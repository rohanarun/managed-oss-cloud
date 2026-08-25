import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { executeCoreBusinessAction, type CoreBusinessAuthorization, type CoreBusinessExecutionResult } from "../src/server/core-business-engine.js";
import { createPublicFeedbackRouter, publicFeedbackMountContract } from "../src/server/public-feedback-router.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const owner = "11111111-1111-4111-8111-111111111111";
const secondOwner = "22222222-2222-4222-8222-222222222222";
const fixedNow = () => new Date("2026-08-25T16:00:00.000Z");

function first(result: CoreBusinessExecutionResult, recordType: string) {
  const record = result.records.find((candidate) => candidate.recordType === recordType);
  if (!record) throw new Error(`Expected ${recordType}.`);
  return record;
}

async function feedbackOwner(store: MemorySuiteStore, userId: string) {
  await store.getOrCreateWorkspace(userId);
  const workspace = (await store.enableModule(userId, "feedback"))!;
  const auth: CoreBusinessAuthorization = { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
  const run = (actionId: string, input: Record<string, unknown>) => executeCoreBusinessAction(store, auth, "feedback", actionId, input, { now: fixedNow, modelPolicyId: "test-no-model" });
  return { workspace, auth, run };
}

async function fixture(votingPolicy: "members" | "verified-submitters" | "public" = "public") {
  const store = new MemorySuiteStore("starter");
  const context = await feedbackOwner(store, owner);
  const board = first(await context.run("board-create", {
    name: "Product direction",
    visibility: "public",
    votingPolicy,
    idempotencyKey: `feedback-board-${votingPolicy}-0001`,
  }), "feedback-board");
  const app = express();
  app.use(createPublicFeedbackRouter({ suiteStore: store, now: fixedNow }));
  const pagePath = `/feedback/${context.workspace.slug}/${board.id}`;
  const apiPath = `/api/public/feedback/${context.workspace.slug}/boards/${board.id}`;
  return { store, board, app, pagePath, apiPath, ...context };
}

describe("IdeaLoop public feedback router", () => {
  it("serves an accessible no-script board and accepts its native request form through the typed engine", async () => {
    const context = await fixture();
    const browser = request.agent(context.app);
    const page = await browser.get(context.pagePath);

    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.headers["pragma"]).toBe("no-cache");
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'.*form-action 'self'.*style-src 'nonce-/);
    expect(page.headers["set-cookie"]?.[0]).toMatch(/idealoop_voter=.*HttpOnly.*SameSite=Lax/i);
    expect(page.text).toContain('href="#main"');
    expect(page.text).toContain('label for="request-title"');
    expect(page.text).toContain('label class="choice" for="request-consent"');
    expect(page.text).toContain('<form method="post"');
    expect(page.text).not.toContain("<script");
    expect(publicFeedbackMountContract()).toMatchObject({
      mountPath: "/",
      durableActions: ["feedback:request-submit", "feedback:vote-cast"],
    });

    const formKey = page.text.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
    expect(formKey).toMatch(/^idealoop\.request\./);
    const submitted = await browser
      .post(`/api/public/feedback/${context.workspace.slug}/boards/${context.board.id}/requests`)
      .type("form")
      .send({ title: "Keyboard navigation", problem: "I cannot complete the editor without a pointer.", consent: "on", idempotencyKey: formKey });
    expect(submitted.status).toBe(303);
    expect(submitted.headers.location).toBe(`${context.pagePath}?submitted=1`);

    const rendered = await browser.get(submitted.headers.location);
    expect(rendered.status).toBe(200);
    expect(rendered.text).toContain("Your request was submitted.");
    expect(rendered.text).toContain("Keyboard navigation");
    expect(rendered.text).toContain("I cannot complete the editor without a pointer.");
    expect(rendered.text).toContain("Open");

    const requests = await context.store.listRecords(owner, { moduleId: "feedback", recordType: "feedback-request", limit: 10 });
    const receipts = await context.store.listRecords(owner, { moduleId: "feedback", recordType: "command-receipt", limit: 20 });
    expect(requests).toHaveLength(1);
    expect(requests[0].data).toMatchObject({ boardId: context.board.id, consent: true, version: 1 });
    expect(receipts.some((receipt) => receipt.data.actionId === "request-submit" && receipt.data.idempotencyKey === formKey)).toBe(true);
  });

  it("replays exact requests, conflicts changed reuse, and reconciles one pseudonymous vote per browser", async () => {
    const context = await fixture();
    const browser = request.agent(context.app);
    await browser.get(context.pagePath);
    const requestPath = `${context.apiPath}/requests`;
    const submission = {
      title: "Bulk export <script>alert(1)</script>",
      problem: "Exporting one item at a time blocks the monthly review.",
      consent: true,
      idempotencyKey: "public-request-json-0001",
    };

    const created = await browser.post(requestPath).send(submission);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ schema: "idealoop-request-result.v1", outcome: "created", request: { status: "open", voteCount: 0 } });
    const requestId = created.body.request.id as string;

    const replayed = await browser.post(requestPath).send(submission);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ outcome: "replayed", request: { id: requestId } });
    const conflict = await browser.post(requestPath).send({ ...submission, title: "Changed title" });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: "idempotency_conflict", message: "That submission key is already bound to different feedback." });
    expect(await context.store.listRecords(owner, { moduleId: "feedback", recordType: "feedback-request", limit: 10 })).toHaveLength(1);

    const votePath = `${requestPath}/${requestId}/votes`;
    const vote = { decision: "up", idempotencyKey: "public-vote-json-0001" };
    const voted = await browser.post(votePath).send(vote);
    expect(voted.status).toBe(201);
    expect(voted.body).toMatchObject({ schema: "idealoop-vote-result.v1", outcome: "created", requestId, decision: "up", voteCount: 1 });
    const voteReplay = await browser.post(votePath).send(vote);
    expect(voteReplay.status).toBe(200);
    expect(voteReplay.body).toMatchObject({ outcome: "replayed", voteCount: 1 });
    const reconciled = await browser.post(votePath).send({ ...vote, idempotencyKey: "public-vote-json-0002" });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({ outcome: "reconciled", voteCount: 1 });

    const privateVotes = await context.store.listRecords(owner, { moduleId: "feedback", recordType: "feedback-vote", limit: 10 });
    expect(privateVotes).toHaveLength(1);
    expect(privateVotes[0].data.voterKeyHash).toMatch(/^[a-f0-9]{64}$/);
    const privateHash = String(privateVotes[0].data.voterKeyHash);
    await context.store.updateRecord(owner, requestId, { data: { customerEmail: "private-customer@example.test", internalEvidence: "private-evidence-42" } });

    const publicJson = await browser.get(context.apiPath);
    expect(publicJson.status).toBe(200);
    expect(publicJson.body.requests[0]).toEqual({
      id: requestId,
      title: submission.title,
      problem: submission.problem,
      status: "open",
      version: 1,
      voteCount: 1,
      updatedAt: expect.any(String),
    });
    const serialized = JSON.stringify(publicJson.body);
    expect(serialized).not.toContain(privateHash);
    expect(serialized).not.toContain("private-customer@example.test");
    expect(serialized).not.toContain("private-evidence-42");
    expect(serialized).not.toContain("consent");
    expect(serialized).not.toContain("idempotencyKey");
    expect(serialized).not.toContain(owner);

    const publicPage = await browser.get(context.pagePath);
    expect(publicPage.text).toContain("Bulk export &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(publicPage.text).toContain("1 vote");
    expect(publicPage.text).toContain("Withdraw vote");
    expect(publicPage.text).not.toContain(privateHash);
    expect(publicPage.text).not.toContain("private-customer@example.test");
    expect(publicPage.text).not.toContain("private-evidence-42");
    expect(publicPage.text).not.toContain("public-request-json-0001");

    const withdrawn = await browser.post(votePath).send({ decision: "withdraw", idempotencyKey: "public-vote-json-0003" });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({ outcome: "reconciled", decision: "withdraw", voteCount: 0 });
    expect(await context.store.listRecords(owner, { moduleId: "feedback", recordType: "feedback-vote", limit: 10 })).toHaveLength(1);
  });

  it("renders operator status transitions and supports the same board on a verified custom domain", async () => {
    const context = await fixture();
    expect(await context.store.addCustomDomain(owner, "ideas.customer.example")).toBeDefined();
    expect(await context.store.setCustomDomainStatus(owner, "ideas.customer.example", "verified")).toBeDefined();

    const customPage = await request(context.app).get(`/feedback/${context.board.id}`).set("Host", "ideas.customer.example");
    expect(customPage.status).toBe(200);
    expect(customPage.text).toContain(`/api/public/feedback/boards/${context.board.id}/requests`);
    const created = await request(context.app)
      .post(`/api/public/feedback/boards/${context.board.id}/requests`)
      .set("Host", "ideas.customer.example")
      .send({ title: "Saved filters", problem: "I rebuild the same view every morning.", consent: true, idempotencyKey: "custom-domain-request-0001" });
    expect(created.status).toBe(201);
    const requestId = created.body.request.id as string;

    await context.run("status-transition", {
      requestId,
      toStatus: "planned",
      expectedVersion: 1,
      explanation: "Accepted for the next planning cycle; no delivery date is promised.",
      idempotencyKey: "operator-status-planned-0001",
    });

    const rendered = await request(context.app).get(`/feedback/${context.board.id}`).set("Host", "ideas.customer.example");
    expect(rendered.status).toBe(200);
    expect(rendered.text).toContain("Planned");
    expect(rendered.text).toContain("Accepted for the next planning cycle; no delivery date is promised.");
    const projection = await request(context.app).get(`/api/public/feedback/boards/${context.board.id}`).set("Host", "ideas.customer.example");
    expect(projection.status).toBe(200);
    expect(projection.body.requests[0]).toMatchObject({ id: requestId, status: "planned", publicExplanation: "Accepted for the next planning cycle; no delivery date is promised.", version: 2 });
    expect(projection.body).not.toHaveProperty("workspaceId");
  });

  it("fails closed across tenants, private boards, non-public voting policies, and write-rate exhaustion", async () => {
    const context = await fixture();
    const second = await feedbackOwner(context.store, secondOwner);
    const secondBoard = first(await second.run("board-create", {
      name: "Second tenant board",
      visibility: "public",
      votingPolicy: "public",
      idempotencyKey: "second-tenant-board-0001",
    }), "feedback-board");
    const secondRequest = first(await second.run("request-submit", {
      boardId: secondBoard.id,
      title: "Second tenant request",
      problem: "This must never appear in the first tenant.",
      consent: true,
      idempotencyKey: "second-tenant-request-0001",
    }), "feedback-request");
    const privateBoard = first(await context.run("board-create", {
      name: "Private evidence board",
      visibility: "private",
      votingPolicy: "members",
      idempotencyKey: "private-feedback-board-0001",
    }), "feedback-board");

    expect((await request(context.app).get(`/feedback/${context.workspace.slug}/${secondBoard.id}`)).status).toBe(404);
    expect((await request(context.app).get(`/feedback/${context.workspace.slug}/${privateBoard.id}`)).status).toBe(404);
    expect((await request(context.app).post(`/api/public/feedback/${context.workspace.slug}/boards/${secondBoard.id}/requests`).send({ title: "Cross tenant", problem: "Should fail.", consent: true, idempotencyKey: "cross-tenant-request-0001" })).status).toBe(404);
    expect((await request(context.app).post(`${context.apiPath}/requests/${secondRequest.id}/votes`).send({ decision: "up", idempotencyKey: "cross-tenant-vote-0001" })).status).toBe(404);

    const restricted = await fixture("verified-submitters");
    const restrictedRequest = first(await restricted.run("request-submit", {
      boardId: restricted.board.id,
      title: "Verified-only vote",
      problem: "The public route cannot prove submitter verification.",
      consent: true,
      idempotencyKey: "restricted-vote-request-0001",
    }), "feedback-request");
    const rejectedVote = await request(restricted.app).post(`${restricted.apiPath}/requests/${restrictedRequest.id}/votes`).send({ decision: "up", idempotencyKey: "restricted-public-vote-0001" });
    expect(rejectedVote.status).toBe(403);
    expect(rejectedVote.body.error).toBe("public_voting_disabled");
    expect(await restricted.store.listRecords(owner, { moduleId: "feedback", recordType: "feedback-vote", limit: 10 })).toHaveLength(0);

    const limitedApp = express();
    limitedApp.use(createPublicFeedbackRouter({ suiteStore: context.store, now: fixedNow, writeRateLimit: { windowMs: 60_000, limit: 1 } }));
    const firstWrite = await request(limitedApp).post(`${context.apiPath}/requests`).send({ title: "Within limit", problem: "The first write is accepted.", consent: true, idempotencyKey: "rate-limit-request-0001" });
    expect(firstWrite.status).toBe(201);
    const limited = await request(limitedApp).post(`${context.apiPath}/requests`).send({ title: "Beyond limit", problem: "The second write is rejected.", consent: true, idempotencyKey: "rate-limit-request-0002" });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});
