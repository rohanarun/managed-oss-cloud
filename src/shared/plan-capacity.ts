import type { ApplicationInstance, ComputePlan } from "./types.js";

export interface CapacityVector {
  memoryMb: number;
  cpuMillis: number;
  storageGb: number;
}

export interface PlanCapacitySnapshot extends CapacityVector {
  planId: string;
  maxServices: number;
}

export interface ApplicationCapacityUsage extends CapacityVector {
  services: number;
}

export interface CapacityEnvelopeFit {
  fits: boolean;
  remaining: ApplicationCapacityUsage;
  exceeded: Array<keyof ApplicationCapacityUsage>;
}

function safeNonNegativeInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

export function planCapacitySnapshot(plan: ComputePlan): PlanCapacitySnapshot {
  if (!plan.id.trim()) throw new Error("Plan capacity requires a stable plan ID.");
  return {
    planId: plan.id,
    memoryMb: safeNonNegativeInteger("Plan memory", plan.memoryMb),
    cpuMillis: safeNonNegativeInteger("Plan CPU", plan.cpu * 1_000),
    storageGb: safeNonNegativeInteger("Plan storage", plan.storageGb),
    maxServices: safeNonNegativeInteger("Plan service limit", plan.maxServices),
  };
}

export function positiveCapacityDelta(current: CapacityVector | undefined, target: CapacityVector): CapacityVector {
  return {
    memoryMb: Math.max(0, target.memoryMb - (current?.memoryMb ?? 0)),
    cpuMillis: Math.max(0, target.cpuMillis - (current?.cpuMillis ?? 0)),
    storageGb: Math.max(0, target.storageGb - (current?.storageGb ?? 0)),
  };
}

export function applicationCapacityUsage(
  applications: Array<Pick<ApplicationInstance, "memoryReservationMb" | "cpuReservationMillis" | "storageReservationGb">>,
  memorySafetyReserveMb = 0,
): ApplicationCapacityUsage {
  safeNonNegativeInteger("Application memory safety reserve", memorySafetyReserveMb);
  return applications.reduce<ApplicationCapacityUsage>((usage, application) => ({
    memoryMb: usage.memoryMb + safeNonNegativeInteger("Application memory reservation", application.memoryReservationMb),
    cpuMillis: usage.cpuMillis + safeNonNegativeInteger("Application CPU reservation", application.cpuReservationMillis),
    storageGb: usage.storageGb + safeNonNegativeInteger("Application storage reservation", application.storageReservationGb),
    services: usage.services + 1,
  }), { memoryMb: memorySafetyReserveMb, cpuMillis: 0, storageGb: 0, services: 0 });
}

export function capacityEnvelopeFit(usage: ApplicationCapacityUsage, allocation: PlanCapacitySnapshot): CapacityEnvelopeFit {
  const remaining = {
    memoryMb: allocation.memoryMb - usage.memoryMb,
    cpuMillis: allocation.cpuMillis - usage.cpuMillis,
    storageGb: allocation.storageGb - usage.storageGb,
    services: allocation.maxServices - usage.services,
  };
  const exceeded = (Object.keys(remaining) as Array<keyof ApplicationCapacityUsage>).filter((dimension) => remaining[dimension] < 0);
  return { fits: exceeded.length === 0, remaining, exceeded };
}
