import { z } from "zod";
import type { ComputePlan } from "../shared/types.js";
import { validatePublicVerificationKey } from "./public-signing.js";

const environmentSchema = z.object({
  PRODUCT_NAME: z.string().default("Managed OSS Cloud"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  PUBLIC_HOST_TARGET: z.string().default("apps.example.com"),
  PROVISIONING_MODE: z.enum(["dry-run", "live"]).default("dry-run"),
  DATABASE_URL: z.string().optional(),
  DATABASE_RUNTIME_URL: z.string().optional(),
  DATABASE_AI_URL: z.string().optional(),
  DATABASE_MIGRATOR_URL: z.string().optional(),
  DATABASE_SSL: z.enum(["true", "false"]).default("true"),
  DATABASE_MIGRATION_MODE: z.enum(["auto", "manual"]).default("auto"),
  BILLING_MODE: z.enum(["disabled", "live"]).default("disabled"),
  SUBSCRIPTION_RECONCILIATION_MODE: z.enum(["disabled", "dry-run", "apply"]).default("disabled"),
  SUBSCRIPTION_RECONCILIATION_INTERVAL_MILLISECONDS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS: z.coerce.number().int().min(300_000).max(604_800_000).default(86_400_000),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  PLAN_CATALOG_JSON: z.string().default(
    '{"starter":{"label":"Starter","memoryMb":1536,"cpu":0.5,"storageGb":10,"maxServices":2,"infrastructureMonthlyCents":500,"monthlyCents":700},"scale":{"label":"Scale","memoryMb":6144,"cpu":2,"storageGb":100,"maxServices":12,"infrastructureMonthlyCents":4464,"monthlyCents":5000},"fleet":{"label":"Fleet","memoryMb":24576,"cpu":8,"storageGb":500,"maxServices":50,"infrastructureMonthlyCents":17857,"monthlyCents":20000}}',
  ),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(12),
  PLATFORM_FEE_MIN_CENTS: z.coerce.number().int().min(0).default(200),
  APPLICATION_MEMORY_SAFETY_RESERVE_MB: z.coerce.number().int().min(0).max(65_536).default(192),
  CUSTOM_DOMAIN_MONTHLY_CENTS: z.coerce.number().int().min(0).default(0),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PLATFORM_IPV4: z.ipv4().optional(),
  PROVISIONING_WORKER: z.enum(["disabled", "docker", "remote"]).default("disabled"),
  PROVISIONING_POLL_MILLISECONDS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  HOST_APPS_ROOT: z.string().default("/opt/managed-oss/apps/workspaces"),
  HOST_CADDY_CONFIG: z.string().default("/opt/managed-oss/config/apps.caddy"),
  PLATFORM_DOCKER_NETWORK: z.string().default("config_default"),
  PLATFORM_CADDY_CONTAINER: z.string().default("config_caddy_1"),
  BACKUP_BUCKET: z.string().optional(),
  BACKUP_KEY_HEX: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  WORKER_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
  GCP_WORKER_IDENTITY_AUDIENCE: z.string().url().optional(),
  GCP_WORKER_IDENTITY_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/).optional(),
  GCP_WORKER_IDENTITY_INSTANCE_NAMES: z.string().max(8_192).optional(),
  GCP_WORKER_IDENTITY_ZONES: z.string().max(2_048).optional(),
  WORKER_NODE_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/).optional(),
  WORKER_NODE_NAME: z.string().min(3).max(100).optional(),
  WORKER_PRIVATE_ADDRESS: z.ipv4().optional(),
  WORKER_MACHINE_TYPE: z.string().min(2).optional(),
  WORKER_CAPACITY_MEMORY_MB: z.coerce.number().int().min(1024).optional(),
  WORKER_CAPACITY_CPU_MILLIS: z.coerce.number().int().min(250).optional(),
  WORKER_CAPACITY_STORAGE_GB: z.coerce.number().int().min(10).optional(),
  WORKER_SYSTEM_RESERVE_MEMORY_MB: z.coerce.number().int().min(256).default(768),
  WORKER_SYSTEM_RESERVE_CPU_MILLIS: z.coerce.number().int().min(100).default(200),
  WORKER_SYSTEM_RESERVE_STORAGE_GB: z.coerce.number().int().min(1).default(15),
  WORKER_LAUNCH_MEMORY_RESERVE_MB: z.coerce.number().int().min(64).max(16_384).default(160),
  WORKER_STORAGE_SCAN_MILLISECONDS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  WORKER_STORAGE_QUOTA_BACKEND: z.enum(["measurement-only", "operator-project-quota"]).default("measurement-only"),
  WORKER_STORAGE_QUOTA_PROOF_COMPLETED: z.enum(["true", "false"]).default("false"),
  WORKER_STORAGE_QUOTA_HELPER: z.string().regex(/^\/[A-Za-z0-9._/-]+$/).optional(),
  WORKER_AGENT_TOKEN_FILE: z.string().default("/opt/managed-oss/agent/token"),
  CONTROL_PLANE_AGENT_URL: z.string().url().optional(),
  GATEWAY_RECONCILER_TOKEN: z.string().min(32).optional(),
  CADDY_ADMIN_URL: z.literal("http://127.0.0.1:2019/load").default("http://127.0.0.1:2019/load"),
  GATEWAY_CONTROL_PLANE_URL: z.string().url().default("http://control-plane:8787"),
  GATEWAY_POLL_MILLISECONDS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  CONTROL_PLANE_DOMAIN: z.string().optional(),
  CONTROL_PLANE_UPSTREAM: z.string().default("control-plane:8787"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(10).optional(),
  GOOGLE_OAUTH_STATE_SECRET: z.string().min(32).optional(),
  GOOGLE_OAUTH_CALLBACK_URL: z.string().url().optional(),
  GOOGLE_OAUTH_BROKER_START_URL: z.string().url().optional(),
  GOOGLE_OAUTH_ASSERTION_SIGNING_PRIVATE_KEY: z.string().min(64).optional(),
  GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY: z.string().min(40).optional(),
  CONSENT_POLICY_SIGNING_PRIVATE_KEY: z.string().min(64).optional(),
  CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS_JSON: z.string().default("[]"),
  EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET: z.string().min(32).optional(),
  AI_MODE: z.enum(["disabled", "openai-compatible"]).default("disabled"),
  AI_BASE_URL: z.string().url().default("http://127.0.0.1:11434/v1"),
  AI_MODEL: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).default("qwen3:4b"),
  AI_API_KEY: z.string().max(4_096).optional(),
  AI_POLL_MILLISECONDS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  AI_REQUEST_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(1_000).max(300_000).default(90_000),
  SUITE_ENTITLEMENT_MODE: z.enum(["hosted", "unrestricted"]).default("hosted"),
  HOSTING_ENTITLEMENT_MODE: z.enum(["hosted", "unrestricted"]).default("hosted"),
}).superRefine((value, context) => {
  if (value.BILLING_MODE === "live" && (value.WORKER_STORAGE_QUOTA_BACKEND !== "operator-project-quota" || value.WORKER_STORAGE_QUOTA_PROOF_COMPLETED !== "true")) context.addIssue({ code: "custom", path: ["WORKER_STORAGE_QUOTA_BACKEND"], message: "Live billing requires an operator-provisioned hard project-quota backend and a completed quota proof." });
  if (value.PROVISIONING_WORKER === "remote" && value.WORKER_STORAGE_QUOTA_BACKEND === "operator-project-quota" && !value.WORKER_STORAGE_QUOTA_HELPER) context.addIssue({ code: "custom", path: ["WORKER_STORAGE_QUOTA_HELPER"], message: "A remote worker using operator project quotas requires an absolute quota helper path." });
  const workerIdentityFields = [value.GCP_WORKER_IDENTITY_AUDIENCE, value.GCP_WORKER_IDENTITY_PROJECT_ID, value.GCP_WORKER_IDENTITY_INSTANCE_NAMES, value.GCP_WORKER_IDENTITY_ZONES];
  if (workerIdentityFields.some(Boolean) && !workerIdentityFields.every(Boolean)) context.addIssue({ code: "custom", path: ["GCP_WORKER_IDENTITY_AUDIENCE"], message: "GCP worker identity audience, project, instance names, and zones must be configured together." });
  if (value.GCP_WORKER_IDENTITY_AUDIENCE && !value.GCP_WORKER_IDENTITY_AUDIENCE.startsWith("https://")) context.addIssue({ code: "custom", path: ["GCP_WORKER_IDENTITY_AUDIENCE"], message: "GCP worker identity audience must use HTTPS." });
  const tenantBrokerFields = [value.GOOGLE_OAUTH_BROKER_START_URL, value.GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY];
  if (tenantBrokerFields.some(Boolean) && !tenantBrokerFields.every(Boolean)) context.addIssue({ code: "custom", path: ["GOOGLE_OAUTH_BROKER_START_URL"], message: "Managed Google OAuth broker URL and assertion public key must be configured together." });
  const controlBrokerFields = [value.GOOGLE_OAUTH_CLIENT_ID, value.GOOGLE_OAUTH_CLIENT_SECRET, value.GOOGLE_OAUTH_STATE_SECRET, value.GOOGLE_OAUTH_CALLBACK_URL, value.GOOGLE_OAUTH_BROKER_START_URL, value.GOOGLE_OAUTH_ASSERTION_SIGNING_PRIVATE_KEY, value.GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY];
  if (controlBrokerFields.slice(0, 4).concat(controlBrokerFields.slice(5, 6)).some(Boolean) && !controlBrokerFields.every(Boolean)) context.addIssue({ code: "custom", path: ["GOOGLE_OAUTH_CLIENT_ID"], message: "The hosting-layer Google OAuth broker credentials, URLs, and assertion key pair must be configured together." });
  for (const [name, candidate, pathname] of [["GOOGLE_OAUTH_CALLBACK_URL", value.GOOGLE_OAUTH_CALLBACK_URL, "/oauth/google/callback"], ["GOOGLE_OAUTH_BROKER_START_URL", value.GOOGLE_OAUTH_BROKER_START_URL, "/oauth/google/start"]] as const) {
    if (!candidate) continue;
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== pathname || url.search || url.hash) context.addIssue({ code: "custom", path: [name], message: `${name} must be an exact HTTPS ${pathname} URL without credentials, non-default port, query, or fragment.` });
  }
  if (value.AI_MODE !== "openai-compatible") return;
  const endpoint = new URL(value.AI_BASE_URL);
  if (!endpoint.pathname.replace(/\/+$/, "").endsWith("/v1")) context.addIssue({ code: "custom", path: ["AI_BASE_URL"], message: "AI_BASE_URL must end in /v1 for the OpenAI-compatible worker." });
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) context.addIssue({ code: "custom", path: ["AI_BASE_URL"], message: "AI_BASE_URL must not embed credentials, query parameters, or fragments." });
  if (["0.0.0.0", "[::]"].includes(endpoint.hostname)) context.addIssue({ code: "custom", path: ["AI_BASE_URL"], message: "AI_BASE_URL must identify a reachable host, not a wildcard bind address." });
});

export function parseRuntimeEnvironment(environment: NodeJS.ProcessEnv) {
  return environmentSchema.parse(environment);
}

const raw = parseRuntimeEnvironment(process.env);
const consentPolicyPreviousPublicKeys = z.array(z.unknown()).max(20).parse(JSON.parse(raw.CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS_JSON)).map(validatePublicVerificationKey);
if (new Set(consentPolicyPreviousPublicKeys.map((key) => key.keyId)).size !== consentPolicyPreviousPublicKeys.length) throw new Error("Previous public signing key IDs must be unique.");
const planRecord = z.record(
  z.string(),
  z.object({ label: z.string(), memoryMb: z.number().positive(), cpu: z.number().positive(), storageGb: z.number().int().positive().default(10), maxServices: z.number().int().positive().default(2), infrastructureMonthlyCents: z.number().int().min(0).default(0), monthlyCents: z.number().int().min(0) }),
).parse(JSON.parse(raw.PLAN_CATALOG_JSON));

for (const plan of Object.values(planRecord)) {
  const platformFeeCents = Math.max(Math.ceil(plan.infrastructureMonthlyCents * (raw.PLATFORM_FEE_PERCENT / 100)), raw.PLATFORM_FEE_MIN_CENTS);
  if (plan.monthlyCents !== plan.infrastructureMonthlyCents + platformFeeCents) throw new Error(`Plan ${plan.label} monthly total does not match its infrastructure and management fee components.`);
}

export const config = {
  ...raw,
  CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS: consentPolicyPreviousPublicKeys,
  plans: Object.entries(planRecord).map<ComputePlan>(([id, plan]) => ({ id, ...plan })),
};
