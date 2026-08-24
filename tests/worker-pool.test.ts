import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import type { GcpWorkerIdentity } from "../src/server/gcp-instance-identity";
import { MemoryRepository } from "../src/server/repository";

const bootstrapToken = "worker-bootstrap-token-with-more-than-32-characters";
const gatewayToken = "gateway-reconciler-token-with-more-than-32-characters";

async function installation(repository: MemoryRepository, userId: string, name: string, appId: string, memoryReservationMb: number, cpuReservationMillis: number) {
  const item = await repository.createInstallation({ userId, appIds: [appId], name, plan: "scale", state: "provisioning", hostname: `${name}.apps.example.com`, customDomains: [] });
  await repository.recordSubscription({ userId, installationId: item.id, providerSubscriptionId: `sub_${item.id}`, status: "active", infrastructureMonthlyCents: 1, platformFeeMonthlyCents: 1 });
  await repository.createApplicationInstances(item.id, [{ appId, memoryReservationMb, cpuReservationMillis, storageReservationGb: 10 }], "apps.example.com");
  await repository.enqueueJob(item.id, "install");
  return item;
}

describe("tenant worker pool", () => {
  it("enrolls a hosted worker only with its exact Google Cloud instance identity", async () => {
    const repository = new MemoryRepository();
    const identityToken = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}`;
    const identity: GcpWorkerIdentity = {
      instanceId: "9876543210987654321",
      instanceName: "gcp-worker-0",
      projectId: "local-passage-501917-g0",
      zone: "us-central1-a",
      subject: "123456789012345678901",
      issuedAt: 2_000_000_000,
      expiresAt: 2_000_003_500,
    };
    const verifiedTokens: string[] = [];
    const app = await createApp({
      repository,
      workerBootstrapToken: bootstrapToken,
      gatewayReconcilerToken: gatewayToken,
      agentJobsEnabled: false,
      gcpWorkerIdentityVerifier: {
        verify: async (candidate) => {
          verifiedTokens.push(candidate);
          if (candidate !== identityToken) throw new Error("invalid signed identity");
          return identity;
        },
      },
    });
    const registration = {
      id: identity.instanceName,
      name: "Hosted GCP Worker",
      privateAddress: "10.70.0.50",
      machineType: "e2-standard-2",
      capacityMemoryMb: 7168,
      capacityCpuMillis: 1800,
      capacityStorageGb: 180,
      systemReserveMemoryMb: 768,
    };

    expect((await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send(registration)).status).toBe(401);
    expect((await request(app).post("/api/agent/register").set("authorization", `Bearer ${identityToken}`).send({ ...registration, id: "gcp-worker-rogue" })).status).toBe(403);

    const enrolled = await request(app).post("/api/agent/register").set("authorization", `Bearer ${identityToken}`).send(registration);
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.node).toMatchObject({ id: identity.instanceName, privateAddress: registration.privateAddress });
    expect(typeof enrolled.body.agentToken).toBe("string");
    expect(enrolled.body.agentToken).not.toContain(bootstrapToken);
    expect(verifiedTokens).toEqual([bootstrapToken, identityToken, identityToken]);

    expect((await request(app).post("/api/agent/register").set("authorization", `Bearer ${identityToken}`).send(registration)).status).toBe(409);
    const ownActivity = await request(app).get("/api/agent/activity").set("authorization", `Bearer ${enrolled.body.agentToken}`);
    expect(ownActivity.status).toBe(200);
    expect(ownActivity.body.activity).toMatchObject({ node: { id: identity.instanceName }, mode: "active" });
    expect(JSON.stringify(ownActivity.body)).not.toContain(bootstrapToken);
    expect((await request(app).get(`/api/internal/workers/${identity.instanceName}/activity`).set("authorization", `Bearer ${bootstrapToken}`)).status).toBe(200);
  });

  it("keeps authenticated workers idle without crash-looping while leasing is locked", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, workerBootstrapToken: bootstrapToken, gatewayReconcilerToken: gatewayToken, agentJobsEnabled: false });
    const registration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "idle-worker", name: "Idle Worker", privateAddress: "10.70.0.9", machineType: "e2-standard-2", capacityMemoryMb: 7168, capacityCpuMillis: 1800, capacityStorageGb: 180, systemReserveMemoryMb: 768 });
    expect(registration.status).toBe(201);
    expect((await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${registration.body.agentToken}`).send({})).status).toBe(204);
  });

  it("drains a worker without heartbeat reactivation, exposes active work, and preserves live routes", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, workerBootstrapToken: bootstrapToken, gatewayReconcilerToken: gatewayToken, agentJobsEnabled: true });
    const user = await repository.createUser({ email: "drain@example.com", displayName: "Drain Owner", passwordHash: "unused" });
    const item = await installation(repository, user.id, "drain", "listmonk", 576, 500);
    const registration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "drain-worker", name: "Drain Worker", privateAddress: "10.70.0.8", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });
    const agentAuthorization = { authorization: `Bearer ${registration.body.agentToken}` };
    const bootstrapAuthorization = { authorization: `Bearer ${bootstrapToken}` };

    expect((await request(app).post("/api/internal/workers/drain-worker/mode").send({ mode: "draining" })).status).toBe(401);
    expect((await request(app).post("/api/internal/workers/drain-worker/mode").set(agentAuthorization).send({ mode: "draining" })).status).toBe(401);
    const drained = await request(app).post("/api/internal/workers/drain-worker/mode").set(bootstrapAuthorization).send({ mode: "draining" });
    expect(drained.body.activity).toMatchObject({ mode: "draining", safeToReplaceAgent: true, runningJobs: [], assignedApplications: [] });

    const heartbeat = await request(app).post("/api/agent/heartbeat").set(agentAuthorization).send({ privateAddress: "10.70.0.8", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20 });
    expect(heartbeat.body.node.status).toBe("draining");
    expect((await request(app).post("/api/agent/jobs/claim").set(agentAuthorization).send({})).status).toBe(204);

    await request(app).post("/api/internal/workers/drain-worker/mode").set(bootstrapAuthorization).send({ mode: "active" });
    const claim = await request(app).post("/api/agent/jobs/claim").set(agentAuthorization).send({});
    expect(claim.body.job.action).toBe("install");
    const application = claim.body.job.applications[0];
    const drainingWithWork = await request(app).post("/api/internal/workers/drain-worker/mode").set(bootstrapAuthorization).send({ mode: "draining" });
    expect(drainingWithWork.body.activity).toMatchObject({ mode: "draining", safeToReplaceAgent: false });
    expect(JSON.stringify(drainingWithWork.body)).not.toContain(registration.body.agentToken);
    expect(JSON.stringify(drainingWithWork.body)).not.toContain(bootstrapToken);
    expect(drainingWithWork.body.activity.runningJobs).toEqual([expect.objectContaining({ id: claim.body.job.id, installationId: item.id, action: "install", status: "running" })]);
    expect(drainingWithWork.body.activity.assignedApplications).toEqual([expect.objectContaining({ id: application.id, installationId: item.id, appId: "listmonk" })]);
    expect((await request(app).post("/api/agent/heartbeat").set(agentAuthorization).send({ privateAddress: "10.70.0.8", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20 })).body.node.status).toBe("draining");

    expect((await request(app).post(`/api/agent/jobs/${claim.body.job.id}/report`).set(agentAuthorization).send({ status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).status).toBe(204);
    const idle = await request(app).get("/api/internal/workers/drain-worker/activity").set(bootstrapAuthorization);
    expect(idle.body.activity).toMatchObject({ mode: "draining", safeToReplaceAgent: true, runningJobs: [] });
    expect(idle.body.activity.assignedApplications).toHaveLength(1);
    expect((await request(app).get("/api/internal/gateway/routes").set("authorization", `Bearer ${gatewayToken}`)).body.routes).toEqual([expect.objectContaining({ workerNodeId: "drain-worker" })]);

    await repository.enqueueJob(item.id, "start", { applicationInstanceId: application.id });
    expect((await request(app).post("/api/agent/jobs/claim").set(agentAuthorization).send({})).status).toBe(204);
    await request(app).post("/api/internal/workers/drain-worker/mode").set(bootstrapAuthorization).send({ mode: "active" });
    expect((await request(app).post("/api/agent/jobs/claim").set(agentAuthorization).send({})).body.job.action).toBe("start");
  });

  it("marks install targets provisioning and queues one cleanup when cancellation rejects the in-flight report", async () => {
    const repository = new MemoryRepository();
    const user = await repository.createUser({ email: "cancel-install@example.com", displayName: "Cancel Install", passwordHash: "unused" });
    const item = await installation(repository, user.id, "cancel-install", "listmonk", 576, 500);
    const [subscription] = await repository.listSubscriptions();
    const worker = await repository.registerWorkerNode({ id: "cancel-install-worker", name: "Cancel Install Worker", privateAddress: "10.70.0.12", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });

    const install = await repository.claimWorkerJob(worker.node.id);
    expect(install?.action).toBe("install");
    const application = install!.applications[0];
    expect(await repository.getApplicationInstance(user.id, application.id)).toMatchObject({ state: "provisioning", workerNodeId: worker.node.id });

    await repository.updateSubscriptionStatus(subscription.providerSubscriptionId!, "canceled");
    expect(await repository.reportWorkerJob(worker.node.id, install!.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(false);
    const cleanup = await repository.claimWorkerJob(worker.node.id);
    expect(cleanup).toMatchObject({ action: "stop", installationId: item.id, workerNodeId: worker.node.id, payload: { applicationInstanceId: application.id, reason: "subscription_inactive" } });

    await repository.updateSubscriptionStatus(subscription.providerSubscriptionId!, "canceled");
    expect((await repository.claimWorkerJob(worker.node.id))?.id).toBe(cleanup!.id);
    expect(await repository.reportWorkerJob(worker.node.id, cleanup!.id, { status: "succeeded", applications: [{ id: application.id, state: "stopped", healthy: false }] })).toBe(true);
    expect(await repository.claimWorkerJob(worker.node.id)).toBeUndefined();
  });

  it("reconciliation queues one cleanup for an assigned install target before rejecting its report", async () => {
    const repository = new MemoryRepository();
    const user = await repository.createUser({ email: "reconcile-install@example.com", displayName: "Reconcile Install", passwordHash: "unused" });
    const item = await installation(repository, user.id, "reconcile-install", "umami", 768, 750);
    const [subscription] = await repository.listSubscriptions();
    const worker = await repository.registerWorkerNode({ id: "reconcile-install-worker", name: "Reconcile Install Worker", privateAddress: "10.70.0.13", machineType: "e2-standard-2", capacityMemoryMb: 2048, capacityCpuMillis: 1500, capacityStorageGb: 30, systemReserveMemoryMb: 512 });
    const install = await repository.claimWorkerJob(worker.node.id);
    const application = install!.applications[0];
    expect(application.state).toBe("provisioning");

    await repository.applySubscriptionReconciliation({ deactivateSubscriptionIds: [subscription.id], upsertSubscriptions: [], affectedUserIds: [user.id] });
    expect(await repository.reportWorkerJob(worker.node.id, install!.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(false);
    const cleanup = await repository.claimWorkerJob(worker.node.id);
    expect(cleanup).toMatchObject({ action: "stop", installationId: item.id, payload: { applicationInstanceId: application.id, reason: "subscription_reconciliation" } });

    await repository.applySubscriptionReconciliation({ deactivateSubscriptionIds: [subscription.id], upsertSubscriptions: [], affectedUserIds: [user.id] });
    expect((await repository.claimWorkerJob(worker.node.id))?.id).toBe(cleanup!.id);
  });

  it("keeps paid claims and reconciliation available in unrestricted hosting mode", async () => {
    const previousMode = config.HOSTING_ENTITLEMENT_MODE;
    config.HOSTING_ENTITLEMENT_MODE = "unrestricted";
    try {
      const repository = new MemoryRepository();
      const user = await repository.createUser({ email: "unrestricted-install@example.com", displayName: "Unrestricted Install", passwordHash: "unused" });
      const item = await repository.createInstallation({ userId: user.id, appIds: ["umami"], name: "Unrestricted", plan: "starter", state: "provisioning", hostname: "unrestricted.apps.example.com", customDomains: [] });
      const [application] = await repository.createApplicationInstances(item.id, [{ appId: "umami", memoryReservationMb: 768, cpuReservationMillis: 750, storageReservationGb: 10 }], "apps.example.com");
      await repository.enqueueJob(item.id, "install", { applicationInstanceId: application.id });
      const worker = await repository.registerWorkerNode({ id: "unrestricted-worker", name: "Unrestricted Worker", privateAddress: "10.70.0.14", machineType: "e2-standard-2", capacityMemoryMb: 2048, capacityCpuMillis: 1500, capacityStorageGb: 30, systemReserveMemoryMb: 512 });

      const install = await repository.claimWorkerJob(worker.node.id);
      expect(install?.action).toBe("install");
      await repository.applySubscriptionReconciliation({ deactivateSubscriptionIds: [], upsertSubscriptions: [], affectedUserIds: [user.id] });
      expect(await repository.reportWorkerJob(worker.node.id, install!.id, { status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).toBe(true);
      expect(await repository.getInstallation(user.id, item.id)).toMatchObject({ state: "live" });
      expect(await repository.claimWorkerJob(worker.node.id)).toBeUndefined();
    } finally {
      config.HOSTING_ENTITLEMENT_MODE = previousMode;
    }
  });

  it("authenticates nodes, places by capacity, preserves node affinity, and emits private routes", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, workerBootstrapToken: bootstrapToken, gatewayReconcilerToken: gatewayToken, agentJobsEnabled: true });
    const user = await repository.createUser({ email: "pool@example.com", displayName: "Pool Owner", passwordHash: "unused" });
    const first = await installation(repository, user.id, "first", "listmonk", 576, 500);

    expect((await request(app).post("/api/agent/jobs/claim")).status).toBe(401);
    const nodeOneRegistration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "worker-one", name: "Worker One", privateAddress: "10.70.0.10", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });
    expect(nodeOneRegistration.status).toBe(201);
    const nodeOneToken = nodeOneRegistration.body.agentToken as string;
    const nodeTwoRegistration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "worker-two", name: "Worker Two", privateAddress: "10.70.0.11", machineType: "e2-standard-2", capacityMemoryMb: 2048, capacityCpuMillis: 2000, capacityStorageGb: 100, systemReserveMemoryMb: 512 });
    const nodeTwoToken = nodeTwoRegistration.body.agentToken as string;

    const firstClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeOneToken}`).send({});
    expect(firstClaim.status).toBe(200);
    expect(firstClaim.body.job.installationId).toBe(first.id);
    expect(JSON.stringify(firstClaim.body)).not.toContain(user.email);
    const resumedClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeOneToken}`).send({});
    expect(resumedClaim.body.job.id).toBe(firstClaim.body.job.id);
    expect(resumedClaim.body.job.attempts).toBe(firstClaim.body.job.attempts);
    const firstApplication = firstClaim.body.job.applications[0];
    expect((await request(app).post(`/api/agent/jobs/${firstClaim.body.job.id}/report`).set("authorization", `Bearer ${nodeOneToken}`).send({ status: "succeeded", applications: [{ id: firstApplication.id, state: "live", healthy: true }] })).status).toBe(204);

    const second = await installation(repository, user.id, "second", "umami", 768, 750);
    expect((await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeOneToken}`).send({})).status).toBe(204);
    const secondClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeTwoToken}`).send({});
    expect(secondClaim.status).toBe(200);
    expect(secondClaim.body.job.installationId).toBe(second.id);

    const stop = await repository.enqueueJob(first.id, "stop", { applicationInstanceId: firstApplication.id });
    const secondResumedClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeTwoToken}`).send({});
    expect(secondResumedClaim.body.job.id).toBe(secondClaim.body.job.id);
    const stickyClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeOneToken}`).send({});
    expect(stickyClaim.body.job.id).toBe(stop.id);

    await repository.addDomain(user.id, first.id, "status.customer.example");
    await repository.setDomainStatus(user.id, first.id, "status.customer.example", "verified");
    const routes = await request(app).get("/api/internal/gateway/routes").set("authorization", `Bearer ${gatewayToken}`);
    expect(routes.status).toBe(200);
    expect(routes.body.routes).toEqual(expect.arrayContaining([expect.objectContaining({ hostname: "status.customer.example", workerPrivateAddress: "10.70.0.10", workerNodeId: "worker-one" })]));
    expect((await request(app).get("/api/internal/gateway/routes")).status).toBe(401);
  });

  it("places cloned applications from one workspace across workers when capacity requires it", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, workerBootstrapToken: bootstrapToken, gatewayReconcilerToken: gatewayToken, agentJobsEnabled: true });
    const user = await repository.createUser({ email: "spread@example.com", displayName: "Spread Owner", passwordHash: "unused" });
    const workspace = await repository.createInstallation({ userId: user.id, appIds: ["listmonk", "listmonk"], name: "Spread", plan: "scale", state: "provisioning", hostname: "spread.apps.example.com", customDomains: [] });
    await repository.recordSubscription({ userId: user.id, installationId: workspace.id, providerSubscriptionId: `sub_${workspace.id}`, status: "active", infrastructureMonthlyCents: 1, platformFeeMonthlyCents: 1 });
    const applications = await repository.createApplicationInstances(workspace.id, [
      { appId: "listmonk", memoryReservationMb: 576, cpuReservationMillis: 500, storageReservationGb: 10 },
      { appId: "listmonk", memoryReservationMb: 576, cpuReservationMillis: 500, storageReservationGb: 10 },
    ], "apps.example.com");
    for (const application of applications) await repository.enqueueJob(workspace.id, "install", { applicationInstanceId: application.id });
    const firstRegistration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "spread-one", name: "Spread One", privateAddress: "10.70.0.20", machineType: "e2-standard-2", capacityMemoryMb: 1200, capacityCpuMillis: 600, capacityStorageGb: 15, systemReserveMemoryMb: 512 });
    const secondRegistration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "spread-two", name: "Spread Two", privateAddress: "10.70.0.21", machineType: "e2-standard-2", capacityMemoryMb: 1200, capacityCpuMillis: 600, capacityStorageGb: 15, systemReserveMemoryMb: 512 });
    const firstClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${firstRegistration.body.agentToken}`).send({});
    const secondClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${secondRegistration.body.agentToken}`).send({});
    expect(firstClaim.body.job.applications[0].id).not.toBe(secondClaim.body.job.applications[0].id);
    expect(firstClaim.body.job.installationId).toBe(workspace.id);
    expect(secondClaim.body.job.installationId).toBe(workspace.id);
  });

  it("recovers unassigned lifecycle and data jobs only on the worker that owns their application", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, workerBootstrapToken: bootstrapToken, gatewayReconcilerToken: gatewayToken, agentJobsEnabled: true });
    const user = await repository.createUser({ email: "recovery@example.com", displayName: "Recovery Owner", passwordHash: "unused" });
    const workspace = await repository.createInstallation({ userId: user.id, appIds: ["uptime-kuma"], name: "Recovery", plan: "starter", state: "provisioning", hostname: "recovery.apps.example.com", customDomains: [] });
    await repository.recordSubscription({ userId: user.id, installationId: workspace.id, providerSubscriptionId: `sub_${workspace.id}`, status: "active", infrastructureMonthlyCents: 1, platformFeeMonthlyCents: 1 });
    const [application] = await repository.createApplicationInstances(workspace.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
    const installJob = await repository.enqueueJob(workspace.id, "install", { applicationInstanceId: application.id });
    const pendingJobs = await Promise.all(["stop", "start", "backup", "restore", "uninstall"].map((action) => repository.enqueueJob(workspace.id, action as "stop" | "start" | "backup" | "restore" | "uninstall", { applicationInstanceId: application.id, ...(action === "restore" ? { objectName: "worker-owner/backup.enc" } : {}) })));
    expect(pendingJobs.every((job) => job.workerNodeId === undefined)).toBe(true);

    const ownerRegistration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "worker-owner", name: "Worker Owner", privateAddress: "10.70.0.30", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });
    const otherRegistration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "worker-other", name: "Worker Other", privateAddress: "10.70.0.31", machineType: "e2-standard-2", capacityMemoryMb: 4096, capacityCpuMillis: 4000, capacityStorageGb: 100, systemReserveMemoryMb: 512 });
    const ownerToken = ownerRegistration.body.agentToken as string;
    const otherToken = otherRegistration.body.agentToken as string;

    const installClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${ownerToken}`).send({});
    expect(installClaim.body.job.id).toBe(installJob.id);
    expect((await request(app).post(`/api/agent/jobs/${installJob.id}/report`).set("authorization", `Bearer ${ownerToken}`).send({ status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).status).toBe(204);

    for (const pending of pendingJobs) {
      expect((await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${otherToken}`).send({})).status).toBe(204);
      const claim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${ownerToken}`).send({});
      expect(claim.status).toBe(200);
      expect(claim.body.job).toMatchObject({ id: pending.id, workerNodeId: "worker-owner" });
      const state = pending.action === "stop" || pending.action === "uninstall" ? "stopped" : "live";
      expect((await request(app).post(`/api/agent/jobs/${pending.id}/report`).set("authorization", `Bearer ${ownerToken}`).send({ status: "succeeded", applications: [{ id: application.id, state, healthy: state === "live" }] })).status).toBe(204);
    }
  });

  it("suspends canceled hosted servers across HTTP mutations, gateway routes, and worker claims", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, workerBootstrapToken: bootstrapToken, gatewayReconcilerToken: gatewayToken, agentJobsEnabled: true });
    const customer = request.agent(app);
    const signup = await customer.post("/api/auth/signup").send({ displayName: "Canceled Owner", email: "canceled-hosting@example.com", password: "long-safe-password" });
    const userId = signup.body.user.id as string;
    const workspace = await repository.createInstallation({ userId, appIds: ["uptime-kuma"], name: "Canceled", plan: "starter", state: "provisioning", hostname: "canceled.apps.example.com", customDomains: [] });
    const [application] = await repository.createApplicationInstances(workspace.id, [{ appId: "uptime-kuma", memoryReservationMb: 384, cpuReservationMillis: 250, storageReservationGb: 3 }], "apps.example.com");
    await repository.recordSubscription({ userId, installationId: workspace.id, providerSubscriptionId: "sub_canceled_hosting", status: "active", infrastructureMonthlyCents: 500, platformFeeMonthlyCents: 200 });
    await repository.enqueueJob(workspace.id, "install", { applicationInstanceId: application.id });
    const registration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "cancel-worker", name: "Cancel Worker", privateAddress: "10.70.0.40", machineType: "e2-standard-2", capacityMemoryMb: 1536, capacityCpuMillis: 1000, capacityStorageGb: 20, systemReserveMemoryMb: 512 });
    const workerAuthorization = { authorization: `Bearer ${registration.body.agentToken}` };
    const install = await request(app).post("/api/agent/jobs/claim").set(workerAuthorization).send({});
    await request(app).post(`/api/agent/jobs/${install.body.job.id}/report`).set(workerAuthorization).send({ status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] });
    expect((await request(app).get("/api/internal/gateway/routes").set("authorization", `Bearer ${gatewayToken}`)).body.routes).toHaveLength(1);

    const runningPaidJob = await repository.enqueueJob(workspace.id, "start", { applicationInstanceId: application.id });
    expect((await request(app).post("/api/agent/jobs/claim").set(workerAuthorization).send({})).body.job.id).toBe(runningPaidJob.id);

    await repository.updateSubscriptionStatus("sub_canceled_hosting", "canceled");
    expect((await repository.getInstallation(userId, workspace.id))?.state).toBe("suspended");
    expect((await customer.post(`/api/installations/${workspace.id}/applications`).set("Idempotency-Key", "clone-inactive-request-0001").send({ appId: "uptime-kuma" })).status).toBe(402);
    expect((await customer.post(`/api/installations/${workspace.id}/domains`).send({ domain: "canceled.customer.example" })).status).toBe(402);
    expect((await customer.post(`/api/installations/${workspace.id}/actions`).send({ action: "start", applicationInstanceId: application.id })).status).toBe(402);
    expect((await request(app).get("/api/internal/gateway/routes").set("authorization", `Bearer ${gatewayToken}`)).body.routes).toEqual([]);
    expect((await request(app).post(`/api/agent/jobs/${runningPaidJob.id}/report`).set(workerAuthorization).send({ status: "succeeded", applications: [{ id: application.id, state: "live", healthy: true }] })).status).toBe(409);

    await repository.enqueueJob(workspace.id, "start", { applicationInstanceId: application.id });
    const stop = await request(app).post("/api/agent/jobs/claim").set(workerAuthorization).send({});
    expect(stop.body.job.action).toBe("stop");
    await request(app).post(`/api/agent/jobs/${stop.body.job.id}/report`).set(workerAuthorization).send({ status: "succeeded", applications: [{ id: application.id, state: "stopped", healthy: false }] });
    expect((await request(app).post("/api/agent/jobs/claim").set(workerAuthorization).send({})).status).toBe(204);
  });
});
