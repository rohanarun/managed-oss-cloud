import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "../catalog/apps.json";
import { runtimeReservation } from "../src/server/app-manifests";
import { loadDatabaseMigrations } from "../src/server/database-migrations";

const migration = readFileSync("db/migrations/015-runtime-resource-reservations.sql", "utf8");

describe("runtime reservation normalization", () => {
  it("registers the immutable reservation migration before subsequent releases", async () => {
    const migrations = await loadDatabaseMigrations();
    expect(migrations.find((item) => item.version === "015")).toMatchObject({ name: "runtime-resource-reservations" });
    expect(migrations.findIndex((item) => item.version === "015")).toBeLessThan(migrations.findIndex((item) => item.version === "016"));
  });

  it("keeps catalogue planning memory equal to the complete bounded manifest", () => {
    for (const app of catalog) expect(app.memoryBudgetMb, app.id).toBe(runtimeReservation(app.id).memoryMb);
  });

  it("fails before mutation for active holds and all three worker or plan dimensions", () => {
    expect(migration).toMatch(/checkout_capacity_holds WHERE state='active'/);
    expect(migration).toMatch(/plan_capacity_change_holds WHERE state='active'/);
    expect(migration).toMatch(/memory_mb\+w\.system_reserve_memory_mb>w\.capacity_memory_mb/);
    expect(migration).toMatch(/cpu_millis>w\.capacity_cpu_millis/);
    expect(migration).toMatch(/storage_gb>w\.capacity_storage_gb/);
    expect(migration.indexOf("$runtime_reservation_preflight$;")).toBeLessThan(migration.indexOf("UPDATE application_instances"));
  });
});
