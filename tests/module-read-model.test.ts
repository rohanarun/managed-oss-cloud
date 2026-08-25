import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSuiteModuleReadModelService,
  SuiteModuleReadModelError,
} from "../src/server/module-read-model.js";
import {
  MemorySuiteStore,
  PostgresSuiteStore,
  type SuiteStore,
} from "../src/server/suite-store.js";
import { SuiteRecordPageCursorError } from "../src/server/suite-record-page.js";
import type { SuiteRecord } from "../src/shared/suite.js";

const equalTimestamp = "2026-08-25T12:00:00.000Z";

function memoryRecords(store: MemorySuiteStore) {
  return (store as unknown as { records: Map<string, SuiteRecord> }).records;
}

function setMemoryUpdatedAt(store: MemorySuiteStore, recordIds: string[], updatedAt: string) {
  for (const recordId of recordIds) {
    const record = memoryRecords(store).get(recordId);
    if (!record) throw new Error(`Missing memory record fixture ${recordId}.`);
    record.updatedAt = updatedAt;
  }
}

async function collectRecordIds(
  store: Pick<SuiteStore, "listRecordPage">,
  userId: string,
  input: Omit<Parameters<SuiteStore["listRecordPage"]>[1], "cursor">,
) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listRecordPage(userId, { ...input, cursor });
    ids.push(...page.records.map((record) => record.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

describe("Module Read Model v1 memory store", () => {
  it("paginates equal timestamps exactly once with the stable descending ID tie-breaker", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerId = randomUUID();
    await store.getOrCreateWorkspace(ownerId);
    await store.enableModule(ownerId, "crm");
    const records = await Promise.all([
      store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Alpha one", state: "active", data: { secret: "one" } }),
      store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Alpha two", state: "active", data: { secret: "two" } }),
      store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Alpha three", state: "active", data: { secret: "three" } }),
    ]);
    if (records.some((record) => !record)) throw new Error("Expected CRM fixtures.");
    const persisted = records as SuiteRecord[];
    setMemoryUpdatedAt(store, persisted.map((record) => record.id), equalTimestamp);

    const expected = persisted.map((record) => record.id).sort().reverse();
    const actual = await collectRecordIds(store, ownerId, { moduleId: "crm", limit: 1 });
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);

    const first = await store.listRecordPage(ownerId, { moduleId: "crm", limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect(first.records.every((record) => !("data" in record) && !("workspaceId" in record))).toBe(true);
    expect(JSON.stringify(first)).not.toContain("secret");
    expect((await store.listRecords(ownerId, { moduleId: "crm", limit: 1 }))[0].data).toBeDefined();
  });

  it("applies module, type, state, title-prefix, and exact-ID filters without substring expansion", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerId = randomUUID();
    await store.getOrCreateWorkspace(ownerId);
    await store.enableModule(ownerId, "crm");
    await store.enableModule(ownerId, "finance");
    const active = await store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Alpha account", state: "active", data: { private: "active" } });
    const archived = await store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Alphabet archive", state: "archived", data: { private: "archived" } });
    await store.createRecord(ownerId, { moduleId: "crm", recordType: "company", title: "Alpha company", state: "active" });
    await store.createRecord(ownerId, { moduleId: "finance", recordType: "client", title: "Alpha external module", state: "active" });
    if (!active || !archived) throw new Error("Expected filter fixtures.");

    const filtered = await store.listRecordPage(ownerId, { moduleId: "crm", recordType: "contact", state: "active", search: "  ALPHA  ", limit: 10 });
    expect(filtered.records.map((record) => record.id)).toEqual([active.id]);
    expect((await store.listRecordPage(ownerId, { moduleId: "crm", search: "pha", limit: 10 })).records).toEqual([]);
    expect((await store.listRecordPage(ownerId, { moduleId: "crm", state: "archived", search: archived.id.toUpperCase(), limit: 10 })).records.map((record) => record.id)).toEqual([archived.id]);
  });

  it("rejects malformed, filter-mismatched, caller-mismatched, and tenant-mismatched cursors", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const outsiderId = randomUUID();
    await store.getOrCreateWorkspace(ownerId);
    await store.enableModule(ownerId, "crm");
    await store.addWorkspaceMember(ownerId, memberId, "member");
    await store.getOrCreateWorkspace(outsiderId);
    await store.enableModule(outsiderId, "crm");
    await store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "First", state: "active" });
    await store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Second", state: "active" });
    const first = await store.listRecordPage(ownerId, { moduleId: "crm", recordType: "contact", limit: 1 });
    if (!first.nextCursor) throw new Error("Expected a continuation cursor.");

    await expect(store.listRecordPage(ownerId, { moduleId: "crm", recordType: "contact", state: "active", limit: 1, cursor: first.nextCursor })).rejects.toBeInstanceOf(SuiteRecordPageCursorError);
    await expect(store.listRecordPage(memberId, { moduleId: "crm", recordType: "contact", limit: 1, cursor: first.nextCursor })).rejects.toBeInstanceOf(SuiteRecordPageCursorError);
    await expect(store.listRecordPage(outsiderId, { moduleId: "crm", recordType: "contact", limit: 1, cursor: first.nextCursor })).rejects.toBeInstanceOf(SuiteRecordPageCursorError);
    await expect(store.listRecordPage(ownerId, { moduleId: "crm", recordType: "contact", limit: 1, cursor: "not-a-cursor" })).rejects.toBeInstanceOf(SuiteRecordPageCursorError);

    await expect(store.listRecordPage(ownerId, { moduleId: "crm", recordType: "contact", limit: 2, cursor: first.nextCursor })).resolves.toBeDefined();
  });

  it("preserves record visibility across hidden and cross-tenant page and detail reads", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const peerId = randomUUID();
    const outsiderId = randomUUID();
    await store.getOrCreateWorkspace(ownerId);
    await store.enableModule(ownerId, "community");
    await store.addWorkspaceMember(ownerId, memberId, "member");
    await store.addWorkspaceMember(ownerId, peerId, "member");
    await store.getOrCreateWorkspace(outsiderId);
    await store.enableModule(outsiderId, "community");

    const shared = await store.createRecord(ownerId, { moduleId: "community", recordType: "community-post", title: "Shared post", state: "visible", data: { spaceVisibility: "workspace", authorRef: ownerId, privateBody: "shared" } });
    const ownHidden = await store.createRecord(memberId, { moduleId: "community", recordType: "community-post", title: "Own hidden post", state: "hidden", data: { spaceVisibility: "workspace", authorRef: memberId, privateBody: "own" } });
    const peerHidden = await store.createRecord(peerId, { moduleId: "community", recordType: "community-post", title: "Peer hidden post", state: "hidden", data: { spaceVisibility: "workspace", authorRef: peerId, privateBody: "peer" } });
    const outsider = await store.createRecord(outsiderId, { moduleId: "community", recordType: "community-post", title: "Other tenant", state: "visible", data: { spaceVisibility: "workspace", authorRef: outsiderId, privateBody: "outsider" } });
    if (!shared || !ownHidden || !peerHidden || !outsider) throw new Error("Expected visibility fixtures.");

    const ids = await collectRecordIds(store, memberId, { moduleId: "community", limit: 1 });
    expect(ids).toEqual(expect.arrayContaining([shared.id, ownHidden.id]));
    expect(ids).not.toEqual(expect.arrayContaining([peerHidden.id, outsider.id]));

    const readModel = createSuiteModuleReadModelService(store);
    expect(await readModel.getRecordDetail(memberId, "community", ownHidden.id)).toMatchObject({ id: ownHidden.id, data: { privateBody: "own" } });
    expect(await readModel.getRecordDetail(memberId, "community", peerHidden.id)).toBeUndefined();
    expect(await readModel.getRecordDetail(memberId, "community", outsider.id)).toBeUndefined();
    expect(await readModel.getRecordDetail(memberId, "crm", ownHidden.id)).toBeUndefined();
  });

  it("projects only module-scoped page, detail, and declared read capabilities", async () => {
    const store = new MemorySuiteStore("fleet");
    const ownerId = randomUUID();
    await store.getOrCreateWorkspace(ownerId);
    await store.enableModule(ownerId, "crm");
    const record = await store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Scoped detail", data: { email: "private@example.com" } });
    if (!record) throw new Error("Expected detail fixture.");
    const readModel = createSuiteModuleReadModelService(store);

    const projection = await readModel.listRecordPage(ownerId, "crm", { limit: 10 });
    expect(projection.records.map((item) => item.id)).toContain(record.id);
    expect(projection.capabilities).toMatchObject({
      version: "module-read-model.v1",
      moduleId: "crm",
      recordPage: { order: "updatedAt-desc-id-desc", filters: ["recordType", "state", "titlePrefixOrExactId"] },
      recordDetail: true,
    });
    for (const unsupported of ["activity", "relationships", "export", "delete", "exportReady", "deleteReady"]) {
      expect(projection.capabilities).not.toHaveProperty(unsupported);
    }
    expect(await readModel.getRecordDetail(ownerId, "crm", record.id)).toMatchObject({ id: record.id, data: { email: "private@example.com" } });
    expect(() => readModel.capabilities("unknown-module")).toThrow(SuiteModuleReadModelError);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Module Read Model v1 PostgreSQL parity", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false });
  const store = new PostgresSuiteStore(databaseUrl, false);
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const outsiderId = randomUUID();

  beforeAll(async () => {
    await store.initialize();
    await pool.query("TRUNCATE suite_workspaces,users CASCADE");
    for (const [id, email] of [[ownerId, "read-owner@example.com"], [memberId, "read-member@example.com"], [outsiderId, "read-outsider@example.com"]]) {
      await pool.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$2,'unused')", [id, email]);
    }
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  it("matches memory pagination, filtering, summary, visibility, and tenant boundaries", async () => {
    const workspace = await store.getOrCreateWorkspace(ownerId);
    await store.setWorkspacePlan(ownerId, "fleet");
    await store.enableModule(ownerId, "crm");
    await store.enableModule(ownerId, "community");
    await store.addWorkspaceMember(ownerId, memberId, "member");
    await store.getOrCreateWorkspace(outsiderId);
    await store.setWorkspacePlan(outsiderId, "fleet");
    await store.enableModule(outsiderId, "crm");

    const contacts = await Promise.all([
      store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Alpha first", state: "active", data: { private: "one" } }),
      store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Alpha second", state: "active", data: { private: "two" } }),
      store.createRecord(ownerId, { moduleId: "crm", recordType: "contact", title: "Beta archived", state: "archived", data: { private: "three" } }),
    ]);
    if (contacts.some((record) => !record)) throw new Error("Expected PostgreSQL contacts.");
    const persisted = contacts as SuiteRecord[];
    await pool.query("UPDATE suite_records SET updated_at=$2 WHERE id=ANY($1::UUID[])", [persisted.map((record) => record.id), equalTimestamp]);

    const activeIds = await collectRecordIds(store, ownerId, { moduleId: "crm", recordType: "contact", state: "active", search: "alpha", limit: 1 });
    expect(activeIds).toEqual(persisted.slice(0, 2).map((record) => record.id).sort().reverse());
    const exact = await store.listRecordPage(ownerId, { moduleId: "crm", search: persisted[2].id.toUpperCase(), limit: 10 });
    expect(exact.records.map((record) => record.id)).toEqual([persisted[2].id]);
    expect(exact.records[0]).not.toHaveProperty("data");
    expect(exact.records[0]).not.toHaveProperty("workspaceId");

    const shared = await store.createRecord(ownerId, { moduleId: "community", recordType: "community-post", title: "Shared", state: "visible", data: { spaceVisibility: "workspace", authorRef: ownerId } });
    const hidden = await store.createRecord(ownerId, { moduleId: "community", recordType: "community-post", title: "Hidden", state: "hidden", data: { spaceVisibility: "workspace", authorRef: ownerId } });
    const outsider = await store.createRecord(outsiderId, { moduleId: "crm", recordType: "contact", title: "Other tenant", state: "active", data: { private: "other" } });
    if (!shared || !hidden || !outsider) throw new Error("Expected PostgreSQL visibility fixtures.");
    expect((await store.listRecordPage(memberId, { moduleId: "community", limit: 10 })).records.map((record) => record.id)).toEqual([shared.id]);
    expect((await store.listRecordPage(ownerId, { moduleId: "crm", limit: 10 })).records.map((record) => record.id)).not.toContain(outsider.id);
    expect(await createSuiteModuleReadModelService(store).getRecordDetail(ownerId, "crm", outsider.id)).toBeUndefined();

    const first = await store.listRecordPage(ownerId, { moduleId: "crm", limit: 1 });
    if (!first.nextCursor) throw new Error("Expected PostgreSQL cursor.");
    await expect(store.listRecordPage(ownerId, { moduleId: "crm", state: "active", limit: 1, cursor: first.nextCursor })).rejects.toBeInstanceOf(SuiteRecordPageCursorError);
    expect(workspace.id).not.toBe((await store.getOrCreateWorkspace(outsiderId)).id);
  });
});
