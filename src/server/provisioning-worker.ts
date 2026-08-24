import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { AgentJob, ApplicationInstance, WorkerNodeActivity, WorkerNodeRoute } from "../shared/types.js";
import { buildRuntimeManifest, runtimeIngressNetwork, runtimeReservation, type RuntimeManifest } from "./app-manifests.js";
import { migrateComposeIngressNetwork, migrateComposeResourceLimits, updateComposeApplicationImage, type ManagedEnvironmentSynchronization } from "./compose-upgrade.js";
import { config } from "./config.js";
import { runtimeReadinessIssue } from "./runtime-readiness.js";
import { requestGcpInstanceIdentityToken } from "./gcp-instance-identity.js";
import { assertManifestMatchesReservation, assertWorkerResourceConsistency, assignedApplicationUsage, enforceStorageQuarantineContract, parseQuotaHelperProof, quotaHelperArguments, readHostResourceSnapshot, storageBytesPerGb, storageQuarantineMarker, writeStorageQuarantine, type WorkerResourcePolicy } from "./worker-resource-enforcement.js";

const execFileAsync = promisify(execFile);
function manifestOptions() {
  const googleOAuthBroker = config.GOOGLE_OAUTH_BROKER_START_URL && config.GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY
    ? { startUrl: config.GOOGLE_OAUTH_BROKER_START_URL, assertionPublicKey: config.GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY }
    : undefined;
  return { googleOAuthBroker, platformNetworkName: config.PLATFORM_DOCKER_NETWORK };
}

function resourcePolicy(): WorkerResourcePolicy {
  if (!config.WORKER_NODE_ID || !config.WORKER_CAPACITY_MEMORY_MB || !config.WORKER_CAPACITY_CPU_MILLIS || !config.WORKER_CAPACITY_STORAGE_GB) throw new Error("Worker resource policy is incomplete.");
  return {
    workerNodeId: config.WORKER_NODE_ID,
    appsRoot: config.HOST_APPS_ROOT,
    capacityMemoryMb: config.WORKER_CAPACITY_MEMORY_MB,
    capacityCpuMillis: config.WORKER_CAPACITY_CPU_MILLIS,
    capacityStorageGb: config.WORKER_CAPACITY_STORAGE_GB,
    systemReserveMemoryMb: config.WORKER_SYSTEM_RESERVE_MEMORY_MB,
    systemReserveCpuMillis: config.WORKER_SYSTEM_RESERVE_CPU_MILLIS,
    systemReserveStorageGb: config.WORKER_SYSTEM_RESERVE_STORAGE_GB,
    launchMemoryReserveMb: config.WORKER_LAUNCH_MEMORY_RESERVE_MB,
    storageQuotaBackend: config.WORKER_STORAGE_QUOTA_BACKEND,
  };
}

interface WorkerReport {
  status: "succeeded" | "failed";
  error?: string;
  applications?: Array<{ id: string; state: ApplicationInstance["state"]; healthy?: boolean }>;
  backups?: Array<{ applicationInstanceId: string; objectName: string; sizeBytes: number }>;
}

class AgentClient {
  private token = "";
  private readonly baseUrl: string;

  constructor() {
    if (!config.CONTROL_PLANE_AGENT_URL) throw new Error("Remote worker requires CONTROL_PLANE_AGENT_URL.");
    this.baseUrl = config.CONTROL_PLANE_AGENT_URL.replace(/\/$/, "");
  }

  private async request<T>(pathname: string, init: RequestInit = {}, token = this.token): Promise<T | undefined> {
    const response = await fetch(`${this.baseUrl}${pathname}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers } });
    if (response.status === 204) return undefined;
    if (!response.ok) throw new Error(`Control plane ${pathname} failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return await response.json() as T;
  }

  async initialize() {
    this.token = (await readFile(config.WORKER_AGENT_TOKEN_FILE, "utf8").catch(() => "")).trim();
    if (!this.token) {
      if ((!config.GCP_WORKER_IDENTITY_AUDIENCE && !config.WORKER_BOOTSTRAP_TOKEN) || !config.WORKER_NODE_ID || !config.WORKER_NODE_NAME || !config.WORKER_PRIVATE_ADDRESS || !config.WORKER_MACHINE_TYPE || !config.WORKER_CAPACITY_MEMORY_MB || !config.WORKER_CAPACITY_CPU_MILLIS || !config.WORKER_CAPACITY_STORAGE_GB) throw new Error("Remote worker registration settings are incomplete.");
      const enrollmentCredential = config.GCP_WORKER_IDENTITY_AUDIENCE
        ? await requestGcpInstanceIdentityToken(config.GCP_WORKER_IDENTITY_AUDIENCE)
        : config.WORKER_BOOTSTRAP_TOKEN!;
      const registered = await this.request<{ agentToken: string }>("/api/agent/register", { method: "POST", body: JSON.stringify({ id: config.WORKER_NODE_ID, name: config.WORKER_NODE_NAME, privateAddress: config.WORKER_PRIVATE_ADDRESS, machineType: config.WORKER_MACHINE_TYPE, capacityMemoryMb: config.WORKER_CAPACITY_MEMORY_MB, capacityCpuMillis: config.WORKER_CAPACITY_CPU_MILLIS, capacityStorageGb: config.WORKER_CAPACITY_STORAGE_GB, systemReserveMemoryMb: config.WORKER_SYSTEM_RESERVE_MEMORY_MB }) }, enrollmentCredential);
      if (!registered?.agentToken) throw new Error("Control plane did not return a worker token.");
      this.token = registered.agentToken;
      await mkdir(path.dirname(config.WORKER_AGENT_TOKEN_FILE), { recursive: true, mode: 0o700 });
      await writeFile(config.WORKER_AGENT_TOKEN_FILE, `${this.token}\n`, { mode: 0o600 });
    }
    await this.heartbeat();
  }

  async heartbeat() {
    if (!config.WORKER_PRIVATE_ADDRESS || !config.WORKER_CAPACITY_MEMORY_MB || !config.WORKER_CAPACITY_CPU_MILLIS || !config.WORKER_CAPACITY_STORAGE_GB) throw new Error("Worker capacity settings are incomplete.");
    await this.request("/api/agent/heartbeat", { method: "POST", body: JSON.stringify({ privateAddress: config.WORKER_PRIVATE_ADDRESS, capacityMemoryMb: config.WORKER_CAPACITY_MEMORY_MB, capacityCpuMillis: config.WORKER_CAPACITY_CPU_MILLIS, capacityStorageGb: config.WORKER_CAPACITY_STORAGE_GB }) });
  }

  async claim() { return (await this.request<{ job: AgentJob }>("/api/agent/jobs/claim", { method: "POST", body: "{}" }))?.job; }
  async report(jobId: string, report: WorkerReport) { await this.request(`/api/agent/jobs/${jobId}/report`, { method: "POST", body: JSON.stringify(report) }); }
  async routes() { return (await this.request<{ routes: WorkerNodeRoute[] }>("/api/agent/routes"))?.routes ?? []; }
  async activity() {
    const activity = (await this.request<{ activity: WorkerNodeActivity }>("/api/agent/activity"))?.activity;
    if (!activity) throw new Error("Control plane did not return worker resource activity.");
    return activity;
  }
}

function workspacePath(instance: ApplicationInstance) {
  if (!/^[0-9a-f-]{36}$/i.test(instance.id) || !/^mos-[0-9a-f]{12}$/i.test(instance.containerProject)) throw new Error("Invalid managed application identifier.");
  const resolvedRoot = path.resolve(config.HOST_APPS_ROOT);
  const resolved = path.resolve(resolvedRoot, instance.id);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Application workspace escaped the managed root.");
  return resolved;
}

async function docker(args: string[]) {
  return execFileAsync("docker", args, { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
}

function dockerFailure(error: unknown) {
  if (!error || typeof error !== "object") return String(error);
  const details = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [details.message, details.stderr, details.stdout].map((value) => String(value ?? "")).join("\n");
}

async function networkExists(networkName: string) {
  try {
    await docker(["network", "inspect", networkName]);
    return true;
  } catch (error) {
    if (/no such network/i.test(dockerFailure(error))) return false;
    throw error;
  }
}

async function ensureIngressNetwork(instance: ApplicationInstance) {
  const networkName = runtimeIngressNetwork(instance);
  if (!await networkExists(networkName)) {
    await docker(["network", "create", "--label", "com.getsupers.managed=true", "--label", `com.getsupers.application-instance=${instance.id}`, networkName]);
  }
  return networkName;
}

async function isolateApplicationIngress(instance: ApplicationInstance, recreate: boolean) {
  const networkName = await ensureIngressNetwork(instance);
  const composePath = path.join(workspacePath(instance), "compose.json");
  const targetManifest = buildRuntimeManifest(instance, manifestOptions());
  const migration = await migrateComposeIngressNetwork(composePath, networkName, targetManifest.compose.services.proxy, targetManifest.compose.networks.platform);
  const resourceMigration = await migrateComposeResourceLimits(composePath, targetManifest.compose.services);
  if ((migration.changed || resourceMigration.changed) && recreate) await docker(["compose", "-f", composePath, "up", "-d", "--force-recreate", "--wait", "app", "proxy"]);
  return { changed: migration.changed || resourceMigration.changed, ingressNetworkName: networkName };
}

async function removeIngressNetwork(instance: ApplicationInstance) {
  const networkName = runtimeIngressNetwork(instance);
  if (!await networkExists(networkName)) return;
  await docker(["network", "rm", networkName]);
}

async function verifyRuntimeReadiness(manifest: RuntimeManifest) {
  if (!manifest.readiness) return;
  const url = `http://127.0.0.1:${manifest.internalPort}${manifest.readiness.path}`;
  let lastError = "readiness endpoint did not respond";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let response: unknown;
    try {
      const result = await docker(["exec", manifest.primaryContainer, "node", "--input-type=module", "-e", "const response=await fetch(process.argv[1]);const body=await response.text();if(!response.ok)throw new Error(`HTTP ${response.status}: ${body.slice(0,200)}`);process.stdout.write(body);", url]);
      response = JSON.parse(String(result.stdout));
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const issue = runtimeReadinessIssue(manifest, response);
    if (issue) throw new Error(issue);
    return;
  }
  throw new Error(`Application ${manifest.appId} failed its readiness check at ${manifest.readiness.path}: ${lastError.slice(0, 500)}`);
}

function applicationPath(applicationId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) throw new Error("Invalid managed application identifier.");
  const root = path.resolve(config.HOST_APPS_ROOT);
  const directory = path.resolve(root, applicationId);
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("Application resource path escaped the managed root.");
  return directory;
}

async function runQuotaHelper(action: "apply" | "verify", instance: Pick<ApplicationInstance, "id" | "storageReservationGb">) {
  if (config.WORKER_STORAGE_QUOTA_BACKEND !== "operator-project-quota") return;
  if (!config.WORKER_STORAGE_QUOTA_HELPER) throw new Error("Operator project-quota mode requires WORKER_STORAGE_QUOTA_HELPER.");
  const applicationDirectory = applicationPath(instance.id);
  const storageLimitBytes = instance.storageReservationGb * storageBytesPerGb;
  const result = await execFileAsync(config.WORKER_STORAGE_QUOTA_HELPER, quotaHelperArguments(action, applicationDirectory, instance.id, storageLimitBytes), { timeout: 30_000, maxBuffer: 1024 * 1024 });
  parseQuotaHelperProof(String(result.stdout), { applicationPath: applicationDirectory, applicationId: instance.id, storageLimitBytes });
}

async function recordStorageQuarantine(application: { id: string; appId: string; usedBytes: number; storageLimitBytes: number }) {
  const directory = applicationPath(application.id);
  if (!await storageQuarantineMarker(directory)) {
    await writeStorageQuarantine(directory, { applicationId: application.id, appId: application.appId, usedBytes: application.usedBytes, storageLimitBytes: application.storageLimitBytes, observedAt: new Date().toISOString() });
  }
}

async function stopStorageQuarantinedApplication(application: { id: string }) {
  const directory = applicationPath(application.id);
  const composePath = path.join(directory, "compose.json");
  if (await pathHasType(composePath, "file")) await docker(["compose", "-f", composePath, "stop"]);
}

async function pathHasType(candidate: string, expected: "file" | "directory") {
  try {
    const details = await stat(candidate);
    return expected === "file" ? details.isFile() : details.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function reconcileWorkerResources(agent: AgentClient, pending: ApplicationInstance[] = []) {
  const activity = await agent.activity();
  const usage = await assignedApplicationUsage(activity, config.HOST_APPS_ROOT);
  const overQuota = usage.filter((application) => application.overQuota);
  await enforceStorageQuarantineContract(overQuota, {
    quarantine: recordStorageQuarantine,
    removeQuarantinedRoutes: () => reloadRoutes(agent),
    stop: stopStorageQuarantinedApplication,
  });

  for (const application of activity.assignedApplications) {
    const directory = applicationPath(application.id);
    const exists = await pathHasType(directory, "directory");
    if (exists && config.WORKER_STORAGE_QUOTA_BACKEND === "operator-project-quota") {
      const reservation = runtimeReservation(application.appId);
      await runQuotaHelper("verify", { id: application.id, storageReservationGb: reservation.storageGb });
    }
  }

  const pendingMemoryMb = pending.reduce((total, instance) => total + assertManifestMatchesReservation(instance, buildRuntimeManifest(instance, manifestOptions())).memoryMb, 0);
  const host = await readHostResourceSnapshot(config.HOST_APPS_ROOT);
  assertWorkerResourceConsistency(activity, resourcePolicy(), host, pendingMemoryMb);
  return { activity, overQuota };
}

async function assertNotStorageQuarantined(instance: Pick<ApplicationInstance, "id">) {
  if (await storageQuarantineMarker(applicationPath(instance.id))) throw new Error(`Application ${instance.id} is storage-quarantined and cannot start until an operator reduces usage, verifies a backup, and explicitly clears the marker.`);
}

async function writeCompose(instance: ApplicationInstance, manifest: RuntimeManifest) {
  assertManifestMatchesReservation(instance, manifest);
  const directory = workspacePath(instance);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  await runQuotaHelper("apply", instance);
  const composePath = path.join(directory, "compose.json");
  await writeFile(composePath, `${JSON.stringify(manifest.compose, null, 2)}\n`, { mode: 0o600 });
  return composePath;
}

async function reloadRoutes(agent: AgentClient) {
  const routes = await agent.routes();
  const instances = routes.map((route): ApplicationInstance => ({ id: route.applicationInstanceId, installationId: "", appId: route.appId, state: "live", hostname: route.hostname, containerProject: route.containerProject, customDomains: [], memoryReservationMb: 0, cpuReservationMillis: 0, storageReservationGb: 0, createdAt: "", updatedAt: "" }));
  const routable: Array<{ route: WorkerNodeRoute; instance: ApplicationInstance }> = [];
  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];
    if (await storageQuarantineMarker(applicationPath(instance.id))) continue;
    await isolateApplicationIngress(instance, true);
    routable.push({ route: routes[index], instance });
  }
  const blocks = routable.map(({ route, instance }) => {
    const manifest = buildRuntimeManifest(instance, manifestOptions());
    return `http://${route.hostname}:8080 {\n  encode zstd gzip\n  reverse_proxy ${manifest.proxyContainer}:8080\n}`;
  });
  await writeFile(config.HOST_CADDY_CONFIG, `${blocks.join("\n\n")}\n`, { mode: 0o640 });
  await docker(["exec", config.PLATFORM_CADDY_CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--address", "127.0.0.1:2019"]);
}

async function metadataAccessToken() {
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`Metadata token request failed with ${response.status}.`);
  const value = await response.json() as { access_token?: string };
  if (!value.access_token) throw new Error("Metadata token response omitted the access token.");
  return value.access_token;
}

async function encryptArchive(inputPath: string, outputPath: string) {
  if (!config.BACKUP_KEY_HEX) throw new Error("Encrypted backups require BACKUP_KEY_HEX.");
  const key = Buffer.from(config.BACKUP_KEY_HEX, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  await writeFile(outputPath, Buffer.concat([Buffer.from("MOSB1"), iv]), { mode: 0o600 });
  await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath, { flags: "a", mode: 0o600 }));
  await appendFile(outputPath, cipher.getAuthTag());
}

async function decryptArchive(inputPath: string, outputPath: string) {
  if (!config.BACKUP_KEY_HEX) throw new Error("Encrypted restores require BACKUP_KEY_HEX.");
  const details = await stat(inputPath);
  if (details.size < 34) throw new Error("Backup is too small to contain an encrypted archive.");
  const handle = await open(inputPath, "r");
  const header = Buffer.alloc(17);
  const tag = Buffer.alloc(16);
  await handle.read(header, 0, header.length, 0);
  await handle.read(tag, 0, tag.length, details.size - tag.length);
  await handle.close();
  if (header.subarray(0, 5).toString() !== "MOSB1") throw new Error("Backup encryption header is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config.BACKUP_KEY_HEX, "hex"), header.subarray(5));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(inputPath, { start: 17, end: details.size - 17 }), decipher, createWriteStream(outputPath, { mode: 0o600 }));
}

async function uploadBackup(filePath: string, objectName: string) {
  if (!config.BACKUP_BUCKET) throw new Error("Encrypted backups require BACKUP_BUCKET.");
  const token = await metadataAccessToken();
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.BACKUP_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  await execFileAsync("curl", ["-fsS", "-X", "POST", "-H", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/octet-stream", "--data-binary", `@${filePath}`, uploadUrl], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
}

async function downloadBackup(objectName: string, filePath: string) {
  if (!config.BACKUP_BUCKET) throw new Error("Encrypted restores require BACKUP_BUCKET.");
  const token = await metadataAccessToken();
  const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.BACKUP_BUCKET)}/o/${encodeURIComponent(objectName)}?alt=media`;
  await execFileAsync("curl", ["-fsS", "-H", `Authorization: Bearer ${token}`, "-o", filePath, downloadUrl], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
}

async function prepareDatabaseDump(instance: ApplicationInstance, directory: string) {
  const postgresDatabases: Record<string, { user: string; database: string }> = {
    "cal-diy": { user: "calcom", database: "calendso" },
    documenso: { user: "documenso", database: "documenso" },
    listmonk: { user: "listmonk", database: "listmonk" },
    umami: { user: "umami", database: "umami" },
  };
  const postgres = postgresDatabases[instance.appId];
  if (!postgres && instance.appId !== "heyform") return;
  const backupDirectory = path.join(directory, ".managed-backup");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const dump = postgres
    ? await execFileAsync("docker", ["exec", `${instance.containerProject}-db`, "pg_dump", "-U", postgres.user, "-d", postgres.database, "-Fc"], { encoding: "buffer", timeout: 15 * 60_000, maxBuffer: 1024 * 1024 * 1024 })
    : await execFileAsync("docker", ["exec", `${instance.containerProject}-mongo`, "mongodump", "--archive", "--db", "heyform"], { encoding: "buffer", timeout: 15 * 60_000, maxBuffer: 1024 * 1024 * 1024 });
  await writeFile(path.join(backupDirectory, "database.dump"), dump.stdout, { mode: 0o600 });
}

async function backup(job: AgentJob) {
  const backups: NonNullable<WorkerReport["backups"]> = [];
  for (const instance of job.applications) {
    const directory = workspacePath(instance);
    const composePath = path.join(directory, "compose.json");
    const archivePath = `/tmp/managed-oss-${job.id}-${instance.id}.tar.gz`;
    const encryptedPath = `${archivePath}.enc`;
    let stopped = false;
    try {
      await docker(["compose", "-f", composePath, "stop", "app"]);
      stopped = true;
      await prepareDatabaseDump(instance, directory);
      await execFileAsync("tar", ["-czf", archivePath, "--exclude=./database", "--exclude=./mongodb", "-C", directory, "."], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
      await encryptArchive(archivePath, encryptedPath);
      if (!config.WORKER_NODE_ID) throw new Error("Backup identity is unavailable.");
      const objectName = `${config.WORKER_NODE_ID}/${job.installationId}/${instance.id}/${new Date().toISOString().replaceAll(":", "-")}.tar.gz.enc`;
      await uploadBackup(encryptedPath, objectName);
      backups.push({ applicationInstanceId: instance.id, objectName, sizeBytes: (await stat(encryptedPath)).size });
    } finally {
      if (stopped && !await storageQuarantineMarker(directory)) await docker(["compose", "-f", composePath, "start", "app"]).catch(() => undefined);
      await rm(archivePath, { force: true });
      await rm(encryptedPath, { force: true });
      await rm(path.join(directory, ".managed-backup"), { recursive: true, force: true });
    }
  }
  return backups;
}

async function restore(job: AgentJob, agent: AgentClient) {
  const objectName = typeof job.payload.objectName === "string" ? job.payload.objectName : "";
  const instanceId = typeof job.payload.applicationInstanceId === "string" ? job.payload.applicationInstanceId : "";
  const instance = job.applications.find((candidate) => candidate.id === instanceId);
  if (!config.WORKER_NODE_ID || !instance || !objectName.startsWith(`${config.WORKER_NODE_ID}/${job.installationId}/${instance.id}/`) || !objectName.endsWith(".tar.gz.enc")) throw new Error("Restore target is outside this managed application.");
  const directory = workspacePath(instance);
  const encryptedPath = `/tmp/managed-oss-restore-${job.id}.enc`;
  const archivePath = `/tmp/managed-oss-restore-${job.id}.tar.gz`;
  const composePath = path.join(directory, "compose.json");
  try {
    await assertNotStorageQuarantined(instance);
    assertManifestMatchesReservation(instance, buildRuntimeManifest(instance, manifestOptions()));
    await runQuotaHelper("verify", instance);
    await isolateApplicationIngress(instance, false);
    await downloadBackup(objectName, encryptedPath);
    await decryptArchive(encryptedPath, archivePath);
    const listing = await execFileAsync("tar", ["-tzf", archivePath], { timeout: 5 * 60_000 });
    if (listing.stdout.split("\n").some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) throw new Error("Backup archive contains an unsafe path.");
    await docker(["compose", "-f", composePath, "down"]);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", directory], { timeout: 30 * 60_000 });
    const postgresDatabases: Record<string, { user: string; database: string }> = {
      "cal-diy": { user: "calcom", database: "calendso" },
      documenso: { user: "documenso", database: "documenso" },
      listmonk: { user: "listmonk", database: "listmonk" },
      umami: { user: "umami", database: "umami" },
    };
    const postgres = postgresDatabases[instance.appId];
    if (postgres) {
      await docker(["compose", "-f", composePath, "up", "-d", "--wait", "db"]);
      await docker(["cp", path.join(directory, ".managed-backup/database.dump"), `${instance.containerProject}-db:/tmp/database.dump`]);
      await docker(["exec", `${instance.containerProject}-db`, "pg_restore", "-U", postgres.user, "-d", postgres.database, "--clean", "--if-exists", "/tmp/database.dump"]);
    } else if (instance.appId === "heyform") {
      await docker(["compose", "-f", composePath, "up", "-d", "--wait", "mongo"]);
      await docker(["cp", path.join(directory, ".managed-backup/database.dump"), `${instance.containerProject}-mongo:/tmp/database.dump`]);
      await docker(["exec", "-u", "0", `${instance.containerProject}-mongo`, "chmod", "0444", "/tmp/database.dump"]);
      await docker(["exec", `${instance.containerProject}-mongo`, "mongorestore", "--archive=/tmp/database.dump", "--drop", "--nsInclude=heyform.*"]);
    }
    await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
  } finally {
    await rm(encryptedPath, { force: true });
    await rm(archivePath, { force: true });
    await rm(path.join(directory, ".managed-backup"), { recursive: true, force: true });
  }
}

async function install(job: AgentJob, agent: AgentClient) {
  const requestedId = typeof job.payload.applicationInstanceId === "string" ? job.payload.applicationInstanceId : undefined;
  const targets = requestedId ? job.applications.filter((instance) => instance.id === requestedId) : job.applications.filter((instance) => instance.state === "queued" || instance.state === "provisioning");
  if (!targets.length) throw new Error("Install job did not include a queued application.");
  const manifests = targets.map((instance) => buildRuntimeManifest(instance, manifestOptions()));
  for (let index = 0; index < targets.length; index += 1) {
    const instance = targets[index];
    const manifest = manifests[index];
    await assertNotStorageQuarantined(instance);
    assertManifestMatchesReservation(instance, manifest);
    await ensureIngressNetwork(instance);
    const composePath = await writeCompose(instance, manifest);
    await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
  }
}

async function changeLifecycle(job: AgentJob, agent: AgentClient) {
  for (const instance of job.applications) {
    const composePath = path.join(workspacePath(instance), "compose.json");
    const startsApplication = job.action === "upgrade" || job.action === "start";
    if (startsApplication) {
      await assertNotStorageQuarantined(instance);
      assertManifestMatchesReservation(instance, buildRuntimeManifest(instance, manifestOptions()));
      await runQuotaHelper("verify", instance);
    }
    if (job.action === "upgrade") {
      await isolateApplicationIngress(instance, false);
      const targetManifest = buildRuntimeManifest(instance, manifestOptions());
      const targetImage = targetManifest.compose.services.app?.image;
      if (typeof targetImage !== "string") throw new Error(`Application ${instance.appId} has no upgradeable app image.`);
      const targetEnvironment = targetManifest.compose.services.app?.environment;
      const environmentRecord = targetEnvironment && typeof targetEnvironment === "object" && !Array.isArray(targetEnvironment) ? targetEnvironment as Record<string, unknown> : undefined;
      let synchronization: ManagedEnvironmentSynchronization | undefined;
      if (instance.appId === "heyform") {
        const required = ["MANAGED_GOOGLE_BROKER_START_URL", "MANAGED_OAUTH_ASSERTION_PUBLIC_KEY", "MANAGED_OAUTH_APPLICATION_ID"];
        const set = Object.fromEntries(required.flatMap((key) => typeof environmentRecord?.[key] === "string" && (environmentRecord[key] as string).trim() ? [[key, environmentRecord[key] as string]] : []));
        if (Object.keys(set).length !== required.length) throw new Error("Managed HeyForm upgrade requires the complete hosting-layer public OAuth broker configuration.");
        synchronization = {
          set,
          required,
          remove: ["GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_CLIENT_SECRET", "MANAGED_OAUTH_STATE_SECRET", "MANAGED_GOOGLE_CALLBACK_URL", "GOOGLE_LOGIN_CALLBACK_URL"],
        };
      }
      await updateComposeApplicationImage(composePath, targetImage, synchronization);
      await docker(["compose", "-f", composePath, "pull", "app"]);
    }
    if (job.action === "start") await isolateApplicationIngress(instance, false);
    if (job.action === "upgrade") await docker(["compose", "-f", composePath, "up", "-d", "--force-recreate", "--no-deps", "--wait", "app"]);
    if (startsApplication) await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
    if (job.action === "stop") await docker(["compose", "-f", composePath, "stop"]);
    if (job.action === "uninstall") {
      await docker(["compose", "-f", composePath, "down", "--remove-orphans"]);
      await removeIngressNetwork(instance);
      await rm(workspacePath(instance), { recursive: true, force: true });
    }
  }
}

async function run() {
  if (config.PROVISIONING_WORKER !== "remote") throw new Error("Provisioning worker refused to start unless PROVISIONING_WORKER=remote.");
  const agent = new AgentClient();
  await agent.initialize();
  const startupResources = await reconcileWorkerResources(agent);
  await reloadRoutes(agent);
  if (startupResources.overQuota.length) process.stderr.write(`${startupResources.overQuota.length} application workspace(s) were stopped and storage-quarantined during startup reconciliation.\n`);
  process.stdout.write(`Provisioning worker ${config.WORKER_NODE_ID} ready\n`);
  setInterval(() => { void agent.heartbeat().catch((error) => process.stderr.write(`${error instanceof Error ? error.message : "Worker heartbeat failed."}\n`)); }, 30_000);
  let storageScanRunning = false;
  setInterval(() => {
    if (storageScanRunning) return;
    storageScanRunning = true;
    void reconcileWorkerResources(agent)
      .catch((error) => process.stderr.write(`${error instanceof Error ? error.message : "Worker resource reconciliation failed."}\n`))
      .finally(() => { storageScanRunning = false; });
  }, config.WORKER_STORAGE_SCAN_MILLISECONDS);
  while (true) {
    let job: AgentJob | undefined;
    try { job = await agent.claim(); }
    catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "Worker claim failed."}\n`);
      await new Promise((resolve) => setTimeout(resolve, config.PROVISIONING_POLL_MILLISECONDS));
      continue;
    }
    if (!job) { await new Promise((resolve) => setTimeout(resolve, config.PROVISIONING_POLL_MILLISECONDS)); continue; }
    try {
      let backups: WorkerReport["backups"];
      const pendingLaunch = ["install", "start", "restore"].includes(job.action) ? job.applications : [];
      const resources = await reconcileWorkerResources(agent, pendingLaunch);
      if (resources.overQuota.length && !["backup", "stop", "uninstall", "reload-routes"].includes(job.action)) throw new Error("Worker provisioning is blocked while any assigned application remains storage-quarantined.");
      if (job.action === "install") await install(job, agent);
      else if (["upgrade", "stop", "start", "uninstall"].includes(job.action)) await changeLifecycle(job, agent);
      else if (job.action === "reload-routes") await reloadRoutes(agent);
      else if (job.action === "backup") backups = await backup(job);
      else if (job.action === "restore") await restore(job, agent);
      else throw new Error(`Worker action ${job.action} is not enabled yet.`);
      const applicationState = job.action === "stop" || job.action === "uninstall" ? "stopped" : "live";
      if (applicationState === "live") {
        for (const application of job.applications) await verifyRuntimeReadiness(buildRuntimeManifest(application, manifestOptions()));
      }
      await agent.report(job.id, { status: "succeeded", backups, applications: job.applications.map((application) => ({ id: application.id, state: applicationState, healthy: applicationState === "live" })) });
      await reloadRoutes(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "Unknown provisioning failure";
      await agent.report(job.id, { status: "failed", error: message, applications: job.applications.map((application) => ({ id: application.id, state: "failed" })) });
    }
  }
}

await run();
