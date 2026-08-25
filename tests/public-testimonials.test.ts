import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { executeFirstPartyGrowthAction, type FirstPartyGrowthAuthorization } from "../src/server/first-party-growth-engine";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";

const ownerA = "95959595-9595-4595-8595-959595959595";
const ownerB = "96969696-9696-4696-8696-969696969696";
const fixedNow = new Date("2026-08-25T12:00:00.000Z");

function key(value: string) {
  return `public-proofport.${value}.0001`;
}

function approval(userId: string, value: string) {
  return {
    approved: true as const,
    approvedBy: userId,
    approvedAt: fixedNow.toISOString(),
    decisionId: `public-proofport.${value}.approval`,
    reason: "The exact moderated ProofPort version and public effect were reviewed.",
  };
}

async function actor(store: MemorySuiteStore, userId: string) {
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.enableModule(userId, "testimonials");
  return { workspace, auth: { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] } satisfies FirstPartyGrowthAuthorization };
}

async function run(store: MemorySuiteStore, auth: FirstPartyGrowthAuthorization, actionId: string, input: Record<string, unknown>) {
  return executeFirstPartyGrowthAction(store, auth, "testimonials", actionId, input, { now: () => fixedNow, publicBaseUrl: "https://cloud.example.test" });
}

function record(result: Awaited<ReturnType<typeof run>>, recordType: string) {
  const found = result.records.find((candidate) => candidate.recordType === recordType);
  if (!found) throw new Error(`Expected ${recordType}.`);
  return found;
}

describe("public ProofPort HTTP surfaces", () => {
  it("collects, moderates, publishes every widget layout, isolates tenants, and removes revoked consent", async () => {
    const store = new MemorySuiteStore("fleet");
    const firstActor = await actor(store, ownerA);
    const secondActor = await actor(store, ownerB);
    const collection = record(await run(store, firstActor.auth, "collection-create", {
      name: "Northwind customer outcomes",
      purpose: "Share a specific outcome for review before anything can be published.",
      consentPolicyVersion: "proofport-public-v1",
      retentionDays: 730,
      allowedLocales: ["en-US"],
      idempotencyKey: key("collection"),
    }), "collection");
    const collectionRequest = await run(store, firstActor.auth, "request-draft", {
      collectionId: collection.id,
      recipientRefHash: "a".repeat(64),
      expiresAt: "2035-12-31T23:59:00.000Z",
      locale: "en-US",
      contextLabel: "Northwind onboarding review",
      idempotencyKey: key("request"),
    });
    const requestRecord = record(collectionRequest, "collection-request");
    const accessToken = String(collectionRequest.audit.accessToken);
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);

    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, synchronizeSuiteEntitlements: false, suiteEntitlementMode: "unrestricted" });
    await store.addCustomDomain(ownerA, "proof-a.example.com");
    await store.setCustomDomainStatus(ownerA, "proof-a.example.com", "active");
    await store.addCustomDomain(ownerB, "proof-b.example.com");
    await store.setCustomDomainStatus(ownerB, "proof-b.example.com", "active");

    const platformCollection = await request(app).get(`/collect/testimonials/${firstActor.workspace.id}/${requestRecord.id}`).query({ token: accessToken });
    expect(platformCollection.status).toBe(200);
    expect(platformCollection.headers["cache-control"]).toBe("no-store");
    expect(platformCollection.headers["referrer-policy"]).toBe("no-referrer");
    expect(platformCollection.headers["content-security-policy"]).toMatch(/default-src 'none'.*connect-src 'self'.*script-src 'nonce-/);
    expect(platformCollection.text).toContain("Northwind customer outcomes");
    expect(platformCollection.text).toContain("Northwind onboarding review");
    expect(platformCollection.text).toContain('name="authorName"');
    expect(platformCollection.text).toContain('name="attribution"');
    expect(platformCollection.text).toContain('name="content"');
    expect(platformCollection.text).not.toContain('type="email"');
    expect(platformCollection.text).not.toContain("recipientRefHash");
    expect((await request(app).get(`/collect/testimonials/${secondActor.workspace.id}/${requestRecord.id}`).query({ token: accessToken })).status).toBe(404);
    expect((await request(app).get(`/collect/testimonials/${requestRecord.id}`).set("Host", "proof-a.example.com").query({ token: accessToken })).status).toBe(200);
    expect((await request(app).get(`/collect/testimonials/${requestRecord.id}`).set("Host", "proof-b.example.com").query({ token: accessToken })).status).toBe(404);
    expect((await request(app).get(`/collect/testimonials/${firstActor.workspace.id}/${requestRecord.id}`).query({ token: "x".repeat(32) })).status).toBe(404);

    const emptyDiscovery = await request(app).get(`/api/public/${firstActor.workspace.slug}/testimonials`);
    expect(emptyDiscovery.status).toBe(200);
    expect(emptyDiscovery.body.records).toEqual([]);
    expect(JSON.stringify(emptyDiscovery.body)).not.toContain(accessToken);
    expect(JSON.stringify(emptyDiscovery.body)).not.toContain("a".repeat(64));

    const testimonialBody = {
      authorName: "Asha Patel",
      content: "The workflow saved a full day and rendered <script>globalThis.proofPortXss=true</script> as text.",
      attribution: "first-name",
      authorRole: "Operations lead",
      organization: "Northwind Studio",
      consent: { granted: true, policyVersion: "proofport-public-v1", purposes: ["testimonial-publication"] },
    };
    const submission = await request(app)
      .post(`/api/public/testimonials/${firstActor.workspace.id}/requests/${requestRecord.id}/submissions`)
      .query({ token: accessToken })
      .send(testimonialBody);
    expect(submission.status).toBe(201);
    expect(submission.body).toMatchObject({ state: "pending-review", moderationStatus: "pending-review", replayed: false });
    expect(Object.keys(submission.body).sort()).toEqual(["id", "moderationStatus", "replayed", "state"]);
    expect(JSON.stringify(submission.body)).not.toContain(accessToken);
    expect(JSON.stringify(submission.body)).not.toContain(testimonialBody.content);
    const replay = await request(app)
      .post(`/api/public/testimonials/${firstActor.workspace.id}/requests/${requestRecord.id}/submissions`)
      .query({ token: accessToken })
      .send(testimonialBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: submission.body.id, replayed: true });
    expect((await request(app).get(`/collect/testimonials/${firstActor.workspace.id}/${requestRecord.id}`).query({ token: accessToken })).status).toBe(410);

    const privateEvidence = await store.getRecord(ownerA, submission.body.id);
    expect(privateEvidence?.data).toMatchObject({ content: testimonialBody.content, public: false, sourceRefHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await request(app).get(`/api/public/${firstActor.workspace.slug}/testimonials`)).body.records).toEqual([]);

    const moderation = record(await run(store, firstActor.auth, "moderation-decide", {
      testimonialId: submission.body.id,
      decision: "accept",
      reason: "Consent, attribution, and the exact statement were reviewed.",
      expectedVersion: 1,
      dryRun: false,
      approval: approval(ownerA, "moderation"),
      idempotencyKey: key("moderation"),
    }), "moderation-decision");
    const publication = record(await run(store, firstActor.auth, "publication-version-create", {
      testimonialId: submission.body.id,
      content: testimonialBody.content,
      attributionLabel: "Asha, Operations lead",
      disclosure: "Submitted by a customer and published after human review.",
      moderationDecisionId: moderation.id,
      idempotencyKey: key("publication"),
    }), "publication-version");
    await run(store, firstActor.auth, "publication-publish", {
      publicationVersionId: publication.id,
      contentHash: publication.data.contentHash,
      dryRun: false,
      approval: approval(ownerA, "publication"),
      idempotencyKey: key("publication-publish"),
    });

    const discovery = await request(app).get(`/api/public/${firstActor.workspace.slug}/testimonials`);
    expect(discovery.status).toBe(200);
    expect(discovery.body.records).toHaveLength(1);
    expect(discovery.body.records[0]).toMatchObject({ id: publication.id, content: testimonialBody.content, attributionLabel: "Asha, Operations lead" });
    expect(Object.keys(discovery.body.records[0]).sort()).toEqual(["attributionLabel", "content", "contentHash", "disclosure", "id", "publishedAt"]);
    for (const privateValue of [accessToken, "sourceRefHash", "consentReceiptId", "moderationDecisionId", "recipientRefHash"]) {
      expect(JSON.stringify(discovery.body)).not.toContain(privateValue);
    }
    expect((await request(app).get(`/api/public/${secondActor.workspace.slug}/testimonials`)).body.records).toEqual([]);

    const widgets = [];
    for (const layout of ["grid", "carousel", "quote-wall"] as const) {
      const widget = record(await run(store, firstActor.auth, "widget-version-create", {
        widgetKey: `${layout}-proof`,
        name: `${layout} proof`,
        publicationVersionIds: [publication.id],
        layout,
        theme: { accent: "#D9FF63", surface: "#10150F", text: "#F5F7EC", radiusPx: 18 },
        idempotencyKey: key(`widget-${layout}`),
      }), "widget-version");
      await run(store, firstActor.auth, "widget-publish", {
        widgetVersionId: widget.id,
        contentHash: widget.data.contentHash,
        dryRun: false,
        approval: approval(ownerA, `widget-${layout}`),
        idempotencyKey: key(`widget-publish-${layout}`),
      });
      widgets.push({ layout, widget });
    }

    const markers = { grid: 'class="testimonial-grid"', carousel: 'class="carousel-track"', "quote-wall": 'class="quote-wall"' } as const;
    for (const { layout, widget } of widgets) {
      const rendered = await request(app).get(`/embeds/testimonials/${firstActor.workspace.id}/${widget.id}`);
      expect(rendered.status).toBe(200);
      expect(rendered.headers["cache-control"]).toBe("public, max-age=60");
      expect(rendered.headers["content-security-policy"]).toContain("script-src 'none'");
      expect(rendered.headers["x-content-type-options"]).toBe("nosniff");
      expect(rendered.text).toContain(`data-layout="${layout}"`);
      expect(rendered.text).toContain(`data-widget-version="${widget.id}"`);
      expect(rendered.text).toContain(markers[layout]);
      expect(rendered.text).toContain("<blockquote>");
      expect(rendered.text).toContain("<figcaption>");
      expect(rendered.text).toContain("&lt;script&gt;globalThis.proofPortXss=true&lt;/script&gt;");
      expect(rendered.text).not.toContain("<script");
      expect(rendered.text).not.toContain("sourceRefHash");
      for (const [otherLayout, marker] of Object.entries(markers)) if (otherLayout !== layout) expect(rendered.text).not.toContain(marker);

      const publicWidget = await request(app).get(`/api/public/testimonials/${firstActor.workspace.id}/widgets/${widget.id}`);
      expect(publicWidget.status).toBe(200);
      expect(publicWidget.body.widget).toMatchObject({ id: widget.id, layout, testimonials: [{ id: publication.id }] });
      for (const privateValue of [accessToken, "sourceRefHash", "consentReceiptId", "moderationDecisionId", "recipientRefHash"]) {
        expect(JSON.stringify(publicWidget.body)).not.toContain(privateValue);
      }
    }

    const firstWidget = widgets[0].widget;
    const customWidget = await request(app).get(`/embeds/testimonials/${firstWidget.id}`).set("Host", "proof-a.example.com");
    expect(customWidget.status).toBe(200);
    expect(customWidget.text).toContain("Asha, Operations lead");
    expect((await request(app).get(`/embeds/testimonials/${firstWidget.id}`).set("Host", "proof-b.example.com")).status).toBe(404);
    expect((await request(app).get(`/embeds/testimonials/${secondActor.workspace.id}/${firstWidget.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/testimonials/widgets/${firstWidget.id}`).set("Host", "proof-b.example.com")).status).toBe(404);

    await run(store, firstActor.auth, "consent-revoke", {
      testimonialId: submission.body.id,
      reason: "The author withdrew publication consent.",
      dryRun: false,
      approval: approval(ownerA, "consent-revoke"),
      idempotencyKey: key("consent-revoke"),
    });
    expect((await request(app).get(`/api/public/${firstActor.workspace.slug}/testimonials`)).body.records).toEqual([]);
    for (const { widget } of widgets) {
      expect((await request(app).get(`/embeds/testimonials/${firstActor.workspace.id}/${widget.id}`)).status).toBe(404);
      expect((await request(app).get(`/api/public/testimonials/${firstActor.workspace.id}/widgets/${widget.id}`)).status).toBe(404);
    }
    expect((await request(app).get(`/embeds/testimonials/${firstWidget.id}`).set("Host", "proof-a.example.com")).status).toBe(404);
  });
});
