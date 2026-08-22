import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { MemoryRepository } from "../src/server/repository";

const bootstrapToken = "worker-bootstrap-token-with-more-than-32-characters";
const gatewayToken = "gateway-reconciler-token-with-more-than-32-characters";

async function installation(repository: MemoryRepository, userId: string, name: string, appId: string, memoryReservationMb: number, cpuReservationMillis: number) {
  const item = await repository.createInstallation({ userId, appIds: [appId], name, plan: "scale", state: "provisioning", hostname: `${name}.apps.example.com`, customDomains: [] });
  await repository.createApplicationInstances(item.id, [{ appId, memoryReservationMb, cpuReservationMillis, storageReservationGb: 10 }], "apps.example.com");
  await repository.enqueueJob(item.id, "install");
  return item;
}

describe("tenant worker pool", () => {
  it("keeps authenticated workers idle without crash-looping while leasing is locked", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({ repository, workerBootstrapToken: bootstrapToken, gatewayReconcilerToken: gatewayToken, agentJobsEnabled: false });
    const registration = await request(app).post("/api/agent/register").set("authorization", `Bearer ${bootstrapToken}`).send({ id: "idle-worker", name: "Idle Worker", privateAddress: "10.70.0.9", machineType: "e2-standard-2", capacityMemoryMb: 7168, capacityCpuMillis: 1800, capacityStorageGb: 180, systemReserveMemoryMb: 768 });
    expect(registration.status).toBe(201);
    expect((await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${registration.body.agentToken}`).send({})).status).toBe(204);
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
    const firstApplication = firstClaim.body.job.applications[0];
    expect((await request(app).post(`/api/agent/jobs/${firstClaim.body.job.id}/report`).set("authorization", `Bearer ${nodeOneToken}`).send({ status: "succeeded", applications: [{ id: firstApplication.id, state: "live", healthy: true }] })).status).toBe(204);

    const second = await installation(repository, user.id, "second", "umami", 768, 750);
    expect((await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeOneToken}`).send({})).status).toBe(204);
    const secondClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeTwoToken}`).send({});
    expect(secondClaim.status).toBe(200);
    expect(secondClaim.body.job.installationId).toBe(second.id);

    const stop = await repository.enqueueJob(first.id, "stop", { applicationInstanceId: firstApplication.id });
    expect((await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeTwoToken}`).send({})).status).toBe(204);
    const stickyClaim = await request(app).post("/api/agent/jobs/claim").set("authorization", `Bearer ${nodeOneToken}`).send({});
    expect(stickyClaim.body.job.id).toBe(stop.id);

    await repository.addDomain(user.id, first.id, "status.customer.example");
    await repository.setDomainStatus("status.customer.example", "verified");
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
});
