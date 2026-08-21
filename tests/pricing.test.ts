import { describe, expect, it } from "vitest";
import { buildQuote } from "../src/shared/pricing";
import type { CatalogApp } from "../src/shared/types";

const lightApp: CatalogApp = { id: "one", name: "One", replaces: "A", category: "Test", license: "MIT", sourceUrl: "https://example.com", description: "Test", version: "1.0.0", memoryBudgetMb: 128, bundleEligible: true, status: "ready", requirements: [], deploymentNote: "Test" };
const heavyApp: CatalogApp = { ...lightApp, id: "two", memoryBudgetMb: 640, bundleEligible: false };
const policy = {
  plans: [
    { id: "starter", label: "Starter", memoryMb: 512, cpu: .5, monthlyCents: 700 },
    { id: "standard", label: "Standard", memoryMb: 2048, cpu: 1, monthlyCents: 2500 },
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
    expect(quote.totalMonthlyCents).toBe(900);
    expect(quote.requiresSplit).toBe(false);
  });

  it("moves a heavy or incompatible application to an isolated service", () => {
    const quote = buildQuote([heavyApp], policy);
    expect(quote.recommendedPlan?.id).toBe("standard");
    expect(quote.requiresSplit).toBe(true);
  });
});
