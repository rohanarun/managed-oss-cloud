import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { additiveBusinessActions, additiveBusinessActionsByModule, additiveBusinessModules, type AdditiveBusinessPlanId, type AdditiveBusinessRole } from "../src/shared/additive-business-actions.js";
import { suiteModuleById, type SuiteModuleDefinition, type SuiteRecord } from "../src/shared/suite.js";
import { AdditiveBusinessEngine, additiveBusinessModuleSnapshotLimit, executeAdditiveBusinessActionWithStore, type AdditiveBusinessEngineContext, type AdditiveBusinessExecutionResult, type AdditiveBusinessRecord } from "../src/server/additive-business-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";
import { canReadSuiteRecord } from "../src/server/suite-record-visibility.js";

const clock = "2026-08-24T18:00:00.000Z";
const actorId = "workspace-owner-0001";
const workspaceId = randomUUID();
const key = (label: string) => `${label}.idempotency-key-0001`;
let approvalOrdinal = 0;
const approve = (actor = actorId, approvedAt = clock, decisionId?: string) => ({ approved: true, approvedBy: actor, approvedAt, decisionId: decisionId ?? `additive.approval.${actor}.${String(++approvalOrdinal).padStart(4, "0")}`, reason: "Reviewed the exact requested effect and its tenant evidence." });
const context = (plan: AdditiveBusinessPlanId = "fleet", workspace = workspaceId, actor = actorId, scopes: readonly string[] = ["*"], role: AdditiveBusinessRole = "owner", workspaceMembers: readonly { userId: string; role: AdditiveBusinessRole }[] = [{ userId: actor, role }]): AdditiveBusinessEngineContext => ({ workspaceId: workspace, actorId: actor, plan, role, workspaceMembers, scopes, modelPolicyId: "local/grounded", now: () => new Date(clock) });
function first(result: AdditiveBusinessExecutionResult) { const record = result.records[0]; if (!record) throw new Error("Expected a durable record."); return record; }
async function base(engine: AdditiveBusinessEngine, ctx = context("starter"), label = "customers") { return first(await engine.execute(ctx, "tables", "base-create", { key: label, name: "Customers", purpose: "Track customer facts with an explicit schema", idempotencyKey: key(`base-${label}`) })); }
function memberCanRead(record: AdditiveBusinessRecord, userId: string) {
  return canReadSuiteRecord({ userId, workspaceId: record.workspaceId, role: "member" }, {
    workspaceId: record.workspaceId,
    moduleId: record.moduleId,
    recordType: record.recordType,
    state: record.state,
    data: { additiveContract: "additive-business-record.v1", record },
  });
}

describe("additional clean-room AI-native business modules", () => {
  it("publishes original CLI/MCP contracts with shared-database and proposal-only safety metadata", () => {
    expect(additiveBusinessModules.map((module) => module.id)).toEqual(["tables", "meetings", "insights", "learning", "community"]);
    expect(additiveBusinessActions).toHaveLength(46);
    for (const module of additiveBusinessModules) {
      expect(module.dataPlane).toBe("workspace-shared");
      expect(module.minimumMonthlyPlanUsd).toBe(module.minPlan === "starter" ? 7 : 50);
      expect(module.resource.class).toBe(module.id === "tables" ? "shared" : "high");
      const actions = additiveBusinessActionsByModule.get(module.id)!;
      expect(actions.length).toBeGreaterThanOrEqual(9);
      for (const action of actions) {
        expect(action.productName).not.toMatch(/Airtable|Fireflies|Fathom|Metabase|Moodle|\bCircle\b|Skool/i);
        expect(action.mcpToolName).toBe(`${module.id}_${action.id.replaceAll("-", "_")}`);
        expect(action.cliExample).toContain(`supersuite action ${module.id} ${action.id}`);
        expect(action.inputSchema.additionalProperties).toBe(false);
        if (action.operation !== "read") expect(action.inputSchema.required).toContain("idempotencyKey");
        if (["high", "critical"].includes(action.risk)) expect(["admin", "owner"]).toContain(action.minimumRole);
        else expect(["viewer", "member", "admin", "owner"]).toContain(action.minimumRole);
        if (action.requiresApproval) {
          expect(action.supportsDryRun).toBe(true);
          expect(action.inputSchema.required).toContain("dryRun");
          expect(action.inputSchema.properties).toHaveProperty("approval");
          expect(action.inputSchema.properties.approval).toMatchObject({ required: expect.arrayContaining(["decisionId"]) });
        }
        if (action.operation === "ai") {
          expect(action).toMatchObject({ externalEffect: "model", requiresApproval: true, supportsDryRun: true, promptVersion: "2026-08-24.1" });
          expect(action.inputSchema.required).not.toContain("modelId");
          expect(action.exampleInput).not.toHaveProperty("modelId");
          expect(action.inputSchema.properties.modelId).toMatchObject({ description: expect.stringContaining("Optional expected workspace-configured model identifier") });
        }
      }
    }
    expect(new Set(additiveBusinessActions.map((action) => action.mcpToolName)).size).toBe(additiveBusinessActions.length);
  });

  it("runs the Starter table path with typed rows, exact imports, deterministic formulas, and idempotency", async () => {
    const engine = new AdditiveBusinessEngine();
    const ctx = context("starter");
    const table = await base(engine, ctx);
    await engine.execute(ctx, "tables", "field-add", { baseId: table.id, key: "company", label: "Company", fieldType: "text", required: true, idempotencyKey: key("field-company") });
    await engine.execute(ctx, "tables", "field-add", { baseId: table.id, key: "revenue", label: "Revenue", fieldType: "number", required: false, idempotencyKey: key("field-revenue") });
    await expect(engine.execute(ctx, "tables", "row-create", { baseId: table.id, values: { revenue: 50 }, sourceRecordIds: [], idempotencyKey: key("bad-required") })).rejects.toThrow(/Required field company/);

    const rowInput = { baseId: table.id, values: { company: "Northwind", revenue: 125.5 }, sourceRecordIds: [table.id], idempotencyKey: key("row") };
    const created = await engine.execute(ctx, "tables", "row-create", rowInput);
    const replayed = await engine.execute(ctx, "tables", "row-create", rowInput);
    expect(first(replayed).id).toBe(first(created).id);
    expect(replayed.audit).toMatchObject({ replayed: true, decision: "replayed" });
    await expect(engine.execute(ctx, "tables", "row-create", { ...rowInput, values: { company: "Different", revenue: 125.5 } })).rejects.toThrow(/idempotency key was already used/);
    const updated = first(await engine.execute(ctx, "tables", "row-update", { rowId: first(created).id, expectedVersion: 1, patch: { revenue: 150 }, idempotencyKey: key("row-update") }));
    expect(updated).toMatchObject({ version: 2, data: { values: { company: "Northwind", revenue: 150 } } });
    await engine.execute(ctx, "tables", "view-create", { baseId: table.id, name: "By revenue", filter: {}, sort: [{ field: "revenue", direction: "desc" }], idempotencyKey: key("view") });

    const rows = [{ company: "Acme", revenue: 25 }, { company: "Globex", revenue: 75 }];
    const preview = await engine.execute(ctx, "tables", "import-preview", { baseId: table.id, rows });
    const apply = { baseId: table.id, rows, previewHash: preview.preview!.previewHash, dryRun: false, idempotencyKey: key("import") };
    await expect(engine.execute(ctx, "tables", "import-apply", apply)).rejects.toThrow(/human approval/);
    const dry = await engine.execute(ctx, "tables", "import-apply", { ...apply, dryRun: true, idempotencyKey: key("import-dry") });
    expect(dry).toMatchObject({ records: [], preview: { wouldCreateRows: 2 }, audit: { dryRun: true, decision: "previewed" } });
    expect((await engine.execute(ctx, "tables", "import-apply", { ...apply, approval: approve() })).records).toHaveLength(2);
    const aggregate = await engine.execute(ctx, "tables", "formula-evaluate", { baseId: table.id, operation: "sum", fieldKey: "revenue" });
    expect(aggregate.preview).toMatchObject({ value: 250, valueCount: 3, deterministic: true });
    expect(engine.listRecords(ctx, { moduleId: "tables", recordType: "table-row" })).toHaveLength(3);
  });

  it("enforces plan, scope, tenant, approval, dry-run, and optimistic-lock boundaries", async () => {
    const engine = new AdditiveBusinessEngine();
    await expect(engine.execute(context("starter"), "meetings", "meeting-create", { title: "Blocked", purpose: "Scale only", startsAt: clock, privacy: "workspace", idempotencyKey: key("blocked-plan") })).rejects.toThrow(/\$50\/month Scale/);
    await expect(engine.execute(context("scale", workspaceId, actorId, ["tables:read"]), "tables", "base-create", { key: "blocked", name: "Blocked", purpose: "No write", idempotencyKey: key("blocked-scope") })).rejects.toThrow(/tables:write scope/);

    const owner = context("scale");
    const meeting = first(await engine.execute(owner, "meetings", "meeting-create", { title: "Private review", purpose: "Check privacy", startsAt: clock, privacy: "restricted", idempotencyKey: key("tenant-meeting") }));
    const segment = first(await engine.execute(owner, "meetings", "transcript-append", { meetingId: meeting.id, speaker: "Avery", startMs: 0, endMs: 2000, text: "Private detail", source: "manual", idempotencyKey: key("tenant-segment") }));
    const outsider = context("scale", randomUUID(), "outsider-0001");
    expect(engine.getRecord(outsider, meeting.id)).toBeUndefined();
    await expect(engine.execute(outsider, "meetings", "participant-add", { meetingId: meeting.id, displayName: "Outsider", role: "observer", userRef: "outsider-0001", idempotencyKey: key("cross-tenant") })).rejects.toThrow(/not found in this workspace/);

    const redact = { segmentId: segment.id, expectedVersion: 1, reason: "Approved privacy request", dryRun: false, idempotencyKey: key("redact") };
    await expect(engine.execute(owner, "meetings", "transcript-redact", redact)).rejects.toThrow(/human approval/);
    await expect(engine.execute(owner, "meetings", "transcript-redact", { ...redact, approval: approve("wrong-actor") })).rejects.toThrow(/human approval/);
    await expect(engine.execute(owner, "meetings", "transcript-redact", { ...redact, approval: approve(actorId, "2026-08-24T18:00:00.001Z", "future.approval.0001") })).rejects.toThrow(/future-dated/);
    await expect(engine.execute(owner, "meetings", "transcript-redact", { ...redact, approval: approve(actorId, "2026-08-23T17:59:59.999Z", "stale.approval.0001") })).rejects.toThrow(/approval is stale/);
    await expect(engine.execute(owner, "meetings", "transcript-redact", { ...redact, approval: { ...approve(), decisionId: "too-short" } })).rejects.toThrow(/too short|invalid format/);
    const memberId = "workspace-member-0002";
    const members = [{ userId: actorId, role: "owner" as const }, { userId: memberId, role: "member" as const }];
    const member = context("scale", workspaceId, memberId, ["*"], "member", members);
    await expect(engine.execute(member, "meetings", "transcript-redact", { ...redact, approval: approve(memberId) })).rejects.toThrow(/admin role is required/);
    const dry = await engine.execute(owner, "meetings", "transcript-redact", { ...redact, dryRun: true, idempotencyKey: key("redact-dry") });
    expect(dry.records).toHaveLength(0);
    expect(engine.getRecord(owner, segment.id)?.state).toBe("captured");
    const redacted = first(await engine.execute(owner, "meetings", "transcript-redact", { ...redact, approval: approve() }));
    expect(redacted).toMatchObject({ state: "redacted", version: 2, data: { text: null, redacted: true, redactedBy: actorId } });
    expect((await engine.execute(owner, "meetings", "meeting-export", { meetingId: meeting.id, includeTranscript: false, format: "canonical-json", idempotencyKey: key("privacy-export") })).records[0]?.data).toMatchObject({ meetingPrivacy: "restricted", meetingCreatedBy: actorId, exportedBy: actorId });
    await expect(engine.execute(owner, "meetings", "transcript-redact", { ...redact, expectedVersion: 1, approval: approve(), idempotencyKey: key("stale-redact") })).rejects.toThrow(/Expected version 2/);
  });

  it("binds replay receipts to one actor and consumes approvals once across the workspace", async () => {
    const engine = new AdditiveBusinessEngine();
    const memberId = "workspace-member-replay-0002";
    const members = [{ userId: actorId, role: "owner" as const }, { userId: memberId, role: "member" as const }];
    const owner = context("scale", workspaceId, actorId, ["*"], "owner", members);
    const member = context("scale", workspaceId, memberId, ["*"], "member", members);
    const baseInput = { key: "actor-bound", name: "Actor bound", purpose: "Reject another member replay", idempotencyKey: key("actor-bound-base") };
    await engine.execute(owner, "tables", "base-create", baseInput);
    await expect(engine.execute(member, "tables", "base-create", baseInput)).rejects.toThrow(/bound to another workspace actor/);

    const table = await base(engine, owner, "approval-once");
    await engine.execute(owner, "tables", "field-add", { baseId: table.id, key: "name", label: "Name", fieldType: "text", required: false, idempotencyKey: key("approval-field") });
    const rows = [{ name: "Northwind" }];
    const preview = await engine.execute(owner, "tables", "import-preview", { baseId: table.id, rows });
    const decision = approve(actorId, clock, "workspace.single-use-decision-0001");
    await engine.execute(owner, "tables", "import-apply", { baseId: table.id, rows, previewHash: preview.preview!.previewHash, dryRun: false, approval: decision, idempotencyKey: key("approval-import") });

    const meeting = first(await engine.execute(owner, "meetings", "meeting-create", { title: "Approval boundary", purpose: "Cross-module approval proof", startsAt: clock, privacy: "workspace", idempotencyKey: key("approval-meeting") }));
    const segment = first(await engine.execute(owner, "meetings", "transcript-append", { meetingId: meeting.id, speaker: actorId, startMs: 0, endMs: 500, text: "Sensitive text", source: "manual", idempotencyKey: key("approval-segment") }));
    await expect(engine.execute(owner, "meetings", "transcript-redact", { segmentId: segment.id, expectedVersion: 1, reason: "Should need its own decision", dryRun: false, approval: decision, idempotencyKey: key("approval-redaction") })).rejects.toThrow(/decision ID is already bound/);
  });

  it("binds user references and sensitive child writes to authenticated workspace membership and parent visibility", async () => {
    const engine = new AdditiveBusinessEngine();
    const learnerId = "workspace-member-0002";
    const otherId = "workspace-member-0003";
    const members = [{ userId: actorId, role: "owner" as const }, { userId: learnerId, role: "member" as const }, { userId: otherId, role: "member" as const }];
    const owner = context("scale", workspaceId, actorId, ["*"], "owner", members);
    const learner = context("scale", workspaceId, learnerId, ["*"], "member", members);
    const other = context("scale", workspaceId, otherId, ["*"], "member", members);

    const meeting = first(await engine.execute(owner, "meetings", "meeting-create", { title: "Restricted", purpose: "Exact participant access", startsAt: clock, privacy: "restricted", idempotencyKey: key("privacy-meeting") }));
    const ownerSegment = first(await engine.execute(owner, "meetings", "transcript-append", { meetingId: meeting.id, speaker: actorId, startMs: 0, endMs: 500, text: "Creator-only before the participant is added.", source: "manual", idempotencyKey: key("owner-sensitive-segment") }));
    expect(ownerSegment.data).toMatchObject({ meetingParticipantUserRefs: [], recordedBy: actorId, speakerRef: actorId });
    await expect(engine.execute(learner, "meetings", "transcript-append", { meetingId: meeting.id, speaker: "Learner", startMs: 0, endMs: 1_000, text: "Blocked", source: "manual", idempotencyKey: key("blocked-sensitive-meeting") })).rejects.toThrow(/not found in this workspace/);
    await expect(engine.execute(owner, "meetings", "participant-add", { meetingId: meeting.id, displayName: "Ghost", role: "observer", userRef: "not-a-workspace-member", idempotencyKey: key("ghost-participant") })).rejects.toThrow(/authenticated workspace member/);
    const participantResult = await engine.execute(owner, "meetings", "participant-add", { meetingId: meeting.id, displayName: "Learner", role: "participant", userRef: learnerId, idempotencyKey: key("real-participant") });
    expect(first(participantResult).data).toMatchObject({ userRef: learnerId, meetingParticipantUserRefs: [learnerId] });
    const updatedMeeting = participantResult.records.find((record) => record.recordType === "meeting")!;
    expect(updatedMeeting.data.participantUserRefs).toEqual([learnerId]);
    const propagatedOwnerSegment = engine.getRecord(owner, ownerSegment.id)!;
    expect(propagatedOwnerSegment).toMatchObject({ version: 2, data: { meetingParticipantUserRefs: [learnerId], recordedBy: actorId, speakerRef: actorId } });
    expect(memberCanRead(updatedMeeting, learnerId)).toBe(true);
    expect(memberCanRead(propagatedOwnerSegment, learnerId)).toBe(true);
    const segment = first(await engine.execute(learner, "meetings", "transcript-append", { meetingId: meeting.id, speaker: learnerId, startMs: 500, endMs: 1_000, text: "Allowed", source: "manual", idempotencyKey: key("participant-segment") }));
    expect(segment.data).toMatchObject({ meetingPrivacy: "restricted", meetingCreatedBy: actorId, meetingParticipantUserRefs: [learnerId], recordedBy: learnerId, speakerRef: learnerId });
    await expect(engine.execute(owner, "meetings", "decision-record", { meetingId: meeting.id, decision: "Invalid owner", ownerRef: "ghost", evidenceIds: [segment.id], idempotencyKey: key("ghost-owner") })).rejects.toThrow(/authenticated workspace member/);
    await expect(engine.execute(owner, "insights", "source-register", { name: "Invalid owner", kind: "manual", ownerRef: "ghost", refreshCadence: "manual", idempotencyKey: key("ghost-source-owner") })).rejects.toThrow(/authenticated workspace member/);

    const course = first(await engine.execute(owner, "learning", "course-create", { title: "Private course", audience: "One learner", outcome: "Prove privacy", visibility: "private", idempotencyKey: key("private-course") }));
    const lesson = first(await engine.execute(owner, "learning", "lesson-create", { courseId: course.id, title: "Private lesson", content: "Private content", sourceRecordIds: [segment.id], position: 1, idempotencyKey: key("private-lesson") }));
    const rubric = first(await engine.execute(owner, "learning", "rubric-create", { courseId: course.id, name: "Private rubric", criteria: [{ key: "proof", weight: 100 }], passingScore: 80, idempotencyKey: key("private-rubric") }));
    await expect(engine.execute(owner, "learning", "learner-enroll", { courseId: course.id, learnerRef: "ghost", reason: "Invalid", idempotencyKey: key("ghost-learner") })).rejects.toThrow(/authenticated workspace member/);
    const enrollmentResult = await engine.execute(owner, "learning", "learner-enroll", { courseId: course.id, learnerRef: learnerId, reason: "Exact learner", idempotencyKey: key("private-enrollment") });
    const enrollment = first(enrollmentResult);
    const updatedCourse = enrollmentResult.records.find((record) => record.recordType === "learning-course")!;
    expect(enrollment.data.courseLearnerRefs).toEqual([learnerId]);
    expect(updatedCourse.data.learnerRefs).toEqual([learnerId]);
    const propagatedLesson = engine.getRecord(owner, lesson.id)!;
    const propagatedRubric = engine.getRecord(owner, rubric.id)!;
    expect(propagatedLesson).toMatchObject({ version: 2, data: { courseLearnerRefs: [learnerId] } });
    expect(propagatedRubric).toMatchObject({ version: 2, data: { courseLearnerRefs: [learnerId] } });
    expect(memberCanRead(updatedCourse, learnerId)).toBe(true);
    expect(memberCanRead(propagatedLesson, learnerId)).toBe(true);
    await expect(engine.execute(other, "learning", "attempt-record", { enrollmentId: enrollment.id, rubricId: rubric.id, score: 90, evidenceIds: [lesson.id], idempotencyKey: key("other-private-attempt") })).rejects.toThrow(/not found in this workspace/);
    const attempt = first(await engine.execute(learner, "learning", "attempt-record", { enrollmentId: enrollment.id, rubricId: rubric.id, score: 90, evidenceIds: [lesson.id], idempotencyKey: key("learner-private-attempt") }));
    expect(attempt.data).toMatchObject({ courseVisibility: "private", courseCreatedBy: actorId, courseLearnerRefs: [learnerId], learnerRef: learnerId });
    await expect(engine.execute(learner, "learning", "lesson-create", { courseId: course.id, title: "Impersonated authoring", content: "Blocked", sourceRecordIds: [lesson.id], position: 2, idempotencyKey: key("learner-course-admin") })).rejects.toThrow(/course creator/);

    const space = first(await engine.execute(owner, "community", "space-create", { key: "private", name: "Private space", purpose: "Exact membership", visibility: "private", policy: "Members only.", idempotencyKey: key("private-space") }));
    expect(space.data.createdBy).toBe(actorId);
    await expect(engine.execute(learner, "community", "member-add", { spaceId: space.id, memberRef: learnerId, displayName: "Learner", idempotencyKey: key("member-admin-block") })).rejects.toThrow(/admin role is required/);
    await engine.execute(owner, "community", "member-add", { spaceId: space.id, memberRef: actorId, displayName: "Owner", idempotencyKey: key("private-owner-member") });
    const post = first(await engine.execute(owner, "community", "post-create", { spaceId: space.id, authorRef: actorId, title: "Private post", body: "Private body", evidenceIds: [lesson.id], idempotencyKey: key("private-post") }));
    expect(post.data).toMatchObject({ spaceVisibility: "private", spaceCreatedBy: actorId, spaceMemberRefs: [actorId], authorRef: actorId });
    const learnerMemberResult = await engine.execute(owner, "community", "member-add", { spaceId: space.id, memberRef: learnerId, displayName: "Learner", idempotencyKey: key("private-learner-member") });
    const learnerMember = first(learnerMemberResult);
    const updatedSpace = learnerMemberResult.records.find((record) => record.recordType === "community-space")!;
    expect(learnerMember.data.spaceMemberRefs).toEqual(expect.arrayContaining([actorId, learnerId]));
    expect(updatedSpace.data.memberRefs).toEqual(expect.arrayContaining([actorId, learnerId]));
    const propagatedPost = engine.getRecord(owner, post.id)!;
    expect(propagatedPost).toMatchObject({ version: 2, data: { spaceMemberRefs: expect.arrayContaining([actorId, learnerId]) } });
    expect(memberCanRead(updatedSpace, learnerId)).toBe(true);
    expect(memberCanRead(propagatedPost, learnerId)).toBe(true);
    await expect(engine.execute(learner, "community", "post-create", { spaceId: space.id, authorRef: actorId, title: "Impersonation", body: "Blocked", evidenceIds: [post.id], idempotencyKey: key("community-impersonation") })).rejects.toThrow(/acting authenticated workspace member/);
    const reply = first(await engine.execute(learner, "community", "reply-create", { postId: post.id, authorRef: learnerId, body: "Attributed reply", evidenceIds: [post.id], idempotencyKey: key("private-reply") }));
    expect(reply.data).toMatchObject({ spaceVisibility: "private", spaceCreatedBy: actorId, spaceMemberRefs: expect.arrayContaining([actorId, learnerId]), authorRef: learnerId });

    const meetingProposal = first(await engine.execute(owner, "meetings", "summary-propose", { meetingId: meeting.id, goal: "Cite the restricted meeting.", evidenceIds: [segment.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("privacy-meeting-ai") }));
    const learningProposal = first(await engine.execute(owner, "learning", "feedback-propose", { attemptId: attempt.id, goal: "Cite the private attempt.", evidenceIds: [attempt.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("privacy-learning-ai") }));
    const communityProposal = first(await engine.execute(owner, "community", "digest-propose", { spaceId: space.id, audience: "Members", evidenceIds: [post.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("privacy-community-ai") }));
    expect(meetingProposal.data).toMatchObject({ meetingPrivacy: "restricted", meetingCreatedBy: actorId, meetingParticipantUserRefs: [learnerId] });
    expect(learningProposal.data).toMatchObject({ courseVisibility: "private", courseCreatedBy: actorId, courseLearnerRefs: [learnerId], learnerRef: learnerId });
    expect(communityProposal.data).toMatchObject({ spaceVisibility: "private", spaceCreatedBy: actorId, spaceMemberRefs: expect.arrayContaining([actorId, learnerId]) });
  });

  it("persists visibility membership snapshots for pre-existing children through fresh hosted evaluators", async () => {
    const store = new MemorySuiteStore("scale");
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.setWorkspacePlan(ownerId, "scale");
    await store.addWorkspaceMember(ownerId, memberId, "member");
    for (const moduleId of ["meetings", "learning", "community"] as const) await store.enableModule(ownerId, moduleId);
    const ownerAuthorization = { userId: ownerId, workspaceId: workspace.id, role: "owner" as const, scopes: ["*"] };
    const memberAuthorization = { userId: memberId, workspaceId: workspace.id, role: "member" as const, scopes: ["*"] };
    const executeAsOwner = (moduleId: "meetings" | "learning" | "community", actionId: string, input: Record<string, unknown>) => executeAdditiveBusinessActionWithStore(store, ownerAuthorization, moduleId, actionId, input, { now: () => new Date(clock), modelPolicyId: "local/grounded" });

    const meeting = first(await executeAsOwner("meetings", "meeting-create", { title: "Stored restricted meeting", purpose: "Persist participant visibility", startsAt: clock, privacy: "restricted", idempotencyKey: key("stored-visibility-meeting") }));
    const segment = first(await executeAsOwner("meetings", "transcript-append", { meetingId: meeting.id, speaker: ownerId, startMs: 0, endMs: 1_000, text: "Created before participant membership.", source: "manual", idempotencyKey: key("stored-visibility-segment") }));
    await executeAsOwner("meetings", "participant-add", { meetingId: meeting.id, displayName: "Member", role: "participant", userRef: memberId, idempotencyKey: key("stored-visibility-participant") });
    const storedMeeting = await store.getRecord(memberId, meeting.id);
    const storedSegment = await store.getRecord(memberId, segment.id);
    expect(storedMeeting?.data).toMatchObject({ record: { version: 2, data: { participantUserRefs: [memberId] } } });
    expect(storedSegment?.data).toMatchObject({ record: { version: 2, data: { meetingParticipantUserRefs: [memberId], recordedBy: ownerId, speakerRef: ownerId } } });
    const redacted = first(await executeAsOwner("meetings", "transcript-redact", { segmentId: segment.id, expectedVersion: 2, reason: "Verify membership survives an update", approval: approve(ownerId), dryRun: false, idempotencyKey: key("stored-visibility-redact") }));
    expect(redacted.data.meetingParticipantUserRefs).toEqual([memberId]);
    expect(await store.getRecord(memberId, segment.id)).toBeDefined();

    const course = first(await executeAsOwner("learning", "course-create", { title: "Stored private course", audience: "One member", outcome: "Persist learner visibility", visibility: "private", idempotencyKey: key("stored-visibility-course") }));
    const lesson = first(await executeAsOwner("learning", "lesson-create", { courseId: course.id, title: "Existing lesson", content: "Created before learner enrollment.", sourceRecordIds: [redacted.id], position: 1, idempotencyKey: key("stored-visibility-lesson") }));
    await executeAsOwner("learning", "learner-enroll", { courseId: course.id, learnerRef: memberId, reason: "Visibility regression", idempotencyKey: key("stored-visibility-enrollment") });
    expect((await store.getRecord(memberId, course.id))?.data).toMatchObject({ record: { version: 2, data: { learnerRefs: [memberId] } } });
    expect((await store.getRecord(memberId, lesson.id))?.data).toMatchObject({ record: { version: 2, data: { courseLearnerRefs: [memberId] } } });

    const space = first(await executeAsOwner("community", "space-create", { key: "stored-private", name: "Stored private space", purpose: "Persist member visibility", visibility: "private", policy: "Members only.", idempotencyKey: key("stored-visibility-space") }));
    await executeAsOwner("community", "member-add", { spaceId: space.id, memberRef: ownerId, displayName: "Owner", idempotencyKey: key("stored-visibility-owner-member") });
    const post = first(await executeAsOwner("community", "post-create", { spaceId: space.id, authorRef: ownerId, title: "Existing private post", body: "Created before the second member.", evidenceIds: [lesson.id], idempotencyKey: key("stored-visibility-post") }));
    const memberResult = await executeAsOwner("community", "member-add", { spaceId: space.id, memberRef: memberId, displayName: "Member", idempotencyKey: key("stored-visibility-member") });
    const communityMember = first(memberResult);
    const expectedSpaceMembers = expect.arrayContaining([ownerId, memberId]);
    expect((await store.getRecord(memberId, space.id))?.data).toMatchObject({ record: { version: 3, data: { memberRefs: expectedSpaceMembers } } });
    expect((await store.getRecord(memberId, post.id))?.data).toMatchObject({ record: { version: 2, data: { spaceMemberRefs: expectedSpaceMembers } } });
    const promoted = first(await executeAsOwner("community", "member-role-set", { memberId: communityMember.id, role: "moderator", expectedVersion: 1, reason: "Verify membership survives an update", approval: approve(ownerId), dryRun: false, idempotencyKey: key("stored-visibility-role") }));
    expect(promoted.data.spaceMemberRefs).toEqual(expect.arrayContaining([ownerId, memberId]));
    const reaction = first(await executeAdditiveBusinessActionWithStore(store, memberAuthorization, "community", "reaction-record", { postId: post.id, memberRef: memberId, reaction: "helpful", idempotencyKey: key("stored-visibility-reaction") }, { now: () => new Date(clock) }));
    const withdrawn = first(await executeAdditiveBusinessActionWithStore(store, memberAuthorization, "community", "reaction-record", { postId: post.id, memberRef: memberId, reaction: "withdraw", idempotencyKey: key("stored-visibility-reaction-withdraw") }, { now: () => new Date(clock) }));
    expect(withdrawn).toMatchObject({ id: reaction.id, state: "withdrawn", data: { spaceMemberRefs: expect.arrayContaining([ownerId, memberId]) } });
  });

  it("runs meetings, insights, learning, and community on one shared workspace graph", async () => {
    const engine = new AdditiveBusinessEngine();
    const ctx = context("scale");
    const meeting = first(await engine.execute(ctx, "meetings", "meeting-create", { title: "Launch review", purpose: "Choose a release window", startsAt: clock, privacy: "confidential", idempotencyKey: key("meeting") }));
    await engine.execute(ctx, "meetings", "participant-add", { meetingId: meeting.id, displayName: "Avery", role: "host", userRef: actorId, idempotencyKey: key("participant") });
    const segment = first(await engine.execute(ctx, "meetings", "transcript-append", { meetingId: meeting.id, speaker: "Avery", startMs: 0, endMs: 8000, text: "Tuesday after checks.", source: "local-transcription", idempotencyKey: key("segment") }));
    const decision = first(await engine.execute(ctx, "meetings", "decision-record", { meetingId: meeting.id, decision: "Launch Tuesday after final checks.", ownerRef: actorId, evidenceIds: [segment.id], idempotencyKey: key("decision") }));
    const actionItem = first(await engine.execute(ctx, "meetings", "action-item-create", { meetingId: meeting.id, title: "Complete final checks", ownerRef: actorId, dueAt: "2026-08-25T16:00:00.000Z", evidenceIds: [decision.id], idempotencyKey: key("meeting-action") }));
    expect(actionItem.data).toMatchObject({ createdBy: actorId, meetingParticipantUserRefs: [actorId] });
    const meetingExport = first(await engine.execute(ctx, "meetings", "meeting-export", { meetingId: meeting.id, includeTranscript: true, format: "canonical-json", idempotencyKey: key("meeting-export") }));
    expect(meetingExport).toMatchObject({ state: "immutable", data: { exportHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });

    const source = first(await engine.execute(ctx, "insights", "source-register", { name: "Launch metrics", kind: "manual", ownerRef: actorId, refreshCadence: "daily", idempotencyKey: key("source") }));
    const metric = first(await engine.execute(ctx, "insights", "metric-define", { sourceId: source.id, key: "activation", name: "Activation", unit: "users", aggregation: "sum", idempotencyKey: key("metric") }));
    const importInput = { metricId: metric.id, observations: [{ observedAt: clock, value: 42, dimensions: { cohort: "launch" } }], sourceRevision: "manual-2026-08-24", dryRun: false, idempotencyKey: key("observation") };
    await expect(engine.execute(ctx, "insights", "observation-import", importInput)).rejects.toThrow(/human approval/);
    const observation = first(await engine.execute(ctx, "insights", "observation-import", { ...importInput, approval: approve() }));
    const dashboard = first(await engine.execute(ctx, "insights", "dashboard-create", { name: "Launch health", purpose: "Review observed activation", audience: "Launch operators", idempotencyKey: key("dashboard") }));
    await engine.execute(ctx, "insights", "chart-add", { dashboardId: dashboard.id, metricId: metric.id, visualization: "line", window: "30d", idempotencyKey: key("chart") });
    const alert = first(await engine.execute(ctx, "insights", "alert-rule-create", { metricId: metric.id, operator: "lt", threshold: 25, cooldownMinutes: 1440, idempotencyKey: key("alert") }));
    expect(alert).toMatchObject({ state: "inert", data: { deliveryConfigured: false } });
    const snapshot = first(await engine.execute(ctx, "insights", "snapshot-freeze", { dashboardId: dashboard.id, asOf: clock, evidenceIds: [observation.id, decision.id], approval: approve(), dryRun: false, idempotencyKey: key("snapshot") }));
    expect(snapshot.data.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: decision.id, moduleId: "meetings" })]));

    const course = first(await engine.execute(ctx, "learning", "course-create", { title: "Release readiness", audience: "Launch operators", outcome: "Run every approved launch check", visibility: "workspace", idempotencyKey: key("course") }));
    const lesson = first(await engine.execute(ctx, "learning", "lesson-create", { courseId: course.id, title: "Reviewed launch decision", content: "Use the meeting ledger and metrics.", sourceRecordIds: [decision.id, snapshot.id], position: 1, idempotencyKey: key("lesson") }));
    const enrollment = first(await engine.execute(ctx, "learning", "learner-enroll", { courseId: course.id, learnerRef: actorId, reason: "Launch role onboarding", idempotencyKey: key("enrollment") }));
    const rubric = first(await engine.execute(ctx, "learning", "rubric-create", { courseId: course.id, name: "Readiness", criteria: [{ key: "evidence", weight: 100 }], passingScore: 80, idempotencyKey: key("rubric") }));
    const attempt = first(await engine.execute(ctx, "learning", "attempt-record", { enrollmentId: enrollment.id, rubricId: rubric.id, score: 90, evidenceIds: [lesson.id, decision.id], idempotencyKey: key("attempt") }));
    const credentialPreview = await engine.execute(ctx, "learning", "credential-preview", { enrollmentId: enrollment.id, attemptId: attempt.id });
    const credentialInput = { enrollmentId: enrollment.id, attemptId: attempt.id, previewHash: credentialPreview.preview!.previewHash, dryRun: false, idempotencyKey: key("credential") };
    await expect(engine.execute(ctx, "learning", "credential-issue", credentialInput)).rejects.toThrow(/human approval/);
    const credential = first(await engine.execute(ctx, "learning", "credential-issue", { ...credentialInput, approval: approve() }));
    expect(credential).toMatchObject({ state: "issued", data: { score: 90, passingScore: 80, eligible: true, issuedBy: actorId } });

    const space = first(await engine.execute(ctx, "community", "space-create", { key: "launch", name: "Launch customers", purpose: "Share reviewed launch facts", visibility: "workspace", policy: "Cite workspace evidence and be respectful.", idempotencyKey: key("space") }));
    const member = first(await engine.execute(ctx, "community", "member-add", { spaceId: space.id, memberRef: actorId, displayName: "Avery", idempotencyKey: key("member") }));
    const post = first(await engine.execute(ctx, "community", "post-create", { spaceId: space.id, authorRef: actorId, title: "Launch evidence", body: "The reviewed decision and metric are attached.", evidenceIds: [decision.id, snapshot.id], idempotencyKey: key("post") }));
    await engine.execute(ctx, "community", "reply-create", { postId: post.id, authorRef: actorId, body: "The learning credential is also available.", evidenceIds: [credential.id], idempotencyKey: key("reply") });
    await engine.execute(ctx, "community", "reaction-record", { postId: post.id, memberRef: actorId, reaction: "helpful", idempotencyKey: key("reaction") });
    const promoted = first(await engine.execute(ctx, "community", "member-role-set", { memberId: member.id, role: "moderator", expectedVersion: 1, reason: "Approved launch moderation", approval: approve(), dryRun: false, idempotencyKey: key("role") }));
    expect(promoted.data.role).toBe("moderator");
    const announcement = first(await engine.execute(ctx, "community", "announcement-publish", { spaceId: space.id, title: "Launch update", body: "Tuesday remains the reviewed target.", evidenceIds: [decision.id], approval: approve(), dryRun: false, idempotencyKey: key("announcement") }));
    expect(announcement).toMatchObject({ state: "published", data: { modelAuthored: false, exactCopyHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const hidden = first(await engine.execute(ctx, "community", "post-hide", { postId: post.id, expectedVersion: 1, reason: "Reviewed policy action", approval: approve(), dryRun: false, idempotencyKey: key("hide") }));
    expect(hidden).toMatchObject({ state: "hidden", data: { bodyPreserved: true } });
  });

  it("queues every AI endpoint as a grounded proposal with no result, side effect, or automatic mutation path", async () => {
    const engine = new AdditiveBusinessEngine();
    const ctx = context("scale");
    const table = await base(engine, ctx, "evidence");
    const meeting = first(await engine.execute(ctx, "meetings", "meeting-create", { title: "Evidence review", purpose: "Review exact evidence", startsAt: clock, privacy: "workspace", idempotencyKey: key("ai-meeting") }));
    const source = first(await engine.execute(ctx, "insights", "source-register", { name: "Metrics", kind: "manual", ownerRef: actorId, refreshCadence: "manual", idempotencyKey: key("ai-source") }));
    const metric = first(await engine.execute(ctx, "insights", "metric-define", { sourceId: source.id, key: "evidence-count", name: "Evidence count", unit: "records", aggregation: "count", idempotencyKey: key("ai-metric") }));
    const dashboard = first(await engine.execute(ctx, "insights", "dashboard-create", { name: "Evidence", purpose: "Review evidence counts", audience: "Operators", idempotencyKey: key("ai-dashboard") }));
    const snapshot = first(await engine.execute(ctx, "insights", "snapshot-freeze", { dashboardId: dashboard.id, asOf: clock, evidenceIds: [metric.id], approval: approve(), dryRun: false, idempotencyKey: key("ai-snapshot") }));
    const course = first(await engine.execute(ctx, "learning", "course-create", { title: "Evidence course", audience: "Operators", outcome: "Cite evidence", visibility: "workspace", idempotencyKey: key("ai-course") }));
    const enrollment = first(await engine.execute(ctx, "learning", "learner-enroll", { courseId: course.id, learnerRef: actorId, reason: "Evidence practice", idempotencyKey: key("ai-enroll") }));
    const rubric = first(await engine.execute(ctx, "learning", "rubric-create", { courseId: course.id, name: "Evidence", criteria: [{ key: "citations", weight: 100 }], passingScore: 80, idempotencyKey: key("ai-rubric") }));
    const attempt = first(await engine.execute(ctx, "learning", "attempt-record", { enrollmentId: enrollment.id, rubricId: rubric.id, score: 85, evidenceIds: [table.id], idempotencyKey: key("ai-attempt") }));
    const space = first(await engine.execute(ctx, "community", "space-create", { key: "evidence", name: "Evidence", purpose: "Discuss supported facts", visibility: "workspace", policy: "Cite records.", idempotencyKey: key("ai-space") }));
    await engine.execute(ctx, "community", "member-add", { spaceId: space.id, memberRef: actorId, displayName: "Avery", idempotencyKey: key("ai-member") });
    const post = first(await engine.execute(ctx, "community", "post-create", { spaceId: space.id, authorRef: actorId, title: "Evidence", body: "One supported fact.", evidenceIds: [table.id], idempotencyKey: key("ai-post") }));

    const inputs: Array<["tables" | "meetings" | "insights" | "learning" | "community", string, Record<string, unknown>]> = [
      ["tables", "schema-propose", { baseId: table.id, goal: "Propose a minimal schema.", evidenceIds: [table.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-table") }],
      ["meetings", "summary-propose", { meetingId: meeting.id, goal: "Summarize supported facts.", evidenceIds: [meeting.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-summary") }],
      ["meetings", "followup-propose", { meetingId: meeting.id, audience: "Participants", goal: "Draft cited follow-up copy.", evidenceIds: [meeting.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-followup") }],
      ["insights", "anomaly-propose", { metricId: metric.id, question: "Which measured changes deserve review?", evidenceIds: [metric.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-anomaly") }],
      ["insights", "narrative-propose", { snapshotId: snapshot.id, audience: "Operators", evidenceIds: [snapshot.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-narrative") }],
      ["learning", "feedback-propose", { attemptId: attempt.id, goal: "Propose rubric-grounded feedback.", evidenceIds: [attempt.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-feedback") }],
      ["learning", "path-propose", { enrollmentId: enrollment.id, goal: "Propose the next evidence-based lesson.", evidenceIds: [attempt.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-path") }],
      ["community", "moderation-propose", { spaceId: space.id, targetRecordId: post.id, question: "Which policy clauses may apply?", evidenceIds: [post.id, space.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-moderation") }],
      ["community", "digest-propose", { spaceId: space.id, audience: "Members", evidenceIds: [post.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-digest") }],
    ];

    for (const [moduleId, actionId, input] of inputs) {
      const queued = await engine.execute(ctx, moduleId, actionId, input);
      expect(queued).toMatchObject({ kind: "ai-proposal", audit: { decision: "queued", modelExecuted: false, automaticMutationAllowed: false, externalEffectExecuted: false } });
      expect(first(queued)).toMatchObject({ recordType: "ai-proposal-request", state: "queued", data: { modelPolicyId: "local/grounded", requestedModelId: "local/grounded", output: null, confidence: null, proposalOnly: true, automaticMutationAllowed: false, applyActionId: null, modelExecuted: false, fabricatedOutputAllowed: false, review: { status: "pending-model", required: true } } });
      expect(first(queued).data.evidenceBindings).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: expect.any(String), version: expect.any(Number), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
    }
    expect(engine.listRecords(ctx, { recordType: "ai-proposal-request" })).toHaveLength(9);

    const dry = await engine.execute(ctx, "tables", "schema-propose", { baseId: table.id, goal: "Preview only.", evidenceIds: [table.id], modelId: "local/grounded", dryRun: true, idempotencyKey: key("ai-dry") });
    expect(dry).toMatchObject({ records: [], preview: { modelInvoked: false, output: null, automaticMutationAllowed: false } });
    expect(engine.listRecords(ctx, { recordType: "ai-proposal-request" })).toHaveLength(9);

    const other = context("scale", randomUUID(), "other-owner");
    const otherBase = await base(engine, other, "private");
    await expect(engine.execute(ctx, "tables", "schema-propose", { baseId: table.id, goal: "Cross tenant", evidenceIds: [otherBase.id], modelId: "local/grounded", approval: approve(), dryRun: false, idempotencyKey: key("ai-cross-tenant") })).rejects.toThrow(/not found in this workspace/);
    await expect(engine.execute(ctx, "tables", "schema-propose", { baseId: table.id, goal: "Credential leak", evidenceIds: [table.id], modelId: "sk-secret-value", approval: approve(), dryRun: false, idempotencyKey: key("ai-secret") })).rejects.toThrow(/identifier, not a credential/);
  });

  it("persists hosted state, receipts, and queued AI work in SuiteStore rather than process memory", async () => {
    const existingDefinition = suiteModuleById.get("tables");
    const definition: SuiteModuleDefinition = {
      id: "tables",
      name: "SchemaDeck",
      inspiredBy: "Clean-room structured workspace data",
      category: "Structured data",
      description: "Governed schemas and typed rows.",
      minPlan: "starter",
      resourceClass: "shared",
      recordTypes: ["table-base", "table-field", "table-row", "table-view", "ai-proposal-request", "additive-command-receipt"],
      aiCapabilities: ["queue evidence-bound schema proposal"],
    };
    suiteModuleById.set("tables", definition);
    try {
      const store = new MemorySuiteStore("scale");
      const userId = randomUUID();
      const workspace = await store.getOrCreateWorkspace(userId);
      await store.enableModule(userId, "tables");
      await store.enableModule(userId, "crm");
      await store.enableModule(userId, "meetings");
      await store.enableModule(userId, "people");
      const crmRecord = await store.createRecord(userId, { moduleId: "crm", recordType: "account", title: "Tenant CRM account", state: "active", data: { version: 3, externalKey: "tenant-crm", name: "Northwind" } });
      if (!crmRecord) throw new Error("Expected the CRM fixture record.");
      const authorization = { userId, workspaceId: workspace.id, role: "owner" as const, scopes: ["*"] };
      const input = { key: "persistent", name: "Persistent", purpose: "Survive process restart", idempotencyKey: key("store-base") };
      const created = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "base-create", input, { now: () => new Date(clock) });
      expect(first(created).workspaceId).toBe(workspace.id);

      const commandReceiptLookup = vi.spyOn(store, "findCommandReceipt");
      const receiptWideScan = vi.spyOn(store, "listRecords");
      const replayedFromFreshEvaluator = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "base-create", input, { now: () => new Date(clock) });
      expect(first(replayedFromFreshEvaluator).id).toBe(first(created).id);
      expect(replayedFromFreshEvaluator.audit).toMatchObject({ replayed: true, receiptId: created.audit.receiptId });
      expect(commandReceiptLookup).toHaveBeenCalledWith(userId, { recordType: "additive-command-receipt", moduleId: "tables", actionId: "base-create", idempotencyKey: input.idempotencyKey });
      expect(receiptWideScan).not.toHaveBeenCalled();
      commandReceiptLookup.mockRestore();
      receiptWideScan.mockRestore();
      const stored = await store.listRecords(userId, { moduleId: "tables", limit: 100 });
      expect(stored.filter((record) => record.recordType === "table-base")).toHaveLength(1);
      expect(stored.filter((record) => record.recordType === "additive-command-receipt")).toHaveLength(1);
      expect(stored.find((record) => record.id === first(created).id)?.data).toMatchObject({ additiveContract: "additive-business-record.v1" });
      expect(await store.findCommandReceipt(userId, { recordType: "additive-command-receipt", moduleId: "tables", actionId: "base-create", idempotencyKey: input.idempotencyKey })).toMatchObject({ data: { approvalDecisionId: null } });
      const memberId = randomUUID();
      await store.addWorkspaceMember(userId, memberId, "member");
      const memberAuthorization = { userId: memberId, workspaceId: workspace.id, role: "member" as const, scopes: ["*"] };
      await expect(executeAdditiveBusinessActionWithStore(store, memberAuthorization, "tables", "base-create", input, { now: () => new Date(clock) })).rejects.toThrow(/bound to another workspace actor/);
      await expect(executeAdditiveBusinessActionWithStore(store, memberAuthorization, "tables", "schema-propose", { baseId: first(created).id, goal: "Must require admin", evidenceIds: [first(created).id], modelId: "local/grounded", approval: approve(memberId), dryRun: false, idempotencyKey: key("member-ai") }, { now: () => new Date(clock), modelPolicyId: "local/grounded" })).rejects.toThrow(/admin role is required/);
      const viewerId = randomUUID();
      await store.addWorkspaceMember(userId, viewerId, "viewer");
      await expect(executeAdditiveBusinessActionWithStore(store, { userId: viewerId, workspaceId: workspace.id, role: "viewer", scopes: ["tables:read"] }, "tables", "formula-evaluate", { baseId: first(created).id, operation: "count", fieldKey: "" }, { now: () => new Date(clock) })).resolves.toMatchObject({ kind: "read", preview: { value: 0 } });

      const extendedDecision = approve(userId, clock, "extended.global-approval-decision-0001");
      const extendedReceipt = await store.createRecord(userId, { moduleId: "people", recordType: "extended-business-command-receipt", title: "Foreign approval receipt", state: "committed", data: { actionId: "decide-leave", idempotencyKey: key("foreign-extended-receipt"), approvalDecisionId: extendedDecision.decisionId, resultSnapshot: { audit: { approvalDecisionId: extendedDecision.decisionId } } } });
      expect(extendedReceipt).toBeDefined();
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "schema-propose", { baseId: first(created).id, goal: "Reject a decision already consumed by another engine.", evidenceIds: [first(created).id], modelId: "local/grounded", approval: extendedDecision, dryRun: false, idempotencyKey: key("cross-engine-approval") }, { now: () => new Date(clock), modelPolicyId: "local/grounded" })).rejects.toThrow(/decision ID is already bound/);

      await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "field-add", { baseId: first(created).id, key: "payload", label: "Payload", fieldType: "text", required: false, idempotencyKey: key("store-payload-field") }, { now: () => new Date(clock) });
      await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "field-add", { baseId: first(created).id, key: "account", label: "Account", fieldType: "relation", required: false, idempotencyKey: key("store-account-field") }, { now: () => new Date(clock) });
      const singleUseApproval = approve(userId, clock, "tables.single-use-approval-decision-0001");
      const approvedRows = [{ payload: "approved" }];
      const approvedPreview = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "import-preview", { baseId: first(created).id, rows: approvedRows }, { now: () => new Date(clock) });
      const approvedApplyInput = { baseId: first(created).id, rows: approvedRows, previewHash: approvedPreview.preview!.previewHash, approval: singleUseApproval, dryRun: false, idempotencyKey: key("single-use-import") };
      await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "import-apply", approvedApplyInput, { now: () => new Date(clock) });
      expect(await store.findCommandReceipt(userId, { recordType: "additive-command-receipt", moduleId: "tables", actionId: "import-apply", idempotencyKey: approvedApplyInput.idempotencyKey })).toMatchObject({ data: { approvalDecisionId: singleUseApproval.decisionId, result: { audit: { approvalDecisionId: singleUseApproval.decisionId } } } });
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "import-apply", approvedApplyInput, { now: () => new Date(clock) })).resolves.toMatchObject({ audit: { replayed: true, decision: "replayed" } });
      const countBeforeDecisionReuse = (await store.listRecords(userId, { moduleId: "tables", limit: 100 })).length;
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "schema-propose", { baseId: first(created).id, goal: "Attempt to reuse an approval decision.", evidenceIds: [first(created).id], modelId: "local/grounded", approval: singleUseApproval, dryRun: false, idempotencyKey: key("single-use-ai-reuse") }, { now: () => new Date(clock), modelPolicyId: "local/grounded" })).rejects.toThrow(/decision ID is already bound/);
      expect((await store.listRecords(userId, { moduleId: "tables", limit: 100 })).length).toBe(countBeforeDecisionReuse);
      expect(await store.claimAiAction()).toBeUndefined();

      const approvalMeeting = first(await executeAdditiveBusinessActionWithStore(store, authorization, "meetings", "meeting-create", { title: "Approval reuse", purpose: "Reject cross-module reuse", startsAt: clock, privacy: "workspace", idempotencyKey: key("stored-approval-meeting") }, { now: () => new Date(clock) }));
      const approvalSegment = first(await executeAdditiveBusinessActionWithStore(store, authorization, "meetings", "transcript-append", { meetingId: approvalMeeting.id, speaker: userId, startMs: 0, endMs: 500, text: "Do not reuse approvals", source: "manual", idempotencyKey: key("stored-approval-segment") }, { now: () => new Date(clock) }));
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "meetings", "transcript-redact", { segmentId: approvalSegment.id, expectedVersion: 1, reason: "Must use another decision", dryRun: false, approval: singleUseApproval, idempotencyKey: key("stored-cross-module-approval") }, { now: () => new Date(clock) })).rejects.toThrow(/decision ID is already bound/);

      const privatePeerId = randomUUID();
      await store.addWorkspaceMember(userId, privatePeerId, "member");
      const privateLeave = await store.createRecord(userId, { moduleId: "people", recordType: "leave-request", title: "Private peer leave", state: "pending-human-decision", data: { subjectUserId: privatePeerId, managerRef: userId, note: "private" } });
      if (!privateLeave) throw new Error("Expected the private People fixture.");
      await expect(executeAdditiveBusinessActionWithStore(store, memberAuthorization, "tables", "row-create", { baseId: first(created).id, values: { payload: "must fail" }, sourceRecordIds: [privateLeave.id], idempotencyKey: key("hidden-evidence-member") }, { now: () => new Date(clock) })).rejects.toThrow(/evidence record was not found/);
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "row-create", { baseId: first(created).id, values: { payload: "owner-visible" }, sourceRecordIds: [privateLeave.id], idempotencyKey: key("hidden-evidence-owner") }, { now: () => new Date(clock) })).resolves.toMatchObject({ records: [expect.objectContaining({ recordType: "table-row" })] });
      const oversizedRows = [{ payload: "a".repeat(40_000) }, { payload: "b".repeat(40_000) }];
      const oversizedPreview = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "import-preview", { baseId: first(created).id, rows: oversizedRows }, { now: () => new Date(clock) });
      const recordsBeforeOversizedReceipt = await store.listRecords(userId, { moduleId: "tables", limit: 100 });
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "import-apply", { baseId: first(created).id, rows: oversizedRows, previewHash: oversizedPreview.preview!.previewHash, approval: approve(userId), dryRun: false, idempotencyKey: key("oversized-receipt") }, { now: () => new Date(clock) })).rejects.toThrow(/safe receipt snapshot ceiling/);
      const recordsAfterOversizedReceipt = await store.listRecords(userId, { moduleId: "tables", limit: 100 });
      expect(recordsAfterOversizedReceipt.map((record) => record.id)).toEqual(recordsBeforeOversizedReceipt.map((record) => record.id));
      const internalRecords = (store as unknown as { records: Map<string, SuiteRecord> }).records;
      for (let index = 0; index < 10_001; index += 1) {
        const id = randomUUID();
        internalRecords.set(id, { id, workspaceId: workspace.id, moduleId: "tables", recordType: "window-noise", title: `Newer record ${index}`, state: "active", data: {}, createdAt: `2099-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`, updatedAt: `2099-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z` });
      }
      expect((await store.listRecords(userId, { moduleId: "tables", limit: 10_000 })).map((record) => record.id)).not.toContain(first(created).id);
      const targetedLookup = vi.spyOn(store, "getRecord");
      const linkedInput = { baseId: first(created).id, values: { payload: "bounded", account: crmRecord.id }, sourceRecordIds: [crmRecord.id], idempotencyKey: key("store-crm-link") };
      const linkedRow = first(await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "row-create", linkedInput, { now: () => new Date(clock) }));
      expect(targetedLookup).toHaveBeenCalledWith(userId, first(created).id);
      expect(targetedLookup).toHaveBeenCalledWith(userId, crmRecord.id);
      expect(linkedRow.data.sourceBindings).toEqual([expect.objectContaining({ recordId: crmRecord.id, moduleId: "crm", recordType: "account", version: 3, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), readonlyExternal: true })]);
      targetedLookup.mockClear();
      const updatedLinkedRow = first(await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "row-update", { rowId: linkedRow.id, expectedVersion: 1, patch: { payload: "changed" }, idempotencyKey: key("store-relation-update") }, { now: () => new Date(clock) }));
      expect(targetedLookup).toHaveBeenCalledWith(userId, crmRecord.id);
      expect(updatedLinkedRow).toMatchObject({ version: 2, data: { values: { payload: "changed", account: crmRecord.id } } });
      targetedLookup.mockRestore();
      const immutableReplay = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "row-create", linkedInput, { now: () => new Date(clock) });
      expect(first(immutableReplay)).toMatchObject({ id: linkedRow.id, version: 1, data: { values: { payload: "bounded", account: crmRecord.id } } });
      expect(immutableReplay.audit).toMatchObject({ replayed: true, decision: "replayed" });

      const saturatedRowId = randomUUID();
      const saturatedValues: Record<string, string> = {};
      for (let index = 0; index <= 1_000; index += 1) {
        const fieldId = randomUUID();
        const relationId = randomUUID();
        const fieldKey = `relation_${index}`;
        saturatedValues[fieldKey] = relationId;
        const fieldRecord = { id: fieldId, workspaceId: workspace.id, moduleId: "tables" as const, recordType: "table-field", title: fieldKey, state: "active", version: 1, contentHash: "c".repeat(64), data: { baseId: first(created).id, key: fieldKey, fieldType: "relation", required: false }, createdAt: clock, updatedAt: clock };
        internalRecords.set(fieldId, { id: fieldId, workspaceId: workspace.id, moduleId: "tables", recordType: "table-field", title: fieldKey, state: "active", data: { additiveContract: "additive-business-record.v1", record: fieldRecord }, createdAt: clock, updatedAt: clock });
      }
      const saturatedRow = { id: saturatedRowId, workspaceId: workspace.id, moduleId: "tables" as const, recordType: "table-row", title: "Saturated relation row", state: "active", version: 1, contentHash: "d".repeat(64), data: { baseId: first(created).id, values: saturatedValues }, createdAt: clock, updatedAt: clock };
      internalRecords.set(saturatedRowId, { id: saturatedRowId, workspaceId: workspace.id, moduleId: "tables", recordType: "table-row", title: saturatedRow.title, state: "active", data: { additiveContract: "additive-business-record.v1", record: saturatedRow }, createdAt: clock, updatedAt: clock });
      const countBeforeRelationSaturation = internalRecords.size;
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "row-update", { rowId: saturatedRowId, expectedVersion: 1, patch: {}, idempotencyKey: key("stored-relation-saturation") }, { now: () => new Date(clock) })).rejects.toThrow(/more than 1000 relation records/);
      expect(internalRecords.size).toBe(countBeforeRelationSaturation);

      const queueAiAction = vi.spyOn(store, "queueAiAction");
      const mismatchedModelKey = key("store-ai-model-mismatch");
      const recordsBeforeModelMismatch = await store.listRecords(userId, { moduleId: "tables", limit: 100_000 });
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "schema-propose", { baseId: first(created).id, goal: "Reject an untrusted caller-selected model.", evidenceIds: [first(created).id], modelId: "caller-selected-model", approval: { ...approve(), approvedBy: userId }, dryRun: false, idempotencyKey: mismatchedModelKey }, { now: () => new Date(clock), modelPolicyId: "local/grounded" })).rejects.toThrow(/workspace-configured model policy/);
      expect(queueAiAction).not.toHaveBeenCalled();
      expect((await store.listRecords(userId, { moduleId: "tables", limit: 100_000 })).map((record) => record.id)).toEqual(recordsBeforeModelMismatch.map((record) => record.id));
      await expect(store.findCommandReceipt(userId, { recordType: "additive-command-receipt", moduleId: "tables", actionId: "schema-propose", idempotencyKey: mismatchedModelKey })).resolves.toBeUndefined();

      const queued = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "schema-propose", { baseId: first(created).id, goal: "Propose one cited field.", evidenceIds: [first(created).id], approval: { ...approve(), approvedBy: userId }, dryRun: false, idempotencyKey: key("store-ai") }, { now: () => new Date(clock), modelPolicyId: "local/grounded" });
      expect(first(queued)).toMatchObject({ recordType: "ai-proposal-request", data: { queuedActionId: expect.any(String), modelPolicyId: "local/grounded", requestedModelId: "local/grounded", output: null, automaticMutationAllowed: false } });
      expect(queueAiAction).toHaveBeenCalledOnce();
      const claimed = await store.claimAiAction();
      expect(claimed?.action).toMatchObject({ moduleId: "tables", context: { requestRecordId: first(queued).id, modelPolicyId: "local/grounded", requestedModelId: "local/grounded", proposalOnly: true, automaticMutationAllowed: false } });
      expect(claimed?.records.map((record) => record.id)).toContain(first(created).id);

      const outsiderId = randomUUID();
      const outsiderWorkspace = await store.getOrCreateWorkspace(outsiderId);
      await store.enableModule(outsiderId, "tables");
      await expect(executeAdditiveBusinessActionWithStore(store, { userId: outsiderId, workspaceId: outsiderWorkspace.id, role: "owner", scopes: ["*"] }, "tables", "row-create", { baseId: first(created).id, values: {}, sourceRecordIds: [], idempotencyKey: key("store-cross-tenant") })).rejects.toThrow(/not found in this workspace/);
      const outsiderBase = first(await executeAdditiveBusinessActionWithStore(store, { userId: outsiderId, workspaceId: outsiderWorkspace.id, role: "owner", scopes: ["*"] }, "tables", "base-create", { key: "outsider", name: "Outsider", purpose: "Prove evidence isolation", idempotencyKey: key("outsider-base") }));
      await expect(executeAdditiveBusinessActionWithStore(store, { userId: outsiderId, workspaceId: outsiderWorkspace.id, role: "owner", scopes: ["*"] }, "tables", "row-create", { baseId: outsiderBase.id, values: {}, sourceRecordIds: [crmRecord.id], idempotencyKey: key("store-cross-evidence") })).rejects.toThrow(/evidence record was not found in this workspace/);

      const overflowRecord = internalRecords.get(first(created).id)!;
      const boundedList = vi.spyOn(store, "listRecords").mockResolvedValueOnce(Array(additiveBusinessModuleSnapshotLimit + 1).fill(overflowRecord));
      const countBeforeOverflow = internalRecords.size;
      await expect(executeAdditiveBusinessActionWithStore(store, authorization, "tables", "base-create", { key: "must-fail-closed", name: "Must fail", purpose: "No silent truncation", idempotencyKey: key("overflow") })).rejects.toThrow(/does not provide paginated additive snapshots/);
      expect(internalRecords.size).toBe(countBeforeOverflow);
      boundedList.mockRestore();
    }
    finally {
      if (existingDefinition) suiteModuleById.set("tables", existingDefinition);
      else suiteModuleById.delete("tables");
    }
  });
});
