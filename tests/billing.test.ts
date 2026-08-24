import { describe, expect, it, vi } from "vitest";
import { BillingService, type BillingGateway } from "../src/server/billing";
import { MemoryRepository } from "../src/server/repository";
import type { Quote } from "../src/shared/types";

async function fixture() {
  const repository = new MemoryRepository();
  const user = await repository.createUser({ email: "billing@example.com", displayName: "Billing Owner", passwordHash: "unused" });
  const installation = await repository.createInstallation({ userId: user.id, appIds: ["uptime-kuma"], name: "Status", plan: "starter", state: "planned", hostname: "status.apps.example.com", customDomains: [] });
  await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
  await repository.registerWorkerNode({ id: `billing-worker-${user.id.slice(0, 8)}`, name: `Billing worker ${user.id.slice(0, 8)}`, privateAddress: "10.70.0.80", machineType: "e2-standard-2", capacityMemoryMb: 8192, capacityCpuMillis: 2000, capacityStorageGb: 100, systemReserveMemoryMb: 512 });
  const quote: Quote = { selectedApps: [], requestedMemoryMb: 448, requestedCpuMillis: 250, requestedStorageGb: 3, reservedMemoryMb: 192, compatibleWithBundle: true, recommendedPlan: { id: "starter", label: "Starter", memoryMb: 1536, cpu: .5, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 }, infrastructureMonthlyCents: 500, platformFeeCents: 200, totalMonthlyCents: 700, requiresSplit: false, explanation: "fits" };
  return { repository, user, installation: (await repository.getInstallation(user.id, installation.id))!, quote };
}

describe("billing safety", () => {
  it("requires the complete live billing configuration", async () => {
    const { repository, user, installation, quote } = await fixture();
    const service = new BillingService(repository, undefined, { mode: "disabled" });
    await expect(service.checkout(user, installation, quote, "checkout-safe-key-1234")).rejects.toThrow(/not enabled/);
  });

  it("creates itemized checkout and processes one signed paid event exactly once", async () => {
    const { repository, user, installation, quote } = await fixture();
    let createdCheckout: Parameters<BillingGateway["createCheckout"]>[0] | undefined;
    let checkoutGatewayCalledAt = 0;
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_safe"),
      createCheckout: vi.fn(async (input) => { checkoutGatewayCalledAt = Date.now(); createdCheckout = input; return { id: "cs_safe", url: "https://checkout.stripe.test/safe", expiresAt: input.expiresAt }; }),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => ({ id: "sub_safe", status: "active", userId: user.id, installationId: installation.id, capacityHoldId: createdCheckout?.capacityHoldId, customerId: "cus_safe", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] })),
      constructEvent: vi.fn(() => {
        if (!createdCheckout) throw new Error("Checkout was not created.");
        return { id: "evt_safe", type: "checkout.session.completed", checkout: { sessionId: "cs_safe", customerId: "cus_safe", paymentStatus: "paid", subscriptionId: "sub_safe", metadata: { userId: user.id, installationId: installation.id, planId: installation.plan, capacityHoldId: createdCheckout.capacityHoldId, infrastructureMonthlyCents: "500", platformFeeMonthlyCents: "200" } } };
      }),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    const checkout = await service.checkout(user, installation, quote, "checkout-safe-key-1234");
    expect(checkout.url).toContain("stripe.test");
    expect(gateway.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 }));
    expect(new Date(createdCheckout!.expiresAt).getTime() - checkoutGatewayCalledAt).toBeGreaterThanOrEqual(34 * 60_000);
    const activeHold = await repository.getCheckoutCapacityHold(createdCheckout!.capacityHoldId);
    expect(new Date(activeHold!.expiresAt).getTime() - new Date(createdCheckout!.expiresAt).getTime()).toBeGreaterThanOrEqual(24 * 60_000);

    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: false, queued: true, userId: user.id, installationId: installation.id, plan: "starter" });
    expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("provisioning");
    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: true, userId: user.id, installationId: installation.id, entitlementSyncRequired: true });
    expect(await repository.getInstallationCapacityAllocation(user.id, installation.id)).toMatchObject({ planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2, state: "active" });
    expect(await repository.canReserveOnInstallationWorker(installation.id, { memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }, 192)).toBe(true);
    const [clone] = await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com", 192);
    expect(clone.workerNodeId).toBeTruthy();
    expect((await repository.enqueueJob(installation.id, "install", { applicationInstanceId: clone.id })).workerNodeId).toBe(clone.workerNodeId);
    expect(await repository.canReserveOnInstallationWorker(installation.id, { memoryReservationMb: 1, cpuReservationMillis: 1, storageReservationGb: 1 }, 192)).toBe(false);
  });

  it("reconciles an active subscription before changing its paid plan", async () => {
    const { repository, user, installation } = await fixture();
    const application = installation.applications![0];
    const hold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: "upgrade-initial-checkout", requestedPlan: "starter", requestedAppIds: installation.appIds, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: application.memoryReservationMb, cpuReservationMillis: application.cpuReservationMillis, storageReservationGb: application.storageReservationGb }] });
    expect(hold).toBeTruthy();
    await repository.getOrCreateStripeCustomer(user.id, async () => "cus_upgrade");
    await repository.attachCheckoutSession({ holdId: hold!.id, userId: user.id, stripeCustomerId: "cus_upgrade", stripeCheckoutSessionId: "cs_upgrade", stripeCheckoutExpiresAt: new Date(Date.now() + 35 * 60_000).toISOString() });
    await repository.processPaidCheckout({ eventId: "evt_upgrade_initial", eventType: "checkout.session.completed", holdId: hold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: "cs_upgrade", stripeCustomerId: "cus_upgrade", providerSubscriptionId: "sub_upgrade", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_safe"),
      createCheckout: vi.fn(async () => ({ id: "cs_safe", url: "https://checkout.stripe.test/safe" })),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => ({ id: "sub_unused", status: "active", userId: user.id, installationId: installation.id, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] })),
      constructEvent: vi.fn(() => ({ id: "evt_unused", type: "ignored" })),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    const plan = { id: "scale", label: "Scale", memoryMb: 6144, cpu: 2, storageGb: 100, maxServices: 12, infrastructureMonthlyCents: 4464, monthlyCents: 5000 };
    await service.upgrade(user, installation, plan, 536);
    expect(gateway.updateSubscription).toHaveBeenCalledWith(expect.objectContaining({ providerSubscriptionId: "sub_upgrade", installationId: installation.id, plan, platformFeeMonthlyCents: 536, capacityChangeHoldId: expect.any(String), idempotencyKey: expect.stringContaining("capacity-resize:") }));
    expect(await repository.getInstallationCapacityAllocation(user.id, installation.id)).toMatchObject({ planId: "scale", memoryMb: 6144, cpuMillis: 2000, storageGb: 100, generation: 2 });
    vi.mocked(gateway.updateSubscription).mockClear();
    const fleet = { id: "fleet", label: "Fleet", memoryMb: 24576, cpu: 8, storageGb: 500, maxServices: 50, infrastructureMonthlyCents: 17857, monthlyCents: 20000 };
    await service.upgrade(user, (await repository.getInstallation(user.id, installation.id))!, fleet, 2143);
    expect(gateway.updateSubscription).toHaveBeenCalledWith(expect.objectContaining({ providerSubscriptionId: "sub_upgrade", plan: fleet, capacityChangeHoldId: expect.any(String) }));
    expect(await repository.getInstallationCapacityAllocation(user.id, installation.id)).toMatchObject({ planId: "fleet", memoryMb: 24576, cpuMillis: 8000, storageGb: 500, generation: 3 });
    const starter = { id: "starter", label: "Starter", memoryMb: 1536, cpu: .5, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 };
    await service.upgrade(user, (await repository.getInstallation(user.id, installation.id))!, starter, 200);
    expect(await repository.getInstallationCapacityAllocation(user.id, installation.id)).toMatchObject({ planId: "starter", generation: 4 });
    await repository.updateSubscriptionStatus("sub_upgrade", "canceled");
    await repository.updateSubscriptionStatus("sub_upgrade", "canceled");
    expect(await repository.getInstallationCapacityAllocation(user.id, installation.id)).toMatchObject({ planId: "starter", generation: 5, state: "suspended", releaseReason: "Subscription became inactive." });
    await repository.updateSubscriptionStatus("sub_upgrade", "active");
    await repository.updateSubscriptionStatus("sub_upgrade", "active");
    expect(await repository.getInstallationCapacityAllocation(user.id, installation.id)).toMatchObject({ planId: "starter", generation: 6, state: "active", suspendedAt: undefined, releaseReason: undefined });
  });

  it("revokes premium entitlement metadata when Stripe cancels or marks a subscription inactive", async () => {
    const { repository, user, installation } = await fixture();
    await repository.upgrade(user.id, installation.id, "fleet");
    await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: "sub_lifecycle", status: "active", infrastructureMonthlyCents: 17857, platformFeeMonthlyCents: 2143 });
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_safe"),
      createCheckout: vi.fn(async () => ({ id: "cs_safe", url: "https://checkout.stripe.test/safe" })),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => ({ id: "sub_lifecycle", status: "active", userId: user.id, installationId: installation.id, infrastructureMonthlyCents: 17_857, platformFeeMonthlyCents: 2_143, problems: [] })),
      constructEvent: vi.fn(() => ({ id: "evt_cancel", type: "customer.subscription.deleted", subscription: { id: "sub_lifecycle", status: "canceled", userId: user.id, installationId: installation.id } })),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: false, subscriptionChanged: true, status: "canceled", userId: user.id, installationId: installation.id, plan: "none", entitlementActive: false, ownershipQuarantined: false, pricingQuarantined: false });
    expect(await repository.getActiveSubscription(user.id, installation.id)).toBeUndefined();
    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: true, userId: user.id, installationId: installation.id, entitlementSyncRequired: true });
  });

  it("rejects a paid event whose provider line items do not exactly match the configured plan", async () => {
    const { repository, user, installation, quote } = await fixture();
    let createdCheckout: Parameters<BillingGateway["createCheckout"]>[0] | undefined;
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_safe"),
      createCheckout: vi.fn(async (input) => { createdCheckout = input; return { id: "cs_underpaid", url: "https://checkout.stripe.test/safe", expiresAt: input.expiresAt }; }),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => ({ id: "sub_underpaid", status: "active", userId: user.id, installationId: installation.id, capacityHoldId: createdCheckout?.capacityHoldId, customerId: "cus_safe", infrastructureMonthlyCents: 1, platformFeeMonthlyCents: 1, problems: [] })),
      constructEvent: vi.fn(() => {
        if (!createdCheckout) throw new Error("Checkout was not created.");
        return { id: "evt_underpaid", type: "checkout.session.completed", checkout: { sessionId: "cs_underpaid", customerId: "cus_safe", paymentStatus: "paid", subscriptionId: "sub_underpaid", metadata: { userId: user.id, installationId: installation.id, planId: installation.plan, capacityHoldId: createdCheckout.capacityHoldId, infrastructureMonthlyCents: "500", platformFeeMonthlyCents: "200" } } };
      }),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    await service.checkout(user, installation, quote, "checkout-underpaid-key-1234");
    await expect(service.webhook(Buffer.from("signed"), "signature")).rejects.toThrow(/line items did not exactly match/);
    expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("planned");
    expect(await repository.listSubscriptions()).toEqual([]);
  });

  it("rejects a paid event whose Stripe customer or Session does not own the exact hold", async () => {
    const { repository, user, installation, quote } = await fixture();
    let createdCheckout: Parameters<BillingGateway["createCheckout"]>[0] | undefined;
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_owned"),
      createCheckout: vi.fn(async (input) => { createdCheckout = input; return { id: "cs_owned", url: "https://checkout.stripe.test/owned", expiresAt: input.expiresAt }; }),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => ({ id: "sub_wrong_owner", status: "active", userId: user.id, installationId: installation.id, capacityHoldId: createdCheckout?.capacityHoldId, customerId: "cus_attacker", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] })),
      constructEvent: vi.fn(() => {
        if (!createdCheckout) throw new Error("Checkout was not created.");
        return { id: "evt_wrong_owner", type: "checkout.session.completed", checkout: { sessionId: "cs_attacker", customerId: "cus_attacker", paymentStatus: "paid", subscriptionId: "sub_wrong_owner", metadata: { userId: user.id, installationId: installation.id, planId: installation.plan, capacityHoldId: createdCheckout.capacityHoldId, infrastructureMonthlyCents: "500", platformFeeMonthlyCents: "200" } } };
      }),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    await service.checkout(user, installation, quote, "checkout-wrong-owner-key-1234");

    await expect(service.webhook(Buffer.from("signed"), "signature")).rejects.toThrow(/exact owned capacity hold and Stripe session/);
    expect((await repository.getCheckoutCapacityHold(createdCheckout!.capacityHoldId))?.state).toBe("active");
    expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("planned");
    expect(await repository.listSubscriptions()).toEqual([]);
  });

  it("derives suite entitlement from the highest active paid server", async () => {
    const { repository, user, installation } = await fixture();
    await repository.upgrade(user.id, installation.id, "fleet");
    await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: "sub_fleet", status: "active", infrastructureMonthlyCents: 1, platformFeeMonthlyCents: 1 });
    const scale = await repository.createInstallation({ userId: user.id, appIds: [], name: "Scale", plan: "scale", state: "live", hostname: "scale.apps.example.com", customDomains: [] });
    await repository.recordSubscription({ userId: user.id, installationId: scale.id, providerSubscriptionId: "sub_scale", status: "active", infrastructureMonthlyCents: 1, platformFeeMonthlyCents: 1 });
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("fleet");
    await repository.updateSubscriptionStatus("sub_fleet", "canceled");
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("scale");
    await repository.updateSubscriptionStatus("sub_scale", "past_due");
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("none");
  });
});
