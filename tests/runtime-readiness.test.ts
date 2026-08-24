import { describe, expect, it } from "vitest";
import type { ApplicationInstance } from "../src/shared/types";
import { buildRuntimeManifest } from "../src/server/app-manifests";
import { runtimeReadinessIssue } from "../src/server/runtime-readiness";

const application: ApplicationInstance = { id: "11111111-2222-3333-4444-555555555555", installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", appId: "uptime-kuma", state: "queued", hostname: "status.apps.example.com", containerProject: "mos-111122223333", customDomains: [], memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };

describe("runtime readiness truth", () => {
  const manifest = buildRuntimeManifest(application, {});

  it("rejects Uptime Kuma while its database setup server is answering", () => {
    expect(runtimeReadinessIssue(manifest, { type: "setup-database" })).toMatch(/still requires database setup/);
  });

  it("accepts the main server's entry page responses after database initialization", () => {
    expect(runtimeReadinessIssue(manifest, { type: "entryPage", entryPage: "dashboard" })).toBeUndefined();
  });

  it("fails closed on malformed readiness responses", () => {
    expect(runtimeReadinessIssue(manifest, "not-json")).toMatch(/invalid readiness response/);
    expect(runtimeReadinessIssue(manifest, {})).toMatch(/unexpected readiness state/);
  });
});
