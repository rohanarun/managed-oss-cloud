import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { SuiteRecord, SuiteWorkspace } from "../shared/suite.js";
import { executeEsignAction, type EsignAuthorization, type EsignExecutionResult } from "./esign-engine.js";
import type { SuiteStore } from "./suite-store.js";

const moduleId = "esign";
const signerTokenPattern = /^esig_[A-Za-z0-9_-]{40,100}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisionIdPattern = /^[A-Za-z0-9._:-]{16,200}$/;
const csrfHeaderValue = "1";
export const hostedEsignMaximumPdfBytes = 50 * 1024 * 1024;

export type HostedEsignOperation = "session" | "document" | "complete" | "decline";

export interface HostedEsignRateLimitRequest {
  operation: HostedEsignOperation;
  keys: string[];
  limit: number;
  windowMs: number;
  now: Date;
}

export interface HostedEsignRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface HostedEsignRateLimiter {
  consume(request: HostedEsignRateLimitRequest): Promise<HostedEsignRateLimitDecision>;
}

interface RateBucket {
  count: number;
  resetsAt: number;
}

export class InMemoryHostedEsignRateLimiter implements HostedEsignRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  async consume(request: HostedEsignRateLimitRequest): Promise<HostedEsignRateLimitDecision> {
    const now = request.now.getTime();
    const bucketIds = [...new Set(request.keys)].map((key) => `${request.operation}:${key}`);
    const buckets = bucketIds.map((id) => {
      const current = this.buckets.get(id);
      return current && current.resetsAt > now ? current : { count: 0, resetsAt: now + request.windowMs };
    });
    const rejected = buckets.find((bucket) => bucket.count >= request.limit);
    if (rejected) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((rejected.resetsAt - now) / 1_000)) };
    bucketIds.forEach((id, index) => this.buckets.set(id, { ...buckets[index], count: buckets[index].count + 1 }));
    return { allowed: true };
  }
}

export interface HostedEsignObjectRequest {
  workspaceId: string;
  ownerUserId: string;
  objectRef: string;
  objectVersion: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  expectedContentType: "application/pdf";
}

export interface HostedEsignLoadedObject {
  bytes: Uint8Array;
  objectVersion: string;
  contentType: string;
  sourceSha256: string;
  safetyProfile: "sanitized-static-pdf.v1";
}

export interface HostedEsignObjectLoader {
  loadExactPdf(request: HostedEsignObjectRequest): Promise<HostedEsignLoadedObject>;
}

export interface HostedEsignRatePolicy {
  limit: number;
  windowMs: number;
}

export interface HostedEsignServiceOptions {
  store: SuiteStore;
  objectLoader: HostedEsignObjectLoader;
  now?: () => Date;
  rateLimiter?: HostedEsignRateLimiter;
  ratePolicies?: Partial<Record<HostedEsignOperation, HostedEsignRatePolicy>>;
  modelPolicyId?: string;
  maximumPdfBytes?: number;
}

export interface HostedEsignCredentialInput {
  workspaceId: string;
  sessionToken: string;
  clientKey: string;
}

export interface HostedEsignSessionView {
  schema: "hosted-esign-session.v1";
  workspaceId: string;
  envelopeId: string;
  envelopeVersion: number;
  envelopeDraftHash: string;
  sessionId: string;
  sessionVersion: number;
  signerId: string;
  signerRole: string;
  expiresAt: string;
  title: string;
  message: string;
  disclosure: string;
  disclosureHash: string;
  instructions: string;
  boundaryHash: string;
  document: {
    title: string;
    contentType: "application/pdf";
    sizeBytes: number;
    pageCount: number;
    sha256: string;
    objectVersion: string;
    protectedEndpoint: "./document";
  };
  fields: Array<{
    fieldId: string;
    kind: "signature" | "initials" | "text" | "date" | "checkbox";
    page: number;
    xBasisPoints: number;
    yBasisPoints: number;
    widthBasisPoints: number;
    heightBasisPoints: number;
    required: boolean;
    label?: string;
  }>;
  choices: {
    complete: "complete";
    decline: "decline";
    explicitChoiceRequired: true;
  };
  claims: {
    identityAssurance: "not-assessed";
    legalComplianceCertified: false;
    qualifiedSignatureClaimed: false;
  };
}

export interface HostedEsignPdfResult {
  bytes: Uint8Array;
  contentType: "application/pdf";
  sizeBytes: number;
  sha256: string;
  objectVersion: string;
  safetyProfile: "sanitized-static-pdf.v1";
}

export interface HostedEsignFieldFact {
  fieldId: string;
  valueHash: string;
  completedAt: string;
  method: "typed-name" | "drawn-mark" | "typed-text" | "selected-checkbox" | "entered-date";
}

export interface HostedEsignCompleteInput extends HostedEsignCredentialInput {
  decision: "complete";
  reviewedDisclosure: true;
  disclosureHash: string;
  boundaryHash: string;
  expectedEnvelopeVersion: number;
  expectedSessionVersion: number;
  decisionId: string;
  decidedAt: string;
  fieldFacts: HostedEsignFieldFact[];
}

export interface HostedEsignDeclineInput extends HostedEsignCredentialInput {
  decision: "decline";
  reviewedDisclosure: true;
  disclosureHash: string;
  boundaryHash: string;
  expectedEnvelopeVersion: number;
  expectedSessionVersion: number;
  decisionId: string;
  decidedAt: string;
  reason: string;
}

export interface HostedEsignDecisionResult {
  schema: "hosted-esign-decision.v1";
  decision: "complete" | "decline";
  envelopeId: string;
  sessionId: string;
  envelopeState: string;
  receiptId: string;
  recordedAt: string;
  identityAssurance: "not-assessed";
  legalComplianceCertified: false;
}

export type HostedEsignErrorCode =
  | "request_rejected"
  | "invalid_or_expired_session"
  | "rate_limited"
  | "boundary_mismatch"
  | "document_unavailable"
  | "decision_conflict";

export class HostedEsignError extends Error {
  constructor(
    readonly code: HostedEsignErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HostedEsignError";
  }
}

interface ResolvedHostedBoundary {
  workspace: SuiteWorkspace;
  auth: EsignAuthorization;
  sessionToken: string;
  session: SuiteRecord;
  envelope: SuiteRecord;
  templateVersion: SuiteRecord;
  document: SuiteRecord;
  signer: Record<string, unknown>;
  fields: Array<Record<string, unknown>>;
  disclosureHash: string;
  boundaryHash: string;
  terminalReplayCandidate: boolean;
}

const defaultRatePolicies: Record<HostedEsignOperation, HostedEsignRatePolicy> = {
  session: { limit: 30, windowMs: 60_000 },
  document: { limit: 60, windowMs: 60_000 },
  complete: { limit: 8, windowMs: 60_000 },
  decline: { limit: 8, windowMs: 60_000 },
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function hashSecret(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeHashMatch(left: unknown, right: string) {
  if (typeof left !== "string" || !sha256Pattern.test(left)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function object(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostedEsignError("boundary_mismatch", 409, `${label} is malformed.`);
  return value as Record<string, unknown>;
}

function exactRecord(record: SuiteRecord | undefined, workspaceId: string, recordType: string) {
  if (!record || record.workspaceId !== workspaceId || record.moduleId !== moduleId || record.recordType !== recordType) {
    throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
  }
  return record;
}

function positiveVersion(record: SuiteRecord) {
  const value = Number(record.data.version ?? 1);
  if (!Number.isSafeInteger(value) || value < 1) throw new HostedEsignError("boundary_mismatch", 409, "A stored workflow version is malformed.");
  return value;
}

function requiredString(value: unknown, label: string, maximum = 20_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new HostedEsignError("request_rejected", 400, `${label} is invalid.`);
  return value;
}

function requiredInteger(value: unknown, label: string, maximum = 1_000_000) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new HostedEsignError("request_rejected", 400, `${label} is invalid.`);
  return Number(value);
}

function strictInput(value: unknown, allowed: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostedEsignError("request_rejected", 400, "The request body must be a JSON object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HostedEsignError("request_rejected", 400, "The request body contains an unsupported field.");
  return input;
}

function sameCanonical(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function arrayOfObjects(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new HostedEsignError("boundary_mismatch", 409, `${label} is malformed.`);
  return value.map((item) => object(item, label));
}

function isoDate(value: unknown, label: string) {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new HostedEsignError("boundary_mismatch", 409, `${label} is malformed.`);
  return parsed;
}

function validateFieldFacts(value: unknown): HostedEsignFieldFact[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new HostedEsignError("request_rejected", 400, "fieldFacts must contain one to two hundred facts.");
  const facts = value.map((candidate) => {
    const fact = strictInput(candidate, ["fieldId", "valueHash", "completedAt", "method"]);
    if (typeof fact.fieldId !== "string" || !uuidPattern.test(fact.fieldId)) throw new HostedEsignError("request_rejected", 400, "A field fact ID is invalid.");
    if (typeof fact.valueHash !== "string" || !sha256Pattern.test(fact.valueHash)) throw new HostedEsignError("request_rejected", 400, "A field fact value hash is invalid.");
    if (typeof fact.completedAt !== "string" || !Number.isFinite(new Date(fact.completedAt).getTime())) throw new HostedEsignError("request_rejected", 400, "A field fact clock is invalid.");
    if (!(["typed-name", "drawn-mark", "typed-text", "selected-checkbox", "entered-date"] as unknown[]).includes(fact.method)) throw new HostedEsignError("request_rejected", 400, "A field fact method is invalid.");
    return fact as unknown as HostedEsignFieldFact;
  });
  if (new Set(facts.map((fact) => fact.fieldId)).size !== facts.length) throw new HostedEsignError("request_rejected", 400, "A field can appear only once.");
  return facts;
}

function decisionReceiptId(result: EsignExecutionResult) {
  if (typeof result.audit.receiptId !== "string" || !result.audit.receiptId) throw new HostedEsignError("decision_conflict", 409, "The workflow receipt was not recorded.");
  return result.audit.receiptId;
}

function decisionState(result: EsignExecutionResult) {
  return result.records.find((record) => record.recordType === "envelope")?.state ?? "recorded";
}

export class HostedEsignService {
  private readonly store: SuiteStore;
  private readonly objectLoader: HostedEsignObjectLoader;
  private readonly now: () => Date;
  private readonly rateLimiter: HostedEsignRateLimiter;
  private readonly ratePolicies: Record<HostedEsignOperation, HostedEsignRatePolicy>;
  private readonly modelPolicyId: string;
  private readonly maximumPdfBytes: number;

  constructor(options: HostedEsignServiceOptions) {
    this.store = options.store;
    this.objectLoader = options.objectLoader;
    this.now = options.now ?? (() => new Date());
    this.rateLimiter = options.rateLimiter ?? new InMemoryHostedEsignRateLimiter();
    this.ratePolicies = { ...defaultRatePolicies, ...options.ratePolicies };
    for (const [operation, policy] of Object.entries(this.ratePolicies)) {
      if (!Number.isSafeInteger(policy.limit) || policy.limit < 1 || !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1_000) throw new Error(`The ${operation} hosted signer rate policy is invalid.`);
    }
    this.modelPolicyId = options.modelPolicyId ?? "hosted-esign-no-ai";
    this.maximumPdfBytes = options.maximumPdfBytes ?? hostedEsignMaximumPdfBytes;
    if (!Number.isSafeInteger(this.maximumPdfBytes) || this.maximumPdfBytes < 1 || this.maximumPdfBytes > hostedEsignMaximumPdfBytes) throw new Error(`Hosted signer PDF bytes must be between 1 and ${hostedEsignMaximumPdfBytes}.`);
  }

  private async resolve(input: HostedEsignCredentialInput, operation: HostedEsignOperation): Promise<ResolvedHostedBoundary> {
    const tokenHash = hashSecret(String(input.sessionToken ?? ""));
    if (typeof input.sessionToken !== "string" || !signerTokenPattern.test(input.sessionToken)) throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
    const workspaceId = requiredString(input.workspaceId, "workspaceId", 100);
    if (!uuidPattern.test(workspaceId)) throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
    const policy = this.ratePolicies[operation];
    const clientHash = hashSecret(`hosted-esign-client.v1:${String(input.clientKey ?? "unknown")}`);
    const decision = await this.rateLimiter.consume({ operation, keys: [`client:${clientHash}`, `credential:${hashSecret(tokenHash)}`], limit: policy.limit, windowMs: policy.windowMs, now: this.now() });
    if (!decision.allowed) throw new HostedEsignError("rate_limited", 429, "Too many signer requests. Try again later.", decision.retryAfterSeconds);

    const workspace = await this.store.getWorkspaceByPublicId(workspaceId);
    if (!workspace || workspace.id !== workspaceId || workspace.plan === "none" || !workspace.enabledModuleIds.includes(moduleId)) throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
    const session = await this.store.findSignerSessionByTokenHash(workspace.userId, tokenHash);
    if (!session || session.workspaceId !== workspace.id || !constantTimeHashMatch(session.data.tokenHash, tokenHash)) throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
    const now = this.now();
    const envelope = exactRecord(await this.store.getRecord(workspace.userId, String(session.data.envelopeId)), workspace.id, "envelope");
    const sessionIssuedAt = isoDate(session.data.issuedAt, "session issue clock");
    const sessionExpiresAt = isoDate(session.data.expiresAt, "session expiry");
    const envelopeExpiresAt = isoDate(envelope.data.expiresAt, "envelope expiry");
    const activeBoundary = session.state === "active" && sessionExpiresAt.getTime() > now.getTime() && envelope.state === "in-progress" && envelopeExpiresAt.getTime() > now.getTime();
    const terminalReplayCandidate = (operation === "complete" && session.state === "completed" && ["in-progress", "completed", "declined", "voided"].includes(envelope.state))
      || (operation === "decline" && session.state === "declined" && envelope.state === "declined");
    if ((!activeBoundary && !terminalReplayCandidate) || sessionIssuedAt.getTime() > now.getTime() + 5 * 60_000 || sessionExpiresAt.getTime() > envelopeExpiresAt.getTime()) throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
    const templateVersion = exactRecord(await this.store.getRecord(workspace.userId, String(envelope.data.templateVersionId)), workspace.id, "template-version");
    const document = exactRecord(await this.store.getRecord(workspace.userId, String(envelope.data.documentId)), workspace.id, "document");
    if (templateVersion.state !== "immutable" || document.state !== "immutable") throw new HostedEsignError("boundary_mismatch", 409, "The immutable document boundary is unavailable.");

    const signers = arrayOfObjects(envelope.data.signers, "envelope signers");
    const signer = signers.find((candidate) => candidate.signerId === session.data.signerId);
    if (!signer || signer.signerKeyHash !== session.data.signerKeyHash || signer.role !== session.data.role || signer.order !== session.data.routeOrder) throw new HostedEsignError("boundary_mismatch", 409, "The signer route boundary changed.");
    const fields = arrayOfObjects(envelope.data.fields, "envelope fields");
    const templateFields = arrayOfObjects(templateVersion.data.fields, "template fields");
    if (!sameCanonical(fields, templateFields)) throw new HostedEsignError("boundary_mismatch", 409, "The field snapshot does not match the immutable template.");
    const disclosure = requiredString(envelope.data.disclosure, "stored disclosure", 10_000);
    if (templateVersion.data.disclosure !== disclosure) throw new HostedEsignError("boundary_mismatch", 409, "The disclosure does not match the immutable template.");

    const templateSnapshot = {
      templateId: templateVersion.data.templateId,
      templateVersion: templateVersion.data.templateVersion,
      signerRoles: templateVersion.data.signerRoles,
      fields: templateVersion.data.fields,
      disclosure: templateVersion.data.disclosure,
      instructions: templateVersion.data.instructions ?? "",
    };
    const templateContentHash = digest(templateSnapshot);
    if (!sha256Pattern.test(String(templateVersion.data.contentHash)) || templateContentHash !== templateVersion.data.contentHash || templateContentHash !== envelope.data.templateContentHash) throw new HostedEsignError("boundary_mismatch", 409, "The template content hash does not match.");

    const registrationSnapshot = {
      objectRef: document.data.objectRef,
      objectVersion: document.data.objectVersion,
      sha256: document.data.sha256,
      sizeBytes: document.data.sizeBytes,
      contentType: document.data.contentType,
      pageCount: document.data.pageCount,
    };
    if (document.data.registrationHash !== digest(registrationSnapshot) || document.data.sha256 !== envelope.data.documentHash || document.data.objectVersion !== envelope.data.documentObjectVersion || document.data.contentType !== "application/pdf") throw new HostedEsignError("boundary_mismatch", 409, "The document object boundary does not match.");

    const envelopeSnapshot = {
      templateVersionId: templateVersion.id,
      templateContentHash,
      documentId: document.id,
      documentHash: document.data.sha256,
      documentObjectVersion: document.data.objectVersion,
      signers,
      fields,
      disclosure,
      expiresAt: envelope.data.expiresAt,
      message: envelope.data.message ?? "",
    };
    const envelopeDraftHash = digest(envelopeSnapshot);
    if (envelopeDraftHash !== envelope.data.envelopeDraftHash) throw new HostedEsignError("boundary_mismatch", 409, "The envelope content hash does not match.");
    const auth: EsignAuthorization = { userId: workspace.userId, workspaceId: workspace.id, role: "owner", scopes: ["esign:external"] };
    const disclosureHash = hashSecret(disclosure);
    const boundaryHash = digest({
      workspaceId: workspace.id,
      envelopeId: envelope.id,
      envelopeVersion: positiveVersion(envelope),
      envelopeDraftHash,
      templateVersionId: templateVersion.id,
      templateContentHash,
      documentId: document.id,
      documentHash: document.data.sha256,
      documentObjectVersion: document.data.objectVersion,
      documentRegistrationHash: document.data.registrationHash,
      sessionId: session.id,
      sessionVersion: positiveVersion(session),
      sessionIssuedAt: session.data.issuedAt,
      sessionExpiresAt: session.data.expiresAt,
      sessionTokenHash: session.data.tokenHash,
      signerId: session.data.signerId,
      signerKeyHash: session.data.signerKeyHash,
      signerRole: session.data.role,
      disclosureHash,
    });
    return { workspace, auth, sessionToken: input.sessionToken, session, envelope, templateVersion, document, signer, fields, disclosureHash, boundaryHash, terminalReplayCandidate };
  }

  private assertClientBoundary(boundary: ResolvedHostedBoundary, input: { disclosureHash: string; boundaryHash: string; expectedEnvelopeVersion: number; expectedSessionVersion: number }) {
    if (typeof input.disclosureHash !== "string" || input.disclosureHash !== boundary.disclosureHash || typeof input.boundaryHash !== "string" || !sha256Pattern.test(input.boundaryHash)) throw new HostedEsignError("boundary_mismatch", 409, "The signer view is stale. Reload the exact document and disclosure.");
    const envelopeVersion = requiredInteger(input.expectedEnvelopeVersion, "expectedEnvelopeVersion");
    const sessionVersion = requiredInteger(input.expectedSessionVersion, "expectedSessionVersion");
    if (!boundary.terminalReplayCandidate && (input.boundaryHash !== boundary.boundaryHash || envelopeVersion !== positiveVersion(boundary.envelope) || sessionVersion !== positiveVersion(boundary.session))) throw new HostedEsignError("boundary_mismatch", 409, "The signer workflow version is stale.");
  }

  private clientDecisionClock(boundary: ResolvedHostedBoundary, value: unknown) {
    if (typeof value !== "string") throw new HostedEsignError("request_rejected", 400, "decidedAt is invalid.");
    const decidedAt = new Date(value);
    const issuedAt = isoDate(boundary.session.data.issuedAt, "session issue clock");
    const expiresAt = isoDate(boundary.session.data.expiresAt, "session expiry");
    if (!Number.isFinite(decidedAt.getTime()) || decidedAt.getTime() < issuedAt.getTime() || decidedAt.getTime() > expiresAt.getTime() || decidedAt.getTime() > this.now().getTime() + 5 * 60_000) throw new HostedEsignError("request_rejected", 400, "decidedAt must occur during the signer session and not in the future.");
    return decidedAt.toISOString();
  }

  private async decisionResult(boundary: ResolvedHostedBoundary, decision: HostedEsignDecisionResult["decision"], result: EsignExecutionResult): Promise<HostedEsignDecisionResult> {
    const receiptId = decisionReceiptId(result);
    const receipt = await this.store.getRecord(boundary.workspace.userId, receiptId);
    if (!receipt || receipt.workspaceId !== boundary.workspace.id || receipt.moduleId !== moduleId || receipt.recordType !== "esign-command-receipt") throw new HostedEsignError("decision_conflict", 409, "The workflow receipt could not be verified.");
    return { schema: "hosted-esign-decision.v1", decision, envelopeId: boundary.envelope.id, sessionId: boundary.session.id, envelopeState: decisionState(result), receiptId, recordedAt: receipt.createdAt, identityAssurance: "not-assessed", legalComplianceCertified: false };
  }

  private async verifiedPdf(boundary: ResolvedHostedBoundary): Promise<HostedEsignPdfResult> {
    const expectedSizeBytes = requiredInteger(boundary.document.data.sizeBytes, "document size", 10_000_000_000);
    if (expectedSizeBytes > this.maximumPdfBytes) throw new HostedEsignError("document_unavailable", 413, `Hosted signer PDFs cannot exceed ${this.maximumPdfBytes} bytes.`);
    let loaded: HostedEsignLoadedObject;
    try {
      loaded = await this.objectLoader.loadExactPdf({
        workspaceId: boundary.workspace.id,
        ownerUserId: boundary.workspace.userId,
        objectRef: requiredString(boundary.document.data.objectRef, "objectRef", 512),
        objectVersion: requiredString(boundary.document.data.objectVersion, "objectVersion", 200),
        expectedSha256: requiredString(boundary.document.data.sha256, "document sha256", 64),
        expectedSizeBytes,
        expectedContentType: "application/pdf",
      });
    } catch (error) {
      if (error instanceof HostedEsignError) throw error;
      throw new HostedEsignError("document_unavailable", 503, "The exact document is temporarily unavailable.");
    }
    if (!loaded.bytes || !Number.isSafeInteger(loaded.bytes.byteLength) || loaded.bytes.byteLength > this.maximumPdfBytes) throw new HostedEsignError("document_unavailable", 413, `Hosted signer PDFs cannot exceed ${this.maximumPdfBytes} bytes.`);
    const bytes = Buffer.from(loaded.bytes);
    const computedHash = createHash("sha256").update(bytes).digest("hex");
    const expectedHash = String(boundary.document.data.sha256);
    const expectedSize = Number(boundary.document.data.sizeBytes);
    if (
      loaded.contentType !== "application/pdf"
      || loaded.objectVersion !== boundary.document.data.objectVersion
      || loaded.sourceSha256 !== expectedHash
      || loaded.safetyProfile !== "sanitized-static-pdf.v1"
      || bytes.byteLength !== expectedSize
      || computedHash !== expectedHash
      || bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    ) throw new HostedEsignError("document_unavailable", 409, "The loaded document does not match the registered render-safe object.");
    return { bytes, contentType: "application/pdf", sizeBytes: bytes.byteLength, sha256: computedHash, objectVersion: loaded.objectVersion, safetyProfile: "sanitized-static-pdf.v1" };
  }

  async openSession(input: HostedEsignCredentialInput): Promise<HostedEsignSessionView> {
    const boundary = await this.resolve(input, "session");
    const assigned = boundary.fields.filter((field) => field.signerRole === boundary.signer.role).map((field) => ({
      fieldId: String(field.fieldId),
      kind: field.kind as HostedEsignSessionView["fields"][number]["kind"],
      page: Number(field.page),
      xBasisPoints: Number(field.xBasisPoints),
      yBasisPoints: Number(field.yBasisPoints),
      widthBasisPoints: Number(field.widthBasisPoints),
      heightBasisPoints: Number(field.heightBasisPoints),
      required: field.required === true,
      ...(typeof field.label === "string" && field.label ? { label: field.label } : {}),
    }));
    return {
      schema: "hosted-esign-session.v1",
      workspaceId: boundary.workspace.id,
      envelopeId: boundary.envelope.id,
      envelopeVersion: positiveVersion(boundary.envelope),
      envelopeDraftHash: String(boundary.envelope.data.envelopeDraftHash),
      sessionId: boundary.session.id,
      sessionVersion: positiveVersion(boundary.session),
      signerId: String(boundary.session.data.signerId),
      signerRole: String(boundary.signer.role),
      expiresAt: String(boundary.session.data.expiresAt),
      title: boundary.envelope.title,
      message: String(boundary.envelope.data.message ?? ""),
      disclosure: String(boundary.envelope.data.disclosure),
      disclosureHash: boundary.disclosureHash,
      instructions: String(boundary.templateVersion.data.instructions ?? ""),
      boundaryHash: boundary.boundaryHash,
      document: {
        title: boundary.document.title,
        contentType: "application/pdf",
        sizeBytes: Number(boundary.document.data.sizeBytes),
        pageCount: Number(boundary.document.data.pageCount),
        sha256: String(boundary.document.data.sha256),
        objectVersion: String(boundary.document.data.objectVersion),
        protectedEndpoint: "./document",
      },
      fields: assigned,
      choices: { complete: "complete", decline: "decline", explicitChoiceRequired: true },
      claims: { identityAssurance: "not-assessed", legalComplianceCertified: false, qualifiedSignatureClaimed: false },
    };
  }

  async loadDocument(input: HostedEsignCredentialInput): Promise<HostedEsignPdfResult> {
    return this.verifiedPdf(await this.resolve(input, "document"));
  }

  async complete(input: HostedEsignCompleteInput): Promise<HostedEsignDecisionResult> {
    if (input.decision !== "complete" || input.reviewedDisclosure !== true || !decisionIdPattern.test(String(input.decisionId ?? ""))) throw new HostedEsignError("request_rejected", 400, "An explicit complete decision and unique decision ID are required.");
    const boundary = await this.resolve(input, "complete");
    this.assertClientBoundary(boundary, input);
    const decidedAt = this.clientDecisionClock(boundary, input.decidedAt);
    const fieldFacts = validateFieldFacts(input.fieldFacts);
    if (!boundary.terminalReplayCandidate) await this.verifiedPdf(boundary);
    let result: EsignExecutionResult;
    try {
      result = await executeEsignAction(this.store, boundary.auth, moduleId, "field-completion-record", {
        envelopeId: boundary.envelope.id,
        signerId: boundary.session.data.signerId,
        sessionToken: boundary.sessionToken,
        expectedEnvelopeVersion: input.expectedEnvelopeVersion,
        expectedSessionVersion: input.expectedSessionVersion,
        fieldFacts,
        dryRun: false,
        approval: {
          approved: true,
          approvedBy: boundary.auth.userId,
          approvedAt: decidedAt,
          decisionId: input.decisionId,
          reason: `Hosted signer explicitly selected complete after reviewing disclosure ${input.disclosureHash} and boundary ${input.boundaryHash}.`,
        },
        idempotencyKey: `hosted.complete.${digest({ workspaceId: boundary.workspace.id, sessionId: boundary.session.id, decisionId: input.decisionId }).slice(0, 48)}`,
      }, { now: this.now, modelPolicyId: this.modelPolicyId });
    } catch {
      throw new HostedEsignError("decision_conflict", 409, "The complete decision could not be recorded against the exact current workflow.");
    }
    return this.decisionResult(boundary, "complete", result);
  }

  async decline(input: HostedEsignDeclineInput): Promise<HostedEsignDecisionResult> {
    if (input.decision !== "decline" || input.reviewedDisclosure !== true || !decisionIdPattern.test(String(input.decisionId ?? ""))) throw new HostedEsignError("request_rejected", 400, "An explicit decline decision and unique decision ID are required.");
    const reason = requiredString(input.reason, "reason", 2_000).trim();
    const boundary = await this.resolve(input, "decline");
    this.assertClientBoundary(boundary, input);
    const decidedAt = this.clientDecisionClock(boundary, input.decidedAt);
    let result: EsignExecutionResult;
    try {
      result = await executeEsignAction(this.store, boundary.auth, moduleId, "decline-record", {
        envelopeId: boundary.envelope.id,
        signerId: boundary.session.data.signerId,
        sessionToken: boundary.sessionToken,
        expectedEnvelopeVersion: input.expectedEnvelopeVersion,
        expectedSessionVersion: input.expectedSessionVersion,
        reason,
        dryRun: false,
        approval: {
          approved: true,
          approvedBy: boundary.auth.userId,
          approvedAt: decidedAt,
          decisionId: input.decisionId,
          reason: `Hosted signer explicitly selected decline after reviewing disclosure ${input.disclosureHash} and boundary ${input.boundaryHash}.`,
        },
        idempotencyKey: `hosted.decline.${digest({ workspaceId: boundary.workspace.id, sessionId: boundary.session.id, decisionId: input.decisionId }).slice(0, 48)}`,
      }, { now: this.now, modelPolicyId: this.modelPolicyId });
    } catch {
      throw new HostedEsignError("decision_conflict", 409, "The decline decision could not be recorded against the exact current workflow.");
    }
    return this.decisionResult(boundary, "decline", result);
  }
}

export interface HostedEsignRequestSecurityOptions {
  allowedOrigins: readonly string[];
  requireTls?: boolean;
  trustForwardedProto?: boolean;
}

export interface HostedEsignRouterOptions extends HostedEsignRequestSecurityOptions {
  service: HostedEsignService;
  clientKey?: (request: Request) => string;
}

export const hostedEsignSecurityHeaders = Object.freeze({
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
});

export function applyHostedEsignSecurityHeaders(response: Response, origin?: string) {
  for (const [name, value] of Object.entries(hostedEsignSecurityHeaders)) response.setHeader(name, value);
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Hosted-Signer-Request");
  response.vary("Origin");
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
}

function canonicalOrigin(value: string) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid origin");
  return parsed.origin;
}

export function assertHostedEsignRequestSecurity(request: Request, options: HostedEsignRequestSecurityOptions) {
  if (Object.keys(request.query).length > 0) throw new HostedEsignError("request_rejected", 400, "Hosted signer endpoints do not accept query parameters.");
  if (request.get("cookie")) throw new HostedEsignError("request_rejected", 400, "Hosted signer endpoints do not use ambient cookies.");
  const requireTls = options.requireTls ?? true;
  const forwarded = request.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const secure = request.secure || (options.trustForwardedProto === true && forwarded === "https");
  if (requireTls && !secure) throw new HostedEsignError("request_rejected", 400, "A protected HTTPS transport is required.");
  if (!request.is("application/json")) throw new HostedEsignError("request_rejected", 415, "Hosted signer requests require application/json.");
  if (request.get("x-hosted-signer-request") !== csrfHeaderValue) throw new HostedEsignError("request_rejected", 403, "The hosted signer CSRF preflight header is required.");
  const suppliedOrigin = request.get("origin");
  if (!suppliedOrigin) throw new HostedEsignError("request_rejected", 403, "An explicit approved origin is required.");
  let origin: string;
  let allowed: Set<string>;
  try {
    origin = canonicalOrigin(suppliedOrigin);
    allowed = new Set(options.allowedOrigins.map(canonicalOrigin));
  } catch {
    throw new HostedEsignError("request_rejected", 403, "The request origin is invalid.");
  }
  if (!allowed.has(origin)) throw new HostedEsignError("request_rejected", 403, "The request origin is not approved.");
  return origin;
}

function credentialFromRequest(request: Request, body: Record<string, unknown>) {
  const bodyToken = typeof body.sessionToken === "string" ? body.sessionToken : undefined;
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Bearer (esig_[A-Za-z0-9_-]{40,100})$/);
  if (authorization && !match) throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
  if (bodyToken && match) throw new HostedEsignError("request_rejected", 400, "Supply the signer credential in exactly one protected location.");
  const sessionToken = bodyToken ?? match?.[1] ?? "";
  hashSecret(sessionToken);
  if (!signerTokenPattern.test(sessionToken)) throw new HostedEsignError("invalid_or_expired_session", 401, "The signer session is invalid or unavailable.");
  return sessionToken;
}

function untrustedRequestBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostedEsignError("request_rejected", 400, "The request body must be a JSON object.");
  return value as Record<string, unknown>;
}

function clientKey(request: Request, resolver?: (request: Request) => string) {
  const resolved = resolver?.(request) ?? request.socket.remoteAddress ?? "unknown";
  return hashSecret(`hosted-esign-http-client.v1:${resolved}`);
}

function publicError(error: unknown) {
  if (error instanceof HostedEsignError) return error;
  return new HostedEsignError("request_rejected", 400, "The hosted signer request could not be processed.");
}

function handle(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => handler(request, response).catch(next);
}

export function createHostedEsignRouter(options: HostedEsignRouterOptions): Router {
  if (!options.allowedOrigins.length) throw new Error("At least one exact hosted signer origin is required.");
  const router = express.Router();
  router.use(express.json({ limit: "256kb", strict: true, type: "application/json" }));
  router.use((request, response, next) => {
    applyHostedEsignSecurityHeaders(response);
    next();
  });

  for (const route of ["/session", "/document", "/complete", "/decline"]) {
    router.options(route, (request, response, next) => {
      try {
        const requireTls = options.requireTls ?? true;
        const forwarded = request.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
        const secure = request.secure || (options.trustForwardedProto === true && forwarded === "https");
        if (requireTls && !secure) throw new HostedEsignError("request_rejected", 400, "A protected HTTPS transport is required.");
        const origin = request.get("origin");
        if (!origin || !new Set(options.allowedOrigins.map(canonicalOrigin)).has(canonicalOrigin(origin))) throw new HostedEsignError("request_rejected", 403, "The request origin is not approved.");
        if (request.get("access-control-request-method")?.toUpperCase() !== "POST") throw new HostedEsignError("request_rejected", 403, "Only POST signer requests are approved.");
        const requestedHeaders = new Set((request.get("access-control-request-headers") ?? "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean));
        if (!requestedHeaders.has("content-type") || !requestedHeaders.has("x-hosted-signer-request")) throw new HostedEsignError("request_rejected", 403, "The signer preflight is missing required protected headers.");
        applyHostedEsignSecurityHeaders(response, canonicalOrigin(origin));
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });
  }

  router.post("/session", handle(async (request, response) => {
    const origin = assertHostedEsignRequestSecurity(request, options);
    applyHostedEsignSecurityHeaders(response, origin);
    const untrustedBody = untrustedRequestBody(request.body);
    const sessionToken = credentialFromRequest(request, untrustedBody);
    const body = strictInput(untrustedBody, ["workspaceId", "sessionToken"]);
    const result = await options.service.openSession({ workspaceId: String(body.workspaceId ?? ""), sessionToken, clientKey: clientKey(request, options.clientKey) });
    response.status(200).json(result);
  }));

  router.post("/document", handle(async (request, response) => {
    const origin = assertHostedEsignRequestSecurity(request, options);
    applyHostedEsignSecurityHeaders(response, origin);
    const untrustedBody = untrustedRequestBody(request.body);
    const sessionToken = credentialFromRequest(request, untrustedBody);
    const body = strictInput(untrustedBody, ["workspaceId", "sessionToken"]);
    const result = await options.service.loadDocument({ workspaceId: String(body.workspaceId ?? ""), sessionToken, clientKey: clientKey(request, options.clientKey) });
    response.setHeader("Content-Type", result.contentType);
    response.setHeader("Content-Length", String(result.sizeBytes));
    response.setHeader("Content-Disposition", "inline; filename=\"agreement.pdf\"");
    response.setHeader("X-Content-SHA256", result.sha256);
    response.setHeader("X-Object-Version", result.objectVersion);
    response.status(200).send(Buffer.from(result.bytes));
  }));

  router.post("/complete", handle(async (request, response) => {
    const origin = assertHostedEsignRequestSecurity(request, options);
    applyHostedEsignSecurityHeaders(response, origin);
    const untrustedBody = untrustedRequestBody(request.body);
    const sessionToken = credentialFromRequest(request, untrustedBody);
    const body = strictInput(untrustedBody, ["workspaceId", "sessionToken", "decision", "reviewedDisclosure", "disclosureHash", "boundaryHash", "expectedEnvelopeVersion", "expectedSessionVersion", "decisionId", "decidedAt", "fieldFacts"]);
    const result = await options.service.complete({ ...body, workspaceId: String(body.workspaceId ?? ""), sessionToken, clientKey: clientKey(request, options.clientKey) } as unknown as HostedEsignCompleteInput);
    response.status(200).json(result);
  }));

  router.post("/decline", handle(async (request, response) => {
    const origin = assertHostedEsignRequestSecurity(request, options);
    applyHostedEsignSecurityHeaders(response, origin);
    const untrustedBody = untrustedRequestBody(request.body);
    const sessionToken = credentialFromRequest(request, untrustedBody);
    const body = strictInput(untrustedBody, ["workspaceId", "sessionToken", "decision", "reviewedDisclosure", "disclosureHash", "boundaryHash", "expectedEnvelopeVersion", "expectedSessionVersion", "decisionId", "decidedAt", "reason"]);
    const result = await options.service.decline({ ...body, workspaceId: String(body.workspaceId ?? ""), sessionToken, clientKey: clientKey(request, options.clientKey) } as unknown as HostedEsignDeclineInput);
    response.status(200).json(result);
  }));

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const safe = publicError(error);
    if (safe.retryAfterSeconds) response.setHeader("Retry-After", String(safe.retryAfterSeconds));
    response.status(safe.status).json({ error: safe.code, message: safe.message });
  });
  return router;
}

export function hostedEsignMountContract() {
  return {
    version: "hosted-esign-mount.v1",
    mountPath: "/api/public/esign",
    methods: {
      session: "POST /session",
      document: "POST /document",
      complete: "POST /complete",
      decline: "POST /decline",
    },
    credentialLocations: ["Authorization: Bearer <opaque signer token>", "JSON body sessionToken"],
    forbiddenCredentialLocations: ["query", "path", "cookie", "log"],
    requiredRequestHeaders: { "Content-Type": "application/json", "X-Hosted-Signer-Request": csrfHeaderValue, Origin: "exact configured signer origin" },
    storeRequirements: ["getWorkspaceByPublicId", "findSignerSessionByTokenHash", "getRecord", "runInWorkspaceTransaction", "createRecord", "updateRecord"],
    objectLoaderRequirement: "loadExactPdf must return the exact registered object version and SHA-256 under sanitized-static-pdf.v1",
    maximumPdfBytes: hostedEsignMaximumPdfBytes,
    signerSessionLookup: "exact indexed tokenHash lookup",
    autonomousAiAllowed: false,
    legalComplianceCertified: false,
  } as const;
}
