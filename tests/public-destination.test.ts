import { afterEach, describe, expect, it, vi } from "vitest";
import { isGlobalPublicIpv4, isGlobalPublicIpv6, resolvePublicHttpsDestination, type PublicDestinationResolver } from "../src/server/public-destination";

const resolver = (ipv4: string[], ipv6: string[] = []): PublicDestinationResolver => ({ resolve4: async () => ipv4, resolve6: async () => ipv6 });

afterEach(() => vi.useRealTimers());

describe("public destination resolution", () => {
  it("accepts only hostnames whose complete current address set is global", async () => {
    expect(await resolvePublicHttpsDestination("https://example.com/path", resolver(["93.184.216.34"], ["2606:2800:220:1:248:1893:25c8:1946"]))).toBe("https://example.com/path");
    expect(await resolvePublicHttpsDestination("https://example.com/path", resolver(["93.184.216.34", "169.254.169.254"]))).toBeUndefined();
    expect(await resolvePublicHttpsDestination("https://example.com/path", resolver([], ["fd00::1"]))).toBeUndefined();
    expect(await resolvePublicHttpsDestination("https://example.com/path", resolver([]))).toBeUndefined();
  });

  it("rejects special, private, documentation, and mapped address families", () => {
    for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.51.100.4", "203.0.113.4", "224.0.0.1"]) expect(isGlobalPublicIpv4(address)).toBe(false);
    expect(isGlobalPublicIpv4("1.1.1.1")).toBe(true);
    for (const address of ["::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002::1", "3fff::1"]) expect(isGlobalPublicIpv6(address)).toBe(false);
    expect(isGlobalPublicIpv6("2606:4700:4700::1111")).toBe(true);
  });

  it("fails closed when either address family has an indeterminate resolver failure", async () => {
    const failedIpv6: PublicDestinationResolver = {
      resolve4: async () => ["93.184.216.34"],
      resolve6: async () => { throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }); },
    };
    expect(await resolvePublicHttpsDestination("https://example.com/path", failedIpv6)).toBeUndefined();

    vi.useFakeTimers();
    const timedOutIpv6: PublicDestinationResolver = {
      resolve4: async () => ["93.184.216.34"],
      resolve6: async () => new Promise<string[]>(() => undefined),
    };
    const pending = resolvePublicHttpsDestination("https://example.com/path", timedOutIpv6);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it("accepts an explicitly absent address family when every returned address is global", async () => {
    const noIpv6: PublicDestinationResolver = {
      resolve4: async () => ["93.184.216.34"],
      resolve6: async () => { throw Object.assign(new Error("no data"), { code: "ENODATA" }); },
    };
    expect(await resolvePublicHttpsDestination("https://example.com/path", noIpv6)).toBe("https://example.com/path");
  });
});
