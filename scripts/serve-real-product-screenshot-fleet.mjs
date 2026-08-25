import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/server/app.ts";
import { MemoryRepository } from "../src/server/repository.ts";
import { executeSuiteAction } from "../src/server/suite-engine.ts";
import { MemorySuiteStore } from "../src/server/suite-store.ts";
import { suiteModules } from "../src/shared/suite.ts";

const root = resolve(process.argv[2] ?? "");
const basePort = Number(process.argv[3] ?? 4300);
const backendPort = basePort - 1;
const webKey = process.env.PRODUCT_WEB_KEY ?? "real-backend-screenshot-workspace-2026";

if (!process.argv[2]) throw new Error("Usage: node --import tsx scripts/serve-real-product-screenshot-fleet.mjs <generated-product-root> [base-port]");
if (!Number.isInteger(basePort) || backendPort < 1024 || basePort + 36 > 65535) throw new Error("The base port must leave room for the backend and 37 product servers.");
if (webKey.length < 24) throw new Error("PRODUCT_WEB_KEY must contain at least 24 characters.");

const directories = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (directories.length !== 37) throw new Error("Expected 37 generated product directories, found " + directories.length + ".");

const repository = new MemoryRepository();
const suiteStore = new MemorySuiteStore("fleet");
const backend = createServer(await createApp({
  repository,
  suiteStore,
  suiteEntitlementMode: "unrestricted",
}));
await new Promise((resolveListen, rejectListen) => {
  backend.once("error", rejectListen);
  backend.listen(backendPort, "127.0.0.1", resolveListen);
});
const backendUrl = "http://127.0.0.1:" + backendPort;

async function api(path, init) {
  const response = await fetch(backendUrl + path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(path + " failed with HTTP " + response.status + ": " + (body.error ?? "unknown error"));
  return body;
}

const signup = await api("/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    displayName: "Real Product Screenshot Workspace",
    email: "real-product-screenshots@example.test",
    password: "real-product-screenshots-password",
  }),
});
const ownerId = String(signup.user.id);
await suiteStore.setWorkspacePlan(ownerId, "fleet");
for (const module of suiteModules) await suiteStore.enableModule(ownerId, module.id);
const workspace = await suiteStore.getOrCreateWorkspace(ownerId);

function durableRecords(result) {
  if (result?.kind === "record" && result.record) return [result.record];
  if (result?.kind === "command" && Array.isArray(result.records)) return result.records;
  return [];
}

const accountResult = await executeSuiteAction(suiteStore, ownerId, "crm", "account-upsert", {
  externalKey: "screenshot-workspace-account",
  name: "Northwind Studio",
  domain: "northwind.example",
  idempotencyKey: "screenshot.account.seed.0001",
});
const account = durableRecords(accountResult).find((record) => record.recordType === "account");
if (!account) throw new Error("The screenshot workspace account fixture was not created.");
const contactResult = await executeSuiteAction(suiteStore, ownerId, "crm", "contact-link", {
  accountId: account.id,
  name: "Asha Patel",
  email: "asha@example.test",
  consentBasis: "Synthetic local screenshot fixture.",
  idempotencyKey: "screenshot.contact.seed.0001",
});
const contact = durableRecords(contactResult).find((record) => record.recordType === "contact");
if (!contact) throw new Error("The screenshot workspace contact fixture was not created.");

const rawToken = await suiteStore.createApiToken(ownerId, {
  name: "Local screenshot product clients",
  scopes: ["read", "write", "ai"],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});
if (!rawToken) throw new Error("The local screenshot workspace API token could not be created.");

const publicForm = durableRecords(await executeSuiteAction(suiteStore, ownerId, "forms", "form-create", { name: "Project brief" }))
  .find((record) => record.recordType === "form");
if (!publicForm) throw new Error("The public form fixture was not created.");
const publicFormRelease = durableRecords(await executeSuiteAction(suiteStore, ownerId, "forms", "form-draft", {
  formId: publicForm.id,
  title: "Tell us what you are building",
  schema: { version: 1, fields: [
    { key: "name", type: "short-text", required: true, purpose: "Address the response", privacy: "internal" },
    { key: "email", type: "email", required: true, purpose: "Reply about the project", privacy: "restricted" },
    { key: "project-type", type: "choice", required: true, purpose: "Route the request", privacy: "internal", choices: ["Website", "Application", "Campaign"] },
    { key: "details", type: "long-text", required: true, purpose: "Understand the requested outcome", privacy: "internal" },
  ] },
  logic: [],
})).find((record) => record.recordType === "form-release");
if (!publicFormRelease) throw new Error("The public form release fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "forms", "release-publish", {
  releaseId: publicFormRelease.id,
  contentHash: publicFormRelease.data.contentHash,
  idempotencyKey: "screenshot.form.publish.0001",
});

const publicHost = durableRecords(await executeSuiteAction(suiteStore, ownerId, "schedule", "host-create", { name: "Asha Patel" }))
  .find((record) => record.recordType === "host");
if (!publicHost) throw new Error("The public scheduling host fixture was not created.");
const publicScheduleRevision = durableRecords(await executeSuiteAction(suiteStore, ownerId, "schedule", "schedule-draft", {
  name: "Daily consultation hours",
  timeZone: "America/New_York",
  hostIds: [publicHost.id],
  windows: Array.from({ length: 7 }, (_value, dayOfWeek) => ({ dayOfWeek, start: "09:00", end: "17:00" })),
})).find((record) => record.recordType === "schedule-revision");
if (!publicScheduleRevision) throw new Error("The public schedule revision fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "schedule", "schedule-publish", {
  revisionId: publicScheduleRevision.id,
  contentHash: publicScheduleRevision.data.contentHash,
});
const publicEventRelease = durableRecords(await executeSuiteAction(suiteStore, ownerId, "schedule", "event-draft", {
  name: "Product consultation",
  slug: "product-consultation",
  scheduleRevisionId: publicScheduleRevision.id,
  hostIds: [publicHost.id],
  durationMinutes: 30,
})).find((record) => record.recordType === "event-release");
if (!publicEventRelease) throw new Error("The public event release fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "schedule", "event-publish", {
  releaseId: publicEventRelease.id,
  contentHash: publicEventRelease.data.contentHash,
});

const publicFeedbackBoard = durableRecords(await executeSuiteAction(suiteStore, ownerId, "feedback", "board-create", {
  name: "Northwind product direction",
  visibility: "public",
  votingPolicy: "public",
  idempotencyKey: "screenshot.feedback.board.0001",
})).find((record) => record.recordType === "feedback-board");
if (!publicFeedbackBoard) throw new Error("The public feedback board fixture was not created.");
const publicFeedbackRequest = durableRecords(await executeSuiteAction(suiteStore, ownerId, "feedback", "request-submit", {
  boardId: publicFeedbackBoard.id,
  title: "Saved workspace views",
  problem: "Let each teammate reopen the same filtered workspace without rebuilding it.",
  consent: true,
  idempotencyKey: "screenshot.feedback.request.0001",
})).find((record) => record.recordType === "feedback-request");
if (!publicFeedbackRequest) throw new Error("The public feedback request fixture was not created.");

const publicKnowledgeLibrary = durableRecords(await executeSuiteAction(suiteStore, ownerId, "knowledge", "library-create", {
  name: "Northwind field manual",
  defaultAccess: "public",
  locale: "en-US",
  reviewCadenceDays: 60,
  idempotencyKey: "screenshot.knowledge.library.0001",
})).find((record) => record.recordType === "knowledge-library");
if (!publicKnowledgeLibrary) throw new Error("The public knowledge library fixture was not created.");
const publicKnowledgeRevision = durableRecords(await executeSuiteAction(suiteStore, ownerId, "knowledge", "page-revision-draft", {
  libraryId: publicKnowledgeLibrary.id,
  title: "Run a calm, evidence-first incident review",
  content: "# Start with observed facts\n\nRecord the customer impact, time window, and verified system behavior before proposing a cause.\n\n## Keep the review useful\n\n- Separate observations from hypotheses\n- Link each decision to reviewed evidence\n- Assign a clear owner and follow-up date\n\n> A durable incident review improves the system without turning uncertainty into blame.",
  sourceIds: [],
  idempotencyKey: "screenshot.knowledge.revision.0001",
})).find((record) => record.recordType === "page-revision");
if (!publicKnowledgeRevision) throw new Error("The public knowledge revision fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "knowledge", "page-revision-publish", {
  revisionId: publicKnowledgeRevision.id,
  contentHash: publicKnowledgeRevision.data.contentHash,
  dryRun: false,
  approval: {
    approved: true,
    approvedBy: ownerId,
    approvedAt: new Date().toISOString(),
    decisionId: "screenshot.knowledge.publish.approval.0001",
    reason: "Publish the exact synthetic AtlasBase revision for real-backend screenshot capture.",
  },
  idempotencyKey: "screenshot.knowledge.publish.0001",
});
await executeSuiteAction(suiteStore, ownerId, "knowledge", "source-link", {
  revisionId: publicKnowledgeRevision.id,
  locator: "https://example.com/operations/incident-review-standard",
  observedAt: new Date().toISOString(),
  contentHash: createHash("sha256").update("northwind-incident-review-standard-v1", "utf8").digest("hex"),
  trustNote: "Reviewed operating standard maintained by the Northwind reliability team.",
  idempotencyKey: "screenshot.knowledge.source.0001",
});

const giveawayApprovalTime = new Date();
const publicGiveaway = durableRecords(await executeSuiteAction(suiteStore, ownerId, "giveaways", "contest-create", {
  name: "Northwind launch giveaway",
  description: "Enter the open product launch draw from this real FairLaunch workspace.",
  closesAt: "2035-12-31T23:59:00.000Z",
  rules: "One consented entry per email. Duplicate retries return the original private entry, and the published draw proof never exposes participant identity.",
  entropyCommitment: createHash("sha256").update("northwind-screenshot-draw-secret", "utf8").digest("hex"),
  consentPolicyVersion: "screenshot-giveaway-policy-v1",
  referralBonusCap: 2,
  prizeDescription: "One annual Northwind workspace plan",
  idempotencyKey: "screenshot.giveaway.create.0001",
})).find((record) => record.recordType === "contest");
if (!publicGiveaway) throw new Error("The public giveaway fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "giveaways", "contest-publish", {
  contestId: publicGiveaway.id,
  expectedVersion: 1,
  rulesHash: publicGiveaway.data.rulesHash,
  dryRun: false,
  approval: {
    approved: true,
    approvedBy: ownerId,
    approvedAt: giveawayApprovalTime.toISOString(),
    decisionId: "screenshot.giveaway.publish.approval.0001",
    reason: "Publish the synthetic local FairLaunch fixture for real-backend screenshot capture.",
  },
  idempotencyKey: "screenshot.giveaway.publish.0001",
});

const publicBrandPage = durableRecords(await executeSuiteAction(suiteStore, ownerId, "brand-pages", "page-create", {
  slug: "northwind-studio",
  name: "Northwind Studio",
  privacyMode: "no-analytics",
  locale: "en-US",
  idempotencyKey: "screenshot.brand-page.create.0001",
})).find((record) => record.recordType === "page");
if (!publicBrandPage) throw new Error("The public brand page fixture was not created.");
const publicBrandPageLinks = [];
for (const link of [
  { key: "platform", destination: "https://example.com/platform", label: "Explore the platform", accessibilityLabel: "Explore the Northwind platform" },
  { key: "reports", destination: "https://example.com/reports", label: "Read field reports", accessibilityLabel: "Read Northwind field reports" },
  { key: "contact", destination: "https://example.com/contact", label: "Start a conversation", accessibilityLabel: "Contact the Northwind team" },
]) {
  const destination = durableRecords(await executeSuiteAction(suiteStore, ownerId, "brand-pages", "destination-version-create", {
    pageId: publicBrandPage.id,
    linkKey: link.key,
    destination: link.destination,
    label: link.label,
    accessibilityLabel: link.accessibilityLabel,
    campaign: { source: "beaconpage", medium: "published-page", name: "northwind-studio" },
    idempotencyKey: "screenshot.brand-page.destination." + link.key + ".0001",
  })).find((record) => record.recordType === "destination-version");
  if (!destination) throw new Error("The public brand page " + link.key + " destination fixture was not created.");
  publicBrandPageLinks.push({ key: link.key, label: link.label, destinationVersionId: destination.id, accessibilityLabel: link.accessibilityLabel });
}
const publicBrandPageVersion = durableRecords(await executeSuiteAction(suiteStore, ownerId, "brand-pages", "page-version-create", {
  pageId: publicBrandPage.id,
  title: "Northwind Studio",
  description: "Field notes, product work, and a direct line to the team behind the Northwind workspace.",
  links: publicBrandPageLinks,
  layout: "cards",
  theme: { accent: "#D9FF63", background: "#10150F", foreground: "#F5F7EC", radiusPx: 18 },
  idempotencyKey: "screenshot.brand-page.version.0001",
})).find((record) => record.recordType === "page-version");
if (!publicBrandPageVersion) throw new Error("The public brand page version fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "brand-pages", "page-version-publish", {
  pageVersionId: publicBrandPageVersion.id,
  contentHash: publicBrandPageVersion.data.contentHash,
  dryRun: false,
  approval: {
    approved: true,
    approvedBy: ownerId,
    approvedAt: new Date().toISOString(),
    decisionId: "screenshot.brand-page.publish.approval.0001",
    reason: "Publish the synthetic local BeaconPage fixture for real-backend screenshot capture.",
  },
  idempotencyKey: "screenshot.brand-page.publish.0001",
});

const proofPortCollection = durableRecords(await executeSuiteAction(suiteStore, ownerId, "testimonials", "collection-create", {
  name: "Northwind customer outcomes",
  purpose: "Share a specific result for human review before anything can be published.",
  consentPolicyVersion: "screenshot-proofport-policy-v1",
  retentionDays: 730,
  allowedLocales: ["en-US"],
  idempotencyKey: "screenshot.proofport.collection.0001",
})).find((record) => record.recordType === "collection");
if (!proofPortCollection) throw new Error("The ProofPort collection fixture was not created.");
const unusedProofPortRequestResult = await executeSuiteAction(suiteStore, ownerId, "testimonials", "request-draft", {
  collectionId: proofPortCollection.id,
  recipientRefHash: createHash("sha256").update("northwind-unused-proofport-request", "utf8").digest("hex"),
  expiresAt: "2035-12-31T23:59:00.000Z",
  locale: "en-US",
  contextLabel: "Northwind customer story",
  idempotencyKey: "screenshot.proofport.request.unused.0001",
}, { publicBaseUrl: "https://proofport.example.test" });
const unusedProofPortRequest = durableRecords(unusedProofPortRequestResult).find((record) => record.recordType === "collection-request");
const unusedProofPortToken = String(unusedProofPortRequestResult.audit?.accessToken ?? "");
if (!unusedProofPortRequest || !/^[A-Za-z0-9_-]{32,128}$/.test(unusedProofPortToken)) throw new Error("The unused ProofPort collection URL fixture was not created.");
const unusedProofPortCollectionUrl = backendUrl + "/collect/testimonials/" + encodeURIComponent(workspace.id) + "/" + encodeURIComponent(unusedProofPortRequest.id) + "?token=" + encodeURIComponent(unusedProofPortToken);

const submittedProofPortRequestResult = await executeSuiteAction(suiteStore, ownerId, "testimonials", "request-draft", {
  collectionId: proofPortCollection.id,
  recipientRefHash: createHash("sha256").update("northwind-published-proofport-request", "utf8").digest("hex"),
  expiresAt: "2035-12-31T23:59:00.000Z",
  locale: "en-US",
  contextLabel: "Northwind workspace review",
  idempotencyKey: "screenshot.proofport.request.submitted.0001",
}, { publicBaseUrl: "https://proofport.example.test" });
const submittedProofPortRequest = durableRecords(submittedProofPortRequestResult).find((record) => record.recordType === "collection-request");
const submittedProofPortToken = String(submittedProofPortRequestResult.audit?.accessToken ?? "");
if (!submittedProofPortRequest || !/^[A-Za-z0-9_-]{32,128}$/.test(submittedProofPortToken)) throw new Error("The submitted ProofPort request fixture was not created.");
const proofPortSubmission = await api("/api/public/testimonials/" + encodeURIComponent(workspace.id) + "/requests/" + encodeURIComponent(submittedProofPortRequest.id) + "/submissions?token=" + encodeURIComponent(submittedProofPortToken), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    authorName: "Asha Patel",
    content: "Northwind gave our team one place to review the work, make a decision, and move the launch forward.",
    attribution: "first-name",
    authorRole: "Operations lead",
    organization: "Northwind Studio",
    consent: { granted: true, policyVersion: "screenshot-proofport-policy-v1", purposes: ["testimonial-publication"] },
  }),
});
const proofPortTestimonialId = String(proofPortSubmission.id ?? "");
if (!/^[0-9a-f-]{36}$/.test(proofPortTestimonialId)) throw new Error("The public ProofPort submission fixture was not recorded.");
const proofPortApprovalTime = new Date().toISOString();
const proofPortModeration = durableRecords(await executeSuiteAction(suiteStore, ownerId, "testimonials", "moderation-decide", {
  testimonialId: proofPortTestimonialId,
  decision: "accept",
  reason: "Consent, attribution, and the exact statement were reviewed for the local screenshot fixture.",
  expectedVersion: 1,
  dryRun: false,
  approval: {
    approved: true,
    approvedBy: ownerId,
    approvedAt: proofPortApprovalTime,
    decisionId: "screenshot.proofport.moderation.approval.0001",
    reason: "Approve the exact synthetic ProofPort statement after human-review simulation.",
  },
  idempotencyKey: "screenshot.proofport.moderation.0001",
})).find((record) => record.recordType === "moderation-decision");
if (!proofPortModeration) throw new Error("The ProofPort moderation fixture was not created.");
const proofPortPublication = durableRecords(await executeSuiteAction(suiteStore, ownerId, "testimonials", "publication-version-create", {
  testimonialId: proofPortTestimonialId,
  content: "Northwind gave our team one place to review the work, make a decision, and move the launch forward.",
  attributionLabel: "Asha, Operations lead",
  disclosure: "Submitted with publication consent and published after review.",
  moderationDecisionId: proofPortModeration.id,
  idempotencyKey: "screenshot.proofport.publication.0001",
})).find((record) => record.recordType === "publication-version");
if (!proofPortPublication) throw new Error("The ProofPort publication fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "testimonials", "publication-publish", {
  publicationVersionId: proofPortPublication.id,
  contentHash: proofPortPublication.data.contentHash,
  dryRun: false,
  approval: {
    approved: true,
    approvedBy: ownerId,
    approvedAt: proofPortApprovalTime,
    decisionId: "screenshot.proofport.publication.approval.0001",
    reason: "Publish the exact reviewed synthetic ProofPort statement.",
  },
  idempotencyKey: "screenshot.proofport.publication.publish.0001",
});
const proofPortWidget = durableRecords(await executeSuiteAction(suiteStore, ownerId, "testimonials", "widget-version-create", {
  widgetKey: "northwind-proof",
  name: "Northwind customer proof",
  publicationVersionIds: [proofPortPublication.id],
  layout: "carousel",
  theme: { accent: "#D9FF63", surface: "#10150F", text: "#F5F7EC", radiusPx: 18 },
  idempotencyKey: "screenshot.proofport.widget.0001",
})).find((record) => record.recordType === "widget-version");
if (!proofPortWidget) throw new Error("The ProofPort widget fixture was not created.");
await executeSuiteAction(suiteStore, ownerId, "testimonials", "widget-publish", {
  widgetVersionId: proofPortWidget.id,
  contentHash: proofPortWidget.data.contentHash,
  dryRun: false,
  approval: {
    approved: true,
    approvedBy: ownerId,
    approvedAt: proofPortApprovalTime,
    decisionId: "screenshot.proofport.widget.approval.0001",
    reason: "Publish the exact synthetic ProofPort widget for real-backend screenshot capture.",
  },
  idempotencyKey: "screenshot.proofport.widget.publish.0001",
});

const publicSurfaces = {
  form: backendUrl + "/forms/" + encodeURIComponent(workspace.slug) + "/" + encodeURIComponent(publicFormRelease.id),
  booking: backendUrl + "/book/" + encodeURIComponent(workspace.slug) + "/product-consultation",
  feedback: backendUrl + "/feedback/" + encodeURIComponent(workspace.slug) + "/" + encodeURIComponent(publicFeedbackBoard.id),
  knowledgeLibrary: backendUrl + "/knowledge/" + encodeURIComponent(workspace.slug) + "/" + encodeURIComponent(publicKnowledgeLibrary.id),
  knowledgeRevision: backendUrl + "/knowledge/" + encodeURIComponent(workspace.slug) + "/" + encodeURIComponent(publicKnowledgeLibrary.id) + "/pages/" + encodeURIComponent(publicKnowledgeRevision.id),
  knowledgeRevisionProjection: backendUrl + "/api/public/knowledge/" + encodeURIComponent(workspace.slug) + "/libraries/" + encodeURIComponent(publicKnowledgeLibrary.id) + "/pages/" + encodeURIComponent(publicKnowledgeRevision.id),
  giveaway: backendUrl + "/giveaways/" + encodeURIComponent(workspace.slug) + "/" + encodeURIComponent(publicGiveaway.id),
  brandPage: backendUrl + "/p/" + encodeURIComponent(workspace.slug) + "/northwind-studio",
  brandPageDiscovery: backendUrl + "/api/public/" + encodeURIComponent(workspace.slug) + "/brand-pages",
  testimonialCollection: unusedProofPortCollectionUrl,
  testimonialWidget: backendUrl + "/embeds/testimonials/" + encodeURIComponent(workspace.id) + "/" + encodeURIComponent(proofPortWidget.id),
  testimonialDiscovery: backendUrl + "/api/public/" + encodeURIComponent(workspace.slug) + "/testimonials",
};

function primaryInput(manifest, action) {
  const input = structuredClone(action.exampleInput);
  if (manifest.module.id === "inbox" && action.id === "thread-open") input.contactId = contact.id;
  if (manifest.module.id === "people" && action.id === "create-profile") {
    input.employeeRef = ownerId;
    input.managerRef = ownerId;
  }
  if (manifest.module.id === "insights" && action.id === "source-register") input.ownerRef = ownerId;
  if (manifest.module.id === "assurance" && action.id === "create-program") input.ownerRef = ownerId;
  return input;
}

const servers = [];
const products = [];
for (const [index, slug] of directories.entries()) {
  const productRoot = resolve(root, slug);
  const imported = await Promise.all([
    import(pathToFileURL(resolve(productRoot, "src/web-server.mjs")).href),
    import(pathToFileURL(resolve(productRoot, "src/client.mjs")).href),
    import(pathToFileURL(resolve(productRoot, "src/manifest.mjs")).href),
  ]);
  const createProductWebServer = imported[0].createProductWebServer;
  const ProductClient = imported[1].ProductClient;
  const manifest = imported[2].manifest;
  if (manifest.product.slug !== slug) throw new Error("Directory " + slug + " contains the " + manifest.product.slug + " manifest.");
  const client = new ProductClient({ baseUrl: backendUrl, token: rawToken.token });
  const primary = manifest.actions.find((action) => action.id === manifest.experience.primaryActionId);
  if (!primary) throw new Error(slug + " has no primary action.");
  const seeded = await client.runAction(primary.id, primaryInput(manifest, primary));
  const durable = [...(seeded.records ?? []), ...(seeded.record ? [seeded.record] : [])].find((record) => record.moduleId === manifest.module.id);
  if (!durable) throw new Error(slug + " primary action did not create a durable backend record.");

  const server = createProductWebServer({ client, webKey });
  const port = basePort + index;
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  servers.push(server);
  products.push({ slug, name: manifest.product.name, moduleId: manifest.module.id, recordId: durable.id, port, url: "http://127.0.0.1:" + port + "/" });
}

process.stdout.write(JSON.stringify({ ok: true, mode: "real-backend", root, webKey, backendUrl, workspaceId: workspace.id, publicSurfaces, products }) + "\n");

async function close() {
  await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(() => resolveClose()))));
  await new Promise((resolveClose) => backend.close(() => resolveClose()));
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    close().finally(() => process.exit(0));
  });
}
