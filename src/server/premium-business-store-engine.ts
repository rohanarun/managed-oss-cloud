import { createHash, randomUUID } from "node:crypto";
import type { SuiteAiAction, SuiteRecord, SuiteWorkspaceRole } from "../shared/suite.js";
import {
  premiumBusinessAction,
  premiumBusinessActions,
  premiumBusinessModuleById,
  premiumPlanAllows,
  type PremiumActionDefinition,
  type PremiumActionIdFor,
  type PremiumModuleId,
} from "../shared/premium-business-actions.js";
import type { SuiteStore } from "./suite-store.js";
import { premiumBusinessPromptDigest, premiumBusinessPromptPolicies } from "./prompts/premium-business.js";
import { suiteStorageAccounting } from "../shared/suite-quotas.js";

export interface PremiumBusinessAuthorization {
  userId: string;
  workspaceId: string;
  role: SuiteWorkspaceRole;
  scopes: string[];
}

export interface PremiumBusinessStoreDependencies {
  now: () => Date;
}

export interface PremiumBusinessStoreResult {
  kind: "read" | "command" | "ai-action";
  action: PremiumActionDefinition;
  records: SuiteRecord[];
  audit: Record<string, unknown>;
  preview?: Record<string, unknown>;
  privateOutput?: Record<string, unknown>;
  aiAction?: SuiteAiAction;
}

export interface PremiumBusinessAiCompletion {
  output: { summary: string; claims: Array<{ text: string; evidenceIds: string[] }> };
  confidence: number;
  evidenceIds: string[];
  promptVersion: string;
  modelId: string;
  reviewStatus: "pending-human-review";
  approvalRequired: true;
}

export const premiumBusinessAiResultContract = {
  version: "premium-business-ai-result.v1",
  required: ["output", "confidence", "evidenceIds", "promptVersion", "modelId", "reviewStatus", "approvalRequired"],
  claimEvidenceRequired: true,
  reviewStatus: "pending-human-review",
  approvalRequired: true,
} as const;

const receiptType = "premium-command-receipt";
const aiAuditType = "premium-ai-request-audit";
const forbiddenKeys = new Set(["apikey", "secret", "password", "accesstoken", "refreshtoken", "authorization", "cookie", "privatekey", "providersecret"]);
const stateTransitions: Record<string, readonly string[]> = { backlog: ["ready"], ready: ["active"], active: ["blocked", "done"], blocked: ["active"], done: [] };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex"); }
function plain(value: unknown, label: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function normalized(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function inspect(value: unknown, label = "input", depth = 0, seen = new WeakSet<object>()): void {
  if (depth > 16) throw new Error(`${label} is nested too deeply.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (value.length > 40_000) throw new Error(`${label} contains an oversized string.`); if (/^\s*(?:javascript|data\s*:\s*text\/html)\s*:/i.test(value) || /<\s*script\b/i.test(value)) throw new Error(`${label} contains executable content.`); return; }
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new Error(`${label} contains an unsafe number.`); return; }
  if (typeof value !== "object") throw new Error(`${label} contains a non-JSON value.`);
  if (seen.has(value as object)) throw new Error(`${label} contains a cycle.`); seen.add(value as object);
  if (Array.isArray(value)) { if (value.length > 500) throw new Error(`${label} contains too many items.`); value.forEach((item) => inspect(item, label, depth + 1, seen)); }
  else for (const [key, item] of Object.entries(value as Record<string, unknown>)) { if (["__proto__", "prototype", "constructor"].includes(key) || forbiddenKeys.has(normalized(key))) throw new Error(`${label}.${key} is not allowed.`); inspect(item, label, depth + 1, seen); }
  seen.delete(value as object);
  if (depth === 0 && Buffer.byteLength(JSON.stringify(value), "utf8") > 256_000) throw new Error(`${label} exceeds 256000 bytes.`);
}
function validateValue(value: unknown, schema: Record<string, unknown>, path: string) {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} is not allowed.`);
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format.`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(`${path} is too long.`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${path} must be a UUID.`);
    if (schema.format === "date-time" && !Number.isFinite(new Date(value).getTime())) throw new Error(`${path} must be a date-time.`);
  }
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value) || (typeof schema.minimum === "number" && value < schema.minimum) || (typeof schema.maximum === "number" && value > schema.maximum))) throw new Error(`${path} must be an in-range safe integer.`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be boolean.`);
  if (schema.type === "array" && !Array.isArray(value)) throw new Error(`${path} must be an array.`);
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${path} must be an object.`);
}
function validateInput(action: PremiumActionDefinition, input: Record<string, unknown>) {
  inspect(input);
  const properties = action.inputSchema.properties;
  for (const key of Object.keys(input)) if (!properties[key]) throw new Error(`input.${key} is not allowed.`);
  for (const key of action.inputSchema.required) if (!(key in input)) throw new Error(`input.${key} is required.`);
  for (const [key, value] of Object.entries(input)) validateValue(value, properties[key] as Record<string, unknown>, `input.${key}`);
}
function text(input: Record<string, unknown>, key: string, maximum = 20_000) { const value = input[key]; if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${key} must be a non-empty string no longer than ${maximum} characters.`); return value.trim(); }
function integer(input: Record<string, unknown>, key: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { const value = input[key]; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be a safe integer from ${minimum} to ${maximum}.`); return value; }
function iso(input: Record<string, unknown>, key: string) { const value = text(input, key, 80); const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error(`${key} must be an ISO date-time.`); return date; }
function strings(value: unknown, key: string, maximum = 200) { if (!Array.isArray(value) || !value.length || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${key} must contain 1 to ${maximum} strings.`); const result = value.map(String); if (new Set(result).size !== result.length) throw new Error(`${key} must be unique.`); return result; }
function recordVersion(record: SuiteRecord) { const version = Number(record.data.version ?? 1); if (!Number.isSafeInteger(version) || version < 1) throw new Error("The durable record version is invalid."); return version; }
function expected(record: SuiteRecord, input: Record<string, unknown>) { const supplied = integer(input, "expectedVersion", 1); if (recordVersion(record) !== supplied) throw new Error(`The ${record.recordType} version is stale.`); return supplied; }

async function authorize(store: SuiteStore, auth: PremiumBusinessAuthorization, action: PremiumActionDefinition) {
  const workspace = await store.getOrCreateWorkspace(auth.userId);
  if (workspace.id !== auth.workspaceId) throw new Error("The authorization workspace does not match the actor's tenant.");
  if (workspace.currentRole !== auth.role) throw new Error("The authorization role is stale.");
  const module = premiumBusinessModuleById.get(action.moduleId);
  if (!module || !premiumPlanAllows(workspace.plan, module)) throw new Error(`${module?.name ?? action.moduleId} requires the $${module?.minimumMonthlyPlanUsd ?? 200}/month ${module?.minPlan ?? "fleet"} plan.`);
  if (!workspace.enabledModuleIds.includes(action.moduleId)) throw new Error("The premium module is not enabled for this workspace.");
  if (!auth.scopes.includes("*") && !auth.scopes.includes(`${action.moduleId}:${action.requiredScope}`)) throw new Error(`The ${action.moduleId}:${action.requiredScope} scope is required.`);
  if (auth.role === "viewer" && action.operation !== "read") throw new Error("Viewers cannot mutate or queue model work.");
  if ((action.requiresApproval || action.destructive || action.externalEffect !== "none") && !["owner", "admin"].includes(auth.role)) throw new Error("Only owners or administrators may authorize this action.");
  return workspace;
}
async function owned(store: SuiteStore, auth: PremiumBusinessAuthorization, recordId: unknown, moduleId?: string, recordType?: string | readonly string[], label = "recordId") {
  if (typeof recordId !== "string") throw new Error(`${label} must be a record ID.`);
  const record = await store.getRecord(auth.userId, recordId); const allowed = typeof recordType === "string" ? [recordType] : recordType;
  if (!record || record.workspaceId !== auth.workspaceId || (moduleId && record.moduleId !== moduleId) || (allowed && !allowed.includes(record.recordType))) throw new Error(`${label.replace(/Id$/, "")} not found in this workspace.`);
  return record;
}
async function create(store: SuiteStore, auth: PremiumBusinessAuthorization, input: Parameters<SuiteStore["createRecord"]>[1]) {
  const record = await store.createRecord(auth.userId, { ...input, data: { version: 1, ...(input.data ?? {}) } }); if (!record) throw new Error("The premium record could not be persisted."); return record;
}
async function update(store: SuiteStore, auth: PremiumBusinessAuthorization, record: SuiteRecord, input: Parameters<SuiteStore["updateRecord"]>[2]) {
  const current = await owned(store, auth, record.id, record.moduleId, record.recordType); const nextVersion = recordVersion(current) + 1;
  const updated = await store.updateRecord(auth.userId, current.id, { ...input, data: { ...(input.data ?? {}), version: nextVersion } }); if (!updated) throw new Error("The premium record could not be updated."); return updated;
}
async function evidence(store: SuiteStore, auth: PremiumBusinessAuthorization, value: unknown, options: { include?: string; moduleId?: string; recordType?: string | readonly string[] } = {}) {
  const ids = strings(value, "evidenceIds", 100); if (options.include && !ids.includes(options.include)) throw new Error("The primary source must be included in evidenceIds.");
  const records: SuiteRecord[] = []; for (const recordId of ids) records.push(await owned(store, auth, recordId, options.moduleId, options.recordType, "evidenceId")); return records;
}
function humanApproval(auth: PremiumBusinessAuthorization, input: Record<string, unknown>, now: Date) {
  const approval = input.approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) throw new Error("An attributable human approval is required when dryRun is false.");
  const value = approval as Record<string, unknown>; const approvedAt = new Date(String(value.approvedAt));
  if (value.approved !== true || value.approvedBy !== auth.userId || typeof value.reason !== "string" || value.reason.trim().length < 3 || !Number.isFinite(approvedAt.getTime()) || approvedAt.getTime() > now.getTime() + 300_000 || approvedAt.getTime() < now.getTime() - 86_400_000) throw new Error("An attributable, reasoned, recent human approval is required when dryRun is false.");
  return { approvedBy: auth.userId, approvedAt: approvedAt.toISOString(), reason: value.reason.trim() };
}

interface DurableOutcome { records: SuiteRecord[]; preview?: Record<string, unknown>; privateOutput?: Record<string, unknown>; aiAction?: SuiteAiAction; audit?: Record<string, unknown> }
interface DurableContext { store: SuiteStore; auth: PremiumBusinessAuthorization; action: PremiumActionDefinition; input: Record<string, unknown>; now: Date; dryRun: boolean; deps: PremiumBusinessStoreDependencies }

async function replay(store: SuiteStore, auth: PremiumBusinessAuthorization, action: PremiumActionDefinition, key: string, requestHash: string): Promise<PremiumBusinessStoreResult | undefined> {
  const receipt = (await store.listRecords(auth.userId, { moduleId: action.moduleId, recordType: receiptType, limit: 1_000_000 })).find((record) => record.data.actionId === action.id && record.data.idempotencyKey === key);
  if (!receipt) return undefined;
  if (receipt.data.requestHash !== requestHash) throw new Error("The idempotency key was already used for different input.");
  const records: SuiteRecord[] = []; for (const recordId of Array.isArray(receipt.data.resultRecordIds) ? receipt.data.resultRecordIds : []) { const record = await store.getRecord(auth.userId, String(recordId)); if (record) records.push(record); }
  const aiAction = typeof receipt.data.aiActionId === "string" ? await store.getAiAction(auth.userId, receipt.data.aiActionId) : undefined;
  return { kind: aiAction ? "ai-action" : "command", action, records, aiAction, preview: receipt.data.previewDigest ? { replayed: true, previewDigest: receipt.data.previewDigest } : undefined, audit: { ...(receipt.data.audit as Record<string, unknown>), receiptId: receipt.id, replayed: true } };
}
async function persistReceipt(context: DurableContext, key: string, requestHash: string, result: PremiumBusinessStoreResult) {
  const receiptAudit = { ...result.audit, requestHash, idempotencyKey: key, replayed: false };
  const receiptHash = digest(receiptAudit);
  const receipt = await create(context.store, context.auth, { moduleId: context.action.moduleId, recordType: receiptType, title: `${context.action.id} · ${key.slice(0, 48)}`, state: context.dryRun ? "previewed" : "recorded", data: { actionId: context.action.id, idempotencyKey: key, requestHash, resultRecordIds: result.records.map((record) => record.id), aiActionId: result.aiAction?.id, previewDigest: result.preview ? digest(result.preview) : undefined, audit: { ...receiptAudit, receiptHash }, immutable: true } });
  result.audit = { ...receiptAudit, receiptHash, receiptId: receipt.id };
  return result;
}

function makeResult(context: DurableContext, outcome: DurableOutcome): PremiumBusinessStoreResult {
  const decision = context.dryRun ? "previewed" : context.action.operation === "read" ? "read" : outcome.aiAction ? "queued" : "applied";
  const approved = !context.dryRun && context.action.requiresApproval ? humanApproval(context.auth, context.input, context.now) : undefined;
  const audit = { workspaceId: context.auth.workspaceId, actorUserId: context.auth.userId, moduleId: context.action.moduleId, actionId: context.action.id, risk: context.action.risk, destructive: context.action.destructive, externalEffect: context.action.externalEffect, decision, dryRun: context.dryRun, approval: approved, recordIds: outcome.records.map((record) => record.id), occurredAt: context.now.toISOString(), ...(outcome.audit ?? {}) };
  return { kind: outcome.aiAction ? "ai-action" : context.action.operation === "read" ? "read" : "command", action: context.action, records: outcome.records, preview: outcome.preview, privateOutput: outcome.privateOutput, aiAction: outcome.aiAction, audit };
}

async function queueAi(context: DurableContext, options: { title: string; goal: string; promptVersion: string; modelId: string; evidence: SuiteRecord[]; source: Record<string, unknown>; extra?: Record<string, unknown> }): Promise<DurableOutcome> {
  const platformPrompt = premiumBusinessPromptPolicies[context.action.moduleId];
  const boundary = { platformPromptId: platformPrompt.id, platformPromptVersion: platformPrompt.version, platformPromptDigest: premiumBusinessPromptDigest(context.action.moduleId), forbiddenAutonomy: platformPrompt.forbiddenAutonomy, promptVersion: options.promptVersion, requestedModelId: options.modelId, executedModelId: null, confidence: null, evidenceIds: options.evidence.map((record) => record.id), evidenceSnapshots: options.evidence.map((record) => ({ recordId: record.id, version: recordVersion(record), snapshotHash: digest(record) })), review: { status: "pending-model", required: true }, output: null, fabricatedOutputAllowed: false, automaticMutationAllowed: false, approvalRequired: true, resultContract: premiumBusinessAiResultContract, source: canonical(options.source), ...(options.extra ?? {}) };
  if (context.dryRun) return { records: [], preview: { wouldQueueModelRun: true, modelInvoked: false, ...boundary } };
  let audit = await create(context.store, context.auth, { moduleId: context.action.moduleId, recordType: aiAuditType, title: options.title, state: "queued", data: { actionId: context.action.id, ...boundary, requestedAt: context.now.toISOString(), requestedByUserId: context.auth.userId, immutableRequest: true } });
  const aiAction = await context.store.queueAiAction(context.auth.userId, { moduleId: context.action.moduleId, goal: options.goal, context: { actionId: context.action.id, aiAuditRecordId: audit.id, workspaceId: context.auth.workspaceId, ...boundary } });
  if (!aiAction) { audit = await update(context.store, context.auth, audit, { state: "queue-failed", data: { review: { status: "queue-failed", required: true } } }); throw new Error("The premium AI request could not be queued."); }
  audit = await update(context.store, context.auth, audit, { data: { aiActionId: aiAction.id } });
  return { records: [audit], aiAction, preview: { aiAuditRecordId: audit.id, aiActionId: aiAction.id, output: null }, audit: { modelExecuted: false, promptVersion: options.promptVersion, requestedModelId: options.modelId, confidence: null, evidenceIds: boundary.evidenceIds, reviewStatus: "pending-model", fabricatedOutputAllowed: false } };
}

export async function executePremiumBusinessAction<M extends PremiumModuleId>(store: SuiteStore, auth: PremiumBusinessAuthorization, moduleId: M, actionId: PremiumActionIdFor<M>, input: Record<string, unknown>, dependencies: Partial<PremiumBusinessStoreDependencies> = {}): Promise<PremiumBusinessStoreResult> {
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
    const action = premiumBusinessAction(moduleId, actionId) as PremiumActionDefinition | undefined; if (!action) throw new Error(`Unknown premium action ${moduleId}.${String(actionId)}.`);
    await authorize(store, auth, action); validateInput(action, input);
    const deps: PremiumBusinessStoreDependencies = { now: dependencies.now ?? (() => new Date()) }; const now = deps.now(); if (!Number.isFinite(now.getTime())) throw new Error("The premium engine clock is invalid.");
    const dryRun = input.dryRun === true; if (input.dryRun !== undefined && !action.supportsDryRun) throw new Error("This action does not support dry runs.");
    const requestHash = digest({ moduleId, actionId, input }); let key: string | undefined;
    if (action.operation !== "read") {
      key = text(input, "idempotencyKey", 200); const existing = await replay(store, auth, action, key, requestHash); if (existing) return existing;
      if (action.requiresApproval && !dryRun) humanApproval(auth, input, now);
    }
    const context: DurableContext = { store, auth, action, input, now, dryRun, deps };
    const outcome = action.moduleId === "projects" ? await projects(context) : action.moduleId === "drive" ? await drive(context) : action.moduleId === "channels" ? await channels(context) : action.moduleId === "operations" ? await operations(context) : await assistant(context);
    const result = makeResult(context, outcome); return key ? persistReceipt(context, key, requestHash, result) : result;
  });
}

async function projects(context: DurableContext): Promise<DurableOutcome> {
  const { store, auth, action, input, now, dryRun } = context;
  if (action.id === "project-create") {
    const stableKey = text(input, "key", 40); const existing = await store.listRecords(auth.userId, { moduleId: "projects", recordType: "project", limit: 100_000 });
    if (existing.some((record) => record.data.key === stableKey)) throw new Error("Project key already exists in this workspace.");
    return { records: [await create(store, auth, { moduleId: "projects", recordType: "project", title: text(input, "name", 160), state: "active", data: { key: stableKey, outcome: text(input, "outcome", 2_000) } })] };
  }
  if (action.id === "issue-create") {
    const project = await owned(store, auth, input.projectId, "projects", "project", "projectId");
    return { records: [await create(store, auth, { moduleId: "projects", recordType: "issue", title: text(input, "title", 240), state: "backlog", data: { projectId: project.id, priority: text(input, "priority", 20), points: integer(input, "points", 1, 100), dependencyIds: [] } })] };
  }
  if (action.id === "dependency-link") {
    const issue = await owned(store, auth, input.issueId, "projects", "issue", "issueId"); const dependency = await owned(store, auth, input.dependsOnIssueId, "projects", "issue", "dependsOnIssueId"); expected(issue, input);
    if (issue.id === dependency.id || issue.data.projectId !== dependency.data.projectId) throw new Error("Dependencies must be different issues in the same project.");
    const current = Array.isArray(issue.data.dependencyIds) ? issue.data.dependencyIds.map(String) : []; if (current.includes(dependency.id)) return { records: [issue], preview: { alreadyLinked: true } };
    const reaches = async (start: string, target: string, visited = new Set<string>()): Promise<boolean> => {
      if (start === target) return true; if (visited.has(start)) return false; visited.add(start);
      const candidate = await owned(store, auth, start, "projects", "issue"); const dependencies = Array.isArray(candidate.data.dependencyIds) ? candidate.data.dependencyIds.map(String) : [];
      for (const recordId of dependencies) if (await reaches(recordId, target, visited)) return true; return false;
    };
    if (await reaches(dependency.id, issue.id)) throw new Error("The dependency would create a cycle.");
    return { records: [await update(store, auth, issue, { data: { dependencyIds: [...current, dependency.id] } })] };
  }
  if (action.id === "issue-transition") {
    const issue = await owned(store, auth, input.issueId, "projects", "issue", "issueId"); expected(issue, input); const target = text(input, "toState", 20);
    if (!(stateTransitions[issue.state] ?? []).includes(target)) throw new Error(`Invalid issue transition from ${issue.state} to ${target}.`);
    return { records: [await update(store, auth, issue, { state: target, data: { transitionReason: text(input, "reason", 1_000), transitionedByUserId: auth.userId, transitionedAt: now.toISOString() } })] };
  }
  if (action.id === "cycle-draft") {
    const project = await owned(store, auth, input.projectId, "projects", "project", "projectId"); const issueIds = strings(input.issueIds, "issueIds", 200); const issues: SuiteRecord[] = [];
    for (const issueId of issueIds) issues.push(await owned(store, auth, issueId, "projects", "issue", "issueId"));
    if (issues.some((issue) => issue.data.projectId !== project.id || issue.state === "done")) throw new Error("Every cycle issue must be unfinished and belong to the selected project.");
    const capacityPoints = integer(input, "capacityPoints", 1, 10_000); const issueSnapshot = issues.map((issue) => ({ id: issue.id, version: recordVersion(issue), points: issue.data.points, state: issue.state })); const committedPoints = issueSnapshot.reduce((sum, item) => sum + Number(item.points), 0);
    if (!Number.isSafeInteger(committedPoints) || committedPoints > capacityPoints) throw new Error("Selected issue points exceed cycle capacity.");
    const snapshot = { projectId: project.id, title: text(input, "title", 160), capacityPoints, committedPoints, issueSnapshot }; const contentHash = digest(snapshot);
    const cycle = await create(store, auth, { moduleId: "projects", recordType: "cycle", title: snapshot.title, state: "draft", data: { ...snapshot, contentHash } }); return { records: [cycle], preview: { contentHash, remainingPoints: capacityPoints - committedPoints } };
  }
  if (action.id === "cycle-commit") {
    const cycle = await owned(store, auth, input.cycleId, "projects", "cycle", "cycleId"); const contentHash = text(input, "contentHash", 64);
    if (cycle.state !== "draft" || cycle.data.contentHash !== contentHash) throw new Error("Only the exact draft cycle hash can be committed."); const snapshot = Array.isArray(cycle.data.issueSnapshot) ? cycle.data.issueSnapshot : [];
    for (const item of snapshot) { const source = plain(item, "cycle issue snapshot"); const current = await owned(store, auth, source.id, "projects", "issue"); if (recordVersion(current) !== source.version || current.state !== source.state || current.data.points !== source.points) throw new Error("Cycle evidence changed after drafting; create a new snapshot."); }
    if (dryRun) return { records: [], preview: { wouldCommit: cycle.id, contentHash, issueCount: snapshot.length } };
    return { records: [await update(store, auth, cycle, { state: "active", data: { committedByUserId: auth.userId, committedAt: now.toISOString() } })] };
  }
  if (action.id === "plan-propose" || action.id === "health-explain") {
    const project = await owned(store, auth, input.projectId, "projects", "project", "projectId"); const selected = await evidence(store, auth, input.evidenceIds, { include: project.id }); const goal = text(input, action.id === "plan-propose" ? "objective" : "question", 4_000);
    return queueAi(context, { title: `${action.title}: ${project.title}`, goal, promptVersion: text(input, "promptVersion", 120), modelId: text(input, "modelId", 200), evidence: selected, source: { projectId: project.id, goal }, extra: { proposalOnly: true } });
  }
  throw new Error(`Projects action ${action.id} is not implemented.`);
}

async function durableSharePlan(context: DurableContext) {
  const file = await owned(context.store, context.auth, context.input.fileId, "drive", "file", "fileId"); if (file.state !== "available") throw new Error("Only an available file can be shared.");
  const expiresAt = iso(context.input, "expiresAt"); if (expiresAt <= context.now || expiresAt.getTime() > context.now.getTime() + 365 * 86_400_000) throw new Error("Share expiry must be in the future and within one year.");
  const plan = { fileId: file.id, fileVersion: recordVersion(file), checksum: file.data.checksum, permission: text(context.input, "permission", 20), expiresAt: expiresAt.toISOString() }; return { file, plan, previewHash: digest(plan) };
}

async function drive(context: DurableContext): Promise<DurableOutcome> {
  const { store, auth, action, input, now, dryRun } = context;
  if (action.id === "vault-create") return { records: [await create(store, auth, { moduleId: "drive", recordType: "vault", title: text(input, "name", 160), state: "active", data: { classification: text(input, "classification", 20) } })] };
  if (action.id === "file-register") {
    const vault = await owned(store, auth, input.vaultId, "drive", "vault", "vaultId"); const objectKey = text(input, "objectKey", 1_000); if (/^[a-z]+:\/\//i.test(objectKey) || objectKey.includes("?") || objectKey.includes("..")) throw new Error("objectKey must be an opaque relative storage key.");
    const snapshot = { vaultId: vault.id, name: text(input, "name", 240), objectKey, contentType: text(input, "contentType", 200), sizeBytes: integer(input, "sizeBytes", 1, 5_368_709_120), checksum: text(input, "checksum", 64) };
    if (dryRun) return { records: [], preview: { wouldRegister: snapshot, objectBytesStoredInDatabase: false } };
    const file = await create(store, auth, { moduleId: "drive", recordType: "file", title: snapshot.name, state: "available", data: { ...snapshot, fileVersionNumber: 1, retention: null, legalHold: false } }); const version = await create(store, auth, { moduleId: "drive", recordType: "file-version", title: `${snapshot.name} v1`, state: "immutable", data: { fileId: file.id, fileVersionNumber: 1, objectKey, sizeBytes: snapshot.sizeBytes, checksum: snapshot.checksum, storageAccounting: suiteStorageAccounting(snapshot.sizeBytes) } }); return { records: [file, version] };
  }
  if (action.id === "file-version-add") {
    const file = await owned(store, auth, input.fileId, "drive", "file", "fileId"); expected(file, input); if (file.state !== "available") throw new Error("Only an available file accepts a version."); const objectKey = text(input, "objectKey", 1_000); if (/^[a-z]+:\/\//i.test(objectKey) || objectKey.includes("?") || objectKey.includes("..")) throw new Error("objectKey must be an opaque relative storage key.");
    const next = Number(file.data.fileVersionNumber ?? 1) + 1; const snapshot = { objectKey, sizeBytes: integer(input, "sizeBytes", 1, 5_368_709_120), checksum: text(input, "checksum", 64), fileVersionNumber: next }; if (dryRun) return { records: [], preview: { fileId: file.id, ...snapshot } };
    const version = await create(store, auth, { moduleId: "drive", recordType: "file-version", title: `${file.title} v${next}`, state: "immutable", data: { fileId: file.id, ...snapshot, storageAccounting: suiteStorageAccounting(snapshot.sizeBytes) } }); const updated = await update(store, auth, file, { data: { ...snapshot, currentVersionRecordId: version.id } }); return { records: [updated, version] };
  }
  if (action.id === "share-preview") { const shared = await durableSharePlan(context); return { records: [], preview: { ...shared.plan, previewHash: shared.previewHash, mutationApplied: false } }; }
  if (action.id === "share-create") {
    const shared = await durableSharePlan(context); if (text(input, "previewHash", 64) !== shared.previewHash) throw new Error("The share preview hash is stale or does not match."); if (dryRun) return { records: [], preview: { ...shared.plan, previewHash: shared.previewHash, wouldCreateShare: true } };
    const token = randomUUID(); const share = await create(store, auth, { moduleId: "drive", recordType: "share", title: `${shared.file.title} share`, state: "active", data: { ...shared.plan, tokenHash: digest(token), tokenStoredPlaintext: false } }); return { records: [share], privateOutput: { shareToken: token } };
  }
  if (action.id === "retention-set") {
    const file = await owned(store, auth, input.fileId, "drive", "file", "fileId"); expected(file, input); const retainUntil = iso(input, "retainUntil").toISOString(); const legalHold = input.legalHold === true; if (dryRun) return { records: [], preview: { fileId: file.id, retainUntil, legalHold, wouldUpdateVersion: recordVersion(file) + 1 } };
    return { records: [await update(store, auth, file, { data: { retention: retainUntil, legalHold, retentionSetByUserId: auth.userId, retentionSetAt: now.toISOString() } })] };
  }
  if (action.id === "file-delete") {
    const file = await owned(store, auth, input.fileId, "drive", "file", "fileId"); expected(file, input); if (file.data.legalHold === true) throw new Error("A file under legal hold cannot be deleted."); if (typeof file.data.retention === "string" && new Date(file.data.retention).getTime() > now.getTime()) throw new Error("The active retention window blocks deletion."); const reason = text(input, "reason", 1_000);
    if (dryRun) return { records: [], preview: { fileId: file.id, wouldSoftDelete: true, objectDeletionDelegated: true } }; return { records: [await update(store, auth, file, { state: "deleted", data: { deletedAt: now.toISOString(), deletedByUserId: auth.userId, deletionReason: reason, objectDeletionRequired: true } })] };
  }
  if (action.id === "document-understand") {
    const file = await owned(store, auth, input.fileId, "drive", "file", "fileId"); if (file.state !== "available") throw new Error("Only an available file can be analyzed."); const selected = await evidence(store, auth, input.evidenceIds, { include: file.id }); const goal = text(input, "question", 4_000);
    return queueAi(context, { title: `${action.title}: ${file.title}`, goal, promptVersion: text(input, "promptVersion", 120), modelId: text(input, "modelId", 200), evidence: selected, source: { fileId: file.id, checksum: file.data.checksum, question: goal }, extra: { objectKeySharedWithModel: false, citationRequired: true } });
  }
  throw new Error(`Drive action ${action.id} is not implemented.`);
}

async function durableMessagePlan(context: DurableContext) {
  const topic = await owned(context.store, context.auth, context.input.topicId, "channels", "topic", "topicId"); if (topic.state !== "open") throw new Error("Messages can only be posted to an open topic.");
  const body = text(context.input, "body", 12_000); const plan = { topicId: topic.id, topicVersion: recordVersion(topic), body, bodyHash: digest(body) }; return { topic, body, plan, previewHash: digest(plan) };
}

async function channels(context: DurableContext): Promise<DurableOutcome> {
  const { store, auth, action, input, now, dryRun } = context;
  if (action.id === "stream-create") {
    const stableKey = text(input, "key", 40); const existing = await store.listRecords(auth.userId, { moduleId: "channels", recordType: "stream", limit: 100_000 }); if (existing.some((record) => record.data.key === stableKey)) throw new Error("Stream key already exists in this workspace.");
    return { records: [await create(store, auth, { moduleId: "channels", recordType: "stream", title: text(input, "name", 160), state: "active", data: { key: stableKey, purpose: text(input, "purpose", 2_000) } })] };
  }
  if (action.id === "topic-create") { const stream = await owned(store, auth, input.streamId, "channels", "stream", "streamId"); return { records: [await create(store, auth, { moduleId: "channels", recordType: "topic", title: text(input, "title", 240), state: "open", data: { streamId: stream.id, intent: text(input, "intent", 2_000), decision: null } })] }; }
  if (action.id === "message-preview") { const message = await durableMessagePlan(context); return { records: [], preview: { ...message.plan, previewHash: message.previewHash, mutationApplied: false } }; }
  if (action.id === "message-post") {
    const message = await durableMessagePlan(context); if (text(input, "previewHash", 64) !== message.previewHash) throw new Error("The message preview hash is stale or does not match."); if (dryRun) return { records: [], preview: { ...message.plan, previewHash: message.previewHash, wouldPost: true } };
    return { records: [await create(store, auth, { moduleId: "channels", recordType: "message", title: message.topic.title, state: "posted", data: { topicId: message.topic.id, streamId: message.topic.data.streamId, body: message.body, bodyHash: message.plan.bodyHash, postedByUserId: auth.userId, postedAt: now.toISOString() } })] };
  }
  if (action.id === "message-redact") {
    const message = await owned(store, auth, input.messageId, "channels", "message", "messageId"); expected(message, input); if (message.state === "redacted") throw new Error("The message is already redacted."); const reason = text(input, "reason", 1_000);
    if (dryRun) return { records: [], preview: { messageId: message.id, wouldRedact: true, originalBodyHash: message.data.bodyHash } }; return { records: [await update(store, auth, message, { state: "redacted", data: { body: null, redactedAt: now.toISOString(), redactedByUserId: auth.userId, redactionReason: reason } })] };
  }
  if (action.id === "topic-resolve") {
    const topic = await owned(store, auth, input.topicId, "channels", "topic", "topicId"); expected(topic, input); if (topic.state !== "open") throw new Error("Only an open topic can be resolved.");
    return { records: [await update(store, auth, topic, { state: "resolved", data: { decision: text(input, "decision", 4_000), resolvedByUserId: auth.userId, resolvedAt: now.toISOString() } })] };
  }
  if (action.id === "topic-summarize") {
    const topic = await owned(store, auth, input.topicId, "channels", "topic", "topicId"); const selected = await evidence(store, auth, input.evidenceIds, { moduleId: "channels", recordType: "message" }); if (selected.some((record) => record.data.topicId !== topic.id)) throw new Error("Topic summaries may use only messages from the selected topic."); const goal = text(input, "question", 4_000);
    return queueAi(context, { title: `${action.title}: ${topic.title}`, goal, promptVersion: text(input, "promptVersion", 120), modelId: text(input, "modelId", 200), evidence: selected, source: { topicId: topic.id, question: goal }, extra: { proposalOnly: true } });
  }
  if (action.id === "digest-draft") {
    const stream = await owned(store, auth, input.streamId, "channels", "stream", "streamId"); const selected = await evidence(store, auth, input.evidenceIds, { moduleId: "channels", recordType: "topic" }); if (selected.some((record) => record.data.streamId !== stream.id)) throw new Error("Stream digests may use only topics from the selected stream."); const goal = text(input, "instruction", 4_000);
    return queueAi(context, { title: `${action.title}: ${stream.title}`, goal, promptVersion: text(input, "promptVersion", 120), modelId: text(input, "modelId", 200), evidence: selected, source: { streamId: stream.id, instruction: goal }, extra: { proposalOnly: true, automaticSendAllowed: false } });
  }
  throw new Error(`Channels action ${action.id} is not implemented.`);
}

function durableJournal(input: Record<string, unknown>) {
  const currency = text(input, "currency", 3); const period = text(input, "period", 7); const memo = text(input, "memo", 1_000); if (!Array.isArray(input.entries) || input.entries.length < 2 || input.entries.length > 200) throw new Error("entries must contain 2 to 200 lines.");
  const entries = input.entries.map((item, index) => { const entry = plain(item, `entries[${index}]`); const account = text(entry, "account", 120); const debitMinor = integer(entry, "debitMinor", 0, 1_000_000_000_000); const creditMinor = integer(entry, "creditMinor", 0, 1_000_000_000_000); if ((debitMinor === 0) === (creditMinor === 0)) throw new Error("Each journal line must contain exactly one positive debit or credit."); return { account, debitMinor, creditMinor }; });
  const debitMinor = entries.reduce((sum, entry) => sum + entry.debitMinor, 0); const creditMinor = entries.reduce((sum, entry) => sum + entry.creditMinor, 0); if (!Number.isSafeInteger(debitMinor) || debitMinor <= 0 || debitMinor !== creditMinor) throw new Error("Journal debits and credits must balance exactly in integer minor units.");
  const snapshot = { currency, period, memo, entries, debitMinor, creditMinor }; return { snapshot, previewHash: digest(snapshot) };
}

async function operations(context: DurableContext): Promise<DurableOutcome> {
  const { store, auth, action, input, now, dryRun } = context;
  if (action.id === "party-create") return { records: [await create(store, auth, { moduleId: "operations", recordType: "party", title: text(input, "name", 240), state: "active", data: { kind: text(input, "kind", 20), currency: text(input, "currency", 3) } })] };
  if (action.id === "item-create") {
    const sku = text(input, "sku", 80); const existing = await store.listRecords(auth.userId, { moduleId: "operations", recordType: "item", limit: 100_000 }); if (existing.some((record) => record.data.sku === sku)) throw new Error("SKU already exists in this workspace.");
    return { records: [await create(store, auth, { moduleId: "operations", recordType: "item", title: text(input, "name", 240), state: "active", data: { sku, currency: text(input, "currency", 3), unitPriceMinor: integer(input, "unitPriceMinor", 0, 1_000_000_000_000) } })] };
  }
  if (action.id === "order-create") {
    const party = await owned(store, auth, input.partyId, "operations", "party", "partyId"); if (party.data.kind !== "customer") throw new Error("Sales orders require a customer party."); const currency = text(input, "currency", 3); if (party.data.currency !== currency) throw new Error("Order and party currencies must match."); if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 200) throw new Error("lines must contain 1 to 200 order lines.");
    const lines: Array<{ itemId: string; sku: unknown; quantity: number; unitPriceMinor: number; totalMinor: number }> = [];
    for (const [index, value] of input.lines.entries()) { const line = plain(value, `lines[${index}]`); const item = await owned(store, auth, line.itemId, "operations", "item", "itemId"); if (item.data.currency !== currency) throw new Error("Every order item must use the order currency."); const quantity = integer(line, "quantity", 1, 1_000_000); const unitPriceMinor = Number(item.data.unitPriceMinor); const totalMinor = quantity * unitPriceMinor; if (!Number.isSafeInteger(totalMinor)) throw new Error("Order line total exceeds safe integer bounds."); lines.push({ itemId: item.id, sku: item.data.sku, quantity, unitPriceMinor, totalMinor }); }
    const totalMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0); if (!Number.isSafeInteger(totalMinor)) throw new Error("Order total exceeds safe integer bounds."); const snapshot = { partyId: party.id, currency, lines, totalMinor };
    return { records: [await create(store, auth, { moduleId: "operations", recordType: "order", title: `Order for ${party.title}`, state: "confirmed", data: { ...snapshot, contentHash: digest(snapshot) } })] };
  }
  if (action.id === "invoice-draft") {
    const order = await owned(store, auth, input.orderId, "operations", "order", "orderId"); const issueAt = iso(input, "issueAt"); const dueAt = iso(input, "dueAt"); if (dueAt < issueAt) throw new Error("Invoice dueAt cannot precede issueAt.");
    const snapshot = { orderId: order.id, orderContentHash: order.data.contentHash, partyId: order.data.partyId, currency: order.data.currency, lines: order.data.lines, totalMinor: order.data.totalMinor, balanceMinor: order.data.totalMinor, issueAt: issueAt.toISOString(), dueAt: dueAt.toISOString() }; const contentHash = digest(snapshot);
    const invoice = await create(store, auth, { moduleId: "operations", recordType: "invoice", title: `Invoice for ${order.title}`, state: "draft", data: { ...snapshot, contentHash, immutableAfterIssue: true } }); return { records: [invoice], preview: { contentHash } };
  }
  if (action.id === "invoice-issue") {
    const invoice = await owned(store, auth, input.invoiceId, "operations", "invoice", "invoiceId"); const contentHash = text(input, "contentHash", 64); if (invoice.state !== "draft" || invoice.data.contentHash !== contentHash) throw new Error("Only the exact draft invoice hash can be issued."); if (dryRun) return { records: [], preview: { invoiceId: invoice.id, contentHash, wouldIssue: true, externalDelivery: false } };
    return { records: [await update(store, auth, invoice, { state: "open", data: { issuedAt: now.toISOString(), issuedByUserId: auth.userId } })] };
  }
  if (action.id === "journal-preview") { const journal = durableJournal(input); return { records: [], preview: { ...journal.snapshot, previewHash: journal.previewHash, mutationApplied: false } }; }
  if (action.id === "journal-post") {
    const journal = durableJournal(input); if (text(input, "previewHash", 64) !== journal.previewHash) throw new Error("The journal preview hash is stale or does not match."); if (dryRun) return { records: [], preview: { ...journal.snapshot, previewHash: journal.previewHash, wouldPost: true } };
    return { records: [await create(store, auth, { moduleId: "operations", recordType: "journal", title: journal.snapshot.memo, state: "posted", data: { ...journal.snapshot, contentHash: journal.previewHash, immutable: true, postedByUserId: auth.userId, postedAt: now.toISOString() } })] };
  }
  if (action.id === "payment-record") {
    const invoice = await owned(store, auth, input.invoiceId, "operations", "invoice", "invoiceId"); if (invoice.state !== "open") throw new Error("Payments require an open issued invoice."); const currency = text(input, "currency", 3); const amountMinor = integer(input, "amountMinor", 1, 1_000_000_000_000); const balanceMinor = Number(invoice.data.balanceMinor); if (invoice.data.currency !== currency || amountMinor > balanceMinor) throw new Error("Payment currency must match and amount cannot exceed invoice balance."); const nextBalance = balanceMinor - amountMinor;
    if (dryRun) return { records: [], preview: { invoiceId: invoice.id, amountMinor, currency, currentBalanceMinor: balanceMinor, nextBalanceMinor: nextBalance } };
    const payment = await create(store, auth, { moduleId: "operations", recordType: "payment", title: text(input, "reference", 240), state: "recorded", data: { invoiceId: invoice.id, amountMinor, currency, reference: text(input, "reference", 240), recordedByUserId: auth.userId, recordedAt: now.toISOString(), immutable: true } }); const updated = await update(store, auth, invoice, { state: nextBalance === 0 ? "paid" : "open", data: { balanceMinor: nextBalance, lastPaymentId: payment.id } }); return { records: [updated, payment] };
  }
  if (action.id === "variance-explain") {
    const selected = await evidence(store, auth, input.evidenceIds, { moduleId: "operations", recordType: ["order", "invoice", "payment", "journal"] }); const goal = text(input, "question", 4_000);
    return queueAi(context, { title: action.title, goal, promptVersion: text(input, "promptVersion", 120), modelId: text(input, "modelId", 200), evidence: selected, source: { question: goal }, extra: { mayPostAccountingFacts: false } });
  }
  throw new Error(`Operations action ${action.id} is not implemented.`);
}

async function durableGroundedRun(context: DurableContext) {
  const prompt = await owned(context.store, context.auth, context.input.promptVersionId, "assistant", "prompt-version", "promptVersionId"); const collection = await owned(context.store, context.auth, context.input.collectionId, "assistant", "collection", "collectionId"); const selected = await evidence(context.store, context.auth, context.input.evidenceIds);
  const attachments = (await context.store.listRecords(context.auth.userId, { moduleId: "assistant", recordType: "source-attachment", limit: 100_000 })).filter((record) => record.data.collectionId === collection.id);
  const evidenceHashes: Array<{ recordId: string; recordSnapshotHash: string; contentHash: unknown }> = [];
  for (const record of selected) {
    const snapshotHash = digest(record); const attachment = attachments.find((candidate) => candidate.data.recordId === record.id && candidate.data.sourceVersion === recordVersion(record) && candidate.data.sourceSnapshotHash === snapshotHash);
    if (!attachment) throw new Error("Every run evidence record must be checksum-attached at its current exact version."); evidenceHashes.push({ recordId: record.id, recordSnapshotHash: snapshotHash, contentHash: attachment.data.contentHash });
  }
  const plan = { promptVersionId: prompt.id, promptContentHash: prompt.data.contentHash, collectionId: collection.id, evidenceIds: selected.map((record) => record.id), evidenceHashes, modelId: text(context.input, "modelId", 200), goal: text(context.input, "goal", 4_000), reviewRequired: true }; return { prompt, collection, selected, plan, previewHash: digest(plan) };
}

function reviewedResult(input: Record<string, unknown>, allowedEvidenceIds: Set<string>, reviewerId: string) {
  const output = plain(input.output, "output"); if (typeof output.summary !== "string" || !output.summary.trim() || !Array.isArray(output.claims) || output.claims.length < 1 || output.claims.length > 200) throw new Error("output must contain a summary and 1 to 200 claims.");
  const selectedEvidence = strings(input.evidenceIds, "evidenceIds", 100); if (selectedEvidence.some((recordId) => !allowedEvidenceIds.has(recordId))) throw new Error("Result evidence exceeds the authorized model evidence."); const selectedSet = new Set(selectedEvidence);
  const claims = output.claims.map((value, index) => { const claim = plain(value, `output.claims[${index}]`); if (typeof claim.text !== "string" || !claim.text.trim()) throw new Error(`output.claims[${index}].text is required.`); const claimEvidence = strings(claim.evidenceIds, `output.claims[${index}].evidenceIds`, 100); if (claimEvidence.some((recordId) => !allowedEvidenceIds.has(recordId) || !selectedSet.has(recordId))) throw new Error("Every claim must cite selected authorized evidence."); return { text: claim.text.trim(), evidenceIds: claimEvidence }; });
  const review = plain(input.review, "review"); if (!["approved", "rejected"].includes(String(review.status)) || review.reviewedBy !== reviewerId || typeof review.reviewedAt !== "string" || !Number.isFinite(new Date(review.reviewedAt).getTime()) || typeof review.notes !== "string" || !review.notes.trim()) throw new Error("A complete attributable human review is required.");
  return { output: { summary: output.summary.trim(), claims }, confidence: integer(input, "confidence", 0, 100), evidenceIds: selectedEvidence, review: canonical(review) as Record<string, unknown> };
}

export function validatePremiumBusinessAiCompletion(value: unknown, boundary: { evidenceIds: Iterable<string>; promptVersion: string; modelId: string }): PremiumBusinessAiCompletion {
  const result = plain(value, "AI completion"); const output = plain(result.output, "AI completion.output"); if (typeof output.summary !== "string" || !output.summary.trim() || !Array.isArray(output.claims) || output.claims.length < 1 || output.claims.length > 200) throw new Error("AI completion output must contain a summary and cited claims.");
  const allowed = new Set(boundary.evidenceIds); const completionEvidence = strings(result.evidenceIds, "AI completion.evidenceIds", 100); if (completionEvidence.some((recordId) => !allowed.has(recordId))) throw new Error("AI completion cites evidence outside the authorized selection."); const completionSet = new Set(completionEvidence);
  const claims = output.claims.map((value, index) => { const claim = plain(value, `AI completion.output.claims[${index}]`); if (typeof claim.text !== "string" || !claim.text.trim()) throw new Error("Every AI claim requires text."); const cited = strings(claim.evidenceIds, `AI completion.output.claims[${index}].evidenceIds`, 100); if (cited.some((recordId) => !allowed.has(recordId) || !completionSet.has(recordId))) throw new Error("Every AI claim must cite authorized selected evidence."); return { text: claim.text.trim(), evidenceIds: cited }; });
  if (typeof result.confidence !== "number" || !Number.isInteger(result.confidence) || result.confidence < 0 || result.confidence > 100) throw new Error("AI completion confidence must be a whole percentage from 0 to 100.");
  if (result.promptVersion !== boundary.promptVersion || result.modelId !== boundary.modelId) throw new Error("AI completion prompt or model provenance does not match the authorized request."); if (result.reviewStatus !== "pending-human-review" || result.approvalRequired !== true) throw new Error("AI completion must remain pending human review and approval-required.");
  return { output: { summary: output.summary.trim(), claims }, confidence: result.confidence, evidenceIds: completionEvidence, promptVersion: boundary.promptVersion, modelId: boundary.modelId, reviewStatus: "pending-human-review", approvalRequired: true };
}

export async function recordPremiumBusinessAiCompletion(store: SuiteStore, auth: PremiumBusinessAuthorization, aiActionId: string, value?: unknown, dependencies: Partial<PremiumBusinessStoreDependencies> = {}) {
  const aiAction = await store.getAiAction(auth.userId, aiActionId); if (!aiAction || aiAction.workspaceId !== auth.workspaceId || aiAction.status !== "completed") throw new Error("The completed premium AI action was not found in this workspace.");
  const action = premiumBusinessActions.find((candidate) => candidate.moduleId === aiAction.moduleId && candidate.id === aiAction.context.actionId); if (!action || action.operation !== "ai") throw new Error("The completed AI action does not match a registered premium AI boundary."); await authorize(store, auth, action);
  const audit = await owned(store, auth, aiAction.context.aiAuditRecordId, action.moduleId, aiAuditType, "aiAuditRecordId"); if (audit.data.aiActionId !== aiAction.id || audit.data.promptVersion !== aiAction.context.promptVersion || audit.data.requestedModelId !== aiAction.context.requestedModelId) throw new Error("The premium AI audit boundary is stale or mismatched.");
  const platformPrompt = premiumBusinessPromptPolicies[action.moduleId]; if (audit.data.platformPromptId !== platformPrompt.id || audit.data.platformPromptVersion !== platformPrompt.version || audit.data.platformPromptDigest !== premiumBusinessPromptDigest(action.moduleId) || aiAction.context.platformPromptDigest !== audit.data.platformPromptDigest) throw new Error("The premium AI action does not match the approved platform prompt policy.");
  const evidenceIds = Array.isArray(audit.data.evidenceIds) ? audit.data.evidenceIds.filter((item): item is string => typeof item === "string") : []; const completion = validatePremiumBusinessAiCompletion(value ?? aiAction.result, { evidenceIds, promptVersion: String(audit.data.promptVersion), modelId: String(audit.data.requestedModelId) }); const resultHash = digest(completion);
  if (audit.data.resultHash) { if (audit.data.resultHash !== resultHash) throw new Error("The premium AI request is already bound to a different completion."); return { auditRecord: audit, completion, replayed: true }; }
  if (audit.state !== "queued" || plain(audit.data.review, "AI audit review").status !== "pending-model") throw new Error("The premium AI audit is not waiting for a model completion."); const now = (dependencies.now ?? (() => new Date()))();
  const recorded = await update(store, auth, audit, { state: "pending-human-review", data: { executedModelId: completion.modelId, confidence: completion.confidence, resultHash, resultEvidenceIds: completion.evidenceIds, review: { status: "pending-human-review", required: true }, completedAt: now.toISOString() } }); return { auditRecord: recorded, completion, replayed: false };
}

async function assistant(context: DurableContext): Promise<DurableOutcome> {
  const { store, auth, action, input, now, dryRun } = context;
  if (action.id === "collection-create") return { records: [await create(store, auth, { moduleId: "assistant", recordType: "collection", title: text(input, "name", 160), state: "active", data: { purpose: text(input, "purpose", 2_000) } })] };
  if (action.id === "source-attach") {
    const collection = await owned(store, auth, input.collectionId, "assistant", "collection", "collectionId"); const source = await owned(store, auth, input.recordId, undefined, undefined, "recordId"); if (source.id === collection.id) throw new Error("A collection cannot cite itself."); const contentHash = text(input, "contentHash", 64); const sourceSnapshotHash = digest(source);
    const existing = (await store.listRecords(auth.userId, { moduleId: "assistant", recordType: "source-attachment", limit: 100_000 })).find((record) => record.data.collectionId === collection.id && record.data.recordId === source.id && record.data.contentHash === contentHash && record.data.sourceVersion === recordVersion(source) && record.data.sourceSnapshotHash === sourceSnapshotHash); if (existing) return { records: [existing], preview: { alreadyAttached: true } };
    return { records: [await create(store, auth, { moduleId: "assistant", recordType: "source-attachment", title: text(input, "citationLabel", 240), state: "active", data: { collectionId: collection.id, recordId: source.id, sourceModuleId: source.moduleId, sourceRecordType: source.recordType, sourceVersion: recordVersion(source), sourceSnapshotHash, contentHash, rawPayloadCopied: false } })] };
  }
  if (action.id === "prompt-version-create") {
    const inputContract = plain(input.inputContract, "inputContract"); const outputContract = plain(input.outputContract, "outputContract"); const content = { name: text(input, "name", 160), systemInstruction: text(input, "systemInstruction", 20_000), inputContract: canonical(inputContract), outputContract: canonical(outputContract), evidenceRequired: true, unsupportedClaimsForbidden: true }; const contentHash = digest(content);
    return { records: [await create(store, auth, { moduleId: "assistant", recordType: "prompt-version", title: content.name, state: "immutable", data: { ...content, contentHash } })], preview: { contentHash } };
  }
  if (action.id === "run-preview") { const run = await durableGroundedRun(context); return { records: [], preview: { ...run.plan, previewHash: run.previewHash, modelInvoked: false, output: null } }; }
  if (action.id === "run-execute") {
    const run = await durableGroundedRun(context); if (text(input, "previewHash", 64) !== run.previewHash) throw new Error("The model run preview hash is stale or does not match.");
    return queueAi(context, { title: `${action.title}: ${run.prompt.title}`, goal: String(run.plan.goal), promptVersion: String(run.prompt.data.contentHash), modelId: String(run.plan.modelId), evidence: run.selected, source: { promptVersionId: run.prompt.id, promptContentHash: run.prompt.data.contentHash, collectionId: run.collection.id, goal: run.plan.goal }, extra: { previewHash: run.previewHash, outputContract: run.prompt.data.outputContract } });
  }
  if (action.id === "result-record") {
    const audit = await owned(store, auth, input.runId, "assistant", aiAuditType, "runId"); if (audit.state !== "pending-human-review") throw new Error("Only a completed premium run pending human review can be recorded."); const aiAction = await store.getAiAction(auth.userId, String(audit.data.aiActionId)); if (!aiAction || aiAction.status !== "completed") throw new Error("The exact completed model action was not found.");
    const allowed = new Set(Array.isArray(audit.data.evidenceIds) ? audit.data.evidenceIds.map(String) : []); const reviewed = reviewedResult(input, allowed, auth.userId); const completion = validatePremiumBusinessAiCompletion(aiAction.result, { evidenceIds: allowed, promptVersion: String(audit.data.promptVersion), modelId: String(audit.data.requestedModelId) });
    if (digest({ output: reviewed.output, confidence: reviewed.confidence, evidenceIds: reviewed.evidenceIds, promptVersion: completion.promptVersion, modelId: completion.modelId, reviewStatus: "pending-human-review", approvalRequired: true }) !== digest(completion)) throw new Error("The reviewed result does not exactly match the recorded model completion."); const reviewStatus = String(reviewed.review.status);
    if (dryRun) return { records: [], preview: { wouldRecordResult: true, outputHash: digest(reviewed.output), confidence: reviewed.confidence, evidenceIds: reviewed.evidenceIds, reviewStatus } };
    const result = await create(store, auth, { moduleId: "assistant", recordType: "ai-result", title: `Result for ${audit.title}`, state: reviewStatus, data: { runId: audit.id, aiActionId: aiAction.id, output: reviewed.output, outputHash: digest(reviewed.output), confidence: reviewed.confidence, evidenceIds: reviewed.evidenceIds, promptVersion: completion.promptVersion, modelId: completion.modelId, review: reviewed.review, fabricatedOutputAllowed: false, immutable: true } }); const updated = await update(store, auth, audit, { state: reviewStatus, data: { resultRecordId: result.id, review: reviewed.review, reviewedAt: now.toISOString() } }); return { records: [updated, result] };
  }
  if (action.id === "agent-draft") {
    const prompt = await owned(store, auth, input.promptVersionId, "assistant", "prompt-version", "promptVersionId"); const allowedActions = strings(input.allowedActions, "allowedActions", 50); const known = new Set(premiumBusinessActions.map((candidate) => candidate.mcpToolName)); if (allowedActions.some((tool) => !known.has(tool))) throw new Error("Every allowed agent action must be an exact premium MCP tool name.");
    const content = { name: text(input, "name", 160), purpose: text(input, "purpose", 2_000), promptVersionId: prompt.id, promptContentHash: prompt.data.contentHash, allowedActions, maximumSteps: integer(input, "maximumSteps", 1, 50), automaticMutationAllowed: false }; const contentHash = digest(content); return { records: [await create(store, auth, { moduleId: "assistant", recordType: "agent", title: content.name, state: "draft", data: { ...content, contentHash } })], preview: { contentHash } };
  }
  if (action.id === "agent-approve") {
    const agent = await owned(store, auth, input.agentId, "assistant", "agent", "agentId"); const contentHash = text(input, "contentHash", 64); if (agent.state !== "draft" || agent.data.contentHash !== contentHash) throw new Error("Only the exact draft agent hash can be approved."); if (dryRun) return { records: [], preview: { agentId: agent.id, contentHash, wouldApprove: true } };
    return { records: [await update(store, auth, agent, { state: "approved", data: { approvedByUserId: auth.userId, approvedAt: now.toISOString() } })] };
  }
  if (action.id === "agent-execute") {
    const agent = await owned(store, auth, input.agentId, "assistant", "agent", "agentId"); if (agent.state !== "approved") throw new Error("Only an approved agent version can be executed."); const prompt = await owned(store, auth, agent.data.promptVersionId, "assistant", "prompt-version", "promptVersionId"); if (prompt.data.contentHash !== agent.data.promptContentHash) throw new Error("The agent prompt boundary is stale."); const selected = await evidence(store, auth, input.evidenceIds); const goal = text(input, "goal", 4_000);
    return queueAi(context, { title: `${action.title}: ${agent.title}`, goal, promptVersion: String(prompt.data.contentHash), modelId: text(input, "modelId", 200), evidence: selected, source: { agentId: agent.id, agentContentHash: agent.data.contentHash, promptVersionId: prompt.id, goal }, extra: { allowedActions: agent.data.allowedActions, maximumSteps: agent.data.maximumSteps, automaticMutationAllowed: false, proposalsRequireSeparateApproval: true } });
  }
  throw new Error(`Assistant action ${action.id} is not implemented.`);
}
