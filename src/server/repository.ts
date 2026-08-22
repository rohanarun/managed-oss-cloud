import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AccountUser, AgentJob, ApplicationInstance, BackupRecord, CustomDomain, GatewayRoute, Installation, ProvisioningJob, WorkerNode } from "../shared/types.js";
import { config } from "./config.js";

interface StoredUser extends AccountUser { passwordHash: string }
export interface WorkerRegistration { id: string; name: string; privateAddress: string; machineType: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number; systemReserveMemoryMb: number }
export interface WorkerJobReport { status: "succeeded" | "failed"; error?: string; applications?: Array<{ id: string; state: ApplicationInstance["state"]; healthy?: boolean }>; backups?: Array<{ applicationInstanceId: string; objectName: string; sizeBytes: number }> }
const agentTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newAgentToken = () => randomBytes(32).toString("base64url");

export interface Repository {
  readonly persistence: "postgres" | "preview-memory";
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
  addDomain(userId: string, id: string, domain: string): Promise<Installation | undefined>;
  upgrade(userId: string, id: string, plan: string): Promise<Installation | undefined>;
  appendApplicationId(installationId: string, appId: string): Promise<void>;
  canReserveOnInstallationWorker(installationId: string, reservation: { memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }): Promise<boolean>;
  createApplicationInstances(installationId: string, apps: Array<{ appId: string; memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }>, hostnameBase: string): Promise<ApplicationInstance[]>;
  getApplicationInstance(userId: string, id: string): Promise<ApplicationInstance | undefined>;
  updateInstallationState(id: string, state: Installation["state"], failureReason?: string): Promise<void>;
  updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string): Promise<void>;
  enqueueJob(installationId: string, action: ProvisioningJob["action"], payload?: Record<string, unknown>): Promise<ProvisioningJob>;
  setDomainStatus(domain: string, status: CustomDomain["verificationStatus"]): Promise<void>;
  getOrCreateStripeCustomer(userId: string, create: () => Promise<string>): Promise<string>;
  recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }): Promise<void>;
  getActiveSubscription(userId: string, installationId: string): Promise<{ providerSubscriptionId: string } | undefined>;
  hasProcessedStripeEvent(eventId: string): Promise<boolean>;
  markStripeEventProcessed(eventId: string, eventType: string): Promise<void>;
  processPaidCheckout(input: { eventId: string; eventType: string; userId: string; installationId: string; providerSubscriptionId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }): Promise<boolean>;
  listBackups(userId: string, installationId: string): Promise<BackupRecord[]>;
  registerWorkerNode(input: WorkerRegistration): Promise<{ node: WorkerNode; agentToken: string }>;
  findWorkerNodeByAgentToken(token: string): Promise<WorkerNode | undefined>;
  heartbeatWorkerNode(nodeId: string, input: { privateAddress: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number }): Promise<WorkerNode | undefined>;
  claimWorkerJob(nodeId: string): Promise<AgentJob | undefined>;
  reportWorkerJob(nodeId: string, jobId: string, report: WorkerJobReport): Promise<boolean>;
  listGatewayRoutes(): Promise<GatewayRoute[]>;
  listWorkerNodeRoutes(nodeId: string): Promise<Array<{ hostname: string; containerProject: string; appId: string }>>;
}

export class MemoryRepository implements Repository {
  readonly persistence = "preview-memory" as const;
  private users = new Map<string, StoredUser>();
  private sessions = new Map<string, { userId: string; expiresAt: string }>();
  private installations = new Map<string, Installation>();
  private applications = new Map<string, ApplicationInstance>();
  private jobs = new Map<string, ProvisioningJob>();
  private stripeCustomers = new Map<string, string>();
  private subscriptions = new Map<string, { userId: string; installationId: string; providerSubscriptionId: string; status: string }>();
  private stripeEvents = new Set<string>();
  private backups: BackupRecord[] = [];
  private workers = new Map<string, WorkerNode & { agentTokenHash: string }>();

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
    const item = await this.getInstallation(userId, id);
    if (!item) return undefined;
    if (!item.customDomains.includes(domain)) item.customDomains.push(domain);
    const application = [...this.applications.values()].find((candidate) => candidate.installationId === id);
    if (application && !application.customDomains.some((candidate) => candidate.domain === domain)) application.customDomains.push({ id: randomUUID(), applicationInstanceId: application.id, domain, verificationStatus: "awaiting-dns" });
    item.updatedAt = new Date().toISOString();
    return item;
  }
  async upgrade(userId: string, id: string, plan: string) {
    const item = this.installations.get(id);
    if (!item || item.userId !== userId) return undefined;
    item.plan = plan;
    item.updatedAt = new Date().toISOString();
    return this.getInstallation(userId, id);
  }
  async appendApplicationId(installationId: string, appId: string) { const item = this.installations.get(installationId); if (item) { item.appIds.push(appId); item.updatedAt = new Date().toISOString(); } }
  async canReserveOnInstallationWorker(installationId: string, reservation: { memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }) {
    const workerId = this.installations.get(installationId)?.workerNodeId;
    if (!workerId) return true;
    const worker = this.workers.get(workerId);
    return Boolean(worker && worker.reservedMemoryMb + worker.systemReserveMemoryMb + reservation.memoryReservationMb <= worker.capacityMemoryMb && worker.reservedCpuMillis + reservation.cpuReservationMillis <= worker.capacityCpuMillis && worker.reservedStorageGb + reservation.storageReservationGb <= worker.capacityStorageGb);
  }
  async createApplicationInstances(installationId: string, apps: Array<{ appId: string; memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }>, hostnameBase: string) {
    const now = new Date().toISOString();
    const created = apps.map(({ appId, memoryReservationMb, cpuReservationMillis, storageReservationGb }) => {
      const id = randomUUID();
      const instance: ApplicationInstance = { id, installationId, appId, state: "queued", hostname: `${appId}-${id.slice(0, 8)}.${hostnameBase}`, containerProject: `mos-${id.replaceAll("-", "").slice(0, 12)}`, customDomains: [], memoryReservationMb, cpuReservationMillis, storageReservationGb, createdAt: now, updatedAt: now };
      this.applications.set(id, instance);
      return instance;
    });
    return created;
  }
  async getApplicationInstance(userId: string, id: string) {
    const instance = this.applications.get(id);
    return instance && this.installations.get(instance.installationId)?.userId === userId ? instance : undefined;
  }
  async updateInstallationState(id: string, state: Installation["state"], failureReason?: string) { const item = this.installations.get(id); if (item) { item.state = state; item.failureReason = failureReason; item.updatedAt = new Date().toISOString(); } }
  async updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string) { const item = this.applications.get(id); if (item) { item.state = state; item.lastHealthAt = healthAt; item.updatedAt = new Date().toISOString(); } }
  async enqueueJob(installationId: string, action: ProvisioningJob["action"], payload: Record<string, unknown> = {}) { const target = typeof payload.applicationInstanceId === "string" ? this.applications.get(payload.applicationInstanceId) : undefined; const job: ProvisioningJob = { id: randomUUID(), installationId, action, status: "queued", attempts: 0, payload, workerNodeId: target?.workerNodeId ?? this.installations.get(installationId)?.workerNodeId, createdAt: new Date().toISOString() }; this.jobs.set(job.id, job); return job; }
  async setDomainStatus(domain: string, status: CustomDomain["verificationStatus"]) { for (const app of this.applications.values()) { const item = app.customDomains.find((candidate) => candidate.domain === domain); if (item) { item.verificationStatus = status; item.lastCheckedAt = new Date().toISOString(); } } }
  async getOrCreateStripeCustomer(userId: string, create: () => Promise<string>) { const existing = this.stripeCustomers.get(userId); if (existing) return existing; const id = await create(); this.stripeCustomers.set(userId, id); return id; }
  async recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) { this.subscriptions.set(input.providerSubscriptionId, { userId: input.userId, installationId: input.installationId, providerSubscriptionId: input.providerSubscriptionId, status: input.status }); }
  async getActiveSubscription(userId: string, installationId: string) { const item = [...this.subscriptions.values()].find((candidate) => candidate.userId === userId && candidate.installationId === installationId && candidate.status === "active"); return item ? { providerSubscriptionId: item.providerSubscriptionId } : undefined; }
  async hasProcessedStripeEvent(eventId: string) { return this.stripeEvents.has(eventId); }
  async markStripeEventProcessed(eventId: string) { this.stripeEvents.add(eventId); }
  async processPaidCheckout(input: { eventId: string; eventType: string; userId: string; installationId: string; providerSubscriptionId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) { if (this.stripeEvents.has(input.eventId)) return false; this.stripeEvents.add(input.eventId); await this.recordSubscription({ ...input, status: "active" }); await this.updateInstallationState(input.installationId, "provisioning"); for (const app of this.applications.values()) if (app.installationId === input.installationId) await this.enqueueJob(input.installationId, "install", { stripeEventId: input.eventId, applicationInstanceId: app.id }); return true; }
  async listBackups(userId: string, installationId: string) { return this.installations.get(installationId)?.userId === userId ? this.backups.filter((item) => item.installationId === installationId) : []; }
  private publicWorker(worker: WorkerNode & { agentTokenHash: string }): WorkerNode { const { agentTokenHash: _hidden, ...item } = worker; return item; }
  async registerWorkerNode(input: WorkerRegistration) {
    const now = new Date().toISOString();
    const token = newAgentToken();
    const previous = this.workers.get(input.id);
    const worker: WorkerNode & { agentTokenHash: string } = { ...input, status: "ready", reservedMemoryMb: previous?.reservedMemoryMb ?? 0, reservedCpuMillis: previous?.reservedCpuMillis ?? 0, reservedStorageGb: previous?.reservedStorageGb ?? 0, agentTokenHash: agentTokenHash(token), lastHeartbeatAt: now, createdAt: previous?.createdAt ?? now, updatedAt: now };
    this.workers.set(worker.id, worker);
    return { node: this.publicWorker(worker), agentToken: token };
  }
  async findWorkerNodeByAgentToken(token: string) { const worker = [...this.workers.values()].find((item) => item.agentTokenHash === agentTokenHash(token)); return worker ? this.publicWorker(worker) : undefined; }
  async heartbeatWorkerNode(nodeId: string, input: { privateAddress: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number }) { const worker = this.workers.get(nodeId); if (!worker) return undefined; Object.assign(worker, input, { status: "ready", lastHeartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); for (const job of this.jobs.values()) if (job.workerNodeId === nodeId && job.status === "running") job.leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString(); return this.publicWorker(worker); }
  async claimWorkerJob(nodeId: string) {
    const worker = this.workers.get(nodeId);
    if (!worker || worker.status !== "ready") return undefined;
    const running = [...this.jobs.values()].find((job) => job.workerNodeId === nodeId && job.status === "running");
    if (running) {
      const targetId = typeof running.payload.applicationInstanceId === "string" ? running.payload.applicationInstanceId : undefined;
      const applications = [...this.applications.values()].filter((app) => app.installationId === running.installationId && (!targetId || app.id === targetId));
      running.leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      return { ...running, applications };
    }
    const jobs = [...this.jobs.values()].filter((item) => item.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let job = jobs.find((item) => item.workerNodeId === nodeId);
    if (!job) job = jobs.find((item) => {
      if (item.action !== "install" || item.workerNodeId) return false;
      const installation = this.installations.get(item.installationId);
      if (!installation) return false;
      const targetId = typeof item.payload.applicationInstanceId === "string" ? item.payload.applicationInstanceId : undefined;
      const apps = [...this.applications.values()].filter((app) => app.installationId === installation.id && !app.workerNodeId && (!targetId || app.id === targetId));
      if (!apps.length) return false;
      return apps.reduce((sum, app) => sum + app.memoryReservationMb, 0) + worker.reservedMemoryMb + worker.systemReserveMemoryMb <= worker.capacityMemoryMb && apps.reduce((sum, app) => sum + app.cpuReservationMillis, 0) + worker.reservedCpuMillis <= worker.capacityCpuMillis && apps.reduce((sum, app) => sum + app.storageReservationGb, 0) + worker.reservedStorageGb <= worker.capacityStorageGb;
    });
    if (!job) return undefined;
    const installation = this.installations.get(job.installationId)!;
    const targetId = typeof job.payload.applicationInstanceId === "string" ? job.payload.applicationInstanceId : undefined;
    const applications = [...this.applications.values()].filter((app) => app.installationId === job!.installationId && (!targetId || app.id === targetId));
    if (!job.workerNodeId) {
      for (const app of applications) app.workerNodeId = nodeId;
      worker.reservedMemoryMb += applications.reduce((sum, app) => sum + app.memoryReservationMb, 0);
      worker.reservedCpuMillis += applications.reduce((sum, app) => sum + app.cpuReservationMillis, 0);
      worker.reservedStorageGb += applications.reduce((sum, app) => sum + app.storageReservationGb, 0);
    }
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
      const nextState = installationApplications.some((app) => app.state === "failed") ? "failed" : installationApplications.every((app) => app.state === "live") ? "live" : "provisioning";
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
    } else await this.updateInstallationState(job.installationId, "failed", report.error);
    for (const item of report.backups ?? []) this.backups.push({ id: randomUUID(), installationId: job.installationId, applicationInstanceId: item.applicationInstanceId, objectName: item.objectName, sizeBytes: item.sizeBytes, status: "ready", createdAt: new Date().toISOString() });
    return true;
  }
  async listGatewayRoutes() { const routes: GatewayRoute[] = []; for (const app of this.applications.values()) { if (app.state !== "live" || !app.workerNodeId) continue; const worker = this.workers.get(app.workerNodeId); if (!worker || worker.status !== "ready") continue; for (const hostname of [app.hostname, ...app.customDomains.filter((item) => ["verified", "active"].includes(item.verificationStatus)).map((item) => item.domain)]) routes.push({ hostname, upstreamHost: app.hostname, workerPrivateAddress: worker.privateAddress, workerNodeId: worker.id }); } return routes; }
  async listWorkerNodeRoutes(nodeId: string) { return [...this.applications.values()].filter((app) => app.workerNodeId === nodeId && app.state === "live").map((app) => ({ hostname: app.hostname, containerProject: app.containerProject, appId: app.appId })); }
}

export class PostgresRepository implements Repository {
  readonly persistence = "postgres" as const;
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, ssl: config.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false });
  }
  async initialize() {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const schema = await readFile(path.resolve(moduleDirectory, "../../db/schema.sql"), "utf8");
    await this.pool.query(schema);
  }
  private user(row: Record<string, unknown>): StoredUser {
    return { id: String(row.id), email: String(row.email), displayName: String(row.display_name), passwordHash: String(row.password_hash), createdAt: new Date(String(row.created_at)).toISOString() };
  }
  private installation(row: Record<string, unknown>): Installation {
    return { id: String(row.id), userId: String(row.user_id), appIds: row.app_ids as string[], name: String(row.name), plan: String(row.plan), state: row.state as Installation["state"], hostname: String(row.hostname), customDomains: (row.custom_domains as string[]) ?? [], failureReason: row.failure_reason ? String(row.failure_reason) : undefined, workerNodeId: row.worker_node_id ? String(row.worker_node_id) : undefined, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
  }
  private application(row: Record<string, unknown>, domains: CustomDomain[] = []): ApplicationInstance { return { id: String(row.id), installationId: String(row.installation_id), appId: String(row.app_id), state: row.state as ApplicationInstance["state"], hostname: String(row.hostname), containerProject: String(row.container_project), customDomains: domains, lastHealthAt: row.last_health_at ? new Date(String(row.last_health_at)).toISOString() : undefined, workerNodeId: row.worker_node_id ? String(row.worker_node_id) : undefined, memoryReservationMb: Number(row.memory_reservation_mb ?? 0), cpuReservationMillis: Number(row.cpu_reservation_millis ?? 0), storageReservationGb: Number(row.storage_reservation_gb ?? 0), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
  private worker(row: Record<string, unknown>): WorkerNode { return { id: String(row.id), name: String(row.name), status: row.status as WorkerNode["status"], privateAddress: String(row.private_address), machineType: String(row.machine_type), capacityMemoryMb: Number(row.capacity_memory_mb), capacityCpuMillis: Number(row.capacity_cpu_millis), capacityStorageGb: Number(row.capacity_storage_gb), systemReserveMemoryMb: Number(row.system_reserve_memory_mb), reservedMemoryMb: Number(row.reserved_memory_mb ?? 0), reservedCpuMillis: Number(row.reserved_cpu_millis ?? 0), reservedStorageGb: Number(row.reserved_storage_gb ?? 0), lastHeartbeatAt: new Date(String(row.last_heartbeat_at)).toISOString(), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
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
    const domains = await this.pool.query("SELECT d.* FROM custom_domains d JOIN application_instances a ON a.id=d.application_instance_id JOIN installations i ON i.id=a.installation_id WHERE i.user_id=$1", [userId]);
    for (const installation of installations) {
      installation.applications = applications.rows.filter((row) => String(row.installation_id) === installation.id).map((row) => this.application(row, domains.rows.filter((domain) => String(domain.application_instance_id) === String(row.id)).map((domain) => ({ id: String(domain.id), applicationInstanceId: String(domain.application_instance_id), domain: String(domain.domain), verificationStatus: String(domain.verification_status) as CustomDomain["verificationStatus"], lastCheckedAt: domain.last_checked_at ? new Date(String(domain.last_checked_at)).toISOString() : undefined }))));
    }
    return installations;
  }
  async createInstallation(input: Omit<Installation, "id" | "createdAt" | "updatedAt">) {
    const result = await this.pool.query("INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *, '{}'::text[] custom_domains", [randomUUID(), input.userId, input.name, input.plan, input.state, input.hostname, JSON.stringify(input.appIds)]);
    return this.installation(result.rows[0]);
  }
  async getInstallation(userId: string, id: string) { const rows = await this.listInstallations(userId); return rows.find((item) => item.id === id); }
  async addDomain(userId: string, id: string, domain: string) {
    const item = await this.getInstallation(userId, id);
    if (!item) return undefined;
    const application = item.applications?.[0];
    if (!application) return undefined;
    await this.pool.query("INSERT INTO custom_domains(id,installation_id,application_instance_id,domain,verification_status) VALUES($1,$2,$3,$4,'awaiting-dns') ON CONFLICT(domain) DO NOTHING", [randomUUID(), id, application.id, domain]);
    return this.getInstallation(userId, id);
  }
  async upgrade(userId: string, id: string, plan: string) { await this.pool.query("UPDATE installations SET plan=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3", [plan, id, userId]); return this.getInstallation(userId, id); }
  async appendApplicationId(installationId: string, appId: string) { await this.pool.query("UPDATE installations SET app_ids=app_ids || to_jsonb($2::text),updated_at=NOW() WHERE id=$1", [installationId, appId]); }
  async canReserveOnInstallationWorker(installationId: string, reservation: { memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }) {
    const result = await this.pool.query("SELECT i.worker_node_id,w.capacity_memory_mb,w.capacity_cpu_millis,w.capacity_storage_gb,w.system_reserve_memory_mb,COALESCE(SUM(a.memory_reservation_mb),0) reserved_memory_mb,COALESCE(SUM(a.cpu_reservation_millis),0) reserved_cpu_millis,COALESCE(SUM(a.storage_reservation_gb),0) reserved_storage_gb FROM installations i LEFT JOIN worker_nodes w ON w.id=i.worker_node_id LEFT JOIN application_instances a ON a.worker_node_id=w.id WHERE i.id=$1 GROUP BY i.worker_node_id,w.capacity_memory_mb,w.capacity_cpu_millis,w.capacity_storage_gb,w.system_reserve_memory_mb", [installationId]);
    const row = result.rows[0];
    if (!row || !row.worker_node_id) return true;
    return Number(row.reserved_memory_mb) + Number(row.system_reserve_memory_mb) + reservation.memoryReservationMb <= Number(row.capacity_memory_mb) && Number(row.reserved_cpu_millis) + reservation.cpuReservationMillis <= Number(row.capacity_cpu_millis) && Number(row.reserved_storage_gb) + reservation.storageReservationGb <= Number(row.capacity_storage_gb);
  }
  async createApplicationInstances(installationId: string, apps: Array<{ appId: string; memoryReservationMb: number; cpuReservationMillis: number; storageReservationGb: number }>, hostnameBase: string) {
    const created: ApplicationInstance[] = [];
    for (const { appId, memoryReservationMb, cpuReservationMillis, storageReservationGb } of apps) {
      const id = randomUUID();
      const result = await this.pool.query("INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb) SELECT $1,$2,$3,'queued',$4,$5,$6,$7,$8 FROM installations WHERE id=$2 RETURNING *", [id, installationId, appId, `${appId}-${id.slice(0, 8)}.${hostnameBase}`, `mos-${id.replaceAll("-", "").slice(0, 12)}`, memoryReservationMb, cpuReservationMillis, storageReservationGb]);
      created.push(this.application(result.rows[0]));
    }
    return created;
  }
  async getApplicationInstance(userId: string, id: string) { const result = await this.pool.query("SELECT a.* FROM application_instances a JOIN installations i ON i.id=a.installation_id WHERE a.id=$1 AND i.user_id=$2", [id, userId]); return result.rows[0] ? this.application(result.rows[0]) : undefined; }
  async updateInstallationState(id: string, state: Installation["state"], failureReason?: string) { await this.pool.query("UPDATE installations SET state=$1,failure_reason=$2,updated_at=NOW() WHERE id=$3", [state, failureReason ?? null, id]); }
  async updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string) { await this.pool.query("UPDATE application_instances SET state=$1,last_health_at=COALESCE($2,last_health_at),updated_at=NOW() WHERE id=$3", [state, healthAt ?? null, id]); }
  async enqueueJob(installationId: string, action: ProvisioningJob["action"], payload: Record<string, unknown> = {}) { const id = randomUUID(); const targetId = typeof payload.applicationInstanceId === "string" ? payload.applicationInstanceId : null; const result = await this.pool.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload,worker_node_id) SELECT $1,$2,$3,$4,COALESCE((SELECT worker_node_id FROM application_instances WHERE id=$5::uuid),i.worker_node_id) FROM installations i WHERE i.id=$2 RETURNING *", [id, installationId, action, payload, targetId]); const row = result.rows[0]; return { id: String(row.id), installationId: String(row.installation_id), action: row.action, status: row.status, attempts: Number(row.attempts), payload: row.payload, workerNodeId: row.worker_node_id ? String(row.worker_node_id) : undefined, createdAt: new Date(String(row.created_at)).toISOString() } as ProvisioningJob; }
  async setDomainStatus(domain: string, status: CustomDomain["verificationStatus"]) { await this.pool.query("UPDATE custom_domains SET verification_status=$1,last_checked_at=NOW() WHERE domain=$2", [status, domain]); }
  async getOrCreateStripeCustomer(userId: string, create: () => Promise<string>) { const existing = await this.pool.query("SELECT stripe_customer_id FROM billing_accounts WHERE user_id=$1", [userId]); if (existing.rows[0]?.stripe_customer_id) return String(existing.rows[0].stripe_customer_id); const customerId = await create(); await this.pool.query("INSERT INTO billing_accounts(user_id,stripe_customer_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=EXCLUDED.stripe_customer_id", [userId, customerId]); return customerId; }
  async recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) { await this.pool.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider_subscription_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,status=EXCLUDED.status,infrastructure_monthly_cents=EXCLUDED.infrastructure_monthly_cents,platform_fee_monthly_cents=EXCLUDED.platform_fee_monthly_cents,updated_at=NOW()", [randomUUID(), input.userId, input.installationId, input.providerSubscriptionId, input.status, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents]); }
  async getActiveSubscription(userId: string, installationId: string) { const result = await this.pool.query("SELECT provider_subscription_id FROM subscriptions WHERE user_id=$1 AND installation_id=$2 AND status='active' ORDER BY created_at DESC LIMIT 1", [userId, installationId]); return result.rows[0]?.provider_subscription_id ? { providerSubscriptionId: String(result.rows[0].provider_subscription_id) } : undefined; }
  async hasProcessedStripeEvent(eventId: string) { return (await this.pool.query("SELECT 1 FROM stripe_events WHERE event_id=$1", [eventId])).rowCount === 1; }
  async markStripeEventProcessed(eventId: string, eventType: string) { await this.pool.query("INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING", [eventId, eventType]); }
  async processPaidCheckout(input: { eventId: string; eventType: string; userId: string; installationId: string; providerSubscriptionId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const event = await client.query("INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id", [input.eventId, input.eventType]);
      if (!event.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) VALUES($1,$2,$3,$4,'active',$5,$6) ON CONFLICT(provider_subscription_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,status='active',infrastructure_monthly_cents=EXCLUDED.infrastructure_monthly_cents,platform_fee_monthly_cents=EXCLUDED.platform_fee_monthly_cents,updated_at=NOW()", [randomUUID(), input.userId, input.installationId, input.providerSubscriptionId, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents]);
      await client.query("UPDATE installations SET state='provisioning',updated_at=NOW() WHERE id=$1 AND user_id=$2", [input.installationId, input.userId]);
      await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload) SELECT gen_random_uuid(),$1,'install',jsonb_build_object('stripeEventId',$2::text,'applicationInstanceId',a.id::text) FROM application_instances a WHERE a.installation_id=$1", [input.installationId, input.eventId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async listBackups(userId: string, installationId: string) { const result = await this.pool.query("SELECT b.* FROM backups b JOIN installations i ON i.id=b.installation_id WHERE b.installation_id=$1 AND i.user_id=$2 ORDER BY b.created_at DESC", [installationId, userId]); return result.rows.map((row) => ({ id: String(row.id), installationId: String(row.installation_id), applicationInstanceId: String(row.application_instance_id), objectName: String(row.object_name), sizeBytes: Number(row.size_bytes), status: row.status, createdAt: new Date(String(row.created_at)).toISOString() })) as BackupRecord[]; }
  async registerWorkerNode(input: WorkerRegistration) {
    const agentToken = newAgentToken();
    const result = await this.pool.query("INSERT INTO worker_nodes(id,name,status,private_address,machine_type,capacity_memory_mb,capacity_cpu_millis,capacity_storage_gb,system_reserve_memory_mb,agent_token_hash) VALUES($1,$2,'ready',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,status='ready',private_address=EXCLUDED.private_address,machine_type=EXCLUDED.machine_type,capacity_memory_mb=EXCLUDED.capacity_memory_mb,capacity_cpu_millis=EXCLUDED.capacity_cpu_millis,capacity_storage_gb=EXCLUDED.capacity_storage_gb,system_reserve_memory_mb=EXCLUDED.system_reserve_memory_mb,agent_token_hash=EXCLUDED.agent_token_hash,last_heartbeat_at=NOW(),updated_at=NOW() RETURNING *,0 reserved_memory_mb,0 reserved_cpu_millis,0 reserved_storage_gb", [input.id, input.name, input.privateAddress, input.machineType, input.capacityMemoryMb, input.capacityCpuMillis, input.capacityStorageGb, input.systemReserveMemoryMb, agentTokenHash(agentToken)]);
    return { node: this.worker(result.rows[0]), agentToken };
  }
  async findWorkerNodeByAgentToken(token: string) {
    const result = await this.pool.query("SELECT w.*,COALESCE(SUM(a.memory_reservation_mb),0) reserved_memory_mb,COALESCE(SUM(a.cpu_reservation_millis),0) reserved_cpu_millis,COALESCE(SUM(a.storage_reservation_gb),0) reserved_storage_gb FROM worker_nodes w LEFT JOIN application_instances a ON a.worker_node_id=w.id WHERE w.agent_token_hash=$1 GROUP BY w.id", [agentTokenHash(token)]);
    return result.rows[0] ? this.worker(result.rows[0]) : undefined;
  }
  async heartbeatWorkerNode(nodeId: string, input: { privateAddress: string; capacityMemoryMb: number; capacityCpuMillis: number; capacityStorageGb: number }) {
    const result = await this.pool.query("WITH extended AS (UPDATE provisioning_jobs SET lease_expires_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE worker_node_id=$1 AND status='running'), updated AS (UPDATE worker_nodes SET status='ready',private_address=$2,capacity_memory_mb=$3,capacity_cpu_millis=$4,capacity_storage_gb=$5,last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *) SELECT updated.*,COALESCE(SUM(a.memory_reservation_mb),0) reserved_memory_mb,COALESCE(SUM(a.cpu_reservation_millis),0) reserved_cpu_millis,COALESCE(SUM(a.storage_reservation_gb),0) reserved_storage_gb FROM updated LEFT JOIN application_instances a ON a.worker_node_id=updated.id GROUP BY updated.id,updated.name,updated.status,updated.private_address,updated.machine_type,updated.capacity_memory_mb,updated.capacity_cpu_millis,updated.capacity_storage_gb,updated.system_reserve_memory_mb,updated.agent_token_hash,updated.last_heartbeat_at,updated.created_at,updated.updated_at", [nodeId, input.privateAddress, input.capacityMemoryMb, input.capacityCpuMillis, input.capacityStorageGb]);
    return result.rows[0] ? this.worker(result.rows[0]) : undefined;
  }
  async claimWorkerJob(nodeId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE provisioning_jobs SET status='queued',locked_at=NULL,locked_by=NULL,lease_expires_at=NULL,available_at=NOW(),updated_at=NOW() WHERE status='running' AND lease_expires_at<NOW() AND attempts<3");
      const nodeResult = await client.query("SELECT * FROM worker_nodes WHERE id=$1 AND status='ready' AND last_heartbeat_at>NOW()-INTERVAL '2 minutes' FOR UPDATE", [nodeId]);
      if (!nodeResult.rows[0]) { await client.query("ROLLBACK"); return undefined; }
      const active = await client.query("UPDATE provisioning_jobs SET lease_expires_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE id=(SELECT id FROM provisioning_jobs WHERE worker_node_id=$1 AND status='running' ORDER BY locked_at LIMIT 1 FOR UPDATE) RETURNING *", [nodeId]);
      if (active.rows[0]) {
        const job = active.rows[0];
        const apps = await client.query("SELECT * FROM application_instances WHERE installation_id=$1 AND (NOT ($2::jsonb ? 'applicationInstanceId') OR id=($2::jsonb->>'applicationInstanceId')::uuid) ORDER BY created_at", [job.installation_id, job.payload ?? {}]);
        await client.query("COMMIT");
        return { id: String(job.id), installationId: String(job.installation_id), action: job.action, status: job.status, attempts: Number(job.attempts), payload: job.payload ?? {}, workerNodeId: nodeId, leaseExpiresAt: new Date(String(job.lease_expires_at)).toISOString(), createdAt: new Date(String(job.created_at)).toISOString(), applications: apps.rows.map((app) => this.application(app)) } as AgentJob;
      }
      const node = nodeResult.rows[0];
      const reservation = await client.query("SELECT COALESCE(SUM(memory_reservation_mb),0) memory,COALESCE(SUM(cpu_reservation_millis),0) cpu,COALESCE(SUM(storage_reservation_gb),0) storage FROM application_instances WHERE worker_node_id=$1", [nodeId]);
      const assigned = await client.query("SELECT j.* FROM provisioning_jobs j WHERE j.status='queued' AND j.available_at<=NOW() AND j.worker_node_id=$1 ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1", [nodeId]);
      let row = assigned.rows[0];
      if (!row) {
        const candidates = await client.query("SELECT j.*,(SELECT COALESCE(SUM(a.memory_reservation_mb),0)::int FROM application_instances a WHERE a.installation_id=j.installation_id AND a.worker_node_id IS NULL AND (NOT (j.payload ? 'applicationInstanceId') OR a.id=(j.payload->>'applicationInstanceId')::uuid)) required_memory_mb,(SELECT COALESCE(SUM(a.cpu_reservation_millis),0)::int FROM application_instances a WHERE a.installation_id=j.installation_id AND a.worker_node_id IS NULL AND (NOT (j.payload ? 'applicationInstanceId') OR a.id=(j.payload->>'applicationInstanceId')::uuid)) required_cpu_millis,(SELECT COALESCE(SUM(a.storage_reservation_gb),0)::int FROM application_instances a WHERE a.installation_id=j.installation_id AND a.worker_node_id IS NULL AND (NOT (j.payload ? 'applicationInstanceId') OR a.id=(j.payload->>'applicationInstanceId')::uuid)) required_storage_gb FROM provisioning_jobs j JOIN installations i ON i.id=j.installation_id WHERE j.status='queued' AND j.available_at<=NOW() AND j.worker_node_id IS NULL AND j.action='install' ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 20");
        const availableMemory = Number(node.capacity_memory_mb) - Number(node.system_reserve_memory_mb) - Number(reservation.rows[0].memory);
        const availableCpu = Number(node.capacity_cpu_millis) - Number(reservation.rows[0].cpu);
        const availableStorage = Number(node.capacity_storage_gb) - Number(reservation.rows[0].storage);
        row = candidates.rows.find((candidate) => Number(candidate.required_memory_mb) <= availableMemory && Number(candidate.required_cpu_millis) <= availableCpu && Number(candidate.required_storage_gb) <= availableStorage);
      }
      if (!row) { await client.query("COMMIT"); return undefined; }
      await client.query("UPDATE application_instances SET worker_node_id=$1,updated_at=NOW() WHERE installation_id=$2 AND worker_node_id IS NULL AND (NOT ($3::jsonb ? 'applicationInstanceId') OR id=($3::jsonb->>'applicationInstanceId')::uuid)", [nodeId, row.installation_id, row.payload]);
      const claimed = await client.query("UPDATE provisioning_jobs SET worker_node_id=$1,status='running',attempts=attempts+1,locked_at=NOW(),locked_by=$1,lease_expires_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE id=$2 RETURNING *", [nodeId, row.id]);
      const apps = await client.query("SELECT * FROM application_instances WHERE installation_id=$1 AND (NOT ($2::jsonb ? 'applicationInstanceId') OR id=($2::jsonb->>'applicationInstanceId')::uuid) ORDER BY created_at", [row.installation_id, row.payload]);
      await client.query("COMMIT");
      const job = claimed.rows[0];
      return { id: String(job.id), installationId: String(job.installation_id), action: job.action, status: job.status, attempts: Number(job.attempts), payload: job.payload ?? {}, workerNodeId: nodeId, leaseExpiresAt: new Date(String(job.lease_expires_at)).toISOString(), createdAt: new Date(String(job.created_at)).toISOString(), applications: apps.rows.map((app) => this.application(app)) } as AgentJob;
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
          const state = Number(counts.failed) > 0 ? "failed" : Number(counts.live) === Number(counts.total) ? "live" : "provisioning";
          await client.query("UPDATE installations SET state=$1,failure_reason=NULL,updated_at=NOW() WHERE id=$2", [state, job.installation_id]);
          if (job.action === "uninstall") await client.query("UPDATE application_instances SET worker_node_id=NULL,state='stopped',updated_at=NOW() WHERE installation_id=$1 AND worker_node_id=$2 AND (NOT ($3::jsonb ? 'applicationInstanceId') OR id=($3::jsonb->>'applicationInstanceId')::uuid)", [job.installation_id, nodeId, job.payload]);
        } else { await client.query("UPDATE installations SET state='failed',failure_reason=$1,updated_at=NOW() WHERE id=$2", [(report.error ?? "Worker job failed").slice(0, 1000), job.installation_id]); }
      }
      for (const item of report.backups ?? []) await client.query("INSERT INTO backups(id,installation_id,application_instance_id,object_name,size_bytes,status) VALUES($1,$2,$3,$4,$5,'ready') ON CONFLICT(object_name) DO NOTHING", [randomUUID(), job.installation_id, item.applicationInstanceId, item.objectName, item.sizeBytes]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async listGatewayRoutes() {
    const result = await this.pool.query("SELECT a.hostname upstream_host,w.id worker_node_id,hostnames.hostname,w.private_address::text FROM application_instances a JOIN worker_nodes w ON w.id=a.worker_node_id CROSS JOIN LATERAL (SELECT a.hostname UNION ALL SELECT d.domain FROM custom_domains d WHERE d.application_instance_id=a.id AND d.verification_status IN ('verified','active')) hostnames(hostname) WHERE a.state='live' AND w.status='ready' AND w.last_heartbeat_at>NOW()-INTERVAL '2 minutes' ORDER BY hostnames.hostname");
    return result.rows.map((row) => ({ hostname: String(row.hostname), upstreamHost: String(row.upstream_host), workerPrivateAddress: String(row.private_address), workerNodeId: String(row.worker_node_id) })) as GatewayRoute[];
  }
  async listWorkerNodeRoutes(nodeId: string) { const result = await this.pool.query("SELECT hostname,container_project,app_id FROM application_instances WHERE worker_node_id=$1 AND state='live' ORDER BY hostname", [nodeId]); return result.rows.map((row) => ({ hostname: String(row.hostname), containerProject: String(row.container_project), appId: String(row.app_id) })); }
}

export function createRepository(): Repository {
  return config.DATABASE_URL ? new PostgresRepository(config.DATABASE_URL) : new MemoryRepository();
}
