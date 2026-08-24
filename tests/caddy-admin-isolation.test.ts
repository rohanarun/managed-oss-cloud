import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRuntimeEnvironment } from "../src/server/config";

const controlCaddyfile = readFileSync("deploy/google-cloud/Caddyfile", "utf8");
const controlCompose = readFileSync("deploy/google-cloud/docker-compose.yml", "utf8");
const workerCaddyfile = readFileSync("deploy/google-cloud/worker/Caddyfile", "utf8");
const workerCompose = readFileSync("deploy/google-cloud/worker/docker-compose.yml", "utf8");
const workerAgent = readFileSync("src/server/provisioning-worker.ts", "utf8");
const terraform = readFileSync("infra/google-cloud/main.tf", "utf8");
const environmentExample = readFileSync(".env.example", "utf8");
const operationsGuide = readFileSync("docs/google-cloud.md", "utf8");

function serviceBlocks(source: string) {
  const servicesStart = source.indexOf("services:\n");
  if (servicesStart < 0) throw new Error("Compose file has no services block.");
  const bodyStart = servicesStart + "services:\n".length;
  const networksOffset = source.slice(bodyStart).search(/^networks:/m);
  const services = source.slice(bodyStart, networksOffset < 0 ? source.length : bodyStart + networksOffset);
  const starts = [...services.matchAll(/^  ([a-zA-Z0-9-]+):\n/gm)];
  return starts.map((match, index) => ({
    name: match[1],
    block: services.slice(match.index, starts[index + 1]?.index ?? services.length),
  }));
}

function service(source: string, name: string) {
  const found = serviceBlocks(source).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Compose service ${name}.`);
  return found.block;
}

describe("Caddy administration isolation", () => {
  it("binds both static admin listeners to IPv4 loopback only", () => {
    for (const caddyfile of [controlCaddyfile, workerCaddyfile]) {
      expect(caddyfile).toMatch(/^\{\n  admin 127\.0\.0\.1:2019\n/m);
      expect(caddyfile).not.toMatch(/admin\s+(?:0\.0\.0\.0|\[?::\]?|localhost):2019/);
    }
  });

  it("grants the control reconciler sole access through Caddy's network namespace", () => {
    const services = serviceBlocks(controlCompose);
    const namespaceSharers = services.filter(({ block }) => block.includes("network_mode: service:caddy"));
    expect(namespaceSharers.map(({ name }) => name)).toEqual(["gateway-reconciler"]);

    const reconciler = service(controlCompose, "gateway-reconciler");
    expect(reconciler).toContain("CADDY_ADMIN_URL: http://127.0.0.1:2019/load");
    expect(reconciler).toContain("GATEWAY_CONTROL_PLANE_URL: http://control-plane:8787");
    expect(reconciler).not.toMatch(/^    (?:ports|expose|networks):/m);
    for (const candidate of services.filter(({ name }) => name !== "gateway-reconciler")) {
      expect(candidate.block, `${candidate.name} must not receive the admin endpoint`).not.toContain("2019");
    }
    expect(controlCompose).not.toContain("http://caddy:2019");
  });

  it("keeps the loopback endpoint fail-closed in runtime and generated environment configuration", () => {
    expect(parseRuntimeEnvironment({})).toMatchObject({ CADDY_ADMIN_URL: "http://127.0.0.1:2019/load" });
    expect(() => parseRuntimeEnvironment({ CADDY_ADMIN_URL: "http://caddy:2019/load" })).toThrow();
    expect(() => parseRuntimeEnvironment({ CADDY_ADMIN_URL: "http://0.0.0.0:2019/load" })).toThrow();
    expect(environmentExample).toContain("CADDY_ADMIN_URL=http://127.0.0.1:2019/load");
    const gatewayEnvironmentStart = terraform.indexOf("cat > /opt/managed-oss/config/gateway.env");
    const gatewayEnvironment = terraform.slice(gatewayEnvironmentStart, terraform.indexOf("\n    EOF", gatewayEnvironmentStart));
    expect(gatewayEnvironment).toContain("CADDY_ADMIN_URL=http://127.0.0.1:2019/load");
  });

  it("leaves public control ingress and private worker ingress intact without publishing port 2019", () => {
    const controlCaddy = service(controlCompose, "caddy");
    expect(controlCaddy).toContain('- "80:80"');
    expect(controlCaddy).toContain('- "443:443"');
    expect(controlCaddy).not.toMatch(/(?:ports|expose):[\s\S]*2019/);
    expect(controlCaddyfile).toContain("reverse_proxy control-plane:8787");

    const workerCaddy = service(workerCompose, "caddy");
    expect(workerCaddy).toContain('- "8080:8080"');
    expect(workerCaddy).toContain("networks:\n      - platform");
    expect(workerCompose).toContain("name: managed-oss-worker-platform");
    expect(workerCaddy).not.toContain("2019");
    expect(workerCaddyfile).toContain(':8080 {\n  respond "Route unavailable" 404');
    expect(workerCaddyfile).toContain("import /etc/caddy/apps.caddy");
  });

  it("keeps every worker bridge peer away from admin while preserving trusted in-container reloads", () => {
    expect(serviceBlocks(workerCompose).filter(({ block }) => block.includes("network_mode: service:caddy"))).toEqual([]);
    expect(workerCompose).not.toContain("2019");
    expect(workerAgent).toContain('["exec", config.PLATFORM_CADDY_CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--address", "127.0.0.1:2019"]');
    expect(operationsGuide).toContain("Worker tenant containers remain ordinary peers on the platform bridge and cannot reach the worker admin API");
  });
});
