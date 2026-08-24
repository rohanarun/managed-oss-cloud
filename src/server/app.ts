import { createHash, randomBytes, randomUUID, timingSafeEqual, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import QRCode from "qrcode";
import { z } from "zod";
import { buildQuote, buildQuoteForPlan } from "../shared/pricing.js";
import type { AccountUser, CatalogApp } from "../shared/types.js";
import { suiteApiTokenScopes, suiteModuleById, suiteModules, suitePlanAllows, type SuiteApiTokenScope, type SuitePaidPlanId, type SuiteWorkspace } from "../shared/suite.js";
import { suiteActionExampleInput, suiteActionInputJsonSchema, suiteActionRequiredScope, suiteActionToolName, suiteActions, suiteActionsByModule } from "../shared/suite-actions.js";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./auth.js";
import { CheckoutCapacityUnavailableError, createBillingService, type BillingGateway, type BillingSettings } from "./billing.js";
import { config } from "./config.js";
import { verifyDomain, type DomainResolver } from "./domain-verification.js";
import { MemoryHostnameClaimRegistry } from "./hostname-claims.js";
import { GcpInstanceIdentityVerifier, parseGcpWorkerIdentityPolicy, type GcpWorkerIdentity } from "./gcp-instance-identity.js";
import { runtimeReservation } from "./app-manifests.js";
import { ManagedGoogleOAuthBroker, ManagedOAuthBrokerError, type ManagedGoogleOAuthBrokerLike, type ManagedOAuthTenantPost } from "./managed-oauth.js";
import { createRepository, type Repository } from "./repository.js";
import { createSuiteStore, type SuiteStore } from "./suite-store.js";
import { executeSuiteAction, type SuiteEngineDependencies } from "./suite-engine.js";
import { createExtendedExternalEvidenceVerifier } from "./extended-external-evidence.js";
import { PublicSigningService, validatePublicVerificationKey, type PublicVerificationKey } from "./public-signing.js";
import { resolvePublicHttpsDestination, type PublicDestinationResolver } from "./public-destination.js";
import { PublicGrowthError, PublicGrowthService, type PublishedPageProjection, type PublishedWidgetProjection } from "./public-growth.js";
import { HostedEsignService, createHostedEsignRouter, type HostedEsignObjectLoader, type HostedEsignRateLimiter } from "./hosted-esign.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "../..");
const sessionCookie = "opendock_session";
const catalogSchema = z.array(z.object({
  id: z.string(), name: z.string(), replaces: z.string(), category: z.string(), license: z.string(), sourceUrl: z.string().url(), description: z.string(), version: z.string(),
  memoryBudgetMb: z.number().int().positive(), cpuBudgetMillis: z.number().int().positive(), storageBudgetGb: z.number().int().positive(), bundleEligible: z.boolean(), status: z.enum(["ready", "integration"]), requirements: z.array(z.string()), deploymentNote: z.string(),
}));
const appIdsSchema = z.object({ appIds: z.array(z.string()).min(1).max(12) });
const installSchema = z.object({
  appIds: z.array(z.string()).max(12).default([]),
  name: z.string().trim().min(2).max(60).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]+$/),
  plan: z.string().min(1).max(40).optional(),
});
const domainSchema = z.object({ domain: z.string().trim().toLowerCase().regex(/^(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,}$/) });
const upgradeSchema = z.object({ plan: z.string().min(1) });
const signupSchema = z.object({ displayName: z.string().trim().min(2).max(60), email: z.string().trim().toLowerCase().email(), password: z.string().min(10).max(200) });
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
const checkoutSchema = z.object({ installationId: z.string().uuid() });
const cloneApplicationSchema = z.object({ appId: z.string().min(1).max(100) });
const actionSchema = z.object({ action: z.enum(["start", "stop", "upgrade", "backup", "restore"]), objectName: z.string().max(1_000).optional(), applicationInstanceId: z.string().uuid() });
const workerRegistrationSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/), name: z.string().min(3).max(100), privateAddress: z.ipv4(), machineType: z.string().min(2).max(100), capacityMemoryMb: z.number().int().min(1024), capacityCpuMillis: z.number().int().min(250), capacityStorageGb: z.number().int().min(10), systemReserveMemoryMb: z.number().int().min(256) });
const workerHeartbeatSchema = z.object({ privateAddress: z.ipv4(), capacityMemoryMb: z.number().int().min(1024), capacityCpuMillis: z.number().int().min(250), capacityStorageGb: z.number().int().min(10) });
const workerNodeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/);
const workerModeSchema = z.object({ mode: z.enum(["active", "draining"]) });
const workerReportSchema = z.object({ status: z.enum(["succeeded", "failed"]), error: z.string().max(1_000).optional(), applications: z.array(z.object({ id: z.string().uuid(), state: z.enum(["queued", "provisioning", "live", "failed", "stopped"]), healthy: z.boolean().optional() })).max(12).optional(), backups: z.array(z.object({ applicationInstanceId: z.string().uuid(), objectName: z.string().min(1).max(1_000), sizeBytes: z.number().int().nonnegative() })).max(12).optional() });
const oauthCallbackSchema = z.object({ state: z.string().min(8).max(8_000), code: z.string().min(1).max(8_000).optional(), error: z.string().min(1).max(200).optional(), error_description: z.string().max(1_000).optional() }).refine((value) => Boolean(value.code || value.error));
const oauthStartSchema = z.object({ application_id: z.string().uuid(), origin: z.string().url().max(2_048), upstream_state: z.string().min(8).max(2_000) });
const moduleIdSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/) });
const suiteRecordQuerySchema = z.object({ moduleId: z.string().optional(), recordType: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const suiteRecordSchema = z.object({ moduleId: z.string(), recordType: z.string().min(1).max(80), title: z.string().trim().min(1).max(300), state: z.string().min(1).max(80).optional(), data: z.record(z.string(), z.unknown()).optional() });
const suiteRecordPatchSchema = z.object({ title: z.string().trim().min(1).max(300).optional(), state: z.string().min(1).max(80).optional(), data: z.record(z.string(), z.unknown()).optional() }).refine((value) => Object.keys(value).length > 0);
const suiteAiActionSchema = z.object({ moduleId: z.string(), goal: z.string().trim().min(3).max(4_000), context: z.record(z.string(), z.unknown()).optional() });
const apiTokenSchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.enum(suiteApiTokenScopes)).min(1).max(suiteApiTokenScopes.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, "API token scopes must be unique.")
    .default([...suiteApiTokenScopes]),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
const workspaceMemberSchema = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["admin", "member", "viewer"]) });
const suiteActionSchema = z.object({ input: z.record(z.string(), z.unknown()).default({}) });
const publicWorkspaceSchema = z.object({ workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/), moduleId: z.enum(["feedback", "knowledge", "testimonials", "brand-pages", "giveaways"]) });
const publicFeedbackSchema = z.object({ title: z.string().trim().min(3).max(160), description: z.string().trim().min(3).max(5_000), email: z.string().email().optional() });
const consentPurposes = z.array(z.enum(["contest-administration", "referral-attribution", "testimonial-publication", "collection-follow-up"])).min(1).max(20).refine((purposes) => new Set(purposes).size === purposes.length, "Consent purposes must be unique.");
const publicTestimonialSchema = z.object({
  authorName: z.string().trim().min(1).max(120),
  content: z.string().trim().min(10).max(20_000),
  attribution: z.enum(["full-name", "first-name", "anonymous"]),
  authorRole: z.string().trim().min(1).max(160).optional(),
  organization: z.string().trim().min(1).max(160).optional(),
  consent: z.object({ granted: z.literal(true), policyVersion: z.string().trim().min(1).max(100), purposes: consentPurposes }).strict(),
}).strict();
const publicEntrySchema = z.object({
  participantKeyHash: z.string().regex(/^[a-f0-9]{64}$/i),
  displayName: z.string().trim().min(1).max(120).optional(),
  referralCode: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  consent: z.object({ granted: z.literal(true), policyVersion: z.string().trim().min(1).max(100), purposes: consentPurposes }).strict(),
}).strict();
const publicCollectionParamsSchema = z.object({ workspaceId: z.string().uuid(), requestId: z.string().uuid() });
const customDomainCollectionParamsSchema = z.object({ requestId: z.string().uuid() });
const publicWidgetParamsSchema = z.object({ workspaceId: z.string().uuid(), widgetVersionId: z.string().uuid() });
const customDomainWidgetParamsSchema = z.object({ widgetVersionId: z.string().uuid() });
const publicPageEmbedParamsSchema = z.object({ workspaceId: z.string().uuid(), pageVersionId: z.string().uuid() });
const customDomainPageEmbedParamsSchema = z.object({ pageVersionId: z.string().uuid() });
const publicTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const publicConsentSiteSchema = z.object({ siteId: z.string().uuid() });
const publicConsentDecisionSchema = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), allowed: z.boolean() });
const publicConsentChoiceSchema = z.object({
  revisionId: z.string().uuid(),
  visitorKey: z.string().min(16).max(512),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,200}$/),
  action: z.enum(["choose", "revoke"]).default("choose"),
  decisions: z.array(publicConsentDecisionSchema).max(100).optional(),
  gpc: z.boolean().optional(),
}).refine((value) => value.action === "revoke" || Boolean(value.decisions?.length), { message: "A choice must include decisions.", path: ["decisions"] });
const publicSeoReportTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

function bearerToken(request: Request) { const authorization = request.get("authorization") ?? ""; return authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined; }
function tokenMatches(actual: string | undefined, expected: string | undefined) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function publicUser(user: AccountUser) {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt };
}

function safeDomainClaimError(error: unknown) {
  if (error instanceof Error && /^(Platform-owned hostnames|Enter a valid custom hostname)/.test(error.message)) return error.message;
  return "That hostname is already reserved or could not be claimed safely.";
}

function escapeHtml(value: unknown) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!); }
function managedOAuthPostHtml(response: Response, post: ManagedOAuthTenantPost) {
  const action = new URL(post.action);
  if (action.protocol !== "https:" || action.username || action.password || action.port || action.search || action.hash || action.pathname !== "/connect/google/callback") throw new Error("Managed OAuth tenant POST target is invalid.");
  const fieldNames = Object.keys(post.fields);
  const acceptedShape = fieldNames.includes("state") && (fieldNames.length === 2 || fieldNames.length === 3)
    && (("assertion" in post.fields && fieldNames.length === 2) || ("error" in post.fields && "error_description" in post.fields && fieldNames.length === 3));
  if (!acceptedShape) throw new Error("Managed OAuth tenant POST fields are invalid.");
  const nonce = randomBytes(24).toString("base64url");
  const fields = Object.entries(post.fields).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
  response.set("Cache-Control", "no-store, max-age=0");
  response.set("Pragma", "no-cache");
  response.set("Referrer-Policy", "no-referrer");
  response.set("X-Robots-Tag", "noindex, nofollow");
  response.set("Content-Security-Policy", `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action ${action.origin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`);
  response.type("html");
  return response.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Completing Google sign-in</title><style nonce="${nonce}">body{margin:0;display:grid;min-height:100vh;place-items:center;font:16px system-ui;color:#171717;background:#fff}main{max-width:32rem;padding:2rem;text-align:center}button{padding:.75rem 1rem}</style></head><body><main><p>Completing Google sign-in…</p><form id="managed-oauth-post" method="post" action="${escapeHtml(action.toString())}" autocomplete="off">${fields}<noscript><p>JavaScript is disabled. Continue to finish signing in.</p></noscript><button type="submit">Continue</button></form></main><script nonce="${nonce}">document.getElementById("managed-oauth-post").submit();</script></body></html>`);
}
function safeHttpUrl(value: unknown) { try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined; } catch { return undefined; } }
function safePublicHttpsUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !hostname || hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) return undefined;
    return url.toString();
  } catch { return undefined; }
}
function publicGrowthFailure(response: Response, error: unknown) {
  if (error instanceof PublicGrowthError) return response.status(error.status).json({ error: error.message });
  throw error;
}
function publishedPageHtml(page: PublishedPageProjection) {
  const links = page.links.map((link) => `<a href="/out/${encodeURIComponent(page.workspaceId)}/${encodeURIComponent(page.pageVersionId)}/${encodeURIComponent(link.destinationVersionId)}" aria-label="${escapeHtml(link.accessibilityLabel || link.label)}">${escapeHtml(link.label)}</a>`).join("");
  const { background, foreground, accent, radiusPx } = page.theme;
  return `<!doctype html><html lang="${escapeHtml(page.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin-when-cross-origin"><title>${escapeHtml(page.title)}</title><style>:root{color-scheme:light dark}body{margin:0;font:16px system-ui;background:${background};color:${foreground}}main{width:min(92%,680px);margin:10vh auto;text-align:center}h1{font-size:clamp(2.5rem,8vw,5rem);letter-spacing:-.06em}a{display:block;margin:12px;padding:16px;border:2px solid ${accent};border-radius:${radiusPx}px;color:${foreground};background:${background};text-decoration:none}a:focus-visible{outline:3px solid ${accent};outline-offset:3px}</style></head><body><main data-page-version="${escapeHtml(page.pageVersionId)}"><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.description)}</p>${links}</main></body></html>`;
}
function publishedWidgetHtml(widget: PublishedWidgetProjection) {
  const { accent, surface, text, radiusPx } = widget.theme;
  const quotes = widget.testimonials.map((testimonial) => `<article><blockquote>${escapeHtml(testimonial.content)}</blockquote><p>${escapeHtml(testimonial.attributionLabel)}</p>${testimonial.disclosure ? `<small>${escapeHtml(testimonial.disclosure)}</small>` : ""}</article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Testimonials</title><style>body{margin:0;font:16px system-ui;background:${surface};color:${text}}main{display:grid;gap:16px;padding:16px}article{border:1px solid ${accent};border-radius:${radiusPx}px;padding:18px}blockquote{margin:0}p{font-weight:700}</style></head><body><main data-widget-version="${escapeHtml(widget.id)}">${quotes}</main></body></html>`;
}
function publicRecordProjection(record: Awaited<ReturnType<SuiteStore["listPublicRecords"]>>[number], moduleId: string) {
  const allowlists: Record<string, string[]> = {
    testimonials: ["content", "role", "company", "avatarUrl"], knowledge: ["content", "slug", "summary"], feedback: ["description", "voteCount", "roadmapState"],
    giveaways: ["rules", "closesAt", "description"], "brand-pages": ["title", "description", "links", "theme"],
  };
  const allowed = new Set(allowlists[moduleId] ?? []);
  return { id: record.id, title: record.title, state: record.state, data: Object.fromEntries(Object.entries(record.data).filter(([key]) => allowed.has(key))), updatedAt: record.updatedAt };
}

export async function createApp(options: { repository?: Repository; suiteStore?: SuiteStore; hostnameRegistry?: MemoryHostnameClaimRegistry; billingGateway?: BillingGateway; billingSettings?: BillingSettings; domainResolver?: DomainResolver; publicDestinationResolver?: PublicDestinationResolver; workerBootstrapToken?: string; gcpWorkerIdentityVerifier?: { verify(token: string): Promise<GcpWorkerIdentity> }; gatewayReconcilerToken?: string; agentJobsEnabled?: boolean; provisioningReadyForBilling?: boolean; consentPolicySigningKey?: string | Buffer | KeyObject; consentPolicyPreviousVerificationKeys?: readonly PublicVerificationKey[]; suiteEntitlementMode?: "hosted" | "unrestricted"; synchronizeSuiteEntitlements?: boolean; managedGoogleOAuthBroker?: ManagedGoogleOAuthBrokerLike; verifyExtendedExternalEvidence?: SuiteEngineDependencies["verifyExtendedExternalEvidence"]; hostedEsign?: { objectLoader: HostedEsignObjectLoader; rateLimiter: HostedEsignRateLimiter; allowedOrigins: readonly string[]; clientKey: (request: Request) => string } } = {}) {
  const app = express();
  const repository = options.repository ?? createRepository();
  const suiteStore = options.suiteStore ?? createSuiteStore();
  if (repository.persistence === "preview-memory" && suiteStore.persistence === "preview-memory") {
    const hostnameRegistry = options.hostnameRegistry ?? repository.hostnameRegistry ?? suiteStore.hostnameRegistry ?? new MemoryHostnameClaimRegistry();
    repository.attachHostnameRegistry?.(hostnameRegistry);
    suiteStore.attachHostnameRegistry?.(hostnameRegistry);
  }
  await repository.initialize();
  await suiteStore.initialize();
  const billing = createBillingService(repository, options.billingGateway, options.billingSettings);
  const workerBootstrapToken = options.workerBootstrapToken ?? config.WORKER_BOOTSTRAP_TOKEN;
  const configuredWorkerIdentityPolicy = parseGcpWorkerIdentityPolicy({
    audience: config.GCP_WORKER_IDENTITY_AUDIENCE,
    projectId: config.GCP_WORKER_IDENTITY_PROJECT_ID,
    instanceNames: config.GCP_WORKER_IDENTITY_INSTANCE_NAMES,
    zones: config.GCP_WORKER_IDENTITY_ZONES,
  });
  const gcpWorkerIdentityVerifier = options.gcpWorkerIdentityVerifier ?? (configuredWorkerIdentityPolicy ? new GcpInstanceIdentityVerifier(configuredWorkerIdentityPolicy) : undefined);
  const gatewayReconcilerToken = options.gatewayReconcilerToken ?? config.GATEWAY_RECONCILER_TOKEN;
  const agentJobsEnabled = options.agentJobsEnabled ?? config.PROVISIONING_MODE === "live";
  const provisioningReadyForBilling = options.provisioningReadyForBilling ?? (config.PROVISIONING_MODE === "live" && agentJobsEnabled);
  const suiteEntitlementMode = options.suiteEntitlementMode ?? config.SUITE_ENTITLEMENT_MODE;
  const verifyExtendedExternalEvidence = options.verifyExtendedExternalEvidence ?? (config.EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET ? createExtendedExternalEvidenceVerifier(config.EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET) : undefined);
  const consentPolicySigningKey = options.consentPolicySigningKey ?? config.CONSENT_POLICY_SIGNING_PRIVATE_KEY;
  const publicSigning = consentPolicySigningKey ? new PublicSigningService(consentPolicySigningKey) : undefined;
  const publicSigningVerificationKeys = publicSigning
    ? [...new Map([publicSigning.verificationKey(), ...(options.consentPolicyPreviousVerificationKeys ?? config.CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS)].map(validatePublicVerificationKey).map((key) => [key.keyId, key])).values()]
    : [];
  const publicGrowth = new PublicGrowthService(suiteStore, { publicBaseUrl: config.PUBLIC_APP_URL });
  const managedGoogleOAuthBroker = options.managedGoogleOAuthBroker ?? (
    config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET && config.GOOGLE_OAUTH_STATE_SECRET && config.GOOGLE_OAUTH_CALLBACK_URL && config.GOOGLE_OAUTH_BROKER_START_URL && config.GOOGLE_OAUTH_ASSERTION_SIGNING_PRIVATE_KEY && config.GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY
      ? new ManagedGoogleOAuthBroker(repository, {
        clientId: config.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
        stateSecret: config.GOOGLE_OAUTH_STATE_SECRET,
        callbackUrl: config.GOOGLE_OAUTH_CALLBACK_URL,
        brokerStartUrl: config.GOOGLE_OAUTH_BROKER_START_URL,
        assertionSigningPrivateKey: config.GOOGLE_OAUTH_ASSERTION_SIGNING_PRIVATE_KEY,
        assertionPublicKey: config.GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY,
      }, { domainResolver: options.domainResolver })
      : undefined
  );
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path.join(projectDirectory, "catalog/apps.json"), "utf8"))) as CatalogApp[];
  const publicSuiteModules = suiteModules.map(({ inspiredBy: _categoryReference, ...module }) => module);
  const policy = { plans: config.plans, platformFeePercent: config.PLATFORM_FEE_PERCENT, platformFeeMinimumCents: config.PLATFORM_FEE_MIN_CENTS, systemReserveMb: config.APPLICATION_MEMORY_SAFETY_RESERVE_MB, maximumSafeUtilization: 0.8 };
  const suitePlanDescription = (planId: SuitePaidPlanId) => {
    const plan = config.plans.find((candidate) => candidate.id === planId);
    if (!plan) return planId;
    const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: plan.monthlyCents % 100 === 0 ? 0 : 2 }).format(plan.monthlyCents / 100);
    return `${price} ${plan.label}`;
  };
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const oauthLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const publicWriteLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const publicRedirectLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
  const checkedPublicDestination = (value: unknown) => resolvePublicHttpsDestination(value, options.publicDestinationResolver);

  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  if (options.hostedEsign) {
    const hostedEsignService = new HostedEsignService({
      store: suiteStore,
      objectLoader: options.hostedEsign.objectLoader,
      rateLimiter: options.hostedEsign.rateLimiter,
    });
    app.use("/api/public/esign", createHostedEsignRouter({
      service: hostedEsignService,
      allowedOrigins: options.hostedEsign.allowedOrigins,
      clientKey: options.hostedEsign.clientKey,
      requireTls: true,
      trustForwardedProto: true,
    }));
  }
  app.post("/api/billing/webhook", express.raw({ type: "application/json", limit: "128kb" }), async (request, response) => {
    const signature = request.get("stripe-signature");
    if (!signature || !Buffer.isBuffer(request.body)) return response.status(400).json({ error: "A signed Stripe payload is required." });
    try {
      const result = await billing.webhook(request.body, signature);
      if ("userId" in result && result.userId) {
        const synced = await suiteStore.setWorkspacePlan(String(result.userId), await repository.getEffectiveSuitePlan(String(result.userId)));
        if (!synced) throw new Error("The paid workspace entitlement could not be synchronized; Stripe should retry this event.");
      }
      return response.json(result);
    } catch (error) {
      return response.status(400).json({ error: error instanceof Error ? error.message : "Stripe webhook rejected." });
    }
  });
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/public/")) {
      response.set("Access-Control-Allow-Origin", "*");
      response.set("Access-Control-Allow-Headers", "Content-Type");
      response.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      if (request.method === "OPTIONS") return response.status(204).send();
      return next();
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.get("origin");
      const allowed = new URL(config.PUBLIC_APP_URL);
      if (origin && new URL(origin).host !== allowed.host && new URL(origin).host !== request.get("host")) return response.status(403).json({ error: "Cross-site request rejected." });
    }
    next();
  });

  app.get("/.well-known/managed-oss-public-signing-keys.json", (_request, response) => {
    if (!publicSigning) return response.status(503).json({ error: "Public signing is not configured." });
    response.set("Cache-Control", "public, max-age=300, must-revalidate");
    return response.json({ purpose: "managed-oss-consent-policy-and-receipt-signing", keys: publicSigningVerificationKeys });
  });

  async function currentSessionUser(request: Request) {
    const token = request.cookies[sessionCookie];
    return token ? repository.findUserBySession(hashSessionToken(token)) : undefined;
  }
  async function synchronizedSuiteWorkspace(userId: string): Promise<SuiteWorkspace> {
    const workspace = await suiteStore.getOrCreateWorkspace(userId);
    if (options.synchronizeSuiteEntitlements === false) {
      if (process.env.NODE_ENV !== "test") throw new Error("Entitlement synchronization may only be bypassed by isolated tests.");
      return workspace;
    }
    if (suiteEntitlementMode === "unrestricted") {
      if (workspace.plan !== "none") return workspace;
      const updated = await suiteStore.setWorkspacePlan(workspace.userId, "fleet");
      if (!updated) throw new Error("The unrestricted self-hosted entitlement could not be initialized.");
      return suiteStore.getOrCreateWorkspace(userId);
    }
    const effectivePlan = await repository.getEffectiveSuitePlan(workspace.userId);
    if (effectivePlan === workspace.plan) return workspace;
    const updated = await suiteStore.setWorkspacePlan(workspace.userId, effectivePlan);
    if (!updated) throw new Error("The workspace billing entitlement could not be synchronized.");
    return suiteStore.getOrCreateWorkspace(userId);
  }
  async function requireUser(request: Request, response: Response, next: NextFunction) {
    const user = await currentSessionUser(request);
    if (!user) return response.status(401).json({ error: "Sign in to manage servers." });
    response.locals.user = user;
    next();
  }
  async function authorizeSuite(request: Request, response: Response, requiredScope: SuiteApiTokenScope) {
    const sessionUser = await currentSessionUser(request);
    if (sessionUser) {
      response.locals.user = sessionUser;
      response.locals.suiteAuthentication = { kind: "session" };
      return true;
    }
    const rawToken = bearerToken(request);
    const principal = rawToken ? await suiteStore.findApiTokenPrincipal(rawToken) : undefined;
    if (!principal) {
      response.status(401).json({ error: "Sign in or provide a valid suite API token." });
      return false;
    }
    if (!principal.scopes.includes(requiredScope)) {
      response.status(403).json({ error: `This API token requires the ${requiredScope} scope.`, requiredScope });
      return false;
    }
    const user = await repository.findUserById(principal.userId);
    if (!user) {
      response.status(401).json({ error: "This suite API token no longer has an account." });
      return false;
    }
    response.locals.user = user;
    response.locals.suiteAuthentication = { kind: "api-token", tokenId: principal.tokenId, scopes: principal.scopes };
    return true;
  }
  function requireSuiteScope(requiredScope: SuiteApiTokenScope) {
    return async (request: Request, response: Response, next: NextFunction) => {
      if (!await authorizeSuite(request, response, requiredScope)) return;
      const workspace = await synchronizedSuiteWorkspace(response.locals.user.id);
      response.locals.suiteWorkspace = workspace;
      if (requiredScope !== "read" && workspace.currentRole === "viewer") return response.status(403).json({ error: "Viewers cannot change this customer workspace." });
      next();
    };
  }
  async function requireSuiteActionScope(request: Request, response: Response, next: NextFunction) {
    const moduleId = String(request.params.id ?? "");
    const actionId = String(request.params.actionId ?? "");
    const action = suiteActionsByModule.get(moduleId)?.find((candidate) => candidate.id === actionId);
    const requiredScope: SuiteApiTokenScope = action ? suiteActionRequiredScope(action) : "write";
    if (!await authorizeSuite(request, response, requiredScope)) return;
    const workspace = await synchronizedSuiteWorkspace(response.locals.user.id);
    response.locals.suiteWorkspace = workspace;
    if (requiredScope !== "read" && workspace.currentRole === "viewer") return response.status(403).json({ error: "Viewers cannot run mutation actions in this customer workspace." });
    next();
  }
  async function issueSession(response: Response, userId: string) {
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
    await repository.createSession({ tokenHash: hashSessionToken(token), userId, expiresAt: expiresAt.toISOString() });
    response.cookie(sessionCookie, token, { httpOnly: true, sameSite: "lax", secure: config.PUBLIC_APP_URL.startsWith("https://"), path: "/", expires: expiresAt });
  }

  app.get("/api/health", (_request, response) => response.json({ ok: true, mode: config.PROVISIONING_MODE, persistence: repository.persistence }));
  app.get("/api/config", (_request, response) => response.json({ productName: config.PRODUCT_NAME, provisioningMode: config.PROVISIONING_MODE, persistence: repository.persistence, billingReady: billing.ready, stripePublishableKey: billing.ready ? config.STRIPE_PUBLISHABLE_KEY : undefined, plans: config.plans, platformFeePercent: config.PLATFORM_FEE_PERCENT, platformFeeMinimumCents: config.PLATFORM_FEE_MIN_CENTS }));
  app.get("/api/catalog", (_request, response) => response.json(catalog));
  app.get("/api/suite/catalog", (_request, response) => response.json(publicSuiteModules));
  app.get("/api/suite/actions", (_request, response) => response.json(suiteActions.map((action) => ({ ...action, inputSchema: suiteActionInputJsonSchema(action), exampleInput: suiteActionExampleInput(action), requiredScope: suiteActionRequiredScope(action), mcpTool: suiteActionToolName(action) }))));
  app.get("/oauth/google/start", oauthLimiter, async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("Referrer-Policy", "no-referrer");
    if (!managedGoogleOAuthBroker) return response.status(503).send("Platform Google sign-in is not configured.");
    const parsed = oauthStartSchema.safeParse(request.query);
    if (!parsed.success) return response.status(400).send("Google sign-in request is invalid.");
    try {
      return response.redirect(302, await managedGoogleOAuthBroker.begin({ applicationInstanceId: parsed.data.application_id, origin: parsed.data.origin, upstreamState: parsed.data.upstream_state }));
    } catch (error) {
      const status = error instanceof ManagedOAuthBrokerError ? error.status : 400;
      return response.status(status).send("Google sign-in could not be started.");
    }
  });
  app.get("/oauth/google/callback", oauthLimiter, async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("Referrer-Policy", "no-referrer");
    if (!managedGoogleOAuthBroker) return response.status(503).send("Platform Google sign-in is not configured.");
    const parsed = oauthCallbackSchema.safeParse(request.query);
    if (!parsed.success) return response.status(400).send("Google sign-in returned an invalid callback.");
    try {
      return managedOAuthPostHtml(response, await managedGoogleOAuthBroker.complete({ state: parsed.data.state, code: parsed.data.code, error: parsed.data.error, errorDescription: parsed.data.error_description }));
    } catch (error) {
      const status = error instanceof ManagedOAuthBrokerError ? error.status : 400;
      return response.status(status).send("Google sign-in could not be completed.");
    }
  });

  function requireWorkerBootstrap(request: Request, response: Response, next: NextFunction) {
    if (!tokenMatches(bearerToken(request), workerBootstrapToken)) return response.status(401).json({ error: "Worker bootstrap authorization failed." });
    next();
  }
  app.post("/api/agent/register", async (request, response) => {
    const parsed = workerRegistrationSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Worker registration is invalid." });
    const enrollmentCredential = bearerToken(request);
    if (gcpWorkerIdentityVerifier) {
      let identity: GcpWorkerIdentity;
      try {
        identity = await gcpWorkerIdentityVerifier.verify(enrollmentCredential ?? "");
      } catch {
        return response.status(401).json({ error: "Google Cloud worker identity was rejected." });
      }
      if (identity.instanceName !== parsed.data.id) return response.status(403).json({ error: "The verified Google Cloud instance cannot register this worker node ID." });
    } else if (!tokenMatches(enrollmentCredential, workerBootstrapToken)) {
      return response.status(401).json({ error: "Worker bootstrap authorization failed." });
    }
    if (await repository.getWorkerNodeActivity(parsed.data.id)) return response.status(409).json({ error: "This worker is already enrolled; use its existing agent credential or perform an explicit operator reset." });
    return response.status(201).json(await repository.registerWorkerNode(parsed.data));
  });
  app.get("/api/internal/workers/:id/activity", requireWorkerBootstrap, async (request, response) => {
    const nodeId = workerNodeIdSchema.safeParse(request.params.id);
    if (!nodeId.success) return response.status(400).json({ error: "Worker node ID is invalid." });
    const activity = await repository.getWorkerNodeActivity(nodeId.data);
    return activity ? response.json({ activity }) : response.status(404).json({ error: "Worker node not found." });
  });
  app.post("/api/internal/workers/:id/mode", requireWorkerBootstrap, async (request, response) => {
    const nodeId = workerNodeIdSchema.safeParse(request.params.id);
    const mode = workerModeSchema.safeParse(request.body);
    if (!nodeId.success || !mode.success) return response.status(400).json({ error: "Worker node mode request is invalid." });
    const activity = await repository.setWorkerNodeMode(nodeId.data, mode.data.mode);
    return activity ? response.json({ activity }) : response.status(404).json({ error: "Worker node not found." });
  });
  async function requireAgent(request: Request, response: Response, next: NextFunction) {
    const token = bearerToken(request);
    const node = token ? await repository.findWorkerNodeByAgentToken(token) : undefined;
    if (!node) return response.status(401).json({ error: "Worker authorization failed." });
    response.locals.workerNode = node;
    next();
  }
  app.get("/api/agent/activity", requireAgent, async (_request, response) => {
    const activity = await repository.getWorkerNodeActivity(response.locals.workerNode.id);
    return activity ? response.json({ activity }) : response.status(404).json({ error: "Worker node no longer exists." });
  });
  app.post("/api/agent/heartbeat", requireAgent, async (request, response) => {
    const parsed = workerHeartbeatSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Worker heartbeat is invalid." });
    const node = await repository.heartbeatWorkerNode(response.locals.workerNode.id, parsed.data);
    return node ? response.json({ node }) : response.status(404).json({ error: "Worker node no longer exists." });
  });
  app.post("/api/agent/jobs/claim", requireAgent, async (_request, response) => {
    if (!agentJobsEnabled) return response.status(204).send();
    const job = await repository.claimWorkerJob(response.locals.workerNode.id);
    return job ? response.json({ job }) : response.status(204).send();
  });
  app.post("/api/agent/jobs/:id/report", requireAgent, async (request, response) => {
    const parsed = workerReportSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Worker report is invalid." });
    const accepted = await repository.reportWorkerJob(response.locals.workerNode.id, String(request.params.id), parsed.data);
    return accepted ? response.status(204).send() : response.status(409).json({ error: "The job lease is no longer active for this worker." });
  });
  app.get("/api/agent/routes", requireAgent, async (_request, response) => response.json({ routes: await repository.listWorkerNodeRoutes(response.locals.workerNode.id) }));
  app.get("/api/internal/gateway/routes", async (request, response) => {
    if (!tokenMatches(bearerToken(request), gatewayReconcilerToken)) return response.status(401).json({ error: "Gateway authorization failed." });
    return response.json({ routes: await repository.listGatewayRoutes(), controlPlaneHosts: await suiteStore.listActiveCustomDomains() });
  });

  app.post("/api/auth/signup", authLimiter, async (request, response) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Use a valid email, name, and password of at least 10 characters." });
    if (await repository.findUserByEmail(parsed.data.email)) return response.status(409).json({ error: "An account already uses that email." });
    const user = await repository.createUser({ email: parsed.data.email, displayName: parsed.data.displayName, passwordHash: await hashPassword(parsed.data.password) });
    await issueSession(response, user.id);
    return response.status(201).json({ user: publicUser(user), persistence: repository.persistence });
  });
  app.post("/api/auth/login", authLimiter, async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid email and password." });
    const user = await repository.findUserByEmail(parsed.data.email);
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) return response.status(401).json({ error: "Email or password is incorrect." });
    await issueSession(response, user.id);
    return response.json({ user: publicUser(user), persistence: repository.persistence });
  });
  app.post("/api/auth/logout", async (request, response) => {
    const token = request.cookies[sessionCookie];
    if (token) await repository.deleteSession(hashSessionToken(token));
    response.clearCookie(sessionCookie, { path: "/" });
    return response.status(204).send();
  });
  app.get("/api/me", async (request, response) => {
    const user = await currentSessionUser(request);
    return user ? response.json({ user: publicUser(user), persistence: repository.persistence }) : response.status(401).json({ user: null });
  });
  app.get("/api/dashboard", requireUser, async (_request, response) => {
    const user = response.locals.user;
    return response.json({ user: publicUser(user), installations: await repository.listInstallations(user.id), persistence: repository.persistence, billingReady: billing.ready, provisioningMode: config.PROVISIONING_MODE });
  });

  app.get("/api/suite/workspace", requireSuiteScope("read"), async (_request, response) => {
    const workspace = response.locals.suiteWorkspace as SuiteWorkspace;
    return response.json({ workspace, modules: publicSuiteModules, persistence: suiteStore.persistence });
  });
  app.get("/api/suite/usage", requireSuiteScope("read"), async (_request, response) => {
    return response.json({ usage: await suiteStore.getUsage(response.locals.user.id) });
  });
  app.get("/api/suite/members", requireUser, async (_request, response) => {
    const workspace = await suiteStore.getOrCreateWorkspace(response.locals.user.id);
    const members = await suiteStore.listWorkspaceMembers(response.locals.user.id);
    const resolved = await Promise.all(members.map(async (member) => {
      const user = await repository.findUserById(member.userId);
      return { ...member, email: user?.email, displayName: user?.displayName };
    }));
    return response.json({ workspaceId: workspace.id, currentRole: workspace.currentRole, members: resolved });
  });
  app.post("/api/suite/members", requireUser, async (request, response) => {
    const parsed = workspaceMemberSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Provide an existing account email and an admin, member, or viewer role." });
    const target = await repository.findUserByEmail(parsed.data.email);
    if (!target) return response.status(404).json({ error: "That person must create an account before being added." });
    if (target.id === response.locals.user.id) return response.status(409).json({ error: "Your account is already in this workspace." });
    const member = await suiteStore.addWorkspaceMember(response.locals.user.id, target.id, parsed.data.role);
    return member ? response.status(201).json({ member: { ...member, email: target.email, displayName: target.displayName } }) : response.status(409).json({ error: "Only owners and admins can add an account that is not already in another workspace." });
  });
  app.delete("/api/suite/members/:id", requireUser, async (request, response) => {
    const parsed = z.string().uuid().safeParse(request.params.id);
    if (!parsed.success) return response.status(400).json({ error: "Provide a valid workspace member ID." });
    return await suiteStore.removeWorkspaceMember(response.locals.user.id, parsed.data)
      ? response.status(204).send()
      : response.status(409).json({ error: "Only owners and admins can remove a non-owner member from this workspace." });
  });
  app.get("/api/suite/domains", requireSuiteScope("read"), async (_request, response) => {
    return response.json({ domains: await suiteStore.listCustomDomains(response.locals.user.id) });
  });
  app.post("/api/suite/domains", requireSuiteScope("write"), async (request, response) => {
    const parsed = domainSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid custom domain." });
    const workspace = response.locals.suiteWorkspace as SuiteWorkspace;
    if (workspace.plan === "none" && suiteEntitlementMode !== "unrestricted") return response.status(409).json({ error: `Custom domains require an active ${suitePlanDescription("starter")} plan.`, requiredPlan: "starter" });
    try {
      const domain = await suiteStore.addCustomDomain(response.locals.user.id, parsed.data.domain);
      return domain ? response.status(201).json({ domain, dns: domain.ownership }) : response.status(409).json({ error: "Only workspace owners and admins can claim a hostname that has never been reserved." });
    } catch (error) {
      return response.status(409).json({ error: safeDomainClaimError(error) });
    }
  });
  app.post("/api/suite/domains/:domain/verify", requireSuiteScope("write"), async (request, response) => {
    const parsed = domainSchema.safeParse({ domain: request.params.domain });
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid custom domain." });
    const workspace = response.locals.suiteWorkspace as SuiteWorkspace;
    if (workspace.plan === "none" && suiteEntitlementMode !== "unrestricted") return response.status(409).json({ error: `Domain verification requires an active ${suitePlanDescription("starter")} plan.`, requiredPlan: "starter" });
    const owned = (await suiteStore.listCustomDomains(response.locals.user.id)).find((item) => item.domain === parsed.data.domain);
    if (!owned) return response.status(404).json({ error: "This custom domain does not belong to the customer workspace." });
    const result = await verifyDomain(owned.ownership, options.domainResolver);
    const domain = await suiteStore.setCustomDomainStatus(response.locals.user.id, parsed.data.domain, result.verified ? "verified" : "awaiting-dns");
    return response.status(result.verified ? 200 : 409).json({ ...result, domain, expected: owned.ownership });
  });
  app.post("/api/suite/modules/:id/enable", requireSuiteScope("write"), async (request, response) => {
    const parsed = moduleIdSchema.safeParse(request.params);
    const module = parsed.success ? suiteModuleById.get(parsed.data.id) : undefined;
    if (!module) return response.status(404).json({ error: "Suite module not found." });
    const workspace = await suiteStore.getOrCreateWorkspace(response.locals.user.id);
    if (workspace.currentRole !== "owner" && workspace.currentRole !== "admin") return response.status(403).json({ error: "Only workspace owners and admins can enable modules." });
    if (suiteEntitlementMode !== "unrestricted" && !suitePlanAllows(workspace.plan, module)) return response.status(409).json({ error: `${module.name} requires the ${suitePlanDescription(module.minPlan)} plan.`, requiredPlan: module.minPlan });
    const updated = await suiteStore.enableModule(response.locals.user.id, module.id);
    return response.status(201).json({ workspace: updated, module });
  });
  app.post("/api/suite/modules/:id/actions/:actionId", requireSuiteActionScope, async (request, response) => {
    const parsedModule = moduleIdSchema.safeParse(request.params);
    const module = parsedModule.success ? suiteModuleById.get(parsedModule.data.id) : undefined;
    const parsed = suiteActionSchema.safeParse(request.body);
    const actionId = String(request.params.actionId ?? "");
    if (!module || !suiteActionsByModule.get(module.id)?.some((action) => action.id === actionId)) return response.status(404).json({ error: "Module action not found." });
    if (!parsed.success) return response.status(400).json({ error: "Action input must be a JSON object." });
    try {
      const result = await suiteStore.runInWorkspaceTransaction(response.locals.user.id, () => executeSuiteAction(suiteStore, response.locals.user.id, module.id, actionId, parsed.data.input, { verifyExtendedExternalEvidence }));
      return response.status(result.kind === "record" ? 201 : result.kind === "command" || result.kind === "read" ? 200 : 202).json(result);
    } catch (error) {
      return response.status(409).json({ error: error instanceof Error ? error.message : "The module action could not run." });
    }
  });
  app.get("/api/suite/records", requireSuiteScope("read"), async (request, response) => {
    const parsed = suiteRecordQuerySchema.safeParse(request.query);
    if (!parsed.success) return response.status(400).json({ error: "Invalid record query." });
    if (parsed.data.moduleId && !suiteModuleById.has(parsed.data.moduleId)) return response.status(404).json({ error: "Suite module not found." });
    return response.json({ records: await suiteStore.listRecords(response.locals.user.id, parsed.data) });
  });
  app.post("/api/suite/records", requireSuiteScope("write"), (_request, response) => response.status(410).json({
    error: "Generic record creation is disabled because it bypasses typed validation, idempotency, approval, and audit receipts.",
    replacement: "POST /api/suite/modules/:moduleId/actions/:actionId",
  }));
  app.patch("/api/suite/records/:id", requireSuiteScope("write"), (_request, response) => response.status(410).json({
    error: "Generic record updates are disabled because state changes must use a typed, version-checked module action.",
    replacement: "POST /api/suite/modules/:moduleId/actions/:actionId",
  }));
  app.post("/api/suite/ai-actions", requireSuiteScope("ai"), (_request, response) => response.status(410).json({
    error: "Generic AI queueing is disabled because every model request must use a pinned prompt and typed evidence contract.",
    replacement: "POST /api/suite/modules/:moduleId/actions/:actionId",
  }));
  app.get("/api/suite/ai-actions/:id", requireSuiteScope("read"), async (request, response) => {
    if (!z.string().uuid().safeParse(request.params.id).success) return response.status(400).json({ error: "Provide a valid AI action ID." });
    const action = await suiteStore.getAiAction(response.locals.user.id, String(request.params.id));
    return action ? response.json({ action }) : response.status(404).json({ error: "AI action not found." });
  });
  app.post("/api/suite/api-tokens", requireUser, async (request, response) => {
    const parsed = apiTokenSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Give this CLI or MCP token a name, one or more valid scopes, and an expiry of 1 to 365 days." });
    const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString();
    try {
      const token = await suiteStore.createApiToken(response.locals.user.id, { name: parsed.data.name, scopes: parsed.data.scopes, expiresAt });
      return response.status(201).json({ token, warning: "Copy this token now. It is not shown again." });
    } catch (error) {
      return response.status(403).json({ error: error instanceof Error ? error.message : "This token cannot be created for the current workspace role." });
    }
  });
  app.get("/api/suite/api-tokens", requireUser, async (_request, response) => {
    return response.json({ tokens: await suiteStore.listApiTokens(response.locals.user.id) });
  });
  app.delete("/api/suite/api-tokens/:id", requireUser, async (request, response) => {
    const parsed = z.string().uuid().safeParse(request.params.id);
    if (!parsed.success) return response.status(400).json({ error: "Provide a valid API token ID." });
    return await suiteStore.revokeApiToken(response.locals.user.id, parsed.data)
      ? response.status(204).send()
      : response.status(404).json({ error: "API token not found." });
  });

  app.get("/api/public/consent/sites/:siteId/policy", async (request, response) => {
    const parsed = publicConsentSiteSchema.safeParse(request.params);
    if (!parsed.success) return response.status(400).json({ error: "Provide a valid consent site ID." });
    if (!publicSigning) return response.status(503).json({ error: "Signed consent policy delivery is not configured." });
    const hostname = request.hostname.toLowerCase();
    const workspace = await suiteStore.getWorkspaceByCustomDomain(hostname);
    if (!workspace) return response.status(404).json({ error: "Consent policy not found." });
    const sites = await suiteStore.listPublicWorkflowRecords(workspace.slug, { moduleId: "consent", recordType: "site", limit: 10_000 });
    const site = sites.find((candidate) => candidate.id === parsed.data.siteId && candidate.state === "verified" && candidate.data.verified === true && candidate.data.domain === hostname && candidate.data.canonicalOrigin === `https://${hostname}`);
    if (!site) return response.status(404).json({ error: "Consent policy not found." });
    const revisions = await suiteStore.listPublicRecords(workspace.slug, { moduleId: "consent", recordType: "policy-revision", limit: 10_000 });
    const revision = revisions.find((candidate) => candidate.data.siteId === site.id && candidate.state === "published");
    if (!revision || !revision.data.content || typeof revision.data.contentHash !== "string") return response.status(404).json({ error: "Consent policy not found." });
    const payload = {
      workspace: workspace.slug,
      siteId: site.id,
      origin: site.data.canonicalOrigin,
      revisionId: revision.id,
      version: revision.data.version,
      contentHash: revision.data.contentHash,
      publishedAt: revision.data.publishedAt,
      policy: revision.data.content,
    };
    response.set("Cache-Control", "public, max-age=60, must-revalidate");
    return response.json({ payload, signature: publicSigning.sign(payload) });
  });

  app.post("/api/public/consent/sites/:siteId/choices", publicWriteLimiter, async (request, response) => {
    const parsedSite = publicConsentSiteSchema.safeParse(request.params);
    const parsed = publicConsentChoiceSchema.safeParse(request.body);
    if (!parsedSite.success || !parsed.success) return response.status(400).json({ error: "Provide a valid consent choice, revision, visitor key, and idempotency key." });
    if (!publicSigning) return response.status(503).json({ error: "Signed consent receipt delivery is not configured." });
    const hostname = request.hostname.toLowerCase();
    const workspace = await suiteStore.getWorkspaceByCustomDomain(hostname);
    if (!workspace) return response.status(404).json({ error: "Consent site not found." });
    const sites = await suiteStore.listPublicWorkflowRecords(workspace.slug, { moduleId: "consent", recordType: "site", limit: 10_000 });
    const site = sites.find((candidate) => candidate.id === parsedSite.data.siteId && candidate.state === "verified" && candidate.data.verified === true && candidate.data.domain === hostname && candidate.data.canonicalOrigin === `https://${hostname}`);
    if (!site) return response.status(404).json({ error: "Consent site not found." });
    const requestOrigin = request.get("origin");
    let normalizedRequestOrigin: string | undefined;
    try { normalizedRequestOrigin = requestOrigin ? new URL(requestOrigin).origin : undefined; } catch { normalizedRequestOrigin = undefined; }
    if (!normalizedRequestOrigin || normalizedRequestOrigin !== site.data.canonicalOrigin) return response.status(403).json({ error: "Consent choices must originate from the verified site origin." });
    const revisions = await suiteStore.listPublicRecords(workspace.slug, { moduleId: "consent", recordType: "policy-revision", limit: 10_000 });
    const revision = revisions.find((candidate) => candidate.id === parsed.data.revisionId && candidate.data.siteId === site.id && candidate.state === "published");
    if (!revision) return response.status(409).json({ error: "The selected consent policy is not the active published revision." });
    const purposes = (revision.data.content as { purposes?: unknown[] } | undefined)?.purposes;
    if (!Array.isArray(purposes) || !purposes.length) return response.status(409).json({ error: "The active policy has no valid purpose snapshot." });
    const expected = new Map<string, boolean>();
    for (const item of purposes) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).key !== "string") return response.status(409).json({ error: "The active policy purpose snapshot is invalid." });
      expected.set(String((item as Record<string, unknown>).key), (item as Record<string, unknown>).required === true);
    }
    const requestedDecisions = parsed.data.action === "revoke"
      ? [...expected].map(([key, required]) => ({ key, allowed: required }))
      : parsed.data.decisions ?? [];
    const decisionKeys = new Set(requestedDecisions.map((decision) => decision.key));
    const invalidDecision = requestedDecisions.some((decision) => !expected.has(decision.key) || (expected.get(decision.key) === true && decision.allowed !== true));
    if (invalidDecision || decisionKeys.size !== requestedDecisions.length || decisionKeys.size !== expected.size) return response.status(400).json({ error: "Decisions must contain one valid choice for every purpose; required purposes cannot be rejected." });
    const decisions = [...requestedDecisions].sort((left, right) => left.key.localeCompare(right.key));
    const visitorHash = createHash("sha256").update(`${site.id}:${parsed.data.visitorKey}`, "utf8").digest("hex");
    const idempotencyHash = createHash("sha256").update(`${site.id}:${parsed.data.idempotencyKey}`, "utf8").digest("hex");
    const requestHash = createHash("sha256").update(JSON.stringify({ action: parsed.data.action, revisionId: revision.id, visitorHash, decisions, gpc: parsed.data.gpc === true }), "utf8").digest("hex");
    let receipts = await suiteStore.listPublicWorkflowRecords(workspace.slug, { moduleId: "consent", recordType: "consent-receipt", limit: 10_000 });
    const replay = receipts.find((candidate) => candidate.data.publicIdempotencyHash === idempotencyHash);
    if (replay) {
      if (replay.data.publicRequestHash !== requestHash) return response.status(409).json({ error: "The idempotency key was already used for a different consent choice." });
      return response.json({ receiptId: replay.id, payload: replay.data.signedPayload, signature: replay.data.signature, replayed: true });
    }
    const prior = receipts.find((candidate) => candidate.data.siteId === site.id && candidate.data.visitorHash === visitorHash);
    const recordedAt = new Date().toISOString();
    const receiptId = randomUUID();
    const signedPayload = {
      schema: "managed-oss-consent-receipt",
      version: 1,
      receiptId,
      workspace: workspace.slug,
      siteId: site.id,
      origin: site.data.canonicalOrigin,
      revisionId: revision.id,
      contentHash: revision.data.contentHash,
      visitorId: visitorHash,
      action: parsed.data.action,
      decisions,
      gpc: parsed.data.gpc === true,
      priorReceiptId: prior?.id,
      recordedAt,
    };
    const signature = publicSigning.sign(signedPayload);
    let receipt;
    try {
      receipt = await suiteStore.createPublicRecord(workspace.slug, {
        id: receiptId,
        moduleId: "consent",
        recordType: "consent-receipt",
        title: `Receipt ${requestHash.slice(0, 12)}`,
        state: parsed.data.action === "revoke" ? "revoked" : "active",
        data: { siteId: site.id, revisionId: revision.id, visitorHash, decisions, gpc: parsed.data.gpc === true, priorReceiptId: prior?.id, publicIdempotencyHash: idempotencyHash, publicRequestHash: requestHash, signedPayload, signature, sequence: receipts.filter((candidate) => candidate.data.siteId === site.id).length + 1, public: false },
      });
    } catch {
      receipts = await suiteStore.listPublicWorkflowRecords(workspace.slug, { moduleId: "consent", recordType: "consent-receipt", limit: 10_000 });
      const concurrentReplay = receipts.find((candidate) => candidate.data.publicIdempotencyHash === idempotencyHash);
      if (concurrentReplay?.data.publicRequestHash === requestHash) return response.json({ receiptId: concurrentReplay.id, payload: concurrentReplay.data.signedPayload, signature: concurrentReplay.data.signature, replayed: true });
      if (concurrentReplay) return response.status(409).json({ error: "The idempotency key was already used for a different consent choice." });
      throw new Error("The consent receipt could not be appended.");
    }
    if (!receipt) return response.status(404).json({ error: "Consent receipt collection is not enabled." });
    if (receipt.id !== signedPayload.receiptId) throw new Error("The signed consent receipt ID did not match the persisted record.");
    return response.status(201).json({ receiptId: receipt.id, payload: signedPayload, signature, replayed: false });
  });

  app.get("/api/public/seo/reports/:token", async (request, response) => {
    const token = publicSeoReportTokenSchema.safeParse(request.params.token);
    if (!token.success) return response.status(404).json({ error: "SEO report not found." });
    const hostname = request.hostname.toLowerCase();
    const workspace = await suiteStore.getWorkspaceByCustomDomain(hostname);
    if (!workspace) return response.status(404).json({ error: "SEO report not found." });
    const tokenHash = createHash("sha256").update(token.data, "utf8").digest("hex");
    const reports = await suiteStore.listPublicWorkflowRecords(workspace.slug, { moduleId: "seo", recordType: "report", limit: 10_000 });
    const report = reports.find((candidate) => candidate.state === "published" && candidate.data.domain === hostname && tokenMatches(String(candidate.data.accessTokenHash ?? ""), tokenHash));
    if (!report) return response.status(404).json({ error: "SEO report not found." });
    response.set("Cache-Control", "no-store");
    return response.json({ report: { id: report.id, title: report.title, publishedAt: report.data.publishedAt, snapshotHash: report.data.snapshotHash, snapshot: report.data.snapshot } });
  });

  app.get("/api/public/:workspaceSlug/:moduleId", async (request, response) => {
    const parsed = publicWorkspaceSchema.safeParse(request.params);
    if (!parsed.success) return response.status(404).json({ error: "Public workspace surface not found." });
    if (parsed.data.moduleId === "testimonials") {
      try { return response.json({ moduleId: "testimonials", records: await publicGrowth.testimonialsBySlug(parsed.data.workspaceSlug) }); }
      catch (error) { return publicGrowthFailure(response, error); }
    }
    if (parsed.data.moduleId === "giveaways") {
      try { return response.json({ moduleId: "giveaways", records: await publicGrowth.contestsBySlug(parsed.data.workspaceSlug) }); }
      catch (error) { return publicGrowthFailure(response, error); }
    }
    if (parsed.data.moduleId === "brand-pages") return response.json({ moduleId: "brand-pages", records: [] });
    const recordType = parsed.data.moduleId === "knowledge" ? "page" : undefined;
    const records = await suiteStore.listPublicRecords(parsed.data.workspaceSlug, { moduleId: parsed.data.moduleId, recordType, limit: 100 });
    return response.json({ moduleId: parsed.data.moduleId, records: records.map((record) => publicRecordProjection(record, parsed.data.moduleId)) });
  });
  app.post("/api/public/:workspaceSlug/feedback", publicWriteLimiter, async (request, response) => {
    const workspaceSlug = String(request.params.workspaceSlug);
    const parsed = publicFeedbackSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Provide a title and feedback description." });
    const record = await suiteStore.createPublicRecord(workspaceSlug, { moduleId: "feedback", recordType: "suggestion", title: parsed.data.title, state: "open", data: { description: parsed.data.description, email: parsed.data.email, source: "public-form", public: false } });
    return record ? response.status(201).json({ id: record.id, state: record.state }) : response.status(404).json({ error: "Feedback collection is not enabled for this workspace." });
  });
  app.post("/api/public/:workspaceSlug/testimonials", publicWriteLimiter, (_request, response) => response.status(404).json({ error: "Use a token-bound ProofPort collection request." }));
  app.post("/api/public/:workspaceSlug/giveaways/:contestId/entries", publicWriteLimiter, async (request, response) => {
    const workspaceSlug = String(request.params.workspaceSlug);
    const contestId = z.string().uuid().safeParse(request.params.contestId);
    const parsed = publicEntrySchema.safeParse(request.body);
    if (!contestId.success || !parsed.success) return response.status(400).json({ error: "A valid contest, pseudonymous participant hash, and policy-bound consent are required." });
    try {
      const entry = await publicGrowth.enterGiveawayBySlug(workspaceSlug, contestId.data, parsed.data);
      return response.status(entry.replayed ? 200 : 201).json(entry);
    } catch (error) { return publicGrowthFailure(response, error); }
  });
  const routeKitDestination = async (workspaceSlug: string, code: string, hostname?: string) => {
    const [routes, versions, receipts] = await Promise.all([
      suiteStore.listPublicWorkflowRecords(workspaceSlug, { moduleId: "links", recordType: "link-route", limit: 10_000 }),
      suiteStore.listPublicWorkflowRecords(workspaceSlug, { moduleId: "links", recordType: "destination-version", limit: 10_000 }),
      suiteStore.listPublicWorkflowRecords(workspaceSlug, { moduleId: "links", recordType: "command-receipt", limit: 10_000 }),
    ]);
    const candidates = routes.filter((route) => route.state === "active" && route.data.slug === code && (!hostname || route.data.hostname === hostname));
    if (candidates.length !== 1 || typeof candidates[0].data.activeDestinationVersionId !== "string") return undefined;
    const route = candidates[0];
    const version = versions.find((candidate) => candidate.id === route.data.activeDestinationVersionId && candidate.state === "published" && candidate.data.routeId === route.id && candidate.data.contentHash === route.data.activeContentHash);
    const destination = version ? safePublicHttpsUrl(version.data.destination) : undefined;
    const receipt = receipts.find((candidate) => candidate.data.actionId === "destination-publish" && Array.isArray(candidate.data.resultRecordIds) && candidate.data.resultRecordIds.includes(route.id) && candidate.data.resultRecordIds.includes(version?.id));
    const audit = receipt?.data.audit && typeof receipt.data.audit === "object" ? receipt.data.audit as Record<string, unknown> : undefined;
    if (!version || !destination || !/^[a-f0-9]{64}$/.test(String(version.data.contentHash ?? "")) || typeof audit?.approvalDecisionId !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(audit.approvalDecisionId)) return undefined;
    return { route, destination };
  };

  app.get("/r/:workspaceSlug/:code", publicRedirectLimiter, async (request, response) => {
    const resolved = await routeKitDestination(String(request.params.workspaceSlug), String(request.params.code));
    const destination = resolved ? await checkedPublicDestination(resolved.destination) : undefined;
    return destination ? response.redirect(302, destination) : response.status(404).send("Link not found.");
  });
  app.get("/r/:code", publicRedirectLimiter, async (request, response) => {
    const workspace = await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase());
    if (!workspace) return response.status(404).send("Custom workspace domain not found.");
    const resolved = await routeKitDestination(workspace.slug, String(request.params.code), request.hostname.toLowerCase());
    const destination = resolved ? await checkedPublicDestination(resolved.destination) : undefined;
    return destination ? response.redirect(302, destination) : response.status(404).send("Link not found.");
  });

  app.get("/out/:workspaceId/:pageVersionId/:destinationVersionId", publicRedirectLimiter, async (request, response) => {
    const parsed = z.object({ workspaceId: z.string().uuid(), pageVersionId: z.string().uuid(), destinationVersionId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return response.status(404).send("Destination not found.");
    try {
      const page = await publicGrowth.pageByWorkspaceId(parsed.data.workspaceId, parsed.data.pageVersionId);
      const link = page.links.find((candidate) => candidate.destinationVersionId === parsed.data.destinationVersionId);
      const destination = link ? await checkedPublicDestination(link.destination) : undefined;
      if (!link || !destination) return response.status(404).send("Destination not found.");
      const requestHost = request.hostname.toLowerCase();
      const platformHost = new URL(config.PUBLIC_APP_URL).hostname.toLowerCase();
      if (requestHost !== platformHost) {
        const workspace = await suiteStore.getWorkspaceByCustomDomain(requestHost);
        if (workspace?.id !== page.workspaceId) return response.status(404).send("Destination not found.");
      }
      const nonce = randomBytes(18).toString("base64");
      const destinationHost = new URL(destination).hostname;
      response.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "Content-Security-Policy": `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; style-src 'nonce-${nonce}'`,
      });
      return response.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Continue to ${escapeHtml(destinationHost)}</title><style nonce="${escapeHtml(nonce)}">body{margin:0;display:grid;min-height:100vh;place-items:center;font:16px system-ui;background:#f5f4ef;color:#15171d}main{width:min(90%,36rem);text-align:center}a{display:inline-block;margin-top:1rem;padding:.85rem 1.1rem;border-radius:.7rem;background:#15171d;color:#fff;text-decoration:none}</style></head><body><main><h1>Continue to ${escapeHtml(destinationHost)}?</h1><p>This external destination was checked for a current public network address. DNS can change after this check, so continue only if you recognize the domain.</p><a href="${escapeHtml(destination)}" rel="noopener noreferrer nofollow">Continue</a></main></body></html>`);
    } catch (error) { return error instanceof PublicGrowthError ? response.status(404).send("Destination not found.") : Promise.reject(error); }
  });

  app.get("/p/:workspaceSlug/:slug", async (request, response) => {
    try {
      const page = await publicGrowth.pageBySlug(String(request.params.workspaceSlug), String(request.params.slug));
      response.set("Cache-Control", "public, max-age=60");
      return response.type("html").send(publishedPageHtml(page));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("Page not found.") : Promise.reject(error); }
  });
  app.get("/p/:slug", async (request, response) => {
    const workspace = await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase());
    if (!workspace) return response.status(404).send("Custom workspace domain not found.");
    try {
      const page = await publicGrowth.pageBySlug(workspace.slug, String(request.params.slug));
      response.set("Cache-Control", "public, max-age=60");
      return response.type("html").send(publishedPageHtml(page));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("Page not found.") : Promise.reject(error); }
  });
  app.get("/embeds/pages/:workspaceId/:pageVersionId", async (request, response) => {
    const parsed = publicPageEmbedParamsSchema.safeParse(request.params);
    if (!parsed.success) return response.status(404).send("Published page not found.");
    try {
      const page = await publicGrowth.pageByWorkspaceId(parsed.data.workspaceId, parsed.data.pageVersionId);
      response.set("Cache-Control", "public, max-age=60");
      return response.type("html").send(publishedPageHtml(page));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("Published page not found.") : Promise.reject(error); }
  });
  app.get("/embeds/pages/:pageVersionId", async (request, response) => {
    const parsed = customDomainPageEmbedParamsSchema.safeParse(request.params);
    const workspace = parsed.success ? await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase()) : undefined;
    if (!parsed.success || !workspace) return response.status(404).send("Published page not found.");
    try {
      const page = await publicGrowth.pageByWorkspaceId(workspace.id, parsed.data.pageVersionId);
      response.set("Cache-Control", "public, max-age=60");
      return response.type("html").send(publishedPageHtml(page));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("Published page not found.") : Promise.reject(error); }
  });

  app.get("/q/:workspaceSlug/:name.svg", async (request, response) => {
    try {
      const qr = await publicGrowth.qrBySlug(String(request.params.workspaceSlug), String(request.params.name));
      const stableUrl = `${new URL(config.PUBLIC_APP_URL).origin}/q/${encodeURIComponent(String(request.params.workspaceSlug))}/${encodeURIComponent(qr.slug)}`;
      const svg = await QRCode.toString(stableUrl, { type: "svg", errorCorrectionLevel: qr.style.errorCorrection, margin: 2, color: { dark: qr.style.foreground, light: qr.style.background } });
      response.set("Cache-Control", "public, max-age=300");
      return response.type("image/svg+xml").send(svg);
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("QR code not found.") : Promise.reject(error); }
  });
  app.get("/q/:workspaceSlug/:name", publicRedirectLimiter, async (request, response) => {
    try {
      const destination = await checkedPublicDestination((await publicGrowth.qrBySlug(String(request.params.workspaceSlug), String(request.params.name))).destination);
      return destination ? response.redirect(302, destination) : response.status(404).send("QR route not found.");
    }
    catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("QR route not found.") : Promise.reject(error); }
  });
  app.get("/q/:name.svg", async (request, response) => {
    const workspace = await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase());
    if (!workspace) return response.status(404).send("Custom workspace domain not found.");
    try {
      const qr = await publicGrowth.qrBySlug(workspace.slug, String(request.params.name));
      const stableUrl = `https://${request.hostname.toLowerCase()}/q/${encodeURIComponent(qr.slug)}`;
      const svg = await QRCode.toString(stableUrl, { type: "svg", errorCorrectionLevel: qr.style.errorCorrection, margin: 2, color: { dark: qr.style.foreground, light: qr.style.background } });
      response.set("Cache-Control", "public, max-age=300");
      return response.type("image/svg+xml").send(svg);
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("QR code not found.") : Promise.reject(error); }
  });
  app.get("/q/:name", publicRedirectLimiter, async (request, response) => {
    const workspace = await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase());
    if (!workspace) return response.status(404).send("Custom workspace domain not found.");
    try {
      const destination = await checkedPublicDestination((await publicGrowth.qrBySlug(workspace.slug, String(request.params.name))).destination);
      return destination ? response.redirect(302, destination) : response.status(404).send("QR route not found.");
    }
    catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("QR route not found.") : Promise.reject(error); }
  });

  app.get("/api/public/testimonials/:workspaceId/widgets/:widgetVersionId", async (request, response) => {
    const parsed = publicWidgetParamsSchema.safeParse(request.params);
    if (!parsed.success) return response.status(404).json({ error: "Published testimonial widget not found." });
    try { return response.json({ widget: await publicGrowth.widgetByWorkspaceId(parsed.data.workspaceId, parsed.data.widgetVersionId) }); }
    catch (error) { return publicGrowthFailure(response, error); }
  });
  app.get("/api/public/testimonials/widgets/:widgetVersionId", async (request, response) => {
    const parsed = customDomainWidgetParamsSchema.safeParse(request.params);
    const workspace = parsed.success ? await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase()) : undefined;
    if (!parsed.success || !workspace) return response.status(404).json({ error: "Published testimonial widget not found." });
    try { return response.json({ widget: await publicGrowth.widgetByWorkspaceId(workspace.id, parsed.data.widgetVersionId) }); }
    catch (error) { return publicGrowthFailure(response, error); }
  });
  app.get("/api/public/testimonials", async (request, response) => {
    const workspace = await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase());
    if (!workspace) return response.status(404).json({ error: "Custom workspace domain not found." });
    try { return response.json({ moduleId: "testimonials", records: await publicGrowth.testimonialsByWorkspaceId(workspace.id) }); }
    catch (error) { return publicGrowthFailure(response, error); }
  });
  app.get("/embeds/testimonials/:workspaceId/:widgetVersionId", async (request, response) => {
    const parsed = publicWidgetParamsSchema.safeParse(request.params);
    if (!parsed.success) return response.status(404).send("Published testimonial widget not found.");
    try {
      const widget = await publicGrowth.widgetByWorkspaceId(parsed.data.workspaceId, parsed.data.widgetVersionId);
      response.set("Cache-Control", "public, max-age=60");
      return response.type("html").send(publishedWidgetHtml(widget));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("Published testimonial widget not found.") : Promise.reject(error); }
  });
  app.get("/embeds/testimonials/:widgetVersionId", async (request, response) => {
    const parsed = customDomainWidgetParamsSchema.safeParse(request.params);
    const workspace = parsed.success ? await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase()) : undefined;
    if (!parsed.success || !workspace) return response.status(404).send("Published testimonial widget not found.");
    try {
      const widget = await publicGrowth.widgetByWorkspaceId(workspace.id, parsed.data.widgetVersionId);
      response.set("Cache-Control", "public, max-age=60");
      return response.type("html").send(publishedWidgetHtml(widget));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send("Published testimonial widget not found.") : Promise.reject(error); }
  });
  app.get("/widgets/testimonials.js", (_request, response) => {
    response.set("Access-Control-Allow-Origin", "*");
    response.set("Cache-Control", "public, max-age=300");
    response.type("application/javascript");
    return response.send(`(()=>{const s=document.currentScript,w=s&&s.dataset.workspace,v=s&&s.dataset.version;if(!s||!w||!v)return;let t;try{t=document.querySelector(s.dataset.target||'[data-supersuite-testimonials]')}catch{return}if(!t)return;const o=new URL(s.src).origin;fetch(o+'/api/public/testimonials/'+encodeURIComponent(w)+'/widgets/'+encodeURIComponent(v),{credentials:'omit',referrerPolicy:'no-referrer'}).then(r=>{if(!r.ok)throw new Error('not-found');return r.json()}).then(({widget})=>{const root=t.shadowRoot||(t.attachShadow?t.attachShadow({mode:'open'}):t);root.replaceChildren();const style=document.createElement('style');style.textContent=':host{font:16px system-ui}.q{padding:18px;border:1px solid var(--proof-accent);border-radius:var(--proof-radius);margin:10px 0;background:var(--proof-surface);color:var(--proof-text)}.a{font-weight:700;margin-top:8px}';root.append(style);t.style.setProperty('--proof-accent',widget.theme.accent);t.style.setProperty('--proof-surface',widget.theme.surface);t.style.setProperty('--proof-text',widget.theme.text);t.style.setProperty('--proof-radius',widget.theme.radiusPx+'px');widget.testimonials.forEach(q=>{const article=document.createElement('article');article.className='q';const quote=document.createElement('div');quote.textContent=q.content;const attribution=document.createElement('p');attribution.className='a';attribution.textContent=q.attributionLabel;article.append(quote,attribution);root.append(article)})}).catch(()=>{});})();`);
  });

  const collectionPageNonce = (response: Response) => {
    const nonce = randomBytes(18).toString("base64");
    response.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
    });
    return nonce;
  };
  const collectionForm = (details: { requestId: string; collectionName: string; purpose: string; consentPolicyVersion: string; contextLabel: string; locale: string }, endpoint: string, token: string, nonce: string) => `<!doctype html><html lang="${escapeHtml(details.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(details.collectionName)}</title><style nonce="${escapeHtml(nonce)}">body{font:16px system-ui;background:#f5f4ef;color:#15171d}form{width:min(90%,560px);margin:8vh auto;display:grid;gap:12px}input,select,textarea,button{font:inherit;padding:14px;border:1px solid #bbb;border-radius:10px}textarea{min-height:160px}button{color:white;background:#15171d}</style></head><body><form data-endpoint="${escapeHtml(endpoint)}" data-token="${escapeHtml(token)}" data-policy="${escapeHtml(details.consentPolicyVersion)}"><h1>${escapeHtml(details.collectionName)}</h1><p>${escapeHtml(details.purpose)}</p>${details.contextLabel ? `<p>${escapeHtml(details.contextLabel)}</p>` : ""}<input name="authorName" placeholder="Your name" required><input name="authorRole" placeholder="Role (optional)"><input name="organization" placeholder="Organization (optional)"><select name="attribution"><option value="full-name">Full name</option><option value="first-name">First name</option><option value="anonymous">Anonymous</option></select><textarea name="content" placeholder="What changed for you?" required minlength="10"></textarea><label><input name="consent" type="checkbox" required> I consent to reviewed publication under policy ${escapeHtml(details.consentPolicyVersion)}.</label><button>Send for review</button><p role="status"></p></form><script nonce="${escapeHtml(nonce)}">const form=document.querySelector('form'),endpoint=form.dataset.endpoint,token=form.dataset.token,policy=form.dataset.policy;form.onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),b={authorName:f.get('authorName'),content:f.get('content'),attribution:f.get('attribution'),authorRole:f.get('authorRole')||undefined,organization:f.get('organization')||undefined,consent:{granted:f.get('consent')==='on',policyVersion:policy,purposes:['testimonial-publication']}},r=await fetch(endpoint+'?token='+encodeURIComponent(token),{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',referrerPolicy:'no-referrer',body:JSON.stringify(b)});e.target.querySelector('[role=status]').textContent=r.ok?'Thank you. Your testimonial is awaiting review.':'This request could not be submitted.';if(r.ok)e.target.querySelector('button').disabled=true}</script></body></html>`;

  app.get("/collect/testimonials/:workspaceId/:requestId", async (request, response) => {
    const parsed = publicCollectionParamsSchema.safeParse(request.params);
    const token = publicTokenSchema.safeParse(request.query.token);
    if (!parsed.success || !token.success) return response.status(404).send("Collection request not found.");
    try {
      const resolved = await publicGrowth.collectionRequestByWorkspaceId(parsed.data.workspaceId, parsed.data.requestId, token.data);
      const nonce = collectionPageNonce(response);
      return response.type("html").send(collectionForm(resolved.public, `/api/public/testimonials/${parsed.data.workspaceId}/requests/${parsed.data.requestId}/submissions`, token.data, nonce));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send(error.message) : Promise.reject(error); }
  });
  app.post("/api/public/testimonials/:workspaceId/requests/:requestId/submissions", publicWriteLimiter, async (request, response) => {
    const parsed = publicCollectionParamsSchema.safeParse(request.params);
    const token = publicTokenSchema.safeParse(request.query.token);
    const body = publicTestimonialSchema.safeParse(request.body);
    if (!parsed.success || !token.success || !body.success) return response.status(400).json({ error: "A valid token-bound request, statement, attribution, and policy consent are required." });
    try {
      const result = await publicGrowth.submitTestimonialByWorkspaceId(parsed.data.workspaceId, parsed.data.requestId, token.data, body.data);
      return response.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { return publicGrowthFailure(response, error); }
  });
  app.get("/collect/testimonials/:requestId", async (request, response) => {
    const parsed = customDomainCollectionParamsSchema.safeParse(request.params);
    const token = publicTokenSchema.safeParse(request.query.token);
    const workspace = parsed.success && token.success ? await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase()) : undefined;
    if (!parsed.success || !token.success || !workspace) return response.status(404).send("Collection request not found.");
    try {
      const resolved = await publicGrowth.collectionRequestBySlug(workspace.slug, parsed.data.requestId, token.data);
      const nonce = collectionPageNonce(response);
      return response.type("html").send(collectionForm(resolved.public, `/api/public/testimonials/requests/${parsed.data.requestId}/submissions`, token.data, nonce));
    } catch (error) { return error instanceof PublicGrowthError ? response.status(error.status).send(error.message) : Promise.reject(error); }
  });
  app.post("/api/public/testimonials/requests/:requestId/submissions", publicWriteLimiter, async (request, response) => {
    const parsed = customDomainCollectionParamsSchema.safeParse(request.params);
    const token = publicTokenSchema.safeParse(request.query.token);
    const body = publicTestimonialSchema.safeParse(request.body);
    const workspace = parsed.success && token.success && body.success ? await suiteStore.getWorkspaceByCustomDomain(request.hostname.toLowerCase()) : undefined;
    if (!parsed.success || !token.success || !body.success || !workspace) return response.status(400).json({ error: "A valid custom-domain collection request and policy consent are required." });
    try {
      const result = await publicGrowth.submitTestimonialBySlug(workspace.slug, parsed.data.requestId, token.data, body.data);
      return response.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { return publicGrowthFailure(response, error); }
  });
  app.get("/widgets/:workspaceSlug/testimonials", (_request, response) => response.status(404).send("Use a token-bound ProofPort collection URL."));

  app.post("/api/quote", (request, response) => {
    const parsed = appIdsSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Choose at least one application." });
    const selected = parsed.data.appIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean) as CatalogApp[];
    if (selected.length !== parsed.data.appIds.length) return response.status(400).json({ error: "The selection contains an unknown application." });
    return response.json(buildQuote(selected, policy));
  });
  app.post("/api/installations", requireUser, async (request, response) => {
    const parsed = installSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Provide a workspace name, a configured plan, and zero to twelve applications." });
    const selected = parsed.data.appIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean) as CatalogApp[];
    if (selected.length !== parsed.data.appIds.length) return response.status(400).json({ error: "The selection contains an unknown application." });
    if (selected.some((item) => item.status !== "ready")) return response.status(409).json({ error: "One or more selected apps are still undergoing deployment and licence verification." });
    const chosenPlan = parsed.data.plan ? config.plans.find((plan) => plan.id === parsed.data.plan) : undefined;
    if (parsed.data.plan && !chosenPlan) return response.status(400).json({ error: "Choose a configured Starter, Scale, or Fleet plan." });
    if (!selected.length && !chosenPlan) return response.status(400).json({ error: "Choose a plan for a Suite-only workspace." });
    const quote = chosenPlan ? buildQuoteForPlan(selected, chosenPlan, policy) : buildQuote(selected, policy);
    if (!quote) return response.status(409).json({ error: `The selected applications do not safely fit the chosen ${chosenPlan?.label ?? "configured"} plan.` });
    if (!quote.recommendedPlan) return response.status(409).json({ error: "No configured server plan can safely contain this selection." });
    const slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const installation = await repository.createInstallation({ userId: response.locals.user.id, appIds: parsed.data.appIds, name: parsed.data.name, plan: quote.recommendedPlan.id, state: "planned", hostname: `${slug}.${config.PUBLIC_HOST_TARGET}`, customDomains: [] });
    installation.applications = await repository.createApplicationInstances(installation.id, installation.appIds.map((appId) => {
      const reservation = runtimeReservation(appId);
      return { appId, memoryReservationMb: reservation.memoryMb, cpuReservationMillis: reservation.cpuMillis, storageReservationGb: reservation.storageGb };
    }), config.PUBLIC_HOST_TARGET);
    return response.status(201).json({ installation, quote, provisioningMode: config.PROVISIONING_MODE });
  });
  app.post("/api/installations/:id/domains", requireUser, async (request, response) => {
    const parsed = domainSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid domain name." });
    const existing = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!existing) return response.status(404).json({ error: "Server not found." });
    if (config.HOSTING_ENTITLEMENT_MODE === "hosted" && existing.state !== "planned" && !(await repository.getActiveSubscription(response.locals.user.id, existing.id))) return response.status(402).json({ error: "Reactivate this server subscription before adding a custom domain." });
    try {
      const claimed = await repository.addDomain(response.locals.user.id, String(request.params.id), parsed.data.domain);
      if (!claimed) return response.status(409).json({ error: "That hostname has already been reserved and cannot be reassigned." });
      return response.json({ installation: claimed.installation, domain: claimed.domain, dns: claimed.domain.ownership });
    } catch (error) {
      return response.status(409).json({ error: safeDomainClaimError(error) });
    }
  });
  app.post("/api/installations/:id/domains/:domain/verify", requireUser, async (request, response) => {
    const parsed = domainSchema.safeParse({ domain: request.params.domain });
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid domain name." });
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation || !installation.customDomains.includes(parsed.data.domain)) return response.status(404).json({ error: "Domain was not found on this server." });
    if (config.HOSTING_ENTITLEMENT_MODE === "hosted" && installation.state !== "planned" && !(await repository.getActiveSubscription(response.locals.user.id, installation.id))) return response.status(402).json({ error: "Reactivate this server subscription before verifying a custom domain." });
    const domain = installation.applications?.flatMap((application) => application.customDomains).find((item) => item.domain === parsed.data.domain);
    if (!domain) return response.status(404).json({ error: "Domain ownership claim was not found on this server." });
    const result = await verifyDomain(domain.ownership, options.domainResolver);
    const updated = await repository.setDomainStatus(response.locals.user.id, installation.id, parsed.data.domain, result.verified ? "verified" : "awaiting-dns");
    return response.status(result.verified && updated ? 200 : 409).json({ ...result, domain: updated, expected: domain.ownership });
  });
  app.post("/api/installations/:id/upgrade", requireUser, async (request, response) => {
    const parsed = upgradeSchema.safeParse(request.body);
    if (!parsed.success || !config.plans.some((plan) => plan.id === parsed.data.plan)) return response.status(400).json({ error: "Choose a configured server plan." });
    const existing = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!existing) return response.status(404).json({ error: "Server not found." });
    if (existing.state === "planned" && await repository.hasActiveCheckoutCapacityHold(existing.id)) return response.status(409).json({ error: "This server has an active Stripe checkout. Finish or let that checkout expire before changing its plan." });
    const plan = config.plans.find((item) => item.id === parsed.data.plan)!;
    const applications = existing.applications ?? [];
    const memory = applications.reduce((sum, app) => sum + app.memoryReservationMb, policy.systemReserveMb);
    const cpu = applications.reduce((sum, app) => sum + app.cpuReservationMillis, 0);
    const storage = applications.reduce((sum, app) => sum + app.storageReservationGb, 0);
    if (applications.length > plan.maxServices || memory > plan.memoryMb * policy.maximumSafeUtilization || cpu > plan.cpu * 1_000 || storage > plan.storageGb) return response.status(409).json({ error: "That plan is smaller than the services already reserved on this server." });
    if (existing.state !== "planned" && config.HOSTING_ENTITLEMENT_MODE === "hosted") {
      if (!billing.ready) return response.status(503).json({ error: "Paid server upgrades remain locked until Stripe reconciliation is enabled." });
      const platformFeeMonthlyCents = Math.max(Math.ceil(plan.infrastructureMonthlyCents * (config.PLATFORM_FEE_PERCENT / 100)), config.PLATFORM_FEE_MIN_CENTS);
      try { await billing.upgrade(response.locals.user, existing, plan, platformFeeMonthlyCents, policy.systemReserveMb); }
      catch (error) { return response.status(409).json({ error: error instanceof Error ? error.message : "Stripe could not reconcile the upgrade." }); }
    }
    const installation = existing.state !== "planned" && config.HOSTING_ENTITLEMENT_MODE === "hosted"
      ? await repository.getInstallation(response.locals.user.id, existing.id)
      : await repository.upgrade(response.locals.user.id, existing.id, parsed.data.plan);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    if (existing.state !== "planned" && config.SUITE_ENTITLEMENT_MODE !== "unrestricted" && ["starter", "scale", "fleet"].includes(parsed.data.plan)) await suiteStore.setWorkspacePlan(response.locals.user.id, parsed.data.plan as "starter" | "scale" | "fleet");
    return response.json({ installation, provisioningMode: config.PROVISIONING_MODE, deployRequired: true });
  });
  app.post("/api/installations/:id/applications", requireUser, async (request, response) => {
    const parsed = cloneApplicationSchema.safeParse(request.body);
    const idempotencyKey = request.get("idempotency-key");
    if (!parsed.success || !idempotencyKey || !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) return response.status(400).json({ error: "Choose a valid application and provide a valid idempotency key." });
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation) return response.status(404).json({ error: "Server not found." });
    if (installation.state === "planned" && await repository.hasActiveCheckoutCapacityHold(installation.id)) return response.status(409).json({ error: "This server has an active Stripe checkout. Finish or let that checkout expire before changing its applications." });
    if (config.HOSTING_ENTITLEMENT_MODE === "hosted" && installation.state !== "planned" && !(await repository.getActiveSubscription(response.locals.user.id, installation.id))) return response.status(402).json({ error: "Reactivate this server subscription before cloning another service." });
    const catalogApp = catalog.find((item) => item.id === parsed.data.appId);
    if (!catalogApp || catalogApp.status !== "ready") return response.status(409).json({ error: "That application does not have a verified runtime yet." });
    const plan = config.plans.find((item) => item.id === installation.plan);
    if (!plan) return response.status(409).json({ error: "Upgrade this legacy server to a current plan before cloning services." });
    const reservation = runtimeReservation(catalogApp.id);
    let clone: Awaited<ReturnType<Repository["createApplicationClone"]>>;
    try {
      clone = await repository.createApplicationClone({ userId: response.locals.user.id, installationId: installation.id, idempotencyKey, app: { appId: catalogApp.id, memoryReservationMb: reservation.memoryMb, cpuReservationMillis: reservation.cpuMillis, storageReservationGb: reservation.storageGb }, hostnameBase: config.PUBLIC_HOST_TARGET, memorySafetyReserveMb: policy.systemReserveMb });
    } catch (error) {
      return response.status(409).json({ error: error instanceof Error ? error.message : "The worker pool could not reserve this service." });
    }
    const refreshed = await repository.getInstallation(response.locals.user.id, installation.id);
    const applications = refreshed?.applications ?? [];
    const storage = applications.reduce((sum, application) => sum + application.storageReservationGb, 0);
    return response.status(clone.replayed ? 200 : 201).json({ ...clone, quota: { services: applications.length, maxServices: plan.maxServices, storageGb: storage, maxStorageGb: plan.storageGb } });
  });
  app.get("/api/installations/:id/backups", requireUser, async (request, response) => {
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation) return response.status(404).json({ error: "Server not found." });
    return response.json(await repository.listBackups(response.locals.user.id, installation.id));
  });
  app.post("/api/installations/:id/actions", requireUser, async (request, response) => {
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Choose a valid server action and application." });
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation) return response.status(404).json({ error: "Server not found." });
    if (!installation.applications?.some((application) => application.id === parsed.data.applicationInstanceId)) return response.status(404).json({ error: "Application not found on this server." });
    if (config.HOSTING_ENTITLEMENT_MODE === "hosted" && ["start", "upgrade", "restore"].includes(parsed.data.action) && !(await repository.getActiveSubscription(response.locals.user.id, installation.id))) return response.status(402).json({ error: "Reactivate this server subscription before running a paid service action." });
    if (config.PROVISIONING_MODE !== "live") return response.status(503).json({ error: "Live provisioning is still locked." });
    if (parsed.data.action === "restore") {
      if (!parsed.data.objectName || !parsed.data.applicationInstanceId) return response.status(400).json({ error: "Choose a verified backup to restore." });
      const backups = await repository.listBackups(response.locals.user.id, installation.id);
      if (!backups.some((item) => item.objectName === parsed.data.objectName && item.applicationInstanceId === parsed.data.applicationInstanceId)) return response.status(404).json({ error: "Backup not found." });
    }
    const job = await repository.enqueueJob(installation.id, parsed.data.action, { objectName: parsed.data.objectName, applicationInstanceId: parsed.data.applicationInstanceId });
    return response.status(202).json({ job });
  });
  app.post("/api/billing/checkout", requireUser, async (request, response) => {
    if (!billing.ready) return response.status(503).json({ error: "Billing is not enabled yet. No charge or cloud resource was created." });
    if (!provisioningReadyForBilling) return response.status(503).json({ error: "Provisioning is not live, so checkout remains locked and no charge was created." });
    const parsed = checkoutSchema.safeParse(request.body);
    const idempotencyKey = request.get("idempotency-key");
    if (!parsed.success || !idempotencyKey || !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) return response.status(400).json({ error: "A server and a valid idempotency key are required." });
    const installation = await repository.getInstallation(response.locals.user.id, parsed.data.installationId);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    if (installation.state !== "planned") return response.status(409).json({ error: "Only an unpaid planned server can enter checkout." });
    const selected = installation.appIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean) as CatalogApp[];
    const chosenPlan = config.plans.find((plan) => plan.id === installation.plan);
    const quote = chosenPlan ? buildQuoteForPlan(selected, chosenPlan, policy) : null;
    if (!quote) return response.status(409).json({ error: "The selected server plan no longer safely contains these applications." });
    try {
      const checkout = await billing.checkout(response.locals.user, installation, quote, idempotencyKey);
      return response.json(checkout);
    } catch (error) {
      if (error instanceof CheckoutCapacityUnavailableError) return response.status(503).json({ error: `${error.message} No charge was created; add or upgrade worker capacity and retry.` });
      throw error;
    }
  });

  const staticDirectory = path.join(projectDirectory, "dist");
  app.use(express.static(staticDirectory));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(staticDirectory, "index.html")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    return response.status(500).json({ error: "The request could not be completed safely." });
  });
  return app;
}
