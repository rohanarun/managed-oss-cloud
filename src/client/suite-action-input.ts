import type { SuiteActionInputJsonSchema } from "../shared/suite-actions";

export type SuiteActionDraftValue = string | boolean;
export type SuiteActionDraft = Record<string, SuiteActionDraftValue>;

type InputAction = {
  inputSchema: SuiteActionInputJsonSchema;
  exampleInput: Record<string, unknown>;
};

type JsonSchema = Record<string, unknown>;

function nestedSchemas(schema: JsonSchema): JsonSchema[] {
  return Array.isArray(schema.anyOf)
    ? schema.anyOf.filter(
        (candidate): candidate is JsonSchema =>
          Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate),
      )
    : [];
}

export function suiteActionSchemaTypes(schema: JsonSchema): string[] {
  const direct = typeof schema.type === "string" ? [schema.type] : [];
  const nested = nestedSchemas(schema).flatMap(suiteActionSchemaTypes);
  if (direct.length || nested.length) return [...new Set([...direct, ...nested])];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return [...new Set(schema.enum.map((value) => (value === null ? "null" : typeof value)))];
  }
  if (Object.hasOwn(schema, "const")) {
    return [schema.const === null ? "null" : typeof schema.const];
  }
  return ["string"];
}

export function createSuiteActionDraft(action: InputAction): SuiteActionDraft {
  return Object.fromEntries(
    Object.entries(action.exampleInput).map(([field, value]) => [
      field,
      typeof value === "boolean"
        ? value
        : typeof value === "string"
          ? value
          : JSON.stringify(value),
    ]),
  );
}

function parseStructured(field: string, raw: string, type: "array" | "object") {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${field} must contain valid JSON.`);
  }
  if (type === "array" && !Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON array.`);
  }
  if (
    type === "object" &&
    (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return parsed;
}

function parseDraftValue(field: string, schema: JsonSchema, value: SuiteActionDraftValue) {
  const types = suiteActionSchemaTypes(schema);
  if (typeof value === "string" && value === "null" && types.includes("null")) {
    return null;
  }
  const valueType = types.find((type) => type !== "null") ?? "string";
  if (valueType === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${field} must be true or false.`);
    return value;
  }
  const raw = typeof value === "string" ? value : String(value);
  if (valueType === "array" || valueType === "object") {
    return parseStructured(field, raw, valueType);
  }
  if (valueType === "integer" || valueType === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (valueType === "integer" && !Number.isInteger(parsed))) {
      throw new Error(`${field} must be ${valueType === "integer" ? "a whole number" : "a number"}.`);
    }
    return parsed;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(raw)) {
    throw new Error(`${field} must be one of the available choices.`);
  }
  return raw;
}

export function buildSuiteActionInput(
  action: InputAction,
  draft: SuiteActionDraft,
): Record<string, unknown> {
  const required = new Set(action.inputSchema.required);
  const input: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(action.inputSchema.properties)) {
    const value = draft[field];
    const missing =
      value === undefined || (typeof value === "string" && value.trim() === "");
    if (missing) {
      if (required.has(field)) throw new Error(`${field} is required.`);
      continue;
    }
    input[field] = parseDraftValue(field, schema, value);
  }
  return input;
}
