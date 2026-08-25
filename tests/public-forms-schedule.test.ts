import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { MemoryRepository } from "../src/server/repository";
import { executeSuiteAction, type SuiteActionResult, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { PUBLIC_BOOKING_POLICY_VERSION } from "../src/server/public-form-schedule";

const owner = "81818181-8181-4181-8181-818181818181";
const secondOwner = "82828282-8282-4282-8282-828282828282";

function fixedDependencies(clock = "2026-08-25T12:00:00.000Z"): SuiteEngineDependencies {
  return { now: () => new Date(clock), resolveTxt: async () => [], resolveHost: async () => ["93.184.216.34"] };
}

function firstRecord(result: SuiteActionResult) {
  if (result.kind === "record") return result.record;
  if (result.kind === "command" && result.records[0]) return result.records[0];
  throw new Error("Expected a durable record.");
}

async function publishForm(store: MemorySuiteStore, userId = owner) {
  await store.enableModule(userId, "forms");
  const form = firstRecord(await executeSuiteAction(store, userId, "forms", "form-create", { name: "Project intake" }, fixedDependencies()));
  const release = firstRecord(await executeSuiteAction(store, userId, "forms", "form-draft", {
    formId: form.id,
    title: "Tell us about your project",
    schema: {
      version: 1,
      fields: [
        { key: "name", type: "short-text", required: true, purpose: "Address your response", privacy: "internal" },
        { key: "email", type: "email", required: true, purpose: "Reply to your request", privacy: "restricted" },
        { key: "team-size", type: "integer", required: true, purpose: "Plan the engagement", privacy: "internal" },
        { key: "project-type", type: "choice", required: true, purpose: "Route the request", privacy: "internal", choices: ["Website", "Application"] },
        { key: "details", type: "long-text", required: false, purpose: "Understand the project", privacy: "internal" },
      ],
    },
    logic: [{ when: { field: "project-type", equals: "Website" }, effect: "require", target: "details" }],
  }, fixedDependencies()));
  await executeSuiteAction(store, userId, "forms", "release-publish", {
    releaseId: release.id,
    contentHash: release.data.contentHash,
    idempotencyKey: `form-release-publish-${userId.slice(0, 8)}`,
  }, fixedDependencies());
  return { form, release };
}

async function publishEvent(store: MemorySuiteStore, userId = owner) {
  await store.enableModule(userId, "schedule");
  const host = firstRecord(await executeSuiteAction(store, userId, "schedule", "host-create", { name: "Asha" }, fixedDependencies()));
  const revision = firstRecord(await executeSuiteAction(store, userId, "schedule", "schedule-draft", {
    name: "Weekday schedule",
    timeZone: "America/New_York",
    hostIds: [host.id],
    windows: [{ dayOfWeek: 2, start: "09:00", end: "17:00" }],
  }, fixedDependencies()));
  await executeSuiteAction(store, userId, "schedule", "schedule-publish", { revisionId: revision.id, contentHash: revision.data.contentHash }, fixedDependencies());
  const release = firstRecord(await executeSuiteAction(store, userId, "schedule", "event-draft", {
    name: "Product consultation",
    slug: "product-consultation",
    scheduleRevisionId: revision.id,
    hostIds: [host.id],
    durationMinutes: 30,
  }, fixedDependencies()));
  await executeSuiteAction(store, userId, "schedule", "event-publish", { releaseId: release.id, contentHash: release.data.contentHash }, fixedDependencies());
  return { host, release };
}

describe("public form and scheduling portals", () => {
  it("renders and submits an exact published form without exposing private answers", async () => {
    const store = new MemorySuiteStore("starter");
    const { release } = await publishForm(store);
    const workspace = await store.getOrCreateWorkspace(owner);
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, synchronizeSuiteEntitlements: false });

    const page = await request(app).get(`/forms/${workspace.slug}/${release.id}`);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'.*nonce-/);
    expect(page.text).toContain('for="field-name"');
    expect(page.text).toContain('type="email"');
    expect(page.text).toContain("credentials:'omit'");
    expect(page.text).not.toContain("third-party tracking is created.</p></section><script");

    const body = {
      responseValues: { name: "Asha", email: "asha@example.com", "team-size": 8, "project-type": "Website", details: "A launch site" },
      respondentKey: "respondent-public-0001",
      idempotencyKey: "public-form-submission-0001",
    };
    const submitted = await request(app).post(`/api/public/${workspace.slug}/forms/${release.id}/submissions`).send(body);
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({ state: "submitted", replayed: false });
    expect(submitted.body).not.toHaveProperty("responseValues");
    expect(JSON.stringify(submitted.body)).not.toContain("asha@example.com");

    const privateSubmissions = await store.listRecords(owner, { moduleId: "forms", recordType: "submission", limit: 10 });
    const privateVersions = await store.listRecords(owner, { moduleId: "forms", recordType: "submission-version", limit: 10 });
    expect(privateSubmissions).toHaveLength(1);
    expect(privateVersions).toHaveLength(1);
    expect(privateSubmissions[0].data).toMatchObject({ releaseId: release.id, currentAnswers: body.responseValues, version: 1 });
    expect(privateSubmissions[0].data.respondentDigest).toMatch(/^[a-f0-9]{64}$/);

    const replay = await request(app).post(`/api/public/${workspace.slug}/forms/${release.id}/submissions`).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ submissionId: submitted.body.submissionId, replayed: true });
    const changed = await request(app).post(`/api/public/${workspace.slug}/forms/${release.id}/submissions`).send({ ...body, responseValues: { ...body.responseValues, name: "Changed" } });
    expect(changed.status).toBe(409);
    expect(changed.body.error).not.toContain("Changed");
    expect((await request(app).post(`/api/public/${workspace.slug}/forms/${release.id}/submissions`).send({ ...body, idempotencyKey: "public-form-submission-0002", responseValues: { ...body.responseValues, undeclared: true } })).status).toBe(400);

    const second = await publishForm(store, secondOwner);
    const secondWorkspace = await store.getOrCreateWorkspace(secondOwner);
    expect(second.release.id).not.toBe(release.id);
    expect((await request(app).get(`/forms/${secondWorkspace.slug}/${release.id}`)).status).toBe(404);

    await store.addCustomDomain(owner, "forms.customer.example");
    await store.setCustomDomainStatus(owner, "forms.customer.example", "active");
    expect((await request(app).get(`/forms/${release.id}`).set("Host", "forms.customer.example")).status).toBe(200);
    const custom = await request(app).post(`/api/public/forms/${release.id}/submissions`).set("Host", "forms.customer.example").send({ ...body, idempotencyKey: "public-form-submission-custom-0003" });
    expect(custom.status).toBe(201);
  });

  it("shows live slots and creates conflict-safe bookings with private invitee consent", async () => {
    const store = new MemorySuiteStore("starter");
    const { host } = await publishEvent(store);
    const workspace = await store.getOrCreateWorkspace(owner);
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: store, synchronizeSuiteEntitlements: false });

    const page = await request(app).get(`/book/${workspace.slug}/product-consultation`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Choose a live available time");
    expect(page.text).toContain('id="invitee-email"');
    expect(page.text).toContain("credentials:'omit'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    const availabilityPath = `/api/public/${workspace.slug}/schedule/product-consultation/availability`;
    const availability = await request(app).get(availabilityPath).query({
      from: "2026-08-25T13:00:00.000Z",
      to: "2026-08-25T18:00:00.000Z",
      timeZone: "America/New_York",
    });
    expect(availability.status).toBe(200);
    expect(availability.body.reservationHeld).toBe(false);
    expect(availability.body.slots.length).toBeGreaterThan(2);
    expect(availability.body.slots[0]).toEqual(expect.objectContaining({ hostId: host.id }));
    expect(JSON.stringify(availability.body)).not.toContain("invitee");

    const chosen = availability.body.slots[0];
    const bookingBody = {
      ...chosen,
      idempotencyKey: "public-booking-attempt-0001",
      invitee: {
        name: "Asha Patel",
        email: "ASHA@EXAMPLE.COM",
        timeZone: "America/New_York",
        notes: "Discuss onboarding",
        consent: { granted: true, policyVersion: PUBLIC_BOOKING_POLICY_VERSION },
      },
    };
    const booked = await request(app).post(`/api/public/${workspace.slug}/schedule/product-consultation/bookings`).send(bookingBody);
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ state: "confirmed", startsAt: chosen.startsAt, endsAt: chosen.endsAt, providerStatus: "not-configured", replayed: false });
    expect(JSON.stringify(booked.body)).not.toContain("ASHA");
    expect(JSON.stringify(booked.body)).not.toContain("onboarding");

    const privateBooking = (await store.listRecords(owner, { moduleId: "schedule", recordType: "booking", limit: 10 }))[0];
    expect(privateBooking.data).toMatchObject({
      invitee: { name: "Asha Patel", email: "asha@example.com", timeZone: "America/New_York", consent: { granted: true, policyVersion: PUBLIC_BOOKING_POLICY_VERSION } },
      providerStatus: "not-configured",
    });
    expect(privateBooking.data.inviteeDigest).toMatch(/^[a-f0-9]{64}$/);

    const replay = await request(app).post(`/api/public/${workspace.slug}/schedule/product-consultation/bookings`).send(bookingBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ bookingId: booked.body.bookingId, replayed: true });
    const changedInvitee = await request(app).post(`/api/public/${workspace.slug}/schedule/product-consultation/bookings`).send({ ...bookingBody, invitee: { ...bookingBody.invitee, email: "other@example.com" } });
    expect(changedInvitee.status).toBe(409);

    const raceSlot = availability.body.slots[1];
    const race = await Promise.all([
      request(app).post(`/api/public/${workspace.slug}/schedule/product-consultation/bookings`).send({ ...bookingBody, ...raceSlot, idempotencyKey: "public-booking-race-0002" }),
      request(app).post(`/api/public/${workspace.slug}/schedule/product-consultation/bookings`).send({ ...bookingBody, ...raceSlot, idempotencyKey: "public-booking-race-0003" }),
    ]);
    expect(race.map((item) => item.status).sort()).toEqual([201, 409]);
    expect((await request(app).post(`/api/public/${workspace.slug}/schedule/product-consultation/bookings`).send({ ...bookingBody, ...availability.body.slots[2], idempotencyKey: "public-booking-policy-0004", invitee: { ...bookingBody.invitee, consent: { granted: true, policyVersion: "wrong-policy" } } })).status).toBe(400);

    await publishEvent(store, secondOwner);
    const secondWorkspace = await store.getOrCreateWorkspace(secondOwner);
    expect((await request(app).get(`/book/${secondWorkspace.slug}/product-consultation`)).status).toBe(200);
    expect((await request(app).get(`/book/${secondWorkspace.slug}/missing-event`)).status).toBe(404);

    await store.addCustomDomain(owner, "book.customer.example");
    await store.setCustomDomainStatus(owner, "book.customer.example", "active");
    expect((await request(app).get("/book/product-consultation").set("Host", "book.customer.example")).status).toBe(200);
    const customAvailability = await request(app).get("/api/public/schedule/product-consultation/availability").set("Host", "book.customer.example").query({
      from: "2026-08-25T13:00:00.000Z",
      to: "2026-08-25T18:00:00.000Z",
      timeZone: "America/New_York",
    });
    expect(customAvailability.status).toBe(200);
    expect(customAvailability.body.slots.every((slot: { startsAt: string }) => slot.startsAt !== chosen.startsAt && slot.startsAt !== raceSlot.startsAt)).toBe(true);
  });
});
