import { createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";

export interface GcpWorkerIdentityPolicy {
  audience: string;
  projectId: string;
  allowedInstanceNames: ReadonlySet<string>;
  allowedZones: ReadonlySet<string>;
  maximumTokenAgeSeconds?: number;
}

export interface GcpWorkerIdentity {
  instanceId: string;
  instanceName: string;
  projectId: string;
  zone: string;
  subject: string;
  issuedAt: number;
  expiresAt: number;
}

type VerifiedClaims = Record<string, unknown>;
type VerifySignedToken = (token: string, audience: string) => Promise<VerifiedClaims>;

const googleTokenVerifier = new OAuth2Client();

async function verifyGoogleSignature(token: string, audience: string): Promise<VerifiedClaims> {
  const ticket = await googleTokenVerifier.verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("Google did not return a verified identity payload.");
  return payload as unknown as VerifiedClaims;
}

function requiredString(value: unknown, claim: string, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`The verified identity token omitted a valid ${claim} claim.`);
  return value;
}

function requiredEpoch(value: unknown, claim: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`The verified identity token omitted a valid ${claim} claim.`);
  return value;
}

function computeClaims(payload: VerifiedClaims) {
  const google = payload.google;
  if (!google || typeof google !== "object" || Array.isArray(google)) throw new Error("A full Compute Engine instance identity token is required.");
  const compute = (google as Record<string, unknown>).compute_engine;
  if (!compute || typeof compute !== "object" || Array.isArray(compute)) throw new Error("A full Compute Engine instance identity token is required.");
  return compute as Record<string, unknown>;
}

function normalizeZone(value: string) {
  const segments = value.split("/").filter(Boolean);
  return segments.at(-1) ?? value;
}

export class GcpInstanceIdentityVerifier {
  private readonly usedTokenDigests = new Map<string, number>();

  constructor(
    private readonly policy: GcpWorkerIdentityPolicy,
    private readonly verifySignedToken: VerifySignedToken = verifyGoogleSignature,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {
    if (!/^https:\/\//.test(policy.audience) || policy.audience.length > 2_048) throw new Error("The worker identity audience must be an HTTPS URL.");
    if (!policy.projectId.trim() || !policy.allowedInstanceNames.size || !policy.allowedZones.size) throw new Error("The worker identity policy must pin a project, at least one instance, and at least one zone.");
  }

  async verify(token: string): Promise<GcpWorkerIdentity> {
    if (typeof token !== "string" || token.length < 100 || token.length > 16_384 || token.split(".").length !== 3) throw new Error("A compact Google-signed worker identity token is required.");
    const now = this.now();
    for (const [digest, expiresAt] of this.usedTokenDigests) if (expiresAt <= now) this.usedTokenDigests.delete(digest);
    const tokenDigest = createHash("sha256").update(token, "utf8").digest("hex");
    if (this.usedTokenDigests.has(tokenDigest)) throw new Error("This worker identity token has already been used.");

    const payload = await this.verifySignedToken(token, this.policy.audience);
    const issuer = requiredString(payload.iss, "issuer");
    if (!["accounts.google.com", "https://accounts.google.com"].includes(issuer)) throw new Error("The worker identity token has an unexpected issuer.");
    if (payload.aud !== this.policy.audience) throw new Error("The worker identity token has an unexpected audience.");

    const issuedAt = requiredEpoch(payload.iat, "issued-at");
    const expiresAt = requiredEpoch(payload.exp, "expiration");
    const maximumAge = this.policy.maximumTokenAgeSeconds ?? 300;
    if (!Number.isSafeInteger(maximumAge) || maximumAge < 30 || maximumAge > 3_600) throw new Error("The worker identity maximum token age must be between 30 and 3600 seconds.");
    if (issuedAt > now + 30 || expiresAt <= now || expiresAt - issuedAt > 3_660 || now - issuedAt > maximumAge) throw new Error("The worker identity token is expired, future-dated, or too old for enrollment.");

    const compute = computeClaims(payload);
    const projectId = requiredString(compute.project_id, "project ID");
    const instanceName = requiredString(compute.instance_name, "instance name");
    const instanceId = requiredString(compute.instance_id, "instance ID");
    const zone = normalizeZone(requiredString(compute.zone, "zone"));
    const subject = requiredString(payload.sub, "subject");
    if (projectId !== this.policy.projectId) throw new Error("The worker identity token belongs to a different Google Cloud project.");
    if (!this.policy.allowedInstanceNames.has(instanceName)) throw new Error("The Google Cloud instance is not allowed to enroll as a worker.");
    if (!this.policy.allowedZones.has(zone)) throw new Error("The Google Cloud instance is in an unapproved zone.");
    if (!/^\d{6,30}$/.test(instanceId) || !/^\d{6,30}$/.test(subject)) throw new Error("The worker identity token contains invalid stable identifiers.");

    this.usedTokenDigests.set(tokenDigest, expiresAt);
    return { instanceId, instanceName, projectId, zone, subject, issuedAt, expiresAt };
  }
}

export function parseGcpWorkerIdentityPolicy(input: { audience?: string; projectId?: string; instanceNames?: string; zones?: string }) {
  if (!input.audience && !input.projectId && !input.instanceNames && !input.zones) return undefined;
  const instanceNames = new Set((input.instanceNames ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const zones = new Set((input.zones ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (!input.audience || !input.projectId || !instanceNames.size || !zones.size) throw new Error("GCP worker identity enrollment requires audience, project ID, instance names, and zones together.");
  for (const name of instanceNames) if (!/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) throw new Error(`Invalid allowed Google Cloud instance name: ${name}.`);
  for (const zone of zones) if (!/^[a-z]+-[a-z0-9]+\d-[a-z]$/.test(zone)) throw new Error(`Invalid allowed Google Cloud zone: ${zone}.`);
  return { audience: input.audience, projectId: input.projectId, allowedInstanceNames: instanceNames, allowedZones: zones } satisfies GcpWorkerIdentityPolicy;
}

export async function requestGcpInstanceIdentityToken(audience: string, fetchImplementation: typeof fetch = fetch) {
  if (!audience.startsWith("https://") || audience.length > 2_048) throw new Error("The worker identity audience must be an HTTPS URL.");
  const query = new URLSearchParams({ audience, format: "full" });
  const response = await fetchImplementation(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?${query}`, {
    headers: { "Metadata-Flavor": "Google" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Google metadata identity request failed with ${response.status}.`);
  const token = (await response.text()).trim();
  if (token.length < 100 || token.length > 16_384 || token.split(".").length !== 3) throw new Error("Google metadata returned an invalid instance identity token.");
  return token;
}
