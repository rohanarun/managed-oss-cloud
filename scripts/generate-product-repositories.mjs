import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suiteModules } from "../src/shared/suite.ts";
import {
  suiteActionExampleInput,
  suiteActionInputJsonSchema,
  suiteActionRequiredScope,
  suiteActionsByModule,
  suiteActionToolName,
} from "../src/shared/suite-actions.ts";

const generatorDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(generatorDirectory, "..");
const defaultOutputRoot = "/Volumes/SP AI 01_16/managed-oss-product-repos";
const sourceRelease = "v0.4.2";
const sourceCommit = "20c4a704c77cbbbff1da995e1d91b937625a8aa4";
const sourceSnapshotSha256 = "d0b7b1079d4924eb7369c788a979a707d45bb63470290e6ac33ee5662d78f69f";
const generatedVersion = "0.2.0";

const products = [
  { slug: "pulseflow", command: "pulseflow", moduleId: "automate", name: "PulseFlow", tagline: "Governed automations with typed triggers, approvals, retries, and explainable AI repair.", accent: "#16d9b3", accentDark: "#087f6d" },
  { slug: "signaldeck", command: "signaldeck", moduleId: "publish", name: "SignalDeck", tagline: "Plan, approve, publish, and explain multi-channel campaigns from one evidence trail.", accent: "#6ea8ff", accentDark: "#285eb5", primaryActionId: "campaign-draft" },
  { slug: "relaydesk", command: "relaydesk", moduleId: "inbox", name: "RelayDesk", tagline: "A shared customer inbox with governed AI triage, response proposals, and SLA evidence.", accent: "#ff8c61", accentDark: "#ad4927" },
  { slug: "orbitcrm", command: "orbitcrm", moduleId: "crm", name: "OrbitCRM", tagline: "Relationship context, pipeline evidence, and AI-assisted next actions in a single workspace.", accent: "#9d84ff", accentDark: "#5b43b7" },
  { slug: "northstar-work", command: "northstar-work", moduleId: "tasks", name: "Northstar Work", tagline: "Turn outcomes into accountable projects, dependencies, sprints, and cited delivery insights.", accent: "#3fc8f4", accentDark: "#16708b" },
  { slug: "idealoop", command: "idealoop", moduleId: "feedback", name: "IdeaLoop", tagline: "Connect customer feedback to deduplication evidence, decisions, roadmaps, and releases.", accent: "#f2bf43", accentDark: "#8c6810" },
  { slug: "atlasbase", command: "atlasbase", moduleId: "knowledge", name: "AtlasBase", tagline: "Structured knowledge with revision provenance, permissions, and citation-grounded answers.", accent: "#70d67b", accentDark: "#277732" },
  { slug: "routekit", command: "routekit", moduleId: "links", name: "RouteKit", tagline: "Versioned branded routes, controlled destinations, privacy-aware events, and safe experiments.", accent: "#ff719a", accentDark: "#9b2f51" },
  { slug: "fairlaunch", command: "fairlaunch", moduleId: "giveaways", name: "FairLaunch", tagline: "Consent-aware referral contests with frozen eligibility evidence and auditable winner draws.", accent: "#f5a742", accentDark: "#9b5b0d" },
  { slug: "proofport", command: "proofport", moduleId: "testimonials", name: "ProofPort", tagline: "Collect, moderate, publish, revoke, and measure customer proof with explicit consent.", accent: "#20c9c3", accentDark: "#087975" },
  { slug: "beaconpage", command: "beaconpage", moduleId: "brand-pages", name: "BeaconPage", tagline: "Branded landing pages, QR routes, versioned destinations, and privacy-safe conversion signals.", accent: "#ffcc66", accentDark: "#8a651a" },
  { slug: "northstar-planning", command: "northstar-planning", moduleId: "projects", name: "Northstar Planning", tagline: "Outcome-led planning, issue dependencies, committed cycles, and evidence-backed health analysis.", accent: "#62a0ff", accentDark: "#2a5fae" },
  { slug: "harbor-vault", command: "harbor-vault", moduleId: "drive", name: "Harbor Vault", tagline: "Versioned file governance, deliberate sharing, retention controls, and cited document understanding.", accent: "#54d6a3", accentDark: "#1d7a58" },
  { slug: "threadline", command: "threadline", moduleId: "channels", name: "Threadline", tagline: "Topic-first team communication with preview gates, redaction evidence, summaries, and digests.", accent: "#c28bff", accentDark: "#7345a8" },
  { slug: "ledgerline-operations", command: "ledgerline-operations", moduleId: "operations", name: "Ledgerline Operations", tagline: "Orders, invoices, journal previews, payments, and explainable operating variance in one ledger.", accent: "#fb8c75", accentDark: "#9e4230" },
  { slug: "evident-ai-workbench", command: "evident-ai-workbench", moduleId: "assistant", name: "Evident AI Workbench", tagline: "Versioned prompts, source-bound runs, governed agents, and durable AI result evidence.", accent: "#73d2ff", accentDark: "#246e91" },
  { slug: "consentledger", command: "consentledger", moduleId: "consent", name: "ConsentLedger", tagline: "Versioned privacy policies, cryptographic receipts, bounded scans, and cited consent explanations.", accent: "#5ee0b7", accentDark: "#197458" },
  { slug: "searchproof", command: "searchproof", moduleId: "seo", name: "SearchProof", tagline: "Authorized rank evidence, safe site audits, and citation-grounded content briefs without invented metrics.", accent: "#6cb6ff", accentDark: "#285f9f" },
  { slug: "workledger", command: "workledger", moduleId: "finance", name: "WorkLedger", tagline: "Time entries, integer-money invoices, payment facts, and cited reconciliation proposals for independent businesses.", accent: "#71d586", accentDark: "#2c7740" },
  { slug: "signalmesh", command: "signalmesh", moduleId: "notify", name: "SignalMesh", tagline: "Typed product events, preference-aware delivery, exact workflows, and explainable suppression evidence.", accent: "#ff9a68", accentDark: "#a94f29" },
  { slug: "talentledger", command: "talentledger", moduleId: "hire", name: "TalentLedger", tagline: "Versioned jobs, structured applications, candidate rights, and review-only AI summaries without automated hiring decisions.", accent: "#b493ff", accentDark: "#6543a8", primaryActionId: "job-draft" },
  { slug: "canvasforge", command: "canvasforge", moduleId: "collab", name: "CanvasForge", tagline: "Structured collaborative documents with immutable revisions, controlled sharing, and approval-gated AI patches.", accent: "#55d4e8", accentDark: "#177789" },
  { slug: "slotline", command: "slotline", moduleId: "schedule", name: "Slotline", tagline: "Conflict-aware availability, deterministic routing, bookings, and cited calendar reconciliation.", accent: "#ffc75c", accentDark: "#8d6715" },
  { slug: "intakeforge", command: "intakeforge", moduleId: "forms", name: "IntakeForge", tagline: "Accessible versioned forms with deterministic logic, privacy controls, corrections, and grounded summaries.", accent: "#ef84b4", accentDark: "#98436b" },
  { slug: "releaseguard", command: "releaseguard", moduleId: "flags", name: "ReleaseGuard", tagline: "Typed feature flags, signed manifests, approval-gated rollouts, and quality-evidenced experiments.", accent: "#8da3ff", accentDark: "#4a5daf" },
  { slug: "accordseal", command: "accordseal", moduleId: "esign", name: "AccordSeal", tagline: "Content-addressed agreements, signer workflows, approvals, private completion evidence, and cited clause proposals.", accent: "#f0ae6f", accentDark: "#945822" },
  { slug: "letterline", command: "letterline", moduleId: "email", name: "Letterline", tagline: "Purpose-bound audiences, consent evidence, reviewed campaigns, and provider-neutral dispatch plans.", accent: "#70cfef", accentDark: "#26728a" },
  { slug: "schemadeck", command: "schemadeck", moduleId: "tables", name: "SchemaDeck", tagline: "Governed schemas, typed rows, deterministic views, and cited proposals in one shared data fabric.", accent: "#62d6ba", accentDark: "#1c7863" },
  { slug: "recall-room", command: "recall-room", moduleId: "meetings", name: "Recall Room", tagline: "Privacy-aware meeting evidence, decisions, owners, commitments, and reviewed follow-up proposals.", accent: "#aa96ff", accentDark: "#5f4aaf" },
  { slug: "proofline-insights", command: "proofline-insights", moduleId: "insights", name: "Proofline Insights", tagline: "Metrics, observations, dashboards, and immutable reporting clocks with cited explanations.", accent: "#62b8ff", accentDark: "#28649c" },
  { slug: "learning-forge", command: "learning-forge", moduleId: "learning", name: "Learning Forge", tagline: "Evidence-bound lessons, attempts, rubrics, reviewed feedback, and durable credentials.", accent: "#f4bf57", accentDark: "#8f6714" },
  { slug: "circlefield", command: "circlefield", moduleId: "community", name: "Circlefield", tagline: "Portable community context, memberships, moderation receipts, and reviewed announcements.", accent: "#eb82b6", accentDark: "#963f6a" },
  { slug: "gatherledger", command: "gatherledger", moduleId: "events", name: "GatherLedger", tagline: "Auditable event releases, ticket inventory, money receipts, access records, and attendee proposals.", accent: "#ff916c", accentDark: "#a8492e" },
  { slug: "peopleweave", command: "peopleweave", moduleId: "people", name: "PeopleWeave", tagline: "Policies, onboarding, leave, attendance, reviews, and offboarding without automated employment decisions.", accent: "#8ddc8b", accentDark: "#387a38" },
  { slug: "meterproof", command: "meterproof", moduleId: "metering", name: "MeterProof", tagline: "Reproducible usage events, aggregates, charge previews, credits, invoices, and payment evidence.", accent: "#6ec7e8", accentDark: "#2b748e" },
  { slug: "assuregraph", command: "assuregraph", moduleId: "assurance", name: "AssureGraph", tagline: "Risks, controls, evidence, tests, remediations, exceptions, and audit packs bound to exact owners and clocks.", accent: "#f19d72", accentDark: "#964d2b" },
  { slug: "liveforum", command: "liveforum", moduleId: "live", name: "LiveForum", tagline: "Consent-pinned live sessions, access grants, attributed chat, moderation receipts, and reviewed replay proposals.", accent: "#d38cff", accentDark: "#7c44a0" },
];

function flag(name) {
  return process.argv.includes(name);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function render(template, values) {
  return Object.entries(values).reduce(
    (value, [key, replacement]) => value.replaceAll("__" + key + "__", replacement),
    template,
  );
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requiredStringSample(name, schema) {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
  if (schema.format === "date-time") return "2026-09-01T12:00:00.000Z";
  if (schema.format === "email") return "operator@example.com";
  if (schema.format === "uri") return "https://example.com/resource";
  const pattern = schema.pattern;
  if (pattern === "^[a-f0-9]{64}$") return "a".repeat(64);
  if (pattern === "^[A-Z]{3}$") return "USD";
  if (pattern === "^https://") return "https://example.com";
  if (pattern === "^\\d{4}-\\d{2}-\\d{2}$") return "2026-09-01";
  if (pattern === "^\\d{4}-\\d{2}$") return "2026-09";
  if (pattern === "^#[0-9A-Fa-f]{6}$") return "#16d9b3";
  if (name.toLowerCase().includes("idempotency")) return "generated.sample-key-0001";
  if (name.toLowerCase().endsWith("hash") || name.toLowerCase().includes("checksum")) return "a".repeat(64);
  if (name.toLowerCase().includes("hostname") || name === "domain") return "example.com";
  if (name.toLowerCase().includes("locale")) return "en-US";
  if (name.toLowerCase().includes("currency")) return "USD";
  if (pattern?.includes("[a-z]")) return "sample-key";
  if (pattern?.includes("A-Za-z0-9")) return "sample-key-0001";
  return "Sample " + name.replaceAll(/([A-Z])/g, " $1").toLowerCase();
}

function sampleForSchema(schema, name = "value") {
  if (schema?.const !== undefined) return schema.const;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema?.anyOf) && schema.anyOf.length > 0) {
    const branch = schema.anyOf.find((candidate) => candidate.type !== "null") ?? schema.anyOf[0];
    return sampleForSchema(branch, name);
  }
  switch (schema?.type) {
    case "object":
      return Object.fromEntries((schema.required ?? []).map((key) => [key, sampleForSchema(schema.properties?.[key] ?? {}, key)]));
    case "array": {
      const count = Math.max(1, schema.minItems ?? 0);
      return Array.from({ length: count }, () => sampleForSchema(schema.items ?? { type: "object" }, name));
    }
    case "boolean": return false;
    case "integer": return Math.max(0, schema.minimum ?? 0);
    case "null": return null;
    case "string": return requiredStringSample(name, schema);
    default: return {};
  }
}

function materializeExampleInput(value, schema, name = "value") {
  if (typeof value === "string" && /^<[^<>]+>$/.test(value)) return sampleForSchema(schema, name);
  if (Array.isArray(value)) return value.map((item) => materializeExampleInput(item, schema?.items ?? {}, name));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      materializeExampleInput(item, schema?.properties?.[key] ?? {}, key),
    ]));
  }
  return value;
}

function humanizeIdentifier(value) {
  return String(value ?? "")
    .replaceAll(/[-_]+/g, " ")
    .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function actionExperienceGroup(action) {
  const haystack = [action.id, action.title, action.description].join(" ").toLowerCase();
  if (action.requiredScope === "ai" || action.operation === "ai") return "AI assistance";
  if (action.operation === "create" || /^(create|open|start|upsert|register|draft|record|submit|enroll|issue)\b/.test(action.title.toLowerCase())) return "Create and capture";
  if (/approve|review|publish|final|release|moderate|sign|verify|audit|test|draw|decide/.test(haystack)) return "Review and approve";
  if (/create|open|start|upsert|register|draft|record|submit|enroll|issue/.test(haystack)) return "Create and capture";
  if (action.operation === "read" || /list|read|export|report|status|preview|inspect|reconcile/.test(haystack)) return "Inspect and report";
  return "Operate and update";
}

function productExperience(product, module, actions) {
  const recordTypes = [...new Set([
    ...(module.recordTypes ?? []),
    ...actions.map((action) => action.recordType).filter(Boolean),
  ])];
  const nonAiActions = actions.filter((action) => action.requiredScope !== "ai" && action.operation !== "ai");
  const primaryAction = actions.find((action) => action.id === product.primaryActionId) ?? nonAiActions[0] ?? actions[0];
  const sampleStates = ["active", "in review", "ready", "scheduled", "draft", "complete"];
  const sampleSuffixes = ["Launch", "Operations", "Evidence", "Review", "Pilot", "Archive"];
  const sampleRecords = recordTypes.slice(0, 8).map((recordType, index) => ({
    id: "demo-" + module.id + "-" + String(index + 1).padStart(2, "0"),
    moduleId: module.id,
    recordType,
    title: humanizeIdentifier(recordType) + " " + sampleSuffixes[index % sampleSuffixes.length],
    state: sampleStates[index % sampleStates.length],
    createdAt: new Date(Date.UTC(2026, 7, 18 + index, 13, 30)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 25, 13 - index, 15)).toISOString(),
    data: {
      owner: index % 2 === 0 ? "Operations" : "Product",
      evidenceStatus: index % 3 === 0 ? "verified" : "current",
      nextStep: actions[index % actions.length]?.title ?? "Review record",
    },
  }));
  return {
    releaseBoundary: "Complete for every typed action declared by this product manifest; it does not claim feature parity with unrelated third-party products.",
    headline: product.tagline.split(",")[0].replace(/[.]$/, ""),
    primaryActionId: primaryAction.id,
    quickActionIds: nonAiActions.slice(0, 4).map((action) => action.id),
    navigation: ["Overview", "Records", "Workflows", "AI assistance", "Settings"],
    workflowGroups: ["Create and capture", "Operate and update", "Review and approve", "Inspect and report", "AI assistance"].map((name) => ({
      name,
      actionIds: actions.filter((action) => actionExperienceGroup(action) === name).map((action) => action.id),
    })).filter((group) => group.actionIds.length > 0),
    metrics: [
      { label: "Typed actions", value: actions.length },
      { label: "Record types", value: recordTypes.length },
      { label: "AI workflows", value: actions.filter((action) => action.requiredScope === "ai").length },
      { label: "Review gates", value: actions.filter((action) => actionExperienceGroup(action) === "Review and approve").length },
    ],
    sampleRecords,
  };
}

function productManifest(product, module, actions) {
  const mcpPrefix = product.slug.replaceAll("-", "_");
  const recordTypes = [...new Set([
    ...(module.recordTypes ?? []),
    ...actions.map((action) => action.recordType).filter(Boolean),
  ])];
  return {
    schemaVersion: 1,
    release: {
      productVersion: generatedVersion,
      backendRelease: sourceRelease,
      backendCommit: sourceCommit,
      backendSourceSnapshotSha256: sourceSnapshotSha256,
      generatedAt: "2026-08-24T00:00:00.000Z",
      generator: "managed-oss-cloud/scripts/generate-product-repositories.mjs",
    },
    product: {
      slug: product.slug,
      command: product.command,
      mcpPrefix,
      environmentPrefix: product.command.replaceAll("-", "_").toUpperCase(),
      name: product.name,
      tagline: product.tagline,
      repository: "https://github.com/rohanarun/" + product.slug,
      license: "MIT",
      accent: product.accent,
      accentDark: product.accentDark,
    },
    module: {
      id: module.id,
      category: module.category,
      description: module.description,
      minimumHostedPlan: module.minPlan,
      resourceClass: module.resourceClass,
      resourceRequirements: module.resourceRequirements,
      recordTypes,
      aiCapabilities: module.aiCapabilities,
      scaleGuidance: module.scaleGuidance,
      externalUsage: module.externalUsage,
    },
    backend: {
      defaultUrl: "https://cloud.getsupers.com",
      workspaceEndpoint: "/api/suite/workspace",
      actionEndpointPattern: "/api/suite/modules/" + module.id + "/actions/{actionId}",
      authentication: "Bearer API token",
      databaseBoundary: "All shared database access and tenant isolation remain behind the managed-oss-cloud API.",
    },
    cleanRoom: {
      statement: "Original clean-room implementation of the " + module.category.toLowerCase() + " software category, designed and written independently.",
      sourceBoundary: "Public category behavior informed requirements; implementation and product identity are original.",
    },
    experience: productExperience(product, module, actions),
    actions: actions.map((action) => {
      const inputSchema = suiteActionInputJsonSchema(action);
      const exampleInput = materializeExampleInput(
        action.exampleInput ?? suiteActionExampleInput(action) ?? sampleForSchema(inputSchema),
        inputSchema,
      );
      return {
        ...action,
        inputSchema,
        requiredScope: suiteActionRequiredScope(action),
        backendMcpToolName: suiteActionToolName(action),
        productMcpToolName: mcpPrefix + "_" + action.id.replaceAll("-", "_"),
        productCliExample: product.command + " action " + action.id + " '" + JSON.stringify(exampleInput) + "'",
        exampleInput,
      };
    }),
  };
}

const manifestSource = String.raw`import { readFileSync } from "node:fs";

const manifestUrl = new URL("../product-manifest.json", import.meta.url);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const manifest = deepFreeze(JSON.parse(readFileSync(manifestUrl, "utf8")));
export const product = manifest.product;
export const moduleDefinition = manifest.module;
export const actions = manifest.actions;
export const actionById = new Map(actions.map((action) => [action.id, action]));
export const actionByToolName = new Map(actions.map((action) => [action.productMcpToolName, action]));
`;

const validationSource = String.raw`export class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputValidationError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(path, message) {
  throw new InputValidationError(path + " " + message);
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
}

function formatIsValid(format, value) {
  if (typeof format !== "string") return true;
  if (format === "uuid") return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (format === "date-time") return !Number.isNaN(Date.parse(value)) && /T/.test(value);
  if (format === "email") return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
  if (format === "uri") {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }
  return true;
}

export function validateInput(schema, value, path = "input") {
  if (!schema || typeof schema !== "object") return value;
  if (Array.isArray(schema.anyOf)) {
    const errors = [];
    for (const branch of schema.anyOf) {
      try {
        return validateInput(branch, value, path);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    fail(path, "does not match any permitted shape: " + errors.join("; "));
  }
  if (schema.const !== undefined && value !== schema.const) fail(path, "must equal " + JSON.stringify(schema.const) + ".");
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) fail(path, "must be one of " + schema.enum.map(JSON.stringify).join(", ") + ".");

  switch (schema.type) {
    case "null":
      if (value !== null) fail(path, "must be null.");
      break;
    case "object": {
      if (!isPlainObject(value)) fail(path, "must be an object.");
      const keys = Object.keys(value);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(path, "must contain at least " + schema.minProperties + " propert" + (schema.minProperties === 1 ? "y." : "ies."));
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(path, "must contain at most " + schema.maxProperties + " propert" + (schema.maxProperties === 1 ? "y." : "ies."));
      for (const key of schema.required ?? []) {
        if (!(key in value)) fail(path + "." + key, "is required.");
      }
      const declared = new Set(Object.keys(schema.properties ?? {}));
      for (const key of keys) {
        if (schema.propertyNames) validateInput({ ...schema.propertyNames, type: "string" }, key, path + " property " + JSON.stringify(key));
        if (declared.has(key)) continue;
        if (schema.additionalProperties === false) fail(path + "." + key, "is not permitted.");
        if (isPlainObject(schema.additionalProperties)) validateInput(schema.additionalProperties, value[key], path + "." + key);
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (key in value) validateInput(child, value[key], path + "." + key);
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) fail(path, "must be an array.");
      if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, "must contain at least " + schema.minItems + " item(s).");
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, "must contain at most " + schema.maxItems + " item(s).");
      if (schema.uniqueItems === true) {
        for (let index = 0; index < value.length; index += 1) {
          if (value.slice(0, index).some((item) => sameJsonValue(item, value[index]))) fail(path + "[" + index + "]", "duplicates an earlier item but items must be unique.");
        }
      }
      if (schema.items) value.forEach((item, index) => validateInput(schema.items, item, path + "[" + index + "]"));
      break;
    case "string":
      if (typeof value !== "string") fail(path, "must be a string.");
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, "must contain at least " + schema.minLength + " character(s).");
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, "must contain at most " + schema.maxLength + " character(s).");
      if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern)).test(value)) fail(path, "does not match the required pattern.");
      if (!formatIsValid(schema.format, value)) fail(path, "must use the " + schema.format + " format.");
      break;
    case "integer":
      if (!Number.isInteger(value)) fail(path, "must be an integer.");
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, "must be at least " + schema.minimum + ".");
      if (schema.maximum !== undefined && value > schema.maximum) fail(path, "must be at most " + schema.maximum + ".");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number.");
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, "must be at least " + schema.minimum + ".");
      if (schema.maximum !== undefined && value > schema.maximum) fail(path, "must be at most " + schema.maximum + ".");
      break;
    case "boolean":
      if (typeof value !== "boolean") fail(path, "must be a boolean.");
      break;
    default:
      break;
  }
  return value;
}
`;

const clientSource = String.raw`import { actionById, manifest } from "./manifest.mjs";
import { validateInput } from "./validation.mjs";

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The API URL must be an absolute HTTP or HTTPS URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The API URL must use HTTP or HTTPS.");
  return url.href.endsWith("/") ? url.href : url.href + "/";
}

export class ProductClient {
  constructor(options) {
    if (!options?.token || typeof options.token !== "string") throw new Error("A scoped workspace API token is required.");
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? manifest.backend.defaultUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", "Bearer " + this.token);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.fetchImpl(new URL(path.replace(/^\//, ""), this.baseUrl), { ...init, headers });
    const text = await response.text();
    let body = {};
    if (text) {
      try { body = JSON.parse(text); } catch { body = { error: "The API returned a non-JSON response." }; }
    }
    if (!response.ok) {
      const message = body && typeof body === "object" && typeof body.error === "string" ? body.error : "Request failed with HTTP " + response.status + ".";
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  workspace() {
    return this.request("/api/suite/workspace");
  }

  enable() {
    return this.request("/api/suite/modules/" + manifest.module.id + "/enable", { method: "POST" });
  }

  listRecords(options = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Record limit must be an integer from 1 to 200.");
    if (options.recordType && !manifest.module.recordTypes.includes(options.recordType)) throw new Error("Unknown record type for " + manifest.product.name + ".");
    const query = new URLSearchParams({ moduleId: manifest.module.id, limit: String(limit) });
    if (options.recordType) query.set("recordType", options.recordType);
    return this.request("/api/suite/records?" + query.toString());
  }

  aiStatus(actionId) {
    if (!/^[0-9a-f-]{36}$/i.test(actionId ?? "")) throw new Error("AI action ID must be a UUID.");
    return this.request("/api/suite/ai-actions/" + encodeURIComponent(actionId));
  }

  runAction(actionId, input) {
    const action = actionById.get(actionId);
    if (!action) throw new Error("Unknown " + manifest.product.name + " action: " + actionId + ".");
    validateInput(action.inputSchema, input);
    return this.request("/api/suite/modules/" + manifest.module.id + "/actions/" + encodeURIComponent(action.id), {
      method: "POST",
      body: JSON.stringify({ input }),
    });
  }
}

export function environmentConfig(env = process.env) {
  const prefix = manifest.product.environmentPrefix;
  const token = env[prefix + "_TOKEN"] ?? env.SUPERSUITE_TOKEN;
  const baseUrl = env[prefix + "_URL"] ?? env.SUPERSUITE_URL ?? manifest.backend.defaultUrl;
  if (!token) throw new Error("Set " + prefix + "_TOKEN or SUPERSUITE_TOKEN to a scoped token created in the workspace dashboard.");
  return { token, baseUrl };
}

export function clientFromEnvironment(env = process.env, fetchImpl = fetch) {
  return new ProductClient({ ...environmentConfig(env), fetchImpl });
}
`;

const demoClientSource = String.raw`import { randomUUID } from "node:crypto";
import { actionById, manifest } from "./manifest.mjs";
import { validateInput } from "./validation.mjs";

function clone(value) {
  return structuredClone(value);
}

function titleForAction(action, input) {
  const preferredKeys = [action.titleField, "name", "title", "subject", "label", "slug", "externalKey"].filter(Boolean);
  for (const key of preferredKeys) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return action.title;
}

export class DemoProductClient {
  constructor() {
    this.records = clone(manifest.experience.sampleRecords ?? []);
    this.aiActions = new Map();
    this.enabled = true;
  }

  async workspace() {
    return {
      workspace: {
        id: "demo-workspace",
        slug: "sample-workspace",
        name: "Sample workspace",
        plan: manifest.module.minimumHostedPlan,
        enabledModuleIds: this.enabled ? [manifest.module.id] : [],
      },
      usage: {
        recordCount: this.records.length,
        aiActionsThisMonth: this.aiActions.size,
        storageBytes: 0,
      },
      demo: true,
    };
  }

  async enable() {
    this.enabled = true;
    return { enabled: true, moduleId: manifest.module.id, demo: true };
  }

  async listRecords(options = {}) {
    const records = this.records
      .filter((record) => !options.recordType || record.recordType === options.recordType)
      .slice(0, options.limit ?? 50);
    return { records: clone(records), demo: true };
  }

  async aiStatus(actionId) {
    const action = this.aiActions.get(actionId);
    if (!action) {
      const error = new Error("Demo AI action not found.");
      error.status = 404;
      throw error;
    }
    return { action: clone(action), demo: true };
  }

  async runAction(actionId, input) {
    const action = actionById.get(actionId);
    if (!action) throw new Error("Unknown " + manifest.product.name + " action: " + actionId + ".");
    validateInput(action.inputSchema, input);
    const now = new Date().toISOString();
    if (action.requiredScope === "ai" || action.operation === "ai") {
      const aiAction = {
        id: randomUUID(),
        moduleId: manifest.module.id,
        actionId: action.id,
        status: "completed",
        goal: action.title,
        result: { proposal: "Sample evidence-bound proposal", evidenceRecordIds: this.records.slice(0, 2).map((record) => record.id) },
        createdAt: now,
        completedAt: now,
      };
      this.aiActions.set(aiAction.id, aiAction);
      return { kind: "ai-action", action, aiAction: clone(aiAction), records: clone(this.records.slice(0, 2)), demo: true };
    }

    const referenced = Object.values(input).filter((value) => typeof value === "string").find((value) => this.records.some((record) => record.id === value));
    const recordType = action.recordType || manifest.module.recordTypes[0] || "record";
    let record = referenced ? this.records.find((candidate) => candidate.id === referenced) : undefined;
    if (action.operation === "create" || !record) {
      record = {
        id: randomUUID(),
        moduleId: manifest.module.id,
        recordType,
        title: titleForAction(action, input),
        state: action.resultingState || "active",
        data: { ...clone(input), lastActionId: action.id, evidenceStatus: "sample" },
        createdAt: now,
        updatedAt: now,
      };
      this.records.unshift(record);
    } else {
      record = { ...record, state: action.resultingState || record.state, data: { ...record.data, ...clone(input), lastActionId: action.id }, updatedAt: now };
      this.records = this.records.map((candidate) => candidate.id === record.id ? record : candidate);
    }
    return {
      kind: action.operation === "read" ? "read" : action.operation === "create" ? "record" : "command",
      action,
      record: action.operation === "create" ? clone(record) : undefined,
      records: action.operation === "create" ? undefined : [clone(record)],
      audit: { demo: true, executedAt: now, actionId: action.id },
      demo: true,
    };
  }
}
`;

const cliSource = String.raw`#!/usr/bin/env node
import { actionById, actions, manifest } from "./manifest.mjs";
import { clientFromEnvironment } from "./client.mjs";

function usage() {
  const command = manifest.product.command;
  const prefix = manifest.product.environmentPrefix;
  return manifest.product.name + " CLI\n\n" +
    "Usage:\n" +
    "  " + command + " version\n" +
    "  " + command + " manifest\n" +
    "  " + command + " actions\n" +
    "  " + command + " action-help <action>\n" +
    "  " + command + " workspace\n" +
    "  " + command + " enable\n" +
    "  " + command + " list [record-type] [limit]\n" +
    "  " + command + " ai-status <action-id>\n" +
    "  " + command + " action <action> <json-input>\n\n" +
    "Environment:\n" +
    "  " + prefix + "_TOKEN or SUPERSUITE_TOKEN  Scoped workspace API token\n" +
    "  " + prefix + "_URL or SUPERSUITE_URL      API origin";
}

function output(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function parseObject(value) {
  if (!value) throw new Error("json-input is required.");
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("json-input must be valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("json-input must be a JSON object.");
  return parsed;
}

async function run(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return process.stdout.write(usage() + "\n");
  if (command === "version" || command === "--version" || command === "-v") return process.stdout.write(manifest.release.productVersion + "\n");
  if (command === "manifest") return output(manifest);
  if (command === "actions") return output(actions);
  if (command === "action-help") {
    const action = actionById.get(args[0]);
    if (!action) throw new Error("Choose an action: " + actions.map((item) => item.id).join(", ") + ".");
    return output(action);
  }

  const client = clientFromEnvironment();
  if (command === "workspace") return output(await client.workspace());
  if (command === "enable") return output(await client.enable());
  if (command === "list") return output(await client.listRecords({ recordType: args[0], limit: args[1] ? Number(args[1]) : 50 }));
  if (command === "ai-status") return output(await client.aiStatus(args[0]));
  if (command === "action") {
    if (!args[0]) throw new Error("Choose an action: " + actions.map((item) => item.id).join(", ") + ".");
    return output(await client.runAction(args[0], parseObject(args[1])));
  }
  throw new Error("Unknown command: " + command + ".\n\n" + usage());
}

run().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
`;

const mcpSource = String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { actionByToolName, actions, manifest } from "./manifest.mjs";
import { clientFromEnvironment } from "./client.mjs";
import { validateInput } from "./validation.mjs";

const prefix = manifest.product.mcpPrefix;
const builtInNames = {
  workspace: prefix + "_workspace",
  enable: prefix + "_enable",
  list: prefix + "_list_records",
  aiStatus: prefix + "_ai_status",
};

function toolAnnotations(action) {
  return {
    readOnlyHint: action.operation === "read",
    destructiveHint: action.destructive === true,
    idempotentHint: action.idempotent === true,
    openWorldHint: false,
  };
}

export function productTools() {
  return [
    {
      name: builtInNames.workspace,
      title: "Read " + manifest.product.name + " workspace",
      description: "Read the authenticated workspace and enabled modules. Requires read scope.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: builtInNames.enable,
      title: "Enable " + manifest.product.name,
      description: "Enable this product module after the hosted plan gate succeeds. Requires write scope.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: builtInNames.list,
      title: "List " + manifest.product.name + " records",
      description: "List records owned by this product module. Requires read scope.",
      inputSchema: {
        type: "object",
        properties: {
          recordType: { type: "string", enum: manifest.module.recordTypes },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: builtInNames.aiStatus,
      title: "Read " + manifest.product.name + " AI action status",
      description: "Read a queued, running, completed, or failed AI action. Requires read scope.",
      inputSchema: {
        type: "object",
        required: ["actionId"],
        properties: { actionId: { type: "string", format: "uuid" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ...actions.map((action) => ({
      name: action.productMcpToolName,
      title: action.title,
      description: action.description + " Requires " + action.requiredScope + " scope.",
      inputSchema: action.inputSchema,
      annotations: toolAnnotations(action),
    })),
  ];
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export async function callProductTool(name, args, client) {
  if (name === builtInNames.workspace) return result(await client.workspace());
  if (name === builtInNames.enable) return result(await client.enable());
  if (name === builtInNames.list) return result(await client.listRecords(args ?? {}));
  if (name === builtInNames.aiStatus) {
    validateInput(productTools().find((tool) => tool.name === builtInNames.aiStatus).inputSchema, args ?? {});
    return result(await client.aiStatus(args.actionId));
  }
  const action = actionByToolName.get(name);
  if (!action) throw new Error("Unknown " + manifest.product.name + " tool: " + name + ".");
  return result(await client.runAction(action.id, args ?? {}));
}

function response(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function protocolError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcpMessage(message, client) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return protocolError(message?.id, -32600, "Invalid Request");
  if (message.id === undefined) return undefined;
  if (message.method === "initialize") {
    return response(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: manifest.product.slug, version: manifest.release.productVersion },
      instructions: manifest.product.tagline,
    });
  }
  if (message.method === "ping") return response(message.id, {});
  if (message.method === "tools/list") return response(message.id, { tools: productTools() });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string") return protocolError(message.id, -32602, "Tool name is required.");
    try {
      return response(message.id, await callProductTool(name, message.params?.arguments ?? {}, client));
    } catch (error) {
      return response(message.id, errorResult(error));
    }
  }
  return protocolError(message.id, -32601, "Method not found: " + message.method);
}

export async function runStdio() {
  const client = clientFromEnvironment();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify(protocolError(null, -32700, "Parse error")) + "\n");
      continue;
    }
    const reply = await handleMcpMessage(message, client);
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdio().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
`;

const webServerSource = String.raw`#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientFromEnvironment } from "./client.mjs";
import { DemoProductClient } from "./demo-client.mjs";
import { manifest } from "./manifest.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const webRoot = join(directory, "..", "web");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

function secureEqual(left, right) {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right ?? "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error("Request body exceeds 1 MiB.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object.");
  return parsed;
}

export function webKeyFromEnvironment(env = process.env) {
  const key = env[manifest.product.environmentPrefix + "_WEB_KEY"] ?? env.PRODUCT_WEB_KEY;
  if (!key || key.length < 24) throw new Error("Set " + manifest.product.environmentPrefix + "_WEB_KEY or PRODUCT_WEB_KEY to at least 24 characters.");
  return key;
}

export function createProductWebServer({ client, webKey }) {
  if (!client) throw new Error("A product client is required.");
  if (!webKey || webKey.length < 24) throw new Error("The product web key must contain at least 24 characters.");
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/health") return jsonResponse(response, 200, { ok: true, product: manifest.product.slug, version: manifest.release.productVersion });
      if (url.pathname === "/manifest") return jsonResponse(response, 200, manifest);

      const staticEntry = staticFiles.get(url.pathname);
      if (staticEntry && request.method === "GET") {
        const [file, contentType] = staticEntry;
        const content = await readFile(join(webRoot, file));
        response.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        return response.end(content);
      }

      if (!url.pathname.startsWith("/product-api/")) return jsonResponse(response, 404, { error: "Not found." });
      if (!secureEqual(request.headers["x-product-web-key"], webKey)) return jsonResponse(response, 401, { error: "A valid product web key is required." });

      let result;
      if (request.method === "GET" && url.pathname === "/product-api/workspace") result = await client.workspace();
      else if (request.method === "POST" && url.pathname === "/product-api/enable") result = await client.enable();
      else if (request.method === "GET" && url.pathname === "/product-api/records") result = await client.listRecords({ recordType: url.searchParams.get("recordType") || undefined, limit: Number(url.searchParams.get("limit") ?? 50) });
      else if (request.method === "GET" && url.pathname.startsWith("/product-api/ai-actions/")) result = await client.aiStatus(decodeURIComponent(url.pathname.slice("/product-api/ai-actions/".length)));
      else if (request.method === "POST" && url.pathname.startsWith("/product-api/actions/")) {
        const actionId = decodeURIComponent(url.pathname.slice("/product-api/actions/".length));
        const body = await requestBody(request);
        result = await client.runAction(actionId, body.input);
      } else return jsonResponse(response, 404, { error: "Not found." });
      return jsonResponse(response, 200, result);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : error?.name === "InputValidationError" ? 400 : 502;
      return jsonResponse(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function startWebServer(env = process.env) {
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  const demoMode = env.PRODUCT_DEMO_MODE === "true";
  const server = createProductWebServer({ client: demoMode ? new DemoProductClient() : clientFromEnvironment(env), webKey: webKeyFromEnvironment(env) });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(manifest.product.name + " web UI listening on http://" + host + ":" + port + (demoMode ? " in sample workspace mode" : "") + "\n");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWebServer().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
`;

const demoServerSource = String.raw`#!/usr/bin/env node
import { startWebServer } from "./web-server.mjs";

const env = {
  ...process.env,
  PRODUCT_DEMO_MODE: "true",
  PRODUCT_WEB_KEY: process.env.PRODUCT_WEB_KEY ?? "sample-workspace-key-2026",
};

startWebServer(env).catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
`;

const webAppSource = String.raw`const state = {
  manifest: null,
  webKey: sessionStorage.getItem("product-web-key") ?? "",
  workspace: null,
  records: [],
  activities: [],
  connected: false,
  demo: false,
  activeView: "overview",
  selectedAction: null,
  recordQuery: "",
  recordType: "all",
};

const byId = (id) => document.getElementById(id);
const queryAll = (selector, root = document) => [...root.querySelectorAll(selector)];

function humanize(value) {
  return String(value ?? "").replaceAll(/[-_]+/g, " ").replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date) : "Not dated";
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function clear(element) {
  element.replaceChildren();
  return element;
}

function toast(message, kind = "neutral") {
  const item = make("div", "toast", message);
  item.dataset.kind = kind;
  byId("toast-root").append(item);
  requestAnimationFrame(() => item.dataset.visible = "true");
  setTimeout(() => {
    item.dataset.visible = "false";
    setTimeout(() => item.remove(), 220);
  }, 4200);
}

function setBusy(isBusy, label = "Working") {
  document.body.dataset.busy = String(isBusy);
  byId("busy-label").textContent = label;
}

async function api(path, options = {}, authenticated = true) {
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (authenticated) headers.set("X-Product-Web-Key", state.webKey);
  const response = await fetch(path, { ...options, headers });
  let body;
  try { body = await response.json(); } catch { body = { error: "The server returned a non-JSON response." }; }
  if (!response.ok) throw new Error(body.error ?? "Request failed with HTTP " + response.status + ".");
  return body;
}

function workspaceValue() {
  return state.workspace?.workspace ?? state.workspace ?? {};
}

function setConnection(connected) {
  state.connected = connected;
  const status = byId("connection-state");
  status.textContent = connected ? state.demo ? "Sample workspace" : "Connected" : "Connect";
  status.dataset.connected = String(connected);
  byId("connect-trigger").textContent = connected ? state.demo ? "Sample workspace" : "Workspace connected" : "Connect workspace";
  byId("sample-banner").hidden = !state.demo;
}

function activateView(view) {
  state.activeView = view;
  queryAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === view;
    button.dataset.active = String(selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  queryAll(".view").forEach((section) => { section.hidden = section.id !== "view-" + view; });
  byId("current-view").textContent = humanize(view);
  if (view === "records") renderRecords();
  if (view === "workflows") renderWorkflows();
  if (view === "ai") renderAi();
  if (view === "settings") renderSettings();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function actionButton(action, className = "action-row") {
  const button = make("button", className);
  button.type = "button";
  button.dataset.actionId = action.id;
  const copy = make("span", "action-copy");
  copy.append(make("strong", "", action.title), make("small", "", action.description));
  const scope = make("span", "scope", action.requiredScope);
  button.append(copy, scope);
  button.addEventListener("click", () => openAction(action.id));
  return button;
}

function renderManifest(manifest) {
  state.manifest = manifest;
  document.title = manifest.product.name + " — Workspace";
  byId("product-name").textContent = manifest.product.name;
  byId("product-category").textContent = manifest.module.category;
  byId("hero-title").textContent = manifest.experience.headline;
  byId("hero-description").textContent = manifest.module.description;
  byId("module-plan").textContent = humanize(manifest.module.minimumHostedPlan) + " plan";
  document.body.style.setProperty("--accent", manifest.product.accent);
  document.body.style.setProperty("--accent-dark", manifest.product.accentDark);

  const quickActions = clear(byId("quick-actions"));
  for (const actionId of manifest.experience.quickActionIds ?? []) {
    const action = manifest.actions.find((candidate) => candidate.id === actionId);
    if (action) quickActions.append(actionButton(action, "quick-action"));
  }
  const primary = manifest.actions.find((action) => action.id === manifest.experience.primaryActionId) ?? manifest.actions[0];
  byId("primary-action-label").textContent = primary.title;
  byId("primary-action").onclick = () => openAction(primary.id);

  const filters = clear(byId("record-type-filter"));
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All record types";
  filters.append(all);
  for (const recordType of manifest.module.recordTypes) {
    const option = document.createElement("option");
    option.value = recordType;
    option.textContent = humanize(recordType);
    filters.append(option);
  }
  renderMetrics();
  renderWorkflows();
  renderAi();
  renderSettings();
}

function renderMetrics() {
  if (!state.manifest) return;
  const metrics = clear(byId("metric-grid"));
  const liveValues = new Map([
    ["Typed actions", state.manifest.actions.length],
    ["Record types", new Set(state.records.map((record) => record.recordType)).size || state.manifest.module.recordTypes.length],
    ["Workspace records", state.records.length],
    ["Review gates", state.manifest.experience.metrics.find((metric) => metric.label === "Review gates")?.value ?? 0],
  ]);
  for (const [label, value] of liveValues) {
    const card = make("article", "metric-card");
    card.append(make("span", "metric-value", String(value).padStart(2, "0")), make("span", "metric-label", label));
    metrics.append(card);
  }
}

function recordCard(record, compact = false) {
  const card = make("button", compact ? "record-card compact" : "record-card");
  card.type = "button";
  const top = make("span", "record-card-top");
  top.append(make("span", "record-type", humanize(record.recordType)), make("span", "record-state", humanize(record.state || "current")));
  card.append(top, make("strong", "record-title", record.title || humanize(record.recordType)), make("span", "record-date", "Updated " + shortDate(record.updatedAt)));
  card.addEventListener("click", () => openRecord(record));
  return card;
}

function renderRecentRecords() {
  const target = clear(byId("recent-records"));
  const records = state.records.slice(0, 5);
  if (!records.length) {
    target.append(make("p", "empty-state", state.connected ? "No records yet. Run the primary workflow to create the first one." : "Connect a workspace to load current records."));
    return;
  }
  records.forEach((record) => target.append(recordCard(record, true)));
}

function filteredRecords() {
  const query = state.recordQuery.trim().toLowerCase();
  return state.records.filter((record) => {
    if (state.recordType !== "all" && record.recordType !== state.recordType) return false;
    if (!query) return true;
    return [record.title, record.recordType, record.state, JSON.stringify(record.data)].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

function renderRecords() {
  const records = filteredRecords();
  byId("record-count").textContent = records.length + (records.length === 1 ? " record" : " records");
  const grid = clear(byId("record-grid"));
  if (!records.length) {
    grid.append(make("p", "empty-state wide", state.connected ? "No records match this view." : "Connect a workspace to inspect records."));
    return;
  }
  records.forEach((record) => grid.append(recordCard(record)));
}

function renderWorkflows() {
  if (!state.manifest) return;
  const target = clear(byId("workflow-groups"));
  for (const [index, group] of state.manifest.experience.workflowGroups.entries()) {
    const section = make("section", "workflow-group");
    const trigger = make("button", "workflow-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-expanded", String(index === 0));
    trigger.append(make("span", "workflow-index", String(index + 1).padStart(2, "0")), make("strong", "", group.name), make("span", "workflow-count", group.actionIds.length + " workflows"));
    const body = make("div", "workflow-body");
    body.hidden = index !== 0;
    for (const actionId of group.actionIds) {
      const action = state.manifest.actions.find((candidate) => candidate.id === actionId);
      if (action) body.append(actionButton(action));
    }
    trigger.addEventListener("click", () => {
      const expanded = trigger.getAttribute("aria-expanded") === "true";
      trigger.setAttribute("aria-expanded", String(!expanded));
      body.hidden = expanded;
    });
    section.append(trigger, body);
    target.append(section);
  }
}

function renderAi() {
  if (!state.manifest) return;
  const target = clear(byId("ai-actions"));
  const actions = state.manifest.actions.filter((action) => action.requiredScope === "ai" || action.operation === "ai");
  if (!actions.length) {
    target.append(make("p", "empty-state wide", "This product keeps every declared workflow deterministic and does not expose an AI action."));
    return;
  }
  actions.forEach((action) => target.append(actionButton(action, "ai-card")));
}

function renderSettings() {
  if (!state.manifest) return;
  byId("settings-boundary").textContent = state.manifest.experience.releaseBoundary;
  byId("settings-module").textContent = state.manifest.module.id;
  byId("settings-plan").textContent = state.manifest.module.minimumHostedPlan;
  byId("settings-resource").textContent = state.manifest.module.resourceClass;
  byId("settings-version").textContent = state.manifest.release.productVersion;
  const capabilities = clear(byId("capability-list"));
  state.manifest.module.aiCapabilities.forEach((capability) => capabilities.append(make("li", "", capability)));
}

function openRecord(record) {
  byId("record-detail-title").textContent = record.title || humanize(record.recordType);
  byId("record-detail-meta").textContent = humanize(record.recordType) + " · " + humanize(record.state || "current") + " · Updated " + shortDate(record.updatedAt);
  byId("record-detail-json").textContent = JSON.stringify(record, null, 2);
  byId("record-dialog").showModal();
}

function fieldDescription(schema) {
  return schema.description || (schema.format ? "Required format: " + schema.format + "." : "Typed input enforced by the product action contract.");
}

function createField(name, schema, value, required) {
  const group = make("div", "field-group");
  const label = make("label", "field-label");
  label.htmlFor = "field-" + name;
  label.append(document.createTextNode(humanize(name)));
  if (required) label.append(make("span", "required", "Required"));
  let control;
  if (Array.isArray(schema.enum)) {
    control = document.createElement("select");
    for (const optionValue of schema.enum) {
      const option = document.createElement("option");
      option.value = String(optionValue);
      option.textContent = humanize(optionValue);
      option.selected = optionValue === value;
      control.append(option);
    }
  } else if (schema.type === "boolean") {
    const wrapper = make("label", "toggle");
    control = document.createElement("input");
    control.type = "checkbox";
    control.checked = value === true;
    wrapper.append(control, make("span", "toggle-track"), make("span", "toggle-copy", "Enabled"));
    label.htmlFor = "";
    group.append(label, wrapper, make("p", "field-help", fieldDescription(schema)));
  } else if (schema.type === "array" || schema.type === "object" || (schema.type === "string" && (schema.maxLength ?? 0) > 320)) {
    control = document.createElement("textarea");
    control.rows = schema.type === "string" ? 4 : 5;
    control.value = schema.type === "string" ? value ?? "" : JSON.stringify(value ?? (schema.type === "array" ? [] : {}), null, 2);
    control.dataset.json = schema.type === "string" ? "false" : "true";
  } else {
    control = document.createElement("input");
    control.type = schema.type === "integer" || schema.type === "number" ? "number" : schema.format === "email" ? "email" : schema.format === "date-time" ? "datetime-local" : schema.format === "uri" ? "url" : "text";
    if (schema.minimum !== undefined) control.min = String(schema.minimum);
    if (schema.maximum !== undefined) control.max = String(schema.maximum);
    if (schema.maxLength !== undefined) control.maxLength = schema.maxLength;
    if (value !== undefined && value !== null) control.value = schema.format === "date-time" ? String(value).replace(/Z$/, "").slice(0, 16) : String(value);
    if (schema.format === "uuid" || /Id$/.test(name)) {
      control.setAttribute("list", "record-identifiers");
      control.placeholder = "Select or paste a record ID";
    }
  }
  control.id = "field-" + name;
  control.name = name;
  control.dataset.schemaType = schema.type ?? "string";
  control.required = required;
  if (schema.type !== "boolean") group.append(label, control, make("p", "field-help", fieldDescription(schema)));
  return group;
}

function buildActionForm(action) {
  const form = clear(byId("action-form"));
  const required = new Set(action.inputSchema.required ?? []);
  const example = action.exampleInput ?? {};
  for (const [name, schema] of Object.entries(action.inputSchema.properties ?? {})) form.append(createField(name, schema, example[name], required.has(name)));
  byId("action-json").value = JSON.stringify(example, null, 2);
  form.addEventListener("input", () => {
    try { byId("action-json").value = JSON.stringify(collectActionInput(action), null, 2); } catch { }
  });
}

function collectActionInput(action) {
  if (byId("advanced-input").open) {
    let parsed;
    try { parsed = JSON.parse(byId("action-json").value); } catch { throw new Error("Advanced JSON input must be valid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Advanced JSON input must be an object.");
    return parsed;
  }
  const input = {};
  const required = new Set(action.inputSchema.required ?? []);
  for (const [name, schema] of Object.entries(action.inputSchema.properties ?? {})) {
    const control = byId("field-" + name);
    if (!control) continue;
    if (schema.type === "boolean") {
      input[name] = control.checked;
      continue;
    }
    if (!control.value && !required.has(name)) continue;
    if (control.dataset.json === "true") {
      try { input[name] = JSON.parse(control.value); } catch { throw new Error(humanize(name) + " must contain valid JSON."); }
    } else if (schema.type === "integer" || schema.type === "number") input[name] = Number(control.value);
    else if (schema.format === "date-time" && control.value) input[name] = new Date(control.value).toISOString();
    else input[name] = control.value;
  }
  return input;
}

function openAction(actionId) {
  const action = state.manifest.actions.find((candidate) => candidate.id === actionId);
  if (!action) return;
  state.selectedAction = action;
  byId("action-dialog-title").textContent = action.title;
  byId("action-dialog-description").textContent = action.description;
  byId("action-scope").textContent = action.requiredScope + " scope";
  byId("action-operation").textContent = humanize(action.operation);
  byId("advanced-input").open = false;
  byId("action-result").hidden = true;
  buildActionForm(action);
  byId("action-dialog").showModal();
}

function addActivity(action, result) {
  state.activities.unshift({ actionId: action.id, title: action.title, status: result.kind === "ai-action" ? "proposal ready" : "completed", at: new Date().toISOString() });
  state.activities = state.activities.slice(0, 12);
  renderActivity();
}

function renderActivity() {
  const target = clear(byId("activity-list"));
  const items = state.activities.length ? state.activities : (state.records.slice(0, 4).map((record) => ({ title: "Updated " + humanize(record.recordType), status: record.state || "current", at: record.updatedAt })));
  if (!items.length) return target.append(make("p", "empty-state", "Recent workflow activity will appear here."));
  for (const item of items) {
    const row = make("div", "activity-row");
    row.append(make("span", "activity-dot"), make("strong", "", item.title), make("span", "activity-status", humanize(item.status)), make("time", "", shortDate(item.at)));
    target.append(row);
  }
}

async function refreshRecords() {
  if (!state.connected) return;
  const response = await api("/product-api/records?limit=200");
  state.records = Array.isArray(response.records) ? response.records : [];
  renderMetrics();
  renderRecentRecords();
  renderRecords();
  renderActivity();
  const identifiers = clear(byId("record-identifiers"));
  state.records.forEach((record) => {
    const option = document.createElement("option");
    option.value = record.id;
    option.label = (record.title || humanize(record.recordType)) + " — " + humanize(record.recordType);
    identifiers.append(option);
  });
}

async function connect() {
  const key = byId("web-key").value.trim();
  if (key.length < 24) throw new Error("Enter the separate browser access key configured for this product server.");
  state.webKey = key;
  sessionStorage.setItem("product-web-key", key);
  state.workspace = await api("/product-api/workspace");
  state.demo = state.workspace.demo === true;
  setConnection(true);
  byId("connect-dialog").close();
  await refreshRecords();
  const workspace = workspaceValue();
  byId("workspace-name").textContent = workspace.name || workspace.slug || "Private workspace";
  toast(state.demo ? "Sample workspace loaded." : "Workspace connected.", "success");
}

async function executeSelectedAction(event) {
  event.preventDefault();
  if (!state.connected) {
    byId("connect-dialog").showModal();
    toast("Connect the product server before running a workflow.", "error");
    return;
  }
  const action = state.selectedAction;
  const input = collectActionInput(action);
  setBusy(true, "Running " + action.title);
  try {
    const result = await api("/product-api/actions/" + encodeURIComponent(action.id), { method: "POST", body: JSON.stringify({ input }) });
    addActivity(action, result);
    byId("action-result").hidden = false;
    byId("action-result-json").textContent = JSON.stringify(result, null, 2);
    await refreshRecords();
    toast(action.title + " completed.", "success");
  } finally {
    setBusy(false);
  }
}

async function invoke(work) {
  try { await work(); }
  catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
    setBusy(false);
  }
}

queryAll("[data-view]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
byId("connect-trigger").addEventListener("click", () => byId("connect-dialog").showModal());
byId("connect-cancel").addEventListener("click", () => byId("connect-dialog").close());
byId("connect").addEventListener("click", () => invoke(connect));
byId("disconnect").addEventListener("click", () => {
  state.webKey = "";
  state.workspace = null;
  state.records = [];
  state.demo = false;
  sessionStorage.removeItem("product-web-key");
  byId("web-key").value = "";
  setConnection(false);
  renderMetrics();
  renderRecentRecords();
  renderRecords();
  byId("connect-dialog").close();
  toast("Browser access cleared.");
});
byId("enable-product").addEventListener("click", () => invoke(async () => {
  if (!state.connected) return byId("connect-dialog").showModal();
  await api("/product-api/enable", { method: "POST" });
  state.workspace = await api("/product-api/workspace");
  toast("Product enabled for this workspace.", "success");
}));
byId("refresh-records").addEventListener("click", () => invoke(refreshRecords));
byId("view-all-records").addEventListener("click", () => activateView("records"));
byId("record-query").addEventListener("input", (event) => { state.recordQuery = event.target.value; renderRecords(); });
byId("record-type-filter").addEventListener("change", (event) => { state.recordType = event.target.value; renderRecords(); });
byId("action-execute").addEventListener("click", executeSelectedAction);
byId("action-close").addEventListener("click", () => byId("action-dialog").close());
byId("record-close").addEventListener("click", () => byId("record-dialog").close());
byId("global-search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  state.recordQuery = event.currentTarget.value;
  byId("record-query").value = state.recordQuery;
  activateView("records");
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    byId("global-search").focus();
  }
});

invoke(async () => {
  const manifest = await api("/manifest", {}, false);
  renderManifest(manifest);
  byId("web-key").value = state.webKey;
  setConnection(false);
  renderRecentRecords();
  renderRecords();
  renderActivity();
  activateView("overview");
  if (state.webKey.length >= 24) await connect();
});
`;

const indexTemplate = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="__TAGLINE__">
  <title>__PRODUCT_NAME__ — Workspace</title>
  <link rel="stylesheet" href="/styles.css?v=__VERSION__">
</head>
<body>
  <div class="busy-overlay" aria-live="polite"><span class="busy-spinner"></span><span id="busy-label">Working</span></div>
  <div id="toast-root" class="toast-root" aria-live="polite"></div>

  <aside class="side-nav">
    <a class="brand" href="/" aria-label="__PRODUCT_NAME__ home">
      <span class="mark" aria-hidden="true"><span></span><span></span><span></span></span>
      <span><strong id="product-name">__PRODUCT_NAME__</strong><small id="product-category">__CATEGORY__</small></span>
    </a>
    <nav aria-label="Product workspace">
      <button type="button" data-view="overview" data-active="true"><span class="nav-glyph">O</span>Overview</button>
      <button type="button" data-view="records"><span class="nav-glyph">R</span>Records</button>
      <button type="button" data-view="workflows"><span class="nav-glyph">W</span>Workflows</button>
      <button type="button" data-view="ai"><span class="nav-glyph">A</span>AI assistance</button>
      <button type="button" data-view="settings"><span class="nav-glyph">S</span>Settings</button>
    </nav>
    <div class="nav-footer">
      <div class="connection-state"><span class="state-dot"></span><span id="connection-state" data-connected="false">Connect</span></div>
      <button id="connect-trigger" class="connect-button" type="button">Connect workspace</button>
      <p>Private API access stays on this server.</p>
    </div>
  </aside>

  <main class="workspace-shell">
    <header class="topbar">
      <div class="breadcrumbs"><span id="workspace-name">Private workspace</span><span>/</span><strong id="current-view">Overview</strong></div>
      <div class="topbar-actions">
        <label class="global-search"><span>Search</span><input id="global-search" type="search" placeholder="Search records"><kbd>⌘ K</kbd></label>
        <span id="module-plan" class="plan-label">__PLAN__ plan</span>
      </div>
    </header>

    <div id="sample-banner" class="sample-banner" hidden><strong>Sample workspace</strong><span>This is the actual product UI using local seeded data. Connect your backend for durable shared records.</span></div>

    <section id="view-overview" class="view overview-view">
      <section class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">__MODULE_ID__ WORKSPACE</p>
          <h1 id="hero-title">__HEADLINE__</h1>
          <p id="hero-description">Product workspace</p>
          <div class="hero-actions">
            <button id="primary-action" class="primary" type="button"><span id="primary-action-label">Start workflow</span><span aria-hidden="true">↗</span></button>
            <button id="view-all-records" class="secondary" type="button">Browse records</button>
          </div>
        </div>
        <aside class="hero-signal" aria-label="Workspace signal">
          <div class="signal-visual" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
          <p>Typed operations</p>
          <strong>__ACTION_COUNT__</strong>
          <small>Every workflow is schema-validated, scoped, and recorded by the shared backend.</small>
        </aside>
      </section>

      <section id="metric-grid" class="metric-grid" aria-label="Workspace metrics"></section>

      <section class="overview-grid">
        <article class="panel recent-panel">
          <div class="panel-heading"><div><p class="kicker">Current work</p><h2>Recent records</h2></div><button id="refresh-records" type="button" class="text-button">Refresh</button></div>
          <div id="recent-records" class="recent-records"></div>
        </article>
        <article class="panel action-panel">
          <div class="panel-heading"><div><p class="kicker">Move work forward</p><h2>Quick workflows</h2></div></div>
          <div id="quick-actions" class="quick-actions"></div>
        </article>
        <article class="panel activity-panel">
          <div class="panel-heading"><div><p class="kicker">Evidence trail</p><h2>Recent activity</h2></div></div>
          <div id="activity-list" class="activity-list"></div>
        </article>
      </section>
    </section>

    <section id="view-records" class="view" hidden>
      <div class="view-heading"><div><p class="eyebrow">DURABLE WORK</p><h1>Records</h1><p>Search, filter, and inspect product-scoped records without exposing database credentials.</p></div><button id="enable-product" class="primary" type="button">Enable product</button></div>
      <div class="record-toolbar">
        <label><span>Search records</span><input id="record-query" type="search" placeholder="Title, state, or data"></label>
        <label><span>Record type</span><select id="record-type-filter"></select></label>
        <strong id="record-count">0 records</strong>
      </div>
      <div id="record-grid" class="record-grid"></div>
    </section>

    <section id="view-workflows" class="view" hidden>
      <div class="view-heading"><div><p class="eyebrow">TYPED OPERATIONS</p><h1>Workflows</h1><p>Every declared product action is available through a guided form, the CLI, and MCP with the same schema.</p></div></div>
      <div id="workflow-groups" class="workflow-groups"></div>
    </section>

    <section id="view-ai" class="view" hidden>
      <div class="view-heading"><div><p class="eyebrow">EVIDENCE-BOUND</p><h1>AI assistance</h1><p>AI creates reviewable proposals from typed evidence. It cannot bypass approvals or mutate consequential facts.</p></div></div>
      <div id="ai-actions" class="ai-grid"></div>
    </section>

    <section id="view-settings" class="view" hidden>
      <div class="view-heading"><div><p class="eyebrow">PRODUCT BOUNDARY</p><h1>Settings</h1><p id="settings-boundary"></p></div><button id="disconnect" class="secondary" type="button">Clear browser access</button></div>
      <div class="settings-grid">
        <article class="panel"><h2>Runtime</h2><dl class="detail-list"><div><dt>Module</dt><dd id="settings-module"></dd></div><div><dt>Minimum plan</dt><dd id="settings-plan"></dd></div><div><dt>Resource class</dt><dd id="settings-resource"></dd></div><div><dt>Product version</dt><dd id="settings-version"></dd></div></dl></article>
        <article class="panel"><h2>AI capabilities</h2><ul id="capability-list" class="capability-list"></ul></article>
        <article class="panel security-panel"><h2>Security model</h2><p>The browser key only unlocks this local product server. Your scoped bearer token remains server-side, and all durable tenant isolation stays in managed-oss-cloud.</p></article>
      </div>
    </section>
  </main>

  <datalist id="record-identifiers"></datalist>

  <dialog id="connect-dialog" class="modal connect-modal">
    <div class="modal-heading"><div><p class="kicker">Private connection</p><h2>Connect this browser</h2><p>Enter the separate web access key configured for this product server. Never enter the backend bearer token here.</p></div><button id="connect-cancel" type="button" class="icon-button" aria-label="Close">×</button></div>
    <label class="modal-field" for="web-key"><span>Web access key</span><input id="web-key" type="password" autocomplete="current-password" placeholder="At least 24 characters"></label>
    <div class="modal-actions"><button id="connect" class="primary" type="button">Connect workspace</button></div>
  </dialog>

  <dialog id="action-dialog" class="modal action-modal">
    <div class="modal-heading"><div><div class="action-meta"><span id="action-scope" class="scope"></span><span id="action-operation" class="scope"></span></div><h2 id="action-dialog-title">Run workflow</h2><p id="action-dialog-description"></p></div><button id="action-close" type="button" class="icon-button" aria-label="Close">×</button></div>
    <form id="action-form" class="action-form"></form>
    <details id="advanced-input" class="advanced-input"><summary>Advanced JSON input</summary><label for="action-json">Typed JSON</label><textarea id="action-json" spellcheck="false"></textarea></details>
    <section id="action-result" class="action-result" hidden><h3>Workflow result</h3><pre id="action-result-json"></pre></section>
    <div class="modal-actions"><button id="action-execute" class="primary" type="button">Run workflow</button></div>
  </dialog>

  <dialog id="record-dialog" class="modal record-modal">
    <div class="modal-heading"><div><p class="kicker">Durable record</p><h2 id="record-detail-title">Record</h2><p id="record-detail-meta"></p></div><button id="record-close" type="button" class="icon-button" aria-label="Close">×</button></div>
    <pre id="record-detail-json" class="record-json"></pre>
  </dialog>

  <script type="module" src="/app.js?v=__VERSION__"></script>
</body>
</html>
`;

const stylesSource = String.raw`* { box-sizing: border-box; }
:root {
  --accent: __ACCENT__;
  --accent-dark: __ACCENT_DARK__;
  --canvas: #090b0f;
  --surface: #101319;
  --surface-raised: #151920;
  --surface-soft: #1a1f27;
  --line: #282e38;
  --line-strong: #39414d;
  --text: #f4f5f7;
  --muted: #969faa;
  --muted-strong: #bbc2cb;
  --danger: #ff7d75;
  color: var(--text);
  background: var(--canvas);
  font-family: Geist, "Helvetica Neue", Arial, sans-serif;
  font-synthesis: none;
}
html { min-width: 320px; background: var(--canvas); scroll-behavior: smooth; }
body { margin: 0; min-height: 100vh; overflow-x: hidden; background: radial-gradient(circle at 88% -8%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 30rem), var(--canvas); }
body::before { position: fixed; inset: 0; z-index: -1; pointer-events: none; content: ""; opacity: 0.32; background-image: linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px); background-size: 44px 44px; mask-image: linear-gradient(to bottom, black, transparent 72%); }
button, input, select, textarea { font: inherit; }
button { color: inherit; }
button, a, input, select, textarea, summary { outline-offset: 3px; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); }
button { border: 0; cursor: pointer; }
input, select, textarea { width: 100%; border: 1px solid var(--line-strong); border-radius: 0.72rem; padding: 0.78rem 0.88rem; color: var(--text); background: #0d1015; transition: border-color 160ms ease, box-shadow 160ms ease; }
input:hover, select:hover, textarea:hover { border-color: #515b69; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 13%, transparent); }
textarea { resize: vertical; line-height: 1.55; }
h1, h2, h3, p { margin-top: 0; }
h1, h2, h3, strong { letter-spacing: -0.025em; }
h1 { max-width: 72rem; margin-bottom: 1.15rem; font-size: clamp(2.5rem, 5vw, 5.4rem); line-height: 0.98; letter-spacing: -0.062em; }
h2 { margin-bottom: 0.55rem; font-size: clamp(1.35rem, 2vw, 1.9rem); }
h3 { margin-bottom: 0.5rem; }
p { color: var(--muted); line-height: 1.58; }
[hidden] { display: none !important; }

.side-nav { position: fixed; inset: 0 auto 0 0; z-index: 20; display: flex; flex-direction: column; width: 264px; padding: 1.35rem 1rem 1rem; border-right: 1px solid var(--line); background: rgba(12, 15, 20, 0.94); backdrop-filter: blur(24px); }
.brand { display: flex; align-items: center; gap: 0.8rem; min-width: 0; padding: 0.4rem 0.55rem 1.6rem; color: var(--text); text-decoration: none; }
.brand > span:last-child { display: grid; min-width: 0; gap: 0.16rem; }
.brand strong { overflow: hidden; font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
.brand small { overflow: hidden; color: var(--muted); font-size: 0.72rem; text-overflow: ellipsis; white-space: nowrap; }
.mark { display: inline-flex; align-items: end; justify-content: center; gap: 2px; width: 2.25rem; height: 2.25rem; padding: 0.56rem; flex: 0 0 auto; border-radius: 0.72rem; color: #06110e; background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent-dark) 75%, #000)); box-shadow: 0 0.8rem 2.4rem color-mix(in srgb, var(--accent) 18%, transparent); }
.mark span { display: block; width: 3px; border-radius: 3px; background: currentColor; animation: signal 1.8s ease-in-out infinite; }
.mark span:nth-child(1) { height: 45%; animation-delay: -0.4s; }
.mark span:nth-child(2) { height: 100%; animation-delay: -0.8s; }
.mark span:nth-child(3) { height: 65%; animation-delay: -1.2s; }
.side-nav nav { display: grid; gap: 0.26rem; }
.side-nav nav button { display: flex; align-items: center; gap: 0.72rem; width: 100%; border-radius: 0.7rem; padding: 0.72rem 0.76rem; color: var(--muted-strong); background: transparent; text-align: left; transition: color 160ms ease, background 160ms ease, transform 160ms ease; }
.side-nav nav button:hover { color: var(--text); background: var(--surface-soft); transform: translateX(2px); }
.side-nav nav button[data-active="true"] { color: #07110e; background: var(--accent); font-weight: 760; }
.nav-glyph { display: grid; place-items: center; width: 1.6rem; height: 1.6rem; border: 1px solid currentColor; border-radius: 0.45rem; font-size: 0.62rem; font-weight: 800; opacity: 0.78; }
.nav-footer { display: grid; gap: 0.72rem; margin-top: auto; padding: 1rem 0.55rem 0.25rem; border-top: 1px solid var(--line); }
.nav-footer p { margin: 0; font-size: 0.72rem; }
.connection-state { display: flex; align-items: center; gap: 0.48rem; color: var(--muted-strong); font-size: 0.78rem; }
.state-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #59616c; }
.connection-state:has([data-connected="true"]) .state-dot { background: var(--accent); box-shadow: 0 0 0.8rem var(--accent); }
.connect-button { width: 100%; border: 1px solid var(--line-strong); border-radius: 0.66rem; padding: 0.7rem; color: var(--text); background: var(--surface-raised); font-size: 0.78rem; font-weight: 680; }
.connect-button:hover { border-color: var(--accent); }

.workspace-shell { width: calc(100% - 264px); min-height: 100vh; margin-left: 264px; padding: 0 2.2rem 6rem; }
.topbar { position: sticky; top: 0; z-index: 15; display: flex; align-items: center; justify-content: space-between; min-height: 4.75rem; margin: 0 -2.2rem; padding: 0 2.2rem; border-bottom: 1px solid rgba(40,46,56,0.78); background: rgba(9, 11, 15, 0.78); backdrop-filter: blur(22px); }
.breadcrumbs { display: flex; gap: 0.55rem; align-items: center; color: var(--muted); font-size: 0.78rem; }
.breadcrumbs strong { color: var(--text); }
.topbar-actions { display: flex; gap: 0.7rem; align-items: center; }
.global-search { position: relative; display: flex; align-items: center; min-width: min(25rem, 32vw); }
.global-search > span { position: absolute; overflow: hidden; width: 1px; height: 1px; clip: rect(0 0 0 0); }
.global-search input { height: 2.55rem; padding-right: 3.6rem; background: rgba(17,20,26,0.82); }
kbd { position: absolute; right: 0.65rem; border: 1px solid var(--line-strong); border-radius: 0.35rem; padding: 0.18rem 0.35rem; color: var(--muted); background: var(--surface-soft); font-size: 0.62rem; }
.plan-label { border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 999px; padding: 0.5rem 0.72rem; color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); font-size: 0.72rem; font-weight: 720; }
.sample-banner { display: flex; gap: 0.75rem; align-items: center; margin: 1rem 0 0; border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line)); border-radius: 0.7rem; padding: 0.72rem 0.88rem; background: color-mix(in srgb, var(--accent) 7%, var(--surface)); font-size: 0.78rem; }
.sample-banner strong { color: var(--accent); }
.sample-banner span { color: var(--muted-strong); }

.view { width: min(1540px, 100%); margin: 0 auto; padding-top: 3rem; animation: view-in 400ms cubic-bezier(.2,.8,.2,1) both; }
.hero-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(19rem, 0.55fr); gap: clamp(2rem, 7vw, 8rem); align-items: end; min-height: 31rem; padding: clamp(4rem, 9vw, 8rem) 0 4.5rem; }
.hero-copy { min-width: 0; }
.hero-copy > p:not(.eyebrow) { max-width: 52rem; margin-bottom: 2rem; font-size: 1rem; }
.eyebrow, .kicker { margin-bottom: 0.85rem; color: var(--accent); font-size: 0.68rem; font-weight: 800; letter-spacing: 0.17em; text-transform: uppercase; }
.hero-actions, .modal-actions { display: flex; flex-wrap: wrap; gap: 0.7rem; }
.primary, .secondary { display: inline-flex; align-items: center; justify-content: center; gap: 1.2rem; min-height: 2.8rem; border-radius: 0.7rem; padding: 0.76rem 1.05rem; font-weight: 760; transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease; }
.primary { color: #07110e; background: var(--accent); box-shadow: 0 0.85rem 2.6rem color-mix(in srgb, var(--accent) 14%, transparent); }
.primary:hover { transform: translateY(-2px); box-shadow: 0 1rem 3rem color-mix(in srgb, var(--accent) 24%, transparent); }
.secondary { border: 1px solid var(--line-strong); color: var(--text); background: var(--surface-raised); }
.secondary:hover { border-color: var(--accent); transform: translateY(-2px); }
.hero-signal { position: relative; overflow: hidden; min-height: 21rem; border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line)); border-radius: 1.3rem; padding: 1.5rem; background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 8%, var(--surface-raised)), var(--surface)); }
.hero-signal::after { position: absolute; inset: auto -22% -38% 28%; height: 14rem; border-radius: 50%; content: ""; background: color-mix(in srgb, var(--accent) 20%, transparent); filter: blur(48px); }
.hero-signal p { margin: 1.8rem 0 0.25rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.12em; }
.hero-signal > strong { position: relative; z-index: 1; display: block; font-size: clamp(4rem, 7vw, 7.8rem); line-height: 0.9; letter-spacing: -0.08em; }
.hero-signal small { position: absolute; right: 1.5rem; bottom: 1.4rem; left: 1.5rem; z-index: 1; color: var(--muted-strong); line-height: 1.5; }
.signal-visual { display: flex; align-items: end; gap: 0.28rem; height: 4rem; }
.signal-visual span { width: 0.42rem; border-radius: 999px; background: var(--accent); animation: signal 2.1s ease-in-out infinite; }
.signal-visual span:nth-child(1), .signal-visual span:nth-child(7) { height: 20%; }
.signal-visual span:nth-child(2), .signal-visual span:nth-child(6) { height: 42%; animation-delay: -0.3s; }
.signal-visual span:nth-child(3), .signal-visual span:nth-child(5) { height: 70%; animation-delay: -0.6s; }
.signal-visual span:nth-child(4) { height: 100%; animation-delay: -0.9s; }

.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 1rem; overflow: hidden; background: var(--line); gap: 1px; }
.metric-card { display: grid; gap: 1.25rem; min-height: 9.2rem; padding: 1.2rem; background: var(--surface); }
.metric-value { font-size: 2.45rem; font-weight: 680; letter-spacing: -0.06em; }
.metric-label { align-self: end; color: var(--muted); font-size: 0.75rem; }
.overview-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-auto-flow: dense; gap: 1rem; margin-top: 1rem; }
.panel { min-width: 0; border: 1px solid var(--line); border-radius: 1rem; padding: 1.35rem; background: rgba(16,19,25,0.9); }
.recent-panel { grid-column: span 8; min-height: 25rem; }
.action-panel { grid-column: span 4; grid-row: span 2; }
.activity-panel { grid-column: span 8; }
.panel-heading { display: flex; align-items: start; justify-content: space-between; gap: 1rem; margin-bottom: 1.2rem; }
.panel-heading h2 { margin: 0; }
.panel-heading .kicker { margin-bottom: 0.35rem; }
.text-button { padding: 0.4rem; color: var(--accent); background: transparent; font-size: 0.74rem; font-weight: 720; }
.recent-records, .quick-actions, .activity-list { display: grid; gap: 0.55rem; }
.record-card, .quick-action, .action-row, .ai-card { position: relative; display: grid; width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 0.78rem; color: var(--text); background: var(--surface-raised); text-align: left; transition: transform 180ms ease, border-color 180ms ease, background 180ms ease; }
.record-card:hover, .quick-action:hover, .action-row:hover, .ai-card:hover { z-index: 2; border-color: color-mix(in srgb, var(--accent) 58%, var(--line)); background: color-mix(in srgb, var(--accent) 5%, var(--surface-raised)); transform: translateY(-2px) scale(1.006); }
.record-card.compact { grid-template-columns: 1fr auto; align-items: center; gap: 0.55rem 1rem; padding: 0.85rem 0.95rem; }
.record-card.compact .record-card-top { grid-column: 1 / -1; }
.record-card.compact .record-date { text-align: right; }
.record-card-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.record-type, .record-state, .scope { color: var(--muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; }
.record-state { color: var(--accent); }
.record-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-date { color: var(--muted); font-size: 0.68rem; }
.quick-action { display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; padding: 0.9rem; }
.quick-action::after { content: "↗"; color: var(--accent); }
.action-copy { display: grid; min-width: 0; gap: 0.28rem; }
.action-copy small { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 0.7rem; line-height: 1.4; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.activity-row { display: grid; grid-template-columns: auto 1fr auto auto; gap: 0.7rem; align-items: center; border-top: 1px solid var(--line); padding: 0.76rem 0; font-size: 0.76rem; }
.activity-row:first-child { border-top: 0; }
.activity-dot { width: 0.48rem; height: 0.48rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0.6rem color-mix(in srgb, var(--accent) 70%, transparent); }
.activity-status, .activity-row time { color: var(--muted); }

.view-heading { display: flex; align-items: end; justify-content: space-between; gap: 2rem; min-height: 18rem; padding: 4rem 0 3rem; }
.view-heading h1 { margin-bottom: 0.7rem; }
.view-heading p:not(.eyebrow) { max-width: 56rem; margin-bottom: 0; }
.record-toolbar { display: grid; grid-template-columns: minmax(15rem, 1fr) minmax(12rem, 0.45fr) auto; gap: 0.8rem; align-items: end; border: 1px solid var(--line); border-radius: 1rem; padding: 1rem; background: var(--surface); }
.record-toolbar label { display: grid; gap: 0.42rem; color: var(--muted); font-size: 0.7rem; }
.record-toolbar strong { padding: 0.8rem 0; color: var(--muted-strong); font-size: 0.74rem; white-space: nowrap; }
.record-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-flow: dense; gap: 0.8rem; margin-top: 0.8rem; }
.record-grid .record-card { min-height: 11rem; padding: 1rem; }
.record-grid .record-title { align-self: end; font-size: 1.05rem; }
.empty-state { display: grid; place-items: center; min-height: 9rem; margin: 0; border: 1px dashed var(--line-strong); border-radius: 0.72rem; padding: 1rem; text-align: center; }
.empty-state.wide { grid-column: 1 / -1; }

.workflow-groups { display: grid; border-top: 1px solid var(--line); }
.workflow-group { border-bottom: 1px solid var(--line); }
.workflow-trigger { display: grid; grid-template-columns: auto 1fr auto; gap: 1rem; align-items: center; width: 100%; padding: 1.35rem 0.4rem; color: var(--text); background: transparent; text-align: left; }
.workflow-trigger:hover strong { color: var(--accent); }
.workflow-index, .workflow-count { color: var(--muted); font-size: 0.7rem; }
.workflow-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; padding: 0 0.4rem 1.4rem 3rem; }
.action-row { display: flex; align-items: start; justify-content: space-between; gap: 0.8rem; min-height: 6.5rem; padding: 0.95rem; }
.ai-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.8rem; }
.ai-card { min-height: 13rem; padding: 1.15rem; }
.ai-card .scope { position: absolute; right: 1rem; bottom: 1rem; color: var(--accent); }
.ai-card::before { width: 2rem; height: 2px; margin-bottom: 2.5rem; content: ""; background: var(--accent); box-shadow: 0 0 1rem var(--accent); }

.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-flow: dense; gap: 1rem; }
.settings-grid .panel { min-height: 19rem; }
.security-panel { grid-column: 1 / -1; min-height: auto !important; }
.detail-list { display: grid; gap: 0; margin: 1rem 0 0; }
.detail-list div { display: flex; justify-content: space-between; gap: 1rem; border-top: 1px solid var(--line); padding: 0.85rem 0; }
.detail-list dt { color: var(--muted); }
.detail-list dd { margin: 0; font-weight: 680; }
.capability-list { display: grid; gap: 0.8rem; margin: 1.2rem 0 0; padding: 0; list-style: none; }
.capability-list li { border-left: 2px solid var(--accent); padding: 0.45rem 0.8rem; color: var(--muted-strong); }

.modal { width: min(48rem, calc(100% - 2rem)); max-height: calc(100vh - 2rem); overflow: auto; border: 1px solid var(--line-strong); border-radius: 1.15rem; padding: 1.35rem; color: var(--text); background: #101319; box-shadow: 0 2rem 8rem rgba(0,0,0,0.58); }
.action-modal { width: min(60rem, calc(100% - 2rem)); }
.modal::backdrop { background: rgba(2,4,7,0.76); backdrop-filter: blur(8px); }
.modal-heading { display: flex; align-items: start; justify-content: space-between; gap: 2rem; margin-bottom: 1.2rem; }
.modal-heading h2 { margin-bottom: 0.5rem; }
.modal-heading p:not(.kicker) { margin-bottom: 0; }
.icon-button { display: grid; place-items: center; flex: 0 0 auto; width: 2.3rem; height: 2.3rem; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--muted-strong); background: var(--surface-raised); font-size: 1.2rem; }
.modal-field, .field-group { display: grid; gap: 0.45rem; margin-top: 1rem; }
.modal-field > span, .field-label { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; color: var(--muted-strong); font-size: 0.74rem; font-weight: 680; }
.required { color: var(--accent); font-size: 0.6rem; letter-spacing: 0.07em; text-transform: uppercase; }
.modal-actions { justify-content: flex-end; margin-top: 1.2rem; }
.action-meta { display: flex; gap: 0.45rem; margin-bottom: 0.6rem; }
.action-meta .scope { border: 1px solid var(--line-strong); border-radius: 999px; padding: 0.34rem 0.5rem; }
.action-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 0.8rem; }
.field-group:has(textarea), .field-group:has(.toggle) { grid-column: 1 / -1; }
.field-help { margin: 0; font-size: 0.65rem; }
.toggle { display: flex; align-items: center; gap: 0.65rem; cursor: pointer; }
.toggle input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.toggle-track { position: relative; width: 2.5rem; height: 1.38rem; border: 1px solid var(--line-strong); border-radius: 999px; background: #0d1015; }
.toggle-track::after { position: absolute; top: 0.2rem; left: 0.2rem; width: 0.86rem; height: 0.86rem; border-radius: 50%; content: ""; background: var(--muted); transition: transform 160ms ease, background 160ms ease; }
.toggle input:checked + .toggle-track::after { background: var(--accent); transform: translateX(1.08rem); }
.toggle-copy { color: var(--muted-strong); font-size: 0.74rem; }
.advanced-input { margin-top: 1rem; border: 1px solid var(--line); border-radius: 0.78rem; padding: 0.85rem; background: #0d1015; }
.advanced-input summary { color: var(--muted-strong); cursor: pointer; font-size: 0.74rem; font-weight: 680; }
.advanced-input label { display: block; margin: 1rem 0 0.45rem; color: var(--muted); font-size: 0.68rem; }
.advanced-input textarea { min-height: 14rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.72rem; }
.action-result { margin-top: 1rem; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 0.78rem; padding: 1rem; background: color-mix(in srgb, var(--accent) 5%, #0d1015); }
pre { overflow: auto; margin: 0; border-radius: 0.65rem; padding: 0.9rem; color: #d9dee5; background: #080a0d; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.7rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.record-json { max-height: 65vh; }

.toast-root { position: fixed; top: 1rem; right: 1rem; z-index: 100; display: grid; gap: 0.55rem; width: min(24rem, calc(100% - 2rem)); }
.toast { border: 1px solid var(--line-strong); border-radius: 0.72rem; padding: 0.8rem 0.9rem; color: var(--muted-strong); background: #151920; box-shadow: 0 1rem 3rem rgba(0,0,0,0.4); opacity: 0; transform: translateY(-0.6rem); transition: opacity 200ms ease, transform 200ms ease; }
.toast[data-visible="true"] { opacity: 1; transform: translateY(0); }
.toast[data-kind="success"] { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.toast[data-kind="error"] { border-color: color-mix(in srgb, var(--danger) 55%, var(--line)); color: #ffd0cc; }
.busy-overlay { position: fixed; inset: 0; z-index: 90; display: none; place-items: center; align-content: center; gap: 0.8rem; color: var(--muted-strong); background: rgba(7,9,12,0.58); backdrop-filter: blur(4px); font-size: 0.8rem; }
body[data-busy="true"] .busy-overlay { display: grid; }
.busy-spinner { width: 2rem; height: 2rem; border: 2px solid var(--line-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }

@keyframes signal { 0%, 100% { transform: scaleY(0.72); opacity: 0.7; } 50% { transform: scaleY(1.04); opacity: 1; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes view-in { from { opacity: 0; transform: translateY(0.8rem); } to { opacity: 1; transform: translateY(0); } }

@media (max-width: 1080px) {
  .side-nav { width: 220px; }
  .workspace-shell { width: calc(100% - 220px); margin-left: 220px; }
  .hero-grid { grid-template-columns: 1fr; gap: 1.5rem; }
  .hero-signal { min-height: 15rem; }
  .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .recent-panel, .action-panel, .activity-panel { grid-column: 1 / -1; grid-row: auto; }
  .record-grid, .ai-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 760px) {
  .side-nav { position: fixed; inset: auto 0 0; width: 100%; height: auto; padding: 0.45rem; border: 0; border-top: 1px solid var(--line); }
  .brand, .nav-footer { display: none; }
  .side-nav nav { grid-template-columns: repeat(5, 1fr); }
  .side-nav nav button { justify-content: center; padding: 0.6rem 0.2rem; font-size: 0; }
  .side-nav nav button .nav-glyph { font-size: 0.62rem; }
  .workspace-shell { width: 100%; margin-left: 0; padding: 0 1rem 6rem; }
  .topbar { margin: 0 -1rem; padding: 0 1rem; }
  .breadcrumbs, .plan-label { display: none; }
  .topbar-actions, .global-search { width: 100%; min-width: 0; }
  .hero-grid { min-height: auto; padding: 5rem 0 3rem; }
  h1 { font-size: clamp(2.45rem, 12vw, 4.2rem); }
  .metric-grid, .record-grid, .ai-grid, .workflow-body, .settings-grid, .action-form { grid-template-columns: 1fr; }
  .overview-grid { display: block; }
  .overview-grid > * { margin-top: 0.8rem; }
  .record-toolbar { grid-template-columns: 1fr; }
  .view-heading { align-items: start; flex-direction: column; min-height: auto; padding: 4rem 0 2rem; }
  .workflow-body { padding-left: 0.4rem; }
  .security-panel, .field-group:has(textarea), .field-group:has(.toggle) { grid-column: auto; }
  .sample-banner { align-items: start; flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
`;

const fakeApiSource = String.raw`import { createServer } from "node:http";

async function parseBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function createFakeApi(moduleId) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const body = await parseBody(request);
    requests.push({ method: request.method, path: url.pathname, search: url.search, authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer test-token") {
      response.statusCode = 401;
      return response.end(JSON.stringify({ error: "Unauthorized." }));
    }
    const modulePrefix = "/api/suite/modules/" + moduleId;
    if (url.pathname === "/api/suite/workspace") return response.end(JSON.stringify({ id: "workspace-1", plan: "fleet", enabledModuleIds: [moduleId] }));
    if (url.pathname === modulePrefix + "/enable" && request.method === "POST") return response.end(JSON.stringify({ enabled: true, moduleId }));
    if (url.pathname === "/api/suite/records") return response.end(JSON.stringify({ records: [{ id: "record-1", moduleId }] }));
    if (url.pathname.startsWith("/api/suite/ai-actions/")) return response.end(JSON.stringify({ id: url.pathname.split("/").at(-1), status: "completed" }));
    if (url.pathname.startsWith(modulePrefix + "/actions/") && request.method === "POST") {
      return response.end(JSON.stringify({ ok: true, moduleId, actionId: url.pathname.split("/").at(-1), input: body.input }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Unknown fake route." }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: "http://127.0.0.1:" + address.port,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
`;

const clientTestSource = String.raw`import assert from "node:assert/strict";
import test from "node:test";
import { ProductClient } from "../src/client.mjs";
import { manifest } from "../src/manifest.mjs";
import { createFakeApi } from "./helpers/fake-api.mjs";

test("manifest is pinned and every action is product scoped", () => {
  assert.equal(manifest.release.backendRelease, "${sourceRelease}");
  assert.equal(manifest.release.backendCommit, "${sourceCommit}");
  assert.ok(manifest.actions.length > 0);
  assert.ok(manifest.actions.every((action) => action.moduleId === manifest.module.id));
  assert.equal(new Set(manifest.actions.map((action) => action.id)).size, manifest.actions.length);
  assert.ok(manifest.actions.every((action) => action.inputSchema?.type === "object"));
});

test("client uses bearer auth and cannot escape its fixed module", async (context) => {
  const fake = await createFakeApi(manifest.module.id);
  context.after(() => fake.close());
  const client = new ProductClient({ baseUrl: fake.url, token: "test-token" });
  const workspace = await client.workspace();
  assert.equal(workspace.id, "workspace-1");
  const records = await client.listRecords({ limit: 25 });
  assert.equal(records.records[0].moduleId, manifest.module.id);
  const action = manifest.actions[0];
  const result = await client.runAction(action.id, action.exampleInput);
  assert.equal(result.moduleId, manifest.module.id);
  assert.equal(result.actionId, action.id);
  assert.ok(fake.requests.every((request) => request.authorization === "Bearer test-token"));
  assert.ok(fake.requests.some((request) => request.path === "/api/suite/modules/" + manifest.module.id + "/actions/" + action.id));
  assert.throws(() => client.runAction("not-a-product-action", {}), /Unknown/);
  assert.throws(() => client.runAction(action.id, {}), /required/);
});
`;

const validationTestSource = String.raw`import assert from "node:assert/strict";
import test from "node:test";
import { validateInput } from "../src/validation.mjs";

test("validator enforces unique arrays structurally", () => {
  const schema = {
    type: "array",
    uniqueItems: true,
    items: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string" } },
      additionalProperties: false,
    },
  };
  validateInput(schema, [{ key: "first" }, { key: "second" }]);
  assert.throws(() => validateInput(schema, [{ key: "duplicate" }, { key: "duplicate" }]), /must be unique/);
});

test("validator enforces dynamic object key, size, and value schemas", () => {
  const schema = {
    type: "object",
    minProperties: 1,
    maxProperties: 2,
    propertyNames: { pattern: "^[a-z]+$" },
    additionalProperties: { type: "integer", minimum: 0 },
  };
  validateInput(schema, { accepted: 1 });
  assert.throws(() => validateInput(schema, {}), /at least 1 property/);
  assert.throws(() => validateInput(schema, { first: 1, second: 2, third: 3 }), /at most 2 properties/);
  assert.throws(() => validateInput(schema, { "Not-valid": 1 }), /required pattern/);
  assert.throws(() => validateInput(schema, { accepted: "wrong" }), /must be an integer/);
});
`;

const cliTestSource = String.raw`import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { manifest } from "../src/manifest.mjs";
import { createFakeApi } from "./helpers/fake-api.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("CLI exposes only pinned product actions", async () => {
  const { stdout } = await execute(process.execPath, [cli, "actions"]);
  const actions = JSON.parse(stdout);
  assert.equal(actions.length, manifest.actions.length);
  assert.ok(actions.every((action) => action.moduleId === manifest.module.id));
});

test("CLI invokes the fixed product endpoint", async (context) => {
  const fake = await createFakeApi(manifest.module.id);
  context.after(() => fake.close());
  const action = manifest.actions[0];
  const env = {
    ...process.env,
    [manifest.product.environmentPrefix + "_TOKEN"]: "test-token",
    [manifest.product.environmentPrefix + "_URL"]: fake.url,
  };
  const { stdout } = await execute(process.execPath, [cli, "action", action.id, JSON.stringify(action.exampleInput)], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.moduleId, manifest.module.id);
  assert.equal(result.actionId, action.id);
});
`;

const mcpTestSource = String.raw`import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { manifest } from "../src/manifest.mjs";
import { createFakeApi } from "./helpers/fake-api.mjs";

function mcpSession(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  const waiters = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      replies.set(message.id, message);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    }
  });
  return {
    request(message) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
      if (replies.has(message.id)) return Promise.resolve(replies.get(message.id));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP response " + message.id + ". stderr: " + stderr)), 5000);
        waiters.set(message.id, (value) => { clearTimeout(timer); resolve(value); });
      });
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
      assert.equal(stderr, "");
    },
  };
}

test("stdio MCP advertises and calls only this product's typed tools", async (context) => {
  const fake = await createFakeApi(manifest.module.id);
  context.after(() => fake.close());
  const env = {
    ...process.env,
    [manifest.product.environmentPrefix + "_TOKEN"]: "test-token",
    [manifest.product.environmentPrefix + "_URL"]: fake.url,
  };
  const session = mcpSession(env);
  context.after(() => session.close());
  const initialized = await session.request({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(initialized.result.serverInfo.name, manifest.product.slug);
  const listed = await session.request({ id: 2, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, manifest.actions.length + 4);
  const productNames = new Set(manifest.actions.map((action) => action.productMcpToolName));
  assert.ok(listed.result.tools.filter((tool) => productNames.has(tool.name)).every((tool) => tool.inputSchema.type === "object"));
  const action = manifest.actions[0];
  const called = await session.request({ id: 3, method: "tools/call", params: { name: action.productMcpToolName, arguments: action.exampleInput } });
  assert.equal(called.result.isError, undefined);
  assert.equal(called.result.structuredContent.result.moduleId, manifest.module.id);
});
`;

const webTestSource = String.raw`import assert from "node:assert/strict";
import test from "node:test";
import { ProductClient } from "../src/client.mjs";
import { manifest } from "../src/manifest.mjs";
import { createProductWebServer } from "../src/web-server.mjs";
import { createFakeApi } from "./helpers/fake-api.mjs";

test("web UI keeps the API token server-side and gates proxy calls", async (context) => {
  const fake = await createFakeApi(manifest.module.id);
  const webKey = "test-product-web-key-0001";
  const server = createProductWebServer({ client: new ProductClient({ baseUrl: fake.url, token: "test-token" }), webKey });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = "http://127.0.0.1:" + address.port;
  context.after(() => Promise.all([
    fake.close(),
    new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  ]));

  const page = await fetch(baseUrl + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(manifest.product.name));
  const publicManifest = await (await fetch(baseUrl + "/manifest")).json();
  assert.equal(publicManifest.module.id, manifest.module.id);
  const denied = await fetch(baseUrl + "/product-api/workspace");
  assert.equal(denied.status, 401);
  const workspace = await fetch(baseUrl + "/product-api/workspace", { headers: { "X-Product-Web-Key": webKey } });
  assert.equal(workspace.status, 200);
  assert.equal((await workspace.json()).id, "workspace-1");
  assert.ok(fake.requests.every((request) => request.authorization === "Bearer test-token"));
});
`;

const demoTestSource = String.raw`import assert from "node:assert/strict";
import test from "node:test";
import { DemoProductClient } from "../src/demo-client.mjs";
import { manifest } from "../src/manifest.mjs";

test("sample workspace exercises every declared product action", async () => {
  const client = new DemoProductClient();
  const workspace = await client.workspace();
  assert.equal(workspace.demo, true);
  assert.deepEqual(workspace.workspace.enabledModuleIds, [manifest.module.id]);
  const initial = await client.listRecords({ limit: 200 });
  assert.ok(initial.records.length > 0);
  for (const action of manifest.actions) {
    const result = await client.runAction(action.id, action.exampleInput);
    assert.equal(result.action.id, action.id);
    assert.equal(result.demo, true);
  }
  const final = await client.listRecords({ limit: 200 });
  assert.ok(final.records.length >= initial.records.length);
});

test("every declared action output type is available through record filtering", async () => {
  const client = new DemoProductClient();
  const outputTypes = new Set(manifest.actions.map((action) => action.recordType).filter(Boolean));
  for (const recordType of outputTypes) {
    assert.ok(manifest.module.recordTypes.includes(recordType));
    const result = await client.listRecords({ recordType, limit: 200 });
    assert.ok(Array.isArray(result.records));
  }
});
`;

const uiTestSource = String.raw`import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { manifest } from "../src/manifest.mjs";

test("product UI exposes overview, records, workflows, AI, settings, and guided forms", async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/styles.css", import.meta.url), "utf8"),
  ]);
  for (const view of ["overview", "records", "workflows", "ai", "settings"]) {
    assert.match(html, new RegExp("data-view=\\\"" + view + "\\\""));
    assert.match(html, new RegExp("id=\\\"view-" + view + "\\\""));
  }
  assert.match(html, /id="action-form"/);
  assert.match(app, /function createField/);
  assert.match(app, /manifest\.experience\.workflowGroups/);
  assert.doesNotMatch(html, /<body[^>]+style=/);
  assert.match(css, new RegExp("--accent:\\s*" + manifest.product.accent.replace("#", "\\#"), "i"));
  assert.match(css, /grid-auto-flow:\s*dense/);
});
`;

const verifyManifestSource = String.raw`import assert from "node:assert/strict";
import { manifest } from "../src/manifest.mjs";
import { validateInput } from "../src/validation.mjs";

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.release.backendRelease, "${sourceRelease}");
assert.equal(manifest.release.backendCommit, "${sourceCommit}");
assert.equal(manifest.release.backendSourceSnapshotSha256, "${sourceSnapshotSha256}");
assert.ok(manifest.actions.length > 0);
assert.ok(manifest.actions.every((action) => action.moduleId === manifest.module.id));
assert.equal(new Set(manifest.actions.map((action) => action.id)).size, manifest.actions.length);
assert.equal(new Set(manifest.actions.map((action) => action.productMcpToolName)).size, manifest.actions.length);
assert.ok(manifest.actions.every((action) => action.inputSchema?.type === "object" && action.inputSchema.additionalProperties === false));
assert.ok(manifest.actions.every((action) => !action.recordType || manifest.module.recordTypes.includes(action.recordType)), "Every action output record type must be listable by web, CLI, and MCP clients.");
assert.equal(manifest.experience.primaryActionId, manifest.actions.find((action) => action.id === manifest.experience.primaryActionId)?.id);
assert.ok(manifest.experience.workflowGroups.flatMap((group) => group.actionIds).length === manifest.actions.length, "Every action must appear in exactly one guided workflow group.");
if (manifest.actions.find((action) => action.id === manifest.experience.primaryActionId)?.operation === "create") {
  assert.ok(manifest.experience.workflowGroups.find((group) => group.name === "Create and capture")?.actionIds.includes(manifest.experience.primaryActionId), "A primary create action must lead the Create and capture workflow group.");
}
for (const action of manifest.actions) validateInput(action.inputSchema, action.exampleInput, "actions." + action.id + ".exampleInput");
process.stdout.write(manifest.product.name + ": " + manifest.actions.length + " pinned typed actions verified.\n");
`;

const verifyScreenshotSource = String.raw`import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { manifest } from "../src/manifest.mjs";

const path = new URL("../docs/product-workspace.png", import.meta.url);
const image = await readFile(path);
assert.ok(image.length > 50_000, "The product screenshot must be a real rendered PNG larger than 50 KB.");
assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "The product screenshot must have a valid PNG signature.");
const width = image.readUInt32BE(16);
const height = image.readUInt32BE(20);
assert.equal(width, 1440, "The product screenshot width must be exactly 1440 pixels.");
assert.equal(height, 1000, "The product screenshot height must be exactly 1000 pixels.");
process.stdout.write(manifest.product.name + ": verified " + width + "x" + height + " product screenshot.\n");
`;

const mitLicense = `MIT License

Copyright (c) 2026 Rohan Arun and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function readme(product, module, manifest) {
  const prefix = manifest.product.environmentPrefix;
  const actionRows = manifest.actions.map((action) => `| \`${action.id}\` | ${action.title} | \`${action.requiredScope}\` | \`${action.operation}\` |`).join("\n");
  return `# ${product.name}

${product.tagline}

${product.name} is a focused, public MIT distribution for the \`${module.id}\` module in [managed-oss-cloud](https://github.com/rohanarun/managed-oss-cloud). It includes a product web UI, a product-scoped HTTP client, the \`${product.command}\` CLI, and a stdio MCP server exposing only this product's ${manifest.actions.length} typed actions.

![${product.name} sample workspace](./docs/product-workspace.png)

## Product v1 boundary

This release is declared-action complete: every typed action in this repository's product manifest is exposed through guided schema-driven browser forms with durable record browsing, workflow groups, AI proposal surfaces, connection settings, CLI parity, and MCP parity. The screenshot above is captured from the actual application in its visibly labeled local sample-workspace mode.

That boundary does not claim feature parity with any unrelated mature third-party product. Provider adapters, external delivery, customer-selected storage, legal review, and other category-specific stop lines remain explicit in the [suite acceptance matrix](https://github.com/rohanarun/managed-oss-cloud/blob/main/docs/product-v1-acceptance.md).

## Current boundary

This repository is runnable, but it is intentionally not a second database server. Authentication, workspace isolation, shared PostgreSQL storage, plan enforcement, AI execution, and audit records remain behind the managed-oss-cloud API. This product receives a scoped API token and cannot receive database credentials or run database migrations.

- Hosted backend: \`https://cloud.getsupers.com\`
- Self-hosted backend: any compatible managed-oss-cloud ${sourceRelease} deployment
- Hosted minimum plan: \`${module.minPlan}\`
- Resource class: \`${module.resourceClass}\`
- Pinned backend source: [${sourceRelease}](https://github.com/rohanarun/managed-oss-cloud/tree/${sourceRelease}) at \`${sourceCommit}\`

## AI-native by construction

${module.aiCapabilities.map((capability) => `- ${capability}`).join("\n")}

AI actions use their own \`ai\` token scope, preserve the typed action contract, and return durable backend job evidence. They do not grant the model database credentials or bypass approval, plan, tenant, or action boundaries.

## Run the CLI

Node.js 20 or newer is the only local dependency.

\`\`\`bash
npm install
npm link
export ${prefix}_TOKEN="a-scoped-workspace-token"
export ${prefix}_URL="https://cloud.getsupers.com"
${product.command} actions
${product.command} workspace
${product.command} action ${manifest.actions[0].id} '${JSON.stringify(manifest.actions[0].exampleInput)}'
\`\`\`

The generic \`SUPERSUITE_TOKEN\` and \`SUPERSUITE_URL\` variables are supported as fallbacks. Create a token in the workspace dashboard with only the \`read\`, \`write\`, and/or \`ai\` scopes the client needs.

## Run the web UI

The UI proxies requests through the local Node server so the workspace API token is never sent to the browser. Browser access is protected by a separate key of at least 24 characters.

\`\`\`bash
export ${prefix}_TOKEN="a-scoped-workspace-token"
export ${prefix}_URL="https://cloud.getsupers.com"
export ${prefix}_WEB_KEY="a-separate-random-browser-key"
npm start
\`\`\`

Open \`http://127.0.0.1:4173\`. Put the service behind TLS and an authenticated reverse proxy before exposing it to a network.

To explore the complete product UI without a backend account, start the clearly labeled local sample workspace:

\`\`\`bash
npm run demo
\`\`\`

Open \`http://127.0.0.1:4173\` and connect with \`sample-workspace-key-2026\`. Sample mode is only a UI fixture; backend and persistence acceptance is tested separately against managed-oss-cloud.

Docker runs the same server:

\`\`\`bash
docker build -t ${product.slug}:${generatedVersion} .
docker run --rm -p 4173:4173 \\
  -e ${prefix}_TOKEN \\
  -e ${prefix}_URL \\
  -e ${prefix}_WEB_KEY \\
  ${product.slug}:${generatedVersion}
\`\`\`

## Connect the MCP server

The MCP server uses newline-delimited JSON-RPC over stdio and implements \`initialize\`, \`ping\`, \`tools/list\`, and \`tools/call\`. It advertises four product utilities plus the ${manifest.actions.length} product action tools with their pinned JSON input schemas.

\`\`\`json
{
  "mcpServers": {
    "${product.slug}": {
      "command": "${product.command}-mcp",
      "env": {
        "${prefix}_TOKEN": "a-scoped-workspace-token",
        "${prefix}_URL": "https://cloud.getsupers.com"
      }
    }
  }
}
\`\`\`

## Self-host the backend

\`\`\`bash
git clone https://github.com/rohanarun/managed-oss-cloud.git
cd managed-oss-cloud
git checkout ${sourceRelease}
# Follow that repository's PostgreSQL, migration, TLS, and runtime instructions.
\`\`\`

Then point \`${prefix}_URL\` at the self-hosted control-plane origin. All products may share the same backend and PostgreSQL cluster while the backend preserves workspace and module boundaries.

## Typed action catalogue

| Action ID | Capability | Token scope | Operation |
|---|---|---|---|
${actionRows}

The complete machine-readable module definition, JSON input schemas, MCP tool names, examples, and release provenance are pinned in [product-manifest.json](./product-manifest.json).

## Clean-room statement

${manifest.cleanRoom.statement} Public category behavior informed the requirements, but the product name, implementation, UI, CLI, MCP surface, tests, and documentation in this repository are original. No third-party product source code, assets, copied interface, trademarks, or branding are included.

## Security

- Use a distinct, least-privilege workspace API token per deployment.
- Never place the API token in browser code, Git history, container images, or logs.
- Keep the web server on loopback unless it is behind TLS and authentication.
- Rotate a token immediately if it is exposed.
- Treat AI output as a proposal unless the action contract explicitly records approval and execution boundaries.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting and the trust boundary.

## Development

\`\`\`bash
npm test
npm run verify
npm run verify:screenshot
npm pack --dry-run
\`\`\`

The repository tests prove bearer authentication, fixed module routing, input validation, every declared action's HTTP/CLI/MCP registration, sample-workspace behavior, web-key protection, server-side token handling, and the captured PNG's format and dimensions. Durable backend behavior and tenant isolation remain covered by managed-oss-cloud's PostgreSQL and application acceptance suites.

## License

[MIT](./LICENSE)
`;
}

function security(product) {
  return `# Security policy

## Supported version

The latest tagged ${product.name} release is supported.

## Trust boundary

This repository never needs direct PostgreSQL access. It sends product-scoped requests to managed-oss-cloud with a bearer token. The backend is responsible for authentication, tenant isolation, plan checks, storage accounting, AI job isolation, and durable audit evidence.

The web server keeps that API token server-side and requires a separate browser access key. Deploy it behind HTTPS and additional access control whenever it is reachable beyond loopback.

## Report a vulnerability

Use GitHub's private security advisory flow for this repository. Do not open a public issue containing tokens, personal data, exploit details, or customer records.
`;
}

function packageJson(product) {
  return {
    name: "@managed-oss/" + product.slug,
    version: generatedVersion,
    description: product.tagline,
    type: "module",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/rohanarun/" + product.slug + ".git" },
    bugs: { url: "https://github.com/rohanarun/" + product.slug + "/issues" },
    homepage: "https://github.com/rohanarun/" + product.slug + "#readme",
    engines: { node: ">=20.11" },
    bin: {
      [product.command]: "src/cli.mjs",
      [product.command + "-mcp"]: "src/mcp.mjs",
    },
    files: ["src", "web", "docs", "product-manifest.json", "LICENSE", "README.md", "SECURITY.md", "Dockerfile"],
    scripts: {
      start: "node src/web-server.mjs",
      demo: "node src/demo-server.mjs",
      test: "node --test --test-concurrency=1",
      verify: "node scripts/verify-manifest.mjs && node --test --test-concurrency=1",
      "verify:screenshot": "node scripts/verify-screenshot.mjs",
    },
  };
}

function dockerfile(product) {
  return `FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app
COPY --chown=node:node package.json product-manifest.json LICENSE README.md SECURITY.md ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web

ENV HOST=0.0.0.0
ENV PORT=4173
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "src/web-server.mjs"]
`;
}

const workflowSource = `name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
      - run: npm test
      - run: npm run verify
      - run: npm run verify:screenshot
      - run: npm pack --dry-run
      - run: docker build --tag product-ci:test .
`;

async function writeProductRepository(root, product, force) {
  const module = suiteModules.find((candidate) => candidate.id === product.moduleId);
  if (!module) throw new Error("Unknown source module: " + product.moduleId);
  const actions = suiteActionsByModule.get(module.id) ?? [];
  if (actions.length === 0) throw new Error("No actions found for module: " + module.id);
  if (actions.some((action) => {
    const schema = suiteActionInputJsonSchema(action);
    return schema.type !== "object" || schema.additionalProperties !== false;
  })) throw new Error("Every generated action must have a closed typed object input schema: " + module.id);
  const target = join(root, product.slug);
  if (await exists(target)) {
    if (!force) throw new Error(target + " already exists. Pass --force to replace only this known product directory.");
    await rm(target, { recursive: true, force: false });
  }
  await Promise.all([
    mkdir(join(target, ".github", "workflows"), { recursive: true }),
    mkdir(join(target, "docs"), { recursive: true }),
    mkdir(join(target, "scripts"), { recursive: true }),
    mkdir(join(target, "src"), { recursive: true }),
    mkdir(join(target, "test", "helpers"), { recursive: true }),
    mkdir(join(target, "web"), { recursive: true }),
  ]);
  const manifest = productManifest(product, module, actions);
  const substitutions = {
    PRODUCT_NAME: product.name,
    HEADLINE: manifest.experience.headline,
    TAGLINE: product.tagline,
    ACCENT: product.accent,
    ACCENT_DARK: product.accentDark,
    CATEGORY: module.category,
    PLAN: module.minPlan,
    ACTION_COUNT: String(actions.length),
    MODULE_ID: module.id,
    VERSION: generatedVersion,
  };
  const files = new Map([
    [".dockerignore", ".git\n.github\nnode_modules\nnpm-debug.log\ntest\n"],
    [".gitignore", "node_modules/\n*.tgz\n.env\n.DS_Store\n"],
    [".github/workflows/ci.yml", workflowSource],
    ["Dockerfile", dockerfile(product)],
    ["LICENSE", mitLicense],
    ["README.md", readme(product, module, manifest)],
    ["SECURITY.md", security(product)],
    ["package.json", json(packageJson(product))],
    ["product-manifest.json", json(manifest)],
    ["scripts/verify-manifest.mjs", verifyManifestSource],
    ["scripts/verify-screenshot.mjs", verifyScreenshotSource],
    ["src/cli.mjs", cliSource],
    ["src/client.mjs", clientSource],
    ["src/demo-client.mjs", demoClientSource],
    ["src/demo-server.mjs", demoServerSource],
    ["src/manifest.mjs", manifestSource],
    ["src/mcp.mjs", mcpSource],
    ["src/validation.mjs", validationSource],
    ["src/web-server.mjs", webServerSource],
    ["test/client.test.mjs", clientTestSource],
    ["test/cli.test.mjs", cliTestSource],
    ["test/demo.test.mjs", demoTestSource],
    ["test/helpers/fake-api.mjs", fakeApiSource],
    ["test/mcp.test.mjs", mcpTestSource],
    ["test/ui.test.mjs", uiTestSource],
    ["test/validation.test.mjs", validationTestSource],
    ["test/web.test.mjs", webTestSource],
    ["web/app.js", webAppSource],
    ["web/index.html", render(indexTemplate, substitutions)],
    ["web/styles.css", render(stylesSource, substitutions)],
  ]);
  await Promise.all([...files].map(async ([relativePath, content]) => {
    const path = join(target, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }));
  await Promise.all([chmod(join(target, "src", "cli.mjs"), 0o755), chmod(join(target, "src", "demo-server.mjs"), 0o755), chmod(join(target, "src", "mcp.mjs"), 0o755), chmod(join(target, "src", "web-server.mjs"), 0o755)]);
  return { slug: product.slug, path: target, moduleId: module.id, actions: actions.length };
}

async function main() {
  const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (packageMetadata.version !== "0.4.3") throw new Error("This generator requires managed-oss-cloud package metadata version 0.4.3.");
  if (products.length !== 37 || new Set(products.map((product) => product.moduleId)).size !== 37 || new Set(products.map((product) => product.slug)).size !== 37) {
    throw new Error("The product registry must contain exactly 37 unique products and modules.");
  }
  const sourceSnapshot = products.map((product) => ({
    module: suiteModules.find((module) => module.id === product.moduleId),
    actions: suiteActionsByModule.get(product.moduleId),
  }));
  const actualSourceSnapshotSha256 = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
  if (actualSourceSnapshotSha256 !== sourceSnapshotSha256) {
    throw new Error("The 37-module source snapshot no longer matches managed-oss-cloud " + sourceRelease + ". Refuse to mislabel generated manifests.");
  }
  const only = argumentValue("--only");
  const requestedSlugs = only ? [...new Set(only.split(",").map((slug) => slug.trim()).filter(Boolean))] : products.map((product) => product.slug);
  const unknownSlugs = requestedSlugs.filter((slug) => !products.some((product) => product.slug === slug));
  if (unknownSlugs.length > 0) throw new Error("Unknown product slug(s): " + unknownSlugs.join(", ") + ".");
  if (requestedSlugs.length === 0) throw new Error("--only must include at least one product slug.");
  const selectedProducts = requestedSlugs.map((slug) => products.find((product) => product.slug === slug));
  const outputRoot = resolve(argumentValue("--output") ?? process.env.MANAGED_OSS_PRODUCT_OUTPUT ?? defaultOutputRoot);
  await mkdir(outputRoot, { recursive: true });
  const results = [];
  for (const product of selectedProducts) results.push(await writeProductRepository(outputRoot, product, flag("--force")));
  process.stdout.write(json({ outputRoot, sourceRelease, sourceCommit, sourceSnapshotSha256, products: results, totalActions: results.reduce((sum, product) => sum + product.actions, 0) }));
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});
