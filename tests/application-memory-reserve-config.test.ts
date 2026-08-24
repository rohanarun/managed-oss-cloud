import { describe, expect, it } from "vitest";
import { parseRuntimeEnvironment } from "../src/server/config";

describe("application memory safety reserve configuration", () => {
  it("uses the documented default and accepts an operator override", () => {
    expect(parseRuntimeEnvironment({}).APPLICATION_MEMORY_SAFETY_RESERVE_MB).toBe(192);
    expect(parseRuntimeEnvironment({ APPLICATION_MEMORY_SAFETY_RESERVE_MB: "384" }).APPLICATION_MEMORY_SAFETY_RESERVE_MB).toBe(384);
    expect(parseRuntimeEnvironment({ APPLICATION_MEMORY_SAFETY_RESERVE_MB: "0" }).APPLICATION_MEMORY_SAFETY_RESERVE_MB).toBe(0);
  });

  it.each(["-1", "1.5", "65537", "not-a-number"])("rejects an invalid reserve of %s MB", (value) => {
    expect(() => parseRuntimeEnvironment({ APPLICATION_MEMORY_SAFETY_RESERVE_MB: value })).toThrow();
  });

  it("bounds the paid-capacity recovery window", () => {
    expect(parseRuntimeEnvironment({}).PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS).toBe(86_400_000);
    expect(parseRuntimeEnvironment({ PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS: "3600000" }).PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS).toBe(3_600_000);
    expect(() => parseRuntimeEnvironment({ PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS: "299999" })).toThrow();
    expect(() => parseRuntimeEnvironment({ PAID_CAPACITY_RECOVERY_WINDOW_MILLISECONDS: "604800001" })).toThrow();
  });

  it("keeps measured ext4 storage fail-honest and requires hard-quota proof for live billing", () => {
    expect(parseRuntimeEnvironment({})).toMatchObject({
      WORKER_SYSTEM_RESERVE_CPU_MILLIS: 200,
      WORKER_SYSTEM_RESERVE_STORAGE_GB: 15,
      WORKER_STORAGE_QUOTA_BACKEND: "measurement-only",
      WORKER_STORAGE_QUOTA_PROOF_COMPLETED: "false",
    });
    expect(() => parseRuntimeEnvironment({ BILLING_MODE: "live" })).toThrow(/hard project-quota backend/);
    expect(parseRuntimeEnvironment({ BILLING_MODE: "live", WORKER_STORAGE_QUOTA_BACKEND: "operator-project-quota", WORKER_STORAGE_QUOTA_PROOF_COMPLETED: "true" })).toMatchObject({ BILLING_MODE: "live" });
    expect(() => parseRuntimeEnvironment({ PROVISIONING_WORKER: "remote", WORKER_STORAGE_QUOTA_BACKEND: "operator-project-quota", WORKER_STORAGE_QUOTA_PROOF_COMPLETED: "true" })).toThrow(/quota helper path/);
    expect(parseRuntimeEnvironment({ PROVISIONING_WORKER: "remote", WORKER_STORAGE_QUOTA_BACKEND: "operator-project-quota", WORKER_STORAGE_QUOTA_PROOF_COMPLETED: "true", WORKER_STORAGE_QUOTA_HELPER: "/opt/managed-oss/quota/bin/helper" })).toMatchObject({ WORKER_STORAGE_QUOTA_HELPER: "/opt/managed-oss/quota/bin/helper" });
  });
});
