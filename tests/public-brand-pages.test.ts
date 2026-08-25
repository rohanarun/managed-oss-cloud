import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { executeFirstPartyGrowthAction, type FirstPartyGrowthAuthorization } from "../src/server/first-party-growth-engine";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";

const ownerA = "93939393-9393-4393-8393-939393939393";
const ownerB = "94949494-9494-4494-8494-949494949494";
const fixedNow = new Date("2026-08-25T12:00:00.000Z");

function key(value: string) {
  return `public-beacon.${value}.0001`;
}

function approval(userId: string, value: string) {
  return {
    approved: true as const,
    approvedBy: userId,
    approvedAt: fixedNow.toISOString(),
    decisionId: `public-beacon.${value}.approval`,
    reason: "The exact immutable BeaconPage version was reviewed for publication.",
  };
}

async function actor(store: MemorySuiteStore, userId: string) {
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.enableModule(userId, "brand-pages");
  return { workspace, auth: { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] } satisfies FirstPartyGrowthAuthorization };
}

async function run(store: MemorySuiteStore, auth: FirstPartyGrowthAuthorization, actionId: string, input: Record<string, unknown>) {
  return executeFirstPartyGrowthAction(store, auth, "brand-pages", actionId, input, { now: () => fixedNow });
}

function record(result: Awaited<ReturnType<typeof run>>, recordType: string) {
  const found = result.records.find((candidate) => candidate.recordType === recordType);
  if (!found) throw new Error(`Expected ${recordType}.`);
  return found;
}

async function draftPage(store: MemorySuiteStore, auth: FirstPartyGrowthAuthorization, input: {
  slug: string;
  title: string;
  description: string;
  layout: "stack" | "cards" | "editorial";
}) {
  const page = record(await run(store, auth, "page-create", {
    slug: input.slug,
    name: input.title,
    privacyMode: "no-analytics",
    locale: "en-US",
    idempotencyKey: key(`page-${input.slug}`),
  }), "page");
  const links = [];
  const destinations = [];
  for (const [index, label] of ["Product notes", "Contact studio"].entries()) {
    const linkKey = index === 0 ? "notes" : "contact";
    const destination = record(await run(store, auth, "destination-version-create", {
      pageId: page.id,
      linkKey,
      destination: `https://example.com/${input.slug}/${linkKey}`,
      label,
      accessibilityLabel: `Open ${label.toLowerCase()}`,
      campaign: {},
      idempotencyKey: key(`destination-${input.slug}-${linkKey}`),
    }), "destination-version");
    destinations.push(destination);
    links.push({ key: linkKey, label, destinationVersionId: destination.id, accessibilityLabel: `Open ${label.toLowerCase()}` });
  }
  const version = record(await run(store, auth, "page-version-create", {
    pageId: page.id,
    title: input.title,
    description: input.description,
    links,
    layout: input.layout,
    theme: { accent: "#8CF0C8", background: "#0B1713", foreground: "#F4FFF9", radiusPx: 18 },
    idempotencyKey: key(`version-${input.slug}`),
  }), "page-version");
  return { page, version, links, destinations };
}

async function publishPage(store: MemorySuiteStore, auth: FirstPartyGrowthAuthorization, input: Parameters<typeof draftPage>[2]) {
  const drafted = await draftPage(store, auth, input);
  await run(store, auth, "page-version-publish", {
    pageVersionId: drafted.version.id,
    contentHash: drafted.version.data.contentHash,
    dryRun: false,
    approval: approval(auth.userId, `publish-${input.slug}`),
    idempotencyKey: key(`publish-${input.slug}`),
  });
  return drafted;
}

async function nextVersion(store: MemorySuiteStore, auth: FirstPartyGrowthAuthorization, input: {
  pageId: string;
  slug: string;
  links: Array<Record<string, unknown>>;
  title: string;
  layout: "stack" | "cards" | "editorial";
}) {
  return record(await run(store, auth, "page-version-create", {
    pageId: input.pageId,
    title: input.title,
    description: "This replacement version remains private until its exact hash and approval are committed.",
    links: input.links,
    layout: input.layout,
    theme: { accent: "#F0C36A", background: "#17120B", foreground: "#FFF9EC", radiusPx: 4 },
    idempotencyKey: key(`replacement-${input.slug}`),
  }), "page-version");
}

describe("public BeaconPage HTTP surfaces", () => {
  it("discovers only approved active versions and renders stack, cards, and editorial as distinct layouts", async () => {
    const store = new MemorySuiteStore("fleet");
    const { auth, workspace } = await actor(store, ownerA);
    const stack = await publishPage(store, auth, { slug: "stack-page", title: "Stack profile", description: "A focused sequence of links.", layout: "stack" });
    const cards = await publishPage(store, auth, { slug: "cards-page", title: "Card collection", description: "Cards escape <script>globalThis.bad=true</script> safely.", layout: "cards" });
    const editorial = await publishPage(store, auth, { slug: "editorial-page", title: "Editorial index", description: "A wide publication-style directory.", layout: "editorial" });
    const unapproved = await draftPage(store, auth, { slug: "unapproved-page", title: "Unapproved page", description: "This must never become discoverable.", layout: "cards" });
    await store.updateRecord(ownerA, unapproved.version.id, { state: "published", data: { public: true } });
    await store.updateRecord(ownerA, unapproved.page.id, { state: "published", data: { public: true, activePageVersionId: unapproved.version.id } });
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, synchronizeSuiteEntitlements: false, suiteEntitlementMode: "unrestricted" });

    const discovery = await request(app).get(`/api/public/${workspace.slug}/brand-pages`);
    expect(discovery.status).toBe(200);
    expect(discovery.body.moduleId).toBe("brand-pages");
    expect(discovery.body.records.map((page: { slug: string }) => page.slug)).toEqual(["cards-page", "editorial-page", "stack-page"]);
    for (const page of discovery.body.records) {
      expect(Object.keys(page).sort()).toEqual(["contentHash", "description", "id", "layout", "linkCount", "locale", "pageVersionId", "publicPath", "slug", "title"]);
      expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(page.linkCount).toBe(2);
      expect(page.publicPath).toBe(`/p/${workspace.slug}/${page.slug}`);
      expect(page).not.toHaveProperty("workspaceId");
      expect(page).not.toHaveProperty("links");
      expect(JSON.stringify(page)).not.toContain("https://example.com");
    }
    expect((await request(app).get(`/p/${workspace.slug}/unapproved-page`)).status).toBe(404);

    const cases = [
      { slug: "stack-page", version: stack.version, destination: stack.destinations[0], layout: "stack", marker: 'class="stack-links"', absent: ['class="card-grid"', 'class="editorial-index"'] },
      { slug: "cards-page", version: cards.version, destination: cards.destinations[0], layout: "cards", marker: 'class="card-grid"', absent: ['class="stack-links"', 'class="editorial-index"'] },
      { slug: "editorial-page", version: editorial.version, destination: editorial.destinations[0], layout: "editorial", marker: 'class="editorial-index"', absent: ['class="stack-links"', 'class="card-grid"'] },
    ];
    for (const item of cases) {
      const page = await request(app).get(`/p/${workspace.slug}/${item.slug}`);
      expect(page.status).toBe(200);
      expect(page.headers["cache-control"]).toBe("public, max-age=60");
      expect(page.text).toContain(`data-layout="${item.layout}"`);
      expect(page.text).toContain(`data-page-version="${item.version.id}"`);
      expect(page.text).toContain(item.marker);
      for (const absent of item.absent) expect(page.text).not.toContain(absent);
      expect(page.text).toContain(`/out/${workspace.id}/${item.version.id}/${item.destination.id}`);
      expect(page.text).not.toContain(`href="https://example.com/${item.slug}`);
      expect(page.text).not.toContain("<script>");
    }
    const cardsPage = await request(app).get(`/p/${workspace.slug}/cards-page`);
    expect(cardsPage.text).toContain("&lt;script&gt;globalThis.bad=true&lt;/script&gt;");
  });

  it("keeps draft and superseded versions private and binds custom domains to their owning workspace", async () => {
    const store = new MemorySuiteStore("fleet");
    const firstActor = await actor(store, ownerA);
    const secondActor = await actor(store, ownerB);
    const first = await publishPage(store, firstActor.auth, { slug: "studio", title: "Northwind Studio", description: "Workspace A public page.", layout: "stack" });
    const second = await publishPage(store, secondActor.auth, { slug: "studio", title: "Contoso Studio", description: "Workspace B public page.", layout: "cards" });
    const replacement = await nextVersion(store, firstActor.auth, { pageId: first.page.id, slug: "studio", links: first.links, title: "Northwind Journal", layout: "editorial" });
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, synchronizeSuiteEntitlements: false, suiteEntitlementMode: "unrestricted" });

    expect((await request(app).get(`/p/${firstActor.workspace.slug}/studio`)).text).toContain('data-layout="stack"');
    let discovery = await request(app).get(`/api/public/${firstActor.workspace.slug}/brand-pages`);
    expect(discovery.body.records[0]).toMatchObject({ pageVersionId: first.version.id, layout: "stack", title: "Northwind Studio" });
    expect(discovery.body.records[0].pageVersionId).not.toBe(replacement.id);

    await run(store, firstActor.auth, "page-version-publish", {
      pageVersionId: replacement.id,
      contentHash: replacement.data.contentHash,
      dryRun: false,
      approval: approval(ownerA, "publish-studio-v2"),
      idempotencyKey: key("publish-studio-v2"),
    });
    const current = await request(app).get(`/p/${firstActor.workspace.slug}/studio`);
    expect(current.status).toBe(200);
    expect(current.text).toContain("Northwind Journal");
    expect(current.text).toContain('data-layout="editorial"');
    expect((await request(app).get(`/embeds/pages/${firstActor.workspace.id}/${first.version.id}`)).status).toBe(404);
    discovery = await request(app).get(`/api/public/${firstActor.workspace.slug}/brand-pages`);
    expect(discovery.body.records[0]).toMatchObject({ pageVersionId: replacement.id, layout: "editorial", title: "Northwind Journal" });

    await store.addCustomDomain(ownerA, "pages-a.example.com");
    expect((await request(app).get("/p/studio").set("Host", "pages-a.example.com")).status).toBe(404);
    await store.setCustomDomainStatus(ownerA, "pages-a.example.com", "verified");
    await store.addCustomDomain(ownerB, "pages-b.example.com");
    await store.setCustomDomainStatus(ownerB, "pages-b.example.com", "active");
    const customA = await request(app).get("/p/studio").set("Host", "pages-a.example.com");
    const customB = await request(app).get("/p/studio").set("Host", "pages-b.example.com");
    expect(customA.text).toContain("Northwind Journal");
    expect(customA.text).not.toContain("Contoso Studio");
    expect(customB.text).toContain("Contoso Studio");
    expect(customB.text).not.toContain("Northwind Journal");
    expect((await request(app).get(`/embeds/pages/${firstActor.workspace.id}/${second.version.id}`)).status).toBe(404);

    await run(store, firstActor.auth, "route-disable", {
      routeId: first.page.id,
      routeKind: "page",
      reason: "The public campaign ended.",
      dryRun: false,
      approval: approval(ownerA, "disable-studio"),
      idempotencyKey: key("disable-studio"),
    });
    expect((await request(app).get(`/p/${firstActor.workspace.slug}/studio`)).status).toBe(404);
    expect((await request(app).get("/p/studio").set("Host", "pages-a.example.com")).status).toBe(404);
    expect((await request(app).get(`/api/public/${firstActor.workspace.slug}/brand-pages`)).body.records).toEqual([]);
    expect((await request(app).get("/p/studio").set("Host", "pages-b.example.com")).status).toBe(200);
  });
});
