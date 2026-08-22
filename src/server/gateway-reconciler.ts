import type { GatewayRoute } from "../shared/types.js";
import { config } from "./config.js";

function caddyHost(hostname: string) {
  if (!/^(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(hostname)) throw new Error(`Unsafe gateway hostname: ${hostname}`);
  return hostname.toLowerCase();
}

function privateAddress(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error(`Unsafe worker address: ${address}`);
  if (!(octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168))) throw new Error(`Worker address is not private: ${address}`);
  return address;
}

export function renderGatewayCaddyfile(routes: GatewayRoute[], options: { controlPlaneDomain?: string; platformIpv4?: string; controlPlaneUpstream: string }) {
  const blocks = ["{\n  admin 0.0.0.0:2019\n}"];
  if (options.controlPlaneDomain) blocks.push(`${caddyHost(options.controlPlaneDomain)} {\n  encode zstd gzip\n  reverse_proxy ${options.controlPlaneUpstream}\n}`);
  if (options.platformIpv4) blocks.push(`http://${options.platformIpv4} {\n  encode zstd gzip\n  reverse_proxy ${options.controlPlaneUpstream}\n}`);
  const unique = new Set<string>();
  for (const route of [...routes].sort((left, right) => left.hostname.localeCompare(right.hostname))) {
    const hostname = caddyHost(route.hostname);
    if (unique.has(hostname)) throw new Error(`Duplicate gateway route: ${hostname}`);
    unique.add(hostname);
    blocks.push(`${hostname} {\n  encode zstd gzip\n  reverse_proxy http://${privateAddress(route.workerPrivateAddress)}:8080 {\n    header_up Host ${caddyHost(route.upstreamHost)}\n  }\n}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

async function fetchRoutes() {
  if (!config.GATEWAY_RECONCILER_TOKEN) throw new Error("Gateway reconciler requires GATEWAY_RECONCILER_TOKEN.");
  const response = await fetch(`${config.GATEWAY_CONTROL_PLANE_URL.replace(/\/$/, "")}/api/internal/gateway/routes`, { headers: { authorization: `Bearer ${config.GATEWAY_RECONCILER_TOKEN}` } });
  if (!response.ok) throw new Error(`Gateway route discovery failed with ${response.status}.`);
  return (await response.json() as { routes: GatewayRoute[] }).routes;
}

async function loadCaddyfile(caddyfile: string) {
  const response = await fetch(config.CADDY_ADMIN_URL, { method: "POST", headers: { "content-type": "text/caddyfile" }, body: caddyfile });
  if (!response.ok) throw new Error(`Caddy configuration reload failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

async function run() {
  let lastApplied = "";
  while (true) {
    try {
      const routes = await fetchRoutes();
      const rendered = renderGatewayCaddyfile(routes, { controlPlaneDomain: config.CONTROL_PLANE_DOMAIN, platformIpv4: config.PLATFORM_IPV4, controlPlaneUpstream: config.CONTROL_PLANE_UPSTREAM });
      if (rendered !== lastApplied) { await loadCaddyfile(rendered); lastApplied = rendered; }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "Gateway reconciliation failed."}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.GATEWAY_POLL_MILLISECONDS));
  }
}

if (process.argv[1]?.endsWith("gateway-reconciler.js")) await run();
