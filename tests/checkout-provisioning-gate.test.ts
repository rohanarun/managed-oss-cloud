import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { BillingGateway } from "../src/server/billing";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";

describe("checkout provisioning gate", () => {
  it("never creates a Stripe checkout while provisioning is locked or healthy capacity is absent", async () => {
    const repository = new MemoryRepository();
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_capacity"),
      createCheckout: vi.fn(async () => ({ id: "cs_capacity", url: "https://checkout.stripe.test/capacity" })),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => ({ id: "sub_unused", status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] })),
      constructEvent: vi.fn(() => ({ id: "evt_unused", type: "ignored" })),
    };
    const settings = { mode: "live" as const, webhookSecret: "whsec_capacity", publishableKey: "pk_capacity" };
    const suiteStore = new MemorySuiteStore();
    const lockedApp = await createApp({ repository, suiteStore, billingGateway: gateway, billingSettings: settings, provisioningReadyForBilling: false });
    const lockedCustomer = request.agent(lockedApp);
    const signup = await lockedCustomer.post("/api/auth/signup").send({ displayName: "Capacity Owner", email: "capacity-checkout@example.com", password: "long-safe-password" });
    const installation = await repository.createInstallation({ userId: signup.body.user.id, appIds: ["uptime-kuma"], name: "Capacity", plan: "starter", state: "planned", hostname: "capacity.apps.example.com", customDomains: [] });
    await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 416, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
    const checkout = () => lockedCustomer.post("/api/billing/checkout").set("idempotency-key", "capacity-checkout-key-1234").send({ installationId: installation.id });
    expect((await checkout()).status).toBe(503);
    expect(gateway.createCheckout).not.toHaveBeenCalled();

    const readyApp = await createApp({ repository, suiteStore, billingGateway: gateway, billingSettings: settings, provisioningReadyForBilling: true });
    const readyCustomer = request.agent(readyApp);
    await readyCustomer.post("/api/auth/login").send({ email: "capacity-checkout@example.com", password: "long-safe-password" });
    expect((await readyCustomer.post("/api/billing/checkout").set("idempotency-key", "capacity-checkout-key-1234").send({ installationId: installation.id })).status).toBe(503);
    expect(gateway.createCheckout).not.toHaveBeenCalled();

    await repository.registerWorkerNode({ id: "checkout-worker", name: "Checkout Worker", privateAddress: "10.70.0.60", machineType: "e2-small", capacityMemoryMb: 2048, capacityCpuMillis: 500, capacityStorageGb: 10, systemReserveMemoryMb: 512 });
    const accepted = await readyCustomer.post("/api/billing/checkout").set("idempotency-key", "capacity-checkout-key-1234").send({ installationId: installation.id });
    expect(accepted.status).toBe(200);
    expect(gateway.createCheckout).toHaveBeenCalledTimes(1);
  });
});
