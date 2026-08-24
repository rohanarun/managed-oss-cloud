import { z, type ZodType } from "zod";
import { suiteActionFields, suiteActionInputJsonSchema, type SuiteActionDefinition, type SuiteActionFieldDefinition } from "../shared/suite-actions.js";

function fieldSchema(field: SuiteActionFieldDefinition): ZodType {
  if (field.kind === "boolean") return z.literal(true).describe(field.description);
  if (field.kind === "array") return z.array(z.unknown()).describe(field.description);
  if (field.kind === "object") return z.record(z.string(), z.unknown()).describe(field.description);
  if (field.kind === "json") return z.unknown().refine((value) => value !== undefined, `${field.name} is required.`).describe(field.description);
  if (field.kind === "integer") return z.number().int().describe(field.description);
  if (field.kind === "sha256") return z.string().regex(/^[a-f0-9]{64}$/).describe(field.description);
  if (field.kind === "email") return z.string().email().describe(field.description);
  if (field.kind === "url") return z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Use an HTTP or HTTPS URL.").describe(field.description);
  if (field.kind === "datetime") return z.string().datetime({ offset: true }).describe(field.description);
  if (field.kind === "uuid") return z.string().uuid().describe(field.description);
  if (field.kind === "currency") return z.string().regex(/^[A-Z]{3}$/).describe(field.description);
  if (field.kind === "slug") return z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/).describe(field.description);
  return z.string().trim().min(1).describe(field.description);
}

function jsonSchema(schema: Record<string, unknown>): ZodType {
  let result: ZodType;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const alternatives = schema.anyOf.map((candidate) => jsonSchema(candidate as Record<string, unknown>));
    result = alternatives.length === 1 ? alternatives[0] : z.union(alternatives as [ZodType, ZodType, ...ZodType[]]);
  } else if ("const" in schema) result = z.literal(schema.const as string | number | boolean | null);
  else if (Array.isArray(schema.enum)) {
    const allowed = schema.enum;
    result = z.unknown().refine((value) => allowed.includes(value), "Choose an allowed value.");
  }
  else if (schema.type === "string") {
    let value = z.string();
    if (schema.format === "email") value = value.email();
    else if (schema.format === "uri") value = value.url();
    else if (schema.format === "date-time") value = value.datetime({ offset: true });
    else if (schema.format === "uuid") value = value.uuid();
    if (typeof schema.pattern === "string") value = value.regex(new RegExp(schema.pattern));
    if (typeof schema.minLength === "number") value = value.min(schema.minLength);
    if (typeof schema.maxLength === "number") value = value.max(schema.maxLength);
    result = value;
  } else if (schema.type === "integer") {
    let value = z.number().int();
    if (typeof schema.minimum === "number") value = value.min(schema.minimum);
    if (typeof schema.maximum === "number") value = value.max(schema.maximum);
    result = value;
  } else if (schema.type === "number") result = z.number().finite();
  else if (schema.type === "boolean") result = z.boolean();
  else if (schema.type === "array") {
    let value = z.array(schema.items && typeof schema.items === "object" ? jsonSchema(schema.items as Record<string, unknown>) : z.unknown());
    if (typeof schema.minItems === "number") value = value.min(schema.minItems);
    if (typeof schema.maxItems === "number") value = value.max(schema.maxItems);
    result = value;
  } else if (schema.type === "object") {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : undefined;
    if (!properties) result = z.record(z.string(), z.unknown());
    else {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const shape = Object.fromEntries(Object.entries(properties).map(([name, property]) => {
        const value = jsonSchema(property);
        return [name, required.has(name) ? value : value.optional()];
      }));
      result = schema.additionalProperties === false ? z.object(shape).strict() : z.object(shape).passthrough();
    }
  } else result = z.unknown();
  return typeof schema.description === "string" ? result.describe(schema.description) : result;
}

export function suiteActionMcpInputShape(action: SuiteActionDefinition): Record<string, ZodType> {
  const schema = suiteActionInputJsonSchema(action);
  const required = new Set(schema.required);
  const fields = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => {
    const value = jsonSchema(property);
    return [name, required.has(name) ? value : value.optional()];
  }));
  return schema.additionalProperties === false ? fields : {
    ...fields,
    additionalData: z.record(z.string(), z.unknown()).optional().describe("Optional additional action context. Named required fields take precedence."),
  };
}

export function suiteActionMcpInput(args: Record<string, unknown>) {
  const { additionalData, ...namedFields } = args;
  const extras = additionalData && typeof additionalData === "object" && !Array.isArray(additionalData) ? additionalData as Record<string, unknown> : {};
  return { ...extras, ...namedFields };
}
