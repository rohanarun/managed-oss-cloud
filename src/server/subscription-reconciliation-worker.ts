import { setTimeout as wait } from "node:timers/promises";
import { config } from "./config.js";
import { PostgresRepository, type Repository } from "./repository.js";
import { reconcileSubscriptions, StripeSubscriptionSource, type PaidCapacityCompensationProvider, type SubscriptionReconciliationReport, type SubscriptionSource } from "./subscription-reconciliation.js";

export function reconciliationAlert(report: SubscriptionReconciliationReport) {
  if (report.summary.paidCapacityCompensationRequired > 0) return { severity: "error" as const, code: "paid_capacity_compensation_required", count: report.summary.paidCapacityCompensationRequired };
  const invalid = report.summary.deactivateInvalidProvider
    + report.summary.deactivateOwnershipMismatch
    + report.summary.skippedInvalidProvider
    + report.summary.skippedOwnershipMismatch;
  return invalid > 0
    ? { severity: "error" as const, code: "stripe_entitlement_integrity_problem", count: invalid }
    : report.summary.paidCapacityPending > 0
      ? { severity: "warning" as const, code: "paid_capacity_recovery_pending", count: report.summary.paidCapacityPending }
      : undefined;
}

export async function runReconciliationPass(input: {
  repository: Repository;
  source: SubscriptionSource;
  compensation?: PaidCapacityCompensationProvider;
  mode: "dry-run" | "apply";
  now?: () => Date;
}) {
  return reconcileSubscriptions({ repository: input.repository, source: input.source, compensation: input.compensation, apply: input.mode === "apply", now: input.now });
}

function safeError(error: unknown) {
  const raw = error instanceof Error ? error.message : "Subscription reconciliation failed.";
  return [config.STRIPE_SECRET_KEY, config.DATABASE_URL]
    .filter((value): value is string => Boolean(value))
    .reduce((message, secret) => message.replaceAll(secret, "[REDACTED]"), raw);
}

async function main() {
  if (config.SUBSCRIPTION_RECONCILIATION_MODE === "disabled") throw new Error("Scheduled subscription reconciliation is disabled.");
  if (config.BILLING_MODE !== "live") throw new Error("Scheduled subscription reconciliation requires BILLING_MODE=live.");
  if (!config.DATABASE_URL) throw new Error("Scheduled subscription reconciliation requires DATABASE_URL.");
  if (!config.STRIPE_SECRET_KEY) throw new Error("Scheduled subscription reconciliation requires STRIPE_SECRET_KEY.");
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((argument) => argument !== "--once") || argumentsList.filter((argument) => argument === "--once").length > 1) throw new Error("Usage: npm run reconcile:subscriptions:worker -- [--once]");
  const once = argumentsList.includes("--once");
  const repository = new PostgresRepository(config.DATABASE_URL);
  const source = new StripeSubscriptionSource(config.STRIPE_SECRET_KEY);
  try {
    do {
      try {
        const report = await runReconciliationPass({ repository, source, compensation: source, mode: config.SUBSCRIPTION_RECONCILIATION_MODE });
        const alert = reconciliationAlert(report);
        process.stdout.write(`${JSON.stringify({ event: "subscription_reconciliation", mode: report.mode, generatedAt: report.generatedAt, summary: report.summary, entitlements: report.entitlements.length, alert })}\n`);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ event: "subscription_reconciliation_failed", severity: "error", error: safeError(error) })}\n`);
        if (once) throw error;
      }
      if (!once) await wait(config.SUBSCRIPTION_RECONCILIATION_INTERVAL_MILLISECONDS);
    } while (!once);
  } finally {
    await repository.close();
  }
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "subscription_reconciliation_worker_stopped", severity: "error", error: safeError(error) })}\n`);
    process.exitCode = 1;
  });
}
