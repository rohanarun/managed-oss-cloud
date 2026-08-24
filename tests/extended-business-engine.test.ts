import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  additiveWaveTwoActions,
  additiveWaveTwoActionsByModule,
  additiveWaveTwoModules,
  type AdditiveWaveTwoModuleId,
} from "../src/shared/extended-business-actions.js";
import { suiteModuleById, type SuiteModuleDefinition } from "../src/shared/suite.js";
import {
  executeExtendedBusinessAction,
  extendedBusinessBoundedScanLimit,
  extendedBusinessDigest,
  type ExtendedBusinessAuthorization,
  type ExtendedBusinessStore,
  type ExtendedExternalEvidenceRequest,
} from "../src/server/extended-business-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const moduleIds: AdditiveWaveTwoModuleId[] = ["events", "people", "metering", "assurance", "live"];
const insertedModules: string[] = [];
const fixedNow = new Date("2026-08-24T16:00:00.000Z");
const deps = {
  now: () => fixedNow,
  modelPolicyId: "local/grounded",
  verifyExternalEvidence: async (request: ExtendedExternalEvidenceRequest) => ({
    verified: true as const,
    verifierId: "test-hosting-adapter",
    verificationId: `verified:${request.kind}:${request.evidenceHash.slice(0, 16)}`,
    verifiedAt: request.requestedAt,
    evidenceHash: request.evidenceHash,
  }),
};

beforeAll(() => {
  for (const module of additiveWaveTwoModules) {
    if (suiteModuleById.has(module.id)) continue;
    const actionRecordTypes = additiveWaveTwoActionsByModule.get(module.id)!.map((action) => action.recordType);
    const definition: SuiteModuleDefinition = {
      id: module.id,
      name: module.name,
      inspiredBy: "Original clean-room first-party design",
      category: module.category,
      description: module.originalProductThesis,
      minPlan: module.minPlan,
      resourceClass: module.resource.class,
      recordTypes: [...new Set([...actionRecordTypes, "extended-business-command-receipt", "ai-proposal-request"])],
      aiCapabilities: [...module.aiNativeQualities],
    };
    suiteModuleById.set(module.id, definition);
    insertedModules.push(module.id);
  }
});

afterAll(() => {
  for (const moduleId of insertedModules) suiteModuleById.delete(moduleId);
});

function key(label: string) { return `${label}.idempotency.0001`; }
function approval(auth: ExtendedBusinessAuthorization, label: string, approvedAt = fixedNow) {
  return { approved: true as const, approvedBy: auth.userId, approvedAt: approvedAt.toISOString(), decisionId: `${label}.approval.0001`, reason: `Reviewed the exact ${label} evidence and effect.` };
}

async function actor(store: MemorySuiteStore, plan: "scale" | "fleet", enabled: AdditiveWaveTwoModuleId[] = moduleIds) {
  const userId = randomUUID();
  const workspace = await store.getOrCreateWorkspace(userId);
  await store.setWorkspacePlan(userId, plan);
  for (const moduleId of enabled) await store.enableModule(userId, moduleId);
  const current = await store.getOrCreateWorkspace(userId);
  return { userId, workspaceId: workspace.id, role: current.currentRole!, scopes: ["*"] } satisfies ExtendedBusinessAuthorization;
}

async function member(store: MemorySuiteStore, owner: ExtendedBusinessAuthorization, role: "admin" | "member" | "viewer" = "member") {
  const userId = randomUUID();
  await store.addWorkspaceMember(owner.userId, userId, role);
  const workspace = await store.getOrCreateWorkspace(userId);
  return { userId, workspaceId: workspace.id, role: workspace.currentRole!, scopes: ["*"] } satisfies ExtendedBusinessAuthorization;
}

async function run(store: MemorySuiteStore, auth: ExtendedBusinessAuthorization, moduleId: AdditiveWaveTwoModuleId, actionId: string, input: Record<string, unknown>) {
  return executeExtendedBusinessAction(store, auth, moduleId, actionId, input, deps);
}

async function runAt(store: MemorySuiteStore, auth: ExtendedBusinessAuthorization, moduleId: AdditiveWaveTwoModuleId, actionId: string, input: Record<string, unknown>, at: string) {
  return executeExtendedBusinessAction(store, auth, moduleId, actionId, input, { ...deps, now: () => new Date(at) });
}

function first(result: Awaited<ReturnType<typeof executeExtendedBusinessAction>>) {
  const record = result.records[0];
  if (!record) throw new Error("Expected a result record.");
  return record;
}

function resultRecord(result: Awaited<ReturnType<typeof executeExtendedBusinessAction>>, recordType: string) {
  const record = result.records.find((candidate) => candidate.recordType === recordType);
  if (!record) throw new Error(`Expected ${recordType}.`);
  return record;
}

function expectStrictObjects(schema: Record<string, unknown>) {
  if (schema.type === "object" && schema.properties) {
    expect(schema.additionalProperties).toBe(false);
    for (const property of Object.values(schema.properties as Record<string, Record<string, unknown>>)) expectStrictObjects(property);
  }
  if (schema.type === "array" && schema.items && typeof schema.items === "object") expectStrictObjects(schema.items as Record<string, unknown>);
}

describe("extended clean-room business modules", () => {
  it("publishes the researched typed CLI and MCP surface with plan and safety metadata", () => {
    const expected: Record<AdditiveWaveTwoModuleId, string[]> = {
      events: ["create-draft", "publish-release", "define-ticket-type", "reserve-tickets", "create-checkout", "record-payment", "issue-ticket", "request-refund", "record-refund", "check-in", "propose-attendee-update", "summarize"],
      people: ["create-profile", "start-onboarding", "publish-policy", "acknowledge-policy", "request-leave", "decide-leave", "record-attendance", "correct-attendance", "open-review", "submit-review", "propose-growth-plan", "record-access-revocation", "offboard"],
      metering: ["create-meter", "ingest-event", "aggregate-usage", "propose-plan", "publish-plan", "preview-charge", "create-subscription", "grant-credit", "draft-invoice", "finalize-invoice", "record-payment", "explain-invoice"],
      assurance: ["create-program", "register-subject", "create-risk", "publish-control", "map-control", "request-evidence", "attach-evidence", "test-control", "propose-gap", "approve-remediation", "record-exception", "export-audit-pack"],
      live: ["create-session", "issue-presenter-grant", "issue-attendee-access", "record-media-consent", "start-broadcast", "update-broadcast", "send-chat", "moderate-chat", "open-prompt", "submit-response", "end-broadcast", "build-replay"],
    };
    expect(additiveWaveTwoActions).toHaveLength(61);
    for (const module of additiveWaveTwoModules) {
      expect(additiveWaveTwoActionsByModule.get(module.id)!.map((action) => action.id)).toEqual(expected[module.id]);
      expect(module.dataPlane).toBe("workspace-shared");
      expect(module.minPlan).toBe(["events", "people"].includes(module.id) ? "scale" : "fleet");
      expect(module.resource.class).toBe(["metering", "live"].includes(module.id) ? "accelerated" : "high");
    }
    for (const action of additiveWaveTwoActions) {
      expect(action.mcpToolName).toBe(`${action.moduleId}_${action.id.replaceAll("-", "_")}`);
      expect(action.cliExample).toContain(`supersuite action ${action.moduleId} ${action.id}`);
      expectStrictObjects(action.inputSchema as unknown as Record<string, unknown>);
      if (action.operation !== "read") expect(action.inputSchema.required).toContain("idempotencyKey");
      if (action.requiresApproval) {
        expect(action.supportsDryRun).toBe(true);
        expect(action.minimumRole === "admin" || action.minimumRole === "owner").toBe(true);
        expect(action.inputSchema.required).toContain("dryRun");
      }
      if (action.operation === "ai") {
        expect(action).toMatchObject({ effectBoundary: "proposal-only", externalEffect: "model", promptId: `${action.moduleId}.${action.id}`, promptVersion: "2026-08-24.1" });
        expect(action.inputSchema.required).not.toContain("modelId");
        expect(action.exampleInput).not.toHaveProperty("modelId");
        expect(action.inputSchema.properties.modelId).toMatchObject({ description: expect.stringContaining("Optional expected workspace-configured model identifier") });
      }
    }
    for (const actionId of ["record-payment", "record-refund", "check-in"]) expect(additiveWaveTwoActions.find((action) => action.moduleId === "events" && action.id === actionId)?.requiresApproval).toBe(true);
    for (const actionId of ["decide-leave", "correct-attendance", "offboard"]) expect(additiveWaveTwoActions.find((action) => action.moduleId === "people" && action.id === actionId)?.requiresApproval).toBe(true);
    for (const actionId of ["issue-presenter-grant", "issue-attendee-access", "moderate-chat"]) expect(additiveWaveTwoActions.find((action) => action.moduleId === "live" && action.id === actionId)?.requiresApproval).toBe(true);
  });

  it("enforces Scale versus Fleet entitlements and enabled-module scope before persistence", async () => {
    const scaleStore = new MemorySuiteStore("scale");
    const scale = await actor(scaleStore, "scale", ["events", "people", "metering"]);
    const event = await run(scaleStore, scale, "events", "create-draft", { key: "scale-event", title: "Scale event", purpose: "Test entitlement", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T15:00:00.000Z", timeZone: "UTC", venueMode: "online", venue: "Hosted room", capacity: 50, idempotencyKey: key("scale-event") });
    expect(first(event).recordType).toBe("event");
    await expect(run(scaleStore, scale, "metering", "create-meter", { key: "calls", name: "Calls", unit: "request", aggregation: "sum", eventKey: "call", dimensionKeys: [], idempotencyKey: key("scale-meter") })).rejects.toThrow(/fleet plan/);

    const fleetStore = new MemorySuiteStore("fleet");
    const fleet = await actor(fleetStore, "fleet", ["metering"]);
    const meter = await run(fleetStore, fleet, "metering", "create-meter", { key: "calls", name: "Calls", unit: "request", aggregation: "sum", eventKey: "call", dimensionKeys: [], idempotencyKey: key("fleet-meter") });
    expect(first(meter).recordType).toBe("usage-meter");
    await expect(run(fleetStore, { ...fleet, scopes: ["metering:read"] }, "metering", "ingest-event", { meterId: first(meter).id, sourceEventId: "source-42", subjectRef: "customer-42", quantity: 1, occurredAt: fixedNow.toISOString(), dimensions: {}, sourceAttestation: "batch-42", idempotencyKey: key("bad-scope") })).rejects.toThrow(/metering:write scope/);
  });

  it("runs ticket inventory, verified money receipts, access issuance, and exact-once replay without provider calls", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["events"]);
    const draft = first(await run(store, auth, "events", "create-draft", { key: "summit", title: "Summit", purpose: "Customer learning", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z", timeZone: "America/New_York", venueMode: "hybrid", venue: "Main hall", capacity: 100, idempotencyKey: key("event") }));
    const publishDry = await run(store, auth, "events", "publish-release", { eventId: draft.id, expectedVersion: 1, releaseHash: "0".repeat(64), dryRun: true, idempotencyKey: key("publish-dry") });
    expect(publishDry.audit).toMatchObject({ dryRun: true, providerCallStarted: false, autonomousSideEffect: false });
    const releaseHash = String(publishDry.audit.expectedReleaseHash);
    const published = await run(store, auth, "events", "publish-release", { eventId: draft.id, expectedVersion: 1, releaseHash, dryRun: false, approval: approval(auth, "publish"), idempotencyKey: key("publish") });
    expect(resultRecord(published, "event").state).toBe("published");
    const ticketType = resultRecord(await run(store, auth, "events", "define-ticket-type", { eventId: draft.id, key: "general", name: "General", priceMinor: 2500, currency: "USD", quantity: 2, salesStartAt: "2026-08-24T00:00:00.000Z", salesEndAt: "2026-09-01T13:00:00.000Z", idempotencyKey: key("ticket-type") }), "ticket-type");
    const reservationInput = { ticketTypeId: ticketType.id, customerRef: "customer-42", quantity: 2, expiresAt: "2026-08-25T16:00:00.000Z", idempotencyKey: key("reservation") };
    const reservationResult = await run(store, auth, "events", "reserve-tickets", reservationInput);
    const replayed = await run(store, auth, "events", "reserve-tickets", reservationInput);
    expect(first(replayed).id).toBe(first(reservationResult).id);
    expect(replayed.audit).toMatchObject({ replayed: true });
    const reservation = first(reservationResult);
    await expect(run(store, auth, "events", "reserve-tickets", { ...reservationInput, quantity: 1, idempotencyKey: key("sold-out") })).rejects.toThrow(/available inventory/);
    const checkout = first(await run(store, auth, "events", "create-checkout", { reservationId: reservation.id, expectedAmountMinor: 5000, currency: "USD", returnUrl: "https://events.example.test/complete", dryRun: false, approval: approval(auth, "checkout"), idempotencyKey: key("checkout") }));
    const paymentAt = "2026-08-24T17:00:00.000Z";
    const payment = resultRecord(await runAt(store, auth, "events", "record-payment", { checkoutId: checkout.id, provider: "payment-provider", providerReceiptId: "pay-42", amountMinor: 5000, currency: "USD", paidAt: paymentAt, dryRun: false, approval: approval(auth, "payment", new Date(paymentAt)), idempotencyKey: key("payment") }, paymentAt), "payment-receipt");
    const lateReplay = await run(store, auth, "events", "reserve-tickets", reservationInput);
    expect(first(lateReplay)).toMatchObject({ id: reservation.id, state: "reserved" });
    expect((await store.getRecord(auth.userId, reservation.id))?.state).toBe("paid");
    const ticket = first(await run(store, auth, "events", "issue-ticket", { paymentReceiptId: payment.id, reservationId: reservation.id, attendeeRef: "attendee-42", ordinal: 1, dryRun: false, approval: approval(auth, "ticket"), idempotencyKey: key("ticket") }));
    const checkInAt = "2026-09-01T13:45:00.000Z";
    const checkIn = await runAt(store, auth, "events", "check-in", { ticketId: ticket.id, gate: "Main entrance", checkedInAt: checkInAt, scannerReceiptId: "scan-42", dryRun: false, approval: approval(auth, "check-in", new Date(checkInAt)), idempotencyKey: key("check-in") }, checkInAt);
    expect(resultRecord(checkIn, "ticket").state).toBe("checked-in");
    expect(checkIn.audit).toMatchObject({ providerCallStarted: false, autonomousSideEffect: false, approvalDecisionId: "check-in.approval.0001" });
  });

  it("requires fresh single-use approval decisions and rejects duplicate checkout or payment paths", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["events"]);
    const draft = first(await run(store, auth, "events", "create-draft", { key: "approval-event", title: "Approval event", purpose: "Verify approval freshness", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z", timeZone: "UTC", venueMode: "online", venue: "Hosted room", capacity: 2, idempotencyKey: key("approval-event") }));
    expect(await store.findCommandReceipt(auth.userId, { recordType: "extended-business-command-receipt", moduleId: "events", actionId: "create-draft", idempotencyKey: key("approval-event") })).toMatchObject({ data: { approvalDecisionId: null } });
    const preview = await run(store, auth, "events", "publish-release", { eventId: draft.id, expectedVersion: 1, releaseHash: "0".repeat(64), dryRun: true, idempotencyKey: key("approval-preview") });
    const releaseHash = String(preview.audit.expectedReleaseHash);
    const staleApproval = { ...approval(auth, "stale-release"), approvedAt: "2026-08-22T15:59:59.999Z" };
    const futureApproval = { ...approval(auth, "future-release"), approvedAt: "2026-08-24T16:00:00.001Z" };
    await expect(run(store, auth, "events", "publish-release", { eventId: draft.id, expectedVersion: 1, releaseHash, dryRun: false, approval: staleApproval, idempotencyKey: key("stale-release") })).rejects.toThrow(/stale/);
    await expect(run(store, auth, "events", "publish-release", { eventId: draft.id, expectedVersion: 1, releaseHash, dryRun: false, approval: futureApproval, idempotencyKey: key("future-release") })).rejects.toThrow(/future-dated/);
    const additiveDecision = approval(auth, "foreign-additive-release");
    expect(await store.createRecord(auth.userId, { moduleId: "events", recordType: "additive-command-receipt", title: "Foreign additive receipt", state: "committed", data: { actionId: "import-apply", idempotencyKey: key("foreign-additive-receipt"), approvalDecisionId: additiveDecision.decisionId, result: { audit: { approvalDecisionId: additiveDecision.decisionId } } } })).toBeDefined();
    await expect(run(store, auth, "events", "publish-release", { eventId: draft.id, expectedVersion: 1, releaseHash, dryRun: false, approval: additiveDecision, idempotencyKey: key("foreign-additive-release") })).rejects.toThrow(/decision ID is already bound/);
    const committedApproval = approval(auth, "single-use-release");
    await run(store, auth, "events", "publish-release", { eventId: draft.id, expectedVersion: 1, releaseHash, dryRun: false, approval: committedApproval, idempotencyKey: key("single-use-release") });
    expect(await store.findCommandReceipt(auth.userId, { recordType: "extended-business-command-receipt", moduleId: "events", actionId: "publish-release", idempotencyKey: key("single-use-release") })).toMatchObject({ data: { approvalDecisionId: committedApproval.decisionId, resultSnapshot: { audit: { approvalDecisionId: committedApproval.decisionId } } } });
    const ticketType = resultRecord(await run(store, auth, "events", "define-ticket-type", { eventId: draft.id, key: "single", name: "Single", priceMinor: 1200, currency: "USD", quantity: 2, salesStartAt: "2026-08-24T00:00:00.000Z", salesEndAt: "2026-09-01T13:00:00.000Z", idempotencyKey: key("single-ticket-type") }), "ticket-type");
    const reservation = first(await run(store, auth, "events", "reserve-tickets", { ticketTypeId: ticketType.id, customerRef: "customer-approval", quantity: 1, expiresAt: "2026-08-25T16:00:00.000Z", idempotencyKey: key("single-reservation") }));
    const checkoutInput = { reservationId: reservation.id, expectedAmountMinor: 1200, currency: "USD", returnUrl: "https://events.example.test/approval", dryRun: false };
    await expect(run(store, auth, "events", "create-checkout", { ...checkoutInput, approval: committedApproval, idempotencyKey: key("reused-decision") })).rejects.toThrow(/already bound/);
    const checkout = first(await run(store, auth, "events", "create-checkout", { ...checkoutInput, approval: approval(auth, "first-checkout"), idempotencyKey: key("first-checkout") }));
    await expect(run(store, auth, "events", "create-checkout", { ...checkoutInput, approval: approval(auth, "second-checkout"), idempotencyKey: key("second-checkout") })).rejects.toThrow(/already has an active or paid checkout/);
    const paymentInput = { checkoutId: checkout.id, provider: "payment-provider", providerReceiptId: "single-payment-receipt", amountMinor: 1200, currency: "USD", paidAt: "2026-08-24T16:00:00.000Z", dryRun: false };
    await run(store, auth, "events", "record-payment", { ...paymentInput, approval: approval(auth, "first-payment"), idempotencyKey: key("first-payment") });
    await expect(run(store, auth, "events", "record-payment", { ...paymentInput, providerReceiptId: "second-payment-receipt", approval: approval(auth, "second-payment"), idempotencyKey: key("second-payment") })).rejects.toThrow(/no longer active/);
  });

  it("keeps employment decisions human and AI growth output proposal-only", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["people"]);
    const person = await member(store, auth);
    const profile = first(await run(store, auth, "people", "create-profile", { employeeRef: person.userId, displayName: "Avery", employmentType: "employee", startDate: "2026-09-01", managerRef: auth.userId, privacy: "people-team", idempotencyKey: key("profile") }));
    const leaveInput = { profileId: profile.id, leaveKind: "vacation", startsOn: "2026-09-10", endsOn: "2026-09-12", note: "Planned time away", subjectReceiptId: "leave-request-42", idempotencyKey: key("leave") };
    await expect(run(store, auth, "people", "request-leave", leaveInput)).rejects.toThrow(/authenticated person/);
    const leave = first(await run(store, person, "people", "request-leave", leaveInput));
    await expect(run(store, auth, "people", "decide-leave", { requestId: leave.id, decision: "approved", rationale: "Coverage confirmed", decisionReceiptId: "leave-decision-42", dryRun: false, idempotencyKey: key("leave-decision-no-approval") })).rejects.toThrow(/human approval/);
    const decision = await run(store, auth, "people", "decide-leave", { requestId: leave.id, decision: "approved", rationale: "Coverage confirmed", decisionReceiptId: "leave-decision-42", dryRun: false, approval: approval(auth, "leave-decision"), idempotencyKey: key("leave-decision") });
    expect(resultRecord(decision, "leave-decision").data).toMatchObject({ decision: "approved", decidedBy: auth.userId });
    const proposal = await run(store, auth, "people", "propose-growth-plan", { profileId: profile.id, goal: "Propose optional development opportunities.", evidenceIds: [leave.id], modelId: "local/grounded", idempotencyKey: key("growth-proposal") });
    expect(proposal.kind).toBe("ai-action");
    expect(proposal.aiAction?.context).toMatchObject({ evidenceBindings: [{ recordId: leave.id, version: 1 }], targetRecordId: profile.id, targetVersion: 1 });
    expect(first(proposal).data).toMatchObject({ evidenceBindings: [{ recordId: leave.id, version: 1 }], targetRecordId: profile.id, targetVersion: 1 });
    expect((await store.getRecord(auth.userId, profile.id))?.state).toBe("active");
    const revokedAt = "2026-09-30T20:45:00.000Z";
    const access = first(await runAt(store, auth, "people", "record-access-revocation", { profileId: profile.id, system: "identity-provider", accountRef: person.userId, sourceReceiptId: "identity-revocation-42", revokedAt, dryRun: false, approval: approval(auth, "access-revocation", new Date(revokedAt)), idempotencyKey: key("access-revocation") }, revokedAt));
    const offboardAt = "2026-09-30T21:00:00.000Z";
    await expect(runAt(store, auth, "people", "offboard", { profileId: profile.id, effectiveAt: offboardAt, reason: "Approved contract completion", employmentDecisionReceiptId: "wrong.approval.0001", accessRevocationReceiptIds: [access.id], dryRun: false, approval: approval(auth, "offboarding-wrong", new Date(offboardAt)), idempotencyKey: key("offboard-wrong") }, offboardAt)).rejects.toThrow(/exact attributable employment approval/);
    const offboarded = await runAt(store, auth, "people", "offboard", { profileId: profile.id, effectiveAt: offboardAt, reason: "Approved contract completion", employmentDecisionReceiptId: "offboarding.approval.0001", accessRevocationReceiptIds: [access.id], dryRun: false, approval: approval(auth, "offboarding", new Date(offboardAt)), idempotencyKey: key("offboard") }, offboardAt);
    expect(resultRecord(offboarded, "people-profile").state).toBe("offboarded");
    expect(resultRecord(offboarded, "offboarding-receipt").data).toMatchObject({ subjectUserId: person.userId, managerRef: auth.userId });
    expect(offboarded.audit).toMatchObject({ accessReceiptsVerified: 1, approvalDecisionId: "offboarding.approval.0001" });
    expect((await store.listWorkspaceMembers(auth.userId)).map((member) => member.userId)).not.toContain(person.userId);
  });

  it("requires an exact workspace member as the onboarding owner before preview or persistence", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["people"]);
    const employee = await member(store, owner);
    const onboardingOwner = await member(store, owner);
    const otherTenant = await actor(store, "fleet", ["people"]);
    const profile = first(await run(store, owner, "people", "create-profile", { employeeRef: employee.userId, displayName: "Onboarding employee", employmentType: "employee", startDate: "2026-09-01", managerRef: owner.userId, privacy: "people-team", idempotencyKey: key("onboarding-profile") }));
    const onboarding = { profileId: profile.id, dueAt: "2026-09-05T17:00:00.000Z", checklist: [{ key: "security", title: "Complete security briefing" }] };

    await expect(run(store, owner, "people", "start-onboarding", { ...onboarding, ownerRef: randomUUID(), dryRun: true, idempotencyKey: key("onboarding-missing-owner") })).rejects.toThrow(/ownerRef must be an authenticated member/);
    await expect(run(store, owner, "people", "start-onboarding", { ...onboarding, ownerRef: otherTenant.userId, dryRun: false, approval: approval(owner, "onboarding-cross-tenant"), idempotencyKey: key("onboarding-cross-tenant") })).rejects.toThrow(/ownerRef must be an authenticated member/);
    expect(await store.listRecords(owner.userId, { moduleId: "people", recordType: "onboarding", limit: 10 })).toHaveLength(0);

    const preview = await run(store, owner, "people", "start-onboarding", { ...onboarding, ownerRef: onboardingOwner.userId, dryRun: true, idempotencyKey: key("onboarding-member-preview") });
    expect(preview.audit).toMatchObject({ dryRun: true, wouldPersist: false, profileId: profile.id, checklistItems: 1 });
    expect(await store.listRecords(owner.userId, { moduleId: "people", recordType: "onboarding", limit: 10 })).toHaveLength(0);
    const started = first(await run(store, owner, "people", "start-onboarding", { ...onboarding, ownerRef: onboardingOwner.userId, dryRun: false, approval: approval(owner, "onboarding-member"), idempotencyKey: key("onboarding-member") }));
    expect(started.data).toMatchObject({ profileId: profile.id, subjectUserId: employee.userId, ownerRef: onboardingOwner.userId, employmentDecisionMade: false });
  });

  it("reapplies PeopleWeave visibility to targets and AI or human evidence inside trusted transactions", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["people"]);
    await store.enableModule(owner.userId, "assistant");
    const admin = await member(store, owner, "admin");
    const subject = await member(store, owner);
    const outsider = await member(store, owner);
    const subjectProfile = first(await run(store, owner, "people", "create-profile", { employeeRef: subject.userId, displayName: "Subject employee", employmentType: "employee", startDate: "2026-08-01", managerRef: owner.userId, privacy: "manager-and-person", idempotencyKey: key("visibility-subject-profile") }));
    const outsiderProfile = first(await run(store, owner, "people", "create-profile", { employeeRef: outsider.userId, displayName: "Outside employee", employmentType: "employee", startDate: "2026-08-01", managerRef: owner.userId, privacy: "manager-and-person", idempotencyKey: key("visibility-outsider-profile") }));
    const leave = first(await run(store, subject, "people", "request-leave", { profileId: subjectProfile.id, leaveKind: "personal", startsOn: "2026-09-10", endsOn: "2026-09-10", note: "Private subject note", subjectReceiptId: "visibility-leave-receipt", idempotencyKey: key("visibility-leave") }));
    const attendance = first(await run(store, subject, "people", "record-attendance", { profileId: subjectProfile.id, clockInAt: "2026-08-24T13:00:00.000Z", clockOutAt: "2026-08-24T15:00:00.000Z", source: "subject-entry", sourceReceiptId: "visibility-attendance-receipt", idempotencyKey: key("visibility-attendance") }));
    const subjectReview = first(await run(store, owner, "people", "open-review", { profileId: subjectProfile.id, cycleKey: "visibility-subject", reviewerRef: subject.userId, dueAt: "2026-12-01T17:00:00.000Z", rubric: [{ key: "delivery", question: "What outcomes are supported?" }], idempotencyKey: key("visibility-subject-review") }));
    const outsiderReview = first(await run(store, owner, "people", "open-review", { profileId: outsiderProfile.id, cycleKey: "visibility-outsider", reviewerRef: outsider.userId, dueAt: "2026-12-01T17:00:00.000Z", rubric: [{ key: "delivery", question: "What outcomes are supported?" }], idempotencyKey: key("visibility-outsider-review") }));
    const assistantEvidence = await store.createRecord(owner.userId, { moduleId: "assistant", recordType: "source-attachment", title: "Subject-only assistant evidence", state: "active", data: { createdByUserId: subject.userId, sourceSnapshotHash: "a".repeat(64) } });
    if (!assistantEvidence) throw new Error("Expected assistant evidence record.");

    await expect(run(store, outsider, "people", "propose-growth-plan", { profileId: subjectProfile.id, goal: "Must not expose another employee.", evidenceIds: [outsiderProfile.id], modelId: "local/grounded", idempotencyKey: key("visibility-hidden-target") })).rejects.toThrow(/profile not found/);

    const hiddenEvidence = [
      ["leave", leave],
      ["review", subjectReview],
      ["attendance", attendance],
      ["assistant", assistantEvidence],
    ] as const;
    for (const [label, evidence] of hiddenEvidence) {
      await expect(run(store, outsider, "people", "propose-growth-plan", { profileId: outsiderProfile.id, goal: `Must not bind hidden ${label} evidence.`, evidenceIds: [evidence.id], modelId: "local/grounded", idempotencyKey: key(`visibility-ai-${label}`) })).rejects.toThrow(/evidenceIds not found/);
      await expect(run(store, outsider, "people", "submit-review", { reviewId: outsiderReview.id, submittedBy: outsider.userId, responses: [{ criterionKey: "delivery", response: "Human-authored response." }], evidenceIds: [evidence.id], submissionReceiptId: `visibility-human-${label}-receipt`, idempotencyKey: key(`visibility-human-${label}`) })).rejects.toThrow(/evidenceIds not found/);
    }

    const allEvidenceIds = hiddenEvidence.map(([, evidence]) => evidence.id);
    for (const [label, privileged] of [["owner", owner], ["admin", admin]] as const) {
      const proposal = await run(store, privileged, "people", "propose-growth-plan", { profileId: subjectProfile.id, goal: `Privileged ${label} evidence review.`, evidenceIds: allEvidenceIds, modelId: "local/grounded", idempotencyKey: key(`visibility-${label}-proposal`) });
      expect(proposal.aiAction?.context.evidenceBindings).toEqual(expect.arrayContaining(allEvidenceIds.map((recordId) => expect.objectContaining({ recordId }))));
      expect(proposal.aiAction?.context).toMatchObject({ targetRecordId: subjectProfile.id });

      const privilegedReview = first(await run(store, owner, "people", "open-review", { profileId: subjectProfile.id, cycleKey: `visibility-${label}-human`, reviewerRef: privileged.userId, dueAt: "2026-12-15T17:00:00.000Z", rubric: [{ key: "delivery", question: "What evidence is supported?" }], idempotencyKey: key(`visibility-${label}-review`) }));
      const submission = resultRecord(await run(store, privileged, "people", "submit-review", { reviewId: privilegedReview.id, submittedBy: privileged.userId, responses: [{ criterionKey: "delivery", response: "Reviewed by an authorized workspace role." }], evidenceIds: allEvidenceIds, submissionReceiptId: `visibility-${label}-submission-receipt`, idempotencyKey: key(`visibility-${label}-submission`) }), "review-submission");
      expect(submission.data.evidenceIds).toEqual(allEvidenceIds);
    }
  });

  it("binds PeopleWeave leave and review replay receipts to the authenticated member", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["people"]);
    const firstMember = await member(store, owner);
    const secondMember = await member(store, owner);
    const firstProfile = first(await run(store, owner, "people", "create-profile", { employeeRef: firstMember.userId, displayName: "First member", employmentType: "employee", startDate: "2026-08-01", managerRef: owner.userId, privacy: "manager-and-person", idempotencyKey: key("actor-first-profile") }));

    const leaveInput = { profileId: firstProfile.id, leaveKind: "vacation", startsOn: "2026-09-20", endsOn: "2026-09-21", subjectReceiptId: "actor-bound-leave-receipt", idempotencyKey: key("actor-bound-leave") };
    await run(store, firstMember, "people", "request-leave", leaveInput);
    await expect(run(store, secondMember, "people", "request-leave", leaveInput)).rejects.toThrow(/another authenticated actor/);

    const review = first(await run(store, owner, "people", "open-review", { profileId: firstProfile.id, cycleKey: "actor-bound-review", reviewerRef: firstMember.userId, dueAt: "2026-12-01T17:00:00.000Z", rubric: [{ key: "delivery", question: "What outcomes are supported?" }], idempotencyKey: key("actor-bound-open-review") }));
    const reviewInput = { reviewId: review.id, submittedBy: firstMember.userId, responses: [{ criterionKey: "delivery", response: "Human-authored response." }], evidenceIds: [firstProfile.id], submissionReceiptId: "actor-bound-review-receipt", idempotencyKey: key("actor-bound-submit-review") };
    await run(store, firstMember, "people", "submit-review", reviewInput);
    await expect(run(store, secondMember, "people", "submit-review", reviewInput)).rejects.toThrow(/another authenticated actor/);

    const receipts = await store.listRecords(owner.userId, { moduleId: "people", recordType: "extended-business-command-receipt", limit: 100 });
    expect(receipts.find((record) => record.data.idempotencyKey === leaveInput.idempotencyKey)?.data.actorUserId).toBe(firstMember.userId);
    expect(receipts.find((record) => record.data.idempotencyKey === reviewInput.idempotencyKey)?.data.actorUserId).toBe(firstMember.userId);
  });

  it("calculates usage charges deterministically and records credits, invoices, and payments as receipts", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["metering"]);
    const meter = first(await run(store, auth, "metering", "create-meter", { key: "api", name: "API calls", unit: "request", aggregation: "sum", eventKey: "api.request", dimensionKeys: ["region"], idempotencyKey: key("meter") }));
    for (const [index, quantity] of [3, 2].entries()) await run(store, auth, "metering", "ingest-event", { meterId: meter.id, sourceEventId: `source-${index}`, subjectRef: "customer-42", quantity, occurredAt: `2026-08-${String(20 + index).padStart(2, "0")}T16:00:00.000Z`, dimensions: { region: "us-east" }, sourceAttestation: `batch-${index}`, idempotencyKey: key(`usage-${index}`) });
    const aggregate = first(await run(store, auth, "metering", "aggregate-usage", { meterId: meter.id, subjectRef: "customer-42", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", idempotencyKey: key("aggregate") }));
    expect(aggregate.data.quantity).toBe(5);
    const overlappingAggregate = first(await run(store, auth, "metering", "aggregate-usage", { meterId: meter.id, subjectRef: "customer-42", periodStart: "2026-08-15T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", idempotencyKey: key("overlapping-aggregate") }));
    const terms = { key: "growth", name: "Growth", currency: "USD", interval: "monthly", meterId: meter.id, baseFeeMinor: 700, unitPriceMinor: 2 };
    const plan = first(await run(store, auth, "metering", "publish-plan", { ...terms, contentHash: extendedBusinessDigest(terms), dryRun: false, approval: approval(auth, "plan"), idempotencyKey: key("plan") }));
    const preview = await run(store, auth, "metering", "preview-charge", { planId: plan.id, aggregateIds: [aggregate.id] });
    expect(preview.audit).toMatchObject({ quantity: 5, baseFeeMinor: 700, usageFeeMinor: 10, subtotalMinor: 710, currency: "USD" });
    await expect(run(store, auth, "metering", "preview-charge", { planId: plan.id, aggregateIds: [aggregate.id, overlappingAggregate.id] })).rejects.toThrow(/must not overlap/);
    await runAt(store, auth, "metering", "ingest-event", { meterId: meter.id, sourceEventId: "unsafe-source", subjectRef: "customer-unsafe", quantity: 1_000_000_000_000, occurredAt: "2026-09-15T16:00:00.000Z", dimensions: { region: "us-east" }, sourceAttestation: "unsafe-boundary-test", idempotencyKey: key("unsafe-usage") }, "2026-09-15T16:00:00.000Z");
    const unsafeAggregate = first(await run(store, auth, "metering", "aggregate-usage", { meterId: meter.id, subjectRef: "customer-unsafe", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z", idempotencyKey: key("unsafe-aggregate") }));
    const unsafeTerms = { key: "unsafe-boundary", name: "Unsafe boundary", currency: "USD", interval: "monthly", meterId: meter.id, baseFeeMinor: 0, unitPriceMinor: 100_000_000_000 };
    const unsafePlan = first(await run(store, auth, "metering", "publish-plan", { ...unsafeTerms, contentHash: extendedBusinessDigest(unsafeTerms), dryRun: false, approval: approval(auth, "unsafe-plan"), idempotencyKey: key("unsafe-plan") }));
    await expect(run(store, auth, "metering", "preview-charge", { planId: unsafePlan.id, aggregateIds: [unsafeAggregate.id] })).rejects.toThrow(/safe minor-unit arithmetic/);
    const subscription = first(await run(store, auth, "metering", "create-subscription", { planId: plan.id, subjectRef: "customer-42", startsAt: "2026-08-01T00:00:00.000Z", billingAnchorDay: 1, agreementReceiptId: "agreement-42", dryRun: false, approval: approval(auth, "subscription"), idempotencyKey: key("subscription") }));
    const credit = first(await run(store, auth, "metering", "grant-credit", { subscriptionId: subscription.id, amountMinor: 1000, currency: "USD", reason: "Approved service credit", creditReceiptId: "credit-42", dryRun: false, approval: approval(auth, "credit"), idempotencyKey: key("credit") }));
    await expect(run(store, auth, "metering", "preview-charge", { planId: plan.id, aggregateIds: [aggregate.id, aggregate.id] })).rejects.toThrow(/duplicate record IDs/);
    const invoice = first(await run(store, auth, "metering", "draft-invoice", { subscriptionId: subscription.id, periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", aggregateIds: [aggregate.id], idempotencyKey: key("invoice") }));
    expect(invoice.data).toMatchObject({ subtotalMinor: 710, appliedCreditMinor: 710, totalMinor: 0, currency: "USD", creditAllocations: [{ creditId: credit.id, amountMinor: 710 }] });
    const finalizedResult = await run(store, auth, "metering", "finalize-invoice", { invoiceId: invoice.id, expectedVersion: 1, totalsHash: invoice.data.totalsHash, dryRun: false, approval: approval(auth, "finalize"), idempotencyKey: key("finalize") });
    const finalized = resultRecord(finalizedResult, "billing-invoice");
    expect(finalized.state).toBe("final");
    expect(resultRecord(finalizedResult, "credit-grant")).toMatchObject({ id: credit.id, state: "available", data: { remainingAmountMinor: 290 } });
    expect(resultRecord(finalizedResult, "credit-application-receipt").data).toMatchObject({ creditId: credit.id, invoiceId: invoice.id, amountMinor: 710, remainingAmountMinor: 290 });
    const invoicePaymentAt = "2026-09-02T12:00:00.000Z";
    const paid = await runAt(store, auth, "metering", "record-payment", { invoiceId: invoice.id, provider: "payment-provider", providerReceiptId: "invoice-payment-42", amountMinor: 0, currency: "USD", paidAt: invoicePaymentAt, dryRun: false, approval: approval(auth, "invoice-payment", new Date(invoicePaymentAt)), idempotencyKey: key("invoice-payment") }, invoicePaymentAt);
    expect(resultRecord(paid, "billing-invoice").state).toBe("paid");
    expect(resultRecord(paid, "invoice-payment-receipt").state).toBe("verified");
  });

  it("links read-only evidence to any tenant-owned suite record while denying cross-workspace evidence", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerA = await actor(store, "fleet", ["assurance"]);
    const ownerB = await actor(store, "fleet", ["assurance"]);
    await store.enableModule(ownerA.userId, "crm");
    const crm = await store.createRecord(ownerA.userId, { moduleId: "crm", recordType: "account", title: "Northwind", state: "active", data: { externalKey: "northwind", version: 1 } });
    if (!crm) throw new Error("Expected CRM evidence record.");
    const program = first(await run(store, ownerA, "assurance", "create-program", { key: "security", name: "Security", framework: "Internal", purpose: "Verify controls", ownerRef: ownerA.userId, periodStart: "2026-01-01", periodEnd: "2026-12-31", idempotencyKey: key("program-a") }));
    const controlHash = extendedBusinessDigest({ objective: "Accounts are reviewed", procedure: "Review account owners quarterly." });
    const control = first(await run(store, ownerA, "assurance", "publish-control", { programId: program.id, key: "account-review", title: "Account review", objective: "Accounts are reviewed", procedure: "Review account owners quarterly.", ownerRef: ownerA.userId, contentHash: controlHash, dryRun: false, approval: approval(ownerA, "control"), idempotencyKey: key("control-a") }));
    const request = first(await run(store, ownerA, "assurance", "request-evidence", { controlId: control.id, ownerRef: ownerA.userId, requirements: "Owned account record", dueAt: "2026-10-01T17:00:00.000Z", idempotencyKey: key("evidence-request-a") }));
    const linked = first(await run(store, ownerA, "assurance", "attach-evidence", { requestId: request.id, sourceRecordId: crm.id, contentHash: "a".repeat(64), observedAt: fixedNow.toISOString(), provenance: "Shared CRM record selected by the control owner", idempotencyKey: key("evidence-a") }));
    expect(linked.data).toMatchObject({ sourceRecordId: crm.id, sourceModuleId: "crm", sourceRecordType: "account" });
    expect(linked.data.sourceSnapshotHash).toBe(extendedBusinessDigest(crm));
    expect(linked.data).not.toHaveProperty("sourceData");

    const programB = first(await run(store, ownerB, "assurance", "create-program", { key: "security-b", name: "Security B", framework: "Internal", purpose: "Verify controls", ownerRef: ownerB.userId, periodStart: "2026-01-01", periodEnd: "2026-12-31", idempotencyKey: key("program-b") }));
    const controlB = first(await run(store, ownerB, "assurance", "publish-control", { programId: programB.id, key: "account-review", title: "Account review", objective: "Accounts are reviewed", procedure: "Review account owners quarterly.", ownerRef: ownerB.userId, contentHash: controlHash, dryRun: false, approval: approval(ownerB, "control-b"), idempotencyKey: key("control-b") }));
    const requestB = first(await run(store, ownerB, "assurance", "request-evidence", { controlId: controlB.id, ownerRef: ownerB.userId, requirements: "Owned account record", dueAt: "2026-10-01T17:00:00.000Z", idempotencyKey: key("evidence-request-b") }));
    await expect(run(store, ownerB, "assurance", "attach-evidence", { requestId: requestB.id, sourceRecordId: crm.id, contentHash: "a".repeat(64), observedAt: fixedNow.toISOString(), provenance: "Must fail tenant boundary", idempotencyKey: key("cross-tenant-evidence") })).rejects.toThrow(/sourceRecord not found/);
  });

  it("propagates confidential assurance lineage and keeps private audit packs from unrelated members", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["assurance"]);
    const admin = await member(store, owner, "admin");
    const steward = await member(store, owner);
    const outsider = await member(store, owner);
    const program = first(await run(store, owner, "assurance", "create-program", { key: "private-assurance", name: "Private assurance", framework: "Internal", purpose: "Protect classified evidence", ownerRef: steward.userId, periodStart: "2026-01-01", periodEnd: "2026-12-31", idempotencyKey: key("private-assurance-program") }));
    const subject = first(await run(store, steward, "assurance", "register-subject", { programId: program.id, kind: "dataset", name: "Restricted customer dataset", ownerRef: steward.userId, classification: "restricted", idempotencyKey: key("private-assurance-subject") }));
    const risk = first(await run(store, steward, "assurance", "create-risk", { programId: program.id, subjectId: subject.id, statement: "Unreviewed access could expose restricted records.", likelihood: 2, impact: 5, ownerRef: steward.userId, idempotencyKey: key("private-assurance-risk") }));
    expect(risk.data).toMatchObject({ programId: program.id, programOwnerRef: steward.userId, subjectId: subject.id, subjectOwnerRef: steward.userId, subjectClassification: "restricted", assuranceClassification: "restricted", createdByUserId: steward.userId });

    const controlHash = extendedBusinessDigest({ objective: "Restrict dataset access", procedure: "Review access with the accountable steward." });
    const control = first(await run(store, owner, "assurance", "publish-control", { programId: program.id, key: "dataset-access", title: "Dataset access", objective: "Restrict dataset access", procedure: "Review access with the accountable steward.", ownerRef: owner.userId, contentHash: controlHash, dryRun: false, approval: approval(owner, "private-control"), idempotencyKey: key("private-control") }));
    const mapping = first(await run(store, owner, "assurance", "map-control", { controlId: control.id, riskIds: [risk.id], rationale: "This control mitigates the restricted subject risk.", idempotencyKey: key("private-control-map") }));
    expect(mapping.data).toMatchObject({ programOwnerRef: steward.userId, subjectIds: [subject.id], subjectOwnerRefs: [steward.userId], subjectClassifications: ["restricted"], assuranceClassification: "restricted" });
    expect((await store.getRecord(owner.userId, control.id))?.data).toMatchObject({ subjectIds: [subject.id], subjectOwnerRefs: [steward.userId], subjectClassifications: ["restricted"], assuranceClassification: "restricted" });

    const request = first(await run(store, owner, "assurance", "request-evidence", { controlId: control.id, ownerRef: steward.userId, requirements: "Restricted access review evidence", dueAt: "2026-10-01T17:00:00.000Z", idempotencyKey: key("private-evidence-request") }));
    const evidence = first(await run(store, steward, "assurance", "attach-evidence", { requestId: request.id, sourceRecordId: risk.id, contentHash: "b".repeat(64), observedAt: fixedNow.toISOString(), provenance: "Selected by the accountable subject steward", idempotencyKey: key("private-evidence") }));
    expect(evidence.data).toMatchObject({ programOwnerRef: steward.userId, subjectClassifications: ["restricted"], assuranceClassification: "restricted", evidenceOwnerRef: steward.userId, attachedByUserId: steward.userId });
    const pack = first(await run(store, steward, "assurance", "export-audit-pack", { programId: program.id, asOf: "2026-12-31T23:59:59.000Z", recordIds: [risk.id, evidence.id], format: "canonical-json", idempotencyKey: key("private-audit-pack") }));
    expect(pack).toMatchObject({ state: "ready-private", data: { programId: program.id, programOwnerRef: steward.userId, private: true, createdByUserId: steward.userId } });

    await expect(run(store, outsider, "assurance", "propose-gap", { programId: program.id, question: "Must not expose restricted risk evidence.", evidenceIds: [risk.id], modelId: "local/grounded", idempotencyKey: key("private-risk-outsider") })).rejects.toThrow(/evidenceIds not found/);
    await expect(run(store, outsider, "assurance", "propose-gap", { programId: program.id, question: "Must not expose a private audit pack.", evidenceIds: [pack.id], modelId: "local/grounded", idempotencyKey: key("private-pack-outsider") })).rejects.toThrow(/evidenceIds not found/);

    for (const [label, authorized] of [["steward", steward], ["owner", owner], ["admin", admin]] as const) {
      const proposal = await run(store, authorized, "assurance", "propose-gap", { programId: program.id, question: `Authorized ${label} review.`, evidenceIds: [risk.id, evidence.id, pack.id], modelId: "local/grounded", idempotencyKey: key(`private-assurance-${label}`) });
      expect(proposal.aiAction?.context).toMatchObject({ programId: program.id, programOwnerRef: steward.userId, requestedByUserId: authorized.userId });
    }
  });

  it("propagates private LiveForum participants while keeping consent choices subject-private", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["live"]);
    await store.enableModule(owner.userId, "crm");
    const admin = await member(store, owner, "admin");
    const creator = await member(store, owner);
    const participant = await member(store, owner);
    const observer = await member(store, owner);
    const outsider = await member(store, owner);
    const sharedEvidence = await store.createRecord(owner.userId, { moduleId: "crm", recordType: "account", title: "Shared account", state: "active", data: { externalKey: "shared-account", version: 1 } });
    if (!sharedEvidence) throw new Error("Expected shared evidence record.");
    const session = first(await run(store, creator, "live", "create-session", { key: "private-session", title: "Private session", purpose: "Participant-only discussion", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T15:00:00.000Z", visibility: "private", recordingMode: "consent-required", idempotencyKey: key("private-live-session") }));
    expect(session.data).toMatchObject({ sessionCreatedBy: creator.userId, sessionParticipantRefs: [creator.userId] });
    const participantAccess = first(await run(store, owner, "live", "issue-attendee-access", { sessionId: session.id, attendeeRef: participant.userId, accessKind: "view-chat-and-respond", expiresAt: "2026-09-01T16:00:00.000Z", accessDecisionReceiptId: "private-participant-access", dryRun: false, approval: approval(owner, "private-participant-access"), idempotencyKey: key("private-participant-access") }));
    await run(store, owner, "live", "issue-attendee-access", { sessionId: session.id, attendeeRef: observer.userId, accessKind: "view", expiresAt: "2026-09-01T16:00:00.000Z", accessDecisionReceiptId: "private-observer-access", dryRun: false, approval: approval(owner, "private-observer-access"), idempotencyKey: key("private-observer-access") });
    const storedSession = await store.getRecord(owner.userId, session.id);
    expect(storedSession?.data.sessionParticipantRefs).toEqual(expect.arrayContaining([creator.userId, participant.userId, observer.userId]));
    expect(participantAccess.data).toMatchObject({ sessionId: session.id, sessionVisibility: "private", sessionCreatedBy: creator.userId });

    const consent = first(await run(store, participant, "live", "record-media-consent", { sessionId: session.id, participantRef: participant.userId, decision: "declined", scopes: ["record-audio"], policyVersion: "media-v1", capturedAt: fixedNow.toISOString(), subjectReceiptId: "private-media-consent", idempotencyKey: key("private-media-consent") }));
    expect(consent.data).toMatchObject({ sessionId: session.id, sessionVisibility: "private", sessionCreatedBy: creator.userId, participantRef: participant.userId, decision: "declined" });
    await expect(run(store, outsider, "live", "build-replay", { sessionId: session.id, goal: "Must not target an unjoined private session.", evidenceIds: [sharedEvidence.id], modelId: "local/grounded", idempotencyKey: key("private-session-outsider") })).rejects.toThrow(/session not found/);
    await expect(run(store, observer, "live", "build-replay", { sessionId: session.id, goal: "Must not expose another participant's consent.", evidenceIds: [consent.id], modelId: "local/grounded", idempotencyKey: key("private-consent-observer") })).rejects.toThrow(/evidenceIds not found/);

    for (const [label, authorized] of [["participant", participant], ["owner", owner], ["admin", admin]] as const) {
      const proposal = await run(store, authorized, "live", "build-replay", { sessionId: session.id, goal: `Authorized ${label} consent review.`, evidenceIds: [consent.id], modelId: "local/grounded", idempotencyKey: key(`private-live-${label}`) });
      expect(proposal.aiAction?.context).toMatchObject({ sessionId: session.id, sessionVisibility: "private", sessionCreatedBy: creator.userId, requestedByUserId: authorized.userId });
    }
  });

  it("requires access and consent receipts for live state and human approval for moderation", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["live"]);
    const attendeeAuth = await member(store, auth);
    const session = first(await run(store, auth, "live", "create-session", { key: "briefing", title: "Briefing", purpose: "Customer education", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T15:00:00.000Z", visibility: "invited-public", recordingMode: "consent-required", idempotencyKey: key("session") }));
    const presenter = first(await run(store, auth, "live", "issue-presenter-grant", { sessionId: session.id, presenterRef: auth.userId, capabilities: ["broadcast", "moderate", "prompt", "end"], expiresAt: "2026-09-01T16:00:00.000Z", accessDecisionReceiptId: "presenter-access-42", dryRun: false, approval: approval(auth, "presenter"), idempotencyKey: key("presenter") }));
    const attendee = first(await run(store, auth, "live", "issue-attendee-access", { sessionId: session.id, attendeeRef: attendeeAuth.userId, accessKind: "view-chat-and-respond", expiresAt: "2026-09-01T16:00:00.000Z", accessDecisionReceiptId: "attendee-access-42", dryRun: false, approval: approval(auth, "attendee"), idempotencyKey: key("attendee") }));
    await run(store, auth, "live", "record-media-consent", { sessionId: session.id, participantRef: auth.userId, decision: "granted", scopes: ["record-audio"], policyVersion: "media-v1", capturedAt: "2026-08-24T15:49:00.000Z", subjectReceiptId: "presenter-media-consent-42", idempotencyKey: key("presenter-consent") });
    const attendeeConsent = { sessionId: session.id, participantRef: attendeeAuth.userId, decision: "granted", scopes: ["record-audio", "publish-replay"], policyVersion: "media-v1", capturedAt: "2026-08-24T15:50:00.000Z", subjectReceiptId: "media-consent-42", idempotencyKey: key("consent") };
    await expect(run(store, auth, "live", "record-media-consent", attendeeConsent)).rejects.toThrow(/authenticated participant/);
    await expect(run(store, attendeeAuth, "live", "record-media-consent", { ...attendeeConsent, capturedAt: "2026-08-24T16:00:00.001Z", subjectReceiptId: "future-media-consent-42", idempotencyKey: key("future-consent") })).rejects.toThrow(/future subject-interaction clock/);
    await run(store, attendeeAuth, "live", "record-media-consent", attendeeConsent);
    const startDry = await run(store, auth, "live", "start-broadcast", { sessionId: session.id, expectedVersion: 1, presenterGrantId: presenter.id, startedAt: "2026-09-01T14:00:00.000Z", consentSnapshotHash: "0".repeat(64), dryRun: true, idempotencyKey: key("start-dry") });
    const consentSnapshotHash = String(startDry.audit.expectedConsentSnapshotHash);
    await run(store, auth, "live", "start-broadcast", { sessionId: session.id, expectedVersion: 1, presenterGrantId: presenter.id, startedAt: "2026-09-01T14:00:00.000Z", consentSnapshotHash, dryRun: false, approval: approval(auth, "start"), idempotencyKey: key("start") });
    await expect(run(store, auth, "live", "send-chat", { sessionId: session.id, attendeeAccessId: attendee.id, body: "Forged attendee message", sentAt: "2026-09-01T14:14:00.000Z", idempotencyKey: key("forged-chat") })).rejects.toThrow(/authenticated user/);
    const message = first(await run(store, attendeeAuth, "live", "send-chat", { sessionId: session.id, attendeeAccessId: attendee.id, body: "Could you clarify the launch date?", sentAt: "2026-09-01T14:15:00.000Z", idempotencyKey: key("chat") }));
    await expect(run(store, auth, "live", "moderate-chat", { messageId: message.id, expectedVersion: 1, moderatorGrantId: presenter.id, decision: "hide", reason: "Contains a credential", moderationReceiptId: "moderation-42", dryRun: false, idempotencyKey: key("moderate-no-approval") })).rejects.toThrow(/human approval/);
    const moderated = await run(store, auth, "live", "moderate-chat", { messageId: message.id, expectedVersion: 1, moderatorGrantId: presenter.id, decision: "hide", reason: "Contains a credential", moderationReceiptId: "moderation-42", dryRun: false, approval: approval(auth, "moderate"), idempotencyKey: key("moderate") });
    expect(resultRecord(moderated, "live-chat-message").state).toBe("hidden");
    expect(resultRecord(moderated, "chat-moderation-receipt").data).toMatchObject({ approvedBy: auth.userId, decision: "hide" });
    const prompt = first(await run(store, auth, "live", "open-prompt", { sessionId: session.id, presenterGrantId: presenter.id, question: "Choose the next topic", responseType: "single-choice", options: ["Security", "Billing"], closesAt: "2026-08-25T00:00:00.000Z", idempotencyKey: key("prompt") }));
    await expect(executeExtendedBusinessAction(store, attendeeAuth, "live", "submit-response", { promptId: prompt.id, attendeeAccessId: attendee.id, response: "Security", submittedAt: "2026-08-24T16:00:00.000Z", idempotencyKey: key("late-response") }, { ...deps, now: () => new Date("2026-08-25T00:00:00.001Z") })).rejects.toThrow(/prompt is closed/);
  });

  it("uses indexed receipt replay while retaining bounded domain scans", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["events"]);
    let indexedReceiptLookup = false;
    let receiptWideScan = false;
    let boundedDomainScan = false;
    const saturatedStore = new Proxy(store as ExtendedBusinessStore, {
      get(target, property, receiver) {
        if (property === "listRecords") return async (userId: string, input: { moduleId?: string; recordType?: string; limit: number }) => {
          if (input.recordType === "extended-business-command-receipt") receiptWideScan = true;
          if (input.moduleId === "events" && input.recordType === "event" && input.limit === extendedBusinessBoundedScanLimit + 1) boundedDomainScan = true;
          return target.listRecords(userId, input);
        };
        if (property === "findCommandReceipt") return async (userId: string, input: Parameters<ExtendedBusinessStore["findCommandReceipt"]>[1]) => {
          indexedReceiptLookup = true;
          return target.findCommandReceipt(userId, input);
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(extendedBusinessBoundedScanLimit).toBe(100_000);
    await expect(executeExtendedBusinessAction(saturatedStore, auth, "events", "create-draft", { key: "indexed", title: "Indexed", purpose: "Prove exact lookup", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T15:00:00.000Z", timeZone: "UTC", venueMode: "online", venue: "Hosted room", capacity: 50, idempotencyKey: key("indexed") }, deps)).resolves.toMatchObject({ records: [expect.objectContaining({ recordType: "event" })] });
    expect(indexedReceiptLookup).toBe(true);
    expect(receiptWideScan).toBe(false);
    expect(boundedDomainScan).toBe(true);
  });

  it("fails closed when external evidence is missing, mismatched, or future-dated", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["metering"]);
    const meter = first(await run(store, auth, "metering", "create-meter", { key: "verified-usage", name: "Verified usage", unit: "request", aggregation: "sum", eventKey: "api.request", dimensionKeys: ["region"], idempotencyKey: key("verified-usage-meter") }));
    const baseInput = { meterId: meter.id, sourceEventId: "untrusted-source", subjectRef: "customer-42", quantity: 1, occurredAt: fixedNow.toISOString(), dimensions: { region: "us-east" }, sourceAttestation: "caller-assertion", idempotencyKey: key("untrusted-usage") };

    await expect(executeExtendedBusinessAction(store, auth, "metering", "ingest-event", baseInput, {
      now: deps.now,
      modelPolicyId: deps.modelPolicyId,
    })).rejects.toThrow(/not verified by a trusted hosting-layer adapter/);

    let verifierCalls = 0;
    await expect(executeExtendedBusinessAction(store, auth, "metering", "ingest-event", { ...baseInput, sourceEventId: "mismatched-source", idempotencyKey: key("mismatched-usage") }, {
      ...deps,
      verifyExternalEvidence: async (request) => {
        verifierCalls += 1;
        return { verified: true, verifierId: "test-hosting-adapter", verificationId: "verified:mismatched-evidence", verifiedAt: request.requestedAt, evidenceHash: "0".repeat(64) };
      },
    })).rejects.toThrow(/not verified by a trusted hosting-layer adapter/);
    expect(verifierCalls).toBe(1);

    await expect(executeExtendedBusinessAction(store, auth, "metering", "ingest-event", { ...baseInput, sourceEventId: "future-source", occurredAt: "2026-08-24T16:00:00.001Z", idempotencyKey: key("future-usage") }, {
      ...deps,
      verifyExternalEvidence: async () => {
        verifierCalls += 1;
        return undefined;
      },
    })).rejects.toThrow(/source occurrence clock/);
    expect(verifierCalls).toBe(1);
    expect(await store.listRecords(auth.userId, { moduleId: "metering", recordType: "usage-event", limit: 100 })).toHaveLength(0);
    for (const idempotencyKey of [baseInput.idempotencyKey, key("mismatched-usage"), key("future-usage")]) {
      await expect(store.findCommandReceipt(auth.userId, { recordType: "extended-business-command-receipt", moduleId: "metering", actionId: "ingest-event", idempotencyKey })).resolves.toBeUndefined();
    }
  });

  it("rejects AI requests outside the workspace model policy before queueing or receipting", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store, "fleet", ["metering"]);
    const meter = first(await run(store, auth, "metering", "create-meter", { key: "model-policy", name: "Model policy", unit: "request", aggregation: "sum", eventKey: "api.request", dimensionKeys: [], idempotencyKey: key("model-policy-meter") }));
    const idempotencyKey = key("wrong-model-policy");

    await expect(run(store, auth, "metering", "propose-plan", { goal: "Propose transparent pricing.", currency: "USD", evidenceIds: [meter.id], modelId: "caller-selected-model", idempotencyKey })).rejects.toThrow(/workspace-configured model policy/);

    expect(await store.listRecords(auth.userId, { moduleId: "metering", recordType: "ai-proposal-request", limit: 100 })).toHaveLength(0);
    await expect(store.findCommandReceipt(auth.userId, { recordType: "extended-business-command-receipt", moduleId: "metering", actionId: "propose-plan", idempotencyKey })).resolves.toBeUndefined();

    const omittedModelKey = key("omitted-model-policy");
    const queued = await run(store, auth, "metering", "propose-plan", { goal: "Propose transparent pricing.", currency: "USD", evidenceIds: [meter.id], idempotencyKey: omittedModelKey });
    expect(first(queued)).toMatchObject({ recordType: "ai-proposal-request", data: { modelPolicyId: "local/grounded", requestedModelId: "local/grounded" } });
    expect(queued.aiAction).toMatchObject({ context: { modelPolicyId: "local/grounded", requestedModelId: "local/grounded" } });
    await expect(store.findCommandReceipt(auth.userId, { recordType: "extended-business-command-receipt", moduleId: "metering", actionId: "propose-plan", idempotencyKey: omittedModelKey })).resolves.toBeDefined();
  });

  it("prevents viewers from receiving employee or attendee capabilities and non-admins from receiving presenter grants", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["people", "live"]);
    const viewer = await member(store, owner, "viewer");
    const ordinaryMember = await member(store, owner, "member");

    await expect(run(store, owner, "people", "create-profile", { employeeRef: viewer.userId, displayName: "Viewer", employmentType: "employee", startDate: "2026-09-01", managerRef: owner.userId, privacy: "manager-and-person", idempotencyKey: key("viewer-profile") })).rejects.toThrow(/member role or higher/);
    const session = first(await run(store, owner, "live", "create-session", { key: "viewer-capability", title: "Viewer capability", purpose: "Verify minimum workspace roles", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T15:00:00.000Z", visibility: "workspace", recordingMode: "disabled", idempotencyKey: key("viewer-capability-session") }));
    await expect(run(store, owner, "live", "issue-attendee-access", { sessionId: session.id, attendeeRef: viewer.userId, accessKind: "view", expiresAt: "2026-09-01T16:00:00.000Z", accessDecisionReceiptId: "viewer-access-decision", dryRun: true, idempotencyKey: key("viewer-attendee-access") })).rejects.toThrow(/member role or higher/);
    await expect(run(store, owner, "live", "issue-presenter-grant", { sessionId: session.id, presenterRef: ordinaryMember.userId, capabilities: ["broadcast"], expiresAt: "2026-09-01T16:00:00.000Z", accessDecisionReceiptId: "member-presenter-decision", dryRun: true, idempotencyKey: key("member-presenter-grant") })).rejects.toThrow(/admin role or higher/);

    expect(await store.listRecords(owner.userId, { moduleId: "people", recordType: "people-profile", limit: 100 })).toHaveLength(0);
    expect(await store.listRecords(owner.userId, { moduleId: "live", recordType: "attendee-access", limit: 100 })).toHaveLength(0);
    expect(await store.listRecords(owner.userId, { moduleId: "live", recordType: "presenter-grant", limit: 100 })).toHaveLength(0);
  });

  it("scopes subject receipts per person without leaking another person's private receipt", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["people"]);
    const firstMember = await member(store, owner);
    const secondMember = await member(store, owner);
    const firstProfile = first(await run(store, owner, "people", "create-profile", { employeeRef: firstMember.userId, displayName: "First person", employmentType: "employee", startDate: "2026-08-01", managerRef: owner.userId, privacy: "manager-and-person", idempotencyKey: key("scoped-first-profile") }));
    const secondProfile = first(await run(store, owner, "people", "create-profile", { employeeRef: secondMember.userId, displayName: "Second person", employmentType: "employee", startDate: "2026-08-01", managerRef: owner.userId, privacy: "manager-and-person", idempotencyKey: key("scoped-second-profile") }));
    const sharedSubjectReceiptId = "subject-device-receipt-42";

    const firstLeave = first(await run(store, firstMember, "people", "request-leave", { profileId: firstProfile.id, leaveKind: "vacation", startsOn: "2026-09-10", endsOn: "2026-09-11", subjectReceiptId: sharedSubjectReceiptId, idempotencyKey: key("scoped-first-leave") }));
    const secondLeave = first(await run(store, secondMember, "people", "request-leave", { profileId: secondProfile.id, leaveKind: "personal", startsOn: "2026-09-12", endsOn: "2026-09-12", subjectReceiptId: sharedSubjectReceiptId, idempotencyKey: key("scoped-second-leave") }));
    expect(firstLeave.data.subjectUserId).toBe(firstMember.userId);
    expect(secondLeave.data.subjectUserId).toBe(secondMember.userId);
    await expect(run(store, secondMember, "people", "request-leave", { profileId: secondProfile.id, leaveKind: "personal", startsOn: "2026-09-13", endsOn: "2026-09-13", subjectReceiptId: sharedSubjectReceiptId, idempotencyKey: key("scoped-second-duplicate") })).rejects.toThrow(/already recorded for this person/);
  });

  it("requires unique rubric keys and one human response per exact criterion", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store, "fleet", ["people"]);
    const reviewer = await member(store, owner);
    const profile = first(await run(store, owner, "people", "create-profile", { employeeRef: reviewer.userId, displayName: "Reviewer", employmentType: "employee", startDate: "2026-08-01", managerRef: owner.userId, privacy: "manager-and-person", idempotencyKey: key("rubric-profile") }));

    await expect(run(store, owner, "people", "open-review", { profileId: profile.id, cycleKey: "duplicate-rubric", reviewerRef: reviewer.userId, dueAt: "2026-12-01T17:00:00.000Z", rubric: [{ key: "delivery", question: "What was delivered?" }, { key: "delivery", question: "What was supported?" }], idempotencyKey: key("duplicate-rubric") })).rejects.toThrow(/criterion keys must be unique/);
    const review = first(await run(store, owner, "people", "open-review", { profileId: profile.id, cycleKey: "exact-rubric", reviewerRef: reviewer.userId, dueAt: "2026-12-01T17:00:00.000Z", rubric: [{ key: "delivery", question: "What was delivered?" }, { key: "collaboration", question: "What collaboration is supported?" }], idempotencyKey: key("exact-rubric") }));
    const common = { reviewId: review.id, submittedBy: reviewer.userId, evidenceIds: [profile.id] };

    await expect(run(store, reviewer, "people", "submit-review", { ...common, responses: [{ criterionKey: "delivery", response: "Human-authored evidence." }], submissionReceiptId: "partial-review-receipt", idempotencyKey: key("partial-review") })).rejects.toThrow(/every rubric criterion exactly once/);
    await expect(run(store, reviewer, "people", "submit-review", { ...common, responses: [{ criterionKey: "delivery", response: "Human-authored evidence." }, { criterionKey: "unknown", response: "Unknown criterion." }], submissionReceiptId: "unknown-review-receipt", idempotencyKey: key("unknown-review") })).rejects.toThrow(/every rubric criterion exactly once/);
    await expect(run(store, reviewer, "people", "submit-review", { ...common, responses: [{ criterionKey: "delivery", response: "Human-authored evidence." }, { criterionKey: "delivery", response: "Duplicate criterion." }], submissionReceiptId: "duplicate-review-receipt", idempotencyKey: key("duplicate-review") })).rejects.toThrow(/every rubric criterion exactly once/);

    const submitted = resultRecord(await run(store, reviewer, "people", "submit-review", { ...common, responses: [{ criterionKey: "collaboration", response: "Supported collaboration evidence." }, { criterionKey: "delivery", response: "Supported delivery evidence." }], submissionReceiptId: "exact-review-receipt", idempotencyKey: key("exact-review") }), "review-submission");
    expect(submitted.data.responses).toHaveLength(2);
    expect(submitted.state).toBe("submitted");
  });
});
