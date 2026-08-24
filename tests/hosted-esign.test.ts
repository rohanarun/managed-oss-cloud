import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  HostedEsignError,
  HostedEsignService,
  InMemoryHostedEsignRateLimiter,
  createHostedEsignRouter,
  hostedEsignMaximumPdfBytes,
  hostedEsignMountContract,
  type HostedEsignLoadedObject,
  type HostedEsignObjectLoader,
  type HostedEsignObjectRequest,
} from "../src/server/hosted-esign.js";
import { executeEsignAction, type EsignAuthorization, type EsignExecutionResult } from "../src/server/esign-engine.js";
import { MemorySuiteStore } from "../src/server/suite-store.js";

const initialClock = new Date("2026-08-24T18:00:00.000Z");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");

function id(label: string) {
  return `hosted-esign.${label}.0001`;
}

function approval(auth: EsignAuthorization, label: string) {
  return {
    approved: true,
    approvedBy: auth.userId,
    approvedAt: initialClock.toISOString(),
    decisionId: `hosted-esign.${label}.decision.0001`,
    reason: `Reviewed the exact ${label} workflow boundary.`,
  };
}

function first(result: EsignExecutionResult, recordType: string) {
  const record = result.records.find((candidate) => candidate.recordType === recordType);
  if (!record) throw new Error(`Expected ${recordType}.`);
  return record;
}

class ExactPdfLoader implements HostedEsignObjectLoader {
  mode: "exact" | "wrong-bytes" | "wrong-version" | "unsafe" = "exact";
  requests: HostedEsignObjectRequest[] = [];

  async loadExactPdf(input: HostedEsignObjectRequest): Promise<HostedEsignLoadedObject> {
    this.requests.push(input);
    const bytes = this.mode === "wrong-bytes" ? Buffer.from("%PDF-1.7\nchanged\n%%EOF\n") : pdfBytes;
    return {
      bytes,
      objectVersion: this.mode === "wrong-version" ? "generation-other" : input.objectVersion,
      contentType: "application/pdf",
      sourceSha256: input.expectedSha256,
      safetyProfile: this.mode === "unsafe" ? ("unreviewed-pdf" as "sanitized-static-pdf.v1") : "sanitized-static-pdf.v1",
    };
  }
}

async function fixture() {
  let clock = new Date(initialClock);
  const now = () => new Date(clock);
  const store = new MemorySuiteStore("starter");
  const userId = randomUUID();
  let workspace = await store.getOrCreateWorkspace(userId);
  workspace = (await store.enableModule(userId, "esign"))!;
  const auth: EsignAuthorization = { userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
  const run = (actionId: string, input: Record<string, unknown>) => executeEsignAction(store, auth, "esign", actionId, input, { now, randomBytes, modelPolicyId: "test-no-ai" });
  const fieldId = randomUUID();
  const signerId = randomUUID();
  const template = first(await run("template-create", { name: "Hosted agreement", purpose: "Record explicit workflow choices.", idempotencyKey: id("template") }), "template");
  const templateVersion = first(await run("template-version-create", {
    templateId: template.id,
    expectedTemplateVersion: 0,
    signerRoles: [{ role: "Signer", order: 1 }],
    fields: [{ fieldId, signerRole: "Signer", kind: "signature", page: 1, xBasisPoints: 1_000, yBasisPoints: 8_000, widthBasisPoints: 3_000, heightBasisPoints: 800, required: true, label: "Signature" }],
    disclosure: "Review the exact document and explicitly choose complete or decline.",
    instructions: "Read every page before making a choice.",
    idempotencyKey: id("template-version"),
  }), "template-version");
  const document = first(await run("document-register", {
    title: "agreement.pdf",
    objectRef: "tenant/contracts/agreement.pdf",
    objectVersion: "generation-0001",
    sha256: pdfHash,
    sizeBytes: pdfBytes.byteLength,
    contentType: "application/pdf",
    pageCount: 1,
    idempotencyKey: id("document"),
  }), "document");
  const envelope = first(await run("envelope-draft", {
    title: "Agreement for review",
    templateVersionId: templateVersion.id,
    documentId: document.id,
    documentHash: pdfHash,
    signers: [{ signerId, signerKeyHash: "b".repeat(64), role: "Signer", order: 1, authentication: "access-link", locale: "en-US", displayLabel: "Primary signer" }],
    expiresAt: "2026-09-24T18:00:00.000Z",
    message: "Please review the exact document.",
    idempotencyKey: id("envelope"),
  }), "envelope");
  const preview = await run("envelope-preview", { envelopeId: envelope.id, expectedVersion: 1 });
  await run("envelope-dispatch-plan", {
    envelopeId: envelope.id,
    expectedVersion: 1,
    previewHash: preview.audit.previewHash,
    channel: "hosted-link",
    dryRun: false,
    approval: approval(auth, "dispatch"),
    idempotencyKey: id("dispatch"),
  });
  const issued = await run("signer-session-issue", {
    envelopeId: envelope.id,
    signerId,
    expectedEnvelopeVersion: 2,
    expiresAt: "2026-08-25T18:00:00.000Z",
    dryRun: false,
    approval: approval(auth, "session"),
    idempotencyKey: id("session"),
  });
  const session = first(issued, "signer-session");
  const token = issued.privateOutput?.signerSessionToken;
  if (!token) throw new Error("Expected a signer token.");
  const loader = new ExactPdfLoader();
  const service = (options: ConstructorParameters<typeof HostedEsignService>[0] = { store, objectLoader: loader, now }) => new HostedEsignService(options);
  return { store, userId, workspace, auth, fieldId, signerId, envelope, session, token, loader, service, now, setClock: (value: string) => { clock = new Date(value); } };
}

function credential(context: Awaited<ReturnType<typeof fixture>>) {
  return { workspaceId: context.workspace.id, sessionToken: context.token, clientKey: "203.0.113.10" };
}

function httpApp(context: Awaited<ReturnType<typeof fixture>>, service = context.service()) {
  const app = express();
  app.use("/api/public/esign", createHostedEsignRouter({ service, allowedOrigins: ["https://sign.example"], requireTls: false }));
  return app;
}

describe("secure hosted e-sign signer surface", () => {
  it("opens only the exact immutable signer, template, envelope, and document boundary", async () => {
    const context = await fixture();
    const view = await context.service().openSession(credential(context));
    expect(view).toMatchObject({
      schema: "hosted-esign-session.v1",
      workspaceId: context.workspace.id,
      envelopeId: context.envelope.id,
      envelopeVersion: 3,
      sessionId: context.session.id,
      sessionVersion: 1,
      signerId: context.signerId,
      disclosure: "Review the exact document and explicitly choose complete or decline.",
      document: { contentType: "application/pdf", sha256: pdfHash, objectVersion: "generation-0001", protectedEndpoint: "./document" },
      choices: { complete: "complete", decline: "decline", explicitChoiceRequired: true },
      claims: { identityAssurance: "not-assessed", legalComplianceCertified: false, qualifiedSignatureClaimed: false },
    });
    expect(view.disclosureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(view.boundaryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(view.fields).toEqual([expect.objectContaining({ fieldId: context.fieldId, kind: "signature", required: true })]);
    expect(JSON.stringify(view)).not.toContain(context.token);
    expect(hostedEsignMountContract()).toMatchObject({ mountPath: "/api/public/esign", autonomousAiAllowed: false, legalComplianceCertified: false });
  });

  it("fails closed for wrong, expired, revoked, and cross-tenant signer credentials", async () => {
    const wrong = await fixture();
    await expect(wrong.service().openSession({ ...credential(wrong), sessionToken: `esig_${"Z".repeat(43)}` })).rejects.toMatchObject({ code: "invalid_or_expired_session", status: 401 });

    const expired = await fixture();
    expired.setClock("2026-08-25T18:00:00.001Z");
    await expect(expired.service().openSession(credential(expired))).rejects.toMatchObject({ code: "invalid_or_expired_session", status: 401 });

    const revoked = await fixture();
    await revoked.store.updateRecord(revoked.userId, revoked.session.id, { state: "revoked", data: { revokedAt: initialClock.toISOString(), version: 2 } });
    await expect(revoked.service().openSession(credential(revoked))).rejects.toMatchObject({ code: "invalid_or_expired_session", status: 401 });

    const firstTenant = await fixture();
    const secondTenant = await fixture();
    await expect(secondTenant.service().openSession({ workspaceId: secondTenant.workspace.id, sessionToken: firstTenant.token, clientKey: "203.0.113.11" })).rejects.toMatchObject({ code: "invalid_or_expired_session", status: 401 });
  });

  it("loads only the exact content-addressed sanitized PDF object", async () => {
    const context = await fixture();
    const pdf = await context.service().loadDocument(credential(context));
    expect(Buffer.from(pdf.bytes)).toEqual(pdfBytes);
    expect(pdf).toMatchObject({ contentType: "application/pdf", sizeBytes: pdfBytes.byteLength, sha256: pdfHash, objectVersion: "generation-0001", safetyProfile: "sanitized-static-pdf.v1" });
    expect(context.loader.requests).toEqual([expect.objectContaining({ workspaceId: context.workspace.id, ownerUserId: context.userId, objectRef: "tenant/contracts/agreement.pdf", objectVersion: "generation-0001", expectedSha256: pdfHash, expectedSizeBytes: pdfBytes.byteLength })]);

    for (const mode of ["wrong-bytes", "wrong-version", "unsafe"] as const) {
      const mismatch = await fixture();
      mismatch.loader.mode = mode;
      await expect(mismatch.service().loadDocument(credential(mismatch))).rejects.toMatchObject({ code: "document_unavailable" });
    }
  });

  it("caps buffered hosted PDFs before calling the loader and uses the indexed session lookup", async () => {
    const context = await fixture();
    const findSignerSession = vi.spyOn(context.store, "findSignerSessionByTokenHash");
    const capped = context.service({ store: context.store, objectLoader: context.loader, now: context.now, maximumPdfBytes: pdfBytes.byteLength - 1 });
    await expect(capped.loadDocument(credential(context))).rejects.toMatchObject({ code: "document_unavailable", status: 413 });
    expect(context.loader.requests).toHaveLength(0);
    expect(findSignerSession).toHaveBeenCalledWith(context.userId, createHash("sha256").update(context.token, "utf8").digest("hex"));
    expect(() => context.service({ store: context.store, objectLoader: context.loader, maximumPdfBytes: hostedEsignMaximumPdfBytes + 1 })).toThrow(/PDF bytes/);
  });

  it("rate limits both credential and client buckets without storing plaintext credentials", async () => {
    const context = await fixture();
    const limiter = new InMemoryHostedEsignRateLimiter();
    const service = context.service({ store: context.store, objectLoader: context.loader, now: context.now, rateLimiter: limiter, ratePolicies: { session: { limit: 1, windowMs: 60_000 } } });
    await service.openSession(credential(context));
    await expect(service.openSession(credential(context))).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 60 });
    const storedBucketKeys = [...(limiter as unknown as { buckets: Map<string, unknown> }).buckets.keys()];
    expect(storedBucketKeys).toHaveLength(2);
    expect(storedBucketKeys.every((key) => /^[a-z]+:(?:client|credential):[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(storedBucketKeys.join(" ")).not.toContain(context.token);
    expect(JSON.stringify(limiter)).not.toContain(context.token);
  });

  it("records an explicit complete decision through the existing engine without raw values, AI, or legal claims", async () => {
    const context = await fixture();
    const service = context.service();
    const view = await service.openSession(credential(context));
    const result = await service.complete({
      ...credential(context),
      decision: "complete",
      reviewedDisclosure: true,
      disclosureHash: view.disclosureHash,
      boundaryHash: view.boundaryHash,
      expectedEnvelopeVersion: view.envelopeVersion,
      expectedSessionVersion: view.sessionVersion,
      decisionId: "hosted.complete.decision.0001",
      decidedAt: initialClock.toISOString(),
      fieldFacts: [{ fieldId: context.fieldId, valueHash: "d".repeat(64), completedAt: initialClock.toISOString(), method: "drawn-mark" }],
    });
    expect(result).toMatchObject({ schema: "hosted-esign-decision.v1", decision: "complete", envelopeId: context.envelope.id, sessionId: context.session.id, envelopeState: "completed", identityAssurance: "not-assessed", legalComplianceCertified: false });
    expect(result.receiptId).toMatch(uuidPattern);
    const completions = await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "field-completion", limit: 10 });
    expect(completions).toEqual([expect.objectContaining({ data: expect.objectContaining({ valueHash: "d".repeat(64), rawValuePersisted: false, identityAssurance: "not-assessed" }) })]);
    expect(JSON.stringify(await context.store.listRecords(context.userId, { moduleId: "esign", limit: 1_000 }))).not.toContain(context.token);
    expect(JSON.stringify(result)).not.toContain(context.token);
  });

  it("records an explicit decline without requiring or inventing a signature", async () => {
    const context = await fixture();
    const service = context.service();
    const view = await service.openSession(credential(context));
    const result = await service.decline({
      ...credential(context),
      decision: "decline",
      reviewedDisclosure: true,
      disclosureHash: view.disclosureHash,
      boundaryHash: view.boundaryHash,
      expectedEnvelopeVersion: view.envelopeVersion,
      expectedSessionVersion: view.sessionVersion,
      decisionId: "hosted.decline.decision.0001",
      decidedAt: initialClock.toISOString(),
      reason: "I do not agree to these terms.",
    });
    expect(result).toMatchObject({ decision: "decline", envelopeState: "declined", identityAssurance: "not-assessed", legalComplianceCertified: false });
    const events = await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "decline-event", limit: 10 });
    expect(events).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: "I do not agree to these terms.", signatureOccurred: false }) })]);
  });

  it("replays complete and decline decisions with stable clocks after their sessions become terminal", async () => {
    const completed = await fixture();
    const completeService = completed.service();
    const completeView = await completeService.openSession(credential(completed));
    const completeInput = {
      ...credential(completed),
      decision: "complete" as const,
      reviewedDisclosure: true as const,
      disclosureHash: completeView.disclosureHash,
      boundaryHash: completeView.boundaryHash,
      expectedEnvelopeVersion: completeView.envelopeVersion,
      expectedSessionVersion: completeView.sessionVersion,
      decisionId: "hosted.complete.replay.0001",
      decidedAt: initialClock.toISOString(),
      fieldFacts: [{ fieldId: completed.fieldId, valueHash: "e".repeat(64), completedAt: initialClock.toISOString(), method: "drawn-mark" as const }],
    };
    const firstComplete = await completeService.complete(completeInput);
    completed.setClock("2026-08-24T18:05:00.000Z");
    completed.loader.mode = "wrong-bytes";
    const replayedComplete = await completeService.complete(completeInput);
    expect(replayedComplete).toEqual(firstComplete);
    expect(await completed.store.listRecords(completed.userId, { moduleId: "esign", recordType: "field-completion", limit: 10 })).toHaveLength(1);

    const declined = await fixture();
    const declineService = declined.service();
    const declineView = await declineService.openSession(credential(declined));
    const declineInput = {
      ...credential(declined),
      decision: "decline" as const,
      reviewedDisclosure: true as const,
      disclosureHash: declineView.disclosureHash,
      boundaryHash: declineView.boundaryHash,
      expectedEnvelopeVersion: declineView.envelopeVersion,
      expectedSessionVersion: declineView.sessionVersion,
      decisionId: "hosted.decline.replay.0001",
      decidedAt: initialClock.toISOString(),
      reason: "I still decline this exact agreement.",
    };
    const firstDecline = await declineService.decline(declineInput);
    declined.setClock("2026-08-24T18:05:00.000Z");
    const replayedDecline = await declineService.decline(declineInput);
    expect(replayedDecline).toEqual(firstDecline);
    expect(await declined.store.listRecords(declined.userId, { moduleId: "esign", recordType: "decline-event", limit: 10 })).toHaveLength(1);
  });

  it("rejects stale disclosure, boundary, and version submissions before mutation", async () => {
    const context = await fixture();
    const service = context.service();
    const view = await service.openSession(credential(context));
    const base = {
      ...credential(context),
      decision: "complete" as const,
      reviewedDisclosure: true as const,
      disclosureHash: view.disclosureHash,
      boundaryHash: view.boundaryHash,
      expectedEnvelopeVersion: view.envelopeVersion,
      expectedSessionVersion: view.sessionVersion,
      decisionId: "hosted.stale.decision.0001",
      decidedAt: initialClock.toISOString(),
      fieldFacts: [{ fieldId: context.fieldId, valueHash: "d".repeat(64), completedAt: initialClock.toISOString(), method: "drawn-mark" as const }],
    };
    await expect(service.complete({ ...base, disclosureHash: "0".repeat(64) })).rejects.toMatchObject({ code: "boundary_mismatch" });
    await expect(service.complete({ ...base, boundaryHash: "0".repeat(64) })).rejects.toMatchObject({ code: "boundary_mismatch" });
    await expect(service.complete({ ...base, expectedEnvelopeVersion: view.envelopeVersion + 1 })).rejects.toMatchObject({ code: "boundary_mismatch" });
    expect(await context.store.listRecords(context.userId, { moduleId: "esign", recordType: "field-completion", limit: 10 })).toHaveLength(0);
  });

  it("mounts body/header-only credentials with strict origin, CSRF, TLS-ready, no-store, and anti-frame controls", async () => {
    const context = await fixture();
    const app = httpApp(context);
    const protectedHeaders = { Origin: "https://sign.example", "X-Hosted-Signer-Request": "1" };
    const success = await request(app).post("/api/public/esign/session").set(protectedHeaders).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(200);
    expect(success.headers).toMatchObject({
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "content-security-policy": expect.stringContaining("frame-ancestors 'none'"),
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "strict-transport-security": expect.stringContaining("max-age=63072000"),
      "access-control-allow-origin": "https://sign.example",
    });
    expect(success.text).not.toContain(context.token);

    await request(app).post("/api/public/esign/session").set({ "X-Hosted-Signer-Request": "1" }).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(403);
    await request(app).post("/api/public/esign/session").set({ Origin: "https://evil.example", "X-Hosted-Signer-Request": "1" }).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(403);
    await request(app).post("/api/public/esign/session").set({ Origin: "https://sign.example" }).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(403);
    const queryResponse = await request(app).post("/api/public/esign/session").query({ sessionToken: context.token }).set(protectedHeaders).send({ workspaceId: context.workspace.id }).expect(400);
    expect(queryResponse.text).not.toContain(context.token);
    await request(app).post("/api/public/esign/session").set({ ...protectedHeaders, Cookie: "session=ambient" }).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(400);

    const headerResponse = await request(app).post("/api/public/esign/document").set({ ...protectedHeaders, Authorization: `Bearer ${context.token}` }).send({ workspaceId: context.workspace.id }).expect(200);
    expect(headerResponse.headers["content-type"]).toContain("application/pdf");
    expect(headerResponse.headers["content-disposition"]).toBe("inline; filename=\"agreement.pdf\"");
    expect(headerResponse.headers["x-content-sha256"]).toBe(pdfHash);
    expect(Buffer.from(headerResponse.body)).toEqual(pdfBytes);

    const duplicateCredential = await request(app).post("/api/public/esign/session").set({ ...protectedHeaders, Authorization: `Bearer ${context.token}` }).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(400);
    expect(duplicateCredential.text).not.toContain(context.token);
  });

  it("requires HTTPS by default and permits forwarded HTTPS only when the trusted-proxy option is explicit", async () => {
    const context = await fixture();
    const app = express();
    app.use("/api/public/esign", createHostedEsignRouter({ service: context.service(), allowedOrigins: ["https://sign.example"], trustForwardedProto: true }));
    const protectedHeaders = { Origin: "https://sign.example", "X-Hosted-Signer-Request": "1" };
    await request(app).post("/api/public/esign/session").set(protectedHeaders).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(400);
    await request(app).post("/api/public/esign/session").set({ ...protectedHeaders, "X-Forwarded-Proto": "https" }).send({ workspaceId: context.workspace.id, sessionToken: context.token }).expect(200);
    await request(app).options("/api/public/esign/session").set({
      Origin: "https://sign.example",
      "X-Forwarded-Proto": "https",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, x-hosted-signer-request, authorization",
    }).expect(204).expect("Access-Control-Allow-Origin", "https://sign.example");
  });

  it("returns generic credential errors without echoing attacker-controlled secrets", async () => {
    const context = await fixture();
    const wrongToken = `esig_${"Y".repeat(43)}`;
    const response = await request(httpApp(context)).post("/api/public/esign/session")
      .set({ Origin: "https://sign.example", "X-Hosted-Signer-Request": "1" })
      .send({ workspaceId: context.workspace.id, sessionToken: wrongToken })
      .expect(401);
    expect(response.body).toEqual({ error: "invalid_or_expired_session", message: "The signer session is invalid or unavailable." });
    expect(response.text).not.toContain(wrongToken);
    expect(response.text).not.toContain(context.token);
  });
});
