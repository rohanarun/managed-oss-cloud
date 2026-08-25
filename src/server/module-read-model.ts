import {
  suiteModuleReadModelVersion,
  suiteRecordPageDefaultLimit,
  suiteRecordPageMaxLimit,
  type SuiteModuleReadCapabilities,
  type SuiteModuleRecordPageProjection,
  type SuiteRecordDetail,
  type SuiteRecordPageInput,
} from "../shared/module-read-model.js";
import {
  suiteModuleById,
  type SuiteModuleDefinition,
  type SuiteRecord,
} from "../shared/suite.js";
import type { SuiteStore } from "./suite-store.js";
import { suiteRecordSummary } from "./suite-record-page.js";

type ModulePageInput = Omit<SuiteRecordPageInput, "moduleId">;
type ModuleReadStore = Pick<SuiteStore, "getRecord" | "listRecordPage">;

export class SuiteModuleReadModelError extends Error {
  readonly code = "unknown_suite_module";

  constructor(moduleId: string) {
    super(`Unknown suite module: ${moduleId}.`);
    this.name = "SuiteModuleReadModelError";
  }
}

function moduleDefinition(moduleId: string) {
  const module = suiteModuleById.get(moduleId);
  if (!module) throw new SuiteModuleReadModelError(moduleId);
  return module;
}

export function projectSuiteModuleReadCapabilities(module: SuiteModuleDefinition): SuiteModuleReadCapabilities {
  return {
    version: suiteModuleReadModelVersion,
    moduleId: module.id,
    name: module.name,
    category: module.category,
    recordTypes: [...module.recordTypes],
    aiCapabilities: [...module.aiCapabilities],
    recordPage: {
      defaultLimit: suiteRecordPageDefaultLimit,
      maxLimit: suiteRecordPageMaxLimit,
      order: "updatedAt-desc-id-desc",
      filters: ["recordType", "state", "titlePrefixOrExactId"],
    },
    recordDetail: true,
  };
}

export function projectSuiteRecordDetail(record: SuiteRecord): SuiteRecordDetail {
  return { ...suiteRecordSummary(record), data: structuredClone(record.data) };
}

/**
 * Application-facing Module Read Model v1 seam. HTTP routing can be added
 * later without coupling page, detail, or static capability projection to the
 * transport layer.
 */
export class SuiteModuleReadModelService {
  constructor(private readonly store: ModuleReadStore) {}

  capabilities(moduleId: string) {
    return projectSuiteModuleReadCapabilities(moduleDefinition(moduleId));
  }

  async listRecordPage(userId: string, moduleId: string, input: ModulePageInput): Promise<SuiteModuleRecordPageProjection> {
    const capabilities = this.capabilities(moduleId);
    const page = await this.store.listRecordPage(userId, { ...input, moduleId });
    return { capabilities, ...page };
  }

  async getRecordDetail(userId: string, moduleId: string, recordId: string): Promise<SuiteRecordDetail | undefined> {
    moduleDefinition(moduleId);
    const record = await this.store.getRecord(userId, recordId);
    return record?.moduleId === moduleId ? projectSuiteRecordDetail(record) : undefined;
  }
}

export function createSuiteModuleReadModelService(store: ModuleReadStore) {
  return new SuiteModuleReadModelService(store);
}
