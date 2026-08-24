import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemorySuiteStore } from "../src/server/suite-store.js";

describe("SuiteStore record visibility integration", () => {
  it("filters public member list/get reads while preserving trusted transactional invariants", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerId = randomUUID();
    const subjectId = randomUUID();
    const peerId = randomUUID();
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.enableModule(ownerId, "people");
    await store.enableModule(ownerId, "projects");
    await store.addWorkspaceMember(ownerId, subjectId, "member");
    await store.addWorkspaceMember(ownerId, peerId, "viewer");

    const ownLeave = await store.createRecord(ownerId, {
      moduleId: "people",
      recordType: "leave-request",
      title: "Subject leave",
      state: "pending-human-decision",
      data: { subjectUserId: subjectId, managerRef: ownerId, note: "private subject note" },
    });
    const peerLeave = await store.createRecord(ownerId, {
      moduleId: "people",
      recordType: "leave-request",
      title: "Peer leave",
      state: "pending-human-decision",
      data: { subjectUserId: peerId, managerRef: ownerId, note: "private peer note" },
    });
    const publishedPolicy = await store.createRecord(ownerId, {
      moduleId: "people",
      recordType: "people-policy",
      title: "Published policy",
      state: "published",
      data: { contentHash: "a".repeat(64) },
    });
    if (!ownLeave || !peerLeave || !publishedPolicy) throw new Error("Visibility fixtures were not persisted.");

    expect((await store.listRecords(ownerId, { moduleId: "people", limit: 20 })).map((record) => record.id)).toEqual(expect.arrayContaining([ownLeave.id, peerLeave.id, publishedPolicy.id]));
    expect((await store.listRecords(subjectId, { moduleId: "people", limit: 20 })).map((record) => record.id)).toEqual(expect.arrayContaining([ownLeave.id, publishedPolicy.id]));
    expect((await store.listRecords(subjectId, { moduleId: "people", limit: 20 })).map((record) => record.id)).not.toContain(peerLeave.id);
    expect(await store.getRecord(subjectId, ownLeave.id)).toMatchObject({ id: ownLeave.id, workspaceId: workspace.id });
    expect(await store.getRecord(subjectId, peerLeave.id)).toBeUndefined();
    expect(await store.getRecord(peerId, ownLeave.id)).toBeUndefined();

    const internalPeer = await store.runInWorkspaceTransaction(subjectId, () => store.getRecord(subjectId, peerLeave.id));
    expect(internalPeer?.id).toBe(peerLeave.id);

    const ownerAction = await store.queueAiAction(ownerId, { moduleId: "people", goal: "Owner-only private proposal", context: { evidenceIds: [peerLeave.id] } });
    const subjectAction = await store.queueAiAction(subjectId, { moduleId: "people", goal: "Subject private proposal", context: { evidenceIds: [ownLeave.id] } });
    if (!ownerAction || !subjectAction) throw new Error("Visibility AI fixtures were not queued.");
    expect(ownerAction.context.requestedByUserId).toBe(ownerId);
    expect(await store.getAiAction(subjectId, ownerAction.id)).toBeUndefined();
    expect(await store.getAiAction(subjectId, subjectAction.id)).toMatchObject({ id: subjectAction.id, context: { requestedByUserId: subjectId } });
    expect((await store.runInWorkspaceTransaction(subjectId, () => store.getAiAction(subjectId, ownerAction.id)))?.id).toBe(ownerAction.id);

    const crossModuleAction = await store.queueAiAction(ownerId, { moduleId: "projects", goal: "Use selected private People evidence", context: { evidenceIds: [peerLeave.id] } });
    const crossModuleAudit = await store.createRecord(ownerId, {
      moduleId: "projects",
      recordType: "premium-ai-request-audit",
      title: "Private cross-module request",
      state: "queued",
      data: { requestedByUserId: ownerId, evidenceIds: [peerLeave.id], reviewStatus: "pending-model" },
    });
    if (!crossModuleAction || !crossModuleAudit) throw new Error("Cross-module AI fixtures were not persisted.");
    expect(crossModuleAction.context).toMatchObject({ requestedByUserId: ownerId, evidenceIds: [peerLeave.id] });
    expect(await store.getAiAction(subjectId, crossModuleAction.id)).toBeUndefined();
    expect(await store.getRecord(subjectId, crossModuleAudit.id)).toBeUndefined();
    expect((await store.listRecords(subjectId, { moduleId: "projects", limit: 20 })).map((record) => record.id)).not.toContain(crossModuleAudit.id);
    expect(await store.getRecord(ownerId, crossModuleAudit.id)).toMatchObject({ id: crossModuleAudit.id });
  });

  it("projects generic AI claims through the current requester and keeps legacy suggestions exact", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerId = randomUUID();
    const requesterId = randomUUID();
    const peerId = randomUUID();
    await store.getOrCreateWorkspace(ownerId);
    await store.enableModule(ownerId, "projects");
    await store.enableModule(ownerId, "notify");
    await store.addWorkspaceMember(ownerId, requesterId, "member");
    await store.addWorkspaceMember(ownerId, peerId, "member");

    const requesterAudit = await store.createRecord(requesterId, {
      moduleId: "projects",
      recordType: "ai-request-audit",
      title: "Requester private audit",
      state: "queued",
      data: { requestedByUserId: requesterId, instruction: "requester only" },
    });
    const peerAudit = await store.createRecord(peerId, {
      moduleId: "projects",
      recordType: "ai-request-audit",
      title: "Peer private audit",
      state: "queued",
      data: { requestedByUserId: peerId, instruction: "peer only" },
    });
    const peerResult = await store.createRecord(peerId, {
      moduleId: "projects",
      recordType: "ai-result",
      title: "Peer private result",
      state: "pending-human-review",
      data: { requestedByUserId: peerId, output: "peer only" },
    });
    if (!requesterAudit || !peerAudit || !peerResult) throw new Error("Expected private AI records.");

    const generic = await store.queueAiAction(requesterId, {
      moduleId: "projects",
      goal: "Use only records visible to the requester",
      context: { actionId: "legacy-generic-proposal" },
    });
    const genericClaim = await store.claimAiAction();
    expect(genericClaim?.action.id).toBe(generic?.id);
    expect(genericClaim?.records.map((record) => record.id)).toContain(requesterAudit.id);
    expect(genericClaim?.records.map((record) => record.id)).not.toEqual(expect.arrayContaining([peerAudit.id, peerResult.id]));
    await store.completeAiAction(genericClaim!.action.id, { status: "completed", result: { proposal: "bounded" } });

    const workflow = await store.createRecord(requesterId, {
      moduleId: "notify",
      recordType: "workflow",
      title: "Exact workflow",
      state: "draft",
      data: { createdByUserId: requesterId },
    });
    const unrelated = await store.createRecord(requesterId, {
      moduleId: "notify",
      recordType: "workflow",
      title: "Unrelated workflow",
      state: "draft",
      data: { createdByUserId: requesterId },
    });
    if (!workflow || !unrelated) throw new Error("Expected notification workflows.");
    const legacy = await store.queueAiAction(requesterId, {
      moduleId: "notify",
      goal: "Suggest wording for one workflow",
      context: { actionId: "workflow-suggest", workflowId: workflow.id },
    });
    const legacyClaim = await store.claimAiAction();
    expect(legacyClaim?.action.id).toBe(legacy?.id);
    expect(legacyClaim?.records.map((record) => record.id)).toEqual([workflow.id]);
    expect(legacyClaim?.records.map((record) => record.id)).not.toContain(unrelated.id);
  });
});
