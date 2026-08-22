import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { AgentJob, ApplicationInstance } from "../shared/types.js";
import { buildRuntimeManifest, type RuntimeManifest } from "./app-manifests.js";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const memoryReserveBytes = 160 * 1024 * 1024;

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
      if (!config.WORKER_BOOTSTRAP_TOKEN || !config.WORKER_NODE_ID || !config.WORKER_NODE_NAME || !config.WORKER_PRIVATE_ADDRESS || !config.WORKER_MACHINE_TYPE || !config.WORKER_CAPACITY_MEMORY_MB || !config.WORKER_CAPACITY_CPU_MILLIS) throw new Error("Remote worker registration settings are incomplete.");
      const registered = await this.request<{ agentToken: string }>("/api/agent/register", { method: "POST", body: JSON.stringify({ id: config.WORKER_NODE_ID, name: config.WORKER_NODE_NAME, privateAddress: config.WORKER_PRIVATE_ADDRESS, machineType: config.WORKER_MACHINE_TYPE, capacityMemoryMb: config.WORKER_CAPACITY_MEMORY_MB, capacityCpuMillis: config.WORKER_CAPACITY_CPU_MILLIS, systemReserveMemoryMb: config.WORKER_SYSTEM_RESERVE_MEMORY_MB }) }, config.WORKER_BOOTSTRAP_TOKEN);
      if (!registered?.agentToken) throw new Error("Control plane did not return a worker token.");
      this.token = registered.agentToken;
      await mkdir(path.dirname(config.WORKER_AGENT_TOKEN_FILE), { recursive: true, mode: 0o700 });
      await writeFile(config.WORKER_AGENT_TOKEN_FILE, `${this.token}\n`, { mode: 0o600 });
    }
    await this.heartbeat();
  }

  async heartbeat() {
    if (!config.WORKER_PRIVATE_ADDRESS || !config.WORKER_CAPACITY_MEMORY_MB || !config.WORKER_CAPACITY_CPU_MILLIS) throw new Error("Worker capacity settings are incomplete.");
    await this.request("/api/agent/heartbeat", { method: "POST", body: JSON.stringify({ privateAddress: config.WORKER_PRIVATE_ADDRESS, capacityMemoryMb: config.WORKER_CAPACITY_MEMORY_MB, capacityCpuMillis: config.WORKER_CAPACITY_CPU_MILLIS }) });
  }

  async claim() { return (await this.request<{ job: AgentJob }>("/api/agent/jobs/claim", { method: "POST", body: "{}" }))?.job; }
  async report(jobId: string, report: WorkerReport) { await this.request(`/api/agent/jobs/${jobId}/report`, { method: "POST", body: JSON.stringify(report) }); }
  async routes() { return (await this.request<{ routes: Array<{ hostname: string; containerProject: string; appId: string }> }>("/api/agent/routes"))?.routes ?? []; }
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

function manifestReservation(manifest: RuntimeManifest) {
  return Object.values(manifest.compose.services).reduce((sum, service) => {
    const limit = String(service.mem_limit ?? "0m").match(/^(\d+)m$/i);
    return sum + (limit ? Number(limit[1]) * 1024 * 1024 : 0);
  }, 0);
}

async function availableMemoryBytes() {
  const contents = await readFile("/proc/meminfo", "utf8");
  const available = contents.match(/^MemAvailable:\s+(\d+) kB$/m);
  if (!available) throw new Error("Host memory availability could not be measured.");
  return Number(available[1]) * 1024;
}

async function assertCapacity(manifests: RuntimeManifest[]) {
  const requested = manifests.reduce((sum, manifest) => sum + manifestReservation(manifest), 0);
  const available = await availableMemoryBytes();
  if (requested + memoryReserveBytes > available) {
    throw new Error(`Insufficient safe memory: ${Math.ceil(requested / 1048576)} MB requested with ${Math.floor(available / 1048576)} MB currently available. Upgrade capacity before retrying.`);
  }
}

async function writeCompose(instance: ApplicationInstance, manifest: RuntimeManifest) {
  const directory = workspacePath(instance);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const composePath = path.join(directory, "compose.json");
  await writeFile(composePath, `${JSON.stringify(manifest.compose, null, 2)}\n`, { mode: 0o600 });
  return composePath;
}

async function reloadRoutes(agent: AgentClient) {
  const routes = await agent.routes();
  const blocks = routes.map((route) => {
    const instance: ApplicationInstance = { id: "00000000-0000-0000-0000-000000000000", installationId: "", appId: route.appId, state: "live", hostname: route.hostname, containerProject: route.containerProject, customDomains: [], memoryReservationMb: 0, cpuReservationMillis: 0, createdAt: "", updatedAt: "" };
    const manifest = buildRuntimeManifest(instance, { platformNetwork: config.PLATFORM_DOCKER_NETWORK });
    return `http://${route.hostname}:8080 {\n  encode zstd gzip\n  reverse_proxy ${manifest.primaryContainer}:${manifest.internalPort}\n}`;
  });
  await writeFile(config.HOST_CADDY_CONFIG, `${blocks.join("\n\n")}\n`, { mode: 0o640 });
  await docker(["exec", config.PLATFORM_CADDY_CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
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
  if (!['listmonk', 'umami'].includes(instance.appId)) return;
  const backupDirectory = path.join(directory, ".managed-backup");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const user = instance.appId === "listmonk" ? "listmonk" : "umami";
  const database = user;
  const dump = await execFileAsync("docker", ["exec", `${instance.containerProject}-db`, "pg_dump", "-U", user, "-d", database, "-Fc"], { encoding: "buffer", timeout: 15 * 60_000, maxBuffer: 1024 * 1024 * 1024 });
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
      if (instance.appId === "uptime-kuma") { await docker(["compose", "-f", composePath, "stop"]); stopped = true; }
      await prepareDatabaseDump(instance, directory);
      await execFileAsync("tar", ["-czf", archivePath, "--exclude=./database", "-C", directory, "."], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
      await encryptArchive(archivePath, encryptedPath);
      if (!config.WORKER_NODE_ID) throw new Error("Backup identity is unavailable.");
      const objectName = `${config.WORKER_NODE_ID}/${job.installationId}/${instance.id}/${new Date().toISOString().replaceAll(":", "-")}.tar.gz.enc`;
      await uploadBackup(encryptedPath, objectName);
      backups.push({ applicationInstanceId: instance.id, objectName, sizeBytes: (await stat(encryptedPath)).size });
    } finally {
      if (stopped) await docker(["compose", "-f", composePath, "start"]).catch(() => undefined);
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
    await downloadBackup(objectName, encryptedPath);
    await decryptArchive(encryptedPath, archivePath);
    const listing = await execFileAsync("tar", ["-tzf", archivePath], { timeout: 5 * 60_000 });
    if (listing.stdout.split("\n").some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) throw new Error("Backup archive contains an unsafe path.");
    await docker(["compose", "-f", composePath, "down"]);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", directory], { timeout: 30 * 60_000 });
    if (["listmonk", "umami"].includes(instance.appId)) {
      const user = instance.appId === "listmonk" ? "listmonk" : "umami";
      await docker(["compose", "-f", composePath, "up", "-d", "db"]);
      await docker(["cp", path.join(directory, ".managed-backup/database.dump"), `${instance.containerProject}-db:/tmp/database.dump`]);
      await docker(["exec", `${instance.containerProject}-db`, "pg_restore", "-U", user, "-d", user, "--clean", "--if-exists", "/tmp/database.dump"]);
    }
    await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
    await reloadRoutes(agent);
  } finally {
    await rm(encryptedPath, { force: true });
    await rm(archivePath, { force: true });
    await rm(path.join(directory, ".managed-backup"), { recursive: true, force: true });
  }
}

async function install(job: AgentJob, agent: AgentClient) {
  const manifests = job.applications.map((instance) => buildRuntimeManifest(instance, { platformNetwork: config.PLATFORM_DOCKER_NETWORK }));
  await assertCapacity(manifests);
  for (let index = 0; index < job.applications.length; index += 1) {
    const instance = job.applications[index];
    const manifest = manifests[index];
    const composePath = await writeCompose(instance, manifest);
    await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
  }
  await reloadRoutes(agent);
}

async function changeLifecycle(job: AgentJob, agent: AgentClient) {
  for (const instance of job.applications) {
    const composePath = path.join(workspacePath(instance), "compose.json");
    if (job.action === "upgrade") await docker(["compose", "-f", composePath, "pull"]);
    if (job.action === "upgrade" || job.action === "start") await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
    if (job.action === "stop") await docker(["compose", "-f", composePath, "stop"]);
    if (job.action === "uninstall") {
      await docker(["compose", "-f", composePath, "down", "--remove-orphans"]);
      await rm(workspacePath(instance), { recursive: true, force: true });
    }
  }
  await reloadRoutes(agent);
}

async function run() {
  if (config.PROVISIONING_WORKER !== "remote") throw new Error("Provisioning worker refused to start unless PROVISIONING_WORKER=remote.");
  const agent = new AgentClient();
  await agent.initialize();
  process.stdout.write(`Provisioning worker ${config.WORKER_NODE_ID} ready\n`);
  setInterval(() => { void agent.heartbeat().catch((error) => process.stderr.write(`${error instanceof Error ? error.message : "Worker heartbeat failed."}\n`)); }, 30_000);
  while (true) {
    const job = await agent.claim();
    if (!job) { await new Promise((resolve) => setTimeout(resolve, config.PROVISIONING_POLL_MILLISECONDS)); continue; }
    try {
      let backups: WorkerReport["backups"];
      if (job.action === "install") await install(job, agent);
      else if (["upgrade", "stop", "start", "uninstall"].includes(job.action)) await changeLifecycle(job, agent);
      else if (job.action === "reload-routes") await reloadRoutes(agent);
      else if (job.action === "backup") backups = await backup(job);
      else if (job.action === "restore") await restore(job, agent);
      else throw new Error(`Worker action ${job.action} is not enabled yet.`);
      const applicationState = job.action === "stop" || job.action === "uninstall" ? "stopped" : "live";
      await agent.report(job.id, { status: "succeeded", backups, applications: job.applications.map((application) => ({ id: application.id, state: applicationState, healthy: applicationState === "live" })) });
      await reloadRoutes(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "Unknown provisioning failure";
      await agent.report(job.id, { status: "failed", error: message, applications: job.applications.map((application) => ({ id: application.id, state: "failed" })) });
    }
  }
}

await run();
