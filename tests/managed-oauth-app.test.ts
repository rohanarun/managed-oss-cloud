import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { ManagedOAuthBrokerError, type ManagedGoogleOAuthBrokerLike } from "../src/server/managed-oauth";

describe("managed OAuth HTTP boundary", () => {
  it("passes only validated broker inputs and POSTs assertions without putting identity in a URL", async () => {
    const broker: ManagedGoogleOAuthBrokerLike = {
      begin: vi.fn(async () => "https://accounts.google.com/o/oauth2/v2/auth?state=signed"),
      complete: vi.fn(async () => ({ action: "https://heyform.apps.example.com/connect/google/callback", fields: { state: "upstream", assertion: "signed-identity-assertion" } })),
    };
    const app = await createApp({ managedGoogleOAuthBroker: broker, synchronizeSuiteEntitlements: false });
    const started = await request(app).get("/oauth/google/start").query({ application_id: "11111111-2222-4333-8444-555555555555", origin: "https://heyform.apps.example.com", upstream_state: "upstream-state" });
    expect(started.status).toBe(302);
    expect(started.headers.location).toContain("accounts.google.com");
    expect(started.headers["cache-control"]).toContain("no-store");
    expect(broker.begin).toHaveBeenCalledWith({ applicationInstanceId: "11111111-2222-4333-8444-555555555555", origin: "https://heyform.apps.example.com", upstreamState: "upstream-state" });

    const completed = await request(app).get("/oauth/google/callback").query({ state: "signed-state", code: "provider-code" });
    expect(completed.status).toBe(200);
    expect(completed.headers.location).toBeUndefined();
    expect(completed.text).toContain('method="post"');
    expect(completed.text).toContain('action="https://heyform.apps.example.com/connect/google/callback"');
    expect(completed.text).toContain('name="assertion" value="signed-identity-assertion"');
    expect(completed.text).not.toContain("?state=");
    expect(completed.headers["content-security-policy"]).toContain("form-action https://heyform.apps.example.com");
    expect(completed.headers["content-security-policy"]).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(completed.headers["referrer-policy"]).toBe("no-referrer");
    expect(completed.headers["cache-control"]).toContain("no-store");
    expect(broker.complete).toHaveBeenCalledWith({ state: "signed-state", code: "provider-code", error: undefined, errorDescription: undefined });
  });

  it("returns generic failures without exposing broker or provider details", async () => {
    const broker: ManagedGoogleOAuthBrokerLike = {
      begin: async () => { throw new ManagedOAuthBrokerError("secret internal route mismatch", 403); },
      complete: async () => { throw new ManagedOAuthBrokerError("provider access token leaked", 502); },
    };
    const app = await createApp({ managedGoogleOAuthBroker: broker, synchronizeSuiteEntitlements: false });
    const started = await request(app).get("/oauth/google/start").query({ application_id: "11111111-2222-4333-8444-555555555555", origin: "https://heyform.apps.example.com", upstream_state: "upstream-state" });
    expect(started.status).toBe(403);
    expect(started.text).toBe("Google sign-in could not be started.");
    const completed = await request(app).get("/oauth/google/callback").query({ state: "signed-state", code: "provider-code" });
    expect(completed.status).toBe(502);
    expect(completed.text).toBe("Google sign-in could not be completed.");
  });
});
