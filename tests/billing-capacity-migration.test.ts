import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDatabaseMigrations } from "../src/server/database-migrations";

describe("billing capacity atomicity migration", () => {
  const sql = readFileSync("db/migrations/013-billing-capacity-atomicity.sql", "utf8");

  it("keeps terminal history while permitting only one active recovery per installation", () => {
    expect(sql).toMatch(/installation_id UUID NOT NULL REFERENCES installations\(id\)/);
    expect(sql).not.toMatch(/installation_id UUID NOT NULL UNIQUE/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX paid_checkout_capacity_recoveries_active_installation_idx[\s\S]*WHERE state IN \('pending_capacity','compensation_required'\)/);
    expect(sql).toMatch(/cancel_subscription_and_refund_captured_payment/);
  });

  it("records exact provider confirmation for expired resize convergence", async () => {
    expect(sql).toMatch(/provider_committed_at TIMESTAMPTZ/);
    expect(sql).toMatch(/provider_confirmation_source TEXT/);
    expect(sql).toMatch(/OLD\.state='expired'[\s\S]*NEW\.state='consumed'[\s\S]*provider_confirmation_source/);
    const migrations = await loadDatabaseMigrations();
    expect(migrations.map(({ version }) => version)).toEqual(expect.arrayContaining(["012", "013", "014"]));
    expect(migrations.findIndex(({ version }) => version === "012")).toBeLessThan(migrations.findIndex(({ version }) => version === "013"));
    expect(migrations.findIndex(({ version }) => version === "013")).toBeLessThan(migrations.findIndex(({ version }) => version === "014"));
  });
});
