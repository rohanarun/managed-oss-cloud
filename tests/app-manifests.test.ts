import { describe, expect, it } from "vitest";
import type { ApplicationInstance } from "../src/shared/types";
import { buildRuntimeManifest } from "../src/server/app-manifests";

function instance(appId: string): ApplicationInstance {
  return { id: "11111111-2222-3333-4444-555555555555", installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", appId, state: "queued", hostname: `${appId}.apps.example.com`, containerProject: `mos-${appId}`, customDomains: [], memoryReservationMb: 384, cpuReservationMillis: 250, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}

describe("verified application manifests", () => {
  for (const appId of ["uptime-kuma", "listmonk", "umami"]) {
    it(`isolates ${appId} and exposes only its web container`, () => {
      const manifest = buildRuntimeManifest(instance(appId), { platformNetwork: "platform" });
      expect(manifest.primaryContainer).toContain(`mos-${appId}`);
      expect(manifest.compose.networks.private).toEqual({ internal: true });
      expect(Object.values(manifest.compose.services).every((service) => !("ports" in service))).toBe(true);
      expect(JSON.stringify(manifest.compose)).not.toContain("latest");
      expect(JSON.stringify(manifest.compose)).toContain("no-new-privileges:true");
    });
  }

  it("fails closed for applications without a verified runtime", () => {
    expect(() => buildRuntimeManifest(instance("documenso"), { platformNetwork: "platform" })).toThrow(/no verified runtime manifest/);
  });
});
