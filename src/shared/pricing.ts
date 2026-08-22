import type { CatalogApp, ComputePlan, Quote } from "./types.js";

export interface PricingPolicy {
  plans: ComputePlan[];
  platformFeePercent: number;
  platformFeeMinimumCents: number;
  systemReserveMb: number;
  maximumSafeUtilization: number;
}

function platformFeeFor(plan: ComputePlan, policy: PricingPolicy) {
  return Math.max(Math.ceil(plan.infrastructureMonthlyCents * (policy.platformFeePercent / 100)), policy.platformFeeMinimumCents);
}

function planCanContain(quote: Pick<Quote, "requestedMemoryMb" | "requestedCpuMillis" | "requestedStorageGb" | "selectedApps">, plan: ComputePlan, policy: PricingPolicy) {
  return quote.requestedMemoryMb <= plan.memoryMb * policy.maximumSafeUtilization
    && quote.requestedCpuMillis <= plan.cpu * 1_000
    && quote.requestedStorageGb <= plan.storageGb
    && quote.selectedApps.length <= plan.maxServices;
}

export function buildQuote(apps: CatalogApp[], policy: PricingPolicy): Quote {
  const appMemory = apps.reduce((total, app) => total + app.memoryBudgetMb, 0);
  const requestedCpuMillis = apps.reduce((total, app) => total + app.cpuBudgetMillis, 0);
  const requestedStorageGb = apps.reduce((total, app) => total + app.storageBudgetGb, 0);
  const requestedMemoryMb = appMemory + policy.systemReserveMb;
  const compatibleWithBundle = apps.every((app) => app.bundleEligible);
  const recommendedPlan = policy.plans
    .slice()
    .sort((a, b) => a.memoryMb - b.memoryMb)
    .find((plan) => planCanContain({ requestedMemoryMb, requestedCpuMillis, requestedStorageGb, selectedApps: apps }, plan, policy)) ?? null;
  const requiresSplit = !compatibleWithBundle || recommendedPlan === null;
  const infrastructureMonthlyCents = recommendedPlan?.infrastructureMonthlyCents ?? 0;
  const platformFeeCents = recommendedPlan ? platformFeeFor(recommendedPlan, policy) : 0;

  return {
    selectedApps: apps,
    requestedMemoryMb,
    requestedCpuMillis,
    requestedStorageGb,
    reservedMemoryMb: policy.systemReserveMb,
    compatibleWithBundle,
    recommendedPlan,
    infrastructureMonthlyCents,
    platformFeeCents,
    totalMonthlyCents: infrastructureMonthlyCents + platformFeeCents,
    requiresSplit,
    explanation: requiresSplit
      ? "This selection includes an isolated workload. It will be separated instead of overloading the shared server."
      : `All selected applications fit the ${recommendedPlan?.label ?? "configured"} server with a safety reserve.`,
  };
}

export function buildQuoteForPlan(apps: CatalogApp[], plan: ComputePlan, policy: PricingPolicy): Quote | null {
  const quote = buildQuote(apps, policy);
  if (!planCanContain(quote, plan, policy)) return null;
  const platformFeeCents = platformFeeFor(plan, policy);
  return {
    ...quote,
    recommendedPlan: plan,
    infrastructureMonthlyCents: plan.infrastructureMonthlyCents,
    platformFeeCents,
    totalMonthlyCents: plan.infrastructureMonthlyCents + platformFeeCents,
    explanation: `The selected applications fit the chosen ${plan.label} allocation with its configured safety reserve.`,
  };
}
