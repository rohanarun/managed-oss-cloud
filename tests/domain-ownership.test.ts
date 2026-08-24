import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { assertCustomerHostname, MemoryHostnameClaimRegistry, platformOwnedHostnameSuffixes } from "../src/server/hostname-claims";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";

async function signup(agent: ReturnType<typeof request.agent>, email: string) {
  const response = await agent.post("/api/auth/signup").send({ displayName: email.split("@")[0], email, password: "long-safe-password" });
  expect(response.status).toBe(201);
  return response.body.user as { id: string };
}

describe("global custom-domain ownership", () => {
  it("ships ownership as immutable migration 004 with one global unique hostname and deletion tombstones", () => {
    const migration = readFileSync("db/migrations/004-global-hostname-claims.sql", "utf8");
    expect(migration).toMatch(/CREATE TABLE global_hostname_claims[\s\S]*hostname TEXT NOT NULL UNIQUE/);
    expect(migration).toMatch(/custom_domains_tombstone_claim[\s\S]*suite_custom_domains_tombstone_claim/);
    expect(migration).toMatch(/status='tombstoned'[\s\S]*tombstoned_at=COALESCE/);
    expect(migration).toMatch(/a hostname is claimed by more than one pre-migration domain surface/);
    expect(readFileSync("db/schema.sql", "utf8")).not.toContain("global_hostname_claims");
    expect(readFileSync("db/suite-schema.sql", "utf8")).not.toContain("global_hostname_claims");
  });

  it("atomically rejects cross-surface collisions in both directions and returns claim-specific DNS instructions", async () => {
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: new MemorySuiteStore("starter"), synchronizeSuiteEntitlements: false });
    const owner = request.agent(app);
    await signup(owner, "global-owner@example.com");
    const installation = await owner.post("/api/installations").send({ name: "Global claims", appIds: ["uptime-kuma"] });
    expect((await owner.post(`/api/installations/${installation.body.installation.id}/domains`).send({ domain: "stolen.apps.example.com" })).status).toBe(409);
    expect((await owner.post("/api/suite/domains").send({ domain: "stolen.apps.example.com" })).status).toBe(409);

    const appClaim = await owner.post(`/api/installations/${installation.body.installation.id}/domains`).send({ domain: "shared.customer.example" });
    expect(appClaim.status).toBe(200);
    expect(appClaim.body.dns).toEqual({
      claimId: expect.any(String),
      txt: { type: "TXT", name: "_managed-oss.shared.customer.example", value: expect.stringMatching(/^managed-oss-domain-verification=[a-f0-9]{36}$/) },
      cname: { type: "CNAME", name: "shared.customer.example", value: expect.stringMatching(/^[a-f0-9]{36}\.verify\.apps\.example\.com$/) },
    });
    expect((await owner.post("/api/suite/domains").send({ domain: "shared.customer.example" })).status).toBe(409);

    const suiteClaim = await owner.post("/api/suite/domains").send({ domain: "suite-first.customer.example" });
    expect(suiteClaim.status).toBe(201);
    expect(suiteClaim.body.dns.claimId).not.toBe(appClaim.body.dns.claimId);
    expect((await owner.post(`/api/installations/${installation.body.installation.id}/domains`).send({ domain: "suite-first.customer.example" })).status).toBe(409);
  });

  it("keeps a suspended former owner's hostname unavailable to another customer", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, suiteStore: new MemorySuiteStore("starter"), synchronizeSuiteEntitlements: false });
    const victim = request.agent(app);
    await signup(victim, "suspended-victim@example.com");
    const victimInstallation = await victim.post("/api/installations").send({ name: "Victim", appIds: ["uptime-kuma"] });
    expect((await victim.post(`/api/installations/${victimInstallation.body.installation.id}/domains`).send({ domain: "retained.customer.example" })).status).toBe(200);
    await repository.updateInstallationState(victimInstallation.body.installation.id, "suspended", "Subscription canceled.");

    const attacker = request.agent(app);
    await signup(attacker, "takeover-attempt@example.com");
    const attackerInstallation = await attacker.post("/api/installations").send({ name: "Attacker", appIds: ["uptime-kuma"] });
    expect((await attacker.post(`/api/installations/${attackerInstallation.body.installation.id}/domains`).send({ domain: "retained.customer.example" })).status).toBe(409);
    expect((await attacker.post("/api/suite/domains").send({ domain: "retained.customer.example" })).status).toBe(409);
  });

  it("rejects platform suffixes and preserves tombstones instead of recycling hostnames", async () => {
    const suffixes = platformOwnedHostnameSuffixes({ publicHostTarget: "apps.getsupers.com", controlPlaneDomain: "cloud.getsupers.com", publicAppUrl: "https://cloud.getsupers.com" });
    expect(() => assertCustomerHostname("fake.apps.getsupers.com", suffixes)).toThrow(/Platform-owned/);
    expect(() => assertCustomerHostname("nested.cloud.getsupers.com", suffixes)).toThrow(/Platform-owned/);

    const registry = new MemoryHostnameClaimRegistry();
    const claim = registry.claim({ hostname: "deleted.customer.example", surface: "suite", ownerUserId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222" }, suffixes)!;
    expect(registry.tombstone(claim)).toBe(true);
    expect(registry.claim({ hostname: claim.hostname, surface: "application", ownerUserId: "33333333-3333-4333-8333-333333333333", resourceId: "44444444-4444-4444-8444-444444444444" }, suffixes)).toBeUndefined();
  });

  it("verifies exact TXT and CNAME proofs, rejects wrong proofs, and supports an apex through TXT", async () => {
    let txtAnswers: string[][] = [];
    let cnameAnswers: string[] = [];
    const app = await createApp({
      repository: new MemoryRepository(),
      suiteStore: new MemorySuiteStore("starter"),
      synchronizeSuiteEntitlements: false,
      domainResolver: { resolveTxt: async () => txtAnswers, resolveCname: async () => cnameAnswers },
    });
    const owner = request.agent(app);
    await signup(owner, "proof-owner@example.com");

    const apex = await owner.post("/api/suite/domains").send({ domain: "customer-example.org" });
    expect(apex.status).toBe(201);
    txtAnswers = [["managed-oss-domain-verification=wrong"]];
    expect((await owner.post("/api/suite/domains/customer-example.org/verify")).status).toBe(409);
    txtAnswers = [[apex.body.dns.txt.value.slice(0, 20), apex.body.dns.txt.value.slice(20)]];
    const txtVerified = await owner.post("/api/suite/domains/customer-example.org/verify");
    expect(txtVerified.status).toBe(200);
    expect(txtVerified.body.method).toBe("TXT");

    txtAnswers = [];
    const cname = await owner.post("/api/suite/domains").send({ domain: "cname.customer.example" });
    cnameAnswers = ["wrong.verify.apps.example.com"];
    expect((await owner.post("/api/suite/domains/cname.customer.example/verify")).status).toBe(409);
    cnameAnswers = [`${cname.body.dns.cname.value}.`];
    const cnameVerified = await owner.post("/api/suite/domains/cname.customer.example/verify");
    expect(cnameVerified.status).toBe(200);
    expect(cnameVerified.body.method).toBe("CNAME");
  });

  it("rejects an A-only platform route through the API", async () => {
    let addressLookups = 0;
    const app = await createApp({
      repository: new MemoryRepository(),
      suiteStore: new MemorySuiteStore("starter"),
      synchronizeSuiteEntitlements: false,
      domainResolver: { resolveTxt: async () => [], resolveCname: async () => [], resolve4: async () => { addressLookups += 1; return ["34.44.230.152"]; } },
    });
    const owner = request.agent(app);
    await signup(owner, "a-only@example.com");
    expect((await owner.post("/api/suite/domains").send({ domain: "a-only.customer.example" })).status).toBe(201);
    expect((await owner.post("/api/suite/domains/a-only.customer.example/verify")).status).toBe(409);
    expect(addressLookups).toBe(0);
  });
});
