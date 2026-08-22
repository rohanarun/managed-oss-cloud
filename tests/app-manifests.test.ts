import { describe, expect, it } from "vitest";
import type { ApplicationInstance } from "../src/shared/types";
import { buildRuntimeManifest, runtimeReservation } from "../src/server/app-manifests";

function instance(appId: string): ApplicationInstance {
  return { id: "11111111-2222-3333-4444-555555555555", installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", appId, state: "queued", hostname: `${appId}.apps.example.com`, containerProject: `mos-${appId}`, customDomains: [], memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}

describe("verified application manifests", () => {
  for (const appId of ["cal-diy", "documenso", "heyform", "uptime-kuma", "listmonk", "umami"]) {
    it(`isolates ${appId} and exposes only its web container`, () => {
      const manifest = buildRuntimeManifest(instance(appId), { platformNetwork: "platform" });
      expect(manifest.primaryContainer).toContain(`mos-${appId}`);
      expect(manifest.compose.networks.private).toEqual({ internal: true });
      expect(Object.values(manifest.compose.services).every((service) => !("ports" in service))).toBe(true);
      expect(JSON.stringify(manifest.compose)).not.toContain("latest");
      expect(JSON.stringify(manifest.compose)).toContain("no-new-privileges:true");
      const limitedMemoryMb = Object.values(manifest.compose.services).reduce((total, service) => {
        const match = String(service.mem_limit ?? "").match(/^(\d+)m$/i);
        return total + (match ? Number(match[1]) : 0);
      }, 0);
      expect(runtimeReservation(appId).memoryMb).toBe(limitedMemoryMb);
    });
  }

  it("uses each instance hostname for public callback and cookie URLs", () => {
    for (const appId of ["cal-diy", "documenso", "heyform"]) {
      expect(JSON.stringify(buildRuntimeManifest(instance(appId), { platformNetwork: "platform" }))).toContain(`https://${appId}.apps.example.com`);
    }
  });

  it("fails closed for applications without a verified runtime", () => {
    expect(() => buildRuntimeManifest(instance("unknown"), { platformNetwork: "platform" })).toThrow(/no verified runtime manifest/);
  });

  it("injects hosting-layer Google OAuth only into managed HeyForm", () => {
    const googleOAuth = { clientId: "platform-client-id", clientSecret: "platform-client-secret", stateSecret: "platform-state-secret", callbackUrl: "https://cloud.getsupers.com/oauth/google/callback" };
    const heyform = buildRuntimeManifest(instance("heyform"), { platformNetwork: "platform", googleOAuth });
    expect(heyform.compose.services.app.environment).toMatchObject({
      GOOGLE_LOGIN_CLIENT_ID: googleOAuth.clientId,
      GOOGLE_LOGIN_CLIENT_SECRET: googleOAuth.clientSecret,
      MANAGED_OAUTH_STATE_SECRET: googleOAuth.stateSecret,
      MANAGED_GOOGLE_CALLBACK_URL: googleOAuth.callbackUrl,
    });
    expect(JSON.stringify(buildRuntimeManifest(instance("uptime-kuma"), { platformNetwork: "platform", googleOAuth }))).not.toContain("platform-client-secret");
  });
});
