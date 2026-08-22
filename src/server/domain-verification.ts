import { promises as dns } from "node:dns";

export interface DomainResolver {
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
}

export async function verifyDomain(domain: string, expectedCname: string, platformIPv4: string | undefined, resolver: DomainResolver = dns) {
  const normalize = (value: string) => value.toLowerCase().replace(/\.$/, "");
  const observedCnames = await resolver.resolveCname(domain).catch(() => [] as string[]);
  if (observedCnames.some((value) => normalize(value) === normalize(expectedCname))) return { verified: true, method: "CNAME" as const, observed: observedCnames };
  const observedAddresses = await resolver.resolve4(domain).catch(() => [] as string[]);
  if (platformIPv4 && observedAddresses.includes(platformIPv4)) return { verified: true, method: "A" as const, observed: observedAddresses };
  return { verified: false, method: "none" as const, observed: [...observedCnames, ...observedAddresses] };
}
