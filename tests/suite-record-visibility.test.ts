import { describe, expect, it } from "vitest";
import {
  canReadSuiteRecord,
  type SuiteRecordReadPrincipal,
  type SuiteRecordVisibilityTarget,
} from "../src/server/suite-record-visibility.js";
import type { SuiteWorkspaceRole } from "../src/shared/suite.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "00000000-0000-4000-8000-000000000002";
const userId = "workspace-user-0001";
const otherUserId = "workspace-user-0002";

function principal(role: SuiteWorkspaceRole, overrides: Partial<SuiteRecordReadPrincipal> = {}): SuiteRecordReadPrincipal {
  return { userId, workspaceId, role, ...overrides };
}

function record(overrides: Partial<SuiteRecordVisibilityTarget> = {}): SuiteRecordVisibilityTarget {
  return {
    workspaceId,
    moduleId: "people",
    recordType: "leave-request",
    state: "active",
    data: {},
    ...overrides,
  };
}

function additiveRecord(
  moduleId: string,
  recordType: string,
  state: string,
  data: Record<string, unknown>,
  envelopeOverrides: Record<string, unknown> = {},
): SuiteRecordVisibilityTarget {
  return record({
    moduleId,
    recordType,
    state,
    data: {
      additiveContract: "additive-business-record.v1",
      record: {
        workspaceId,
        moduleId,
        recordType,
        state,
        data,
        ...envelopeOverrides,
      },
    },
  });
}

describe("suite record read visibility", () => {
  describe("tenant and role boundary", () => {
    it("preserves workspace visibility for modules without a record-level policy", () => {
      for (const role of ["viewer", "member", "admin", "owner"] as const) {
        expect(canReadSuiteRecord(principal(role), record({ moduleId: "crm", recordType: "account" }))).toBe(true);
      }
    });

    it("checks the tenant and principal before every role grant", () => {
      const target = record({ moduleId: "meetings", recordType: "meeting", data: { privacy: "workspace" } });
      expect(canReadSuiteRecord(principal("owner", { userId: "" }), target)).toBe(false);
      expect(canReadSuiteRecord(principal("owner", { userId: "   " }), target)).toBe(false);
      expect(canReadSuiteRecord(principal("owner", { workspaceId: "" }), target)).toBe(false);
      expect(canReadSuiteRecord(principal("owner"), { ...target, workspaceId: otherWorkspaceId })).toBe(false);
    });

    it("allows owners and administrators to inspect every same-tenant protected record", () => {
      const protectedRecords = [
        record({ moduleId: "people", recordType: "offboarding-receipt" }),
        record({ moduleId: "meetings", recordType: "transcript-segment" }),
        record({ moduleId: "learning", recordType: "learning-attempt" }),
        record({ moduleId: "community", recordType: "community-post", state: "hidden" }),
      ];
      for (const role of ["owner", "admin"] as const) {
        for (const target of protectedRecords) expect(canReadSuiteRecord(principal(role), target)).toBe(true);
      }
    });
  });

  describe("PeopleWeave", () => {
    it("makes only published policies workspace-wide", () => {
      const published = record({ recordType: "people-policy", state: "published" });
      for (const role of ["viewer", "member", "admin", "owner"] as const) {
        expect(canReadSuiteRecord(principal(role), published)).toBe(true);
      }
      expect(canReadSuiteRecord(principal("viewer"), { ...published, state: "draft" })).toBe(false);
      expect(canReadSuiteRecord(principal("member"), { ...published, state: "retired" })).toBe(false);
    });

    it.each([
      ["people-profile", "employeeRef"],
      ["onboarding", "subjectUserId"],
      ["onboarding", "ownerRef"],
      ["policy-acknowledgement", "subjectUserId"],
      ["leave-request", "subjectUserId"],
      ["leave-decision", "subjectUserId"],
      ["leave-decision", "decidedBy"],
      ["attendance", "subjectUserId"],
      ["attendance-correction", "subjectUserId"],
      ["attendance-correction", "approvedBy"],
      ["people-review", "subjectUserId"],
      ["people-review", "reviewerRef"],
      ["review-submission", "subjectUserId"],
      ["review-submission", "reviewerRef"],
      ["review-submission", "submittedBy"],
      ["access-revocation-receipt", "subjectUserId"],
      ["access-revocation-receipt", "verifiedBy"],
      ["offboarding-receipt", "subjectUserId"],
    ] as const)("grants an exact %s.%s relationship", (recordType, field) => {
      const related = record({ recordType, data: { [field]: userId } });
      expect(canReadSuiteRecord(principal("member"), related)).toBe(true);
      expect(canReadSuiteRecord(principal("viewer"), related)).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ recordType, data: { [field]: otherUserId } }))).toBe(false);
    });

    it("enforces the profile privacy class for managers and fails closed when child lineage is absent", () => {
      for (const privacy of ["restricted", "people-team"] as const) {
        expect(canReadSuiteRecord(principal("member"), record({ recordType: "people-profile", data: { employeeRef: otherUserId, managerRef: userId, privacy } }))).toBe(false);
        expect(canReadSuiteRecord(principal("member"), record({ recordType: "leave-request", data: { subjectUserId: otherUserId, managerRef: userId, profilePrivacy: privacy } }))).toBe(false);
      }
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "people-profile", data: { employeeRef: otherUserId, managerRef: userId, privacy: "manager-and-person" } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "leave-request", data: { subjectUserId: otherUserId, managerRef: userId, profilePrivacy: "manager-and-person" } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "leave-request", data: { subjectUserId: otherUserId, managerRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "people-profile", data: { employeeRef: userId, managerRef: otherUserId, privacy: "restricted" } }))).toBe(true);
    });

    it("does not accept nested, partial, or record-inappropriate identity fields", () => {
      expect(canReadSuiteRecord(principal("member"), record({ data: { subject: { subjectUserId: userId } } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ data: { subjectUserId: `${userId}-other` } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "leave-request", data: { ownerRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "people-profile", data: { subjectUserId: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "offboarding-receipt", data: { approvedBy: userId } }))).toBe(false);
    });

    it("keeps AI requests, command receipts, and audits administrative even if they contain a relationship field", () => {
      for (const role of ["member", "viewer"] as const) {
        for (const recordType of [
          "extended-business-command-receipt",
          "ai-proposal-request",
          "ai-request-audit",
          "proposal-ai-request-audit",
          "audit",
        ]) {
          expect(canReadSuiteRecord(principal(role), record({ recordType, data: { subjectUserId: userId, managerRef: userId } }))).toBe(false);
        }
      }
    });

    it("fails closed for unknown or unattributed PeopleWeave records", () => {
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "unknown-people-record", data: { subjectUserId: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ recordType: "offboarding-receipt", data: { profileId: "profile-1" } }))).toBe(false);
    });
  });

  describe("Recall Room meetings", () => {
    it("shares workspace meetings and restricts confidential or restricted meetings to exact creators and participants", () => {
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "meetings", recordType: "meeting", data: { privacy: "workspace" } }))).toBe(true);
      for (const privacy of ["confidential", "restricted"] as const) {
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting", data: { privacy, createdBy: userId } }))).toBe(true);
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting", data: { privacy, participantUserRefs: [otherUserId, userId] } }))).toBe(true);
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting", data: { privacy, createdBy: otherUserId } }))).toBe(false);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting", data: { createdBy: userId } }))).toBe(false);
    });

    it.each([
      ["meeting-participant", "active"],
      ["transcript-segment", "captured"],
      ["meeting-decision", "decided"],
      ["meeting-action-item", "open"],
    ] as const)("preserves workspace visibility for classified %s children", (recordType, state) => {
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "meetings", recordType, state, data: { meetingPrivacy: "workspace" } }))).toBe(true);
    });

    it.each([
      ["meeting-participant", "userRef"],
      ["transcript-segment", "speakerRef"],
      ["transcript-segment", "recordedBy"],
      ["meeting-decision", "ownerRef"],
      ["meeting-decision", "recordedBy"],
      ["meeting-action-item", "ownerRef"],
      ["meeting-action-item", "createdBy"],
      ["ai-proposal-request", "queuedBy"],
    ] as const)("grants an exact confidential %s.%s relationship", (recordType, field) => {
      const data = { meetingPrivacy: "confidential", [field]: userId };
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType, data }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType, data: { ...data, [field]: otherUserId } }))).toBe(false);
    });

    it("grants the denormalized meeting creator across non-AI children while keeping AI requests requester-only", () => {
      for (const recordType of ["meeting-participant", "transcript-segment", "meeting-decision", "meeting-action-item"]) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "meetings", recordType, data: { meetingPrivacy: "restricted", meetingCreatedBy: userId } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "meetings", recordType: "ai-proposal-request", data: { meetingPrivacy: "restricted", meetingCreatedBy: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "meetings", recordType: "ai-proposal-request", data: { meetingPrivacy: "restricted", requestedByUserId: userId } }))).toBe(true);
    });

    it("supports an exact denormalized participant set for shared confidential artifacts but not private AI or exports", () => {
      for (const recordType of ["meeting-participant", "transcript-segment", "meeting-decision", "meeting-action-item"]) {
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType, data: { meetingPrivacy: "confidential", meetingParticipantUserRefs: [otherUserId, userId] } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "ai-proposal-request", data: { meetingPrivacy: "confidential", meetingParticipantUserRefs: [userId] } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting-export", data: { meetingPrivacy: "confidential", meetingParticipantUserRefs: [userId] } }))).toBe(false);
    });

    it("requires a valid denormalized privacy class before any child identity can grant access", () => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting-participant", data: { userRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting-decision", data: { meetingPrivacy: "secret", ownerRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "transcript-segment", data: { meetingPrivacy: "restricted", speaker: userId } }))).toBe(false);
    });

    it("keeps exports private even for workspace meetings", () => {
      const base = { meetingPrivacy: "workspace", meetingCreatedBy: otherUserId };
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting-export", data: base }))).toBe(false);
      for (const field of ["meetingCreatedBy", "exportedBy", "createdBy"] as const) {
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting-export", data: { ...base, [field]: userId } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType: "meeting-export", data: { exportedBy: userId } }))).toBe(false);
    });

    it("never shares internal or unknown meeting records through a classification field", () => {
      for (const recordType of ["additive-command-receipt", "meeting-ai-request-audit", "unknown-meeting-child"]) {
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "meetings", recordType, data: { meetingPrivacy: "workspace", meetingCreatedBy: userId } }))).toBe(false);
      }
    });
  });

  describe("Learning Forge", () => {
    it("shares workspace and catalog courses while restricting private courses to their exact creator", () => {
      for (const visibility of ["workspace", "public-catalog"] as const) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "learning", recordType: "learning-course", data: { visibility } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-course", data: { visibility: "private", createdBy: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-course", data: { visibility: "private", learnerRefs: [otherUserId, userId] } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-course", data: { visibility: "private", createdBy: otherUserId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-course", data: { createdBy: userId } }))).toBe(false);
    });

    it.each(["learning-lesson", "learning-rubric"] as const)("shares classified non-private %s records", (recordType) => {
      for (const courseVisibility of ["workspace", "public-catalog"] as const) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "learning", recordType, data: { courseVisibility } }))).toBe(true);
      }
    });

    it.each(["learning-lesson", "learning-rubric"] as const)("limits private %s records to an exact creator", (recordType) => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType, data: { courseVisibility: "private", courseCreatedBy: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType, data: { courseVisibility: "private", courseLearnerRefs: [otherUserId, userId] } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType, data: { courseVisibility: "private", courseCreatedBy: otherUserId } }))).toBe(false);
    });

    it.each([
      ["learning-enrollment", "learnerRef"],
      ["learning-enrollment", "enrolledBy"],
      ["learning-attempt", "learnerRef"],
      ["learning-attempt", "recordedBy"],
      ["learning-credential", "learnerRef"],
      ["learning-credential", "issuedBy"],
    ] as const)("keeps personal %s records limited to exact %s identities even on shared courses", (recordType, field) => {
      const related = { courseVisibility: "workspace", [field]: userId };
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType, data: related }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType, data: { ...related, [field]: otherUserId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType, data: { courseVisibility: "workspace" } }))).toBe(false);
    });

    it("allows the denormalized course creator to read private non-AI children while keeping AI requests requester-only", () => {
      for (const recordType of ["learning-lesson", "learning-rubric", "learning-enrollment", "learning-attempt", "learning-credential"]) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "learning", recordType, data: { courseVisibility: "private", courseCreatedBy: userId } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "learning", recordType: "ai-proposal-request", data: { courseVisibility: "private", courseCreatedBy: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "learning", recordType: "ai-proposal-request", data: { courseVisibility: "private", requestedByUserId: userId } }))).toBe(true);
    });

    it("keeps AI drafts attributable and never workspace-wide", () => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "ai-proposal-request", data: { courseVisibility: "workspace", queuedBy: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "ai-proposal-request", data: { courseVisibility: "workspace", queuedBy: otherUserId } }))).toBe(false);
    });

    it("fails closed for unclassified, internal, unknown, nested, and partial learning records", () => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-attempt", data: { learnerRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-attempt", data: { courseVisibility: "private", learnerRef: `${userId}-other` } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-attempt", data: { courseVisibility: "private", learner: { learnerRef: userId } } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "learning-attempt", data: { courseVisibility: "private", courseLearnerRefs: [userId] } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "additive-command-receipt", data: { courseVisibility: "workspace", learnerRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "learning", recordType: "unknown-learning-child", data: { courseVisibility: "workspace" } }))).toBe(false);
    });
  });

  describe("Circlefield community", () => {
    it("shares workspace and public spaces while restricting private spaces to exact creators or members", () => {
      for (const visibility of ["workspace", "public"] as const) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "community", recordType: "community-space", data: { visibility } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-space", data: { visibility: "private", createdBy: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-space", data: { visibility: "private", memberRefs: [otherUserId, userId] } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-space", data: { visibility: "private" } }))).toBe(false);
    });

    it.each([
      ["community-member", "active"],
      ["community-post", "visible"],
      ["community-reply", "visible"],
      ["community-reaction", "active"],
      ["community-announcement", "published"],
    ] as const)("shares classified non-private %s records in a shareable state", (recordType, state) => {
      for (const spaceVisibility of ["workspace", "public"] as const) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "community", recordType, state, data: { spaceVisibility } }))).toBe(true);
      }
    });

    it.each([
      ["community-member", "memberRef"],
      ["community-member", "addedBy"],
      ["community-post", "authorRef"],
      ["community-reply", "authorRef"],
      ["community-reaction", "memberRef"],
      ["community-announcement", "publishedBy"],
    ] as const)("grants an exact private %s.%s relationship", (recordType, field) => {
      const related = { spaceVisibility: "private", [field]: userId };
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType, data: related }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType, data: { ...related, [field]: otherUserId } }))).toBe(false);
    });

    it("grants the denormalized space creator across private non-AI children while keeping AI requests requester-only", () => {
      for (const recordType of ["community-member", "community-post", "community-reply", "community-reaction", "community-announcement"]) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "community", recordType, data: { spaceVisibility: "private", spaceCreatedBy: userId } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "community", recordType: "ai-proposal-request", data: { spaceVisibility: "private", spaceCreatedBy: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "community", recordType: "ai-proposal-request", data: { spaceVisibility: "private", requestedByUserId: userId } }))).toBe(true);
    });

    it("supports exact private-space membership for shareable records but not private AI drafts", () => {
      for (const [recordType, state] of [
        ["community-member", "active"],
        ["community-post", "visible"],
        ["community-reply", "visible"],
        ["community-reaction", "active"],
        ["community-announcement", "published"],
      ] as const) {
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType, state, data: { spaceVisibility: "private", spaceMemberRefs: [otherUserId, userId] } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "ai-proposal-request", data: { spaceVisibility: "private", spaceMemberRefs: [userId] } }))).toBe(false);
    });

    it("does not expose hidden posts, withdrawn reactions, or AI drafts merely because their space is shared", () => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-post", state: "hidden", data: { spaceVisibility: "public" } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-post", state: "hidden", data: { spaceVisibility: "public", authorRef: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-post", state: "hidden", data: { spaceVisibility: "private", spaceMemberRefs: [userId] } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-reaction", state: "withdrawn", data: { spaceVisibility: "workspace" } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-reaction", state: "withdrawn", data: { spaceVisibility: "workspace", memberRef: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "ai-proposal-request", data: { spaceVisibility: "public" } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "ai-proposal-request", data: { spaceVisibility: "public", queuedBy: userId } }))).toBe(true);
    });

    it("fails closed for missing classifications, unrelated fields, internal records, and unknown children", () => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-post", data: { authorRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-post", data: { spaceVisibility: "private", memberRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "community-post", data: { spaceVisibility: "private", authorRef: `${userId}-other` } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "additive-command-receipt", data: { spaceVisibility: "public", authorRef: userId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "community", recordType: "unknown-community-child", data: { spaceVisibility: "public" } }))).toBe(false);
    });
  });

  describe("global AI request privacy", () => {
    it("keeps AI requests, audits, and results requester or reviewer bound even in otherwise shared modules", () => {
      for (const [moduleId, recordType] of [
        ["projects", "premium-ai-request-audit"],
        ["tables", "ai-proposal-request"],
        ["crm", "ai-request-audit"],
        ["publish", "proposal-ai-request-audit"],
        ["assistant", "ai-result"],
      ] as const) {
        expect(canReadSuiteRecord(principal("member"), record({ moduleId, recordType, data: { requestedByUserId: userId } }))).toBe(true);
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId, recordType, data: { reviewedByUserId: userId } }))).toBe(true);
        expect(canReadSuiteRecord(principal("member"), record({ moduleId, recordType, data: { requestedByUserId: otherUserId } }))).toBe(false);
        expect(canReadSuiteRecord(principal("member"), record({ moduleId, recordType, data: { evidenceIds: ["private-record"] } }))).toBe(false);
      }
    });
  });

  describe("AssureGraph assurance", () => {
    it("shares explicitly public or internal records and limits classified or unclassified records to exact owners", () => {
      for (const classification of ["public", "internal"] as const) {
        expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "assurance", recordType: "assurance-risk", data: { assuranceClassification: classification } }))).toBe(true);
      }
      for (const classification of ["confidential", "restricted"] as const) {
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assurance", recordType: "assurance-risk", data: { assuranceClassification: classification, subjectOwnerRef: userId } }))).toBe(true);
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assurance", recordType: "assurance-risk", data: { assuranceClassification: classification, subjectOwnerRef: otherUserId } }))).toBe(false);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assurance", recordType: "assurance-program", data: { programOwnerRef: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assurance", recordType: "assurance-program", data: { programOwnerRef: otherUserId } }))).toBe(false);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assurance", recordType: "assurance-risk", data: { assuranceClassification: "secret", subjectOwnerRef: userId } }))).toBe(false);
    });

    it("keeps audit packs private regardless of their subject classification", () => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assurance", recordType: "audit-pack", state: "ready-private", data: { private: true, assuranceClassification: "public", createdByUserId: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assurance", recordType: "audit-pack", state: "ready-private", data: { private: true, assuranceClassification: "public", createdByUserId: otherUserId } }))).toBe(false);
    });
  });

  describe("LiveForum sessions", () => {
    it("shares non-private sessions and limits private session artifacts to exact participants", () => {
      expect(canReadSuiteRecord(principal("viewer"), record({ moduleId: "live", recordType: "live-session", data: { visibility: "workspace" } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "live", recordType: "live-session", data: { visibility: "private", sessionParticipantRefs: [userId] } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "live", recordType: "live-chat-message", state: "visible", data: { sessionVisibility: "private", sessionParticipantRefs: [userId] } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "live", recordType: "live-session", data: { visibility: "private", sessionParticipantRefs: [otherUserId] } }))).toBe(false);
    });

    it("keeps access, consent, responses, and moderation narrowed to their exact subjects", () => {
      const cases = [
        ["attendee-access", "attendeeRef"],
        ["presenter-grant", "presenterRef"],
        ["media-consent-receipt", "participantRef"],
        ["live-prompt-response", "attendeeRef"],
        ["chat-moderation-receipt", "messageSenderRef"],
      ] as const;
      for (const [recordType, field] of cases) {
        const shared = { sessionVisibility: "workspace", sessionParticipantRefs: [userId], [field]: otherUserId };
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "live", recordType, data: shared }))).toBe(false);
        expect(canReadSuiteRecord(principal("member"), record({ moduleId: "live", recordType, data: { ...shared, [field]: userId } }))).toBe(true);
      }
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "live", recordType: "unknown-live-record", data: { sessionVisibility: "workspace", sessionParticipantRefs: [userId] } }))).toBe(false);
    });
  });

  describe("Assistant evidence privacy", () => {
    it.each(["createdByUserId", "requestedByUserId", "approvedByUserId", "reviewedByUserId"] as const)("allows only the exact attributed %s", (field) => {
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assistant", recordType: "source-attachment", data: { [field]: userId } }))).toBe(true);
      expect(canReadSuiteRecord(principal("member"), record({ moduleId: "assistant", recordType: "source-attachment", data: { [field]: otherUserId } }))).toBe(false);
    });

    it("fails closed for unattributed Assistant records while preserving admin access", () => {
      const unattributed = record({ moduleId: "assistant", recordType: "ai-result", data: { output: "private" } });
      expect(canReadSuiteRecord(principal("viewer"), unattributed)).toBe(false);
      expect(canReadSuiteRecord(principal("admin"), unattributed)).toBe(true);
    });
  });

  describe("additive record envelopes", () => {
    it("authorizes from the persisted inner domain data", () => {
      const target = additiveRecord("meetings", "meeting", "scheduled", { privacy: "workspace" });
      expect(canReadSuiteRecord(principal("viewer"), target)).toBe(true);
    });

    it("does not accept spoofed top-level identities outside the domain envelope", () => {
      const target = additiveRecord("meetings", "meeting", "scheduled", { privacy: "restricted", createdBy: otherUserId });
      target.data.createdBy = userId;
      expect(canReadSuiteRecord(principal("member"), target)).toBe(false);
    });

    it.each([
      ["workspaceId", otherWorkspaceId],
      ["moduleId", "community"],
      ["recordType", "meeting-export"],
      ["state", "cancelled"],
    ] as const)("fails closed when envelope %s disagrees with the Suite record", (field, value) => {
      const target = additiveRecord("meetings", "meeting", "scheduled", { privacy: "workspace" }, { [field]: value });
      expect(canReadSuiteRecord(principal("member"), target)).toBe(false);
    });

    it("fails closed for malformed protected envelopes", () => {
      const malformed = record({
        moduleId: "learning",
        recordType: "learning-course",
        data: { additiveContract: "additive-business-record.v1", record: { data: { visibility: "workspace" } } },
      });
      expect(canReadSuiteRecord(principal("member"), malformed)).toBe(false);
    });
  });
});
