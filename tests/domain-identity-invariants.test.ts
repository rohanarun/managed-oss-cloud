import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSuiteStore } from "../src/server/suite-store.js";

const migrationUrl = new URL("../db/migrations/018-domain-identity-invariants.sql", import.meta.url);
const preflightUrl = new URL("../deploy/google-cloud/database/preflight-migration-018-domain-identities.sql", import.meta.url);
const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function normalizedSql(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueIndexDefinitions(sql: string) {
  return Object.fromEntries([...sql.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+suite_records\((.*?)\)\s+WHERE\s+(.*?);/gs)].map((match) => [
    match[1],
    { keys: normalizedSql(match[2]), predicate: normalizedSql(match[3]) },
  ]));
}

function duplicatePreflightDefinitions(sql: string) {
  return Object.fromEntries([...sql.matchAll(/SELECT\s+'(\w+)'\s+AS\s+invariant_name,\s+COUNT\(\*\)::bigint\s+AS\s+duplicate_group_count\s+FROM\s+\(\s*SELECT\s+(.*?)\s+FROM\s+suite_records\s+WHERE\s+(.*?)\s+GROUP BY\s+(.*?)\s+HAVING COUNT\(\*\) > 1[\s\S]*?\) AS duplicate_groups/g)].map((match) => [
    match[1],
    { keys: normalizedSql(match[2]), predicate: normalizedSql(match[3]), groupBy: normalizedSql(match[4]) },
  ]));
}

const expectedIndexes = {
  suite_core_webhook_delivery_unique: {
    keys: "workspace_id,(data->>'endpointId'),(data->>'deliveryId')",
    predicate: "module_id='automate' AND record_type='trigger-event' AND COALESCE(data->>'endpointId','')<>'' AND COALESCE(data->>'deliveryId','')<>''",
  },
  suite_core_inbox_delivery_unique: {
    keys: "workspace_id,(data->>'deliveryId')",
    predicate: "module_id='inbox' AND record_type='message' AND COALESCE(data->>'deliveryId','')<>''",
  },
  suite_core_crm_external_key_unique: {
    keys: "workspace_id,(data->>'externalKey')",
    predicate: "module_id='crm' AND record_type='account' AND COALESCE(data->>'externalKey','')<>''",
  },
  suite_core_feedback_vote_unique: {
    keys: "workspace_id,(data->>'requestId'),(data->>'voterKeyHash')",
    predicate: "module_id='feedback' AND record_type='feedback-vote' AND COALESCE(data->>'requestId','')<>'' AND COALESCE(data->>'voterKeyHash','')<>''",
  },
  suite_core_active_route_unique: {
    keys: "workspace_id,(data->>'routeKey')",
    predicate: "module_id='links' AND record_type='link-route' AND state<>'disabled' AND COALESCE(data->>'routeKey','')<>''",
  },
  suite_core_link_event_unique: {
    keys: "workspace_id,(data->>'eventId')",
    predicate: "module_id='links' AND record_type='link-event' AND COALESCE(data->>'eventId','')<>''",
  },
  suite_premium_project_key_unique: {
    keys: "workspace_id,(data->>'key')",
    predicate: "module_id='projects' AND record_type='project' AND COALESCE(data->>'key','')<>''",
  },
  suite_premium_stream_key_unique: {
    keys: "workspace_id,(data->>'key')",
    predicate: "module_id='channels' AND record_type='stream' AND COALESCE(data->>'key','')<>''",
  },
  suite_premium_item_sku_unique: {
    keys: "workspace_id,(data->>'sku')",
    predicate: "module_id='operations' AND record_type='item' AND COALESCE(data->>'sku','')<>''",
  },
  suite_premium_attachment_snapshot_unique: {
    keys: "workspace_id,(data->>'collectionId'),(data->>'recordId'),(data->>'contentHash'),(data->>'sourceVersion'),(data->>'sourceSnapshotHash')",
    predicate: "module_id='assistant' AND record_type='source-attachment' AND COALESCE(data->>'collectionId','')<>'' AND COALESCE(data->>'recordId','')<>''",
  },
  suite_events_payment_provider_receipt_unique: {
    keys: "workspace_id,(data->>'provider'),(data->>'providerReceiptId')",
    predicate: "module_id='events' AND record_type='payment-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>''",
  },
  suite_events_refund_provider_receipt_unique: {
    keys: "workspace_id,(data->>'provider'),(data->>'providerReceiptId')",
    predicate: "module_id='events' AND record_type='refund-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>''",
  },
  suite_events_scanner_receipt_unique: {
    keys: "workspace_id,(data->>'scannerReceiptId')",
    predicate: "module_id='events' AND record_type='check-in-receipt' AND COALESCE(data->>'scannerReceiptId','')<>''",
  },
  suite_events_ticket_ordinal_unique: {
    keys: "workspace_id,(data->>'reservationId'),(data->>'ordinal')",
    predicate: "module_id='events' AND record_type='ticket' AND COALESCE(data->>'reservationId','')<>'' AND COALESCE(data->>'ordinal','')<>''",
  },
  suite_people_ack_subject_receipt_unique: {
    keys: "workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId')",
    predicate: "module_id='people' AND record_type='policy-acknowledgement' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>''",
  },
  suite_people_leave_subject_receipt_unique: {
    keys: "workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId')",
    predicate: "module_id='people' AND record_type='leave-request' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>''",
  },
  suite_people_attendance_source_receipt_unique: {
    keys: "workspace_id,(data->>'subjectUserId'),(data->>'sourceReceiptId')",
    predicate: "module_id='people' AND record_type='attendance' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'sourceReceiptId','')<>''",
  },
  suite_people_correction_receipt_unique: {
    keys: "workspace_id,(data->>'correctionReceiptId')",
    predicate: "module_id='people' AND record_type='attendance-correction' AND COALESCE(data->>'correctionReceiptId','')<>''",
  },
  suite_people_review_cycle_unique: {
    keys: "workspace_id,(data->>'profileId'),(data->>'cycleKey')",
    predicate: "module_id='people' AND record_type='people-review' AND COALESCE(data->>'profileId','')<>'' AND COALESCE(data->>'cycleKey','')<>''",
  },
  suite_people_submission_receipt_unique: {
    keys: "workspace_id,(data->>'submittedBy'),(data->>'submissionReceiptId')",
    predicate: "module_id='people' AND record_type='review-submission' AND COALESCE(data->>'submittedBy','')<>'' AND COALESCE(data->>'submissionReceiptId','')<>''",
  },
  suite_people_revocation_source_receipt_unique: {
    keys: "workspace_id,(data->>'system'),(data->>'sourceReceiptId')",
    predicate: "module_id='people' AND record_type='access-revocation-receipt' AND COALESCE(data->>'system','')<>'' AND COALESCE(data->>'sourceReceiptId','')<>''",
  },
  suite_live_consent_subject_receipt_unique: {
    keys: "workspace_id,(data->>'participantRef'),(data->>'subjectReceiptId')",
    predicate: "module_id='live' AND record_type='media-consent-receipt' AND COALESCE(data->>'participantRef','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>''",
  },
  suite_metering_source_event_unique: {
    keys: "workspace_id,(data->>'sourceEventId')",
    predicate: "module_id='metering' AND record_type='usage-event' AND COALESCE(data->>'sourceEventId','')<>''",
  },
  suite_metering_invoice_provider_receipt_unique: {
    keys: "workspace_id,(data->>'provider'),(data->>'providerReceiptId')",
    predicate: "module_id='metering' AND record_type='invoice-payment-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>''",
  },
} as const;

describe("domain identity migration contract", () => {
  it("defines the complete expected key and predicate for every migration 018 unique index", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(uniqueIndexDefinitions(sql)).toEqual(expectedIndexes);
  });

  it("preflights all 24 migration identities without returning customer key values", async () => {
    const sql = await readFile(preflightUrl, "utf8");
    const definitions = duplicatePreflightDefinitions(sql);
    expect(Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, { keys: definition.keys, predicate: definition.predicate }]))).toEqual(expectedIndexes);
    for (const definition of Object.values(definitions)) expect(definition.groupBy).toBe(definition.keys);
    expect(sql.match(/AS invariant_name/g)).toHaveLength(24);
    expect(sql).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    expect(sql).toContain("SET LOCAL search_path = pg_catalog, public;");
    expect(sql).toContain("ROLLBACK;");
    expect(sql).toContain("WHEN to_regclass('public.suite_records') IS NULL THEN $missing_suite_records$");
    expect(sql).toContain("\\gexec");
    const missingRelationBranch = sql.slice(sql.indexOf("$missing_suite_records$") + "$missing_suite_records$".length, sql.indexOf("$missing_suite_records$", sql.indexOf("$missing_suite_records$") + 1));
    expect([...missingRelationBranch.matchAll(/\('([a-z0-9_]+)'\)/g)].map((match) => match[1]).sort()).toEqual(Object.keys(expectedIndexes).sort());
    expect(sql).toContain("HAVING COUNT(*) > 1\n    AND (data->>'contentHash') IS NOT NULL\n    AND (data->>'sourceVersion') IS NOT NULL\n    AND (data->>'sourceSnapshotHash') IS NOT NULL");
    expect(sql).not.toMatch(/array_agg|string_agg|json_agg|jsonb_agg/);
  });
});

describePostgres("PostgreSQL domain identity invariants", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false });
  const store = new PostgresSuiteStore(databaseUrl!, false);
  const firstOwnerId = randomUUID();
  const secondOwnerId = randomUUID();
  let firstWorkspaceId = "";
  let secondWorkspaceId = "";

  beforeAll(async () => {
    await store.initialize();
    const suffix = randomUUID().replaceAll("-", "");
    await pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$2,'unused'),($3,$4,$4,'unused')", [firstOwnerId, `identity-first-${suffix}@example.com`, secondOwnerId, `identity-second-${suffix}@example.com`]);
    firstWorkspaceId = (await store.getOrCreateWorkspace(firstOwnerId)).id;
    secondWorkspaceId = (await store.getOrCreateWorkspace(secondOwnerId)).id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1::UUID[])", [[firstOwnerId, secondOwnerId]]).catch(() => undefined);
    await store.close();
    await pool.end();
  });

  async function insertRecord(workspaceId: string, moduleId: string, recordType: string, title: string, data: Record<string, unknown>) {
    return pool.query("INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,$3,$4,$5,'active',$6::JSONB)", [randomUUID(), workspaceId, moduleId, recordType, title, JSON.stringify(data)]);
  }

  it("rejects scoped and workspace-global identity collisions while allowing their intended neighboring scopes", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const endpointId = `endpoint-${suffix}`;
    const otherEndpointId = `other-endpoint-${suffix}`;
    const deliveryId = `delivery-${suffix}`;
    await insertRecord(firstWorkspaceId, "automate", "trigger-event", "First scoped delivery", { endpointId, deliveryId });
    await expect(insertRecord(firstWorkspaceId, "automate", "trigger-event", "Same delivery in another endpoint", { endpointId: otherEndpointId, deliveryId })).resolves.toBeTruthy();
    await expect(insertRecord(firstWorkspaceId, "automate", "trigger-event", "Duplicate scoped delivery", { endpointId, deliveryId })).rejects.toMatchObject({ code: "23505", constraint: "suite_core_webhook_delivery_unique" });
    await expect(insertRecord(secondWorkspaceId, "automate", "trigger-event", "Same scoped identity in another workspace", { endpointId, deliveryId })).resolves.toBeTruthy();

    const eventId = `event-${suffix}`;
    await insertRecord(firstWorkspaceId, "links", "link-event", "First global event", { eventId });
    await expect(insertRecord(firstWorkspaceId, "links", "link-event", "Duplicate global event", { eventId })).rejects.toMatchObject({ code: "23505", constraint: "suite_core_link_event_unique" });
    await expect(insertRecord(secondWorkspaceId, "links", "link-event", "Same global event in another workspace", { eventId })).resolves.toBeTruthy();
  });
});
