import { readFileSync } from "node:fs";

interface PackageManifest {
  version?: unknown;
}

export function managedOssPackageVersion() {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("The package manifest has no valid semantic version.");
  }
  return manifest.version;
}
