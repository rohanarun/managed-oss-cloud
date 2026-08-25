import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";
import { suiteModules } from "../src/shared/suite";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const generatorPath = path.join(repositoryRoot, "scripts", "generate-product-repositories.mjs");
const productCount = 37;
const generatedActionCount = 407;
const subprocessTimeoutMs = 5_000;

interface GeneratedAction {
  id: string;
  operation: string;
  recordType?: string;
  exampleInput: Record<string, unknown>;
  productMcpToolName: string;
}

interface GeneratedManifest {
  release: { productVersion: string };
  product: { slug: string; mcpPrefix: string };
  module: { id: string; recordTypes: string[] };
  experience: { primaryActionId: string };
  actions: GeneratedAction[];
}

interface DurableRecord {
  id: string;
  workspaceId: string;
  moduleId: string;
  recordType: string;
}

interface ListedRecord {
  id: string;
  moduleId: string;
  recordType: string;
  data?: never;
  workspaceId?: never;
}

interface RecordDetail {
  id: string;
  moduleId: string;
  recordType: string;
  data: Record<string, unknown>;
}

interface ProductClientShape {
  workspace(): Promise<unknown>;
  listRecords(options: { recordType?: string; state?: string; search?: string; limit?: number; cursor?: string }): Promise<unknown>;
  recordDetail(recordId: string): Promise<unknown>;
  runAction(actionId: string, input: Record<string, unknown>): Promise<unknown>;
}

interface GeneratedProductClientModule {
  ProductClient: new (options: { baseUrl: string; token: string }) => ProductClientShape;
}

function tokenOnlyClientEnvironment(overrides: Record<string, string>) {
  const inheritedNames = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR"] as const;
  const inherited = Object.fromEntries(inheritedNames.flatMap((name) => {
    const value = process.env[name];
    return typeof value === "string" ? [[name, value]] : [];
  }));
  const environment = { ...inherited, ...overrides };
  const forbidden = Object.keys(environment).filter((name) => /(?:DATABASE|POSTGRES|^PG[A-Z_])/i.test(name));
  if (forbidden.length) throw new Error(`Generated product clients must not receive database credentials: ${forbidden.join(", ")}`);
  return environment;
}

function isDurableRecord(value: unknown): value is DurableRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DurableRecord>;
  return [record.id, record.workspaceId, record.moduleId, record.recordType].every((field) => typeof field === "string" && field.length > 0);
}

function recordsFrom(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const payload = value as { record?: unknown; records?: unknown };
  return [
    ...(isDurableRecord(payload.record) ? [payload.record] : []),
    ...(Array.isArray(payload.records) ? payload.records.filter(isDurableRecord) : []),
  ];
}

function recordsListedBy(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const records = (value as { records?: unknown }).records;
  return Array.isArray(records) ? records.filter((record): record is ListedRecord => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const summary = record as Partial<ListedRecord>;
    return [summary.id, summary.moduleId, summary.recordType].every((field) => typeof field === "string" && field.length > 0)
      && !("data" in record)
      && !("workspaceId" in record);
  }) : [];
}

function recordDetailedBy(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = (value as { record?: unknown }).record;
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const detail = record as Partial<RecordDetail>;
  if (![detail.id, detail.moduleId, detail.recordType].every((field) => typeof field === "string" && field.length > 0)) return undefined;
  if (!detail.data || typeof detail.data !== "object" || Array.isArray(detail.data) || "workspaceId" in record) return undefined;
  return detail as RecordDetail;
}

function resultFromMcp(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const structuredContent = (value as { structuredContent?: unknown }).structuredContent;
  if (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) return undefined;
  return (structuredContent as { result?: unknown }).result;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function acceptanceInput(
  manifest: GeneratedManifest,
  action: GeneratedAction,
  dependencies: { contactId: string; ownerId: string },
) {
  const input = structuredClone(action.exampleInput);
  if (manifest.module.id === "inbox" && action.id === "thread-open") input.contactId = dependencies.contactId;
  if (manifest.module.id === "people" && action.id === "create-profile") {
    input.employeeRef = dependencies.ownerId;
    input.managerRef = dependencies.ownerId;
  }
  if (manifest.module.id === "insights" && action.id === "source-register") input.ownerRef = dependencies.ownerId;
  if (manifest.module.id === "assurance" && action.id === "create-program") input.ownerRef = dependencies.ownerId;
  return input;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

describe("generated product real-backend acceptance", () => {
  let generatedRoot: string;
  let server: Server;
  let baseUrl: string;
  let suiteStore: MemorySuiteStore;
  let workspaceId: string;
  let ownerId: string;
  let contactId: string;
  let token: string;

  beforeAll(async () => {
    generatedRoot = await realpath(await mkdtemp(path.join(tmpdir(), "managed-oss-generated-products-")));
    const generated = await execFileAsync(process.execPath, ["--import", "tsx", generatorPath, "--output", generatedRoot], {
      cwd: repositoryRoot,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(generated.stderr).toBe("");
    const summary = JSON.parse(generated.stdout) as { outputRoot: string; products: unknown[]; totalActions: number };
    expect(summary.outputRoot).toBe(generatedRoot);
    expect(summary.products).toHaveLength(productCount);
    expect(summary.totalActions).toBe(generatedActionCount);

    suiteStore = new MemorySuiteStore("fleet");
    const app = await createApp({
      repository: new MemoryRepository(),
      suiteStore,
      suiteEntitlementMode: "unrestricted",
      synchronizeSuiteEntitlements: false,
    });
    server = createServer(app);
    await withDeadline(new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    }), 5_000, "Acceptance HTTP server startup");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Acceptance HTTP server did not bind a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const owner = request.agent(baseUrl);
    const signup = await owner.post("/api/auth/signup").send({
      displayName: "Generated Product Acceptance Owner",
      email: "generated-products@example.test",
      password: "generated-products-acceptance-password",
    });
    expect(signup.status, JSON.stringify(signup.body)).toBe(201);
    ownerId = String(signup.body.user.id);
    expect((await suiteStore.setWorkspacePlan(ownerId, "fleet"))?.plan).toBe("fleet");

    for (const module of suiteModules) {
      const enabled = await owner.post(`/api/suite/modules/${module.id}/enable`);
      expect(enabled.status, `Failed to enable ${module.id}: ${JSON.stringify(enabled.body)}`).toBe(201);
    }
    const workspace = await owner.get("/api/suite/workspace");
    expect(workspace.status).toBe(200);
    workspaceId = String(workspace.body.workspace.id);
    expect(new Set(workspace.body.workspace.enabledModuleIds)).toEqual(new Set(suiteModules.map((module) => module.id)));

    const accountResponse = await owner.post("/api/suite/modules/crm/actions/account-upsert").send({ input: {
      externalKey: "generated-product-acceptance-account",
      name: "Generated product acceptance account",
      domain: "generated-products.example.test",
      idempotencyKey: "generated-products.acceptance.account.0001",
    } });
    expect([200, 201], JSON.stringify(accountResponse.body)).toContain(accountResponse.status);
    const account = recordsFrom(accountResponse.body).find((record) => record.recordType === "account");
    if (!account) throw new Error("The RelayDesk dependency account was not returned by the real backend.");
    const contactResponse = await owner.post("/api/suite/modules/crm/actions/contact-link").send({ input: {
      accountId: account.id,
      name: "Generated product acceptance contact",
      email: "relaydesk-contact@example.test",
      consentBasis: "Isolated synthetic acceptance fixture.",
      idempotencyKey: "generated-products.acceptance.contact.0001",
    } });
    expect([200, 201], JSON.stringify(contactResponse.body)).toContain(contactResponse.status);
    const contact = recordsFrom(contactResponse.body).find((record) => record.recordType === "contact");
    if (!contact) throw new Error("The RelayDesk dependency contact was not returned by the real backend.");
    contactId = contact.id;

    const tokenResponse = await owner.post("/api/suite/api-tokens").send({
      name: "Generated product acceptance clients",
      scopes: ["read", "write", "ai"],
      expiresInDays: 1,
    });
    expect(tokenResponse.status, JSON.stringify(tokenResponse.body)).toBe(201);
    token = String(tokenResponse.body.token.token);
    expect(token).toMatch(/^sup_/);
  }, 45_000);

  afterAll(async () => {
    if (server) {
      await withDeadline(new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }), 5_000, "Acceptance HTTP server shutdown");
    }
    if (generatedRoot) await rm(generatedRoot, { recursive: true, force: true });
  });

  it("runs every manifest primary workflow and observes its record through its client, CLI, and MCP", async () => {
    const productDirectories = (await readdir(generatedRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(productDirectories).toHaveLength(productCount);
    expect(new Set(productDirectories).size).toBe(productCount);

    const clientEnvironment = tokenOnlyClientEnvironment({ SUPERSUITE_TOKEN: token, SUPERSUITE_URL: baseUrl });
    const failures: string[] = [];
    const acceptedModules = new Set<string>();

    for (const productDirectory of productDirectories) {
      let stage = "read generated manifest";
      let manifest: GeneratedManifest | undefined;
      try {
        const productRoot = path.join(generatedRoot, productDirectory);
        manifest = JSON.parse(await readFile(path.join(productRoot, "product-manifest.json"), "utf8")) as GeneratedManifest;
        expect(manifest.product.slug).toBe(productDirectory);
        expect(manifest.module.recordTypes.length).toBeGreaterThan(0);
        const primaryActionId = manifest.experience.primaryActionId;
        const primaryAction = manifest.actions.find((action) => action.id === primaryActionId);
        if (!primaryAction) throw new Error(`Primary action ${primaryActionId} is absent from the generated manifest.`);

        stage = "authenticate generated product client workspace";
        const clientModule = await import(pathToFileURL(path.join(productRoot, "src", "client.mjs")).href) as GeneratedProductClientModule;
        const productClient = new clientModule.ProductClient({ baseUrl, token });
        const workspacePayload = await withDeadline(productClient.workspace(), subprocessTimeoutMs, `${productDirectory} client workspace`);
        const workspace = (workspacePayload as { workspace?: { id?: string; enabledModuleIds?: unknown } }).workspace;
        expect(workspace?.id).toBe(workspaceId);
        expect(workspace?.enabledModuleIds).toContain(manifest.module.id);

        stage = `run manifest primary action ${primaryAction.id}`;
        const actionInput = acceptanceInput(manifest, primaryAction, { contactId, ownerId });
        const actionResult = await withDeadline(
          productClient.runAction(primaryAction.id, actionInput),
          subprocessTimeoutMs,
          `${productDirectory} primary action`,
        );
        const returnedRecords = recordsFrom(actionResult).filter((record) => record.moduleId === manifest!.module.id);
        const returnedRecord = primaryAction.recordType
          ? returnedRecords.find((record) => record.recordType === primaryAction.recordType)
          : returnedRecords[0];
        if (!returnedRecord) {
          throw new Error(`Primary action ${primaryAction.id} returned no durable ${primaryAction.recordType ?? manifest.module.id} record.`);
        }
        expect(returnedRecord.workspaceId).toBe(workspaceId);
        expect(manifest.module.recordTypes).toContain(returnedRecord.recordType);

        stage = `list ${returnedRecord.recordType} through generated product client`;
        const clientPage = await withDeadline(
          productClient.listRecords({ recordType: returnedRecord.recordType, search: returnedRecord.id, limit: 100 }),
          subprocessTimeoutMs,
          `${productDirectory} client list`,
        );
        const listedByClient = recordsListedBy(clientPage);
        expect(listedByClient.map((record) => record.id)).toContain(returnedRecord.id);
        expect(listedByClient.every((record) => !("data" in record) && !("workspaceId" in record))).toBe(true);
        const detailedByClient = recordDetailedBy(await withDeadline(
          productClient.recordDetail(returnedRecord.id),
          subprocessTimeoutMs,
          `${productDirectory} client detail`,
        ));
        expect(detailedByClient?.id).toBe(returnedRecord.id);
        expect(detailedByClient?.moduleId).toBe(manifest.module.id);

        stage = `replay ${primaryAction.id} and list ${returnedRecord.recordType} through generated CLI`;
        const cliAction = await execFileAsync(process.execPath, [
          path.join(productRoot, "src", "cli.mjs"),
          "action",
          primaryAction.id,
          JSON.stringify(actionInput),
        ], {
          cwd: productRoot,
          env: clientEnvironment,
          timeout: subprocessTimeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        });
        expect(cliAction.stderr).toBe("");
        const cliReturnedRecord = recordsFrom(JSON.parse(cliAction.stdout)).find((record) => (
          record.moduleId === manifest!.module.id && record.recordType === returnedRecord.recordType
        ));
        if (!cliReturnedRecord) throw new Error(`CLI action ${primaryAction.id} returned no durable ${returnedRecord.recordType} record.`);
        expect(cliReturnedRecord.workspaceId).toBe(workspaceId);
        const cli = await execFileAsync(process.execPath, [path.join(productRoot, "src", "cli.mjs"), "list", returnedRecord.recordType, "100"], {
          cwd: productRoot,
          env: clientEnvironment,
          timeout: subprocessTimeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        });
        expect(cli.stderr).toBe("");
        const cliListedRecordIds = recordsListedBy(JSON.parse(cli.stdout)).map((record) => record.id);
        expect(cliListedRecordIds).toContain(returnedRecord.id);
        expect(cliListedRecordIds).toContain(cliReturnedRecord.id);
        const cliDetail = await execFileAsync(process.execPath, [path.join(productRoot, "src", "cli.mjs"), "detail", returnedRecord.id], {
          cwd: productRoot,
          env: clientEnvironment,
          timeout: subprocessTimeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        });
        expect(cliDetail.stderr).toBe("");
        expect(recordDetailedBy(JSON.parse(cliDetail.stdout))?.id).toBe(returnedRecord.id);

        stage = `inspect workspace and list ${returnedRecord.recordType} through generated MCP`;
        const mcp = new Client({ name: `generated-${productDirectory}-acceptance`, version: manifest.release.productVersion });
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [path.join(productRoot, "src", "mcp.mjs")],
          cwd: productRoot,
          env: clientEnvironment,
          stderr: "pipe",
        });
        try {
          await withDeadline(mcp.connect(transport), subprocessTimeoutMs, `${productDirectory} MCP connect`);
          const tools = await withDeadline(mcp.listTools(), subprocessTimeoutMs, `${productDirectory} MCP tools/list`);
          const toolNames = tools.tools.map((tool) => tool.name);
          expect(toolNames).toEqual(expect.arrayContaining([
            `${manifest.product.mcpPrefix}_workspace`,
            `${manifest.product.mcpPrefix}_list_records`,
            `${manifest.product.mcpPrefix}_record_detail`,
            primaryAction.productMcpToolName,
          ]));
          const mcpWorkspace = resultFromMcp(await withDeadline(
            mcp.callTool({ name: `${manifest.product.mcpPrefix}_workspace`, arguments: {} }),
            subprocessTimeoutMs,
            `${productDirectory} MCP workspace`,
          )) as { workspace?: { id?: string; enabledModuleIds?: string[] } } | undefined;
          expect(mcpWorkspace?.workspace?.id).toBe(workspaceId);
          expect(mcpWorkspace?.workspace?.enabledModuleIds).toContain(manifest.module.id);
          const mcpAction = resultFromMcp(await withDeadline(
            mcp.callTool({ name: primaryAction.productMcpToolName, arguments: actionInput }),
            subprocessTimeoutMs,
            `${productDirectory} MCP primary action`,
          ));
          const mcpReturnedRecord = recordsFrom(mcpAction).find((record) => (
            record.moduleId === manifest!.module.id && record.recordType === returnedRecord.recordType
          ));
          if (!mcpReturnedRecord) throw new Error(`MCP action ${primaryAction.id} returned no durable ${returnedRecord.recordType} record.`);
          expect(mcpReturnedRecord.workspaceId).toBe(workspaceId);
          const mcpList = resultFromMcp(await withDeadline(
            mcp.callTool({ name: `${manifest.product.mcpPrefix}_list_records`, arguments: { recordType: returnedRecord.recordType, limit: 100 } }),
            subprocessTimeoutMs,
            `${productDirectory} MCP list`,
          ));
          const mcpListedRecordIds = recordsListedBy(mcpList).map((record) => record.id);
          expect(mcpListedRecordIds).toContain(returnedRecord.id);
          expect(mcpListedRecordIds).toContain(cliReturnedRecord.id);
          expect(mcpListedRecordIds).toContain(mcpReturnedRecord.id);
          const mcpDetail = resultFromMcp(await withDeadline(
            mcp.callTool({ name: `${manifest.product.mcpPrefix}_record_detail`, arguments: { recordId: returnedRecord.id } }),
            subprocessTimeoutMs,
            `${productDirectory} MCP detail`,
          ));
          expect(recordDetailedBy(mcpDetail)?.id).toBe(returnedRecord.id);
        } finally {
          await withDeadline(mcp.close(), subprocessTimeoutMs, `${productDirectory} MCP close`);
        }

        acceptedModules.add(manifest.module.id);
      } catch (error) {
        failures.push(`${manifest?.product.slug ?? productDirectory} [${stage}]: ${describeError(error)}`);
      }
    }

    expect(failures, `Generated product acceptance failures:\n${failures.join("\n")}`).toEqual([]);
    expect(acceptedModules).toEqual(new Set(suiteModules.map((module) => module.id)));
  }, 120_000);
});
