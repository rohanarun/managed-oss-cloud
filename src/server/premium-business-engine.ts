import { createHash, randomUUID } from "node:crypto";
import {
  premiumBusinessActions,
  premiumBusinessModuleById,
  premiumPlanAllows,
  type PremiumActionDefinition,
  type PremiumActionIdFor,
  type PremiumExternalEffect,
  type PremiumModuleId,
  type PremiumPlanId,
} from "../shared/premium-business-actions.js";

export interface PremiumEngineContext {
  tenantId: string;
  actorId: string;
  requestId: string;
  plan: PremiumPlanId;
  now?: () => Date;
}

export interface PremiumRecord {
  id: string;
  tenantId: string;
  moduleId: PremiumModuleId;
  recordType: string;
  title: string;
  state: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PremiumAuditReceipt {
  id: string;
  tenantId: string;
  actorId: string;
  requestId: string;
  moduleId: PremiumModuleId;
  actionId: string;
  risk: PremiumActionDefinition["risk"];
  destructive: boolean;
  externalEffect: PremiumExternalEffect;
  decision: "read" | "previewed" | "applied" | "queued" | "replayed";
  dryRun: boolean;
  replayed: boolean;
  inputHash: string;
  recordIds: string[];
  approvedBy?: string;
  createdAt: string;
  receiptHash: string;
}

export interface PremiumExecutionResult {
  action: PremiumActionDefinition;
  records: PremiumRecord[];
  preview?: Record<string, unknown>;
  privateOutput?: Record<string, unknown>;
  audit: PremiumAuditReceipt;
}

interface HandlerOutcome {
  records: PremiumRecord[];
  preview?: Record<string, unknown>;
  privateOutput?: Record<string, unknown>;
  decision?: PremiumAuditReceipt["decision"];
}

interface IdempotentOutcome {
  inputHash: string;
  records: PremiumRecord[];
  preview?: Record<string, unknown>;
  privateOutput?: Record<string, unknown>;
  originalReceiptId: string;
}

const forbiddenInputKeys = new Set(["apikey", "secret", "password", "accesstoken", "refreshtoken", "authorization", "cookie", "privatekey", "providersecret"]);
const allowedTransitions: Record<string, readonly string[]> = { backlog: ["ready"], ready: ["active"], active: ["blocked", "done"], blocked: ["active"], done: [] };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex"); }
function clone<T>(value: T): T { return structuredClone(value); }
function normalizedKey(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }

function inspectSafeJson(value: unknown, label: string, depth = 0, seen = new WeakSet<object>()): void {
  if (depth > 16) throw new Error(`${label} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 40_000) throw new Error(`${label} contains an oversized string.`);
    if (/^\s*(?:javascript|data\s*:\s*text\/html)\s*:/i.test(value) || /<\s*script\b/i.test(value)) throw new Error(`${label} contains executable content.`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} contains a non-integer or unsafe number.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} must contain JSON-compatible values only.`);
  if (seen.has(value as object)) throw new Error(`${label} cannot contain circular references.`);
  seen.add(value as object);
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error(`${label} contains too many items.`);
    value.forEach((item) => inspectSafeJson(item, label, depth + 1, seen));
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || forbiddenInputKeys.has(normalizedKey(key))) throw new Error(`${label} contains forbidden secret or unsafe field ${key}.`);
      inspectSafeJson(item, label, depth + 1, seen);
    }
  }
  seen.delete(value as object);
  if (depth === 0 && Buffer.byteLength(JSON.stringify(value), "utf8") > 256_000) throw new Error(`${label} exceeds the 256000-byte limit.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function text(input: Record<string, unknown>, name: string, maximum = 20_000) {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  return value.trim();
}
function whole(input: Record<string, unknown>, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be a safe integer from ${minimum} to ${maximum}.`);
  return value;
}
function dateTime(input: Record<string, unknown>, name: string) {
  const raw = text(input, name, 80);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) throw new Error(`${name} must be an ISO 8601 date-time.`);
  return parsed;
}
function uniqueStrings(value: unknown, name: string, maximum = 200) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} must contain 1 to ${maximum} non-empty strings.`);
  const result = value.map((item) => String(item));
  if (new Set(result).size !== result.length) throw new Error(`${name} must be unique.`);
  return result;
}

function validateInput(action: PremiumActionDefinition, input: Record<string, unknown>) {
  inspectSafeJson(input, "input");
  const allowed = new Set(Object.keys(action.inputSchema.properties));
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unexpected input field ${key}.`);
  for (const name of action.inputSchema.required) if (input[name] === undefined) throw new Error(`${name} is required.`);
  for (const [name, value] of Object.entries(input)) {
    const property = action.inputSchema.properties[name];
    if (!property) continue;
    const expected = property.type;
    if (expected === "string" && typeof value !== "string") throw new Error(`${name} must be a string.`);
    if (expected === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new Error(`${name} must be an integer.`);
    if (expected === "boolean" && typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
    if (expected === "array" && !Array.isArray(value)) throw new Error(`${name} must be an array.`);
    if (expected === "object" && !isPlainObject(value)) throw new Error(`${name} must be an object.`);
    if (typeof value === "string" && typeof property.pattern === "string" && !new RegExp(property.pattern).test(value)) throw new Error(`${name} does not match its required format.`);
    if (typeof value === "string" && property.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID.`);
    if (typeof value === "string" && property.format === "date-time" && !Number.isFinite(new Date(value).getTime())) throw new Error(`${name} must be a date-time.`);
    if (typeof value === "number" && typeof property.minimum === "number" && value < property.minimum) throw new Error(`${name} is below its minimum.`);
    if (typeof value === "number" && typeof property.maximum === "number" && value > property.maximum) throw new Error(`${name} is above its maximum.`);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) throw new Error(`${name} is not an allowed value.`);
  }
}

function validateContext(context: PremiumEngineContext) {
  for (const [label, value] of [["tenantId", context.tenantId], ["actorId", context.actorId], ["requestId", context.requestId]] as const) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{3,200}$/.test(value)) throw new Error(`${label} must be a stable safe identifier.`);
  }
}

function approvalFor(context: PremiumEngineContext, input: Record<string, unknown>, now: Date) {
  const value = input.approval;
  if (!isPlainObject(value) || value.approved !== true || value.approvedBy !== context.actorId || typeof value.reason !== "string" || value.reason.trim().length < 3 || typeof value.approvedAt !== "string") throw new Error("Exact human approval by the acting user is required.");
  const approvedAt = new Date(value.approvedAt);
  if (!Number.isFinite(approvedAt.getTime()) || approvedAt.getTime() > now.getTime() + 300_000 || approvedAt.getTime() < now.getTime() - 86_400_000) throw new Error("Approval must have a valid recent timestamp.");
  return { approvedBy: context.actorId, approvedAt: approvedAt.toISOString(), reason: value.reason.trim() };
}

function requireExpectedVersion(record: PremiumRecord, input: Record<string, unknown>) {
  const expected = whole(input, "expectedVersion", 1);
  if (record.version !== expected) throw new Error(`The ${record.recordType} version is stale.`);
}

export class PremiumBusinessEngine {
  private readonly records = new Map<string, PremiumRecord>();
  private readonly receipts = new Map<string, PremiumAuditReceipt>();
  private readonly idempotency = new Map<string, IdempotentOutcome>();

  async execute<M extends PremiumModuleId>(context: PremiumEngineContext, moduleId: M, actionId: PremiumActionIdFor<M>, input: Record<string, unknown>): Promise<PremiumExecutionResult> {
    validateContext(context);
    const action = premiumBusinessActions.find((candidate) => candidate.moduleId === moduleId && candidate.id === actionId);
    if (!action) throw new Error(`Unknown premium action ${moduleId}.${String(actionId)}.`);
    const module = premiumBusinessModuleById.get(moduleId);
    if (!module || !premiumPlanAllows(context.plan, module)) throw new Error(`${module?.name ?? moduleId} requires the $${module?.minimumMonthlyPlanUsd ?? 200}/month ${module?.minPlan ?? "fleet"} plan.`);
    validateInput(action, input);
    const now = (context.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) throw new Error("The execution clock is invalid.");
    const inputHash = digest(input);
    const dryRun = input.dryRun === true;
    if (input.dryRun !== undefined && !action.supportsDryRun) throw new Error("This action does not support dry-run input.");
    if (action.externalEffect !== "none" && !action.requiresApproval) throw new Error("External-effect actions must be approval-gated by metadata.");

    let approvedBy: string | undefined;
    let idempotencyKey: string | undefined;
    if (action.operation !== "read") {
      idempotencyKey = text(input, "idempotencyKey", 200);
      const idempotencyScope = `${context.tenantId}:${moduleId}:${action.id}:${idempotencyKey}`;
      if (!dryRun) {
        const replay = this.idempotency.get(idempotencyScope);
        if (replay) {
          if (replay.inputHash !== inputHash) throw new Error("The idempotency key was already used for different input.");
          const replayReceipt = this.receipt(context, action, inputHash, clone(replay.records), "replayed", false, true, now, undefined, replay.originalReceiptId);
          return { action, records: clone(replay.records), preview: clone(replay.preview), privateOutput: clone(replay.privateOutput), audit: replayReceipt };
        }
      }
      if (action.requiresApproval && !dryRun) approvedBy = approvalFor(context, input, now).approvedBy;
    }

    const outcome = await this.dispatch(context, action, input, now, dryRun);
    const decision = dryRun ? "previewed" : outcome.decision ?? (action.operation === "read" ? "read" : action.operation === "ai" ? "queued" : "applied");
    const audit = this.receipt(context, action, inputHash, outcome.records, decision, dryRun, false, now, approvedBy);
    if (action.operation !== "read" && !dryRun && idempotencyKey) {
      this.idempotency.set(`${context.tenantId}:${moduleId}:${action.id}:${idempotencyKey}`, { inputHash, records: clone(outcome.records), preview: clone(outcome.preview), privateOutput: clone(outcome.privateOutput), originalReceiptId: audit.id });
    }
    return { action, records: clone(outcome.records), preview: clone(outcome.preview), privateOutput: clone(outcome.privateOutput), audit };
  }

  getRecord(context: Pick<PremiumEngineContext, "tenantId">, recordId: string) {
    const record = this.records.get(recordId);
    return record?.tenantId === context.tenantId ? clone(record) : undefined;
  }

  listRecords(context: Pick<PremiumEngineContext, "tenantId">, filter: { moduleId?: PremiumModuleId; recordType?: string } = {}) {
    return [...this.records.values()].filter((record) => record.tenantId === context.tenantId && (!filter.moduleId || record.moduleId === filter.moduleId) && (!filter.recordType || record.recordType === filter.recordType)).map(clone);
  }

  listAuditReceipts(context: Pick<PremiumEngineContext, "tenantId">) {
    return [...this.receipts.values()].filter((receipt) => receipt.tenantId === context.tenantId).map(clone);
  }

  private receipt(context: PremiumEngineContext, action: PremiumActionDefinition, inputHash: string, records: PremiumRecord[], decision: PremiumAuditReceipt["decision"], dryRun: boolean, replayed: boolean, now: Date, approvedBy?: string, originalReceiptId?: string) {
    const base = { id: randomUUID(), tenantId: context.tenantId, actorId: context.actorId, requestId: context.requestId, moduleId: action.moduleId, actionId: action.id, risk: action.risk, destructive: action.destructive, externalEffect: action.externalEffect, decision, dryRun, replayed, inputHash, recordIds: records.map((record) => record.id), approvedBy, originalReceiptId, createdAt: now.toISOString() };
    const receipt: PremiumAuditReceipt = { ...base, receiptHash: digest(base) };
    this.receipts.set(receipt.id, receipt);
    return clone(receipt);
  }

  private create(context: PremiumEngineContext, moduleId: PremiumModuleId, recordType: string, title: string, state: string, data: Record<string, unknown>, now: Date) {
    const timestamp = now.toISOString();
    const record: PremiumRecord = { id: randomUUID(), tenantId: context.tenantId, moduleId, recordType, title, state, version: 1, data: clone(data), createdAt: timestamp, updatedAt: timestamp };
    this.records.set(record.id, record);
    return clone(record);
  }

  private update(context: PremiumEngineContext, record: PremiumRecord, changes: { title?: string; state?: string; data?: Record<string, unknown> }, now: Date) {
    const current = this.owned(context, record.id);
    const updated: PremiumRecord = { ...current, title: changes.title ?? current.title, state: changes.state ?? current.state, version: current.version + 1, data: { ...current.data, ...(changes.data ?? {}) }, updatedAt: now.toISOString() };
    this.records.set(updated.id, updated);
    return clone(updated);
  }

  private owned(context: Pick<PremiumEngineContext, "tenantId">, recordId: unknown, moduleId?: PremiumModuleId, recordType?: string | readonly string[]) {
    if (typeof recordId !== "string") throw new Error("recordId must be a UUID string.");
    const record = this.records.get(recordId);
    const allowedTypes = typeof recordType === "string" ? [recordType] : recordType;
    if (!record || record.tenantId !== context.tenantId || (moduleId && record.moduleId !== moduleId) || (allowedTypes && !allowedTypes.includes(record.recordType))) throw new Error("Record not found in this tenant.");
    return clone(record);
  }

  private evidence(context: PremiumEngineContext, value: unknown, options: { include?: string; moduleId?: PremiumModuleId; recordType?: string | readonly string[] } = {}) {
    const ids = uniqueStrings(value, "evidenceIds", 100);
    if (options.include && !ids.includes(options.include)) throw new Error("The primary source record must be included in evidenceIds.");
    return ids.map((recordId) => this.owned(context, recordId, options.moduleId, options.recordType));
  }

  private async dispatch(context: PremiumEngineContext, action: PremiumActionDefinition, input: Record<string, unknown>, now: Date, dryRun: boolean): Promise<HandlerOutcome> {
    if (action.moduleId === "projects") return this.projects(context, action.id, input, now, dryRun);
    if (action.moduleId === "drive") return this.drive(context, action.id, input, now, dryRun);
    if (action.moduleId === "channels") return this.channels(context, action.id, input, now, dryRun);
    if (action.moduleId === "operations") return this.operations(context, action.id, input, now, dryRun);
    if (action.moduleId === "assistant") return this.assistant(context, action.id, input, now, dryRun);
    throw new Error("Premium module dispatch is not implemented.");
  }

  private aiRequest(context: PremiumEngineContext, moduleId: PremiumModuleId, title: string, source: Record<string, unknown>, prompt: string, model: string, evidence: PremiumRecord[], now: Date, dryRun: boolean, extra: Record<string, unknown> = {}): HandlerOutcome {
    const aiAudit = { promptVersion: prompt, modelId: model, confidence: null, evidenceIds: evidence.map((record) => record.id), review: { status: "pending", required: true }, output: null, fabricatedOutputAllowed: false };
    const preview = { wouldQueueModelRun: true, aiAudit, source: canonical(source), approvalRequired: true, automaticMutationAllowed: false, ...extra };
    if (dryRun) return { records: [], preview };
    const request = this.create(context, moduleId, "ai-request", title, "queued", { source: canonical(source), aiAudit, approvalRequired: true, automaticMutationAllowed: false, ...extra }, now);
    return { records: [request], preview: { aiRequestId: request.id, output: null }, decision: "queued" };
  }

  private projects(context: PremiumEngineContext, actionId: string, input: Record<string, unknown>, now: Date, dryRun: boolean): HandlerOutcome {
    if (actionId === "project-create") {
      const stableKey = text(input, "key", 40);
      if (this.listRecords(context, { moduleId: "projects", recordType: "project" }).some((record) => record.data.key === stableKey)) throw new Error("Project key already exists in this tenant.");
      const record = this.create(context, "projects", "project", text(input, "name", 160), "active", { key: stableKey, outcome: text(input, "outcome", 2000) }, now);
      return { records: [record] };
    }
    if (actionId === "issue-create") {
      const project = this.owned(context, input.projectId, "projects", "project");
      const issue = this.create(context, "projects", "issue", text(input, "title", 240), "backlog", { projectId: project.id, priority: text(input, "priority", 20), points: whole(input, "points", 1, 100), dependencyIds: [] }, now);
      return { records: [issue] };
    }
    if (actionId === "dependency-link") {
      const issue = this.owned(context, input.issueId, "projects", "issue");
      const dependency = this.owned(context, input.dependsOnIssueId, "projects", "issue");
      requireExpectedVersion(issue, input);
      if (issue.id === dependency.id || issue.data.projectId !== dependency.data.projectId) throw new Error("Dependencies must be different issues in the same project.");
      const existing = Array.isArray(issue.data.dependencyIds) ? issue.data.dependencyIds.map(String) : [];
      if (existing.includes(dependency.id)) return { records: [issue], preview: { alreadyLinked: true } };
      const reaches = (start: string, target: string, visited = new Set<string>()): boolean => {
        if (start === target) return true;
        if (visited.has(start)) return false;
        visited.add(start);
        const candidate = this.owned(context, start, "projects", "issue");
        const dependencies = Array.isArray(candidate.data.dependencyIds) ? candidate.data.dependencyIds.map(String) : [];
        return dependencies.some((recordId) => reaches(recordId, target, visited));
      };
      if (reaches(dependency.id, issue.id)) throw new Error("The dependency would create a cycle.");
      return { records: [this.update(context, issue, { data: { dependencyIds: [...existing, dependency.id] } }, now)] };
    }
    if (actionId === "issue-transition") {
      const issue = this.owned(context, input.issueId, "projects", "issue");
      requireExpectedVersion(issue, input);
      const target = text(input, "toState", 20);
      if (!(allowedTransitions[issue.state] ?? []).includes(target)) throw new Error(`Invalid issue transition from ${issue.state} to ${target}.`);
      return { records: [this.update(context, issue, { state: target, data: { transitionReason: text(input, "reason", 1000), transitionedBy: context.actorId } }, now)] };
    }
    if (actionId === "cycle-draft") {
      const project = this.owned(context, input.projectId, "projects", "project");
      const issueIds = uniqueStrings(input.issueIds, "issueIds", 200);
      const issues = issueIds.map((recordId) => this.owned(context, recordId, "projects", "issue"));
      if (issues.some((issue) => issue.data.projectId !== project.id || issue.state === "done")) throw new Error("Every cycle issue must be an unfinished issue in the selected project.");
      const capacityPoints = whole(input, "capacityPoints", 1, 10_000);
      const issueSnapshot = issues.map((issue) => ({ id: issue.id, version: issue.version, points: issue.data.points, state: issue.state }));
      const committedPoints = issueSnapshot.reduce((sum, issue) => sum + Number(issue.points), 0);
      if (!Number.isSafeInteger(committedPoints) || committedPoints > capacityPoints) throw new Error("Selected issue points exceed cycle capacity.");
      const snapshot = { projectId: project.id, title: text(input, "title", 160), capacityPoints, committedPoints, issueSnapshot };
      const contentHash = digest(snapshot);
      const cycle = this.create(context, "projects", "cycle", snapshot.title, "draft", { ...snapshot, contentHash }, now);
      return { records: [cycle], preview: { contentHash, remainingPoints: capacityPoints - committedPoints } };
    }
    if (actionId === "cycle-commit") {
      const cycle = this.owned(context, input.cycleId, "projects", "cycle");
      const contentHash = text(input, "contentHash", 64);
      if (cycle.state !== "draft" || cycle.data.contentHash !== contentHash) throw new Error("Only the exact draft cycle hash can be committed.");
      const snapshot = Array.isArray(cycle.data.issueSnapshot) ? cycle.data.issueSnapshot : [];
      for (const item of snapshot) {
        if (!isPlainObject(item)) throw new Error("Cycle issue snapshot is invalid.");
        const current = this.owned(context, item.id, "projects", "issue");
        if (current.version !== item.version || current.state !== item.state || current.data.points !== item.points) throw new Error("Cycle evidence changed after drafting; create a new cycle snapshot.");
      }
      if (dryRun) return { records: [], preview: { wouldCommit: cycle.id, contentHash, issueCount: snapshot.length } };
      return { records: [this.update(context, cycle, { state: "active", data: { committedBy: context.actorId, committedAt: now.toISOString() } }, now)] };
    }
    if (actionId === "plan-propose" || actionId === "health-explain") {
      const project = this.owned(context, input.projectId, "projects", "project");
      const evidence = this.evidence(context, input.evidenceIds, { include: project.id });
      const goal = text(input, actionId === "plan-propose" ? "objective" : "question", 4000);
      return this.aiRequest(context, "projects", `${actionId}: ${project.title}`, { projectId: project.id, goal }, text(input, "promptVersion", 120), text(input, "modelId", 200), evidence, now, dryRun, { proposalOnly: true });
    }
    throw new Error(`Projects action ${actionId} is not implemented.`);
  }

  private sharePlan(context: PremiumEngineContext, input: Record<string, unknown>, now: Date) {
    const file = this.owned(context, input.fileId, "drive", "file");
    if (file.state !== "available") throw new Error("Only an available file can be shared.");
    const expiresAt = dateTime(input, "expiresAt");
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 365 * 86_400_000) throw new Error("Share expiry must be in the future and within one year.");
    const plan = { fileId: file.id, fileVersion: file.version, checksum: file.data.checksum, permission: text(input, "permission", 20), expiresAt: expiresAt.toISOString() };
    return { file, plan, previewHash: digest(plan) };
  }

  private drive(context: PremiumEngineContext, actionId: string, input: Record<string, unknown>, now: Date, dryRun: boolean): HandlerOutcome {
    if (actionId === "vault-create") {
      const vault = this.create(context, "drive", "vault", text(input, "name", 160), "active", { classification: text(input, "classification", 20) }, now);
      return { records: [vault] };
    }
    if (actionId === "file-register") {
      const vault = this.owned(context, input.vaultId, "drive", "vault");
      const objectKey = text(input, "objectKey", 1000);
      if (/^[a-z]+:\/\//i.test(objectKey) || objectKey.includes("?") || objectKey.includes("..")) throw new Error("objectKey must be an opaque relative storage key without URL credentials or traversal.");
      const snapshot = { vaultId: vault.id, name: text(input, "name", 240), objectKey, contentType: text(input, "contentType", 200), sizeBytes: whole(input, "sizeBytes", 1, 5_368_709_120), checksum: text(input, "checksum", 64) };
      if (dryRun) return { records: [], preview: { wouldRegister: snapshot, objectBytesStoredInRecord: false } };
      const file = this.create(context, "drive", "file", snapshot.name, "available", { ...snapshot, retention: null, legalHold: false }, now);
      const version = this.create(context, "drive", "file-version", `${snapshot.name} v1`, "immutable", { fileId: file.id, version: 1, objectKey, sizeBytes: snapshot.sizeBytes, checksum: snapshot.checksum }, now);
      return { records: [file, version] };
    }
    if (actionId === "file-version-add") {
      const file = this.owned(context, input.fileId, "drive", "file");
      requireExpectedVersion(file, input);
      if (file.state !== "available") throw new Error("Only an available file accepts a new version.");
      const objectKey = text(input, "objectKey", 1000);
      if (/^[a-z]+:\/\//i.test(objectKey) || objectKey.includes("?") || objectKey.includes("..")) throw new Error("objectKey must be an opaque relative storage key.");
      const next = file.version + 1;
      const snapshot = { objectKey, sizeBytes: whole(input, "sizeBytes", 1, 5_368_709_120), checksum: text(input, "checksum", 64), version: next };
      if (dryRun) return { records: [], preview: { fileId: file.id, nextVersion: next, ...snapshot } };
      const version = this.create(context, "drive", "file-version", `${file.title} v${next}`, "immutable", { fileId: file.id, ...snapshot }, now);
      const updated = this.update(context, file, { data: { ...snapshot, currentVersionRecordId: version.id } }, now);
      return { records: [updated, version] };
    }
    if (actionId === "share-preview") {
      const result = this.sharePlan(context, input, now);
      return { records: [], preview: { ...result.plan, previewHash: result.previewHash, mutationApplied: false } };
    }
    if (actionId === "share-create") {
      const result = this.sharePlan(context, input, now);
      if (text(input, "previewHash", 64) !== result.previewHash) throw new Error("The share preview hash is stale or does not match.");
      if (dryRun) return { records: [], preview: { ...result.plan, previewHash: result.previewHash, wouldCreateShare: true } };
      const shareToken = randomUUID();
      const share = this.create(context, "drive", "share", `${result.file.title} share`, "active", { ...result.plan, tokenHash: digest(shareToken), tokenStoredPlaintext: false }, now);
      return { records: [share], privateOutput: { shareToken } };
    }
    if (actionId === "retention-set") {
      const file = this.owned(context, input.fileId, "drive", "file");
      requireExpectedVersion(file, input);
      const retainUntil = dateTime(input, "retainUntil").toISOString();
      const legalHold = input.legalHold === true;
      if (dryRun) return { records: [], preview: { fileId: file.id, retainUntil, legalHold, wouldUpdateVersion: file.version + 1 } };
      return { records: [this.update(context, file, { data: { retention: retainUntil, legalHold, retentionSetBy: context.actorId } }, now)] };
    }
    if (actionId === "file-delete") {
      const file = this.owned(context, input.fileId, "drive", "file");
      requireExpectedVersion(file, input);
      if (file.data.legalHold === true) throw new Error("A file under legal hold cannot be deleted.");
      if (typeof file.data.retention === "string" && new Date(file.data.retention).getTime() > now.getTime()) throw new Error("The active retention window blocks deletion.");
      const reason = text(input, "reason", 1000);
      if (dryRun) return { records: [], preview: { fileId: file.id, wouldSoftDelete: true, reason, objectDeletionDelegated: true } };
      return { records: [this.update(context, file, { state: "deleted", data: { deletedAt: now.toISOString(), deletedBy: context.actorId, deletionReason: reason, objectDeletionRequired: true } }, now)] };
    }
    if (actionId === "document-understand") {
      const file = this.owned(context, input.fileId, "drive", "file");
      if (file.state !== "available") throw new Error("Only an available file can be analyzed.");
      const evidence = this.evidence(context, input.evidenceIds, { include: file.id });
      return this.aiRequest(context, "drive", `Document analysis: ${file.title}`, { fileId: file.id, checksum: file.data.checksum, question: text(input, "question", 4000) }, text(input, "promptVersion", 120), text(input, "modelId", 200), evidence, now, dryRun, { objectKeySharedWithModel: false, citationRequired: true });
    }
    throw new Error(`Drive action ${actionId} is not implemented.`);
  }

  private messagePlan(context: PremiumEngineContext, input: Record<string, unknown>) {
    const topic = this.owned(context, input.topicId, "channels", "topic");
    if (topic.state !== "open") throw new Error("Messages can only be posted to an open topic.");
    const body = text(input, "body", 12_000);
    const plan = { topicId: topic.id, topicVersion: topic.version, body, bodyHash: digest(body) };
    return { topic, body, plan, previewHash: digest(plan) };
  }

  private channels(context: PremiumEngineContext, actionId: string, input: Record<string, unknown>, now: Date, dryRun: boolean): HandlerOutcome {
    if (actionId === "stream-create") {
      const stableKey = text(input, "key", 40);
      if (this.listRecords(context, { moduleId: "channels", recordType: "stream" }).some((record) => record.data.key === stableKey)) throw new Error("Stream key already exists in this tenant.");
      return { records: [this.create(context, "channels", "stream", text(input, "name", 160), "active", { key: stableKey, purpose: text(input, "purpose", 2000) }, now)] };
    }
    if (actionId === "topic-create") {
      const stream = this.owned(context, input.streamId, "channels", "stream");
      return { records: [this.create(context, "channels", "topic", text(input, "title", 240), "open", { streamId: stream.id, intent: text(input, "intent", 2000), decision: null }, now)] };
    }
    if (actionId === "message-preview") {
      const result = this.messagePlan(context, input);
      return { records: [], preview: { ...result.plan, previewHash: result.previewHash, mutationApplied: false } };
    }
    if (actionId === "message-post") {
      const result = this.messagePlan(context, input);
      if (text(input, "previewHash", 64) !== result.previewHash) throw new Error("The message preview hash is stale or does not match.");
      if (dryRun) return { records: [], preview: { ...result.plan, previewHash: result.previewHash, wouldPost: true } };
      const message = this.create(context, "channels", "message", result.topic.title, "posted", { topicId: result.topic.id, streamId: result.topic.data.streamId, body: result.body, bodyHash: result.plan.bodyHash, postedBy: context.actorId }, now);
      return { records: [message] };
    }
    if (actionId === "message-redact") {
      const message = this.owned(context, input.messageId, "channels", "message");
      requireExpectedVersion(message, input);
      if (message.state === "redacted") throw new Error("The message is already redacted.");
      const reason = text(input, "reason", 1000);
      if (dryRun) return { records: [], preview: { messageId: message.id, wouldRedact: true, originalBodyHash: message.data.bodyHash } };
      return { records: [this.update(context, message, { state: "redacted", data: { body: null, redactedAt: now.toISOString(), redactedBy: context.actorId, redactionReason: reason } }, now)] };
    }
    if (actionId === "topic-resolve") {
      const topic = this.owned(context, input.topicId, "channels", "topic");
      requireExpectedVersion(topic, input);
      if (topic.state !== "open") throw new Error("Only an open topic can be resolved.");
      return { records: [this.update(context, topic, { state: "resolved", data: { decision: text(input, "decision", 4000), resolvedBy: context.actorId, resolvedAt: now.toISOString() } }, now)] };
    }
    if (actionId === "topic-summarize") {
      const topic = this.owned(context, input.topicId, "channels", "topic");
      const evidence = this.evidence(context, input.evidenceIds, { moduleId: "channels", recordType: "message" });
      if (evidence.some((record) => record.data.topicId !== topic.id)) throw new Error("Topic summaries may use only messages from the selected topic.");
      return this.aiRequest(context, "channels", `Topic summary: ${topic.title}`, { topicId: topic.id, question: text(input, "question", 4000) }, text(input, "promptVersion", 120), text(input, "modelId", 200), evidence, now, dryRun, { proposalOnly: true });
    }
    if (actionId === "digest-draft") {
      const stream = this.owned(context, input.streamId, "channels", "stream");
      const evidence = this.evidence(context, input.evidenceIds, { moduleId: "channels", recordType: "topic" });
      if (evidence.some((record) => record.data.streamId !== stream.id)) throw new Error("Stream digests may use only topics from the selected stream.");
      return this.aiRequest(context, "channels", `Digest: ${stream.title}`, { streamId: stream.id, instruction: text(input, "instruction", 4000) }, text(input, "promptVersion", 120), text(input, "modelId", 200), evidence, now, dryRun, { proposalOnly: true, automaticSendAllowed: false });
    }
    throw new Error(`Channels action ${actionId} is not implemented.`);
  }

  private normalizedJournal(input: Record<string, unknown>) {
    const currency = text(input, "currency", 3);
    const period = text(input, "period", 7);
    const memo = text(input, "memo", 1000);
    if (!Array.isArray(input.entries) || input.entries.length < 2 || input.entries.length > 200) throw new Error("entries must contain 2 to 200 journal lines.");
    const entries = input.entries.map((entry, index) => {
      if (!isPlainObject(entry)) throw new Error(`entries[${index}] must be an object.`);
      const account = text(entry, "account", 120);
      const debitMinor = whole(entry, "debitMinor", 0, 1_000_000_000_000);
      const creditMinor = whole(entry, "creditMinor", 0, 1_000_000_000_000);
      if ((debitMinor === 0) === (creditMinor === 0)) throw new Error("Each journal line must contain exactly one positive debit or credit.");
      return { account, debitMinor, creditMinor };
    });
    const debitMinor = entries.reduce((sum, entry) => sum + entry.debitMinor, 0);
    const creditMinor = entries.reduce((sum, entry) => sum + entry.creditMinor, 0);
    if (!Number.isSafeInteger(debitMinor) || debitMinor <= 0 || debitMinor !== creditMinor) throw new Error("Journal debits and credits must balance exactly in integer minor units.");
    const snapshot = { currency, period, memo, entries, debitMinor, creditMinor };
    return { snapshot, previewHash: digest(snapshot) };
  }

  private operations(context: PremiumEngineContext, actionId: string, input: Record<string, unknown>, now: Date, dryRun: boolean): HandlerOutcome {
    if (actionId === "party-create") return { records: [this.create(context, "operations", "party", text(input, "name", 240), "active", { kind: text(input, "kind", 20), currency: text(input, "currency", 3) }, now)] };
    if (actionId === "item-create") {
      const sku = text(input, "sku", 80);
      if (this.listRecords(context, { moduleId: "operations", recordType: "item" }).some((record) => record.data.sku === sku)) throw new Error("SKU already exists in this tenant.");
      return { records: [this.create(context, "operations", "item", text(input, "name", 240), "active", { sku, currency: text(input, "currency", 3), unitPriceMinor: whole(input, "unitPriceMinor", 0, 1_000_000_000_000) }, now)] };
    }
    if (actionId === "order-create") {
      const party = this.owned(context, input.partyId, "operations", "party");
      if (party.data.kind !== "customer") throw new Error("Sales orders require a customer party.");
      const currency = text(input, "currency", 3);
      if (party.data.currency !== currency) throw new Error("Order and party currencies must match.");
      if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 200) throw new Error("lines must contain 1 to 200 order lines.");
      const lines = input.lines.map((line, index) => {
        if (!isPlainObject(line)) throw new Error(`lines[${index}] must be an object.`);
        const item = this.owned(context, line.itemId, "operations", "item");
        if (item.data.currency !== currency) throw new Error("Every order item must use the order currency.");
        const quantity = whole(line, "quantity", 1, 1_000_000);
        const unitPriceMinor = Number(item.data.unitPriceMinor);
        const totalMinor = quantity * unitPriceMinor;
        if (!Number.isSafeInteger(totalMinor)) throw new Error("Order line total exceeds safe integer bounds.");
        return { itemId: item.id, sku: item.data.sku, quantity, unitPriceMinor, totalMinor };
      });
      const totalMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0);
      if (!Number.isSafeInteger(totalMinor)) throw new Error("Order total exceeds safe integer bounds.");
      const snapshot = { partyId: party.id, currency, lines, totalMinor };
      return { records: [this.create(context, "operations", "order", `Order for ${party.title}`, "confirmed", { ...snapshot, contentHash: digest(snapshot) }, now)] };
    }
    if (actionId === "invoice-draft") {
      const order = this.owned(context, input.orderId, "operations", "order");
      const issueAt = dateTime(input, "issueAt");
      const dueAt = dateTime(input, "dueAt");
      if (dueAt < issueAt) throw new Error("Invoice dueAt cannot precede issueAt.");
      const snapshot = { orderId: order.id, orderContentHash: order.data.contentHash, partyId: order.data.partyId, currency: order.data.currency, lines: order.data.lines, totalMinor: order.data.totalMinor, balanceMinor: order.data.totalMinor, issueAt: issueAt.toISOString(), dueAt: dueAt.toISOString() };
      const invoice = this.create(context, "operations", "invoice", `Invoice for ${order.title}`, "draft", { ...snapshot, contentHash: digest(snapshot), immutableAfterIssue: true }, now);
      return { records: [invoice], preview: { contentHash: invoice.data.contentHash } };
    }
    if (actionId === "invoice-issue") {
      const invoice = this.owned(context, input.invoiceId, "operations", "invoice");
      const contentHash = text(input, "contentHash", 64);
      if (invoice.state !== "draft" || invoice.data.contentHash !== contentHash) throw new Error("Only the exact draft invoice hash can be issued.");
      if (dryRun) return { records: [], preview: { invoiceId: invoice.id, contentHash, wouldIssue: true, externalDelivery: false } };
      return { records: [this.update(context, invoice, { state: "open", data: { issuedAt: now.toISOString(), issuedBy: context.actorId } }, now)] };
    }
    if (actionId === "journal-preview") {
      const journal = this.normalizedJournal(input);
      return { records: [], preview: { ...journal.snapshot, previewHash: journal.previewHash, mutationApplied: false } };
    }
    if (actionId === "journal-post") {
      const journal = this.normalizedJournal(input);
      if (text(input, "previewHash", 64) !== journal.previewHash) throw new Error("The journal preview hash is stale or does not match.");
      if (dryRun) return { records: [], preview: { ...journal.snapshot, previewHash: journal.previewHash, wouldPost: true } };
      const posting = this.create(context, "operations", "journal", journal.snapshot.memo, "posted", { ...journal.snapshot, contentHash: journal.previewHash, immutable: true, postedBy: context.actorId }, now);
      return { records: [posting] };
    }
    if (actionId === "payment-record") {
      const invoice = this.owned(context, input.invoiceId, "operations", "invoice");
      if (invoice.state !== "open") throw new Error("Payments require an open issued invoice.");
      const currency = text(input, "currency", 3);
      const amountMinor = whole(input, "amountMinor", 1, 1_000_000_000_000);
      const balanceMinor = Number(invoice.data.balanceMinor);
      if (invoice.data.currency !== currency || amountMinor > balanceMinor) throw new Error("Payment currency must match and amount cannot exceed invoice balance.");
      const nextBalance = balanceMinor - amountMinor;
      if (dryRun) return { records: [], preview: { invoiceId: invoice.id, amountMinor, currency, currentBalanceMinor: balanceMinor, nextBalanceMinor: nextBalance } };
      const payment = this.create(context, "operations", "payment", text(input, "reference", 240), "recorded", { invoiceId: invoice.id, amountMinor, currency, reference: text(input, "reference", 240), recordedBy: context.actorId, immutable: true }, now);
      const updated = this.update(context, invoice, { state: nextBalance === 0 ? "paid" : "open", data: { balanceMinor: nextBalance, lastPaymentId: payment.id } }, now);
      return { records: [updated, payment] };
    }
    if (actionId === "variance-explain") {
      const evidence = this.evidence(context, input.evidenceIds, { moduleId: "operations", recordType: ["order", "invoice", "payment", "journal"] });
      return this.aiRequest(context, "operations", "Variance explanation", { question: text(input, "question", 4000) }, text(input, "promptVersion", 120), text(input, "modelId", 200), evidence, now, dryRun, { mayPostAccountingFacts: false });
    }
    throw new Error(`Operations action ${actionId} is not implemented.`);
  }

  private groundedRun(context: PremiumEngineContext, input: Record<string, unknown>) {
    const prompt = this.owned(context, input.promptVersionId, "assistant", "prompt-version");
    const collection = this.owned(context, input.collectionId, "assistant", "collection");
    const evidence = this.evidence(context, input.evidenceIds);
    const attachments = this.listRecords(context, { moduleId: "assistant", recordType: "source-attachment" }).filter((record) => record.data.collectionId === collection.id);
    const attachmentsByRecord = new Map(attachments.map((record) => [String(record.data.recordId), record]));
    if (evidence.some((record) => !attachmentsByRecord.has(record.id))) throw new Error("Every run evidence record must be checksum-attached to the selected collection.");
    for (const record of evidence) {
      const attachment = attachmentsByRecord.get(record.id)!;
      if (attachment.data.sourceVersion !== record.version || attachment.data.sourceSnapshotHash !== digest(record)) throw new Error("Attached evidence changed after it was pinned; attach the current exact version before running a model.");
    }
    const plan = { promptVersionId: prompt.id, promptContentHash: prompt.data.contentHash, collectionId: collection.id, evidenceIds: evidence.map((record) => record.id), evidenceHashes: evidence.map((record) => ({ recordId: record.id, recordSnapshotHash: digest(record), contentHash: attachmentsByRecord.get(record.id)!.data.contentHash })), modelId: text(input, "modelId", 200), goal: text(input, "goal", 4000), reviewRequired: true };
    return { prompt, collection, evidence, plan, previewHash: digest(plan) };
  }

  private assistant(context: PremiumEngineContext, actionId: string, input: Record<string, unknown>, now: Date, dryRun: boolean): HandlerOutcome {
    if (actionId === "collection-create") return { records: [this.create(context, "assistant", "collection", text(input, "name", 160), "active", { purpose: text(input, "purpose", 2000) }, now)] };
    if (actionId === "source-attach") {
      const collection = this.owned(context, input.collectionId, "assistant", "collection");
      const source = this.owned(context, input.recordId);
      if (source.id === collection.id) throw new Error("A collection cannot cite itself as evidence.");
      const contentHash = text(input, "contentHash", 64);
      const sourceSnapshotHash = digest(source);
      const existing = this.listRecords(context, { moduleId: "assistant", recordType: "source-attachment" }).find((record) => record.data.collectionId === collection.id && record.data.recordId === source.id && record.data.contentHash === contentHash && record.data.sourceVersion === source.version && record.data.sourceSnapshotHash === sourceSnapshotHash);
      if (existing) return { records: [existing], preview: { alreadyAttached: true } };
      const attachment = this.create(context, "assistant", "source-attachment", text(input, "citationLabel", 240), "active", { collectionId: collection.id, recordId: source.id, sourceModuleId: source.moduleId, sourceRecordType: source.recordType, sourceVersion: source.version, sourceSnapshotHash, contentHash, rawPayloadCopied: false }, now);
      return { records: [attachment] };
    }
    if (actionId === "prompt-version-create") {
      if (!isPlainObject(input.inputContract) || !isPlainObject(input.outputContract)) throw new Error("Prompt contracts must be objects.");
      const content = { name: text(input, "name", 160), systemInstruction: text(input, "systemInstruction", 20_000), inputContract: canonical(input.inputContract), outputContract: canonical(input.outputContract), evidenceRequired: true, unsupportedClaimsForbidden: true };
      const contentHash = digest(content);
      const prompt = this.create(context, "assistant", "prompt-version", content.name, "immutable", { ...content, contentHash }, now);
      return { records: [prompt], preview: { contentHash } };
    }
    if (actionId === "run-preview") {
      const run = this.groundedRun(context, input);
      return { records: [], preview: { ...run.plan, previewHash: run.previewHash, modelInvoked: false, output: null } };
    }
    if (actionId === "run-execute") {
      const run = this.groundedRun(context, input);
      if (text(input, "previewHash", 64) !== run.previewHash) throw new Error("The model run preview hash is stale or does not match.");
      return this.aiRequest(context, "assistant", `Model run: ${run.prompt.title}`, { promptVersionId: run.prompt.id, promptContentHash: run.prompt.data.contentHash, collectionId: run.collection.id, goal: run.plan.goal }, String(run.prompt.data.contentHash), String(run.plan.modelId), run.evidence, now, dryRun, { previewHash: run.previewHash, outputContract: run.prompt.data.outputContract });
    }
    if (actionId === "result-record") {
      const run = this.owned(context, input.runId, "assistant", "ai-request");
      if (run.state !== "queued") throw new Error("Only a queued model run can accept one reviewed result.");
      const aiAudit = isPlainObject(run.data.aiAudit) ? run.data.aiAudit : undefined;
      const allowedEvidence = new Set(Array.isArray(aiAudit?.evidenceIds) ? aiAudit.evidenceIds.map(String) : []);
      const evidence = this.evidence(context, input.evidenceIds);
      if (evidence.some((record) => !allowedEvidence.has(record.id))) throw new Error("Result evidence must be a subset of the authorized run evidence.");
      if (!isPlainObject(input.output) || typeof input.output.summary !== "string" || !input.output.summary.trim() || !Array.isArray(input.output.claims) || input.output.claims.length < 1 || input.output.claims.length > 200) throw new Error("output must contain a summary and 1 to 200 cited claims.");
      const claims = input.output.claims.map((claim, index) => {
        if (!isPlainObject(claim) || typeof claim.text !== "string" || !claim.text.trim() || !Array.isArray(claim.evidenceIds) || claim.evidenceIds.length < 1) throw new Error(`output.claims[${index}] must contain text and evidenceIds.`);
        const claimEvidenceIds = claim.evidenceIds.map(String);
        if (claimEvidenceIds.some((recordId) => !allowedEvidence.has(recordId) || !evidence.some((record) => record.id === recordId))) throw new Error("Every claim must cite only selected authorized evidence.");
        return { text: claim.text.trim(), evidenceIds: [...new Set(claimEvidenceIds)] };
      });
      if (!isPlainObject(input.review) || !["approved", "rejected"].includes(String(input.review.status)) || input.review.reviewedBy !== context.actorId || typeof input.review.reviewedAt !== "string" || !Number.isFinite(new Date(input.review.reviewedAt).getTime()) || typeof input.review.notes !== "string") throw new Error("A complete human review by the acting user is required.");
      const confidence = whole(input, "confidence", 0, 100);
      const resultData = { runId: run.id, output: { summary: input.output.summary.trim(), claims }, confidence, evidenceIds: evidence.map((record) => record.id), promptVersion: aiAudit?.promptVersion, modelId: aiAudit?.modelId, review: canonical(input.review), fabricatedOutputAllowed: false };
      if (dryRun) return { records: [], preview: { wouldRecordResult: true, ...resultData } };
      const result = this.create(context, "assistant", "ai-result", `Result for ${run.title}`, String(input.review.status), resultData, now);
      const completed = this.update(context, run, { state: String(input.review.status) === "approved" ? "completed" : "rejected", data: { resultId: result.id, confidence, review: canonical(input.review) } }, now);
      return { records: [completed, result] };
    }
    if (actionId === "agent-draft") {
      const prompt = this.owned(context, input.promptVersionId, "assistant", "prompt-version");
      const allowedActions = uniqueStrings(input.allowedActions, "allowedActions", 50);
      const knownTools = new Set(premiumBusinessActions.map((candidate) => candidate.mcpToolName));
      if (allowedActions.some((tool) => !knownTools.has(tool))) throw new Error("Every allowed agent action must be an exact registered premium MCP tool name.");
      const content = { name: text(input, "name", 160), purpose: text(input, "purpose", 2000), promptVersionId: prompt.id, promptContentHash: prompt.data.contentHash, allowedActions, maximumSteps: whole(input, "maximumSteps", 1, 50), automaticMutationAllowed: false };
      const contentHash = digest(content);
      const agent = this.create(context, "assistant", "agent", content.name, "draft", { ...content, contentHash }, now);
      return { records: [agent], preview: { contentHash } };
    }
    if (actionId === "agent-approve") {
      const agent = this.owned(context, input.agentId, "assistant", "agent");
      const contentHash = text(input, "contentHash", 64);
      if (agent.state !== "draft" || agent.data.contentHash !== contentHash) throw new Error("Only the exact draft agent content hash can be approved.");
      if (dryRun) return { records: [], preview: { agentId: agent.id, contentHash, wouldApprove: true } };
      return { records: [this.update(context, agent, { state: "approved", data: { approvedBy: context.actorId, approvedAt: now.toISOString() } }, now)] };
    }
    if (actionId === "agent-execute") {
      const agent = this.owned(context, input.agentId, "assistant", "agent");
      if (agent.state !== "approved") throw new Error("Only an exact approved agent version can be executed.");
      const prompt = this.owned(context, agent.data.promptVersionId, "assistant", "prompt-version");
      if (prompt.data.contentHash !== agent.data.promptContentHash) throw new Error("The agent prompt evidence is stale.");
      const evidence = this.evidence(context, input.evidenceIds);
      return this.aiRequest(context, "assistant", `Agent run: ${agent.title}`, { agentId: agent.id, agentContentHash: agent.data.contentHash, promptVersionId: prompt.id, goal: text(input, "goal", 4000) }, String(prompt.data.contentHash), text(input, "modelId", 200), evidence, now, dryRun, { allowedActions: agent.data.allowedActions, maximumSteps: agent.data.maximumSteps, automaticMutationAllowed: false, proposalsRequireSeparateApproval: true });
    }
    throw new Error(`Assistant action ${actionId} is not implemented.`);
  }
}
