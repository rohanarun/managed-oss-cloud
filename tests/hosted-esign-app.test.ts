import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { HostedEsignObjectLoader, HostedEsignRateLimiter } from "../src/server/hosted-esign";
import { MemoryRepository } from "../src/server/repository";
import { MemorySuiteStore } from "../src/server/suite-store";

const objectLoader: HostedEsignObjectLoader = {
  async loadExactPdf() {
    throw new Error("No object should be loaded during the mount contract test.");
  },
};

const rateLimiter: HostedEsignRateLimiter = {
  async consume() { return { allowed: true }; },
};

async function application() {
  return createApp({
    repository: new MemoryRepository(),
    suiteStore: new MemorySuiteStore("starter"),
    hostedEsign: {
      objectLoader,
      rateLimiter,
      allowedOrigins: ["https://sign.example.com"],
      clientKey: (request) => request.ip ?? "unavailable",
    },
  });
}

function signerPreflight(app: Awaited<ReturnType<typeof application>>, origin: string) {
  return request(app)
    .options("/api/public/esign/session")
    .set("x-forwarded-proto", "https")
    .set("origin", origin)
    .set("access-control-request-method", "POST")
    .set("access-control-request-headers", "content-type,x-hosted-signer-request");
}

describe("hosted e-signature application mount", () => {
  it("mounts before wildcard public CORS and allows only the exact signer origin", async () => {
    const app = await application();
    const allowed = await signerPreflight(app, "https://sign.example.com");
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://sign.example.com");
    expect(allowed.headers["access-control-allow-origin"]).not.toBe("*");
    expect(allowed.headers["access-control-allow-headers"]).toContain("X-Hosted-Signer-Request");
    expect(allowed.headers["cache-control"]).toContain("no-store");

    const rejected = await signerPreflight(app, "https://attacker.example.com");
    expect(rejected.status).toBe(403);
    expect(rejected.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("fails closed when the production signer dependencies are not configured", async () => {
    const app = await createApp({ repository: new MemoryRepository(), suiteStore: new MemorySuiteStore("starter") });
    const response = await request(app)
      .post("/api/public/esign/session")
      .set("x-forwarded-proto", "https")
      .set("origin", "https://sign.example.com")
      .set("x-hosted-signer-request", "1")
      .send({ workspaceId: "00000000-0000-4000-8000-000000000001", sessionToken: "esig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(response.status).toBe(404);
  });
});
