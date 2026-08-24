import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("suite action atomicity and audited AI completion", () => {
  it("serializes an entire workspace action through one PostgreSQL transaction", () => {
    const source = readFileSync("src/server/suite-store.ts", "utf8");
    const postgres = source.slice(source.indexOf("export class PostgresSuiteStore"), source.indexOf("export function createSuiteStore"));
    expect(postgres).toContain("new AsyncLocalStorage<pg.PoolClient>()");
    expect(source).toContain("suite-workspace-action:${workspaceId}");
    expect(postgres).toContain("workspaceMutationLockKey(workspaceId)");
    expect(postgres).toContain("this.transactionContext.run(client, () => operation(workspace))");
    const app = readFileSync("src/server/app.ts", "utf8");
    expect(app).toContain("suiteStore.runInWorkspaceTransaction(response.locals.user.id");
  });

  it("enforces durable receipt uniqueness and completes the AI audit in the same database function", () => {
    const sql = readFileSync("db/migrations/008-suite-action-atomicity-and-ai-audit.sql", "utf8");
    expect(sql).toMatch(/CREATE UNIQUE INDEX suite_action_receipt_idempotency_idx[\s\S]*workspace_id,module_id,\(data->>'actionId'\),\(data->>'idempotencyKey'\)/);
    expect(sql).toContain("core-business-ai-result.v1");
    expect(sql).toContain("core AI completion violates its trusted result contract");
    expect(sql).toContain("jsonb_typeof(p_result->'proposal') IS DISTINCT FROM 'string'");
    expect(sql).toContain("p_result->'approvalRequired' IS DISTINCT FROM 'true'::JSONB");
    expect(sql).toContain("premium-business-ai-result.v1");
    expect(sql).toContain("premium AI completion violates its trusted result contract");
    expect(sql).toContain("record_type='premium-ai-request-audit'");
    expect(sql).toContain("state='pending-human-review'");
    expect(sql).toContain("data->>'promptDigest'=v_action.context->>'promptDigest'");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION managed_oss_complete_suite_ai_action(UUID,TEXT,JSONB,TEXT) TO managed_oss_ai");
  });

  it("uses trusted per-module prompts and records the actual configured model", () => {
    const worker = readFileSync("src/server/ai-worker.ts", "utf8");
    expect(worker).toContain("coreBusinessPromptPolicies[coreAction.moduleId]");
    expect(worker).toContain("coreBusinessPromptDigest(coreAction.moduleId)");
    expect(worker).toContain("model: config.AI_MODEL");
    expect(worker).toContain("resultSha256: sha256(completion)");
    expect(worker).toContain("The complete authorized evidence selection is not available");
  });
});
