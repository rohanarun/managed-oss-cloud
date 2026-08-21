export type AppStatus = "beta" | "integration";

export interface CatalogApp {
  id: string;
  name: string;
  replaces: string;
  category: string;
  license: string;
  sourceUrl: string;
  description: string;
  memoryBudgetMb: number;
  bundleEligible: boolean;
  status: AppStatus;
}

export interface ComputePlan {
  id: string;
  memoryMb: number;
  cpu: number;
  monthlyCents: number;
}

export interface Quote {
  selectedApps: CatalogApp[];
  requestedMemoryMb: number;
  reservedMemoryMb: number;
  compatibleWithBundle: boolean;
  recommendedPlan: ComputePlan | null;
  renderMonthlyCents: number;
  platformFeeCents: number;
  totalMonthlyCents: number;
  requiresSplit: boolean;
  explanation: string;
}

export interface Installation {
  id: string;
  appIds: string[];
  name: string;
  plan: string;
  state: "planned" | "provisioning" | "live" | "failed";
  hostname: string;
  customDomains: string[];
  createdAt: string;
}
