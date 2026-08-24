export type FirstPartyGrowthModuleId = "giveaways" | "testimonials" | "brand-pages";
export type FirstPartyGrowthOperation = "read" | "command" | "ai";
export type FirstPartyGrowthScope = "read" | "write" | "ai" | "external";
export type FirstPartyGrowthRisk = "low" | "moderate" | "high";

export interface FirstPartyGrowthJsonSchema {
  type: "object";
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: false;
}

export interface FirstPartyGrowthActionDefinition {
  id: string;
  moduleId: FirstPartyGrowthModuleId;
  productName: "FairLaunch" | "ProofPort" | "BeaconPage";
  title: string;
  description: string;
  operation: FirstPartyGrowthOperation;
  requiredScope: FirstPartyGrowthScope;
  recordType: string;
  risk: FirstPartyGrowthRisk;
  destructive: boolean;
  externalEffect: boolean;
  effectBoundary: "none" | "hosted-public-surface";
  idempotent: true;
  inputSchema: FirstPartyGrowthJsonSchema;
  exampleInput: Record<string, unknown>;
  cliExample: string;
  mcpToolName: string;
  promptId?: string;
  promptVersion?: "2026-08-24.1";
}

const uuid = { type: "string", format: "uuid" };
const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" };
const text = (maxLength = 4_000) => ({ type: "string", minLength: 1, maxLength });
const optionalText = (maxLength = 4_000) => ({ type: "string", maxLength });
const dateTime = { type: "string", format: "date-time" };
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const boolean = { type: "boolean" };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const url = { type: "string", format: "uri", pattern: "^https://" };
const slug = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,79}$" };
const idempotencyKey = { type: "string", pattern: "^[A-Za-z0-9._:-]{16,200}$" };
const uuidArray = (maxItems = 100) => ({ type: "array", maxItems, items: uuid });
const stringArray = (maxItems = 100, maxLength = 500) => ({ type: "array", maxItems, items: text(maxLength) });
const approval = {
  type: "object",
  required: ["approved", "approvedBy", "decisionId", "reason"],
  properties: {
    approved: { const: true },
    approvedBy: uuid,
    decisionId: idempotencyKey,
    reason: text(1_000),
  },
  additionalProperties: false,
};
const consent = {
  type: "object",
  required: ["granted", "policyVersion", "purposes", "capturedAt", "captureMethod"],
  properties: {
    granted: { const: true },
    policyVersion: text(100),
    purposes: { type: "array", minItems: 1, maxItems: 20, items: { enum: ["contest-administration", "referral-attribution", "testimonial-publication", "collection-follow-up"] } },
    capturedAt: dateTime,
    captureMethod: { enum: ["hosted-form", "api-attestation", "signed-import"] },
  },
  additionalProperties: false,
};
const aggregateDimensions = {
  type: "object",
  properties: {
    campaign: optionalText(120),
    referrerCategory: { enum: ["direct", "search", "social", "partner", "other"] },
    deviceClass: { enum: ["desktop", "mobile", "tablet", "unknown"] },
    locale: { type: "string", pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$" },
    variant: optionalText(80),
  },
  additionalProperties: false,
};
const weightedVariants = {
  type: "array",
  minItems: 1,
  maxItems: 20,
  items: {
    type: "object",
    required: ["key", "weight"],
    properties: { key: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,80}$" }, weight: integer(1, 1_000_000) },
    additionalProperties: false,
  },
};
const pageLinks = {
  type: "array",
  maxItems: 100,
  items: {
    type: "object",
    required: ["key", "label", "destinationVersionId"],
    properties: { key: slug, label: text(120), destinationVersionId: uuid, accessibilityLabel: optionalText(200) },
    additionalProperties: false,
  },
};

type Draft = Omit<FirstPartyGrowthActionDefinition, "requiredScope" | "risk" | "destructive" | "externalEffect" | "effectBoundary" | "idempotent" | "inputSchema" | "exampleInput" | "cliExample" | "mcpToolName"> & {
  requiredScope?: FirstPartyGrowthScope;
  risk?: FirstPartyGrowthRisk;
  destructive?: boolean;
  externalEffect?: boolean;
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  example: Record<string, unknown>;
};

function define(draft: Draft): FirstPartyGrowthActionDefinition {
  const {
    required: draftRequired,
    properties: draftProperties,
    example,
    requiredScope,
    risk,
    destructive: draftDestructive,
    externalEffect: draftExternalEffect,
    ...base
  } = draft;
  const mutates = draft.operation !== "read";
  const destructive = draftDestructive ?? false;
  const externalEffect = draftExternalEffect ?? false;
  const properties = { ...draftProperties };
  const required = [...draftRequired];
  const exampleInput = { ...example };
  if (mutates) {
    properties.idempotencyKey = idempotencyKey;
    required.push("idempotencyKey");
    exampleInput.idempotencyKey = `${draft.moduleId}.${draft.id}.sample-0001`;
  }
  if (destructive || externalEffect) {
    properties.dryRun = boolean;
    properties.approval = approval;
    required.push("dryRun");
    exampleInput.dryRun = true;
  }
  const mcpToolName = `${draft.moduleId.replaceAll("-", "_")}_${draft.id.replaceAll("-", "_")}`;
  const cliInput = JSON.stringify(exampleInput).replaceAll("'", "'\\''");
  return {
    ...base,
    requiredScope: requiredScope ?? (draft.operation === "read" ? "read" : draft.operation === "ai" ? "ai" : externalEffect ? "external" : "write"),
    risk: risk ?? (destructive || externalEffect ? "high" : draft.operation === "ai" ? "moderate" : "low"),
    destructive,
    externalEffect,
    effectBoundary: externalEffect ? "hosted-public-surface" : "none",
    idempotent: true,
    inputSchema: { type: "object", required: [...new Set(required)], properties, additionalProperties: false },
    exampleInput,
    cliExample: `supersuite action ${draft.moduleId} ${draft.id} '${cliInput}'`,
    mcpToolName,
  };
}

const sample = {
  actor: "00000000-0000-4000-8000-000000000001",
  contest: "00000000-0000-4000-8000-000000000101",
  entry: "00000000-0000-4000-8000-000000000102",
  record: "00000000-0000-4000-8000-000000000201",
  evidence: "00000000-0000-4000-8000-000000000202",
};

const giveaways: FirstPartyGrowthActionDefinition[] = [
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "contest-create", title: "Create consent-aware contest", description: "Create contest rules, a close clock, capped referral weights, and a precommitted organizer entropy digest before entries exist.", operation: "command", recordType: "contest", required: ["name", "closesAt", "rules", "entropyCommitment", "consentPolicyVersion"], properties: { name: text(160), description: optionalText(4_000), closesAt: dateTime, rules: text(20_000), entropyCommitment: sha256, consentPolicyVersion: text(100), referralBonusCap: integer(0, 20), prizeDescription: optionalText(2_000) }, example: { name: "Launch draw", closesAt: "2026-09-30T16:00:00.000Z", rules: "One consented entry per participant.", entropyCommitment: "a".repeat(64), consentPolicyVersion: "contest-consent-v1", referralBonusCap: 3, prizeDescription: "Annual workspace plan" } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "contest-publish", title: "Publish exact contest version", description: "Make an approved immutable rule snapshot visible on the hosted public surface without contacting another provider.", operation: "command", recordType: "contest", destructive: true, externalEffect: true, required: ["contestId", "expectedVersion", "rulesHash"], properties: { contestId: uuid, expectedVersion: integer(1), rulesHash: sha256 }, example: { contestId: sample.contest, expectedVersion: 1, rulesHash: "b".repeat(64) } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "entry-register", title: "Register privacy-minimized entry", description: "Register one pseudonymous participant key, explicit purpose consent, optional referral, and source attestation without storing protected traits.", operation: "command", recordType: "entrant", risk: "moderate", required: ["contestId", "participantKeyHash", "consent", "sourceAttestation"], properties: { contestId: uuid, participantKeyHash: sha256, displayName: optionalText(120), referralCode: optionalText(100), consent, sourceAttestation: { enum: ["hosted-form", "verified-api", "signed-import"] } }, example: { contestId: sample.contest, participantKeyHash: "c".repeat(64), displayName: "Participant", consent: { granted: true, policyVersion: "contest-consent-v1", purposes: ["contest-administration", "referral-attribution"], capturedAt: "2026-08-24T16:00:00.000Z", captureMethod: "hosted-form" }, sourceAttestation: "hosted-form" } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "entry-consent-revoke", title: "Revoke contest consent", description: "Revoke participant consent, remove eligibility and referral weight, and retain only a non-public compliance receipt.", operation: "command", recordType: "entrant", destructive: true, required: ["entryId", "reason"], properties: { entryId: uuid, reason: text(1_000) }, example: { entryId: sample.entry, reason: "Participant requested withdrawal." } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "fraud-signal-record", title: "Record bounded fraud signal", description: "Record enumerated behavior or attestation evidence for human review; protected-trait inference and autonomous exclusion are forbidden.", operation: "command", recordType: "fraud-signal", risk: "moderate", required: ["entryId", "signalKind", "severity", "evidenceIds", "observationSummary"], properties: { entryId: uuid, signalKind: { enum: ["duplicate-credential", "velocity-anomaly", "referral-loop", "invalid-attestation", "manual-evidence"] }, severity: { enum: ["low", "medium", "high"] }, evidenceIds: uuidArray(50), observationSummary: text(1_000) }, example: { entryId: sample.entry, signalKind: "referral-loop", severity: "medium", evidenceIds: [sample.evidence], observationSummary: "Two mutually referring pseudonymous entries require review." } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "eligibility-decide", title: "Record human eligibility decision", description: "Apply an attributable human eligibility decision against reviewed signal records with an expected-version guard.", operation: "command", recordType: "eligibility-decision", destructive: true, required: ["entryId", "decision", "reviewedSignalIds", "reason", "expectedEntryVersion"], properties: { entryId: uuid, decision: { enum: ["eligible", "excluded"] }, reviewedSignalIds: uuidArray(100), reason: text(2_000), expectedEntryVersion: integer(1) }, example: { entryId: sample.entry, decision: "eligible", reviewedSignalIds: [], reason: "No verified disqualifying evidence.", expectedEntryVersion: 1 } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "draw-snapshot-freeze", title: "Freeze auditable draw candidates", description: "Close entries and freeze sorted candidate IDs, effective weights, eligibility decisions, and a canonical candidate digest.", operation: "command", recordType: "draw-snapshot", destructive: true, required: ["contestId", "expectedContestVersion"], properties: { contestId: uuid, expectedContestVersion: integer(1) }, example: { contestId: sample.contest, expectedContestVersion: 2 } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "winner-draw-reveal", title: "Reveal and verify deterministic winner", description: "Verify the precommitted organizer secret, mix documented public entropy, use rejection sampling, and persist a reproducible winner proof.", operation: "command", recordType: "winner-proof", destructive: true, externalEffect: true, required: ["snapshotId", "entropyReveal", "publicEntropy", "publicEntropySource", "beaconObservedAt"], properties: { snapshotId: uuid, entropyReveal: text(512), publicEntropy: text(2_000), publicEntropySource: url, beaconObservedAt: dateTime }, example: { snapshotId: sample.record, entropyReveal: "organizer-secret-with-at-least-16-chars", publicEntropy: "public-beacon-round-12345", publicEntropySource: "https://example.org/public-randomness/12345", beaconObservedAt: "2026-10-01T00:00:00.000Z" } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "referral-variant-allocate", title: "Allocate referral experience", description: "Deterministically allocate a pseudonymous participant to a weighted experience without recording an event or using raw identity.", operation: "read", recordType: "allocation", required: ["contestId", "participantKeyHash", "experimentId", "variants"], properties: { contestId: uuid, participantKeyHash: sha256, experimentId: uuid, variants: weightedVariants }, example: { contestId: sample.contest, participantKeyHash: "c".repeat(64), experimentId: sample.record, variants: [{ key: "control", weight: 1 }, { key: "short-form", weight: 1 }] } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "aggregate-event-ingest", title: "Ingest aggregate contest event", description: "Persist a deduplicated daily aggregate with allowlisted coarse dimensions and no raw participant identifiers.", operation: "command", recordType: "aggregate-event", required: ["contestId", "eventId", "eventType", "occurredOn", "count", "dimensions"], properties: { contestId: uuid, eventId: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,200}$" }, eventType: { enum: ["view", "entry-start", "entry-complete", "referral-visit", "consent-revoked"] }, occurredOn: date, count: integer(1, 1_000_000_000), dimensions: aggregateDimensions }, example: { contestId: sample.contest, eventId: "contest.event.0001", eventType: "view", occurredOn: "2026-08-24", count: 12, dimensions: { campaign: "launch", deviceClass: "desktop" } } }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "fraud-review-propose", title: "Propose cited fraud review", description: "Queue a model proposal limited to selected behavioral evidence; it cannot infer protected traits or change eligibility.", operation: "ai", recordType: "ai-request-audit", required: ["contestId", "instruction", "evidenceIds"], properties: { contestId: uuid, instruction: text(4_000), evidenceIds: uuidArray(100) }, example: { contestId: sample.contest, instruction: "Summarize evidence and uncertainty without recommending based on protected traits.", evidenceIds: [sample.entry, sample.evidence] }, promptId: "giveaways.fraud-review-propose", promptVersion: "2026-08-24.1" }),
  define({ moduleId: "giveaways", productName: "FairLaunch", id: "contest-export-manifest", title: "Create private contest export", description: "Persist a content-addressed private export manifest for contest rules, consent receipts, decisions, and draw proofs.", operation: "command", recordType: "export-manifest", required: ["contestId", "format", "includeRevokedAudit"], properties: { contestId: uuid, format: { enum: ["canonical-json", "csv"] }, includeRevokedAudit: boolean }, example: { contestId: sample.contest, format: "canonical-json", includeRevokedAudit: true } }),
];

const testimonials: FirstPartyGrowthActionDefinition[] = [
  define({ moduleId: "testimonials", productName: "ProofPort", id: "collection-create", title: "Create testimonial collection", description: "Create a collection purpose, consent policy, moderation rules, and retention window before requesting any statement.", operation: "command", recordType: "collection", required: ["name", "purpose", "consentPolicyVersion", "retentionDays"], properties: { name: text(160), purpose: text(2_000), consentPolicyVersion: text(100), retentionDays: integer(1, 3_650), allowedLocales: stringArray(50, 20) }, example: { name: "Customer outcomes", purpose: "Collect attributable product experiences for reviewed publication.", consentPolicyVersion: "testimonial-consent-v1", retentionDays: 730, allowedLocales: ["en-US"] } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "request-draft", title: "Draft collection request", description: "Create a private request artifact and hosted collection URL; it never sends a message or contacts a provider.", operation: "command", recordType: "collection-request", required: ["collectionId", "recipientRefHash", "expiresAt", "locale"], properties: { collectionId: uuid, recipientRefHash: sha256, expiresAt: dateTime, locale: text(20), contextLabel: optionalText(160) }, example: { collectionId: sample.record, recipientRefHash: "d".repeat(64), expiresAt: "2026-09-30T16:00:00.000Z", locale: "en-US", contextLabel: "Onboarding" } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "submission-record", title: "Record consented testimonial", description: "Store the exact submitted statement, attribution choice, purpose consent, and source provenance as non-public evidence.", operation: "command", recordType: "testimonial", risk: "moderate", required: ["collectionId", "authorName", "content", "attribution", "consent", "sourceRefHash"], properties: { collectionId: uuid, requestId: uuid, authorName: text(120), content: text(20_000), attribution: { enum: ["full-name", "first-name", "anonymous"] }, authorRole: optionalText(160), organization: optionalText(160), consent, sourceRefHash: sha256 }, example: { collectionId: sample.record, requestId: sample.evidence, authorName: "Avery", content: "The reviewed workflow reduced our handoff time.", attribution: "first-name", authorRole: "Operations lead", organization: "Example Co", consent: { granted: true, policyVersion: "testimonial-consent-v1", purposes: ["testimonial-publication"], capturedAt: "2026-08-24T16:00:00.000Z", captureMethod: "hosted-form" }, sourceRefHash: "e".repeat(64) } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "consent-revoke", title: "Revoke testimonial publication", description: "Immediately make every publication version and widget reference non-public while retaining a minimal compliance receipt.", operation: "command", recordType: "testimonial", destructive: true, externalEffect: true, required: ["testimonialId", "reason"], properties: { testimonialId: uuid, reason: text(1_000) }, example: { testimonialId: sample.record, reason: "Author withdrew publication consent." } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "moderation-decide", title: "Record human moderation decision", description: "Record an attributable accept, reject, or redact decision without changing the author's original evidence statement.", operation: "command", recordType: "moderation-decision", destructive: true, required: ["testimonialId", "decision", "reason", "expectedVersion"], properties: { testimonialId: uuid, decision: { enum: ["accept", "reject", "redact"] }, reason: text(2_000), redactedContent: optionalText(20_000), expectedVersion: integer(1) }, example: { testimonialId: sample.record, decision: "accept", reason: "Consent and factual claims reviewed.", expectedVersion: 1 } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "publication-version-create", title: "Create immutable publication version", description: "Create an exact reviewed quote, attribution, disclosure, consent-receipt link, and content digest without publishing it.", operation: "command", recordType: "publication-version", required: ["testimonialId", "content", "attributionLabel", "disclosure", "moderationDecisionId"], properties: { testimonialId: uuid, content: text(20_000), attributionLabel: text(240), disclosure: optionalText(1_000), moderationDecisionId: uuid }, example: { testimonialId: sample.record, content: "The reviewed workflow reduced our handoff time.", attributionLabel: "Avery, Operations lead", disclosure: "Submitted by a customer.", moderationDecisionId: sample.evidence } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "publication-publish", title: "Publish exact testimonial version", description: "Publish a consent-valid immutable version to hosted APIs and widgets after attributable human approval.", operation: "command", recordType: "publication-version", destructive: true, externalEffect: true, required: ["publicationVersionId", "contentHash"], properties: { publicationVersionId: uuid, contentHash: sha256 }, example: { publicationVersionId: sample.record, contentHash: "f".repeat(64) } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "widget-version-create", title: "Create safe widget version", description: "Create a typed display configuration referencing approved publication versions; arbitrary script and HTML fields are not accepted.", operation: "command", recordType: "widget-version", required: ["widgetKey", "name", "publicationVersionIds", "layout", "theme"], properties: { widgetKey: slug, name: text(160), publicationVersionIds: uuidArray(100), layout: { enum: ["grid", "carousel", "quote-wall"] }, theme: { type: "object", required: ["accent", "surface", "text"], properties: { accent: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, surface: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, text: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, radiusPx: integer(0, 40) }, additionalProperties: false } }, example: { widgetKey: "homepage-proof", name: "Homepage proof", publicationVersionIds: [sample.record], layout: "grid", theme: { accent: "#2563EB", surface: "#FFFFFF", text: "#111827", radiusPx: 16 } } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "widget-publish", title: "Publish widget version", description: "Publish one content-addressed widget version and supersede the prior hosted version without third-party calls.", operation: "command", recordType: "widget-version", destructive: true, externalEffect: true, required: ["widgetVersionId", "contentHash"], properties: { widgetVersionId: uuid, contentHash: sha256 }, example: { widgetVersionId: sample.record, contentHash: "1".repeat(64) } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "embed-code-read", title: "Read pinned widget embed", description: "Return a safe script and iframe embed pinned to an approved widget version and the configured hosted origin.", operation: "read", recordType: "widget-version", required: ["widgetVersionId", "mode"], properties: { widgetVersionId: uuid, mode: { enum: ["script", "iframe"] } }, example: { widgetVersionId: sample.record, mode: "script" } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "aggregate-event-ingest", title: "Ingest aggregate widget event", description: "Persist deduplicated aggregate views or interactions with coarse allowlisted dimensions and no visitor identifiers.", operation: "command", recordType: "aggregate-event", required: ["surfaceVersionId", "eventId", "eventType", "occurredOn", "count", "dimensions"], properties: { surfaceVersionId: uuid, eventId: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,200}$" }, eventType: { enum: ["widget-view", "quote-view", "collection-open", "submission-complete"] }, occurredOn: date, count: integer(1, 1_000_000_000), dimensions: aggregateDimensions }, example: { surfaceVersionId: sample.record, eventId: "proof.event.0001", eventType: "widget-view", occurredOn: "2026-08-24", count: 44, dimensions: { campaign: "homepage", deviceClass: "mobile" } } }),
  define({ moduleId: "testimonials", productName: "ProofPort", id: "review-highlights-propose", title: "Propose evidence-cited highlights", description: "Queue a model proposal that may quote only selected testimonial evidence, labels paraphrases, and cannot publish or invent customer claims.", operation: "ai", recordType: "ai-request-audit", required: ["collectionId", "instruction", "evidenceIds"], properties: { collectionId: uuid, instruction: text(4_000), evidenceIds: uuidArray(100) }, example: { collectionId: sample.record, instruction: "Identify supported themes and quote exact evidence only.", evidenceIds: [sample.evidence] }, promptId: "testimonials.review-highlights-propose", promptVersion: "2026-08-24.1" }),
];

const brandPages: FirstPartyGrowthActionDefinition[] = [
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "page-create", title: "Create private branded page", description: "Create a stable slug, accessibility defaults, and privacy mode before any page version becomes public.", operation: "command", recordType: "page", required: ["slug", "name", "privacyMode"], properties: { slug, name: text(160), privacyMode: { enum: ["aggregate", "no-analytics"] }, locale: text(20) }, example: { slug: "founder-links", name: "Founder links", privacyMode: "aggregate", locale: "en-US" } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "destination-version-create", title: "Create safe link destination version", description: "Validate and content-address a public HTTPS destination without fetching it or mutating an active page.", operation: "command", recordType: "destination-version", required: ["pageId", "linkKey", "destination", "label"], properties: { pageId: uuid, linkKey: slug, destination: url, label: text(120), accessibilityLabel: optionalText(200), campaign: { type: "object", properties: { source: optionalText(100), medium: optionalText(100), name: optionalText(100) }, additionalProperties: false } }, example: { pageId: sample.record, linkKey: "docs", destination: "https://example.com/docs", label: "Read the docs", accessibilityLabel: "Open product documentation", campaign: { source: "bio", medium: "link", name: "launch" } } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "page-version-create", title: "Create immutable page version", description: "Create a typed content, layout, theme, and destination-version snapshot with no arbitrary HTML or script.", operation: "command", recordType: "page-version", required: ["pageId", "title", "description", "links", "layout", "theme"], properties: { pageId: uuid, title: text(240), description: optionalText(2_000), links: pageLinks, layout: { enum: ["stack", "cards", "editorial"] }, theme: { type: "object", required: ["accent", "background", "foreground"], properties: { accent: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, background: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, foreground: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, radiusPx: integer(0, 40) }, additionalProperties: false } }, example: { pageId: sample.record, title: "Build in public", description: "Products, notes, and contact links.", links: [{ key: "docs", label: "Read the docs", destinationVersionId: sample.evidence, accessibilityLabel: "Open product documentation" }], layout: "editorial", theme: { accent: "#14B8A6", background: "#0B1020", foreground: "#F8FAFC", radiusPx: 18 } } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "page-version-publish", title: "Publish exact branded page version", description: "Make one reviewed content-addressed page version public and supersede the prior version without third-party calls.", operation: "command", recordType: "page-version", destructive: true, externalEffect: true, required: ["pageVersionId", "contentHash"], properties: { pageVersionId: uuid, contentHash: sha256 }, example: { pageVersionId: sample.record, contentHash: "2".repeat(64) } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "qr-route-create", title: "Create stable branded QR route", description: "Create a stable public QR slug whose destination is changed only through immutable versions.", operation: "command", recordType: "qr-route", required: ["slug", "name", "privacyMode", "style"], properties: { slug, name: text(160), privacyMode: { enum: ["aggregate", "no-analytics"] }, style: { type: "object", required: ["foreground", "background", "errorCorrection"], properties: { foreground: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, background: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, errorCorrection: { enum: ["L", "M", "Q", "H"] }, logoAssetId: uuid }, additionalProperties: false } }, example: { slug: "launch-qr", name: "Launch QR", privacyMode: "aggregate", style: { foreground: "#111827", background: "#FFFFFF", errorCorrection: "M" } } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "qr-destination-version-create", title: "Create QR destination version", description: "Validate and content-address a public HTTPS destination while retaining every prior version and activation receipt.", operation: "command", recordType: "qr-destination-version", required: ["qrRouteId", "destination", "label"], properties: { qrRouteId: uuid, destination: url, label: text(160), campaign: { type: "object", properties: { source: optionalText(100), medium: optionalText(100), name: optionalText(100) }, additionalProperties: false } }, example: { qrRouteId: sample.record, destination: "https://example.com/launch", label: "Launch page", campaign: { source: "packaging", medium: "qr", name: "launch" } } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "qr-destination-activate", title: "Activate exact QR destination", description: "Activate a reviewed content-addressed QR destination version on the hosted redirect surface.", operation: "command", recordType: "qr-destination-version", destructive: true, externalEffect: true, required: ["destinationVersionId", "contentHash"], properties: { destinationVersionId: uuid, contentHash: sha256 }, example: { destinationVersionId: sample.record, contentHash: "3".repeat(64) } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "route-disable", title: "Disable public page or QR route", description: "Remove a page or QR route from the hosted public surface while retaining immutable version and approval history.", operation: "command", recordType: "route", destructive: true, externalEffect: true, required: ["routeId", "routeKind", "reason"], properties: { routeId: uuid, routeKind: { enum: ["page", "qr-route"] }, reason: text(1_000) }, example: { routeId: sample.record, routeKind: "qr-route", reason: "Campaign ended." } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "aggregate-event-ingest", title: "Ingest aggregate page or QR event", description: "Persist a deduplicated coarse daily count with no raw IP, fingerprint, contact identity, or unbounded dimensions.", operation: "command", recordType: "aggregate-event", required: ["routeId", "eventId", "eventType", "occurredOn", "count", "dimensions"], properties: { routeId: uuid, eventId: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,200}$" }, eventType: { enum: ["page-view", "link-activate", "qr-render", "qr-redirect"] }, occurredOn: date, count: integer(1, 1_000_000_000), dimensions: aggregateDimensions }, example: { routeId: sample.record, eventId: "beacon.event.0001", eventType: "qr-redirect", occurredOn: "2026-08-24", count: 18, dimensions: { referrerCategory: "direct", deviceClass: "mobile" } } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "variant-allocate", title: "Allocate page variant deterministically", description: "Deterministically allocate a caller-provided pseudonymous hash to weighted page variants without persisting visitor state.", operation: "read", recordType: "allocation", required: ["experimentId", "visitorKeyHash", "variants"], properties: { experimentId: uuid, visitorKeyHash: sha256, variants: weightedVariants }, example: { experimentId: sample.record, visitorKeyHash: "4".repeat(64), variants: [{ key: "control", weight: 2 }, { key: "editorial", weight: 1 }] } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "embed-code-read", title: "Read pinned page embed", description: "Return a sandboxed iframe embed pinned to an approved page version and the configured hosted origin.", operation: "read", recordType: "page-version", required: ["pageVersionId"], properties: { pageVersionId: uuid }, example: { pageVersionId: sample.record } }),
  define({ moduleId: "brand-pages", productName: "BeaconPage", id: "page-copy-propose", title: "Propose evidence-grounded page copy", description: "Queue a model proposal bounded to selected source records; it cannot publish, invent claims, or change destinations.", operation: "ai", recordType: "ai-request-audit", required: ["pageId", "instruction", "evidenceIds"], properties: { pageId: uuid, instruction: text(4_000), evidenceIds: uuidArray(100) }, example: { pageId: sample.record, instruction: "Draft concise page copy using only cited product facts.", evidenceIds: [sample.evidence] }, promptId: "brand-pages.page-copy-propose", promptVersion: "2026-08-24.1" }),
];

export const firstPartyGrowthActions: FirstPartyGrowthActionDefinition[] = [...giveaways, ...testimonials, ...brandPages];

export const firstPartyGrowthActionsByModule = new Map<FirstPartyGrowthModuleId, FirstPartyGrowthActionDefinition[]>(
  (["giveaways", "testimonials", "brand-pages"] as const).map((moduleId) => [moduleId, firstPartyGrowthActions.filter((action) => action.moduleId === moduleId)]),
);

export function firstPartyGrowthAction(moduleId: string, actionId: string) {
  return firstPartyGrowthActions.find((action) => action.moduleId === moduleId && action.id === actionId);
}

export function isFirstPartyGrowthModule(moduleId: string): moduleId is FirstPartyGrowthModuleId {
  return moduleId === "giveaways" || moduleId === "testimonials" || moduleId === "brand-pages";
}
