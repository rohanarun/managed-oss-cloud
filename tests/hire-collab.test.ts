import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { validateAiResult } from "../src/server/ai-result";
import { createApp } from "../src/server/app";
import { MemoryRepository } from "../src/server/repository";
import { executeSuiteAction, type SuiteActionResult, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { suiteAction, suiteActionInputJsonSchema, suiteActionRequiredScope, suiteActionToolName, suiteActionsByModule } from "../src/shared/suite-actions";
import { suiteGenericCreateRecordTypes, suiteModuleById } from "../src/shared/suite";

const ownerA = "61616161-6161-4161-8161-616161616161";
const ownerB = "62626262-6262-4262-8262-626262626262";

const dependencies: SuiteEngineDependencies = {
  now: () => new Date("2026-08-24T12:00:00.000Z"),
  resolveTxt: async () => [],
  resolveHost: async () => ["93.184.216.34"],
};

function firstRecord(result: SuiteActionResult) {
  if (result.kind === "record") return result.record;
  if (result.kind === "command" && result.records[0]) return result.records[0];
  throw new Error("Expected a durable record result.");
}

async function publishedJob(store: MemorySuiteStore, userId = ownerA) {
  await store.enableModule(userId, "hire");
  const draft = firstRecord(await executeSuiteAction(store, userId, "hire", "job-draft", {
    title: "Product engineer",
    description: "Build accessible private business software.",
    pipelineStages: ["applied", "review", "interview"],
    privacyNoticeVersion: "notice-2026-08",
  }, dependencies));
  await executeSuiteAction(store, userId, "hire", "job-approve", { jobId: draft.id, contentHash: draft.data.contentHash }, dependencies);
  return firstRecord(await executeSuiteAction(store, userId, "hire", "job-publish", { jobId: draft.id, contentHash: draft.data.contentHash, idempotencyKey: "publish-hiring-job-0001" }, dependencies));
}

async function submittedApplication(store: MemorySuiteStore, userId = ownerA) {
  const job = await publishedJob(store, userId);
  const application = firstRecord(await executeSuiteAction(store, userId, "hire", "application-submit", {
    jobId: job.id,
    candidateName: "Asha Example",
    email: "asha@example.com",
    consent: true,
    answers: [{ key: "portfolio", value: "https://example.com/work" }],
  }, dependencies));
  return { job, application };
}

async function collaborationDocument(store: MemorySuiteStore, userId = ownerA, title = "Project brief") {
  await store.enableModule(userId, "collab");
  const space = firstRecord(await executeSuiteAction(store, userId, "collab", "space-create", { name: "Product" }, dependencies));
  const document = firstRecord(await executeSuiteAction(store, userId, "collab", "document-create", {
    spaceId: space.id,
    title,
    blocks: [{ id: "intro", type: "paragraph", text: "Initial text" }],
  }, dependencies));
  const revision = (await store.listRecords(userId, { moduleId: "collab", recordType: "revision", limit: 20 })).find((record) => record.id === document.data.currentRevisionId)!;
  return { space, document, revision };
}

describe("clean-room hiring and collaboration modules", () => {
  it("publishes the required typed CLI/MCP actions with read, write, AI, array, version, and hash schemas", () => {
    const hire = suiteModuleById.get("hire")!;
    const collab = suiteModuleById.get("collab")!;
    expect(hire).toMatchObject({ minPlan: "starter", resourceClass: "shared", scaleGuidance: expect.stringContaining("Scale") });
    expect(collab).toMatchObject({ minPlan: "starter", resourceClass: "shared", scaleGuidance: expect.stringContaining("Scale") });
    expect(suiteGenericCreateRecordTypes(hire)).toEqual([]);
    expect(suiteGenericCreateRecordTypes(collab)).toEqual([]);

    const hireActions = suiteActionsByModule.get("hire")?.map((action) => action.id);
    const collabActions = suiteActionsByModule.get("collab")?.map((action) => action.id);
    expect(hireActions).toEqual(expect.arrayContaining(["job-list", "job-draft", "job-publish", "application-get", "resume-extract", "candidate-summarize", "transition-preview", "transition-apply", "interview-schedule", "scorecard-submit", "decision-record", "candidate-export", "deletion-preview"]));
    expect(collabActions).toEqual(expect.arrayContaining(["space-list", "document-get", "document-create", "canvas-get", "canvas-create", "patch-propose", "patch-apply", "comment-create", "revision-list", "revision-compare", "revision-restore", "share-create", "export-create"]));
    expect(suiteActionToolName(suiteAction("hire", "transition-preview")!)).toBe("hire_transition_preview");
    expect(suiteActionToolName(suiteAction("collab", "patch-apply")!)).toBe("collab_patch_apply");
    expect(suiteActionRequiredScope(suiteAction("hire", "job-list")!)).toBe("read");
    expect(suiteActionRequiredScope(suiteAction("hire", "resume-extract")!)).toBe("ai");
    expect(suiteActionRequiredScope(suiteAction("collab", "patch-apply")!)).toBe("write");
    expect(suiteActionInputJsonSchema(suiteAction("hire", "job-approve")!).properties.contentHash).toMatchObject({ type: "string", pattern: "^[a-f0-9]{64}$" });
    expect(suiteActionInputJsonSchema(suiteAction("hire", "transition-apply")!).properties.expectedVersion).toMatchObject({ type: "integer" });
    expect(suiteActionInputJsonSchema(suiteAction("collab", "operation-apply")!).properties.operations).toMatchObject({ type: "array" });
    expect(suiteActionInputJsonSchema(suiteAction("collab", "patch-apply")!).properties.approval).toMatchObject({ type: "boolean", const: true });
  });

  it("binds applications to immutable job/pipeline versions and suggests duplicates without merging or blocking", async () => {
    const store = new MemorySuiteStore("starter");
    const job = await publishedJob(store);
    const first = firstRecord(await executeSuiteAction(store, ownerA, "hire", "application-submit", {
      jobId: job.id,
      candidateName: "Asha One",
      email: "same@example.com",
      consent: true,
      answers: [{ key: "experience", value: "Five years" }],
    }, dependencies));
    await store.updateRecord(ownerA, job.id, { data: { version: 2, pipelineVersion: 2, contentHash: "f".repeat(64) } });
    expect(first.data).toMatchObject({ jobVersion: 1, pipelineVersion: 1, pipelineSnapshot: ["applied", "review", "interview"] });

    const restoredJob = await store.updateRecord(ownerA, job.id, { state: "published", data: { version: 1, pipelineVersion: 1, contentHash: job.data.approvedContentHash, approvedContentHash: job.data.approvedContentHash } });
    const second = firstRecord(await executeSuiteAction(store, ownerA, "hire", "application-submit", {
      jobId: restoredJob!.id,
      candidateName: "Asha Two",
      email: "same@example.com",
      consent: true,
      answers: [{ key: "experience", value: "Six years" }],
    }, dependencies));
    expect(second.id).not.toBe(first.id);
    expect(second.data.candidateId).not.toBe(first.data.candidateId);
    const secondCandidate = await store.getRecord(ownerA, String(second.data.candidateId));
    expect(secondCandidate?.data.duplicateSuggestionIds).toContain(first.data.candidateId);
    expect(await store.listRecords(ownerA, { moduleId: "hire", recordType: "application", limit: 20 })).toHaveLength(2);
    await expect(executeSuiteAction(store, ownerA, "hire", "application-submit", { jobId: restoredJob!.id, candidateName: "Unsafe", email: "unsafe@example.com", consent: true, answers: [{ key: "race", value: "inferred" }] }, dependencies)).rejects.toThrow(/protected or sensitive trait/);
  });

  it("requires exact transition previews, appends events, and denies every automated terminal hiring path", async () => {
    const store = new MemorySuiteStore("starter");
    const { application } = await submittedApplication(store);
    const preview = await executeSuiteAction(store, ownerA, "hire", "transition-preview", { applicationId: application.id, toStage: "review" }, dependencies);
    expect(preview.kind).toBe("command");
    if (preview.kind !== "command") throw new Error("Expected transition preview.");
    expect(preview.audit).toMatchObject({ expectedVersion: 1, fromStage: "applied", toStage: "review", mutationApplied: false, previewHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(executeSuiteAction(store, ownerA, "hire", "transition-apply", { applicationId: application.id, toStage: "review", expectedVersion: 1, reason: "Structured evidence review", previewHash: "0".repeat(64) }, dependencies)).rejects.toThrow(/stale/);
    expect((await store.getRecord(ownerA, application.id))?.data.currentStage).toBe("applied");
    const applied = firstRecord(await executeSuiteAction(store, ownerA, "hire", "transition-apply", { applicationId: application.id, toStage: "review", expectedVersion: 1, reason: "Structured evidence review", previewHash: preview.audit.previewHash }, dependencies));
    expect(applied.data).toMatchObject({ currentStage: "review", version: 2 });
    expect(await store.listRecords(ownerA, { moduleId: "hire", recordType: "application-event", limit: 20 })).toHaveLength(2);
    await expect(executeSuiteAction(store, ownerA, "hire", "transition-preview", { applicationId: application.id, toStage: "hired" }, dependencies)).rejects.toThrow(/cannot perform hired or not-selected/);
    await expect(executeSuiteAction(store, ownerA, "hire", "decision-record", { applicationId: application.id, decisionType: "not_selected", reason: "Automated", evidenceIds: [application.id], expectedVersion: 2 }, dependencies)).rejects.toThrow(/human-only/);
    expect((await store.getRecord(ownerA, application.id))?.state).toBe("active");
  });

  it("keeps candidate reads, exports, and AI evidence tenant-scoped and proposal-only", async () => {
    const store = new MemorySuiteStore("starter");
    const { application } = await submittedApplication(store, ownerA);
    await store.enableModule(ownerB, "hire");
    const candidate = await store.getRecord(ownerA, String(application.data.candidateId));
    await expect(executeSuiteAction(store, ownerB, "hire", "application-get", { applicationId: application.id }, dependencies)).rejects.toThrow(/not found/);
    await expect(executeSuiteAction(store, ownerB, "hire", "candidate-export", { candidateId: candidate!.id }, dependencies)).rejects.toThrow(/not found/);

    const resume = await store.createRecord(ownerA, { moduleId: "hire", recordType: "resume-document", title: "Private resume", state: "quarantined", data: { applicationId: application.id, scanState: "malware", objectKey: "private/resume.pdf", contentHash: "a".repeat(64) } });
    await expect(executeSuiteAction(store, ownerA, "hire", "resume-extract", { applicationId: application.id, resumeDocumentId: resume!.id, instruction: "Extract cited facts.", rawResume: "secret" }, dependencies)).rejects.toThrow(/clean private resume/);
    await store.updateRecord(ownerA, resume!.id, { state: "available", data: { scanState: "clean" } });
    const queued = await executeSuiteAction(store, ownerA, "hire", "resume-extract", { applicationId: application.id, resumeDocumentId: resume!.id, instruction: "Extract cited facts.", providerSecret: "must-not-enter-model" }, dependencies);
    expect(queued.kind).toBe("ai-action");
    if (queued.kind !== "ai-action") throw new Error("Expected AI action.");
    expect(queued.aiAction.context).toMatchObject({ applicationId: application.id, resumeDocumentId: resume!.id, evidenceIds: [application.id, resume!.id], approvalRequired: true, outputContract: { sourceSpans: true, confidencePerField: true, omitUnsupportedFacts: true } });
    expect(JSON.stringify(queued.aiAction.context)).not.toContain("providerSecret");
    expect(JSON.stringify(queued.aiAction.context)).not.toContain("private/resume.pdf");
    expect(() => validateAiResult({ proposal: "Apply silently", evidence: [], assumptions: [], approvalRequired: false }, [])).toThrow();

    const exported = firstRecord(await executeSuiteAction(store, ownerA, "hire", "candidate-export", { candidateId: candidate!.id }, dependencies));
    expect(exported).toMatchObject({ recordType: "export", state: "ready", data: { candidateId: candidate!.id, private: true, manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const deletion = firstRecord(await executeSuiteAction(store, ownerA, "hire", "deletion-preview", { candidateId: candidate!.id }, dependencies));
    expect(deletion).toMatchObject({ recordType: "deletion-request", state: "preview", data: { candidateId: candidate!.id, executionStarted: false, planHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await store.getRecord(ownerA, candidate!.id)).toBeDefined();
  });

  it("applies safe collaboration operations exactly once and rejects stale, executable, malformed, or cross-tenant mutations", async () => {
    const store = new MemorySuiteStore("starter");
    const { document } = await collaborationDocument(store, ownerA);
    const operationId = randomUUID();
    const input = { resourceId: document.id, operationId, baseVersion: 1, operations: [{ op: "upsert", item: { id: "scope", type: "heading", text: "Scope" } }] };
    const applied = await executeSuiteAction(store, ownerA, "collab", "operation-apply", input, dependencies);
    const replay = await executeSuiteAction(store, ownerA, "collab", "operation-apply", input, dependencies);
    expect(applied.kind === "command" && applied.audit.replayed).toBe(false);
    expect(replay.kind === "command" && replay.audit.replayed).toBe(true);
    expect(firstRecord(applied).data.version).toBe(2);
    expect(await store.listRecords(ownerA, { moduleId: "collab", recordType: "operation", limit: 20 })).toHaveLength(1);
    await expect(executeSuiteAction(store, ownerA, "collab", "operation-apply", { ...input, operations: [{ op: "remove", id: "intro" }] }, dependencies)).rejects.toThrow(/already used/);
    await expect(executeSuiteAction(store, ownerA, "collab", "operation-apply", { ...input, operationId: randomUUID(), operations: [{ op: "remove", id: "intro" }] }, dependencies)).rejects.toThrow(/version is stale/);
    await expect(executeSuiteAction(store, ownerA, "collab", "operation-apply", { resourceId: document.id, operationId: randomUUID(), baseVersion: 2, operations: [{ op: "upsert", item: { id: "bad", type: "paragraph", html: "<script>run()</script>" } }] }, dependencies)).rejects.toThrow(/forbidden field|executable content/);

    const canvasSpace = firstRecord(await executeSuiteAction(store, ownerA, "collab", "space-create", { name: "Canvas" }, dependencies));
    await expect(executeSuiteAction(store, ownerA, "collab", "canvas-create", { spaceId: canvasSpace.id, title: "Unsafe canvas", elements: [{ id: "shape", type: "rectangle", x: Number.POSITIVE_INFINITY, y: 0, width: 100, height: 100 }] }, dependencies)).rejects.toThrow(/non-finite|finite geometry/);
    await store.enableModule(ownerB, "collab");
    await expect(executeSuiteAction(store, ownerB, "collab", "document-get", { documentId: document.id }, dependencies)).rejects.toThrow(/not found/);
    await expect(executeSuiteAction(store, ownerB, "collab", "operation-apply", { ...input, operationId: randomUUID(), baseVersion: 2 }, dependencies)).rejects.toThrow(/not found/);
  });

  it("restores a historical collaboration snapshot as a new linked head without rewriting history", async () => {
    const store = new MemorySuiteStore("starter");
    const { document, revision: firstRevision } = await collaborationDocument(store);
    const operation = await executeSuiteAction(store, ownerA, "collab", "operation-apply", { resourceId: document.id, operationId: randomUUID(), baseVersion: 1, operations: [{ op: "upsert", item: { id: "new", type: "paragraph", text: "New content" } }] }, dependencies);
    const secondRevision = operation.kind === "command" ? operation.records.find((record) => record.recordType === "revision")! : undefined;
    const restored = await executeSuiteAction(store, ownerA, "collab", "revision-restore", { resourceId: document.id, revisionId: firstRevision.id, expectedVersion: 2 }, dependencies);
    expect(restored.kind).toBe("command");
    if (restored.kind !== "command") throw new Error("Expected restore result.");
    const head = restored.records.find((record) => record.recordType === "document")!;
    const restoredRevision = restored.records.find((record) => record.recordType === "revision" && record.id !== firstRevision.id)!;
    expect(head.data).toMatchObject({ version: 3, currentRevisionId: restoredRevision.id });
    expect(restoredRevision.data).toMatchObject({ restoredFromRevisionId: firstRevision.id, parentRevisionIds: expect.arrayContaining([firstRevision.id, secondRevision!.id]), immutable: true });
    const revisions = await store.listRecords(ownerA, { moduleId: "collab", recordType: "revision", limit: 20 });
    expect(new Set(revisions.map((record) => record.id))).toEqual(new Set([firstRevision.id, secondRevision!.id, restoredRevision.id]));
    const comparison = await executeSuiteAction(store, ownerA, "collab", "revision-compare", { resourceId: document.id, fromRevisionId: secondRevision!.id, toRevisionId: restoredRevision.id }, dependencies);
    expect(comparison.kind === "command" && comparison.audit.changes).toMatchObject({ removedIds: ["new"] });
  });

  it("keeps AI patches proposal-only, selected, exact-version, explicitly approved, and attributed", async () => {
    const store = new MemorySuiteStore("starter");
    const { document, revision } = await collaborationDocument(store);
    const proposed = await executeSuiteAction(store, ownerA, "collab", "patch-propose", { resourceId: document.id, sourceRevisionId: revision.id, selection: ["intro"], instruction: "Rewrite the selected paragraph.", hiddenComment: "must-not-enter-model" }, dependencies);
    expect(proposed.kind).toBe("ai-action");
    if (proposed.kind !== "ai-action") throw new Error("Expected AI proposal.");
    expect(proposed.aiAction.context).toMatchObject({ resourceId: document.id, sourceRevisionId: revision.id, sourceVersion: 1, selection: ["intro"], evidenceIds: [document.id, revision.id], approvalRequired: true, executableContentAllowed: false });
    expect(JSON.stringify(proposed.aiAction.context)).not.toContain("hiddenComment");
    const claimed = await store.claimAiAction();
    expect(claimed?.action.id).toBe(proposed.aiAction.id);
    await store.completeAiAction(proposed.aiAction.id, { status: "completed", result: { proposal: "Replace selected block", evidence: [document.id, revision.id], assumptions: [], approvalRequired: true, operations: [{ op: "upsert", item: { id: "intro", type: "paragraph", text: "Model-proposed text" } }] } });
    await expect(executeSuiteAction(store, ownerA, "collab", "patch-apply", { proposalId: proposed.aiAction.id, resourceId: document.id, sourceRevisionId: revision.id, expectedVersion: 1, approval: false }, dependencies)).rejects.toThrow(/approval/);
    expect((await store.getRecord(ownerA, document.id))?.data.version).toBe(1);
    const applied = await executeSuiteAction(store, ownerA, "collab", "patch-apply", { proposalId: proposed.aiAction.id, resourceId: document.id, sourceRevisionId: revision.id, expectedVersion: 1, approval: true }, dependencies);
    expect(applied.kind).toBe("command");
    if (applied.kind !== "command") throw new Error("Expected approved patch.");
    const patch = applied.records.find((record) => record.recordType === "ai-patch")!;
    expect(patch).toMatchObject({ state: "accepted", data: { aiActionId: proposed.aiAction.id, sourceRevisionId: revision.id, sourceVersion: 1, approvedByUserId: ownerA, approvalRequired: true, immutable: true } });
    const replay = await executeSuiteAction(store, ownerA, "collab", "patch-apply", { proposalId: proposed.aiAction.id, resourceId: document.id, sourceRevisionId: revision.id, expectedVersion: 1, approval: true }, dependencies);
    expect(replay.kind === "command" && replay.audit.replayed).toBe(true);

    const staleFixture = await collaborationDocument(store, ownerA, "Stale proposal");
    const staleProposal = await executeSuiteAction(store, ownerA, "collab", "patch-propose", { resourceId: staleFixture.document.id, sourceRevisionId: staleFixture.revision.id, selection: ["intro"], instruction: "Rewrite it." }, dependencies);
    if (staleProposal.kind !== "ai-action") throw new Error("Expected AI proposal.");
    const staleClaim = await store.claimAiAction();
    await store.completeAiAction(staleClaim!.action.id, { status: "completed", result: { proposal: "Patch", evidence: [], assumptions: [], approvalRequired: true, operations: [{ op: "remove", id: "intro" }] } });
    await executeSuiteAction(store, ownerA, "collab", "operation-apply", { resourceId: staleFixture.document.id, operationId: randomUUID(), baseVersion: 1, operations: [{ op: "upsert", item: { id: "later", type: "paragraph", text: "Later edit" } }] }, dependencies);
    await expect(executeSuiteAction(store, ownerA, "collab", "patch-apply", { proposalId: staleProposal.aiAction.id, resourceId: staleFixture.document.id, sourceRevisionId: staleFixture.revision.id, expectedVersion: 2, approval: true }, dependencies)).rejects.toThrow(/stale/);
    expect((await store.getRecord(ownerA, staleFixture.document.id))?.data.version).toBe(2);
  });

  it("pins shares and exports to exact revisions and stores only the share token hash", async () => {
    const store = new MemorySuiteStore("starter");
    const { document, revision } = await collaborationDocument(store);
    const shared = await executeSuiteAction(store, ownerA, "collab", "share-create", { resourceId: document.id, revisionId: revision.id, permission: "view", expiresAt: "2026-09-01T00:00:00.000Z" }, dependencies);
    expect(shared.kind).toBe("command");
    if (shared.kind !== "command") throw new Error("Expected share result.");
    const share = firstRecord(shared);
    expect(shared.audit.token).toEqual(expect.any(String));
    expect(share.data).toMatchObject({ pinnedRevisionId: revision.id, pinnedContentHash: revision.data.contentHash, currentView: false });
    expect(JSON.stringify(share.data)).not.toContain(String(shared.audit.token));
    await executeSuiteAction(store, ownerA, "collab", "operation-apply", { resourceId: document.id, operationId: randomUUID(), baseVersion: 1, operations: [{ op: "upsert", item: { id: "later", type: "paragraph", text: "Private later edit" } }] }, dependencies);
    expect((await store.getRecord(ownerA, share.id))?.data.pinnedRevisionId).toBe(revision.id);
    const exported = firstRecord(await executeSuiteAction(store, ownerA, "collab", "export-create", { resourceId: document.id, revisionId: revision.id, format: "markdown" }, dependencies));
    expect(exported).toMatchObject({ state: "queued", data: { revisionId: revision.id, revisionVersion: 1, contentHash: revision.data.contentHash, exactRevision: true, externalRendererStarted: false } });
  });

  it("enforces read-only action tokens and blocks generic HTTP mutation bypasses for protected records", async () => {
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: new MemorySuiteStore("starter"), synchronizeSuiteEntitlements: false });
    const session = request.agent(app);
    await session.post("/api/auth/signup").send({ displayName: "Hiring Owner", email: "hire-http@example.com", password: "long-safe-password" });
    expect((await session.post("/api/suite/modules/hire/enable")).status).toBe(201);
    const drafted = await session.post("/api/suite/modules/hire/actions/job-draft").send({ input: { title: "Engineer", description: "Build software", pipelineStages: ["applied", "review"], privacyNoticeVersion: "notice-1" } });
    expect(drafted.status).toBe(200);
    const jobId = drafted.body.records[0].id;
    expect((await session.post("/api/suite/records").send({ moduleId: "hire", recordType: "job", title: "Bypass", data: { state: "hired" } })).status).toBe(410);
    expect((await session.patch(`/api/suite/records/${jobId}`).send({ state: "published", data: { public: true } })).status).toBe(410);

    const readToken = (await session.post("/api/suite/api-tokens").send({ name: "Hiring reader", scopes: ["read"], expiresInDays: 30 })).body.token.token;
    const authorization = { Authorization: `Bearer ${readToken}` };
    expect((await request(app).post("/api/suite/modules/hire/actions/job-list").set(authorization).send({ input: {} })).status).toBe(200);
    expect((await request(app).post("/api/suite/modules/hire/actions/job-draft").set(authorization).send({ input: { title: "Escalation", description: "No", pipelineStages: ["applied"], privacyNoticeVersion: "notice-1" } })).status).toBe(403);
  });
});
