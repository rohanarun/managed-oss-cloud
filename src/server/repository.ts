import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { AccountUser, AgentJob, ApplicationInstance, BackupRecord, CustomDomain, GatewayRoute, Installation, ProvisioningJob, WorkerNode, WorkerNodeActivity, WorkerNodeMode, WorkerNodeRoute } from "../shared/types.js";
import { suiteModules, type SuitePlanId } from "../shared/suite.js";
import { applicationCapacityUsage, capacityEnvelopeFit, planCapacitySnapshot, positiveCapacityDelta, type PlanCapacitySnapshot } from "../shared/plan-capacity.js";
import { config } from "./config.js";
import { ensureDatabaseMigrations } from "./database-migrations.js";
import { assertPostgresRegistryHasNoPlatformClaims, hostnameClaimFromRow, hostnameOwnershipInstructions, insertPostgresHostnameClaim, MemoryHostnameClaimRegistry, newHostnameClaim, platformOwnedHostnameSuffixes, updatePostgresHostnameClaimStatus } from "./hostname-claims.js";
import { databaseTimestampIso } from "./postgres-values.js";

interface StoredUser extends AccountUser { passwordHash: string }
export interface WorkerRegistration { id: string; name: string; privateAddress: string; machineType: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number; systemReserveMemoryMb: number }
export interface WorkerJobReport { status: "succeeded" | "failed"; error?: string; applications?: Array<{ id: string; state: ApplicationInstance["state"]; healthy?: boolean }>; backups?: Array<{ applicationInstanceId: string; objectName: string; sizeBytes: number }> }
export interface StoredSubscription { id: string; userId: string; installationId?: string; providerSubscriptionId?: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number; installationPlan?: string }
export interface ReconciledSubscription { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }
export interface ReconciledEntitlement { userId: string; plan: SuitePlanId; suiteWorkspaceUpdated: boolean }
export interface ManagedOAuthFlow {
  id: string;
  stateTokenHash: string;
  applicationInstanceId: string;
  origin: string;
  upstreamState: string;
  codeVerifier: string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
}
export interface CapacityReservation { memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }
export interface CheckoutCapacityReservation extends CapacityReservation { applicationInstanceId: string; appId: string }
export type CheckoutCapacityHoldState = "active" | "consumed" | "released" | "expired";
export interface CheckoutCapacityHoldItem extends CheckoutCapacityReservation { id: string; holdId: string; workerNodeId: string; createdAt: string }
export interface CheckoutPlanCapacityHold extends PlanCapacitySnapshot { holdId: string; workerNodeId: string; createdAt: string }
export interface CheckoutCapacityHold {
  id: string;
  userId: string;
  installationId: string;
  idempotencyKey: string;
  requestedPlan: string;
  requestedAppIds: string[];
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  state: CheckoutCapacityHoldState;
  stripeCustomerId?: string;
  stripeCheckoutSessionId?: string;
  stripeCheckoutExpiresAt?: string;
  providerSubscriptionId?: string;
  expiresAt: string;
  consumedAt?: string;
  releasedAt?: string;
  expiredAt?: string;
  releaseReason?: string;
  createdAt: string;
  updatedAt: string;
  items: CheckoutCapacityHoldItem[];
  planCapacity: CheckoutPlanCapacityHold;
}
export interface AcquireCheckoutCapacityHoldInput {
  userId: string;
  installationId: string;
  idempotencyKey: string;
  requestedPlan: string;
  requestedAppIds: string[];
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  expiresAt: string;
  reservations: CheckoutCapacityReservation[];
  planCapacity: PlanCapacitySnapshot;
}
export interface AttachCheckoutSessionInput { holdId: string; userId: string; stripeCustomerId: string; stripeCheckoutSessionId: string; stripeCheckoutExpiresAt: string }
export interface ProcessPaidCheckoutInput {
  eventId: string;
  eventType: string;
  holdId: string;
  userId: string;
  installationId: string;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string;
  providerSubscriptionId: string;
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  compensationDeadlineAt?: string;
}
export type PaidCheckoutCapacityRecoveryState = "pending_capacity" | "fulfilled" | "compensation_required" | "compensated";
export interface PaidCheckoutCapacityRecovery {
  id: string;
  stripeEventId: string;
  checkoutHoldId: string;
  userId: string;
  installationId: string;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string;
  providerSubscriptionId: string;
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  state: PaidCheckoutCapacityRecoveryState;
  attemptCount: number;
  compensationDeadlineAt: string;
  compensationAction: "cancel_subscription_and_refund_captured_payment";
  lastAttemptAt?: string;
  fulfilledAt?: string;
  compensationRequiredAt?: string;
  compensatedAt?: string;
  compensationReference?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
export interface PaidCheckoutProviderConfirmation {
  providerSubscriptionId: string;
  status: string;
  userId?: string;
  installationId?: string;
  capacityHoldId?: string;
  customerId?: string;
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  problems: string[];
}
export type InstallationCapacityAllocationState = "active" | "suspended" | "released";
export interface InstallationCapacityAllocation extends PlanCapacitySnapshot {
  id: string;
  installationId: string;
  workerNodeId: string;
  generation: number;
  state: InstallationCapacityAllocationState;
  sourceCheckoutHoldId?: string;
  suspendedAt?: string;
  releasedAt?: string;
  releaseReason?: string;
  createdAt: string;
  updatedAt: string;
}
export type PlanCapacityChangeHoldState = "active" | "consumed" | "released" | "expired";
export interface PlanCapacityChangeHold extends PlanCapacitySnapshot {
  id: string;
  userId: string;
  installationId: string;
  allocationId: string;
  idempotencyKey: string;
  expectedGeneration: number;
  fromPlan: string;
  workerNodeId: string;
  reservedDeltaMemoryMb: number;
  reservedDeltaCpuMillis: number;
  reservedDeltaStorageGb: number;
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  providerSubscriptionId: string;
  state: PlanCapacityChangeHoldState;
  expiresAt: string;
  consumedAt?: string;
  releasedAt?: string;
  expiredAt?: string;
  releaseReason?: string;
  providerCommittedAt?: string;
  providerConfirmationSource?: string;
  createdAt: string;
  updatedAt: string;
}
export interface CreateApplicationCloneInput {
  userId: string;
  installationId: string;
  idempotencyKey: string;
  app: { appId: string; memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number };
  hostnameBase: string;
  memorySafetyReserveMb: number;
}
export interface ApplicationCloneResult { application: ApplicationInstance; job?: ProvisioningJob; replayed: boolean }
export interface AcquirePlanCapacityChangeHoldInput {
  userId: string;
  installationId: string;
  idempotencyKey: string;
  requested: PlanCapacitySnapshot;
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  providerSubscriptionId: string;
  expiresAt: string;
  memorySafetyReserveMb: number;
}
const agentTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newAgentToken = () => randomBytes(32).toString("base64url");
const paidWorkerActions = new Set<ProvisioningJob["action"]>(["install", "upgrade", "start", "restore"]);
const checkoutCapacityAllocationLock = "managed-oss-cloud/checkout-capacity-allocation";
const committedWorkerCapacitySql = `LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(capacity.memory),0) memory,COALESCE(SUM(capacity.cpu),0) cpu,COALESCE(SUM(capacity.storage),0) storage FROM (
    SELECT app.memory_reservation_mb memory,app.cpu_reservation_millis cpu,app.storage_reservation_gb storage FROM application_instances app WHERE app.worker_node_id=w.id
    UNION ALL SELECT item.memory_reservation_mb,item.cpu_reservation_millis,item.storage_reservation_gb FROM checkout_capacity_hold_items item JOIN checkout_capacity_holds hold ON hold.id=item.hold_id WHERE item.worker_node_id=w.id AND hold.state='active' AND hold.expires_at>NOW()
  ) capacity
) committed ON TRUE`;
const hostingEntitlementActive = (subscriptions: Iterable<StoredSubscription>, installationId: string) => config.HOSTING_ENTITLEMENT_MODE === "unrestricted" || [...subscriptions].some((subscription) => subscription.installationId === installationId && ["active", "trialing"].includes(subscription.status));
const platformHostnameSuffixes = () => platformOwnedHostnameSuffixes({ publicHostTarget: config.PUBLIC_HOST_TARGET, controlPlaneDomain: config.CONTROL_PLANE_DOMAIN, publicAppUrl: config.PUBLIC_APP_URL });

function cloneRequestSnapshot(input: CreateApplicationCloneInput) {
  return { installationId: input.installationId, appId: input.app.appId, memoryReservationMb: input.app.memoryReservationMb, cpuReservationMillis: input.app.cpuReservationMillis, storageReservationGb: input.app.storageReservationGb, hostnameBase: input.hostnameBase, memorySafetyReserveMb: input.memorySafetyReserveMb };
}

function cloneRequestHash(input: CreateApplicationCloneInput) {
  return createHash("sha256").update(JSON.stringify(cloneRequestSnapshot(input)), "utf8").digest("hex");
}

export interface ClaimedApplicationDomain {
  installation: Installation;
  domain: CustomDomain;
}

function allocateCapacity(workers: WorkerNode[], reservations: CheckoutCapacityReservation[]) {
  if (!workers.length) return false;
  if (!reservations.length) return new Map<string, string>();
  const bins = workers.map((worker) => ({
    workerId: worker.id,
    memory: worker.capacityMemoryMb - worker.systemReserveMemoryMb - worker.reservedMemoryMb,
    cpu: worker.capacityCpuMillis - worker.reservedCpuMillis,
    storage: worker.capacityStorageGb - worker.reservedStorageGb,
  }));
  const requested = [...reservations].sort((left, right) => right.memoryReservationMb - left.memoryReservationMb || right.cpuReservationMillis - left.cpuReservationMillis || right.storageReservationGb - left.storageReservationGb || left.applicationInstanceId.localeCompare(right.applicationInstanceId));
  const allocated = new Map<string, string>();
  for (const reservation of requested) {
    const candidates = bins.map((bin, index) => ({ bin, index })).filter(({ bin }) => reservation.memoryReservationMb <= bin.memory && reservation.cpuReservationMillis <= bin.cpu && reservation.storageReservationGb <= bin.storage).sort((left, right) => (left.bin.memory - reservation.memoryReservationMb) - (right.bin.memory - reservation.memoryReservationMb));
    if (!candidates.length) return false;
    const target = bins[candidates[0].index];
    target.memory -= reservation.memoryReservationMb;
    target.cpu -= reservation.cpuReservationMillis;
    target.storage -= reservation.storageReservationGb;
    allocated.set(reservation.applicationInstanceId, target.workerId);
  }
  return allocated;
}

function canonicalCapacityReservations(reservations: CheckoutCapacityReservation[]) {
  return reservations.map(({ applicationInstanceId, appId, memoryReservationMb, cpuReservationMillis, storageReservationGb }) => ({ applicationInstanceId, appId, memoryReservationMb, cpuReservationMillis, storageReservationGb })).sort((left, right) => left.applicationInstanceId.localeCompare(right.applicationInstanceId));
}

function capacityCanFit(workers: WorkerNode[], reservations: CapacityReservation[]) {
  return Boolean(allocateCapacity(workers, reservations.map((reservation, index) => ({ ...reservation, applicationInstanceId: `capacity-check-${index}`, appId: `capacity-check-${index}` }))));
}

function allocationAffinityWorker(workers: WorkerNode[], assignments: Map<string, string>) {
  return assignments.values().next().value ?? workers[0]?.id;
}

function samePlanCapacity(left: PlanCapacitySnapshot | undefined, right: PlanCapacitySnapshot | undefined) {
  return Boolean(left && right && left.planId === right.planId && left.memoryMb === right.memoryMb && left.cpuMillis === right.cpuMillis && left.storageGb === right.storageGb && left.maxServices === right.maxServices);
}

export interface Repository {
  readonly persistence: "postgres" | "preview-memory";
  hostnameRegistry?: MemoryHostnameClaimRegistry;
  attachHostnameRegistry?(hostnameRegistry: MemoryHostnameClaimRegistry): void;
  initialize(): Promise<void>;
  findUserByEmail(email: string): Promise<StoredUser | undefined>;
  findUserById(id: string): Promise<StoredUser | undefined>;
  createUser(input: { email: string; displayName: string; passwordHash: string }): Promise<StoredUser>;
  createSession(input: { tokenHash: string; userId: string; expiresAt: string }): Promise<void>;
  findUserBySession(tokenHash: string): Promise<StoredUser | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  listInstallations(userId: string): Promise<Installation[]>;
  createInstallation(input: Omit<Installation, "id" | "createdAt" | "updatedAt">): Promise<Installation>;
  getInstallation(userId: string, id: string): Promise<Installation | undefined>;
  addDomain(userId: string, id: string, domain: string): Promise<ClaimedApplicationDomain | undefined>;
  upgrade(userId: string, id: string, plan: string): Promise<Installation | undefined>;
  appendApplicationId(installationId: string, appId: string): Promise<void>;
  canReserveOnInstallationWorker(installationId: string, reservation: { memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }, memorySafetyReserveMb?: number): Promise<boolean>;
  hasFreshProvisioningCapacity(reservations: CapacityReservation[]): Promise<boolean>;
  acquireCheckoutCapacityHold(input: AcquireCheckoutCapacityHoldInput): Promise<CheckoutCapacityHold | undefined>;
  hasActiveCheckoutCapacityHold(installationId: string): Promise<boolean>;
  attachCheckoutSession(input: AttachCheckoutSessionInput): Promise<boolean>;
  releaseCheckoutCapacityHold(holdId: string, userId: string, reason: string): Promise<boolean>;
  getCheckoutCapacityHold(holdId: string): Promise<CheckoutCapacityHold | undefined>;
  createApplicationInstances(installationId: string, apps: Array<{ appId: string; memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }>, hostnameBase: string, memorySafetyReserveMb?: number): Promise<ApplicationInstance[]>;
  getApplicationInstance(userId: string, id: string): Promise<ApplicationInstance | undefined>;
  updateInstallationState(id: string, state: Installation["state"], failureReason?: string): Promise<void>;
  updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string): Promise<void>;
  enqueueJob(installationId: string, action: ProvisioningJob["action"], payload?: Record<string, unknown>): Promise<ProvisioningJob>;
  setDomainStatus(userId: string, installationId: string, domain: string, status: CustomDomain["verificationStatus"]): Promise<CustomDomain | undefined>;
  getOrCreateStripeCustomer(userId: string, create: () => Promise<string>): Promise<string>;
  recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }): Promise<void>;
  listSubscriptions(): Promise<StoredSubscription[]>;
  applySubscriptionReconciliation(input: { deactivateSubscriptionIds: string[]; upsertSubscriptions: ReconciledSubscription[]; affectedUserIds: string[] }): Promise<ReconciledEntitlement[]>;
  getActiveSubscription(userId: string, installationId: string): Promise<{ providerSubscriptionId: string } | undefined>;
  updateSubscriptionStatus(providerSubscriptionId: string, status: string): Promise<{ userId: string; installationId: string } | undefined>;
  getEffectiveSuitePlan(userId: string): Promise<SuitePlanId>;
  hasProcessedStripeEvent(eventId: string): Promise<boolean>;
  markStripeEventProcessed(eventId: string, eventType: string): Promise<void>;
  processPaidCheckout(input: ProcessPaidCheckoutInput): Promise<boolean>;
  getPaidCheckoutCapacityRecovery(providerSubscriptionId: string): Promise<PaidCheckoutCapacityRecovery | undefined>;
  advancePaidCheckoutCapacityRecovery(providerSubscriptionId: string): Promise<PaidCheckoutCapacityRecovery | undefined>;
  retryPaidCheckoutCapacityRecovery(confirmation: PaidCheckoutProviderConfirmation): Promise<PaidCheckoutCapacityRecovery | undefined>;
  markPaidCheckoutCapacityCompensated(providerSubscriptionId: string, compensationReference: string): Promise<PaidCheckoutCapacityRecovery | undefined>;
  getInstallationCapacityAllocation(userId: string, installationId: string): Promise<InstallationCapacityAllocation | undefined>;
  acquirePlanCapacityChangeHold(input: AcquirePlanCapacityChangeHoldInput): Promise<PlanCapacityChangeHold | undefined>;
  getPlanCapacityChangeHold(holdId: string): Promise<PlanCapacityChangeHold | undefined>;
  releasePlanCapacityChangeHold(holdId: string, userId: string, reason: string): Promise<boolean>;
  consumePlanCapacityChangeHold(holdId: string, userId: string, providerConfirmationSource?: string): Promise<InstallationCapacityAllocation | undefined>;
  createApplicationClone(input: CreateApplicationCloneInput): Promise<ApplicationCloneResult>;
  listBackups(userId: string, installationId: string): Promise<BackupRecord[]>;
  registerWorkerNode(input: WorkerRegistration): Promise<{ node: WorkerNode; agentToken: string }>;
  findWorkerNodeByAgentToken(token: string): Promise<WorkerNode | undefined>;
  heartbeatWorkerNode(nodeId: string, input: { privateAddress: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number }): Promise<WorkerNode | undefined>;
  getWorkerNodeActivity(nodeId: string): Promise<WorkerNodeActivity | undefined>;
  setWorkerNodeMode(nodeId: string, mode: WorkerNodeMode): Promise<WorkerNodeActivity | undefined>;
  claimWorkerJob(nodeId: string): Promise<AgentJob | undefined>;
  reportWorkerJob(nodeId: string, jobId: string, report: WorkerJobReport): Promise<boolean>;
  listGatewayRoutes(): Promise<GatewayRoute[]>;
  createManagedOAuthFlow(input: ManagedOAuthFlow): Promise<void>;
  consumeManagedOAuthFlow(stateTokenHash: string): Promise<ManagedOAuthFlow | undefined>;
  listWorkerNodeRoutes(nodeId: string): Promise<WorkerNodeRoute[]>;
}

export class MemoryRepository implements Repository {
  readonly persistence = "preview-memory" as const;
  private users = new Map<string, StoredUser>();
  private sessions = new Map<string, { userId: string; expiresAt: string }>();
  private installations = new Map<string, Installation>();
  private applications = new Map<string, ApplicationInstance>();
  private jobs = new Map<string, ProvisioningJob>();
  private stripeCustomers = new Map<string, string>();
  private subscriptions = new Map<string, StoredSubscription>();
  private stripeEvents = new Set<string>();
  private checkoutCapacityHolds = new Map<string, CheckoutCapacityHold>();
  private capacityAllocations = new Map<string, InstallationCapacityAllocation>();
  private planCapacityChangeHolds = new Map<string, PlanCapacityChangeHold>();
  private paidCheckoutCapacityRecoveries = new Map<string, PaidCheckoutCapacityRecovery>();
  private cloneIdempotency = new Map<string, { userId: string; requestHash: string; installationId: string; appId: string; applicationId: string; jobId?: string }>();
  private backups: BackupRecord[] = [];
  private managedOAuthFlows = new Map<string, ManagedOAuthFlow>();
  private workers = new Map<string, WorkerNode & { agentTokenHash: string }>();
  hostnameRegistry: MemoryHostnameClaimRegistry;

  constructor(hostnameRegistry = new MemoryHostnameClaimRegistry()) {
    this.hostnameRegistry = hostnameRegistry;
  }

  attachHostnameRegistry(hostnameRegistry: MemoryHostnameClaimRegistry) {
    if (hostnameRegistry === this.hostnameRegistry) return;
    for (const application of this.applications.values()) {
      for (const domain of application.customDomains) {
        const claim = this.hostnameRegistry.get(domain.domain);
        if (!claim || claim.id !== domain.ownership.claimId || claim.surface !== "application" || claim.resourceId !== application.id) throw new Error(`Application hostname claim integrity failed for ${domain.domain}.`);
        hostnameRegistry.import(claim);
      }
    }
    this.hostnameRegistry = hostnameRegistry;
  }

  async initialize() {}
  async findUserByEmail(email: string) { return [...this.users.values()].find((user) => user.email === email); }
  async findUserById(id: string) { return this.users.get(id); }
  async createUser(input: { email: string; displayName: string; passwordHash: string }) {
    const user = { id: randomUUID(), email: input.email, displayName: input.displayName, passwordHash: input.passwordHash, createdAt: new Date().toISOString() };
    this.users.set(user.id, user);
    return user;
  }
  async createSession(input: { tokenHash: string; userId: string; expiresAt: string }) { this.sessions.set(input.tokenHash, { userId: input.userId, expiresAt: input.expiresAt }); }
  async findUserBySession(tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= new Date().toISOString()) return undefined;
    return this.users.get(session.userId);
  }
  async deleteSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async listInstallations(userId: string) { return [...this.installations.values()].filter((item) => item.userId === userId).map((item) => ({ ...item, applications: [...this.applications.values()].filter((app) => app.installationId === item.id) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async createInstallation(input: Omit<Installation, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const installation = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.installations.set(installation.id, installation);
    return installation;
  }
  async getInstallation(userId: string, id: string) { const item = this.installations.get(id); return item?.userId === userId ? { ...item, applications: [...this.applications.values()].filter((app) => app.installationId === item.id) } : undefined; }
  async addDomain(userId: string, id: string, domain: string) {
    const item = this.installations.get(id);
    if (!item || item.userId !== userId) return undefined;
    const application = [...this.applications.values()].find((candidate) => candidate.installationId === id);
    if (!application) return undefined;
    const claim = this.hostnameRegistry.claim({ hostname: domain, surface: "application", ownerUserId: userId, resourceId: application.id }, platformHostnameSuffixes());
    if (!claim) return undefined;
    const customDomain: CustomDomain = { id: randomUUID(), applicationInstanceId: application.id, domain: claim.hostname, verificationStatus: "awaiting-dns", ownership: hostnameOwnershipInstructions(claim, config.PUBLIC_HOST_TARGET) };
    item.customDomains.push(claim.hostname);
    application.customDomains.push(customDomain);
    item.updatedAt = new Date().toISOString();
    return { installation: (await this.getInstallation(userId, id))!, domain: customDomain };
  }
  async upgrade(userId: string, id: string, plan: string) {
    const item = this.installations.get(id);
    if (!item || item.userId !== userId) return undefined;
    this.expireCheckoutCapacityHolds();
    this.expirePlanCapacityChangeHolds();
    if ([...this.checkoutCapacityHolds.values()].some((hold) => hold.installationId === id && hold.state === "active")) return undefined;
    if ([...this.planCapacityChangeHolds.values()].some((hold) => hold.installationId === id && hold.state === "active")) return undefined;
    item.plan = plan;
    item.updatedAt = new Date().toISOString();
    return this.getInstallation(userId, id);
  }
  async appendApplicationId(installationId: string, appId: string) {
    const item = this.installations.get(installationId);
    if (!item) return;
    this.expireCheckoutCapacityHolds();
    this.expirePlanCapacityChangeHolds();
    if ([...this.checkoutCapacityHolds.values()].some((hold) => hold.installationId === installationId && hold.state === "active")) return;
    if ([...this.planCapacityChangeHolds.values()].some((hold) => hold.installationId === installationId && hold.state === "active")) return;
    item.appIds.push(appId);
    item.updatedAt = new Date().toISOString();
  }
  async canReserveOnInstallationWorker(installationId: string, reservation: { memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }, memorySafetyReserveMb = 0) {
    this.expirePlanCapacityChangeHolds();
    if ([...this.planCapacityChangeHolds.values()].some((hold) => hold.installationId === installationId && hold.state === "active")) return false;
    const allocation = this.capacityAllocations.get(installationId);
    if (allocation?.state === "active") {
      const applications = [...this.applications.values()].filter((application) => application.installationId === installationId);
      if (!capacityEnvelopeFit(applicationCapacityUsage([...applications, reservation], memorySafetyReserveMb), allocation).fits) return false;
      const cutoff = Date.now() - 2 * 60_000;
      const workers = this.workersWithActiveCheckoutHolds().filter((worker) => worker.status === "ready" && new Date(worker.lastHeartbeatAt).getTime() > cutoff);
      return capacityCanFit(workers, [reservation]);
    }
    if (allocation) return false;
    const workerId = this.installations.get(installationId)?.workerNodeId;
    if (!workerId) return true;
    const worker = this.workersWithActiveCheckoutHolds().find((candidate) => candidate.id === workerId);
    return Boolean(worker && worker.reservedMemoryMb + worker.systemReserveMemoryMb + reservation.memoryReservationMb <= worker.capacityMemoryMb && worker.reservedCpuMillis + reservation.cpuReservationMillis <= worker.capacityCpuMillis && worker.reservedStorageGb + reservation.storageReservationGb <= worker.capacityStorageGb);
  }
  async hasFreshProvisioningCapacity(reservations: CapacityReservation[]) {
    const cutoff = Date.now() - 2 * 60_000;
    return capacityCanFit(this.workersWithActiveCheckoutHolds().filter((worker) => worker.status === "ready" && new Date(worker.lastHeartbeatAt).getTime() > cutoff), reservations);
  }
  private expireCheckoutCapacityHolds(now = new Date()) {
    for (const hold of this.checkoutCapacityHolds.values()) {
      if (hold.state !== "active" || new Date(hold.expiresAt).getTime() > now.getTime()) continue;
      hold.state = "expired";
      hold.expiredAt = now.toISOString();
      hold.updatedAt = hold.expiredAt;
    }
  }
  private copyCheckoutCapacityHold(hold: CheckoutCapacityHold) {
    return { ...hold, requestedAppIds: [...hold.requestedAppIds], items: hold.items.map((item) => ({ ...item })), planCapacity: { ...hold.planCapacity } };
  }
  private workersWithActiveCheckoutHolds() {
    this.expireCheckoutCapacityHolds();
    const held = new Map<string, CapacityReservation>();
    for (const hold of this.checkoutCapacityHolds.values()) {
      if (hold.state !== "active") continue;
      for (const item of hold.items) {
        const usage = held.get(item.workerNodeId) ?? { memoryReservationMb: 0, cpuReservationMillis: 0, storageReservationGb: 0 };
        usage.memoryReservationMb += item.memoryReservationMb;
        usage.cpuReservationMillis += item.cpuReservationMillis;
        usage.storageReservationGb += item.storageReservationGb;
        held.set(item.workerNodeId, usage);
      }
    }
    return [...this.workers.values()].map((worker) => {
      const usage = held.get(worker.id);
      return this.publicWorker({
        ...worker,
        reservedMemoryMb: worker.reservedMemoryMb + (usage?.memoryReservationMb ?? 0),
        reservedCpuMillis: worker.reservedCpuMillis + (usage?.cpuReservationMillis ?? 0),
        reservedStorageGb: worker.reservedStorageGb + (usage?.storageReservationGb ?? 0),
      });
    });
  }
  async acquireCheckoutCapacityHold(input: AcquireCheckoutCapacityHoldInput) {
    const now = new Date();
    const expiresAt = new Date(input.expiresAt);
    this.expireCheckoutCapacityHolds(now);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) throw new Error("Checkout capacity hold expiry must be in the future.");
    if (input.reservations.some((item) => !item.applicationInstanceId || !item.appId || item.memoryReservationMb <= 0 || item.cpuReservationMillis <= 0 || item.storageReservationGb <= 0)) throw new Error("Checkout capacity reservations are incomplete.");
    if (new Set(input.reservations.map((item) => item.applicationInstanceId)).size !== input.reservations.length) throw new Error("Checkout capacity reservations contain duplicate applications.");
    const configuredPlan = config.plans.find((plan) => plan.id === input.requestedPlan);
    if (!configuredPlan || !samePlanCapacity(input.planCapacity, planCapacitySnapshot(configuredPlan))) throw new Error("Checkout must persist the complete configured plan quota snapshot.");
    if (!capacityEnvelopeFit(applicationCapacityUsage(input.reservations), input.planCapacity).fits) throw new Error("Checkout applications exceed the configured plan quota.");
    const configuredPlatformFee = Math.max(Math.ceil(configuredPlan.infrastructureMonthlyCents * (config.PLATFORM_FEE_PERCENT / 100)), config.PLATFORM_FEE_MIN_CENTS);
    if (input.infrastructureMonthlyCents !== configuredPlan.infrastructureMonthlyCents || input.platformFeeMonthlyCents !== configuredPlatformFee) throw new Error("Checkout hold prices do not match the configured plan.");
    const existing = [...this.checkoutCapacityHolds.values()].find((hold) => hold.userId === input.userId && hold.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const sameRequest = existing.installationId === input.installationId && existing.requestedPlan === input.requestedPlan && JSON.stringify(existing.requestedAppIds) === JSON.stringify(input.requestedAppIds) && existing.infrastructureMonthlyCents === input.infrastructureMonthlyCents && existing.platformFeeMonthlyCents === input.platformFeeMonthlyCents && JSON.stringify(canonicalCapacityReservations(existing.items)) === JSON.stringify(canonicalCapacityReservations(input.reservations)) && samePlanCapacity(existing.planCapacity, input.planCapacity);
      if (!sameRequest) throw new Error("The checkout idempotency key is already bound to a different capacity request.");
      return existing.state === "active" ? this.copyCheckoutCapacityHold(existing) : undefined;
    }
    if ([...this.checkoutCapacityHolds.values()].some((hold) => hold.installationId === input.installationId && hold.state === "active")) return undefined;
    const installation = this.installations.get(input.installationId);
    if (!installation || installation.userId !== input.userId || installation.state !== "planned" || installation.plan !== input.requestedPlan || JSON.stringify(installation.appIds) !== JSON.stringify(input.requestedAppIds)) return undefined;
    const applications = [...this.applications.values()].filter((application) => application.installationId === installation.id).sort((left, right) => left.id.localeCompare(right.id));
    const requested = [...input.reservations].sort((left, right) => left.applicationInstanceId.localeCompare(right.applicationInstanceId));
    if (applications.length !== requested.length || applications.some((application, index) => {
      const reservation = requested[index];
      return application.id !== reservation.applicationInstanceId || application.appId !== reservation.appId || application.workerNodeId || application.state !== "queued" || application.memoryReservationMb !== reservation.memoryReservationMb || application.cpuReservationMillis !== reservation.cpuReservationMillis || application.storageReservationGb !== reservation.storageReservationGb;
    })) return undefined;
    const cutoff = now.getTime() - 2 * 60_000;
    const workers = this.workersWithActiveCheckoutHolds().filter((worker) => worker.status === "ready" && new Date(worker.lastHeartbeatAt).getTime() > cutoff).sort((left, right) => left.id.localeCompare(right.id));
    const assignments = allocateCapacity(workers, requested);
    if (!assignments) return undefined;
    const workerNodeId = allocationAffinityWorker(workers, assignments);
    if (!workerNodeId) return undefined;
    const createdAt = now.toISOString();
    const holdId = randomUUID();
    const hold: CheckoutCapacityHold = {
      id: holdId,
      userId: input.userId,
      installationId: input.installationId,
      idempotencyKey: input.idempotencyKey,
      requestedPlan: input.requestedPlan,
      requestedAppIds: [...input.requestedAppIds],
      infrastructureMonthlyCents: input.infrastructureMonthlyCents,
      platformFeeMonthlyCents: input.platformFeeMonthlyCents,
      state: "active",
      expiresAt: input.expiresAt,
      createdAt,
      updatedAt: createdAt,
      items: requested.map((reservation) => ({ ...reservation, id: randomUUID(), holdId, workerNodeId: assignments.get(reservation.applicationInstanceId)!, createdAt })),
      planCapacity: { ...input.planCapacity, holdId, workerNodeId, createdAt },
    };
    this.checkoutCapacityHolds.set(hold.id, hold);
    return this.copyCheckoutCapacityHold(hold);
  }
  async attachCheckoutSession(input: AttachCheckoutSessionInput) {
    this.expireCheckoutCapacityHolds();
    const hold = this.checkoutCapacityHolds.get(input.holdId);
    const sessionExpiresAt = new Date(input.stripeCheckoutExpiresAt);
    if (!hold || hold.userId !== input.userId || hold.state !== "active" || this.stripeCustomers.get(input.userId) !== input.stripeCustomerId || !Number.isFinite(sessionExpiresAt.getTime()) || sessionExpiresAt <= new Date() || sessionExpiresAt > new Date(hold.expiresAt)) return false;
    if ([...this.checkoutCapacityHolds.values()].some((candidate) => candidate.id !== hold.id && candidate.stripeCheckoutSessionId === input.stripeCheckoutSessionId)) return false;
    if ((hold.stripeCustomerId && hold.stripeCustomerId !== input.stripeCustomerId) || (hold.stripeCheckoutSessionId && hold.stripeCheckoutSessionId !== input.stripeCheckoutSessionId) || (hold.stripeCheckoutExpiresAt && hold.stripeCheckoutExpiresAt !== input.stripeCheckoutExpiresAt)) return false;
    hold.stripeCustomerId = input.stripeCustomerId;
    hold.stripeCheckoutSessionId = input.stripeCheckoutSessionId;
    hold.stripeCheckoutExpiresAt = input.stripeCheckoutExpiresAt;
    hold.updatedAt = new Date().toISOString();
    return true;
  }
  async releaseCheckoutCapacityHold(holdId: string, userId: string, reason: string) {
    this.expireCheckoutCapacityHolds();
    const hold = this.checkoutCapacityHolds.get(holdId);
    if (!hold || hold.userId !== userId || hold.state !== "active") return false;
    hold.state = "released";
    hold.releasedAt = new Date().toISOString();
    hold.releaseReason = reason.slice(0, 500);
    hold.updatedAt = hold.releasedAt;
    return true;
  }
  async getCheckoutCapacityHold(holdId: string) {
    this.expireCheckoutCapacityHolds();
    const hold = this.checkoutCapacityHolds.get(holdId);
    return hold ? this.copyCheckoutCapacityHold(hold) : undefined;
  }
  async hasActiveCheckoutCapacityHold(installationId: string) {
    this.expireCheckoutCapacityHolds();
    return [...this.checkoutCapacityHolds.values()].some((hold) => hold.installationId === installationId && hold.state === "active");
  }
  async createApplicationInstances(installationId: string, apps: Array<{ appId: string; memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }>, hostnameBase: string, memorySafetyReserveMb = 0) {
    this.expireCheckoutCapacityHolds();
    this.expirePlanCapacityChangeHolds();
    if ([...this.checkoutCapacityHolds.values()].some((hold) => hold.installationId === installationId && hold.state === "active")) throw new Error("The installation has an active checkout capacity hold.");
    if ([...this.planCapacityChangeHolds.values()].some((hold) => hold.installationId === installationId && hold.state === "active")) throw new Error("The installation has an active plan quota change hold.");
    const allocation = this.capacityAllocations.get(installationId);
    if (allocation && allocation.state !== "active") throw new Error("The paid plan quota is not active.");
    const now = new Date().toISOString();
    const prepared = apps.map((app) => ({ ...app, id: randomUUID() }));
    let assignments: Map<string, string> | undefined;
    if (allocation?.state === "active") {
      const existing = [...this.applications.values()].filter((application) => application.installationId === installationId);
      if (!capacityEnvelopeFit(applicationCapacityUsage([...existing, ...apps], memorySafetyReserveMb), allocation).fits) throw new Error("The paid plan quota cannot contain these additional applications.");
      const cutoff = Date.now() - 2 * 60_000;
      const workers = this.workersWithActiveCheckoutHolds().filter((worker) => worker.status === "ready" && new Date(worker.lastHeartbeatAt).getTime() > cutoff).sort((left, right) => left.id.localeCompare(right.id));
      const placement = allocateCapacity(workers, prepared.map((item) => ({ applicationInstanceId: item.id, appId: item.appId, memoryReservationMb: item.memoryReservationMb, cpuReservationMillis: item.cpuReservationMillis, storageReservationGb: item.storageReservationGb })));
      if (!placement) throw new Error("The worker pool cannot reserve these application resources.");
      assignments = placement;
    }
    const created = prepared.map(({ id, appId, memoryReservationMb, cpuReservationMillis, storageReservationGb }) => {
      const workerNodeId = assignments?.get(id);
      if (workerNodeId) {
        const worker = this.workers.get(workerNodeId)!;
        worker.reservedMemoryMb += memoryReservationMb;
        worker.reservedCpuMillis += cpuReservationMillis;
        worker.reservedStorageGb += storageReservationGb;
      }
      const instance: ApplicationInstance = { id, installationId, appId, state: "queued", hostname: `${appId}-${id.slice(0, 8)}.${hostnameBase}`, containerProject: `mos-${id.replaceAll("-", "").slice(0, 12)}`, customDomains: [], ...(workerNodeId ? { workerNodeId } : {}), memoryReservationMb, cpuReservationMillis, storageReservationGb, createdAt: now, updatedAt: now };
      this.applications.set(id, instance);
      return instance;
    });
    return created;
  }
  async createApplicationClone(input: CreateApplicationCloneInput): Promise<ApplicationCloneResult> {
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new Error("Clone idempotency key must contain 16 to 200 characters.");
    const key = `${input.userId}:${idempotencyKey}`;
    const requestHash = cloneRequestHash(input);
    const replay = this.cloneIdempotency.get(key);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new Error("The clone idempotency key is already bound to a different request.");
      const application = this.applications.get(replay.applicationId);
      if (!application) throw new Error("The idempotent clone application is missing.");
      return { application: { ...application }, job: replay.jobId ? this.jobs.get(replay.jobId) : undefined, replayed: true };
    }
    this.expireCheckoutCapacityHolds();
    this.expirePlanCapacityChangeHolds();
    const installation = this.installations.get(input.installationId);
    if (!installation || installation.userId !== input.userId) throw new Error("Installation not found.");
    if ([...this.checkoutCapacityHolds.values()].some((hold) => hold.installationId === installation.id && hold.state === "active")) throw new Error("The installation has an active checkout capacity hold.");
    if ([...this.planCapacityChangeHolds.values()].some((hold) => hold.installationId === installation.id && hold.state === "active")) throw new Error("The installation has an active plan quota change hold.");
    if (config.HOSTING_ENTITLEMENT_MODE === "hosted" && installation.state !== "planned" && !hostingEntitlementActive(this.subscriptions.values(), installation.id)) throw new Error("Reactivate this server subscription before cloning another service.");
    const allocation = this.capacityAllocations.get(installation.id);
    if (allocation && allocation.state !== "active") throw new Error("The paid plan quota is not active.");
    const configuredPlan = config.plans.find((plan) => plan.id === installation.plan);
    const envelope = allocation ?? (configuredPlan ? planCapacitySnapshot(configuredPlan) : undefined);
    if (!envelope) throw new Error("Upgrade this legacy server to a current plan before cloning services.");
    const existing = [...this.applications.values()].filter((application) => application.installationId === installation.id);
    if (!capacityEnvelopeFit(applicationCapacityUsage([...existing, input.app], input.memorySafetyReserveMb), envelope).fits) throw new Error("The paid plan quota cannot contain this additional application.");
    const applicationId = randomUUID();
    let workerNodeId: string | undefined;
    if (allocation) {
      const cutoff = Date.now() - 2 * 60_000;
      const workers = this.workersWithActiveCheckoutHolds().filter((worker) => worker.status === "ready" && new Date(worker.lastHeartbeatAt).getTime() > cutoff).sort((left, right) => left.id.localeCompare(right.id));
      const placement = allocateCapacity(workers, [{ ...input.app, applicationInstanceId: applicationId }]);
      workerNodeId = placement ? placement.get(applicationId) : undefined;
      if (!workerNodeId) throw new Error("The worker pool cannot reserve this application.");
    }
    const now = new Date().toISOString();
    const application: ApplicationInstance = { id: applicationId, installationId: installation.id, appId: input.app.appId, state: "queued", hostname: `${input.app.appId}-${applicationId.slice(0, 8)}.${input.hostnameBase}`, containerProject: `mos-${applicationId.replaceAll("-", "").slice(0, 12)}`, customDomains: [], ...(workerNodeId ? { workerNodeId } : {}), memoryReservationMb: input.app.memoryReservationMb, cpuReservationMillis: input.app.cpuReservationMillis, storageReservationGb: input.app.storageReservationGb, createdAt: now, updatedAt: now };
    this.applications.set(application.id, application);
    installation.appIds.push(application.appId);
    installation.updatedAt = now;
    if (workerNodeId) {
      const worker = this.workers.get(workerNodeId)!;
      worker.reservedMemoryMb += application.memoryReservationMb;
      worker.reservedCpuMillis += application.cpuReservationMillis;
      worker.reservedStorageGb += application.storageReservationGb;
    }
    let job: ProvisioningJob | undefined;
    if (installation.state === "live") {
      job = { id: randomUUID(), installationId: installation.id, action: "install", status: "queued", attempts: 0, payload: { applicationInstanceId: application.id, cloneIdempotencyKey: idempotencyKey }, workerNodeId, createdAt: now };
      this.jobs.set(job.id, job);
    }
    this.cloneIdempotency.set(key, { userId: input.userId, requestHash, installationId: installation.id, appId: application.appId, applicationId: application.id, ...(job ? { jobId: job.id } : {}) });
    return { application: { ...application }, ...(job ? { job: { ...job } } : {}), replayed: false };
  }
  async getApplicationInstance(userId: string, id: string) {
    const instance = this.applications.get(id);
    return instance && this.installations.get(instance.installationId)?.userId === userId ? instance : undefined;
  }
  async updateInstallationState(id: string, state: Installation["state"], failureReason?: string) { const item = this.installations.get(id); if (item) { item.state = state; item.failureReason = failureReason; item.updatedAt = new Date().toISOString(); } }
  async updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string) { const item = this.applications.get(id); if (item) { item.state = state; item.lastHealthAt = healthAt; item.updatedAt = new Date().toISOString(); } }
  async enqueueJob(installationId: string, action: ProvisioningJob["action"], payload: Record<string, unknown> = {}) { const target = typeof payload.applicationInstanceId === "string" ? this.applications.get(payload.applicationInstanceId) : undefined; const job: ProvisioningJob = { id: randomUUID(), installationId, action, status: "queued", attempts: 0, payload, workerNodeId: target?.workerNodeId ?? this.installations.get(installationId)?.workerNodeId, createdAt: new Date().toISOString() }; this.jobs.set(job.id, job); return job; }
  async setDomainStatus(userId: string, installationId: string, domain: string, status: CustomDomain["verificationStatus"]) {
    const installation = this.installations.get(installationId);
    const application = [...this.applications.values()].find((candidate) => candidate.installationId === installationId);
    const item = application?.customDomains.find((candidate) => candidate.domain === domain);
    if (!installation || installation.userId !== userId || !application || !item || status === "failed") return undefined;
    const claimStatus = status === "awaiting-dns" ? "pending" : status;
    const claim = this.hostnameRegistry.setStatus({ hostname: domain, surface: "application", ownerUserId: userId, resourceId: application.id }, claimStatus);
    if (!claim) return undefined;
    item.verificationStatus = status;
    item.lastCheckedAt = claim.lastCheckedAt;
    return item;
  }
  async getOrCreateStripeCustomer(userId: string, create: () => Promise<string>) { const existing = this.stripeCustomers.get(userId); if (existing) return existing; const id = await create(); this.stripeCustomers.set(userId, id); return id; }
  async recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) { const existing = this.subscriptions.get(input.providerSubscriptionId); this.subscriptions.set(input.providerSubscriptionId, { id: existing?.id ?? randomUUID(), ...input, installationPlan: this.installations.get(input.installationId)?.plan }); }
  async listSubscriptions() { return [...this.subscriptions.values()].map((item) => ({ ...item, installationPlan: item.installationId ? this.installations.get(item.installationId)?.plan : undefined })); }
  private synchronizeCapacityAllocationEntitlement(installationId: string, entitlementActive: boolean, reason: string) {
    const allocation = this.capacityAllocations.get(installationId);
    if (!allocation) return;
    const now = new Date().toISOString();
    if (!entitlementActive && allocation.state === "active") {
      for (const hold of this.planCapacityChangeHolds.values()) {
        if (hold.installationId !== installationId || hold.state !== "active") continue;
        hold.state = "released";
        hold.releasedAt = now;
        hold.releaseReason = reason.slice(0, 500);
        hold.updatedAt = now;
      }
      Object.assign(allocation, { state: "suspended" as const, generation: allocation.generation + 1, suspendedAt: now, releaseReason: reason.slice(0, 500), updatedAt: now });
    } else if (entitlementActive && allocation.state === "suspended") {
      Object.assign(allocation, { state: "active" as const, generation: allocation.generation + 1, suspendedAt: undefined, releaseReason: undefined, updatedAt: now });
    }
  }
  async applySubscriptionReconciliation(input: { deactivateSubscriptionIds: string[]; upsertSubscriptions: ReconciledSubscription[]; affectedUserIds: string[] }) {
    for (const item of this.subscriptions.values()) if (input.deactivateSubscriptionIds.includes(item.id)) item.status = "inactive";
    for (const item of input.upsertSubscriptions) await this.recordSubscription(item);
    for (const userId of new Set(input.affectedUserIds)) {
      for (const installation of this.installations.values()) {
        if (installation.userId !== userId || installation.state === "planned") continue;
        const entitled = hostingEntitlementActive(this.subscriptions.values(), installation.id);
        this.synchronizeCapacityAllocationEntitlement(installation.id, entitled, "Subscription reconciliation changed this capacity entitlement.");
        if (!entitled) {
          installation.state = "suspended";
          installation.failureReason = "Subscription reconciliation suspended this server.";
          for (const job of this.jobs.values()) if (job.installationId === installation.id && ["queued", "running"].includes(job.status) && ["install", "upgrade", "start", "restore"].includes(job.action)) {
            job.status = "failed";
            job.leaseExpiresAt = undefined;
          }
          for (const app of this.applications.values()) if (app.installationId === installation.id && app.workerNodeId && ["live", "provisioning"].includes(app.state) && ![...this.jobs.values()].some((job) => job.installationId === installation.id && job.action === "stop" && ["queued", "running"].includes(job.status) && job.payload.applicationInstanceId === app.id)) await this.enqueueJob(installation.id, "stop", { applicationInstanceId: app.id, reason: "subscription_reconciliation" });
        } else if (installation.state === "suspended") {
          installation.state = [...this.applications.values()].some((app) => app.installationId === installation.id && app.state === "live") ? "live" : "provisioning";
          installation.failureReason = undefined;
        }
        installation.updatedAt = new Date().toISOString();
      }
    }
    return Promise.all([...new Set(input.affectedUserIds)].sort().map(async (userId) => ({ userId, plan: await this.getEffectiveSuitePlan(userId), suiteWorkspaceUpdated: false })));
  }
  async getActiveSubscription(userId: string, installationId: string) { const item = [...this.subscriptions.values()].find((candidate) => candidate.userId === userId && candidate.installationId === installationId && ["active", "trialing"].includes(candidate.status) && candidate.providerSubscriptionId); return item?.providerSubscriptionId ? { providerSubscriptionId: item.providerSubscriptionId } : undefined; }
  async updateSubscriptionStatus(providerSubscriptionId: string, status: string) {
    const item = this.subscriptions.get(providerSubscriptionId);
    if (!item?.installationId || !item.providerSubscriptionId) return undefined;
    item.status = status;
    const installation = this.installations.get(item.installationId);
    const entitlementActive = hostingEntitlementActive(this.subscriptions.values(), item.installationId);
    this.synchronizeCapacityAllocationEntitlement(item.installationId, entitlementActive, "Subscription became inactive.");
    if (installation && !entitlementActive) {
      installation.state = "suspended";
      installation.failureReason = "Subscription inactive; customer routes and paid mutations are suspended.";
      installation.updatedAt = new Date().toISOString();
      for (const job of this.jobs.values()) if (job.installationId === installation.id && ["queued", "running"].includes(job.status) && ["install", "upgrade", "start", "restore"].includes(job.action)) {
        job.status = "failed";
        job.leaseExpiresAt = undefined;
      }
      for (const app of this.applications.values()) if (app.installationId === installation.id && app.workerNodeId && ["live", "provisioning"].includes(app.state) && ![...this.jobs.values()].some((job) => job.installationId === installation.id && job.action === "stop" && ["queued", "running"].includes(job.status) && job.payload.applicationInstanceId === app.id)) await this.enqueueJob(installation.id, "stop", { applicationInstanceId: app.id, reason: "subscription_inactive" });
    } else if (installation && entitlementActive && installation.state === "suspended") {
      installation.state = [...this.applications.values()].some((app) => app.installationId === installation.id && app.state === "live") ? "live" : "provisioning";
      installation.failureReason = undefined;
      installation.updatedAt = new Date().toISOString();
    }
    return { userId: item.userId, installationId: item.installationId };
  }
  async getEffectiveSuitePlan(userId: string): Promise<SuitePlanId> { const rank = { starter: 0, scale: 1, fleet: 2 }; const plans = [...this.subscriptions.values()].filter((item) => item.userId === userId && ["active", "trialing"].includes(item.status) && item.installationId).map((item) => item.installationId ? this.installations.get(item.installationId)?.plan : undefined).filter((plan): plan is "starter" | "scale" | "fleet" => plan === "starter" || plan === "scale" || plan === "fleet"); return plans.sort((a, b) => rank[b] - rank[a])[0] ?? "none"; }
  async hasProcessedStripeEvent(eventId: string) { return this.stripeEvents.has(eventId); }
  async markStripeEventProcessed(eventId: string) { this.stripeEvents.add(eventId); }
  private paidCheckoutAssignments(hold: CheckoutCapacityHold) {
    if (hold.state === "active") return new Map(hold.items.map((item) => [item.applicationInstanceId, item.workerNodeId]));
    const cutoff = Date.now() - 2 * 60_000;
    const workers = this.workersWithActiveCheckoutHolds().filter((worker) => worker.status === "ready" && new Date(worker.lastHeartbeatAt).getTime() > cutoff).sort((left, right) => left.id.localeCompare(right.id));
    return allocateCapacity(workers, hold.items);
  }
  private fulfillPaidCheckout(input: ProcessPaidCheckoutInput, hold: CheckoutCapacityHold, assignments: Map<string, string>, recovery?: PaidCheckoutCapacityRecovery) {
    const installation = this.installations.get(input.installationId)!;
    const items = [...hold.items].sort((left, right) => left.applicationInstanceId.localeCompare(right.applicationInstanceId));
    const affinityWorker = assignments.values().next().value ?? this.workersWithActiveCheckoutHolds().find((worker) => worker.status === "ready")?.id;
    if (!affinityWorker) throw new Error("No healthy worker is available for the paid plan affinity.");
    const now = new Date().toISOString();
    const allocation: InstallationCapacityAllocation = { id: randomUUID(), installationId: installation.id, workerNodeId: affinityWorker, planId: hold.planCapacity.planId, memoryMb: hold.planCapacity.memoryMb, cpuMillis: hold.planCapacity.cpuMillis, storageGb: hold.planCapacity.storageGb, maxServices: hold.planCapacity.maxServices, generation: 1, state: "active", sourceCheckoutHoldId: hold.id, createdAt: now, updatedAt: now };
    this.capacityAllocations.set(installation.id, allocation);
    for (const item of items) {
      const application = this.applications.get(item.applicationInstanceId)!;
      const workerNodeId = assignments.get(item.applicationInstanceId);
      const worker = workerNodeId ? this.workers.get(workerNodeId) : undefined;
      if (!workerNodeId || !worker) throw new Error("A paid checkout application lost its atomic worker placement.");
      worker.reservedMemoryMb += item.memoryReservationMb;
      worker.reservedCpuMillis += item.cpuReservationMillis;
      worker.reservedStorageGb += item.storageReservationGb;
      application.workerNodeId = workerNodeId;
      application.updatedAt = now;
      const job: ProvisioningJob = { id: randomUUID(), installationId: installation.id, action: "install", status: "queued", attempts: 0, payload: { stripeEventId: input.eventId, capacityHoldId: hold.id, applicationInstanceId: application.id, ...(recovery ? { paidCapacityRecoveryId: recovery.id } : {}) }, workerNodeId, createdAt: now };
      this.jobs.set(job.id, job);
    }
    const existingSubscription = this.subscriptions.get(input.providerSubscriptionId);
    this.subscriptions.set(input.providerSubscriptionId, { id: existingSubscription?.id ?? randomUUID(), userId: input.userId, installationId: input.installationId, providerSubscriptionId: input.providerSubscriptionId, status: "active", infrastructureMonthlyCents: input.infrastructureMonthlyCents, platformFeeMonthlyCents: input.platformFeeMonthlyCents, installationPlan: installation.plan });
    installation.state = items.length ? "provisioning" : "live";
    installation.workerNodeId = allocation.workerNodeId;
    installation.updatedAt = now;
    if (hold.state === "active") {
      hold.state = "consumed";
      hold.providerSubscriptionId = input.providerSubscriptionId;
      hold.consumedAt = now;
      hold.updatedAt = now;
    }
    if (recovery) {
      recovery.state = "fulfilled";
      recovery.attemptCount += 1;
      recovery.lastAttemptAt = now;
      recovery.fulfilledAt = now;
      recovery.lastError = undefined;
      recovery.updatedAt = now;
    }
  }
  async processPaidCheckout(input: ProcessPaidCheckoutInput) {
    if (this.stripeEvents.has(input.eventId)) return false;
    this.expireCheckoutCapacityHolds();
    const hold = this.checkoutCapacityHolds.get(input.holdId);
    const installation = this.installations.get(input.installationId);
    if (!hold || !["active", "expired"].includes(hold.state) || hold.userId !== input.userId || hold.installationId !== input.installationId || hold.stripeCheckoutSessionId !== input.stripeCheckoutSessionId || hold.stripeCustomerId !== input.stripeCustomerId || this.stripeCustomers.get(input.userId) !== input.stripeCustomerId || hold.infrastructureMonthlyCents !== input.infrastructureMonthlyCents || hold.platformFeeMonthlyCents !== input.platformFeeMonthlyCents) throw new Error("Paid checkout did not match an exact owned capacity hold and Stripe session.");
    if (!installation || installation.userId !== input.userId || installation.state !== "planned" || installation.plan !== hold.requestedPlan || JSON.stringify(installation.appIds) !== JSON.stringify(hold.requestedAppIds)) throw new Error("Paid checkout capacity snapshot no longer matches the planned installation.");
    if (this.subscriptions.has(input.providerSubscriptionId)) throw new Error("Provider subscription is already bound to another checkout.");
    const applications = [...this.applications.values()].filter((application) => application.installationId === installation.id).sort((left, right) => left.id.localeCompare(right.id));
    const items = [...hold.items].sort((left, right) => left.applicationInstanceId.localeCompare(right.applicationInstanceId));
    if (applications.length !== items.length || applications.some((application, index) => {
      const item = items[index];
      return application.id !== item.applicationInstanceId || application.appId !== item.appId || application.state !== "queued" || application.workerNodeId || application.memoryReservationMb !== item.memoryReservationMb || application.cpuReservationMillis !== item.cpuReservationMillis || application.storageReservationGb !== item.storageReservationGb || (hold.state === "active" && !this.workers.has(item.workerNodeId));
    })) throw new Error("Paid checkout capacity items no longer match the planned applications.");
    if (this.capacityAllocations.has(installation.id)) throw new Error("The planned installation already owns a capacity allocation.");
    const assignments = this.paidCheckoutAssignments(hold);
    if (!assignments) {
      const now = new Date();
      const deadline = new Date(input.compensationDeadlineAt ?? now.getTime() + config.PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS);
      if (!Number.isFinite(deadline.getTime()) || deadline <= now) throw new Error("Paid checkout capacity recovery deadline must be in the future.");
      const recovery: PaidCheckoutCapacityRecovery = { id: randomUUID(), stripeEventId: input.eventId, checkoutHoldId: hold.id, userId: input.userId, installationId: input.installationId, stripeCheckoutSessionId: input.stripeCheckoutSessionId, stripeCustomerId: input.stripeCustomerId, providerSubscriptionId: input.providerSubscriptionId, infrastructureMonthlyCents: input.infrastructureMonthlyCents, platformFeeMonthlyCents: input.platformFeeMonthlyCents, state: "pending_capacity", attemptCount: 1, compensationDeadlineAt: deadline.toISOString(), compensationAction: "cancel_subscription_and_refund_captured_payment", lastAttemptAt: now.toISOString(), lastError: "No recently healthy worker could atomically place the paid checkout.", createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.paidCheckoutCapacityRecoveries.set(input.providerSubscriptionId, recovery);
      this.subscriptions.set(input.providerSubscriptionId, { id: randomUUID(), userId: input.userId, installationId: input.installationId, providerSubscriptionId: input.providerSubscriptionId, status: "paid_pending_capacity", infrastructureMonthlyCents: input.infrastructureMonthlyCents, platformFeeMonthlyCents: input.platformFeeMonthlyCents, installationPlan: installation.plan });
    } else {
      let recovery: PaidCheckoutCapacityRecovery | undefined;
      if (hold.state === "expired") {
        const now = new Date();
        const deadline = new Date(input.compensationDeadlineAt ?? now.getTime() + config.PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS);
        recovery = { id: randomUUID(), stripeEventId: input.eventId, checkoutHoldId: hold.id, userId: input.userId, installationId: input.installationId, stripeCheckoutSessionId: input.stripeCheckoutSessionId, stripeCustomerId: input.stripeCustomerId, providerSubscriptionId: input.providerSubscriptionId, infrastructureMonthlyCents: input.infrastructureMonthlyCents, platformFeeMonthlyCents: input.platformFeeMonthlyCents, state: "pending_capacity", attemptCount: 0, compensationDeadlineAt: deadline.toISOString(), compensationAction: "cancel_subscription_and_refund_captured_payment", createdAt: now.toISOString(), updatedAt: now.toISOString() };
        this.paidCheckoutCapacityRecoveries.set(input.providerSubscriptionId, recovery);
      }
      this.fulfillPaidCheckout(input, hold, assignments, recovery);
    }
    this.stripeEvents.add(input.eventId);
    return true;
  }
  async getPaidCheckoutCapacityRecovery(providerSubscriptionId: string) { const recovery = this.paidCheckoutCapacityRecoveries.get(providerSubscriptionId); return recovery ? { ...recovery } : undefined; }
  async advancePaidCheckoutCapacityRecovery(providerSubscriptionId: string) {
    const recovery = this.paidCheckoutCapacityRecoveries.get(providerSubscriptionId);
    if (!recovery || recovery.state !== "pending_capacity" || new Date(recovery.compensationDeadlineAt) > new Date()) return recovery ? { ...recovery } : undefined;
    const subscription = this.subscriptions.get(providerSubscriptionId);
    if (!subscription || subscription.status !== "paid_pending_capacity" || subscription.userId !== recovery.userId || subscription.installationId !== recovery.installationId) throw new Error("Pending paid capacity recovery lost its exact local subscription obligation.");
    const now = new Date().toISOString();
    recovery.state = "compensation_required";
    recovery.compensationRequiredAt = now;
    recovery.lastAttemptAt = now;
    recovery.attemptCount += 1;
    recovery.lastError = "Capacity recovery deadline elapsed; cancel the provider subscription and refund the captured payment.";
    recovery.updatedAt = now;
    subscription.status = "compensation_required";
    return { ...recovery };
  }
  async retryPaidCheckoutCapacityRecovery(confirmation: PaidCheckoutProviderConfirmation) {
    const recovery = this.paidCheckoutCapacityRecoveries.get(confirmation.providerSubscriptionId);
    if (!recovery || recovery.state !== "pending_capacity") return recovery ? { ...recovery } : undefined;
    if (new Date() >= new Date(recovery.compensationDeadlineAt)) return this.advancePaidCheckoutCapacityRecovery(confirmation.providerSubscriptionId);
    if (confirmation.problems.length || !["active", "trialing"].includes(confirmation.status) || confirmation.userId !== recovery.userId || confirmation.installationId !== recovery.installationId || confirmation.capacityHoldId !== recovery.checkoutHoldId || confirmation.customerId !== recovery.stripeCustomerId || confirmation.infrastructureMonthlyCents !== recovery.infrastructureMonthlyCents || confirmation.platformFeeMonthlyCents !== recovery.platformFeeMonthlyCents) throw new Error("Provider confirmation did not exactly match the pending paid capacity obligation.");
    const now = new Date();
    const hold = this.checkoutCapacityHolds.get(recovery.checkoutHoldId);
    if (!hold || hold.state !== "expired") throw new Error("Pending paid capacity recovery lost its immutable expired checkout hold.");
    const assignments = this.paidCheckoutAssignments(hold);
    if (!assignments) {
      recovery.attemptCount += 1;
      recovery.lastAttemptAt = now.toISOString();
      recovery.lastError = "No recently healthy worker could atomically place the pending paid checkout.";
      recovery.updatedAt = now.toISOString();
      return { ...recovery };
    }
    this.fulfillPaidCheckout({ eventId: recovery.stripeEventId, eventType: "checkout.session.completed", holdId: recovery.checkoutHoldId, userId: recovery.userId, installationId: recovery.installationId, stripeCheckoutSessionId: recovery.stripeCheckoutSessionId, stripeCustomerId: recovery.stripeCustomerId, providerSubscriptionId: recovery.providerSubscriptionId, infrastructureMonthlyCents: recovery.infrastructureMonthlyCents, platformFeeMonthlyCents: recovery.platformFeeMonthlyCents }, hold, assignments, recovery);
    return { ...recovery };
  }
  async markPaidCheckoutCapacityCompensated(providerSubscriptionId: string, compensationReference: string) {
    const recovery = this.paidCheckoutCapacityRecoveries.get(providerSubscriptionId);
    const reference = compensationReference.trim();
    if (!recovery || recovery.state !== "compensation_required" || !reference) return undefined;
    const subscription = this.subscriptions.get(providerSubscriptionId);
    if (!subscription || subscription.status !== "compensation_required" || subscription.userId !== recovery.userId || subscription.installationId !== recovery.installationId) throw new Error("Compensation cannot be recorded without the exact local paid-capacity obligation.");
    const now = new Date().toISOString();
    recovery.state = "compensated";
    recovery.compensatedAt = now;
    recovery.compensationReference = reference;
    recovery.updatedAt = now;
    subscription.status = "canceled";
    return { ...recovery };
  }
  private expirePlanCapacityChangeHolds() {
    const now = new Date();
    for (const hold of this.planCapacityChangeHolds.values()) if (hold.state === "active" && new Date(hold.expiresAt) <= now) {
      hold.state = "expired";
      hold.expiredAt = now.toISOString();
      hold.updatedAt = hold.expiredAt;
    }
  }
  async getInstallationCapacityAllocation(userId: string, installationId: string) {
    const allocation = this.capacityAllocations.get(installationId);
    return allocation && this.installations.get(installationId)?.userId === userId ? { ...allocation } : undefined;
  }
  async acquirePlanCapacityChangeHold(input: AcquirePlanCapacityChangeHoldInput) {
    this.expirePlanCapacityChangeHolds();
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new Error("Plan capacity change hold expiry must be in the future.");
    const configured = config.plans.find((plan) => plan.id === input.requested.planId);
    if (!configured || !samePlanCapacity(input.requested, planCapacitySnapshot(configured))) throw new Error("Plan resize must hold the complete configured target quota.");
    const configuredPlatformFee = Math.max(Math.ceil(configured.infrastructureMonthlyCents * (config.PLATFORM_FEE_PERCENT / 100)), config.PLATFORM_FEE_MIN_CENTS);
    if (input.infrastructureMonthlyCents !== configured.infrastructureMonthlyCents || input.platformFeeMonthlyCents !== configuredPlatformFee) throw new Error("Plan resize prices do not match the configured target plan.");
    const existing = [...this.planCapacityChangeHolds.values()].find((hold) => hold.userId === input.userId && hold.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const same = existing.installationId === input.installationId && existing.providerSubscriptionId === input.providerSubscriptionId && samePlanCapacity(existing, input.requested) && existing.infrastructureMonthlyCents === input.infrastructureMonthlyCents && existing.platformFeeMonthlyCents === input.platformFeeMonthlyCents;
      if (!same) throw new Error("The resize idempotency key is already bound to a different plan capacity request.");
      return existing.state === "active" ? { ...existing } : undefined;
    }
    if ([...this.planCapacityChangeHolds.values()].some((hold) => hold.installationId === input.installationId && hold.state === "active")) return undefined;
    const installation = this.installations.get(input.installationId);
    const allocation = this.capacityAllocations.get(input.installationId);
    if (!installation || installation.userId !== input.userId || !allocation || allocation.state !== "active" || allocation.planId !== installation.plan || allocation.workerNodeId !== installation.workerNodeId) return undefined;
    const applications = [...this.applications.values()].filter((application) => application.installationId === installation.id);
    if (!capacityEnvelopeFit(applicationCapacityUsage(applications, input.memorySafetyReserveMb), input.requested).fits) return undefined;
    const delta = positiveCapacityDelta(allocation, input.requested);
    const now = new Date().toISOString();
    const hold: PlanCapacityChangeHold = { ...input.requested, id: randomUUID(), userId: input.userId, installationId: installation.id, allocationId: allocation.id, idempotencyKey: input.idempotencyKey, expectedGeneration: allocation.generation, fromPlan: allocation.planId, workerNodeId: allocation.workerNodeId, reservedDeltaMemoryMb: delta.memoryMb, reservedDeltaCpuMillis: delta.cpuMillis, reservedDeltaStorageGb: delta.storageGb, infrastructureMonthlyCents: input.infrastructureMonthlyCents, platformFeeMonthlyCents: input.platformFeeMonthlyCents, providerSubscriptionId: input.providerSubscriptionId, state: "active", expiresAt: input.expiresAt, createdAt: now, updatedAt: now };
    this.planCapacityChangeHolds.set(hold.id, hold);
    return { ...hold };
  }
  async getPlanCapacityChangeHold(holdId: string) {
    this.expirePlanCapacityChangeHolds();
    const hold = this.planCapacityChangeHolds.get(holdId);
    return hold ? { ...hold } : undefined;
  }
  async releasePlanCapacityChangeHold(holdId: string, userId: string, reason: string) {
    this.expirePlanCapacityChangeHolds();
    const hold = this.planCapacityChangeHolds.get(holdId);
    if (!hold || hold.userId !== userId || hold.state !== "active") return false;
    hold.state = "released";
    hold.releasedAt = new Date().toISOString();
    hold.releaseReason = reason.slice(0, 500);
    hold.updatedAt = hold.releasedAt;
    return true;
  }
  async consumePlanCapacityChangeHold(holdId: string, userId: string, providerConfirmationSource = "provider_update_response") {
    this.expirePlanCapacityChangeHolds();
    const hold = this.planCapacityChangeHolds.get(holdId);
    const allocation = hold ? this.capacityAllocations.get(hold.installationId) : undefined;
    if (hold?.state === "consumed" && allocation?.generation === hold.expectedGeneration + 1 && allocation.planId === hold.planId) return { ...allocation };
    const confirmationSource = providerConfirmationSource.trim().slice(0, 100);
    if (!confirmationSource || !hold || hold.userId !== userId || !["active", "expired"].includes(hold.state) || !allocation || allocation.id !== hold.allocationId || allocation.generation !== hold.expectedGeneration || allocation.planId !== hold.fromPlan || allocation.workerNodeId !== hold.workerNodeId) return undefined;
    const installation = this.installations.get(hold.installationId);
    const subscription = this.subscriptions.get(hold.providerSubscriptionId);
    if (!installation || installation.userId !== userId || installation.plan !== hold.fromPlan || subscription?.installationId !== installation.id || !["active", "trialing"].includes(subscription.status)) return undefined;
    Object.assign(allocation, { planId: hold.planId, memoryMb: hold.memoryMb, cpuMillis: hold.cpuMillis, storageGb: hold.storageGb, maxServices: hold.maxServices, generation: allocation.generation + 1, updatedAt: new Date().toISOString() });
    installation.plan = hold.planId;
    installation.updatedAt = allocation.updatedAt;
    subscription.infrastructureMonthlyCents = hold.infrastructureMonthlyCents;
    subscription.platformFeeMonthlyCents = hold.platformFeeMonthlyCents;
    subscription.installationPlan = hold.planId;
    hold.state = "consumed";
    hold.consumedAt = allocation.updatedAt;
    hold.providerCommittedAt = allocation.updatedAt;
    hold.providerConfirmationSource = confirmationSource;
    hold.updatedAt = allocation.updatedAt;
    return { ...allocation };
  }
  async listBackups(userId: string, installationId: string) { return this.installations.get(installationId)?.userId === userId ? this.backups.filter((item) => item.installationId === installationId) : []; }
  private publicWorker(worker: WorkerNode & { agentTokenHash: string }): WorkerNode { const { agentTokenHash: _hidden, ...item } = worker; return item; }
  private workerActivity(nodeId: string): WorkerNodeActivity | undefined {
    const worker = this.workers.get(nodeId);
    if (!worker) return undefined;
    const runningJobs = [...this.jobs.values()].filter((job) => job.workerNodeId === nodeId && job.status === "running").map(({ payload: _payload, attempts: _attempts, ...job }) => job);
    const assignedApplications = [...this.applications.values()].filter((application) => application.workerNodeId === nodeId).map(({ id, installationId, appId, state }) => ({ id, installationId, appId, state }));
    return { node: this.publicWorker(worker), mode: worker.status === "ready" ? "active" : worker.status, runningJobs, assignedApplications, safeToReplaceAgent: runningJobs.length === 0 };
  }
  async registerWorkerNode(input: WorkerRegistration) {
    const now = new Date().toISOString();
    const token = newAgentToken();
    const previous = this.workers.get(input.id);
    const worker: WorkerNode & { agentTokenHash: string } = { ...input, status: "ready", reservedMemoryMb: previous?.reservedMemoryMb ?? 0, reservedCpuMillis: previous?.reservedCpuMillis ?? 0, reservedStorageGb: previous?.reservedStorageGb ?? 0, agentTokenHash: agentTokenHash(token), lastHeartbeatAt: now, createdAt: previous?.createdAt ?? now, updatedAt: now };
    this.workers.set(worker.id, worker);
    return { node: this.publicWorker(worker), agentToken: token };
  }
  async findWorkerNodeByAgentToken(token: string) { const worker = [...this.workers.values()].find((item) => item.agentTokenHash === agentTokenHash(token)); return worker ? this.publicWorker(worker) : undefined; }
  async heartbeatWorkerNode(nodeId: string, input: { privateAddress: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number }) { const worker = this.workers.get(nodeId); if (!worker) return undefined; Object.assign(worker, input, { lastHeartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); for (const job of this.jobs.values()) if (job.workerNodeId === nodeId && job.status === "running") job.leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString(); return this.publicWorker(worker); }
  async getWorkerNodeActivity(nodeId: string) { return this.workerActivity(nodeId); }
  async setWorkerNodeMode(nodeId: string, mode: WorkerNodeMode) { const worker = this.workers.get(nodeId); if (!worker) return undefined; worker.status = mode === "draining" ? "draining" : "ready"; worker.updatedAt = new Date().toISOString(); return this.workerActivity(nodeId); }
  async claimWorkerJob(nodeId: string) {
    const worker = this.workers.get(nodeId);
    if (!worker || worker.status !== "ready") return undefined;
    const capacityWorker = this.workersWithActiveCheckoutHolds().find((candidate) => candidate.id === nodeId);
    if (!capacityWorker) return undefined;
    const running = [...this.jobs.values()].find((job) => job.workerNodeId === nodeId && job.status === "running");
    if (running) {
      if (paidWorkerActions.has(running.action) && !hostingEntitlementActive(this.subscriptions.values(), running.installationId)) {
        running.status = "failed";
        running.leaseExpiresAt = undefined;
        for (const app of this.applications.values()) if (app.installationId === running.installationId && app.workerNodeId && ["live", "provisioning"].includes(app.state) && ![...this.jobs.values()].some((job) => job.installationId === running.installationId && job.action === "stop" && ["queued", "running"].includes(job.status) && job.payload.applicationInstanceId === app.id)) await this.enqueueJob(running.installationId, "stop", { applicationInstanceId: app.id, reason: "subscription_inactive" });
        return undefined;
      }
      const targetId = typeof running.payload.applicationInstanceId === "string" ? running.payload.applicationInstanceId : undefined;
      const applications = [...this.applications.values()].filter((app) => app.installationId === running.installationId && (!targetId || app.id === targetId));
      running.leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      return { ...running, applications };
    }
    const jobs = [...this.jobs.values()].filter((item) => item.status === "queued" && (!paidWorkerActions.has(item.action) || hostingEntitlementActive(this.subscriptions.values(), item.installationId))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let job = jobs.find((item) => item.workerNodeId === nodeId);
    if (!job) job = jobs.find((item) => {
      if (item.workerNodeId) return false;
      const installation = this.installations.get(item.installationId);
      if (!installation) return false;
      const targetId = typeof item.payload.applicationInstanceId === "string" ? item.payload.applicationInstanceId : undefined;
      const apps = [...this.applications.values()].filter((app) => app.installationId === installation.id && (!targetId || app.id === targetId));
      if (!apps.length) return false;
      if (item.action !== "install") return ["upgrade", "start", "stop", "uninstall", "backup", "restore"].includes(item.action) && apps.every((app) => app.workerNodeId === nodeId);
      const unassignedApps = apps.filter((app) => !app.workerNodeId);
      if (unassignedApps.length !== apps.length) return false;
      return unassignedApps.reduce((sum, app) => sum + app.memoryReservationMb, 0) + capacityWorker.reservedMemoryMb + capacityWorker.systemReserveMemoryMb <= capacityWorker.capacityMemoryMb && unassignedApps.reduce((sum, app) => sum + app.cpuReservationMillis, 0) + capacityWorker.reservedCpuMillis <= capacityWorker.capacityCpuMillis && unassignedApps.reduce((sum, app) => sum + app.storageReservationGb, 0) + capacityWorker.reservedStorageGb <= capacityWorker.capacityStorageGb;
    });
    if (!job) return undefined;
    if (paidWorkerActions.has(job.action) && !hostingEntitlementActive(this.subscriptions.values(), job.installationId)) return undefined;
    const installation = this.installations.get(job.installationId)!;
    const targetId = typeof job.payload.applicationInstanceId === "string" ? job.payload.applicationInstanceId : undefined;
    const applications = [...this.applications.values()].filter((app) => app.installationId === job!.installationId && (!targetId || app.id === targetId));
    if (!job.workerNodeId && job.action === "install") {
      for (const app of applications) app.workerNodeId = nodeId;
      worker.reservedMemoryMb += applications.reduce((sum, app) => sum + app.memoryReservationMb, 0);
      worker.reservedCpuMillis += applications.reduce((sum, app) => sum + app.cpuReservationMillis, 0);
      worker.reservedStorageGb += applications.reduce((sum, app) => sum + app.storageReservationGb, 0);
    }
    if (job.action === "install") for (const app of applications) { app.state = "provisioning"; app.updatedAt = new Date().toISOString(); }
    job.workerNodeId = nodeId; job.status = "running"; job.attempts += 1; job.leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return { ...job, applications };
  }
  async reportWorkerJob(nodeId: string, jobId: string, report: WorkerJobReport) {
    const job = this.jobs.get(jobId);
    if (!job || job.workerNodeId !== nodeId || job.status !== "running") return false;
    job.status = report.status;
    if (report.status === "succeeded") {
      for (const state of report.applications ?? []) await this.updateApplicationState(state.id, state.state, state.healthy ? new Date().toISOString() : undefined);
      const installationApplications = [...this.applications.values()].filter((app) => app.installationId === job.installationId);
      const entitled = hostingEntitlementActive(this.subscriptions.values(), job.installationId);
      const nextState = !entitled ? "suspended" : installationApplications.some((app) => app.state === "failed") ? "failed" : installationApplications.every((app) => app.state === "live") ? "live" : "provisioning";
      await this.updateInstallationState(job.installationId, nextState);
      if (job.action === "uninstall") {
        const worker = this.workers.get(nodeId);
        const targetId = typeof job.payload.applicationInstanceId === "string" ? job.payload.applicationInstanceId : undefined;
        const applications = [...this.applications.values()].filter((app) => app.installationId === job.installationId && (!targetId || app.id === targetId));
        if (worker) {
          worker.reservedMemoryMb = Math.max(0, worker.reservedMemoryMb - applications.reduce((sum, app) => sum + app.memoryReservationMb, 0));
          worker.reservedCpuMillis = Math.max(0, worker.reservedCpuMillis - applications.reduce((sum, app) => sum + app.cpuReservationMillis, 0));
          worker.reservedStorageGb = Math.max(0, worker.reservedStorageGb - applications.reduce((sum, app) => sum + app.storageReservationGb, 0));
        }
        for (const app of applications) app.workerNodeId = undefined;
      }
    } else if (hostingEntitlementActive(this.subscriptions.values(), job.installationId)) await this.updateInstallationState(job.installationId, "failed", report.error);
    for (const item of report.backups ?? []) this.backups.push({ id: randomUUID(), installationId: job.installationId, applicationInstanceId: item.applicationInstanceId, objectName: item.objectName, sizeBytes: item.sizeBytes, status: "ready", createdAt: new Date().toISOString() });
    return true;
  }
  async listGatewayRoutes() {
    const routes: GatewayRoute[] = [];
    for (const app of this.applications.values()) {
      const installation = this.installations.get(app.installationId);
      const entitled = hostingEntitlementActive(this.subscriptions.values(), app.installationId);
      if (app.state !== "live" || !app.workerNodeId || installation?.state !== "live" || !entitled) continue;
      const worker = this.workers.get(app.workerNodeId);
      if (!worker || !["ready", "draining"].includes(worker.status)) continue;
      const common = { upstreamHost: app.hostname, workerPrivateAddress: worker.privateAddress, workerNodeId: worker.id, applicationInstanceId: app.id, appId: app.appId };
      routes.push({ hostname: app.hostname, ...common });
      for (const item of app.customDomains) {
        const claim = this.hostnameRegistry.get(item.domain);
        if (!["verified", "active"].includes(item.verificationStatus) || claim?.id !== item.ownership.claimId || claim.surface !== "application" || claim.resourceId !== app.id || !["verified", "active"].includes(claim.status)) continue;
        routes.push({ hostname: item.domain, ownership: item.ownership, ...common });
      }
    }
    return routes;
  }
  async createManagedOAuthFlow(input: ManagedOAuthFlow) {
    const retentionThreshold = Date.now() - 86_400_000;
    for (const [key, flow] of this.managedOAuthFlows) if (new Date(flow.expiresAt).getTime() < retentionThreshold) this.managedOAuthFlows.delete(key);
    if (this.managedOAuthFlows.has(input.stateTokenHash)) throw new Error("Managed OAuth state collision.");
    this.managedOAuthFlows.set(input.stateTokenHash, { ...input });
  }
  async consumeManagedOAuthFlow(stateTokenHash: string) {
    const flow = this.managedOAuthFlows.get(stateTokenHash);
    const now = new Date();
    if (!flow || flow.consumedAt || new Date(flow.expiresAt) <= now) return undefined;
    flow.consumedAt = now.toISOString();
    return { ...flow };
  }
  async listWorkerNodeRoutes(nodeId: string) { return [...this.applications.values()].filter((app) => app.workerNodeId === nodeId && app.state === "live" && this.installations.get(app.installationId)?.state === "live" && hostingEntitlementActive(this.subscriptions.values(), app.installationId)).map((app) => ({ applicationInstanceId: app.id, hostname: app.hostname, containerProject: app.containerProject, appId: app.appId })); }
}

export class PostgresRepository implements Repository {
  readonly persistence = "postgres" as const;
  private pool: pg.Pool;
  constructor(connectionString: string, ssl = config.DATABASE_SSL === "true") {
    this.pool = new pg.Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : false });
  }
  async initialize() {
    await ensureDatabaseMigrations(this.pool);
    await assertPostgresRegistryHasNoPlatformClaims(this.pool, platformHostnameSuffixes());
  }
  async close() { await this.pool.end(); }
  private user(row: Record<string, unknown>): StoredUser {
    return { id: String(row.id), email: String(row.email), displayName: String(row.display_name), passwordHash: String(row.password_hash), createdAt: databaseTimestampIso(row.created_at) };
  }
  private installation(row: Record<string, unknown>): Installation {
    return { id: String(row.id), userId: String(row.user_id), appIds: row.app_ids as string[], name: String(row.name), plan: String(row.plan), state: row.state as Installation["state"], hostname: String(row.hostname), customDomains: (row.custom_domains as string[]) ?? [], failureReason: row.failure_reason ? String(row.failure_reason) : undefined, workerNodeId: row.worker_node_id ? String(row.worker_node_id) : undefined, createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at) };
  }
  private application(row: Record<string, unknown>, domains: CustomDomain[] = []): ApplicationInstance { return { id: String(row.id), installationId: String(row.installation_id), appId: String(row.app_id), state: row.state as ApplicationInstance["state"], hostname: String(row.hostname), containerProject: String(row.container_project), customDomains: domains, lastHealthAt: row.last_health_at ? databaseTimestampIso(row.last_health_at) : undefined, workerNodeId: row.worker_node_id ? String(row.worker_node_id) : undefined, memoryReservationMb: Number(row.memory_reservation_mb ?? 0), cpuReservationMillis: Number(row.cpu_reservation_millis ?? 0), storageReservationGb: Number(row.storage_reservation_gb ?? 0), createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at) }; }
  private customDomain(row: Record<string, unknown>): CustomDomain {
    const claim = hostnameClaimFromRow(row);
    return {
      id: String(row.id),
      applicationInstanceId: String(row.application_instance_id),
      domain: String(row.domain),
      verificationStatus: String(row.verification_status) as CustomDomain["verificationStatus"],
      ownership: hostnameOwnershipInstructions(claim, config.PUBLIC_HOST_TARGET),
      lastCheckedAt: row.last_checked_at ? databaseTimestampIso(row.last_checked_at) : undefined,
    };
  }
  private worker(row: Record<string, unknown>): WorkerNode { return { id: String(row.id), name: String(row.name), status: row.status as WorkerNode["status"], privateAddress: String(row.private_address), machineType: String(row.machine_type), capacityMemoryMb: Number(row.capacity_memory_mb), capacityCpuMillis: Number(row.capacity_cpu_millis), capacityStorageGb: Number(row.capacity_storage_gb), systemReserveMemoryMb: Number(row.system_reserve_memory_mb), reservedMemoryMb: Number(row.reserved_memory_mb ?? 0), reservedCpuMillis: Number(row.reserved_cpu_millis ?? 0), reservedStorageGb: Number(row.reserved_storage_gb ?? 0), lastHeartbeatAt: databaseTimestampIso(row.last_heartbeat_at), createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at) }; }
  private capacityAllocation(row: Record<string, unknown>): InstallationCapacityAllocation {
    return { id: String(row.id), installationId: String(row.installation_id), workerNodeId: String(row.worker_node_id), planId: String(row.plan), memoryMb: Number(row.allocation_memory_mb), cpuMillis: Number(row.allocation_cpu_millis), storageGb: Number(row.allocation_storage_gb), maxServices: Number(row.allocation_max_services), generation: Number(row.generation), state: row.state as InstallationCapacityAllocationState, sourceCheckoutHoldId: row.source_checkout_hold_id ? String(row.source_checkout_hold_id) : undefined, suspendedAt: row.suspended_at ? databaseTimestampIso(row.suspended_at) : undefined, releasedAt: row.released_at ? databaseTimestampIso(row.released_at) : undefined, releaseReason: row.release_reason ? String(row.release_reason) : undefined, createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at) };
  }
  private async synchronizeCapacityAllocationEntitlement(client: pg.PoolClient, installationId: string, entitlementActive: boolean, reason: string) {
    const current = await client.query("SELECT * FROM installation_capacity_allocations WHERE installation_id=$1 AND state IN ('active','suspended') FOR UPDATE", [installationId]);
    if (!current.rows[0]) return;
    if (!entitlementActive && current.rows[0].state === "active") {
      await client.query("UPDATE plan_capacity_change_holds SET state='released',released_at=NOW(),release_reason=$2,updated_at=NOW() WHERE installation_id=$1 AND state='active'", [installationId, reason.slice(0, 500)]);
      const changed = await client.query("UPDATE installation_capacity_allocations SET state='suspended',generation=generation+1,suspended_at=NOW(),release_reason=$2,updated_at=NOW() WHERE installation_id=$1 AND state='active' RETURNING *", [installationId, reason.slice(0, 500)]);
      if (changed.rows[0]) await client.query("INSERT INTO installation_capacity_allocation_events(id,allocation_id,installation_id,event_type,generation,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,reason) SELECT gen_random_uuid(),id,installation_id,'suspended',generation,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,$2 FROM installation_capacity_allocations WHERE id=$1", [changed.rows[0].id, reason.slice(0, 500)]);
    } else if (entitlementActive && current.rows[0].state === "suspended") {
      const changed = await client.query("UPDATE installation_capacity_allocations SET state='active',generation=generation+1,suspended_at=NULL,release_reason=NULL,updated_at=NOW() WHERE installation_id=$1 AND state='suspended' RETURNING *", [installationId]);
      if (changed.rows[0]) await client.query("INSERT INTO installation_capacity_allocation_events(id,allocation_id,installation_id,event_type,generation,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,reason) SELECT gen_random_uuid(),id,installation_id,'reactivated',generation,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,'subscription_entitlement_restored' FROM installation_capacity_allocations WHERE id=$1", [changed.rows[0].id]);
    }
  }
  private planCapacityChangeHold(row: Record<string, unknown>): PlanCapacityChangeHold {
    return { id: String(row.id), userId: String(row.user_id), installationId: String(row.installation_id), allocationId: String(row.allocation_id), idempotencyKey: String(row.idempotency_key), expectedGeneration: Number(row.expected_generation), fromPlan: String(row.from_plan), workerNodeId: String(row.worker_node_id), planId: String(row.requested_plan), memoryMb: Number(row.target_memory_mb), cpuMillis: Number(row.target_cpu_millis), storageGb: Number(row.target_storage_gb), maxServices: Number(row.target_max_services), reservedDeltaMemoryMb: Number(row.reserved_delta_memory_mb), reservedDeltaCpuMillis: Number(row.reserved_delta_cpu_millis), reservedDeltaStorageGb: Number(row.reserved_delta_storage_gb), infrastructureMonthlyCents: Number(row.infrastructure_monthly_cents), platformFeeMonthlyCents: Number(row.platform_fee_monthly_cents), providerSubscriptionId: String(row.provider_subscription_id), state: row.state as PlanCapacityChangeHoldState, expiresAt: databaseTimestampIso(row.expires_at), consumedAt: row.consumed_at ? databaseTimestampIso(row.consumed_at) : undefined, releasedAt: row.released_at ? databaseTimestampIso(row.released_at) : undefined, expiredAt: row.expired_at ? databaseTimestampIso(row.expired_at) : undefined, releaseReason: row.release_reason ? String(row.release_reason) : undefined, providerCommittedAt: row.provider_committed_at ? databaseTimestampIso(row.provider_committed_at) : undefined, providerConfirmationSource: row.provider_confirmation_source ? String(row.provider_confirmation_source) : undefined, createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at) };
  }
  private paidCheckoutCapacityRecovery(row: Record<string, unknown>): PaidCheckoutCapacityRecovery {
    return {
      id: String(row.id), stripeEventId: String(row.stripe_event_id), checkoutHoldId: String(row.checkout_hold_id), userId: String(row.user_id), installationId: String(row.installation_id),
      stripeCheckoutSessionId: String(row.stripe_checkout_session_id), stripeCustomerId: String(row.stripe_customer_id), providerSubscriptionId: String(row.provider_subscription_id),
      infrastructureMonthlyCents: Number(row.infrastructure_monthly_cents), platformFeeMonthlyCents: Number(row.platform_fee_monthly_cents), state: row.state as PaidCheckoutCapacityRecoveryState,
      attemptCount: Number(row.attempt_count), compensationDeadlineAt: databaseTimestampIso(row.compensation_deadline_at), compensationAction: "cancel_subscription_and_refund_captured_payment",
      lastAttemptAt: row.last_attempt_at ? databaseTimestampIso(row.last_attempt_at) : undefined, fulfilledAt: row.fulfilled_at ? databaseTimestampIso(row.fulfilled_at) : undefined,
      compensationRequiredAt: row.compensation_required_at ? databaseTimestampIso(row.compensation_required_at) : undefined, compensatedAt: row.compensated_at ? databaseTimestampIso(row.compensated_at) : undefined,
      compensationReference: row.compensation_reference ? String(row.compensation_reference) : undefined, lastError: row.last_error ? String(row.last_error) : undefined,
      createdAt: databaseTimestampIso(row.created_at), updatedAt: databaseTimestampIso(row.updated_at),
    };
  }
  private checkoutCapacityHold(row: Record<string, unknown>, itemRows: Record<string, unknown>[] = [], planRow?: Record<string, unknown>): CheckoutCapacityHold {
    if (!planRow) throw new Error("Checkout capacity hold is missing its logical plan quota snapshot.");
    return {
      id: String(row.id),
      userId: String(row.user_id),
      installationId: String(row.installation_id),
      idempotencyKey: String(row.idempotency_key),
      requestedPlan: String(row.requested_plan),
      requestedAppIds: row.requested_app_ids as string[],
      infrastructureMonthlyCents: Number(row.infrastructure_monthly_cents),
      platformFeeMonthlyCents: Number(row.platform_fee_monthly_cents),
      state: row.state as CheckoutCapacityHoldState,
      stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : undefined,
      stripeCheckoutSessionId: row.stripe_checkout_session_id ? String(row.stripe_checkout_session_id) : undefined,
      stripeCheckoutExpiresAt: row.stripe_checkout_expires_at ? databaseTimestampIso(row.stripe_checkout_expires_at) : undefined,
      providerSubscriptionId: row.provider_subscription_id ? String(row.provider_subscription_id) : undefined,
      expiresAt: databaseTimestampIso(row.expires_at),
      consumedAt: row.consumed_at ? databaseTimestampIso(row.consumed_at) : undefined,
      releasedAt: row.released_at ? databaseTimestampIso(row.released_at) : undefined,
      expiredAt: row.expired_at ? databaseTimestampIso(row.expired_at) : undefined,
      releaseReason: row.release_reason ? String(row.release_reason) : undefined,
      createdAt: databaseTimestampIso(row.created_at),
      updatedAt: databaseTimestampIso(row.updated_at),
      items: itemRows.map((item) => ({
        id: String(item.id),
        holdId: String(item.hold_id),
        applicationInstanceId: String(item.application_instance_id),
        workerNodeId: String(item.worker_node_id),
        appId: String(item.app_id),
        memoryReservationMb: Number(item.memory_reservation_mb),
        cpuReservationMillis: Number(item.cpu_reservation_millis),
        storageReservationGb: Number(item.storage_reservation_gb),
        createdAt: databaseTimestampIso(item.created_at),
      })),
      planCapacity: {
        holdId: String(planRow.hold_id),
        workerNodeId: String(planRow.worker_node_id),
        planId: String(planRow.requested_plan),
        memoryMb: Number(planRow.allocation_memory_mb),
        cpuMillis: Number(planRow.allocation_cpu_millis),
        storageGb: Number(planRow.allocation_storage_gb),
        maxServices: Number(planRow.allocation_max_services),
        createdAt: databaseTimestampIso(planRow.created_at),
      },
    };
  }
  private async workerActivity(queryable: pg.Pool | pg.PoolClient, nodeId: string): Promise<WorkerNodeActivity | undefined> {
    const nodeResult = await queryable.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.id=$1`, [nodeId]);
    if (!nodeResult.rows[0]) return undefined;
    const jobs = await queryable.query("SELECT id,installation_id,action,status,worker_node_id,lease_expires_at,created_at FROM provisioning_jobs WHERE worker_node_id=$1 AND status='running' ORDER BY locked_at,created_at", [nodeId]);
    const applications = await queryable.query("SELECT id,installation_id,app_id,state FROM application_instances WHERE worker_node_id=$1 ORDER BY created_at", [nodeId]);
    const node = this.worker(nodeResult.rows[0]);
    const runningJobs = jobs.rows.map((row) => ({ id: String(row.id), installationId: String(row.installation_id), action: row.action as ProvisioningJob["action"], status: "running" as const, workerNodeId: String(row.worker_node_id), leaseExpiresAt: row.lease_expires_at ? databaseTimestampIso(row.lease_expires_at) : undefined, createdAt: databaseTimestampIso(row.created_at) }));
    const assignedApplications = applications.rows.map((row) => ({ id: String(row.id), installationId: String(row.installation_id), appId: String(row.app_id), state: row.state as ApplicationInstance["state"] }));
    return { node, mode: node.status === "ready" ? "active" : node.status, runningJobs, assignedApplications, safeToReplaceAgent: runningJobs.length === 0 };
  }
  async findUserByEmail(email: string) { const result = await this.pool.query("SELECT * FROM users WHERE email=$1", [email]); return result.rows[0] ? this.user(result.rows[0]) : undefined; }
  async findUserById(id: string) { const result = await this.pool.query("SELECT * FROM users WHERE id=$1", [id]); return result.rows[0] ? this.user(result.rows[0]) : undefined; }
  async createUser(input: { email: string; displayName: string; passwordHash: string }) {
    const result = await this.pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING *", [randomUUID(), input.email, input.displayName, input.passwordHash]);
    return this.user(result.rows[0]);
  }
  async createSession(input: { tokenHash: string; userId: string; expiresAt: string }) { await this.pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [input.tokenHash, input.userId, input.expiresAt]); }
  async findUserBySession(tokenHash: string) { const result = await this.pool.query("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()", [tokenHash]); return result.rows[0] ? this.user(result.rows[0]) : undefined; }
  async deleteSession(tokenHash: string) { await this.pool.query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash]); }
  async listInstallations(userId: string) {
    const result = await this.pool.query("SELECT i.*, COALESCE(array_agg(d.domain) FILTER (WHERE d.domain IS NOT NULL), '{}') custom_domains FROM installations i LEFT JOIN custom_domains d ON d.installation_id=i.id WHERE i.user_id=$1 GROUP BY i.id ORDER BY i.created_at DESC", [userId]);
    const installations = result.rows.map((row) => this.installation(row));
    if (!installations.length) return installations;
    const applications = await this.pool.query("SELECT a.* FROM application_instances a JOIN installations i ON i.id=a.installation_id WHERE i.user_id=$1 ORDER BY a.created_at", [userId]);
    const domains = await this.pool.query("SELECT d.*,c.id claim_id,c.hostname claim_hostname,c.surface claim_surface,c.owner_user_id claim_owner_user_id,c.resource_id claim_resource_id,c.challenge_token,c.status claim_status,c.created_at claim_created_at,c.last_checked_at claim_last_checked_at,c.verified_at,c.tombstoned_at FROM custom_domains d JOIN global_hostname_claims c ON c.id=d.hostname_claim_id JOIN application_instances a ON a.id=d.application_instance_id JOIN installations i ON i.id=a.installation_id WHERE i.user_id=$1", [userId]);
    for (const installation of installations) {
      installation.applications = applications.rows.filter((row) => String(row.installation_id) === installation.id).map((row) => this.application(row, domains.rows.filter((domain) => String(domain.application_instance_id) === String(row.id)).map((domain) => this.customDomain(domain))));
    }
    return installations;
  }
  async createInstallation(input: Omit<Installation, "id" | "createdAt" | "updatedAt">) {
    const result = await this.pool.query("INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *, '{}'::text[] custom_domains", [randomUUID(), input.userId, input.name, input.plan, input.state, input.hostname, JSON.stringify(input.appIds)]);
    return this.installation(result.rows[0]);
  }
  async getInstallation(userId: string, id: string) { const rows = await this.listInstallations(userId); return rows.find((item) => item.id === id); }
  async addDomain(userId: string, id: string, domain: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query("SELECT i.id installation_id,a.id application_instance_id FROM installations i JOIN application_instances a ON a.installation_id=i.id WHERE i.id=$1 AND i.user_id=$2 ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF i,a", [id, userId]);
      if (!target.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      const claim = newHostnameClaim({ hostname: domain, surface: "application", ownerUserId: userId, resourceId: String(target.rows[0].application_instance_id) }, platformHostnameSuffixes());
      const insertedClaim = await insertPostgresHostnameClaim(client, claim);
      if (!insertedClaim) { await client.query("ROLLBACK"); return undefined; }
      const insertedDomain = await client.query("INSERT INTO custom_domains(id,installation_id,application_instance_id,domain,verification_status,hostname_claim_id) VALUES($1,$2,$3,$4,'awaiting-dns',$5) RETURNING *", [randomUUID(), id, target.rows[0].application_instance_id, claim.hostname, claim.id]);
      await client.query("COMMIT");
      const installation = await this.getInstallation(userId, id);
      if (!installation) throw new Error("The claimed installation disappeared after commit.");
      return { installation, domain: this.customDomain({ ...insertedDomain.rows[0], claim_id: claim.id, claim_hostname: claim.hostname, claim_surface: claim.surface, claim_owner_user_id: claim.ownerUserId, claim_resource_id: claim.resourceId, challenge_token: claim.challengeToken, claim_status: claim.status, claim_created_at: claim.createdAt }) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
  async upgrade(userId: string, id: string, plan: string) {
    await this.expireCheckoutCapacityHolds();
    const result = await this.pool.query("UPDATE installations SET plan=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 AND NOT EXISTS (SELECT 1 FROM checkout_capacity_holds hold WHERE hold.installation_id=installations.id AND hold.state='active' AND hold.expires_at>NOW()) AND NOT EXISTS (SELECT 1 FROM plan_capacity_change_holds resize WHERE resize.installation_id=installations.id AND resize.state='active' AND resize.expires_at>NOW())", [plan, id, userId]);
    if (!result.rowCount) return undefined;
    return this.getInstallation(userId, id);
  }
  async appendApplicationId(installationId: string, appId: string) { await this.pool.query("UPDATE installations SET app_ids=app_ids || to_jsonb($2::text),updated_at=NOW() WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM checkout_capacity_holds hold WHERE hold.installation_id=installations.id AND hold.state='active' AND hold.expires_at>NOW()) AND NOT EXISTS (SELECT 1 FROM plan_capacity_change_holds resize WHERE resize.installation_id=installations.id AND resize.state='active' AND resize.expires_at>NOW())", [installationId, appId]); }
  async canReserveOnInstallationWorker(installationId: string, reservation: { memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }, memorySafetyReserveMb = 0) {
    await this.expireCheckoutCapacityHolds();
    if ((await this.pool.query("SELECT 1 FROM plan_capacity_change_holds WHERE installation_id=$1 AND state='active' AND expires_at>NOW() LIMIT 1", [installationId])).rowCount) return false;
    const allocationResult = await this.pool.query("SELECT allocation.*,COUNT(a.id)::int services,COALESCE(SUM(a.memory_reservation_mb),0)::int used_memory_mb,COALESCE(SUM(a.cpu_reservation_millis),0)::int used_cpu_millis,COALESCE(SUM(a.storage_reservation_gb),0)::int used_storage_gb FROM installation_capacity_allocations allocation LEFT JOIN application_instances a ON a.installation_id=allocation.installation_id WHERE allocation.installation_id=$1 AND allocation.state='active' GROUP BY allocation.id", [installationId]);
    if (allocationResult.rows[0]) {
      const row = allocationResult.rows[0];
      if (!capacityEnvelopeFit({ services: Number(row.services) + 1, memoryMb: Number(row.used_memory_mb) + reservation.memoryReservationMb + memorySafetyReserveMb, cpuMillis: Number(row.used_cpu_millis) + reservation.cpuReservationMillis, storageGb: Number(row.used_storage_gb) + reservation.storageReservationGb }, this.capacityAllocation(row)).fits) return false;
      const workers = await this.pool.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY w.id`);
      return capacityCanFit(workers.rows.map((worker) => this.worker(worker)), [reservation]);
    }
    if ((await this.pool.query("SELECT 1 FROM installation_capacity_allocations WHERE installation_id=$1 AND state='suspended'", [installationId])).rowCount) return false;
    const result = await this.pool.query("SELECT i.worker_node_id,w.capacity_memory_mb,w.capacity_cpu_millis,w.capacity_storage_gb,w.system_reserve_memory_mb,COALESCE(apps.memory,0)+COALESCE(holds.memory,0) reserved_memory_mb,COALESCE(apps.cpu,0)+COALESCE(holds.cpu,0) reserved_cpu_millis,COALESCE(apps.storage,0)+COALESCE(holds.storage,0) reserved_storage_gb FROM installations i LEFT JOIN worker_nodes w ON w.id=i.worker_node_id LEFT JOIN LATERAL (SELECT SUM(a.memory_reservation_mb) memory,SUM(a.cpu_reservation_millis) cpu,SUM(a.storage_reservation_gb) storage FROM application_instances a WHERE a.worker_node_id=w.id) apps ON TRUE LEFT JOIN LATERAL (SELECT SUM(item.memory_reservation_mb) memory,SUM(item.cpu_reservation_millis) cpu,SUM(item.storage_reservation_gb) storage FROM checkout_capacity_hold_items item JOIN checkout_capacity_holds hold ON hold.id=item.hold_id WHERE item.worker_node_id=w.id AND hold.state='active' AND hold.expires_at>NOW()) holds ON TRUE WHERE i.id=$1", [installationId]);
    const row = result.rows[0];
    if (!row || !row.worker_node_id) return true;
    return Number(row.reserved_memory_mb) + Number(row.system_reserve_memory_mb) + reservation.memoryReservationMb <= Number(row.capacity_memory_mb) && Number(row.reserved_cpu_millis) + reservation.cpuReservationMillis <= Number(row.capacity_cpu_millis) && Number(row.reserved_storage_gb) + reservation.storageReservationGb <= Number(row.capacity_storage_gb);
  }
  async hasFreshProvisioningCapacity(reservations: CapacityReservation[]) {
    await this.expireCheckoutCapacityHolds();
    const result = await this.pool.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY w.id`);
    return capacityCanFit(result.rows.map((row) => this.worker(row)), reservations);
  }
  private async expireCheckoutCapacityHolds() {
    await this.pool.query("UPDATE checkout_capacity_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
  }
  private async loadCheckoutCapacityHold(queryable: pg.Pool | pg.PoolClient, holdId: string) {
    const result = await queryable.query("SELECT * FROM checkout_capacity_holds WHERE id=$1", [holdId]);
    if (!result.rows[0]) return undefined;
    const items = await queryable.query("SELECT * FROM checkout_capacity_hold_items WHERE hold_id=$1 ORDER BY application_instance_id", [holdId]);
    const plan = await queryable.query("SELECT * FROM checkout_plan_capacity_holds WHERE hold_id=$1", [holdId]);
    return this.checkoutCapacityHold(result.rows[0], items.rows, plan.rows[0]);
  }
  async acquireCheckoutCapacityHold(input: AcquireCheckoutCapacityHoldInput) {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new Error("Checkout capacity hold expiry must be in the future.");
    if (input.reservations.some((item) => !item.applicationInstanceId || !item.appId || item.memoryReservationMb <= 0 || item.cpuReservationMillis <= 0 || item.storageReservationGb <= 0)) throw new Error("Checkout capacity reservations are incomplete.");
    if (new Set(input.reservations.map((item) => item.applicationInstanceId)).size !== input.reservations.length) throw new Error("Checkout capacity reservations contain duplicate applications.");
    const configuredPlan = config.plans.find((plan) => plan.id === input.requestedPlan);
    if (!configuredPlan || !samePlanCapacity(input.planCapacity, planCapacitySnapshot(configuredPlan))) throw new Error("Checkout must persist the complete configured plan quota snapshot.");
    if (!capacityEnvelopeFit(applicationCapacityUsage(input.reservations), input.planCapacity).fits) throw new Error("Checkout applications exceed the configured plan quota.");
    const configuredPlatformFee = Math.max(Math.ceil(configuredPlan.infrastructureMonthlyCents * (config.PLATFORM_FEE_PERCENT / 100)), config.PLATFORM_FEE_MIN_CENTS);
    if (input.infrastructureMonthlyCents !== configuredPlan.infrastructureMonthlyCents || input.platformFeeMonthlyCents !== configuredPlatformFee) throw new Error("Checkout hold prices do not match the configured plan.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);
      await client.query("UPDATE checkout_capacity_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      const existingResult = await client.query("SELECT * FROM checkout_capacity_holds WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE", [input.userId, input.idempotencyKey]);
      if (existingResult.rows[0]) {
        const itemResult = await client.query("SELECT * FROM checkout_capacity_hold_items WHERE hold_id=$1 ORDER BY application_instance_id", [existingResult.rows[0].id]);
        const planResult = await client.query("SELECT * FROM checkout_plan_capacity_holds WHERE hold_id=$1", [existingResult.rows[0].id]);
        const existing = this.checkoutCapacityHold(existingResult.rows[0], itemResult.rows, planResult.rows[0]);
        const existingReservations = canonicalCapacityReservations(existing.items);
        const requested = canonicalCapacityReservations(input.reservations);
        const sameRequest = existing.installationId === input.installationId && existing.requestedPlan === input.requestedPlan && JSON.stringify(existing.requestedAppIds) === JSON.stringify(input.requestedAppIds) && existing.infrastructureMonthlyCents === input.infrastructureMonthlyCents && existing.platformFeeMonthlyCents === input.platformFeeMonthlyCents && JSON.stringify(existingReservations) === JSON.stringify(requested) && samePlanCapacity(existing.planCapacity, input.planCapacity);
        if (!sameRequest) throw new Error("The checkout idempotency key is already bound to a different capacity request.");
        await client.query("COMMIT");
        return existing.state === "active" ? existing : undefined;
      }
      if ((await client.query("SELECT 1 FROM checkout_capacity_holds WHERE installation_id=$1 AND state='active' LIMIT 1 FOR UPDATE", [input.installationId])).rowCount) { await client.query("ROLLBACK"); return undefined; }
      const installationResult = await client.query("SELECT * FROM installations WHERE id=$1 AND user_id=$2 AND state='planned' FOR UPDATE", [input.installationId, input.userId]);
      const installation = installationResult.rows[0];
      if (!installation || String(installation.plan) !== input.requestedPlan || JSON.stringify(installation.app_ids) !== JSON.stringify(input.requestedAppIds)) { await client.query("ROLLBACK"); return undefined; }
      const applicationResult = await client.query("SELECT * FROM application_instances WHERE installation_id=$1 ORDER BY id FOR UPDATE", [input.installationId]);
      const applications = applicationResult.rows.map((row) => this.application(row));
      const requested = [...input.reservations].sort((left, right) => left.applicationInstanceId.localeCompare(right.applicationInstanceId));
      if (applications.length !== requested.length || applications.some((application, index) => {
        const reservation = requested[index];
        return application.id !== reservation.applicationInstanceId || application.appId !== reservation.appId || application.workerNodeId || application.state !== "queued" || application.memoryReservationMb !== reservation.memoryReservationMb || application.cpuReservationMillis !== reservation.cpuReservationMillis || application.storageReservationGb !== reservation.storageReservationGb;
      })) { await client.query("ROLLBACK"); return undefined; }
      const workerResult = await client.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY w.id FOR UPDATE OF w`, []);
      const workers = workerResult.rows.map((row) => this.worker(row));
      const assignments = allocateCapacity(workers, requested);
      if (!assignments) { await client.query("ROLLBACK"); return undefined; }
      const workerNodeId = allocationAffinityWorker(workers, assignments);
      if (!workerNodeId) { await client.query("ROLLBACK"); return undefined; }
      const holdId = randomUUID();
      const holdResult = await client.query("INSERT INTO checkout_capacity_holds(id,user_id,installation_id,idempotency_key,requested_plan,requested_app_ids,infrastructure_monthly_cents,platform_fee_monthly_cents,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", [holdId, input.userId, input.installationId, input.idempotencyKey, input.requestedPlan, JSON.stringify(input.requestedAppIds), input.infrastructureMonthlyCents, input.platformFeeMonthlyCents, input.expiresAt]);
      const itemRows: Record<string, unknown>[] = [];
      for (const reservation of requested) {
        const item = await client.query("INSERT INTO checkout_capacity_hold_items(id,hold_id,application_instance_id,worker_node_id,app_id,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [randomUUID(), holdId, reservation.applicationInstanceId, assignments.get(reservation.applicationInstanceId), reservation.appId, reservation.memoryReservationMb, reservation.cpuReservationMillis, reservation.storageReservationGb]);
        itemRows.push(item.rows[0]);
      }
      const planResult = await client.query("INSERT INTO checkout_plan_capacity_holds(hold_id,worker_node_id,requested_plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [holdId, workerNodeId, input.planCapacity.planId, input.planCapacity.memoryMb, input.planCapacity.cpuMillis, input.planCapacity.storageGb, input.planCapacity.maxServices]);
      await client.query("COMMIT");
      return this.checkoutCapacityHold(holdResult.rows[0], itemRows, planResult.rows[0]);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally { client.release(); }
  }
  async attachCheckoutSession(input: AttachCheckoutSessionInput) {
    const checkoutExpiry = new Date(input.stripeCheckoutExpiresAt);
    if (!Number.isFinite(checkoutExpiry.getTime()) || checkoutExpiry <= new Date()) return false;
    const result = await this.pool.query("UPDATE checkout_capacity_holds hold SET stripe_customer_id=$3,stripe_checkout_session_id=$4,stripe_checkout_expires_at=$5,checkout_session_attached_at=COALESCE(checkout_session_attached_at,NOW()),updated_at=NOW() FROM billing_accounts account WHERE hold.id=$1 AND hold.user_id=$2 AND hold.state='active' AND hold.expires_at>NOW() AND account.user_id=hold.user_id AND account.stripe_customer_id=$3 AND $5::timestamptz<=hold.expires_at AND (hold.stripe_customer_id IS NULL OR hold.stripe_customer_id=$3) AND (hold.stripe_checkout_session_id IS NULL OR hold.stripe_checkout_session_id=$4) AND (hold.stripe_checkout_expires_at IS NULL OR hold.stripe_checkout_expires_at=$5::timestamptz) RETURNING hold.id", [input.holdId, input.userId, input.stripeCustomerId, input.stripeCheckoutSessionId, input.stripeCheckoutExpiresAt]);
    return result.rowCount === 1;
  }
  async releaseCheckoutCapacityHold(holdId: string, userId: string, reason: string) {
    const result = await this.pool.query("UPDATE checkout_capacity_holds SET state='released',released_at=NOW(),release_reason=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND state='active' RETURNING id", [holdId, userId, reason.slice(0, 500)]);
    return result.rowCount === 1;
  }
  async getCheckoutCapacityHold(holdId: string) {
    await this.expireCheckoutCapacityHolds();
    return this.loadCheckoutCapacityHold(this.pool, holdId);
  }
  async hasActiveCheckoutCapacityHold(installationId: string) {
    await this.expireCheckoutCapacityHolds();
    return (await this.pool.query("SELECT 1 FROM checkout_capacity_holds WHERE installation_id=$1 AND state='active' AND expires_at>NOW() LIMIT 1", [installationId])).rowCount === 1;
  }
  async createApplicationInstances(installationId: string, apps: Array<{ appId: string; memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }>, hostnameBase: string, memorySafetyReserveMb = 0) {
    const client = await this.pool.connect();
    const created: ApplicationInstance[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);
      await client.query("UPDATE checkout_capacity_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      await client.query("UPDATE plan_capacity_change_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      const installation = await client.query("SELECT id FROM installations WHERE id=$1 FOR UPDATE", [installationId]);
      if (!installation.rows[0]) throw new Error("Installation not found.");
      if ((await client.query("SELECT 1 FROM checkout_capacity_holds WHERE installation_id=$1 AND state='active' AND expires_at>NOW() LIMIT 1", [installationId])).rowCount) throw new Error("The installation has an active checkout capacity hold.");
      if ((await client.query("SELECT 1 FROM plan_capacity_change_holds WHERE installation_id=$1 AND state='active' LIMIT 1", [installationId])).rowCount) throw new Error("The installation has an active plan quota change hold.");
      const allocationResult = await client.query("SELECT * FROM installation_capacity_allocations WHERE installation_id=$1 AND state IN ('active','suspended') FOR UPDATE", [installationId]);
      const allocation = allocationResult.rows[0] ? this.capacityAllocation(allocationResult.rows[0]) : undefined;
      if (allocation && allocation.state !== "active") throw new Error("The paid plan quota is not active.");
      const prepared = apps.map((app) => ({ ...app, id: randomUUID() }));
      let assignments: Map<string, string> | undefined;
      if (allocation?.state === "active") {
        const usageResult = await client.query("SELECT COUNT(*)::int services,COALESCE(SUM(memory_reservation_mb),0)::int memory_mb,COALESCE(SUM(cpu_reservation_millis),0)::int cpu_millis,COALESCE(SUM(storage_reservation_gb),0)::int storage_gb FROM application_instances WHERE installation_id=$1", [installationId]);
        const usage = usageResult.rows[0];
        const proposed = { services: Number(usage.services) + apps.length, memoryMb: Number(usage.memory_mb) + apps.reduce((sum, item) => sum + item.memoryReservationMb, 0) + memorySafetyReserveMb, cpuMillis: Number(usage.cpu_millis) + apps.reduce((sum, item) => sum + item.cpuReservationMillis, 0), storageGb: Number(usage.storage_gb) + apps.reduce((sum, item) => sum + item.storageReservationGb, 0) };
        if (!capacityEnvelopeFit(proposed, allocation).fits) throw new Error("The paid plan quota cannot contain these additional applications.");
        const workerResult = await client.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY w.id FOR UPDATE OF w`);
        const placement = allocateCapacity(workerResult.rows.map((worker) => this.worker(worker)), prepared.map((item) => ({ applicationInstanceId: item.id, appId: item.appId, memoryReservationMb: item.memoryReservationMb, cpuReservationMillis: item.cpuReservationMillis, storageReservationGb: item.storageReservationGb })));
        if (!placement) throw new Error("The worker pool cannot reserve these application resources.");
        assignments = placement;
      }
      for (const { id, appId, memoryReservationMb, cpuReservationMillis, storageReservationGb } of prepared) {
        const result = await client.query("INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb,worker_node_id) VALUES($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9) RETURNING *", [id, installationId, appId, `${appId}-${id.slice(0, 8)}.${hostnameBase}`, `mos-${id.replaceAll("-", "").slice(0, 12)}`, memoryReservationMb, cpuReservationMillis, storageReservationGb, assignments?.get(id) ?? null]);
        created.push(this.application(result.rows[0]));
      }
      await client.query("COMMIT");
      return created;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally { client.release(); }
  }
  async createApplicationClone(input: CreateApplicationCloneInput): Promise<ApplicationCloneResult> {
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new Error("Clone idempotency key must contain 16 to 200 characters.");
    const storedKey = `application-clone:${input.userId}:${idempotencyKey}`;
    const requestSnapshot = cloneRequestSnapshot(input);
    const requestHash = cloneRequestHash(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);
      const replayResult = await client.query("SELECT user_id,response FROM idempotency_keys WHERE key=$1 FOR UPDATE", [storedKey]);
      if (replayResult.rows[0]) {
        const response = replayResult.rows[0].response as { kind?: string; requestHash?: string; applicationId?: string; jobId?: string };
        if (String(replayResult.rows[0].user_id) !== input.userId || response.kind !== "application_clone_v1" || response.requestHash !== requestHash || !response.applicationId) throw new Error("The clone idempotency key is already bound to a different request.");
        const applicationResult = await client.query("SELECT * FROM application_instances WHERE id=$1 AND installation_id=$2", [response.applicationId, input.installationId]);
        const jobResult = response.jobId ? await client.query("SELECT * FROM provisioning_jobs WHERE id=$1 AND installation_id=$2", [response.jobId, input.installationId]) : undefined;
        if (!applicationResult.rows[0] || (response.jobId && !jobResult?.rows[0])) throw new Error("The idempotent clone result is incomplete.");
        await client.query("COMMIT");
        const jobRow = jobResult?.rows[0];
        return { application: this.application(applicationResult.rows[0]), ...(jobRow ? { job: { id: String(jobRow.id), installationId: String(jobRow.installation_id), action: jobRow.action, status: jobRow.status, attempts: Number(jobRow.attempts), payload: jobRow.payload, workerNodeId: jobRow.worker_node_id ? String(jobRow.worker_node_id) : undefined, createdAt: databaseTimestampIso(jobRow.created_at) } as ProvisioningJob } : {}), replayed: true };
      }
      await client.query("UPDATE checkout_capacity_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      await client.query("UPDATE plan_capacity_change_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      const installationResult = await client.query("SELECT * FROM installations WHERE id=$1 AND user_id=$2 FOR UPDATE", [input.installationId, input.userId]);
      const installation = installationResult.rows[0];
      if (!installation) throw new Error("Installation not found.");
      if ((await client.query("SELECT 1 FROM checkout_capacity_holds WHERE installation_id=$1 AND state='active' LIMIT 1", [input.installationId])).rowCount) throw new Error("The installation has an active checkout capacity hold.");
      if ((await client.query("SELECT 1 FROM plan_capacity_change_holds WHERE installation_id=$1 AND state='active' LIMIT 1", [input.installationId])).rowCount) throw new Error("The installation has an active plan quota change hold.");
      if (config.HOSTING_ENTITLEMENT_MODE === "hosted" && installation.state !== "planned" && !(await client.query("SELECT 1 FROM subscriptions WHERE installation_id=$1 AND user_id=$2 AND status IN ('active','trialing') LIMIT 1", [input.installationId, input.userId])).rowCount) throw new Error("Reactivate this server subscription before cloning another service.");
      const allocationResult = await client.query("SELECT * FROM installation_capacity_allocations WHERE installation_id=$1 AND state IN ('active','suspended') FOR UPDATE", [input.installationId]);
      const allocation = allocationResult.rows[0] ? this.capacityAllocation(allocationResult.rows[0]) : undefined;
      if (allocation && allocation.state !== "active") throw new Error("The paid plan quota is not active.");
      const configuredPlan = config.plans.find((plan) => plan.id === String(installation.plan));
      const envelope = allocation ?? (configuredPlan ? planCapacitySnapshot(configuredPlan) : undefined);
      if (!envelope) throw new Error("Upgrade this legacy server to a current plan before cloning services.");
      const usageResult = await client.query("SELECT COUNT(*)::int services,COALESCE(SUM(memory_reservation_mb),0)::int memory_mb,COALESCE(SUM(cpu_reservation_millis),0)::int cpu_millis,COALESCE(SUM(storage_reservation_gb),0)::int storage_gb FROM application_instances WHERE installation_id=$1", [input.installationId]);
      const usage = usageResult.rows[0];
      const proposed = { services: Number(usage.services) + 1, memoryMb: Number(usage.memory_mb) + input.app.memoryReservationMb + input.memorySafetyReserveMb, cpuMillis: Number(usage.cpu_millis) + input.app.cpuReservationMillis, storageGb: Number(usage.storage_gb) + input.app.storageReservationGb };
      if (!capacityEnvelopeFit(proposed, envelope).fits) throw new Error("The paid plan quota cannot contain this additional application.");
      const applicationId = randomUUID();
      let workerNodeId: string | undefined;
      if (allocation) {
        const workerResult = await client.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY w.id FOR UPDATE OF w`);
        const placement = allocateCapacity(workerResult.rows.map((row) => this.worker(row)), [{ ...input.app, applicationInstanceId: applicationId }]);
        workerNodeId = placement ? placement.get(applicationId) : undefined;
        if (!workerNodeId) throw new Error("The worker pool cannot reserve this application.");
      }
      const applicationResult = await client.query("INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb,worker_node_id) VALUES($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9) RETURNING *", [applicationId, input.installationId, input.app.appId, `${input.app.appId}-${applicationId.slice(0, 8)}.${input.hostnameBase}`, `mos-${applicationId.replaceAll("-", "").slice(0, 12)}`, input.app.memoryReservationMb, input.app.cpuReservationMillis, input.app.storageReservationGb, workerNodeId ?? null]);
      if ((await client.query("UPDATE installations SET app_ids=app_ids || to_jsonb($2::text),updated_at=NOW() WHERE id=$1 AND user_id=$3 RETURNING id", [input.installationId, input.app.appId, input.userId])).rowCount !== 1) throw new Error("The clone installation changed before commit.");
      let jobRow: Record<string, unknown> | undefined;
      if (installation.state === "live") {
        const jobResult = await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload,worker_node_id) VALUES($1,$2,'install',jsonb_build_object('applicationInstanceId',$3::text,'cloneIdempotencyKey',$4::text),$5) RETURNING *", [randomUUID(), input.installationId, applicationId, idempotencyKey, workerNodeId ?? null]);
        jobRow = jobResult.rows[0];
      }
      await client.query("INSERT INTO idempotency_keys(key,user_id,response) VALUES($1,$2,$3)", [storedKey, input.userId, { kind: "application_clone_v1", request: requestSnapshot, requestHash, applicationId, ...(jobRow ? { jobId: String(jobRow.id) } : {}) }]);
      await client.query("COMMIT");
      return { application: this.application(applicationResult.rows[0]), ...(jobRow ? { job: { id: String(jobRow.id), installationId: String(jobRow.installation_id), action: jobRow.action, status: jobRow.status, attempts: Number(jobRow.attempts), payload: jobRow.payload, workerNodeId: jobRow.worker_node_id ? String(jobRow.worker_node_id) : undefined, createdAt: databaseTimestampIso(jobRow.created_at) } as ProvisioningJob } : {}), replayed: false };
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  async getApplicationInstance(userId: string, id: string) { const result = await this.pool.query("SELECT a.* FROM application_instances a JOIN installations i ON i.id=a.installation_id WHERE a.id=$1 AND i.user_id=$2", [id, userId]); return result.rows[0] ? this.application(result.rows[0]) : undefined; }
  async updateInstallationState(id: string, state: Installation["state"], failureReason?: string) { await this.pool.query("UPDATE installations SET state=$1,failure_reason=$2,updated_at=NOW() WHERE id=$3", [state, failureReason ?? null, id]); }
  async updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string) { await this.pool.query("UPDATE application_instances SET state=$1,last_health_at=COALESCE($2,last_health_at),updated_at=NOW() WHERE id=$3", [state, healthAt ?? null, id]); }
  async enqueueJob(installationId: string, action: ProvisioningJob["action"], payload: Record<string, unknown> = {}) { const id = randomUUID(); const targetId = typeof payload.applicationInstanceId === "string" ? payload.applicationInstanceId : null; const result = await this.pool.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload,worker_node_id) SELECT $1,$2,$3,$4,COALESCE((SELECT worker_node_id FROM application_instances WHERE id=$5::uuid),i.worker_node_id) FROM installations i WHERE i.id=$2 RETURNING *", [id, installationId, action, payload, targetId]); const row = result.rows[0]; return { id: String(row.id), installationId: String(row.installation_id), action: row.action, status: row.status, attempts: Number(row.attempts), payload: row.payload, workerNodeId: row.worker_node_id ? String(row.worker_node_id) : undefined, createdAt: databaseTimestampIso(row.created_at) } as ProvisioningJob; }
  async setDomainStatus(userId: string, installationId: string, domain: string, status: CustomDomain["verificationStatus"]) {
    if (status === "failed") return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query("SELECT d.*,i.user_id,c.id claim_id,c.hostname claim_hostname,c.surface claim_surface,c.owner_user_id claim_owner_user_id,c.resource_id claim_resource_id,c.challenge_token,c.status claim_status,c.created_at claim_created_at,c.last_checked_at claim_last_checked_at,c.verified_at,c.tombstoned_at FROM custom_domains d JOIN installations i ON i.id=d.installation_id JOIN global_hostname_claims c ON c.id=d.hostname_claim_id WHERE d.installation_id=$1 AND i.user_id=$2 AND d.domain=$3 FOR UPDATE OF d,c", [installationId, userId, domain]);
      if (!target.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      const row = target.rows[0];
      const claimStatus = status === "awaiting-dns" ? "pending" : status;
      const claim = await updatePostgresHostnameClaimStatus(client, { hostname: domain, surface: "application", ownerUserId: userId, resourceId: String(row.application_instance_id) }, claimStatus);
      if (!claim || claim.id !== String(row.hostname_claim_id)) { await client.query("ROLLBACK"); return undefined; }
      const updated = await client.query("UPDATE custom_domains SET verification_status=$1,last_checked_at=NOW() WHERE id=$2 RETURNING *", [status, row.id]);
      await client.query("COMMIT");
      return this.customDomain({ ...updated.rows[0], claim_id: claim.id, claim_hostname: claim.hostname, claim_surface: claim.surface, claim_owner_user_id: claim.ownerUserId, claim_resource_id: claim.resourceId, challenge_token: claim.challengeToken, claim_status: claim.status, claim_created_at: claim.createdAt, claim_last_checked_at: claim.lastCheckedAt, verified_at: claim.verifiedAt, tombstoned_at: claim.tombstonedAt });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
  async getOrCreateStripeCustomer(userId: string, create: () => Promise<string>) { const existing = await this.pool.query("SELECT stripe_customer_id FROM billing_accounts WHERE user_id=$1", [userId]); if (existing.rows[0]?.stripe_customer_id) return String(existing.rows[0].stripe_customer_id); const customerId = await create(); await this.pool.query("INSERT INTO billing_accounts(user_id,stripe_customer_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=EXCLUDED.stripe_customer_id", [userId, customerId]); return customerId; }
  async recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) { await this.pool.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider_subscription_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,status=EXCLUDED.status,infrastructure_monthly_cents=EXCLUDED.infrastructure_monthly_cents,platform_fee_monthly_cents=EXCLUDED.platform_fee_monthly_cents,updated_at=NOW()", [randomUUID(), input.userId, input.installationId, input.providerSubscriptionId, input.status, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents]); }
  async listSubscriptions() {
    const result = await this.pool.query("SELECT s.*,i.plan installation_plan FROM subscriptions s LEFT JOIN installations i ON i.id=s.installation_id ORDER BY s.created_at,s.id");
    return result.rows.map((row) => ({ id: String(row.id), userId: String(row.user_id), installationId: row.installation_id ? String(row.installation_id) : undefined, providerSubscriptionId: row.provider_subscription_id ? String(row.provider_subscription_id) : undefined, status: String(row.status), infrastructureMonthlyCents: Number(row.infrastructure_monthly_cents), platformFeeMonthlyCents: Number(row.platform_fee_monthly_cents), installationPlan: row.installation_plan ? String(row.installation_plan) : undefined }));
  }
  async applySubscriptionReconciliation(input: { deactivateSubscriptionIds: string[]; upsertSubscriptions: ReconciledSubscription[]; affectedUserIds: string[] }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const affectedInstallations = new Set(input.upsertSubscriptions.map((item) => item.installationId));
      if (input.deactivateSubscriptionIds.length) {
        const existing = await client.query("SELECT installation_id FROM subscriptions WHERE id=ANY($1::uuid[]) AND installation_id IS NOT NULL", [input.deactivateSubscriptionIds]);
        for (const row of existing.rows) affectedInstallations.add(String(row.installation_id));
      }
      if (affectedInstallations.size) await client.query("SELECT id FROM provisioning_jobs WHERE installation_id=ANY($1::uuid[]) AND status IN ('queued','running') ORDER BY id FOR UPDATE", [[...affectedInstallations].sort()]);
      if (input.deactivateSubscriptionIds.length) await client.query("UPDATE subscriptions SET status='inactive',updated_at=NOW() WHERE id=ANY($1::uuid[])", [input.deactivateSubscriptionIds]);
      for (const item of input.upsertSubscriptions) {
        const result = await client.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) SELECT $1,i.user_id,i.id,$4,$5,$6,$7 FROM installations i WHERE i.id=$3 AND i.user_id=$2 ON CONFLICT(provider_subscription_id) DO UPDATE SET user_id=EXCLUDED.user_id,installation_id=EXCLUDED.installation_id,status=EXCLUDED.status,infrastructure_monthly_cents=EXCLUDED.infrastructure_monthly_cents,platform_fee_monthly_cents=EXCLUDED.platform_fee_monthly_cents,updated_at=NOW() RETURNING id", [randomUUID(), item.userId, item.installationId, item.providerSubscriptionId, item.status, item.infrastructureMonthlyCents, item.platformFeeMonthlyCents]);
        if (result.rowCount !== 1) throw new Error(`Subscription ${item.providerSubscriptionId} ownership changed during reconciliation.`);
      }
      const entitlements: ReconciledEntitlement[] = [];
      const suiteTable = (await client.query("SELECT to_regclass('public.suite_workspaces') table_name")).rows[0]?.table_name;
      for (const userId of [...new Set(input.affectedUserIds)].sort()) {
        const installationEntitlements = await client.query("SELECT i.id,EXISTS(SELECT 1 FROM subscriptions s WHERE s.installation_id=i.id AND s.status IN ('active','trialing')) entitlement_active FROM installations i WHERE i.user_id=$1 AND i.state<>'planned' ORDER BY i.id", [userId]);
        for (const installation of installationEntitlements.rows) await this.synchronizeCapacityAllocationEntitlement(client, String(installation.id), config.HOSTING_ENTITLEMENT_MODE === "unrestricted" || installation.entitlement_active === true, "Subscription reconciliation changed this capacity entitlement.");
        await client.query("UPDATE installations i SET state='suspended',failure_reason='Subscription reconciliation suspended this server.',updated_at=NOW() WHERE $2::BOOLEAN AND i.user_id=$1 AND i.state<>'planned' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=i.id AND s.status IN ('active','trialing'))", [userId, config.HOSTING_ENTITLEMENT_MODE === "hosted"]);
        await client.query("UPDATE provisioning_jobs j SET status='failed',locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,last_error='Subscription reconciliation revoked this paid mutation.',updated_at=NOW() FROM installations i WHERE $2::BOOLEAN AND j.installation_id=i.id AND i.user_id=$1 AND i.state='suspended' AND j.status IN ('queued','running') AND j.action IN ('install','upgrade','start','restore')", [userId, config.HOSTING_ENTITLEMENT_MODE === "hosted"]);
        await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,status,payload,worker_node_id) SELECT gen_random_uuid(),a.installation_id,'stop','queued',jsonb_build_object('applicationInstanceId',a.id::text,'reason','subscription_reconciliation'),a.worker_node_id FROM application_instances a JOIN installations i ON i.id=a.installation_id WHERE $2::BOOLEAN AND i.user_id=$1 AND i.state='suspended' AND a.state IN ('live','provisioning') AND a.worker_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provisioning_jobs j WHERE j.installation_id=a.installation_id AND j.action='stop' AND j.status IN ('queued','running') AND j.payload->>'applicationInstanceId'=a.id::text)", [userId, config.HOSTING_ENTITLEMENT_MODE === "hosted"]);
        await client.query("UPDATE installations i SET state=CASE WHEN EXISTS (SELECT 1 FROM application_instances a WHERE a.installation_id=i.id AND a.state='live') THEN 'live' ELSE 'provisioning' END,failure_reason=NULL,updated_at=NOW() WHERE i.user_id=$1 AND i.state='suspended' AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=i.id AND s.status IN ('active','trialing'))", [userId]);
        const result = await client.query("SELECT MAX(CASE i.plan WHEN 'fleet' THEN 2 WHEN 'scale' THEN 1 WHEN 'starter' THEN 0 END) rank FROM subscriptions s JOIN installations i ON i.id=s.installation_id WHERE s.user_id=$1 AND s.status IN ('active','trialing')", [userId]);
        const rawRank = result.rows[0]?.rank;
        const plan: SuitePlanId = rawRank === null || rawRank === undefined ? "none" : Number(rawRank) >= 2 ? "fleet" : Number(rawRank) >= 1 ? "scale" : "starter";
        let suiteWorkspaceUpdated = false;
        if (suiteTable) {
          const allowedModules = plan === "fleet" ? suiteModules.map((module) => module.id) : suiteModules.filter((module) => plan === "scale" ? module.minPlan !== "fleet" : plan === "starter" ? module.minPlan === "starter" : false).map((module) => module.id);
          const reconciled = await client.query("SELECT managed_oss_reconcile_suite_entitlement($1,$2,$3::TEXT[]) updated", [userId, plan, allowedModules]);
          suiteWorkspaceUpdated = Boolean(reconciled.rows[0]?.updated);
        }
        entitlements.push({ userId, plan, suiteWorkspaceUpdated });
      }
      await client.query("COMMIT");
      return entitlements;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async getActiveSubscription(userId: string, installationId: string) { const result = await this.pool.query("SELECT provider_subscription_id FROM subscriptions WHERE user_id=$1 AND installation_id=$2 AND status IN ('active','trialing') ORDER BY created_at DESC LIMIT 1", [userId, installationId]); return result.rows[0]?.provider_subscription_id ? { providerSubscriptionId: String(result.rows[0].provider_subscription_id) } : undefined; }
  async updateSubscriptionStatus(providerSubscriptionId: string, status: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT user_id,installation_id FROM subscriptions WHERE provider_subscription_id=$1", [providerSubscriptionId]);
      if (!existing.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      await client.query("SELECT id FROM provisioning_jobs WHERE installation_id=$1 AND status IN ('queued','running') ORDER BY id FOR UPDATE", [existing.rows[0].installation_id]);
      const result = await client.query("UPDATE subscriptions SET status=$2,updated_at=NOW() WHERE provider_subscription_id=$1 RETURNING user_id,installation_id", [providerSubscriptionId, status]);
      const row = result.rows[0];
      const entitlementActive = config.HOSTING_ENTITLEMENT_MODE === "unrestricted" || (await client.query("SELECT 1 FROM subscriptions WHERE installation_id=$1 AND status IN ('active','trialing') LIMIT 1", [row.installation_id])).rowCount === 1;
      await this.synchronizeCapacityAllocationEntitlement(client, String(row.installation_id), entitlementActive, "Subscription became inactive.");
      if (!entitlementActive) {
        await client.query("UPDATE installations SET state='suspended',failure_reason='Subscription inactive; customer routes and paid mutations are suspended.',updated_at=NOW() WHERE id=$1", [row.installation_id]);
        await client.query("UPDATE provisioning_jobs SET status='failed',locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,last_error='Subscription became inactive before this paid mutation completed.',updated_at=NOW() WHERE installation_id=$1 AND status IN ('queued','running') AND action IN ('install','upgrade','start','restore')", [row.installation_id]);
        await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,status,payload,worker_node_id) SELECT gen_random_uuid(),a.installation_id,'stop','queued',jsonb_build_object('applicationInstanceId',a.id::text,'reason','subscription_inactive'),a.worker_node_id FROM application_instances a WHERE a.installation_id=$1 AND a.state IN ('live','provisioning') AND a.worker_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provisioning_jobs j WHERE j.installation_id=a.installation_id AND j.action='stop' AND j.status IN ('queued','running') AND j.payload->>'applicationInstanceId'=a.id::text)", [row.installation_id]);
      } else {
        await client.query("UPDATE installations i SET state=CASE WHEN EXISTS (SELECT 1 FROM application_instances a WHERE a.installation_id=i.id AND a.state='live') THEN 'live' ELSE 'provisioning' END,failure_reason=NULL,updated_at=NOW() WHERE i.id=$1 AND i.state='suspended'", [row.installation_id]);
      }
      await client.query("COMMIT");
      return { userId: String(row.user_id), installationId: String(row.installation_id) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async getEffectiveSuitePlan(userId: string): Promise<SuitePlanId> { const result = await this.pool.query("SELECT MAX(CASE i.plan WHEN 'fleet' THEN 2 WHEN 'scale' THEN 1 WHEN 'starter' THEN 0 END) rank FROM subscriptions s JOIN installations i ON i.id=s.installation_id WHERE s.user_id=$1 AND s.status IN ('active','trialing')", [userId]); const rawRank = result.rows[0]?.rank; return rawRank === null || rawRank === undefined ? "none" : Number(rawRank) >= 2 ? "fleet" : Number(rawRank) >= 1 ? "scale" : "starter"; }
  async hasProcessedStripeEvent(eventId: string) { return (await this.pool.query("SELECT 1 FROM stripe_events WHERE event_id=$1", [eventId])).rowCount === 1; }
  async markStripeEventProcessed(eventId: string, eventType: string) { await this.pool.query("INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING", [eventId, eventType]); }
  async processPaidCheckout(input: ProcessPaidCheckoutInput) {
    const compensationDeadline = new Date(input.compensationDeadlineAt ?? Date.now() + config.PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS);
    if (!Number.isFinite(compensationDeadline.getTime()) || compensationDeadline <= new Date()) throw new Error("Paid checkout capacity recovery deadline must be in the future.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);
      await client.query("UPDATE checkout_capacity_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      const event = await client.query("INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id", [input.eventId, input.eventType]);
      if (!event.rowCount) { await client.query("ROLLBACK"); return false; }
      const holdResult = await client.query("SELECT hold.*,account.stripe_customer_id owned_stripe_customer_id FROM checkout_capacity_holds hold JOIN billing_accounts account ON account.user_id=hold.user_id WHERE hold.id=$1 FOR UPDATE OF hold", [input.holdId]);
      const hold = holdResult.rows[0];
      if (!hold || !["active", "expired"].includes(String(hold.state)) || String(hold.user_id) !== input.userId || String(hold.installation_id) !== input.installationId || String(hold.stripe_checkout_session_id ?? "") !== input.stripeCheckoutSessionId || String(hold.stripe_customer_id ?? "") !== input.stripeCustomerId || String(hold.owned_stripe_customer_id ?? "") !== input.stripeCustomerId || Number(hold.infrastructure_monthly_cents) !== input.infrastructureMonthlyCents || Number(hold.platform_fee_monthly_cents) !== input.platformFeeMonthlyCents) throw new Error("Paid checkout did not match an exact owned capacity hold and Stripe session.");
      const installationResult = await client.query("SELECT * FROM installations WHERE id=$1 AND user_id=$2 FOR UPDATE", [input.installationId, input.userId]);
      const installation = installationResult.rows[0];
      if (!installation || installation.state !== "planned" || String(installation.plan) !== String(hold.requested_plan) || JSON.stringify(installation.app_ids) !== JSON.stringify(hold.requested_app_ids)) throw new Error("Paid checkout capacity snapshot no longer matches the planned installation.");
      const itemResult = await client.query("SELECT item.*,a.installation_id,a.app_id current_app_id,a.state application_state,a.worker_node_id current_worker_node_id,a.memory_reservation_mb current_memory_reservation_mb,a.cpu_reservation_millis current_cpu_reservation_millis,a.storage_reservation_gb current_storage_reservation_gb,w.id existing_worker_id FROM checkout_capacity_hold_items item JOIN application_instances a ON a.id=item.application_instance_id LEFT JOIN worker_nodes w ON w.id=item.worker_node_id WHERE item.hold_id=$1 ORDER BY item.application_instance_id FOR UPDATE OF a", [input.holdId]);
      const planResult = await client.query("SELECT plan.*,w.id existing_worker_id FROM checkout_plan_capacity_holds plan LEFT JOIN worker_nodes w ON w.id=plan.worker_node_id WHERE plan.hold_id=$1", [input.holdId]);
      const plan = planResult.rows[0];
      const applicationCount = await client.query("SELECT COUNT(*)::INT count FROM application_instances WHERE installation_id=$1", [input.installationId]);
      if (!plan || String(plan.requested_plan) !== String(hold.requested_plan) || Number(applicationCount.rows[0].count) !== itemResult.rows.length || itemResult.rows.some((item) => String(item.installation_id) !== input.installationId || String(item.current_app_id) !== String(item.app_id) || item.application_state !== "queued" || item.current_worker_node_id || Number(item.current_memory_reservation_mb) !== Number(item.memory_reservation_mb) || Number(item.current_cpu_reservation_millis) !== Number(item.cpu_reservation_millis) || Number(item.current_storage_reservation_gb) !== Number(item.storage_reservation_gb))) throw new Error("Paid checkout capacity items no longer match the planned applications and logical plan quota.");
      let assignments = new Map<string, string>(itemResult.rows.map((item) => [String(item.application_instance_id), String(item.worker_node_id)]));
      let affinityWorker = String(plan.worker_node_id);
      if (hold.state === "expired") {
        const workersResult = await client.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY w.id FOR UPDATE OF w`);
        const workers = workersResult.rows.map((row) => this.worker(row));
        const placement = allocateCapacity(workers, itemResult.rows.map((item) => ({ applicationInstanceId: String(item.application_instance_id), appId: String(item.app_id), memoryReservationMb: Number(item.memory_reservation_mb), cpuReservationMillis: Number(item.cpu_reservation_millis), storageReservationGb: Number(item.storage_reservation_gb) })));
        affinityWorker = placement ? allocationAffinityWorker(workers, placement) ?? "" : "";
        if (!placement || !affinityWorker) {
          const subscription = await client.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) VALUES($1,$2,$3,$4,'paid_pending_capacity',$5,$6) ON CONFLICT(provider_subscription_id) DO NOTHING RETURNING id", [randomUUID(), input.userId, input.installationId, input.providerSubscriptionId, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents]);
          if (subscription.rowCount !== 1) throw new Error("Provider subscription is already bound to another checkout.");
          await client.query("INSERT INTO paid_checkout_capacity_recoveries(id,stripe_event_id,checkout_hold_id,user_id,installation_id,stripe_checkout_session_id,stripe_customer_id,provider_subscription_id,infrastructure_monthly_cents,platform_fee_monthly_cents,attempt_count,compensation_deadline_at,last_attempt_at,last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,NOW(),'No recently healthy worker could atomically place the paid checkout.')", [randomUUID(), input.eventId, input.holdId, input.userId, input.installationId, input.stripeCheckoutSessionId, input.stripeCustomerId, input.providerSubscriptionId, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents, compensationDeadline.toISOString()]);
          await client.query("COMMIT");
          return true;
        }
        assignments = placement;
      } else if (!plan.existing_worker_id || itemResult.rows.some((item) => !item.existing_worker_id)) throw new Error("An active paid checkout reservation lost its worker.");
      const subscription = await client.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) VALUES($1,$2,$3,$4,'active',$5,$6) ON CONFLICT(provider_subscription_id) DO NOTHING RETURNING id", [randomUUID(), input.userId, input.installationId, input.providerSubscriptionId, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents]);
      if (subscription.rowCount !== 1) throw new Error("Provider subscription is already bound to another checkout.");
      const allocationId = randomUUID();
      const allocation = await client.query("INSERT INTO installation_capacity_allocations(id,installation_id,worker_node_id,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,source_checkout_hold_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,generation", [allocationId, input.installationId, affinityWorker, plan.requested_plan, plan.allocation_memory_mb, plan.allocation_cpu_millis, plan.allocation_storage_gb, plan.allocation_max_services, input.holdId]);
      if (allocation.rowCount !== 1) throw new Error("Paid checkout could not create its durable plan capacity allocation.");
      await client.query("INSERT INTO installation_capacity_allocation_events(id,allocation_id,installation_id,event_type,generation,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,source_hold_id,reason) VALUES($1,$2,$3,'allocated',$4,$5,$6,$7,$8,$9,$10,'paid_checkout')", [randomUUID(), allocationId, input.installationId, allocation.rows[0].generation, plan.requested_plan, plan.allocation_memory_mb, plan.allocation_cpu_millis, plan.allocation_storage_gb, plan.allocation_max_services, input.holdId]);
      for (const item of itemResult.rows) {
        const applicationInstanceId = String(item.application_instance_id);
        const workerNodeId = assignments.get(applicationInstanceId);
        if (!workerNodeId) throw new Error("A paid checkout application lost its atomic worker placement.");
        const assigned = await client.query("UPDATE application_instances SET worker_node_id=$3,updated_at=NOW() WHERE id=$1 AND installation_id=$2 AND worker_node_id IS NULL RETURNING id", [applicationInstanceId, input.installationId, workerNodeId]);
        if (assigned.rowCount !== 1) throw new Error("Capacity hold assignments changed while payment was processed.");
        await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload,worker_node_id) VALUES($1,$2,'install',jsonb_build_object('stripeEventId',$3::text,'capacityHoldId',$4::text,'applicationInstanceId',$5::text),$6)", [randomUUID(), input.installationId, input.eventId, input.holdId, applicationInstanceId, workerNodeId]);
      }
      await client.query("UPDATE installations SET state=CASE WHEN $4::INT=0 THEN 'live' ELSE 'provisioning' END,worker_node_id=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2", [input.installationId, input.userId, affinityWorker, itemResult.rows.length]);
      if (hold.state === "active") {
        const consumed = await client.query("UPDATE checkout_capacity_holds SET state='consumed',provider_subscription_id=$2,consumed_at=NOW(),updated_at=NOW() WHERE id=$1 AND state='active' RETURNING id", [input.holdId, input.providerSubscriptionId]);
        if (consumed.rowCount !== 1) throw new Error("Capacity hold changed while payment was processed.");
      } else {
        await client.query("INSERT INTO paid_checkout_capacity_recoveries(id,stripe_event_id,checkout_hold_id,user_id,installation_id,stripe_checkout_session_id,stripe_customer_id,provider_subscription_id,infrastructure_monthly_cents,platform_fee_monthly_cents,state,attempt_count,compensation_deadline_at,last_attempt_at,fulfilled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'fulfilled',1,$11,NOW(),NOW())", [randomUUID(), input.eventId, input.holdId, input.userId, input.installationId, input.stripeCheckoutSessionId, input.stripeCustomerId, input.providerSubscriptionId, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents, compensationDeadline.toISOString()]);
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async getPaidCheckoutCapacityRecovery(providerSubscriptionId: string) {
    const result = await this.pool.query("SELECT * FROM paid_checkout_capacity_recoveries WHERE provider_subscription_id=$1", [providerSubscriptionId]);
    return result.rows[0] ? this.paidCheckoutCapacityRecovery(result.rows[0]) : undefined;
  }
  async advancePaidCheckoutCapacityRecovery(providerSubscriptionId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recoveryResult = await client.query("SELECT * FROM paid_checkout_capacity_recoveries WHERE provider_subscription_id=$1 FOR UPDATE", [providerSubscriptionId]);
      if (!recoveryResult.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      const recovery = this.paidCheckoutCapacityRecovery(recoveryResult.rows[0]);
      if (recovery.state !== "pending_capacity" || new Date(recovery.compensationDeadlineAt) > new Date()) { await client.query("COMMIT"); return recovery; }
      const updated = await client.query("UPDATE paid_checkout_capacity_recoveries SET state='compensation_required',attempt_count=attempt_count+1,last_attempt_at=NOW(),compensation_required_at=NOW(),last_error='Capacity recovery deadline elapsed; cancel the provider subscription and refund the captured payment.',updated_at=NOW() WHERE id=$1 AND state='pending_capacity' RETURNING *", [recovery.id]);
      const subscription = await client.query("UPDATE subscriptions SET status='compensation_required',updated_at=NOW() WHERE provider_subscription_id=$1 AND user_id=$2 AND installation_id=$3 AND status='paid_pending_capacity' RETURNING id", [providerSubscriptionId, recovery.userId, recovery.installationId]);
      if (updated.rowCount !== 1 || subscription.rowCount !== 1) throw new Error("Pending paid capacity recovery lost its exact local subscription obligation.");
      await client.query("COMMIT");
      return this.paidCheckoutCapacityRecovery(updated.rows[0]);
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  async retryPaidCheckoutCapacityRecovery(confirmation: PaidCheckoutProviderConfirmation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);
      const recoveryResult = await client.query("SELECT * FROM paid_checkout_capacity_recoveries WHERE provider_subscription_id=$1 FOR UPDATE", [confirmation.providerSubscriptionId]);
      if (!recoveryResult.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      let recovery = this.paidCheckoutCapacityRecovery(recoveryResult.rows[0]);
      if (recovery.state !== "pending_capacity") { await client.query("COMMIT"); return recovery; }
      if (new Date() >= new Date(recovery.compensationDeadlineAt)) {
        const updated = await client.query("UPDATE paid_checkout_capacity_recoveries SET state='compensation_required',attempt_count=attempt_count+1,last_attempt_at=NOW(),compensation_required_at=NOW(),last_error='Capacity recovery deadline elapsed; cancel the provider subscription and refund the captured payment.',updated_at=NOW() WHERE id=$1 AND state='pending_capacity' RETURNING *", [recovery.id]);
        const subscription = await client.query("UPDATE subscriptions SET status='compensation_required',updated_at=NOW() WHERE provider_subscription_id=$1 AND user_id=$2 AND installation_id=$3 AND status='paid_pending_capacity' RETURNING id", [recovery.providerSubscriptionId, recovery.userId, recovery.installationId]);
        if (updated.rowCount !== 1 || subscription.rowCount !== 1) throw new Error("Pending paid capacity recovery lost its exact local subscription obligation.");
        await client.query("COMMIT");
        return this.paidCheckoutCapacityRecovery(updated.rows[0]);
      }
      if (confirmation.problems.length || !["active", "trialing"].includes(confirmation.status) || confirmation.userId !== recovery.userId || confirmation.installationId !== recovery.installationId || confirmation.capacityHoldId !== recovery.checkoutHoldId || confirmation.customerId !== recovery.stripeCustomerId || confirmation.infrastructureMonthlyCents !== recovery.infrastructureMonthlyCents || confirmation.platformFeeMonthlyCents !== recovery.platformFeeMonthlyCents) throw new Error("Provider confirmation did not exactly match the pending paid capacity obligation.");
      const holdResult = await client.query("SELECT * FROM checkout_capacity_holds WHERE id=$1 FOR UPDATE", [recovery.checkoutHoldId]);
      const hold = holdResult.rows[0];
      if (!hold || hold.state !== "expired" || String(hold.user_id) !== recovery.userId || String(hold.installation_id) !== recovery.installationId || String(hold.stripe_checkout_session_id) !== recovery.stripeCheckoutSessionId || String(hold.stripe_customer_id) !== recovery.stripeCustomerId) throw new Error("Pending paid capacity recovery lost its immutable expired checkout hold.");
      const installationResult = await client.query("SELECT * FROM installations WHERE id=$1 AND user_id=$2 AND state='planned' FOR UPDATE", [recovery.installationId, recovery.userId]);
      const installation = installationResult.rows[0];
      if (!installation || String(installation.plan) !== String(hold.requested_plan) || JSON.stringify(installation.app_ids) !== JSON.stringify(hold.requested_app_ids)) throw new Error("Pending paid capacity recovery installation snapshot changed.");
      if ((await client.query("SELECT 1 FROM installation_capacity_allocations WHERE installation_id=$1 AND state IN ('active','suspended')", [recovery.installationId])).rowCount) throw new Error("Pending paid capacity recovery found an unexpected capacity allocation.");
      const itemResult = await client.query("SELECT item.*,a.installation_id,a.app_id current_app_id,a.state application_state,a.worker_node_id current_worker_node_id,a.memory_reservation_mb current_memory_reservation_mb,a.cpu_reservation_millis current_cpu_reservation_millis,a.storage_reservation_gb current_storage_reservation_gb FROM checkout_capacity_hold_items item JOIN application_instances a ON a.id=item.application_instance_id WHERE item.hold_id=$1 ORDER BY item.application_instance_id FOR UPDATE OF a", [recovery.checkoutHoldId]);
      const planResult = await client.query("SELECT * FROM checkout_plan_capacity_holds WHERE hold_id=$1", [recovery.checkoutHoldId]);
      const plan = planResult.rows[0];
      const applicationCount = await client.query("SELECT COUNT(*)::INT count FROM application_instances WHERE installation_id=$1", [recovery.installationId]);
      if (!plan || Number(applicationCount.rows[0].count) !== itemResult.rows.length || itemResult.rows.some((item) => String(item.installation_id) !== recovery.installationId || String(item.current_app_id) !== String(item.app_id) || item.application_state !== "queued" || item.current_worker_node_id || Number(item.current_memory_reservation_mb) !== Number(item.memory_reservation_mb) || Number(item.current_cpu_reservation_millis) !== Number(item.cpu_reservation_millis) || Number(item.current_storage_reservation_gb) !== Number(item.storage_reservation_gb))) throw new Error("Pending paid capacity recovery applications changed.");
      const workersResult = await client.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY w.id FOR UPDATE OF w`);
      const workers = workersResult.rows.map((row) => this.worker(row));
      const assignments = allocateCapacity(workers, itemResult.rows.map((item) => ({ applicationInstanceId: String(item.application_instance_id), appId: String(item.app_id), memoryReservationMb: Number(item.memory_reservation_mb), cpuReservationMillis: Number(item.cpu_reservation_millis), storageReservationGb: Number(item.storage_reservation_gb) })));
      const affinityWorker = assignments ? allocationAffinityWorker(workers, assignments) : undefined;
      if (!assignments || !affinityWorker) {
        const updated = await client.query("UPDATE paid_checkout_capacity_recoveries SET attempt_count=attempt_count+1,last_attempt_at=NOW(),last_error='No recently healthy worker could atomically place the pending paid checkout.',updated_at=NOW() WHERE id=$1 AND state='pending_capacity' RETURNING *", [recovery.id]);
        await client.query("COMMIT");
        return this.paidCheckoutCapacityRecovery(updated.rows[0]);
      }
      const allocationId = randomUUID();
      const allocation = await client.query("INSERT INTO installation_capacity_allocations(id,installation_id,worker_node_id,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,source_checkout_hold_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,generation", [allocationId, recovery.installationId, affinityWorker, plan.requested_plan, plan.allocation_memory_mb, plan.allocation_cpu_millis, plan.allocation_storage_gb, plan.allocation_max_services, recovery.checkoutHoldId]);
      await client.query("INSERT INTO installation_capacity_allocation_events(id,allocation_id,installation_id,event_type,generation,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,source_hold_id,reason) VALUES($1,$2,$3,'allocated',$4,$5,$6,$7,$8,$9,$10,'paid_checkout_capacity_recovered')", [randomUUID(), allocationId, recovery.installationId, allocation.rows[0].generation, plan.requested_plan, plan.allocation_memory_mb, plan.allocation_cpu_millis, plan.allocation_storage_gb, plan.allocation_max_services, recovery.checkoutHoldId]);
      for (const item of itemResult.rows) {
        const applicationInstanceId = String(item.application_instance_id);
        const workerNodeId = assignments.get(applicationInstanceId);
        if (!workerNodeId) throw new Error("A recovered paid checkout application lost its atomic worker placement.");
        if ((await client.query("UPDATE application_instances SET worker_node_id=$3,updated_at=NOW() WHERE id=$1 AND installation_id=$2 AND worker_node_id IS NULL RETURNING id", [applicationInstanceId, recovery.installationId, workerNodeId])).rowCount !== 1) throw new Error("A recovered paid checkout application changed during placement.");
        await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload,worker_node_id) VALUES($1,$2,'install',jsonb_build_object('stripeEventId',$3::text,'capacityHoldId',$4::text,'applicationInstanceId',$5::text,'paidCapacityRecoveryId',$6::text),$7)", [randomUUID(), recovery.installationId, recovery.stripeEventId, recovery.checkoutHoldId, applicationInstanceId, recovery.id, workerNodeId]);
      }
      await client.query("UPDATE installations SET state=CASE WHEN $4::INT=0 THEN 'live' ELSE 'provisioning' END,worker_node_id=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2", [recovery.installationId, recovery.userId, affinityWorker, itemResult.rows.length]);
      const activated = await client.query("UPDATE subscriptions SET status='active',infrastructure_monthly_cents=$2,platform_fee_monthly_cents=$3,updated_at=NOW() WHERE provider_subscription_id=$1 AND user_id=$4 AND installation_id=$5 AND status='paid_pending_capacity' RETURNING id", [recovery.providerSubscriptionId, recovery.infrastructureMonthlyCents, recovery.platformFeeMonthlyCents, recovery.userId, recovery.installationId]);
      if (activated.rowCount !== 1) throw new Error("Recovered paid capacity lost its exact local subscription obligation.");
      const updated = await client.query("UPDATE paid_checkout_capacity_recoveries SET state='fulfilled',attempt_count=attempt_count+1,last_attempt_at=NOW(),fulfilled_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1 AND state='pending_capacity' RETURNING *", [recovery.id]);
      await client.query("COMMIT");
      recovery = this.paidCheckoutCapacityRecovery(updated.rows[0]);
      return recovery;
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  async getPlanCapacityChangeHold(holdId: string) {
    await this.pool.query("UPDATE plan_capacity_change_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE id=$1 AND state='active' AND expires_at<=NOW()", [holdId]);
    const result = await this.pool.query("SELECT * FROM plan_capacity_change_holds WHERE id=$1", [holdId]);
    return result.rows[0] ? this.planCapacityChangeHold(result.rows[0]) : undefined;
  }
  async markPaidCheckoutCapacityCompensated(providerSubscriptionId: string, compensationReference: string) {
    const reference = compensationReference.trim();
    if (!reference) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query("UPDATE paid_checkout_capacity_recoveries SET state='compensated',compensated_at=NOW(),compensation_reference=$2,updated_at=NOW() WHERE provider_subscription_id=$1 AND state='compensation_required' RETURNING *", [providerSubscriptionId, reference]);
      if (!updated.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      const recovery = this.paidCheckoutCapacityRecovery(updated.rows[0]);
      const subscription = await client.query("UPDATE subscriptions SET status='canceled',updated_at=NOW() WHERE provider_subscription_id=$1 AND user_id=$2 AND installation_id=$3 AND status='compensation_required' RETURNING id", [providerSubscriptionId, recovery.userId, recovery.installationId]);
      if (subscription.rowCount !== 1) throw new Error("Compensation cannot be recorded without the exact local paid-capacity obligation.");
      await client.query("COMMIT");
      return recovery;
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  async getInstallationCapacityAllocation(userId: string, installationId: string) {
    const result = await this.pool.query("SELECT allocation.* FROM installation_capacity_allocations allocation JOIN installations i ON i.id=allocation.installation_id WHERE allocation.installation_id=$1 AND i.user_id=$2 AND allocation.state IN ('active','suspended') ORDER BY allocation.generation DESC LIMIT 1", [installationId, userId]);
    return result.rows[0] ? this.capacityAllocation(result.rows[0]) : undefined;
  }
  async acquirePlanCapacityChangeHold(input: AcquirePlanCapacityChangeHoldInput) {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new Error("Plan capacity change hold expiry must be in the future.");
    const configured = config.plans.find((plan) => plan.id === input.requested.planId);
    if (!configured || !samePlanCapacity(input.requested, planCapacitySnapshot(configured))) throw new Error("Plan resize must hold the complete configured target quota.");
    const configuredPlatformFee = Math.max(Math.ceil(configured.infrastructureMonthlyCents * (config.PLATFORM_FEE_PERCENT / 100)), config.PLATFORM_FEE_MIN_CENTS);
    if (input.infrastructureMonthlyCents !== configured.infrastructureMonthlyCents || input.platformFeeMonthlyCents !== configuredPlatformFee) throw new Error("Plan resize prices do not match the configured target plan.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);
      await client.query("UPDATE plan_capacity_change_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      const existingResult = await client.query("SELECT * FROM plan_capacity_change_holds WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE", [input.userId, input.idempotencyKey]);
      if (existingResult.rows[0]) {
        const existing = this.planCapacityChangeHold(existingResult.rows[0]);
        const same = existing.installationId === input.installationId && existing.providerSubscriptionId === input.providerSubscriptionId && samePlanCapacity(existing, input.requested) && existing.infrastructureMonthlyCents === input.infrastructureMonthlyCents && existing.platformFeeMonthlyCents === input.platformFeeMonthlyCents;
        if (!same) throw new Error("The resize idempotency key is already bound to a different plan capacity request.");
        await client.query("COMMIT");
        return existing.state === "active" ? existing : undefined;
      }
      if ((await client.query("SELECT 1 FROM plan_capacity_change_holds WHERE installation_id=$1 AND state='active' LIMIT 1 FOR UPDATE", [input.installationId])).rowCount) { await client.query("ROLLBACK"); return undefined; }
      const targetResult = await client.query("SELECT i.user_id,i.plan installation_plan,i.worker_node_id installation_worker,allocation.*,subscription.provider_subscription_id,subscription.status subscription_status FROM installations i JOIN installation_capacity_allocations allocation ON allocation.installation_id=i.id AND allocation.state='active' JOIN subscriptions subscription ON subscription.installation_id=i.id AND subscription.provider_subscription_id=$3 AND subscription.status IN ('active','trialing') WHERE i.id=$1 AND i.user_id=$2 FOR UPDATE OF i,allocation,subscription", [input.installationId, input.userId, input.providerSubscriptionId]);
      const target = targetResult.rows[0];
      if (!target || String(target.installation_plan) !== String(target.plan) || String(target.installation_worker ?? "") !== String(target.worker_node_id)) { await client.query("ROLLBACK"); return undefined; }
      const usageResult = await client.query("SELECT COUNT(*)::int services,COALESCE(SUM(memory_reservation_mb),0)::int memory_mb,COALESCE(SUM(cpu_reservation_millis),0)::int cpu_millis,COALESCE(SUM(storage_reservation_gb),0)::int storage_gb FROM application_instances WHERE installation_id=$1", [input.installationId]);
      const usage = usageResult.rows[0];
      if (!capacityEnvelopeFit({ services: Number(usage.services), memoryMb: Number(usage.memory_mb) + input.memorySafetyReserveMb, cpuMillis: Number(usage.cpu_millis), storageGb: Number(usage.storage_gb) }, input.requested).fits) { await client.query("ROLLBACK"); return undefined; }
      const current = this.capacityAllocation(target);
      const delta = positiveCapacityDelta(current, input.requested);
      const holdResult = await client.query("INSERT INTO plan_capacity_change_holds(id,user_id,installation_id,allocation_id,idempotency_key,expected_generation,from_plan,requested_plan,worker_node_id,target_memory_mb,target_cpu_millis,target_storage_gb,target_max_services,reserved_delta_memory_mb,reserved_delta_cpu_millis,reserved_delta_storage_gb,infrastructure_monthly_cents,platform_fee_monthly_cents,provider_subscription_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *", [randomUUID(), input.userId, input.installationId, current.id, input.idempotencyKey, current.generation, current.planId, input.requested.planId, current.workerNodeId, input.requested.memoryMb, input.requested.cpuMillis, input.requested.storageGb, input.requested.maxServices, delta.memoryMb, delta.cpuMillis, delta.storageGb, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents, input.providerSubscriptionId, input.expiresAt]);
      await client.query("COMMIT");
      return this.planCapacityChangeHold(holdResult.rows[0]);
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  async releasePlanCapacityChangeHold(holdId: string, userId: string, reason: string) {
    const result = await this.pool.query("UPDATE plan_capacity_change_holds SET state='released',released_at=NOW(),release_reason=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND state='active' RETURNING id", [holdId, userId, reason.slice(0, 500)]);
    return result.rowCount === 1;
  }
  async consumePlanCapacityChangeHold(holdId: string, userId: string, providerConfirmationSource = "provider_update_response") {
    const confirmationSource = providerConfirmationSource.trim().slice(0, 100);
    if (!confirmationSource) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);
      await client.query("UPDATE plan_capacity_change_holds SET state='expired',expired_at=NOW(),updated_at=NOW() WHERE id=$1 AND state='active' AND expires_at<=NOW()", [holdId]);
      const holdResult = await client.query("SELECT * FROM plan_capacity_change_holds WHERE id=$1 AND user_id=$2 FOR UPDATE", [holdId, userId]);
      const hold = holdResult.rows[0] ? this.planCapacityChangeHold(holdResult.rows[0]) : undefined;
      if (!hold) { await client.query("ROLLBACK"); return undefined; }
      const allocationResult = await client.query("SELECT * FROM installation_capacity_allocations WHERE id=$1 FOR UPDATE", [hold.allocationId]);
      if (hold.state === "consumed") {
        const current = allocationResult.rows[0] ? this.capacityAllocation(allocationResult.rows[0]) : undefined;
        await client.query("COMMIT");
        return current?.generation === hold.expectedGeneration + 1 && current.planId === hold.planId ? current : undefined;
      }
      if (!["active", "expired"].includes(hold.state)) { await client.query("ROLLBACK"); return undefined; }
      const changed = await client.query("UPDATE installation_capacity_allocations SET plan=$2,allocation_memory_mb=$3,allocation_cpu_millis=$4,allocation_storage_gb=$5,allocation_max_services=$6,generation=generation+1,updated_at=NOW() WHERE id=$1 AND installation_id=$7 AND worker_node_id=$8 AND state='active' AND generation=$9 AND plan=$10 RETURNING *", [hold.allocationId, hold.planId, hold.memoryMb, hold.cpuMillis, hold.storageGb, hold.maxServices, hold.installationId, hold.workerNodeId, hold.expectedGeneration, hold.fromPlan]);
      if (changed.rowCount !== 1) throw new Error("The paid plan quota changed before its reserved resize committed.");
      const installation = await client.query("UPDATE installations SET plan=$2,updated_at=NOW() WHERE id=$1 AND user_id=$3 AND plan=$4 AND worker_node_id=$5 RETURNING id", [hold.installationId, hold.planId, userId, hold.fromPlan, hold.workerNodeId]);
      if (installation.rowCount !== 1) throw new Error("The installation changed before its reserved resize committed.");
      const subscription = await client.query("UPDATE subscriptions SET infrastructure_monthly_cents=$2,platform_fee_monthly_cents=$3,updated_at=NOW() WHERE provider_subscription_id=$1 AND installation_id=$4 AND user_id=$5 AND status IN ('active','trialing') RETURNING id", [hold.providerSubscriptionId, hold.infrastructureMonthlyCents, hold.platformFeeMonthlyCents, hold.installationId, userId]);
      if (subscription.rowCount !== 1) throw new Error("The paid subscription changed before its reserved resize committed.");
      await client.query("INSERT INTO installation_capacity_allocation_events(id,allocation_id,installation_id,event_type,generation,plan,allocation_memory_mb,allocation_cpu_millis,allocation_storage_gb,allocation_max_services,source_hold_id,reason) VALUES($1,$2,$3,'resized',$4,$5,$6,$7,$8,$9,$10,'provider_subscription_updated')", [randomUUID(), hold.allocationId, hold.installationId, changed.rows[0].generation, hold.planId, hold.memoryMb, hold.cpuMillis, hold.storageGb, hold.maxServices, hold.id]);
      const consumed = await client.query("UPDATE plan_capacity_change_holds SET state='consumed',consumed_at=NOW(),provider_committed_at=NOW(),provider_confirmation_source=$2,updated_at=NOW() WHERE id=$1 AND state IN ('active','expired') RETURNING id", [hold.id, confirmationSource]);
      if (consumed.rowCount !== 1) throw new Error("The plan capacity change hold changed while its provider update committed.");
      await client.query("COMMIT");
      return this.capacityAllocation(changed.rows[0]);
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  async listBackups(userId: string, installationId: string) { const result = await this.pool.query("SELECT b.* FROM backups b JOIN installations i ON i.id=b.installation_id WHERE b.installation_id=$1 AND i.user_id=$2 ORDER BY b.created_at DESC", [installationId, userId]); return result.rows.map((row) => ({ id: String(row.id), installationId: String(row.installation_id), applicationInstanceId: String(row.application_instance_id), objectName: String(row.object_name), sizeBytes: Number(row.size_bytes), status: row.status, createdAt: databaseTimestampIso(row.created_at) })) as BackupRecord[]; }
  async registerWorkerNode(input: WorkerRegistration) {
    const agentToken = newAgentToken();
    const result = await this.pool.query("INSERT INTO worker_nodes(id,name,status,private_address,machine_type,capacity_memory_mb,capacity_cpu_millis,capacity_storage_gb,system_reserve_memory_mb,agent_token_hash) VALUES($1,$2,'ready',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,status='ready',private_address=EXCLUDED.private_address,machine_type=EXCLUDED.machine_type,capacity_memory_mb=EXCLUDED.capacity_memory_mb,capacity_cpu_millis=EXCLUDED.capacity_cpu_millis,capacity_storage_gb=EXCLUDED.capacity_storage_gb,system_reserve_memory_mb=EXCLUDED.system_reserve_memory_mb,agent_token_hash=EXCLUDED.agent_token_hash,last_heartbeat_at=NOW(),updated_at=NOW() RETURNING *,0 reserved_memory_mb,0 reserved_cpu_millis,0 reserved_storage_gb", [input.id, input.name, input.privateAddress, input.machineType, input.capacityMemoryMb, input.capacityCpuMillis, input.capacityStorageGb, input.systemReserveMemoryMb, agentTokenHash(agentToken)]);
    return { node: this.worker(result.rows[0]), agentToken };
  }
  async findWorkerNodeByAgentToken(token: string) {
    const result = await this.pool.query(`SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM worker_nodes w ${committedWorkerCapacitySql} WHERE w.agent_token_hash=$1`, [agentTokenHash(token)]);
    return result.rows[0] ? this.worker(result.rows[0]) : undefined;
  }
  async heartbeatWorkerNode(nodeId: string, input: { privateAddress: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number }) {
    const result = await this.pool.query(`WITH extended AS (UPDATE provisioning_jobs SET lease_expires_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE worker_node_id=$1 AND status='running'), updated AS (UPDATE worker_nodes SET private_address=$2,capacity_memory_mb=$3,capacity_cpu_millis=$4,capacity_storage_gb=$5,last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *) SELECT w.*,committed.memory reserved_memory_mb,committed.cpu reserved_cpu_millis,committed.storage reserved_storage_gb FROM updated w ${committedWorkerCapacitySql}`, [nodeId, input.privateAddress, input.capacityMemoryMb, input.capacityCpuMillis, input.capacityStorageGb]);
    return result.rows[0] ? this.worker(result.rows[0]) : undefined;
  }
  async getWorkerNodeActivity(nodeId: string) { return this.workerActivity(this.pool, nodeId); }
  async setWorkerNodeMode(nodeId: string, mode: WorkerNodeMode) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query("UPDATE worker_nodes SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING id", [nodeId, mode === "draining" ? "draining" : "ready"]);
      if (!updated.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      const activity = await this.workerActivity(client, nodeId);
      await client.query("COMMIT");
      return activity;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async claimWorkerJob(nodeId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE provisioning_jobs SET status='queued',locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,available_at=NOW(),updated_at=NOW() WHERE status='running' AND lease_expires_at<NOW() AND attempts<3");
      const nodeResult = await client.query("SELECT * FROM worker_nodes WHERE id=$1 AND status='ready' AND last_heartbeat_at>NOW()-INTERVAL '2 minutes' FOR UPDATE", [nodeId]);
      if (!nodeResult.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      const active = await client.query("SELECT * FROM provisioning_jobs WHERE worker_node_id=$1 AND status='running' ORDER BY locked_at LIMIT 1 FOR UPDATE", [nodeId]);
      if (active.rows[0]) {
        let job = active.rows[0];
        if (paidWorkerActions.has(job.action) && config.HOSTING_ENTITLEMENT_MODE !== "unrestricted") {
          const entitlement = await client.query("SELECT status FROM subscriptions WHERE installation_id=$1 ORDER BY id FOR SHARE", [job.installation_id]);
          if (!entitlement.rows.some((subscription) => ["active", "trialing"].includes(String(subscription.status)))) {
            await client.query("UPDATE provisioning_jobs SET status='failed',locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,last_error='Subscription entitlement was revoked before this paid mutation could resume.',updated_at=NOW() WHERE id=$1", [job.id]);
            await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,status,payload,worker_node_id) SELECT gen_random_uuid(),a.installation_id,'stop','queued',jsonb_build_object('applicationInstanceId',a.id::text,'reason','subscription_inactive'),a.worker_node_id FROM application_instances a WHERE a.installation_id=$1 AND a.state IN ('live','provisioning') AND a.worker_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provisioning_jobs cleanup WHERE cleanup.installation_id=a.installation_id AND cleanup.action='stop' AND cleanup.status IN ('queued','running') AND cleanup.payload->>'applicationInstanceId'=a.id::text)", [job.installation_id]);
            await client.query("COMMIT");
            return undefined;
          }
        }
        job = (await client.query("UPDATE provisioning_jobs SET lease_expires_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE id=$1 AND status='running' RETURNING *", [job.id])).rows[0];
        const apps = await client.query("SELECT * FROM application_instances WHERE installation_id=$1 AND (NOT ($2::jsonb ? 'applicationInstanceId') OR id=($2::jsonb->>'applicationInstanceId')::uuid) ORDER BY created_at", [job.installation_id, job.payload ?? {}]);
        await client.query("COMMIT");
        return { id: String(job.id), installationId: String(job.installation_id), action: job.action, status: job.status, attempts: Number(job.attempts), payload: job.payload ?? {}, workerNodeId: nodeId, leaseExpiresAt: databaseTimestampIso(job.lease_expires_at), createdAt: databaseTimestampIso(job.created_at), applications: apps.rows.map((app) => this.application(app)) } as AgentJob;
      }
      const node = nodeResult.rows[0];
      const reservation = await client.query(`SELECT COALESCE(SUM(capacity.memory),0) memory,COALESCE(SUM(capacity.cpu),0) cpu,COALESCE(SUM(capacity.storage),0) storage FROM (
        SELECT a.memory_reservation_mb memory,a.cpu_reservation_millis cpu,a.storage_reservation_gb storage FROM application_instances a WHERE a.worker_node_id=$1
        UNION ALL SELECT item.memory_reservation_mb,item.cpu_reservation_millis,item.storage_reservation_gb FROM checkout_capacity_hold_items item JOIN checkout_capacity_holds hold ON hold.id=item.hold_id WHERE item.worker_node_id=$1 AND hold.state='active' AND hold.expires_at>NOW()
      ) capacity`, [nodeId]);
      const assigned = await client.query("SELECT j.* FROM provisioning_jobs j WHERE j.status='queued' AND j.available_at<=NOW() AND j.worker_node_id=$1 AND (j.action IN ('stop','uninstall','backup') OR $2::BOOLEAN OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=j.installation_id AND s.status IN ('active','trialing'))) ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1", [nodeId, config.HOSTING_ENTITLEMENT_MODE === "unrestricted"]);
      let row = assigned.rows[0];
      if (!row) {
        const candidates = await client.query(`
          SELECT j.*,placement.*
          FROM provisioning_jobs j
          JOIN installations i ON i.id=j.installation_id
          CROSS JOIN LATERAL (
            SELECT
              COUNT(*) FILTER (WHERE a.worker_node_id IS NULL)::int required_app_count,
              COALESCE(SUM(a.memory_reservation_mb) FILTER (WHERE a.worker_node_id IS NULL),0)::int required_memory_mb,
              COALESCE(SUM(a.cpu_reservation_millis) FILTER (WHERE a.worker_node_id IS NULL),0)::int required_cpu_millis,
              COALESCE(SUM(a.storage_reservation_gb) FILTER (WHERE a.worker_node_id IS NULL),0)::int required_storage_gb,
              CASE WHEN COUNT(*)>0 AND COUNT(*) FILTER (WHERE a.worker_node_id IS NULL)=0 AND COUNT(DISTINCT a.worker_node_id)=1 THEN MIN(a.worker_node_id) END existing_worker_node_id
            FROM application_instances a
            WHERE a.installation_id=j.installation_id AND (NOT (j.payload ? 'applicationInstanceId') OR a.id=(j.payload->>'applicationInstanceId')::uuid)
          ) placement
          WHERE j.status='queued' AND j.available_at<=NOW() AND j.worker_node_id IS NULL
            AND j.action IN ('install','upgrade','start','stop','uninstall','backup','restore')
            AND (j.action IN ('stop','uninstall','backup') OR $2::BOOLEAN OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=j.installation_id AND s.status IN ('active','trialing')))
            AND (j.action='install' OR placement.existing_worker_node_id=$1)
          ORDER BY j.created_at
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 20
        `, [nodeId, config.HOSTING_ENTITLEMENT_MODE === "unrestricted"]);
        const availableMemory = Number(node.capacity_memory_mb) - Number(node.system_reserve_memory_mb) - Number(reservation.rows[0].memory);
        const availableCpu = Number(node.capacity_cpu_millis) - Number(reservation.rows[0].cpu);
        const availableStorage = Number(node.capacity_storage_gb) - Number(reservation.rows[0].storage);
        row = candidates.rows.find((candidate) => candidate.action === "install"
          ? Number(candidate.required_app_count) > 0 && Number(candidate.required_memory_mb) <= availableMemory && Number(candidate.required_cpu_millis) <= availableCpu && Number(candidate.required_storage_gb) <= availableStorage
          : candidate.existing_worker_node_id === nodeId);
      }
      if (!row) { await client.query("COMMIT"); return undefined; }
      if (paidWorkerActions.has(row.action) && config.HOSTING_ENTITLEMENT_MODE !== "unrestricted") {
        const entitlement = await client.query("SELECT status FROM subscriptions WHERE installation_id=$1 ORDER BY id FOR SHARE", [row.installation_id]);
        if (!entitlement.rows.some((subscription) => ["active", "trialing"].includes(String(subscription.status)))) { await client.query("COMMIT"); return undefined; }
      }
      const claimed = await client.query("UPDATE provisioning_jobs SET worker_node_id=$1,status='running',attempts=attempts+1,locked_at=NOW(),locked_by=$1,lease_expires_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE id=$2 AND status='queued' RETURNING *", [nodeId, row.id]);
      if (!claimed.rows[0]) { await client.query("COMMIT"); return undefined; }
      if (row.action === "install") await client.query("UPDATE application_instances SET worker_node_id=COALESCE(worker_node_id,$1),state='provisioning',updated_at=NOW() WHERE installation_id=$2 AND (worker_node_id IS NULL OR worker_node_id=$1) AND (NOT ($3::jsonb ? 'applicationInstanceId') OR id=($3::jsonb->>'applicationInstanceId')::uuid)", [nodeId, row.installation_id, row.payload]);
      const apps = await client.query("SELECT * FROM application_instances WHERE installation_id=$1 AND (NOT ($2::jsonb ? 'applicationInstanceId') OR id=($2::jsonb->>'applicationInstanceId')::uuid) ORDER BY created_at", [row.installation_id, row.payload]);
      await client.query("COMMIT");
      const job = claimed.rows[0];
      return { id: String(job.id), installationId: String(job.installation_id), action: job.action, status: job.status, attempts: Number(job.attempts), payload: job.payload ?? {}, workerNodeId: nodeId, leaseExpiresAt: databaseTimestampIso(job.lease_expires_at), createdAt: databaseTimestampIso(job.created_at), applications: apps.rows.map((app) => this.application(app)) } as AgentJob;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async reportWorkerJob(nodeId: string, jobId: string, report: WorkerJobReport) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM provisioning_jobs WHERE id=$1 AND worker_node_id=$2 AND status='running' FOR UPDATE", [jobId, nodeId]);
      const job = result.rows[0];
      if (!job) { await client.query("ROLLBACK"); return false; }
      if (report.status === "failed" && Number(job.attempts) < 3) {
        await client.query("UPDATE provisioning_jobs SET status='queued',available_at=NOW()+(attempts*INTERVAL '1 minute'),locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,last_error=$1,updated_at=NOW() WHERE id=$2", [(report.error ?? "Worker job failed").slice(0, 1000), jobId]);
      } else {
        await client.query("UPDATE provisioning_jobs SET status=$1,locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,last_error=$2,updated_at=NOW() WHERE id=$3", [report.status, report.error?.slice(0, 1000) ?? null, jobId]);
        for (const app of report.applications ?? []) await client.query("UPDATE application_instances SET state=$1,last_health_at=CASE WHEN $2 THEN NOW() ELSE last_health_at END,updated_at=NOW() WHERE id=$3 AND worker_node_id=$4", [app.state, app.healthy ?? false, app.id, nodeId]);
        if (report.status === "succeeded") {
          const aggregate = await client.query("SELECT COUNT(*) FILTER (WHERE state='failed') failed,COUNT(*) FILTER (WHERE state IN ('queued','provisioning')) pending,COUNT(*) FILTER (WHERE state='live') live,COUNT(*) total FROM application_instances WHERE installation_id=$1", [job.installation_id]);
          const counts = aggregate.rows[0];
          const entitled = config.HOSTING_ENTITLEMENT_MODE === "unrestricted" || (await client.query("SELECT 1 FROM subscriptions WHERE installation_id=$1 AND status IN ('active','trialing') LIMIT 1", [job.installation_id])).rowCount === 1;
          const state = !entitled ? "suspended" : Number(counts.failed) > 0 ? "failed" : Number(counts.live) === Number(counts.total) ? "live" : "provisioning";
          await client.query("UPDATE installations SET state=$1,failure_reason=CASE WHEN $1='suspended' THEN COALESCE(failure_reason,'Subscription inactive; customer routes and paid mutations are suspended.') ELSE NULL END,updated_at=NOW() WHERE id=$2", [state, job.installation_id]);
          if (job.action === "uninstall") await client.query("UPDATE application_instances SET worker_node_id=NULL,state='stopped',updated_at=NOW() WHERE installation_id=$1 AND worker_node_id=$2 AND (NOT ($3::jsonb ? 'applicationInstanceId') OR id=($3::jsonb->>'applicationInstanceId')::uuid)", [job.installation_id, nodeId, job.payload]);
        } else { await client.query("UPDATE installations i SET state=CASE WHEN $3::BOOLEAN OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=i.id AND s.status IN ('active','trialing')) THEN 'failed' ELSE 'suspended' END,failure_reason=CASE WHEN $3::BOOLEAN OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=i.id AND s.status IN ('active','trialing')) THEN $1 ELSE i.failure_reason END,updated_at=NOW() WHERE i.id=$2", [(report.error ?? "Worker job failed").slice(0, 1000), job.installation_id, config.HOSTING_ENTITLEMENT_MODE === "unrestricted"]); }
      }
      for (const item of report.backups ?? []) await client.query("INSERT INTO backups(id,installation_id,application_instance_id,object_name,size_bytes,status) VALUES($1,$2,$3,$4,$5,'ready') ON CONFLICT(object_name) DO NOTHING", [randomUUID(), job.installation_id, item.applicationInstanceId, item.objectName, item.sizeBytes]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async listGatewayRoutes() {
    const result = await this.pool.query(`
      SELECT a.id application_instance_id,a.app_id,a.hostname upstream_host,w.id worker_node_id,
             hostnames.hostname,hostnames.claim_id,hostnames.challenge_token,host(w.private_address) private_address
      FROM application_instances a
      JOIN installations i ON i.id=a.installation_id
      JOIN worker_nodes w ON w.id=a.worker_node_id
      CROSS JOIN LATERAL (
        SELECT a.hostname hostname,NULL::uuid claim_id,NULL::text challenge_token
        UNION ALL
        SELECT d.domain,c.id,c.challenge_token
        FROM custom_domains d
        JOIN global_hostname_claims c ON c.id=d.hostname_claim_id AND c.hostname=d.domain AND c.surface='application' AND c.resource_id=a.id
        WHERE d.application_instance_id=a.id AND d.verification_status IN ('verified','active') AND c.status IN ('verified','active')
      ) hostnames
      WHERE a.state='live' AND i.state='live'
        AND ($1::BOOLEAN OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=i.id AND s.status IN ('active','trialing')))
        AND w.status IN ('ready','draining') AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes'
      ORDER BY hostnames.hostname
    `, [config.HOSTING_ENTITLEMENT_MODE === "unrestricted"]);
    return result.rows.map((row) => ({
      hostname: String(row.hostname),
      upstreamHost: String(row.upstream_host),
      ...(row.claim_id && row.challenge_token ? { ownership: hostnameOwnershipInstructions({ id: String(row.claim_id), hostname: String(row.hostname), challengeToken: String(row.challenge_token) }, config.PUBLIC_HOST_TARGET) } : {}),
      workerPrivateAddress: String(row.private_address),
      workerNodeId: String(row.worker_node_id),
      applicationInstanceId: String(row.application_instance_id),
      appId: String(row.app_id),
    })) as GatewayRoute[];
  }
  async createManagedOAuthFlow(input: ManagedOAuthFlow) {
    await this.pool.query("DELETE FROM managed_oauth_flows WHERE expires_at<NOW()-INTERVAL '1 day'");
    await this.pool.query("INSERT INTO managed_oauth_flows(id,state_token_hash,application_instance_id,origin,upstream_state,code_verifier,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [input.id, input.stateTokenHash, input.applicationInstanceId, input.origin, input.upstreamState, input.codeVerifier, input.expiresAt, input.createdAt]);
  }
  async consumeManagedOAuthFlow(stateTokenHash: string) {
    const result = await this.pool.query("UPDATE managed_oauth_flows SET consumed_at=NOW() WHERE state_token_hash=$1 AND consumed_at IS NULL AND expires_at>NOW() RETURNING *", [stateTokenHash]);
    const row = result.rows[0];
    return row ? { id: String(row.id), stateTokenHash: String(row.state_token_hash), applicationInstanceId: String(row.application_instance_id), origin: String(row.origin), upstreamState: String(row.upstream_state), codeVerifier: String(row.code_verifier), expiresAt: databaseTimestampIso(row.expires_at), createdAt: databaseTimestampIso(row.created_at), consumedAt: databaseTimestampIso(row.consumed_at) } : undefined;
  }
  async listWorkerNodeRoutes(nodeId: string) { const result = await this.pool.query("SELECT a.id application_instance_id,a.hostname,a.container_project,a.app_id FROM application_instances a JOIN installations i ON i.id=a.installation_id WHERE a.worker_node_id=$1 AND a.state='live' AND i.state='live' AND ($2::BOOLEAN OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.installation_id=i.id AND s.status IN ('active','trialing'))) ORDER BY a.hostname", [nodeId, config.HOSTING_ENTITLEMENT_MODE === "unrestricted"]); return result.rows.map((row) => ({ applicationInstanceId: String(row.application_instance_id), hostname: String(row.hostname), containerProject: String(row.container_project), appId: String(row.app_id) })); }
}

export function createRepository(): Repository {
  return config.DATABASE_URL ? new PostgresRepository(config.DATABASE_URL) : new MemoryRepository();
}
