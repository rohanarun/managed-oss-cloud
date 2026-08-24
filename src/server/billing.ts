import Stripe from "stripe";
import type { AccountUser, ComputePlan, Installation, Quote } from "../shared/types.js";
import { config } from "./config.js";
import type { Repository } from "./repository.js";
import { configuredPlanPrice, normalizeStripeSubscription, type ProviderSubscriptionSnapshot } from "./subscription-reconciliation.js";
import { planCapacitySnapshot } from "../shared/plan-capacity.js";

export interface CheckoutResult { id: string; url: string | null; expiresAt?: string }

export interface BillingGateway {
  createCustomer(input: { email: string; name: string; userId: string }): Promise<string>;
  createCheckout(input: { customerId: string; userId: string; installationId: string; installationName: string; planId: string; capacityHoldId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number; expiresAt: string; idempotencyKey: string }): Promise<CheckoutResult>;
  expireCheckout?(stripeCheckoutSessionId: string): Promise<void>;
  updateSubscription(input: { providerSubscriptionId: string; userId: string; installationId: string; plan: ComputePlan; platformFeeMonthlyCents: number; capacityChangeHoldId: string; idempotencyKey: string }): Promise<void>;
  retrieveSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>;
  constructEvent(payload: Buffer, signature: string, secret: string): BillingEvent;
}

export interface BillingEvent {
  id: string;
  type: string;
  checkout?: {
    sessionId: string;
    customerId?: string;
    paymentStatus: string;
    subscriptionId?: string;
    metadata: Record<string, string>;
  };
  subscription?: {
    id: string;
    status: string;
    userId?: string;
    installationId?: string;
  };
}

export interface BillingSettings {
  mode: "disabled" | "live";
  webhookSecret?: string;
  publishableKey?: string;
}

export class StripeGateway implements BillingGateway {
  private readonly stripe: Stripe;
  constructor(secretKey: string) { this.stripe = new Stripe(secretKey); }
  async createCustomer(input: { email: string; name: string; userId: string }) { const customer = await this.stripe.customers.create({ email: input.email, name: input.name, metadata: { userId: input.userId } }); return customer.id; }
  async createCheckout(input: { customerId: string; userId: string; installationId: string; installationName: string; planId: string; capacityHoldId: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number; expiresAt: string; idempotencyKey: string }) {
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    if (input.infrastructureMonthlyCents > 0) lineItems.push({ quantity: 1, price_data: { currency: "usd", unit_amount: input.infrastructureMonthlyCents, recurring: { interval: "month" }, product_data: { name: `${input.installationName} infrastructure allocation`, metadata: { billingComponent: "infrastructure", installationId: input.installationId } } } });
    if (input.platformFeeMonthlyCents > 0) lineItems.push({ quantity: 1, price_data: { currency: "usd", unit_amount: input.platformFeeMonthlyCents, recurring: { interval: "month" }, product_data: { name: "Managed OSS operations fee", metadata: { billingComponent: "platform-fee", installationId: input.installationId } } } });
    const metadata = { userId: input.userId, installationId: input.installationId, planId: input.planId, capacityHoldId: input.capacityHoldId, infrastructureMonthlyCents: String(input.infrastructureMonthlyCents), platformFeeMonthlyCents: String(input.platformFeeMonthlyCents) };
    const session = await this.stripe.checkout.sessions.create({ mode: "subscription", customer: input.customerId, line_items: lineItems, client_reference_id: input.installationId, metadata, subscription_data: { metadata }, expires_at: Math.floor(new Date(input.expiresAt).getTime() / 1000), success_url: `${config.PUBLIC_APP_URL}/dashboard/servers?checkout=success`, cancel_url: `${config.PUBLIC_APP_URL}/dashboard/billing?checkout=cancelled`, allow_promotion_codes: false }, { idempotencyKey: input.idempotencyKey });
    return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() };
  }
  async expireCheckout(stripeCheckoutSessionId: string) { await this.stripe.checkout.sessions.expire(stripeCheckoutSessionId); }
  async updateSubscription(input: { providerSubscriptionId: string; userId: string; installationId: string; plan: ComputePlan; platformFeeMonthlyCents: number; capacityChangeHoldId: string; idempotencyKey: string }) {
    const subscription = await this.stripe.subscriptions.retrieve(input.providerSubscriptionId, { expand: ["items.data.price.product"] });
    const itemFor = (component: string) => subscription.items.data.find((item) => typeof item.price.product !== "string" && !item.price.product.deleted && item.price.product.metadata.billingComponent === component);
    const infrastructure = itemFor("infrastructure");
    const platformFee = itemFor("platform-fee");
    if (!infrastructure || !platformFee) throw new Error("Stripe subscription line items could not be reconciled safely.");
    const productId = (item: typeof infrastructure) => typeof item.price.product === "string" ? item.price.product : item.price.product.id;
    await this.stripe.subscriptions.update(input.providerSubscriptionId, {
      items: [
        { id: infrastructure.id, price_data: { currency: "usd", product: productId(infrastructure), recurring: { interval: "month" }, unit_amount: input.plan.infrastructureMonthlyCents } },
        { id: platformFee.id, price_data: { currency: "usd", product: productId(platformFee), recurring: { interval: "month" }, unit_amount: input.platformFeeMonthlyCents } },
      ],
      metadata: { userId: input.userId, installationId: input.installationId, planId: input.plan.id, capacityChangeHoldId: input.capacityChangeHoldId },
      payment_behavior: "error_if_incomplete",
      proration_behavior: "always_invoice",
    }, { idempotencyKey: input.idempotencyKey });
  }
  async retrieveSubscription(providerSubscriptionId: string) {
    const subscription = await this.stripe.subscriptions.retrieve(providerSubscriptionId, { expand: ["items.data.price.product"] });
    return normalizeStripeSubscription(subscription);
  }
  constructEvent(payload: Buffer, signature: string, secret: string): BillingEvent {
    const event = this.stripe.webhooks.constructEvent(payload, signature, secret);
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      return { id: event.id, type: event.type, subscription: { id: subscription.id, status: subscription.status, userId: subscription.metadata.userId, installationId: subscription.metadata.installationId } };
    }
    if (event.type !== "checkout.session.completed") return { id: event.id, type: event.type };
    const session = event.data.object;
    return { id: event.id, type: event.type, checkout: { sessionId: session.id, customerId: typeof session.customer === "string" ? session.customer : session.customer?.id, paymentStatus: session.payment_status, subscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id, metadata: Object.fromEntries(Object.entries(session.metadata ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } };
  }
}

export class CheckoutCapacityUnavailableError extends Error {
  constructor(message = "No recently healthy worker has unreserved capacity for this checkout.") { super(message); this.name = "CheckoutCapacityUnavailableError"; }
}

export class BillingService {
  constructor(private readonly repository: Repository, private readonly gateway?: BillingGateway, private readonly settings: BillingSettings = { mode: config.BILLING_MODE, webhookSecret: config.STRIPE_WEBHOOK_SECRET, publishableKey: config.STRIPE_PUBLISHABLE_KEY }) {}
  get ready() { return this.settings.mode === "live" && Boolean(this.gateway && this.settings.webhookSecret && this.settings.publishableKey); }

  async checkout(user: AccountUser, installation: Installation, quote: Quote, idempotencyKey: string) {
    if (!this.ready || !this.gateway) throw new Error("Billing is not enabled.");
    const applications = installation.applications ?? [];
    if (!quote.recommendedPlan || quote.recommendedPlan.id !== installation.plan) throw new CheckoutCapacityUnavailableError("The checkout quote does not contain the installation's complete configured plan quota.");
    const holdExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const hold = await this.repository.acquireCheckoutCapacityHold({
      userId: user.id,
      installationId: installation.id,
      idempotencyKey,
      requestedPlan: installation.plan,
      requestedAppIds: installation.appIds,
      infrastructureMonthlyCents: quote.infrastructureMonthlyCents,
      platformFeeMonthlyCents: quote.platformFeeCents,
      expiresAt: holdExpiresAt,
      planCapacity: planCapacitySnapshot(quote.recommendedPlan),
      reservations: applications.map((application) => ({ applicationInstanceId: application.id, appId: application.appId, memoryReservationMb: application.memoryReservationMb, cpuReservationMillis: application.cpuReservationMillis, storageReservationGb: application.storageReservationGb })),
    });
    if (!hold) throw new CheckoutCapacityUnavailableError();
    let customerId: string;
    try {
      customerId = await this.repository.getOrCreateStripeCustomer(user.id, () => this.gateway!.createCustomer({ email: user.email, name: user.displayName, userId: user.id }));
    } catch (error) {
      await this.repository.releaseCheckoutCapacityHold(hold.id, user.id, "stripe_customer_creation_failed");
      throw error;
    }
    let checkout: CheckoutResult;
    const checkoutExpiresAt = new Date(Date.now() + 35 * 60_000).toISOString();
    try {
      checkout = await this.gateway.createCheckout({ customerId, userId: user.id, installationId: installation.id, installationName: installation.name, planId: installation.plan, capacityHoldId: hold.id, infrastructureMonthlyCents: quote.infrastructureMonthlyCents, platformFeeMonthlyCents: quote.platformFeeCents, expiresAt: checkoutExpiresAt, idempotencyKey });
    } catch (error) {
      await this.repository.releaseCheckoutCapacityHold(hold.id, user.id, "stripe_checkout_creation_failed");
      throw error;
    }
    const actualCheckoutExpiry = checkout.expiresAt ?? checkoutExpiresAt;
    try {
      if (!await this.repository.attachCheckoutSession({ holdId: hold.id, userId: user.id, stripeCustomerId: customerId, stripeCheckoutSessionId: checkout.id, stripeCheckoutExpiresAt: actualCheckoutExpiry })) throw new Error("Stripe checkout could not be bound to its capacity hold.");
    } catch (error) {
      if (this.gateway.expireCheckout) {
        try {
          await this.gateway.expireCheckout(checkout.id);
          await this.repository.releaseCheckoutCapacityHold(hold.id, user.id, "stripe_checkout_expired_after_binding_failure");
        } catch {}
      }
      throw error;
    }
    return { ...checkout, capacityHoldId: hold.id };
  }

  async upgrade(user: AccountUser, installation: Installation, plan: ComputePlan, platformFeeMonthlyCents: number, memorySafetyReserveMb = 0) {
    if (!this.ready || !this.gateway) throw new Error("Billing is not enabled.");
    const subscription = await this.repository.getActiveSubscription(user.id, installation.id);
    if (!subscription) throw new Error("No active subscription belongs to this server.");
    const allocation = await this.repository.getInstallationCapacityAllocation(user.id, installation.id);
    if (!allocation || allocation.state !== "active") throw new CheckoutCapacityUnavailableError("This paid server has no durable plan quota allocation to resize.");
    const idempotencyKey = `capacity-resize:${installation.id}:${allocation.generation}:${plan.id}`;
    const hold = await this.repository.acquirePlanCapacityChangeHold({ userId: user.id, installationId: installation.id, idempotencyKey, requested: planCapacitySnapshot(plan), infrastructureMonthlyCents: plan.infrastructureMonthlyCents, platformFeeMonthlyCents, providerSubscriptionId: subscription.providerSubscriptionId, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), memorySafetyReserveMb });
    if (!hold) throw new CheckoutCapacityUnavailableError("The target plan quota could not be reserved, or current applications do not fit it.");
    try {
      await this.gateway.updateSubscription({ providerSubscriptionId: subscription.providerSubscriptionId, userId: user.id, installationId: installation.id, plan, platformFeeMonthlyCents, capacityChangeHoldId: hold.id, idempotencyKey });
    } catch (error) {
      try {
        const provider = await this.gateway.retrieveSubscription(subscription.providerSubscriptionId);
        const targetConfirmed = provider.id === subscription.providerSubscriptionId && provider.userId === user.id && provider.installationId === installation.id && provider.capacityChangeHoldId === hold.id && provider.planId === plan.id && ["active", "trialing"].includes(provider.status) && provider.problems.length === 0 && provider.infrastructureMonthlyCents === plan.infrastructureMonthlyCents && provider.platformFeeMonthlyCents === platformFeeMonthlyCents;
        if (targetConfirmed) {
          const recovered = await this.repository.consumePlanCapacityChangeHold(hold.id, user.id, "provider_retrieval_after_update_error");
          if (recovered) return recovered;
        }
        const previousPrice = configuredPlanPrice(installation.plan);
        const previousConfirmed = provider.id === subscription.providerSubscriptionId && provider.userId === user.id && provider.installationId === installation.id && provider.problems.length === 0 && previousPrice && provider.infrastructureMonthlyCents === previousPrice.infrastructureMonthlyCents && provider.platformFeeMonthlyCents === previousPrice.platformFeeMonthlyCents && provider.capacityChangeHoldId !== hold.id;
        if (previousConfirmed) await this.repository.releasePlanCapacityChangeHold(hold.id, user.id, "provider_confirmed_subscription_unchanged");
      } catch {}
      throw new Error(`The provider update outcome is pending exact reconciliation; retry the same plan change without creating a new hold. ${error instanceof Error ? error.message : "Subscription update failed."}`);
    }
    const committed = await this.repository.consumePlanCapacityChangeHold(hold.id, user.id, "provider_update_response");
    if (!committed) throw new Error("Stripe accepted the resize, but its logical quota is pending idempotent reconciliation. Retry the same plan change; do not create another subscription update.");
    return committed;
  }

  async webhook(payload: Buffer, signature: string) {
    if (!this.ready || !this.gateway || !this.settings.webhookSecret) throw new Error("Billing webhook is not enabled.");
    const event = this.gateway.constructEvent(payload, signature, this.settings.webhookSecret);
    if (await this.repository.hasProcessedStripeEvent(event.id)) {
      const storedSubscription = event.subscription?.id ? (await this.repository.listSubscriptions()).find((item) => item.providerSubscriptionId === event.subscription!.id) : undefined;
      const duplicateOwner = storedSubscription?.installationId
        ? { userId: storedSubscription.userId, installationId: storedSubscription.installationId }
        : event.subscription?.userId && event.subscription.installationId
          ? { userId: event.subscription.userId, installationId: event.subscription.installationId }
        : event.checkout?.metadata.userId && event.checkout.metadata.installationId
          ? { userId: event.checkout.metadata.userId, installationId: event.checkout.metadata.installationId }
          : undefined;
      return { duplicate: true, ...duplicateOwner, entitlementSyncRequired: Boolean(duplicateOwner) };
    }
    if (event.subscription) {
      if (!event.subscription.id) throw new Error("Subscription event was missing its immutable provider ID.");
      const stored = (await this.repository.listSubscriptions()).find((item) => item.providerSubscriptionId === event.subscription!.id);
      if (!stored?.installationId) throw new Error("Subscription event did not match a stored customer subscription.");
      let installation = await this.repository.getInstallation(stored.userId, stored.installationId);
      if (!installation) throw new Error("Subscription event referenced a missing installation.");
      let providerMismatch = false;
      if (["active", "trialing"].includes(event.subscription.status)) {
        const provider = await this.gateway.retrieveSubscription(event.subscription.id);
        if (provider.capacityChangeHoldId) {
          const resize = await this.repository.getPlanCapacityChangeHold(provider.capacityChangeHoldId);
          const confirmedResize = resize && resize.providerSubscriptionId === event.subscription.id && resize.userId === stored.userId && resize.installationId === stored.installationId && provider.userId === stored.userId && provider.installationId === stored.installationId && provider.planId === resize.planId && provider.problems.length === 0 && provider.infrastructureMonthlyCents === resize.infrastructureMonthlyCents && provider.platformFeeMonthlyCents === resize.platformFeeMonthlyCents;
          if (confirmedResize) {
            const committed = await this.repository.consumePlanCapacityChangeHold(resize.id, stored.userId, "signed_subscription_webhook");
            if (!committed) throw new Error("The signed provider resize could not converge on its reserved local quota.");
            installation = await this.repository.getInstallation(stored.userId, stored.installationId);
            if (!installation) throw new Error("Subscription resize referenced a missing installation after commit.");
          }
        }
        const expected = configuredPlanPrice(installation.plan);
        providerMismatch = !expected || provider.id !== event.subscription.id || provider.userId !== stored.userId || provider.installationId !== stored.installationId || provider.status !== event.subscription.status || provider.problems.length > 0 || provider.infrastructureMonthlyCents !== expected.infrastructureMonthlyCents || provider.platformFeeMonthlyCents !== expected.platformFeeMonthlyCents;
      }
      const ownershipMismatch = Boolean((event.subscription.userId && event.subscription.userId !== stored.userId) || (event.subscription.installationId && event.subscription.installationId !== stored.installationId));
      const reconciledStatus = ownershipMismatch || providerMismatch ? "inactive" : event.subscription.status;
      const owner = await this.repository.updateSubscriptionStatus(event.subscription.id, reconciledStatus);
      if (!owner || owner.userId !== stored.userId || owner.installationId !== stored.installationId) throw new Error("Subscription ownership changed while its status was reconciled.");
      await this.repository.markStripeEventProcessed(event.id, event.type);
      const entitlementActive = !ownershipMismatch && !providerMismatch && ["active", "trialing"].includes(event.subscription.status);
      return { duplicate: false, subscriptionChanged: true, status: reconciledStatus, userId: owner.userId, installationId: owner.installationId, plan: entitlementActive ? installation.plan : "none", entitlementActive, ownershipQuarantined: ownershipMismatch, pricingQuarantined: providerMismatch };
    }
    if (event.type !== "checkout.session.completed" || !event.checkout) { await this.repository.markStripeEventProcessed(event.id, event.type); return { ignored: true }; }
    const metadata = event.checkout.metadata;
    if (event.checkout.paymentStatus !== "paid" || !event.checkout.sessionId || !event.checkout.customerId || !event.checkout.subscriptionId || !metadata.userId || !metadata.installationId || !metadata.capacityHoldId || !metadata.planId) throw new Error("Checkout completion was missing paid subscription or capacity-hold metadata.");
    const infrastructureMonthlyCents = Number(metadata.infrastructureMonthlyCents);
    const platformFeeMonthlyCents = Number(metadata.platformFeeMonthlyCents);
    if (!Number.isSafeInteger(infrastructureMonthlyCents) || !Number.isSafeInteger(platformFeeMonthlyCents) || infrastructureMonthlyCents <= 0 || platformFeeMonthlyCents <= 0) throw new Error("Checkout completion contained invalid price metadata.");
    const installation = await this.repository.getInstallation(metadata.userId, metadata.installationId);
    if (!installation || installation.state !== "planned") throw new Error("Paid checkout did not reference an unpaid planned installation owned by the metadata user.");
    const hold = await this.repository.getCheckoutCapacityHold(metadata.capacityHoldId);
    if (!hold || !["active", "expired"].includes(hold.state) || hold.userId !== metadata.userId || hold.installationId !== metadata.installationId || hold.requestedPlan !== metadata.planId || hold.stripeCheckoutSessionId !== event.checkout.sessionId || hold.stripeCustomerId !== event.checkout.customerId) throw new Error("Paid checkout did not match the exact owned capacity hold and Stripe session.");
    const expectedPlan = config.plans.find((plan) => plan.id === installation.plan);
    const expectedPrice = configuredPlanPrice(installation.plan);
    if (!expectedPlan || !expectedPrice) throw new Error("Paid checkout referenced an unknown server plan.");
    if (metadata.planId !== installation.plan || hold.infrastructureMonthlyCents !== infrastructureMonthlyCents || hold.platformFeeMonthlyCents !== platformFeeMonthlyCents || infrastructureMonthlyCents !== expectedPrice.infrastructureMonthlyCents || platformFeeMonthlyCents !== expectedPrice.platformFeeMonthlyCents) throw new Error("Checkout price or plan metadata did not match the immutable capacity hold and configured installation.");
    const provider = await this.gateway.retrieveSubscription(event.checkout.subscriptionId);
    if (provider.id !== event.checkout.subscriptionId || provider.userId !== metadata.userId || provider.installationId !== metadata.installationId || provider.capacityHoldId !== metadata.capacityHoldId || provider.customerId !== event.checkout.customerId || !["active", "trialing"].includes(provider.status) || provider.problems.length || provider.infrastructureMonthlyCents !== expectedPrice.infrastructureMonthlyCents || provider.platformFeeMonthlyCents !== expectedPrice.platformFeeMonthlyCents) throw new Error(`Stripe subscription line items did not exactly match the held installation quote and ownership${provider.problems.length ? `: ${provider.problems.join(", ")}` : "."}`);
    const processed = await this.repository.processPaidCheckout({ eventId: event.id, eventType: event.type, holdId: metadata.capacityHoldId, userId: metadata.userId, installationId: metadata.installationId, stripeCheckoutSessionId: event.checkout.sessionId, stripeCustomerId: event.checkout.customerId, providerSubscriptionId: event.checkout.subscriptionId, infrastructureMonthlyCents, platformFeeMonthlyCents, compensationDeadlineAt: new Date(Date.now() + config.PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS).toISOString() });
    if (!processed) return { duplicate: true };
    const recovery = await this.repository.getPaidCheckoutCapacityRecovery(event.checkout.subscriptionId);
    if (recovery?.state === "pending_capacity") return { duplicate: false, queued: false, paidPendingCapacity: true, compensationDeadlineAt: recovery.compensationDeadlineAt, compensationAction: recovery.compensationAction, userId: metadata.userId, installationId: metadata.installationId, plan: installation.plan };
    return { duplicate: false, queued: true, userId: metadata.userId, installationId: metadata.installationId, plan: installation.plan };
  }
}

export function createBillingService(repository: Repository, gateway?: BillingGateway, settings?: BillingSettings) {
  const productionGateway = gateway ?? (config.STRIPE_SECRET_KEY ? new StripeGateway(config.STRIPE_SECRET_KEY) : undefined);
  return new BillingService(repository, productionGateway, settings);
}
