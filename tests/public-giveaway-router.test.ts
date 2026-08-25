import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { executeFirstPartyGrowthAction, type FirstPartyGrowthAuthorization } from "../src/server/first-party-growth-engine";
import { createPublicGiveawayRouter, type PublicGiveawayRouterOptions } from "../src/server/public-giveaway-router";
import { MemorySuiteStore } from "../src/server/suite-store";

const ownerA = "91919191-9191-4191-8191-919191919191";
const ownerB = "92929292-9292-4292-8292-929292929292";
const initialTime = "2026-08-25T12:00:00.000Z";
const normalCloseTime = "2026-09-01T12:00:00.000Z";
const entropyReveal = "fairlaunch-test-secret-with-enough-entropy";

function sha(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function key(value: string) {
  return `public-giveaway.${value}.0001`;
}

function approval(userId: string, decision: string, at: Date) {
  return {
    approved: true as const,
    approvedBy: userId,
    approvedAt: at.toISOString(),
    decisionId: `public-giveaway.${decision}.approval`,
    reason: "The exact public contest mutation was reviewed for this test.",
  };
}

async function publishContest(input: {
  store: MemorySuiteStore;
  userId: string;
  clock: Date;
  suffix: string;
  closesAt?: string;
}) {
  const { store, userId, clock, suffix } = input;
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.enableModule(userId, "giveaways");
  const auth: FirstPartyGrowthAuthorization = { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
  const created = await executeFirstPartyGrowthAction(store, auth, "giveaways", "contest-create", {
    name: `Fair draw ${suffix}`,
    description: `A public contest for tenant ${suffix}.`,
    closesAt: input.closesAt ?? normalCloseTime,
    rules: "One consented entry per email. Retries never create another entry.",
    entropyCommitment: sha(entropyReveal),
    consentPolicyVersion: `contest-policy-${suffix}`,
    referralBonusCap: 2,
    prizeDescription: "One annual workspace plan",
    idempotencyKey: key(`create-${suffix}`),
  }, { now: () => clock });
  const contest = created.records.find((record) => record.recordType === "contest");
  if (!contest) throw new Error("Expected a contest record.");
  await executeFirstPartyGrowthAction(store, auth, "giveaways", "contest-publish", {
    contestId: contest.id,
    expectedVersion: 1,
    rulesHash: contest.data.rulesHash,
    dryRun: false,
    approval: approval(userId, `publish-${suffix}`, clock),
    idempotencyKey: key(`publish-${suffix}`),
  }, { now: () => clock });
  return { auth, contest, workspace: (await store.getWorkspaceBySlug(workspace.slug))! };
}

function testApp(store: MemorySuiteStore, options: Omit<PublicGiveawayRouterOptions, "store"> = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(createPublicGiveawayRouter({ store, ...options }));
  return app;
}

function jsonEntry(email: string, displayName = "Avery") {
  return { email, displayName, consent: true };
}

describe("public FairLaunch giveaway router", () => {
  it("renders an accessible hosted page and turns a normal email into one private typed entry", async () => {
    const store = new MemorySuiteStore("fleet");
    const clock = new Date(initialTime);
    const { contest, workspace } = await publishContest({ store, userId: ownerA, clock, suffix: "hosted" });
    const app = testApp(store, { now: () => clock });
    const pagePath = `/giveaways/${workspace.slug}/${contest.id}`;

    const page = await request(app).get(pagePath);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.headers["content-security-policy"]).toMatch(/^default-src 'none';.*frame-ancestors 'none';.*form-action 'self';.*script-src 'none';.*style-src 'nonce-/);
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.text).toContain('<label for="entry-email">Email</label>');
    expect(page.text).toContain('type="email"');
    expect(page.text).toContain('name="consent"');
    expect(page.text).toContain("if I provide a referral code, referral attribution");
    expect(page.text).toContain("One consented entry per email");
    expect(page.text).toContain(`datetime="${normalCloseTime}"`);
    expect(page.text).toContain("The raw address is not stored");
    expect(page.text).not.toContain("participantKeyHash");
    expect(page.text).not.toContain("organizerEntropyCommitment");

    const first = await request(app).post(`${pagePath}/entries`).type("form").send({
      email: " Avery.Person@Example.COM ",
      displayName: "Avery",
      consent: "on",
    });
    expect(first.status).toBe(201);
    expect(first.headers["content-type"]).toContain("text/html");
    expect(first.text).toContain("Entry confirmed");
    expect(first.text).not.toContain("Avery.Person@Example.COM");

    const entries = await store.listRecords(ownerA, { moduleId: "giveaways", recordType: "entrant", limit: 10 });
    const receipts = await store.listRecords(ownerA, { moduleId: "giveaways", recordType: "consent-receipt", limit: 10 });
    expect(entries).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    const browserEmailDigest = sha("fairlaunch/browser-email/v1:avery.person@example.com");
    const expectedParticipantDigest = sha(`fairlaunch/participant/v1:${workspace.id}:${contest.id}:${browserEmailDigest}`);
    expect(entries[0].data.participantKeyHash).toBe(expectedParticipantDigest);
    expect(entries[0].data.participantKeyHash).not.toBe(sha("avery.person@example.com"));
    expect(receipts[0].data).toMatchObject({
      contestId: contest.id,
      participantKeyHash: expectedParticipantDigest,
      policyVersion: "contest-policy-hosted",
      purposes: ["contest-administration"],
      captureMethod: "hosted-form",
      public: false,
    });
    expect(JSON.stringify({ entries, receipts }).toLowerCase()).not.toContain("avery.person@example.com");

    const replay = await request(app).post(`${pagePath}/entries`).set("Accept", "application/json").send(jsonEntry("avery.person@EXAMPLE.com"));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: entries[0].id, state: "eligible", replayed: true });
    expect(replay.body).not.toHaveProperty("email");
    expect(replay.body).not.toHaveProperty("participantKeyHash");

    const conflict = await request(app).post(`${pagePath}/entries`).set("Accept", "application/json").send(jsonEntry("avery.person@example.com", "Changed retry"));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("This entry conflicts with an existing entry, referral, or contest policy.");
    expect(JSON.stringify(conflict.body)).not.toContain("avery.person@example.com");
    expect(await store.listRecords(ownerA, { moduleId: "giveaways", recordType: "entrant", limit: 10 })).toHaveLength(1);
    expect(await store.listRecords(ownerA, { moduleId: "giveaways", recordType: "consent-receipt", limit: 10 })).toHaveLength(1);
  });

  it("serializes replay and conflicting races without duplicate entrants or consent receipts", async () => {
    const store = new MemorySuiteStore("fleet");
    const clock = new Date(initialTime);
    const { contest, workspace } = await publishContest({ store, userId: ownerA, clock, suffix: "race" });
    const app = testApp(store, { now: () => clock });
    const entryPath = `/giveaways/${workspace.slug}/${contest.id}/entries`;
    const body = jsonEntry("race@example.com", "Race entry");

    const replayRace = await Promise.all([
      request(app).post(entryPath).set("Accept", "application/json").send(body),
      request(app).post(entryPath).set("Accept", "application/json").send(body),
    ]);
    expect(replayRace.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(replayRace[0].body.id).toBe(replayRace[1].body.id);

    const conflictRace = await Promise.all([
      request(app).post(entryPath).set("Accept", "application/json").send(jsonEntry("conflict@example.com", "Left")),
      request(app).post(entryPath).set("Accept", "application/json").send(jsonEntry("conflict@example.com", "Right")),
    ]);
    expect(conflictRace.map((response) => response.status).sort()).toEqual([201, 409]);
    const entries = await store.listRecords(ownerA, { moduleId: "giveaways", recordType: "entrant", limit: 10 });
    const receipts = await store.listRecords(ownerA, { moduleId: "giveaways", recordType: "consent-receipt", limit: 10 });
    expect(entries).toHaveLength(2);
    expect(receipts).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.data.participantKeyHash)).size).toBe(2);
  });

  it("serves only verified custom-domain contests and keeps platform and domain tenants isolated", async () => {
    const store = new MemorySuiteStore("fleet");
    const clock = new Date(initialTime);
    const first = await publishContest({ store, userId: ownerA, clock, suffix: "tenant-a" });
    const second = await publishContest({ store, userId: ownerB, clock, suffix: "tenant-b" });
    const app = testApp(store, { now: () => clock });
    await store.addCustomDomain(ownerA, "draws-a.example.com");

    const pending = await request(app).get(`/giveaways/${first.contest.id}`).set("Host", "draws-a.example.com");
    expect(pending.status).toBe(404);
    expect(pending.text).not.toContain(first.contest.title);
    await store.setCustomDomainStatus(ownerA, "draws-a.example.com", "verified");
    await store.addCustomDomain(ownerB, "draws-b.example.com");
    await store.setCustomDomainStatus(ownerB, "draws-b.example.com", "active");

    const custom = await request(app).get(`/giveaways/${first.contest.id}`).set("Host", "draws-a.example.com");
    expect(custom.status).toBe(200);
    expect(custom.text).toContain(first.contest.title);
    expect(custom.text).not.toContain(second.contest.title);
    expect(custom.text).toContain(`action="/giveaways/${first.contest.id}/entries"`);

    expect((await request(app).get(`/giveaways/${first.contest.id}`).set("Host", "draws-b.example.com")).status).toBe(404);
    expect((await request(app).get(`/giveaways/${second.workspace.slug}/${first.contest.id}`)).status).toBe(404);
    expect((await request(app).get(`/giveaways/${first.workspace.slug}/${second.contest.id}`)).status).toBe(404);

    const entryBody = jsonEntry("tenant-a@example.com", "Tenant A entry");
    const accepted = await request(app).post(`/giveaways/${first.contest.id}/entries`).set("Host", "draws-a.example.com").set("Accept", "application/json").send(entryBody);
    expect(accepted.status).toBe(201);
    const crossTenant = await request(app).post(`/giveaways/${first.contest.id}/entries`).set("Host", "draws-b.example.com").set("Accept", "application/json").send(entryBody);
    const missing = await request(app).post("/giveaways/11111111-1111-4111-8111-111111111111/entries").set("Host", "draws-b.example.com").set("Accept", "application/json").send(entryBody);
    expect(crossTenant.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(crossTenant.body).toEqual(missing.body);
    expect(await store.listRecords(ownerA, { moduleId: "giveaways", recordType: "entrant", limit: 10 })).toHaveLength(1);
    expect(await store.listRecords(ownerB, { moduleId: "giveaways", recordType: "entrant", limit: 10 })).toHaveLength(0);
  });

  it("publishes a reproducible draw proof without private entry identifiers and rate-limits writes", async () => {
    const store = new MemorySuiteStore("fleet");
    let clock = new Date(initialTime);
    const { auth, contest, workspace } = await publishContest({
      store,
      userId: ownerA,
      clock,
      suffix: "proof",
      closesAt: "2026-08-25T13:00:00.000Z",
    });
    const app = testApp(store, { now: () => clock });
    const pagePath = `/giveaways/${workspace.slug}/${contest.id}`;
    const entry = await request(app).post(`${pagePath}/entries`).set("Accept", "application/json").send(jsonEntry("winner@example.com", "Private winner"));
    expect(entry.status).toBe(201);

    clock = new Date("2026-08-25T14:00:00.000Z");
    const frozen = await executeFirstPartyGrowthAction(store, auth, "giveaways", "draw-snapshot-freeze", {
      contestId: contest.id,
      expectedContestVersion: 2,
      dryRun: false,
      approval: approval(ownerA, "freeze-proof", clock),
      idempotencyKey: key("freeze-proof"),
    }, { now: () => clock });
    const snapshot = frozen.records.find((record) => record.recordType === "draw-snapshot");
    if (!snapshot) throw new Error("Expected a frozen draw snapshot.");
    const drawn = await executeFirstPartyGrowthAction(store, auth, "giveaways", "winner-draw-reveal", {
      snapshotId: snapshot.id,
      entropyReveal,
      publicEntropy: "public-beacon-round-42000",
      publicEntropySource: "https://example.org/randomness/42000",
      beaconObservedAt: clock.toISOString(),
      dryRun: false,
      approval: approval(ownerA, "draw-proof", clock),
      idempotencyKey: key("draw-proof"),
    }, { now: () => clock });
    const winnerProof = drawn.records.find((record) => record.recordType === "winner-proof");
    if (!winnerProof) throw new Error("Expected a private winner proof.");

    const page = await request(app).get(pagePath);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Winner selected");
    expect(page.text).toContain("sha256-commit-public-entropy-rejection-v1");
    expect(page.text).toContain(String(winnerProof.data.winnerToken));
    expect(page.text).toContain(String(winnerProof.data.candidatesHash));
    expect(page.text).toContain(entropyReveal);
    expect(page.text).toContain("public-beacon-round-42000");
    expect(page.text).not.toContain("winnerEntryId");
    expect(page.text).not.toContain(String(winnerProof.data.winnerEntryId));
    expect(page.text).not.toContain(entry.body.id);
    expect(page.text).not.toContain("winner@example.com");
    expect(page.text).not.toContain('type="email"');
    expect((await request(app).post(`${pagePath}/entries`).set("Accept", "application/json").send(jsonEntry("closed@example.com"))).status).toBe(404);

    const currentContest = await store.getRecord(ownerA, contest.id);
    const proof = currentContest?.data.publicDrawProof as Record<string, unknown>;
    await store.updateRecord(ownerA, contest.id, { data: { publicDrawProof: { ...proof, winnerToken: "0".repeat(24) } } });
    expect((await request(app).get(pagePath)).status).toBe(404);

    const rateStore = new MemorySuiteStore("fleet");
    const rateContest = await publishContest({ store: rateStore, userId: ownerA, clock: new Date(initialTime), suffix: "rate" });
    const rateApp = testApp(rateStore, { now: () => new Date(initialTime), entryRateLimit: { limit: 1, windowMs: 60_000 } });
    const ratePath = `/giveaways/${rateContest.workspace.slug}/${rateContest.contest.id}/entries`;
    expect((await request(rateApp).post(ratePath).set("Accept", "application/json").send(jsonEntry("first@example.com"))).status).toBe(201);
    const limited = await request(rateApp).post(ratePath).set("Accept", "application/json").send(jsonEntry("second@example.com"));
    expect(limited.status).toBe(429);
    expect(limited.headers["cache-control"]).toContain("no-store");
    expect(limited.body).toEqual({ error: "Too many entry attempts were made. Try again later." });
    expect(await rateStore.listRecords(ownerA, { moduleId: "giveaways", recordType: "entrant", limit: 10 })).toHaveLength(1);
  });
});
