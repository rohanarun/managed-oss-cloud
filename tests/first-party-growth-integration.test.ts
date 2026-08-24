import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeSuiteAction, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { firstPartyGrowthActions } from "../src/shared/first-party-growth-actions";
import { suiteAction, suiteActions } from "../src/shared/suite-actions";

const dependencies: SuiteEngineDependencies = {
  now: () => new Date("2026-08-24T16:00:00.000Z"),
  resolveTxt: async () => [],
  resolveHost: async () => ["203.0.113.10"],
  publicBaseUrl: "https://cloud.example.test",
};

describe("first-party growth rewrite integration", () => {
  it("replaces every legacy shortcut with strict dashboard, CLI, and MCP actions", () => {
    expect(firstPartyGrowthActions).toHaveLength(36);
    for (const action of firstPartyGrowthActions) {
      expect(suiteAction(action.moduleId, action.id)).toMatchObject({
        engine: "growth",
        inputSchema: action.inputSchema,
        exampleInput: action.exampleInput,
        mcpToolName: action.mcpToolName,
        cliExample: action.cliExample,
      });
    }
    for (const legacy of [
      ["giveaways", "create-contest"],
      ["giveaways", "enter-contest"],
      ["giveaways", "draw-winner"],
      ["testimonials", "request-testimonial"],
      ["testimonials", "submit-testimonial"],
      ["testimonials", "approve-testimonial"],
      ["testimonials", "revoke-testimonial"],
      ["brand-pages", "create-page"],
      ["brand-pages", "create-qr"],
    ]) {
      expect(suiteAction(legacy[0], legacy[1])).toBeUndefined();
    }
    expect(new Set(suiteActions.map((action) => `${action.moduleId}:${action.id}`)).size).toBe(suiteActions.length);
  });

  it("executes and replays a nested typed growth transaction through the production dispatcher", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "giveaways");
    const input = {
      name: "Fair launch",
      closesAt: "2026-09-30T16:00:00.000Z",
      rules: "One consented entry per participant.",
      entropyCommitment: "a".repeat(64),
      consentPolicyVersion: "contest-consent-v1",
      referralBonusCap: 3,
      idempotencyKey: "giveaways.contest-create.integration-0001",
    };

    const first = await store.runInWorkspaceTransaction(userId, () =>
      executeSuiteAction(store, userId, "giveaways", "contest-create", input, dependencies),
    );
    const replay = await store.runInWorkspaceTransaction(userId, () =>
      executeSuiteAction(store, userId, "giveaways", "contest-create", input, dependencies),
    );

    expect(first.kind).toBe("command");
    expect(replay.kind).toBe("command");
    expect("audit" in replay ? replay.audit?.replayed : undefined).toBe(true);
    expect(await store.listRecords(userId, { moduleId: "giveaways", recordType: "contest", limit: 20 })).toHaveLength(1);
    expect(await store.listRecords(userId, { moduleId: "giveaways", recordType: "growth-command-receipt", limit: 20 })).toHaveLength(1);
  });

  it("routes model jobs only through the pinned growth result and prompt contracts", () => {
    const worker = readFileSync("src/server/ai-worker.ts", "utf8");
    expect(worker).toContain('version === "first-party-growth-ai-result.v1"');
    expect(worker).toContain("firstPartyGrowthPromptDigest(growthAction.moduleId)");
    expect(worker).toContain("validateFirstPartyGrowthAiCompletion");
    expect(worker).toContain('model: config.AI_MODEL');
  });
});
