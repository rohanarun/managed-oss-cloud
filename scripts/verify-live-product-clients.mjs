import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running live product verification.`);
  return value;
}

function workspaceId(payload) {
  const candidate = payload?.workspace?.id ?? payload?.id;
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error("The live workspace response did not include an ID.");
  return candidate;
}

async function productDefinitions(root) {
  const products = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(directory, "product-manifest.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (manifest?.product?.slug !== entry.name || typeof manifest?.module?.id !== "string") {
      throw new Error(`Invalid generated product identity in ${directory}.`);
    }
    products.push({ directory, manifest });
  }
  return products.sort((left, right) => left.manifest.product.slug.localeCompare(right.manifest.product.slug));
}

function clientEnvironment(token, baseUrl) {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    SUPERSUITE_TOKEN: token,
    SUPERSUITE_URL: baseUrl,
  }).filter(([, value]) => typeof value === "string" && value.length > 0));
}

async function verifyCli(product, environment) {
  const executable = join(product.directory, "src", "cli.mjs");
  const { stdout, stderr } = await execute(process.execPath, [executable, "workspace"], {
    env: environment,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (stderr.trim()) throw new Error(`${product.manifest.product.slug} CLI wrote to stderr: ${stderr.trim()}`);
  return workspaceId(JSON.parse(stdout));
}

async function verifyMcp(product, environment) {
  const executable = join(product.directory, "src", "mcp.mjs");
  const toolName = `${product.manifest.product.mcpPrefix}_workspace`;
  const child = spawn(process.execPath, [executable], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  child.stdin.end([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-product-verifier", version: "1" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: {} } }),
  ].join("\n") + "\n");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (exitCode !== 0) throw new Error(`${product.manifest.product.slug} MCP exited ${exitCode}: ${stderr.trim()}`);
  if (stderr.trim()) throw new Error(`${product.manifest.product.slug} MCP wrote to stderr: ${stderr.trim()}`);
  const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const initialized = messages.find((message) => message.id === 1);
  const called = messages.find((message) => message.id === 2);
  if (!initialized?.result || called?.error || called?.result?.isError === true) throw new Error(`${product.manifest.product.slug} MCP did not complete its workspace call.`);
  return workspaceId(called.result?.structuredContent?.result);
}

async function main() {
  const root = requiredEnvironment("MANAGED_OSS_PRODUCT_OUTPUT");
  const token = requiredEnvironment("SUPERSUITE_TOKEN");
  const baseUrl = requiredEnvironment("SUPERSUITE_URL");
  const expectedCount = Number(requiredEnvironment("EXPECTED_PRODUCT_COUNT"));
  if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error("EXPECTED_PRODUCT_COUNT must be a positive integer.");
  const products = await productDefinitions(root);
  if (products.length !== expectedCount) throw new Error(`Expected ${expectedCount} generated products, found ${products.length}.`);
  if (new Set(products.map((product) => product.manifest.module.id)).size !== products.length) throw new Error("Generated products do not have unique module identities.");

  const environment = clientEnvironment(token, baseUrl);
  const observedWorkspaceIds = new Set();
  for (const product of products) {
    observedWorkspaceIds.add(await verifyCli(product, environment));
    observedWorkspaceIds.add(await verifyMcp(product, environment));
  }
  if (observedWorkspaceIds.size !== 1) throw new Error("Product clients did not resolve to one shared tenant workspace.");
  process.stdout.write(JSON.stringify({
    ok: true,
    products: products.length,
    cliChecks: products.length,
    mcpChecks: products.length,
    sharedWorkspace: true,
    modules: products.map((product) => product.manifest.module.id).sort(),
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
