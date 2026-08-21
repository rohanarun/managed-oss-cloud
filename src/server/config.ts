import { z } from "zod";
import type { ComputePlan } from "../shared/types.js";

const environmentSchema = z.object({
  PRODUCT_NAME: z.string().default("Managed OSS Cloud"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  PROVISIONING_MODE: z.enum(["dry-run", "live"]).default("dry-run"),
  RENDER_API_KEY: z.string().optional(),
  RENDER_OWNER_ID: z.string().optional(),
  RENDER_REGION: z.string().default("oregon"),
  RENDER_PLAN_CATALOG_JSON: z.string().default(
    '{"starter":{"memoryMb":512,"cpu":0.5,"monthlyCents":700},"standard":{"memoryMb":2048,"cpu":1,"monthlyCents":2500}}',
  ),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(12),
  PLATFORM_FEE_MIN_CENTS: z.coerce.number().int().min(0).default(200),
  CUSTOM_DOMAIN_MONTHLY_CENTS: z.coerce.number().int().min(0).default(25),
  SESSION_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

const raw = environmentSchema.parse(process.env);
const planRecord = z.record(
  z.string(),
  z.object({ memoryMb: z.number().positive(), cpu: z.number().positive(), monthlyCents: z.number().int().positive() }),
).parse(JSON.parse(raw.RENDER_PLAN_CATALOG_JSON));

export const config = {
  ...raw,
  plans: Object.entries(planRecord).map<ComputePlan>(([id, plan]) => ({ id, ...plan })),
};
