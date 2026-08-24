import { createHash, randomUUID } from "node:crypto";
import type { SuiteAiAction, SuiteRecord, SuiteWorkspaceRole } from "../shared/suite.js";
import { coreBusinessAction, coreBusinessActions, type CoreBusinessActionDefinition, type CoreBusinessModuleId, type CoreBusinessScope } from "../shared/core-business-actions.js";
import type { SuiteStore } from "./suite-store.js";
import { canReadSuiteRecord } from "./suite-record-visibility.js";
import { coreBusinessAiResultContract, coreBusinessPromptDigest, coreBusinessPromptPolicies } from "./prompts/core-business.js";

export interface CoreBusinessAuthorization { userId: string; workspaceId: string; role: SuiteWorkspaceRole; scopes: string[] }
export interface CoreBusinessApproval { approved: true; approvedBy: string; approvedAt: string; decisionId: string; reason: string }
export interface CoreBusinessExternalRequest { requestId: string; workspaceId: string; actorUserId: string; moduleId: CoreBusinessModuleId; actionId: string; payloadHash: string; payload: Record<string, unknown>; approval: CoreBusinessApproval }
export interface CoreBusinessExternalReceipt { provider: string; externalId: string; status: "accepted" | "completed"; occurredAt: string; evidence?: Record<string, unknown> }
export interface CoreBusinessEngineDependencies { now: () => Date; modelPolicyId: string; externalExecutor?: (request: CoreBusinessExternalRequest) => Promise<CoreBusinessExternalReceipt> }
export interface CoreBusinessExecutionResult { kind: "read" | "command" | "ai-action"; action: CoreBusinessActionDefinition; records: SuiteRecord[]; audit: Record<string, unknown>; aiAction?: SuiteAiAction }
export interface CoreBusinessAiCompletion { proposal: string; evidence: string[]; confidence: number; assumptions: string[]; reviewStatus: "pending-human-review"; approvalRequired: true; model: string; [key: string]: unknown }
export interface CoreBusinessStorageContext { workspaceId: string; actorUserId: string; idempotencyKey?: string; readOnly: boolean }
export interface CoreBusinessStorageSession { store: SuiteStore; replaceSnapshot?: (snapshot: CoreBusinessSnapshot) => Promise<void> }
export interface CoreBusinessStorageAdapter { transaction<T>(context: CoreBusinessStorageContext, work: (session: CoreBusinessStorageSession) => Promise<T>): Promise<T> }
export interface CoreBusinessSnapshot {
  version: "core-business-snapshot.v1";
  workspaceId: string;
  exportedAt: string;
  actionCatalogDigest: string;
  actions: Array<{ moduleId: CoreBusinessModuleId; actionId: string; schemaDigest: string; promptId?: string; promptVersion?: string }>;
  records: SuiteRecord[];
  aiActions: SuiteAiAction[];
  snapshotHash: string;
}

const defaults: CoreBusinessEngineDependencies = { now: () => new Date(), modelPolicyId: "workspace-configured-model" };
export const coreBusinessApprovalFreshnessMs = 24 * 60 * 60 * 1_000;
export const coreBusinessBoundedScanLimit = 10_000;
const locks = new Map<string, Promise<void>>();
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve(); let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; }); const tail = previous.then(() => gate); locks.set(key, tail); await previous;
  try { return await work(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value; }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function plain(value: unknown, label: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function list(value: unknown, label: string) { if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be a non-empty string array.`); return [...new Set(value.map(String))]; }
function iso(input: Record<string, unknown>, key: string) { return new Date(String(input[key])).toISOString(); }
function output(action: CoreBusinessActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>, kind: CoreBusinessExecutionResult["kind"] = "command"): CoreBusinessExecutionResult { return { kind, action, records, audit }; }

async function completeCoreScan(store: SuiteStore, userId: string, moduleId: CoreBusinessModuleId, recordType: string) {
  const records = await store.listRecords(userId, { moduleId, recordType, limit: coreBusinessBoundedScanLimit + 1 });
  if (records.length > coreBusinessBoundedScanLimit) throw new Error(`The bounded ${moduleId}/${recordType} scan is saturated; an indexed or paginated lookup is required before this action can run safely.`);
  return records;
}

function visibilityScopedStore(store: SuiteStore, auth: CoreBusinessAuthorization): SuiteStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "getRecord") {
        return async (userId: string, recordId: string) => {
          if (userId !== auth.userId) return undefined;
          const record = await target.getRecord(userId, recordId);
          return record && canReadSuiteRecord({ userId: auth.userId, workspaceId: auth.workspaceId, role: auth.role }, record) ? record : undefined;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function validateString(value: unknown, schema: Record<string, unknown>, path: string) {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(`${path} is too short.`);
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(`${path} is too long.`);
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format.`);
  if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${path} must be a UUID.`);
  if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(new Date(value).getTime()))) throw new Error(`${path} must be an ISO date-time.`);
  if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`${path} must be an email address.`);
  if (schema.format === "uri") { try { new URL(value); } catch { throw new Error(`${path} must be a URL.`); } }
}
function validate(value: unknown, schema: Record<string, unknown>, path: string): void {
  if (Array.isArray(schema.anyOf)) { if (!schema.anyOf.some((candidate) => { try { validate(value, candidate as Record<string, unknown>, path); return true; } catch { return false; } })) throw new Error(`${path} does not match an allowed shape.`); return; }
  if ("const" in schema && value !== schema.const) throw new Error(`${path} must equal the required constant.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} must be an allowed value.`);
  if (schema.type === "null") { if (value !== null) throw new Error(`${path} must be null.`); return; }
  if (schema.type === "string") return validateString(value, schema, path);
  if (schema.type === "boolean") { if (typeof value !== "boolean") throw new Error(`${path} must be boolean.`); return; }
  if (schema.type === "integer") { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer.`); if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`${path} is below its minimum.`); if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`${path} exceeds its maximum.`); return; }
  if (schema.type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite.`); return; }
  if (schema.type === "array") { if (!Array.isArray(value)) throw new Error(`${path} must be an array.`); if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${path} has too few items.`); if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} has too many items.`); if (schema.items) value.forEach((item, index) => validate(item, schema.items as Record<string, unknown>, `${path}[${index}]`)); return; }
  if (schema.type === "object") {
    const source = plain(value, path); const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in source)) throw new Error(`${path}.${key} is required.`);
    if (schema.additionalProperties === false && properties) for (const key of Object.keys(source)) if (!(key in properties)) throw new Error(`${path}.${key} is not allowed.`);
    if (properties) for (const [key, item] of Object.entries(source)) if (properties[key]) validate(item, properties[key], `${path}.${key}`);
  }
}

async function authorize(store: SuiteStore, auth: CoreBusinessAuthorization, action: CoreBusinessActionDefinition) {
  const workspace = await store.getOrCreateWorkspace(auth.userId);
  if (workspace.id !== auth.workspaceId) throw new Error("The authorization workspace does not match the actor's tenant.");
  if (workspace.currentRole !== auth.role) throw new Error("The supplied role does not match the workspace membership.");
  if (!workspace.enabledModuleIds.includes(action.moduleId)) throw new Error("The module is not enabled for this workspace.");
  if (!auth.scopes.includes("*") && !auth.scopes.includes(`${action.moduleId}:${action.requiredScope}`)) throw new Error(`The ${action.moduleId}:${action.requiredScope} scope is required.`);
  if (auth.role === "viewer" && action.operation !== "read") throw new Error("Viewers cannot mutate or queue AI work.");
  if ((action.destructive || action.externalEffect) && !["owner", "admin"].includes(auth.role)) throw new Error("Only owners or administrators can approve high-risk actions.");
}
async function owned(store: SuiteStore, userId: string, recordId: unknown, moduleId?: string, recordType?: string, label = "recordId") {
  if (typeof recordId !== "string") throw new Error(`${label} must be a record ID.`); const record = await store.getRecord(userId, recordId);
  if (!record || (moduleId && record.moduleId !== moduleId) || (recordType && record.recordType !== recordType)) throw new Error(`${label.replace(/Id$/, "")} not found.`); return record;
}
async function create(store: SuiteStore, userId: string, input: Parameters<SuiteStore["createRecord"]>[1]) { const record = await store.createRecord(userId, input); if (!record) throw new Error("The workspace record could not be persisted."); return record; }
async function update(store: SuiteStore, userId: string, id: string, input: Parameters<SuiteStore["updateRecord"]>[2]) { const record = await store.updateRecord(userId, id, input); if (!record) throw new Error("The workspace record could not be updated."); return record; }
function expected(record: SuiteRecord, input: Record<string, unknown>) { const value = input.expectedVersion; if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(record.data.version ?? 1) !== value) throw new Error("The record version is stale."); return Number(value) + 1; }
function approval(input: Record<string, unknown>, auth: CoreBusinessAuthorization, now: Date): CoreBusinessApproval {
  const value = input.approval as CoreBusinessApproval | undefined;
  const approvedAt = new Date(String(value?.approvedAt ?? ""));
  if (!value || value.approved !== true || value.approvedBy !== auth.userId || !value.reason?.trim() || !/^[A-Za-z0-9._:-]{16,200}$/.test(value.decisionId ?? "") || !Number.isFinite(approvedAt.getTime())) throw new Error("An attributable, reasoned, fresh, uniquely identified human approval is required when dryRun is false.");
  if (approvedAt.getTime() > now.getTime()) throw new Error("Human approval cannot be future-dated.");
  if (now.getTime() - approvedAt.getTime() > coreBusinessApprovalFreshnessMs) throw new Error("Human approval is stale and must be reviewed again against the current request.");
  return { ...value, approvedAt: approvedAt.toISOString(), reason: value.reason.trim() };
}

function receiptApprovalDecisionId(receipt: SuiteRecord) {
  const audit = receipt.data.audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return null;
  const nested = (audit as Record<string, unknown>).approvalDecisionId;
  const top = receipt.data.approvalDecisionId;
  if (top !== undefined && top !== null && top !== nested) throw new Error("A stored core command receipt has inconsistent approval attribution.");
  if (nested === undefined || nested === null) return null;
  if (typeof nested !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(nested)) throw new Error("A stored core command receipt has malformed approval attribution.");
  return nested;
}

async function assertApprovalUnused(store: SuiteStore, auth: CoreBusinessAuthorization, decisionId: string) {
  const receipt = await store.findApprovalDecisionReceipt(auth.userId, decisionId);
  if (receipt) {
    if (receipt.recordType === "command-receipt") receiptApprovalDecisionId(receipt);
    throw new Error("The human approval decision ID is already bound to another committed command.");
  }
}

async function replay(store: SuiteStore, auth: CoreBusinessAuthorization, action: CoreBusinessActionDefinition, key: string, hash: string) {
  const receipt = await store.findCommandReceipt(auth.userId, { recordType: "command-receipt", moduleId: action.moduleId, actionId: action.id, idempotencyKey: key });
  if (!receipt) return undefined;
  if (receipt.data.actorUserId !== auth.userId) throw new Error("The idempotency key is bound to another authenticated actor.");
  if (receipt.data.actionId !== action.id || receipt.data.requestHash !== hash) throw new Error("The idempotency key was already used for a different command.");
  const records: SuiteRecord[] = []; for (const id of Array.isArray(receipt.data.resultRecordIds) ? receipt.data.resultRecordIds : []) { const record = await store.getRecord(auth.userId, String(id)); if (record) records.push(record); }
  const aiAction = typeof receipt.data.aiActionId === "string" ? await store.getAiAction(auth.userId, receipt.data.aiActionId) : undefined;
  return { kind: aiAction ? "ai-action" : "command", action, records, audit: { ...(receipt.data.audit as Record<string, unknown>), receiptId: receipt.id, replayed: true }, ...(aiAction ? { aiAction } : {}) } as CoreBusinessExecutionResult;
}
async function saveReceipt(store: SuiteStore, auth: CoreBusinessAuthorization, action: CoreBusinessActionDefinition, key: string, hash: string, execution: CoreBusinessExecutionResult) {
  const receipt = await create(store, auth.userId, { moduleId: action.moduleId, recordType: "command-receipt", title: `${action.id} · ${key.slice(0, 48)}`, state: "recorded", data: { actionId: action.id, idempotencyKey: key, requestHash: hash, resultRecordIds: execution.records.map((record) => record.id), aiActionId: execution.aiAction?.id, audit: execution.audit, actorUserId: auth.userId, approvalDecisionId: execution.audit.approvalDecisionId ?? null, immutable: true } });
  execution.audit = { ...execution.audit, receiptId: receipt.id, replayed: false }; return execution;
}

async function queueAi(store: SuiteStore, auth: CoreBusinessAuthorization, action: CoreBusinessActionDefinition, input: Record<string, unknown>, deps: CoreBusinessEngineDependencies) {
  const evidence: SuiteRecord[] = []; for (const id of input.evidenceIds as string[]) evidence.push(await owned(store, auth.userId, id, undefined, undefined, "evidenceId"));
  const targetSpecs: Partial<Record<string, [string, string]>> = {
    "automate:failure-diagnose": ["runId", "workflow-run"], "automate:retry-plan-propose": ["runId", "workflow-run"], "publish:content-variants-propose": ["campaignId", "campaign"], "publish:performance-explain": ["campaignId", "campaign"],
    "inbox:reply-propose": ["conversationId", "conversation"], "inbox:thread-summarize": ["conversationId", "conversation"], "crm:next-action-propose": ["accountId", "account"], "tasks:workload-rebalance-propose": ["projectId", "project"], "tasks:delivery-risk-explain": ["projectId", "project"],
    "feedback:duplicate-cluster-propose": ["boardId", "feedback-board"], "knowledge:staleness-audit-propose": ["libraryId", "knowledge-library"], "links:destination-risk-propose": ["destinationVersionId", "destination-version"],
  };
  const spec = targetSpecs[`${action.moduleId}:${action.id}`]; let target: SuiteRecord | undefined;
  if (spec) target = await owned(store, auth.userId, input[spec[0]], action.moduleId, spec[1], spec[0]);
  if (action.id === "duplicate-review-propose") target = await owned(store, auth.userId, input.recordId, "crm", undefined, "recordId");
  const policy = coreBusinessPromptPolicies[action.moduleId]; if (!action.promptId || action.promptVersion !== policy.version) throw new Error("The AI action is missing an approved prompt boundary.");
  const boundary = { promptId: action.promptId, promptVersion: policy.version, promptDigest: coreBusinessPromptDigest(action.moduleId), modelPolicyId: deps.modelPolicyId, executedModel: null, confidence: null, evidenceIds: evidence.map((record) => record.id), targetRecordId: target?.id, reviewStatus: "pending-model", approvalRequired: true, resultContract: coreBusinessAiResultContract, forbiddenAutonomy: policy.forbiddenAutonomy };
  const now = deps.now().toISOString(); const auditRecord = await create(store, auth.userId, { moduleId: action.moduleId, recordType: "ai-request-audit", title: action.title, state: "queued", data: { ...boundary, requestedAt: now, requestedByUserId: auth.userId, immutableRequest: true } });
  const goal = String(input.instruction ?? input.question ?? action.title); const aiAction = await store.queueAiAction(auth.userId, { moduleId: action.moduleId, goal, context: { actionId: action.id, aiAuditRecordId: auditRecord.id, ...boundary } });
  if (!aiAction) { await update(store, auth.userId, auditRecord.id, { state: "queue-failed", data: { reviewStatus: "queue-failed", failedAt: now } }); throw new Error("The AI proposal could not be queued."); }
  return { kind: "ai-action", action, records: [auditRecord], aiAction, audit: { aiAuditRecordId: auditRecord.id, ...boundary, modelExecuted: false } } satisfies CoreBusinessExecutionResult;
}

export function validateCoreBusinessAiCompletion(value: unknown, allowedEvidenceIds: Iterable<string>): CoreBusinessAiCompletion {
  const result = plain(value, "AI result");
  if (typeof result.proposal !== "string" || !result.proposal.trim() || result.proposal.length > 20_000) throw new Error("The AI result proposal is missing or too long.");
  if (!Array.isArray(result.evidence) || result.evidence.length > 100 || result.evidence.some((id) => !validId(id))) throw new Error("The AI result evidence list is malformed.");
  const evidence = [...new Set(result.evidence as string[])]; const allowed = new Set(allowedEvidenceIds);
  if (evidence.some((id) => !allowed.has(id))) throw new Error("The AI result cites evidence outside the authorized selection.");
  if (typeof result.confidence !== "number" || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new Error("The AI result confidence must be from zero to one.");
  if (!Array.isArray(result.assumptions) || result.assumptions.length > 50 || result.assumptions.some((item) => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new Error("The AI result assumptions are malformed.");
  if (result.reviewStatus !== "pending-human-review" || result.approvalRequired !== true) throw new Error("The AI result must remain pending human review and approval-required.");
  if (typeof result.model !== "string" || !result.model.trim() || result.model.length > 200) throw new Error("The AI result must record its executed model.");
  return { ...result, proposal: result.proposal.trim(), evidence, confidence: result.confidence, assumptions: result.assumptions as string[], reviewStatus: "pending-human-review", approvalRequired: true, model: result.model.trim() } as CoreBusinessAiCompletion;
}

export async function recordCoreBusinessAiCompletion(store: SuiteStore, auth: CoreBusinessAuthorization, aiActionId: string, value?: unknown, completedAt = new Date()) {
  const aiAction = await store.getAiAction(auth.userId, aiActionId);
  if (!aiAction || aiAction.workspaceId !== auth.workspaceId || aiAction.status !== "completed") throw new Error("The completed tenant AI action was not found.");
  const action = coreBusinessAction(aiAction.moduleId, String(aiAction.context.actionId));
  if (!action || action.operation !== "ai" || action.promptId !== aiAction.context.promptId || action.promptVersion !== aiAction.context.promptVersion || coreBusinessPromptDigest(action.moduleId) !== aiAction.context.promptDigest) throw new Error("The completed AI action does not match a trusted prompt boundary.");
  await authorize(store, auth, action);
  const allowedEvidenceIds = Array.isArray(aiAction.context.evidenceIds) ? aiAction.context.evidenceIds.filter((id): id is string => typeof id === "string") : [];
  const completion = validateCoreBusinessAiCompletion(value ?? aiAction.result, allowedEvidenceIds);
  const auditRecord = await owned(store, auth.userId, aiAction.context.aiAuditRecordId, action.moduleId, "ai-request-audit", "aiAuditRecordId");
  const resultHash = digest(completion);
  if (auditRecord.data.resultHash) {
    const recordedBoundary = { executedModel: auditRecord.data.executedModel, confidence: auditRecord.data.confidence, evidenceIds: auditRecord.data.evidenceIds, assumptions: auditRecord.data.assumptions, reviewStatus: auditRecord.data.reviewStatus, approvalRequired: auditRecord.data.approvalRequired };
    const completionBoundary = { executedModel: completion.model, confidence: completion.confidence, evidenceIds: completion.evidence, assumptions: completion.assumptions, reviewStatus: completion.reviewStatus, approvalRequired: completion.approvalRequired };
    if (digest(recordedBoundary) !== digest(completionBoundary)) throw new Error("The AI audit record is already bound to a different completion.");
    return { auditRecord, completion, replayed: true };
  }
  if (auditRecord.data.promptDigest !== aiAction.context.promptDigest || auditRecord.data.reviewStatus !== "pending-model") throw new Error("The AI audit record is stale or does not match the queued boundary.");
  const recorded = await update(store, auth.userId, auditRecord.id, { state: "pending-human-review", data: { executedModel: completion.model, confidence: completion.confidence, evidenceIds: completion.evidence, assumptions: completion.assumptions, reviewStatus: completion.reviewStatus, approvalRequired: true, resultHash, completedAt: completedAt.toISOString() } });
  return { auditRecord: recorded, completion, replayed: false };
}

async function exportOne(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, id: unknown, moduleId: string, type: string, format: unknown, now: string, extra: Record<string, unknown> = {}) {
  const source = await owned(store, userId, id, moduleId, type); const manifest = { sourceRecordId: source.id, sourceUpdatedAt: source.updatedAt, format, ...extra };
  const job = await create(store, userId, { moduleId, recordType: "export-job", title: `${format} · ${source.title}`, state: "queued", data: { ...manifest, manifestHash: digest(manifest), private: true, queuedAt: now } });
  return output(action, [job, source], { exportId: job.id, sourceRecordId: source.id, manifestHash: job.data.manifestHash, format });
}

async function validateRisky(store: SuiteStore, auth: CoreBusinessAuthorization, action: CoreBusinessActionDefinition, input: Record<string, unknown>) {
  const userId = auth.userId;
  if (action.moduleId === "automate" && action.id === "workflow-publish") { const record = await owned(store, userId, input.workflowVersionId, "automate", "workflow-version", "workflowVersionId"); if (record.data.contentHash !== input.contentHash) throw new Error("The workflow content hash is stale."); }
  else if (action.moduleId === "automate" && action.id === "workflow-run-start") { const record = await owned(store, userId, input.workflowVersionId, "automate", "workflow-version", "workflowVersionId"); if (record.state !== "published") throw new Error("Only a published workflow can start a live run."); }
  else if (action.moduleId === "publish" && action.id === "publication-dispatch") { const record = await owned(store, userId, input.scheduledPostId, "publish", "scheduled-post", "scheduledPostId"); if (record.state !== "scheduled") throw new Error("Only a scheduled post can be dispatched."); }
  else if (action.moduleId === "inbox" && action.id === "reply-send") { const record = await owned(store, userId, input.conversationId, "inbox", "conversation", "conversationId"); if (record.state !== "open") throw new Error("Replies require an open conversation."); }
  else if (action.moduleId === "feedback" && action.id === "request-merge") { const target = await owned(store, userId, input.targetRequestId, "feedback", "feedback-request", "targetRequestId"); for (const id of input.sourceRequestIds as string[]) { const source = await owned(store, userId, id, "feedback", "feedback-request", "sourceRequestId"); if (source.id === target.id) throw new Error("A request cannot be merged into itself."); } }
  else if (action.moduleId === "feedback" && action.id === "changelog-publish") for (const id of input.requestIds as string[]) { const request = await owned(store, userId, id, "feedback", "feedback-request", "requestId"); if (request.state !== "shipped") throw new Error("Changelog entries may cite only shipped requests."); }
  else if (action.moduleId === "knowledge" && action.id === "page-revision-publish") { const record = await owned(store, userId, input.revisionId, "knowledge", "page-revision", "revisionId"); if (record.data.contentHash !== input.contentHash) throw new Error("The revision content hash is stale."); }
  else if (action.moduleId === "links" && action.id === "destination-publish") { const route = await owned(store, userId, input.routeId, "links", "link-route", "routeId"); const destination = await owned(store, userId, input.destinationVersionId, "links", "destination-version", "destinationVersionId"); if (destination.data.routeId !== route.id || destination.data.contentHash !== input.contentHash) throw new Error("The destination is not the exact reviewed route version."); }
  else if (action.moduleId === "links" && action.id === "route-disable") await owned(store, userId, input.routeId, "links", "link-route", "routeId");
}

async function preview(store: SuiteStore, auth: CoreBusinessAuthorization, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  await validateRisky(store, auth, action, input); const record = await create(store, auth.userId, { moduleId: action.moduleId, recordType: "dry-run-preview", title: `Preview · ${action.title}`, state: "preview", data: { actionId: action.id, payloadHash: digest(input), externalEffectExecuted: false, destructiveMutationApplied: false, createdAt: now } });
  return output(action, [record], { dryRun: true, previewId: record.id, externalEffectExecuted: false, destructiveMutationApplied: false, payloadHash: digest(input) });
}

async function automate(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "workflow-version-create") {
    const steps = input.steps as Array<Record<string, unknown>>; const keys = steps.map((step, index) => { if (typeof step.key !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(step.key)) throw new Error(`steps[${index}].key must be a stable key.`); return step.key; });
    if (new Set(keys).size !== keys.length) throw new Error("Workflow step keys must be unique."); const edges = new Map<string, string[]>();
    steps.forEach((step) => { const deps = step.dependsOn === undefined ? [] : list(step.dependsOn, `step ${step.key} dependencies`); if (deps.some((key) => !keys.includes(key) || key === step.key)) throw new Error("Workflow dependencies must reference other declared steps."); edges.set(String(step.key), deps); });
    const seen = new Set<string>(); const visiting = new Set<string>(); const visit = (key: string) => { if (visiting.has(key)) throw new Error("Workflow dependencies cannot contain a cycle."); if (seen.has(key)) return; visiting.add(key); for (const dependency of edges.get(key) ?? []) visit(dependency); visiting.delete(key); seen.add(key); }; keys.forEach(visit);
    const snapshot = { name: input.name, triggerSchema: input.triggerSchema, steps }; const contentHash = digest(snapshot); const workflow = await create(store, userId, { moduleId: "automate", recordType: "workflow-version", title: String(input.name), state: "draft", data: { version: 1, snapshot, contentHash, createdAt: now, immutableAfterPublication: true } });
    return output(action, [workflow], { workflowVersionId: workflow.id, version: 1, contentHash });
  }
  if (action.id === "trigger-event-validate") { const workflow = await owned(store, userId, input.workflowVersionId, "automate", "workflow-version", "workflowVersionId"); const schema = plain((workflow.data.snapshot as Record<string, unknown>).triggerSchema, "triggerSchema"); const event = plain(input.event, "event"); const missing = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string" && !(key in event)) : []; return output(action, [workflow], { valid: missing.length === 0, missing, mutationApplied: false }, "read"); }
  if (action.id === "workflow-publish") { const workflow = await owned(store, userId, input.workflowVersionId, "automate", "workflow-version", "workflowVersionId"); if (workflow.state === "published") return output(action, [workflow], { workflowVersionId: workflow.id, alreadyPublished: true }); const published = await update(store, userId, workflow.id, { state: "published", data: { publishedAt: now, approvedContentHash: input.contentHash } }); return output(action, [published], { workflowVersionId: published.id, contentHash: input.contentHash }); }
  if (action.id === "workflow-run-simulate") { const workflow = await owned(store, userId, input.workflowVersionId, "automate", "workflow-version", "workflowVersionId"); const steps = ((workflow.data.snapshot as Record<string, unknown>).steps as Array<Record<string, unknown>>).map((step) => ({ key: step.key, outcome: "not-executed", connectorCalled: false })); const run = await create(store, userId, { moduleId: "automate", recordType: "workflow-run", title: `Simulation · ${workflow.title}`, state: "simulated", data: { workflowVersionId: workflow.id, workflowContentHash: workflow.data.contentHash, eventHash: digest(input.event), steps, externalEffects: false, createdAt: now } }); return output(action, [run], { runId: run.id, simulated: true, externalEffects: false }); }
  if (action.id === "workflow-run-start") { const workflow = await owned(store, userId, input.workflowVersionId, "automate", "workflow-version", "workflowVersionId"); const run = await create(store, userId, { moduleId: "automate", recordType: "workflow-run", title: `Run · ${workflow.title}`, state: "approved-pending-executor", data: { workflowVersionId: workflow.id, workflowContentHash: workflow.data.contentHash, event: input.event, eventHash: digest(input.event), createdAt: now } }); return output(action, [run], { runId: run.id, outboundPayload: { runId: run.id, workflowVersionId: workflow.id, workflowContentHash: workflow.data.contentHash, event: input.event } }); }
  if (action.id === "webhook-event-ingest") { const duplicate = (await completeCoreScan(store, userId, "automate", "trigger-event")).find((record) => record.data.endpointId === input.endpointId && record.data.deliveryId === input.deliveryId); if (duplicate) { if (duplicate.data.bodyHash !== input.bodyHash) throw new Error("The webhook delivery ID was reused with a different body."); return output(action, [duplicate], { eventId: duplicate.id, duplicateDelivery: true }); } const event = await create(store, userId, { moduleId: "automate", recordType: "trigger-event", title: String(input.deliveryId), state: "verified-envelope", data: { endpointId: input.endpointId, deliveryId: input.deliveryId, bodyHash: input.bodyHash, receivedAt: iso(input, "receivedAt"), signatureVerifiedAtHostingLayer: true } }); return output(action, [event], { eventId: event.id, duplicateDelivery: false }); }
  if (action.id === "run-export") return exportOne(store, userId, action, input.runId, "automate", "workflow-run", input.format, now);
  throw new Error("Automate action is not implemented.");
}

async function publish(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "channel-binding-preview") return output(action, [], { provider: input.provider, accountRefHash: digest(input.accountRef), capabilities: [...new Set(input.capabilities as string[])].sort(), tokenStored: false, providerCalled: false }, "read");
  if (action.id === "campaign-draft") { const snapshot = { name: input.name, goal: input.goal, audience: input.audience, channelIds: [...new Set(input.channelIds as string[])].sort() }; const campaign = await create(store, userId, { moduleId: "publish", recordType: "campaign", title: String(input.name), state: "draft", data: { version: 1, snapshot, contentHash: digest(snapshot), createdAt: now } }); return output(action, [campaign], { campaignId: campaign.id, contentHash: campaign.data.contentHash }); }
  if (action.id === "campaign-approve") { const campaign = await owned(store, userId, input.campaignId, "publish", "campaign", "campaignId"); if (campaign.data.contentHash !== input.contentHash) throw new Error("The campaign content hash is stale."); const approved = await update(store, userId, campaign.id, { state: "approved", data: { approvedContentHash: input.contentHash, approvedAt: now } }); return output(action, [approved], { campaignId: approved.id, approvedContentHash: input.contentHash }); }
  if (action.id === "post-schedule") { const campaign = await owned(store, userId, input.campaignId, "publish", "campaign", "campaignId"); if (campaign.state !== "approved" || campaign.data.approvedContentHash !== input.campaignHash) throw new Error("The post must use the exact approved campaign snapshot."); if (new Date(String(input.scheduledAt)).getTime() <= new Date(now).getTime()) throw new Error("scheduledAt must be in the future."); const post = await create(store, userId, { moduleId: "publish", recordType: "scheduled-post", title: String(input.content).slice(0, 200), state: "scheduled", data: { campaignId: campaign.id, campaignHash: input.campaignHash, channelId: input.channelId, content: input.content, contentHash: digest(input.content), scheduledAt: iso(input, "scheduledAt"), createdAt: now } }); return output(action, [post], { scheduledPostId: post.id, contentHash: post.data.contentHash, providerCalled: false }); }
  if (action.id === "publication-dispatch") { const post = await owned(store, userId, input.scheduledPostId, "publish", "scheduled-post", "scheduledPostId"); const delivery = await create(store, userId, { moduleId: "publish", recordType: "publication-delivery", title: `Delivery · ${post.title}`, state: "approved-pending-executor", data: { scheduledPostId: post.id, campaignId: post.data.campaignId, channelId: post.data.channelId, content: post.data.content, contentHash: post.data.contentHash, approvedAt: now } }); return output(action, [delivery, post], { deliveryId: delivery.id, outboundPayload: { deliveryId: delivery.id, scheduledPostId: post.id, channelId: post.data.channelId, content: post.data.content, contentHash: post.data.contentHash } }); }
  if (action.id === "metrics-import") { const post = await owned(store, userId, input.scheduledPostId, "publish", "scheduled-post", "scheduledPostId"); const metrics = plain(input.metrics, "metrics"); if (Object.values(metrics).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Metrics must be nonnegative finite numbers."); const observation = await create(store, userId, { moduleId: "publish", recordType: "metric-observation", title: `${input.source} · ${post.title}`, state: "observed", data: { scheduledPostId: post.id, campaignId: post.data.campaignId, observedAt: iso(input, "observedAt"), source: input.source, metrics, immutable: true } }); return output(action, [observation], { observationId: observation.id, causalClaim: false }); }
  if (action.id === "campaign-export") return exportOne(store, userId, action, input.campaignId, "publish", "campaign", input.format, now);
  throw new Error("Publish action is not implemented.");
}

async function inbox(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "thread-open") { await owned(store, userId, input.contactId, "crm", "contact", "contactId"); const conversation = await create(store, userId, { moduleId: "inbox", recordType: "conversation", title: String(input.subject), state: "open", data: { contactId: input.contactId, channel: input.channel, version: 1, openedAt: now } }); const message = await create(store, userId, { moduleId: "inbox", recordType: "message", title: `Opening · ${input.subject}`, state: "received", data: { conversationId: conversation.id, direction: "inbound", body: input.message, sequence: 1, occurredAt: now, immutable: true } }); return output(action, [conversation, message], { conversationId: conversation.id, messageId: message.id, version: 1 }); }
  if (action.id === "message-ingest") { const conversation = await owned(store, userId, input.conversationId, "inbox", "conversation", "conversationId"); if (conversation.state !== "open") throw new Error("Inbound messages require an open conversation."); const messages = await completeCoreScan(store, userId, "inbox", "message"); const duplicate = messages.find((record) => record.data.deliveryId === input.deliveryId); if (duplicate) return output(action, [duplicate], { messageId: duplicate.id, duplicateDelivery: true }); const count = messages.filter((record) => record.data.conversationId === conversation.id).length; const message = await create(store, userId, { moduleId: "inbox", recordType: "message", title: `Inbound · ${conversation.title}`, state: "received", data: { conversationId: conversation.id, deliveryId: input.deliveryId, senderRefHash: digest(input.senderRef), body: input.body, direction: "inbound", sequence: count + 1, occurredAt: iso(input, "receivedAt"), immutable: true } }); return output(action, [message], { messageId: message.id, duplicateDelivery: false, rawSenderRefStored: false }); }
  if (action.id === "thread-assign") { const conversation = await owned(store, userId, input.conversationId, "inbox", "conversation", "conversationId"); const version = expected(conversation, input); const assigned = await update(store, userId, conversation.id, { data: { assigneeId: input.assigneeId, version, assignedAt: now } }); return output(action, [assigned], { conversationId: assigned.id, assigneeId: input.assigneeId, version }); }
  if (action.id === "sla-policy-set") { const targets = plain(input.targets, "targets"); if (Object.values(targets).some((value) => !Number.isSafeInteger(value) || Number(value) <= 0)) throw new Error("SLA targets must be positive whole minutes."); const policy = await create(store, userId, { moduleId: "inbox", recordType: "sla-policy", title: String(input.name), state: "active", data: { targets, timeZone: input.timeZone, createdAt: now } }); return output(action, [policy], { policyId: policy.id, targets }); }
  if (action.id === "reply-send") { const conversation = await owned(store, userId, input.conversationId, "inbox", "conversation", "conversationId"); const message = await create(store, userId, { moduleId: "inbox", recordType: "message", title: `Approved reply · ${conversation.title}`, state: "approved-pending-executor", data: { conversationId: conversation.id, body: input.body, bodyHash: digest(input.body), proposalId: input.proposalId, direction: "outbound", approvedAt: now } }); return output(action, [message], { messageId: message.id, outboundPayload: { messageId: message.id, conversationId: conversation.id, channel: conversation.data.channel, body: input.body, bodyHash: message.data.bodyHash } }); }
  if (action.id === "thread-resolve") { const conversation = await owned(store, userId, input.conversationId, "inbox", "conversation", "conversationId"); const version = expected(conversation, input); const resolved = await update(store, userId, conversation.id, { state: "resolved", data: { version, resolution: input.resolution, resolvedAt: now } }); return output(action, [resolved], { conversationId: resolved.id, version, state: "resolved" }); }
  if (action.id === "conversation-export") return exportOne(store, userId, action, input.conversationId, "inbox", "conversation", "canonical-json", now, { redactionPolicy: input.redactionPolicy });
  throw new Error("Inbox action is not implemented.");
}

async function crm(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "account-upsert") { const existing = (await completeCoreScan(store, userId, "crm", "account")).find((record) => record.data.externalKey === input.externalKey); if (existing) { if (existing.title !== input.name || existing.data.domain !== input.domain) throw new Error("The external account key identifies different data."); return output(action, [existing], { accountId: existing.id, reconciled: true }); } const account = await create(store, userId, { moduleId: "crm", recordType: "account", title: String(input.name), state: "active", data: { externalKey: input.externalKey, domain: String(input.domain).toLowerCase(), createdAt: now } }); return output(action, [account], { accountId: account.id, reconciled: false }); }
  if (action.id === "contact-link") { const account = await owned(store, userId, input.accountId, "crm", "account", "accountId"); const contact = await create(store, userId, { moduleId: "crm", recordType: "contact", title: String(input.name), state: "active", data: { accountId: account.id, email: String(input.email).toLowerCase(), consentBasis: input.consentBasis, createdAt: now } }); return output(action, [contact, account], { contactId: contact.id, accountId: account.id }); }
  if (action.id === "opportunity-open") { const account = await owned(store, userId, input.accountId, "crm", "account", "accountId"); const opportunity = await create(store, userId, { moduleId: "crm", recordType: "opportunity", title: String(input.name), state: "qualified", data: { accountId: account.id, stage: "qualified", version: 1, amountMinor: input.amountMinor, currency: input.currency, expectedCloseAt: iso(input, "expectedCloseAt"), createdAt: now } }); return output(action, [opportunity], { opportunityId: opportunity.id, stage: "qualified", version: 1 }); }
  if (action.id === "opportunity-transition") { const opportunity = await owned(store, userId, input.opportunityId, "crm", "opportunity", "opportunityId"); const allowed: Record<string, string[]> = { qualified: ["evaluation", "lost"], evaluation: ["proposal", "lost"], proposal: ["won", "lost"] }; if (!(allowed[String(opportunity.data.stage)] ?? []).includes(String(input.toStage))) throw new Error("The opportunity transition is not allowed."); const version = expected(opportunity, input); const updated = await update(store, userId, opportunity.id, { state: String(input.toStage), data: { stage: input.toStage, version, transitionReason: input.reason, transitionedAt: now } }); const event = await create(store, userId, { moduleId: "crm", recordType: "opportunity-event", title: `${opportunity.data.stage} → ${input.toStage}`, state: "recorded", data: { opportunityId: opportunity.id, fromStage: opportunity.data.stage, toStage: input.toStage, reason: input.reason, version, occurredAt: now, immutable: true } }); return output(action, [updated, event], { opportunityId: updated.id, stage: input.toStage, version, eventId: event.id }); }
  if (action.id === "activity-record") { const account = await owned(store, userId, input.accountId, "crm", "account", "accountId"); const activity = await create(store, userId, { moduleId: "crm", recordType: "activity", title: `${input.kind} · ${account.title}`, state: "recorded", data: { accountId: account.id, kind: input.kind, occurredAt: iso(input, "occurredAt"), summary: input.summary, immutable: true } }); return output(action, [activity], { activityId: activity.id, accountId: account.id }); }
  if (action.id === "pipeline-forecast") { const probabilities = plain(input.stageProbabilities, "stageProbabilities"); const records = (await completeCoreScan(store, userId, "crm", "opportunity")).filter((record) => record.data.currency === input.currency && !["won", "lost"].includes(String(record.data.stage))); let totalMinor = 0; let weightedMinor = 0; for (const record of records) { const probability = probabilities[String(record.data.stage)]; if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`Missing valid probability for stage ${record.data.stage}.`); totalMinor += Number(record.data.amountMinor); weightedMinor += Math.round(Number(record.data.amountMinor) * probability); } return output(action, records, { currency: input.currency, opportunityCount: records.length, totalMinor, weightedMinor, deterministic: true }, "read"); }
  if (action.id === "crm-export") { const accounts: SuiteRecord[] = []; for (const id of input.accountIds as string[]) accounts.push(await owned(store, userId, id, "crm", "account", "accountId")); const manifestHash = digest({ ids: accounts.map((record) => record.id).sort(), format: input.format }); const job = await create(store, userId, { moduleId: "crm", recordType: "export-job", title: "CRM graph export", state: "queued", data: { accountIds: accounts.map((record) => record.id), format: input.format, manifestHash, private: true, queuedAt: now } }); return output(action, [job], { exportId: job.id, accountCount: accounts.length, manifestHash }); }
  throw new Error("CRM action is not implemented.");
}

async function dependencyEdges(store: SuiteStore, userId: string, projectId: string) { return (await completeCoreScan(store, userId, "tasks", "work-item-dependency")).filter((record) => record.data.projectId === projectId).map((record) => [String(record.data.predecessorId), String(record.data.successorId)] as const); }
async function tasks(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "project-blueprint-create") { const states = list(input.states, "states"); if (states.length < 2) throw new Error("A project needs at least two unique states."); const limits = plain(input.workInProgressLimits, "workInProgressLimits"); for (const [state, value] of Object.entries(limits)) if (!states.includes(state) || !Number.isSafeInteger(value) || Number(value) < 1) throw new Error("Work limits must be positive integers for declared states."); const project = await create(store, userId, { moduleId: "tasks", recordType: "project", title: String(input.name), state: "active", data: { states, initialState: states[0], terminalState: states.at(-1), workInProgressLimits: limits, createdAt: now } }); return output(action, [project], { projectId: project.id, states, workInProgressLimits: limits }); }
  if (action.id === "work-item-create") { const project = await owned(store, userId, input.projectId, "tasks", "project", "projectId"); const item = await create(store, userId, { moduleId: "tasks", recordType: "work-item", title: String(input.title), state: String(project.data.initialState), data: { projectId: project.id, acceptanceCriteria: input.acceptanceCriteria, priority: input.priority, dueAt: input.dueAt ? iso(input, "dueAt") : null, version: 1, createdAt: now } }); return output(action, [item], { workItemId: item.id, state: item.state, version: 1 }); }
  if (action.id === "dependency-link") { const project = await owned(store, userId, input.projectId, "tasks", "project", "projectId"); const predecessor = await owned(store, userId, input.predecessorId, "tasks", "work-item", "predecessorId"); const successor = await owned(store, userId, input.successorId, "tasks", "work-item", "successorId"); if (predecessor.id === successor.id || predecessor.data.projectId !== project.id || successor.data.projectId !== project.id) throw new Error("Dependencies must link distinct items in one project."); const adjacency = new Map<string, string[]>(); for (const [from, to] of [...await dependencyEdges(store, userId, project.id), [predecessor.id, successor.id] as const]) adjacency.set(from, [...(adjacency.get(from) ?? []), to]); const seen = new Set<string>(); const visiting = new Set<string>(); const visit = (node: string) => { if (visiting.has(node)) throw new Error("Work dependencies cannot contain a cycle."); if (seen.has(node)) return; visiting.add(node); for (const next of adjacency.get(node) ?? []) visit(next); visiting.delete(node); seen.add(node); }; [...adjacency.keys()].forEach(visit); const edge = await create(store, userId, { moduleId: "tasks", recordType: "work-item-dependency", title: `${predecessor.title} → ${successor.title}`, state: "active", data: { projectId: project.id, predecessorId: predecessor.id, successorId: successor.id, createdAt: now } }); return output(action, [edge], { dependencyId: edge.id, acyclic: true }); }
  if (action.id === "work-item-transition") { const item = await owned(store, userId, input.workItemId, "tasks", "work-item", "workItemId"); const project = await owned(store, userId, item.data.projectId, "tasks", "project", "projectId"); const states = project.data.states as string[]; const from = states.indexOf(item.state); const to = states.indexOf(String(input.toState)); if (to < 0 || Math.abs(to - from) !== 1) throw new Error("Work items may move only one configured state at a time."); if (to > from) for (const [predecessorId, successorId] of await dependencyEdges(store, userId, project.id)) if (successorId === item.id && (await owned(store, userId, predecessorId, "tasks", "work-item")).state !== project.data.terminalState) throw new Error("All predecessors must be complete."); const limit = (project.data.workInProgressLimits as Record<string, number>)[String(input.toState)]; if (limit) { const count = (await completeCoreScan(store, userId, "tasks", "work-item")).filter((record) => record.data.projectId === project.id && record.state === input.toState && record.id !== item.id).length; if (count >= limit) throw new Error("The target work limit is full."); } const version = expected(item, input); const changed = await update(store, userId, item.id, { state: String(input.toState), data: { version, transitionedAt: now } }); return output(action, [changed], { workItemId: item.id, fromState: item.state, toState: input.toState, version }); }
  if (action.id === "sprint-commit") { if (new Date(String(input.endsAt)) <= new Date(String(input.startsAt))) throw new Error("Sprint endsAt must be later than startsAt."); const project = await owned(store, userId, input.projectId, "tasks", "project", "projectId"); const items: SuiteRecord[] = []; for (const id of input.workItemIds as string[]) { const item = await owned(store, userId, id, "tasks", "work-item", "workItemId"); if (item.data.projectId !== project.id) throw new Error("Every sprint item must belong to the project."); items.push(item); } const scopeHash = digest(items.map((item) => item.id).sort()); const sprint = await create(store, userId, { moduleId: "tasks", recordType: "sprint", title: String(input.name), state: "committed", data: { projectId: project.id, startsAt: iso(input, "startsAt"), endsAt: iso(input, "endsAt"), committedWorkItemIds: items.map((item) => item.id), scopeHash, committedAt: now } }); return output(action, [sprint], { sprintId: sprint.id, scopeHash, workItemCount: items.length }); }
  if (action.id === "time-log") { const item = await owned(store, userId, input.workItemId, "tasks", "work-item", "workItemId"); const started = new Date(String(input.startedAt)); const ended = new Date(String(input.endedAt)); const minutes = (ended.getTime() - started.getTime()) / 60_000; if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 1_440) throw new Error("Time must be positive whole minutes no longer than 24 hours."); const entry = await create(store, userId, { moduleId: "tasks", recordType: "time-entry", title: `Time · ${item.title}`, state: "recorded", data: { workItemId: item.id, startedAt: started.toISOString(), endedAt: ended.toISOString(), minutes, note: input.note ?? "", createdAt: now } }); return output(action, [entry], { timeEntryId: entry.id, minutes }); }
  if (action.id === "project-export") return exportOne(store, userId, action, input.projectId, "tasks", "project", input.format, now);
  throw new Error("Tasks action is not implemented.");
}

async function feedback(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "board-create") { const board = await create(store, userId, { moduleId: "feedback", recordType: "feedback-board", title: String(input.name), state: "active", data: { visibility: input.visibility, votingPolicy: input.votingPolicy, createdAt: now } }); return output(action, [board], { boardId: board.id, visibility: input.visibility }); }
  if (action.id === "request-submit") { if (input.consent !== true) throw new Error("Feedback submission consent is required."); const board = await owned(store, userId, input.boardId, "feedback", "feedback-board", "boardId"); const request = await create(store, userId, { moduleId: "feedback", recordType: "feedback-request", title: String(input.title), state: "open", data: { boardId: board.id, problem: input.problem, consent: true, version: 1, createdAt: now } }); return output(action, [request], { requestId: request.id, state: "open", version: 1 }); }
  if (action.id === "vote-cast") { const request = await owned(store, userId, input.requestId, "feedback", "feedback-request", "requestId"); const existing = (await completeCoreScan(store, userId, "feedback", "feedback-vote")).find((record) => record.data.requestId === request.id && record.data.voterKeyHash === input.voterKeyHash); if (existing) { const changed = await update(store, userId, existing.id, { state: input.decision === "up" ? "active" : "withdrawn", data: { decision: input.decision, updatedAt: now } }); return output(action, [changed], { voteId: changed.id, reconciled: true }); } const vote = await create(store, userId, { moduleId: "feedback", recordType: "feedback-vote", title: `Vote · ${request.title}`, state: input.decision === "up" ? "active" : "withdrawn", data: { requestId: request.id, voterKeyHash: input.voterKeyHash, decision: input.decision, createdAt: now } }); return output(action, [vote], { voteId: vote.id, reconciled: false }); }
  if (action.id === "request-merge") { const target = await owned(store, userId, input.targetRequestId, "feedback", "feedback-request", "targetRequestId"); const sources: SuiteRecord[] = []; for (const id of input.sourceRequestIds as string[]) { const source = await owned(store, userId, id, "feedback", "feedback-request", "sourceRequestId"); sources.push(await update(store, userId, source.id, { state: "merged", data: { mergedIntoRequestId: target.id, mergeReason: input.reason, mergedAt: now } })); } const event = await create(store, userId, { moduleId: "feedback", recordType: "merge-event", title: `Merge into ${target.title}`, state: "recorded", data: { targetRequestId: target.id, sourceRequestIds: sources.map((source) => source.id), reason: input.reason, originalsPreserved: true, occurredAt: now } }); return output(action, [target, ...sources, event], { targetRequestId: target.id, sourceRequestIds: sources.map((source) => source.id), originalsPreserved: true }); }
  if (action.id === "status-transition") { const request = await owned(store, userId, input.requestId, "feedback", "feedback-request", "requestId"); const allowed: Record<string, string[]> = { open: ["planned", "declined"], planned: ["in-progress", "open", "declined"], "in-progress": ["shipped", "planned"] }; if (!(allowed[request.state] ?? []).includes(String(input.toStatus))) throw new Error("The feedback status transition is not allowed."); const version = expected(request, input); const changed = await update(store, userId, request.id, { state: String(input.toStatus), data: { version, publicExplanation: input.explanation, transitionedAt: now } }); return output(action, [changed], { requestId: changed.id, status: input.toStatus, version }); }
  if (action.id === "changelog-publish") { const entry = await create(store, userId, { moduleId: "feedback", recordType: "changelog-entry", title: String(input.title), state: "approved-pending-executor", data: { requestIds: input.requestIds, body: input.body, contentHash: digest({ title: input.title, body: input.body, requestIds: input.requestIds }), approvedAt: now } }); return output(action, [entry], { changelogEntryId: entry.id, outboundPayload: { changelogEntryId: entry.id, title: input.title, body: input.body, requestIds: input.requestIds, contentHash: entry.data.contentHash } }); }
  if (action.id === "impact-score") { const request = await owned(store, userId, input.requestId, "feedback", "feedback-request", "requestId"); const weights = plain(input.weights, "weights"); if (Object.values(weights).some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Impact weights must be finite numbers."); const votes = (await completeCoreScan(store, userId, "feedback", "feedback-vote")).filter((vote) => vote.data.requestId === request.id && vote.state === "active").length; const factors = { votes, accounts: Number(request.data.affectedAccounts ?? 0), urgency: Number(request.data.urgency ?? 0), effort: Number(request.data.effort ?? 0) }; const score = Math.round(Object.entries(factors).reduce((sum, [key, value]) => sum + value * Number(weights[key] ?? 0), 0)); return output(action, [request], { requestId: request.id, factors, weights, score, deterministic: true }, "read"); }
  if (action.id === "feedback-export") return exportOne(store, userId, action, input.boardId, "feedback", "feedback-board", input.format, now);
  throw new Error("Feedback action is not implemented.");
}

async function knowledge(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "library-create") { const library = await create(store, userId, { moduleId: "knowledge", recordType: "knowledge-library", title: String(input.name), state: "active", data: { defaultAccess: input.defaultAccess, locale: input.locale, reviewCadenceDays: input.reviewCadenceDays, createdAt: now } }); return output(action, [library], { libraryId: library.id, defaultAccess: input.defaultAccess }); }
  if (action.id === "page-revision-draft") { const library = await owned(store, userId, input.libraryId, "knowledge", "knowledge-library", "libraryId"); const sources: SuiteRecord[] = []; for (const id of input.sourceIds as string[]) sources.push(await owned(store, userId, id, undefined, undefined, "sourceId")); let parent: SuiteRecord | undefined; if (input.parentRevisionId) { parent = await owned(store, userId, input.parentRevisionId, "knowledge", "page-revision", "parentRevisionId"); if (parent.data.libraryId !== library.id) throw new Error("The parent revision belongs to another library."); } const contentHash = digest({ libraryId: library.id, title: input.title, content: input.content, sourceIds: sources.map((record) => record.id).sort(), parentRevisionId: parent?.id ?? null }); const revision = await create(store, userId, { moduleId: "knowledge", recordType: "page-revision", title: String(input.title), state: "draft", data: { libraryId: library.id, content: input.content, sourceIds: sources.map((record) => record.id), parentRevisionId: parent?.id ?? null, contentHash, createdAt: now, immutableAfterPublication: true } }); return output(action, [revision], { revisionId: revision.id, contentHash, sourceCount: sources.length }); }
  if (action.id === "page-revision-publish") { const revision = await owned(store, userId, input.revisionId, "knowledge", "page-revision", "revisionId"); const published = await update(store, userId, revision.id, { state: "published", data: { publishedContentHash: input.contentHash, publishedAt: now } }); return output(action, [published], { revisionId: published.id, contentHash: input.contentHash, outboundPayload: { revisionId: published.id, libraryId: published.data.libraryId, contentHash: input.contentHash } }); }
  if (action.id === "source-link") { const revision = await owned(store, userId, input.revisionId, "knowledge", "page-revision", "revisionId"); const source = await create(store, userId, { moduleId: "knowledge", recordType: "knowledge-source", title: String(input.locator).slice(0, 300), state: "observed", data: { revisionId: revision.id, locator: input.locator, observedAt: iso(input, "observedAt"), contentHash: input.contentHash, trustNote: input.trustNote, immutable: true } }); return output(action, [source], { sourceId: source.id, revisionId: revision.id }); }
  if (action.id === "permission-grant") { const library = await owned(store, userId, input.libraryId, "knowledge", "knowledge-library", "libraryId"); if (new Date(String(input.expiresAt)).getTime() <= new Date(now).getTime()) throw new Error("expiresAt must be in the future."); const grant = await create(store, userId, { moduleId: "knowledge", recordType: "knowledge-grant", title: `${input.permission} · ${library.title}`, state: "active", data: { libraryId: library.id, principalId: input.principalId, permission: input.permission, expiresAt: iso(input, "expiresAt"), createdAt: now } }); return output(action, [grant], { grantId: grant.id, libraryId: library.id, permission: input.permission }); }
  if (action.id === "page-export") return exportOne(store, userId, action, input.revisionId, "knowledge", "page-revision", input.format, now);
  if (action.id === "import-preview") { const library = await owned(store, userId, input.libraryId, "knowledge", "knowledge-library", "libraryId"); const manifest = plain(input.manifest, "manifest"); const pages = Array.isArray(manifest.pages) ? manifest.pages : []; if (pages.length > 1_000) throw new Error("Knowledge imports are limited to 1,000 pages."); return output(action, [library], { libraryId: library.id, pageCount: pages.length, manifestHash: digest(manifest), recordsCreated: 0, externalEffects: false }, "read"); }
  throw new Error("Knowledge action is not implemented.");
}

function destination(raw: unknown) { const url = new URL(String(raw)); if (url.protocol !== "https:" || url.username || url.password || ["localhost", "metadata.google.internal"].includes(url.hostname) || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) throw new Error("Destinations must be credential-free public HTTPS URLs."); return url.toString(); }
async function links(store: SuiteStore, userId: string, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.id === "route-create") { const routeKey = `${String(input.hostname).toLowerCase()}/${input.slug}`; if ((await completeCoreScan(store, userId, "links", "link-route")).some((record) => record.data.routeKey === routeKey && record.state !== "disabled")) throw new Error("The route is already active in this workspace."); const route = await create(store, userId, { moduleId: "links", recordType: "link-route", title: routeKey, state: "draft", data: { hostname: String(input.hostname).toLowerCase(), slug: input.slug, routeKey, privacyMode: input.privacyMode, version: 1, activeDestinationVersionId: null, createdAt: now } }); return output(action, [route], { routeId: route.id, routeKey, privacyMode: input.privacyMode }); }
  if (action.id === "destination-version-create") { const route = await owned(store, userId, input.routeId, "links", "link-route", "routeId"); const target = destination(input.destination); const content = { routeId: route.id, destination: target, campaign: input.campaign }; const version = await create(store, userId, { moduleId: "links", recordType: "destination-version", title: target, state: "draft", data: { ...content, contentHash: digest(content), createdAt: now, immutableAfterPublication: true } }); return output(action, [version], { destinationVersionId: version.id, contentHash: version.data.contentHash }); }
  if (action.id === "destination-publish") { const route = await owned(store, userId, input.routeId, "links", "link-route", "routeId"); const version = await owned(store, userId, input.destinationVersionId, "links", "destination-version", "destinationVersionId"); const active = await update(store, userId, route.id, { state: "active", data: { activeDestinationVersionId: version.id, activeContentHash: input.contentHash, version: Number(route.data.version ?? 1) + 1, publishedAt: now } }); const published = await update(store, userId, version.id, { state: "published", data: { publishedAt: now } }); return output(action, [active, published], { routeId: active.id, destinationVersionId: published.id, outboundPayload: { routeId: active.id, routeKey: active.data.routeKey, destination: published.data.destination, contentHash: input.contentHash } }); }
  if (action.id === "redirect-resolve") { const route = await owned(store, userId, input.routeId, "links", "link-route", "routeId"); if (route.state !== "active" || !route.data.activeDestinationVersionId) throw new Error("The route is not active."); const version = await owned(store, userId, route.data.activeDestinationVersionId, "links", "destination-version", "destinationVersionId"); return output(action, [route, version], { routeId: route.id, destination: version.data.destination, contentHash: version.data.contentHash, eventRecorded: false }, "read"); }
  if (action.id === "event-ingest") { const route = await owned(store, userId, input.routeId, "links", "link-route", "routeId"); const dimensions = plain(input.dimensions, "dimensions"); if (Object.keys(dimensions).some((key) => /ip|fingerprint|email|name|address/i.test(key))) throw new Error("Link events cannot contain raw identity or fingerprint dimensions."); const duplicate = (await completeCoreScan(store, userId, "links", "link-event")).find((record) => record.data.eventId === input.eventId); if (duplicate) return output(action, [duplicate], { linkEventId: duplicate.id, duplicateEvent: true }); const event = await create(store, userId, { moduleId: "links", recordType: "link-event", title: String(input.eventId), state: "observed", data: { routeId: route.id, eventId: input.eventId, occurredAt: iso(input, "occurredAt"), kind: input.kind, dimensions, privacyMode: route.data.privacyMode, rawIdentityStored: false } }); return output(action, [event], { linkEventId: event.id, duplicateEvent: false, rawIdentityStored: false }); }
  if (action.id === "experiment-allocate") { const variants = (input.variants as Array<Record<string, unknown>>).map((variant, index) => { if (typeof variant.key !== "string" || !variant.key || typeof variant.weight !== "number" || !Number.isSafeInteger(variant.weight) || variant.weight <= 0) throw new Error(`variants[${index}] needs a key and positive integer weight.`); return { key: variant.key, weight: variant.weight }; }); const total = variants.reduce((sum, item) => sum + item.weight, 0); const bucket = Number.parseInt(digest({ experimentId: input.experimentId, visitorKeyHash: input.visitorKeyHash }).slice(0, 12), 16) % total; let cursor = 0; const selected = variants.find((item) => { cursor += item.weight; return bucket < cursor; })!; return output(action, [], { experimentId: input.experimentId, selectedVariant: selected.key, allocationHash: digest({ experimentId: input.experimentId, visitorKeyHash: input.visitorKeyHash, variants }), deterministic: true, eventRecorded: false }, "read"); }
  if (action.id === "route-disable") { const route = await owned(store, userId, input.routeId, "links", "link-route", "routeId"); const disabled = await update(store, userId, route.id, { state: "disabled", data: { disabledReason: input.reason, disabledAt: now, activeDestinationVersionId: null, version: Number(route.data.version ?? 1) + 1 } }); return output(action, [disabled], { routeId: disabled.id, state: "disabled", historyRetained: true }); }
  if (action.id === "analytics-export") { const routes: SuiteRecord[] = []; for (const id of input.routeIds as string[]) routes.push(await owned(store, userId, id, "links", "link-route", "routeId")); if (new Date(String(input.to)) <= new Date(String(input.from))) throw new Error("Export to must be later than from."); const manifestHash = digest(input); const job = await create(store, userId, { moduleId: "links", recordType: "export-job", title: "Route analytics export", state: "queued", data: { routeIds: routes.map((record) => record.id), from: iso(input, "from"), to: iso(input, "to"), format: input.format, aggregateOnly: true, rawVisitorIdentifiers: false, manifestHash, queuedAt: now } }); return output(action, [job], { exportId: job.id, manifestHash, aggregateOnly: true }); }
  throw new Error("Links action is not implemented.");
}

async function command(store: SuiteStore, auth: CoreBusinessAuthorization, action: CoreBusinessActionDefinition, input: Record<string, unknown>, now: string) {
  if (action.moduleId === "automate") return automate(store, auth.userId, action, input, now);
  if (action.moduleId === "publish") return publish(store, auth.userId, action, input, now);
  if (action.moduleId === "inbox") return inbox(store, auth.userId, action, input, now);
  if (action.moduleId === "crm") return crm(store, auth.userId, action, input, now);
  if (action.moduleId === "tasks") return tasks(store, auth.userId, action, input, now);
  if (action.moduleId === "feedback") return feedback(store, auth.userId, action, input, now);
  if (action.moduleId === "knowledge") return knowledge(store, auth.userId, action, input, now);
  return links(store, auth.userId, action, input, now);
}

async function external(store: SuiteStore, auth: CoreBusinessAuthorization, execution: CoreBusinessExecutionResult, approvalRecord: CoreBusinessApproval, deps: CoreBusinessEngineDependencies) {
  const payload = execution.audit.outboundPayload; if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("The approved external command did not produce a bounded payload.");
  const request: CoreBusinessExternalRequest = { requestId: randomUUID(), workspaceId: auth.workspaceId, actorUserId: auth.userId, moduleId: execution.action.moduleId, actionId: execution.action.id, payloadHash: digest(payload), payload: payload as Record<string, unknown>, approval: approvalRecord };
  if (!deps.externalExecutor) return { ...execution, audit: { ...execution.audit, externalEffectExecuted: false, executorConfigured: false, outboundRequestId: request.requestId, outboundPayloadHash: request.payloadHash, state: "approved-pending-executor" } };
  const receipt = await deps.externalExecutor(request); const receiptRecord = await create(store, auth.userId, { moduleId: execution.action.moduleId, recordType: "external-effect-receipt", title: `${receipt.provider} · ${execution.action.title}`, state: receipt.status, data: { actionId: execution.action.id, requestId: request.requestId, payloadHash: request.payloadHash, provider: receipt.provider, externalId: receipt.externalId, status: receipt.status, occurredAt: receipt.occurredAt, evidence: receipt.evidence ?? {}, approvalDecisionId: approvalRecord.decisionId, immutable: true } });
  return { ...execution, records: [...execution.records, receiptRecord], audit: { ...execution.audit, externalEffectExecuted: true, executorConfigured: true, outboundRequestId: request.requestId, outboundPayloadHash: request.payloadHash, externalReceiptId: receiptRecord.id, providerStatus: receipt.status } };
}

export async function executeCoreBusinessAction(store: SuiteStore, auth: CoreBusinessAuthorization, moduleId: string, actionId: string, input: Record<string, unknown>, deps: CoreBusinessEngineDependencies = defaults): Promise<CoreBusinessExecutionResult> {
  const action = coreBusinessAction(moduleId, actionId); if (!action) throw new Error("The core business action does not exist."); validate(input, action.inputSchema as unknown as Record<string, unknown>, "input");
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId || workspace.currentRole !== auth.role) throw new Error("The authorization workspace or role no longer matches the actor's tenant.");
    const scopedStore = visibilityScopedStore(store, auth);
    await authorize(scopedStore, auth, action);
    const trustedNow = deps.now();
    if (!(trustedNow instanceof Date) || !Number.isFinite(trustedNow.getTime())) throw new Error("The trusted server clock is invalid.");
    const now = trustedNow.toISOString();
    if (action.operation === "read") return command(scopedStore, auth, action, input, now);
    const key = String(input.idempotencyKey); const requestHash = digest({ workspaceId: auth.workspaceId, actorUserId: auth.userId, moduleId, actionId, input });
    return locked(`core-business:${auth.workspaceId}`, async () => {
      const prior = await replay(scopedStore, auth, action, key, requestHash); if (prior) return prior;
      if (action.operation === "ai") return saveReceipt(scopedStore, auth, action, key, requestHash, await queueAi(scopedStore, auth, action, input, deps));
      let execution: CoreBusinessExecutionResult;
      if (action.destructive || action.externalEffect) {
        if (input.dryRun === true) execution = await preview(scopedStore, auth, action, input, now);
        else {
          const approved = approval(input, auth, trustedNow);
          await assertApprovalUnused(scopedStore, auth, approved.decisionId);
          await validateRisky(scopedStore, auth, action, input);
          execution = await command(scopedStore, auth, action, input, now);
          execution.audit = { ...execution.audit, dryRun: false, approvalDecisionId: approved.decisionId, approvedBy: approved.approvedBy, approvedAt: approved.approvedAt, approvalReason: approved.reason };
          if (action.externalEffect) execution = await external(scopedStore, auth, execution, approved, deps);
        }
      } else execution = await command(scopedStore, auth, action, input, now);
      return saveReceipt(scopedStore, auth, action, key, requestHash, execution);
    });
  });
}

function snapshotActions() {
  return coreBusinessActions.map((action) => ({ moduleId: action.moduleId, actionId: action.id, schemaDigest: digest(action.inputSchema), ...(action.promptId ? { promptId: action.promptId, promptVersion: action.promptVersion } : {}) })).sort((left, right) => `${left.moduleId}:${left.actionId}`.localeCompare(`${right.moduleId}:${right.actionId}`));
}
function snapshotPayload(snapshot: Omit<CoreBusinessSnapshot, "snapshotHash"> | CoreBusinessSnapshot) { const { snapshotHash: _snapshotHash, ...payload } = snapshot as CoreBusinessSnapshot; return payload; }
function safeSnapshotValue(value: unknown, path: string, depth = 0): void {
  if (depth > 32) throw new Error(`${path} exceeds the snapshot nesting limit.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number.`); return; }
  if (Array.isArray(value)) { if (value.length > 100_000) throw new Error(`${path} contains too many items.`); value.forEach((item, index) => safeSnapshotValue(item, `${path}[${index}]`, depth + 1)); return; }
  if (!value || typeof value !== "object") throw new Error(`${path} contains a non-JSON value.`);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) { if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${path} contains a forbidden object key.`); safeSnapshotValue(item, `${path}.${key}`, depth + 1); }
}
function validId(value: unknown) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validTime(value: unknown) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(new Date(value).getTime()); }

export function validateCoreBusinessSnapshot(value: unknown, expectedWorkspaceId: string): CoreBusinessSnapshot {
  const snapshot = plain(value, "snapshot") as unknown as CoreBusinessSnapshot;
  const allowed = new Set(["version", "workspaceId", "exportedAt", "actionCatalogDigest", "actions", "records", "aiActions", "snapshotHash"]);
  if (Object.keys(snapshot).some((key) => !allowed.has(key))) throw new Error("The snapshot contains unknown top-level fields.");
  if (snapshot.version !== "core-business-snapshot.v1") throw new Error("The core business snapshot version is unsupported.");
  if (snapshot.workspaceId !== expectedWorkspaceId || !validId(snapshot.workspaceId)) throw new Error("The snapshot belongs to a different or malformed workspace.");
  if (!validTime(snapshot.exportedAt)) throw new Error("The snapshot export time is malformed.");
  if (!Array.isArray(snapshot.actions) || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.aiActions) || snapshot.records.length > 100_000 || snapshot.aiActions.length > 100_000) throw new Error("The snapshot collections are malformed or too large.");
  safeSnapshotValue(snapshot, "snapshot");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 64 * 1024 * 1024) throw new Error("The snapshot exceeds the 64 MiB import limit.");
  const expectedActions = snapshotActions(); const catalogDigest = digest(expectedActions);
  if (snapshot.actionCatalogDigest !== catalogDigest || digest(snapshot.actions) !== catalogDigest) throw new Error("The snapshot action catalogue does not match this engine version.");
  const moduleIds = new Set<CoreBusinessModuleId>(["automate", "publish", "inbox", "crm", "tasks", "feedback", "knowledge", "links"]);
  const recordIds = new Set<string>();
  for (const record of snapshot.records) {
    if (!validId(record.id) || recordIds.has(record.id)) throw new Error("The snapshot contains a malformed or duplicate record ID."); recordIds.add(record.id);
    if (record.workspaceId !== expectedWorkspaceId || !moduleIds.has(record.moduleId as CoreBusinessModuleId)) throw new Error("The snapshot contains a cross-tenant or unknown-module record.");
    if (typeof record.recordType !== "string" || !/^[a-z][a-z0-9-]{1,79}$/.test(record.recordType) || typeof record.title !== "string" || record.title.length > 1_000 || typeof record.state !== "string" || record.state.length > 100 || !validTime(record.createdAt) || !validTime(record.updatedAt)) throw new Error("The snapshot contains malformed record metadata.");
    plain(record.data, `record ${record.id} data`);
    if (record.recordType === "command-receipt" && (!coreBusinessAction(record.moduleId, String(record.data.actionId)) || typeof record.data.idempotencyKey !== "string" || typeof record.data.requestHash !== "string")) throw new Error("The snapshot contains a malformed command receipt.");
  }
  const aiActionIds = new Set<string>(); const receiptAiIds = new Set(snapshot.records.filter((record) => record.recordType === "command-receipt" && typeof record.data.aiActionId === "string").map((record) => String(record.data.aiActionId)));
  for (const aiAction of snapshot.aiActions) {
    if (!validId(aiAction.id) || aiActionIds.has(aiAction.id) || aiAction.workspaceId !== expectedWorkspaceId || !moduleIds.has(aiAction.moduleId as CoreBusinessModuleId) || !["queued", "running", "completed", "failed"].includes(aiAction.status) || typeof aiAction.goal !== "string" || !validTime(aiAction.createdAt) || !validTime(aiAction.updatedAt)) throw new Error("The snapshot contains malformed or cross-tenant AI action state.");
    if (!receiptAiIds.has(aiAction.id)) throw new Error("The snapshot contains AI action state without its command receipt."); aiActionIds.add(aiAction.id); plain(aiAction.context, `AI action ${aiAction.id} context`);
  }
  for (const id of receiptAiIds) if (!aiActionIds.has(id)) throw new Error("The snapshot command receipt references missing AI action state.");
  if (typeof snapshot.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.snapshotHash) || digest(snapshotPayload(snapshot)) !== snapshot.snapshotHash) throw new Error("The snapshot integrity hash is invalid.");
  return structuredClone(snapshot);
}

async function snapshotAuthorization(store: SuiteStore, auth: CoreBusinessAuthorization, write: boolean) {
  const workspace = await store.getOrCreateWorkspace(auth.userId);
  if (workspace.id !== auth.workspaceId || workspace.currentRole !== auth.role) throw new Error("The snapshot actor does not belong to the requested workspace.");
  if (write && auth.role !== "owner") throw new Error("Only the workspace owner can replace a core business snapshot.");
  if (!auth.scopes.includes("*") && modulesForSnapshot.some((moduleId) => !auth.scopes.includes(`${moduleId}:read`))) throw new Error("Snapshot access requires read scope for every core module.");
}
const modulesForSnapshot: CoreBusinessModuleId[] = ["automate", "publish", "inbox", "crm", "tasks", "feedback", "knowledge", "links"];

export async function exportCoreBusinessSnapshot(store: SuiteStore, auth: CoreBusinessAuthorization, exportedAt = new Date()): Promise<CoreBusinessSnapshot> {
  await snapshotAuthorization(store, auth, false); const records = new Map<string, SuiteRecord>();
  for (const moduleId of modulesForSnapshot) {
    const moduleRecords = await store.listRecords(auth.userId, { moduleId, limit: 100_001 });
    if (moduleRecords.length > 100_000) throw new Error(`The ${moduleId} module is too large for one complete core business snapshot.`);
    for (const record of moduleRecords) { if (record.workspaceId !== auth.workspaceId) throw new Error("The store returned a cross-tenant record during snapshot export."); records.set(record.id, record); }
  }
  if (records.size > 100_000) throw new Error("The workspace is too large for one core business snapshot.");
  const aiActions: SuiteAiAction[] = [];
  for (const record of records.values()) if (record.recordType === "command-receipt" && typeof record.data.aiActionId === "string") { const action = await store.getAiAction(auth.userId, record.data.aiActionId); if (!action || action.workspaceId !== auth.workspaceId) throw new Error("A command receipt references missing or cross-tenant AI action state."); aiActions.push(action); }
  const actions = snapshotActions();
  const exportedRecords = [...records.values()].map((record) => canonical(record) as SuiteRecord).sort((a, b) => a.id.localeCompare(b.id));
  const exportedAiActions = aiActions.map((action) => canonical(action) as SuiteAiAction).sort((a, b) => a.id.localeCompare(b.id));
  const payload: Omit<CoreBusinessSnapshot, "snapshotHash"> = { version: "core-business-snapshot.v1", workspaceId: auth.workspaceId, exportedAt: exportedAt.toISOString(), actionCatalogDigest: digest(actions), actions, records: exportedRecords, aiActions: exportedAiActions };
  const snapshot = { ...payload, snapshotHash: digest(payload) }; return validateCoreBusinessSnapshot(snapshot, auth.workspaceId);
}

export function suiteStoreCoreBusinessStorage(store: SuiteStore): CoreBusinessStorageAdapter {
  return { transaction: (context, work) => locked(`core-business-storage:${context.workspaceId}`, async () => { const workspace = await store.getOrCreateWorkspace(context.actorUserId); if (workspace.id !== context.workspaceId) throw new Error("The storage transaction actor belongs to another workspace."); return work({ store }); }) };
}

export async function executeCoreBusinessActionWithStorage(storage: CoreBusinessStorageAdapter, auth: CoreBusinessAuthorization, moduleId: string, actionId: string, input: Record<string, unknown>, deps: CoreBusinessEngineDependencies = defaults) {
  const action = coreBusinessAction(moduleId, actionId); if (!action) throw new Error("The core business action does not exist.");
  return storage.transaction({ workspaceId: auth.workspaceId, actorUserId: auth.userId, idempotencyKey: action.operation === "read" ? undefined : String(input.idempotencyKey ?? ""), readOnly: action.operation === "read" }, ({ store }) => executeCoreBusinessAction(store, auth, moduleId, actionId, input, deps));
}

export async function exportCoreBusinessSnapshotWithStorage(storage: CoreBusinessStorageAdapter, auth: CoreBusinessAuthorization, exportedAt = new Date()) {
  return storage.transaction({ workspaceId: auth.workspaceId, actorUserId: auth.userId, readOnly: true }, ({ store }) => exportCoreBusinessSnapshot(store, auth, exportedAt));
}

export async function importCoreBusinessSnapshotWithStorage(storage: CoreBusinessStorageAdapter, auth: CoreBusinessAuthorization, value: unknown) {
  const snapshot = validateCoreBusinessSnapshot(value, auth.workspaceId);
  return storage.transaction({ workspaceId: auth.workspaceId, actorUserId: auth.userId, readOnly: false }, async (session) => { await snapshotAuthorization(session.store, auth, true); if (!session.replaceSnapshot) throw new Error("This storage adapter does not support atomic snapshot replacement."); await session.replaceSnapshot(snapshot); return { workspaceId: snapshot.workspaceId, snapshotHash: snapshot.snapshotHash, recordCount: snapshot.records.length, aiActionCount: snapshot.aiActions.length }; });
}

export function coreBusinessScope(moduleId: CoreBusinessModuleId, scope: CoreBusinessScope) { return `${moduleId}:${scope}`; }
