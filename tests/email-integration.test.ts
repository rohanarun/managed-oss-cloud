import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeSuiteAction, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { emailActions } from "../src/shared/email-actions";
import { suiteAction, suiteActions } from "../src/shared/suite-actions";
import { suiteAiReadScopes, suiteModuleById } from "../src/shared/suite";

const dependencies: SuiteEngineDependencies = {
  now: () => new Date("2026-08-24T18:00:00.000Z"),
  resolveTxt: async () => [],
  resolveHost: async () => ["203.0.113.10"],
  publicBaseUrl: "https://cloud.example.test",
};

describe("Letterline integration", () => {
  it("registers every strict action and the shared Starter module for dashboard, CLI, and MCP", () => {
    expect(emailActions).toHaveLength(16);
    for (const action of emailActions) {
      expect(suiteAction("email", action.id)).toMatchObject({
        engine: "email",
        inputSchema: action.inputSchema,
        exampleInput: action.exampleInput,
        mcpToolName: action.mcpToolName,
        cliExample: action.cliExample,
      });
    }
    expect(suiteModuleById.get("email")).toMatchObject({
      name: "Letterline",
      minPlan: "starter",
      resourceClass: "shared",
      recordTypes: expect.arrayContaining(["audience", "subscriber", "suppression", "campaign", "dispatch-plan", "email-ai-request-audit", "email-command-receipt"]),
    });
    expect(suiteAiReadScopes("email")).toEqual(["email", "knowledge", "crm", "feedback"]);
    expect(new Set(suiteActions.map((action) => `${action.moduleId}:${action.id}`)).size).toBe(suiteActions.length);
  });

  it("executes and replays a typed Letterline transaction through the production dispatcher", async () => {
    const store = new MemorySuiteStore("starter");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "email");
    const input = {
      name: "Product letter",
      purpose: "Send a reviewed newsletter to people who opted in.",
      consentPolicyVersion: "newsletter-consent-v1",
      idempotencyKey: "email.audience.integration-0001",
    };
    const first = await store.runInWorkspaceTransaction(userId, () => executeSuiteAction(store, userId, "email", "audience-create", input, dependencies));
    const replay = await store.runInWorkspaceTransaction(userId, () => executeSuiteAction(store, userId, "email", "audience-create", input, dependencies));
    expect(first.kind).toBe("command");
    expect(replay.kind).toBe("command");
    expect(replay.kind === "command" ? replay.audit.replayed : undefined).toBe(true);
    expect(await store.listRecords(userId, { moduleId: "email", recordType: "audience", limit: 20 })).toHaveLength(1);
    expect(await store.listRecords(userId, { moduleId: "email", recordType: "email-command-receipt", limit: 20 })).toHaveLength(1);
  });

  it("pins exact evidence and atomic PostgreSQL completion contracts", () => {
    const worker = readFileSync("src/server/ai-worker.ts", "utf8");
    const migration = readFileSync("db/migrations/011-email-atomicity-and-invariants.sql", "utf8");
    expect(worker).toContain('contractVersion === "letterline-ai-result.v1"');
    expect(worker).toContain("emailPromptDigest()");
    expect(worker).toContain("validateEmailAiCompletion");
    expect(worker).toContain("targetRecordHash");
    expect(worker).toContain("evidenceHashes");
    expect(migration).toContain("managed_oss_complete_suite_ai_action_v3");
    expect(migration).toContain("suite_email_subscriber_hash_key");
    expect(migration).toContain("suite_email_provider_event_key");
    expect(migration).toContain("email-ai-request-audit");
  });
});
