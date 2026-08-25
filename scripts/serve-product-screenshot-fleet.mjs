import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? "");
const basePort = Number(process.argv[3] ?? 4300);
const webKey = process.env.PRODUCT_WEB_KEY ?? "sample-workspace-key-2026";

if (!process.argv[2]) throw new Error("Usage: node scripts/serve-product-screenshot-fleet.mjs <generated-product-root> [base-port]");
if (!Number.isInteger(basePort) || basePort < 1024 || basePort + 36 > 65535) throw new Error("The base port must leave room for 37 product servers.");
if (webKey.length < 24) throw new Error("PRODUCT_WEB_KEY must contain at least 24 characters.");

const directories = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (directories.length !== 37) throw new Error(`Expected 37 generated product directories, found ${directories.length}.`);

const servers = [];
const products = [];

for (const [index, slug] of directories.entries()) {
  const productRoot = resolve(root, slug);
  const [{ createProductWebServer }, { DemoProductClient }, { manifest }] = await Promise.all([
    import(pathToFileURL(resolve(productRoot, "src/web-server.mjs")).href),
    import(pathToFileURL(resolve(productRoot, "src/demo-client.mjs")).href),
    import(pathToFileURL(resolve(productRoot, "src/manifest.mjs")).href),
  ]);
  if (manifest.product.slug !== slug) throw new Error(`Directory ${slug} contains the ${manifest.product.slug} manifest.`);
  const server = createProductWebServer({ client: new DemoProductClient(), webKey });
  const port = basePort + index;
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  servers.push(server);
  products.push({ slug, name: manifest.product.name, moduleId: manifest.module.id, port, url: `http://127.0.0.1:${port}/` });
}

process.stdout.write(`${JSON.stringify({ ok: true, root, webKey, products }, null, 2)}\n`);

async function close() {
  await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(() => resolveClose()))));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    close().finally(() => process.exit(0));
  });
}
