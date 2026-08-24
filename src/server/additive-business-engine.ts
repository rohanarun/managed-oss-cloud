import { randomUUID } from "node:crypto";
import {
  additiveBusinessActionByKey,
  additiveBusinessModules,
  type AdditiveBusinessActionDefinition,
  type AdditiveBusinessModuleId,
  type AdditiveBusinessPlanId,
  type AdditiveBusinessRole,
  type AdditiveBusinessScope,
} from "../shared/additive-business-actions.js";
import type { SuiteRecord, SuiteWorkspaceRole } from "../shared/suite.js";
import { canonicalJsonSha256 } from "./ai-result.js";
import { canReadSuiteRecord } from "./suite-record-visibility.js";
import type { SuiteStore } from "./suite-store.js";

export interface AdditiveBusinessEngineContext {
  workspaceId: string;
  actorId: string;
  plan: AdditiveBusinessPlanId;
  role: AdditiveBusinessRole;
  workspaceMembers: readonly { userId: string; role: AdditiveBusinessRole }[];
  modelPolicyId?: string;
  scopes?: readonly string[];
  requestId?: string;
  now?: () => Date;
}

export interface AdditiveBusinessRecord {
  id: string;
  workspaceId: string;
  moduleId: AdditiveBusinessModuleId;
  recordType: string;
  title: string;
  state: string;
  version: number;
  contentHash: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AdditiveBusinessEvidenceRecord {
  id: string;
  workspaceId: string;
  moduleId: string;
  recordType: string;
  title: string;
  state: string;
  version: number;
  contentHash: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  readonlyExternal: true;
}

export interface AdditiveBusinessAuditReceipt {
  receiptId: string;
  requestId?: string;
  workspaceId: string;
  actorId: string;
  moduleId: AdditiveBusinessModuleId;
  actionId: string;
  inputDigest: string;
  dryRun: boolean;
  replayed: boolean;
  decision: "read" | "previewed" | "applied" | "queued" | "replayed";
  approvedBy: string | null;
  approvalDecisionId: string | null;
  approvedAt: string | null;
  approvalReason: string | null;
  modelExecuted: false;
  automaticMutationAllowed: false;
  externalEffectExecuted: false;
  createdAt: string;
}

export interface AdditiveBusinessExecutionResult {
  kind: "read" | "command" | "ai-proposal";
  records: AdditiveBusinessRecord[];
  preview?: Record<string, unknown>;
  audit: AdditiveBusinessAuditReceipt;
}

interface StoredReceipt {
  workspaceId: string;
  actorId: string;
  moduleId: AdditiveBusinessModuleId;
  actionId: string;
  idempotencyKey: string;
  inputDigest: string;
  result: AdditiveBusinessExecutionResult;
}

interface AdditiveBusinessApproval {
  approvedBy: string;
  approvedAt: string;
  decisionId: string;
  reason: string;
}

const planRank: Record<AdditiveBusinessPlanId, number> = { none: 0, starter: 1, scale: 2, fleet: 3 };
const roleRank: Record<AdditiveBusinessRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const moduleById = new Map(additiveBusinessModules.map((module) => [module.id, module] as const));
export const additiveBusinessApprovalFreshnessMs = 24 * 60 * 60 * 1_000;
const modelCredentialPattern = /(?:api[_-]?key|secret|token|sk-[a-z0-9])/i;

function expectedModelPolicyId(expectedModelId: unknown, trustedModelPolicyId: unknown) {
  if (typeof trustedModelPolicyId !== "string" || !trustedModelPolicyId.trim() || trustedModelPolicyId.length > 200 || modelCredentialPattern.test(trustedModelPolicyId)) throw new Error("A trusted workspace model policy is required before queuing additive AI work.");
  if (expectedModelId === undefined) return trustedModelPolicyId;
  if (typeof expectedModelId !== "string" || modelCredentialPattern.test(expectedModelId)) throw new Error("modelId must be an identifier, not a credential.");
  if (expectedModelId !== trustedModelPolicyId) throw new Error("modelId must exactly match the workspace-configured model policy.");
  return trustedModelPolicyId;
}

function digest(value: unknown) {
  return canonicalJsonSha256(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validDateTime(value: unknown) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function asObjects(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => asObject(item, `${label}[${index}]`));
}

function asStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of record IDs.`);
  return [...new Set(value as string[])];
}

function validateSchemaValue(label: string, value: unknown, schema: Readonly<Record<string, unknown>>) {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${label} is not an allowed value.`);
  if (schema.const !== undefined && value !== schema.const) throw new Error(`${label} must equal the required constant.`);
  const type = schema.type;
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${label} must be a string.`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(`${label} is too short.`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(`${label} is too long.`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) throw new Error(`${label} has an invalid format.`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${label} must be a UUID.`);
    if (schema.format === "date-time" && !validDateTime(value)) throw new Error(`${label} must be a valid date-time.`);
  }
  if (type === "integer") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
    if (typeof schema.minimum === "number" && Number(value) < schema.minimum) throw new Error(`${label} is below its minimum.`);
    if (typeof schema.maximum === "number" && Number(value) > schema.maximum) throw new Error(`${label} exceeds its maximum.`);
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`${label} is below its minimum.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`${label} exceeds its maximum.`);
  }
  if (type === "boolean" && typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${label} has too many items.`);
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === "object" && !Array.isArray(itemSchema)) value.forEach((item, index) => validateSchemaValue(`${label}[${index}]`, item, itemSchema as Readonly<Record<string, unknown>>));
  }
  if (type === "object") {
    const objectValue = asObject(value, label);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const field of required) if (typeof field === "string" && objectValue[field] === undefined) throw new Error(`${label}.${field} is required.`);
    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [field, fieldValue] of Object.entries(objectValue)) {
        const fieldSchema = (properties as Record<string, Readonly<Record<string, unknown>>>)[field];
        if (!fieldSchema && schema.additionalProperties === false) throw new Error(`${label}.${field} is not allowed.`);
        if (fieldSchema) validateSchemaValue(`${label}.${field}`, fieldValue, fieldSchema);
      }
    }
  }
}

function validateInput(action: AdditiveBusinessActionDefinition, input: Record<string, unknown>) {
  for (const required of action.inputSchema.required) if (input[required] === undefined) throw new Error(`${required} is required.`);
  for (const [field, value] of Object.entries(input)) {
    const schema = action.inputSchema.properties[field];
    if (!schema) throw new Error(`${field} is not allowed for ${action.moduleId}:${action.id}.`);
    validateSchemaValue(field, value, schema);
  }
}

export class AdditiveBusinessEngine {
  private readonly records = new Map<string, AdditiveBusinessRecord>();
  private readonly externalEvidence = new Map<string, AdditiveBusinessEvidenceRecord>();
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly dirtyRecordIds = new Set<string>();

  /**
   * Reference-engine hydration seam. Hosted callers should use
   * executeAdditiveBusinessActionWithStore, which loads and commits through
   * SuiteStore inside one workspace transaction.
   */
  hydrateRecordsForStoreAdapter(records: readonly AdditiveBusinessRecord[]) {
    if (this.records.size > 0 || this.externalEvidence.size > 0 || this.receipts.size > 0) throw new Error("The reference engine must be empty before store hydration.");
    for (const record of records) {
      if (!record.id || !record.workspaceId || !moduleById.has(record.moduleId) || !Number.isSafeInteger(record.version) || record.version < 1 || !/^[a-f0-9]{64}$/.test(record.contentHash)) throw new Error("The workspace contains a malformed additive business record.");
      if (this.records.has(record.id)) throw new Error("The workspace contains duplicate additive business record IDs.");
      this.records.set(record.id, clone(record));
    }
  }

  hydrateExternalEvidenceForStoreAdapter(records: readonly AdditiveBusinessEvidenceRecord[]) {
    for (const record of records) {
      if (!record.id || !record.workspaceId || !record.moduleId || !record.recordType || !Number.isSafeInteger(record.version) || record.version < 1 || !/^[a-f0-9]{64}$/.test(record.contentHash) || record.readonlyExternal !== true) throw new Error("The workspace contains malformed external evidence state.");
      if (this.records.has(record.id) || this.externalEvidence.has(record.id)) throw new Error("The workspace contains duplicate evidence record IDs.");
      this.externalEvidence.set(record.id, clone(record));
    }
  }

  changedRecordsForStoreAdapter() {
    return [...this.dirtyRecordIds].map((recordId) => this.records.get(recordId)).filter((record): record is AdditiveBusinessRecord => Boolean(record)).map(clone);
  }

  listRecords(context: AdditiveBusinessEngineContext, filter: { moduleId?: AdditiveBusinessModuleId; recordType?: string; state?: string } = {}) {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === context.workspaceId)
      .filter((record) => this.canRead(context, record))
      .filter((record) => !filter.moduleId || record.moduleId === filter.moduleId)
      .filter((record) => !filter.recordType || record.recordType === filter.recordType)
      .filter((record) => !filter.state || record.state === filter.state)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(clone);
  }

  getRecord(context: AdditiveBusinessEngineContext, recordId: string) {
    const record = this.records.get(recordId);
    return record?.workspaceId === context.workspaceId && this.canRead(context, record) ? clone(record) : undefined;
  }

  listAuditReceipts(context: AdditiveBusinessEngineContext) {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.workspaceId === context.workspaceId)
      .filter((receipt) => context.role === "owner" || context.role === "admin" || receipt.actorId === context.actorId)
      .map((receipt) => clone(receipt.result.audit))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.receiptId.localeCompare(right.receiptId));
  }

  async execute(
    context: AdditiveBusinessEngineContext,
    moduleId: AdditiveBusinessModuleId,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<AdditiveBusinessExecutionResult> {
    this.dirtyRecordIds.clear();
    this.assertContext(context);
    const action = additiveBusinessActionByKey.get(`${moduleId}:${actionId}`);
    if (!action) throw new Error(`Unknown additive business action ${moduleId}:${actionId}.`);
    this.assertPlan(context, moduleId);
    this.assertRole(context, action);
    this.assertScope(context, moduleId, action.requiredScope);
    validateInput(action, input);
    const trustedModelPolicyId = action.operation === "ai" ? expectedModelPolicyId(input.modelId, context.modelPolicyId) : undefined;

    const inputDigest = digest({ workspaceId: context.workspaceId, actorUserId: context.actorId, input });
    const idempotencyKey = action.idempotent ? String(input.idempotencyKey) : undefined;
    const receiptKey = idempotencyKey ? `${context.workspaceId}:${moduleId}:${actionId}:${idempotencyKey}` : undefined;
    if (receiptKey) {
      const existing = this.receipts.get(receiptKey);
      if (existing) {
        if (existing.actorId !== context.actorId) throw new Error("The idempotency key is bound to another workspace actor.");
        if (existing.inputDigest !== inputDigest) throw new Error("The idempotency key was already used for different input.");
        const replay = clone(existing.result);
        replay.audit.replayed = true;
        replay.audit.decision = "replayed";
        return replay;
      }
    }

    const now = this.now(context);
    const at = now.toISOString();
    const isDryRun = action.supportsDryRun && input.dryRun === true;
    const approval = isDryRun ? null : this.assertApprovalIfRequired(context, action, input, now);
    if (approval && [...this.receipts.values()].some((receipt) => receipt.workspaceId === context.workspaceId && receipt.result.audit.approvalDecisionId === approval.decisionId)) throw new Error("The human approval decision ID is already bound to another committed command.");
    let body: Omit<AdditiveBusinessExecutionResult, "audit">;
    if (isDryRun) {
      body = { kind: action.operation === "ai" ? "ai-proposal" : "command", records: [], preview: this.previewAction(context, action, input) };
    }
    else if (action.operation === "ai") {
      body = this.queueGroundedProposal(context, action, input, trustedModelPolicyId!, at);
    }
    else {
      body = this.dispatch(context, action, input, at);
    }

    const audit: AdditiveBusinessAuditReceipt = {
      receiptId: randomUUID(),
      requestId: context.requestId,
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      moduleId,
      actionId,
      inputDigest,
      dryRun: isDryRun,
      replayed: false,
      decision: isDryRun ? "previewed" : action.operation === "read" ? "read" : action.operation === "ai" ? "queued" : "applied",
      approvedBy: approval?.approvedBy ?? null,
      approvalDecisionId: approval?.decisionId ?? null,
      approvedAt: approval?.approvedAt ?? null,
      approvalReason: approval?.reason ?? null,
      modelExecuted: false,
      automaticMutationAllowed: false,
      externalEffectExecuted: false,
      createdAt: at,
    };
    const result: AdditiveBusinessExecutionResult = { ...body, audit };
    if (receiptKey && idempotencyKey) this.receipts.set(receiptKey, { workspaceId: context.workspaceId, actorId: context.actorId, moduleId, actionId, idempotencyKey, inputDigest, result: clone(result) });
    return clone(result);
  }

  private assertContext(context: AdditiveBusinessEngineContext) {
    if (typeof context.workspaceId !== "string" || !context.workspaceId.trim() || typeof context.actorId !== "string" || !context.actorId.trim()) throw new Error("Workspace and actor identity are required.");
    if (!Object.hasOwn(planRank, context.plan)) throw new Error("A recognized plan is required.");
    if (!Object.hasOwn(roleRank, context.role)) throw new Error("A recognized workspace role is required.");
    if (!Array.isArray(context.workspaceMembers) || context.workspaceMembers.length === 0) throw new Error("Authenticated workspace membership state is required.");
    const members = new Map<string, AdditiveBusinessRole>();
    for (const member of context.workspaceMembers) {
      if (!member || typeof member.userId !== "string" || !member.userId.trim() || !Object.hasOwn(roleRank, member.role) || members.has(member.userId)) throw new Error("Authenticated workspace membership state is malformed.");
      members.set(member.userId, member.role);
    }
    if (members.get(context.actorId) !== context.role) throw new Error("The acting identity and role must match an authenticated workspace member.");
  }

  private canRead(context: AdditiveBusinessEngineContext, record: AdditiveBusinessRecord | AdditiveBusinessEvidenceRecord) {
    return canReadSuiteRecord({ userId: context.actorId, workspaceId: context.workspaceId, role: context.role }, record);
  }

  private assertPlan(context: AdditiveBusinessEngineContext, moduleId: AdditiveBusinessModuleId) {
    const module = moduleById.get(moduleId)!;
    if (planRank[context.plan] < planRank[module.minPlan]) throw new Error(`${module.name} requires the ${module.minPlan === "starter" ? "$7/month Starter" : "$50/month Scale"} plan or higher.`);
  }

  private assertRole(context: AdditiveBusinessEngineContext, action: AdditiveBusinessActionDefinition) {
    if (roleRank[context.role] < roleRank[action.minimumRole]) throw new Error(`${action.minimumRole} role is required for ${action.moduleId}:${action.id}.`);
  }

  private assertScope(context: AdditiveBusinessEngineContext, moduleId: AdditiveBusinessModuleId, scope: AdditiveBusinessScope) {
    const scopes = context.scopes ?? ["*"];
    if (!scopes.includes("*") && !scopes.includes(`${moduleId}:*`) && !scopes.includes(`${moduleId}:${scope}`)) throw new Error(`${moduleId}:${scope} scope is required.`);
  }

  private assertApprovalIfRequired(context: AdditiveBusinessEngineContext, action: AdditiveBusinessActionDefinition, input: Record<string, unknown>, now: Date): AdditiveBusinessApproval | null {
    if (!action.requiresApproval) return null;
    if (!input.approval || typeof input.approval !== "object" || Array.isArray(input.approval)) throw new Error("A valid attributed human approval is required for this action.");
    const approval = input.approval as Record<string, unknown>;
    if (approval.approved !== true || approval.approvedBy !== context.actorId || !validDateTime(approval.approvedAt) || typeof approval.decisionId !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(approval.decisionId) || typeof approval.reason !== "string" || !approval.reason.trim()) throw new Error("A valid attributed human approval is required for this action.");
    const approvedAt = new Date(String(approval.approvedAt));
    if (approvedAt.getTime() > now.getTime()) throw new Error("Human approval cannot be future-dated.");
    if (now.getTime() - approvedAt.getTime() > additiveBusinessApprovalFreshnessMs) throw new Error("Human approval is stale and must be reviewed again against the current request.");
    return { approvedBy: context.actorId, approvedAt: approvedAt.toISOString(), decisionId: approval.decisionId, reason: approval.reason.trim() };
  }

  private now(context: AdditiveBusinessEngineContext) {
    const now = context.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("The trusted server clock is invalid.");
    return new Date(now.getTime());
  }

  private workspaceMember(context: AdditiveBusinessEngineContext, userRef: unknown, label: string) {
    if (typeof userRef !== "string" || !userRef.trim()) throw new Error(`${label} must identify an authenticated workspace member.`);
    const member = context.workspaceMembers.find((candidate) => candidate.userId === userRef);
    if (!member) throw new Error(`${label} must identify an authenticated workspace member.`);
    return member;
  }

  private actingMember(context: AdditiveBusinessEngineContext, userRef: unknown, label: string) {
    this.workspaceMember(context, userRef, label);
    if (userRef !== context.actorId) throw new Error(`${label} must match the acting authenticated workspace member.`);
  }

  private activeMembershipRefs(
    context: AdditiveBusinessEngineContext,
    options: {
      moduleId: AdditiveBusinessModuleId;
      recordType: string;
      parentField: string;
      parentId: string;
      identityField: string;
      additionalRef?: string | null;
      nullableIdentity?: boolean;
    },
  ) {
    const refs: string[] = [];
    const members = this.listRecords(context, { moduleId: options.moduleId, recordType: options.recordType, state: "active" })
      .filter((record) => record.data[options.parentField] === options.parentId);
    for (const member of members) {
      const ref = member.data[options.identityField];
      if (ref === null && options.nullableIdentity) continue;
      this.workspaceMember(context, ref, `${options.recordType}.${options.identityField}`);
      refs.push(String(ref));
    }
    if (options.additionalRef) {
      this.workspaceMember(context, options.additionalRef, options.identityField);
      refs.push(options.additionalRef);
    }
    return [...new Set(refs)].sort((left, right) => left.localeCompare(right));
  }

  private recordBelongsToParent(record: AdditiveBusinessRecord, moduleId: AdditiveBusinessModuleId, parentId: string, parentField: string) {
    if (record.moduleId !== moduleId || record.id === parentId) return false;
    if (record.data[parentField] === parentId) return true;
    const targetId = record.data.targetRecordId;
    if (typeof targetId !== "string") return false;
    const target = this.records.get(targetId);
    return Boolean(target && target.workspaceId === record.workspaceId && target.moduleId === moduleId && (target.id === parentId || target.data[parentField] === parentId));
  }

  private synchronizeMembershipVisibility(
    parent: AdditiveBusinessRecord,
    options: {
      parentField: string;
      childField: string;
      childParentField: string;
      refs: readonly string[];
    },
    at: string,
  ) {
    const refs = [...options.refs];
    const updatedParent = this.update(parent, { data: { ...parent.data, [options.parentField]: refs } }, at);
    for (const child of [...this.records.values()]) {
      if (!this.recordBelongsToParent(child, parent.moduleId, parent.id, options.childParentField)) continue;
      const existing = child.data[options.childField];
      if (Array.isArray(existing) && existing.length === refs.length && existing.every((value, index) => value === refs[index])) continue;
      this.update(child, { data: { ...child.data, [options.childField]: refs } }, at);
    }
    return updatedParent;
  }

  private owned(context: AdditiveBusinessEngineContext, recordId: unknown, expected?: { moduleId?: AdditiveBusinessModuleId; recordType?: string | readonly string[] }) {
    if (typeof recordId !== "string") throw new Error("A record ID is required.");
    const record = this.records.get(recordId);
    const recordTypes = typeof expected?.recordType === "string" ? [expected.recordType] : expected?.recordType;
    if (!record || record.workspaceId !== context.workspaceId || !this.canRead(context, record) || (expected?.moduleId && record.moduleId !== expected.moduleId) || (recordTypes && !recordTypes.includes(record.recordType))) throw new Error("The referenced record was not found in this workspace.");
    return record;
  }

  private evidenceRecord(context: AdditiveBusinessEngineContext, recordId: unknown) {
    if (typeof recordId !== "string") throw new Error("An evidence record ID is required.");
    const record = this.records.get(recordId) ?? this.externalEvidence.get(recordId);
    if (!record || record.workspaceId !== context.workspaceId || !this.canRead(context, record)) throw new Error("The referenced evidence record was not found in this workspace.");
    return record;
  }

  private evidence(context: AdditiveBusinessEngineContext, value: unknown) {
    const ids = asStrings(value, "evidenceIds");
    if (ids.length === 0) throw new Error("At least one tenant-owned evidence record is required.");
    return ids.map((id) => this.evidenceRecord(context, id));
  }

  private create(context: AdditiveBusinessEngineContext, moduleId: AdditiveBusinessModuleId, recordType: string, title: string, state: string, data: Record<string, unknown>, at: string) {
    const version = 1;
    const record: AdditiveBusinessRecord = {
      id: randomUUID(),
      workspaceId: context.workspaceId,
      moduleId,
      recordType,
      title,
      state,
      version,
      contentHash: digest({ moduleId, recordType, title, state, version, data }),
      data: clone(data),
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(record.id, record);
    this.dirtyRecordIds.add(record.id);
    return clone(record);
  }

  private update(record: AdditiveBusinessRecord, patch: { title?: string; state?: string; data?: Record<string, unknown> }, at: string) {
    record.title = patch.title ?? record.title;
    record.state = patch.state ?? record.state;
    record.data = patch.data ? clone(patch.data) : record.data;
    record.version += 1;
    record.updatedAt = at;
    record.contentHash = digest({ moduleId: record.moduleId, recordType: record.recordType, title: record.title, state: record.state, version: record.version, data: record.data });
    this.dirtyRecordIds.add(record.id);
    return clone(record);
  }

  private assertExpectedVersion(record: AdditiveBusinessRecord, value: unknown) {
    if (value !== record.version) throw new Error(`Expected version ${record.version}; the requested record is stale.`);
  }

  private previewAction(context: AdditiveBusinessEngineContext, action: AdditiveBusinessActionDefinition, input: Record<string, unknown>) {
    if (action.operation === "ai") {
      const binding = this.proposalBinding(context, action, input);
      return { wouldQueueProposal: action.id, modelInvoked: false, output: null, evidenceBindings: binding.evidenceBindings, automaticMutationAllowed: false };
    }
    if (action.moduleId === "tables" && action.id === "import-apply") {
      const rows = asObjects(input.rows, "rows");
      this.validateImport(context, String(input.baseId), rows);
      const expected = this.importHash(String(input.baseId), rows);
      if (input.previewHash !== expected) throw new Error("The import preview hash does not match the exact batch.");
      return { wouldCreateRows: rows.length, previewHash: expected };
    }
    if (action.moduleId === "meetings" && action.id === "transcript-redact") {
      const segment = this.owned(context, input.segmentId, { moduleId: "meetings", recordType: "transcript-segment" });
      const meeting = this.owned(context, segment.data.meetingId, { moduleId: "meetings", recordType: "meeting" });
      this.meetingBoundary(context, meeting);
      this.assertExpectedVersion(segment, input.expectedVersion);
      return { wouldRedact: segment.id, currentHash: segment.contentHash };
    }
    if (action.moduleId === "insights" && action.id === "observation-import") {
      this.owned(context, input.metricId, { moduleId: "insights", recordType: "insight-metric" });
      const observations = this.validateObservations(input.observations);
      return { wouldAppendObservations: observations.length, sourceRevision: input.sourceRevision };
    }
    if (action.moduleId === "insights" && action.id === "snapshot-freeze") {
      this.owned(context, input.dashboardId, { moduleId: "insights", recordType: "insight-dashboard" });
      const evidence = this.evidence(context, input.evidenceIds);
      return { wouldFreeze: evidence.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash })), asOf: input.asOf };
    }
    if (action.moduleId === "learning" && action.id === "credential-issue") {
      const eligibility = this.credentialEligibility(context, String(input.enrollmentId), String(input.attemptId));
      if (input.previewHash !== eligibility.previewHash) throw new Error("The credential preview hash does not match current eligibility.");
      if (!eligibility.eligible) throw new Error("The selected attempt does not meet the rubric passing score.");
      return { wouldIssueCredential: true, ...eligibility };
    }
    if (action.moduleId === "community" && action.id === "post-hide") {
      const post = this.owned(context, input.postId, { moduleId: "community", recordType: "community-post" });
      const space = this.owned(context, post.data.spaceId, { moduleId: "community", recordType: "community-space" });
      this.spaceBoundary(context, space, true);
      this.assertExpectedVersion(post, input.expectedVersion);
      return { wouldHide: post.id, currentHash: post.contentHash };
    }
    if (action.moduleId === "community" && action.id === "member-role-set") {
      const member = this.owned(context, input.memberId, { moduleId: "community", recordType: "community-member" });
      const space = this.owned(context, member.data.spaceId, { moduleId: "community", recordType: "community-space" });
      this.spaceBoundary(context, space);
      this.workspaceMember(context, member.data.memberRef, "community memberRef");
      this.assertExpectedVersion(member, input.expectedVersion);
      return { wouldSetRole: input.role, memberId: member.id, currentHash: member.contentHash };
    }
    if (action.moduleId === "community" && action.id === "announcement-publish") {
      const space = this.owned(context, input.spaceId, { moduleId: "community", recordType: "community-space" });
      this.spaceBoundary(context, space, true);
      const evidence = this.evidence(context, input.evidenceIds);
      return { wouldPublishExactCopy: true, copyHash: digest({ title: input.title, body: input.body }), evidenceIds: evidence.map((record) => record.id) };
    }
    return { validated: true, actionId: action.id };
  }

  private dispatch(context: AdditiveBusinessEngineContext, action: AdditiveBusinessActionDefinition, input: Record<string, unknown>, at: string): Omit<AdditiveBusinessExecutionResult, "audit"> {
    if (action.moduleId === "tables") return this.tables(context, action.id, input, at);
    if (action.moduleId === "meetings") return this.meetings(context, action.id, input, at);
    if (action.moduleId === "insights") return this.insights(context, action.id, input, at);
    if (action.moduleId === "learning") return this.learning(context, action.id, input, at);
    return this.community(context, action.id, input, at);
  }

  private command(records: AdditiveBusinessRecord[], preview?: Record<string, unknown>): Omit<AdditiveBusinessExecutionResult, "audit"> {
    return { kind: "command", records, ...(preview ? { preview } : {}) };
  }

  private read(preview: Record<string, unknown>): Omit<AdditiveBusinessExecutionResult, "audit"> {
    return { kind: "read", records: [], preview };
  }

  private tableFields(context: AdditiveBusinessEngineContext, baseId: string) {
    this.owned(context, baseId, { moduleId: "tables", recordType: "table-base" });
    return this.listRecords(context, { moduleId: "tables", recordType: "table-field" }).filter((field) => field.data.baseId === baseId);
  }

  private validateRow(context: AdditiveBusinessEngineContext, baseId: string, values: Record<string, unknown>) {
    const fields = this.tableFields(context, baseId);
    const byKey = new Map(fields.map((field) => [String(field.data.key), field]));
    for (const key of Object.keys(values)) if (!byKey.has(key)) throw new Error(`Row value ${key} is not a registered field.`);
    for (const field of fields) if (field.data.required === true && values[String(field.data.key)] === undefined) throw new Error(`Required field ${String(field.data.key)} is missing.`);
    for (const [key, value] of Object.entries(values)) {
      const type = byKey.get(key)?.data.fieldType;
      if (type === "text" && typeof value !== "string") throw new Error(`${key} must be text.`);
      if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${key} must be a finite number.`);
      if (type === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be boolean.`);
      if (type === "date-time" && !validDateTime(value)) throw new Error(`${key} must be a valid date-time.`);
      if (type === "relation") this.evidenceRecord(context, value);
    }
  }

  private validateImport(context: AdditiveBusinessEngineContext, baseId: string, rows: Record<string, unknown>[]) {
    if (rows.length === 0) throw new Error("At least one row is required for import.");
    rows.forEach((row) => this.validateRow(context, baseId, row));
  }

  private importHash(baseId: string, rows: Record<string, unknown>[]) {
    return digest({ version: "schemadeck-import.v1", baseId, rows });
  }

  private tables(context: AdditiveBusinessEngineContext, actionId: string, input: Record<string, unknown>, at: string) {
    if (actionId === "base-create") {
      if (this.listRecords(context, { moduleId: "tables", recordType: "table-base" }).some((record) => record.data.key === input.key)) throw new Error("A base with this key already exists in the workspace.");
      return this.command([this.create(context, "tables", "table-base", String(input.name), "active", { key: input.key, purpose: input.purpose, schemaVersion: 1 }, at)]);
    }
    if (actionId === "field-add") {
      const base = this.owned(context, input.baseId, { moduleId: "tables", recordType: "table-base" });
      if (this.tableFields(context, base.id).some((record) => record.data.key === input.key)) throw new Error("A field with this key already exists in the base.");
      return this.command([this.create(context, "tables", "table-field", String(input.label), "active", { baseId: base.id, key: input.key, fieldType: input.fieldType, required: input.required === true }, at)]);
    }
    if (actionId === "row-create") {
      const baseId = String(input.baseId);
      const values = asObject(input.values, "values");
      this.validateRow(context, baseId, values);
      const sources = Array.isArray(input.sourceRecordIds) ? asStrings(input.sourceRecordIds, "sourceRecordIds").map((id) => this.evidenceRecord(context, id)) : [];
      return this.command([this.create(context, "tables", "table-row", `Row ${this.listRecords(context, { moduleId: "tables", recordType: "table-row" }).filter((record) => record.data.baseId === baseId).length + 1}`, "active", { baseId, values, sourceBindings: sources.map((record) => ({ recordId: record.id, moduleId: record.moduleId, recordType: record.recordType, version: record.version, contentHash: record.contentHash, readonlyExternal: "readonlyExternal" in record })) }, at)]);
    }
    if (actionId === "row-update") {
      const row = this.owned(context, input.rowId, { moduleId: "tables", recordType: "table-row" });
      this.assertExpectedVersion(row, input.expectedVersion);
      const patch = asObject(input.patch, "patch");
      const values = { ...asObject(row.data.values, "stored row values"), ...patch };
      this.validateRow(context, String(row.data.baseId), values);
      return this.command([this.update(row, { data: { ...row.data, values, lastEditedBy: context.actorId } }, at)]);
    }
    if (actionId === "view-create") {
      const baseId = String(input.baseId);
      const fields = new Set(this.tableFields(context, baseId).map((field) => String(field.data.key)));
      for (const key of Object.keys(asObject(input.filter, "filter"))) if (!fields.has(key)) throw new Error(`View filter ${key} is not a registered field.`);
      for (const [index, sort] of asObjects(input.sort, "sort").entries()) {
        if (!fields.has(String(sort.field)) || !["asc", "desc"].includes(String(sort.direction))) throw new Error(`sort[${index}] is invalid.`);
      }
      return this.command([this.create(context, "tables", "table-view", String(input.name), "active", { baseId, filter: input.filter, sort: input.sort }, at)]);
    }
    if (actionId === "import-preview") {
      const rows = asObjects(input.rows, "rows");
      this.validateImport(context, String(input.baseId), rows);
      return this.read({ rowCount: rows.length, previewHash: this.importHash(String(input.baseId), rows), wouldWrite: false });
    }
    if (actionId === "import-apply") {
      const baseId = String(input.baseId);
      const rows = asObjects(input.rows, "rows");
      this.validateImport(context, baseId, rows);
      const previewHash = this.importHash(baseId, rows);
      if (input.previewHash !== previewHash) throw new Error("The import preview hash does not match the exact batch.");
      return this.command(rows.map((values, index) => this.create(context, "tables", "table-row", `Imported row ${index + 1}`, "active", { baseId, values, import: { previewHash, rowIndex: index, approvedBy: context.actorId } }, at)));
    }
    if (actionId === "formula-evaluate") {
      const baseId = String(input.baseId);
      this.owned(context, baseId, { moduleId: "tables", recordType: "table-base" });
      const rows = this.listRecords(context, { moduleId: "tables", recordType: "table-row", state: "active" }).filter((record) => record.data.baseId === baseId);
      if (input.operation === "count") return this.read({ operation: "count", value: rows.length, rowCount: rows.length, deterministic: true });
      const fieldKey = String(input.fieldKey);
      const field = this.tableFields(context, baseId).find((record) => record.data.key === fieldKey);
      if (!field || field.data.fieldType !== "number") throw new Error("The aggregate field must be a registered number field.");
      const values = rows.map((row) => asObject(row.data.values, "stored row values")[fieldKey]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (values.length === 0) throw new Error("No numeric values are available for this aggregate.");
      const sum = values.reduce((total, value) => total + value, 0);
      const result = input.operation === "sum" ? sum : input.operation === "min" ? Math.min(...values) : input.operation === "max" ? Math.max(...values) : sum / values.length;
      return this.read({ operation: input.operation, fieldKey, value: result, valueCount: values.length, deterministic: true });
    }
    throw new Error(`Unsupported tables action ${actionId}.`);
  }

  private meetingBoundary(context: AdditiveBusinessEngineContext, meeting: AdditiveBusinessRecord) {
    const privacy = meeting.data.privacy;
    const createdBy = meeting.data.createdBy;
    if (!["workspace", "confidential", "restricted"].includes(String(privacy)) || typeof createdBy !== "string" || !createdBy) throw new Error("The meeting is missing trusted privacy attribution and cannot be mutated.");
    const meetingParticipantUserRefs = this.activeMembershipRefs(context, {
      moduleId: "meetings",
      recordType: "meeting-participant",
      parentField: "meetingId",
      parentId: meeting.id,
      identityField: "userRef",
      nullableIdentity: true,
    });
    if (privacy !== "workspace" && roleRank[context.role] < roleRank.admin && createdBy !== context.actorId && !meetingParticipantUserRefs.includes(context.actorId)) throw new Error("Only the meeting creator, an attributed participant, or an admin can mutate this sensitive meeting.");
    return { meetingPrivacy: privacy, meetingCreatedBy: createdBy, meetingParticipantUserRefs };
  }

  private meetings(context: AdditiveBusinessEngineContext, actionId: string, input: Record<string, unknown>, at: string) {
    if (actionId === "meeting-create") return this.command([this.create(context, "meetings", "meeting", String(input.title), "scheduled", { purpose: input.purpose, startsAt: input.startsAt, privacy: input.privacy, createdBy: context.actorId, participantUserRefs: [] }, at)]);
    if (actionId === "participant-add") {
      const meeting = this.owned(context, input.meetingId, { moduleId: "meetings", recordType: "meeting" });
      const boundary = this.meetingBoundary(context, meeting);
      const userRef = typeof input.userRef === "string" && input.userRef.trim() ? input.userRef : null;
      if (userRef) this.workspaceMember(context, userRef, "userRef");
      const meetingParticipantUserRefs = this.activeMembershipRefs(context, {
        moduleId: "meetings",
        recordType: "meeting-participant",
        parentField: "meetingId",
        parentId: meeting.id,
        identityField: "userRef",
        additionalRef: userRef,
        nullableIdentity: true,
      });
      const visibility = { ...boundary, meetingParticipantUserRefs };
      const updatedMeeting = this.synchronizeMembershipVisibility(meeting, { parentField: "participantUserRefs", childField: "meetingParticipantUserRefs", childParentField: "meetingId", refs: meetingParticipantUserRefs }, at);
      const participant = this.create(context, "meetings", "meeting-participant", String(input.displayName), "active", { meetingId: meeting.id, ...visibility, role: input.role, userRef }, at);
      return this.command([participant, updatedMeeting]);
    }
    if (actionId === "transcript-append") {
      const meeting = this.owned(context, input.meetingId, { moduleId: "meetings", recordType: "meeting" });
      const boundary = this.meetingBoundary(context, meeting);
      if (Number(input.endMs) <= Number(input.startMs)) throw new Error("Transcript endMs must be greater than startMs.");
      const speakerRef = context.workspaceMembers.some((member) => member.userId === input.speaker) ? String(input.speaker) : undefined;
      return this.command([this.create(context, "meetings", "transcript-segment", `${String(input.speaker)} ${input.startMs}-${input.endMs}`, "captured", { meetingId: meeting.id, ...boundary, speaker: input.speaker, ...(speakerRef ? { speakerRef } : {}), recordedBy: context.actorId, startMs: input.startMs, endMs: input.endMs, text: input.text, source: input.source, redacted: false }, at)]);
    }
    if (actionId === "decision-record") {
      const meeting = this.owned(context, input.meetingId, { moduleId: "meetings", recordType: "meeting" });
      const boundary = this.meetingBoundary(context, meeting);
      this.workspaceMember(context, input.ownerRef, "ownerRef");
      const evidence = this.evidence(context, input.evidenceIds);
      return this.command([this.create(context, "meetings", "meeting-decision", String(input.decision).slice(0, 160), "decided", { meetingId: meeting.id, ...boundary, decision: input.decision, ownerRef: input.ownerRef, evidenceBindings: evidence.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash })), recordedBy: context.actorId }, at)]);
    }
    if (actionId === "action-item-create") {
      const meeting = this.owned(context, input.meetingId, { moduleId: "meetings", recordType: "meeting" });
      const boundary = this.meetingBoundary(context, meeting);
      this.workspaceMember(context, input.ownerRef, "ownerRef");
      const evidence = this.evidence(context, input.evidenceIds);
      return this.command([this.create(context, "meetings", "meeting-action-item", String(input.title), "open", { meetingId: meeting.id, ...boundary, ownerRef: input.ownerRef, createdBy: context.actorId, dueAt: input.dueAt, evidenceBindings: evidence.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash })) }, at)]);
    }
    if (actionId === "transcript-redact") {
      const segment = this.owned(context, input.segmentId, { moduleId: "meetings", recordType: "transcript-segment" });
      const meeting = this.owned(context, segment.data.meetingId, { moduleId: "meetings", recordType: "meeting" });
      const boundary = this.meetingBoundary(context, meeting);
      this.assertExpectedVersion(segment, input.expectedVersion);
      return this.command([this.update(segment, { state: "redacted", data: { ...segment.data, ...boundary, text: null, redacted: true, redactedBy: context.actorId, redactedAt: at, redactionReason: input.reason } }, at)]);
    }
    if (actionId === "meeting-export") {
      const meeting = this.owned(context, input.meetingId, { moduleId: "meetings", recordType: "meeting" });
      const boundary = this.meetingBoundary(context, meeting);
      const included = this.listRecords(context, { moduleId: "meetings" }).filter((record) => record.id === meeting.id || record.data.meetingId === meeting.id).filter((record) => input.includeTranscript === true || record.recordType !== "transcript-segment");
      const bindings = included.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash }));
      return this.command([this.create(context, "meetings", "meeting-export", `${meeting.title} export`, "immutable", { meetingId: meeting.id, ...boundary, exportedBy: context.actorId, format: input.format, includeTranscript: input.includeTranscript, bindings, exportHash: digest(bindings) }, at)]);
    }
    throw new Error(`Unsupported meetings action ${actionId}.`);
  }

  private validateObservations(value: unknown) {
    const observations = asObjects(value, "observations");
    if (observations.length === 0) throw new Error("At least one observation is required.");
    for (const [index, observation] of observations.entries()) {
      if (!validDateTime(observation.observedAt) || typeof observation.value !== "number" || !Number.isFinite(observation.value)) throw new Error(`observations[${index}] must contain a valid observedAt and finite value.`);
      asObject(observation.dimensions ?? {}, `observations[${index}].dimensions`);
    }
    return observations;
  }

  private insights(context: AdditiveBusinessEngineContext, actionId: string, input: Record<string, unknown>, at: string) {
    if (actionId === "source-register") {
      this.workspaceMember(context, input.ownerRef, "ownerRef");
      return this.command([this.create(context, "insights", "insight-source", String(input.name), "active", { kind: input.kind, ownerRef: input.ownerRef, refreshCadence: input.refreshCadence, credentialStored: false }, at)]);
    }
    if (actionId === "metric-define") {
      const source = this.owned(context, input.sourceId, { moduleId: "insights", recordType: "insight-source" });
      if (this.listRecords(context, { moduleId: "insights", recordType: "insight-metric" }).some((metric) => metric.data.key === input.key)) throw new Error("A metric with this key already exists in the workspace.");
      return this.command([this.create(context, "insights", "insight-metric", String(input.name), "active", { sourceId: source.id, key: input.key, unit: input.unit, aggregation: input.aggregation }, at)]);
    }
    if (actionId === "observation-import") {
      const metric = this.owned(context, input.metricId, { moduleId: "insights", recordType: "insight-metric" });
      const observations = this.validateObservations(input.observations);
      return this.command(observations.map((observation) => this.create(context, "insights", "metric-observation", `${metric.title} at ${String(observation.observedAt)}`, "observed", { metricId: metric.id, observedAt: observation.observedAt, value: observation.value, dimensions: observation.dimensions ?? {}, sourceRevision: input.sourceRevision, importedBy: context.actorId }, at)));
    }
    if (actionId === "dashboard-create") return this.command([this.create(context, "insights", "insight-dashboard", String(input.name), "active", { purpose: input.purpose, audience: input.audience }, at)]);
    if (actionId === "chart-add") {
      const dashboard = this.owned(context, input.dashboardId, { moduleId: "insights", recordType: "insight-dashboard" });
      const metric = this.owned(context, input.metricId, { moduleId: "insights", recordType: "insight-metric" });
      return this.command([this.create(context, "insights", "insight-chart", `${metric.title} ${String(input.visualization)}`, "active", { dashboardId: dashboard.id, metricId: metric.id, visualization: input.visualization, window: input.window }, at)]);
    }
    if (actionId === "alert-rule-create") {
      const metric = this.owned(context, input.metricId, { moduleId: "insights", recordType: "insight-metric" });
      return this.command([this.create(context, "insights", "insight-alert-rule", `${metric.title} ${String(input.operator)} ${String(input.threshold)}`, "inert", { metricId: metric.id, operator: input.operator, threshold: input.threshold, cooldownMinutes: input.cooldownMinutes, deliveryConfigured: false }, at)]);
    }
    if (actionId === "snapshot-freeze") {
      const dashboard = this.owned(context, input.dashboardId, { moduleId: "insights", recordType: "insight-dashboard" });
      const evidence = this.evidence(context, input.evidenceIds);
      const bindings = evidence.map((record) => ({ recordId: record.id, moduleId: record.moduleId, recordType: record.recordType, version: record.version, contentHash: record.contentHash }));
      return this.command([this.create(context, "insights", "insight-snapshot", `${dashboard.title} ${String(input.asOf)}`, "immutable", { dashboardId: dashboard.id, asOf: input.asOf, bindings, snapshotHash: digest({ dashboardId: dashboard.id, asOf: input.asOf, bindings }) }, at)]);
    }
    throw new Error(`Unsupported insights action ${actionId}.`);
  }

  private courseBoundary(context: AdditiveBusinessEngineContext, course: AdditiveBusinessRecord, options: { learnerOwned?: boolean; learnerRef?: unknown } = {}) {
    const visibility = course.data.visibility;
    const createdBy = course.data.createdBy;
    if (!["private", "workspace", "public-catalog"].includes(String(visibility)) || typeof createdBy !== "string" || !createdBy) throw new Error("The course is missing trusted visibility attribution and cannot be accessed.");
    const courseLearnerRefs = this.activeMembershipRefs(context, {
      moduleId: "learning",
      recordType: "learning-enrollment",
      parentField: "courseId",
      parentId: course.id,
      identityField: "learnerRef",
    });
    if (visibility === "private" && roleRank[context.role] < roleRank.admin && createdBy !== context.actorId && (!options.learnerOwned || options.learnerRef !== context.actorId)) throw new Error("Only the course creator, its exact enrolled learner for learner-owned work, or an admin can mutate this private course.");
    return { courseVisibility: visibility, courseCreatedBy: createdBy, courseLearnerRefs };
  }

  private credentialEligibility(context: AdditiveBusinessEngineContext, enrollmentId: string, attemptId: string) {
    const enrollment = this.owned(context, enrollmentId, { moduleId: "learning", recordType: "learning-enrollment" });
    const course = this.owned(context, enrollment.data.courseId, { moduleId: "learning", recordType: "learning-course" });
    const boundary = this.courseBoundary(context, course, { learnerOwned: true, learnerRef: enrollment.data.learnerRef });
    const attempt = this.owned(context, attemptId, { moduleId: "learning", recordType: "learning-attempt" });
    if (attempt.data.enrollmentId !== enrollment.id) throw new Error("The attempt does not belong to the selected enrollment.");
    const rubric = this.owned(context, attempt.data.rubricId, { moduleId: "learning", recordType: "learning-rubric" });
    const eligible = Number(attempt.data.score) >= Number(rubric.data.passingScore);
    const facts = { courseId: course.id, courseVersion: course.version, ...boundary, learnerRef: enrollment.data.learnerRef, enrollmentId: enrollment.id, enrollmentVersion: enrollment.version, attemptId: attempt.id, attemptVersion: attempt.version, rubricId: rubric.id, rubricVersion: rubric.version, score: attempt.data.score, passingScore: rubric.data.passingScore, eligible };
    return { ...facts, previewHash: digest({ version: "learning-forge-credential.v1", ...facts }) };
  }

  private learning(context: AdditiveBusinessEngineContext, actionId: string, input: Record<string, unknown>, at: string) {
    if (actionId === "course-create") return this.command([this.create(context, "learning", "learning-course", String(input.title), "draft", { audience: input.audience, outcome: input.outcome, visibility: input.visibility, createdBy: context.actorId, learnerRefs: [] }, at)]);
    if (actionId === "lesson-create") {
      const course = this.owned(context, input.courseId, { moduleId: "learning", recordType: "learning-course" });
      const boundary = this.courseBoundary(context, course);
      const evidence = this.evidence(context, input.sourceRecordIds);
      if (this.listRecords(context, { moduleId: "learning", recordType: "learning-lesson" }).some((lesson) => lesson.data.courseId === course.id && lesson.data.position === input.position)) throw new Error("A lesson already occupies this course position.");
      return this.command([this.create(context, "learning", "learning-lesson", String(input.title), "draft", { courseId: course.id, ...boundary, content: input.content, position: input.position, sourceBindings: evidence.map((record) => ({ recordId: record.id, moduleId: record.moduleId, version: record.version, contentHash: record.contentHash })) }, at)]);
    }
    if (actionId === "learner-enroll") {
      const course = this.owned(context, input.courseId, { moduleId: "learning", recordType: "learning-course" });
      const boundary = this.courseBoundary(context, course);
      this.workspaceMember(context, input.learnerRef, "learnerRef");
      if (this.listRecords(context, { moduleId: "learning", recordType: "learning-enrollment" }).some((enrollment) => enrollment.data.courseId === course.id && enrollment.data.learnerRef === input.learnerRef && enrollment.state === "active")) throw new Error("This learner is already enrolled in the course.");
      const courseLearnerRefs = this.activeMembershipRefs(context, {
        moduleId: "learning",
        recordType: "learning-enrollment",
        parentField: "courseId",
        parentId: course.id,
        identityField: "learnerRef",
        additionalRef: String(input.learnerRef),
      });
      const visibility = { ...boundary, courseLearnerRefs };
      const updatedCourse = this.synchronizeMembershipVisibility(course, { parentField: "learnerRefs", childField: "courseLearnerRefs", childParentField: "courseId", refs: courseLearnerRefs }, at);
      const enrollment = this.create(context, "learning", "learning-enrollment", `${course.title}: ${String(input.learnerRef)}`, "active", { courseId: course.id, ...visibility, learnerRef: input.learnerRef, reason: input.reason, enrolledBy: context.actorId }, at);
      return this.command([enrollment, updatedCourse]);
    }
    if (actionId === "rubric-create") {
      const course = this.owned(context, input.courseId, { moduleId: "learning", recordType: "learning-course" });
      const boundary = this.courseBoundary(context, course);
      const criteria = asObjects(input.criteria, "criteria");
      if (criteria.length === 0 || criteria.some((criterion) => typeof criterion.key !== "string" || !criterion.key.trim() || typeof criterion.weight !== "number" || !Number.isFinite(criterion.weight) || criterion.weight <= 0)) throw new Error("Rubric criteria require unique keys and positive finite weights.");
      if (new Set(criteria.map((criterion) => criterion.key)).size !== criteria.length) throw new Error("Rubric criterion keys must be unique.");
      return this.command([this.create(context, "learning", "learning-rubric", String(input.name), "active", { courseId: course.id, ...boundary, criteria, passingScore: input.passingScore }, at)]);
    }
    if (actionId === "attempt-record") {
      const enrollment = this.owned(context, input.enrollmentId, { moduleId: "learning", recordType: "learning-enrollment" });
      const rubric = this.owned(context, input.rubricId, { moduleId: "learning", recordType: "learning-rubric" });
      if (rubric.data.courseId !== enrollment.data.courseId) throw new Error("The rubric and enrollment must belong to the same course.");
      const course = this.owned(context, enrollment.data.courseId, { moduleId: "learning", recordType: "learning-course" });
      const boundary = this.courseBoundary(context, course, { learnerOwned: true, learnerRef: enrollment.data.learnerRef });
      const evidence = this.evidence(context, input.evidenceIds);
      return this.command([this.create(context, "learning", "learning-attempt", `Attempt ${String(input.score)}`, "recorded", { enrollmentId: enrollment.id, rubricId: rubric.id, courseId: enrollment.data.courseId, ...boundary, learnerRef: enrollment.data.learnerRef, score: input.score, passed: Number(input.score) >= Number(rubric.data.passingScore), evidenceBindings: evidence.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash })), recordedBy: context.actorId }, at)]);
    }
    if (actionId === "credential-preview") return this.read(this.credentialEligibility(context, String(input.enrollmentId), String(input.attemptId)));
    if (actionId === "credential-issue") {
      const eligibility = this.credentialEligibility(context, String(input.enrollmentId), String(input.attemptId));
      if (input.previewHash !== eligibility.previewHash) throw new Error("The credential preview hash does not match current eligibility.");
      if (!eligibility.eligible) throw new Error("The selected attempt does not meet the rubric passing score.");
      if (this.listRecords(context, { moduleId: "learning", recordType: "learning-credential" }).some((credential) => credential.data.enrollmentId === eligibility.enrollmentId && credential.state === "issued")) throw new Error("An active credential already exists for this enrollment.");
      return this.command([this.create(context, "learning", "learning-credential", `Credential ${eligibility.enrollmentId}`, "issued", { ...eligibility, issuedBy: context.actorId, issuedAt: at, revocable: true }, at)]);
    }
    throw new Error(`Unsupported learning action ${actionId}.`);
  }

  private communityMember(context: AdditiveBusinessEngineContext, spaceId: string, memberRef: unknown) {
    return this.listRecords(context, { moduleId: "community", recordType: "community-member", state: "active" }).find((member) => member.data.spaceId === spaceId && member.data.memberRef === memberRef);
  }

  private spaceBoundary(context: AdditiveBusinessEngineContext, space: AdditiveBusinessRecord, requireActiveMember = false) {
    const visibility = space.data.visibility;
    const createdBy = space.data.createdBy;
    if (!["private", "workspace", "public"].includes(String(visibility)) || typeof createdBy !== "string" || !createdBy) throw new Error("The community space is missing trusted visibility attribution and cannot be mutated.");
    const spaceMemberRefs = this.activeMembershipRefs(context, {
      moduleId: "community",
      recordType: "community-member",
      parentField: "spaceId",
      parentId: space.id,
      identityField: "memberRef",
    });
    if (visibility === "private" && requireActiveMember && !spaceMemberRefs.includes(context.actorId)) throw new Error("The acting identity must be an active member of this private community space.");
    return { spaceVisibility: visibility, spaceCreatedBy: createdBy, spaceMemberRefs };
  }

  private community(context: AdditiveBusinessEngineContext, actionId: string, input: Record<string, unknown>, at: string) {
    if (actionId === "space-create") {
      if (this.listRecords(context, { moduleId: "community", recordType: "community-space" }).some((space) => space.data.key === input.key)) throw new Error("A community space with this key already exists.");
      return this.command([this.create(context, "community", "community-space", String(input.name), "active", { key: input.key, purpose: input.purpose, visibility: input.visibility, policy: input.policy, policyHash: digest(input.policy), createdBy: context.actorId, memberRefs: [] }, at)]);
    }
    if (actionId === "member-add") {
      const space = this.owned(context, input.spaceId, { moduleId: "community", recordType: "community-space" });
      const boundary = this.spaceBoundary(context, space);
      this.workspaceMember(context, input.memberRef, "memberRef");
      if (this.communityMember(context, space.id, input.memberRef)) throw new Error("This member already belongs to the space.");
      const spaceMemberRefs = this.activeMembershipRefs(context, {
        moduleId: "community",
        recordType: "community-member",
        parentField: "spaceId",
        parentId: space.id,
        identityField: "memberRef",
        additionalRef: String(input.memberRef),
      });
      const visibility = { ...boundary, spaceMemberRefs };
      const updatedSpace = this.synchronizeMembershipVisibility(space, { parentField: "memberRefs", childField: "spaceMemberRefs", childParentField: "spaceId", refs: spaceMemberRefs }, at);
      const member = this.create(context, "community", "community-member", String(input.displayName), "active", { spaceId: space.id, ...visibility, memberRef: input.memberRef, role: "member", addedBy: context.actorId }, at);
      return this.command([member, updatedSpace]);
    }
    if (actionId === "post-create") {
      const space = this.owned(context, input.spaceId, { moduleId: "community", recordType: "community-space" });
      const boundary = this.spaceBoundary(context, space, true);
      this.actingMember(context, input.authorRef, "authorRef");
      if (!this.communityMember(context, space.id, input.authorRef)) throw new Error("The author must be an active member of this space.");
      const evidence = this.evidence(context, input.evidenceIds);
      return this.command([this.create(context, "community", "community-post", String(input.title), "visible", { spaceId: space.id, ...boundary, authorRef: input.authorRef, body: input.body, evidenceBindings: evidence.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash })) }, at)]);
    }
    if (actionId === "reply-create") {
      const post = this.owned(context, input.postId, { moduleId: "community", recordType: "community-post" });
      const space = this.owned(context, post.data.spaceId, { moduleId: "community", recordType: "community-space" });
      const boundary = this.spaceBoundary(context, space, true);
      this.actingMember(context, input.authorRef, "authorRef");
      if (!this.communityMember(context, String(post.data.spaceId), input.authorRef)) throw new Error("The author must be an active member of this space.");
      const evidence = this.evidence(context, input.evidenceIds);
      return this.command([this.create(context, "community", "community-reply", `Reply to ${post.title}`, "visible", { postId: post.id, spaceId: space.id, ...boundary, authorRef: input.authorRef, body: input.body, evidenceBindings: evidence.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash })) }, at)]);
    }
    if (actionId === "reaction-record") {
      const post = this.owned(context, input.postId, { moduleId: "community", recordType: "community-post" });
      const space = this.owned(context, post.data.spaceId, { moduleId: "community", recordType: "community-space" });
      const boundary = this.spaceBoundary(context, space, true);
      this.actingMember(context, input.memberRef, "memberRef");
      if (!this.communityMember(context, String(post.data.spaceId), input.memberRef)) throw new Error("The reacting identity must be an active member of this space.");
      const existing = this.listRecords(context, { moduleId: "community", recordType: "community-reaction" }).find((reaction) => reaction.data.postId === post.id && reaction.data.memberRef === input.memberRef);
      if (existing) return this.command([this.update(this.records.get(existing.id)!, { state: input.reaction === "withdraw" ? "withdrawn" : "active", data: { ...existing.data, spaceId: space.id, ...boundary, reaction: input.reaction } }, at)]);
      return this.command([this.create(context, "community", "community-reaction", `${String(input.reaction)} on ${post.title}`, input.reaction === "withdraw" ? "withdrawn" : "active", { postId: post.id, spaceId: space.id, ...boundary, memberRef: input.memberRef, reaction: input.reaction }, at)]);
    }
    if (actionId === "post-hide") {
      const post = this.owned(context, input.postId, { moduleId: "community", recordType: "community-post" });
      const space = this.owned(context, post.data.spaceId, { moduleId: "community", recordType: "community-space" });
      const boundary = this.spaceBoundary(context, space, true);
      this.assertExpectedVersion(post, input.expectedVersion);
      return this.command([this.update(post, { state: "hidden", data: { ...post.data, ...boundary, moderation: { hiddenBy: context.actorId, hiddenAt: at, reason: input.reason }, bodyPreserved: true } }, at)]);
    }
    if (actionId === "member-role-set") {
      const member = this.owned(context, input.memberId, { moduleId: "community", recordType: "community-member" });
      const space = this.owned(context, member.data.spaceId, { moduleId: "community", recordType: "community-space" });
      const boundary = this.spaceBoundary(context, space);
      this.workspaceMember(context, member.data.memberRef, "community memberRef");
      this.assertExpectedVersion(member, input.expectedVersion);
      return this.command([this.update(member, { data: { ...member.data, ...boundary, role: input.role, roleChangedBy: context.actorId, roleChangeReason: input.reason } }, at)]);
    }
    if (actionId === "announcement-publish") {
      const space = this.owned(context, input.spaceId, { moduleId: "community", recordType: "community-space" });
      const boundary = this.spaceBoundary(context, space, true);
      const evidence = this.evidence(context, input.evidenceIds);
      return this.command([this.create(context, "community", "community-announcement", String(input.title), "published", { spaceId: space.id, ...boundary, body: input.body, exactCopyHash: digest({ title: input.title, body: input.body }), evidenceBindings: evidence.map((record) => ({ recordId: record.id, version: record.version, contentHash: record.contentHash })), publishedBy: context.actorId, publishedAt: at, modelAuthored: false }, at)]);
    }
    throw new Error(`Unsupported community action ${actionId}.`);
  }

  private proposalBinding(context: AdditiveBusinessEngineContext, action: AdditiveBusinessActionDefinition, input: Record<string, unknown>) {
    const targetId = input.baseId ?? input.meetingId ?? input.metricId ?? input.snapshotId ?? input.attemptId ?? input.enrollmentId ?? input.targetRecordId ?? input.spaceId;
    const target = this.owned(context, targetId);
    if (action.moduleId === "community") {
      const space = this.owned(context, input.spaceId, { moduleId: "community", recordType: "community-space" });
      if (target.id !== space.id && target.data.spaceId !== space.id) throw new Error("The community proposal target must belong to the selected space.");
    }
    const evidence = this.evidence(context, input.evidenceIds);
    const all = [...new Map([target, ...evidence].map((record) => [record.id, record])).values()];
    return {
      target,
      evidenceBindings: all.map((record) => ({ recordId: record.id, moduleId: record.moduleId, recordType: record.recordType, version: record.version, contentHash: record.contentHash })),
    };
  }

  private proposalVisibilityBoundary(context: AdditiveBusinessEngineContext, target: AdditiveBusinessRecord) {
    if (target.moduleId === "meetings") {
      const meeting = target.recordType === "meeting" ? target : this.owned(context, target.data.meetingId, { moduleId: "meetings", recordType: "meeting" });
      return this.meetingBoundary(context, meeting);
    }
    if (target.moduleId === "learning") {
      const enrollment = target.recordType === "learning-enrollment"
        ? target
        : target.recordType === "learning-attempt"
          ? this.owned(context, target.data.enrollmentId, { moduleId: "learning", recordType: "learning-enrollment" })
          : undefined;
      const courseId = target.recordType === "learning-course" ? target.id : enrollment?.data.courseId ?? target.data.courseId;
      const course = this.owned(context, courseId, { moduleId: "learning", recordType: "learning-course" });
      return { ...this.courseBoundary(context, course, { learnerOwned: Boolean(enrollment), learnerRef: enrollment?.data.learnerRef }), ...(enrollment ? { learnerRef: enrollment.data.learnerRef } : {}) };
    }
    if (target.moduleId === "community") {
      const space = target.recordType === "community-space" ? target : this.owned(context, target.data.spaceId, { moduleId: "community", recordType: "community-space" });
      return this.spaceBoundary(context, space, true);
    }
    return {};
  }

  private queueGroundedProposal(context: AdditiveBusinessEngineContext, action: AdditiveBusinessActionDefinition, input: Record<string, unknown>, trustedModelPolicyId: string, at: string): Omit<AdditiveBusinessExecutionResult, "audit"> {
    const binding = this.proposalBinding(context, action, input);
    const visibilityBoundary = this.proposalVisibilityBoundary(context, binding.target);
    const goal = String(input.goal ?? input.question ?? `Prepare a cited ${action.title.toLowerCase()} for ${String(input.audience ?? "human review")}.`);
    const request = this.create(context, action.moduleId, "ai-proposal-request", action.title, "queued", {
      proposalKind: action.id,
      targetRecordId: binding.target.id,
      ...visibilityBoundary,
      goal,
      modelPolicyId: trustedModelPolicyId,
      requestedModelId: trustedModelPolicyId,
      prompt: { id: action.promptId, version: action.promptVersion, digest: digest({ id: action.promptId, version: action.promptVersion, invariant: "Evidence-bound proposals only. Never apply a mutation, send, publish, moderate, score, credential, or alter records." }) },
      evidenceBindings: binding.evidenceBindings,
      evidenceIds: binding.evidenceBindings.map((item) => item.recordId),
      output: null,
      confidence: null,
      assumptions: [],
      review: { status: "pending-model", required: true, reviewedBy: null, reviewedAt: null },
      proposalOnly: true,
      automaticMutationAllowed: false,
      applyActionId: null,
      modelExecuted: false,
      fabricatedOutputAllowed: false,
      queuedBy: context.actorId,
    }, at);
    return { kind: "ai-proposal", records: [request], preview: { requestId: request.id, modelExecuted: false, output: null, automaticMutationAllowed: false } };
  }
}

const additiveRecordContract = "additive-business-record.v1";
const additiveReceiptContract = "additive-business-receipt.v1";
export const additiveBusinessModuleSnapshotLimit = 100_000;
export const additiveBusinessInputReferenceLimit = 1_000;
export const additiveBusinessStoredRelationReferenceLimit = 1_000;
export const additiveBusinessReceiptSnapshotLimitBytes = 64 * 1024;

export interface AdditiveBusinessAuthorization {
  userId: string;
  workspaceId: string;
  role: SuiteWorkspaceRole;
  scopes: readonly string[];
}

export interface AdditiveBusinessStoreDependencies {
  now?: () => Date;
  modelPolicyId?: string;
}

interface AdditiveReceiptSnapshot {
  kind: AdditiveBusinessExecutionResult["kind"];
  preview?: Record<string, unknown>;
  audit: AdditiveBusinessAuditReceipt;
  recordIds: string[];
  recordSnapshots: AdditiveBusinessRecord[];
}

function isAdditiveModuleId(value: unknown): value is AdditiveBusinessModuleId {
  return typeof value === "string" && moduleById.has(value as AdditiveBusinessModuleId);
}

function recordFromSuite(record: SuiteRecord): AdditiveBusinessRecord | undefined {
  if (record.data.additiveContract !== additiveRecordContract || !record.data.record || typeof record.data.record !== "object" || Array.isArray(record.data.record) || !isAdditiveModuleId(record.moduleId)) return undefined;
  const stored = record.data.record as Record<string, unknown>;
  if (stored.id !== record.id || stored.workspaceId !== record.workspaceId || stored.moduleId !== record.moduleId || stored.recordType !== record.recordType || stored.title !== record.title || stored.state !== record.state || typeof stored.recordType !== "string" || typeof stored.title !== "string" || typeof stored.state !== "string" || !Number.isSafeInteger(stored.version) || Number(stored.version) < 1 || typeof stored.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(stored.contentHash) || !stored.data || typeof stored.data !== "object" || Array.isArray(stored.data) || typeof stored.createdAt !== "string" || typeof stored.updatedAt !== "string") throw new Error(`Stored additive business record ${record.id} is malformed.`);
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    moduleId: record.moduleId,
    recordType: stored.recordType,
    title: stored.title,
    state: stored.state,
    version: Number(stored.version),
    contentHash: stored.contentHash,
    data: clone(stored.data as Record<string, unknown>),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function externalEvidenceFromSuite(record: SuiteRecord): AdditiveBusinessEvidenceRecord | undefined {
  if (isAdditiveModuleId(record.moduleId)) return undefined;
  const explicitVersion = record.data.version;
  const version = Number.isSafeInteger(explicitVersion) && Number(explicitVersion) >= 1 ? Number(explicitVersion) : 1;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    moduleId: record.moduleId,
    recordType: record.recordType,
    title: record.title,
    state: record.state,
    version,
    contentHash: digest({
      contract: "suite-record-evidence-snapshot.v1",
      id: record.id,
      workspaceId: record.workspaceId,
      moduleId: record.moduleId,
      recordType: record.recordType,
      title: record.title,
      state: record.state,
      version,
      data: record.data,
      updatedAt: record.updatedAt,
    }),
    data: clone(record.data),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    readonlyExternal: true,
  };
}

function recordEnvelope(record: AdditiveBusinessRecord) {
  return { additiveContract: additiveRecordContract, record: clone(record) };
}

function remapIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapIds(item, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, remapIds(item, ids)]));
  return value;
}

function inputRecordIds(value: unknown) {
  const ids = new Set<string>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 24) throw new Error("The action input nesting exceeds the safe reference-resolution depth.");
    if (typeof item === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)) ids.add(item);
      if (ids.size > additiveBusinessInputReferenceLimit) throw new Error(`The action references more than ${additiveBusinessInputReferenceLimit} records; split it into bounded requests.`);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (item && typeof item === "object") for (const child of Object.values(item as Record<string, unknown>)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...ids];
}

function storedRowUpdateRelationRecordIds(records: readonly AdditiveBusinessRecord[], moduleId: AdditiveBusinessModuleId, actionId: string, input: Record<string, unknown>) {
  if (moduleId !== "tables" || actionId !== "row-update" || typeof input.rowId !== "string") return [];
  const row = records.find((record) => record.id === input.rowId && record.moduleId === "tables" && record.recordType === "table-row");
  if (!row) return [];
  const baseId = row.data.baseId;
  if (typeof baseId !== "string") throw new Error("The stored table row is missing its base attribution; relation hydration stopped before mutation.");
  const values = { ...asObject(row.data.values, "stored row values"), ...asObject(input.patch, "patch") };
  const relationKeys = new Set(records
    .filter((record) => record.moduleId === "tables" && record.recordType === "table-field" && record.data.baseId === baseId && record.data.fieldType === "relation")
    .map((record) => String(record.data.key)));
  const ids = new Set<string>();
  for (const key of relationKeys) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Stored relation field ${key} does not contain a valid record UUID; row update stopped before mutation.`);
    ids.add(value);
    if (ids.size > additiveBusinessStoredRelationReferenceLimit) throw new Error(`The stored row depends on more than ${additiveBusinessStoredRelationReferenceLimit} relation records; row update stopped before mutation and requires a paginated relation resolver.`);
  }
  return [...ids];
}

function receiptSnapshot(result: AdditiveBusinessExecutionResult): AdditiveReceiptSnapshot {
  const snapshot: AdditiveReceiptSnapshot = {
    kind: result.kind,
    ...(result.preview ? { preview: clone(result.preview) } : {}),
    audit: clone(result.audit),
    recordIds: result.records.map((record) => record.id),
    recordSnapshots: clone(result.records),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > additiveBusinessReceiptSnapshotLimitBytes) throw new Error(`The immutable additive idempotency response exceeds the ${additiveBusinessReceiptSnapshotLimitBytes}-byte safe receipt snapshot ceiling; split the request before retrying.`);
  return snapshot;
}

function storedReceiptRecord(value: unknown, receipt: SuiteRecord, expectedId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The stored additive idempotency record snapshot is malformed.");
  const record = value as AdditiveBusinessRecord;
  if (record.id !== expectedId || record.workspaceId !== receipt.workspaceId || record.moduleId !== receipt.moduleId || !isAdditiveModuleId(record.moduleId) || typeof record.recordType !== "string" || !record.recordType || typeof record.title !== "string" || typeof record.state !== "string" || !Number.isSafeInteger(record.version) || record.version < 1 || !record.data || typeof record.data !== "object" || Array.isArray(record.data) || !validDateTime(record.createdAt) || !validDateTime(record.updatedAt)) throw new Error("The stored additive idempotency record snapshot is malformed.");
  const expectedHash = digest({ moduleId: record.moduleId, recordType: record.recordType, title: record.title, state: record.state, version: record.version, data: record.data });
  if (record.contentHash !== expectedHash) throw new Error("The stored additive idempotency record snapshot failed its immutable content-hash check.");
  return clone(record);
}

function storedReceiptApprovalDecisionId(receipt: SuiteRecord) {
  if (receipt.data.additiveContract !== additiveReceiptContract || !receipt.data.result || typeof receipt.data.result !== "object" || Array.isArray(receipt.data.result)) throw new Error("The stored additive idempotency receipt is malformed.");
  const snapshot = receipt.data.result as unknown as AdditiveReceiptSnapshot;
  const audit = snapshot.audit;
  if (!audit || typeof audit !== "object" || typeof receipt.data.actorUserId !== "string" || audit.actorId !== receipt.data.actorUserId || audit.workspaceId !== receipt.workspaceId || audit.moduleId !== receipt.moduleId || audit.actionId !== receipt.data.actionId || audit.inputDigest !== receipt.data.inputDigest || audit.receiptId !== receipt.id) throw new Error("The stored additive idempotency audit snapshot does not match its receipt boundary.");
  if (audit.approvalDecisionId !== null && (typeof audit.approvalDecisionId !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(audit.approvalDecisionId))) throw new Error("The stored additive approval decision ID is malformed.");
  if (receipt.data.approvalDecisionId !== undefined && receipt.data.approvalDecisionId !== audit.approvalDecisionId) throw new Error("The stored additive approval decision binding is inconsistent.");
  return audit.approvalDecisionId;
}

function storedReceiptResult(receipt: SuiteRecord, actorUserId: string): AdditiveBusinessExecutionResult {
  if (receipt.data.additiveContract !== additiveReceiptContract || !receipt.data.result || typeof receipt.data.result !== "object" || Array.isArray(receipt.data.result)) throw new Error("The stored additive idempotency receipt is malformed.");
  if (receipt.data.actorUserId !== actorUserId) throw new Error("The idempotency key is bound to another workspace actor.");
  const snapshot = receipt.data.result as unknown as AdditiveReceiptSnapshot;
  if (!Array.isArray(snapshot.recordIds) || !Array.isArray(snapshot.recordSnapshots) || !snapshot.audit || !["read", "command", "ai-proposal"].includes(snapshot.kind)) throw new Error("The stored additive idempotency result is malformed.");
  storedReceiptApprovalDecisionId(receipt);
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > additiveBusinessReceiptSnapshotLimitBytes) throw new Error("The stored additive idempotency result exceeds the safe immutable snapshot ceiling.");
  if (snapshot.recordSnapshots.length !== snapshot.recordIds.length || snapshot.recordIds.some((id) => typeof id !== "string") || new Set(snapshot.recordIds).size !== snapshot.recordIds.length) throw new Error("The stored additive idempotency result must contain one immutable snapshot for every response record.");
  const records = snapshot.recordSnapshots.map((record, index) => storedReceiptRecord(record, receipt, snapshot.recordIds[index]!));
  if (snapshot.audit.actorId !== actorUserId || snapshot.audit.workspaceId !== receipt.workspaceId || snapshot.audit.moduleId !== receipt.moduleId || snapshot.audit.actionId !== receipt.data.actionId || snapshot.audit.inputDigest !== receipt.data.inputDigest || snapshot.audit.receiptId !== receipt.id) throw new Error("The stored additive idempotency audit snapshot does not match its receipt boundary.");
  return {
    kind: snapshot.kind,
    records: clone(records),
    ...(snapshot.preview ? { preview: clone(snapshot.preview) } : {}),
    audit: { ...clone(snapshot.audit), receiptId: receipt.id, replayed: true, decision: "replayed" },
  };
}

/**
 * Production execution path for the additive business modules.
 *
 * Every domain record and idempotency receipt is committed through SuiteStore,
 * and AI actions are queued through SuiteStore.queueAiAction. The domain engine
 * above is deliberately a stateless-per-call rule evaluator in this path; its
 * private maps are hydrated from the workspace database on every transaction
 * and are never the hosted source of truth.
 */
export async function executeAdditiveBusinessActionWithStore(
  store: SuiteStore,
  authorization: AdditiveBusinessAuthorization,
  moduleId: AdditiveBusinessModuleId,
  actionId: string,
  input: Record<string, unknown>,
  dependencies: AdditiveBusinessStoreDependencies = {},
): Promise<AdditiveBusinessExecutionResult> {
  return store.runInWorkspaceTransaction(authorization.userId, async (workspace) => {
    if (workspace.id !== authorization.workspaceId) throw new Error("The authenticated workspace does not match the additive business authorization.");
    if (workspace.currentRole !== authorization.role) throw new Error("The authenticated workspace role does not match the additive business authorization.");
    if (!workspace.enabledModuleIds.includes(moduleId)) throw new Error(`${moduleId} is not enabled for this workspace.`);
    const action = additiveBusinessActionByKey.get(`${moduleId}:${actionId}`);
    if (!action) throw new Error(`Unknown additive business action ${moduleId}:${actionId}.`);
    const trustedModelPolicyId = action.operation === "ai" ? expectedModelPolicyId(input.modelId, dependencies.modelPolicyId) : undefined;
    if (roleRank[authorization.role] < roleRank[action.minimumRole]) throw new Error(`${action.minimumRole} role is required for ${moduleId}:${actionId}.`);
    const module = moduleById.get(moduleId)!;
    if (planRank[workspace.plan] < planRank[module.minPlan]) throw new Error(`${module.name} is not available on the current workspace plan.`);
    if (!authorization.scopes.includes("*") && !authorization.scopes.includes(`${moduleId}:*`) && !authorization.scopes.includes(`${moduleId}:${action.requiredScope}`)) throw new Error(`${moduleId}:${action.requiredScope} scope is required.`);

    const workspaceMembers = await store.listWorkspaceMembers(authorization.userId);
    if (!workspaceMembers.some((member) => member.userId === authorization.userId && member.role === authorization.role)) throw new Error("The acting identity and role must match an authenticated workspace member.");
    const inputDigest = digest({ workspaceId: workspace.id, actorUserId: authorization.userId, input });
    const idempotencyKey = action.idempotent ? String(input.idempotencyKey ?? "") : undefined;
    if (action.idempotent && !idempotencyKey) throw new Error("An idempotency key is required.");
    if (idempotencyKey) {
      const existing = await store.findCommandReceipt(authorization.userId, { recordType: "additive-command-receipt", moduleId, actionId, idempotencyKey });
      if (existing) {
        if (existing.data.actorUserId !== authorization.userId) throw new Error("The idempotency key is bound to another workspace actor.");
        if (existing.data.inputDigest !== inputDigest) throw new Error("The idempotency key was already used for different input.");
        return storedReceiptResult(existing, authorization.userId);
      }
    }

    if (action.requiresApproval && input.dryRun !== true) {
      const approval = input.approval;
      const decisionId = approval && typeof approval === "object" && !Array.isArray(approval) && typeof (approval as Record<string, unknown>).decisionId === "string"
        ? String((approval as Record<string, unknown>).decisionId)
        : undefined;
      if (decisionId && /^[A-Za-z0-9._:-]{16,200}$/.test(decisionId) && await store.findApprovalDecisionReceipt(authorization.userId, decisionId)) throw new Error("The human approval decision ID is already bound to another committed command.");
    }

    const principal = { userId: authorization.userId, workspaceId: workspace.id, role: authorization.role };
    const moduleRecords = await store.listRecords(authorization.userId, { moduleId, limit: additiveBusinessModuleSnapshotLimit + 1 });
    if (moduleRecords.length > additiveBusinessModuleSnapshotLimit) throw new Error(`${moduleId} has more than ${additiveBusinessModuleSnapshotLimit} workspace records. Execution stopped before mutation because the SuiteStore contract does not provide paginated additive snapshots.`);
    const visibleModuleRecords = moduleRecords.filter((record) => canReadSuiteRecord(principal, record));
    const targetedRecords: SuiteRecord[] = [];
    for (const recordId of inputRecordIds(input)) {
      const record = await store.getRecord(authorization.userId, recordId);
      if (record && canReadSuiteRecord(principal, record)) targetedRecords.push(record);
    }
    let suiteRecords = [...new Map([...visibleModuleRecords, ...targetedRecords].map((record) => [record.id, record] as const)).values()];
    let domainRecords = suiteRecords.map(recordFromSuite).filter((record): record is AdditiveBusinessRecord => Boolean(record));
    const loadedIds = new Set(suiteRecords.map((record) => record.id));
    for (const recordId of storedRowUpdateRelationRecordIds(domainRecords, moduleId, actionId, input)) {
      if (loadedIds.has(recordId)) continue;
      const record = await store.getRecord(authorization.userId, recordId);
      if (record && canReadSuiteRecord(principal, record)) {
        targetedRecords.push(record);
        loadedIds.add(record.id);
      }
    }
    suiteRecords = [...new Map([...visibleModuleRecords, ...targetedRecords].map((record) => [record.id, record] as const)).values()];
    domainRecords = suiteRecords.map(recordFromSuite).filter((record): record is AdditiveBusinessRecord => Boolean(record));
    const externalEvidence = suiteRecords.map(externalEvidenceFromSuite).filter((record): record is AdditiveBusinessEvidenceRecord => Boolean(record));

    const engine = new AdditiveBusinessEngine();
    engine.hydrateRecordsForStoreAdapter(domainRecords);
    engine.hydrateExternalEvidenceForStoreAdapter(externalEvidence);
    const evaluated = await engine.execute({
      workspaceId: workspace.id,
      actorId: authorization.userId,
      plan: workspace.plan,
      role: authorization.role,
      workspaceMembers,
      scopes: authorization.scopes,
      modelPolicyId: trustedModelPolicyId,
      now: dependencies.now,
    }, moduleId, actionId, input);
    if (idempotencyKey) receiptSnapshot(evaluated);
    const changedRecords = engine.changedRecordsForStoreAdapter();
    const changedRecordIds = new Set(changedRecords.map((record) => record.id));
    if (evaluated.records.some((record) => !changedRecordIds.has(record.id))) throw new Error("The additive evaluator returned a record without marking it for atomic persistence.");

    const suiteById = new Map(suiteRecords.map((record) => [record.id, record] as const));
    const idMap = new Map<string, string>();
    const suiteTargets = new Map<string, SuiteRecord>();
    for (const record of changedRecords) {
      const existing = suiteById.get(record.id);
      if (existing && recordFromSuite(existing)) {
        idMap.set(record.id, existing.id);
        suiteTargets.set(record.id, existing);
        continue;
      }
      const created = await store.createRecord(authorization.userId, {
        moduleId: record.moduleId,
        recordType: record.recordType,
        title: record.title,
        state: record.state,
        data: recordEnvelope(record),
      });
      if (!created) throw new Error(`The workspace store refused to create ${record.moduleId}:${record.recordType}.`);
      idMap.set(record.id, created.id);
      suiteTargets.set(record.id, created);
    }

    const persistedByDomainId = new Map<string, AdditiveBusinessRecord>();
    for (const record of changedRecords) {
      const actualId = idMap.get(record.id) ?? record.id;
      const remappedData = remapIds(record.data, idMap) as Record<string, unknown>;
      const persisted: AdditiveBusinessRecord = {
        ...record,
        id: actualId,
        workspaceId: workspace.id,
        data: remappedData,
        contentHash: digest({ moduleId: record.moduleId, recordType: record.recordType, title: record.title, state: record.state, version: record.version, data: remappedData }),
      };
      const target = suiteTargets.get(record.id);
      if (!target) throw new Error("The workspace store lost an additive persistence target.");
      const updated = await store.updateRecord(authorization.userId, target.id, { title: persisted.title, state: persisted.state, data: recordEnvelope(persisted) });
      if (!updated) throw new Error(`The workspace store refused to update ${persisted.moduleId}:${persisted.recordType}.`);
      persistedByDomainId.set(record.id, persisted);
    }
    let persistedRecords = evaluated.records.map((record) => {
      const persisted = persistedByDomainId.get(record.id);
      if (!persisted) throw new Error("The workspace store lost an additive response record during atomic persistence.");
      return persisted;
    });

    let preview = evaluated.preview ? remapIds(evaluated.preview, idMap) as Record<string, unknown> : undefined;
    if (action.operation === "ai" && input.dryRun !== true) {
      const proposal = persistedRecords.find((record) => record.recordType === "ai-proposal-request");
      if (!proposal) throw new Error("The additive AI action did not produce its proposal request record.");
      const evidenceIds = Array.isArray(proposal.data.evidenceIds) ? proposal.data.evidenceIds.filter((value): value is string => typeof value === "string") : [];
      const queued = await store.queueAiAction(authorization.userId, {
        moduleId,
        goal: String(proposal.data.goal),
        context: {
          requestRecordId: proposal.id,
          targetRecordId: proposal.data.targetRecordId,
          evidenceIds,
          evidenceBindings: proposal.data.evidenceBindings,
          prompt: proposal.data.prompt,
          modelPolicyId: trustedModelPolicyId,
          requestedModelId: trustedModelPolicyId,
          proposalOnly: true,
          automaticMutationAllowed: false,
          applyActionId: null,
          resultContract: { version: "additive-business-proposal.v1", citationsRequired: true, consequentialMutationsForbidden: true },
        },
      });
      if (!queued) throw new Error("The workspace store refused to queue the grounded AI proposal.");
      const queuedProposal: AdditiveBusinessRecord = {
        ...proposal,
        data: { ...proposal.data, queuedActionId: queued.id },
      };
      queuedProposal.contentHash = digest({ moduleId: queuedProposal.moduleId, recordType: queuedProposal.recordType, title: queuedProposal.title, state: queuedProposal.state, version: queuedProposal.version, data: queuedProposal.data });
      const updated = await store.updateRecord(authorization.userId, queuedProposal.id, { data: recordEnvelope(queuedProposal) });
      if (!updated) throw new Error("The workspace store refused to bind the queued AI action receipt.");
      persistedRecords = persistedRecords.map((record) => record.id === queuedProposal.id ? queuedProposal : record);
      preview = { ...(preview ?? {}), requestId: queuedProposal.id, queuedActionId: queued.id, modelExecuted: false, output: null, automaticMutationAllowed: false };
    }

    let result: AdditiveBusinessExecutionResult = { ...evaluated, records: persistedRecords, ...(preview ? { preview } : {}) };
    if (idempotencyKey) {
      const receiptData = {
        additiveContract: additiveReceiptContract,
        actionId,
        idempotencyKey,
        actorUserId: authorization.userId,
        inputDigest,
        approvalDecisionId: result.audit.approvalDecisionId,
        result: receiptSnapshot(result),
      };
      const receipt = await store.createRecord(authorization.userId, { moduleId, recordType: "additive-command-receipt", title: `${action.title} receipt`, state: result.audit.dryRun ? "previewed" : "committed", data: receiptData });
      if (!receipt) throw new Error("The workspace store refused to persist the additive idempotency receipt.");
      result = { ...result, audit: { ...result.audit, receiptId: receipt.id } };
      const updatedReceipt = await store.updateRecord(authorization.userId, receipt.id, { data: { ...receiptData, result: receiptSnapshot(result) } });
      if (!updatedReceipt) throw new Error("The workspace store refused to finalize the additive idempotency receipt.");
    }
    return clone(result);
  });
}
