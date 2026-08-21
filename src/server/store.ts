import { randomUUID } from "node:crypto";
import type { Installation } from "../shared/types.js";

export class InstallationStore {
  private readonly installations = new Map<string, Installation>();

  list() {
    return [...this.installations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(input: Omit<Installation, "id" | "createdAt">) {
    const installation: Installation = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.installations.set(installation.id, installation);
    return installation;
  }

  get(id: string) {
    return this.installations.get(id);
  }

  addDomain(id: string, domain: string) {
    const installation = this.installations.get(id);
    if (!installation) return undefined;
    if (!installation.customDomains.includes(domain)) installation.customDomains.push(domain);
    return installation;
  }

  upgrade(id: string, plan: string) {
    const installation = this.installations.get(id);
    if (!installation) return undefined;
    installation.plan = plan;
    return installation;
  }
}
