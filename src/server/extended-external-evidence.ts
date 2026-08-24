import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ExtendedBusinessEngineDependencies,
  ExtendedExternalEvidenceKind,
  ExtendedExternalEvidenceRequest,
} from "./extended-business-engine.js";

const attestationVersion = "extended-external-evidence-attestation.v1" as const;
const maximumAttestationLifetimeMilliseconds = 24 * 60 * 60 * 1_000;
const safeIdentifier = /^[A-Za-z0-9._:/-]{2,240}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const evidenceKinds = new Set<ExtendedExternalEvidenceKind>([
  "event-payment",
  "event-refund",
  "event-check-in",
  "people-access-revocation",
  "metering-usage-event",
  "metering-invoice-payment",
]);

export interface ExtendedExternalEvidenceAttestationClaims {
  version: typeof attestationVersion;
  kind: ExtendedExternalEvidenceKind;
  workspaceId: string;
  actorUserId: string;
  moduleId: string;
  actionId: string;
  evidenceHash: string;
  verifierId: string;
  verificationId: string;
  verifiedAt: string;
  expiresAt: string;
}

export type ExtendedExternalEvidenceAttestationInput = Omit<ExtendedExternalEvidenceAttestationClaims, "version">;

function time(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return Number.NaN;
  return new Date(value).getTime();
}

function validClaims(value: unknown): value is ExtendedExternalEvidenceAttestationClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  if (Object.keys(claims).sort().join("|") !== ["actionId", "actorUserId", "evidenceHash", "expiresAt", "kind", "moduleId", "verificationId", "verifiedAt", "verifierId", "version", "workspaceId"].sort().join("|")) return false;
  const verifiedAt = time(claims.verifiedAt);
  const expiresAt = time(claims.expiresAt);
  return claims.version === attestationVersion
    && typeof claims.kind === "string" && evidenceKinds.has(claims.kind as ExtendedExternalEvidenceKind)
    && typeof claims.workspaceId === "string" && uuid.test(claims.workspaceId)
    && typeof claims.actorUserId === "string" && uuid.test(claims.actorUserId)
    && typeof claims.moduleId === "string" && safeIdentifier.test(claims.moduleId)
    && typeof claims.actionId === "string" && safeIdentifier.test(claims.actionId)
    && typeof claims.evidenceHash === "string" && digest.test(claims.evidenceHash)
    && typeof claims.verifierId === "string" && safeIdentifier.test(claims.verifierId) && claims.verifierId.length <= 200
    && typeof claims.verificationId === "string" && safeIdentifier.test(claims.verificationId) && claims.verificationId.length >= 8
    && Number.isFinite(verifiedAt) && Number.isFinite(expiresAt)
    && expiresAt >= verifiedAt
    && expiresAt - verifiedAt <= maximumAttestationLifetimeMilliseconds;
}

function secretBuffer(secret: string) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("The external-evidence attestation secret must contain at least 32 bytes.");
  return Buffer.from(secret, "utf8");
}

function signature(secret: Buffer, payload: string) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function signExtendedExternalEvidenceAttestation(secret: string, input: ExtendedExternalEvidenceAttestationInput) {
  const claims: ExtendedExternalEvidenceAttestationClaims = { version: attestationVersion, ...input };
  if (!validClaims(claims)) throw new Error("The external-evidence attestation claims are invalid.");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signature(secretBuffer(secret), payload)}`;
}

function verifiedClaims(secret: Buffer, token: string) {
  if (token.length > 4_096) return undefined;
  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1] || segments[0].length > 3_500 || segments[1].length > 100) return undefined;
  const expected = Buffer.from(signature(secret, segments[0]), "utf8");
  const actual = Buffer.from(segments[1], "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const decoded = Buffer.from(segments[0], "base64url");
    if (decoded.length > 2_600) return undefined;
    const claims: unknown = JSON.parse(decoded.toString("utf8"));
    return validClaims(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

export function createExtendedExternalEvidenceVerifier(secret: string): ExtendedBusinessEngineDependencies["verifyExternalEvidence"] {
  const trustedSecret = secretBuffer(secret);
  return async (request: ExtendedExternalEvidenceRequest) => {
    if (!request.attestationToken) return undefined;
    const claims = verifiedClaims(trustedSecret, request.attestationToken);
    if (!claims) return undefined;
    const requestedAt = time(request.requestedAt);
    if (!Number.isFinite(requestedAt)
      || requestedAt < time(claims.verifiedAt)
      || requestedAt > time(claims.expiresAt)
      || claims.kind !== request.kind
      || claims.workspaceId !== request.workspaceId
      || claims.actorUserId !== request.actorUserId
      || claims.moduleId !== request.moduleId
      || claims.actionId !== request.actionId
      || claims.evidenceHash !== request.evidenceHash) return undefined;
    return {
      verified: true,
      verifierId: claims.verifierId,
      verificationId: claims.verificationId,
      verifiedAt: claims.verifiedAt,
      evidenceHash: claims.evidenceHash,
    };
  };
}
