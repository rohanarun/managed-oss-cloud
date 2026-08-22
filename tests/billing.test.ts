import { describe, expect, it, vi } from "vitest";
import { BillingService, type BillingGateway } from "../src/server/billing";
import { MemoryRepository } from "../src/server/repository";
import type { Quote } from "../src/shared/types";

async function fixture() {
  const repository = new MemoryRepository();
  const user = await repository.createUser({ email: "billing@example.com", displayName: "Billing Owner", passwordHash: "unused" });
  const installation = await repository.createInstallation({ userId: user.id, appIds: ["uptime-kuma"], name: "Status", plan: "micro", state: "planned", hostname: "status.apps.example.com", customDomains: [] });
  await repository.createApplicationInstances(installation.id, installation.appIds, "apps.example.com");
  const quote: Quote = { selectedApps: [], requestedMemoryMb: 448, reservedMemoryMb: 192, compatibleWithBundle: true, recommendedPlan: { id: "micro", label: "Micro", memoryMb: 1024, cpu: .25, monthlyCents: 410 }, infrastructureMonthlyCents: 410, platformFeeCents: 200, totalMonthlyCents: 610, requiresSplit: false, explanation: "fits" };
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
      constructEvent: vi.fn(() => ({ id: "evt_safe", type: "checkout.session.completed", checkout: { paymentStatus: "paid", subscriptionId: "sub_safe", metadata: { userId: user.id, installationId: installation.id, infrastructureMonthlyCents: "410", platformFeeMonthlyCents: "200" } } })),
    };
    const service = new BillingService(repository, gateway, { mode: "live", webhookSecret: "whsec_safe", publishableKey: "pk_safe" });
    const checkout = await service.checkout(user, installation, quote, "checkout-safe-key-1234");
    expect(checkout.url).toContain("stripe.test");
    expect(gateway.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ infrastructureMonthlyCents: 410, platformFeeMonthlyCents: 200 }));

    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: false, queued: true });
    expect((await repository.getInstallation(user.id, installation.id))?.state).toBe("provisioning");
    expect(await service.webhook(Buffer.from("signed"), "signature")).toEqual({ duplicate: true });
  });
});
