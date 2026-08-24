import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executePremiumBusinessAction, premiumBusinessAiEvidenceRecords, premiumBusinessBoundedScanLimit, recordPremiumBusinessAiCompletion, validatePremiumBusinessAiCompletion, type PremiumBusinessAuthorization } from "../src/server/premium-business-store-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import type { PremiumActionIdFor, PremiumModuleId } from "../src/shared/premium-business-actions";

const clock = "2026-08-24T18:00:00.000Z";
const modelPolicyId = "local/grounded";
const deps = { now: () => new Date(clock), modelPolicyId };

async function fixture(plan: "scale" | "fleet" = "fleet", modules: PremiumModuleId[] = ["projects", "drive", "channels", "operations", "assistant"]) {
  const store = new MemorySuiteStore(plan); const userId = randomUUID(); const workspace = await store.getOrCreateWorkspace(userId);
  for (const moduleId of modules) await store.enableModule(userId, moduleId);
  const auth: PremiumBusinessAuthorization = { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
  const run = <M extends PremiumModuleId>(moduleId: M, actionId: PremiumActionIdFor<M>, input: Record<string, unknown>) => store.runInWorkspaceTransaction(userId, () => executePremiumBusinessAction(store, auth, moduleId, actionId, input, deps));
  return { store, userId, auth, run };
}

function approve(userId: string) { return { approved: true, approvedBy: userId, approvedAt: clock, decisionId: `premium-approval-${randomUUID()}`, reason: "Reviewed exact content and evidence" }; }
function first<T extends { records: Array<unknown> }>(result: T) { const record = result.records[0]; if (!record) throw new Error("Expected a record."); return record as Awaited<ReturnType<MemorySuiteStore["getRecord"]>> & {}; }

describe("premium SuiteStore production adapter", () => {
  it("persists one atomic receipt and one result across concurrent identical retries", async () => {
    const { store, userId, auth } = await fixture("scale", ["projects"]); const input = { key: "atomic", name: "Atomic", outcome: "One durable project", idempotencyKey: "premium-atomic-project-0001" };
    const [created, replayed] = await Promise.all([
      store.runInWorkspaceTransaction(userId, () => executePremiumBusinessAction(store, auth, "projects", "project-create", input, deps)),
      store.runInWorkspaceTransaction(userId, () => executePremiumBusinessAction(store, auth, "projects", "project-create", input, deps)),
    ]);
    expect(created.kind).toBe("command"); expect(replayed.audit.replayed).toBe(true); expect(first(created).id).toBe(first(replayed).id);
    expect(await store.listRecords(userId, { moduleId: "projects", recordType: "project", limit: 20 })).toHaveLength(1);
    expect(await store.listRecords(userId, { moduleId: "projects", recordType: "premium-command-receipt", limit: 20 })).toHaveLength(1);
    await expect(store.runInWorkspaceTransaction(userId, () => executePremiumBusinessAction(store, auth, "projects", "project-create", { ...input, name: "Changed" }, deps))).rejects.toThrow(/different input/);
  });

  it("enforces authoritative plan, role, scope, and workspace boundaries before persistence", async () => {
    const scale = await fixture("scale", ["projects"]); await expect(scale.store.runInWorkspaceTransaction(scale.userId, () => executePremiumBusinessAction(scale.store, scale.auth, "operations", "party-create", { name: "Denied", kind: "customer", currency: "USD", idempotencyKey: "premium-denied-party-001" }, deps))).rejects.toThrow(/\$200\/month fleet plan/);
    const other = await fixture("scale", ["projects"]); const project = first(await scale.run("projects", "project-create", { key: "private", name: "Private", outcome: "Tenant only", idempotencyKey: "premium-private-project1" }));
    await expect(other.run("projects", "issue-create", { projectId: project.id, title: "Cross tenant", priority: "high", points: 2, idempotencyKey: "premium-cross-tenant-01" })).rejects.toThrow(/not found in this workspace/);
    const scopedAuth = { ...scale.auth, scopes: ["projects:read"] }; await expect(scale.store.runInWorkspaceTransaction(scale.userId, () => executePremiumBusinessAction(scale.store, scopedAuth, "projects", "issue-create", { projectId: project.id, title: "No scope", priority: "low", points: 1, idempotencyKey: "premium-no-scope-issue1" }, deps))).rejects.toThrow(/projects:write scope/);
    expect(await other.store.getRecord(other.userId, project.id)).toBeUndefined();
  });

  it("does not let Assistant attach a private People record that the member cannot read", async () => {
    const { store, userId, auth, run } = await fixture("fleet", ["assistant"]);
    await store.enableModule(userId, "people");
    const subjectId = randomUUID();
    const memberId = randomUUID();
    await store.addWorkspaceMember(userId, subjectId, "member");
    await store.addWorkspaceMember(userId, memberId, "member");
    const privateLeave = await store.createRecord(userId, {
      moduleId: "people",
      recordType: "leave-request",
      title: "Private leave request",
      state: "pending-human-decision",
      data: { subjectUserId: subjectId, managerRef: userId },
    });
    if (!privateLeave) throw new Error("Expected a private People record.");
    const workspace = await store.getOrCreateWorkspace(memberId);
    const memberAuth: PremiumBusinessAuthorization = { userId: memberId, workspaceId: workspace.id, role: "member", scopes: ["*"] };
    const memberCollection = first(await executePremiumBusinessAction(store, memberAuth, "assistant", "collection-create", { name: "Member private boundary", purpose: "Prove Assistant evidence authorization", idempotencyKey: "premium-private-boundary-01" }, deps));
    await expect(executePremiumBusinessAction(store, memberAuth, "assistant", "source-attach", {
      collectionId: memberCollection.id,
      recordId: privateLeave.id,
      citationLabel: "Inaccessible private leave",
      contentHash: "a".repeat(64),
      idempotencyKey: "premium-private-boundary-02",
    }, deps)).rejects.toThrow(/record not found in this workspace/);
    const ownerCollection = first(await run("assistant", "collection-create", { name: "Owner private boundary", purpose: "Store owner-reviewed private evidence", idempotencyKey: "premium-private-boundary-owner" }));
    const ownerAttached = await executePremiumBusinessAction(store, auth, "assistant", "source-attach", {
      collectionId: ownerCollection.id,
      recordId: privateLeave.id,
      citationLabel: "Owner-reviewed private leave",
      contentHash: "a".repeat(64),
      idempotencyKey: "premium-private-boundary-03",
    }, deps);
    expect(first(ownerAttached).data.recordId).toBe(privateLeave.id);
    expect((await store.listRecords(memberId, { moduleId: "assistant", limit: 100 })).map((record) => record.id)).toContain(memberCollection.id);
    expect((await store.listRecords(memberId, { moduleId: "assistant", limit: 100 })).map((record) => record.id)).not.toEqual(expect.arrayContaining([ownerCollection.id, first(ownerAttached).id]));
  });

  it("reapplies member visibility to Assistant attachment binding, reuse, and receipt replay inside trusted transactions", async () => {
    const { store, userId, run } = await fixture("fleet", ["projects", "assistant"]);
    const source = first(await run("projects", "project-create", { key: "member-visible-source", name: "Member-visible source", outcome: "Prove attachment privacy", idempotencyKey: "premium-member-visible-source" }));
    const memberId = randomUUID();
    await store.addWorkspaceMember(userId, memberId, "member");
    const workspace = await store.getOrCreateWorkspace(memberId);
    const memberAuth: PremiumBusinessAuthorization = { userId: memberId, workspaceId: workspace.id, role: "member", scopes: ["*"] };
    const memberRun = <M extends PremiumModuleId>(moduleId: M, actionId: PremiumActionIdFor<M>, input: Record<string, unknown>) => executePremiumBusinessAction(store, memberAuth, moduleId, actionId, input, deps);
    const collection = first(await memberRun("assistant", "collection-create", { name: "Member evidence", purpose: "Keep attachment metadata private", idempotencyKey: "premium-member-collection" }));
    const prompt = first(await memberRun("assistant", "prompt-version-create", { name: "Member prompt", systemInstruction: "Use only member-visible attached evidence.", inputContract: { goal: "string" }, outputContract: { summary: "string", claims: "cited[]" }, idempotencyKey: "premium-member-prompt" }));
    const attachInput = { collectionId: collection.id, recordId: source.id, citationLabel: "Member citation", contentHash: "e".repeat(64), idempotencyKey: "premium-member-attachment-01" };
    const foreignAttachment = first(await memberRun("assistant", "source-attach", attachInput));
    const reassigned = await store.updateRecord(userId, foreignAttachment.id, { data: { createdByUserId: userId } });
    expect(reassigned?.data.createdByUserId).toBe(userId);

    await expect(memberRun("assistant", "run-preview", { promptVersionId: prompt.id, collectionId: collection.id, evidenceIds: [source.id], modelId: modelPolicyId, goal: "Use only my attachment" }))
      .rejects.toThrow(/checksum-attached/);

    const ownAttachInput = { ...attachInput, idempotencyKey: "premium-member-attachment-02" };
    const ownAttachment = first(await memberRun("assistant", "source-attach", ownAttachInput));
    expect(ownAttachment.id).not.toBe(foreignAttachment.id);
    expect(ownAttachment.data.createdByUserId).toBe(memberId);
    await store.updateRecord(userId, ownAttachment.id, { data: { createdByUserId: userId } });
    const replay = await memberRun("assistant", "source-attach", ownAttachInput);
    expect(replay.audit.replayed).toBe(true);
    expect(replay.records).toEqual([]);
  });

  it("fails closed at limit plus one for every premium uniqueness and Assistant attachment scan", async () => {
    const { store, run } = await fixture("fleet", ["projects", "channels", "operations", "assistant"]);
    const source = first(await run("projects", "project-create", { key: "saturation-source", name: "Saturation source", outcome: "Exercise bounded scans", idempotencyKey: "premium-saturation-source" }));
    const collection = first(await run("assistant", "collection-create", { name: "Saturation evidence", purpose: "Exercise bounded attachment scans", idempotencyKey: "premium-saturation-collection" }));
    const prompt = first(await run("assistant", "prompt-version-create", { name: "Saturation prompt", systemInstruction: "Use exact attached evidence.", inputContract: { goal: "string" }, outputContract: { summary: "string", claims: "cited[]" }, idempotencyKey: "premium-saturation-prompt" }));
    const attachment = first(await run("assistant", "source-attach", { collectionId: collection.id, recordId: source.id, citationLabel: "Saturation source", contentHash: "f".repeat(64), idempotencyKey: "premium-saturation-attachment" }));
    const originalListRecords = store.listRecords.bind(store);
    let saturated: { moduleId: string; recordType: string } | undefined;
    const listRecords = vi.spyOn(store, "listRecords").mockImplementation(async (userId, input) => {
      if (saturated && input.moduleId === saturated.moduleId && input.recordType === saturated.recordType && input.limit === premiumBusinessBoundedScanLimit + 1) {
        return Array(premiumBusinessBoundedScanLimit + 1).fill(attachment);
      }
      return originalListRecords(userId, input);
    });

    expect(premiumBusinessBoundedScanLimit).toBe(100_000);
    saturated = { moduleId: "projects", recordType: "project" };
    await expect(run("projects", "project-create", { key: "saturated-project", name: "Saturated project", outcome: "Must fail closed", idempotencyKey: "premium-saturated-project" })).rejects.toThrow(/bounded projects\/project scan is saturated/);
    saturated = { moduleId: "channels", recordType: "stream" };
    await expect(run("channels", "stream-create", { key: "saturated-stream", name: "Saturated stream", purpose: "Must fail closed", idempotencyKey: "premium-saturated-stream" })).rejects.toThrow(/bounded channels\/stream scan is saturated/);
    saturated = { moduleId: "operations", recordType: "item" };
    await expect(run("operations", "item-create", { sku: "SATURATED", name: "Saturated item", currency: "USD", unitPriceMinor: 100, idempotencyKey: "premium-saturated-item" })).rejects.toThrow(/bounded operations\/item scan is saturated/);
    saturated = { moduleId: "assistant", recordType: "source-attachment" };
    await expect(run("assistant", "source-attach", { collectionId: collection.id, recordId: source.id, citationLabel: "Saturated attachment", contentHash: "a".repeat(64), idempotencyKey: "premium-saturated-attachment-2" })).rejects.toThrow(/bounded assistant\/source-attachment scan is saturated/);
    await expect(run("assistant", "run-preview", { promptVersionId: prompt.id, collectionId: collection.id, evidenceIds: [source.id], modelId: modelPolicyId, goal: "Must fail closed before binding" })).rejects.toThrow(/bounded assistant\/source-attachment scan is saturated/);

    const boundedCalls = listRecords.mock.calls.map(([, input]) => input).filter((input) => input.limit === premiumBusinessBoundedScanLimit + 1);
    expect(boundedCalls).toEqual(expect.arrayContaining([
      { moduleId: "projects", recordType: "project", limit: premiumBusinessBoundedScanLimit + 1 },
      { moduleId: "channels", recordType: "stream", limit: premiumBusinessBoundedScanLimit + 1 },
      { moduleId: "operations", recordType: "item", limit: premiumBusinessBoundedScanLimit + 1 },
      { moduleId: "assistant", recordType: "source-attachment", limit: premiumBusinessBoundedScanLimit + 1 },
    ]));
    expect(boundedCalls.filter((input) => input.moduleId === "assistant" && input.recordType === "source-attachment")).toHaveLength(2);
    listRecords.mockRestore();
  });

  it("binds premium idempotency receipts to the authenticated actor before replay", async () => {
    const { store, userId, auth, run } = await fixture("fleet", ["assistant"]);
    const input = {
      name: "Private retry boundary",
      purpose: "Never replay another member's Assistant result",
      idempotencyKey: "premium-private-replay-actor",
    };
    const ownerCollection = first(await run("assistant", "collection-create", input));
    const memberId = randomUUID();
    await store.addWorkspaceMember(userId, memberId, "member");
    const workspace = await store.getOrCreateWorkspace(memberId);
    const memberAuth: PremiumBusinessAuthorization = { userId: memberId, workspaceId: workspace.id, role: "member", scopes: ["*"] };

    await expect(executePremiumBusinessAction(store, memberAuth, "assistant", "collection-create", input, deps))
      .rejects.toThrow(/another authenticated actor/);
    expect(await store.getRecord(memberId, ownerCollection.id)).toBeUndefined();
    const receipt = (await store.listRecords(userId, { moduleId: "assistant", recordType: "premium-command-receipt", limit: 20 }))[0];
    expect(receipt?.data.actorUserId).toBe(auth.userId);
  });

  it("consumes every premium approval decision exactly once across actions", async () => {
    const { userId, run } = await fixture("scale", ["projects"]);
    const project = first(await run("projects", "project-create", { key: "approval-once", name: "Approval once", outcome: "Bind one review to one command", idempotencyKey: "premium-approval-project" }));
    const issue = first(await run("projects", "issue-create", { projectId: project.id, title: "Reviewed issue", priority: "normal", points: 1, idempotencyKey: "premium-approval-issue01" }));
    const cycle = first(await run("projects", "cycle-draft", { projectId: project.id, title: "Reviewed cycle", capacityPoints: 1, issueIds: [issue.id], idempotencyKey: "premium-approval-cycle01" }));
    const oneDecision = approve(userId);
    await run("projects", "cycle-commit", { cycleId: cycle.id, contentHash: cycle.data.contentHash, approval: oneDecision, dryRun: false, idempotencyKey: "premium-approval-commit1" });

    await expect(run("projects", "plan-propose", {
      projectId: project.id,
      objective: "Attempt to reuse an approval decision",
      evidenceIds: [project.id],
      promptVersion: "approval-once-v1",
      modelId: "local/grounded",
      approval: oneDecision,
      dryRun: false,
      idempotencyKey: "premium-approval-reuse01",
    })).rejects.toThrow(/decision ID is already bound/);
  });

  it("treats caller modelId only as an assertion of the trusted host policy before receipt lookup or queueing", async () => {
    const { store, userId, run } = await fixture("scale", ["projects"]);
    const project = first(await run("projects", "project-create", { key: "trusted-model-policy", name: "Trusted model policy", outcome: "Prevent caller-selected model routing", idempotencyKey: "premium-trusted-model-project" }));
    const receiptCount = (await store.listRecords(userId, { moduleId: "projects", recordType: "premium-command-receipt", limit: 20 })).length;
    const receiptLookup = vi.spyOn(store, "findCommandReceipt");
    const queue = vi.spyOn(store, "queueAiAction");

    await expect(run("projects", "plan-propose", {
      projectId: project.id,
      objective: "Attempt caller-selected routing",
      evidenceIds: [project.id],
      promptVersion: "trusted-policy-v1",
      modelId: "caller/untrusted-model",
      approval: approve(userId),
      dryRun: false,
      idempotencyKey: "premium-wrong-model-policy",
    })).rejects.toThrow(/host-configured model policy/);
    expect(receiptLookup).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(await store.listRecords(userId, { moduleId: "projects", recordType: "premium-command-receipt", limit: 20 })).toHaveLength(receiptCount);

    const approval = approve(userId);
    const omittedInput = {
      projectId: project.id,
      objective: "Use the trusted host model",
      evidenceIds: [project.id],
      promptVersion: "trusted-policy-v1",
      approval,
      dryRun: false,
      idempotencyKey: "premium-omitted-model-policy",
    };
    const queued = await run("projects", "plan-propose", omittedInput);
    expect(queued.records[0]?.data.requestedModelId).toBe(modelPolicyId);
    expect(queued.aiAction?.context.requestedModelId).toBe(modelPolicyId);
    expect(queue).toHaveBeenCalledTimes(1);
    const assertedReplay = await run("projects", "plan-propose", { ...omittedInput, modelId: modelPolicyId });
    expect(assertedReplay.audit.replayed).toBe(true);
    expect(assertedReplay.aiAction?.id).toBe(queued.aiAction?.id);
    expect(await store.listRecords(userId, { moduleId: "projects", recordType: "premium-command-receipt", limit: 20 })).toHaveLength(receiptCount + 1);
    expect(queue).toHaveBeenCalledTimes(1);
    receiptLookup.mockRestore();
    queue.mockRestore();
  });

  it("persists all five premium domains in one shared workspace graph visible to members but not outsiders", async () => {
    const { store, userId, auth } = await fixture("fleet"); const memberId = randomUUID(); await store.addWorkspaceMember(userId, memberId, "member"); const memberWorkspace = await store.getOrCreateWorkspace(memberId); expect(memberWorkspace.id).toBe(auth.workspaceId);
    const memberAuth: PremiumBusinessAuthorization = { userId: memberId, workspaceId: memberWorkspace.id, role: "member", scopes: ["*"] };
    const probes = [
      ["projects", "project-create", { key: "shared-project", name: "Shared project", outcome: "Visible across members", idempotencyKey: "premium-shared-project" }],
      ["drive", "vault-create", { name: "Shared vault", classification: "internal", idempotencyKey: "premium-shared-vault01" }],
      ["channels", "stream-create", { key: "shared-stream", name: "Shared stream", purpose: "Visible across members", idempotencyKey: "premium-shared-stream01" }],
      ["operations", "party-create", { name: "Shared customer", kind: "customer", currency: "USD", idempotencyKey: "premium-shared-party01" }],
      ["assistant", "collection-create", { name: "Shared evidence", purpose: "Visible across members", idempotencyKey: "premium-shared-assistant" }],
    ] as const;
    for (const [moduleId, actionId, input] of probes) {
      const result = await executePremiumBusinessAction(store, memberAuth, moduleId, actionId as never, input, deps); expect(first(result).workspaceId).toBe(auth.workspaceId);
      expect((await store.listRecords(userId, { moduleId, limit: 20 })).map((record) => record.id)).toContain(first(result).id);
    }
    const outsiderId = randomUUID(); await store.getOrCreateWorkspace(outsiderId); expect(await store.listRecords(outsiderId, { limit: 100 })).toEqual([]);
  });

  it("executes all eight planning actions with durable versions, capacity, approval, and AI audit", async () => {
    const { store, userId, auth, run } = await fixture("scale", ["projects"]); const project = first(await run("projects", "project-create", { key: "northstar", name: "Northstar", outcome: "Deliver safely", idempotencyKey: "premium-project-create01" }));
    const foundation = first(await run("projects", "issue-create", { projectId: project.id, title: "Foundation", priority: "high", points: 3, idempotencyKey: "premium-issue-foundation" })); const release = first(await run("projects", "issue-create", { projectId: project.id, title: "Release", priority: "normal", points: 5, idempotencyKey: "premium-issue-release001" }));
    const linked = first(await run("projects", "dependency-link", { issueId: release.id, dependsOnIssueId: foundation.id, expectedVersion: 1, idempotencyKey: "premium-dependency-link1" })); expect(linked.data.version).toBe(2);
    const ready = first(await run("projects", "issue-transition", { issueId: foundation.id, toState: "ready", expectedVersion: 1, reason: "Evidence complete", idempotencyKey: "premium-issue-transition" })); expect(ready.state).toBe("ready");
    const cycleResult = await run("projects", "cycle-draft", { projectId: project.id, title: "Cycle one", capacityPoints: 8, issueIds: [foundation.id, release.id], idempotencyKey: "premium-cycle-draft-001" }); const cycle = first(cycleResult);
    const committed = first(await run("projects", "cycle-commit", { cycleId: cycle.id, contentHash: cycle.data.contentHash, approval: approve(userId), dryRun: false, idempotencyKey: "premium-cycle-commit-01" })); expect(committed.state).toBe("active");
    const plan = await run("projects", "plan-propose", { projectId: project.id, objective: "Propose the next bounded cycle", evidenceIds: [project.id, foundation.id], promptVersion: "northstar-plan-v1", modelId: "local/grounded", approval: approve(userId), dryRun: false, idempotencyKey: "premium-plan-propose-01" }); expect(plan).toMatchObject({ kind: "ai-action", records: [{ recordType: "premium-ai-request-audit", data: { output: null, confidence: null, fabricatedOutputAllowed: false } }] });
    const health = await run("projects", "health-explain", { projectId: project.id, question: "What is blocked?", evidenceIds: [project.id, linked.id], promptVersion: "northstar-health-v1", modelId: "local/grounded", dryRun: true, idempotencyKey: "premium-health-dry-run1" }); expect(health).toMatchObject({ kind: "command", records: [], preview: { modelInvoked: false, output: null } });
    expect(await store.listRecords(userId, { moduleId: "projects", recordType: "premium-command-receipt", limit: 100 })).toHaveLength(9);
  });

  it("executes all eight private-file actions and leaves private share material out of durable receipts", async () => {
    const { store, userId, run } = await fixture("scale", ["drive"]); const nextApproval = () => approve(userId); const vault = first(await run("drive", "vault-create", { name: "Contracts", classification: "restricted", idempotencyKey: "premium-vault-create-001" }));
    const registered = await run("drive", "file-register", { vaultId: vault.id, name: "agreement.pdf", objectKey: "tenant/contracts/agreement-v1", contentType: "application/pdf", sizeBytes: 2048, checksum: "a".repeat(64), approval: nextApproval(), dryRun: false, idempotencyKey: "premium-file-register-01" }); const file = registered.records.find((record) => record.recordType === "file")!;
    const versioned = await run("drive", "file-version-add", { fileId: file.id, objectKey: "tenant/contracts/agreement-v2", sizeBytes: 4096, checksum: "b".repeat(64), expectedVersion: 1, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-file-version-001" }); const current = versioned.records.find((record) => record.recordType === "file")!;
    const sharePlan = await run("drive", "share-preview", { fileId: file.id, expiresAt: "2026-08-25T18:00:00.000Z", permission: "view" }); const share = await run("drive", "share-create", { fileId: file.id, expiresAt: "2026-08-25T18:00:00.000Z", permission: "view", previewHash: sharePlan.preview!.previewHash, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-share-create-001" }); expect(share.privateOutput?.shareToken).toMatch(/^[0-9a-f-]{36}$/);
    const analysis = await run("drive", "document-understand", { fileId: file.id, question: "Which facts are supported?", evidenceIds: [file.id], promptVersion: "harbor-understand-v1", modelId: "local/grounded", approval: nextApproval(), dryRun: false, idempotencyKey: "premium-document-ai-001" }); expect(analysis.aiAction).toBeDefined();
    const retained = first(await run("drive", "retention-set", { fileId: file.id, retainUntil: "2026-08-23T18:00:00.000Z", legalHold: false, expectedVersion: Number(current.data.version), approval: nextApproval(), dryRun: false, idempotencyKey: "premium-retention-set-01" }));
    const deleted = first(await run("drive", "file-delete", { fileId: file.id, expectedVersion: Number(retained.data.version), reason: "Owner-approved removal", approval: nextApproval(), dryRun: false, idempotencyKey: "premium-file-delete-0001" })); expect(deleted.state).toBe("deleted");
    const receipts = await store.listRecords(userId, { moduleId: "drive", recordType: "premium-command-receipt", limit: 100 }); expect(JSON.stringify(receipts)).not.toContain(String(share.privateOutput?.shareToken)); expect(receipts).toHaveLength(7);
  });

  it("executes all eight topic-first communication actions and never silently sends AI text", async () => {
    const { store, userId, run } = await fixture("scale", ["channels"]); const nextApproval = () => approve(userId); const stream = first(await run("channels", "stream-create", { key: "launch", name: "Launch", purpose: "Coordinate release", idempotencyKey: "premium-stream-create-01" })); const topic = first(await run("channels", "topic-create", { streamId: stream.id, title: "Release date", intent: "Choose the date", idempotencyKey: "premium-topic-create-001" }));
    const preview = await run("channels", "message-preview", { topicId: topic.id, body: "Tuesday is the proposed date." }); const posted = first(await run("channels", "message-post", { topicId: topic.id, body: "Tuesday is the proposed date.", previewHash: preview.preview!.previewHash, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-message-post-001" }));
    const summary = await run("channels", "topic-summarize", { topicId: topic.id, question: "What date was proposed?", evidenceIds: [posted.id], promptVersion: "threadline-summary-v1", modelId: "local/grounded", approval: nextApproval(), dryRun: false, idempotencyKey: "premium-topic-summary-01" }); expect(summary.records[0].data).toMatchObject({ output: null, automaticMutationAllowed: false });
    const digest = await run("channels", "digest-draft", { streamId: stream.id, instruction: "Draft a cited digest", evidenceIds: [topic.id], promptVersion: "threadline-digest-v1", modelId: "local/grounded", approval: nextApproval(), dryRun: false, idempotencyKey: "premium-digest-draft-01" }); expect(digest.records[0].data).toMatchObject({ automaticSendAllowed: false, output: null });
    const redacted = first(await run("channels", "message-redact", { messageId: posted.id, expectedVersion: 1, reason: "Approved privacy request", approval: nextApproval(), dryRun: false, idempotencyKey: "premium-message-redact1" })); expect(redacted).toMatchObject({ state: "redacted", data: { body: null } });
    const resolved = first(await run("channels", "topic-resolve", { topicId: topic.id, decision: "Ship Tuesday", expectedVersion: 1, idempotencyKey: "premium-topic-resolve-01" })); expect(resolved.state).toBe("resolved");
    expect(await store.listRecords(userId, { moduleId: "channels", recordType: "premium-command-receipt", limit: 100 })).toHaveLength(7);
  });

  it("executes all nine ERP actions with exact integer balance and approval gates", async () => {
    const { store, userId, run } = await fixture("fleet", ["operations"]); const nextApproval = () => approve(userId); const party = first(await run("operations", "party-create", { name: "Acme", kind: "customer", currency: "USD", idempotencyKey: "premium-party-create-001" })); const item = first(await run("operations", "item-create", { sku: "CONSULT", name: "Consulting", currency: "USD", unitPriceMinor: 25000, idempotencyKey: "premium-item-create-0001" }));
    const order = first(await run("operations", "order-create", { partyId: party.id, currency: "USD", lines: [{ itemId: item.id, quantity: 2 }], idempotencyKey: "premium-order-create-001" })); const invoiceDraft = first(await run("operations", "invoice-draft", { orderId: order.id, issueAt: clock, dueAt: "2026-09-24T18:00:00.000Z", idempotencyKey: "premium-invoice-draft-01" })); const invoice = first(await run("operations", "invoice-issue", { invoiceId: invoiceDraft.id, contentHash: invoiceDraft.data.contentHash, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-invoice-issue-01" }));
    await expect(run("operations", "journal-preview", { currency: "USD", period: "2026-08", memo: "Broken", entries: [{ account: "cash", debitMinor: 50000, creditMinor: 0 }, { account: "revenue", debitMinor: 0, creditMinor: 49999 }] })).rejects.toThrow(/balance exactly/);
    const journalInput = { currency: "USD", period: "2026-08", memo: "Revenue", entries: [{ account: "cash", debitMinor: 50000, creditMinor: 0 }, { account: "revenue", debitMinor: 0, creditMinor: 50000 }] }; const journalPreview = await run("operations", "journal-preview", journalInput); const journal = first(await run("operations", "journal-post", { ...journalInput, previewHash: journalPreview.preview!.previewHash, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-journal-post-001" })); expect(journal.data).toMatchObject({ debitMinor: 50000, creditMinor: 50000, immutable: true });
    const payment = await run("operations", "payment-record", { invoiceId: invoice.id, amountMinor: 50000, currency: "USD", reference: "bank-001", approval: nextApproval(), dryRun: false, idempotencyKey: "premium-payment-record-01" }); expect(payment.records.find((record) => record.recordType === "invoice")?.state).toBe("paid");
    const variance = await run("operations", "variance-explain", { question: "Explain the invoice total", evidenceIds: [order.id, journal.id], promptVersion: "ledgerline-variance-v1", modelId: "local/grounded", approval: nextApproval(), dryRun: false, idempotencyKey: "premium-variance-ai-001" }); expect(variance.records[0].data).toMatchObject({ output: null, mayPostAccountingFacts: false });
    expect(await store.listRecords(userId, { moduleId: "operations", recordType: "premium-command-receipt", limit: 100 })).toHaveLength(8);
  });

  it("loads exact cross-tool premium evidence and rejects a changed snapshot before model work", async () => {
    const { store, userId, run } = await fixture("scale", ["projects"]);
    await store.enableModule(userId, "crm");
    const project = first(await run("projects", "project-create", {
      key: "cross-tool-evidence",
      name: "Cross-tool evidence",
      outcome: "Ground plans in the shared customer record",
      idempotencyKey: "premium-cross-tool-project",
    }));
    const customer = await store.createRecord(userId, {
      moduleId: "crm",
      recordType: "account",
      title: "Shared customer",
      state: "active",
      data: { version: 1, createdByUserId: userId, segment: "enterprise" },
    });
    if (!customer) throw new Error("Expected shared CRM evidence.");

    const firstQueued = await run("projects", "plan-propose", {
      projectId: project.id,
      objective: "Propose a customer-grounded next cycle",
      evidenceIds: [project.id, customer.id],
      promptVersion: "northstar-plan-v1",
      modelId: "local/grounded",
      approval: approve(userId),
      dryRun: false,
      idempotencyKey: "premium-cross-tool-plan-01",
    });
    const firstClaim = await store.claimAiAction();
    expect(firstClaim?.action.id).toBe(firstQueued.aiAction?.id);
    expect(new Set(firstClaim?.records.map((record) => record.id))).toEqual(new Set([project.id, customer.id]));
    expect(premiumBusinessAiEvidenceRecords(firstClaim!.action, firstClaim!.records).map((record) => record.id)).toEqual([project.id, customer.id]);
    await store.completeAiAction(firstClaim!.action.id, { status: "failed", result: { error: "test completion" } });

    const secondQueued = await run("projects", "plan-propose", {
      projectId: project.id,
      objective: "Prove the queued evidence cannot drift",
      evidenceIds: [project.id, customer.id],
      promptVersion: "northstar-plan-v1",
      modelId: "local/grounded",
      approval: approve(userId),
      dryRun: false,
      idempotencyKey: "premium-cross-tool-plan-02",
    });
    const changed = await store.updateRecord(userId, customer.id, { data: { version: 2, segment: "mid-market" } });
    expect(changed?.data.version).toBe(2);
    const secondClaim = await store.claimAiAction();
    expect(secondClaim?.action.id).toBe(secondQueued.aiAction?.id);
    expect(() => premiumBusinessAiEvidenceRecords(secondClaim!.action, secondClaim!.records)).toThrow(/exact premium evidence selection/);
  });

  it("fails closed before model work when an attached Assistant source changes after queueing", async () => {
    const { store, userId, run } = await fixture("fleet", ["projects", "assistant"]); const approval = approve(userId);
    const project = first(await run("projects", "project-create", { key: "stale-evidence", name: "Stale evidence", outcome: "Bind exact source versions", idempotencyKey: "premium-stale-project" }));
    const issue = first(await run("projects", "issue-create", { projectId: project.id, title: "Versioned source", priority: "normal", points: 2, idempotencyKey: "premium-stale-issue01" }));
    const collection = first(await run("assistant", "collection-create", { name: "Exact evidence", purpose: "Reject stale sources", idempotencyKey: "premium-stale-collection" }));
    await run("assistant", "source-attach", { collectionId: collection.id, recordId: issue.id, citationLabel: "Version one", contentHash: "d".repeat(64), idempotencyKey: "premium-stale-attach01" });
    const prompt = first(await run("assistant", "prompt-version-create", { name: "Exact only", systemInstruction: "Use only the attached version.", inputContract: { goal: "string" }, outputContract: { summary: "string", claims: "cited[]" }, idempotencyKey: "premium-stale-prompt01" }));
    const input = { promptVersionId: prompt.id, collectionId: collection.id, evidenceIds: [issue.id], modelId: modelPolicyId, goal: "Explain the issue" };
    const preview = await run("assistant", "run-preview", input);
    const queued = await run("assistant", "run-execute", { ...input, previewHash: preview.preview!.previewHash, approval, dryRun: false, idempotencyKey: "premium-stale-run-001" });
    await run("projects", "issue-transition", { issueId: issue.id, toState: "ready", expectedVersion: 1, reason: "Source changed after queue", idempotencyKey: "premium-stale-transition" });
    const claimed = await store.claimAiAction(); expect(claimed?.action.id).toBe(queued.aiAction?.id);
    expect(claimed?.records.map((record) => record.id)).not.toContain(issue.id);
    expect(() => premiumBusinessAiEvidenceRecords(claimed!.action, claimed!.records)).toThrow(/exact attached Assistant evidence/);
  });

  it("executes all nine AI-workbench actions and binds reviewed output to the exact completed model result", async () => {
    const { store, userId, auth, run } = await fixture("fleet", ["projects", "assistant"]); const nextApproval = () => approve(userId); const source = first(await run("projects", "project-create", { key: "evidence", name: "Evidence", outcome: "Ground claims", idempotencyKey: "premium-evidence-project1" })); const unrelated = first(await run("projects", "project-create", { key: "unrelated", name: "Unrelated", outcome: "Must not reach the model", idempotencyKey: "premium-unrelated-project" })); const collection = first(await run("assistant", "collection-create", { name: "Evidence set", purpose: "Ground one run", idempotencyKey: "premium-collection-create" }));
    const attachment = first(await run("assistant", "source-attach", { collectionId: collection.id, recordId: source.id, citationLabel: "Project outcome", contentHash: "c".repeat(64), idempotencyKey: "premium-source-attach-01" })); const prompt = first(await run("assistant", "prompt-version-create", { name: "Grounded", systemInstruction: "Use only selected evidence.", inputContract: { goal: "string" }, outputContract: { summary: "string", claims: "cited[]" }, idempotencyKey: "premium-prompt-version-01" }));
    const runInput = { promptVersionId: prompt.id, collectionId: collection.id, evidenceIds: [source.id], goal: "Explain the outcome" }; const preview = await run("assistant", "run-preview", runInput); expect(preview.preview).toMatchObject({ requestedModelId: modelPolicyId }); const queued = await run("assistant", "run-execute", { ...runInput, previewHash: preview.preview!.previewHash, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-ai-run-execute" }); expect(queued.records[0].data).toMatchObject({ platformPromptId: "premium.assistant.grounded-workbench", platformPromptVersion: "2026-08-24.1", platformPromptDigest: expect.stringMatching(/^[a-f0-9]{64}$/), output: null, confidence: null, requestedModelId: modelPolicyId, resultContract: { version: "premium-business-ai-result.v1", claimEvidenceRequired: true } });
    const completion = { output: { summary: "The project defines an outcome.", claims: [{ text: "The outcome is to ground claims.", evidenceIds: [source.id] }] }, confidence: 91, evidenceIds: [source.id], promptVersion: prompt.data.contentHash, modelId: modelPolicyId, reviewStatus: "pending-human-review" as const, approvalRequired: true as const };
    expect(() => validatePremiumBusinessAiCompletion({ ...completion, modelId: "different" }, { evidenceIds: [source.id], promptVersion: String(prompt.data.contentHash), modelId: modelPolicyId })).toThrow(/provenance/);
    const claimed = await store.claimAiAction(); expect(claimed?.action.id).toBe(queued.aiAction?.id); expect(new Set(claimed!.records.map((record) => record.id))).toEqual(new Set([source.id, attachment.id])); expect(claimed!.records.map((record) => record.id)).not.toContain(unrelated.id); expect(premiumBusinessAiEvidenceRecords(claimed!.action, claimed!.records).map((record) => record.id)).toEqual([source.id]); await store.completeAiAction(claimed!.action.id, { status: "completed", result: completion }); await store.runInWorkspaceTransaction(userId, () => recordPremiumBusinessAiCompletion(store, auth, claimed!.action.id, undefined, deps));
    const reviewed = await run("assistant", "result-record", { runId: queued.records[0].id, output: completion.output, confidence: completion.confidence, evidenceIds: completion.evidenceIds, review: { status: "approved", reviewedBy: userId, reviewedAt: clock, notes: "Opened the cited source" }, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-result-record-01" }); expect(reviewed.records.find((record) => record.recordType === "ai-result")?.data).toMatchObject({ promptVersion: prompt.data.contentHash, modelId: modelPolicyId, confidence: 91, fabricatedOutputAllowed: false });
    const agentDraft = first(await run("assistant", "agent-draft", { name: "Planner", purpose: "Propose a planning action", promptVersionId: prompt.id, allowedActions: ["projects_issue_create"], maximumSteps: 3, idempotencyKey: "premium-agent-draft-001" })); const agent = first(await run("assistant", "agent-approve", { agentId: agentDraft.id, contentHash: agentDraft.data.contentHash, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-agent-approve-01" })); await expect(run("assistant", "agent-execute", { agentId: agent.id, goal: "Read an unattached record", evidenceIds: [unrelated.id], modelId: modelPolicyId, approval: nextApproval(), dryRun: false, idempotencyKey: "premium-agent-unattached" })).rejects.toThrow(/checksum-attached/); const agentRun = await run("assistant", "agent-execute", { agentId: agent.id, goal: "Propose next work", evidenceIds: [source.id], approval: nextApproval(), dryRun: false, idempotencyKey: "premium-agent-execute-01" }); expect(agentRun.records[0].data).toMatchObject({ automaticMutationAllowed: false, proposalsRequireSeparateApproval: true, allowedActions: ["projects_issue_create"], requestedModelId: modelPolicyId });
    expect(await store.listRecords(userId, { moduleId: "assistant", recordType: "premium-command-receipt", limit: 100 })).toHaveLength(8);
  });
});
