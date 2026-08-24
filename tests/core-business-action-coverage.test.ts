import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  coreBusinessActionsByModule,
  type CoreBusinessModuleId,
} from "../src/shared/core-business-actions.js";
import {
  executeCoreBusinessAction,
  type CoreBusinessAuthorization,
  type CoreBusinessEngineDependencies,
  type CoreBusinessExecutionResult,
} from "../src/server/core-business-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const modules: CoreBusinessModuleId[] = ["automate", "publish", "inbox", "crm", "tasks", "feedback", "knowledge", "links"];
const now = new Date("2026-08-24T12:00:00.000Z");

function idempotencyKey(moduleId: CoreBusinessModuleId, actionId: string, suffix = "primary") {
  return `coverage.${moduleId}.${actionId}.${suffix}.0001`;
}

function approval(auth: CoreBusinessAuthorization, label: string) {
  return {
    approved: true as const,
    approvedBy: auth.userId,
    approvedAt: now.toISOString(),
    decisionId: `coverage.${label}.approval.0001`,
    reason: `Reviewed the exact ${label} inputs and bounded effect.`,
  };
}

function dependencies(externalCalls: string[]): CoreBusinessEngineDependencies {
  return {
    now: () => now,
    modelPolicyId: "local-action-coverage-model",
    externalExecutor: async (request) => {
      externalCalls.push(`${request.moduleId}:${request.actionId}`);
      return {
        provider: "local-action-coverage-executor",
        externalId: `${request.moduleId}.${request.actionId}.${externalCalls.length}`,
        status: "accepted",
        occurredAt: now.toISOString(),
      };
    },
  };
}

async function actor(store: MemorySuiteStore): Promise<CoreBusinessAuthorization> {
  const userId = randomUUID();
  const workspace = await store.getOrCreateWorkspace(userId);
  for (const moduleId of modules) await store.enableModule(userId, moduleId);
  const current = await store.getOrCreateWorkspace(userId);
  return { userId, workspaceId: workspace.id, role: current.currentRole!, scopes: ["*"] };
}

function first(result: CoreBusinessExecutionResult) {
  const record = result.records[0];
  if (!record) throw new Error(`Expected ${result.action.moduleId}:${result.action.id} to return a record.`);
  return record;
}

function moduleHarness(
  store: MemorySuiteStore,
  auth: CoreBusinessAuthorization,
  moduleId: CoreBusinessModuleId,
  deps: CoreBusinessEngineDependencies,
) {
  const executed = new Set<string>();
  return {
    async run(actionId: string, input: Record<string, unknown>, suffix = "primary") {
      const action = coreBusinessActionsByModule.get(moduleId)?.find((candidate) => candidate.id === actionId);
      if (!action) throw new Error(`Unknown ${moduleId} coverage action ${actionId}.`);
      const completeInput = action.operation === "read"
        ? input
        : { ...input, idempotencyKey: idempotencyKey(moduleId, actionId, suffix) };
      const result = await executeCoreBusinessAction(store, auth, moduleId, actionId, completeInput, deps);
      expect(result.action).toMatchObject({ moduleId, id: actionId, operation: action.operation });
      expect(Object.keys(result.audit).length).toBeGreaterThan(0);
      if (action.operation === "ai") {
        expect(result).toMatchObject({ kind: "ai-action", aiAction: { status: "queued", moduleId } });
        expect(result.audit).toMatchObject({ modelExecuted: false, reviewStatus: "pending-model", approvalRequired: true });
      } else if (action.operation === "command") {
        expect(result.kind).toBe("command");
        expect(result.records.length).toBeGreaterThan(0);
      } else {
        expect(result.kind).toBe("read");
      }
      executed.add(actionId);
      return result;
    },
    expectComplete() {
      const registered = coreBusinessActionsByModule.get(moduleId)!.map((action) => action.id).sort();
      expect([...executed].sort()).toEqual(registered);
    },
  };
}

describe("core business registered action execution coverage", () => {
  it("enforces registered integer upper bounds before the engine can persist an action", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);

    await expect(executeCoreBusinessAction(store, auth, "knowledge", "library-create", {
      name: "Invalid retention window",
      defaultAccess: "workspace",
      locale: "en-US",
      reviewCadenceDays: 3_651,
      idempotencyKey: "coverage.knowledge.maximum.0001",
    }, dependencies([]))).rejects.toThrow(/exceeds its maximum/);
    expect(await store.listRecords(auth.userId, { moduleId: "knowledge", recordType: "knowledge-library", limit: 10 })).toHaveLength(0);
  });

  it("executes every Automate action through typed workflow, AI, export, publication, and executor boundaries", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const externalCalls: string[] = [];
    const run = moduleHarness(store, auth, "automate", dependencies(externalCalls));

    const workflow = first(await run.run("workflow-version-create", {
      name: "Lead intake",
      triggerSchema: { type: "object", required: ["leadId"] },
      steps: [{ key: "qualify", kind: "transform" }, { key: "notify", kind: "connector", dependsOn: ["qualify"] }],
    }));
    expect((await run.run("trigger-event-validate", { workflowVersionId: workflow.id, event: { leadId: "lead-42" } })).audit).toMatchObject({ valid: true, mutationApplied: false });
    const simulation = first(await run.run("workflow-run-simulate", { workflowVersionId: workflow.id, event: { leadId: "lead-42" } }));
    expect(simulation).toMatchObject({ recordType: "workflow-run", state: "simulated", data: { externalEffects: false } });
    expect((await run.run("webhook-event-ingest", { endpointId: randomUUID(), deliveryId: "delivery-coverage-42", bodyHash: "b".repeat(64), receivedAt: now.toISOString() })).audit).toMatchObject({ duplicateDelivery: false });
    await run.run("failure-diagnose", { runId: simulation.id, instruction: "Explain the first causal failure.", evidenceIds: [simulation.id, workflow.id] });
    await run.run("retry-plan-propose", { runId: simulation.id, instruction: "Propose the smallest safe retry.", evidenceIds: [simulation.id] });
    expect(first(await run.run("run-export", { runId: simulation.id, format: "canonical-json" }))).toMatchObject({ recordType: "export-job", state: "queued", data: { private: true } });
    await run.run("workflow-publish", { workflowVersionId: workflow.id, contentHash: workflow.data.contentHash, dryRun: false, approval: approval(auth, "workflow-publish") });
    const live = await run.run("workflow-run-start", { workflowVersionId: workflow.id, event: { leadId: "lead-42" }, dryRun: false, approval: approval(auth, "workflow-run-start") });
    expect(live.audit).toMatchObject({ externalEffectExecuted: true, providerStatus: "accepted" });
    expect(externalCalls).toEqual(["automate:workflow-run-start"]);
    run.expectComplete();
  });

  it("executes every Publish action through approval, measurement, AI, export, and provider dispatch", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const externalCalls: string[] = [];
    const run = moduleHarness(store, auth, "publish", dependencies(externalCalls));

    expect((await run.run("channel-binding-preview", { provider: "federated-social", accountRef: "brand-main", capabilities: ["image", "text", "text"] })).audit).toMatchObject({ capabilities: ["image", "text"], tokenStored: false, providerCalled: false });
    const campaign = first(await run.run("campaign-draft", { name: "Launch week", goal: "Qualified visits", audience: "Existing opt-in customers", channelIds: [randomUUID()] }));
    await run.run("content-variants-propose", { campaignId: campaign.id, instruction: "Draft supported launch angles.", evidenceIds: [campaign.id] });
    await run.run("campaign-approve", { campaignId: campaign.id, contentHash: campaign.data.contentHash });
    const post = first(await run.run("post-schedule", { campaignId: campaign.id, channelId: randomUUID(), content: "Reviewed launch copy", scheduledAt: "2026-08-25T12:00:00.000Z", campaignHash: campaign.data.contentHash }));
    const observation = first(await run.run("metrics-import", { scheduledPostId: post.id, observedAt: "2026-08-26T12:00:00.000Z", source: "provider-export", metrics: { views: 120, clicks: 9 } }));
    expect(observation).toMatchObject({ recordType: "metric-observation", state: "observed", data: { immutable: true } });
    await run.run("performance-explain", { campaignId: campaign.id, instruction: "Separate observations from hypotheses.", evidenceIds: [campaign.id, observation.id] });
    expect(first(await run.run("campaign-export", { campaignId: campaign.id, format: "csv" }))).toMatchObject({ recordType: "export-job", data: { private: true } });
    const dispatch = await run.run("publication-dispatch", { scheduledPostId: post.id, dryRun: false, approval: approval(auth, "publication-dispatch") });
    expect(dispatch.audit).toMatchObject({ externalEffectExecuted: true, providerStatus: "accepted" });
    expect(externalCalls).toEqual(["publish:publication-dispatch"]);
    run.expectComplete();
  });

  it("executes every Inbox action through message provenance, ownership, AI, export, resolution, and approved send", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const deps = dependencies([]);
    const account = first(await executeCoreBusinessAction(store, auth, "crm", "account-upsert", { externalKey: "inbox-contact-account", name: "Inbox Account", domain: "inbox.example", idempotencyKey: "coverage.inbox.seed-account.0001" }, deps));
    const contact = first(await executeCoreBusinessAction(store, auth, "crm", "contact-link", { accountId: account.id, name: "Avery", email: "avery@example.com", consentBasis: "Existing customer", idempotencyKey: "coverage.inbox.seed-contact.0001" }, deps));
    const externalCalls: string[] = [];
    const run = moduleHarness(store, auth, "inbox", dependencies(externalCalls));

    const opened = await run.run("thread-open", { contactId: contact.id, channel: "email", subject: "Invoice question", message: "Please clarify the total." });
    const conversation = opened.records.find((record) => record.recordType === "conversation")!;
    const openingMessage = opened.records.find((record) => record.recordType === "message")!;
    const inbound = first(await run.run("message-ingest", { conversationId: conversation.id, deliveryId: "mail-coverage-42", senderRef: "customer-42", body: "Following up", receivedAt: now.toISOString() }));
    expect(inbound.data).toMatchObject({ senderRefHash: expect.stringMatching(/^[a-f0-9]{64}$/), sequence: 2, immutable: true });
    await run.run("thread-assign", { conversationId: conversation.id, assigneeId: auth.userId, expectedVersion: 1 });
    await run.run("sla-policy-set", { name: "Standard", targets: { normalMinutes: 480, urgentMinutes: 60 }, timeZone: "America/New_York" });
    await run.run("reply-propose", { conversationId: conversation.id, instruction: "Draft a concise policy-grounded response.", evidenceIds: [openingMessage.id, inbound.id] });
    await run.run("thread-summarize", { conversationId: conversation.id, instruction: "Summarize supported facts only.", evidenceIds: [conversation.id, openingMessage.id, inbound.id] });
    const reply = await run.run("reply-send", { conversationId: conversation.id, body: "Here is the confirmed answer.", proposalId: null, dryRun: false, approval: approval(auth, "reply-send") });
    expect(reply.audit).toMatchObject({ externalEffectExecuted: true, providerStatus: "accepted" });
    expect(first(await run.run("conversation-export", { conversationId: conversation.id, redactionPolicy: "mask-contact" }))).toMatchObject({ recordType: "export-job", data: { private: true, redactionPolicy: "mask-contact" } });
    expect(first(await run.run("thread-resolve", { conversationId: conversation.id, expectedVersion: 2, resolution: "Customer confirmed the answer." }))).toMatchObject({ state: "resolved", data: { version: 3 } });
    expect(externalCalls).toEqual(["inbox:reply-send"]);
    run.expectComplete();
  });

  it("executes every CRM action through graph creation, versioned pipeline movement, AI, forecast, and export", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const run = moduleHarness(store, auth, "crm", dependencies([]));

    const account = first(await run.run("account-upsert", { externalKey: "acct-coverage", name: "Northwind", domain: "northwind.example" }));
    const contact = first(await run.run("contact-link", { accountId: account.id, name: "Avery", email: "avery@example.com", consentBasis: "Existing customer" }));
    const opportunity = first(await run.run("opportunity-open", { accountId: account.id, name: "Expansion", amountMinor: 250_001, currency: "USD", expectedCloseAt: "2026-10-01T00:00:00.000Z" }));
    expect(first(await run.run("opportunity-transition", { opportunityId: opportunity.id, toStage: "evaluation", expectedVersion: 1, reason: "Discovery completed" }))).toMatchObject({ state: "evaluation", data: { stage: "evaluation", version: 2 } });
    const activity = first(await run.run("activity-record", { accountId: account.id, kind: "meeting", occurredAt: now.toISOString(), summary: "Reviewed deployment needs." }));
    await run.run("duplicate-review-propose", { recordId: contact.id, instruction: "Explain likely duplicate signals.", evidenceIds: [account.id, contact.id] });
    await run.run("next-action-propose", { accountId: account.id, instruction: "Suggest the smallest supported next step.", evidenceIds: [account.id, activity.id] });
    expect((await run.run("pipeline-forecast", { currency: "USD", stageProbabilities: { evaluation: 0.4 } })).audit).toMatchObject({ opportunityCount: 1, totalMinor: 250_001, weightedMinor: 100_000, deterministic: true });
    expect(first(await run.run("crm-export", { accountIds: [account.id], format: "csv-bundle" }))).toMatchObject({ recordType: "export-job", data: { accountIds: [account.id], private: true } });
    run.expectComplete();
  });

  it("executes every Tasks action through acyclic planning, transitions, sprint scope, AI, time, and export", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const run = moduleHarness(store, auth, "tasks", dependencies([]));

    const project = first(await run.run("project-blueprint-create", { name: "Launch", states: ["backlog", "doing", "done"], workInProgressLimits: { doing: 2 } }));
    const predecessor = first(await run.run("work-item-create", { projectId: project.id, title: "Foundation", acceptanceCriteria: ["Verified"], priority: "high" }, "predecessor"));
    const successor = first(await run.run("work-item-create", { projectId: project.id, title: "Release", acceptanceCriteria: ["Verified"], priority: "normal" }, "successor"));
    expect(first(await run.run("dependency-link", { projectId: project.id, predecessorId: predecessor.id, successorId: successor.id }))).toMatchObject({ recordType: "work-item-dependency", state: "active" });
    expect(first(await run.run("work-item-transition", { workItemId: predecessor.id, toState: "doing", expectedVersion: 1 }))).toMatchObject({ state: "doing", data: { version: 2 } });
    expect(first(await run.run("sprint-commit", { projectId: project.id, name: "Sprint 12", startsAt: "2026-08-25T00:00:00.000Z", endsAt: "2026-09-08T00:00:00.000Z", workItemIds: [predecessor.id, successor.id] }))).toMatchObject({ recordType: "sprint", state: "committed" });
    await run.run("workload-rebalance-propose", { projectId: project.id, instruction: "Reduce overload without changing assignments.", evidenceIds: [project.id, predecessor.id, successor.id] });
    await run.run("delivery-risk-explain", { projectId: project.id, instruction: "Explain observed delivery risk.", evidenceIds: [project.id, predecessor.id, successor.id] });
    expect(first(await run.run("time-log", { workItemId: predecessor.id, startedAt: "2026-08-24T10:00:00.000Z", endedAt: "2026-08-24T11:00:00.000Z", note: "Verification" }))).toMatchObject({ recordType: "time-entry", data: { minutes: 60 } });
    expect(first(await run.run("project-export", { projectId: project.id, format: "canonical-json" }))).toMatchObject({ recordType: "export-job", data: { private: true } });
    run.expectComplete();
  });

  it("executes every Feedback action through consent, voting, AI, reviewed merge, roadmap, scoring, export, and changelog dispatch", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const externalCalls: string[] = [];
    const run = moduleHarness(store, auth, "feedback", dependencies(externalCalls));

    const board = first(await run.run("board-create", { name: "Ideas", visibility: "public", votingPolicy: "verified-submitters" }));
    const target = first(await run.run("request-submit", { boardId: board.id, title: "Bulk export", problem: "One-by-one export is slow.", consent: true }, "target"));
    const source = first(await run.run("request-submit", { boardId: board.id, title: "Batch export", problem: "Projects need one export operation.", consent: true }, "source"));
    await run.run("vote-cast", { requestId: target.id, voterKeyHash: "d".repeat(64), decision: "up" });
    await run.run("duplicate-cluster-propose", { boardId: board.id, instruction: "Cite requests that describe the same problem.", evidenceIds: [target.id, source.id] });
    expect((await run.run("impact-score", { requestId: target.id, weights: { votes: 2, accounts: 5, urgency: 3, effort: -2 } })).audit).toMatchObject({ score: 2, deterministic: true });
    await run.run("request-merge", { sourceRequestIds: [source.id], targetRequestId: target.id, reason: "Reviewed as the same user problem.", dryRun: false, approval: approval(auth, "request-merge") });
    await run.run("status-transition", { requestId: target.id, toStatus: "planned", expectedVersion: 1, explanation: "Accepted for planning." }, "planned");
    await run.run("status-transition", { requestId: target.id, toStatus: "in-progress", expectedVersion: 2, explanation: "Implementation started." }, "in-progress");
    await run.run("status-transition", { requestId: target.id, toStatus: "shipped", expectedVersion: 3, explanation: "Verified and released." }, "shipped");
    expect(first(await run.run("feedback-export", { boardId: board.id, format: "canonical-json" }))).toMatchObject({ recordType: "export-job", data: { private: true } });
    const changelog = await run.run("changelog-publish", { requestIds: [target.id], title: "Bulk export shipped", body: "Projects can now be exported together.", dryRun: false, approval: approval(auth, "changelog-publish") });
    expect(changelog.audit).toMatchObject({ externalEffectExecuted: true, providerStatus: "accepted" });
    expect(externalCalls).toEqual(["feedback:changelog-publish"]);
    run.expectComplete();
  });

  it("executes every Knowledge action through governed revisions, sources, publication, AI, access, export, and import preview", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const externalCalls: string[] = [];
    const run = moduleHarness(store, auth, "knowledge", dependencies(externalCalls));

    const library = first(await run.run("library-create", { name: "Support handbook", defaultAccess: "workspace", locale: "en-US", reviewCadenceDays: 90 }));
    const revision = first(await run.run("page-revision-draft", { libraryId: library.id, title: "Refund policy", content: "The reviewed refund window is 30 days.", sourceIds: [] }));
    const source = first(await run.run("source-link", { revisionId: revision.id, locator: "internal-policy-42", observedAt: now.toISOString(), contentHash: "f".repeat(64), trustNote: "Approved policy record" }));
    const published = await run.run("page-revision-publish", { revisionId: revision.id, contentHash: revision.data.contentHash, dryRun: false, approval: approval(auth, "page-revision-publish") });
    expect(published.audit).toMatchObject({ externalEffectExecuted: true, providerStatus: "accepted" });
    await run.run("answer-propose", { question: "What is the refund window?", evidenceIds: [revision.id, source.id] });
    await run.run("staleness-audit-propose", { libraryId: library.id, instruction: "Compare claims with source clocks.", evidenceIds: [revision.id, source.id] });
    expect(first(await run.run("permission-grant", { libraryId: library.id, principalId: randomUUID(), permission: "view", expiresAt: "2027-08-24T12:00:00.000Z" }))).toMatchObject({ recordType: "knowledge-grant", state: "active" });
    expect(first(await run.run("page-export", { revisionId: revision.id, format: "markdown" }))).toMatchObject({ recordType: "export-job", data: { sourceRecordId: revision.id, private: true } });
    expect((await run.run("import-preview", { libraryId: library.id, manifest: { pages: [{ title: "Draft import" }] } })).audit).toMatchObject({ pageCount: 1, recordsCreated: 0, externalEffects: false });
    expect(externalCalls).toEqual(["knowledge:page-revision-publish"]);
    run.expectComplete();
  });

  it("executes every Links action through safe versioning, publication, resolution, privacy, allocation, AI, export, and disable", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const externalCalls: string[] = [];
    const run = moduleHarness(store, auth, "links", dependencies(externalCalls));

    const route = first(await run.run("route-create", { hostname: "go.example.com", slug: "launch", privacyMode: "aggregate" }));
    const destination = first(await run.run("destination-version-create", { routeId: route.id, destination: "https://example.com/launch", campaign: { source: "qr" } }));
    await run.run("destination-risk-propose", { destinationVersionId: destination.id, instruction: "Review destination risk and cite observations.", evidenceIds: [route.id, destination.id] });
    const published = await run.run("destination-publish", { routeId: route.id, destinationVersionId: destination.id, contentHash: destination.data.contentHash, dryRun: false, approval: approval(auth, "destination-publish") });
    expect(published.audit).toMatchObject({ externalEffectExecuted: true, providerStatus: "accepted" });
    expect((await run.run("redirect-resolve", { routeId: route.id })).audit).toMatchObject({ destination: "https://example.com/launch", eventRecorded: false });
    const event = first(await run.run("event-ingest", { routeId: route.id, eventId: "event-coverage-42", occurredAt: now.toISOString(), kind: "redirect", dimensions: { country: "US" } }));
    expect(event.data).toMatchObject({ rawIdentityStored: false, privacyMode: "aggregate" });
    const allocationInput = { experimentId: randomUUID(), visitorKeyHash: "b".repeat(64), variants: [{ key: "a", weight: 1 }, { key: "b", weight: 2 }] };
    const allocation = await run.run("experiment-allocate", allocationInput);
    expect((await run.run("experiment-allocate", allocationInput)).audit).toEqual(allocation.audit);
    expect(first(await run.run("analytics-export", { routeIds: [route.id], from: "2026-08-01T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z", format: "csv" }))).toMatchObject({ recordType: "export-job", data: { aggregateOnly: true, rawVisitorIdentifiers: false } });
    expect(first(await run.run("route-disable", { routeId: route.id, reason: "Destination ownership changed.", dryRun: false, approval: approval(auth, "route-disable") }))).toMatchObject({ state: "disabled", data: { activeDestinationVersionId: null } });
    expect(externalCalls).toEqual(["links:destination-publish"]);
    run.expectComplete();
  });
});
