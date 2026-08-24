import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemorySuiteStore } from "../src/server/suite-store";
import {
  suiteRegisteredObjectBytes,
  suiteStorageAccounting,
  suiteStorageAccountingVersion,
  suiteStorageObjectRegistration,
} from "../src/shared/suite-quotas";

function driveVersion(fileId: string, fileVersionNumber: number, sizeBytes: number, checksum = "a".repeat(64)) {
  return {
    fileId,
    fileVersionNumber,
    objectKey: `tenant/files/${fileId}/v${fileVersionNumber}`,
    sizeBytes,
    checksum,
    storageAccounting: suiteStorageAccounting(sizeBytes),
  };
}

function esignDocument(label: string, sizeBytes: number, verified = false) {
  return {
    objectRef: `tenant/contracts/${label}.pdf`,
    objectVersion: `generation-${label}`,
    sha256: "b".repeat(64),
    sizeBytes,
    contentType: "application/pdf",
    pageCount: 1,
    immutable: true,
    storageAccounting: suiteStorageAccounting(sizeBytes, verified ? { objectStoreVerified: true } : {}),
  };
}

describe("shared suite retained-object storage accounting", () => {
  it("counts every immutable Drive version and e-sign object, never the mutable Drive head", () => {
    const fileId = randomUUID();
    expect(suiteRegisteredObjectBytes("drive", "file", { sizeBytes: 9_999_999 })).toBe(0);
    expect(suiteRegisteredObjectBytes("drive", "file-version", driveVersion(fileId, 1, 2_048))).toBe(2_048);
    expect(suiteRegisteredObjectBytes("drive", "file-version", driveVersion(fileId, 2, 4_096))).toBe(4_096);
    expect(suiteRegisteredObjectBytes("esign", "document", esignDocument("one", 42_000))).toBe(42_000);
    expect(() => suiteRegisteredObjectBytes("esign", "document", { ...esignDocument("bad", 42_000), storageAccounting: undefined })).toThrow(/storageAccounting/);
  });

  it("reports reconciliation-ready registered, verified, and unverified byte totals", async () => {
    const store = new MemorySuiteStore("scale");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "drive");
    const fileId = randomUUID();
    const first = await store.createRecord(userId, { moduleId: "drive", recordType: "file-version", title: "File v1", state: "immutable", data: driveVersion(fileId, 1, 2_048) });
    const secondData = { ...driveVersion(fileId, 2, 4_096, "c".repeat(64)), storageAccounting: suiteStorageAccounting(4_096, { objectStoreVerified: true }) };
    await store.createRecord(userId, { moduleId: "drive", recordType: "file-version", title: "File v2", state: "immutable", data: secondData });

    expect(await store.getUsage(userId)).toMatchObject({
      registeredStorageBytes: 6_144,
      verifiedStorageBytes: 4_096,
      unverifiedStorageBytes: 2_048,
      retainedStorageObjectCount: 2,
      storageAccountingVersion: suiteStorageAccountingVersion,
      storageUsageAsOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(suiteStorageObjectRegistration("drive", "file-version", secondData)).toMatchObject({ objectStoreVerified: true, sizeSource: "object-store-head" });
    expect(first).toBeTruthy();
  });

  it("serializes creates at the workspace quota and rejects both lowering and overwriting immutable metadata", async () => {
    const store = new MemorySuiteStore("starter");
    const userId = randomUUID();
    await store.getOrCreateWorkspace(userId);
    await store.enableModule(userId, "esign");
    const inputs = [
      { moduleId: "esign", recordType: "document", title: "Large agreement", state: "immutable", data: esignDocument("large", 10_000_000_000) },
      { moduleId: "esign", recordType: "document", title: "Overflow agreement", state: "immutable", data: esignDocument("overflow", 800_000_000) },
    ] as const;
    const settled = await Promise.allSettled(inputs.map((input) => store.createRecord(userId, input)));
    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(settled.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/storage quota/) }) });

    const retained = (await store.listRecords(userId, { moduleId: "esign", recordType: "document", limit: 10 }))[0];
    expect(retained).toBeTruthy();
    const registeredBytes = Number(retained.data.sizeBytes);
    await expect(store.updateRecord(userId, retained.id, {
      data: { sizeBytes: 1, storageAccounting: suiteStorageAccounting(1) },
    })).rejects.toThrow(/immutable/);
    await expect(store.updateRecord(userId, retained.id, { data: { sha256: "d".repeat(64) } })).rejects.toThrow(/immutable/);
    expect((await store.getUsage(userId)).registeredStorageBytes).toBe(registeredBytes);
  });
});
