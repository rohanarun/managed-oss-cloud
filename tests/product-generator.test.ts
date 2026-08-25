import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const generator = join(repositoryRoot, "scripts", "generate-product-repositories.mjs");

function generatedFunction(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  if (start === -1 || end === -1) throw new Error(`Could not locate generated function ${name}.`);
  return source.slice(start, end);
}

describe("standalone product repository generator", () => {
  it("generates only an explicitly selected registered product with closed schemas", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "managed-oss-product-generator-"));
    try {
      const { stdout } = await execute(process.execPath, [
        "--import",
        "tsx",
        generator,
        "--output",
        outputRoot,
        "--only",
        "schemadeck",
      ], { cwd: repositoryRoot });
      const summary = JSON.parse(stdout) as {
        products: Array<{ slug: string; moduleId: string; actions: number }>;
        totalActions: number;
      };
      expect(summary.products).toEqual([{ slug: "schemadeck", path: join(outputRoot, "schemadeck"), moduleId: "tables", actions: 9 }]);
      expect(summary.totalActions).toBe(9);

      const manifest = JSON.parse(await readFile(join(outputRoot, "schemadeck", "product-manifest.json"), "utf8")) as {
        product: { slug: string };
        module: { id: string; recordTypes: string[] };
        experience: { workflowGroups: Array<{ actionIds: string[] }> };
        actions: Array<{ recordType?: string; exampleInput: unknown; inputSchema: { type?: string; additionalProperties?: boolean } }>;
      };
      expect(manifest.product.slug).toBe("schemadeck");
      expect(manifest.module.id).toBe("tables");
      expect(manifest.actions).toHaveLength(9);
      expect(manifest.actions.every((action) => action.inputSchema.type === "object" && action.inputSchema.additionalProperties === false)).toBe(true);
      expect(manifest.actions.every((action) => !action.recordType || manifest.module.recordTypes.includes(action.recordType))).toBe(true);
      expect(manifest.experience.workflowGroups.flatMap((group) => group.actionIds)).toHaveLength(manifest.actions.length);
      expect(JSON.stringify(manifest.actions.map((action) => action.exampleInput))).not.toMatch(/<[^<>]+>/);

      const [client, cli, mcp, webServer, webApp, webHtml] = await Promise.all([
        readFile(join(outputRoot, "schemadeck", "src", "client.mjs"), "utf8"),
        readFile(join(outputRoot, "schemadeck", "src", "cli.mjs"), "utf8"),
        readFile(join(outputRoot, "schemadeck", "src", "mcp.mjs"), "utf8"),
        readFile(join(outputRoot, "schemadeck", "src", "web-server.mjs"), "utf8"),
        readFile(join(outputRoot, "schemadeck", "web", "app.js"), "utf8"),
        readFile(join(outputRoot, "schemadeck", "web", "index.html"), "utf8"),
      ]);
      expect(client).toContain('"/api/suite/modules/" + manifest.module.id + "/records?"');
      expect(client).toContain("limit > 100");
      expect(client).toContain("recordDetail(value)");
      expect(client).not.toContain('this.request("/api/suite/records?"');
      expect(cli).toContain('command === "page"');
      expect(cli).toContain('command === "detail"');
      expect(mcp).toContain('detail: prefix + "_record_detail"');
      expect(mcp).toContain("maximum: 100");
      expect(webServer).toContain('url.searchParams.get("cursor")');
      expect(webServer).toContain('url.pathname.startsWith("/product-api/records/")');
      expect(webApp).toContain('query.set("search", state.recordQuery.trim())');
      expect(webApp).toContain('query.set("state", state.recordState.trim())');
      expect(webApp).toContain('query.set("cursor", cursor)');
      expect(webApp).toContain('api("/product-api/records/" + encodeURIComponent(recordId))');
      expect(webApp).not.toContain("JSON.stringify(record.data)");
      expect(webHtml).toContain('id="load-more-records"');
      expect(webHtml).toContain('id="record-state-filter"');
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("ships regression tests for every generated schema assertion", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "managed-oss-product-generator-"));
    try {
      await execute(process.execPath, [
        "--import",
        "tsx",
        generator,
        "--output",
        outputRoot,
        "--only",
        "signalmesh",
      ], { cwd: repositoryRoot });
      const productRoot = join(outputRoot, "signalmesh");
      const packageMetadata = JSON.parse(await readFile(join(productRoot, "package.json"), "utf8")) as { version: string };
      expect(packageMetadata.version).toBe("0.3.0");
      const { stdout } = await execute("npm", ["test"], { cwd: productRoot });
      expect(stdout).toMatch(/tests 12/);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("emits tutorial release gates and a runnable real-backend primary workflow contract", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "managed-oss-product-generator-"));
    try {
      await execute(process.execPath, [
        "--import",
        "tsx",
        generator,
        "--output",
        outputRoot,
        "--only",
        "peopleweave,relaydesk,proofline-insights,liveforum",
      ], { cwd: repositoryRoot });

      const peopleRoot = join(outputRoot, "peopleweave");
      const [webApp, verifier, readme, workflow, packageBytes, peopleBytes, relayBytes, prooflineBytes] = await Promise.all([
        readFile(join(peopleRoot, "web", "app.js"), "utf8"),
        readFile(join(peopleRoot, "scripts", "verify-tutorial.mjs"), "utf8"),
        readFile(join(peopleRoot, "README.md"), "utf8"),
        readFile(join(peopleRoot, ".github", "workflows", "ci.yml"), "utf8"),
        readFile(join(peopleRoot, "package.json"), "utf8"),
        readFile(join(peopleRoot, "product-manifest.json"), "utf8"),
        readFile(join(outputRoot, "relaydesk", "product-manifest.json"), "utf8"),
        readFile(join(outputRoot, "proofline-insights", "product-manifest.json"), "utf8"),
      ]);
      const packageMetadata = JSON.parse(packageBytes) as { files: string[]; scripts: Record<string, string> };
      const peopleManifest = JSON.parse(peopleBytes) as {
        actions: Array<{ id: string; exampleInput: Record<string, unknown>; inputSchema: { properties?: Record<string, unknown> } }>;
      };
      const relayManifest = JSON.parse(relayBytes) as { experience: { primaryActionId: string; quickActionIds: string[] } };
      const prooflineManifest = JSON.parse(prooflineBytes) as {
        experience: { primaryActionId: string; quickActionIds: string[] };
        actions: Array<{ id: string; exampleInput: Record<string, unknown>; inputSchema: { properties?: Record<string, unknown> } }>;
      };

      expect(verifier).toContain('readFile(new URL("../docs/tutorial.mp4"');
      expect(verifier).toContain('readFile(new URL("../docs/tutorial.srt"');
      expect(verifier).toContain('readFile(new URL("../docs/tutorial-proof.json"');
      expect(verifier).toContain('proof.schema, "managed-oss-functional-tutorial.v1"');
      expect(verifier).toContain("proof.functionalProof.action.id, manifest.experience.primaryActionId");
      expect(verifier).toContain("proof.functionalProof.detail.matched, true");
      expect(verifier).toContain("proof.video.final.sha256, digest(video)");
      expect(packageMetadata.files).toContain("docs");
      expect(packageMetadata.scripts["verify:tutorial"]).toBe("node scripts/verify-tutorial.mjs");
      expect(workflow).toContain("- run: npm run verify:tutorial");
      expect(workflow.indexOf("npm run verify:tutorial")).toBeLessThan(workflow.indexOf("npm pack --dry-run"));
      expect(readme).toContain("## Functional tutorial");
      expect(readme).toContain("[Watch the real-backend product tutorial](./docs/tutorial.mp4)");
      expect(readme).toContain("[Download subtitles](./docs/tutorial.srt)");
      expect(readme).toContain("[Inspect functional proof](./docs/tutorial-proof.json)");
      expect(readme).toContain("npm run verify:tutorial");

      const createProfile = peopleManifest.actions.find((action) => action.id === "create-profile");
      expect(createProfile).toBeDefined();
      const runtimeExampleInput = runInNewContext(
        `(${generatedFunction(webApp, "runtimeExampleInput", "createField")})`,
        {
          structuredClone,
          workspaceValue: () => ({ userId: "11111111-1111-4111-8111-111111111111" }),
        },
      ) as (action: typeof createProfile) => Record<string, unknown>;
      const hydrated = runtimeExampleInput(createProfile);
      expect(hydrated).toMatchObject({
        employeeRef: "11111111-1111-4111-8111-111111111111",
        managerRef: "11111111-1111-4111-8111-111111111111",
      });
      expect(createProfile?.exampleInput).toMatchObject({
        employeeRef: "workspace-user-0001",
        managerRef: "workspace-user-0001",
      });
      const registerSource = prooflineManifest.actions.find((action) => action.id === "source-register");
      expect(registerSource).toBeDefined();
      expect(runtimeExampleInput(registerSource)).toMatchObject({
        ownerRef: "11111111-1111-4111-8111-111111111111",
      });

      expect(relayManifest.experience.primaryActionId).toBe("sla-policy-set");
      expect(relayManifest.experience.quickActionIds).toContain("sla-policy-set");
      expect(prooflineManifest.experience.primaryActionId).toBe("dashboard-create");
      expect(prooflineManifest.experience.quickActionIds).toContain("dashboard-create");

      class BrowserDate extends Date {
        override getTimezoneOffset() {
          return 240;
        }
      }
      const dateTimeLocalValue = runInNewContext(
        `(${generatedFunction(webApp, "dateTimeLocalValue", "make")})`,
        { Date: BrowserDate, Number },
      ) as (value: string) => string;
      expect(dateTimeLocalValue("2026-09-01T12:00:00.000Z")).toBe("2026-09-01T08:00");
      expect(dateTimeLocalValue("not-a-date")).toBe("");
      expect(webApp).toContain('control.value = schema.format === "date-time" ? dateTimeLocalValue(value) : String(value)');
      expect(webApp).toContain('new Date(control.value).toISOString()');
      expect(webApp).not.toContain('String(value).replace(/Z$/, "").slice(0, 16)');

      let connectDialogOpened = 0;
      const toastCalls: Array<[string, string]> = [];
      const disconnectedState = {
        connected: false,
        selectedAction: null,
        manifest: { actions: [{ id: "create-profile", title: "Create purpose-bound people profile" }] },
      };
      const openAction = runInNewContext(
        `(${generatedFunction(webApp, "openAction", "addActivity")})`,
        {
          state: disconnectedState,
          byId: (id: string) => {
            if (id !== "connect-dialog") throw new Error(`Unexpected disconnected element lookup: ${id}`);
            return { showModal: () => { connectDialogOpened += 1; } };
          },
          toast: (message: string, kind: string) => toastCalls.push([message, kind]),
        },
      ) as (actionId: string) => void;
      openAction("create-profile");
      expect(connectDialogOpened).toBe(1);
      expect(disconnectedState.selectedAction).toBeNull();
      expect(toastCalls).toEqual([["Connect the product server before opening a workflow.", "error"]]);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for an unknown product selector", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "managed-oss-product-generator-"));
    try {
      await expect(execute(process.execPath, [
        "--import",
        "tsx",
        generator,
        "--output",
        outputRoot,
        "--only",
        "unknown-product",
      ], { cwd: repositoryRoot })).rejects.toMatchObject({ stderr: expect.stringMatching(/Unknown product slug/) });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
