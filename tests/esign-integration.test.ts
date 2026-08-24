import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeSuiteAction, type SuiteEngineDependencies } from "../src/server/suite-engine";
import { MemorySuiteStore } from "../src/server/suite-store";
import { esignActions } from "../src/shared/esign-actions";
import { suiteAction, suiteActions } from "../src/shared/suite-actions";
import { suiteModuleById } from "../src/shared/suite";
import { suiteRegisteredObjectBytes, suiteStorageAccounting } from "../src/shared/suite-quotas";

const dependencies: SuiteEngineDependencies = {
  now: () => new Date("2026-08-24T18:00:00.000Z"),
  resolveTxt: async () => [],
  resolveHost: async () => ["203.0.113.10"],
  publicBaseUrl: "https://cloud.example.test",
};

describe("e-signature rewrite integration", () => {
  it("registers every typed action and Starter module in the dashboard, CLI, and MCP registry", () => {
    expect(esignActions).toHaveLength(14);
    for (const action of esignActions) {
      expect(suiteAction("esign", action.id)).toMatchObject({
        engine: "esign",
        inputSchema: action.inputSchema,
        exampleInput: action.exampleInput,
        mcpToolName: action.mcpToolName,
        cliExample: action.cliExample,
      });
    }
    expect(suiteModuleById.get("esign")).toMatchObject({
      minPlan: "starter",
      resourceClass: "shared",
      recordTypes: expect.arrayContaining(["document", "envelope", "signer-session", "esign-command-receipt", "esign-ai-request-audit"]),
    });
    expect(new Set(suiteActions.map((action) => `${action.moduleId}:${action.id}`)).size).toBe(suiteActions.length);
  });

  it("executes and replays one nested transaction through the production dispatcher", async () => {
    const store = new MemorySuiteStore("starter");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "esign");
    const input = {
      name: "Mutual agreement",
      purpose: "Collect explicit reviewed workflow facts.",
      idempotencyKey: "esign.template.integration-0001",
    };

    const first = await store.runInWorkspaceTransaction(userId, () =>
      executeSuiteAction(store, userId, "esign", "template-create", input, dependencies),
    );
    const replay = await store.runInWorkspaceTransaction(userId, () =>
      executeSuiteAction(store, userId, "esign", "template-create", input, dependencies),
    );

    expect(first.kind).toBe("command");
    expect(replay.kind).toBe("command");
    expect(replay.kind === "command" ? replay.audit.replayed : undefined).toBe(true);
    expect(await store.listRecords(userId, { moduleId: "esign", recordType: "template", limit: 20 })).toHaveLength(1);
    expect(await store.listRecords(userId, { moduleId: "esign", recordType: "esign-command-receipt", limit: 20 })).toHaveLength(1);
  });

  it("counts registered agreement bytes against the same shared customer storage quota", () => {
    expect(suiteRegisteredObjectBytes("esign", "document", { objectRef: "tenant/agreement.pdf", objectVersion: "v1", sha256: "a".repeat(64), sizeBytes: 42_000, storageAccounting: suiteStorageAccounting(42_000) })).toBe(42_000);
    expect(suiteRegisteredObjectBytes("esign", "template", { sizeBytes: 42_000 })).toBe(0);
    expect(suiteRegisteredObjectBytes("drive", "file", { sizeBytes: 99_000 })).toBe(0);
    expect(suiteRegisteredObjectBytes("drive", "file-version", { fileId: randomUUID(), fileVersionNumber: 1, objectKey: "tenant/file-v1", checksum: "b".repeat(64), sizeBytes: 99_000, storageAccounting: suiteStorageAccounting(99_000) })).toBe(99_000);
  });

  it("pins trusted model evidence and atomic PostgreSQL completion boundaries", () => {
    const worker = readFileSync("src/server/ai-worker.ts", "utf8");
    const migration = readFileSync("db/migrations/010-esign-atomicity-and-invariants.sql", "utf8");
    expect(worker).toContain('version === "esign-ai-result.v1"');
    expect(worker).toContain("esignPromptDigest()");
    expect(worker).toContain("validateEsignAiCompletion");
    expect(worker).toContain("targetRecordHash");
    expect(worker).toContain("evidenceHashes");
    expect(migration).toContain("managed_oss_complete_suite_ai_action_v2");
    expect(migration).toContain("esign-ai-request-audit");
    expect(migration).toContain("esign_signer_session_token_hash_idx");
    expect(migration).toContain("esign_document_object_version_once_idx");
    expect(migration).toContain("esign_field_completion_once_idx");
  });
});
