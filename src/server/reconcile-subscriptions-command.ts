import { config } from "./config.js";
import { PostgresRepository } from "./repository.js";
import { parseReconciliationMode, reconcileSubscriptions, StripeSubscriptionSource } from "./subscription-reconciliation.js";

function redact(message: string) {
  return [config.STRIPE_SECRET_KEY, config.DATABASE_URL].filter((value): value is string => Boolean(value)).reduce((safe, value) => safe.replaceAll(value, "[REDACTED]"), message);
}

let repository: PostgresRepository | undefined;
try {
  const mode = parseReconciliationMode(process.argv.slice(2));
  if (!config.DATABASE_URL) throw new Error("Subscription reconciliation requires DATABASE_URL.");
  if (!config.STRIPE_SECRET_KEY) throw new Error("Subscription reconciliation requires STRIPE_SECRET_KEY.");
  repository = new PostgresRepository(config.DATABASE_URL);
  const source = new StripeSubscriptionSource(config.STRIPE_SECRET_KEY);
  const report = await reconcileSubscriptions({ repository, source, compensation: source, apply: mode === "apply" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const message = redact(error instanceof Error ? error.message : "Subscription reconciliation failed.");
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
} finally {
  await repository?.close();
}
