export type AdditiveBusinessPlanId = "none" | "starter" | "scale" | "fleet";
export type AdditiveBusinessModuleId = "tables" | "meetings" | "insights" | "learning" | "community";
export type AdditiveBusinessOperation = "read" | "mutation" | "ai";
export type AdditiveBusinessScope = "read" | "write" | "ai";
export type AdditiveBusinessRisk = "low" | "medium" | "high" | "critical";
export type AdditiveBusinessExternalEffect = "none" | "delivery" | "credential" | "model";
export type AdditiveBusinessRole = "viewer" | "member" | "admin" | "owner";

export interface AdditiveBusinessJsonSchema {
  type: "object";
  required: readonly string[];
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  additionalProperties: false;
}

export interface AdditiveBusinessModuleDefinition {
  id: AdditiveBusinessModuleId;
  name: string;
  category: string;
  originalProductThesis: string;
  minPlan: Extract<AdditiveBusinessPlanId, "starter" | "scale">;
  minimumMonthlyPlanUsd: 7 | 50;
  dataPlane: "workspace-shared";
  resource: {
    class: "shared" | "high";
    minimumCpuMillicores: number;
    minimumMemoryMiB: number;
    includedStorageGb: number;
    recommendedWorkerConcurrency: number;
  };
  aiNativeQualities: readonly string[];
}

export interface AdditiveBusinessActionDefinition {
  id: string;
  moduleId: AdditiveBusinessModuleId;
  productName: string;
  title: string;
  description: string;
  operation: AdditiveBusinessOperation;
  requiredScope: AdditiveBusinessScope;
  minimumRole: AdditiveBusinessRole;
  risk: AdditiveBusinessRisk;
  destructive: boolean;
  externalEffect: AdditiveBusinessExternalEffect;
  requiresApproval: boolean;
  supportsDryRun: boolean;
  idempotent: boolean;
  recordType: string;
  inputSchema: AdditiveBusinessJsonSchema;
  exampleInput: Record<string, unknown>;
  cliExample: string;
  mcpToolName: string;
  promptId?: string;
  promptVersion?: string;
}

export const additiveBusinessModules = [
  {
    id: "tables",
    name: "SchemaDeck",
    category: "Structured collaborative data",
    originalProductThesis: "Turn governed schemas, typed rows, deterministic views, and cited proposals into one shared workspace data fabric.",
    minPlan: "starter",
    minimumMonthlyPlanUsd: 7,
    dataPlane: "workspace-shared",
    resource: { class: "shared", minimumCpuMillicores: 150, minimumMemoryMiB: 256, includedStorageGb: 2, recommendedWorkerConcurrency: 2 },
    aiNativeQualities: ["Version-pinned schema proposals", "Deterministic formulas", "No model-applied row or schema changes"],
  },
  {
    id: "meetings",
    name: "Recall Room",
    category: "Meeting decisions and commitments",
    originalProductThesis: "Preserve meetings as a privacy-aware ledger of participants, transcript evidence, decisions, owners, and reviewed follow-up proposals.",
    minPlan: "scale",
    minimumMonthlyPlanUsd: 50,
    dataPlane: "workspace-shared",
    resource: { class: "high", minimumCpuMillicores: 500, minimumMemoryMiB: 768, includedStorageGb: 10, recommendedWorkerConcurrency: 2 },
    aiNativeQualities: ["Transcript-cited proposals", "Human-owned decisions", "Approval-gated redaction"],
  },
  {
    id: "insights",
    name: "Proofline Insights",
    category: "Business intelligence",
    originalProductThesis: "Model metrics, observations, dashboards, and immutable reporting clocks before asking a model for cited explanations or hypotheses.",
    minPlan: "scale",
    minimumMonthlyPlanUsd: 50,
    dataPlane: "workspace-shared",
    resource: { class: "high", minimumCpuMillicores: 650, minimumMemoryMiB: 1_024, includedStorageGb: 20, recommendedWorkerConcurrency: 3 },
    aiNativeQualities: ["Measurement-clock provenance", "Hypotheses separated from facts", "No autonomous alert or metric mutation"],
  },
  {
    id: "learning",
    name: "Learning Forge",
    category: "Courses and skills",
    originalProductThesis: "Bind lessons, attempts, rubrics, feedback proposals, and credentials to explicit evidence and human-reviewed achievement rules.",
    minPlan: "scale",
    minimumMonthlyPlanUsd: 50,
    dataPlane: "workspace-shared",
    resource: { class: "high", minimumCpuMillicores: 500, minimumMemoryMiB: 768, includedStorageGb: 12, recommendedWorkerConcurrency: 2 },
    aiNativeQualities: ["Rubric-grounded feedback proposals", "Evidence-bound learning paths", "Human-issued credentials"],
  },
  {
    id: "community",
    name: "Circlefield",
    category: "Customer community",
    originalProductThesis: "Make community context, membership, moderation receipts, and reviewed announcements portable without silent model moderation or posting.",
    minPlan: "scale",
    minimumMonthlyPlanUsd: 50,
    dataPlane: "workspace-shared",
    resource: { class: "high", minimumCpuMillicores: 600, minimumMemoryMiB: 1_024, includedStorageGb: 15, recommendedWorkerConcurrency: 4 },
    aiNativeQualities: ["Policy-cited moderation proposals", "Exact-copy announcement approvals", "No silent model hiding, banning, or posting"],
  },
] as const satisfies readonly AdditiveBusinessModuleDefinition[];

const uuid = (description: string) => ({ type: "string", format: "uuid", description });
const text = (description: string, maxLength = 4_000) => ({ type: "string", minLength: 1, maxLength, description });
const optionalText = (description: string, maxLength = 4_000) => ({ type: "string", maxLength, description });
const integer = (description: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum, description });
const number = (description: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE) => ({ type: "number", minimum, maximum, description });
const boolean = (description: string) => ({ type: "boolean", description });
const dateTime = (description: string) => ({ type: "string", format: "date-time", description });
const sha256 = (description: string) => ({ type: "string", pattern: "^[a-f0-9]{64}$", description });
const object = (description: string) => ({ type: "object", description });
const array = (description: string, items: Record<string, unknown>, maxItems = 200) => ({ type: "array", items, maxItems, description });
const enumString = (description: string, values: readonly string[]) => ({ type: "string", enum: values, description });
const idempotencyKey = { type: "string", minLength: 16, maxLength: 200, pattern: "^[A-Za-z0-9._:-]{16,200}$", description: "A retry-safe key unique to this logical mutation." };
const approval = {
  type: "object",
  description: "Attributed human approval of the exact requested effect.",
  required: ["approved", "approvedBy", "approvedAt", "decisionId", "reason"],
  properties: {
    approved: { const: true },
    approvedBy: { type: "string", minLength: 1, maxLength: 200 },
    approvedAt: { type: "string", format: "date-time" },
    decisionId: { type: "string", minLength: 16, maxLength: 200, pattern: "^[A-Za-z0-9._:-]{16,200}$" },
    reason: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  additionalProperties: false,
};
const dryRun = boolean("When true, validate and return a preview without persisting or performing the effect.");
const evidenceIds = array("Tenant-owned record IDs selected as evidence.", { type: "string", format: "uuid" }, 500);
const modelId = text("Optional expected workspace-configured model identifier. When omitted, the trusted workspace policy is used; never a credential.", 200);

type Draft = Omit<AdditiveBusinessActionDefinition, "inputSchema" | "exampleInput" | "cliExample" | "mcpToolName" | "idempotent" | "requiredScope" | "minimumRole" | "risk" | "destructive" | "externalEffect" | "requiresApproval" | "supportsDryRun" | "promptId" | "promptVersion"> & {
  required: readonly string[];
  properties: Record<string, Record<string, unknown>>;
  example: Record<string, unknown>;
  requiredScope?: AdditiveBusinessScope;
  minimumRole?: AdditiveBusinessRole;
  risk?: AdditiveBusinessRisk;
  destructive?: boolean;
  externalEffect?: AdditiveBusinessExternalEffect;
  requiresApproval?: boolean;
  supportsDryRun?: boolean;
};

function define(draft: Draft): AdditiveBusinessActionDefinition {
  const {
    required,
    properties: draftProperties,
    example,
    requiredScope,
    minimumRole,
    risk,
    destructive = false,
    externalEffect = draft.operation === "ai" ? "model" : "none",
    requiresApproval = draft.operation === "ai" || destructive,
    supportsDryRun = draft.operation === "ai" || destructive,
    ...base
  } = draft;
  const idempotent = draft.operation !== "read";
  const properties = { ...draftProperties };
  const requiredFields = [...required];
  const exampleInput = { ...example };
  if (idempotent) {
    properties.idempotencyKey = idempotencyKey;
    requiredFields.push("idempotencyKey");
    exampleInput.idempotencyKey = `${draft.moduleId}.${draft.id}.example-0001`;
  }
  if (supportsDryRun) {
    properties.dryRun = dryRun;
    properties.approval = approval;
    requiredFields.push("dryRun");
    exampleInput.dryRun = true;
  }
  const promptId = draft.operation === "ai" ? `${draft.moduleId}.${draft.id}` : undefined;
  const promptVersion = draft.operation === "ai" ? "2026-08-24.1" : undefined;
  const mcpToolName = `${draft.moduleId}_${draft.id.replaceAll("-", "_")}`;
  const cliInput = JSON.stringify(exampleInput).replaceAll("'", "'\\''");
  const resolvedRisk = risk ?? (destructive || externalEffect !== "none" ? "high" : draft.operation === "ai" ? "medium" : "low");
  const resolvedMinimumRole = minimumRole ?? (["high", "critical"].includes(resolvedRisk) ? "admin" : draft.operation === "read" ? "viewer" : "member");
  if (["high", "critical"].includes(resolvedRisk) && !["admin", "owner"].includes(resolvedMinimumRole)) throw new Error(`${draft.moduleId}:${draft.id} must require an admin or owner because it is ${resolvedRisk} risk.`);
  return {
    ...base,
    requiredScope: requiredScope ?? (draft.operation === "read" ? "read" : draft.operation === "ai" ? "ai" : "write"),
    minimumRole: resolvedMinimumRole,
    risk: resolvedRisk,
    destructive,
    externalEffect,
    requiresApproval,
    supportsDryRun,
    idempotent,
    inputSchema: { type: "object", required: [...new Set(requiredFields)], properties, additionalProperties: false },
    exampleInput,
    cliExample: `supersuite action ${draft.moduleId} ${draft.id} '${cliInput}'`,
    mcpToolName,
    promptId,
    promptVersion,
  };
}

const sample = {
  record: "00000000-0000-4000-8000-000000000100",
  evidence: "00000000-0000-4000-8000-000000000101",
  actor: "user-owner-0001",
};

const tables = [
  define({ moduleId: "tables", productName: "SchemaDeck", id: "base-create", title: "Create governed base", description: "Create a shared base with an explicit purpose and stable key.", operation: "mutation", recordType: "table-base", required: ["key", "name", "purpose"], properties: { key: text("Stable lowercase base key.", 80), name: text("Base name.", 160), purpose: text("Bounded data purpose.", 2_000) }, example: { key: "customers", name: "Customers", purpose: "Track opted-in customer facts" } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "field-add", title: "Add typed field", description: "Add a uniquely keyed typed field to one tenant-owned base.", operation: "mutation", recordType: "table-field", required: ["baseId", "key", "label", "fieldType"], properties: { baseId: uuid("Base ID."), key: text("Stable lowercase field key.", 80), label: text("Field label.", 160), fieldType: enumString("Field type.", ["text", "number", "boolean", "date-time", "relation"]), required: boolean("Whether a value is required for future rows.") }, example: { baseId: sample.record, key: "company", label: "Company", fieldType: "text", required: true } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "row-create", title: "Create validated row", description: "Create a row only after validating values against the current tenant-owned schema.", operation: "mutation", recordType: "table-row", required: ["baseId", "values"], properties: { baseId: uuid("Base ID."), values: object("Values keyed by registered field key."), sourceRecordIds: array("Optional shared-database source records.", { type: "string", format: "uuid" }, 100) }, example: { baseId: sample.record, values: { company: "Northwind" }, sourceRecordIds: [] } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "row-update", title: "Update row with optimistic lock", description: "Apply a bounded patch after exact row-version and schema validation.", operation: "mutation", recordType: "table-row", required: ["rowId", "expectedVersion", "patch"], properties: { rowId: uuid("Row ID."), expectedVersion: integer("Current row version.", 1), patch: object("Field-value patch.") }, example: { rowId: sample.record, expectedVersion: 1, patch: { company: "Northwind Labs" } } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "view-create", title: "Create deterministic view", description: "Persist a bounded sort and filter contract without executing arbitrary code.", operation: "mutation", recordType: "table-view", required: ["baseId", "name", "filter", "sort"], properties: { baseId: uuid("Base ID."), name: text("View name.", 160), filter: object("Declarative equality filter."), sort: array("Ordered field and direction pairs.", { type: "object" }, 20) }, example: { baseId: sample.record, name: "Companies", filter: {}, sort: [{ field: "company", direction: "asc" }] } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "import-preview", title: "Preview typed row import", description: "Validate a bounded row batch and return its exact hash without writing anything.", operation: "read", recordType: "table-row", required: ["baseId", "rows"], properties: { baseId: uuid("Base ID."), rows: array("Rows to validate.", { type: "object" }, 500) }, example: { baseId: sample.record, rows: [{ company: "Northwind" }] } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "import-apply", title: "Apply approved typed row import", description: "Persist the exact previewed batch only after attributed approval.", operation: "mutation", recordType: "table-row", requiresApproval: true, supportsDryRun: true, risk: "high", required: ["baseId", "rows", "previewHash"], properties: { baseId: uuid("Base ID."), rows: array("Exact previewed rows.", { type: "object" }, 500), previewHash: sha256("Exact import preview hash.") }, example: { baseId: sample.record, rows: [{ company: "Northwind" }], previewHash: "a".repeat(64) } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "formula-evaluate", title: "Evaluate bounded aggregate", description: "Evaluate a deterministic count, sum, minimum, maximum, or average against tenant rows.", operation: "read", recordType: "table-row", required: ["baseId", "operation", "fieldKey"], properties: { baseId: uuid("Base ID."), operation: enumString("Supported aggregate.", ["count", "sum", "min", "max", "average"]), fieldKey: optionalText("Numeric field key; may be blank for count.", 80) }, example: { baseId: sample.record, operation: "count", fieldKey: "" } }),
  define({ moduleId: "tables", productName: "SchemaDeck", id: "schema-propose", title: "Queue grounded schema proposal", description: "Queue a cited schema-improvement proposal; it can never add fields or mutate rows itself.", operation: "ai", recordType: "ai-proposal-request", required: ["baseId", "goal", "evidenceIds"], properties: { baseId: uuid("Base ID."), goal: text("Schema question or desired outcome."), evidenceIds, modelId }, example: { baseId: sample.record, goal: "Propose a minimal customer-health field set.", evidenceIds: [sample.evidence] } }),
];

const meetings = [
  define({ moduleId: "meetings", productName: "Recall Room", id: "meeting-create", title: "Create meeting ledger", description: "Create a purpose-bound meeting with explicit start time and privacy classification.", operation: "mutation", recordType: "meeting", required: ["title", "purpose", "startsAt", "privacy"], properties: { title: text("Meeting title.", 240), purpose: text("Meeting purpose.", 2_000), startsAt: dateTime("Scheduled UTC start."), privacy: enumString("Privacy class.", ["workspace", "confidential", "restricted"]) }, example: { title: "Launch review", purpose: "Choose a safe launch window", startsAt: "2026-08-25T15:00:00.000Z", privacy: "confidential" } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "participant-add", title: "Add attributed participant", description: "Add a participant and attendance role without importing address books.", operation: "mutation", recordType: "meeting-participant", required: ["meetingId", "displayName", "role"], properties: { meetingId: uuid("Meeting ID."), displayName: text("Participant display name.", 160), role: enumString("Attendance role.", ["host", "participant", "observer"]), userRef: optionalText("Optional workspace user reference.", 200) }, example: { meetingId: sample.record, displayName: "Avery", role: "participant", userRef: sample.actor } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "transcript-append", title: "Append transcript evidence", description: "Append a time-bounded transcript segment with speaker and capture provenance.", operation: "mutation", recordType: "transcript-segment", required: ["meetingId", "speaker", "startMs", "endMs", "text", "source"], properties: { meetingId: uuid("Meeting ID."), speaker: text("Speaker label.", 160), startMs: integer("Segment start in milliseconds.", 0), endMs: integer("Segment end in milliseconds.", 1), text: text("Transcript text.", 20_000), source: enumString("Capture source.", ["manual", "local-transcription", "imported"]) }, example: { meetingId: sample.record, speaker: "Avery", startMs: 0, endMs: 8_000, text: "Tuesday is the proposed launch day.", source: "local-transcription" } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "decision-record", title: "Record human decision", description: "Record an explicit decision, owner, rationale, and supporting tenant evidence.", operation: "mutation", recordType: "meeting-decision", required: ["meetingId", "decision", "ownerRef", "evidenceIds"], properties: { meetingId: uuid("Meeting ID."), decision: text("Human-authored decision.", 4_000), ownerRef: text("Responsible workspace identity.", 200), evidenceIds }, example: { meetingId: sample.record, decision: "Launch Tuesday after final checks.", ownerRef: sample.actor, evidenceIds: [sample.evidence] } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "action-item-create", title: "Create owned action item", description: "Create a human-assigned commitment with due date and decision evidence.", operation: "mutation", recordType: "meeting-action-item", required: ["meetingId", "title", "ownerRef", "dueAt", "evidenceIds"], properties: { meetingId: uuid("Meeting ID."), title: text("Action item.", 500), ownerRef: text("Responsible workspace identity.", 200), dueAt: dateTime("UTC due time."), evidenceIds }, example: { meetingId: sample.record, title: "Complete release checks", ownerRef: sample.actor, dueAt: "2026-08-26T15:00:00.000Z", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "summary-propose", title: "Queue cited meeting summary", description: "Queue a chronology, decision, and open-question proposal pinned to selected evidence; it cannot record decisions.", operation: "ai", recordType: "ai-proposal-request", required: ["meetingId", "goal", "evidenceIds"], properties: { meetingId: uuid("Meeting ID."), goal: text("Summary goal."), evidenceIds, modelId }, example: { meetingId: sample.record, goal: "Summarize supported decisions and open questions.", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "followup-propose", title: "Queue follow-up proposal", description: "Queue draft follow-up copy with citations; it cannot send, assign, or schedule anything.", operation: "ai", recordType: "ai-proposal-request", required: ["meetingId", "audience", "goal", "evidenceIds"], properties: { meetingId: uuid("Meeting ID."), audience: text("Intended audience.", 1_000), goal: text("Follow-up goal."), evidenceIds, modelId }, example: { meetingId: sample.record, audience: "Meeting participants", goal: "Draft a factual recap.", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "transcript-redact", title: "Redact transcript segment", description: "Replace transcript text with an auditable redaction marker after explicit approval and optimistic locking.", operation: "mutation", recordType: "transcript-segment", destructive: true, risk: "critical", required: ["segmentId", "expectedVersion", "reason"], properties: { segmentId: uuid("Transcript segment ID."), expectedVersion: integer("Current segment version.", 1), reason: text("Redaction reason.", 1_000) }, example: { segmentId: sample.record, expectedVersion: 1, reason: "Approved privacy request" } }),
  define({ moduleId: "meetings", productName: "Recall Room", id: "meeting-export", title: "Freeze private meeting export", description: "Create an immutable private export manifest with selected transcript and decision record IDs.", operation: "mutation", recordType: "meeting-export", required: ["meetingId", "includeTranscript", "format"], properties: { meetingId: uuid("Meeting ID."), includeTranscript: boolean("Whether transcript segments are included."), format: enumString("Export format.", ["canonical-json", "markdown"]) }, example: { meetingId: sample.record, includeTranscript: true, format: "canonical-json" } }),
];

const insights = [
  define({ moduleId: "insights", productName: "Proofline Insights", id: "source-register", title: "Register governed data source", description: "Register source identity, ownership, refresh cadence, and provenance without storing a credential.", operation: "mutation", recordType: "insight-source", required: ["name", "kind", "ownerRef", "refreshCadence"], properties: { name: text("Source name.", 160), kind: enumString("Source kind.", ["table", "database-view", "file-import", "manual"]), ownerRef: text("Accountable workspace identity.", 200), refreshCadence: enumString("Expected refresh cadence.", ["manual", "hourly", "daily", "weekly"]) }, example: { name: "Revenue ledger", kind: "table", ownerRef: sample.actor, refreshCadence: "daily" } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "metric-define", title: "Define typed metric", description: "Define a unit, aggregation, source, and dimensional contract without free-form executable queries.", operation: "mutation", recordType: "insight-metric", required: ["sourceId", "key", "name", "unit", "aggregation"], properties: { sourceId: uuid("Registered source ID."), key: text("Stable metric key.", 80), name: text("Metric name.", 160), unit: text("Unit label.", 80), aggregation: enumString("Supported aggregation.", ["sum", "count", "minimum", "maximum", "average", "last"]) }, example: { sourceId: sample.record, key: "mrr", name: "Monthly recurring revenue", unit: "USD-minor", aggregation: "sum" } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "observation-import", title: "Import approved observations", description: "Append exact timestamped integer or decimal observations after approval; existing observations are never overwritten.", operation: "mutation", recordType: "metric-observation", requiresApproval: true, supportsDryRun: true, risk: "high", required: ["metricId", "observations", "sourceRevision"], properties: { metricId: uuid("Metric ID."), observations: array("Timestamped value and dimension maps.", { type: "object" }, 2_000), sourceRevision: text("Immutable source revision or checksum.", 200) }, example: { metricId: sample.record, observations: [{ observedAt: "2026-08-24T00:00:00.000Z", value: 1200, dimensions: {} }], sourceRevision: "warehouse-2026-08-24" } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "dashboard-create", title: "Create dashboard contract", description: "Create a purpose-bound dashboard before charts or narrative are attached.", operation: "mutation", recordType: "insight-dashboard", required: ["name", "purpose", "audience"], properties: { name: text("Dashboard name.", 160), purpose: text("Decision supported by this dashboard.", 2_000), audience: text("Intended audience.", 1_000) }, example: { name: "Revenue health", purpose: "Review measured recurring revenue", audience: "Finance operators" } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "chart-add", title: "Add deterministic chart", description: "Bind a chart to one typed metric and explicit dimensions and time window.", operation: "mutation", recordType: "insight-chart", required: ["dashboardId", "metricId", "visualization", "window"], properties: { dashboardId: uuid("Dashboard ID."), metricId: uuid("Metric ID."), visualization: enumString("Visualization.", ["line", "bar", "number", "table"]), window: enumString("Time window.", ["7d", "30d", "90d", "365d", "all"]) }, example: { dashboardId: sample.record, metricId: sample.evidence, visualization: "line", window: "30d" } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "alert-rule-create", title: "Create inert alert rule", description: "Persist a threshold rule that remains inert until a separately approved delivery integration is configured.", operation: "mutation", recordType: "insight-alert-rule", required: ["metricId", "operator", "threshold", "cooldownMinutes"], properties: { metricId: uuid("Metric ID."), operator: enumString("Comparison operator.", ["gt", "gte", "lt", "lte"]), threshold: number("Threshold value."), cooldownMinutes: integer("Minimum minutes between matches.", 1, 43_200) }, example: { metricId: sample.record, operator: "lt", threshold: 1000, cooldownMinutes: 1440 } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "snapshot-freeze", title: "Freeze reporting snapshot", description: "Freeze exact observation IDs and an as-of clock after attributed approval.", operation: "mutation", recordType: "insight-snapshot", requiresApproval: true, supportsDryRun: true, risk: "high", required: ["dashboardId", "asOf", "evidenceIds"], properties: { dashboardId: uuid("Dashboard ID."), asOf: dateTime("Reporting clock."), evidenceIds }, example: { dashboardId: sample.record, asOf: "2026-08-24T12:00:00.000Z", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "anomaly-propose", title: "Queue cited anomaly hypotheses", description: "Queue hypotheses grounded in exact observations and clocks; it cannot change metrics or alert rules.", operation: "ai", recordType: "ai-proposal-request", required: ["metricId", "question", "evidenceIds"], properties: { metricId: uuid("Metric ID."), question: text("Anomaly question."), evidenceIds, modelId }, example: { metricId: sample.record, question: "Which measured changes deserve investigation?", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "insights", productName: "Proofline Insights", id: "narrative-propose", title: "Queue dashboard narrative", description: "Queue a fact-versus-hypothesis narrative pinned to an immutable snapshot; it cannot publish itself.", operation: "ai", recordType: "ai-proposal-request", required: ["snapshotId", "audience", "evidenceIds"], properties: { snapshotId: uuid("Snapshot ID."), audience: text("Intended reader.", 1_000), evidenceIds, modelId }, example: { snapshotId: sample.record, audience: "Executive operators", evidenceIds: [sample.evidence] } }),
];

const learning = [
  define({ moduleId: "learning", productName: "Learning Forge", id: "course-create", title: "Create outcome-based course", description: "Create a course with explicit audience, measurable outcome, and visibility.", operation: "mutation", recordType: "learning-course", required: ["title", "audience", "outcome", "visibility"], properties: { title: text("Course title.", 240), audience: text("Learner audience.", 1_000), outcome: text("Measurable learning outcome.", 2_000), visibility: enumString("Visibility.", ["private", "workspace", "public-catalog"]) }, example: { title: "Secure releases", audience: "Release operators", outcome: "Run the approved release checklist", visibility: "workspace" } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "lesson-create", title: "Create cited lesson", description: "Create a sequenced lesson with source record IDs from the shared workspace graph.", operation: "mutation", recordType: "learning-lesson", required: ["courseId", "title", "content", "sourceRecordIds", "position"], properties: { courseId: uuid("Course ID."), title: text("Lesson title.", 240), content: text("Human-authored lesson content.", 50_000), sourceRecordIds: evidenceIds, position: integer("One-based lesson position.", 1, 10_000) }, example: { courseId: sample.record, title: "Preflight", content: "Review every release gate.", sourceRecordIds: [sample.evidence], position: 1 } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "learner-enroll", title: "Enroll learner", description: "Enroll one workspace learner with an attributed enrollment reason.", operation: "mutation", recordType: "learning-enrollment", required: ["courseId", "learnerRef", "reason"], properties: { courseId: uuid("Course ID."), learnerRef: text("Workspace learner identity.", 200), reason: text("Enrollment reason.", 1_000) }, example: { courseId: sample.record, learnerRef: sample.actor, reason: "Release role onboarding" } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "rubric-create", title: "Create assessment rubric", description: "Create explicit criteria and passing score before attempts are evaluated.", operation: "mutation", recordType: "learning-rubric", required: ["courseId", "name", "criteria", "passingScore"], properties: { courseId: uuid("Course ID."), name: text("Rubric name.", 160), criteria: array("Weighted criterion objects.", { type: "object" }, 100), passingScore: integer("Passing score from zero to 100.", 0, 100) }, example: { courseId: sample.record, name: "Release assessment", criteria: [{ key: "preflight", weight: 100 }], passingScore: 80 } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "attempt-record", title: "Record assessment attempt", description: "Record submitted evidence and deterministic score against one rubric; it does not issue a credential.", operation: "mutation", recordType: "learning-attempt", required: ["enrollmentId", "rubricId", "score", "evidenceIds"], properties: { enrollmentId: uuid("Enrollment ID."), rubricId: uuid("Rubric ID."), score: integer("Human or deterministic score.", 0, 100), evidenceIds }, example: { enrollmentId: sample.record, rubricId: sample.evidence, score: 90, evidenceIds: [sample.evidence] } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "feedback-propose", title: "Queue rubric-grounded feedback", description: "Queue cited learner feedback; it cannot alter scores, progress, or credentials.", operation: "ai", recordType: "ai-proposal-request", required: ["attemptId", "goal", "evidenceIds"], properties: { attemptId: uuid("Attempt ID."), goal: text("Feedback objective."), evidenceIds, modelId }, example: { attemptId: sample.record, goal: "Propose feedback tied to rubric evidence.", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "path-propose", title: "Queue adaptive learning path", description: "Queue a cited sequence proposal; it cannot enroll learners or reorder a course itself.", operation: "ai", recordType: "ai-proposal-request", required: ["enrollmentId", "goal", "evidenceIds"], properties: { enrollmentId: uuid("Enrollment ID."), goal: text("Desired learning outcome."), evidenceIds, modelId }, example: { enrollmentId: sample.record, goal: "Propose the smallest evidence-based next lesson.", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "credential-preview", title: "Preview credential eligibility", description: "Deterministically evaluate attempt evidence and return an exact preview hash without issuing anything.", operation: "read", recordType: "learning-credential", required: ["enrollmentId", "attemptId"], properties: { enrollmentId: uuid("Enrollment ID."), attemptId: uuid("Attempt ID.") }, example: { enrollmentId: sample.record, attemptId: sample.evidence } }),
  define({ moduleId: "learning", productName: "Learning Forge", id: "credential-issue", title: "Issue approved credential", description: "Issue the exact eligible credential after attributed approval of the preview.", operation: "mutation", recordType: "learning-credential", externalEffect: "credential", requiresApproval: true, supportsDryRun: true, risk: "critical", required: ["enrollmentId", "attemptId", "previewHash"], properties: { enrollmentId: uuid("Enrollment ID."), attemptId: uuid("Attempt ID."), previewHash: sha256("Exact eligibility preview hash.") }, example: { enrollmentId: sample.record, attemptId: sample.evidence, previewHash: "b".repeat(64) } }),
];

const community = [
  define({ moduleId: "community", productName: "Circlefield", id: "space-create", title: "Create governed community space", description: "Create a purpose-bound space with explicit posting and moderation policy.", operation: "mutation", recordType: "community-space", required: ["key", "name", "purpose", "visibility", "policy"], properties: { key: text("Stable lowercase space key.", 80), name: text("Space name.", 160), purpose: text("Space purpose.", 2_000), visibility: enumString("Visibility.", ["private", "workspace", "public"]), policy: text("Human-authored posting and moderation policy.", 10_000) }, example: { key: "customers", name: "Customer circle", purpose: "Share product knowledge", visibility: "workspace", policy: "Be factual and respectful." } }),
  define({ moduleId: "community", productName: "Circlefield", id: "member-add", title: "Add community member", description: "Add an attributed member with the least-privileged member role.", operation: "mutation", recordType: "community-member", minimumRole: "admin", required: ["spaceId", "memberRef", "displayName"], properties: { spaceId: uuid("Space ID."), memberRef: text("Stable member identity reference.", 200), displayName: text("Display name.", 160) }, example: { spaceId: sample.record, memberRef: sample.actor, displayName: "Avery" } }),
  define({ moduleId: "community", productName: "Circlefield", id: "post-create", title: "Create attributed post", description: "Create human-authored content in a tenant-owned space with selected source citations.", operation: "mutation", recordType: "community-post", required: ["spaceId", "authorRef", "title", "body", "evidenceIds"], properties: { spaceId: uuid("Space ID."), authorRef: text("Author identity.", 200), title: text("Post title.", 240), body: text("Post body.", 50_000), evidenceIds }, example: { spaceId: sample.record, authorRef: sample.actor, title: "Launch notes", body: "Here are the reviewed launch facts.", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "community", productName: "Circlefield", id: "reply-create", title: "Create attributed reply", description: "Append a human-authored reply while preserving its parent post and evidence links.", operation: "mutation", recordType: "community-reply", required: ["postId", "authorRef", "body", "evidenceIds"], properties: { postId: uuid("Post ID."), authorRef: text("Author identity.", 200), body: text("Reply body.", 20_000), evidenceIds }, example: { postId: sample.record, authorRef: sample.actor, body: "The cited checklist confirms this.", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "community", productName: "Circlefield", id: "reaction-record", title: "Record member reaction", description: "Upsert one bounded reaction per member and post without exposing a behavioral profile.", operation: "mutation", recordType: "community-reaction", required: ["postId", "memberRef", "reaction"], properties: { postId: uuid("Post ID."), memberRef: text("Member identity.", 200), reaction: enumString("Reaction.", ["helpful", "thanks", "insightful", "withdraw"]) }, example: { postId: sample.record, memberRef: sample.actor, reaction: "helpful" } }),
  define({ moduleId: "community", productName: "Circlefield", id: "moderation-propose", title: "Queue policy-cited moderation proposal", description: "Queue a recommendation grounded in exact content and policy evidence; it cannot hide, edit, ban, or notify anyone.", operation: "ai", recordType: "ai-proposal-request", required: ["spaceId", "targetRecordId", "question", "evidenceIds"], properties: { spaceId: uuid("Space ID."), targetRecordId: uuid("Post or reply under review."), question: text("Moderation question."), evidenceIds, modelId }, example: { spaceId: sample.record, targetRecordId: sample.evidence, question: "Which policy clauses may apply?", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "community", productName: "Circlefield", id: "digest-propose", title: "Queue cited community digest", description: "Queue factual digest copy from selected posts; it cannot publish or deliver itself.", operation: "ai", recordType: "ai-proposal-request", required: ["spaceId", "audience", "evidenceIds"], properties: { spaceId: uuid("Space ID."), audience: text("Intended audience.", 1_000), evidenceIds, modelId }, example: { spaceId: sample.record, audience: "Workspace members", evidenceIds: [sample.evidence] } }),
  define({ moduleId: "community", productName: "Circlefield", id: "post-hide", title: "Hide post after approval", description: "Hide a post without deleting its evidence ledger after explicit human moderation approval.", operation: "mutation", recordType: "community-post", destructive: true, risk: "critical", required: ["postId", "expectedVersion", "reason"], properties: { postId: uuid("Post ID."), expectedVersion: integer("Current post version.", 1), reason: text("Policy-grounded moderation reason.", 2_000) }, example: { postId: sample.record, expectedVersion: 1, reason: "Reviewed policy violation" } }),
  define({ moduleId: "community", productName: "Circlefield", id: "member-role-set", title: "Set approved community role", description: "Change a member role only after attributed approval and optimistic locking.", operation: "mutation", recordType: "community-member", requiresApproval: true, supportsDryRun: true, risk: "high", required: ["memberId", "role", "expectedVersion", "reason"], properties: { memberId: uuid("Member record ID."), role: enumString("Community role.", ["member", "moderator"]), expectedVersion: integer("Current member version.", 1), reason: text("Role change reason.", 1_000) }, example: { memberId: sample.record, role: "moderator", expectedVersion: 1, reason: "Approved moderation duty" } }),
  define({ moduleId: "community", productName: "Circlefield", id: "announcement-publish", title: "Publish exact approved announcement", description: "Publish exact human-authored announcement copy to one space; AI proposals are never accepted as implicit approval.", operation: "mutation", recordType: "community-announcement", externalEffect: "delivery", requiresApproval: true, supportsDryRun: true, risk: "critical", required: ["spaceId", "title", "body", "evidenceIds"], properties: { spaceId: uuid("Space ID."), title: text("Announcement title.", 240), body: text("Exact announcement body.", 20_000), evidenceIds }, example: { spaceId: sample.record, title: "Service update", body: "The reviewed maintenance window begins Tuesday.", evidenceIds: [sample.evidence] } }),
];

export const additiveBusinessActions = [...tables, ...meetings, ...insights, ...learning, ...community] as const;

export const additiveBusinessActionsByModule = new Map<AdditiveBusinessModuleId, readonly AdditiveBusinessActionDefinition[]>(
  additiveBusinessModules.map((module) => [module.id, additiveBusinessActions.filter((action) => action.moduleId === module.id)]),
);

export const additiveBusinessActionByKey = new Map(
  additiveBusinessActions.map((action) => [`${action.moduleId}:${action.id}`, action] as const),
);
