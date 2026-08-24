import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeSuiteAction } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { coreBusinessActions } from "../src/shared/core-business-actions";
import { suiteAction, suiteActions } from "../src/shared/suite-actions";

describe("core business rewrite integration", () => {
  it("registers every clean-room action in the shared CLI and MCP registry", () => {
    expect(coreBusinessActions).toHaveLength(72);
    for (const action of coreBusinessActions) {
      expect(suiteAction(action.moduleId, action.id)).toMatchObject({
        engine: "core",
        inputSchema: action.inputSchema,
        mcpToolName: action.mcpToolName,
      });
    }
    for (const [moduleId, actionId] of [
      ["automate", "create-flow"], ["automate", "repair-run"],
      ["publish", "schedule-post"], ["publish", "analyze-campaign"],
      ["inbox", "open-conversation"], ["inbox", "draft-reply"],
      ["crm", "add-contact"], ["crm", "recommend-next-action"],
      ["tasks", "create-task"], ["tasks", "complete-task"],
      ["feedback", "submit-suggestion"], ["feedback", "cluster-feedback"],
      ["knowledge", "publish-page"], ["knowledge", "answer-question"],
      ["links", "create-link"], ["links", "analyze-traffic"],
    ]) expect(suiteAction(moduleId, actionId)).toBeUndefined();
    expect(new Set(suiteActions.map((action) => `${action.moduleId}:${action.id}`)).size).toBe(suiteActions.length);
  });

  it("executes and replays one atomic typed action through the production dispatcher", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "automate");
    const input = {
      name: "Qualified lead intake",
      triggerSchema: { type: "object", required: ["leadId"] },
      steps: [{ key: "qualify", kind: "transform" }],
      idempotencyKey: "workflow-create-integration-0001",
    };

    const [first, replay] = await Promise.all([
      store.runInWorkspaceTransaction(userId, () => executeSuiteAction(store, userId, "automate", "workflow-version-create", input)),
      store.runInWorkspaceTransaction(userId, () => executeSuiteAction(store, userId, "automate", "workflow-version-create", input)),
    ]);

    expect(first.kind).toBe("command");
    expect(replay.kind).toBe("command");
    expect("audit" in replay ? replay.audit?.replayed : undefined).toBe(true);
    expect(await store.listRecords(userId, { moduleId: "automate", recordType: "workflow-version", limit: 20 })).toHaveLength(1);
    expect(await store.listRecords(userId, { moduleId: "automate", recordType: "command-receipt", limit: 20 })).toHaveLength(1);
  });

  it("rejects undeclared fields before applying a clean-room mutation", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "crm");
    await expect(store.runInWorkspaceTransaction(userId, () => executeSuiteAction(store, userId, "crm", "account-upsert", {
      externalKey: "boundary-account",
      name: "Boundary account",
      domain: "example.com",
      idempotencyKey: "crm-account-integration-0001",
      providerSecret: "must-not-pass",
    }))).rejects.toThrow(/not allowed/);
    expect(await store.listRecords(userId, { moduleId: "crm", limit: 20 })).toEqual([]);
  });
});
