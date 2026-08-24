import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresRepository } from "../src/server/repository";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL billing capacity atomicity", () => {
  const inspection = new pg.Pool({ connectionString: databaseUrl, ssl: false });
  afterAll(async () => inspection.end());

  async function paidStarter(suffix: string) {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    const user = await repository.createUser({ email: `pg-billing-${suffix}@example.com`, displayName: `PG billing ${suffix}`, passwordHash: "unused" });
    const workerId = `pg-billing-${suffix}`;
    await repository.registerWorkerNode({ id: workerId, name: `PG billing ${suffix}`, privateAddress: "10.70.0.82", machineType: "e2-standard-2", capacityMemoryMb: 8192, capacityCpuMillis: 2000, capacityStorageGb: 100, systemReserveMemoryMb: 512 });
    const installation = await repository.createInstallation({ userId: user.id, appIds: ["uptime-kuma"], name: `PG billing ${suffix}`, plan: "starter", state: "planned", hostname: `pg-billing-${suffix}.apps.example.com`, customDomains: [] });
    const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
    const hold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: `checkout-${suffix}-initial`, requestedPlan: "starter", requestedAppIds: ["uptime-kuma"], infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }] });
    const customerId = await repository.getOrCreateStripeCustomer(user.id, async () => `cus_${suffix}`);
    const subscriptionId = `sub_${suffix}`;
    await repository.attachCheckoutSession({ holdId: hold!.id, userId: user.id, stripeCustomerId: customerId, stripeCheckoutSessionId: `cs_${suffix}`, stripeCheckoutExpiresAt: new Date(Date.now() + 35 * 60_000).toISOString() });
    await repository.processPaidCheckout({ eventId: `evt_${suffix}`, eventType: "checkout.session.completed", holdId: hold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: `cs_${suffix}`, stripeCustomerId: customerId, providerSubscriptionId: subscriptionId, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
    return { repository, user, workerId, installation, application, subscriptionId };
  }

  it("persists paid pending capacity after an expired hold and atomically recovers it", async () => {
    const repository = new PostgresRepository(databaseUrl!, false);
    await repository.initialize();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const workerId = `pg-late-${suffix}`;
    try {
      const user = await repository.createUser({ email: `pg-late-${suffix}@example.com`, displayName: "PG late paid", passwordHash: "unused" });
      await repository.registerWorkerNode({ id: workerId, name: `PG late ${suffix}`, privateAddress: "10.70.0.83", machineType: "fleet-exclusive", capacityMemoryMb: 24000, capacityCpuMillis: 8000, capacityStorageGb: 500, systemReserveMemoryMb: 512 });
      const installation = await repository.createInstallation({ userId: user.id, appIds: ["large-private-app"], name: "PG late paid", plan: "fleet", state: "planned", hostname: `pg-late-${suffix}.apps.example.com`, customDomains: [] });
      const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "large-private-app", memoryReservationMb: 23000, cpuReservationMillis: 7000, storageReservationGb: 400 }], "apps.example.com");
      const hold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: `checkout-late-${suffix}`, requestedPlan: "fleet", requestedAppIds: ["large-private-app"], infrastructureMonthlyCents: 17857, platformFeeMonthlyCents: 2143, expiresAt: new Date(Date.now() + 1400).toISOString(), planCapacity: { planId: "fleet", memoryMb: 24576, cpuMillis: 8000, storageGb: 500, maxServices: 50 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: 23000, cpuReservationMillis: 7000, storageReservationGb: 400 }] });
      const customerId = await repository.getOrCreateStripeCustomer(user.id, async () => `cus_late_${suffix}`);
      const subscriptionId = `sub_late_${suffix}`;
      await repository.attachCheckoutSession({ holdId: hold!.id, userId: user.id, stripeCustomerId: customerId, stripeCheckoutSessionId: `cs_late_${suffix}`, stripeCheckoutExpiresAt: new Date(Date.now() + 700).toISOString() });
      await repository.setWorkerNodeMode(workerId, "draining");
      await wait(1600);
      expect(await repository.processPaidCheckout({ eventId: `evt_late_${suffix}`, eventType: "checkout.session.completed", holdId: hold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: `cs_late_${suffix}`, stripeCustomerId: customerId, providerSubscriptionId: subscriptionId, infrastructureMonthlyCents: 17857, platformFeeMonthlyCents: 2143, compensationDeadlineAt: new Date(Date.now() + 60 * 60_000).toISOString() })).toBe(true);
      expect(await repository.getPaidCheckoutCapacityRecovery(subscriptionId)).toMatchObject({ state: "pending_capacity", attemptCount: 1 });
      expect((await repository.listSubscriptions()).find((item) => item.providerSubscriptionId === subscriptionId)?.status).toBe("paid_pending_capacity");
      expect((await inspection.query("SELECT COUNT(*)::INT count FROM installation_capacity_allocations WHERE installation_id=$1", [installation.id])).rows[0].count).toBe(0);

      await repository.setWorkerNodeMode(workerId, "active");
      await repository.heartbeatWorkerNode(workerId, { privateAddress: "10.70.0.83", capacityMemoryMb: 24000, capacityCpuMillis: 8000, capacityStorageGb: 500 });
      expect(await repository.retryPaidCheckoutCapacityRecovery({ providerSubscriptionId: subscriptionId, status: "active", userId: user.id, installationId: installation.id, capacityHoldId: hold!.id, customerId, infrastructureMonthlyCents: 17857, platformFeeMonthlyCents: 2143, problems: [] })).toMatchObject({ state: "fulfilled", attemptCount: 2 });
      expect(await repository.getInstallationCapacityAllocation(user.id, installation.id)).toMatchObject({ planId: "fleet", state: "active" });
      expect((await inspection.query("SELECT COUNT(*)::INT count FROM provisioning_jobs WHERE installation_id=$1 AND payload->>'paidCapacityRecoveryId' IS NOT NULL", [installation.id])).rows[0].count).toBe(1);
    } finally {
      await repository.setWorkerNodeMode(workerId, "draining").catch(() => undefined);
      await repository.close();
    }
  }, 15_000);

  it("consumes an expired resize only after a trusted provider confirmation source", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const fixture = await paidStarter(suffix);
    try {
      const hold = await fixture.repository.acquirePlanCapacityChangeHold({ userId: fixture.user.id, installationId: fixture.installation.id, idempotencyKey: `resize-${suffix}`, requested: { planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, maxServices: 12 }, infrastructureMonthlyCents: 4464, platformFeeMonthlyCents: 536, providerSubscriptionId: fixture.subscriptionId, expiresAt: new Date(Date.now() + 500).toISOString(), memorySafetyReserveMb: 192 });
      await wait(700);
      expect(await fixture.repository.consumePlanCapacityChangeHold(hold!.id, fixture.user.id, "signed_subscription_webhook")).toMatchObject({ planId: "scale", generation: 2 });
      expect(await fixture.repository.getPlanCapacityChangeHold(hold!.id)).toMatchObject({ state: "consumed", providerConfirmationSource: "signed_subscription_webhook", expiredAt: expect.any(String), providerCommittedAt: expect.any(String) });
      expect(await fixture.repository.getInstallation(fixture.user.id, fixture.installation.id)).toMatchObject({ plan: "scale" });
    } finally {
      await fixture.repository.setWorkerNodeMode(fixture.workerId, "draining").catch(() => undefined);
      await fixture.repository.close();
    }
  });

  it("serializes concurrent clone retries into one app row, appIds append, and install job", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const fixture = await paidStarter(suffix);
    try {
      await fixture.repository.updateApplicationState(fixture.application.id, "live", new Date().toISOString());
      await fixture.repository.updateInstallationState(fixture.installation.id, "live");
      const input = { userId: fixture.user.id, installationId: fixture.installation.id, idempotencyKey: `clone-${suffix}-request`, app: { appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }, hostnameBase: "apps.example.com", memorySafetyReserveMb: 192 };
      const [first, replay] = await Promise.all([fixture.repository.createApplicationClone(input), fixture.repository.createApplicationClone(input)]);
      expect(first.application.id).toBe(replay.application.id);
      expect(first.job?.id).toBe(replay.job?.id);
      expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
      const persisted = await fixture.repository.getInstallation(fixture.user.id, fixture.installation.id);
      expect(persisted?.applications).toHaveLength(2);
      expect(persisted?.appIds).toEqual(["uptime-kuma", "uptime-kuma"]);
      expect((await inspection.query("SELECT COUNT(*)::INT count FROM provisioning_jobs WHERE installation_id=$1 AND payload->>'cloneIdempotencyKey'=$2", [fixture.installation.id, input.idempotencyKey])).rows[0].count).toBe(1);
      expect((await inspection.query("SELECT COUNT(*)::INT count FROM idempotency_keys WHERE key=$1", [`application-clone:${fixture.user.id}:${input.idempotencyKey}`])).rows[0].count).toBe(1);
    } finally {
      await fixture.repository.setWorkerNodeMode(fixture.workerId, "draining").catch(() => undefined);
      await fixture.repository.close();
    }
  });
});
