import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function serviceBlocks(file: string) {
  const source = readFileSync(file, "utf8");
  const servicesStart = source.indexOf("services:\n");
  if (servicesStart < 0) return [];
  const bodyStart = servicesStart + "services:\n".length;
  const networksStart = source.slice(bodyStart).search(/^networks:/m);
  const services = source.slice(bodyStart, networksStart < 0 ? source.length : bodyStart + networksStart);
  const starts = [...services.matchAll(/^  ([a-zA-Z0-9-]+):\n/gm)];
  return starts.map((match, index) => ({
    name: match[1],
    block: services.slice(match.index, starts[index + 1]?.index ?? services.length),
  }));
}

describe("runtime Compose resource limits", () => {
  for (const file of ["deploy/google-cloud/docker-compose.yml", "deploy/google-cloud/worker/docker-compose.yml"]) {
    it(`bounds every service in ${file}`, () => {
      const services = serviceBlocks(file);
      expect(services.length).toBeGreaterThan(0);
      for (const service of services) {
        expect(service.block, `${service.name} mem_limit`).toMatch(/^    mem_limit: (?:\d+)(?:m|g)$/m);
        expect(service.block, `${service.name} cpus`).toMatch(/^    cpus: "(?:\d+(?:\.\d+)?)"$/m);
        expect(service.block, `${service.name} deploy memory`).toMatch(/^          memory: (?:\d+)(?:M|G)$/m);
        expect(service.block, `${service.name} deploy CPU`).toMatch(/^          cpus: "(?:\d+(?:\.\d+)?)"$/m);
      }
    });
  }

  it("preserves host networking for the worker agent while bounding its system-reserve budget", () => {
    const agent = serviceBlocks("deploy/google-cloud/worker/docker-compose.yml").find((service) => service.name === "agent")?.block ?? "";
    expect(agent).toContain("network_mode: host");
    expect(agent).toContain("/opt/managed-oss/quota:/opt/managed-oss/quota:ro");
  });
});
