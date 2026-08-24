import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemorySuiteStore } from "../src/server/suite-store";

describe("SuiteStore transaction composition", () => {
  it("reuses a nested in-memory workspace transaction without deadlocking", async () => {
    const store = new MemorySuiteStore("fleet");
    const userId = randomUUID();
    const result = await store.runInWorkspaceTransaction(userId, (outer) =>
      store.runInWorkspaceTransaction(userId, async (inner) => ({
        outer: outer.id,
        inner: inner.id,
      })),
    );
    expect(result.inner).toBe(result.outer);
  });

  it("rejects an attempted cross-tenant nested transaction", async () => {
    const store = new MemorySuiteStore("fleet");
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    await expect(
      store.runInWorkspaceTransaction(firstUserId, () =>
        store.runInWorkspaceTransaction(secondUserId, async () => true),
      ),
    ).rejects.toThrow("cannot cross tenant boundaries");
  });
});
