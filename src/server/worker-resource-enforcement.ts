import { cpus } from "node:os";
import { lstat, mkdir, readFile, readdir, rename, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApplicationInstance, WorkerNodeActivity } from "../shared/types.js";
import { runtimeReservation, type RuntimeManifest } from "./app-manifests.js";

export const storageBytesPerGb = 1_000_000_000;
export const storageQuarantineMarkerName = ".managed-storage-quarantine.json";

export interface WorkerResourcePolicy {
  workerNodeId: string;
  appsRoot: string;
  capacityMemoryMb: number;
  capacityCpuMillis: number;
  capacityStorageGb: number;
  systemReserveMemoryMb: number;
  systemReserveCpuMillis: number;
  systemReserveStorageGb: number;
  launchMemoryReserveMb: number;
  storageQuotaBackend: "measurement-only" | "operator-project-quota";
}

export interface HostResourceSnapshot {
  totalMemoryMb: number;
  availableMemoryMb: number;
  logicalCpuMillis: number;
  filesystemTotalBytes: number;
  filesystemAvailableBytes: number;
  managedRootUsageBytes: number;
}

export interface ResourceEnvelope {
  memoryMb: number;
  cpuMillis: number;
  storageGb: number;
}

interface AssignedApplicationUsage {
  id: string;
  appId: string;
  state: ApplicationInstance["state"];
  usedBytes: number;
  storageLimitBytes: number;
  overQuota: boolean;
}

export async function enforceStorageQuarantineContract<T>(applications: readonly T[], actions: {
  quarantine(application: T): Promise<void>;
  removeQuarantinedRoutes(): Promise<void>;
  stop(application: T): Promise<void>;
}) {
  if (!applications.length) return;
  for (const application of applications) await actions.quarantine(application);
  const failures: unknown[] = [];
  try { await actions.removeQuarantinedRoutes(); } catch (error) { failures.push(error); }
  for (const application of applications) {
    try { await actions.stop(application); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Storage quarantine was recorded, but one or more route-removal or stop operations failed.");
}

function parseMemoryMb(value: unknown, serviceName: string) {
  const match = String(value ?? "").match(/^(\d+)([kmg])(?:i?b)?$/i);
  if (!match) throw new Error(`Managed service ${serviceName} has no explicit byte-unit memory limit.`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Managed service ${serviceName} has an invalid memory limit.`);
  if (unit === "g") return amount * 1024;
  if (unit === "k") return Math.ceil(amount / 1024);
  return amount;
}

function parseCpuMillis(value: unknown, serviceName: string) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Managed service ${serviceName} has no explicit CPU limit.`);
  const cores = Number(value);
  const millis = cores * 1_000;
  if (!Number.isFinite(millis) || millis <= 0 || !Number.isSafeInteger(millis)) throw new Error(`Managed service ${serviceName} has an invalid CPU limit.`);
  return millis;
}

export function manifestResourceEnvelope(manifest: RuntimeManifest): ResourceEnvelope {
  let memoryMb = 0;
  let cpuMillis = 0;
  for (const [serviceName, service] of Object.entries(manifest.compose.services)) {
    const serviceMemory = parseMemoryMb(service.mem_limit, serviceName);
    const serviceCpu = parseCpuMillis(service.cpus, serviceName);
    const deploy = service.deploy as { resources?: { limits?: { memory?: unknown; cpus?: unknown } } } | undefined;
    const deployMemory = parseMemoryMb(deploy?.resources?.limits?.memory, `${serviceName} deploy`);
    const deployCpu = parseCpuMillis(deploy?.resources?.limits?.cpus, `${serviceName} deploy`);
    if (serviceMemory !== deployMemory || serviceCpu !== deployCpu) throw new Error(`Managed service ${serviceName} has inconsistent local and deploy resource limits.`);
    memoryMb += serviceMemory;
    cpuMillis += serviceCpu;
  }
  return { memoryMb, cpuMillis, storageGb: runtimeReservation(manifest.appId).storageGb };
}

export function assertManifestMatchesReservation(instance: ApplicationInstance, manifest: RuntimeManifest) {
  const expected = runtimeReservation(instance.appId);
  const actual = manifestResourceEnvelope(manifest);
  const registered = { memoryMb: instance.memoryReservationMb, cpuMillis: instance.cpuReservationMillis, storageGb: instance.storageReservationGb };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Application ${instance.id} manifest limits do not match the verified ${instance.appId} runtime reservation.`);
  if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error(`Application ${instance.id} database reservation does not match the verified ${instance.appId} runtime reservation.`);
  return actual;
}

export function assignedReservation(activity: WorkerNodeActivity): ResourceEnvelope {
  const ids = new Set<string>();
  return activity.assignedApplications.reduce<ResourceEnvelope>((total, application) => {
    if (ids.has(application.id)) throw new Error(`Worker activity contains duplicate application ${application.id}.`);
    ids.add(application.id);
    const reservation = runtimeReservation(application.appId);
    return { memoryMb: total.memoryMb + reservation.memoryMb, cpuMillis: total.cpuMillis + reservation.cpuMillis, storageGb: total.storageGb + reservation.storageGb };
  }, { memoryMb: 0, cpuMillis: 0, storageGb: 0 });
}

export function assertWorkerResourceConsistency(activity: WorkerNodeActivity, policy: WorkerResourcePolicy, host: HostResourceSnapshot, pendingLaunchMemoryMb = 0) {
  const node = activity.node;
  if (node.id !== policy.workerNodeId) throw new Error("Control-plane worker identity does not match this host.");
  const advertised = { memoryMb: node.capacityMemoryMb, cpuMillis: node.capacityCpuMillis, storageGb: node.capacityStorageGb };
  const configured = { memoryMb: policy.capacityMemoryMb, cpuMillis: policy.capacityCpuMillis, storageGb: policy.capacityStorageGb };
  if (JSON.stringify(advertised) !== JSON.stringify(configured) || node.systemReserveMemoryMb !== policy.systemReserveMemoryMb) throw new Error("Control-plane worker capacity differs from the host configuration; drain and reconcile the node before provisioning.");

  const expected = assignedReservation(activity);
  const recorded = { memoryMb: node.reservedMemoryMb, cpuMillis: node.reservedCpuMillis, storageGb: node.reservedStorageGb };
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) throw new Error("Control-plane worker reservations differ from the complete assigned application set; provisioning is blocked until reconciliation succeeds.");
  if (recorded.memoryMb + policy.systemReserveMemoryMb > policy.capacityMemoryMb) throw new Error("Worker memory reservations and its system reserve exceed advertised memory.");
  if (recorded.cpuMillis > policy.capacityCpuMillis) throw new Error("Worker CPU reservations exceed advertised CPU.");
  if (recorded.storageGb > policy.capacityStorageGb) throw new Error("Worker storage reservations exceed advertised storage.");

  if (host.totalMemoryMb < policy.capacityMemoryMb) throw new Error("Advertised worker memory exceeds physical host memory.");
  if (host.logicalCpuMillis < policy.capacityCpuMillis + policy.systemReserveCpuMillis) throw new Error("Advertised worker CPU plus its host reserve exceeds physical logical CPU.");
  if (host.filesystemTotalBytes < (policy.capacityStorageGb + policy.systemReserveStorageGb) * storageBytesPerGb) throw new Error("Advertised worker storage plus its host reserve exceeds the application filesystem.");
  if (host.availableMemoryMb < pendingLaunchMemoryMb + policy.launchMemoryReserveMb) throw new Error(`Insufficient safe memory for launch: ${pendingLaunchMemoryMb} MB is pending and ${host.availableMemoryMb} MB is available.`);

  const reservedUnusedBytes = Math.max(0, (recorded.storageGb * storageBytesPerGb) - host.managedRootUsageBytes);
  const requiredFilesystemHeadroom = reservedUnusedBytes + (policy.systemReserveStorageGb * storageBytesPerGb);
  if (host.filesystemAvailableBytes < requiredFilesystemHeadroom) throw new Error("The application filesystem cannot honor all unused customer storage reservations plus the host reserve.");
  return { assigned: expected, requiredFilesystemHeadroom };
}

export async function measureAllocatedDirectoryBytes(directory: string): Promise<number> {
  const seen = new Set<string>();
  async function visit(candidate: string): Promise<number> {
    let details;
    try {
      details = await lstat(candidate, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const identity = `${details.dev}:${details.ino}`;
    if (seen.has(identity)) return 0;
    seen.add(identity);
    const allocated = Number(details.blocks) * 512;
    if (details.isSymbolicLink() || !details.isDirectory()) return allocated;
    const entries = await readdir(candidate);
    let total = allocated;
    for (const entry of entries) total += await visit(path.join(candidate, entry));
    return total;
  }
  return visit(directory);
}

export async function readHostResourceSnapshot(appsRoot: string): Promise<HostResourceSnapshot> {
  await mkdir(appsRoot, { recursive: true, mode: 0o750 });
  const memory = await readFile("/proc/meminfo", "utf8");
  const total = memory.match(/^MemTotal:\s+(\d+) kB$/m);
  const available = memory.match(/^MemAvailable:\s+(\d+) kB$/m);
  if (!total || !available) throw new Error("Host memory capacity could not be measured.");
  const filesystem = await statfs(appsRoot, { bigint: true });
  return {
    totalMemoryMb: Math.floor(Number(total[1]) / 1024),
    availableMemoryMb: Math.floor(Number(available[1]) / 1024),
    logicalCpuMillis: cpus().length * 1_000,
    filesystemTotalBytes: Number(filesystem.blocks * filesystem.bsize),
    filesystemAvailableBytes: Number(filesystem.bavail * filesystem.bsize),
    managedRootUsageBytes: await measureAllocatedDirectoryBytes(appsRoot),
  };
}

export async function assignedApplicationUsage(activity: WorkerNodeActivity, appsRoot: string): Promise<AssignedApplicationUsage[]> {
  return Promise.all(activity.assignedApplications.map(async (application) => {
    if (!/^[0-9a-f-]{36}$/i.test(application.id)) throw new Error("Control-plane activity contains an invalid application identifier.");
    const usedBytes = await measureAllocatedDirectoryBytes(path.join(appsRoot, application.id));
    const storageLimitBytes = runtimeReservation(application.appId).storageGb * storageBytesPerGb;
    return { id: application.id, appId: application.appId, state: application.state, usedBytes, storageLimitBytes, overQuota: usedBytes > storageLimitBytes };
  }));
}

export function quotaHelperArguments(action: "apply" | "verify", applicationPath: string, applicationId: string, storageLimitBytes: number) {
  if (!path.isAbsolute(applicationPath) || !/^[0-9a-f-]{36}$/i.test(applicationId) || !Number.isSafeInteger(storageLimitBytes) || storageLimitBytes <= 0) throw new Error("Hard-quota helper input is invalid.");
  return [action, "--path", applicationPath, "--application-id", applicationId, "--limit-bytes", String(storageLimitBytes)];
}

export function parseQuotaHelperProof(output: string, expected: { applicationPath: string; applicationId: string; storageLimitBytes: number }) {
  let proof: unknown;
  try { proof = JSON.parse(output); } catch { throw new Error("Hard-quota helper returned invalid JSON proof."); }
  const value = proof as Record<string, unknown>;
  if (value.ok !== true || value.backend !== "operator-project-quota" || value.path !== expected.applicationPath || value.applicationId !== expected.applicationId || value.hardLimitBytes !== expected.storageLimitBytes || typeof value.evidence !== "string" || value.evidence.length < 16) throw new Error("Hard-quota helper did not prove the exact application path and byte limit.");
  return value;
}

export async function storageQuarantineMarker(directory: string) {
  const marker = path.join(directory, storageQuarantineMarkerName);
  try {
    const details = await lstat(marker);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Storage quarantine marker is not a regular file.");
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeStorageQuarantine(directory: string, evidence: { applicationId: string; appId: string; usedBytes: number; storageLimitBytes: number; observedAt: string }) {
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const marker = path.join(directory, storageQuarantineMarkerName);
  const temporary = `${marker}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: "managed-storage-quarantine.v1", reason: "measured-storage-over-quota", ...evidence }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, marker);
  return marker;
}
