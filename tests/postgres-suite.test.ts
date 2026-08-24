import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { loadDatabaseMigrations, runDatabaseMigrations } from "../src/server/database-migrations";
import { backfillLegacyPaidPlanCapacity } from "../src/server/legacy-capacity-backfill";
import { PostgresRepository } from "../src/server/repository";
import { PostgresSuiteStore } from "../src/server/suite-store";
import { suiteStorageAccounting, suiteStorageAccountingVersion } from "../src/shared/suite-quotas";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL suite isolation", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false });
  const administrativePool = pool;
  const store = new PostgresSuiteStore(databaseUrl, false);
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const viewerId = randomUUID();
  const outsiderId = randomUUID();

  beforeAll(async () => {
    await store.initialize();
    await pool.query("TRUNCATE suite_workspaces,users CASCADE");
    for (const [id, email] of [[ownerId, "pg-owner@example.com"], [memberId, "pg-member@example.com"], [viewerId, "pg-viewer@example.com"], [outsiderId, "pg-outsider@example.com"]]) {
      await pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,'unused')", [id, email, email]);
    }
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  it("shares one workspace for a customer while rejecting viewer writes and outsider reads", async () => {
    const ownerWorkspace = await store.getOrCreateWorkspace(ownerId);
    expect(ownerWorkspace.currentRole).toBe("owner");
    await store.setWorkspacePlan(ownerId, "starter");
    await store.enableModule(ownerId, "crm");
    expect(await store.addWorkspaceMember(ownerId, memberId, "member")).toMatchObject({ userId: memberId, role: "member" });
    expect(await store.addWorkspaceMember(ownerId, viewerId, "viewer")).toMatchObject({ userId: viewerId, role: "viewer" });
    expect((await store.getOrCreateWorkspace(memberId)).id).toBe(ownerWorkspace.id);

    const record = await store.createRecord(memberId, { moduleId: "crm", recordType: "contact", title: "Shared PostgreSQL customer", data: { email: "customer@example.com" } });
    expect(record).toBeTruthy();
    expect((await store.listRecords(ownerId, { limit: 10 }))[0].id).toBe(record!.id);
    expect(await store.createRecord(viewerId, { moduleId: "crm", recordType: "activity", title: "Denied" })).toBeUndefined();
    expect(await store.listRecords(outsiderId, { limit: 10 })).toEqual([]);
    expect((await store.getUsage(ownerId)).recordCount).toBe(1);
  });

  it("serializes retained-object quota, preserves every version, and reconciles without rewriting registered bytes", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const storageOwnerId = randomUUID();
    const quotaOwnerId = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$2,'unused'),($3,$4,$4,'unused')", [storageOwnerId, `storage-${suffix}@example.com`, quotaOwnerId, `quota-${suffix}@example.com`]);

    await store.getOrCreateWorkspace(storageOwnerId);
    await store.setWorkspacePlan(storageOwnerId, "scale");
    await store.enableModule(storageOwnerId, "drive");
    const fileId = randomUUID();
    const first = await store.createRecord(storageOwnerId, {
      moduleId: "drive",
      recordType: "file-version",
      title: "Object v1",
      state: "immutable",
      data: { fileId, fileVersionNumber: 1, objectKey: `tenant/${suffix}/v1`, checksum: "a".repeat(64), sizeBytes: 2_048, storageAccounting: suiteStorageAccounting(2_048) },
    });
    const second = await store.createRecord(storageOwnerId, {
      moduleId: "drive",
      recordType: "file-version",
      title: "Object v2",
      state: "immutable",
      data: { fileId, fileVersionNumber: 2, objectKey: `tenant/${suffix}/v2`, checksum: "b".repeat(64), sizeBytes: 4_096, storageAccounting: suiteStorageAccounting(4_096) },
    });
    expect(await store.getUsage(storageOwnerId)).toMatchObject({ registeredStorageBytes: 6_144, verifiedStorageBytes: 0, unverifiedStorageBytes: 6_144, retainedStorageObjectCount: 2, storageAccountingVersion: suiteStorageAccountingVersion });
    expect((await pool.query("SELECT record_id,size_bytes,object_store_verified,verification_state FROM suite_storage_objects WHERE record_id=ANY($1::UUID[]) ORDER BY size_bytes", [[first!.id, second!.id]])).rows).toEqual([
      { record_id: first!.id, size_bytes: "2048", object_store_verified: false, verification_state: "registered-unverified" },
      { record_id: second!.id, size_bytes: "4096", object_store_verified: false, verification_state: "registered-unverified" },
    ]);

    await expect(store.updateRecord(storageOwnerId, first!.id, { data: { sizeBytes: 1, storageAccounting: suiteStorageAccounting(1) } })).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE suite_records SET data=jsonb_set(data,'{sizeBytes}','1'::JSONB) WHERE id=$1", [first!.id])).rejects.toThrow(/retained object metadata is immutable/);
    await expect(pool.query("DELETE FROM suite_records WHERE id=$1", [first!.id])).rejects.toThrow(/cannot be deleted/);

    expect((await pool.query("SELECT managed_oss_reconcile_suite_storage_object($1,$2,NOW()) reconciled", [second!.id, 4_000])).rows[0].reconciled).toBe(true);
    expect((await pool.query("SELECT size_bytes,object_store_observed_bytes,object_store_verified,verification_state FROM suite_storage_objects WHERE record_id=$1", [second!.id])).rows[0]).toEqual({ size_bytes: "4096", object_store_observed_bytes: "4000", object_store_verified: false, verification_state: "size-mismatch" });
    expect((await pool.query("SELECT managed_oss_reconcile_suite_storage_object($1,$2,NOW()) reconciled", [second!.id, 4_096])).rows[0].reconciled).toBe(true);
    expect(await store.getUsage(storageOwnerId)).toMatchObject({ registeredStorageBytes: 6_144, verifiedStorageBytes: 4_096, unverifiedStorageBytes: 2_048, retainedStorageObjectCount: 2 });

    await store.getOrCreateWorkspace(quotaOwnerId);
    await store.setWorkspacePlan(quotaOwnerId, "starter");
    await store.enableModule(quotaOwnerId, "esign");
    const document = (label: string, sizeBytes: number) => ({
      moduleId: "esign",
      recordType: "document",
      title: `${label}.pdf`,
      state: "immutable",
      data: { objectRef: `tenant/${suffix}/${label}.pdf`, objectVersion: `generation-${label}`, sha256: "c".repeat(64), sizeBytes, storageAccounting: suiteStorageAccounting(sizeBytes) },
    });
    const settled = await Promise.allSettled([
      store.createRecord(quotaOwnerId, document("large", 10_000_000_000)),
      store.createRecord(quotaOwnerId, document("overflow", 800_000_000)),
    ]);
    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await store.getUsage(quotaOwnerId)).registeredStorageBytes).toBe(10_000_000_000);
  });

  it("enforces composite tenant foreign keys in the database", async () => {
    const outsiderWorkspace = await store.getOrCreateWorkspace(outsiderId);
    await store.setWorkspacePlan(outsiderId, "starter");
    await store.enableModule(outsiderId, "crm");
    const outsiderRecord = await store.createRecord(outsiderId, { moduleId: "crm", recordType: "contact", title: "Other tenant" });
    const ownerWorkspace = await store.getOrCreateWorkspace(ownerId);
    await expect(pool.query("INSERT INTO suite_events(id,workspace_id,module_id,event_type,record_id) VALUES($1,$2,'crm','invalid.cross_tenant',$3)", [randomUUID(), ownerWorkspace.id, outsiderRecord!.id])).rejects.toMatchObject({ code: "23503" });
    expect(outsiderWorkspace.id).not.toBe(ownerWorkspace.id);
  });

  it("resolves hosted signer sessions through the exact indexed token hash without cross-tenant scans", async () => {
    await store.setWorkspacePlan(ownerId, "starter");
    await store.enableModule(ownerId, "esign");
    const tokenHash = "9".repeat(64);
    const session = await store.createRecord(ownerId, {
      moduleId: "esign",
      recordType: "signer-session",
      title: "Indexed signer session",
      state: "active",
      data: { tokenHash, envelopeId: randomUUID(), signerId: randomUUID() },
    });
    expect(await store.findSignerSessionByTokenHash(ownerId, tokenHash)).toMatchObject({ id: session!.id, workspaceId: session!.workspaceId });
    expect(await store.findSignerSessionByTokenHash(outsiderId, tokenHash)).toBeUndefined();

    await store.setWorkspacePlan(outsiderId, "starter");
    await store.enableModule(outsiderId, "esign");
    await expect(store.createRecord(outsiderId, {
      moduleId: "esign",
      recordType: "signer-session",
      title: "Rejected duplicate signer session",
      state: "active",
      data: { tokenHash, envelopeId: randomUUID(), signerId: randomUUID() },
    })).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces forced tenant RLS through non-owner runtime, AI, and migrator roles", async () => {
    const ownerWorkspace = await store.getOrCreateWorkspace(ownerId);
    const outsiderWorkspace = await store.getOrCreateWorkspace(outsiderId);
    const roles = await pool.query("SELECT rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::TEXT[]) ORDER BY rolname", [["managed_oss_ai", "managed_oss_control", "managed_oss_core_owner", "managed_oss_migrator", "managed_oss_runtime", "managed_oss_suite_owner"]]);
    expect(roles.rows).toEqual([
      { rolname: "managed_oss_ai", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: "managed_oss_control", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: "managed_oss_core_owner", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: "managed_oss_migrator", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: "managed_oss_runtime", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: "managed_oss_suite_owner", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
    ]);
    const rls = await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname LIKE 'suite\\_%' ESCAPE '\\' AND relkind='r' ORDER BY relname");
    expect(rls.rows.length).toBeGreaterThan(0);
    expect(rls.rows.every((row) => row.relrowsecurity === true && row.relforcerowsecurity === true)).toBe(true);
    expect((await pool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='global_hostname_claims'")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const runtime = await pool.connect();
    try {
      await runtime.query("BEGIN");
      await runtime.query("SET LOCAL ROLE managed_oss_runtime");
      const context = await runtime.query("SELECT * FROM managed_oss_workspace_context_for_user($1,'none')", [ownerId]);
      expect(String(context.rows[0].workspace_id)).toBe(ownerWorkspace.id);
      expect((await runtime.query("SELECT current_setting('app.workspace_id',true) workspace_id")).rows[0].workspace_id).toBe(ownerWorkspace.id);
      const visibleWorkspaces = await runtime.query("SELECT DISTINCT workspace_id FROM suite_records ORDER BY workspace_id");
      expect(visibleWorkspaces.rows.map((row) => String(row.workspace_id))).toEqual([ownerWorkspace.id]);
      expect(visibleWorkspaces.rows.map((row) => String(row.workspace_id))).not.toContain(outsiderWorkspace.id);
      await expect(runtime.query("INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,'crm','contact','Cross tenant','active','{}'::JSONB)", [randomUUID(), outsiderWorkspace.id])).rejects.toMatchObject({ code: "42501" });
      await runtime.query("COMMIT");

      await runtime.query("BEGIN");
      await runtime.query("SET LOCAL ROLE managed_oss_runtime");
      expect((await runtime.query("SELECT current_setting('app.workspace_id',true) workspace_id")).rows[0].workspace_id).toBe("");
      expect((await runtime.query("SELECT COUNT(*)::INT count FROM suite_records")).rows[0].count).toBe(0);
      await expect(runtime.query("ALTER TABLE suite_records ADD COLUMN forbidden_runtime_change BOOLEAN")).rejects.toMatchObject({ code: "42501" });
      await runtime.query("ROLLBACK");

      await runtime.query("BEGIN");
      await runtime.query("SET LOCAL ROLE managed_oss_ai");
      await expect(runtime.query("SELECT * FROM managed_oss_claim_suite_ai_action(FALSE,ARRAY[]::TEXT[],ARRAY[]::TEXT[])")).resolves.toBeTruthy();
      await expect(runtime.query("SELECT token_hash FROM suite_api_tokens LIMIT 1")).rejects.toMatchObject({ code: "42501" });
      await runtime.query("ROLLBACK");

      await runtime.query("BEGIN");
      await runtime.query("SET LOCAL ROLE managed_oss_migrator");
      expect((await runtime.query("SELECT version FROM managed_schema_migrations ORDER BY version")).rows.map((row) => row.version)).toEqual([
        "001", "002", "003", "004", "005", "006", "007", "008",
        "009", "010", "011", "012", "013", "014", "015", "016", "017", "018",
      ]);
      await runtime.query("ROLLBACK");
    } finally {
      runtime.release();
    }
  });

  it("rejects an incomplete trusted AI result and rolls back both completion records", async () => {
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.setWorkspacePlan(ownerId, "starter");
    await store.enableModule(ownerId, "crm");
    const actionId = randomUUID();
    const auditId = randomUUID();
    const promptDigest = "a".repeat(64);
    await pool.query(
      "INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,'crm','ai-request-audit','Atomic AI audit','queued',$3::JSONB)",
      [auditId, workspace.id, JSON.stringify({ promptDigest, reviewStatus: "pending-model" })],
    );
    await pool.query(
      "INSERT INTO suite_ai_actions(id,workspace_id,module_id,goal,context,status,lease_expires_at) VALUES($1,$2,'crm','Propose the next action',$3::JSONB,'running',NOW()+INTERVAL '5 minutes')",
      [actionId, workspace.id, JSON.stringify({ aiAuditRecordId: auditId, promptDigest, evidenceIds: [], resultContract: { version: "core-business-ai-result.v1" } })],
    );

    const ai = await pool.connect();
    try {
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      await expect(ai.query(
        "SELECT managed_oss_complete_suite_ai_action($1,'completed',$2::JSONB,NULL)",
        [actionId, JSON.stringify({ proposal: "A bounded proposal", evidence: [], confidence: 0.8, assumptions: [], reviewStatus: "pending-human-review", model: "local/test", resultSha256: "b".repeat(64) })],
      )).rejects.toThrow(/trusted result contract/);
      await ai.query("ROLLBACK");

      expect((await pool.query("SELECT status,result,lease_expires_at IS NOT NULL AS leased FROM suite_ai_actions WHERE id=$1", [actionId])).rows[0]).toEqual({ status: "running", result: null, leased: true });
      expect((await pool.query("SELECT state,data->>'reviewStatus' AS review_status,data ? 'resultHash' AS has_result_hash FROM suite_records WHERE id=$1", [auditId])).rows[0]).toEqual({ state: "queued", review_status: "pending-model", has_result_hash: false });
    } finally {
      try { await ai.query("ROLLBACK"); } catch {}
      ai.release();
      await pool.query("DELETE FROM suite_ai_actions WHERE id=$1", [actionId]);
      await pool.query("DELETE FROM suite_records WHERE id=$1", [auditId]);
    }
  });

  it("atomically commits a valid premium AI audit and rolls back a missing-field result", async () => {
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.setWorkspacePlan(ownerId, "starter");
    await store.enableModule(ownerId, "finance");
    const evidenceId = randomUUID();
    const validActionId = randomUUID();
    const validAuditId = randomUUID();
    const invalidActionId = randomUUID();
    const invalidAuditId = randomUUID();
    const platformPromptDigest = "c".repeat(64);
    const context = (auditId: string) => ({ aiAuditRecordId: auditId, evidenceIds: [evidenceId], promptVersion: "customer-analysis-v1", requestedModelId: "local/test", platformPromptDigest, resultContract: { version: "premium-business-ai-result.v1" } });
    const auditData = { promptVersion: "customer-analysis-v1", requestedModelId: "local/test", platformPromptDigest, review: { status: "pending-model", required: true } };
    const validResult = { output: { summary: "The reconciled records support one bounded follow-up.", claims: [{ text: "The customer balance was reconciled.", evidenceIds: [evidenceId] }] }, confidence: 87, evidenceIds: [evidenceId], promptVersion: "customer-analysis-v1", modelId: "local/test", reviewStatus: "pending-human-review", approvalRequired: true };

    await pool.query("INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,'finance','evidence','Premium evidence','active','{}'::JSONB),($3,$2,'finance','premium-ai-request-audit','Valid premium audit','queued',$4::JSONB),($5,$2,'finance','premium-ai-request-audit','Invalid premium audit','queued',$4::JSONB)", [evidenceId, workspace.id, validAuditId, JSON.stringify(auditData), invalidAuditId]);
    await pool.query("INSERT INTO suite_ai_actions(id,workspace_id,module_id,goal,context,status,lease_expires_at) VALUES($1,$2,'finance','Analyze the evidence',$3::JSONB,'running',NOW()+INTERVAL '5 minutes'),($4,$2,'finance','Analyze the evidence',$5::JSONB,'running',NOW()+INTERVAL '5 minutes')", [validActionId, workspace.id, JSON.stringify(context(validAuditId)), invalidActionId, JSON.stringify(context(invalidAuditId))]);

    const ai = await pool.connect();
    try {
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      expect((await ai.query("SELECT managed_oss_complete_suite_ai_action($1,'completed',$2::JSONB,NULL) completed", [validActionId, JSON.stringify(validResult)])).rows[0].completed).toBe(true);
      await ai.query("COMMIT");
      expect((await pool.query("SELECT status,result->>'modelId' model_id FROM suite_ai_actions WHERE id=$1", [validActionId])).rows[0]).toEqual({ status: "completed", model_id: "local/test" });
      expect((await pool.query("SELECT state,data->'review'->>'status' review_status,data->>'executedModelId' model_id FROM suite_records WHERE id=$1", [validAuditId])).rows[0]).toEqual({ state: "pending-human-review", review_status: "pending-human-review", model_id: "local/test" });

      const missingFieldResult: Record<string, unknown> = { ...validResult };
      delete missingFieldResult.approvalRequired;
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      await expect(ai.query("SELECT managed_oss_complete_suite_ai_action($1,'completed',$2::JSONB,NULL)", [invalidActionId, JSON.stringify(missingFieldResult)])).rejects.toThrow(/premium AI completion violates its trusted result contract/);
      await ai.query("ROLLBACK");
      expect((await pool.query("SELECT status,result,lease_expires_at IS NOT NULL AS leased FROM suite_ai_actions WHERE id=$1", [invalidActionId])).rows[0]).toEqual({ status: "running", result: null, leased: true });
      expect((await pool.query("SELECT state,data->'review'->>'status' review_status,data ? 'executedModelId' AS has_model FROM suite_records WHERE id=$1", [invalidAuditId])).rows[0]).toEqual({ state: "queued", review_status: "pending-model", has_model: false });
    } finally {
      try { await ai.query("ROLLBACK"); } catch {}
      ai.release();
      await pool.query("DELETE FROM suite_ai_actions WHERE id=ANY($1::UUID[])", [[validActionId, invalidActionId]]);
      await pool.query("DELETE FROM suite_records WHERE id=ANY($1::UUID[])", [[validAuditId, invalidAuditId, evidenceId]]);
    }
  });

  it("atomically commits a valid first-party growth AI audit and rolls back a contract violation", async () => {
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.setWorkspacePlan(ownerId, "starter");
    await store.enableModule(ownerId, "giveaways");
    const evidenceId = randomUUID();
    const validActionId = randomUUID();
    const validAuditId = randomUUID();
    const invalidActionId = randomUUID();
    const invalidAuditId = randomUUID();
    const promptDigest = "d".repeat(64);
    const context = (auditId: string) => ({ aiAuditRecordId: auditId, promptDigest, evidenceIds: [evidenceId], resultContract: { version: "first-party-growth-ai-result.v1" } });
    const auditData = { promptDigest, evidenceIds: [evidenceId], reviewStatus: "pending-model" };
    const validResult = { version: "first-party-growth-ai-result.v1", proposal: "Review the bounded referral-loop evidence without changing eligibility.", evidence: [evidenceId], confidence: 0.82, assumptions: ["The cited signal remains unverified until human review."], reviewStatus: "pending-human-review", approvalRequired: true, model: "local/test" };

    await pool.query("INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,'giveaways','fraud-signal','Growth evidence','active','{}'::JSONB),($3,$2,'giveaways','ai-request-audit','Valid growth audit','queued',$4::JSONB),($5,$2,'giveaways','ai-request-audit','Invalid growth audit','queued',$4::JSONB)", [evidenceId, workspace.id, validAuditId, JSON.stringify(auditData), invalidAuditId]);
    await pool.query("INSERT INTO suite_ai_actions(id,workspace_id,module_id,goal,context,status,lease_expires_at) VALUES($1,$2,'giveaways','Propose a cited fraud review',$3::JSONB,'running',NOW()+INTERVAL '5 minutes'),($4,$2,'giveaways','Propose a cited fraud review',$5::JSONB,'running',NOW()+INTERVAL '5 minutes')", [validActionId, workspace.id, JSON.stringify(context(validAuditId)), invalidActionId, JSON.stringify(context(invalidAuditId))]);

    const ai = await pool.connect();
    try {
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      expect((await ai.query("SELECT managed_oss_complete_suite_ai_action($1,'completed',$2::JSONB,NULL) completed", [validActionId, JSON.stringify(validResult)])).rows[0].completed).toBe(true);
      await ai.query("COMMIT");
      expect((await pool.query("SELECT status,result->>'version' version,result->>'model' model FROM suite_ai_actions WHERE id=$1", [validActionId])).rows[0]).toEqual({ status: "completed", version: "first-party-growth-ai-result.v1", model: "local/test" });
      expect((await pool.query("SELECT state,data->>'reviewStatus' review_status,data->>'executedModel' model FROM suite_records WHERE id=$1", [validAuditId])).rows[0]).toEqual({ state: "pending-human-review", review_status: "pending-human-review", model: "local/test" });

      const missingFieldResult: Record<string, unknown> = { ...validResult };
      delete missingFieldResult.approvalRequired;
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      await expect(ai.query("SELECT managed_oss_complete_suite_ai_action($1,'completed',$2::JSONB,NULL)", [invalidActionId, JSON.stringify(missingFieldResult)])).rejects.toThrow(/first-party growth AI completion violates its trusted result contract/);
      await ai.query("ROLLBACK");
      expect((await pool.query("SELECT status,result,lease_expires_at IS NOT NULL AS leased FROM suite_ai_actions WHERE id=$1", [invalidActionId])).rows[0]).toEqual({ status: "running", result: null, leased: true });
      expect((await pool.query("SELECT state,data->>'reviewStatus' review_status,data ? 'executedModel' AS has_model FROM suite_records WHERE id=$1", [invalidAuditId])).rows[0]).toEqual({ state: "queued", review_status: "pending-model", has_model: false });
    } finally {
      try { await ai.query("ROLLBACK"); } catch {}
      ai.release();
      await pool.query("DELETE FROM suite_ai_actions WHERE id=ANY($1::UUID[])", [[validActionId, invalidActionId]]);
      await pool.query("DELETE FROM suite_records WHERE id=ANY($1::UUID[])", [[validAuditId, invalidAuditId, evidenceId]]);
    }
  });

  it("atomically validates e-signature proposals and counts registered agreement bytes", async () => {
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.setWorkspacePlan(ownerId, "starter");
    await store.enableModule(ownerId, "esign");
    const targetId = randomUUID();
    const evidenceId = randomUUID();
    const validActionId = randomUUID();
    const validAuditId = randomUUID();
    const invalidActionId = randomUUID();
    const invalidAuditId = randomUUID();
    const documentId = randomUUID();
    const platformPromptDigest = "e".repeat(64);
    const context = (auditId: string) => ({
      aiAuditRecordId: auditId,
      actionId: "clause-propose",
      targetRecordId: targetId,
      targetRecordHash: "f".repeat(64),
      evidenceIds: [evidenceId],
      evidenceHashes: [{ recordId: evidenceId, snapshotHash: "a".repeat(64) }],
      allowedProposalKinds: ["clause"],
      platformPromptDigest,
      resultContract: { version: "esign-ai-result.v1" },
    });
    const auditData = { targetRecordId: targetId, platformPromptDigest, reviewStatus: "pending-model", approvalRequired: true };
    const validResult = {
      proposals: [{ proposalId: "clause-1", kind: "clause", text: "A bounded clause proposal for legal review.", citations: [targetId, evidenceId], rationale: "The selected records support this review-only draft.", riskFlags: ["Jurisdiction-specific review required."] }],
      confidence: 0.75,
      assumptions: ["The human reviewer will verify governing law."],
      reviewStatus: "pending-human-review",
      approvalRequired: true,
      model: "local/test",
    };

    const usageBefore = await store.getUsage(ownerId);
    await pool.query("INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,'esign','template-version','Target version','immutable','{}'::JSONB),($3,$2,'knowledge','page','Selected evidence','published','{}'::JSONB),($4,$2,'esign','document','Registered agreement','immutable',$5::JSONB),($6,$2,'esign','esign-ai-request-audit','Valid e-sign audit','queued',$7::JSONB),($8,$2,'esign','esign-ai-request-audit','Invalid e-sign audit','queued',$7::JSONB)", [targetId, workspace.id, evidenceId, documentId, JSON.stringify({ objectRef: "tenant/contracts/registered-agreement.pdf", objectVersion: "generation-test", sha256: "d".repeat(64), sizeBytes: 42_000, storageAccounting: suiteStorageAccounting(42_000) }), validAuditId, JSON.stringify(auditData), invalidAuditId]);
    await pool.query("INSERT INTO suite_ai_actions(id,workspace_id,module_id,goal,context,status,lease_expires_at) VALUES($1,$2,'esign','Propose a clause',$3::JSONB,'running',NOW()+INTERVAL '5 minutes'),($4,$2,'esign','Propose a clause',$5::JSONB,'running',NOW()+INTERVAL '5 minutes')", [validActionId, workspace.id, JSON.stringify(context(validAuditId)), invalidActionId, JSON.stringify(context(invalidAuditId))]);

    const ai = await pool.connect();
    try {
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      expect((await ai.query("SELECT managed_oss_complete_suite_ai_action_v2($1,'completed',$2::JSONB,NULL) completed", [validActionId, JSON.stringify(validResult)])).rows[0].completed).toBe(true);
      await ai.query("COMMIT");
      expect((await pool.query("SELECT status,result->>'model' model FROM suite_ai_actions WHERE id=$1", [validActionId])).rows[0]).toEqual({ status: "completed", model: "local/test" });
      expect((await pool.query("SELECT state,data->>'reviewStatus' review_status,data->>'proposalCount' proposal_count,data->>'executedModel' model FROM suite_records WHERE id=$1", [validAuditId])).rows[0]).toEqual({ state: "pending-human-review", review_status: "pending-human-review", proposal_count: "1", model: "local/test" });
      expect((await store.getUsage(ownerId)).registeredStorageBytes - usageBefore.registeredStorageBytes).toBe(42_000);

      const invalidResult = { ...validResult, proposals: [{ ...validResult.proposals[0], kind: "routing" }] };
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      await expect(ai.query("SELECT managed_oss_complete_suite_ai_action_v2($1,'completed',$2::JSONB,NULL)", [invalidActionId, JSON.stringify(invalidResult)])).rejects.toThrow(/e-signature AI completion violates its trusted result contract/);
      await ai.query("ROLLBACK");
      expect((await pool.query("SELECT status,result,lease_expires_at IS NOT NULL AS leased FROM suite_ai_actions WHERE id=$1", [invalidActionId])).rows[0]).toEqual({ status: "running", result: null, leased: true });
      expect((await pool.query("SELECT state,data->>'reviewStatus' review_status FROM suite_records WHERE id=$1", [invalidAuditId])).rows[0]).toEqual({ state: "queued", review_status: "pending-model" });
    } finally {
      try { await ai.query("ROLLBACK"); } catch {}
      ai.release();
      await pool.query("DELETE FROM suite_ai_actions WHERE id=ANY($1::UUID[])", [[validActionId, invalidActionId]]);
      await pool.query("DELETE FROM suite_records WHERE id=ANY($1::UUID[])", [[validAuditId, invalidAuditId, targetId, evidenceId]]);
    }
  });

  it("atomically validates Letterline proposals and rolls back an unsafe body", async () => {
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.setWorkspacePlan(ownerId, "starter");
    await store.enableModule(ownerId, "email");
    const campaignId = randomUUID();
    const evidenceId = randomUUID();
    const validActionId = randomUUID();
    const validAuditId = randomUUID();
    const invalidActionId = randomUUID();
    const invalidAuditId = randomUUID();
    const platformPromptDigest = "1".repeat(64);
    const context = (auditId: string) => ({
      aiAuditRecordId: auditId,
      actionId: "body-propose",
      targetRecordId: campaignId,
      targetRecordHash: "2".repeat(64),
      evidenceIds: [evidenceId],
      evidenceHashes: [{ recordId: evidenceId, snapshotHash: "3".repeat(64) }],
      allowedProposalKinds: ["body"],
      platformPromptDigest,
      resultContract: { version: "letterline-ai-result.v1" },
    });
    const auditData = {
      targetRecordId: campaignId,
      platformPromptDigest,
      reviewStatus: "pending-model",
      approvalRequired: true,
      providerCallAllowed: false,
    };
    const validResult = {
      version: "letterline-ai-result.v1",
      proposals: [{
        proposalId: "body-1",
        kind: "body",
        content: "The selected evidence supports this review-only draft.\n\nUnsubscribe: {{unsubscribe_url}}",
        citations: [campaignId, evidenceId],
        rationale: "The exact campaign and selected record bound the proposal.",
        riskFlags: ["Human review is required before provider handoff."],
      }],
      confidence: 0.79,
      assumptions: ["The cited workspace evidence remains current."],
      reviewStatus: "pending-human-review",
      approvalRequired: true,
      model: "local/test",
    };

    await pool.query(
      "INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,'email','campaign','Atomic campaign','draft','{}'::JSONB),($3,$2,'knowledge','page','Selected email evidence','published','{}'::JSONB),($4,$2,'email','email-ai-request-audit','Valid email audit','queued',$5::JSONB),($6,$2,'email','email-ai-request-audit','Invalid email audit','queued',$5::JSONB)",
      [campaignId, workspace.id, evidenceId, validAuditId, JSON.stringify(auditData), invalidAuditId],
    );
    await pool.query(
      "INSERT INTO suite_ai_actions(id,workspace_id,module_id,goal,context,status,lease_expires_at) VALUES($1,$2,'email','Propose a cited newsletter body',$3::JSONB,'running',NOW()+INTERVAL '5 minutes'),($4,$2,'email','Propose a cited newsletter body',$5::JSONB,'running',NOW()+INTERVAL '5 minutes')",
      [validActionId, workspace.id, JSON.stringify(context(validAuditId)), invalidActionId, JSON.stringify(context(invalidAuditId))],
    );

    const ai = await pool.connect();
    try {
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      expect((await ai.query("SELECT managed_oss_complete_suite_ai_action_v3($1,'completed',$2::JSONB,NULL) completed", [validActionId, JSON.stringify(validResult)])).rows[0].completed).toBe(true);
      await ai.query("COMMIT");
      expect((await pool.query("SELECT status,result->>'version' version,result->>'model' model FROM suite_ai_actions WHERE id=$1", [validActionId])).rows[0]).toEqual({ status: "completed", version: "letterline-ai-result.v1", model: "local/test" });
      expect((await pool.query("SELECT state,data->>'reviewStatus' review_status,data->>'proposalCount' proposal_count,data->>'executedModel' model,data->>'providerCallAllowed' provider_call_allowed FROM suite_records WHERE id=$1", [validAuditId])).rows[0]).toEqual({ state: "pending-human-review", review_status: "pending-human-review", proposal_count: "1", model: "local/test", provider_call_allowed: "false" });

      const invalidResult = {
        ...validResult,
        proposals: [{ ...validResult.proposals[0], content: "This body omits the required unsubscribe marker." }],
      };
      await ai.query("BEGIN");
      await ai.query("SET LOCAL ROLE managed_oss_ai");
      await expect(ai.query("SELECT managed_oss_complete_suite_ai_action_v3($1,'completed',$2::JSONB,NULL)", [invalidActionId, JSON.stringify(invalidResult)])).rejects.toThrow(/Letterline AI completion violates its trusted result contract/);
      await ai.query("ROLLBACK");
      expect((await pool.query("SELECT status,result,lease_expires_at IS NOT NULL AS leased FROM suite_ai_actions WHERE id=$1", [invalidActionId])).rows[0]).toEqual({ status: "running", result: null, leased: true });
      expect((await pool.query("SELECT state,data->>'reviewStatus' review_status,data ? 'executedModel' AS has_model FROM suite_records WHERE id=$1", [invalidAuditId])).rows[0]).toEqual({ state: "queued", review_status: "pending-model", has_model: false });
    } finally {
      try { await ai.query("ROLLBACK"); } catch {}
      ai.release();
      await pool.query("DELETE FROM suite_ai_actions WHERE id=ANY($1::UUID[])", [[validActionId, invalidActionId]]);
      await pool.query("DELETE FROM suite_records WHERE id=ANY($1::UUID[])", [[validAuditId, invalidAuditId, campaignId, evidenceId]]);
    }
  });

  it("runs SuiteStore tenant transactions through a real non-owner runtime login", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const roleName = `phasea_runtime_${suffix}`;
    const password = randomUUID().replaceAll("-", "");
    const connection = new URL(databaseUrl!);
    connection.username = roleName;
    connection.password = password;
    const previousMode = config.DATABASE_MIGRATION_MODE;
    let runtimeStore: PostgresSuiteStore | undefined;
    await pool.query(`CREATE ROLE "${roleName}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await pool.query(`GRANT managed_oss_runtime TO "${roleName}"`);
    try {
      config.DATABASE_MIGRATION_MODE = "manual";
      runtimeStore = new PostgresSuiteStore(connection.toString(), false);
      await runtimeStore.initialize();
      const [ownerWorkspace, outsiderWorkspace, ownerRecords, outsiderRecords] = await Promise.all([
        runtimeStore.getOrCreateWorkspace(ownerId),
        runtimeStore.getOrCreateWorkspace(outsiderId),
        runtimeStore.listRecords(ownerId, { limit: 20 }),
        runtimeStore.listRecords(outsiderId, { limit: 20 }),
      ]);
      expect(ownerWorkspace.id).not.toBe(outsiderWorkspace.id);
      expect(ownerRecords.every((record) => record.workspaceId === ownerWorkspace.id)).toBe(true);
      expect(outsiderRecords.every((record) => record.workspaceId === outsiderWorkspace.id)).toBe(true);
      const outsiderRecordIds = new Set(outsiderRecords.map((record) => record.id));
      expect(ownerRecords.filter((record) => outsiderRecordIds.has(record.id))).toEqual([]);
      const token = await runtimeStore.createApiToken(ownerId, { name: "Phase A runtime token", scopes: ["read"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(await runtimeStore.findApiTokenPrincipal(token.token)).toMatchObject({ tokenId: token.id, userId: ownerId, scopes: ["read"] });
      expect(await runtimeStore.revokeApiToken(ownerId, token.id)).toBe(true);
      expect(await runtimeStore.findApiTokenPrincipal(token.token)).toBeUndefined();
    } finally {
      config.DATABASE_MIGRATION_MODE = previousMode;
      await runtimeStore?.close();
      await pool.query(`DROP ROLE IF EXISTS "${roleName}"`);
    }
  });

  it("revokes running and queued paid worker mutations when a hosted subscription is canceled", async () => {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    try {
      const suffix = randomUUID().slice(0, 8);
      const user = await repository.createUser({ email: `pg-cancel-${suffix}@example.com`, displayName: "Canceled PostgreSQL owner", passwordHash: "unused" });
      const installation = await repository.createInstallation({ userId: user.id, appIds: ["uptime-kuma"], name: "Cancellation boundary", plan: "starter", state: "provisioning", hostname: "pg-cancel.apps.example.com", customDomains: [] });
      const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
      await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: `sub_${randomUUID()}`, status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
      const worker = await repository.registerWorkerNode({ id: `pg-worker-${suffix}`, name: `PostgreSQL worker ${suffix}`, privateAddress: "10.70.0.70", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });

      await repository.enqueueJob(installation.id, "install", { applicationInstanceId: application.id });
      const install = await repository.claimWorkerJob(worker.node.id);
      expect(install?.action).toBe("install");
      expect(await repository.reportWorkerJob(worker.node.id, install!.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(true);
      expect(await repository.listGatewayRoutes()).toHaveLength(1);

      const runningStart = await repository.enqueueJob(installation.id, "start", { applicationInstanceId: application.id });
      expect((await repository.claimWorkerJob(worker.node.id))?.id).toBe(runningStart.id);
      const subscription = (await repository.listSubscriptions()).find((item) => item.installationId === installation.id)!;
      await repository.updateSubscriptionStatus(subscription.providerSubscriptionId!, "canceled");

      expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("suspended");
      expect(await repository.reportWorkerJob(worker.node.id, runningStart.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(false);
      expect(await repository.listGatewayRoutes()).toEqual([]);
      await repository.enqueueJob(installation.id, "start", { applicationInstanceId: application.id });
      const stop = await repository.claimWorkerJob(worker.node.id);
      expect(stop?.action).toBe("stop");
      expect(await repository.reportWorkerJob(worker.node.id, stop!.id, { status: "succeeded", applications: [{ id: application.id, state: "stopped", healthy: false }] })).toBe(true);
      expect(await repository.claimWorkerJob(worker.node.id)).toBeUndefined();
    } finally {
      await repository.close();
    }
  });

  it("persists and atomically consumes one hosting-layer OAuth state for the exact routed HeyForm instance", async () => {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    try {
      const suffix = randomUUID().slice(0, 8);
      const user = await repository.createUser({ email: `pg-oauth-${suffix}@example.com`, displayName: "PostgreSQL OAuth owner", passwordHash: "unused" });
      const installation = await repository.createInstallation({ userId: user.id, appIds: ["heyform"], name: "OAuth boundary", plan: "starter", state: "provisioning", hostname: `pg-oauth-${suffix}.apps.example.com`, customDomains: [] });
      const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "heyform", memoryReservationMb: 1312, cpuReservationMillis: 750, storageReservationGb: 20 }], "apps.example.com");
      await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: `sub_oauth_${suffix}`, status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
      const worker = await repository.registerWorkerNode({ id: `pg-oauth-${suffix}`, name: `PostgreSQL OAuth ${suffix}`, privateAddress: "10.70.0.79", machineType: "e2-standard-2", capacityMemoryMb: 2048, capacityCpuMillis: 1000, capacityStorageGb: 30, systemReserveMemoryMb: 512 });
      await repository.enqueueJob(installation.id, "install", { applicationInstanceId: application.id });
      const job = await repository.claimWorkerJob(worker.node.id);
      expect(await repository.reportWorkerJob(worker.node.id, job!.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(true);
      expect((await repository.listGatewayRoutes()).filter((route) => route.applicationInstanceId === application.id)).toEqual([expect.objectContaining({ applicationInstanceId: application.id, appId: "heyform", hostname: application.hostname })]);

      const flow = { id: "a".repeat(43), stateTokenHash: "b".repeat(64), applicationInstanceId: application.id, origin: `https://${application.hostname}`, upstreamState: "postgres-upstream-state", codeVerifier: "c".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() };
      await repository.createManagedOAuthFlow(flow);
      expect(await repository.consumeManagedOAuthFlow(flow.stateTokenHash)).toMatchObject({ ...flow, consumedAt: expect.any(String) });
      expect(await repository.consumeManagedOAuthFlow(flow.stateTokenHash)).toBeUndefined();
    } finally {
      await repository.close();
    }
  });

  it("persists worker drain state across heartbeat and blocks new claims while exposing running work", async () => {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    try {
      const suffix = randomUUID().slice(0, 8);
      const user = await repository.createUser({ email: `pg-drain-${suffix}@example.com`, displayName: "PostgreSQL drain owner", passwordHash: "unused" });
      const installation = await repository.createInstallation({ userId: user.id, appIds: ["listmonk"], name: "Drain boundary", plan: "starter", state: "provisioning", hostname: `pg-drain-${suffix}.apps.example.com`, customDomains: [] });
      const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "listmonk", memoryReservationMb: 576, cpuReservationMillis: 500, storageReservationGb: 10 }], "apps.example.com");
      await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: `sub_${randomUUID()}`, status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
      const worker = await repository.registerWorkerNode({ id: `pg-drain-${suffix}`, name: `PostgreSQL drain ${suffix}`, privateAddress: "10.70.0.71", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });
      await repository.enqueueJob(installation.id, "install", { applicationInstanceId: application.id });

      expect(await repository.setWorkerNodeMode(worker.node.id, "draining")).toMatchObject({ mode: "draining", safeToReplaceAgent: true, runningJobs: [] });
      expect((await repository.heartbeatWorkerNode(worker.node.id, { privateAddress: "10.70.0.71", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20 }))?.status).toBe("draining");
      expect(await repository.claimWorkerJob(worker.node.id)).toBeUndefined();

      expect((await repository.setWorkerNodeMode(worker.node.id, "active"))?.mode).toBe("active");
      const claim = await repository.claimWorkerJob(worker.node.id);
      expect(claim?.action).toBe("install");
      const activity = await repository.setWorkerNodeMode(worker.node.id, "draining");
      expect(activity).toMatchObject({ mode: "draining", safeToReplaceAgent: false });
      expect(activity?.runningJobs).toEqual([expect.objectContaining({ id: claim!.id, action: "install", status: "running" })]);
      expect(activity?.assignedApplications).toEqual([expect.objectContaining({ id: application.id, appId: "listmonk" })]);

      expect(await repository.reportWorkerJob(worker.node.id, claim!.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(true);
      expect(await repository.getWorkerNodeActivity(worker.node.id)).toMatchObject({ mode: "draining", safeToReplaceAgent: true, runningJobs: [] });
      expect((await repository.listGatewayRoutes()).filter((route) => route.workerNodeId === worker.node.id)).toEqual([expect.objectContaining({ workerNodeId: worker.node.id })]);
      await repository.enqueueJob(installation.id, "start", { applicationInstanceId: application.id });
      expect(await repository.claimWorkerJob(worker.node.id)).toBeUndefined();
    } finally {
      await repository.close();
    }
  });

  it("serializes cancellation with final install claim and queues cleanup when the in-flight report is rejected", async () => {
    const suffix = randomUUID().slice(0, 8);
    const applicationName = `claim-race-${suffix}`;
    const connection = new URL(databaseUrl!);
    connection.searchParams.set("application_name", applicationName);
    const repository = new PostgresRepository(connection.toString(), false);
    await repository.initialize();
    const blocker = await pool.connect();
    try {
      const user = await repository.createUser({ email: `pg-cancel-install-${suffix}@example.com`, displayName: "PostgreSQL cancel install", passwordHash: "unused" });
      const installation = await repository.createInstallation({ userId: user.id, appIds: ["listmonk"], name: "Cancel install boundary", plan: "starter", state: "provisioning", hostname: `pg-cancel-install-${suffix}.apps.example.com`, customDomains: [] });
      const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "listmonk", memoryReservationMb: 576, cpuReservationMillis: 500, storageReservationGb: 10 }], "apps.example.com");
      const providerSubscriptionId = `sub_${randomUUID()}`;
      await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId, status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
      const worker = await repository.registerWorkerNode({ id: `pg-race-${suffix}`, name: `PostgreSQL race ${suffix}`, privateAddress: "10.70.0.72", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });
      await repository.enqueueJob(installation.id, "install", { applicationInstanceId: application.id });

      await blocker.query("BEGIN");
      await blocker.query("UPDATE subscriptions SET status='canceled',updated_at=NOW() WHERE provider_subscription_id=$1", [providerSubscriptionId]);
      const blockedClaim = repository.claimWorkerJob(worker.node.id);
      let observedEntitlementLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await pool.query("SELECT wait_event_type,query FROM pg_stat_activity WHERE application_name=$1 AND query ILIKE '%FOR SHARE%'", [applicationName]);
        if (activity.rows.some((row) => row.wait_event_type === "Lock")) { observedEntitlementLock = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedEntitlementLock).toBe(true);
      await blocker.query("COMMIT");
      expect(await blockedClaim).toBeUndefined();
      expect(await repository.getApplicationInstance(user.id, application.id)).toMatchObject({ state: "queued", workerNodeId: undefined });

      await repository.updateSubscriptionStatus(providerSubscriptionId, "active");
      const install = await repository.claimWorkerJob(worker.node.id);
      expect(install?.action).toBe("install");
      expect(await repository.getApplicationInstance(user.id, application.id)).toMatchObject({ state: "provisioning", workerNodeId: worker.node.id });

      await repository.updateSubscriptionStatus(providerSubscriptionId, "canceled");
      expect(await repository.reportWorkerJob(worker.node.id, install!.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(false);
      const cleanup = await repository.claimWorkerJob(worker.node.id);
      expect(cleanup).toMatchObject({ action: "stop", installationId: installation.id, workerNodeId: worker.node.id, payload: { applicationInstanceId: application.id, reason: "subscription_inactive" } });
      await repository.updateSubscriptionStatus(providerSubscriptionId, "canceled");
      expect((await repository.claimWorkerJob(worker.node.id))?.id).toBe(cleanup!.id);
      expect(await repository.reportWorkerJob(worker.node.id, cleanup!.id, { status: "succeeded", applications: [{ id: application.id, state: "stopped", healthy: false }] })).toBe(true);
      expect(await repository.claimWorkerJob(worker.node.id)).toBeUndefined();
    } finally {
      try { await blocker.query("ROLLBACK"); } catch {}
      blocker.release();
      await repository.close();
    }
  });

  it("serializes concurrent checkout holds and atomically consumes one into fixed worker jobs", async () => {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const workerId = `pg-hold-${suffix}`;
    try {
      await pool.query("UPDATE worker_nodes SET status='draining'");
      await repository.registerWorkerNode({ id: workerId, name: `PostgreSQL hold ${suffix}`, privateAddress: "10.70.0.92", machineType: "exact-app", capacityMemoryMb: 640, capacityCpuMillis: 250, capacityStorageGb: 3, systemReserveMemoryMb: 256 });
      const installations = [];
      for (const label of ["first", "second"] as const) {
        const installation = await repository.createInstallation({ userId: ownerId, appIds: ["uptime-kuma"], name: `PostgreSQL hold ${label} ${suffix}`, plan: "starter", state: "planned", hostname: `pg-hold-${label}-${suffix}.apps.example.com`, customDomains: [] });
        const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
        installations.push({ installation, application });
      }
      const requests = installations.map(({ installation, application }) => ({ userId: ownerId, installationId: installation.id, idempotencyKey: `checkout:${randomUUID()}`, requestedPlan: "starter", requestedAppIds: ["uptime-kuma"], infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: application.memoryReservationMb, cpuReservationMillis: application.cpuReservationMillis, storageReservationGb: application.storageReservationGb }] }));

      const holds = await Promise.all(requests.map((request) => repository.acquireCheckoutCapacityHold(request)));
      expect(holds.filter(Boolean)).toHaveLength(1);
      const selectedIndex = holds[0] ? 0 : 1;
      const hold = holds[selectedIndex]!;
      const selected = installations[selectedIndex];
      const customerId = `cus_${suffix}`;
      const sessionId = `cs_${suffix}`;
      const subscriptionId = `sub_${suffix}`;
      expect(await repository.getOrCreateStripeCustomer(ownerId, async () => customerId)).toBe(customerId);
      expect(await repository.attachCheckoutSession({ holdId: hold.id, userId: ownerId, stripeCustomerId: customerId, stripeCheckoutSessionId: sessionId, stripeCheckoutExpiresAt: new Date(Date.now() + 31 * 60_000).toISOString() })).toBe(true);
      const paid = { eventId: `evt_${suffix}`, eventType: "checkout.session.completed", holdId: hold.id, userId: ownerId, installationId: selected.installation.id, stripeCheckoutSessionId: sessionId, stripeCustomerId: customerId, providerSubscriptionId: subscriptionId, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 };
      expect(await repository.processPaidCheckout(paid)).toBe(true);
      expect(await repository.processPaidCheckout(paid)).toBe(false);
      expect(await repository.getCheckoutCapacityHold(hold.id)).toMatchObject({ state: "consumed", providerSubscriptionId: subscriptionId });
      expect(await repository.getApplicationInstance(ownerId, selected.application.id)).toMatchObject({ workerNodeId: workerId, state: "queued" });
      expect(await repository.claimWorkerJob(workerId)).toMatchObject({ action: "install", workerNodeId: workerId, payload: { capacityHoldId: hold.id, applicationInstanceId: selected.application.id } });
    } finally {
      await repository.setWorkerNodeMode(workerId, "draining").catch(() => undefined);
      await repository.close();
    }
  });

  it("backfills legacy paid tenants only at exact configured prices, retries idempotently, and fails closed across price, tenant, and quota boundaries", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `legacy_backfill_${suffix}`;
    await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    const isolatedDatabaseUrl = new URL(databaseUrl!);
    isolatedDatabaseUrl.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: isolatedDatabaseUrl.toString(), ssl: false });
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await runDatabaseMigrations(pool, await loadDatabaseMigrations(), { mode: "auto" });
    expect((await pool.query("SELECT version FROM managed_schema_migrations ORDER BY version")).rows.map((row) => row.version)).toEqual([
      "001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011", "012", "013", "014", "015", "016", "017", "018",
    ]);

    const starter = config.plans.find((plan) => plan.id === "starter")!;
    const scale = config.plans.find((plan) => plan.id === "scale")!;
    const starterOwnerId = randomUUID();
    const scaleOwnerId = randomUUID();
    const otherTenantId = randomUUID();
    const starterInstallationId = randomUUID();
    const scaleInstallationId = randomUUID();
    const crossTenantInstallationId = randomUUID();
    const overflowInstallationId = randomUUID();
    const priceMismatchInstallationId = randomUUID();
    const nullPriceInstallationId = randomUUID();
    const workerId = `pg-legacy-${suffix}`;

    await pool.query(
      "INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,'Legacy starter','unused'),($3,$4,'Legacy scale','unused'),($5,$6,'Other tenant','unused')",
      [starterOwnerId, `legacy-starter-${suffix}@example.com`, scaleOwnerId, `legacy-scale-${suffix}@example.com`, otherTenantId, `legacy-other-${suffix}@example.com`],
    );
    await pool.query(
      "INSERT INTO worker_nodes(id,name,status,private_address,machine_type,capacity_memory_mb,capacity_cpu_millis,capacity_storage_gb,system_reserve_memory_mb,agent_token_hash) VALUES($1,$2,'ready','10.70.0.94','legacy-test',32768,16000,1000,512,$3)",
      [workerId, `Legacy backfill ${suffix}`, `legacy-token-${suffix}`],
    );
    await pool.query(
      `INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids)
       VALUES($1,$2,'Legacy starter','starter','live',$3,'["starter-app"]'::JSONB),
             ($4,$5,'Legacy scale','scale','live',$6,'["scale-app"]'::JSONB)`,
      [starterInstallationId, starterOwnerId, `legacy-starter-${suffix}.apps.example.com`, scaleInstallationId, scaleOwnerId, `legacy-scale-${suffix}.apps.example.com`],
    );
    await pool.query(
      `INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,worker_node_id,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb)
       VALUES($1,$2,'starter-app','live',$3,$4,$5,384,250,3),
             ($6,$7,'scale-app','live',$8,$9,$5,1024,500,20)`,
      [randomUUID(), starterInstallationId, `legacy-starter-app-${suffix}.apps.example.com`, `legacy-starter-${suffix}`, workerId, randomUUID(), scaleInstallationId, `legacy-scale-app-${suffix}.apps.example.com`, `legacy-scale-${suffix}`],
    );
    await pool.query(
      `INSERT INTO subscriptions(id,user_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents,installation_id)
       VALUES($1,$2,$3,'active',$4,$5,$6),($7,$8,$9,'trialing',$10,$11,$12)`,
      [
        randomUUID(), starterOwnerId, `sub_legacy_starter_${suffix}`, starter.infrastructureMonthlyCents, starter.monthlyCents - starter.infrastructureMonthlyCents, starterInstallationId,
        randomUUID(), scaleOwnerId, `sub_legacy_scale_${suffix}`, scale.infrastructureMonthlyCents, scale.monthlyCents - scale.infrastructureMonthlyCents, scaleInstallationId,
      ],
    );

    const priceMismatchSubscriptionId = randomUUID();
    await pool.query(
      "INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids) VALUES($1,$2,'Legacy price mismatch','starter','live',$3,'[\"price-app\"]'::JSONB)",
      [priceMismatchInstallationId, starterOwnerId, `legacy-price-${suffix}.apps.example.com`],
    );
    await pool.query(
      "INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,worker_node_id,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb) VALUES($1,$2,'price-app','live',$3,$4,$5,384,250,3)",
      [randomUUID(), priceMismatchInstallationId, `legacy-price-app-${suffix}.apps.example.com`, `legacy-price-${suffix}`, workerId],
    );
    await pool.query(
      "INSERT INTO subscriptions(id,user_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents,installation_id) VALUES($1,$2,$3,'active',$4,$5,$6)",
      [priceMismatchSubscriptionId, starterOwnerId, `sub_legacy_price_${suffix}`, starter.infrastructureMonthlyCents + 1, starter.monthlyCents - starter.infrastructureMonthlyCents, priceMismatchInstallationId],
    );
    await expect(backfillLegacyPaidPlanCapacity(pool, {
      plans: config.plans,
      memorySafetyReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB,
    })).rejects.toThrow(/subscription price split that does not match configured plan starter/);
    expect((await pool.query(
      "SELECT id,worker_node_id FROM installations WHERE id=ANY($1::UUID[]) ORDER BY id",
      [[starterInstallationId, scaleInstallationId, priceMismatchInstallationId]],
    )).rows.every((row) => row.worker_node_id === null)).toBe(true);
    expect((await pool.query(
      "SELECT COUNT(*)::INT count FROM installation_capacity_allocations WHERE installation_id=ANY($1::UUID[])",
      [[starterInstallationId, scaleInstallationId, priceMismatchInstallationId]],
    )).rows[0].count).toBe(0);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE id=$1", [priceMismatchSubscriptionId]);

    await expect(backfillLegacyPaidPlanCapacity(pool, {
      plans: config.plans,
      memorySafetyReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB,
    })).resolves.toEqual({ eligibleInstallations: 2, createdAllocations: 2, existingAllocations: 0, updatedInstallationAffinities: 2 });

    const allocationRows = (await pool.query(
      `SELECT id,installation_id,worker_node_id,plan,allocation_memory_mb,allocation_cpu_millis,
              allocation_storage_gb,allocation_max_services,generation,state,source_checkout_hold_id
       FROM installation_capacity_allocations
       WHERE installation_id=ANY($1::UUID[])
       ORDER BY installation_id`,
      [[starterInstallationId, scaleInstallationId]],
    )).rows;
    const expectedByInstallation = new Map([
      [starterInstallationId, starter],
      [scaleInstallationId, scale],
    ]);
    expect(allocationRows).toHaveLength(2);
    for (const allocation of allocationRows) {
      const plan = expectedByInstallation.get(allocation.installation_id)!;
      expect(allocation).toMatchObject({
        worker_node_id: workerId,
        plan: plan.id,
        allocation_memory_mb: plan.memoryMb,
        allocation_cpu_millis: plan.cpu * 1_000,
        allocation_storage_gb: plan.storageGb,
        allocation_max_services: plan.maxServices,
        generation: "1",
        state: "active",
        source_checkout_hold_id: null,
      });
    }
    expect((await pool.query(
      "SELECT installation_id,event_type,generation,reason FROM installation_capacity_allocation_events WHERE installation_id=ANY($1::UUID[]) ORDER BY installation_id",
      [[starterInstallationId, scaleInstallationId]],
    )).rows).toEqual(allocationRows.map((allocation) => ({
      installation_id: allocation.installation_id,
      event_type: "allocated",
      generation: "1",
      reason: "legacy_active_subscription_backfill",
    })));
    expect((await pool.query(
      "SELECT id,worker_node_id FROM installations WHERE id=ANY($1::UUID[]) ORDER BY id",
      [[starterInstallationId, scaleInstallationId]],
    )).rows).toEqual(allocationRows.map((allocation) => ({ id: allocation.installation_id, worker_node_id: workerId })));

    const immutableAllocationIds = allocationRows.map((allocation) => allocation.id);
    await expect(backfillLegacyPaidPlanCapacity(pool, {
      plans: config.plans,
      memorySafetyReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB,
    })).resolves.toEqual({ eligibleInstallations: 2, createdAllocations: 0, existingAllocations: 2, updatedInstallationAffinities: 0 });
    expect((await pool.query(
      "SELECT id FROM installation_capacity_allocations WHERE installation_id=ANY($1::UUID[]) ORDER BY installation_id",
      [[starterInstallationId, scaleInstallationId]],
    )).rows.map((row) => row.id)).toEqual(immutableAllocationIds);
    expect((await pool.query(
      "SELECT COUNT(*)::INT count FROM installation_capacity_allocation_events WHERE installation_id=ANY($1::UUID[])",
      [[starterInstallationId, scaleInstallationId]],
    )).rows[0].count).toBe(2);

    await pool.query("ALTER TABLE subscriptions ALTER COLUMN infrastructure_monthly_cents DROP NOT NULL");
    await pool.query(
      "INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids) VALUES($1,$2,'Legacy null price','starter','live',$3,'[\"null-price-app\"]'::JSONB)",
      [nullPriceInstallationId, starterOwnerId, `legacy-null-price-${suffix}.apps.example.com`],
    );
    await pool.query(
      "INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,worker_node_id,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb) VALUES($1,$2,'null-price-app','live',$3,$4,$5,384,250,3)",
      [randomUUID(), nullPriceInstallationId, `legacy-null-price-app-${suffix}.apps.example.com`, `legacy-null-price-${suffix}`, workerId],
    );
    const nullPriceSubscriptionId = randomUUID();
    await pool.query(
      "INSERT INTO subscriptions(id,user_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents,installation_id) VALUES($1,$2,$3,'active',NULL,$4,$5)",
      [nullPriceSubscriptionId, starterOwnerId, `sub_legacy_null_price_${suffix}`, starter.monthlyCents - starter.infrastructureMonthlyCents, nullPriceInstallationId],
    );
    await expect(backfillLegacyPaidPlanCapacity(pool, {
      plans: config.plans,
      memorySafetyReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB,
    })).rejects.toThrow(/subscription price split that does not match configured plan starter/);
    expect((await pool.query("SELECT worker_node_id FROM installations WHERE id=$1", [nullPriceInstallationId])).rows[0].worker_node_id).toBeNull();
    expect((await pool.query("SELECT COUNT(*)::INT count FROM installation_capacity_allocations WHERE installation_id=$1", [nullPriceInstallationId])).rows[0].count).toBe(0);
    expect((await pool.query(
      "SELECT id FROM installation_capacity_allocations WHERE installation_id=ANY($1::UUID[]) ORDER BY installation_id",
      [[starterInstallationId, scaleInstallationId]],
    )).rows.map((row) => row.id)).toEqual(immutableAllocationIds);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE id=$1", [nullPriceSubscriptionId]);

    await pool.query(
      "INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids) VALUES($1,$2,'Cross tenant legacy','starter','live',$3,'[\"cross-app\"]'::JSONB)",
      [crossTenantInstallationId, starterOwnerId, `legacy-cross-${suffix}.apps.example.com`],
    );
    await pool.query(
      "INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,worker_node_id,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb) VALUES($1,$2,'cross-app','live',$3,$4,$5,384,250,3)",
      [randomUUID(), crossTenantInstallationId, `legacy-cross-app-${suffix}.apps.example.com`, `legacy-cross-${suffix}`, workerId],
    );
    const crossTenantSubscriptionId = randomUUID();
    await pool.query(
      "INSERT INTO subscriptions(id,user_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents,installation_id) VALUES($1,$2,$3,'active',$4,$5,$6)",
      [crossTenantSubscriptionId, otherTenantId, `sub_legacy_cross_${suffix}`, starter.infrastructureMonthlyCents, starter.monthlyCents - starter.infrastructureMonthlyCents, crossTenantInstallationId],
    );
    await expect(backfillLegacyPaidPlanCapacity(pool, {
      plans: config.plans,
      memorySafetyReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB,
    })).rejects.toThrow(/conflicting subscription ownership/);
    expect((await pool.query("SELECT worker_node_id FROM installations WHERE id=$1", [crossTenantInstallationId])).rows[0].worker_node_id).toBeNull();
    expect((await pool.query("SELECT COUNT(*)::INT count FROM installation_capacity_allocations WHERE installation_id=$1", [crossTenantInstallationId])).rows[0].count).toBe(0);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE id=$1", [crossTenantSubscriptionId]);

    await pool.query(
      "INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids) VALUES($1,$2,'Overflow legacy','starter','live',$3,'[\"overflow-app\"]'::JSONB)",
      [overflowInstallationId, starterOwnerId, `legacy-overflow-${suffix}.apps.example.com`],
    );
    await pool.query(
      "INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,worker_node_id,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb) VALUES($1,$2,'overflow-app','live',$3,$4,$5,$6,1,1)",
      [
        randomUUID(), overflowInstallationId, `legacy-overflow-app-${suffix}.apps.example.com`, `legacy-overflow-${suffix}`, workerId,
        Math.max(0, starter.memoryMb - config.APPLICATION_MEMORY_SAFETY_RESERVE_MB + 1),
      ],
    );
    await pool.query(
      "INSERT INTO subscriptions(id,user_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents,installation_id) VALUES($1,$2,$3,'active',$4,$5,$6)",
      [randomUUID(), starterOwnerId, `sub_legacy_overflow_${suffix}`, starter.infrastructureMonthlyCents, starter.monthlyCents - starter.infrastructureMonthlyCents, overflowInstallationId],
    );
    await expect(backfillLegacyPaidPlanCapacity(pool, {
      plans: config.plans,
      memorySafetyReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB,
    })).rejects.toThrow(/exceeds configured starter quota: memoryMb/);
    expect((await pool.query("SELECT worker_node_id FROM installations WHERE id=$1", [overflowInstallationId])).rows[0].worker_node_id).toBeNull();
    expect((await pool.query("SELECT COUNT(*)::INT count FROM installation_capacity_allocations WHERE installation_id=$1", [overflowInstallationId])).rows[0].count).toBe(0);
    expect((await pool.query(
      "SELECT COUNT(*)::INT count FROM installation_capacity_allocation_events WHERE installation_id=ANY($1::UUID[])",
      [[starterInstallationId, scaleInstallationId]],
    )).rows[0].count).toBe(2);
    } finally {
      await pool.end();
      await administrativePool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
  });

  it("keeps many Suite-only quotas at zero physical capacity and atomically places clones", async () => {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const workerId = `pg-suite-only-${suffix}`;
    const secondWorkerId = `pg-suite-clone-${suffix}`;
    const customers: Array<{ userId: string; installationId: string; planId: "starter" | "scale" | "fleet" }> = [];
    const paidPlans = [
      { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 },
      { planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, maxServices: 12, infrastructureMonthlyCents: 4464, platformFeeMonthlyCents: 536 },
      { planId: "fleet", memoryMb: 24576, cpuMillis: 8000, storageGb: 500, maxServices: 50, infrastructureMonthlyCents: 17857, platformFeeMonthlyCents: 2143 },
    ] as const;
    try {
      await pool.query("UPDATE worker_nodes SET status='draining'");
      await repository.registerWorkerNode({ id: workerId, name: `Suite only ${suffix}`, privateAddress: "10.70.0.96", machineType: "exact-one-app", capacityMemoryMb: 640, capacityCpuMillis: 250, capacityStorageGb: 1, systemReserveMemoryMb: 256 });
      for (let index = 0; index < 21; index += 1) {
        const selectedPlan = paidPlans[index % paidPlans.length];
        const user = await repository.createUser({ email: `pg-suite-only-${suffix}-${index}@example.com`, displayName: `PostgreSQL Suite customer ${index}`, passwordHash: "unused" });
        const installation = await repository.createInstallation({ userId: user.id, appIds: [], name: `PostgreSQL Suite only ${index}`, plan: selectedPlan.planId, state: "planned", hostname: `pg-suite-only-${suffix}-${index}.apps.example.com`, customDomains: [] });
        const hold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: `checkout:suite:${suffix}:${index}`, requestedPlan: selectedPlan.planId, requestedAppIds: [], infrastructureMonthlyCents: selectedPlan.infrastructureMonthlyCents, platformFeeMonthlyCents: selectedPlan.platformFeeMonthlyCents, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), planCapacity: selectedPlan, reservations: [] });
        expect(hold).toBeTruthy();
        const customerId = await repository.getOrCreateStripeCustomer(user.id, async () => `cus_suite_${suffix}_${index}`);
        const sessionId = `cs_suite_${suffix}_${index}`;
        await repository.attachCheckoutSession({ holdId: hold!.id, userId: user.id, stripeCustomerId: customerId, stripeCheckoutSessionId: sessionId, stripeCheckoutExpiresAt: new Date(Date.now() + 35 * 60_000).toISOString() });
        expect(await repository.processPaidCheckout({ eventId: `evt_suite_${suffix}_${index}`, eventType: "checkout.session.completed", holdId: hold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: sessionId, stripeCustomerId: customerId, providerSubscriptionId: `sub_suite_${suffix}_${index}`, infrastructureMonthlyCents: selectedPlan.infrastructureMonthlyCents, platformFeeMonthlyCents: selectedPlan.platformFeeMonthlyCents })).toBe(true);
        customers.push({ userId: user.id, installationId: installation.id, planId: selectedPlan.planId });
      }

      expect((await repository.getWorkerNodeActivity(workerId))?.node).toMatchObject({ reservedMemoryMb: 0, reservedCpuMillis: 0, reservedStorageGb: 0 });
      expect(await repository.getInstallationCapacityAllocation(customers[0].userId, customers[0].installationId)).toMatchObject({ planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 });
      expect(await repository.getInstallationCapacityAllocation(customers[1].userId, customers[1].installationId)).toMatchObject({ planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, maxServices: 12 });
      expect(await repository.getInstallationCapacityAllocation(customers[2].userId, customers[2].installationId)).toMatchObject({ planId: "fleet", memoryMb: 24576, cpuMillis: 8000, storageGb: 500, maxServices: 50 });
      const [firstClone] = await repository.createApplicationInstances(customers[0].installationId, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192);
      expect(firstClone.workerNodeId).toBe(workerId);
      expect((await repository.getWorkerNodeActivity(workerId))?.node).toMatchObject({ reservedMemoryMb: 384, reservedCpuMillis: 250, reservedStorageGb: 1 });

      expect(await repository.canReserveOnInstallationWorker(customers[1].installationId, { memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }, 192)).toBe(false);
      await expect(repository.createApplicationInstances(customers[1].installationId, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192)).rejects.toThrow(/worker pool cannot reserve/);
      expect((await repository.getInstallation(customers[1].userId, customers[1].installationId))?.applications).toHaveLength(0);

      await repository.registerWorkerNode({ id: secondWorkerId, name: `Suite clones ${suffix}`, privateAddress: "10.70.0.97", machineType: "shared-apps", capacityMemoryMb: 2048, capacityCpuMillis: 1000, capacityStorageGb: 10, systemReserveMemoryMb: 512 });
      const [secondClone] = await repository.createApplicationInstances(customers[0].installationId, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192);
      expect(secondClone.workerNodeId).toBe(secondWorkerId);
      await expect(repository.createApplicationInstances(customers[0].installationId, [{ appId: "tiny", memoryReservationMb: 1, cpuReservationMillis: 1, storageReservationGb: 1 }], "apps.example.com", 192)).rejects.toThrow(/plan quota cannot contain/);
      expect((await repository.getInstallation(customers[0].userId, customers[0].installationId))?.applications).toHaveLength(2);
    } finally {
      await repository.setWorkerNodeMode(workerId, "draining").catch(() => undefined);
      await repository.setWorkerNodeMode(secondWorkerId, "draining").catch(() => undefined);
      await repository.close();
    }
  });

  it("holds, consumes, and idempotently downsizes a durable logical paid plan quota", async () => {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const workerId = `pg-plan-${suffix}`;
    try {
      await pool.query("UPDATE worker_nodes SET status='draining'");
      await repository.registerWorkerNode({ id: workerId, name: `PostgreSQL plan ${suffix}`, privateAddress: "10.70.0.93", machineType: "e2-standard-2", capacityMemoryMb: 8_192, capacityCpuMillis: 2_000, capacityStorageGb: 100, systemReserveMemoryMb: 512 });
      const installation = await repository.createInstallation({ userId: ownerId, appIds: ["uptime-kuma"], name: `PostgreSQL plan ${suffix}`, plan: "starter", state: "planned", hostname: `pg-plan-${suffix}.apps.example.com`, customDomains: [] });
      const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
      const hold = await repository.acquireCheckoutCapacityHold({ userId: ownerId, installationId: installation.id, idempotencyKey: `checkout:${suffix}`, requestedPlan: "starter", requestedAppIds: ["uptime-kuma"], infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: application.memoryReservationMb, cpuReservationMillis: application.cpuReservationMillis, storageReservationGb: application.storageReservationGb }] });
      expect(hold).toBeTruthy();
      const customerId = await repository.getOrCreateStripeCustomer(ownerId, async () => `cus_plan_${suffix}`);
      const subscriptionId = `sub_plan_${suffix}`;
      await repository.attachCheckoutSession({ holdId: hold!.id, userId: ownerId, stripeCustomerId: customerId, stripeCheckoutSessionId: `cs_plan_${suffix}`, stripeCheckoutExpiresAt: new Date(Date.now() + 35 * 60_000).toISOString() });
      await repository.processPaidCheckout({ eventId: `evt_plan_${suffix}`, eventType: "checkout.session.completed", holdId: hold!.id, userId: ownerId, installationId: installation.id, stripeCheckoutSessionId: `cs_plan_${suffix}`, stripeCustomerId: customerId, providerSubscriptionId: subscriptionId, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });

      const scale = await repository.acquirePlanCapacityChangeHold({ userId: ownerId, installationId: installation.id, idempotencyKey: `resize:${suffix}:scale`, requested: { planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, maxServices: 12 }, infrastructureMonthlyCents: 4464, platformFeeMonthlyCents: 536, providerSubscriptionId: subscriptionId, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), memorySafetyReserveMb: 192 });
      expect(scale).toMatchObject({ reservedDeltaMemoryMb: 4608, reservedDeltaCpuMillis: 1500, reservedDeltaStorageGb: 90 });
      expect(await repository.canReserveOnInstallationWorker(installation.id, { memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }, 192)).toBe(false);
      await expect(repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192)).rejects.toThrow(/active plan quota change hold/);
      expect((await repository.getInstallation(ownerId, installation.id))?.applications).toHaveLength(1);
      expect(await repository.consumePlanCapacityChangeHold(scale!.id, ownerId)).toMatchObject({ planId: "scale", generation: 2 });
      expect(await repository.consumePlanCapacityChangeHold(scale!.id, ownerId)).toMatchObject({ planId: "scale", generation: 2 });

      const starter = await repository.acquirePlanCapacityChangeHold({ userId: ownerId, installationId: installation.id, idempotencyKey: `resize:${suffix}:starter`, requested: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, providerSubscriptionId: subscriptionId, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), memorySafetyReserveMb: 192 });
      expect(starter).toMatchObject({ reservedDeltaMemoryMb: 0, reservedDeltaCpuMillis: 0, reservedDeltaStorageGb: 0 });
      expect(await repository.consumePlanCapacityChangeHold(starter!.id, ownerId)).toMatchObject({ planId: "starter", generation: 3 });
      expect(await repository.getInstallation(ownerId, installation.id)).toMatchObject({ plan: "starter", workerNodeId: workerId });
      expect((await repository.getWorkerNodeActivity(workerId))?.node).toMatchObject({ reservedMemoryMb: 384, reservedCpuMillis: 250, reservedStorageGb: 3 });

      await repository.updateSubscriptionStatus(subscriptionId, "canceled");
      await repository.updateSubscriptionStatus(subscriptionId, "canceled");
      expect(await repository.getInstallationCapacityAllocation(ownerId, installation.id)).toMatchObject({ planId: "starter", generation: 4, state: "suspended" });
      expect((await pool.query("SELECT COUNT(*)::INT count FROM installation_capacity_allocation_events WHERE installation_id=$1 AND event_type='suspended'", [installation.id])).rows[0].count).toBe(1);
      expect((await repository.getWorkerNodeActivity(workerId))?.node).toMatchObject({ reservedMemoryMb: 384, reservedCpuMillis: 250, reservedStorageGb: 3 });

      await repository.updateSubscriptionStatus(subscriptionId, "active");
      await repository.updateSubscriptionStatus(subscriptionId, "active");
      expect(await repository.getInstallationCapacityAllocation(ownerId, installation.id)).toMatchObject({ planId: "starter", generation: 5, state: "active", suspendedAt: undefined, releaseReason: undefined });
      expect((await pool.query("SELECT COUNT(*)::INT count FROM installation_capacity_allocation_events WHERE installation_id=$1 AND event_type='reactivated'", [installation.id])).rows[0].count).toBe(1);
    } finally {
      await repository.setWorkerNodeMode(workerId, "draining").catch(() => undefined);
      await repository.close();
    }
  });
});
