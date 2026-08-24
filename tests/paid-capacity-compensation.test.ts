import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import type { PaidCheckoutCapacityRecovery } from "../src/server/repository";
import { StripeSubscriptionSource } from "../src/server/subscription-reconciliation";

const recovery: PaidCheckoutCapacityRecovery = {
  id: "11111111-1111-4111-8111-111111111111",
  stripeEventId: "evt_compensate",
  checkoutHoldId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  installationId: "44444444-4444-4444-8444-444444444444",
  stripeCheckoutSessionId: "cs_compensate",
  stripeCustomerId: "cus_compensate",
  providerSubscriptionId: "sub_compensate",
  infrastructureMonthlyCents: 500,
  platformFeeMonthlyCents: 200,
  state: "compensation_required",
  attemptCount: 2,
  compensationDeadlineAt: "2026-08-24T12:00:00.000Z",
  compensationAction: "cancel_subscription_and_refund_captured_payment",
  compensationRequiredAt: "2026-08-24T12:00:00.000Z",
  createdAt: "2026-08-24T11:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

describe("Stripe paid-capacity compensation", () => {
  it("cancels and refunds the exact checkout invoice idempotently, then returns provider references", async () => {
    let subscriptionStatus = "active";
    const refunds: Array<Record<string, unknown>> = [];
    const subscription = () => ({
      id: recovery.providerSubscriptionId,
      status: subscriptionStatus,
      customer: recovery.stripeCustomerId,
      metadata: { userId: recovery.userId, installationId: recovery.installationId, capacityHoldId: recovery.checkoutHoldId },
      items: { data: [
        { quantity: 1, price: { currency: "usd", unit_amount: 500, recurring: { interval: "month", interval_count: 1 }, product: { id: "prod_infrastructure", deleted: false, metadata: { billingComponent: "infrastructure" } } } },
        { quantity: 1, price: { currency: "usd", unit_amount: 200, recurring: { interval: "month", interval_count: 1 }, product: { id: "prod_platform", deleted: false, metadata: { billingComponent: "platform-fee" } } } },
      ] },
    });
    const cancel = vi.fn(async () => { subscriptionStatus = "canceled"; return subscription(); });
    const createRefund = vi.fn(async (params: Record<string, unknown>) => {
      const refund = { id: "re_compensate", status: "succeeded", amount: params.amount, payment_intent: params.payment_intent, charge: null, metadata: params.metadata };
      refunds.push(refund);
      return refund;
    });
    const fakeStripe = {
      subscriptions: { retrieve: vi.fn(async () => subscription()), cancel },
      checkout: { sessions: { retrieve: vi.fn(async () => ({ id: recovery.stripeCheckoutSessionId, mode: "subscription", payment_status: "paid", subscription: recovery.providerSubscriptionId, customer: recovery.stripeCustomerId, invoice: "in_compensate" })) } },
      invoices: { retrieve: vi.fn(async () => ({ id: "in_compensate", status: "paid", currency: "usd", customer: recovery.stripeCustomerId, amount_paid: 700, parent: { subscription_details: { subscription: recovery.providerSubscriptionId } }, payments: { data: [{ id: "inpay_compensate", status: "paid", amount_paid: 700, payment: { type: "payment_intent", payment_intent: "pi_compensate" } }] } })) },
      refunds: { list: vi.fn(async () => ({ data: refunds, has_more: false })), create: createRefund },
    } as unknown as Stripe;
    const gateway = new StripeSubscriptionSource(fakeStripe);

    const first = await gateway.compensatePaidCapacity(recovery);
    const replay = await gateway.compensatePaidCapacity(recovery);

    expect(first).toEqual({ status: "confirmed", reference: "stripe:subscription=sub_compensate;invoice=in_compensate;refunds=re_compensate" });
    expect(replay).toEqual(first);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(recovery.providerSubscriptionId, expect.objectContaining({ invoice_now: false, prorate: false }), { idempotencyKey: `paid-capacity-cancel:${recovery.id}` });
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(createRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: 700, payment_intent: "pi_compensate", metadata: expect.objectContaining({ managedOssPaidCapacityRecoveryId: recovery.id }) }), { idempotencyKey: `paid-capacity-refund:${recovery.id}:inpay_compensate:0` });
  });
});
