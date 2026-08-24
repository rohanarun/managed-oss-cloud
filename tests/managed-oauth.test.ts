import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ManagedGoogleOAuthBroker, signManagedGoogleIdentityAssertion, verifyManagedGoogleIdentityAssertion } from "../src/server/managed-oauth";
import type { ManagedOAuthFlow } from "../src/server/repository";
import type { GatewayRoute } from "../src/shared/types";
import { parseRuntimeEnvironment } from "../src/server/config";

const now = new Date("2026-08-24T12:00:00.000Z");
const applicationInstanceId = "11111111-2222-4333-8444-555555555555";
const origin = "https://heyform-example.apps.getsupers.com";
const upstreamState = "heyform-browser-state-value";
const stateSecret = "state-secret-with-at-least-thirty-two-characters";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

class FlowRepository {
  routes: GatewayRoute[] = [{ hostname: new URL(origin).hostname, upstreamHost: new URL(origin).hostname, workerPrivateAddress: "10.70.0.3", workerNodeId: "worker-0", applicationInstanceId, appId: "heyform" }];
  flows = new Map<string, ManagedOAuthFlow>();

  async listGatewayRoutes() { return this.routes; }
  async createManagedOAuthFlow(flow: ManagedOAuthFlow) { this.flows.set(flow.stateTokenHash, { ...flow }); }
  async consumeManagedOAuthFlow(stateTokenHash: string) {
    const flow = this.flows.get(stateTokenHash);
    if (!flow || flow.consumedAt) return undefined;
    flow.consumedAt = now.toISOString();
    return { ...flow };
  }
}

function broker(repository = new FlowRepository(), fetchImplementation?: typeof fetch, domainResolver?: { resolveTxt(hostname: string): Promise<string[][]>; resolveCname(hostname: string): Promise<string[]> }) {
  const pair = keys();
  return {
    pair,
    repository,
    value: new ManagedGoogleOAuthBroker(repository, {
      clientId: "google-platform-client-id",
      clientSecret: "google-platform-client-secret",
      stateSecret,
      callbackUrl: "https://cloud.getsupers.com/oauth/google/callback",
      brokerStartUrl: "https://cloud.getsupers.com/oauth/google/start",
      assertionSigningPrivateKey: pair.privateKey,
      assertionPublicKey: pair.publicKey,
    }, { now: () => now, ...(fetchImplementation ? { fetch: fetchImplementation } : {}), ...(domainResolver ? { domainResolver } : {}) }),
  };
}

describe("hosting-layer Google OAuth broker", () => {
  it("allows only the public broker pair on workers and requires the complete private broker set on the control plane", () => {
    expect(parseRuntimeEnvironment({ GOOGLE_OAUTH_BROKER_START_URL: "https://cloud.getsupers.com/oauth/google/start", GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY: "a".repeat(60) })).toMatchObject({ GOOGLE_OAUTH_BROKER_START_URL: "https://cloud.getsupers.com/oauth/google/start" });
    expect(() => parseRuntimeEnvironment({ GOOGLE_OAUTH_BROKER_START_URL: "https://cloud.getsupers.com/oauth/google/start" })).toThrow(/public key/i);
    expect(() => parseRuntimeEnvironment({ GOOGLE_OAUTH_CLIENT_ID: "client-id-value" })).toThrow(/configured together/i);
    expect(() => parseRuntimeEnvironment({ GOOGLE_OAUTH_BROKER_START_URL: "https://cloud.getsupers.com/not-oauth", GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY: "a".repeat(60) })).toThrow(/exact HTTPS/i);
    expect(() => parseRuntimeEnvironment({ GOOGLE_OAUTH_BROKER_START_URL: "https://cloud.getsupers.com:8443/oauth/google/start", GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY: "a".repeat(60) })).toThrow(/non-default port/i);
  });

  it("signs short-lived audience- and app-state-bound Ed25519 identity assertions", () => {
    const pair = keys();
    const token = signManagedGoogleIdentityAssertion({ sub: "google-user", email: "Person@Example.com", name: "Person Example" }, {
      issuer: "https://cloud.getsupers.com",
      audience: origin,
      flowId: "a".repeat(43),
      upstreamState,
      nowSeconds: Math.floor(now.getTime() / 1_000),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    });
    const verified = verifyManagedGoogleIdentityAssertion(token, { issuer: "https://cloud.getsupers.com", audience: origin, publicKey: pair.publicKey, nowSeconds: Math.floor(now.getTime() / 1_000) });
    expect(verified).toMatchObject({ sub: "google-user", email: "person@example.com", email_verified: true, aud: origin, provider: "google", state_hash: createHash("sha256").update(upstreamState).digest("hex") });
    expect(() => verifyManagedGoogleIdentityAssertion(token, { issuer: "https://cloud.getsupers.com", audience: "https://other.apps.getsupers.com", publicKey: pair.publicKey, nowSeconds: Math.floor(now.getTime() / 1_000) })).toThrow(/audience/);
    const assertionParts = token.split(".");
    assertionParts[2] = `${assertionParts[2][0] === "A" ? "B" : "A"}${assertionParts[2].slice(1)}`;
    expect(() => verifyManagedGoogleIdentityAssertion(assertionParts.join("."), { issuer: "https://cloud.getsupers.com", audience: origin, publicKey: pair.publicKey, nowSeconds: Math.floor(now.getTime() / 1_000) })).toThrow(/signature/);
  });

  it("authorizes only an active exact HeyForm route, persists opaque state and PKCE, exchanges centrally, and returns no provider token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const providerFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "provider-access-token-with-safe-length", token_type: "Bearer" }), { status: 200 });
      return new Response(JSON.stringify({ id: "google-user-1", email: "user@example.com", verified_email: true, name: "User Example", picture: "https://images.example/avatar.png", locale: "en" }), { status: 200 });
    }) as typeof fetch;
    const fixture = broker(new FlowRepository(), providerFetch);
    const authorizationUrl = new URL(await fixture.value.begin({ applicationInstanceId, origin, upstreamState }));
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://cloud.getsupers.com/oauth/google/callback");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.toString()).not.toContain("google-platform-client-secret");
    expect(fixture.repository.flows.size).toBe(1);

    const state = authorizationUrl.searchParams.get("state")!;
    const target = await fixture.value.complete({ state, code: "one-time-google-code" });
    expect(target.action).toBe(`${origin}/connect/google/callback`);
    expect(target.action).not.toContain("?");
    expect(target.fields.state).toBe(upstreamState);
    expect(target.fields).not.toHaveProperty("code");
    expect(target.fields).toHaveProperty("assertion");
    const assertion = "assertion" in target.fields ? target.fields.assertion : "";
    expect(assertion).not.toContain("provider-access-token");
    expect(verifyManagedGoogleIdentityAssertion(assertion, { issuer: "https://cloud.getsupers.com", audience: origin, publicKey: fixture.pair.publicKey, nowSeconds: Math.floor(now.getTime() / 1_000) })).toMatchObject({ sub: "google-user-1", state_hash: createHash("sha256").update(upstreamState).digest("hex") });
    expect(requests[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(String(requests[0].init?.body)).toContain("client_secret=google-platform-client-secret");
    expect(String(requests[0].init?.body)).toContain("code_verifier=");
    expect((requests[1].init?.headers as Record<string, string>).authorization).toBe("Bearer provider-access-token-with-safe-length");
    await expect(fixture.value.complete({ state, code: "replay" })).rejects.toThrow(/already used/);
  });

  it("fails closed for cross-tenant routing, wrong application type, unverified email, and key mismatch", async () => {
    const crossTenant = broker();
    await expect(crossTenant.value.begin({ applicationInstanceId, origin: "https://attacker.example", upstreamState })).rejects.toThrow(/not an active/);
    crossTenant.repository.routes[0].appId = "uptime-kuma";
    await expect(crossTenant.value.begin({ applicationInstanceId, origin, upstreamState })).rejects.toThrow(/not an active/);

    const unverifiedFetch = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/token")
      ? new Response(JSON.stringify({ access_token: "provider-access-token-with-safe-length" }))
      : new Response(JSON.stringify({ id: "google-user", email: "user@example.com", verified_email: false, name: "User" }))) as typeof fetch;
    const unverified = broker(new FlowRepository(), unverifiedFetch);
    const auth = new URL(await unverified.value.begin({ applicationInstanceId, origin, upstreamState }));
    await expect(unverified.value.complete({ state: auth.searchParams.get("state")!, code: "code" })).rejects.toThrow(/verified identity/);

    const first = keys();
    const second = keys();
    expect(() => new ManagedGoogleOAuthBroker(new FlowRepository(), {
      clientId: "google-platform-client-id", clientSecret: "google-platform-client-secret", stateSecret,
      callbackUrl: "https://cloud.getsupers.com/oauth/google/callback", brokerStartUrl: "https://cloud.getsupers.com/oauth/google/start",
      assertionSigningPrivateKey: first.privateKey, assertionPublicKey: second.publicKey,
    })).toThrow(/does not match/);
  });

  it("revalidates custom-domain ownership before starting and completing an OAuth flow", async () => {
    const repository = new FlowRepository();
    const customHost = new URL(origin).hostname;
    const token = "managed-ownership-token";
    repository.routes[0] = {
      ...repository.routes[0],
      hostname: customHost,
      upstreamHost: "heyform-canonical.apps.getsupers.com",
      ownership: {
        claimId: "22222222-3333-4444-8555-666666666666",
        txt: { type: "TXT", name: `_managed-oss.${customHost}`, value: `managed-oss-domain-verification=${token}` },
        cname: { type: "CNAME", name: customHost, value: `${token}.verify.apps.getsupers.com` },
      },
    };
    let owned = true;
    const resolver = {
      resolveTxt: async () => owned ? [[`managed-oss-domain-verification=${token}`]] : [],
      resolveCname: async () => [],
    };
    const fixture = broker(repository, undefined, resolver);
    const authorization = new URL(await fixture.value.begin({ applicationInstanceId, origin, upstreamState }));
    owned = false;
    await expect(fixture.value.complete({ state: authorization.searchParams.get("state")!, code: "provider-code" })).rejects.toThrow(/no longer active/);
    await expect(fixture.value.begin({ applicationInstanceId, origin, upstreamState })).rejects.toThrow(/not an active/);
  });
});
