import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export type PublicSigningKey = string | Buffer | KeyObject;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalPublicJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export interface PublicSignature {
  algorithm: "Ed25519";
  keyId: string;
  signature: string;
}

export interface PublicVerificationKey {
  algorithm: "Ed25519";
  keyId: string;
  publicKey: string;
}

export function validatePublicVerificationKey(value: unknown): PublicVerificationKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A public signing verification key must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.algorithm !== "Ed25519" || typeof candidate.keyId !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(candidate.keyId) || typeof candidate.publicKey !== "string" || !/^[A-Za-z0-9_-]{40,256}$/.test(candidate.publicKey)) throw new Error("A public signing verification key is malformed.");
  const publicKeyDer = Buffer.from(candidate.publicKey, "base64url");
  if (publicKeyDer.toString("base64url") !== candidate.publicKey) throw new Error("A public signing verification key is not canonical base64url.");
  const publicKey = createPublicKey({ key: publicKeyDer, type: "spki", format: "der" });
  const derivedKeyId = createHash("sha256").update(publicKeyDer).digest("base64url").slice(0, 24);
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519" || derivedKeyId !== candidate.keyId) throw new Error("A public signing verification key does not match its key ID.");
  return { algorithm: "Ed25519", keyId: candidate.keyId, publicKey: candidate.publicKey };
}

export class PublicSigningService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly publicKeyDer: Buffer;
  readonly keyId: string;

  constructor(key: PublicSigningKey) {
    if (typeof key === "string") {
      const normalized = key.includes("BEGIN PRIVATE KEY") ? key.replace(/\\n/g, "\n") : undefined;
      this.privateKey = normalized
        ? createPrivateKey(normalized)
        : createPrivateKey({ key: Buffer.from(key, "base64"), type: "pkcs8", format: "der" });
    } else if (Buffer.isBuffer(key)) {
      this.privateKey = createPrivateKey({ key, type: "pkcs8", format: "der" });
    } else {
      this.privateKey = key;
    }
    if (this.privateKey.type !== "private" || this.privateKey.asymmetricKeyType !== "ed25519") throw new Error("The consent policy signing key must be an Ed25519 private key.");
    this.publicKey = createPublicKey(this.privateKey);
    this.publicKeyDer = this.publicKey.export({ type: "spki", format: "der" });
    this.keyId = createHash("sha256").update(this.publicKeyDer).digest("base64url").slice(0, 24);
  }

  sign(payload: unknown): PublicSignature {
    const signature = sign(null, Buffer.from(canonicalPublicJson(payload), "utf8"), this.privateKey);
    return { algorithm: "Ed25519", keyId: this.keyId, signature: signature.toString("base64url") };
  }

  verificationKey(): PublicVerificationKey {
    return { algorithm: "Ed25519", keyId: this.keyId, publicKey: this.publicKeyDer.toString("base64url") };
  }
}

export function verifyPublicSignature(payload: unknown, signature: PublicSignature, trustedKeys: readonly PublicVerificationKey[]) {
  if (signature.algorithm !== "Ed25519" || !Array.isArray(trustedKeys) || trustedKeys.length === 0) return false;
  try {
    const trusted = trustedKeys.find((candidate) => candidate.algorithm === signature.algorithm && candidate.keyId === signature.keyId);
    if (!trusted) return false;
    const validated = validatePublicVerificationKey(trusted);
    const publicKeyDer = Buffer.from(validated.publicKey, "base64url");
    const publicKey = createPublicKey({ key: publicKeyDer, type: "spki", format: "der" });
    const derivedKeyId = createHash("sha256").update(publicKeyDer).digest("base64url").slice(0, 24);
    return derivedKeyId === signature.keyId && verify(null, Buffer.from(canonicalPublicJson(payload), "utf8"), publicKey, Buffer.from(signature.signature, "base64url"));
  } catch {
    return false;
  }
}

export function verifyPublicReceiptEnvelope(receiptId: string, payload: unknown, signature: PublicSignature, trustedKeys: readonly PublicVerificationKey[]) {
  if (!/^[0-9a-f-]{36}$/i.test(receiptId) || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record.schema !== "managed-oss-consent-receipt" || record.version !== 1 || record.receiptId !== receiptId) return false;
  return verifyPublicSignature(payload, signature, trustedKeys);
}
