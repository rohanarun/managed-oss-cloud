import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { MemoryRepository } from "../src/server/repository";

async function application() {
  return createApp({ repository: new MemoryRepository() });
}

describe("account and server boundaries", () => {
  it("creates an account, session, server plan, domain, and capacity upgrade", async () => {
    const app = await application();
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ displayName: "Test Owner", email: "owner@example.com", password: "long-safe-password" });
    expect(signup.status).toBe(201);
    expect(signup.headers["set-cookie"]?.[0]).toContain("HttpOnly");

    const create = await agent.post("/api/installations").send({ name: "Team Tools", appIds: ["listmonk"] });
    expect(create.status).toBe(201);
    expect(create.body.installation.userId).toBe(signup.body.user.id);

    const domain = await agent.post(`/api/installations/${create.body.installation.id}/domains`).send({ domain: "mail.example.com" });
    expect(domain.status).toBe(200);
    expect(domain.body.dns.type).toBe("CNAME");

    const upgrade = await agent.post(`/api/installations/${create.body.installation.id}/upgrade`).send({ plan: "medium" });
    expect(upgrade.status).toBe(200);
    expect(upgrade.body.installation.plan).toBe("medium");
  });

  it("keeps unauthenticated and cross-account requests out", async () => {
    const app = await application();
    expect((await request(app).get("/api/dashboard")).status).toBe(401);

    const first = request.agent(app);
    const second = request.agent(app);
    await first.post("/api/auth/signup").send({ displayName: "First Owner", email: "first@example.com", password: "long-safe-password" });
    const created = await first.post("/api/installations").send({ name: "Private Stack", appIds: ["uptime-kuma"] });
    await second.post("/api/auth/signup").send({ displayName: "Second Owner", email: "second@example.com", password: "long-safe-password" });
    const attempted = await second.post(`/api/installations/${created.body.installation.id}/domains`).send({ domain: "stolen.example.com" });
    expect(attempted.status).toBe(404);
  });

  it("fails closed for integrations and billing", async () => {
    const app = await application();
    const agent = request.agent(app);
    await agent.post("/api/auth/signup").send({ displayName: "Safe Owner", email: "safe@example.com", password: "long-safe-password" });
    expect((await agent.post("/api/installations").send({ name: "Unverified", appIds: ["documenso"] })).status).toBe(409);
    expect((await agent.post("/api/billing/checkout").send({ installationId: "anything" })).status).toBe(503);
  });
});
