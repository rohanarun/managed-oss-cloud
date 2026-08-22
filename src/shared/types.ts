export type AppStatus = "ready" | "integration";

export interface CatalogApp {
  id: string;
  name: string;
  replaces: string;
  category: string;
  license: string;
  sourceUrl: string;
  description: string;
  version: string;
  memoryBudgetMb: number;
  bundleEligible: boolean;
  status: AppStatus;
  requirements: string[];
  deploymentNote: string;
}

export interface ComputePlan {
  id: string;
  label: string;
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
  infrastructureMonthlyCents: number;
  platformFeeCents: number;
  totalMonthlyCents: number;
  requiresSplit: boolean;
  explanation: string;
}

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface Installation {
  id: string;
  userId: string;
  appIds: string[];
  name: string;
  plan: string;
  state: "planned" | "awaiting_payment" | "provisioning" | "live" | "failed";
  hostname: string;
  customDomains: string[];
  applications?: ApplicationInstance[];
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationInstance {
  id: string;
  installationId: string;
  appId: string;
  state: "queued" | "provisioning" | "live" | "failed" | "stopped";
  hostname: string;
  containerProject: string;
  customDomains: CustomDomain[];
  lastHealthAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomDomain {
  id: string;
  applicationInstanceId: string;
  domain: string;
  verificationStatus: "awaiting-dns" | "verified" | "active" | "failed";
  lastCheckedAt?: string;
}

export interface ProvisioningJob {
  id: string;
  installationId: string;
  action: "install" | "upgrade" | "stop" | "start" | "uninstall" | "reload-routes" | "backup" | "restore";
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BackupRecord {
  id: string;
  installationId: string;
  applicationInstanceId: string;
  objectName: string;
  sizeBytes: number;
  status: "ready" | "failed";
  createdAt: string;
}

export interface DashboardData {
  user: AccountUser;
  installations: Installation[];
  persistence: "postgres" | "preview-memory";
  billingReady: boolean;
  provisioningMode: "dry-run" | "live";
}
