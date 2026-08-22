import { describe, expect, it } from "vitest";
import { createManagedOAuthState, decodeManagedOAuthState } from "../src/server/managed-oauth";

const secret = "a-platform-owned-state-secret-that-is-long-enough";

describe("managed OAuth state", () => {
  it("round trips an exact managed app origin and upstream state", () => {
    const token = createManagedOAuthState({ origin: "https://heyform-example.apps.getsupers.com", state: "upstream-state-value" }, secret);
    expect(decodeManagedOAuthState(token, secret)).toEqual({ origin: "https://heyform-example.apps.getsupers.com", state: "upstream-state-value" });
  });

  it("rejects tampering, non-HTTPS targets, paths, and short state", () => {
    const token = createManagedOAuthState({ origin: "https://heyform-example.apps.getsupers.com", state: "upstream-state-value" }, secret);
    expect(() => decodeManagedOAuthState(`${token}x`, secret)).toThrow(/signature/);
    for (const invalid of [
      { origin: "http://heyform-example.apps.getsupers.com", state: "upstream-state-value" },
      { origin: "https://heyform-example.apps.getsupers.com/path", state: "upstream-state-value" },
      { origin: "https://heyform-example.apps.getsupers.com", state: "short" },
    ]) expect(() => decodeManagedOAuthState(createManagedOAuthState(invalid, secret), secret)).toThrow(/invalid/);
  });
});
