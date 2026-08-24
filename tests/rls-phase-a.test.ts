import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDatabaseMigrations } from "../src/server/database-migrations";
import { parseRuntimeEnvironment } from "../src/server/config";

describe("suite RLS phase A", () => {
  it("loads immutable migration 003 after the existing schemas without enabling RLS", async () => {
    const migrations = await loadDatabaseMigrations();
    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: "001", name: "core-schema" },
      { version: "002", name: "suite-schema" },
      { version: "003", name: "suite-rls-phase-a" },
      { version: "004", name: "global-hostname-claims" },
      { version: "005", name: "checkout-capacity-holds" },
      { version: "006", name: "database-role-and-rls-enforcement" },
      { version: "007", name: "paid-plan-capacity-allocations" },
      { version: "008", name: "suite-action-atomicity-and-ai-audit" },
      { version: "009", name: "public-growth-surfaces" },
      { version: "010", name: "esign-atomicity-and-invariants" },
      { version: "011", name: "email-atomicity-and-invariants" },
      { version: "012", name: "managed-oauth-broker" },
      { version: "013", name: "billing-capacity-atomicity" },
      { version: "014", name: "suite-storage-accounting" },
    ]);
    const phaseA = migrations[2].sql;
    expect(phaseA).toMatch(/managed_oss_suite_owner NOLOGIN NOSUPERUSER[\s\S]*NOBYPASSRLS/);
    expect(phaseA).toMatch(/managed_oss_runtime NOLOGIN NOSUPERUSER[\s\S]*NOBYPASSRLS/);
    expect(phaseA).toMatch(/managed_oss_ai NOLOGIN NOSUPERUSER[\s\S]*NOBYPASSRLS/);
    expect(phaseA).toMatch(/managed_oss_migrator NOLOGIN NOSUPERUSER[\s\S]*NOBYPASSRLS/);
    expect(phaseA).toMatch(/ALTER TABLE suite_api_tokens ADD COLUMN IF NOT EXISTS workspace_id UUID/);
    expect(phaseA).toMatch(/SECURITY DEFINER[\s\S]*SET search_path=pg_catalog/);
    expect(phaseA).toMatch(/REVOKE ALL ON TABLE suite_workspaces/);
    expect(phaseA).not.toMatch(/(?:ENABLE|FORCE) ROW LEVEL SECURITY/i);
    expect(readFileSync("db/schema.sql", "utf8")).not.toContain("managed_oss_runtime");
    expect(readFileSync("db/suite-schema.sql", "utf8")).not.toContain("managed_oss_runtime");
  });

  it("keeps SuiteStore queries transaction-local and routes cross-workspace lookups through resolvers", () => {
    const source = readFileSync("src/server/suite-store.ts", "utf8");
    const postgres = source.slice(source.indexOf("export class PostgresSuiteStore"), source.indexOf("export function createSuiteStore"));
    expect(postgres).toContain("SELECT set_config('app.workspace_id',$1,true)");
    expect(postgres).toContain("managed_oss_workspace_context_for_user");
    expect(postgres).toContain("managed_oss_public_workspace_context");
    expect(postgres).toContain("managed_oss_custom_domain_workspace_context");
    expect(postgres).toContain("managed_oss_api_token_principal");
    expect(postgres).toContain("managed_oss_claim_suite_ai_action");
    expect(postgres).not.toContain("this.pool.query(");
    expect(postgres).toMatch(/INSERT INTO suite_api_tokens\(id,user_id,workspace_id/);
  });

  it("accepts separated credentials while retaining staged DATABASE_URL compatibility", () => {
    const parsed = parseRuntimeEnvironment({
      DATABASE_URL: "postgresql://compat@example.test/database",
      DATABASE_RUNTIME_URL: "postgresql://runtime@example.test/database",
      DATABASE_AI_URL: "postgresql://ai@example.test/database",
      DATABASE_MIGRATOR_URL: "postgresql://migrator@example.test/database",
    });
    expect(parsed).toMatchObject({
      DATABASE_URL: "postgresql://compat@example.test/database",
      DATABASE_RUNTIME_URL: "postgresql://runtime@example.test/database",
      DATABASE_AI_URL: "postgresql://ai@example.test/database",
      DATABASE_MIGRATOR_URL: "postgresql://migrator@example.test/database",
    });
    const compose = readFileSync("deploy/google-cloud/docker-compose.yml", "utf8");
    expect(compose).toContain("database-suite.env");
    expect(compose).toContain("database-ai.env");
    expect(compose).toContain("database-migrator.env");
    const subscriptionService = compose.slice(compose.indexOf("  subscription-reconciler:"), compose.indexOf("  ai-worker:"));
    expect(subscriptionService).not.toContain("database-ai.env");
  });
});
