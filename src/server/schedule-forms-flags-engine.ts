import { createHash } from "node:crypto";
import type { SuiteActionDefinition } from "../shared/suite-actions.js";
import type { SuiteRecord } from "../shared/suite.js";
import type { SuiteStore } from "./suite-store.js";

export type DeterministicSuiteActionResult =
  | { kind: "record"; action: SuiteActionDefinition; record: SuiteRecord }
  | { kind: "command"; action: SuiteActionDefinition; records: SuiteRecord[]; audit: Record<string, unknown> };

const actionLocks = new Map<string, Promise<void>>();

async function locked<T>(key: string, work: () => Promise<T>) {
  const previous = actionLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  actionLocks.set(key, tail);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (actionLocks.get(key) === tail) actionLocks.delete(key);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown) { return JSON.stringify(canonicalValue(value)); }
function digest(value: unknown) { return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex"); }
function result(action: SuiteActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>): DeterministicSuiteActionResult { return { kind: "command", action, records, audit }; }

function text(input: Record<string, unknown>, name: string, maximum = 4_000) {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  return value.trim();
}

function array(input: Record<string, unknown>, name: string, maximum = 1_000, allowEmpty = false) {
  const value = input[name];
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > maximum) throw new Error(`${name} must be ${allowEmpty ? "an" : "a non-empty"} array with at most ${maximum} items.`);
  return value;
}

function object(input: Record<string, unknown>, name: string) {
  const value = input[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function integer(input: Record<string, unknown>, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be a safe integer from ${minimum} to ${maximum}.`);
  return value;
}

function sha256(input: Record<string, unknown>, name = "contentHash") {
  const value = text(input, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  return value;
}

function idempotencyKey(input: Record<string, unknown>) {
  const value = text(input, "idempotencyKey", 200);
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(value)) throw new Error("idempotencyKey must contain 16 to 200 safe characters.");
  return value;
}

function stableKey(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,79}$/.test(value)) throw new Error(`${label} must be a stable lowercase key.`);
  return value;
}

function dateTime(input: Record<string, unknown>, name: string) {
  const value = text(input, name, 40);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error(`${name} must be an ISO 8601 date-time.`);
  return parsed;
}

function timeZone(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("timeZone must be an IANA time-zone name.");
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date()); }
  catch { throw new Error("timeZone must be an IANA time-zone name."); }
  return value;
}

async function owned(store: SuiteStore, userId: string, recordId: unknown, moduleId: string, recordType: string, label: string) {
  if (typeof recordId !== "string") throw new Error(`${label} must be a UUID string.`);
  const record = await store.getRecord(userId, recordId);
  if (!record || record.moduleId !== moduleId || record.recordType !== recordType) throw new Error(`${label.replace(/Id$/, "")} not found.`);
  return record;
}

async function create(store: SuiteStore, userId: string, input: Parameters<SuiteStore["createRecord"]>[1]) {
  const record = await store.createRecord(userId, input);
  if (!record) throw new Error("The record could not be persisted.");
  return record;
}

async function update(store: SuiteStore, userId: string, recordId: string, input: Parameters<SuiteStore["updateRecord"]>[2]) {
  const record = await store.updateRecord(userId, recordId, input);
  if (!record) throw new Error("The record could not be updated.");
  return record;
}

function interval(input: Record<string, unknown>) {
  const startsAt = dateTime(input, "startsAt");
  const endsAt = dateTime(input, "endsAt");
  if (endsAt.getTime() <= startsAt.getTime()) throw new Error("endsAt must be later than startsAt.");
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

function overlaps(left: { startsAt: string; endsAt: string }, right: { startsAt: string; endsAt: string }) {
  return new Date(left.startsAt).getTime() < new Date(right.endsAt).getTime() && new Date(right.startsAt).getTime() < new Date(left.endsAt).getTime();
}

function scheduleWindows(input: Record<string, unknown>) {
  const windows = array(input, "windows", 100).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`windows[${index}] must be an object.`);
    const source = item as Record<string, unknown>;
    const dayOfWeek = source.dayOfWeek;
    const start = source.start;
    const end = source.end;
    if (!Number.isInteger(dayOfWeek) || Number(dayOfWeek) < 0 || Number(dayOfWeek) > 6) throw new Error(`windows[${index}].dayOfWeek must be an integer from 0 to 6.`);
    if (typeof start !== "string" || typeof end !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) throw new Error(`windows[${index}] must have an increasing 24-hour start and end.`);
    return { dayOfWeek: Number(dayOfWeek), start, end };
  }).sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.start.localeCompare(right.start));
  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1];
    const current = windows[index];
    if (previous.dayOfWeek === current.dayOfWeek && current.start < previous.end) throw new Error("Availability windows cannot overlap.");
  }
  return windows;
}

async function scheduleConflict(store: SuiteStore, userId: string, hostId: string, candidate: { startsAt: string; endsAt: string }, excludedId?: string) {
  const active = (await store.listRecords(userId, { moduleId: "schedule", recordType: "booking", limit: 10_000 }))
    .filter((booking) => booking.id !== excludedId && ["requested", "confirmed"].includes(booking.state) && booking.data.hostId === hostId);
  return active.find((booking) => overlaps(candidate, { startsAt: String(booking.data.startsAt), endsAt: String(booking.data.endsAt) }));
}

function zonedMinute(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dayOfWeek: days[values.weekday], minute: Number(values.hour) * 60 + Number(values.minute) };
}

function scheduleAllows(content: Record<string, unknown>, candidate: { startsAt: string; endsAt: string }) {
  const zone = timeZone(content.timeZone);
  const windows = Array.isArray(content.windows) ? content.windows as Array<{ dayOfWeek: number; start: string; end: string }> : [];
  const start = zonedMinute(new Date(candidate.startsAt), zone);
  const end = zonedMinute(new Date(candidate.endsAt), zone);
  if (start.dayOfWeek !== end.dayOfWeek) return false;
  return windows.some((window) => {
    const [startHour, startMinute] = window.start.split(":").map(Number);
    const [endHour, endMinute] = window.end.split(":").map(Number);
    return window.dayOfWeek === start.dayOfWeek && start.minute >= startHour * 60 + startMinute && end.minute <= endHour * 60 + endMinute;
  });
}

function scheduleSlotAligned(content: Record<string, unknown>, candidate: { startsAt: string; endsAt: string }, durationMinutes: number) {
  const zone = timeZone(content.timeZone);
  const windows = Array.isArray(content.windows) ? content.windows as Array<{ dayOfWeek: number; start: string; end: string }> : [];
  const start = zonedMinute(new Date(candidate.startsAt), zone);
  const end = zonedMinute(new Date(candidate.endsAt), zone);
  if (start.dayOfWeek !== end.dayOfWeek) return false;
  return windows.some((window) => {
    const [startHour, startMinute] = window.start.split(":").map(Number);
    const [endHour, endMinute] = window.end.split(":").map(Number);
    const windowStart = startHour * 60 + startMinute;
    const windowEnd = endHour * 60 + endMinute;
    return window.dayOfWeek === start.dayOfWeek
      && start.minute >= windowStart
      && end.minute <= windowEnd
      && (start.minute - windowStart) % durationMinutes === 0;
  });
}

function normalizedBookingInvitee(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invitee must be an object.");
  const source = value as Record<string, unknown>;
  const unsupported = Object.keys(source).find((key) => !["name", "email", "timeZone", "notes", "consent"].includes(key));
  if (unsupported) throw new Error(`invitee.${unsupported} is not supported.`);
  const name = text(source, "name", 160);
  const email = text(source, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invitee.email must be a valid email address.");
  const zone = timeZone(source.timeZone);
  const notes = source.notes === undefined ? undefined : text(source, "notes", 2_000);
  if (!source.consent || typeof source.consent !== "object" || Array.isArray(source.consent)) throw new Error("invitee.consent must be an object.");
  const consent = source.consent as Record<string, unknown>;
  if (Object.keys(consent).some((key) => !["granted", "policyVersion"].includes(key)) || consent.granted !== true) throw new Error("invitee.consent must contain explicit granted consent.");
  const policyVersion = text(consent, "policyVersion", 100);
  return { name, email, timeZone: zone, ...(notes ? { notes } : {}), consent: { granted: true, policyVersion } };
}

async function releaseScheduleContent(store: SuiteStore, userId: string, release: SuiteRecord) {
  const revision = await owned(store, userId, release.data.scheduleRevisionId, "schedule", "schedule-revision", "scheduleRevisionId");
  if (revision.state !== "published" || revision.data.contentHash !== (release.data.content as Record<string, unknown>).scheduleContentHash) throw new Error("The booking release's exact schedule revision is unavailable.");
  return revision.data.content as Record<string, unknown>;
}

async function executeSchedule(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, now: string): Promise<DeterministicSuiteActionResult> {
  if (actionId === "host-create") {
    const name = text(input, "name", 200);
    const record = await create(store, userId, { moduleId: "schedule", recordType: "host", title: name, state: "active", data: { active: true, createdAt: now } });
    return { kind: "record", action, record };
  }
  if (actionId === "host-list") {
    const records = await store.listRecords(userId, { moduleId: "schedule", recordType: "host", limit: 10_000 });
    return result(action, records, { count: records.length, privateInviteeDataIncluded: false });
  }
  if (actionId === "schedule-draft") {
    const name = text(input, "name", 200);
    const zone = timeZone(input.timeZone);
    const windows = scheduleWindows(input);
    const hostIds = [...new Set(array(input, "hostIds", 100).map((item) => String(item)))].sort();
    for (const hostId of hostIds) await owned(store, userId, hostId, "schedule", "host", "hostId");
    const content = { timeZone: zone, windows, hostIds };
    const contentHash = digest(content);
    const schedule = await create(store, userId, { moduleId: "schedule", recordType: "schedule", title: name, state: "draft", data: { timeZone: zone, currentDraftHash: contentHash, createdAt: now } });
    const revision = await create(store, userId, { moduleId: "schedule", recordType: "schedule-revision", title: `${name} v1`, state: "draft", data: { scheduleId: schedule.id, version: 1, content, contentHash, immutableAfterPublication: true, createdAt: now } });
    await update(store, userId, schedule.id, { data: { currentDraftRevisionId: revision.id } });
    return result(action, [revision, schedule], { scheduleId: schedule.id, revisionId: revision.id, version: 1, contentHash, valid: true });
  }
  if (actionId === "schedule-publish") {
    const revision = await owned(store, userId, input.revisionId, "schedule", "schedule-revision", "revisionId");
    const contentHash = sha256(input);
    if (revision.data.contentHash !== contentHash || digest(revision.data.content) !== contentHash) throw new Error("The schedule publication hash does not match the immutable revision content.");
    if (revision.state === "published") return result(action, [revision], { revisionId: revision.id, contentHash, replayed: true });
    if (revision.state !== "draft") throw new Error("Only a draft schedule revision can be published.");
    const published = await update(store, userId, revision.id, { state: "published", data: { publishedAt: now, publishedContentHash: contentHash } });
    return result(action, [published], { revisionId: published.id, contentHash, publishedAt: now, replayed: false });
  }
  if (actionId === "event-draft") {
    const name = text(input, "name", 200);
    const slug = stableKey(input.slug, "slug");
    const revision = await owned(store, userId, input.scheduleRevisionId, "schedule", "schedule-revision", "scheduleRevisionId");
    if (revision.state !== "published") throw new Error("An event release requires a published schedule revision.");
    const hostIds = [...new Set(array(input, "hostIds", 100).map(String))].sort();
    const scheduleHostIds = new Set(Array.isArray((revision.data.content as Record<string, unknown>)?.hostIds) ? (revision.data.content as Record<string, unknown>).hostIds as string[] : []);
    if (hostIds.some((hostId) => !scheduleHostIds.has(hostId))) throw new Error("Every event host must belong to the selected schedule revision.");
    const durationMinutes = integer(input, "durationMinutes", 5, 1_440);
    const duplicate = (await store.listRecords(userId, { moduleId: "schedule", recordType: "event-release", limit: 10_000 })).find((record) => record.data.slug === slug && ["draft", "published"].includes(record.state));
    if (duplicate) throw new Error("slug is already in use by an active event release.");
    const content = { name, slug, scheduleRevisionId: revision.id, scheduleContentHash: revision.data.contentHash, hostIds, durationMinutes };
    const contentHash = digest(content);
    const release = await create(store, userId, { moduleId: "schedule", recordType: "event-release", title: name, state: "draft", data: { content, contentHash, slug, hostIds, durationMinutes, scheduleRevisionId: revision.id, public: false, createdAt: now } });
    return result(action, [release], { releaseId: release.id, contentHash, valid: true });
  }
  if (actionId === "event-publish") {
    const release = await owned(store, userId, input.releaseId, "schedule", "event-release", "releaseId");
    const contentHash = sha256(input);
    if (release.data.contentHash !== contentHash || digest(release.data.content) !== contentHash) throw new Error("The event publication hash does not match the immutable release content.");
    const revision = await owned(store, userId, release.data.scheduleRevisionId, "schedule", "schedule-revision", "scheduleRevisionId");
    if (revision.state !== "published" || revision.data.contentHash !== (release.data.content as Record<string, unknown>).scheduleContentHash) throw new Error("The event's exact schedule revision is not available for publication.");
    if (release.state === "published") return result(action, [release], { releaseId: release.id, contentHash, replayed: true });
    if (release.state !== "draft") throw new Error("Only a draft event release can be published.");
    const published = await update(store, userId, release.id, { state: "published", data: { public: true, publishedAt: now, publishedContentHash: contentHash } });
    return result(action, [published], { releaseId: published.id, contentHash, publishedAt: now, replayed: false });
  }
  if (actionId === "availability-preview") {
    const release = await owned(store, userId, input.releaseId, "schedule", "event-release", "releaseId");
    if (release.state !== "published") throw new Error("Availability requires a published event release.");
    timeZone(input.timeZone);
    const from = dateTime(input, "from");
    const to = dateTime(input, "to");
    if (to <= from || to.getTime() - from.getTime() > 31 * 86_400_000) throw new Error("Availability range must be increasing and no longer than 31 days.");
    const durationMs = Number(release.data.durationMinutes) * 60_000;
    const scheduleContent = await releaseScheduleContent(store, userId, release);
    const activeBookings = (await store.listRecords(userId, { moduleId: "schedule", recordType: "booking", limit: 10_000 }))
      .filter((booking) => ["requested", "confirmed"].includes(booking.state));
    const slots: Array<Record<string, unknown>> = [];
    for (const hostId of release.data.hostIds as string[]) {
      for (let cursor = Math.ceil(from.getTime() / 60_000) * 60_000; cursor + durationMs <= to.getTime() && slots.length < 500;) {
        const candidate = { startsAt: new Date(cursor).toISOString(), endsAt: new Date(cursor + durationMs).toISOString() };
        if (!scheduleSlotAligned(scheduleContent, candidate, Number(release.data.durationMinutes))) {
          cursor += 60_000;
          continue;
        }
        const conflict = activeBookings.find((booking) => booking.data.hostId === hostId && overlaps(candidate, { startsAt: String(booking.data.startsAt), endsAt: String(booking.data.endsAt) }));
        if (!conflict) slots.push({ hostId, ...candidate });
        cursor += durationMs;
      }
    }
    const snapshotHash = digest({ releaseId: release.id, releaseHash: release.data.contentHash, from: from.toISOString(), to: to.toISOString(), timeZone: input.timeZone, slots });
    return result(action, [], { releaseId: release.id, slots, snapshotHash, expiresAt: new Date(new Date(now).getTime() + 60_000).toISOString(), reservationHeld: false });
  }
  if (actionId === "routing-preview") {
    const release = await owned(store, userId, input.releaseId, "schedule", "event-release", "releaseId");
    if (release.state !== "published") throw new Error("Routing requires a published event release.");
    const answers = object(input, "routingAnswers");
    const protectedKeys = Object.keys(answers).filter((key) => /race|religion|disability|gender|ethnicity|health|pregnan/i.test(key));
    if (protectedKeys.length) throw new Error("Protected or sensitive traits cannot be routing inputs.");
    const candidates = [...release.data.hostIds as string[]].sort();
    const selectedHostId = candidates[Number.parseInt(digest({ releaseId: release.id, answers }).slice(0, 8), 16) % candidates.length];
    return result(action, [], { releaseId: release.id, candidates, selectedHostId, strategy: "content-addressed-stable", answerHash: digest(answers) });
  }
  if (actionId === "booking-create") {
    const release = await owned(store, userId, input.releaseId, "schedule", "event-release", "releaseId");
    if (release.state !== "published") throw new Error("Booking requires a published event release.");
    const hostId = String(input.hostId ?? "");
    if (!Array.isArray(release.data.hostIds) || !release.data.hostIds.includes(hostId)) throw new Error("The host is not eligible for this event release.");
    const requested = interval(input);
    if ((new Date(requested.endsAt).getTime() - new Date(requested.startsAt).getTime()) / 60_000 !== release.data.durationMinutes) throw new Error("The requested interval does not match the published event duration.");
    const scheduleContent = await releaseScheduleContent(store, userId, release);
    if (!scheduleAllows(scheduleContent, requested) || !scheduleSlotAligned(scheduleContent, requested, Number(release.data.durationMinutes))) throw new Error("The requested interval is outside the exact published host availability or slot grid.");
    const key = idempotencyKey(input);
    const invitee = normalizedBookingInvitee(input.invitee);
    const inviteeDigest = invitee ? digest(invitee) : undefined;
    return locked(`schedule-book:${release.workspaceId}:${hostId}`, async () => {
      const bookings = await store.listRecords(userId, { moduleId: "schedule", recordType: "booking", limit: 10_000 });
      const replay = bookings.find((booking) => booking.data.idempotencyKey === key);
      if (replay) {
        if (replay.data.releaseId !== release.id || replay.data.hostId !== hostId || replay.data.startsAt !== requested.startsAt || replay.data.endsAt !== requested.endsAt || replay.data.inviteeDigest !== inviteeDigest) throw new Error("The booking idempotency key was already used for a different reservation.");
        return result(action, [replay], { bookingId: replay.id, version: replay.data.version, replayed: true });
      }
      const conflict = await scheduleConflict(store, userId, hostId, requested);
      if (conflict) throw new Error(`The requested host interval conflicts with active booking ${conflict.id}.`);
      const booking = await create(store, userId, { moduleId: "schedule", recordType: "booking", title: `Booking · ${release.title}`, state: "confirmed", data: { releaseId: release.id, releaseContentHash: release.data.contentHash, scheduleRevisionId: release.data.scheduleRevisionId, hostId, ...requested, idempotencyKey: key, invitee, inviteeDigest, version: 1, providerStatus: "not-configured", createdAt: now } });
      const event = await create(store, userId, { moduleId: "schedule", recordType: "booking-event", title: `Created · ${booking.id}`, state: "recorded", data: { bookingId: booking.id, eventType: "created", version: 1, occurredAt: now, appendOnly: true } });
      return result(action, [booking, event], { bookingId: booking.id, eventId: event.id, version: 1, replayed: false, providerAccepted: false });
    });
  }
  if (actionId === "booking-get") {
    const booking = await owned(store, userId, input.bookingId, "schedule", "booking", "bookingId");
    return result(action, [booking], { bookingId: booking.id, version: booking.data.version, releaseId: booking.data.releaseId });
  }
  if (actionId === "booking-reschedule-preview" || actionId === "unavailability-explain") {
    const booking = actionId === "booking-reschedule-preview" ? await owned(store, userId, input.bookingId, "schedule", "booking", "bookingId") : undefined;
    if (actionId === "unavailability-explain") await owned(store, userId, input.releaseId, "schedule", "event-release", "releaseId");
    const hostId = booking ? String(booking.data.hostId) : String(input.hostId ?? "");
    if (!hostId) throw new Error("hostId must identify an eligible host.");
    const requested = interval(input);
    const conflict = await scheduleConflict(store, userId, hostId, requested, booking?.id);
    const audit = { eligible: !conflict, hostId, ...requested, conflictBookingId: conflict?.id, evidenceIds: conflict ? [conflict.id] : [], privacySafe: true, mutationApplied: false };
    return result(action, booking ? [booking] : [], audit);
  }
  if (actionId === "booking-reschedule") {
    const booking = await owned(store, userId, input.bookingId, "schedule", "booking", "bookingId");
    const expectedVersion = integer(input, "expectedVersion", 1);
    const requested = interval(input);
    const key = idempotencyKey(input);
    return locked(`schedule-book:${booking.workspaceId}:${booking.data.hostId}`, async () => {
      const current = await owned(store, userId, booking.id, "schedule", "booking", "bookingId");
      const existingSuccessor = (await store.listRecords(userId, { moduleId: "schedule", recordType: "booking", limit: 10_000 })).find((candidate) => candidate.data.rescheduleIdempotencyKey === key);
      if (existingSuccessor) {
        if (existingSuccessor.data.predecessorId !== current.id || existingSuccessor.data.startsAt !== requested.startsAt || existingSuccessor.data.endsAt !== requested.endsAt) throw new Error("The reschedule idempotency key was already used for a different replacement.");
        return result(action, [current, existingSuccessor], { predecessorId: current.id, successorId: existingSuccessor.id, replayed: true });
      }
      if (current.state !== "confirmed" || current.data.version !== expectedVersion) throw new Error("The booking version is stale or no longer active.");
      const release = await owned(store, userId, current.data.releaseId, "schedule", "event-release", "releaseId");
      if (!scheduleAllows(await releaseScheduleContent(store, userId, release), requested)) throw new Error("The replacement interval is outside the exact published host availability.");
      if (await scheduleConflict(store, userId, String(current.data.hostId), requested, current.id)) throw new Error("The replacement interval conflicts with an active booking.");
      const successor = await create(store, userId, { moduleId: "schedule", recordType: "booking", title: current.title, state: "confirmed", data: { ...current.data, ...requested, idempotencyKey: undefined, rescheduleIdempotencyKey: key, predecessorId: current.id, version: 1, createdAt: now } });
      const predecessor = await update(store, userId, current.id, { state: "rescheduled", data: { successorId: successor.id, version: expectedVersion + 1, rescheduledAt: now } });
      const event = await create(store, userId, { moduleId: "schedule", recordType: "booking-event", title: `Rescheduled · ${current.id}`, state: "recorded", data: { bookingId: current.id, successorId: successor.id, eventType: "rescheduled", occurredAt: now, appendOnly: true } });
      return result(action, [predecessor, successor, event], { predecessorId: predecessor.id, successorId: successor.id, eventId: event.id, replayed: false });
    });
  }
  if (actionId === "booking-cancel") {
    const booking = await owned(store, userId, input.bookingId, "schedule", "booking", "bookingId");
    const reason = text(input, "reason", 500);
    return locked(`schedule-book:${booking.workspaceId}:${booking.data.hostId}`, async () => {
      const current = await owned(store, userId, booking.id, "schedule", "booking", "bookingId");
      if (current.state === "canceled") {
        const event = (await store.listRecords(userId, { moduleId: "schedule", recordType: "booking-event", limit: 10_000 })).find((candidate) => candidate.data.bookingId === current.id && candidate.data.eventType === "canceled");
        return result(action, event ? [current, event] : [current], { bookingId: current.id, eventId: event?.id, replayed: true });
      }
      const expectedVersion = integer(input, "expectedVersion", 1);
      if (current.state !== "confirmed" || current.data.version !== expectedVersion) throw new Error("The booking version is stale or no longer active.");
      const canceled = await update(store, userId, current.id, { state: "canceled", data: { version: expectedVersion + 1, canceledAt: now, cancellationReason: reason } });
      const event = await create(store, userId, { moduleId: "schedule", recordType: "booking-event", title: `Canceled · ${current.id}`, state: "recorded", data: { bookingId: current.id, eventType: "canceled", reason, occurredAt: now, appendOnly: true } });
      return result(action, [canceled, event], { bookingId: canceled.id, eventId: event.id, capacityReleased: true, replayed: false });
    });
  }
  if (actionId === "connector-health") {
    const connectors = await store.listRecords(userId, { moduleId: "schedule", recordType: "connector", limit: 1_000 });
    return result(action, connectors, { connectors: connectors.map((item) => ({ id: item.id, state: item.state, lastVerifiedAt: item.data.lastVerifiedAt ?? null })), providerSuccessInferred: false });
  }
  if (actionId === "booking-export") {
    const from = dateTime(input, "from");
    const to = dateTime(input, "to");
    if (to <= from || to.getTime() - from.getTime() > 366 * 86_400_000) throw new Error("Export range must be increasing and no longer than 366 days.");
    const format = text(input, "format", 20);
    if (!['json', 'ical'].includes(format)) throw new Error("format must be json or ical.");
    const bookings = (await store.listRecords(userId, { moduleId: "schedule", recordType: "booking", limit: 10_000 })).filter((booking) => new Date(String(booking.data.startsAt)) >= from && new Date(String(booking.data.startsAt)) < to);
    const projection = bookings.map((booking) => ({ id: booking.id, state: booking.state, startsAt: booking.data.startsAt, endsAt: booking.data.endsAt, releaseId: booking.data.releaseId, hostId: booking.data.hostId }));
    const payload = format === "ical" ? ["BEGIN:VCALENDAR", "VERSION:2.0", ...projection.flatMap((item) => ["BEGIN:VEVENT", `UID:${item.id}`, `DTSTART:${String(item.startsAt).replace(/[-:]/g, "").replace(".000", "")}`, `DTEND:${String(item.endsAt).replace(/[-:]/g, "").replace(".000", "")}`, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n") : canonicalJson(projection);
    return result(action, bookings, { format, count: bookings.length, contentHash: digest(payload), payload });
  }
  throw new Error("Scheduling action is not implemented.");
}

type FormField = { key: string; type: string; required: boolean; purpose: string; privacy: string; choices?: unknown[] };

function validateFormSchema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The form schema must be an object.");
  const schema = value as Record<string, unknown>;
  const supportedRoot = new Set(["fields", "version"]);
  const unsupported = Object.keys(schema).filter((key) => !supportedRoot.has(key));
  if (unsupported.length) throw new Error(`Unsupported form schema keyword: ${unsupported[0]}.`);
  if (!Array.isArray(schema.fields) || !schema.fields.length || schema.fields.length > 200) throw new Error("The form schema must declare between 1 and 200 fields.");
  const supportedTypes = new Set(["short-text", "long-text", "boolean", "integer", "decimal", "date", "date-time", "choice", "multi-choice", "email", "url"]);
  const allowedFieldKeys = new Set(["key", "type", "required", "purpose", "privacy", "choices"]);
  const fields: FormField[] = schema.fields.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`schema.fields[${index}] must be an object.`);
    const source = item as Record<string, unknown>;
    const unknown = Object.keys(source).find((key) => !allowedFieldKeys.has(key));
    if (unknown) throw new Error(`Unsupported field schema keyword: ${unknown}.`);
    const key = stableKey(source.key, `schema.fields[${index}].key`);
    if (typeof source.type !== "string" || !supportedTypes.has(source.type)) throw new Error(`schema.fields[${index}].type is not supported.`);
    if (source.required !== undefined && typeof source.required !== "boolean") throw new Error(`schema.fields[${index}].required must be boolean.`);
    if (typeof source.purpose !== "string" || !source.purpose.trim()) throw new Error(`schema.fields[${index}].purpose is required.`);
    if (/password|secret|payment card|credit card|biometric|health record|government id/i.test(source.purpose)) throw new Error("Sensitive credential, payment, biometric, health-record, and government-ID purposes cannot be published.");
    if (typeof source.privacy !== "string" || !["public", "internal", "restricted"].includes(source.privacy)) throw new Error(`schema.fields[${index}].privacy must be public, internal, or restricted.`);
    if (["choice", "multi-choice"].includes(source.type) && (!Array.isArray(source.choices) || !source.choices.length || source.choices.length > 100 || source.choices.some((choice) => typeof choice !== "string"))) throw new Error(`schema.fields[${index}].choices must be a bounded string array.`);
    return { key, type: source.type, required: source.required === true, purpose: source.purpose.trim(), privacy: source.privacy, ...(source.choices ? { choices: [...new Set(source.choices as unknown[])] } : {}) };
  });
  if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error("Form field keys must be unique and cannot be recycled within a release.");
  return { version: 1, fields };
}

type FormLogicRule = { when: { field: string; equals: unknown }; effect: "show" | "hide" | "require"; target: string };

function validateFormLogic(value: unknown, fields: FormField[]) {
  if (!Array.isArray(value) || value.length > 200) throw new Error("logic must be an array with at most 200 rules.");
  const keys = new Set(fields.map((field) => field.key));
  const logic: FormLogicRule[] = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`logic[${index}] must be an object.`);
    const source = item as Record<string, unknown>;
    if (Object.keys(source).some((key) => ["code", "script", "javascript", "url"].includes(key.toLowerCase()))) throw new Error("Form logic cannot execute code or perform network requests.");
    if (!source.when || typeof source.when !== "object" || Array.isArray(source.when)) throw new Error(`logic[${index}].when must be an object.`);
    const when = source.when as Record<string, unknown>;
    if (typeof when.field !== "string" || !keys.has(when.field) || typeof source.target !== "string" || !keys.has(source.target)) throw new Error(`logic[${index}] contains a dangling field reference.`);
    if (typeof source.effect !== "string" || !["show", "hide", "require"].includes(source.effect)) throw new Error(`logic[${index}].effect is not supported.`);
    return { when: { field: when.field, equals: when.equals }, effect: source.effect as FormLogicRule["effect"], target: source.target };
  });
  const edges = new Map<string, string[]>();
  for (const rule of logic) edges.set(rule.when.field, [...(edges.get(rule.when.field) ?? []), rule.target]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("Form logic must be acyclic.");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const target of edges.get(key) ?? []) visit(target);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of edges.keys()) visit(key);
  return logic;
}

function answerMatchesType(field: FormField, value: unknown) {
  if (["short-text", "long-text", "date", "date-time", "email", "url", "choice"].includes(field.type)) return typeof value === "string";
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (field.type === "decimal") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "multi-choice") return Array.isArray(value) && value.every((item) => typeof item === "string");
  return false;
}

function validateAnswers(release: SuiteRecord, rawAnswers: unknown) {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) throw new Error("answers must be an object.");
  const content = release.data.content as { schema?: { fields?: FormField[] }; logic?: FormLogicRule[] };
  const fields = content.schema?.fields;
  const logic = content.logic;
  if (!Array.isArray(fields) || !Array.isArray(logic)) throw new Error("The exact form release has no valid schema and logic snapshot.");
  const answers = rawAnswers as Record<string, unknown>;
  const known = new Map(fields.map((field) => [field.key, field]));
  const unknown = Object.keys(answers).find((key) => !known.has(key));
  if (unknown) throw new Error(`Answer key ${unknown} is not declared by this exact release.`);
  const hidden = new Set<string>();
  const required = new Set(fields.filter((field) => field.required).map((field) => field.key));
  for (const rule of logic) {
    const matches = canonicalJson(answers[rule.when.field]) === canonicalJson(rule.when.equals);
    if (matches && rule.effect === "hide") hidden.add(rule.target);
    if (matches && rule.effect === "show") hidden.delete(rule.target);
    if (matches && rule.effect === "require") required.add(rule.target);
  }
  for (const key of hidden) {
    required.delete(key);
    if (answers[key] !== undefined) throw new Error(`Answer ${key} is hidden by the exact release logic and cannot be accepted.`);
  }
  for (const key of required) if (answers[key] === undefined || answers[key] === null || answers[key] === "") throw new Error(`Required answer ${key} is missing.`);
  for (const [key, value] of Object.entries(answers)) {
    const field = known.get(key)!;
    if (!answerMatchesType(field, value)) throw new Error(`Answer ${key} does not match the exact release type ${field.type}.`);
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) throw new Error(`Answer ${key} must be a valid email.`);
    if (field.type === "url") { try { const url = new URL(String(value)); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); } catch { throw new Error(`Answer ${key} must be a valid HTTP or HTTPS URL.`); } }
    if (field.choices && (field.type === "choice" ? !field.choices.includes(value) : (value as unknown[]).some((item) => !field.choices!.includes(item)))) throw new Error(`Answer ${key} contains a value outside the exact release choices.`);
  }
  return canonicalValue(answers) as Record<string, unknown>;
}

async function exactFormRelease(store: SuiteStore, userId: string, releaseId: unknown, published = false) {
  const release = await owned(store, userId, releaseId, "forms", "form-release", "releaseId");
  if (published && release.state !== "published") throw new Error("Submissions require an exact published form release.");
  return release;
}

async function executeForms(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, now: string): Promise<DeterministicSuiteActionResult> {
  if (actionId === "form-create") {
    const name = text(input, "name", 200);
    const record = await create(store, userId, { moduleId: "forms", recordType: "form", title: name, state: "draft", data: { createdAt: now } });
    return { kind: "record", action, record };
  }
  if (actionId === "form-list") {
    const records = await store.listRecords(userId, { moduleId: "forms", recordType: "form", limit: 10_000 });
    return result(action, records, { count: records.length, respondentValuesIncluded: false });
  }
  if (actionId === "form-draft") {
    const form = await owned(store, userId, input.formId, "forms", "form", "formId");
    const title = text(input, "title", 200);
    const rawSchema = object(input, "schema");
    const rawLogic = array(input, "logic", 200, true);
    const versions = (await store.listRecords(userId, { moduleId: "forms", recordType: "form-release", limit: 10_000 })).filter((record) => record.data.formId === form.id);
    const version = Math.max(0, ...versions.map((record) => Number(record.data.version) || 0)) + 1;
    const content = { schema: canonicalValue(rawSchema), logic: canonicalValue(rawLogic), title };
    const contentHash = digest(content);
    const release = await create(store, userId, { moduleId: "forms", recordType: "form-release", title: `${title} v${version}`, state: "draft", data: { formId: form.id, version, content, contentHash, public: false, createdAt: now } });
    return result(action, [release], { releaseId: release.id, version, contentHash, validationPending: true });
  }
  if (actionId === "schema-validate" || actionId === "logic-validate") {
    const release = await exactFormRelease(store, userId, input.releaseId);
    const content = release.data.content as Record<string, unknown>;
    const schema = validateFormSchema(content.schema);
    const logic = validateFormLogic(content.logic, schema.fields);
    return result(action, [release], { releaseId: release.id, schemaValid: true, logicValid: true, fieldCount: schema.fields.length, ruleCount: logic.length, contentHash: release.data.contentHash, mutationApplied: false });
  }
  if (actionId === "release-diff") {
    const release = await exactFormRelease(store, userId, input.releaseId);
    const prior = (await store.listRecords(userId, { moduleId: "forms", recordType: "form-release", limit: 10_000 })).filter((record) => record.data.formId === release.data.formId && record.state === "published" && Number(record.data.version) < Number(release.data.version)).sort((a, b) => Number(b.data.version) - Number(a.data.version))[0];
    const currentFields = validateFormSchema((release.data.content as Record<string, unknown>).schema).fields;
    const priorFields = prior ? validateFormSchema((prior.data.content as Record<string, unknown>).schema).fields : [];
    const priorByKey = new Map(priorFields.map((field) => [field.key, field]));
    const currentByKey = new Map(currentFields.map((field) => [field.key, field]));
    const added = currentFields.filter((field) => !priorByKey.has(field.key)).map((field) => field.key);
    const removed = priorFields.filter((field) => !currentByKey.has(field.key)).map((field) => field.key);
    const changed = currentFields.filter((field) => priorByKey.has(field.key) && canonicalJson(field) !== canonicalJson(priorByKey.get(field.key))).map((field) => field.key);
    return result(action, prior ? [release, prior] : [release], { releaseId: release.id, priorReleaseId: prior?.id ?? null, added, removed, changed, mutationApplied: false });
  }
  if (actionId === "release-publish") {
    const release = await exactFormRelease(store, userId, input.releaseId);
    const hash = sha256(input);
    const key = idempotencyKey(input);
    return locked(`forms-release:${release.workspaceId}:${release.data.formId}`, async () => {
      const replays = await store.listRecords(userId, { moduleId: "forms", recordType: "form-release", limit: 10_000 });
      const replay = replays.find((record) => record.data.publishIdempotencyKey === key);
      if (replay) {
        if (replay.id !== release.id || replay.data.contentHash !== hash) throw new Error("The release publication key was already used for different content.");
        return result(action, [replay], { releaseId: replay.id, contentHash: hash, replayed: true });
      }
      if (release.data.contentHash !== hash || digest(release.data.content) !== hash) throw new Error("The release publication hash does not match the immutable schema and logic content.");
      const content = release.data.content as Record<string, unknown>;
      const schema = validateFormSchema(content.schema);
      validateFormLogic(content.logic, schema.fields);
      if (release.state !== "draft") throw new Error("Only a draft form release can be published.");
      const published = await update(store, userId, release.id, { state: "published", data: { public: true, publishIdempotencyKey: key, publishedContentHash: hash, publishedAt: now, validatedFieldCount: schema.fields.length } });
      return result(action, [published], { releaseId: published.id, version: published.data.version, contentHash: hash, publishedAt: now, replayed: false });
    });
  }
  if (actionId === "submission-validate") {
    const release = await exactFormRelease(store, userId, input.releaseId, true);
    const answers = validateAnswers(release, input.responseValues);
    return result(action, [], { valid: true, releaseId: release.id, releaseContentHash: release.data.contentHash, answerHash: digest(answers), canonicalAnswers: answers, persisted: false });
  }
  if (actionId === "submission-create") {
    const release = await exactFormRelease(store, userId, input.releaseId, true);
    const answers = validateAnswers(release, input.responseValues);
    const key = idempotencyKey(input);
    const answerHash = digest(answers);
    return locked(`forms-submit:${release.workspaceId}:${release.id}`, async () => {
      const submissions = await store.listRecords(userId, { moduleId: "forms", recordType: "submission", limit: 10_000 });
      const replay = submissions.find((record) => record.data.idempotencyKey === key);
      if (replay) {
        if (replay.data.releaseId !== release.id || replay.data.answerHash !== answerHash) throw new Error("The submission idempotency key was already used for different exact-release answers.");
        return result(action, [replay], { submissionId: replay.id, version: replay.data.version, replayed: true });
      }
      const respondentDigest = typeof input.respondentKey === "string" && input.respondentKey ? digest(`${release.workspaceId}:${input.respondentKey}`) : undefined;
      const submission = await create(store, userId, { moduleId: "forms", recordType: "submission", title: `Submission · ${release.title}`, state: "submitted", data: { formId: release.data.formId, releaseId: release.id, releaseVersion: release.data.version, releaseContentHash: release.data.contentHash, initialAnswers: answers, currentAnswers: answers, answerHash, idempotencyKey: key, respondentDigest, version: 1, submittedAt: now } });
      const version = await create(store, userId, { moduleId: "forms", recordType: "submission-version", title: `Original · ${submission.id}`, state: "immutable", data: { submissionId: submission.id, version: 1, answers, answerHash, source: "respondent", createdAt: now, immutable: true } });
      return result(action, [submission, version], { submissionId: submission.id, versionId: version.id, version: 1, releaseId: release.id, replayed: false });
    });
  }
  if (actionId === "submission-get") {
    const submission = await owned(store, userId, input.submissionId, "forms", "submission", "submissionId");
    const versions = (await store.listRecords(userId, { moduleId: "forms", recordType: "submission-version", limit: 1_000 })).filter((record) => record.data.submissionId === submission.id).sort((a, b) => Number(a.data.version) - Number(b.data.version));
    return result(action, [submission, ...versions], { submissionId: submission.id, version: submission.data.version, releaseId: submission.data.releaseId, versionCount: versions.length });
  }
  if (actionId === "submission-correct") {
    const submission = await owned(store, userId, input.submissionId, "forms", "submission", "submissionId");
    const expectedVersion = integer(input, "expectedVersion", 1);
    const reason = text(input, "reason", 2_000);
    return locked(`forms-submission:${submission.id}`, async () => {
      const current = await owned(store, userId, submission.id, "forms", "submission", "submissionId");
      if (current.data.version !== expectedVersion) throw new Error("The submission correction version is stale.");
      const release = await exactFormRelease(store, userId, current.data.releaseId, true);
      if (release.data.contentHash !== current.data.releaseContentHash) throw new Error("The submission's exact release hash is unavailable.");
      const answers = validateAnswers(release, input.responseValues);
      const versionNumber = expectedVersion + 1;
      const answerHash = digest(answers);
      const version = await create(store, userId, { moduleId: "forms", recordType: "submission-version", title: `Correction ${versionNumber} · ${current.id}`, state: "immutable", data: { submissionId: current.id, version: versionNumber, answers, answerHash, source: "authorized-correction", reason, previousVersion: expectedVersion, releaseId: release.id, releaseContentHash: release.data.contentHash, createdAt: now, immutable: true } });
      const corrected = await update(store, userId, current.id, { data: { currentAnswers: answers, answerHash, version: versionNumber, latestVersionId: version.id, correctedAt: now } });
      return result(action, [corrected, version], { submissionId: corrected.id, versionId: version.id, previousVersion: expectedVersion, version: versionNumber, releaseId: release.id, originalPreserved: true });
    });
  }
  if (actionId === "results-query" || actionId === "results-summarize") {
    const form = await owned(store, userId, input.formId, "forms", "form", "formId");
    const submissions = (await store.listRecords(userId, { moduleId: "forms", recordType: "submission", limit: 10_000 })).filter((record) => record.data.formId === form.id && record.state === "submitted");
    const byRelease = Object.fromEntries([...new Set(submissions.map((item) => String(item.data.releaseId)))].sort().map((releaseId) => [releaseId, submissions.filter((item) => item.data.releaseId === releaseId).length]));
    const audit = { formId: form.id, denominator: submissions.length, byRelease, queryClock: now, submissionIds: submissions.map((item) => item.id).sort(), restrictedValuesIncluded: false, summary: `${submissions.length} submitted response${submissions.length === 1 ? "" : "s"} across ${Object.keys(byRelease).length} exact release${Object.keys(byRelease).length === 1 ? "" : "s"}.` };
    return result(action, [form], audit);
  }
  if (actionId === "export-preview") {
    const form = await owned(store, userId, input.formId, "forms", "form", "formId");
    const fields = [...new Set(array(input, "fields", 200, true).map(String))].sort();
    const format = text(input, "format", 20);
    if (!['json', 'csv'].includes(format)) throw new Error("format must be json or csv.");
    const rowCount = (await store.listRecords(userId, { moduleId: "forms", recordType: "submission", limit: 10_000 })).filter((record) => record.data.formId === form.id && record.state === "submitted").length;
    const plan = { formId: form.id, fields, format, rowCount, formulaProtection: format === "csv", restrictedFieldsExcluded: true };
    const contentHash = digest(plan);
    const exportRecord = await create(store, userId, { moduleId: "forms", recordType: "export", title: `Export preview · ${form.title}`, state: "previewed", data: { ...plan, contentHash, createdAt: now, artifactCreated: false } });
    return result(action, [exportRecord], { exportId: exportRecord.id, contentHash, ...plan });
  }
  if (actionId === "export-create") {
    const exportRecord = await owned(store, userId, input.exportId, "forms", "export", "exportId");
    const hash = sha256(input);
    const key = idempotencyKey(input);
    if (exportRecord.data.contentHash !== hash) throw new Error("The export confirmation hash does not match the reviewed projection.");
    if (exportRecord.state === "created" && exportRecord.data.idempotencyKey === key) return result(action, [exportRecord], { exportId: exportRecord.id, contentHash: hash, replayed: true });
    if (exportRecord.state !== "previewed") throw new Error("Only a reviewed export preview can be created.");
    const created = await update(store, userId, exportRecord.id, { state: "created", data: { idempotencyKey: key, artifactCreated: true, createdAt: now } });
    return result(action, [created], { exportId: created.id, contentHash: hash, replayed: false });
  }
  if (actionId === "rights-preview") {
    const respondentKey = text(input, "respondentKey", 500);
    const workspace = await store.getOrCreateWorkspace(userId);
    const respondentDigest = digest(`${workspace.id}:${respondentKey}`);
    const affected = (await store.listRecords(userId, { moduleId: "forms", recordType: "submission", limit: 10_000 })).filter((record) => record.data.respondentDigest === respondentDigest);
    return result(action, [], { respondentDigest, affectedSubmissionIds: affected.map((record) => record.id).sort(), affectedCount: affected.length, rawRespondentKeyStored: false, mutationApplied: false });
  }
  throw new Error("Forms action is not implemented.");
}

type FlagVariant = { key: string; value: unknown; weight?: number };
type FlagRule = { attribute: string; operator: "eq" | "in"; value: unknown; variant: string };
type FlagContent = { projectId: string; environmentKey: string; flagId: string; key: string; valueType: string; safeValue: unknown; variants: FlagVariant[]; rules: FlagRule[]; baseVersion: number };

function flagValueMatches(type: string, value: unknown) {
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "decimal") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string" && value.length <= 4_000;
  if (type === "json") return value !== undefined && Buffer.byteLength(canonicalJson(value), "utf8") <= 16_384;
  return false;
}

function validateFlagContent(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The flag revision content is invalid.");
  const content = value as FlagContent;
  if (!flagValueMatches(content.valueType, content.safeValue)) throw new Error("The safe value does not match the declared flag type.");
  if (!Array.isArray(content.variants) || !content.variants.length || content.variants.length > 20) throw new Error("A flag requires between 1 and 20 variants.");
  const variants = content.variants.map((variant, index) => {
    if (!variant || typeof variant !== "object") throw new Error(`variants[${index}] must be an object.`);
    const key = stableKey(variant.key, `variants[${index}].key`);
    if (!flagValueMatches(content.valueType, variant.value)) throw new Error(`Variant ${key} does not match the declared flag type.`);
    if (variant.weight !== undefined && (!Number.isSafeInteger(variant.weight) || variant.weight < 0 || variant.weight > 10_000)) throw new Error(`Variant ${key} weight must be integer allocation units.`);
    return { key, value: canonicalValue(variant.value), ...(variant.weight !== undefined ? { weight: variant.weight } : {}) };
  });
  if (new Set(variants.map((variant) => variant.key)).size !== variants.length) throw new Error("Variant keys must be unique.");
  if (variants.some((variant) => variant.weight !== undefined) && variants.reduce((sum, variant) => sum + (variant.weight ?? 0), 0) !== 10_000) throw new Error("Fractional variant weights must sum exactly to 10000 allocation units.");
  const variantKeys = new Set(variants.map((variant) => variant.key));
  if (!Array.isArray(content.rules) || content.rules.length > 100) throw new Error("rules must be an array with at most 100 entries.");
  const protectedPattern = /race|religion|ethnicity|gender|pregnan|disability|health|biometric|credit|insurance/i;
  const rules = content.rules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`rules[${index}] must be an object.`);
    if (typeof rule.attribute !== "string" || !/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(rule.attribute) || protectedPattern.test(rule.attribute)) throw new Error("Rules cannot use undeclared, protected, or sensitive attributes.");
    if (!['eq', 'in'].includes(rule.operator)) throw new Error("Rule operator must be eq or in.");
    if (rule.operator === "in" && (!Array.isArray(rule.value) || rule.value.length > 100)) throw new Error("An in rule requires a bounded value array.");
    if (!variantKeys.has(rule.variant)) throw new Error("Every rule must reference a declared variant.");
    return { attribute: rule.attribute, operator: rule.operator, value: canonicalValue(rule.value), variant: rule.variant } as FlagRule;
  });
  return { ...content, safeValue: canonicalValue(content.safeValue), variants, rules };
}

function evaluateFlag(content: FlagContent, input: { expectedType: string; defaultValue: unknown; context: Record<string, unknown>; subjectKey: string }) {
  if (input.expectedType !== content.valueType || !flagValueMatches(input.expectedType, input.defaultValue)) return { value: input.defaultValue, variant: null, reason: "type-mismatch", matchedRule: null };
  for (let index = 0; index < content.rules.length; index += 1) {
    const rule = content.rules[index];
    const observed = rule.attribute.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, input.context);
    const matches = rule.operator === "eq" ? canonicalJson(observed) === canonicalJson(rule.value) : Array.isArray(rule.value) && rule.value.some((candidate) => canonicalJson(candidate) === canonicalJson(observed));
    if (matches) {
      const variant = content.variants.find((candidate) => candidate.key === rule.variant)!;
      return { value: variant.value, variant: variant.key, reason: "target-match", matchedRule: index };
    }
  }
  if (content.variants.some((variant) => variant.weight !== undefined)) {
    const bucket = Number.parseInt(digest(`${content.projectId}:${content.environmentKey}:${content.key}:${input.subjectKey}`).slice(0, 8), 16) % 10_000;
    let cursor = 0;
    for (const variant of content.variants) {
      cursor += variant.weight ?? 0;
      if (bucket < cursor) return { value: variant.value, variant: variant.key, reason: "fractional-allocation", matchedRule: null, bucket };
    }
  }
  return { value: content.safeValue, variant: null, reason: "safe-value", matchedRule: null };
}

async function activeRevision(store: SuiteStore, userId: string, projectId: string, environmentKey: string) {
  return (await store.listRecords(userId, { moduleId: "flags", recordType: "config-revision", limit: 10_000 }))
    .filter((record) => record.data.projectId === projectId && record.data.environmentKey === environmentKey && record.state === "published")
    .sort((a, b) => Number(b.data.version) - Number(a.data.version))[0];
}

async function executeFlags(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, now: string): Promise<DeterministicSuiteActionResult> {
  if (actionId === "project-create") {
    const name = text(input, "name", 200);
    const record = await create(store, userId, { moduleId: "flags", recordType: "flag-project", title: name, state: "active", data: { createdAt: now } });
    return { kind: "record", action, record };
  }
  if (actionId === "project-list") {
    const records = await store.listRecords(userId, { moduleId: "flags", recordType: "flag-project", limit: 10_000 });
    return result(action, records, { count: records.length, credentialsIncluded: false });
  }
  if (actionId === "flag-draft") {
    const project = await owned(store, userId, input.projectId, "flags", "flag-project", "projectId");
    const environmentKey = stableKey(input.environmentKey, "environmentKey");
    const key = stableKey(input.key, "key");
    const valueType = text(input, "valueType", 20);
    if (!["boolean", "integer", "decimal", "string", "json"].includes(valueType)) throw new Error("valueType must be boolean, integer, decimal, string, or json.");
    const flags = await store.listRecords(userId, { moduleId: "flags", recordType: "flag", limit: 10_000 });
    if (flags.some((flag) => flag.data.projectId === project.id && flag.data.key === key)) throw new Error("A published semantic flag key cannot be recycled.");
    const flag = await create(store, userId, { moduleId: "flags", recordType: "flag", title: key, state: "draft", data: { projectId: project.id, key, valueType, safeValue: canonicalValue(input.safeValue), createdAt: now } });
    const current = await activeRevision(store, userId, project.id, environmentKey);
    const versions = (await store.listRecords(userId, { moduleId: "flags", recordType: "config-revision", limit: 10_000 })).filter((record) => record.data.projectId === project.id && record.data.environmentKey === environmentKey);
    const version = Math.max(0, ...versions.map((record) => Number(record.data.version) || 0)) + 1;
    const content = validateFlagContent({ projectId: project.id, environmentKey, flagId: flag.id, key, valueType, safeValue: input.safeValue, variants: array(input, "variants", 20), rules: array(input, "rules", 100, true), baseVersion: Number(current?.data.version ?? 0) });
    const contentHash = digest(content);
    const revision = await create(store, userId, { moduleId: "flags", recordType: "config-revision", title: `${key} · ${environmentKey} v${version}`, state: "draft", data: { projectId: project.id, environmentKey, flagId: flag.id, version, baseVersion: content.baseVersion, content, contentHash, createdAt: now } });
    await update(store, userId, flag.id, { data: { draftRevisionId: revision.id, contentHash } });
    return result(action, [revision, flag], { revisionId: revision.id, flagId: flag.id, version, baseVersion: content.baseVersion, contentHash });
  }
  if (actionId === "revision-validate" || actionId === "rollout-preview") {
    const revision = await owned(store, userId, input.revisionId, "flags", "config-revision", "revisionId");
    const content = validateFlagContent(revision.data.content);
    const contentHash = digest(content);
    if (contentHash !== revision.data.contentHash) throw new Error("The revision content no longer matches its canonical content hash.");
    if (actionId === "revision-validate") return result(action, [revision], { revisionId: revision.id, valid: true, contentHash, variantCount: content.variants.length, ruleCount: content.rules.length, mutationApplied: false });
    const contexts = array(input, "contexts", 100, true).map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`contexts[${index}] must be an object.`);
      const source = item as Record<string, unknown>;
      const context = source.context && typeof source.context === "object" && !Array.isArray(source.context) ? source.context as Record<string, unknown> : {};
      const subjectKey = typeof source.subjectKey === "string" && source.subjectKey ? source.subjectKey : `vector-${index}`;
      return { index, ...evaluateFlag(content, { expectedType: content.valueType, defaultValue: content.safeValue, context, subjectKey }) };
    });
    return result(action, [revision], { revisionId: revision.id, contentHash, vectors: contexts, mutationApplied: false });
  }
  if (actionId === "revision-diff") {
    const revision = await owned(store, userId, input.revisionId, "flags", "config-revision", "revisionId");
    const current = await activeRevision(store, userId, String(revision.data.projectId), String(revision.data.environmentKey));
    const currentContent = current?.data.content as FlagContent | undefined;
    const nextContent = revision.data.content as FlagContent;
    return result(action, current ? [revision, current] : [revision], { revisionId: revision.id, activeRevisionId: current?.id ?? null, flagKeyChanged: currentContent ? currentContent.key !== nextContent.key : true, typeChanged: currentContent ? currentContent.valueType !== nextContent.valueType : true, variantsChanged: currentContent ? canonicalJson(currentContent.variants) !== canonicalJson(nextContent.variants) : true, rulesChanged: currentContent ? canonicalJson(currentContent.rules) !== canonicalJson(nextContent.rules) : true, mutationApplied: false });
  }
  if (actionId === "revision-approve") {
    const revision = await owned(store, userId, input.revisionId, "flags", "config-revision", "revisionId");
    const hash = sha256(input);
    const content = validateFlagContent(revision.data.content);
    if (revision.data.contentHash !== hash || digest(content) !== hash) throw new Error("The approval hash does not match the immutable flag revision content.");
    const existing = (await store.listRecords(userId, { moduleId: "flags", recordType: "approval", limit: 10_000 })).find((record) => record.data.revisionId === revision.id && record.data.contentHash === hash && record.state === "approved");
    if (existing) return result(action, [revision, existing], { revisionId: revision.id, approvalId: existing.id, contentHash: hash, replayed: true });
    if (!["draft", "validated"].includes(revision.state)) throw new Error("Only a draft or validated exact revision can be approved.");
    const approval = await create(store, userId, { moduleId: "flags", recordType: "approval", title: `Approval · ${revision.title}`, state: "approved", data: { revisionId: revision.id, contentHash: hash, approvedAt: now, immutable: true } });
    const approved = await update(store, userId, revision.id, { state: "approved", data: { approvedContentHash: hash, approvalId: approval.id, approvedAt: now } });
    return result(action, [approved, approval], { revisionId: approved.id, approvalId: approval.id, contentHash: hash, replayed: false });
  }
  if (actionId === "revision-publish") {
    const revision = await owned(store, userId, input.revisionId, "flags", "config-revision", "revisionId");
    const hash = sha256(input);
    const baseVersion = integer(input, "baseVersion", 0);
    const key = idempotencyKey(input);
    return locked(`flags-publish:${revision.workspaceId}:${revision.data.projectId}:${revision.data.environmentKey}`, async () => {
      const replay = (await store.listRecords(userId, { moduleId: "flags", recordType: "manifest", limit: 10_000 })).find((record) => record.data.publishIdempotencyKey === key);
      if (replay) {
        if (replay.data.revisionId !== revision.id || replay.data.contentHash !== hash) throw new Error("The publication key was already used for different flag content.");
        return result(action, [replay], { manifestId: replay.id, revisionId: revision.id, contentHash: hash, replayed: true });
      }
      const current = await activeRevision(store, userId, String(revision.data.projectId), String(revision.data.environmentKey));
      if (Number(current?.data.version ?? 0) !== baseVersion || Number(revision.data.baseVersion) !== baseVersion) throw new Error("The active flag base version changed before publication.");
      const content = validateFlagContent(revision.data.content);
      const approval = (await store.listRecords(userId, { moduleId: "flags", recordType: "approval", limit: 10_000 })).find((record) => record.data.revisionId === revision.id && record.data.contentHash === hash && record.state === "approved");
      if (revision.state !== "approved" || revision.data.contentHash !== hash || revision.data.approvedContentHash !== hash || digest(content) !== hash || !approval) throw new Error("Only the exact approved flag revision hash can be published.");
      if (current) await update(store, userId, current.id, { state: "superseded", data: { supersededByRevisionId: revision.id, supersededAt: now } });
      const published = await update(store, userId, revision.id, { state: "published", data: { publishedAt: now, publishedContentHash: hash } });
      const manifestContent = { schemaVersion: 1, projectId: revision.data.projectId, environmentKey: revision.data.environmentKey, revisionId: revision.id, version: revision.data.version, flags: [{ key: content.key, type: content.valueType, safeValue: content.safeValue, variants: content.variants, rules: content.rules }] };
      const manifestHash = digest(manifestContent);
      const manifest = await create(store, userId, { moduleId: "flags", recordType: "manifest", title: `${revision.data.environmentKey} v${revision.data.version}`, state: "active", data: { projectId: revision.data.projectId, environmentKey: revision.data.environmentKey, revisionId: revision.id, version: revision.data.version, content: manifestContent, contentHash: manifestHash, revisionContentHash: hash, publishIdempotencyKey: key, audience: "server", createdAt: now } });
      const flag = await owned(store, userId, content.flagId, "flags", "flag", "flagId");
      await update(store, userId, flag.id, { state: "active", data: { activeRevisionId: revision.id, publishedAt: now } });
      return result(action, [published, manifest, approval], { manifestId: manifest.id, revisionId: published.id, version: published.data.version, contentHash: hash, manifestHash, replayed: false });
    });
  }
  if (actionId === "evaluate") {
    const project = await owned(store, userId, input.projectId, "flags", "flag-project", "projectId");
    const environmentKey = stableKey(input.environmentKey, "environmentKey");
    const flagKey = stableKey(input.flagKey, "flagKey");
    const expectedType = text(input, "expectedType", 20);
    const context = object(input, "context");
    const subjectKey = text(input, "subjectKey", 500);
    const revision = await activeRevision(store, userId, project.id, environmentKey);
    if (!revision) return result(action, [], { value: input.defaultValue, variant: null, reason: "missing-flag", revisionId: null, flagKey, persisted: false });
    const content = validateFlagContent(revision.data.content);
    if (content.key !== flagKey) return result(action, [], { value: input.defaultValue, variant: null, reason: "missing-flag", revisionId: revision.id, flagKey, persisted: false });
    const evaluated = evaluateFlag(content, { expectedType, defaultValue: input.defaultValue, context, subjectKey });
    const receiptContent = { projectId: project.id, environmentKey, revisionId: revision.id, revisionContentHash: revision.data.contentHash, flagKey, valueType: expectedType, variant: evaluated.variant, reason: evaluated.reason, matchedRule: evaluated.matchedRule, subjectDigest: digest(`${project.id}:${subjectKey}`), evaluatorVersion: "supersuite-flags-1" };
    const receiptHash = digest(receiptContent);
    const receipt = await create(store, userId, { moduleId: "flags", recordType: "evaluation-receipt", title: `${flagKey} · ${evaluated.reason}`, state: "recorded", data: { ...receiptContent, value: evaluated.value, receiptHash, evaluatedAt: now, rawContextStored: false } });
    return result(action, [receipt], { ...receiptContent, receiptId: receipt.id, value: evaluated.value, receiptHash, rawContextStored: false, persisted: true });
  }
  if (actionId === "evaluation-explain") {
    const receipt = await owned(store, userId, input.receiptId, "flags", "evaluation-receipt", "receiptId");
    return result(action, [receipt], { receiptId: receipt.id, revisionId: receipt.data.revisionId, flagKey: receipt.data.flagKey, variant: receipt.data.variant, reason: receipt.data.reason, evidenceIds: [receipt.id, receipt.data.revisionId], rawContextIncluded: false });
  }
  if (actionId === "manifest-export") {
    const project = await owned(store, userId, input.projectId, "flags", "flag-project", "projectId");
    const environmentKey = stableKey(input.environmentKey, "environmentKey");
    const audience = text(input, "audience", 20);
    if (!['client', 'server'].includes(audience)) throw new Error("audience must be client or server.");
    const manifests = (await store.listRecords(userId, { moduleId: "flags", recordType: "manifest", limit: 10_000 })).filter((record) => record.data.projectId === project.id && record.data.environmentKey === environmentKey && record.state === "active").sort((a, b) => Number(b.data.version) - Number(a.data.version));
    const manifest = manifests[0];
    if (!manifest) throw new Error("No active manifest exists for this environment.");
    return result(action, [manifest], { manifestId: manifest.id, audience, version: manifest.data.version, contentHash: manifest.data.contentHash, content: manifest.data.content, credentialsIncluded: false });
  }
  if (actionId === "experiment-draft") {
    const project = await owned(store, userId, input.projectId, "flags", "flag-project", "projectId");
    const flag = await owned(store, userId, input.flagId, "flags", "flag", "flagId");
    if (flag.data.projectId !== project.id) throw new Error("The experiment flag does not belong to the selected project.");
    const hypothesis = text(input, "hypothesis", 2_000);
    const variants = [...new Set(array(input, "variants", 20).map((item) => stableKey(item, "variant")))];
    const weights = array(input, "weights", 20).map((item, index) => {
      if (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) > 10_000) throw new Error(`weights[${index}] must be integer allocation units.`);
      return Number(item);
    });
    if (weights.length !== variants.length || weights.reduce((sum, item) => sum + item, 0) !== 10_000) throw new Error("Experiment weights must align with variants and sum exactly to 10000.");
    const minimumSample = integer(input, "minimumSample", 2, 10_000_000);
    const minimumDurationHours = integer(input, "minimumDurationHours", 1, 8_760);
    const contract = { projectId: project.id, flagId: flag.id, hypothesis, variants, weights, minimumSample, minimumDurationHours, assignmentEpoch: 1, requiredGates: ["minimum-sample", "minimum-duration", "sample-ratio", "single-variant-exposure"] };
    const contentHash = digest(contract);
    const experiment = await create(store, userId, { moduleId: "flags", recordType: "experiment", title: hypothesis.slice(0, 160), state: "draft", data: { ...contract, version: 1, contentHash, createdAt: now } });
    return result(action, [experiment], { experimentId: experiment.id, version: 1, contentHash, assignmentEpoch: 1 });
  }
  if (actionId === "experiment-start") {
    const experiment = await owned(store, userId, input.experimentId, "flags", "experiment", "experimentId");
    const expectedVersion = integer(input, "expectedVersion", 1);
    const hash = sha256(input);
    const contract = { projectId: experiment.data.projectId, flagId: experiment.data.flagId, hypothesis: experiment.data.hypothesis, variants: experiment.data.variants, weights: experiment.data.weights, minimumSample: experiment.data.minimumSample, minimumDurationHours: experiment.data.minimumDurationHours, assignmentEpoch: experiment.data.assignmentEpoch, requiredGates: experiment.data.requiredGates };
    if (experiment.state === "running" && experiment.data.contentHash === hash) return result(action, [experiment], { experimentId: experiment.id, version: experiment.data.version, contentHash: hash, replayed: true });
    if (experiment.state !== "draft" || experiment.data.version !== expectedVersion || experiment.data.contentHash !== hash || digest(contract) !== hash) throw new Error("Only the exact preregistered experiment version and content hash can start.");
    const started = await update(store, userId, experiment.id, { state: "running", data: { startedAt: now, frozenContentHash: hash } });
    return result(action, [started], { experimentId: started.id, version: expectedVersion, contentHash: hash, startedAt: now, replayed: false });
  }
  if (actionId === "exposure-record") {
    const experiment = await owned(store, userId, input.experimentId, "flags", "experiment", "experimentId");
    if (experiment.state !== "running") throw new Error("Exposure requires a running exact experiment epoch.");
    const subjectKey = text(input, "subjectKey", 500);
    const variant = stableKey(input.variant, "variant");
    if (!Array.isArray(experiment.data.variants) || !experiment.data.variants.includes(variant)) throw new Error("Exposure variant is not declared by this experiment epoch.");
    const sourceEventId = text(input, "sourceEventId", 200);
    const subjectDigest = digest(`${experiment.data.projectId}:${experiment.id}:${subjectKey}`);
    return locked(`flags-exposure:${experiment.id}:${subjectDigest}`, async () => {
      const exposures = (await store.listRecords(userId, { moduleId: "flags", recordType: "exposure", limit: 10_000 })).filter((record) => record.data.experimentId === experiment.id && record.data.assignmentEpoch === experiment.data.assignmentEpoch);
      const eventReplay = exposures.find((record) => record.data.sourceEventId === sourceEventId);
      if (eventReplay) {
        if (eventReplay.data.subjectDigest !== subjectDigest || eventReplay.data.variant !== variant) throw new Error("The source exposure event was already used for different immutable exposure content.");
        return result(action, [eventReplay], { exposureId: eventReplay.id, replayed: true, dataQualityState: eventReplay.data.dataQualityState });
      }
      const prior = exposures.find((record) => record.data.subjectDigest === subjectDigest);
      if (prior && prior.data.variant === variant) return result(action, [prior], { exposureId: prior.id, replayed: true, deduplicatedFirstExposure: true, dataQualityState: prior.data.dataQualityState });
      const dataQualityState = prior ? "multiple-variant" : "valid";
      const exposure = await create(store, userId, { moduleId: "flags", recordType: "exposure", title: `${experiment.id} · ${variant}`, state: "recorded", data: { experimentId: experiment.id, assignmentEpoch: experiment.data.assignmentEpoch, subjectDigest, variant, sourceEventId, dataQualityState, firstExposedAt: now, rawSubjectStored: false } });
      if (prior) await update(store, userId, prior.id, { data: { dataQualityState: "multiple-variant", conflictingExposureId: exposure.id } });
      return result(action, prior ? [exposure, prior] : [exposure], { exposureId: exposure.id, replayed: false, deduplicatedFirstExposure: false, dataQualityState, conflictingExposureId: prior?.id ?? null });
    });
  }
  if (actionId === "experiment-analyze") {
    const experiment = await owned(store, userId, input.experimentId, "flags", "experiment", "experimentId");
    if (!['running', 'stopped', 'analyzing'].includes(experiment.state)) throw new Error("Only a started experiment can be analyzed.");
    const exposures = (await store.listRecords(userId, { moduleId: "flags", recordType: "exposure", limit: 10_000 })).filter((record) => record.data.experimentId === experiment.id && record.data.assignmentEpoch === experiment.data.assignmentEpoch);
    const counts = Object.fromEntries((experiment.data.variants as string[]).map((variant) => [variant, exposures.filter((record) => record.data.variant === variant).length]));
    const sample = exposures.length;
    const expected = (experiment.data.weights as number[]).map((weight) => sample * weight / 10_000);
    const sampleRatioOk = sample === 0 || (experiment.data.variants as string[]).every((variant, index) => Math.abs(Number(counts[variant]) - expected[index]) <= Math.max(2, expected[index] * 0.25));
    const durationHours = experiment.data.startedAt ? Math.max(0, (new Date(now).getTime() - new Date(String(experiment.data.startedAt)).getTime()) / 3_600_000) : 0;
    const gates = { minimumSample: sample >= Number(experiment.data.minimumSample), minimumDuration: durationHours >= Number(experiment.data.minimumDurationHours), sampleRatio: sampleRatioOk, singleVariantExposure: !exposures.some((record) => record.data.dataQualityState === "multiple-variant") };
    const allPassed = Object.values(gates).every(Boolean);
    const status = gates.singleVariantExposure && gates.sampleRatio ? (allPassed ? "descriptive-only" : "insufficient") : "invalidated";
    const frozen = { experimentId: experiment.id, assignmentEpoch: experiment.data.assignmentEpoch, exposureIds: exposures.map((record) => record.id).sort(), counts, sample, gates, status, engineVersion: "supersuite-flags-analysis-1" };
    return result(action, [experiment], { ...frozen, durationHours, winner: null, causalClaim: false, reproducibilityHash: digest(frozen), warnings: Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => gate), persisted: false });
  }
  if (actionId === "revision-rollback") {
    const target = await owned(store, userId, input.revisionId, "flags", "config-revision", "revisionId");
    const hash = sha256(input);
    const baseVersion = integer(input, "baseVersion", 0);
    const key = idempotencyKey(input);
    if (!['published', 'superseded'].includes(target.state) || target.data.contentHash !== hash || digest(validateFlagContent(target.data.content)) !== hash) throw new Error("Rollback requires an exact previously published revision hash.");
    return locked(`flags-publish:${target.workspaceId}:${target.data.projectId}:${target.data.environmentKey}`, async () => {
      const replay = (await store.listRecords(userId, { moduleId: "flags", recordType: "rollback-event", limit: 10_000 })).find((record) => record.data.idempotencyKey === key);
      if (replay) return result(action, [replay], { rollbackEventId: replay.id, targetRevisionId: target.id, replayed: true });
      const current = await activeRevision(store, userId, String(target.data.projectId), String(target.data.environmentKey));
      if (!current || Number(current.data.version) !== baseVersion) throw new Error("The active flag base version changed before rollback.");
      const versions = (await store.listRecords(userId, { moduleId: "flags", recordType: "config-revision", limit: 10_000 })).filter((record) => record.data.projectId === target.data.projectId && record.data.environmentKey === target.data.environmentKey);
      const version = Math.max(...versions.map((record) => Number(record.data.version) || 0)) + 1;
      const rollbackContent = { ...(target.data.content as FlagContent), baseVersion };
      const rollbackHash = digest(rollbackContent);
      await update(store, userId, current.id, { state: "superseded", data: { supersededAt: now } });
      const revision = await create(store, userId, { moduleId: "flags", recordType: "config-revision", title: `${target.title} rollback v${version}`, state: "published", data: { projectId: target.data.projectId, environmentKey: target.data.environmentKey, flagId: target.data.flagId, version, baseVersion, content: rollbackContent, contentHash: rollbackHash, publishedContentHash: rollbackHash, rollbackSourceRevisionId: target.id, publishedAt: now } });
      const event = await create(store, userId, { moduleId: "flags", recordType: "rollback-event", title: `Rollback to ${target.id}`, state: "published", data: { sourceRevisionId: current.id, targetRevisionId: target.id, newRevisionId: revision.id, version, idempotencyKey: key, occurredAt: now, appendOnly: true } });
      return result(action, [revision, event], { rollbackEventId: event.id, sourceRevisionId: current.id, targetRevisionId: target.id, newRevisionId: revision.id, version, contentHash: rollbackHash, replayed: false });
    });
  }
  if (actionId === "stale-review") {
    const project = await owned(store, userId, input.projectId, "flags", "flag-project", "projectId");
    const flags = (await store.listRecords(userId, { moduleId: "flags", recordType: "flag", limit: 10_000 })).filter((record) => record.data.projectId === project.id);
    const stale = flags.filter((flag) => flag.state !== "active" || typeof flag.data.reviewAt === "string" && new Date(flag.data.reviewAt) < new Date(now));
    return result(action, stale, { projectId: project.id, suggestions: stale.map((flag) => ({ flagId: flag.id, reason: flag.state !== "active" ? "never-published" : "review-date-passed" })), mutationApplied: false });
  }
  throw new Error("Feature-flags action is not implemented.");
}

export async function executeScheduleFormsFlagsAction(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, clock: () => Date): Promise<DeterministicSuiteActionResult> {
  const now = clock().toISOString();
  if (action.moduleId === "schedule") return executeSchedule(store, userId, action, actionId, input, now);
  if (action.moduleId === "forms") return executeForms(store, userId, action, actionId, input, now);
  if (action.moduleId === "flags") return executeFlags(store, userId, action, actionId, input, now);
  throw new Error("Deterministic module action is not implemented.");
}
