import pg from "pg";
import { config } from "./config.js";
import { loadDatabaseMigrations, runDatabaseMigrations } from "./database-migrations.js";
import { backfillLegacyPaidPlanCapacity } from "./legacy-capacity-backfill.js";

let pool: pg.Pool | undefined;
try {
  const migrationUrl = config.DATABASE_MIGRATOR_URL ?? config.DATABASE_URL;
  if (!migrationUrl) throw new Error("Database migration requires DATABASE_MIGRATOR_URL or the compatibility fallback DATABASE_URL.");
  pool = new pg.Pool({ connectionString: migrationUrl, ssl: config.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false });
  const migrations = await runDatabaseMigrations(pool, await loadDatabaseMigrations(), { mode: "auto" });
  const legacyCapacityBackfill = await backfillLegacyPaidPlanCapacity(pool, { plans: config.plans, memorySafetyReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB });
  process.stdout.write(`${JSON.stringify({ migrations, legacyCapacityBackfill })}\n`);
} catch (error) {
  const raw = error instanceof Error ? error.message : "Database migration failed.";
  const safe = [config.DATABASE_MIGRATOR_URL,config.DATABASE_URL].filter((value): value is string => Boolean(value)).reduce((message,value) => message.replaceAll(value,"[REDACTED]"),raw);
  process.stderr.write(`${JSON.stringify({ error: safe })}\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
