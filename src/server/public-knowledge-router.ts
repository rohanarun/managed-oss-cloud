import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { suiteModuleById, suitePlanAllows, type SuiteRecord, type SuiteWorkspace } from "../shared/suite.js";
import type { SuiteStore } from "./suite-store.js";

const knowledgeModuleId = "knowledge";
const maximumPublicRecords = 10_000;
const sha256Pattern = /^[a-f0-9]{64}$/;
const workspaceSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/);
const uuidSchema = z.string().uuid();
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export interface PublicKnowledgeRouterOptions {
  store: SuiteStore;
}

export interface AtlasBasePublicSource {
  locator: string;
  observedAt: string;
  contentHash: string;
  trustNote: string;
}

export interface AtlasBasePublicPageSummary {
  revisionId: string;
  title: string;
  contentHash: string;
  publishedAt: string;
  parentRevisionId?: string;
}

export interface AtlasBasePublicLibraryView {
  schema: "atlasbase-public-library.v1";
  library: {
    id: string;
    name: string;
    locale: string;
    reviewCadenceDays: number;
  };
  pages: AtlasBasePublicPageSummary[];
}

export interface AtlasBasePublicPageView {
  schema: "atlasbase-public-page.v1";
  library: AtlasBasePublicLibraryView["library"];
  page: AtlasBasePublicPageSummary & {
    content: string;
    sources: AtlasBasePublicSource[];
    latestRevisionId: string;
    isLatestRevision: boolean;
  };
}

interface PublicKnowledgeContext {
  workspace: SuiteWorkspace;
  libraryId: string;
  pagePath(revisionId: string): string;
  libraryPath: string;
}

interface PublicLibrarySnapshot {
  view: AtlasBasePublicLibraryView;
  validRevisions: Map<string, ValidPublishedRevision>;
  latestRevisionByRoot: Map<string, ValidPublishedRevision>;
  rootByRevision: Map<string, string>;
}

interface ValidPublishedRevision {
  record: SuiteRecord;
  summary: AtlasBasePublicPageSummary;
  content: string;
}

class PublicKnowledgeError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function inlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

function markdownLike(value: string) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  let code: string[] | undefined;

  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    output.push(`<${tag}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    list = undefined;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = undefined;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextOrdered = Boolean(ordered);
      if (list && list.ordered !== nextOrdered) flushList();
      list ??= { ordered: nextOrdered, items: [] };
      list.items.push((ordered ?? unordered)![1]);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code) output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return output.join("");
}

const documentStyles = `:root{color-scheme:light;--ink:#172018;--muted:#566258;--paper:#f4f7ef;--surface:#fffef9;--line:#d8dfd2;--accent:#285f35;--accent-soft:#dff0d6;--focus:#a5dc45}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 86% 2%,#d7edce 0,transparent 31rem),var(--paper);color:var(--ink);font:16px/1.65 Satoshi,ui-sans-serif,system-ui,-apple-system,sans-serif}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;z-index:3;padding:.75rem 1rem;background:#fff;color:var(--ink);outline:3px solid var(--focus)}a{color:var(--accent);text-underline-offset:.2em}a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.shell{width:min(92vw,78rem);margin:auto;padding:2rem 0 8rem}.nav{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem;border:1px solid var(--line);border-radius:999px;background:rgba(255,254,249,.9)}.brand{font-weight:850;letter-spacing:-.035em;text-decoration:none;color:var(--ink)}.nav-note{color:var(--muted);font-size:.9rem}.hero{display:grid;grid-template-columns:minmax(0,2fr) minmax(18rem,.55fr);gap:clamp(3rem,9vw,9rem);align-items:end;padding:clamp(6rem,12vw,11rem) 0}.kicker{margin:0 0 1rem;color:var(--accent);font-size:.78rem;font-weight:850;letter-spacing:.12em;text-transform:uppercase}h1{width:100%;max-width:66rem;margin:0;font-size:clamp(3.2rem,6vw,6.2rem);line-height:.9;letter-spacing:-.075em;overflow-wrap:anywhere;text-wrap:balance}.lede{max-width:31rem;margin:0;color:var(--muted);font-size:1.08rem}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-flow:dense;gap:1rem}.card{min-height:15rem;display:flex;flex-direction:column;justify-content:space-between;padding:clamp(1.4rem,4vw,2.5rem);border:1px solid var(--line);border-radius:1.6rem;background:rgba(255,254,249,.94);box-shadow:0 1.5rem 5rem rgba(33,57,34,.06)}.card:first-child:nth-last-child(odd){grid-column:span 2}.card h2{max-width:22ch;margin:0 0 1rem;font-size:clamp(1.7rem,3vw,2.6rem);line-height:1.02;letter-spacing:-.05em}.card p{margin:.35rem 0;color:var(--muted)}.card-link{align-self:flex-start;margin-top:2rem;border-radius:999px;padding:.72rem 1rem;background:var(--accent);color:#fff;font-weight:800;text-decoration:none}.empty{grid-column:span 2;padding:3rem;border:1px dashed #9dac99;border-radius:1.5rem;color:var(--muted)}.article-shell{display:block;padding:clamp(5rem,10vw,9rem) 0}.article-meta{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(18rem,.45fr);gap:clamp(3rem,9vw,9rem);align-items:end}.article-meta .kicker{grid-column:1/-1}.article-meta h1{font-size:clamp(3.2rem,6vw,6.2rem)}.revision{padding-top:1.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}.revision code,.source code{overflow-wrap:anywhere}.article{width:min(100%,61rem);min-width:0;margin:clamp(4rem,9vw,8rem) 0 0 auto;padding:clamp(1.5rem,5vw,4.5rem);border:1px solid var(--line);border-radius:2rem;background:var(--surface);box-shadow:0 2rem 7rem rgba(33,57,34,.08)}.content{font-size:1.05rem}.content h2,.content h3,.content h4{margin:2.5rem 0 .75rem;line-height:1.08;letter-spacing:-.04em}.content h2{font-size:2rem}.content h3{font-size:1.55rem}.content p,.content ul,.content ol,.content blockquote{max-width:48rem}.content pre{overflow:auto;padding:1.2rem;border-radius:1rem;background:#19231b;color:#f1f7ed}.content code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.content blockquote{margin-left:0;padding-left:1.2rem;border-left:3px solid #77a56c;color:var(--muted)}.bibliography{margin-top:5rem;padding-top:3rem;border-top:1px solid var(--line)}.bibliography h2{font-size:2rem;letter-spacing:-.04em}.sources{display:grid;gap:.8rem}.source{padding:1.2rem;border:1px solid var(--line);border-radius:1rem;background:#f8faf4}.source p{margin:.2rem 0}.source-locator{font-weight:800;color:var(--ink);overflow-wrap:anywhere}.footer{margin-top:6rem;padding-top:2rem;border-top:1px solid var(--line);color:var(--muted)}@media(max-width:760px){.nav-note{display:none}.hero,.article-meta{grid-template-columns:1fr;padding:5rem 0}.article-meta .kicker{grid-column:auto}.grid{grid-template-columns:1fr}.card,.card:first-child:nth-last-child(odd),.empty{grid-column:span 1}.article{padding:1.4rem}h1{font-size:clamp(3rem,15vw,5.4rem)}}`;
const styleHash = createHash("sha256").update(documentStyles, "utf8").digest("base64");

function knowledgeEnabled(workspace: SuiteWorkspace) {
  const module = suiteModuleById.get(knowledgeModuleId);
  return Boolean(module && workspace.enabledModuleIds.includes(knowledgeModuleId) && suitePlanAllows(workspace.plan, module));
}

function notFound() {
  return new PublicKnowledgeError("knowledge_not_found", 404, "This public knowledge resource was not found.");
}

function validId(value: unknown) {
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

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(new Date(value).getTime());
}

function publicLibrary(record: SuiteRecord | undefined, workspace: SuiteWorkspace): AtlasBasePublicLibraryView["library"] | undefined {
  const locale = record?.data.locale;
  const reviewCadenceDays = record?.data.reviewCadenceDays;
  if (!record
    || record.workspaceId !== workspace.id
    || record.moduleId !== knowledgeModuleId
    || record.recordType !== "knowledge-library"
    || record.state !== "active"
    || record.data.defaultAccess !== "public"
    || !record.title.trim()
    || record.title.length > 200
    || typeof locale !== "string"
    || !localePattern.test(locale)
    || !Number.isSafeInteger(reviewCadenceDays)
    || Number(reviewCadenceDays) < 1
    || Number(reviewCadenceDays) > 3_650) return undefined;
  return { id: record.id, name: record.title, locale, reviewCadenceDays: Number(reviewCadenceDays) };
}

function publishedRevision(record: SuiteRecord, libraryId: string): ValidPublishedRevision | undefined {
  const content = record.data.content;
  const sourceIds = record.data.sourceIds;
  const parentRevisionId = record.data.parentRevisionId;
  const contentHash = record.data.contentHash;
  const publishedAt = record.data.publishedAt;
  if (record.moduleId !== knowledgeModuleId
    || record.recordType !== "page-revision"
    || record.state !== "published"
    || record.data.libraryId !== libraryId
    || record.data.immutableAfterPublication !== true
    || typeof content !== "string"
    || content.length < 1
    || content.length > 100_000
    || !record.title.trim()
    || record.title.length > 300
    || !Array.isArray(sourceIds)
    || sourceIds.length > 500
    || sourceIds.some((item) => typeof item !== "string" || !uuidSchema.safeParse(item).success)
    || (parentRevisionId !== null && parentRevisionId !== undefined && !uuidSchema.safeParse(parentRevisionId).success)
    || typeof contentHash !== "string"
    || !sha256Pattern.test(contentHash)
    || record.data.publishedContentHash !== contentHash
    || !isIsoDate(publishedAt)) return undefined;
  const expectedHash = digest({
    libraryId,
    title: record.title,
    content,
    sourceIds: [...sourceIds].sort(),
    parentRevisionId: parentRevisionId ?? null,
  });
  if (expectedHash !== contentHash) return undefined;
  return {
    record,
    content,
    summary: {
      revisionId: record.id,
      title: record.title,
      contentHash,
      publishedAt,
      ...(typeof parentRevisionId === "string" ? { parentRevisionId } : {}),
    },
  };
}

function newest(left: ValidPublishedRevision, right: ValidPublishedRevision) {
  const published = right.summary.publishedAt.localeCompare(left.summary.publishedAt);
  if (published !== 0) return published;
  return right.summary.revisionId.localeCompare(left.summary.revisionId);
}

function resolveRoots(revisions: Map<string, ValidPublishedRevision>) {
  const rootByRevision = new Map<string, string>();
  const invalid = new Set<string>();
  for (const revision of revisions.values()) {
    const path: string[] = [];
    const visited = new Set<string>();
    let current = revision;
    while (true) {
      if (visited.has(current.record.id)) {
        path.forEach((id) => invalid.add(id));
        break;
      }
      visited.add(current.record.id);
      path.push(current.record.id);
      const parentId = current.summary.parentRevisionId;
      const parent = parentId ? revisions.get(parentId) : undefined;
      if (!parent) {
        path.forEach((id) => rootByRevision.set(id, current.record.id));
        break;
      }
      current = parent;
    }
  }
  invalid.forEach((id) => rootByRevision.delete(id));
  return rootByRevision;
}

function publicSource(record: SuiteRecord, revisionId: string): AtlasBasePublicSource | undefined {
  const { locator, observedAt, contentHash, trustNote } = record.data;
  if (record.moduleId !== knowledgeModuleId
    || record.recordType !== "knowledge-source"
    || record.state !== "observed"
    || record.data.revisionId !== revisionId
    || record.data.immutable !== true
    || typeof locator !== "string"
    || !locator.trim()
    || locator.length > 2_000
    || !isIsoDate(observedAt)
    || typeof contentHash !== "string"
    || !sha256Pattern.test(contentHash)
    || typeof trustNote !== "string"
    || !trustNote.trim()
    || trustNote.length > 1_000) return undefined;
  return { locator, observedAt, contentHash, trustNote };
}

function sourceOrder(left: AtlasBasePublicSource, right: AtlasBasePublicSource) {
  const observed = right.observedAt.localeCompare(left.observedAt);
  if (observed !== 0) return observed;
  const locator = left.locator.localeCompare(right.locator);
  return locator || left.contentHash.localeCompare(right.contentHash);
}

function libraryPage(input: { view: AtlasBasePublicLibraryView; context: PublicKnowledgeContext }) {
  const cards = input.view.pages.map((page) => `<article class="card"><div><h2>${escapeHtml(page.title)}</h2><p>Published <time datetime="${escapeHtml(page.publishedAt)}">${escapeHtml(page.publishedAt.slice(0, 10))}</time></p><p><code>${escapeHtml(page.contentHash)}</code></p></div><a class="card-link" href="${escapeHtml(input.context.pagePath(page.revisionId))}">Read this page</a></article>`).join("");
  return `<!doctype html><html lang="${escapeHtml(input.view.library.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.view.library.name)} · AtlasBase</title><style>${documentStyles}</style></head><body><a class="skip" href="#main">Skip to pages</a><main id="main" class="shell"><nav class="nav" aria-label="Knowledge portal"><a class="brand" href="${escapeHtml(input.context.libraryPath)}">AtlasBase</a><span class="nav-note">Published, content-addressed knowledge</span></nav><header class="hero"><div><p class="kicker">Public knowledge library</p><h1>${escapeHtml(input.view.library.name)}</h1></div><p class="lede">Browse the latest published revision in each page history. Every page keeps a stable URL, exact content digest, and public source bibliography.</p></header><section class="grid" aria-label="Published pages">${cards || `<p class="empty">This public library has no verified published pages yet.</p>`}</section><footer class="footer">Review cadence: every ${input.view.library.reviewCadenceDays} days. AtlasBase renders published text without executable page content.</footer></main></body></html>`;
}

function pageDocument(input: { view: AtlasBasePublicPageView; context: PublicKnowledgeContext }) {
  const sources = input.view.page.sources.map((source) => `<article class="source"><p class="source-locator">${escapeHtml(source.locator)}</p><p>${escapeHtml(source.trustNote)}</p><p>Observed <time datetime="${escapeHtml(source.observedAt)}">${escapeHtml(source.observedAt.slice(0, 10))}</time></p><p><code>${escapeHtml(source.contentHash)}</code></p></article>`).join("");
  const currentStatus = input.view.page.isLatestRevision
    ? "This is the latest published revision in its page history."
    : `A newer published revision is available: <a href="${escapeHtml(input.context.pagePath(input.view.page.latestRevisionId))}">open the latest revision</a>.`;
  return `<!doctype html><html lang="${escapeHtml(input.view.library.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.view.page.title)} · ${escapeHtml(input.view.library.name)}</title><style>${documentStyles}</style></head><body><a class="skip" href="#article">Skip to article</a><main class="shell"><nav class="nav" aria-label="Knowledge portal"><a class="brand" href="${escapeHtml(input.context.libraryPath)}">${escapeHtml(input.view.library.name)}</a><span class="nav-note">Stable revision</span></nav><div class="article-shell"><header class="article-meta"><p class="kicker">Published knowledge</p><h1>${escapeHtml(input.view.page.title)}</h1><div class="revision"><p>${currentStatus}</p><p>Published <time datetime="${escapeHtml(input.view.page.publishedAt)}">${escapeHtml(input.view.page.publishedAt.slice(0, 10))}</time></p><p>Revision digest<br><code>${escapeHtml(input.view.page.contentHash)}</code></p></div></header><article id="article" class="article"><div class="content">${markdownLike(input.view.page.content)}</div><section class="bibliography" aria-labelledby="sources-title"><h2 id="sources-title">Sources</h2><div class="sources">${sources || `<p>No public bibliography entries are attached to this revision.</p>`}</div></section></article></div><footer class="footer"><a href="${escapeHtml(input.context.libraryPath)}">Return to ${escapeHtml(input.view.library.name)}</a></footer></main></body></html>`;
}

function errorDocument(title: string, message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · AtlasBase</title><style>${documentStyles}</style></head><body><main class="shell"><section class="hero"><div><p class="kicker">AtlasBase</p><h1>${escapeHtml(title)}</h1></div><p class="lede" role="alert">${escapeHtml(message)}</p></section></main></body></html>`;
}

function securityHeaders(response: Response) {
  response.set("Content-Security-Policy", `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'none'; style-src 'sha256-${styleHash}'`);
  response.set("Referrer-Policy", "no-referrer");
  response.set("X-Content-Type-Options", "nosniff");
  response.set("X-Frame-Options", "DENY");
  response.set("Cross-Origin-Opener-Policy", "same-origin");
  response.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.vary("Host");
  response.vary("Accept");
}

function sendRepresentation(request: Request, response: Response, input: { body: string; type: "html" | "json"; cacheControl: string; contentLanguage?: string }) {
  const etag = `"${createHash("sha256").update(`${input.type}:${input.body}`, "utf8").digest("hex")}"`;
  response.set("Cache-Control", input.cacheControl);
  response.set("ETag", etag);
  if (input.contentLanguage) response.set("Content-Language", input.contentLanguage);
  if (request.get("if-none-match") === etag) {
    response.status(304).end();
    return;
  }
  response.status(200).type(input.type === "html" ? "html" : "application/json").send(input.body);
}

function handle(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => handler(request, response).catch(next);
}

export function createPublicKnowledgeRouter(options: PublicKnowledgeRouterOptions): Router {
  const router = express.Router();
  const routePrefixes = ["/knowledge", "/api/public/knowledge"];
  router.use(routePrefixes, (_request, response, next) => {
    securityHeaders(response);
    next();
  });

  async function workspaceBySlug(value: unknown) {
    const workspace = await options.store.getWorkspaceBySlug(validWorkspaceSlug(value));
    if (!workspace || !knowledgeEnabled(workspace)) throw notFound();
    return workspace;
  }

  async function workspaceByDomain(request: Request) {
    const workspace = await options.store.getWorkspaceByCustomDomain(customHostname(request));
    if (!workspace || !knowledgeEnabled(workspace)) throw notFound();
    return workspace;
  }

  async function hostedContext(request: Request): Promise<PublicKnowledgeContext> {
    const workspace = await workspaceBySlug(request.params.workspaceSlug);
    const libraryId = validId(request.params.libraryId);
    return {
      workspace,
      libraryId,
      libraryPath: `/knowledge/${encodeURIComponent(workspace.slug)}/${libraryId}`,
      pagePath: (revisionId) => `/knowledge/${encodeURIComponent(workspace.slug)}/${libraryId}/pages/${revisionId}`,
    };
  }

  async function domainContext(request: Request): Promise<PublicKnowledgeContext> {
    const workspace = await workspaceByDomain(request);
    const libraryId = validId(request.params.libraryId);
    return {
      workspace,
      libraryId,
      libraryPath: `/knowledge/${libraryId}`,
      pagePath: (revisionId) => `/knowledge/${libraryId}/pages/${revisionId}`,
    };
  }

  async function snapshot(context: PublicKnowledgeContext): Promise<PublicLibrarySnapshot> {
    const record = await options.store.getRecord(context.workspace.userId, context.libraryId);
    const library = publicLibrary(record, context.workspace);
    if (!library) throw notFound();
    const revisions = await options.store.listPublicWorkflowRecords(context.workspace.slug, { moduleId: knowledgeModuleId, recordType: "page-revision", limit: maximumPublicRecords + 1 });
    if (revisions.length > maximumPublicRecords) throw new PublicKnowledgeError("knowledge_too_large", 503, "This public library is too large to render safely right now.");
    const validRevisions = new Map(revisions
      .map((candidate) => publishedRevision(candidate, library.id))
      .filter((candidate): candidate is ValidPublishedRevision => Boolean(candidate))
      .map((candidate) => [candidate.record.id, candidate]));
    const rootByRevision = resolveRoots(validRevisions);
    const latestRevisionByRoot = new Map<string, ValidPublishedRevision>();
    for (const [revisionId, root] of rootByRevision) {
      const revision = validRevisions.get(revisionId)!;
      const current = latestRevisionByRoot.get(root);
      if (!current || newest(current, revision) > 0) latestRevisionByRoot.set(root, revision);
    }
    const pages = [...latestRevisionByRoot.values()]
      .map((revision) => revision.summary)
      .sort((left, right) => left.title < right.title ? -1 : left.title > right.title ? 1 : right.publishedAt.localeCompare(left.publishedAt) || right.revisionId.localeCompare(left.revisionId));
    return { view: { schema: "atlasbase-public-library.v1", library, pages }, validRevisions, latestRevisionByRoot, rootByRevision };
  }

  async function pageView(context: PublicKnowledgeContext, revisionId: string): Promise<AtlasBasePublicPageView> {
    const state = await snapshot(context);
    const revision = state.validRevisions.get(revisionId);
    const root = state.rootByRevision.get(revisionId);
    const latest = root ? state.latestRevisionByRoot.get(root) : undefined;
    if (!revision || !root || !latest) throw notFound();
    const sources = await options.store.listPublicWorkflowRecords(context.workspace.slug, { moduleId: knowledgeModuleId, recordType: "knowledge-source", limit: maximumPublicRecords + 1 });
    if (sources.length > maximumPublicRecords) throw new PublicKnowledgeError("knowledge_too_large", 503, "This public bibliography is too large to render safely right now.");
    const bibliography = sources
      .map((candidate) => publicSource(candidate, revisionId))
      .filter((candidate): candidate is AtlasBasePublicSource => Boolean(candidate))
      .sort(sourceOrder);
    return {
      schema: "atlasbase-public-page.v1",
      library: state.view.library,
      page: {
        ...revision.summary,
        content: revision.content,
        sources: bibliography,
        latestRevisionId: latest.record.id,
        isLatestRevision: latest.record.id === revision.record.id,
      },
    };
  }

  function renderLibrary(contextResolver: (request: Request) => Promise<PublicKnowledgeContext>) {
    return handle(async (request, response) => {
      response.locals.knowledgeResponseKind = "html";
      const context = await contextResolver(request);
      const state = await snapshot(context);
      sendRepresentation(request, response, {
        body: libraryPage({ view: state.view, context }),
        type: "html",
        cacheControl: "public, max-age=0, s-maxage=60, must-revalidate, stale-while-revalidate=300",
        contentLanguage: state.view.library.locale,
      });
    });
  }

  function renderPage(contextResolver: (request: Request) => Promise<PublicKnowledgeContext>) {
    return handle(async (request, response) => {
      response.locals.knowledgeResponseKind = "html";
      const context = await contextResolver(request);
      const view = await pageView(context, validId(request.params.revisionId));
      sendRepresentation(request, response, {
        body: pageDocument({ view, context }),
        type: "html",
        cacheControl: "public, max-age=0, s-maxage=300, must-revalidate",
        contentLanguage: view.library.locale,
      });
    });
  }

  function libraryJson(contextResolver: (request: Request) => Promise<PublicKnowledgeContext>) {
    return handle(async (request, response) => {
      response.locals.knowledgeResponseKind = "json";
      const state = await snapshot(await contextResolver(request));
      sendRepresentation(request, response, {
        body: JSON.stringify(state.view),
        type: "json",
        cacheControl: "public, max-age=0, s-maxage=60, must-revalidate, stale-while-revalidate=300",
        contentLanguage: state.view.library.locale,
      });
    });
  }

  function pageJson(contextResolver: (request: Request) => Promise<PublicKnowledgeContext>) {
    return handle(async (request, response) => {
      response.locals.knowledgeResponseKind = "json";
      const context = await contextResolver(request);
      const view = await pageView(context, validId(request.params.revisionId));
      sendRepresentation(request, response, {
        body: JSON.stringify(view),
        type: "json",
        cacheControl: "public, max-age=0, s-maxage=300, must-revalidate",
        contentLanguage: view.library.locale,
      });
    });
  }

  router.get("/knowledge/:workspaceSlug/:libraryId", renderLibrary(hostedContext));
  router.get("/knowledge/:workspaceSlug/:libraryId/pages/:revisionId", renderPage(hostedContext));
  router.get("/knowledge/:libraryId", renderLibrary(domainContext));
  router.get("/knowledge/:libraryId/pages/:revisionId", renderPage(domainContext));
  router.get("/api/public/knowledge/:workspaceSlug/libraries/:libraryId", libraryJson(hostedContext));
  router.get("/api/public/knowledge/:workspaceSlug/libraries/:libraryId/pages/:revisionId", pageJson(hostedContext));
  router.get("/api/public/knowledge/libraries/:libraryId", libraryJson(domainContext));
  router.get("/api/public/knowledge/libraries/:libraryId/pages/:revisionId", pageJson(domainContext));

  router.use(routePrefixes, (error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const safe = error instanceof PublicKnowledgeError
      ? error
      : new PublicKnowledgeError("knowledge_unavailable", 503, "The public knowledge service is temporarily unavailable.");
    response.set("Cache-Control", "no-store, max-age=0");
    if (response.locals.knowledgeResponseKind === "html" || (request.method === "GET" && request.path.startsWith("/knowledge/"))) {
      response.status(safe.status).type("html").send(errorDocument(safe.status === 404 ? "Page not found" : "Knowledge unavailable", safe.message));
    } else response.status(safe.status).json({ error: safe.code, message: safe.message });
  });
  return router;
}

export function publicKnowledgeMountContract() {
  return {
    version: "atlasbase-public-mount.v1",
    mountPath: "/",
    routes: {
      hostedLibrary: "GET /knowledge/:workspaceSlug/:libraryId",
      hostedRevision: "GET /knowledge/:workspaceSlug/:libraryId/pages/:revisionId",
      customDomainLibrary: "GET /knowledge/:libraryId",
      customDomainRevision: "GET /knowledge/:libraryId/pages/:revisionId",
      hostedLibraryProjection: "GET /api/public/knowledge/:workspaceSlug/libraries/:libraryId",
      hostedRevisionProjection: "GET /api/public/knowledge/:workspaceSlug/libraries/:libraryId/pages/:revisionId",
      customDomainLibraryProjection: "GET /api/public/knowledge/libraries/:libraryId",
      customDomainRevisionProjection: "GET /api/public/knowledge/libraries/:libraryId/pages/:revisionId",
    },
    publicLibraryFields: ["id", "name", "locale", "reviewCadenceDays"],
    publicPageFields: ["revisionId", "title", "contentHash", "publishedAt", "parentRevisionId", "content", "sources", "latestRevisionId", "isLatestRevision"],
    publicSourceFields: ["locator", "observedAt", "contentHash", "trustNote"],
    privateRecordFieldsNeverProjected: ["workspaceId", "userId", "sourceIds", "data", "command-receipt", "approvalDecisionId", "actorUserId", "requestHash"],
    publicationRule: "Only exact, content-hash-verified published revisions in libraries whose defaultAccess is public are rendered.",
  } as const;
}
