import { describe, expect, it } from "vitest";
import { executeSuiteAction, type SuiteActionResult, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { suiteAction, suiteActionInputJsonSchema, suiteActionToolName, suiteActionsByModule } from "../src/shared/suite-actions";

const owner = "70707070-7070-4070-8070-707070707070";

function firstRecord(actionResult: SuiteActionResult) {
  if (actionResult.kind === "record") return actionResult.record;
  if (actionResult.kind === "command" && actionResult.records[0]) return actionResult.records[0];
  throw new Error("Expected a durable record result.");
}

function commandAudit(actionResult: SuiteActionResult) {
  if (actionResult.kind !== "command") throw new Error("Expected a command result.");
  return actionResult.audit;
}

function fixedDependencies(clock = "2026-08-24T16:00:00.000Z"): SuiteEngineDependencies {
  return { now: () => new Date(clock), resolveTxt: async () => [], resolveHost: async () => ["93.184.216.34"] };
}

async function publishedSchedule(store: MemorySuiteStore) {
  await store.enableModule(owner, "schedule");
  const host = firstRecord(await executeSuiteAction(store, owner, "schedule", "host-create", { name: "Asha" }, fixedDependencies()));
  const revision = firstRecord(await executeSuiteAction(store, owner, "schedule", "schedule-draft", {
    name: "Weekday availability",
    timeZone: "America/New_York",
    hostIds: [host.id],
    windows: [{ dayOfWeek: 2, start: "09:00", end: "17:00" }],
  }, fixedDependencies()));
  await executeSuiteAction(store, owner, "schedule", "schedule-publish", { revisionId: revision.id, contentHash: revision.data.contentHash }, fixedDependencies());
  const release = firstRecord(await executeSuiteAction(store, owner, "schedule", "event-draft", {
    name: "Intro call",
    slug: "intro-call",
    scheduleRevisionId: revision.id,
    hostIds: [host.id],
    durationMinutes: 30,
  }, fixedDependencies()));
  await executeSuiteAction(store, owner, "schedule", "event-publish", { releaseId: release.id, contentHash: release.data.contentHash }, fixedDependencies());
  return { host, release };
}

async function publishedFormRelease(store: MemorySuiteStore, version: 1 | 2 = 1) {
  await store.enableModule(owner, "forms");
  let form = (await store.listRecords(owner, { moduleId: "forms", recordType: "form", limit: 10 }))[0];
  if (!form) form = firstRecord(await executeSuiteAction(store, owner, "forms", "form-create", { name: "Research form" }, fixedDependencies()));
  const release = firstRecord(await executeSuiteAction(store, owner, "forms", "form-draft", {
    formId: form.id,
    title: `Research form ${version}`,
    schema: {
      version: 1,
      fields: version === 1
        ? [{ key: "name", type: "short-text", required: true, purpose: "Identify the respondent in this form", privacy: "internal" }]
        : [
            { key: "name", type: "short-text", required: true, purpose: "Identify the respondent in this form", privacy: "internal" },
            { key: "team-size", type: "integer", required: true, purpose: "Understand aggregate team size", privacy: "internal" },
          ],
    },
    logic: [],
  }, fixedDependencies()));
  await executeSuiteAction(store, owner, "forms", "release-publish", { releaseId: release.id, contentHash: release.data.contentHash, idempotencyKey: `publish-form-release-${version.toString().padStart(4, "0")}` }, fixedDependencies());
  return { form, release };
}

describe("clean-room scheduling, forms, and feature-flags modules", () => {
  it("generates every required CLI/MCP action name and typed input schema", () => {
    const required: Record<string, string[]> = {
      schedule: ["schedule_host_list", "schedule_schedule_draft", "schedule_schedule_publish", "schedule_event_draft", "schedule_event_publish", "schedule_availability_preview", "schedule_routing_preview", "schedule_booking_create", "schedule_booking_get", "schedule_booking_reschedule_preview", "schedule_booking_reschedule", "schedule_booking_cancel", "schedule_connector_health", "schedule_booking_export", "schedule_unavailability_explain"],
      forms: ["forms_form_list", "forms_form_draft", "forms_schema_validate", "forms_logic_validate", "forms_release_diff", "forms_release_publish", "forms_submission_validate", "forms_submission_create", "forms_submission_get", "forms_submission_correct", "forms_results_query", "forms_results_summarize", "forms_export_preview", "forms_export_create", "forms_rights_preview"],
      flags: ["flags_project_list", "flags_flag_draft", "flags_revision_validate", "flags_rollout_preview", "flags_revision_diff", "flags_revision_approve", "flags_revision_publish", "flags_evaluate", "flags_evaluation_explain", "flags_manifest_export", "flags_exposure_record", "flags_experiment_draft", "flags_experiment_start", "flags_experiment_analyze", "flags_revision_rollback", "flags_stale_review"],
    };
    for (const [moduleId, names] of Object.entries(required)) {
      const generated = suiteActionsByModule.get(moduleId)!.map(suiteActionToolName);
      expect(generated).toEqual(expect.arrayContaining(names));
      expect(new Set(generated).size).toBe(generated.length);
    }
    expect(suiteActionInputJsonSchema(suiteAction("schedule", "schedule-draft")!).properties.windows).toMatchObject({ type: "array" });
    expect(suiteActionInputJsonSchema(suiteAction("forms", "submission-create")!).properties.responseValues).toMatchObject({ type: "object" });
    expect(suiteActionInputJsonSchema(suiteAction("flags", "evaluate")!).properties.defaultValue).not.toHaveProperty("type");
  });

  it("allows exactly one overlapping booking and returns the same booking on an idempotent retry", async () => {
    const store = new MemorySuiteStore("starter");
    const { host, release } = await publishedSchedule(store);
    const availability = commandAudit(await executeSuiteAction(store, owner, "schedule", "availability-preview", {
      releaseId: release.id,
      from: "2026-08-25T14:07:00.000Z",
      to: "2026-08-25T16:00:00.000Z",
      timeZone: "America/New_York",
    }, fixedDependencies()));
    expect(availability.slots).toEqual(expect.arrayContaining([expect.objectContaining({ startsAt: "2026-08-25T14:30:00.000Z", endsAt: "2026-08-25T15:00:00.000Z" })]));
    expect(availability.slots).not.toEqual(expect.arrayContaining([expect.objectContaining({ startsAt: "2026-08-25T14:07:00.000Z" })]));
    await expect(executeSuiteAction(store, owner, "schedule", "booking-create", {
      releaseId: release.id,
      hostId: host.id,
      startsAt: "2026-08-25T14:07:00.000Z",
      endsAt: "2026-08-25T14:37:00.000Z",
      idempotencyKey: "booking-off-grid-attempt-0000",
    }, fixedDependencies())).rejects.toThrow(/slot grid/);
    const baseInput = { releaseId: release.id, hostId: host.id, startsAt: "2026-08-25T14:00:00.000Z", endsAt: "2026-08-25T14:30:00.000Z" };
    const attempted = await Promise.allSettled([
      executeSuiteAction(store, owner, "schedule", "booking-create", { ...baseInput, idempotencyKey: "booking-attempt-primary-0001" }, fixedDependencies()),
      executeSuiteAction(store, owner, "schedule", "booking-create", { ...baseInput, idempotencyKey: "booking-attempt-second-0002" }, fixedDependencies()),
    ]);
    expect(attempted.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempted.filter((item) => item.status === "rejected")).toHaveLength(1);
    const created = firstRecord((attempted.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<SuiteActionResult>).value);
    const replay = firstRecord(await executeSuiteAction(store, owner, "schedule", "booking-create", { ...baseInput, idempotencyKey: "booking-attempt-primary-0001" }, fixedDependencies()));
    expect(replay.id).toBe(created.id);
    expect((await store.listRecords(owner, { moduleId: "schedule", recordType: "booking", limit: 20 })).filter((booking) => booking.state === "confirmed")).toHaveLength(1);
  });

  it("publishes only an exact validated form release and corrects against that original release after a newer release exists", async () => {
    const store = new MemorySuiteStore("starter");
    await store.enableModule(owner, "forms");
    const form = firstRecord(await executeSuiteAction(store, owner, "forms", "form-create", { name: "Exact form" }, fixedDependencies()));
    const draft = firstRecord(await executeSuiteAction(store, owner, "forms", "form-draft", {
      formId: form.id,
      title: "Exact form v1",
      schema: { version: 1, fields: [{ key: "name", type: "short-text", required: true, purpose: "Collect display name", privacy: "internal" }] },
      logic: [],
    }, fixedDependencies()));
    await expect(executeSuiteAction(store, owner, "forms", "release-publish", { releaseId: draft.id, contentHash: "0".repeat(64), idempotencyKey: "publish-exact-form-0001" }, fixedDependencies())).rejects.toThrow(/hash does not match/);
    expect(commandAudit(await executeSuiteAction(store, owner, "forms", "schema-validate", { releaseId: draft.id }, fixedDependencies()))).toMatchObject({ schemaValid: true, logicValid: true });
    await executeSuiteAction(store, owner, "forms", "release-publish", { releaseId: draft.id, contentHash: draft.data.contentHash, idempotencyKey: "publish-exact-form-0001" }, fixedDependencies());
    const submission = firstRecord(await executeSuiteAction(store, owner, "forms", "submission-create", { releaseId: draft.id, responseValues: { name: "Asha" }, idempotencyKey: "submit-exact-form-000001" }, fixedDependencies()));

    await publishedFormRelease(store, 2);
    const corrected = await executeSuiteAction(store, owner, "forms", "submission-correct", { submissionId: submission.id, responseValues: { name: "Asha Patel" }, expectedVersion: 1, reason: "Respondent corrected their display name" }, fixedDependencies());
    expect(commandAudit(corrected)).toMatchObject({ releaseId: draft.id, previousVersion: 1, version: 2, originalPreserved: true });
    const current = await store.getRecord(owner, submission.id);
    expect(current?.data).toMatchObject({ releaseId: draft.id, releaseContentHash: draft.data.contentHash, initialAnswers: { name: "Asha" }, currentAnswers: { name: "Asha Patel" }, version: 2 });
    await expect(executeSuiteAction(store, owner, "forms", "submission-correct", { submissionId: submission.id, responseValues: { name: 42 }, expectedVersion: 2, reason: "Invalid correction" }, fixedDependencies())).rejects.toThrow(/exact release type/);
  });

  it("requires exact flag approval/publication hashes, evaluates deterministically, deduplicates exposure, and suppresses winners on failed quality gates", async () => {
    const store = new MemorySuiteStore("starter");
    await store.enableModule(owner, "flags");
    const project = firstRecord(await executeSuiteAction(store, owner, "flags", "project-create", { name: "Exact flags" }, fixedDependencies()));
    const drafted = await executeSuiteAction(store, owner, "flags", "flag-draft", {
      projectId: project.id,
      environmentKey: "production",
      key: "checkout-v2",
      valueType: "boolean",
      safeValue: false,
      variants: [{ key: "control", value: false, weight: 5_000 }, { key: "treatment", value: true, weight: 5_000 }],
      rules: [],
    }, fixedDependencies());
    if (drafted.kind !== "command") throw new Error("Expected a flag draft command.");
    const revision = drafted.records.find((record) => record.recordType === "config-revision")!;
    const flag = drafted.records.find((record) => record.recordType === "flag")!;
    await expect(executeSuiteAction(store, owner, "flags", "revision-approve", { revisionId: revision.id, contentHash: "0".repeat(64) }, fixedDependencies())).rejects.toThrow(/approval hash/);
    const contentHash = String(revision.data.contentHash);
    await executeSuiteAction(store, owner, "flags", "revision-approve", { revisionId: revision.id, contentHash }, fixedDependencies());
    await expect(executeSuiteAction(store, owner, "flags", "revision-publish", { revisionId: revision.id, contentHash, baseVersion: 1, idempotencyKey: "publish-stale-base-0001" }, fixedDependencies())).rejects.toThrow(/base version/);
    await executeSuiteAction(store, owner, "flags", "revision-publish", { revisionId: revision.id, contentHash, baseVersion: 0, idempotencyKey: "publish-exact-flag-0001" }, fixedDependencies());

    const evaluationInput = { projectId: project.id, environmentKey: "production", flagKey: "checkout-v2", expectedType: "boolean", defaultValue: false, context: {}, subjectKey: "subject-101" };
    const firstEvaluationResult = await executeSuiteAction(store, owner, "flags", "evaluate", evaluationInput, fixedDependencies());
    const firstEvaluation = commandAudit(firstEvaluationResult);
    const secondEvaluation = commandAudit(await executeSuiteAction(store, owner, "flags", "evaluate", evaluationInput, fixedDependencies()));
    expect(secondEvaluation).toMatchObject({ value: firstEvaluation.value, variant: firstEvaluation.variant, reason: firstEvaluation.reason, revisionId: revision.id, rawContextStored: false });
    expect(commandAudit(await executeSuiteAction(store, owner, "flags", "evaluation-explain", { receiptId: firstRecord(firstEvaluationResult).id }, fixedDependencies()))).toMatchObject({ revisionId: revision.id, flagKey: "checkout-v2", reason: firstEvaluation.reason, rawContextIncluded: false });

    const experiment = firstRecord(await executeSuiteAction(store, owner, "flags", "experiment-draft", { projectId: project.id, flagId: flag.id, hypothesis: "The treatment improves completion", variants: ["control", "treatment"], weights: [5_000, 5_000], minimumSample: 100, minimumDurationHours: 24 }, fixedDependencies()));
    await executeSuiteAction(store, owner, "flags", "experiment-start", { experimentId: experiment.id, expectedVersion: 1, contentHash: experiment.data.contentHash }, fixedDependencies());
    const firstExposure = firstRecord(await executeSuiteAction(store, owner, "flags", "exposure-record", { experimentId: experiment.id, subjectKey: "subject-101", variant: "control", sourceEventId: "exposure-event-0001" }, fixedDependencies()));
    const replayExposure = firstRecord(await executeSuiteAction(store, owner, "flags", "exposure-record", { experimentId: experiment.id, subjectKey: "subject-101", variant: "control", sourceEventId: "exposure-event-0001" }, fixedDependencies()));
    expect(replayExposure.id).toBe(firstExposure.id);
    await executeSuiteAction(store, owner, "flags", "exposure-record", { experimentId: experiment.id, subjectKey: "subject-101", variant: "treatment", sourceEventId: "exposure-event-0002" }, fixedDependencies());
    const analysis = commandAudit(await executeSuiteAction(store, owner, "flags", "experiment-analyze", { experimentId: experiment.id }, fixedDependencies("2026-08-25T17:00:00.000Z")));
    expect(analysis).toMatchObject({ status: "invalidated", winner: null, causalClaim: false, gates: { minimumSample: false, minimumDuration: true, singleVariantExposure: false } });
    expect(analysis.warnings).toEqual(expect.arrayContaining(["minimumSample", "singleVariantExposure"]));
  });
});
