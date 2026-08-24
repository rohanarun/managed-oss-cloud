import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "../src/server/repository";
import { normalizeStripeSubscription, parseReconciliationMode, reconcileSubscriptions, type ProviderSubscriptionSnapshot, type SubscriptionSource } from "../src/server/subscription-reconciliation";

async function fixture(plan: "starter" | "scale" | "fleet" = "fleet") {
  const repository = new MemoryRepository();
  const user = await repository.createUser({ email: "reconcile@example.com", displayName: "Reconcile Owner", passwordHash: "unused" });
  const installation = await repository.createInstallation({ userId: user.id, appIds: [], name: "Reconcile", plan, state: "live", hostname: "reconcile.apps.example.com", customDomains: [] });
  return { repository, user, installation };
}

const source = (subscriptions: ProviderSubscriptionSnapshot[]): SubscriptionSource => ({ listAllSubscriptions: vi.fn(async () => subscriptions) });

describe("Stripe subscription reconciliation", () => {
  it("is read-only by default while reporting provider-missing entitlement revocation", async () => {
    const { repository, user, installation } = await fixture();
    await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: "sub_stale_synthetic", status: "active", infrastructureMonthlyCents: 17_857, platformFeeMonthlyCents: 2_143 });
    const apply = vi.spyOn(repository, "applySubscriptionReconciliation");
    const report = await reconcileSubscriptions({ repository, source: source([]), now: () => new Date("2026-08-24T00:00:00.000Z") });
    expect(report).toMatchObject({ mode: "dry-run", providerSubscriptionCount: 0, storedSubscriptionCount: 1, summary: { deactivateProviderMissing: 1, affectedOwners: 1 }, entitlements: [{ userId: user.id, before: "fleet", after: "none", suiteWorkspaceUpdated: false }] });
    expect(report.actions[0]).toMatchObject({ providerSubscriptionId: "sub_stale_synthetic", action: "deactivate_provider_missing", status: "inactive" });
    expect(apply).not.toHaveBeenCalled();
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("fleet");
  });

  it("applies stale deactivation and entitlement recomputation only when explicitly requested", async () => {
    const { repository, user, installation } = await fixture();
    await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: "sub_missing", status: "active", infrastructureMonthlyCents: 17_857, platformFeeMonthlyCents: 2_143 });
    const report = await reconcileSubscriptions({ repository, source: source([]), apply: true });
    expect(report.mode).toBe("apply");
    expect((await repository.listSubscriptions())[0].status).toBe("inactive");
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("none");
  });

  it("imports ownership-verified Stripe state and normalized monthly pricing", async () => {
    const { repository, user, installation } = await fixture("scale");
    const provider: ProviderSubscriptionSnapshot = { id: "sub_provider", status: "trialing", userId: user.id, installationId: installation.id, infrastructureMonthlyCents: 4_464, platformFeeMonthlyCents: 536, problems: [] };
    const report = await reconcileSubscriptions({ repository, source: source([provider]), apply: true });
    expect(report.summary.upsertProvider).toBe(1);
    expect(await repository.listSubscriptions()).toEqual([expect.objectContaining({ providerSubscriptionId: "sub_provider", status: "trialing", infrastructureMonthlyCents: 4_464, platformFeeMonthlyCents: 536 })]);
    expect(report.entitlements).toEqual([{ userId: user.id, before: "none", after: "scale", suiteWorkspaceUpdated: false }]);
  });

  it("skips invalid or ownership-mismatched provider rows", async () => {
    const { repository, user, installation } = await fixture();
    const invalid: ProviderSubscriptionSnapshot = { id: "sub_invalid", status: "active", userId: user.id, installationId: installation.id, infrastructureMonthlyCents: 0, platformFeeMonthlyCents: 0, problems: ["missing_managed_price_items"] };
    const mismatch: ProviderSubscriptionSnapshot = { id: "sub_mismatch", status: "active", userId: "99999999-9999-4999-8999-999999999999", installationId: installation.id, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] };
    const report = await reconcileSubscriptions({ repository, source: source([invalid, mismatch]), apply: true });
    expect(report.summary).toMatchObject({ skippedInvalidProvider: 1, skippedOwnershipMismatch: 1, upsertProvider: 0 });
    expect(await repository.listSubscriptions()).toEqual([]);
  });

  it("revokes or skips structurally valid subscriptions whose exact plan amount is wrong", async () => {
    const { repository, user, installation } = await fixture("starter");
    await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: "sub_underpriced_reconcile", status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
    const provider: ProviderSubscriptionSnapshot = { id: "sub_underpriced_reconcile", status: "active", userId: user.id, installationId: installation.id, infrastructureMonthlyCents: 1, platformFeeMonthlyCents: 1, problems: [] };
    const report = await reconcileSubscriptions({ repository, source: source([provider]), apply: true });
    expect(report.actions).toEqual([expect.objectContaining({ action: "deactivate_invalid_provider", problems: expect.arrayContaining(["infrastructure_price_mismatch", "platform_fee_price_mismatch", "stored_entitlement_revoked"]) })]);
    expect((await repository.listSubscriptions())[0].status).toBe("inactive");
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("none");
  });

  it("normalizes expanded managed Stripe prices without retaining provider objects", () => {
    const subscription = {
      id: "sub_normalized",
      status: "active",
      metadata: { userId: "11111111-1111-4111-8111-111111111111", installationId: "22222222-2222-4222-8222-222222222222" },
      items: { data: [
        { quantity: 1, price: { currency: "usd", unit_amount: 500, recurring: { interval: "month", interval_count: 1 }, product: { id: "prod_infra", deleted: false, metadata: { billingComponent: "infrastructure" } } } },
        { quantity: 1, price: { currency: "usd", unit_amount: 200, recurring: { interval: "month", interval_count: 1 }, product: { id: "prod_fee", deleted: false, metadata: { billingComponent: "platform-fee" } } } },
      ] },
    } as unknown as Stripe.Subscription;
    expect(normalizeStripeSubscription(subscription)).toEqual({ id: "sub_normalized", status: "active", userId: subscription.metadata.userId, installationId: subscription.metadata.installationId, infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200, problems: [] });
  });

  it("rejects missing, duplicate, zero-priced, and multi-quantity managed components", () => {
    const base = {
      id: "sub_invalid_lines",
      status: "active",
      metadata: { userId: "11111111-1111-4111-8111-111111111111", installationId: "22222222-2222-4222-8222-222222222222" },
    };
    const item = (component: string, amount: number, quantity = 1) => ({ quantity, price: { currency: "usd", unit_amount: amount, recurring: { interval: "month", interval_count: 1 }, product: { id: `prod_${component}_${amount}`, deleted: false, metadata: { billingComponent: component } } } });
    const missing = normalizeStripeSubscription({ ...base, items: { data: [item("infrastructure", 500)] } } as unknown as Stripe.Subscription);
    expect(missing.problems).toEqual(expect.arrayContaining(["missing_platform-fee_price", "unexpected_price_item_count"]));
    const duplicate = normalizeStripeSubscription({ ...base, items: { data: [item("infrastructure", 500), item("infrastructure", 1), item("platform-fee", 200)] } } as unknown as Stripe.Subscription);
    expect(duplicate.problems).toEqual(expect.arrayContaining(["duplicate_infrastructure_price", "unexpected_price_item_count"]));
    expect(normalizeStripeSubscription({ ...base, items: { data: [item("infrastructure", 0), item("platform-fee", 200)] } } as unknown as Stripe.Subscription).problems).toContain("invalid_infrastructure_price");
    expect(normalizeStripeSubscription({ ...base, items: { data: [item("infrastructure", 500, 2), item("platform-fee", 200)] } } as unknown as Stripe.Subscription).problems).toContain("invalid_infrastructure_price");
  });

  it("requires the exact apply flag", () => {
    expect(parseReconciliationMode([])).toBe("dry-run");
    expect(parseReconciliationMode(["--apply"])).toBe("apply");
    expect(() => parseReconciliationMode(["--apply=true"])).toThrow(/Usage/);
    expect(() => parseReconciliationMode(["--apply", "--apply"])).toThrow(/only once/);
  });
});
