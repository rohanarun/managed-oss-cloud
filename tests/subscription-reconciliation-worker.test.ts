import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/server/repository";
import { reconciliationAlert, runReconciliationPass } from "../src/server/subscription-reconciliation-worker";

describe("scheduled subscription reconciliation", () => {
  it("runs in explicit apply mode and reports provider-integrity revocations as alerts", async () => {
    const repository = new MemoryRepository();
    const user = await repository.createUser({ email: "scheduled-reconcile@example.com", displayName: "Scheduled reconciliation", passwordHash: "unused" });
    const installation = await repository.createInstallation({ userId: user.id, appIds: [], name: "Scheduled", plan: "starter", state: "live", hostname: "scheduled.apps.example.com", customDomains: [] });
    await repository.recordSubscription({ userId: user.id, installationId: installation.id, providerSubscriptionId: "sub_scheduled_invalid", status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
    const report = await runReconciliationPass({
      repository,
      source: { listAllSubscriptions: async () => [{ id: "sub_scheduled_invalid", status: "active", infrastructureMonthlyCents: 0, platformFeeMonthlyCents: 0, problems: ["missing_user_metadata"] }] },
      mode: "apply",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });

    expect(report.mode).toBe("apply");
    expect(await repository.getEffectiveSuitePlan(user.id)).toBe("none");
    expect(reconciliationAlert(report)).toEqual({ severity: "error", code: "stripe_entitlement_integrity_problem", count: 1 });
  });

  it("keeps a dry run non-mutating and omits alerts for a clean provider snapshot", async () => {
    const repository = new MemoryRepository();
    const report = await runReconciliationPass({ repository, source: { listAllSubscriptions: async () => [] }, mode: "dry-run" });
    expect(report.mode).toBe("dry-run");
    expect(reconciliationAlert(report)).toBeUndefined();
  });
});
