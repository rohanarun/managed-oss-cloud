import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  KeyObject,
} from "node:crypto";
import { z } from "zod";
import { verifyDomain, type DomainResolver } from "./domain-verification.js";
import type { ManagedOAuthFlow, Repository } from "./repository.js";

const provider = "google" as const;
const stateLifetimeSeconds = 10 * 60;
const assertionLifetimeSeconds = 90;
const maximumProviderResponseBytes = 64 * 1024;

const googleTokenSchema = z.object({
  access_token: z.string().min(16).max(8_192),
  token_type: z.string().max(32).optional(),
}).passthrough();

const googleUserInfoSchema = z.object({
  id: z.string().min(1).max(512),
  email: z.string().email().max(320),
  verified_email: z.boolean(),
  name: z.string().min(1).max(300),
  picture: z.string().url().max(2_048).optional(),
  locale: z.string().min(2).max(35).optional(),
}).passthrough();

const assertionPayloadSchema = z.object({
  iss: z.string().url(),
  aud: z.string().url(),
  sub: z.string().min(1).max(512),
  email: z.string().email().max(320),
  email_verified: z.literal(true),
  name: z.string().min(1).max(300),
  picture: z.string().url().max(2_048).optional(),
  locale: z.string().min(2).max(35).optional(),
  provider: z.literal(provider),
  flow_id: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  state_hash: z.string().regex(/^[a-f0-9]{64}$/),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

interface SignedBrokerState {
  version: 1;
  provider: typeof provider;
  flowId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ManagedGoogleOAuthBrokerSettings {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  callbackUrl: string;
  brokerStartUrl: string;
  assertionSigningPrivateKey: string | Buffer | KeyObject;
  assertionPublicKey: string | Buffer | KeyObject;
}

export type ManagedOAuthTenantPost =
  | { action: string; fields: { state: string; assertion: string } }
  | { action: string; fields: { state: string; error: "access_denied"; error_description: string } };

export interface ManagedGoogleOAuthBrokerLike {
  begin(input: { applicationInstanceId: string; origin: string; upstreamState: string }): Promise<string>;
  complete(input: { state: string; code?: string; error?: string; errorDescription?: string }): Promise<ManagedOAuthTenantPost>;
}

export class ManagedOAuthBrokerError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409 | 502 | 503 = 400) {
    super(message);
  }
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function stateSignature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function exactHttpsUrl(value: string, pathname?: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || (pathname && url.pathname !== pathname)) throw new Error("Managed OAuth requires an exact HTTPS URL.");
  if (!pathname && url.pathname !== "/") throw new Error("Managed OAuth tenant origins cannot include a path.");
  return url;
}

function privateKey(value: string | Buffer | KeyObject) {
  if (value instanceof KeyObject) {
    if (value.type !== "private") throw new Error("Managed OAuth assertion signing requires a private key.");
    if (value.asymmetricKeyType !== "ed25519") throw new Error("Managed OAuth assertion signing requires Ed25519.");
    return value;
  }
  const key = typeof value === "string" && !value.includes("BEGIN")
    ? createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" })
    : createPrivateKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Managed OAuth assertion signing requires Ed25519.");
  return key;
}

function publicKey(value: string | Buffer | KeyObject) {
  if (value instanceof KeyObject) {
    const key = value.type === "public" ? value : createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Managed OAuth assertion verification requires Ed25519.");
    return key;
  }
  const key = typeof value === "string" && !value.includes("BEGIN")
    ? createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" })
    : createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Managed OAuth assertion verification requires Ed25519.");
  return key;
}

function assertionKeyId(key: KeyObject) {
  return sha256(key.export({ format: "der", type: "spki" })).slice(0, 24);
}

function createBrokerState(value: SignedBrokerState, secret: string) {
  const payload = encode(value);
  return `${payload}.${stateSignature(payload, secret)}`;
}

function decodeBrokerState(token: string, secret: string, nowSeconds: number) {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra || token.length > 2_048) throw new ManagedOAuthBrokerError("Managed OAuth state is malformed.");
  const expected = Buffer.from(stateSignature(payload, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new ManagedOAuthBrokerError("Managed OAuth state signature is invalid.");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new ManagedOAuthBrokerError("Managed OAuth state payload is invalid."); }
  const parsed = z.object({
    version: z.literal(1),
    provider: z.literal(provider),
    flowId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  }).strict().safeParse(decoded);
  if (!parsed.success || parsed.data.expiresAt <= nowSeconds || parsed.data.issuedAt > nowSeconds + 30 || parsed.data.expiresAt - parsed.data.issuedAt !== stateLifetimeSeconds) throw new ManagedOAuthBrokerError("Managed OAuth state has expired or is invalid.");
  return parsed.data;
}

export function signManagedGoogleIdentityAssertion(
  profile: { sub: string; email: string; name: string; picture?: string; locale?: string },
  input: { issuer: string; audience: string; flowId: string; upstreamState: string; nowSeconds: number; privateKey: string | Buffer | KeyObject; publicKey: string | Buffer | KeyObject },
) {
  const signingKey = privateKey(input.privateKey);
  const verificationKey = publicKey(input.publicKey);
  const derivedPublicKey = createPublicKey(signingKey).export({ format: "der", type: "spki" });
  const configuredPublicKey = verificationKey.export({ format: "der", type: "spki" });
  if (derivedPublicKey.length !== configuredPublicKey.length || !timingSafeEqual(derivedPublicKey, configuredPublicKey)) throw new Error("Managed OAuth assertion key pair does not match.");
  const header = encode({ alg: "EdDSA", typ: "JWT", kid: assertionKeyId(verificationKey) });
  const payload = encode(assertionPayloadSchema.parse({
    iss: input.issuer,
    aud: input.audience,
    sub: profile.sub,
    email: profile.email.toLowerCase(),
    email_verified: true,
    name: profile.name,
    ...(profile.picture ? { picture: profile.picture } : {}),
    ...(profile.locale ? { locale: profile.locale } : {}),
    provider,
    flow_id: input.flowId,
    state_hash: sha256(input.upstreamState),
    iat: input.nowSeconds,
    exp: input.nowSeconds + assertionLifetimeSeconds,
  }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), signingKey).toString("base64url")}`;
}

export function verifyManagedGoogleIdentityAssertion(token: string, input: { issuer: string; audience: string; publicKey: string | Buffer | KeyObject; nowSeconds: number }) {
  const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra || token.length > 8_000) throw new Error("Managed OAuth identity assertion is malformed.");
  const key = publicKey(input.publicKey);
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch { throw new Error("Managed OAuth identity assertion is invalid."); }
  const parsedHeader = z.object({ alg: z.literal("EdDSA"), typ: z.literal("JWT"), kid: z.string() }).strict().safeParse(header);
  const parsedPayload = assertionPayloadSchema.safeParse(payload);
  if (!parsedHeader.success || parsedHeader.data.kid !== assertionKeyId(key) || !parsedPayload.success) throw new Error("Managed OAuth identity assertion is invalid.");
  const value = parsedPayload.data;
  if (value.iss !== input.issuer || value.aud !== input.audience || value.exp <= input.nowSeconds || value.iat > input.nowSeconds + 30 || value.exp - value.iat !== assertionLifetimeSeconds) throw new Error("Managed OAuth identity assertion audience or lifetime is invalid.");
  if (!verify(null, Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, "base64url"))) throw new Error("Managed OAuth identity assertion signature is invalid.");
  return value;
}

async function boundedJson(response: Response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumProviderResponseBytes) throw new Error("OAuth provider response exceeded the safe limit.");
  try { return JSON.parse(text) as unknown; } catch { throw new Error("OAuth provider returned invalid JSON."); }
}

function flowPost(flow: ManagedOAuthFlow, values: { assertion: string } | { error: "access_denied"; error_description: string }): ManagedOAuthTenantPost {
  const action = new URL("/connect/google/callback", flow.origin).toString();
  if ("assertion" in values) return { action, fields: { state: flow.upstreamState, assertion: values.assertion } };
  return { action, fields: { state: flow.upstreamState, error: values.error, error_description: values.error_description } };
}

export class ManagedGoogleOAuthBroker implements ManagedGoogleOAuthBrokerLike {
  private readonly callback: URL;
  private readonly start: URL;
  private readonly signingKey: KeyObject;
  private readonly verificationKey: KeyObject;

  constructor(
    private readonly repository: Pick<Repository, "listGatewayRoutes" | "createManagedOAuthFlow" | "consumeManagedOAuthFlow">,
    private readonly settings: ManagedGoogleOAuthBrokerSettings,
    private readonly dependencies: { fetch?: typeof fetch; now?: () => Date; domainResolver?: DomainResolver } = {},
  ) {
    if (settings.clientId.length < 10 || settings.clientSecret.length < 10 || settings.stateSecret.length < 32) throw new Error("Managed Google OAuth broker credentials are incomplete.");
    this.callback = exactHttpsUrl(settings.callbackUrl, "/oauth/google/callback");
    this.start = exactHttpsUrl(settings.brokerStartUrl, "/oauth/google/start");
    if (this.callback.origin !== this.start.origin) throw new Error("Managed Google OAuth broker start and callback URLs must share an origin.");
    this.signingKey = privateKey(settings.assertionSigningPrivateKey);
    this.verificationKey = publicKey(settings.assertionPublicKey);
    const derived = createPublicKey(this.signingKey).export({ format: "der", type: "spki" });
    const configured = this.verificationKey.export({ format: "der", type: "spki" });
    if (derived.length !== configured.length || !timingSafeEqual(derived, configured)) throw new Error("Managed OAuth assertion key pair does not match.");
  }

  private now() { return this.dependencies.now?.() ?? new Date(); }

  private async activeRoute(applicationInstanceId: string, originHost: string) {
    const route = (await this.repository.listGatewayRoutes()).find((candidate) => candidate.applicationInstanceId === applicationInstanceId && candidate.appId === "heyform" && candidate.hostname === originHost);
    if (!route) return undefined;
    if (route.hostname === route.upstreamHost) return route;
    if (!route.ownership) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        verifyDomain(route.ownership, this.dependencies.domainResolver),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Managed OAuth domain verification timed out.")), 2_000); timer.unref?.(); }),
      ]);
      return result.verified ? route : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async begin(input: { applicationInstanceId: string; origin: string; upstreamState: string }) {
    const origin = exactHttpsUrl(input.origin).origin;
    if (!/^[0-9a-f-]{36}$/i.test(input.applicationInstanceId) || input.upstreamState.length < 8 || input.upstreamState.length > 2_000) throw new ManagedOAuthBrokerError("Managed OAuth tenant request is invalid.");
    const originHost = new URL(origin).hostname;
    const route = await this.activeRoute(input.applicationInstanceId, originHost);
    if (!route) throw new ManagedOAuthBrokerError("Managed OAuth target is not an active hosted HeyForm application.", 403);

    const now = this.now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const flowId = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const signedState = createBrokerState({ version: 1, provider, flowId, issuedAt: nowSeconds, expiresAt: nowSeconds + stateLifetimeSeconds }, this.settings.stateSecret);
    await this.repository.createManagedOAuthFlow({
      id: flowId,
      stateTokenHash: sha256(signedState),
      applicationInstanceId: input.applicationInstanceId,
      origin,
      upstreamState: input.upstreamState,
      codeVerifier,
      expiresAt: new Date((nowSeconds + stateLifetimeSeconds) * 1_000).toISOString(),
      createdAt: now.toISOString(),
    });

    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.searchParams.set("client_id", this.settings.clientId);
    authorization.searchParams.set("redirect_uri", this.callback.toString());
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "openid email profile");
    authorization.searchParams.set("state", signedState);
    authorization.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("prompt", "select_account");
    return authorization.toString();
  }

  async complete(input: { state: string; code?: string; error?: string; errorDescription?: string }) {
    const now = this.now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const decodedState = decodeBrokerState(input.state, this.settings.stateSecret, nowSeconds);
    const flow = await this.repository.consumeManagedOAuthFlow(sha256(input.state));
    if (!flow || flow.id !== decodedState.flowId || flow.expiresAt <= now.toISOString()) throw new ManagedOAuthBrokerError("Managed OAuth state was already used or expired.", 409);
    const originHost = new URL(flow.origin).hostname;
    const route = await this.activeRoute(flow.applicationInstanceId, originHost);
    if (!route) throw new ManagedOAuthBrokerError("Managed OAuth target is no longer active.", 403);
    if (input.error) return flowPost(flow, { error: "access_denied", error_description: "Google sign-in was not completed." });
    if (!input.code) throw new ManagedOAuthBrokerError("Google did not return an authorization code.");

    const fetchImplementation = this.dependencies.fetch ?? fetch;
    let tokenResponse: Response;
    try {
      tokenResponse = await fetchImplementation("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          code: input.code,
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          redirect_uri: this.callback.toString(),
          grant_type: "authorization_code",
          code_verifier: flow.codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new ManagedOAuthBrokerError("Google token exchange was unavailable.", 502); }
    if (!tokenResponse.ok) throw new ManagedOAuthBrokerError("Google token exchange was rejected.", 502);
    const token = googleTokenSchema.safeParse(await boundedJson(tokenResponse));
    if (!token.success) throw new ManagedOAuthBrokerError("Google token exchange returned an invalid response.", 502);

    let profileResponse: Response;
    try {
      profileResponse = await fetchImplementation("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { authorization: `Bearer ${token.data.access_token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new ManagedOAuthBrokerError("Google identity lookup was unavailable.", 502); }
    if (!profileResponse.ok) throw new ManagedOAuthBrokerError("Google identity lookup was rejected.", 502);
    const profile = googleUserInfoSchema.safeParse(await boundedJson(profileResponse));
    if (!profile.success || !profile.data.verified_email) throw new ManagedOAuthBrokerError("Google did not return a verified identity.", 502);

    const assertion = signManagedGoogleIdentityAssertion({
      sub: profile.data.id,
      email: profile.data.email,
      name: profile.data.name,
      picture: profile.data.picture,
      locale: profile.data.locale,
    }, {
      issuer: this.start.origin,
      audience: flow.origin,
      flowId: flow.id,
      upstreamState: flow.upstreamState,
      nowSeconds,
      privateKey: this.signingKey,
      publicKey: this.verificationKey,
    });
    return flowPost(flow, { assertion });
  }
}
