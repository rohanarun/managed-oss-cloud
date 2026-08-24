import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeManifest, runtimeReservation } from "../src/server/app-manifests";
import type { ApplicationInstance, WorkerNodeActivity } from "../src/shared/types";
import { assertManifestMatchesReservation, assertWorkerResourceConsistency, assignedApplicationUsage, enforceStorageQuarantineContract, manifestResourceEnvelope, measureAllocatedDirectoryBytes, parseQuotaHelperProof, quotaHelperArguments, storageBytesPerGb, storageQuarantineMarker, writeStorageQuarantine, type HostResourceSnapshot, type WorkerResourcePolicy } from "../src/server/worker-resource-enforcement";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function application(appId = "uptime-kuma"): ApplicationInstance {
  const reservation = runtimeReservation(appId);
  return { id: "11111111-2222-3333-4444-555555555555", installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", appId, state: "live", hostname: `${appId}.apps.example.com`, containerProject: "mos-111122223333", customDomains: [], memoryReservationMb: reservation.memoryMb, cpuReservationMillis: reservation.cpuMillis, storageReservationGb: reservation.storageGb, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}

function policy(appsRoot = "/opt/managed-oss/apps/workspaces"): WorkerResourcePolicy {
  return { workerNodeId: "worker-one", appsRoot, capacityMemoryMb: 2_048, capacityCpuMillis: 1_800, capacityStorageGb: 20, systemReserveMemoryMb: 512, systemReserveCpuMillis: 200, systemReserveStorageGb: 5, launchMemoryReserveMb: 160, storageQuotaBackend: "measurement-only" };
}

function activity(overrides: Partial<WorkerNodeActivity["node"]> = {}): WorkerNodeActivity {
  const app = application();
  return {
    node: {
      id: "worker-one", name: "Worker one", status: "ready", privateAddress: "10.70.0.3", machineType: "e2-standard-2",
      capacityMemoryMb: 2_048, capacityCpuMillis: 1_800, capacityStorageGb: 20, systemReserveMemoryMb: 512,
      reservedMemoryMb: app.memoryReservationMb, reservedCpuMillis: app.cpuReservationMillis, reservedStorageGb: app.storageReservationGb,
      lastHeartbeatAt: new Date().toISOString(), createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), ...overrides,
    },
    mode: "active", runningJobs: [], assignedApplications: [{ id: app.id, installationId: app.installationId, appId: app.appId, state: app.state }], safeToReplaceAgent: true,
  };
}

function host(overrides: Partial<HostResourceSnapshot> = {}): HostResourceSnapshot {
  return { totalMemoryMb: 4_096, availableMemoryMb: 1_024, logicalCpuMillis: 2_000, filesystemTotalBytes: 30 * storageBytesPerGb, filesystemAvailableBytes: 25 * storageBytesPerGb, managedRootUsageBytes: storageBytesPerGb, ...overrides };
}

describe("worker runtime resource enforcement", () => {
  it("requires every manifest service limit to exactly fit its database reservation", () => {
    for (const appId of ["cal-diy", "documenso", "heyform", "uptime-kuma", "listmonk", "umami"]) {
      const instance = application(appId);
      const envelope = manifestResourceEnvelope(buildRuntimeManifest(instance, {}));
      expect(envelope).toEqual(runtimeReservation(appId));
      expect(assertManifestMatchesReservation(instance, buildRuntimeManifest(instance, {}))).toEqual(envelope);
    }
    expect(() => assertManifestMatchesReservation({ ...application(), cpuReservationMillis: 249 }, buildRuntimeManifest(application(), {}))).toThrow(/database reservation/);
  });

  it("reconciles all three control-plane reservation dimensions before launch", () => {
    expect(assertWorkerResourceConsistency(activity(), policy(), host(), 384)).toMatchObject({ assigned: runtimeReservation("uptime-kuma") });
    expect(() => assertWorkerResourceConsistency(activity({ reservedMemoryMb: 415 }), policy(), host())).toThrow(/complete assigned application set/);
    expect(() => assertWorkerResourceConsistency(activity({ reservedCpuMillis: 249 }), policy(), host())).toThrow(/complete assigned application set/);
    expect(() => assertWorkerResourceConsistency(activity({ reservedStorageGb: 2 }), policy(), host())).toThrow(/complete assigned application set/);
  });

  it("fails when advertised capacity exceeds physical CPU, memory, disk, or reserved disk headroom", () => {
    expect(() => assertWorkerResourceConsistency(activity(), policy(), host({ totalMemoryMb: 2_047 }))).toThrow(/physical host memory/);
    expect(() => assertWorkerResourceConsistency(activity(), policy(), host({ logicalCpuMillis: 1_999 }))).toThrow(/physical logical CPU/);
    expect(() => assertWorkerResourceConsistency(activity(), policy(), host({ filesystemTotalBytes: 24 * storageBytesPerGb }))).toThrow(/application filesystem/);
    expect(() => assertWorkerResourceConsistency(activity(), policy(), host({ filesystemAvailableBytes: 6_999_999_999, managedRootUsageBytes: 0 }))).toThrow(/unused customer storage reservations/);
    expect(() => assertWorkerResourceConsistency(activity(), policy(), host({ availableMemoryMb: 543 }), 384)).toThrow(/Insufficient safe memory/);
  });

  it("measures allocated workspace bytes without following external symlinks and detects over-quota usage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "managed-worker-usage-"));
    directories.push(root);
    const app = application();
    const directory = path.join(root, app.id);
    await mkdir(directory);
    await writeFile(path.join(directory, "payload.bin"), Buffer.alloc(128 * 1024, 7));
    await symlink("/", path.join(directory, "outside"));
    const usedBytes = await measureAllocatedDirectoryBytes(directory);
    expect(usedBytes).toBeGreaterThanOrEqual(128 * 1024);
    const [usage] = await assignedApplicationUsage(activity(), root);
    expect(usage).toMatchObject({ id: app.id, usedBytes, storageLimitBytes: 3 * storageBytesPerGb, overQuota: false });
  });

  it("writes a durable stop/quarantine marker that is never auto-cleared", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "managed-worker-quarantine-"));
    directories.push(root);
    const evidence = { applicationId: application().id, appId: "uptime-kuma", usedBytes: 3_000_000_001, storageLimitBytes: 3_000_000_000, observedAt: "2026-08-24T12:00:00.000Z" };
    const marker = await writeStorageQuarantine(root, evidence);
    expect(await storageQuarantineMarker(root)).toBe(marker);
    expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({ version: "managed-storage-quarantine.v1", reason: "measured-storage-over-quota", ...evidence });
  });

  it("records every quarantine before removing routes and attempts every stop even when one operation fails", async () => {
    const events: string[] = [];
    await expect(enforceStorageQuarantineContract(["one", "two"], {
      quarantine: async (applicationId) => { events.push(`quarantine:${applicationId}`); },
      removeQuarantinedRoutes: async () => { events.push("routes:removed"); },
      stop: async (applicationId) => {
        events.push(`stop:${applicationId}`);
        if (applicationId === "one") throw new Error("simulated stop failure");
      },
    })).rejects.toThrow(/route-removal or stop operations failed/);
    expect(events).toEqual(["quarantine:one", "quarantine:two", "routes:removed", "stop:one", "stop:two"]);
  });

  it("requires exact machine-readable proof from an operator hard-quota helper", () => {
    const expected = { applicationPath: "/opt/managed-oss/apps/workspaces/11111111-2222-3333-4444-555555555555", applicationId: application().id, storageLimitBytes: 3 * storageBytesPerGb };
    expect(quotaHelperArguments("verify", expected.applicationPath, expected.applicationId, expected.storageLimitBytes)).toEqual(["verify", "--path", expected.applicationPath, "--application-id", expected.applicationId, "--limit-bytes", "3000000000"]);
    expect(parseQuotaHelperProof(JSON.stringify({ ok: true, backend: "operator-project-quota", path: expected.applicationPath, applicationId: expected.applicationId, hardLimitBytes: expected.storageLimitBytes, evidence: "project-quota-proof-1234" }), expected)).toMatchObject({ ok: true });
    expect(() => parseQuotaHelperProof(JSON.stringify({ ok: true, backend: "operator-project-quota", path: expected.applicationPath, applicationId: expected.applicationId, hardLimitBytes: 4 * storageBytesPerGb, evidence: "wrong-limit-proof-1234" }), expected)).toThrow(/exact application path and byte limit/);
  });
});
