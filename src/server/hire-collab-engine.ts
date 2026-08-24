import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SuiteRecord } from "../shared/suite.js";
import type { SuiteActionDefinition } from "../shared/suite-actions.js";
import type { SuiteActionResult, SuiteEngineDependencies } from "./suite-engine.js";
import type { SuiteStore } from "./suite-store.js";

const terminalApplicationStates = new Set(["hired", "not_selected", "not-selected", "rejected"]);
const closedApplicationStates = new Set(["hired", "not_selected", "withdrawn", "closed", "deletion_pending", "deleted"]);
const forbiddenTraitKeys = new Set([
  "age", "birthdate", "dateofbirth", "race", "ethnicity", "religion", "disability", "health", "medicalcondition",
  "pregnancy", "sex", "sexuality", "sexualorientation", "gender", "genderidentity", "maritalstatus", "nationalorigin",
  "facialexpression", "emotion", "personality", "honesty", "culturalfit",
]);
const forbiddenExecutableKeys = new Set(["html", "innerhtml", "outerhtml", "srcdoc", "javascript", "script", "onload", "onerror", "executable", "shell", "command", "filepath"]);
const blockTypes = new Set(["paragraph", "heading", "list", "checklist", "quote", "code", "table", "callout", "divider", "attachment", "embed", "record-link"]);
const elementTypes = new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "freehand", "text", "sticky-note", "frame", "image", "record-link"]);
const collabLocks = new Map<string, Promise<void>>();

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}

function canonicalJson(value: unknown) { return JSON.stringify(canonicalValue(value)); }
function digest(value: unknown) { return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex"); }
function result(action: SuiteActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>): SuiteActionResult { return { kind: "command", action, records, audit }; }

function text(input: Record<string, unknown>, name: string, maximum = 4_000) {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  return value.trim();
}

function integer(input: Record<string, unknown>, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const value = input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be a safe integer from ${minimum} to ${maximum}.`);
  return value;
}

function sha256(input: Record<string, unknown>, name: string) {
  const value = text(input, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  return value;
}

function safeIdempotencyKey(input: Record<string, unknown>) {
  const value = text(input, "idempotencyKey", 200);
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(value)) throw new Error("idempotencyKey must contain 16 to 200 safe characters.");
  return value;
}

function dateTime(input: Record<string, unknown>, name: string) {
  const raw = text(input, name, 40);
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) throw new Error(`${name} must be an ISO 8601 date-time.`);
  return value;
}

function normalizedKey(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }

function inspectJson(value: unknown, options: { label: string; forbiddenKeys?: Set<string>; maximumBytes: number }, depth = 0, seen = new WeakSet<object>()): void {
  if (depth > 16) throw new Error(`${options.label} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 20_000) throw new Error(`${options.label} contains an oversized string.`);
    if (/^\s*(?:javascript|data\s*:\s*text\/html)\s*:/i.test(value)) throw new Error(`${options.label} contains executable content.`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error(`${options.label} contains a non-finite or out-of-bounds number.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${options.label} must contain JSON-compatible values only.`);
  if (seen.has(value as object)) throw new Error(`${options.label} cannot contain circular references.`);
  seen.add(value as object);
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error(`${options.label} contains too many items.`);
    value.forEach((item) => inspectJson(item, options, depth + 1, seen));
  } else {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1_000) throw new Error(`${options.label} contains too many fields.`);
    for (const [key, item] of entries) {
      const normalized = normalizedKey(key);
      if (options.forbiddenKeys?.has(normalized)) throw new Error(`${options.label} contains forbidden field ${key}.`);
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${options.label} contains an unsafe object key.`);
      inspectJson(item, options, depth + 1, seen);
    }
  }
  seen.delete(value as object);
  if (depth === 0 && Buffer.byteLength(canonicalJson(value), "utf8") > options.maximumBytes) throw new Error(`${options.label} exceeds the ${options.maximumBytes}-byte limit.`);
}

async function ownedRecord(store: SuiteStore, userId: string, recordId: unknown, moduleId: string, recordTypes: string | string[], label: string) {
  if (typeof recordId !== "string") throw new Error(`${label} must be a UUID string.`);
  const record = await store.getRecord(userId, recordId);
  const allowed = Array.isArray(recordTypes) ? recordTypes : [recordTypes];
  if (!record || record.moduleId !== moduleId || !allowed.includes(record.recordType)) throw new Error(`${label.replace(/Id$/, "")} not found.`);
  return record;
}

async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = collabLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.then(() => gate);
  collabLocks.set(key, queued);
  await prior;
  try { return await work(); }
  finally {
    release();
    if (collabLocks.get(key) === queued) collabLocks.delete(key);
  }
}

function hiringStages(input: Record<string, unknown>) {
  if (!Array.isArray(input.pipelineStages) || !input.pipelineStages.length || input.pipelineStages.length > 30) throw new Error("pipelineStages must contain 1 to 30 stage keys.");
  const stages = input.pipelineStages.map((stage, index) => {
    if (typeof stage !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(stage)) throw new Error(`pipelineStages[${index}] must be a stable lowercase key.`);
    if (terminalApplicationStates.has(stage)) throw new Error("Terminal outcomes are decisions, not automated pipeline stages.");
    return stage;
  });
  if (new Set(stages).size !== stages.length) throw new Error("pipelineStages must be unique.");
  return stages;
}

function applicationAnswers(input: Record<string, unknown>) {
  if (!Array.isArray(input.answers) || input.answers.length > 100) throw new Error("answers must be an array with at most 100 items.");
  inspectJson(input.answers, { label: "answers", forbiddenKeys: forbiddenTraitKeys, maximumBytes: 128_000 });
  for (const [index, answer] of input.answers.entries()) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error(`answers[${index}] must be an object.`);
    const key = (answer as Record<string, unknown>).key;
    if (typeof key !== "string" || !key.trim() || key.length > 100) throw new Error(`answers[${index}].key must be a stable field label.`);
    if (forbiddenTraitKeys.has(normalizedKey(key))) throw new Error(`answers[${index}] requests a protected or sensitive trait.`);
  }
  return canonicalValue(input.answers) as unknown[];
}

function transitionSnapshot(application: SuiteRecord, toStage: string) {
  const pipeline = application.data.pipelineSnapshot;
  if (!Array.isArray(pipeline) || pipeline.some((stage) => typeof stage !== "string")) throw new Error("The application has no valid bound pipeline snapshot.");
  if (terminalApplicationStates.has(toStage)) throw new Error("API and agent actions cannot perform hired or not-selected terminal transitions.");
  if (!pipeline.includes(toStage)) throw new Error("toStage is not part of the application's bound pipeline version.");
  const fromStage = String(application.data.currentStage ?? "");
  if (!fromStage || fromStage === toStage) throw new Error("The requested transition must change to a different valid stage.");
  if (closedApplicationStates.has(application.state)) throw new Error("This application no longer accepts pipeline transitions.");
  const expectedVersion = Number(application.data.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("The application version is invalid.");
  const preview = { applicationId: application.id, fromStage, toStage, expectedVersion, jobVersion: application.data.jobVersion, pipelineVersion: application.data.pipelineVersion };
  return { ...preview, previewHash: digest(preview) };
}

async function hiringEvidence(store: SuiteStore, userId: string, application: SuiteRecord, value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 50 || value.some((id) => typeof id !== "string") || new Set(value).size !== value.length) throw new Error("evidenceIds must contain 1 to 50 unique workspace record IDs.");
  const records: SuiteRecord[] = [];
  for (const recordId of value as string[]) {
    const record = await store.getRecord(userId, recordId);
    const linked = record?.id === application.id || record?.id === application.data.candidateId || record?.data.applicationId === application.id || record?.data.candidateId === application.data.candidateId;
    if (!record || record.moduleId !== "hire" || !linked) throw new Error("Every evidence record must be workspace-owned evidence linked to the selected application.");
    records.push(record);
  }
  return records;
}

async function candidateRecords(store: SuiteStore, userId: string, candidate: SuiteRecord) {
  const all = await store.listRecords(userId, { moduleId: "hire", limit: 10_000 });
  const applications = all.filter((record) => record.recordType === "application" && record.data.candidateId === candidate.id);
  const applicationIds = new Set(applications.map((record) => record.id));
  const interviews = all.filter((record) => record.recordType === "interview" && applicationIds.has(String(record.data.applicationId)));
  const interviewIds = new Set(interviews.map((record) => record.id));
  return all.filter((record) => record.id === candidate.id || applicationIds.has(record.id) || record.data.candidateId === candidate.id || applicationIds.has(String(record.data.applicationId)) || interviewIds.has(record.id) || interviewIds.has(String(record.data.interviewId)));
}

export async function executeHireAction(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, dependencies: SuiteEngineDependencies): Promise<SuiteActionResult> {
  const now = dependencies.now().toISOString();
  if (actionId === "job-list") {
    const records = await store.listRecords(userId, { moduleId: "hire", recordType: "job", limit: 1_000 });
    return result(action, records, { count: records.length });
  }
  if (actionId === "application-list") {
    const job = await ownedRecord(store, userId, input.jobId, "hire", "job", "jobId");
    const records = (await store.listRecords(userId, { moduleId: "hire", recordType: "application", limit: 10_000 })).filter((record) => record.data.jobId === job.id);
    return result(action, records, { jobId: job.id, count: records.length });
  }
  if (actionId === "application-get") {
    const application = await ownedRecord(store, userId, input.applicationId, "hire", "application", "applicationId");
    return result(action, [application], { applicationId: application.id, version: application.data.version });
  }
  if (actionId === "job-draft") {
    const title = text(input, "title", 240);
    const description = text(input, "description", 20_000);
    const pipelineStages = hiringStages(input);
    const privacyNoticeVersion = text(input, "privacyNoticeVersion", 120);
    const content = { title, description, pipelineStages, privacyNoticeVersion };
    const contentHash = digest(content);
    const job = await store.createRecord(userId, { moduleId: "hire", recordType: "job", title, state: "draft", data: { content, contentHash, version: 1, pipelineVersion: 1, applicationFormVersion: 1, public: false, createdAt: now } });
    if (!job) throw new Error("The hiring job could not be drafted.");
    return result(action, [job], { jobId: job.id, version: 1, contentHash, createdAt: now });
  }
  if (actionId === "job-approve") {
    const job = await ownedRecord(store, userId, input.jobId, "hire", "job", "jobId");
    const contentHash = sha256(input, "contentHash");
    if (job.data.contentHash !== contentHash || digest(job.data.content) !== contentHash) throw new Error("The approval hash does not match the immutable job content.");
    if (job.state === "approved" && job.data.approvedContentHash === contentHash) return result(action, [job], { jobId: job.id, contentHash, replayed: true });
    if (job.state !== "draft") throw new Error("Only a draft job can be approved.");
    const approved = await store.updateRecord(userId, job.id, { state: "approved", data: { approvedContentHash: contentHash, approvedAt: now } });
    if (!approved) throw new Error("The hiring job approval could not be persisted.");
    return result(action, [approved], { jobId: job.id, contentHash, approvedAt: now, replayed: false });
  }
  if (actionId === "job-publish") {
    const job = await ownedRecord(store, userId, input.jobId, "hire", "job", "jobId");
    const contentHash = sha256(input, "contentHash");
    const idempotencyKey = safeIdempotencyKey(input);
    return locked(`hire-job:${job.id}`, async () => {
      const jobs = await store.listRecords(userId, { moduleId: "hire", recordType: "job", limit: 10_000 });
      const replay = jobs.find((candidate) => candidate.data.publishIdempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.id !== job.id || replay.data.contentHash !== contentHash) throw new Error("The job publication key was already used for different content.");
        return result(action, [replay], { jobId: replay.id, contentHash, version: replay.data.version, replayed: true });
      }
      const current = await ownedRecord(store, userId, job.id, "hire", "job", "jobId");
      if (current.state !== "approved" || current.data.approvedContentHash !== contentHash || current.data.contentHash !== contentHash || digest(current.data.content) !== contentHash) throw new Error("Only the exact approved job content can be published.");
      const published = await store.updateRecord(userId, current.id, { state: "published", data: { public: true, publishIdempotencyKey: idempotencyKey, publishedAt: now } });
      if (!published) throw new Error("The hiring job could not be published.");
      return result(action, [published], { jobId: published.id, contentHash, version: published.data.version, publishedAt: now, replayed: false });
    });
  }
  if (actionId === "application-submit") {
    const job = await ownedRecord(store, userId, input.jobId, "hire", "job", "jobId");
    if (job.state !== "published" || job.data.public !== true || job.data.approvedContentHash !== job.data.contentHash) throw new Error("Applications require an exact approved published job version.");
    const candidateName = text(input, "candidateName", 240);
    const email = text(input, "email", 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email must be valid.");
    if (input.consent !== true) throw new Error("Explicit consent is required.");
    const answers = applicationAnswers(input);
    return locked(`hire-submit:${job.workspaceId}`, async () => {
      const existingCandidates = (await store.listRecords(userId, { moduleId: "hire", recordType: "candidate", limit: 10_000 })).filter((candidate) => candidate.data.normalizedEmail === email);
      const candidate = await store.createRecord(userId, { moduleId: "hire", recordType: "candidate", title: candidateName, state: "active", data: { email, normalizedEmail: email, noticeVersion: (job.data.content as Record<string, unknown>).privacyNoticeVersion, lifecycleState: "active", duplicateSuggestionIds: existingCandidates.map((item) => item.id), createdAt: now } });
      if (!candidate) throw new Error("The candidate record could not be created.");
      const pipelineSnapshot = (job.data.content as Record<string, unknown>).pipelineStages;
      if (!Array.isArray(pipelineSnapshot) || !pipelineSnapshot.length || pipelineSnapshot.some((stage) => typeof stage !== "string")) throw new Error("The published job has no valid pipeline snapshot.");
      const application = await store.createRecord(userId, { moduleId: "hire", recordType: "application", title: `${candidateName} · ${job.title}`, state: "active", data: { candidateId: candidate.id, jobId: job.id, jobVersion: job.data.version, jobContentHash: job.data.contentHash, applicationFormVersion: job.data.applicationFormVersion, pipelineVersion: job.data.pipelineVersion, pipelineSnapshot: [...pipelineSnapshot], currentStage: pipelineSnapshot[0], answers, version: 1, submittedAt: now, noticeVersion: (job.data.content as Record<string, unknown>).privacyNoticeVersion } });
      if (!application) throw new Error("The application could not be created.");
      const notice = await store.createRecord(userId, { moduleId: "hire", recordType: "consent-notice", title: `Notice for ${application.id}`, state: "accepted", data: { candidateId: candidate.id, applicationId: application.id, noticeVersion: application.data.noticeVersion, decision: true, acceptedAt: now, immutable: true } });
      const event = await store.createRecord(userId, { moduleId: "hire", recordType: "application-event", title: `Submitted · ${application.id}`, state: "recorded", data: { applicationId: application.id, candidateId: candidate.id, eventType: "submitted", applicationVersion: 1, jobVersion: application.data.jobVersion, pipelineVersion: application.data.pipelineVersion, occurredAt: now, appendOnly: true } });
      if (!notice || !event) throw new Error("The application evidence could not be appended.");
      return result(action, [application, candidate, notice, event], { applicationId: application.id, candidateId: candidate.id, eventId: event.id, version: 1, duplicateSuggestionIds: existingCandidates.map((item) => item.id), submittedAt: now });
    });
  }
  if (actionId === "transition-preview") {
    const application = await ownedRecord(store, userId, input.applicationId, "hire", "application", "applicationId");
    const preview = transitionSnapshot(application, text(input, "toStage", 40));
    return result(action, [application], { ...preview, mutationApplied: false });
  }
  if (actionId === "transition-apply") {
    const application = await ownedRecord(store, userId, input.applicationId, "hire", "application", "applicationId");
    const requestedVersion = integer(input, "expectedVersion");
    const requestedHash = sha256(input, "previewHash");
    const toStage = text(input, "toStage", 40);
    const reason = text(input, "reason", 2_000);
    return locked(`hire-application:${application.id}`, async () => {
      const current = await ownedRecord(store, userId, application.id, "hire", "application", "applicationId");
      const preview = transitionSnapshot(current, toStage);
      if (preview.expectedVersion !== requestedVersion || preview.previewHash !== requestedHash) throw new Error("The application version or transition preview hash is stale; preview the transition again.");
      const nextVersion = requestedVersion + 1;
      const event = await store.createRecord(userId, { moduleId: "hire", recordType: "application-event", title: `${preview.fromStage} to ${toStage}`, state: "recorded", data: { applicationId: current.id, candidateId: current.data.candidateId, eventType: "stage-transition", fromStage: preview.fromStage, toStage, reason, sourceVersion: requestedVersion, resultingVersion: nextVersion, occurredAt: now, appendOnly: true } });
      if (!event) throw new Error("The transition event could not be appended.");
      const updated = await store.updateRecord(userId, current.id, { data: { currentStage: toStage, version: nextVersion, lastTransitionEventId: event.id, transitionedAt: now } });
      if (!updated) throw new Error("The application transition could not be persisted.");
      return result(action, [updated, event], { applicationId: updated.id, eventId: event.id, fromStage: preview.fromStage, toStage, version: nextVersion, previewHash: requestedHash, appliedAt: now });
    });
  }
  if (actionId === "interview-schedule") {
    const application = await ownedRecord(store, userId, input.applicationId, "hire", "application", "applicationId");
    const plan = await ownedRecord(store, userId, input.planId, "hire", "interview-plan", "planId");
    if (closedApplicationStates.has(application.state)) throw new Error("This application cannot schedule new interviews.");
    const scheduledAt = dateTime(input, "scheduledAt");
    if (scheduledAt.getTime() <= dependencies.now().getTime()) throw new Error("scheduledAt must be in the future.");
    const interview = await store.createRecord(userId, { moduleId: "hire", recordType: "interview", title: `${application.title} · ${scheduledAt.toISOString()}`, state: "scheduled", data: { applicationId: application.id, candidateId: application.data.candidateId, planId: plan.id, planVersion: Number(plan.data.version) || 1, scheduledAt: scheduledAt.toISOString(), createdAt: now } });
    if (!interview) throw new Error("The interview could not be scheduled.");
    return result(action, [interview], { interviewId: interview.id, applicationId: application.id, scheduledAt: scheduledAt.toISOString() });
  }
  if (actionId === "scorecard-submit") {
    const interview = await ownedRecord(store, userId, input.interviewId, "hire", "interview", "interviewId");
    const interviewerId = text(input, "interviewerId", 64);
    if (!Array.isArray(input.ratings) || !input.ratings.length || input.ratings.length > 50) throw new Error("ratings must contain 1 to 50 competency ratings.");
    inspectJson(input.ratings, { label: "ratings", forbiddenKeys: forbiddenTraitKeys, maximumBytes: 64_000 });
    const ratings = input.ratings.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`ratings[${index}] must be an object.`);
      const source = item as Record<string, unknown>;
      if (typeof source.criterion !== "string" || !source.criterion.trim() || source.criterion.length > 200 || !Number.isSafeInteger(source.rating) || Number(source.rating) < 1 || Number(source.rating) > 5 || typeof source.evidence !== "string" || !source.evidence.trim() || source.evidence.length > 2_000) throw new Error(`ratings[${index}] must contain criterion, integer rating 1-5, and evidence.`);
      return { criterion: source.criterion.trim(), rating: Number(source.rating), evidence: source.evidence.trim() };
    });
    const evidenceNotes = text(input, "evidenceNotes", 10_000);
    const duplicate = (await store.listRecords(userId, { moduleId: "hire", recordType: "scorecard", limit: 10_000 })).find((scorecard) => scorecard.data.interviewId === interview.id && scorecard.data.interviewerId === interviewerId && scorecard.state === "submitted");
    if (duplicate) throw new Error("This interviewer already submitted an immutable scorecard; corrections require a future amendment workflow.");
    const scorecard = await store.createRecord(userId, { moduleId: "hire", recordType: "scorecard", title: `Scorecard · ${interview.title}`, state: "submitted", data: { interviewId: interview.id, applicationId: interview.data.applicationId, interviewerId, ratings, evidenceNotes, version: 1, submittedAt: now, immutable: true, finalDecisionCalculated: false } });
    if (!scorecard) throw new Error("The scorecard could not be submitted.");
    return result(action, [scorecard], { scorecardId: scorecard.id, interviewId: interview.id, version: 1, immutable: true, submittedAt: now });
  }
  if (actionId === "decision-record") {
    const application = await ownedRecord(store, userId, input.applicationId, "hire", "application", "applicationId");
    const decisionType = text(input, "decisionType", 80).toLowerCase().replace(/_/g, "-");
    if (terminalApplicationStates.has(decisionType) || ["hire", "reject", "offer", "notselect"].includes(decisionType.replace(/-/g, ""))) throw new Error("Terminal hiring decisions are human-only and unavailable to API or agent token actions.");
    if (!new Set(["continue-review", "pause-review", "request-more-evidence"]).has(decisionType)) throw new Error("decisionType must be continue-review, pause-review, or request-more-evidence on this API surface.");
    const expectedVersion = integer(input, "expectedVersion");
    if (Number(application.data.version) !== expectedVersion || closedApplicationStates.has(application.state)) throw new Error("The application version is stale or no longer accepts review decisions.");
    const reason = text(input, "reason", 2_000);
    const evidence = await hiringEvidence(store, userId, application, input.evidenceIds);
    const decision = await store.createRecord(userId, { moduleId: "hire", recordType: "decision", title: `${decisionType} · ${application.title}`, state: "recorded", data: { applicationId: application.id, candidateId: application.data.candidateId, decisionType, reason, evidenceIds: evidence.map((record) => record.id), applicationVersion: expectedVersion, terminal: false, recordedAt: now, appendOnly: true } });
    if (!decision) throw new Error("The review decision could not be appended.");
    return result(action, [decision], { decisionId: decision.id, applicationId: application.id, terminal: false, applicationVersion: expectedVersion, recordedAt: now });
  }
  if (actionId === "candidate-export" || actionId === "deletion-preview") {
    const candidate = await ownedRecord(store, userId, input.candidateId, "hire", "candidate", "candidateId");
    const records = await candidateRecords(store, userId, candidate);
    const recordIds = records.map((record) => record.id).sort();
    if (actionId === "candidate-export") {
      const manifestHash = digest({ candidateId: candidate.id, recordIds, schemaVersion: 1 });
      const exportRecord = await store.createRecord(userId, { moduleId: "hire", recordType: "export", title: `Candidate export · ${candidate.title}`, state: "ready", data: { candidateId: candidate.id, recordIds, schemaVersion: 1, manifestHash, createdAt: now, private: true } });
      if (!exportRecord) throw new Error("The candidate export could not be created.");
      return result(action, [exportRecord, ...records], { exportId: exportRecord.id, candidateId: candidate.id, recordCount: recordIds.length, manifestHash, createdAt: now });
    }
    const affected = { recordIds, objectIds: [], searchIndexIds: [], connectorRefs: [], retentionExceptions: [] };
    const planHash = digest({ candidateId: candidate.id, affected, schemaVersion: 1 });
    const request = await store.createRecord(userId, { moduleId: "hire", recordType: "deletion-request", title: `Deletion preview · ${candidate.title}`, state: "preview", data: { candidateId: candidate.id, affected, planHash, schemaVersion: 1, executionStarted: false, createdAt: now } });
    if (!request) throw new Error("The deletion preview could not be created.");
    return result(action, [request], { requestId: request.id, candidateId: candidate.id, affected, planHash, executionStarted: false, createdAt: now });
  }
  throw new Error("Hiring action is not implemented.");
}

export async function hireAiContext(store: SuiteStore, userId: string, actionId: string, input: Record<string, unknown>) {
  if (actionId === "resume-extract") {
    const application = await ownedRecord(store, userId, input.applicationId, "hire", "application", "applicationId");
    const resume = await ownedRecord(store, userId, input.resumeDocumentId, "hire", "resume-document", "resumeDocumentId");
    if (resume.data.applicationId !== application.id || resume.data.scanState !== "clean" || resume.state === "quarantined") throw new Error("Only a clean private resume linked to this application can be analyzed.");
    return { actionId, applicationId: application.id, resumeDocumentId: resume.id, evidenceIds: [application.id, resume.id], instruction: text(input, "instruction", 4_000), approvalRequired: true, outputContract: { sourceSpans: true, confidencePerField: true, omitUnsupportedFacts: true }, forbiddenInferences: [...forbiddenTraitKeys].sort() };
  }
  if (actionId === "candidate-summarize") {
    const application = await ownedRecord(store, userId, input.applicationId, "hire", "application", "applicationId");
    const evidence = await hiringEvidence(store, userId, application, input.evidenceIds);
    return { actionId, applicationId: application.id, evidenceIds: evidence.map((record) => record.id), instruction: text(input, "instruction", 4_000), approvalRequired: true, unsupportedClaims: "omit", terminalDecisionAllowed: false };
  }
  throw new Error("Hiring AI action is not implemented.");
}

function collabCollection(resourceType: string) { return resourceType === "document" ? "blocks" : "elements"; }

function collabItems(value: unknown, resourceType: "document" | "canvas", label: string) {
  if (!Array.isArray(value) || value.length > 5_000) throw new Error(`${label} must be an array with at most 5000 items.`);
  inspectJson(value, { label, forbiddenKeys: forbiddenExecutableKeys, maximumBytes: 512_000 });
  const ids = new Set<string>();
  const allowedTypes = resourceType === "document" ? blockTypes : elementTypes;
  const items = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}[${index}] must be an object.`);
    const source = item as Record<string, unknown>;
    if (typeof source.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(source.id) || ids.has(source.id)) throw new Error(`${label}[${index}].id must be a unique stable identifier.`);
    if (typeof source.type !== "string" || !allowedTypes.has(source.type)) throw new Error(`${label}[${index}].type is not supported.`);
    if (source.type === "embed" && (typeof source.provider !== "string" || !["asset", "record", "external-link"].includes(source.provider))) throw new Error("Embeds must use a supported structured provider; executable HTML is not accepted.");
    for (const field of ["width", "height"]) if (source[field] !== undefined && (typeof source[field] !== "number" || !Number.isFinite(source[field]) || Number(source[field]) < 0 || Number(source[field]) > 100_000)) throw new Error(`${label}[${index}].${field} is outside the finite geometry bounds.`);
    ids.add(source.id);
    return canonicalValue(source) as Record<string, unknown>;
  });
  return items;
}

function collabOperations(value: unknown, resourceType: "document" | "canvas") {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("operations must contain 1 to 100 operations.");
  inspectJson(value, { label: "operations", forbiddenKeys: forbiddenExecutableKeys, maximumBytes: 128_000 });
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`operations[${index}] must be an object.`);
    const operation = item as Record<string, unknown>;
    if (!new Set(["upsert", "remove", "move"]).has(String(operation.op))) throw new Error(`operations[${index}].op must be upsert, remove, or move.`);
    if (operation.op === "upsert") {
      const [safeItem] = collabItems([operation.item], resourceType, `operations[${index}].item`);
      return { op: "upsert", item: safeItem };
    }
    if (typeof operation.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(operation.id)) throw new Error(`operations[${index}].id must be a stable identifier.`);
    if (operation.op === "move" && operation.afterId !== null && operation.afterId !== undefined && (typeof operation.afterId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(operation.afterId))) throw new Error(`operations[${index}].afterId must be a stable identifier or null.`);
    return operation.op === "move" ? { op: "move", id: operation.id, afterId: operation.afterId ?? null } : { op: "remove", id: operation.id };
  });
}

function applyOperations(items: Record<string, unknown>[], operations: Record<string, unknown>[]) {
  const next = items.map((item) => canonicalValue(item) as Record<string, unknown>);
  for (const operation of operations) {
    if (operation.op === "upsert") {
      const item = operation.item as Record<string, unknown>;
      const position = next.findIndex((current) => current.id === item.id);
      if (position < 0) next.push(item); else next[position] = item;
      continue;
    }
    const position = next.findIndex((current) => current.id === operation.id);
    if (position < 0) throw new Error(`Operation target ${String(operation.id)} does not exist at the base version.`);
    if (operation.op === "remove") { next.splice(position, 1); continue; }
    const [moving] = next.splice(position, 1);
    if (operation.afterId === null) { next.unshift(moving); continue; }
    const target = next.findIndex((current) => current.id === operation.afterId);
    if (target < 0) throw new Error(`Move anchor ${String(operation.afterId)} does not exist at the base version.`);
    next.splice(target + 1, 0, moving);
  }
  return next;
}

async function collabResource(store: SuiteStore, userId: string, resourceId: unknown) {
  return ownedRecord(store, userId, resourceId, "collab", ["document", "canvas"], "resourceId");
}

async function collabRevision(store: SuiteStore, userId: string, revisionId: unknown, resource: SuiteRecord, label = "revisionId") {
  const revision = await ownedRecord(store, userId, revisionId, "collab", "revision", label);
  if (revision.data.resourceId !== resource.id) throw new Error(`${label.replace(/Id$/, "")} does not belong to the selected resource.`);
  return revision;
}

async function applyCollabOperation(store: SuiteStore, userId: string, action: SuiteActionDefinition, resourceId: string, operationId: string, baseVersion: number, rawOperations: unknown, now: string, attribution: Record<string, unknown> = {}) {
  return locked(`collab-resource:${resourceId}`, async () => {
    const resource = await collabResource(store, userId, resourceId);
    const resourceType = resource.recordType as "document" | "canvas";
    const operations = collabOperations(rawOperations, resourceType);
    const payloadHash = digest({ resourceId, operationId, baseVersion, operations });
    const existingOperations = await store.listRecords(userId, { moduleId: "collab", recordType: "operation", limit: 10_000 });
    const replay = existingOperations.find((record) => record.data.operationId === operationId);
    if (replay) {
      if (replay.data.resourceId !== resource.id || replay.data.payloadHash !== payloadHash) throw new Error("operationId was already used for a different resource or payload.");
      const revision = await ownedRecord(store, userId, replay.data.resultingRevisionId, "collab", "revision", "resultingRevisionId");
      return { records: [resource, replay, revision], audit: { operationId, payloadHash, resultingVersion: replay.data.resultingVersion, replayed: true } };
    }
    if (Number(resource.data.version) !== baseVersion) throw new Error("The collaboration resource version is stale; fetch the current head and rebase the operation.");
    const collection = collabCollection(resourceType);
    const snapshot = resource.data.snapshot;
    const currentItems = snapshot && typeof snapshot === "object" && Array.isArray((snapshot as Record<string, unknown>)[collection]) ? (snapshot as Record<string, unknown>)[collection] as Record<string, unknown>[] : [];
    const nextItems = applyOperations(currentItems, operations);
    const nextVersion = baseVersion + 1;
    const nextSnapshot = { schemaVersion: 1, [collection]: nextItems };
    const contentHash = digest({ resourceType, snapshot: nextSnapshot, version: nextVersion });
    const operation = await store.createRecord(userId, { moduleId: "collab", recordType: "operation", title: `Operation ${operationId}`, state: "applied", data: { resourceId: resource.id, operationId, baseVersion, resultingVersion: nextVersion, operations, payloadHash, receivedAt: now, immutable: true, ...attribution } });
    if (!operation) throw new Error("The collaboration operation could not be persisted.");
    const revision = await store.createRecord(userId, { moduleId: "collab", recordType: "revision", title: `Revision ${nextVersion} · ${resource.title}`, state: "active", data: { resourceId: resource.id, resourceType, version: nextVersion, parentRevisionIds: resource.data.currentRevisionId ? [resource.data.currentRevisionId] : [], contentHash, snapshot: nextSnapshot, operationIds: [operation.id], createdAt: now, immutable: true, ...attribution } });
    if (!revision) throw new Error("The collaboration revision could not be persisted.");
    const updated = await store.updateRecord(userId, resource.id, { data: { version: nextVersion, snapshot: nextSnapshot, contentHash, currentRevisionId: revision.id, updatedAt: now } });
    if (!updated) throw new Error("The collaboration resource head could not be updated.");
    const persistedOperation = await store.updateRecord(userId, operation.id, { data: { resultingRevisionId: revision.id } });
    if (!persistedOperation) throw new Error("The collaboration operation result could not be linked.");
    return { records: [updated, persistedOperation, revision], audit: { operationId, operationRecordId: persistedOperation.id, revisionId: revision.id, payloadHash, contentHash, resultingVersion: nextVersion, replayed: false } };
  });
}

function revisionChanges(from: SuiteRecord, to: SuiteRecord) {
  const snapshotItems = (revision: SuiteRecord) => {
    const snapshot = revision.data.snapshot;
    if (!snapshot || typeof snapshot !== "object") return [] as Record<string, unknown>[];
    const source = snapshot as Record<string, unknown>;
    const values = Array.isArray(source.blocks) ? source.blocks : Array.isArray(source.elements) ? source.elements : [];
    return values as Record<string, unknown>[];
  };
  const before = new Map(snapshotItems(from).map((item) => [String(item.id), digest(item)]));
  const after = new Map(snapshotItems(to).map((item) => [String(item.id), digest(item)]));
  return {
    addedIds: [...after.keys()].filter((id) => !before.has(id)).sort(),
    removedIds: [...before.keys()].filter((id) => !after.has(id)).sort(),
    changedIds: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)).sort(),
  };
}

export async function executeCollabAction(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, dependencies: SuiteEngineDependencies): Promise<SuiteActionResult> {
  const nowDate = dependencies.now();
  const now = nowDate.toISOString();
  if (actionId === "space-list") {
    const records = await store.listRecords(userId, { moduleId: "collab", recordType: "space", limit: 1_000 });
    return result(action, records, { count: records.length });
  }
  if (actionId === "document-get" || actionId === "canvas-get") {
    const recordType = actionId === "document-get" ? "document" : "canvas";
    const field = actionId === "document-get" ? "documentId" : "canvasId";
    const resource = await ownedRecord(store, userId, input[field], "collab", recordType, field);
    const revision = await collabRevision(store, userId, resource.data.currentRevisionId, resource, "currentRevisionId");
    return result(action, [resource, revision], { resourceId: resource.id, version: resource.data.version, contentHash: resource.data.contentHash, currentRevisionId: revision.id });
  }
  if (actionId === "document-create" || actionId === "canvas-create") {
    const space = await ownedRecord(store, userId, input.spaceId, "collab", "space", "spaceId");
    const title = text(input, "title", 300);
    const resourceType = actionId === "document-create" ? "document" : "canvas";
    const collection = collabCollection(resourceType);
    const items = collabItems(input[collection], resourceType, collection);
    const snapshot = { schemaVersion: 1, [collection]: items };
    const contentHash = digest({ resourceType, snapshot, version: 1 });
    const resource = await store.createRecord(userId, { moduleId: "collab", recordType: resourceType, title, state: "active", data: { spaceId: space.id, version: 1, snapshot, contentHash, currentRevisionId: null, permissionPolicy: "workspace", createdAt: now } });
    if (!resource) throw new Error(`The collaborative ${resourceType} could not be created.`);
    const revision = await store.createRecord(userId, { moduleId: "collab", recordType: "revision", title: `Revision 1 · ${title}`, state: "active", data: { resourceId: resource.id, resourceType, version: 1, parentRevisionIds: [], contentHash, snapshot, operationIds: [], createdAt: now, immutable: true } });
    if (!revision) throw new Error("The initial collaboration revision could not be persisted.");
    const updated = await store.updateRecord(userId, resource.id, { data: { currentRevisionId: revision.id } });
    if (!updated) throw new Error("The collaboration resource head could not be linked.");
    return result(action, [updated, revision], { resourceId: updated.id, revisionId: revision.id, version: 1, contentHash, createdAt: now });
  }
  if (actionId === "operation-apply") {
    const resource = await collabResource(store, userId, input.resourceId);
    const operationId = text(input, "operationId", 64);
    const baseVersion = integer(input, "baseVersion");
    const applied = await applyCollabOperation(store, userId, action, resource.id, operationId, baseVersion, input.operations, now);
    return result(action, applied.records, applied.audit);
  }
  if (actionId === "patch-apply") {
    if (input.approval !== true) throw new Error("Explicit proposal approval is required.");
    const resource = await collabResource(store, userId, input.resourceId);
    const sourceRevision = await collabRevision(store, userId, input.sourceRevisionId, resource, "sourceRevisionId");
    const expectedVersion = integer(input, "expectedVersion");
    const proposalId = text(input, "proposalId", 64);
    const aiAction = await store.getAiAction(userId, proposalId);
    if (!aiAction || aiAction.moduleId !== "collab" || aiAction.status !== "completed" || !aiAction.result) throw new Error("The completed workspace AI proposal was not found.");
    if (aiAction.context.resourceId !== resource.id || aiAction.context.sourceRevisionId !== sourceRevision.id || aiAction.result.approvalRequired !== true || !Array.isArray(aiAction.result.operations)) throw new Error("The AI proposal is not a valid approval-required patch for this exact resource revision.");
    const existingPatch = (await store.listRecords(userId, { moduleId: "collab", recordType: "ai-patch", limit: 10_000 })).find((patch) => patch.data.aiActionId === aiAction.id && patch.state === "accepted");
    if (existingPatch) {
      const current = await collabResource(store, userId, resource.id);
      return result(action, [existingPatch, current], { patchId: existingPatch.id, proposalId: aiAction.id, operationId: existingPatch.data.operationId, replayed: true });
    }
    if (Number(resource.data.version) !== expectedVersion || resource.data.currentRevisionId !== sourceRevision.id || Number(sourceRevision.data.version) !== expectedVersion) throw new Error("The AI patch source is stale; regenerate or explicitly rebase it against the current revision.");
    const operationId = randomUUID();
    const applied = await applyCollabOperation(store, userId, action, resource.id, operationId, expectedVersion, aiAction.result.operations, now, { source: "approved-ai-proposal", aiActionId: aiAction.id, modelAttribution: aiAction.result.model ?? "configured-model" });
    const patch = await store.createRecord(userId, { moduleId: "collab", recordType: "ai-patch", title: `Accepted proposal ${aiAction.id}`, state: "accepted", data: { aiActionId: aiAction.id, resourceId: resource.id, sourceRevisionId: sourceRevision.id, sourceVersion: expectedVersion, operationId, resultingRevisionId: applied.audit.revisionId, resultingVersion: applied.audit.resultingVersion, approvedByUserId: userId, approvedAt: now, approvalRequired: true, immutable: true } });
    if (!patch) throw new Error("The accepted AI patch attribution could not be persisted.");
    return result(action, [patch, ...applied.records], { ...applied.audit, patchId: patch.id, proposalId: aiAction.id, approvedAt: now });
  }
  if (actionId === "comment-create") {
    const resource = await collabResource(store, userId, input.resourceId);
    const anchorId = text(input, "anchorId", 80);
    const body = text(input, "body", 10_000);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body)) throw new Error("body contains unsupported control characters.");
    const comment = await store.createRecord(userId, { moduleId: "collab", recordType: "comment-thread", title: `Comment · ${resource.title}`, state: "open", data: { resourceId: resource.id, anchorId, body, plainText: true, createdAt: now, appendOnlyHistory: true } });
    if (!comment) throw new Error("The collaboration comment could not be created.");
    return result(action, [comment], { commentId: comment.id, resourceId: resource.id, anchorId, createdAt: now });
  }
  if (actionId === "revision-list") {
    const resource = await collabResource(store, userId, input.resourceId);
    const revisions = (await store.listRecords(userId, { moduleId: "collab", recordType: "revision", limit: 10_000 })).filter((revision) => revision.data.resourceId === resource.id);
    return result(action, revisions, { resourceId: resource.id, count: revisions.length, currentRevisionId: resource.data.currentRevisionId });
  }
  if (actionId === "revision-create") {
    const resource = await collabResource(store, userId, input.resourceId);
    const expectedVersion = integer(input, "expectedVersion");
    if (Number(resource.data.version) !== expectedVersion) throw new Error("The collaboration resource version is stale.");
    const reason = text(input, "reason", 1_000);
    const revision = await store.createRecord(userId, { moduleId: "collab", recordType: "revision", title: `${reason} · ${resource.title}`, state: "named", data: { resourceId: resource.id, resourceType: resource.recordType, version: expectedVersion, parentRevisionIds: resource.data.currentRevisionId ? [resource.data.currentRevisionId] : [], contentHash: resource.data.contentHash, snapshot: resource.data.snapshot, operationIds: [], reason, named: true, createdAt: now, immutable: true } });
    if (!revision) throw new Error("The named collaboration revision could not be created.");
    return result(action, [revision], { revisionId: revision.id, resourceId: resource.id, version: expectedVersion, contentHash: revision.data.contentHash, createdAt: now });
  }
  if (actionId === "revision-compare") {
    const resource = await collabResource(store, userId, input.resourceId);
    const from = await collabRevision(store, userId, input.fromRevisionId, resource, "fromRevisionId");
    const to = await collabRevision(store, userId, input.toRevisionId, resource, "toRevisionId");
    return result(action, [from, to], { resourceId: resource.id, fromRevisionId: from.id, toRevisionId: to.id, fromVersion: from.data.version, toVersion: to.data.version, fromContentHash: from.data.contentHash, toContentHash: to.data.contentHash, changes: revisionChanges(from, to) });
  }
  if (actionId === "revision-restore") {
    const resource = await collabResource(store, userId, input.resourceId);
    const target = await collabRevision(store, userId, input.revisionId, resource);
    const expectedVersion = integer(input, "expectedVersion");
    return locked(`collab-resource:${resource.id}`, async () => {
      const current = await collabResource(store, userId, resource.id);
      if (Number(current.data.version) !== expectedVersion) throw new Error("The collaboration resource version is stale; inspect the current head before restoring.");
      const nextVersion = expectedVersion + 1;
      const contentHash = digest({ resourceType: current.recordType, snapshot: target.data.snapshot, version: nextVersion });
      const revision = await store.createRecord(userId, { moduleId: "collab", recordType: "revision", title: `Restore ${target.title} · ${current.title}`, state: "active", data: { resourceId: current.id, resourceType: current.recordType, version: nextVersion, parentRevisionIds: [current.data.currentRevisionId, target.id].filter(Boolean), restoredFromRevisionId: target.id, contentHash, snapshot: target.data.snapshot, operationIds: [], createdAt: now, immutable: true } });
      if (!revision) throw new Error("The restored collaboration revision could not be created.");
      const updated = await store.updateRecord(userId, current.id, { data: { version: nextVersion, snapshot: target.data.snapshot, contentHash, currentRevisionId: revision.id, restoredAt: now } });
      if (!updated) throw new Error("The restored collaboration head could not be persisted.");
      return result(action, [updated, revision, target], { resourceId: updated.id, revisionId: revision.id, restoredFromRevisionId: target.id, priorHeadRevisionId: current.data.currentRevisionId, version: nextVersion, contentHash, restoredAt: now });
    });
  }
  if (actionId === "share-create") {
    const resource = await collabResource(store, userId, input.resourceId);
    const revision = await collabRevision(store, userId, input.revisionId, resource);
    const permission = text(input, "permission", 20);
    if (!new Set(["view", "comment"]).has(permission)) throw new Error("permission must be view or comment; anonymous editing is not supported.");
    const expiresAt = dateTime(input, "expiresAt");
    if (expiresAt.getTime() <= nowDate.getTime() || expiresAt.getTime() > nowDate.getTime() + 366 * 24 * 60 * 60 * 1_000) throw new Error("expiresAt must be in the future and no more than 366 days away.");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = digest(token);
    const share = await store.createRecord(userId, { moduleId: "collab", recordType: "share-link", title: `Pinned share · ${resource.title}`, state: "active", data: { resourceId: resource.id, pinnedRevisionId: revision.id, pinnedContentHash: revision.data.contentHash, permission, tokenHash, expiresAt: expiresAt.toISOString(), currentView: false, public: false, createdAt: now } });
    if (!share) throw new Error("The pinned collaboration share could not be created.");
    return result(action, [share], { shareId: share.id, token, resourceId: resource.id, revisionId: revision.id, contentHash: revision.data.contentHash, permission, expiresAt: expiresAt.toISOString(), createdAt: now });
  }
  if (actionId === "export-create") {
    const resource = await collabResource(store, userId, input.resourceId);
    const revision = await collabRevision(store, userId, input.revisionId, resource);
    const format = text(input, "format", 30).toLowerCase();
    const supported = resource.recordType === "document" ? new Set(["canonical-json", "pdf", "markdown", "html"]) : new Set(["canonical-json", "pdf", "png", "svg"]);
    if (!supported.has(format)) throw new Error(`format is not supported for this ${resource.recordType}.`);
    const exportJob = await store.createRecord(userId, { moduleId: "collab", recordType: "export-job", title: `${format} export · ${resource.title}`, state: "queued", data: { resourceId: resource.id, revisionId: revision.id, revisionVersion: revision.data.version, contentHash: revision.data.contentHash, format, queuedAt: now, exactRevision: true, externalRendererStarted: false } });
    if (!exportJob) throw new Error("The collaboration export could not be queued.");
    return result(action, [exportJob], { exportId: exportJob.id, resourceId: resource.id, revisionId: revision.id, contentHash: revision.data.contentHash, format, queuedAt: now, externalRendererStarted: false });
  }
  throw new Error("Collaboration action is not implemented.");
}

export async function collabAiContext(store: SuiteStore, userId: string, actionId: string, input: Record<string, unknown>) {
  if (actionId !== "patch-propose") throw new Error("Collaboration AI action is not implemented.");
  const resource = await collabResource(store, userId, input.resourceId);
  const sourceRevision = await collabRevision(store, userId, input.sourceRevisionId, resource, "sourceRevisionId");
  if (resource.data.currentRevisionId !== sourceRevision.id || Number(resource.data.version) !== Number(sourceRevision.data.version)) throw new Error("AI proposals must target the exact current revision; fetch the current head before proposing a patch.");
  if (!Array.isArray(input.selection) || !input.selection.length || input.selection.length > 500) throw new Error("selection must contain 1 to 500 explicit block or element identifiers.");
  const selection = input.selection.map((item, index) => {
    if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item)) throw new Error(`selection[${index}] must be a stable block or element identifier.`);
    return item;
  });
  if (new Set(selection).size !== selection.length) throw new Error("selection must not contain duplicates.");
  return { actionId, resourceId: resource.id, sourceRevisionId: sourceRevision.id, sourceVersion: sourceRevision.data.version, selection, evidenceIds: [resource.id, sourceRevision.id], instruction: text(input, "instruction", 4_000), approvalRequired: true, outputContract: { operations: true, explanation: true, sourceRevisionId: sourceRevision.id }, executableContentAllowed: false };
}
