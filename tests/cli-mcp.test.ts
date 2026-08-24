import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { describeSuiteAction, parseJsonObject, validateSuiteActionInput } from "../src/cli/action-input";
import { suiteActionMcpInput, suiteActionMcpInputShape } from "../src/mcp/action-schema";
import { suiteModules, suiteToolName } from "../src/shared/suite";
import { managedOssPackageVersion } from "../src/shared/package-version";
import {
  suiteAction,
  suiteActionExampleInput,
  suiteActionInputJsonSchema,
  suiteActionRequiredScope,
  suiteActionToolName,
  suiteActions,
  suiteActionsByModule,
} from "../src/shared/suite-actions";

describe("SuperSuite CLI and MCP action discovery", () => {
  it("derives the CLI and MCP version from the package manifest", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(managedOssPackageVersion()).toBe(manifest.version);
  });

  it("publishes one uniquely named typed MCP tool for every workflow action", () => {
    const baseNames = ["suite_catalog", "suite_workspace", "suite_ai_status"];
    for (const module of suiteModules) {
      expect(suiteActionsByModule.get(module.id)?.length).toBeGreaterThan(0);
      baseNames.push(suiteToolName(module.id, "list"));
    }
    const actionNames = suiteActions.map(suiteActionToolName);
    const allNames = [...baseNames, ...actionNames];
    expect(new Set(allNames).size).toBe(allNames.length);
    expect(allNames).toHaveLength(3 + suiteModules.length + suiteActions.length);
    expect(suiteModules.every((module) => !allNames.includes(suiteToolName(module.id, "create")) && !allNames.includes(suiteToolName(module.id, "ai")))).toBe(true);
    expect(suiteModules.every((module) => !allNames.includes(`${module.id.replaceAll("-", "_")}_action`))).toBe(true);
  });

  it("exposes required fields, formats, examples, and token scopes for action discovery", () => {
    const schedule = suiteAction("publish", "post-schedule")!;
    const schema = suiteActionInputJsonSchema(schedule);
    expect(schema.required).toEqual(["campaignId", "channelId", "content", "scheduledAt", "campaignHash", "idempotencyKey"]);
    expect(schema.properties.scheduledAt).toMatchObject({ type: "string", format: "date-time" });
    expect(describeSuiteAction(schedule)).toMatchObject({
      moduleId: "publish",
      id: "post-schedule",
      requiredScope: "write",
      mcpTool: "publish_post_schedule",
      exampleInput: suiteActionExampleInput(schedule),
    });
    expect(suiteActionRequiredScope(suiteAction("crm", "next-action-propose")!)).toBe("ai");
    expect(suiteActionInputJsonSchema(suiteAction("operations", "order-create")!).properties.lines).toMatchObject({ type: "array" });
    expect(suiteActionInputJsonSchema(suiteAction("giveaways", "entry-register")!).properties.consent).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("rejects malformed JSON and invalid action fields before an API request", () => {
    expect(() => parseJsonObject("{", "json-input", true)).toThrow(/valid JSON/);
    expect(() => parseJsonObject("null", "json-input", true)).toThrow(/not null/);
    expect(() => parseJsonObject("[]", "json-input", true)).toThrow(/not an array/);
    expect(() => parseJsonObject("42", "json-input", true)).toThrow(/not number/);
    expect(parseJsonObject(undefined, "json-context")).toEqual({});

    const enter = suiteAction("giveaways", "entry-register")!;
    expect(() => validateSuiteActionInput(enter, {
      contestId: "not-a-uuid",
      participantKeyHash: "invalid",
      consent: { granted: false, policyVersion: "v1", purposes: [], capturedAt: "not-a-date", captureMethod: "unknown" },
      sourceAttestation: "unknown",
      idempotencyKey: "short",
    })).toThrow(/contestId.*participantKeyHash.*consent\.granted.*consent\.purposes.*consent\.capturedAt.*consent\.captureMethod.*sourceAttestation.*idempotencyKey/s);
    expect(() => validateSuiteActionInput(enter, { contestId: "00000000-0000-4000-8000-000000000101" })).toThrow(/participantKeyHash is required.*consent is required.*sourceAttestation is required.*idempotencyKey is required/s);
    expect(validateSuiteActionInput(enter, suiteActionExampleInput(enter))).toEqual(suiteActionExampleInput(enter));
  });

  it("keeps generated MCP schemas executable for every current action", () => {
    for (const action of suiteActions) {
      const parsed = z.object(suiteActionMcpInputShape(action)).safeParse({ ...suiteActionExampleInput(action), additionalData: { source: "mcp-test" } });
      expect(parsed.success, `${action.moduleId}/${action.id}`).toBe(true);
    }
    expect(suiteActionMcpInput({ recordId: "named", additionalData: { recordId: "extra", reason: "test" } })).toEqual({ recordId: "named", reason: "test" });
  });

  it("validates every generated action example through the exact CLI schema path", () => {
    for (const action of suiteActions) {
      const example = suiteActionExampleInput(action);
      expect(validateSuiteActionInput(action, example), `${action.moduleId}/${action.id}`).toEqual(example);
    }

    const nullable = suiteAction("inbox", "reply-send")!;
    const nullableExample = suiteActionExampleInput(nullable);
    expect(nullableExample.proposalId).toBeNull();
    expect(validateSuiteActionInput(nullable, nullableExample)).toEqual(nullableExample);
    const missingNullable = { ...nullableExample };
    delete missingNullable.proposalId;
    expect(() => validateSuiteActionInput(nullable, missingNullable)).toThrow(/proposalId is required/);

    const boolean = suiteAction("email", "subscriber-list")!;
    const booleanExample = suiteActionExampleInput(boolean);
    expect(booleanExample.includeSuppressed).toBe(false);
    expect(validateSuiteActionInput(boolean, booleanExample)).toEqual(booleanExample);
    expect(() => validateSuiteActionInput(boolean, { ...booleanExample, includeSuppressed: "false" })).toThrow(/includeSuppressed/);

    const emptyString = suiteAction("tables", "formula-evaluate")!;
    const emptyStringExample = suiteActionExampleInput(emptyString);
    expect(emptyStringExample.fieldKey).toBe("");
    expect(validateSuiteActionInput(emptyString, emptyStringExample)).toEqual(emptyStringExample);
    expect(() => validateSuiteActionInput(emptyString, { ...emptyStringExample, fieldKey: 1 })).toThrow(/fieldKey/);

    for (const [moduleId, actionId, field] of [["insights", "alert-rule-create", "threshold"], ["metering", "ingest-event", "quantity"]] as const) {
      const numeric = suiteAction(moduleId, actionId)!;
      const numericExample = suiteActionExampleInput(numeric);
      expect(typeof numericExample[field]).toBe("number");
      expect(validateSuiteActionInput(numeric, numericExample)).toEqual(numericExample);
      expect(() => validateSuiteActionInput(numeric, { ...numericExample, [field]: String(numericExample[field]) })).toThrow(new RegExp(field));
    }
  });
});
