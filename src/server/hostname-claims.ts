import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { HostnameOwnershipInstructions } from "../shared/types.js";
import { databaseTimestampIso } from "./postgres-values.js";

export type HostnameClaimSurface = "application" | "suite";
export type HostnameClaimStatus = "pending" | "verified" | "active" | "tombstoned";

export interface HostnameClaim {
  id: string;
  hostname: string;
  surface: HostnameClaimSurface;
  ownerUserId: string;
  resourceId: string;
  challengeToken: string;
  status: HostnameClaimStatus;
  createdAt: string;
  lastCheckedAt?: string;
  verifiedAt?: string;
  tombstonedAt?: string;
}

export interface HostnameClaimInput {
  hostname: string;
  surface: HostnameClaimSurface;
  ownerUserId: string;
  resourceId: string;
}

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const hostnamePattern = /^(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

export function normalizeHostname(value: string) {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (hostname.length > 230 || !hostnamePattern.test(hostname) || hostname.split(".").some((label) => label.length > 63 || label.endsWith("-"))) {
    throw new Error("Enter a valid custom hostname with room for its ownership challenge.");
  }
  return hostname;
}

function configuredHostname(value: string | undefined) {
  if (!value) return undefined;
  try {
    const hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname;
    return hostnamePattern.test(hostname.toLowerCase()) ? normalizeHostname(hostname) : undefined;
  } catch {
    return undefined;
  }
}

export function platformOwnedHostnameSuffixes(input: { publicHostTarget: string; controlPlaneDomain?: string; publicAppUrl: string }) {
  return [...new Set([
    normalizeHostname(input.publicHostTarget),
    configuredHostname(input.controlPlaneDomain),
    configuredHostname(input.publicAppUrl),
  ].filter((value): value is string => Boolean(value)))];
}

export function assertCustomerHostname(hostname: string, platformSuffixes: string[]) {
  const normalized = normalizeHostname(hostname);
  if (platformSuffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))) {
    throw new Error("Platform-owned hostnames cannot be claimed as customer domains.");
  }
  return normalized;
}

export function newHostnameClaim(input: HostnameClaimInput, platformSuffixes: string[]): HostnameClaim {
  return {
    id: randomUUID(),
    hostname: assertCustomerHostname(input.hostname, platformSuffixes),
    surface: input.surface,
    ownerUserId: input.ownerUserId,
    resourceId: input.resourceId,
    challengeToken: randomBytes(18).toString("hex"),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export function hostnameOwnershipInstructions(claim: Pick<HostnameClaim, "id" | "hostname" | "challengeToken">, publicHostTarget: string): HostnameOwnershipInstructions {
  const target = normalizeHostname(publicHostTarget);
  return {
    claimId: claim.id,
    txt: {
      type: "TXT",
      name: `_managed-oss.${claim.hostname}`,
      value: `managed-oss-domain-verification=${claim.challengeToken}`,
    },
    cname: {
      type: "CNAME",
      name: claim.hostname,
      value: `${claim.challengeToken}.verify.${target}`,
    },
  };
}

export class MemoryHostnameClaimRegistry {
  private claims = new Map<string, HostnameClaim>();

  claim(input: HostnameClaimInput, platformSuffixes: string[]) {
    let claim = newHostnameClaim(input, platformSuffixes);
    if (this.claims.has(claim.hostname)) return undefined;
    while ([...this.claims.values()].some((existing) => existing.challengeToken === claim.challengeToken)) claim = newHostnameClaim(input, platformSuffixes);
    this.claims.set(claim.hostname, claim);
    return { ...claim };
  }

  import(claim: HostnameClaim) {
    const existing = this.claims.get(claim.hostname);
    if (existing && existing.id !== claim.id) throw new Error(`Duplicate hostname claim detected for ${claim.hostname}.`);
    if ([...this.claims.values()].some((candidate) => candidate.challengeToken === claim.challengeToken && candidate.id !== claim.id)) throw new Error("Duplicate hostname challenge token detected.");
    this.claims.set(claim.hostname, { ...claim });
  }

  get(hostname: string) {
    const claim = this.claims.get(normalizeHostname(hostname));
    return claim ? { ...claim } : undefined;
  }

  setStatus(input: Pick<HostnameClaim, "hostname" | "surface" | "ownerUserId" | "resourceId">, status: Exclude<HostnameClaimStatus, "tombstoned">) {
    const claim = this.claims.get(normalizeHostname(input.hostname));
    if (!claim || claim.status === "tombstoned" || claim.surface !== input.surface || claim.ownerUserId !== input.ownerUserId || claim.resourceId !== input.resourceId) return undefined;
    const checkedAt = new Date().toISOString();
    claim.status = status;
    claim.lastCheckedAt = checkedAt;
    if (["verified", "active"].includes(status)) claim.verifiedAt ??= checkedAt;
    return { ...claim };
  }

  tombstone(input: Pick<HostnameClaim, "hostname" | "surface" | "ownerUserId" | "resourceId">) {
    const claim = this.claims.get(normalizeHostname(input.hostname));
    if (!claim || claim.surface !== input.surface || claim.ownerUserId !== input.ownerUserId || claim.resourceId !== input.resourceId) return false;
    claim.status = "tombstoned";
    claim.tombstonedAt ??= new Date().toISOString();
    return true;
  }
}

export function hostnameClaimFromRow(row: Record<string, unknown>): HostnameClaim {
  return {
    id: String(row.claim_id ?? row.id),
    hostname: String(row.claim_hostname ?? row.hostname),
    surface: String(row.claim_surface ?? row.surface) as HostnameClaimSurface,
    ownerUserId: String(row.claim_owner_user_id ?? row.owner_user_id),
    resourceId: String(row.claim_resource_id ?? row.resource_id),
    challengeToken: String(row.challenge_token),
    status: String(row.claim_status ?? row.status) as HostnameClaimStatus,
    createdAt: databaseTimestampIso(row.claim_created_at ?? row.created_at),
    lastCheckedAt: row.claim_last_checked_at || row.last_checked_at ? databaseTimestampIso(row.claim_last_checked_at ?? row.last_checked_at) : undefined,
    verifiedAt: row.verified_at ? databaseTimestampIso(row.verified_at) : undefined,
    tombstonedAt: row.tombstoned_at ? databaseTimestampIso(row.tombstoned_at) : undefined,
  };
}

export async function insertPostgresHostnameClaim(queryable: Queryable, claim: HostnameClaim) {
  const result = await queryable.query(`
    INSERT INTO global_hostname_claims(id,hostname,surface,owner_user_id,resource_id,challenge_token,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'pending',$7)
    ON CONFLICT(hostname) DO NOTHING
    RETURNING id AS claim_id,hostname AS claim_hostname,surface AS claim_surface,owner_user_id AS claim_owner_user_id,resource_id AS claim_resource_id,challenge_token,status AS claim_status,created_at AS claim_created_at,last_checked_at AS claim_last_checked_at,verified_at,tombstoned_at
  `, [claim.id, claim.hostname, claim.surface, claim.ownerUserId, claim.resourceId, claim.challengeToken, claim.createdAt]);
  return result.rows[0] ? hostnameClaimFromRow(result.rows[0]) : undefined;
}

export async function updatePostgresHostnameClaimStatus(queryable: Queryable, input: Pick<HostnameClaim, "hostname" | "surface" | "ownerUserId" | "resourceId">, status: Exclude<HostnameClaimStatus, "tombstoned">) {
  const result = await queryable.query(`
    UPDATE global_hostname_claims
    SET status=$5,last_checked_at=NOW(),verified_at=CASE WHEN $5 IN ('verified','active') THEN COALESCE(verified_at,NOW()) ELSE verified_at END
    WHERE hostname=$1 AND surface=$2 AND owner_user_id=$3 AND resource_id=$4 AND status<>'tombstoned'
    RETURNING id AS claim_id,hostname AS claim_hostname,surface AS claim_surface,owner_user_id AS claim_owner_user_id,resource_id AS claim_resource_id,challenge_token,status AS claim_status,created_at AS claim_created_at,last_checked_at AS claim_last_checked_at,verified_at,tombstoned_at
  `, [input.hostname, input.surface, input.ownerUserId, input.resourceId, status]);
  return result.rows[0] ? hostnameClaimFromRow(result.rows[0]) : undefined;
}

export async function assertPostgresRegistryHasNoPlatformClaims(queryable: Queryable, platformSuffixes: string[]) {
  const result = await queryable.query("SELECT hostname FROM global_hostname_claims");
  for (const row of result.rows) assertCustomerHostname(String(row.hostname), platformSuffixes);
}
