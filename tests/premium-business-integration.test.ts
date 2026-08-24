import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeSuiteAction } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import {
  premiumBusinessActions,
  premiumBusinessModules,
} from "../src/shared/premium-business-actions";
import { suiteAction, suiteActions } from "../src/shared/suite-actions";
import { readFileSync } from "node:fs";

describe("premium business rewrite integration", () => {
  it("publishes every premium action through the shared dashboard, CLI, and MCP registry", () => {
    expect(premiumBusinessActions).toHaveLength(42);
    for (const action of premiumBusinessActions) {
      expect(suiteAction(action.moduleId, action.id)).toMatchObject({
        engine: "premium",
        inputSchema: action.inputSchema,
        mcpToolName: action.mcpToolName,
        cliExample: `supersuite action ${action.moduleId} ${action.id} '<json-input>'`,
      });
    }
    for (const [moduleId, actionId] of [
      ["projects", "create-issue"], ["projects", "plan-cycle"],
      ["drive", "register-file"], ["drive", "understand-document"],
      ["channels", "post-message"], ["channels", "summarize-topic"],
      ["operations", "create-invoice"], ["operations", "forecast-demand"],
      ["assistant", "create-conversation"], ["assistant", "ask"],
    ]) expect(suiteAction(moduleId, actionId)).toBeUndefined();
    expect(
      new Set(suiteActions.map((action) => `${action.moduleId}:${action.id}`)).size,
    ).toBe(suiteActions.length);
  });

  it("keeps Scale and Fleet resource gates attached to the production modules", () => {
    expect(
      Object.fromEntries(
        premiumBusinessModules.map((module) => [module.id, module.minPlan]),
      ),
    ).toEqual({
      projects: "scale",
      drive: "scale",
      channels: "scale",
      operations: "fleet",
      assistant: "fleet",
    });
  });

  it("executes and replays a premium action through the production dispatcher transaction", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "projects");
    const input = {
      key: "launch",
      name: "Launch",
      outcome: "Ship the verified release",
      idempotencyKey: "projects.launch.integration-0001",
    };

    const first = await store.runInWorkspaceTransaction(userId, () =>
      executeSuiteAction(store, userId, "projects", "project-create", input),
    );
    const replay = await store.runInWorkspaceTransaction(userId, () =>
      executeSuiteAction(store, userId, "projects", "project-create", input),
    );

    expect(first.kind).toBe("command");
    expect(replay.kind).toBe("command");
    expect("audit" in replay ? replay.audit?.replayed : undefined).toBe(true);
    expect(
      await store.listRecords(userId, {
        moduleId: "projects",
        recordType: "project",
        limit: 20,
      }),
    ).toHaveLength(1);
    expect(
      await store.listRecords(userId, {
        moduleId: "projects",
        recordType: "premium-command-receipt",
        limit: 20,
      }),
    ).toHaveLength(1);
  });

  it("blocks a Fleet module on Scale before its engine can mutate records", async () => {
    const store = new MemorySuiteStore("scale");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    expect(await store.enableModule(userId, "operations")).toBeUndefined();
    expect(await store.listRecords(userId, { moduleId: "operations", limit: 20 })).toEqual([]);
  });

  it("routes premium model jobs through their pinned result and prompt contracts", () => {
    const worker = readFileSync("src/server/ai-worker.ts", "utf8");
    expect(worker).toContain('version === "premium-business-ai-result.v1"');
    expect(worker).toContain("premiumBusinessPromptDigest(moduleId)");
    expect(worker).toContain("validatePremiumBusinessAiCompletion");
    expect(worker).toContain("requestedModelId !== config.AI_MODEL");
  });
});
