import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateProposalOnlyAiResult } from "../src/server/ai-result";
import { config } from "../src/server/config";
import { executeSuiteAction } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import {
  additiveBusinessActions,
  additiveBusinessActionsByModule,
  additiveBusinessModules,
} from "../src/shared/additive-business-actions";
import {
  additiveWaveTwoActions,
  additiveWaveTwoActionsByModule,
  additiveWaveTwoModules,
} from "../src/shared/extended-business-actions";
import { suiteAction, suiteActionToolName, suiteActions } from "../src/shared/suite-actions";
import { suiteModuleById, suiteModules, suiteToolName } from "../src/shared/suite";

const now = new Date("2026-08-24T18:00:00.000Z");
const dependencies = { now: () => now, resolveTxt: async () => [], resolveHost: async () => ["203.0.113.10"] };

describe("Batch A and B shared-suite integration", () => {
  it("derives registry records, capabilities, plans, resources, and every typed action from the finalized contracts", () => {
    for (const module of additiveBusinessModules) {
      const actions = additiveBusinessActionsByModule.get(module.id)!;
      expect(suiteModuleById.get(module.id)).toMatchObject({
        name: module.name,
        category: module.category,
        description: module.originalProductThesis,
        minPlan: module.minPlan,
        resourceClass: module.resource.class,
        resourceRequirements: module.resource,
        recordTypes: [...new Set([...actions.map((action) => action.recordType), "additive-command-receipt"])],
        aiCapabilities: module.aiNativeQualities,
      });
    }
    for (const module of additiveWaveTwoModules) {
      const actions = additiveWaveTwoActionsByModule.get(module.id)!;
      expect(suiteModuleById.get(module.id)).toMatchObject({
        name: module.name,
        category: module.category,
        description: module.originalProductThesis,
        minPlan: module.minPlan,
        resourceClass: module.resource.class,
        resourceRequirements: module.resource,
        recordTypes: [...new Set([...actions.map((action) => action.recordType), ...(module.id === "metering" ? ["credit-application-receipt"] : []), "extended-business-command-receipt"])],
        aiCapabilities: module.aiNativeQualities,
      });
    }

    for (const source of additiveBusinessActions) {
      expect(suiteAction(source.moduleId, source.id)).toMatchObject({
        engine: "additive",
        operation: source.operation === "mutation" ? "command" : source.operation,
        recordType: source.recordType,
        requiredFields: source.inputSchema.required,
        inputSchema: source.inputSchema,
        exampleInput: source.exampleInput,
        requiredScope: source.requiredScope,
        mcpToolName: source.mcpToolName,
        cliExample: source.cliExample,
        risk: source.risk,
        destructive: source.destructive,
        externalEffect: source.externalEffect,
        idempotent: source.idempotent,
        requiresApproval: source.requiresApproval,
        supportsDryRun: source.supportsDryRun,
      });
    }
    for (const source of additiveWaveTwoActions) {
      expect(suiteAction(source.moduleId, source.id)).toMatchObject({
        engine: "extended",
        operation: source.operation === "mutation" ? "command" : source.operation,
        recordType: source.recordType,
        requiredFields: source.inputSchema.required,
        inputSchema: source.inputSchema,
        exampleInput: source.exampleInput,
        requiredScope: source.requiredScope,
        mcpToolName: source.mcpToolName,
        cliExample: source.cliExample,
        risk: source.risk,
        destructive: source.destructive,
        externalEffect: source.externalEffect,
        idempotent: source.idempotent,
        requiresApproval: source.requiresApproval,
        supportsDryRun: source.supportsDryRun,
        minimumRole: source.minimumRole,
        effectBoundary: source.effectBoundary,
      });
    }

    const toolNames = [
      "suite_catalog", "suite_workspace", "suite_ai_status",
      ...suiteModules.map((module) => suiteToolName(module.id, "list")),
      ...suiteActions.map(suiteActionToolName),
    ];
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames).toHaveLength(3 + suiteModules.length + suiteActions.length);
  });

  it("dispatches both SuiteStore adapters and returns canonical shared-store records", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    await store.setWorkspacePlan(userId, "fleet");
    await store.enableModule(userId, "tables");
    await store.enableModule(userId, "events");

    const table = await executeSuiteAction(store, userId, "tables", "base-create", additiveBusinessActionsByModule.get("tables")![0].exampleInput, dependencies);
    expect(table).toMatchObject({ kind: "command", action: { engine: "additive" }, records: [{ moduleId: "tables", recordType: "table-base", data: { additiveContract: "additive-business-record.v1" } }] });
    const tableRecords = "records" in table && Array.isArray(table.records) ? table.records : [];
    if (!tableRecords[0]) throw new Error("Expected the stored table record.");
    const tableId = tableRecords[0].id;

    const eventAction = additiveWaveTwoActionsByModule.get("events")!.find((action) => action.id === "create-draft")!;
    const event = await executeSuiteAction(store, userId, "events", eventAction.id, eventAction.exampleInput, dependencies);
    expect(event).toMatchObject({ kind: "command", action: { engine: "extended" }, records: [{ moduleId: "events", recordType: "event", state: "draft" }] });

    const proposal = await executeSuiteAction(store, userId, "tables", "schema-propose", {
      baseId: tableId,
      goal: "Propose one cited field for human review.",
      evidenceIds: [tableId],
      modelId: config.AI_MODEL,
      dryRun: false,
      approval: { approved: true, approvedBy: userId, approvedAt: now.toISOString(), decisionId: "tables.schema-propose.integration-approval-0001", reason: "Reviewed the exact evidence selection." },
      idempotencyKey: "tables.schema-propose.integration-0001",
    }, dependencies);
    expect(proposal).toMatchObject({ kind: "ai-action", action: { engine: "additive" }, aiAction: { moduleId: "tables", status: "queued" }, audit: { proposalOnly: true } });
  });

  it("claims only explicitly selected tenant records across tools and keeps unselected reads module-local", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    await store.setWorkspacePlan(userId, "fleet");
    await store.enableModule(userId, "tables");
    await store.enableModule(userId, "crm");
    const table = await store.createRecord(userId, { moduleId: "tables", recordType: "table-base", title: "Customers" });
    const selected = await store.createRecord(userId, { moduleId: "crm", recordType: "account", title: "Selected" });
    const unselected = await store.createRecord(userId, { moduleId: "crm", recordType: "account", title: "Unselected" });
    await store.queueAiAction(userId, { moduleId: "tables", goal: "Use selected evidence.", context: { evidenceIds: [table!.id, selected!.id], proposalOnly: true } });
    const selectedClaim = await store.claimAiAction();
    expect(new Set(selectedClaim!.records.map((record) => record.id))).toEqual(new Set([table!.id, selected!.id]));
    expect(selectedClaim!.records.map((record) => record.id)).not.toContain(unselected!.id);
    await store.completeAiAction(selectedClaim!.action.id, { status: "completed", result: { proposal: "Done" } });

    await store.queueAiAction(userId, { moduleId: "tables", goal: "No cross-tool selection.", context: {} });
    const localClaim = await store.claimAiAction();
    expect(localClaim!.records.every((record) => record.moduleId === "tables")).toBe(true);
    expect(localClaim!.records.map((record) => record.id)).not.toContain(selected!.id);
    expect(localClaim!.records.map((record) => record.id)).not.toContain(unselected!.id);
  });

  it("validates proposal-only results without accepting external-effect or citation escalation", () => {
    const evidenceId = randomUUID();
    const valid = {
      version: "extended-business-proposal.v1" as const,
      proposal: "Review the cited record before any separate action.",
      evidence: [evidenceId],
      confidence: 0.7,
      assumptions: ["The selected snapshot is current."],
      model: "local-reviewed-model",
      reviewStatus: "pending-human-review" as const,
      approvalRequired: true as const,
      proposalOnly: true as const,
      automaticMutationAllowed: false as const,
      externalEffectAllowed: false as const,
    };
    expect(validateProposalOnlyAiResult(valid, { version: valid.version, allowedRecordIds: [evidenceId] })).toEqual(valid);
    expect(() => validateProposalOnlyAiResult({ ...valid, evidence: [randomUUID()] }, { version: valid.version, allowedRecordIds: [evidenceId] })).toThrow(/explicitly selected/);
    expect(() => validateProposalOnlyAiResult({ ...valid, executed: true }, { version: valid.version, allowedRecordIds: [evidenceId] })).toThrow();
    expect(() => validateProposalOnlyAiResult({ ...valid, externalEffectAllowed: true }, { version: valid.version, allowedRecordIds: [evidenceId] })).toThrow();
  });
});
