import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { config } from "./config.js";

export type DatabaseMigrationMode = "auto" | "manual";

export interface DatabaseMigration {
  version: string;
  name: string;
  sql: string;
}

export interface DatabaseMigrationReport {
  mode: DatabaseMigrationMode;
  applied: string[];
  alreadyApplied: string[];
}

interface AppliedMigrationRow {
  version: string;
  name: string;
  checksum_sha256: string;
}

const migrationLockNamespace = "managed-oss-cloud/database-migrations";
const defaultLockTimeoutMilliseconds = 5_000;
const defaultStatementTimeoutMilliseconds = 120_000;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "../..");

export function migrationChecksum(sql: string) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function loadDatabaseMigrations(rootDirectory = projectDirectory): Promise<DatabaseMigration[]> {
  return [
    { version: "001", name: "core-schema", sql: await readFile(path.join(rootDirectory, "db/schema.sql"), "utf8") },
    { version: "002", name: "suite-schema", sql: await readFile(path.join(rootDirectory, "db/suite-schema.sql"), "utf8") },
    { version: "003", name: "suite-rls-phase-a", sql: await readFile(path.join(rootDirectory, "db/migrations/003-suite-rls-phase-a.sql"), "utf8") },
    { version: "004", name: "global-hostname-claims", sql: await readFile(path.join(rootDirectory, "db/migrations/004-global-hostname-claims.sql"), "utf8") },
    { version: "005", name: "checkout-capacity-holds", sql: await readFile(path.join(rootDirectory, "db/migrations/005-checkout-capacity-holds.sql"), "utf8") },
    { version: "006", name: "database-role-and-rls-enforcement", sql: await readFile(path.join(rootDirectory, "db/migrations/006-database-role-and-rls-enforcement.sql"), "utf8") },
    { version: "007", name: "paid-plan-capacity-allocations", sql: await readFile(path.join(rootDirectory, "db/migrations/007-paid-plan-capacity-allocations.sql"), "utf8") },
    { version: "008", name: "suite-action-atomicity-and-ai-audit", sql: await readFile(path.join(rootDirectory, "db/migrations/008-suite-action-atomicity-and-ai-audit.sql"), "utf8") },
    { version: "009", name: "public-growth-surfaces", sql: await readFile(path.join(rootDirectory, "db/migrations/009-public-growth-surfaces.sql"), "utf8") },
    { version: "010", name: "esign-atomicity-and-invariants", sql: await readFile(path.join(rootDirectory, "db/migrations/010-esign-atomicity-and-invariants.sql"), "utf8") },
    { version: "011", name: "email-atomicity-and-invariants", sql: await readFile(path.join(rootDirectory, "db/migrations/011-email-atomicity-and-invariants.sql"), "utf8") },
    { version: "012", name: "managed-oauth-broker", sql: await readFile(path.join(rootDirectory, "db/migrations/012-managed-oauth-broker.sql"), "utf8") },
    { version: "013", name: "billing-capacity-atomicity", sql: await readFile(path.join(rootDirectory, "db/migrations/013-billing-capacity-atomicity.sql"), "utf8") },
    { version: "014", name: "suite-storage-accounting", sql: await readFile(path.join(rootDirectory, "db/migrations/014-suite-storage-accounting.sql"), "utf8") },
  ];
}

function validateMigrationSet(migrations: DatabaseMigration[]) {
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (!/^\d{3,}$/.test(migration.version)) throw new Error(`Database migration version ${migration.version} is invalid.`);
    if (versions.has(migration.version)) throw new Error(`Database migration version ${migration.version} is duplicated.`);
    versions.add(migration.version);
    if (!migration.name.trim() || !migration.sql.trim()) throw new Error(`Database migration ${migration.version} is incomplete.`);
  }
  return [...migrations].sort((left, right) => left.version.localeCompare(right.version));
}

function finiteTimeout(name: string, value: number | undefined, fallback: number, maximum: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${name} must be a finite number of milliseconds between 1 and ${maximum}.`);
  return resolved;
}

export async function runDatabaseMigrations(
  pool: pg.Pool,
  migrations: DatabaseMigration[],
  options: { mode: DatabaseMigrationMode; lockTimeoutMilliseconds?: number; statementTimeoutMilliseconds?: number },
): Promise<DatabaseMigrationReport> {
  const ordered = validateMigrationSet(migrations);
  const lockTimeoutMilliseconds = finiteTimeout("Migration lock timeout", options.lockTimeoutMilliseconds, defaultLockTimeoutMilliseconds, 60_000);
  const statementTimeoutMilliseconds = finiteTimeout("Migration statement timeout", options.statementTimeoutMilliseconds, defaultStatementTimeoutMilliseconds, 30 * 60_000);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [
      `${lockTimeoutMilliseconds}ms`,
      `${statementTimeoutMilliseconds}ms`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [migrationLockNamespace]);

    if (options.mode === "auto") {
      await client.query(`CREATE TABLE IF NOT EXISTS managed_schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum_sha256 CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    } else {
      const ledger = await client.query<{ ledger: string | null }>("SELECT to_regclass('public.managed_schema_migrations')::text AS ledger");
      if (!ledger.rows[0]?.ledger) throw new Error("Database migrations are pending; run npm run migrate before starting the application in manual mode.");
    }

    const result = await client.query<AppliedMigrationRow>("SELECT version, name, checksum_sha256 FROM managed_schema_migrations ORDER BY version");
    const known = new Map(ordered.map((migration) => [migration.version, migration]));
    const recorded = new Map(result.rows.map((row) => [row.version, row]));

    for (const row of result.rows) {
      const migration = known.get(row.version);
      if (!migration) throw new Error(`Database migration ${row.version} is newer than or unknown to this application build.`);
      const checksum = migrationChecksum(migration.sql);
      if (row.name !== migration.name || row.checksum_sha256.trim() !== checksum) throw new Error(`Database migration ${row.version} checksum does not match the applied ledger.`);
    }

    const pending = ordered.filter((migration) => !recorded.has(migration.version));
    if (options.mode === "manual" && pending.length) throw new Error(`Database migrations are pending (${pending.map((migration) => migration.version).join(", ")}); run npm run migrate before starting the application.`);

    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query("INSERT INTO managed_schema_migrations(version,name,checksum_sha256) VALUES($1,$2,$3)", [migration.version, migration.name, migrationChecksum(migration.sql)]);
      applied.push(migration.version);
    }
    await client.query("COMMIT");
    return { mode: options.mode, applied, alreadyApplied: ordered.filter((migration) => recorded.has(migration.version)).map((migration) => migration.version) };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureDatabaseMigrations(pool: pg.Pool, mode: DatabaseMigrationMode = config.DATABASE_MIGRATION_MODE) {
  return runDatabaseMigrations(pool, await loadDatabaseMigrations(), { mode });
}
