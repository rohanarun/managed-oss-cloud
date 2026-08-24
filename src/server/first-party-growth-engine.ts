import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { SuiteAiAction, SuiteRecord, SuiteWorkspaceRole } from "../shared/suite.js";
import {
  firstPartyGrowthAction,
  type FirstPartyGrowthActionDefinition,
  type FirstPartyGrowthModuleId,
  type FirstPartyGrowthScope,
} from "../shared/first-party-growth-actions.js";
import type { SuiteStore } from "./suite-store.js";
import { canReadSuiteRecord } from "./suite-record-visibility.js";
import { firstPartyGrowthPromptDigest, firstPartyGrowthPromptPolicies } from "./prompts/first-party-growth.js";

export interface FirstPartyGrowthAuthorization {
  userId: string;
  workspaceId: string;
  role: SuiteWorkspaceRole;
  scopes: string[];
}

export interface FirstPartyGrowthApproval {
  approved: true;
  approvedBy: string;
  approvedAt: string;
  decisionId: string;
  reason: string;
}

export interface FirstPartyGrowthEngineDependencies {
  now: () => Date;
  modelPolicyId: string;
  publicBaseUrl?: string;
  randomBytes: (size: number) => Buffer;
}

export interface FirstPartyGrowthExecutionResult {
  kind: "read" | "command" | "ai-action";
  action: FirstPartyGrowthActionDefinition;
  records: SuiteRecord[];
  audit: Record<string, unknown>;
  aiAction?: SuiteAiAction;
}

export interface FirstPartyGrowthAiCompletion {
  version: "first-party-growth-ai-result.v1";
  proposal: string;
  evidence: string[];
  confidence: number;
  assumptions: string[];
  reviewStatus: "pending-human-review";
  approvalRequired: true;
  model: string;
}

const defaults: FirstPartyGrowthEngineDependencies = {
  now: () => new Date(),
  modelPolicyId: "workspace-configured-model",
  randomBytes,
};
const receiptRecordType = "growth-command-receipt";
export const firstPartyGrowthApprovalFreshnessMs = 24 * 60 * 60 * 1_000;
// This matches the largest current workspace record quota. SuiteStore does not yet
// expose an indexed JSON receipt lookup, so correctness must not silently stop at
// the most recent receipts. The production follow-up is an indexed store method.
const maxRecordScan = 5_000_000;

function visibilityScopedStore(store: SuiteStore, auth: FirstPartyGrowthAuthorization): SuiteStore {
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
  if (schema.format === "uri") { try { new URL(value); } catch { throw new Error(`${path} must be a URL.`); } }
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

function time(value: unknown, label: string) {
  const timestamp = new Date(String(value)).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is not a valid persisted date-time.`);
  return timestamp;
}

function version(record: SuiteRecord) {
  const value = Number(record.data.version ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function expected(record: SuiteRecord, input: Record<string, unknown>, key: string) {
  const supplied = input[key];
  if (!Number.isSafeInteger(supplied) || Number(supplied) !== version(record)) throw new Error("The record version is stale.");
  return version(record) + 1;
}

function output(action: FirstPartyGrowthActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>, kind: FirstPartyGrowthExecutionResult["kind"] = "command"): FirstPartyGrowthExecutionResult {
  return { kind, action, records, audit };
}

async function create(store: SuiteStore, userId: string, input: Parameters<SuiteStore["createRecord"]>[1]) {
  const record = await store.createRecord(userId, input);
  if (!record) throw new Error("The workspace record could not be persisted.");
  return record;
}

async function update(store: SuiteStore, userId: string, recordId: string, input: Parameters<SuiteStore["updateRecord"]>[2]) {
  const record = await store.updateRecord(userId, recordId, input);
  if (!record) throw new Error("The workspace record could not be updated.");
  return record;
}

async function owned(store: SuiteStore, userId: string, recordId: unknown, moduleId?: string, recordType?: string, label = "recordId") {
  if (typeof recordId !== "string") throw new Error(`${label} must be a record ID.`);
  const record = await store.getRecord(userId, recordId);
  if (!record || (moduleId && record.moduleId !== moduleId) || (recordType && record.recordType !== recordType)) throw new Error(`${label.replace(/Id$/, "")} not found.`);
  return record;
}

async function list(store: SuiteStore, userId: string, moduleId: FirstPartyGrowthModuleId, recordType?: string) {
  return store.listRecords(userId, { moduleId, recordType, limit: maxRecordScan });
}

function approval(input: Record<string, unknown>, auth: FirstPartyGrowthAuthorization, now: Date): FirstPartyGrowthApproval {
  const candidate = input.approval as FirstPartyGrowthApproval | undefined;
  const approvedAt = new Date(String(candidate?.approvedAt ?? ""));
  if (!candidate || candidate.approved !== true || candidate.approvedBy !== auth.userId || !candidate.reason?.trim() || !/^[A-Za-z0-9._:-]{16,200}$/.test(candidate.decisionId ?? "") || !Number.isFinite(approvedAt.getTime())) throw new Error("An attributable, reasoned, fresh, uniquely identified human approval is required when dryRun is false.");
  if (approvedAt.getTime() > now.getTime()) throw new Error("Human approval cannot be future-dated.");
  if (now.getTime() - approvedAt.getTime() > firstPartyGrowthApprovalFreshnessMs) throw new Error("Human approval is stale and must be reviewed again against the current request.");
  return { ...candidate, approvedAt: approvedAt.toISOString(), reason: candidate.reason.trim() };
}

function receiptApprovalDecisionId(receipt: SuiteRecord) {
  const topLevel = receipt.data.approvalDecisionId;
  const audit = receipt.data.audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    if (topLevel !== undefined && topLevel !== null) throw new Error("A stored growth command receipt has inconsistent approval attribution.");
    return null;
  }
  const nested = (audit as Record<string, unknown>).approvalDecisionId;
  if ((topLevel === null && nested !== undefined && nested !== null) || (topLevel !== undefined && topLevel !== null && topLevel !== nested)) throw new Error("A stored growth command receipt has inconsistent approval attribution.");
  if (nested === undefined || nested === null) return null;
  if (typeof nested !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(nested)) throw new Error("A stored growth command receipt has malformed approval attribution.");
  return nested;
}

async function assertApprovalUnused(store: SuiteStore, auth: FirstPartyGrowthAuthorization, decisionId: string) {
  const receipt = await store.findApprovalDecisionReceipt(auth.userId, decisionId);
  if (receipt) {
    if (receipt.recordType === receiptRecordType) receiptApprovalDecisionId(receipt);
    throw new Error("The human approval decision ID is already bound to another committed command.");
  }
}

function publicHttps(value: unknown, label: string) {
  let parsed: URL;
  try { parsed = new URL(String(value)); } catch { throw new Error(`${label} must be a valid public HTTPS URL.`); }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || !hostname || hostname.startsWith("[") || isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) throw new Error(`${label} must be a hostname-based public HTTPS URL without credentials or a nonstandard port.`);
  return parsed.toString();
}

function hostedOrigin(deps: FirstPartyGrowthEngineDependencies) {
  if (!deps.publicBaseUrl) throw new Error("A hosted public base URL is required for embed or collection links.");
  const value = publicHttps(deps.publicBaseUrl, "publicBaseUrl");
  const parsed = new URL(value);
  return parsed.origin;
}

function deterministicAllocation(namespace: Record<string, unknown>, variantsInput: unknown) {
  const variants = (variantsInput as Array<Record<string, unknown>>).map((item) => ({ key: String(item.key), weight: Number(item.weight) }));
  const totalWeight = variants.reduce((sum, item) => sum + item.weight, 0);
  const allocationHash = digest({ namespace, variants });
  const bucket = Number(BigInt(`0x${allocationHash}`) % BigInt(totalWeight));
  let cursor = 0;
  const selected = variants.find((item) => { cursor += item.weight; return bucket < cursor; });
  if (!selected) throw new Error("The weighted allocation could not be resolved.");
  return { selectedVariant: selected.key, allocationHash, bucket, totalWeight, deterministic: true, eventRecorded: false, rawIdentityStored: false };
}

function assertNoSensitiveFraudInference(summary: string) {
  const protectedTerms = /\b(race|racial|ethnic|ethnicity|nationality|religion|religious|sex|gender|sexual orientation|pregnan|disabil|health|medical|politic|socioeconomic|marital|family status|age)\b/i;
  if (protectedTerms.test(summary) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(summary) || /\b(?:ip address|device fingerprint|biometric)\b/i.test(summary)) throw new Error("Fraud observations must exclude protected traits, raw contact identity, network addresses, and fingerprints.");
}

function assertAggregateDimensions(value: unknown) {
  const dimensions = object(value, "dimensions");
  for (const [key, item] of Object.entries(dimensions)) {
    const textValue = String(item);
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(textValue) || isIP(textValue) !== 0 || /\b(?:visitor|user|contact|email|phone|fingerprint|cookie)[._:-]?(?:id|key|hash)?\b/i.test(key) || /^[a-f0-9]{32,}$/i.test(textValue)) throw new Error("Aggregate dimensions cannot contain raw or pseudonymous visitor identity.");
  }
}

async function authorize(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition) {
  const workspace = await store.getOrCreateWorkspace(auth.userId);
  if (workspace.id !== auth.workspaceId) throw new Error("The authorization workspace does not match the actor's tenant.");
  if (workspace.currentRole !== auth.role) throw new Error("The supplied role does not match the workspace membership.");
  if (!workspace.enabledModuleIds.includes(action.moduleId)) throw new Error("Enable this module before running its first-party actions.");
  if (!auth.scopes.includes("*") && !auth.scopes.includes(`${action.moduleId}:${action.requiredScope}`)) throw new Error(`The ${action.moduleId}:${action.requiredScope} scope is required.`);
  if (auth.role === "viewer" && action.operation !== "read") throw new Error("Viewers cannot mutate records or queue AI work.");
  if ((action.destructive || action.externalEffect) && !["owner", "admin"].includes(auth.role)) throw new Error("Only owners or administrators can approve high-risk actions.");
}

async function replay(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition, key: string, requestHash: string) {
  const receipt = await store.findCommandReceipt(auth.userId, { recordType: receiptRecordType, moduleId: action.moduleId, actionId: action.id, idempotencyKey: key });
  if (!receipt) return undefined;
  if (receipt.data.actorUserId !== auth.userId) throw new Error("The idempotency key is already bound to another authenticated actor.");
  if (receipt.data.actionId !== action.id || receipt.data.requestHash !== requestHash) throw new Error("The idempotency key was already used for a different command.");
  const records: SuiteRecord[] = [];
  for (const recordId of Array.isArray(receipt.data.resultRecordIds) ? receipt.data.resultRecordIds : []) {
    const record = await store.getRecord(auth.userId, String(recordId));
    if (record) records.push(record);
  }
  const aiAction = typeof receipt.data.aiActionId === "string" ? await store.getAiAction(auth.userId, receipt.data.aiActionId) : undefined;
  return { kind: aiAction ? "ai-action" : "command", action, records, audit: { ...(receipt.data.audit as Record<string, unknown>), receiptId: receipt.id, replayed: true }, ...(aiAction ? { aiAction } : {}) } as FirstPartyGrowthExecutionResult;
}

async function saveReceipt(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition, key: string, requestHash: string, execution: FirstPartyGrowthExecutionResult) {
  const receipt = await create(store, auth.userId, { moduleId: action.moduleId, recordType: receiptRecordType, title: `${action.id} · ${key.slice(0, 48)}`, state: "recorded", data: { actionId: action.id, idempotencyKey: key, requestHash, resultRecordIds: execution.records.map((record) => record.id), aiActionId: execution.aiAction?.id, audit: execution.audit, actorUserId: auth.userId, workspaceId: auth.workspaceId, approvalDecisionId: execution.audit.approvalDecisionId ?? null, immutable: true } });
  execution.audit = { ...execution.audit, receiptId: receipt.id, requestHash, replayed: false };
  return execution;
}

async function queueAi(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition, input: Record<string, unknown>, deps: FirstPartyGrowthEngineDependencies) {
  const evidence: SuiteRecord[] = [];
  for (const recordId of input.evidenceIds as string[]) evidence.push(await owned(store, auth.userId, recordId, undefined, undefined, "evidenceId"));
  if (action.moduleId === "giveaways" && evidence.some((record) => record.moduleId !== "giveaways" || !["contest", "entrant", "fraud-signal", "eligibility-decision", "consent-receipt", "consent-revocation", "draw-snapshot", "winner-proof"].includes(record.recordType))) throw new Error("Giveaway fraud review evidence must be an allowlisted contest-integrity record from this workspace.");
  const targetKey = action.moduleId === "giveaways" ? "contestId" : action.moduleId === "testimonials" ? "collectionId" : "pageId";
  const targetType = action.moduleId === "giveaways" ? "contest" : action.moduleId === "testimonials" ? "collection" : "page";
  const target = await owned(store, auth.userId, input[targetKey], action.moduleId, targetType, targetKey);
  const policy = firstPartyGrowthPromptPolicies[action.moduleId];
  if (!action.promptId || action.promptVersion !== policy.version) throw new Error("The AI action is missing an approved prompt boundary.");
  const boundary = {
    promptId: action.promptId,
    promptVersion: policy.version,
    promptDigest: firstPartyGrowthPromptDigest(action.moduleId),
    modelPolicyId: deps.modelPolicyId,
    executedModel: null,
    confidence: null,
    evidenceIds: evidence.map((record) => record.id),
    targetRecordId: target.id,
    reviewStatus: "pending-model",
    approvalRequired: true,
    resultContract: policy.resultContract,
    forbiddenAutonomy: policy.forbiddenAutonomy,
  };
  const requestedAt = deps.now().toISOString();
  const auditRecord = await create(store, auth.userId, { moduleId: action.moduleId, recordType: "ai-request-audit", title: action.title, state: "queued", data: { ...boundary, requestedAt, requestedByUserId: auth.userId, immutableRequest: true } });
  const aiAction = await store.queueAiAction(auth.userId, { moduleId: action.moduleId, goal: String(input.instruction), context: { actionId: action.id, aiAuditRecordId: auditRecord.id, ...boundary } });
  if (!aiAction) {
    await update(store, auth.userId, auditRecord.id, { state: "queue-failed", data: { reviewStatus: "queue-failed", failedAt: requestedAt } });
    throw new Error("The AI proposal could not be queued.");
  }
  return { kind: "ai-action", action, records: [auditRecord], aiAction, audit: { aiAuditRecordId: auditRecord.id, ...boundary, modelExecuted: false, externalEffectExecuted: false } } satisfies FirstPartyGrowthExecutionResult;
}

export function validateFirstPartyGrowthAiCompletion(value: unknown, allowedEvidenceIds: Iterable<string>): FirstPartyGrowthAiCompletion {
  const result = object(value, "AI result");
  const allowedKeys = new Set(["version", "proposal", "evidence", "confidence", "assumptions", "reviewStatus", "approvalRequired", "model"]);
  if (Object.keys(result).some((key) => !allowedKeys.has(key))) throw new Error("The AI result contains fields outside the approved proposal contract.");
  if (result.version !== "first-party-growth-ai-result.v1") throw new Error("The AI result contract version is unsupported.");
  if (typeof result.proposal !== "string" || !result.proposal.trim() || result.proposal.length > 20_000) throw new Error("The AI proposal is missing or too long.");
  if (!Array.isArray(result.evidence) || result.evidence.length > 100 || result.evidence.some((id) => typeof id !== "string")) throw new Error("The AI evidence list is malformed.");
  const evidence = [...new Set(result.evidence as string[])];
  const allowed = new Set(allowedEvidenceIds);
  if (evidence.some((recordId) => !allowed.has(recordId))) throw new Error("The AI result cites evidence outside the authorized selection.");
  if (typeof result.confidence !== "number" || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new Error("The AI confidence must be from zero to one.");
  if (!Array.isArray(result.assumptions) || result.assumptions.length > 50 || result.assumptions.some((item) => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new Error("The AI assumptions are malformed.");
  if (result.reviewStatus !== "pending-human-review" || result.approvalRequired !== true) throw new Error("The AI result must remain pending human review and approval-required.");
  if (typeof result.model !== "string" || !result.model.trim() || result.model.length > 200) throw new Error("The executed model identifier is required.");
  return { ...result, version: "first-party-growth-ai-result.v1", proposal: result.proposal.trim(), evidence, confidence: result.confidence, assumptions: result.assumptions as string[], reviewStatus: "pending-human-review", approvalRequired: true, model: result.model.trim() } as FirstPartyGrowthAiCompletion;
}

interface DrawCandidate {
  entryId: string;
  weight: number;
  eligibilityDecisionId: string | null;
  consentReceiptId: string;
}

function candidateDigest(candidates: DrawCandidate[]) {
  return digest(candidates.map((candidate) => ({ entryId: candidate.entryId, weight: candidate.weight, eligibilityDecisionId: candidate.eligibilityDecisionId, consentReceiptId: candidate.consentReceiptId })));
}

async function drawCandidates(store: SuiteStore, userId: string, contest: SuiteRecord) {
  const entrants = (await list(store, userId, "giveaways", "entrant")).filter((record) => record.data.contestId === contest.id);
  const consentReceipts = await list(store, userId, "giveaways", "consent-receipt");
  const signals = (await list(store, userId, "giveaways", "fraud-signal")).filter((record) => entrants.some((entry) => entry.id === record.data.entryId));
  const decisions = (await list(store, userId, "giveaways", "eligibility-decision")).filter((record) => entrants.some((entry) => entry.id === record.data.entryId));
  for (const signal of signals) {
    const resolved = decisions.some((decision) => decision.data.entryId === signal.data.entryId && Array.isArray(decision.data.reviewedSignalIds) && decision.data.reviewedSignalIds.includes(signal.id));
    if (!resolved) throw new Error("Every recorded fraud signal needs an attributable human eligibility decision before freezing a draw.");
  }
  const bonusCap = Number(contest.data.referralBonusCap ?? 0);
  const candidates = entrants
    .filter((entry) => entry.state === "eligible" && entry.data.consentRevokedAt === undefined && typeof entry.data.consentReceiptId === "string" && consentReceipts.some((receipt) => receipt.id === entry.data.consentReceiptId && receipt.state === "granted"))
    .map((entry) => {
      const latestDecision = decisions.filter((decision) => decision.data.entryId === entry.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      return { entryId: entry.id, weight: Math.max(1, Math.min(1 + bonusCap, Number(entry.data.weight ?? 1))), eligibilityDecisionId: latestDecision?.id ?? null, consentReceiptId: String(entry.data.consentReceiptId) };
    })
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
  if (!candidates.length) throw new Error("The contest has no consent-valid eligible candidates.");
  if (candidates.some((candidate) => !Number.isSafeInteger(candidate.weight))) throw new Error("A candidate has an invalid weight.");
  return candidates;
}

function selectWinner(seedHash: string, candidates: DrawCandidate[]) {
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (!Number.isSafeInteger(totalWeight) || totalWeight <= 0) throw new Error("The candidate weight total is invalid.");
  const range = 1n << 256n;
  const limit = range - (range % BigInt(totalWeight));
  let counter = 0;
  let sample = 0n;
  while (counter < 1_000) {
    sample = BigInt(`0x${hashText(`${seedHash}:${counter}`)}`);
    if (sample < limit) break;
    counter += 1;
  }
  if (counter >= 1_000) throw new Error("The auditable rejection sampler did not converge.");
  const selectedIndex = Number(sample % BigInt(totalWeight));
  let cursor = 0;
  const winner = candidates.find((candidate) => { cursor += candidate.weight; return selectedIndex < cursor; });
  if (!winner) throw new Error("The winner allocation could not be resolved.");
  return { winner, selectedIndex, totalWeight, rejectionCounter: counter, algorithm: "sha256-commit-public-entropy-rejection-v1" };
}

async function giveawayCommand(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition, input: Record<string, unknown>, deps: FirstPartyGrowthEngineDependencies, apply: boolean) {
  const nowDate = deps.now();
  const now = nowDate.toISOString();
  if (action.id === "contest-create") {
    const closesAt = iso(input.closesAt, "closesAt");
    if (new Date(closesAt) <= nowDate) throw new Error("Contest close time must be in the future.");
    const rulesHash = digest({ name: input.name, description: input.description ?? "", closesAt, rules: input.rules, consentPolicyVersion: input.consentPolicyVersion, referralBonusCap: input.referralBonusCap ?? 0, prizeDescription: input.prizeDescription ?? "" });
    const contest = await create(store, auth.userId, { moduleId: "giveaways", recordType: "contest", title: String(input.name), state: "draft", data: { description: input.description ?? "", closesAt, rules: input.rules, rulesHash, entropyCommitment: input.entropyCommitment, consentPolicyVersion: input.consentPolicyVersion, referralBonusCap: input.referralBonusCap ?? 0, prizeDescription: input.prizeDescription ?? "", version: 1, public: false, createdAt: now } });
    return output(action, [contest], { contestId: contest.id, rulesHash, entropyCommittedBeforeEntries: true, externalEffectExecuted: false });
  }
  if (action.id === "contest-publish") {
    const contest = await owned(store, auth.userId, input.contestId, "giveaways", "contest", "contestId");
    const nextVersion = expected(contest, input, "expectedVersion");
    if (contest.state !== "draft" || contest.data.rulesHash !== input.rulesHash || time(contest.data.closesAt, "contest.closesAt") <= nowDate.getTime()) throw new Error("Only the exact current draft rules of an open contest can be published.");
    if (!apply) return output(action, [], { dryRun: true, plannedState: "published", contestId: contest.id, rulesHash: contest.data.rulesHash, externalEffectExecuted: false });
    const published = await update(store, auth.userId, contest.id, { state: "published", data: { public: true, publishedAt: now, version: nextVersion } });
    return output(action, [published], { contestId: published.id, rulesHash: published.data.rulesHash, publicSurfaceChanged: true, externalEffectExecuted: true });
  }
  if (action.id === "entry-register") {
    const contest = await owned(store, auth.userId, input.contestId, "giveaways", "contest", "contestId");
    if (contest.state !== "published" || contest.data.drawSnapshotId || time(contest.data.closesAt, "contest.closesAt") <= nowDate.getTime()) throw new Error("This contest is not accepting entries.");
    const consentInput = object(input.consent, "consent");
    if (consentInput.policyVersion !== contest.data.consentPolicyVersion || !Array.isArray(consentInput.purposes) || !consentInput.purposes.includes("contest-administration")) throw new Error("Entry consent must match the contest policy and include contest administration.");
    const consentCapturedAt = iso(consentInput.capturedAt, "consent.capturedAt");
    if (new Date(consentCapturedAt).getTime() > nowDate.getTime()) throw new Error("Entry consent cannot be captured in the future.");
    const entrants = (await list(store, auth.userId, "giveaways", "entrant")).filter((record) => record.data.contestId === contest.id);
    if (entrants.some((record) => record.data.participantKeyHash === input.participantKeyHash && record.state !== "revoked")) throw new Error("This pseudonymous participant key already entered the contest.");
    const referralCode = digest({ workspaceId: auth.workspaceId, contestId: contest.id, participantKeyHash: input.participantKeyHash }).slice(0, 16);
    if (entrants.some((record) => record.data.referralCode === referralCode)) throw new Error("The referral code space produced a collision; no entry was created.");
    const referrer = input.referralCode ? entrants.find((record) => record.data.referralCode === input.referralCode && record.state === "eligible") : undefined;
    if (input.referralCode && !referrer) throw new Error("The referral code is not eligible for this contest.");
    const receipt = await create(store, auth.userId, { moduleId: "giveaways", recordType: "consent-receipt", title: `Contest consent · ${referralCode}`, state: "granted", data: { contestId: contest.id, participantKeyHash: input.participantKeyHash, policyVersion: consentInput.policyVersion, purposes: consentInput.purposes, capturedAt: consentCapturedAt, captureMethod: consentInput.captureMethod, immutableGrant: true, public: false } });
    const entry = await create(store, auth.userId, { moduleId: "giveaways", recordType: "entrant", title: `Entry ${referralCode}`, state: "eligible", data: { contestId: contest.id, participantKeyHash: input.participantKeyHash, displayName: input.displayName ?? "", referralCode, referrerEntryId: referrer?.id ?? null, consentReceiptId: receipt.id, sourceAttestation: input.sourceAttestation, weight: 1, version: 1, public: false, createdAt: now, protectedTraitsStored: false } });
    const records = [receipt, entry];
    if (referrer && Number(contest.data.referralBonusCap ?? 0) > 0) {
      const cap = 1 + Number(contest.data.referralBonusCap);
      const weighted = await update(store, auth.userId, referrer.id, { data: { weight: Math.min(cap, Number(referrer.data.weight ?? 1) + 1), version: version(referrer) + 1 } });
      records.push(weighted);
    }
    return output(action, records, { entryId: entry.id, consentReceiptId: receipt.id, referralCode, referrerEntryId: referrer?.id ?? null, protectedTraitInference: false, externalEffectExecuted: false });
  }
  if (action.id === "entry-consent-revoke") {
    const entry = await owned(store, auth.userId, input.entryId, "giveaways", "entrant", "entryId");
    const contest = await owned(store, auth.userId, entry.data.contestId, "giveaways", "contest", "contestId");
    if (entry.state === "revoked") throw new Error("This entry consent is already revoked.");
    const frozenSnapshot = typeof contest.data.drawSnapshotId === "string" && !contest.data.winnerProofId ? await owned(store, auth.userId, contest.data.drawSnapshotId, "giveaways", "draw-snapshot", "drawSnapshotId") : undefined;
    if (!apply) return output(action, [], { dryRun: true, entryId: entry.id, plannedState: "revoked", plannedWeight: 0, invalidatesUndrawnSnapshotId: frozenSnapshot?.id ?? null, completedDrawProofRetained: Boolean(contest.data.winnerProofId), externalEffectExecuted: false });
    const revocation = await create(store, auth.userId, { moduleId: "giveaways", recordType: "consent-revocation", title: `Revocation · ${entry.id}`, state: "recorded", data: { entryId: entry.id, consentReceiptId: entry.data.consentReceiptId, reason: input.reason, revokedAt: now, revokedByUserId: auth.userId, immutable: true, public: false } });
    const revoked = await update(store, auth.userId, entry.id, { state: "revoked", data: { consentRevokedAt: now, consentRevocationId: revocation.id, weight: 0, version: version(entry) + 1, public: false } });
    const records = [revocation, revoked];
    if (typeof entry.data.consentReceiptId === "string") records.push(await update(store, auth.userId, entry.data.consentReceiptId, { state: "revoked", data: { revokedAt: now, consentRevocationId: revocation.id } }));
    if (typeof entry.data.referrerEntryId === "string" && !contest.data.winnerProofId) {
      const referrer = await owned(store, auth.userId, entry.data.referrerEntryId, "giveaways", "entrant", "referrerEntryId");
      const adjusted = await update(store, auth.userId, referrer.id, { data: { weight: Math.max(1, Number(referrer.data.weight ?? 1) - 1), version: version(referrer) + 1 } });
      records.push(adjusted);
    }
    if (frozenSnapshot) {
      records.push(await update(store, auth.userId, frozenSnapshot.id, { state: "invalidated", data: { invalidatedAt: now, invalidatedByConsentRevocationId: revocation.id, public: false } }));
      records.push(await update(store, auth.userId, contest.id, { state: "published", data: { drawSnapshotId: null, entriesClosedAt: now, snapshotInvalidatedAt: now, snapshotInvalidationReason: "candidate-consent-revoked", version: version(contest) + 1, public: true } }));
    }
    return output(action, records, { entryId: revoked.id, consentRevocationId: revocation.id, eligibilityRemoved: true, referralWeightRemoved: !contest.data.winnerProofId, invalidatedUndrawnSnapshotId: frozenSnapshot?.id ?? null, completedDrawProofRetained: Boolean(contest.data.winnerProofId), externalEffectExecuted: false });
  }
  if (action.id === "fraud-signal-record") {
    const entry = await owned(store, auth.userId, input.entryId, "giveaways", "entrant", "entryId");
    const summary = String(input.observationSummary);
    assertNoSensitiveFraudInference(summary);
    const evidence: SuiteRecord[] = [];
    for (const recordId of input.evidenceIds as string[]) evidence.push(await owned(store, auth.userId, recordId, undefined, undefined, "evidenceId"));
    const signal = await create(store, auth.userId, { moduleId: "giveaways", recordType: "fraud-signal", title: `${input.signalKind} · ${entry.id}`, state: "pending-human-review", data: { entryId: entry.id, contestId: entry.data.contestId, signalKind: input.signalKind, severity: input.severity, evidenceIds: evidence.map((record) => record.id), observationSummary: summary, observedAt: now, protectedTraitInference: false, autonomousDecision: false, public: false } });
    return output(action, [signal], { signalId: signal.id, reviewStatus: "pending-human-review", protectedTraitInference: false, eligibilityChanged: false });
  }
  if (action.id === "eligibility-decide") {
    const entry = await owned(store, auth.userId, input.entryId, "giveaways", "entrant", "entryId");
    const contest = await owned(store, auth.userId, entry.data.contestId, "giveaways", "contest", "contestId");
    if (contest.data.drawSnapshotId) throw new Error("Eligibility cannot change after the draw candidate snapshot is frozen.");
    const nextVersion = expected(entry, input, "expectedEntryVersion");
    const reviewedSignals: SuiteRecord[] = [];
    for (const signalId of input.reviewedSignalIds as string[]) {
      const signal = await owned(store, auth.userId, signalId, "giveaways", "fraud-signal", "reviewedSignalId");
      if (signal.data.entryId !== entry.id) throw new Error("A reviewed fraud signal belongs to another entry.");
      reviewedSignals.push(signal);
    }
    if (!apply) return output(action, [], { dryRun: true, entryId: entry.id, plannedState: input.decision, reviewedSignalIds: reviewedSignals.map((record) => record.id), protectedTraitInference: false });
    const decision = await create(store, auth.userId, { moduleId: "giveaways", recordType: "eligibility-decision", title: `${input.decision} · ${entry.id}`, state: "recorded", data: { entryId: entry.id, contestId: contest.id, decision: input.decision, reviewedSignalIds: reviewedSignals.map((record) => record.id), reason: input.reason, decidedAt: now, decidedByUserId: auth.userId, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId, protectedTraitInference: false, autonomousDecision: false, immutable: true, public: false } });
    const decided = await update(store, auth.userId, entry.id, { state: input.decision === "eligible" ? "eligible" : "excluded", data: { eligibilityDecisionId: decision.id, weight: input.decision === "eligible" ? Math.max(1, Number(entry.data.weight ?? 1)) : 0, version: nextVersion, public: false } });
    return output(action, [decision, decided], { entryId: decided.id, eligibilityDecisionId: decision.id, decision: input.decision, protectedTraitInference: false, humanDecision: true });
  }
  if (action.id === "draw-snapshot-freeze") {
    const contest = await owned(store, auth.userId, input.contestId, "giveaways", "contest", "contestId");
    const nextVersion = expected(contest, input, "expectedContestVersion");
    if (contest.state !== "published" || contest.data.drawSnapshotId || time(contest.data.closesAt, "contest.closesAt") > nowDate.getTime()) throw new Error("Only a closed published contest without an existing snapshot can freeze candidates.");
    const candidates = await drawCandidates(store, auth.userId, contest);
    const candidatesHash = candidateDigest(candidates);
    const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    const audit = { contestId: contest.id, candidatesHash, candidateCount: candidates.length, totalWeight, algorithm: "canonical-json-sha256-v1", sourceEntriesLockedByContestState: true };
    if (!apply) return output(action, [], { ...audit, dryRun: true, plannedState: "draw-frozen" });
    const snapshot = await create(store, auth.userId, { moduleId: "giveaways", recordType: "draw-snapshot", title: `Draw snapshot · ${contest.title}`, state: "frozen", data: { ...audit, organizerEntropyCommitment: contest.data.entropyCommitment, frozenAt: now, frozenByUserId: auth.userId, immutable: true, public: false } });
    const frozen = await update(store, auth.userId, contest.id, { state: "draw-frozen", data: { drawSnapshotId: snapshot.id, entriesClosedAt: now, version: nextVersion, public: true } });
    return output(action, [snapshot, frozen], { ...audit, snapshotId: snapshot.id, immutableSnapshot: true });
  }
  if (action.id === "winner-draw-reveal") {
    const snapshot = await owned(store, auth.userId, input.snapshotId, "giveaways", "draw-snapshot", "snapshotId");
    const contest = await owned(store, auth.userId, snapshot.data.contestId, "giveaways", "contest", "contestId");
    if (contest.state !== "draw-frozen" || contest.data.drawSnapshotId !== snapshot.id || contest.data.winnerProofId) throw new Error("This draw is not in a unique frozen, undrawn state.");
    if (hashText(String(input.entropyReveal)) !== snapshot.data.organizerEntropyCommitment) throw new Error("The organizer entropy reveal does not match the pre-entry commitment.");
    const publicEntropySource = publicHttps(input.publicEntropySource, "publicEntropySource");
    const candidates = await drawCandidates(store, auth.userId, contest);
    const currentCandidateHash = candidateDigest(candidates);
    if (currentCandidateHash !== snapshot.data.candidatesHash) throw new Error("The frozen candidate set no longer matches its immutable digest.");
    const seedHash = digest({ contestId: contest.id, snapshotId: snapshot.id, candidatesHash: currentCandidateHash, organizerEntropyReveal: input.entropyReveal, publicEntropy: input.publicEntropy, publicEntropySource, beaconObservedAt: iso(input.beaconObservedAt, "beaconObservedAt") });
    const selection = selectWinner(seedHash, candidates);
    const winnerToken = digest({ contestId: contest.id, entryId: selection.winner.entryId }).slice(0, 24);
    const proof = { algorithm: selection.algorithm, seedHash, candidatesHash: currentCandidateHash, candidateCount: candidates.length, totalWeight: selection.totalWeight, selectedIndex: selection.selectedIndex, rejectionCounter: selection.rejectionCounter, winnerToken, organizerEntropyReveal: input.entropyReveal, publicEntropy: input.publicEntropy, publicEntropySource, beaconObservedAt: iso(input.beaconObservedAt, "beaconObservedAt"), reproducible: true };
    if (!apply) return output(action, [], { ...proof, dryRun: true, winnerEntryId: selection.winner.entryId, externalEffectExecuted: false });
    const winnerProof = await create(store, auth.userId, { moduleId: "giveaways", recordType: "winner-proof", title: `Winner proof · ${contest.title}`, state: "selected", data: { ...proof, contestId: contest.id, snapshotId: snapshot.id, winnerEntryId: selection.winner.entryId, drawnAt: now, drawnByUserId: auth.userId, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId, immutable: true, public: false } });
    const drawn = await update(store, auth.userId, contest.id, { state: "drawn", data: { winnerProofId: winnerProof.id, publicDrawProof: proof, drawnAt: now, version: version(contest) + 1, public: true } });
    return output(action, [winnerProof, drawn], { ...proof, winnerProofId: winnerProof.id, winnerEntryId: selection.winner.entryId, publicSurfaceChanged: true, externalEffectExecuted: true });
  }
  if (action.id === "referral-variant-allocate") {
    await owned(store, auth.userId, input.contestId, "giveaways", "contest", "contestId");
    return output(action, [], { contestId: input.contestId, experimentId: input.experimentId, ...deterministicAllocation({ contestId: input.contestId, participantKeyHash: input.participantKeyHash, experimentId: input.experimentId }, input.variants) }, "read");
  }
  if (action.id === "aggregate-event-ingest") {
    await owned(store, auth.userId, input.contestId, "giveaways", "contest", "contestId");
    assertAggregateDimensions(input.dimensions);
    const duplicate = (await list(store, auth.userId, "giveaways", "aggregate-event")).find((record) => record.data.eventId === input.eventId);
    if (duplicate) return output(action, [duplicate], { aggregateEventId: duplicate.id, duplicate: true, rawIdentityStored: false });
    const event = await create(store, auth.userId, { moduleId: "giveaways", recordType: "aggregate-event", title: String(input.eventId), state: "observed", data: { contestId: input.contestId, eventId: input.eventId, eventType: input.eventType, occurredOn: input.occurredOn, count: input.count, dimensions: input.dimensions, rawIdentityStored: false, aggregateOnly: true, recordedAt: now, public: false } });
    return output(action, [event], { aggregateEventId: event.id, duplicate: false, rawIdentityStored: false, aggregateOnly: true });
  }
  if (action.id === "contest-export-manifest") {
    const contest = await owned(store, auth.userId, input.contestId, "giveaways", "contest", "contestId");
    const related = (await list(store, auth.userId, "giveaways")).filter((record) => record.id === contest.id || record.data.contestId === contest.id || record.data.entryId && (record.data.contestId === contest.id));
    const included = related.filter((record) => input.includeRevokedAudit === true || record.recordType !== "consent-revocation");
    const manifestHash = digest(included.map((record) => ({ id: record.id, recordType: record.recordType, state: record.state, updatedAt: record.updatedAt })));
    const manifest = await create(store, auth.userId, { moduleId: "giveaways", recordType: "export-manifest", title: `Contest export · ${contest.title}`, state: "ready", data: { contestId: contest.id, format: input.format, includeRevokedAudit: input.includeRevokedAudit, recordIds: included.map((record) => record.id), manifestHash, private: true, generatedAt: now } });
    return output(action, [manifest], { exportManifestId: manifest.id, manifestHash, recordCount: included.length, private: true });
  }
  throw new Error("The FairLaunch action is not implemented.");
}

async function testimonialCommand(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition, input: Record<string, unknown>, deps: FirstPartyGrowthEngineDependencies, apply: boolean) {
  const nowDate = deps.now();
  const now = nowDate.toISOString();
  if (action.id === "collection-create") {
    const collection = await create(store, auth.userId, { moduleId: "testimonials", recordType: "collection", title: String(input.name), state: "active", data: { purpose: input.purpose, consentPolicyVersion: input.consentPolicyVersion, retentionDays: input.retentionDays, allowedLocales: input.allowedLocales ?? [], version: 1, public: false, createdAt: now } });
    return output(action, [collection], { collectionId: collection.id, consentPolicyVersion: collection.data.consentPolicyVersion, public: false });
  }
  if (action.id === "request-draft") {
    const collection = await owned(store, auth.userId, input.collectionId, "testimonials", "collection", "collectionId");
    const expiresAt = iso(input.expiresAt, "expiresAt");
    if (new Date(expiresAt) <= nowDate) throw new Error("A collection request must expire in the future.");
    const origin = hostedOrigin(deps);
    const accessToken = deps.randomBytes(24).toString("base64url");
    const request = await create(store, auth.userId, { moduleId: "testimonials", recordType: "collection-request", title: `Request · ${collection.title}`, state: "draft", data: { collectionId: collection.id, recipientRefHash: input.recipientRefHash, expiresAt, locale: input.locale, contextLabel: input.contextLabel ?? "", accessTokenHash: hashText(accessToken), tokenIssuedAt: now, providerCallStarted: false, public: false } });
    const collectionUrl = `${origin}/collect/testimonials/${encodeURIComponent(auth.workspaceId)}/${encodeURIComponent(request.id)}?token=${encodeURIComponent(accessToken)}`;
    return output(action, [request], { requestId: request.id, collectionUrl, accessToken, expiresAt, messageSent: false, providerCallStarted: false, externalEffectExecuted: false });
  }
  if (action.id === "submission-record") {
    const collection = await owned(store, auth.userId, input.collectionId, "testimonials", "collection", "collectionId");
    const consentInput = object(input.consent, "consent");
    if (consentInput.policyVersion !== collection.data.consentPolicyVersion || !Array.isArray(consentInput.purposes) || !consentInput.purposes.includes("testimonial-publication")) throw new Error("Submission consent must match the collection policy and include testimonial publication.");
    const consentCapturedAt = iso(consentInput.capturedAt, "consent.capturedAt");
    if (new Date(consentCapturedAt).getTime() > nowDate.getTime()) throw new Error("Testimonial consent cannot be captured in the future.");
    const existing = (await list(store, auth.userId, "testimonials", "testimonial")).find((record) => record.data.sourceRefHash === input.sourceRefHash && record.state !== "revoked");
    if (existing) throw new Error("This source reference already has a non-revoked testimonial submission.");
    let request: SuiteRecord | undefined;
    if (input.requestId) {
      request = await owned(store, auth.userId, input.requestId, "testimonials", "collection-request", "requestId");
      if (request.data.collectionId !== collection.id || request.state !== "draft" || time(request.data.expiresAt, "request.expiresAt") <= nowDate.getTime()) throw new Error("The collection request is expired, consumed, or belongs to another collection.");
    }
    const consentReceipt = await create(store, auth.userId, { moduleId: "testimonials", recordType: "consent-receipt", title: `Publication consent · ${input.sourceRefHash}`, state: "granted", data: { collectionId: collection.id, sourceRefHash: input.sourceRefHash, policyVersion: consentInput.policyVersion, purposes: consentInput.purposes, capturedAt: consentCapturedAt, captureMethod: consentInput.captureMethod, immutableGrant: true, public: false } });
    const statementHash = digest({ content: input.content, authorName: input.authorName, attribution: input.attribution, authorRole: input.authorRole ?? "", organization: input.organization ?? "" });
    const testimonial = await create(store, auth.userId, { moduleId: "testimonials", recordType: "testimonial", title: String(input.authorName), state: "pending-review", data: { collectionId: collection.id, requestId: request?.id ?? null, authorName: input.authorName, content: input.content, attribution: input.attribution, authorRole: input.authorRole ?? "", organization: input.organization ?? "", consentReceiptId: consentReceipt.id, sourceRefHash: input.sourceRefHash, statementHash, submittedAt: now, version: 1, public: false } });
    const records = [consentReceipt, testimonial];
    if (request) records.push(await update(store, auth.userId, request.id, { state: "consumed", data: { testimonialId: testimonial.id, consumedAt: now } }));
    return output(action, records, { testimonialId: testimonial.id, consentReceiptId: consentReceipt.id, statementHash, public: false, moderationStatus: "pending-review" });
  }
  if (action.id === "consent-revoke") {
    const testimonial = await owned(store, auth.userId, input.testimonialId, "testimonials", "testimonial", "testimonialId");
    if (testimonial.state === "revoked" || testimonial.data.consentRevokedAt) throw new Error("This testimonial consent is already revoked.");
    const publicationVersions = (await list(store, auth.userId, "testimonials", "publication-version")).filter((record) => record.data.testimonialId === testimonial.id && record.state !== "revoked");
    const affectedIds = publicationVersions.map((record) => record.id);
    const widgets = (await list(store, auth.userId, "testimonials", "widget-version")).filter((record) => Array.isArray(record.data.publicationVersionIds) && record.data.publicationVersionIds.some((recordId) => affectedIds.includes(String(recordId))) && record.state !== "revoked-content");
    if (!apply) return output(action, [], { dryRun: true, testimonialId: testimonial.id, publicationVersionIds: affectedIds, widgetVersionIds: widgets.map((record) => record.id), plannedPublicState: false, externalEffectExecuted: false });
    const revocation = await create(store, auth.userId, { moduleId: "testimonials", recordType: "consent-revocation", title: `Publication revocation · ${testimonial.id}`, state: "recorded", data: { testimonialId: testimonial.id, consentReceiptId: testimonial.data.consentReceiptId, reason: input.reason, revokedAt: now, revokedByUserId: auth.userId, immutable: true, public: false } });
    const records: SuiteRecord[] = [revocation, await update(store, auth.userId, testimonial.id, { state: "revoked", data: { consentRevocationId: revocation.id, consentRevokedAt: now, public: false, version: version(testimonial) + 1 } })];
    if (typeof testimonial.data.consentReceiptId === "string") records.push(await update(store, auth.userId, testimonial.data.consentReceiptId, { state: "revoked", data: { revokedAt: now, consentRevocationId: revocation.id } }));
    for (const publication of publicationVersions) records.push(await update(store, auth.userId, publication.id, { state: "revoked", data: { public: false, revokedAt: now, consentRevocationId: revocation.id } }));
    for (const widget of widgets) records.push(await update(store, auth.userId, widget.id, { state: "revoked-content", data: { public: false, invalidatedAt: now, consentRevocationId: revocation.id } }));
    return output(action, records, { testimonialId: testimonial.id, consentRevocationId: revocation.id, publicationVersionsUnpublished: publicationVersions.length, widgetsUnpublished: widgets.length, publicSurfaceChanged: publicationVersions.length + widgets.length > 0, externalEffectExecuted: true });
  }
  if (action.id === "moderation-decide") {
    const testimonial = await owned(store, auth.userId, input.testimonialId, "testimonials", "testimonial", "testimonialId");
    const nextVersion = expected(testimonial, input, "expectedVersion");
    if (testimonial.state !== "pending-review" || testimonial.data.consentRevokedAt) throw new Error("Only a consent-valid pending testimonial can receive an initial moderation decision.");
    if (input.decision === "redact" && (typeof input.redactedContent !== "string" || !input.redactedContent.trim() || input.redactedContent === testimonial.data.content)) throw new Error("A redact decision requires non-empty content different from the original statement.");
    if (input.decision !== "redact" && input.redactedContent) throw new Error("Redacted content is allowed only for a redact decision.");
    if (!apply) return output(action, [], { dryRun: true, testimonialId: testimonial.id, plannedState: input.decision, originalStatementPreserved: true });
    const decision = await create(store, auth.userId, { moduleId: "testimonials", recordType: "moderation-decision", title: `${input.decision} · ${testimonial.id}`, state: "recorded", data: { testimonialId: testimonial.id, decision: input.decision, reason: input.reason, redactedContent: input.decision === "redact" ? input.redactedContent : null, decidedAt: now, decidedByUserId: auth.userId, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId, originalStatementHash: testimonial.data.statementHash, immutable: true, public: false } });
    const moderated = await update(store, auth.userId, testimonial.id, { state: input.decision === "reject" ? "rejected" : input.decision === "redact" ? "redacted" : "reviewed", data: { moderationDecisionId: decision.id, moderatedAt: now, version: nextVersion, public: false } });
    return output(action, [decision, moderated], { testimonialId: testimonial.id, moderationDecisionId: decision.id, decision: input.decision, originalStatementPreserved: true, humanDecision: true });
  }
  if (action.id === "publication-version-create") {
    const testimonial = await owned(store, auth.userId, input.testimonialId, "testimonials", "testimonial", "testimonialId");
    const decision = await owned(store, auth.userId, input.moderationDecisionId, "testimonials", "moderation-decision", "moderationDecisionId");
    const consentReceipt = await owned(store, auth.userId, testimonial.data.consentReceiptId, "testimonials", "consent-receipt", "consentReceiptId");
    if (decision.data.testimonialId !== testimonial.id || testimonial.data.moderationDecisionId !== decision.id || !["reviewed", "redacted"].includes(testimonial.state) || testimonial.data.consentRevokedAt || consentReceipt.state !== "granted") throw new Error("A consent-valid accepted or redacted moderation decision is required.");
    const expectedContent = decision.data.decision === "redact" ? decision.data.redactedContent : testimonial.data.content;
    if (input.content !== expectedContent) throw new Error("Publication content must exactly match the human-reviewed statement version.");
    const contentHash = digest({ testimonialId: testimonial.id, content: input.content, attributionLabel: input.attributionLabel, disclosure: input.disclosure ?? "", consentReceiptId: testimonial.data.consentReceiptId, moderationDecisionId: decision.id });
    const publication = await create(store, auth.userId, { moduleId: "testimonials", recordType: "publication-version", title: String(input.attributionLabel), state: "draft", data: { testimonialId: testimonial.id, content: input.content, attributionLabel: input.attributionLabel, disclosure: input.disclosure ?? "", consentReceiptId: testimonial.data.consentReceiptId, moderationDecisionId: decision.id, contentHash, version: 1, public: false, createdAt: now } });
    return output(action, [publication], { publicationVersionId: publication.id, contentHash, public: false, exactReviewedContent: true });
  }
  if (action.id === "publication-publish") {
    const publication = await owned(store, auth.userId, input.publicationVersionId, "testimonials", "publication-version", "publicationVersionId");
    const testimonial = await owned(store, auth.userId, publication.data.testimonialId, "testimonials", "testimonial", "testimonialId");
    const consentReceipt = await owned(store, auth.userId, publication.data.consentReceiptId, "testimonials", "consent-receipt", "consentReceiptId");
    if (publication.state !== "draft" || publication.data.contentHash !== input.contentHash || testimonial.data.consentRevokedAt || consentReceipt.state !== "granted" || !["reviewed", "redacted", "published"].includes(testimonial.state)) throw new Error("Only the exact consent-valid reviewed publication version can be published.");
    if (!apply) return output(action, [], { dryRun: true, publicationVersionId: publication.id, contentHash: publication.data.contentHash, plannedState: "published", externalEffectExecuted: false });
    const published = await update(store, auth.userId, publication.id, { state: "published", data: { public: true, publishedAt: now, publishedByUserId: auth.userId, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId } });
    const source = await update(store, auth.userId, testimonial.id, { state: "published", data: { publishedVersionId: published.id, version: version(testimonial) + 1, public: false } });
    return output(action, [published, source], { publicationVersionId: published.id, testimonialId: source.id, publicSurfaceChanged: true, externalEffectExecuted: true, consentReceiptId: published.data.consentReceiptId });
  }
  if (action.id === "widget-version-create") {
    const publications: SuiteRecord[] = [];
    for (const publicationId of input.publicationVersionIds as string[]) {
      const publication = await owned(store, auth.userId, publicationId, "testimonials", "publication-version", "publicationVersionId");
      if (publication.state !== "published" || publication.data.public !== true) throw new Error("Widgets may reference only currently published testimonial versions.");
      const source = await owned(store, auth.userId, publication.data.testimonialId, "testimonials", "testimonial", "testimonialId");
      const consentReceipt = await owned(store, auth.userId, publication.data.consentReceiptId, "testimonials", "consent-receipt", "consentReceiptId");
      if (source.data.consentRevokedAt || consentReceipt.state !== "granted") throw new Error("A referenced testimonial no longer has valid publication consent.");
      publications.push(publication);
    }
    if (new Set(publications.map((record) => record.id)).size !== publications.length) throw new Error("Widget publication versions must be unique.");
    const prior = (await list(store, auth.userId, "testimonials", "widget-version")).filter((record) => record.data.widgetKey === input.widgetKey);
    const widgetVersion = prior.reduce((maximum, record) => Math.max(maximum, Number(record.data.version ?? 0)), 0) + 1;
    const contentHash = digest({ widgetKey: input.widgetKey, version: widgetVersion, publicationVersionIds: publications.map((record) => record.id), layout: input.layout, theme: input.theme });
    const widget = await create(store, auth.userId, { moduleId: "testimonials", recordType: "widget-version", title: String(input.name), state: "draft", data: { widgetKey: input.widgetKey, version: widgetVersion, publicationVersionIds: publications.map((record) => record.id), layout: input.layout, theme: input.theme, contentHash, arbitraryHtmlAllowed: false, arbitraryScriptAllowed: false, public: false, createdAt: now } });
    return output(action, [widget], { widgetVersionId: widget.id, widgetKey: input.widgetKey, version: widgetVersion, contentHash, public: false });
  }
  if (action.id === "widget-publish") {
    const widget = await owned(store, auth.userId, input.widgetVersionId, "testimonials", "widget-version", "widgetVersionId");
    if (widget.state !== "draft" || widget.data.contentHash !== input.contentHash) throw new Error("Only the exact draft widget content hash can be published.");
    for (const publicationId of widget.data.publicationVersionIds as string[]) {
      const publication = await owned(store, auth.userId, publicationId, "testimonials", "publication-version", "publicationVersionId");
      if (publication.state !== "published" || publication.data.public !== true) throw new Error("A referenced testimonial version is no longer public.");
      const source = await owned(store, auth.userId, publication.data.testimonialId, "testimonials", "testimonial", "testimonialId");
      const consentReceipt = await owned(store, auth.userId, publication.data.consentReceiptId, "testimonials", "consent-receipt", "consentReceiptId");
      if (source.data.consentRevokedAt || consentReceipt.state !== "granted") throw new Error("A referenced testimonial no longer has valid publication consent.");
    }
    const superseded = (await list(store, auth.userId, "testimonials", "widget-version")).filter((record) => record.id !== widget.id && record.data.widgetKey === widget.data.widgetKey && record.state === "published");
    if (!apply) return output(action, [], { dryRun: true, widgetVersionId: widget.id, supersededWidgetVersionIds: superseded.map((record) => record.id), plannedState: "published", externalEffectExecuted: false });
    const records: SuiteRecord[] = [];
    for (const previous of superseded) records.push(await update(store, auth.userId, previous.id, { state: "superseded", data: { public: false, supersededAt: now, supersededByWidgetVersionId: widget.id } }));
    records.push(await update(store, auth.userId, widget.id, { state: "published", data: { public: true, publishedAt: now, publishedByUserId: auth.userId, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId } }));
    return output(action, records, { widgetVersionId: widget.id, widgetKey: widget.data.widgetKey, supersededWidgetVersionIds: superseded.map((record) => record.id), publicSurfaceChanged: true, externalEffectExecuted: true });
  }
  if (action.id === "embed-code-read") {
    const widget = await owned(store, auth.userId, input.widgetVersionId, "testimonials", "widget-version", "widgetVersionId");
    if (widget.state !== "published" || widget.data.public !== true) throw new Error("Only a published widget version can be embedded.");
    const origin = hostedOrigin(deps);
    const source = `${origin}/embeds/testimonials/${encodeURIComponent(auth.workspaceId)}/${encodeURIComponent(widget.id)}`;
    const embed = input.mode === "script"
      ? `<script async src="${origin}/widgets/testimonials.js" data-workspace="${auth.workspaceId}" data-version="${widget.id}"></script>`
      : `<iframe src="${source}" sandbox="allow-scripts allow-same-origin" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" title="Testimonials"></iframe>`;
    return output(action, [widget], { widgetVersionId: widget.id, mode: input.mode, embed, pinnedVersion: true, origin, arbitraryScriptAccepted: false }, "read");
  }
  if (action.id === "aggregate-event-ingest") {
    const surface = await owned(store, auth.userId, input.surfaceVersionId, "testimonials", undefined, "surfaceVersionId");
    if (!["widget-version", "publication-version", "collection-request"].includes(surface.recordType)) throw new Error("The aggregate event surface type is unsupported.");
    assertAggregateDimensions(input.dimensions);
    const duplicate = (await list(store, auth.userId, "testimonials", "aggregate-event")).find((record) => record.data.eventId === input.eventId);
    if (duplicate) return output(action, [duplicate], { aggregateEventId: duplicate.id, duplicate: true, rawIdentityStored: false });
    const event = await create(store, auth.userId, { moduleId: "testimonials", recordType: "aggregate-event", title: String(input.eventId), state: "observed", data: { surfaceVersionId: surface.id, eventId: input.eventId, eventType: input.eventType, occurredOn: input.occurredOn, count: input.count, dimensions: input.dimensions, aggregateOnly: true, rawIdentityStored: false, recordedAt: now, public: false } });
    return output(action, [event], { aggregateEventId: event.id, duplicate: false, aggregateOnly: true, rawIdentityStored: false });
  }
  throw new Error("The ProofPort action is not implemented.");
}

async function brandPageCommand(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition, input: Record<string, unknown>, deps: FirstPartyGrowthEngineDependencies, apply: boolean) {
  const now = deps.now().toISOString();
  if (action.id === "page-create") {
    const duplicate = (await list(store, auth.userId, "brand-pages", "page")).find((record) => record.data.slug === input.slug && record.state !== "disabled");
    if (duplicate) throw new Error("This page slug is already active.");
    const page = await create(store, auth.userId, { moduleId: "brand-pages", recordType: "page", title: String(input.name), state: "private", data: { slug: input.slug, privacyMode: input.privacyMode, locale: input.locale ?? "en-US", activePageVersionId: null, version: 1, public: false, createdAt: now } });
    return output(action, [page], { pageId: page.id, slug: page.data.slug, public: false, activePageVersionId: null });
  }
  if (action.id === "destination-version-create") {
    const page = await owned(store, auth.userId, input.pageId, "brand-pages", "page", "pageId");
    if (page.state === "disabled") throw new Error("A disabled page cannot receive new destinations.");
    const destination = publicHttps(input.destination, "destination");
    const prior = (await list(store, auth.userId, "brand-pages", "destination-version")).filter((record) => record.data.pageId === page.id && record.data.linkKey === input.linkKey);
    const destinationVersion = prior.reduce((maximum, record) => Math.max(maximum, Number(record.data.version ?? 0)), 0) + 1;
    const contentHash = digest({ pageId: page.id, linkKey: input.linkKey, version: destinationVersion, destination, label: input.label, accessibilityLabel: input.accessibilityLabel ?? "", campaign: input.campaign ?? {} });
    const record = await create(store, auth.userId, { moduleId: "brand-pages", recordType: "destination-version", title: String(input.label), state: "draft", data: { pageId: page.id, linkKey: input.linkKey, version: destinationVersion, destination, label: input.label, accessibilityLabel: input.accessibilityLabel ?? "", campaign: input.campaign ?? {}, contentHash, validatedAt: now, validationPolicy: "syntax-and-reserved-host-v1", requiresResolutionCheckAtUse: true, noFetchPerformed: true, public: false } });
    return output(action, [record], { destinationVersionId: record.id, contentHash, destination, version: destinationVersion, noFetchPerformed: true, requiresResolutionCheckAtUse: true });
  }
  if (action.id === "page-version-create") {
    const page = await owned(store, auth.userId, input.pageId, "brand-pages", "page", "pageId");
    if (page.state === "disabled") throw new Error("A disabled page cannot receive a new version.");
    const links = input.links as Array<Record<string, unknown>>;
    if (new Set(links.map((item) => item.key)).size !== links.length) throw new Error("Page link keys must be unique.");
    for (const link of links) {
      const destination = await owned(store, auth.userId, link.destinationVersionId, "brand-pages", "destination-version", "destinationVersionId");
      if (destination.data.pageId !== page.id || destination.data.linkKey !== link.key || destination.state === "disabled") throw new Error("A link references a destination version from another page, key, or disabled route.");
    }
    const prior = (await list(store, auth.userId, "brand-pages", "page-version")).filter((record) => record.data.pageId === page.id);
    const pageVersion = prior.reduce((maximum, record) => Math.max(maximum, Number(record.data.version ?? 0)), 0) + 1;
    const contentHash = digest({ pageId: page.id, version: pageVersion, title: input.title, description: input.description ?? "", links, layout: input.layout, theme: input.theme });
    const record = await create(store, auth.userId, { moduleId: "brand-pages", recordType: "page-version", title: String(input.title), state: "draft", data: { pageId: page.id, version: pageVersion, description: input.description ?? "", links, layout: input.layout, theme: input.theme, contentHash, arbitraryHtmlAllowed: false, arbitraryScriptAllowed: false, public: false, createdAt: now } });
    return output(action, [record], { pageVersionId: record.id, pageId: page.id, version: pageVersion, contentHash, public: false });
  }
  if (action.id === "page-version-publish") {
    const pageVersion = await owned(store, auth.userId, input.pageVersionId, "brand-pages", "page-version", "pageVersionId");
    const page = await owned(store, auth.userId, pageVersion.data.pageId, "brand-pages", "page", "pageId");
    if (pageVersion.state !== "draft" || pageVersion.data.contentHash !== input.contentHash || page.state === "disabled") throw new Error("Only the exact current draft page version can be published.");
    const superseded = (await list(store, auth.userId, "brand-pages", "page-version")).filter((record) => record.id !== pageVersion.id && record.data.pageId === page.id && record.state === "published");
    if (!apply) return output(action, [], { dryRun: true, pageId: page.id, pageVersionId: pageVersion.id, supersededPageVersionIds: superseded.map((record) => record.id), plannedState: "published", externalEffectExecuted: false });
    const records: SuiteRecord[] = [];
    for (const previous of superseded) records.push(await update(store, auth.userId, previous.id, { state: "superseded", data: { public: false, supersededAt: now, supersededByPageVersionId: pageVersion.id } }));
    const published = await update(store, auth.userId, pageVersion.id, { state: "published", data: { public: true, publishedAt: now, publishedByUserId: auth.userId, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId } });
    const activePage = await update(store, auth.userId, page.id, { state: "published", data: { activePageVersionId: published.id, public: true, publishedAt: now, version: version(page) + 1 } });
    records.push(published, activePage);
    return output(action, records, { pageId: activePage.id, pageVersionId: published.id, slug: activePage.data.slug, supersededPageVersionIds: superseded.map((record) => record.id), publicSurfaceChanged: true, externalEffectExecuted: true });
  }
  if (action.id === "qr-route-create") {
    const duplicate = (await list(store, auth.userId, "brand-pages", "qr-route")).find((record) => record.data.slug === input.slug && record.state !== "disabled");
    if (duplicate) throw new Error("This QR route slug is already active.");
    const qrRoute = await create(store, auth.userId, { moduleId: "brand-pages", recordType: "qr-route", title: String(input.name), state: "inactive", data: { slug: input.slug, privacyMode: input.privacyMode, style: input.style, activeDestinationVersionId: null, version: 1, public: false, createdAt: now } });
    return output(action, [qrRoute], { qrRouteId: qrRoute.id, slug: qrRoute.data.slug, public: false, activeDestinationVersionId: null });
  }
  if (action.id === "qr-destination-version-create") {
    const qrRoute = await owned(store, auth.userId, input.qrRouteId, "brand-pages", "qr-route", "qrRouteId");
    if (qrRoute.state === "disabled") throw new Error("A disabled QR route cannot receive a new destination.");
    const destination = publicHttps(input.destination, "destination");
    const prior = (await list(store, auth.userId, "brand-pages", "qr-destination-version")).filter((record) => record.data.qrRouteId === qrRoute.id);
    const destinationVersion = prior.reduce((maximum, record) => Math.max(maximum, Number(record.data.version ?? 0)), 0) + 1;
    const contentHash = digest({ qrRouteId: qrRoute.id, version: destinationVersion, destination, label: input.label, campaign: input.campaign ?? {} });
    const record = await create(store, auth.userId, { moduleId: "brand-pages", recordType: "qr-destination-version", title: String(input.label), state: "draft", data: { qrRouteId: qrRoute.id, version: destinationVersion, destination, label: input.label, campaign: input.campaign ?? {}, contentHash, validatedAt: now, validationPolicy: "syntax-and-reserved-host-v1", requiresResolutionCheckAtUse: true, noFetchPerformed: true, public: false } });
    return output(action, [record], { destinationVersionId: record.id, contentHash, destination, version: destinationVersion, noFetchPerformed: true, requiresResolutionCheckAtUse: true });
  }
  if (action.id === "qr-destination-activate") {
    const destinationVersion = await owned(store, auth.userId, input.destinationVersionId, "brand-pages", "qr-destination-version", "destinationVersionId");
    const qrRoute = await owned(store, auth.userId, destinationVersion.data.qrRouteId, "brand-pages", "qr-route", "qrRouteId");
    if (destinationVersion.state !== "draft" || destinationVersion.data.contentHash !== input.contentHash || qrRoute.state === "disabled") throw new Error("Only the exact safe draft destination of an enabled QR route can be activated.");
    const previous = (await list(store, auth.userId, "brand-pages", "qr-destination-version")).filter((record) => record.id !== destinationVersion.id && record.data.qrRouteId === qrRoute.id && record.state === "active");
    if (!apply) return output(action, [], { dryRun: true, qrRouteId: qrRoute.id, destinationVersionId: destinationVersion.id, supersededDestinationVersionIds: previous.map((record) => record.id), plannedState: "active", externalEffectExecuted: false });
    const records: SuiteRecord[] = [];
    for (const prior of previous) records.push(await update(store, auth.userId, prior.id, { state: "superseded", data: { public: false, supersededAt: now, supersededByDestinationVersionId: destinationVersion.id } }));
    const activeDestination = await update(store, auth.userId, destinationVersion.id, { state: "active", data: { public: false, activatedAt: now, activatedByUserId: auth.userId, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId } });
    const activeRoute = await update(store, auth.userId, qrRoute.id, { state: "active", data: { activeDestinationVersionId: activeDestination.id, public: true, activatedAt: now, version: version(qrRoute) + 1 } });
    records.push(activeDestination, activeRoute);
    return output(action, records, { qrRouteId: activeRoute.id, destinationVersionId: activeDestination.id, destination: activeDestination.data.destination, supersededDestinationVersionIds: previous.map((record) => record.id), publicSurfaceChanged: true, externalEffectExecuted: true, requiresResolutionCheckAtUse: true });
  }
  if (action.id === "route-disable") {
    const routeType = input.routeKind === "page" ? "page" : "qr-route";
    const route = await owned(store, auth.userId, input.routeId, "brand-pages", routeType, "routeId");
    if (route.state === "disabled") throw new Error("This public route is already disabled.");
    if (!apply) return output(action, [], { dryRun: true, routeId: route.id, routeKind: input.routeKind, plannedState: "disabled", externalEffectExecuted: false });
    const disabled = await update(store, auth.userId, route.id, { state: "disabled", data: { public: false, activePageVersionId: null, activeDestinationVersionId: null, disabledAt: now, disabledByUserId: auth.userId, disabledReason: input.reason, approvalDecisionId: (input.approval as FirstPartyGrowthApproval).decisionId, version: version(route) + 1 } });
    return output(action, [disabled], { routeId: disabled.id, routeKind: input.routeKind, publicSurfaceChanged: true, externalEffectExecuted: true, versionHistoryRetained: true });
  }
  if (action.id === "aggregate-event-ingest") {
    const route = await owned(store, auth.userId, input.routeId, "brand-pages", undefined, "routeId");
    if (!["page", "qr-route"].includes(route.recordType)) throw new Error("Aggregate events require a page or QR route.");
    assertAggregateDimensions(input.dimensions);
    const duplicate = (await list(store, auth.userId, "brand-pages", "aggregate-event")).find((record) => record.data.eventId === input.eventId);
    if (duplicate) return output(action, [duplicate], { aggregateEventId: duplicate.id, duplicate: true, rawIdentityStored: false });
    const event = await create(store, auth.userId, { moduleId: "brand-pages", recordType: "aggregate-event", title: String(input.eventId), state: "observed", data: { routeId: route.id, eventId: input.eventId, eventType: input.eventType, occurredOn: input.occurredOn, count: input.count, dimensions: input.dimensions, aggregateOnly: true, rawIdentityStored: false, recordedAt: now, public: false } });
    return output(action, [event], { aggregateEventId: event.id, duplicate: false, aggregateOnly: true, rawIdentityStored: false });
  }
  if (action.id === "variant-allocate") {
    return output(action, [], { experimentId: input.experimentId, ...deterministicAllocation({ experimentId: input.experimentId, visitorKeyHash: input.visitorKeyHash }, input.variants) }, "read");
  }
  if (action.id === "embed-code-read") {
    const pageVersion = await owned(store, auth.userId, input.pageVersionId, "brand-pages", "page-version", "pageVersionId");
    if (pageVersion.state !== "published" || pageVersion.data.public !== true) throw new Error("Only a published page version can be embedded.");
    const origin = hostedOrigin(deps);
    const source = `${origin}/embeds/pages/${encodeURIComponent(auth.workspaceId)}/${encodeURIComponent(pageVersion.id)}`;
    const embed = `<iframe src="${source}" sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" title="${String(pageVersion.title).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"></iframe>`;
    return output(action, [pageVersion], { pageVersionId: pageVersion.id, embed, pinnedVersion: true, origin, arbitraryHtmlAccepted: false }, "read");
  }
  throw new Error("The BeaconPage action is not implemented.");
}

async function executeCommand(store: SuiteStore, auth: FirstPartyGrowthAuthorization, action: FirstPartyGrowthActionDefinition, input: Record<string, unknown>, deps: FirstPartyGrowthEngineDependencies, apply: boolean) {
  if (action.moduleId === "giveaways") return giveawayCommand(store, auth, action, input, deps, apply);
  if (action.moduleId === "testimonials") return testimonialCommand(store, auth, action, input, deps, apply);
  return brandPageCommand(store, auth, action, input, deps, apply);
}

/**
 * Central integration signature:
 * executeFirstPartyGrowthAction(store, auth, moduleId, actionId, input, deps?)
 *
 * Every non-read operation is serialized by SuiteStore.runInWorkspaceTransaction,
 * and its idempotency receipt is stored as a tenant-owned SuiteRecord. There are no
 * process-local maps or locks in this engine.
 */
export async function executeFirstPartyGrowthAction(
  store: SuiteStore,
  auth: FirstPartyGrowthAuthorization,
  moduleId: string,
  actionId: string,
  input: Record<string, unknown>,
  dependencies: Partial<FirstPartyGrowthEngineDependencies> = {},
): Promise<FirstPartyGrowthExecutionResult> {
  const action = firstPartyGrowthAction(moduleId, actionId);
  if (!action) throw new Error("The first-party growth action does not exist.");
  validate(input, action.inputSchema as unknown as Record<string, unknown>, "input");
  const deps: FirstPartyGrowthEngineDependencies = {
    now: dependencies.now ?? defaults.now,
    modelPolicyId: dependencies.modelPolicyId ?? defaults.modelPolicyId,
    randomBytes: dependencies.randomBytes ?? defaults.randomBytes,
    ...(dependencies.publicBaseUrl ? { publicBaseUrl: dependencies.publicBaseUrl } : {}),
  };
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
    const scopedStore = visibilityScopedStore(store, auth);
    await authorize(scopedStore, auth, action);
    const trustedNow = deps.now();
    if (!(trustedNow instanceof Date) || !Number.isFinite(trustedNow.getTime())) throw new Error("The trusted server clock is invalid.");
    const transactionDeps = { ...deps, now: () => trustedNow };
    if (action.operation === "read") return executeCommand(scopedStore, auth, action, input, transactionDeps, false);
    const key = String(input.idempotencyKey);
    const requestHash = digest({ workspaceId: auth.workspaceId, actorUserId: auth.userId, moduleId: action.moduleId, actionId: action.id, input });
    const prior = await replay(scopedStore, auth, action, key, requestHash);
    if (prior) return prior;
    if (action.operation === "ai") return saveReceipt(scopedStore, auth, action, key, requestHash, await queueAi(scopedStore, auth, action, input, transactionDeps));
    const highRisk = action.destructive || action.externalEffect;
    const dryRun = highRisk && input.dryRun === true;
    let approvalRecord: FirstPartyGrowthApproval | undefined;
    if (highRisk && !dryRun) {
      approvalRecord = approval(input, auth, trustedNow);
      await assertApprovalUnused(scopedStore, auth, approvalRecord.decisionId);
    }
    const execution = await executeCommand(scopedStore, auth, action, input, transactionDeps, !dryRun);
    execution.audit = {
      ...execution.audit,
      dryRun,
      effectBoundary: action.effectBoundary,
      providerCallStarted: false,
      autonomousExternalSideEffect: false,
      ...(approvalRecord ? { approvalDecisionId: approvalRecord.decisionId, approvedBy: approvalRecord.approvedBy, approvedAt: approvalRecord.approvedAt, approvalReason: approvalRecord.reason } : {}),
    };
    return saveReceipt(scopedStore, auth, action, key, requestHash, execution);
  });
}

export async function recordFirstPartyGrowthAiCompletion(
  store: SuiteStore,
  auth: FirstPartyGrowthAuthorization,
  aiActionId: string,
  value?: unknown,
  completedAt = new Date(),
) {
  return store.runInWorkspaceTransaction(auth.userId, async (workspace) => {
    if (workspace.id !== auth.workspaceId) throw new Error("The storage transaction belongs to another workspace.");
    const scopedStore = visibilityScopedStore(store, auth);
    const aiAction = await scopedStore.getAiAction(auth.userId, aiActionId);
    if (!aiAction || aiAction.workspaceId !== auth.workspaceId || aiAction.status !== "completed") throw new Error("The completed tenant AI action was not found.");
    const action = firstPartyGrowthAction(aiAction.moduleId, String(aiAction.context.actionId));
    if (!action || action.operation !== "ai" || action.promptId !== aiAction.context.promptId || action.promptVersion !== aiAction.context.promptVersion || firstPartyGrowthPromptDigest(action.moduleId) !== aiAction.context.promptDigest) throw new Error("The completed AI action does not match a trusted first-party prompt boundary.");
    await authorize(scopedStore, auth, action);
    const allowedEvidenceIds = Array.isArray(aiAction.context.evidenceIds) ? aiAction.context.evidenceIds.filter((recordId): recordId is string => typeof recordId === "string") : [];
    const completion = validateFirstPartyGrowthAiCompletion(value ?? aiAction.result, allowedEvidenceIds);
    const auditRecord = await owned(scopedStore, auth.userId, aiAction.context.aiAuditRecordId, action.moduleId, "ai-request-audit", "aiAuditRecordId");
    const resultHash = digest(completion);
    if (auditRecord.data.resultHash) {
      if (auditRecord.data.resultHash !== resultHash) throw new Error("The AI audit record is already bound to a different completion.");
      return { auditRecord, completion, replayed: true };
    }
    if (auditRecord.data.promptDigest !== aiAction.context.promptDigest || auditRecord.data.reviewStatus !== "pending-model") throw new Error("The AI audit record is stale or does not match the queued boundary.");
    const recorded = await update(scopedStore, auth.userId, auditRecord.id, { state: "pending-human-review", data: { executedModel: completion.model, confidence: completion.confidence, evidenceIds: completion.evidence, assumptions: completion.assumptions, reviewStatus: completion.reviewStatus, approvalRequired: true, resultHash, completedAt: completedAt.toISOString(), externalEffectExecuted: false } });
    return { auditRecord: recorded, completion, replayed: false };
  });
}

export function firstPartyGrowthScope(moduleId: FirstPartyGrowthModuleId, scope: FirstPartyGrowthScope) {
  return `${moduleId}:${scope}`;
}
