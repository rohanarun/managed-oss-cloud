import { createHash, timingSafeEqual } from "node:crypto";
import type { SuiteRecord, SuiteWorkspace } from "../shared/suite.js";
import { executeFirstPartyGrowthAction, type FirstPartyGrowthAuthorization } from "./first-party-growth-engine.js";
import type { SuiteStore } from "./suite-store.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const approvalPattern = /^[A-Za-z0-9._:-]{16,200}$/;
const maximumWorkflowRecords = 10_000;

export class PublicGrowthError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 410, message: string) {
    super(message);
  }
}

export interface PublicTestimonialSubmission {
  authorName: string;
  content: string;
  attribution: "full-name" | "first-name" | "anonymous";
  authorRole?: string;
  organization?: string;
  consent: {
    granted: true;
    policyVersion: string;
    purposes: string[];
  };
}

export interface PublicGiveawayEntry {
  participantKeyHash: string;
  displayName?: string;
  referralCode?: string;
  consent: {
    granted: true;
    policyVersion: string;
    purposes: string[];
  };
}

export interface PublishedTestimonialProjection {
  id: string;
  content: string;
  attributionLabel: string;
  disclosure: string;
  contentHash: string;
  publishedAt: string;
}

export interface PublishedWidgetProjection {
  id: string;
  widgetKey: string;
  version: number;
  layout: "grid" | "carousel" | "quote-wall";
  theme: { accent: string; surface: string; text: string; radiusPx: number };
  contentHash: string;
  testimonials: PublishedTestimonialProjection[];
}

export interface PublishedPageProjection {
  workspaceId: string;
  pageId: string;
  pageVersionId: string;
  slug: string;
  title: string;
  description: string;
  locale: string;
  layout: "stack" | "cards" | "editorial";
  theme: { accent: string; background: string; foreground: string; radiusPx: number };
  links: Array<{ key: string; label: string; accessibilityLabel: string; destination: string; destinationVersionId: string }>;
  contentHash: string;
}

export interface ActiveQrProjection {
  routeId: string;
  destinationVersionId: string;
  slug: string;
  destination: string;
  contentHash: string;
  privacyMode: "aggregate" | "no-analytics";
  style: { foreground: string; background: string; errorCorrection: "L" | "M" | "Q" | "H" };
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTokenMatch(expectedHash: unknown, token: string) {
  if (typeof expectedHash !== "string" || !sha256Pattern.test(expectedHash)) return false;
  const actual = Buffer.from(hash(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function publicHttps(value: unknown) {
  let parsed: URL;
  try { parsed = new URL(String(value)); } catch { return undefined; }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || !hostname || hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) return undefined;
  return parsed.toString();
}

function validApproval(record: SuiteRecord) {
  return typeof record.data.approvalDecisionId === "string" && approvalPattern.test(record.data.approvalDecisionId);
}

function validHash(record: SuiteRecord) {
  return typeof record.data.contentHash === "string" && sha256Pattern.test(record.data.contentHash);
}

function validTheme(value: unknown, keys: readonly string[]) {
  const theme = object(value);
  if (!theme || keys.some((key) => typeof theme[key] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(String(theme[key])))) return undefined;
  const radiusPx = Number(theme.radiusPx ?? 0);
  if (!Number.isSafeInteger(radiusPx) || radiusPx < 0 || radiusPx > 40) return undefined;
  return { ...Object.fromEntries(keys.map((key) => [key, String(theme[key])])), radiusPx };
}

function workspaceAuth(workspace: SuiteWorkspace): FirstPartyGrowthAuthorization {
  return { userId: workspace.userId, workspaceId: workspace.id, role: "owner", scopes: ["*"] };
}

export class PublicGrowthService {
  constructor(
    private readonly store: SuiteStore,
    private readonly dependencies: { now?: () => Date; publicBaseUrl?: string } = {},
  ) {}

  private now() { return this.dependencies.now?.() ?? new Date(); }
  private consentCapturedAt() { return new Date(Math.floor(this.now().getTime() / 60_000) * 60_000).toISOString(); }

  private async workspaceBySlug(slug: string) {
    const workspace = await this.store.getWorkspaceBySlug(slug);
    if (!workspace) throw new PublicGrowthError(404, "Public workspace not found.");
    return workspace;
  }

  private async workspaceById(id: string) {
    const workspace = await this.store.getWorkspaceByPublicId(id);
    if (!workspace) throw new PublicGrowthError(404, "Public workspace not found.");
    return workspace;
  }

  private async workflow(workspace: SuiteWorkspace, moduleId: string, recordType: string) {
    return this.store.listPublicWorkflowRecords(workspace.slug, { moduleId, recordType, limit: maximumWorkflowRecords });
  }

  private async validatePublication(workspace: SuiteWorkspace, publication: SuiteRecord, records?: {
    testimonials: SuiteRecord[];
    receipts: SuiteRecord[];
    decisions: SuiteRecord[];
  }): Promise<PublishedTestimonialProjection | undefined> {
    if (publication.recordType !== "publication-version" || publication.state !== "published" || publication.data.public !== true || !validHash(publication) || !validApproval(publication)) return undefined;
    const sourceRecords = records ?? {
      testimonials: await this.workflow(workspace, "testimonials", "testimonial"),
      receipts: await this.workflow(workspace, "testimonials", "consent-receipt"),
      decisions: await this.workflow(workspace, "testimonials", "moderation-decision"),
    };
    const testimonial = sourceRecords.testimonials.find((candidate) => candidate.id === publication.data.testimonialId);
    const receipt = sourceRecords.receipts.find((candidate) => candidate.id === publication.data.consentReceiptId);
    const decision = sourceRecords.decisions.find((candidate) => candidate.id === publication.data.moderationDecisionId);
    if (!testimonial || !receipt || testimonial.state === "revoked" || testimonial.data.consentRevokedAt || testimonial.data.consentReceiptId !== receipt.id) return undefined;
    if (receipt.state !== "granted" || receipt.data.policyVersion === undefined || !Array.isArray(receipt.data.purposes) || !receipt.data.purposes.includes("testimonial-publication")) return undefined;
    if (!decision || decision.data.testimonialId !== testimonial.id || !["accept", "redact"].includes(String(decision.data.decision)) || !validApproval(decision)) return undefined;
    if (typeof publication.data.content !== "string" || !publication.data.content.trim() || typeof publication.data.attributionLabel !== "string" || !publication.data.attributionLabel.trim()) return undefined;
    return {
      id: publication.id,
      content: publication.data.content,
      attributionLabel: publication.data.attributionLabel,
      disclosure: typeof publication.data.disclosure === "string" ? publication.data.disclosure : "",
      contentHash: String(publication.data.contentHash),
      publishedAt: typeof publication.data.publishedAt === "string" ? publication.data.publishedAt : publication.updatedAt,
    };
  }

  async testimonialsBySlug(slug: string) {
    return this.testimonials(await this.workspaceBySlug(slug));
  }

  async testimonialsByWorkspaceId(workspaceId: string) {
    return this.testimonials(await this.workspaceById(workspaceId));
  }

  private async testimonials(workspace: SuiteWorkspace) {
    const [publications, testimonials, receipts, decisions] = await Promise.all([
      this.workflow(workspace, "testimonials", "publication-version"),
      this.workflow(workspace, "testimonials", "testimonial"),
      this.workflow(workspace, "testimonials", "consent-receipt"),
      this.workflow(workspace, "testimonials", "moderation-decision"),
    ]);
    const records = { testimonials, receipts, decisions };
    const projected = await Promise.all(publications.map((publication) => this.validatePublication(workspace, publication, records)));
    return projected.filter((publication): publication is PublishedTestimonialProjection => Boolean(publication));
  }

  async widgetByWorkspaceId(workspaceId: string, widgetVersionId: string) {
    return this.widget(await this.workspaceById(workspaceId), widgetVersionId);
  }

  async widgetBySlug(slug: string, widgetVersionId: string) {
    return this.widget(await this.workspaceBySlug(slug), widgetVersionId);
  }

  private async widget(workspace: SuiteWorkspace, widgetVersionId: string): Promise<PublishedWidgetProjection> {
    const widgets = await this.workflow(workspace, "testimonials", "widget-version");
    const widget = widgets.find((candidate) => candidate.id === widgetVersionId);
    if (!widget || widget.state !== "published" || widget.data.public !== true || !validHash(widget) || !validApproval(widget)) throw new PublicGrowthError(404, "Published testimonial widget not found.");
    if (!Array.isArray(widget.data.publicationVersionIds) || !widget.data.publicationVersionIds.length || new Set(widget.data.publicationVersionIds).size !== widget.data.publicationVersionIds.length) throw new PublicGrowthError(404, "Published testimonial widget not found.");
    const [publications, testimonials, receipts, decisions] = await Promise.all([
      this.workflow(workspace, "testimonials", "publication-version"),
      this.workflow(workspace, "testimonials", "testimonial"),
      this.workflow(workspace, "testimonials", "consent-receipt"),
      this.workflow(workspace, "testimonials", "moderation-decision"),
    ]);
    const records = { testimonials, receipts, decisions };
    const publicationsById = new Map(publications.map((publication) => [publication.id, publication]));
    const resolved: PublishedTestimonialProjection[] = [];
    for (const publicationVersionId of widget.data.publicationVersionIds) {
      const publication = publicationsById.get(String(publicationVersionId));
      const projection = publication ? await this.validatePublication(workspace, publication, records) : undefined;
      if (!projection) throw new PublicGrowthError(404, "Published testimonial widget not found.");
      resolved.push(projection);
    }
    const theme = validTheme(widget.data.theme, ["accent", "surface", "text"] as const);
    const layout = widget.data.layout;
    if (!theme || !["grid", "carousel", "quote-wall"].includes(String(layout))) throw new PublicGrowthError(404, "Published testimonial widget not found.");
    return {
      id: widget.id,
      widgetKey: String(widget.data.widgetKey),
      version: Number(widget.data.version),
      layout: layout as PublishedWidgetProjection["layout"],
      theme: theme as PublishedWidgetProjection["theme"],
      contentHash: String(widget.data.contentHash),
      testimonials: resolved,
    };
  }

  async collectionRequestByWorkspaceId(workspaceId: string, requestId: string, token: string) {
    return this.collectionRequest(await this.workspaceById(workspaceId), requestId, token, false);
  }

  async collectionRequestBySlug(slug: string, requestId: string, token: string) {
    return this.collectionRequest(await this.workspaceBySlug(slug), requestId, token, false);
  }

  private async collectionRequest(workspace: SuiteWorkspace, requestId: string, token: string, allowConsumed: boolean) {
    const requests = await this.workflow(workspace, "testimonials", "collection-request");
    const request = requests.find((candidate) => candidate.id === requestId);
    if (!request || !constantTokenMatch(request.data.accessTokenHash, token)) throw new PublicGrowthError(404, "Collection request not found.");
    if (request.state === "consumed" && !allowConsumed) throw new PublicGrowthError(410, "This collection request was already used.");
    if (!["draft", ...(allowConsumed ? ["consumed"] : [])].includes(request.state) || typeof request.data.expiresAt !== "string" || new Date(request.data.expiresAt).getTime() <= this.now().getTime()) throw new PublicGrowthError(410, "This collection request expired.");
    const collections = await this.workflow(workspace, "testimonials", "collection");
    const collection = collections.find((candidate) => candidate.id === request.data.collectionId && candidate.state === "active");
    if (!collection || typeof collection.data.consentPolicyVersion !== "string") throw new PublicGrowthError(404, "Collection request not found.");
    return {
      workspace,
      request,
      collection,
      public: {
        requestId: request.id,
        collectionName: collection.title,
        purpose: String(collection.data.purpose ?? ""),
        consentPolicyVersion: collection.data.consentPolicyVersion,
        contextLabel: String(request.data.contextLabel ?? ""),
        locale: String(request.data.locale ?? "en-US"),
        expiresAt: request.data.expiresAt,
      },
    };
  }

  async submitTestimonialByWorkspaceId(workspaceId: string, requestId: string, token: string, input: PublicTestimonialSubmission) {
    const workspace = await this.workspaceById(workspaceId);
    return this.submitTestimonial(await this.collectionRequest(workspace, requestId, token, true), token, input);
  }

  async submitTestimonialBySlug(slug: string, requestId: string, token: string, input: PublicTestimonialSubmission) {
    const workspace = await this.workspaceBySlug(slug);
    return this.submitTestimonial(await this.collectionRequest(workspace, requestId, token, true), token, input);
  }

  private async submitTestimonial(
    resolved: Awaited<ReturnType<PublicGrowthService["collectionRequestByWorkspaceId"]>>,
    token: string,
    input: PublicTestimonialSubmission,
  ) {
    if (input.consent.policyVersion !== resolved.collection.data.consentPolicyVersion || !input.consent.purposes.includes("testimonial-publication")) throw new PublicGrowthError(409, "Consent must match this collection policy and include testimonial publication.");
    const sourceRefHash = hash(`proofport/source/v1:${resolved.workspace.id}:${resolved.request.id}:${hash(token)}`);
    const idempotencyKey = `public-testimonial.${hash(`${resolved.workspace.id}:${resolved.request.id}:${sourceRefHash}`)}`;
    try {
      const result = await executeFirstPartyGrowthAction(
        this.store,
        workspaceAuth(resolved.workspace),
        "testimonials",
        "submission-record",
        {
          collectionId: resolved.collection.id,
          requestId: resolved.request.id,
          authorName: input.authorName,
          content: input.content,
          attribution: input.attribution,
          ...(input.authorRole ? { authorRole: input.authorRole } : {}),
          ...(input.organization ? { organization: input.organization } : {}),
          consent: { ...input.consent, capturedAt: this.consentCapturedAt(), captureMethod: "hosted-form" },
          sourceRefHash,
          idempotencyKey,
        },
        { now: () => this.now(), publicBaseUrl: this.dependencies.publicBaseUrl },
      );
      const testimonial = result.records.find((record) => record.recordType === "testimonial");
      if (!testimonial) throw new Error("The testimonial receipt did not resolve its private evidence record.");
      return { id: testimonial.id, state: testimonial.state, moderationStatus: "pending-review" as const, replayed: result.audit.replayed === true };
    } catch (error) {
      if (error instanceof PublicGrowthError) throw error;
      if (error instanceof Error && /idempotency key|already|expired|consumed|source reference/i.test(error.message)) throw new PublicGrowthError(409, "This collection request was already submitted or changed after submission.");
      throw error;
    }
  }

  async contestsBySlug(slug: string) {
    const workspace = await this.workspaceBySlug(slug);
    const [contests, receipts] = await Promise.all([
      this.workflow(workspace, "giveaways", "contest"),
      this.workflow(workspace, "giveaways", "growth-command-receipt"),
    ]);
    return contests.filter((contest) => this.openApprovedContest(contest, receipts)).map((contest) => ({
      id: contest.id,
      name: contest.title,
      description: String(contest.data.description ?? ""),
      closesAt: String(contest.data.closesAt),
      rules: String(contest.data.rules),
      rulesHash: String(contest.data.rulesHash),
      consentPolicyVersion: String(contest.data.consentPolicyVersion),
      prizeDescription: String(contest.data.prizeDescription ?? ""),
    }));
  }

  private openApprovedContest(contest: SuiteRecord, receipts: SuiteRecord[]) {
    const publishedReceipt = receipts.find((receipt) => receipt.data.actionId === "contest-publish" && Array.isArray(receipt.data.resultRecordIds) && receipt.data.resultRecordIds.includes(contest.id));
    const receiptAudit = object(publishedReceipt?.data.audit);
    return contest.state === "published" && contest.data.public === true && sha256Pattern.test(String(contest.data.rulesHash ?? "")) && typeof contest.data.consentPolicyVersion === "string" && new Date(String(contest.data.closesAt)).getTime() > this.now().getTime() && typeof receiptAudit?.approvalDecisionId === "string" && approvalPattern.test(receiptAudit.approvalDecisionId);
  }

  async enterGiveawayBySlug(slug: string, contestId: string, input: PublicGiveawayEntry) {
    const workspace = await this.workspaceBySlug(slug);
    const [contests, receipts] = await Promise.all([
      this.workflow(workspace, "giveaways", "contest"),
      this.workflow(workspace, "giveaways", "growth-command-receipt"),
    ]);
    const contest = contests.find((candidate) => candidate.id === contestId);
    if (!contest || !this.openApprovedContest(contest, receipts)) throw new PublicGrowthError(404, "This public contest is not accepting entries.");
    if (input.consent.policyVersion !== contest.data.consentPolicyVersion || !input.consent.purposes.includes("contest-administration") || (input.referralCode && !input.consent.purposes.includes("referral-attribution"))) throw new PublicGrowthError(409, "Consent must match the contest policy and requested referral purposes.");
    const participantKeyHash = hash(`fairlaunch/participant/v1:${workspace.id}:${contest.id}:${input.participantKeyHash.toLowerCase()}`);
    const idempotencyKey = `public-entry.${hash(`${workspace.id}:${contest.id}:${participantKeyHash}`)}`;
    try {
      const result = await executeFirstPartyGrowthAction(
        this.store,
        workspaceAuth(workspace),
        "giveaways",
        "entry-register",
        {
          contestId: contest.id,
          participantKeyHash,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.referralCode ? { referralCode: input.referralCode } : {}),
          consent: { ...input.consent, capturedAt: this.consentCapturedAt(), captureMethod: "hosted-form" },
          sourceAttestation: "hosted-form",
          idempotencyKey,
        },
        { now: () => this.now(), publicBaseUrl: this.dependencies.publicBaseUrl },
      );
      const entry = result.records.find((record) => record.recordType === "entrant");
      if (!entry) throw new Error("The giveaway receipt did not resolve its private entry record.");
      return { id: entry.id, state: entry.state, referralCode: String(entry.data.referralCode), replayed: result.audit.replayed === true };
    } catch (error) {
      if (error instanceof PublicGrowthError) throw error;
      if (error instanceof Error && /idempotency key|already entered|referral code/i.test(error.message)) throw new PublicGrowthError(409, "This pseudonymous participant already entered or the referral is invalid.");
      throw error;
    }
  }

  async pageBySlug(workspaceSlug: string, pageSlug: string) {
    return this.page(await this.workspaceBySlug(workspaceSlug), pageSlug);
  }

  async pageByWorkspaceId(workspaceId: string, pageVersionId: string) {
    const workspace = await this.workspaceById(workspaceId);
    const versions = await this.workflow(workspace, "brand-pages", "page-version");
    const version = versions.find((candidate) => candidate.id === pageVersionId);
    if (!version || typeof version.data.pageId !== "string") throw new PublicGrowthError(404, "Published page not found.");
    const pages = await this.workflow(workspace, "brand-pages", "page");
    const page = pages.find((candidate) => candidate.id === version.data.pageId);
    if (!page || page.data.activePageVersionId !== version.id) throw new PublicGrowthError(404, "Published page not found.");
    return this.resolvePage(workspace, page, version);
  }

  private async page(workspace: SuiteWorkspace, pageSlug: string) {
    const pages = await this.workflow(workspace, "brand-pages", "page");
    const matches = pages.filter((candidate) => candidate.data.slug === pageSlug && candidate.state === "published" && candidate.data.public === true);
    if (matches.length !== 1 || typeof matches[0].data.activePageVersionId !== "string") throw new PublicGrowthError(404, "Published page not found.");
    const versions = await this.workflow(workspace, "brand-pages", "page-version");
    const version = versions.find((candidate) => candidate.id === matches[0].data.activePageVersionId);
    if (!version) throw new PublicGrowthError(404, "Published page not found.");
    return this.resolvePage(workspace, matches[0], version);
  }

  private async resolvePage(workspace: SuiteWorkspace, page: SuiteRecord, pageVersion: SuiteRecord): Promise<PublishedPageProjection> {
    if (page.state !== "published" || page.data.public !== true || page.data.activePageVersionId !== pageVersion.id || pageVersion.state !== "published" || pageVersion.data.public !== true || pageVersion.data.pageId !== page.id || !validHash(pageVersion) || !validApproval(pageVersion)) throw new PublicGrowthError(404, "Published page not found.");
    const theme = validTheme(pageVersion.data.theme, ["accent", "background", "foreground"] as const);
    if (!theme || !["stack", "cards", "editorial"].includes(String(pageVersion.data.layout)) || !Array.isArray(pageVersion.data.links)) throw new PublicGrowthError(404, "Published page not found.");
    const destinations = await this.workflow(workspace, "brand-pages", "destination-version");
    const links: PublishedPageProjection["links"] = [];
    for (const candidate of pageVersion.data.links) {
      const link = object(candidate);
      if (!link || typeof link.key !== "string" || typeof link.label !== "string" || typeof link.destinationVersionId !== "string") throw new PublicGrowthError(404, "Published page not found.");
      const destination = destinations.find((record) => record.id === link.destinationVersionId);
      const href = destination ? publicHttps(destination.data.destination) : undefined;
      if (!destination || destination.data.pageId !== page.id || destination.data.linkKey !== link.key || !validHash(destination) || !href || destination.state === "disabled") throw new PublicGrowthError(404, "Published page not found.");
      links.push({ key: link.key, label: link.label, accessibilityLabel: typeof link.accessibilityLabel === "string" ? link.accessibilityLabel : "", destination: href, destinationVersionId: destination.id });
    }
    return {
      workspaceId: workspace.id,
      pageId: page.id,
      pageVersionId: pageVersion.id,
      slug: String(page.data.slug),
      title: pageVersion.title,
      description: String(pageVersion.data.description ?? ""),
      locale: String(page.data.locale ?? "en-US"),
      layout: pageVersion.data.layout as PublishedPageProjection["layout"],
      theme: theme as PublishedPageProjection["theme"],
      links,
      contentHash: String(pageVersion.data.contentHash),
    };
  }

  async qrBySlug(workspaceSlug: string, qrSlug: string) {
    return this.qr(await this.workspaceBySlug(workspaceSlug), qrSlug);
  }

  async qrByWorkspaceId(workspaceId: string, qrSlug: string) {
    return this.qr(await this.workspaceById(workspaceId), qrSlug);
  }

  private async qr(workspace: SuiteWorkspace, qrSlug: string): Promise<ActiveQrProjection> {
    const routes = await this.workflow(workspace, "brand-pages", "qr-route");
    const matches = routes.filter((candidate) => candidate.data.slug === qrSlug && candidate.state === "active" && candidate.data.public === true);
    if (matches.length !== 1 || typeof matches[0].data.activeDestinationVersionId !== "string") throw new PublicGrowthError(404, "Active QR route not found.");
    const route = matches[0];
    const destinations = await this.workflow(workspace, "brand-pages", "qr-destination-version");
    const destination = destinations.find((candidate) => candidate.id === route.data.activeDestinationVersionId);
    const href = destination ? publicHttps(destination.data.destination) : undefined;
    const style = object(route.data.style);
    if (!destination || destination.state !== "active" || destination.data.qrRouteId !== route.id || !validHash(destination) || !validApproval(destination) || !href || !style || !/^#[0-9A-Fa-f]{6}$/.test(String(style.foreground)) || !/^#[0-9A-Fa-f]{6}$/.test(String(style.background)) || !["L", "M", "Q", "H"].includes(String(style.errorCorrection)) || !["aggregate", "no-analytics"].includes(String(route.data.privacyMode))) throw new PublicGrowthError(404, "Active QR route not found.");
    return {
      routeId: route.id,
      destinationVersionId: destination.id,
      slug: String(route.data.slug),
      destination: href,
      contentHash: String(destination.data.contentHash),
      privacyMode: route.data.privacyMode as ActiveQrProjection["privacyMode"],
      style: { foreground: String(style.foreground), background: String(style.background), errorCorrection: style.errorCorrection as ActiveQrProjection["style"]["errorCorrection"] },
    };
  }
}
