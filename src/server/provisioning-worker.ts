import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import pg from "pg";
import type { ApplicationInstance, ProvisioningJob } from "../shared/types.js";
import { buildRuntimeManifest, type RuntimeManifest } from "./app-manifests.js";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const workerId = `docker-${process.pid}`;
const memoryReserveBytes = 160 * 1024 * 1024;

interface ClaimedJob extends ProvisioningJob {
  applications: ApplicationInstance[];
}

class WorkerDatabase {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, ssl: config.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false });
  }

  async recoverStaleJobs() {
    await this.pool.query("UPDATE provisioning_jobs SET status='queued',locked_at=NULL,locked_by=NULL,available_at=NOW(),updated_at=NOW() WHERE status='running' AND locked_at<NOW()-INTERVAL '15 minutes' AND attempts<3");
  }

  async claim(): Promise<ClaimedJob | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM provisioning_jobs WHERE status='queued' AND available_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); return undefined; }
      await client.query("UPDATE provisioning_jobs SET status='running',attempts=attempts+1,locked_at=NOW(),locked_by=$1,updated_at=NOW() WHERE id=$2", [workerId, row.id]);
      const applications = await client.query("SELECT * FROM application_instances WHERE installation_id=$1 ORDER BY created_at", [row.installation_id]);
      await client.query("COMMIT");
      return {
        id: String(row.id), installationId: String(row.installation_id), action: row.action, status: "running", attempts: Number(row.attempts) + 1, payload: row.payload ?? {}, createdAt: new Date(String(row.created_at)).toISOString(),
        applications: applications.rows.map((app) => ({ id: String(app.id), installationId: String(app.installation_id), appId: String(app.app_id), state: app.state, hostname: String(app.hostname), containerProject: String(app.container_project), customDomains: [], lastHealthAt: app.last_health_at ? new Date(String(app.last_health_at)).toISOString() : undefined, createdAt: new Date(String(app.created_at)).toISOString(), updatedAt: new Date(String(app.updated_at)).toISOString() })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setInstallationState(id: string, state: string, failureReason?: string) { await this.pool.query("UPDATE installations SET state=$1,failure_reason=$2,updated_at=NOW() WHERE id=$3", [state, failureReason ?? null, id]); }
  async setApplicationState(id: string, state: string, healthy = false) { await this.pool.query("UPDATE application_instances SET state=$1,last_health_at=CASE WHEN $2 THEN NOW() ELSE last_health_at END,updated_at=NOW() WHERE id=$3", [state, healthy, id]); }
  async complete(id: string) { await this.pool.query("UPDATE provisioning_jobs SET status='succeeded',locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=NOW() WHERE id=$1", [id]); }
  async fail(job: ClaimedJob, message: string) {
    if (job.attempts < 3) {
      await this.pool.query("UPDATE provisioning_jobs SET status='queued',available_at=NOW()+($1*INTERVAL '1 minute'),locked_at=NULL,locked_by=NULL,last_error=$2,updated_at=NOW() WHERE id=$3", [job.attempts, message, job.id]);
    } else {
      await this.pool.query("UPDATE provisioning_jobs SET status='failed',locked_at=NULL,locked_by=NULL,last_error=$1,updated_at=NOW() WHERE id=$2", [message, job.id]);
      await this.setInstallationState(job.installationId, "failed", message);
      for (const application of job.applications) await this.setApplicationState(application.id, "failed");
    }
  }

  async routes() {
    const result = await this.pool.query("SELECT a.id,a.hostname,a.container_project,a.app_id,COALESCE(array_agg(d.domain) FILTER (WHERE d.verification_status IN ('verified','active')), '{}') domains FROM application_instances a LEFT JOIN custom_domains d ON d.application_instance_id=a.id WHERE a.state='live' GROUP BY a.id ORDER BY a.hostname");
    return result.rows as Array<{ id: string; hostname: string; container_project: string; app_id: string; domains: string[] }>;
  }

  async activateVerifiedDomains() { await this.pool.query("UPDATE custom_domains SET verification_status='active',last_checked_at=NOW() WHERE verification_status='verified'"); }
  async recordBackup(installationId: string, applicationInstanceId: string, objectName: string, sizeBytes: number) { await this.pool.query("INSERT INTO backups(id,installation_id,application_instance_id,object_name,size_bytes,status) VALUES($1,$2,$3,$4,$5,'ready')", [randomUUID(), installationId, applicationInstanceId, objectName, sizeBytes]); }
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

async function reloadRoutes(database: WorkerDatabase) {
  const routes = await database.routes();
  const manifests = new Map<string, RuntimeManifest>();
  const blocks = routes.map((route) => {
    const instance: ApplicationInstance = { id: route.id, installationId: "", appId: route.app_id, state: "live", hostname: route.hostname, containerProject: route.container_project, customDomains: [], createdAt: "", updatedAt: "" };
    const manifest = buildRuntimeManifest(instance, { platformNetwork: config.PLATFORM_DOCKER_NETWORK });
    manifests.set(route.id, manifest);
    const hostnames = [route.hostname, ...(route.domains ?? [])].join(", ");
    return `${hostnames} {\n  encode zstd gzip\n  reverse_proxy ${manifest.primaryContainer}:${manifest.internalPort}\n}`;
  });
  await writeFile(config.HOST_CADDY_CONFIG, `${blocks.join("\n\n")}\n`, { mode: 0o640 });
  await docker(["exec", config.PLATFORM_CADDY_CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
  await database.activateVerifiedDomains();
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

async function backup(job: ClaimedJob, database: WorkerDatabase) {
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
      const objectName = `${job.installationId}/${instance.id}/${new Date().toISOString().replaceAll(":", "-")}.tar.gz.enc`;
      await uploadBackup(encryptedPath, objectName);
      await database.recordBackup(job.installationId, instance.id, objectName, (await stat(encryptedPath)).size);
    } finally {
      if (stopped) await docker(["compose", "-f", composePath, "start"]).catch(() => undefined);
      await rm(archivePath, { force: true });
      await rm(encryptedPath, { force: true });
      await rm(path.join(directory, ".managed-backup"), { recursive: true, force: true });
    }
  }
}

async function restore(job: ClaimedJob, database: WorkerDatabase) {
  const objectName = typeof job.payload.objectName === "string" ? job.payload.objectName : "";
  const instanceId = typeof job.payload.applicationInstanceId === "string" ? job.payload.applicationInstanceId : "";
  const instance = job.applications.find((candidate) => candidate.id === instanceId);
  if (!instance || !objectName.startsWith(`${job.installationId}/${instance.id}/`) || !objectName.endsWith(".tar.gz.enc")) throw new Error("Restore target is outside this managed application.");
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
    await database.setApplicationState(instance.id, "live", true);
    await reloadRoutes(database);
  } finally {
    await rm(encryptedPath, { force: true });
    await rm(archivePath, { force: true });
    await rm(path.join(directory, ".managed-backup"), { recursive: true, force: true });
  }
}

async function install(job: ClaimedJob, database: WorkerDatabase) {
  const manifests = job.applications.map((instance) => buildRuntimeManifest(instance, { platformNetwork: config.PLATFORM_DOCKER_NETWORK }));
  await assertCapacity(manifests);
  await database.setInstallationState(job.installationId, "provisioning");
  for (let index = 0; index < job.applications.length; index += 1) {
    const instance = job.applications[index];
    const manifest = manifests[index];
    await database.setApplicationState(instance.id, "provisioning");
    const composePath = await writeCompose(instance, manifest);
    await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
    await database.setApplicationState(instance.id, "live", true);
  }
  await reloadRoutes(database);
  await database.setInstallationState(job.installationId, "live");
}

async function changeLifecycle(job: ClaimedJob, database: WorkerDatabase) {
  for (const instance of job.applications) {
    const composePath = path.join(workspacePath(instance), "compose.json");
    if (job.action === "upgrade") await docker(["compose", "-f", composePath, "pull"]);
    if (job.action === "upgrade" || job.action === "start") await docker(["compose", "-f", composePath, "up", "-d", "--wait"]);
    if (job.action === "stop") await docker(["compose", "-f", composePath, "stop"]);
    if (job.action === "uninstall") {
      await docker(["compose", "-f", composePath, "down", "--remove-orphans"]);
      await rm(workspacePath(instance), { recursive: true, force: true });
    }
    await database.setApplicationState(instance.id, job.action === "stop" || job.action === "uninstall" ? "stopped" : "live", job.action !== "stop" && job.action !== "uninstall");
  }
  await database.setInstallationState(job.installationId, job.action === "stop" || job.action === "uninstall" ? "planned" : "live");
  await reloadRoutes(database);
}

async function run() {
  if (config.PROVISIONING_WORKER !== "docker") throw new Error("Provisioning worker refused to start unless PROVISIONING_WORKER=docker.");
  if (!config.DATABASE_URL) throw new Error("Provisioning worker requires PostgreSQL.");
  const database = new WorkerDatabase(config.DATABASE_URL);
  await database.recoverStaleJobs();
  process.stdout.write(`Provisioning worker ${workerId} ready\n`);
  while (true) {
    const job = await database.claim();
    if (!job) { await new Promise((resolve) => setTimeout(resolve, config.PROVISIONING_POLL_MILLISECONDS)); continue; }
    try {
      if (job.action === "install") await install(job, database);
      else if (["upgrade", "stop", "start", "uninstall"].includes(job.action)) await changeLifecycle(job, database);
      else if (job.action === "reload-routes") await reloadRoutes(database);
      else if (job.action === "backup") await backup(job, database);
      else if (job.action === "restore") await restore(job, database);
      else throw new Error(`Worker action ${job.action} is not enabled yet.`);
      await database.complete(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "Unknown provisioning failure";
      await database.fail(job, message);
    }
  }
}

await run();
