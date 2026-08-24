import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDatabaseMigrations } from "../src/server/database-migrations";

const suiteTables = [
  "suite_workspaces",
  "suite_workspace_members",
  "suite_custom_domains",
  "suite_workspace_modules",
  "suite_records",
  "suite_events",
  "suite_ai_actions",
  "suite_api_tokens",
  "suite_record_links",
  "global_hostname_claims",
];

describe("suite RLS phase B", () => {
  it("loads the immutable enforcement migration after capacity holds", async () => {
    const migrations = await loadDatabaseMigrations();
    const phaseB = migrations.find((migration) => migration.version === "006");
    expect(phaseB?.name).toBe("database-role-and-rls-enforcement");
    expect(migrations.map((migration) => migration.version)).toEqual(["001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011", "012", "013", "014", "015", "016", "017", "018"]);
    for (const table of suiteTables) {
      expect(phaseB?.sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(phaseB?.sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
  });

  it("separates control, runtime, AI, and migrator credentials in deployment", () => {
    const compose = readFileSync("deploy/google-cloud/docker-compose.yml", "utf8");
    const control = compose.slice(compose.indexOf("  control-plane:"), compose.indexOf("  migrate:"));
    const migration = compose.slice(compose.indexOf("  migrate:"), compose.indexOf("  subscription-reconciler:"));
    const reconciler = compose.slice(compose.indexOf("  subscription-reconciler:"), compose.indexOf("  ai-worker:"));
    const ai = compose.slice(compose.indexOf("  ai-worker:"), compose.indexOf("  local-ai:"));
    expect(control).toContain("database-control.env");
    expect(control).toContain("database-suite.env");
    expect(control).not.toContain("database-migrator.env");
    expect(migration).toContain("database-migrator.env");
    expect(migration).not.toContain("database-control.env");
    expect(reconciler).toContain("database-control.env");
    expect(reconciler).not.toContain("database-suite.env");
    expect(ai).toContain("database-ai.env");
    expect(ai).not.toContain("database-control.env");
    expect(compose).not.toContain("postgresql://opendock");
  });

  it("gives the control plane only a security-definer entitlement boundary into Suite data", () => {
    const sql = readFileSync("db/migrations/006-database-role-and-rls-enforcement.sql", "utf8");
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION managed_oss_reconcile_suite_entitlement[\s\S]*SECURITY DEFINER[\s\S]*SET search_path=pg_catalog/);
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION managed_oss_reconcile_suite_entitlement(UUID,TEXT,TEXT[]) TO managed_oss_control");
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*suite_(?:workspaces|records|ai_actions)[^;]*managed_oss_control/i);
    expect(sql).toContain("REVOKE ALL ON TABLE checkout_capacity_holds,checkout_capacity_hold_items FROM managed_oss_runtime");
  });
});
