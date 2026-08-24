import { promises as dns } from "node:dns";
import type { HostnameOwnershipInstructions } from "../shared/types.js";

export interface DomainResolver {
  resolveCname(hostname: string): Promise<string[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
  resolve4?(hostname: string): Promise<string[]>;
}

function normalizeCname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export async function verifyDomain(ownership: HostnameOwnershipInstructions, resolver: DomainResolver = dns) {
  const [txtAnswers, cnameAnswers] = await Promise.all([
    resolver.resolveTxt(ownership.txt.name).catch(() => [] as string[][]),
    resolver.resolveCname(ownership.cname.name).catch(() => [] as string[]),
  ]);
  const observedTxt = txtAnswers.map((chunks) => chunks.join(""));
  const observedCnames = cnameAnswers.map(normalizeCname);
  if (observedTxt.includes(ownership.txt.value)) {
    return { verified: true, method: "TXT" as const, observed: { txt: observedTxt, cname: observedCnames } };
  }
  if (observedCnames.includes(normalizeCname(ownership.cname.value))) {
    return { verified: true, method: "CNAME" as const, observed: { txt: observedTxt, cname: observedCnames } };
  }
  return { verified: false, method: "none" as const, observed: { txt: observedTxt, cname: observedCnames } };
}
