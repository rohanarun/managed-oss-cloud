import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { firstPartyGrowthActions, firstPartyGrowthActionsByModule, type FirstPartyGrowthModuleId } from "../src/shared/first-party-growth-actions.js";
import {
  executeFirstPartyGrowthAction,
  recordFirstPartyGrowthAiCompletion,
  type FirstPartyGrowthAuthorization,
  type FirstPartyGrowthEngineDependencies,
} from "../src/server/first-party-growth-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const modules: FirstPartyGrowthModuleId[] = ["giveaways", "testimonials", "brand-pages"];
const firstNow = new Date("2026-08-24T16:00:00.000Z");
const laterNow = new Date("2026-08-26T16:00:00.000Z");
const deps: FirstPartyGrowthEngineDependencies = {
  now: () => firstNow,
  modelPolicyId: "local-reviewed-model",
  publicBaseUrl: "https://cloud.example.test",
  randomBytes: (size) => Buffer.alloc(size, 7),
};
const laterDeps = { ...deps, now: () => laterNow };

function key(label: string) { return `${label}.idempotency.0001`; }
function hashText(value: string) { return createHash("sha256").update(value).digest("hex"); }
function approval(auth: FirstPartyGrowthAuthorization, label: string) {
  return { approved: true as const, approvedBy: auth.userId, decisionId: `${label}.approval.0001`, reason: `Reviewed ${label} evidence and exact content.` };
}

async function actor(store: MemorySuiteStore, enabled = modules) {
  const userId = randomUUID();
  const workspace = await store.getOrCreateWorkspace(userId);
  for (const moduleId of enabled) await store.enableModule(userId, moduleId);
  const current = await store.getOrCreateWorkspace(userId);
  return { userId, workspaceId: workspace.id, role: current.currentRole!, scopes: ["*"] } satisfies FirstPartyGrowthAuthorization;
}

async function run(store: MemorySuiteStore, auth: FirstPartyGrowthAuthorization, moduleId: FirstPartyGrowthModuleId, actionId: string, input: Record<string, unknown>, dependencies: Partial<FirstPartyGrowthEngineDependencies> = deps) {
  return executeFirstPartyGrowthAction(store, auth, moduleId, actionId, input, dependencies);
}

function first(result: Awaited<ReturnType<typeof executeFirstPartyGrowthAction>>) {
  const record = result.records[0];
  if (!record) throw new Error("Expected a result record.");
  return record;
}

function expectStrictObjects(schema: Record<string, unknown>) {
  if (schema.type === "object" && schema.properties) {
    expect(schema.additionalProperties).toBe(false);
    for (const property of Object.values(schema.properties as Record<string, Record<string, unknown>>)) expectStrictObjects(property);
  }
  if (schema.type === "array" && schema.items && typeof schema.items === "object") expectStrictObjects(schema.items as Record<string, unknown>);
}

describe("first-party AI-native growth products", () => {
  it("publishes strict, idempotent CLI and MCP contracts with at least eight actions per module", () => {
    expect(firstPartyGrowthActions).toHaveLength(36);
    for (const moduleId of modules) {
      const actions = firstPartyGrowthActionsByModule.get(moduleId)!;
      expect(actions.length).toBeGreaterThanOrEqual(8);
      expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
      for (const action of actions) {
        expect(action.idempotent).toBe(true);
        expect(action.mcpToolName).toBe(`${moduleId.replaceAll("-", "_")}_${action.id.replaceAll("-", "_")}`);
        expect(action.cliExample).toContain(`supersuite action ${moduleId} ${action.id}`);
        expectStrictObjects(action.inputSchema as unknown as Record<string, unknown>);
        if (action.operation !== "read") expect(action.inputSchema.required).toContain("idempotencyKey");
        if (action.destructive || action.externalEffect) {
          expect(action.inputSchema.required).toContain("dryRun");
          expect(action.inputSchema.properties.approval).toMatchObject({ type: "object", additionalProperties: false });
        }
        if (action.operation === "ai") expect(action).toMatchObject({ promptId: expect.any(String), promptVersion: "2026-08-24.1", requiredScope: "ai" });
      }
    }
    expect(new Set(firstPartyGrowthActions.map((action) => action.mcpToolName)).size).toBe(firstPartyGrowthActions.length);
  });

  it("enforces tenant, enabled-module, role, and scope boundaries before dereferencing records", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerA = await actor(store);
    const ownerB = await actor(store);
    const contest = first(await run(store, ownerA, "giveaways", "contest-create", { name: "Tenant A", closesAt: "2026-08-25T16:00:00.000Z", rules: "One entry", entropyCommitment: "a".repeat(64), consentPolicyVersion: "v1", idempotencyKey: key("tenant-a") }));

    await expect(run(store, ownerB, "giveaways", "contest-publish", { contestId: contest.id, expectedVersion: 1, rulesHash: contest.data.rulesHash, dryRun: true, idempotencyKey: key("cross-tenant") })).rejects.toThrow(/not found/);
    await expect(run(store, { ...ownerA, workspaceId: randomUUID() }, "giveaways", "referral-variant-allocate", { contestId: contest.id, participantKeyHash: "b".repeat(64), experimentId: randomUUID(), variants: [{ key: "a", weight: 1 }] })).rejects.toThrow(/storage transaction|workspace/);
    await expect(run(store, { ...ownerA, scopes: ["giveaways:read"] }, "giveaways", "entry-register", { contestId: contest.id, participantKeyHash: "b".repeat(64), consent: { granted: true, policyVersion: "v1", purposes: ["contest-administration"], capturedAt: firstNow.toISOString(), captureMethod: "hosted-form" }, sourceAttestation: "hosted-form", idempotencyKey: key("scope") })).rejects.toThrow(/giveaways:write scope/);
  });

  it("persists exact-once receipts and rejects idempotency-key equivocation without process memory", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const input = { name: "Launch", closesAt: "2026-08-25T16:00:00.000Z", rules: "One entry", entropyCommitment: "a".repeat(64), consentPolicyVersion: "v1", idempotencyKey: key("contest") };
    const created = await run(store, auth, "giveaways", "contest-create", input);
    const replayed = await run(store, auth, "giveaways", "contest-create", input);
    expect(first(replayed).id).toBe(first(created).id);
    expect(replayed.audit).toMatchObject({ replayed: true, receiptId: created.audit.receiptId });
    expect(await store.listRecords(auth.userId, { moduleId: "giveaways", recordType: "contest", limit: 100 })).toHaveLength(1);
    expect(await store.listRecords(auth.userId, { moduleId: "giveaways", recordType: "growth-command-receipt", limit: 100 })).toHaveLength(1);
    await expect(run(store, auth, "giveaways", "contest-create", { ...input, rules: "Changed after receipt" })).rejects.toThrow(/idempotency key/);
  });

  it("runs consent-aware referral contests and produces a reproducible commit-reveal winner proof", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const entropyReveal = "organizer-secret-with-at-least-16-chars";
    const contest = first(await run(store, auth, "giveaways", "contest-create", { name: "Fair draw", closesAt: "2026-08-25T16:00:00.000Z", rules: "One consented entry per participant.", entropyCommitment: hashText(entropyReveal), consentPolicyVersion: "contest-v1", referralBonusCap: 2, idempotencyKey: key("fair-contest") }));
    await run(store, auth, "giveaways", "contest-publish", { contestId: contest.id, expectedVersion: 1, rulesHash: contest.data.rulesHash, dryRun: false, approval: approval(auth, "contest-publish"), idempotencyKey: key("publish-contest") });
    const entryInput = (participantKeyHash: string, idempotencyKey: string, referralCode?: string) => ({ contestId: contest.id, participantKeyHash, displayName: "Participant", ...(referralCode ? { referralCode } : {}), consent: { granted: true, policyVersion: "contest-v1", purposes: ["contest-administration", "referral-attribution"], capturedAt: firstNow.toISOString(), captureMethod: "hosted-form" }, sourceAttestation: "hosted-form", idempotencyKey });
    const firstEntryResult = await run(store, auth, "giveaways", "entry-register", entryInput("1".repeat(64), key("entry-one")));
    const firstEntry = firstEntryResult.records.find((record) => record.recordType === "entrant")!;
    const secondEntryResult = await run(store, auth, "giveaways", "entry-register", entryInput("2".repeat(64), key("entry-two"), String(firstEntry.data.referralCode)));
    const secondEntry = secondEntryResult.records.find((record) => record.recordType === "entrant")!;
    const signal = first(await run(store, auth, "giveaways", "fraud-signal-record", { entryId: secondEntry.id, signalKind: "referral-loop", severity: "low", evidenceIds: [firstEntry.id], observationSummary: "A mutually linked pseudonymous path needs manual review.", idempotencyKey: key("signal") }));
    await expect(run(store, auth, "giveaways", "fraud-signal-record", { entryId: secondEntry.id, signalKind: "manual-evidence", severity: "high", evidenceIds: [], observationSummary: "Infer age from a participant name.", idempotencyKey: key("protected-signal") })).rejects.toThrow(/protected traits/);
    await run(store, auth, "giveaways", "eligibility-decide", { entryId: secondEntry.id, decision: "eligible", reviewedSignalIds: [signal.id], reason: "No verified disqualifying evidence.", expectedEntryVersion: 1, dryRun: false, approval: approval(auth, "eligibility"), idempotencyKey: key("eligibility") });

    const preview = await run(store, auth, "giveaways", "draw-snapshot-freeze", { contestId: contest.id, expectedContestVersion: 2, dryRun: true, idempotencyKey: key("freeze-preview") }, laterDeps);
    expect(preview.audit).toMatchObject({ dryRun: true, candidateCount: 2, plannedState: "draw-frozen", autonomousExternalSideEffect: false });
    expect(await store.listRecords(auth.userId, { moduleId: "giveaways", recordType: "draw-snapshot", limit: 10 })).toHaveLength(0);
    const frozen = await run(store, auth, "giveaways", "draw-snapshot-freeze", { contestId: contest.id, expectedContestVersion: 2, dryRun: false, approval: approval(auth, "freeze"), idempotencyKey: key("freeze-live") }, laterDeps);
    const snapshot = frozen.records.find((record) => record.recordType === "draw-snapshot")!;
    const drawInput = { snapshotId: snapshot.id, entropyReveal, publicEntropy: "public-beacon-round-12345", publicEntropySource: "https://example.org/randomness/12345", beaconObservedAt: laterNow.toISOString(), dryRun: false, approval: approval(auth, "winner"), idempotencyKey: key("winner") };
    const drawn = await run(store, auth, "giveaways", "winner-draw-reveal", drawInput, laterDeps);
    expect(drawn.audit).toMatchObject({ algorithm: "sha256-commit-public-entropy-rejection-v1", reproducible: true, candidateCount: 2, publicSurfaceChanged: true, providerCallStarted: false, autonomousExternalSideEffect: false });
    expect(String(drawn.audit.winnerToken)).toHaveLength(24);
    const replayed = await run(store, auth, "giveaways", "winner-draw-reveal", drawInput, laterDeps);
    expect(replayed.audit.winnerEntryId).toBe(drawn.audit.winnerEntryId);
    await expect(run(store, auth, "giveaways", "winner-draw-reveal", { ...drawInput, idempotencyKey: key("winner-again"), approval: approval(auth, "winner-again") }, laterDeps)).rejects.toThrow(/undrawn state/);
  });

  it("keeps testimonial evidence private until approved versions publish and revokes every affected surface", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const collection = first(await run(store, auth, "testimonials", "collection-create", { name: "Outcomes", purpose: "Reviewed customer outcomes", consentPolicyVersion: "testimonial-v1", retentionDays: 730, allowedLocales: ["en-US"], idempotencyKey: key("collection") }));
    const requestResult = await run(store, auth, "testimonials", "request-draft", { collectionId: collection.id, recipientRefHash: "3".repeat(64), expiresAt: "2026-09-30T16:00:00.000Z", locale: "en-US", idempotencyKey: key("request") });
    const collectionRequest = first(requestResult);
    expect(requestResult.audit).toMatchObject({ messageSent: false, providerCallStarted: false, externalEffectExecuted: false });
    expect(String(requestResult.audit.collectionUrl)).toMatch(/^https:\/\/cloud\.example\.test\/collect\//);
    const submitted = await run(store, auth, "testimonials", "submission-record", { collectionId: collection.id, requestId: collectionRequest.id, authorName: "Avery", content: "The reviewed workflow reduced handoff time.", attribution: "first-name", authorRole: "Operations lead", organization: "Example Co", consent: { granted: true, policyVersion: "testimonial-v1", purposes: ["testimonial-publication"], capturedAt: firstNow.toISOString(), captureMethod: "hosted-form" }, sourceRefHash: "4".repeat(64), idempotencyKey: key("submission") });
    const testimonial = submitted.records.find((record) => record.recordType === "testimonial")!;
    expect(testimonial.data.public).toBe(false);
    const moderated = await run(store, auth, "testimonials", "moderation-decide", { testimonialId: testimonial.id, decision: "accept", reason: "Exact statement and consent reviewed.", expectedVersion: 1, dryRun: false, approval: approval(auth, "moderation"), idempotencyKey: key("moderation") });
    const decision = moderated.records.find((record) => record.recordType === "moderation-decision")!;
    const publication = first(await run(store, auth, "testimonials", "publication-version-create", { testimonialId: testimonial.id, content: "The reviewed workflow reduced handoff time.", attributionLabel: "Avery, Operations lead", disclosure: "Submitted by a customer.", moderationDecisionId: decision.id, idempotencyKey: key("publication") }));
    await run(store, auth, "testimonials", "publication-publish", { publicationVersionId: publication.id, contentHash: publication.data.contentHash, dryRun: false, approval: approval(auth, "publication-publish"), idempotencyKey: key("publication-publish") });
    const widget = first(await run(store, auth, "testimonials", "widget-version-create", { widgetKey: "homepage-proof", name: "Homepage proof", publicationVersionIds: [publication.id], layout: "grid", theme: { accent: "#2563EB", surface: "#FFFFFF", text: "#111827", radiusPx: 16 }, idempotencyKey: key("widget") }));
    await run(store, auth, "testimonials", "widget-publish", { widgetVersionId: widget.id, contentHash: widget.data.contentHash, dryRun: false, approval: approval(auth, "widget-publish"), idempotencyKey: key("widget-publish") });
    const embed = await run(store, auth, "testimonials", "embed-code-read", { widgetVersionId: widget.id, mode: "script" });
    expect(embed.audit).toMatchObject({ pinnedVersion: true, arbitraryScriptAccepted: false });
    expect(embed.audit.embed).toContain(`data-version=\"${widget.id}\"`);
    const revocation = await run(store, auth, "testimonials", "consent-revoke", { testimonialId: testimonial.id, reason: "Author withdrew publication consent.", dryRun: false, approval: approval(auth, "consent-revoke"), idempotencyKey: key("consent-revoke") });
    expect(revocation.audit).toMatchObject({ publicationVersionsUnpublished: 1, widgetsUnpublished: 1, publicSurfaceChanged: true });
    expect((await store.getRecord(auth.userId, publication.id))?.data.public).toBe(false);
    expect((await store.getRecord(auth.userId, widget.id))?.data.public).toBe(false);
    await expect(run(store, auth, "testimonials", "embed-code-read", { widgetVersionId: widget.id, mode: "script" })).rejects.toThrow(/published widget/);
  });

  it("versions safe page and QR destinations, allocates deterministically, and stores aggregate-only events", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const page = first(await run(store, auth, "brand-pages", "page-create", { slug: "founder-links", name: "Founder links", privacyMode: "aggregate", locale: "en-US", idempotencyKey: key("page") }));
    await expect(run(store, auth, "brand-pages", "destination-version-create", { pageId: page.id, linkKey: "private", destination: "https://127.0.0.1/admin", label: "Private", campaign: {}, idempotencyKey: key("unsafe-destination") })).rejects.toThrow(/public HTTPS/);
    const destination = first(await run(store, auth, "brand-pages", "destination-version-create", { pageId: page.id, linkKey: "docs", destination: "https://example.com/docs", label: "Read the docs", campaign: { source: "bio", medium: "link", name: "launch" }, idempotencyKey: key("destination") }));
    expect(destination.data).toMatchObject({ version: 1, noFetchPerformed: true, requiresResolutionCheckAtUse: true });
    const pageVersion = first(await run(store, auth, "brand-pages", "page-version-create", { pageId: page.id, title: "Build in public", description: "Products and notes.", links: [{ key: "docs", label: "Read the docs", destinationVersionId: destination.id, accessibilityLabel: "Open product documentation" }], layout: "editorial", theme: { accent: "#14B8A6", background: "#0B1020", foreground: "#F8FAFC", radiusPx: 18 }, idempotencyKey: key("page-version") }));
    await run(store, auth, "brand-pages", "page-version-publish", { pageVersionId: pageVersion.id, contentHash: pageVersion.data.contentHash, dryRun: false, approval: approval(auth, "page-publish"), idempotencyKey: key("page-publish") });
    const pageEmbed = await run(store, auth, "brand-pages", "embed-code-read", { pageVersionId: pageVersion.id });
    expect(pageEmbed.audit).toMatchObject({ pinnedVersion: true, arbitraryHtmlAccepted: false });

    const qrRoute = first(await run(store, auth, "brand-pages", "qr-route-create", { slug: "launch-qr", name: "Launch QR", privacyMode: "aggregate", style: { foreground: "#111827", background: "#FFFFFF", errorCorrection: "M" }, idempotencyKey: key("qr-route") }));
    const qrV1 = first(await run(store, auth, "brand-pages", "qr-destination-version-create", { qrRouteId: qrRoute.id, destination: "https://example.com/launch", label: "Launch", campaign: { source: "packaging", medium: "qr", name: "launch" }, idempotencyKey: key("qr-v1") }));
    await run(store, auth, "brand-pages", "qr-destination-activate", { destinationVersionId: qrV1.id, contentHash: qrV1.data.contentHash, dryRun: false, approval: approval(auth, "qr-v1"), idempotencyKey: key("activate-v1") });
    const qrV2 = first(await run(store, auth, "brand-pages", "qr-destination-version-create", { qrRouteId: qrRoute.id, destination: "https://example.com/fall", label: "Fall launch", campaign: {}, idempotencyKey: key("qr-v2") }));
    const activated = await run(store, auth, "brand-pages", "qr-destination-activate", { destinationVersionId: qrV2.id, contentHash: qrV2.data.contentHash, dryRun: false, approval: approval(auth, "qr-v2"), idempotencyKey: key("activate-v2") });
    expect(activated.audit).toMatchObject({ supersededDestinationVersionIds: [qrV1.id], requiresResolutionCheckAtUse: true });
    expect((await store.getRecord(auth.userId, qrV1.id))?.state).toBe("superseded");

    const allocationInput = { experimentId: randomUUID(), visitorKeyHash: "5".repeat(64), variants: [{ key: "control", weight: 2 }, { key: "editorial", weight: 1 }] };
    const allocationA = await run(store, auth, "brand-pages", "variant-allocate", allocationInput);
    const allocationB = await run(store, auth, "brand-pages", "variant-allocate", allocationInput);
    expect(allocationB.audit).toEqual(allocationA.audit);
    expect(allocationA.audit).toMatchObject({ deterministic: true, eventRecorded: false, rawIdentityStored: false });
    const event = await run(store, auth, "brand-pages", "aggregate-event-ingest", { routeId: qrRoute.id, eventId: "beacon.event.0001", eventType: "qr-redirect", occurredOn: "2026-08-24", count: 18, dimensions: { referrerCategory: "direct", deviceClass: "mobile" }, idempotencyKey: key("aggregate") });
    expect(event.audit).toMatchObject({ aggregateOnly: true, rawIdentityStored: false, duplicate: false });
    await expect(run(store, auth, "brand-pages", "aggregate-event-ingest", { routeId: qrRoute.id, eventId: "beacon.event.0002", eventType: "qr-redirect", occurredOn: "2026-08-24", count: 1, dimensions: { ip: "127.0.0.1" }, idempotencyKey: key("raw-event") })).rejects.toThrow(/not allowed/);
  });

  it("queues model work with immutable prompt and evidence provenance and records only validated completions", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const collection = first(await run(store, auth, "testimonials", "collection-create", { name: "Evidence", purpose: "Reviewed evidence", consentPolicyVersion: "v1", retentionDays: 365, idempotencyKey: key("ai-collection") }));
    const queued = await run(store, auth, "testimonials", "review-highlights-propose", { collectionId: collection.id, instruction: "Identify supported themes only.", evidenceIds: [collection.id], idempotencyKey: key("ai-proposal") });
    expect(queued.kind).toBe("ai-action");
    expect(queued.aiAction).toMatchObject({ status: "queued", moduleId: "testimonials" });
    expect(queued.aiAction?.result).toBeUndefined();
    expect(queued.audit).toMatchObject({ promptId: "testimonials.review-highlights-propose", promptVersion: "2026-08-24.1", promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/), modelPolicyId: "local-reviewed-model", executedModel: null, confidence: null, reviewStatus: "pending-model", approvalRequired: true, resultContract: { version: "first-party-growth-ai-result.v1" }, modelExecuted: false, externalEffectExecuted: false });
    const claim = await store.claimAiAction();
    expect(claim?.action.id).toBe(queued.aiAction?.id);
    const completion = { version: "first-party-growth-ai-result.v1" as const, proposal: "One supported theme is a reviewed-evidence workflow.", evidence: [collection.id], confidence: 0.76, assumptions: ["The selected collection is the full authorized evidence set."], reviewStatus: "pending-human-review" as const, approvalRequired: true as const, model: "local-model-v1" };
    await store.completeAiAction(queued.aiAction!.id, { status: "completed", result: completion });
    const recorded = await recordFirstPartyGrowthAiCompletion(store, auth, queued.aiAction!.id, completion, firstNow);
    expect(recorded).toMatchObject({ replayed: false, auditRecord: { state: "pending-human-review", data: { executedModel: "local-model-v1", confidence: 0.76, evidenceIds: [collection.id], reviewStatus: "pending-human-review", resultHash: expect.stringMatching(/^[a-f0-9]{64}$/), externalEffectExecuted: false } } });
    await expect(recordFirstPartyGrowthAiCompletion(store, auth, queued.aiAction!.id, { ...completion, evidence: [randomUUID()] }, firstNow)).rejects.toThrow(/outside the authorized selection/);
    expect((await recordFirstPartyGrowthAiCompletion(store, auth, queued.aiAction!.id, completion, firstNow)).replayed).toBe(true);
  });
});
