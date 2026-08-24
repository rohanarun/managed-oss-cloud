import { describe, expect, it } from "vitest";
import { executeSuiteAction, type SuiteEngineDependencies, type SuiteActionResult } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { suiteAction, suiteActionInputJsonSchema, suiteActionToolName, suiteActionsByModule } from "../src/shared/suite-actions";
import { suiteModuleById } from "../src/shared/suite";

const userA = "10101010-1010-4010-8010-101010101010";
const userB = "20202020-2020-4020-8020-202020202020";

function dependencies(overrides: Partial<SuiteEngineDependencies> = {}): SuiteEngineDependencies {
  return {
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    resolveTxt: async () => [],
    resolveHost: async () => ["93.184.216.34"],
    ...overrides,
  };
}

function firstRecord(result: SuiteActionResult) {
  if (result.kind === "record") return result.record;
  if (result.kind === "command" && result.records[0]) return result.records[0];
  throw new Error("Expected a durable record result.");
}

async function createSite(store: MemorySuiteStore, userId: string, moduleId: "consent" | "seo", name: string) {
  await store.enableModule(userId, moduleId);
  return firstRecord(await executeSuiteAction(store, userId, moduleId, "site-create", { name }));
}

async function configuredConsentSite(store: MemorySuiteStore, userId = userA) {
  const site = await createSite(store, userId, "consent", "Primary privacy site");
  return firstRecord(await executeSuiteAction(store, userId, "consent", "site-configure", { siteId: site.id, domain: "privacy.example.com", fallbackBehavior: "essential-only" }, dependencies()));
}

async function verifiedConsentSite(store: MemorySuiteStore, userId = userA) {
  const site = await configuredConsentSite(store, userId);
  const challenge = String(site.data.verificationChallenge);
  return firstRecord(await executeSuiteAction(store, userId, "consent", "domain-verify", { siteId: site.id }, dependencies({ resolveTxt: async () => [[challenge]] })));
}

async function draftConsentPolicy(store: MemorySuiteStore, siteId: string, userId = userA) {
  return firstRecord(await executeSuiteAction(store, userId, "consent", "policy-draft", {
    siteId,
    fallbackBehavior: "essential-only",
    locale: "en-US",
    purposes: [
      { key: "essential", label: "Essential", description: "Required to provide the requested service.", required: true },
      { key: "analytics", label: "Analytics", description: "Optional aggregate product measurement.", required: false },
    ],
    services: [
      { key: "site-analytics", label: "Site analytics", description: "Customer-configured aggregate analytics.", purposeKeys: ["analytics"], resourceRules: ["https://metrics.example.com/*"] },
    ],
  }, dependencies()));
}

async function configuredSeoSite(store: MemorySuiteStore, dailyUnitLimit = 50, userId = userA) {
  const site = await createSite(store, userId, "seo", "Primary search site");
  return firstRecord(await executeSuiteAction(store, userId, "seo", "site-configure", { siteId: site.id, origin: "https://example.com", locale: "en-US", device: "desktop", dailyUnitLimit }, dependencies()));
}

async function seoKeyword(store: MemorySuiteStore, siteId: string, userId = userA) {
  return firstRecord(await executeSuiteAction(store, userId, "seo", "keyword-add", { siteId, query: "private cloud hosting", country: "US", device: "desktop" }, dependencies()));
}

describe("clean-room consent and SEO modules", () => {
  it("publishes plan, resource, action, CLI, and MCP metadata through the shared generators", () => {
    const consent = suiteModuleById.get("consent")!;
    const seo = suiteModuleById.get("seo")!;
    expect(consent).toMatchObject({ minPlan: "starter", resourceClass: "shared", scaleGuidance: expect.stringContaining("Scale") });
    expect(seo).toMatchObject({ minPlan: "starter", resourceClass: "shared", scaleGuidance: expect.stringContaining("Scale") });
    expect(consent.recordTypes).toContain("consent-receipt");
    expect(seo.recordTypes).toContain("audit-run");
    expect(suiteActionsByModule.get("consent")?.map((action) => action.id)).toEqual(expect.arrayContaining(["domain-verify", "policy-publish", "choice-record"]));
    expect(suiteActionsByModule.get("seo")?.map((action) => action.id)).toEqual(expect.arrayContaining(["rank-run", "audit-start", "brief-approve"]));
    expect(suiteActionToolName(suiteAction("consent", "policy-publish")!)).toBe("consent_policy_publish");
    expect(suiteActionToolName(suiteAction("seo", "rank-run")!)).toBe("seo_rank_run");
    expect(suiteActionInputJsonSchema(suiteAction("consent", "policy-draft")!).properties.purposes).toMatchObject({ type: "array" });
    expect(suiteActionInputJsonSchema(suiteAction("seo", "audit-start")!).properties.urls).toMatchObject({ type: "array" });
  });

  it("rejects publication for an unverified domain without changing the approved revision", async () => {
    const store = new MemorySuiteStore("starter");
    const site = await configuredConsentSite(store);
    const revision = await draftConsentPolicy(store, site.id);
    const contentHash = String(revision.data.contentHash);
    await executeSuiteAction(store, userA, "consent", "policy-approve", { revisionId: revision.id, contentHash }, dependencies());

    await expect(executeSuiteAction(store, userA, "consent", "policy-publish", { revisionId: revision.id, contentHash, idempotencyKey: "publish-unverified-0001" }, dependencies())).rejects.toThrow(/domain is verified/);
    expect(await store.getRecord(userA, revision.id)).toMatchObject({ state: "approved", data: { public: false } });
    expect((await store.listRecords(userA, { moduleId: "consent", recordType: "policy-revision", limit: 20 })).filter((item) => item.state === "published")).toEqual([]);
  });

  it("verifies DNS server-side, publishes the approved hash idempotently, and appends pseudonymous immutable receipts", async () => {
    const store = new MemorySuiteStore("starter");
    const site = await verifiedConsentSite(store);
    const revision = await draftConsentPolicy(store, site.id);
    const contentHash = String(revision.data.contentHash);
    await executeSuiteAction(store, userA, "consent", "policy-approve", { revisionId: revision.id, contentHash }, dependencies());
    const firstPublish = await executeSuiteAction(store, userA, "consent", "policy-publish", { revisionId: revision.id, contentHash, idempotencyKey: "publish-policy-000001" }, dependencies());
    const replay = await executeSuiteAction(store, userA, "consent", "policy-publish", { revisionId: revision.id, contentHash, idempotencyKey: "publish-policy-000001" }, dependencies());
    expect(firstRecord(replay).id).toBe(firstRecord(firstPublish).id);
    expect(replay.kind === "command" && replay.audit.replayed).toBe(true);

    const visitorKey = "site-local-random-key-0001";
    const firstChoice = firstRecord(await executeSuiteAction(store, userA, "consent", "choice-record", {
      siteId: site.id,
      revisionId: revision.id,
      visitorKey,
      decisions: [{ key: "essential", allowed: true }, { key: "analytics", allowed: false }],
      rawIp: "203.0.113.9",
      cookie: "must-not-persist",
    }, dependencies()));
    const preservedFirst = structuredClone(firstChoice);
    const secondChoice = firstRecord(await executeSuiteAction(store, userA, "consent", "choice-record", {
      siteId: site.id,
      revisionId: revision.id,
      visitorKey,
      decisions: [{ key: "essential", allowed: true }, { key: "analytics", allowed: true }],
      gpc: true,
    }, dependencies({ now: () => new Date("2026-08-24T12:01:00.000Z") })));
    expect(secondChoice.data.priorReceiptId).toBe(firstChoice.id);
    expect(await store.getRecord(userA, firstChoice.id)).toEqual(preservedFirst);
    const serialized = JSON.stringify(await store.listRecords(userA, { moduleId: "consent", recordType: "consent-receipt", limit: 20 }));
    expect(serialized).not.toContain(visitorKey);
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("must-not-persist");
  });

  it("blocks unresolved governed observations and cross-workspace policy access", async () => {
    const store = new MemorySuiteStore("starter");
    const site = await configuredConsentSite(store, userA);
    const observation = await store.createRecord(userA, { moduleId: "consent", recordType: "resource-observation", title: "metrics.example.com", data: { siteId: site.id, governed: true, classificationState: "unresolved", rawEvidenceHash: "evidence" } });
    await expect(draftConsentPolicy(store, site.id, userA)).rejects.toThrow(/Resolve or explicitly ignore/);
    await store.updateRecord(userA, observation!.id, { data: { classificationState: "resolved" } });
    const revision = await draftConsentPolicy(store, site.id, userA);

    await store.enableModule(userB, "consent");
    await expect(executeSuiteAction(store, userB, "consent", "policy-approve", { revisionId: revision.id, contentHash: revision.data.contentHash }, dependencies())).rejects.toThrow(/not found/);
    expect(await store.getRecord(userB, revision.id)).toBeUndefined();
  });

  it("deduplicates exact keyword series and rank checks before enforcing provider-unit ceilings", async () => {
    const store = new MemorySuiteStore("starter");
    const site = await configuredSeoSite(store, 1);
    const keyword = await seoKeyword(store, site.id);
    await expect(executeSuiteAction(store, userA, "seo", "keyword-add", { siteId: site.id, query: "  PRIVATE   CLOUD HOSTING ", country: "US", device: "desktop" }, dependencies())).rejects.toThrow(/already exists/);

    const input = { keywordId: keyword.id, provider: "customer-serp-provider", idempotencyKey: "rank-check-key-0001" };
    const queued = await executeSuiteAction(store, userA, "seo", "rank-run", input, dependencies());
    const replay = await executeSuiteAction(store, userA, "seo", "rank-run", input, dependencies());
    expect(firstRecord(replay).id).toBe(firstRecord(queued).id);
    expect(replay.kind === "command" && replay.audit.replayed).toBe(true);
    await expect(executeSuiteAction(store, userA, "seo", "rank-run", { ...input, idempotencyKey: "rank-check-key-0002" }, dependencies())).rejects.toThrow(/daily provider-unit ceiling/);
    const checks = await store.listRecords(userA, { moduleId: "seo", recordType: "rank-check", limit: 20 });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ state: "queued", data: { estimatedProviderUnits: 1, externalCallStarted: false } });
  });

  it("rejects private or metadata crawl resolution before queueing and strips query secrets from safe audit targets", async () => {
    const store = new MemorySuiteStore("starter");
    const site = await configuredSeoSite(store);
    await expect(executeSuiteAction(store, userA, "seo", "audit-start", { siteId: site.id, urls: ["https://example.com/private?token=secret"] }, dependencies({ resolveHost: async () => ["169.254.169.254"] }))).rejects.toThrow(/private, reserved, loopback, link-local, or metadata/);
    expect(await store.listRecords(userA, { moduleId: "seo", recordType: "audit-run", limit: 20 })).toEqual([]);

    const queued = firstRecord(await executeSuiteAction(store, userA, "seo", "audit-start", { siteId: site.id, urls: ["https://example.com/private?token=secret"] }, dependencies()));
    expect(queued.data).toMatchObject({ requestedUrls: ["https://example.com/private"], redirectPolicy: "same-origin-public-only", externalCallStarted: false });
    expect(JSON.stringify(queued)).not.toContain("token=secret");
  });

  it("approves only an exact cited brief version, never publishes it, and redacts arbitrary AI context", async () => {
    const store = new MemorySuiteStore("starter");
    const site = await configuredSeoSite(store);
    const keyword = await seoKeyword(store, site.id);
    const check = firstRecord(await executeSuiteAction(store, userA, "seo", "rank-run", { keywordId: keyword.id, provider: "customer-proxy", idempotencyKey: "brief-evidence-00001" }, dependencies()));
    const brief = firstRecord(await executeSuiteAction(store, userA, "seo", "brief-create", { siteId: site.id, keywordId: keyword.id, title: "Private cloud content brief", evidenceIds: [check.id], outline: ["Measured context", "Customer questions"] }, dependencies()));
    const contentHash = String(brief.data.contentHash);
    await expect(executeSuiteAction(store, userA, "seo", "brief-approve", { briefId: brief.id, contentHash: "0".repeat(64) }, dependencies())).rejects.toThrow(/does not match/);
    const approved = firstRecord(await executeSuiteAction(store, userA, "seo", "brief-approve", { briefId: brief.id, contentHash }, dependencies()));
    expect(approved).toMatchObject({ state: "approved", data: { contentHash, approvedContentHash: contentHash, cmsPublished: false } });

    const ai = await executeSuiteAction(store, userA, "seo", "brief-draft", { siteId: site.id, keywordId: keyword.id, evidenceIds: [check.id], instruction: "Draft an outline using only the selected evidence.", connectorToken: "secret-token" }, dependencies());
    expect(ai.kind).toBe("ai-action");
    if (ai.kind === "ai-action") {
      expect(ai.aiAction.context).toEqual({ actionId: "brief-draft", siteId: site.id, keywordId: keyword.id, evidenceIds: [check.id], instruction: "Draft an outline using only the selected evidence.", requestedByUserId: userA });
      expect(JSON.stringify(ai.aiAction.context)).not.toContain("secret-token");
    }
  });
});
