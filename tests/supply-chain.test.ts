import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/container.yml",
  ".github/workflows/managed-images.yml",
];

describe("release supply-chain configuration", () => {
  it("pins every third-party GitHub Action to a full commit SHA", () => {
    for (const file of workflowFiles) {
      const workflow = readFileSync(file, "utf8");
      const references = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
      expect(references.length, `${file} should contain action references`).toBeGreaterThan(0);
      for (const reference of references) expect(reference, `${file}: ${reference}`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
    }
  });

  it("grants the current attestation action its required artifact permissions", () => {
    for (const file of workflowFiles.slice(1)) {
      const workflow = readFileSync(file, "utf8");
      expect(workflow).toContain("id-token: write");
      expect(workflow).toContain("attestations: write");
      expect(workflow).toContain("artifact-metadata: write");
      expect(workflow).toMatch(/uses:\s*actions\/attest@[0-9a-f]{40}/);
    }
  });

  it("uses an explicit Docker build-context allowlist", () => {
    const dockerignore = readFileSync(".dockerignore", "utf8");
    const lines = dockerignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(lines[0]).toBe("*");
    for (const required of ["!package.json", "!package-lock.json", "!src/**", "!catalog/**", "!db/**", "!docs/**"]) expect(lines).toContain(required);
    for (const forbidden of ["!.git/**", "!node_modules/**", "!infra/**", "!tests/**", "!.env", "!**/.terraform/**", "!**/*.tfstate", "!**/*.tfvars"]) expect(lines).not.toContain(forbidden);
  });
});
