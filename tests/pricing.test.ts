import { describe, expect, it } from "vitest";
import { buildQuote } from "../src/shared/pricing";
import type { CatalogApp } from "../src/shared/types";

const lightApp: CatalogApp = { id: "one", name: "One", replaces: "A", category: "Test", license: "MIT", sourceUrl: "https://example.com", description: "Test", version: "1.0.0", memoryBudgetMb: 128, cpuBudgetMillis: 100, storageBudgetGb: 1, bundleEligible: true, status: "ready", requirements: [], deploymentNote: "Test" };
const heavyApp: CatalogApp = { ...lightApp, id: "two", memoryBudgetMb: 640, bundleEligible: false };
const policy = {
  plans: [
    { id: "starter", label: "Starter", memoryMb: 512, cpu: .5, storageGb: 5, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 },
    { id: "standard", label: "Standard", memoryMb: 2048, cpu: 1, storageGb: 20, maxServices: 5, infrastructureMonthlyCents: 2232, monthlyCents: 2500 },
  ],
  platformFeePercent: 12,
  platformFeeMinimumCents: 200,
  systemReserveMb: 128,
  maximumSafeUtilization: .8,
};

describe("buildQuote", () => {
  it("packs a light application into Starter and applies the configured minimum fee", () => {
    const quote = buildQuote([lightApp], policy);
    expect(quote.recommendedPlan?.id).toBe("starter");
    expect(quote.totalMonthlyCents).toBe(700);
    expect(quote.requiresSplit).toBe(false);
  });

  it("keeps the published tier totals exact", () => {
    const tiers = [
      { id: "starter", label: "Starter", memoryMb: 1536, cpu: .5, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 },
      { id: "scale", label: "Scale", memoryMb: 6144, cpu: 2, storageGb: 100, maxServices: 12, infrastructureMonthlyCents: 4464, monthlyCents: 5000 },
      { id: "fleet", label: "Fleet", memoryMb: 24576, cpu: 8, storageGb: 500, maxServices: 50, infrastructureMonthlyCents: 17857, monthlyCents: 20000 },
    ];
    expect(tiers.map((plan) => plan.infrastructureMonthlyCents + Math.max(Math.ceil(plan.infrastructureMonthlyCents * .12), 200))).toEqual(tiers.map((plan) => plan.monthlyCents));
  });

  it("moves a heavy or incompatible application to an isolated service", () => {
    const quote = buildQuote([heavyApp], policy);
    expect(quote.recommendedPlan?.id).toBe("standard");
    expect(quote.requiresSplit).toBe(true);
  });

  it("does not recommend a plan whose CPU quota is too small", () => {
    const cpuHeavy = { ...lightApp, id: "cpu-heavy", cpuBudgetMillis: 750 };
    expect(buildQuote([cpuHeavy], policy).recommendedPlan?.id).toBe("standard");
  });
});
