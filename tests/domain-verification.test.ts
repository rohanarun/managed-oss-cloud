import { describe, expect, it, vi } from "vitest";
import { verifyDomain, type DomainResolver } from "../src/server/domain-verification";
import { hostnameOwnershipInstructions, newHostnameClaim } from "../src/server/hostname-claims";

const ownership = () => hostnameOwnershipInstructions(newHostnameClaim({ hostname: "status.example.com", surface: "application", ownerUserId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222" }, ["apps.getsupers.com"]), "apps.getsupers.com");

describe("custom domain verification", () => {
  it("accepts the exact CNAME target", async () => {
    const expected = ownership();
    const resolver: DomainResolver = { resolveCname: async () => [`${expected.cname.value}.`], resolveTxt: async () => [] };
    expect(await verifyDomain(expected, resolver)).toMatchObject({ verified: true, method: "CNAME" });
  });

  it("accepts the exact TXT challenge, including split DNS character strings", async () => {
    const expected = ownership();
    const split = Math.floor(expected.txt.value.length / 2);
    const resolver: DomainResolver = { resolveCname: async () => [], resolveTxt: async () => [[expected.txt.value.slice(0, split), expected.txt.value.slice(split)]] };
    expect(await verifyDomain(expected, resolver)).toMatchObject({ verified: true, method: "TXT" });
  });

  it("rejects A-only routing and never consults address records", async () => {
    const expected = ownership();
    const resolve4 = vi.fn(async () => ["34.44.230.152"]);
    const resolver: DomainResolver = { resolveCname: async () => [], resolveTxt: async () => [], resolve4 };
    expect(await verifyDomain(expected, resolver)).toMatchObject({ verified: false, method: "none" });
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("rejects another claim's TXT and CNAME values", async () => {
    const expected = ownership();
    const other = ownership();
    const resolver: DomainResolver = { resolveCname: async () => [other.cname.value], resolveTxt: async () => [[other.txt.value]] };
    expect(await verifyDomain(expected, resolver)).toMatchObject({ verified: false, method: "none" });
  });
});
