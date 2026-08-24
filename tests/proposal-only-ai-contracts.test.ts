import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/server/config.js";
import { executeAdditiveBusinessActionWithStore } from "../src/server/additive-business-engine.js";
import { aiResultContractVersion, canonicalJsonSha256, canonicalJsonText, proposalOnlySnapshotHash, validateProposalOnlyAiJob, validateProposalOnlyAiResult } from "../src/server/ai-result.js";
import { PostgresSuiteStore, MemorySuiteStore, type SuiteStore } from "../src/server/suite-store.js";
import { additiveWaveTwoAction } from "../src/shared/extended-business-actions.js";
import type { SuiteAiAction, SuiteRecord } from "../src/shared/suite.js";

const fixedNow = "2026-08-24T18:00:00.000Z";
const modelId = config.AI_MODEL;
const canonicalJsonAcceptanceVectors = [
  {
    name: "mixed-case Unicode strings and structural JSON",
    value: {
      Zoo: [true, false, null, "line\n\"quote\"\\slash", { beta: "mañana", Alpha: "東京", "é": "café", "é": "decomposed" }],
      zebra: null,
      "ångström": "🧪",
    },
    hash: "0b73476fed9a6b27d7abbfc33313c590ef68e942a12fe42b96decc13aacbe20d",
  },
  {
    name: "finite exponent-range numbers",
    value: [0, -0, 1, -12.5, 1e-7, 1e21, 5e-324, 1.7976931348623157e308, 9_007_199_254_740_991, 0.000001, 1.2345e30],
    hash: "3619a7a9683d81af9a6628db1be6c485418165050b5ee4ccee1560894df36e5f",
  },
  {
    name: "UTF-8 byte ordering and empty containers",
    value: { z: "last", A: "first", a: "second", Ω: "omega", "😀": "face", nested: [[], {}, true, false, null] },
    hash: "1b7ef00ef268bd05dab8d336107765e6c56b9a520ca86f6e39e2550d77d7fa4c",
  },
] as const;

function result(version: "additive-business-proposal.v1" | "extended-business-proposal.v1", evidence: string[]) {
  return {
    version,
    proposal: "A bounded, evidence-cited proposal for human review.",
    evidence,
    confidence: 0.81,
    assumptions: ["The reviewer will confirm that the selected evidence remains applicable."],
    model: modelId,
    reviewStatus: "pending-human-review" as const,
    approvalRequired: true as const,
    proposalOnly: true as const,
    automaticMutationAllowed: false as const,
    externalEffectAllowed: false as const,
  };
}

function expectValidAdditiveEnvelopeHash(record: SuiteRecord) {
  const nested = record.data.record as Record<string, unknown>;
  const data = nested.data as Record<string, unknown>;
  expect(nested.contentHash).toBe(proposalOnlySnapshotHash({
    moduleId: nested.moduleId,
    recordType: nested.recordType,
    title: nested.title,
    state: nested.state,
    version: nested.version,
    data,
  }));
  return { nested, data };
}

async function additiveFixture(store: SuiteStore, userId: string, label: string) {
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.setWorkspacePlan(userId, "fleet");
  await store.enableModule(userId, "tables");
  const authorization = { userId, workspaceId: workspace.id, role: "owner" as const, scopes: ["*"] };
  const nonce = randomUUID();
  const created = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "base-create", {
    key: `${label}-${nonce}`,
    name: `${label} proposal evidence`,
    purpose: "Verify the exact proposal audit envelope hash boundary.",
    idempotencyKey: `base.${label}.${nonce}`,
  }, { now: () => new Date(fixedNow), modelPolicyId: modelId });
  const target = created.records[0]!;
  const proposal = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "schema-propose", {
    baseId: target.id,
    goal: "Propose one cited field without applying it.",
    evidenceIds: [target.id],
    modelId,
    approval: { approved: true, approvedBy: userId, approvedAt: fixedNow, decisionId: `schema.${label}.${nonce}`, reason: "Reviewed the exact proposal-only model request." },
    dryRun: false,
    idempotencyKey: `schema.${label}.${nonce}`,
  }, { now: () => new Date(fixedNow), modelPolicyId: modelId });
  const audit = proposal.records[0]!;
  const storedAudit = await store.getRecord(userId, audit.id);
  if (!storedAudit) throw new Error("Expected the additive proposal audit record.");
  const nestedData = (storedAudit.data.record as Record<string, unknown>).data as Record<string, unknown>;
  const queuedActionId = String(nestedData.queuedActionId);
  const queued = await store.getAiAction(userId, queuedActionId);
  if (!queued) throw new Error("Expected the additive proposal AI action.");
  return { workspace, target, audit, storedAudit, queued };
}

async function extendedFixture(store: SuiteStore, userId: string) {
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.setWorkspacePlan(userId, "fleet");
  await store.enableModule(userId, "events");
  await store.enableModule(userId, "crm");
  const target = await store.createRecord(userId, { moduleId: "events", recordType: "event", title: "Evidence review", state: "draft", data: { version: 1, purpose: "Review selected evidence" } });
  const evidence = await store.createRecord(userId, { moduleId: "crm", recordType: "account", title: "Versionless evidence", state: "active", data: { externalKey: randomUUID() } });
  if (!target || !evidence) throw new Error("Expected extended proposal fixtures.");
  const action = additiveWaveTwoAction("events", "summarize");
  if (!action?.promptId || !action.promptVersion) throw new Error("Expected the extended proposal action contract.");
  const evidenceBindings = [{ recordId: evidence.id, moduleId: evidence.moduleId, recordType: evidence.recordType, version: 1, snapshotHash: proposalOnlySnapshotHash(evidence) }];
  const auditData = {
    actionId: action.id,
    promptId: action.promptId,
    promptVersion: action.promptVersion,
    modelPolicyId: modelId,
    requestedModelId: modelId,
    evidenceIds: [evidence.id],
    evidenceBindings,
    targetRecordId: target.id,
    targetVersion: 1,
    targetSnapshotHash: proposalOnlySnapshotHash(target),
    proposalOnly: true,
    automaticMutationAllowed: false,
    externalEffectAllowed: false,
    reviewStatus: "pending-model",
    requestedAt: fixedNow,
  };
  const audit = await store.createRecord(userId, { moduleId: "events", recordType: "ai-proposal-request", title: action.title, state: "queued", data: auditData });
  if (!audit) throw new Error("Expected the extended proposal audit.");
  const queued = await store.queueAiAction(userId, {
    moduleId: "events",
    goal: "Summarize the selected evidence without executing any effect.",
    context: {
      actionId: action.id,
      promptId: action.promptId,
      promptVersion: action.promptVersion,
      modelPolicyId: modelId,
      requestedModelId: modelId,
      evidenceIds: [evidence.id],
      evidenceBindings,
      targetRecordId: target.id,
      targetVersion: 1,
      targetSnapshotHash: proposalOnlySnapshotHash(target),
      aiAuditRecordId: audit.id,
      resultContract: { version: "extended-business-proposal.v1", reviewStatus: "pending-human-review", approvalRequired: true },
    },
  });
  if (!queued) throw new Error("Expected the extended proposal action.");
  return { workspace, target, evidence, audit, queued };
}

describe("additive and extended proposal-only AI contracts", () => {
  it("implements the fixed canonical JSON v1 acceptance vectors and rejects values outside the shared JSONB domain", () => {
    for (const vector of canonicalJsonAcceptanceVectors) {
      expect(proposalOnlySnapshotHash(vector.value), vector.name).toBe(vector.hash);
      expect(canonicalJsonText(vector.value), vector.name).toMatch(/^managed-oss-canonical-json\.v1\|/);
    }
    expect(proposalOnlySnapshotHash({ a: 1, B: 2, optional: undefined })).toBe(proposalOnlySnapshotHash({ B: 2, a: 1 }));
    expect(proposalOnlySnapshotHash("é")).not.toBe(proposalOnlySnapshotHash("é"));
    expect(() => proposalOnlySnapshotHash({ invalid: Number.NaN })).toThrow(/non-finite/);
    expect(() => proposalOnlySnapshotHash([, true])).toThrow(/dense/);
    expect(() => proposalOnlySnapshotHash("contains\0nul")).toThrow(/U\+0000/);
    expect(() => proposalOnlySnapshotHash("\ud800")).toThrow(/unpaired/);
    expect(() => proposalOnlySnapshotHash(new Date(fixedNow))).toThrow(/plain JSON object/);
  });

  it("rejects unknown contract versions and keeps the model result schema exact and citation-unique", () => {
    expect(() => aiResultContractVersion({ resultContract: { version: "unreviewed-proposal.v9" } })).toThrow(/unknown or invalid/);
    expect(() => aiResultContractVersion({ resultContract: {} })).toThrow(/unknown or invalid/);
    const evidenceId = randomUUID();
    expect(() => validateProposalOnlyAiResult({ ...result("extended-business-proposal.v1", [evidenceId]), unexpected: true }, { version: "extended-business-proposal.v1", allowedRecordIds: [evidenceId] })).toThrow();
    expect(() => validateProposalOnlyAiResult(result("extended-business-proposal.v1", [evidenceId, evidenceId]), { version: "extended-business-proposal.v1", allowedRecordIds: [evidenceId] })).toThrow(/at most once/);
  });

  it("loads the separate additive audit, verifies every binding, and atomically records pending human review", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    const workspace = await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "tables");
    const authorization = { userId, workspaceId: workspace.id, role: "owner" as const, scopes: ["*"] };
    const created = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "base-create", { key: "proposal-evidence", name: "Proposal evidence", purpose: "Hold exact proposal evidence", idempotencyKey: "base.proposal-only.0001" }, { now: () => new Date(fixedNow) });
    const target = created.records[0]!;
    const queued = await executeAdditiveBusinessActionWithStore(store, authorization, "tables", "schema-propose", {
      baseId: target.id,
      goal: "Propose one evidence-cited field.",
      evidenceIds: [target.id],
      modelId,
      approval: { approved: true, approvedBy: userId, approvedAt: fixedNow, decisionId: "schema.proposal.approval.0001", reason: "Reviewed the exact proposal-only model request." },
      dryRun: false,
      idempotencyKey: "schema.proposal-only.0001",
    }, { now: () => new Date(fixedNow), modelPolicyId: modelId });
    const request = queued.records[0]!;
    const prompt = request.data.prompt as Record<string, unknown>;
    const promptBoundary = { id: prompt.id, version: prompt.version, invariant: "Evidence-bound proposals only. Never apply a mutation, send, publish, moderate, score, credential, or alter records." };
    expect(prompt.digest).toBe(canonicalJsonSha256(promptBoundary));
    const worker = readFileSync("src/server/ai-worker.ts", "utf8");
    expect(worker).toContain("const expectedPromptDigest = canonicalJsonSha256(");
    const claim = await store.claimAiAction();
    expect(claim?.records.map((record) => record.id)).toEqual(expect.arrayContaining([target.id, request.id]));
    const boundary = validateProposalOnlyAiJob(claim!.action, claim!.records, modelId);
    expect(boundary.modelRecords.map((record) => record.id)).toEqual([target.id]);
    expect(boundary.modelRecords.map((record) => record.id)).not.toContain(request.id);
    expect(await store.completeAiAction(claim!.action.id, { status: "completed", result: result("additive-business-proposal.v1", [target.id]) })).toBe(true);
    const transitioned = await store.getRecord(userId, request.id);
    if (!transitioned) throw new Error("Expected the transitioned additive proposal audit.");
    const { nested, data: nestedData } = expectValidAdditiveEnvelopeHash(transitioned);
    expect(transitioned).toMatchObject({ state: "pending-human-review" });
    expect(nested).toMatchObject({ state: "pending-human-review" });
    expect(nested.contentHash).not.toBe(request.contentHash);
    expect(nestedData).toMatchObject({ output: expect.any(String), citedEvidenceIds: [target.id], executedModel: modelId, modelExecuted: true, automaticMutationAllowed: false, externalEffectAllowed: false, review: { status: "pending-human-review", required: true } });
    expect(await store.getRecord(userId, target.id)).toMatchObject({ state: target.state, data: { record: { contentHash: target.contentHash } } });
  });

  it("rehashes additive model failures and rejects a tampered queued audit payload in memory", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    const failed = await additiveFixture(store, userId, "memory-failure");
    const failureClaim = await store.claimAiAction();
    expect(failureClaim?.action.id).toBe(failed.queued.id);
    expect(await store.completeAiAction(failed.queued.id, { status: "failed", result: { error: "The bounded proposal model failed." } })).toBe(true);
    const transitioned = await store.getRecord(userId, failed.audit.id);
    if (!transitioned) throw new Error("Expected the failed additive proposal audit.");
    const { nested, data } = expectValidAdditiveEnvelopeHash(transitioned);
    expect(transitioned.state).toBe("model-failed");
    expect(nested).toMatchObject({ state: "model-failed" });
    expect(nested.contentHash).not.toBe(failed.audit.contentHash);
    expect(data).toMatchObject({ modelError: "The bounded proposal model failed.", modelCompleted: false, review: { status: "model-failed", required: true } });

    const tampered = await additiveFixture(store, userId, "memory-tamper");
    const tamperedClaim = await store.claimAiAction();
    expect(tamperedClaim?.action.id).toBe(tampered.queued.id);
    const tamperedPayload = structuredClone(tampered.storedAudit.data);
    const tamperedNested = tamperedPayload.record as Record<string, unknown>;
    const tamperedNestedData = tamperedNested.data as Record<string, unknown>;
    tamperedNestedData.goal = "A payload changed without replacing its exact canonical content hash.";
    expect(await store.updateRecord(userId, tampered.audit.id, { data: tamperedPayload })).toBeDefined();
    await expect(store.completeAiAction(tampered.queued.id, { status: "failed", result: { error: "Do not transition a tampered request." } })).rejects.toThrow(/content hash is invalid/);
    expect(await store.getAiAction(userId, tampered.queued.id)).toMatchObject({ status: "running" });
    expect(await store.getRecord(userId, tampered.audit.id)).toMatchObject({ state: "queued", data: { record: { state: "queued", contentHash: tampered.audit.contentHash } } });
  });

  it("normalizes versionless evidence to version one, detects later drift, and atomically records model failure", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    const fixture = await extendedFixture(store, userId);
    const claim = await store.claimAiAction();
    expect(claim?.action.id).toBe(fixture.queued.id);
    expect(claim?.records.map((record) => record.id)).toEqual(expect.arrayContaining([fixture.target.id, fixture.evidence.id, fixture.audit.id]));
    expect((claim!.action.context.evidenceBindings as Array<Record<string, unknown>>)[0]).toMatchObject({ recordId: fixture.evidence.id, version: 1 });
    expect(validateProposalOnlyAiJob(claim!.action, claim!.records, modelId).modelRecords.map((record) => record.id)).toEqual([fixture.target.id, fixture.evidence.id]);

    await store.updateRecord(userId, fixture.evidence.id, { data: { observedChange: true } });
    const changed = await store.getRecord(userId, fixture.evidence.id);
    const currentRecords = claim!.records.map((record) => record.id === fixture.evidence.id ? changed! : record);
    expect(() => validateProposalOnlyAiJob(claim!.action, currentRecords, modelId)).toThrow(/changed/);
    await expect(store.completeAiAction(claim!.action.id, { status: "completed", result: result("extended-business-proposal.v1", [fixture.target.id, fixture.evidence.id]) })).rejects.toThrow(/changed/);
    const stillRunning = await store.getAiAction(userId, claim!.action.id);
    expect(stillRunning).toMatchObject({ status: "running" });
    expect(stillRunning?.result).toBeUndefined();
    expect(await store.getRecord(userId, fixture.audit.id)).toMatchObject({ state: "queued", data: { reviewStatus: "pending-model" } });
    expect(await store.completeAiAction(claim!.action.id, { status: "failed", result: { error: "Selected evidence changed after authorization." } })).toBe(true);
    expect(await store.getRecord(userId, fixture.audit.id)).toMatchObject({ state: "model-failed", data: { reviewStatus: "model-failed", automaticMutationAllowed: false, externalEffectAllowed: false, modelCompleted: false } });
  });

  it("requires both configured extended model fields and atomically stores a strict proposal without changing its target", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    const fixture = await extendedFixture(store, userId);
    const claim = await store.claimAiAction();
    const mismatched: SuiteAiAction = { ...claim!.action, context: { ...claim!.action.context, requestedModelId: "another/model" } };
    const mismatchedRecords = claim!.records.map((record) => record.id === fixture.audit.id ? { ...record, data: { ...record.data, requestedModelId: "another/model" } } : record);
    expect(() => validateProposalOnlyAiJob(mismatched, mismatchedRecords, modelId)).toThrow(/configured proposal model field/);
    const completion = result("extended-business-proposal.v1", [fixture.target.id, fixture.evidence.id]);
    expect(await store.completeAiAction(claim!.action.id, { status: "completed", result: completion })).toBe(true);
    expect(await store.getRecord(userId, fixture.audit.id)).toMatchObject({ state: "pending-human-review", data: { proposal: completion.proposal, evidence: completion.evidence, executedModel: modelId, reviewStatus: "pending-human-review", approvalRequired: true, proposalOnly: true, automaticMutationAllowed: false, externalEffectAllowed: false, modelExecuted: true } });
    expect(await store.getRecord(userId, fixture.target.id)).toEqual(fixture.target);
  });

  it("rejects a same-ID binding when the claimed record belongs to another tenant", async () => {
    const store = new MemorySuiteStore("fleet");
    const fixture = await extendedFixture(store, randomUUID());
    const claim = await store.claimAiAction();
    const forged = claim!.records.map((record) => record.id === fixture.evidence.id ? { ...record, workspaceId: randomUUID() } : record) as SuiteRecord[];
    expect(() => validateProposalOnlyAiJob(claim!.action, forged, modelId)).toThrow(/exact tenant/);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL proposal-only AI completion v4", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false });
  const store = new PostgresSuiteStore(databaseUrl, false);
  const userId = randomUUID();

  beforeAll(async () => {
    await store.initialize();
    await pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$2,'unused')", [userId, `proposal-${randomUUID()}@example.com`]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await store.close();
    await pool.end();
  });

  it("matches PostgreSQL 17 canonical JSON text and SHA-256 to every Node acceptance vector", async () => {
    const serverVersion = await pool.query<{ server_version_num: string }>("SELECT pg_catalog.current_setting('server_version_num') AS server_version_num");
    expect(Number(serverVersion.rows[0].server_version_num)).toBeGreaterThanOrEqual(170_000);
    for (const vector of canonicalJsonAcceptanceVectors) {
      const result = await pool.query<{ canonical: string; hash: string }>(`SELECT public.managed_oss_canonical_jsonb($1::JSONB) AS canonical,
        pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb($1::JSONB),'UTF8'),'sha256'),'hex') AS hash`, [JSON.stringify(vector.value)]);
      expect(result.rows[0].canonical, vector.name).toBe(canonicalJsonText(vector.value));
      expect(result.rows[0].hash, vector.name).toBe(vector.hash);
    }
  });

  it("commits the action and separate audit together and rolls both back for an extra result field", async () => {
    const valid = await extendedFixture(store, userId);
    await pool.query("UPDATE suite_ai_actions SET status='running',lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE id=$1", [valid.queued.id]);
    expect(await store.completeAiAction(valid.queued.id, { status: "completed", result: result("extended-business-proposal.v1", [valid.target.id, valid.evidence.id]) })).toBe(true);
    expect((await pool.query("SELECT status FROM suite_ai_actions WHERE id=$1", [valid.queued.id])).rows[0]).toEqual({ status: "completed" });
    expect((await pool.query("SELECT state,data->>'reviewStatus' review_status,data->>'executedModel' model FROM suite_records WHERE id=$1", [valid.audit.id])).rows[0]).toEqual({ state: "pending-human-review", review_status: "pending-human-review", model: modelId });

    const invalid = await extendedFixture(store, userId);
    await pool.query("UPDATE suite_ai_actions SET status='running',lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE id=$1", [invalid.queued.id]);
    await expect(store.completeAiAction(invalid.queued.id, { status: "completed", result: { ...result("extended-business-proposal.v1", [invalid.evidence.id]), unsafe: true } })).rejects.toThrow(/trusted result contract/);
    expect((await pool.query("SELECT status,result FROM suite_ai_actions WHERE id=$1", [invalid.queued.id])).rows[0]).toEqual({ status: "running", result: null });
    expect((await pool.query("SELECT state,data->>'reviewStatus' review_status FROM suite_records WHERE id=$1", [invalid.audit.id])).rows[0]).toEqual({ state: "queued", review_status: "pending-model" });

    const drifted = await extendedFixture(store, userId);
    await store.updateRecord(userId, drifted.evidence.id, { data: { changedAfterClaim: true } });
    await pool.query("UPDATE suite_ai_actions SET status='running',lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE id=$1", [drifted.queued.id]);
    await expect(store.completeAiAction(drifted.queued.id, { status: "completed", result: result("extended-business-proposal.v1", [drifted.target.id, drifted.evidence.id]) })).rejects.toThrow(/version or hash changed/);
    expect((await pool.query("SELECT status,result FROM suite_ai_actions WHERE id=$1", [drifted.queued.id])).rows[0]).toEqual({ status: "running", result: null });
    expect((await pool.query("SELECT state,data->>'reviewStatus' review_status FROM suite_records WHERE id=$1", [drifted.audit.id])).rows[0]).toEqual({ state: "queued", review_status: "pending-model" });

    const missingVersionActionId = randomUUID();
    await pool.query("INSERT INTO suite_ai_actions(id,workspace_id,module_id,goal,context,status,lease_expires_at) VALUES($1,$2,'events','Reject a versionless result contract',$3::JSONB,'running',NOW()+INTERVAL '5 minutes')", [missingVersionActionId, valid.workspace.id, JSON.stringify({ resultContract: {} })]);
    await expect(store.completeAiAction(missingVersionActionId, { status: "completed", result: result("extended-business-proposal.v1", [valid.evidence.id]) })).rejects.toThrow(/unknown or invalid AI result contract version/);
    expect((await pool.query("SELECT status,result FROM suite_ai_actions WHERE id=$1", [missingVersionActionId])).rows[0]).toEqual({ status: "running", result: null });
  });

  it("rehashes additive success and failure transitions and rejects a tampered queued audit payload in PostgreSQL 17", async () => {
    const expectPostgresEnvelopeHash = async (recordId: string) => {
      const checked = await pool.query<{ content_hash: string; expected_hash: string }>(`SELECT
        data->'record'->>'contentHash' AS content_hash,
        pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(pg_catalog.jsonb_build_object(
          'moduleId',data->'record'->'moduleId','recordType',data->'record'->'recordType','title',data->'record'->'title',
          'state',data->'record'->'state','version',data->'record'->'version','data',data->'record'->'data'
        )),'UTF8'),'sha256'),'hex') AS expected_hash
        FROM suite_records WHERE id=$1`, [recordId]);
      expect(checked.rows[0].content_hash).toBe(checked.rows[0].expected_hash);
    };

    const succeeded = await additiveFixture(store, userId, "postgres-success");
    await pool.query("UPDATE suite_ai_actions SET status='running',lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE id=$1", [succeeded.queued.id]);
    expect(await store.completeAiAction(succeeded.queued.id, { status: "completed", result: result("additive-business-proposal.v1", [succeeded.target.id]) })).toBe(true);
    expect((await pool.query("SELECT state,data->'record'->>'state' nested_state,data->'record'->'data'->>'executedModel' model FROM suite_records WHERE id=$1", [succeeded.audit.id])).rows[0]).toEqual({ state: "pending-human-review", nested_state: "pending-human-review", model: modelId });
    await expectPostgresEnvelopeHash(succeeded.audit.id);
    const succeededAudit = await store.getRecord(userId, succeeded.audit.id);
    if (!succeededAudit) throw new Error("Expected the successful PostgreSQL additive audit.");
    expectValidAdditiveEnvelopeHash(succeededAudit);

    const failed = await additiveFixture(store, userId, "postgres-failure");
    await pool.query("UPDATE suite_ai_actions SET status='running',lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE id=$1", [failed.queued.id]);
    expect(await store.completeAiAction(failed.queued.id, { status: "failed", result: { error: "The PostgreSQL proposal model failed." } })).toBe(true);
    expect((await pool.query("SELECT state,data->'record'->>'state' nested_state,data->'record'->'data'->>'modelError' model_error FROM suite_records WHERE id=$1", [failed.audit.id])).rows[0]).toEqual({ state: "model-failed", nested_state: "model-failed", model_error: "The PostgreSQL proposal model failed." });
    await expectPostgresEnvelopeHash(failed.audit.id);
    const failedAudit = await store.getRecord(userId, failed.audit.id);
    if (!failedAudit) throw new Error("Expected the failed PostgreSQL additive audit.");
    expectValidAdditiveEnvelopeHash(failedAudit);

    const tampered = await additiveFixture(store, userId, "postgres-tamper");
    await pool.query("UPDATE suite_ai_actions SET status='running',lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE id=$1", [tampered.queued.id]);
    await pool.query("UPDATE suite_records SET data=pg_catalog.jsonb_set(data,'{record,data,goal}',pg_catalog.to_jsonb($2::TEXT),FALSE) WHERE id=$1", [tampered.audit.id, "A payload changed without replacing its exact canonical content hash."]);
    await expect(store.completeAiAction(tampered.queued.id, { status: "failed", result: { error: "Do not transition a tampered request." } })).rejects.toThrow(/content hash is invalid/);
    expect((await pool.query("SELECT status,result FROM suite_ai_actions WHERE id=$1", [tampered.queued.id])).rows[0]).toEqual({ status: "running", result: null });
    expect((await pool.query("SELECT state,data->'record'->>'state' nested_state,data->'record'->>'contentHash' content_hash FROM suite_records WHERE id=$1", [tampered.audit.id])).rows[0]).toEqual({ state: "queued", nested_state: "queued", content_hash: tampered.audit.contentHash });
  });
});
