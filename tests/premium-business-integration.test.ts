import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeSuiteAction } from "../src/server/suite-engine";
import { config } from "../src/server/config";
import { MemorySuiteStore } from "../src/server/suite-store";
import {
  premiumBusinessActions,
  premiumBusinessModules,
  premiumPlanAllows,
  type PremiumModuleId,
} from "../src/shared/premium-business-actions";
import { suiteAction, suiteActions } from "../src/shared/suite-actions";
import { suiteModuleById } from "../src/shared/suite";
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

  it("publishes modelId only as an optional host-policy assertion and dispatches omitted values through config.AI_MODEL", async () => {
    const modelActions = premiumBusinessActions.filter((action) => action.operation === "ai" || action.moduleId === "assistant" && action.id === "run-preview");
    expect(modelActions).toHaveLength(9);
    for (const action of modelActions) {
      expect(action.inputSchema.required).not.toContain("modelId");
      expect(action.inputSchema.properties.modelId).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
      expect(action.inputSchema.properties.modelId.description).toMatch(/Optional exact assertion of the host-configured model policy/);
      expect(action.description).toMatch(/host-configured model policy|host model policy/);
      expect(action.cliExample).not.toContain("modelId");
    }

    const store = new MemorySuiteStore("scale");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "projects");
    const projectResult = await executeSuiteAction(store, userId, "projects", "project-create", { key: "dispatcher-model-policy", name: "Dispatcher model policy", outcome: "Use the configured host model", idempotencyKey: "premium-dispatcher-model-project" });
    if (projectResult.kind !== "command" || !projectResult.records[0]) throw new Error("Expected a project record.");
    const approval = { approved: true, approvedBy: userId, approvedAt: new Date().toISOString(), decisionId: `premium-dispatcher-${randomUUID()}`, reason: "Reviewed the exact host-policy request" };
    const queued = await executeSuiteAction(store, userId, "projects", "plan-propose", { projectId: projectResult.records[0].id, objective: "Use the configured model without caller routing", evidenceIds: [projectResult.records[0].id], promptVersion: "dispatcher-policy-v1", approval, dryRun: false, idempotencyKey: "premium-dispatcher-model-run" });
    expect(queued.kind).toBe("ai-action");
    if (queued.kind !== "ai-action") throw new Error("Expected a queued premium AI action.");
    expect(queued.aiAction.context.requestedModelId).toBe(config.AI_MODEL);
    expect(queued.records?.[0]?.data.requestedModelId).toBe(config.AI_MODEL);
  });

  it("keeps the category references and exact Scale/Fleet gates attached to the production modules", () => {
    expect(
      Object.fromEntries(
        premiumBusinessModules.map((module) => {
          const productionModule = suiteModuleById.get(module.id);
          return [module.id, { inspiredBy: productionModule?.inspiredBy, description: productionModule?.description, recordTypes: productionModule?.recordTypes, aiCapabilities: productionModule?.aiCapabilities, minPlan: module.minPlan, productionMinPlan: productionModule?.minPlan, minimumMonthlyPlanUsd: module.minimumMonthlyPlanUsd }];
        }),
      ),
    ).toEqual({
      projects: { inspiredBy: "Plane", description: "Outcome projects, scoped issues, acyclic dependencies, capacity-safe cycle snapshots, and cited planning proposals.", recordTypes: ["project", "issue", "cycle", "premium-ai-request-audit", "premium-command-receipt"], aiCapabilities: ["propose cited plan", "explain project health with citations"], minPlan: "scale", productionMinPlan: "scale", minimumMonthlyPlanUsd: 50 },
      drive: { inspiredBy: "Nextcloud", description: "Private vaults, checksum-addressed file versions, approved expiring shares, retention controls, and cited document understanding.", recordTypes: ["vault", "file", "file-version", "share", "premium-ai-request-audit", "premium-command-receipt"], aiCapabilities: ["understand checksum-pinned document with citations"], minPlan: "scale", productionMinPlan: "scale", minimumMonthlyPlanUsd: 50 },
      channels: { inspiredBy: "Zulip", description: "Topic-first streams with preview-approved messages, redaction receipts, human decisions, cited summaries, and non-sending digests.", recordTypes: ["stream", "topic", "message", "premium-ai-request-audit", "premium-command-receipt"], aiCapabilities: ["summarize topic with citations", "draft non-sending digest"], minPlan: "scale", productionMinPlan: "scale", minimumMonthlyPlanUsd: 50 },
      operations: { inspiredBy: "ERPNext", description: "Parties, priced items, immutable order and invoice snapshots, balanced journals, payment receipts, and cited variance explanations.", recordTypes: ["party", "item", "order", "invoice", "journal", "payment", "premium-ai-request-audit", "premium-command-receipt"], aiCapabilities: ["explain operational variance without posting accounting facts"], minPlan: "fleet", productionMinPlan: "fleet", minimumMonthlyPlanUsd: 200 },
      assistant: { inspiredBy: "LibreChat", description: "A model-neutral workbench for attached evidence, immutable prompts, reviewed cited results, and allowlisted proposal-only agents.", recordTypes: ["collection", "source-attachment", "prompt-version", "premium-ai-request-audit", "ai-result", "agent", "premium-command-receipt"], aiCapabilities: ["run attached evidence-bound prompt", "review cited model result", "propose allowlisted agent actions"], minPlan: "fleet", productionMinPlan: "fleet", minimumMonthlyPlanUsd: 200 },
    });
    const plans = ["none", "starter", "scale", "fleet"] as const;
    for (const module of premiumBusinessModules) expect(plans.map((plan) => premiumPlanAllows(plan, module))).toEqual(module.minPlan === "scale" ? [false, false, true, true] : [false, false, false, true]);
  });

  it("enables and executes every premium module only on its exact minimum-or-higher production plan", async () => {
    const probes: Record<PremiumModuleId, { actionId: string; input: Record<string, unknown> }> = {
      projects: { actionId: "project-create", input: { key: "gate-project", name: "Gate project", outcome: "Prove Scale access", idempotencyKey: "premium-gate-project" } },
      drive: { actionId: "vault-create", input: { name: "Gate vault", classification: "internal", idempotencyKey: "premium-gate-vault01" } },
      channels: { actionId: "stream-create", input: { key: "gate-stream", name: "Gate stream", purpose: "Prove Scale access", idempotencyKey: "premium-gate-stream01" } },
      operations: { actionId: "party-create", input: { name: "Gate customer", kind: "customer", currency: "USD", idempotencyKey: "premium-gate-party01" } },
      assistant: { actionId: "collection-create", input: { name: "Gate evidence", purpose: "Prove Fleet access", idempotencyKey: "premium-gate-assistant" } },
    };
    const plans = ["none", "starter", "scale", "fleet"] as const;
    for (const plan of plans) {
      const store = new MemorySuiteStore(plan); const userId = randomUUID(); await store.getOrCreateWorkspace(userId);
      for (const module of premiumBusinessModules) {
        const allowed = premiumPlanAllows(plan, module); const enabled = await store.enableModule(userId, module.id); expect(Boolean(enabled), `${module.id} enablement on ${plan}`).toBe(allowed);
        if (allowed) { const result = await executeSuiteAction(store, userId, module.id, probes[module.id].actionId, probes[module.id].input); expect(result.kind).toBe("command"); expect(await store.listRecords(userId, { moduleId: module.id, limit: 20 })).not.toEqual([]); }
        else expect(await store.listRecords(userId, { moduleId: module.id, limit: 20 })).toEqual([]);
      }
    }
    for (const module of premiumBusinessModules) {
      const store = new MemorySuiteStore("fleet"); const userId = randomUUID(); await store.getOrCreateWorkspace(userId); await store.enableModule(userId, module.id); const downgradedPlan = module.minPlan === "scale" ? "starter" : "scale"; await store.setWorkspacePlan(userId, downgradedPlan);
      await expect(executeSuiteAction(store, userId, module.id, probes[module.id].actionId, probes[module.id].input)).rejects.toThrow(new RegExp(`locked on the current ${downgradedPlan} plan`));
      expect(await store.listRecords(userId, { moduleId: module.id, limit: 20 })).toEqual([]);
    }
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
    expect(worker).toContain('contractVersion === "premium-business-ai-result.v1"');
    expect(worker).toContain("premiumBusinessPromptDigest(moduleId)");
    expect(worker).toContain("validatePremiumBusinessAiCompletion");
    expect(worker).toContain("premiumBusinessAiEvidenceRecords(job.action, job.records)");
    expect(worker).toContain("workspaceRecords: premiumEvidence");
    expect(worker).toContain("requestedModelId !== config.AI_MODEL");
  });
});
