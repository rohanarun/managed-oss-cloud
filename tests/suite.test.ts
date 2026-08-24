import { createHash } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";
import { suiteAiReadScopes, suiteModules, suitePlanAllows, suiteToolName } from "../src/shared/suite";
import { suiteActions, suiteActionsByModule } from "../src/shared/suite-actions";
import { executeSuiteAction } from "../src/server/suite-engine";
import { executeFirstPartyGrowthAction } from "../src/server/first-party-growth-engine";
import { suiteStorageAccounting } from "../src/shared/suite-quotas";

function idempotency(label: string) { return `${label}.idempotency.0001`; }
function approval(userId: string, label: string) { return { approved: true, approvedBy: userId, approvedAt: new Date().toISOString(), decisionId: `${label}.approval.0001`, reason: `Reviewed the exact ${label} version and public effect.` }; }
function recordOf(response: request.Response, recordType: string) { return response.body.records?.find((record: { recordType: string }) => record.recordType === recordType); }
function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }

describe("MIT-native shared suite", () => {
  it("defines every requested rewrite with deterministic CLI and MCP names", () => {
    expect(suiteModules.map((module) => module.inspiredBy)).toEqual([
      "Activepieces", "Postiz", "Chatwoot", "Frappe CRM", "Vikunja", "Fider", "BookStack", "Slash",
      "KingSumo", "Testimonial collection tools", "QR and link-in-bio tools", "Public consent and GPC standards", "Public search measurement standards",
      "Public bookkeeping and time-tracking patterns", "CloudEvents and public notification patterns", "Public recruiting workflow standards", "Open document and canvas collaboration standards",
      "Public scheduling and iCalendar standards", "Public JSON Schema and accessibility standards", "OpenFeature and public experimentation standards",
      "Public electronic-signature workflow standards",
      "Public permission-based email marketing standards",
      "Public relational-data and spreadsheet patterns", "Public meeting transcript and action-ledger patterns", "Public business-intelligence and measurement patterns",
      "Public learning-management and credential patterns", "Public forum and community-management patterns",
      "Public event, ticketing, and access-control patterns", "Public HRIS and employment-record patterns", "Public usage-metering and billing-ledger patterns",
      "Public risk, control, and audit-evidence patterns", "Public livestream, chat, and media-consent patterns",
      "Plane", "Nextcloud", "Zulip", "ERPNext", "LibreChat",
    ]);
    expect(suiteModules).toHaveLength(37);
    expect(suiteActions.length).toBe([...suiteActionsByModule.values()].reduce((sum, actions) => sum + actions.length, 0));
    expect(new Set(suiteModules.map((module) => module.id)).size).toBe(suiteModules.length);
    expect(suiteModules.every((module) => module.recordTypes.length > 0 && module.aiCapabilities.length > 0)).toBe(true);
    expect(suiteToolName("brand-pages", "create")).toBe("brand_pages_create");
    expect(suiteModules.every((module) => (suiteActionsByModule.get(module.id)?.length ?? 0) >= 2)).toBe(true);
  });

  it("publishes typed domain actions for every module without generic mutation aliases", () => {
    for (const module of suiteModules) {
      const actions = suiteActionsByModule.get(module.id) ?? [];
      expect(actions.length).toBeGreaterThanOrEqual(2);
      expect(actions.every((action) => action.id && action.description && Array.isArray(action.requiredFields))).toBe(true);
      expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
    }
    expect([...suiteActionsByModule.values()].flat().some((action) => ["create-link", "create-page", "create-qr", "create-contest", "add-contact", "create-invoice"].includes(action.id))).toBe(false);
  });

  it("restricts higher-resource modules to the configured plan", () => {
    const projects = suiteModules.find((module) => module.id === "projects")!;
    const operations = suiteModules.find((module) => module.id === "operations")!;
    expect(suitePlanAllows("starter", projects)).toBe(false);
    expect(suitePlanAllows("scale", projects)).toBe(true);
    expect(suitePlanAllows("scale", operations)).toBe(false);
    expect(suitePlanAllows("fleet", operations)).toBe(true);
    expect(suitePlanAllows("starter", suiteModules.find((module) => module.id === "tables")!)).toBe(true);
    expect(suitePlanAllows("starter", suiteModules.find((module) => module.id === "meetings")!)).toBe(false);
    expect(suitePlanAllows("scale", suiteModules.find((module) => module.id === "events")!)).toBe(true);
    expect(suitePlanAllows("scale", suiteModules.find((module) => module.id === "metering")!)).toBe(false);
    expect(suitePlanAllows("fleet", suiteModules.find((module) => module.id === "metering")!)).toBe(true);
    expect(suiteAiReadScopes("inbox")).toEqual(["inbox", "crm", "knowledge"]);
    expect(suiteAiReadScopes("assistant")).toEqual(["assistant"]);
    expect(suiteAiReadScopes("tables")).toEqual(["tables"]);
    expect(suiteAiReadScopes("tables", { explicitSelection: true })).toEqual(suiteModules.map((module) => module.id));
    expect(suiteAiReadScopes("projects", { explicitSelection: true })).toEqual(suiteModules.map((module) => module.id));
    expect(suiteAiReadScopes("drive", { explicitSelection: true })).toEqual(suiteModules.map((module) => module.id));
    expect(suiteAiReadScopes("channels", { explicitSelection: true })).toEqual(suiteModules.map((module) => module.id));
    expect(suiteAiReadScopes("operations", { explicitSelection: true })).toEqual(suiteModules.map((module) => module.id));
    expect(suiteAiReadScopes("assistant", { explicitSelection: true })).toEqual(["assistant"]);
  });

  it("rechecks the paid plan for every premium action, including after downgrade", async () => {
    const store = new MemorySuiteStore("starter");
    const userId = "66666666-6666-4666-8666-666666666666";
    await store.setWorkspacePlan(userId, "fleet");
    await store.enableModule(userId, "operations");
    const existing = await store.createRecord(userId, { moduleId: "operations", recordType: "invoice", title: "INV-existing" });
    await store.setWorkspacePlan(userId, "starter");
    await expect(executeSuiteAction(store, userId, "operations", "party-create", { name: "Customer", kind: "customer", currency: "USD", idempotencyKey: idempotency("downgraded-party") })).rejects.toThrow(/locked/);
    expect(await store.createRecord(userId, { moduleId: "operations", recordType: "invoice", title: "INV-bypass" })).toBeUndefined();
    expect(await store.queueAiAction(userId, { moduleId: "operations", goal: "Bypass plan" })).toBeUndefined();
    expect(await store.updateRecord(userId, existing!.id, { state: "sent" })).toBeUndefined();
  });

  it("shares records across enabled modules while isolating customer workspaces", async () => {
    const store = new MemorySuiteStore("starter");
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    await store.enableModule(first, "crm");
    await store.enableModule(first, "inbox");
    const contact = await store.createRecord(first, { moduleId: "crm", recordType: "contact", title: "Asha", data: { email: "asha@example.com" } });
    const conversation = await store.createRecord(first, { moduleId: "inbox", recordType: "conversation", title: "Onboarding", data: { contactId: contact?.id } });
    expect(new Set((await store.listRecords(first, { limit: 50 })).map((record) => record.id))).toEqual(new Set([conversation?.id, contact?.id]));
    expect(await store.listRecords(second, { limit: 50 })).toEqual([]);
  });

  it("shares one customer workspace across team accounts with enforced roles", async () => {
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: new MemorySuiteStore("starter"), synchronizeSuiteEntitlements: false });
    const owner = request.agent(app);
    await owner.post("/api/auth/signup").send({ displayName: "Workspace Owner", email: "owner-team@example.com", password: "long-safe-password" });
    const ownerWorkspace = (await owner.get("/api/suite/workspace")).body.workspace;
    expect(ownerWorkspace.currentRole).toBe("owner");
    expect((await owner.post("/api/suite/modules/crm/enable")).status).toBe(201);
    const account = await owner.post("/api/suite/modules/crm/actions/account-upsert").send({ input: { externalKey: "shared-customer", name: "Shared customer", domain: "shared.example", idempotencyKey: idempotency("shared-account") } });
    expect(account.status).toBe(200);
    const accountId = recordOf(account, "account").id;

    const member = request.agent(app);
    await member.post("/api/auth/signup").send({ displayName: "Workspace Member", email: "member-team@example.com", password: "long-safe-password" });
    const addedMember = await owner.post("/api/suite/members").send({ email: "member-team@example.com", role: "member" });
    expect(addedMember.status).toBe(201);
    const memberWorkspace = (await member.get("/api/suite/workspace")).body.workspace;
    expect(memberWorkspace.id).toBe(ownerWorkspace.id);
    expect(memberWorkspace.currentRole).toBe("member");
    expect((await member.get("/api/suite/records")).body.records.some((record: { id: string }) => record.id === accountId)).toBe(true);
    expect((await member.post("/api/suite/modules/crm/actions/activity-record").send({ input: { accountId, kind: "note", occurredAt: "2026-08-24T12:00:00.000Z", summary: "Member follow-up", idempotencyKey: idempotency("member-activity") } })).status).toBe(200);
    expect((await member.post("/api/suite/modules/tasks/enable")).status).toBe(403);

    const viewer = request.agent(app);
    await viewer.post("/api/auth/signup").send({ displayName: "Workspace Viewer", email: "viewer-team@example.com", password: "long-safe-password" });
    expect((await owner.post("/api/suite/members").send({ email: "viewer-team@example.com", role: "viewer" })).status).toBe(201);
    const viewerRecords = (await viewer.get("/api/suite/records")).body.records;
    expect(viewerRecords.some((record: { id: string }) => record.id === accountId)).toBe(true);
    expect(viewerRecords.some((record: { recordType: string }) => record.recordType === "activity")).toBe(true);
    expect((await viewer.post("/api/suite/modules/crm/actions/activity-record").send({ input: { accountId, kind: "note", occurredAt: "2026-08-24T12:00:00.000Z", summary: "Denied", idempotencyKey: idempotency("viewer-activity") } })).status).toBe(403);
    expect((await viewer.post("/api/suite/api-tokens").send({ name: "Viewer writer", scopes: ["write"] })).status).toBe(403);
    expect((await viewer.post("/api/suite/api-tokens").send({ name: "Viewer reader", scopes: ["read"] })).status).toBe(201);

    const listed = await owner.get("/api/suite/members");
    expect(listed.body.members.map((item: { email: string }) => item.email)).toEqual(["owner-team@example.com", "member-team@example.com", "viewer-team@example.com"]);
    const viewerEntry = listed.body.members.find((item: { email: string }) => item.email === "viewer-team@example.com");
    expect((await member.delete(`/api/suite/members/${viewerEntry.userId}`)).status).toBe(409);
    expect((await owner.delete(`/api/suite/members/${viewerEntry.userId}`)).status).toBe(204);
    expect((await viewer.get("/api/suite/workspace")).body.workspace.id).not.toBe(ownerWorkspace.id);
  });

  it("supports session setup, instant module enablement, shared records, AI jobs, and bearer CLI access", async () => {
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: new MemorySuiteStore("starter"), synchronizeSuiteEntitlements: false });
    const agent = request.agent(app);
    expect((await agent.post("/api/auth/signup").send({ displayName: "Suite Owner", email: "suite@example.com", password: "long-safe-password" })).status).toBe(201);

    expect((await agent.post("/api/suite/modules/projects/enable")).status).toBe(409);
    expect((await agent.post("/api/suite/modules/crm/enable")).status).toBe(201);
    expect((await agent.post("/api/suite/modules/inbox/enable")).status).toBe(201);

    const account = await agent.post("/api/suite/modules/crm/actions/account-upsert").send({ input: { externalKey: "customer-trial", name: "Customer", domain: "customer.example", idempotencyKey: idempotency("session-account") } });
    expect(account.status).toBe(200);
    const accountId = recordOf(account, "account").id;
    const wrongContact = await agent.post("/api/suite/modules/inbox/actions/thread-open").send({ input: { contactId: accountId, channel: "email", subject: "Wrong record type", message: "Must not persist", idempotencyKey: idempotency("wrong-contact-thread") } });
    expect(wrongContact.status).toBe(409);
    expect(wrongContact.body.error).toBe("contact not found.");
    expect((await agent.get("/api/suite/records?moduleId=inbox")).body.records).toEqual([]);
    const contact = await agent.post("/api/suite/modules/crm/actions/contact-link").send({ input: { accountId, name: "Customer contact", email: "customer@example.com", consentBasis: "Existing customer", idempotencyKey: idempotency("session-contact") } });
    expect(contact.status).toBe(200);
    const conversation = await agent.post("/api/suite/modules/inbox/actions/thread-open").send({ input: { contactId: recordOf(contact, "contact").id, channel: "email", subject: "Needs help", message: "Please help", idempotencyKey: idempotency("session-thread") } });
    expect(conversation.status).toBe(200);
    expect((await agent.get("/api/suite/records")).body.records.length).toBeGreaterThanOrEqual(3);

    expect((await agent.post("/api/suite/ai-actions").send({ moduleId: "crm", goal: "Unsafe generic queue" })).status).toBe(410);
    const action = await agent.post("/api/suite/modules/crm/actions/next-action-propose").send({ input: { accountId, instruction: "Draft a follow-up using exact account evidence.", evidenceIds: [accountId], idempotencyKey: idempotency("session-ai") } });
    expect(action.status).toBe(202);
    expect(action.body.aiAction.status).toBe("queued");
    expect((await agent.get(`/api/suite/ai-actions/${action.body.aiAction.id}`)).body.action.goal).toContain("Draft a follow-up");

    const tokenResponse = await agent.post("/api/suite/api-tokens").send({ name: "Test MCP" });
    expect(tokenResponse.status).toBe(201);
    expect(tokenResponse.body.token.token).toMatch(/^sup_/);
    const bearerWorkspace = await request(app).get("/api/suite/workspace").set("Authorization", `Bearer ${tokenResponse.body.token.token}`);
    expect(bearerWorkspace.status).toBe(200);
    expect(bearerWorkspace.body.workspace.enabledModuleIds).toEqual(["crm", "inbox"]);
  });

  it("enforces read, write, and AI scopes while keeping bearer tokens out of account administration", async () => {
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: new MemorySuiteStore("starter"), synchronizeSuiteEntitlements: false });
    const agent = request.agent(app);
    await agent.post("/api/auth/signup").send({ displayName: "Scoped Owner", email: "scoped@example.com", password: "long-safe-password" });
    expect((await agent.post("/api/suite/modules/crm/enable")).status).toBe(201);

    const readToken = (await agent.post("/api/suite/api-tokens").send({ name: "Read client", scopes: ["read"], expiresInDays: 30 })).body.token;
    const writeToken = (await agent.post("/api/suite/api-tokens").send({ name: "Write client", scopes: ["write"], expiresInDays: 30 })).body.token;
    const aiToken = (await agent.post("/api/suite/api-tokens").send({ name: "AI client", scopes: ["ai"], expiresInDays: 30 })).body.token;
    const readAuthorization = { Authorization: `Bearer ${readToken.token}` };
    const writeAuthorization = { Authorization: `Bearer ${writeToken.token}` };
    const aiAuthorization = { Authorization: `Bearer ${aiToken.token}` };

    expect((await request(app).get("/api/suite/workspace").set(readAuthorization)).status).toBe(200);
    expect((await request(app).post("/api/suite/records").set(readAuthorization).send({ moduleId: "crm", recordType: "contact", title: "Denied" })).status).toBe(403);
    expect((await request(app).post("/api/suite/ai-actions").set(readAuthorization).send({ moduleId: "crm", goal: "Denied AI action" })).status).toBe(403);

    expect((await request(app).get("/api/suite/workspace").set(writeAuthorization)).status).toBe(403);
    const createdAccount = await request(app).post("/api/suite/modules/crm/actions/account-upsert").set(writeAuthorization).send({ input: { externalKey: "scoped-account", name: "Asha", domain: "asha.example", idempotencyKey: idempotency("scoped-account") } });
    expect(createdAccount.status).toBe(200);
    const accountId = recordOf(createdAccount, "account").id;
    expect((await request(app).post("/api/suite/modules/crm/actions/next-action-propose").set(writeAuthorization).send({ input: { accountId, instruction: "Follow up", evidenceIds: [accountId], idempotencyKey: idempotency("write-ai-denied") } })).status).toBe(403);
    expect((await request(app).post("/api/suite/records").set(writeAuthorization).send({ moduleId: "crm", recordType: "contact", title: "Bypass" })).status).toBe(410);

    const queued = await request(app).post("/api/suite/modules/crm/actions/next-action-propose").set(aiAuthorization).send({ input: { accountId, instruction: "Follow up using cited evidence", evidenceIds: [accountId], idempotencyKey: idempotency("scoped-ai") } });
    expect(queued.status).toBe(202);
    expect((await request(app).post("/api/suite/modules/crm/actions/account-upsert").set(aiAuthorization).send({ input: { externalKey: "denied", name: "Denied", domain: "denied.example", idempotencyKey: idempotency("ai-write-denied") } })).status).toBe(403);
    expect((await request(app).post("/api/suite/ai-actions").set(aiAuthorization).send({ moduleId: "crm", goal: "Bypass pinned prompt" })).status).toBe(410);
    expect((await request(app).get(`/api/suite/ai-actions/${queued.body.aiAction.id}`).set(aiAuthorization)).status).toBe(403);

    expect((await request(app).get("/api/dashboard").set(readAuthorization)).status).toBe(401);
    expect((await request(app).get("/api/me").set(readAuthorization)).status).toBe(401);
    expect((await request(app).get("/api/suite/api-tokens").set(readAuthorization)).status).toBe(401);
    expect((await request(app).post("/api/suite/api-tokens").set(readAuthorization).send({ name: "Escalation attempt" })).status).toBe(401);

    const listed = await agent.get("/api/suite/api-tokens");
    expect(listed.status).toBe(200);
    expect(listed.body.tokens).toHaveLength(3);
    expect(listed.body.tokens.find((token: { id: string }) => token.id === readToken.id)).toMatchObject({ name: "Read client", scopes: ["read"], lastUsedAt: expect.any(String) });
    expect(listed.body.tokens.every((token: Record<string, unknown>) => !("token" in token))).toBe(true);
    expect((await agent.post("/api/suite/api-tokens").send({ name: "Duplicate", scopes: ["read", "read"] })).status).toBe(400);
    expect((await agent.post("/api/suite/api-tokens").send({ name: "Too long", expiresInDays: 366 })).status).toBe(400);

    expect((await agent.delete(`/api/suite/api-tokens/${readToken.id}`)).status).toBe(204);
    expect((await request(app).get("/api/suite/workspace").set(readAuthorization)).status).toBe(401);
    const revoked = (await agent.get("/api/suite/api-tokens")).body.tokens.find((token: { id: string }) => token.id === readToken.id);
    expect(revoked.revokedAt).toBeTruthy();
  });

  it("rejects expired tokens and prevents one account from revoking another account's token", async () => {
    const repository = new MemoryRepository();
    const store = new MemorySuiteStore("starter");
    const app = await createApp({ repository, suiteStore: store, synchronizeSuiteEntitlements: false });
    const owner = request.agent(app);
    const signup = await owner.post("/api/auth/signup").send({ displayName: "Expiry Owner", email: "expiry@example.com", password: "long-safe-password" });
    const expired = await store.createApiToken(signup.body.user.id, { name: "Expired", scopes: ["read"], expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect((await request(app).get("/api/suite/workspace").set("Authorization", `Bearer ${expired.token}`)).status).toBe(401);

    const live = (await owner.post("/api/suite/api-tokens").send({ name: "Owned token", scopes: ["read"] })).body.token;
    const other = request.agent(app);
    await other.post("/api/auth/signup").send({ displayName: "Other Owner", email: "other-expiry@example.com", password: "long-safe-password" });
    expect((await other.delete(`/api/suite/api-tokens/${live.id}`)).status).toBe(404);
    expect((await request(app).get("/api/suite/workspace").set("Authorization", `Bearer ${live.token}`)).status).toBe(200);
  });

  it("does not turn an unpaid planned capacity change into a premium suite entitlement", async () => {
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: new MemorySuiteStore("none") });
    const agent = request.agent(app);
    await agent.post("/api/auth/signup").send({ displayName: "Plan Owner", email: "plan@example.com", password: "long-safe-password" });
    const created = await agent.post("/api/installations").send({ name: "Unpaid capacity", appIds: ["uptime-kuma"] });
    expect((await agent.post(`/api/installations/${created.body.installation.id}/upgrade`).send({ plan: "fleet" })).status).toBe(200);
    expect((await agent.get("/api/suite/workspace")).body.workspace.plan).toBe("none");
    const starterModule = await agent.post("/api/suite/modules/crm/enable");
    expect(starterModule.status).toBe(409);
    expect(starterModule.body).toMatchObject({ requiredPlan: "starter" });
    expect(starterModule.body.error).toContain("$7 Starter");
    expect((await agent.post("/api/suite/modules/operations/enable")).status).toBe(409);
    const domain = await agent.post("/api/suite/domains").send({ domain: "unpaid.example.com" });
    expect(domain.status).toBe(409);
    expect(domain.body).toMatchObject({ requiredPlan: "starter" });
  });

  it("leases AI work, records completion, and exposes tenant-owned status", async () => {
    const store = new MemorySuiteStore("starter");
    const userId = "44444444-4444-4444-8444-444444444444";
    await store.enableModule(userId, "knowledge");
    const queued = await store.queueAiAction(userId, { moduleId: "knowledge", goal: "Answer from published pages" });
    const claimed = await store.claimAiAction();
    expect(claimed?.action.id).toBe(queued?.id);
    expect(claimed?.action.status).toBe("running");
    expect(claimed?.action.attempts).toBe(1);
    expect(claimed?.action.leaseExpiresAt).toBeTruthy();
    expect(await store.completeAiAction(claimed!.action.id, { status: "completed", result: { proposal: "Grounded answer", evidence: [] } })).toBe(true);
    expect((await store.getAiAction(userId, claimed!.action.id))?.status).toBe("completed");
    expect(await store.getAiAction("55555555-5555-4555-8555-555555555555", claimed!.action.id)).toBeUndefined();
  });

  it("limits AI context to declared modules and terminalizes exhausted leases", async () => {
    const store = new MemorySuiteStore("starter");
    const userId = "45454545-4545-4454-8454-454545454545";
    for (const moduleId of ["inbox", "crm", "knowledge", "links"]) await store.enableModule(userId, moduleId);
    await store.createRecord(userId, { moduleId: "inbox", recordType: "conversation", title: "Ticket" });
    await store.createRecord(userId, { moduleId: "crm", recordType: "contact", title: "Customer" });
    await store.createRecord(userId, { moduleId: "knowledge", recordType: "page", title: "Answer" });
    await store.createRecord(userId, { moduleId: "links", recordType: "link", title: "Private unrelated link" });
    const queued = await store.queueAiAction(userId, { moduleId: "inbox", goal: "Draft a grounded answer" });
    const claimed = await store.claimAiAction();
    expect(new Set(claimed?.records.map((record) => record.moduleId))).toEqual(new Set(["inbox", "crm", "knowledge"]));
    claimed!.action.attempts = 3;
    claimed!.action.leaseExpiresAt = "2020-01-01T00:00:00.000Z";
    expect(await store.claimAiAction()).toBeUndefined();
    expect(await store.getAiAction(userId, queued!.id)).toMatchObject({ status: "failed", attempts: 3, leaseExpiresAt: undefined });
  });

  it("reports and enforces plan-backed record, AI, payload, and registered-storage quotas", async () => {
    const store = new MemorySuiteStore("starter");
    const userId = "46464646-4646-4464-8464-464646464646";
    await store.enableModule(userId, "esign");
    await store.enableModule(userId, "crm");
    await store.createRecord(userId, { moduleId: "esign", recordType: "document", title: "Brief.pdf", state: "immutable", data: { objectRef: "private/brief.pdf", objectVersion: "generation-1", sha256: "a".repeat(64), sizeBytes: 1_048_576, storageAccounting: suiteStorageAccounting(1_048_576) } });
    await store.queueAiAction(userId, { moduleId: "crm", goal: "Draft a follow-up" });
    expect(await store.getUsage(userId)).toMatchObject({ recordCount: 1, aiActionsThisMonth: 1, registeredStorageBytes: 1_048_576, storageLimitBytes: 10 * 1024 ** 3 });
    await store.createRecord(userId, { moduleId: "esign", recordType: "document", title: "Large.pdf", state: "immutable", data: { objectRef: "private/large.pdf", objectVersion: "generation-1", sha256: "b".repeat(64), sizeBytes: 10_000_000_000, storageAccounting: suiteStorageAccounting(10_000_000_000) } });
    await expect(store.createRecord(userId, { moduleId: "esign", recordType: "document", title: "Too large", state: "immutable", data: { objectRef: "private/overflow.pdf", objectVersion: "generation-1", sha256: "c".repeat(64), sizeBytes: 800_000_000, storageAccounting: suiteStorageAccounting(800_000_000) } })).rejects.toThrow(/storage quota/);
    await expect(store.createRecord(userId, { moduleId: "crm", recordType: "contact", title: "Oversized", data: { note: "x".repeat(300_000) } })).rejects.toThrow(/262144-byte/);
  });

  it("serves public links, brand pages, feedback, testimonials, and giveaway entries without exposing private records", async () => {
    const store = new MemorySuiteStore("starter");
    const publicDestinationResolver = {
      resolve4: async (hostname: string) => hostname === "private.example" ? ["169.254.169.254"] : ["93.184.216.34"],
      resolve6: async () => [] as string[],
    };
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, synchronizeSuiteEntitlements: false, publicDestinationResolver });
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ displayName: "Public Owner", email: "public@example.com", password: "long-safe-password" });
    const userId = signup.body.user.id;
    const workspace = (await agent.get("/api/suite/workspace")).body.workspace;
    for (const moduleId of ["feedback", "testimonials", "giveaways", "links", "brand-pages"]) expect((await agent.post(`/api/suite/modules/${moduleId}/enable`)).status).toBe(201);
    const run = (moduleId: string, actionId: string, input: Record<string, unknown>) => agent.post(`/api/suite/modules/${moduleId}/actions/${actionId}`).send({ input });

    const linkRoute = await run("links", "route-create", { hostname: "go.public.example", slug: "docs", privacyMode: "no-analytics", idempotencyKey: idempotency("public-link-route") });
    const linkRouteId = recordOf(linkRoute, "link-route").id;
    const linkDestination = await run("links", "destination-version-create", { routeId: linkRouteId, destination: "https://example.com/docs", campaign: {}, idempotencyKey: idempotency("public-link-destination") });
    const linkVersion = recordOf(linkDestination, "destination-version");
    expect((await run("links", "destination-publish", { routeId: linkRouteId, destinationVersionId: linkVersion.id, contentHash: linkVersion.data.contentHash, dryRun: false, approval: approval(userId, "public-link-publish"), idempotencyKey: idempotency("public-link-publish") })).status).toBe(200);
    const redirect = await request(app).get(`/r/${workspace.slug}/docs`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("https://example.com/docs");

    const privateRoute = await run("links", "route-create", { hostname: "go.public.example", slug: "private", privacyMode: "no-analytics", idempotencyKey: idempotency("private-link-route") });
    const privateRouteId = recordOf(privateRoute, "link-route").id;
    const privateDestination = recordOf(await run("links", "destination-version-create", { routeId: privateRouteId, destination: "https://private.example/admin", campaign: {}, idempotencyKey: idempotency("private-link-destination") }), "destination-version");
    expect((await run("links", "destination-publish", { routeId: privateRouteId, destinationVersionId: privateDestination.id, contentHash: privateDestination.data.contentHash, dryRun: false, approval: approval(userId, "private-link-publish"), idempotencyKey: idempotency("private-link-publish") })).status).toBe(200);
    expect((await request(app).get(`/r/${workspace.slug}/private`)).status).toBe(404);

    const page = await run("brand-pages", "page-create", { slug: "founder", name: "Founder links", privacyMode: "no-analytics", locale: "en-US", idempotencyKey: idempotency("public-page") });
    const pageId = recordOf(page, "page").id;
    const pageDestination = await run("brand-pages", "destination-version-create", { pageId, linkKey: "docs", destination: "https://example.com/docs", label: "Docs", accessibilityLabel: "Open documentation", campaign: {}, idempotencyKey: idempotency("public-page-destination") });
    const pageDestinationRecord = recordOf(pageDestination, "destination-version");
    const pageVersion = await run("brand-pages", "page-version-create", { pageId, title: "Founder links", description: "Products and notes.", links: [{ key: "docs", label: "Docs", destinationVersionId: pageDestinationRecord.id, accessibilityLabel: "Open documentation" }], layout: "stack", theme: { accent: "#14B8A6", background: "#0B1020", foreground: "#F8FAFC", radiusPx: 18 }, idempotencyKey: idempotency("public-page-version") });
    const pageVersionRecord = recordOf(pageVersion, "page-version");
    expect((await run("brand-pages", "page-version-publish", { pageVersionId: pageVersionRecord.id, contentHash: pageVersionRecord.data.contentHash, dryRun: false, approval: approval(userId, "public-page-publish"), idempotencyKey: idempotency("public-page-publish") })).status).toBe(200);
    const rendered = await request(app).get(`/p/${workspace.slug}/founder`);
    expect(rendered.status).toBe(200);
    expect(rendered.text).toContain("Founder links");
    expect(rendered.text).not.toContain("javascript:");
    expect(rendered.text).not.toContain('href="https://example.com/docs"');
    const navigationPath = `/out/${workspace.id}/${pageVersionRecord.id}/${pageDestinationRecord.id}`;
    expect(rendered.text).toContain(`href="${navigationPath}"`);
    const navigation = await request(app).get(navigationPath).set("host", "localhost");
    expect(navigation.status).toBe(200);
    expect(navigation.headers["cache-control"]).toBe("no-store");
    expect(navigation.text).toContain("Continue to example.com?");
    expect((await request(app).get(`/embeds/pages/${workspace.id}/${pageVersionRecord.id}`)).text).toContain(`data-page-version="${pageVersionRecord.id}"`);

    const feedback = await request(app).post(`/api/public/${workspace.slug}/feedback`).set("Origin", "https://customer.example").send({ title: "Add exports", description: "We need a CSV export." });
    expect(feedback.status).toBe(201);
    expect(feedback.headers["access-control-allow-origin"]).toBe("*");

    const consentPolicyVersion = "</script><script>globalThis.testimonialXss=true</script>";
    const collection = await run("testimonials", "collection-create", { name: "Customer outcomes", purpose: "Publish reviewed customer outcomes.", consentPolicyVersion, retentionDays: 730, allowedLocales: ["en-US"], idempotencyKey: idempotency("public-collection") });
    const collectionId = recordOf(collection, "collection").id;
    const collectionRequest = await executeFirstPartyGrowthAction(store, { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] }, "testimonials", "request-draft", { collectionId, recipientRefHash: "d".repeat(64), expiresAt: "2030-01-01T00:00:00.000Z", locale: "en-US", contextLabel: "Onboarding", idempotencyKey: idempotency("public-collection-request") }, { publicBaseUrl: "https://cloud.example.test" });
    const requestRecord = collectionRequest.records.find((record) => record.recordType === "collection-request")!;
    const accessToken = String(collectionRequest.audit.accessToken);
    const collectionPage = await request(app).get(`/collect/testimonials/${workspace.id}/${requestRecord.id}`).query({ token: accessToken });
    expect(collectionPage.status).toBe(200);
    expect(collectionPage.headers["cache-control"]).toBe("no-store");
    expect(collectionPage.headers["content-security-policy"]).toMatch(/default-src 'none'.*script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(collectionPage.text).not.toContain('type="email"');
    expect(collectionPage.text).not.toContain(consentPolicyVersion);
    expect(collectionPage.text.match(/<script\b/g)).toHaveLength(1);
    expect(collectionPage.text).toContain("&lt;/script&gt;&lt;script&gt;globalThis.testimonialXss=true&lt;/script&gt;");
    const testimonialBody = { authorName: "Asha", content: "This saved our team a full day every week.", attribution: "first-name", authorRole: "Operations lead", organization: "Example Co", consent: { granted: true, policyVersion: consentPolicyVersion, purposes: ["testimonial-publication"] } };
    expect((await request(app).post(`/api/public/testimonials/${workspace.id}/requests/${requestRecord.id}/submissions`).query({ token: accessToken }).send({ ...testimonialBody, email: "must-not-be-accepted@example.com" })).status).toBe(400);
    const submittedTestimonial = await request(app).post(`/api/public/testimonials/${workspace.id}/requests/${requestRecord.id}/submissions`).query({ token: accessToken }).send(testimonialBody);
    expect(submittedTestimonial.status).toBe(201);
    expect(submittedTestimonial.body).not.toHaveProperty("email");
    const replayedTestimonial = await request(app).post(`/api/public/testimonials/${workspace.id}/requests/${requestRecord.id}/submissions`).query({ token: accessToken }).send(testimonialBody);
    expect(replayedTestimonial.status).toBe(200);
    expect(replayedTestimonial.body).toMatchObject({ id: submittedTestimonial.body.id, replayed: true });
    expect((await request(app).get(`/collect/testimonials/${workspace.id}/${requestRecord.id}`).query({ token: accessToken })).status).toBe(410);
    expect((await request(app).post(`/api/public/${workspace.slug}/testimonials`).send(testimonialBody)).status).toBe(404);
    expect((await request(app).get(`/api/public/${workspace.slug}/testimonials`)).body.records).toEqual([]);
    const privateTestimonial = (await store.listRecords(userId, { moduleId: "testimonials", recordType: "testimonial", limit: 10 })).find((record) => record.id === submittedTestimonial.body.id)!;
    expect(privateTestimonial.data).not.toHaveProperty("email");
    const moderation = await run("testimonials", "moderation-decide", { testimonialId: privateTestimonial.id, decision: "accept", reason: "Consent and exact statement reviewed.", expectedVersion: 1, dryRun: false, approval: approval(userId, "public-testimonial-moderation"), idempotencyKey: idempotency("public-testimonial-moderation") });
    const moderationRecord = recordOf(moderation, "moderation-decision");
    const publication = await run("testimonials", "publication-version-create", { testimonialId: privateTestimonial.id, content: testimonialBody.content, attributionLabel: "Asha, Operations lead", disclosure: "Submitted by a customer.", moderationDecisionId: moderationRecord.id, idempotencyKey: idempotency("public-testimonial-version") });
    const publicationRecord = recordOf(publication, "publication-version");
    expect((await run("testimonials", "publication-publish", { publicationVersionId: publicationRecord.id, contentHash: publicationRecord.data.contentHash, dryRun: false, approval: approval(userId, "public-testimonial-publish"), idempotencyKey: idempotency("public-testimonial-publish") })).status).toBe(200);
    const publicTestimonials = (await request(app).get(`/api/public/${workspace.slug}/testimonials`)).body.records;
    expect(publicTestimonials).toEqual([expect.objectContaining({ id: publicationRecord.id, content: testimonialBody.content, attributionLabel: "Asha, Operations lead" })]);
    expect(publicTestimonials[0]).not.toHaveProperty("email");
    const widget = await run("testimonials", "widget-version-create", { widgetKey: "homepage-proof", name: "Homepage proof", publicationVersionIds: [publicationRecord.id], layout: "grid", theme: { accent: "#2563EB", surface: "#FFFFFF", text: "#111827", radiusPx: 16 }, idempotencyKey: idempotency("public-widget") });
    const widgetRecord = recordOf(widget, "widget-version");
    expect((await run("testimonials", "widget-publish", { widgetVersionId: widgetRecord.id, contentHash: widgetRecord.data.contentHash, dryRun: false, approval: approval(userId, "public-widget-publish"), idempotencyKey: idempotency("public-widget-publish") })).status).toBe(200);
    const publicWorkflowReads = vi.spyOn(store, "listPublicWorkflowRecords");
    const pinnedWidget = await request(app).get(`/api/public/testimonials/${workspace.id}/widgets/${widgetRecord.id}`);
    expect(publicWorkflowReads).toHaveBeenCalledTimes(5);
    publicWorkflowReads.mockRestore();
    expect(pinnedWidget.body.widget.testimonials[0].id).toBe(publicationRecord.id);
    expect((await request(app).get(`/embeds/testimonials/${workspace.id}/${widgetRecord.id}`)).text).toContain(`data-widget-version="${widgetRecord.id}"`);
    expect((await request(app).get("/widgets/testimonials.js")).text).toContain("dataset.version");

    const qr = await run("brand-pages", "qr-route-create", { slug: "launch", name: "Launch QR", privacyMode: "no-analytics", style: { foreground: "#111827", background: "#FFFFFF", errorCorrection: "M" }, idempotencyKey: idempotency("public-qr") });
    const qrId = recordOf(qr, "qr-route").id;
    const qrDestination = await run("brand-pages", "qr-destination-version-create", { qrRouteId: qrId, destination: "https://example.com/launch", label: "Launch", campaign: {}, idempotencyKey: idempotency("public-qr-destination") });
    const qrDestinationRecord = recordOf(qrDestination, "qr-destination-version");
    expect((await run("brand-pages", "qr-destination-activate", { destinationVersionId: qrDestinationRecord.id, contentHash: qrDestinationRecord.data.contentHash, dryRun: false, approval: approval(userId, "public-qr-activate"), idempotencyKey: idempotency("public-qr-activate") })).status).toBe(200);
    const qrSvg = await request(app).get(`/q/${workspace.slug}/launch.svg`);
    expect(qrSvg.status).toBe(200);
    expect(qrSvg.headers["content-type"]).toContain("image/svg+xml");
    expect(Buffer.from(qrSvg.body).toString("utf8")).toContain("<svg");
    expect((await request(app).get(`/q/${workspace.slug}/launch`)).headers.location).toBe("https://example.com/launch");
    expect((await request(app).get(`/q/${workspace.slug}/launch`)).headers.location).toBe("https://example.com/launch");

    const entropyReveal = "organizer-secret-with-at-least-16-chars";
    const contest = await run("giveaways", "contest-create", { name: "Launch", closesAt: "2030-01-01T00:00:00.000Z", rules: "One consented entry per participant.", entropyCommitment: sha(entropyReveal), consentPolicyVersion: "contest-policy-v1", referralBonusCap: 2, idempotencyKey: idempotency("public-contest") });
    const contestRecord = recordOf(contest, "contest");
    expect((await run("giveaways", "contest-publish", { contestId: contestRecord.id, expectedVersion: 1, rulesHash: contestRecord.data.rulesHash, dryRun: false, approval: approval(userId, "public-contest-publish"), idempotencyKey: idempotency("public-contest-publish") })).status).toBe(200);
    const entryBody = { participantKeyHash: sha("entrant@example.com"), displayName: "Entrant", consent: { granted: true, policyVersion: "contest-policy-v1", purposes: ["contest-administration", "referral-attribution"] } };
    const concurrentEntries = await Promise.all([
      request(app).post(`/api/public/${workspace.slug}/giveaways/${contestRecord.id}/entries`).send(entryBody),
      request(app).post(`/api/public/${workspace.slug}/giveaways/${contestRecord.id}/entries`).send(entryBody),
    ]);
    expect(concurrentEntries.map((result) => result.status).sort()).toEqual([200, 201]);
    const entry = concurrentEntries.find((result) => result.status === 201)!;
    expect(entry.body.referralCode).toHaveLength(16);
    expect(entry.body).not.toHaveProperty("participantKeyHash");
    expect((await request(app).post(`/api/public/${workspace.slug}/giveaways/${contestRecord.id}/entries`).send({ ...entryBody, displayName: "Changed retry" })).status).toBe(409);
    expect((await request(app).post(`/api/public/${workspace.slug}/giveaways/${contestRecord.id}/entries`).send({ participantKeyHash: sha("referred@example.com"), displayName: "Referred", referralCode: entry.body.referralCode, consent: entryBody.consent })).status).toBe(201);
    const privateEntries = await store.listRecords(userId, { moduleId: "giveaways", recordType: "entrant", limit: 10 });
    expect(privateEntries).toHaveLength(2);
    expect(privateEntries.every((record) => !Object.hasOwn(record.data, "email") && /^[a-f0-9]{64}$/.test(String(record.data.participantKeyHash)))).toBe(true);
    expect((await request(app).get(`/api/public/${workspace.slug}/giveaways`)).body.records[0]).toMatchObject({ id: contestRecord.id, rulesHash: contestRecord.data.rulesHash, consentPolicyVersion: "contest-policy-v1" });
  });

  it("verifies a customer CNAME and serves first-party links, pages, and QR codes on that host", async () => {
    const gatewayToken = "g".repeat(32);
    let expectedCname = "not-yet-claimed.invalid";
    const store = new MemorySuiteStore("starter");
    const app = await createApp({
      repository: new MemoryRepository(), suiteStore: store, gatewayReconcilerToken: gatewayToken,
      synchronizeSuiteEntitlements: false,
      domainResolver: { resolveCname: async () => [expectedCname], resolveTxt: async () => [] },
    });
    const owner = request.agent(app);
    const signup = await owner.post("/api/auth/signup").send({ displayName: "Domain Owner", email: "domain-owner@example.com", password: "long-safe-password" });
    const userId = signup.body.user.id;
    for (const moduleId of ["links", "brand-pages", "testimonials"]) await owner.post(`/api/suite/modules/${moduleId}/enable`);
    const run = (moduleId: string, actionId: string, input: Record<string, unknown>) => owner.post(`/api/suite/modules/${moduleId}/actions/${actionId}`).send({ input });

    const linkRoute = await run("links", "route-create", { hostname: "links.customer.example", slug: "docs", privacyMode: "no-analytics", idempotencyKey: idempotency("domain-link") });
    const linkRouteId = recordOf(linkRoute, "link-route").id;
    const linkDestination = recordOf(await run("links", "destination-version-create", { routeId: linkRouteId, destination: "https://example.com/docs", campaign: {}, idempotencyKey: idempotency("domain-link-destination") }), "destination-version");
    await run("links", "destination-publish", { routeId: linkRouteId, destinationVersionId: linkDestination.id, contentHash: linkDestination.data.contentHash, dryRun: false, approval: approval(userId, "domain-link-publish"), idempotencyKey: idempotency("domain-link-publish") });

    const page = recordOf(await run("brand-pages", "page-create", { slug: "founder", name: "Founder", privacyMode: "no-analytics", locale: "en-US", idempotencyKey: idempotency("domain-page") }), "page");
    const pageDestination = recordOf(await run("brand-pages", "destination-version-create", { pageId: page.id, linkKey: "docs", destination: "https://example.com/docs", label: "Docs", campaign: {}, idempotencyKey: idempotency("domain-page-destination") }), "destination-version");
    const pageVersion = recordOf(await run("brand-pages", "page-version-create", { pageId: page.id, title: "Founder", description: "Public links", links: [{ key: "docs", label: "Docs", destinationVersionId: pageDestination.id }], layout: "stack", theme: { accent: "#14B8A6", background: "#0B1020", foreground: "#F8FAFC", radiusPx: 12 }, idempotencyKey: idempotency("domain-page-version") }), "page-version");
    await run("brand-pages", "page-version-publish", { pageVersionId: pageVersion.id, contentHash: pageVersion.data.contentHash, dryRun: false, approval: approval(userId, "domain-page-publish"), idempotencyKey: idempotency("domain-page-publish") });

    const qr = recordOf(await run("brand-pages", "qr-route-create", { slug: "launch", name: "Launch QR", privacyMode: "no-analytics", style: { foreground: "#111827", background: "#FFFFFF", errorCorrection: "M" }, idempotencyKey: idempotency("domain-qr") }), "qr-route");
    const qrDestination = recordOf(await run("brand-pages", "qr-destination-version-create", { qrRouteId: qr.id, destination: "https://example.com/launch", label: "Launch", campaign: {}, idempotencyKey: idempotency("domain-qr-destination") }), "qr-destination-version");
    await run("brand-pages", "qr-destination-activate", { destinationVersionId: qrDestination.id, contentHash: qrDestination.data.contentHash, dryRun: false, approval: approval(userId, "domain-qr-activate"), idempotencyKey: idempotency("domain-qr-activate") });

    const collection = recordOf(await run("testimonials", "collection-create", { name: "Domain reviews", purpose: "Reviewed public testimonials", consentPolicyVersion: "domain-testimonial-v1", retentionDays: 365, allowedLocales: ["en-US"], idempotencyKey: idempotency("domain-collection") }), "collection");
    const workspace = (await owner.get("/api/suite/workspace")).body.workspace;
    const collectionRequest = await executeFirstPartyGrowthAction(store, { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] }, "testimonials", "request-draft", { collectionId: collection.id, recipientRefHash: "e".repeat(64), expiresAt: "2030-01-01T00:00:00.000Z", locale: "en-US", idempotencyKey: idempotency("domain-request") }, { publicBaseUrl: "https://cloud.example.test" });
    const collectionRequestRecord = collectionRequest.records.find((record) => record.recordType === "collection-request")!;
    const accessToken = String(collectionRequest.audit.accessToken);

    const claimed = await owner.post("/api/suite/domains").send({ domain: "links.customer.example" });
    expect(claimed.status).toBe(201);
    expectedCname = claimed.body.dns.cname.value;
    expect((await owner.post("/api/suite/domains/links.customer.example/verify")).status).toBe(200);
    expect((await request(app).get("/r/docs").set("Host", "links.customer.example")).headers.location).toBe("https://example.com/docs");
    expect((await request(app).get("/p/founder").set("Host", "links.customer.example")).text).toContain("Founder");
    expect((await request(app).get("/q/launch.svg").set("Host", "links.customer.example")).headers["content-type"]).toContain("image/svg+xml");
    expect((await request(app).get("/q/launch").set("Host", "links.customer.example")).headers.location).toBe("https://example.com/launch");
    const customCollection = await request(app).get(`/collect/testimonials/${collectionRequestRecord.id}`).set("Host", "links.customer.example").query({ token: accessToken });
    expect(customCollection.status).toBe(200);
    expect(customCollection.text).not.toContain('type="email"');
    const customSubmission = await request(app).post(`/api/public/testimonials/requests/${collectionRequestRecord.id}/submissions`).set("Host", "links.customer.example").query({ token: accessToken }).send({ authorName: "Customer", content: "The custom-domain collection flow worked safely.", attribution: "anonymous", consent: { granted: true, policyVersion: "domain-testimonial-v1", purposes: ["testimonial-publication"] } });
    expect(customSubmission.status).toBe(201);
    expect((await request(app).get("/api/public/testimonials").set("Host", "links.customer.example")).body.records).toEqual([]);
    const gateway = await request(app).get("/api/internal/gateway/routes").set("Authorization", `Bearer ${gatewayToken}`);
    expect(gateway.body.controlPlaneHosts).toEqual(["links.customer.example"]);
  });
});
