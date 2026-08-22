import type { CatalogApp, ComputePlan, Quote } from "./types.js";

export interface PricingPolicy {
  plans: ComputePlan[];
  platformFeePercent: number;
  platformFeeMinimumCents: number;
  systemReserveMb: number;
  maximumSafeUtilization: number;
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
    .find((plan) => requestedMemoryMb <= plan.memoryMb * policy.maximumSafeUtilization && requestedCpuMillis <= plan.cpu * 1_000 && requestedStorageGb <= plan.storageGb && apps.length <= plan.maxServices) ?? null;
  const requiresSplit = !compatibleWithBundle || recommendedPlan === null;
  const infrastructureMonthlyCents = recommendedPlan?.infrastructureMonthlyCents ?? 0;
  const percentageFee = Math.ceil(infrastructureMonthlyCents * (policy.platformFeePercent / 100));
  const platformFeeCents = recommendedPlan
    ? Math.max(percentageFee, policy.platformFeeMinimumCents)
    : 0;

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
    totalMonthlyCents: recommendedPlan?.monthlyCents ?? 0,
    requiresSplit,
    explanation: requiresSplit
      ? "This selection includes an isolated workload. It will be separated instead of overloading the shared server."
      : `All selected applications fit the ${recommendedPlan?.label ?? "configured"} server with a safety reserve.`,
  };
}
