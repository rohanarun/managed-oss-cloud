import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("deploy/google-cloud/docker-compose.yml", "utf8");
const terraform = readFileSync("infra/google-cloud/main.tf", "utf8");
const roleConfigurator = readFileSync("deploy/google-cloud/database/configure-role-logins.sh", "utf8");
const domainIdentityPreflight = readFileSync("deploy/google-cloud/database/preflight-migration-018-domain-identities.sql", "utf8");
const rollout = readFileSync("deploy/google-cloud/rollout-control-plane.sh", "utf8");
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const containerWorkflow = readFileSync(".github/workflows/container.yml", "utf8");

function service(name: string, next: string) {
  return compose.slice(compose.indexOf(`  ${name}:`), compose.indexOf(`  ${next}:`));
}

describe("production database role separation", () => {
  it("keeps the PostgreSQL owner password out of every application service", () => {
    const control = service("control-plane", "migrate");
    const migrator = service("migrate", "subscription-reconciler");
    const reconciler = service("subscription-reconciler", "ai-worker");
    const ai = service("ai-worker", "ollama");
    const localAi = service("local-ai-worker", "gateway-reconciler");

    expect(control).toContain("database-control.env");
    expect(control).toContain("database-suite.env");
    expect(migrator).toContain("database-migrator.env");
    expect(reconciler).toContain("database-control.env");
    expect(ai).toContain("database-ai.env");
    expect(localAi).toContain("database-ai.env");
    for (const application of [control, migrator, reconciler, ai, localAi]) {
      expect(application).not.toContain("POSTGRES_PASSWORD");
      expect(application).not.toContain("postgresql://opendock:");
    }
  });

  it("creates distinct non-privileged login wrappers and verifies each credential", () => {
    for (const role of ["control", "runtime", "ai", "migrator"]) {
      expect(roleConfigurator).toContain(`managed_oss_${role}_login`);
    }
    expect(roleConfigurator.match(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/g)?.length).toBeGreaterThanOrEqual(8);
    expect(roleConfigurator).toContain("verify_login managed_oss_control_login");
    expect(roleConfigurator).toContain("verify_login managed_oss_runtime_login");
    expect(roleConfigurator).toContain("verify_login managed_oss_ai_login");
    expect(roleConfigurator).toContain("verify_login managed_oss_migrator_login");
    expect(roleConfigurator).toContain("database-role-passwords.env");
    expect(roleConfigurator).toContain("chmod 0600");
  });

  it("migrates with a bootstrap-only owner connection before installing scoped credentials", () => {
    const migration = terraform.indexOf("docker-compose --profile operations run --rm migrate");
    const configure = terraform.indexOf("configure-role-logins.sh", migration);
    const start = terraform.indexOf("docker-compose up -d", configure);
    expect(migration).toBeGreaterThan(0);
    expect(configure).toBeGreaterThan(migration);
    expect(start).toBeGreaterThan(configure);
    const runtimeHereDoc = terraform.slice(terraform.indexOf("cat > /opt/managed-oss/config/runtime.env"), terraform.indexOf("printf '%s'", terraform.indexOf("cat > /opt/managed-oss/config/runtime.env")));
    expect(runtimeHereDoc).not.toContain("POSTGRES_PASSWORD=");
    const rolloutMigration = rollout.indexOf("run --rm migrate");
    const rolloutConfigure = rollout.indexOf('"$database_configurator"', rolloutMigration);
    expect(rolloutMigration).toBeLessThan(rolloutConfigure);
    expect(rolloutConfigure).toBeLessThan(rollout.indexOf("compose up -d", rolloutConfigure));
  });

  it("installs the trusted hashing dependency with the database owner before scoped migrations", () => {
    for (const source of [rollout, terraform]) {
      const extension = source.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      const migration = source.indexOf("run --rm migrate");
      expect(extension).toBeGreaterThan(0);
      expect(extension).toBeLessThan(migration);
      expect(source.slice(extension, migration)).not.toContain("managed_oss_migrator_login");
    }
    const databaseStart = terraform.indexOf("docker-compose up -d database");
    const extension = terraform.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(databaseStart).toBeGreaterThan(0);
    expect(databaseStart).toBeLessThan(extension);
    expect(terraform.slice(databaseStart, extension)).toContain("pg_isready");
  });

  it("runs the privacy-safe migration 018 duplicate inventory with the database owner immediately before migrations", () => {
    const extension = rollout.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const preflight = rollout.indexOf('domain_identity_report="$(', extension);
    const migration = rollout.indexOf("run --rm migrate", preflight);
    expect(preflight).toBeGreaterThan(extension);
    expect(migration).toBeGreaterThan(preflight);
    const gate = rollout.slice(preflight, migration);
    expect(gate).toContain('cat -- "$domain_identity_preflight"');
    expect(gate).toContain("IFS= read -r PGPASSWORD");
    expect(gate).toContain('psql -X -q -v ON_ERROR_STOP=1 -A -t -F "|"');
    expect(gate).toContain("rows != 24 || unique_names != 24");
    expect(gate).toContain('postgres_password=""');
    expect(gate).not.toContain("-e PGPASSWORD");
    expect(domainIdentityPreflight).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    expect(domainIdentityPreflight).toContain("ROLLBACK;");
  });

  it("installs the trusted hashing dependency before every PostgreSQL-backed CI suite", () => {
    expect(ciWorkflow.match(/CREATE EXTENSION IF NOT EXISTS pgcrypto/g)).toHaveLength(2);
    expect(containerWorkflow.match(/CREATE EXTENSION IF NOT EXISTS pgcrypto/g)).toHaveLength(1);
    expect(ciWorkflow.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto")).toBeLessThan(
      ciWorkflow.indexOf("npm test"),
    );
    expect(containerWorkflow.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto")).toBeLessThan(
      containerWorkflow.indexOf("npm test"),
    );
    const acceptanceJob = ciWorkflow.slice(ciWorkflow.indexOf("shared-database-acceptance:"));
    expect(acceptanceJob.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto")).toBeLessThan(
      acceptanceJob.indexOf("npm run test:postgres-acceptance"),
    );
  });
});
