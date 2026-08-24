import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applicationCapacityUsage, capacityEnvelopeFit, planCapacitySnapshot, positiveCapacityDelta } from "../src/shared/plan-capacity";
import type { ApplicationInstance, ComputePlan } from "../src/shared/types";
import { loadDatabaseMigrations } from "../src/server/database-migrations";
import { MemoryRepository } from "../src/server/repository";

const plan = (input: Partial<ComputePlan> = {}): ComputePlan => ({
  id: "scale",
  label: "Scale",
  memoryMb: 6_144,
  cpu: 2,
  storageGb: 100,
  maxServices: 12,
  infrastructureMonthlyCents: 4_464,
  monthlyCents: 5_000,
  ...input,
});

const application = (input: Partial<ApplicationInstance> = {}): ApplicationInstance => ({
  id: "app-1",
  installationId: "installation-1",
  appId: "status",
  state: "live",
  hostname: "status.apps.example.com",
  containerProject: "status",
  customDomains: [],
  memoryReservationMb: 512,
  cpuReservationMillis: 250,
  storageReservationGb: 5,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...input,
});

describe("paid plan capacity envelopes", () => {
  it("persists the complete logical plan quota independently of today's application usage", () => {
    const allocation = planCapacitySnapshot(plan());
    const usage = applicationCapacityUsage([application()], 192);
    expect(allocation).toEqual({ planId: "scale", memoryMb: 6_144, cpuMillis: 2_000, storageGb: 100, maxServices: 12 });
    expect(usage).toEqual({ memoryMb: 704, cpuMillis: 250, storageGb: 5, services: 1 });
    expect(capacityEnvelopeFit(usage, allocation)).toMatchObject({ fits: true, remaining: { memoryMb: 5_440, cpuMillis: 1_750, storageGb: 95, services: 11 } });
  });

  it("computes the positive logical upgrade delta while a downgrade needs no added quota", () => {
    const starter = planCapacitySnapshot(plan({ id: "starter", memoryMb: 1_536, cpu: 0.5, storageGb: 10, maxServices: 2 }));
    const scale = planCapacitySnapshot(plan());
    expect(positiveCapacityDelta(starter, scale)).toEqual({ memoryMb: 4_608, cpuMillis: 1_500, storageGb: 90 });
    expect(positiveCapacityDelta(scale, starter)).toEqual({ memoryMb: 0, cpuMillis: 0, storageGb: 0 });
  });

  it("uses zero worker app capacity for Suite-only customers and atomically enforces physical and logical clone limits", async () => {
    const repository = new MemoryRepository();
    const workerId = "logical-quota-worker";
    await repository.registerWorkerNode({ id: workerId, name: "Logical quota worker", privateAddress: "10.70.0.94", machineType: "exact-one-app", capacityMemoryMb: 896, capacityCpuMillis: 250, capacityStorageGb: 1, systemReserveMemoryMb: 512 });
    const customers: Array<{ userId: string; installationId: string }> = [];
    const paidPlans = [
      { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 },
      { planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, maxServices: 12, infrastructureMonthlyCents: 4464, platformFeeMonthlyCents: 536 },
      { planId: "fleet", memoryMb: 24576, cpuMillis: 8000, storageGb: 500, maxServices: 50, infrastructureMonthlyCents: 17857, platformFeeMonthlyCents: 2143 },
    ] as const;

    for (let index = 0; index < 100; index += 1) {
      const selectedPlan = paidPlans[index % paidPlans.length];
      const user = await repository.createUser({ email: `suite-only-${index}@example.com`, displayName: `Suite customer ${index}`, passwordHash: "unused" });
      const installation = await repository.createInstallation({ userId: user.id, appIds: [], name: `Suite only ${index}`, plan: selectedPlan.planId, state: "planned", hostname: `suite-only-${index}.apps.example.com`, customDomains: [] });
      const hold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: `suite-only:${index}:${randomUUID()}`, requestedPlan: selectedPlan.planId, requestedAppIds: [], infrastructureMonthlyCents: selectedPlan.infrastructureMonthlyCents, platformFeeMonthlyCents: selectedPlan.platformFeeMonthlyCents, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), planCapacity: selectedPlan, reservations: [] });
      expect(hold).toBeTruthy();
      const customerId = await repository.getOrCreateStripeCustomer(user.id, async () => `cus_suite_${index}`);
      const sessionId = `cs_suite_${index}`;
      await repository.attachCheckoutSession({ holdId: hold!.id, userId: user.id, stripeCustomerId: customerId, stripeCheckoutSessionId: sessionId, stripeCheckoutExpiresAt: new Date(Date.now() + 35 * 60_000).toISOString() });
      expect(await repository.processPaidCheckout({ eventId: `evt_suite_${index}`, eventType: "checkout.session.completed", holdId: hold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: sessionId, stripeCustomerId: customerId, providerSubscriptionId: `sub_suite_${index}`, infrastructureMonthlyCents: selectedPlan.infrastructureMonthlyCents, platformFeeMonthlyCents: selectedPlan.platformFeeMonthlyCents })).toBe(true);
      customers.push({ userId: user.id, installationId: installation.id });
    }

    expect((await repository.getWorkerNodeActivity(workerId))?.node).toMatchObject({ reservedMemoryMb: 0, reservedCpuMillis: 0, reservedStorageGb: 0 });
    expect(await repository.getInstallationCapacityAllocation(customers[0].userId, customers[0].installationId)).toMatchObject({ planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 });
    expect(await repository.getInstallationCapacityAllocation(customers[1].userId, customers[1].installationId)).toMatchObject({ planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, maxServices: 12 });
    expect(await repository.getInstallationCapacityAllocation(customers[2].userId, customers[2].installationId)).toMatchObject({ planId: "fleet", memoryMb: 24576, cpuMillis: 8000, storageGb: 500, maxServices: 50 });

    const [firstClone] = await repository.createApplicationInstances(customers[0].installationId, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192);
    expect(firstClone.workerNodeId).toBe(workerId);
    expect((await repository.getWorkerNodeActivity(workerId))?.node).toMatchObject({ reservedMemoryMb: 384, reservedCpuMillis: 250, reservedStorageGb: 1 });

    const beforePhysicalFailure = (await repository.getInstallation(customers[1].userId, customers[1].installationId))!.applications!.length;
    expect(await repository.canReserveOnInstallationWorker(customers[1].installationId, { memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }, 192)).toBe(false);
    await expect(repository.createApplicationInstances(customers[1].installationId, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192)).rejects.toThrow(/worker pool cannot reserve/);
    expect((await repository.getInstallation(customers[1].userId, customers[1].installationId))!.applications).toHaveLength(beforePhysicalFailure);

    await repository.registerWorkerNode({ id: "logical-quota-worker-two", name: "Logical quota worker two", privateAddress: "10.70.0.95", machineType: "shared-apps", capacityMemoryMb: 2048, capacityCpuMillis: 1000, capacityStorageGb: 10, systemReserveMemoryMb: 512 });
    const resize = await repository.acquirePlanCapacityChangeHold({ userId: customers[0].userId, installationId: customers[0].installationId, idempotencyKey: `suite-only-resize:${randomUUID()}`, requested: { planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, maxServices: 12 }, infrastructureMonthlyCents: 4464, platformFeeMonthlyCents: 536, providerSubscriptionId: "sub_suite_0", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), memorySafetyReserveMb: 192 });
    expect(resize).toBeTruthy();
    expect(await repository.canReserveOnInstallationWorker(customers[0].installationId, { memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }, 192)).toBe(false);
    await expect(repository.createApplicationInstances(customers[0].installationId, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192)).rejects.toThrow(/active plan quota change hold/);
    expect((await repository.getInstallation(customers[0].userId, customers[0].installationId))!.applications).toHaveLength(1);
    expect(await repository.releasePlanCapacityChangeHold(resize!.id, customers[0].userId, "test_resize_abandoned")).toBe(true);

    const [secondClone] = await repository.createApplicationInstances(customers[0].installationId, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 1 }], "apps.example.com", 192);
    expect(secondClone.workerNodeId).toBe("logical-quota-worker-two");
    const beforeQuotaFailure = (await repository.getInstallation(customers[0].userId, customers[0].installationId))!.applications!.length;
    await expect(repository.createApplicationInstances(customers[0].installationId, [{ appId: "tiny", memoryReservationMb: 1, cpuReservationMillis: 1, storageReservationGb: 1 }], "apps.example.com", 192)).rejects.toThrow(/plan quota cannot contain/);
    expect((await repository.getInstallation(customers[0].userId, customers[0].installationId))!.applications).toHaveLength(beforeQuotaFailure);
  });

  it("checks clone usage inside the allocation rather than against uncommitted worker space", () => {
    const allocation = planCapacitySnapshot(plan({ id: "starter", memoryMb: 1_536, cpu: 0.5, storageGb: 10, maxServices: 2 }));
    const full = applicationCapacityUsage([
      application({ id: "one", memoryReservationMb: 640, storageReservationGb: 5 }),
      application({ id: "two", memoryReservationMb: 640, storageReservationGb: 5 }),
    ], 192);
    expect(capacityEnvelopeFit(full, allocation)).toMatchObject({ fits: true });
    const third = applicationCapacityUsage([
      application({ id: "one", memoryReservationMb: 640, storageReservationGb: 5 }),
      application({ id: "two", memoryReservationMb: 640, storageReservationGb: 5 }),
      application({ id: "three", memoryReservationMb: 1, cpuReservationMillis: 1, storageReservationGb: 1 }),
    ], 192);
    expect(capacityEnvelopeFit(third, allocation)).toMatchObject({ fits: false, exceeded: expect.arrayContaining(["storageGb", "services"]) });
  });

  it("defines durable initial, resize, ownership, immutable, and least-privilege storage", async () => {
    const sql = readFileSync("db/migrations/007-paid-plan-capacity-allocations.sql", "utf8");
    expect(sql).toMatch(/CREATE TABLE checkout_plan_capacity_holds/);
    expect(sql).not.toMatch(/IF EXISTS \(SELECT 1 FROM subscriptions WHERE status IN \('active','trialing'\)/);
    expect(sql).toMatch(/runtime-plan-aware, transactionally locked legacy backfill/);
    expect(sql).toMatch(/CREATE TABLE installation_capacity_allocations/);
    expect(sql).toMatch(/CREATE TABLE plan_capacity_change_holds/);
    expect(sql).toMatch(/UNIQUE\(user_id,idempotency_key\)/);
    expect(sql).toMatch(/expected_generation BIGINT/);
    expect(sql).toMatch(/reserved_delta_memory_mb INTEGER NOT NULL CHECK \(reserved_delta_memory_mb>=0\)/);
    expect(sql).toMatch(/reserved_delta columns describe quota headroom and do not reserve physical worker capacity/);
    expect(sql).toMatch(/Physical worker commitment is derived only from assigned application instances and active checkout hold items/);
    expect(sql).toMatch(/plan capacity change hold snapshot is immutable/);
    expect(sql).toMatch(/checkout plan capacity hold allocation is immutable/);
    expect(sql).toMatch(/installation capacity allocation events are append-only/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC,managed_oss_runtime/);
    expect((await loadDatabaseMigrations()).find((migration) => migration.version === "007")).toMatchObject({ name: "paid-plan-capacity-allocations" });
  });
});
