import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AccountUser, ApplicationInstance, BackupRecord, CustomDomain, Installation, ProvisioningJob } from "../shared/types.js";
import { config } from "./config.js";

interface StoredUser extends AccountUser { passwordHash: string }

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
  createApplicationInstances(installationId: string, appIds: string[], hostnameBase: string): Promise<ApplicationInstance[]>;
  getApplicationInstance(userId: string, id: string): Promise<ApplicationInstance | undefined>;
  updateInstallationState(id: string, state: Installation["state"], failureReason?: string): Promise<void>;
  updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string): Promise<void>;
  enqueueJob(installationId: string, action: ProvisioningJob["action"], payload?: Record<string, unknown>): Promise<ProvisioningJob>;
  setDomainStatus(domain: string, status: CustomDomain["verificationStatus"]): Promise<void>;
  getOrCreateStripeCustomer(userId: string, create: () => Promise<string>): Promise<string>;
  recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }): Promise<void>;
  hasProcessedStripeEvent(eventId: string): Promise<boolean>;
  markStripeEventProcessed(eventId: string, eventType: string): Promise<void>;
  processPaidCheckout(input: { eventId: string; eventType: string; userId: string; installationId: string; providerSubscriptionId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }): Promise<boolean>;
  listBackups(userId: string, installationId: string): Promise<BackupRecord[]>;
}

export class MemoryRepository implements Repository {
  readonly persistence = "preview-memory" as const;
  private users = new Map<string, StoredUser>();
  private sessions = new Map<string, { userId: string; expiresAt: string }>();
  private installations = new Map<string, Installation>();
  private applications = new Map<string, ApplicationInstance>();
  private jobs = new Map<string, ProvisioningJob>();
  private stripeCustomers = new Map<string, string>();
  private stripeEvents = new Set<string>();
  private backups: BackupRecord[] = [];

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
  async getInstallation(userId: string, id: string) { const item = this.installations.get(id); return item?.userId === userId ? item : undefined; }
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
    const item = await this.getInstallation(userId, id);
    if (!item) return undefined;
    item.plan = plan;
    item.updatedAt = new Date().toISOString();
    return item;
  }
  async createApplicationInstances(installationId: string, appIds: string[], hostnameBase: string) {
    const now = new Date().toISOString();
    const created = appIds.map((appId) => {
      const id = randomUUID();
      const instance: ApplicationInstance = { id, installationId, appId, state: "queued", hostname: `${appId}-${installationId.slice(0, 8)}.${hostnameBase}`, containerProject: `mos-${id.replaceAll("-", "").slice(0, 12)}`, customDomains: [], createdAt: now, updatedAt: now };
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
  async enqueueJob(installationId: string, action: ProvisioningJob["action"], payload: Record<string, unknown> = {}) { const job: ProvisioningJob = { id: randomUUID(), installationId, action, status: "queued", attempts: 0, payload, createdAt: new Date().toISOString() }; this.jobs.set(job.id, job); return job; }
  async setDomainStatus(domain: string, status: CustomDomain["verificationStatus"]) { for (const app of this.applications.values()) { const item = app.customDomains.find((candidate) => candidate.domain === domain); if (item) { item.verificationStatus = status; item.lastCheckedAt = new Date().toISOString(); } } }
  async getOrCreateStripeCustomer(userId: string, create: () => Promise<string>) { const existing = this.stripeCustomers.get(userId); if (existing) return existing; const id = await create(); this.stripeCustomers.set(userId, id); return id; }
  async recordSubscription() {}
  async hasProcessedStripeEvent(eventId: string) { return this.stripeEvents.has(eventId); }
  async markStripeEventProcessed(eventId: string) { this.stripeEvents.add(eventId); }
  async processPaidCheckout(input: { eventId: string; eventType: string; userId: string; installationId: string; providerSubscriptionId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) { if (this.stripeEvents.has(input.eventId)) return false; this.stripeEvents.add(input.eventId); await this.recordSubscription(); await this.updateInstallationState(input.installationId, "provisioning"); await this.enqueueJob(input.installationId, "install", { stripeEventId: input.eventId }); return true; }
  async listBackups(userId: string, installationId: string) { return this.installations.get(installationId)?.userId === userId ? this.backups.filter((item) => item.installationId === installationId) : []; }
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
    return { id: String(row.id), userId: String(row.user_id), appIds: row.app_ids as string[], name: String(row.name), plan: String(row.plan), state: row.state as Installation["state"], hostname: String(row.hostname), customDomains: (row.custom_domains as string[]) ?? [], failureReason: row.failure_reason ? String(row.failure_reason) : undefined, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
  }
  private application(row: Record<string, unknown>, domains: CustomDomain[] = []): ApplicationInstance { return { id: String(row.id), installationId: String(row.installation_id), appId: String(row.app_id), state: row.state as ApplicationInstance["state"], hostname: String(row.hostname), containerProject: String(row.container_project), customDomains: domains, lastHealthAt: row.last_health_at ? new Date(String(row.last_health_at)).toISOString() : undefined, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
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
  async createApplicationInstances(installationId: string, appIds: string[], hostnameBase: string) {
    const created: ApplicationInstance[] = [];
    for (const appId of appIds) {
      const id = randomUUID();
      const result = await this.pool.query("INSERT INTO application_instances(id,installation_id,app_id,state,hostname,container_project) VALUES($1,$2,$3,'queued',$4,$5) RETURNING *", [id, installationId, appId, `${appId}-${installationId.slice(0, 8)}.${hostnameBase}`, `mos-${id.replaceAll("-", "").slice(0, 12)}`]);
      created.push(this.application(result.rows[0]));
    }
    return created;
  }
  async getApplicationInstance(userId: string, id: string) { const result = await this.pool.query("SELECT a.* FROM application_instances a JOIN installations i ON i.id=a.installation_id WHERE a.id=$1 AND i.user_id=$2", [id, userId]); return result.rows[0] ? this.application(result.rows[0]) : undefined; }
  async updateInstallationState(id: string, state: Installation["state"], failureReason?: string) { await this.pool.query("UPDATE installations SET state=$1,failure_reason=$2,updated_at=NOW() WHERE id=$3", [state, failureReason ?? null, id]); }
  async updateApplicationState(id: string, state: ApplicationInstance["state"], healthAt?: string) { await this.pool.query("UPDATE application_instances SET state=$1,last_health_at=COALESCE($2,last_health_at),updated_at=NOW() WHERE id=$3", [state, healthAt ?? null, id]); }
  async enqueueJob(installationId: string, action: ProvisioningJob["action"], payload: Record<string, unknown> = {}) { const id = randomUUID(); const result = await this.pool.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload) VALUES($1,$2,$3,$4) RETURNING *", [id, installationId, action, payload]); const row = result.rows[0]; return { id: String(row.id), installationId: String(row.installation_id), action: row.action, status: row.status, attempts: Number(row.attempts), payload: row.payload, createdAt: new Date(String(row.created_at)).toISOString() } as ProvisioningJob; }
  async setDomainStatus(domain: string, status: CustomDomain["verificationStatus"]) { await this.pool.query("UPDATE custom_domains SET verification_status=$1,last_checked_at=NOW() WHERE domain=$2", [status, domain]); }
  async getOrCreateStripeCustomer(userId: string, create: () => Promise<string>) { const existing = await this.pool.query("SELECT stripe_customer_id FROM billing_accounts WHERE user_id=$1", [userId]); if (existing.rows[0]?.stripe_customer_id) return String(existing.rows[0].stripe_customer_id); const customerId = await create(); await this.pool.query("INSERT INTO billing_accounts(user_id,stripe_customer_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=EXCLUDED.stripe_customer_id", [userId, customerId]); return customerId; }
  async recordSubscription(input: { userId: string; installationId: string; providerSubscriptionId: string; status: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) { await this.pool.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider_subscription_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()", [randomUUID(), input.userId, input.installationId, input.providerSubscriptionId, input.status, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents]); }
  async hasProcessedStripeEvent(eventId: string) { return (await this.pool.query("SELECT 1 FROM stripe_events WHERE event_id=$1", [eventId])).rowCount === 1; }
  async markStripeEventProcessed(eventId: string, eventType: string) { await this.pool.query("INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING", [eventId, eventType]); }
  async processPaidCheckout(input: { eventId: string; eventType: string; userId: string; installationId: string; providerSubscriptionId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const event = await client.query("INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id", [input.eventId, input.eventType]);
      if (!event.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query("INSERT INTO subscriptions(id,user_id,installation_id,provider_subscription_id,status,infrastructure_monthly_cents,platform_fee_monthly_cents) VALUES($1,$2,$3,$4,'active',$5,$6) ON CONFLICT(provider_subscription_id) DO UPDATE SET status='active',updated_at=NOW()", [randomUUID(), input.userId, input.installationId, input.providerSubscriptionId, input.infrastructureMonthlyCents, input.platformFeeMonthlyCents]);
      await client.query("UPDATE installations SET state='provisioning',updated_at=NOW() WHERE id=$1 AND user_id=$2", [input.installationId, input.userId]);
      await client.query("INSERT INTO provisioning_jobs(id,installation_id,action,payload) VALUES($1,$2,'install',$3)", [randomUUID(), input.installationId, { stripeEventId: input.eventId }]);
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
}

export function createRepository(): Repository {
  return config.DATABASE_URL ? new PostgresRepository(config.DATABASE_URL) : new MemoryRepository();
}
