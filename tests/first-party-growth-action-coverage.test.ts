import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  executeFirstPartyGrowthAction,
  firstPartyGrowthApprovalFreshnessMs,
  type FirstPartyGrowthAuthorization,
  type FirstPartyGrowthEngineDependencies,
} from "../src/server/first-party-growth-engine.js";
import { executeSuiteAction, type SuiteEngineDependencies } from "../src/server/suite-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";
import { firstPartyGrowthActions } from "../src/shared/first-party-growth-actions.js";

const now = new Date("2026-08-24T16:00:00.000Z");
const deps: FirstPartyGrowthEngineDependencies = {
  now: () => now,
  modelPolicyId: "local-growth-action-coverage-model",
  publicBaseUrl: "https://cloud.example.test",
  randomBytes: (size) => Buffer.alloc(size, 11),
};

function key(label: string) {
  return `growth.coverage.${label}.0001`;
}

function approval(auth: FirstPartyGrowthAuthorization, label: string) {
  return {
    approved: true as const,
    approvedBy: auth.userId,
    approvedAt: now.toISOString(),
    decisionId: `growth.coverage.${label}.approval.0001`,
    reason: `Reviewed the exact ${label} input and bounded hosted effect.`,
  };
}

async function actor(store: MemorySuiteStore): Promise<FirstPartyGrowthAuthorization> {
  const userId = randomUUID();
  const workspace = await store.getOrCreateWorkspace(userId);
  for (const moduleId of ["giveaways", "testimonials", "brand-pages"]) await store.enableModule(userId, moduleId);
  const current = await store.getOrCreateWorkspace(userId);
  return { userId, workspaceId: workspace.id, role: current.currentRole!, scopes: ["*"] };
}

async function member(store: MemorySuiteStore, owner: FirstPartyGrowthAuthorization): Promise<FirstPartyGrowthAuthorization> {
  const userId = randomUUID();
  await store.addWorkspaceMember(owner.userId, userId, "member");
  const workspace = await store.getOrCreateWorkspace(userId);
  return { userId, workspaceId: workspace.id, role: workspace.currentRole!, scopes: ["*"] };
}

async function run(store: MemorySuiteStore, auth: FirstPartyGrowthAuthorization, moduleId: string, actionId: string, input: Record<string, unknown>) {
  return executeFirstPartyGrowthAction(store, auth, moduleId, actionId, input, deps);
}

function first(result: Awaited<ReturnType<typeof executeFirstPartyGrowthAction>>) {
  const record = result.records[0];
  if (!record) throw new Error(`Expected ${result.action.moduleId}:${result.action.id} to return a record.`);
  return record;
}

describe("previously uncovered first-party growth actions", () => {
  it("requires fresh single-use approvals, binds receipts, and rejects cross-actor replay", async () => {
    for (const action of firstPartyGrowthActions.filter((candidate) => candidate.destructive || candidate.externalEffect)) {
      expect(action.inputSchema.properties.approval).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["approved", "approvedBy", "approvedAt", "decisionId", "reason"]),
        properties: { approvedAt: { type: "string", format: "date-time" } },
        additionalProperties: false,
      });
    }

    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const contest = first(await run(store, auth, "giveaways", "contest-create", {
      name: "Approval boundary contest",
      closesAt: "2026-08-25T16:00:00.000Z",
      rules: "One reviewed entry per participant.",
      entropyCommitment: createHash("sha256").update("approval-boundary-secret").digest("hex"),
      consentPolicyVersion: "contest-v1",
      idempotencyKey: key("approval-contest-create"),
    }));
    const publishInput = {
      contestId: contest.id,
      expectedVersion: 1,
      rulesHash: contest.data.rulesHash,
      dryRun: false,
    };
    await expect(run(store, auth, "giveaways", "contest-publish", {
      ...publishInput,
      approval: { ...approval(auth, "stale-contest-publish"), approvedAt: new Date(now.getTime() - firstPartyGrowthApprovalFreshnessMs - 1).toISOString() },
      idempotencyKey: key("stale-contest-publish"),
    })).rejects.toThrow(/stale/);
    await expect(run(store, auth, "giveaways", "contest-publish", {
      ...publishInput,
      approval: { ...approval(auth, "future-contest-publish"), approvedAt: new Date(now.getTime() + 1).toISOString() },
      idempotencyKey: key("future-contest-publish"),
    })).rejects.toThrow(/future-dated/);

    const committedApproval = approval(auth, "single-use-contest-publish");
    await run(store, auth, "giveaways", "contest-publish", {
      ...publishInput,
      approval: committedApproval,
      idempotencyKey: key("single-use-contest-publish"),
    });
    const publishReceipt = (await store.listRecords(auth.userId, { recordType: "growth-command-receipt", limit: 100 }))
      .find((record) => record.data.idempotencyKey === key("single-use-contest-publish"));
    expect(publishReceipt).toMatchObject({
      moduleId: "giveaways",
      data: {
        actorUserId: auth.userId,
        workspaceId: auth.workspaceId,
        approvalDecisionId: committedApproval.decisionId,
        audit: {
          approvalDecisionId: committedApproval.decisionId,
          approvedBy: auth.userId,
          approvedAt: now.toISOString(),
        },
      },
    });

    const page = first(await run(store, auth, "brand-pages", "page-create", {
      slug: "approval-boundary",
      name: "Approval boundary",
      privacyMode: "no-analytics",
      locale: "en-US",
      idempotencyKey: key("approval-page-create"),
    }));
    await expect(run(store, auth, "brand-pages", "route-disable", {
      routeId: page.id,
      routeKind: "page",
      reason: "A separate module must require a separate decision.",
      dryRun: false,
      approval: committedApproval,
      idempotencyKey: key("cross-module-decision-reuse"),
    })).rejects.toThrow(/decision ID is already bound/);
    expect(await store.getRecord(auth.userId, page.id)).toMatchObject({ state: "private" });

    const peer = await member(store, auth);
    const actorBoundInput = {
      slug: "actor-bound-replay",
      name: "Actor-bound replay",
      privacyMode: "aggregate",
      locale: "en-US",
      idempotencyKey: key("actor-bound-page-create"),
    };
    await run(store, auth, "brand-pages", "page-create", actorBoundInput);
    await expect(run(store, peer, "brand-pages", "page-create", actorBoundInput)).rejects.toThrow(/another authenticated actor/);
  });

  it("blocks cross-requester AI-audit evidence through the outer suite dispatch transaction", async () => {
    const store = new MemorySuiteStore("fleet");
    const owner = await actor(store);
    const page = first(await run(store, owner, "brand-pages", "page-create", {
      slug: "private-audit-source",
      name: "Private audit source",
      privacyMode: "aggregate",
      locale: "en-US",
      idempotencyKey: key("private-audit-page"),
    }));
    const collection = first(await run(store, owner, "testimonials", "collection-create", {
      name: "Private audit collection",
      purpose: "Collect consented evidence for reviewed publication.",
      consentPolicyVersion: "testimonial-consent-v1",
      retentionDays: 365,
      allowedLocales: ["en-US"],
      idempotencyKey: key("private-audit-collection"),
    }));
    const ownerProposal = await run(store, owner, "brand-pages", "page-copy-propose", {
      pageId: page.id,
      instruction: "Draft copy from the selected page only.",
      evidenceIds: [page.id],
      idempotencyKey: key("private-owner-proposal"),
    });
    const privateAudit = first(ownerProposal);
    expect(privateAudit).toMatchObject({ recordType: "ai-request-audit", data: { requestedByUserId: owner.userId } });

    const peer = await member(store, owner);
    const dispatchDeps: SuiteEngineDependencies = {
      now: () => now,
      resolveTxt: async () => [],
      resolveHost: async () => [],
      publicBaseUrl: deps.publicBaseUrl,
    };
    const attempts = [
      { moduleId: "brand-pages", actionId: "page-copy-propose", target: { pageId: page.id }, label: "brand-private-audit" },
      { moduleId: "testimonials", actionId: "review-highlights-propose", target: { collectionId: collection.id }, label: "testimonial-private-audit" },
    ];
    for (const attempt of attempts) {
      await expect(store.runInWorkspaceTransaction(peer.userId, () => executeSuiteAction(store, peer.userId, attempt.moduleId, attempt.actionId, {
        ...attempt.target,
        instruction: "Do not expose another requester's private AI audit.",
        evidenceIds: [privateAudit.id],
        idempotencyKey: key(attempt.label),
      }, dispatchDeps))).rejects.toThrow(/evidence not found/);
    }
    expect(await store.listRecords(owner.userId, { recordType: "ai-request-audit", limit: 100 })).toEqual([privateAudit]);
  });

  it("executes giveaway fraud review, consent revocation, and a private export manifest", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const entropyReveal = "coverage-organizer-secret";
    const contest = first(await run(store, auth, "giveaways", "contest-create", {
      name: "Coverage contest",
      closesAt: "2026-08-25T16:00:00.000Z",
      rules: "One consented entry per participant.",
      entropyCommitment: createHash("sha256").update(entropyReveal).digest("hex"),
      consentPolicyVersion: "contest-v1",
      idempotencyKey: key("contest-create"),
    }));
    await run(store, auth, "giveaways", "contest-publish", {
      contestId: contest.id,
      expectedVersion: 1,
      rulesHash: contest.data.rulesHash,
      dryRun: false,
      approval: approval(auth, "contest-publish"),
      idempotencyKey: key("contest-publish"),
    });
    const registered = await run(store, auth, "giveaways", "entry-register", {
      contestId: contest.id,
      participantKeyHash: "a".repeat(64),
      consent: { granted: true, policyVersion: "contest-v1", purposes: ["contest-administration"], capturedAt: now.toISOString(), captureMethod: "hosted-form" },
      sourceAttestation: "hosted-form",
      idempotencyKey: key("entry-register"),
    });
    const entry = registered.records.find((record) => record.recordType === "entrant")!;
    const signal = first(await run(store, auth, "giveaways", "fraud-signal-record", {
      entryId: entry.id,
      signalKind: "velocity-anomaly",
      severity: "low",
      evidenceIds: [entry.id],
      observationSummary: "A pseudonymous submission interval needs attributable human review.",
      idempotencyKey: key("fraud-signal"),
    }));

    const proposal = await run(store, auth, "giveaways", "fraud-review-propose", {
      contestId: contest.id,
      instruction: "Summarize only the selected behavioral evidence and uncertainty.",
      evidenceIds: [contest.id, entry.id, signal.id],
      idempotencyKey: key("fraud-review"),
    });
    expect(proposal).toMatchObject({
      kind: "ai-action",
      aiAction: { status: "queued", moduleId: "giveaways" },
      audit: {
        targetRecordId: contest.id,
        evidenceIds: [contest.id, entry.id, signal.id],
        modelExecuted: false,
        externalEffectExecuted: false,
      },
    });

    const revoked = await run(store, auth, "giveaways", "entry-consent-revoke", {
      entryId: entry.id,
      reason: "Participant requested withdrawal.",
      dryRun: false,
      approval: approval(auth, "entry-consent-revoke"),
      idempotencyKey: key("entry-consent-revoke"),
    });
    expect(revoked.audit).toMatchObject({ eligibilityRemoved: true, completedDrawProofRetained: false, externalEffectExecuted: false });
    expect(revoked.records.find((record) => record.id === entry.id)).toMatchObject({ state: "revoked", data: { weight: 0, public: false } });
    expect(revoked.records.some((record) => record.recordType === "consent-revocation" && record.data.immutable === true)).toBe(true);

    const exported = await run(store, auth, "giveaways", "contest-export-manifest", {
      contestId: contest.id,
      format: "canonical-json",
      includeRevokedAudit: true,
      idempotencyKey: key("contest-export"),
    });
    expect(first(exported)).toMatchObject({ recordType: "export-manifest", state: "ready", data: { contestId: contest.id, includeRevokedAudit: true, private: true } });
    expect(exported.audit).toMatchObject({ private: true, recordCount: expect.any(Number), manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("executes brand-page AI copy proposal and approved route disable against a published immutable version", async () => {
    const store = new MemorySuiteStore("fleet");
    const auth = await actor(store);
    const page = first(await run(store, auth, "brand-pages", "page-create", {
      slug: "coverage-page",
      name: "Coverage page",
      privacyMode: "aggregate",
      locale: "en-US",
      idempotencyKey: key("page-create"),
    }));
    const destination = first(await run(store, auth, "brand-pages", "destination-version-create", {
      pageId: page.id,
      linkKey: "docs",
      destination: "https://example.com/docs",
      label: "Read the docs",
      accessibilityLabel: "Open product documentation",
      idempotencyKey: key("destination-create"),
    }));
    const pageVersion = first(await run(store, auth, "brand-pages", "page-version-create", {
      pageId: page.id,
      title: "Build in public",
      description: "Products, notes, and contact links.",
      links: [{ key: "docs", label: "Read the docs", destinationVersionId: destination.id, accessibilityLabel: "Open product documentation" }],
      layout: "editorial",
      theme: { accent: "#14B8A6", background: "#0B1020", foreground: "#F8FAFC", radiusPx: 18 },
      idempotencyKey: key("page-version-create"),
    }));
    await run(store, auth, "brand-pages", "page-version-publish", {
      pageVersionId: pageVersion.id,
      contentHash: pageVersion.data.contentHash,
      dryRun: false,
      approval: approval(auth, "page-version-publish"),
      idempotencyKey: key("page-version-publish"),
    });

    const proposal = await run(store, auth, "brand-pages", "page-copy-propose", {
      pageId: page.id,
      instruction: "Draft concise copy using only the selected immutable page facts.",
      evidenceIds: [page.id, pageVersion.id, destination.id],
      idempotencyKey: key("page-copy-propose"),
    });
    expect(proposal).toMatchObject({
      kind: "ai-action",
      aiAction: { status: "queued", moduleId: "brand-pages" },
      audit: {
        targetRecordId: page.id,
        evidenceIds: [page.id, pageVersion.id, destination.id],
        modelExecuted: false,
        externalEffectExecuted: false,
      },
    });

    const disabled = await run(store, auth, "brand-pages", "route-disable", {
      routeId: page.id,
      routeKind: "page",
      reason: "Campaign ended.",
      dryRun: false,
      approval: approval(auth, "route-disable"),
      idempotencyKey: key("route-disable"),
    });
    expect(first(disabled)).toMatchObject({ state: "disabled", data: { public: false, activePageVersionId: null, disabledReason: "Campaign ended." } });
    expect(disabled.audit).toMatchObject({ routeId: page.id, routeKind: "page", publicSurfaceChanged: true, externalEffectExecuted: true, versionHistoryRetained: true });
    expect((await store.getRecord(auth.userId, pageVersion.id))).toMatchObject({ state: "published", data: { public: true } });
  });
});
