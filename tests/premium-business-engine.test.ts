import { describe, expect, it } from "vitest";
import { PremiumBusinessEngine, type PremiumEngineContext, type PremiumExecutionResult } from "../src/server/premium-business-engine";
import { premiumBusinessActions, premiumBusinessActionsByModule, premiumBusinessModules } from "../src/shared/premium-business-actions";

const tenantA = "tenant-a-0001";
const tenantB = "tenant-b-0001";
const actorA = "actor-a-0001";
const now = "2026-08-24T18:00:00.000Z";

function context(plan: PremiumEngineContext["plan"] = "fleet", tenantId = tenantA, actorId = actorA, requestId = "request-0001"): PremiumEngineContext {
  return { tenantId, actorId, requestId, plan, now: () => new Date(now) };
}

function approval(actorId = actorA) {
  return { approved: true, approvedBy: actorId, approvedAt: now, reason: "Reviewed exact preview and evidence" };
}

function first(result: PremiumExecutionResult) {
  const record = result.records[0];
  if (!record) throw new Error("Expected a durable record.");
  return record;
}

describe("premium clean-room business rewrites", () => {
  it("publishes at least eight specialized CLI/MCP actions per original module with explicit safety metadata", () => {
    expect(premiumBusinessModules.map((module) => module.name)).toEqual(["Northstar Planning", "Harbor Vault", "Threadline", "Ledgerline Operations", "Evident AI Workbench"]);
    for (const module of premiumBusinessModules) {
      const actions = premiumBusinessActionsByModule.get(module.id)!;
      expect(actions.length).toBeGreaterThanOrEqual(8);
      expect(module.minimumMonthlyPlanUsd).toBe(module.minPlan === "scale" ? 50 : 200);
      expect(module.resource.minimumCpuMillicores).toBeGreaterThan(0);
      expect(module.resource.minimumMemoryMiB).toBeGreaterThan(0);
      expect(module.resource.includedStorageGb).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.mcpToolName).toBe(`${module.id}_${action.id.replaceAll("-", "_")}`);
        expect(action.cliExample).toContain(`supersuite ${module.id} ${action.id}`);
        expect(action.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
        if (action.operation !== "read") {
          expect(action.idempotent).toBe(true);
          expect(action.inputSchema.required).toContain("idempotencyKey");
        }
        if (action.externalEffect !== "none") {
          expect(action.requiresApproval).toBe(true);
          expect(action.supportsDryRun).toBe(true);
          expect(action.inputSchema.properties).toHaveProperty("approval");
          expect(action.inputSchema.properties).toHaveProperty("dryRun");
        }
      }
    }
    expect(new Set(premiumBusinessActions.map((action) => action.mcpToolName)).size).toBe(premiumBusinessActions.length);
  });

  it("enforces $50 and $200 eligibility before any premium record is created", async () => {
    const engine = new PremiumBusinessEngine();
    await expect(engine.execute(context("starter"), "projects", "project-create", { key: "roadmap", name: "Roadmap", outcome: "Ship", idempotencyKey: "starter-project-0001" })).rejects.toThrow(/\$50\/month scale plan/);
    expect(engine.listRecords(context("starter"))).toHaveLength(0);

    const project = first(await engine.execute(context("scale"), "projects", "project-create", { key: "roadmap", name: "Roadmap", outcome: "Ship", idempotencyKey: "scale-project-0001" }));
    expect(project.moduleId).toBe("projects");
    const vault = first(await engine.execute(context("scale", tenantA, actorA, "request-vault"), "drive", "vault-create", { name: "Private", classification: "restricted", idempotencyKey: "scale-vault-000001" }));
    expect(vault.moduleId).toBe("drive");
    await expect(engine.execute(context("scale"), "operations", "party-create", { name: "Customer", kind: "customer", currency: "USD", idempotencyKey: "scale-party-000001" })).rejects.toThrow(/\$200\/month fleet plan/);
    await expect(engine.execute(context("scale"), "assistant", "collection-create", { name: "Evidence", purpose: "Ground runs", idempotencyKey: "scale-collection-01" })).rejects.toThrow(/\$200\/month fleet plan/);
    expect(engine.listRecords(context("scale"), { moduleId: "operations" })).toHaveLength(0);
    expect(engine.listRecords(context("scale"), { moduleId: "assistant" })).toHaveLength(0);
  });

  it("keeps every lookup tenant-bound and replays mutations only for identical input", async () => {
    const engine = new PremiumBusinessEngine();
    const input = { key: "tenant-graph", name: "Tenant graph", outcome: "Keep records isolated", idempotencyKey: "tenant-project-0001" };
    const created = await engine.execute(context("scale"), "projects", "project-create", input);
    const replayed = await engine.execute(context("scale", tenantA, actorA, "request-replay"), "projects", "project-create", input);
    expect(first(replayed).id).toBe(first(created).id);
    expect(replayed.audit).toMatchObject({ replayed: true, decision: "replayed", tenantId: tenantA });
    expect(engine.listRecords(context("scale"), { moduleId: "projects", recordType: "project" })).toHaveLength(1);
    await expect(engine.execute(context("scale", tenantA, actorA, "request-conflict"), "projects", "project-create", { ...input, name: "Different" })).rejects.toThrow(/idempotency key was already used/);

    const other = context("scale", tenantB, "actor-b-0001", "request-other");
    expect(engine.getRecord(other, first(created).id)).toBeUndefined();
    await expect(engine.execute(other, "projects", "issue-create", { projectId: first(created).id, title: "Cross tenant", priority: "high", points: 3, idempotencyKey: "cross-tenant-issue-01" })).rejects.toThrow(/not found in this tenant/);
    expect(engine.listAuditReceipts(other)).toHaveLength(0);
  });

  it("rejects dependency cycles and stale or over-capacity cycle commitments", async () => {
    const engine = new PremiumBusinessEngine();
    const ctx = context("scale");
    const project = first(await engine.execute(ctx, "projects", "project-create", { key: "northstar", name: "Northstar", outcome: "Deliver safely", idempotencyKey: "northstar-project-01" }));
    const issueA = first(await engine.execute(ctx, "projects", "issue-create", { projectId: project.id, title: "Foundation", priority: "high", points: 5, idempotencyKey: "northstar-issue-a01" }));
    const issueB = first(await engine.execute(ctx, "projects", "issue-create", { projectId: project.id, title: "Release", priority: "normal", points: 8, idempotencyKey: "northstar-issue-b01" }));
    await engine.execute(ctx, "projects", "dependency-link", { issueId: issueB.id, dependsOnIssueId: issueA.id, expectedVersion: 1, idempotencyKey: "northstar-dependency-01" });
    await expect(engine.execute(ctx, "projects", "dependency-link", { issueId: issueA.id, dependsOnIssueId: issueB.id, expectedVersion: 1, idempotencyKey: "northstar-dependency-02" })).rejects.toThrow(/create a cycle/);
    await expect(engine.execute(ctx, "projects", "cycle-draft", { projectId: project.id, title: "Impossible", capacityPoints: 10, issueIds: [issueA.id, issueB.id], idempotencyKey: "northstar-cycle-bad1" })).rejects.toThrow(/exceed cycle capacity/);
    const cycleResult = await engine.execute(ctx, "projects", "cycle-draft", { projectId: project.id, title: "Cycle one", capacityPoints: 13, issueIds: [issueA.id, issueB.id], idempotencyKey: "northstar-cycle-good" });
    const cycle = first(cycleResult);
    const commit = { cycleId: cycle.id, contentHash: cycle.data.contentHash, dryRun: false, idempotencyKey: "northstar-cycle-commit" };
    await expect(engine.execute(ctx, "projects", "cycle-commit", commit)).rejects.toThrow(/human approval/);
    const preview = await engine.execute(ctx, "projects", "cycle-commit", { ...commit, dryRun: true, idempotencyKey: "northstar-cycle-preview" });
    expect(preview).toMatchObject({ records: [], preview: { wouldCommit: cycle.id }, audit: { dryRun: true, decision: "previewed" } });
    const committed = first(await engine.execute(ctx, "projects", "cycle-commit", { ...commit, approval: approval() }));
    expect(committed.state).toBe("active");
  });

  it("requires dry-run or approval for files and blocks deletion during retention or legal hold", async () => {
    const engine = new PremiumBusinessEngine();
    const ctx = context("scale");
    const vault = first(await engine.execute(ctx, "drive", "vault-create", { name: "Contracts", classification: "restricted", idempotencyKey: "harbor-vault-00001" }));
    const register = { vaultId: vault.id, name: "agreement.pdf", objectKey: "tenant/contracts/agreement-v1", contentType: "application/pdf", sizeBytes: 2048, checksum: "a".repeat(64), dryRun: false, idempotencyKey: "harbor-file-register" };
    await expect(engine.execute(ctx, "drive", "file-register", register)).rejects.toThrow(/human approval/);
    const dry = await engine.execute(ctx, "drive", "file-register", { ...register, dryRun: true, idempotencyKey: "harbor-file-preview1" });
    expect(dry.records).toHaveLength(0);
    expect(engine.listRecords(ctx, { moduleId: "drive", recordType: "file" })).toHaveLength(0);
    const fileResult = await engine.execute(ctx, "drive", "file-register", { ...register, approval: approval() });
    const file = fileResult.records.find((record) => record.recordType === "file")!;
    expect(fileResult.records.find((record) => record.recordType === "file-version")?.state).toBe("immutable");

    const retention = first(await engine.execute(ctx, "drive", "retention-set", { fileId: file.id, retainUntil: "2027-08-24T18:00:00.000Z", legalHold: true, expectedVersion: 1, approval: approval(), dryRun: false, idempotencyKey: "harbor-retention-001" }));
    await expect(engine.execute(ctx, "drive", "file-delete", { fileId: file.id, expectedVersion: retention.version, reason: "Requested deletion", approval: approval(), dryRun: false, idempotencyKey: "harbor-delete-0001" })).rejects.toThrow(/legal hold/);
    const sharePreview = await engine.execute(ctx, "drive", "share-preview", { fileId: file.id, expiresAt: "2026-08-25T18:00:00.000Z", permission: "view" });
    await expect(engine.execute(ctx, "drive", "share-create", { fileId: file.id, expiresAt: "2026-08-25T18:00:00.000Z", permission: "view", previewHash: "0".repeat(64), approval: approval(), dryRun: false, idempotencyKey: "harbor-share-00001" })).rejects.toThrow(/preview hash/);
    const shared = await engine.execute(ctx, "drive", "share-create", { fileId: file.id, expiresAt: "2026-08-25T18:00:00.000Z", permission: "view", previewHash: sharePreview.preview!.previewHash, approval: approval(), dryRun: false, idempotencyKey: "harbor-share-00002" });
    expect(shared.privateOutput?.shareToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(first(shared).data).toMatchObject({ tokenStoredPlaintext: false });
  });

  it("posts only the exact approved message and queues evidence-only summaries with no fabricated output", async () => {
    const engine = new PremiumBusinessEngine();
    const ctx = context("scale");
    const stream = first(await engine.execute(ctx, "channels", "stream-create", { key: "launch", name: "Launch", purpose: "Coordinate launch decisions", idempotencyKey: "threadline-stream-01" }));
    const topic = first(await engine.execute(ctx, "channels", "topic-create", { streamId: stream.id, title: "Release window", intent: "Choose a release window", idempotencyKey: "threadline-topic-001" }));
    const preview = await engine.execute(ctx, "channels", "message-preview", { topicId: topic.id, body: "Propose Tuesday at 14:00 UTC." });
    const postInput = { topicId: topic.id, body: "Propose Tuesday at 14:00 UTC.", previewHash: preview.preview!.previewHash, dryRun: false, idempotencyKey: "threadline-message-1" };
    await expect(engine.execute(ctx, "channels", "message-post", postInput)).rejects.toThrow(/human approval/);
    const dry = await engine.execute(ctx, "channels", "message-post", { ...postInput, dryRun: true, idempotencyKey: "threadline-message-dry" });
    expect(dry.records).toHaveLength(0);
    const posted = first(await engine.execute(ctx, "channels", "message-post", { ...postInput, approval: approval() }));
    expect(posted.state).toBe("posted");

    const summary = first(await engine.execute(ctx, "channels", "topic-summarize", { topicId: topic.id, question: "What was proposed?", evidenceIds: [posted.id], promptVersion: "threadline-summary-v1", modelId: "local/grounded-small", approval: approval(), dryRun: false, idempotencyKey: "threadline-summary-01" }));
    expect(summary).toMatchObject({ recordType: "ai-request", state: "queued", data: { aiAudit: { promptVersion: "threadline-summary-v1", modelId: "local/grounded-small", confidence: null, evidenceIds: [posted.id], review: { status: "pending", required: true }, output: null, fabricatedOutputAllowed: false }, automaticMutationAllowed: false } });
    expect(JSON.stringify(summary.data)).not.toContain("Propose Tuesday at 14:00 UTC.");
  });

  it("validates exact double-entry balance and never lets an unapproved accounting fact post", async () => {
    const engine = new PremiumBusinessEngine();
    const ctx = context("fleet");
    const party = first(await engine.execute(ctx, "operations", "party-create", { name: "Acme", kind: "customer", currency: "USD", idempotencyKey: "ledgerline-party-01" }));
    const item = first(await engine.execute(ctx, "operations", "item-create", { sku: "CONSULT", name: "Consulting", currency: "USD", unitPriceMinor: 25000, idempotencyKey: "ledgerline-item-001" }));
    const order = first(await engine.execute(ctx, "operations", "order-create", { partyId: party.id, currency: "USD", lines: [{ itemId: item.id, quantity: 2 }], idempotencyKey: "ledgerline-order-01" }));
    expect(order.data.totalMinor).toBe(50000);
    const invoiceDraft = first(await engine.execute(ctx, "operations", "invoice-draft", { orderId: order.id, issueAt: now, dueAt: "2026-09-24T18:00:00.000Z", idempotencyKey: "ledgerline-invoice-1" }));
    const invoice = first(await engine.execute(ctx, "operations", "invoice-issue", { invoiceId: invoiceDraft.id, contentHash: invoiceDraft.data.contentHash, approval: approval(), dryRun: false, idempotencyKey: "ledgerline-issue-001" }));
    expect(invoice.state).toBe("open");

    await expect(engine.execute(ctx, "operations", "journal-preview", { currency: "USD", period: "2026-08", memo: "Broken", entries: [{ account: "cash", debitMinor: 50000, creditMinor: 0 }, { account: "revenue", debitMinor: 0, creditMinor: 49000 }] })).rejects.toThrow(/balance exactly/);
    const journalInput = { currency: "USD", period: "2026-08", memo: "Recognize revenue", entries: [{ account: "cash", debitMinor: 50000, creditMinor: 0 }, { account: "revenue", debitMinor: 0, creditMinor: 50000 }] };
    const journalPreview = await engine.execute(ctx, "operations", "journal-preview", journalInput);
    const postInput = { ...journalInput, previewHash: journalPreview.preview!.previewHash, dryRun: false, idempotencyKey: "ledgerline-journal-01" };
    await expect(engine.execute(ctx, "operations", "journal-post", postInput)).rejects.toThrow(/human approval/);
    const journal = first(await engine.execute(ctx, "operations", "journal-post", { ...postInput, approval: approval() }));
    expect(journal).toMatchObject({ state: "posted", data: { debitMinor: 50000, creditMinor: 50000, immutable: true } });
    const payment = await engine.execute(ctx, "operations", "payment-record", { invoiceId: invoice.id, amountMinor: 50000, currency: "USD", reference: "bank-001", approval: approval(), dryRun: false, idempotencyKey: "ledgerline-payment-1" });
    expect(payment.records.find((record) => record.recordType === "invoice")).toMatchObject({ state: "paid", data: { balanceMinor: 0 } });
  });

  it("binds AI runs to prompt, model, evidence, confidence, review, and constrained agent allowlists", async () => {
    const engine = new PremiumBusinessEngine();
    const ctx = context("fleet");
    const project = first(await engine.execute(ctx, "projects", "project-create", { key: "evidence", name: "Evidence", outcome: "Ground every claim", idempotencyKey: "evident-project-001" }));
    const collection = first(await engine.execute(ctx, "assistant", "collection-create", { name: "Launch evidence", purpose: "Ground launch analysis", idempotencyKey: "evident-collection-1" }));
    await engine.execute(ctx, "assistant", "source-attach", { collectionId: collection.id, recordId: project.id, citationLabel: "Project outcome", contentHash: "b".repeat(64), idempotencyKey: "evident-source-0001" });
    const prompt = first(await engine.execute(ctx, "assistant", "prompt-version-create", { name: "Grounded analysis", systemInstruction: "Use only cited records. Omit unsupported claims.", inputContract: { goal: "string", evidenceIds: "uuid[]" }, outputContract: { summary: "string", claims: [{ text: "string", evidenceIds: "uuid[]" }] }, idempotencyKey: "evident-prompt-0001" }));
    const runInput = { promptVersionId: prompt.id, collectionId: collection.id, evidenceIds: [project.id], modelId: "local/qwen-audited", goal: "Explain the intended outcome" };
    const preview = await engine.execute(ctx, "assistant", "run-preview", runInput);
    expect(preview.preview).toMatchObject({ modelInvoked: false, output: null, promptContentHash: prompt.data.contentHash });
    const run = first(await engine.execute(ctx, "assistant", "run-execute", { ...runInput, previewHash: preview.preview!.previewHash, approval: approval(), dryRun: false, idempotencyKey: "evident-run-000001" }));
    expect(run.data).toMatchObject({ aiAudit: { promptVersion: prompt.data.contentHash, modelId: "local/qwen-audited", confidence: null, evidenceIds: [project.id], review: { status: "pending", required: true }, output: null, fabricatedOutputAllowed: false }, automaticMutationAllowed: false });

    await expect(engine.execute(ctx, "assistant", "result-record", { runId: run.id, output: { summary: "Unsupported", claims: [{ text: "Made up", evidenceIds: [collection.id] }] }, confidence: 99, evidenceIds: [project.id], review: { status: "approved", reviewedBy: actorA, reviewedAt: now, notes: "Reviewed" }, approval: approval(), dryRun: false, idempotencyKey: "evident-result-bad1" })).rejects.toThrow(/claim must cite only/);
    const recorded = await engine.execute(ctx, "assistant", "result-record", { runId: run.id, output: { summary: "The project has a defined outcome.", claims: [{ text: "The intended outcome is to ground every claim.", evidenceIds: [project.id] }] }, confidence: 87, evidenceIds: [project.id], review: { status: "approved", reviewedBy: actorA, reviewedAt: now, notes: "Evidence checked" }, approval: approval(), dryRun: false, idempotencyKey: "evident-result-good" });
    expect(recorded.records.find((record) => record.recordType === "ai-result")).toMatchObject({ state: "approved", data: { confidence: 87, promptVersion: prompt.data.contentHash, modelId: "local/qwen-audited", evidenceIds: [project.id], review: { status: "approved", reviewedBy: actorA }, fabricatedOutputAllowed: false } });

    await expect(engine.execute(ctx, "assistant", "agent-draft", { name: "Unsafe", purpose: "Unknown tool", promptVersionId: prompt.id, allowedActions: ["shell_execute"], maximumSteps: 3, idempotencyKey: "evident-agent-bad01" })).rejects.toThrow(/registered premium MCP/);
    const agentDraft = first(await engine.execute(ctx, "assistant", "agent-draft", { name: "Planner", purpose: "Propose one cited planning action", promptVersionId: prompt.id, allowedActions: ["projects_issue_create"], maximumSteps: 3, idempotencyKey: "evident-agent-good1" }));
    const agent = first(await engine.execute(ctx, "assistant", "agent-approve", { agentId: agentDraft.id, contentHash: agentDraft.data.contentHash, approval: approval(), dryRun: false, idempotencyKey: "evident-agent-approve" }));
    const agentRun = first(await engine.execute(ctx, "assistant", "agent-execute", { agentId: agent.id, goal: "Propose next work", evidenceIds: [project.id], modelId: "local/qwen-audited", approval: approval(), dryRun: false, idempotencyKey: "evident-agent-run01" }));
    expect(agentRun.data).toMatchObject({ automaticMutationAllowed: false, proposalsRequireSeparateApproval: true, allowedActions: ["projects_issue_create"] });
  });
});
