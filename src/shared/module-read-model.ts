export const suiteRecordPageDefaultLimit = 50;
export const suiteRecordPageMaxLimit = 100;
export const suiteModuleReadModelVersion = "module-read-model.v1" as const;

/**
 * Store-level record page input. `search` is deliberately narrow: it matches
 * a case-insensitive title prefix or one exact record ID.
 */
export interface SuiteRecordPageInput {
  moduleId: string;
  recordType?: string;
  state?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

/**
 * A list-safe record projection. Record payload data and workspace identity
 * are intentionally absent; callers must use the scoped detail read for data.
 */
export interface SuiteRecordSummary {
  id: string;
  moduleId: string;
  recordType: string;
  title: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface SuiteRecordDetail extends SuiteRecordSummary {
  data: Record<string, unknown>;
}

export interface SuiteRecordPage {
  records: SuiteRecordSummary[];
  nextCursor?: string;
}

/**
 * Backend-owned read capabilities only. This projection intentionally makes
 * no claim about activity, relationships, export, or deletion readiness.
 */
export interface SuiteModuleReadCapabilities {
  version: typeof suiteModuleReadModelVersion;
  moduleId: string;
  name: string;
  category: string;
  recordTypes: string[];
  aiCapabilities: string[];
  recordPage: {
    defaultLimit: number;
    maxLimit: number;
    order: "updatedAt-desc-id-desc";
    filters: ["recordType", "state", "titlePrefixOrExactId"];
  };
  recordDetail: true;
}

export interface SuiteModuleRecordPageProjection extends SuiteRecordPage {
  capabilities: SuiteModuleReadCapabilities;
}
