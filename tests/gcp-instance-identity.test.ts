import { describe, expect, it, vi } from "vitest";
import { GcpInstanceIdentityVerifier, parseGcpWorkerIdentityPolicy, requestGcpInstanceIdentityToken } from "../src/server/gcp-instance-identity";
import { parseRuntimeEnvironment } from "../src/server/config";

const token = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}`;
const now = 2_000_000_000;
const policy = {
  audience: "https://cloud.getsupers.com/api/agent/register",
  projectId: "local-passage-501917-g0",
  allowedInstanceNames: new Set(["managed-oss-host-worker-0"]),
  allowedZones: new Set(["us-central1-a"]),
};

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: policy.audience,
    sub: "123456789012345678901",
    iat: now - 10,
    exp: now + 3_500,
    google: { compute_engine: { project_id: policy.projectId, instance_name: "managed-oss-host-worker-0", instance_id: "9876543210987654321", zone: "projects/840778325784/zones/us-central1-a" } },
    ...overrides,
  };
}

describe("Google Compute Engine worker identity", () => {
  it("accepts a fresh Google-signed full token only for the exact project, instance, zone, and audience", async () => {
    const signedVerifier = vi.fn(async () => claims());
    const verifier = new GcpInstanceIdentityVerifier(policy, signedVerifier, () => now);
    await expect(verifier.verify(token)).resolves.toMatchObject({
      projectId: policy.projectId,
      instanceName: "managed-oss-host-worker-0",
      instanceId: "9876543210987654321",
      zone: "us-central1-a",
    });
    expect(signedVerifier).toHaveBeenCalledWith(token, policy.audience);
  });

  it("rejects replay, stale tokens, service-account-only tokens, and every identity boundary mismatch", async () => {
    const verifier = new GcpInstanceIdentityVerifier(policy, async () => claims(), () => now);
    await verifier.verify(token);
    await expect(verifier.verify(token)).rejects.toThrow(/already been used/);

    const failures: Array<[Record<string, unknown>, RegExp]> = [
      [{ aud: "https://attacker.example/register" }, /audience/],
      [{ iat: now - 301 }, /too old/],
      [{ exp: now }, /expired/],
      [{ google: undefined }, /full Compute Engine/],
      [{ google: { compute_engine: { project_id: "other-project", instance_name: "managed-oss-host-worker-0", instance_id: "9876543210987654321", zone: "us-central1-a" } } }, /different Google Cloud project/],
      [{ google: { compute_engine: { project_id: policy.projectId, instance_name: "rogue-worker", instance_id: "9876543210987654321", zone: "us-central1-a" } } }, /not allowed/],
      [{ google: { compute_engine: { project_id: policy.projectId, instance_name: "managed-oss-host-worker-0", instance_id: "9876543210987654321", zone: "us-east1-b" } } }, /unapproved zone/],
    ];
    for (const [index, [override, message]] of failures.entries()) {
      const candidate = new GcpInstanceIdentityVerifier(policy, async () => claims(override), () => now);
      await expect(candidate.verify(`${token.slice(0, -1)}${String(index % 10)}`)).rejects.toThrow(message);
    }
  });

  it("parses the all-or-nothing enrollment policy and rejects broad or malformed values", () => {
    expect(parseGcpWorkerIdentityPolicy({})).toBeUndefined();
    expect(parseGcpWorkerIdentityPolicy({ audience: policy.audience, projectId: policy.projectId, instanceNames: "managed-oss-host-worker-0", zones: "us-central1-a" })).toMatchObject({ projectId: policy.projectId });
    expect(() => parseGcpWorkerIdentityPolicy({ audience: policy.audience })).toThrow(/requires audience/);
    expect(() => parseGcpWorkerIdentityPolicy({ audience: policy.audience, projectId: policy.projectId, instanceNames: "../../worker", zones: "us-central1-a" })).toThrow(/Invalid allowed/);
    expect(parseRuntimeEnvironment({ GCP_WORKER_IDENTITY_AUDIENCE: policy.audience, GCP_WORKER_IDENTITY_PROJECT_ID: policy.projectId, GCP_WORKER_IDENTITY_INSTANCE_NAMES: "managed-oss-host-worker-0", GCP_WORKER_IDENTITY_ZONES: "us-central1-a" })).toMatchObject({ GCP_WORKER_IDENTITY_PROJECT_ID: policy.projectId });
    expect(() => parseRuntimeEnvironment({ GCP_WORKER_IDENTITY_AUDIENCE: policy.audience })).toThrow(/configured together/);
    expect(() => parseRuntimeEnvironment({ GCP_WORKER_IDENTITY_AUDIENCE: "http://control.example.com/register", GCP_WORKER_IDENTITY_PROJECT_ID: policy.projectId, GCP_WORKER_IDENTITY_INSTANCE_NAMES: "managed-oss-host-worker-0", GCP_WORKER_IDENTITY_ZONES: "us-central1-a" })).toThrow(/HTTPS/);
  });

  it("requests a full identity document only from the fixed metadata endpoint", async () => {
    const metadataFetch = vi.fn(async () => new Response(token, { status: 200 }));
    await expect(requestGcpInstanceIdentityToken(policy.audience, metadataFetch as typeof fetch)).resolves.toBe(token);
    const [url, options] = metadataFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?");
    expect(String(url)).toContain("format=full");
    expect(String(url)).toContain(encodeURIComponent(policy.audience));
    expect(options).toMatchObject({ headers: { "Metadata-Flavor": "Google" }, redirect: "error" });
  });
});
