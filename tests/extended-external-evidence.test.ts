import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import {
  createExtendedExternalEvidenceVerifier,
  signExtendedExternalEvidenceAttestation,
} from "../src/server/extended-external-evidence.js";
import { extendedExternalEvidenceHash, type ExtendedExternalEvidenceRequest } from "../src/server/extended-business-engine.js";
import { MemoryRepository } from "../src/server/repository.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const secret = "external-evidence-test-secret.".repeat(3);

function requestFixture(overrides: Partial<ExtendedExternalEvidenceRequest> = {}): ExtendedExternalEvidenceRequest {
  const envelope = {
    version: "extended-external-evidence.v1" as const,
    kind: "metering-usage-event" as const,
    workspaceId: randomUUID(),
    actorUserId: randomUUID(),
    moduleId: "metering" as const,
    actionId: "ingest-event",
    evidence: { meterId: randomUUID(), sourceEventId: "source-42", subjectRef: "customer-42", quantity: 3 },
  };
  return { ...envelope, requestedAt: "2026-08-24T16:01:00.000Z", evidenceHash: extendedExternalEvidenceHash(envelope), ...overrides };
}

function tokenFor(requestValue: ExtendedExternalEvidenceRequest, overrides: Record<string, unknown> = {}) {
  return signExtendedExternalEvidenceAttestation(secret, {
    kind: requestValue.kind,
    workspaceId: requestValue.workspaceId,
    actorUserId: requestValue.actorUserId,
    moduleId: requestValue.moduleId,
    actionId: requestValue.actionId,
    evidenceHash: requestValue.evidenceHash,
    verifierId: "trusted-source-adapter",
    verificationId: "source-verification-42",
    verifiedAt: "2026-08-24T16:00:00.000Z",
    expiresAt: "2026-08-24T16:05:00.000Z",
    ...overrides,
  });
}

describe("hosting-layer external evidence attestations", () => {
  it("accepts only an exact signed workspace, actor, action, evidence hash, and validity window", async () => {
    const verifier = createExtendedExternalEvidenceVerifier(secret);
    const exact = requestFixture();
    const token = tokenFor(exact);
    await expect(verifier({ ...exact, attestationToken: token })).resolves.toMatchObject({
      verified: true,
      verifierId: "trusted-source-adapter",
      verificationId: "source-verification-42",
      evidenceHash: exact.evidenceHash,
    });
    await expect(verifier({ ...exact, actorUserId: randomUUID(), attestationToken: token })).resolves.toBeUndefined();
    await expect(verifier({ ...exact, evidenceHash: "0".repeat(64), attestationToken: token })).resolves.toBeUndefined();
    await expect(verifier({ ...exact, requestedAt: "2026-08-24T16:05:00.001Z", attestationToken: token })).resolves.toBeUndefined();
    await expect(verifier({ ...exact, attestationToken: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}` })).resolves.toBeUndefined();
    await expect(verifier(exact)).resolves.toBeUndefined();
  });

  it("wires the verifier through the shipped HTTP path and rejects caller-only assertions", async () => {
    const store = new MemorySuiteStore("fleet");
    const app = await createApp({
      repository: new MemoryRepository(),
      suiteStore: store,
      suiteEntitlementMode: "unrestricted",
      synchronizeSuiteEntitlements: false,
      verifyExtendedExternalEvidence: createExtendedExternalEvidenceVerifier(secret),
    });
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ displayName: "Evidence Owner", email: "evidence-owner@example.com", password: "long-safe-password" });
    expect(signup.status).toBe(201);
    const actorUserId = signup.body.user.id as string;
    expect((await agent.post("/api/suite/modules/metering/enable")).status).toBe(201);
    const workspaceId = (await agent.get("/api/suite/workspace")).body.workspace.id as string;
    const meterResponse = await agent.post("/api/suite/modules/metering/actions/create-meter").send({ input: { key: "trusted-api", name: "Trusted API calls", unit: "request", aggregation: "sum", eventKey: "api.request", dimensionKeys: ["region"], idempotencyKey: "trusted-meter.idempotency.0001" } });
    expect(meterResponse.status).toBe(200);
    const meterId = meterResponse.body.records[0].id as string;
    const occurredAt = new Date(Date.now() - 5_000).toISOString();
    const evidence = { meterId, sourceEventId: "trusted-source-42", subjectRef: "customer-42", quantity: 3, occurredAt, dimensions: { region: "us-east" }, sourceAttestation: "signed-source-batch-42" };
    const envelope = { version: "extended-external-evidence.v1" as const, kind: "metering-usage-event" as const, workspaceId, actorUserId, moduleId: "metering" as const, actionId: "ingest-event", evidence };
    const verifiedAt = new Date(Date.now() - 2_000).toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const externalEvidenceToken = signExtendedExternalEvidenceAttestation(secret, { kind: envelope.kind, workspaceId, actorUserId, moduleId: envelope.moduleId, actionId: envelope.actionId, evidenceHash: extendedExternalEvidenceHash(envelope), verifierId: "trusted-meter-adapter", verificationId: "trusted-meter-event-42", verifiedAt, expiresAt });

    const accepted = await agent.post("/api/suite/modules/metering/actions/ingest-event").send({ input: { ...evidence, externalEvidenceToken, idempotencyKey: "trusted-usage.idempotency.0001" } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.records[0]).toMatchObject({ recordType: "usage-event", state: "recorded", data: { sourceEventId: "trusted-source-42", gatewayVerification: { verifierId: "trusted-meter-adapter", verificationId: "trusted-meter-event-42" } } });

    const untrusted = await agent.post("/api/suite/modules/metering/actions/ingest-event").send({ input: { ...evidence, sourceEventId: "caller-only-source", sourceAttestation: "caller-only-assertion", idempotencyKey: "untrusted-usage.idempotency.0001" } });
    expect(untrusted.status).toBe(409);
    expect(untrusted.body.error).toMatch(/trusted hosting-layer adapter/);
    expect((await store.listRecords(actorUserId, { moduleId: "metering", recordType: "usage-event", limit: 100 })).map((record) => record.data.sourceEventId)).toEqual(["trusted-source-42"]);
  });
});
