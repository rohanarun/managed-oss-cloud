import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ComputePlan } from "../shared/types.js";
import { capacityEnvelopeFit, planCapacitySnapshot, type PlanCapacitySnapshot } from "../shared/plan-capacity.js";

const checkoutCapacityAllocationLock = "managed-oss-cloud/checkout-capacity-allocation";
const backfillReason = "legacy_active_subscription_backfill";

interface LegacyPaidInstallationRow extends pg.QueryResultRow {
  installation_id: string;
  installation_user_id: string;
  installation_plan: string;
  installation_worker_node_id: string | null;
  subscription_id: string;
  subscription_user_id: string;
  subscription_infrastructure_monthly_cents: number | string | null;
  subscription_platform_fee_monthly_cents: number | string | null;
}

interface ConfiguredLegacyPlan {
  snapshot: PlanCapacitySnapshot;
  infrastructureMonthlyCents: number;
  platformFeeMonthlyCents: number;
}

interface LegacyApplicationRow extends pg.QueryResultRow {
  id: string;
  installation_id: string;
  worker_node_id: string | null;
  memory_reservation_mb: number | string;
  cpu_reservation_millis: number | string;
  storage_reservation_gb: number | string;
}

interface ExistingAllocationRow extends pg.QueryResultRow {
  id: string;
  installation_id: string;
  worker_node_id: string;
  plan: string;
  allocation_memory_mb: number | string;
  allocation_cpu_millis: number | string;
  allocation_storage_gb: number | string;
  allocation_max_services: number | string;
  generation: number | string;
  state: string;
  source_checkout_hold_id: string | null;
}

interface ExistingAllocationEventRow extends pg.QueryResultRow {
  allocation_id: string;
  installation_id: string;
  event_type: string;
  generation: number | string;
  plan: string;
  allocation_memory_mb: number | string;
  allocation_cpu_millis: number | string;
  allocation_storage_gb: number | string;
  allocation_max_services: number | string;
}

export interface LegacyCapacityBackfillOptions {
  plans: readonly ComputePlan[];
  memorySafetyReserveMb: number;
}

export interface LegacyCapacityBackfillReport {
  eligibleInstallations: number;
  createdAllocations: number;
  existingAllocations: number;
  updatedInstallationAffinities: number;
}

function nonNegativeInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function databaseInteger(name: string, value: number | string) {
  const parsed = typeof value === "number" ? value : Number(value);
  return nonNegativeInteger(name, parsed);
}

function configuredPlanSnapshots(plans: readonly ComputePlan[]) {
  const snapshots = new Map<string, ConfiguredLegacyPlan>();
  for (const plan of plans) {
    if (snapshots.has(plan.id)) throw new Error(`Legacy capacity backfill received duplicate plan ${plan.id}.`);
    const infrastructureMonthlyCents = nonNegativeInteger(`Configured ${plan.id} infrastructure monthly price`, plan.infrastructureMonthlyCents);
    const totalMonthlyCents = nonNegativeInteger(`Configured ${plan.id} total monthly price`, plan.monthlyCents);
    snapshots.set(plan.id, {
      snapshot: planCapacitySnapshot(plan),
      infrastructureMonthlyCents,
      platformFeeMonthlyCents: nonNegativeInteger(`Configured ${plan.id} platform fee`, totalMonthlyCents - infrastructureMonthlyCents),
    });
  }
  if (!snapshots.size) throw new Error("Legacy capacity backfill requires at least one configured plan.");
  return snapshots;
}

function parsedSubscriptionPrice(value: number | string | null) {
  if (value === null) return undefined;
  if (typeof value === "string" && !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasConfiguredSubscriptionPrice(row: LegacyPaidInstallationRow, plan: ConfiguredLegacyPlan) {
  return parsedSubscriptionPrice(row.subscription_infrastructure_monthly_cents) === plan.infrastructureMonthlyCents
    && parsedSubscriptionPrice(row.subscription_platform_fee_monthly_cents) === plan.platformFeeMonthlyCents;
}

function sameAllocationSnapshot(row: ExistingAllocationRow, workerNodeId: string, snapshot: PlanCapacitySnapshot) {
  return row.worker_node_id === workerNodeId
    && row.plan === snapshot.planId
    && databaseInteger("Existing allocation memory", row.allocation_memory_mb) === snapshot.memoryMb
    && databaseInteger("Existing allocation CPU", row.allocation_cpu_millis) === snapshot.cpuMillis
    && databaseInteger("Existing allocation storage", row.allocation_storage_gb) === snapshot.storageGb
    && databaseInteger("Existing allocation service limit", row.allocation_max_services) === snapshot.maxServices
    && databaseInteger("Existing allocation generation", row.generation) === 1
    && row.state === "active"
    && row.source_checkout_hold_id === null;
}

function sameAllocatedEvent(row: ExistingAllocationEventRow, allocation: ExistingAllocationRow, snapshot: PlanCapacitySnapshot) {
  return row.allocation_id === allocation.id
    && row.installation_id === allocation.installation_id
    && row.event_type === "allocated"
    && databaseInteger("Existing allocation event generation", row.generation) === 1
    && row.plan === snapshot.planId
    && databaseInteger("Existing allocation event memory", row.allocation_memory_mb) === snapshot.memoryMb
    && databaseInteger("Existing allocation event CPU", row.allocation_cpu_millis) === snapshot.cpuMillis
    && databaseInteger("Existing allocation event storage", row.allocation_storage_gb) === snapshot.storageGb
    && databaseInteger("Existing allocation event service limit", row.allocation_max_services) === snapshot.maxServices;
}

export async function backfillLegacyPaidPlanCapacity(
  pool: pg.Pool,
  options: LegacyCapacityBackfillOptions,
): Promise<LegacyCapacityBackfillReport> {
  const memorySafetyReserveMb = nonNegativeInteger("Legacy capacity backfill memory safety reserve", options.memorySafetyReserveMb);
  const planSnapshots = configuredPlanSnapshots(options.plans);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [checkoutCapacityAllocationLock]);

    const activeCheckoutHolds = await client.query("SELECT id FROM checkout_capacity_holds WHERE state='active' ORDER BY id FOR UPDATE");
    if (activeCheckoutHolds.rowCount) throw new Error("Legacy capacity backfill refused to run while an active checkout capacity hold exists.");
    const activePlanChangeHolds = await client.query("SELECT id FROM plan_capacity_change_holds WHERE state='active' ORDER BY id FOR UPDATE");
    if (activePlanChangeHolds.rowCount) throw new Error("Legacy capacity backfill refused to run while an active plan quota change hold exists.");

    const paid = await client.query<LegacyPaidInstallationRow>(`
      SELECT i.id installation_id,
             i.user_id installation_user_id,
             i.plan installation_plan,
             i.worker_node_id installation_worker_node_id,
             s.id subscription_id,
             s.user_id subscription_user_id,
             s.infrastructure_monthly_cents subscription_infrastructure_monthly_cents,
             s.platform_fee_monthly_cents subscription_platform_fee_monthly_cents
      FROM subscriptions s
      JOIN installations i ON i.id=s.installation_id
      WHERE s.status IN ('active','trialing')
        AND s.installation_id IS NOT NULL
      ORDER BY i.id,s.id
      FOR UPDATE OF s,i
    `);

    const installations = new Map<string, LegacyPaidInstallationRow>();
    for (const row of paid.rows) {
      if (row.installation_user_id !== row.subscription_user_id) throw new Error(`Legacy paid installation ${row.installation_id} has conflicting subscription ownership.`);
      if (installations.has(row.installation_id)) throw new Error(`Legacy paid installation ${row.installation_id} has multiple active subscriptions.`);
      installations.set(row.installation_id, row);
    }

    for (const installation of installations.values()) {
      const plan = planSnapshots.get(installation.installation_plan);
      if (!plan) throw new Error(`Legacy paid installation ${installation.installation_id} uses unknown plan ${installation.installation_plan}.`);
      if (!hasConfiguredSubscriptionPrice(installation, plan)) {
        throw new Error(`Legacy paid installation ${installation.installation_id} has a subscription price split that does not match configured plan ${installation.installation_plan}.`);
      }
    }

    const installationIds = [...installations.keys()];
    if (!installationIds.length) {
      await client.query("COMMIT");
      return { eligibleInstallations: 0, createdAllocations: 0, existingAllocations: 0, updatedInstallationAffinities: 0 };
    }

    const applicationResult = await client.query<LegacyApplicationRow>(`
      SELECT id,installation_id,worker_node_id,memory_reservation_mb,cpu_reservation_millis,storage_reservation_gb
      FROM application_instances
      WHERE installation_id=ANY($1::uuid[])
      ORDER BY installation_id,id
      FOR UPDATE
    `, [installationIds]);
    const applications = new Map<string, LegacyApplicationRow[]>();
    for (const row of applicationResult.rows) {
      const rows = applications.get(row.installation_id) ?? [];
      rows.push(row);
      applications.set(row.installation_id, rows);
    }

    const allocationResult = await client.query<ExistingAllocationRow>(`
      SELECT id,installation_id,worker_node_id,plan,allocation_memory_mb,allocation_cpu_millis,
             allocation_storage_gb,allocation_max_services,generation,state,source_checkout_hold_id
      FROM installation_capacity_allocations
      WHERE installation_id=ANY($1::uuid[])
      ORDER BY installation_id,id
      FOR UPDATE
    `, [installationIds]);
    const allocations = new Map<string, ExistingAllocationRow[]>();
    for (const row of allocationResult.rows) {
      const rows = allocations.get(row.installation_id) ?? [];
      rows.push(row);
      allocations.set(row.installation_id, rows);
    }
    const allocationIds = allocationResult.rows.map((row) => row.id);
    const eventResult = allocationIds.length
      ? await client.query<ExistingAllocationEventRow>(`
          SELECT allocation_id,installation_id,event_type,generation,plan,allocation_memory_mb,
                 allocation_cpu_millis,allocation_storage_gb,allocation_max_services
          FROM installation_capacity_allocation_events
          WHERE allocation_id=ANY($1::uuid[])
          ORDER BY allocation_id,generation,event_type
        `, [allocationIds])
      : { rows: [] as ExistingAllocationEventRow[] };
    const events = new Map<string, ExistingAllocationEventRow[]>();
    for (const row of eventResult.rows) {
      const rows = events.get(row.allocation_id) ?? [];
      rows.push(row);
      events.set(row.allocation_id, rows);
    }

    const prepared = installationIds.map((installationId) => {
      const installation = installations.get(installationId)!;
      const snapshot = planSnapshots.get(installation.installation_plan)!.snapshot;
      const assignedApplications = applications.get(installationId) ?? [];
      if (!assignedApplications.length) throw new Error(`Legacy paid installation ${installationId} has no application assignment from which to derive a worker.`);
      const workerIds = new Set(assignedApplications.map((application) => application.worker_node_id).filter((worker): worker is string => Boolean(worker)));
      if (assignedApplications.some((application) => !application.worker_node_id) || workerIds.size !== 1) throw new Error(`Legacy paid installation ${installationId} has missing or ambiguous application worker assignments.`);
      const workerNodeId = [...workerIds][0];
      if (installation.installation_worker_node_id && installation.installation_worker_node_id !== workerNodeId) throw new Error(`Legacy paid installation ${installationId} has a conflicting installation worker affinity.`);
      const usage = assignedApplications.reduce((total, application) => ({
        services: total.services + 1,
        memoryMb: total.memoryMb + databaseInteger("Application memory reservation", application.memory_reservation_mb),
        cpuMillis: total.cpuMillis + databaseInteger("Application CPU reservation", application.cpu_reservation_millis),
        storageGb: total.storageGb + databaseInteger("Application storage reservation", application.storage_reservation_gb),
      }), { services: 0, memoryMb: memorySafetyReserveMb, cpuMillis: 0, storageGb: 0 });
      const fit = capacityEnvelopeFit(usage, snapshot);
      if (!fit.fits) throw new Error(`Legacy paid installation ${installationId} exceeds configured ${snapshot.planId} quota: ${fit.exceeded.join(", ")}.`);
      const existing = allocations.get(installationId) ?? [];
      if (existing.length > 1 || (existing[0] && !sameAllocationSnapshot(existing[0], workerNodeId, snapshot))) throw new Error(`Legacy paid installation ${installationId} has a conflicting existing capacity allocation.`);
      if (existing[0]) {
        const existingEvents = events.get(existing[0].id) ?? [];
        if (existingEvents.length !== 1 || !sameAllocatedEvent(existingEvents[0], existing[0], snapshot)) throw new Error(`Legacy paid installation ${installationId} has a conflicting or incomplete allocation audit trail.`);
      }
      return { installation, snapshot, workerNodeId, existing: existing[0] };
    });

    const workerIds = [...new Set(prepared.map((item) => item.workerNodeId))];
    const workers = await client.query<{ id: string }>("SELECT id FROM worker_nodes WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE", [workerIds]);
    if (workers.rows.length !== workerIds.length) throw new Error("Legacy capacity backfill could not lock every derived worker.");

    let createdAllocations = 0;
    let existingAllocations = 0;
    let updatedInstallationAffinities = 0;
    for (const item of prepared) {
      if (!item.installation.installation_worker_node_id) {
        const affinity = await client.query(
          "UPDATE installations SET worker_node_id=$2,updated_at=NOW() WHERE id=$1 AND worker_node_id IS NULL RETURNING id",
          [item.installation.installation_id, item.workerNodeId],
        );
        if (affinity.rowCount !== 1) throw new Error(`Legacy paid installation ${item.installation.installation_id} changed before worker affinity was recorded.`);
        updatedInstallationAffinities += 1;
      }
      if (item.existing) {
        existingAllocations += 1;
        continue;
      }
      const allocationId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO installation_capacity_allocations(
           id,installation_id,worker_node_id,plan,allocation_memory_mb,allocation_cpu_millis,
           allocation_storage_gb,allocation_max_services,generation,state,source_checkout_hold_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'active',NULL)
         RETURNING id`,
        [allocationId, item.installation.installation_id, item.workerNodeId, item.snapshot.planId, item.snapshot.memoryMb, item.snapshot.cpuMillis, item.snapshot.storageGb, item.snapshot.maxServices],
      );
      if (inserted.rowCount !== 1) throw new Error(`Legacy paid installation ${item.installation.installation_id} capacity allocation was not inserted.`);
      const audit = await client.query(
        `INSERT INTO installation_capacity_allocation_events(
           id,allocation_id,installation_id,event_type,generation,plan,allocation_memory_mb,
           allocation_cpu_millis,allocation_storage_gb,allocation_max_services,source_hold_id,reason
         ) VALUES($1,$2,$3,'allocated',1,$4,$5,$6,$7,$8,NULL,$9)
         RETURNING id`,
        [randomUUID(), allocationId, item.installation.installation_id, item.snapshot.planId, item.snapshot.memoryMb, item.snapshot.cpuMillis, item.snapshot.storageGb, item.snapshot.maxServices, backfillReason],
      );
      if (audit.rowCount !== 1) throw new Error(`Legacy paid installation ${item.installation.installation_id} capacity audit event was not inserted.`);
      createdAllocations += 1;
    }

    await client.query("COMMIT");
    return { eligibleInstallations: prepared.length, createdAllocations, existingAllocations, updatedInstallationAffinities };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
