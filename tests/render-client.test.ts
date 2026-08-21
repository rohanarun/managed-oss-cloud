import { describe, expect, it, vi } from "vitest";
import { RenderClient } from "../src/server/render-client";

describe("RenderClient", () => {
  it("creates an image-backed appliance without exposing the API key in its body", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ service: { id: "srv-1" } }), { status: 201 })) as unknown as typeof fetch;
    const client = new RenderClient({ apiKey: "secret-key", ownerId: "tea-1", region: "oregon", fetcher });
    await client.createAppliance({ name: "customer-one", plan: "starter", imageUrl: "ghcr.io/example/appliance:1", environment: { APP_IDS: "linkding" } });
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.render.com/v1/services");
    expect(JSON.stringify(init.body)).not.toContain("secret-key");
    expect(JSON.parse(init.body as string).serviceDetails.plan).toBe("starter");
  });

  it("updates a server plan through the service API", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ service: { id: "srv-1" } }), { status: 200 })) as unknown as typeof fetch;
    const client = new RenderClient({ apiKey: "secret-key", ownerId: "tea-1", region: "oregon", fetcher });
    await client.updatePlan("srv-1", "standard");
    const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ serviceDetails: { plan: "standard" } });
  });
});
