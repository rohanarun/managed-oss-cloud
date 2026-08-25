import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const generator = path.join(repositoryRoot, "scripts", "generate-product-repositories.mjs");
const fleet = path.join(repositoryRoot, "scripts", "serve-real-product-screenshot-fleet.mjs");

interface FleetSummary {
  ok: boolean;
  mode: string;
  webKey: string;
  backendUrl: string;
  workspaceId: string;
  publicSurfaces: {
    form: string;
    booking: string;
    feedback: string;
    knowledgeLibrary: string;
    knowledgeRevision: string;
    knowledgeRevisionProjection: string;
    giveaway: string;
    brandPage: string;
    brandPageDiscovery: string;
    testimonialCollection: string;
    testimonialWidget: string;
    testimonialDiscovery: string;
  };
  products: Array<{ slug: string; moduleId: string; recordId: string; url: string }>;
}

async function readyLine(child: ChildProcessWithoutNullStreams) {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Real screenshot fleet did not become ready. " + stderr)), 30_000);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(stdout.slice(0, newline));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Real screenshot fleet exited with " + code + ". " + stderr));
    });
  });
}

describe("real-backend product screenshot fleet", () => {
  let generatedRoot: string;
  let child: ChildProcessWithoutNullStreams;
  let summary: FleetSummary;

  beforeAll(async () => {
    generatedRoot = await mkdtemp(path.join(tmpdir(), "managed-oss-real-screenshots-"));
    await execFileAsync(process.execPath, ["--import", "tsx", generator, "--output", generatedRoot], { cwd: repositoryRoot, timeout: 30_000 });
    const basePort = 54_000 + process.pid % 1_000;
    child = spawn(process.execPath, ["--import", "tsx", fleet, generatedRoot, String(basePort)], {
      cwd: repositoryRoot,
      env: { ...process.env, PRODUCT_WEB_KEY: "test-real-backend-screenshot-key-2026" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    summary = JSON.parse(await readyLine(child)) as FleetSummary;
  }, 45_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    if (generatedRoot) await rm(generatedRoot, { recursive: true, force: true });
  });

  it("seeds and serves every generated product through the shared authenticated API", async () => {
    expect(summary).toMatchObject({ ok: true, mode: "real-backend" });
    expect(summary.products).toHaveLength(37);
    expect(new Set(summary.products.map((product) => product.slug)).size).toBe(37);
    expect(new Set(summary.products.map((product) => product.moduleId)).size).toBe(37);
    expect(summary.products.every((product) => /^[0-9a-f-]{36}$/.test(product.recordId))).toBe(true);
    const publicForm = await fetch(summary.publicSurfaces.form);
    expect(publicForm.status).toBe(200);
    expect(await publicForm.text()).toContain("Tell us what you are building");
    const booking = await fetch(summary.publicSurfaces.booking);
    expect(booking.status).toBe(200);
    expect(await booking.text()).toContain("Product consultation");
    const feedback = await fetch(summary.publicSurfaces.feedback);
    expect(feedback.status).toBe(200);
    expect(feedback.headers.get("cache-control")).toContain("no-store");
    const feedbackPage = await feedback.text();
    expect(feedbackPage).toContain("Northwind product direction");
    expect(feedbackPage).toContain("Saved workspace views");
    expect(feedbackPage).toContain("Vote for this");
    expect(feedbackPage).not.toContain("voterKeyHash");
    const knowledgeLibrary = await fetch(summary.publicSurfaces.knowledgeLibrary);
    expect(knowledgeLibrary.status).toBe(200);
    expect(knowledgeLibrary.headers.get("cache-control")).toContain("s-maxage=60");
    expect(knowledgeLibrary.headers.get("content-security-policy")).toMatch(/default-src 'none'.*script-src 'none'.*style-src 'sha256-/);
    const knowledgeLibraryPage = await knowledgeLibrary.text();
    expect(knowledgeLibraryPage).toContain("Northwind field manual");
    expect(knowledgeLibraryPage).toContain("Run a calm, evidence-first incident review");
    expect(knowledgeLibraryPage).toContain(new URL(summary.publicSurfaces.knowledgeRevision).pathname);
    const knowledgeRevision = await fetch(summary.publicSurfaces.knowledgeRevision);
    expect(knowledgeRevision.status).toBe(200);
    expect(knowledgeRevision.headers.get("cache-control")).toContain("s-maxage=300");
    const knowledgeRevisionPage = await knowledgeRevision.text();
    expect(knowledgeRevisionPage).toContain("Start with observed facts");
    expect(knowledgeRevisionPage).toContain("Reviewed operating standard maintained by the Northwind reliability team.");
    expect(knowledgeRevisionPage).not.toContain("<script");
    const knowledgeProjection = await fetch(summary.publicSurfaces.knowledgeRevisionProjection);
    expect(knowledgeProjection.status).toBe(200);
    const projectedKnowledge = await knowledgeProjection.json() as {
      schema: string;
      page: Record<string, unknown> & { sources: Array<Record<string, unknown>> };
    };
    expect(projectedKnowledge.schema).toBe("atlasbase-public-page.v1");
    expect(projectedKnowledge.page).toMatchObject({
      title: "Run a calm, evidence-first incident review",
      isLatestRevision: true,
    });
    expect(projectedKnowledge.page.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(projectedKnowledge.page.sources).toHaveLength(1);
    expect(Object.keys(projectedKnowledge.page.sources[0]).sort()).toEqual(["contentHash", "locator", "observedAt", "trustNote"]);
    expect(JSON.stringify(projectedKnowledge)).not.toContain("sourceIds");
    expect(JSON.stringify(projectedKnowledge)).not.toContain("workspaceId");
    const giveaway = await fetch(summary.publicSurfaces.giveaway);
    expect(giveaway.status).toBe(200);
    expect(giveaway.headers.get("cache-control")).toContain("no-store");
    expect(giveaway.headers.get("content-security-policy")).toMatch(/default-src 'none'.*script-src 'none'.*style-src 'nonce-/);
    const giveawayPage = await giveaway.text();
    expect(giveawayPage).toContain("Northwind launch giveaway");
    expect(giveawayPage).toContain("Accepting entries");
    expect(giveawayPage).toContain('type="email"');
    expect(giveawayPage).toContain("One consented entry per email");
    expect(giveawayPage).not.toContain("participantKeyHash");
    const brandPage = await fetch(summary.publicSurfaces.brandPage);
    expect(brandPage.status).toBe(200);
    const brandPageHtml = await brandPage.text();
    expect(brandPageHtml).toContain("Northwind Studio");
    expect(brandPageHtml).toContain('data-layout="cards"');
    expect(brandPageHtml).toContain('class="card-grid"');
    expect(brandPageHtml).toMatch(/href="\/out\/[^"]+"/);
    expect(brandPageHtml).not.toMatch(/href="https:\/\/example\.com\//);
    const brandPageDiscovery = await fetch(summary.publicSurfaces.brandPageDiscovery);
    expect(brandPageDiscovery.status).toBe(200);
    const discoveredBrandPages = await brandPageDiscovery.json() as {
      records: Array<Record<string, unknown>>;
    };
    expect(discoveredBrandPages.records).toHaveLength(1);
    expect(discoveredBrandPages.records[0]).toMatchObject({
      slug: "northwind-studio",
      title: "Northwind Studio",
      locale: "en-US",
      layout: "cards",
      linkCount: 3,
      publicPath: new URL(summary.publicSurfaces.brandPage).pathname,
    });
    expect(discoveredBrandPages.records[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(discoveredBrandPages)).not.toContain("https://example.com/");
    expect(discoveredBrandPages.records[0]).not.toHaveProperty("workspaceId");
    expect(discoveredBrandPages.records[0]).not.toHaveProperty("links");
    const testimonialCollectionUrl = new URL(summary.publicSurfaces.testimonialCollection);
    expect(testimonialCollectionUrl.searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    const testimonialCollection = await fetch(testimonialCollectionUrl);
    expect(testimonialCollection.status).toBe(200);
    expect(testimonialCollection.headers.get("cache-control")).toBe("no-store");
    expect(testimonialCollection.headers.get("content-security-policy")).toMatch(/default-src 'none'.*connect-src 'self'.*script-src 'nonce-/);
    const testimonialCollectionHtml = await testimonialCollection.text();
    expect(testimonialCollectionHtml).toContain("Northwind customer outcomes");
    expect(testimonialCollectionHtml).toContain("Northwind customer story");
    expect(testimonialCollectionHtml).toContain('name="authorName"');
    expect(testimonialCollectionHtml).toContain('name="content"');
    expect(testimonialCollectionHtml).toContain("Send for review");
    expect(testimonialCollectionHtml).not.toContain('type="email"');
    expect(testimonialCollectionHtml).not.toContain("recipientRefHash");
    const testimonialWidget = await fetch(summary.publicSurfaces.testimonialWidget);
    expect(testimonialWidget.status).toBe(200);
    expect(testimonialWidget.headers.get("content-security-policy")).toContain("script-src 'none'");
    const testimonialWidgetHtml = await testimonialWidget.text();
    expect(testimonialWidgetHtml).toContain('data-layout="carousel"');
    expect(testimonialWidgetHtml).toContain('class="carousel-track"');
    expect(testimonialWidgetHtml).toContain("Northwind gave our team one place");
    expect(testimonialWidgetHtml).toContain("Asha, Operations lead");
    expect(testimonialWidgetHtml).not.toContain("<script");
    expect(testimonialWidgetHtml).not.toContain("sourceRefHash");
    expect(testimonialWidgetHtml).not.toContain("consentReceiptId");
    expect(testimonialWidgetHtml).not.toContain(String(testimonialCollectionUrl.searchParams.get("token")));
    const testimonialDiscovery = await fetch(summary.publicSurfaces.testimonialDiscovery);
    expect(testimonialDiscovery.status).toBe(200);
    const discoveredTestimonials = await testimonialDiscovery.json() as { records: Array<Record<string, unknown>> };
    expect(discoveredTestimonials.records).toHaveLength(1);
    expect(discoveredTestimonials.records[0]).toMatchObject({
      content: "Northwind gave our team one place to review the work, make a decision, and move the launch forward.",
      attributionLabel: "Asha, Operations lead",
    });
    expect(Object.keys(discoveredTestimonials.records[0] ?? {}).sort()).toEqual(["attributionLabel", "content", "contentHash", "disclosure", "id", "publishedAt"]);
    for (const privateValue of ["sourceRefHash", "consentReceiptId", "moderationDecisionId", "recipientRefHash", String(testimonialCollectionUrl.searchParams.get("token"))]) {
      expect(JSON.stringify(discoveredTestimonials)).not.toContain(privateValue);
    }

    for (const product of [summary.products[0], summary.products[12], summary.products[36]]) {
      const page = await fetch(product.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Workspace");
      const workspace = await fetch(product.url + "product-api/workspace", { headers: { "X-Product-Web-Key": summary.webKey } });
      expect(workspace.status).toBe(200);
      expect((await workspace.json()).workspace.id).toBe(summary.workspaceId);
      const records = await fetch(product.url + "product-api/records?limit=100", { headers: { "X-Product-Web-Key": summary.webKey } });
      expect(records.status).toBe(200);
      expect((await records.json()).records.some((record: { id: string }) => record.id === product.recordId)).toBe(true);
    }
  });
});
