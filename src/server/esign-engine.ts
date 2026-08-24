import { createHash, randomBytes } from "node:crypto";
import type { SuiteAiAction, SuiteRecord, SuiteWorkspaceRole } from "../shared/suite.js";
import { esignAction, esignActions, type EsignActionDefinition } from "../shared/esign-actions.js";
import type { SuiteStore } from "./suite-store.js";
import { esignPromptDigest, esignPromptPolicy } from "./prompts/esign.js";
import { suiteStorageAccounting } from "../shared/suite-quotas.js";

export interface EsignAuthorization {
  userId: string;
  workspaceId: string;
  role: SuiteWorkspaceRole;
  scopes: string[];
}

export interface EsignApproval {
  approved: true;
  approvedBy: string;
  approvedAt: string;
  decisionId: string;
  reason: string;
}

export interface EsignEngineDependencies {
  now: () => Date;
  randomBytes: (size: number) => Buffer;
  modelPolicyId: string;
}

export interface EsignExecutionResult {
  kind: "read" | "command" | "ai-action";
  action: EsignActionDefinition;
  records: SuiteRecord[];
  audit: Record<string, unknown>;
  aiAction?: SuiteAiAction;
  privateOutput?: { signerSessionToken: string; sessionId: string; expiresAt: string };
}

export interface EsignAiProposal {
  proposalId: string;
  kind: "clause" | "field" | "routing";
  text: string;
  citations: string[];
  rationale: string;
  riskFlags: string[];
}

export interface EsignAiCompletion {
  proposals: EsignAiProposal[];
  confidence: number;
  assumptions: string[];
  reviewStatus: "pending-human-review";
  approvalRequired: true;
  model: string;
}

const defaults: EsignEngineDependencies = {
  now: () => new Date(),
  randomBytes,
  modelPolicyId: "workspace-configured-model",
};
const moduleId = "esign";
const receiptType = "esign-command-receipt";
const auditType = "esign-ai-request-audit";
const maxRecords = 100_000;

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

function hashText(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function iso(value: unknown, label: string) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid ISO date-time.`);
  return date.toISOString();
}

function version(record: SuiteRecord) {
  const value = Number(record.data.version ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function requireVersion(record: SuiteRecord, supplied: unknown, label = "record") {
  if (!Number.isSafeInteger(supplied) || Number(supplied) !== version(record)) throw new Error(`The ${label} version is stale.`);
  return version(record) + 1;
}

function output(action: EsignActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>, kind: EsignExecutionResult["kind"] = "command"): EsignExecutionResult {
  return { kind, action, records, audit };
}

async function create(store: SuiteStore, auth: EsignAuthorization, input: Parameters<SuiteStore["createRecord"]>[1]) {
  const record = await store.createRecord(auth.userId, input);
  if (!record) throw new Error("The e-signature workspace record could not be persisted.");
  return record;
}

async function update(store: SuiteStore, auth: EsignAuthorization, record: SuiteRecord, input: Parameters<SuiteStore["updateRecord"]>[2]) {
  const updated = await store.updateRecord(auth.userId, record.id, input);
  if (!updated) throw new Error("The e-signature workspace record could not be updated.");
  return updated;
}

async function owned(store: SuiteStore, auth: EsignAuthorization, id: unknown, recordType?: string, label = "recordId") {
  if (typeof id !== "string") throw new Error(`${label} must be a record ID.`);
  const record = await store.getRecord(auth.userId, id);
  if (!record || record.moduleId !== moduleId || (recordType && record.recordType !== recordType)) throw new Error(`${label.replace(/Id$/, "")} not found in this workspace.`);
  return record;
}

async function list(store: SuiteStore, auth: EsignAuthorization, recordType?: string) {
  return store.listRecords(auth.userId, { moduleId, recordType, limit: maxRecords });
}

async function authorize(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition) {
  const workspace = await store.getOrCreateWorkspace(auth.userId);
  if (workspace.id !== auth.workspaceId) throw new Error("The authorization workspace does not match the storage tenant.");
  if (workspace.currentRole !== auth.role) throw new Error("The supplied role does not match the workspace membership.");
  if (!["starter", "scale", "fleet"].includes(workspace.plan)) throw new Error("The e-signature module requires a paid plan.");
  if (!workspace.enabledModuleIds.includes(moduleId)) throw new Error("Enable the e-signature module before using it.");
  if (!auth.scopes.includes("*") && !auth.scopes.includes(`esign:${action.requiredScope}`)) throw new Error(`The esign:${action.requiredScope} scope is required.`);
  if (auth.role === "viewer" && action.operation !== "read") throw new Error("Viewers cannot mutate e-signature records or queue AI work.");
  if (action.approvalRequired && !["owner", "admin"].includes(auth.role)) throw new Error("Only an owner or administrator may approve this high-risk e-signature action.");
}

function approval(input: Record<string, unknown>, auth: EsignAuthorization, now: Date): EsignApproval {
  const candidate = input.approval as EsignApproval | undefined;
  if (!candidate || candidate.approved !== true || candidate.approvedBy !== auth.userId || !candidate.reason?.trim() || !/^[A-Za-z0-9._:-]{16,200}$/.test(candidate.decisionId ?? "")) throw new Error("An attributable, reasoned, uniquely identified human approval is required when dryRun is false.");
  const approvedAt = new Date(candidate.approvedAt);
  if (!Number.isFinite(approvedAt.getTime()) || approvedAt.getTime() > now.getTime() + 5 * 60_000) throw new Error("The approval clock is invalid or in the future.");
  return { ...candidate, approvedAt: approvedAt.toISOString(), reason: candidate.reason.trim() };
}

function requestInputForDigest(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => key === "sessionToken" && typeof value === "string" ? [key, { sha256: hashText(value) }] : [key, value]));
}

async function replay(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, key: string, requestHash: string) {
  const receipt = (await list(store, auth, receiptType)).find((record) => record.data.idempotencyKey === key);
  if (!receipt) return undefined;
  if (receipt.data.actionId !== action.id || receipt.data.requestHash !== requestHash) throw new Error("The idempotency key was already used for a different e-signature command.");
  const records: SuiteRecord[] = [];
  for (const id of Array.isArray(receipt.data.resultRecordIds) ? receipt.data.resultRecordIds : []) {
    const record = await store.getRecord(auth.userId, String(id));
    if (record) records.push(record);
  }
  const aiAction = typeof receipt.data.aiActionId === "string" ? await store.getAiAction(auth.userId, receipt.data.aiActionId) : undefined;
  const audit = { ...(receipt.data.audit as Record<string, unknown>), receiptId: receipt.id, requestHash, replayed: true, ...(action.id === "signer-session-issue" ? { privateOutputUnavailableOnReplay: true } : {}) };
  return { kind: aiAction ? "ai-action" : "command", action, records, audit, ...(aiAction ? { aiAction } : {}) } satisfies EsignExecutionResult;
}

async function saveReceipt(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, key: string, requestHash: string, execution: EsignExecutionResult) {
  const receipt = await create(store, auth, { moduleId, recordType: receiptType, title: `${action.id} · ${key.slice(0, 48)}`, state: "recorded", data: { actionId: action.id, idempotencyKey: key, requestHash, resultRecordIds: execution.records.map((record) => record.id), aiActionId: execution.aiAction?.id, audit: execution.audit, actorUserId: auth.userId, workspaceId: auth.workspaceId, immutable: true, containsPlaintextSessionToken: false } });
  execution.audit = { ...execution.audit, receiptId: receipt.id, requestHash, replayed: false };
  return execution;
}

function signerRoutes(envelope: SuiteRecord) {
  if (!Array.isArray(envelope.data.signers)) throw new Error("The envelope signer snapshot is malformed.");
  return envelope.data.signers.map((item, index) => object(item, `envelope.signers[${index}]`));
}

function envelopeFields(envelope: SuiteRecord) {
  if (!Array.isArray(envelope.data.fields)) throw new Error("The envelope field snapshot is malformed.");
  return envelope.data.fields.map((item, index) => object(item, `envelope.fields[${index}]`));
}

function dispatchBoundary(envelope: SuiteRecord) {
  return {
    envelopeId: envelope.id,
    envelopeVersion: version(envelope),
    envelopeDraftHash: envelope.data.envelopeDraftHash,
    templateContentHash: envelope.data.templateContentHash,
    documentHash: envelope.data.documentHash,
    expiresAt: envelope.data.expiresAt,
    signers: signerRoutes(envelope),
    fields: envelopeFields(envelope),
    effectBoundary: "dispatch-plan-only",
    providerCallPlannedByPlatform: false,
  };
}

function validateRoleAndFieldSnapshots(roles: Array<Record<string, unknown>>, fields: Array<Record<string, unknown>>) {
  const roleNames = roles.map((role) => String(role.role));
  const roleOrders = roles.map((role) => Number(role.order));
  if (new Set(roleNames).size !== roles.length || new Set(roleOrders).size !== roles.length) throw new Error("Signer template roles and route orders must be unique.");
  const sortedOrders = [...roleOrders].sort((a, b) => a - b);
  if (sortedOrders.some((order, index) => order !== index + 1)) throw new Error("Signer template route order must be contiguous from one.");
  const fieldIds = fields.map((field) => String(field.fieldId));
  if (new Set(fieldIds).size !== fields.length) throw new Error("Template field IDs must be unique.");
  for (const field of fields) {
    if (!roleNames.includes(String(field.signerRole))) throw new Error("Every template field must name one declared signer role.");
    if (Number(field.xBasisPoints) + Number(field.widthBasisPoints) > 10_000 || Number(field.yBasisPoints) + Number(field.heightBasisPoints) > 10_000) throw new Error("Template field geometry must remain inside the normalized page boundary.");
  }
}

function sessionToken(size: number, deps: EsignEngineDependencies) {
  return `esig_${deps.randomBytes(size).toString("base64url")}`;
}

function assertEnvelopeActive(envelope: SuiteRecord) {
  if (!["ready-for-manual-dispatch", "in-progress"].includes(envelope.state)) throw new Error("The envelope is not active for signer workflow actions.");
}

async function sessionForToken(store: SuiteStore, auth: EsignAuthorization, envelopeId: string, signerId: string, token: string, now: Date) {
  const tokenHash = hashText(token);
  const session = (await list(store, auth, "signer-session")).find((record) => record.data.tokenHash === tokenHash);
  if (!session || session.data.envelopeId !== envelopeId || session.data.signerId !== signerId) throw new Error("The signer session token is invalid for this envelope and signer.");
  if (session.state !== "active" || new Date(String(session.data.expiresAt)).getTime() <= now.getTime()) throw new Error("The signer session is not active.");
  return session;
}

function compatibleMethod(fieldKind: unknown, method: unknown) {
  const allowed: Record<string, string[]> = {
    signature: ["typed-name", "drawn-mark"],
    initials: ["typed-name", "drawn-mark"],
    text: ["typed-text"],
    checkbox: ["selected-checkbox"],
    date: ["entered-date"],
  };
  return allowed[String(fieldKind)]?.includes(String(method)) ?? false;
}

async function templateCreate(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date) {
  const template = await create(store, auth, { moduleId, recordType: "template", title: String(input.name), state: "active", data: { purpose: input.purpose, currentTemplateVersion: 0, currentTemplateVersionId: null, version: 1, createdAt: now.toISOString() } });
  return output(action, [template], { templateId: template.id, currentTemplateVersion: 0, externalEffectExecuted: false });
}

async function templateVersionCreate(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date) {
  const template = await owned(store, auth, input.templateId, "template", "templateId");
  if (template.state !== "active") throw new Error("Only an active template can receive a version.");
  const current = Number(template.data.currentTemplateVersion ?? 0);
  if (!Number.isSafeInteger(input.expectedTemplateVersion) || input.expectedTemplateVersion !== current) throw new Error("The template version is stale.");
  const roles = (input.signerRoles as unknown[]).map((item, index) => object(item, `signerRoles[${index}]`));
  const fields = (input.fields as unknown[]).map((item, index) => object(item, `fields[${index}]`));
  validateRoleAndFieldSnapshots(roles, fields);
  const versionNumber = current + 1;
  const snapshot = { templateId: template.id, templateVersion: versionNumber, signerRoles: roles, fields, disclosure: input.disclosure, instructions: input.instructions ?? "" };
  const contentHash = digest(snapshot);
  const prior = (await list(store, auth, "template-version")).find((record) => record.data.templateId === template.id && record.data.contentHash === contentHash);
  if (prior) throw new Error("This exact immutable template version already exists.");
  const versionRecord = await create(store, auth, { moduleId, recordType: "template-version", title: `${template.title} · v${versionNumber}`, state: "immutable", data: { ...snapshot, contentHash, immutable: true, createdAt: now.toISOString() } });
  const updated = await update(store, auth, template, { data: { currentTemplateVersion: versionNumber, currentTemplateVersionId: versionRecord.id, version: version(template) + 1, updatedAt: now.toISOString() } });
  return output(action, [updated, versionRecord], { templateId: template.id, templateVersionId: versionRecord.id, templateVersion: versionNumber, contentHash, externalEffectExecuted: false });
}

async function documentRegister(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date) {
  const objectRef = String(input.objectRef);
  if (objectRef.startsWith("/") || objectRef.includes("\\") || objectRef.split("/").some((segment) => segment === "..") || objectRef.includes("://")) throw new Error("objectRef must be an opaque relative object-store reference without traversal or a URL.");
  const duplicate = (await list(store, auth, "document")).find((record) => record.data.objectRef === objectRef && record.data.objectVersion === input.objectVersion);
  if (duplicate) throw new Error("This exact object reference and object version are already registered.");
  const snapshot = { objectRef, objectVersion: input.objectVersion, sha256: input.sha256, sizeBytes: input.sizeBytes, contentType: input.contentType, pageCount: input.pageCount };
  const document = await create(store, auth, { moduleId, recordType: "document", title: String(input.title), state: "immutable", data: { ...snapshot, registrationHash: digest(snapshot), immutable: true, objectFetchedByPlatform: false, storageAccounting: suiteStorageAccounting(Number(input.sizeBytes)), version: 1, registeredAt: now.toISOString() } });
  return output(action, [document], { documentId: document.id, sha256: document.data.sha256, registrationHash: document.data.registrationHash, exactObjectVersionRequired: true, objectFetchedByPlatform: false, storageBytesRegistered: input.sizeBytes, objectStoreSizeVerified: false, externalEffectExecuted: false });
}

async function envelopeDraft(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date) {
  const templateVersion = await owned(store, auth, input.templateVersionId, "template-version", "templateVersionId");
  const document = await owned(store, auth, input.documentId, "document", "documentId");
  if (templateVersion.state !== "immutable" || document.state !== "immutable") throw new Error("Envelope drafts require immutable template and document records.");
  if (document.data.sha256 !== input.documentHash) throw new Error("The document hash does not match the exact registered object version.");
  const roles = (templateVersion.data.signerRoles as unknown[]).map((item, index) => object(item, `template.signerRoles[${index}]`));
  const fields = (templateVersion.data.fields as unknown[]).map((item, index) => object(item, `template.fields[${index}]`));
  if (fields.some((field) => Number(field.page) > Number(document.data.pageCount))) throw new Error("Every envelope field page must exist in the registered document.");
  const signers = (input.signers as unknown[]).map((item, index) => object(item, `signers[${index}]`));
  const roleNames = roles.map((role) => String(role.role)).sort();
  const signerRoleNames = signers.map((signer) => String(signer.role)).sort();
  if (new Set(signers.map((signer) => signer.signerId)).size !== signers.length || new Set(signers.map((signer) => signer.signerKeyHash)).size !== signers.length) throw new Error("Envelope signer IDs and privacy-preserving signer keys must be unique.");
  if (JSON.stringify(roleNames) !== JSON.stringify(signerRoleNames)) throw new Error("Envelope signers must cover every template role exactly once.");
  for (const signer of signers) {
    const role = roles.find((candidate) => candidate.role === signer.role);
    if (!role || role.order !== signer.order) throw new Error("Envelope signer order must match the immutable template role order.");
  }
  const expiresAt = iso(input.expiresAt, "expiresAt");
  if (new Date(expiresAt).getTime() <= now.getTime()) throw new Error("Envelope expiry must be in the future.");
  const snapshot = { templateVersionId: templateVersion.id, templateContentHash: templateVersion.data.contentHash, documentId: document.id, documentHash: document.data.sha256, documentObjectVersion: document.data.objectVersion, signers, fields, disclosure: templateVersion.data.disclosure, expiresAt, message: input.message ?? "" };
  const envelopeDraftHash = digest(snapshot);
  const envelope = await create(store, auth, { moduleId, recordType: "envelope", title: String(input.title), state: "draft", data: { ...snapshot, envelopeDraftHash, completedSignerIds: [], version: 1, deliveryClaimed: false, identityAssuranceClaimed: false, legalComplianceCertified: false, createdAt: now.toISOString() } });
  return output(action, [envelope], { envelopeId: envelope.id, envelopeDraftHash, documentHash: document.data.sha256, templateContentHash: templateVersion.data.contentHash, signerCount: signers.length, providerCallStarted: false, externalEffectExecuted: false });
}

async function envelopePreview(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  requireVersion(envelope, input.expectedVersion, "envelope");
  if (envelope.state !== "draft") throw new Error("Only a draft envelope can be previewed for initial dispatch.");
  const boundary = dispatchBoundary(envelope);
  return output(action, [envelope], { ...boundary, previewHash: digest(boundary), providerCallStarted: false, messageSent: false, externalEffectExecuted: false }, "read");
}

async function envelopeDispatchPlan(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EsignApproval) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  const nextVersion = requireVersion(envelope, input.expectedVersion, "envelope");
  if (envelope.state !== "draft") throw new Error("Only a draft envelope can receive an initial dispatch plan.");
  if (new Date(String(envelope.data.expiresAt)).getTime() <= now.getTime()) throw new Error("The envelope has expired.");
  const boundary = dispatchBoundary(envelope);
  const previewHash = digest(boundary);
  if (input.previewHash !== previewHash) throw new Error("The dispatch preview hash is stale or does not match the exact envelope boundary.");
  if (!apply) return output(action, [], { dryRun: true, ...boundary, previewHash, plannedState: "ready-for-manual-dispatch", channel: input.channel, providerCallStarted: false, messageSent: false, externalEffectExecuted: false });
  const planSnapshot = { ...boundary, previewHash, channel: input.channel, approvalDecisionId: approved!.decisionId, approvedBy: approved!.approvedBy, approvedAt: approved!.approvedAt };
  const plan = await create(store, auth, { moduleId, recordType: "dispatch-plan", title: `Dispatch plan · ${envelope.title}`, state: "approved", data: { ...planSnapshot, contentHash: digest(planSnapshot), immutable: true, messageSent: false, providerCallStarted: false, createdAt: now.toISOString() } });
  const updated = await update(store, auth, envelope, { state: "ready-for-manual-dispatch", data: { dispatchPlanId: plan.id, dispatchPlanHash: plan.data.contentHash, dispatchChannel: input.channel, version: nextVersion, readyAt: now.toISOString(), deliveryClaimed: false } });
  return output(action, [updated, plan], { envelopeId: envelope.id, dispatchPlanId: plan.id, dispatchPlanHash: plan.data.contentHash, channel: input.channel, messageSent: false, providerCallStarted: false, externalEffectExecuted: false });
}

async function signerSessionIssue(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date, deps: EsignEngineDependencies, apply: boolean, approved?: EsignApproval) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  assertEnvelopeActive(envelope);
  const nextVersion = requireVersion(envelope, input.expectedEnvelopeVersion, "envelope");
  const signer = signerRoutes(envelope).find((candidate) => candidate.signerId === input.signerId);
  if (!signer) throw new Error("The signer is not part of the immutable envelope route.");
  const completed = new Set(Array.isArray(envelope.data.completedSignerIds) ? envelope.data.completedSignerIds.map(String) : []);
  if (completed.has(String(signer.signerId))) throw new Error("The signer already completed this envelope.");
  if (signerRoutes(envelope).some((candidate) => Number(candidate.order) < Number(signer.order) && !completed.has(String(candidate.signerId)))) throw new Error("Earlier signer routes must complete before this signer session is issued.");
  const expiresAt = iso(input.expiresAt, "expiresAt");
  if (new Date(expiresAt).getTime() <= now.getTime() || new Date(expiresAt).getTime() > new Date(String(envelope.data.expiresAt)).getTime()) throw new Error("Signer session expiry must be in the future and no later than the envelope expiry.");
  const signerSessions = (await list(store, auth, "signer-session")).filter((record) => record.data.envelopeId === envelope.id && record.data.signerId === signer.signerId && record.state === "active");
  const active = signerSessions.find((record) => new Date(String(record.data.expiresAt)).getTime() > now.getTime());
  if (active) throw new Error("An active signer session already exists for this route.");
  const expiredSessions = signerSessions.filter((record) => new Date(String(record.data.expiresAt)).getTime() <= now.getTime());
  if (!apply) return output(action, [], { dryRun: true, envelopeId: envelope.id, signerId: signer.signerId, expiresAt, expiredSessionIdsToClose: expiredSessions.map((record) => record.id), tokenWillBeReturnedOnce: true, plaintextTokenWillBePersisted: false, externalEffectExecuted: false });
  const retired: SuiteRecord[] = [];
  for (const expired of expiredSessions) retired.push(await update(store, auth, expired, { state: "expired", data: { expiredAt: now.toISOString(), version: version(expired) + 1 } }));
  const token = sessionToken(32, deps);
  const tokenHash = hashText(token);
  const session = await create(store, auth, { moduleId, recordType: "signer-session", title: `Signer session · ${String(signer.role)}`, state: "active", data: { envelopeId: envelope.id, signerId: signer.signerId, signerKeyHash: signer.signerKeyHash, role: signer.role, routeOrder: signer.order, tokenHash, expiresAt, issuedAt: now.toISOString(), issuedByUserId: auth.userId, approvalDecisionId: approved!.decisionId, version: 1, plaintextTokenPersisted: false, identityAssurance: "not-assessed" } });
  const updated = await update(store, auth, envelope, { state: "in-progress", data: { version: nextVersion, lastSessionIssuedAt: now.toISOString() } });
  return { ...output(action, [updated, ...retired, session], { envelopeId: envelope.id, sessionId: session.id, signerId: signer.signerId, tokenHash, expiresAt, expiredSessionIdsClosed: retired.map((record) => record.id), plaintextTokenPersisted: false, tokenReturnedOnce: true, identityAssuranceClaimed: false, externalEffectExecuted: false }), privateOutput: { signerSessionToken: token, sessionId: session.id, expiresAt } };
}

async function fieldCompletionRecord(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EsignApproval) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  assertEnvelopeActive(envelope);
  const nextEnvelopeVersion = requireVersion(envelope, input.expectedEnvelopeVersion, "envelope");
  const signer = signerRoutes(envelope).find((candidate) => candidate.signerId === input.signerId);
  if (!signer) throw new Error("The signer is not part of the immutable envelope route.");
  const session = await sessionForToken(store, auth, envelope.id, String(input.signerId), String(input.sessionToken), now);
  const nextSessionVersion = requireVersion(session, input.expectedSessionVersion, "signer session");
  const assignedFields = envelopeFields(envelope).filter((field) => field.signerRole === signer.role);
  const requiredFieldIds = new Set(assignedFields.filter((field) => field.required === true).map((field) => String(field.fieldId)));
  const facts = (input.fieldFacts as unknown[]).map((item, index) => object(item, `fieldFacts[${index}]`));
  const factIds = facts.map((fact) => String(fact.fieldId));
  if (new Set(factIds).size !== facts.length) throw new Error("Each field can be completed at most once in this command.");
  if ([...requiredFieldIds].some((fieldId) => !factIds.includes(fieldId))) throw new Error("Every required field for this signer role must have a completion fact.");
  for (const fact of facts) {
    const field = assignedFields.find((candidate) => candidate.fieldId === fact.fieldId);
    if (!field) throw new Error("A completion fact references a field outside this signer role.");
    if (!compatibleMethod(field.kind, fact.method)) throw new Error("A completion method is incompatible with its immutable field kind.");
    const completedAt = new Date(String(fact.completedAt));
    if (completedAt.getTime() < new Date(String(session.data.issuedAt)).getTime() || completedAt.getTime() > now.getTime() + 5 * 60_000) throw new Error("Field completion clocks must occur during the signer session and not in the future.");
  }
  const existingFacts = (await list(store, auth, "field-completion")).filter((record) => record.data.envelopeId === envelope.id);
  if (facts.some((fact) => existingFacts.some((record) => record.data.fieldId === fact.fieldId))) throw new Error("An immutable completion fact already exists for one of these envelope fields.");
  const currentCompleted = new Set(Array.isArray(envelope.data.completedSignerIds) ? envelope.data.completedSignerIds.map(String) : []);
  currentCompleted.add(String(signer.signerId));
  const allCompleted = signerRoutes(envelope).every((candidate) => currentCompleted.has(String(candidate.signerId)));
  if (!apply) return output(action, [], { dryRun: true, envelopeId: envelope.id, signerId: signer.signerId, fieldIds: factIds, plannedSignerState: "completed", plannedEnvelopeState: allCompleted ? "completed" : "in-progress", rawFieldValuesPersisted: false, identityAssuranceClaimed: false, signatureComplianceClaimed: false, externalEffectExecuted: false });
  const records: SuiteRecord[] = [];
  for (const fact of facts) {
    const field = assignedFields.find((candidate) => candidate.fieldId === fact.fieldId)!;
    records.push(await create(store, auth, { moduleId, recordType: "field-completion", title: `${String(field.kind)} · ${String(field.fieldId)}`, state: "recorded", data: { envelopeId: envelope.id, sessionId: session.id, signerId: signer.signerId, signerKeyHash: signer.signerKeyHash, fieldId: field.fieldId, fieldKind: field.kind, valueHash: fact.valueHash, completedAt: iso(fact.completedAt, "fieldFact.completedAt"), method: fact.method, documentHash: envelope.data.documentHash, envelopeDraftHash: envelope.data.envelopeDraftHash, recordedAt: now.toISOString(), recordedByUserId: auth.userId, approvalDecisionId: approved!.decisionId, rawValuePersisted: false, identityAssurance: "not-assessed", immutable: true, version: 1 } }));
  }
  records.push(await update(store, auth, session, { state: "completed", data: { completedAt: now.toISOString(), completionFieldIds: factIds, approvalDecisionId: approved!.decisionId, version: nextSessionVersion } }));
  records.push(await update(store, auth, envelope, { state: allCompleted ? "completed" : "in-progress", data: { completedSignerIds: [...currentCompleted].sort(), ...(allCompleted ? { completedAt: now.toISOString() } : {}), version: nextEnvelopeVersion } }));
  return output(action, records, { envelopeId: envelope.id, sessionId: session.id, signerId: signer.signerId, fieldIds: factIds, envelopeState: allCompleted ? "completed" : "in-progress", rawFieldValuesPersisted: false, plaintextSessionTokenPersisted: false, identityAssuranceClaimed: false, signatureComplianceClaimed: false, externalEffectExecuted: false });
}

async function declineRecord(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EsignApproval) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  assertEnvelopeActive(envelope);
  const nextEnvelopeVersion = requireVersion(envelope, input.expectedEnvelopeVersion, "envelope");
  const signer = signerRoutes(envelope).find((candidate) => candidate.signerId === input.signerId);
  if (!signer) throw new Error("The signer is not part of the immutable envelope route.");
  const session = await sessionForToken(store, auth, envelope.id, String(input.signerId), String(input.sessionToken), now);
  const nextSessionVersion = requireVersion(session, input.expectedSessionVersion, "signer session");
  if (!apply) return output(action, [], { dryRun: true, envelopeId: envelope.id, signerId: signer.signerId, plannedState: "declined", plaintextSessionTokenPersisted: false, signatureClaimed: false, externalEffectExecuted: false });
  const reasonHash = digest({ envelopeId: envelope.id, signerId: signer.signerId, reason: input.reason });
  const event = await create(store, auth, { moduleId, recordType: "decline-event", title: `Decline · ${String(signer.role)}`, state: "recorded", data: { envelopeId: envelope.id, sessionId: session.id, signerId: signer.signerId, signerKeyHash: signer.signerKeyHash, reason: input.reason, reasonHash, declinedAt: now.toISOString(), approvalDecisionId: approved!.decisionId, recordedByUserId: auth.userId, signatureOccurred: false, immutable: true, version: 1 } });
  const declinedSession = await update(store, auth, session, { state: "declined", data: { declinedAt: now.toISOString(), declineEventId: event.id, approvalDecisionId: approved!.decisionId, version: nextSessionVersion } });
  const declinedEnvelope = await update(store, auth, envelope, { state: "declined", data: { declinedAt: now.toISOString(), declinedBySignerId: signer.signerId, declineEventId: event.id, version: nextEnvelopeVersion } });
  return output(action, [declinedEnvelope, declinedSession, event], { envelopeId: envelope.id, signerId: signer.signerId, declineEventId: event.id, reasonHash, plaintextSessionTokenPersisted: false, signatureClaimed: false, externalEffectExecuted: false });
}

async function envelopeVoid(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EsignApproval) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  const nextVersion = requireVersion(envelope, input.expectedVersion, "envelope");
  if (["completed", "declined", "voided"].includes(envelope.state)) throw new Error("A terminal envelope cannot be voided.");
  const openSessions = (await list(store, auth, "signer-session")).filter((record) => record.data.envelopeId === envelope.id && record.state === "active");
  if (!apply) return output(action, [], { dryRun: true, envelopeId: envelope.id, plannedState: "voided", openSessionsToRevoke: openSessions.map((record) => record.id), historyWillBeRetained: true, externalEffectExecuted: false });
  const reasonHash = digest({ envelopeId: envelope.id, reason: input.reason });
  const event = await create(store, auth, { moduleId, recordType: "void-event", title: `Void · ${envelope.title}`, state: "recorded", data: { envelopeId: envelope.id, reason: input.reason, reasonHash, voidedAt: now.toISOString(), voidedByUserId: auth.userId, approvalDecisionId: approved!.decisionId, immutable: true, version: 1 } });
  const records: SuiteRecord[] = [event];
  for (const session of openSessions) records.push(await update(store, auth, session, { state: "revoked", data: { revokedAt: now.toISOString(), revokedByEventId: event.id, version: version(session) + 1 } }));
  records.unshift(await update(store, auth, envelope, { state: "voided", data: { voidedAt: now.toISOString(), voidEventId: event.id, version: nextVersion } }));
  return output(action, records, { envelopeId: envelope.id, voidEventId: event.id, reasonHash, revokedSessionIds: openSessions.map((record) => record.id), historyRetained: true, externalEffectExecuted: false });
}

async function reminderPlan(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EsignApproval) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  assertEnvelopeActive(envelope);
  requireVersion(envelope, input.expectedEnvelopeVersion, "envelope");
  const signer = signerRoutes(envelope).find((candidate) => candidate.signerId === input.signerId);
  if (!signer) throw new Error("The signer is not part of the immutable envelope route.");
  if (Array.isArray(envelope.data.completedSignerIds) && envelope.data.completedSignerIds.includes(signer.signerId)) throw new Error("A completed signer cannot receive a reminder plan.");
  const notBefore = iso(input.notBefore, "notBefore");
  if (new Date(notBefore).getTime() < now.getTime() || new Date(notBefore).getTime() >= new Date(String(envelope.data.expiresAt)).getTime()) throw new Error("Reminder timing must be in the future and before envelope expiry.");
  const snapshot = { envelopeId: envelope.id, envelopeVersion: version(envelope), envelopeDraftHash: envelope.data.envelopeDraftHash, signerId: signer.signerId, signerKeyHash: signer.signerKeyHash, channel: input.channel, notBefore, note: input.note ?? "", effectBoundary: "dispatch-plan-only", messageSent: false, providerCallPlannedByPlatform: false };
  const previewHash = digest(snapshot);
  if (!apply) return output(action, [], { dryRun: true, ...snapshot, previewHash, externalEffectExecuted: false });
  if (input.previewHash !== previewHash) throw new Error("The reminder preview hash is required and must match the current envelope and signer boundary.");
  const plan = await create(store, auth, { moduleId, recordType: "reminder-plan", title: `Reminder plan · ${String(signer.role)}`, state: "approved", data: { ...snapshot, previewHash, contentHash: digest({ ...snapshot, previewHash, approvalDecisionId: approved!.decisionId }), approvalDecisionId: approved!.decisionId, approvedBy: approved!.approvedBy, approvedAt: approved!.approvedAt, createdAt: now.toISOString(), messageSent: false, providerCallStarted: false, immutable: true, version: 1 } });
  return output(action, [plan], { envelopeId: envelope.id, reminderPlanId: plan.id, signerId: signer.signerId, previewHash, messageSent: false, providerCallStarted: false, externalEffectExecuted: false });
}

async function certificateManifest(store: SuiteStore, auth: EsignAuthorization, envelope: SuiteRecord) {
  const records = await list(store, auth);
  const related = records.filter((record) => record.id === envelope.data.dispatchPlanId || record.data.envelopeId === envelope.id);
  const sessions = related.filter((record) => record.recordType === "signer-session").map((record) => ({ id: record.id, signerId: record.data.signerId, signerKeyHash: record.data.signerKeyHash, role: record.data.role, state: record.state, issuedAt: record.data.issuedAt, expiresAt: record.data.expiresAt, completedAt: record.data.completedAt, declinedAt: record.data.declinedAt, version: version(record) })).sort((left, right) => String(left.signerId).localeCompare(String(right.signerId)));
  const completions = related.filter((record) => record.recordType === "field-completion").map((record) => ({ id: record.id, sessionId: record.data.sessionId, signerId: record.data.signerId, signerKeyHash: record.data.signerKeyHash, fieldId: record.data.fieldId, fieldKind: record.data.fieldKind, valueHash: record.data.valueHash, method: record.data.method, completedAt: record.data.completedAt, documentHash: record.data.documentHash, envelopeDraftHash: record.data.envelopeDraftHash })).sort((left, right) => String(left.fieldId).localeCompare(String(right.fieldId)));
  const events = related.filter((record) => ["dispatch-plan", "decline-event", "void-event", "reminder-plan"].includes(record.recordType)).map((record) => ({ id: record.id, type: record.recordType, state: record.state, contentHash: record.data.contentHash ?? record.data.reasonHash ?? digest({ id: record.id, type: record.recordType, data: record.data }), createdAt: record.createdAt })).sort((left, right) => `${left.createdAt}:${left.id}`.localeCompare(`${right.createdAt}:${right.id}`));
  return canonical({ certificateSchema: "basic-esign-workflow-certificate.v1", legalScope: "basic-electronic-workflow-facts-only", qualifiedSignatureClaimed: false, complianceCertified: false, identityAssuranceClaimed: false, envelope: { id: envelope.id, state: envelope.state, version: version(envelope), envelopeDraftHash: envelope.data.envelopeDraftHash, templateVersionId: envelope.data.templateVersionId, templateContentHash: envelope.data.templateContentHash, documentId: envelope.data.documentId, documentHash: envelope.data.documentHash, documentObjectVersion: envelope.data.documentObjectVersion, expiresAt: envelope.data.expiresAt, completedAt: envelope.data.completedAt, declinedAt: envelope.data.declinedAt, voidedAt: envelope.data.voidedAt }, signers: signerRoutes(envelope), sessions, completions, events });
}

async function certificateExport(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, now: Date, apply: boolean, approved?: EsignApproval) {
  const envelope = await owned(store, auth, input.envelopeId, "envelope", "envelopeId");
  requireVersion(envelope, input.expectedVersion, "envelope");
  if (!["completed", "declined", "voided"].includes(envelope.state)) throw new Error("A certificate can be exported only for a terminal envelope.");
  const manifest = await certificateManifest(store, auth, envelope);
  const contentHash = digest(manifest);
  if (!apply) return output(action, [], { dryRun: true, envelopeId: envelope.id, envelopeState: envelope.state, format: input.format, contentHash, manifest, privateExport: true, legalComplianceCertified: false, qualifiedSignatureClaimed: false, externalEffectExecuted: false });
  const prior = (await list(store, auth, "certificate")).find((record) => record.data.envelopeId === envelope.id && record.data.contentHash === contentHash);
  const certificate = prior ?? await create(store, auth, { moduleId, recordType: "certificate", title: `Workflow certificate · ${envelope.title}`, state: "immutable", data: { envelopeId: envelope.id, envelopeState: envelope.state, format: input.format, contentHash, manifest, exportedAt: now.toISOString(), exportedByUserId: auth.userId, approvalDecisionId: approved!.decisionId, private: true, immutable: true, legalComplianceCertified: false, qualifiedSignatureClaimed: false, version: 1 } });
  return output(action, [certificate], { envelopeId: envelope.id, certificateId: certificate.id, contentHash, format: input.format, privateExport: true, replayedExistingCertificate: Boolean(prior), legalComplianceCertified: false, qualifiedSignatureClaimed: false, externalEffectExecuted: false });
}

async function queueAi(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, deps: EsignEngineDependencies) {
  const targetKey = action.id === "clause-propose" ? "templateVersionId" : "documentId";
  const targetType = action.id === "clause-propose" ? "template-version" : "document";
  const target = await owned(store, auth, input[targetKey], targetType, targetKey);
  const evidence: SuiteRecord[] = [];
  for (const recordId of input.evidenceIds as string[]) {
    const record = await store.getRecord(auth.userId, recordId);
    if (!record) throw new Error("An AI evidence record was not found in this workspace.");
    if (!["esign", "drive", "knowledge"].includes(record.moduleId)) throw new Error("E-signature AI evidence must be an e-signature, private-file, or knowledge record selected from this workspace.");
    evidence.push(record);
  }
  if (new Set(evidence.map((record) => record.id)).size !== evidence.length) throw new Error("AI evidence record IDs must be unique.");
  if (!action.promptId || action.promptVersion !== esignPromptPolicy.version) throw new Error("The e-signature AI action is missing an approved platform prompt boundary.");
  const allowedProposalKinds = action.id === "clause-propose" ? ["clause"] : ["field", "routing"];
  const boundary = {
    actionId: action.id,
    promptId: action.promptId,
    promptVersion: action.promptVersion,
    platformPromptId: esignPromptPolicy.id,
    platformPromptVersion: esignPromptPolicy.version,
    platformPromptDigest: esignPromptDigest(),
    modelPolicyId: deps.modelPolicyId,
    targetRecordId: target.id,
    targetRecordHash: digest(target),
    evidenceIds: evidence.map((record) => record.id),
    evidenceHashes: evidence.map((record) => ({ recordId: record.id, snapshotHash: digest(record) })),
    allowedProposalKinds,
    resultContract: esignPromptPolicy.resultContract,
    forbiddenAutonomy: esignPromptPolicy.forbiddenAutonomy,
    reviewStatus: "pending-model",
    approvalRequired: true,
    automaticMutationAllowed: false,
    signatureOrConsentAllowed: false,
    externalEffectExecuted: false,
    output: null,
    confidence: null,
  };
  const requestedAt = deps.now().toISOString();
  const auditRecord = await create(store, auth, { moduleId, recordType: auditType, title: action.title, state: "queued", data: { ...boundary, requestedAt, requestedByUserId: auth.userId, immutableRequest: true } });
  const aiAction = await store.queueAiAction(auth.userId, { moduleId, goal: String(input.instruction), context: { ...boundary, aiAuditRecordId: auditRecord.id } });
  if (!aiAction) throw new Error("The e-signature AI proposal could not be queued.");
  return { kind: "ai-action", action, records: [auditRecord], aiAction, audit: { aiAuditRecordId: auditRecord.id, ...boundary, modelExecuted: false, externalEffectExecuted: false } } satisfies EsignExecutionResult;
}

function strictKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label} contains fields outside the approved result contract.`);
}

export function validateEsignAiCompletion(value: unknown, boundary: { authorizedRecordIds: Iterable<string>; allowedProposalKinds: Iterable<string> }): EsignAiCompletion {
  const result = object(value, "AI result");
  strictKeys(result, ["proposals", "confidence", "assumptions", "reviewStatus", "approvalRequired", "model"], "AI result");
  if (!Array.isArray(result.proposals) || result.proposals.length < 1 || result.proposals.length > 100) throw new Error("AI result must include one to one hundred proposals.");
  const authorized = new Set(boundary.authorizedRecordIds);
  const allowedKinds = new Set(boundary.allowedProposalKinds);
  const proposalIds = new Set<string>();
  const proposals = result.proposals.map((value, index) => {
    const proposal = object(value, `AI result.proposals[${index}]`);
    strictKeys(proposal, ["proposalId", "kind", "text", "citations", "rationale", "riskFlags"], `AI result.proposals[${index}]`);
    if (typeof proposal.proposalId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(proposal.proposalId) || proposalIds.has(proposal.proposalId)) throw new Error("Every AI proposal needs a unique bounded proposalId.");
    proposalIds.add(proposal.proposalId);
    if (typeof proposal.kind !== "string" || !allowedKinds.has(proposal.kind)) throw new Error("An AI proposal kind exceeds the authorized action boundary.");
    if (typeof proposal.text !== "string" || !proposal.text.trim() || proposal.text.length > 20_000) throw new Error("Every AI proposal needs bounded non-empty text.");
    if (typeof proposal.rationale !== "string" || !proposal.rationale.trim() || proposal.rationale.length > 4_000) throw new Error("Every AI proposal needs a bounded rationale.");
    if (!Array.isArray(proposal.citations) || proposal.citations.length < 1 || proposal.citations.length > 100 || proposal.citations.some((citation) => typeof citation !== "string" || !authorized.has(citation))) throw new Error("Every AI proposal must cite only authorized records.");
    if (!Array.isArray(proposal.riskFlags) || proposal.riskFlags.length > 20 || proposal.riskFlags.some((flag) => typeof flag !== "string" || !flag.trim() || flag.length > 500)) throw new Error("AI proposal risk flags are malformed.");
    return { proposalId: proposal.proposalId, kind: proposal.kind as EsignAiProposal["kind"], text: proposal.text.trim(), citations: [...new Set(proposal.citations as string[])], rationale: proposal.rationale.trim(), riskFlags: proposal.riskFlags as string[] };
  });
  if (typeof result.confidence !== "number" || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new Error("AI confidence must be from zero to one.");
  if (!Array.isArray(result.assumptions) || result.assumptions.length > 50 || result.assumptions.some((item) => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new Error("AI assumptions are malformed.");
  if (result.reviewStatus !== "pending-human-review" || result.approvalRequired !== true) throw new Error("AI output must remain pending human review and approval-required.");
  if (typeof result.model !== "string" || !result.model.trim() || result.model.length > 200) throw new Error("The executed model identifier is required.");
  return { proposals, confidence: result.confidence, assumptions: result.assumptions as string[], reviewStatus: "pending-human-review", approvalRequired: true, model: result.model.trim() };
}

export async function recordEsignAiCompletion(store: SuiteStore, auth: EsignAuthorization, aiActionId: string, value?: unknown, completedAt = new Date()) {
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
    const aiAction = await store.getAiAction(auth.userId, aiActionId);
    if (!aiAction || aiAction.workspaceId !== auth.workspaceId || aiAction.moduleId !== moduleId || aiAction.status !== "completed") throw new Error("The completed e-signature AI action was not found in this workspace.");
    const action = esignAction(moduleId, String(aiAction.context.actionId));
    if (!action || action.operation !== "ai" || action.promptId !== aiAction.context.promptId || action.promptVersion !== aiAction.context.promptVersion || aiAction.context.platformPromptId !== esignPromptPolicy.id || aiAction.context.platformPromptVersion !== esignPromptPolicy.version || aiAction.context.platformPromptDigest !== esignPromptDigest()) throw new Error("The completed AI action does not match the trusted e-signature platform prompt boundary.");
    await authorize(store, auth, action);
    const evidenceIds = Array.isArray(aiAction.context.evidenceIds) ? aiAction.context.evidenceIds.filter((id): id is string => typeof id === "string") : [];
    const targetRecordId = typeof aiAction.context.targetRecordId === "string" ? aiAction.context.targetRecordId : "";
    const allowedProposalKinds = Array.isArray(aiAction.context.allowedProposalKinds) ? aiAction.context.allowedProposalKinds.filter((kind): kind is string => typeof kind === "string") : [];
    const completion = validateEsignAiCompletion(value ?? aiAction.result, { authorizedRecordIds: [...evidenceIds, targetRecordId], allowedProposalKinds });
    const auditRecord = await owned(store, auth, aiAction.context.aiAuditRecordId, auditType, "aiAuditRecordId");
    if (auditRecord.data.platformPromptDigest !== esignPromptDigest() || auditRecord.data.targetRecordId !== targetRecordId || auditRecord.data.reviewStatus !== "pending-model") {
      if (auditRecord.data.resultHash) {
        const replayHash = digest(completion);
        if (auditRecord.data.resultHash !== replayHash) throw new Error("The AI audit is already bound to a different completion.");
        return { auditRecord, completion, replayed: true };
      }
      throw new Error("The e-signature AI audit boundary is stale or mismatched.");
    }
    const resultHash = digest(completion);
    const recorded = await update(store, auth, auditRecord, { state: "pending-human-review", data: { resultHash, executedModel: completion.model, confidence: completion.confidence, proposalCount: completion.proposals.length, proposalKinds: [...new Set(completion.proposals.map((proposal) => proposal.kind))], citedRecordIds: [...new Set(completion.proposals.flatMap((proposal) => proposal.citations))], assumptions: completion.assumptions, reviewStatus: "pending-human-review", approvalRequired: true, completedAt: completedAt.toISOString(), automaticMutationAllowed: false, signatureOrConsentAllowed: false, externalEffectExecuted: false } });
    return { auditRecord: recorded, completion, replayed: false };
  });
}

async function executeCommand(store: SuiteStore, auth: EsignAuthorization, action: EsignActionDefinition, input: Record<string, unknown>, deps: EsignEngineDependencies, apply: boolean, approved?: EsignApproval): Promise<EsignExecutionResult> {
  const now = deps.now();
  if (action.id === "template-create") return templateCreate(store, auth, action, input, now);
  if (action.id === "template-version-create") return templateVersionCreate(store, auth, action, input, now);
  if (action.id === "document-register") return documentRegister(store, auth, action, input, now);
  if (action.id === "envelope-draft") return envelopeDraft(store, auth, action, input, now);
  if (action.id === "envelope-preview") return envelopePreview(store, auth, action, input);
  if (action.id === "envelope-dispatch-plan") return envelopeDispatchPlan(store, auth, action, input, now, apply, approved);
  if (action.id === "signer-session-issue") return signerSessionIssue(store, auth, action, input, now, deps, apply, approved);
  if (action.id === "field-completion-record") return fieldCompletionRecord(store, auth, action, input, now, apply, approved);
  if (action.id === "decline-record") return declineRecord(store, auth, action, input, now, apply, approved);
  if (action.id === "envelope-void") return envelopeVoid(store, auth, action, input, now, apply, approved);
  if (action.id === "reminder-plan") return reminderPlan(store, auth, action, input, now, apply, approved);
  if (action.id === "certificate-export") return certificateExport(store, auth, action, input, now, apply, approved);
  throw new Error(`E-signature action ${action.id} is not implemented.`);
}

export async function executeEsignAction(store: SuiteStore, auth: EsignAuthorization, requestedModuleId: string, actionId: string, input: Record<string, unknown>, dependencies: Partial<EsignEngineDependencies> = {}): Promise<EsignExecutionResult> {
  const action = esignAction(requestedModuleId, actionId);
  if (!action) throw new Error("The e-signature action does not exist.");
  validate(input, action.inputSchema as unknown as Record<string, unknown>, "input");
  const deps: EsignEngineDependencies = { now: dependencies.now ?? defaults.now, randomBytes: dependencies.randomBytes ?? defaults.randomBytes, modelPolicyId: dependencies.modelPolicyId ?? defaults.modelPolicyId };
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
    await authorize(store, auth, action);
    if (action.operation === "read") return executeCommand(store, auth, action, input, deps, false);
    const key = String(input.idempotencyKey);
    const requestHash = digest({ workspaceId: auth.workspaceId, moduleId, actionId: action.id, input: requestInputForDigest(input) });
    const prior = await replay(store, auth, action, key, requestHash);
    if (prior) return prior;
    if (action.operation === "ai") return saveReceipt(store, auth, action, key, requestHash, await queueAi(store, auth, action, input, deps));
    const dryRun = action.approvalRequired && input.dryRun === true;
    const approved = action.approvalRequired && !dryRun ? approval(input, auth, deps.now()) : undefined;
    const execution = await executeCommand(store, auth, action, input, deps, !dryRun, approved);
    execution.audit = { ...execution.audit, dryRun, effectBoundary: action.effectBoundary, messageSent: false, providerCallStarted: false, autonomousSignatureOrConsent: false, legalComplianceCertified: false, ...(approved ? { approvalDecisionId: approved.decisionId, approvedBy: approved.approvedBy, approvalReason: approved.reason, approvedAt: approved.approvedAt } : {}) };
    return saveReceipt(store, auth, action, key, requestHash, execution);
  });
}

export function esignIntegrationManifest() {
  return {
    moduleId,
    engine: "esign",
    minimumPlan: "starter",
    actions: esignActions.map((action) => action.id),
    receiptRecordType: receiptType,
    aiAuditRecordType: auditType,
    platformPromptId: esignPromptPolicy.id,
    platformPromptVersion: esignPromptPolicy.version,
    platformPromptDigest: esignPromptDigest(),
  } as const;
}
