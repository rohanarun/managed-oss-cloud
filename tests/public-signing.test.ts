import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PublicSigningService, validatePublicVerificationKey, verifyPublicSignature } from "../src/server/public-signing";

describe("trusted public signing keys", () => {
  it("supports explicit rotation without trusting a replacement key carried by an attacker", () => {
    const oldSigner = new PublicSigningService(generateKeyPairSync("ed25519").privateKey);
    const currentSigner = new PublicSigningService(generateKeyPairSync("ed25519").privateKey);
    const attacker = new PublicSigningService(generateKeyPairSync("ed25519").privateKey);
    const trustedRotationSet = [oldSigner.verificationKey(), currentSigner.verificationKey()];
    const oldPayload = { receiptId: "old", decision: "essential-only" };
    const currentPayload = { receiptId: "current", decision: "essential-only" };

    expect(verifyPublicSignature(oldPayload, oldSigner.sign(oldPayload), trustedRotationSet)).toBe(true);
    expect(verifyPublicSignature(currentPayload, currentSigner.sign(currentPayload), trustedRotationSet)).toBe(true);
    expect(verifyPublicSignature(currentPayload, attacker.sign(currentPayload), trustedRotationSet)).toBe(false);
    expect(verifyPublicSignature(currentPayload, currentSigner.sign(currentPayload), [])).toBe(false);
    expect(() => validatePublicVerificationKey({ ...currentSigner.verificationKey(), keyId: attacker.keyId })).toThrow(/does not match/);
  });
});
