export type EmailModuleId = "email";
export type EmailOperation = "read" | "command" | "ai";
export type EmailScope = "read" | "write" | "ai" | "external";
export type EmailRisk = "low" | "moderate" | "high";

export interface EmailJsonSchema {
  type: "object";
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: false;
}

export interface EmailActionDefinition {
  id: string;
  moduleId: EmailModuleId;
  productName: "Letterline";
  title: string;
  description: string;
  operation: EmailOperation;
  requiredScope: EmailScope;
  recordType: string;
  risk: EmailRisk;
  approvalRequired: boolean;
  destructive: boolean;
  externalEffect: false;
  providerCallsAllowed: false;
  effectBoundary: "none" | "dispatch-plan-only" | "verified-provider-receipt-ingest" | "private-export";
  idempotent: true;
  inputSchema: EmailJsonSchema;
  exampleInput: Record<string, unknown>;
  cliExample: string;
  mcpToolName: string;
  promptId?: "email.subject-propose" | "email.body-propose";
  promptVersion?: "2026-08-24.1";
}

const uuid = { type: "string", format: "uuid" };
const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" };
const text = (maxLength = 4_000) => ({ type: "string", minLength: 1, maxLength });
const optionalText = (maxLength = 4_000) => ({ type: "string", maxLength });
const dateTime = { type: "string", format: "date-time" };
const boolean = { type: "boolean" };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const idempotencyKey = { type: "string", pattern: "^[A-Za-z0-9._:-]{16,200}$" };
const uuidArray = (maxItems = 100) => ({ type: "array", maxItems, items: uuid });
const email = { type: "string", minLength: 3, maxLength: 320 };
const approval = {
  type: "object",
  required: ["approved", "approvedBy", "approvedAt", "decisionId", "reason"],
  properties: {
    approved: { const: true },
    approvedBy: uuid,
    approvedAt: dateTime,
    decisionId: idempotencyKey,
    reason: text(2_000),
  },
  additionalProperties: false,
};
const consent = {
  type: "object",
  required: ["granted", "policyVersion", "purposes", "capturedAt", "captureMethod", "sourceProofHash", "purchasedList", "doubleOptInConfirmed", "reconfirmationAfterSuppression"],
  properties: {
    granted: { const: true },
    policyVersion: text(120),
    purposes: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { enum: ["newsletter", "product-updates", "promotional-email"] },
    },
    capturedAt: dateTime,
    captureMethod: { enum: ["hosted-form", "api-attestation", "signed-first-party-import"] },
    sourceProofHash: sha256,
    purchasedList: { const: false },
    doubleOptInConfirmed: boolean,
    reconfirmationAfterSuppression: boolean,
    jurisdiction: optionalText(80),
  },
  additionalProperties: false,
};
const reviewChecklist = {
  type: "object",
  required: ["consentBoundaryReviewed", "claimsReviewed", "unsubscribeMechanismReviewed", "senderIdentityReviewed"],
  properties: {
    consentBoundaryReviewed: { const: true },
    claimsReviewed: { const: true },
    unsubscribeMechanismReviewed: { const: true },
    senderIdentityReviewed: { const: true },
  },
  additionalProperties: false,
};
const gatewayVerification = {
  type: "object",
  required: ["verified", "verifierId", "verifiedAt", "payloadHash"],
  properties: {
    verified: { const: true },
    verifierId: { type: "string", pattern: "^[A-Za-z0-9._:-]{3,120}$" },
    verifiedAt: dateTime,
    payloadHash: sha256,
  },
  additionalProperties: false,
};

type Draft = Omit<EmailActionDefinition, "moduleId" | "productName" | "requiredScope" | "risk" | "approvalRequired" | "destructive" | "externalEffect" | "providerCallsAllowed" | "effectBoundary" | "idempotent" | "inputSchema" | "exampleInput" | "cliExample" | "mcpToolName"> & {
  requiredScope?: EmailScope;
  risk?: EmailRisk;
  approvalRequired?: boolean;
  destructive?: boolean;
  effectBoundary?: EmailActionDefinition["effectBoundary"];
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  example: Record<string, unknown>;
};

function define(draft: Draft): EmailActionDefinition {
  const {
    required: draftRequired,
    properties: draftProperties,
    example,
    requiredScope,
    risk,
    approvalRequired = false,
    destructive = false,
    effectBoundary = "none",
    ...base
  } = draft;
  const properties = { ...draftProperties };
  const required = [...draftRequired];
  const exampleInput = { ...example };
  if (draft.operation !== "read") {
    properties.idempotencyKey = idempotencyKey;
    required.push("idempotencyKey");
    exampleInput.idempotencyKey = `email.${draft.id}.sample-0001`;
  }
  if (approvalRequired) {
    properties.dryRun = boolean;
    properties.approval = approval;
    required.push("dryRun");
    exampleInput.dryRun = true;
  }
  const mcpToolName = `email_${draft.id.replaceAll("-", "_")}`;
  const cliInput = JSON.stringify(exampleInput).replaceAll("'", "'\\''");
  return {
    ...base,
    moduleId: "email",
    productName: "Letterline",
    requiredScope: requiredScope ?? (draft.operation === "read" ? "read" : draft.operation === "ai" ? "ai" : approvalRequired ? "external" : "write"),
    risk: risk ?? (approvalRequired ? "high" : draft.operation === "ai" ? "moderate" : "low"),
    approvalRequired,
    destructive,
    externalEffect: false,
    providerCallsAllowed: false,
    effectBoundary,
    idempotent: true,
    inputSchema: { type: "object", required: [...new Set(required)], properties, additionalProperties: false },
    exampleInput,
    cliExample: `supersuite action email ${draft.id} '${cliInput}'`,
    mcpToolName,
  };
}

const sample = {
  actor: "00000000-0000-4000-8000-000000000001",
  audience: "00000000-0000-4000-8000-000000000101",
  subscriber: "00000000-0000-4000-8000-000000000102",
  campaign: "00000000-0000-4000-8000-000000000103",
  campaignVersion: "00000000-0000-4000-8000-000000000104",
  dispatchPlan: "00000000-0000-4000-8000-000000000105",
  evidence: "00000000-0000-4000-8000-000000000106",
};

export const emailActions: EmailActionDefinition[] = [
  define({ id: "audience-create", title: "Create purpose-bound audience", description: "Create an audience with an explicit purpose and consent-policy boundary before collecting any address.", operation: "command", recordType: "audience", required: ["name", "purpose", "consentPolicyVersion"], properties: { name: text(160), purpose: text(2_000), consentPolicyVersion: text(120), description: optionalText(4_000) }, example: { name: "Product newsletter", purpose: "Send a reviewed monthly product newsletter to people who opted in.", consentPolicyVersion: "newsletter-consent-v1" } }),
  define({ id: "subscriber-opt-in-record", title: "Record lawful subscriber opt-in", description: "Normalize and deduplicate one address while creating an immutable, purpose-specific consent receipt; purchased-list assumptions are rejected.", operation: "command", recordType: "subscriber", risk: "moderate", required: ["audienceId", "email", "consent"], properties: { audienceId: uuid, email, displayName: optionalText(160), locale: optionalText(40), consent }, example: { audienceId: sample.audience, email: "Reader@example.com", displayName: "Reader", locale: "en-US", consent: { granted: true, policyVersion: "newsletter-consent-v1", purposes: ["newsletter"], capturedAt: "2026-08-24T16:00:00.000Z", captureMethod: "hosted-form", sourceProofHash: "a".repeat(64), purchasedList: false, doubleOptInConfirmed: true, reconfirmationAfterSuppression: false } } }),
  define({ id: "subscriber-reactivate", title: "Reconfirm suppressed subscriber", description: "Reactivate only a prior unsubscribe or manual suppression after a newer double opt-in; hard bounces, complaints, and legal blocks remain blocked.", operation: "command", recordType: "consent-receipt", risk: "high", required: ["subscriberId", "audienceId", "consent"], properties: { subscriberId: uuid, audienceId: uuid, consent }, example: { subscriberId: sample.subscriber, audienceId: sample.audience, consent: { granted: true, policyVersion: "newsletter-consent-v1", purposes: ["newsletter"], capturedAt: "2026-08-25T16:00:00.000Z", captureMethod: "hosted-form", sourceProofHash: "b".repeat(64), purchasedList: false, doubleOptInConfirmed: true, reconfirmationAfterSuppression: true } } }),
  define({ id: "subscriber-suppress", title: "Suppress or unsubscribe immediately", description: "Apply an immutable unsubscribe, bounce, complaint, legal, or manual suppression before any future dispatch plan is created.", operation: "command", recordType: "suppression", risk: "moderate", destructive: true, required: ["subscriberId", "reason", "occurredAt", "evidenceHash"], properties: { subscriberId: uuid, reason: { enum: ["unsubscribe", "hard-bounce", "complaint", "legal-block", "manual"] }, occurredAt: dateTime, evidenceHash: sha256, note: optionalText(1_000) }, example: { subscriberId: sample.subscriber, reason: "unsubscribe", occurredAt: "2026-08-24T17:00:00.000Z", evidenceHash: "c".repeat(64), note: "Recipient used the hosted unsubscribe control." } }),
  define({ id: "subscriber-list", title: "List audience subscribers", description: "List tenant-scoped subscriber records with an explicit choice about whether suppressed records are included.", operation: "read", recordType: "subscriber", required: ["audienceId", "includeSuppressed"], properties: { audienceId: uuid, includeSuppressed: boolean }, example: { audienceId: sample.audience, includeSuppressed: false } }),
  define({ id: "campaign-create", title: "Create audience-bound campaign", description: "Create a campaign objective bound to one existing audience without drafting, scheduling, or sending content.", operation: "command", recordType: "campaign", required: ["audienceId", "name", "objective"], properties: { audienceId: uuid, name: text(200), objective: text(2_000) }, example: { audienceId: sample.audience, name: "September product letter", objective: "Explain reviewed product improvements to opted-in readers." } }),
  define({ id: "campaign-version-draft", title: "Create immutable campaign version", description: "Freeze an exact subject, sender identity, reply address, plain text, optional HTML, and required unsubscribe marker under an optimistic campaign version.", operation: "command", recordType: "campaign-version", risk: "moderate", required: ["campaignId", "expectedCampaignVersion", "subject", "senderName", "replyToEmail", "bodyText", "footer"], properties: { campaignId: uuid, expectedCampaignVersion: integer(1, 1_000_000), subject: text(240), preheader: optionalText(300), senderName: text(160), replyToEmail: email, bodyText: text(100_000), bodyHtml: optionalText(200_000), footer: text(4_000) }, example: { campaignId: sample.campaign, expectedCampaignVersion: 1, subject: "September product notes", preheader: "A concise review of this month's improvements.", senderName: "Example Product", replyToEmail: "hello@example.com", bodyText: "Hello,\n\nHere are the reviewed updates.\n\nUnsubscribe: {{unsubscribe_url}}", footer: "Example Product · Contact us at hello@example.com · {{unsubscribe_url}}" } }),
  define({ id: "subject-propose", title: "Propose cited subject lines", description: "Queue evidence-bound subject proposals that remain pending human review and cannot alter, approve, schedule, or send a campaign.", operation: "ai", recordType: "email-ai-request-audit", required: ["campaignId", "instruction", "evidenceIds"], properties: { campaignId: uuid, instruction: text(4_000), evidenceIds: uuidArray(100) }, example: { campaignId: sample.campaign, instruction: "Propose concise subject lines supported by the selected evidence without urgency or unsupported claims.", evidenceIds: [sample.evidence] }, promptId: "email.subject-propose", promptVersion: "2026-08-24.1" }),
  define({ id: "body-propose", title: "Propose cited newsletter body", description: "Queue an evidence-bound plain-text body proposal with an unsubscribe marker; it remains unreviewed and cannot be dispatched.", operation: "ai", recordType: "email-ai-request-audit", required: ["campaignId", "instruction", "evidenceIds"], properties: { campaignId: uuid, instruction: text(4_000), evidenceIds: uuidArray(100) }, example: { campaignId: sample.campaign, instruction: "Draft a factual newsletter body with citations and the required unsubscribe marker.", evidenceIds: [sample.evidence] }, promptId: "email.body-propose", promptVersion: "2026-08-24.1" }),
  define({ id: "campaign-review-record", title: "Record human content review", description: "Create an attributable review of the exact immutable campaign version and required consent, claims, unsubscribe, and sender-identity checks.", operation: "command", recordType: "campaign-review", risk: "moderate", required: ["campaignId", "campaignVersionId", "expectedCampaignVersion", "contentHash", "decision", "checklist", "reason"], properties: { campaignId: uuid, campaignVersionId: uuid, expectedCampaignVersion: integer(1, 1_000_000), contentHash: sha256, decision: { enum: ["approved-for-approval", "changes-requested"] }, checklist: reviewChecklist, reason: text(2_000) }, example: { campaignId: sample.campaign, campaignVersionId: sample.campaignVersion, expectedCampaignVersion: 2, contentHash: "d".repeat(64), decision: "approved-for-approval", checklist: { consentBoundaryReviewed: true, claimsReviewed: true, unsubscribeMechanismReviewed: true, senderIdentityReviewed: true }, reason: "The exact content and recipient purpose were reviewed." } }),
  define({ id: "campaign-approve", title: "Approve exact campaign version", description: "Bind attributable owner or administrator approval to one reviewed content hash; approval never sends or schedules the message.", operation: "command", recordType: "campaign-approval", approvalRequired: true, required: ["campaignId", "campaignVersionId", "expectedCampaignVersion", "contentHash", "reviewId"], properties: { campaignId: uuid, campaignVersionId: uuid, expectedCampaignVersion: integer(1, 1_000_000), contentHash: sha256, reviewId: uuid }, example: { campaignId: sample.campaign, campaignVersionId: sample.campaignVersion, expectedCampaignVersion: 3, contentHash: "d".repeat(64), reviewId: sample.evidence } }),
  define({ id: "campaign-schedule", title: "Schedule approved campaign", description: "Schedule the exact approved content and audience under a fresh human approval; no message or provider call is made.", operation: "command", recordType: "campaign-schedule", approvalRequired: true, required: ["campaignId", "campaignVersionId", "expectedCampaignVersion", "contentHash", "scheduledAt"], properties: { campaignId: uuid, campaignVersionId: uuid, expectedCampaignVersion: integer(1, 1_000_000), contentHash: sha256, scheduledAt: dateTime }, example: { campaignId: sample.campaign, campaignVersionId: sample.campaignVersion, expectedCampaignVersion: 4, contentHash: "d".repeat(64), scheduledAt: "2026-09-01T16:00:00.000Z" } }),
  define({ id: "dispatch-plan-create", title: "Create provider-neutral dispatch plan", description: "Freeze eligible recipient IDs and hashes after a fresh suppression check; the engine stores no credentials and makes no provider request.", operation: "command", recordType: "dispatch-plan", approvalRequired: true, effectBoundary: "dispatch-plan-only", required: ["campaignId", "campaignVersionId", "expectedCampaignVersion", "contentHash", "scheduledAt", "providerAdapterId"], properties: { campaignId: uuid, campaignVersionId: uuid, expectedCampaignVersion: integer(1, 1_000_000), contentHash: sha256, scheduledAt: dateTime, providerAdapterId: { type: "string", pattern: "^[A-Za-z0-9._:-]{3,120}$" } }, example: { campaignId: sample.campaign, campaignVersionId: sample.campaignVersion, expectedCampaignVersion: 5, contentHash: "d".repeat(64), scheduledAt: "2026-09-01T16:00:00.000Z", providerAdapterId: "customer-provider-adapter-v1" } }),
  define({ id: "provider-receipt-ingest", title: "Ingest verified provider receipt", description: "Record a gateway-verified acceptance, delivery, bounce, complaint, or unsubscribe receipt idempotently; hard failures suppress before later plans.", operation: "command", recordType: "provider-receipt", risk: "moderate", effectBoundary: "verified-provider-receipt-ingest", required: ["dispatchPlanId", "subscriberId", "eventId", "eventType", "occurredAt", "providerMessageRefHash", "gatewayVerification"], properties: { dispatchPlanId: uuid, subscriberId: uuid, eventId: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,200}$" }, eventType: { enum: ["accepted", "delivered", "soft-bounce", "hard-bounce", "complaint", "unsubscribe"] }, occurredAt: dateTime, providerMessageRefHash: sha256, gatewayVerification }, example: { dispatchPlanId: sample.dispatchPlan, subscriberId: sample.subscriber, eventId: "provider.event.0001", eventType: "delivered", occurredAt: "2026-09-01T16:01:00.000Z", providerMessageRefHash: "e".repeat(64), gatewayVerification: { verified: true, verifierId: "signed-webhook-gateway-v1", verifiedAt: "2026-09-01T16:01:01.000Z", payloadHash: "f".repeat(64) } } }),
  define({ id: "campaign-analytics-aggregate", title: "Aggregate verified delivery outcomes", description: "Return coarse counts from verified provider receipts only, with no fabricated opens, clicks, revenue, or attribution.", operation: "read", recordType: "provider-receipt", required: ["campaignId", "from", "to"], properties: { campaignId: uuid, from: dateTime, to: dateTime }, example: { campaignId: sample.campaign, from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.000Z" } }),
  define({ id: "audience-export", title: "Create private audience export", description: "Create a content-addressed private export manifest and return authorized rows once; provider credentials and suppression ambiguity are excluded.", operation: "command", recordType: "audience-export", approvalRequired: true, effectBoundary: "private-export", required: ["audienceId", "format", "includeSuppressed"], properties: { audienceId: uuid, format: { enum: ["canonical-json", "csv"] }, includeSuppressed: boolean }, example: { audienceId: sample.audience, format: "canonical-json", includeSuppressed: false } }),
];

export function emailAction(moduleId: string, actionId: string) {
  return moduleId === "email" ? emailActions.find((action) => action.id === actionId) : undefined;
}

export function emailScope(scope: EmailScope) {
  return `email:${scope}`;
}
