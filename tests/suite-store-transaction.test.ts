import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemorySuiteStore } from "../src/server/suite-store.js";

async function enabledStore(moduleId = "crm") {
  const store = new MemorySuiteStore("fleet");
  const userId = randomUUID();
  await store.getOrCreateWorkspace(userId);
  await store.enableModule(userId, moduleId);
  return { store, userId };
}

describe("MemorySuiteStore transaction atomicity", () => {
  it("restores updates and removes created records and queued AI actions after a late failure", async () => {
    const { store, userId } = await enabledStore();
    const existing = await store.createRecord(userId, { moduleId: "crm", recordType: "account", title: "Original", state: "active", data: { version: 1, value: "before" } });
    if (!existing) throw new Error("Expected fixture record.");
    const before = structuredClone(existing);
    let queuedId = "";
    await expect(store.runInWorkspaceTransaction(userId, async () => {
      await store.updateRecord(userId, existing.id, { title: "Changed", data: { value: "after" } });
      await store.createRecord(userId, { moduleId: "crm", recordType: "contact", title: "Partial", state: "active", data: {} });
      const queued = await store.queueAiAction(userId, { moduleId: "crm", goal: "Must roll back", context: {} });
      queuedId = queued?.id ?? "";
      throw new Error("late failure");
    })).rejects.toThrow("late failure");
    expect(await store.getRecord(userId, existing.id)).toEqual(before);
    expect(await store.listRecords(userId, { moduleId: "crm", limit: 20 })).toEqual([before]);
    expect(await store.getAiAction(userId, queuedId)).toBeUndefined();
    expect((await store.getUsage(userId)).aiActionsThisMonth).toBe(0);
  });

  it("does not retain a first workspace or membership when its first transaction fails", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    await expect(store.runInWorkspaceTransaction(userId, async () => { throw new Error("first transaction failed"); })).rejects.toThrow("first transaction failed");
    expect(await store.getWorkspaceBySlug(`workspace-${userId.slice(0, 8)}`)).toBeUndefined();
    const created = await store.getOrCreateWorkspace(userId);
    expect(created.currentRole).toBe("owner");
  });

  it("rolls back outer and nested writes together", async () => {
    const { store, userId } = await enabledStore();
    await expect(store.runInWorkspaceTransaction(userId, async () => {
      await store.createRecord(userId, { moduleId: "crm", recordType: "account", title: "Outer", data: {} });
      await store.runInWorkspaceTransaction(userId, async () => {
        await store.createRecord(userId, { moduleId: "crm", recordType: "contact", title: "Inner", data: {} });
        throw new Error("nested failure");
      });
    })).rejects.toThrow("nested failure");
    expect(await store.listRecords(userId, { moduleId: "crm", limit: 20 })).toEqual([]);
  });

  it("serializes tenants so one committed transaction survives another tenant's rollback", async () => {
    const store = new MemorySuiteStore("fleet");
    const left = randomUUID();
    const right = randomUUID();
    for (const userId of [left, right]) { await store.getOrCreateWorkspace(userId); await store.enableModule(userId, "crm"); }
    const [committed] = await Promise.all([
      store.runInWorkspaceTransaction(left, () => store.createRecord(left, { moduleId: "crm", recordType: "account", title: "Committed", data: {} })),
      store.runInWorkspaceTransaction(right, async () => {
        await store.createRecord(right, { moduleId: "crm", recordType: "account", title: "Rolled back", data: {} });
        throw new Error("right failed");
      }).catch((error: unknown) => error),
    ]);
    expect(committed?.title).toBe("Committed");
    expect((await store.listRecords(left, { moduleId: "crm", limit: 20 })).map((record) => record.title)).toEqual(["Committed"]);
    expect(await store.listRecords(right, { moduleId: "crm", limit: 20 })).toEqual([]);
  });

  it("rolls back both a custom domain row and its shared hostname claim", async () => {
    const { store, userId } = await enabledStore();
    const domain = `rollback-${randomUUID().slice(0, 8)}.example.com`;
    await expect(store.runInWorkspaceTransaction(userId, async () => {
      expect(await store.addCustomDomain(userId, domain)).toBeTruthy();
      throw new Error("domain failure");
    })).rejects.toThrow("domain failure");
    expect(await store.listCustomDomains(userId)).toEqual([]);
    expect(store.hostnameRegistry.get(domain)).toBeUndefined();
  });

  it("rejects a nested cross-tenant transaction without creating the other workspace", async () => {
    const { store, userId } = await enabledStore();
    const outsider = randomUUID();
    await expect(store.runInWorkspaceTransaction(userId, () => store.runInWorkspaceTransaction(outsider, async () => undefined))).rejects.toThrow(/cannot cross tenant boundaries/);
    expect(await store.getWorkspaceBySlug(`workspace-${outsider.slice(0, 8)}`)).toBeUndefined();
  });
});
