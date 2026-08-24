import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { BillingGateway } from "../src/server/billing";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";

describe("Suite-only plan checkout API", () => {
  it("creates and quotes zero-app Starter, Scale, and Fleet workspaces before secure checkout", async () => {
    const repository = new MemoryRepository();
    await repository.registerWorkerNode({
      id: "suite-only-worker",
      name: "Suite-only worker",
      privateAddress: "10.70.0.81",
      machineType: "e2-standard-2",
      capacityMemoryMb: 8_192,
      capacityCpuMillis: 4_000,
      capacityStorageGb: 200,
      systemReserveMemoryMb: 512,
    });
    const checkoutInputs: Array<Parameters<BillingGateway["createCheckout"]>[0]> = [];
    const gateway: BillingGateway = {
      createCustomer: vi.fn(async () => "cus_suite_only"),
      createCheckout: vi.fn(async (input) => {
        checkoutInputs.push(input);
        return { id: `cs_${input.planId}`, url: `https://checkout.stripe.test/${input.planId}`, expiresAt: input.expiresAt };
      }),
      expireCheckout: vi.fn(async () => undefined),
      updateSubscription: vi.fn(async () => undefined),
      retrieveSubscription: vi.fn(async () => ({ id: "sub_unused", status: "active", infrastructureMonthlyCents: 0, platformFeeMonthlyCents: 0, problems: [] })),
      constructEvent: vi.fn(() => ({ id: "evt_unused", type: "ignored" })),
    };
    const app = await createApp({
      repository,
      suiteStore: new MemorySuiteStore(),
      billingGateway: gateway,
      billingSettings: { mode: "live", webhookSecret: "whsec_suite", publishableKey: "pk_suite" },
      provisioningReadyForBilling: true,
      synchronizeSuiteEntitlements: false,
    });
    const agent = request.agent(app);
    expect((await agent.post("/api/auth/signup").send({ displayName: "Suite Owner", email: "suite-only@example.com", password: "long-safe-password" })).status).toBe(201);

    expect((await agent.post("/api/installations").send({ name: "Missing plan", appIds: [] })).status).toBe(400);
    expect((await agent.post("/api/installations").send({ name: "Unknown plan", appIds: [], plan: "unlimited" })).status).toBe(400);

    const expectations = [
      { id: "starter", total: 700, infrastructure: 500, fee: 200 },
      { id: "scale", total: 5_000, infrastructure: 4_464, fee: 536 },
      { id: "fleet", total: 20_000, infrastructure: 17_857, fee: 2_143 },
    ];
    for (const plan of expectations) {
      const created = await agent.post("/api/installations").send({ name: `${plan.id} suite`, appIds: [], plan: plan.id });
      expect(created.status).toBe(201);
      expect(created.body.installation).toMatchObject({ plan: plan.id, appIds: [], applications: [] });
      expect(created.body.quote).toMatchObject({ selectedApps: [], totalMonthlyCents: plan.total, infrastructureMonthlyCents: plan.infrastructure, platformFeeCents: plan.fee, recommendedPlan: { id: plan.id } });

      const checkout = await agent.post("/api/billing/checkout")
        .set("Idempotency-Key", `checkout:${plan.id}:suite-only-0001`)
        .send({ installationId: created.body.installation.id });
      expect(checkout.status).toBe(200);
      expect(checkout.body.url).toBe(`https://checkout.stripe.test/${plan.id}`);
    }

    expect(checkoutInputs.map((input) => ({ planId: input.planId, installationName: input.installationName, infrastructureMonthlyCents: input.infrastructureMonthlyCents, platformFeeMonthlyCents: input.platformFeeMonthlyCents }))).toEqual(expectations.map((plan) => ({ planId: plan.id, installationName: `${plan.id} suite`, infrastructureMonthlyCents: plan.infrastructure, platformFeeMonthlyCents: plan.fee })));
    expect(checkoutInputs.every((input) => input.infrastructureMonthlyCents + input.platformFeeMonthlyCents === expectations.find((plan) => plan.id === input.planId)!.total)).toBe(true);
  });
});
