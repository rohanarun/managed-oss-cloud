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
  RENDER_API_KEY: z.string().optional(),
  RENDER_OWNER_ID: z.string().optional(),
  RENDER_REGION: z.string().default("oregon"),
  PLAN_CATALOG_JSON: z.string().default(
    '{"micro":{"label":"Micro","memoryMb":1024,"cpu":0.25,"monthlyCents":0},"small":{"label":"Small","memoryMb":2048,"cpu":0.5,"monthlyCents":0},"medium":{"label":"Medium","memoryMb":4096,"cpu":1,"monthlyCents":0}}',
  ),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(12),
  PLATFORM_FEE_MIN_CENTS: z.coerce.number().int().min(0).default(200),
  CUSTOM_DOMAIN_MONTHLY_CENTS: z.coerce.number().int().min(0).default(0),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
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
