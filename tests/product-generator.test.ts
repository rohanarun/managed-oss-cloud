import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const generator = join(repositoryRoot, "scripts", "generate-product-repositories.mjs");

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
