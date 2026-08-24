import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { MemoryRepository } from "../src/server/repository";
import { executeSuiteAction, type SuiteActionResult, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { PublicSigningService, verifyPublicReceiptEnvelope, verifyPublicSignature, type PublicSignature } from "../src/server/public-signing";

const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const engineDependencies: SuiteEngineDependencies = {
  now: () => new Date("2026-08-24T12:00:00.000Z"),
  resolveTxt: async () => [],
  resolveHost: async () => ["93.184.216.34"],
};

function firstRecord(result: SuiteActionResult) {
  if (result.kind === "record") return result.record;
  if (result.kind === "command" && result.records[0]) return result.records[0];
  throw new Error("Expected a durable record result.");
}

async function verifiedCustomDomain(store: MemorySuiteStore, userId: string, domain: string) {
  await store.addCustomDomain(userId, domain);
  await store.setCustomDomainStatus(userId, domain, "verified");
}

async function publishedConsentPolicy(store: MemorySuiteStore, userId = ownerA, domain = "privacy.example.com") {
  await store.enableModule(userId, "consent");
  await verifiedCustomDomain(store, userId, domain);
  const created = firstRecord(await executeSuiteAction(store, userId, "consent", "site-create", { name: "Privacy site" }, engineDependencies));
  const configured = firstRecord(await executeSuiteAction(store, userId, "consent", "site-configure", { siteId: created.id, domain, fallbackBehavior: "essential-only" }, engineDependencies));
  const challenge = String(configured.data.verificationChallenge);
  const verified = firstRecord(await executeSuiteAction(store, userId, "consent", "domain-verify", { siteId: configured.id }, { ...engineDependencies, resolveTxt: async () => [[challenge]] }));
  const revision = firstRecord(await executeSuiteAction(store, userId, "consent", "policy-draft", {
    siteId: verified.id,
    locale: "en-US",
    fallbackBehavior: "essential-only",
    purposes: [
      { key: "essential", label: "Essential", description: "Required service operation.", required: true },
      { key: "analytics", label: "Analytics", description: "Optional aggregate measurement.", required: false },
    ],
    services: [],
  }, engineDependencies));
  const contentHash = String(revision.data.contentHash);
  await executeSuiteAction(store, userId, "consent", "policy-approve", { revisionId: revision.id, contentHash }, engineDependencies);
  const published = firstRecord(await executeSuiteAction(store, userId, "consent", "policy-publish", { revisionId: revision.id, contentHash, idempotencyKey: "public-policy-publish-0001" }, engineDependencies));
  return { site: verified, revision: published };
}

async function configuredSeoSite(store: MemorySuiteStore, userId = ownerA) {
  await store.enableModule(userId, "seo");
  const created = firstRecord(await executeSuiteAction(store, userId, "seo", "site-create", { name: "Search site" }, engineDependencies));
  const site = firstRecord(await executeSuiteAction(store, userId, "seo", "site-configure", { siteId: created.id, origin: "https://product.example.com", locale: "en-US", device: "desktop" }, engineDependencies));
  const keyword = firstRecord(await executeSuiteAction(store, userId, "seo", "keyword-add", { siteId: site.id, query: "private cloud", country: "US", device: "desktop" }, engineDependencies));
  return { site, keyword };
}

describe("public consent and SEO security surfaces", () => {
  it("serves a domain-bound cryptographically signed policy without exposing its private signing key", async () => {
    const store = new MemorySuiteStore("starter");
    const { site, revision } = await publishedConsentPolicy(store);
    const { privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const privateKeySecret = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    const trustedKey = new PublicSigningService(privateKey).verificationKey();
    const historicalSigner = new PublicSigningService(generateKeyPairSync("ed25519").privateKey);
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, consentPolicySigningKey: privateKeySecret, consentPolicyPreviousVerificationKeys: [historicalSigner.verificationKey()] });

    const wellKnownKeys = await request(app).get("/.well-known/managed-oss-public-signing-keys.json").set("host", "privacy.example.com");
    expect(wellKnownKeys.status).toBe(200);
    expect(wellKnownKeys.body).toEqual({ purpose: "managed-oss-consent-policy-and-receipt-signing", keys: [trustedKey, historicalSigner.verificationKey()] });
    const result = await request(app).get(`/api/public/consent/sites/${site.id}/policy`).set("host", "privacy.example.com");
    expect(result.status).toBe(200);
    expect(result.body.payload).toMatchObject({ workspace: "workspace-aaaaaaaa", siteId: site.id, origin: "https://privacy.example.com", revisionId: revision.id, contentHash: revision.data.contentHash });
    expect(result.body.signature).not.toHaveProperty("publicKey");
    expect(verifyPublicSignature(result.body.payload, result.body.signature as PublicSignature, [trustedKey])).toBe(true);
    expect(verifyPublicSignature({ ...result.body.payload, origin: "https://attacker.example.com" }, result.body.signature as PublicSignature, [trustedKey])).toBe(false);
    const { privateKey: attackerPrivateKey } = generateKeyPairSync("ed25519");
    const attacker = new PublicSigningService(attackerPrivateKey);
    const forgedPayload = { ...result.body.payload, origin: "https://attacker.example.com" };
    expect(verifyPublicSignature(forgedPayload, attacker.sign(forgedPayload), [trustedKey])).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain(privatePem);
    expect(JSON.stringify(result.body)).not.toContain(privateKeySecret);
    expect(JSON.stringify(result.body)).not.toContain("PRIVATE KEY");
    expect((await request(app).get(`/api/public/consent/sites/${site.id}/policy`).set("host", "unknown.example.com")).status).toBe(404);
  });

  it("records signed choices idempotently, rejects conflicting replays, and appends revocation without raw identifiers", async () => {
    const store = new MemorySuiteStore("starter");
    const { site, revision } = await publishedConsentPolicy(store);
    const { privateKey } = generateKeyPairSync("ed25519");
    const trustedKey = new PublicSigningService(privateKey).verificationKey();
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, consentPolicySigningKey: privateKey });
    const visitorKey = "browser-local-random-visitor-key";
    const body = {
      revisionId: revision.id,
      visitorKey,
      idempotencyKey: "public-choice-request-0001",
      decisions: [{ key: "essential", allowed: true }, { key: "analytics", allowed: false }],
    };
    const sendChoice = (value: Record<string, unknown>) => request(app).post(`/api/public/consent/sites/${site.id}/choices`).set("host", "privacy.example.com").set("origin", "https://privacy.example.com").send(value);

    const concurrent = await Promise.all([sendChoice(body), sendChoice(body)]);
    const first = concurrent.find((result) => result.status === 201)!;
    const replay = concurrent.find((result) => result.status === 200)!;
    expect(concurrent.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(replay.body).toMatchObject({ receiptId: first.body.receiptId, replayed: true });
    expect(first.body.payload).toMatchObject({ schema: "managed-oss-consent-receipt", version: 1, receiptId: first.body.receiptId });
    expect(verifyPublicReceiptEnvelope(first.body.receiptId, first.body.payload, first.body.signature as PublicSignature, [trustedKey])).toBe(true);
    expect(verifyPublicReceiptEnvelope("00000000-0000-4000-8000-000000000000", first.body.payload, first.body.signature as PublicSignature, [trustedKey])).toBe(false);
    expect(verifyPublicSignature(first.body.payload, first.body.signature as PublicSignature, [trustedKey])).toBe(true);
    expect((await sendChoice({ ...body, decisions: [{ key: "essential", allowed: true }, { key: "analytics", allowed: true }] })).status).toBe(409);
    expect((await request(app).post(`/api/public/consent/sites/${site.id}/choices`).set("host", "privacy.example.com").set("origin", "https://attacker.example.com").send({ ...body, idempotencyKey: "public-choice-request-0002" })).status).toBe(403);

    const revoked = await sendChoice({ revisionId: revision.id, visitorKey, idempotencyKey: "public-choice-revoke-0001", action: "revoke" });
    expect(revoked.status).toBe(201);
    expect(revoked.body.payload).toMatchObject({ action: "revoke", priorReceiptId: first.body.receiptId, decisions: [{ key: "analytics", allowed: false }, { key: "essential", allowed: true }] });
    const receipts = await store.listRecords(ownerA, { moduleId: "consent", recordType: "consent-receipt", limit: 20 });
    expect(receipts).toHaveLength(2);
    expect(JSON.stringify(receipts)).not.toContain(visitorKey);
    expect(JSON.stringify(receipts)).not.toContain(body.idempotencyKey);
  });

  it("requires verified owned custom domains for opaque SEO reports, isolates tenants, and revokes public access without deleting the snapshot", async () => {
    const store = new MemorySuiteStore("starter");
    const { site, keyword } = await configuredSeoSite(store);
    await store.addCustomDomain(ownerA, "reports.example.com");
    await expect(executeSuiteAction(store, ownerA, "seo", "report-create", { siteId: site.id, domain: "reports.example.com", title: "Search visibility", evidenceIds: [keyword.id] }, engineDependencies)).rejects.toThrow(/verified custom domain/);
    await store.setCustomDomainStatus(ownerA, "reports.example.com", "verified");
    const result = await executeSuiteAction(store, ownerA, "seo", "report-create", { siteId: site.id, domain: "reports.example.com", title: "Search visibility", evidenceIds: [keyword.id] }, engineDependencies);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    const report = result.records[0];
    const token = String(result.audit.accessToken);
    const originalSnapshot = structuredClone(report.data.snapshot);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(report)).not.toContain(token);

    await store.enableModule(ownerB, "seo");
    await verifiedCustomDomain(store, ownerB, "other-reports.example.com");
    await expect(executeSuiteAction(store, ownerB, "seo", "report-revoke", { reportId: report.id }, engineDependencies)).rejects.toThrow(/not found/);
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store });
    const publicReport = await request(app).get(`/api/public/seo/reports/${token}`).set("host", "reports.example.com");
    expect(publicReport.status).toBe(200);
    expect(publicReport.body.report).toMatchObject({ id: report.id, title: "Search visibility", snapshotHash: report.data.snapshotHash, snapshot: originalSnapshot });
    expect((await request(app).get(`/api/public/seo/reports/${token}`).set("host", "other-reports.example.com")).status).toBe(404);

    const revoked = await executeSuiteAction(store, ownerA, "seo", "report-revoke", { reportId: report.id }, engineDependencies);
    expect(revoked.kind === "command" && revoked.audit.replayed).toBe(false);
    expect((await request(app).get(`/api/public/seo/reports/${token}`).set("host", "reports.example.com")).status).toBe(404);
    const privateReport = await store.getRecord(ownerA, report.id);
    expect(privateReport).toMatchObject({ state: "revoked", data: { snapshot: originalSnapshot, snapshotHash: report.data.snapshotHash } });
    const revokeReplay = await executeSuiteAction(store, ownerA, "seo", "report-revoke", { reportId: report.id }, engineDependencies);
    expect(revokeReplay.kind === "command" && revokeReplay.audit.replayed).toBe(true);
  });
});
