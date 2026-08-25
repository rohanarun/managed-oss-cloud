import { createHash } from "node:crypto";
import type {
  SuiteRecordPage,
  SuiteRecordPageInput,
  SuiteRecordSummary,
} from "../shared/module-read-model.js";
import { suiteRecordPageMaxLimit } from "../shared/module-read-model.js";
import type { SuiteRecord } from "../shared/suite.js";

const cursorVersion = 1;
const maxCursorLength = 2_048;
const maxFilterLength = 200;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface NormalizedSuiteRecordPageInput {
  moduleId: string;
  recordType?: string;
  state?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface SuiteRecordPageKey {
  updatedAt: string;
  id: string;
}

interface CursorClaims {
  v: typeof cursorVersion;
  f: string;
  u: string;
  i: string;
}

export class SuiteRecordPageInputError extends Error {
  readonly code = "invalid_record_page_input";

  constructor(message: string) {
    super(message);
    this.name = "SuiteRecordPageInputError";
  }
}

export class SuiteRecordPageCursorError extends Error {
  readonly code = "invalid_record_page_cursor";

  constructor() {
    super("The record page cursor is invalid for this query.");
    this.name = "SuiteRecordPageCursorError";
  }
}

function normalizedFilter(name: string, value: unknown, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new SuiteRecordPageInputError(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw new SuiteRecordPageInputError(`${name} is required.`);
    return undefined;
  }
  if (normalized.length > maxFilterLength) throw new SuiteRecordPageInputError(`${name} must be at most ${maxFilterLength} characters.`);
  return normalized;
}

export function normalizeSuiteRecordPageInput(input: SuiteRecordPageInput): NormalizedSuiteRecordPageInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SuiteRecordPageInputError("The record page input must be an object.");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > suiteRecordPageMaxLimit) {
    throw new SuiteRecordPageInputError(`limit must be an integer between 1 and ${suiteRecordPageMaxLimit}.`);
  }
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor || input.cursor.length > maxCursorLength)) {
    throw new SuiteRecordPageCursorError();
  }
  const search = normalizedFilter("search", input.search)?.toLowerCase();
  return {
    moduleId: normalizedFilter("moduleId", input.moduleId, true)!,
    recordType: normalizedFilter("recordType", input.recordType),
    state: normalizedFilter("state", input.state),
    search,
    limit: input.limit,
    cursor: input.cursor,
  };
}

export function suiteRecordPageFingerprint(
  userId: string,
  workspaceId: string,
  input: Pick<NormalizedSuiteRecordPageInput, "moduleId" | "recordType" | "state" | "search">,
) {
  return createHash("sha256").update(JSON.stringify({
    version: cursorVersion,
    userId,
    workspaceId,
    moduleId: input.moduleId,
    recordType: input.recordType ?? null,
    state: input.state ?? null,
    search: input.search ?? null,
    order: "updatedAt-desc-id-desc",
  })).digest("base64url");
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isCursorClaims(value: unknown): value is CursorClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return Object.keys(claims).length === 4
    && claims.v === cursorVersion
    && typeof claims.f === "string"
    && claims.f.length === 43
    && isCanonicalTimestamp(claims.u)
    && typeof claims.i === "string"
    && uuidPattern.test(claims.i);
}

export function decodeSuiteRecordPageCursor(cursor: string | undefined, expectedFingerprint: string): SuiteRecordPageKey | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (!decoded.length || decoded.toString("base64url") !== cursor) throw new SuiteRecordPageCursorError();
    const claims: unknown = JSON.parse(decoded.toString("utf8"));
    if (!isCursorClaims(claims) || claims.f !== expectedFingerprint) throw new SuiteRecordPageCursorError();
    return { updatedAt: claims.u, id: claims.i };
  } catch (error) {
    if (error instanceof SuiteRecordPageCursorError) throw error;
    throw new SuiteRecordPageCursorError();
  }
}

export function encodeSuiteRecordPageCursor(record: SuiteRecordPageKey, fingerprint: string) {
  if (!isCanonicalTimestamp(record.updatedAt) || !uuidPattern.test(record.id) || fingerprint.length !== 43) throw new SuiteRecordPageCursorError();
  const claims: CursorClaims = { v: cursorVersion, f: fingerprint, u: record.updatedAt, i: record.id };
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

export function compareSuiteRecordPageKeys(left: SuiteRecordPageKey, right: SuiteRecordPageKey) {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

export function suiteRecordIsAfterPageCursor(record: SuiteRecordPageKey, cursor: SuiteRecordPageKey | undefined) {
  return !cursor || record.updatedAt < cursor.updatedAt || (record.updatedAt === cursor.updatedAt && record.id < cursor.id);
}

export function suiteRecordMatchesPageInput(record: SuiteRecord, input: NormalizedSuiteRecordPageInput) {
  if (record.moduleId !== input.moduleId) return false;
  if (input.recordType && record.recordType !== input.recordType) return false;
  if (input.state && record.state !== input.state) return false;
  if (input.search && record.id.toLowerCase() !== input.search && !record.title.toLowerCase().startsWith(input.search)) return false;
  return true;
}

export function suiteRecordSummary(record: SuiteRecord): SuiteRecordSummary {
  return {
    id: record.id,
    moduleId: record.moduleId,
    recordType: record.recordType,
    title: record.title,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function suiteRecordPage(
  visibleRecords: SuiteRecord[],
  limit: number,
  fingerprint: string,
): SuiteRecordPage {
  const selected = visibleRecords.slice(0, limit);
  const last = selected.at(-1);
  return {
    records: selected.map(suiteRecordSummary),
    nextCursor: visibleRecords.length > limit && last
      ? encodeSuiteRecordPageCursor(last, fingerprint)
      : undefined,
  };
}
