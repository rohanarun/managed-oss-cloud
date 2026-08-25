import { createHash, randomBytes as systemRandomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z, ZodError } from "zod";
import { suiteModuleById, suitePlanAllows, type SuiteRecord, type SuiteWorkspace } from "../shared/suite.js";
import { executeCoreBusinessAction, type CoreBusinessAuthorization, type CoreBusinessExecutionResult } from "./core-business-engine.js";
import type { SuiteStore } from "./suite-store.js";

const feedbackModuleId = "feedback";
const publicRecordLimit = 10_000;
const voterCookieName = "idealoop_voter";
const voterCookiePattern = /^[A-Za-z0-9_-]{32,128}$/;
const voterHashPattern = /^[a-f0-9]{64}$/;
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{16,200}$/);
const uuidSchema = z.string().uuid();
const workspaceSlugSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
const publicRequestStates = new Set(["open", "planned", "in-progress", "shipped", "declined"]);

const requestSubmissionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  problem: z.string().trim().min(1).max(10_000),
  consent: z.preprocess((value) => value === true || value === "true" || value === "on" || value === "1", z.literal(true)),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const voteSubmissionSchema = z.object({
  decision: z.enum(["up", "withdraw"]),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export interface PublicFeedbackRateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface PublicFeedbackRouterOptions {
  suiteStore: SuiteStore;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  writeRateLimit?: PublicFeedbackRateLimitPolicy;
}

export interface IdeaLoopPublicBoard {
  id: string;
  name: string;
  votingPolicy: "members" | "verified-submitters" | "public";
}

export interface IdeaLoopPublicRequest {
  id: string;
  title: string;
  problem: string;
  status: "open" | "planned" | "in-progress" | "shipped" | "declined";
  publicExplanation?: string;
  version: number;
  voteCount: number;
  updatedAt: string;
}

export interface IdeaLoopPublicBoardView {
  schema: "idealoop-public-board.v1";
  board: IdeaLoopPublicBoard;
  requests: IdeaLoopPublicRequest[];
}

interface FeedbackSnapshot extends IdeaLoopPublicBoardView {
  activeVoterRequestIds: Set<string>;
}

interface PublicRouteContext {
  workspace: SuiteWorkspace;
  boardId: string;
  pagePath: string;
  requestPath: string;
  votePath: (requestId: string) => string;
}

class PublicFeedbackError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function securityHeaders(response: Response, nonce: string) {
  response.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate, private");
  response.set("Pragma", "no-cache");
  response.set("Expires", "0");
  response.set("Referrer-Policy", "no-referrer");
  response.set("X-Content-Type-Options", "nosniff");
  response.set("X-Frame-Options", "DENY");
  response.set("X-Robots-Tag", "noindex, nofollow");
  response.set("Cross-Origin-Opener-Policy", "same-origin");
  response.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.vary("Host");
  response.vary("Accept");
  response.set("Content-Security-Policy", `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'nonce-${nonce}'`);
}

function token(randomBytes: (size: number) => Buffer, purpose: "request" | "vote") {
  return `idealoop.${purpose}.${randomBytes(18).toString("base64url")}`;
}

function cookies(request: Request) {
  const values = new Map<string, string>();
  for (const part of (request.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return values;
}

function voterToken(request: Request, response: Response, randomBytes: (size: number) => Buffer) {
  const existing = cookies(request).get(voterCookieName);
  if (existing && voterCookiePattern.test(existing)) return existing;
  const created = randomBytes(32).toString("base64url");
  response.cookie(voterCookieName, created, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.secure,
    maxAge: 365 * 24 * 60 * 60 * 1_000,
    path: "/",
  });
  return created;
}

function voterHash(workspaceId: string, boardId: string, opaqueToken: string) {
  return createHash("sha256").update(`idealoop/voter/v1:${workspaceId}:${boardId}:${opaqueToken}`).digest("hex");
}

function publicBoard(record: SuiteRecord): IdeaLoopPublicBoard | undefined {
  if (record.moduleId !== feedbackModuleId || record.recordType !== "feedback-board" || record.state !== "active" || record.data.visibility !== "public") return undefined;
  if (typeof record.title !== "string" || !record.title.trim() || record.title.length > 160) return undefined;
  if (!new Set(["members", "verified-submitters", "public"]).has(String(record.data.votingPolicy))) return undefined;
  return { id: record.id, name: record.title, votingPolicy: record.data.votingPolicy as IdeaLoopPublicBoard["votingPolicy"] };
}

function publicRequest(record: SuiteRecord, boardId: string, voteCount: number): IdeaLoopPublicRequest | undefined {
  if (record.moduleId !== feedbackModuleId || record.recordType !== "feedback-request" || record.data.boardId !== boardId || record.data.consent !== true || !publicRequestStates.has(record.state)) return undefined;
  if (typeof record.title !== "string" || !record.title.trim() || record.title.length > 300) return undefined;
  if (typeof record.data.problem !== "string" || !record.data.problem.trim() || record.data.problem.length > 10_000) return undefined;
  const version = record.data.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return undefined;
  const explanation = record.data.publicExplanation;
  if (explanation !== undefined && (typeof explanation !== "string" || !explanation.trim() || explanation.length > 2_000)) return undefined;
  return {
    id: record.id,
    title: record.title,
    problem: record.data.problem,
    status: record.state as IdeaLoopPublicRequest["status"],
    ...(typeof explanation === "string" ? { publicExplanation: explanation } : {}),
    version,
    voteCount,
    updatedAt: record.updatedAt,
  };
}

function feedbackEnabled(workspace: SuiteWorkspace) {
  const module = suiteModuleById.get(feedbackModuleId);
  return Boolean(module && workspace.enabledModuleIds.includes(feedbackModuleId) && suitePlanAllows(workspace.plan, module));
}

function notFound() {
  return new PublicFeedbackError("board_not_found", 404, "This public feedback board was not found.");
}

function validUuid(value: unknown) {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function validWorkspaceSlug(value: unknown) {
  const parsed = workspaceSlugSchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function customHostname(request: Request) {
  const hostname = request.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) throw notFound();
  return hostname;
}

function handle(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => handler(request, response).catch(next);
}

function assertSameOriginBrowserWrite(request: Request) {
  const fetchSite = request.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") throw new PublicFeedbackError("cross_site_write_rejected", 403, "Cross-site feedback writes are not accepted.");
  const origin = request.get("origin");
  if (!origin) return;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new PublicFeedbackError("cross_site_write_rejected", 403, "Cross-site feedback writes are not accepted."); }
  const expectedHost = request.get("host")?.toLowerCase();
  if (!expectedHost || !["http:", "https:"].includes(parsed.protocol) || parsed.host.toLowerCase() !== expectedHost) throw new PublicFeedbackError("cross_site_write_rejected", 403, "Cross-site feedback writes are not accepted.");
}

function formRequest(request: Request) {
  return Boolean(request.is("application/x-www-form-urlencoded"));
}

function errorPage(input: { nonce: string; title: string; message: string }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.title)}</title><style nonce="${input.nonce}">:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f6f4ef;color:#17201d;font:17px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}main{width:min(90vw,46rem);margin:12vh auto;padding:clamp(2rem,7vw,5rem);border:1px solid #d8d5cc;border-radius:2rem;background:#fff}h1{font-size:clamp(2.5rem,8vw,5rem);line-height:.95;letter-spacing:-.06em}p{max-width:34rem;color:#52605b}</style></head><body><main><h1>${escapeHtml(input.title)}</h1><p role="alert">${escapeHtml(input.message)}</p></main></body></html>`;
}

function statusLabel(status: IdeaLoopPublicRequest["status"]) {
  return ({ open: "Open", planned: "Planned", "in-progress": "In progress", shipped: "Shipped", declined: "Declined" })[status];
}

function boardStyles() {
  return `:root{color-scheme:light;--ink:#17201d;--muted:#58645f;--line:#d6ddd8;--paper:#f4f6f2;--card:#fff;--accent:#155f49;--soft:#def2e7}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 88% 2%,#d6f5e7 0,transparent 30rem),var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;z-index:2;background:#fff;padding:.75rem 1rem}.shell{width:min(92vw,78rem);margin:0 auto;padding:3rem 0 8rem}.brand{font-weight:800;letter-spacing:-.03em}.hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(20rem,.75fr);gap:clamp(3rem,8vw,8rem);align-items:end;padding:clamp(5rem,10vw,10rem) 0}h1{max-width:62rem;margin:0;font-size:clamp(3.4rem,8vw,7.6rem);line-height:.86;letter-spacing:-.075em}.lede{max-width:30rem;color:var(--muted);font-size:1.1rem}.panel,.request{background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:1.5rem;padding:clamp(1.3rem,3vw,2.2rem);box-shadow:0 1.5rem 5rem rgba(24,43,35,.07)}.panel{margin-bottom:clamp(5rem,10vw,9rem)}.panel h2,.list-heading{margin:.1rem 0 1rem;font-size:clamp(2rem,4vw,3.4rem);line-height:1;letter-spacing:-.055em}.field{margin:0 0 1.25rem}.field label{display:block;margin-bottom:.45rem;font-weight:750}.choice{display:flex!important;gap:.7rem;align-items:flex-start;font-weight:500!important}.choice input{width:1.15rem;height:1.15rem;margin-top:.2rem}input,textarea,button{font:inherit}input:not([type=checkbox]),textarea{width:100%;padding:.85rem 1rem;border:1px solid #aebbb5;border-radius:.75rem;background:#fff;color:var(--ink)}textarea{resize:vertical}input:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid #47b88c;outline-offset:3px}button{border:0;border-radius:999px;background:var(--ink);color:#fff;padding:.8rem 1.15rem;font-weight:800;cursor:pointer}button:hover{background:var(--accent)}.privacy{color:var(--muted);font-size:.9rem}.notice{margin:0 0 2rem;padding:1rem 1.2rem;border:1px solid #9acdb7;border-radius:1rem;background:var(--soft);font-weight:700}.requests{display:grid;gap:1rem}.request-head{display:flex;gap:1rem;align-items:flex-start;justify-content:space-between}.request h3{margin:0;font-size:clamp(1.35rem,3vw,2rem);line-height:1.08;letter-spacing:-.04em}.status{white-space:nowrap;border:1px solid #aac5b9;border-radius:999px;background:var(--soft);padding:.25rem .65rem;font-size:.78rem;font-weight:850;text-transform:uppercase;letter-spacing:.06em}.problem{max-width:56rem;color:#35443e;white-space:pre-wrap}.explanation{max-width:56rem;padding-left:1rem;border-left:3px solid #4c987b;color:var(--muted)}.vote-row{display:flex;align-items:center;gap:.8rem;margin-top:1.35rem}.vote-count{font-variant-numeric:tabular-nums;font-weight:800}.empty{padding:2rem;border:1px dashed #9ea9a4;border-radius:1.2rem;color:var(--muted)}@media(max-width:760px){.shell{padding-top:1.5rem}.hero{grid-template-columns:1fr;padding:5rem 0}.request-head{display:block}.status{display:inline-block;margin-top:.8rem}}`;
}

function renderBoardPage(input: {
  snapshot: FeedbackSnapshot;
  context: PublicRouteContext;
  nonce: string;
  randomBytes: (size: number) => Buffer;
  notice?: "submitted" | "voted";
}) {
  const { board, requests } = input.snapshot;
  const votingAvailable = board.votingPolicy === "public";
  const requestsMarkup = requests.map((item) => {
    const voted = input.snapshot.activeVoterRequestIds.has(item.id);
    const decision = voted ? "withdraw" : "up";
    const button = voted ? "Withdraw vote" : "Vote for this";
    const voteForm = votingAvailable
      ? `<form method="post" action="${escapeHtml(input.context.votePath(item.id))}"><input type="hidden" name="decision" value="${decision}"><input type="hidden" name="idempotencyKey" value="${escapeHtml(token(input.randomBytes, "vote"))}"><button type="submit" aria-label="${escapeHtml(button)}: ${escapeHtml(item.title)}">${button}</button></form>`
      : `<span class="privacy">Voting is limited by this board's ${escapeHtml(board.votingPolicy)} policy.</span>`;
    return `<article class="request"><div class="request-head"><h3>${escapeHtml(item.title)}</h3><span class="status">${escapeHtml(statusLabel(item.status))}</span></div><p class="problem">${escapeHtml(item.problem)}</p>${item.publicExplanation ? `<p class="explanation"><strong>Roadmap update:</strong> ${escapeHtml(item.publicExplanation)}</p>` : ""}<div class="vote-row"><span class="vote-count">${item.voteCount} ${item.voteCount === 1 ? "vote" : "votes"}</span>${voteForm}</div></article>`;
  }).join("");
  const notice = input.notice === "submitted" ? "Your request was submitted." : input.notice === "voted" ? "Your vote was updated." : undefined;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(board.name)} · IdeaLoop</title><style nonce="${input.nonce}">${boardStyles()}</style></head><body><a class="skip" href="#main">Skip to feedback</a><main id="main" class="shell"><div class="brand">IdeaLoop feedback</div><section class="hero" aria-labelledby="board-title"><h1 id="board-title">${escapeHtml(board.name)}</h1><p class="lede">Share a concrete product problem, follow its public roadmap status, and support requests without creating duplicate votes.</p></section>${notice ? `<p class="notice" role="status">${notice}</p>` : ""}<section class="panel" aria-labelledby="submit-title"><h2 id="submit-title">Submit a request</h2><form method="post" action="${escapeHtml(input.context.requestPath)}"><div class="field"><label for="request-title">Short title</label><input id="request-title" name="title" required maxlength="300" autocomplete="off"></div><div class="field"><label for="request-problem">What problem are you trying to solve?</label><textarea id="request-problem" name="problem" required maxlength="10000" rows="6"></textarea></div><div class="field"><label class="choice" for="request-consent"><input id="request-consent" name="consent" type="checkbox" required> I agree that this title and problem statement will appear publicly on this board.</label></div><input type="hidden" name="idempotencyKey" value="${escapeHtml(token(input.randomBytes, "request"))}"><button type="submit">Submit request</button><p class="privacy">Only the title and problem statement are published. Submission consent and command evidence stay private to the workspace.</p></form></section><section aria-labelledby="requests-title"><h2 id="requests-title" class="list-heading">Requests</h2><div class="requests">${requestsMarkup || `<p class="empty">No public requests yet. Submit the first concrete problem above.</p>`}</div></section></main></body></html>`;
}

function safePublicError(error: unknown) {
  if (error instanceof PublicFeedbackError) return error;
  if (error instanceof ZodError) return new PublicFeedbackError("invalid_input", 400, "Check the required feedback fields and try again.");
  if (error instanceof SyntaxError) return new PublicFeedbackError("invalid_input", 400, "The feedback request body is invalid.");
  if (error instanceof Error && error.message === "The idempotency key was already used for a different command.") return new PublicFeedbackError("idempotency_conflict", 409, "That submission key is already bound to different feedback.");
  if (error instanceof Error && /quota|not accepting more|storage limit/i.test(error.message)) return new PublicFeedbackError("board_temporarily_unavailable", 503, "This board cannot accept submissions right now.");
  return new PublicFeedbackError("feedback_unavailable", 503, "The public feedback service is temporarily unavailable.");
}

export function createPublicFeedbackRouter(options: PublicFeedbackRouterOptions): Router {
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? systemRandomBytes;
  const policy = options.writeRateLimit ?? { windowMs: 15 * 60_000, limit: 30 };
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 1 || !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1_000) throw new Error("The public feedback rate-limit policy is invalid.");

  const router = express.Router();
  const routePrefixes = ["/feedback", "/api/public/feedback"];
  router.use(routePrefixes, (request, response, next) => {
    const nonce = randomBytes(18).toString("base64url");
    response.locals.feedbackNonce = nonce;
    securityHeaders(response, nonce);
    next();
  });
  router.use("/api/public/feedback", express.json({ limit: "32kb", strict: true, type: "application/json" }));
  router.use("/api/public/feedback", express.urlencoded({ extended: false, limit: "32kb", type: "application/x-www-form-urlencoded" }));

  const writeLimiter = rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (request) => `${ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? "127.0.0.1")}:${String(request.params.boardId ?? "unknown")}`,
    handler: (request, response) => {
      const safe = new PublicFeedbackError("rate_limited", 429, "Too many feedback writes were attempted. Try again later.");
      response.set("Retry-After", String(Math.max(1, Math.ceil(policy.windowMs / 1_000))));
      if (formRequest(request)) response.status(safe.status).type("html").send(errorPage({ nonce: String(response.locals.feedbackNonce), title: "Please wait", message: safe.message }));
      else response.status(safe.status).json({ error: safe.code, message: safe.message });
    },
  });

  async function workspaceBySlug(value: unknown) {
    const workspace = await options.suiteStore.getWorkspaceBySlug(validWorkspaceSlug(value));
    if (!workspace || !feedbackEnabled(workspace)) throw notFound();
    return workspace;
  }

  async function workspaceByDomain(request: Request) {
    const workspace = await options.suiteStore.getWorkspaceByCustomDomain(customHostname(request));
    if (!workspace || !feedbackEnabled(workspace)) throw notFound();
    return workspace;
  }

  async function platformContext(request: Request): Promise<PublicRouteContext> {
    const workspace = await workspaceBySlug(request.params.workspaceSlug);
    const boardId = validUuid(request.params.boardId);
    return {
      workspace,
      boardId,
      pagePath: `/feedback/${encodeURIComponent(workspace.slug)}/${boardId}`,
      requestPath: `/api/public/feedback/${encodeURIComponent(workspace.slug)}/boards/${boardId}/requests`,
      votePath: (requestId) => `/api/public/feedback/${encodeURIComponent(workspace.slug)}/boards/${boardId}/requests/${requestId}/votes`,
    };
  }

  async function domainContext(request: Request): Promise<PublicRouteContext> {
    const workspace = await workspaceByDomain(request);
    const boardId = validUuid(request.params.boardId);
    return {
      workspace,
      boardId,
      pagePath: `/feedback/${boardId}`,
      requestPath: `/api/public/feedback/boards/${boardId}/requests`,
      votePath: (requestId) => `/api/public/feedback/boards/${boardId}/requests/${requestId}/votes`,
    };
  }

  async function snapshot(context: PublicRouteContext, selectedVoterHash?: string): Promise<FeedbackSnapshot> {
    const record = await options.suiteStore.getRecord(context.workspace.userId, context.boardId);
    const board = record && record.workspaceId === context.workspace.id ? publicBoard(record) : undefined;
    if (!board) throw notFound();
    const [requestRecords, voteRecords] = await Promise.all([
      options.suiteStore.listPublicWorkflowRecords(context.workspace.slug, { moduleId: feedbackModuleId, recordType: "feedback-request", limit: publicRecordLimit + 1 }),
      options.suiteStore.listPublicWorkflowRecords(context.workspace.slug, { moduleId: feedbackModuleId, recordType: "feedback-vote", limit: publicRecordLimit + 1 }),
    ]);
    if (requestRecords.length > publicRecordLimit || voteRecords.length > publicRecordLimit) throw new PublicFeedbackError("board_temporarily_unavailable", 503, "This board is too large to render safely right now.");
    const eligibleRequestIds = new Set(requestRecords.filter((item) => item.data.boardId === board.id && publicRequestStates.has(item.state)).map((item) => item.id));
    const activeVotersByRequest = new Map<string, Set<string>>();
    const activeVoterRequestIds = new Set<string>();
    for (const vote of voteRecords) {
      const requestId = typeof vote.data.requestId === "string" ? vote.data.requestId : "";
      const storedVoterHash = typeof vote.data.voterKeyHash === "string" ? vote.data.voterKeyHash : "";
      if (vote.state !== "active" || !eligibleRequestIds.has(requestId) || !voterHashPattern.test(storedVoterHash)) continue;
      const voters = activeVotersByRequest.get(requestId) ?? new Set<string>();
      voters.add(storedVoterHash);
      activeVotersByRequest.set(requestId, voters);
      if (selectedVoterHash === storedVoterHash) activeVoterRequestIds.add(requestId);
    }
    const requests = requestRecords
      .map((item) => publicRequest(item, board.id, activeVotersByRequest.get(item.id)?.size ?? 0))
      .filter((item): item is IdeaLoopPublicRequest => Boolean(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    return { schema: "idealoop-public-board.v1", board, requests, activeVoterRequestIds };
  }

  function authorization(workspace: SuiteWorkspace): CoreBusinessAuthorization {
    return { userId: workspace.userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
  }

  async function execute(context: PublicRouteContext, actionId: "request-submit" | "vote-cast", input: Record<string, unknown>) {
    return executeCoreBusinessAction(options.suiteStore, authorization(context.workspace), feedbackModuleId, actionId, input, { now, modelPolicyId: "public-feedback-no-model" });
  }

  async function inResolvedWorkspace<T>(context: PublicRouteContext, operation: () => Promise<T>) {
    return options.suiteStore.runInWorkspaceTransaction(context.workspace.userId, async (lockedWorkspace) => {
      if (lockedWorkspace.id !== context.workspace.id || lockedWorkspace.userId !== context.workspace.userId) throw notFound();
      return operation();
    });
  }

  function executionRecord(result: CoreBusinessExecutionResult, type: "feedback-request" | "feedback-vote") {
    const record = result.records.find((item) => item.moduleId === feedbackModuleId && item.recordType === type);
    if (!record) throw new PublicFeedbackError("feedback_unavailable", 503, "The public feedback write could not be confirmed.");
    return record;
  }

  function renderBoard(contextResolver: (request: Request) => Promise<PublicRouteContext>) {
    return handle(async (request, response) => {
      response.locals.feedbackResponseKind = "html";
      const context = await contextResolver(request);
      const opaqueVoter = voterToken(request, response, randomBytes);
      const view = await snapshot(context, voterHash(context.workspace.id, context.boardId, opaqueVoter));
      const notice = request.query.submitted === "1" ? "submitted" : request.query.voted === "1" ? "voted" : undefined;
      response.status(200).type("html").send(renderBoardPage({ snapshot: view, context, nonce: String(response.locals.feedbackNonce), randomBytes, notice }));
    });
  }

  function boardJson(contextResolver: (request: Request) => Promise<PublicRouteContext>) {
    return handle(async (request, response) => {
      const context = await contextResolver(request);
      const view = await snapshot(context);
      response.status(200).json({ schema: view.schema, board: view.board, requests: view.requests } satisfies IdeaLoopPublicBoardView);
    });
  }

  function submitRequest(contextResolver: (request: Request) => Promise<PublicRouteContext>) {
    return handle(async (request, response) => {
      response.locals.feedbackResponseKind = formRequest(request) ? "html" : "json";
      assertSameOriginBrowserWrite(request);
      const context = await contextResolver(request);
      const input = requestSubmissionSchema.parse(request.body);
      const { result, projection } = await inResolvedWorkspace(context, async () => {
        await snapshot(context);
        const result = await execute(context, "request-submit", { boardId: context.boardId, ...input });
        const created = executionRecord(result, "feedback-request");
        const projection = publicRequest(created, context.boardId, 0);
        if (!projection) throw new PublicFeedbackError("feedback_unavailable", 503, "The public feedback write could not be confirmed.");
        return { result, projection };
      });
      if (formRequest(request)) {
        response.redirect(303, `${context.pagePath}?submitted=1`);
        return;
      }
      const replayed = result.audit.replayed === true;
      response.status(replayed ? 200 : 201).json({ schema: "idealoop-request-result.v1", outcome: replayed ? "replayed" : "created", request: projection });
    });
  }

  function submitVote(contextResolver: (request: Request) => Promise<PublicRouteContext>) {
    return handle(async (request, response) => {
      response.locals.feedbackResponseKind = formRequest(request) ? "html" : "json";
      assertSameOriginBrowserWrite(request);
      const context = await contextResolver(request);
      const requestId = validUuid(request.params.requestId);
      const input = voteSubmissionSchema.parse(request.body);
      const opaqueVoter = voterToken(request, response, randomBytes);
      const { result, requestProjection } = await inResolvedWorkspace(context, async () => {
        const view = await snapshot(context);
        if (view.board.votingPolicy !== "public") throw new PublicFeedbackError("public_voting_disabled", 403, "This board does not accept unauthenticated public votes.");
        if (!view.requests.some((item) => item.id === requestId)) throw notFound();
        const result = await execute(context, "vote-cast", { requestId, voterKeyHash: voterHash(context.workspace.id, context.boardId, opaqueVoter), ...input });
        executionRecord(result, "feedback-vote");
        const updated = await snapshot(context);
        const requestProjection = updated.requests.find((item) => item.id === requestId);
        if (!requestProjection) throw notFound();
        return { result, requestProjection };
      });
      if (formRequest(request)) {
        response.redirect(303, `${context.pagePath}?voted=1`);
        return;
      }
      const replayed = result.audit.replayed === true;
      const reconciled = result.audit.reconciled === true;
      response.status(replayed || reconciled ? 200 : 201).json({
        schema: "idealoop-vote-result.v1",
        outcome: replayed ? "replayed" : reconciled ? "reconciled" : "created",
        requestId,
        decision: input.decision,
        voteCount: requestProjection.voteCount,
      });
    });
  }

  router.get("/feedback/:workspaceSlug/:boardId", renderBoard(platformContext));
  router.get("/feedback/:boardId", renderBoard(domainContext));
  router.get("/api/public/feedback/:workspaceSlug/boards/:boardId", boardJson(platformContext));
  router.get("/api/public/feedback/boards/:boardId", boardJson(domainContext));
  router.post("/api/public/feedback/:workspaceSlug/boards/:boardId/requests", writeLimiter, submitRequest(platformContext));
  router.post("/api/public/feedback/boards/:boardId/requests", writeLimiter, submitRequest(domainContext));
  router.post("/api/public/feedback/:workspaceSlug/boards/:boardId/requests/:requestId/votes", writeLimiter, submitVote(platformContext));
  router.post("/api/public/feedback/boards/:boardId/requests/:requestId/votes", writeLimiter, submitVote(domainContext));

  router.use(routePrefixes, (error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const safe = safePublicError(error);
    const html = response.locals.feedbackResponseKind === "html" || formRequest(request) || (request.method === "GET" && request.path.startsWith("/feedback/"));
    if (html) response.status(safe.status).type("html").send(errorPage({ nonce: String(response.locals.feedbackNonce), title: safe.status === 404 ? "Board not found" : "Feedback unavailable", message: safe.message }));
    else response.status(safe.status).json({ error: safe.code, message: safe.message });
  });
  return router;
}

export function publicFeedbackMountContract() {
  return {
    version: "idealoop-public-mount.v1",
    mountPath: "/",
    routes: {
      hostedBoard: "GET /feedback/:workspaceSlug/:boardId",
      customDomainBoard: "GET /feedback/:boardId",
      boardProjection: "GET /api/public/feedback/:workspaceSlug/boards/:boardId",
      customDomainProjection: "GET /api/public/feedback/boards/:boardId",
      requestSubmit: "POST /api/public/feedback/:workspaceSlug/boards/:boardId/requests",
      customDomainRequestSubmit: "POST /api/public/feedback/boards/:boardId/requests",
      voteCast: "POST /api/public/feedback/:workspaceSlug/boards/:boardId/requests/:requestId/votes",
      customDomainVoteCast: "POST /api/public/feedback/boards/:boardId/requests/:requestId/votes",
    },
    durableActions: ["feedback:request-submit", "feedback:vote-cast"],
    publicBoardFields: ["id", "name", "votingPolicy"],
    publicRequestFields: ["id", "title", "problem", "status", "publicExplanation", "version", "voteCount", "updatedAt"],
    privateRecordFieldsNeverProjected: ["consent", "voterKeyHash", "actorUserId", "command-receipt", "requestHash", "receiptId", "audit"],
    browserWriteControl: "A fresh client-visible idempotency key is embedded in each native form.",
  } as const;
}
