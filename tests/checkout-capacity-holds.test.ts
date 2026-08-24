import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BillingService, type BillingGateway } from "../src/server/billing";
import { loadDatabaseMigrations } from "../src/server/database-migrations";
import { MemoryRepository, type AcquireCheckoutCapacityHoldInput, type Repository } from "../src/server/repository";
import type { Quote } from "../src/shared/types";

async function plannedApplication(repository: Repository, input: { userId: string; emailPrefix: string; memory?: number; cpu?: number; storage?: number }) {
  const memory = input.memory ?? 384;
  const cpu = input.cpu ?? 250;
  const storage = input.storage ?? 3;
  const installation = await repository.createInstallation({ userId: input.userId, appIds: ["uptime-kuma"], name: `Capacity ${input.emailPrefix}`, plan: "starter", state: "planned", hostname: `${input.emailPrefix}.apps.example.com`, customDomains: [] });
  const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: memory, cpuReservationMillis: cpu, storageReservationGb: storage }], "apps.example.com");
  return { installation: (await repository.getInstallation(input.userId, installation.id))!, application };
}

function holdRequest(input: { userId: string; installationId: string; applicationId: string; memory?: number; cpu?: number; storage?: number; idempotencyKey?: string; expiresAt?: string }): AcquireCheckoutCapacityHoldInput {
  return {
    userId: input.userId,
    installationId: input.installationId,
    idempotencyKey: input.idempotencyKey ?? `checkout:${randomUUID()}`,
    requestedPlan: "starter",
    requestedAppIds: ["uptime-kuma"],
    infrastructureMonthlyCents: 500,
    platformFeeMonthlyCents: 200,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 },
    reservations: [{ applicationInstanceId: input.applicationId, appId: "uptime-kuma", memoryReservationMb: input.memory ?? 384, cpuReservationMillis: input.cpu ?? 250, storageReservationGb: input.storage ?? 3 }],
  };
}

describe("durable checkout capacity holds", () => {
  it("serializes memory checkout reservations, releases failures, and ignores expired holds", async () => {
    const repository = new MemoryRepository();
    const user = await repository.createUser({ email: "holds-memory@example.com", displayName: "Hold Owner", passwordHash: "unused" });
    await repository.registerWorkerNode({ id: "hold-memory-worker", name: "Hold memory worker", privateAddress: "10.70.0.90", machineType: "exact-app", capacityMemoryMb: 896, capacityCpuMillis: 250, capacityStorageGb: 3, systemReserveMemoryMb: 512 });
    const first = await plannedApplication(repository, { userId: user.id, emailPrefix: "memory-first" });
    const second = await plannedApplication(repository, { userId: user.id, emailPrefix: "memory-second" });

    const results = await Promise.all([
      repository.acquireCheckoutCapacityHold(holdRequest({ userId: user.id, installationId: first.installation.id, applicationId: first.application.id })),
      repository.acquireCheckoutCapacityHold(holdRequest({ userId: user.id, installationId: second.installation.id, applicationId: second.application.id })),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const active = results.find(Boolean)!;
    const activeTarget = results[0] ? first : second;
    const blocked = results[0] ? second : first;
    expect(await repository.hasActiveCheckoutCapacityHold(activeTarget.installation.id)).toBe(true);
    expect(await repository.upgrade(user.id, activeTarget.installation.id, "scale")).toBeUndefined();
    await repository.appendApplicationId(activeTarget.installation.id, "blocked-snapshot-change");
    expect((await repository.getInstallation(user.id, activeTarget.installation.id))?.appIds).toEqual(["uptime-kuma"]);
    await expect(repository.createApplicationInstances(activeTarget.installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 64, cpuReservationMillis: 50, storageReservationGb: 1 }], "apps.example.com")).rejects.toThrow(/active checkout capacity hold/);
    expect(await repository.hasFreshProvisioningCapacity([{ memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }])).toBe(false);
    expect(await repository.releaseCheckoutCapacityHold(active.id, user.id, "test_checkout_creation_failed")).toBe(true);
    expect((await repository.getCheckoutCapacityHold(active.id))?.state).toBe("released");

    const short = await repository.acquireCheckoutCapacityHold(holdRequest({ userId: user.id, installationId: blocked.installation.id, applicationId: blocked.application.id, expiresAt: new Date(Date.now() + 5).toISOString() }));
    expect(short?.state).toBe("active");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await repository.getCheckoutCapacityHold(short!.id))?.state).toBe("expired");
    expect(await repository.hasFreshProvisioningCapacity([{ memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }])).toBe(true);
  });

  it("releases the exact hold when Stripe checkout creation fails", async () => {
    const repository = new MemoryRepository();
    const user = await repository.createUser({ email: "hold-failure@example.com", displayName: "Checkout failure", passwordHash: "unused" });
    await repository.registerWorkerNode({ id: "hold-failure-worker", name: "Hold failure worker", privateAddress: "10.70.0.91", machineType: "e2-small", capacityMemoryMb: 2048, capacityCpuMillis: 500, capacityStorageGb: 10, systemReserveMemoryMb: 512 });
    const { installation } = await plannedApplication(repository, { userId: user.id, emailPrefix: "checkout-failure" });
    let holdId: string | undefined;
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_checkout_failure"),
      createCheckout: vi.fn(async (input) => { holdId = input.capacityHoldId; throw new Error("provider unavailable"); }),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => { throw new Error("unused"); }),
      constructEvent: vi.fn(() => ({ id: "evt_unused", type: "ignored" })),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_failure", publishableKey: "pk_failure" });
    const quote: Quote = { selectedApps: [], requestedMemoryMb: 384, requestedCpuMillis: 250, requestedStorageGb: 3, reservedMemoryMb: 128, compatibleWithBundle: true, recommendedPlan: { id: "starter", label: "Starter", memoryMb: 1536, cpu: .5, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 }, infrastructureMonthlyCents: 500, platformFeeCents: 200, totalMonthlyCents: 700, requiresSplit: false, explanation: "fits" };

    await expect(service.checkout(user, installation, quote, "checkout:failure:capacity:1234")).rejects.toThrow(/provider unavailable/);
    expect(holdId).toBeTruthy();
    expect((await repository.getCheckoutCapacityHold(holdId!))?.state).toBe("released");
    expect(await repository.hasFreshProvisioningCapacity([{ memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }])).toBe(true);
  });

  it("declares immutable state, ownership, expiry, uniqueness, allocation, and runtime grants in migration 005", async () => {
    const sql = readFileSync("db/migrations/005-checkout-capacity-holds.sql", "utf8");
    expect(sql).toMatch(/state IN \('active','consumed','released','expired'\)/);
    expect(sql).toMatch(/UNIQUE\(user_id,idempotency_key\)/);
    expect(sql).toMatch(/UNIQUE\(stripe_checkout_session_id\)/);
    expect(sql).toMatch(/WHERE state='active'/);
    expect(sql).toMatch(/checkout_capacity_hold_items[\s\S]*worker_node_id TEXT NOT NULL REFERENCES worker_nodes/);
    expect(sql).toMatch(/expires_at>created_at/);
    expect(sql).toMatch(/checkout capacity hold snapshot is immutable/);
    expect(sql).toMatch(/checkout capacity hold allocation is immutable/);
    expect(sql).toMatch(/GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE checkout_capacity_holds,checkout_capacity_hold_items TO managed_oss_runtime/);
    expect((await loadDatabaseMigrations()).find((migration) => migration.version === "005")).toMatchObject({ version: "005", name: "checkout-capacity-holds" });
  });

});
