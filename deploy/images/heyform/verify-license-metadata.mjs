import { readFile } from "node:fs/promises";

const directory = new URL("./", import.meta.url);
const record = JSON.parse(await readFile(new URL("upstream-license.json", directory), "utf8"));
const dockerfile = await readFile(new URL("Dockerfile", directory), "utf8");
const readme = await readFile(new URL("../../../README.md", directory), "utf8");

function requireContract(condition, message) {
  if (!condition) throw new Error(`Managed HeyForm image license gate failed: ${message}`);
}

const expectedKeys = ["baseImage", "license", "licenseUrl", "modifiedSourceUrl", "upstreamSourceUrl"];
requireContract(
  JSON.stringify(Object.keys(record).sort()) === JSON.stringify(expectedKeys),
  "upstream-license.json must contain only the reviewed license fields",
);
requireContract(
  /^heyform\/community-edition:v3\.0\.1@sha256:[a-f0-9]{64}$/.test(record.baseImage),
  "the reviewed upstream base and digest changed",
);
requireContract(record.license === "AGPL-3.0-only", "the upstream SPDX license identifier changed");
requireContract(
  record.licenseUrl === "https://github.com/heyform/heyform/blob/v3.0.1/LICENSE",
  "the exact upstream license URL changed",
);
requireContract(
  record.upstreamSourceUrl === "https://github.com/heyform/heyform/tree/v3.0.1",
  "the exact upstream corresponding-source URL changed",
);
requireContract(
  record.modifiedSourceUrl === "https://github.com/rohanarun/managed-oss-cloud/tree/main/deploy/images/heyform",
  "the modified-source URL changed",
);
requireContract(dockerfile.startsWith(`FROM ${record.baseImage}\n`), "Dockerfile FROM does not match the reviewed base");
requireContract(
  dockerfile.includes(`org.opencontainers.image.licenses="${record.license}"`),
  "Dockerfile does not publish the upstream license",
);
requireContract(
  dockerfile.includes(`org.opencontainers.image.source="${record.modifiedSourceUrl}"`),
  "Dockerfile does not publish the modified source location",
);
requireContract(
  dockerfile.includes('org.opencontainers.image.base.name="docker.io/heyform/community-edition:v3.0.1"'),
  "Dockerfile does not publish the upstream base name",
);
requireContract(
  dockerfile.includes('org.opencontainers.image.base.digest="sha256:d74d6605ed8bd3dcf3681dbfe9e39d4c5a2d67de87fd2f3964bf9460aeede911"'),
  "Dockerfile does not publish the upstream base digest",
);
requireContract(
  dockerfile.includes(`io.getsupers.managed-oss.upstream.source="${record.upstreamSourceUrl}"`),
  "Dockerfile does not publish the exact upstream source location",
);
requireContract(
  dockerfile.includes(`io.getsupers.managed-oss.upstream.license="${record.licenseUrl}"`),
  "Dockerfile does not publish the exact upstream license location",
);
requireContract(
  readme.includes("| Jotform-style forms | [HeyForm](https://github.com/heyform/heyform) | v3.0.1 | AGPL-3.0-only |"),
  "README does not disclose the managed image's upstream license",
);

process.stdout.write("Managed HeyForm base, source, and AGPL-3.0-only metadata passed the license gate.\n");
