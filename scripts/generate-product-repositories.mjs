import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suiteModules } from "../src/shared/suite.ts";
import {
  suiteActionRequiredScope,
  suiteActionsByModule,
  suiteActionToolName,
} from "../src/shared/suite-actions.ts";

const generatorDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(generatorDirectory, "..");
const defaultOutputRoot = "/Volumes/SP AI 01_16/managed-oss-product-repos";
const sourceRelease = "v0.4.0";
const sourceCommit = "4ff94afc860109e683c56c3acffedb8a6c233e03";
const sourceSnapshotSha256 = "df03dff119034858ec0a25b1171226ff3539d015318c15b5a2359eab49118dcf";
const generatedVersion = "0.1.0";

const products = [
  { slug: "pulseflow", command: "pulseflow", moduleId: "automate", name: "PulseFlow", tagline: "Governed automations with typed triggers, approvals, retries, and explainable AI repair.", accent: "#16d9b3", accentDark: "#087f6d" },
  { slug: "signaldeck", command: "signaldeck", moduleId: "publish", name: "SignalDeck", tagline: "Plan, approve, publish, and explain multi-channel campaigns from one evidence trail.", accent: "#6ea8ff", accentDark: "#285eb5" },
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

function productManifest(product, module, actions) {
  const mcpPrefix = product.slug.replaceAll("-", "_");
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
      recordTypes: module.recordTypes,
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
    actions: actions.map((action) => ({
      ...action,
      inputSchema: action.inputSchema,
      requiredScope: suiteActionRequiredScope(action),
      backendMcpToolName: suiteActionToolName(action),
      productMcpToolName: mcpPrefix + "_" + action.id.replaceAll("-", "_"),
      productCliExample: product.command + " action " + action.id + " '" + JSON.stringify(action.exampleInput ?? sampleForSchema(action.inputSchema)) + "'",
      exampleInput: action.exampleInput ?? sampleForSchema(action.inputSchema),
    })),
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
      for (const key of schema.required ?? []) {
        if (!(key in value)) fail(path + "." + key, "is required.");
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(value)) if (!allowed.has(key)) fail(path + "." + key, "is not permitted.");
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
          "Cache-Control": file === "index.html" ? "no-store" : "public, max-age=300",
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
  const server = createProductWebServer({ client: clientFromEnvironment(env), webKey: webKeyFromEnvironment(env) });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(manifest.product.name + " web UI listening on http://" + host + ":" + port + "\n");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWebServer().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
`;

const webAppSource = String.raw`const state = { manifest: null, webKey: sessionStorage.getItem("product-web-key") ?? "" };
const byId = (id) => document.getElementById(id);

function show(value, kind = "neutral") {
  const panel = byId("output");
  panel.dataset.kind = kind;
  panel.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function api(path, options = {}, authenticated = true) {
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (authenticated) headers.set("X-Product-Web-Key", state.webKey);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed with HTTP " + response.status + ".");
  return body;
}

function actionOption(action) {
  const option = document.createElement("option");
  option.value = action.id;
  option.textContent = action.title + " [" + action.requiredScope + "]";
  return option;
}

function selectAction() {
  const action = state.manifest.actions.find((item) => item.id === byId("action").value);
  byId("action-description").textContent = action.description;
  byId("action-input").value = JSON.stringify(action.exampleInput ?? {}, null, 2);
}

function renderManifest(manifest) {
  state.manifest = manifest;
  document.title = manifest.product.name;
  byId("product-name").textContent = manifest.product.name;
  byId("tagline").textContent = manifest.product.tagline;
  byId("category").textContent = manifest.module.category;
  byId("plan").textContent = manifest.module.minimumHostedPlan;
  byId("action-count").textContent = String(manifest.actions.length);
  byId("module-id").textContent = manifest.module.id;
  byId("action").replaceChildren(...manifest.actions.map(actionOption));
  selectAction();
}

async function connect() {
  state.webKey = byId("web-key").value;
  sessionStorage.setItem("product-web-key", state.webKey);
  const workspace = await api("/product-api/workspace");
  byId("connection-state").textContent = "Connected";
  byId("connection-state").dataset.connected = "true";
  show(workspace, "success");
}

async function runAction() {
  let input;
  try { input = JSON.parse(byId("action-input").value); } catch { throw new Error("Action input must be valid JSON."); }
  show("Running action...");
  const result = await api("/product-api/actions/" + encodeURIComponent(byId("action").value), { method: "POST", body: JSON.stringify({ input }) });
  show(result, "success");
}

async function invoke(work) {
  try { await work(); } catch (error) { show(error instanceof Error ? error.message : String(error), "error"); }
}

byId("web-key").value = state.webKey;
byId("connect").addEventListener("click", () => invoke(connect));
byId("disconnect").addEventListener("click", () => {
  state.webKey = "";
  sessionStorage.removeItem("product-web-key");
  byId("web-key").value = "";
  byId("connection-state").textContent = "Disconnected";
  byId("connection-state").dataset.connected = "false";
  show("Local browser access cleared.");
});
byId("enable").addEventListener("click", () => invoke(async () => show(await api("/product-api/enable", { method: "POST" }), "success")));
byId("records").addEventListener("click", () => invoke(async () => show(await api("/product-api/records?limit=50"), "success")));
byId("workspace").addEventListener("click", () => invoke(async () => show(await api("/product-api/workspace"), "success")));
byId("action").addEventListener("change", selectAction);
byId("run-action").addEventListener("click", () => invoke(runAction));

invoke(async () => renderManifest(await api("/manifest", {}, false)));
`;

const indexTemplate = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>__PRODUCT_NAME__</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body style="--accent: __ACCENT__; --accent-dark: __ACCENT_DARK__">
  <main>
    <nav>
      <a class="brand" href="/" aria-label="__PRODUCT_NAME__ home"><span class="mark"></span><span id="product-name">__PRODUCT_NAME__</span></a>
      <div class="state"><span class="state-dot"></span><span id="connection-state" data-connected="false">Disconnected</span></div>
    </nav>

    <header>
      <div>
        <p class="eyebrow">PRIVATE BUSINESS WORKSPACE</p>
        <h1 id="tagline">__TAGLINE__</h1>
      </div>
      <dl>
        <div><dt>Category</dt><dd id="category">__CATEGORY__</dd></div>
        <div><dt>Hosted plan</dt><dd id="plan">__PLAN__</dd></div>
        <div><dt>Typed actions</dt><dd id="action-count">__ACTION_COUNT__</dd></div>
        <div><dt>Module</dt><dd id="module-id">__MODULE_ID__</dd></div>
      </dl>
    </header>

    <section class="connection" aria-labelledby="connection-title">
      <div><h2 id="connection-title">Connect this browser</h2><p>The backend API token stays server-side. Enter only the separate web access key configured for this UI.</p></div>
      <div class="connection-controls">
        <label for="web-key">Web access key</label>
        <input id="web-key" type="password" autocomplete="current-password" placeholder="At least 24 characters">
        <button id="connect" class="primary">Connect</button>
        <button id="disconnect" class="quiet">Clear</button>
      </div>
    </section>

    <section class="workspace-grid">
      <article>
        <div class="article-heading"><div><h2>Workspace</h2><p>Inspect or enable the product-scoped module.</p></div></div>
        <div class="button-row"><button id="workspace">Read workspace</button><button id="enable">Enable product</button><button id="records">List records</button></div>
      </article>
      <article class="action-card">
        <div class="article-heading"><div><h2>Typed action</h2><p id="action-description"></p></div></div>
        <label for="action">Action</label>
        <select id="action"></select>
        <label for="action-input">JSON input</label>
        <textarea id="action-input" spellcheck="false"></textarea>
        <button id="run-action" class="primary">Run scoped action</button>
      </article>
      <article class="output-card">
        <div class="article-heading"><div><h2>Result</h2><p>API responses and validation failures appear here.</p></div></div>
        <pre id="output" data-kind="neutral">Connect to read the workspace.</pre>
      </article>
    </section>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
`;

const stylesSource = String.raw`* { box-sizing: border-box; }
:root { font-family: Geist, "Helvetica Neue", Arial, sans-serif; color: #f5f7fa; background: #0b0e13; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 78% 0%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 34rem), #0b0e13; }
button, input, select, textarea { font: inherit; }
button { border: 1px solid #3a424f; border-radius: 0.7rem; padding: 0.72rem 1rem; color: #f5f7fa; background: #171c24; cursor: pointer; transition: transform 160ms ease, border-color 160ms ease, background 160ms ease; }
button:hover { transform: translateY(-1px); border-color: var(--accent); }
button.primary { border-color: var(--accent); color: #06120f; background: var(--accent); font-weight: 750; }
button.quiet { background: transparent; }
input, select, textarea { width: 100%; border: 1px solid #343c48; border-radius: 0.7rem; color: #f5f7fa; background: #0d1117; padding: 0.78rem 0.88rem; }
textarea { min-height: 15rem; resize: vertical; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.83rem; line-height: 1.55; }
label { display: block; margin: 1rem 0 0.45rem; color: #aeb7c5; font-size: 0.82rem; font-weight: 650; }
main { width: min(1480px, calc(100% - 2rem)); margin: 0 auto; padding: 1rem 0 5rem; }
nav { position: sticky; top: 1rem; z-index: 3; display: flex; justify-content: space-between; align-items: center; width: min(920px, 100%); margin: 0 auto; padding: 0.8rem 1rem; border: 1px solid #2c333e; border-radius: 1rem; background: rgba(14, 18, 24, 0.82); backdrop-filter: blur(18px); }
.brand { display: flex; align-items: center; gap: 0.7rem; color: inherit; text-decoration: none; font-weight: 780; letter-spacing: -0.02em; }
.mark { width: 1.05rem; height: 1.05rem; border-radius: 0.3rem; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); box-shadow: 0 0 1.6rem color-mix(in srgb, var(--accent) 55%, transparent); }
.state { display: flex; align-items: center; gap: 0.45rem; color: #9aa5b3; font-size: 0.82rem; }
.state-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #5e6672; }
.state:has([data-connected="true"]) .state-dot { background: var(--accent); box-shadow: 0 0 0.75rem var(--accent); }
header { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(20rem, 0.8fr); gap: 5rem; align-items: end; padding: 8rem 2rem 6rem; }
.eyebrow { margin: 0 0 1.2rem; color: var(--accent); font-size: 0.76rem; font-weight: 760; letter-spacing: 0.18em; }
h1 { max-width: 62rem; margin: 0; font-size: clamp(2.7rem, 6.5vw, 6.3rem); line-height: 0.97; letter-spacing: -0.06em; }
h2 { margin: 0; font-size: 1.22rem; letter-spacing: -0.025em; }
p { color: #929ca9; line-height: 1.55; }
dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: 0; overflow: hidden; border: 1px solid #303743; border-radius: 1rem; background: #303743; }
dl div { padding: 1rem; background: #11161d; }
dt { color: #7f8997; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; }
dd { margin: 0.35rem 0 0; font-weight: 680; }
.connection { display: grid; grid-template-columns: 1fr minmax(26rem, 0.8fr); gap: 3rem; align-items: end; padding: 2rem; border: 1px solid color-mix(in srgb, var(--accent) 35%, #303743); border-radius: 1.2rem; background: linear-gradient(120deg, color-mix(in srgb, var(--accent) 9%, #12171e), #10141a); }
.connection p, .article-heading p { margin: 0.55rem 0 0; }
.connection-controls { display: grid; grid-template-columns: 1fr auto auto; gap: 0.55rem; align-items: end; }
.connection-controls label { grid-column: 1 / -1; margin-top: 0; }
.workspace-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-top: 1rem; }
article { min-width: 0; padding: 1.5rem; border: 1px solid #2b323d; border-radius: 1.2rem; background: rgba(16, 20, 27, 0.88); }
.action-card { grid-row: span 2; }
.output-card { min-height: 24rem; }
.button-row { display: flex; flex-wrap: wrap; gap: 0.65rem; margin-top: 1.5rem; }
pre { min-height: 17rem; margin: 1.25rem 0 0; overflow: auto; border-radius: 0.8rem; padding: 1rem; color: #d7dce5; background: #080b0f; font-size: 0.79rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
pre[data-kind="success"] { border-left: 3px solid var(--accent); }
pre[data-kind="error"] { border-left: 3px solid #ff625f; color: #ffb2b0; }
@media (max-width: 900px) { header, .connection, .workspace-grid { grid-template-columns: 1fr; } header { gap: 2.5rem; padding: 6rem 0 4rem; } .connection-controls { grid-template-columns: 1fr 1fr; } .connection-controls input { grid-column: 1 / -1; } .action-card { grid-row: auto; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
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
  assert.equal(manifest.release.backendRelease, "v0.4.0");
  assert.equal(manifest.release.backendCommit, "4ff94afc860109e683c56c3acffedb8a6c233e03");
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

const verifyManifestSource = String.raw`import assert from "node:assert/strict";
import { manifest } from "../src/manifest.mjs";
import { validateInput } from "../src/validation.mjs";

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.release.backendRelease, "v0.4.0");
assert.equal(manifest.release.backendCommit, "4ff94afc860109e683c56c3acffedb8a6c233e03");
assert.equal(manifest.release.backendSourceSnapshotSha256, "df03dff119034858ec0a25b1171226ff3539d015318c15b5a2359eab49118dcf");
assert.ok(manifest.actions.length > 0);
assert.ok(manifest.actions.every((action) => action.moduleId === manifest.module.id));
assert.equal(new Set(manifest.actions.map((action) => action.id)).size, manifest.actions.length);
assert.equal(new Set(manifest.actions.map((action) => action.productMcpToolName)).size, manifest.actions.length);
assert.ok(manifest.actions.every((action) => action.inputSchema?.type === "object" && action.inputSchema.additionalProperties === false));
for (const action of manifest.actions) validateInput(action.inputSchema, action.exampleInput, "actions." + action.id + ".exampleInput");
process.stdout.write(manifest.product.name + ": " + manifest.actions.length + " pinned typed actions verified.\n");
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

## Current boundary

This repository is runnable, but it is intentionally not a second database server. Authentication, workspace isolation, shared PostgreSQL storage, plan enforcement, AI execution, and audit records remain behind the managed-oss-cloud API. This product receives a scoped API token and cannot receive database credentials or run database migrations.

- Hosted backend: \`https://cloud.getsupers.com\`
- Self-hosted backend: any compatible managed-oss-cloud v0.4.0 deployment
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

Docker runs the same server:

\`\`\`bash
docker build -t ${product.slug}:0.1.0 .
docker run --rm -p 4173:4173 \\
  -e ${prefix}_TOKEN \\
  -e ${prefix}_URL \\
  -e ${prefix}_WEB_KEY \\
  ${product.slug}:0.1.0
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

The complete machine-readable module definition, JSON input schemas, MCP tool names, risk metadata, examples, and release provenance are pinned in [product-manifest.json](./product-manifest.json).

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
npm pack --dry-run
\`\`\`

The tests run against a fake API and prove bearer authentication, fixed module routing, input validation, CLI execution, stdio MCP discovery/calls, web-key protection, and server-side token handling.

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
    files: ["src", "web", "product-manifest.json", "LICENSE", "README.md", "SECURITY.md", "Dockerfile"],
    scripts: {
      start: "node src/web-server.mjs",
      test: "node --test --test-concurrency=1",
      verify: "node scripts/verify-manifest.mjs && node --test --test-concurrency=1",
    },
  };
}

function dockerfile(product) {
  return `FROM node:22-alpine

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
      - run: npm run verify
      - run: npm pack --dry-run
      - run: docker build --tag product-ci:test .
`;

async function writeProductRepository(root, product, force) {
  const module = suiteModules.find((candidate) => candidate.id === product.moduleId);
  if (!module) throw new Error("Unknown source module: " + product.moduleId);
  const actions = suiteActionsByModule.get(module.id) ?? [];
  if (actions.length === 0) throw new Error("No actions found for module: " + module.id);
  if (actions.some((action) => !action.inputSchema || action.inputSchema.type !== "object")) throw new Error("Every generated action must have a typed object input schema: " + module.id);
  const target = join(root, product.slug);
  if (await exists(target)) {
    if (!force) throw new Error(target + " already exists. Pass --force to replace only this known product directory.");
    await rm(target, { recursive: true, force: false });
  }
  await Promise.all([
    mkdir(join(target, ".github", "workflows"), { recursive: true }),
    mkdir(join(target, "scripts"), { recursive: true }),
    mkdir(join(target, "src"), { recursive: true }),
    mkdir(join(target, "test", "helpers"), { recursive: true }),
    mkdir(join(target, "web"), { recursive: true }),
  ]);
  const manifest = productManifest(product, module, actions);
  const substitutions = {
    PRODUCT_NAME: product.name,
    TAGLINE: product.tagline,
    ACCENT: product.accent,
    ACCENT_DARK: product.accentDark,
    CATEGORY: module.category,
    PLAN: module.minPlan,
    ACTION_COUNT: String(actions.length),
    MODULE_ID: module.id,
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
    ["src/cli.mjs", cliSource],
    ["src/client.mjs", clientSource],
    ["src/manifest.mjs", manifestSource],
    ["src/mcp.mjs", mcpSource],
    ["src/validation.mjs", validationSource],
    ["src/web-server.mjs", webServerSource],
    ["test/client.test.mjs", clientTestSource],
    ["test/cli.test.mjs", cliTestSource],
    ["test/helpers/fake-api.mjs", fakeApiSource],
    ["test/mcp.test.mjs", mcpTestSource],
    ["test/web.test.mjs", webTestSource],
    ["web/app.js", webAppSource],
    ["web/index.html", render(indexTemplate, substitutions)],
    ["web/styles.css", stylesSource],
  ]);
  await Promise.all([...files].map(async ([relativePath, content]) => {
    const path = join(target, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }));
  await Promise.all([chmod(join(target, "src", "cli.mjs"), 0o755), chmod(join(target, "src", "mcp.mjs"), 0o755), chmod(join(target, "src", "web-server.mjs"), 0o755)]);
  return { slug: product.slug, path: target, moduleId: module.id, actions: actions.length };
}

async function main() {
  const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (packageMetadata.version !== "0.4.0") throw new Error("This generator is pinned to managed-oss-cloud v0.4.0.");
  if (products.length !== 16 || new Set(products.map((product) => product.moduleId)).size !== 16 || new Set(products.map((product) => product.slug)).size !== 16) {
    throw new Error("The product registry must contain exactly 16 unique products and modules.");
  }
  const sourceSnapshot = products.map((product) => ({
    module: suiteModules.find((module) => module.id === product.moduleId),
    actions: suiteActionsByModule.get(product.moduleId),
  }));
  const actualSourceSnapshotSha256 = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
  if (actualSourceSnapshotSha256 !== sourceSnapshotSha256) {
    throw new Error("The 16-module source snapshot no longer matches managed-oss-cloud v0.4.0. Refuse to mislabel generated manifests.");
  }
  const outputRoot = resolve(argumentValue("--output") ?? process.env.MANAGED_OSS_PRODUCT_OUTPUT ?? defaultOutputRoot);
  await mkdir(outputRoot, { recursive: true });
  const results = [];
  for (const product of products) results.push(await writeProductRepository(outputRoot, product, flag("--force")));
  process.stdout.write(json({ outputRoot, sourceRelease, sourceCommit, sourceSnapshotSha256, products: results, totalActions: results.reduce((sum, product) => sum + product.actions, 0) }));
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});
