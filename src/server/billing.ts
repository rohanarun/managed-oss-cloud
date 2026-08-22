import Stripe from "stripe";
import type { AccountUser, ComputePlan, Installation, Quote } from "../shared/types.js";
import { config } from "./config.js";
import type { Repository } from "./repository.js";

export interface CheckoutResult { id: string; url: string | null }

export interface BillingGateway {
  createCustomer(input: { email: string; name: string; userId: string }): Promise<string>;
  createCheckout(input: { customerId: string; userId: string; installationId: string; installationName: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number; idempotencyKey: string }): Promise<CheckoutResult>;
  updateSubscription(input: { providerSubscriptionId: string; installationId: string; plan: ComputePlan; platformFeeMonthlyCents: number }): Promise<void>;
  constructEvent(payload: Buffer, signature: string, secret: string): BillingEvent;
}

export interface BillingEvent {
  id: string;
  type: string;
  checkout?: {
    paymentStatus: string;
    subscriptionId?: string;
    metadata: Record<string, string>;
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
  async createCheckout(input: { customerId: string; userId: string; installationId: string; installationName: string; infrastructureMonthlyCents: number; platformFeeMonthlyCents: number; idempotencyKey: string }) {
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    if (input.infrastructureMonthlyCents > 0) lineItems.push({ quantity: 1, price_data: { currency: "usd", unit_amount: input.infrastructureMonthlyCents, recurring: { interval: "month" }, product_data: { name: `${input.installationName} infrastructure allocation`, metadata: { billingComponent: "infrastructure", installationId: input.installationId } } } });
    if (input.platformFeeMonthlyCents > 0) lineItems.push({ quantity: 1, price_data: { currency: "usd", unit_amount: input.platformFeeMonthlyCents, recurring: { interval: "month" }, product_data: { name: "Managed OSS operations fee", metadata: { billingComponent: "platform-fee", installationId: input.installationId } } } });
    const metadata = { userId: input.userId, installationId: input.installationId, infrastructureMonthlyCents: String(input.infrastructureMonthlyCents), platformFeeMonthlyCents: String(input.platformFeeMonthlyCents) };
    const session = await this.stripe.checkout.sessions.create({ mode: "subscription", customer: input.customerId, line_items: lineItems, client_reference_id: input.installationId, metadata, subscription_data: { metadata }, success_url: `${config.PUBLIC_APP_URL}/dashboard/servers?checkout=success`, cancel_url: `${config.PUBLIC_APP_URL}/dashboard/billing?checkout=cancelled`, allow_promotion_codes: false }, { idempotencyKey: input.idempotencyKey });
    return { id: session.id, url: session.url };
  }
  async updateSubscription(input: { providerSubscriptionId: string; installationId: string; plan: ComputePlan; platformFeeMonthlyCents: number }) {
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
      metadata: { installationId: input.installationId, plan: input.plan.id },
      payment_behavior: "error_if_incomplete",
      proration_behavior: "always_invoice",
    });
  }
  constructEvent(payload: Buffer, signature: string, secret: string): BillingEvent {
    const event = this.stripe.webhooks.constructEvent(payload, signature, secret);
    if (event.type !== "checkout.session.completed") return { id: event.id, type: event.type };
    const session = event.data.object;
    return { id: event.id, type: event.type, checkout: { paymentStatus: session.payment_status, subscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id, metadata: Object.fromEntries(Object.entries(session.metadata ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } };
  }
}

export class BillingService {
  constructor(private readonly repository: Repository, private readonly gateway?: BillingGateway, private readonly settings: BillingSettings = { mode: config.BILLING_MODE, webhookSecret: config.STRIPE_WEBHOOK_SECRET, publishableKey: config.STRIPE_PUBLISHABLE_KEY }) {}
  get ready() { return this.settings.mode === "live" && Boolean(this.gateway && this.settings.webhookSecret && this.settings.publishableKey); }

  async checkout(user: AccountUser, installation: Installation, quote: Quote, idempotencyKey: string) {
    if (!this.ready || !this.gateway) throw new Error("Billing is not enabled.");
    const customerId = await this.repository.getOrCreateStripeCustomer(user.id, () => this.gateway!.createCustomer({ email: user.email, name: user.displayName, userId: user.id }));
    return this.gateway.createCheckout({ customerId, userId: user.id, installationId: installation.id, installationName: installation.name, infrastructureMonthlyCents: quote.infrastructureMonthlyCents, platformFeeMonthlyCents: quote.platformFeeCents, idempotencyKey });
  }

  async upgrade(user: AccountUser, installation: Installation, plan: ComputePlan, platformFeeMonthlyCents: number) {
    if (!this.ready || !this.gateway) throw new Error("Billing is not enabled.");
    const subscription = await this.repository.getActiveSubscription(user.id, installation.id);
    if (!subscription) throw new Error("No active subscription belongs to this server.");
    await this.gateway.updateSubscription({ providerSubscriptionId: subscription.providerSubscriptionId, installationId: installation.id, plan, platformFeeMonthlyCents });
  }

  async webhook(payload: Buffer, signature: string) {
    if (!this.ready || !this.gateway || !this.settings.webhookSecret) throw new Error("Billing webhook is not enabled.");
    const event = this.gateway.constructEvent(payload, signature, this.settings.webhookSecret);
    if (await this.repository.hasProcessedStripeEvent(event.id)) return { duplicate: true };
    if (event.type !== "checkout.session.completed" || !event.checkout) { await this.repository.markStripeEventProcessed(event.id, event.type); return { ignored: true }; }
    const metadata = event.checkout.metadata;
    if (event.checkout.paymentStatus !== "paid" || !event.checkout.subscriptionId || !metadata.userId || !metadata.installationId) throw new Error("Checkout completion was missing paid subscription metadata.");
    const infrastructureMonthlyCents = Number(metadata.infrastructureMonthlyCents);
    const platformFeeMonthlyCents = Number(metadata.platformFeeMonthlyCents);
    if (!Number.isSafeInteger(infrastructureMonthlyCents) || !Number.isSafeInteger(platformFeeMonthlyCents) || infrastructureMonthlyCents < 0 || platformFeeMonthlyCents < 0) throw new Error("Checkout completion contained invalid price metadata.");
    const processed = await this.repository.processPaidCheckout({ eventId: event.id, eventType: event.type, userId: metadata.userId, installationId: metadata.installationId, providerSubscriptionId: event.checkout.subscriptionId, infrastructureMonthlyCents, platformFeeMonthlyCents });
    return { duplicate: !processed, queued: processed };
  }
}

export function createBillingService(repository: Repository, gateway?: BillingGateway) {
  const productionGateway = gateway ?? (config.STRIPE_SECRET_KEY ? new StripeGateway(config.STRIPE_SECRET_KEY) : undefined);
  return new BillingService(repository, productionGateway);
}
