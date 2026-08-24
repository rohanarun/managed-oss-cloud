export type EsignModuleId = "esign";
export type EsignOperation = "read" | "command" | "ai";
export type EsignScope = "read" | "write" | "ai" | "external";
export type EsignRisk = "low" | "moderate" | "high";

export interface EsignJsonSchema {
  type: "object";
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: false;
}

export interface EsignActionDefinition {
  id: string;
  moduleId: EsignModuleId;
  productName: "E-Signature Workflow";
  title: string;
  description: string;
  operation: EsignOperation;
  requiredScope: EsignScope;
  recordType: string;
  risk: EsignRisk;
  approvalRequired: boolean;
  destructive: boolean;
  externalEffect: false;
  effectBoundary: "none" | "dispatch-plan-only" | "private-token-issuance" | "private-export";
  idempotent: true;
  inputSchema: EsignJsonSchema;
  exampleInput: Record<string, unknown>;
  cliExample: string;
  mcpToolName: string;
  promptId?: "esign.clause-propose" | "esign.field-routing-propose";
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
const signerRoles = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    type: "object",
    required: ["role", "order"],
    properties: {
      role: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9 _.-]{0,79}$" },
      order: integer(1, 50),
      description: optionalText(500),
    },
    additionalProperties: false,
  },
};
const templateFields = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: {
    type: "object",
    required: ["fieldId", "signerRole", "kind", "page", "xBasisPoints", "yBasisPoints", "widthBasisPoints", "heightBasisPoints", "required"],
    properties: {
      fieldId: uuid,
      signerRole: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9 _.-]{0,79}$" },
      kind: { enum: ["signature", "initials", "text", "date", "checkbox"] },
      page: integer(1, 10_000),
      xBasisPoints: integer(0, 10_000),
      yBasisPoints: integer(0, 10_000),
      widthBasisPoints: integer(1, 10_000),
      heightBasisPoints: integer(1, 10_000),
      required: boolean,
      label: optionalText(160),
    },
    additionalProperties: false,
  },
};
const signerRoutes = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    type: "object",
    required: ["signerId", "signerKeyHash", "role", "order", "authentication", "locale"],
    properties: {
      signerId: uuid,
      signerKeyHash: sha256,
      role: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9 _.-]{0,79}$" },
      order: integer(1, 50),
      authentication: { enum: ["access-link", "shared-secret", "platform-account"] },
      locale: { type: "string", pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$" },
      displayLabel: optionalText(120),
    },
    additionalProperties: false,
  },
};
const fieldFacts = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: {
    type: "object",
    required: ["fieldId", "valueHash", "completedAt", "method"],
    properties: {
      fieldId: uuid,
      valueHash: sha256,
      completedAt: dateTime,
      method: { enum: ["typed-name", "drawn-mark", "typed-text", "selected-checkbox", "entered-date"] },
    },
    additionalProperties: false,
  },
};

type Draft = Omit<EsignActionDefinition, "moduleId" | "productName" | "requiredScope" | "risk" | "approvalRequired" | "destructive" | "externalEffect" | "effectBoundary" | "idempotent" | "inputSchema" | "exampleInput" | "cliExample" | "mcpToolName"> & {
  requiredScope?: EsignScope;
  risk?: EsignRisk;
  approvalRequired?: boolean;
  destructive?: boolean;
  effectBoundary?: EsignActionDefinition["effectBoundary"];
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  example: Record<string, unknown>;
};

function define(draft: Draft): EsignActionDefinition {
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
    exampleInput.idempotencyKey = `esign.${draft.id}.sample-0001`;
  }
  if (approvalRequired) {
    properties.dryRun = boolean;
    properties.approval = approval;
    required.push("dryRun");
    exampleInput.dryRun = true;
  }
  const mcpToolName = `esign_${draft.id.replaceAll("-", "_")}`;
  const cliInput = JSON.stringify(exampleInput).replaceAll("'", "'\\''");
  return {
    ...base,
    moduleId: "esign",
    productName: "E-Signature Workflow",
    requiredScope: requiredScope ?? (draft.operation === "read" ? "read" : draft.operation === "ai" ? "ai" : approvalRequired ? "external" : "write"),
    risk: risk ?? (approvalRequired ? "high" : draft.operation === "ai" ? "moderate" : "low"),
    approvalRequired,
    destructive,
    externalEffect: false,
    effectBoundary,
    idempotent: true,
    inputSchema: { type: "object", required: [...new Set(required)], properties, additionalProperties: false },
    exampleInput,
    cliExample: `supersuite action esign ${draft.id} '${cliInput}'`,
    mcpToolName,
  };
}

const sample = {
  actor: "00000000-0000-4000-8000-000000000001",
  template: "00000000-0000-4000-8000-000000000101",
  templateVersion: "00000000-0000-4000-8000-000000000102",
  document: "00000000-0000-4000-8000-000000000103",
  envelope: "00000000-0000-4000-8000-000000000104",
  signer: "00000000-0000-4000-8000-000000000105",
  field: "00000000-0000-4000-8000-000000000106",
  evidence: "00000000-0000-4000-8000-000000000107",
};

export const esignActions: EsignActionDefinition[] = [
  define({ id: "template-create", title: "Create reusable agreement template", description: "Create a private template container with a stated business purpose; no document or signature is inferred.", operation: "command", recordType: "template", required: ["name", "purpose"], properties: { name: text(160), purpose: text(2_000) }, example: { name: "Mutual agreement", purpose: "Collect reviewed approvals for one agreement type." } }),
  define({ id: "template-version-create", title: "Create immutable template version", description: "Freeze signer roles, normalized field geometry, disclosure text, and an exact content hash under an optimistic template-version guard.", operation: "command", recordType: "template-version", required: ["templateId", "expectedTemplateVersion", "signerRoles", "fields", "disclosure"], properties: { templateId: uuid, expectedTemplateVersion: integer(0, 1_000_000), signerRoles, fields: templateFields, disclosure: text(10_000), instructions: optionalText(10_000) }, example: { templateId: sample.template, expectedTemplateVersion: 0, signerRoles: [{ role: "Signer", order: 1 }], fields: [{ fieldId: sample.field, signerRole: "Signer", kind: "signature", page: 1, xBasisPoints: 1_000, yBasisPoints: 8_000, widthBasisPoints: 3_000, heightBasisPoints: 800, required: true }], disclosure: "Review the document and choose whether to complete or decline." } }),
  define({ id: "document-register", title: "Register content-addressed document", description: "Register an existing private object by opaque reference, exact object version, byte count, media type, page count, and SHA-256 without uploading or fetching it.", operation: "command", recordType: "document", risk: "moderate", required: ["title", "objectRef", "objectVersion", "sha256", "sizeBytes", "contentType", "pageCount"], properties: { title: text(240), objectRef: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9/_.,:=+@-]{0,511}$" }, objectVersion: text(200), sha256, sizeBytes: integer(1, 10_000_000_000), contentType: { enum: ["application/pdf"] }, pageCount: integer(1, 10_000) }, example: { title: "agreement.pdf", objectRef: "tenant/contracts/agreement-v1.pdf", objectVersion: "generation-0001", sha256: "a".repeat(64), sizeBytes: 42_000, contentType: "application/pdf", pageCount: 3 } }),
  define({ id: "envelope-draft", title: "Draft signer and routing envelope", description: "Bind one exact template version and document hash to privacy-minimized signer routes without contacting any signer.", operation: "command", recordType: "envelope", risk: "moderate", required: ["title", "templateVersionId", "documentId", "documentHash", "signers", "expiresAt"], properties: { title: text(240), templateVersionId: uuid, documentId: uuid, documentHash: sha256, signers: signerRoutes, expiresAt: dateTime, message: optionalText(4_000) }, example: { title: "Agreement for review", templateVersionId: sample.templateVersion, documentId: sample.document, documentHash: "a".repeat(64), signers: [{ signerId: sample.signer, signerKeyHash: "b".repeat(64), role: "Signer", order: 1, authentication: "access-link", locale: "en-US", displayLabel: "Primary signer" }], expiresAt: "2026-09-24T18:00:00.000Z", message: "Please review the attached agreement." } }),
  define({ id: "envelope-preview", title: "Preview exact dispatch boundary", description: "Return a content-addressed dispatch preview for the current envelope version without mutating state or contacting a provider.", operation: "read", recordType: "envelope", required: ["envelopeId", "expectedVersion"], properties: { envelopeId: uuid, expectedVersion: integer(1, 1_000_000) }, example: { envelopeId: sample.envelope, expectedVersion: 1 } }),
  define({ id: "envelope-dispatch-plan", title: "Approve manual dispatch plan", description: "Persist an approved plan for hosted-link, manual export, or API handoff; it does not send a message or claim provider delivery.", operation: "command", recordType: "dispatch-plan", approvalRequired: true, effectBoundary: "dispatch-plan-only", required: ["envelopeId", "expectedVersion", "previewHash", "channel"], properties: { envelopeId: uuid, expectedVersion: integer(1, 1_000_000), previewHash: sha256, channel: { enum: ["hosted-link", "manual-export", "api-handoff"] } }, example: { envelopeId: sample.envelope, expectedVersion: 1, previewHash: "c".repeat(64), channel: "hosted-link" } }),
  define({ id: "signer-session-issue", title: "Issue private signer session", description: "Issue one time-limited signer session and persist only its token hash; plaintext token material is returned once through private output.", operation: "command", recordType: "signer-session", approvalRequired: true, effectBoundary: "private-token-issuance", required: ["envelopeId", "signerId", "expectedEnvelopeVersion", "expiresAt"], properties: { envelopeId: uuid, signerId: uuid, expectedEnvelopeVersion: integer(1, 1_000_000), expiresAt: dateTime }, example: { envelopeId: sample.envelope, signerId: sample.signer, expectedEnvelopeVersion: 2, expiresAt: "2026-08-25T18:00:00.000Z" } }),
  define({ id: "field-completion-record", title: "Record signer field completion facts", description: "Record hashes and clocks for every required field in one signer session; this records workflow facts but makes no identity, intent, or qualified-signature claim.", operation: "command", recordType: "field-completion", approvalRequired: true, effectBoundary: "none", required: ["envelopeId", "signerId", "sessionToken", "expectedEnvelopeVersion", "expectedSessionVersion", "fieldFacts"], properties: { envelopeId: uuid, signerId: uuid, sessionToken: { type: "string", pattern: "^esig_[A-Za-z0-9_-]{40,100}$" }, expectedEnvelopeVersion: integer(1, 1_000_000), expectedSessionVersion: integer(1, 1_000_000), fieldFacts }, example: { envelopeId: sample.envelope, signerId: sample.signer, sessionToken: `esig_${"A".repeat(43)}`, expectedEnvelopeVersion: 3, expectedSessionVersion: 1, fieldFacts: [{ fieldId: sample.field, valueHash: "d".repeat(64), completedAt: "2026-08-24T18:10:00.000Z", method: "drawn-mark" }] } }),
  define({ id: "decline-record", title: "Record explicit decline", description: "Record an attributable decline through the exact signer-session boundary and stop the envelope without implying a signature occurred.", operation: "command", recordType: "decline-event", approvalRequired: true, destructive: true, required: ["envelopeId", "signerId", "sessionToken", "expectedEnvelopeVersion", "expectedSessionVersion", "reason"], properties: { envelopeId: uuid, signerId: uuid, sessionToken: { type: "string", pattern: "^esig_[A-Za-z0-9_-]{40,100}$" }, expectedEnvelopeVersion: integer(1, 1_000_000), expectedSessionVersion: integer(1, 1_000_000), reason: text(2_000) }, example: { envelopeId: sample.envelope, signerId: sample.signer, sessionToken: `esig_${"A".repeat(43)}`, expectedEnvelopeVersion: 3, expectedSessionVersion: 1, reason: "I do not agree to these terms." } }),
  define({ id: "envelope-void", title: "Void incomplete envelope", description: "Void an incomplete envelope under an optimistic version guard, revoke open signer sessions, and retain immutable history.", operation: "command", recordType: "void-event", approvalRequired: true, destructive: true, required: ["envelopeId", "expectedVersion", "reason"], properties: { envelopeId: uuid, expectedVersion: integer(1, 1_000_000), reason: text(2_000) }, example: { envelopeId: sample.envelope, expectedVersion: 3, reason: "The underlying agreement was replaced." } }),
  define({ id: "reminder-plan", title: "Create approved reminder plan", description: "Create a content-addressed reminder plan for a pending signer; it never sends a reminder or claims provider acceptance.", operation: "command", recordType: "reminder-plan", approvalRequired: true, effectBoundary: "dispatch-plan-only", required: ["envelopeId", "signerId", "expectedEnvelopeVersion", "channel", "notBefore"], properties: { envelopeId: uuid, signerId: uuid, expectedEnvelopeVersion: integer(1, 1_000_000), channel: { enum: ["hosted-link", "manual-export", "api-handoff"] }, notBefore: dateTime, previewHash: sha256, note: optionalText(2_000) }, example: { envelopeId: sample.envelope, signerId: sample.signer, expectedEnvelopeVersion: 3, channel: "hosted-link", notBefore: "2026-08-25T18:00:00.000Z", note: "One reviewed reminder." } }),
  define({ id: "certificate-export", title: "Export immutable workflow certificate", description: "Create a content-addressed private certificate manifest from exact workflow hashes and audit facts; it is not a legal-compliance certification or qualified-signature attestation.", operation: "command", recordType: "certificate", approvalRequired: true, effectBoundary: "private-export", required: ["envelopeId", "expectedVersion", "format"], properties: { envelopeId: uuid, expectedVersion: integer(1, 1_000_000), format: { enum: ["canonical-json"] } }, example: { envelopeId: sample.envelope, expectedVersion: 4, format: "canonical-json" } }),
  define({ id: "clause-propose", title: "Propose cited agreement clauses", description: "Queue a model proposal grounded only in selected records; proposed text never changes a template, signs, consents, or provides legal advice.", operation: "ai", recordType: "ai-request-audit", required: ["templateVersionId", "instruction", "evidenceIds"], properties: { templateVersionId: uuid, instruction: text(4_000), evidenceIds: uuidArray(100) }, example: { templateVersionId: sample.templateVersion, instruction: "Suggest clearer language and identify unsupported assumptions for human and legal review.", evidenceIds: [sample.templateVersion, sample.evidence] }, promptId: "esign.clause-propose", promptVersion: "2026-08-24.1" }),
  define({ id: "field-routing-propose", title: "Propose cited fields and routing", description: "Queue a cited model proposal for field placement or signer order; it cannot create a field, route, session, dispatch, signature, or consent event.", operation: "ai", recordType: "ai-request-audit", required: ["documentId", "instruction", "evidenceIds"], properties: { documentId: uuid, instruction: text(4_000), evidenceIds: uuidArray(100) }, example: { documentId: sample.document, instruction: "Propose required fields and routing with a citation for every suggestion.", evidenceIds: [sample.document, sample.evidence] }, promptId: "esign.field-routing-propose", promptVersion: "2026-08-24.1" }),
];

export function esignAction(moduleId: string, actionId: string) {
  return moduleId === "esign" ? esignActions.find((action) => action.id === actionId) : undefined;
}

export function esignScope(scope: EsignScope) {
  return `esign:${scope}`;
}
