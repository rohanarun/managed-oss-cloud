import type pg from "pg";
import { describe, expect, it } from "vitest";
import { backfillLegacyPaidPlanCapacity } from "../src/server/legacy-capacity-backfill";
import type { ComputePlan } from "../src/shared/types";

interface Step {
  sql: RegExp;
  result: { rows: Record<string, unknown>[]; rowCount?: number } | ((parameters: unknown[] | undefined) => { rows: Record<string, unknown>[]; rowCount?: number });
}

class ScriptedClient {
  readonly calls: Array<{ sql: string; parameters?: unknown[] }> = [];
  released = false;
  constructor(private readonly steps: Step[]) {}
  async query(sql: string, parameters?: unknown[]) {
    this.calls.push({ sql, parameters });
    const step = this.steps.shift();
    if (!step) throw new Error(`Unexpected query: ${sql}`);
    if (!step.sql.test(sql)) throw new Error(`Expected ${step.sql}, received ${sql}`);
    const result = typeof step.result === "function" ? step.result(parameters) : step.result;
    return { ...result, rowCount: result.rowCount ?? result.rows.length };
  }
  release() { this.released = true; }
  expectComplete() { expect(this.steps).toHaveLength(0); }
}

const poolFor = (client: ScriptedClient) => ({ connect: async () => client }) as unknown as pg.Pool;
const result = (rows: Record<string, unknown>[] = [], rowCount = rows.length) => ({ rows, rowCount });
const starter: ComputePlan = { id: "starter", label: "Starter", memoryMb: 1_536, cpu: 0.5, storageGb: 10, maxServices: 2, infrastructureMonthlyCents: 500, monthlyCents: 700 };
const installationId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const subscriptionId = "10000000-0000-4000-8000-000000000003";
const workerId = "managed-oss-host-worker-0";
const paidRow = (overrides: Record<string, unknown> = {}) => ({
  installation_id: installationId,
  installation_user_id: userId,
  installation_plan: "starter",
  installation_worker_node_id: null,
  subscription_id: subscriptionId,
  subscription_user_id: userId,
  subscription_infrastructure_monthly_cents: 500,
  subscription_platform_fee_monthly_cents: 200,
  ...overrides,
});
const applications = (overrides: Record<string, unknown> = {}) => [
  { id: "20000000-0000-4000-8000-000000000001", installation_id: installationId, worker_node_id: workerId, memory_reservation_mb: 800, cpu_reservation_millis: 250, storage_reservation_gb: 4, ...overrides },
  { id: "20000000-0000-4000-8000-000000000002", installation_id: installationId, worker_node_id: workerId, memory_reservation_mb: 500, cpu_reservation_millis: 250, storage_reservation_gb: 6, ...overrides },
];
const transactionPrefix = (checkoutRows: Record<string, unknown>[] = [], planChangeRows: Record<string, unknown>[] = []) => [
  { sql: /BEGIN ISOLATION LEVEL SERIALIZABLE/, result: result() },
  { sql: /pg_advisory_xact_lock\(hashtextextended/, result: result([{ pg_advisory_xact_lock: null }]) },
  { sql: /FROM checkout_capacity_holds WHERE state='active'.*FOR UPDATE/s, result: result(checkoutRows) },
  ...(checkoutRows.length ? [] : [{ sql: /FROM plan_capacity_change_holds WHERE state='active'.*FOR UPDATE/s, result: result(planChangeRows) }]),
] satisfies Step[];

describe("legacy paid-plan capacity backfill", () => {
  it("derives one app worker, persists the configured plan snapshot and audit atomically, then retries without writes", async () => {
    let allocationId = "";
    const first = new ScriptedClient([
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([paidRow()]) },
      { sql: /FROM application_instances[\s\S]*FOR UPDATE/, result: result(applications()) },
      { sql: /FROM installation_capacity_allocations[\s\S]*FOR UPDATE/, result: result() },
      { sql: /FROM worker_nodes[\s\S]*FOR SHARE/, result: result([{ id: workerId }]) },
      { sql: /UPDATE installations SET worker_node_id=\$2/, result: result([{ id: installationId }]) },
      {
        sql: /INSERT INTO installation_capacity_allocations/,
        result: (parameters) => {
          allocationId = String(parameters?.[0]);
          expect(parameters?.slice(1)).toEqual([installationId, workerId, "starter", 1_536, 500, 10, 2]);
          return result([{ id: allocationId }]);
        },
      },
      {
        sql: /INSERT INTO installation_capacity_allocation_events/,
        result: (parameters) => {
          expect(parameters?.[1]).toBe(allocationId);
          expect(parameters?.slice(2)).toEqual([installationId, "starter", 1_536, 500, 10, 2, "legacy_active_subscription_backfill"]);
          return result([{ id: parameters?.[0] }]);
        },
      },
      { sql: /^COMMIT$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(first), { plans: [starter], memorySafetyReserveMb: 192 })).resolves.toEqual({
      eligibleInstallations: 1,
      createdAllocations: 1,
      existingAllocations: 0,
      updatedInstallationAffinities: 1,
    });
    first.expectComplete();
    expect(first.released).toBe(true);

    const allocation = { id: allocationId, installation_id: installationId, worker_node_id: workerId, plan: "starter", allocation_memory_mb: 1_536, allocation_cpu_millis: 500, allocation_storage_gb: 10, allocation_max_services: 2, generation: 1, state: "active", source_checkout_hold_id: null };
    const retry = new ScriptedClient([
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([paidRow({ installation_worker_node_id: workerId })]) },
      { sql: /FROM application_instances[\s\S]*FOR UPDATE/, result: result(applications()) },
      { sql: /FROM installation_capacity_allocations[\s\S]*FOR UPDATE/, result: result([allocation]) },
      { sql: /FROM installation_capacity_allocation_events/, result: result([{ allocation_id: allocationId, installation_id: installationId, event_type: "allocated", generation: 1, plan: "starter", allocation_memory_mb: 1_536, allocation_cpu_millis: 500, allocation_storage_gb: 10, allocation_max_services: 2 }]) },
      { sql: /FROM worker_nodes[\s\S]*FOR SHARE/, result: result([{ id: workerId }]) },
      { sql: /^COMMIT$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(retry), { plans: [starter], memorySafetyReserveMb: 192 })).resolves.toEqual({
      eligibleInstallations: 1,
      createdAllocations: 0,
      existingAllocations: 1,
      updatedInstallationAffinities: 0,
    });
    retry.expectComplete();
    expect(retry.calls.some((call) => /INSERT|UPDATE installations/.test(call.sql))).toBe(false);
  });

  it.each([
    ["checkout", [{ id: "30000000-0000-4000-8000-000000000001" }], [], /active checkout capacity hold/],
    ["plan change", [], [{ id: "30000000-0000-4000-8000-000000000002" }], /active plan quota change hold/],
  ])("fails closed on an active %s hold", async (_label, checkoutRows, planChangeRows, message) => {
    const client = new ScriptedClient([
      ...transactionPrefix(checkoutRows as Record<string, unknown>[], planChangeRows as Record<string, unknown>[]),
      { sql: /^ROLLBACK$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(client), { plans: [starter], memorySafetyReserveMb: 192 })).rejects.toThrow(message as RegExp);
    client.expectComplete();
    expect(client.calls.some((call) => /INSERT|UPDATE installations/.test(call.sql))).toBe(false);
  });

  it.each([
    ["infrastructure mismatch", { subscription_infrastructure_monthly_cents: 501 }],
    ["platform-fee mismatch", { subscription_platform_fee_monthly_cents: 199 }],
    ["missing infrastructure price", { subscription_infrastructure_monthly_cents: null }],
    ["missing platform fee", { subscription_platform_fee_monthly_cents: null }],
    ["malformed stored price", { subscription_infrastructure_monthly_cents: "500.0" }],
  ])("rolls back before capacity reads or writes on a %s", async (_label, override) => {
    const client = new ScriptedClient([
      ...transactionPrefix(),
      { sql: /s\.infrastructure_monthly_cents[\s\S]*s\.platform_fee_monthly_cents[\s\S]*FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([paidRow(override)]) },
      { sql: /^ROLLBACK$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(client), { plans: [starter], memorySafetyReserveMb: 192 })).rejects.toThrow(
      /subscription price split that does not match configured plan starter/,
    );
    client.expectComplete();
    expect(client.calls.some((call) => /FROM application_instances|FROM installation_capacity_allocations|INSERT|UPDATE installations/.test(call.sql))).toBe(false);
  });

  it.each([
    ["missing worker", applications({ worker_node_id: null }), [starter], /missing or ambiguous application worker assignments/],
    ["ambiguous worker", [applications()[0], { ...applications()[1], worker_node_id: "other-worker" }], [starter], /missing or ambiguous application worker assignments/],
    ["unknown plan", applications(), [starter], /unknown plan fleet/],
    ["quota overflow", applications({ memory_reservation_mb: 1_600, cpu_reservation_millis: 600, storage_reservation_gb: 11 }), [starter], /exceeds configured starter quota: memoryMb, cpuMillis, storageGb/],
  ])("rolls back every candidate when one has a %s", async (label, appRows, plans, message) => {
    const candidate = label === "unknown plan" ? paidRow({ installation_plan: "fleet" }) : paidRow();
    const client = new ScriptedClient(label === "unknown plan" ? [
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([candidate]) },
      { sql: /^ROLLBACK$/, result: result() },
    ] : [
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([candidate]) },
      { sql: /FROM application_instances[\s\S]*FOR UPDATE/, result: result(appRows as Record<string, unknown>[]) },
      { sql: /FROM installation_capacity_allocations[\s\S]*FOR UPDATE/, result: result() },
      { sql: /^ROLLBACK$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(client), { plans: plans as ComputePlan[], memorySafetyReserveMb: 192 })).rejects.toThrow(message as RegExp);
    client.expectComplete();
    expect(client.calls.some((call) => /INSERT|UPDATE installations/.test(call.sql))).toBe(false);
  });

  it("rejects conflicting existing allocations and missing derived workers before mutating anything", async () => {
    const conflictingAllocation = { id: "40000000-0000-4000-8000-000000000001", installation_id: installationId, worker_node_id: workerId, plan: "scale", allocation_memory_mb: 6_144, allocation_cpu_millis: 2_000, allocation_storage_gb: 100, allocation_max_services: 12, generation: 1, state: "active", source_checkout_hold_id: null };
    const conflict = new ScriptedClient([
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([paidRow()]) },
      { sql: /FROM application_instances[\s\S]*FOR UPDATE/, result: result(applications()) },
      { sql: /FROM installation_capacity_allocations[\s\S]*FOR UPDATE/, result: result([conflictingAllocation]) },
      { sql: /FROM installation_capacity_allocation_events/, result: result() },
      { sql: /^ROLLBACK$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(conflict), { plans: [starter], memorySafetyReserveMb: 192 })).rejects.toThrow(/conflicting existing capacity allocation/);
    expect(conflict.calls.some((call) => /INSERT|UPDATE installations/.test(call.sql))).toBe(false);

    const missingWorker = new ScriptedClient([
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([paidRow()]) },
      { sql: /FROM application_instances[\s\S]*FOR UPDATE/, result: result(applications()) },
      { sql: /FROM installation_capacity_allocations[\s\S]*FOR UPDATE/, result: result() },
      { sql: /FROM worker_nodes[\s\S]*FOR SHARE/, result: result() },
      { sql: /^ROLLBACK$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(missingWorker), { plans: [starter], memorySafetyReserveMb: 192 })).rejects.toThrow(/could not lock every derived worker/);
    expect(missingWorker.calls.some((call) => /INSERT|UPDATE installations/.test(call.sql))).toBe(false);
  });

  it("rejects duplicate active subscriptions, ownership conflicts, duplicate plan definitions, and invalid safety reserves", async () => {
    const duplicate = new ScriptedClient([
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([paidRow(), paidRow({ subscription_id: "50000000-0000-4000-8000-000000000001" })]) },
      { sql: /^ROLLBACK$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(duplicate), { plans: [starter], memorySafetyReserveMb: 192 })).rejects.toThrow(/multiple active subscriptions/);

    const ownership = new ScriptedClient([
      ...transactionPrefix(),
      { sql: /FROM subscriptions s[\s\S]*FOR UPDATE OF s,i/, result: result([paidRow({ subscription_user_id: "50000000-0000-4000-8000-000000000002" })]) },
      { sql: /^ROLLBACK$/, result: result() },
    ]);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(ownership), { plans: [starter], memorySafetyReserveMb: 192 })).rejects.toThrow(/conflicting subscription ownership/);

    await expect(backfillLegacyPaidPlanCapacity(poolFor(new ScriptedClient([])), { plans: [starter, starter], memorySafetyReserveMb: 192 })).rejects.toThrow(/duplicate plan starter/);
    await expect(backfillLegacyPaidPlanCapacity(poolFor(new ScriptedClient([])), { plans: [starter], memorySafetyReserveMb: -1 })).rejects.toThrow(/non-negative integer/);
  });
});
