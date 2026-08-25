import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { executeCoreBusinessAction, type CoreBusinessAuthorization } from "../src/server/core-business-engine.js";
import { createPublicKnowledgeRouter, publicKnowledgeMountContract } from "../src/server/public-knowledge-router.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const ownerA = "71717171-7171-4171-8171-717171717171";
const ownerB = "72727272-7272-4272-8272-727272727272";

function key(value: string) {
  return `atlasbase.public.${value}.0001`;
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function actor(store: MemorySuiteStore, userId: string) {
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.enableModule(userId, "knowledge");
  const refreshed = await store.getOrCreateWorkspace(userId);
  return {
    workspace: refreshed,
    auth: { userId, workspaceId: refreshed.id, role: "owner", scopes: ["*"] } satisfies CoreBusinessAuthorization,
  };
}

function testApp(store: MemorySuiteStore) {
  const app = express();
  app.disable("x-powered-by");
  app.use(createPublicKnowledgeRouter({ store }));
  return app;
}

async function publicLibraryFixture(store = new MemorySuiteStore("fleet"), userId = ownerA) {
  const context = await actor(store, userId);
  let clock = new Date("2026-08-25T10:00:00.000Z");
  let sequence = 0;
  const run = (actionId: string, input: Record<string, unknown>) => executeCoreBusinessAction(
    store,
    context.auth,
    "knowledge",
    actionId,
    input,
    { now: () => clock, modelPolicyId: "public-knowledge-test-model" },
  );
  const first = (result: Awaited<ReturnType<typeof run>>, recordType: string) => {
    const record = result.records.find((candidate) => candidate.recordType === recordType);
    if (!record) throw new Error(`Expected ${recordType}.`);
    return record;
  };
  const library = first(await run("library-create", {
    name: `Operations handbook ${userId.slice(0, 4)}`,
    defaultAccess: "public",
    locale: "en-US",
    reviewCadenceDays: 45,
    idempotencyKey: key(`library-${userId.slice(0, 4)}`),
  }), "knowledge-library");
  const privateEvidence = await store.createRecord(userId, {
    moduleId: "knowledge",
    recordType: "private-evidence",
    title: "Private evidence",
    state: "restricted",
    data: { private: true, secret: "TOP-SECRET-CUSTOMER-DATA" },
  });
  if (!privateEvidence) throw new Error("Expected private source evidence.");
  const privateEvidenceRecord = privateEvidence;

  async function draftAndPublish(input: { title: string; content: string; parentRevisionId?: string; suffix: string }) {
    const drafted = first(await run("page-revision-draft", {
      libraryId: library.id,
      title: input.title,
      content: input.content,
      sourceIds: [privateEvidenceRecord.id],
      ...(input.parentRevisionId ? { parentRevisionId: input.parentRevisionId } : {}),
      idempotencyKey: key(`draft-${userId.slice(0, 4)}-${input.suffix}`),
    }), "page-revision");
    sequence += 1;
    const approval = {
      approved: true as const,
      approvedBy: userId,
      approvedAt: clock.toISOString(),
      decisionId: `atlasbase.public.approval.${userId.slice(0, 4)}.${sequence}`,
      reason: "The exact immutable revision and its public audience were reviewed.",
    };
    const published = first(await run("page-revision-publish", {
      revisionId: drafted.id,
      contentHash: drafted.data.contentHash,
      dryRun: false,
      approval,
      idempotencyKey: key(`publish-${userId.slice(0, 4)}-${input.suffix}`),
    }), "page-revision");
    return published;
  }

  const original = await draftAndPublish({
    title: "Getting started",
    content: "# Original guide\n\nThis is the first published revision.",
    suffix: "original",
  });
  clock = new Date("2026-08-25T11:00:00.000Z");
  const latest = await draftAndPublish({
    title: "Operate the service safely",
    content: "# Safe operations\n\nNever render **untrusted HTML**.\n\n- Verify the revision digest\n- Cite reviewed sources\n\n<script>alert('must-not-run')</script>",
    parentRevisionId: original.id,
    suffix: "latest",
  });
  await run("source-link", {
    revisionId: latest.id,
    locator: "https://docs.example.com/reviewed-policy",
    observedAt: "2026-08-25T10:30:00.000Z",
    contentHash: hash("reviewed source snapshot"),
    trustNote: "Public policy snapshot reviewed by the operations owner.",
    idempotencyKey: key(`source-${userId.slice(0, 4)}`),
  });
  clock = new Date("2026-08-25T12:00:00.000Z");
  const draft = first(await run("page-revision-draft", {
    libraryId: library.id,
    title: "Unpublished replacement",
    content: "This draft must never appear publicly.",
    sourceIds: [],
    parentRevisionId: latest.id,
    idempotencyKey: key(`draft-${userId.slice(0, 4)}-unpublished`),
  }), "page-revision");

  return { ...context, store, app: testApp(store), library, privateEvidence: privateEvidenceRecord, original, latest, draft, run };
}

describe("public AtlasBase knowledge router", () => {
  it("renders only the deterministic latest published revision and keeps every published revision URL stable", async () => {
    const fixture = await publicLibraryFixture();
    const indexPath = `/knowledge/${fixture.workspace.slug}/${fixture.library.id}`;
    const index = await request(fixture.app).get(indexPath);
    expect(index.status).toBe(200);
    expect(index.headers["cache-control"]).toContain("s-maxage=60");
    expect(index.headers["content-security-policy"]).toMatch(/default-src 'none';.*script-src 'none';.*style-src 'sha256-/);
    expect(index.headers["content-language"]).toBe("en-US");
    expect(index.text).toContain("Operate the service safely");
    expect(index.text).not.toContain("Getting started");
    expect(index.text).not.toContain("Unpublished replacement");
    expect(index.text).toContain(`/knowledge/${fixture.workspace.slug}/${fixture.library.id}/pages/${fixture.latest.id}`);

    const oldRevision = await request(fixture.app).get(`${indexPath}/pages/${fixture.original.id}`);
    expect(oldRevision.status).toBe(200);
    expect(oldRevision.text).toContain("Getting started");
    expect(oldRevision.text).toContain(`/pages/${fixture.latest.id}`);
    expect(oldRevision.text).toContain("open the latest revision");

    const latestRevision = await request(fixture.app).get(`${indexPath}/pages/${fixture.latest.id}`);
    expect(latestRevision.status).toBe(200);
    expect(latestRevision.headers["cache-control"]).toBe("public, max-age=0, s-maxage=300, must-revalidate");
    expect(latestRevision.text).toContain("This is the latest published revision");
    expect(latestRevision.text).toContain("<h2>Safe operations</h2>");
    expect(latestRevision.text).toContain("<strong>untrusted HTML</strong>");
    expect(latestRevision.text).toContain("&lt;script&gt;alert(&#39;must-not-run&#39;)&lt;/script&gt;");
    expect(latestRevision.text).not.toContain("<script>alert");
    expect(latestRevision.text).toContain("https://docs.example.com/reviewed-policy");
    expect(latestRevision.text).toContain("Public policy snapshot reviewed by the operations owner.");
    expect(latestRevision.text).not.toContain("TOP-SECRET-CUSTOMER-DATA");
    expect(latestRevision.text).not.toContain(fixture.privateEvidence.id);
    expect(latestRevision.text).toContain(String(fixture.latest.data.contentHash));

    const unchanged = await request(fixture.app).get(`${indexPath}/pages/${fixture.latest.id}`).set("If-None-Match", latestRevision.headers.etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.text).toBe("");
  });

  it("exposes strict JSON projections with exact content hashes and no private source record data", async () => {
    const fixture = await publicLibraryFixture();
    const apiRoot = `/api/public/knowledge/${fixture.workspace.slug}/libraries/${fixture.library.id}`;
    const index = await request(fixture.app).get(apiRoot);
    expect(index.status).toBe(200);
    expect(Object.keys(index.body).sort()).toEqual(["library", "pages", "schema"]);
    expect(Object.keys(index.body.library).sort()).toEqual(["id", "locale", "name", "reviewCadenceDays"]);
    expect(index.body.pages).toHaveLength(1);
    expect(Object.keys(index.body.pages[0]).sort()).toEqual(["contentHash", "parentRevisionId", "publishedAt", "revisionId", "title"]);
    expect(index.body.pages[0]).toMatchObject({ revisionId: fixture.latest.id, contentHash: fixture.latest.data.contentHash, parentRevisionId: fixture.original.id });

    const page = await request(fixture.app).get(`${apiRoot}/pages/${fixture.latest.id}`);
    expect(page.status).toBe(200);
    expect(Object.keys(page.body).sort()).toEqual(["library", "page", "schema"]);
    expect(Object.keys(page.body.page).sort()).toEqual(["content", "contentHash", "isLatestRevision", "latestRevisionId", "parentRevisionId", "publishedAt", "revisionId", "sources", "title"]);
    expect(page.body.page).toMatchObject({
      revisionId: fixture.latest.id,
      contentHash: fixture.latest.data.contentHash,
      latestRevisionId: fixture.latest.id,
      isLatestRevision: true,
    });
    expect(page.body.page.sources).toHaveLength(1);
    expect(Object.keys(page.body.page.sources[0]).sort()).toEqual(["contentHash", "locator", "observedAt", "trustNote"]);
    expect(JSON.stringify(page.body)).not.toContain("sourceIds");
    expect(JSON.stringify(page.body)).not.toContain("workspaceId");
    expect(JSON.stringify(page.body)).not.toContain("approvalDecisionId");
    expect(JSON.stringify(page.body)).not.toContain("TOP-SECRET-CUSTOMER-DATA");
    expect(JSON.stringify(page.body)).not.toContain(fixture.privateEvidence.id);
  });

  it("serves verified custom domains while failing closed across domains, tenants, private libraries, drafts, and invalid hashes", async () => {
    const store = new MemorySuiteStore("fleet");
    const first = await publicLibraryFixture(store, ownerA);
    const second = await publicLibraryFixture(store, ownerB);
    const app = testApp(store);

    await store.addCustomDomain(ownerA, "kb-a.example.com");
    expect((await request(app).get(`/knowledge/${first.library.id}`).set("Host", "kb-a.example.com")).status).toBe(404);
    await store.setCustomDomainStatus(ownerA, "kb-a.example.com", "verified");
    await store.addCustomDomain(ownerB, "kb-b.example.com");
    await store.setCustomDomainStatus(ownerB, "kb-b.example.com", "active");

    const custom = await request(app).get(`/knowledge/${first.library.id}`).set("Host", "kb-a.example.com");
    expect(custom.status).toBe(200);
    expect(custom.text).toContain(first.library.title);
    expect(custom.text).not.toContain(second.library.title);
    expect(custom.text).toContain(`/knowledge/${first.library.id}/pages/${first.latest.id}`);
    expect((await request(app).get(`/knowledge/${first.library.id}`).set("Host", "kb-b.example.com")).status).toBe(404);
    expect((await request(app).get(`/knowledge/${second.library.id}`).set("Host", "kb-a.example.com")).status).toBe(404);
    expect((await request(app).get(`/knowledge/${first.workspace.slug}/${second.library.id}`)).status).toBe(404);

    const privateLibraryResult = await first.run("library-create", {
      name: "Private operator notes",
      defaultAccess: "private",
      locale: "en-US",
      reviewCadenceDays: 30,
      idempotencyKey: key("private-library"),
    });
    const privateLibrary = privateLibraryResult.records.find((record) => record.recordType === "knowledge-library")!;
    expect((await request(app).get(`/knowledge/${first.workspace.slug}/${privateLibrary.id}`)).status).toBe(404);
    expect((await request(app).get(`/knowledge/${first.workspace.slug}/${first.library.id}/pages/${first.draft.id}`)).status).toBe(404);

    const corrupted = await store.createRecord(ownerA, {
      moduleId: "knowledge",
      recordType: "page-revision",
      title: "Hash mismatch",
      state: "published",
      data: {
        libraryId: first.library.id,
        content: "This was not admitted through exact hash verification.",
        sourceIds: [],
        parentRevisionId: null,
        contentHash: "0".repeat(64),
        publishedContentHash: "0".repeat(64),
        publishedAt: "2026-08-25T13:00:00.000Z",
        immutableAfterPublication: true,
      },
    });
    if (!corrupted) throw new Error("Expected malformed fixture record.");
    expect((await request(app).get(`/knowledge/${first.workspace.slug}/${first.library.id}/pages/${corrupted.id}`)).status).toBe(404);
    const index = await request(app).get(`/api/public/knowledge/${first.workspace.slug}/libraries/${first.library.id}`);
    expect(JSON.stringify(index.body)).not.toContain("Hash mismatch");
  });

  it("publishes an explicit mount contract for integrators", () => {
    expect(publicKnowledgeMountContract()).toMatchObject({
      version: "atlasbase-public-mount.v1",
      mountPath: "/",
      routes: {
        hostedLibrary: "GET /knowledge/:workspaceSlug/:libraryId",
        customDomainRevision: "GET /knowledge/:libraryId/pages/:revisionId",
        hostedRevisionProjection: "GET /api/public/knowledge/:workspaceSlug/libraries/:libraryId/pages/:revisionId",
      },
      publicationRule: expect.stringContaining("content-hash-verified"),
    });
    expect(publicKnowledgeMountContract().privateRecordFieldsNeverProjected).toContain("sourceIds");
  });
});
