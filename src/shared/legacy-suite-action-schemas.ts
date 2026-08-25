type JsonProperty = Record<string, unknown>;

export interface LegacySuiteActionInputSchema {
  type: "object";
  required: string[];
  properties: Record<string, JsonProperty>;
  additionalProperties: false;
}

export const legacySuiteModuleIds = ["consent", "seo", "finance", "notify", "hire", "collab", "schedule", "forms", "flags"] as const;
export type LegacySuiteModuleId = typeof legacySuiteModuleIds[number];

const UUID_EXAMPLE = "00000000-0000-4000-8000-000000000001";
const HASH_EXAMPLE = "0".repeat(64);

function string(description: string, example: string, options: Record<string, unknown> = {}): JsonProperty {
  return { type: "string", minLength: 1, description, examples: [example], ...options };
}

function uuid(description: string): JsonProperty {
  return string(description, UUID_EXAMPLE, { format: "uuid" });
}

function dateTime(description: string): JsonProperty {
  return string(description, "2030-01-01T12:00:00Z", { format: "date-time", maxLength: 40 });
}

function integer(description: string, example = 1, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): JsonProperty {
  return { type: "integer", minimum, maximum, description, examples: [example] };
}

function number(description: string, example = 1, minimum = 0, maximum = 100_000): JsonProperty {
  return { type: "number", minimum, maximum, description, examples: [example] };
}

function boolean(description: string, example = true): JsonProperty {
  return { type: "boolean", description, examples: [example] };
}

function json(description: string, example: unknown): JsonProperty {
  return { description, examples: [example] };
}

function object(
  description: string,
  properties: Record<string, JsonProperty>,
  required: string[] = [],
  example?: Record<string, unknown>,
  additionalProperties = false,
): JsonProperty {
  return {
    type: "object",
    description,
    required,
    properties,
    additionalProperties,
    ...(example ? { examples: [example] } : {}),
  };
}

function openObject(description: string, example: Record<string, unknown>): JsonProperty {
  return { type: "object", description, additionalProperties: true, examples: [example] };
}

function array(
  description: string,
  items: JsonProperty,
  example: unknown[],
  minimum = 0,
  maximum = 100,
  uniqueItems = false,
): JsonProperty {
  return {
    type: "array",
    description,
    items,
    minItems: minimum,
    maxItems: maximum,
    ...(uniqueItems ? { uniqueItems: true } : {}),
    examples: [example],
  };
}

function schema(required: string[], properties: Record<string, JsonProperty>): LegacySuiteActionInputSchema {
  for (const field of required) {
    if (!(field in properties)) throw new Error(`Legacy action schema is missing required property ${field}.`);
  }
  return { type: "object", required: [...required], properties, additionalProperties: false };
}

const name = (label = "Name") => string(`${label}, stored as non-empty plain text.`, `Sample ${label}`, { maxLength: 200 });
const title = (label = "Title") => string(`${label}, stored as non-empty plain text.`, `Sample ${label}`, { maxLength: 240 });
const genericName = (label = "Name") => string(`${label}, stored as non-empty plain text.`, `Sample ${label}`);
const instruction = string("Bounded instruction for a proposal-only model run.", "Explain the reviewed evidence without adding unsupported facts.", { maxLength: 4_000 });
const legacyInstruction = string("Instruction for a proposal-only model run.", "Explain the reviewed evidence without adding unsupported facts.");
const contentHash = string("Lowercase SHA-256 digest of the exact reviewed content.", HASH_EXAMPLE, { pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 });
const idempotencyKey = string("Caller-generated idempotency key for replay-safe mutation.", "request.sample-0001", { pattern: "^[A-Za-z0-9._:-]{16,200}$", maxLength: 200 });
const currency = string("Three-letter uppercase ISO 4217 currency code.", "USD", { pattern: "^[A-Z]{3}$", minLength: 3, maxLength: 3 });
const locale = string("BCP 47-style locale identifier.", "en-US", { pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$", maxLength: 35 });
const hostname = string("Canonical public hostname without a scheme or path.", "app.example.com", { pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$", maxLength: 253 });
const httpUrl = string("Public HTTP or HTTPS URL.", "https://example.com/page", { format: "uri", pattern: "^https?://" });
const timeZone = string("IANA time-zone identifier.", "America/New_York", { maxLength: 100 });
const stableKey = (description: string, example = "sample-key", maximum = 80) => string(description, example, { pattern: `^[a-z][a-z0-9-]{1,${maximum - 1}}$`, maxLength: maximum });
const notifyKey = (description: string, example: string) => string(description, example, { pattern: "^[a-z][a-z0-9.-]{1,99}$", maxLength: 100 });
const uuidArray = (description: string, minimum = 1, maximum = 100) => array(description, uuid("Workspace-owned record UUID."), [UUID_EXAMPLE], minimum, maximum, true);
const emptySchema = () => schema([], {});

const consentPurpose = object(
  "Immutable consent purpose snapshot.",
  {
    key: stableKey("Stable purpose key.", "essential-service", 64),
    label: string("Human-readable purpose label.", "Essential service", { maxLength: 120 }),
    description: string("Plain-language purpose description.", "Required to provide the requested service.", { maxLength: 1_000 }),
    required: boolean("Whether this purpose is essential and cannot be disabled."),
  },
  ["key", "label", "description", "required"],
  { key: "essential-service", label: "Essential service", description: "Required to provide the requested service.", required: true },
);

const consentService = object(
  "Immutable service snapshot bound to declared purposes.",
  {
    key: stableKey("Stable service key.", "session-service", 64),
    label: string("Human-readable service label.", "Session service", { maxLength: 160 }),
    description: string("Plain-language service description.", "Maintains the signed-in session.", { maxLength: 1_000 }),
    purposeKeys: array("Declared purpose keys used by the service.", stableKey("Purpose key.", "essential-service", 64), ["essential-service"], 1, 100),
    resourceRules: array("Optional bounded resource-matching rules.", string("Resource rule.", "cdn.example.com/*", { maxLength: 500 }), ["cdn.example.com/*"], 0, 100),
  },
  ["key", "label", "description", "purposeKeys"],
  { key: "session-service", label: "Session service", description: "Maintains the signed-in session.", purposeKeys: ["essential-service"] },
);

const consentDecision = object(
  "One explicit decision for a declared consent purpose.",
  { key: stableKey("Purpose key.", "essential-service", 64), allowed: boolean("Whether the visitor allowed the purpose.") },
  ["key", "allowed"],
  { key: "essential-service", allowed: true },
);

const notifyChannels = array(
  "Unique supported notification channels.",
  string("Notification channel.", "inbox", { enum: ["inbox", "email", "sms", "push", "chat"] }),
  ["inbox"],
  1,
  5,
  true,
);

const notifySchemaProperty = object(
  "Safe scalar event-property definition.",
  {
    type: string("Scalar property type.", "string", { enum: ["string", "integer", "number", "boolean"] }),
    maxLength: integer("Optional maximum string length.", 200, 1, 4_000),
    enum: array("Optional bounded scalar enum.", json("Scalar enum member.", "sample"), ["sample"], 1, 100, true),
  },
  ["type"],
  { type: "string", maxLength: 200 },
);

const notifyEventSchema = object(
  "Supported safe subset of an object JSON Schema.",
  {
    type: { const: "object", description: "Event schemas are objects.", examples: ["object"] },
    additionalProperties: { const: false, description: "Undeclared event fields are rejected.", examples: [false] },
    properties: { type: "object", description: "Map of one to 100 event-property names to safe scalar definitions.", propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$", maxLength: 64 }, minProperties: 1, maxProperties: 100, additionalProperties: notifySchemaProperty, examples: [{ message: { type: "string", maxLength: 200 } }] },
    required: array("Optional required event-property names.", string("Declared property name.", "message", { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$", maxLength: 64 }), ["message"], 0, 100, true),
  },
  ["type", "additionalProperties", "properties"],
  { type: "object", additionalProperties: false, properties: { message: { type: "string", maxLength: 200 } }, required: ["message"] },
);

const notifyTemplate = object(
  "Safe plain-text notification template.",
  {
    subject: string("Plain-text subject template.", "Account update", { maxLength: 300 }),
    body: string("Plain-text body template.", "{{message}}", { maxLength: 10_000 }),
  },
  ["subject", "body"],
  { subject: "Account update", body: "{{message}}" },
);

const applicationAnswer = object(
  "Candidate-supplied answer. Additional safe response fields are retained by the runtime.",
  { key: string("Application question key.", "portfolio", { maxLength: 100 }) },
  ["key"],
  { key: "portfolio", value: "https://example.com/work" },
  true,
);

const rating = object(
  "Evidence-linked structured interview rating.",
  {
    criterion: string("Competency or criterion being rated.", "Problem solving", { maxLength: 200 }),
    rating: integer("Whole-number rating from one to five.", 4, 1, 5),
    evidence: string("Observed evidence supporting the rating.", "Explained tradeoffs using a concrete example.", { maxLength: 2_000 }),
  },
  ["criterion", "rating", "evidence"],
  { criterion: "Problem solving", rating: 4, evidence: "Explained tradeoffs using a concrete example." },
);

const collabItemTypes = ["paragraph", "heading", "list", "checklist", "quote", "code", "table", "callout", "divider", "attachment", "embed", "record-link", "rectangle", "ellipse", "diamond", "line", "arrow", "freehand", "text", "sticky-note", "frame", "image"];
const collabItem = object(
  "Safe document block or canvas element. Runtime-defined presentation fields remain available.",
  {
    id: string("Stable resource item ID.", "item-1", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", maxLength: 80 }),
    type: string("Supported document block or canvas element type.", "paragraph", { enum: collabItemTypes }),
    provider: string("Optional safe reference provider.", "record", { enum: ["asset", "record", "external-link"] }),
    width: number("Optional finite item width.", 640, 0, 100_000),
    height: number("Optional finite item height.", 480, 0, 100_000),
  },
  ["id", "type"],
  { id: "item-1", type: "paragraph", text: "Shared draft" },
  true,
);

const documentBlock = object(
  "Safe structured document block. Runtime-defined presentation fields remain available.",
  {
    id: string("Stable block ID.", "block-1", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", maxLength: 80 }),
    type: string("Supported document block type.", "paragraph", { enum: ["paragraph", "heading", "list", "checklist", "quote", "code", "table", "callout", "divider", "attachment", "embed", "record-link"] }),
    provider: string("Optional safe reference provider.", "record", { enum: ["asset", "record", "external-link"] }),
  },
  ["id", "type"],
  { id: "block-1", type: "paragraph", text: "Shared draft" },
  true,
);

const canvasElement = object(
  "Safe finite canvas element. Runtime-defined presentation fields remain available.",
  {
    id: string("Stable element ID.", "element-1", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", maxLength: 80 }),
    type: string("Supported canvas element type.", "rectangle", { enum: ["rectangle", "ellipse", "diamond", "line", "arrow", "freehand", "text", "sticky-note", "frame", "image", "record-link"] }),
    provider: string("Optional safe reference provider.", "record", { enum: ["asset", "record", "external-link"] }),
    width: number("Optional finite element width.", 640, 0, 100_000),
    height: number("Optional finite element height.", 480, 0, 100_000),
  },
  ["id", "type"],
  { id: "element-1", type: "rectangle", width: 640, height: 480 },
  true,
);

const collabOperation = {
  anyOf: [
    object("Upsert one safe resource item.", { op: { const: "upsert", examples: ["upsert"] }, item: collabItem }, ["op", "item"], { op: "upsert", item: { id: "item-1", type: "paragraph", text: "Shared draft" } }),
    object("Remove one resource item.", { op: { const: "remove", examples: ["remove"] }, id: string("Resource item ID.", "item-1", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", maxLength: 80 }) }, ["op", "id"], { op: "remove", id: "item-1" }),
    object("Move one item after another item or to the beginning.", { op: { const: "move", examples: ["move"] }, id: string("Resource item ID.", "item-1", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", maxLength: 80 }), afterId: { anyOf: [string("Preceding item ID.", "item-0", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", maxLength: 80 }), { type: "null" }], examples: [null] } }, ["op", "id"], { op: "move", id: "item-1" }),
  ],
  description: "Bounded collaboration operation.",
  examples: [{ op: "upsert", item: { id: "item-1", type: "paragraph", text: "Shared draft" } }],
} satisfies JsonProperty;

const scheduleWindow = object(
  "Weekly availability window in the schedule time zone.",
  {
    dayOfWeek: integer("Day of week, Sunday zero through Saturday six.", 1, 0, 6),
    start: string("Inclusive local start time in HH:MM.", "09:00", { pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", maxLength: 5 }),
    end: string("Exclusive local end time in HH:MM.", "17:00", { pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", maxLength: 5 }),
  },
  ["dayOfWeek", "start", "end"],
  { dayOfWeek: 1, start: "09:00", end: "17:00" },
);

const bookingInviteeConsent = object(
  "Explicit privacy-policy consent captured with a public booking.",
  {
    granted: { const: true, description: "The invitee explicitly accepted the disclosed booking-data purpose.", examples: [true] },
    policyVersion: string("Immutable version of the privacy notice shown to the invitee.", "booking-privacy-v1", { maxLength: 100 }),
  },
  ["granted", "policyVersion"],
  { granted: true, policyVersion: "booking-privacy-v1" },
);

const bookingInvitee = object(
  "Private invitee details captured by a booking surface. These values are never part of public projections.",
  {
    name: string("Invitee display name.", "Asha Patel", { maxLength: 160 }),
    email: string("Invitee email address.", "asha@example.com", { format: "email", maxLength: 254 }),
    timeZone,
    notes: string("Optional bounded notes supplied by the invitee.", "I would like to discuss onboarding.", { maxLength: 2_000 }),
    consent: bookingInviteeConsent,
  },
  ["name", "email", "timeZone", "consent"],
  { name: "Asha Patel", email: "asha@example.com", timeZone: "America/New_York", consent: { granted: true, policyVersion: "booking-privacy-v1" } },
);

const formField = object(
  "Bounded form field definition.",
  {
    key: stableKey("Stable form field key."),
    type: string("Supported form field type.", "short-text", { enum: ["short-text", "long-text", "boolean", "integer", "decimal", "date", "date-time", "choice", "multi-choice", "email", "url"] }),
    required: boolean("Whether a response value is required.", false),
    purpose: string("Plain-language collection purpose.", "Respond to the inquiry."),
    privacy: string("Field privacy classification.", "internal", { enum: ["public", "internal", "restricted"] }),
    choices: array("Allowed choice values.", string("Choice label.", "Yes"), ["Yes", "No"], 1, 100),
  },
  ["key", "type", "purpose", "privacy"],
  { key: "message", type: "short-text", required: true, purpose: "Respond to the inquiry.", privacy: "internal" },
);

const formSchema = object(
  "Versioned bounded form schema.",
  {
    version: json("Optional schema version metadata; the current validator canonicalizes releases to version one.", 1),
    fields: array("Form field definitions.", formField, [{ key: "message", type: "short-text", required: true, purpose: "Respond to the inquiry.", privacy: "internal" }], 1, 200),
  },
  [],
  { version: 1, fields: [{ key: "message", type: "short-text", required: true, purpose: "Respond to the inquiry.", privacy: "internal" }] },
);

const formLogicRule = object(
  "Safe conditional form-logic rule. Additional declarative metadata is retained.",
  {
    when: openObject("Declarative condition object.", { field: "message", equals: "hello" }),
    effect: string("Supported logic effect.", "show", { enum: ["show", "hide", "require"] }),
    target: stableKey("Target form field key."),
  },
  ["when", "effect", "target"],
  { when: { field: "message", equals: "hello" }, effect: "show", target: "details" },
  true,
);

const flagValueType = string("Declared feature-flag value type.", "boolean", { enum: ["boolean", "integer", "decimal", "string", "json"] });
const flagVariant = object(
  "Feature-flag variant.",
  {
    key: stableKey("Stable variant key.", "enabled"),
    value: json("Variant value matching the declared value type.", true),
    weight: integer("Optional allocation weight in ten-thousandths.", 10_000, 0, 10_000),
  },
  ["key", "value"],
  { key: "enabled", value: true, weight: 10_000 },
);

const flagRule = object(
  "Safe feature targeting rule.",
  {
    attribute: string("Non-sensitive context attribute path.", "account.plan", { pattern: "^[a-z][a-zA-Z0-9_.-]{0,63}$", maxLength: 64 }),
    operator: string("Supported comparison operator.", "eq", { enum: ["eq", "in"] }),
    value: json("Comparison value.", "pro"),
    variant: stableKey("Declared variant key.", "enabled"),
  },
  ["attribute", "operator", "variant"],
  { attribute: "account.plan", operator: "eq", value: "pro", variant: "enabled" },
);

const rolloutContext = object(
  "Evaluation vector for rollout preview. Additional descriptive vector fields are retained.",
  {
    context: openObject("Non-sensitive evaluation context.", { account: { plan: "pro" } }),
    subjectKey: string("Stable subject key used only for deterministic preview allocation.", "account-123"),
  },
  [],
  { context: { account: { plan: "pro" } }, subjectKey: "account-123" },
  true,
);

export const legacySuiteActionInputSchemas: Record<LegacySuiteModuleId, Record<string, LegacySuiteActionInputSchema>> = {
  consent: {
    "site-create": schema(["name"], { name: genericName("Consent site name") }),
    "site-configure": schema(["siteId", "domain", "fallbackBehavior"], {
      siteId: uuid("Consent site UUID."),
      domain: hostname,
      fallbackBehavior: string("No-location fallback behavior.", "essential-only", { enum: ["essential-only", "prompt-before-optional"] }),
    }),
    "domain-verify": schema(["siteId"], { siteId: uuid("Consent site UUID.") }),
    "scan-start": schema(["siteId", "urls"], {
      siteId: uuid("Consent site UUID."),
      urls: array("One to fifty public same-domain scan URLs; normalized duplicates are accepted and deduplicated.", httpUrl, ["https://example.com/privacy"], 1, 50),
    }),
    "policy-draft": schema(["siteId", "purposes", "services", "fallbackBehavior", "locale"], {
      siteId: uuid("Consent site UUID."),
      purposes: array("Reviewed consent purposes.", consentPurpose, [{ key: "essential-service", label: "Essential service", description: "Required to provide the requested service.", required: true }], 1, 100),
      services: array("Reviewed services bound to declared purposes.", consentService, [{ key: "session-service", label: "Session service", description: "Maintains the signed-in session.", purposeKeys: ["essential-service"] }], 0, 200),
      fallbackBehavior: string("No-location fallback behavior.", "essential-only", { enum: ["essential-only", "prompt-before-optional"] }),
      locale,
    }),
    "policy-approve": schema(["revisionId", "contentHash"], { revisionId: uuid("Consent policy revision UUID."), contentHash }),
    "policy-publish": schema(["revisionId", "contentHash", "idempotencyKey"], { revisionId: uuid("Consent policy revision UUID."), contentHash, idempotencyKey }),
    "choice-record": schema(["siteId", "revisionId", "visitorKey", "decisions"], {
      siteId: uuid("Consent site UUID."),
      revisionId: uuid("Active published policy revision UUID."),
      visitorKey: string("Site-local visitor key containing at least sixteen characters of entropy.", "visitor-7f9182bd4ac6", { minLength: 16, maxLength: 512 }),
      decisions: array("Exactly one decision for each policy purpose.", consentDecision, [{ key: "essential-service", allowed: true }], 1, 100),
      gpc: boolean("Optional observed Global Privacy Control signal.", false),
    }),
    "finding-suggest": schema(["instruction", "observationId"], { instruction: legacyInstruction, observationId: uuid("Observed consent resource UUID.") }),
  },
  seo: {
    "site-create": schema(["name"], { name: genericName("SEO site name") }),
    "site-configure": schema(["siteId", "origin", "locale", "device"], {
      siteId: uuid("SEO site UUID."),
      origin: string("Canonical public HTTP or HTTPS site origin.", "https://example.com", { format: "uri", pattern: "^https?://" }),
      locale,
      device: string("Search device context.", "desktop", { enum: ["desktop", "mobile"] }),
      dailyUnitLimit: integer("Optional daily customer-provider unit ceiling.", 50, 1, 10_000),
    }),
    "keyword-add": schema(["siteId", "query", "country", "device"], {
      siteId: uuid("SEO site UUID."),
      query: string("Exact search query.", "privacy software", { maxLength: 200 }),
      country: string("Two-letter uppercase country code.", "US", { pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 }),
      device: string("Search device context.", "desktop", { enum: ["desktop", "mobile"] }),
    }),
    "rank-run": schema(["keywordId", "provider", "idempotencyKey"], {
      keywordId: uuid("Exact keyword-series UUID."),
      provider: string("Customer-configured rank-data provider mode.", "customer-serp-provider", { enum: ["customer-serp-provider", "customer-proxy"] }),
      idempotencyKey,
    }),
    "audit-start": schema(["siteId", "urls"], {
      siteId: uuid("SEO site UUID."),
      urls: array("One to 250 public same-origin audit URLs; normalized duplicates are accepted and deduplicated.", httpUrl, ["https://example.com/page"], 1, 250),
      maxPages: integer("Optional bounded crawl-page ceiling.", 50, 1, 250),
    }),
    "brief-create": schema(["siteId", "keywordId", "title", "evidenceIds"], {
      siteId: uuid("SEO site UUID."),
      keywordId: uuid("Exact keyword-series UUID."),
      title: string("Content brief title.", "Evidence-based content brief", { maxLength: 300 }),
      evidenceIds: uuidArray("One to 100 workspace-owned SEO evidence UUIDs.", 1, 100),
      outline: array("Optional reviewed outline lines.", string("Outline line.", "Explain the observed search intent.", { maxLength: 1_000 }), ["Explain the observed search intent."], 0, 100),
    }),
    "brief-approve": schema(["briefId", "contentHash"], { briefId: uuid("Content brief UUID."), contentHash }),
    "report-create": schema(["siteId", "domain", "title", "evidenceIds"], {
      siteId: uuid("SEO site UUID."),
      domain: hostname,
      title: string("Public report title.", "Search visibility report", { maxLength: 300 }),
      evidenceIds: uuidArray("One to 100 workspace-owned SEO evidence UUIDs.", 1, 100),
    }),
    "report-revoke": schema(["reportId"], { reportId: uuid("Public SEO report UUID.") }),
    "brief-draft": schema(["instruction", "siteId", "keywordId", "evidenceIds"], {
      instruction: legacyInstruction,
      siteId: uuid("SEO site UUID."),
      keywordId: uuid("Exact keyword-series UUID."),
      evidenceIds: uuidArray("One to 100 selected SEO evidence UUIDs.", 1, 100),
    }),
  },
  finance: {
    "client-create": schema(["name", "currency"], { name: name("Client name"), currency }),
    "project-create": schema(["clientId", "name", "currency", "billingMethod"], {
      clientId: uuid("Finance client UUID."),
      name: name("Project name"),
      currency,
      billingMethod: string("Explicit project billing method.", "hourly", { enum: ["hourly", "fixed", "retainer", "non-billable", "mixed"] }),
    }),
    "time-create": schema(["projectId", "activity", "startedAt", "endedAt", "rateMinor"], {
      projectId: uuid("Billable project UUID."),
      activity: string("Plain-text work activity.", "Implementation", { maxLength: 200 }),
      startedAt: dateTime("Work interval start."),
      endedAt: dateTime("Work interval end."),
      rateMinor: integer("Hourly rate in integer minor currency units.", 10_000, 0, 100_000_000),
    }),
    "time-submit": schema(["entryId", "contentHash"], { entryId: uuid("Time-entry UUID."), contentHash }),
    "time-approve": schema(["entryId", "contentHash"], { entryId: uuid("Time-entry UUID."), contentHash }),
    "invoice-preview": schema(["projectId", "sourceIds", "issueAt", "dueAt"], {
      projectId: uuid("Billable project UUID."),
      sourceIds: uuidArray("One to 500 approved uninvoiced source-record UUIDs.", 1, 500),
      issueAt: dateTime("Invoice issue date-time."),
      dueAt: dateTime("Invoice due date-time."),
    }),
    "invoice-issue": schema(["invoiceId", "contentHash", "idempotencyKey"], { invoiceId: uuid("Draft invoice UUID."), contentHash, idempotencyKey }),
    "payment-record": schema(["invoiceId", "amountMinor", "currency", "method", "idempotencyKey"], {
      invoiceId: uuid("Issued invoice UUID."),
      amountMinor: integer("Positive payment amount in integer minor currency units.", 10_000, 1, Number.MAX_SAFE_INTEGER),
      currency,
      method: string("Manual payment method.", "manual-bank", { enum: ["manual-bank", "cash", "check", "other"] }),
      idempotencyKey,
    }),
    "reconciliation-suggest": schema(["instruction", "invoiceId"], { instruction: legacyInstruction, invoiceId: uuid("Invoice UUID.") }),
  },
  notify: {
    "workflow-draft": schema(["name"], { name: genericName("Notification workflow name") }),
    "subscriber-upsert": schema(["externalId", "locale", "timeZone"], {
      externalId: string("Workspace-local subscriber identifier.", "customer-123", { pattern: "^[A-Za-z0-9._:-]{2,128}$", maxLength: 128 }),
      locale,
      timeZone,
    }),
    "topic-create": schema(["key", "classification", "channels", "defaultPreference"], {
      key: notifyKey("Stable notification topic key.", "account.update"),
      classification: string("Topic classification.", "optional", { enum: ["required", "optional"] }),
      channels: notifyChannels,
      defaultPreference: string("Default topic preference.", "enabled", { enum: ["enabled", "disabled"] }),
    }),
    "schema-publish": schema(["eventKey", "version", "schema"], {
      eventKey: notifyKey("Stable notification event key.", "account.updated"),
      version: integer("Immutable event-schema version.", 1, 1, 1_000_000),
      schema: notifyEventSchema,
    }),
    "workflow-configure": schema(["workflowId", "eventKey", "version", "topicKey", "channels", "template"], {
      workflowId: uuid("Draft workflow UUID."),
      eventKey: notifyKey("Published event key.", "account.updated"),
      version: integer("Published event-schema version.", 1, 1, 1_000_000),
      topicKey: notifyKey("Active topic key.", "account.update"),
      channels: array("Provider-free workflows currently support exactly the inbox channel.", { const: "inbox", examples: ["inbox"] }, ["inbox"], 1, 1, true),
      template: notifyTemplate,
    }),
    "workflow-publish": schema(["workflowId", "contentHash"], { workflowId: uuid("Configured workflow UUID."), contentHash }),
    "preference-set": schema(["subscriberId", "topicKey", "channel", "decision"], {
      subscriberId: uuid("Notification subscriber UUID."),
      topicKey: notifyKey("Active topic key.", "account.update"),
      channel: string("Topic channel.", "inbox", { enum: ["inbox", "email", "sms", "push", "chat"] }),
      decision: string("Subscriber preference decision.", "enabled", { enum: ["enabled", "disabled"] }),
    }),
    "event-validate": schema(["eventKey", "version", "payload"], {
      eventKey: notifyKey("Published event key.", "account.updated"),
      version: integer("Published event-schema version.", 1, 1, 1_000_000),
      payload: openObject("Event payload validated against the selected immutable schema.", { message: "Profile updated" }),
    }),
    "event-emit": schema(["eventKey", "version", "subscriberId", "payload", "idempotencyKey"], {
      eventKey: notifyKey("Published event key.", "account.updated"),
      version: integer("Published event-schema version.", 1, 1, 1_000_000),
      subscriberId: uuid("Notification subscriber UUID."),
      payload: openObject("Event payload validated against the selected immutable schema.", { message: "Profile updated" }),
      idempotencyKey,
    }),
    "workflow-suggest": schema(["instruction", "workflowId"], { instruction: legacyInstruction, workflowId: uuid("Workflow UUID.") }),
  },
  hire: {
    "interview-plan-create": schema(["title"], { title: genericName("Interview plan title") }),
    "job-list": emptySchema(),
    "job-draft": schema(["title", "description", "pipelineStages", "privacyNoticeVersion"], {
      title: string("Job title.", "Senior product engineer", { maxLength: 240 }),
      description: string("Plain-text job description.", "Build and operate reliable customer-facing products.", { maxLength: 20_000 }),
      pipelineStages: array("Ordered unique non-terminal pipeline stage keys.", string("Pipeline stage key.", "review", { pattern: "^[a-z][a-z0-9-]{1,39}$", maxLength: 40 }), ["review"], 1, 30, true),
      privacyNoticeVersion: string("Exact candidate privacy-notice version.", "privacy-v1", { maxLength: 120 }),
    }),
    "job-approve": schema(["jobId", "contentHash"], { jobId: uuid("Draft job UUID."), contentHash }),
    "job-publish": schema(["jobId", "contentHash", "idempotencyKey"], { jobId: uuid("Approved job UUID."), contentHash, idempotencyKey }),
    "application-list": schema(["jobId"], { jobId: uuid("Hiring job UUID.") }),
    "application-get": schema(["applicationId"], { applicationId: uuid("Hiring application UUID.") }),
    "application-submit": schema(["jobId", "candidateName", "email", "consent", "answers"], {
      jobId: uuid("Published hiring job UUID."),
      candidateName: string("Candidate-provided name.", "Alex Candidate", { maxLength: 240 }),
      email: string("Candidate email address.", "alex@example.com", { format: "email", maxLength: 320 }),
      consent: { type: "boolean", const: true, description: "Explicit consent to the exact job privacy notice.", examples: [true] },
      answers: array("Candidate-supplied answers without protected or inferred traits.", applicationAnswer, [{ key: "portfolio", value: "https://example.com/work" }], 0, 100),
    }),
    "resume-extract": schema(["instruction", "applicationId", "resumeDocumentId"], {
      instruction,
      applicationId: uuid("Hiring application UUID."),
      resumeDocumentId: uuid("Clean private resume document UUID."),
    }),
    "candidate-summarize": schema(["instruction", "applicationId", "evidenceIds"], {
      instruction,
      applicationId: uuid("Hiring application UUID."),
      evidenceIds: uuidArray("One to fifty selected application evidence UUIDs.", 1, 50),
    }),
    "transition-preview": schema(["applicationId", "toStage"], {
      applicationId: uuid("Hiring application UUID."),
      toStage: string("Declared non-terminal pipeline stage key.", "review", { pattern: "^[a-z][a-z0-9-]{1,39}$", maxLength: 40 }),
    }),
    "transition-apply": schema(["applicationId", "toStage", "expectedVersion", "reason", "previewHash"], {
      applicationId: uuid("Hiring application UUID."),
      toStage: string("Declared non-terminal pipeline stage key.", "review", { pattern: "^[a-z][a-z0-9-]{1,39}$", maxLength: 40 }),
      expectedVersion: integer("Current application version.", 1, 1),
      reason: string("Auditable transition reason.", "Move to structured review after evidence check.", { maxLength: 2_000 }),
      previewHash: string("Lowercase SHA-256 digest returned by the matching preview.", HASH_EXAMPLE, { pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 }),
    }),
    "interview-schedule": schema(["applicationId", "planId", "scheduledAt"], {
      applicationId: uuid("Active hiring application UUID."),
      planId: uuid("Workspace interview-plan UUID."),
      scheduledAt: dateTime("Scheduled interview date-time."),
    }),
    "scorecard-submit": schema(["interviewId", "interviewerId", "ratings", "evidenceNotes"], {
      interviewId: uuid("Interview UUID."),
      interviewerId: string("Workspace-local interviewer identifier.", "interviewer-123", { maxLength: 64 }),
      ratings: array("One to fifty evidence-linked ratings.", rating, [{ criterion: "Problem solving", rating: 4, evidence: "Explained tradeoffs using a concrete example." }], 1, 50),
      evidenceNotes: string("Plain-text evidence notes.", "Candidate described the constraints and alternatives.", { maxLength: 10_000 }),
    }),
    "decision-record": schema(["applicationId", "decisionType", "reason", "evidenceIds", "expectedVersion"], {
      applicationId: uuid("Hiring application UUID."),
      decisionType: string("Supported non-terminal review decision.", "continue-review", { enum: ["continue-review", "pause-review", "request-more-evidence"] }),
      reason: string("Auditable decision reason.", "Continue structured review using the selected evidence.", { maxLength: 2_000 }),
      evidenceIds: uuidArray("One to fifty selected hiring evidence UUIDs.", 1, 50),
      expectedVersion: integer("Current application version.", 1, 1),
    }),
    "candidate-export": schema(["candidateId"], { candidateId: uuid("Candidate UUID.") }),
    "deletion-preview": schema(["candidateId"], { candidateId: uuid("Candidate UUID.") }),
  },
  collab: {
    "space-create": schema(["name"], { name: genericName("Collaboration space name") }),
    "space-list": emptySchema(),
    "document-get": schema(["documentId"], { documentId: uuid("Collaborative document UUID.") }),
    "document-create": schema(["spaceId", "title", "blocks"], {
      spaceId: uuid("Collaboration space UUID."),
      title: string("Document title.", "Shared proposal", { maxLength: 300 }),
      blocks: array("Safe structured document blocks.", documentBlock, [{ id: "block-1", type: "paragraph", text: "Shared draft" }], 0, 5_000),
    }),
    "canvas-get": schema(["canvasId"], { canvasId: uuid("Collaborative canvas UUID.") }),
    "canvas-create": schema(["spaceId", "title", "elements"], {
      spaceId: uuid("Collaboration space UUID."),
      title: string("Canvas title.", "Service map", { maxLength: 300 }),
      elements: array("Safe finite canvas elements.", canvasElement, [{ id: "element-1", type: "rectangle", width: 640, height: 480 }], 0, 5_000),
    }),
    "operation-apply": schema(["resourceId", "operationId", "baseVersion", "operations"], {
      resourceId: uuid("Document or canvas UUID."),
      operationId: string("Caller-generated operation identifier.", "operation-0001", { maxLength: 64 }),
      baseVersion: integer("Exact resource version on which the operation was authored.", 1, 1),
      operations: array("One to 100 safe collaboration operations.", collabOperation, [{ op: "upsert", item: { id: "item-1", type: "paragraph", text: "Shared draft" } }], 1, 100),
    }),
    "patch-propose": schema(["instruction", "resourceId", "sourceRevisionId", "selection"], {
      instruction,
      resourceId: uuid("Document or canvas UUID."),
      sourceRevisionId: uuid("Exact source revision UUID."),
      selection: array("Explicit selected resource item IDs.", string("Selected resource item ID.", "item-1", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", maxLength: 80 }), ["item-1"], 1, 500, true),
    }),
    "patch-apply": schema(["proposalId", "resourceId", "sourceRevisionId", "expectedVersion", "approval"], {
      proposalId: uuid("AI patch proposal UUID."),
      resourceId: uuid("Document or canvas UUID."),
      sourceRevisionId: uuid("Exact source revision UUID."),
      expectedVersion: integer("Current resource version.", 1, 1),
      approval: { type: "boolean", const: true, description: "Explicit approval to apply the exact proposed patch.", examples: [true] },
    }),
    "comment-create": schema(["resourceId", "anchorId", "body"], {
      resourceId: uuid("Document or canvas UUID."),
      anchorId: string("Resource item anchor ID.", "item-1", { maxLength: 80 }),
      body: string("Plain-text comment body.", "Please review this section.", { maxLength: 10_000 }),
    }),
    "revision-list": schema(["resourceId"], { resourceId: uuid("Document or canvas UUID.") }),
    "revision-create": schema(["resourceId", "expectedVersion", "reason"], {
      resourceId: uuid("Document or canvas UUID."),
      expectedVersion: integer("Current resource version.", 1, 1),
      reason: string("Auditable revision reason.", "Save the reviewed draft.", { maxLength: 1_000 }),
    }),
    "revision-compare": schema(["resourceId", "fromRevisionId", "toRevisionId"], {
      resourceId: uuid("Document or canvas UUID."),
      fromRevisionId: uuid("Earlier revision UUID."),
      toRevisionId: uuid("Later revision UUID."),
    }),
    "revision-restore": schema(["resourceId", "revisionId", "expectedVersion"], {
      resourceId: uuid("Document or canvas UUID."),
      revisionId: uuid("Revision UUID to restore as a new head."),
      expectedVersion: integer("Current resource version.", 1, 1),
    }),
    "share-create": schema(["resourceId", "revisionId", "permission", "expiresAt"], {
      resourceId: uuid("Document or canvas UUID."),
      revisionId: uuid("Exact shared revision UUID."),
      permission: string("Share permission.", "view", { enum: ["view", "comment"] }),
      expiresAt: dateTime("Share expiry date-time."),
    }),
    "export-create": schema(["resourceId", "revisionId", "format"], {
      resourceId: uuid("Document or canvas UUID."),
      revisionId: uuid("Exact exported revision UUID."),
      format: string("Supported document or canvas export format.", "canonical-json", { enum: ["canonical-json", "pdf", "markdown", "html", "png", "svg"] }),
    }),
  },
  schedule: {
    "host-create": schema(["name"], { name: name("Host name") }),
    "host-list": emptySchema(),
    "schedule-draft": schema(["name", "timeZone", "windows", "hostIds"], {
      name: name("Schedule name"),
      timeZone,
      windows: array("One to 100 non-overlapping weekly availability windows.", scheduleWindow, [{ dayOfWeek: 1, start: "09:00", end: "17:00" }], 1, 100),
      hostIds: array("One to 100 workspace host UUIDs; duplicates are accepted and deduplicated.", uuid("Workspace host UUID."), [UUID_EXAMPLE], 1, 100),
    }),
    "schedule-publish": schema(["revisionId", "contentHash"], { revisionId: uuid("Schedule revision UUID."), contentHash }),
    "event-draft": schema(["name", "slug", "scheduleRevisionId", "hostIds", "durationMinutes"], {
      name: name("Booking event name"),
      slug: stableKey("Stable public event slug.", "consultation"),
      scheduleRevisionId: uuid("Published schedule revision UUID."),
      hostIds: array("One to 100 hosts from the selected schedule revision; duplicates are accepted and deduplicated.", uuid("Workspace host UUID."), [UUID_EXAMPLE], 1, 100),
      durationMinutes: integer("Event duration in whole minutes.", 30, 5, 1_440),
    }),
    "event-publish": schema(["releaseId", "contentHash"], { releaseId: uuid("Booking event release UUID."), contentHash }),
    "availability-preview": schema(["releaseId", "from", "to", "timeZone"], {
      releaseId: uuid("Published booking event release UUID."),
      from: dateTime("Availability range start."),
      to: dateTime("Availability range end."),
      timeZone,
    }),
    "routing-preview": schema(["releaseId", "routingAnswers"], {
      releaseId: uuid("Published booking event release UUID."),
      routingAnswers: openObject("Non-sensitive declarative routing answers.", { team: "sales" }),
    }),
    "booking-create": schema(["releaseId", "hostId", "startsAt", "endsAt", "idempotencyKey"], {
      releaseId: uuid("Published booking event release UUID."),
      hostId: uuid("Eligible host UUID."),
      startsAt: dateTime("Requested booking start."),
      endsAt: dateTime("Requested booking end."),
      idempotencyKey,
      invitee: bookingInvitee,
    }),
    "booking-get": schema(["bookingId"], { bookingId: uuid("Booking UUID.") }),
    "booking-reschedule-preview": schema(["bookingId", "startsAt", "endsAt"], {
      bookingId: uuid("Booking UUID."),
      startsAt: dateTime("Proposed booking start."),
      endsAt: dateTime("Proposed booking end."),
    }),
    "booking-reschedule": schema(["bookingId", "startsAt", "endsAt", "expectedVersion", "idempotencyKey"], {
      bookingId: uuid("Booking UUID."),
      startsAt: dateTime("New booking start."),
      endsAt: dateTime("New booking end."),
      expectedVersion: integer("Current booking version.", 1, 1),
      idempotencyKey,
    }),
    "booking-cancel": schema(["bookingId", "expectedVersion", "reason"], {
      bookingId: uuid("Booking UUID."),
      expectedVersion: integer("Current booking version.", 1, 1),
      reason: string("Auditable cancellation reason.", "No longer needed.", { maxLength: 500 }),
    }),
    "connector-health": emptySchema(),
    "booking-export": schema(["from", "to", "format"], {
      from: dateTime("Export range start."),
      to: dateTime("Export range end."),
      format: string("Booking export format.", "json", { enum: ["json", "ical"] }),
    }),
    "unavailability-explain": schema(["releaseId", "hostId", "startsAt", "endsAt"], {
      releaseId: uuid("Published booking event release UUID."),
      hostId: uuid("Host UUID."),
      startsAt: dateTime("Unavailable interval start."),
      endsAt: dateTime("Unavailable interval end."),
    }),
  },
  forms: {
    "form-create": schema(["name"], { name: name("Form name") }),
    "form-list": emptySchema(),
    "form-draft": schema(["formId", "title", "schema", "logic"], {
      formId: uuid("Form UUID."),
      title: string("Form release title.", "Contact request", { maxLength: 200 }),
      schema: formSchema,
      logic: array("Zero to 200 acyclic declarative form-logic rules.", formLogicRule, [], 0, 200),
    }),
    "schema-validate": schema(["releaseId"], { releaseId: uuid("Form release UUID.") }),
    "logic-validate": schema(["releaseId"], { releaseId: uuid("Form release UUID.") }),
    "release-diff": schema(["releaseId"], { releaseId: uuid("Form release UUID.") }),
    "release-publish": schema(["releaseId", "contentHash", "idempotencyKey"], { releaseId: uuid("Form release UUID."), contentHash, idempotencyKey }),
    "submission-validate": schema(["releaseId", "responseValues"], {
      releaseId: uuid("Published exact form release UUID."),
      responseValues: openObject("Response values keyed by exact release field keys.", { message: "Please contact me." }),
    }),
    "submission-create": schema(["releaseId", "responseValues", "idempotencyKey"], {
      releaseId: uuid("Published exact form release UUID."),
      responseValues: openObject("Response values keyed by exact release field keys.", { message: "Please contact me." }),
      idempotencyKey,
      respondentKey: string("Optional respondent-local key hashed before storage.", "respondent-123"),
    }),
    "submission-get": schema(["submissionId"], { submissionId: uuid("Form submission UUID.") }),
    "submission-correct": schema(["submissionId", "responseValues", "expectedVersion", "reason"], {
      submissionId: uuid("Form submission UUID."),
      responseValues: openObject("Corrected response values keyed by exact release field keys.", { message: "Corrected response." }),
      expectedVersion: integer("Current submission version.", 1, 1),
      reason: string("Auditable correction reason.", "Respondent corrected the answer.", { maxLength: 2_000 }),
    }),
    "results-query": schema(["formId"], { formId: uuid("Form UUID.") }),
    "results-summarize": schema(["formId"], { formId: uuid("Form UUID.") }),
    "export-preview": schema(["formId", "fields", "format"], {
      formId: uuid("Form UUID."),
      fields: array("Zero to 200 selected form field keys; duplicates are accepted and deduplicated.", stableKey("Form field key."), ["message"], 0, 200),
      format: string("Form export format.", "json", { enum: ["json", "csv"] }),
    }),
    "export-create": schema(["exportId", "contentHash", "idempotencyKey"], { exportId: uuid("Reviewed export preview UUID."), contentHash, idempotencyKey }),
    "rights-preview": schema(["respondentKey"], { respondentKey: string("Respondent-local key used only to derive a workspace-scoped digest.", "respondent-123", { maxLength: 500 }) }),
  },
  flags: {
    "project-create": schema(["name"], { name: name("Feature-flag project name") }),
    "project-list": emptySchema(),
    "flag-draft": schema(["projectId", "environmentKey", "key", "valueType", "safeValue", "variants", "rules"], {
      projectId: uuid("Feature-flag project UUID."),
      environmentKey: stableKey("Stable environment key.", "production"),
      key: stableKey("Stable semantic feature-flag key.", "new-checkout"),
      valueType: flagValueType,
      safeValue: json("Safe fallback value matching the declared value type.", false),
      variants: array("One to twenty flag variants.", flagVariant, [{ key: "enabled", value: true, weight: 10_000 }], 1, 20),
      rules: array("Zero to 100 safe targeting rules.", flagRule, [], 0, 100),
    }),
    "revision-validate": schema(["revisionId"], { revisionId: uuid("Feature configuration revision UUID.") }),
    "rollout-preview": schema(["revisionId", "contexts"], {
      revisionId: uuid("Feature configuration revision UUID."),
      contexts: array("Zero to 100 preview evaluation vectors.", rolloutContext, [], 0, 100),
    }),
    "revision-diff": schema(["revisionId"], { revisionId: uuid("Feature configuration revision UUID.") }),
    "revision-approve": schema(["revisionId", "contentHash"], { revisionId: uuid("Feature configuration revision UUID."), contentHash }),
    "revision-publish": schema(["revisionId", "contentHash", "baseVersion", "idempotencyKey"], {
      revisionId: uuid("Approved feature configuration revision UUID."),
      contentHash,
      baseVersion: integer("Current published configuration version, or zero for the first publication.", 0, 0),
      idempotencyKey,
    }),
    "evaluate": schema(["projectId", "environmentKey", "flagKey", "expectedType", "defaultValue", "context", "subjectKey"], {
      projectId: uuid("Feature-flag project UUID."),
      environmentKey: stableKey("Stable environment key.", "production"),
      flagKey: stableKey("Stable semantic feature-flag key.", "new-checkout"),
      expectedType: string("Expected caller value type. Unknown values safely fall back when no matching active flag is evaluated.", "boolean", { maxLength: 20 }),
      defaultValue: json("Caller-provided type-safe default value.", false),
      context: openObject("Non-sensitive evaluation context.", { account: { plan: "pro" } }),
      subjectKey: string("Stable subject key used for deterministic allocation and hashed receipts.", "account-123", { maxLength: 500 }),
    }),
    "evaluation-explain": schema(["receiptId"], { receiptId: uuid("Evaluation receipt UUID.") }),
    "manifest-export": schema(["projectId", "environmentKey", "audience"], {
      projectId: uuid("Feature-flag project UUID."),
      environmentKey: stableKey("Stable environment key.", "production"),
      audience: string("Manifest audience.", "server", { enum: ["client", "server"] }),
    }),
    "exposure-record": schema(["experimentId", "subjectKey", "variant", "sourceEventId"], {
      experimentId: uuid("Running feature experiment UUID."),
      subjectKey: string("Stable experiment subject key, hashed before storage.", "account-123", { maxLength: 500 }),
      variant: stableKey("Declared experiment variant key.", "enabled"),
      sourceEventId: string("Immutable source event identifier.", "exposure-event-123", { maxLength: 200 }),
    }),
    "experiment-draft": schema(["projectId", "flagId", "hypothesis", "variants", "weights", "minimumSample", "minimumDurationHours"], {
      projectId: uuid("Feature-flag project UUID."),
      flagId: uuid("Feature flag UUID."),
      hypothesis: string("Preregistered experiment hypothesis.", "The enabled variant improves task completion.", { maxLength: 2_000 }),
      variants: array("One to twenty declared variant keys; duplicates are accepted and deduplicated before weight checks.", stableKey("Declared variant key.", "enabled"), ["enabled"], 1, 20),
      weights: array("Allocation weights in ten-thousandths; aligned with variants and summing to 10000.", integer("Allocation weight.", 10_000, 0, 10_000), [10_000], 1, 20),
      minimumSample: integer("Preregistered minimum exposure sample.", 100, 2, 10_000_000),
      minimumDurationHours: integer("Preregistered minimum experiment duration in hours.", 24, 1, 8_760),
    }),
    "experiment-start": schema(["experimentId", "expectedVersion", "contentHash"], {
      experimentId: uuid("Draft feature experiment UUID."),
      expectedVersion: integer("Current experiment version.", 1, 1),
      contentHash,
    }),
    "experiment-analyze": schema(["experimentId"], { experimentId: uuid("Started feature experiment UUID.") }),
    "revision-rollback": schema(["revisionId", "contentHash", "baseVersion", "idempotencyKey"], {
      revisionId: uuid("Previously published feature configuration revision UUID."),
      contentHash,
      baseVersion: integer("Current published configuration version.", 1, 0),
      idempotencyKey,
    }),
    "stale-review": schema(["projectId"], { projectId: uuid("Feature-flag project UUID.") }),
  },
};

export function legacySuiteActionInputSchema(moduleId: string, actionId: string): LegacySuiteActionInputSchema | undefined {
  if (!legacySuiteModuleIds.includes(moduleId as LegacySuiteModuleId)) return undefined;
  return legacySuiteActionInputSchemas[moduleId as LegacySuiteModuleId][actionId];
}
