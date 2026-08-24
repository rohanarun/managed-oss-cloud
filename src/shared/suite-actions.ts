import { coreBusinessActions } from "./core-business-actions.js";
import { esignActions } from "./esign-actions.js";
import { emailActions } from "./email-actions.js";
import { firstPartyGrowthActions } from "./first-party-growth-actions.js";
import { premiumBusinessActions } from "./premium-business-actions.js";

export type SuiteActionOperation = "create" | "update" | "ai" | "command" | "read";
export type SuiteActionRequiredScope = "read" | "write" | "ai";
export type SuiteActionFieldKind = "string" | "email" | "url" | "datetime" | "boolean" | "uuid" | "array" | "object" | "json" | "integer" | "sha256" | "currency" | "slug";

export interface SuiteActionFieldDefinition {
  name: string;
  kind: SuiteActionFieldKind;
  description: string;
  example: unknown;
  required: boolean;
}

export interface SuiteActionInputJsonSchema {
  type: "object";
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: boolean;
}

export interface SuiteActionDefinition {
  id: string;
  moduleId: string;
  title: string;
  description: string;
  operation: SuiteActionOperation;
  recordType?: string;
  titleField?: string;
  goalField?: string;
  resultingState?: string;
  requiredFields: string[];
  engine?: "legacy" | "core" | "premium" | "growth" | "esign" | "email";
  inputSchema?: SuiteActionInputJsonSchema;
  exampleInput?: Record<string, unknown>;
  requiredScope?: SuiteActionRequiredScope;
  mcpToolName?: string;
  cliExample?: string;
  risk?: string;
  destructive?: boolean;
  externalEffect?: boolean | string;
  idempotent?: boolean;
}

export const suiteActions: SuiteActionDefinition[] = [
  { id: "site-create", moduleId: "consent", title: "Create consent site", description: "Create an unconfigured privacy site before binding and proving its production domain.", operation: "create", recordType: "site", titleField: "name", resultingState: "unconfigured", requiredFields: ["name"] },
  { id: "site-configure", moduleId: "consent", title: "Configure consent site", description: "Bind a canonical hostname and explicit no-location fallback to a consent site and issue a DNS proof challenge.", operation: "command", recordType: "site", requiredFields: ["siteId", "domain", "fallbackBehavior"] },
  { id: "domain-verify", moduleId: "consent", title: "Verify consent domain", description: "Resolve the configured DNS TXT challenge and record its evidence without accepting client-asserted ownership.", operation: "command", recordType: "site", requiredFields: ["siteId"] },
  { id: "scan-start", moduleId: "consent", title: "Start consent resource scan", description: "Queue a bounded same-domain scan after rejecting private-network and out-of-scope targets.", operation: "command", recordType: "scan-run", requiredFields: ["siteId", "urls"] },
  { id: "policy-draft", moduleId: "consent", title: "Draft consent policy", description: "Create a content-addressed policy revision from reviewed purposes and services.", operation: "command", recordType: "policy-revision", requiredFields: ["siteId", "purposes", "services", "fallbackBehavior", "locale"] },
  { id: "policy-approve", moduleId: "consent", title: "Approve consent policy", description: "Approve the exact immutable policy content hash without publishing it.", operation: "command", recordType: "policy-revision", requiredFields: ["revisionId", "contentHash"] },
  { id: "policy-publish", moduleId: "consent", title: "Publish consent policy", description: "Activate an approved revision only for a proven domain, with exact-hash and idempotency enforcement.", operation: "command", recordType: "policy-revision", requiredFields: ["revisionId", "contentHash", "idempotencyKey"] },
  { id: "choice-record", moduleId: "consent", title: "Record consent choice", description: "Append a site-scoped pseudonymous choice receipt for the active policy without storing the raw visitor key.", operation: "command", recordType: "consent-receipt", requiredFields: ["siteId", "revisionId", "visitorKey", "decisions"] },
  { id: "finding-suggest", moduleId: "consent", title: "Suggest resource classification", description: "Queue a cited classification suggestion for one observed resource; it cannot publish or alter evidence.", operation: "ai", goalField: "instruction", requiredFields: ["instruction", "observationId"] },
  { id: "site-create", moduleId: "seo", title: "Create SEO site", description: "Create an unconfigured search-visibility site before binding an authorized public origin.", operation: "create", recordType: "site", titleField: "name", resultingState: "unconfigured", requiredFields: ["name"] },
  { id: "site-configure", moduleId: "seo", title: "Configure SEO site", description: "Bind a public canonical origin, locale, and device context after resolving it away from private networks.", operation: "command", recordType: "site", requiredFields: ["siteId", "origin", "locale", "device"] },
  { id: "keyword-add", moduleId: "seo", title: "Add exact SEO keyword", description: "Create an immutable exact-query series for one site, country, and device context.", operation: "command", recordType: "keyword", requiredFields: ["siteId", "query", "country", "device"] },
  { id: "rank-run", moduleId: "seo", title: "Queue rank check", description: "Queue one customer-provider request after idempotency and daily provider-unit preflight.", operation: "command", recordType: "rank-check", requiredFields: ["keywordId", "provider", "idempotencyKey"] },
  { id: "audit-start", moduleId: "seo", title: "Start safe content audit", description: "Queue a bounded same-origin audit only after rejecting private, metadata, and unsafe targets.", operation: "command", recordType: "audit-run", requiredFields: ["siteId", "urls"] },
  { id: "brief-create", moduleId: "seo", title: "Create evidence-linked brief", description: "Create a content-addressed draft from exact workspace evidence without publishing it.", operation: "command", recordType: "content-brief", requiredFields: ["siteId", "keywordId", "title", "evidenceIds"] },
  { id: "brief-approve", moduleId: "seo", title: "Approve content brief", description: "Approve the exact brief version while leaving CMS publication disabled.", operation: "command", recordType: "content-brief", requiredFields: ["briefId", "contentHash"] },
  { id: "report-create", moduleId: "seo", title: "Create public SEO report", description: "Freeze an explicitly selected evidence snapshot behind a one-time opaque token on a verified workspace domain.", operation: "command", recordType: "report", requiredFields: ["siteId", "domain", "title", "evidenceIds"] },
  { id: "report-revoke", moduleId: "seo", title: "Revoke public SEO report", description: "Revoke the public token immediately while preserving the private immutable report snapshot.", operation: "command", recordType: "report", requiredFields: ["reportId"] },
  { id: "brief-draft", moduleId: "seo", title: "Draft cited content brief", description: "Queue an AI draft grounded only in explicitly selected SEO evidence records.", operation: "ai", goalField: "instruction", requiredFields: ["instruction", "siteId", "keywordId", "evidenceIds"] },
  { id: "client-create", moduleId: "finance", title: "Create finance client", description: "Create a workspace client with one explicit ISO billing currency and no provider credentials.", operation: "create", recordType: "client", titleField: "name", resultingState: "active", requiredFields: ["name", "currency"] },
  { id: "project-create", moduleId: "finance", title: "Create billable project", description: "Create a client-owned project with an explicit billing method and matching currency.", operation: "command", recordType: "project", requiredFields: ["clientId", "name", "currency", "billingMethod"] },
  { id: "time-create", moduleId: "finance", title: "Create time entry", description: "Create a non-overlapping whole-minute time entry with an integer hourly rate snapshot.", operation: "command", recordType: "time-entry", requiredFields: ["projectId", "activity", "startedAt", "endedAt", "rateMinor"] },
  { id: "time-submit", moduleId: "finance", title: "Submit time entry", description: "Freeze and submit the exact time-entry content version for approval.", operation: "command", recordType: "time-entry", requiredFields: ["entryId", "contentHash"] },
  { id: "time-approve", moduleId: "finance", title: "Approve time entry", description: "Approve only the exact submitted time-entry version for later invoicing.", operation: "command", recordType: "time-entry", requiredFields: ["entryId", "contentHash"] },
  { id: "invoice-preview", moduleId: "finance", title: "Preview invoice", description: "Deterministically compute an integer-minor-unit invoice draft from approved uninvoiced sources.", operation: "command", recordType: "invoice", requiredFields: ["projectId", "sourceIds", "issueAt", "dueAt"] },
  { id: "invoice-issue", moduleId: "finance", title: "Issue invoice", description: "Allocate a sequential number, lock exact sources, and issue one immutable invoice version idempotently.", operation: "command", recordType: "invoice", requiredFields: ["invoiceId", "contentHash", "idempotencyKey"] },
  { id: "payment-record", moduleId: "finance", title: "Record manual payment", description: "Append an idempotent manual payment fact and recompute the invoice balance using integer minor units.", operation: "command", recordType: "payment", requiredFields: ["invoiceId", "amountMinor", "currency", "method", "idempotencyKey"] },
  { id: "reconciliation-suggest", moduleId: "finance", title: "Suggest reconciliation", description: "Queue a cited, non-mutating reconciliation suggestion for an invoice.", operation: "ai", goalField: "instruction", requiredFields: ["instruction", "invoiceId"] },
  { id: "workflow-draft", moduleId: "notify", title: "Create notification workflow draft", description: "Create an inert workflow shell that cannot emit or deliver until configured and exact-hash published.", operation: "create", recordType: "workflow", titleField: "name", resultingState: "draft", requiredFields: ["name"] },
  { id: "subscriber-upsert", moduleId: "notify", title: "Upsert notification subscriber", description: "Create or update a workspace-scoped subscriber profile without channel addresses or tokens.", operation: "command", recordType: "subscriber", requiredFields: ["externalId", "locale", "timeZone"] },
  { id: "topic-create", moduleId: "notify", title: "Create notification topic", description: "Create a required or optional topic with explicit channels and default preference.", operation: "command", recordType: "topic", requiredFields: ["key", "classification", "channels", "defaultPreference"] },
  { id: "schema-publish", moduleId: "notify", title: "Publish event schema", description: "Publish one immutable, bounded JSON event schema version after safe-subset validation.", operation: "command", recordType: "event-schema", requiredFields: ["eventKey", "version", "schema"] },
  { id: "workflow-configure", moduleId: "notify", title: "Configure notification workflow", description: "Bind a draft workflow to one schema/topic and a safe plain-text template version.", operation: "command", recordType: "workflow", requiredFields: ["workflowId", "eventKey", "version", "topicKey", "channels", "template"] },
  { id: "workflow-publish", moduleId: "notify", title: "Publish notification workflow", description: "Activate only the exact validated workflow content hash without connecting or calling a provider.", operation: "command", recordType: "workflow", requiredFields: ["workflowId", "contentHash"] },
  { id: "preference-set", moduleId: "notify", title: "Set notification preference", description: "Append a subscriber topic/channel preference while preserving required operational topics.", operation: "command", recordType: "preference", requiredFields: ["subscriberId", "topicKey", "channel", "decision"] },
  { id: "event-validate", moduleId: "notify", title: "Validate notification event", description: "Validate an event payload against the immutable published schema without persisting or dispatching it.", operation: "command", recordType: "event", requiredFields: ["eventKey", "version", "payload"] },
  { id: "event-emit", moduleId: "notify", title: "Emit notification event", description: "Accept one immutable event idempotently and evaluate preferences into local inbox or suppression without provider calls.", operation: "command", recordType: "event", requiredFields: ["eventKey", "version", "subscriberId", "payload", "idempotencyKey"] },
  { id: "workflow-suggest", moduleId: "notify", title: "Suggest workflow revision", description: "Queue an unapproved workflow suggestion without event payloads, recipients, or provider secrets.", operation: "ai", goalField: "instruction", requiredFields: ["instruction", "workflowId"] },
  { id: "interview-plan-create", moduleId: "hire", title: "Create interview plan", description: "Create a workspace-owned interview plan shell for later structured configuration.", operation: "create", recordType: "interview-plan", titleField: "title", resultingState: "draft", requiredFields: ["title"] },
  { id: "job-list", moduleId: "hire", title: "List hiring jobs", description: "List workspace-owned jobs without exposing another tenant's recruiting data.", operation: "read", recordType: "job", requiredFields: [] },
  { id: "job-draft", moduleId: "hire", title: "Draft hiring job", description: "Create a content-addressed job and immutable pipeline snapshot before approval.", operation: "command", recordType: "job", requiredFields: ["title", "description", "pipelineStages", "privacyNoticeVersion"] },
  { id: "job-approve", moduleId: "hire", title: "Approve hiring job", description: "Approve only the exact content hash of a draft job without publishing it.", operation: "command", recordType: "job", requiredFields: ["jobId", "contentHash"] },
  { id: "job-publish", moduleId: "hire", title: "Publish hiring job", description: "Publish the exact approved job version with idempotency and no autonomous content changes.", operation: "command", recordType: "job", requiredFields: ["jobId", "contentHash", "idempotencyKey"] },
  { id: "application-list", moduleId: "hire", title: "List job applications", description: "List tenant-scoped applications bound to one job.", operation: "read", recordType: "application", requiredFields: ["jobId"] },
  { id: "application-get", moduleId: "hire", title: "Read hiring application", description: "Read one tenant-scoped application and its immutable version bindings.", operation: "read", recordType: "application", requiredFields: ["applicationId"] },
  { id: "application-submit", moduleId: "hire", title: "Submit hiring application", description: "Create candidate, version-bound application, consent evidence, and an append-only event after protected-field validation.", operation: "command", recordType: "application", requiredFields: ["jobId", "candidateName", "email", "consent", "answers"] },
  { id: "resume-extract", moduleId: "hire", title: "Propose resume extraction", description: "Queue a cited extraction proposal only for a clean private resume document; it cannot change candidate facts.", operation: "ai", goalField: "instruction", requiredFields: ["instruction", "applicationId", "resumeDocumentId"] },
  { id: "candidate-summarize", moduleId: "hire", title: "Propose candidate summary", description: "Queue a review-only summary grounded only in selected application evidence.", operation: "ai", goalField: "instruction", requiredFields: ["instruction", "applicationId", "evidenceIds"] },
  { id: "transition-preview", moduleId: "hire", title: "Preview application transition", description: "Validate a non-terminal stage transition and return its exact confirmation hash without mutation.", operation: "read", recordType: "application", requiredFields: ["applicationId", "toStage"] },
  { id: "transition-apply", moduleId: "hire", title: "Apply application transition", description: "Apply an exact-version non-terminal transition and append an immutable event; terminal outcomes are always denied to this API surface.", operation: "command", recordType: "application", requiredFields: ["applicationId", "toStage", "expectedVersion", "reason", "previewHash"] },
  { id: "interview-schedule", moduleId: "hire", title: "Schedule interview", description: "Create a tenant-scoped interview from an active application and workspace interview plan.", operation: "command", recordType: "interview", requiredFields: ["applicationId", "planId", "scheduledAt"] },
  { id: "scorecard-submit", moduleId: "hire", title: "Submit immutable scorecard", description: "Append one evidence-based interviewer scorecard; no aggregate hiring decision is calculated.", operation: "command", recordType: "scorecard", requiredFields: ["interviewId", "interviewerId", "ratings", "evidenceNotes"] },
  { id: "decision-record", moduleId: "hire", title: "Record non-terminal review decision", description: "Append a non-terminal review decision; hired and not-selected outcomes remain unavailable to API and agent tokens.", operation: "command", recordType: "decision", requiredFields: ["applicationId", "decisionType", "reason", "evidenceIds", "expectedVersion"] },
  { id: "candidate-export", moduleId: "hire", title: "Create candidate export", description: "Freeze a tenant-scoped portable export manifest for one candidate and linked recruiting evidence.", operation: "command", recordType: "export", requiredFields: ["candidateId"] },
  { id: "deletion-preview", moduleId: "hire", title: "Preview candidate deletion", description: "Create a content-addressed deletion plan without deleting or hiding any candidate record.", operation: "command", recordType: "deletion-request", requiredFields: ["candidateId"] },
  { id: "space-create", moduleId: "collab", title: "Create collaboration space", description: "Create a tenant-scoped container for documents and canvases.", operation: "create", recordType: "space", titleField: "name", resultingState: "active", requiredFields: ["name"] },
  { id: "space-list", moduleId: "collab", title: "List collaboration spaces", description: "List tenant-scoped collaboration spaces.", operation: "read", recordType: "space", requiredFields: [] },
  { id: "document-get", moduleId: "collab", title: "Read collaborative document", description: "Read one tenant-scoped document head and exact current revision.", operation: "read", recordType: "document", requiredFields: ["documentId"] },
  { id: "document-create", moduleId: "collab", title: "Create collaborative document", description: "Create a validated structured document and immutable initial revision.", operation: "command", recordType: "document", requiredFields: ["spaceId", "title", "blocks"] },
  { id: "canvas-get", moduleId: "collab", title: "Read collaborative canvas", description: "Read one tenant-scoped canvas head and exact current revision.", operation: "read", recordType: "canvas", requiredFields: ["canvasId"] },
  { id: "canvas-create", moduleId: "collab", title: "Create collaborative canvas", description: "Create a finite validated canvas and immutable initial revision.", operation: "command", recordType: "canvas", requiredFields: ["spaceId", "title", "elements"] },
  { id: "operation-apply", moduleId: "collab", title: "Apply collaboration operation", description: "Apply a size-bounded safe operation envelope idempotently against an exact resource version.", operation: "command", recordType: "operation", requiredFields: ["resourceId", "operationId", "baseVersion", "operations"] },
  { id: "patch-propose", moduleId: "collab", title: "Propose collaboration patch", description: "Queue an approval-required AI patch over an exact selected revision without mutating canonical content.", operation: "ai", goalField: "instruction", requiredFields: ["instruction", "resourceId", "sourceRevisionId", "selection"] },
  { id: "patch-apply", moduleId: "collab", title: "Apply approved collaboration patch", description: "Apply a persisted proposal only after explicit approval and when its source and current resource versions still match exactly.", operation: "command", recordType: "ai-patch", requiredFields: ["proposalId", "resourceId", "sourceRevisionId", "expectedVersion", "approval"] },
  { id: "comment-create", moduleId: "collab", title: "Create collaboration comment", description: "Append a safe comment thread anchored to one tenant-scoped resource.", operation: "command", recordType: "comment-thread", requiredFields: ["resourceId", "anchorId", "body"] },
  { id: "revision-list", moduleId: "collab", title: "List collaboration revisions", description: "List immutable revisions for one tenant-scoped resource.", operation: "read", recordType: "revision", requiredFields: ["resourceId"] },
  { id: "revision-create", moduleId: "collab", title: "Create named collaboration revision", description: "Create an immutable named checkpoint from an exact current resource version.", operation: "command", recordType: "revision", requiredFields: ["resourceId", "expectedVersion", "reason"] },
  { id: "revision-compare", moduleId: "collab", title: "Compare collaboration revisions", description: "Compare two immutable revisions of the same tenant-scoped resource without changing history.", operation: "read", recordType: "revision", requiredFields: ["resourceId", "fromRevisionId", "toRevisionId"] },
  { id: "revision-restore", moduleId: "collab", title: "Restore collaboration revision", description: "Restore a historical snapshot by creating a new linked head while preserving all prior revisions.", operation: "command", recordType: "revision", requiredFields: ["resourceId", "revisionId", "expectedVersion"] },
  { id: "share-create", moduleId: "collab", title: "Create pinned collaboration share", description: "Create an expiring pinned-revision share while persisting only a token hash.", operation: "command", recordType: "share-link", requiredFields: ["resourceId", "revisionId", "permission", "expiresAt"] },
  { id: "export-create", moduleId: "collab", title: "Create collaboration export", description: "Queue a format-checked export pinned to one exact immutable revision.", operation: "command", recordType: "export-job", requiredFields: ["resourceId", "revisionId", "format"] },
  { id: "host-create", moduleId: "schedule", title: "Create scheduling host", description: "Create a tenant-scoped reservable host before assigning availability.", operation: "create", recordType: "host", titleField: "name", resultingState: "active", requiredFields: ["name"] },
  { id: "host-list", moduleId: "schedule", title: "List scheduling hosts", description: "List tenant-scoped active and retired scheduling hosts without exposing invitee data.", operation: "read", recordType: "host", requiredFields: [] },
  { id: "schedule-draft", moduleId: "schedule", title: "Draft availability schedule", description: "Create a content-addressed schedule revision after deterministic time-zone and overlap validation.", operation: "command", recordType: "schedule-revision", requiredFields: ["name", "timeZone", "windows", "hostIds"] },
  { id: "schedule-publish", moduleId: "schedule", title: "Publish availability schedule", description: "Publish only the exact validated immutable schedule revision hash.", operation: "command", recordType: "schedule-revision", requiredFields: ["revisionId", "contentHash"] },
  { id: "event-draft", moduleId: "schedule", title: "Draft scheduling event", description: "Create an immutable event-release draft bound to published availability and explicit hosts.", operation: "command", recordType: "event-release", requiredFields: ["name", "slug", "scheduleRevisionId", "hostIds", "durationMinutes"] },
  { id: "event-publish", moduleId: "schedule", title: "Publish scheduling event", description: "Publish only the exact event release whose schedule and content hash remain valid.", operation: "command", recordType: "event-release", requiredFields: ["releaseId", "contentHash"] },
  { id: "availability-preview", moduleId: "schedule", title: "Preview availability", description: "Return bounded eligible UTC intervals from the exact published release without holding capacity.", operation: "read", recordType: "slot-snapshot", requiredFields: ["releaseId", "from", "to", "timeZone"] },
  { id: "routing-preview", moduleId: "schedule", title: "Preview deterministic routing", description: "Resolve an eligible host deterministically from the exact published host pool and supplied allowlisted answers.", operation: "read", recordType: "slot-snapshot", requiredFields: ["releaseId", "routingAnswers"] },
  { id: "booking-create", moduleId: "schedule", title: "Create conflict-safe booking", description: "Revalidate and atomically reserve one exact host interval with idempotent retry behavior.", operation: "command", recordType: "booking", requiredFields: ["releaseId", "hostId", "startsAt", "endsAt", "idempotencyKey"] },
  { id: "booking-get", moduleId: "schedule", title: "Read booking", description: "Read one tenant-owned booking and its immutable release and version evidence.", operation: "read", recordType: "booking", requiredFields: ["bookingId"] },
  { id: "booking-reschedule-preview", moduleId: "schedule", title: "Preview booking reschedule", description: "Check a replacement interval against current active capacity without mutating the booking.", operation: "read", recordType: "booking", requiredFields: ["bookingId", "startsAt", "endsAt"] },
  { id: "booking-reschedule", moduleId: "schedule", title: "Reschedule booking", description: "Create one active successor and retire its exact-version predecessor under a single scheduling lock.", operation: "command", recordType: "booking", requiredFields: ["bookingId", "startsAt", "endsAt", "expectedVersion", "idempotencyKey"] },
  { id: "booking-cancel", moduleId: "schedule", title: "Cancel booking", description: "Cancel an exact booking version idempotently and append one logical cancellation event.", operation: "command", recordType: "booking", requiredFields: ["bookingId", "expectedVersion", "reason"] },
  { id: "connector-health", moduleId: "schedule", title: "Read connector health", description: "Report configured connector evidence without claiming an unverified provider result.", operation: "read", recordType: "connector", requiredFields: [] },
  { id: "booking-export", moduleId: "schedule", title: "Export bookings", description: "Create a bounded deterministic JSON or iCalendar export projection without provider mutation.", operation: "read", recordType: "booking", requiredFields: ["from", "to", "format"] },
  { id: "unavailability-explain", moduleId: "schedule", title: "Explain unavailability", description: "Explain an interval from exact release, schedule, and privacy-safe conflict evidence.", operation: "read", recordType: "booking", requiredFields: ["releaseId", "hostId", "startsAt", "endsAt"] },
  { id: "form-create", moduleId: "forms", title: "Create form", description: "Create a tenant-scoped form shell before drafting immutable releases.", operation: "create", recordType: "form", titleField: "name", resultingState: "draft", requiredFields: ["name"] },
  { id: "form-list", moduleId: "forms", title: "List forms", description: "List tenant-scoped forms without respondent values.", operation: "read", recordType: "form", requiredFields: [] },
  { id: "form-draft", moduleId: "forms", title: "Draft form release", description: "Create an immutable form-release draft containing bounded schema and deterministic logic.", operation: "command", recordType: "form-release", requiredFields: ["formId", "title", "schema", "logic"] },
  { id: "schema-validate", moduleId: "forms", title: "Validate form schema", description: "Validate the exact draft schema vocabulary, stable keys, types, purposes, and bounds without mutation.", operation: "read", recordType: "form-release", requiredFields: ["releaseId"] },
  { id: "logic-validate", moduleId: "forms", title: "Validate form logic", description: "Validate exact-release references, typed effects, and acyclic reachability without executing code.", operation: "read", recordType: "form-release", requiredFields: ["releaseId"] },
  { id: "release-diff", moduleId: "forms", title: "Diff form release", description: "Return a deterministic semantic field diff against the preceding published release.", operation: "read", recordType: "form-release", requiredFields: ["releaseId"] },
  { id: "release-publish", moduleId: "forms", title: "Publish form release", description: "Publish only the exact schema-and-logic content hash after complete deterministic validation.", operation: "command", recordType: "form-release", requiredFields: ["releaseId", "contentHash", "idempotencyKey"] },
  { id: "submission-validate", moduleId: "forms", title: "Validate form submission", description: "Validate canonical answers server-side against the exact immutable release and its logic.", operation: "read", recordType: "submission", requiredFields: ["releaseId", "responseValues"] },
  { id: "submission-create", moduleId: "forms", title: "Create form submission", description: "Finalize one exact-release submission idempotently after server-side validation.", operation: "command", recordType: "submission", requiredFields: ["releaseId", "responseValues", "idempotencyKey"] },
  { id: "submission-get", moduleId: "forms", title: "Read form submission", description: "Read one tenant-owned submission with immutable release and correction lineage.", operation: "read", recordType: "submission", requiredFields: ["submissionId"] },
  { id: "submission-correct", moduleId: "forms", title: "Correct form submission", description: "Append an exact-release validated correction while preserving the original answer version.", operation: "command", recordType: "submission-version", requiredFields: ["submissionId", "responseValues", "expectedVersion", "reason"] },
  { id: "results-query", moduleId: "forms", title: "Query form results", description: "Return a bounded aggregate result with an explicit denominator and query clock.", operation: "read", recordType: "submission", requiredFields: ["formId"] },
  { id: "results-summarize", moduleId: "forms", title: "Summarize form results", description: "Produce a deterministic evidence-linked summary without inventing or exposing respondent facts.", operation: "read", recordType: "submission", requiredFields: ["formId"] },
  { id: "export-preview", moduleId: "forms", title: "Preview form export", description: "Freeze a bounded field projection and formula-protection plan before creating an export.", operation: "command", recordType: "export", requiredFields: ["formId", "fields", "format"] },
  { id: "export-create", moduleId: "forms", title: "Create form export", description: "Create only the exact reviewed export projection with idempotent content-hash confirmation.", operation: "command", recordType: "export", requiredFields: ["exportId", "contentHash", "idempotencyKey"] },
  { id: "rights-preview", moduleId: "forms", title: "Preview respondent rights request", description: "Create a privacy-safe affected-record plan from a workspace-scoped respondent key digest.", operation: "read", recordType: "rights-request", requiredFields: ["respondentKey"] },
  { id: "project-create", moduleId: "flags", title: "Create feature-flag project", description: "Create a tenant-scoped flag project before authoring typed revisions.", operation: "create", recordType: "flag-project", titleField: "name", resultingState: "active", requiredFields: ["name"] },
  { id: "project-list", moduleId: "flags", title: "List feature-flag projects", description: "List tenant-scoped flag projects without SDK credentials or experiment internals.", operation: "read", recordType: "flag-project", requiredFields: [] },
  { id: "flag-draft", moduleId: "flags", title: "Draft typed feature flag", description: "Create a content-addressed configuration revision with typed variants, safe fallback, and bounded deterministic rules.", operation: "command", recordType: "config-revision", requiredFields: ["projectId", "environmentKey", "key", "valueType", "safeValue", "variants", "rules"] },
  { id: "revision-validate", moduleId: "flags", title: "Validate flag revision", description: "Validate the exact revision types, rules, fractional weights, safe fallback, and canonical hash.", operation: "read", recordType: "config-revision", requiredFields: ["revisionId"] },
  { id: "rollout-preview", moduleId: "flags", title: "Preview flag rollout", description: "Evaluate bounded conformance contexts against an exact unpublished revision without mutation.", operation: "read", recordType: "config-revision", requiredFields: ["revisionId", "contexts"] },
  { id: "revision-diff", moduleId: "flags", title: "Diff flag revision", description: "Return a semantic diff against the active environment revision.", operation: "read", recordType: "config-revision", requiredFields: ["revisionId"] },
  { id: "revision-approve", moduleId: "flags", title: "Approve flag revision", description: "Approve only the exact immutable revision content hash.", operation: "command", recordType: "approval", requiredFields: ["revisionId", "contentHash"] },
  { id: "revision-publish", moduleId: "flags", title: "Publish flag revision", description: "Atomically advance one environment only when exact approval, hash, and base version still match.", operation: "command", recordType: "manifest", requiredFields: ["revisionId", "contentHash", "baseVersion", "idempotencyKey"] },
  { id: "evaluate", moduleId: "flags", title: "Evaluate feature flag", description: "Evaluate a typed flag deterministically from the active local manifest and append a privacy-safe explanation receipt.", operation: "command", recordType: "evaluation-receipt", requiredFields: ["projectId", "environmentKey", "flagKey", "expectedType", "defaultValue", "context", "subjectKey"] },
  { id: "evaluation-explain", moduleId: "flags", title: "Explain flag evaluation", description: "Explain one exact privacy-safe evaluation receipt without receiving raw context.", operation: "read", recordType: "evaluation-receipt", requiredFields: ["receiptId"] },
  { id: "manifest-export", moduleId: "flags", title: "Export flag manifest", description: "Export the exact active audience-safe manifest and its content hash.", operation: "read", recordType: "manifest", requiredFields: ["projectId", "environmentKey", "audience"] },
  { id: "exposure-record", moduleId: "flags", title: "Record experiment exposure", description: "Deduplicate exact first exposure and retain conflicting multiple-variant evidence as a quality warning.", operation: "command", recordType: "exposure", requiredFields: ["experimentId", "subjectKey", "variant", "sourceEventId"] },
  { id: "experiment-draft", moduleId: "flags", title: "Draft feature experiment", description: "Preregister immutable variants, weights, minimum sample, duration, and quality gates.", operation: "command", recordType: "experiment", requiredFields: ["projectId", "flagId", "hypothesis", "variants", "weights", "minimumSample", "minimumDurationHours"] },
  { id: "experiment-start", moduleId: "flags", title: "Start feature experiment", description: "Start only the exact preregistered experiment version and content hash.", operation: "command", recordType: "experiment", requiredFields: ["experimentId", "expectedVersion", "contentHash"] },
  { id: "experiment-analyze", moduleId: "flags", title: "Analyze feature experiment", description: "Compute reproducible counts and required quality gates while suppressing winner language on any failure.", operation: "read", recordType: "analysis-run", requiredFields: ["experimentId"] },
  { id: "revision-rollback", moduleId: "flags", title: "Roll back flag revision", description: "Republish a prior exact revision as a new monotonic version with preserved lineage.", operation: "command", recordType: "rollback-event", requiredFields: ["revisionId", "contentHash", "baseVersion", "idempotencyKey"] },
  { id: "stale-review", moduleId: "flags", title: "Review stale flags", description: "Return evidence-backed expired or inactive flag suggestions without mutating configuration.", operation: "read", recordType: "flag", requiredFields: ["projectId"] },
];

for (const action of coreBusinessActions) {
  suiteActions.push({
    id: action.id,
    moduleId: action.moduleId,
    title: action.title,
    description: action.description,
    operation: action.operation,
    recordType: action.recordType,
    requiredFields: [...action.inputSchema.required],
    engine: "core",
    inputSchema: action.inputSchema,
    exampleInput: action.exampleInput,
    requiredScope: action.requiredScope === "external" ? "write" : action.requiredScope,
    mcpToolName: action.mcpToolName,
    cliExample: action.cliExample,
    risk: action.risk,
    destructive: action.destructive,
    externalEffect: action.externalEffect,
    idempotent: action.operation !== "read",
  });
}

for (const action of premiumBusinessActions) {
  suiteActions.push({
    id: action.id,
    moduleId: action.moduleId,
    title: action.title,
    description: action.description,
    operation: action.operation === "mutation" ? "command" : action.operation,
    requiredFields: [...action.inputSchema.required],
    engine: "premium",
    inputSchema: {
      type: "object",
      required: [...action.inputSchema.required],
      properties: Object.fromEntries(
        Object.entries(action.inputSchema.properties).map(([key, value]) => [
          key,
          { ...value },
        ]),
      ),
      additionalProperties: false,
    },
    requiredScope: action.requiredScope,
    mcpToolName: action.mcpToolName,
    cliExample: `supersuite action ${action.moduleId} ${action.id} '<json-input>'`,
    risk: action.risk,
    destructive: action.destructive,
    externalEffect: action.externalEffect,
    idempotent: action.idempotent,
  });
}

for (const action of firstPartyGrowthActions) {
  suiteActions.push({
    id: action.id,
    moduleId: action.moduleId,
    title: action.title,
    description: action.description,
    operation: action.operation,
    recordType: action.recordType,
    requiredFields: [...action.inputSchema.required],
    engine: "growth",
    inputSchema: action.inputSchema,
    exampleInput: action.exampleInput,
    requiredScope: action.requiredScope === "external" ? "write" : action.requiredScope,
    mcpToolName: action.mcpToolName,
    cliExample: action.cliExample,
    risk: action.risk,
    destructive: action.destructive,
    externalEffect: action.externalEffect,
    idempotent: action.idempotent,
  });
}

for (const action of esignActions) {
  suiteActions.push({
    id: action.id,
    moduleId: action.moduleId,
    title: action.title,
    description: action.description,
    operation: action.operation,
    recordType: action.recordType,
    requiredFields: [...action.inputSchema.required],
    engine: "esign",
    inputSchema: action.inputSchema,
    exampleInput: action.exampleInput,
    requiredScope: action.requiredScope === "external" ? "write" : action.requiredScope,
    mcpToolName: action.mcpToolName,
    cliExample: action.cliExample,
    risk: action.risk,
    destructive: action.destructive,
    externalEffect: action.effectBoundary,
    idempotent: action.idempotent,
  });
}

for (const action of emailActions) {
  suiteActions.push({
    id: action.id,
    moduleId: action.moduleId,
    title: action.title,
    description: action.description,
    operation: action.operation,
    recordType: action.recordType,
    requiredFields: [...action.inputSchema.required],
    engine: "email",
    inputSchema: action.inputSchema,
    exampleInput: action.exampleInput,
    requiredScope: action.requiredScope === "external" ? "write" : action.requiredScope,
    mcpToolName: action.mcpToolName,
    cliExample: action.cliExample,
    risk: action.risk,
    destructive: action.destructive,
    externalEffect: action.effectBoundary,
    idempotent: action.idempotent,
  });
}

export const suiteActionsByModule = new Map<string, SuiteActionDefinition[]>();
for (const action of suiteActions) suiteActionsByModule.set(action.moduleId, [...(suiteActionsByModule.get(action.moduleId) ?? []), action]);

export function suiteAction(moduleId: string, actionId: string) {
  return suiteActionsByModule.get(moduleId)?.find((action) => action.id === actionId);
}

const fieldKinds: Record<string, SuiteActionFieldKind> = {
  email: "email",
  consent: "boolean",
  approval: "boolean",
  destination: "url",
  origin: "url",
  scheduledAt: "datetime",
  closesAt: "datetime",
  startedAt: "datetime",
  endedAt: "datetime",
  issueAt: "datetime",
  dueAt: "datetime",
  expiresAt: "datetime",
  from: "datetime",
  to: "datetime",
  startsAt: "datetime",
  endsAt: "datetime",
  links: "array",
  lineItems: "array",
  sourceIds: "array",
  urls: "array",
  purposes: "array",
  services: "array",
  decisions: "array",
  evidenceIds: "array",
  channels: "array",
  pipelineStages: "array",
  answers: "array",
  ratings: "array",
  blocks: "array",
  elements: "array",
  operations: "array",
  selection: "array",
  windows: "array",
  hostIds: "array",
  fields: "array",
  logic: "array",
  variants: "array",
  rules: "array",
  contexts: "array",
  weights: "array",
  schema: "object",
  payload: "object",
  template: "object",
  routingAnswers: "object",
  responseValues: "object",
  context: "object",
  safeValue: "json",
  defaultValue: "json",
  amountMinor: "integer",
  rateMinor: "integer",
  version: "integer",
  expectedVersion: "integer",
  baseVersion: "integer",
  durationMinutes: "integer",
  minimumSample: "integer",
  minimumDurationHours: "integer",
  contentHash: "sha256",
  previewHash: "sha256",
  currency: "currency",
  code: "slug",
  slug: "slug",
};

const fieldDescriptions: Record<string, string> = {
  email: "Valid email address.",
  consent: "Explicit consent; must be true.",
  approval: "Explicit proposal approval; must be true.",
  destination: "HTTP or HTTPS destination URL.",
  origin: "Canonical HTTP or HTTPS site origin.",
  scheduledAt: "ISO 8601 date-time at which publication should occur.",
  closesAt: "ISO 8601 date-time at which the contest closes.",
  startedAt: "ISO 8601 date-time at which tracked work started.",
  endedAt: "ISO 8601 date-time at which tracked work ended.",
  issueAt: "ISO 8601 invoice issue date-time.",
  dueAt: "ISO 8601 invoice due date-time.",
  expiresAt: "ISO 8601 date-time after which access expires.",
  links: "Array of link objects for the page.",
  lineItems: "Array of invoice line-item objects.",
  sourceIds: "Array of approved workspace source-record UUIDs.",
  urls: "Array of bounded, in-scope HTTP or HTTPS URLs.",
  purposes: "Array of purpose snapshots with stable keys, labels, descriptions, and required flags.",
  services: "Array of service snapshots referencing declared purpose keys.",
  decisions: "Array of one boolean decision for every purpose key in the active policy.",
  evidenceIds: "Array of workspace-owned evidence record UUIDs.",
  channels: "Array of explicitly allowed notification channel names.",
  pipelineStages: "Ordered array of unique workspace-defined non-terminal pipeline stage keys.",
  answers: "Array of candidate-supplied application answers without protected or inferred traits.",
  ratings: "Array of structured competency ratings with evidence labels.",
  blocks: "Array of safe structured document blocks.",
  elements: "Array of finite, safe structured canvas elements.",
  operations: "Array of bounded, versioned collaboration operations.",
  selection: "Array describing the explicit resource selection authorized for an AI proposal.",
  schema: "Bounded JSON Schema object using the supported safe subset.",
  payload: "Event payload object validated against its published schema.",
  template: "Safe plain-text notification template object.",
  amountMinor: "Positive integer amount in the currency's minor unit.",
  rateMinor: "Non-negative integer hourly rate in the currency's minor unit.",
  version: "Positive integer immutable version number.",
  expectedVersion: "Positive integer version required for optimistic concurrency.",
  baseVersion: "Positive integer resource version on which an operation was authored.",
  contentHash: "Lowercase SHA-256 digest of the exact content being approved.",
  previewHash: "Lowercase SHA-256 digest returned by the matching transition preview.",
  currency: "Three-letter uppercase ISO currency code.",
  code: "Lowercase route code containing letters, numbers, and hyphens.",
  slug: "Lowercase URL slug containing letters, numbers, and hyphens.",
};

function fieldKind(name: string): SuiteActionFieldKind {
  if (fieldKinds[name]) return fieldKinds[name];
  return name.endsWith("Id") ? "uuid" : "string";
}

function fieldExample(name: string, kind: SuiteActionFieldKind): unknown {
  if (kind === "email") return "person@example.com";
  if (kind === "boolean") return true;
  if (kind === "url") return "https://example.com";
  if (kind === "datetime") return "2030-01-01T12:00:00Z";
  if (kind === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (kind === "array") return [];
  if (kind === "object") return {};
  if (kind === "json") return false;
  if (kind === "integer") return 1;
  if (kind === "sha256") return "0".repeat(64);
  if (kind === "currency") return "USD";
  if (kind === "slug") return name === "code" ? "launch" : "launch-page";
  if (name === "idempotencyKey") return "request.sample-0001";
  if (name === "promptVersion") return "policy-v1";
  if (name === "modelId") return "local-model";
  if (name === "key" || name.endsWith("Key")) return "sample-key";
  return `<${name}>`;
}

export function suiteActionFields(action: SuiteActionDefinition): SuiteActionFieldDefinition[] {
  const schema = action.inputSchema;
  const names = schema ? Object.keys(schema.properties) : action.requiredFields;
  const required = new Set(action.requiredFields);
  return names.map((name) => {
    const property = schema?.properties[name];
    const kind: SuiteActionFieldKind = property?.type === "boolean" ? "boolean"
      : property?.type === "array" ? "array"
      : property?.type === "object" ? "object"
      : property?.type === "integer" ? "integer"
      : property?.format === "email" ? "email"
      : property?.format === "uri" ? "url"
      : property?.format === "date-time" ? "datetime"
      : property?.format === "uuid" ? "uuid"
      : property?.pattern === "^[a-f0-9]{64}$" ? "sha256"
      : property?.pattern === "^[A-Z]{3}$" ? "currency"
      : property?.type === "string" ? "string"
      : fieldKind(name);
    const readableName = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return {
      name,
      kind,
      description: typeof property?.description === "string" ? property.description : fieldDescriptions[name] ?? (kind === "uuid" ? `${readableName} UUID.` : `Non-empty ${readableName}.`),
      example: action.exampleInput && name in action.exampleInput ? action.exampleInput[name] : schemaExample(property, name, kind),
      required: required.has(name),
    };
  });
}

function schemaExample(schema: Record<string, unknown> | undefined, name: string, kind: SuiteActionFieldKind): unknown {
  if (!schema) return fieldExample(name, kind);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return schemaExample(schema.anyOf[0] as Record<string, unknown>, name, kind);
  if (schema.type === "array") {
    const minimum = Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 0);
    const item = schema.items && typeof schema.items === "object" ? schemaExample(schema.items as Record<string, unknown>, `${name}Item`, "json") : {};
    return Array.from({ length: minimum }, () => item);
  }
  if (schema.type === "object") {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    if (name === "approval" && !required.length) return { approved: true, approvedBy: "00000000-0000-4000-8000-000000000001", approvedAt: "2030-01-01T12:00:00Z", reason: "Reviewed and approved." };
    return Object.fromEntries(required.map((key) => [key, schemaExample(properties[key], key, fieldKind(key))]));
  }
  if (schema.type === "integer") return Math.max(1, typeof schema.minimum === "number" ? schema.minimum : 1);
  if (schema.type === "boolean") return true;
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (schema.format === "email") return "person@example.com";
  if (schema.format === "uri") return "https://example.com";
  if (schema.format === "date-time") return "2030-01-01T12:00:00Z";
  if (schema.pattern === "^[a-f0-9]{64}$") return "0".repeat(64);
  if (schema.pattern === "^[A-Z]{3}$") return "USD";
  if (schema.pattern === "^[a-z][a-z0-9-]{1,39}$") return "sample-key";
  if (schema.pattern === "^[A-Za-z0-9._:-]{16,200}$") return "request.sample-0001";
  if (schema.pattern === "^[A-Za-z0-9._:-]{3,120}$") return "policy-v1";
  if (schema.pattern === "^[A-Za-z0-9._-]{2,80}$") return "sample-ref";
  if (schema.pattern === "^\\d{4}-\\d{2}$") return "2030-01";
  if (schema.type === "string") return fieldExample(name, "string");
  return fieldExample(name, kind);
}

function jsonSchemaForField(field: SuiteActionFieldDefinition): Record<string, unknown> {
  const common = { description: field.description, examples: [field.example] };
  if (field.kind === "boolean") return { ...common, type: "boolean", const: true };
  if (field.kind === "array") return { ...common, type: "array", items: {} };
  if (field.kind === "object") return { ...common, type: "object", additionalProperties: true };
  if (field.kind === "json") return { ...common };
  if (field.kind === "integer") return { ...common, type: "integer" };
  if (field.kind === "sha256") return { ...common, type: "string", pattern: "^[a-f0-9]{64}$" };
  if (field.kind === "email") return { ...common, type: "string", format: "email" };
  if (field.kind === "url") return { ...common, type: "string", format: "uri", pattern: "^https?://" };
  if (field.kind === "datetime") return { ...common, type: "string", format: "date-time" };
  if (field.kind === "uuid") return { ...common, type: "string", format: "uuid" };
  if (field.kind === "currency") return { ...common, type: "string", pattern: "^[A-Z]{3}$" };
  if (field.kind === "slug") return { ...common, type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,79}$" };
  return { ...common, type: "string", minLength: 1 };
}

export function suiteActionInputJsonSchema(action: SuiteActionDefinition): SuiteActionInputJsonSchema {
  if (action.inputSchema) return action.inputSchema;
  return {
    type: "object",
    required: [...action.requiredFields],
    properties: Object.fromEntries(suiteActionFields(action).map((field) => [field.name, jsonSchemaForField(field)])),
    additionalProperties: true,
  };
}

export function suiteActionExampleInput(action: SuiteActionDefinition): Record<string, unknown> {
  return Object.fromEntries(suiteActionFields(action).filter((field) => field.required).map((field) => [field.name, field.example]));
}

export function suiteActionRequiredScope(action: SuiteActionDefinition): SuiteActionRequiredScope {
  return action.requiredScope ?? (action.operation === "ai" ? "ai" : action.operation === "read" ? "read" : "write");
}

export function suiteActionToolName(action: SuiteActionDefinition) {
  return action.mcpToolName ?? `${action.moduleId.replaceAll("-", "_")}_${action.id.replaceAll("-", "_")}`;
}
