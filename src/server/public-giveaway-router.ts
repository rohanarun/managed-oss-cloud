import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { SuiteRecord, SuiteWorkspace } from "../shared/suite.js";
import { PublicGrowthError, PublicGrowthService } from "./public-growth.js";
import type { SuiteStore } from "./suite-store.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const approvalPattern = /^[A-Za-z0-9._:-]{16,200}$/;
const referralCodePattern = /^[a-f0-9]{16}$/;
const maximumWorkflowRecords = 10_000;

const platformParamsSchema = z.object({
  workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  contestId: z.string().uuid(),
}).strict();

const customDomainParamsSchema = z.object({ contestId: z.string().uuid() }).strict();

const optionalDisplayName = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).max(120).optional(),
);

const optionalReferralCode = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().toLowerCase().regex(referralCodePattern).optional(),
);

const consentGrant = z.union([z.literal(true), z.literal("true"), z.literal("on"), z.literal("1")]).transform(() => true as const);

const publicEntryBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: optionalDisplayName,
  referralCode: optionalReferralCode,
  consent: consentGrant,
}).strict();

const contestDataSchema = z.object({
  description: z.string().max(4_000),
  closesAt: z.string().datetime({ offset: true }),
  rules: z.string().min(1).max(20_000),
  rulesHash: z.string().regex(sha256Pattern),
  consentPolicyVersion: z.string().min(1).max(100),
  prizeDescription: z.string().max(2_000),
  public: z.literal(true),
}).passthrough();

const publicDrawProofShape = {
  algorithm: z.literal("sha256-commit-public-entropy-rejection-v1"),
  seedHash: z.string().regex(sha256Pattern),
  candidatesHash: z.string().regex(sha256Pattern),
  candidateCount: z.number().int().positive(),
  totalWeight: z.number().int().positive(),
  selectedIndex: z.number().int().nonnegative(),
  rejectionCounter: z.number().int().nonnegative(),
  winnerToken: z.string().regex(/^[a-f0-9]{24}$/),
  organizerEntropyReveal: z.string().min(1).max(512),
  publicEntropy: z.string().min(1).max(2_000),
  publicEntropySource: z.string().url().max(2_048).refine(publicHttpsUrl),
  beaconObservedAt: z.string().datetime({ offset: true }),
  reproducible: z.literal(true),
};

const persistedPublicDrawProofSchema = z.object(publicDrawProofShape).strict();
const privateWinnerProofSchema = z.object(publicDrawProofShape).strip();

export interface PublicGiveawayRatePolicy {
  windowMs: number;
  limit: number;
}

export interface PublicGiveawayRouterOptions {
  store: SuiteStore;
  now?: () => Date;
  pageRateLimit?: Partial<PublicGiveawayRatePolicy>;
  entryRateLimit?: Partial<PublicGiveawayRatePolicy>;
}

export interface PublicGiveawayDrawProof {
  algorithm: "sha256-commit-public-entropy-rejection-v1";
  seedHash: string;
  candidatesHash: string;
  candidateCount: number;
  totalWeight: number;
  selectedIndex: number;
  rejectionCounter: number;
  winnerToken: string;
  organizerEntropyReveal: string;
  publicEntropy: string;
  publicEntropySource: string;
  beaconObservedAt: string;
  reproducible: true;
}

export interface PublicGiveawayContest {
  id: string;
  name: string;
  description: string;
  prizeDescription: string;
  rules: string;
  rulesHash: string;
  closesAt: string;
  consentPolicyVersion: string;
  state: "open" | "closed" | "draw-pending" | "drawn";
  acceptingEntries: boolean;
  drawnAt?: string;
  drawProof?: PublicGiveawayDrawProof;
}

function publicHttpsUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return parsed.protocol === "https:"
    && !parsed.username
    && !parsed.password
    && (!parsed.port || parsed.port === "443")
    && Boolean(hostname)
    && !hostname.startsWith("[")
    && isIP(hostname) === 0
    && hostname !== "localhost"
    && !hostname.endsWith(".localhost")
    && !hostname.endsWith(".local")
    && !hostname.endsWith(".internal")
    && !hostname.endsWith(".home.arpa");
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function equalCanonical(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function projectionFromProof(record: SuiteRecord, persisted: unknown, contestId: string): PublicGiveawayDrawProof | undefined {
  const publicProof = persistedPublicDrawProofSchema.safeParse(persisted);
  const privateProof = privateWinnerProofSchema.safeParse(record.data);
  if (!publicProof.success || !privateProof.success
    || record.moduleId !== "giveaways"
    || record.recordType !== "winner-proof"
    || record.state !== "selected"
    || record.data.contestId !== contestId
    || typeof record.data.approvalDecisionId !== "string"
    || !approvalPattern.test(record.data.approvalDecisionId)
    || !equalCanonical(publicProof.data, privateProof.data)) return undefined;
  return publicProof.data;
}

async function publicContest(store: SuiteStore, workspace: SuiteWorkspace, contestId: string, now: Date): Promise<PublicGiveawayContest | undefined> {
  const [contests, receipts, winnerProofs] = await Promise.all([
    store.listPublicWorkflowRecords(workspace.slug, { moduleId: "giveaways", recordType: "contest", limit: maximumWorkflowRecords }),
    store.listPublicWorkflowRecords(workspace.slug, { moduleId: "giveaways", recordType: "growth-command-receipt", limit: maximumWorkflowRecords }),
    store.listPublicWorkflowRecords(workspace.slug, { moduleId: "giveaways", recordType: "winner-proof", limit: maximumWorkflowRecords }),
  ]);
  const contest = contests.find((candidate) => candidate.id === contestId);
  const data = contest ? contestDataSchema.safeParse(contest.data) : undefined;
  if (!contest || !data?.success || !["published", "draw-frozen", "drawn"].includes(contest.state) || !contest.title.trim() || contest.title.length > 160) return undefined;

  const publicationReceipt = receipts.find((receipt) => {
    const audit = object(receipt.data.audit);
    return receipt.state === "recorded"
      && receipt.data.actionId === "contest-publish"
      && Array.isArray(receipt.data.resultRecordIds)
      && receipt.data.resultRecordIds.includes(contest.id)
      && typeof audit?.approvalDecisionId === "string"
      && approvalPattern.test(audit.approvalDecisionId);
  });
  if (!publicationReceipt) return undefined;

  const closesAt = new Date(data.data.closesAt);
  const acceptingEntries = contest.state === "published" && closesAt.getTime() > now.getTime();
  let state: PublicGiveawayContest["state"] = acceptingEntries ? "open" : "closed";
  let drawProof: PublicGiveawayDrawProof | undefined;
  let drawnAt: string | undefined;
  if (contest.state === "draw-frozen") state = "draw-pending";
  if (contest.state === "drawn") {
    if (typeof contest.data.winnerProofId !== "string") return undefined;
    const proofRecord = winnerProofs.find((candidate) => candidate.id === contest.data.winnerProofId);
    drawProof = proofRecord ? projectionFromProof(proofRecord, contest.data.publicDrawProof, contest.id) : undefined;
    const parsedDrawnAt = z.string().datetime({ offset: true }).safeParse(contest.data.drawnAt);
    if (!drawProof || !parsedDrawnAt.success) return undefined;
    drawnAt = parsedDrawnAt.data;
    state = "drawn";
  }

  return {
    id: contest.id,
    name: contest.title,
    description: data.data.description,
    prizeDescription: data.data.prizeDescription,
    rules: data.data.rules,
    rulesHash: data.data.rulesHash,
    closesAt: data.data.closesAt,
    consentPolicyVersion: data.data.consentPolicyVersion,
    state,
    acceptingEntries,
    ...(drawnAt ? { drawnAt } : {}),
    ...(drawProof ? { drawProof } : {}),
  };
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function readableTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value));
}

function documentStyles() {
  return `:root{color-scheme:light;--ink:#151912;--muted:#5c6456;--paper:#f6f7ef;--surface:#fffef8;--line:#dce1d2;--accent:#185c3d;--focus:#d0f260}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#e2f5d4 0,transparent 34rem),var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}main{width:min(92vw,72rem);margin:auto;padding:3rem 0 7rem}.brand{font-weight:800;letter-spacing:-.03em}.layout{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(20rem,.95fr);gap:clamp(2rem,7vw,7rem);align-items:start;margin-top:4.5rem}.intro{position:sticky;top:2rem}h1{max-width:13ch;margin:.45rem 0 1rem;font-size:clamp(3.2rem,7vw,6.6rem);line-height:.9;letter-spacing:-.075em}.lede{max-width:38rem;color:var(--muted);font-size:1.08rem}.eyebrow{color:var(--accent);font-weight:800;text-transform:uppercase;letter-spacing:.1em;font-size:.76rem}.card{background:rgba(255,254,248,.94);border:1px solid var(--line);border-radius:1.6rem;padding:clamp(1.3rem,4vw,2.5rem);box-shadow:0 2rem 6rem rgba(39,55,34,.09)}.card+.card{margin-top:1.25rem}h2{margin:.1rem 0 1rem;font-size:clamp(1.7rem,4vw,2.7rem);line-height:1;letter-spacing:-.045em}h3{margin:1.5rem 0 .6rem}.rules{white-space:pre-wrap}.meta{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem;margin:1.4rem 0}.meta dt{color:var(--muted)}.meta dd{margin:0;overflow-wrap:anywhere}.field{margin:0 0 1.4rem}.field label,.field>span{display:block;margin-bottom:.45rem;font-weight:750}.hint,.privacy{display:block;margin-top:.45rem;color:var(--muted);font-size:.88rem}input,button{font:inherit}input:not([type=checkbox]){width:100%;border:1px solid #aeb9a4;border-radius:.8rem;background:#fff;color:var(--ink);padding:.85rem 1rem}input[type=checkbox]{width:1.15rem;height:1.15rem;margin:.2rem .55rem 0 0;flex:0 0 auto}.check{display:flex!important;align-items:flex-start;font-weight:550!important}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}button{border:0;border-radius:999px;padding:.9rem 1.3rem;background:var(--ink);color:#fff;font-weight:800;cursor:pointer}button:hover{background:var(--accent)}code{overflow-wrap:anywhere}.proof{margin-top:1.5rem;border-top:1px solid var(--line);padding-top:1.5rem}.status{display:inline-block;border-radius:999px;background:#e6eddd;padding:.35rem .7rem;color:#294232;font-weight:750}.legal{margin-top:1.5rem;color:var(--muted);font-size:.86rem}.message{max-width:46rem;margin:6rem auto}.message h1{max-width:14ch}.message a{color:var(--accent);font-weight:750}@media(max-width:800px){main{padding-top:2rem}.layout{grid-template-columns:1fr;margin-top:3rem}.intro{position:static}h1{font-size:clamp(3rem,16vw,5.2rem)}}`;
}

function statusLabel(contest: PublicGiveawayContest) {
  if (contest.state === "open") return "Accepting entries";
  if (contest.state === "draw-pending") return "Draw pending";
  if (contest.state === "drawn") return "Winner selected";
  return "Entries closed";
}

function drawProofHtml(contest: PublicGiveawayContest) {
  if (contest.state === "draw-pending") return `<section class="card"><p class="eyebrow">Auditable draw</p><h2>The candidate snapshot is frozen</h2><p>The winner proof has not been published yet. No new entries can change the frozen draw.</p></section>`;
  if (!contest.drawProof) return "";
  const proof = contest.drawProof;
  return `<section class="card"><p class="eyebrow">Auditable draw proof</p><h2>Winner token <code>${escapeHtml(proof.winnerToken)}</code></h2><p>This public token identifies the selected entry without exposing a participant name, email, or private entry identifier.</p><dl class="meta"><dt>Drawn</dt><dd><time datetime="${escapeHtml(contest.drawnAt)}">${escapeHtml(readableTime(contest.drawnAt!))}</time></dd><dt>Algorithm</dt><dd><code>${escapeHtml(proof.algorithm)}</code></dd><dt>Candidate digest</dt><dd><code>${escapeHtml(proof.candidatesHash)}</code></dd><dt>Candidate count</dt><dd>${proof.candidateCount}</dd><dt>Total weight</dt><dd>${proof.totalWeight}</dd><dt>Seed digest</dt><dd><code>${escapeHtml(proof.seedHash)}</code></dd><dt>Selected index</dt><dd>${proof.selectedIndex}</dd><dt>Rejection counter</dt><dd>${proof.rejectionCounter}</dd><dt>Organizer reveal</dt><dd><code>${escapeHtml(proof.organizerEntropyReveal)}</code></dd><dt>Public entropy</dt><dd><code>${escapeHtml(proof.publicEntropy)}</code></dd><dt>Entropy source</dt><dd><code>${escapeHtml(proof.publicEntropySource)}</code></dd><dt>Beacon observed</dt><dd><time datetime="${escapeHtml(proof.beaconObservedAt)}">${escapeHtml(readableTime(proof.beaconObservedAt))}</time></dd></dl></section>`;
}

function contestPage(input: { workspace: SuiteWorkspace; contest: PublicGiveawayContest; entryPath: string; referralCode?: string }) {
  const contest = input.contest;
  const form = contest.acceptingEntries ? `<section class="card"><p class="eyebrow">Enter securely</p><h2>Join the draw</h2><form action="${escapeHtml(input.entryPath)}" method="post"><div class="field"><label for="entry-email">Email</label><input id="entry-email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254" aria-describedby="email-privacy"><small id="email-privacy" class="privacy">Your address is normalized and converted to a private, contest-scoped digest on the server. The raw address is not stored.</small></div><div class="field"><label for="entry-name">Display name <span class="hint">Optional and private to the organizer</span></label><input id="entry-name" name="displayName" autocomplete="name" maxlength="120"></div><div class="field"><label for="entry-referral">Referral code <span class="hint">Optional</span></label><input id="entry-referral" name="referralCode" value="${escapeHtml(input.referralCode ?? "")}" pattern="[a-fA-F0-9]{16}" maxlength="16" autocomplete="off"></div><div class="field"><label class="check" for="entry-consent"><input id="entry-consent" name="consent" type="checkbox" value="on" required> <span>I consent to use of this private entry record for contest administration and, if I provide a referral code, referral attribution under policy ${escapeHtml(contest.consentPolicyVersion)}.</span></label></div><button type="submit">Submit entry</button></form><p class="legal">This records an entry only. It does not send email or claim delivery by another provider.</p></section>` : `<section class="card"><p class="eyebrow">Entry status</p><h2>${escapeHtml(statusLabel(contest))}</h2><p>This public page remains available for the immutable rules and draw status, but it is not accepting entries.</p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(contest.name)} · FairLaunch</title></head><body><main><div class="brand">${escapeHtml(input.workspace.name)} / FairLaunch</div><div class="layout"><header class="intro"><p class="eyebrow">Verified public contest</p><h1>${escapeHtml(contest.name)}</h1>${contest.description ? `<p class="lede">${escapeHtml(contest.description)}</p>` : ""}<p class="status">${escapeHtml(statusLabel(contest))}</p></header><div><section class="card"><p class="eyebrow">Published terms</p>${contest.prizeDescription ? `<h2>${escapeHtml(contest.prizeDescription)}</h2>` : "<h2>Contest rules</h2>"}<dl class="meta"><dt>Entries close</dt><dd><time datetime="${escapeHtml(contest.closesAt)}">${escapeHtml(readableTime(contest.closesAt))}</time></dd><dt>Rules digest</dt><dd><code>${escapeHtml(contest.rulesHash)}</code></dd></dl><h3>Rules</h3><p class="rules">${escapeHtml(contest.rules)}</p></section>${form}${drawProofHtml(contest)}</div></div></main></body></html>`;
}

function messagePage(title: string, message: string, backPath?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · FairLaunch</title></head><body><main><section class="card message"><p class="eyebrow">FairLaunch</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p>${backPath ? `<p><a href="${escapeHtml(backPath)}">Return to contest</a></p>` : ""}</section></main></body></html>`;
}

function setNoStoreHeaders(response: Response) {
  response.set("Cache-Control", "no-store, max-age=0");
  response.set("Pragma", "no-cache");
  response.set("Referrer-Policy", "no-referrer");
  response.set("X-Content-Type-Options", "nosniff");
  response.set("X-Robots-Tag", "noindex, nofollow");
  response.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.set("Cross-Origin-Resource-Policy", "same-origin");
  response.vary("Host");
}

function sendDocument(response: Response, status: number, document: string) {
  const nonce = randomBytes(24).toString("base64url");
  setNoStoreHeaders(response);
  response.set("Content-Security-Policy", `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'none'; style-src 'nonce-${nonce}'`);
  const styledDocument = document.replace("</head>", `<style nonce="${nonce}">${documentStyles()}</style></head>`);
  return response.status(status).type("html").send(styledDocument);
}

function setApiHeaders(response: Response) {
  setNoStoreHeaders(response);
  response.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function wantsJson(request: Request) {
  return Boolean(request.is("application/json")) || request.accepts(["html", "json"]) === "json";
}

function sendEntryError(request: Request, response: Response, status: number, message: string, backPath?: string) {
  if (!wantsJson(request)) return sendDocument(response, status, messagePage("Entry not accepted", message, backPath));
  setApiHeaders(response);
  return response.status(status).json({ error: message });
}

function entryFailure(error: unknown) {
  if (error instanceof PublicGrowthError) {
    if (error.status === 409) return { status: 409, message: "This entry conflicts with an existing entry, referral, or contest policy." };
    return { status: 404, message: "This contest is not accepting entries." };
  }
  if (error instanceof Error && /quota|storage|not accepting more/i.test(error.message)) return { status: 503, message: "This workspace cannot accept more entries right now." };
  return { status: 500, message: "The entry could not be accepted safely." };
}

function policy(input: Partial<PublicGiveawayRatePolicy> | undefined, defaults: PublicGiveawayRatePolicy): PublicGiveawayRatePolicy {
  return {
    windowMs: input?.windowMs ?? defaults.windowMs,
    limit: input?.limit ?? defaults.limit,
  };
}

/**
 * Hosted FairLaunch contest pages and normal-email entry endpoints.
 *
 * This router deliberately does not replace the existing pseudonymous-hash API.
 * It adapts a browser email to that typed public workflow entirely on the server.
 */
export function createPublicGiveawayRouter(options: PublicGiveawayRouterOptions): Router {
  const router = Router({ caseSensitive: true, strict: true });
  const now = options.now ?? (() => new Date());
  const service = new PublicGrowthService(options.store, { now });
  const pagePolicy = policy(options.pageRateLimit, { windowMs: 60_000, limit: 180 });
  const entryPolicy = policy(options.entryRateLimit, { windowMs: 15 * 60_000, limit: 30 });

  const pageLimiter = rateLimit({
    ...pagePolicy,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) => sendDocument(response, 429, messagePage("Contest unavailable", "Too many requests were made for this public contest. Try again later.")),
  });
  const entryLimiter = rateLimit({
    ...entryPolicy,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (request, response) => sendEntryError(request, response, 429, "Too many entry attempts were made. Try again later."),
  });

  router.use(express.json({ limit: "16kb" }));
  router.use(express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 8 }));

  const renderPlatformContest = async (request: Request, response: Response) => {
    const parsed = platformParamsSchema.safeParse(request.params);
    if (!parsed.success) return sendDocument(response, 404, messagePage("Contest not found", "The requested public contest is unavailable."));
    const workspace = await options.store.getWorkspaceBySlug(parsed.data.workspaceSlug);
    const contest = workspace ? await publicContest(options.store, workspace, parsed.data.contestId, now()) : undefined;
    if (!workspace || !contest) return sendDocument(response, 404, messagePage("Contest not found", "The requested public contest is unavailable."));
    const referral = optionalReferralCode.safeParse(request.query.ref);
    const entryPath = `/giveaways/${encodeURIComponent(workspace.slug)}/${encodeURIComponent(contest.id)}/entries`;
    return sendDocument(response, 200, contestPage({ workspace, contest, entryPath, ...(referral.success && referral.data ? { referralCode: referral.data } : {}) }));
  };

  const renderCustomDomainContest = async (request: Request, response: Response) => {
    const parsed = customDomainParamsSchema.safeParse(request.params);
    const workspace = parsed.success ? await options.store.getWorkspaceByCustomDomain(request.hostname.toLowerCase()) : undefined;
    const contest = workspace && parsed.success ? await publicContest(options.store, workspace, parsed.data.contestId, now()) : undefined;
    if (!workspace || !contest) return sendDocument(response, 404, messagePage("Contest not found", "The requested public contest is unavailable."));
    const referral = optionalReferralCode.safeParse(request.query.ref);
    const entryPath = `/giveaways/${encodeURIComponent(contest.id)}/entries`;
    return sendDocument(response, 200, contestPage({ workspace, contest, entryPath, ...(referral.success && referral.data ? { referralCode: referral.data } : {}) }));
  };

  const submit = async (request: Request, response: Response, workspace: SuiteWorkspace | undefined, contestId: string | undefined, backPath?: string) => {
    if (!workspace || !contestId) return sendEntryError(request, response, 404, "This contest is not accepting entries.");
    const contest = await publicContest(options.store, workspace, contestId, now());
    const parsed = publicEntryBodySchema.safeParse(request.body);
    if (!contest) return sendEntryError(request, response, 404, "This contest is not accepting entries.");
    if (!parsed.success) return sendEntryError(request, response, 400, "Provide a valid email, consent, and optional referral code.", backPath);
    const participantKeyHash = hash(`fairlaunch/browser-email/v1:${parsed.data.email}`);
    try {
      const result = await service.enterGiveawayBySlug(workspace.slug, contest.id, {
        participantKeyHash,
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.referralCode ? { referralCode: parsed.data.referralCode } : {}),
        consent: {
          granted: true,
          policyVersion: contest.consentPolicyVersion,
          purposes: ["contest-administration", ...(parsed.data.referralCode ? ["referral-attribution"] : [])],
        },
      });
      if (wantsJson(request)) {
        setApiHeaders(response);
        return response.status(result.replayed ? 200 : 201).json(result);
      }
      const title = result.replayed ? "Entry already confirmed" : "Entry confirmed";
      const message = result.replayed
        ? `The same private entry was already recorded. Your referral code is ${result.referralCode}.`
        : `Your private entry is recorded. Your referral code is ${result.referralCode}.`;
      return sendDocument(response, result.replayed ? 200 : 201, messagePage(title, message, backPath));
    } catch (error) {
      const failure = entryFailure(error);
      return sendEntryError(request, response, failure.status, failure.message, backPath);
    }
  };

  router.get("/giveaways/:workspaceSlug/:contestId", pageLimiter, renderPlatformContest);
  router.post("/giveaways/:workspaceSlug/:contestId/entries", entryLimiter, async (request, response) => {
    const parsed = platformParamsSchema.safeParse(request.params);
    const workspace = parsed.success ? await options.store.getWorkspaceBySlug(parsed.data.workspaceSlug) : undefined;
    const backPath = parsed.success ? `/giveaways/${encodeURIComponent(parsed.data.workspaceSlug)}/${encodeURIComponent(parsed.data.contestId)}` : undefined;
    return submit(request, response, workspace, parsed.success ? parsed.data.contestId : undefined, backPath);
  });
  router.get("/giveaways/:contestId", pageLimiter, renderCustomDomainContest);
  router.post("/giveaways/:contestId/entries", entryLimiter, async (request, response) => {
    const parsed = customDomainParamsSchema.safeParse(request.params);
    const workspace = parsed.success ? await options.store.getWorkspaceByCustomDomain(request.hostname.toLowerCase()) : undefined;
    const backPath = parsed.success ? `/giveaways/${encodeURIComponent(parsed.data.contestId)}` : undefined;
    return submit(request, response, workspace, parsed.success ? parsed.data.contestId : undefined, backPath);
  });

  router.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(error);
    if (error instanceof SyntaxError || object(error)?.type === "entity.too.large") return sendEntryError(request, response, 400, "Provide a valid contest entry request.");
    return next(error);
  });

  return router;
}
