import { describe, expect, it } from "vitest";
import { renderGatewayCaddyfile } from "../src/server/gateway-reconciler";

describe("gateway configuration", () => {
  it("routes customer hostnames to private workers while preserving the app host", () => {
    const rendered = renderGatewayCaddyfile([{ hostname: "calendar.customer.example", upstreamHost: "cal-123.apps.example.com", workerPrivateAddress: "10.70.0.12", workerNodeId: "worker-three" }], { controlPlaneDomain: "cloud.getsupers.com", platformIpv4: "34.44.230.152", controlPlaneUpstream: "control-plane:8787" });
    expect(rendered).toContain("calendar.customer.example");
    expect(rendered).toContain("reverse_proxy http://10.70.0.12:8080");
    expect(rendered).toContain("header_up Host cal-123.apps.example.com");
    expect(rendered).toContain("cloud.getsupers.com");
  });

  it("rejects public worker addresses and duplicate hostnames", () => {
    expect(() => renderGatewayCaddyfile([{ hostname: "app.example.com", upstreamHost: "app.apps.example.com", workerPrivateAddress: "8.8.8.8", workerNodeId: "worker" }], { controlPlaneUpstream: "control-plane:8787" })).toThrow(/not private/);
    expect(() => renderGatewayCaddyfile([
      { hostname: "app.example.com", upstreamHost: "one.apps.example.com", workerPrivateAddress: "10.0.0.1", workerNodeId: "one" },
      { hostname: "app.example.com", upstreamHost: "two.apps.example.com", workerPrivateAddress: "10.0.0.2", workerNodeId: "two" },
    ], { controlPlaneUpstream: "control-plane:8787" })).toThrow(/Duplicate/);
  });
});
