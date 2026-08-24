import {
  suiteActionExampleInput,
  suiteActionFields,
  suiteActionInputJsonSchema,
  suiteActionRequiredScope,
  suiteActionToolName,
  type SuiteActionDefinition,
  type SuiteActionFieldDefinition,
} from "../shared/suite-actions.js";
import { z } from "zod";
import { suiteActionMcpInputShape } from "../mcp/action-schema.js";

export function parseJsonObject(value: string | undefined, label: string, required = false): Record<string, unknown> {
  if (value === undefined) {
    if (required) throw new Error(`${label} is required and must be a JSON object.`);
    return {};
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} must be valid JSON containing an object.`); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object, not ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}.`);
  return parsed as Record<string, unknown>;
}

function fieldError(field: SuiteActionFieldDefinition, value: unknown): string | undefined {
  if (field.kind === "boolean") return value === true ? undefined : `${field.name} must be true.`;
  if (field.kind === "array") return Array.isArray(value) ? undefined : `${field.name} must be an array.`;
  if (field.kind === "object") return value !== null && typeof value === "object" && !Array.isArray(value) ? undefined : `${field.name} must be an object.`;
  if (field.kind === "json") return undefined;
  if (field.kind === "integer") return typeof value === "number" && Number.isSafeInteger(value) ? undefined : `${field.name} must be a safe integer.`;
  if (field.kind === "sha256") return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? undefined : `${field.name} must be a lowercase SHA-256 digest.`;
  if (typeof value !== "string" || !value.trim()) return `${field.name} must be a non-empty string.`;
  if (field.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `${field.name} must be a valid email address.`;
  if (field.kind === "url") {
    try { if (!["http:", "https:"].includes(new URL(value).protocol)) return `${field.name} must be an HTTP or HTTPS URL.`; }
    catch { return `${field.name} must be an HTTP or HTTPS URL.`; }
  }
  if (field.kind === "datetime" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(new Date(value).getTime()))) return `${field.name} must be an ISO 8601 date-time.`;
  if (field.kind === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return `${field.name} must be a UUID.`;
  if (field.kind === "currency" && !/^[A-Z]{3}$/.test(value)) return `${field.name} must be a three-letter uppercase currency code.`;
  if (field.kind === "slug" && !/^[a-z0-9][a-z0-9-]{1,79}$/.test(value)) return `${field.name} must contain lowercase letters, numbers, and hyphens.`;
  return undefined;
}

export function validateSuiteActionInput(action: SuiteActionDefinition, input: Record<string, unknown>) {
  const schema = suiteActionInputJsonSchema(action);
  const errors = suiteActionFields(action).flatMap((field) => {
    const present = Object.prototype.hasOwnProperty.call(input, field.name) && input[field.name] !== undefined;
    if (!present) return field.required ? [`${field.name} is required.`] : [];
    if (schema.additionalProperties === false) return [];
    const value = input[field.name];
    const error = fieldError(field, value);
    return error ? [error] : [];
  });
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(input)) if (!(name in schema.properties)) errors.push(`${name} is not allowed.`);
    const parsed = z.object(suiteActionMcpInputShape(action)).strict().safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? issue.path.join(".") : "input";
        const message = `${path}: ${issue.message}`;
        if (!errors.includes(message)) errors.push(message);
      }
    }
  }
  if (errors.length) throw new Error(`Invalid input for ${action.moduleId}/${action.id}: ${errors.join(" ")}`);
  return input;
}

export function describeSuiteAction(action: SuiteActionDefinition) {
  return {
    id: action.id,
    moduleId: action.moduleId,
    title: action.title,
    description: action.description,
    operation: action.operation,
    requiredScope: suiteActionRequiredScope(action),
    mcpTool: suiteActionToolName(action),
    cliExample: action.cliExample ?? `supersuite action ${action.moduleId} ${action.id} '<json-input>'`,
    requiredFields: [...action.requiredFields],
    inputSchema: suiteActionInputJsonSchema(action),
    exampleInput: suiteActionExampleInput(action),
  };
}
