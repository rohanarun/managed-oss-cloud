import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("deploy/google-cloud/docker-compose.yml", "utf8");
const terraform = readFileSync("infra/google-cloud/main.tf", "utf8");
const roleConfigurator = readFileSync("deploy/google-cloud/database/configure-role-logins.sh", "utf8");
const rollout = readFileSync("deploy/google-cloud/rollout-control-plane.sh", "utf8");

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
});
