import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailActions } from "../src/shared/email-actions.js";
import { suiteModuleById, type SuiteModuleDefinition } from "../src/shared/suite.js";
import { emailIntegrationManifest, executeEmailAction, normalizeEmailAddress, recordEmailAiCompletion, validateEmailAiCompletion, type EmailAuthorization, type EmailExecutionResult } from "../src/server/email-engine.js";
import { emailPromptDigest, emailPromptPolicy } from "../src/server/prompts/email.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const clock = new Date("2026-08-24T18:00:00.000Z");
const providerClock = new Date("2026-09-01T18:00:00.000Z");
const deps = { now: () => new Date(clock), modelPolicyId: "local-reviewed-model" };
const priorModule = suiteModuleById.get("email");
const testModule: SuiteModuleDefinition = {
  id: "email",
  name: "Letterline",
  inspiredBy: "Public newsletter workflows",
  category: "Email",
  description: "Consent-bound audiences, reviewed campaigns, provider-neutral dispatch plans, and verified receipts.",
  minPlan: "starter",
  resourceClass: "shared",
  recordTypes: ["audience", "subscriber", "consent-receipt", "suppression", "campaign", "campaign-version", "campaign-review", "campaign-approval", "campaign-schedule", "dispatch-plan", "provider-receipt", "audience-export"],
  aiCapabilities: ["propose cited subject lines", "propose cited newsletter body"],
};

beforeAll(() => suiteModuleById.set("email", testModule));
afterAll(() => priorModule ? suiteModuleById.set("email", priorModule) : suiteModuleById.delete("email"));

function key(label: string) { return `email-${label}-key-0001`; }
function approval(auth: EmailAuthorization, label: string, at = clock) {
  return { approved: true, approvedBy: auth.userId, approvedAt: at.toISOString(), decisionId: `email-${label}-decision-0001`, reason: `Reviewed the exact ${label} boundary.` };
}
function first(result: EmailExecutionResult, recordType?: string) {
  const record = recordType ? result.records.find((candidate) => candidate.recordType === recordType) : result.records[0];
  if (!record) throw new Error(`Expected ${recordType ?? "a result"} record.`);
  return record;
}

async function fixture(plan: "starter" | "scale" | "fleet" = "starter") {
  const store = new MemorySuiteStore(plan);
  const userId = randomUUID();
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.enableModule(userId, "email");
  const auth: EmailAuthorization = { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
  const run = (actionId: string, input: Record<string, unknown>, at = clock) => executeEmailAction(store, auth, "email", actionId, input, { ...deps, now: () => new Date(at) });
  return { store, userId, workspace, auth, run };
}

async function audience(context: Awaited<ReturnType<typeof fixture>>, suffix = "one") {
  return first(await context.run("audience-create", { name: `Product letter ${suffix}`, purpose: "Send a reviewed product newsletter to people who opted in.", consentPolicyVersion: "newsletter-consent-v1", idempotencyKey: key(`audience-${suffix}`) }));
}

function consent(capturedAt = "2026-08-24T16:00:00.000Z", proof = "a", overrides: Record<string, unknown> = {}) {
  return { granted: true, policyVersion: "newsletter-consent-v1", purposes: ["newsletter"], capturedAt, captureMethod: "hosted-form", sourceProofHash: proof.repeat(64), purchasedList: false, doubleOptInConfirmed: true, reconfirmationAfterSuppression: false, ...overrides };
}

async function subscriber(context: Awaited<ReturnType<typeof fixture>>, audienceId: string, suffix = "one", email = `reader-${suffix}@example.com`) {
  return first(await context.run("subscriber-opt-in-record", { audienceId, email, displayName: `Reader ${suffix}`, locale: "en-US", consent: consent("2026-08-24T16:00:00.000Z", suffix === "one" ? "a" : "b"), idempotencyKey: key(`opt-in-${suffix}`) }), "subscriber");
}

async function campaignThroughDispatch(context: Awaited<ReturnType<typeof fixture>>, audienceId: string, suffix = "one") {
  const campaign = first(await context.run("campaign-create", { audienceId, name: `September letter ${suffix}`, objective: "Explain reviewed improvements to opted-in readers.", idempotencyKey: key(`campaign-${suffix}`) }));
  const drafted = await context.run("campaign-version-draft", { campaignId: campaign.id, expectedCampaignVersion: 1, subject: "September product notes", preheader: "A concise review of improvements.", senderName: "Example Product", replyToEmail: "Hello@Example.com", bodyText: "Hello,\n\nHere are the reviewed improvements.\n\nUnsubscribe: {{unsubscribe_url}}", bodyHtml: "<p>Hello. Here are the reviewed improvements.</p><a href=\"{{unsubscribe_url}}\">Unsubscribe</a>", footer: "Example Product · hello@example.com · {{unsubscribe_url}}", idempotencyKey: key(`draft-${suffix}`) });
  const campaignVersion = first(drafted, "campaign-version");
  const contentHash = String(campaignVersion.data.contentHash);
  const reviewed = await context.run("campaign-review-record", { campaignId: campaign.id, campaignVersionId: campaignVersion.id, expectedCampaignVersion: 2, contentHash, decision: "approved-for-approval", checklist: { consentBoundaryReviewed: true, claimsReviewed: true, unsubscribeMechanismReviewed: true, senderIdentityReviewed: true }, reason: "The exact audience, claims, sender, and unsubscribe path were reviewed.", idempotencyKey: key(`review-${suffix}`) });
  const review = first(reviewed, "campaign-review");
  const approveDry = await context.run("campaign-approve", { campaignId: campaign.id, campaignVersionId: campaignVersion.id, expectedCampaignVersion: 3, contentHash, reviewId: review.id, dryRun: true, idempotencyKey: key(`approve-dry-${suffix}`) });
  expect(approveDry.audit).toMatchObject({ dryRun: true, providerCallStarted: false, messageSent: false });
  await context.run("campaign-approve", { campaignId: campaign.id, campaignVersionId: campaignVersion.id, expectedCampaignVersion: 3, contentHash, reviewId: review.id, dryRun: false, approval: approval(context.auth, `approve-${suffix}`), idempotencyKey: key(`approve-${suffix}`) });
  const scheduledAt = "2026-09-01T16:00:00.000Z";
  await context.run("campaign-schedule", { campaignId: campaign.id, campaignVersionId: campaignVersion.id, expectedCampaignVersion: 4, contentHash, scheduledAt, dryRun: false, approval: approval(context.auth, `schedule-${suffix}`), idempotencyKey: key(`schedule-${suffix}`) });
  const planDry = await context.run("dispatch-plan-create", { campaignId: campaign.id, campaignVersionId: campaignVersion.id, expectedCampaignVersion: 5, contentHash, scheduledAt, providerAdapterId: "customer-provider-adapter-v1", dryRun: true, idempotencyKey: key(`plan-dry-${suffix}`) });
  const planLive = await context.run("dispatch-plan-create", { campaignId: campaign.id, campaignVersionId: campaignVersion.id, expectedCampaignVersion: 5, contentHash, scheduledAt, providerAdapterId: "customer-provider-adapter-v1", dryRun: false, approval: approval(context.auth, `plan-${suffix}`), idempotencyKey: key(`plan-${suffix}`) });
  return { campaign, campaignVersion, contentHash, review, planDry, plan: first(planLive, "dispatch-plan") };
}

function assertStrictObjects(schema: Record<string, unknown>) {
  if (schema.type === "object") expect(schema.additionalProperties).toBe(false);
  if (schema.properties && typeof schema.properties === "object") Object.values(schema.properties as Record<string, Record<string, unknown>>).forEach(assertStrictObjects);
  if (schema.items && typeof schema.items === "object") assertStrictObjects(schema.items as Record<string, unknown>);
}

describe("clean-room AI-native Letterline email workflow", () => {
  it("publishes sixteen strict, idempotent CLI and MCP action contracts", () => {
    expect(emailActions).toHaveLength(16);
    expect(new Set(emailActions.map((action) => action.id)).size).toBe(16);
    expect(new Set(emailActions.map((action) => action.mcpToolName)).size).toBe(16);
    for (const action of emailActions) {
      expect(action.moduleId).toBe("email");
      expect(action.productName).toBe("Letterline");
      expect(action.idempotent).toBe(true);
      expect(action.providerCallsAllowed).toBe(false);
      expect(action.externalEffect).toBe(false);
      expect(action.cliExample).toContain(`supersuite action email ${action.id}`);
      expect(action.mcpToolName).toBe(`email_${action.id.replaceAll("-", "_")}`);
      assertStrictObjects(action.inputSchema as unknown as Record<string, unknown>);
      if (action.operation !== "read") expect(action.inputSchema.required).toContain("idempotencyKey");
      if (action.approvalRequired) expect(action.inputSchema.properties.approval).toMatchObject({ type: "object", additionalProperties: false });
      if (action.operation === "ai") expect(action).toMatchObject({ requiredScope: "ai", promptVersion: "2026-08-24.1" });
    }
    expect(emailPromptDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(emailPromptPolicy.system).toContain("Never invent subscriber consent");
    expect(emailIntegrationManifest()).toMatchObject({ moduleId: "email", productName: "Letterline", engine: "email", minimumPlan: "starter", actions: emailActions.map((action) => action.id), providerCallsAllowed: false, sqlRequirements: { rowLevelSecurity: true, atomicAiCompletion: true } });
    const databaseRequirements = readFileSync(new URL("../docs/clean-room/email/database-requirements.md", import.meta.url), "utf8");
    expect(databaseRequirements).toContain("suite_email_subscriber_hash_key");
    expect(databaseRequirements).toContain("suite_email_provider_event_key");
    expect(databaseRequirements).toContain("Enable and force PostgreSQL row-level security");
  });

  it("enforces paid plan, enabled module, tenant, role, and exact scopes", async () => {
    const context = await fixture();
    const other = await fixture();
    const ownedAudience = await audience(context);
    await expect(executeEmailAction(context.store, { ...context.auth, workspaceId: other.workspace.id }, "email", "subscriber-list", { audienceId: ownedAudience.id, includeSuppressed: false }, deps)).rejects.toThrow(/storage transaction|workspace/);
    await expect(executeEmailAction(context.store, { ...context.auth, scopes: ["email:read"] }, "email", "campaign-create", { audienceId: ownedAudience.id, name: "Denied", objective: "No write scope", idempotencyKey: key("scope-denied") }, deps)).rejects.toThrow(/email:write scope/);
    await expect(executeEmailAction(context.store, { ...context.auth, role: "viewer" }, "email", "campaign-create", { audienceId: ownedAudience.id, name: "Denied", objective: "No role", idempotencyKey: key("role-denied") }, deps)).rejects.toThrow(/role/);
    await expect(other.run("subscriber-list", { audienceId: ownedAudience.id, includeSuppressed: false })).rejects.toThrow(/not found/);
    const unpaid = new MemorySuiteStore("none");
    const unpaidUser = randomUUID();
    const unpaidWorkspace = await unpaid.getOrCreateWorkspace(unpaidUser);
    await expect(executeEmailAction(unpaid, { userId: unpaidUser, workspaceId: unpaidWorkspace.id, role: "owner", scopes: ["*"] }, "email", "audience-create", { name: "Denied", purpose: "No plan", consentPolicyVersion: "v1", idempotencyKey: key("unpaid") }, deps)).rejects.toThrow(/paid plan/);
  });

  it("normalizes and deduplicates addresses while preserving immutable consent evidence", async () => {
    expect(normalizeEmailAddress("  Reader+News@Exämple.com ")).toBe("reader+news@xn--exmple-cua.com");
    expect(() => normalizeEmailAddress("reader..bad@example.com")).toThrow(/invalid format/);
    const context = await fixture();
    const listRecord = await audience(context);
    const firstOptIn = await context.run("subscriber-opt-in-record", { audienceId: listRecord.id, email: "Reader+News@Example.com", displayName: "Reader", locale: "en-US", consent: consent("2026-08-24T16:00:00.000Z", "a"), idempotencyKey: key("normalize-one") });
    const secondOptIn = await context.run("subscriber-opt-in-record", { audienceId: listRecord.id, email: " reader+news@example.COM ", displayName: "Reader Updated", locale: "en-US", consent: consent("2026-08-24T16:05:00.000Z", "b"), idempotencyKey: key("normalize-two") });
    expect(first(firstOptIn, "subscriber").id).toBe(first(secondOptIn, "subscriber").id);
    expect(secondOptIn.audit).toMatchObject({ deduplicatedExistingSubscriber: true, purchasedListAllowed: false, emailHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await context.store.listRecords(context.userId, { moduleId: "email", recordType: "subscriber", limit: 20 })).toHaveLength(1);
    const receipts = await context.store.listRecords(context.userId, { moduleId: "email", recordType: "consent-receipt", limit: 20 });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.state === "immutable" && receipt.data.purchasedList === false && /^[a-f0-9]{64}$/.test(String(receipt.data.receiptHash)))).toBe(true);
    await expect(context.run("subscriber-opt-in-record", { audienceId: listRecord.id, email: "purchased@example.com", consent: consent("2026-08-24T16:00:00.000Z", "c", { purchasedList: true }), idempotencyKey: key("purchased") })).rejects.toThrow(/constant|purchased/);
  });

  it("serializes command retries and rejects idempotency-key equivocation", async () => {
    const context = await fixture();
    const input = { name: "Atomic audience", purpose: "One exact purpose", consentPolicyVersion: "v1", idempotencyKey: key("atomic") };
    const [created, replayed] = await Promise.all([context.run("audience-create", input), context.run("audience-create", input)]);
    expect(first(created).id).toBe(first(replayed).id);
    expect([created.audit.replayed, replayed.audit.replayed].sort()).toEqual([false, true]);
    expect(await context.store.listRecords(context.userId, { moduleId: "email", recordType: "audience", limit: 20 })).toHaveLength(1);
    await expect(context.run("audience-create", { ...input, purpose: "Changed purpose" })).rejects.toThrow(/idempotency key/);
  });

  it("suppresses before dispatch and allows only a newer explicit unsubscribe reconfirmation", async () => {
    const context = await fixture();
    const listRecord = await audience(context);
    const firstSubscriber = await subscriber(context, listRecord.id, "one");
    await subscriber(context, listRecord.id, "two");
    const suppression = await context.run("subscriber-suppress", { subscriberId: firstSubscriber.id, reason: "unsubscribe", occurredAt: "2026-08-24T17:00:00.000Z", evidenceHash: "c".repeat(64), note: "Hosted unsubscribe control", idempotencyKey: key("suppress-one") });
    expect(suppression.audit).toMatchObject({ immediatelyExcludedFromDispatch: true, reason: "unsubscribe" });
    const flow = await campaignThroughDispatch(context, listRecord.id, "suppression");
    expect(flow.planDry.audit).toMatchObject({ recipientCount: 1, excludedCount: 1, providerCallStarted: false, providerCredentialsStored: false, deliveryClaimed: false });
    expect(flow.plan.data.recipientIds).not.toContain(firstSubscriber.id);
    await expect(context.run("subscriber-opt-in-record", { audienceId: listRecord.id, email: "reader-one@example.com", consent: consent("2026-08-24T17:30:00.000Z", "d"), idempotencyKey: key("implicit-resubscribe") })).rejects.toThrow(/reactivation action/);
    await expect(context.run("subscriber-reactivate", { subscriberId: firstSubscriber.id, audienceId: listRecord.id, consent: consent("2026-08-24T16:30:00.000Z", "e", { reconfirmationAfterSuppression: true }), idempotencyKey: key("old-reactivation") })).rejects.toThrow(/newer than/);
    const reactivated = await context.run("subscriber-reactivate", { subscriberId: firstSubscriber.id, audienceId: listRecord.id, consent: consent("2026-08-24T17:30:00.000Z", "f", { reconfirmationAfterSuppression: true }), idempotencyKey: key("reactivate") });
    expect(first(reactivated, "subscriber")).toMatchObject({ state: "active", data: { reactivatedFromSuppressionId: first(suppression, "suppression").id } });
  });

  it("requires exact human review, approval, and schedule hashes before a provider-neutral plan", async () => {
    const context = await fixture();
    const listRecord = await audience(context);
    await subscriber(context, listRecord.id, "one");
    const flow = await campaignThroughDispatch(context, listRecord.id, "lifecycle");
    expect(flow.plan).toMatchObject({ state: "ready-for-provider-adapter", data: { campaignId: flow.campaign.id, campaignVersionId: flow.campaignVersion.id, contentHash: flow.contentHash, recipientCount: 1, providerAdapterId: "customer-provider-adapter-v1", providerCallStarted: false, providerCredentialsStored: false, deliveryClaimed: false, immutable: true } });
    const allRecords = await context.store.listRecords(context.userId, { moduleId: "email", limit: 1_000 });
    expect(JSON.stringify(allRecords)).not.toMatch(/api[_-]?key|secret[_-]?key|bearer\s/i);
    const newCampaign = first(await context.run("campaign-create", { audienceId: listRecord.id, name: "Guarded", objective: "Test exact boundaries.", idempotencyKey: key("guard-campaign") }));
    await expect(context.run("campaign-version-draft", { campaignId: newCampaign.id, expectedCampaignVersion: 1, subject: "Missing unsubscribe", senderName: "Example", replyToEmail: "hello@example.com", bodyText: "No unsubscribe marker", footer: "No marker", idempotencyKey: key("missing-unsubscribe") })).rejects.toThrow(/unsubscribe_url/);
    const draft = await context.run("campaign-version-draft", { campaignId: newCampaign.id, expectedCampaignVersion: 1, subject: "Guarded notes", senderName: "Example", replyToEmail: "hello@example.com", bodyText: "Reviewed notes. {{unsubscribe_url}}", footer: "Example · {{unsubscribe_url}}", idempotencyKey: key("guard-draft") });
    const campaignVersion = first(draft, "campaign-version");
    await expect(context.run("campaign-review-record", { campaignId: newCampaign.id, campaignVersionId: campaignVersion.id, expectedCampaignVersion: 2, contentHash: "0".repeat(64), decision: "approved-for-approval", checklist: { consentBoundaryReviewed: true, claimsReviewed: true, unsubscribeMechanismReviewed: true, senderIdentityReviewed: true }, reason: "Reviewed", idempotencyKey: key("stale-review") })).rejects.toThrow(/hash is stale/);
    const unsafeCampaign = first(await context.run("campaign-create", { audienceId: listRecord.id, name: "Unsafe HTML guard", objective: "Reject active content.", idempotencyKey: key("unsafe-campaign") }));
    await expect(context.run("campaign-version-draft", { campaignId: unsafeCampaign.id, expectedCampaignVersion: 1, subject: "Unsafe", senderName: "Example", replyToEmail: "hello@example.com", bodyText: "Reviewed notes. {{unsubscribe_url}}", bodyHtml: "<script>alert(1)</script><a href=\"{{unsubscribe_url}}\">Unsubscribe</a>", footer: "Example · {{unsubscribe_url}}", idempotencyKey: key("unsafe-draft") })).rejects.toThrow(/unsafe active-content/);
  });

  it("ingests only verified idempotent provider evidence and suppresses complaints immediately", async () => {
    const context = await fixture();
    const listRecord = await audience(context);
    const activeSubscriber = await subscriber(context, listRecord.id, "receipt");
    const flow = await campaignThroughDispatch(context, listRecord.id, "receipt");
    const base = { dispatchPlanId: flow.plan.id, subscriberId: activeSubscriber.id, eventId: "provider.event.0001", eventType: "delivered", occurredAt: "2026-09-01T16:01:00.000Z", providerMessageRefHash: "d".repeat(64), gatewayVerification: { verified: true, verifierId: "signed-webhook-gateway-v1", verifiedAt: "2026-09-01T16:01:01.000Z", payloadHash: "e".repeat(64) } };
    const delivered = await context.run("provider-receipt-ingest", { ...base, idempotencyKey: key("receipt-delivered") }, providerClock);
    expect(delivered.audit).toMatchObject({ verifiedGatewayEvidence: true, duplicateProviderEvent: false, eventType: "delivered", platformDeliveryClaimed: false });
    const duplicate = await context.run("provider-receipt-ingest", { ...base, idempotencyKey: key("receipt-delivered-duplicate") }, providerClock);
    expect(first(duplicate, "provider-receipt").id).toBe(first(delivered, "provider-receipt").id);
    expect(duplicate.audit.duplicateProviderEvent).toBe(true);
    await expect(context.run("provider-receipt-ingest", { ...base, eventType: "soft-bounce", idempotencyKey: key("receipt-conflict") }, providerClock)).rejects.toThrow(/different verified evidence/);
    const complaint = await context.run("provider-receipt-ingest", { ...base, eventId: "provider.event.0002", eventType: "complaint", occurredAt: "2026-09-01T16:02:00.000Z", providerMessageRefHash: "f".repeat(64), gatewayVerification: { ...base.gatewayVerification, verifiedAt: "2026-09-01T16:02:01.000Z", payloadHash: "1".repeat(64) }, idempotencyKey: key("receipt-complaint") }, providerClock);
    expect(complaint.audit).toMatchObject({ immediatelyExcludedFromFutureDispatch: true, suppressionId: expect.any(String) });
    expect(await context.store.getRecord(context.userId, activeSubscriber.id)).toMatchObject({ state: "suppressed", data: { suppressionReason: "complaint" } });
    await expect(context.run("subscriber-reactivate", { subscriberId: activeSubscriber.id, audienceId: listRecord.id, consent: consent("2026-09-01T17:00:00.000Z", "2", { reconfirmationAfterSuppression: true }), idempotencyKey: key("complaint-reactivate") }, providerClock)).rejects.toThrow(/cannot be reactivated/);
    const analytics = await context.run("campaign-analytics-aggregate", { campaignId: flow.campaign.id, from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" }, providerClock);
    expect(analytics.audit).toMatchObject({ verifiedProviderReceiptCount: 2, counts: { delivered: 1, complaint: 1 }, opens: null, clicks: null, revenue: null, attribution: null, fabricatedMetrics: false });
  });

  it("queues cited AI proposals under the immutable policy and never mutates a campaign", async () => {
    const context = await fixture();
    const listRecord = await audience(context);
    const campaign = first(await context.run("campaign-create", { audienceId: listRecord.id, name: "AI letter", objective: "Use selected evidence only.", idempotencyKey: key("ai-campaign") }));
    const queued = await context.run("body-propose", { campaignId: campaign.id, instruction: "Draft a factual body with citations and an unsubscribe marker.", evidenceIds: [listRecord.id], idempotencyKey: key("ai-body") });
    expect(queued).toMatchObject({ kind: "ai-action", audit: { platformPromptId: "first-party.email.cited-newsletter-proposals", platformPromptVersion: "2026-08-24.1", platformPromptDigest: expect.stringMatching(/^[a-f0-9]{64}$/), allowedProposalKinds: ["body"], reviewStatus: "pending-model", providerCallAllowed: false, output: null } });
    const completion = { version: "letterline-ai-result.v1" as const, proposals: [{ proposalId: "body-1", kind: "body" as const, content: "The selected audience record supports this purpose statement.\n\nUnsubscribe: {{unsubscribe_url}}", citations: [listRecord.id], rationale: "The audience purpose is the cited source.", riskFlags: ["Human review required."] }], confidence: 0.78, assumptions: ["The selected audience record is current."], reviewStatus: "pending-human-review" as const, approvalRequired: true as const, model: "local-model-v1" };
    expect(() => validateEmailAiCompletion({ ...completion, proposals: [{ ...completion.proposals[0], citations: [randomUUID()] }] }, { authorizedRecordIds: [campaign.id, listRecord.id], allowedProposalKinds: ["body"] })).toThrow(/authorized records/);
    expect(() => validateEmailAiCompletion({ ...completion, proposals: [{ ...completion.proposals[0], content: "No unsubscribe marker." }] }, { authorizedRecordIds: [campaign.id, listRecord.id], allowedProposalKinds: ["body"] })).toThrow(/unsubscribe marker/);
    const claim = await context.store.claimAiAction();
    expect(claim?.action.id).toBe(queued.aiAction?.id);
    await context.store.completeAiAction(claim!.action.id, { status: "completed", result: completion });
    const recorded = await recordEmailAiCompletion(context.store, context.auth, claim!.action.id, undefined, clock);
    expect(recorded).toMatchObject({ replayed: false, auditRecord: { state: "pending-human-review", data: { executedModel: "local-model-v1", confidence: 0.78, proposalKinds: ["body"], automaticMutationAllowed: false, providerCallAllowed: false } } });
    expect(await context.store.getRecord(context.userId, campaign.id)).toMatchObject({ state: "draft-empty", data: { version: 1 } });
    expect((await recordEmailAiCompletion(context.store, context.auth, claim!.action.id, completion, clock)).replayed).toBe(true);
  });

  it("returns private exports once without placing rows in manifests or receipts", async () => {
    const context = await fixture();
    const listRecord = await audience(context);
    const activeSubscriber = await subscriber(context, listRecord.id, "export");
    const dry = await context.run("audience-export", { audienceId: listRecord.id, format: "canonical-json", includeSuppressed: false, dryRun: true, idempotencyKey: key("export-dry") });
    expect(dry.audit).toMatchObject({ rowCount: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), privateExport: true, providerCredentialsStored: false });
    expect(dry.privateOutput).toBeUndefined();
    const input = { audienceId: listRecord.id, format: "canonical-json", includeSuppressed: false, dryRun: false, approval: approval(context.auth, "export"), idempotencyKey: key("export") };
    const exported = await context.run("audience-export", input);
    expect(exported.privateOutput?.audienceExport.rows).toEqual([expect.objectContaining({ subscriberId: activeSubscriber.id, normalizedEmail: "reader-export@example.com", suppressed: false })]);
    const manifest = first(exported, "audience-export");
    expect(manifest.data).toMatchObject({ rowCount: 1, rowsStored: false, providerCredentialsStored: false, immutable: true });
    expect(manifest.data).not.toHaveProperty("rows");
    const replayed = await context.run("audience-export", input);
    expect(replayed.privateOutput).toBeUndefined();
    expect(replayed.audit.privateOutputUnavailableOnReplay).toBe(true);
    const commandReceipts = await context.store.listRecords(context.userId, { moduleId: "email", recordType: "email-command-receipt", limit: 1_000 });
    expect(JSON.stringify(commandReceipts)).not.toContain("reader-export@example.com");
  });
});
