import { extendedExternalEvidenceHash, type ExtendedExternalEvidenceKind } from "./extended-business-engine.js";
import { signExtendedExternalEvidenceAttestation } from "./extended-external-evidence.js";

function object(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

async function main() {
  const secret = process.env.EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET;
  if (!secret) throw new Error("EXTENDED_EXTERNAL_EVIDENCE_HMAC_SECRET is required in the trusted adapter environment.");
  let source = "";
  for await (const chunk of process.stdin) source += String(chunk);
  const input = object(JSON.parse(source), "stdin");
  const envelope = {
    version: "extended-external-evidence.v1" as const,
    kind: string(input.kind, "kind") as ExtendedExternalEvidenceKind,
    workspaceId: string(input.workspaceId, "workspaceId"),
    actorUserId: string(input.actorUserId, "actorUserId"),
    moduleId: string(input.moduleId, "moduleId") as "events" | "people" | "metering" | "assurance" | "live",
    actionId: string(input.actionId, "actionId"),
    evidence: object(input.evidence, "evidence"),
  };
  const evidenceHash = extendedExternalEvidenceHash(envelope);
  const attestationToken = signExtendedExternalEvidenceAttestation(secret, {
    kind: envelope.kind,
    workspaceId: envelope.workspaceId,
    actorUserId: envelope.actorUserId,
    moduleId: envelope.moduleId,
    actionId: envelope.actionId,
    evidenceHash,
    verifierId: string(input.verifierId, "verifierId"),
    verificationId: string(input.verificationId, "verificationId"),
    verifiedAt: string(input.verifiedAt, "verifiedAt"),
    expiresAt: string(input.expiresAt, "expiresAt"),
  });
  process.stdout.write(`${JSON.stringify({ evidenceHash, attestationToken })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
