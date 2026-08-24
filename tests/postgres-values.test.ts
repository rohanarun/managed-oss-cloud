import { describe, expect, it } from "vitest";
import { databaseTimestampIso } from "../src/server/postgres-values";

describe("PostgreSQL timestamp mapping", () => {
  it("preserves milliseconds from node-postgres Date values and rejects invalid values", () => {
    expect(databaseTimestampIso(new Date("2026-08-24T09:31:07.052Z"))).toBe("2026-08-24T09:31:07.052Z");
    expect(databaseTimestampIso("2026-08-24T09:31:07.052Z")).toBe("2026-08-24T09:31:07.052Z");
    expect(() => databaseTimestampIso(undefined, "created_at")).toThrow(/created_at is missing or invalid/);
  });
});
