import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/server/repository";

describe("checkout provisioning capacity gate", () => {
  it("fails closed without a fresh active worker and accepts only reservations that fit", async () => {
    const repository = new MemoryRepository();
    const small = [{ memoryReservationMb: 416, cpuReservationMillis: 250, storageReservationGb: 3 }];
    expect(await repository.hasFreshProvisioningCapacity(small)).toBe(false);

    await repository.registerWorkerNode({ id: "capacity-one", name: "Capacity One", privateAddress: "10.70.0.50", machineType: "e2-small", capacityMemoryMb: 1024, capacityCpuMillis: 500, capacityStorageGb: 10, systemReserveMemoryMb: 512 });
    expect(await repository.hasFreshProvisioningCapacity(small)).toBe(true);
    expect(await repository.hasFreshProvisioningCapacity([{ memoryReservationMb: 608, cpuReservationMillis: 500, storageReservationGb: 10 }])).toBe(false);

    await repository.setWorkerNodeMode("capacity-one", "draining");
    expect(await repository.hasFreshProvisioningCapacity(small)).toBe(false);
  });

  it("can place a multi-application purchase across multiple healthy workers", async () => {
    const repository = new MemoryRepository();
    for (const id of ["capacity-a", "capacity-b"]) await repository.registerWorkerNode({ id, name: id, privateAddress: id.endsWith("a") ? "10.70.0.51" : "10.70.0.52", machineType: "e2-small", capacityMemoryMb: 1024, capacityCpuMillis: 500, capacityStorageGb: 10, systemReserveMemoryMb: 512 });
    expect(await repository.hasFreshProvisioningCapacity([
      { memoryReservationMb: 416, cpuReservationMillis: 250, storageReservationGb: 3 },
      { memoryReservationMb: 416, cpuReservationMillis: 250, storageReservationGb: 3 },
    ])).toBe(true);
  });
});
