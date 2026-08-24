import { promises as dns } from "node:dns";

export interface PublicDestinationResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

function ipv4Number(address: string) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  return parts.reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function ipv4InCidr(value: number, base: number, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isGlobalPublicIpv4(address: string) {
  const value = ipv4Number(address);
  if (value === undefined) return false;
  const blocked = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const;
  return !blocked.some(([base, prefix]) => ipv4InCidr(value, ipv4Number(base)!, prefix));
}

function ipv6Words(address: string) {
  if (address.includes("%") || address.includes(".")) return undefined;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const parse = (word: string) => /^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : Number.NaN;
  const parsed = [...left.map(parse), ...right.map(parse)];
  if (parsed.some((word) => !Number.isFinite(word))) return undefined;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return undefined;
  return [...left.map(parse), ...Array(Math.max(0, omitted)).fill(0), ...right.map(parse)] as number[];
}

export function isGlobalPublicIpv6(address: string) {
  const words = ipv6Words(address);
  if (!words || words.length !== 8 || words[0] < 0x2000 || words[0] > 0x3fff) return false;
  if (words[0] === 0x2001) {
    if (words[1] === 0x0000 || words[1] === 0x0002 || words[1] === 0x0db8) return false;
    if ((words[1] & 0xfff0) === 0x0010 || (words[1] & 0xfff0) === 0x0020) return false;
  }
  if (words[0] === 0x2002 || (words[0] === 0x3fff && (words[1] & 0xf000) === 0x0000)) return false;
  return true;
}

function bounded<T>(operation: Promise<T>, milliseconds = 2_000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Public destination DNS lookup timed out.")), milliseconds);
    timer.unref?.();
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function resolveAddressFamily(operation: Promise<string[]>) {
  try {
    return await bounded(operation);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw error;
  }
}

export async function resolvePublicHttpsDestination(value: unknown, resolver: PublicDestinationResolver = dns) {
  let url: URL;
  try { url = new URL(String(value)); } catch { return undefined; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !hostname || hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) return undefined;
  let ipv4: string[];
  let ipv6: string[];
  try {
    [ipv4, ipv6] = await Promise.all([
      resolveAddressFamily(resolver.resolve4(hostname)),
      resolveAddressFamily(resolver.resolve6(hostname)),
    ]);
  } catch {
    return undefined;
  }
  const addresses = [
    ...ipv4.map((address) => ({ family: 4, address })),
    ...ipv6.map((address) => ({ family: 6, address })),
  ];
  if (!addresses.length || addresses.some((entry) => entry.family === 4 ? !isGlobalPublicIpv4(entry.address) : !isGlobalPublicIpv6(entry.address))) return undefined;
  return url.toString();
}
