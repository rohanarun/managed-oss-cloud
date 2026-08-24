import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = [path.resolve("node_modules")];
const packages = new Map();
const prohibited = /(?:^|[()\s])(?:AGPL|GPL|LGPL|SSPL|BUSL|BSL|Elastic|Commons Clause|PolyForm|FSL|noncommercial)/i;

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const child = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) { await visit(child); continue; }
    const manifestPath = path.join(child, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name && manifest.version) packages.set(`${manifest.name}@${manifest.version}`, String(manifest.license ?? manifest.licenses ?? "UNKNOWN"));
    } catch {}
    await visit(path.join(child, "node_modules"));
  }
}

for (const root of roots) await visit(root);
const blocked = [...packages].filter(([, license]) => prohibited.test(license));
const unknown = [...packages].filter(([, license]) => license === "UNKNOWN" || license === "UNLICENSED");
if (blocked.length || unknown.length) {
  if (blocked.length) process.stderr.write(`Prohibited dependency licenses:\n${blocked.map(([name, license]) => `- ${name}: ${license}`).join("\n")}\n`);
  if (unknown.length) process.stderr.write(`Unknown dependency licenses:\n${unknown.map(([name]) => `- ${name}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`${packages.size} dependency package versions passed the permissive-license gate.\n`);
