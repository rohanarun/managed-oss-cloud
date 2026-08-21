import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { buildQuote } from "../shared/pricing.js";
import type { AccountUser, CatalogApp } from "../shared/types.js";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { createRepository, type Repository } from "./repository.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "../..");
const sessionCookie = "opendock_session";
const catalogSchema = z.array(z.object({
  id: z.string(), name: z.string(), replaces: z.string(), category: z.string(), license: z.string(), sourceUrl: z.string().url(), description: z.string(), version: z.string(),
  memoryBudgetMb: z.number().int().positive(), bundleEligible: z.boolean(), status: z.enum(["ready", "integration"]), requirements: z.array(z.string()), deploymentNote: z.string(),
}));
const appIdsSchema = z.object({ appIds: z.array(z.string()).min(1).max(12) });
const installSchema = appIdsSchema.extend({ name: z.string().trim().min(2).max(60).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]+$/) });
const domainSchema = z.object({ domain: z.string().trim().toLowerCase().regex(/^(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,}$/) });
const upgradeSchema = z.object({ plan: z.string().min(1) });
const signupSchema = z.object({ displayName: z.string().trim().min(2).max(60), email: z.string().trim().toLowerCase().email(), password: z.string().min(10).max(200) });
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });

function publicUser(user: AccountUser) {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt };
}

export async function createApp(options: { repository?: Repository } = {}) {
  const app = express();
  const repository = options.repository ?? createRepository();
  await repository.initialize();
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path.join(projectDirectory, "catalog/apps.json"), "utf8"))) as CatalogApp[];
  const policy = { plans: config.plans, platformFeePercent: config.PLATFORM_FEE_PERCENT, platformFeeMinimumCents: config.PLATFORM_FEE_MIN_CENTS, systemReserveMb: 192, maximumSafeUtilization: 0.8 };
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
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
  app.get("/api/config", (_request, response) => response.json({ productName: config.PRODUCT_NAME, provisioningMode: config.PROVISIONING_MODE, persistence: repository.persistence, billingReady: Boolean(config.STRIPE_SECRET_KEY), plans: config.plans, platformFeePercent: config.PLATFORM_FEE_PERCENT, platformFeeMinimumCents: config.PLATFORM_FEE_MIN_CENTS }));
  app.get("/api/catalog", (_request, response) => response.json(catalog));

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
    return response.json({ user: publicUser(user), installations: await repository.listInstallations(user.id), persistence: repository.persistence, billingReady: Boolean(config.STRIPE_SECRET_KEY), provisioningMode: config.PROVISIONING_MODE });
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
    return response.status(201).json({ installation, quote, provisioningMode: config.PROVISIONING_MODE });
  });
  app.post("/api/installations/:id/domains", requireUser, async (request, response) => {
    const parsed = domainSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid domain name." });
    const installation = await repository.addDomain(response.locals.user.id, String(request.params.id), parsed.data.domain);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    return response.json({ installation, dns: { type: "CNAME", name: parsed.data.domain, value: installation.hostname, status: "awaiting-dns" } });
  });
  app.post("/api/installations/:id/upgrade", requireUser, async (request, response) => {
    const parsed = upgradeSchema.safeParse(request.body);
    if (!parsed.success || !config.plans.some((plan) => plan.id === parsed.data.plan)) return response.status(400).json({ error: "Choose a configured server plan." });
    const installation = await repository.upgrade(response.locals.user.id, String(request.params.id), parsed.data.plan);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    return response.json({ installation, provisioningMode: config.PROVISIONING_MODE, deployRequired: true });
  });
  app.post("/api/billing/checkout", requireUser, (_request, response) => {
    if (!config.STRIPE_SECRET_KEY) return response.status(503).json({ error: "Billing is not connected yet. No charge or cloud resource was created." });
    return response.status(501).json({ error: "Checkout stays locked until webhook and price reconciliation tests pass." });
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
