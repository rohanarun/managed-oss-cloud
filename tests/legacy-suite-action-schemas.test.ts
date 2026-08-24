import { describe, expect, it } from "vitest";
import { validateSuiteActionInput } from "../src/cli/action-input";
import {
  suiteActions,
  suiteActionExampleInput,
  suiteActionInputJsonSchema,
} from "../src/shared/suite-actions";
import {
  legacySuiteActionInputSchema,
  legacySuiteActionInputSchemas,
  legacySuiteModuleIds,
} from "../src/shared/legacy-suite-action-schemas";

const legacyModules = new Set<string>(legacySuiteModuleIds);
const legacyActions = suiteActions.filter((action) => legacyModules.has(action.moduleId));

describe("legacy specialist action schemas", () => {
  it("exports an exact closed schema directly on all 120 legacy action definitions", () => {
    expect(legacyActions).toHaveLength(120);
    expect(Object.values(legacySuiteActionInputSchemas).flatMap((actions) => Object.values(actions))).toHaveLength(120);

    for (const action of legacyActions) {
      const registered = legacySuiteActionInputSchema(action.moduleId, action.id);
      expect(registered, `${action.moduleId}/${action.id}`).toBeDefined();
      expect(action.engine, `${action.moduleId}/${action.id}`).toBe("legacy");
      expect(action.inputSchema, `${action.moduleId}/${action.id}`).toBe(registered);
      expect(suiteActionInputJsonSchema(action), `${action.moduleId}/${action.id}`).toBe(registered);
      expect(action.inputSchema?.additionalProperties, `${action.moduleId}/${action.id}`).toBe(false);
      expect(action.inputSchema?.required, `${action.moduleId}/${action.id}`).toEqual(action.requiredFields);
      expect(Object.keys(action.inputSchema?.properties ?? {}), `${action.moduleId}/${action.id}`).toEqual(
        expect.arrayContaining(action.requiredFields),
      );
    }
  });

  it("validates every generated example and rejects undeclared root input", () => {
    for (const action of legacyActions) {
      const example = suiteActionExampleInput(action);
      expect(validateSuiteActionInput(action, example), `${action.moduleId}/${action.id}`).toEqual(example);
      expect(
        () => validateSuiteActionInput(action, { ...example, undeclaredLegacyField: true }),
        `${action.moduleId}/${action.id}`,
      ).toThrow(/undeclaredLegacyField is not allowed/);
    }
  });

  it("retains every named runtime optional and dynamic payload field", () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["consent", "choice-record", { gpc: true }],
      ["seo", "site-configure", { dailyUnitLimit: 250 }],
      ["seo", "audit-start", { maxPages: 25 }],
      ["seo", "brief-create", { outline: ["Use only selected evidence."] }],
      ["notify", "schema-publish", { schema: { type: "object", additionalProperties: false, properties: { message: { type: "string" } } } }],
      ["forms", "submission-create", { respondentKey: "respondent-123" }],
      ["forms", "form-draft", { schema: {}, logic: [] }],
      ["notify", "event-validate", { payload: { runtimeDefinedField: "value" } }],
      ["schedule", "routing-preview", { routingAnswers: { team: "sales" } }],
      ["forms", "submission-validate", { responseValues: { releaseDefinedField: "value" } }],
      ["flags", "evaluate", { context: { account: { plan: "pro" } } }],
    ];

    for (const [moduleId, actionId, override] of cases) {
      const action = legacyActions.find((candidate) => candidate.moduleId === moduleId && candidate.id === actionId)!;
      const input = { ...suiteActionExampleInput(action), ...override };
      expect(validateSuiteActionInput(action, input), `${moduleId}/${actionId}`).toEqual(input);
    }
  });
});
