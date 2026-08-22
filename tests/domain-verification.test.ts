import { describe, expect, it } from "vitest";
import { verifyDomain, type DomainResolver } from "../src/server/domain-verification";

describe("custom domain verification", () => {
  it("accepts the exact CNAME target", async () => {
    const resolver: DomainResolver = { resolveCname: async () => ["uptime.apps.getsupers.com."], resolve4: async () => [] };
    expect(await verifyDomain("status.example.com", "uptime.apps.getsupers.com", "34.44.230.152", resolver)).toMatchObject({ verified: true, method: "CNAME" });
  });

  it("accepts a direct platform A record but rejects unrelated DNS", async () => {
    const direct: DomainResolver = { resolveCname: async () => [], resolve4: async () => ["34.44.230.152"] };
    expect(await verifyDomain("status.example.com", "uptime.apps.getsupers.com", "34.44.230.152", direct)).toMatchObject({ verified: true, method: "A" });
    const wrong: DomainResolver = { resolveCname: async () => ["other.example.com"], resolve4: async () => ["192.0.2.2"] };
    expect(await verifyDomain("status.example.com", "uptime.apps.getsupers.com", "34.44.230.152", wrong)).toMatchObject({ verified: false });
  });
});
