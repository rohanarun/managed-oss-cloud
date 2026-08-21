import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AccountUser, Installation } from "../shared/types.js";
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
}

export class MemoryRepository implements Repository {
  readonly persistence = "preview-memory" as const;
  private users = new Map<string, StoredUser>();
  private sessions = new Map<string, { userId: string; expiresAt: string }>();
  private installations = new Map<string, Installation>();

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
  async listInstallations(userId: string) { return [...this.installations.values()].filter((item) => item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
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
    return { id: String(row.id), userId: String(row.user_id), appIds: row.app_ids as string[], name: String(row.name), plan: String(row.plan), state: row.state as Installation["state"], hostname: String(row.hostname), customDomains: (row.custom_domains as string[]) ?? [], createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
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
    return result.rows.map((row) => this.installation(row));
  }
  async createInstallation(input: Omit<Installation, "id" | "createdAt" | "updatedAt">) {
    const result = await this.pool.query("INSERT INTO installations(id,user_id,name,plan,state,hostname,app_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *, '{}'::text[] custom_domains", [randomUUID(), input.userId, input.name, input.plan, input.state, input.hostname, JSON.stringify(input.appIds)]);
    return this.installation(result.rows[0]);
  }
  async getInstallation(userId: string, id: string) { const rows = await this.listInstallations(userId); return rows.find((item) => item.id === id); }
  async addDomain(userId: string, id: string, domain: string) {
    const item = await this.getInstallation(userId, id);
    if (!item) return undefined;
    await this.pool.query("INSERT INTO custom_domains(id,installation_id,domain,verification_status) VALUES($1,$2,$3,'awaiting-dns') ON CONFLICT(domain) DO NOTHING", [randomUUID(), id, domain]);
    return this.getInstallation(userId, id);
  }
  async upgrade(userId: string, id: string, plan: string) { await this.pool.query("UPDATE installations SET plan=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3", [plan, id, userId]); return this.getInstallation(userId, id); }
}

export function createRepository(): Repository {
  return config.DATABASE_URL ? new PostgresRepository(config.DATABASE_URL) : new MemoryRepository();
}
