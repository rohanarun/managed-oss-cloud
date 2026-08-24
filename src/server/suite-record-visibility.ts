import type {
  SuiteRecord,
  SuiteWorkspaceRole,
} from "../shared/suite.js";

export interface SuiteRecordReadPrincipal {
  userId: string;
  workspaceId: string;
  role: SuiteWorkspaceRole;
}

export type SuiteRecordVisibilityTarget = Pick<
  SuiteRecord,
  "workspaceId" | "moduleId" | "recordType" | "state" | "data"
>;

type RecordData = Record<string, unknown>;

interface IdentityPolicy {
  fields: readonly string[];
  arrayFields?: readonly string[];
}

const additiveRecordContract = "additive-business-record.v1";
const privilegedRoles = new Set<SuiteWorkspaceRole>(["owner", "admin"]);
const protectedModuleIds = new Set(["people", "meetings", "learning", "community", "assistant", "assurance", "live"]);

const peopleIdentityPolicies: Readonly<Record<string, IdentityPolicy>> = {
  "people-profile": { fields: ["employeeRef", "managerRef"] },
  onboarding: { fields: ["subjectUserId", "managerRef", "ownerRef"] },
  "policy-acknowledgement": { fields: ["subjectUserId", "managerRef"] },
  "leave-request": { fields: ["subjectUserId", "managerRef"] },
  "leave-decision": { fields: ["subjectUserId", "managerRef", "decidedBy"] },
  attendance: { fields: ["subjectUserId", "managerRef"] },
  "attendance-correction": { fields: ["subjectUserId", "managerRef", "approvedBy"] },
  "people-review": { fields: ["subjectUserId", "managerRef", "reviewerRef"] },
  "review-submission": { fields: ["subjectUserId", "managerRef", "reviewerRef", "submittedBy"] },
  "access-revocation-receipt": { fields: ["subjectUserId", "verifiedBy"] },
  "offboarding-receipt": { fields: ["subjectUserId", "managerRef"] },
};

const meetingIdentityPolicies: Readonly<Record<string, IdentityPolicy>> = {
  "meeting-participant": { fields: ["meetingCreatedBy", "userRef"], arrayFields: ["meetingParticipantUserRefs"] },
  "transcript-segment": { fields: ["meetingCreatedBy", "speakerRef", "recordedBy"], arrayFields: ["meetingParticipantUserRefs"] },
  "meeting-decision": { fields: ["meetingCreatedBy", "ownerRef", "recordedBy"], arrayFields: ["meetingParticipantUserRefs"] },
  "meeting-action-item": { fields: ["meetingCreatedBy", "ownerRef", "createdBy"], arrayFields: ["meetingParticipantUserRefs"] },
  "ai-proposal-request": { fields: ["meetingCreatedBy", "queuedBy"] },
};

const learningIdentityPolicies: Readonly<Record<string, IdentityPolicy>> = {
  "learning-lesson": { fields: ["courseCreatedBy", "createdBy"], arrayFields: ["courseLearnerRefs"] },
  "learning-rubric": { fields: ["courseCreatedBy", "createdBy"], arrayFields: ["courseLearnerRefs"] },
  "learning-enrollment": { fields: ["courseCreatedBy", "learnerRef", "enrolledBy"] },
  "learning-attempt": { fields: ["courseCreatedBy", "learnerRef", "recordedBy"] },
  "learning-credential": { fields: ["courseCreatedBy", "learnerRef", "issuedBy"] },
  "ai-proposal-request": { fields: ["courseCreatedBy", "learnerRef", "queuedBy"] },
};

const communityIdentityPolicies: Readonly<Record<string, IdentityPolicy>> = {
  "community-member": { fields: ["spaceCreatedBy", "memberRef", "addedBy"], arrayFields: ["spaceMemberRefs"] },
  "community-post": { fields: ["spaceCreatedBy", "authorRef"], arrayFields: ["spaceMemberRefs"] },
  "community-reply": { fields: ["spaceCreatedBy", "authorRef"], arrayFields: ["spaceMemberRefs"] },
  "community-reaction": { fields: ["spaceCreatedBy", "memberRef"], arrayFields: ["spaceMemberRefs"] },
  "community-announcement": { fields: ["spaceCreatedBy", "publishedBy"], arrayFields: ["spaceMemberRefs"] },
  "ai-proposal-request": { fields: ["spaceCreatedBy", "queuedBy"] },
};

const workspaceMeetingPrivacy = "workspace";
const protectedMeetingPrivacy = new Set(["confidential", "restricted"]);
const sharedLearningVisibility = new Set(["workspace", "public-catalog"]);
const sharedCommunityVisibility = new Set(["workspace", "public"]);
const sharedLearningRecordTypes = new Set(["learning-lesson", "learning-rubric"]);
const sharedAssuranceClassifications = new Set(["public", "internal"]);
const protectedAssuranceClassifications = new Set(["confidential", "restricted"]);
const sharedLiveVisibility = new Set(["workspace", "invited-public"]);
const liveSessionSharedRecordTypes = new Set([
  "broadcast-receipt",
  "broadcast-update",
  "live-chat-message",
  "live-prompt",
]);
const globallyPrivateAiRecordTypes = new Set([
  "ai-proposal-request",
  "ai-request-audit",
  "premium-ai-request-audit",
  "ai-result",
]);

function isRecordData(value: unknown): value is RecordData {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function authorizationData(record: SuiteRecordVisibilityTarget): RecordData | undefined {
  if (!isRecordData(record.data)) return undefined;
  if (record.data.additiveContract !== additiveRecordContract) return record.data;

  const stored = record.data.record;
  if (!isRecordData(stored)
    || stored.workspaceId !== record.workspaceId
    || stored.moduleId !== record.moduleId
    || stored.recordType !== record.recordType
    || stored.state !== record.state
    || !isRecordData(stored.data)) return undefined;
  return stored.data;
}

function hasExactIdentity(data: RecordData, userId: string, policy: IdentityPolicy | undefined) {
  if (!policy) return false;
  if (policy.fields.some((field) => Object.hasOwn(data, field) && data[field] === userId)) return true;
  return (policy.arrayFields ?? []).some((field) => Array.isArray(data[field]) && data[field].some((value) => value === userId));
}

function isInternalRecord(recordType: string) {
  return recordType === "audit"
    || recordType.endsWith("-audit")
    || recordType.endsWith("-command-receipt");
}

function isGloballyPrivateAiRecord(recordType: string) {
  return globallyPrivateAiRecordTypes.has(recordType) || recordType.endsWith("-ai-request-audit");
}

function canReadPrivateAiRecord(userId: string, data: RecordData) {
  return hasExactIdentity(data, userId, {
    fields: ["requestedByUserId", "requestedBy", "queuedBy", "reviewedByUserId", "reviewedBy"],
  });
}

function canReadPeopleRecord(userId: string, record: SuiteRecordVisibilityTarget, data: RecordData) {
  if (record.recordType === "people-policy") return record.state === "published";
  if (record.recordType === "ai-proposal-request" || isInternalRecord(record.recordType)) return false;
  if (record.recordType === "people-profile") {
    if (data.employeeRef === userId) return true;
    return data.privacy === "manager-and-person" && data.managerRef === userId;
  }
  const policy = peopleIdentityPolicies[record.recordType];
  if (!policy) return false;
  const nonManagerPolicy = { ...policy, fields: policy.fields.filter((field) => field !== "managerRef") };
  if (hasExactIdentity(data, userId, nonManagerPolicy)) return true;
  return data.profilePrivacy === "manager-and-person" && data.managerRef === userId;
}

function canReadMeetingRecord(userId: string, record: SuiteRecordVisibilityTarget, data: RecordData) {
  if (isInternalRecord(record.recordType)) return false;
  if (record.recordType === "meeting") {
    if (data.privacy === workspaceMeetingPrivacy) return true;
    if (!protectedMeetingPrivacy.has(String(data.privacy))) return false;
    return hasExactIdentity(data, userId, {
      fields: ["createdBy"],
      arrayFields: ["participantUserRefs"],
    });
  }

  const privacy = data.meetingPrivacy;
  if (privacy !== workspaceMeetingPrivacy && !protectedMeetingPrivacy.has(String(privacy))) return false;
  if (record.recordType === "meeting-export") {
    return hasExactIdentity(data, userId, { fields: ["meetingCreatedBy", "exportedBy", "createdBy"] });
  }
  const policy = meetingIdentityPolicies[record.recordType];
  if (!policy) return false;
  if (record.recordType === "ai-proposal-request") return hasExactIdentity(data, userId, policy);
  if (privacy === workspaceMeetingPrivacy) return true;
  return hasExactIdentity(data, userId, policy);
}

function canReadLearningRecord(userId: string, record: SuiteRecordVisibilityTarget, data: RecordData) {
  if (isInternalRecord(record.recordType)) return false;
  if (record.recordType === "learning-course") {
    if (sharedLearningVisibility.has(String(data.visibility))) return true;
    if (data.visibility !== "private") return false;
    return hasExactIdentity(data, userId, { fields: ["createdBy"], arrayFields: ["learnerRefs"] });
  }

  const visibility = data.courseVisibility;
  if (visibility !== "private" && !sharedLearningVisibility.has(String(visibility))) return false;
  const policy = learningIdentityPolicies[record.recordType];
  if (!policy) return false;
  if (sharedLearningRecordTypes.has(record.recordType) && sharedLearningVisibility.has(String(visibility))) return true;
  return hasExactIdentity(data, userId, policy);
}

function isShareableCommunityState(record: SuiteRecordVisibilityTarget) {
  if (record.recordType === "community-member") return record.state === "active";
  if (record.recordType === "community-post" || record.recordType === "community-reply") return record.state === "visible";
  if (record.recordType === "community-reaction") return record.state === "active";
  if (record.recordType === "community-announcement") return record.state === "published";
  return false;
}

function canReadCommunityRecord(userId: string, record: SuiteRecordVisibilityTarget, data: RecordData) {
  if (isInternalRecord(record.recordType)) return false;
  if (record.recordType === "community-space") {
    if (sharedCommunityVisibility.has(String(data.visibility))) return true;
    if (data.visibility !== "private") return false;
    return hasExactIdentity(data, userId, { fields: ["createdBy"], arrayFields: ["memberRefs"] });
  }

  const visibility = data.spaceVisibility;
  if (visibility !== "private" && !sharedCommunityVisibility.has(String(visibility))) return false;
  const policy = communityIdentityPolicies[record.recordType];
  if (!policy) return false;
  if (record.recordType === "ai-proposal-request") return hasExactIdentity(data, userId, policy);
  if (sharedCommunityVisibility.has(String(visibility)) && isShareableCommunityState(record)) return true;
  if (!isShareableCommunityState(record)) return hasExactIdentity(data, userId, { fields: policy.fields });
  return hasExactIdentity(data, userId, policy);
}

function canReadAssistantRecord(userId: string, data: RecordData) {
  return hasExactIdentity(data, userId, {
    fields: ["createdByUserId", "requestedByUserId", "approvedByUserId", "reviewedByUserId"],
  });
}

const assuranceIdentityPolicy: IdentityPolicy = {
  fields: [
    "programOwnerRef",
    "subjectOwnerRef",
    "ownerRef",
    "controlOwnerRef",
    "evidenceOwnerRef",
    "remediationOwnerRef",
    "createdByUserId",
    "attachedByUserId",
    "testerRef",
    "approvedBy",
    "requestedByUserId",
  ],
  arrayFields: ["subjectOwnerRefs"],
};

function canReadAssuranceRecord(userId: string, record: SuiteRecordVisibilityTarget, data: RecordData) {
  if (isInternalRecord(record.recordType)) return false;
  if (record.recordType === "audit-pack" || data.private === true || record.state === "ready-private") {
    return hasExactIdentity(data, userId, assuranceIdentityPolicy);
  }
  const classification = data.assuranceClassification;
  if (sharedAssuranceClassifications.has(String(classification))) return true;
  if (classification !== undefined && !protectedAssuranceClassifications.has(String(classification))) return false;
  return hasExactIdentity(data, userId, assuranceIdentityPolicy);
}

function liveIdentityPolicy(recordType: string): IdentityPolicy | undefined {
  if (recordType === "attendee-access") return { fields: ["attendeeRef"] };
  if (recordType === "presenter-grant") return { fields: ["presenterRef"] };
  if (recordType === "media-consent-receipt") return { fields: ["participantRef"] };
  if (recordType === "live-prompt-response") return { fields: ["attendeeRef"] };
  if (recordType === "chat-moderation-receipt") return { fields: ["messageSenderRef", "approvedBy"] };
  return undefined;
}

function canReadLiveRecord(userId: string, record: SuiteRecordVisibilityTarget, data: RecordData) {
  if (isInternalRecord(record.recordType)) return false;
  const visibility = record.recordType === "live-session" ? data.visibility : data.sessionVisibility;
  if (visibility !== "private" && !sharedLiveVisibility.has(String(visibility))) return false;

  const narrowPolicy = liveIdentityPolicy(record.recordType);
  if (narrowPolicy) return hasExactIdentity(data, userId, narrowPolicy);

  const shareable = record.recordType === "live-session" || liveSessionSharedRecordTypes.has(record.recordType);
  if (!shareable) return false;
  if (record.recordType === "live-chat-message" && record.state !== "visible") {
    return hasExactIdentity(data, userId, { fields: ["senderRef", "sessionCreatedBy"] });
  }
  if (sharedLiveVisibility.has(String(visibility))) return true;
  return hasExactIdentity(data, userId, {
    fields: ["sessionCreatedBy", "senderRef"],
    arrayFields: ["sessionParticipantRefs"],
  });
}

/**
 * Pure record-level tenant policy. Workspace membership, module entitlement,
 * and token-scope checks remain caller responsibilities. Additive records are
 * authorized from their validated domain envelope, never spoofable top-level
 * fields. Protected child records require a denormalized parent privacy class.
 */
export function canReadSuiteRecord(
  principal: SuiteRecordReadPrincipal,
  record: SuiteRecordVisibilityTarget,
) {
  if (!isNonEmptyString(principal.userId)
    || !isNonEmptyString(principal.workspaceId)
    || record.workspaceId !== principal.workspaceId) return false;
  if (privilegedRoles.has(principal.role)) return true;

  const data = authorizationData(record);
  if (!data) return false;
  if (isGloballyPrivateAiRecord(record.recordType)) return canReadPrivateAiRecord(principal.userId, data);
  if (!protectedModuleIds.has(record.moduleId)) return true;
  if (record.moduleId === "people") return canReadPeopleRecord(principal.userId, record, data);
  if (record.moduleId === "meetings") return canReadMeetingRecord(principal.userId, record, data);
  if (record.moduleId === "learning") return canReadLearningRecord(principal.userId, record, data);
  if (record.moduleId === "assistant") return canReadAssistantRecord(principal.userId, data);
  if (record.moduleId === "community") return canReadCommunityRecord(principal.userId, record, data);
  if (record.moduleId === "assurance") return canReadAssuranceRecord(principal.userId, record, data);
  return canReadLiveRecord(principal.userId, record, data);
}

export function suiteModuleHasProtectedRecords(moduleId: string) {
  return protectedModuleIds.has(moduleId);
}
