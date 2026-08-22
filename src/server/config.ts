import { z } from "zod";
import type { ComputePlan } from "../shared/types.js";

const environmentSchema = z.object({
  PRODUCT_NAME: z.string().default("Managed OSS Cloud"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  PUBLIC_HOST_TARGET: z.string().default("apps.example.com"),
  PROVISIONING_MODE: z.enum(["dry-run", "live"]).default("dry-run"),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z.enum(["true", "false"]).default("true"),
  BILLING_MODE: z.enum(["disabled", "live"]).default("disabled"),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  PLAN_CATALOG_JSON: z.string().default(
    '{"micro":{"label":"Micro","memoryMb":1024,"cpu":0.25,"monthlyCents":0},"small":{"label":"Small","memoryMb":2048,"cpu":0.5,"monthlyCents":0},"medium":{"label":"Medium","memoryMb":4096,"cpu":1,"monthlyCents":0}}',
  ),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(12),
  PLATFORM_FEE_MIN_CENTS: z.coerce.number().int().min(0).default(200),
  CUSTOM_DOMAIN_MONTHLY_CENTS: z.coerce.number().int().min(0).default(0),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PLATFORM_IPV4: z.ipv4().optional(),
  PROVISIONING_WORKER: z.enum(["disabled", "docker"]).default("disabled"),
  PROVISIONING_POLL_MILLISECONDS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  HOST_APPS_ROOT: z.string().default("/opt/managed-oss/apps/workspaces"),
  HOST_CADDY_CONFIG: z.string().default("/opt/managed-oss/config/apps.caddy"),
  PLATFORM_DOCKER_NETWORK: z.string().default("config_default"),
  PLATFORM_CADDY_CONTAINER: z.string().default("config_caddy_1"),
  BACKUP_BUCKET: z.string().optional(),
  BACKUP_KEY_HEX: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

const raw = environmentSchema.parse(process.env);
const planRecord = z.record(
  z.string(),
  z.object({ label: z.string(), memoryMb: z.number().positive(), cpu: z.number().positive(), monthlyCents: z.number().int().min(0) }),
).parse(JSON.parse(raw.PLAN_CATALOG_JSON));

export const config = {
  ...raw,
  plans: Object.entries(planRecord).map<ComputePlan>(([id, plan]) => ({ id, ...plan })),
};
