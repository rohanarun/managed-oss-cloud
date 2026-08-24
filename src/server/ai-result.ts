import { createHash } from "node:crypto";
import { z } from "zod";
import type { SuiteAiAction, SuiteRecord } from "../shared/suite.js";

const aiResultSchema = z.object({
  proposal: z.string().trim().min(1).max(20_000),
  evidence: z.array(z.string().uuid()).max(100).default([]),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  approvalRequired: z.literal(true),
}).passthrough();

export type ValidatedAiResult = z.infer<typeof aiResultSchema>;

export function validateAiResult(value: unknown, allowedRecordIds: Iterable<string>): ValidatedAiResult {
  const parsed = aiResultSchema.parse(value);
  const allowed = new Set(allowedRecordIds);
  const evidence = [...new Set(parsed.evidence)];
  const disallowed = evidence.filter((recordId) => !allowed.has(recordId));
  if (disallowed.length) throw new Error("The model cited records outside its authorized workspace context.");
  return { ...parsed, evidence };
}

export const proposalOnlyContractVersions = ["additive-business-proposal.v1", "extended-business-proposal.v1"] as const;
const proposalOnlyContractVersionSchema = z.enum(proposalOnlyContractVersions);
export type ProposalOnlyContractVersion = z.infer<typeof proposalOnlyContractVersionSchema>;

const knownAiResultContractVersions = new Set([
  "core-business-ai-result.v1",
  "premium-business-ai-result.v1",
  "first-party-growth-ai-result.v1",
  "esign-ai-result.v1",
  "letterline-ai-result.v1",
  ...proposalOnlyContractVersions,
]);

const proposalOnlyAiResultSchema = z.object({
  version: proposalOnlyContractVersionSchema,
  proposal: z.string().trim().min(1).max(20_000),
  evidence: z.array(z.string().uuid()).min(1).max(500),
  confidence: z.number().min(0).max(1),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(50),
  model: z.string().trim().min(1).max(200),
  reviewStatus: z.literal("pending-human-review"),
  approvalRequired: z.literal(true),
  proposalOnly: z.literal(true),
  automaticMutationAllowed: z.literal(false),
  externalEffectAllowed: z.literal(false),
}).strict();

const modelFailureSchema = z.object({ error: z.string().trim().min(1).max(2_000) }).strict();
const recordIdSchema = z.string().uuid();
const evidenceIdsSchema = z.array(recordIdSchema).min(1).max(500);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const additiveBindingSchema = z.object({
  recordId: recordIdSchema,
  moduleId: z.string().trim().min(1).max(100),
  recordType: z.string().trim().min(1).max(200),
  version: z.number().int().safe().min(1),
  contentHash: hashSchema,
}).strict();
const extendedBindingSchema = z.object({
  recordId: recordIdSchema,
  moduleId: z.string().trim().min(1).max(100),
  recordType: z.string().trim().min(1).max(200),
  version: z.number().int().safe().min(1),
  snapshotHash: hashSchema,
}).strict();

export type ValidatedProposalOnlyAiResult = z.infer<typeof proposalOnlyAiResultSchema>;

export const canonicalJsonSpecificationVersion = "managed-oss-canonical-json.v1" as const;

function assertUnicodeScalarString(value: string, path: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) {
      throw new Error(`${path} contains U+0000, which PostgreSQL JSONB cannot represent.`);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${path} contains an unpaired UTF-16 surrogate and is not valid JSON Unicode.`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${path} contains an unpaired UTF-16 surrogate and is not valid JSON Unicode.`);
    }
  }
}

function canonicalJsonString(value: string, path: string) {
  assertUnicodeScalarString(value, path);
  const bytes = Buffer.from(value, "utf8");
  return `S${bytes.length}:${bytes.toString("hex")}`;
}

function canonicalJsonNumber(value: number, path: string) {
  if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number and cannot be canonical JSON.`);
  if (value === 0) return "0";
  const serialized = JSON.stringify(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(serialized);
  if (!match) throw new Error(`${path} contains a number that cannot be canonicalized.`);
  const [, sign, integer, fraction = "", exponentText = "0"] = match;
  const digits = `${integer}${fraction}`;
  const scale = Number(exponentText) - fraction.length;
  const point = digits.length + scale;
  const magnitude = scale >= 0
    ? `${digits}${"0".repeat(scale)}`
    : point > 0
      ? `${digits.slice(0, point)}.${digits.slice(point)}`
      : `0.${"0".repeat(-point)}${digits}`;
  return `${sign}${magnitude}`;
}

function compareUtf8(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJsonValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "N";
  if (typeof value === "boolean") return value ? "T" : "F";
  if (typeof value === "string") return canonicalJsonString(value, path);
  if (typeof value === "number") {
    const number = canonicalJsonNumber(value, path);
    return `D${number.length}:${number}`;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${path} contains a circular JSON array.`);
    ancestors.add(value);
    try {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || value[index] === undefined) throw new Error(`${path}[${index}] is undefined; canonical JSON arrays must be dense.`);
        items.push(canonicalJsonValue(value[index], `${path}[${index}]`, ancestors));
      }
      return `A${value.length}:${items.join("")}`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not a plain JSON object.`);
    if (ancestors.has(value)) throw new Error(`${path} contains a circular JSON object.`);
    ancestors.add(value);
    try {
      const source = value as Record<string, unknown>;
      const keys = Object.keys(source).filter((key) => source[key] !== undefined);
      for (const key of keys) assertUnicodeScalarString(key, `${path} key`);
      keys.sort(compareUtf8);
      const entries = keys.map((key) => `${canonicalJsonString(key, `${path} key`)}${canonicalJsonValue(source[key], `${path}.${key}`, ancestors)}`);
      return `O${keys.length}:${entries.join("")}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error(`${path} contains ${typeof value}, which is outside the canonical JSON domain.`);
}

/**
 * Canonical JSON v1 is a self-delimiting UTF-8 token stream. Object keys are
 * ordered by their UTF-8 bytes, strings are UTF-8 hex, arrays retain order,
 * and finite numbers use exponent-free minimal decimal form. Undefined object
 * properties are omitted exactly as they are by JSON transport; every other
 * non-JSON value fails closed.
 */
export function canonicalJsonText(value: unknown) {
  return `${canonicalJsonSpecificationVersion}|${canonicalJsonValue(value, "$", new Set())}`;
}

export function canonicalJsonSha256(value: unknown) {
  return createHash("sha256").update(canonicalJsonText(value), "utf8").digest("hex");
}

export function proposalOnlySnapshotHash(value: unknown) {
  return canonicalJsonSha256(value);
}

function exactJson(left: unknown, right: unknown) {
  return proposalOnlySnapshotHash(left) === proposalOnlySnapshotHash(right);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function uniqueIds(value: unknown, label: string) {
  const parsed = evidenceIdsSchema.parse(value);
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} must contain unique record IDs.`);
  return parsed;
}

function normalizedRecordVersion(record: SuiteRecord) {
  if (record.data.version === undefined) return 1;
  return Number.isSafeInteger(record.data.version) && Number(record.data.version) >= 1 ? Number(record.data.version) : undefined;
}

export function aiResultContractVersion(context: Record<string, unknown>): string | undefined {
  if (!("resultContract" in context)) return undefined;
  const contract = object(context.resultContract, "resultContract");
  if (typeof contract.version !== "string" || !knownAiResultContractVersions.has(contract.version)) throw new Error("The queued AI result contract version is unknown or invalid.");
  return contract.version;
}

export function validateProposalOnlyAiResult(
  value: unknown,
  boundary: { version: ProposalOnlyContractVersion; allowedRecordIds: Iterable<string> },
): ValidatedProposalOnlyAiResult {
  const parsed = proposalOnlyAiResultSchema.parse(value);
  if (parsed.version !== boundary.version) throw new Error("The model result does not match the queued proposal-only contract.");
  if (new Set(parsed.evidence).size !== parsed.evidence.length) throw new Error("The model result must cite each authorized record at most once.");
  const allowed = new Set(boundary.allowedRecordIds);
  if (parsed.evidence.some((recordId) => !allowed.has(recordId))) throw new Error("The model cited records outside its explicitly selected proposal evidence.");
  return parsed;
}

interface ProposalOnlyAuditBoundary {
  version: ProposalOnlyContractVersion;
  auditRecord: SuiteRecord;
  evidenceIds: string[];
  allowedRecordIds: string[];
  targetRecordId?: string;
  requestedModelId: string;
  modelPolicyId?: string;
  bindings: Array<z.infer<typeof additiveBindingSchema> | z.infer<typeof extendedBindingSchema>>;
}

const additiveModuleIds = new Set(["tables", "meetings", "insights", "learning", "community"]);

function additiveEnvelopeContentHash(stored: Record<string, unknown>, version: number, data: Record<string, unknown>) {
  return proposalOnlySnapshotHash({
    moduleId: stored.moduleId,
    recordType: stored.recordType,
    title: stored.title,
    state: stored.state,
    version,
    data,
  });
}

function additiveEnvelope(record: SuiteRecord) {
  if (record.data.additiveContract !== "additive-business-record.v1") throw new Error("The additive proposal audit record has an invalid durable contract.");
  const stored = object(record.data.record, "additive proposal audit record");
  const version = z.number().int().safe().min(1).parse(stored.version);
  const contentHash = hashSchema.parse(stored.contentHash);
  const data = object(stored.data, "additive proposal audit data");
  if (stored.id !== record.id || stored.workspaceId !== record.workspaceId || stored.moduleId !== record.moduleId || stored.recordType !== record.recordType || stored.title !== record.title || stored.state !== record.state) throw new Error("The additive proposal audit envelope does not match its Suite record.");
  const expectedHash = additiveEnvelopeContentHash(stored, version, data);
  if (contentHash !== expectedHash) throw new Error("The additive proposal audit record content hash is invalid.");
  return { stored, data, version, contentHash };
}

function assertAuditIdentity(action: SuiteAiAction, audit: SuiteRecord) {
  if (audit.workspaceId !== action.workspaceId || audit.moduleId !== action.moduleId || audit.recordType !== "ai-proposal-request" || audit.state !== "queued") throw new Error("The proposal-only audit record is missing, stale, or belongs to another boundary.");
}

export function proposalOnlyAuditBoundary(action: SuiteAiAction, records: readonly SuiteRecord[]): ProposalOnlyAuditBoundary {
  const version = aiResultContractVersion(action.context);
  if (!version || !proposalOnlyContractVersions.includes(version as ProposalOnlyContractVersion)) throw new Error("The queued action is not a supported proposal-only contract.");
  const contractVersion = version as ProposalOnlyContractVersion;
  const recordMap = new Map<string, SuiteRecord>();
  for (const record of records) {
    if (recordMap.has(record.id)) throw new Error("The proposal-only claim returned duplicate record IDs.");
    recordMap.set(record.id, record);
  }
  const evidenceIds = uniqueIds(action.context.evidenceIds, "evidenceIds");

  if (contractVersion === "additive-business-proposal.v1") {
    const requestRecordId = recordIdSchema.parse(action.context.requestRecordId);
    const targetRecordId = recordIdSchema.parse(action.context.targetRecordId);
    const requestedModelId = z.string().trim().min(1).max(200).parse(action.context.requestedModelId);
    const auditRecord = recordMap.get(requestRecordId);
    if (!auditRecord) throw new Error("The additive proposal audit record was not loaded for its exact tenant.");
    assertAuditIdentity(action, auditRecord);
    const envelope = additiveEnvelope(auditRecord);
    const proposalKind = String(object(action.context.prompt, "additive proposal prompt").id).split(".").at(-1);
    if (envelope.data.queuedActionId !== action.id || envelope.data.targetRecordId !== targetRecordId || envelope.data.requestedModelId !== requestedModelId || envelope.data.proposalKind !== proposalKind) throw new Error("The additive proposal audit record does not match the queued action.");
    if (!exactJson(envelope.data.prompt, action.context.prompt) || !exactJson(envelope.data.evidenceIds, evidenceIds) || !exactJson(envelope.data.evidenceBindings, action.context.evidenceBindings)) throw new Error("The additive proposal audit record does not match its queued prompt and evidence boundary.");
    const review = object(envelope.data.review, "additive proposal review");
    if (review.status !== "pending-model" || review.required !== true || envelope.data.proposalOnly !== true || envelope.data.automaticMutationAllowed !== false || envelope.data.applyActionId !== null || envelope.data.modelExecuted !== false) throw new Error("The additive proposal audit record is no longer pending a proposal-only model result.");
    const bindings = z.array(additiveBindingSchema).min(1).max(500).parse(action.context.evidenceBindings);
    const bindingIds = bindings.map((binding) => binding.recordId);
    if (new Set(bindingIds).size !== bindingIds.length || !exactJson(bindingIds, evidenceIds) || !bindingIds.includes(targetRecordId)) throw new Error("The additive proposal evidence bindings must be exact, unique, and include the target.");
    return { version: contractVersion, auditRecord, evidenceIds, allowedRecordIds: evidenceIds, targetRecordId, requestedModelId, bindings };
  }

  const aiAuditRecordId = recordIdSchema.parse(action.context.aiAuditRecordId);
  const requestedModelId = z.string().trim().min(1).max(200).parse(action.context.requestedModelId);
  const modelPolicyId = z.string().trim().min(1).max(200).parse(action.context.modelPolicyId);
  const auditRecord = recordMap.get(aiAuditRecordId);
  if (!auditRecord) throw new Error("The extended proposal audit record was not loaded for its exact tenant.");
  assertAuditIdentity(action, auditRecord);
  const bindings = z.array(extendedBindingSchema).min(1).max(500).parse(action.context.evidenceBindings);
  const bindingIds = bindings.map((binding) => binding.recordId);
  if (new Set(bindingIds).size !== bindingIds.length || !exactJson(bindingIds, evidenceIds)) throw new Error("The extended proposal evidence bindings must exactly match the unique selected evidence.");
  if (auditRecord.data.actionId !== action.context.actionId || auditRecord.data.promptId !== action.context.promptId || auditRecord.data.promptVersion !== action.context.promptVersion || auditRecord.data.modelPolicyId !== modelPolicyId || auditRecord.data.requestedModelId !== requestedModelId || !exactJson(auditRecord.data.evidenceIds, evidenceIds) || !exactJson(auditRecord.data.evidenceBindings, bindings)) throw new Error("The extended proposal audit record does not match the queued action, prompt, model, and evidence boundary.");
  if (auditRecord.data.reviewStatus !== "pending-model" || auditRecord.data.proposalOnly !== true || auditRecord.data.automaticMutationAllowed !== false || auditRecord.data.externalEffectAllowed !== false) throw new Error("The extended proposal audit record is no longer pending a proposal-only model result.");
  const targetRecordId = action.context.targetRecordId === undefined ? undefined : recordIdSchema.parse(action.context.targetRecordId);
  if ((auditRecord.data.targetRecordId ?? undefined) !== targetRecordId || (auditRecord.data.targetVersion ?? undefined) !== (action.context.targetVersion ?? undefined) || (auditRecord.data.targetSnapshotHash ?? undefined) !== (action.context.targetSnapshotHash ?? undefined)) throw new Error("The extended proposal target binding does not match its durable audit record.");
  if (targetRecordId) {
    z.number().int().safe().min(1).parse(action.context.targetVersion);
    hashSchema.parse(action.context.targetSnapshotHash);
  } else if (action.context.targetVersion !== undefined || action.context.targetSnapshotHash !== undefined) {
    throw new Error("The extended proposal target version and hash require an exact target record ID.");
  }
  return { version: contractVersion, auditRecord, evidenceIds, allowedRecordIds: [...new Set([...evidenceIds, ...(targetRecordId ? [targetRecordId] : [])])], targetRecordId, requestedModelId, modelPolicyId, bindings };
}

export interface ValidatedProposalOnlyAiJob extends ProposalOnlyAuditBoundary {
  modelRecords: SuiteRecord[];
}

export function validateProposalOnlyAiJob(action: SuiteAiAction, records: readonly SuiteRecord[], configuredModelId: string): ValidatedProposalOnlyAiJob {
  const boundary = proposalOnlyAuditBoundary(action, records);
  if (!configuredModelId.trim() || boundary.requestedModelId !== configuredModelId || (boundary.modelPolicyId !== undefined && boundary.modelPolicyId !== configuredModelId)) throw new Error("Every configured proposal model field must match the worker's configured model.");
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const modelRecords: SuiteRecord[] = [];

  if (boundary.version === "additive-business-proposal.v1") {
    for (const parsedBinding of boundary.bindings) {
      const binding = additiveBindingSchema.parse(parsedBinding);
      const record = recordMap.get(binding.recordId);
      if (!record || record.workspaceId !== action.workspaceId || record.moduleId !== binding.moduleId || record.recordType !== binding.recordType) throw new Error("An additive evidence binding no longer matches its exact tenant, module, or record type.");
      let actualVersion: number | undefined;
      let actualContentHash: string;
      if (additiveModuleIds.has(record.moduleId)) {
        const envelope = additiveEnvelope(record);
        actualVersion = envelope.version;
        actualContentHash = envelope.contentHash;
      } else {
        actualVersion = normalizedRecordVersion(record);
        actualContentHash = proposalOnlySnapshotHash({ contract: "suite-record-evidence-snapshot.v1", id: record.id, workspaceId: record.workspaceId, moduleId: record.moduleId, recordType: record.recordType, title: record.title, state: record.state, version: actualVersion, data: record.data, updatedAt: record.updatedAt });
      }
      if (actualVersion === undefined || actualVersion !== binding.version || actualContentHash !== binding.contentHash) throw new Error("An additive evidence binding changed after the proposal was authorized.");
      modelRecords.push(record);
    }
  } else {
    for (const parsedBinding of boundary.bindings) {
      const binding = extendedBindingSchema.parse(parsedBinding);
      const record = recordMap.get(binding.recordId);
      if (!record || record.workspaceId !== action.workspaceId || record.moduleId !== binding.moduleId || record.recordType !== binding.recordType || normalizedRecordVersion(record) !== binding.version || proposalOnlySnapshotHash(record) !== binding.snapshotHash) throw new Error("An extended evidence binding changed or no longer matches its exact tenant, module, type, version, and hash.");
      modelRecords.push(record);
    }
    if (boundary.targetRecordId) {
      const target = recordMap.get(boundary.targetRecordId);
      if (!target || target.workspaceId !== action.workspaceId || target.moduleId !== action.moduleId || normalizedRecordVersion(target) !== action.context.targetVersion || proposalOnlySnapshotHash(target) !== action.context.targetSnapshotHash) throw new Error("The extended proposal target changed after the request was authorized.");
      modelRecords.unshift(target);
    }
  }

  const exactModelRecords = [...new Map(modelRecords.map((record) => [record.id, record])).values()];
  if (boundary.allowedRecordIds.some((recordId) => !exactModelRecords.some((record) => record.id === recordId))) throw new Error("The complete proposal-only evidence and target selection is not available to the model worker.");
  return { ...boundary, modelRecords: exactModelRecords };
}

export function transitionProposalOnlyAiAuditRecord(
  action: SuiteAiAction,
  records: readonly SuiteRecord[],
  completion: { status: "completed" | "failed"; result: Record<string, unknown> },
  transitionedAt: string,
): SuiteRecord {
  const boundary = proposalOnlyAuditBoundary(action, records);
  if (!Number.isFinite(Date.parse(transitionedAt))) throw new Error("The proposal-only audit transition time is invalid.");
  const next = structuredClone(boundary.auditRecord);
  next.updatedAt = transitionedAt;

  if (completion.status === "completed") {
    const result = validateProposalOnlyAiResult(completion.result, { version: boundary.version, allowedRecordIds: boundary.allowedRecordIds });
    if (result.model !== boundary.requestedModelId || (boundary.modelPolicyId !== undefined && result.model !== boundary.modelPolicyId)) throw new Error("The proposal result model does not match every configured model field.");
    next.state = "pending-human-review";
    if (boundary.version === "additive-business-proposal.v1") {
      const envelope = additiveEnvelope(boundary.auditRecord);
      const stored = structuredClone(envelope.stored);
      stored.state = next.state;
      stored.updatedAt = transitionedAt;
      const transitionedData = {
        ...envelope.data,
        output: result.proposal,
        confidence: result.confidence,
        assumptions: result.assumptions,
        citedEvidenceIds: result.evidence,
        review: { ...object(envelope.data.review, "additive proposal review"), status: "pending-human-review" },
        executedModel: result.model,
        resultContractVersion: result.version,
        approvalRequired: true,
        proposalOnly: true,
        automaticMutationAllowed: false,
        externalEffectAllowed: false,
        modelExecuted: true,
        completedAt: transitionedAt,
      };
      stored.data = transitionedData;
      stored.contentHash = additiveEnvelopeContentHash(stored, envelope.version, transitionedData);
      next.data = { ...next.data, record: stored };
    } else {
      next.data = { ...next.data, aiActionId: action.id, proposal: result.proposal, evidence: result.evidence, confidence: result.confidence, assumptions: result.assumptions, executedModel: result.model, resultContractVersion: result.version, reviewStatus: "pending-human-review", approvalRequired: true, proposalOnly: true, automaticMutationAllowed: false, externalEffectAllowed: false, modelExecuted: true, completedAt: transitionedAt };
    }
    return next;
  }

  const failure = modelFailureSchema.parse(completion.result);
  next.state = "model-failed";
  if (boundary.version === "additive-business-proposal.v1") {
    const envelope = additiveEnvelope(boundary.auditRecord);
    const stored = structuredClone(envelope.stored);
    stored.state = next.state;
    stored.updatedAt = transitionedAt;
    const transitionedData = { ...envelope.data, review: { ...object(envelope.data.review, "additive proposal review"), status: "model-failed" }, modelError: failure.error, proposalOnly: true, automaticMutationAllowed: false, externalEffectAllowed: false, modelCompleted: false, failedAt: transitionedAt };
    stored.data = transitionedData;
    stored.contentHash = additiveEnvelopeContentHash(stored, envelope.version, transitionedData);
    next.data = { ...next.data, record: stored };
  } else {
    next.data = { ...next.data, aiActionId: action.id, reviewStatus: "model-failed", modelError: failure.error, proposalOnly: true, automaticMutationAllowed: false, externalEffectAllowed: false, modelCompleted: false, failedAt: transitionedAt };
  }
  return next;
}
