import { describe, expect, it, vi } from "vitest";
import { BillingService, type BillingGateway } from "../src/server/billing";
import { MemoryRepository } from "../src/server/repository";
import type { Quote } from "../src/shared/types";

async function fixture() {
  const repository = new MemoryRepository();
  const user = await repository.createUser({ email: "billing@example.com", displayName: "Billing Owner", passwordHash: "unused" });
  const installation = await repository.createInstallation({ userId: user.id, appIds: ["uptime-kuma"], name: "Status", plan: "starter", state: "planned", hostname: "status.apps.example.com", customDomains: [] });
  await repository.createApplicationInstances(installation.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
  const quote: Quote = { selectedApps: [], requestedMemoryMb: 448, requestedCpuMillis: 250, requestedStorageGb: 3, reservedMemoryMb: 192, compatibleWithBundle: true, recommendedPlan: { id: "starter", label: "Starter", memoryMb: 1536, cpu: .5, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 }, infrastructureMonthlyCents: 500, platformFeeCents: 200, totalMonthlyCents: 700, requiresSplit: false, explanation: "fits" };
  return { repository, user, installation, quote };
}

describe("billing safety", () => {
  it("requires the complete live billing configuration", async () => {
    const { repository, user, installation, quote } = await fixture();
    const service = new BillingService(repository, undefined, { mode: "disabled" });
    await expect(service.checkout(user, installation, quote, "checkout-safe-key-1234")).rejects.toThrow(/not enabled/);
  });

  it("creates itemized checkout and processes one signed paid event exactly once", async () => {
    const { repository, user, installation, quote } = await fixture();
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_safe"),
      createCheckout: vi.fn(async () => ({ id: "cs_safe", url: "https://checkout.stripe.test/safe" })),
      updateSubscription: vi.fn(async () => undefined),
      constructEvent: vi.fn(() => ({ id: "evt_safe", type: "checkout.session.completed", checkout: { paymentStatus: "paid", subscriptionId: "sub_safe", metadata: { userId: user.id, installationId: installation.id, infrastructureMonthlyCents: "500", platformFeeMonthlyCents: "200" } } })),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    const checkout = await service.checkout(user, installation, quote, "checkout-safe-key-1234");
    expect(checkout.url).toContain("stripe.test");
    expect(gateway.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 }));

    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: false, queued: true });
    expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("provisioning");
    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: true });
  });

  it("reconciles an active subscription before changing its paid plan", async () => {
    const { repository, user, installation } = await fixture();
    await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: "sub_upgrade", status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_safe"),
      createCheckout: vi.fn(async () => ({ id: "cs_safe", url: "https://checkout.stripe.test/safe" })),
      updateSubscription: vi.fn(async () => undefined),
      constructEvent: vi.fn(() => ({ id: "evt_unused", type: "ignored" })),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    const plan = { id: "scale", label: "Scale", memoryMb: 6144, cpu: 2, storageGb: 100, maxServices: 12, infrastructureMonthlyCents: 4464, monthlyCents: 5000 };
    await service.upgrade(user, installation, plan, 536);
    expect(gateway.updateSubscription).toHaveBeenCalledWith({ providerSubscriptionId: "sub_upgrade", installationId: installation.id, plan, platformFeeMonthlyCents: 536 });
  });
});
