import Stripe from "stripe";
import type { PaidCheckoutCapacityRecovery, ReconciledSubscription, Repository, StoredSubscription } from "./repository.js";
import type { SuitePlanId } from "../shared/suite.js";
import { config } from "./config.js";

const providerStatuses = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]);
const paidPlans = new Set(["starter", "scale", "fleet"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProviderSubscriptionSnapshot {
  id: string;
  status: string;
  userId?: string;
  installationId?: string;
  capacityHoldId?: string;
  capacityChangeHoldId?: string;
  planId?: string;
  customerId?: string;
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
  problems: string[];
}

export interface SubscriptionSource {
  listAllSubscriptions(): Promise<ProviderSubscriptionSnapshot[]>;
}

export interface PaidCapacityCompensationResult {
  status: "confirmed" | "pending";
  reference: string;
}

export interface PaidCapacityCompensationProvider {
  compensatePaidCapacity(recovery: PaidCheckoutCapacityRecovery): Promise<PaidCapacityCompensationResult>;
}

export function configuredPlanPrice(planId: string) {
  const plan = config.plans.find((candidate) => candidate.id === planId);
  if (!plan) return undefined;
  return {
    infrastructureMonthlyCents: plan.infrastructureMonthlyCents,
    platformFeeMonthlyCents: Math.max(Math.ceil(plan.infrastructureMonthlyCents * (config.PLATFORM_FEE_PERCENT / 100)), config.PLATFORM_FEE_MIN_CENTS),
  };
}

function stripeObjectId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}

export class StripeSubscriptionSource implements SubscriptionSource, PaidCapacityCompensationProvider {
  private readonly stripe: Stripe;
  constructor(secretKeyOrClient: string | Stripe) { this.stripe = typeof secretKeyOrClient === "string" ? new Stripe(secretKeyOrClient) : secretKeyOrClient; }

  async listAllSubscriptions() {
    const subscriptions: ProviderSubscriptionSnapshot[] = [];
    for await (const subscription of this.stripe.subscriptions.list({ status: "all", limit: 100, expand: ["data.items.data.price.product"] })) subscriptions.push(normalizeStripeSubscription(subscription));
    return subscriptions;
  }

  async compensatePaidCapacity(recovery: PaidCheckoutCapacityRecovery): Promise<PaidCapacityCompensationResult> {
    if (recovery.state !== "compensation_required") throw new Error("Stripe compensation requires an exact compensation-required recovery.");
    const providerSubscription = await this.stripe.subscriptions.retrieve(recovery.providerSubscriptionId, { expand: ["items.data.price.product"] });
    const normalized = normalizeStripeSubscription(providerSubscription);
    if (normalized.id !== recovery.providerSubscriptionId || normalized.userId !== recovery.userId || normalized.installationId !== recovery.installationId || normalized.capacityHoldId !== recovery.checkoutHoldId || normalized.customerId !== recovery.stripeCustomerId || normalized.infrastructureMonthlyCents !== recovery.infrastructureMonthlyCents || normalized.platformFeeMonthlyCents !== recovery.platformFeeMonthlyCents || normalized.problems.length > 0) throw new Error("Stripe compensation subscription did not exactly match the durable paid-capacity obligation.");

    const session = await this.stripe.checkout.sessions.retrieve(recovery.stripeCheckoutSessionId);
    const sessionSubscriptionId = stripeObjectId(session.subscription);
    const sessionCustomerId = stripeObjectId(session.customer);
    const invoiceId = stripeObjectId(session.invoice);
    if (session.id !== recovery.stripeCheckoutSessionId || session.mode !== "subscription" || session.payment_status !== "paid" || sessionSubscriptionId !== recovery.providerSubscriptionId || sessionCustomerId !== recovery.stripeCustomerId || !invoiceId) throw new Error("Stripe compensation checkout did not exactly match the captured subscription payment.");

    const invoice = await this.stripe.invoices.retrieve(invoiceId, { expand: ["payments.data.payment.payment_intent", "payments.data.payment.charge"] });
    const invoiceCustomerId = stripeObjectId(invoice.customer);
    const invoiceSubscriptionId = stripeObjectId(invoice.parent?.subscription_details?.subscription);
    const payments = (invoice.payments?.data ?? []).filter((payment) => payment.status === "paid" && Number.isSafeInteger(payment.amount_paid) && Number(payment.amount_paid) > 0);
    const paidAmount = payments.reduce((total, payment) => total + Number(payment.amount_paid), 0);
    if (invoice.id !== invoiceId || invoice.status !== "paid" || invoice.currency !== "usd" || invoiceCustomerId !== recovery.stripeCustomerId || invoiceSubscriptionId !== recovery.providerSubscriptionId || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0 || paidAmount !== invoice.amount_paid || payments.length === 0) throw new Error("Stripe compensation invoice did not prove the exact captured subscription payment.");

    if (providerSubscription.status !== "canceled") {
      const canceled = await this.stripe.subscriptions.cancel(recovery.providerSubscriptionId, { invoice_now: false, prorate: false, cancellation_details: { comment: `Managed capacity compensation ${recovery.id}` } }, { idempotencyKey: `paid-capacity-cancel:${recovery.id}` });
      if (canceled.id !== recovery.providerSubscriptionId || canceled.status !== "canceled") throw new Error("Stripe did not confirm cancellation of the paid-capacity subscription.");
    }

    const confirmedRefundIds: string[] = [];
    const pendingRefundIds: string[] = [];
    for (const payment of payments) {
      const paymentIntentId = stripeObjectId(payment.payment.payment_intent);
      const chargeId = stripeObjectId(payment.payment.charge);
      if ((payment.payment.type === "payment_intent" && !paymentIntentId) || (payment.payment.type === "charge" && !chargeId) || !["payment_intent", "charge"].includes(payment.payment.type)) throw new Error("Stripe compensation invoice used an unsupported captured-payment shape.");
      const refundList = await this.stripe.refunds.list({ limit: 100, ...(paymentIntentId ? { payment_intent: paymentIntentId } : { charge: chargeId! }) });
      if (refundList.has_more) throw new Error("Stripe compensation found too many refunds to prove the captured-payment balance safely.");
      const related = refundList.data.filter((refund) => (paymentIntentId ? stripeObjectId(refund.payment_intent) === paymentIntentId : stripeObjectId(refund.charge) === chargeId));
      const succeeded = related.filter((refund) => refund.status === "succeeded");
      const pending = related.filter((refund) => refund.status === "pending" || refund.status === "requires_action");
      const failedManaged = related.find((refund) => ["failed", "canceled"].includes(String(refund.status)) && refund.metadata?.managedOssPaidCapacityRecoveryId === recovery.id);
      const succeededAmount = succeeded.reduce((total, refund) => total + refund.amount, 0);
      const pendingAmount = pending.reduce((total, refund) => total + refund.amount, 0);
      const targetAmount = Number(payment.amount_paid);
      if (!Number.isSafeInteger(succeededAmount) || !Number.isSafeInteger(pendingAmount) || succeededAmount > targetAmount || succeededAmount + pendingAmount > targetAmount) throw new Error("Stripe compensation refund history exceeded the exact captured payment amount.");
      confirmedRefundIds.push(...succeeded.map((refund) => refund.id));
      pendingRefundIds.push(...pending.map((refund) => refund.id));
      if (succeededAmount === targetAmount || pendingAmount > 0) continue;
      if (failedManaged) throw new Error(`Stripe refund ${failedManaged.id} failed; operator review is required before another refund attempt.`);
      const remainingAmount = targetAmount - succeededAmount;
      const created = await this.stripe.refunds.create({ amount: remainingAmount, ...(paymentIntentId ? { payment_intent: paymentIntentId } : { charge: chargeId! }), metadata: { managedOssPaidCapacityRecoveryId: recovery.id, providerSubscriptionId: recovery.providerSubscriptionId, checkoutSessionId: recovery.stripeCheckoutSessionId, invoicePaymentId: payment.id } }, { idempotencyKey: `paid-capacity-refund:${recovery.id}:${payment.id}:${succeededAmount}` });
      if (created.amount !== remainingAmount || (paymentIntentId ? stripeObjectId(created.payment_intent) !== paymentIntentId : stripeObjectId(created.charge) !== chargeId)) throw new Error("Stripe refund response did not match the exact captured payment remainder.");
      if (created.status === "succeeded") confirmedRefundIds.push(created.id);
      else if (created.status === "pending" || created.status === "requires_action") pendingRefundIds.push(created.id);
      else throw new Error(`Stripe refund ${created.id} was not accepted; operator review is required.`);
    }

    const reference = `stripe:subscription=${recovery.providerSubscriptionId};invoice=${invoice.id};refunds=${[...new Set([...confirmedRefundIds, ...pendingRefundIds])].sort().join(",")}`;
    return { status: pendingRefundIds.length ? "pending" : "confirmed", reference };
  }
}

export function normalizeStripeSubscription(subscription: Stripe.Subscription): ProviderSubscriptionSnapshot {
  const problems: string[] = [];
  const totals = { infrastructure: 0, "platform-fee": 0 };
  const componentCounts = { infrastructure: 0, "platform-fee": 0 };
  if (!providerStatuses.has(subscription.status)) problems.push("unsupported_status");
  const userId = subscription.metadata.userId?.trim() || undefined;
  const installationId = subscription.metadata.installationId?.trim() || undefined;
  const capacityHoldId = subscription.metadata.capacityHoldId?.trim() || undefined;
  const capacityChangeHoldId = subscription.metadata.capacityChangeHoldId?.trim() || undefined;
  const planId = subscription.metadata.planId?.trim() || undefined;
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!userId) problems.push("missing_user_metadata");
  else if (!uuidPattern.test(userId)) problems.push("invalid_user_metadata");
  if (!installationId) problems.push("missing_installation_metadata");
  else if (!uuidPattern.test(installationId)) problems.push("invalid_installation_metadata");
  for (const item of subscription.items.data) {
    const product = item.price.product;
    if (typeof product === "string" || product.deleted) { problems.push("unexpanded_or_deleted_product"); continue; }
    const component = product.metadata.billingComponent;
    if (component !== "infrastructure" && component !== "platform-fee") { problems.push("unknown_billing_component"); continue; }
    componentCounts[component] += 1;
    if (item.price.currency !== "usd" || item.price.recurring?.interval !== "month" || item.price.recurring.interval_count !== 1 || !Number.isSafeInteger(item.price.unit_amount) || item.price.unit_amount === null || item.price.unit_amount <= 0 || item.quantity !== 1) {
      problems.push(`invalid_${component}_price`);
      continue;
    }
    const amount = item.price.unit_amount;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(totals[component] + amount)) { problems.push(`invalid_${component}_price`); continue; }
    totals[component] += amount;
  }
  for (const component of ["infrastructure", "platform-fee"] as const) {
    if (componentCounts[component] === 0) problems.push(`missing_${component}_price`);
    if (componentCounts[component] > 1) problems.push(`duplicate_${component}_price`);
  }
  if (subscription.items.data.length !== 2) problems.push("unexpected_price_item_count");
  return { id: subscription.id, status: subscription.status, userId, installationId, ...(capacityHoldId ? { capacityHoldId } : {}), ...(capacityChangeHoldId ? { capacityChangeHoldId } : {}), ...(planId ? { planId } : {}), ...(customerId ? { customerId } : {}), infrastructureMonthlyCents: totals.infrastructure, platformFeeMonthlyCents: totals["platform-fee"], problems: [...new Set(problems)].sort() };
}

type ReconciliationAction = {
  providerSubscriptionId?: string;
  storedSubscriptionId?: string;
  action: "unchanged" | "deactivate_provider_missing" | "deactivate_invalid_provider" | "deactivate_ownership_mismatch" | "upsert_provider" | "skip_invalid_provider" | "skip_ownership_mismatch" | "paid_capacity_pending" | "paid_capacity_compensation_required";
  userId?: string;
  installationId?: string;
  status?: string;
  infrastructureMonthlyCents?: number;
  platformFeeMonthlyCents?: number;
  problems?: string[];
};

export interface SubscriptionReconciliationReport {
  mode: "dry-run" | "apply";
  generatedAt: string;
  providerSubscriptionCount: number;
  storedSubscriptionCount: number;
  summary: { unchanged: number; deactivateProviderMissing: number; deactivateInvalidProvider: number; deactivateOwnershipMismatch: number; upsertProvider: number; skippedInvalidProvider: number; skippedOwnershipMismatch: number; paidCapacityPending: number; paidCapacityCompensationRequired: number; affectedOwners: number };
  actions: ReconciliationAction[];
  entitlements: Array<{ userId: string; before: SuitePlanId; after: SuitePlanId; suiteWorkspaceUpdated: boolean }>;
}

function entitlementFor(subscriptions: StoredSubscription[]): SuitePlanId {
  let rank = -1;
  for (const subscription of subscriptions) {
    if (!["active", "trialing"].includes(subscription.status) || !subscription.installationPlan || !paidPlans.has(subscription.installationPlan)) continue;
    rank = Math.max(rank, subscription.installationPlan === "fleet" ? 2 : subscription.installationPlan === "scale" ? 1 : 0);
  }
  return rank === 2 ? "fleet" : rank === 1 ? "scale" : rank === 0 ? "starter" : "none";
}

function sameStoredSubscription(stored: StoredSubscription | undefined, provider: ReconciledSubscription) {
  return Boolean(stored && stored.userId === provider.userId && stored.installationId === provider.installationId && stored.status === provider.status && stored.infrastructureMonthlyCents === provider.infrastructureMonthlyCents && stored.platformFeeMonthlyCents === provider.platformFeeMonthlyCents);
}

export async function reconcileSubscriptions(input: { repository: Repository; source: SubscriptionSource; compensation?: PaidCapacityCompensationProvider; apply?: boolean; now?: () => Date }): Promise<SubscriptionReconciliationReport> {
  const apply = input.apply === true;
  const observedAt = input.now?.() ?? new Date();
  let [stored, provider] = await Promise.all([input.repository.listSubscriptions(), input.source.listAllSubscriptions()]);
  if (apply) {
    for (const item of stored) if (item.providerSubscriptionId) {
      const recovery = await input.repository.advancePaidCheckoutCapacityRecovery(item.providerSubscriptionId);
      if (recovery?.state === "compensation_required" && input.compensation) {
        const result = await input.compensation.compensatePaidCapacity(recovery);
        if (result.status === "confirmed") {
          const compensated = await input.repository.markPaidCheckoutCapacityCompensated(recovery.providerSubscriptionId, result.reference);
          if (!compensated && (await input.repository.getPaidCheckoutCapacityRecovery(recovery.providerSubscriptionId))?.state !== "compensated") throw new Error(`Confirmed provider compensation for ${recovery.providerSubscriptionId} could not be committed locally.`);
        }
      }
    }
    stored = await input.repository.listSubscriptions();
    for (const item of provider) {
      if (item.capacityHoldId && item.customerId && item.userId && item.installationId && ["active", "trialing"].includes(item.status) && item.problems.length === 0) {
        const recovery = await input.repository.getPaidCheckoutCapacityRecovery(item.id);
        if (recovery?.state === "pending_capacity") await input.repository.retryPaidCheckoutCapacityRecovery({ providerSubscriptionId: item.id, status: item.status, userId: item.userId, installationId: item.installationId, capacityHoldId: item.capacityHoldId, customerId: item.customerId, infrastructureMonthlyCents: item.infrastructureMonthlyCents, platformFeeMonthlyCents: item.platformFeeMonthlyCents, problems: item.problems });
      }
      if (item.capacityChangeHoldId && item.userId && item.installationId && ["active", "trialing"].includes(item.status) && item.problems.length === 0) {
        const resize = await input.repository.getPlanCapacityChangeHold(item.capacityChangeHoldId);
        const confirmed = resize && resize.providerSubscriptionId === item.id && resize.userId === item.userId && resize.installationId === item.installationId && item.planId === resize.planId && item.infrastructureMonthlyCents === resize.infrastructureMonthlyCents && item.platformFeeMonthlyCents === resize.platformFeeMonthlyCents;
        if (confirmed && !(await input.repository.consumePlanCapacityChangeHold(resize.id, item.userId, "scheduled_subscription_reconciliation"))) throw new Error(`Provider-confirmed resize ${resize.id} could not converge on its local capacity allocation.`);
      }
    }
    stored = await input.repository.listSubscriptions();
  }
  const providerIds = new Set(provider.map((item) => item.id));
  const storedByProviderId = new Map(stored.flatMap((item) => item.providerSubscriptionId ? [[item.providerSubscriptionId, item] as const] : []));
  const deactivateSubscriptionIds: string[] = [];
  const upsertSubscriptions: ReconciledSubscription[] = [];
  const providerInstallationPlans = new Map<string, string>();
  const affectedOwners = new Set<string>();
  const actions: ReconciliationAction[] = [];

  const paidCapacityAction = (recovery: NonNullable<Awaited<ReturnType<Repository["getPaidCheckoutCapacityRecovery"]>>>) =>
    recovery.state === "compensation_required" || (recovery.state === "pending_capacity" && new Date(recovery.compensationDeadlineAt) <= observedAt)
      ? "paid_capacity_compensation_required" as const
      : "paid_capacity_pending" as const;

  for (const item of stored) {
    if (item.providerSubscriptionId && providerIds.has(item.providerSubscriptionId)) continue;
    const recovery = item.providerSubscriptionId ? await input.repository.getPaidCheckoutCapacityRecovery(item.providerSubscriptionId) : undefined;
    if (recovery?.state === "compensated") {
      actions.push({ storedSubscriptionId: item.id, providerSubscriptionId: item.providerSubscriptionId, action: "unchanged", userId: item.userId, installationId: item.installationId, status: item.status });
      continue;
    }
    if (recovery && recovery.state !== "fulfilled") {
      actions.push({ storedSubscriptionId: item.id, providerSubscriptionId: item.providerSubscriptionId, action: paidCapacityAction(recovery), userId: item.userId, installationId: item.installationId, status: item.status, infrastructureMonthlyCents: item.infrastructureMonthlyCents, platformFeeMonthlyCents: item.platformFeeMonthlyCents, problems: [recovery.compensationAction, "provider_subscription_missing"] });
      continue;
    }
    if (item.status === "inactive") { actions.push({ storedSubscriptionId: item.id, providerSubscriptionId: item.providerSubscriptionId, action: "unchanged", userId: item.userId, installationId: item.installationId, status: item.status }); continue; }
    deactivateSubscriptionIds.push(item.id);
    affectedOwners.add(item.userId);
    actions.push({ storedSubscriptionId: item.id, providerSubscriptionId: item.providerSubscriptionId, action: "deactivate_provider_missing", userId: item.userId, installationId: item.installationId, status: "inactive" });
  }

  for (const item of provider) {
    const existing = storedByProviderId.get(item.id);
    const recovery = existing ? await input.repository.getPaidCheckoutCapacityRecovery(item.id) : undefined;
    if (existing && recovery?.state === "compensated") {
      actions.push({ providerSubscriptionId: item.id, storedSubscriptionId: existing.id, action: "unchanged", userId: existing.userId, installationId: existing.installationId, status: existing.status });
      continue;
    }
    if (existing && recovery && recovery.state !== "fulfilled") {
      actions.push({ providerSubscriptionId: item.id, storedSubscriptionId: existing.id, action: paidCapacityAction(recovery), userId: existing.userId, installationId: existing.installationId, status: existing.status, infrastructureMonthlyCents: existing.infrastructureMonthlyCents, platformFeeMonthlyCents: existing.platformFeeMonthlyCents, problems: [...new Set([recovery.compensationAction, ...item.problems])].sort() });
      continue;
    }
    if (item.problems.length || !item.userId || !item.installationId) {
      if (existing && existing.status !== "inactive") {
        if (!deactivateSubscriptionIds.includes(existing.id)) deactivateSubscriptionIds.push(existing.id);
        affectedOwners.add(existing.userId);
        actions.push({ providerSubscriptionId: item.id, storedSubscriptionId: existing.id, action: "deactivate_invalid_provider", userId: existing.userId, installationId: existing.installationId, status: "inactive", problems: [...item.problems, "stored_entitlement_revoked"].sort() });
      } else actions.push({ providerSubscriptionId: item.id, action: "skip_invalid_provider", userId: item.userId, installationId: item.installationId, status: item.status, infrastructureMonthlyCents: item.infrastructureMonthlyCents, platformFeeMonthlyCents: item.platformFeeMonthlyCents, problems: item.problems });
      continue;
    }
    const installation = await input.repository.getInstallation(item.userId, item.installationId);
    if (!installation) {
      if (existing && existing.status !== "inactive") {
        if (!deactivateSubscriptionIds.includes(existing.id)) deactivateSubscriptionIds.push(existing.id);
        affectedOwners.add(existing.userId);
        actions.push({ providerSubscriptionId: item.id, storedSubscriptionId: existing.id, action: "deactivate_ownership_mismatch", userId: existing.userId, installationId: existing.installationId, status: "inactive", problems: ["installation_not_owned_by_metadata_user", "stored_entitlement_revoked"] });
      } else actions.push({ providerSubscriptionId: item.id, action: "skip_ownership_mismatch", userId: item.userId, installationId: item.installationId, status: item.status, problems: ["installation_not_owned_by_metadata_user"] });
      continue;
    }
    let expectedPlan = installation.plan;
    if (item.capacityChangeHoldId) {
      const resize = await input.repository.getPlanCapacityChangeHold(item.capacityChangeHoldId);
      const confirmed = resize && resize.providerSubscriptionId === item.id && resize.userId === item.userId && resize.installationId === item.installationId && item.planId === resize.planId && item.infrastructureMonthlyCents === resize.infrastructureMonthlyCents && item.platformFeeMonthlyCents === resize.platformFeeMonthlyCents;
      if (confirmed) expectedPlan = resize.planId;
    }
    const expectedPrice = configuredPlanPrice(expectedPlan);
    const priceProblems = !expectedPrice
      ? ["unknown_installation_plan"]
      : [
          ...(item.infrastructureMonthlyCents === expectedPrice.infrastructureMonthlyCents ? [] : ["infrastructure_price_mismatch"]),
          ...(item.platformFeeMonthlyCents === expectedPrice.platformFeeMonthlyCents ? [] : ["platform_fee_price_mismatch"]),
        ];
    if (priceProblems.length) {
      if (existing && existing.status !== "inactive") {
        if (!deactivateSubscriptionIds.includes(existing.id)) deactivateSubscriptionIds.push(existing.id);
        affectedOwners.add(existing.userId);
        actions.push({ providerSubscriptionId: item.id, storedSubscriptionId: existing.id, action: "deactivate_invalid_provider", userId: existing.userId, installationId: existing.installationId, status: "inactive", problems: [...priceProblems, "stored_entitlement_revoked"].sort() });
      } else actions.push({ providerSubscriptionId: item.id, action: "skip_invalid_provider", userId: item.userId, installationId: item.installationId, status: item.status, infrastructureMonthlyCents: item.infrastructureMonthlyCents, platformFeeMonthlyCents: item.platformFeeMonthlyCents, problems: priceProblems.sort() });
      continue;
    }
    const normalized: ReconciledSubscription = { userId: item.userId, installationId: item.installationId, providerSubscriptionId: item.id, status: item.status, infrastructureMonthlyCents: item.infrastructureMonthlyCents, platformFeeMonthlyCents: item.platformFeeMonthlyCents };
    providerInstallationPlans.set(item.id, expectedPlan);
    if (sameStoredSubscription(existing, normalized)) {
      actions.push({ providerSubscriptionId: item.id, storedSubscriptionId: existing?.id, action: "unchanged", userId: item.userId, installationId: item.installationId, status: item.status, infrastructureMonthlyCents: item.infrastructureMonthlyCents, platformFeeMonthlyCents: item.platformFeeMonthlyCents });
      continue;
    }
    upsertSubscriptions.push(normalized);
    affectedOwners.add(item.userId);
    if (existing?.userId) affectedOwners.add(existing.userId);
    actions.push({ providerSubscriptionId: item.id, storedSubscriptionId: existing?.id, action: "upsert_provider", userId: item.userId, installationId: item.installationId, status: item.status, infrastructureMonthlyCents: item.infrastructureMonthlyCents, platformFeeMonthlyCents: item.platformFeeMonthlyCents });
  }

  const projected = stored.map((item) => deactivateSubscriptionIds.includes(item.id) ? { ...item, status: "inactive" } : { ...item });
  for (const item of upsertSubscriptions) {
    const index = projected.findIndex((candidate) => candidate.providerSubscriptionId === item.providerSubscriptionId);
    const projectedItem: StoredSubscription = { id: index >= 0 ? projected[index].id : `provider:${item.providerSubscriptionId}`, ...item, installationPlan: providerInstallationPlans.get(item.providerSubscriptionId) };
    if (index >= 0) projected[index] = projectedItem; else projected.push(projectedItem);
  }
  const affectedUserIds = [...affectedOwners].sort();
  const appliedEntitlements = apply ? await input.repository.applySubscriptionReconciliation({ deactivateSubscriptionIds, upsertSubscriptions, affectedUserIds }) : [];
  const appliedByUser = new Map(appliedEntitlements.map((item) => [item.userId, item]));
  const entitlements = affectedUserIds.map((userId) => ({ userId, before: entitlementFor(stored.filter((item) => item.userId === userId)), after: appliedByUser.get(userId)?.plan ?? entitlementFor(projected.filter((item) => item.userId === userId)), suiteWorkspaceUpdated: appliedByUser.get(userId)?.suiteWorkspaceUpdated ?? false }));
  const count = (action: ReconciliationAction["action"]) => actions.filter((item) => item.action === action).length;
  return {
    mode: apply ? "apply" : "dry-run",
    generatedAt: observedAt.toISOString(),
    providerSubscriptionCount: provider.length,
    storedSubscriptionCount: stored.length,
    summary: { unchanged: count("unchanged"), deactivateProviderMissing: count("deactivate_provider_missing"), deactivateInvalidProvider: count("deactivate_invalid_provider"), deactivateOwnershipMismatch: count("deactivate_ownership_mismatch"), upsertProvider: count("upsert_provider"), skippedInvalidProvider: count("skip_invalid_provider"), skippedOwnershipMismatch: count("skip_ownership_mismatch"), paidCapacityPending: count("paid_capacity_pending"), paidCapacityCompensationRequired: count("paid_capacity_compensation_required"), affectedOwners: affectedUserIds.length },
    actions,
    entitlements,
  };
}

export function parseReconciliationMode(args: string[]) {
  if (args.some((arg) => !["--apply"].includes(arg))) throw new Error("Usage: npm run reconcile:subscriptions -- [--apply]");
  if (args.filter((arg) => arg === "--apply").length > 1) throw new Error("--apply may be supplied only once.");
  return args.includes("--apply") ? "apply" as const : "dry-run" as const;
}
