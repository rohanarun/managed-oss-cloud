import { createHash } from "node:crypto";
import type { SuiteAiAction, SuiteRecord, SuiteWorkspace, SuiteWorkspaceRole } from "../shared/suite.js";
import {
  additiveWaveTwoAction,
  additiveWaveTwoModuleById,
  additiveWaveTwoPlanAllows,
  type AdditiveWaveTwoActionDefinition,
  type AdditiveWaveTwoModuleId,
  type AdditiveWaveTwoPlanId,
  type AdditiveWaveTwoScope,
} from "../shared/extended-business-actions.js";
import { canonicalJsonSha256 } from "./ai-result.js";
import type { SuiteStore } from "./suite-store.js";
import { canReadSuiteRecord } from "./suite-record-visibility.js";

export interface ExtendedBusinessAuthorization {
  userId: string;
  workspaceId: string;
  role: SuiteWorkspaceRole;
  scopes: string[];
}

export type ExtendedBusinessStore = Pick<SuiteStore,
  "runInWorkspaceTransaction" | "getOrCreateWorkspace" | "listWorkspaceMembers" | "removeWorkspaceMember" | "listRecords" | "getRecord" | "findCommandReceipt" | "findApprovalDecisionReceipt" | "createRecord" | "updateRecord" | "queueAiAction" | "getAiAction"
>;

export interface ExtendedBusinessEngineDependencies {
  now: () => Date;
  modelPolicyId: string;
  verifyExternalEvidence: (request: ExtendedExternalEvidenceRequest) => Promise<ExtendedExternalEvidenceVerification | undefined>;
}

export type ExtendedExternalEvidenceKind = "event-payment" | "event-refund" | "event-check-in" | "people-access-revocation" | "metering-usage-event" | "metering-invoice-payment";

export interface ExtendedExternalEvidenceRequest {
  version: "extended-external-evidence.v1";
  kind: ExtendedExternalEvidenceKind;
  workspaceId: string;
  actorUserId: string;
  moduleId: AdditiveWaveTwoModuleId;
  actionId: string;
  requestedAt: string;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  attestationToken?: string;
}

export interface ExtendedExternalEvidenceVerification {
  verified: true;
  verifierId: string;
  verificationId: string;
  verifiedAt: string;
  evidenceHash: string;
}

export interface ExtendedBusinessExecutionResult {
  kind: "read" | "mutation" | "ai-action";
  action: AdditiveWaveTwoActionDefinition;
  records: SuiteRecord[];
  audit: Record<string, unknown>;
  aiAction?: SuiteAiAction;
}

interface HumanApproval {
  approved: true;
  approvedBy: string;
  approvedAt: string;
  decisionId: string;
  reason: string;
}

const defaults: ExtendedBusinessEngineDependencies = {
  now: () => new Date(),
  modelPolicyId: "workspace-configured-model",
  verifyExternalEvidence: async () => undefined,
};
const receiptRecordType = "extended-business-command-receipt";
// Domain and external-identifier scans without exact SuiteStore lookups remain
// bounded with a one-record saturation sentinel. Receipt replay and approval
// decisions use the indexed store contract below and do not consume this budget.
export const extendedBusinessBoundedScanLimit = 100_000;
export const extendedBusinessApprovalFreshnessMs = 24 * 60 * 60 * 1_000;
const roleRank: Record<SuiteWorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const modelCredentialPattern = /(?:api[_-]?key|secret|token|sk-[a-z0-9])/i;

function expectedModelPolicyId(expectedModelId: unknown, trustedModelPolicyId: unknown) {
  if (typeof trustedModelPolicyId !== "string" || !trustedModelPolicyId.trim() || trustedModelPolicyId.length > 200 || modelCredentialPattern.test(trustedModelPolicyId)) throw new Error("A trusted workspace model policy is required before queuing extended AI work.");
  if (expectedModelId === undefined) return trustedModelPolicyId;
  if (typeof expectedModelId !== "string" || modelCredentialPattern.test(expectedModelId)) throw new Error("modelId must be an identifier, not a credential.");
  if (expectedModelId !== trustedModelPolicyId) throw new Error("modelId must exactly match the workspace-configured model policy.");
  return trustedModelPolicyId;
}

export function extendedBusinessDigest(value: unknown) {
  return canonicalJsonSha256(value);
}

export function extendedBusinessTextDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function extendedExternalEvidenceHash(input: Pick<ExtendedExternalEvidenceRequest, "version" | "kind" | "workspaceId" | "actorUserId" | "moduleId" | "actionId" | "evidence">) {
  return extendedBusinessDigest(input);
}

async function verifyExternalEvidence(
  deps: ExtendedBusinessEngineDependencies,
  auth: ExtendedBusinessAuthorization,
  action: AdditiveWaveTwoActionDefinition,
  kind: ExtendedExternalEvidenceKind,
  evidence: Record<string, unknown>,
  now: string,
  attestationToken: unknown,
) {
  const evidenceEnvelope = { version: "extended-external-evidence.v1" as const, kind, workspaceId: auth.workspaceId, actorUserId: auth.userId, moduleId: action.moduleId, actionId: action.id, evidence };
  const evidenceHash = extendedExternalEvidenceHash(evidenceEnvelope);
  const verification = await deps.verifyExternalEvidence({ ...evidenceEnvelope, requestedAt: now, evidenceHash, ...(typeof attestationToken === "string" ? { attestationToken } : {}) });
  const verifiedAt = typeof verification?.verifiedAt === "string" ? time(verification.verifiedAt, "externalEvidence.verifiedAt") : Number.NaN;
  if (!verification
    || verification.verified !== true
    || !/^[A-Za-z0-9._:/-]{2,200}$/.test(verification.verifierId ?? "")
    || !/^[A-Za-z0-9._:/-]{8,240}$/.test(verification.verificationId ?? "")
    || verification.evidenceHash !== evidenceHash
    || !Number.isFinite(verifiedAt)
    || verifiedAt > time(now, "now")) throw new Error("The exact external evidence was not verified by a trusted hosting-layer adapter.");
  return { verifierId: verification.verifierId, verificationId: verification.verificationId, verifiedAt: new Date(verifiedAt).toISOString(), evidenceHash };
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
  if (schema.format === "uri") { try { new URL(value); } catch { throw new Error(`${path} must be a URL.`); } }
}

function validate(value: unknown, schema: Record<string, unknown>, path: string): void {
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
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite.`);
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`${path} is below its minimum.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`${path} exceeds its maximum.`);
    return;
  }
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

function time(value: unknown, label: string) {
  const timestamp = new Date(String(value)).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid date-time.`);
  return timestamp;
}

function iso(value: unknown, label: string) {
  return new Date(time(value, label)).toISOString();
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text.`);
  return value;
}

function integer(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
  return value;
}

function numeric(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function strings(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must contain non-empty strings.`);
  return [...new Set(value as string[])];
}

function version(record: SuiteRecord) {
  const candidate = Number(record.data.version ?? 1);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 1;
}

function nextVersion(record: SuiteRecord, input: Record<string, unknown>) {
  if (integer(input.expectedVersion, "expectedVersion") !== version(record)) throw new Error("The record version is stale.");
  return version(record) + 1;
}

function output(action: AdditiveWaveTwoActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>, kind: ExtendedBusinessExecutionResult["kind"] = "mutation"): ExtendedBusinessExecutionResult {
  return { kind, action, records, audit };
}

async function create(store: ExtendedBusinessStore, userId: string, input: Parameters<SuiteStore["createRecord"]>[1]) {
  const record = await store.createRecord(userId, input);
  if (!record) throw new Error("The tenant record could not be persisted.");
  return record;
}

async function update(store: ExtendedBusinessStore, userId: string, recordId: string, input: Parameters<SuiteStore["updateRecord"]>[2]) {
  const record = await store.updateRecord(userId, recordId, input);
  if (!record) throw new Error("The tenant record could not be updated.");
  return record;
}

async function ownedWithPrincipal(store: ExtendedBusinessStore, principal: { userId: string; workspaceId: string; role: SuiteWorkspaceRole }, recordId: unknown, moduleId?: string, recordType?: string, label = "recordId") {
  if (typeof recordId !== "string") throw new Error(`${label} must be a record ID.`);
  const record = await store.getRecord(principal.userId, recordId);
  if (!record
    || !canReadSuiteRecord(principal, record)
    || (moduleId && record.moduleId !== moduleId)
    || (recordType && record.recordType !== recordType)) throw new Error(`${label.replace(/Id$/, "")} not found.`);
  return record;
}

async function owned(store: ExtendedBusinessStore, userId: string, recordId: unknown, moduleId?: string, recordType?: string, label = "recordId") {
  const workspace = await store.getOrCreateWorkspace(userId);
  if (!workspace.currentRole) throw new Error(`${label.replace(/Id$/, "")} not found.`);
  return ownedWithPrincipal(store, { userId, workspaceId: workspace.id, role: workspace.currentRole }, recordId, moduleId, recordType, label);
}

async function ownedMany(store: ExtendedBusinessStore, userId: string, ids: unknown, moduleId?: string, recordType?: string, label = "recordIds") {
  if (!Array.isArray(ids)) throw new Error(`${label} must be an array.`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must not contain duplicate record IDs.`);
  const workspace = await store.getOrCreateWorkspace(userId);
  if (!workspace.currentRole) throw new Error(`${label} not found.`);
  const principal = { userId, workspaceId: workspace.id, role: workspace.currentRole };
  const records: SuiteRecord[] = [];
  for (const id of ids) records.push(await ownedWithPrincipal(store, principal, id, moduleId, recordType, label));
  return records;
}

async function list(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, moduleId: AdditiveWaveTwoModuleId, recordType?: string) {
  const workspace = await store.getOrCreateWorkspace(auth.userId);
  if (workspace.id !== auth.workspaceId || !workspace.currentRole || workspace.currentRole !== auth.role) throw new Error("The authenticated workspace principal changed before the protected record scan.");
  const records = await store.listRecords(auth.userId, { moduleId, recordType, limit: extendedBusinessBoundedScanLimit + 1 });
  if (records.length > extendedBusinessBoundedScanLimit) throw new Error(`The bounded ${moduleId}/${recordType ?? "all-records"} scan is saturated; an indexed or paginated SuiteStore lookup is required before this action can run safely.`);
  const principal = { userId: auth.userId, workspaceId: workspace.id, role: workspace.currentRole };
  return records.filter((record) => canReadSuiteRecord(principal, record));
}

function approval(input: Record<string, unknown>, auth: ExtendedBusinessAuthorization, now: string): HumanApproval {
  const candidate = input.approval as HumanApproval | undefined;
  if (!candidate || candidate.approved !== true || candidate.approvedBy !== auth.userId || !candidate.reason?.trim() || !/^[A-Za-z0-9._:-]{16,200}$/.test(candidate.decisionId ?? "") || !Number.isFinite(new Date(candidate.approvedAt).getTime())) throw new Error("An attributable, reasoned, uniquely identified human approval is required when dryRun is false.");
  const approvedAt = time(candidate.approvedAt, "approval.approvedAt");
  const currentTime = time(now, "now");
  if (approvedAt > currentTime) throw new Error("Human approval cannot be future-dated.");
  if (currentTime - approvedAt > extendedBusinessApprovalFreshnessMs) throw new Error("Human approval is stale and must be reviewed again against the current request.");
  return candidate;
}

async function assertUnusedApprovalDecision(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, decisionId: string) {
  if (await store.findApprovalDecisionReceipt(auth.userId, decisionId)) throw new Error("The human approval decision ID is already bound to another committed command.");
}

function hasScope(auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition) {
  return auth.scopes.some((scope) => scope === "*" || scope === action.requiredScope || scope === `${action.moduleId}:*` || scope === `${action.moduleId}:${action.requiredScope}`);
}

async function authorize(auth: ExtendedBusinessAuthorization, workspace: SuiteWorkspace, action: AdditiveWaveTwoActionDefinition) {
  if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
  if (workspace.currentRole && workspace.currentRole !== auth.role) throw new Error("The authorization role does not match the tenant membership.");
  if (!additiveWaveTwoPlanAllows(workspace.plan as AdditiveWaveTwoPlanId, action.moduleId)) throw new Error(`${action.moduleId} requires the ${additiveWaveTwoModuleById.get(action.moduleId)?.minPlan} plan.`);
  if (!workspace.enabledModuleIds.includes(action.moduleId)) throw new Error(`${action.moduleId} is not enabled for this workspace.`);
  if (roleRank[auth.role] < roleRank[action.minimumRole]) throw new Error(`${action.minimumRole} role is required for ${action.id}.`);
  if (!hasScope(auth, action)) throw new Error(`${action.moduleId}:${action.requiredScope} scope is required.`);
}

async function workspaceIdentity(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, identity: unknown, label: string, minimumRole: SuiteWorkspaceRole = "member") {
  const member = typeof identity === "string" ? (await store.listWorkspaceMembers(auth.userId)).find((candidate) => candidate.userId === identity) : undefined;
  if (!member || roleRank[member.role] < roleRank[minimumRole]) throw new Error(`${label} must be an authenticated member of this workspace with ${minimumRole} role or higher.`);
  return member;
}

async function replay(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, key: string, requestHash: string) {
  const prior = await store.findCommandReceipt(auth.userId, { recordType: receiptRecordType, moduleId: action.moduleId, actionId: action.id, idempotencyKey: key });
  if (!prior) return undefined;
  if (prior.data.actorUserId !== auth.userId) throw new Error("The idempotency key is already bound to another authenticated actor.");
  if (prior.data.requestHash !== requestHash || prior.data.actionId !== action.id) throw new Error("The idempotency key is already bound to a different request.");
  const snapshot = prior.data.resultSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("The extended-business idempotency receipt is missing its immutable result snapshot.");
  const stored = snapshot as Record<string, unknown>;
  if (!Array.isArray(stored.records) || !stored.audit || typeof stored.audit !== "object" || Array.isArray(stored.audit) || !["read", "mutation", "ai-action"].includes(String(stored.kind))) throw new Error("The extended-business idempotency result snapshot is malformed.");
  const storedApprovalDecisionId = (stored.audit as Record<string, unknown>).approvalDecisionId ?? null;
  if (prior.data.approvalDecisionId !== undefined && prior.data.approvalDecisionId !== storedApprovalDecisionId) throw new Error("The extended-business approval decision binding is inconsistent.");
  return {
    kind: stored.kind as ExtendedBusinessExecutionResult["kind"],
    action,
    records: structuredClone(stored.records as SuiteRecord[]),
    audit: { ...structuredClone(stored.audit as Record<string, unknown>), replayed: true, receiptId: prior.id },
    ...(stored.aiAction && typeof stored.aiAction === "object" && !Array.isArray(stored.aiAction) ? { aiAction: structuredClone(stored.aiAction as SuiteAiAction) } : {}),
  } satisfies ExtendedBusinessExecutionResult;
}

async function saveReceipt(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, key: string, requestHash: string, result: ExtendedBusinessExecutionResult, now: string) {
  const resultSnapshot = {
    kind: result.kind,
    records: structuredClone(result.records),
    audit: structuredClone(result.audit),
    ...(result.aiAction ? { aiAction: structuredClone(result.aiAction) } : {}),
  };
  const receipt = await create(store, auth.userId, {
    moduleId: result.action.moduleId,
    recordType: receiptRecordType,
    title: `${result.action.id} command receipt`,
    state: "committed",
    data: { idempotencyKey: key, requestHash, actionId: result.action.id, actorUserId: auth.userId, approvalDecisionId: result.audit.approvalDecisionId ?? null, resultSnapshot, committedAt: now },
  });
  result.audit = { ...result.audit, replayed: false, receiptId: receipt.id };
  return result;
}

const assuranceClassificationRank = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;
type AssuranceClassification = keyof typeof assuranceClassificationRank;

function recordIdentity(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} privacy metadata is missing.`);
  return value;
}

function recordIdentityList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} privacy metadata is missing.`);
  return [...new Set(value as string[])];
}

function assuranceClassification(value: unknown, label: string) {
  if (typeof value !== "string" || !(value in assuranceClassificationRank)) throw new Error(`${label} privacy metadata is missing.`);
  return value as AssuranceClassification;
}

function strongestAssuranceClassification(values: readonly unknown[]) {
  const classifications = values.map((value) => assuranceClassification(value, "Assurance classification"));
  if (!classifications.length) return undefined;
  return [...classifications].sort((left, right) => assuranceClassificationRank[right] - assuranceClassificationRank[left])[0];
}

function assuranceLineage(record: SuiteRecord) {
  const programId = record.recordType === "assurance-program" ? record.id : recordIdentity(record.data.programId, "Assurance program");
  const programOwnerRef = recordIdentity(record.data.programOwnerRef ?? (record.recordType === "assurance-program" ? record.data.ownerRef : undefined), "Assurance program owner");
  const lineage: Record<string, unknown> = { programId, programOwnerRef };
  if (typeof record.data.subjectId === "string") lineage.subjectId = record.data.subjectId;
  if (typeof record.data.subjectOwnerRef === "string") lineage.subjectOwnerRef = record.data.subjectOwnerRef;
  if (typeof record.data.subjectClassification === "string") lineage.subjectClassification = assuranceClassification(record.data.subjectClassification, "Assurance subject classification");
  if (Array.isArray(record.data.subjectIds)) lineage.subjectIds = recordIdentityList(record.data.subjectIds, "Assurance subject IDs");
  if (Array.isArray(record.data.subjectOwnerRefs)) lineage.subjectOwnerRefs = recordIdentityList(record.data.subjectOwnerRefs, "Assurance subject owners");
  if (Array.isArray(record.data.subjectClassifications)) lineage.subjectClassifications = record.data.subjectClassifications.map((value) => assuranceClassification(value, "Assurance subject classification"));
  if (typeof record.data.assuranceClassification === "string") lineage.assuranceClassification = assuranceClassification(record.data.assuranceClassification, "Assurance classification");
  return lineage;
}

function liveSessionPrivacy(record: SuiteRecord, additionalParticipantRefs: readonly string[] = []) {
  const sessionId = record.recordType === "live-session" ? record.id : recordIdentity(record.data.sessionId, "Live session");
  const sessionVisibility = recordIdentity(record.recordType === "live-session" ? record.data.visibility : record.data.sessionVisibility, "Live session visibility");
  if (!["private", "workspace", "invited-public"].includes(sessionVisibility)) throw new Error("Live session visibility privacy metadata is invalid.");
  const sessionCreatedBy = recordIdentity(record.data.sessionCreatedBy, "Live session creator");
  const sessionParticipantRefs = [...new Set([...recordIdentityList(record.data.sessionParticipantRefs, "Live session participants"), ...additionalParticipantRefs])];
  return { sessionId, sessionVisibility, sessionCreatedBy, sessionParticipantRefs };
}

function proposalTargetPrivacy(action: AdditiveWaveTwoActionDefinition, target: SuiteRecord | undefined, auth: ExtendedBusinessAuthorization) {
  if (!target) return {};
  if (action.moduleId === "assurance") return { ...assuranceLineage(target), requestedByUserId: auth.userId };
  if (action.moduleId === "live") return { ...liveSessionPrivacy(target), requestedByUserId: auth.userId };
  return { requestedByUserId: auth.userId };
}

async function queueProposal(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, input: Record<string, unknown>, trustedModelPolicyId: string, now: string) {
  const evidenceIds = strings(input.evidenceIds, "evidenceIds");
  const evidence = await ownedMany(store, auth.userId, evidenceIds, undefined, undefined, "evidenceIds");
  const targetKey = ["eventId", "profileId", "invoiceId", "programId", "sessionId"].find((key) => typeof input[key] === "string");
  const target = targetKey ? await owned(store, auth.userId, input[targetKey], action.moduleId, undefined, targetKey) : undefined;
  const targetPrivacy = proposalTargetPrivacy(action, target, auth);
  const evidenceBindings = evidence.map((record) => ({ recordId: record.id, moduleId: record.moduleId, recordType: record.recordType, version: version(record), snapshotHash: extendedBusinessDigest(record) }));
  const auditRecord = await create(store, auth.userId, {
    moduleId: action.moduleId,
    recordType: "ai-proposal-request",
    title: action.title,
    state: "queued",
    data: {
      actionId: action.id,
      promptId: action.promptId,
      promptVersion: action.promptVersion,
      modelPolicyId: trustedModelPolicyId,
      requestedModelId: trustedModelPolicyId,
      evidenceIds,
      evidenceBindings,
      ...(target ? { targetRecordId: target.id, targetVersion: version(target), targetSnapshotHash: extendedBusinessDigest(target) } : {}),
      ...targetPrivacy,
      proposalOnly: true,
      automaticMutationAllowed: false,
      externalEffectAllowed: false,
      employmentDecisionAllowed: false,
      financialDecisionAllowed: false,
      accessDecisionAllowed: false,
      moderationDecisionAllowed: false,
      reviewStatus: "pending-model",
      requestedAt: now,
    },
  });
  const goal = String(input.goal ?? input.question ?? input.audience ?? action.title);
  const aiAction = await store.queueAiAction(auth.userId, {
    moduleId: action.moduleId,
    goal,
    context: {
      actionId: action.id,
      promptId: action.promptId,
      promptVersion: action.promptVersion,
      modelPolicyId: trustedModelPolicyId,
      requestedModelId: trustedModelPolicyId,
      evidenceIds,
      evidenceBindings,
      ...(target ? { targetRecordId: target.id, targetVersion: version(target), targetSnapshotHash: extendedBusinessDigest(target) } : {}),
      ...targetPrivacy,
      aiAuditRecordId: auditRecord.id,
      resultContract: { version: "extended-business-proposal.v1", required: ["proposal", "evidence", "confidence", "assumptions", "reviewStatus"], reviewStatus: "pending-human-review", approvalRequired: true },
      systemBoundary: "Return a cited proposal only. Never execute, approve, publish, pay, refund, issue access, make an employment decision, moderate, infer consent, or mutate tenant state.",
    },
  });
  if (!aiAction) throw new Error("The tenant AI proposal could not be queued.");
  return { kind: "ai-action", action, records: [auditRecord], aiAction, audit: { proposalOnly: true, aiActionId: aiAction.id, evidenceIds, providerCallStarted: false, autonomousSideEffect: false } } satisfies ExtendedBusinessExecutionResult;
}

function dryRunResult(action: AdditiveWaveTwoActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>) {
  return output(action, records, { ...audit, dryRun: true, wouldPersist: false, providerCallStarted: false, autonomousSideEffect: false });
}

function eventReleaseHash(event: SuiteRecord) {
  return extendedBusinessDigest({ eventId: event.id, version: version(event), title: event.title, key: event.data.key, purpose: event.data.purpose, startsAt: event.data.startsAt, endsAt: event.data.endsAt, timeZone: event.data.timeZone, venueMode: event.data.venueMode, venue: event.data.venue, capacity: event.data.capacity });
}

async function events(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, input: Record<string, unknown>, now: string, apply: boolean, deps: ExtendedBusinessEngineDependencies) {
  if (action.id === "create-draft") {
    if (time(input.endsAt, "endsAt") <= time(input.startsAt, "startsAt")) throw new Error("The event must end after it starts.");
    if ((await list(store, auth, "events", "event")).some((record) => record.data.key === input.key)) throw new Error("The event key already exists.");
    const record = await create(store, auth.userId, { moduleId: "events", recordType: "event", title: String(input.title), state: "draft", data: { ...input, idempotencyKey: undefined, version: 1, createdAt: now } });
    return output(action, [record], { eventId: record.id, releaseHash: eventReleaseHash(record) });
  }
  if (action.id === "publish-release") {
    const event = await owned(store, auth.userId, input.eventId, "events", "event", "eventId");
    const next = nextVersion(event, input);
    const expectedHash = eventReleaseHash(event);
    if (!apply) return dryRunResult(action, [event], { eventId: event.id, expectedReleaseHash: expectedHash, nextVersion: next });
    if (input.releaseHash !== expectedHash) throw new Error("The event release hash does not match the current draft.");
    if (!["draft", "published"].includes(event.state)) throw new Error("Only a draft or published event can release a new version.");
    const released = await update(store, auth.userId, event.id, { state: "published", data: { version: next, activeReleaseHash: expectedHash, publishedAt: now } });
    const receipt = await create(store, auth.userId, { moduleId: "events", recordType: "event-release", title: `Release · ${event.title}`, state: "approved-pending-publication", data: { eventId: event.id, eventVersion: next, releaseHash: expectedHash, approvedAt: now, providerExecutionStarted: false } });
    return output(action, [released, receipt], { eventId: event.id, releaseId: receipt.id, releaseHash: expectedHash });
  }
  if (action.id === "define-ticket-type") {
    const event = await owned(store, auth.userId, input.eventId, "events", "event", "eventId");
    if (time(input.salesEndAt, "salesEndAt") <= time(input.salesStartAt, "salesStartAt")) throw new Error("Ticket sales must end after they start.");
    if (time(input.salesEndAt, "salesEndAt") > time(event.data.endsAt, "event.endsAt")) throw new Error("Ticket sales cannot end after the event.");
    const eventTicketTypes = (await list(store, auth, "events", "ticket-type")).filter((record) => record.data.eventId === event.id);
    const duplicate = eventTicketTypes.some((record) => record.data.key === input.key);
    if (duplicate) throw new Error("The ticket key already exists for this event.");
    if (eventTicketTypes.reduce((sum, record) => sum + Number(record.data.quantity), 0) + Number(input.quantity) > Number(event.data.capacity)) throw new Error("Defined ticket inventory cannot exceed event capacity.");
    const ticketType = await create(store, auth.userId, { moduleId: "events", recordType: "ticket-type", title: String(input.name), state: "defined", data: { ...input, idempotencyKey: undefined, eventId: event.id, version: 1, createdAt: now } });
    return output(action, [event, ticketType], { ticketTypeId: ticketType.id, inventory: ticketType.data.quantity });
  }
  if (action.id === "reserve-tickets") {
    const ticketType = await owned(store, auth.userId, input.ticketTypeId, "events", "ticket-type", "ticketTypeId");
    const event = await owned(store, auth.userId, ticketType.data.eventId, "events", "event", "eventId");
    if (event.state !== "published") throw new Error("Tickets can only be reserved for a published event.");
    if (time(now, "now") < time(ticketType.data.salesStartAt, "ticketType.salesStartAt") || time(now, "now") >= time(ticketType.data.salesEndAt, "ticketType.salesEndAt")) throw new Error("Ticket reservations are outside this ticket type's sales window.");
    const expiresAt = time(input.expiresAt, "expiresAt");
    if (expiresAt <= time(now, "now") || expiresAt > time(event.data.startsAt, "event.startsAt")) throw new Error("The reservation expiry is outside the allowed window.");
    const active = (await list(store, auth, "events", "ticket-reservation")).filter((record) => record.data.ticketTypeId === ticketType.id && ["reserved", "paid"].includes(record.state) && (record.state === "paid" || time(record.data.expiresAt, "reservation.expiresAt") > time(now, "now")));
    const committed = active.reduce((sum, record) => sum + Number(record.data.quantity), 0);
    const quantity = integer(input.quantity, "quantity");
    if (committed + quantity > Number(ticketType.data.quantity)) throw new Error("The requested ticket quantity exceeds available inventory.");
    const reservation = await create(store, auth.userId, { moduleId: "events", recordType: "ticket-reservation", title: `Reservation · ${ticketType.title}`, state: "reserved", data: { ticketTypeId: ticketType.id, eventId: event.id, customerRef: input.customerRef, quantity, expiresAt: iso(input.expiresAt, "expiresAt"), version: 1, reservedAt: now } });
    return output(action, [reservation], { reservationId: reservation.id, remainingInventory: Number(ticketType.data.quantity) - committed - quantity });
  }
  if (action.id === "create-checkout") {
    const reservation = await owned(store, auth.userId, input.reservationId, "events", "ticket-reservation", "reservationId");
    if (reservation.state !== "reserved" || time(reservation.data.expiresAt, "reservation.expiresAt") <= time(now, "now")) throw new Error("The ticket reservation is not active.");
    if ((await list(store, auth, "events", "checkout-command")).some((record) => record.data.reservationId === reservation.id && ["approved-pending-executor", "paid"].includes(record.state))) throw new Error("This reservation already has an active or paid checkout.");
    const ticketType = await owned(store, auth.userId, reservation.data.ticketTypeId, "events", "ticket-type", "ticketTypeId");
    const amountMinor = Number(ticketType.data.priceMinor) * Number(reservation.data.quantity);
    if (input.expectedAmountMinor !== amountMinor || input.currency !== ticketType.data.currency) throw new Error("The checkout total does not match the reserved ticket terms.");
    const command = { reservationId: reservation.id, amountMinor, currency: ticketType.data.currency, returnUrl: input.returnUrl, commandHash: extendedBusinessDigest({ reservationId: reservation.id, amountMinor, currency: ticketType.data.currency, returnUrl: input.returnUrl }) };
    if (!apply) return dryRunResult(action, [reservation, ticketType], { ...command });
    const checkout = await create(store, auth.userId, { moduleId: "events", recordType: "checkout-command", title: `Checkout · ${ticketType.title}`, state: "approved-pending-executor", data: { ...command, providerExecutionStarted: false, createdAt: now } });
    return output(action, [checkout], { checkoutId: checkout.id, ...command });
  }
  if (action.id === "record-payment") {
    const checkout = await owned(store, auth.userId, input.checkoutId, "events", "checkout-command", "checkoutId");
    const reservation = await owned(store, auth.userId, checkout.data.reservationId, "events", "ticket-reservation", "reservationId");
    if (checkout.state !== "approved-pending-executor" || reservation.state !== "reserved" || time(reservation.data.expiresAt, "reservation.expiresAt") <= time(now, "now")) throw new Error("The checkout reservation is no longer active and awaiting its first payment receipt.");
    if (input.amountMinor !== checkout.data.amountMinor || input.currency !== checkout.data.currency) throw new Error("The payment receipt does not match the checkout total.");
    if ((await list(store, auth, "events", "payment-receipt")).some((record) => record.data.reservationId === reservation.id || (record.data.provider === input.provider && record.data.providerReceiptId === input.providerReceiptId))) throw new Error("The reservation or provider payment receipt is already recorded.");
    const paidAt = iso(input.paidAt, "paidAt");
    if (time(paidAt, "paidAt") > time(now, "now")) throw new Error("A payment receipt cannot be recorded before its provider clock.");
    if (!apply) return dryRunResult(action, [checkout, reservation], { checkoutId: checkout.id, receiptMatchesExpectedTotal: true, externalEvidenceVerified: false });
    const gatewayVerification = await verifyExternalEvidence(deps, auth, action, "event-payment", { checkoutId: checkout.id, reservationId: reservation.id, provider: input.provider, providerReceiptId: input.providerReceiptId, amountMinor: input.amountMinor, currency: input.currency, paidAt }, now, input.externalEvidenceToken);
    const receipt = await create(store, auth.userId, { moduleId: "events", recordType: "payment-receipt", title: `Payment · ${checkout.title}`, state: "verified", data: { checkoutId: checkout.id, reservationId: reservation.id, provider: input.provider, providerReceiptId: input.providerReceiptId, amountMinor: input.amountMinor, currency: input.currency, paidAt, gatewayVerification, recordedAt: now } });
    const paidCheckout = await update(store, auth.userId, checkout.id, { state: "paid", data: { paymentReceiptId: receipt.id, paidAt: receipt.data.paidAt } });
    const paidReservation = await update(store, auth.userId, reservation.id, { state: "paid", data: { paymentReceiptId: receipt.id } });
    return output(action, [paidCheckout, paidReservation, receipt], { paymentReceiptId: receipt.id, gatewayVerification, providerCallStarted: false });
  }
  if (action.id === "issue-ticket") {
    const receipt = await owned(store, auth.userId, input.paymentReceiptId, "events", "payment-receipt", "paymentReceiptId");
    const reservation = await owned(store, auth.userId, input.reservationId, "events", "ticket-reservation", "reservationId");
    if (receipt.data.reservationId !== reservation.id || reservation.state !== "paid") throw new Error("The paid receipt does not authorize this reservation.");
    const ordinal = integer(input.ordinal, "ordinal");
    if (ordinal > Number(reservation.data.quantity)) throw new Error("The ticket ordinal exceeds the paid reservation quantity.");
    const existing = (await list(store, auth, "events", "ticket")).find((record) => record.data.reservationId === reservation.id && record.data.ordinal === ordinal);
    if (existing) throw new Error("That reservation ordinal already has a ticket.");
    if (!apply) return dryRunResult(action, [receipt, reservation], { reservationId: reservation.id, ordinal, attendeeRef: input.attendeeRef });
    const ticket = await create(store, auth.userId, { moduleId: "events", recordType: "ticket", title: `Ticket ${ordinal} · ${reservation.title}`, state: "issued", data: { eventId: reservation.data.eventId, reservationId: reservation.id, paymentReceiptId: receipt.id, attendeeRef: input.attendeeRef, ordinal, version: 1, issuedAt: now, accessDecisionReceiptId: (input.approval as HumanApproval).decisionId } });
    return output(action, [ticket], { ticketId: ticket.id, accessState: "issued" });
  }
  if (action.id === "request-refund") {
    const ticket = await owned(store, auth.userId, input.ticketId, "events", "ticket", "ticketId");
    if (!["issued", "checked-in"].includes(ticket.state)) throw new Error("This ticket is not refundable.");
    const request = await create(store, auth.userId, { moduleId: "events", recordType: "refund-request", title: `Refund · ${ticket.title}`, state: "pending-human-review", data: { ticketId: ticket.id, reason: input.reason, requestedAmountMinor: input.requestedAmountMinor, requestedAt: now } });
    return output(action, [request], { refundRequestId: request.id, moneyChanged: false, accessChanged: false });
  }
  if (action.id === "record-refund") {
    const request = await owned(store, auth.userId, input.refundRequestId, "events", "refund-request", "refundRequestId");
    const ticket = await owned(store, auth.userId, request.data.ticketId, "events", "ticket", "ticketId");
    const payment = await owned(store, auth.userId, ticket.data.paymentReceiptId, "events", "payment-receipt", "paymentReceiptId");
    const reservation = await owned(store, auth.userId, ticket.data.reservationId, "events", "ticket-reservation", "reservationId");
    const ticketType = await owned(store, auth.userId, reservation.data.ticketTypeId, "events", "ticket-type", "ticketTypeId");
    if (request.state !== "pending-human-review" || ticket.state === "refunded") throw new Error("The refund request is no longer actionable.");
    if (input.amountMinor !== request.data.requestedAmountMinor || input.currency !== payment.data.currency || Number(input.amountMinor) > Number(ticketType.data.priceMinor)) throw new Error("The refund receipt does not match the approved request and ticket price.");
    if ((await list(store, auth, "events", "refund-receipt")).some((record) => record.data.provider === input.provider && record.data.providerReceiptId === input.providerReceiptId)) throw new Error("The provider refund receipt is already recorded.");
    const refundedAt = iso(input.refundedAt, "refundedAt");
    if (time(refundedAt, "refundedAt") > time(now, "now")) throw new Error("A refund receipt cannot be recorded before its provider clock.");
    if (!apply) return dryRunResult(action, [request, ticket, payment], { refundRequestId: request.id, ticketId: ticket.id, receiptMatchesApprovedRequest: true, externalEvidenceVerified: false });
    const gatewayVerification = await verifyExternalEvidence(deps, auth, action, "event-refund", { refundRequestId: request.id, ticketId: ticket.id, provider: input.provider, providerReceiptId: input.providerReceiptId, amountMinor: input.amountMinor, currency: input.currency, refundedAt }, now, input.externalEvidenceToken);
    const receipt = await create(store, auth.userId, { moduleId: "events", recordType: "refund-receipt", title: `Refund receipt · ${ticket.title}`, state: "verified", data: { refundRequestId: request.id, ticketId: ticket.id, provider: input.provider, providerReceiptId: input.providerReceiptId, amountMinor: input.amountMinor, currency: input.currency, refundedAt, gatewayVerification, recordedAt: now } });
    const refunded = await update(store, auth.userId, ticket.id, { state: "refunded", data: { refundReceiptId: receipt.id, accessRevokedAt: now, version: version(ticket) + 1 } });
    const completed = await update(store, auth.userId, request.id, { state: "completed", data: { refundReceiptId: receipt.id, completedAt: now } });
    return output(action, [refunded, completed, receipt], { refundReceiptId: receipt.id, gatewayVerification, accessState: "revoked" });
  }
  if (action.id === "check-in") {
    const ticket = await owned(store, auth.userId, input.ticketId, "events", "ticket", "ticketId");
    if (ticket.state !== "issued") throw new Error("Only an issued unused ticket can check in.");
    if ((await list(store, auth, "events", "check-in-receipt")).some((record) => record.data.scannerReceiptId === input.scannerReceiptId)) throw new Error("The scanner receipt is already recorded.");
    const checkedInAt = iso(input.checkedInAt, "checkedInAt");
    if (time(checkedInAt, "checkedInAt") > time(now, "now")) throw new Error("A check-in receipt cannot be recorded before its scanner clock.");
    if (!apply) return dryRunResult(action, [ticket], { ticketId: ticket.id, gate: input.gate, accessWouldBeGranted: true, externalEvidenceVerified: false });
    const gatewayVerification = await verifyExternalEvidence(deps, auth, action, "event-check-in", { ticketId: ticket.id, gate: input.gate, checkedInAt, scannerReceiptId: input.scannerReceiptId }, now, input.externalEvidenceToken);
    const receipt = await create(store, auth.userId, { moduleId: "events", recordType: "check-in-receipt", title: `Check-in · ${ticket.title}`, state: "verified", data: { ticketId: ticket.id, gate: input.gate, checkedInAt, scannerReceiptId: input.scannerReceiptId, accessDecisionId: (input.approval as HumanApproval).decisionId, gatewayVerification } });
    const checked = await update(store, auth.userId, ticket.id, { state: "checked-in", data: { checkInReceiptId: receipt.id, checkedInAt: receipt.data.checkedInAt, version: version(ticket) + 1 } });
    return output(action, [checked, receipt], { checkInReceiptId: receipt.id, gatewayVerification, accessGranted: true });
  }
  throw new Error("The GatherLedger action is not implemented.");
}

async function people(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, input: Record<string, unknown>, now: string, apply: boolean, deps: ExtendedBusinessEngineDependencies) {
  if (action.id === "create-profile") {
    await workspaceIdentity(store, auth, input.employeeRef, "employeeRef");
    await workspaceIdentity(store, auth, input.managerRef, "managerRef");
    if ((await list(store, auth, "people", "people-profile")).some((record) => record.data.employeeRef === input.employeeRef)) throw new Error("The employee reference already exists.");
    const profile = await create(store, auth.userId, { moduleId: "people", recordType: "people-profile", title: String(input.displayName), state: "active", data: { ...input, idempotencyKey: undefined, version: 1, createdAt: now } });
    return output(action, [profile], { profileId: profile.id });
  }
  if (action.id === "start-onboarding") {
    const profile = await owned(store, auth.userId, input.profileId, "people", "people-profile", "profileId");
    await workspaceIdentity(store, auth, input.ownerRef, "ownerRef");
    if (profile.state !== "active") throw new Error("Only an active profile can begin onboarding.");
    if (!apply) return dryRunResult(action, [profile], { profileId: profile.id, checklistItems: (input.checklist as unknown[]).length });
    const onboarding = await create(store, auth.userId, { moduleId: "people", recordType: "onboarding", title: `Onboarding · ${profile.title}`, state: "active", data: { profileId: profile.id, subjectUserId: profile.data.employeeRef, managerRef: profile.data.managerRef, profilePrivacy: profile.data.privacy, ownerRef: input.ownerRef, dueAt: iso(input.dueAt, "dueAt"), checklist: input.checklist, startedAt: now, employmentDecisionMade: false } });
    return output(action, [onboarding], { onboardingId: onboarding.id });
  }
  if (action.id === "publish-policy") {
    if (extendedBusinessTextDigest(String(input.content)) !== input.contentHash) throw new Error("The policy content hash does not match the exact content.");
    if (!apply) return dryRunResult(action, [], { key: input.key, contentHash: input.contentHash, effectiveAt: iso(input.effectiveAt, "effectiveAt") });
    const revisions = (await list(store, auth, "people", "people-policy")).filter((record) => record.data.key === input.key);
    const policy = await create(store, auth.userId, { moduleId: "people", recordType: "people-policy", title: String(input.title), state: "published", data: { key: input.key, content: input.content, contentHash: input.contentHash, effectiveAt: iso(input.effectiveAt, "effectiveAt"), audience: input.audience, revision: revisions.length + 1, publishedAt: now } });
    return output(action, [policy], { policyId: policy.id, revision: policy.data.revision });
  }
  if (action.id === "acknowledge-policy") {
    const policy = await owned(store, auth.userId, input.policyId, "people", "people-policy", "policyId");
    const profile = await owned(store, auth.userId, input.profileId, "people", "people-profile", "profileId");
    if (profile.data.employeeRef !== auth.userId) throw new Error("Only the authenticated person represented by this profile can acknowledge its policy.");
    if (policy.state !== "published" || policy.data.contentHash !== input.contentHash) throw new Error("The acknowledgement does not match the published policy.");
    if (time(input.acknowledgedAt, "acknowledgedAt") > time(now, "now")) throw new Error("A policy acknowledgement cannot be recorded before the subject interaction.");
    if ((await list(store, auth, "people", "policy-acknowledgement")).some((record) => record.data.subjectUserId === profile.data.employeeRef && record.data.subjectReceiptId === input.subjectReceiptId)) throw new Error("The subject acknowledgement receipt is already recorded for this person.");
    const acknowledgement = await create(store, auth.userId, { moduleId: "people", recordType: "policy-acknowledgement", title: `Acknowledgement · ${policy.title} · ${profile.title}`, state: "verified", data: { policyId: policy.id, profileId: profile.id, subjectUserId: profile.data.employeeRef, managerRef: profile.data.managerRef, profilePrivacy: profile.data.privacy, contentHash: input.contentHash, acknowledgedAt: iso(input.acknowledgedAt, "acknowledgedAt"), subjectReceiptId: input.subjectReceiptId } });
    return output(action, [acknowledgement], { acknowledgementId: acknowledgement.id, subjectProvided: true });
  }
  if (action.id === "request-leave") {
    const profile = await owned(store, auth.userId, input.profileId, "people", "people-profile", "profileId");
    if (profile.data.employeeRef !== auth.userId) throw new Error("Only the authenticated person represented by this profile can request its leave.");
    if (profile.state !== "active" || String(input.endsOn) < String(input.startsOn)) throw new Error("The leave request dates or profile state are invalid.");
    if ((await list(store, auth, "people", "leave-request")).some((record) => record.data.subjectUserId === profile.data.employeeRef && record.data.subjectReceiptId === input.subjectReceiptId)) throw new Error("The subject leave request receipt is already recorded for this person.");
    const request = await create(store, auth.userId, { moduleId: "people", recordType: "leave-request", title: `Leave · ${profile.title}`, state: "pending-human-decision", data: { profileId: profile.id, subjectUserId: profile.data.employeeRef, managerRef: profile.data.managerRef, profilePrivacy: profile.data.privacy, leaveKind: input.leaveKind, startsOn: input.startsOn, endsOn: input.endsOn, note: input.note, subjectReceiptId: input.subjectReceiptId, requestedAt: now } });
    return output(action, [request], { requestId: request.id, employmentDecisionMade: false });
  }
  if (action.id === "decide-leave") {
    const request = await owned(store, auth.userId, input.requestId, "people", "leave-request", "requestId");
    if (request.state !== "pending-human-decision") throw new Error("The leave request already has a decision.");
    if ((await list(store, auth, "people", "leave-decision")).some((record) => record.data.decisionReceiptId === input.decisionReceiptId)) throw new Error("The employment decision receipt is already recorded.");
    if (!apply) return dryRunResult(action, [request], { requestId: request.id, decision: input.decision });
    const decision = await create(store, auth.userId, { moduleId: "people", recordType: "leave-decision", title: `Leave decision · ${request.title}`, state: String(input.decision), data: { requestId: request.id, subjectUserId: request.data.subjectUserId, managerRef: request.data.managerRef, profilePrivacy: request.data.profilePrivacy, decision: input.decision, rationale: input.rationale, decisionReceiptId: input.decisionReceiptId, decidedBy: auth.userId, decidedAt: now } });
    const decided = await update(store, auth.userId, request.id, { state: String(input.decision), data: { decisionId: decision.id, decidedAt: now } });
    return output(action, [decided, decision], { decisionId: decision.id, humanDecision: true });
  }
  if (action.id === "record-attendance") {
    const profile = await owned(store, auth.userId, input.profileId, "people", "people-profile", "profileId");
    if (input.source === "subject-entry" && profile.data.employeeRef !== auth.userId) throw new Error("A subject-entered attendance interval must be submitted by the authenticated person represented by this profile.");
    if (input.source !== "subject-entry" && roleRank[auth.role] < roleRank.admin) throw new Error("Approved imports and time-clock attendance require an administrator.");
    if (time(input.clockOutAt, "clockOutAt") <= time(input.clockInAt, "clockInAt")) throw new Error("Attendance clock-out must follow clock-in.");
    if (time(input.clockOutAt, "clockOutAt") > time(now, "now")) throw new Error("Attendance cannot be recorded before its clock-out.");
    if ((await list(store, auth, "people", "attendance")).some((record) => record.data.subjectUserId === profile.data.employeeRef && record.data.sourceReceiptId === input.sourceReceiptId)) throw new Error("The attendance source receipt is already recorded for this person.");
    const attendance = await create(store, auth.userId, { moduleId: "people", recordType: "attendance", title: `Attendance · ${profile.title}`, state: "recorded", data: { profileId: profile.id, subjectUserId: profile.data.employeeRef, managerRef: profile.data.managerRef, profilePrivacy: profile.data.privacy, clockInAt: iso(input.clockInAt, "clockInAt"), clockOutAt: iso(input.clockOutAt, "clockOutAt"), source: input.source, sourceReceiptId: input.sourceReceiptId, version: 1, recordedAt: now } });
    return output(action, [attendance], { attendanceId: attendance.id });
  }
  if (action.id === "correct-attendance") {
    const attendance = await owned(store, auth.userId, input.attendanceId, "people", "attendance", "attendanceId");
    const next = nextVersion(attendance, input);
    if (time(input.clockOutAt, "clockOutAt") <= time(input.clockInAt, "clockInAt")) throw new Error("Corrected clock-out must follow clock-in.");
    if (time(input.clockOutAt, "clockOutAt") > time(now, "now")) throw new Error("Attendance cannot be corrected before its clock-out.");
    if ((await list(store, auth, "people", "attendance-correction")).some((record) => record.data.correctionReceiptId === input.correctionReceiptId)) throw new Error("The attendance correction receipt is already recorded.");
    if (!apply) return dryRunResult(action, [attendance], { attendanceId: attendance.id, nextVersion: next });
    const correction = await create(store, auth.userId, { moduleId: "people", recordType: "attendance-correction", title: `Correction · ${attendance.title}`, state: "approved", data: { attendanceId: attendance.id, subjectUserId: attendance.data.subjectUserId, managerRef: attendance.data.managerRef, profilePrivacy: attendance.data.profilePrivacy, priorClockInAt: attendance.data.clockInAt, priorClockOutAt: attendance.data.clockOutAt, correctedClockInAt: iso(input.clockInAt, "clockInAt"), correctedClockOutAt: iso(input.clockOutAt, "clockOutAt"), reason: input.reason, correctionReceiptId: input.correctionReceiptId, approvedBy: auth.userId, correctedAt: now } });
    const corrected = await update(store, auth.userId, attendance.id, { state: "corrected", data: { clockInAt: correction.data.correctedClockInAt, clockOutAt: correction.data.correctedClockOutAt, version: next, latestCorrectionId: correction.id } });
    return output(action, [corrected, correction], { correctionId: correction.id, originalPreserved: true });
  }
  if (action.id === "open-review") {
    const profile = await owned(store, auth.userId, input.profileId, "people", "people-profile", "profileId");
    await workspaceIdentity(store, auth, input.reviewerRef, "reviewerRef");
    const rubricKeys = (input.rubric as Array<Record<string, unknown>>).map((criterion) => String(criterion.key));
    if (new Set(rubricKeys).size !== rubricKeys.length) throw new Error("Review rubric criterion keys must be unique.");
    const duplicate = (await list(store, auth, "people", "people-review")).some((record) => record.data.profileId === profile.id && record.data.cycleKey === input.cycleKey);
    if (duplicate) throw new Error("This profile already has a review in the cycle.");
    const review = await create(store, auth.userId, { moduleId: "people", recordType: "people-review", title: `Review ${input.cycleKey} · ${profile.title}`, state: "open", data: { profileId: profile.id, subjectUserId: profile.data.employeeRef, managerRef: profile.data.managerRef, profilePrivacy: profile.data.privacy, cycleKey: input.cycleKey, reviewerRef: input.reviewerRef, dueAt: iso(input.dueAt, "dueAt"), rubric: input.rubric, openedAt: now } });
    return output(action, [review], { reviewId: review.id });
  }
  if (action.id === "submit-review") {
    const review = await owned(store, auth.userId, input.reviewId, "people", "people-review", "reviewId");
    if (review.state !== "open" || review.data.reviewerRef !== input.submittedBy || input.submittedBy !== auth.userId) throw new Error("Only the authenticated named reviewer can submit this open review.");
    const rubricKeys = (review.data.rubric as Array<Record<string, unknown>>).map((criterion) => String(criterion.key));
    const responseKeys = (input.responses as Array<Record<string, unknown>>).map((response) => String(response.criterionKey));
    if (new Set(responseKeys).size !== responseKeys.length || responseKeys.length !== rubricKeys.length || responseKeys.some((key) => !rubricKeys.includes(key))) throw new Error("Review responses must cover every rubric criterion exactly once.");
    if ((await list(store, auth, "people", "review-submission")).some((record) => record.data.submissionReceiptId === input.submissionReceiptId)) throw new Error("The review submission receipt is already recorded.");
    await ownedMany(store, auth.userId, input.evidenceIds, undefined, undefined, "evidenceIds");
    const submission = await create(store, auth.userId, { moduleId: "people", recordType: "review-submission", title: `Submission · ${review.title}`, state: "submitted", data: { reviewId: review.id, subjectUserId: review.data.subjectUserId, managerRef: review.data.managerRef, profilePrivacy: review.data.profilePrivacy, reviewerRef: review.data.reviewerRef, submittedBy: input.submittedBy, responses: input.responses, evidenceIds: input.evidenceIds, submissionReceiptId: input.submissionReceiptId, submittedAt: now, modelAuthored: false } });
    const completed = await update(store, auth.userId, review.id, { state: "submitted", data: { submissionId: submission.id, submittedAt: now } });
    return output(action, [completed, submission], { submissionId: submission.id, humanAuthored: true });
  }
  if (action.id === "record-access-revocation") {
    const profile = await owned(store, auth.userId, input.profileId, "people", "people-profile", "profileId");
    if ((await list(store, auth, "people", "access-revocation-receipt")).some((record) => record.data.sourceReceiptId === input.sourceReceiptId)) throw new Error("The source access-revocation receipt is already recorded.");
    const revokedAt = iso(input.revokedAt, "revokedAt");
    if (time(revokedAt, "revokedAt") > time(now, "now")) throw new Error("Access revocation cannot be recorded before its source-system clock.");
    if (!apply) return dryRunResult(action, [profile], { profileId: profile.id, system: input.system, accountRef: input.accountRef, revokedAt, externalEvidenceVerified: false });
    const gatewayVerification = await verifyExternalEvidence(deps, auth, action, "people-access-revocation", { profileId: profile.id, subjectUserId: profile.data.employeeRef, system: input.system, accountRef: input.accountRef, sourceReceiptId: input.sourceReceiptId, revokedAt }, now, input.externalEvidenceToken);
    const receipt = await create(store, auth.userId, { moduleId: "people", recordType: "access-revocation-receipt", title: `Access revoked · ${input.system} · ${profile.title}`, state: "verified", data: { profileId: profile.id, subjectUserId: profile.data.employeeRef, managerRef: profile.data.managerRef, profilePrivacy: profile.data.privacy, system: input.system, accountRef: input.accountRef, sourceReceiptId: input.sourceReceiptId, revokedAt, gatewayVerification, verifiedBy: auth.userId, verifiedAt: now } });
    return output(action, [receipt], { accessRevocationReceiptId: receipt.id, profileId: profile.id, gatewayVerification, verified: true });
  }
  if (action.id === "offboard") {
    const profile = await owned(store, auth.userId, input.profileId, "people", "people-profile", "profileId");
    if (profile.state !== "active") throw new Error("Offboarding requires an active profile.");
    const accessReceipts = await ownedMany(store, auth.userId, input.accessRevocationReceiptIds, "people", "access-revocation-receipt", "accessRevocationReceiptIds");
    const effectiveAt = iso(input.effectiveAt, "effectiveAt");
    if (time(effectiveAt, "effectiveAt") > time(now, "now")) throw new Error("Future offboarding requires a separate scheduled executor; this action only closes access that is already effective.");
    if (!accessReceipts.length || accessReceipts.some((receipt) => receipt.state !== "verified" || receipt.data.profileId !== profile.id || receipt.data.subjectUserId !== profile.data.employeeRef || !receipt.data.gatewayVerification || time(receipt.data.revokedAt, "revocation.revokedAt") > time(effectiveAt, "effectiveAt"))) throw new Error("Every access-revocation receipt must be hosting-layer verified, bound to the exact profile, and effective by the offboarding clock.");
    const subjectMembership = (await store.listWorkspaceMembers(auth.userId)).find((member) => member.userId === profile.data.employeeRef);
    if (!subjectMembership || subjectMembership.role === "owner") throw new Error("Offboarding requires an active non-owner workspace membership that can be revoked atomically.");
    if (!apply) return dryRunResult(action, [profile, ...accessReceipts], { profileId: profile.id, effectiveAt, accessReceiptCount: accessReceipts.length, workspaceMembershipWouldBeRemoved: true });
    const humanApproval = input.approval as HumanApproval;
    if (input.employmentDecisionReceiptId !== humanApproval.decisionId) throw new Error("Offboarding requires the exact attributable employment approval decision ID.");
    const receipt = await create(store, auth.userId, { moduleId: "people", recordType: "offboarding-receipt", title: `Offboarding · ${profile.title}`, state: "verified", data: { profileId: profile.id, subjectUserId: profile.data.employeeRef, managerRef: profile.data.managerRef, profilePrivacy: profile.data.privacy, effectiveAt, reason: input.reason, employmentDecisionReceiptId: humanApproval.decisionId, accessRevocationReceiptIds: accessReceipts.map((record) => record.id), accessReceiptSnapshotHashes: Object.fromEntries(accessReceipts.map((record) => [record.id, extendedBusinessDigest(record)])), approvedBy: auth.userId, workspaceMembershipRemoved: true, recordedAt: now } });
    const offboarded = await update(store, auth.userId, profile.id, { state: "offboarded", data: { offboardingReceiptId: receipt.id, effectiveAt: receipt.data.effectiveAt, version: version(profile) + 1 } });
    if (!(await store.removeWorkspaceMember(auth.userId, String(profile.data.employeeRef)))) throw new Error("The workspace membership could not be revoked atomically.");
    return output(action, [offboarded, receipt, ...accessReceipts], { offboardingReceiptId: receipt.id, accessReceiptsVerified: accessReceipts.length, workspaceMembershipRemoved: true });
  }
  throw new Error("The PeopleWeave action is not implemented.");
}

function meterQuantity(meter: SuiteRecord, events: SuiteRecord[]) {
  if (meter.data.aggregation === "count") return events.length;
  if (meter.data.aggregation === "maximum") return events.reduce((maximum, event) => Math.max(maximum, Number(event.data.quantity)), 0);
  if (meter.data.aggregation === "last") return events.sort((left, right) => String(left.data.occurredAt).localeCompare(String(right.data.occurredAt))).at(-1)?.data.quantity ?? 0;
  return events.reduce((sum, event) => sum + Number(event.data.quantity), 0);
}

function chargePreview(plan: SuiteRecord, aggregates: SuiteRecord[]) {
  const quantity = aggregates.reduce((sum, aggregate) => sum + Number(aggregate.data.quantity), 0);
  if (!Number.isFinite(quantity) || Math.abs(quantity) > Number.MAX_SAFE_INTEGER) throw new Error("The aggregate quantity exceeds the reproducible numeric boundary.");
  const baseFeeMinor = Number(plan.data.baseFeeMinor);
  const usageFeeRaw = Number(plan.data.unitPriceMinor) * quantity;
  if (!Number.isFinite(usageFeeRaw) || Math.abs(usageFeeRaw) > Number.MAX_SAFE_INTEGER) throw new Error("The usage charge exceeds safe minor-unit arithmetic.");
  const usageFeeMinor = Math.round(usageFeeRaw);
  const subtotalMinor = baseFeeMinor + usageFeeMinor;
  if (!Number.isSafeInteger(baseFeeMinor) || !Number.isSafeInteger(usageFeeMinor) || !Number.isSafeInteger(subtotalMinor)) throw new Error("The charge cannot be represented exactly in integer minor units.");
  const preview = { planId: plan.id, planHash: plan.data.contentHash, aggregateIds: aggregates.map((record) => record.id).sort(), quantity, baseFeeMinor, usageFeeMinor, subtotalMinor, currency: plan.data.currency, rounding: "nearest-minor-unit" };
  return { ...preview, previewHash: extendedBusinessDigest(preview) };
}

function assertNonOverlappingAggregates(aggregates: SuiteRecord[]) {
  const groups = new Map<string, SuiteRecord[]>();
  for (const aggregate of aggregates) {
    const key = `${aggregate.data.meterId}\u0000${aggregate.data.subjectRef}`;
    groups.set(key, [...(groups.get(key) ?? []), aggregate]);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => time(left.data.periodStart, "aggregate.periodStart") - time(right.data.periodStart, "aggregate.periodStart"));
    for (let index = 1; index < ordered.length; index += 1) if (time(ordered[index]!.data.periodStart, "aggregate.periodStart") < time(ordered[index - 1]!.data.periodEnd, "aggregate.periodEnd")) throw new Error("Usage aggregates must not overlap for the same meter and subject.");
  }
}

async function metering(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, input: Record<string, unknown>, now: string, apply: boolean, deps: ExtendedBusinessEngineDependencies) {
  if (action.id === "create-meter") {
    if ((await list(store, auth, "metering", "usage-meter")).some((record) => record.data.key === input.key)) throw new Error("The usage meter key already exists.");
    const meter = await create(store, auth.userId, { moduleId: "metering", recordType: "usage-meter", title: String(input.name), state: "active", data: { ...input, idempotencyKey: undefined, dimensionKeys: strings(input.dimensionKeys, "dimensionKeys"), version: 1, createdAt: now } });
    return output(action, [meter], { meterId: meter.id });
  }
  if (action.id === "ingest-event") {
    const meter = await owned(store, auth.userId, input.meterId, "metering", "usage-meter", "meterId");
    if ((await list(store, auth, "metering", "usage-event")).some((record) => record.data.sourceEventId === input.sourceEventId)) throw new Error("The source usage event is already recorded.");
    const dimensions = object(input.dimensions, "dimensions");
    const allowed = new Set(meter.data.dimensionKeys as string[]);
    if (Object.keys(dimensions).some((key) => !allowed.has(key)) || Object.values(dimensions).some((value) => !["string", "number", "boolean"].includes(typeof value))) throw new Error("Usage dimensions must be allowlisted scalar values.");
    const quantity = numeric(input.quantity, "quantity");
    const occurredAt = iso(input.occurredAt, "occurredAt");
    if (time(occurredAt, "occurredAt") > time(now, "now")) throw new Error("Usage cannot be recorded before its source occurrence clock.");
    const gatewayVerification = await verifyExternalEvidence(deps, auth, action, "metering-usage-event", { meterId: meter.id, sourceEventId: input.sourceEventId, subjectRef: input.subjectRef, quantity, occurredAt, dimensions, sourceAttestation: input.sourceAttestation }, now, input.externalEvidenceToken);
    const event = await create(store, auth.userId, { moduleId: "metering", recordType: "usage-event", title: `${meter.title} · ${input.sourceEventId}`, state: "recorded", data: { meterId: meter.id, sourceEventId: input.sourceEventId, subjectRef: input.subjectRef, quantity, occurredAt, dimensions, sourceAttestation: input.sourceAttestation, gatewayVerification, recordedAt: now } });
    return output(action, [event], { eventId: event.id, gatewayVerification });
  }
  if (action.id === "aggregate-usage") {
    const meter = await owned(store, auth.userId, input.meterId, "metering", "usage-meter", "meterId");
    const start = time(input.periodStart, "periodStart");
    const end = time(input.periodEnd, "periodEnd");
    if (end <= start) throw new Error("The usage period must be non-empty.");
    const events = (await list(store, auth, "metering", "usage-event")).filter((record) => record.data.meterId === meter.id && record.data.subjectRef === input.subjectRef && time(record.data.occurredAt, "event.occurredAt") >= start && time(record.data.occurredAt, "event.occurredAt") < end);
    if (!events.length) throw new Error("No usage events match the aggregate period.");
    const eventIds = events.map((record) => record.id).sort();
    const quantity = Number(meterQuantity(meter, [...events]));
    if (!Number.isFinite(quantity) || Math.abs(quantity) > Number.MAX_SAFE_INTEGER) throw new Error("The frozen aggregate exceeds the reproducible numeric boundary.");
    const aggregateHash = extendedBusinessDigest({ meterId: meter.id, subjectRef: input.subjectRef, periodStart: iso(input.periodStart, "periodStart"), periodEnd: iso(input.periodEnd, "periodEnd"), eventIds, quantity, aggregation: meter.data.aggregation });
    const duplicate = (await list(store, auth, "metering", "usage-aggregate")).find((record) => record.data.aggregateHash === aggregateHash);
    if (duplicate) return output(action, [duplicate], { aggregateId: duplicate.id, quantity, identicalAggregate: true });
    const aggregate = await create(store, auth.userId, { moduleId: "metering", recordType: "usage-aggregate", title: `${meter.title} · ${input.subjectRef}`, state: "frozen", data: { meterId: meter.id, subjectRef: input.subjectRef, periodStart: iso(input.periodStart, "periodStart"), periodEnd: iso(input.periodEnd, "periodEnd"), aggregation: meter.data.aggregation, eventIds, quantity, aggregateHash, frozenAt: now } });
    return output(action, [aggregate], { aggregateId: aggregate.id, quantity, aggregateHash });
  }
  if (action.id === "publish-plan") {
    const meter = await owned(store, auth.userId, input.meterId, "metering", "usage-meter", "meterId");
    const terms = { key: input.key, name: input.name, currency: input.currency, interval: input.interval, meterId: meter.id, baseFeeMinor: input.baseFeeMinor, unitPriceMinor: input.unitPriceMinor };
    const expectedHash = extendedBusinessDigest(terms);
    if (!apply) return dryRunResult(action, [meter], { expectedContentHash: expectedHash, terms });
    if (input.contentHash !== expectedHash) throw new Error("The billing-plan content hash does not match the exact terms.");
    if ((await list(store, auth, "metering", "billing-plan")).some((record) => record.data.key === input.key && record.state === "published")) throw new Error("The published billing-plan key already exists.");
    const plan = await create(store, auth.userId, { moduleId: "metering", recordType: "billing-plan", title: String(input.name), state: "published", data: { ...terms, contentHash: expectedHash, version: 1, publishedAt: now } });
    return output(action, [plan], { planId: plan.id, contentHash: expectedHash });
  }
  if (action.id === "preview-charge") {
    const plan = await owned(store, auth.userId, input.planId, "metering", "billing-plan", "planId");
    const aggregates = await ownedMany(store, auth.userId, input.aggregateIds, "metering", "usage-aggregate", "aggregateIds");
    if (aggregates.some((aggregate) => aggregate.data.meterId !== plan.data.meterId)) throw new Error("Every aggregate must use the plan meter.");
    assertNonOverlappingAggregates(aggregates);
    return output(action, [plan, ...aggregates], chargePreview(plan, aggregates), "read");
  }
  if (action.id === "create-subscription") {
    const plan = await owned(store, auth.userId, input.planId, "metering", "billing-plan", "planId");
    if (plan.state !== "published") throw new Error("Subscriptions require a published plan.");
    if (!apply) return dryRunResult(action, [plan], { planId: plan.id, subjectRef: input.subjectRef, agreementReceiptId: input.agreementReceiptId });
    const subscription = await create(store, auth.userId, { moduleId: "metering", recordType: "billing-subscription", title: `${plan.title} · ${input.subjectRef}`, state: "active", data: { planId: plan.id, planHash: plan.data.contentHash, subjectRef: input.subjectRef, startsAt: iso(input.startsAt, "startsAt"), billingAnchorDay: input.billingAnchorDay, agreementReceiptId: input.agreementReceiptId, version: 1, createdAt: now } });
    return output(action, [subscription], { subscriptionId: subscription.id });
  }
  if (action.id === "grant-credit") {
    const subscription = await owned(store, auth.userId, input.subscriptionId, "metering", "billing-subscription", "subscriptionId");
    const plan = await owned(store, auth.userId, subscription.data.planId, "metering", "billing-plan", "planId");
    if (input.currency !== plan.data.currency) throw new Error("The credit currency must match the subscription plan.");
    if ((await list(store, auth, "metering", "credit-grant")).some((record) => record.data.creditReceiptId === input.creditReceiptId)) throw new Error("The credit approval receipt is already recorded.");
    if (!apply) return dryRunResult(action, [subscription, plan], { subscriptionId: subscription.id, amountMinor: input.amountMinor, currency: input.currency });
    const credit = await create(store, auth.userId, { moduleId: "metering", recordType: "credit-grant", title: `Credit · ${subscription.title}`, state: "available", data: { subscriptionId: subscription.id, amountMinor: input.amountMinor, remainingAmountMinor: input.amountMinor, currency: input.currency, reason: input.reason, creditReceiptId: input.creditReceiptId, version: 1, grantedAt: now } });
    return output(action, [credit], { creditId: credit.id });
  }
  if (action.id === "draft-invoice") {
    const subscription = await owned(store, auth.userId, input.subscriptionId, "metering", "billing-subscription", "subscriptionId");
    const plan = await owned(store, auth.userId, subscription.data.planId, "metering", "billing-plan", "planId");
    const aggregates = await ownedMany(store, auth.userId, input.aggregateIds, "metering", "usage-aggregate", "aggregateIds");
    assertNonOverlappingAggregates(aggregates);
    const periodStart = time(input.periodStart, "periodStart");
    const periodEnd = time(input.periodEnd, "periodEnd");
    if (periodEnd <= periodStart) throw new Error("The invoice period must be non-empty.");
    if (aggregates.some((aggregate) => aggregate.data.subjectRef !== subscription.data.subjectRef || aggregate.data.meterId !== plan.data.meterId)) throw new Error("Invoice aggregates must match the subscription subject and meter.");
    if (aggregates.some((aggregate) => time(aggregate.data.periodStart, "aggregate.periodStart") < periodStart || time(aggregate.data.periodEnd, "aggregate.periodEnd") > periodEnd)) throw new Error("Every invoice aggregate must fall within the invoice period.");
    if ((await list(store, auth, "metering", "billing-invoice")).some((record) => record.data.subscriptionId === subscription.id && record.data.periodStart === iso(input.periodStart, "periodStart") && record.data.periodEnd === iso(input.periodEnd, "periodEnd") && record.state !== "void")) throw new Error("An invoice already exists for this subscription period.");
    const preview = chargePreview(plan, aggregates);
    const credits = (await list(store, auth, "metering", "credit-grant"))
      .filter((record) => record.data.subscriptionId === subscription.id && record.state === "available" && Number(record.data.remainingAmountMinor ?? record.data.amountMinor) > 0)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    let remainingChargeMinor = preview.subtotalMinor;
    const creditAllocations: Array<{ creditId: string; amountMinor: number }> = [];
    for (const credit of credits) {
      if (remainingChargeMinor <= 0) break;
      const amountMinor = Math.min(remainingChargeMinor, Number(credit.data.remainingAmountMinor ?? credit.data.amountMinor));
      if (amountMinor > 0) creditAllocations.push({ creditId: credit.id, amountMinor });
      remainingChargeMinor -= amountMinor;
    }
    const appliedCreditMinor = creditAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    const totalMinor = preview.subtotalMinor - appliedCreditMinor;
    const totals = { subtotalMinor: preview.subtotalMinor, appliedCreditMinor, totalMinor, currency: preview.currency, quantity: preview.quantity, aggregateIds: preview.aggregateIds, creditAllocations };
    const totalsHash = extendedBusinessDigest(totals);
    const invoice = await create(store, auth.userId, { moduleId: "metering", recordType: "billing-invoice", title: `Invoice · ${subscription.title} · ${input.periodStart}`, state: "draft", data: { subscriptionId: subscription.id, planId: plan.id, planHash: plan.data.contentHash, periodStart: iso(input.periodStart, "periodStart"), periodEnd: iso(input.periodEnd, "periodEnd"), ...totals, totalsHash, version: 1, draftedAt: now } });
    return output(action, [invoice], { invoiceId: invoice.id, totalsHash, ...totals });
  }
  if (action.id === "finalize-invoice") {
    const invoice = await owned(store, auth.userId, input.invoiceId, "metering", "billing-invoice", "invoiceId");
    const next = nextVersion(invoice, input);
    if (invoice.state !== "draft" || input.totalsHash !== invoice.data.totalsHash) throw new Error("The invoice is not an exact current draft.");
    if (!apply) return dryRunResult(action, [invoice], { invoiceId: invoice.id, totalsHash: invoice.data.totalsHash, nextVersion: next });
    if (!Array.isArray(invoice.data.creditAllocations)) throw new Error("The invoice credit allocation snapshot is malformed.");
    const allocations = invoice.data.creditAllocations.map((value, index) => {
      const allocation = object(value, `creditAllocations[${index}]`);
      if (typeof allocation.creditId !== "string" || !Number.isSafeInteger(allocation.amountMinor) || Number(allocation.amountMinor) <= 0) throw new Error("The invoice credit allocation snapshot is malformed.");
      return { creditId: allocation.creditId, amountMinor: Number(allocation.amountMinor) };
    });
    const credits = await ownedMany(store, auth.userId, allocations.map((allocation) => allocation.creditId), "metering", "credit-grant", "creditAllocations");
    const appliedCredits: SuiteRecord[] = [];
    const applicationReceipts: SuiteRecord[] = [];
    for (const allocation of allocations) {
      const credit = credits.find((candidate) => candidate.id === allocation.creditId)!;
      const remainingAmountMinor = Number(credit.data.remainingAmountMinor ?? credit.data.amountMinor);
      if (credit.state !== "available" || !Number.isSafeInteger(remainingAmountMinor) || remainingAmountMinor < allocation.amountMinor) throw new Error("An invoice credit allocation is no longer fully available.");
      const nextRemainingAmountMinor = remainingAmountMinor - allocation.amountMinor;
      const application = await create(store, auth.userId, { moduleId: "metering", recordType: "credit-application-receipt", title: `Credit application · ${invoice.title}`, state: "applied", data: { creditId: credit.id, invoiceId: invoice.id, amountMinor: allocation.amountMinor, priorRemainingAmountMinor: remainingAmountMinor, remainingAmountMinor: nextRemainingAmountMinor, currency: invoice.data.currency, approvedBy: auth.userId, appliedAt: now } });
      applicationReceipts.push(application);
      appliedCredits.push(await update(store, auth.userId, credit.id, { state: nextRemainingAmountMinor === 0 ? "applied" : "available", data: { remainingAmountMinor: nextRemainingAmountMinor, latestApplicationReceiptId: application.id, version: version(credit) + 1 } }));
    }
    const finalized = await update(store, auth.userId, invoice.id, { state: "final", data: { version: next, finalizedAt: now, approvedBy: auth.userId } });
    return output(action, [finalized, ...appliedCredits, ...applicationReceipts], { invoiceId: invoice.id, totalMinor: invoice.data.totalMinor, currency: invoice.data.currency, appliedCreditMinor: invoice.data.appliedCreditMinor });
  }
  if (action.id === "record-payment") {
    const invoice = await owned(store, auth.userId, input.invoiceId, "metering", "billing-invoice", "invoiceId");
    if (invoice.state !== "final" || input.amountMinor !== invoice.data.totalMinor || input.currency !== invoice.data.currency) throw new Error("The payment receipt does not match the final invoice.");
    if ((await list(store, auth, "metering", "invoice-payment-receipt")).some((record) => record.data.provider === input.provider && record.data.providerReceiptId === input.providerReceiptId)) throw new Error("The invoice payment receipt is already recorded.");
    const paidAt = iso(input.paidAt, "paidAt");
    if (time(paidAt, "paidAt") > time(now, "now")) throw new Error("An invoice payment cannot be recorded before its provider clock.");
    if (!apply) return dryRunResult(action, [invoice], { invoiceId: invoice.id, receiptMatchesTotal: true, externalEvidenceVerified: false });
    const gatewayVerification = await verifyExternalEvidence(deps, auth, action, "metering-invoice-payment", { invoiceId: invoice.id, provider: input.provider, providerReceiptId: input.providerReceiptId, amountMinor: input.amountMinor, currency: input.currency, paidAt }, now, input.externalEvidenceToken);
    const receipt = await create(store, auth.userId, { moduleId: "metering", recordType: "invoice-payment-receipt", title: `Payment · ${invoice.title}`, state: "verified", data: { invoiceId: invoice.id, provider: input.provider, providerReceiptId: input.providerReceiptId, amountMinor: input.amountMinor, currency: input.currency, paidAt, gatewayVerification, recordedAt: now } });
    const paid = await update(store, auth.userId, invoice.id, { state: "paid", data: { paymentReceiptId: receipt.id, paidAt: receipt.data.paidAt, version: version(invoice) + 1 } });
    return output(action, [paid, receipt], { paymentReceiptId: receipt.id, gatewayVerification });
  }
  throw new Error("The MeterProof action is not implemented.");
}

async function assurance(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, input: Record<string, unknown>, now: string, apply: boolean) {
  if (action.id === "create-program") {
    if (String(input.periodEnd) < String(input.periodStart)) throw new Error("The assurance period is invalid.");
    if ((await list(store, auth, "assurance", "assurance-program")).some((record) => record.data.key === input.key)) throw new Error("The assurance program key already exists.");
    const program = await create(store, auth.userId, { moduleId: "assurance", recordType: "assurance-program", title: String(input.name), state: "active", data: { ...input, idempotencyKey: undefined, programOwnerRef: input.ownerRef, createdByUserId: auth.userId, version: 1, createdAt: now } });
    return output(action, [program], { programId: program.id });
  }
  if (action.id === "register-subject") {
    const program = await owned(store, auth.userId, input.programId, "assurance", "assurance-program", "programId");
    const subject = await create(store, auth.userId, { moduleId: "assurance", recordType: "assurance-subject", title: String(input.name), state: "registered", data: { ...assuranceLineage(program), kind: input.kind, ownerRef: input.ownerRef, classification: input.classification, subjectOwnerRef: input.ownerRef, subjectClassification: input.classification, assuranceClassification: input.classification, createdByUserId: auth.userId, registeredAt: now } });
    return output(action, [subject], { subjectId: subject.id });
  }
  if (action.id === "create-risk") {
    const program = await owned(store, auth.userId, input.programId, "assurance", "assurance-program", "programId");
    const subject = await owned(store, auth.userId, input.subjectId, "assurance", "assurance-subject", "subjectId");
    if (subject.data.programId !== program.id) throw new Error("The risk subject belongs to another program.");
    const score = integer(input.likelihood, "likelihood") * integer(input.impact, "impact");
    const risk = await create(store, auth.userId, { moduleId: "assurance", recordType: "assurance-risk", title: String(input.statement).slice(0, 160), state: "open", data: { ...assuranceLineage(subject), programId: program.id, subjectId: subject.id, statement: input.statement, likelihood: input.likelihood, impact: input.impact, score, ownerRef: input.ownerRef, createdByUserId: auth.userId, version: 1, createdAt: now } });
    return output(action, [risk], { riskId: risk.id, deterministicScore: score });
  }
  if (action.id === "publish-control") {
    const program = await owned(store, auth.userId, input.programId, "assurance", "assurance-program", "programId");
    const expectedHash = extendedBusinessDigest({ objective: input.objective, procedure: input.procedure });
    if (!apply) return dryRunResult(action, [program], { expectedContentHash: expectedHash, key: input.key });
    if (input.contentHash !== expectedHash) throw new Error("The control content hash does not match the objective and procedure.");
    if ((await list(store, auth, "assurance", "assurance-control")).some((record) => record.data.programId === program.id && record.data.key === input.key && record.state === "published")) throw new Error("The published control key already exists in this program.");
    const control = await create(store, auth.userId, { moduleId: "assurance", recordType: "assurance-control", title: String(input.title), state: "published", data: { ...assuranceLineage(program), key: input.key, objective: input.objective, procedure: input.procedure, ownerRef: input.ownerRef, controlOwnerRef: input.ownerRef, createdByUserId: auth.userId, contentHash: expectedHash, version: 1, publishedAt: now } });
    return output(action, [control], { controlId: control.id, contentHash: expectedHash });
  }
  if (action.id === "map-control") {
    const control = await owned(store, auth.userId, input.controlId, "assurance", "assurance-control", "controlId");
    const risks = await ownedMany(store, auth.userId, input.riskIds, "assurance", "assurance-risk", "riskIds");
    if (risks.some((risk) => risk.data.programId !== control.data.programId)) throw new Error("Every mapped risk must belong to the control program.");
    const subjectIds = [...new Set([...(Array.isArray(control.data.subjectIds) ? recordIdentityList(control.data.subjectIds, "Assurance subject IDs") : []), ...risks.map((risk) => recordIdentity(risk.data.subjectId, "Assurance subject"))])];
    const subjectOwnerRefs = [...new Set([...(Array.isArray(control.data.subjectOwnerRefs) ? recordIdentityList(control.data.subjectOwnerRefs, "Assurance subject owners") : []), ...risks.map((risk) => recordIdentity(risk.data.subjectOwnerRef, "Assurance subject owner"))])];
    const subjectClassifications = [...new Set([...(Array.isArray(control.data.subjectClassifications) ? control.data.subjectClassifications : []), ...risks.map((risk) => risk.data.subjectClassification)].map((value) => assuranceClassification(value, "Assurance subject classification")))];
    const privacy = { ...assuranceLineage(control), subjectIds, subjectOwnerRefs, subjectClassifications, assuranceClassification: strongestAssuranceClassification(subjectClassifications) };
    await update(store, auth.userId, control.id, { data: privacy });
    const mapping = await create(store, auth.userId, { moduleId: "assurance", recordType: "control-risk-map", title: `Risk map · ${control.title}`, state: "active", data: { ...privacy, controlId: control.id, riskIds: risks.map((record) => record.id), rationale: input.rationale, createdByUserId: auth.userId, createdAt: now } });
    return output(action, [mapping], { mappingId: mapping.id });
  }
  if (action.id === "request-evidence") {
    const control = await owned(store, auth.userId, input.controlId, "assurance", "assurance-control", "controlId");
    const request = await create(store, auth.userId, { moduleId: "assurance", recordType: "evidence-request", title: `Evidence · ${control.title}`, state: "open", data: { ...assuranceLineage(control), controlId: control.id, ownerRef: input.ownerRef, evidenceOwnerRef: input.ownerRef, controlOwnerRef: control.data.controlOwnerRef ?? control.data.ownerRef, createdByUserId: auth.userId, requirements: input.requirements, dueAt: iso(input.dueAt, "dueAt"), createdAt: now } });
    return output(action, [request], { requestId: request.id });
  }
  if (action.id === "attach-evidence") {
    const request = await owned(store, auth.userId, input.requestId, "assurance", "evidence-request", "requestId");
    const source = await owned(store, auth.userId, input.sourceRecordId, undefined, undefined, "sourceRecordId");
    const evidence = await create(store, auth.userId, { moduleId: "assurance", recordType: "assurance-evidence", title: `Evidence · ${source.title}`, state: "attached", data: { ...assuranceLineage(request), requestId: request.id, controlId: request.data.controlId, controlOwnerRef: request.data.controlOwnerRef, evidenceOwnerRef: request.data.evidenceOwnerRef ?? request.data.ownerRef, attachedByUserId: auth.userId, createdByUserId: auth.userId, sourceRecordId: source.id, sourceModuleId: source.moduleId, sourceRecordType: source.recordType, sourceSnapshotHash: extendedBusinessDigest(source), contentHash: input.contentHash, observedAt: iso(input.observedAt, "observedAt"), provenance: input.provenance, attachedAt: now } });
    return output(action, [evidence], { evidenceId: evidence.id, sourceCopied: false });
  }
  if (action.id === "test-control") {
    const control = await owned(store, auth.userId, input.controlId, "assurance", "assurance-control", "controlId");
    if (input.testerRef !== auth.userId) throw new Error("Only the authenticated tester can record this control-test outcome.");
    const evidence = await ownedMany(store, auth.userId, input.evidenceIds, undefined, undefined, "evidenceIds");
    const result = await create(store, auth.userId, { moduleId: "assurance", recordType: "control-test", title: `Test · ${control.title}`, state: String(input.outcome), data: { ...assuranceLineage(control), controlId: control.id, controlOwnerRef: control.data.controlOwnerRef ?? control.data.ownerRef, testerRef: input.testerRef, createdByUserId: auth.userId, outcome: input.outcome, testedAt: iso(input.testedAt, "testedAt"), evidenceIds: evidence.map((record) => record.id), notes: input.notes, modelDecision: false, recordedAt: now } });
    return output(action, [result], { testId: result.id, humanOutcome: true });
  }
  if (action.id === "approve-remediation") {
    const risk = await owned(store, auth.userId, input.riskId, "assurance", "assurance-risk", "riskId");
    await ownedMany(store, auth.userId, input.evidenceIds, undefined, undefined, "evidenceIds");
    if (!apply) return dryRunResult(action, [risk], { riskId: risk.id, ownerRef: input.ownerRef, dueAt: iso(input.dueAt, "dueAt") });
    const remediation = await create(store, auth.userId, { moduleId: "assurance", recordType: "assurance-remediation", title: `Remediation · ${risk.title}`, state: "approved", data: { ...assuranceLineage(risk), riskId: risk.id, plan: input.plan, ownerRef: input.ownerRef, remediationOwnerRef: input.ownerRef, createdByUserId: auth.userId, dueAt: iso(input.dueAt, "dueAt"), evidenceIds: input.evidenceIds, approvedBy: auth.userId, approvedAt: now } });
    return output(action, [remediation], { remediationId: remediation.id });
  }
  if (action.id === "record-exception") {
    const control = await owned(store, auth.userId, input.controlId, "assurance", "assurance-control", "controlId");
    if (time(input.expiresAt, "expiresAt") <= time(now, "now")) throw new Error("A control exception must expire in the future.");
    if (!apply) return dryRunResult(action, [control], { controlId: control.id, expiresAt: iso(input.expiresAt, "expiresAt") });
    const exception = await create(store, auth.userId, { moduleId: "assurance", recordType: "control-exception", title: `Exception · ${control.title}`, state: "active", data: { ...assuranceLineage(control), controlId: control.id, controlOwnerRef: control.data.controlOwnerRef ?? control.data.ownerRef, createdByUserId: auth.userId, reason: input.reason, expiresAt: iso(input.expiresAt, "expiresAt"), compensatingControls: input.compensatingControls, approvedBy: auth.userId, approvedAt: now } });
    return output(action, [exception], { exceptionId: exception.id });
  }
  if (action.id === "export-audit-pack") {
    const program = await owned(store, auth.userId, input.programId, "assurance", "assurance-program", "programId");
    const records = await ownedMany(store, auth.userId, input.recordIds, undefined, undefined, "recordIds");
    const entries = records.map((record) => ({ id: record.id, moduleId: record.moduleId, recordType: record.recordType, snapshotHash: extendedBusinessDigest(record) })).sort((left, right) => left.id.localeCompare(right.id));
    const manifest = { programId: program.id, asOf: iso(input.asOf, "asOf"), format: input.format, entries };
    const pack = await create(store, auth.userId, { moduleId: "assurance", recordType: "audit-pack", title: `Audit pack · ${program.title}`, state: "ready-private", data: { ...assuranceLineage(program), ...manifest, manifestHash: extendedBusinessDigest(manifest), private: true, createdByUserId: auth.userId, createdAt: now } });
    return output(action, [pack], { auditPackId: pack.id, manifestHash: pack.data.manifestHash, private: true });
  }
  throw new Error("The AssureGraph action is not implemented.");
}

function liveConsentSnapshot(consents: SuiteRecord[]) {
  return extendedBusinessDigest(consents.map((record) => ({ id: record.id, participantRef: record.data.participantRef, decision: record.data.decision, scopes: record.data.scopes, policyVersion: record.data.policyVersion, capturedAt: record.data.capturedAt })).sort((left, right) => left.id.localeCompare(right.id)));
}

async function validPresenterGrant(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, grantId: unknown, sessionId: string, capability: string, now: string) {
  const grant = await owned(store, auth.userId, grantId, "live", "presenter-grant", "presenterGrantId");
  if (grant.data.sessionId !== sessionId || grant.data.presenterRef !== auth.userId || grant.state !== "active" || time(grant.data.expiresAt, "grant.expiresAt") <= time(now, "now") || !(grant.data.capabilities as string[]).includes(capability)) throw new Error(`The presenter grant does not authorize this authenticated user to ${capability}.`);
  return grant;
}

async function validAttendeeAccess(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, accessId: unknown, sessionId: string, capability: "chat" | "respond", now: string) {
  const access = await owned(store, auth.userId, accessId, "live", "attendee-access", "attendeeAccessId");
  const kind = String(access.data.accessKind);
  const allowed = capability === "chat" ? ["view-and-chat", "view-chat-and-respond"] : ["view-chat-and-respond"];
  if (access.data.sessionId !== sessionId || access.data.attendeeRef !== auth.userId || access.state !== "active" || time(access.data.expiresAt, "access.expiresAt") <= time(now, "now") || !allowed.includes(kind)) throw new Error(`The attendee access does not authorize this authenticated user to ${capability}.`);
  return access;
}

async function live(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, input: Record<string, unknown>, now: string, apply: boolean) {
  if (action.id === "create-session") {
    if (time(input.endsAt, "endsAt") <= time(input.startsAt, "startsAt")) throw new Error("The live session must end after it starts.");
    if ((await list(store, auth, "live", "live-session")).some((record) => record.data.key === input.key)) throw new Error("The live-session key already exists.");
    const session = await create(store, auth.userId, { moduleId: "live", recordType: "live-session", title: String(input.title), state: "scheduled", data: { ...input, idempotencyKey: undefined, sessionCreatedBy: auth.userId, sessionParticipantRefs: [auth.userId], version: 1, createdAt: now } });
    return output(action, [session], { sessionId: session.id });
  }
  if (action.id === "issue-presenter-grant") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    await workspaceIdentity(store, auth, input.presenterRef, "presenterRef", "admin");
    if (time(input.expiresAt, "expiresAt") <= time(now, "now")) throw new Error("The presenter grant must expire in the future.");
    const privacy = liveSessionPrivacy(session, [String(input.presenterRef)]);
    if (!apply) return dryRunResult(action, [session], { sessionId: session.id, presenterRef: input.presenterRef, capabilities: input.capabilities });
    await update(store, auth.userId, session.id, { data: { sessionParticipantRefs: privacy.sessionParticipantRefs } });
    const grant = await create(store, auth.userId, { moduleId: "live", recordType: "presenter-grant", title: `Presenter · ${input.presenterRef}`, state: "active", data: { ...privacy, presenterRef: input.presenterRef, capabilities: input.capabilities, expiresAt: iso(input.expiresAt, "expiresAt"), accessDecisionReceiptId: input.accessDecisionReceiptId, approvedBy: auth.userId, issuedAt: now } });
    return output(action, [grant], { presenterGrantId: grant.id });
  }
  if (action.id === "issue-attendee-access") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    await workspaceIdentity(store, auth, input.attendeeRef, "attendeeRef");
    if (time(input.expiresAt, "expiresAt") <= time(now, "now")) throw new Error("The attendee access must expire in the future.");
    const privacy = liveSessionPrivacy(session, [String(input.attendeeRef)]);
    if (!apply) return dryRunResult(action, [session], { sessionId: session.id, attendeeRef: input.attendeeRef, accessKind: input.accessKind });
    await update(store, auth.userId, session.id, { data: { sessionParticipantRefs: privacy.sessionParticipantRefs } });
    const access = await create(store, auth.userId, { moduleId: "live", recordType: "attendee-access", title: `Attendee · ${input.attendeeRef}`, state: "active", data: { ...privacy, attendeeRef: input.attendeeRef, accessKind: input.accessKind, expiresAt: iso(input.expiresAt, "expiresAt"), accessDecisionReceiptId: input.accessDecisionReceiptId, approvedBy: auth.userId, issuedAt: now } });
    return output(action, [access], { attendeeAccessId: access.id });
  }
  if (action.id === "record-media-consent") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    if (input.participantRef !== auth.userId) throw new Error("Only the authenticated participant can record or revoke its media consent.");
    if (time(input.capturedAt, "capturedAt") > time(now, "now")) throw new Error("Media consent cannot be recorded with a future subject-interaction clock.");
    if ((await list(store, auth, "live", "media-consent-receipt")).some((record) => record.data.participantRef === auth.userId && record.data.subjectReceiptId === input.subjectReceiptId)) throw new Error("The media-consent subject receipt is already recorded for this participant.");
    const receipt = await create(store, auth.userId, { moduleId: "live", recordType: "media-consent-receipt", title: `Media consent · ${input.participantRef}`, state: String(input.decision), data: { ...liveSessionPrivacy(session), participantRef: input.participantRef, decision: input.decision, scopes: input.scopes, policyVersion: input.policyVersion, capturedAt: iso(input.capturedAt, "capturedAt"), subjectReceiptId: input.subjectReceiptId, subjectProvided: true } });
    return output(action, [receipt], { consentReceiptId: receipt.id, subjectProvided: true });
  }
  if (action.id === "start-broadcast") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    const next = nextVersion(session, input);
    const grant = await validPresenterGrant(store, auth, input.presenterGrantId, session.id, "broadcast", now);
    if (session.state !== "scheduled") throw new Error("Only a scheduled session can start broadcasting.");
    const consents = (await list(store, auth, "live", "media-consent-receipt")).filter((record) => record.data.sessionId === session.id);
    const expectedConsentHash = liveConsentSnapshot(consents);
    if (!apply) return dryRunResult(action, [session, grant, ...consents], { sessionId: session.id, expectedConsentSnapshotHash: expectedConsentHash, nextVersion: next });
    if (input.consentSnapshotHash !== expectedConsentHash) throw new Error("The consent snapshot hash is stale or incorrect.");
    if (session.data.recordingMode === "consent-required") {
      const latestConsent = new Map<string, SuiteRecord>();
      for (const receipt of [...consents].sort((left, right) => String(left.data.capturedAt).localeCompare(String(right.data.capturedAt)))) latestConsent.set(String(receipt.data.participantRef), receipt);
      const activeAttendees = (await list(store, auth, "live", "attendee-access")).filter((record) => record.data.sessionId === session.id && record.state === "active" && time(record.data.expiresAt, "access.expiresAt") > time(now, "now"));
      const activePresenters = (await list(store, auth, "live", "presenter-grant")).filter((record) => record.data.sessionId === session.id && record.state === "active" && time(record.data.expiresAt, "grant.expiresAt") > time(now, "now"));
      const participants = [...new Set([...activeAttendees.map((record) => String(record.data.attendeeRef)), ...activePresenters.map((record) => String(record.data.presenterRef))])];
      const missing = participants.filter((participantRef) => {
        const receipt = latestConsent.get(participantRef);
        return !receipt || receipt.data.decision !== "granted" || !(receipt.data.scopes as string[]).some((scope) => scope === "record-audio" || scope === "record-video");
      });
      if (missing.length) throw new Error("Recording cannot start until every active participant has a current granted media receipt for audio or video.");
    }
    const started = await update(store, auth.userId, session.id, { state: "live", data: { version: next, presenterGrantId: grant.id, consentSnapshotHash: expectedConsentHash, startedAt: iso(input.startedAt, "startedAt") } });
    const receipt = await create(store, auth.userId, { moduleId: "live", recordType: "broadcast-receipt", title: `Started · ${session.title}`, state: "started", data: { ...liveSessionPrivacy(started), presenterGrantId: grant.id, consentSnapshotHash: expectedConsentHash, startedAt: started.data.startedAt, approvedBy: auth.userId } });
    return output(action, [started, receipt], { broadcastReceiptId: receipt.id });
  }
  if (action.id === "update-broadcast") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    const next = nextVersion(session, input);
    const grant = await validPresenterGrant(store, auth, input.presenterGrantId, session.id, "broadcast", now);
    if (session.state !== "live") throw new Error("Only a live broadcast can be updated.");
    if (!apply) return dryRunResult(action, [session, grant], { sessionId: session.id, nextVersion: next, stageMode: input.stageMode });
    const updated = await update(store, auth.userId, session.id, { data: { version: next, stageMode: input.stageMode, agendaNote: input.agendaNote, updatedAt: now } });
    const receipt = await create(store, auth.userId, { moduleId: "live", recordType: "broadcast-update", title: `Update · ${session.title}`, state: "applied", data: { ...liveSessionPrivacy(updated), presenterGrantId: grant.id, stageMode: input.stageMode, agendaNote: input.agendaNote, approvedBy: auth.userId, appliedAt: now } });
    return output(action, [updated, receipt], { updateReceiptId: receipt.id });
  }
  if (action.id === "send-chat") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    if (session.state !== "live") throw new Error("Chat is only available while the session is live.");
    const access = await validAttendeeAccess(store, auth, input.attendeeAccessId, session.id, "chat", now);
    const message = await create(store, auth.userId, { moduleId: "live", recordType: "live-chat-message", title: `Chat · ${access.data.attendeeRef}`, state: "visible", data: { ...liveSessionPrivacy(session), attendeeAccessId: access.id, senderRef: access.data.attendeeRef, body: input.body, sentAt: iso(input.sentAt, "sentAt"), version: 1 } });
    return output(action, [message], { messageId: message.id, accessReceiptId: access.data.accessDecisionReceiptId });
  }
  if (action.id === "moderate-chat") {
    const message = await owned(store, auth.userId, input.messageId, "live", "live-chat-message", "messageId");
    const next = nextVersion(message, input);
    const grant = await validPresenterGrant(store, auth, input.moderatorGrantId, String(message.data.sessionId), "moderate", now);
    if (!apply) return dryRunResult(action, [message, grant], { messageId: message.id, decision: input.decision, nextVersion: next });
    const receipt = await create(store, auth.userId, { moduleId: "live", recordType: "chat-moderation-receipt", title: `Moderation · ${message.title}`, state: String(input.decision), data: { ...liveSessionPrivacy(message), messageId: message.id, messageSenderRef: message.data.senderRef, moderatorGrantId: grant.id, decision: input.decision, reason: input.reason, moderationReceiptId: input.moderationReceiptId, approvedBy: auth.userId, decidedAt: now } });
    const moderated = await update(store, auth.userId, message.id, { state: input.decision === "hide" ? "hidden" : "visible", data: { version: next, latestModerationReceiptId: receipt.id } });
    return output(action, [moderated, receipt], { moderationReceiptId: receipt.id, humanDecision: true });
  }
  if (action.id === "open-prompt") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    if (session.state !== "live") throw new Error("Prompts require a live session.");
    const grant = await validPresenterGrant(store, auth, input.presenterGrantId, session.id, "prompt", now);
    if (input.responseType === "single-choice" && (!Array.isArray(input.options) || input.options.length < 2)) throw new Error("A single-choice prompt needs at least two options.");
    const prompt = await create(store, auth.userId, { moduleId: "live", recordType: "live-prompt", title: String(input.question).slice(0, 160), state: "open", data: { ...liveSessionPrivacy(session), presenterGrantId: grant.id, question: input.question, responseType: input.responseType, options: input.options ?? [], closesAt: iso(input.closesAt, "closesAt"), openedAt: now } });
    return output(action, [prompt], { promptId: prompt.id });
  }
  if (action.id === "submit-response") {
    const prompt = await owned(store, auth.userId, input.promptId, "live", "live-prompt", "promptId");
    if (prompt.state !== "open" || time(now, "now") > time(prompt.data.closesAt, "prompt.closesAt") || time(input.submittedAt, "submittedAt") > time(now, "now")) throw new Error("The prompt is closed or the submission clock is invalid.");
    const access = await validAttendeeAccess(store, auth, input.attendeeAccessId, String(prompt.data.sessionId), "respond", now);
    if ((await list(store, auth, "live", "live-prompt-response")).some((record) => record.data.promptId === prompt.id && record.data.attendeeAccessId === access.id)) throw new Error("This attendee access already submitted a response.");
    if (prompt.data.responseType === "single-choice" && !(prompt.data.options as string[]).includes(String(input.response))) throw new Error("The response is not an allowed option.");
    const response = await create(store, auth.userId, { moduleId: "live", recordType: "live-prompt-response", title: `Response · ${prompt.title}`, state: "submitted", data: { ...liveSessionPrivacy(prompt), promptId: prompt.id, attendeeAccessId: access.id, attendeeRef: access.data.attendeeRef, response: input.response, submittedAt: iso(input.submittedAt, "submittedAt") } });
    return output(action, [response], { responseId: response.id });
  }
  if (action.id === "end-broadcast") {
    const session = await owned(store, auth.userId, input.sessionId, "live", "live-session", "sessionId");
    const next = nextVersion(session, input);
    const grant = await validPresenterGrant(store, auth, input.presenterGrantId, session.id, "end", now);
    if (session.state !== "live") throw new Error("Only a live session can end.");
    if (!apply) return dryRunResult(action, [session, grant], { sessionId: session.id, nextVersion: next, endedAt: iso(input.endedAt, "endedAt") });
    const ended = await update(store, auth.userId, session.id, { state: "ended", data: { version: next, endedAt: iso(input.endedAt, "endedAt") } });
    const receipt = await create(store, auth.userId, { moduleId: "live", recordType: "broadcast-receipt", title: `Ended · ${session.title}`, state: "ended", data: { ...liveSessionPrivacy(ended), presenterGrantId: grant.id, endedAt: ended.data.endedAt, approvedBy: auth.userId } });
    return output(action, [ended, receipt], { broadcastReceiptId: receipt.id });
  }
  throw new Error("The LiveForum action is not implemented.");
}

async function executeMutation(store: ExtendedBusinessStore, auth: ExtendedBusinessAuthorization, action: AdditiveWaveTwoActionDefinition, input: Record<string, unknown>, deps: ExtendedBusinessEngineDependencies, apply: boolean) {
  const now = deps.now().toISOString();
  if (action.moduleId === "events") return events(store, auth, action, input, now, apply, deps);
  if (action.moduleId === "people") return people(store, auth, action, input, now, apply, deps);
  if (action.moduleId === "metering") return metering(store, auth, action, input, now, apply, deps);
  if (action.moduleId === "assurance") return assurance(store, auth, action, input, now, apply);
  return live(store, auth, action, input, now, apply);
}

/**
 * Clean-room integration signature. Every stateful operation goes through the
 * shared tenant store and transaction; this engine contains no business-state map,
 * provider client, payment executor, identity provider, media server, or model.
 */
export async function executeExtendedBusinessAction(
  store: ExtendedBusinessStore,
  auth: ExtendedBusinessAuthorization,
  moduleId: string,
  actionId: string,
  input: Record<string, unknown>,
  dependencies: Partial<ExtendedBusinessEngineDependencies> = {},
): Promise<ExtendedBusinessExecutionResult> {
  const action = additiveWaveTwoAction(moduleId, actionId);
  if (!action) throw new Error("The extended business action does not exist.");
  validate(input, action.inputSchema as unknown as Record<string, unknown>, "input");
  const deps = {
    now: dependencies.now ?? defaults.now,
    modelPolicyId: dependencies.modelPolicyId ?? defaults.modelPolicyId,
    verifyExternalEvidence: dependencies.verifyExternalEvidence ?? defaults.verifyExternalEvidence,
  };
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    await authorize(auth, workspace, action);
    const trustedModelPolicyId = action.operation === "ai" ? expectedModelPolicyId(input.modelId, deps.modelPolicyId) : undefined;
    if (action.operation === "read") return executeMutation(store, auth, action, input, deps, false);
    const key = String(input.idempotencyKey);
    const requestHash = extendedBusinessDigest({ workspaceId: auth.workspaceId, actorUserId: auth.userId, moduleId: action.moduleId, actionId: action.id, input });
    const prior = await replay(store, auth, action, key, requestHash);
    if (prior) return prior;
    const now = deps.now().toISOString();
    if (action.operation === "ai") return saveReceipt(store, auth, key, requestHash, await queueProposal(store, auth, action, input, trustedModelPolicyId!, now), now);
    const dryRun = action.supportsDryRun && input.dryRun === true;
    let humanApproval: HumanApproval | undefined;
    if (action.requiresApproval && !dryRun) {
      humanApproval = approval(input, auth, now);
      await assertUnusedApprovalDecision(store, auth, humanApproval.decisionId);
    }
    const result = await executeMutation(store, auth, action, input, deps, !dryRun);
    result.audit = {
      ...result.audit,
      dryRun,
      effectBoundary: action.effectBoundary,
      externalEffect: action.externalEffect,
      providerCallStarted: false,
      autonomousSideEffect: false,
      ...(humanApproval ? { approvalDecisionId: humanApproval.decisionId, approvedBy: humanApproval.approvedBy, approvalReason: humanApproval.reason, approvedAt: humanApproval.approvedAt } : {}),
    };
    return saveReceipt(store, auth, key, requestHash, result, now);
  });
}

export function extendedBusinessScope(moduleId: AdditiveWaveTwoModuleId, scope: AdditiveWaveTwoScope) {
  return `${moduleId}:${scope}`;
}
