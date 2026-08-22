import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { buildQuote, buildQuoteForPlan } from "../shared/pricing.js";
import type { AccountUser, CatalogApp } from "../shared/types.js";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./auth.js";
import { createBillingService, type BillingGateway } from "./billing.js";
import { config } from "./config.js";
import { verifyDomain, type DomainResolver } from "./domain-verification.js";
import { runtimeReservation } from "./app-manifests.js";
import { createRepository, type Repository } from "./repository.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "../..");
const sessionCookie = "opendock_session";
const catalogSchema = z.array(z.object({
  id: z.string(), name: z.string(), replaces: z.string(), category: z.string(), license: z.string(), sourceUrl: z.string().url(), description: z.string(), version: z.string(),
  memoryBudgetMb: z.number().int().positive(), cpuBudgetMillis: z.number().int().positive(), storageBudgetGb: z.number().int().positive(), bundleEligible: z.boolean(), status: z.enum(["ready", "integration"]), requirements: z.array(z.string()), deploymentNote: z.string(),
}));
const appIdsSchema = z.object({ appIds: z.array(z.string()).min(1).max(12) });
const installSchema = appIdsSchema.extend({ name: z.string().trim().min(2).max(60).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]+$/) });
const domainSchema = z.object({ domain: z.string().trim().toLowerCase().regex(/^(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,}$/) });
const upgradeSchema = z.object({ plan: z.string().min(1) });
const signupSchema = z.object({ displayName: z.string().trim().min(2).max(60), email: z.string().trim().toLowerCase().email(), password: z.string().min(10).max(200) });
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
const checkoutSchema = z.object({ installationId: z.string().uuid() });
const cloneApplicationSchema = z.object({ appId: z.string().min(1).max(100) });
const actionSchema = z.object({ action: z.enum(["start", "stop", "upgrade", "backup", "restore"]), objectName: z.string().max(1_000).optional(), applicationInstanceId: z.string().uuid() });
const workerRegistrationSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/), name: z.string().min(3).max(100), privateAddress: z.ipv4(), machineType: z.string().min(2).max(100), capacityMemoryMb: z.number().int().min(1024), capacityCpuMillis: z.number().int().min(250), capacityStorageGb: z.number().int().min(10), systemReserveMemoryMb: z.number().int().min(256) });
const workerHeartbeatSchema = z.object({ privateAddress: z.ipv4(), capacityMemoryMb: z.number().int().min(1024), capacityCpuMillis: z.number().int().min(250), capacityStorageGb: z.number().int().min(10) });
const workerReportSchema = z.object({ status: z.enum(["succeeded", "failed"]), error: z.string().max(1_000).optional(), applications: z.array(z.object({ id: z.string().uuid(), state: z.enum(["queued", "provisioning", "live", "failed", "stopped"]), healthy: z.boolean().optional() })).max(12).optional(), backups: z.array(z.object({ applicationInstanceId: z.string().uuid(), objectName: z.string().min(1).max(1_000), sizeBytes: z.number().int().nonnegative() })).max(12).optional() });

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

export async function createApp(options: { repository?: Repository; billingGateway?: BillingGateway; domainResolver?: DomainResolver; workerBootstrapToken?: string; gatewayReconcilerToken?: string; agentJobsEnabled?: boolean } = {}) {
  const app = express();
  const repository = options.repository ?? createRepository();
  await repository.initialize();
  const billing = createBillingService(repository, options.billingGateway);
  const workerBootstrapToken = options.workerBootstrapToken ?? config.WORKER_BOOTSTRAP_TOKEN;
  const gatewayReconcilerToken = options.gatewayReconcilerToken ?? config.GATEWAY_RECONCILER_TOKEN;
  const agentJobsEnabled = options.agentJobsEnabled ?? config.PROVISIONING_MODE === "live";
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path.join(projectDirectory, "catalog/apps.json"), "utf8"))) as CatalogApp[];
  const policy = { plans: config.plans, platformFeePercent: config.PLATFORM_FEE_PERCENT, platformFeeMinimumCents: config.PLATFORM_FEE_MIN_CENTS, systemReserveMb: 192, maximumSafeUtilization: 0.8 };
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.post("/api/billing/webhook", express.raw({ type: "application/json", limit: "128kb" }), async (request, response) => {
    const signature = request.get("stripe-signature");
    if (!signature || !Buffer.isBuffer(request.body)) return response.status(400).json({ error: "A signed Stripe payload is required." });
    try {
      const result = await billing.webhook(request.body, signature);
      return response.json(result);
    } catch (error) {
      return response.status(400).json({ error: error instanceof Error ? error.message : "Stripe webhook rejected." });
    }
  });
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use((request, response, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.get("origin");
      const allowed = new URL(config.PUBLIC_APP_URL);
      if (origin && new URL(origin).host !== allowed.host && new URL(origin).host !== request.get("host")) return response.status(403).json({ error: "Cross-site request rejected." });
    }
    next();
  });

  async function currentUser(request: Request) {
    const token = request.cookies[sessionCookie];
    return token ? repository.findUserBySession(hashSessionToken(token)) : undefined;
  }
  async function requireUser(request: Request, response: Response, next: NextFunction) {
    const user = await currentUser(request);
    if (!user) return response.status(401).json({ error: "Sign in to manage servers." });
    response.locals.user = user;
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

  app.post("/api/agent/register", async (request, response) => {
    if (!tokenMatches(bearerToken(request), workerBootstrapToken)) return response.status(401).json({ error: "Worker bootstrap authorization failed." });
    const parsed = workerRegistrationSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Worker registration is invalid." });
    return response.status(201).json(await repository.registerWorkerNode(parsed.data));
  });
  async function requireAgent(request: Request, response: Response, next: NextFunction) {
    const token = bearerToken(request);
    const node = token ? await repository.findWorkerNodeByAgentToken(token) : undefined;
    if (!node) return response.status(401).json({ error: "Worker authorization failed." });
    response.locals.workerNode = node;
    next();
  }
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
    return response.json({ routes: await repository.listGatewayRoutes() });
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
    const user = await currentUser(request);
    return user ? response.json({ user: publicUser(user), persistence: repository.persistence }) : response.status(401).json({ user: null });
  });
  app.get("/api/dashboard", requireUser, async (_request, response) => {
    const user = response.locals.user;
    return response.json({ user: publicUser(user), installations: await repository.listInstallations(user.id), persistence: repository.persistence, billingReady: billing.ready, provisioningMode: config.PROVISIONING_MODE });
  });

  app.post("/api/quote", (request, response) => {
    const parsed = appIdsSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Choose at least one application." });
    const selected = parsed.data.appIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean) as CatalogApp[];
    if (selected.length !== parsed.data.appIds.length) return response.status(400).json({ error: "The selection contains an unknown application." });
    return response.json(buildQuote(selected, policy));
  });
  app.post("/api/installations", requireUser, async (request, response) => {
    const parsed = installSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Provide a server name and at least one application." });
    const selected = parsed.data.appIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean) as CatalogApp[];
    if (selected.length !== parsed.data.appIds.length) return response.status(400).json({ error: "The selection contains an unknown application." });
    if (selected.some((item) => item.status !== "ready")) return response.status(409).json({ error: "One or more selected apps are still undergoing deployment and licence verification." });
    const quote = buildQuote(selected, policy);
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
    const installation = await repository.addDomain(response.locals.user.id, String(request.params.id), parsed.data.domain);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    const target = installation.applications?.[0]?.hostname ?? installation.hostname;
    return response.json({ installation, dns: { type: "CNAME", name: parsed.data.domain, value: target, status: "awaiting-dns" } });
  });
  app.post("/api/installations/:id/domains/:domain/verify", requireUser, async (request, response) => {
    const parsed = domainSchema.safeParse({ domain: request.params.domain });
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid domain name." });
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation || !installation.customDomains.includes(parsed.data.domain)) return response.status(404).json({ error: "Domain was not found on this server." });
    const target = installation.applications?.[0]?.hostname ?? installation.hostname;
    const result = await verifyDomain(parsed.data.domain, target, config.PLATFORM_IPV4, options.domainResolver);
    await repository.setDomainStatus(parsed.data.domain, result.verified ? "verified" : "awaiting-dns");
    return response.status(result.verified ? 200 : 409).json({ ...result, expected: target });
  });
  app.post("/api/installations/:id/upgrade", requireUser, async (request, response) => {
    const parsed = upgradeSchema.safeParse(request.body);
    if (!parsed.success || !config.plans.some((plan) => plan.id === parsed.data.plan)) return response.status(400).json({ error: "Choose a configured server plan." });
    const existing = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!existing) return response.status(404).json({ error: "Server not found." });
    const plan = config.plans.find((item) => item.id === parsed.data.plan)!;
    const applications = existing.applications ?? [];
    const memory = applications.reduce((sum, app) => sum + app.memoryReservationMb, policy.systemReserveMb);
    const cpu = applications.reduce((sum, app) => sum + app.cpuReservationMillis, 0);
    const storage = applications.reduce((sum, app) => sum + app.storageReservationGb, 0);
    if (applications.length > plan.maxServices || memory > plan.memoryMb * policy.maximumSafeUtilization || cpu > plan.cpu * 1_000 || storage > plan.storageGb) return response.status(409).json({ error: "That plan is smaller than the services already reserved on this server." });
    if (existing.state !== "planned") {
      if (!billing.ready) return response.status(503).json({ error: "Paid server upgrades remain locked until Stripe reconciliation is enabled." });
      const platformFeeMonthlyCents = Math.max(Math.ceil(plan.infrastructureMonthlyCents * (config.PLATFORM_FEE_PERCENT / 100)), config.PLATFORM_FEE_MIN_CENTS);
      try { await billing.upgrade(response.locals.user, existing, plan, platformFeeMonthlyCents); }
      catch (error) { return response.status(409).json({ error: error instanceof Error ? error.message : "Stripe could not reconcile the upgrade." }); }
    }
    const installation = await repository.upgrade(response.locals.user.id, existing.id, parsed.data.plan);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    return response.json({ installation, provisioningMode: config.PROVISIONING_MODE, deployRequired: true });
  });
  app.post("/api/installations/:id/applications", requireUser, async (request, response) => {
    const parsed = cloneApplicationSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Choose a valid application to clone." });
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation) return response.status(404).json({ error: "Server not found." });
    const catalogApp = catalog.find((item) => item.id === parsed.data.appId);
    if (!catalogApp || catalogApp.status !== "ready") return response.status(409).json({ error: "That application does not have a verified runtime yet." });
    const plan = config.plans.find((item) => item.id === installation.plan);
    if (!plan) return response.status(409).json({ error: "Upgrade this legacy server to a current plan before cloning services." });
    const applications = installation.applications ?? [];
    const reservation = runtimeReservation(catalogApp.id);
    const memory = applications.reduce((sum, app) => sum + app.memoryReservationMb, policy.systemReserveMb) + reservation.memoryMb;
    const cpu = applications.reduce((sum, app) => sum + app.cpuReservationMillis, 0) + reservation.cpuMillis;
    const storage = applications.reduce((sum, app) => sum + app.storageReservationGb, 0) + reservation.storageGb;
    if (applications.length + 1 > plan.maxServices || memory > plan.memoryMb * policy.maximumSafeUtilization || cpu > plan.cpu * 1_000 || storage > plan.storageGb) return response.status(409).json({ error: `Upgrade to a larger plan before cloning another service. ${plan.label} allows ${plan.maxServices} services, ${plan.storageGb} GB storage, ${plan.memoryMb} MB memory, and ${plan.cpu} vCPU.` });
    if (!(await repository.canReserveOnInstallationWorker(installation.id, { memoryReservationMb: reservation.memoryMb, cpuReservationMillis: reservation.cpuMillis, storageReservationGb: reservation.storageGb }))) return response.status(409).json({ error: "This worker needs more physical capacity before the service can be cloned safely." });
    const [application] = await repository.createApplicationInstances(installation.id, [{ appId: catalogApp.id, memoryReservationMb: reservation.memoryMb, cpuReservationMillis: reservation.cpuMillis, storageReservationGb: reservation.storageGb }], config.PUBLIC_HOST_TARGET);
    await repository.appendApplicationId(installation.id, catalogApp.id);
    const job = installation.state === "live" ? await repository.enqueueJob(installation.id, "install", { applicationInstanceId: application.id }) : undefined;
    return response.status(201).json({ application, job, quota: { services: applications.length + 1, maxServices: plan.maxServices, storageGb: storage, maxStorageGb: plan.storageGb } });
  });
  app.get("/api/installations/:id/backups", requireUser, async (request, response) => {
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation) return response.status(404).json({ error: "Server not found." });
    return response.json(await repository.listBackups(response.locals.user.id, installation.id));
  });
  app.post("/api/installations/:id/actions", requireUser, async (request, response) => {
    if (config.PROVISIONING_MODE !== "live") return response.status(503).json({ error: "Live provisioning is still locked." });
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Choose a valid server action and application." });
    const installation = await repository.getInstallation(response.locals.user.id, String(request.params.id));
    if (!installation) return response.status(404).json({ error: "Server not found." });
    if (!installation.applications?.some((application) => application.id === parsed.data.applicationInstanceId)) return response.status(404).json({ error: "Application not found on this server." });
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
    const checkout = await billing.checkout(response.locals.user, installation, quote, idempotencyKey);
    return response.json(checkout);
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
