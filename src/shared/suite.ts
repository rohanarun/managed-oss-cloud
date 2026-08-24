import {
  additiveBusinessActionsByModule,
  additiveBusinessModules,
} from "./additive-business-actions.js";
import {
  additiveWaveTwoActionsByModule,
  additiveWaveTwoModules,
} from "./extended-business-actions.js";

export type SuitePaidPlanId = "starter" | "scale" | "fleet";
export type SuitePlanId = "none" | SuitePaidPlanId;
export type SuiteResourceClass = "shared" | "high" | "accelerated";
export type SuiteWorkspaceRole = "owner" | "admin" | "member" | "viewer";
export const suiteApiTokenScopes = ["read", "write", "ai"] as const;
export type SuiteApiTokenScope = typeof suiteApiTokenScopes[number];

export interface SuiteApiTokenSummary {
  id: string;
  name: string;
  scopes: SuiteApiTokenScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface SuiteApiTokenSecret extends SuiteApiTokenSummary {
  token: string;
}

export interface SuiteApiTokenPrincipal {
  tokenId: string;
  userId: string;
  scopes: SuiteApiTokenScope[];
}

export interface SuiteModuleDefinition {
  id: string;
  name: string;
  inspiredBy: string;
  category: string;
  description: string;
  minPlan: SuitePaidPlanId;
  resourceClass: SuiteResourceClass;
  resourceRequirements?: {
    class: SuiteResourceClass;
    minimumCpuMillicores: number;
    minimumMemoryMiB: number;
    includedStorageGb: number;
    recommendedWorkerConcurrency: number;
  };
  recordTypes: string[];
  aiCapabilities: string[];
  scaleGuidance?: string;
  externalUsage?: string[];
}

export interface SuiteWorkspace {
  id: string;
  userId: string;
  name: string;
  slug: string;
  plan: SuitePlanId;
  enabledModuleIds: string[];
  currentRole?: SuiteWorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

export interface SuiteWorkspaceMember {
  userId: string;
  role: SuiteWorkspaceRole;
  createdAt: string;
}

export interface SuiteRecord {
  id: string;
  workspaceId: string;
  moduleId: string;
  recordType: string;
  title: string;
  state: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SuiteAiAction {
  id: string;
  workspaceId: string;
  moduleId: string;
  goal: string;
  context: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed";
  result?: Record<string, unknown>;
  attempts?: number;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

const aiReadScopes: Record<string, string[]> = {
  automate: ["automate"], publish: ["publish", "drive"], inbox: ["inbox", "crm", "knowledge"], crm: ["crm", "inbox"],
  tasks: ["tasks", "projects"], feedback: ["feedback", "crm"], knowledge: ["knowledge"], links: ["links", "brand-pages"],
  giveaways: ["giveaways"], testimonials: ["testimonials", "crm"], "brand-pages": ["brand-pages", "links"], projects: ["projects", "tasks"],
  drive: ["drive"], channels: ["channels", "tasks"], operations: ["operations", "crm"], assistant: ["assistant"],
  consent: ["consent"], seo: ["seo"], finance: ["finance"], notify: ["notify"], hire: ["hire"], collab: ["collab"],
  schedule: ["schedule", "notify", "crm"], forms: ["forms", "crm"], flags: ["flags"],
  esign: ["esign", "drive", "knowledge"],
  email: ["email", "knowledge", "crm", "feedback"],
};

const explicitCrossToolEvidenceModules = new Set([
  "projects", "drive", "channels", "operations",
  "tables", "meetings", "insights", "learning", "community",
  "events", "people", "metering", "assurance", "live",
]);

export function suiteAiReadScopes(moduleId: string, options: { explicitSelection?: boolean } = {}) {
  if (options.explicitSelection && explicitCrossToolEvidenceModules.has(moduleId)) return suiteModules.map((module) => module.id);
  return aiReadScopes[moduleId] ?? [moduleId];
}

const additiveCategoryReferences: Record<string, string> = {
  tables: "Public relational-data and spreadsheet patterns",
  meetings: "Public meeting transcript and action-ledger patterns",
  insights: "Public business-intelligence and measurement patterns",
  learning: "Public learning-management and credential patterns",
  community: "Public forum and community-management patterns",
};

const extendedCategoryReferences: Record<string, string> = {
  events: "Public event, ticketing, and access-control patterns",
  people: "Public HRIS and employment-record patterns",
  metering: "Public usage-metering and billing-ledger patterns",
  assurance: "Public risk, control, and audit-evidence patterns",
  live: "Public livestream, chat, and media-consent patterns",
};

const additiveSuiteModules: SuiteModuleDefinition[] = additiveBusinessModules.map((module) => ({
  id: module.id,
  name: module.name,
  inspiredBy: additiveCategoryReferences[module.id],
  category: module.category,
  description: module.originalProductThesis,
  minPlan: module.minPlan,
  resourceClass: module.resource.class,
  resourceRequirements: { ...module.resource },
  recordTypes: [...new Set([
    ...(additiveBusinessActionsByModule.get(module.id) ?? []).map((action) => action.recordType),
    "additive-command-receipt",
  ])],
  aiCapabilities: [...module.aiNativeQualities],
}));

const extendedSuiteModules: SuiteModuleDefinition[] = additiveWaveTwoModules.map((module) => ({
  id: module.id,
  name: module.name,
  inspiredBy: extendedCategoryReferences[module.id],
  category: module.category,
  description: module.originalProductThesis,
  minPlan: module.minPlan,
  resourceClass: module.resource.class,
  resourceRequirements: { ...module.resource },
  recordTypes: [...new Set([
    ...(additiveWaveTwoActionsByModule.get(module.id) ?? []).map((action) => action.recordType),
    ...(module.id === "metering" ? ["credit-application-receipt"] : []),
    "extended-business-command-receipt",
  ])],
  aiCapabilities: [...module.aiNativeQualities],
}));

export const suiteModules: SuiteModuleDefinition[] = [
  {
    id: "automate",
    name: "Automate",
    inspiredBy: "Activepieces",
    category: "Automation",
    description: "Agent-authored workflows with typed triggers, approvals, retries, and a shared event bus.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["flow", "trigger", "run", "connection"],
    aiCapabilities: ["draft workflow", "repair failed run", "explain automation"],
  },
  {
    id: "publish",
    name: "Publish",
    inspiredBy: "Postiz",
    category: "Social publishing",
    description: "Plan, adapt, approve, schedule, and measure content across connected channels.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["post", "campaign", "channel", "media"],
    aiCapabilities: ["adapt by channel", "build campaign", "summarize performance"],
  },
  {
    id: "inbox",
    name: "Inbox",
    inspiredBy: "Chatwoot",
    category: "Customer support",
    description: "A shared customer inbox with AI triage, suggested replies, SLAs, and human approval.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["conversation", "message", "inbox", "sla"],
    aiCapabilities: ["triage conversation", "draft reply", "detect escalation"],
  },
  {
    id: "crm",
    name: "CRM",
    inspiredBy: "Frappe CRM",
    category: "Customer relationships",
    description: "Contacts, companies, pipelines, activities, and autonomous follow-up plans in one graph.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["contact", "company", "deal", "activity"],
    aiCapabilities: ["enrich record", "summarize relationship", "recommend next action"],
  },
  {
    id: "tasks",
    name: "Tasks",
    inspiredBy: "Vikunja",
    category: "Task management",
    description: "Projects, tasks, dependencies, recurring work, and agent-generated execution plans.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["project", "task", "milestone", "label"],
    aiCapabilities: ["break down goal", "prioritize backlog", "write progress update"],
  },
  {
    id: "feedback",
    name: "Feedback",
    inspiredBy: "Fider",
    category: "Product feedback",
    description: "Feedback boards connected to customers, revenue, releases, and evidence-backed roadmaps.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["suggestion", "vote", "roadmap-item", "release"],
    aiCapabilities: ["deduplicate feedback", "cluster themes", "draft release note"],
  },
  {
    id: "knowledge",
    name: "Knowledge",
    inspiredBy: "BookStack",
    category: "Knowledge base",
    description: "Structured documentation with semantic retrieval, source citations, and answer generation.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["space", "page", "block", "attachment"],
    aiCapabilities: ["answer with citations", "draft page", "detect stale guidance"],
  },
  {
    id: "links",
    name: "Links",
    inspiredBy: "Slash",
    category: "Link management",
    description: "Branded short links, routing rules, conversion events, and privacy-conscious analytics.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["link", "route", "event", "domain"],
    aiCapabilities: ["name link", "detect broken destination", "summarize traffic"],
  },
  {
    id: "giveaways",
    name: "Giveaways",
    inspiredBy: "KingSumo",
    category: "Growth",
    description: "Referral contests with fraud signals, weighted entries, landing pages, and winner audits.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["contest", "entrant", "referral", "reward"],
    aiCapabilities: ["draft contest", "review fraud signals", "write winner announcement"],
  },
  {
    id: "testimonials",
    name: "Testimonials",
    inspiredBy: "Testimonial collection tools",
    category: "Social proof",
    description: "Collect, approve, tag, and publish written or video testimonials through embeddable widgets.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["request", "testimonial", "widget", "consent"],
    aiCapabilities: ["draft request", "extract highlights", "flag sensitive claims"],
  },
  {
    id: "brand-pages",
    name: "Brand Pages",
    inspiredBy: "QR and link-in-bio tools",
    category: "Brand presence",
    description: "Dynamic QR codes and fast link-in-bio pages with reusable brand systems and analytics.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["page", "qr-code", "theme", "event"],
    aiCapabilities: ["compose page", "generate campaign variants", "summarize conversions"],
  },
  {
    id: "consent",
    name: "Consent & Privacy",
    inspiredBy: "Public consent and GPC standards",
    category: "Privacy operations",
    description: "Versioned consent policies, bounded resource scans, domain proof, append-only choice receipts, and evidence-first privacy operations.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["site", "scan-run", "resource-observation", "service", "purpose", "policy-revision", "consent-receipt", "alert"],
    aiCapabilities: ["suggest evidence-backed classification", "explain policy drift", "draft unreviewed descriptions"],
    scaleGuidance: "Use Scale for many domains, frequent scans, large bounded exports, or long receipt retention.",
    externalUsage: ["customer-selected CDN", "customer-selected geolocation", "customer-selected scanning proxy"],
  },
  {
    id: "seo",
    name: "SEO Rank & Content",
    inspiredBy: "Public search measurement standards",
    category: "Search visibility",
    description: "Authorized rank checks, first-party search evidence, safe content audits, and cited briefs without fabricated measurements.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["site", "connector", "keyword", "rank-check", "rank-observation", "search-metric", "audit-run", "page-snapshot", "content-issue", "content-brief", "report"],
    aiCapabilities: ["cluster exact queries", "explain cited changes", "draft evidence-linked briefs"],
    scaleGuidance: "Use Scale for many sites, locale and device matrices, frequent checks, broad crawls, or long measurement history.",
    externalUsage: ["customer-selected SERP provider", "customer proxy", "Search Console", "customer CMS"],
  },
  {
    id: "finance",
    name: "Freelancer Finance & Time",
    inspiredBy: "Public bookkeeping and time-tracking patterns",
    category: "Finance operations",
    description: "Integer-minor-unit time billing, immutable invoice issuance, manual payment facts, and cited bookkeeping assistance.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["business-profile", "client", "project", "time-entry", "expense", "receipt", "invoice", "payment", "reconciliation-match", "delivery", "financial-export"],
    aiCapabilities: ["extract unapproved receipt fields", "suggest reconciliation candidates", "summarize cited unbilled work"],
    scaleGuidance: "Use Scale for larger teams, high receipt volume, many currencies, or long document retention.",
    externalUsage: ["customer payment provider", "customer email provider", "customer OCR provider", "customer object storage"],
  },
  {
    id: "notify",
    name: "Notifications",
    inspiredBy: "CloudEvents and public notification patterns",
    category: "Product notifications",
    description: "Typed immutable events, preference-aware in-product delivery, exact workflow versions, and auditable suppression without shared sender credentials.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["subscriber", "topic", "preference", "event-schema", "event", "template", "workflow", "notification-run", "delivery-attempt", "digest-bucket", "inbox-item", "provider-receipt"],
    aiCapabilities: ["draft unapproved workflow content", "explain cited delivery failures", "suggest quiet-hour policy"],
    scaleGuidance: "Use Scale for high event volume, many customer providers, large digests, or extended delivery history.",
    externalUsage: ["customer email provider", "customer SMS provider", "customer push provider", "customer chat provider"],
  },
  {
    id: "hire",
    name: "Hiring",
    inspiredBy: "Public recruiting workflow standards",
    category: "Recruiting",
    description: "Versioned jobs and applications with structured human review, immutable evidence, candidate rights, and no automated terminal decisions.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["job", "pipeline", "candidate", "application", "resume-document", "application-event", "interview-plan", "interview", "scorecard", "decision", "offer", "communication", "consent-notice", "deletion-request", "export"],
    aiCapabilities: ["extract cited resume facts", "summarize selected candidate evidence", "draft review-only recruiting content"],
    scaleGuidance: "Use Scale for many recruiters, large private resume storage, high application volume, OCR, or long retention history.",
    externalUsage: ["customer object storage", "customer calendar", "customer email provider", "customer-selected OCR or model endpoint"],
  },
  {
    id: "collab",
    name: "Collaborative Docs",
    inspiredBy: "Open document and canvas collaboration standards",
    category: "Collaboration",
    description: "Durable structured documents and canvases with validated operations, immutable revisions, controlled sharing, exports, and approval-gated AI patches.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["space", "document", "canvas", "operation", "revision", "comment-thread", "asset", "share-link", "template", "export-job", "ai-patch"],
    aiCapabilities: ["propose a version-bound patch", "summarize an exact selected revision", "draft structured blocks for review"],
    scaleGuidance: "Use Scale for many concurrent editors, large canvases or media assets, high operation volume, or extended revision history.",
    externalUsage: ["customer object storage", "customer-selected export renderer", "customer-selected model endpoint"],
  },
  {
    id: "schedule",
    name: "Scheduling",
    inspiredBy: "Public scheduling and iCalendar standards",
    category: "Scheduling",
    description: "Conflict-aware availability, immutable event releases, deterministic routing, bookings, and evidence-backed calendar reconciliation.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["host", "schedule", "schedule-revision", "event-type", "event-release", "slot-snapshot", "booking", "booking-event", "connector"],
    aiCapabilities: ["draft review-only availability", "explain cited unavailability", "suggest routing changes for review"],
    scaleGuidance: "Use Scale for many hosts, calendar connections, routing rules, public domains, webhook volume, or long booking history.",
    externalUsage: ["customer calendar provider", "customer conferencing provider", "customer email provider", "customer anti-abuse provider"],
  },
  {
    id: "forms",
    name: "Forms",
    inspiredBy: "Public JSON Schema and accessibility standards",
    category: "Data collection",
    description: "Accessible versioned forms with deterministic logic, exact-release validation, corrections, privacy classes, and bounded exports.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["form", "form-release", "submission", "submission-version", "result-view", "export", "rights-request"],
    aiCapabilities: ["draft review-only forms", "summarize aggregate results", "suggest cited form improvements"],
    scaleGuidance: "Use Scale for high submission or upload volume, many public domains and locales, frequent exports, or long retention.",
    externalUsage: ["customer object storage", "customer malware scanner", "customer email provider", "customer webhook provider"],
  },
  {
    id: "flags",
    name: "Feature Flags",
    inspiredBy: "OpenFeature and public experimentation standards",
    category: "Product delivery",
    description: "Typed local evaluation, immutable signed manifests, approval-bound revisions, exposure evidence, and quality-gated experiments.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["flag-project", "environment", "flag", "config-revision", "approval", "manifest", "evaluation-receipt", "exposure", "experiment", "analysis-run", "rollback-event"],
    aiCapabilities: ["draft review-only rollout plans", "explain exact evaluation receipts", "suggest stale flags with evidence"],
    scaleGuidance: "Use Scale for many environments, high manifest fan-out, large exposure volume, long retention, or concurrent experiments.",
    externalUsage: ["customer analytics provider", "customer data warehouse", "customer CDN"],
  },
  {
    id: "esign",
    name: "E-Signature Workflow",
    inspiredBy: "Public electronic-signature workflow standards",
    category: "Agreements",
    description: "Content-addressed agreement templates, signer workflows, explicit approvals, private completion evidence, and cited AI proposals without autonomous consent or legal-compliance claims.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["template", "template-version", "document", "envelope", "dispatch-plan", "signer-session", "field-completion", "decline-event", "void-event", "reminder-plan", "certificate", "esign-ai-request-audit", "esign-command-receipt"],
    aiCapabilities: ["propose cited clauses for review", "propose cited field placement", "propose cited signer routing"],
    scaleGuidance: "Use Scale for large document collections, many concurrent envelopes, extended evidence retention, or customer-managed object rendering.",
    externalUsage: ["customer object storage", "customer delivery provider", "customer-selected identity provider", "customer-selected model endpoint"],
  },
  {
    id: "email",
    name: "Letterline",
    inspiredBy: "Public permission-based email marketing standards",
    category: "Email marketing",
    description: "Purpose-bound audiences, immutable consent and suppression evidence, reviewed campaign versions, cited AI proposals, and provider-neutral dispatch plans.",
    minPlan: "starter",
    resourceClass: "shared",
    recordTypes: ["audience", "subscriber", "consent-receipt", "suppression", "campaign", "campaign-version", "campaign-review", "campaign-approval", "campaign-schedule", "dispatch-plan", "provider-receipt", "audience-export", "email-ai-request-audit", "email-command-receipt"],
    aiCapabilities: ["propose cited subject lines", "propose cited newsletter bodies", "flag unsupported claims for review"],
    scaleGuidance: "Use Scale for large audiences, high provider-receipt volume, frequent campaigns, long retention, or large private exports.",
    externalUsage: ["customer email provider", "customer verification gateway", "customer-selected model endpoint"],
  },
  ...additiveSuiteModules,
  ...extendedSuiteModules,
  {
    id: "projects",
    name: "Projects",
    inspiredBy: "Plane",
    category: "Product delivery",
    description: "Outcome projects, scoped issues, acyclic dependencies, capacity-safe cycle snapshots, and cited planning proposals.",
    minPlan: "scale",
    resourceClass: "high",
    recordTypes: ["project", "issue", "cycle", "premium-ai-request-audit", "premium-command-receipt"],
    aiCapabilities: ["propose cited plan", "explain project health with citations"],
  },
  {
    id: "drive",
    name: "Drive",
    inspiredBy: "Nextcloud",
    category: "Files",
    description: "Private vaults, checksum-addressed file versions, approved expiring shares, retention controls, and cited document understanding.",
    minPlan: "scale",
    resourceClass: "high",
    recordTypes: ["vault", "file", "file-version", "share", "premium-ai-request-audit", "premium-command-receipt"],
    aiCapabilities: ["understand checksum-pinned document with citations"],
  },
  {
    id: "channels",
    name: "Channels",
    inspiredBy: "Zulip",
    category: "Team communication",
    description: "Topic-first streams with preview-approved messages, redaction receipts, human decisions, cited summaries, and non-sending digests.",
    minPlan: "scale",
    resourceClass: "high",
    recordTypes: ["stream", "topic", "message", "premium-ai-request-audit", "premium-command-receipt"],
    aiCapabilities: ["summarize topic with citations", "draft non-sending digest"],
  },
  {
    id: "operations",
    name: "Operations",
    inspiredBy: "ERPNext",
    category: "Business operations",
    description: "Parties, priced items, immutable order and invoice snapshots, balanced journals, payment receipts, and cited variance explanations.",
    minPlan: "fleet",
    resourceClass: "accelerated",
    recordTypes: ["party", "item", "order", "invoice", "journal", "payment", "premium-ai-request-audit", "premium-command-receipt"],
    aiCapabilities: ["explain operational variance without posting accounting facts"],
  },
  {
    id: "assistant",
    name: "Assistant",
    inspiredBy: "LibreChat",
    category: "AI workspace",
    description: "A model-neutral workbench for attached evidence, immutable prompts, reviewed cited results, and allowlisted proposal-only agents.",
    minPlan: "fleet",
    resourceClass: "accelerated",
    recordTypes: ["collection", "source-attachment", "prompt-version", "premium-ai-request-audit", "ai-result", "agent", "premium-command-receipt"],
    aiCapabilities: ["run attached evidence-bound prompt", "review cited model result", "propose allowlisted agent actions"],
  },
];

export const suiteModuleById = new Map(suiteModules.map((module) => [module.id, module]));

export function suiteGenericCreateRecordTypes(module: SuiteModuleDefinition): string[] {
  void module;
  return [];
}

export function suiteRecordAllowsGenericMutation(moduleId: string, recordType: string) {
  const module = suiteModuleById.get(moduleId);
  return Boolean(module && suiteGenericCreateRecordTypes(module).includes(recordType));
}

const planRank: Record<SuitePlanId, number> = { none: -1, starter: 0, scale: 1, fleet: 2 };

export function suitePlanAllows(plan: string, module: SuiteModuleDefinition) {
  return (planRank[plan as SuitePlanId] ?? -1) >= planRank[module.minPlan];
}

export function suiteToolName(moduleId: string, operation: "list" | "create" | "ai") {
  return `${moduleId.replaceAll("-", "_")}_${operation}`;
}
