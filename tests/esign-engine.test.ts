import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { esignBoundedScanLimit, esignIntegrationManifest, executeEsignAction, recordEsignAiCompletion, validateEsignAiCompletion, type EsignAuthorization, type EsignExecutionResult } from "../src/server/esign-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";
import { esignActions } from "../src/shared/esign-actions.js";
import { suiteModuleById, type SuiteModuleDefinition } from "../src/shared/suite.js";
import { esignPromptDigest, esignPromptPolicy } from "../src/server/prompts/esign.js";

const clock = new Date("2026-08-24T18:00:00.000Z");
const deps = { now: () => new Date(clock), randomBytes, modelPolicyId: "local-reviewed-model" };
const priorModule = suiteModuleById.get("esign");
const testModule: SuiteModuleDefinition = {
  id: "esign",
  name: "E-Signature Workflow",
  inspiredBy: "Basic electronic approval workflows",
  category: "Agreements",
  description: "Content-addressed documents, explicit approvals, signer sessions, and immutable workflow facts.",
  minPlan: "starter",
  resourceClass: "shared",
  recordTypes: ["template", "template-version", "document", "envelope", "signer-session", "field-completion", "dispatch-plan", "reminder-plan", "decline-event", "void-event", "certificate"],
  aiCapabilities: ["propose cited clauses", "propose cited fields and routing"],
};

beforeAll(() => suiteModuleById.set("esign", testModule));
afterAll(() => priorModule ? suiteModuleById.set("esign", priorModule) : suiteModuleById.delete("esign"));

function key(label: string) { return `esign-${label}-key-0001`; }
function approval(auth: EsignAuthorization, label: string) { return { approved: true, approvedBy: auth.userId, approvedAt: clock.toISOString(), decisionId: `esign-${label}-decision-0001`, reason: `Reviewed the exact ${label} boundary.` }; }
function first(result: EsignExecutionResult, recordType?: string) {
  const record = recordType ? result.records.find((candidate) => candidate.recordType === recordType) : result.records[0];
  if (!record) throw new Error(`Expected ${recordType ?? "a result"} record.`);
  return record;
}

async function fixture(plan: "starter" | "scale" | "fleet" = "starter") {
  const store = new MemorySuiteStore(plan);
  const userId = randomUUID();
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.enableModule(userId, "esign");
  const auth: EsignAuthorization = { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
  const run = (actionId: string, input: Record<string, unknown>) => executeEsignAction(store, auth, "esign", actionId, input, deps);
  return { store, userId, workspace, auth, run };
}

async function draftEnvelope(context: Awaited<ReturnType<typeof fixture>>, options: { roles?: Array<{ role: string; order: number }>; fields?: Array<Record<string, unknown>>; signers?: Array<Record<string, unknown>>; suffix?: string } = {}) {
  const suffix = options.suffix ?? "one";
  const roles = options.roles ?? [{ role: "Signer", order: 1 }];
  const fields = options.fields ?? [{ fieldId: randomUUID(), signerRole: "Signer", kind: "signature", page: 1, xBasisPoints: 1_000, yBasisPoints: 8_000, widthBasisPoints: 3_000, heightBasisPoints: 800, required: true }];
  const signers = options.signers ?? roles.map((role) => ({ signerId: randomUUID(), signerKeyHash: `${role.order}`.repeat(64), role: role.role, order: role.order, authentication: "access-link", locale: "en-US", displayLabel: role.role }));
  const template = first(await context.run("template-create", { name: `Agreement ${suffix}`, purpose: "Collect reviewed workflow facts.", idempotencyKey: key(`template-${suffix}`) }));
  const templateVersion = first(await context.run("template-version-create", { templateId: template.id, expectedTemplateVersion: 0, signerRoles: roles, fields, disclosure: "Review the exact document and choose whether to complete or decline.", idempotencyKey: key(`template-version-${suffix}`) }), "template-version");
  const documentHash = suffix === "one" ? "a".repeat(64) : "b".repeat(64);
  const document = first(await context.run("document-register", { title: `agreement-${suffix}.pdf`, objectRef: `tenant/contracts/agreement-${suffix}.pdf`, objectVersion: `generation-${suffix}`, sha256: documentHash, sizeBytes: 42_000, contentType: "application/pdf", pageCount: 3, idempotencyKey: key(`document-${suffix}`) }));
  const envelope = first(await context.run("envelope-draft", { title: `Agreement ${suffix} for review`, templateVersionId: templateVersion.id, documentId: document.id, documentHash, signers, expiresAt: "2026-09-24T18:00:00.000Z", message: "Please review the exact document.", idempotencyKey: key(`envelope-${suffix}`) }));
  return { template, templateVersion, document, envelope, fields, signers };
}

async function dispatch(context: Awaited<ReturnType<typeof fixture>>, envelopeId: string, suffix = "one") {
  const preview = await context.run("envelope-preview", { envelopeId, expectedVersion: 1 });
  const planned = await context.run("envelope-dispatch-plan", { envelopeId, expectedVersion: 1, previewHash: preview.audit.previewHash, channel: "hosted-link", dryRun: true, idempotencyKey: key(`dispatch-dry-${suffix}`) });
  expect(planned.audit).toMatchObject({ dryRun: true, messageSent: false, providerCallStarted: false, externalEffectExecuted: false });
  return context.run("envelope-dispatch-plan", { envelopeId, expectedVersion: 1, previewHash: preview.audit.previewHash, channel: "hosted-link", dryRun: false, approval: approval(context.auth, `dispatch-${suffix}`), idempotencyKey: key(`dispatch-${suffix}`) });
}

function assertStrictObjects(schema: Record<string, unknown>) {
  if (schema.type === "object") expect(schema.additionalProperties).toBe(false);
  if (schema.properties && typeof schema.properties === "object") Object.values(schema.properties as Record<string, Record<string, unknown>>).forEach(assertStrictObjects);
  if (schema.items && typeof schema.items === "object") assertStrictObjects(schema.items as Record<string, unknown>);
}

describe("clean-room AI-native e-signature workflow", () => {
  it("publishes fourteen strict, idempotent CLI and MCP action contracts", () => {
    expect(esignActions).toHaveLength(14);
    expect(new Set(esignActions.map((action) => action.id)).size).toBe(14);
    expect(new Set(esignActions.map((action) => action.mcpToolName)).size).toBe(14);
    for (const action of esignActions) {
      expect(action.moduleId).toBe("esign");
      expect(action.idempotent).toBe(true);
      expect(action.cliExample).toContain(`supersuite action esign ${action.id}`);
      expect(action.mcpToolName).toBe(`esign_${action.id.replaceAll("-", "_")}`);
      expect(action.externalEffect).toBe(false);
      assertStrictObjects(action.inputSchema as unknown as Record<string, unknown>);
      if (action.operation !== "read") expect(action.inputSchema.required).toContain("idempotencyKey");
      if (action.approvalRequired) {
        expect(action.inputSchema.required).toContain("dryRun");
        expect(action.inputSchema.properties.approval).toMatchObject({ type: "object", additionalProperties: false });
      }
      if (action.operation === "ai") expect(action).toMatchObject({ promptVersion: "2026-08-24.1", requiredScope: "ai" });
    }
    expect(esignPromptDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(esignPromptPolicy.system).toContain("Never produce, copy, infer, or claim a signature");
    expect(esignIntegrationManifest()).toMatchObject({ moduleId: "esign", engine: "esign", minimumPlan: "starter", actions: esignActions.map((action) => action.id), receiptRecordType: "esign-command-receipt", aiAuditRecordType: "esign-ai-request-audit" });
  });

  it("enforces plan, enabled-module, tenant, role, and exact action scopes", async () => {
    const context = await fixture();
    const other = await fixture();
    const draft = await draftEnvelope(context);
    await expect(executeEsignAction(context.store, { ...context.auth, workspaceId: other.workspace.id }, "esign", "envelope-preview", { envelopeId: draft.envelope.id, expectedVersion: 1 }, deps)).rejects.toThrow(/storage transaction|workspace/);
    await expect(executeEsignAction(context.store, { ...context.auth, scopes: ["esign:read"] }, "esign", "template-create", { name: "Denied", purpose: "No write scope", idempotencyKey: key("denied-scope") }, deps)).rejects.toThrow(/esign:write scope/);
    await expect(executeEsignAction(context.store, { ...context.auth, role: "viewer" }, "esign", "template-create", { name: "Denied", purpose: "Wrong role", idempotencyKey: key("denied-role") }, deps)).rejects.toThrow(/role/);
    await expect(other.run("envelope-preview", { envelopeId: draft.envelope.id, expectedVersion: 1 })).rejects.toThrow(/not found/);
    const unpaid = new MemorySuiteStore("none");
    const unpaidUser = randomUUID();
    const unpaidWorkspace = await unpaid.getOrCreateWorkspace(unpaidUser);
    await expect(executeEsignAction(unpaid, { userId: unpaidUser, workspaceId: unpaidWorkspace.id, role: "owner", scopes: ["*"] }, "esign", "template-create", { name: "Denied", purpose: "No plan", idempotencyKey: key("unpaid") }, deps)).rejects.toThrow(/paid plan/);
  });

  it("serializes retries into one durable result and rejects idempotency-key equivocation", async () => {
    const context = await fixture();
    const receiptLookups = vi.spyOn(context.store, "findCommandReceipt");
    const recordLists = vi.spyOn(context.store, "listRecords");
    const input = { name: "Atomic agreement", purpose: "One exact result", idempotencyKey: key("atomic-template") };
    const [created, replayed] = await Promise.all([context.run("template-create", input), context.run("template-create", input)]);
    expect(first(created).id).toBe(first(replayed).id);
    expect([created.audit.replayed, replayed.audit.replayed].sort()).toEqual([false, true]);
    expect(receiptLookups).toHaveBeenCalledWith(context.userId, { recordType: "esign-command-receipt", moduleId: "esign", actionId: "template-create", idempotencyKey: input.idempotencyKey });
    expect(recordLists.mock.calls.filter(([, query]) => query.recordType === "esign-command-receipt")).toHaveLength(0);
    expect(await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "template", limit: 20 })).toHaveLength(1);
    expect(await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "esign-command-receipt", limit: 20 })).toHaveLength(1);
    await expect(context.run("template-create", { ...input, purpose: "Changed input" })).rejects.toThrow(/idempotency key/);
    const adminId = randomUUID();
    await context.store.addWorkspaceMember(context.userId, adminId, "admin");
    const adminAuth: EsignAuthorization = { userId: adminId, workspaceId: context.workspace.id, role: "admin", scopes: ["*"] };
    await expect(executeEsignAction(context.store, adminAuth, "esign", "template-create", input, deps)).rejects.toThrow(/idempotency key belongs to another actor/);
    expect(await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "template", limit: 20 })).toHaveLength(1);
    expect(await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "esign-command-receipt", limit: 20 })).toHaveLength(1);
  });

  it("completes the hash-bound workflow without persisting plaintext tokens or field values", async () => {
    const context = await fixture();
    const draft = await draftEnvelope(context);
    const dispatched = await dispatch(context, draft.envelope.id);
    expect(first(dispatched, "envelope")).toMatchObject({ state: "ready-for-manual-dispatch", data: { version: 2, deliveryClaimed: false } });
    const signerId = String(draft.signers[0].signerId);
    const sessionDry = await context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId, expectedEnvelopeVersion: 2, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: true, idempotencyKey: key("session-dry") });
    expect(sessionDry).not.toHaveProperty("privateOutput");
    const issued = await context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId, expectedEnvelopeVersion: 2, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: false, approval: approval(context.auth, "session"), idempotencyKey: key("session") });
    const token = issued.privateOutput?.signerSessionToken;
    expect(token).toMatch(/^esig_[A-Za-z0-9_-]{40,100}$/);
    const session = first(issued, "signer-session");
    expect(session.data).toMatchObject({ plaintextTokenPersisted: false, identityAssurance: "not-assessed", version: 1 });
    expect(session.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(await context.store.listRecords(context.userId, { moduleId: "esign", limit: 1_000 }))).not.toContain(token);
    const replay = await context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId, expectedEnvelopeVersion: 2, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: false, approval: approval(context.auth, "session"), idempotencyKey: key("session") });
    expect(replay.privateOutput).toBeUndefined();
    expect(replay.audit.privateOutputUnavailableOnReplay).toBe(true);

    const fact = { fieldId: String(draft.fields[0].fieldId), valueHash: "d".repeat(64), completedAt: clock.toISOString(), method: "drawn-mark" };
    const tokenLookup = vi.spyOn(context.store, "findSignerSessionByTokenHash");
    const tokenValidationLists = vi.spyOn(context.store, "listRecords");
    await expect(context.run("field-completion-record", { envelopeId: draft.envelope.id, signerId, sessionToken: `esig_${"Z".repeat(43)}`, expectedEnvelopeVersion: 3, expectedSessionVersion: 1, fieldFacts: [fact], dryRun: true, idempotencyKey: key("wrong-token") })).rejects.toThrow(/token is invalid/);
    const completionDry = await context.run("field-completion-record", { envelopeId: draft.envelope.id, signerId, sessionToken: token, expectedEnvelopeVersion: 3, expectedSessionVersion: 1, fieldFacts: [fact], dryRun: true, idempotencyKey: key("completion-dry") });
    expect(completionDry.audit).toMatchObject({ plannedEnvelopeState: "completed", rawFieldValuesPersisted: false, signatureComplianceClaimed: false });
    expect(tokenLookup).toHaveBeenCalledWith(context.userId, session.data.tokenHash);
    expect(tokenValidationLists.mock.calls.filter(([, query]) => query.recordType === "signer-session")).toHaveLength(0);
    tokenLookup.mockRestore();
    tokenValidationLists.mockRestore();
    const completion = await context.run("field-completion-record", { envelopeId: draft.envelope.id, signerId, sessionToken: token, expectedEnvelopeVersion: 3, expectedSessionVersion: 1, fieldFacts: [fact], dryRun: false, approval: approval(context.auth, "completion"), idempotencyKey: key("completion") });
    expect(first(completion, "envelope")).toMatchObject({ state: "completed", data: { version: 4 } });
    expect(first(completion, "field-completion").data).toMatchObject({ valueHash: "d".repeat(64), rawValuePersisted: false, identityAssurance: "not-assessed", immutable: true });
    expect(JSON.stringify(await context.store.listRecords(context.userId, { moduleId: "esign", limit: 1_000 }))).not.toContain(token);

    const originalListRecords = context.store.listRecords.bind(context.store);
    const certificateLists = vi.spyOn(context.store, "listRecords").mockImplementation(async (userId, input) => {
      if (input.moduleId === "esign" && input.recordType === undefined && input.limit === esignBoundedScanLimit + 1) {
        return Array.from({ length: esignBoundedScanLimit + 1 }, () => session);
      }
      return originalListRecords(userId, input);
    });
    await expect(context.run("certificate-export", { envelopeId: draft.envelope.id, expectedVersion: 4, format: "canonical-json", dryRun: true, idempotencyKey: key("certificate-saturated") })).rejects.toThrow(/bounded esign\/all-records scan is saturated/);
    expect(certificateLists).toHaveBeenCalledWith(context.userId, { moduleId: "esign", recordType: undefined, limit: esignBoundedScanLimit + 1 });
    certificateLists.mockRestore();

    const certificateDry = await context.run("certificate-export", { envelopeId: draft.envelope.id, expectedVersion: 4, format: "canonical-json", dryRun: true, idempotencyKey: key("certificate-dry") });
    expect(certificateDry.audit).toMatchObject({ legalComplianceCertified: false, qualifiedSignatureClaimed: false, privateExport: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const certificate = await context.run("certificate-export", { envelopeId: draft.envelope.id, expectedVersion: 4, format: "canonical-json", dryRun: false, approval: approval(context.auth, "certificate"), idempotencyKey: key("certificate") });
    expect(first(certificate, "certificate").data).toMatchObject({ immutable: true, private: true, legalComplianceCertified: false, qualifiedSignatureClaimed: false });
    expect(JSON.stringify(first(certificate, "certificate"))).not.toContain(token);
  });

  it("creates reminder plans without sending, records declines, and voids incomplete history", async () => {
    const context = await fixture();
    const firstDraft = await draftEnvelope(context, { suffix: "decline" });
    await dispatch(context, firstDraft.envelope.id, "decline");
    const signerId = String(firstDraft.signers[0].signerId);
    const issued = await context.run("signer-session-issue", { envelopeId: firstDraft.envelope.id, signerId, expectedEnvelopeVersion: 2, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: false, approval: approval(context.auth, "decline-session"), idempotencyKey: key("decline-session") });
    const reminderDry = await context.run("reminder-plan", { envelopeId: firstDraft.envelope.id, signerId, expectedEnvelopeVersion: 3, channel: "hosted-link", notBefore: "2026-08-25T12:00:00.000Z", note: "One reviewed reminder.", dryRun: true, idempotencyKey: key("reminder-dry") });
    const reminder = await context.run("reminder-plan", { envelopeId: firstDraft.envelope.id, signerId, expectedEnvelopeVersion: 3, channel: "hosted-link", notBefore: "2026-08-25T12:00:00.000Z", note: "One reviewed reminder.", previewHash: reminderDry.audit.previewHash, dryRun: false, approval: approval(context.auth, "reminder"), idempotencyKey: key("reminder") });
    expect(reminder.audit).toMatchObject({ messageSent: false, providerCallStarted: false, externalEffectExecuted: false });
    const declined = await context.run("decline-record", { envelopeId: firstDraft.envelope.id, signerId, sessionToken: issued.privateOutput!.signerSessionToken, expectedEnvelopeVersion: 3, expectedSessionVersion: 1, reason: "I do not agree.", dryRun: false, approval: approval(context.auth, "decline"), idempotencyKey: key("decline") });
    expect(first(declined, "envelope")).toMatchObject({ state: "declined", data: { version: 4 } });
    expect(declined.audit.signatureClaimed).toBe(false);

    const secondDraft = await draftEnvelope(context, { suffix: "void" });
    const voidDry = await context.run("envelope-void", { envelopeId: secondDraft.envelope.id, expectedVersion: 1, reason: "Replaced before dispatch.", dryRun: true, idempotencyKey: key("void-dry") });
    expect(voidDry.audit).toMatchObject({ plannedState: "voided", historyWillBeRetained: true });
    const voided = await context.run("envelope-void", { envelopeId: secondDraft.envelope.id, expectedVersion: 1, reason: "Replaced before dispatch.", dryRun: false, approval: approval(context.auth, "void"), idempotencyKey: key("void") });
    expect(first(voided, "envelope")).toMatchObject({ state: "voided", data: { version: 2 } });
  });

  it("enforces immutable sequential routing before issuing later signer sessions", async () => {
    const context = await fixture();
    const firstSignerId = randomUUID();
    const secondSignerId = randomUUID();
    const firstFieldId = randomUUID();
    const secondFieldId = randomUUID();
    const draft = await draftEnvelope(context, {
      suffix: "routing",
      roles: [{ role: "Reviewer", order: 1 }, { role: "Approver", order: 2 }],
      fields: [
        { fieldId: firstFieldId, signerRole: "Reviewer", kind: "checkbox", page: 1, xBasisPoints: 1_000, yBasisPoints: 1_000, widthBasisPoints: 500, heightBasisPoints: 500, required: true },
        { fieldId: secondFieldId, signerRole: "Approver", kind: "signature", page: 1, xBasisPoints: 1_000, yBasisPoints: 8_000, widthBasisPoints: 3_000, heightBasisPoints: 800, required: true },
      ],
      signers: [
        { signerId: firstSignerId, signerKeyHash: "1".repeat(64), role: "Reviewer", order: 1, authentication: "platform-account", locale: "en-US" },
        { signerId: secondSignerId, signerKeyHash: "2".repeat(64), role: "Approver", order: 2, authentication: "access-link", locale: "en-US" },
      ],
    });
    await dispatch(context, draft.envelope.id, "routing");
    const firstSession = await context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId: firstSignerId, expectedEnvelopeVersion: 2, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: false, approval: approval(context.auth, "routing-first-session"), idempotencyKey: key("routing-first-session") });
    await expect(context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId: secondSignerId, expectedEnvelopeVersion: 3, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: false, approval: approval(context.auth, "routing-blocked-session"), idempotencyKey: key("routing-blocked-session") })).rejects.toThrow(/Earlier signer routes/);
    await context.run("field-completion-record", { envelopeId: draft.envelope.id, signerId: firstSignerId, sessionToken: firstSession.privateOutput!.signerSessionToken, expectedEnvelopeVersion: 3, expectedSessionVersion: 1, fieldFacts: [{ fieldId: firstFieldId, valueHash: "3".repeat(64), completedAt: clock.toISOString(), method: "selected-checkbox" }], dryRun: false, approval: approval(context.auth, "routing-first-completion"), idempotencyKey: key("routing-first-completion") });
    const secondSession = await context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId: secondSignerId, expectedEnvelopeVersion: 4, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: false, approval: approval(context.auth, "routing-second-session"), idempotencyKey: key("routing-second-session") });
    expect(first(secondSession, "signer-session").data).toMatchObject({ signerId: secondSignerId, routeOrder: 2, plaintextTokenPersisted: false });
  });

  it("closes an expired signer session before issuing its replacement", async () => {
    const context = await fixture();
    const draft = await draftEnvelope(context, { suffix: "expired-session" });
    await dispatch(context, draft.envelope.id, "expired-session");
    const signerId = String(draft.signers[0].signerId);
    const original = await context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId, expectedEnvelopeVersion: 2, expiresAt: "2026-08-24T19:00:00.000Z", dryRun: false, approval: approval(context.auth, "original-session"), idempotencyKey: key("original-session") });
    const originalSession = first(original, "signer-session");
    const originalListRecords = context.store.listRecords.bind(context.store);
    const sessionLists = vi.spyOn(context.store, "listRecords").mockImplementation(async (userId, input) => {
      if (input.moduleId === "esign" && input.recordType === "signer-session" && input.limit === esignBoundedScanLimit + 1) {
        return Array.from({ length: esignBoundedScanLimit + 1 }, () => originalSession);
      }
      return originalListRecords(userId, input);
    });
    const replacementInput = { envelopeId: draft.envelope.id, signerId, expectedEnvelopeVersion: 3, expiresAt: "2026-08-25T20:00:00.000Z", dryRun: false, approval: approval(context.auth, "replacement-session"), idempotencyKey: key("replacement-session") };
    await expect(executeEsignAction(context.store, context.auth, "esign", "signer-session-issue", replacementInput, { ...deps, now: () => new Date("2026-08-24T20:00:00.000Z") })).rejects.toThrow(/bounded esign\/signer-session scan is saturated/);
    expect(sessionLists).toHaveBeenCalledWith(context.userId, { moduleId: "esign", recordType: "signer-session", limit: esignBoundedScanLimit + 1 });
    sessionLists.mockRestore();
    const replacement = await executeEsignAction(context.store, context.auth, "esign", "signer-session-issue", replacementInput, { ...deps, now: () => new Date("2026-08-24T20:00:00.000Z") });
    expect((await context.store.getRecord(context.userId, originalSession.id))?.state).toBe("expired");
    expect(replacement.audit.expiredSessionIdsClosed).toEqual([originalSession.id]);
    expect(replacement.records.find((record) => record.recordType === "signer-session" && record.state === "active")?.id).not.toBe(originalSession.id);
  });

  it("rejects object traversal, stale hashes, stale versions, invalid field geometry, and missing approval", async () => {
    const context = await fixture();
    await expect(context.run("document-register", { title: "bad.pdf", objectRef: "tenant/../private/bad.pdf", objectVersion: "v1", sha256: "a".repeat(64), sizeBytes: 10, contentType: "application/pdf", pageCount: 1, idempotencyKey: key("traversal") })).rejects.toThrow(/traversal/);
    const template = first(await context.run("template-create", { name: "Geometry", purpose: "Reject invalid geometry", idempotencyKey: key("geometry-template") }));
    await expect(context.run("template-version-create", { templateId: template.id, expectedTemplateVersion: 0, signerRoles: [{ role: "Signer", order: 1 }], fields: [{ fieldId: randomUUID(), signerRole: "Signer", kind: "signature", page: 1, xBasisPoints: 9_000, yBasisPoints: 1_000, widthBasisPoints: 2_000, heightBasisPoints: 500, required: true }], disclosure: "Review.", idempotencyKey: key("bad-geometry") })).rejects.toThrow(/page boundary/);
    const draft = await draftEnvelope(context, { suffix: "guards" });
    const preview = await context.run("envelope-preview", { envelopeId: draft.envelope.id, expectedVersion: 1 });
    await expect(context.run("envelope-dispatch-plan", { envelopeId: draft.envelope.id, expectedVersion: 1, previewHash: "f".repeat(64), channel: "hosted-link", dryRun: false, approval: approval(context.auth, "stale"), idempotencyKey: key("stale-hash") })).rejects.toThrow(/preview hash/);
    await expect(context.run("envelope-dispatch-plan", { envelopeId: draft.envelope.id, expectedVersion: 1, previewHash: preview.audit.previewHash, channel: "hosted-link", dryRun: false, idempotencyKey: key("missing-approval") })).rejects.toThrow(/human approval/);
    await expect(context.run("envelope-preview", { envelopeId: draft.envelope.id, expectedVersion: 2 })).rejects.toThrow(/version is stale/);
  });

  it("requires fresh single-use approval decisions and binds them at the receipt boundary", async () => {
    const context = await fixture();
    const draft = await draftEnvelope(context, { suffix: "approval-guard" });
    const preview = await context.run("envelope-preview", { envelopeId: draft.envelope.id, expectedVersion: 1 });
    const decisionLookups = vi.spyOn(context.store, "findApprovalDecisionReceipt");
    const recordLists = vi.spyOn(context.store, "listRecords");
    const stale = { ...approval(context.auth, "stale-clock"), approvedAt: new Date(clock.getTime() - 24 * 60 * 60 * 1_000 - 1).toISOString() };
    await expect(context.run("envelope-dispatch-plan", { envelopeId: draft.envelope.id, expectedVersion: 1, previewHash: preview.audit.previewHash, channel: "hosted-link", dryRun: false, approval: stale, idempotencyKey: key("stale-clock") })).rejects.toThrow(/stale|24 hours/);

    const sharedDecision = approval(context.auth, "single-use");
    await context.run("envelope-dispatch-plan", { envelopeId: draft.envelope.id, expectedVersion: 1, previewHash: preview.audit.previewHash, channel: "hosted-link", dryRun: false, approval: sharedDecision, idempotencyKey: key("single-use-dispatch") });
    const receipt = (await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "esign-command-receipt", limit: 100 })).find((record) => record.data.idempotencyKey === key("single-use-dispatch"));
    expect(receipt?.data).toMatchObject({ actionId: "envelope-dispatch-plan", actorUserId: context.userId, approvalDecisionId: sharedDecision.decisionId, approvedBy: context.userId, approvedAt: clock.toISOString() });
    await expect(context.run("signer-session-issue", { envelopeId: draft.envelope.id, signerId: draft.signers[0].signerId, expectedEnvelopeVersion: 2, expiresAt: "2026-08-25T18:00:00.000Z", dryRun: false, approval: sharedDecision, idempotencyKey: key("single-use-session") })).rejects.toThrow(/approval decision was already used/);
    expect(await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "signer-session", limit: 20 })).toHaveLength(0);
    expect(decisionLookups).toHaveBeenCalledWith(context.userId, sharedDecision.decisionId);
    expect(recordLists.mock.calls.filter(([, query]) => query.recordType === "esign-command-receipt")).toHaveLength(1);
  });

  it("rejects another requester's private AI audit as evidence through the full trusted transaction path", async () => {
    const context = await fixture();
    const draft = await draftEnvelope(context, { suffix: "private-evidence" });
    const ownerQueued = await context.run("clause-propose", { templateVersionId: draft.templateVersion.id, instruction: "Prepare the owner's private cited review.", evidenceIds: [draft.templateVersion.id], idempotencyKey: key("private-owner-ai") });
    const privateAudit = first(ownerQueued, "esign-ai-request-audit");
    const memberId = randomUUID();
    await context.store.addWorkspaceMember(context.userId, memberId, "member");
    const memberAuth: EsignAuthorization = { userId: memberId, workspaceId: context.workspace.id, role: "member", scopes: ["*"] };
    expect(await context.store.getRecord(memberId, privateAudit.id)).toBeUndefined();
    await expect(executeEsignAction(context.store, memberAuth, "esign", "clause-propose", {
      templateVersionId: draft.templateVersion.id,
      instruction: "Attempt to use another requester's private audit.",
      evidenceIds: [privateAudit.id],
      idempotencyKey: key("private-member-ai"),
    }, deps)).rejects.toThrow(/AI evidence record was not found/);
  });

  it("queues cited AI proposals under the immutable platform policy and never mutates workflow state", async () => {
    const context = await fixture();
    const draft = await draftEnvelope(context, { suffix: "ai" });
    const queued = await context.run("clause-propose", { templateVersionId: draft.templateVersion.id, instruction: "Propose clearer cited language for legal review.", evidenceIds: [draft.templateVersion.id, draft.document.id], idempotencyKey: key("clause-ai") });
    expect(queued).toMatchObject({ kind: "ai-action", audit: { promptId: "esign.clause-propose", platformPromptId: "first-party.esign.review-proposals", platformPromptVersion: "2026-08-24.1", platformPromptDigest: expect.stringMatching(/^[a-f0-9]{64}$/), output: null, confidence: null, approvalRequired: true, automaticMutationAllowed: false, externalEffectExecuted: false } });
    const completion = { proposals: [{ proposalId: "clause-1", kind: "clause", text: "Proposed review language.", citations: [draft.templateVersion.id], rationale: "The template disclosure is the cited source.", riskFlags: ["Legal review required."] }], confidence: 0.74, assumptions: ["The selected evidence is complete."], reviewStatus: "pending-human-review" as const, approvalRequired: true as const, model: "local-model-v1" };
    expect(() => validateEsignAiCompletion({ ...completion, proposals: [{ ...completion.proposals[0], kind: "routing" }] }, { authorizedRecordIds: [draft.templateVersion.id, draft.document.id], allowedProposalKinds: ["clause"] })).toThrow(/kind exceeds/);
    expect(() => validateEsignAiCompletion({ ...completion, proposals: [{ ...completion.proposals[0], citations: [randomUUID()] }] }, { authorizedRecordIds: [draft.templateVersion.id, draft.document.id], allowedProposalKinds: ["clause"] })).toThrow(/cite only authorized/);
    const claimed = await context.store.claimAiAction();
    expect(claimed?.action.id).toBe(queued.aiAction?.id);
    expect(claimed?.records.map((record) => record.id)).toEqual(expect.arrayContaining([draft.templateVersion.id, draft.document.id]));
    await context.store.completeAiAction(claimed!.action.id, { status: "completed", result: completion });
    const recorded = await recordEsignAiCompletion(context.store, context.auth, claimed!.action.id, undefined, clock);
    expect(recorded).toMatchObject({ replayed: false, auditRecord: { state: "pending-human-review", data: { executedModel: "local-model-v1", confidence: 0.74, proposalCount: 1, proposalKinds: ["clause"], reviewStatus: "pending-human-review", automaticMutationAllowed: false, signatureOrConsentAllowed: false, externalEffectExecuted: false } } });
    expect((await context.store.getRecord(context.userId, draft.templateVersion.id))?.state).toBe("immutable");
    expect((await recordEsignAiCompletion(context.store, context.auth, claimed!.action.id, completion, clock)).replayed).toBe(true);
  });
});
