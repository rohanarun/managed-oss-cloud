import type { SuitePlanId } from "./suite.js";

export const suiteStorageAccountingVersion = "suite-storage-object.v1" as const;

export type SuiteStorageSizeSource = "client-registered" | "object-store-head" | "legacy-registered-metadata";

export interface SuiteStorageAccounting {
  version: typeof suiteStorageAccountingVersion;
  state: "retained";
  registeredBytes: number;
  sizeSource: SuiteStorageSizeSource;
  objectStoreVerified: boolean;
}

export interface SuiteStorageObjectRegistration {
  accountingVersion: typeof suiteStorageAccountingVersion;
  moduleId: "drive" | "esign";
  recordType: "file-version" | "document";
  objectRef: string;
  objectVersion: string;
  checksum: string;
  registeredBytes: number;
  sizeSource: SuiteStorageSizeSource;
  objectStoreVerified: boolean;
}

export interface SuiteUsage {
  recordCount: number;
  recordLimit: number;
  aiActionsThisMonth: number;
  aiActionLimit: number;
  registeredStorageBytes: number;
  verifiedStorageBytes: number;
  unverifiedStorageBytes: number;
  retainedStorageObjectCount: number;
  storageLimitBytes: number;
  storageAccountingVersion: typeof suiteStorageAccountingVersion;
  storageUsageAsOf: string;
}

const planQuotas: Record<SuitePlanId, { recordLimit: number; aiActionLimit: number }> = {
  none: { recordLimit: 0, aiActionLimit: 0 },
  starter: { recordLimit: 50_000, aiActionLimit: 1_000 },
  scale: { recordLimit: 500_000, aiActionLimit: 10_000 },
  fleet: { recordLimit: 5_000_000, aiActionLimit: 100_000 },
};

export const suiteRecordPayloadLimitBytes = 256 * 1024;
export const suiteMaximumRegisteredObjectBytes = 10_000_000_000;

export function suitePlanQuota(plan: SuitePlanId, storageGb: number) {
  return { ...planQuotas[plan], storageLimitBytes: storageGb * 1024 ** 3 };
}

export function suiteStorageAccounting(registeredBytes: number, input: { objectStoreVerified?: boolean; sizeSource?: SuiteStorageSizeSource } = {}): SuiteStorageAccounting {
  if (!Number.isSafeInteger(registeredBytes) || registeredBytes < 1 || registeredBytes > suiteMaximumRegisteredObjectBytes) throw new Error(`Registered object size must be a positive safe integer no larger than ${suiteMaximumRegisteredObjectBytes} bytes.`);
  const objectStoreVerified = input.objectStoreVerified === true;
  const sizeSource = input.sizeSource ?? (objectStoreVerified ? "object-store-head" : "client-registered");
  if (objectStoreVerified && sizeSource !== "object-store-head") throw new Error("Verified object bytes require object-store HEAD evidence.");
  if (!objectStoreVerified && sizeSource === "object-store-head") throw new Error("Object-store HEAD bytes must be marked verified.");
  return { version: suiteStorageAccountingVersion, state: "retained", registeredBytes, sizeSource, objectStoreVerified };
}

function objectData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Retained object metadata needs a storageAccounting object.");
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${label} must be a non-empty bounded string.`);
  return value;
}

function exactChecksum(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function accounting(data: Record<string, unknown>, sizeBytes: unknown) {
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1 || Number(sizeBytes) > suiteMaximumRegisteredObjectBytes) throw new Error(`Retained object sizeBytes must be a positive safe integer no larger than ${suiteMaximumRegisteredObjectBytes}.`);
  const source = objectData(data.storageAccounting);
  if (source.version !== suiteStorageAccountingVersion || source.state !== "retained") throw new Error(`Retained objects require ${suiteStorageAccountingVersion} accounting in retained state.`);
  if (source.registeredBytes !== sizeBytes) throw new Error("Registered object bytes must exactly match immutable sizeBytes metadata.");
  if (!["client-registered", "object-store-head", "legacy-registered-metadata"].includes(String(source.sizeSource))) throw new Error("Retained object sizeSource is invalid.");
  if (typeof source.objectStoreVerified !== "boolean") throw new Error("Retained object metadata must state whether object-store size was verified.");
  if (source.objectStoreVerified === true && source.sizeSource !== "object-store-head") throw new Error("Verified object bytes require object-store HEAD evidence.");
  if (source.objectStoreVerified === false && source.sizeSource === "object-store-head") throw new Error("Object-store HEAD bytes must be marked verified.");
  return {
    registeredBytes: Number(sizeBytes),
    sizeSource: source.sizeSource as SuiteStorageSizeSource,
    objectStoreVerified: source.objectStoreVerified,
  };
}

export function suiteStorageObjectRegistration(moduleId: string, recordType: string, data: Record<string, unknown>): SuiteStorageObjectRegistration | undefined {
  if (moduleId === "drive" && recordType === "file-version") {
    const size = accounting(data, data.sizeBytes);
    const fileId = exactString(data.fileId, "fileId", 100);
    if (!Number.isSafeInteger(data.fileVersionNumber) || Number(data.fileVersionNumber) < 1) throw new Error("Drive fileVersionNumber must be a positive safe integer.");
    return {
      accountingVersion: suiteStorageAccountingVersion,
      moduleId,
      recordType,
      objectRef: exactString(data.objectKey, "objectKey", 1_000),
      objectVersion: `${fileId}:${data.fileVersionNumber}`,
      checksum: exactChecksum(data.checksum, "checksum"),
      ...size,
    };
  }
  if (moduleId === "esign" && recordType === "document") {
    const size = accounting(data, data.sizeBytes);
    return {
      accountingVersion: suiteStorageAccountingVersion,
      moduleId,
      recordType,
      objectRef: exactString(data.objectRef, "objectRef", 512),
      objectVersion: exactString(data.objectVersion, "objectVersion", 200),
      checksum: exactChecksum(data.sha256, "sha256"),
      ...size,
    };
  }
  return undefined;
}

export function suiteRegisteredObjectBytes(moduleId: string, recordType: string, data: Record<string, unknown>) {
  return suiteStorageObjectRegistration(moduleId, recordType, data)?.registeredBytes ?? 0;
}

export function assertSuiteStorageObjectUpdate(input: {
  moduleId: string;
  recordType: string;
  priorTitle: string;
  priorState: string;
  priorData: Record<string, unknown>;
  nextTitle: string;
  nextState: string;
  nextData: Record<string, unknown>;
}) {
  const prior = suiteStorageObjectRegistration(input.moduleId, input.recordType, input.priorData);
  const next = suiteStorageObjectRegistration(input.moduleId, input.recordType, input.nextData);
  if (!prior && !next) return { priorBytes: 0, nextBytes: 0 };
  if (!prior || !next) throw new Error("Retained object accounting can only be created with a new immutable object-version record.");
  const unchanged = input.priorTitle === input.nextTitle
    && input.priorState === input.nextState
    && JSON.stringify(canonical(input.priorData)) === JSON.stringify(canonical(input.nextData))
    && JSON.stringify(canonical(prior)) === JSON.stringify(canonical(next));
  if (!unchanged) throw new Error("Retained object metadata is immutable; size, checksum, object identity, title, and state cannot be overwritten or lowered.");
  return { priorBytes: prior.registeredBytes, nextBytes: next.registeredBytes };
}
