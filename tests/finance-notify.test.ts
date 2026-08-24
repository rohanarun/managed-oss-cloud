import { describe, expect, it } from "vitest";
import { executeSuiteAction, type SuiteActionResult, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { suiteAction, suiteActionInputJsonSchema, suiteActionToolName, suiteActionsByModule } from "../src/shared/suite-actions";
import { suiteModuleById } from "../src/shared/suite";

const owner = "30303030-3030-4030-8030-303030303030";
const otherOwner = "40404040-4040-4040-8040-404040404040";

const dependencies: SuiteEngineDependencies = {
  now: () => new Date("2026-08-24T15:00:00.000Z"),
  resolveTxt: async () => [],
  resolveHost: async () => ["93.184.216.34"],
};

function firstRecord(result: SuiteActionResult) {
  if (result.kind === "record") return result.record;
  if (result.kind === "command" && result.records[0]) return result.records[0];
  throw new Error("Expected a durable record result.");
}

async function financeProject(store: MemorySuiteStore, userId = owner) {
  await store.enableModule(userId, "finance");
  const client = firstRecord(await executeSuiteAction(store, userId, "finance", "client-create", { name: "Example Client", currency: "USD", taxId: "must-not-persist" }, dependencies));
  const project = firstRecord(await executeSuiteAction(store, userId, "finance", "project-create", { clientId: client.id, name: "Consulting", currency: "USD", billingMethod: "hourly" }, dependencies));
  return { client, project };
}

async function approvedTime(store: MemorySuiteStore, projectId: string, startedAt = "2026-08-01T09:00:00.000Z", endedAt = "2026-08-01T10:00:00.000Z", userId = owner) {
  const entry = firstRecord(await executeSuiteAction(store, userId, "finance", "time-create", { projectId, activity: "Implementation", startedAt, endedAt, rateMinor: 12_000 }, dependencies));
  const contentHash = String(entry.data.contentHash);
  await executeSuiteAction(store, userId, "finance", "time-submit", { entryId: entry.id, contentHash }, dependencies);
  return firstRecord(await executeSuiteAction(store, userId, "finance", "time-approve", { entryId: entry.id, contentHash }, dependencies));
}

async function issuedInvoice(store: MemorySuiteStore, projectId: string, sourceId: string, idempotencyKey = "invoice-issue-key-0001", userId = owner) {
  const preview = firstRecord(await executeSuiteAction(store, userId, "finance", "invoice-preview", { projectId, sourceIds: [sourceId], issueAt: "2026-08-02T00:00:00.000Z", dueAt: "2026-08-30T00:00:00.000Z" }, dependencies));
  return firstRecord(await executeSuiteAction(store, userId, "finance", "invoice-issue", { invoiceId: preview.id, contentHash: preview.data.contentHash, idempotencyKey }, dependencies));
}

async function notificationFixture(store: MemorySuiteStore, userId = owner, classification: "required" | "optional" = "optional") {
  await store.enableModule(userId, "notify");
  const workflow = firstRecord(await executeSuiteAction(store, userId, "notify", "workflow-draft", { name: "Invoice notice" }, dependencies));
  const subscriber = firstRecord(await executeSuiteAction(store, userId, "notify", "subscriber-upsert", { externalId: "CUSTOMER_123", locale: "en-US", timeZone: "America/New_York", email: "not-stored@example.com", deviceToken: "not-stored" }, dependencies));
  const topic = firstRecord(await executeSuiteAction(store, userId, "notify", "topic-create", { key: "billing.updates", classification, channels: ["inbox"], defaultPreference: "enabled" }, dependencies));
  const schema = firstRecord(await executeSuiteAction(store, userId, "notify", "schema-publish", {
    eventKey: "invoice.overdue",
    version: 1,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { invoiceNumber: { type: "string", maxLength: 40 }, amountMinor: { type: "integer" } },
      required: ["invoiceNumber", "amountMinor"],
    },
  }, dependencies));
  const configured = firstRecord(await executeSuiteAction(store, userId, "notify", "workflow-configure", {
    workflowId: workflow.id,
    eventKey: "invoice.overdue",
    version: 1,
    topicKey: topic.data.key,
    channels: ["inbox"],
    template: { subject: "Invoice {{invoiceNumber}} is due", body: "Balance: {{amountMinor}} minor units." },
  }, dependencies));
  const published = firstRecord(await executeSuiteAction(store, userId, "notify", "workflow-publish", { workflowId: configured.id, contentHash: configured.data.contentHash }, dependencies));
  return { subscriber, topic, schema, workflow: published };
}

describe("clean-room finance/time and notifications modules", () => {
  it("exposes Starter/shared metadata and typed generated CLI/MCP actions", () => {
    expect(suiteModuleById.get("finance")).toMatchObject({ minPlan: "starter", resourceClass: "shared", scaleGuidance: expect.stringContaining("Scale") });
    expect(suiteModuleById.get("notify")).toMatchObject({ minPlan: "starter", resourceClass: "shared", scaleGuidance: expect.stringContaining("Scale") });
    expect(suiteActionsByModule.get("finance")?.map((action) => action.id)).toEqual(expect.arrayContaining(["time-create", "invoice-issue", "payment-record"]));
    expect(suiteActionsByModule.get("notify")?.map((action) => action.id)).toEqual(expect.arrayContaining(["schema-publish", "workflow-publish", "event-emit"]));
    expect(suiteActionToolName(suiteAction("finance", "invoice-preview")!)).toBe("finance_invoice_preview");
    expect(suiteActionToolName(suiteAction("notify", "event-emit")!)).toBe("notify_event_emit");
    expect(suiteActionInputJsonSchema(suiteAction("finance", "payment-record")!).properties.amountMinor).toMatchObject({ type: "integer" });
    expect(suiteActionInputJsonSchema(suiteAction("notify", "event-emit")!).properties.payload).toMatchObject({ type: "object" });
  });

  it("creates non-overlapping whole-minute time and freezes exact submit/approval versions", async () => {
    const store = new MemorySuiteStore("starter");
    const { client, project } = await financeProject(store);
    expect(client.data).toEqual(expect.objectContaining({ currency: "USD" }));
    expect(JSON.stringify(client)).not.toContain("must-not-persist");
    const entry = firstRecord(await executeSuiteAction(store, owner, "finance", "time-create", { projectId: project.id, activity: "Implementation", startedAt: "2026-08-01T09:00:00.000Z", endedAt: "2026-08-01T10:00:00.000Z", rateMinor: 12_000 }, dependencies));
    await expect(executeSuiteAction(store, owner, "finance", "time-create", { projectId: project.id, activity: "Overlap", startedAt: "2026-08-01T09:30:00.000Z", endedAt: "2026-08-01T10:30:00.000Z", rateMinor: 12_000 }, dependencies)).rejects.toThrow(/overlaps/);
    await expect(executeSuiteAction(store, owner, "finance", "time-submit", { entryId: entry.id, contentHash: "0".repeat(64) }, dependencies)).rejects.toThrow(/does not match/);
    const submitted = firstRecord(await executeSuiteAction(store, owner, "finance", "time-submit", { entryId: entry.id, contentHash: entry.data.contentHash }, dependencies));
    const approved = firstRecord(await executeSuiteAction(store, owner, "finance", "time-approve", { entryId: submitted.id, contentHash: entry.data.contentHash }, dependencies));
    expect(approved).toMatchObject({ state: "approved", data: { durationMinutes: 60, rateMinor: 12_000, approvedContentHash: entry.data.contentHash } });
  });

  it("computes invoice totals with integer arithmetic and issues sequential immutable versions idempotently", async () => {
    const store = new MemorySuiteStore("starter");
    const { project } = await financeProject(store);
    const firstTime = await approvedTime(store, project.id);
    const secondTime = await approvedTime(store, project.id, "2026-08-01T11:00:00.000Z", "2026-08-01T11:30:00.000Z");
    const firstPreview = firstRecord(await executeSuiteAction(store, owner, "finance", "invoice-preview", { projectId: project.id, sourceIds: [firstTime.id], issueAt: "2026-08-02T00:00:00.000Z", dueAt: "2026-08-30T00:00:00.000Z" }, dependencies));
    const secondPreview = firstRecord(await executeSuiteAction(store, owner, "finance", "invoice-preview", { projectId: project.id, sourceIds: [secondTime.id], issueAt: "2026-08-02T00:00:00.000Z", dueAt: "2026-08-30T00:00:00.000Z" }, dependencies));
    expect(firstPreview.data).toMatchObject({ totalMinor: 12_000, balanceMinor: 12_000, currency: "USD" });
    expect(secondPreview.data).toMatchObject({ totalMinor: 6_000, balanceMinor: 6_000, currency: "USD" });
    expect(Number.isInteger(firstPreview.data.totalMinor)).toBe(true);

    const [firstIssuedResult, secondIssuedResult] = await Promise.all([
      executeSuiteAction(store, owner, "finance", "invoice-issue", { invoiceId: firstPreview.id, contentHash: firstPreview.data.contentHash, idempotencyKey: "invoice-concurrent-0001" }, dependencies),
      executeSuiteAction(store, owner, "finance", "invoice-issue", { invoiceId: secondPreview.id, contentHash: secondPreview.data.contentHash, idempotencyKey: "invoice-concurrent-0002" }, dependencies),
    ]);
    const numbers = [firstRecord(firstIssuedResult).data.number, firstRecord(secondIssuedResult).data.number].sort();
    expect(numbers).toEqual(["INV-2026-00001", "INV-2026-00002"]);
    const replay = firstRecord(await executeSuiteAction(store, owner, "finance", "invoice-issue", { invoiceId: firstPreview.id, contentHash: firstPreview.data.contentHash, idempotencyKey: "invoice-concurrent-0001" }, dependencies));
    expect(replay.data.number).toBe(firstRecord(firstIssuedResult).data.number);
    expect((await store.getRecord(owner, firstTime.id))?.state).toBe("invoiced");
  });

  it("records manual payments once, preserves invoice content, and isolates finance records and AI context", async () => {
    const store = new MemorySuiteStore("starter");
    const { project } = await financeProject(store);
    const time = await approvedTime(store, project.id);
    const invoice = await issuedInvoice(store, project.id, time.id);
    const immutableContent = structuredClone(invoice.data.contentHash);
    const paymentInput = { invoiceId: invoice.id, amountMinor: 4_000, currency: "USD", method: "manual-bank", idempotencyKey: "payment-manual-0001" };
    const firstPayment = await executeSuiteAction(store, owner, "finance", "payment-record", paymentInput, dependencies);
    const replay = await executeSuiteAction(store, owner, "finance", "payment-record", paymentInput, dependencies);
    expect(firstRecord(replay).id).toBe(firstRecord(firstPayment).id);
    expect((await store.listRecords(owner, { moduleId: "finance", recordType: "payment", limit: 20 }))).toHaveLength(1);
    const updatedInvoice = await store.getRecord(owner, invoice.id);
    expect(updatedInvoice).toMatchObject({ state: "partially_paid", data: { contentHash: immutableContent, balanceMinor: 8_000 } });
    expect(updatedInvoice?.data).not.toHaveProperty("providerCallStarted");

    await store.enableModule(otherOwner, "finance");
    await expect(executeSuiteAction(store, otherOwner, "finance", "payment-record", paymentInput, dependencies)).rejects.toThrow(/not found/);
    const ai = await executeSuiteAction(store, owner, "finance", "reconciliation-suggest", { invoiceId: invoice.id, instruction: "Suggest a possible match from cited facts.", bankCredential: "must-not-enter-model" }, dependencies);
    expect(ai.kind).toBe("ai-action");
    if (ai.kind === "ai-action") expect(ai.aiAction.context).toEqual({ actionId: "reconciliation-suggest", invoiceId: invoice.id, instruction: "Suggest a possible match from cited facts." });
  });

  it("rejects unsafe schemas and templates before any event or delivery record exists", async () => {
    const store = new MemorySuiteStore("starter");
    await store.enableModule(owner, "notify");
    await expect(executeSuiteAction(store, owner, "notify", "schema-publish", { eventKey: "unsafe.event", version: 1, schema: { type: "object", additionalProperties: false, properties: { providerSecret: { type: "string" } }, required: ["providerSecret"] } }, dependencies)).rejects.toThrow(/unsafe or unsupported/);

    const workflow = firstRecord(await executeSuiteAction(store, owner, "notify", "workflow-draft", { name: "Unsafe draft" }, dependencies));
    await executeSuiteAction(store, owner, "notify", "topic-create", { key: "safe.topic", classification: "optional", channels: ["inbox"], defaultPreference: "enabled" }, dependencies);
    await executeSuiteAction(store, owner, "notify", "schema-publish", { eventKey: "safe.event", version: 1, schema: { type: "object", additionalProperties: false, properties: { name: { type: "string", maxLength: 40 } }, required: ["name"] } }, dependencies);
    await expect(executeSuiteAction(store, owner, "notify", "workflow-configure", { workflowId: workflow.id, eventKey: "safe.event", version: 1, topicKey: "safe.topic", channels: ["inbox"], template: { subject: "Hi {{unknown}}", body: "<script>alert(1)</script>" } }, dependencies)).rejects.toThrow(/plain text|declared event variables/);
    expect(await store.listRecords(owner, { moduleId: "notify", recordType: "event", limit: 20 })).toEqual([]);
    expect(await store.listRecords(owner, { moduleId: "notify", recordType: "notification-run", limit: 20 })).toEqual([]);
  });

  it("validates typed payloads before persistence and emits one idempotent local inbox result without provider calls", async () => {
    const store = new MemorySuiteStore("starter");
    const fixture = await notificationFixture(store);
    await expect(executeSuiteAction(store, owner, "notify", "event-validate", { eventKey: "invoice.overdue", version: 1, payload: { invoiceNumber: "INV-1", amountMinor: 1_000, undeclared: true } }, dependencies)).rejects.toThrow(/not declared/);
    expect(await store.listRecords(owner, { moduleId: "notify", recordType: "event", limit: 20 })).toEqual([]);

    const input = { eventKey: "invoice.overdue", version: 1, subscriberId: fixture.subscriber.id, payload: { invoiceNumber: "INV-1", amountMinor: 1_000 }, idempotencyKey: "notify-event-key-0001" };
    const first = await executeSuiteAction(store, owner, "notify", "event-emit", input, dependencies);
    const replay = await executeSuiteAction(store, owner, "notify", "event-emit", input, dependencies);
    expect(first.kind === "command" && first.audit).toMatchObject({ accepted: true, delivered: false, localInboxCreated: true, providerCallStarted: false });
    expect(replay.kind === "command" && replay.audit).toMatchObject({ accepted: true, replayed: true, delivered: false, providerCallStarted: false });
    expect(await store.listRecords(owner, { moduleId: "notify", recordType: "event", limit: 20 })).toHaveLength(1);
    expect(await store.listRecords(owner, { moduleId: "notify", recordType: "notification-run", limit: 20 })).toHaveLength(1);
    const inbox = await store.listRecords(owner, { moduleId: "notify", recordType: "inbox-item", limit: 20 });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].data).toMatchObject({ subscriberId: fixture.subscriber.id, public: false });
  });

  it("persists optional-topic suppression, protects required topics, and isolates subscribers and AI context", async () => {
    const store = new MemorySuiteStore("starter");
    const fixture = await notificationFixture(store);
    await executeSuiteAction(store, owner, "notify", "preference-set", { subscriberId: fixture.subscriber.id, topicKey: fixture.topic.data.key, channel: "inbox", decision: "disabled" }, dependencies);
    const suppressed = await executeSuiteAction(store, owner, "notify", "event-emit", { eventKey: "invoice.overdue", version: 1, subscriberId: fixture.subscriber.id, payload: { invoiceNumber: "INV-2", amountMinor: 2_000 }, idempotencyKey: "notify-suppress-0001" }, dependencies);
    expect(suppressed.kind === "command" && suppressed.audit).toMatchObject({ accepted: true, suppressed: true, delivered: false, providerCallStarted: false });
    expect(await store.listRecords(owner, { moduleId: "notify", recordType: "inbox-item", limit: 20 })).toEqual([]);

    const other = await notificationFixture(store, otherOwner, "required");
    expect(other.subscriber.title).toBe(fixture.subscriber.title);
    expect(other.subscriber.workspaceId).not.toBe(fixture.subscriber.workspaceId);
    await expect(executeSuiteAction(store, otherOwner, "notify", "preference-set", { subscriberId: other.subscriber.id, topicKey: other.topic.data.key, channel: "inbox", decision: "disabled" }, dependencies)).rejects.toThrow(/required operational topic/);
    await expect(executeSuiteAction(store, otherOwner, "notify", "event-emit", { eventKey: "invoice.overdue", version: 1, subscriberId: fixture.subscriber.id, payload: { invoiceNumber: "INV-X", amountMinor: 2_000 }, idempotencyKey: "notify-cross-tenant1" }, dependencies)).rejects.toThrow(/not found/);

    const ai = await executeSuiteAction(store, owner, "notify", "workflow-suggest", { workflowId: fixture.workflow.id, instruction: "Suggest quieter wording.", providerSecret: "must-not-enter-model", payload: { private: true } }, dependencies);
    expect(ai.kind).toBe("ai-action");
    if (ai.kind === "ai-action") expect(ai.aiAction.context).toEqual({ actionId: "workflow-suggest", workflowId: fixture.workflow.id, instruction: "Suggest quieter wording." });
  });
});
