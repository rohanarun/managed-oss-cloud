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
  const requestedMemoryMb = appMemory + policy.systemReserveMb;
  const compatibleWithBundle = apps.every((app) => app.bundleEligible);
  const recommendedPlan = policy.plans
    .slice()
    .sort((a, b) => a.memoryMb - b.memoryMb)
    .find((plan) => requestedMemoryMb <= plan.memoryMb * policy.maximumSafeUtilization) ?? null;
  const requiresSplit = !compatibleWithBundle || recommendedPlan === null;
  const renderMonthlyCents = recommendedPlan?.monthlyCents ?? 0;
  const percentageFee = Math.ceil(renderMonthlyCents * (policy.platformFeePercent / 100));
  const platformFeeCents = renderMonthlyCents
    ? Math.max(percentageFee, policy.platformFeeMinimumCents)
    : 0;

  return {
    selectedApps: apps,
    requestedMemoryMb,
    reservedMemoryMb: policy.systemReserveMb,
    compatibleWithBundle,
    recommendedPlan,
    renderMonthlyCents,
    platformFeeCents,
    totalMonthlyCents: renderMonthlyCents + platformFeeCents,
    requiresSplit,
    explanation: requiresSplit
      ? "This selection contains a heavy or isolated application. The control plane will split it into another service instead of overloading the shared server."
      : `All selected applications fit the ${recommendedPlan?.id ?? "configured"} server within the safety reserve.`,
  };
}
