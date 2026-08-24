import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import type { SuiteAiAction, SuiteRecord, SuiteWorkspaceRole } from "../shared/suite.js";
import { emailAction, emailActions, type EmailActionDefinition } from "../shared/email-actions.js";
import type { SuiteStore } from "./suite-store.js";
import { emailPromptDigest, emailPromptPolicy } from "./prompts/email.js";
import { canReadSuiteRecord } from "./suite-record-visibility.js";

export interface EmailAuthorization {
  userId: string;
  workspaceId: string;
  role: SuiteWorkspaceRole;
  scopes: string[];
}

export interface EmailApproval {
  approved: true;
  approvedBy: string;
  approvedAt: string;
  decisionId: string;
  reason: string;
}

export interface EmailEngineDependencies {
  now: () => Date;
  modelPolicyId: string;
}

export interface EmailExecutionResult {
  kind: "read" | "command" | "ai-action";
  action: EmailActionDefinition;
  records: SuiteRecord[];
  audit: Record<string, unknown>;
  aiAction?: SuiteAiAction;
  privateOutput?: {
    audienceExport: {
      format: "canonical-json" | "csv";
      rows: Array<Record<string, unknown>>;
      contentHash: string;
    };
  };
}

export interface EmailAiProposal {
  proposalId: string;
  kind: "subject" | "body";
  content: string;
  citations: string[];
  rationale: string;
  riskFlags: string[];
}

export interface EmailAiCompletion {
  version: "letterline-ai-result.v1";
  proposals: EmailAiProposal[];
  confidence: number;
  assumptions: string[];
  reviewStatus: "pending-human-review";
  approvalRequired: true;
  model: string;
}

const defaults: EmailEngineDependencies = {
  now: () => new Date(),
  modelPolicyId: "workspace-configured-model",
};
const moduleId = "email";
const receiptType = "email-command-receipt";
const aiAuditType = "email-ai-request-audit";
export const emailBoundedScanLimit = 100_000;
const approvalFreshnessMs = 24 * 60 * 60 * 1_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function object(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function validateString(value: unknown, schema: Record<string, unknown>, path: string) {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(`${path} is too short.`);
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(`${path} is too long.`);
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format.`);
  if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${path} must be a UUID.`);
  if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(new Date(value).getTime()))) throw new Error(`${path} must be an ISO date-time.`);
}

function validate(value: unknown, schema: Record<string, unknown>, path: string): void {
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((candidate) => { try { validate(value, candidate as Record<string, unknown>, path); return true; } catch { return false; } })) throw new Error(`${path} does not match an allowed shape.`);
    return;
  }
  if ("const" in schema && value !== schema.const) throw new Error(`${path} must equal the required constant.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} must be an allowed value.`);
  if (schema.type === "string") return validateString(value, schema, path);
  if (schema.type === "boolean") { if (typeof value !== "boolean") throw new Error(`${path} must be boolean.`); return; }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer.`);
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`${path} is below its minimum.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`${path} exceeds its maximum.`);
    return;
  }
  if (schema.type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite.`); return; }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${path} has too few items.`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} has too many items.`);
    if (schema.items && typeof schema.items === "object") value.forEach((item, index) => validate(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
    return;
  }
  if (schema.type === "object") {
    const source = object(value, path);
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in source)) throw new Error(`${path}.${key} is required.`);
    if (schema.additionalProperties === false && properties) for (const key of Object.keys(source)) if (!(key in properties)) throw new Error(`${path}.${key} is not allowed.`);
    if (properties) for (const [key, item] of Object.entries(source)) if (properties[key]) validate(item, properties[key], `${path}.${key}`);
  }
}

function strictKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label} contains fields outside the approved contract.`);
}

function iso(value: unknown, label: string) {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid ISO date-time.`);
  return parsed.toISOString();
}

function notFuture(value: unknown, label: string, now: Date) {
  const normalized = iso(value, label);
  if (new Date(normalized).getTime() > now.getTime() + 5 * 60_000) throw new Error(`${label} cannot be in the future.`);
  return normalized;
}

function version(record: SuiteRecord) {
  const value = Number(record.data.version ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function requireVersion(record: SuiteRecord, supplied: unknown, label = "record") {
  if (!Number.isSafeInteger(supplied) || Number(supplied) !== version(record)) throw new Error(`The ${label} version is stale.`);
  return version(record) + 1;
}

export function normalizeEmailAddress(value: unknown) {
  if (typeof value !== "string") throw new Error("Email must be a string.");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 3 || normalized.length > 320 || /[\s\u0000-\u001f\u007f]/.test(normalized)) throw new Error("Email has an invalid format.");
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at !== normalized.indexOf("@")) throw new Error("Email has an invalid format.");
  const local = normalized.slice(0, at).toLowerCase();
  const rawDomain = normalized.slice(at + 1).toLowerCase();
  const domain = domainToASCII(rawDomain);
  if (!domain || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) throw new Error("Email has an invalid format.");
  if (domain.length > 253 || !domain.includes(".") || domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error("Email domain has an invalid format.");
  return `${local}@${domain}`;
}

function result(action: EmailActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>, kind: EmailExecutionResult["kind"] = "command"): EmailExecutionResult {
  return { kind, action, records, audit };
}

async function create(store: SuiteStore, auth: EmailAuthorization, input: Parameters<SuiteStore["createRecord"]>[1]) {
  const record = await store.createRecord(auth.userId, input);
  if (!record) throw new Error("The Letterline workspace record could not be persisted.");
  return record;
}

async function update(store: SuiteStore, auth: EmailAuthorization, record: SuiteRecord, input: Parameters<SuiteStore["updateRecord"]>[2]) {
  const updated = await store.updateRecord(auth.userId, record.id, input);
  if (!updated) throw new Error("The Letterline workspace record could not be updated.");
  return updated;
}

function canRead(auth: EmailAuthorization, record: SuiteRecord) {
  return canReadSuiteRecord({ userId: auth.userId, workspaceId: auth.workspaceId, role: auth.role }, record);
}

async function owned(store: SuiteStore, auth: EmailAuthorization, id: unknown, recordType?: string, label = "recordId") {
  if (typeof id !== "string") throw new Error(`${label} must be a record ID.`);
  const record = await store.getRecord(auth.userId, id);
  if (!record || !canRead(auth, record) || record.moduleId !== moduleId || (recordType && record.recordType !== recordType)) throw new Error(`${label.replace(/Id$/, "")} not found in this workspace.`);
  return record;
}

async function list(store: SuiteStore, auth: EmailAuthorization, recordType?: string) {
  const records = await store.listRecords(auth.userId, { moduleId, recordType, limit: emailBoundedScanLimit + 1 });
  if (records.length > emailBoundedScanLimit) throw new Error(`The bounded email/${recordType ?? "all-records"} scan is saturated; an indexed or paginated SuiteStore lookup is required before this action can run safely.`);
  return records.filter((record) => canRead(auth, record));
}

async function authorize(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition) {
  const workspace = await store.getOrCreateWorkspace(auth.userId);
  if (workspace.id !== auth.workspaceId) throw new Error("The authorization workspace does not match the storage tenant.");
  if (workspace.currentRole !== auth.role) throw new Error("The supplied role does not match the workspace membership.");
  if (!["starter", "scale", "fleet"].includes(workspace.plan)) throw new Error("The email module requires a paid plan.");
  if (!workspace.enabledModuleIds.includes(moduleId)) throw new Error("Enable the email module before using it.");
  if (!auth.scopes.includes("*") && !auth.scopes.includes(`email:${action.requiredScope}`)) throw new Error(`The email:${action.requiredScope} scope is required.`);
  if (auth.role === "viewer" && action.operation !== "read") throw new Error("Viewers cannot mutate email records or queue AI work.");
  if (action.approvalRequired && !["owner", "admin"].includes(auth.role)) throw new Error("Only an owner or administrator may approve this email action.");
}

function approval(input: Record<string, unknown>, auth: EmailAuthorization, now: Date): EmailApproval {
  const candidate = input.approval as EmailApproval | undefined;
  if (!candidate || candidate.approved !== true || candidate.approvedBy !== auth.userId || !candidate.reason?.trim() || !/^[A-Za-z0-9._:-]{16,200}$/.test(candidate.decisionId ?? "")) throw new Error("An attributable, reasoned, uniquely identified human approval is required when dryRun is false.");
  const approvedAt = new Date(candidate.approvedAt);
  if (!Number.isFinite(approvedAt.getTime()) || approvedAt.getTime() > now.getTime() + 5 * 60_000) throw new Error("The approval clock is invalid or in the future.");
  if (approvedAt.getTime() < now.getTime() - approvalFreshnessMs) throw new Error("The human approval is stale; approval must be no more than 24 hours old.");
  return { ...candidate, approvedAt: approvedAt.toISOString(), reason: candidate.reason.trim() };
}

async function assertApprovalDecisionUnused(store: SuiteStore, auth: EmailAuthorization, approved: EmailApproval) {
  const reused = await store.findApprovalDecisionReceipt(auth.userId, approved.decisionId);
  if (reused) throw new Error("The human approval decision was already used by another email command.");
}

async function replay(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, key: string, requestHash: string) {
  const receipt = await store.findCommandReceipt(auth.userId, { recordType: receiptType, moduleId, actionId: action.id, idempotencyKey: key });
  if (!receipt) return undefined;
  if (receipt.data.actorUserId !== auth.userId) throw new Error("The email idempotency key belongs to another actor.");
  if (receipt.data.requestHash !== requestHash) throw new Error("The idempotency key was already used for a different email command.");
  const records: SuiteRecord[] = [];
  for (const id of Array.isArray(receipt.data.resultRecordIds) ? receipt.data.resultRecordIds : []) {
    const record = await store.getRecord(auth.userId, String(id));
    if (record && canRead(auth, record)) records.push(record);
  }
  const aiAction = typeof receipt.data.aiActionId === "string" ? await store.getAiAction(auth.userId, receipt.data.aiActionId) : undefined;
  const audit = { ...(receipt.data.audit as Record<string, unknown>), receiptId: receipt.id, requestHash, replayed: true, ...(action.id === "audience-export" ? { privateOutputUnavailableOnReplay: true } : {}) };
  return { kind: aiAction ? "ai-action" : "command", action, records, audit, ...(aiAction ? { aiAction } : {}) } satisfies EmailExecutionResult;
}

async function saveReceipt(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, key: string, requestHash: string, execution: EmailExecutionResult) {
  const approvalBinding = typeof execution.audit.approvalDecisionId === "string"
    ? { approvalDecisionId: execution.audit.approvalDecisionId, approvedBy: execution.audit.approvedBy, approvedAt: execution.audit.approvedAt }
    : {};
  const receipt = await create(store, auth, { moduleId, recordType: receiptType, title: `${action.id} · ${key.slice(0, 48)}`, state: "recorded", data: { actionId: action.id, idempotencyKey: key, requestHash, resultRecordIds: execution.records.map((record) => record.id), aiActionId: execution.aiAction?.id, audit: execution.audit, actorUserId: auth.userId, workspaceId: auth.workspaceId, ...approvalBinding, immutable: true, providerCredentialsStored: false, privateOutputStored: false } });
  execution.audit = { ...execution.audit, receiptId: receipt.id, requestHash, replayed: false };
  return execution;
}

function consentBoundary(input: Record<string, unknown>, audience: SuiteRecord, now: Date, mode: "initial" | "reactivation") {
  const consent = object(input.consent, "consent");
  const capturedAt = notFuture(consent.capturedAt, "consent.capturedAt", now);
  if (consent.granted !== true || consent.purchasedList !== false) throw new Error("Explicit consent is required and purchased-list enrollment is forbidden.");
  if (consent.policyVersion !== audience.data.consentPolicyVersion) throw new Error("Consent policy version does not match the audience boundary.");
  if (!Array.isArray(consent.purposes) || new Set(consent.purposes).size !== consent.purposes.length) throw new Error("Consent purposes must be unique.");
  if (mode === "initial" && consent.reconfirmationAfterSuppression !== false) throw new Error("Initial opt-in cannot claim suppression reconfirmation.");
  if (mode === "reactivation" && (consent.reconfirmationAfterSuppression !== true || consent.doubleOptInConfirmed !== true)) throw new Error("Reactivation requires explicit suppression reconfirmation and double opt-in.");
  return { ...consent, capturedAt };
}

async function createConsentReceipt(store: SuiteStore, auth: EmailAuthorization, input: { subscriber: SuiteRecord; audience: SuiteRecord; consent: Record<string, unknown>; kind: "initial-opt-in" | "repeat-opt-in" | "reactivation"; now: Date }) {
  const receiptPayload = {
    schema: "letterline-consent-receipt.v1",
    kind: input.kind,
    subscriberId: input.subscriber.id,
    emailHash: input.subscriber.data.emailHash,
    audienceId: input.audience.id,
    policyVersion: input.consent.policyVersion,
    purposes: input.consent.purposes,
    capturedAt: input.consent.capturedAt,
    captureMethod: input.consent.captureMethod,
    sourceProofHash: input.consent.sourceProofHash,
    purchasedList: false,
    doubleOptInConfirmed: input.consent.doubleOptInConfirmed,
    reconfirmationAfterSuppression: input.consent.reconfirmationAfterSuppression,
  };
  const receiptHash = digest(receiptPayload);
  const prior = (await list(store, auth, "consent-receipt")).find((record) => record.data.receiptHash === receiptHash);
  if (prior) return prior;
  return create(store, auth, { moduleId, recordType: "consent-receipt", title: `Consent receipt · ${String(input.subscriber.data.emailHash).slice(0, 12)}`, state: "immutable", data: { ...receiptPayload, receiptHash, recordedAt: input.now.toISOString(), immutable: true, providerCredentialsStored: false, version: 1 } });
}

async function audienceCreate(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  const audience = await create(store, auth, { moduleId, recordType: "audience", title: String(input.name).trim(), state: "active", data: { purpose: String(input.purpose).trim(), consentPolicyVersion: String(input.consentPolicyVersion), description: input.description, createdByUserId: auth.userId, createdAt: now.toISOString(), version: 1 } });
  return result(action, [audience], { audienceId: audience.id, consentPolicyVersion: audience.data.consentPolicyVersion, purchasedListAllowed: false });
}

async function subscriberOptIn(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  const audience = await owned(store, auth, input.audienceId, "audience", "audienceId");
  const normalizedEmail = normalizeEmailAddress(input.email);
  const emailHash = digest({ normalizedEmail });
  const consent = consentBoundary(input, audience, now, "initial");
  const existing = (await list(store, auth, "subscriber")).find((record) => record.data.emailHash === emailHash);
  if (existing?.state === "suppressed") throw new Error("A suppressed subscriber must use the explicit reactivation action and a newer double opt-in.");
  if (existing && new Date(String(consent.capturedAt)).getTime() < new Date(String(existing.data.consentCapturedAt ?? 0)).getTime()) throw new Error("A repeated opt-in cannot predate the subscriber's current consent receipt.");
  let subscriber = existing;
  if (!subscriber) {
    subscriber = await create(store, auth, { moduleId, recordType: "subscriber", title: `Subscriber · ${emailHash.slice(0, 12)}`, state: "active", data: { normalizedEmail, emailHash, displayName: input.displayName, locale: input.locale, audienceIds: [audience.id], consentCapturedAt: consent.capturedAt, version: 1, providerCredentialsStored: false } });
  }
  else {
    const audienceIds = Array.isArray(subscriber.data.audienceIds) ? subscriber.data.audienceIds.map(String) : [];
    subscriber = await update(store, auth, subscriber, { state: "active", data: { audienceIds: [...new Set([...audienceIds, audience.id])], displayName: input.displayName ?? subscriber.data.displayName, locale: input.locale ?? subscriber.data.locale, consentCapturedAt: consent.capturedAt, version: version(subscriber) + 1 } });
  }
  const receipt = await createConsentReceipt(store, auth, { subscriber, audience, consent, kind: existing ? "repeat-opt-in" : "initial-opt-in", now });
  subscriber = await update(store, auth, subscriber, { data: { currentConsentReceiptId: receipt.id, currentConsentReceiptHash: receipt.data.receiptHash } });
  return result(action, [subscriber, receipt], { subscriberId: subscriber.id, consentReceiptId: receipt.id, consentReceiptHash: receipt.data.receiptHash, emailHash, deduplicatedExistingSubscriber: Boolean(existing), purchasedListAllowed: false, normalizedEmailStoredOnlyOnSubscriber: true });
}

async function latestSuppression(store: SuiteStore, auth: EmailAuthorization, subscriberId: string) {
  return (await list(store, auth, "suppression"))
    .filter((record) => record.data.subscriberId === subscriberId)
    .sort((left, right) => String(right.data.occurredAt).localeCompare(String(left.data.occurredAt)) || right.id.localeCompare(left.id))[0];
}

async function subscriberReactivate(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  let subscriber = await owned(store, auth, input.subscriberId, "subscriber", "subscriberId");
  const audience = await owned(store, auth, input.audienceId, "audience", "audienceId");
  if (subscriber.state !== "suppressed") throw new Error("Only a currently suppressed subscriber can be reactivated.");
  const suppression = await latestSuppression(store, auth, subscriber.id);
  if (!suppression) throw new Error("The immutable suppression evidence is missing.");
  if (!["unsubscribe", "manual"].includes(String(suppression.data.reason))) throw new Error("Hard-bounce, complaint, and legal-block suppressions cannot be reactivated here.");
  const consent = consentBoundary(input, audience, now, "reactivation");
  if (new Date(String(consent.capturedAt)).getTime() <= new Date(String(suppression.data.occurredAt)).getTime()) throw new Error("Reactivation consent must be newer than the latest suppression.");
  const audienceIds = Array.isArray(subscriber.data.audienceIds) ? subscriber.data.audienceIds.map(String) : [];
  subscriber = await update(store, auth, subscriber, { state: "active", data: { audienceIds: [...new Set([...audienceIds, audience.id])], consentCapturedAt: consent.capturedAt, reactivatedAt: now.toISOString(), reactivatedFromSuppressionId: suppression.id, version: version(subscriber) + 1 } });
  const receipt = await createConsentReceipt(store, auth, { subscriber, audience, consent, kind: "reactivation", now });
  subscriber = await update(store, auth, subscriber, { data: { currentConsentReceiptId: receipt.id, currentConsentReceiptHash: receipt.data.receiptHash } });
  return result(action, [subscriber, receipt], { subscriberId: subscriber.id, consentReceiptId: receipt.id, reactivatedFromSuppressionId: suppression.id, doubleOptInRequired: true, purchasedListAllowed: false });
}

async function applySuppression(store: SuiteStore, auth: EmailAuthorization, input: { subscriber: SuiteRecord; reason: string; occurredAt: string; evidenceHash: string; source: string; sourceRecordId?: string; note?: unknown; now: Date }) {
  const consentAt = new Date(String(input.subscriber.data.consentCapturedAt ?? 0)).getTime();
  if (new Date(input.occurredAt).getTime() < consentAt) throw new Error("A suppression event cannot be backdated before the current consent receipt.");
  const payload = { schema: "letterline-suppression.v1", subscriberId: input.subscriber.id, emailHash: input.subscriber.data.emailHash, reason: input.reason, occurredAt: input.occurredAt, evidenceHash: input.evidenceHash, source: input.source, sourceRecordId: input.sourceRecordId };
  const suppressionHash = digest(payload);
  const existing = (await list(store, auth, "suppression")).find((record) => record.data.suppressionHash === suppressionHash);
  if (existing) return { suppression: existing, subscriber: input.subscriber, replayed: true };
  const suppression = await create(store, auth, { moduleId, recordType: "suppression", title: `Suppression · ${String(input.subscriber.data.emailHash).slice(0, 12)}`, state: "immutable", data: { ...payload, suppressionHash, note: input.note, recordedAt: input.now.toISOString(), immutable: true, version: 1 } });
  const subscriber = await update(store, auth, input.subscriber, { state: "suppressed", data: { suppressedAt: input.occurredAt, currentSuppressionId: suppression.id, currentSuppressionHash: suppressionHash, suppressionReason: input.reason, version: version(input.subscriber) + 1 } });
  return { suppression, subscriber, replayed: false };
}

async function subscriberSuppress(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  const subscriber = await owned(store, auth, input.subscriberId, "subscriber", "subscriberId");
  const occurredAt = notFuture(input.occurredAt, "occurredAt", now);
  const applied = await applySuppression(store, auth, { subscriber, reason: String(input.reason), occurredAt, evidenceHash: String(input.evidenceHash), source: "workspace-command", note: input.note, now });
  return result(action, [applied.subscriber, applied.suppression], { subscriberId: subscriber.id, suppressionId: applied.suppression.id, reason: input.reason, immediatelyExcludedFromDispatch: true, replayedSuppressionEvidence: applied.replayed });
}

async function effectivelySuppressed(store: SuiteStore, auth: EmailAuthorization, subscriber: SuiteRecord) {
  if (subscriber.state === "suppressed") return true;
  const suppression = await latestSuppression(store, auth, subscriber.id);
  if (!suppression) return false;
  return new Date(String(suppression.data.occurredAt)).getTime() >= new Date(String(subscriber.data.consentCapturedAt ?? 0)).getTime();
}

async function subscriberList(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>) {
  await owned(store, auth, input.audienceId, "audience", "audienceId");
  const matching: SuiteRecord[] = [];
  let suppressedCount = 0;
  for (const subscriber of await list(store, auth, "subscriber")) {
    const audienceIds = Array.isArray(subscriber.data.audienceIds) ? subscriber.data.audienceIds.map(String) : [];
    if (!audienceIds.includes(String(input.audienceId))) continue;
    const suppressed = await effectivelySuppressed(store, auth, subscriber);
    if (suppressed) suppressedCount += 1;
    if (!suppressed || input.includeSuppressed === true) matching.push(subscriber);
  }
  return result(action, matching, { audienceId: input.audienceId, returnedCount: matching.length, suppressedCount, includeSuppressed: input.includeSuppressed, tenantScoped: true }, "read");
}

async function campaignCreate(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  const audience = await owned(store, auth, input.audienceId, "audience", "audienceId");
  const campaign = await create(store, auth, { moduleId, recordType: "campaign", title: String(input.name).trim(), state: "draft-empty", data: { audienceId: audience.id, audiencePurpose: audience.data.purpose, objective: String(input.objective).trim(), createdByUserId: auth.userId, createdAt: now.toISOString(), version: 1, providerCallStarted: false } });
  return result(action, [campaign], { campaignId: campaign.id, audienceId: audience.id, state: campaign.state, providerCallStarted: false });
}

function campaignContent(input: Record<string, unknown>) {
  const replyToEmail = normalizeEmailAddress(input.replyToEmail);
  const subject = String(input.subject).trim();
  const senderName = String(input.senderName).trim();
  const bodyText = String(input.bodyText);
  const bodyHtml = typeof input.bodyHtml === "string" ? input.bodyHtml : undefined;
  const footer = String(input.footer);
  if (/[\r\n]/.test(subject) || /[\r\n]/.test(senderName)) throw new Error("Subject and sender name cannot contain email header line breaks.");
  if (!bodyText.includes("{{unsubscribe_url}}") || !footer.includes("{{unsubscribe_url}}")) throw new Error("Plain text and footer must include the exact {{unsubscribe_url}} marker.");
  if (bodyHtml && !bodyHtml.includes("{{unsubscribe_url}}")) throw new Error("HTML content must include the exact {{unsubscribe_url}} marker.");
  if (bodyHtml && /<(?:script|iframe|object|embed|form|base)\b|\son[a-z]+\s*=|javascript\s*:/i.test(bodyHtml)) throw new Error("HTML content contains an unsafe active-content construct.");
  return canonical({ subject, preheader: input.preheader, senderName, replyToEmail, bodyText, bodyHtml, footer }) as Record<string, unknown>;
}

async function campaignVersionDraft(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  const campaign = await owned(store, auth, input.campaignId, "campaign", "campaignId");
  const nextCampaignVersion = requireVersion(campaign, input.expectedCampaignVersion, "campaign");
  const content = campaignContent(input);
  const contentHash = digest({ schema: "letterline-campaign-content.v1", campaignId: campaign.id, audienceId: campaign.data.audienceId, content });
  const priorVersions = (await list(store, auth, "campaign-version")).filter((record) => record.data.campaignId === campaign.id);
  const campaignVersion = await create(store, auth, { moduleId, recordType: "campaign-version", title: `${campaign.title} · version ${priorVersions.length + 1}`, state: "immutable", data: { campaignId: campaign.id, audienceId: campaign.data.audienceId, versionNumber: priorVersions.length + 1, content, contentHash, draftedAt: now.toISOString(), draftedByUserId: auth.userId, immutable: true, providerCallStarted: false, version: 1 } });
  const updated = await update(store, auth, campaign, { state: "draft", data: { version: nextCampaignVersion, currentCampaignVersionId: campaignVersion.id, currentContentHash: contentHash, currentReviewId: null, currentApprovalId: null, currentScheduleId: null, currentDispatchPlanId: null } });
  return result(action, [updated, campaignVersion], { campaignId: campaign.id, campaignVersionId: campaignVersion.id, campaignVersionNumber: campaignVersion.data.versionNumber, contentHash, immutableVersion: true, approvalsInvalidated: true, providerCallStarted: false });
}

async function assertCurrentCampaignVersion(store: SuiteStore, auth: EmailAuthorization, campaign: SuiteRecord, input: Record<string, unknown>) {
  requireVersion(campaign, input.expectedCampaignVersion, "campaign");
  const campaignVersion = await owned(store, auth, input.campaignVersionId, "campaign-version", "campaignVersionId");
  if (campaignVersion.data.campaignId !== campaign.id || campaign.data.currentCampaignVersionId !== campaignVersion.id || campaignVersion.data.contentHash !== input.contentHash || campaign.data.currentContentHash !== input.contentHash) throw new Error("The campaign version or content hash is stale.");
  return campaignVersion;
}

async function campaignReview(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  const campaign = await owned(store, auth, input.campaignId, "campaign", "campaignId");
  const nextVersion = requireVersion(campaign, input.expectedCampaignVersion, "campaign");
  const campaignVersion = await assertCurrentCampaignVersion(store, auth, campaign, input);
  if (campaign.state !== "draft") throw new Error("Only a draft campaign version can be reviewed.");
  const reviewPayload = { campaignId: campaign.id, campaignVersionId: campaignVersion.id, contentHash: input.contentHash, decision: input.decision, checklist: input.checklist, reason: String(input.reason).trim(), reviewedAt: now.toISOString(), reviewedByUserId: auth.userId };
  const reviewHash = digest(reviewPayload);
  const review = await create(store, auth, { moduleId, recordType: "campaign-review", title: `Review · ${campaign.title}`, state: "immutable", data: { ...reviewPayload, reviewHash, immutable: true, version: 1 } });
  const state = input.decision === "approved-for-approval" ? "reviewed" : "changes-requested";
  const updated = await update(store, auth, campaign, { state, data: { version: nextVersion, currentReviewId: review.id, currentReviewHash: reviewHash } });
  return result(action, [updated, review], { campaignId: campaign.id, campaignVersionId: campaignVersion.id, reviewId: review.id, reviewHash, decision: input.decision, state, automaticApproval: false });
}

async function campaignApprove(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EmailApproval) {
  const campaign = await owned(store, auth, input.campaignId, "campaign", "campaignId");
  const nextVersion = requireVersion(campaign, input.expectedCampaignVersion, "campaign");
  const campaignVersion = await assertCurrentCampaignVersion(store, auth, campaign, input);
  const review = await owned(store, auth, input.reviewId, "campaign-review", "reviewId");
  if (campaign.state !== "reviewed" || campaign.data.currentReviewId !== review.id || review.data.campaignVersionId !== campaignVersion.id || review.data.contentHash !== input.contentHash || review.data.decision !== "approved-for-approval") throw new Error("The exact campaign version has not passed the required human review.");
  const approvalBoundary = { campaignId: campaign.id, campaignVersionId: campaignVersion.id, contentHash: input.contentHash, reviewId: review.id, reviewHash: review.data.reviewHash };
  const approvalBoundaryHash = digest(approvalBoundary);
  if (!apply) return result(action, [], { dryRun: true, ...approvalBoundary, approvalBoundaryHash, plannedState: "approved", messageSent: false, providerCallStarted: false });
  const approvalRecord = await create(store, auth, { moduleId, recordType: "campaign-approval", title: `Approval · ${campaign.title}`, state: "immutable", data: { ...approvalBoundary, approvalBoundaryHash, approvedAt: now.toISOString(), approvedByUserId: approved!.approvedBy, approvalDecisionId: approved!.decisionId, approvalReason: approved!.reason, immutable: true, version: 1 } });
  const updated = await update(store, auth, campaign, { state: "approved", data: { version: nextVersion, currentApprovalId: approvalRecord.id, currentApprovalBoundaryHash: approvalBoundaryHash } });
  return result(action, [updated, approvalRecord], { ...approvalBoundary, approvalId: approvalRecord.id, approvalBoundaryHash, state: "approved", messageSent: false, providerCallStarted: false });
}

async function campaignSchedule(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EmailApproval) {
  const campaign = await owned(store, auth, input.campaignId, "campaign", "campaignId");
  const nextVersion = requireVersion(campaign, input.expectedCampaignVersion, "campaign");
  const campaignVersion = await assertCurrentCampaignVersion(store, auth, campaign, input);
  if (campaign.state !== "approved" || typeof campaign.data.currentApprovalId !== "string") throw new Error("Only the exact approved campaign version can be scheduled.");
  const scheduledAt = iso(input.scheduledAt, "scheduledAt");
  if (new Date(scheduledAt).getTime() <= now.getTime()) throw new Error("The schedule must be in the future.");
  const scheduleBoundary = { campaignId: campaign.id, campaignVersionId: campaignVersion.id, contentHash: input.contentHash, approvalId: campaign.data.currentApprovalId, scheduledAt };
  const scheduleHash = digest(scheduleBoundary);
  if (!apply) return result(action, [], { dryRun: true, ...scheduleBoundary, scheduleHash, plannedState: "scheduled", messageSent: false, providerCallStarted: false });
  const schedule = await create(store, auth, { moduleId, recordType: "campaign-schedule", title: `Schedule · ${campaign.title}`, state: "immutable", data: { ...scheduleBoundary, scheduleHash, scheduledByUserId: approved!.approvedBy, approvalDecisionId: approved!.decisionId, recordedAt: now.toISOString(), immutable: true, version: 1 } });
  const updated = await update(store, auth, campaign, { state: "scheduled", data: { version: nextVersion, currentScheduleId: schedule.id, currentScheduleHash: scheduleHash, scheduledAt } });
  return result(action, [updated, schedule], { ...scheduleBoundary, scheduleId: schedule.id, scheduleHash, state: "scheduled", messageSent: false, providerCallStarted: false });
}

async function eligibleRecipients(store: SuiteStore, auth: EmailAuthorization, audienceId: string) {
  const eligible: Array<{ subscriberId: string; emailHash: string; consentReceiptHash: string }> = [];
  const excluded: Array<{ subscriberId: string; reason: string }> = [];
  for (const subscriber of await list(store, auth, "subscriber")) {
    const audienceIds = Array.isArray(subscriber.data.audienceIds) ? subscriber.data.audienceIds.map(String) : [];
    if (!audienceIds.includes(audienceId)) continue;
    if (await effectivelySuppressed(store, auth, subscriber)) {
      excluded.push({ subscriberId: subscriber.id, reason: "suppressed" });
      continue;
    }
    if (typeof subscriber.data.emailHash !== "string" || typeof subscriber.data.currentConsentReceiptHash !== "string") {
      excluded.push({ subscriberId: subscriber.id, reason: "missing-consent-boundary" });
      continue;
    }
    eligible.push({ subscriberId: subscriber.id, emailHash: subscriber.data.emailHash, consentReceiptHash: subscriber.data.currentConsentReceiptHash });
  }
  eligible.sort((left, right) => left.emailHash.localeCompare(right.emailHash) || left.subscriberId.localeCompare(right.subscriberId));
  return { eligible, excluded };
}

async function dispatchPlanCreate(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EmailApproval) {
  const campaign = await owned(store, auth, input.campaignId, "campaign", "campaignId");
  const nextVersion = requireVersion(campaign, input.expectedCampaignVersion, "campaign");
  const campaignVersion = await assertCurrentCampaignVersion(store, auth, campaign, input);
  if (campaign.state !== "scheduled" || typeof campaign.data.currentScheduleId !== "string" || campaign.data.scheduledAt !== iso(input.scheduledAt, "scheduledAt")) throw new Error("The exact campaign schedule is stale or missing.");
  const recipients = await eligibleRecipients(store, auth, String(campaign.data.audienceId));
  if (!recipients.eligible.length) throw new Error("No consented, unsuppressed recipients are eligible for this dispatch plan.");
  const recipientManifestHash = digest({ schema: "letterline-recipient-manifest.v1", recipients: recipients.eligible });
  const boundary = {
    schema: "letterline-dispatch-plan.v1",
    campaignId: campaign.id,
    campaignVersionId: campaignVersion.id,
    contentHash: input.contentHash,
    audienceId: campaign.data.audienceId,
    scheduleId: campaign.data.currentScheduleId,
    scheduleHash: campaign.data.currentScheduleHash,
    scheduledAt: input.scheduledAt,
    providerAdapterId: input.providerAdapterId,
    recipientManifestHash,
    recipientIds: recipients.eligible.map((recipient) => recipient.subscriberId),
    recipientCount: recipients.eligible.length,
    excludedCount: recipients.excluded.length,
    suppressionCheckedAt: now.toISOString(),
  };
  const dispatchPlanHash = digest(boundary);
  if (!apply) return result(action, [], { dryRun: true, ...boundary, dispatchPlanHash, excluded: recipients.excluded, providerCallStarted: false, providerCredentialsStored: false, deliveryClaimed: false });
  const plan = await create(store, auth, { moduleId, recordType: "dispatch-plan", title: `Dispatch plan · ${campaign.title}`, state: "ready-for-provider-adapter", data: { ...boundary, dispatchPlanHash, recipientSnapshot: recipients.eligible, excluded: recipients.excluded, approvedByUserId: approved!.approvedBy, approvalDecisionId: approved!.decisionId, approvalReason: approved!.reason, createdAt: now.toISOString(), immutable: true, providerCallStarted: false, providerCredentialsStored: false, deliveryClaimed: false, version: 1 } });
  const updated = await update(store, auth, campaign, { state: "dispatch-planned", data: { version: nextVersion, currentDispatchPlanId: plan.id, currentDispatchPlanHash: dispatchPlanHash } });
  return result(action, [updated, plan], { dispatchPlanId: plan.id, ...boundary, dispatchPlanHash, excluded: recipients.excluded, providerCallStarted: false, providerCredentialsStored: false, deliveryClaimed: false });
}

async function providerReceiptIngest(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date) {
  const plan = await owned(store, auth, input.dispatchPlanId, "dispatch-plan", "dispatchPlanId");
  const subscriber = await owned(store, auth, input.subscriberId, "subscriber", "subscriberId");
  const recipientIds = Array.isArray(plan.data.recipientIds) ? plan.data.recipientIds.map(String) : [];
  if (!recipientIds.includes(subscriber.id)) throw new Error("The subscriber is not part of the immutable dispatch plan recipient manifest.");
  const occurredAt = notFuture(input.occurredAt, "occurredAt", now);
  const verification = object(input.gatewayVerification, "gatewayVerification");
  const verifiedAt = notFuture(verification.verifiedAt, "gatewayVerification.verifiedAt", now);
  if (new Date(verifiedAt).getTime() < new Date(occurredAt).getTime()) throw new Error("Gateway verification cannot precede the provider event.");
  const eventPayload = { schema: "letterline-provider-receipt.v1", dispatchPlanId: plan.id, dispatchPlanHash: plan.data.dispatchPlanHash, subscriberId: subscriber.id, emailHash: subscriber.data.emailHash, eventId: input.eventId, eventType: input.eventType, occurredAt, providerMessageRefHash: input.providerMessageRefHash, gatewayVerification: { ...verification, verifiedAt } };
  const eventHash = digest(eventPayload);
  const existing = (await list(store, auth, "provider-receipt")).find((record) => record.data.eventId === input.eventId);
  if (existing) {
    if (existing.data.eventHash !== eventHash) throw new Error("The provider event ID is already bound to different verified evidence.");
    return result(action, [existing], { providerReceiptId: existing.id, eventId: input.eventId, eventType: input.eventType, eventHash, duplicateProviderEvent: true, verifiedGatewayEvidence: true, platformDeliveryClaimed: false });
  }
  const suppressionReason: Record<string, string> = { "hard-bounce": "hard-bounce", complaint: "complaint", unsubscribe: "unsubscribe" };
  if (suppressionReason[String(input.eventType)] && new Date(occurredAt).getTime() < new Date(String(subscriber.data.consentCapturedAt ?? 0)).getTime()) throw new Error("A suppressive provider event cannot predate the subscriber's current consent receipt.");
  const receipt = await create(store, auth, { moduleId, recordType: "provider-receipt", title: `Provider receipt · ${input.eventId}`, state: "immutable", data: { ...eventPayload, eventHash, ingestedAt: now.toISOString(), immutable: true, providerCredentialsStored: false, version: 1 } });
  const records: SuiteRecord[] = [receipt];
  let suppressionId: string | undefined;
  if (suppressionReason[String(input.eventType)]) {
    const applied = await applySuppression(store, auth, { subscriber, reason: suppressionReason[String(input.eventType)], occurredAt, evidenceHash: String(verification.payloadHash), source: "verified-provider-receipt", sourceRecordId: receipt.id, now });
    records.push(applied.subscriber, applied.suppression);
    suppressionId = applied.suppression.id;
  }
  return result(action, records, { providerReceiptId: receipt.id, eventId: input.eventId, eventType: input.eventType, eventHash, duplicateProviderEvent: false, verifiedGatewayEvidence: true, suppressionId, immediatelyExcludedFromFutureDispatch: Boolean(suppressionId), platformDeliveryClaimed: false, providerCredentialsStored: false });
}

async function campaignAnalytics(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>) {
  const campaign = await owned(store, auth, input.campaignId, "campaign", "campaignId");
  const from = iso(input.from, "from");
  const to = iso(input.to, "to");
  if (from > to) throw new Error("Analytics start must not be after the end.");
  const planIds = new Set((await list(store, auth, "dispatch-plan")).filter((record) => record.data.campaignId === campaign.id).map((record) => record.id));
  const receipts = (await list(store, auth, "provider-receipt")).filter((record) => planIds.has(String(record.data.dispatchPlanId)) && String(record.data.occurredAt) >= from && String(record.data.occurredAt) <= to);
  const counts: Record<string, number> = { accepted: 0, delivered: 0, "soft-bounce": 0, "hard-bounce": 0, complaint: 0, unsubscribe: 0 };
  for (const receipt of receipts) if (String(receipt.data.eventType) in counts) counts[String(receipt.data.eventType)] += 1;
  const aggregate = { campaignId: campaign.id, from, to, verifiedProviderReceiptCount: receipts.length, uniqueSubscriberCount: new Set(receipts.map((record) => record.data.subscriberId)).size, counts, opens: null, clicks: null, revenue: null, attribution: null, evidenceBoundary: "gateway-verified-provider-receipts-only" };
  return result(action, [], { ...aggregate, aggregateHash: digest(aggregate), fabricatedMetrics: false }, "read");
}

async function audienceExport(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EmailApproval) {
  const audience = await owned(store, auth, input.audienceId, "audience", "audienceId");
  const rows: Array<Record<string, unknown>> = [];
  for (const subscriber of await list(store, auth, "subscriber")) {
    const audienceIds = Array.isArray(subscriber.data.audienceIds) ? subscriber.data.audienceIds.map(String) : [];
    if (!audienceIds.includes(audience.id)) continue;
    const suppressed = await effectivelySuppressed(store, auth, subscriber);
    if (suppressed && input.includeSuppressed !== true) continue;
    rows.push(canonical({ subscriberId: subscriber.id, normalizedEmail: subscriber.data.normalizedEmail, emailHash: subscriber.data.emailHash, displayName: subscriber.data.displayName, locale: subscriber.data.locale, suppressed, consentReceiptHash: subscriber.data.currentConsentReceiptHash }) as Record<string, unknown>);
  }
  rows.sort((left, right) => String(left.emailHash).localeCompare(String(right.emailHash)) || String(left.subscriberId).localeCompare(String(right.subscriberId)));
  const contentHash = digest({ schema: "letterline-audience-export.v1", audienceId: audience.id, format: input.format, includeSuppressed: input.includeSuppressed, rows });
  if (!apply) return result(action, [], { dryRun: true, audienceId: audience.id, format: input.format, includeSuppressed: input.includeSuppressed, rowCount: rows.length, contentHash, privateExport: true, providerCredentialsStored: false, providerCallStarted: false });
  const manifest = await create(store, auth, { moduleId, recordType: "audience-export", title: `Private export · ${audience.title}`, state: "immutable", data: { audienceId: audience.id, format: input.format, includeSuppressed: input.includeSuppressed, rowCount: rows.length, contentHash, exportedAt: now.toISOString(), exportedByUserId: approved!.approvedBy, approvalDecisionId: approved!.decisionId, private: true, immutable: true, rowsStored: false, providerCredentialsStored: false, version: 1 } });
  return { ...result(action, [manifest], { audienceId: audience.id, exportManifestId: manifest.id, format: input.format, includeSuppressed: input.includeSuppressed, rowCount: rows.length, contentHash, privateExport: true, rowsStoredInReceipt: false, providerCredentialsStored: false, providerCallStarted: false }), privateOutput: { audienceExport: { format: input.format as "canonical-json" | "csv", rows, contentHash } } };
}

async function queueAi(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, deps: EmailEngineDependencies) {
  const campaign = await owned(store, auth, input.campaignId, "campaign", "campaignId");
  const evidence: SuiteRecord[] = [];
  for (const recordId of input.evidenceIds as string[]) {
    const record = await store.getRecord(auth.userId, recordId);
    if (!record || !canRead(auth, record)) throw new Error("An AI evidence record was not found in this workspace.");
    if (!["email", "knowledge", "crm", "feedback"].includes(record.moduleId)) throw new Error("Email AI evidence must be an email, knowledge, CRM, or feedback record selected from this workspace.");
    evidence.push(record);
  }
  if (new Set(evidence.map((record) => record.id)).size !== evidence.length) throw new Error("AI evidence record IDs must be unique.");
  if (!action.promptId || action.promptVersion !== emailPromptPolicy.version) throw new Error("The email AI action is missing the approved platform prompt boundary.");
  const allowedProposalKinds = action.id === "subject-propose" ? ["subject"] : ["body"];
  const boundary = {
    actionId: action.id,
    promptId: action.promptId,
    promptVersion: action.promptVersion,
    platformPromptId: emailPromptPolicy.id,
    platformPromptVersion: emailPromptPolicy.version,
    platformPromptDigest: emailPromptDigest(),
    modelPolicyId: deps.modelPolicyId,
    targetRecordId: campaign.id,
    targetRecordHash: digest(campaign),
    evidenceIds: evidence.map((record) => record.id),
    evidenceHashes: evidence.map((record) => ({ recordId: record.id, snapshotHash: digest(record) })),
    allowedProposalKinds,
    resultContract: emailPromptPolicy.resultContract,
    forbiddenAutonomy: emailPromptPolicy.forbiddenAutonomy,
    reviewStatus: "pending-model",
    approvalRequired: true,
    automaticMutationAllowed: false,
    providerCallAllowed: false,
    output: null,
    confidence: null,
  };
  const requestedAt = deps.now().toISOString();
  const auditRecord = await create(store, auth, { moduleId, recordType: aiAuditType, title: action.title, state: "queued", data: { ...boundary, requestedAt, requestedByUserId: auth.userId, immutableRequest: true } });
  const aiAction = await store.queueAiAction(auth.userId, { moduleId, goal: String(input.instruction), context: { ...boundary, aiAuditRecordId: auditRecord.id } });
  if (!aiAction) throw new Error("The email AI proposal could not be queued.");
  return { kind: "ai-action", action, records: [auditRecord], aiAction, audit: { aiAuditRecordId: auditRecord.id, ...boundary, modelExecuted: false, externalEffectExecuted: false } } satisfies EmailExecutionResult;
}

export function validateEmailAiCompletion(value: unknown, boundary: { authorizedRecordIds: Iterable<string>; allowedProposalKinds: Iterable<string> }): EmailAiCompletion {
  const completion = object(value, "AI result");
  strictKeys(completion, ["version", "proposals", "confidence", "assumptions", "reviewStatus", "approvalRequired", "model"], "AI result");
  if (completion.version !== "letterline-ai-result.v1") throw new Error("The AI result contract version is invalid.");
  if (!Array.isArray(completion.proposals) || completion.proposals.length < 1 || completion.proposals.length > 100) throw new Error("AI result must include one to one hundred proposals.");
  const authorized = new Set(boundary.authorizedRecordIds);
  const allowedKinds = new Set(boundary.allowedProposalKinds);
  const proposalIds = new Set<string>();
  const proposals = completion.proposals.map((value, index) => {
    const proposal = object(value, `AI result.proposals[${index}]`);
    strictKeys(proposal, ["proposalId", "kind", "content", "citations", "rationale", "riskFlags"], `AI result.proposals[${index}]`);
    if (typeof proposal.proposalId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(proposal.proposalId) || proposalIds.has(proposal.proposalId)) throw new Error("Every AI proposal needs a unique bounded proposalId.");
    proposalIds.add(proposal.proposalId);
    if (typeof proposal.kind !== "string" || !allowedKinds.has(proposal.kind)) throw new Error("An AI proposal kind exceeds the authorized action boundary.");
    if (typeof proposal.content !== "string" || !proposal.content.trim() || proposal.content.length > (proposal.kind === "subject" ? 240 : 100_000)) throw new Error("Every AI proposal needs bounded non-empty content.");
    if (proposal.kind === "subject" && /[\r\n]/.test(proposal.content)) throw new Error("Subject proposals cannot contain line breaks.");
    if (proposal.kind === "body" && !proposal.content.includes("{{unsubscribe_url}}")) throw new Error("Body proposals must include the exact unsubscribe marker.");
    if (typeof proposal.rationale !== "string" || !proposal.rationale.trim() || proposal.rationale.length > 4_000) throw new Error("Every AI proposal needs a bounded rationale.");
    if (!Array.isArray(proposal.citations) || proposal.citations.length < 1 || proposal.citations.length > 100 || proposal.citations.some((citation) => typeof citation !== "string" || !authorized.has(citation))) throw new Error("Every AI proposal must cite only authorized records.");
    if (!Array.isArray(proposal.riskFlags) || proposal.riskFlags.length > 20 || proposal.riskFlags.some((flag) => typeof flag !== "string" || !flag.trim() || flag.length > 500)) throw new Error("AI proposal risk flags are malformed.");
    return { proposalId: proposal.proposalId, kind: proposal.kind as EmailAiProposal["kind"], content: proposal.content.trim(), citations: [...new Set(proposal.citations as string[])], rationale: proposal.rationale.trim(), riskFlags: proposal.riskFlags as string[] };
  });
  if (typeof completion.confidence !== "number" || !Number.isFinite(completion.confidence) || completion.confidence < 0 || completion.confidence > 1) throw new Error("AI confidence must be from zero to one.");
  if (!Array.isArray(completion.assumptions) || completion.assumptions.length > 50 || completion.assumptions.some((item) => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new Error("AI assumptions are malformed.");
  if (completion.reviewStatus !== "pending-human-review" || completion.approvalRequired !== true) throw new Error("AI output must remain pending human review and approval-required.");
  if (typeof completion.model !== "string" || !completion.model.trim() || completion.model.length > 200) throw new Error("The executed model identifier is required.");
  return { version: "letterline-ai-result.v1", proposals, confidence: completion.confidence, assumptions: completion.assumptions as string[], reviewStatus: "pending-human-review", approvalRequired: true, model: completion.model.trim() };
}

export async function recordEmailAiCompletion(store: SuiteStore, auth: EmailAuthorization, aiActionId: string, value?: unknown, completedAt = new Date()) {
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
    const aiAction = await store.getAiAction(auth.userId, aiActionId);
    if (!aiAction || aiAction.workspaceId !== auth.workspaceId || aiAction.moduleId !== moduleId || aiAction.status !== "completed") throw new Error("The completed email AI action was not found in this workspace.");
    const action = emailAction(moduleId, String(aiAction.context.actionId));
    if (!action || action.operation !== "ai" || action.promptId !== aiAction.context.promptId || action.promptVersion !== aiAction.context.promptVersion || aiAction.context.platformPromptId !== emailPromptPolicy.id || aiAction.context.platformPromptVersion !== emailPromptPolicy.version || aiAction.context.platformPromptDigest !== emailPromptDigest()) throw new Error("The completed AI action does not match the trusted email platform prompt boundary.");
    await authorize(store, auth, action);
    const evidenceIds = Array.isArray(aiAction.context.evidenceIds) ? aiAction.context.evidenceIds.filter((id): id is string => typeof id === "string") : [];
    const targetRecordId = typeof aiAction.context.targetRecordId === "string" ? aiAction.context.targetRecordId : "";
    const allowedProposalKinds = Array.isArray(aiAction.context.allowedProposalKinds) ? aiAction.context.allowedProposalKinds.filter((kind): kind is string => typeof kind === "string") : [];
    const completion = validateEmailAiCompletion(value ?? aiAction.result, { authorizedRecordIds: [targetRecordId, ...evidenceIds], allowedProposalKinds });
    const auditRecord = await owned(store, auth, aiAction.context.aiAuditRecordId, aiAuditType, "aiAuditRecordId");
    if (auditRecord.data.platformPromptDigest !== emailPromptDigest() || auditRecord.data.targetRecordId !== targetRecordId || auditRecord.data.reviewStatus !== "pending-model") {
      if (auditRecord.data.resultHash) {
        const replayHash = digest(completion);
        if (auditRecord.data.resultHash !== replayHash) throw new Error("The AI audit is already bound to a different completion.");
        return { auditRecord, completion, replayed: true };
      }
      throw new Error("The email AI audit boundary is stale or mismatched.");
    }
    const resultHash = digest(completion);
    const recorded = await update(store, auth, auditRecord, { state: "pending-human-review", data: { resultHash, executedModel: completion.model, confidence: completion.confidence, proposalCount: completion.proposals.length, proposalKinds: [...new Set(completion.proposals.map((proposal) => proposal.kind))], citedRecordIds: [...new Set(completion.proposals.flatMap((proposal) => proposal.citations))], assumptions: completion.assumptions, reviewStatus: "pending-human-review", approvalRequired: true, completedAt: completedAt.toISOString(), automaticMutationAllowed: false, providerCallAllowed: false, externalEffectExecuted: false } });
    return { auditRecord: recorded, completion, replayed: false };
  });
}

async function executeCommand(store: SuiteStore, auth: EmailAuthorization, action: EmailActionDefinition, input: Record<string, unknown>, deps: EmailEngineDependencies, apply: boolean, approved?: EmailApproval): Promise<EmailExecutionResult> {
  const now = deps.now();
  if (action.id === "audience-create") return audienceCreate(store, auth, action, input, now);
  if (action.id === "subscriber-opt-in-record") return subscriberOptIn(store, auth, action, input, now);
  if (action.id === "subscriber-reactivate") return subscriberReactivate(store, auth, action, input, now);
  if (action.id === "subscriber-suppress") return subscriberSuppress(store, auth, action, input, now);
  if (action.id === "subscriber-list") return subscriberList(store, auth, action, input);
  if (action.id === "campaign-create") return campaignCreate(store, auth, action, input, now);
  if (action.id === "campaign-version-draft") return campaignVersionDraft(store, auth, action, input, now);
  if (action.id === "campaign-review-record") return campaignReview(store, auth, action, input, now);
  if (action.id === "campaign-approve") return campaignApprove(store, auth, action, input, now, apply, approved);
  if (action.id === "campaign-schedule") return campaignSchedule(store, auth, action, input, now, apply, approved);
  if (action.id === "dispatch-plan-create") return dispatchPlanCreate(store, auth, action, input, now, apply, approved);
  if (action.id === "provider-receipt-ingest") return providerReceiptIngest(store, auth, action, input, now);
  if (action.id === "campaign-analytics-aggregate") return campaignAnalytics(store, auth, action, input);
  if (action.id === "audience-export") return audienceExport(store, auth, action, input, now, apply, approved);
  throw new Error(`Email action ${action.id} is not implemented.`);
}

export async function executeEmailAction(store: SuiteStore, auth: EmailAuthorization, requestedModuleId: string, actionId: string, input: Record<string, unknown>, dependencies: Partial<EmailEngineDependencies> = {}): Promise<EmailExecutionResult> {
  const action = emailAction(requestedModuleId, actionId);
  if (!action) throw new Error("The email action does not exist.");
  validate(input, action.inputSchema as unknown as Record<string, unknown>, "input");
  const deps: EmailEngineDependencies = { now: dependencies.now ?? defaults.now, modelPolicyId: dependencies.modelPolicyId ?? defaults.modelPolicyId };
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
    await authorize(store, auth, action);
    if (action.operation === "read") return executeCommand(store, auth, action, input, deps, false);
    const key = String(input.idempotencyKey);
    const requestHash = digest({ workspaceId: auth.workspaceId, actorUserId: auth.userId, moduleId, actionId: action.id, input });
    const prior = await replay(store, auth, action, key, requestHash);
    if (prior) return prior;
    if (action.operation === "ai") return saveReceipt(store, auth, action, key, requestHash, await queueAi(store, auth, action, input, deps));
    const dryRun = action.approvalRequired && input.dryRun === true;
    const approved = action.approvalRequired && !dryRun ? approval(input, auth, deps.now()) : undefined;
    if (approved) await assertApprovalDecisionUnused(store, auth, approved);
    const execution = await executeCommand(store, auth, action, input, deps, !dryRun, approved);
    execution.audit = { ...execution.audit, dryRun, effectBoundary: action.effectBoundary, messageSent: false, providerCallStarted: false, providerCredentialsStored: false, externalEffectExecuted: false, ...(approved ? { approvalDecisionId: approved.decisionId, approvedBy: approved.approvedBy, approvalReason: approved.reason, approvedAt: approved.approvedAt } : {}) };
    return saveReceipt(store, auth, action, key, requestHash, execution);
  });
}

export function emailIntegrationManifest() {
  return {
    moduleId,
    productName: "Letterline",
    engine: "email",
    minimumPlan: "starter",
    actions: emailActions.map((action) => action.id),
    receiptRecordType: receiptType,
    aiAuditRecordType: aiAuditType,
    platformPromptId: emailPromptPolicy.id,
    platformPromptVersion: emailPromptPolicy.version,
    platformPromptDigest: emailPromptDigest(),
    providerCallsAllowed: false,
    sqlRequirements: {
      uniqueCommandReceipt: ["workspace_id", "module_id", "actionId", "idempotencyKey"],
      uniqueSubscriberEmailHash: ["workspace_id", "module_id", "emailHash"],
      uniqueProviderEventId: ["workspace_id", "module_id", "eventId"],
      rowLevelSecurity: true,
      atomicAiCompletion: true,
    },
  } as const;
}
