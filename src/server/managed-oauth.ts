import { createHmac, timingSafeEqual } from "node:crypto";

export interface ManagedOAuthState {
  origin: string;
  state: string;
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createManagedOAuthState(value: ManagedOAuthState, secret: string) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function decodeManagedOAuthState(token: string, secret: string): ManagedOAuthState {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) throw new Error("Managed OAuth state is malformed.");
  const expected = Buffer.from(signature(payload, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("Managed OAuth state signature is invalid.");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ManagedOAuthState>;
  if (typeof parsed.origin !== "string" || typeof parsed.state !== "string" || parsed.state.length < 8 || parsed.state.length > 2_000) throw new Error("Managed OAuth state payload is invalid.");
  const origin = new URL(parsed.origin);
  if (origin.protocol !== "https:" || origin.origin !== parsed.origin || origin.username || origin.password) throw new Error("Managed OAuth target origin is invalid.");
  return { origin: origin.origin, state: parsed.state };
}
