import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { buildQuote } from "../shared/pricing.js";
import type { CatalogApp } from "../shared/types.js";
import { config } from "./config.js";
import { InstallationStore } from "./store.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "../..");
const catalogSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  replaces: z.string(),
  category: z.string(),
  license: z.string(),
  sourceUrl: z.string().url(),
  description: z.string(),
  memoryBudgetMb: z.number().int().positive(),
  bundleEligible: z.boolean(),
  status: z.enum(["beta", "integration"]),
}));
const appIdsSchema = z.object({ appIds: z.array(z.string()).min(1) });
const installSchema = appIdsSchema.extend({ name: z.string().trim().min(2).max(60) });
const domainSchema = z.object({
  domain: z.string().trim().toLowerCase().regex(/^(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,}$/),
});
const upgradeSchema = z.object({ plan: z.string().min(1) });

export async function createApp() {
  const app = express();
  const store = new InstallationStore();
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path.join(projectDirectory, "catalog/apps.json"), "utf8"))) as CatalogApp[];
  const policy = {
    plans: config.plans,
    platformFeePercent: config.PLATFORM_FEE_PERCENT,
    platformFeeMinimumCents: config.PLATFORM_FEE_MIN_CENTS,
    systemReserveMb: 128,
    maximumSafeUtilization: 0.85,
  };

  app.use(express.json({ limit: "32kb" }));
  app.get("/api/health", (_request, response) => response.json({ ok: true, mode: config.PROVISIONING_MODE }));
  app.get("/api/config", (_request, response) => response.json({ productName: config.PRODUCT_NAME, provisioningMode: config.PROVISIONING_MODE, plans: config.plans }));
  app.get("/api/catalog", (_request, response) => response.json(catalog));
  app.get("/api/installations", (_request, response) => response.json(store.list()));

  app.post("/api/quote", (request, response) => {
    const parsed = appIdsSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Choose at least one application." });
    const selected = parsed.data.appIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean) as CatalogApp[];
    if (selected.length !== parsed.data.appIds.length) return response.status(400).json({ error: "The selection contains an unknown application." });
    return response.json(buildQuote(selected, policy));
  });

  app.post("/api/installations", (request, response) => {
    const parsed = installSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Provide a server name and at least one application." });
    const selected = parsed.data.appIds.map((id) => catalog.find((item) => item.id === id)).filter(Boolean) as CatalogApp[];
    if (selected.length !== parsed.data.appIds.length) return response.status(400).json({ error: "The selection contains an unknown application." });
    const quote = buildQuote(selected, policy);
    if (!quote.recommendedPlan) return response.status(409).json({ error: "No configured server plan can safely contain this selection." });
    const installation = store.create({
      appIds: parsed.data.appIds,
      name: parsed.data.name,
      plan: quote.recommendedPlan.id,
      state: "planned",
      hostname: `${parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.onrender.com`,
      customDomains: [],
    });
    return response.status(201).json({ installation, quote, provisioningMode: config.PROVISIONING_MODE });
  });

  app.post("/api/installations/:id/domains", (request, response) => {
    const parsed = domainSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid domain name." });
    const installation = store.addDomain(request.params.id, parsed.data.domain);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    return response.json({
      installation,
      dns: { type: "CNAME", name: parsed.data.domain, value: installation.hostname, status: "awaiting-dns" },
    });
  });

  app.post("/api/installations/:id/upgrade", (request, response) => {
    const parsed = upgradeSchema.safeParse(request.body);
    if (!parsed.success || !config.plans.some((plan) => plan.id === parsed.data.plan)) {
      return response.status(400).json({ error: "Choose a configured Render plan." });
    }
    const installation = store.upgrade(request.params.id, parsed.data.plan);
    if (!installation) return response.status(404).json({ error: "Server not found." });
    return response.json({ installation, provisioningMode: config.PROVISIONING_MODE, deployRequired: true });
  });

  const staticDirectory = path.join(projectDirectory, "dist");
  app.use(express.static(staticDirectory));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(staticDirectory, "index.html")));
  return app;
}
