import { suiteModuleById, suitePlanAllows, type SuiteAiAction, type SuiteRecord } from "../shared/suite.js";
import { suiteAction, type SuiteActionDefinition } from "../shared/suite-actions.js";
import type { SuiteStore } from "./suite-store.js";
import { config } from "./config.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { collabAiContext, executeCollabAction, executeHireAction, hireAiContext } from "./hire-collab-engine.js";
import { executeScheduleFormsFlagsAction } from "./schedule-forms-flags-engine.js";
import { executeCoreBusinessAction } from "./core-business-engine.js";
import { executePremiumBusinessAction } from "./premium-business-store-engine.js";
import { executeFirstPartyGrowthAction } from "./first-party-growth-engine.js";
import { executeEsignAction } from "./esign-engine.js";
import { executeEmailAction } from "./email-engine.js";

export type SuiteActionResult = { kind: "record"; action: SuiteActionDefinition; record: SuiteRecord } | { kind: "ai-action"; action: SuiteActionDefinition; aiAction: SuiteAiAction; records?: SuiteRecord[]; audit?: Record<string, unknown> } | { kind: "command" | "read"; action: SuiteActionDefinition; records: SuiteRecord[]; audit: Record<string, unknown> };

export interface SuiteEngineDependencies {
  now: () => Date;
  resolveTxt: (hostname: string) => Promise<string[][]>;
  resolveHost: (hostname: string) => Promise<string[]>;
  publicBaseUrl?: string;
}

const defaultDependencies: SuiteEngineDependencies = {
  now: () => new Date(),
  resolveTxt,
  resolveHost: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address),
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}

function canonicalJson(value: unknown) { return JSON.stringify(canonicalValue(value)); }
function digest(value: unknown) { return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex"); }
function commandResult(action: SuiteActionDefinition, records: SuiteRecord[], audit: Record<string, unknown>): SuiteActionResult { return { kind: "command", action, records, audit }; }

function inputString(input: Record<string, unknown>, name: string, maxLength = 4_000) {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${name} must be a non-empty string no longer than ${maxLength} characters.`);
  return value.trim();
}

function inputArray(input: Record<string, unknown>, name: string, maximum = 1_000) {
  const value = input[name];
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new Error(`${name} must be a non-empty array with at most ${maximum} items.`);
  return value;
}

function contentHashInput(input: Record<string, unknown>) {
  const value = inputString(input, "contentHash", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("contentHash must be a lowercase SHA-256 digest.");
  return value;
}

function idempotencyKeyInput(input: Record<string, unknown>) {
  const value = inputString(input, "idempotencyKey", 200);
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(value)) throw new Error("idempotencyKey must contain 16 to 200 safe characters.");
  return value;
}

function integerInput(input: Record<string, unknown>, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be a safe integer from ${minimum} to ${maximum}.`);
  return value;
}

function currencyInput(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new Error("currency must be a three-letter uppercase code.");
  return value;
}

function dateTimeInput(input: Record<string, unknown>, name: string) {
  const value = inputString(input, name, 40);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error(`${name} must be an ISO 8601 date-time.`);
  return date;
}

const engineLocks = new Map<string, Promise<void>>();

async function withEngineLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = engineLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  engineLocks.set(key, tail);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (engineLocks.get(key) === tail) engineLocks.delete(key);
  }
}

async function ownedRecord(store: SuiteStore, userId: string, recordId: unknown, moduleId: string, recordType: string, label: string) {
  if (typeof recordId !== "string") throw new Error(`${label} must be a UUID string.`);
  const record = await store.getRecord(userId, recordId);
  if (!record || record.moduleId !== moduleId || record.recordType !== recordType) throw new Error(`${label.replace(/Id$/, "")} not found.`);
  return record;
}

function normalizeDomain(value: unknown) {
  if (typeof value !== "string") throw new Error("domain must be a hostname.");
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  if (candidate.length > 253 || !/^[a-z0-9.-]+$/.test(candidate) || candidate.includes("..")) throw new Error("domain must be a valid public hostname without a scheme or path.");
  const labels = candidate.split(".");
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new Error("domain must be a valid public hostname.");
  if (candidate === "localhost" || candidate.endsWith(".localhost") || candidate.endsWith(".local") || candidate.endsWith(".internal") || candidate === "metadata.google.internal" || isIP(candidate)) throw new Error("domain must be a public DNS hostname.");
  return candidate;
}

function unsafeIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || first === 100 && second >= 64 && second <= 127
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && [0, 2, 168].includes(second)
    || first === 198 && (second === 18 || second === 19 || second === 51)
    || first === 203 && second === 0;
}

function unsafeAddress(address: string) {
  const normalized = address.trim().toLowerCase();
  if (isIP(normalized) === 4) return unsafeIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return unsafeIpv4(mapped);
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("2001:db8:");
}

async function assertPublicHostname(hostname: string, dependencies: SuiteEngineDependencies) {
  const addresses = isIP(hostname) ? [hostname] : await dependencies.resolveHost(hostname);
  if (!addresses.length || addresses.some(unsafeAddress)) throw new Error("The target resolves to a private, reserved, loopback, link-local, or metadata network address.");
  return [...new Set(addresses)].sort();
}

function normalizeOrigin(value: unknown) {
  if (typeof value !== "string") throw new Error("origin must be an HTTP or HTTPS origin.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("origin must be an HTTP or HTTPS origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("origin must contain only an HTTP or HTTPS scheme, public hostname, and optional port.");
  return url.origin;
}

async function boundedUrls(value: unknown, expectedOrigin: string, dependencies: SuiteEngineDependencies, maximum: number) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new Error(`urls must contain between 1 and ${maximum} targets.`);
  const normalized: string[] = [];
  const hosts = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Every scan URL must be a string.");
    let url: URL;
    try { url = new URL(item); } catch { throw new Error("Every scan URL must be a valid HTTP or HTTPS URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== expectedOrigin) throw new Error("Every scan URL must use the configured same-site origin without credentials.");
    hosts.add(url.hostname);
    normalized.push(`${url.origin}${url.pathname}`);
  }
  for (const hostname of hosts) await assertPublicHostname(hostname, dependencies);
  return [...new Set(normalized)];
}

function consentFallback(value: unknown) {
  if (value !== "essential-only" && value !== "prompt-before-optional") throw new Error("fallbackBehavior must be essential-only or prompt-before-optional.");
  return value;
}

function stableKey(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(value)) throw new Error(`${label} must be a stable lowercase key.`);
  return value;
}

function consentPolicySnapshot(input: Record<string, unknown>) {
  const rawPurposes = inputArray(input, "purposes", 100);
  const purposes = rawPurposes.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`purposes[${index}] must be an object.`);
    const source = item as Record<string, unknown>;
    const key = stableKey(source.key, `purposes[${index}].key`);
    const label = inputString(source, "label", 120);
    const description = inputString(source, "description", 1_000);
    if (typeof source.required !== "boolean") throw new Error(`purposes[${index}].required must be boolean.`);
    return { key, label, description, required: source.required };
  });
  const purposeKeys = new Set(purposes.map((purpose) => purpose.key));
  if (purposeKeys.size !== purposes.length) throw new Error("Purpose keys must be unique.");

  const rawServices = input.services;
  if (!Array.isArray(rawServices) || rawServices.length > 200) throw new Error("services must be an array with at most 200 items.");
  const services = rawServices.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`services[${index}] must be an object.`);
    const source = item as Record<string, unknown>;
    if (Object.keys(source).some((key) => ["code", "script", "javascript", "html"].includes(key.toLowerCase()))) throw new Error("Service snapshots cannot contain executable code or HTML.");
    const key = stableKey(source.key, `services[${index}].key`);
    const label = inputString(source, "label", 160);
    const description = inputString(source, "description", 1_000);
    if (!Array.isArray(source.purposeKeys) || !source.purposeKeys.length || source.purposeKeys.some((purposeKey) => typeof purposeKey !== "string" || !purposeKeys.has(purposeKey))) throw new Error(`services[${index}].purposeKeys must reference declared purposes.`);
    const resourceRules = source.resourceRules === undefined ? [] : source.resourceRules;
    if (!Array.isArray(resourceRules) || resourceRules.length > 100 || resourceRules.some((rule) => typeof rule !== "string" || !rule.trim() || rule.length > 500)) throw new Error(`services[${index}].resourceRules must be a bounded string array.`);
    return { key, label, description, purposeKeys: [...new Set(source.purposeKeys as string[])].sort(), resourceRules: [...new Set(resourceRules as string[])].sort() };
  });
  if (new Set(services.map((service) => service.key)).size !== services.length) throw new Error("Service keys must be unique.");
  const locale = inputString(input, "locale", 35);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new Error("locale must be a language tag such as en or en-US.");
  return { purposes, services, fallbackBehavior: consentFallback(input.fallbackBehavior), locale };
}

function consentDecisions(input: Record<string, unknown>, revision: SuiteRecord) {
  const purposes = (revision.data.content as { purposes?: unknown[] } | undefined)?.purposes;
  if (!Array.isArray(purposes) || !purposes.length) throw new Error("The published policy has no valid purpose snapshot.");
  const expected = new Map<string, boolean>();
  for (const item of purposes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("The published purpose snapshot is invalid.");
    const purpose = item as Record<string, unknown>;
    expected.set(String(purpose.key), purpose.required === true);
  }
  const decisions = inputArray(input, "decisions", 100).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`decisions[${index}] must be an object.`);
    const source = item as Record<string, unknown>;
    const key = String(source.key ?? "");
    if (!expected.has(key) || typeof source.allowed !== "boolean") throw new Error(`decisions[${index}] must contain a declared purpose key and boolean allowed value.`);
    if (expected.get(key) && source.allowed !== true) throw new Error(`Required purpose ${key} cannot be rejected by this policy.`);
    return { key, allowed: source.allowed };
  });
  if (new Set(decisions.map((decision) => decision.key)).size !== decisions.length || decisions.length !== expected.size) throw new Error("decisions must contain exactly one choice for every purpose.");
  return decisions.sort((left, right) => left.key.localeCompare(right.key));
}

async function executeConsentCommand(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, dependencies: SuiteEngineDependencies): Promise<SuiteActionResult> {
  const now = dependencies.now().toISOString();
  if (actionId === "site-configure") {
    const site = await ownedRecord(store, userId, input.siteId, "consent", "site", "siteId");
    const domain = normalizeDomain(input.domain);
    const fallbackBehavior = consentFallback(input.fallbackBehavior);
    const duplicate = (await store.listRecords(userId, { moduleId: "consent", recordType: "site", limit: 10_000 })).find((candidate) => candidate.id !== site.id && candidate.data.domain === domain);
    if (duplicate) throw new Error("This domain is already configured in the workspace.");
    const changingDomain = typeof site.data.domain === "string" && site.data.domain !== domain;
    if (changingDomain && (await store.listRecords(userId, { moduleId: "consent", recordType: "policy-revision", limit: 10_000 })).some((revision) => revision.data.siteId === site.id && revision.state === "published")) throw new Error("A site with a published policy cannot change domains; create a new site.");
    const keepsProof = site.data.domain === domain && site.data.verified === true;
    const challenge = keepsProof && typeof site.data.verificationChallenge === "string" ? site.data.verificationChallenge : `supersuite-consent=${randomBytes(18).toString("base64url")}`;
    const updated = await store.updateRecord(userId, site.id, {
      state: keepsProof ? "verified" : "pending-verification",
      data: { domain, canonicalOrigin: `https://${domain}`, fallbackBehavior, verified: keepsProof, verificationMethod: "dns-txt", verificationChallenge: challenge, configuredAt: now },
    });
    if (!updated) throw new Error("The consent site could not be configured.");
    return commandResult(action, [updated], { configuredAt: now, domain, verificationMethod: "dns-txt", proofPreserved: keepsProof });
  }

  if (actionId === "domain-verify") {
    const site = await ownedRecord(store, userId, input.siteId, "consent", "site", "siteId");
    const domain = normalizeDomain(site.data.domain);
    const challenge = typeof site.data.verificationChallenge === "string" ? site.data.verificationChallenge : "";
    if (!challenge) throw new Error("Configure the site before domain verification.");
    let answers: string[][];
    try { answers = await dependencies.resolveTxt(domain); } catch { throw new Error("The DNS TXT verification record could not be resolved."); }
    const observed = answers.map((parts) => parts.join("").trim());
    if (!observed.includes(challenge)) throw new Error("The DNS TXT verification record does not match the issued challenge.");
    const evidenceHash = digest({ domain, challenge, observed: observed.sort() });
    const updated = await store.updateRecord(userId, site.id, { state: "verified", data: { verified: true, domainVerifiedAt: now, domainVerificationEvidenceHash: evidenceHash } });
    if (!updated) throw new Error("Domain verification could not be persisted.");
    return commandResult(action, [updated], { method: "dns-txt", verifiedAt: now, evidenceHash });
  }

  if (actionId === "scan-start") {
    const site = await ownedRecord(store, userId, input.siteId, "consent", "site", "siteId");
    if (typeof site.data.canonicalOrigin !== "string") throw new Error("Configure the site before scanning.");
    const urls = await boundedUrls(input.urls, site.data.canonicalOrigin, dependencies, 50);
    const scan = await store.createRecord(userId, { moduleId: "consent", recordType: "scan-run", title: `Resource scan for ${site.title}`, state: "queued", data: { siteId: site.id, requestedUrls: urls, crawlLimit: urls.length, scannerVersion: "supersuite-consent-1", queuedAt: now, immutableOnCompletion: true } });
    if (!scan) throw new Error("The consent scan could not be queued.");
    return commandResult(action, [scan], { queuedAt: now, pageCount: urls.length, sameOrigin: true });
  }

  if (actionId === "policy-draft") {
    const site = await ownedRecord(store, userId, input.siteId, "consent", "site", "siteId");
    if (typeof site.data.domain !== "string") throw new Error("Configure the site before drafting a policy.");
    const unresolved = (await store.listRecords(userId, { moduleId: "consent", recordType: "resource-observation", limit: 10_000 })).filter((observation) => observation.data.siteId === site.id && observation.data.governed === true && observation.data.classificationState !== "resolved" && observation.data.ignored !== true);
    if (unresolved.length) throw new Error(`Resolve or explicitly ignore ${unresolved.length} governed resource observation(s) before drafting.`);
    const content = consentPolicySnapshot(input);
    const revisions = (await store.listRecords(userId, { moduleId: "consent", recordType: "policy-revision", limit: 10_000 })).filter((revision) => revision.data.siteId === site.id);
    const version = Math.max(0, ...revisions.map((revision) => Number(revision.data.version) || 0)) + 1;
    const contentHash = digest({ siteId: site.id, version, content });
    const revision = await store.createRecord(userId, { moduleId: "consent", recordType: "policy-revision", title: `${site.title} policy v${version}`, state: "draft", data: { siteId: site.id, version, content, contentHash, public: false, createdAt: now } });
    if (!revision) throw new Error("The policy revision could not be created.");
    return commandResult(action, [revision], { version, contentHash, createdAt: now });
  }

  if (actionId === "policy-approve") {
    const revision = await ownedRecord(store, userId, input.revisionId, "consent", "policy-revision", "revisionId");
    const contentHash = contentHashInput(input);
    if (revision.data.contentHash !== contentHash) throw new Error("The approval hash does not match the immutable policy content.");
    if (!["draft", "approved"].includes(revision.state)) throw new Error("Only a draft policy can be approved.");
    if (revision.state === "approved" && revision.data.approvedContentHash === contentHash) return commandResult(action, [revision], { approvedAt: revision.data.approvedAt, contentHash, replayed: true });
    const updated = await store.updateRecord(userId, revision.id, { state: "approved", data: { approvedContentHash: contentHash, approvedAt: now } });
    if (!updated) throw new Error("The policy approval could not be persisted.");
    return commandResult(action, [updated], { approvedAt: now, contentHash });
  }

  if (actionId === "policy-publish") {
    const revision = await ownedRecord(store, userId, input.revisionId, "consent", "policy-revision", "revisionId");
    const contentHash = contentHashInput(input);
    const idempotencyKey = idempotencyKeyInput(input);
    const revisions = await store.listRecords(userId, { moduleId: "consent", recordType: "policy-revision", limit: 10_000 });
    const replay = revisions.find((candidate) => candidate.data.publishIdempotencyKey === idempotencyKey);
    if (replay) {
      if (replay.id !== revision.id || replay.data.contentHash !== contentHash) throw new Error("The publication idempotency key was already used for different content.");
      const audit = replay.data.publishAudit && typeof replay.data.publishAudit === "object" ? replay.data.publishAudit as Record<string, unknown> : { contentHash };
      return commandResult(action, [replay], { ...audit, replayed: true });
    }
    if (revision.state !== "approved" || revision.data.approvedContentHash !== contentHash || revision.data.contentHash !== contentHash) throw new Error("Only the exact approved policy content can be published.");
    const site = await ownedRecord(store, userId, revision.data.siteId, "consent", "site", "siteId");
    if (site.data.verified !== true || site.state !== "verified") throw new Error("A production policy cannot be published until its domain is verified.");
    const auditId = randomUUID();
    const integrityDigest = digest({ revisionId: revision.id, siteId: site.id, contentHash, version: revision.data.version });
    const publishAudit = { auditId, publishedAt: now, contentHash, integrityDigest, siteId: site.id, version: revision.data.version };
    for (const current of revisions.filter((candidate) => candidate.id !== revision.id && candidate.data.siteId === site.id && candidate.state === "published")) {
      const superseded = await store.updateRecord(userId, current.id, { state: "superseded", data: { public: false, supersededAt: now, supersededByRevisionId: revision.id } });
      if (!superseded) throw new Error("The prior active policy could not be superseded.");
    }
    const published = await store.updateRecord(userId, revision.id, { state: "published", data: { public: true, publishedAt: now, publishIdempotencyKey: idempotencyKey, integrityDigest, publishAudit } });
    if (!published) throw new Error("The policy publication could not be persisted.");
    return commandResult(action, [published], publishAudit);
  }

  if (actionId === "choice-record") {
    const site = await ownedRecord(store, userId, input.siteId, "consent", "site", "siteId");
    const revision = await ownedRecord(store, userId, input.revisionId, "consent", "policy-revision", "revisionId");
    if (revision.state !== "published" || revision.data.public !== true || revision.data.siteId !== site.id) throw new Error("Choices must reference the active published policy for this site.");
    const active = (await store.listRecords(userId, { moduleId: "consent", recordType: "policy-revision", limit: 10_000 })).find((candidate) => candidate.data.siteId === site.id && candidate.state === "published");
    if (active?.id !== revision.id) throw new Error("Choices must reference the currently active policy revision.");
    const visitorKey = inputString(input, "visitorKey", 512);
    if (visitorKey.length < 16) throw new Error("visitorKey must contain at least 16 characters of site-local entropy.");
    const decisions = consentDecisions(input, revision);
    const visitorKeyHash = digest(`consent-visitor:${site.id}:${visitorKey}`);
    const receipts = (await store.listRecords(userId, { moduleId: "consent", recordType: "consent-receipt", limit: 10_000 })).filter((receipt) => receipt.data.siteId === site.id && receipt.data.visitorKeyHash === visitorKeyHash);
    const priorReceiptId = receipts[0]?.id;
    const signalContext = input.gpc === true ? { gpc: true, source: "Sec-GPC" } : { gpc: false };
    const body = { siteId: site.id, policyRevisionId: revision.id, policyContentHash: revision.data.contentHash, visitorKeyHash, decisions, priorReceiptId, signalContext, createdAt: now };
    const integrityHash = digest(body);
    const receipt = await store.createRecord(userId, { moduleId: "consent", recordType: "consent-receipt", title: `Receipt ${integrityHash.slice(0, 12)}`, state: "active", data: { ...body, integrityHash, sequence: receipts.length + 1 } });
    if (!receipt) throw new Error("The consent receipt could not be appended.");
    return commandResult(action, [receipt], { receiptId: receipt.id, integrityHash, priorReceiptId, appendedAt: now });
  }

  throw new Error("Consent command is not implemented.");
}

function seoDevice(value: unknown) {
  if (value !== "desktop" && value !== "mobile") throw new Error("device must be desktop or mobile.");
  return value;
}

function seoCountry(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z]{2}$/.test(value)) throw new Error("country must be a two-letter uppercase country code.");
  return value;
}

function normalizedQuery(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new Error("query must be a non-empty exact query no longer than 200 characters.");
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

async function seoEvidence(store: SuiteStore, userId: string, site: SuiteRecord, keyword: SuiteRecord, value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((id) => typeof id !== "string")) throw new Error("evidenceIds must contain 1 to 100 record IDs.");
  const ids = [...new Set(value as string[])];
  if (ids.length !== value.length) throw new Error("evidenceIds must not contain duplicates.");
  const records: SuiteRecord[] = [];
  for (const id of ids) {
    const record = await store.getRecord(userId, id);
    const belongsToSite = record?.id === site.id || record?.data.siteId === site.id || record?.data.keywordId === keyword.id || record?.id === keyword.id;
    if (!record || record.moduleId !== "seo" || !belongsToSite) throw new Error("Every evidence record must be workspace-owned SEO evidence for the selected site and keyword.");
    records.push(record);
  }
  return records;
}

const publicSeoEvidenceFields = new Set([
  "siteId", "keywordId", "exactQuery", "country", "device", "locale", "requestedContext", "usageDate",
  "position", "previousPosition", "url", "observedAt", "source", "provenance", "freshness", "missingData",
  "requestedUrls", "maxPages", "redirectPolicy", "contentHash", "version", "outline", "evidenceIds", "targetQuery",
  "issueType", "severity", "description", "status", "resolvedAt", "regressedAt",
]);

function publicSeoEvidenceSnapshot(record: SuiteRecord) {
  const data = Object.fromEntries(Object.entries(record.data).filter(([key]) => publicSeoEvidenceFields.has(key)));
  return canonicalValue({ id: record.id, recordType: record.recordType, title: record.title, state: record.state, data, updatedAt: record.updatedAt });
}

async function seoReportEvidence(store: SuiteStore, userId: string, site: SuiteRecord, value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((id) => typeof id !== "string")) throw new Error("evidenceIds must contain 1 to 100 record IDs.");
  const ids = [...new Set(value as string[])];
  if (ids.length !== value.length) throw new Error("evidenceIds must not contain duplicates.");
  const records: SuiteRecord[] = [];
  for (const id of ids) {
    const record = await store.getRecord(userId, id);
    if (!record || record.moduleId !== "seo" || record.recordType === "report" || (record.id !== site.id && record.data.siteId !== site.id)) {
      throw new Error("Every report evidence record must be workspace-owned SEO evidence for the selected site.");
    }
    records.push(record);
  }
  return records;
}

async function executeSeoCommand(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, dependencies: SuiteEngineDependencies): Promise<SuiteActionResult> {
  const nowDate = dependencies.now();
  const now = nowDate.toISOString();
  if (actionId === "site-configure") {
    const site = await ownedRecord(store, userId, input.siteId, "seo", "site", "siteId");
    const origin = normalizeOrigin(input.origin);
    const hostname = new URL(origin).hostname;
    const resolvedAddresses = await assertPublicHostname(hostname, dependencies);
    const locale = inputString(input, "locale", 35);
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new Error("locale must be a language tag such as en or en-US.");
    const device = seoDevice(input.device);
    const requestedLimit = input.dailyUnitLimit === undefined ? 50 : input.dailyUnitLimit;
    if (!Number.isInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > 10_000) throw new Error("dailyUnitLimit must be an integer from 1 to 10000.");
    const existingKeywords = (await store.listRecords(userId, { moduleId: "seo", recordType: "keyword", limit: 10_000 })).some((keyword) => keyword.data.siteId === site.id);
    if (site.data.origin && site.data.origin !== origin && existingKeywords) throw new Error("A site with keyword history cannot change origin; create a new site.");
    const duplicate = (await store.listRecords(userId, { moduleId: "seo", recordType: "site", limit: 10_000 })).find((candidate) => candidate.id !== site.id && candidate.data.origin === origin);
    if (duplicate) throw new Error("This origin is already configured in the workspace.");
    const updated = await store.updateRecord(userId, site.id, { state: "active", data: { origin, hostname, locale, device, dailyUnitLimit: Number(requestedLimit), ownershipVerified: site.data.origin === origin && site.data.ownershipVerified === true, configuredAt: now } });
    if (!updated) throw new Error("The SEO site could not be configured.");
    return commandResult(action, [updated], { configuredAt: now, origin, resolvedAddresses, dailyUnitLimit: Number(requestedLimit) });
  }

  if (actionId === "keyword-add") {
    const site = await ownedRecord(store, userId, input.siteId, "seo", "site", "siteId");
    if (site.state !== "active" || typeof site.data.origin !== "string") throw new Error("Configure the SEO site before adding keywords.");
    const query = inputString(input, "query", 200).replace(/\s+/g, " ");
    const normalizedKey = normalizedQuery(query);
    const country = seoCountry(input.country);
    const device = seoDevice(input.device);
    const duplicate = (await store.listRecords(userId, { moduleId: "seo", recordType: "keyword", limit: 10_000 })).find((keyword) => keyword.data.siteId === site.id && keyword.data.normalizedKey === normalizedKey && keyword.data.country === country && keyword.data.device === device && keyword.state !== "retired");
    if (duplicate) throw new Error("This exact query, country, and device series already exists.");
    const keyword = await store.createRecord(userId, { moduleId: "seo", recordType: "keyword", title: query, state: "active", data: { siteId: site.id, exactQuery: query, normalizedKey, country, device, locale: site.data.locale, immutableQuery: true, createdAt: now } });
    if (!keyword) throw new Error("The keyword series could not be created.");
    return commandResult(action, [keyword], { keywordId: keyword.id, normalizedKey, createdAt: now });
  }

  if (actionId === "rank-run") {
    const keyword = await ownedRecord(store, userId, input.keywordId, "seo", "keyword", "keywordId");
    const site = await ownedRecord(store, userId, keyword.data.siteId, "seo", "site", "siteId");
    const provider = inputString(input, "provider", 64);
    if (provider !== "customer-serp-provider" && provider !== "customer-proxy") throw new Error("provider must be customer-serp-provider or customer-proxy; direct search-engine scraping is not supported.");
    const idempotencyKey = idempotencyKeyInput(input);
    const checks = await store.listRecords(userId, { moduleId: "seo", recordType: "rank-check", limit: 10_000 });
    const replay = checks.find((check) => check.data.idempotencyKey === idempotencyKey);
    if (replay) {
      if (replay.data.keywordId !== keyword.id || replay.data.provider !== provider) throw new Error("The rank-check idempotency key was already used for a different request.");
      return commandResult(action, [replay], { checkId: replay.id, estimatedProviderUnits: replay.data.estimatedProviderUnits, replayed: true, externalCallStarted: false });
    }
    const usageDate = now.slice(0, 10);
    const usedUnits = checks.filter((check) => check.data.siteId === site.id && check.data.usageDate === usageDate).reduce((total, check) => total + (Number(check.data.estimatedProviderUnits) || 0), 0);
    const limit = Number(site.data.dailyUnitLimit) || 50;
    if (usedUnits + 1 > limit) throw new Error(`The daily provider-unit ceiling of ${limit} would be exceeded; no rank check was queued.`);
    const check = await store.createRecord(userId, { moduleId: "seo", recordType: "rank-check", title: `${keyword.title} · ${usageDate}`, state: "queued", data: { siteId: site.id, keywordId: keyword.id, provider, idempotencyKey, usageDate, requestedContext: { country: keyword.data.country, device: keyword.data.device, locale: keyword.data.locale }, estimatedProviderUnits: 1, queuedAt: now, externalCallStarted: false } });
    if (!check) throw new Error("The rank check could not be queued.");
    return commandResult(action, [check], { checkId: check.id, estimatedProviderUnits: 1, usedUnitsBefore: usedUnits, dailyUnitLimit: limit, externalCallStarted: false });
  }

  if (actionId === "audit-start") {
    const site = await ownedRecord(store, userId, input.siteId, "seo", "site", "siteId");
    if (site.state !== "active" || typeof site.data.origin !== "string") throw new Error("Configure the SEO site before starting an audit.");
    const maxPages = input.maxPages === undefined ? Math.min(250, (input.urls as unknown[]).length) : input.maxPages;
    if (!Number.isInteger(maxPages) || Number(maxPages) < 1 || Number(maxPages) > 250) throw new Error("maxPages must be an integer from 1 to 250.");
    const urls = await boundedUrls(input.urls, site.data.origin, dependencies, Number(maxPages));
    const audit = await store.createRecord(userId, { moduleId: "seo", recordType: "audit-run", title: `Content audit for ${site.title}`, state: "queued", data: { siteId: site.id, requestedUrls: urls, maxPages: Number(maxPages), redirectPolicy: "same-origin-public-only", queuedAt: now, externalCallStarted: false } });
    if (!audit) throw new Error("The content audit could not be queued.");
    return commandResult(action, [audit], { auditId: audit.id, maxPages: Number(maxPages), sameOrigin: true, publicNetworkOnly: true, externalCallStarted: false });
  }

  if (actionId === "brief-create") {
    const site = await ownedRecord(store, userId, input.siteId, "seo", "site", "siteId");
    const keyword = await ownedRecord(store, userId, input.keywordId, "seo", "keyword", "keywordId");
    if (keyword.data.siteId !== site.id) throw new Error("The keyword does not belong to the selected site.");
    const evidence = await seoEvidence(store, userId, site, keyword, input.evidenceIds);
    const title = inputString(input, "title", 300);
    const outline = input.outline === undefined ? [] : input.outline;
    if (!Array.isArray(outline) || outline.length > 100 || outline.some((line) => typeof line !== "string" || !line.trim() || line.length > 1_000)) throw new Error("outline must be a bounded string array.");
    const content = { title, outline: outline.map((line) => String(line).trim()), evidenceIds: evidence.map((record) => record.id), targetQuery: keyword.data.exactQuery, siteId: site.id, keywordId: keyword.id };
    const contentHash = digest(content);
    const brief = await store.createRecord(userId, { moduleId: "seo", recordType: "content-brief", title, state: "draft", data: { ...content, contentHash, version: 1, cmsPublished: false, createdAt: now } });
    if (!brief) throw new Error("The content brief could not be created.");
    return commandResult(action, [brief], { briefId: brief.id, contentHash, evidenceCount: evidence.length, createdAt: now });
  }

  if (actionId === "brief-approve") {
    const brief = await ownedRecord(store, userId, input.briefId, "seo", "content-brief", "briefId");
    const contentHash = contentHashInput(input);
    if (brief.data.contentHash !== contentHash) throw new Error("The approval hash does not match the immutable brief content.");
    if (!["draft", "review", "approved"].includes(brief.state)) throw new Error("Only a draft or reviewed brief can be approved.");
    if (brief.state === "approved" && brief.data.approvedContentHash === contentHash) return commandResult(action, [brief], { approvedAt: brief.data.approvedAt, contentHash, cmsPublished: false, replayed: true });
    const approved = await store.updateRecord(userId, brief.id, { state: "approved", data: { approvedContentHash: contentHash, approvedAt: now, cmsPublished: false } });
    if (!approved) throw new Error("The content brief approval could not be persisted.");
    return commandResult(action, [approved], { approvedAt: now, contentHash, cmsPublished: false });
  }

  if (actionId === "report-create") {
    const site = await ownedRecord(store, userId, input.siteId, "seo", "site", "siteId");
    if (site.state !== "active" || typeof site.data.origin !== "string") throw new Error("Configure the SEO site before creating a report.");
    const domain = normalizeDomain(input.domain);
    const customDomain = (await store.listCustomDomains(userId)).find((candidate) => candidate.domain === domain);
    if (!customDomain || !["verified", "active"].includes(customDomain.status)) throw new Error("The report domain must be a verified custom domain owned by this workspace.");
    const title = inputString(input, "title", 300);
    const evidence = await seoReportEvidence(store, userId, site, input.evidenceIds);
    const snapshot = canonicalValue({ site: publicSeoEvidenceSnapshot(site), evidence: evidence.map(publicSeoEvidenceSnapshot) });
    const snapshotHash = digest(snapshot);
    const accessToken = randomBytes(32).toString("base64url");
    const accessTokenHash = digest(accessToken);
    const report = await store.createRecord(userId, {
      moduleId: "seo",
      recordType: "report",
      title,
      state: "published",
      data: { siteId: site.id, domain, snapshot, snapshotHash, accessTokenHash, publishedAt: now, public: false, immutableSnapshot: true },
    });
    if (!report) throw new Error("The SEO report could not be created.");
    return commandResult(action, [report], { reportId: report.id, accessToken, publicUrl: `https://${domain}/api/public/seo/reports/${accessToken}`, snapshotHash, publishedAt: now });
  }

  if (actionId === "report-revoke") {
    const report = await ownedRecord(store, userId, input.reportId, "seo", "report", "reportId");
    if (report.state === "revoked") return commandResult(action, [report], { reportId: report.id, revokedAt: report.data.revokedAt, replayed: true });
    if (report.state !== "published") throw new Error("Only a published SEO report can be revoked.");
    const revoked = await store.updateRecord(userId, report.id, { state: "revoked", data: { revokedAt: now } });
    if (!revoked) throw new Error("The SEO report revocation could not be persisted.");
    return commandResult(action, [revoked], { reportId: revoked.id, revokedAt: now, replayed: false });
  }

  throw new Error("SEO command is not implemented.");
}

async function executeFinanceCreate(store: SuiteStore, userId: string, action: SuiteActionDefinition, input: Record<string, unknown>, dependencies: SuiteEngineDependencies): Promise<SuiteActionResult> {
  const name = inputString(input, "name", 200);
  const currency = currencyInput(input.currency);
  const client = await store.createRecord(userId, { moduleId: "finance", recordType: "client", title: name, state: "active", data: { currency, createdAt: dependencies.now().toISOString(), actionId: action.id } });
  if (!client) throw new Error("The finance client could not be created.");
  return { kind: "record", action, record: client };
}

async function executeFinanceCommand(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, dependencies: SuiteEngineDependencies): Promise<SuiteActionResult> {
  const now = dependencies.now().toISOString();
  if (actionId === "project-create") {
    const client = await ownedRecord(store, userId, input.clientId, "finance", "client", "clientId");
    const name = inputString(input, "name", 200);
    const currency = currencyInput(input.currency);
    if (client.data.currency !== currency) throw new Error("The project currency must match the client billing currency.");
    const billingMethod = inputString(input, "billingMethod", 30);
    if (!["hourly", "fixed", "retainer", "non-billable", "mixed"].includes(billingMethod)) throw new Error("billingMethod is not supported.");
    const project = await store.createRecord(userId, { moduleId: "finance", recordType: "project", title: name, state: "active", data: { clientId: client.id, currency, billingMethod, createdAt: now } });
    if (!project) throw new Error("The finance project could not be created.");
    return commandResult(action, [project], { projectId: project.id, currency, billingMethod, createdAt: now });
  }

  if (actionId === "time-create") {
    const project = await ownedRecord(store, userId, input.projectId, "finance", "project", "projectId");
    if (project.state !== "active" || !["hourly", "mixed"].includes(String(project.data.billingMethod))) throw new Error("This active project does not accept hourly time entries.");
    const activity = inputString(input, "activity", 200);
    const started = dateTimeInput(input, "startedAt");
    const ended = dateTimeInput(input, "endedAt");
    const durationMs = ended.getTime() - started.getTime();
    if (durationMs <= 0 || durationMs > 24 * 60 * 60 * 1_000 || durationMs % 60_000 !== 0) throw new Error("Time entries must be positive whole minutes and no longer than 24 hours.");
    const durationMinutes = durationMs / 60_000;
    const rateMinor = integerInput(input, "rateMinor", 0, 100_000_000);
    const entries = await store.listRecords(userId, { moduleId: "finance", recordType: "time-entry", limit: 10_000 });
    const overlaps = entries.some((entry) => entry.data.contributorUserId === userId && !["rejected", "written_off"].includes(entry.state) && started.getTime() < new Date(String(entry.data.endedAt)).getTime() && ended.getTime() > new Date(String(entry.data.startedAt)).getTime());
    if (overlaps) throw new Error("This time entry overlaps an existing active entry for the contributor.");
    const content = { projectId: project.id, contributorUserId: userId, activity, startedAt: started.toISOString(), endedAt: ended.toISOString(), durationMinutes, rateMinor, currency: project.data.currency };
    const contentHash = digest(content);
    const entry = await store.createRecord(userId, { moduleId: "finance", recordType: "time-entry", title: `${activity} · ${started.toISOString()}`, state: "draft", data: { ...content, contentHash, billable: true, createdAt: now } });
    if (!entry) throw new Error("The time entry could not be created.");
    return commandResult(action, [entry], { entryId: entry.id, contentHash, durationMinutes, createdAt: now });
  }

  if (actionId === "time-submit" || actionId === "time-approve") {
    const entry = await ownedRecord(store, userId, input.entryId, "finance", "time-entry", "entryId");
    const contentHash = contentHashInput(input);
    if (entry.data.contentHash !== contentHash) throw new Error("The time-entry hash does not match the immutable work facts.");
    if (actionId === "time-submit") {
      if (entry.state === "submitted" && entry.data.submittedContentHash === contentHash) return commandResult(action, [entry], { contentHash, submittedAt: entry.data.submittedAt, replayed: true });
      if (entry.state !== "draft") throw new Error("Only a draft time entry can be submitted.");
      const submitted = await store.updateRecord(userId, entry.id, { state: "submitted", data: { submittedContentHash: contentHash, submittedAt: now } });
      if (!submitted) throw new Error("The submitted time entry could not be persisted.");
      return commandResult(action, [submitted], { contentHash, submittedAt: now });
    }
    if (entry.state === "approved" && entry.data.approvedContentHash === contentHash) return commandResult(action, [entry], { contentHash, approvedAt: entry.data.approvedAt, replayed: true });
    if (entry.state !== "submitted" || entry.data.submittedContentHash !== contentHash) throw new Error("Only the exact submitted time-entry version can be approved.");
    const approved = await store.updateRecord(userId, entry.id, { state: "approved", data: { approvedContentHash: contentHash, approvedAt: now } });
    if (!approved) throw new Error("The approved time entry could not be persisted.");
    return commandResult(action, [approved], { contentHash, approvedAt: now });
  }

  if (actionId === "invoice-preview") {
    const project = await ownedRecord(store, userId, input.projectId, "finance", "project", "projectId");
    const client = await ownedRecord(store, userId, project.data.clientId, "finance", "client", "clientId");
    const sourceIds = inputArray(input, "sourceIds", 500);
    if (sourceIds.some((id) => typeof id !== "string") || new Set(sourceIds).size !== sourceIds.length) throw new Error("sourceIds must contain unique record IDs.");
    const issueAt = dateTimeInput(input, "issueAt");
    const dueAt = dateTimeInput(input, "dueAt");
    if (dueAt.getTime() < issueAt.getTime()) throw new Error("dueAt cannot be earlier than issueAt.");
    const sources: SuiteRecord[] = [];
    for (const id of sourceIds as string[]) {
      const source = await ownedRecord(store, userId, id, "finance", "time-entry", "sourceId");
      if (source.data.projectId !== project.id || source.state !== "approved" || source.data.invoiceId) throw new Error("Every invoice source must be approved, uninvoiced time from the selected project.");
      sources.push(source);
    }
    const lines = sources.map((source) => {
      const durationMinutes = Number(source.data.durationMinutes);
      const rateMinor = Number(source.data.rateMinor);
      const numerator = durationMinutes * rateMinor;
      if (!Number.isSafeInteger(durationMinutes) || !Number.isSafeInteger(rateMinor) || !Number.isSafeInteger(numerator)) throw new Error("Invoice source arithmetic exceeds safe integer bounds.");
      const totalMinor = Math.floor((numerator + 30) / 60);
      return { sourceId: source.id, sourceContentHash: source.data.contentHash, description: source.data.activity, quantityMinutes: durationMinutes, hourlyRateMinor: rateMinor, totalMinor };
    });
    const totalMinor = lines.reduce((total, line) => total + line.totalMinor, 0);
    if (!Number.isSafeInteger(totalMinor)) throw new Error("Invoice total exceeds safe integer bounds.");
    const content = { projectId: project.id, clientSnapshot: { id: client.id, name: client.title }, projectSnapshot: { id: project.id, name: project.title }, currency: project.data.currency, issueAt: issueAt.toISOString(), dueAt: dueAt.toISOString(), lines, subtotalMinor: totalMinor, totalMinor };
    const contentHash = digest(content);
    const invoice = await store.createRecord(userId, { moduleId: "finance", recordType: "invoice", title: `Draft invoice for ${client.title}`, state: "draft", data: { ...content, contentHash, balanceMinor: totalMinor, paidMinor: 0, public: false, createdAt: now } });
    if (!invoice) throw new Error("The invoice preview could not be persisted.");
    return commandResult(action, [invoice], { invoiceId: invoice.id, contentHash, currency: project.data.currency, totalMinor, sourceIds, previewedAt: now });
  }

  if (actionId === "invoice-issue") {
    const invoice = await ownedRecord(store, userId, input.invoiceId, "finance", "invoice", "invoiceId");
    const requestedHash = contentHashInput(input);
    const idempotencyKey = idempotencyKeyInput(input);
    return withEngineLock(`finance-issue:${invoice.workspaceId}`, async () => {
      const invoices = await store.listRecords(userId, { moduleId: "finance", recordType: "invoice", limit: 10_000 });
      const replay = invoices.find((candidate) => candidate.data.issueIdempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.id !== invoice.id || replay.data.contentHash !== requestedHash) throw new Error("The issuance idempotency key was already used for a different invoice version.");
        return commandResult(action, [replay], { invoiceId: replay.id, number: replay.data.number, contentHash: requestedHash, replayed: true });
      }
      const current = await ownedRecord(store, userId, invoice.id, "finance", "invoice", "invoiceId");
      if (current.state !== "draft" || current.data.contentHash !== requestedHash) throw new Error("Only the exact draft invoice version can be issued.");
      const sourceIds = Array.isArray(current.data.lines) ? current.data.lines.map((line) => (line as Record<string, unknown>).sourceId) : [];
      const sources: SuiteRecord[] = [];
      for (const sourceId of sourceIds) {
        const source = await ownedRecord(store, userId, sourceId, "finance", "time-entry", "sourceId");
        const expected = (current.data.lines as Record<string, unknown>[]).find((line) => line.sourceId === source.id)?.sourceContentHash;
        if (source.state !== "approved" || source.data.invoiceId || source.data.contentHash !== expected) throw new Error("An invoice source is no longer approved, uninvoiced, or byte-equivalent to the preview.");
        sources.push(source);
      }
      const issueYear = new Date(String(current.data.issueAt)).getUTCFullYear();
      const sequence = Math.max(0, ...invoices.filter((candidate) => Number(candidate.data.issueYear) === issueYear).map((candidate) => Number(candidate.data.sequence) || 0)) + 1;
      const number = `INV-${issueYear}-${String(sequence).padStart(5, "0")}`;
      for (const source of sources) {
        const locked = await store.updateRecord(userId, source.id, { state: "invoiced", data: { invoiceId: current.id, invoicedAt: now } });
        if (!locked) throw new Error("An invoice source could not be locked.");
      }
      const renderingHash = digest({ contentHash: requestedHash, number });
      const issued = await store.updateRecord(userId, current.id, { title: number, state: "issued", data: { number, sequence, issueYear, issueIdempotencyKey: idempotencyKey, issuedContentHash: requestedHash, renderingHash, issuedAt: now } });
      if (!issued) throw new Error("The issued invoice could not be persisted.");
      return commandResult(action, [issued, ...sources], { invoiceId: issued.id, number, contentHash: requestedHash, renderingHash, issuedAt: now, replayed: false });
    });
  }

  if (actionId === "payment-record") {
    const invoice = await ownedRecord(store, userId, input.invoiceId, "finance", "invoice", "invoiceId");
    const amountMinor = integerInput(input, "amountMinor", 1);
    const currency = currencyInput(input.currency);
    const method = inputString(input, "method", 40);
    if (!["manual-bank", "cash", "check", "other"].includes(method)) throw new Error("method must identify an approved manual payment method.");
    const idempotencyKey = idempotencyKeyInput(input);
    return withEngineLock(`finance-payment:${invoice.id}`, async () => {
      const payments = await store.listRecords(userId, { moduleId: "finance", recordType: "payment", limit: 10_000 });
      const replay = payments.find((payment) => payment.data.idempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.data.invoiceId !== invoice.id || replay.data.amountMinor !== amountMinor || replay.data.currency !== currency) throw new Error("The payment idempotency key was already used for a different payment fact.");
        return commandResult(action, [replay], { paymentId: replay.id, replayed: true, providerCallStarted: false });
      }
      const current = await ownedRecord(store, userId, invoice.id, "finance", "invoice", "invoiceId");
      if (!["issued", "partially_paid"].includes(current.state) || current.data.currency !== currency) throw new Error("Payments require an issued invoice in the same currency.");
      const balanceMinor = Number(current.data.balanceMinor);
      if (!Number.isSafeInteger(balanceMinor) || amountMinor > balanceMinor) throw new Error("The payment amount exceeds the invoice balance.");
      const payment = await store.createRecord(userId, { moduleId: "finance", recordType: "payment", title: `Manual payment for ${current.title}`, state: "succeeded", data: { invoiceId: current.id, amountMinor, currency, method, idempotencyKey, effectiveAt: now, source: "authorized-manual", providerCallStarted: false } });
      if (!payment) throw new Error("The payment fact could not be appended.");
      const nextBalance = balanceMinor - amountMinor;
      const updated = await store.updateRecord(userId, current.id, { state: nextBalance === 0 ? "paid" : "partially_paid", data: { paidMinor: Number(current.data.paidMinor) + amountMinor, balanceMinor: nextBalance, lastPaymentId: payment.id } });
      if (!updated) throw new Error("The invoice balance could not be updated.");
      return commandResult(action, [payment, updated], { paymentId: payment.id, invoiceId: updated.id, balanceMinor: nextBalance, replayed: false, providerCallStarted: false });
    });
  }

  throw new Error("Finance command is not implemented.");
}

function notifyKey(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{1,99}$/.test(value)) throw new Error(`${label} must be a stable lowercase dotted key.`);
  return value;
}

function notifyLocale(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) throw new Error("locale must be a language tag such as en or en-US.");
  return value;
}

function notifyTimeZone(value: unknown) {
  if (typeof value !== "string" || value.length > 100) throw new Error("timeZone must be an IANA time zone.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); }
  catch { throw new Error("timeZone must be an IANA time zone."); }
  return value;
}

type NotifySchemaProperty = { type: "string" | "integer" | "number" | "boolean"; maxLength?: number; enum?: Array<string | number | boolean> };
type NotifySchema = { type: "object"; additionalProperties: false; properties: Record<string, NotifySchemaProperty>; required: string[] };

function safeNotifySchema(value: unknown): NotifySchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schema must be an object.");
  const source = value as Record<string, unknown>;
  if (source.type !== "object" || source.additionalProperties !== false || !source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) throw new Error("Event schemas must use type object, explicit properties, and additionalProperties false.");
  if ("$ref" in source || "$defs" in source || "patternProperties" in source) throw new Error("Remote references and executable or unbounded schema features are not supported.");
  const rawProperties = source.properties as Record<string, unknown>;
  const names = Object.keys(rawProperties);
  if (!names.length || names.length > 100) throw new Error("Event schemas must declare 1 to 100 properties.");
  const properties: Record<string, NotifySchemaProperty> = {};
  for (const name of names.sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || /(secret|password|token|authorization|credential|deviceToken|recipientList)/i.test(name)) throw new Error(`Event field ${name} is unsafe or unsupported.`);
    const definition = rawProperties[name];
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error(`Event field ${name} must have a scalar definition.`);
    const item = definition as Record<string, unknown>;
    if (!["string", "integer", "number", "boolean"].includes(String(item.type))) throw new Error(`Event field ${name} must use a supported scalar type.`);
    const normalized: NotifySchemaProperty = { type: item.type as NotifySchemaProperty["type"] };
    if (item.maxLength !== undefined) {
      if (normalized.type !== "string" || !Number.isInteger(item.maxLength) || Number(item.maxLength) < 1 || Number(item.maxLength) > 4_000) throw new Error(`Event field ${name} has an invalid maxLength.`);
      normalized.maxLength = Number(item.maxLength);
    }
    if (item.enum !== undefined) {
      if (!Array.isArray(item.enum) || !item.enum.length || item.enum.length > 100 || item.enum.some((entry) => !["string", "number", "boolean"].includes(typeof entry))) throw new Error(`Event field ${name} has an invalid enum.`);
      normalized.enum = [...new Set(item.enum as Array<string | number | boolean>)];
    }
    properties[name] = normalized;
  }
  const required = source.required === undefined ? [] : source.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !properties[name]) || new Set(required).size !== required.length) throw new Error("schema.required must contain unique declared property names.");
  return { type: "object", additionalProperties: false, properties, required: [...required].sort() as string[] };
}

function validateNotifyPayload(schema: NotifySchema, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload must be an object.");
  const payload = value as Record<string, unknown>;
  const bytes = Buffer.byteLength(canonicalJson(payload), "utf8");
  if (bytes > 64 * 1024) throw new Error("payload exceeds the 64 KiB event limit.");
  for (const required of schema.required) if (!(required in payload)) throw new Error(`payload is missing required field ${required}.`);
  for (const [name, item] of Object.entries(payload)) {
    const definition = schema.properties[name];
    if (!definition) throw new Error(`payload field ${name} is not declared by the published schema.`);
    if (definition.type === "integer" && (!Number.isSafeInteger(item))) throw new Error(`payload field ${name} must be an integer.`);
    if (definition.type === "number" && (typeof item !== "number" || !Number.isFinite(item))) throw new Error(`payload field ${name} must be a finite number.`);
    if (definition.type === "string" && (typeof item !== "string" || item.length > (definition.maxLength ?? 4_000))) throw new Error(`payload field ${name} must be a bounded string.`);
    if (definition.type === "boolean" && typeof item !== "boolean") throw new Error(`payload field ${name} must be boolean.`);
    if (definition.enum && !definition.enum.includes(item as string | number | boolean)) throw new Error(`payload field ${name} is outside its allowed enum.`);
  }
  return { payload: canonicalValue(payload) as Record<string, unknown>, bytes };
}

function safeNotifyTemplate(value: unknown, allowedVariables: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("template must be an object.");
  const source = value as Record<string, unknown>;
  const subject = inputString(source, "subject", 300);
  const body = inputString(source, "body", 10_000);
  if (/<[^>]+>|javascript:|on\w+\s*=/i.test(`${subject}\n${body}`)) throw new Error("Templates are plain text and cannot contain markup, script URLs, or event handlers.");
  const variables = [...`${subject}\n${body}`.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g)].map((match) => match[1]);
  const stripped = `${subject}\n${body}`.replace(/{{\s*[A-Za-z][A-Za-z0-9_]*\s*}}/g, "");
  if (stripped.includes("{{") || stripped.includes("}}") || variables.some((name) => !allowedVariables.has(name))) throw new Error("Templates may reference only declared event variables.");
  return { subject, body, variables: [...new Set(variables)].sort(), format: "plain-text" };
}

function renderNotifyTemplate(template: { subject: string; body: string }, payload: Record<string, unknown>) {
  const render = (value: string) => value.replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g, (_match, name: string) => String(payload[name] ?? ""));
  return { subject: render(template.subject), body: render(template.body) };
}

async function notifySchemaRecord(store: SuiteStore, userId: string, eventKey: string, version: number) {
  const record = (await store.listRecords(userId, { moduleId: "notify", recordType: "event-schema", limit: 10_000 })).find((candidate) => candidate.data.eventKey === eventKey && candidate.data.version === version && candidate.state === "published");
  if (!record) throw new Error("The published event schema version was not found.");
  return record;
}

async function executeNotifyCommand(store: SuiteStore, userId: string, action: SuiteActionDefinition, actionId: string, input: Record<string, unknown>, dependencies: SuiteEngineDependencies): Promise<SuiteActionResult> {
  const now = dependencies.now().toISOString();
  if (actionId === "subscriber-upsert") {
    const externalId = inputString(input, "externalId", 128);
    if (!/^[A-Za-z0-9._:-]{2,128}$/.test(externalId)) throw new Error("externalId contains unsupported characters.");
    const locale = notifyLocale(input.locale);
    const timeZone = notifyTimeZone(input.timeZone);
    const existing = (await store.listRecords(userId, { moduleId: "notify", recordType: "subscriber", limit: 10_000 })).find((subscriber) => subscriber.data.externalId === externalId);
    if (existing) {
      const updated = await store.updateRecord(userId, existing.id, { state: "active", data: { locale, timeZone, profileUpdatedAt: now } });
      if (!updated) throw new Error("The subscriber could not be updated.");
      return commandResult(action, [updated], { subscriberId: updated.id, upsertedAt: now, created: false });
    }
    const subscriber = await store.createRecord(userId, { moduleId: "notify", recordType: "subscriber", title: externalId, state: "active", data: { externalId, locale, timeZone, createdAt: now, hasChannelSecrets: false } });
    if (!subscriber) throw new Error("The subscriber could not be created.");
    return commandResult(action, [subscriber], { subscriberId: subscriber.id, upsertedAt: now, created: true });
  }

  if (actionId === "topic-create") {
    const key = notifyKey(input.key, "key");
    const classification = inputString(input, "classification", 20);
    if (!["required", "optional"].includes(classification)) throw new Error("classification must be required or optional.");
    const channels = inputArray(input, "channels", 5);
    if (channels.some((channel) => typeof channel !== "string" || !["inbox", "email", "sms", "push", "chat"].includes(channel)) || new Set(channels).size !== channels.length) throw new Error("channels contains an unsupported or duplicate channel.");
    const defaultPreference = inputString(input, "defaultPreference", 20);
    if (!["enabled", "disabled"].includes(defaultPreference) || classification === "required" && defaultPreference !== "enabled") throw new Error("Required topics must default to enabled; optional topics use enabled or disabled.");
    const duplicate = (await store.listRecords(userId, { moduleId: "notify", recordType: "topic", limit: 10_000 })).find((topic) => topic.data.key === key && topic.state !== "retired");
    if (duplicate) throw new Error("This notification topic key already exists.");
    const topic = await store.createRecord(userId, { moduleId: "notify", recordType: "topic", title: key, state: "active", data: { key, classification, channels: [...channels].sort(), defaultPreference, createdAt: now } });
    if (!topic) throw new Error("The notification topic could not be created.");
    return commandResult(action, [topic], { topicId: topic.id, key, createdAt: now });
  }

  if (actionId === "schema-publish") {
    const eventKey = notifyKey(input.eventKey, "eventKey");
    const version = integerInput(input, "version", 1, 1_000_000);
    const schema = safeNotifySchema(input.schema);
    const contentHash = digest({ eventKey, version, schema });
    const schemas = await store.listRecords(userId, { moduleId: "notify", recordType: "event-schema", limit: 10_000 });
    const existing = schemas.find((candidate) => candidate.data.eventKey === eventKey && candidate.data.version === version);
    if (existing) {
      if (existing.data.contentHash !== contentHash) throw new Error("This event schema version is already published with different content.");
      return commandResult(action, [existing], { eventKey, version, contentHash, replayed: true });
    }
    const record = await store.createRecord(userId, { moduleId: "notify", recordType: "event-schema", title: `${eventKey}@${version}`, state: "published", data: { eventKey, version, schema, contentHash, immutable: true, publishedAt: now } });
    if (!record) throw new Error("The event schema could not be published.");
    return commandResult(action, [record], { eventKey, version, contentHash, replayed: false, publishedAt: now });
  }

  if (actionId === "workflow-configure") {
    const workflow = await ownedRecord(store, userId, input.workflowId, "notify", "workflow", "workflowId");
    if (workflow.state !== "draft") throw new Error("Only a draft workflow can be configured.");
    const eventKey = notifyKey(input.eventKey, "eventKey");
    const version = integerInput(input, "version", 1, 1_000_000);
    const schemaRecord = await notifySchemaRecord(store, userId, eventKey, version);
    const topicKey = notifyKey(input.topicKey, "topicKey");
    const topic = (await store.listRecords(userId, { moduleId: "notify", recordType: "topic", limit: 10_000 })).find((candidate) => candidate.data.key === topicKey && candidate.state === "active");
    if (!topic) throw new Error("The active notification topic was not found.");
    const channels = inputArray(input, "channels", 5);
    if (channels.length !== 1 || channels[0] !== "inbox" || !(topic.data.channels as unknown[]).includes("inbox")) throw new Error("This provider-free slice supports only the durable inbox channel.");
    const schema = schemaRecord.data.schema as NotifySchema;
    const template = safeNotifyTemplate(input.template, new Set(Object.keys(schema.properties)));
    const content = { eventKey, schemaVersion: version, schemaContentHash: schemaRecord.data.contentHash, topicKey, channels: ["inbox"], template };
    const contentHash = digest(content);
    const configured = await store.updateRecord(userId, workflow.id, { state: "draft", data: { ...content, contentHash, configuredAt: now, externalProvidersConfigured: false } });
    if (!configured) throw new Error("The workflow configuration could not be persisted.");
    return commandResult(action, [configured], { workflowId: configured.id, contentHash, configuredAt: now });
  }

  if (actionId === "workflow-publish") {
    const workflow = await ownedRecord(store, userId, input.workflowId, "notify", "workflow", "workflowId");
    const contentHash = contentHashInput(input);
    if (workflow.data.contentHash !== contentHash) throw new Error("The workflow hash does not match the validated draft content.");
    if (workflow.state === "published" && workflow.data.publishedContentHash === contentHash) return commandResult(action, [workflow], { workflowId: workflow.id, contentHash, publishedAt: workflow.data.publishedAt, replayed: true });
    if (workflow.state !== "draft" || !workflow.data.schemaContentHash || !workflow.data.template) throw new Error("Only a fully configured draft workflow can be published.");
    const duplicate = (await store.listRecords(userId, { moduleId: "notify", recordType: "workflow", limit: 10_000 })).find((candidate) => candidate.id !== workflow.id && candidate.state === "published" && candidate.data.eventKey === workflow.data.eventKey && candidate.data.schemaVersion === workflow.data.schemaVersion);
    if (duplicate) throw new Error("A workflow is already published for this exact event schema version.");
    const published = await store.updateRecord(userId, workflow.id, { state: "published", data: { publishedContentHash: contentHash, publishedAt: now, immutablePublishedVersion: true } });
    if (!published) throw new Error("The workflow could not be published.");
    return commandResult(action, [published], { workflowId: published.id, contentHash, publishedAt: now, replayed: false });
  }

  if (actionId === "preference-set") {
    const subscriber = await ownedRecord(store, userId, input.subscriberId, "notify", "subscriber", "subscriberId");
    const topicKey = notifyKey(input.topicKey, "topicKey");
    const topic = (await store.listRecords(userId, { moduleId: "notify", recordType: "topic", limit: 10_000 })).find((candidate) => candidate.data.key === topicKey && candidate.state === "active");
    if (!topic) throw new Error("The active notification topic was not found.");
    const channel = inputString(input, "channel", 20);
    if (!Array.isArray(topic.data.channels) || !topic.data.channels.includes(channel)) throw new Error("The channel is not allowed for this topic.");
    const decision = inputString(input, "decision", 20);
    if (!["enabled", "disabled"].includes(decision)) throw new Error("decision must be enabled or disabled.");
    if (topic.data.classification === "required" && decision === "disabled") throw new Error("A required operational topic cannot be disabled.");
    const preference = await store.createRecord(userId, { moduleId: "notify", recordType: "preference", title: `${subscriber.title}:${topicKey}:${channel}`, state: "effective", data: { subscriberId: subscriber.id, topicKey, channel, decision, source: "authorized-action", effectiveAt: now } });
    if (!preference) throw new Error("The preference decision could not be appended.");
    return commandResult(action, [preference], { preferenceId: preference.id, effectiveAt: now, decision });
  }

  if (actionId === "event-validate" || actionId === "event-emit") {
    const eventKey = notifyKey(input.eventKey, "eventKey");
    const version = integerInput(input, "version", 1, 1_000_000);
    const schemaRecord = await notifySchemaRecord(store, userId, eventKey, version);
    const validated = validateNotifyPayload(schemaRecord.data.schema as NotifySchema, input.payload);
    const payloadHash = digest(validated.payload);
    if (actionId === "event-validate") return commandResult(action, [], { valid: true, eventKey, version, payloadHash, payloadBytes: validated.bytes, persisted: false, providerCallStarted: false });

    const subscriber = await ownedRecord(store, userId, input.subscriberId, "notify", "subscriber", "subscriberId");
    const idempotencyKey = idempotencyKeyInput(input);
    const events = await store.listRecords(userId, { moduleId: "notify", recordType: "event", limit: 10_000 });
    const replay = events.find((event) => event.data.idempotencyKey === idempotencyKey);
    if (replay) {
      if (replay.data.eventKey !== eventKey || replay.data.version !== version || replay.data.subscriberId !== subscriber.id || replay.data.payloadHash !== payloadHash) throw new Error("The event idempotency key was already used for different immutable event content.");
      const related = (await store.listRecords(userId, { moduleId: "notify", limit: 10_000 })).filter((record) => record.data.eventId === replay.id);
      return commandResult(action, [replay, ...related], { eventId: replay.id, accepted: true, replayed: true, delivered: false, providerCallStarted: false });
    }
    const workflow = (await store.listRecords(userId, { moduleId: "notify", recordType: "workflow", limit: 10_000 })).find((candidate) => candidate.state === "published" && candidate.data.eventKey === eventKey && candidate.data.schemaVersion === version);
    if (!workflow) throw new Error("No published workflow is bound to this event schema version.");
    const topicKey = String(workflow.data.topicKey);
    const topic = (await store.listRecords(userId, { moduleId: "notify", recordType: "topic", limit: 10_000 })).find((candidate) => candidate.data.key === topicKey && candidate.state === "active");
    if (!topic) throw new Error("The workflow topic is unavailable.");
    const preferences = (await store.listRecords(userId, { moduleId: "notify", recordType: "preference", limit: 10_000 })).filter((preference) => preference.data.subscriberId === subscriber.id && preference.data.topicKey === topicKey && preference.data.channel === "inbox");
    const decision = String(preferences[0]?.data.decision ?? topic.data.defaultPreference);
    const event = await store.createRecord(userId, { moduleId: "notify", recordType: "event", title: `${eventKey}@${version}`, state: "accepted", data: { eventKey, version, subscriberId: subscriber.id, payload: validated.payload, payloadHash, idempotencyKey, schemaContentHash: schemaRecord.data.contentHash, immutable: true, acceptedAt: now, providerCallStarted: false } });
    if (!event) throw new Error("The event could not be durably accepted.");
    if (decision === "disabled" && topic.data.classification === "optional") {
      const suppressed = await store.createRecord(userId, { moduleId: "notify", recordType: "notification-run", title: `Suppressed ${event.title}`, state: "suppressed", data: { eventId: event.id, workflowId: workflow.id, subscriberId: subscriber.id, topicKey, channel: "inbox", reason: "subscriber-preference-disabled", evaluatedAt: now, providerCallStarted: false } });
      if (!suppressed) throw new Error("The suppression run could not be persisted.");
      return commandResult(action, [event, suppressed], { eventId: event.id, runId: suppressed.id, accepted: true, replayed: false, suppressed: true, delivered: false, providerCallStarted: false });
    }
    const run = await store.createRecord(userId, { moduleId: "notify", recordType: "notification-run", title: `Inbox run for ${event.title}`, state: "rendering", data: { eventId: event.id, workflowId: workflow.id, subscriberId: subscriber.id, topicKey, channel: "inbox", evaluatedAt: now, providerCallStarted: false } });
    if (!run) throw new Error("The notification run could not be persisted.");
    const rendered = renderNotifyTemplate(workflow.data.template as { subject: string; body: string }, validated.payload);
    const contentHash = digest(rendered);
    const inbox = await store.createRecord(userId, { moduleId: "notify", recordType: "inbox-item", title: rendered.subject, state: "unread", data: { eventId: event.id, runId: run.id, subscriberId: subscriber.id, content: rendered, contentHash, createdAt: now, public: false } });
    if (!inbox) throw new Error("The inbox item could not be persisted.");
    const completed = await store.updateRecord(userId, run.id, { state: "completed", data: { inboxItemId: inbox.id, contentHash, completedAt: now, localDurableDelivery: true } });
    if (!completed) throw new Error("The local inbox run could not be completed.");
    return commandResult(action, [event, completed, inbox], { eventId: event.id, runId: completed.id, inboxItemId: inbox.id, accepted: true, replayed: false, suppressed: false, delivered: false, localInboxCreated: true, providerCallStarted: false });
  }

  throw new Error("Notification command is not implemented.");
}

function validateInput(action: SuiteActionDefinition, input: Record<string, unknown>) {
  const missing = action.requiredFields.filter((field) => input[field] === undefined || input[field] === null || input[field] === "");
  if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}.`);
  if ("email" in input && (typeof input.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))) throw new Error("email must be valid.");
  if ("consent" in input && input.consent !== true) throw new Error("Explicit consent is required.");
  if ("approval" in input && input.approval !== true) throw new Error("Explicit proposal approval is required.");
  for (const field of ["destination", "origin"]) if (field in input) { try { const url = new URL(String(input[field])); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); } catch { throw new Error(`${field} must be an HTTP or HTTPS URL.`); } }
  for (const field of ["scheduledAt", "closesAt", "startedAt", "endedAt", "issueAt", "dueAt", "expiresAt"]) if (field in input && !Number.isFinite(new Date(String(input[field])).getTime())) throw new Error(`${field} must be an ISO date-time.`);
  for (const field of ["links", "lineItems", "sourceIds", "urls", "purposes", "services", "decisions", "evidenceIds", "channels", "pipelineStages", "answers", "ratings", "blocks", "elements", "operations", "selection"]) if (field in input && !Array.isArray(input[field])) throw new Error(`${field} must be an array.`);
  for (const field of ["schema", "payload", "template"]) if (field in input && (!input[field] || typeof input[field] !== "object" || Array.isArray(input[field]))) throw new Error(`${field} must be an object.`);
  for (const field of ["amountMinor", "rateMinor", "version", "expectedVersion", "baseVersion"]) if (field in input && (typeof input[field] !== "number" || !Number.isSafeInteger(input[field]))) throw new Error(`${field} must be a safe integer.`);
  for (const field of ["contentHash", "previewHash"]) if (field in input && (typeof input[field] !== "string" || !/^[a-f0-9]{64}$/.test(input[field]))) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  if ("currency" in input && (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency))) throw new Error("currency must be a three-letter uppercase code.");
  for (const field of ["code", "slug"]) if (field in input && (typeof input[field] !== "string" || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(input[field]))) throw new Error(`${field} must contain lowercase letters, numbers, and hyphens.`);
}

export async function executeSuiteAction(store: SuiteStore, userId: string, moduleId: string, actionId: string, input: Record<string, unknown>, dependencies: SuiteEngineDependencies = defaultDependencies): Promise<SuiteActionResult> {
  const action = suiteAction(moduleId, actionId);
  if (!action) throw new Error("Module action not found.");
  const workspace = await store.getOrCreateWorkspace(userId);
  if (!workspace.enabledModuleIds.includes(moduleId)) throw new Error("Enable this module before running actions.");
  const module = suiteModuleById.get(moduleId);
  if (!module || config.SUITE_ENTITLEMENT_MODE !== "unrestricted" && !suitePlanAllows(workspace.plan, module)) throw new Error(`${module?.name ?? moduleId} is locked on the current ${workspace.plan} plan.`);
  if (action.engine === "core") {
    if (!workspace.currentRole) throw new Error("The workspace membership role is unavailable.");
    const result = await executeCoreBusinessAction(store, { userId, workspaceId: workspace.id, role: workspace.currentRole, scopes: ["*"] }, moduleId, actionId, input);
    return { ...result, action } as SuiteActionResult;
  }
  if (action.engine === "premium") {
    if (!workspace.currentRole) throw new Error("The workspace membership role is unavailable.");
    const result = await executePremiumBusinessAction(
      store,
      {
        userId,
        workspaceId: workspace.id,
        role: workspace.currentRole,
        scopes: ["*"],
      },
      moduleId as Parameters<typeof executePremiumBusinessAction>[2],
      actionId as never,
      input,
    );
    return { ...result, action } as SuiteActionResult;
  }
  if (action.engine === "growth") {
    if (!workspace.currentRole) throw new Error("The workspace membership role is unavailable.");
    const result = await executeFirstPartyGrowthAction(
      store,
      {
        userId,
        workspaceId: workspace.id,
        role: workspace.currentRole,
        scopes: ["*"],
      },
      moduleId,
      actionId,
      input,
      {
        now: dependencies.now,
        modelPolicyId: config.AI_MODEL,
        publicBaseUrl: dependencies.publicBaseUrl ?? config.PUBLIC_APP_URL,
      },
    );
    return { ...result, action } as SuiteActionResult;
  }
  if (action.engine === "esign") {
    if (!workspace.currentRole) throw new Error("The workspace membership role is unavailable.");
    const result = await executeEsignAction(
      store,
      {
        userId,
        workspaceId: workspace.id,
        role: workspace.currentRole,
        scopes: ["*"],
      },
      moduleId,
      actionId,
      input,
      {
        now: dependencies.now,
        modelPolicyId: config.AI_MODEL,
      },
    );
    return { ...result, action } as SuiteActionResult;
  }
  if (action.engine === "email") {
    if (!workspace.currentRole) throw new Error("The workspace membership role is unavailable.");
    const result = await executeEmailAction(
      store,
      {
        userId,
        workspaceId: workspace.id,
        role: workspace.currentRole,
        scopes: ["*"],
      },
      moduleId,
      actionId,
      input,
      {
        now: dependencies.now,
        modelPolicyId: config.AI_MODEL,
      },
    );
    return { ...result, action } as SuiteActionResult;
  }
  validateInput(action, input);

  if (action.operation === "command" && moduleId === "consent") return executeConsentCommand(store, userId, action, actionId, input, dependencies);
  if (action.operation === "command" && moduleId === "seo") return executeSeoCommand(store, userId, action, actionId, input, dependencies);
  if (action.operation === "create" && moduleId === "finance" && actionId === "client-create") return executeFinanceCreate(store, userId, action, input, dependencies);
  if (action.operation === "command" && moduleId === "finance") return executeFinanceCommand(store, userId, action, actionId, input, dependencies);
  if (action.operation === "command" && moduleId === "notify") return executeNotifyCommand(store, userId, action, actionId, input, dependencies);
  if (["command", "read"].includes(action.operation) && moduleId === "hire") return executeHireAction(store, userId, action, actionId, input, dependencies);
  if (["command", "read"].includes(action.operation) && moduleId === "collab") return executeCollabAction(store, userId, action, actionId, input, dependencies);
  if (["schedule", "forms", "flags"].includes(moduleId)) return executeScheduleFormsFlagsAction(store, userId, action, actionId, input, dependencies.now);

  if (action.operation === "create") {
    const titleValue = action.titleField ? input[action.titleField] : undefined;
    if (typeof titleValue !== "string" || !titleValue.trim()) throw new Error(`${action.titleField ?? "title"} must be a non-empty string.`);
    const record = await store.createRecord(userId, { moduleId, recordType: action.recordType!, title: titleValue.trim(), state: action.resultingState, data: { ...input, actionId } });
    if (!record) throw new Error("The record could not be created.");
    return { kind: "record", action, record };
  }

  if (action.operation === "update") {
    const recordId = input.recordId;
    if (typeof recordId !== "string") throw new Error("recordId must be a UUID string.");
    const existing = await store.getRecord(userId, recordId);
    if (!existing || existing.moduleId !== moduleId || existing.recordType !== action.recordType) throw new Error("The target record was not found in this module.");
    const record = await store.updateRecord(userId, recordId, { state: action.resultingState, data: { lastActionId: actionId, ...input } });
    if (!record) throw new Error("The record could not be updated.");
    return { kind: "record", action, record };
  }

  if (action.operation !== "ai") throw new Error("The command is not implemented.");
  let aiContext: Record<string, unknown> = { actionId, ...input };
  if (moduleId === "consent" && actionId === "finding-suggest") {
    const observation = await ownedRecord(store, userId, input.observationId, "consent", "resource-observation", "observationId");
    aiContext = { actionId, observationId: observation.id, instruction: input.instruction };
  }
  if (moduleId === "seo" && actionId === "brief-draft") {
    const site = await ownedRecord(store, userId, input.siteId, "seo", "site", "siteId");
    const keyword = await ownedRecord(store, userId, input.keywordId, "seo", "keyword", "keywordId");
    if (keyword.data.siteId !== site.id) throw new Error("The keyword does not belong to the selected site.");
    const evidence = await seoEvidence(store, userId, site, keyword, input.evidenceIds);
    aiContext = { actionId, siteId: site.id, keywordId: keyword.id, evidenceIds: evidence.map((record) => record.id), instruction: input.instruction };
  }
  if (moduleId === "finance" && actionId === "reconciliation-suggest") {
    const invoice = await ownedRecord(store, userId, input.invoiceId, "finance", "invoice", "invoiceId");
    aiContext = { actionId, invoiceId: invoice.id, instruction: input.instruction };
  }
  if (moduleId === "notify" && actionId === "workflow-suggest") {
    const workflow = await ownedRecord(store, userId, input.workflowId, "notify", "workflow", "workflowId");
    aiContext = { actionId, workflowId: workflow.id, instruction: input.instruction };
  }
  if (moduleId === "hire") aiContext = await hireAiContext(store, userId, actionId, input);
  if (moduleId === "collab") aiContext = await collabAiContext(store, userId, actionId, input);
  const goal = action.goalField ? input[action.goalField] : undefined;
  if (typeof goal !== "string" || !goal.trim()) throw new Error(`${action.goalField ?? "goal"} must be a non-empty string.`);
  const aiAction = await store.queueAiAction(userId, { moduleId, goal: goal.trim(), context: aiContext });
  if (!aiAction) throw new Error("The AI action could not be queued.");
  return { kind: "ai-action", action, aiAction };
}
