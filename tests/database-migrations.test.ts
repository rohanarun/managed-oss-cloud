import { readFileSync } from "node:fs";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { migrationChecksum, runDatabaseMigrations, type DatabaseMigration } from "../src/server/database-migrations";
import { parseRuntimeEnvironment } from "../src/server/config";

interface LedgerRow {
  version: string;
  name: string;
  checksum_sha256: string;
}

class FakeMigrationClient {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  readonly rows: LedgerRow[];
  ledgerExists: boolean;
  released = false;

  constructor(input: { ledgerExists?: boolean; rows?: LedgerRow[] } = {}) {
    this.ledgerExists = input.ledgerExists ?? true;
    this.rows = [...(input.rows ?? [])];
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });
    if (text.startsWith("CREATE TABLE IF NOT EXISTS managed_schema_migrations")) this.ledgerExists = true;
    if (text.startsWith("SELECT to_regclass")) return { rows: [{ ledger: this.ledgerExists ? "managed_schema_migrations" : null } as unknown as T] };
    if (text.startsWith("SELECT version, name, checksum_sha256")) return { rows: this.rows as unknown as T[] };
    if (text.startsWith("INSERT INTO managed_schema_migrations")) {
      this.rows.push({ version: String(values?.[0]), name: String(values?.[1]), checksum_sha256: String(values?.[2]) });
    }
    return { rows: [] };
  }

  release() { this.released = true; }
}

function poolFor(client: FakeMigrationClient) {
  return { connect: async () => client } as unknown as pg.Pool;
}

const migrations: DatabaseMigration[] = [
  { version: "002", name: "second", sql: "CREATE TABLE second_example(id INTEGER);" },
  { version: "001", name: "first", sql: "CREATE TABLE first_example(id INTEGER);" },
];

describe("database migration runner", () => {
  it("serializes, bounds, checksums, and commits pending migrations in version order", async () => {
    const client = new FakeMigrationClient({ ledgerExists: false });
    const report = await runDatabaseMigrations(poolFor(client), migrations, { mode: "auto", lockTimeoutMilliseconds: 1_500, statementTimeoutMilliseconds: 45_000 });

    expect(report).toEqual({ mode: "auto", applied: ["001", "002"], alreadyApplied: [] });
    expect(client.queries.slice(0, 3)).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", values: ["1500ms", "45000ms"] },
      { text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", values: ["managed-oss-cloud/database-migrations"] },
    ]);
    expect(client.queries.findIndex((query) => query.text === migrations[1].sql)).toBeLessThan(client.queries.findIndex((query) => query.text === migrations[0].sql));
    expect(client.rows).toEqual([
      { version: "001", name: "first", checksum_sha256: migrationChecksum(migrations[1].sql) },
      { version: "002", name: "second", checksum_sha256: migrationChecksum(migrations[0].sql) },
    ]);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("fails closed and rolls back when an applied checksum changes", async () => {
    const client = new FakeMigrationClient({ rows: [{ version: "001", name: "first", checksum_sha256: "0".repeat(64) }] });
    await expect(runDatabaseMigrations(poolFor(client), migrations, { mode: "auto" })).rejects.toThrow(/checksum does not match/);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.queries).not.toContainEqual(expect.objectContaining({ text: migrations[0].sql }));
    expect(client.released).toBe(true);
  });

  it("keeps manual startup read-only and rejects a missing or pending ledger", async () => {
    const missing = new FakeMigrationClient({ ledgerExists: false });
    await expect(runDatabaseMigrations(poolFor(missing), migrations, { mode: "manual" })).rejects.toThrow(/run npm run migrate/);
    expect(missing.queries.some((query) => query.text.startsWith("CREATE TABLE"))).toBe(false);
    expect(missing.queries.at(-1)?.text).toBe("ROLLBACK");

    const currentFirst = migrations.find((migration) => migration.version === "001")!;
    const pending = new FakeMigrationClient({ rows: [{ version: "001", name: currentFirst.name, checksum_sha256: migrationChecksum(currentFirst.sql) }] });
    await expect(runDatabaseMigrations(poolFor(pending), migrations, { mode: "manual" })).rejects.toThrow(/pending \(002\)/);
    expect(pending.queries.some((query) => query.text === migrations[0].sql)).toBe(false);
  });

  it("allows manual startup only when the exact migration ledger is current", async () => {
    const rows = migrations.map((migration) => ({ version: migration.version, name: migration.name, checksum_sha256: migrationChecksum(migration.sql) }));
    const client = new FakeMigrationClient({ rows });
    await expect(runDatabaseMigrations(poolFor(client), migrations, { mode: "manual" })).resolves.toEqual({ mode: "manual", applied: [], alreadyApplied: ["001", "002"] });
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("validates migration mode and removes the unbounded suite table lock", () => {
    expect(parseRuntimeEnvironment({ DATABASE_MIGRATION_MODE: "manual" }).DATABASE_MIGRATION_MODE).toBe("manual");
    expect(parseRuntimeEnvironment({}).DATABASE_MIGRATION_MODE).toBe("auto");
    expect(() => parseRuntimeEnvironment({ DATABASE_MIGRATION_MODE: "unsafe" })).toThrow();
    expect(readFileSync("db/suite-schema.sql", "utf8")).not.toMatch(/LOCK TABLE suite_workspaces/i);
  });

  it("rejects disabled or unbounded timeout configuration before opening a connection", async () => {
    let connected = false;
    const pool = { connect: async () => { connected = true; return new FakeMigrationClient(); } } as unknown as pg.Pool;
    await expect(runDatabaseMigrations(pool, migrations, { mode: "auto", lockTimeoutMilliseconds: 0 })).rejects.toThrow(/finite number/);
    await expect(runDatabaseMigrations(pool, migrations, { mode: "auto", statementTimeoutMilliseconds: Number.POSITIVE_INFINITY })).rejects.toThrow(/finite number/);
    expect(connected).toBe(false);
  });
});
