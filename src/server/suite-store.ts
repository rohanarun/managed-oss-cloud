import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { HostnameOwnershipInstructions } from "../shared/types.js";
import {
  suiteApiTokenScopes,
  suiteAiReadScopes,
  suiteModuleById,
  suiteModules,
  suitePlanAllows,
  type SuiteAiAction,
  type SuiteApiTokenPrincipal,
  type SuiteApiTokenScope,
  type SuiteApiTokenSecret,
  type SuiteApiTokenSummary,
  type SuitePlanId,
  type SuiteRecord,
  type SuiteWorkspace,
  type SuiteWorkspaceMember,
  type SuiteWorkspaceRole,
} from "../shared/suite.js";
import {
  assertSuiteStorageObjectUpdate,
  suitePlanQuota,
  suiteRecordPayloadLimitBytes,
  suiteRegisteredObjectBytes,
  suiteStorageAccountingVersion,
  suiteStorageObjectRegistration,
  type SuiteUsage,
} from "../shared/suite-quotas.js";
import { config } from "./config.js";
import { databaseTimestampIso } from "./postgres-values.js";
import { ensureDatabaseMigrations } from "./database-migrations.js";
import { hostnameClaimFromRow, hostnameOwnershipInstructions, insertPostgresHostnameClaim, MemoryHostnameClaimRegistry, newHostnameClaim, platformOwnedHostnameSuffixes, updatePostgresHostnameClaimStatus } from "./hostname-claims.js";
import { transitionProposalOnlyAiAuditRecord, validateProposalOnlyAiJob } from "./ai-result.js";
import { canReadSuiteRecord } from "./suite-record-visibility.js";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const planAllows = (plan: string, moduleId: string) => { const module = suiteModuleById.get(moduleId); return Boolean(module && (config.SUITE_ENTITLEMENT_MODE === "unrestricted" || suitePlanAllows(plan, module))); };
const canWriteRole = (role?: SuiteWorkspaceRole) => role === "owner" || role === "admin" || role === "member";
const canManageRole = (role?: SuiteWorkspaceRole) => role === "owner" || role === "admin";
const configuredDefaultPlan: SuitePlanId = config.SUITE_ENTITLEMENT_MODE === "unrestricted" ? "fleet" : "none";
const storageGbForPlan = (plan: SuitePlanId) => config.plans.find((candidate) => candidate.id === plan)?.storageGb ?? 0;
const quotaForPlan = (plan: SuitePlanId) => suitePlanQuota(plan, storageGbForPlan(plan));
const workspaceMutationLockKey = (workspaceId: string) => `suite-workspace-action:${workspaceId}`;
const platformHostnameSuffixes = () => platformOwnedHostnameSuffixes({ publicHostTarget: config.PUBLIC_HOST_TARGET, controlPlaneDomain: config.CONTROL_PLANE_DOMAIN, publicAppUrl: config.PUBLIC_APP_URL });
function recordPayloadBytes(data: Record<string, unknown> = {}) {
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > suiteRecordPayloadLimitBytes) throw new Error(`Record data exceeds the ${suiteRecordPayloadLimitBytes}-byte limit.`);
  return bytes;
}

function durableRecordVersion(record: SuiteRecord) {
  const version = Number(record.data.version ?? 1);
  return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

function aiSelectedRecordIds(context: Record<string, unknown>) {
  const ids = Array.isArray(context.evidenceIds) ? context.evidenceIds.filter((value): value is string => typeof value === "string") : [];
  if (typeof context.targetRecordId === "string") ids.push(context.targetRecordId);
  const legacySelectionKey = context.actionId === "finding-suggest"
    ? "observationId"
    : context.actionId === "reconciliation-suggest"
      ? "invoiceId"
      : context.actionId === "workflow-suggest"
        ? "workflowId"
        : undefined;
  if (legacySelectionKey && typeof context[legacySelectionKey] === "string") ids.push(context[legacySelectionKey]);
  const contractVersion = context.resultContract && typeof context.resultContract === "object" && !Array.isArray(context.resultContract)
    ? (context.resultContract as Record<string, unknown>).version
    : undefined;
  if (contractVersion === "additive-business-proposal.v1" && typeof context.requestRecordId === "string") ids.push(context.requestRecordId);
  if (contractVersion === "extended-business-proposal.v1" && typeof context.aiAuditRecordId === "string") ids.push(context.aiAuditRecordId);
  return [...new Set(ids)].slice(0, 1_000);
}

interface AssistantEvidenceBindingSelection {
  attachmentRecordId: string;
  attachmentVersion: number;
  attachmentSnapshotHash: string;
  collectionId: string;
  sourceRecordId: string;
  sourceModuleId: string;
  sourceRecordType: string;
  sourceVersion: number;
  sourceSnapshotHash: string;
  contentHash: string;
}

function assistantEvidenceBindings(action: SuiteAiAction): AssistantEvidenceBindingSelection[] {
  if (action.moduleId !== "assistant" || (action.context.resultContract as { version?: unknown } | undefined)?.version !== "premium-business-ai-result.v1" || !Array.isArray(action.context.assistantEvidenceBindings)) return [];
  return action.context.assistantEvidenceBindings.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const binding = value as Record<string, unknown>;
    const stringFields = ["attachmentRecordId", "attachmentSnapshotHash", "collectionId", "sourceRecordId", "sourceModuleId", "sourceRecordType", "sourceSnapshotHash", "contentHash"] as const;
    if (stringFields.some((field) => typeof binding[field] !== "string" || !String(binding[field]).trim()) || !Number.isSafeInteger(binding.attachmentVersion) || Number(binding.attachmentVersion) < 1 || !Number.isSafeInteger(binding.sourceVersion) || Number(binding.sourceVersion) < 1) return [];
    return [binding as unknown as AssistantEvidenceBindingSelection];
  });
}

function assistantAttachmentMatches(binding: AssistantEvidenceBindingSelection, attachment: SuiteRecord) {
  return attachment.id === binding.attachmentRecordId
    && attachment.moduleId === "assistant"
    && attachment.recordType === "source-attachment"
    && durableRecordVersion(attachment) === binding.attachmentVersion
    && attachment.data.collectionId === binding.collectionId
    && attachment.data.recordId === binding.sourceRecordId
    && attachment.data.sourceModuleId === binding.sourceModuleId
    && attachment.data.sourceRecordType === binding.sourceRecordType
    && attachment.data.sourceVersion === binding.sourceVersion
    && attachment.data.sourceSnapshotHash === binding.sourceSnapshotHash
    && attachment.data.contentHash === binding.contentHash;
}

function assistantSourceMatches(binding: AssistantEvidenceBindingSelection, source: SuiteRecord, evidenceIds: Set<string>) {
  return evidenceIds.has(source.id)
    && source.id === binding.sourceRecordId
    && source.moduleId === binding.sourceModuleId
    && source.recordType === binding.sourceRecordType
    && durableRecordVersion(source) === binding.sourceVersion;
}

export interface SuiteStore {
  readonly persistence: "postgres" | "preview-memory";
  initialize(): Promise<void>;
  runInWorkspaceTransaction<T>(userId: string, operation: (workspace: SuiteWorkspace) => Promise<T>): Promise<T>;
  getOrCreateWorkspace(userId: string): Promise<SuiteWorkspace>;
  getWorkspaceBySlug(slug: string): Promise<SuiteWorkspace | undefined>;
  getWorkspaceByPublicId(workspaceId: string): Promise<SuiteWorkspace | undefined>;
  listWorkspaceMembers(userId: string): Promise<SuiteWorkspaceMember[]>;
  addWorkspaceMember(userId: string, memberUserId: string, role: Exclude<SuiteWorkspaceRole, "owner">): Promise<SuiteWorkspaceMember | undefined>;
  removeWorkspaceMember(userId: string, memberUserId: string): Promise<boolean>;
  getUsage(userId: string): Promise<SuiteUsage>;
  listCustomDomains(userId: string): Promise<SuiteCustomDomain[]>;
  addCustomDomain(userId: string, domain: string): Promise<SuiteCustomDomain | undefined>;
  setCustomDomainStatus(userId: string, domain: string, status: SuiteCustomDomain["status"]): Promise<SuiteCustomDomain | undefined>;
  getWorkspaceByCustomDomain(domain: string): Promise<SuiteWorkspace | undefined>;
  listActiveCustomDomains(): Promise<string[]>;
  setWorkspacePlan(userId: string, plan: SuitePlanId): Promise<SuiteWorkspace | undefined>;
  enableModule(userId: string, moduleId: string): Promise<SuiteWorkspace | undefined>;
  listRecords(userId: string, input: { moduleId?: string; recordType?: string; limit: number }): Promise<SuiteRecord[]>;
  findSignerSessionByTokenHash(userId: string, tokenHash: string): Promise<SuiteRecord | undefined>;
  getRecord(userId: string, recordId: string): Promise<SuiteRecord | undefined>;
  findCommandReceipt(userId: string, input: { recordType: SuiteCommandReceiptRecordType; moduleId: string; actionId: string; idempotencyKey: string }): Promise<SuiteRecord | undefined>;
  findApprovalDecisionReceipt(userId: string, decisionId: string): Promise<SuiteRecord | undefined>;
  createRecord(userId: string, input: { moduleId: string; recordType: string; title: string; state?: string; data?: Record<string, unknown> }): Promise<SuiteRecord | undefined>;
  createPublicRecord(workspaceSlug: string, input: { id?: string; moduleId: string; recordType: string; title: string; state?: string; data?: Record<string, unknown> }): Promise<SuiteRecord | undefined>;
  listPublicRecords(workspaceSlug: string, input: { moduleId: string; recordType?: string; limit: number }): Promise<SuiteRecord[]>;
  recordPublicEvent(workspaceSlug: string, input: { moduleId: string; eventType: string; recordId?: string; payload?: Record<string, unknown> }): Promise<boolean>;
  listPublicWorkflowRecords(workspaceSlug: string, input: { moduleId: string; recordType: string; limit: number }): Promise<SuiteRecord[]>;
  updatePublicWorkflowRecord(workspaceSlug: string, recordId: string, input: { state?: string; data?: Record<string, unknown> }): Promise<SuiteRecord | undefined>;
  updateRecord(userId: string, recordId: string, input: { title?: string; state?: string; data?: Record<string, unknown> }): Promise<SuiteRecord | undefined>;
  queueAiAction(userId: string, input: { moduleId: string; goal: string; context?: Record<string, unknown> }): Promise<SuiteAiAction | undefined>;
  getAiAction(userId: string, actionId: string): Promise<SuiteAiAction | undefined>;
  claimAiAction(): Promise<{ action: SuiteAiAction; records: SuiteRecord[] } | undefined>;
  completeAiAction(actionId: string, result: { status: "completed" | "failed"; result: Record<string, unknown> }): Promise<boolean>;
  createApiToken(userId: string, input: { name: string; scopes: SuiteApiTokenScope[]; expiresAt: string }): Promise<SuiteApiTokenSecret>;
  listApiTokens(userId: string): Promise<SuiteApiTokenSummary[]>;
  revokeApiToken(userId: string, tokenId: string): Promise<boolean>;
  findApiTokenPrincipal(token: string): Promise<SuiteApiTokenPrincipal | undefined>;
  hostnameRegistry?: MemoryHostnameClaimRegistry;
  attachHostnameRegistry?(hostnameRegistry: MemoryHostnameClaimRegistry): void;
}

export const suiteCommandReceiptRecordTypes = [
  "command-receipt",
  "premium-command-receipt",
  "growth-command-receipt",
  "esign-command-receipt",
  "email-command-receipt",
  "additive-command-receipt",
  "extended-business-command-receipt",
] as const;
export type SuiteCommandReceiptRecordType = typeof suiteCommandReceiptRecordTypes[number];
const suiteCommandReceiptRecordTypeSet = new Set<string>(suiteCommandReceiptRecordTypes);

function commandReceiptLookupInput(input: { recordType: string; moduleId: string; actionId: string; idempotencyKey: string }) {
  if (!suiteCommandReceiptRecordTypeSet.has(input.recordType)
    || !input.moduleId.trim()
    || !input.actionId.trim()
    || !input.idempotencyKey.trim()) throw new Error("The command receipt lookup is invalid.");
  return input;
}

function approvalDecisionLookupValue(decisionId: string) {
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(decisionId)) throw new Error("The approval decision lookup is invalid.");
  return decisionId;
}

export interface SuiteCustomDomain {
  id: string;
  workspaceId: string;
  domain: string;
  status: "awaiting-dns" | "verified" | "active";
  ownership: HostnameOwnershipInstructions;
  lastCheckedAt?: string;
  createdAt: string;
}

function now() { return new Date().toISOString(); }

export class MemorySuiteStore implements SuiteStore {
  readonly persistence = "preview-memory" as const;
  private workspaces = new Map<string, SuiteWorkspace>();
  private memberships = new Map<string, { ownerUserId: string; role: SuiteWorkspaceRole; createdAt: string }>();
  private records = new Map<string, SuiteRecord>();
  private actions = new Map<string, SuiteAiAction>();
  private tokens = new Map<string, SuiteApiTokenSummary & { userId: string }>();
  private customDomains = new Map<string, SuiteCustomDomain>();
  private transactionTail: Promise<void> = Promise.resolve();
  private transactionContext = new AsyncLocalStorage<string>();
  hostnameRegistry: MemoryHostnameClaimRegistry;

  constructor(private readonly defaultPlan: SuitePlanId = configuredDefaultPlan, hostnameRegistry = new MemoryHostnameClaimRegistry()) {
    this.hostnameRegistry = hostnameRegistry;
  }

  attachHostnameRegistry(hostnameRegistry: MemoryHostnameClaimRegistry) {
    if (hostnameRegistry === this.hostnameRegistry) return;
    for (const domain of this.customDomains.values()) {
      const claim = this.hostnameRegistry.get(domain.domain);
      if (!claim || claim.id !== domain.ownership.claimId || claim.surface !== "suite" || claim.resourceId !== domain.workspaceId) throw new Error(`Suite hostname claim integrity failed for ${domain.domain}.`);
      hostnameRegistry.import(claim);
    }
    this.hostnameRegistry = hostnameRegistry;
  }

  async initialize() {}

  async runInWorkspaceTransaction<T>(userId: string, operation: (workspace: SuiteWorkspace) => Promise<T>): Promise<T> {
    const activeWorkspaceId = this.transactionContext.getStore();
    if (activeWorkspaceId) {
      const existing = this.baseWorkspace(userId);
      if (!existing || activeWorkspaceId !== existing.id) {
        throw new Error("A workspace transaction cannot cross tenant boundaries.");
      }
      return operation(this.workspaceFor(userId, existing));
    }
    const previous = this.transactionTail;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.transactionTail = tail;
    await previous;
    const snapshot = {
      workspaces: structuredClone(this.workspaces),
      memberships: structuredClone(this.memberships),
      records: structuredClone(this.records),
      actions: structuredClone(this.actions),
      tokens: structuredClone(this.tokens),
      customDomains: structuredClone(this.customDomains),
      hostnameClaims: this.hostnameRegistry.snapshot(),
    };
    try {
      const initial = await this.getOrCreateWorkspace(userId);
      return await this.transactionContext.run(
        initial.id,
        () => operation(initial),
      );
    }
    catch (error) {
      this.workspaces = snapshot.workspaces;
      this.memberships = snapshot.memberships;
      this.records = snapshot.records;
      this.actions = snapshot.actions;
      this.tokens = snapshot.tokens;
      this.customDomains = snapshot.customDomains;
      this.hostnameRegistry.restore(snapshot.hostnameClaims);
      throw error;
    }
    finally {
      release();
      if (this.transactionTail === tail) this.transactionTail = Promise.resolve();
    }
  }

  private baseWorkspace(userId: string) {
    const membership = this.memberships.get(userId);
    return membership ? this.workspaces.get(membership.ownerUserId) : undefined;
  }

  private roleCanWrite(userId: string) { return ["owner", "admin", "member"].includes(this.memberships.get(userId)?.role ?? ""); }
  private roleCanManage(userId: string) { return ["owner", "admin"].includes(this.memberships.get(userId)?.role ?? ""); }

  private workspaceFor(userId: string, workspace: SuiteWorkspace) {
    return { ...workspace, enabledModuleIds: [...workspace.enabledModuleIds], currentRole: this.memberships.get(userId)?.role };
  }

  async getOrCreateWorkspace(userId: string) {
    const existing = this.baseWorkspace(userId);
    if (existing) return this.workspaceFor(userId, existing);
    const createdAt = now();
    const workspace: SuiteWorkspace = { id: randomUUID(), userId, name: "My workspace", slug: `workspace-${userId.slice(0, 8)}`, plan: this.defaultPlan, enabledModuleIds: [], createdAt, updatedAt: createdAt };
    this.workspaces.set(userId, workspace);
    this.memberships.set(userId, { ownerUserId: userId, role: "owner", createdAt });
    return this.workspaceFor(userId, workspace);
  }

  async getWorkspaceBySlug(slug: string) { return [...this.workspaces.values()].find((workspace) => workspace.slug === slug); }

  async getWorkspaceByPublicId(workspaceId: string) {
    const workspace = [...this.workspaces.values()].find((candidate) => candidate.id === workspaceId);
    if (!workspace || (config.SUITE_ENTITLEMENT_MODE !== "unrestricted" && workspace.plan === "none")) return undefined;
    return this.workspaceFor(workspace.userId, workspace);
  }

  async listWorkspaceMembers(userId: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    return [...this.memberships.entries()]
      .filter(([, membership]) => this.workspaces.get(membership.ownerUserId)?.id === workspace.id)
      .map(([memberUserId, membership]) => ({ userId: memberUserId, role: membership.role, createdAt: membership.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addWorkspaceMember(userId: string, memberUserId: string, role: Exclude<SuiteWorkspaceRole, "owner">) {
    const workspace = await this.getOrCreateWorkspace(userId);
    if (!this.roleCanManage(userId) || this.memberships.has(memberUserId)) return undefined;
    const ownerUserId = workspace.userId;
    const member = { userId: memberUserId, role, createdAt: now() };
    this.memberships.set(memberUserId, { ownerUserId, role, createdAt: member.createdAt });
    return member;
  }

  async removeWorkspaceMember(userId: string, memberUserId: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    const target = this.memberships.get(memberUserId);
    if (!this.roleCanManage(userId) || !target || target.role === "owner" || this.workspaces.get(target.ownerUserId)?.id !== workspace.id) return false;
    this.memberships.delete(memberUserId);
    return true;
  }

  async getUsage(userId: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    const records = [...this.records.values()].filter((record) => record.workspaceId === workspace.id);
    const month = now().slice(0, 7);
    const quota = quotaForPlan(workspace.plan);
    const registrations = records.map((record) => suiteStorageObjectRegistration(record.moduleId, record.recordType, record.data)).filter((item) => item !== undefined);
    const registeredStorageBytes = registrations.reduce((sum, item) => sum + item.registeredBytes, 0);
    const verifiedStorageBytes = registrations.filter((item) => item.objectStoreVerified).reduce((sum, item) => sum + item.registeredBytes, 0);
    return {
      recordCount: records.length,
      recordLimit: quota.recordLimit,
      aiActionsThisMonth: [...this.actions.values()].filter((action) => action.workspaceId === workspace.id && action.createdAt.startsWith(month)).length,
      aiActionLimit: quota.aiActionLimit,
      registeredStorageBytes,
      verifiedStorageBytes,
      unverifiedStorageBytes: registeredStorageBytes - verifiedStorageBytes,
      retainedStorageObjectCount: registrations.length,
      storageLimitBytes: quota.storageLimitBytes,
      storageAccountingVersion: suiteStorageAccountingVersion,
      storageUsageAsOf: now(),
    };
  }

  async listCustomDomains(userId: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    return [...this.customDomains.values()].filter((item) => item.workspaceId === workspace.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addCustomDomain(userId: string, domain: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    if (!this.roleCanManage(userId) || (config.SUITE_ENTITLEMENT_MODE !== "unrestricted" && workspace.plan === "none")) return undefined;
    const claim = this.hostnameRegistry.claim({ hostname: domain, surface: "suite", ownerUserId: workspace.userId, resourceId: workspace.id }, platformHostnameSuffixes());
    if (!claim) return undefined;
    const item: SuiteCustomDomain = { id: randomUUID(), workspaceId: workspace.id, domain: claim.hostname, status: "awaiting-dns", ownership: hostnameOwnershipInstructions(claim, config.PUBLIC_HOST_TARGET), createdAt: now() };
    this.customDomains.set(claim.hostname, item);
    return item;
  }

  async setCustomDomainStatus(userId: string, domain: string, status: SuiteCustomDomain["status"]) {
    const workspace = await this.getOrCreateWorkspace(userId);
    const item = this.customDomains.get(domain);
    if (!this.roleCanManage(userId) || (config.SUITE_ENTITLEMENT_MODE !== "unrestricted" && workspace.plan === "none") || !item || item.workspaceId !== workspace.id) return undefined;
    const claimStatus = status === "awaiting-dns" ? "pending" : status;
    const claim = this.hostnameRegistry.setStatus({ hostname: domain, surface: "suite", ownerUserId: workspace.userId, resourceId: workspace.id }, claimStatus);
    if (!claim) return undefined;
    item.status = status;
    item.lastCheckedAt = claim.lastCheckedAt;
    return item;
  }

  async getWorkspaceByCustomDomain(domain: string) {
    const item = this.customDomains.get(domain);
    const claim = item ? this.hostnameRegistry.get(item.domain) : undefined;
    if (!item || !claim || claim.id !== item.ownership.claimId || claim.surface !== "suite" || claim.resourceId !== item.workspaceId || !["verified", "active"].includes(item.status) || !["verified", "active"].includes(claim.status)) return undefined;
    return [...this.workspaces.values()].find((workspace) => workspace.id === item.workspaceId && (config.SUITE_ENTITLEMENT_MODE === "unrestricted" || workspace.plan !== "none"));
  }

  async listActiveCustomDomains() {
    return [...this.customDomains.values()]
      .filter((item) => ["verified", "active"].includes(item.status) && [...this.workspaces.values()].some((workspace) => workspace.id === item.workspaceId && (config.SUITE_ENTITLEMENT_MODE === "unrestricted" || workspace.plan !== "none")))
      .filter((item) => { const claim = this.hostnameRegistry.get(item.domain); return claim?.id === item.ownership.claimId && claim.surface === "suite" && claim.resourceId === item.workspaceId && ["verified", "active"].includes(claim.status); })
      .map((item) => item.domain)
      .sort();
  }

  async setWorkspacePlan(userId: string, plan: SuitePlanId) {
    await this.getOrCreateWorkspace(userId);
    const workspace = this.baseWorkspace(userId)!;
    if (this.memberships.get(userId)?.role !== "owner") return undefined;
    workspace.plan = plan;
    workspace.updatedAt = now();
    for (const action of this.actions.values()) {
      const module = suiteModuleById.get(action.moduleId);
      if (action.workspaceId !== workspace.id || !["queued", "running"].includes(action.status) || !module || suitePlanAllows(plan, module)) continue;
      action.status = "failed";
      action.result = { error: "The workspace plan changed before this AI action ran.", retryable: false };
      action.lastError = "Workspace entitlement revoked.";
      action.leaseExpiresAt = undefined;
      action.updatedAt = now();
    }
    return this.workspaceFor(userId, workspace);
  }

  async enableModule(userId: string, moduleId: string) {
    await this.getOrCreateWorkspace(userId);
    const workspace = this.baseWorkspace(userId)!;
    if (!this.roleCanManage(userId) || !planAllows(workspace.plan, moduleId)) return undefined;
    if (!workspace.enabledModuleIds.includes(moduleId)) workspace.enabledModuleIds.push(moduleId);
    workspace.updatedAt = now();
    return this.workspaceFor(userId, workspace);
  }

  async listRecords(userId: string, input: { moduleId?: string; recordType?: string; limit: number }) {
    const workspace = await this.getOrCreateWorkspace(userId);
    const role = this.memberships.get(userId)?.role;
    const trustedTransaction = this.transactionContext.getStore() === workspace.id;
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspace.id && (!input.moduleId || record.moduleId === input.moduleId) && (!input.recordType || record.recordType === input.recordType))
      .filter((record) => trustedTransaction || Boolean(role && canReadSuiteRecord({ userId, workspaceId: workspace.id, role }, record)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, input.limit);
  }

  async findSignerSessionByTokenHash(userId: string, tokenHash: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    const matches = [...this.records.values()].filter((record) => record.workspaceId === workspace.id && record.moduleId === "esign" && record.recordType === "signer-session" && record.data.tokenHash === tokenHash);
    if (matches.length > 1) throw new Error("Signer session token hash integrity failed.");
    return matches[0];
  }

  async getRecord(userId: string, recordId: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    const record = this.records.get(recordId);
    if (!record || record.workspaceId !== workspace.id) return undefined;
    if (this.transactionContext.getStore() === workspace.id) return record;
    const role = this.memberships.get(userId)?.role;
    return role && canReadSuiteRecord({ userId, workspaceId: workspace.id, role }, record) ? record : undefined;
  }

  async findCommandReceipt(userId: string, input: { recordType: SuiteCommandReceiptRecordType; moduleId: string; actionId: string; idempotencyKey: string }) {
    commandReceiptLookupInput(input);
    const workspace = await this.getOrCreateWorkspace(userId);
    const matches = [...this.records.values()].filter((record) => record.workspaceId === workspace.id
      && record.recordType === input.recordType
      && record.moduleId === input.moduleId
      && record.data.actionId === input.actionId
      && record.data.idempotencyKey === input.idempotencyKey);
    if (matches.length > 1) throw new Error("The workspace contains duplicate command idempotency receipts.");
    return matches[0];
  }

  async findApprovalDecisionReceipt(userId: string, decisionId: string) {
    approvalDecisionLookupValue(decisionId);
    const workspace = await this.getOrCreateWorkspace(userId);
    return [...this.records.values()].find((record) => record.workspaceId === workspace.id
      && suiteCommandReceiptRecordTypeSet.has(record.recordType)
      && record.data.approvalDecisionId === decisionId);
  }

  async createRecord(userId: string, input: { moduleId: string; recordType: string; title: string; state?: string; data?: Record<string, unknown> }) {
    recordPayloadBytes(input.data);
    return this.runInWorkspaceTransaction(userId, async (workspace) => {
      if (!this.roleCanWrite(userId) || !workspace.enabledModuleIds.includes(input.moduleId) || !planAllows(workspace.plan, input.moduleId)) return undefined;
      const usage = await this.getUsage(userId);
      const objectBytes = suiteRegisteredObjectBytes(input.moduleId, input.recordType, input.data ?? {});
      if (usage.recordCount >= usage.recordLimit) throw new Error("This workspace reached its record quota. Upgrade the server plan to continue.");
      if (usage.registeredStorageBytes + objectBytes > usage.storageLimitBytes) throw new Error("This workspace reached its registered storage quota. Upgrade the server plan or remove files.");
      const createdAt = now();
      const record: SuiteRecord = { id: randomUUID(), workspaceId: workspace.id, moduleId: input.moduleId, recordType: input.recordType, title: input.title, state: input.state ?? "active", data: input.data ?? {}, createdAt, updatedAt: createdAt };
      this.records.set(record.id, record);
      return record;
    });
  }

  async createPublicRecord(workspaceSlug: string, input: { id?: string; moduleId: string; recordType: string; title: string; state?: string; data?: Record<string, unknown> }) {
    const workspace = await this.getWorkspaceBySlug(workspaceSlug);
    if (!workspace || !workspace.enabledModuleIds.includes(input.moduleId) || !planAllows(workspace.plan, input.moduleId)) return undefined;
    recordPayloadBytes(input.data);
    return this.runInWorkspaceTransaction(workspace.userId, async (lockedWorkspace) => {
      const records = [...this.records.values()].filter((record) => record.workspaceId === lockedWorkspace.id);
      const publicIdempotencyHash = input.moduleId === "consent" && input.recordType === "consent-receipt" ? input.data?.publicIdempotencyHash : undefined;
      if (typeof publicIdempotencyHash === "string" && records.some((record) => record.moduleId === "consent" && record.recordType === "consent-receipt" && record.data.publicIdempotencyHash === publicIdempotencyHash)) throw new Error("This public consent idempotency key already has a receipt.");
      const usage = await this.getUsage(workspace.userId);
      if (usage.recordCount >= usage.recordLimit) throw new Error("This workspace is not accepting more submissions.");
      if (usage.registeredStorageBytes + suiteRegisteredObjectBytes(input.moduleId, input.recordType, input.data ?? {}) > usage.storageLimitBytes) throw new Error("This workspace is not accepting more object storage.");
      const createdAt = now();
      const recordId = input.id ?? randomUUID();
      if (!/^[0-9a-f-]{36}$/i.test(recordId) || this.records.has(recordId)) throw new Error("The public record ID is invalid or already exists.");
      const record: SuiteRecord = { id: recordId, workspaceId: lockedWorkspace.id, moduleId: input.moduleId, recordType: input.recordType, title: input.title, state: input.state ?? "active", data: input.data ?? {}, createdAt, updatedAt: createdAt };
      this.records.set(record.id, record);
      return record;
    });
  }

  async listPublicRecords(workspaceSlug: string, input: { moduleId: string; recordType?: string; limit: number }) {
    const workspace = await this.getWorkspaceBySlug(workspaceSlug);
    if (!workspace || !planAllows(workspace.plan, input.moduleId)) return [];
    return [...this.records.values()].filter((record) => record.workspaceId === workspace.id && record.moduleId === input.moduleId && (!input.recordType || record.recordType === input.recordType) && record.data.public === true).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, input.limit);
  }

  async recordPublicEvent(workspaceSlug: string, input: { moduleId: string; eventType: string; recordId?: string; payload?: Record<string, unknown> }) {
    const workspace = await this.getWorkspaceBySlug(workspaceSlug);
    return Boolean(workspace?.enabledModuleIds.includes(input.moduleId) && planAllows(workspace.plan, input.moduleId));
  }

  async listPublicWorkflowRecords(workspaceSlug: string, input: { moduleId: string; recordType: string; limit: number }) {
    const workspace = await this.getWorkspaceBySlug(workspaceSlug);
    if (!workspace?.enabledModuleIds.includes(input.moduleId) || !planAllows(workspace.plan, input.moduleId)) return [];
    return [...this.records.values()].filter((record) => record.workspaceId === workspace.id && record.moduleId === input.moduleId && record.recordType === input.recordType).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, input.limit);
  }

  async updatePublicWorkflowRecord(workspaceSlug: string, recordId: string, input: { state?: string; data?: Record<string, unknown> }) {
    const workspace = await this.getWorkspaceBySlug(workspaceSlug);
    if (!workspace) return undefined;
    return this.runInWorkspaceTransaction(workspace.userId, async (lockedWorkspace) => {
      const record = this.records.get(recordId);
      if (!record || record.workspaceId !== lockedWorkspace.id || !lockedWorkspace.enabledModuleIds.includes(record.moduleId) || !planAllows(lockedWorkspace.plan, record.moduleId)) return undefined;
      const nextState = input.state ?? record.state;
      const nextData = input.data === undefined ? record.data : { ...record.data, ...input.data };
      recordPayloadBytes(nextData);
      const bytes = assertSuiteStorageObjectUpdate({ moduleId: record.moduleId, recordType: record.recordType, priorTitle: record.title, priorState: record.state, priorData: record.data, nextTitle: record.title, nextState, nextData });
      const usage = await this.getUsage(workspace.userId);
      if (usage.registeredStorageBytes - bytes.priorBytes + bytes.nextBytes > usage.storageLimitBytes) throw new Error("This workspace is not accepting more object storage.");
      record.state = nextState;
      record.data = nextData;
      record.updatedAt = now();
      return record;
    });
  }

  async updateRecord(userId: string, recordId: string, input: { title?: string; state?: string; data?: Record<string, unknown> }) {
    return this.runInWorkspaceTransaction(userId, async (workspace) => {
      const record = this.records.get(recordId);
      if (!this.roleCanWrite(userId) || !record || record.workspaceId !== workspace.id || !planAllows(workspace.plan, record.moduleId)) return undefined;
      const nextTitle = input.title ?? record.title;
      const nextState = input.state ?? record.state;
      const nextData = input.data === undefined ? record.data : { ...record.data, ...input.data };
      recordPayloadBytes(nextData);
      const bytes = assertSuiteStorageObjectUpdate({ moduleId: record.moduleId, recordType: record.recordType, priorTitle: record.title, priorState: record.state, priorData: record.data, nextTitle, nextState, nextData });
      const usage = await this.getUsage(userId);
      if (usage.registeredStorageBytes - bytes.priorBytes + bytes.nextBytes > usage.storageLimitBytes) throw new Error("This workspace reached its registered storage quota. Upgrade the server plan or remove files.");
      record.title = nextTitle;
      record.state = nextState;
      record.data = nextData;
      record.updatedAt = now();
      return record;
    });
  }

  async queueAiAction(userId: string, input: { moduleId: string; goal: string; context?: Record<string, unknown> }) {
    const workspace = await this.getOrCreateWorkspace(userId);
    if (!this.roleCanWrite(userId) || !workspace.enabledModuleIds.includes(input.moduleId) || !planAllows(workspace.plan, input.moduleId)) return undefined;
    const context = { ...(input.context ?? {}), requestedByUserId: userId };
    recordPayloadBytes(context);
    const usage = await this.getUsage(userId);
    if (usage.aiActionsThisMonth >= usage.aiActionLimit) throw new Error("This workspace reached its monthly AI action quota. Upgrade the server plan or wait for the next billing month.");
    const createdAt = now();
    const action: SuiteAiAction = { id: randomUUID(), workspaceId: workspace.id, moduleId: input.moduleId, goal: input.goal, context, status: "queued", createdAt, updatedAt: createdAt };
    this.actions.set(action.id, action);
    return action;
  }

  async getAiAction(userId: string, actionId: string) {
    const workspace = await this.getOrCreateWorkspace(userId);
    const action = this.actions.get(actionId);
    if (!action || action.workspaceId !== workspace.id) return undefined;
    if (this.transactionContext.getStore() === workspace.id) return action;
    const role = this.memberships.get(userId)?.role;
    return role === "owner" || role === "admin" || action.context.requestedByUserId === userId ? action : undefined;
  }

  async claimAiAction() {
    const current = now();
    for (const item of this.actions.values()) {
      const workspace = [...this.workspaces.values()].find((candidate) => candidate.id === item.workspaceId);
      if (["queued", "running"].includes(item.status) && workspace && !planAllows(workspace.plan, item.moduleId)) {
        item.status = "failed";
        item.lastError = "Workspace entitlement revoked.";
        item.result = { error: "The workspace plan changed before this AI action ran.", retryable: false };
        item.leaseExpiresAt = undefined;
        item.updatedAt = current;
        continue;
      }
      if (item.status === "running" && item.leaseExpiresAt && item.leaseExpiresAt < current && (item.attempts ?? 0) >= 3) {
        item.status = "failed";
        item.lastError = "The AI action exhausted its retry limit after its worker lease expired.";
        item.result = { error: item.lastError, retryable: false };
        item.leaseExpiresAt = undefined;
        item.updatedAt = current;
      }
    }
    const action = [...this.actions.values()].filter((item) => (item.status === "queued" || (item.status === "running" && Boolean(item.leaseExpiresAt && item.leaseExpiresAt < current))) && (item.attempts ?? 0) < 3).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!action) return undefined;
    action.status = "running";
    action.attempts = (action.attempts ?? 0) + 1;
    action.leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    action.updatedAt = now();
    const selectedIds = aiSelectedRecordIds(action.context);
    const allowedModules = new Set(suiteAiReadScopes(action.moduleId, { explicitSelection: selectedIds.length > 0 }));
    const selected = new Set(selectedIds);
    const records = [...this.records.values()]
      .filter((record) => record.workspaceId === action.workspaceId && allowedModules.has(record.moduleId) && (!selected.size || selected.has(record.id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, selected.size ? 1_000 : 100);
    const bindings = assistantEvidenceBindings(action);
    if (bindings.length) {
      const actionWorkspace = [...this.workspaces.values()].find((workspace) => workspace.id === action.workspaceId);
      const evidenceIds = new Set(Array.isArray(action.context.evidenceIds) ? action.context.evidenceIds.filter((value): value is string => typeof value === "string") : []);
      for (const binding of bindings) {
        const attachment = this.records.get(binding.attachmentRecordId);
        if (!attachment || attachment.workspaceId !== action.workspaceId || !assistantAttachmentMatches(binding, attachment)) continue;
        const source = this.records.get(binding.sourceRecordId);
        if (!source || source.workspaceId !== action.workspaceId || !actionWorkspace?.enabledModuleIds.includes(source.moduleId) || !assistantSourceMatches(binding, source, evidenceIds)) continue;
        records.push(attachment, source);
      }
    }
    const requestedByUserId = typeof action.context.requestedByUserId === "string" ? action.context.requestedByUserId : undefined;
    const requesterWorkspace = requestedByUserId ? this.baseWorkspace(requestedByUserId) : undefined;
    const requesterRole = requestedByUserId ? this.memberships.get(requestedByUserId)?.role : undefined;
    const exactRecords = [...new Map(records.map((record) => [record.id, record])).values()]
      .filter((record) => Boolean(requestedByUserId && requesterRole && requesterWorkspace?.id === action.workspaceId && canReadSuiteRecord({ userId: requestedByUserId, workspaceId: action.workspaceId, role: requesterRole }, record)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 1_000);
    return { action, records: exactRecords };
  }

  async completeAiAction(actionId: string, result: { status: "completed" | "failed"; result: Record<string, unknown> }) {
    const action = this.actions.get(actionId);
    if (!action || action.status !== "running") return false;
    const contractVersion = action.context.resultContract && typeof action.context.resultContract === "object" && !Array.isArray(action.context.resultContract)
      ? (action.context.resultContract as Record<string, unknown>).version
      : undefined;
    if (contractVersion === "additive-business-proposal.v1" || contractVersion === "extended-business-proposal.v1") {
      const workspace = [...this.workspaces.values()].find((candidate) => candidate.id === action.workspaceId);
      if (!workspace) throw new Error("Proposal-only AI workspace missing.");
      return this.runInWorkspaceTransaction(workspace.userId, async () => {
        const currentAction = this.actions.get(actionId);
        if (!currentAction || currentAction.status !== "running") return false;
        const auditId = contractVersion === "additive-business-proposal.v1" ? currentAction.context.requestRecordId : currentAction.context.aiAuditRecordId;
        const auditRecord = typeof auditId === "string" ? this.records.get(auditId) : undefined;
        if (!auditRecord) throw new Error("The proposal-only audit record is missing.");
        const selectedRecords = aiSelectedRecordIds(currentAction.context).flatMap((recordId) => {
          const record = this.records.get(recordId);
          return record ? [record] : [];
        });
        if (result.status === "completed") validateProposalOnlyAiJob(currentAction, selectedRecords, config.AI_MODEL);
        const transitionedAt = now();
        const transitionedAudit = transitionProposalOnlyAiAuditRecord(currentAction, selectedRecords, result, transitionedAt);
        recordPayloadBytes(transitionedAudit.data);
        currentAction.status = result.status;
        currentAction.result = result.result;
        currentAction.lastError = result.status === "failed" && typeof result.result.error === "string" ? result.result.error : undefined;
        currentAction.leaseExpiresAt = undefined;
        currentAction.updatedAt = transitionedAt;
        this.records.set(transitionedAudit.id, transitionedAudit);
        return true;
      });
    }
    action.status = result.status;
    action.result = result.result;
    action.lastError = result.status === "failed" && typeof result.result.error === "string" ? result.result.error : undefined;
    action.leaseExpiresAt = undefined;
    action.updatedAt = now();
    return true;
  }

  async createApiToken(userId: string, input: { name: string; scopes: SuiteApiTokenScope[]; expiresAt: string }) {
    await this.getOrCreateWorkspace(userId);
    if (!this.roleCanWrite(userId) && input.scopes.some((scope) => scope !== "read")) throw new Error("Viewer tokens may only use the read scope.");
    const token = `sup_${randomBytes(32).toString("base64url")}`;
    const createdAt = now();
    const item = { id: randomUUID(), userId, name: input.name, scopes: [...input.scopes], expiresAt: input.expiresAt, createdAt };
    this.tokens.set(tokenHash(token), item);
    return { id: item.id, name: item.name, scopes: [...item.scopes], token, createdAt, expiresAt: item.expiresAt };
  }

  async listApiTokens(userId: string) {
    return [...this.tokens.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ userId: _userId, ...item }) => ({ ...item, scopes: [...item.scopes] }));
  }

  async revokeApiToken(userId: string, tokenId: string) {
    const item = [...this.tokens.values()].find((candidate) => candidate.id === tokenId && candidate.userId === userId);
    if (!item) return false;
    item.revokedAt ??= now();
    return true;
  }

  async findApiTokenPrincipal(token: string) {
    const item = this.tokens.get(tokenHash(token));
    if (!item || item.revokedAt || new Date(item.expiresAt).getTime() <= Date.now()) return undefined;
    item.lastUsedAt = now();
    return { tokenId: item.id, userId: item.userId, scopes: [...item.scopes] };
  }
}

type DbRow = Record<string, unknown>;

export class PostgresSuiteStore implements SuiteStore {
  readonly persistence = "postgres" as const;
  private pool: pg.Pool;
  private transactionContext = new AsyncLocalStorage<pg.PoolClient>();

  constructor(connectionString = config.DATABASE_RUNTIME_URL ?? config.DATABASE_URL, ssl = config.DATABASE_SSL === "true") {
    this.pool = new pg.Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined, max: 5 });
  }

  async close() { await this.pool.end(); }

  async initialize() {
    await ensureDatabaseMigrations(this.pool);
  }

  private workspace(row: DbRow, enabledModuleIds: string[] = []): SuiteWorkspace {
    return {
      id: String(row.id), userId: String(row.user_id), name: String(row.name), slug: String(row.slug), plan: String(row.plan) as SuitePlanId,
      enabledModuleIds, currentRole: row.current_role ? String(row.current_role) as SuiteWorkspaceRole : undefined,
      createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at),
    };
  }

  private record(row: DbRow): SuiteRecord {
    return {
      id: String(row.id), workspaceId: String(row.workspace_id), moduleId: String(row.module_id), recordType: String(row.record_type), title: String(row.title), state: String(row.state),
      data: (row.data ?? {}) as Record<string, unknown>, createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at),
    };
  }

  private apiToken(row: DbRow): SuiteApiTokenSummary {
    const scopes = Array.isArray(row.scopes)
      ? row.scopes.filter((scope: unknown): scope is SuiteApiTokenScope => typeof scope === "string" && suiteApiTokenScopes.includes(scope as SuiteApiTokenScope))
      : [];
    return {
      id: String(row.id),
      name: String(row.name),
      scopes,
      createdAt: databaseTimestampIso(row.created_at),
      expiresAt: databaseTimestampIso(row.expires_at),
      lastUsedAt: row.last_used_at ? databaseTimestampIso(row.last_used_at) : undefined,
      revokedAt: row.revoked_at ? databaseTimestampIso(row.revoked_at) : undefined,
    };
  }

  private customDomain(row: DbRow): SuiteCustomDomain {
    const claim = hostnameClaimFromRow(row);
    return { id: String(row.id), workspaceId: String(row.workspace_id), domain: String(row.domain), status: String(row.status) as SuiteCustomDomain["status"], ownership: hostnameOwnershipInstructions(claim, config.PUBLIC_HOST_TARGET), lastCheckedAt: row.last_checked_at ? databaseTimestampIso(row.last_checked_at) : undefined, createdAt: databaseTimestampIso(row.created_at) };
  }

  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>) {
    const activeClient = this.transactionContext.getStore();
    if (activeClient) return operation(activeClient);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async runInWorkspaceTransaction<T>(userId: string, operation: (workspace: SuiteWorkspace) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      const context = await client.query("SELECT * FROM managed_oss_workspace_context_for_user($1,$2)", [userId, configuredDefaultPlan]);
      const row = context.rows[0];
      if (!row) throw new Error("The authenticated user does not have a suite workspace.");
      const workspaceId = String(row.workspace_id);
      await this.setWorkspaceContext(client, workspaceId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspaceMutationLockKey(workspaceId)]);
      const workspace = await this.loadWorkspace(client, workspaceId, String(row.member_role) as SuiteWorkspaceRole);
      if (!workspace) throw new Error("The authenticated suite workspace no longer exists.");
      return this.transactionContext.run(client, () => operation(workspace));
    });
  }

  private async setWorkspaceContext(client: pg.PoolClient, workspaceId: string) {
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
  }

  private async loadWorkspace(client: pg.PoolClient, workspaceId: string, currentRole?: SuiteWorkspaceRole) {
    const result = await client.query("SELECT *, $2::TEXT AS current_role FROM suite_workspaces WHERE id=$1", [workspaceId, currentRole ?? null]);
    if (!result.rows[0]) return undefined;
    const modules = await client.query("SELECT module_id FROM suite_workspace_modules WHERE workspace_id=$1 ORDER BY enabled_at", [workspaceId]);
    return this.workspace(result.rows[0], modules.rows.map((row) => String(row.module_id)));
  }

  private async withUserWorkspace<T>(userId: string, operation: (client: pg.PoolClient, workspace: SuiteWorkspace) => Promise<T>) {
    return this.transaction(async (client) => {
      const context = await client.query("SELECT * FROM managed_oss_workspace_context_for_user($1,$2)", [userId, configuredDefaultPlan]);
      const row = context.rows[0];
      if (!row) throw new Error("The authenticated user does not have a suite workspace.");
      const workspaceId = String(row.workspace_id);
      await this.setWorkspaceContext(client, workspaceId);
      const workspace = await this.loadWorkspace(client, workspaceId, String(row.member_role) as SuiteWorkspaceRole);
      if (!workspace) throw new Error("The authenticated suite workspace no longer exists.");
      return operation(client, workspace);
    });
  }

  private async withPublicWorkspace<T>(slug: string, operation: (client: pg.PoolClient, workspace: SuiteWorkspace) => Promise<T>, missing: T) {
    return this.transaction(async (client) => {
      const context = await client.query("SELECT * FROM managed_oss_public_workspace_context($1,$2)", [slug, config.SUITE_ENTITLEMENT_MODE === "unrestricted"]);
      const row = context.rows[0];
      if (!row) return missing;
      const workspaceId = String(row.workspace_id);
      await this.setWorkspaceContext(client, workspaceId);
      const workspace = await this.loadWorkspace(client, workspaceId);
      return workspace ? operation(client, workspace) : missing;
    });
  }

  async getOrCreateWorkspace(userId: string) {
    return this.withUserWorkspace(userId, async (_client, workspace) => workspace);
  }

  async getWorkspaceBySlug(slug: string) {
    return this.transaction(async (client) => {
      const context = await client.query("SELECT * FROM managed_oss_public_workspace_context($1,TRUE)", [slug]);
      if (!context.rows[0]) return undefined;
      const workspaceId = String(context.rows[0].workspace_id);
      await this.setWorkspaceContext(client, workspaceId);
      return this.loadWorkspace(client, workspaceId);
    });
  }

  async getWorkspaceByPublicId(workspaceId: string) {
    return this.transaction(async (client) => {
      const context = await client.query("SELECT * FROM managed_oss_public_workspace_context_by_id($1,$2)", [workspaceId, config.SUITE_ENTITLEMENT_MODE === "unrestricted"]);
      if (!context.rows[0]) return undefined;
      const resolvedWorkspaceId = String(context.rows[0].workspace_id);
      await this.setWorkspaceContext(client, resolvedWorkspaceId);
      return this.loadWorkspace(client, resolvedWorkspaceId);
    });
  }

  async listWorkspaceMembers(userId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT user_id,role,created_at FROM suite_workspace_members WHERE workspace_id=$1 ORDER BY created_at", [workspace.id]);
      return result.rows.map((row) => ({ userId: String(row.user_id), role: String(row.role) as SuiteWorkspaceRole, createdAt: databaseTimestampIso(row.created_at) }));
    });
  }

  async addWorkspaceMember(userId: string, memberUserId: string, role: Exclude<SuiteWorkspaceRole, "owner">) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canManageRole(workspace.currentRole)) return undefined;
      const result = await client.query("INSERT INTO suite_workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING RETURNING user_id,role,created_at", [workspace.id, memberUserId, role]);
      const row = result.rows[0];
      return row ? { userId: String(row.user_id), role: String(row.role) as SuiteWorkspaceRole, createdAt: databaseTimestampIso(row.created_at) } : undefined;
    });
  }

  async removeWorkspaceMember(userId: string, memberUserId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canManageRole(workspace.currentRole)) return false;
      const result = await client.query("DELETE FROM suite_workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner' RETURNING user_id", [workspace.id, memberUserId]);
      return result.rowCount === 1;
    });
  }

  async getUsage(userId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const quota = quotaForPlan(workspace.plan);
      const records = await client.query("SELECT COUNT(*)::BIGINT AS record_count FROM suite_records WHERE workspace_id=$1", [workspace.id]);
      const storage = await client.query("SELECT COUNT(*)::BIGINT AS object_count,COALESCE(SUM(size_bytes),0)::BIGINT AS storage_bytes,COALESCE(SUM(size_bytes) FILTER (WHERE object_store_verified),0)::BIGINT AS verified_bytes,clock_timestamp() AS usage_as_of FROM suite_storage_objects WHERE workspace_id=$1 AND accounting_state='retained'", [workspace.id]);
      const actions = await client.query("SELECT COUNT(*)::BIGINT AS action_count FROM suite_ai_actions WHERE workspace_id=$1 AND created_at>=date_trunc('month',NOW())", [workspace.id]);
      const registeredStorageBytes = Number(storage.rows[0].storage_bytes);
      const verifiedStorageBytes = Number(storage.rows[0].verified_bytes);
      return {
        recordCount: Number(records.rows[0].record_count), recordLimit: quota.recordLimit,
        aiActionsThisMonth: Number(actions.rows[0].action_count), aiActionLimit: quota.aiActionLimit,
        registeredStorageBytes,
        verifiedStorageBytes,
        unverifiedStorageBytes: registeredStorageBytes - verifiedStorageBytes,
        retainedStorageObjectCount: Number(storage.rows[0].object_count),
        storageLimitBytes: quota.storageLimitBytes,
        storageAccountingVersion: suiteStorageAccountingVersion,
        storageUsageAsOf: databaseTimestampIso(storage.rows[0].usage_as_of),
      };
    });
  }

  async listCustomDomains(userId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT d.*,c.id claim_id,c.hostname claim_hostname,c.surface claim_surface,c.owner_user_id claim_owner_user_id,c.resource_id claim_resource_id,c.challenge_token,c.status claim_status,c.created_at claim_created_at,c.last_checked_at claim_last_checked_at,c.verified_at,c.tombstoned_at FROM suite_custom_domains d JOIN global_hostname_claims c ON c.id=d.hostname_claim_id WHERE d.workspace_id=$1 ORDER BY d.created_at", [workspace.id]);
      return result.rows.map((row) => this.customDomain(row));
    });
  }

  async addCustomDomain(userId: string, domain: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canManageRole(workspace.currentRole) || (config.SUITE_ENTITLEMENT_MODE !== "unrestricted" && workspace.plan === "none")) return undefined;
      const claim = newHostnameClaim({ hostname: domain, surface: "suite", ownerUserId: workspace.userId, resourceId: workspace.id }, platformHostnameSuffixes());
      const insertedClaim = await insertPostgresHostnameClaim(client, claim);
      if (!insertedClaim) return undefined;
      const result = await client.query("INSERT INTO suite_custom_domains(id,workspace_id,domain,hostname_claim_id) VALUES($1,$2,$3,$4) RETURNING *", [randomUUID(), workspace.id, claim.hostname, claim.id]);
      return this.customDomain({ ...result.rows[0], claim_id: claim.id, claim_hostname: claim.hostname, claim_surface: claim.surface, claim_owner_user_id: claim.ownerUserId, claim_resource_id: claim.resourceId, challenge_token: claim.challengeToken, claim_status: claim.status, claim_created_at: claim.createdAt });
    });
  }

  async setCustomDomainStatus(userId: string, domain: string, status: SuiteCustomDomain["status"]) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canManageRole(workspace.currentRole) || (config.SUITE_ENTITLEMENT_MODE !== "unrestricted" && workspace.plan === "none")) return undefined;
      const target = await client.query("SELECT id,hostname_claim_id FROM suite_custom_domains WHERE workspace_id=$1 AND domain=$2 FOR UPDATE", [workspace.id, domain]);
      if (!target.rows[0]) return undefined;
      const claimStatus = status === "awaiting-dns" ? "pending" : status;
      const claim = await updatePostgresHostnameClaimStatus(client, { hostname: domain, surface: "suite", ownerUserId: workspace.userId, resourceId: workspace.id }, claimStatus);
      if (!claim || claim.id !== String(target.rows[0].hostname_claim_id)) return undefined;
      const result = await client.query("UPDATE suite_custom_domains SET status=$3,last_checked_at=NOW() WHERE workspace_id=$1 AND domain=$2 AND hostname_claim_id=$4 RETURNING *", [workspace.id, domain, status, claim.id]);
      return result.rows[0] ? this.customDomain({ ...result.rows[0], claim_id: claim.id, claim_hostname: claim.hostname, claim_surface: claim.surface, claim_owner_user_id: claim.ownerUserId, claim_resource_id: claim.resourceId, challenge_token: claim.challengeToken, claim_status: claim.status, claim_created_at: claim.createdAt, claim_last_checked_at: claim.lastCheckedAt, verified_at: claim.verifiedAt, tombstoned_at: claim.tombstonedAt }) : undefined;
    });
  }

  async getWorkspaceByCustomDomain(domain: string) {
    return this.transaction(async (client) => {
      const context = await client.query("SELECT * FROM managed_oss_custom_domain_workspace_context($1,$2)", [domain, config.SUITE_ENTITLEMENT_MODE === "unrestricted"]);
      if (!context.rows[0]) return undefined;
      const workspaceId = String(context.rows[0].workspace_id);
      await this.setWorkspaceContext(client, workspaceId);
      return this.loadWorkspace(client, workspaceId);
    });
  }

  async listActiveCustomDomains() {
    return this.transaction(async (client) => {
      const result = await client.query("SELECT domain FROM managed_oss_list_active_suite_domains($1)", [config.SUITE_ENTITLEMENT_MODE === "unrestricted"]);
      return result.rows.map((row) => String(row.domain));
    });
  }

  async setWorkspacePlan(userId: string, plan: SuitePlanId) {
    return this.withUserWorkspace(userId, async (client, current) => {
      if (current.currentRole !== "owner") return undefined;
      const result = await client.query("UPDATE suite_workspaces SET plan=$2,updated_at=NOW() WHERE id=$1 RETURNING *, 'owner'::TEXT AS current_role", [current.id, plan]);
      if (!result.rows[0]) return undefined;
      const allowedModules = suiteModules.filter((module) => suitePlanAllows(plan, module)).map((module) => module.id);
      await client.query("UPDATE suite_ai_actions SET status='failed',result=jsonb_build_object('error','The workspace plan changed before this AI action ran.','retryable',false),last_error='Workspace entitlement revoked.',lease_expires_at=NULL,updated_at=NOW() WHERE workspace_id=$1 AND status IN ('queued','running') AND NOT (module_id=ANY($2::TEXT[]))", [current.id, allowedModules]);
      const modules = await client.query("SELECT module_id FROM suite_workspace_modules WHERE workspace_id=$1 ORDER BY enabled_at", [result.rows[0].id]);
      return this.workspace(result.rows[0], modules.rows.map((row) => String(row.module_id)));
    });
  }

  async enableModule(userId: string, moduleId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canManageRole(workspace.currentRole) || !planAllows(workspace.plan, moduleId)) return undefined;
      await client.query("INSERT INTO suite_workspace_modules(workspace_id,module_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [workspace.id, moduleId]);
      await client.query("INSERT INTO suite_events(id,workspace_id,module_id,event_type,payload) VALUES($1,$2,$3,'module.enabled',$4)", [randomUUID(), workspace.id, moduleId, JSON.stringify({ moduleId })]);
      return this.loadWorkspace(client, workspace.id, workspace.currentRole);
    });
  }

  async listRecords(userId: string, input: { moduleId?: string; recordType?: string; limit: number }) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (input.limit <= 0) return [];
      const trustedTransaction = Boolean(this.transactionContext.getStore());
      const role = workspace.currentRole;
      if (trustedTransaction || role === "owner" || role === "admin") {
        const values: unknown[] = [workspace.id, input.limit];
        const filters = ["r.workspace_id=$1"];
        if (input.moduleId) { values.push(input.moduleId); filters.push(`r.module_id=$${values.length}`); }
        if (input.recordType) { values.push(input.recordType); filters.push(`r.record_type=$${values.length}`); }
        const result = await client.query(`SELECT r.* FROM suite_records r WHERE ${filters.join(" AND ")} ORDER BY r.updated_at DESC,r.id DESC LIMIT $2`, values);
        return result.rows.map((row) => this.record(row));
      }
      if (!role) return [];

      const visible: SuiteRecord[] = [];
      const pageSize = Math.min(500, Math.max(100, input.limit));
      let cursor: { updatedAt: unknown; id: string } | undefined;
      while (visible.length < input.limit) {
        const values: unknown[] = [workspace.id, pageSize];
        const filters = ["r.workspace_id=$1"];
        if (input.moduleId) { values.push(input.moduleId); filters.push(`r.module_id=$${values.length}`); }
        if (input.recordType) { values.push(input.recordType); filters.push(`r.record_type=$${values.length}`); }
        if (cursor) {
          values.push(cursor.updatedAt);
          const updatedAtParameter = values.length;
          values.push(cursor.id);
          filters.push(`(r.updated_at<$${updatedAtParameter}::TIMESTAMPTZ OR (r.updated_at=$${updatedAtParameter}::TIMESTAMPTZ AND r.id<$${values.length}::UUID))`);
        }
        const page = await client.query(`SELECT r.* FROM suite_records r WHERE ${filters.join(" AND ")} ORDER BY r.updated_at DESC,r.id DESC LIMIT $2`, values);
        if (!page.rows.length) break;
        for (const row of page.rows) {
          const record = this.record(row);
          if (canReadSuiteRecord({ userId, workspaceId: workspace.id, role }, record)) visible.push(record);
          if (visible.length === input.limit) break;
        }
        if (page.rows.length < pageSize || visible.length === input.limit) break;
        const last = page.rows.at(-1)!;
        cursor = { updatedAt: last.updated_at, id: String(last.id) };
      }
      return visible;
    });
  }

  async findSignerSessionByTokenHash(userId: string, tokenHash: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND module_id='esign' AND record_type='signer-session' AND data->>'tokenHash'=$2 LIMIT 2", [workspace.id, tokenHash]);
      if (result.rows.length > 1) throw new Error("Signer session token hash integrity failed.");
      return result.rows[0] ? this.record(result.rows[0]) : undefined;
    });
  }

  async getRecord(userId: string, recordId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND id=$2", [workspace.id, recordId]);
      if (!result.rows[0]) return undefined;
      const record = this.record(result.rows[0]);
      if (this.transactionContext.getStore()) return record;
      const role = workspace.currentRole;
      return role && canReadSuiteRecord({ userId, workspaceId: workspace.id, role }, record) ? record : undefined;
    });
  }

  async findCommandReceipt(userId: string, input: { recordType: SuiteCommandReceiptRecordType; moduleId: string; actionId: string; idempotencyKey: string }) {
    commandReceiptLookupInput(input);
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND record_type=$2 AND module_id=$3 AND data->>'actionId'=$4 AND data->>'idempotencyKey'=$5 LIMIT 2", [workspace.id, input.recordType, input.moduleId, input.actionId, input.idempotencyKey]);
      if (result.rows.length > 1) throw new Error("The workspace contains duplicate command idempotency receipts.");
      return result.rows[0] ? this.record(result.rows[0]) : undefined;
    });
  }

  async findApprovalDecisionReceipt(userId: string, decisionId: string) {
    approvalDecisionLookupValue(decisionId);
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND record_type=ANY($2::TEXT[]) AND data->>'approvalDecisionId'=$3 ORDER BY updated_at DESC,id DESC LIMIT 1", [workspace.id, suiteCommandReceiptRecordTypes, decisionId]);
      return result.rows[0] ? this.record(result.rows[0]) : undefined;
    });
  }

  async createRecord(userId: string, input: { moduleId: string; recordType: string; title: string; state?: string; data?: Record<string, unknown> }) {
    recordPayloadBytes(input.data);
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canWriteRole(workspace.currentRole) || !workspace.enabledModuleIds.includes(input.moduleId) || !planAllows(workspace.plan, input.moduleId)) return undefined;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspaceMutationLockKey(workspace.id)]);
      const usage = await client.query("SELECT (SELECT COUNT(*)::BIGINT FROM suite_records WHERE workspace_id=$1) AS record_count,(SELECT COALESCE(SUM(size_bytes),0)::BIGINT FROM suite_storage_objects WHERE workspace_id=$1 AND accounting_state='retained') AS storage_bytes", [workspace.id]);
      const quota = quotaForPlan(workspace.plan);
      if (Number(usage.rows[0].record_count) >= quota.recordLimit) throw new Error("This workspace reached its record quota. Upgrade the server plan to continue.");
      if (BigInt(usage.rows[0].storage_bytes) + BigInt(suiteRegisteredObjectBytes(input.moduleId, input.recordType, input.data ?? {})) > BigInt(quota.storageLimitBytes)) throw new Error("This workspace reached its registered storage quota. Upgrade the server plan or remove files.");
      const id = randomUUID();
      const result = await client.query("INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [id, workspace.id, input.moduleId, input.recordType, input.title, input.state ?? "active", JSON.stringify(input.data ?? {})]);
      await client.query("INSERT INTO suite_events(id,workspace_id,module_id,event_type,record_id,payload) VALUES($1,$2,$3,'record.created',$4,$5)", [randomUUID(), workspace.id, input.moduleId, id, JSON.stringify({ recordType: input.recordType })]);
      return this.record(result.rows[0]);
    });
  }

  async createPublicRecord(workspaceSlug: string, input: { id?: string; moduleId: string; recordType: string; title: string; state?: string; data?: Record<string, unknown> }) {
    recordPayloadBytes(input.data);
    return this.withPublicWorkspace(workspaceSlug, async (client, workspace) => {
      if (!workspace.enabledModuleIds.includes(input.moduleId) || !planAllows(workspace.plan, input.moduleId)) return undefined;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspaceMutationLockKey(workspace.id)]);
      const usage = await client.query("SELECT (SELECT COUNT(*)::BIGINT FROM suite_records WHERE workspace_id=$1) AS record_count,(SELECT COALESCE(SUM(size_bytes),0)::BIGINT FROM suite_storage_objects WHERE workspace_id=$1 AND accounting_state='retained') AS storage_bytes", [workspace.id]);
      const quota = quotaForPlan(workspace.plan);
      if (Number(usage.rows[0].record_count) >= quota.recordLimit) throw new Error("This workspace is not accepting more submissions.");
      if (BigInt(usage.rows[0].storage_bytes) + BigInt(suiteRegisteredObjectBytes(input.moduleId, input.recordType, input.data ?? {})) > BigInt(quota.storageLimitBytes)) throw new Error("This workspace is not accepting more object storage.");
      const id = input.id ?? randomUUID();
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("The public record ID is invalid.");
      const result = await client.query("INSERT INTO suite_records(id,workspace_id,module_id,record_type,title,state,data) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [id, workspace.id, input.moduleId, input.recordType, input.title, input.state ?? "active", JSON.stringify(input.data ?? {})]);
      await client.query("INSERT INTO suite_events(id,workspace_id,module_id,event_type,record_id,payload) VALUES($1,$2,$3,'public.record.created',$4,$5)", [randomUUID(), workspace.id, input.moduleId, id, JSON.stringify({ recordType: input.recordType })]);
      return this.record(result.rows[0]);
    }, undefined);
  }

  async listPublicRecords(workspaceSlug: string, input: { moduleId: string; recordType?: string; limit: number }) {
    return this.withPublicWorkspace(workspaceSlug, async (client, workspace) => {
      const values: unknown[] = [workspace.id, input.moduleId, input.limit];
      const recordTypeFilter = input.recordType ? "AND r.record_type=$4" : "";
      if (input.recordType) values.push(input.recordType);
      const result = await client.query(`SELECT r.* FROM suite_records r JOIN suite_workspace_modules m ON m.workspace_id=r.workspace_id AND m.module_id=r.module_id WHERE r.workspace_id=$1 AND r.module_id=$2 AND r.data->>'public'='true' ${recordTypeFilter} ORDER BY r.updated_at DESC LIMIT $3`, values);
      return result.rows.map((row) => this.record(row));
    }, []);
  }

  async recordPublicEvent(workspaceSlug: string, input: { moduleId: string; eventType: string; recordId?: string; payload?: Record<string, unknown> }) {
    return this.withPublicWorkspace(workspaceSlug, async (client, workspace) => {
      const result = await client.query("INSERT INTO suite_events(id,workspace_id,module_id,event_type,record_id,payload) SELECT $1,$2,$3,$4,$5,$6 FROM suite_workspace_modules m WHERE m.workspace_id=$2 AND m.module_id=$3 RETURNING id", [randomUUID(), workspace.id, input.moduleId, input.eventType, input.recordId ?? null, JSON.stringify(input.payload ?? {})]);
      return result.rowCount === 1;
    }, false);
  }

  async listPublicWorkflowRecords(workspaceSlug: string, input: { moduleId: string; recordType: string; limit: number }) {
    return this.withPublicWorkspace(workspaceSlug, async (client, workspace) => {
      const result = await client.query("SELECT r.* FROM suite_records r JOIN suite_workspace_modules m ON m.workspace_id=r.workspace_id AND m.module_id=r.module_id WHERE r.workspace_id=$1 AND r.module_id=$2 AND r.record_type=$3 ORDER BY r.updated_at DESC LIMIT $4", [workspace.id, input.moduleId, input.recordType, input.limit]);
      return result.rows.map((row) => this.record(row));
    }, []);
  }

  async updatePublicWorkflowRecord(workspaceSlug: string, recordId: string, input: { state?: string; data?: Record<string, unknown> }) {
    return this.withPublicWorkspace(workspaceSlug, async (client, workspace) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspaceMutationLockKey(workspace.id)]);
      const existing = await client.query("SELECT r.* FROM suite_records r JOIN suite_workspace_modules m ON m.workspace_id=r.workspace_id AND m.module_id=r.module_id WHERE r.workspace_id=$1 AND r.id=$2 FOR UPDATE OF r", [workspace.id, recordId]);
      if (!existing.rows[0]) return undefined;
      const prior = this.record(existing.rows[0]);
      const nextState = input.state ?? prior.state;
      const nextData = input.data === undefined ? prior.data : { ...prior.data, ...input.data };
      recordPayloadBytes(nextData);
      const bytes = assertSuiteStorageObjectUpdate({ moduleId: prior.moduleId, recordType: prior.recordType, priorTitle: prior.title, priorState: prior.state, priorData: prior.data, nextTitle: prior.title, nextState, nextData });
      const storage = await client.query("SELECT COALESCE(SUM(size_bytes),0)::BIGINT AS storage_bytes FROM suite_storage_objects WHERE workspace_id=$1 AND accounting_state='retained'", [workspace.id]);
      const nextUsage = BigInt(storage.rows[0].storage_bytes) - BigInt(bytes.priorBytes) + BigInt(bytes.nextBytes);
      if (nextUsage > BigInt(quotaForPlan(workspace.plan).storageLimitBytes)) throw new Error("This workspace is not accepting more object storage.");
      const result = await client.query("UPDATE suite_records r SET state=COALESCE($3,state),data=data||$4::jsonb,updated_at=NOW() FROM suite_workspace_modules m WHERE r.workspace_id=$1 AND m.workspace_id=r.workspace_id AND m.module_id=r.module_id AND r.id=$2 RETURNING r.*", [workspace.id, recordId, input.state ?? null, JSON.stringify(input.data ?? {})]);
      return result.rows[0] ? this.record(result.rows[0]) : undefined;
    }, undefined);
  }

  async updateRecord(userId: string, recordId: string, input: { title?: string; state?: string; data?: Record<string, unknown> }) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canWriteRole(workspace.currentRole)) return undefined;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspaceMutationLockKey(workspace.id)]);
      const existing = await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspace.id, recordId]);
      if (!existing.rows[0] || !planAllows(workspace.plan, String(existing.rows[0].module_id))) return undefined;
      const prior = this.record(existing.rows[0]);
      const nextTitle = input.title ?? prior.title;
      const nextState = input.state ?? prior.state;
      const nextData = input.data === undefined ? prior.data : { ...prior.data, ...input.data };
      recordPayloadBytes(nextData);
      const bytes = assertSuiteStorageObjectUpdate({ moduleId: prior.moduleId, recordType: prior.recordType, priorTitle: prior.title, priorState: prior.state, priorData: prior.data, nextTitle, nextState, nextData });
      const storage = await client.query("SELECT COALESCE(SUM(size_bytes),0)::BIGINT AS storage_bytes FROM suite_storage_objects WHERE workspace_id=$1 AND accounting_state='retained'", [workspace.id]);
      const nextUsage = BigInt(storage.rows[0].storage_bytes) - BigInt(bytes.priorBytes) + BigInt(bytes.nextBytes);
      if (nextUsage > BigInt(quotaForPlan(workspace.plan).storageLimitBytes)) throw new Error("This workspace reached its registered storage quota. Upgrade the server plan or remove files.");
      const result = await client.query("UPDATE suite_records SET title=COALESCE($3,title),state=COALESCE($4,state),data=data||$5::jsonb,updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING *", [workspace.id, recordId, input.title ?? null, input.state ?? null, JSON.stringify(input.data ?? {})]);
      return result.rows[0] ? this.record(result.rows[0]) : undefined;
    });
  }

  async queueAiAction(userId: string, input: { moduleId: string; goal: string; context?: Record<string, unknown> }) {
    const context = { ...(input.context ?? {}), requestedByUserId: userId };
    recordPayloadBytes(context);
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canWriteRole(workspace.currentRole) || !workspace.enabledModuleIds.includes(input.moduleId) || !planAllows(workspace.plan, input.moduleId)) return undefined;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workspace.id]);
      const count = await client.query("SELECT COUNT(*)::BIGINT AS action_count FROM suite_ai_actions WHERE workspace_id=$1 AND created_at>=date_trunc('month',NOW())", [workspace.id]);
      if (Number(count.rows[0].action_count) >= quotaForPlan(workspace.plan).aiActionLimit) throw new Error("This workspace reached its monthly AI action quota. Upgrade the server plan or wait for the next billing month.");
      const id = randomUUID();
      const result = await client.query("INSERT INTO suite_ai_actions(id,workspace_id,module_id,goal,context) VALUES($1,$2,$3,$4,$5) RETURNING *", [id, workspace.id, input.moduleId, input.goal, JSON.stringify(context)]);
      return this.aiAction(result.rows[0]);
    });
  }

  private aiAction(row: DbRow): SuiteAiAction {
    return { id: String(row.id), workspaceId: String(row.workspace_id), moduleId: String(row.module_id), goal: String(row.goal), context: (row.context ?? {}) as Record<string, unknown>, status: row.status as SuiteAiAction["status"], result: row.result ? row.result as Record<string, unknown> : undefined, attempts: Number(row.attempts ?? 0), leaseExpiresAt: row.lease_expires_at ? databaseTimestampIso(row.lease_expires_at) : undefined, lastError: row.last_error ? String(row.last_error) : undefined, createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at) };
  }

  async getAiAction(userId: string, actionId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT * FROM suite_ai_actions WHERE workspace_id=$1 AND id=$2", [workspace.id, actionId]);
      if (!result.rows[0]) return undefined;
      const action = this.aiAction(result.rows[0]);
      if (this.transactionContext.getStore()) return action;
      return workspace.currentRole === "owner" || workspace.currentRole === "admin" || action.context.requestedByUserId === userId ? action : undefined;
    });
  }

  async claimAiAction() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const starterModules = suiteModules.filter((module) => module.minPlan === "starter").map((module) => module.id);
      const scaleModules = suiteModules.filter((module) => module.minPlan !== "fleet").map((module) => module.id);
      const result = await client.query("SELECT * FROM managed_oss_claim_suite_ai_action($1,$2,$3)", [config.SUITE_ENTITLEMENT_MODE === "unrestricted", scaleModules, starterModules]);
      if (!result.rows[0]) { await client.query("COMMIT"); return undefined; }
      const row = result.rows[0];
      await this.setWorkspaceContext(client, String(row.workspace_id));
      const action = this.aiAction(row);
      const requester = await client.query("SELECT requested_by_user_id,requested_by_role FROM managed_oss_ai_action_requester_principal($1)", [action.id]);
      const requestedByUserId = requester.rows[0]?.requested_by_user_id ? String(requester.rows[0].requested_by_user_id) : undefined;
      const requesterRole = requester.rows[0]?.requested_by_role as SuiteWorkspaceRole | undefined;
      const selectedIds = aiSelectedRecordIds(action.context);
      const allowedModules = suiteAiReadScopes(String(row.module_id), { explicitSelection: selectedIds.length > 0 });
      const records = selectedIds.length
        ? await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND module_id=ANY($2::TEXT[]) AND id=ANY($3::UUID[]) ORDER BY updated_at DESC LIMIT 1000", [row.workspace_id, allowedModules, selectedIds])
        : await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND module_id=ANY($2::TEXT[]) ORDER BY updated_at DESC LIMIT 100", [row.workspace_id, allowedModules]);
      const claimedRecords = records.rows.map((record) => this.record(record));
      const bindings = assistantEvidenceBindings(action);
      if (bindings.length) {
        const attachmentIds = [...new Set(bindings.map((binding) => binding.attachmentRecordId))];
        const attachmentResult = await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND module_id='assistant' AND record_type='source-attachment' AND id=ANY($2::UUID[])", [row.workspace_id, attachmentIds]);
        const attachments = attachmentResult.rows.map((record) => this.record(record));
        const evidenceIds = new Set(Array.isArray(action.context.evidenceIds) ? action.context.evidenceIds.filter((value): value is string => typeof value === "string") : []);
        const authorizedBindings = bindings.filter((binding) => attachments.some((attachment) => assistantAttachmentMatches(binding, attachment)) && evidenceIds.has(binding.sourceRecordId));
        if (authorizedBindings.length) {
          const sourceIds = [...new Set(authorizedBindings.map((binding) => binding.sourceRecordId))];
          const sourceResult = await client.query("SELECT * FROM suite_records WHERE workspace_id=$1 AND id=ANY($2::UUID[])", [row.workspace_id, sourceIds]);
          const sources = sourceResult.rows.map((record) => this.record(record));
          for (const binding of authorizedBindings) {
            const attachment = attachments.find((candidate) => assistantAttachmentMatches(binding, candidate));
            const source = sources.find((candidate) => assistantSourceMatches(binding, candidate, evidenceIds));
            if (attachment && source) claimedRecords.push(attachment, source);
          }
        }
      }
      await client.query("COMMIT");
      return {
        action,
        records: [...new Map(claimedRecords.map((record) => [record.id, record])).values()]
          .filter((record) => Boolean(requestedByUserId && requesterRole && canReadSuiteRecord({ userId: requestedByUserId, workspaceId: action.workspaceId, role: requesterRole }, record)))
          .slice(0, 1_000),
      };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async completeAiAction(actionId: string, result: { status: "completed" | "failed"; result: Record<string, unknown> }) {
    return this.transaction(async (client) => {
      const updated = await client.query("SELECT managed_oss_complete_suite_ai_action_v4($1,$2,$3,$4) completed", [actionId, result.status, JSON.stringify(result.result), result.status === "failed" && typeof result.result.error === "string" ? result.result.error : null]);
      return updated.rows[0]?.completed === true;
    });
  }

  async createApiToken(userId: string, input: { name: string; scopes: SuiteApiTokenScope[]; expiresAt: string }) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      if (!canWriteRole(workspace.currentRole) && input.scopes.some((scope) => scope !== "read")) throw new Error("Viewer tokens may only use the read scope.");
      const token = `sup_${randomBytes(32).toString("base64url")}`;
      const id = randomUUID();
      const result = await client.query("INSERT INTO suite_api_tokens(id,user_id,workspace_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [id, userId, workspace.id, input.name, tokenHash(token), input.scopes, input.expiresAt]);
      return { ...this.apiToken(result.rows[0]), token };
    });
  }

  async listApiTokens(userId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("SELECT * FROM suite_api_tokens WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC", [workspace.id, userId]);
      return result.rows.map((row) => this.apiToken(row));
    });
  }

  async revokeApiToken(userId: string, tokenId: string) {
    return this.withUserWorkspace(userId, async (client, workspace) => {
      const result = await client.query("UPDATE suite_api_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE workspace_id=$1 AND id=$2 AND user_id=$3 RETURNING id", [workspace.id, tokenId, userId]);
      return result.rowCount === 1;
    });
  }

  async findApiTokenPrincipal(token: string) {
    return this.transaction(async (client) => {
      const result = await client.query("SELECT * FROM managed_oss_api_token_principal($1)", [tokenHash(token)]);
      const row = result.rows[0];
      if (!row) return undefined;
      await this.setWorkspaceContext(client, String(row.workspace_id));
      const scopes = Array.isArray(row.scopes)
        ? row.scopes.filter((scope: unknown): scope is SuiteApiTokenScope => typeof scope === "string" && suiteApiTokenScopes.includes(scope as SuiteApiTokenScope))
        : [];
      return { tokenId: String(row.token_id), userId: String(row.user_id), scopes };
    });
  }
}

export function createSuiteStore(connectionString = config.DATABASE_RUNTIME_URL ?? config.DATABASE_URL): SuiteStore {
  return connectionString ? new PostgresSuiteStore(connectionString) : new MemorySuiteStore();
}
