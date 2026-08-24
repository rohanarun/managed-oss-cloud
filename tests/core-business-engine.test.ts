import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { coreBusinessActions, coreBusinessActionsByModule, type CoreBusinessModuleId } from "../src/shared/core-business-actions.js";
import { executeCoreBusinessAction, executeCoreBusinessActionWithStorage, exportCoreBusinessSnapshot, importCoreBusinessSnapshotWithStorage, recordCoreBusinessAiCompletion, suiteStoreCoreBusinessStorage, validateCoreBusinessSnapshot, type CoreBusinessAuthorization, type CoreBusinessEngineDependencies, type CoreBusinessStorageAdapter } from "../src/server/core-business-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const modules: CoreBusinessModuleId[] = ["automate", "publish", "inbox", "crm", "tasks", "feedback", "knowledge", "links"];
const fixedNow = new Date("2026-08-24T12:00:00.000Z");
const deps: CoreBusinessEngineDependencies = { now: () => fixedNow, modelPolicyId: "local-audited-model" };
const key = (label: string) => `${label}.idempotency-key-0001`;

async function actor(store: MemorySuiteStore, userId = randomUUID()) {
  const workspace = await store.getOrCreateWorkspace(userId);
  for (const moduleId of modules) await store.enableModule(userId, moduleId);
  const refreshed = await store.getOrCreateWorkspace(userId);
  return { userId, workspaceId: refreshed.id, role: "owner", scopes: ["*"] } satisfies CoreBusinessAuthorization;
}

async function run(store: MemorySuiteStore, auth: CoreBusinessAuthorization, moduleId: CoreBusinessModuleId, actionId: string, input: Record<string, unknown>, dependencies = deps) {
  return executeCoreBusinessAction(store, auth, moduleId, actionId, input, dependencies);
}

function first(result: Awaited<ReturnType<typeof executeCoreBusinessAction>>) {
  const record = result.records[0];
  if (!record) throw new Error("Expected a result record.");
  return record;
}

describe("clean-room AI-native core business suite", () => {
  it("publishes at least eight specialized CLI/MCP contracts per module", () => {
    expect(coreBusinessActions).toHaveLength(72);
    for (const moduleId of modules) {
      const actions = coreBusinessActionsByModule.get(moduleId)!;
      expect(actions.length).toBeGreaterThanOrEqual(8);
      expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
      for (const action of actions) {
        expect(action.productName).not.toMatch(/Activepieces|Postiz|Chatwoot|Frappe|Vikunja|Fider|BookStack|Slash/i);
        expect(action.mcpToolName).toBe(`${moduleId}_${action.id.replaceAll("-", "_")}`);
        expect(action.cliExample).toContain(`supersuite action ${moduleId} ${action.id}`);
        expect(action.inputSchema.additionalProperties).toBe(false);
        if (action.operation !== "read") {
          expect(action.inputSchema.required).toContain("idempotencyKey");
          expect(action.inputSchema.properties.idempotencyKey).toMatchObject({ type: "string", pattern: expect.any(String) });
        }
        if (action.externalEffect || action.destructive) {
          expect(action.inputSchema.required).toContain("dryRun");
          expect(action.inputSchema.properties.approval).toMatchObject({ type: "object", additionalProperties: false });
        }
        if (action.operation === "ai") expect(action).toMatchObject({ promptId: expect.any(String), promptVersion: "2026-08-24.1", requiredScope: "ai" });
      }
    }
    expect(new Set(coreBusinessActions.map((action) => action.mcpToolName)).size).toBe(coreBusinessActions.length);
  });

  it("enforces tenant and scope isolation before dereferencing business records", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerA = await actor(store);
    const ownerB = await actor(store);
    const account = first(await run(store, ownerA, "crm", "account-upsert", { externalKey: "tenant-a", name: "Tenant A", domain: "a.example", idempotencyKey: key("account-a") }));

    await expect(run(store, ownerB, "crm", "activity-record", { accountId: account.id, kind: "note", occurredAt: fixedNow.toISOString(), summary: "Should never resolve", idempotencyKey: key("cross-tenant") })).rejects.toThrow(/not found/);
    await expect(run(store, { ...ownerB, workspaceId: ownerA.workspaceId }, "crm", "pipeline-forecast", { currency: "USD", stageProbabilities: { qualified: 0.2 } })).rejects.toThrow(/workspace does not match/);
    await expect(run(store, { ...ownerA, scopes: ["crm:read"] }, "crm", "activity-record", { accountId: account.id, kind: "note", occurredAt: fixedNow.toISOString(), summary: "No write scope", idempotencyKey: key("scope-denied") })).rejects.toThrow(/crm:write scope/);
    expect(await store.getRecord(ownerB.userId, account.id)).toBeUndefined();
  });

  it("replays mutations exactly once and rejects idempotency-key equivocation", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const input = { externalKey: "acct-42", name: "Northwind", domain: "northwind.example", idempotencyKey: key("account") };
    const created = await run(store, auth, "crm", "account-upsert", input);
    const replayed = await run(store, auth, "crm", "account-upsert", input);
    expect(first(replayed).id).toBe(first(created).id);
    expect(replayed.audit).toMatchObject({ replayed: true, receiptId: created.audit.receiptId });
    expect(await store.listRecords(auth.userId, { moduleId: "crm", recordType: "account", limit: 100 })).toHaveLength(1);
    expect(await store.listRecords(auth.userId, { moduleId: "crm", recordType: "command-receipt", limit: 100 })).toHaveLength(1);
    await expect(run(store, auth, "crm", "account-upsert", { ...input, name: "Different" })).rejects.toThrow(/idempotency key was already used/);
  });

  it("keeps external publication inert in dry-run and requires attributed approval to execute", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const campaign = first(await run(store, auth, "publish", "campaign-draft", { name: "Launch", goal: "Qualified visits", audience: "Opt-in customers", channelIds: [randomUUID()], idempotencyKey: key("campaign") }));
    await run(store, auth, "publish", "campaign-approve", { campaignId: campaign.id, contentHash: campaign.data.contentHash, idempotencyKey: key("approve-campaign") });
    const post = first(await run(store, auth, "publish", "post-schedule", { campaignId: campaign.id, channelId: randomUUID(), content: "Reviewed launch copy", scheduledAt: "2026-08-25T12:00:00.000Z", campaignHash: campaign.data.contentHash, idempotencyKey: key("post") }));
    const executor = vi.fn(async () => ({ provider: "test-provider", externalId: "accepted-42", status: "accepted" as const, occurredAt: fixedNow.toISOString() }));
    const externalDeps = { ...deps, externalExecutor: executor };

    const preview = await run(store, auth, "publish", "publication-dispatch", { scheduledPostId: post.id, dryRun: true, idempotencyKey: key("dispatch-preview") }, externalDeps);
    expect(preview.audit).toMatchObject({ dryRun: true, externalEffectExecuted: false, destructiveMutationApplied: false });
    expect(executor).not.toHaveBeenCalled();
    expect(await store.listRecords(auth.userId, { moduleId: "publish", recordType: "publication-delivery", limit: 100 })).toHaveLength(0);

    await expect(run(store, auth, "publish", "publication-dispatch", { scheduledPostId: post.id, dryRun: false, idempotencyKey: key("dispatch-unapproved") }, externalDeps)).rejects.toThrow(/approval/);
    expect(executor).not.toHaveBeenCalled();
    const live = await run(store, auth, "publish", "publication-dispatch", { scheduledPostId: post.id, dryRun: false, approval: { approved: true, approvedBy: auth.userId, decisionId: "publication.approval-0001", reason: "Copy and destination reviewed" }, idempotencyKey: key("dispatch-live") }, externalDeps);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(live.audit).toMatchObject({ externalEffectExecuted: true, providerStatus: "accepted", approvedBy: auth.userId });
    expect(live.records.some((record) => record.recordType === "external-effect-receipt" && record.data.externalId === "accepted-42")).toBe(true);
  });

  it("queues auditable AI proposals without manufacturing model outputs or side effects", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const workflow = first(await run(store, auth, "automate", "workflow-version-create", { name: "Lead intake", triggerSchema: { type: "object", required: ["leadId"] }, steps: [{ key: "qualify", kind: "transform" }], idempotencyKey: key("workflow") }));
    const simulated = first(await run(store, auth, "automate", "workflow-run-simulate", { workflowVersionId: workflow.id, event: { leadId: "lead-42" }, idempotencyKey: key("simulation") }));
    const queued = await run(store, auth, "automate", "failure-diagnose", { runId: simulated.id, instruction: "Explain the first causal failure.", evidenceIds: [simulated.id, workflow.id], idempotencyKey: key("diagnosis") });
    expect(queued.kind).toBe("ai-action");
    expect(queued.aiAction).toMatchObject({ status: "queued", moduleId: "automate" });
    expect(queued.audit).toMatchObject({ promptId: "automate.failure-diagnose", promptVersion: "2026-08-24.1", promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/), modelPolicyId: "local-audited-model", executedModel: null, confidence: null, reviewStatus: "pending-model", approvalRequired: true, modelExecuted: false, evidenceIds: [simulated.id, workflow.id] });
    expect(first(queued)).toMatchObject({ recordType: "ai-request-audit", state: "queued", data: { executedModel: null, confidence: null, reviewStatus: "pending-model", immutableRequest: true } });
    expect(queued.aiAction?.result).toBeUndefined();

    const completion = { proposal: "Inspect the typed transform input before a bounded retry.", evidence: [simulated.id], confidence: 0.72, assumptions: ["The simulation reflects the failing version."], reviewStatus: "pending-human-review" as const, approvalRequired: true as const, model: "local-model-v1" };
    expect((await store.claimAiAction())?.action.id).toBe(queued.aiAction!.id);
    await store.completeAiAction(queued.aiAction!.id, { status: "completed", result: completion });
    const recorded = await recordCoreBusinessAiCompletion(store, auth, queued.aiAction!.id, completion, fixedNow);
    expect(recorded).toMatchObject({ replayed: false, auditRecord: { state: "pending-human-review", data: { executedModel: "local-model-v1", confidence: 0.72, evidenceIds: [simulated.id], reviewStatus: "pending-human-review", resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    await expect(recordCoreBusinessAiCompletion(store, auth, queued.aiAction!.id, { ...completion, evidence: [randomUUID()] }, fixedNow)).rejects.toThrow(/outside the authorized selection/);
    expect((await recordCoreBusinessAiCompletion(store, auth, queued.aiAction!.id, completion, fixedNow)).replayed).toBe(true);
  });

  it("enforces specialized workflow, task, CRM, feedback, knowledge, inbox, and link invariants", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);

    await expect(run(store, auth, "automate", "workflow-version-create", { name: "Cycle", triggerSchema: {}, steps: [{ key: "first", dependsOn: ["second"] }, { key: "second", dependsOn: ["first"] }], idempotencyKey: key("cycle") })).rejects.toThrow(/cycle/);

    const account = first(await run(store, auth, "crm", "account-upsert", { externalKey: "acct", name: "Acme", domain: "acme.example", idempotencyKey: key("acct-core") }));
    const opportunity = first(await run(store, auth, "crm", "opportunity-open", { accountId: account.id, name: "Expansion", amountMinor: 100_001, currency: "USD", expectedCloseAt: "2026-10-01T00:00:00.000Z", idempotencyKey: key("opportunity") }));
    const forecast = await run(store, auth, "crm", "pipeline-forecast", { currency: "USD", stageProbabilities: { qualified: 0.25 } });
    expect(forecast.audit).toMatchObject({ totalMinor: 100_001, weightedMinor: 25_000, deterministic: true });

    const project = first(await run(store, auth, "tasks", "project-blueprint-create", { name: "Launch", states: ["backlog", "doing", "done"], workInProgressLimits: { doing: 2 }, idempotencyKey: key("project") }));
    const predecessor = first(await run(store, auth, "tasks", "work-item-create", { projectId: project.id, title: "Foundation", acceptanceCriteria: ["Verified"], priority: "high", idempotencyKey: key("task-a") }));
    const successor = first(await run(store, auth, "tasks", "work-item-create", { projectId: project.id, title: "Release", acceptanceCriteria: ["Verified"], priority: "normal", idempotencyKey: key("task-b") }));
    await run(store, auth, "tasks", "dependency-link", { projectId: project.id, predecessorId: predecessor.id, successorId: successor.id, idempotencyKey: key("edge-a") });
    await expect(run(store, auth, "tasks", "dependency-link", { projectId: project.id, predecessorId: successor.id, successorId: predecessor.id, idempotencyKey: key("edge-cycle") })).rejects.toThrow(/cycle/);

    const board = first(await run(store, auth, "feedback", "board-create", { name: "Ideas", visibility: "public", votingPolicy: "verified-submitters", idempotencyKey: key("board") }));
    const request = first(await run(store, auth, "feedback", "request-submit", { boardId: board.id, title: "Bulk export", problem: "One-by-one export is slow", consent: true, idempotencyKey: key("request") }));
    await run(store, auth, "feedback", "vote-cast", { requestId: request.id, voterKeyHash: "a".repeat(64), decision: "up", idempotencyKey: key("vote-up") });
    await run(store, auth, "feedback", "vote-cast", { requestId: request.id, voterKeyHash: "a".repeat(64), decision: "withdraw", idempotencyKey: key("vote-withdraw") });
    expect(await store.listRecords(auth.userId, { moduleId: "feedback", recordType: "feedback-vote", limit: 10 })).toHaveLength(1);

    const library = first(await run(store, auth, "knowledge", "library-create", { name: "Handbook", defaultAccess: "workspace", locale: "en-US", reviewCadenceDays: 90, idempotencyKey: key("library") }));
    const revision = first(await run(store, auth, "knowledge", "page-revision-draft", { libraryId: library.id, title: "Policy", content: "Reviewed content", sourceIds: [request.id], idempotencyKey: key("revision") }));
    const pagePreview = await run(store, auth, "knowledge", "page-revision-publish", { revisionId: revision.id, contentHash: revision.data.contentHash, dryRun: true, idempotencyKey: key("page-preview") });
    expect(pagePreview.audit.externalEffectExecuted).toBe(false);
    expect((await store.getRecord(auth.userId, revision.id))?.state).toBe("draft");

    const contact = first(await run(store, auth, "crm", "contact-link", { accountId: account.id, name: "Avery", email: "avery@example.com", consentBasis: "Customer", idempotencyKey: key("contact") }));
    const conversation = first(await run(store, auth, "inbox", "thread-open", { contactId: contact.id, channel: "email", subject: "Question", message: "Hello", idempotencyKey: key("thread") }));
    expect(conversation).toMatchObject({ recordType: "conversation", state: "open", data: { version: 1 } });

    const route = first(await run(store, auth, "links", "route-create", { hostname: "go.example.com", slug: "launch", privacyMode: "aggregate", idempotencyKey: key("route") }));
    await expect(run(store, auth, "links", "destination-version-create", { routeId: route.id, destination: "https://127.0.0.1/private", campaign: {}, idempotencyKey: key("unsafe-destination") })).rejects.toThrow(/public HTTPS/);
    const allocationInput = { experimentId: randomUUID(), visitorKeyHash: "b".repeat(64), variants: [{ key: "control", weight: 1 }, { key: "variant", weight: 1 }] };
    const allocationA = await run(store, auth, "links", "experiment-allocate", allocationInput);
    const allocationB = await run(store, auth, "links", "experiment-allocate", allocationInput);
    expect(allocationB.audit).toEqual(allocationA.audit);
    expect(opportunity.data.amountMinor).toBe(100_001);
  });

  it("exports tenant-bound action, record, receipt, and AI state and exposes an atomic storage seam", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const accountInput = { externalKey: "snapshot-account", name: "Snapshot", domain: "snapshot.example", idempotencyKey: key("snapshot-account") };
    const storage = suiteStoreCoreBusinessStorage(store);
    const account = first(await executeCoreBusinessActionWithStorage(storage, auth, "crm", "account-upsert", accountInput, deps));
    await run(store, auth, "crm", "duplicate-review-propose", { recordId: account.id, instruction: "Review only selected account evidence.", evidenceIds: [account.id], idempotencyKey: key("snapshot-ai") });

    const snapshot = await exportCoreBusinessSnapshot(store, auth, fixedNow);
    expect(snapshot).toMatchObject({ version: "core-business-snapshot.v1", workspaceId: auth.workspaceId, exportedAt: fixedNow.toISOString(), actionCatalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/), snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(snapshot.actions).toHaveLength(72);
    expect(snapshot.records.some((record) => record.recordType === "command-receipt" && record.data.actionId === "account-upsert")).toBe(true);
    expect(snapshot.records.some((record) => record.recordType === "ai-request-audit")).toBe(true);
    expect(snapshot.aiActions).toHaveLength(1);
    expect(validateCoreBusinessSnapshot(snapshot, auth.workspaceId)).toEqual(snapshot);

    expect(() => validateCoreBusinessSnapshot({ ...snapshot, workspaceId: randomUUID() }, auth.workspaceId)).toThrow(/different or malformed workspace/);
    const malformed = structuredClone(snapshot);
    const receipt = malformed.records.find((record) => record.recordType === "command-receipt")!;
    receipt.workspaceId = randomUUID();
    expect(() => validateCoreBusinessSnapshot(malformed, auth.workspaceId)).toThrow(/cross-tenant/);

    const replaceSnapshot = vi.fn(async () => undefined);
    const transactional: CoreBusinessStorageAdapter = { transaction: async (context, work) => {
      expect(context.workspaceId).toBe(auth.workspaceId);
      return work({ store, replaceSnapshot });
    } };
    const imported = await importCoreBusinessSnapshotWithStorage(transactional, auth, snapshot);
    expect(imported).toMatchObject({ workspaceId: auth.workspaceId, snapshotHash: snapshot.snapshotHash, recordCount: snapshot.records.length, aiActionCount: 1 });
    expect(replaceSnapshot).toHaveBeenCalledOnce();
  });
});
