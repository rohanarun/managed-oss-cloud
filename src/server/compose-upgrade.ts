import { readFile, writeFile } from "node:fs/promises";

type ComposeDocument = {
  services?: {
    app?: {
      image?: unknown;
      environment?: unknown;
      networks?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export interface ManagedEnvironmentSynchronization {
  set: Record<string, string>;
  remove: string[];
  required: string[];
}

export async function migrateComposeIngressNetwork(composePath: string, ingressNetworkName: string, proxyService: Record<string, unknown>, platformNetwork: unknown) {
  if (!/^mos-[0-9a-f]{12}-ingress$/i.test(ingressNetworkName)) throw new Error("Managed ingress network name is invalid.");
  if (!proxyService || !Array.isArray(proxyService.networks) || !proxyService.networks.includes("ingress") || !proxyService.networks.includes("platform")) throw new Error("Managed fixed-upstream proxy is invalid.");
  if (!platformNetwork || typeof platformNetwork !== "object" || Array.isArray(platformNetwork)) throw new Error("Managed platform network is invalid.");
  const compose = JSON.parse(await readFile(composePath, "utf8")) as ComposeDocument;
  const application = compose.services?.app;
  if (!application || !Array.isArray(application.networks) || !application.networks.every((network) => typeof network === "string")) throw new Error("Managed compose application networks are invalid.");
  const applicationNetworks = application.networks as string[];
  if (applicationNetworks.some((network) => !["private", "platform", "ingress"].includes(network))) throw new Error("Managed compose application uses an unrecognized network.");
  for (const [serviceName, service] of Object.entries(compose.services ?? {})) {
    if (serviceName === "app" || serviceName === "proxy" || !service || typeof service !== "object" || Array.isArray(service)) continue;
    const networks = (service as { networks?: unknown }).networks;
    if (Array.isArray(networks) && networks.includes("platform")) throw new Error(`Managed internal service ${serviceName} unexpectedly uses the legacy shared network.`);
  }
  const networks = compose.networks && typeof compose.networks === "object" && !Array.isArray(compose.networks) ? compose.networks as Record<string, unknown> : {};
  const alreadyIsolated = applicationNetworks.includes("ingress")
    && !applicationNetworks.includes("platform")
    && JSON.stringify(networks.ingress) === JSON.stringify({ external: true, name: ingressNetworkName })
    && JSON.stringify(networks.platform) === JSON.stringify(platformNetwork)
    && JSON.stringify(compose.services?.proxy) === JSON.stringify(proxyService);
  if (alreadyIsolated) return { changed: false, ingressNetworkName };
  application.networks = [...new Set(applicationNetworks.map((network) => network === "platform" ? "ingress" : network).concat("ingress"))];
  if (!compose.services) throw new Error("Managed compose services are missing.");
  compose.services.proxy = JSON.parse(JSON.stringify(proxyService)) as Record<string, unknown>;
  networks.ingress = { external: true, name: ingressNetworkName };
  networks.platform = JSON.parse(JSON.stringify(platformNetwork)) as Record<string, unknown>;
  compose.networks = networks;
  await writeFile(composePath, `${JSON.stringify(compose, null, 2)}\n`, { mode: 0o600 });
  return { changed: true, ingressNetworkName };
}

export async function migrateComposeResourceLimits(composePath: string, targetServices: Record<string, Record<string, unknown>>) {
  const compose = JSON.parse(await readFile(composePath, "utf8")) as ComposeDocument;
  if (!compose.services || typeof compose.services !== "object") throw new Error("Managed compose services are missing.");
  const currentNames = Object.keys(compose.services).sort();
  const targetNames = Object.keys(targetServices).sort();
  if (JSON.stringify(currentNames) !== JSON.stringify(targetNames)) throw new Error("Managed compose service set differs from the verified runtime manifest.");
  let changed = false;
  for (const serviceName of targetNames) {
    const current = compose.services[serviceName];
    const target = targetServices[serviceName];
    if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error(`Managed compose service ${serviceName} is invalid.`);
    const currentRecord = current as Record<string, unknown>;
    const targetDeploy = target.deploy as { resources?: { limits?: { memory?: unknown; cpus?: unknown } } } | undefined;
    if (typeof target.mem_limit !== "string" || typeof target.cpus !== "string" || typeof targetDeploy?.resources?.limits?.memory !== "string" || typeof targetDeploy.resources.limits.cpus !== "string") throw new Error(`Verified service ${serviceName} lacks explicit memory or CPU limits.`);
    const desired = { mem_limit: target.mem_limit, cpus: target.cpus, deploy: { resources: { limits: { memory: targetDeploy.resources.limits.memory, cpus: targetDeploy.resources.limits.cpus } } } };
    const currentLimits = { mem_limit: currentRecord.mem_limit, cpus: currentRecord.cpus, deploy: currentRecord.deploy };
    if (JSON.stringify(currentLimits) === JSON.stringify(desired)) continue;
    Object.assign(currentRecord, desired);
    changed = true;
  }
  if (changed) await writeFile(composePath, `${JSON.stringify(compose, null, 2)}\n`, { mode: 0o600 });
  return { changed };
}

export async function updateComposeApplicationImage(composePath: string, targetImage: string, synchronization?: ManagedEnvironmentSynchronization) {
  if (!targetImage.includes("@sha256:")) throw new Error("Managed upgrades require a digest-pinned application image.");
  const compose = JSON.parse(await readFile(composePath, "utf8")) as ComposeDocument;
  const application = compose.services?.app;
  if (!application || typeof application.image !== "string") throw new Error("Managed compose file has no application image to upgrade.");
  const previousImage = application.image;
  application.image = targetImage;
  if (synchronization) {
    if (!application.environment || typeof application.environment !== "object" || Array.isArray(application.environment)) throw new Error("Managed compose application environment is invalid.");
    const environment = application.environment as Record<string, unknown>;
    for (const key of synchronization.remove) delete environment[key];
    Object.assign(environment, synchronization.set);
    for (const key of synchronization.required) if (typeof environment[key] !== "string" || !(environment[key] as string).trim()) throw new Error(`Managed compose upgrade is missing required environment key ${key}.`);
  }
  await writeFile(composePath, `${JSON.stringify(compose, null, 2)}\n`, { mode: 0o600 });
  return { previousImage, targetImage };
}
