import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { BillingService, type BillingEvent, type BillingGateway } from "../src/server/billing";
import { MemoryRepository } from "../src/server/repository";
import { reconcileSubscriptions, type ProviderSubscriptionSnapshot, type SubscriptionSource } from "../src/server/subscription-reconciliation";
import { MemorySuiteStore } from "../src/server/suite-store";

function gatewayFor(event: BillingEvent): BillingGateway {
  return {
    createCustomer: async () => "cus_entitlement_regression",
    createCheckout: async () => ({ id: "cs_entitlement_regression", url: null }),
    updateSubscription: async () => undefined,
    retrieveSubscription: async (providerSubscriptionId) => ({ id: providerSubscriptionId, status: "active", userId: event.checkout?.metadata.userId, installationId: event.checkout?.metadata.installationId, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] }),
    constructEvent: () => event,
  };
}

function billing(repository: MemoryRepository, event: BillingEvent) {
  return new BillingService(repository, gatewayFor(event), {
    mode: "live",
    webhookSecret: "whsec_entitlement_regression",
    publishableKey: "pk_entitlement_regression",
  });
}

async function paidFixture(email: string, plan: "starter" | "scale" | "fleet" = "fleet") {
  const repository = new MemoryRepository();
  const user = await repository.createUser({ email, displayName: "Entitlement Owner", passwordHash: "unused" });
  const installation = await repository.createInstallation({
    userId: user.id,
    appIds: [],
    name: "Entitlement regression",
    plan,
    state: "live",
    hostname: `${user.id.slice(0, 8)}.apps.example.com`,
    customDomains: [],
  });
  const providerSubscriptionId = `sub_${user.id.replaceAll("-", "").slice(0, 20)}`;
  await repository.recordSubscription({
    userId: user.id,
    installationId: installation.id,
    providerSubscriptionId,
    status: "active",
    infrastructureMonthlyCents: 17_857,
    platformFeeMonthlyCents: 2_143,
  });
  return { repository, user, installation, providerSubscriptionId };
}

describe("hosted entitlement fail-closed regressions", () => {
  it("uses stored ownership to revoke a canceled subscription whose Stripe event lost metadata", async () => {
    const { repository, user, installation, providerSubscriptionId } = await paidFixture("missing-metadata@example.com");
    const service = billing(repository, {
      id: "evt_cancel_missing_metadata",
      type: "customer.subscription.deleted",
      subscription: { id: providerSubscriptionId, status: "canceled" },
    });

    const result = await service.webhook(Buffer.from("signed"), "signature");

    expect(result).toMatchObject({
      subscriptionChanged: true,
      status: "canceled",
      userId: user.id,
      installationId: installation.id,
      entitlementActive: false,
    });
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("none");
    expect(await repository.getActiveSubscription(user.id, installation.id)).toBeUndefined();
  });

  it("fails closed instead of transferring an active subscription when event ownership metadata mismatches", async () => {
    const { repository, user: owner, installation, providerSubscriptionId } = await paidFixture("stored-owner@example.com");
    const other = await repository.createUser({ email: "mismatched-owner@example.com", displayName: "Other Owner", passwordHash: "unused" });
    const otherInstallation = await repository.createInstallation({
      userId: other.id,
      appIds: [],
      name: "Other installation",
      plan: "fleet",
      state: "live",
      hostname: "other-owner.apps.example.com",
      customDomains: [],
    });
    const service = billing(repository, {
      id: "evt_active_wrong_owner",
      type: "customer.subscription.updated",
      subscription: { id: providerSubscriptionId, status: "active", userId: other.id, installationId: otherInstallation.id },
    });

    await service.webhook(Buffer.from("signed"), "signature").catch(() => undefined);

    const stored = (await repository.listSubscriptions()).find((item) => item.providerSubscriptionId === providerSubscriptionId);
    expect(stored?.userId).toBe(owner.id);
    expect(stored?.installationId).toBe(installation.id);
    expect(["active", "trialing"]).not.toContain(stored?.status);
    expect(await repository.getEffectiveSuitePlan(owner.id)).toBe("none");
    expect(await repository.getEffectiveSuitePlan(other.id)).toBe("none");
  });

  it("revokes an active stored entitlement when the matching provider row is invalid", async () => {
    const { repository, user, providerSubscriptionId } = await paidFixture("invalid-provider@example.com");
    const provider: ProviderSubscriptionSnapshot = {
      id: providerSubscriptionId,
      status: "active",
      infrastructureMonthlyCents: 0,
      platformFeeMonthlyCents: 0,
      problems: ["missing_user_metadata", "missing_installation_metadata", "missing_managed_price_items"],
    };
    const source: SubscriptionSource = { listAllSubscriptions: async () => [provider] };

    const report = await reconcileSubscriptions({ repository, source, apply: true });

    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("none");
    expect((await repository.listSubscriptions()).find((item) => item.providerSubscriptionId === providerSubscriptionId)?.status).not.toMatch(/^(active|trialing)$/);
    expect(report.entitlements).toContainEqual(expect.objectContaining({ userId: user.id, after: "none" }));
  });

  it("fails queued AI work that is no longer entitled before a worker can claim it", async () => {
    const store = new MemorySuiteStore("fleet");
    const downgradedUser = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const canceledUser = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    await store.enableModule(downgradedUser, "operations");
    const premiumAction = await store.queueAiAction(downgradedUser, { moduleId: "operations", goal: "Prepare an operations proposal" });
    await store.setWorkspacePlan(downgradedUser, "starter");

    await store.setWorkspacePlan(canceledUser, "starter");
    await store.enableModule(canceledUser, "crm");
    const canceledAction = await store.queueAiAction(canceledUser, { moduleId: "crm", goal: "Prepare a CRM proposal" });
    await store.setWorkspacePlan(canceledUser, "none");

    expect(await store.claimAiAction()).toBeUndefined();
    for (const [userId, actionId] of [[downgradedUser, premiumAction!.id], [canceledUser, canceledAction!.id]]) {
      const action = await store.getAiAction(userId, actionId);
      expect(action).toMatchObject({ status: "failed" });
      expect(action?.attempts ?? 0).toBe(0);
    }
  });

  it("promotes an existing none workspace to Fleet in unrestricted mode and permits a custom domain", async () => {
    const repository = new MemoryRepository();
    const store = new MemorySuiteStore("none");
    const app = await createApp({ repository, suiteStore: store, suiteEntitlementMode: "unrestricted" });
    const session = request.agent(app);
    const signup = await session.post("/api/auth/signup").send({
      displayName: "Self-hosted Owner",
      email: "self-hosted-entitlement@example.com",
      password: "long-safe-password",
    });
    expect(signup.status).toBe(201);

    const workspace = await session.get("/api/suite/workspace");
    expect(workspace.status).toBe(200);
    expect(workspace.body.workspace.plan).toBe("fleet");
    expect((await session.post("/api/suite/modules/operations/enable")).status).toBe(201);
    expect((await session.post("/api/suite/domains").send({ domain: "selfhost-regression.example" })).status).toBe(201);
  });
});
