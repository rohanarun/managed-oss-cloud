import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRepository } from "../src/server/repository";
import { PostgresSuiteStore } from "../src/server/suite-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL global hostname ownership", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false });
  const repository = new PostgresRepository(databaseUrl!, false);
  const suite = new PostgresSuiteStore(databaseUrl!, false);
  let userId = "";

  beforeAll(async () => {
    await repository.initialize();
    await suite.initialize();
  });

  afterAll(async () => {
    if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await repository.close();
    await suite.close();
    await pool.end();
  });

  it("serializes application and suite claims through one table and retains a tombstone after source deletion", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const user = await repository.createUser({ email: `domain-${suffix}@example.com`, displayName: "Domain owner", passwordHash: "unused" });
    userId = user.id;
    const installation = await repository.createInstallation({ userId, appIds: ["uptime-kuma"], name: "Domain parity", plan: "starter", state: "planned", hostname: `parity-${suffix}.apps.example.com`, customDomains: [] });
    await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
    await suite.getOrCreateWorkspace(userId);
    await suite.setWorkspacePlan(userId, "starter");

    const hostname = `shared-${suffix}.customer.example`;
    const claimed = await repository.addDomain(userId, installation.id, hostname);
    expect(claimed?.domain.ownership.claimId).toBeTruthy();
    expect(await suite.addCustomDomain(userId, hostname)).toBeUndefined();
    const registry = await pool.query("SELECT id,status FROM global_hostname_claims WHERE hostname=$1", [hostname]);
    expect(registry.rows).toEqual([{ id: claimed!.domain.ownership.claimId, status: "pending" }]);

    await pool.query("DELETE FROM custom_domains WHERE hostname_claim_id=$1", [claimed!.domain.ownership.claimId]);
    expect((await pool.query("SELECT status,tombstoned_at IS NOT NULL tombstoned FROM global_hostname_claims WHERE id=$1", [claimed!.domain.ownership.claimId])).rows[0]).toEqual({ status: "tombstoned", tombstoned: true });
    expect(await suite.addCustomDomain(userId, hostname)).toBeUndefined();

    const suiteFirst = `suite-${suffix}.customer.example`;
    expect(await suite.addCustomDomain(userId, suiteFirst)).toBeTruthy();
    expect(await repository.addDomain(userId, installation.id, suiteFirst)).toBeUndefined();
  });
});
