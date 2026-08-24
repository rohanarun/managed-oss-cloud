import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { loadDatabaseMigrations, runDatabaseMigrations } from "../src/server/database-migrations";
import { PostgresRepository } from "../src/server/repository";
import { PostgresSuiteStore } from "../src/server/suite-store";
import { suiteModules } from "../src/shared/suite";

const execFileAsync = promisify(execFile);
const requiredEnvironment = [
  "POSTGRES_ACCEPTANCE_SETUP_URL",
  "POSTGRES_ACCEPTANCE_CONTROL_URL",
  "POSTGRES_ACCEPTANCE_RUNTIME_URL",
] as const;
const acceptanceRequired = process.env.POSTGRES_ACCEPTANCE_REQUIRED === "true";
const acceptanceConfigured = requiredEnvironment.some((name) => Boolean(process.env[name]));
const describeAcceptance = acceptanceRequired || acceptanceConfigured ? describe : describe.skip;
const managedCapabilityRoles = [
  "managed_oss_control",
  "managed_oss_runtime",
  "managed_oss_ai",
  "managed_oss_migrator",
  "managed_oss_core_owner",
  "managed_oss_suite_owner",
] as const;

function parseDatabaseUrl(name: typeof requiredEnvironment[number]) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL shared-client acceptance test.`);
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`${name} must be a PostgreSQL URL.`);
  if (!url.username || !url.password || !url.pathname.slice(1)) throw new Error(`${name} must include an explicit user, password, and database.`);
  return { value, url, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)) };
}

async function formattedSql(pool: pg.Pool, template: string, values: string[]) {
  const placeholders = values.map((_, index) => `$${index + 1}::TEXT`).join(",");
  const result = await pool.query<{ sql: string }>(`SELECT format('${template}',${placeholders}) AS sql`, values);
  return result.rows[0].sql;
}

async function configureScopedLogin(pool: pg.Pool, connection: ReturnType<typeof parseDatabaseUrl>, capability: "managed_oss_control" | "managed_oss_runtime") {
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(connection.user) || managedCapabilityRoles.includes(connection.user as typeof managedCapabilityRoles[number])) {
    throw new Error(`Acceptance login ${connection.user} must be a dedicated, non-capability PostgreSQL role.`);
  }
  const exists = (await pool.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1", [connection.user])).rowCount === 1;
  const template = `${exists ? "ALTER" : "CREATE"} ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`;
  await pool.query(await formattedSql(pool, template, [connection.user, connection.password]));
  await pool.query(await formattedSql(pool, "ALTER ROLE %I RESET ALL", [connection.user]));
  for (const role of managedCapabilityRoles) {
    await pool.query(await formattedSql(pool, "REVOKE %I FROM %I", [role, connection.user]));
  }
  await pool.query(await formattedSql(pool, "GRANT %I TO %I", [capability, connection.user]));
}

async function roleProof(pool: pg.Pool, role: string) {
  const result = await pool.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    memberships: string[];
  }>(`SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
      ARRAY(SELECT parent.rolname::TEXT FROM pg_catalog.pg_auth_members membership JOIN pg_catalog.pg_roles parent ON parent.oid=membership.roleid WHERE membership.member=r.oid ORDER BY parent.rolname)::TEXT[] memberships
    FROM pg_catalog.pg_roles r WHERE r.rolname=$1`, [role]);
  return result.rows[0];
}

function tokenOnlyClientEnvironment(overrides: Record<string, string>) {
  const inheritedNames = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR"] as const;
  const inherited = Object.fromEntries(inheritedNames.flatMap((name) => {
    const value = process.env[name];
    return typeof value === "string" ? [[name, value]] : [];
  }));
  const environment = { ...inherited, ...overrides };
  const forbidden = Object.keys(environment).filter((name) => /(?:DATABASE|POSTGRES|^PG[A-Z_])/i.test(name));
  if (forbidden.length) throw new Error(`Packaged customer clients must not receive database credentials: ${forbidden.join(", ")}`);
  return environment;
}

function recordOf(value: unknown, recordType: string) {
  const records = value && typeof value === "object" && Array.isArray((value as { records?: unknown }).records)
    ? (value as { records: Array<Record<string, unknown>> }).records
    : [];
  return records.find((record) => record.recordType === recordType);
}

describeAcceptance("mandatory PostgreSQL shared API, CLI, and MCP acceptance", () => {
  let setupPool: pg.Pool;
  let runtimeProofPool: pg.Pool;
  let repository: PostgresRepository;
  let suiteStore: PostgresSuiteStore;
  let server: Server;
  let baseUrl: string;
  let setup: ReturnType<typeof parseDatabaseUrl>;
  let control: ReturnType<typeof parseDatabaseUrl>;
  let runtime: ReturnType<typeof parseDatabaseUrl>;

  beforeAll(async () => {
    const missing = requiredEnvironment.filter((name) => !process.env[name]);
    if (missing.length) throw new Error(`PostgreSQL shared-client acceptance is required but missing ${missing.join(", ")}.`);
    if (config.DATABASE_MIGRATION_MODE !== "manual") throw new Error("PostgreSQL shared-client acceptance requires DATABASE_MIGRATION_MODE=manual so application logins cannot migrate.");

    setup = parseDatabaseUrl("POSTGRES_ACCEPTANCE_SETUP_URL");
    control = parseDatabaseUrl("POSTGRES_ACCEPTANCE_CONTROL_URL");
    runtime = parseDatabaseUrl("POSTGRES_ACCEPTANCE_RUNTIME_URL");
    expect(new Set([setup.database, control.database, runtime.database])).toEqual(new Set([setup.database]));
    expect(new Set([setup.user, control.user, runtime.user]).size).toBe(3);
    expect(control.value).not.toBe(setup.value);
    expect(runtime.value).not.toBe(setup.value);
    expect(runtime.value).not.toBe(control.value);

    setupPool = new pg.Pool({ connectionString: setup.value, ssl: false, max: 2 });
    const setupIdentity = await setupPool.query<{ current_user: string; rolsuper: boolean }>("SELECT current_user,r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname=current_user");
    expect(setupIdentity.rows[0]).toEqual({ current_user: setup.user, rolsuper: true });
    await runDatabaseMigrations(setupPool, await loadDatabaseMigrations(), { mode: "auto" });
    await configureScopedLogin(setupPool, control, "managed_oss_control");
    await configureScopedLogin(setupPool, runtime, "managed_oss_runtime");

    expect(await roleProof(setupPool, control.user)).toMatchObject({
      rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
      memberships: ["managed_oss_control"],
    });
    expect(await roleProof(setupPool, runtime.user)).toMatchObject({
      rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
      memberships: ["managed_oss_runtime"],
    });

    repository = new PostgresRepository(control.value, false);
    suiteStore = new PostgresSuiteStore(runtime.value, false);
    const app = await createApp({ repository, suiteStore, suiteEntitlementMode: "unrestricted", synchronizeSuiteEntitlements: false });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Acceptance HTTP server did not bind a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
    runtimeProofPool = new pg.Pool({ connectionString: runtime.value, ssl: false, max: 1 });
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await runtimeProofPool?.end();
    await suiteStore?.close();
    await repository?.close();
    await setupPool?.end();
  });

  it("persists one shared workspace through HTTP, packaged CLI, and packaged MCP while RLS remains transaction-local", async () => {
    const runId = randomUUID();
    const suffix = runId.replaceAll("-", "");
    const owner = request.agent(baseUrl);
    const ownerSignup = await owner.post("/api/auth/signup").send({
      displayName: "PostgreSQL Acceptance Owner",
      email: `owner-${suffix}@acceptance.example`,
      password: `acceptance-owner-${suffix}`,
    });
    expect(ownerSignup.status).toBe(201);
    const ownerId = String(ownerSignup.body.user.id);
    expect((await suiteStore.setWorkspacePlan(ownerId, "fleet"))?.plan).toBe("fleet");

    for (const module of suiteModules) {
      const enabled = await owner.post(`/api/suite/modules/${module.id}/enable`);
      expect(enabled.status, `Failed to enable registered module ${module.id}: ${JSON.stringify(enabled.body)}`).toBe(201);
    }
    const workspaceResponse = await owner.get("/api/suite/workspace");
    expect(workspaceResponse.status).toBe(200);
    const workspaceId = String(workspaceResponse.body.workspace.id);
    expect(new Set(workspaceResponse.body.workspace.enabledModuleIds)).toEqual(new Set(suiteModules.map((module) => module.id)));

    const accountResponse = await owner.post("/api/suite/modules/crm/actions/account-upsert").send({ input: {
      externalKey: `acceptance-account-${suffix}`,
      name: "Shared acceptance account",
      domain: `${suffix.slice(0, 24)}.acceptance.example`,
      idempotencyKey: `acceptance.account.${runId}`,
    } });
    expect([200, 201]).toContain(accountResponse.status);
    const account = recordOf(accountResponse.body, "account");
    expect(account?.workspaceId).toBe(workspaceId);

    for (const module of suiteModules) {
      const sentinel = await suiteStore.createRecord(ownerId, {
        moduleId: module.id,
        recordType: "acceptance-sentinel",
        title: `Registered module sentinel: ${module.id}`,
        state: "acceptance-only",
        data: { acceptanceRunId: runId, registeredRecordTypes: module.recordTypes },
      });
      expect(sentinel?.workspaceId, `Scoped runtime could not create the ${module.id} sentinel.`).toBe(workspaceId);
    }

    const tokenResponse = await owner.post("/api/suite/api-tokens").send({ name: `Acceptance clients ${suffix.slice(0, 12)}`, scopes: ["read", "write"], expiresInDays: 1 });
    expect(tokenResponse.status).toBe(201);
    const token = String(tokenResponse.body.token.token);
    const executableRoot = path.join(process.cwd(), "dist-server");
    const cliPath = path.join(executableRoot, "cli", "index.js");
    const mcpPath = path.join(executableRoot, "mcp", "index.js");
    await access(cliPath);
    await access(mcpPath);
    const clientEnvironment = tokenOnlyClientEnvironment({ SUPERSUITE_TOKEN: token, SUPERSUITE_URL: baseUrl });
    expect(Object.keys(clientEnvironment).filter((name) => /(?:DATABASE|POSTGRES|^PG[A-Z_])/i.test(name))).toEqual([]);

    const contactInput = {
      accountId: String(account?.id),
      name: "CLI-created shared contact",
      email: `contact-${suffix}@acceptance.example`,
      consentBasis: "Acceptance test uses an isolated synthetic customer.",
      idempotencyKey: `acceptance.contact.${runId}`,
    };
    const cli = await execFileAsync(process.execPath, [cliPath, "action", "crm", "contact-link", JSON.stringify(contactInput)], {
      cwd: process.cwd(), env: clientEnvironment, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(cli.stderr).toBe("");
    const cliPayload = JSON.parse(cli.stdout);
    const contact = recordOf(cliPayload, "contact");
    expect(contact).toMatchObject({ workspaceId, moduleId: "crm", recordType: "contact" });

    const mcp = new Client({ name: "postgres-shared-acceptance", version: "0.3.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: clientEnvironment, stderr: "pipe" });
    let threadPayload: Record<string, unknown>;
    try {
      await mcp.connect(transport);
      const mcpWorkspace = await mcp.callTool({ name: "suite_workspace", arguments: {} });
      expect((mcpWorkspace.structuredContent as { workspace?: { id?: string } } | undefined)?.workspace?.id).toBe(workspaceId);
      const opened = await mcp.callTool({ name: "inbox_thread_open", arguments: {
        contactId: String(contact?.id),
        channel: "email",
        subject: "MCP-created shared Inbox thread",
        message: "This synthetic message proves the CRM-to-Inbox shared workspace path.",
        idempotencyKey: `acceptance.thread.${runId}`,
      } });
      expect(opened.isError).not.toBe(true);
      threadPayload = opened.structuredContent as Record<string, unknown>;
    } finally {
      await mcp.close();
    }
    const conversation = recordOf(threadPayload!, "conversation");
    const message = recordOf(threadPayload!, "message");
    expect(conversation).toMatchObject({ workspaceId, moduleId: "inbox", recordType: "conversation" });
    expect(message).toMatchObject({ workspaceId, moduleId: "inbox", recordType: "message" });

    const cliInbox = await execFileAsync(process.execPath, [cliPath, "list", "inbox", "conversation"], {
      cwd: process.cwd(), env: clientEnvironment, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(JSON.parse(cliInbox.stdout).records.map((record: { id: string }) => record.id)).toContain(conversation?.id);
    const httpRecords = await owner.get("/api/suite/records?limit=200");
    expect(httpRecords.status).toBe(200);
    const sharedIds = new Set(httpRecords.body.records.map((record: { id: string }) => record.id));
    for (const item of [account, contact, conversation, message]) expect(sharedIds.has(String(item?.id))).toBe(true);

    const sentinels = await setupPool.query<{ module_id: string; workspace_id: string }>(
      "SELECT module_id,workspace_id::TEXT FROM suite_records WHERE data->>'acceptanceRunId'=$1 ORDER BY module_id",
      [runId],
    );
    expect(sentinels.rows).toHaveLength(suiteModules.length);
    expect(new Set(sentinels.rows.map((row) => row.module_id))).toEqual(new Set(suiteModules.map((module) => module.id)));
    expect(new Set(sentinels.rows.map((row) => row.workspace_id))).toEqual(new Set([workspaceId]));
    const durableSharedRows = await setupPool.query<{ id: string; workspace_id: string }>(
      "SELECT id::TEXT,workspace_id::TEXT FROM suite_records WHERE id=ANY($1::UUID[]) ORDER BY id",
      [[account?.id, contact?.id, conversation?.id, message?.id]],
    );
    expect(durableSharedRows.rows).toHaveLength(4);
    expect(new Set(durableSharedRows.rows.map((row) => row.workspace_id))).toEqual(new Set([workspaceId]));

    const viewer = request.agent(baseUrl);
    const viewerSignup = await viewer.post("/api/auth/signup").send({ displayName: "Acceptance Viewer", email: `viewer-${suffix}@acceptance.example`, password: `acceptance-viewer-${suffix}` });
    expect(viewerSignup.status).toBe(201);
    const viewerId = String(viewerSignup.body.user.id);
    expect((await owner.post("/api/suite/members").send({ email: `viewer-${suffix}@acceptance.example`, role: "viewer" })).status).toBe(201);
    const viewerLeave = await suiteStore.createRecord(ownerId, {
      moduleId: "people",
      recordType: "leave-request",
      title: "Viewer private leave",
      state: "pending-human-decision",
      data: { subjectUserId: viewerId, managerRef: ownerId },
    });
    const publishedPolicy = await suiteStore.createRecord(ownerId, {
      moduleId: "people",
      recordType: "people-policy",
      title: "Acceptance policy",
      state: "published",
      data: { contentHash: "a".repeat(64) },
    });
    const ownerLeave = await suiteStore.createRecord(ownerId, {
      moduleId: "people",
      recordType: "leave-request",
      title: "Owner private leave",
      state: "pending-human-decision",
      data: { subjectUserId: ownerId, managerRef: ownerId },
    });
    if (!viewerLeave || !publishedPolicy || !ownerLeave) throw new Error("PostgreSQL visibility fixtures were not persisted.");
    const viewerRecords = await viewer.get("/api/suite/records?limit=200");
    expect(viewerRecords.body.records.map((record: { id: string }) => record.id)).toContain(contact?.id);
    expect(viewerRecords.body.records.map((record: { id: string }) => record.id)).toEqual(expect.arrayContaining([viewerLeave.id, publishedPolicy.id]));
    expect(viewerRecords.body.records.map((record: { id: string }) => record.id)).not.toContain(ownerLeave.id);
    expect(await suiteStore.getRecord(viewerId, viewerLeave.id)).toMatchObject({ id: viewerLeave.id, workspaceId });
    expect(await suiteStore.getRecord(viewerId, ownerLeave.id)).toBeUndefined();
    expect((await suiteStore.listRecords(viewerId, { moduleId: "people", limit: 1 })).map((record) => record.id)).not.toContain(ownerLeave.id);
    expect((await suiteStore.listRecords(ownerId, { moduleId: "people", limit: 200 })).map((record) => record.id)).toEqual(expect.arrayContaining([viewerLeave.id, publishedPolicy.id, ownerLeave.id]));
    expect((await suiteStore.runInWorkspaceTransaction(viewerId, () => suiteStore.getRecord(viewerId, ownerLeave.id)))?.id).toBe(ownerLeave.id);
    const viewerWrite = await viewer.post("/api/suite/modules/crm/actions/contact-link").send({ input: { ...contactInput, email: `denied-${suffix}@acceptance.example`, idempotencyKey: `acceptance.viewer.denied.${runId}` } });
    expect(viewerWrite.status).toBe(403);

    const outsider = request.agent(baseUrl);
    const outsiderSignup = await outsider.post("/api/auth/signup").send({ displayName: "Acceptance Outsider", email: `outsider-${suffix}@acceptance.example`, password: `acceptance-outsider-${suffix}` });
    expect(outsiderSignup.status).toBe(201);
    const outsiderId = String(outsiderSignup.body.user.id);
    const outsiderWorkspaceResponse = await outsider.get("/api/suite/workspace");
    expect(outsiderWorkspaceResponse.status).toBe(200);
    const outsiderWorkspaceId = String(outsiderWorkspaceResponse.body.workspace.id);
    expect(outsiderWorkspaceId).not.toBe(workspaceId);
    const outsiderRecords = await outsider.get("/api/suite/records?limit=200");
    expect(outsiderRecords.body.records.some((record: { id: string }) => sharedIds.has(record.id))).toBe(false);

    const firstLease = await runtimeProofPool.connect();
    let backendPid: number;
    try {
      await firstLease.query("BEGIN");
      backendPid = Number((await firstLease.query("SELECT pg_backend_pid() pid")).rows[0].pid);
      const context = await firstLease.query("SELECT * FROM managed_oss_workspace_context_for_user($1,'none')", [ownerId]);
      expect(String(context.rows[0].workspace_id)).toBe(workspaceId);
      expect((await firstLease.query("SELECT current_setting('app.workspace_id',TRUE) workspace_id")).rows[0].workspace_id).toBe(workspaceId);
      expect(Number((await firstLease.query("SELECT COUNT(*)::INT count FROM suite_records WHERE data->>'acceptanceRunId'=$1", [runId])).rows[0].count)).toBe(suiteModules.length);
      await firstLease.query("COMMIT");
    } finally {
      firstLease.release();
    }

    const reusedLease = await runtimeProofPool.connect();
    try {
      await reusedLease.query("BEGIN");
      expect(Number((await reusedLease.query("SELECT pg_backend_pid() pid")).rows[0].pid)).toBe(backendPid!);
      expect([null, ""]).toContain((await reusedLease.query("SELECT current_setting('app.workspace_id',TRUE) workspace_id")).rows[0].workspace_id);
      expect(Number((await reusedLease.query("SELECT COUNT(*)::INT count FROM suite_records")).rows[0].count)).toBe(0);
      const outsiderContext = await reusedLease.query("SELECT * FROM managed_oss_workspace_context_for_user($1,'none')", [outsiderId]);
      expect(String(outsiderContext.rows[0].workspace_id)).toBe(outsiderWorkspaceId);
      expect(Number((await reusedLease.query("SELECT COUNT(*)::INT count FROM suite_records WHERE data->>'acceptanceRunId'=$1", [runId])).rows[0].count)).toBe(0);
      await expect(reusedLease.query(
        "INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,'crm','acceptance-cross-tenant','Denied','active','{}'::JSONB)",
        [randomUUID(), workspaceId],
      )).rejects.toMatchObject({ code: "42501" });
      await reusedLease.query("ROLLBACK");
    } finally {
      try { await reusedLease.query("ROLLBACK"); } catch {}
      reusedLease.release();
    }
  }, 120_000);
});
