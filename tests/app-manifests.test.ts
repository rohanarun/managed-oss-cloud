import { describe, expect, it } from "vitest";
import type { ApplicationInstance } from "../src/shared/types";
import { buildRuntimeManifest, runtimeIngressNetwork, runtimeReservation } from "../src/server/app-manifests";

function instance(appId: string): ApplicationInstance {
  return { id: "11111111-2222-3333-4444-555555555555", installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", appId, state: "queued", hostname: `${appId}.apps.example.com`, containerProject: "mos-111122223333", customDomains: [], memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}

describe("verified application manifests", () => {
  for (const appId of ["cal-diy", "documenso", "heyform", "uptime-kuma", "listmonk", "umami"]) {
    it(`isolates ${appId} and exposes only its web container`, () => {
      const manifest = buildRuntimeManifest(instance(appId), {});
      expect(manifest.primaryContainer).toContain("mos-111122223333");
      expect(manifest.compose.networks.private).toEqual({ internal: true });
      expect(manifest.compose.networks.ingress).toEqual({ external: true, name: "mos-111122223333-ingress" });
      expect(manifest.compose.networks.platform).toEqual({ external: true, name: "managed-oss-worker-platform" });
      expect(Object.values(manifest.compose.services).every((service) => !("ports" in service))).toBe(true);
      expect(JSON.stringify(manifest.compose)).not.toContain("latest");
      expect(JSON.stringify(manifest.compose)).toContain("no-new-privileges:true");
      const limitedMemoryMb = Object.values(manifest.compose.services).reduce((total, service) => {
        const match = String(service.mem_limit ?? "").match(/^(\d+)m$/i);
        return total + (match ? Number(match[1]) : 0);
      }, 0);
      const limitedCpuMillis = Object.values(manifest.compose.services).reduce((total, service) => total + (Number(service.cpus) * 1_000), 0);
      for (const service of Object.values(manifest.compose.services)) {
        expect(typeof service.cpus).toBe("string");
        expect((service.deploy as { resources: { limits: { memory: string; cpus: string } } }).resources.limits.cpus).toBe(service.cpus);
      }
      expect(runtimeReservation(appId).memoryMb).toBe(limitedMemoryMb);
      expect(runtimeReservation(appId).cpuMillis).toBe(limitedCpuMillis);
    });
  }

  it("uses each instance hostname for public callback and cookie URLs", () => {
    for (const appId of ["cal-diy", "documenso", "heyform"]) {
      expect(JSON.stringify(buildRuntimeManifest(instance(appId), {}))).toContain(`https://${appId}.apps.example.com`);
    }
  });

  it("fails closed for applications without a verified runtime", () => {
    expect(() => buildRuntimeManifest(instance("unknown"), {})).toThrow(/no verified runtime manifest/);
  });

  it("injects only the hosting-layer broker public configuration into managed HeyForm", () => {
    const googleOAuthBroker = { startUrl: "https://cloud.getsupers.com/oauth/google/start", assertionPublicKey: "public-verification-key-without-private-material" };
    const heyform = buildRuntimeManifest(instance("heyform"), { googleOAuthBroker });
    expect(heyform.compose.services.app.environment).toMatchObject({
      MANAGED_GOOGLE_BROKER_START_URL: googleOAuthBroker.startUrl,
      MANAGED_OAUTH_ASSERTION_PUBLIC_KEY: googleOAuthBroker.assertionPublicKey,
      MANAGED_OAUTH_APPLICATION_ID: instance("heyform").id,
    });
    const serialized = JSON.stringify(heyform);
    expect(serialized).not.toMatch(/GOOGLE_LOGIN_CLIENT|CLIENT_SECRET|STATE_SECRET|SIGNING_PRIVATE/i);
    expect(JSON.stringify(buildRuntimeManifest(instance("uptime-kuma"), { googleOAuthBroker }))).not.toContain(googleOAuthBroker.assertionPublicKey);
  });

  it("initializes Uptime Kuma's supported SQLite configuration before exposing readiness", () => {
    const manifest = buildRuntimeManifest(instance("uptime-kuma"), {});
    expect(manifest.compose.services.app.environment).toEqual({ UPTIME_KUMA_DB_TYPE: "sqlite" });
    expect(manifest.readiness).toEqual({ path: "/api/entry-page", acceptedEntryPageTypes: ["entryPage"], rejectedEntryPageTypes: ["setup-database"] });
  });

  it("gives every application a distinct external ingress network instead of a shared tenant network", () => {
    const first = instance("uptime-kuma");
    const second = { ...instance("umami"), id: "99999999-2222-3333-4444-555555555555", containerProject: "mos-999988887777" };
    const firstManifest = buildRuntimeManifest(first, {});
    const secondManifest = buildRuntimeManifest(second, {});
    expect(runtimeIngressNetwork(first)).not.toBe(runtimeIngressNetwork(second));
    expect(firstManifest.compose.networks.ingress).not.toEqual(secondManifest.compose.networks.ingress);
    expect(firstManifest.compose.services.app.networks).not.toContain("platform");
    expect(secondManifest.compose.services.app.networks).not.toContain("platform");
    expect(firstManifest.compose.services.proxy.networks).toEqual(["ingress", "platform"]);
    expect(secondManifest.compose.services.proxy.networks).toEqual(["ingress", "platform"]);
    expect(firstManifest.compose.services.proxy.command).toEqual(expect.arrayContaining(["app:3001"]));
    expect(secondManifest.compose.services.proxy.command).toEqual(expect.arrayContaining(["app:3000"]));
    expect(firstManifest.proxyContainer).not.toBe(secondManifest.proxyContainer);
  });
});
