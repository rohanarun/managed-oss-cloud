import { describe, expect, it, vi } from "vitest";
import { BillingService, type BillingGateway } from "../src/server/billing";
import { MemoryRepository } from "../src/server/repository";
import { reconcileSubscriptions } from "../src/server/subscription-reconciliation";
import type { ComputePlan, Quote } from "../src/shared/types";

const starterQuote: Quote = {
  selectedApps: [], requestedMemoryMb: 384, requestedCpuMillis: 250, requestedStorageGb: 3, reservedMemoryMb: 192,
  compatibleWithBundle: true,
  recommendedPlan: { id: "starter", label: "Starter", memoryMb: 1536, cpu: 0.5, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 },
  infrastructureMonthlyCents: 500, platformFeeCents: 200, totalMonthlyCents: 700, requiresSplit: false, explanation: "fits",
};

async function plannedFixture() {
  const repository = new MemoryRepository();
  const user = await repository.createUser({ email: "capacity-atomicity@example.com", displayName: "Capacity Atomicity", passwordHash: "unused" });
  const installation = await repository.createInstallation({ userId: user.id, appIds: ["uptime-kuma"], name: "Atomic capacity", plan: "starter", state: "planned", hostname: "atomic.apps.example.com", customDomains: [] });
  const [application] = await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
  const workerId = `atomic-worker-${user.id.slice(0, 8)}`;
  await repository.registerWorkerNode({ id: workerId, name: "Atomic worker", privateAddress: "10.70.0.81", machineType: "e2-standard-2", capacityMemoryMb: 8192, capacityCpuMillis: 2000, capacityStorageGb: 100, systemReserveMemoryMb: 512 });
  return { repository, user, installation: (await repository.getInstallation(user.id, installation.id))!, application, workerId };
}

async function paidFixture() {
  const fixture = await plannedFixture();
  const { repository, user, installation, application } = fixture;
  const hold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: `initial-paid-${user.id}`, requestedPlan: "starter", requestedAppIds: installation.appIds, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: application.memoryReservationMb, cpuReservationMillis: application.cpuReservationMillis, storageReservationGb: application.storageReservationGb }] });
  await repository.getOrCreateStripeCustomer(user.id, async () => "cus_atomicity");
  await repository.attachCheckoutSession({ holdId: hold!.id, userId: user.id, stripeCustomerId: "cus_atomicity", stripeCheckoutSessionId: "cs_atomicity", stripeCheckoutExpiresAt: new Date(Date.now() + 35 * 60_000).toISOString() });
  await repository.processPaidCheckout({ eventId: "evt_atomicity_initial", eventType: "checkout.session.completed", holdId: hold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: "cs_atomicity", stripeCustomerId: "cus_atomicity", providerSubscriptionId: "sub_atomicity", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
  return fixture;
}

describe("billing and capacity atomicity", () => {
  it("accepts a signed paid webhook after hold expiry, persists pending capacity, and recovers through reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      const { repository, user, installation, workerId } = await plannedFixture();
      let checkoutInput: Parameters<BillingGateway["createCheckout"]>[0] | undefined;
      const provider = () => ({ id: "sub_late_paid", status: "active", userId: user.id, installationId: installation.id, capacityHoldId: checkoutInput!.capacityHoldId, customerId: "cus_late_paid", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] });
      const gateway: BillingGateway = {
        createCustomer: vi.fn(async () => "cus_late_paid"),
        createCheckout: vi.fn(async (input) => { checkoutInput = input; return { id: "cs_late_paid", url: "https://checkout.stripe.test/late", expiresAt: input.expiresAt }; }),
        updateSubscription: vi.fn(async () => undefined),
        retrieveSubscription: vi.fn(async () => provider()),
        constructEvent: vi.fn(() => ({ id: "evt_late_paid", type: "checkout.session.completed", checkout: { sessionId: "cs_late_paid", customerId: "cus_late_paid", paymentStatus: "paid", subscriptionId: "sub_late_paid", metadata: { userId: user.id, installationId: installation.id, planId: "starter", capacityHoldId: checkoutInput!.capacityHoldId, infrastructureMonthlyCents: "500", platformFeeMonthlyCents: "200" } } })),
      };
      const billing = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_late", publishableKey: "pk_late" });
      await billing.checkout(user, installation, starterQuote, "late-paid-checkout-0001");
      vi.advanceTimersByTime(61 * 60_000);
      const result = await billing.webhook(Buffer.from("signed"), "valid-signature");
      expect(result).toMatchObject({ duplicate: false, queued: false, paidPendingCapacity: true, compensationAction: "cancel_subscription_and_refund_captured_payment" });
      expect((await repository.listSubscriptions())[0].status).toBe("paid_pending_capacity");
      expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("planned");

      const invalidProvider = { ...provider(), problems: ["temporary_provider_shape_problem"] };
      const invalidReport = await reconcileSubscriptions({ repository, source: { listAllSubscriptions: async () => [invalidProvider] }, apply: true });
      expect(invalidReport.summary).toMatchObject({ paidCapacityPending: 1, deactivateInvalidProvider: 0, upsertProvider: 0 });
      expect((await repository.listSubscriptions())[0].status).toBe("paid_pending_capacity");
      const missingReport = await reconcileSubscriptions({ repository, source: { listAllSubscriptions: async () => [] }, apply: true });
      expect(missingReport.summary).toMatchObject({ paidCapacityPending: 1, deactivateProviderMissing: 0, upsertProvider: 0 });
      expect((await repository.listSubscriptions())[0].status).toBe("paid_pending_capacity");

      await repository.setWorkerNodeMode(workerId, "active");
      await repository.heartbeatWorkerNode(workerId, { privateAddress: "10.70.0.81", capacityMemoryMb: 8192, capacityCpuMillis: 2000, capacityStorageGb: 100 });
      const report = await reconcileSubscriptions({ repository, source: { listAllSubscriptions: async () => [provider()] }, apply: true });
      expect(report.summary.paidCapacityPending).toBe(0);
      expect(await repository.getPaidCheckoutCapacityRecovery("sub_late_paid")).toMatchObject({ state: "fulfilled", attemptCount: 2 });
      expect((await repository.listSubscriptions())[0].status).toBe("active");
      expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("provisioning");
    } finally { vi.useRealTimers(); }
  });

  it("turns an unrecoverable paid placement into an explicit cancel-and-refund obligation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      const { repository, user, installation, application, workerId } = await plannedFixture();
      const hold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: "compensation-checkout-0001", requestedPlan: "starter", requestedAppIds: installation.appIds, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(), planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }] });
      await repository.getOrCreateStripeCustomer(user.id, async () => "cus_compensation");
      await repository.attachCheckoutSession({ holdId: hold!.id, userId: user.id, stripeCustomerId: "cus_compensation", stripeCheckoutSessionId: "cs_compensation", stripeCheckoutExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      vi.advanceTimersByTime(3 * 60_000);
      await repository.processPaidCheckout({ eventId: "evt_compensation", eventType: "checkout.session.completed", holdId: hold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: "cs_compensation", stripeCustomerId: "cus_compensation", providerSubscriptionId: "sub_compensation", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, compensationDeadlineAt: new Date(Date.now() + 5 * 60_000).toISOString() });
      vi.advanceTimersByTime(6 * 60_000);
      const report = await reconcileSubscriptions({ repository, source: { listAllSubscriptions: async () => [] }, apply: true });
      expect(report.summary).toMatchObject({ paidCapacityCompensationRequired: 1, deactivateProviderMissing: 0 });
      expect(await repository.getPaidCheckoutCapacityRecovery("sub_compensation")).toMatchObject({ state: "compensation_required", compensationAction: "cancel_subscription_and_refund_captured_payment" });
      expect((await repository.listSubscriptions())[0].status).toBe("compensation_required");
      const compensatePaidCapacity = vi.fn(async () => ({ status: "confirmed" as const, reference: "stripe:subscription=sub_compensation;invoice=in_compensation;refunds=re_compensation" }));
      const settled = await reconcileSubscriptions({ repository, source: { listAllSubscriptions: async () => [] }, compensation: { compensatePaidCapacity }, apply: true });
      expect(compensatePaidCapacity).toHaveBeenCalledWith(expect.objectContaining({ state: "compensation_required", providerSubscriptionId: "sub_compensation" }));
      expect(settled.summary).toMatchObject({ paidCapacityCompensationRequired: 0, deactivateProviderMissing: 0, unchanged: 1 });
      expect(await repository.getPaidCheckoutCapacityRecovery("sub_compensation")).toMatchObject({ state: "compensated", compensationReference: "stripe:subscription=sub_compensation;invoice=in_compensation;refunds=re_compensation" });
      expect((await repository.listSubscriptions())[0].status).toBe("canceled");

      await repository.heartbeatWorkerNode(workerId, { privateAddress: "10.70.0.81", capacityMemoryMb: 8192, capacityCpuMillis: 2000, capacityStorageGb: 100 });
      const nextHold = await repository.acquireCheckoutCapacityHold({ userId: user.id, installationId: installation.id, idempotencyKey: "compensation-checkout-retry-0002", requestedPlan: "starter", requestedAppIds: installation.appIds, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(), planCapacity: { planId: "starter", memoryMb: 1536, cpuMillis: 500, storageGb: 10, maxServices: 2 }, reservations: [{ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }] });
      await repository.attachCheckoutSession({ holdId: nextHold!.id, userId: user.id, stripeCustomerId: "cus_compensation", stripeCheckoutSessionId: "cs_compensation_retry", stripeCheckoutExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      await repository.setWorkerNodeMode(workerId, "draining");
      vi.advanceTimersByTime(3 * 60_000);
      await repository.processPaidCheckout({ eventId: "evt_compensation_retry", eventType: "checkout.session.completed", holdId: nextHold!.id, userId: user.id, installationId: installation.id, stripeCheckoutSessionId: "cs_compensation_retry", stripeCustomerId: "cus_compensation", providerSubscriptionId: "sub_compensation_retry", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, compensationDeadlineAt: new Date(Date.now() + 5 * 60_000).toISOString() });
      expect(await repository.getPaidCheckoutCapacityRecovery("sub_compensation_retry")).toMatchObject({ state: "pending_capacity", installationId: installation.id });
    } finally { vi.useRealTimers(); }
  });

  it.each(["signed webhook", "scheduled reconciler"])("converges provider-new/local-old upgrades when the %s wins the race", async (winner) => {
    const { repository, user, installation } = await paidFixture();
    const scale: ComputePlan = { id: "scale", label: "Scale", memoryMb: 6144, cpu: 2, storageGb: 100, maxServices: 12, infrastructureMonthlyCents: 4464, monthlyCents: 5000 };
    let capacityChangeHoldId = "";
    let billing: BillingService;
    const provider = () => ({ id: "sub_atomicity", status: "active", userId: user.id, installationId: installation.id, capacityChangeHoldId, planId: "scale", infrastructureMonthlyCents: 4464, platformFeeMonthlyCents: 536, problems: [] });
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_unused"), createCheckout: vi.fn(async () => ({ id: "cs_unused", url: null })),
      updateSubscription: vi.fn(async (input) => {
        capacityChangeHoldId = input.capacityChangeHoldId;
        if (winner === "signed webhook") await billing.webhook(Buffer.from("signed"), "valid-signature");
        else await reconcileSubscriptions({ repository, source: { listAllSubscriptions: async () => [provider()] }, apply: true });
      }),
      retrieveSubscription: vi.fn(async () => provider()),
      constructEvent: vi.fn(() => ({ id: `evt_resize_${winner.replaceAll(" ", "_")}`, type: "customer.subscription.updated", subscription: { id: "sub_atomicity", status: "active", userId: user.id, installationId: installation.id } })),
    };
    billing = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_resize", publishableKey: "pk_resize" });
    await expect(billing.upgrade(user, installation, scale, 536, 192)).resolves.toMatchObject({ planId: "scale", generation: 2, state: "active" });
    expect(await repository.getInstallation(user.id, installation.id)).toMatchObject({ plan: "scale" });
    expect((await repository.listSubscriptions())[0]).toMatchObject({ status: "active", infrastructureMonthlyCents: 4464, platformFeeMonthlyCents: 536, installationPlan: "scale" });
    expect(await repository.getPlanCapacityChangeHold(capacityChangeHoldId)).toMatchObject({ state: "consumed", providerConfirmationSource: winner === "signed webhook" ? "signed_subscription_webhook" : "scheduled_subscription_reconciliation" });
  });

  it("creates a clone, appIds mutation, and install job once for concurrent idempotent requests", async () => {
    const { repository, user, installation, application } = await paidFixture();
    await repository.updateApplicationState(application.id, "live", new Date().toISOString());
    await repository.updateInstallationState(installation.id, "live");
    const input = { userId: user.id, installationId: installation.id, idempotencyKey: "clone-atomicity-request-0001", app: { appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }, hostnameBase: "apps.example.com", memorySafetyReserveMb: 192 };
    const [first, replay] = await Promise.all([repository.createApplicationClone(input), repository.createApplicationClone(input)]);
    expect(new Set([first.application.id, replay.application.id]).size).toBe(1);
    expect(first.job?.id ?? replay.job?.id).toBeTruthy();
    expect(first.job?.id).toBe(replay.job?.id);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    const refreshed = await repository.getInstallation(user.id, installation.id);
    expect(refreshed?.applications).toHaveLength(2);
    expect(refreshed?.appIds).toEqual(["uptime-kuma", "uptime-kuma"]);
    await expect(repository.createApplicationClone({ ...input, app: { ...input.app, appId: "listmonk" } })).rejects.toThrow(/different request/);
  });
});
