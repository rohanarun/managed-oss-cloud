import { describe, expect, it } from "vitest";
import {
  buildSuiteActionInput,
  createSuiteActionDraft,
  suiteActionSchemaTypes,
} from "../src/client/suite-action-input";
import type { SuiteActionInputJsonSchema } from "../src/shared/suite-actions";

const action = {
  inputSchema: {
    type: "object" as const,
    required: ["name", "version", "payload", "approval", "nullableId"],
    properties: {
      name: { type: "string" },
      version: { type: "integer" },
      payload: { type: "array" },
      approval: { type: "object" },
      nullableId: {
        anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      note: { type: "string" },
      enabled: { type: "boolean" },
      mode: { enum: ["safe", "fast"] },
    },
    additionalProperties: false,
  } satisfies SuiteActionInputJsonSchema,
  exampleInput: {
    name: "Launch",
    version: 2,
    payload: [{ key: "value" }],
    approval: { approved: true },
    nullableId: null,
    enabled: false,
    mode: "safe",
  },
};

describe("suite dashboard action input", () => {
  it("serializes examples for editable controls and restores their JSON types", () => {
    const draft = createSuiteActionDraft(action);
    expect(draft).toMatchObject({ version: "2", nullableId: "null", enabled: false });
    expect(buildSuiteActionInput(action, draft)).toEqual({
      name: "Launch",
      version: 2,
      payload: [{ key: "value" }],
      approval: { approved: true },
      nullableId: null,
      enabled: false,
      mode: "safe",
    });
  });

  it("omits blank optional values and rejects malformed structured or numeric values", () => {
    const draft = { ...createSuiteActionDraft(action), note: "" };
    expect(buildSuiteActionInput(action, draft)).not.toHaveProperty("note");
    expect(() => buildSuiteActionInput(action, { ...draft, payload: "{}" })).toThrow(
      "payload must be a JSON array",
    );
    expect(() => buildSuiteActionInput(action, { ...draft, version: "1.5" })).toThrow(
      "version must be a whole number",
    );
    expect(() => buildSuiteActionInput(action, { ...draft, name: "" })).toThrow(
      "name is required",
    );
  });

  it("derives controls from direct, union, enum, and const schemas", () => {
    expect(suiteActionSchemaTypes({ type: "object" })).toEqual(["object"]);
    expect(suiteActionSchemaTypes({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual([
      "string",
      "null",
    ]);
    expect(suiteActionSchemaTypes({ enum: ["safe", "fast"] })).toEqual(["string"]);
    expect(suiteActionSchemaTypes({ const: true })).toEqual(["boolean"]);
  });
});
