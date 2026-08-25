import { createHash } from "node:crypto";

function clone(value) {
  return structuredClone(value ?? {});
}

function tutorialIdentifier(prefix, slug, maximumLength = 200) {
  return `${prefix}-${slug}`.replaceAll(/[^A-Za-z0-9._:-]+/g, "-").slice(0, maximumLength);
}

function shiftedDateTimeInputs(input, properties, now) {
  const entries = Object.entries(properties ?? {})
    .filter(([name, schema]) => schema?.format === "date-time" && typeof input[name] === "string")
    .map(([name]) => [name, new Date(input[name])])
    .filter(([, value]) => Number.isFinite(value.getTime()));
  if (!entries.length) return;
  const earliest = Math.min(...entries.map(([, value]) => value.getTime()));
  const safeThreshold = now.getTime() + (48 * 60 * 60 * 1000);
  if (earliest > safeThreshold) return;
  const target = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
  target.setUTCSeconds(0, 0);
  const shift = target.getTime() - earliest;
  for (const [name, value] of entries) input[name] = new Date(value.getTime() + shift).toISOString();
}

export function buildTutorialInput({ manifest, action, runtimeInput, ownerId, tutorialMemberId, now = new Date() }) {
  if (!manifest?.product?.slug || !manifest?.module?.id || !action?.id) throw new Error("A complete product manifest and primary action are required.");
  if (!ownerId || !tutorialMemberId) throw new Error("Tutorial inputs require real workspace owner and member identities.");
  const input = clone(runtimeInput);
  const slug = manifest.product.slug;
  const properties = action.inputSchema?.properties ?? {};

  if (typeof input.idempotencyKey === "string") input.idempotencyKey = `${manifest.module.id}.${action.id}.tutorial.0001`.slice(0, 200);
  if (typeof input.externalKey === "string") input.externalKey = tutorialIdentifier("tutorial", slug);
  if (typeof input.key === "string") input.key = tutorialIdentifier("tutorial", slug, 80);
  if (typeof input.slug === "string") input.slug = tutorialIdentifier("tutorial", slug, 120).toLowerCase();
  if (typeof input.hostname === "string") input.hostname = `tutorial-${slug}.example.com`;
  if (typeof input.name === "string") input.name = `${manifest.product.name} tutorial workspace`.slice(0, properties.name?.maxLength ?? 160);
  if (typeof input.title === "string") input.title = `${manifest.product.name} functional tutorial`.slice(0, properties.title?.maxLength ?? 240);
  if (typeof input.employeeRef === "string") input.employeeRef = tutorialMemberId;
  if (typeof input.managerRef === "string") input.managerRef = ownerId;
  if (typeof input.ownerRef === "string") input.ownerRef = ownerId;
  if (typeof input.entropyCommitment === "string" && /^[a-f0-9]{64}$/.test(input.entropyCommitment)) {
    input.entropyCommitment = createHash("sha256").update(`tutorial:${slug}:entropy`, "utf8").digest("hex");
  }
  shiftedDateTimeInputs(input, properties, now);
  return input;
}

export function durableRecordsFromActionResult(result) {
  if (result?.kind === "record" && result.record) return [result.record];
  if (result?.kind === "command" && Array.isArray(result.records)) return result.records;
  if (result?.kind === "mutation" && Array.isArray(result.records)) return result.records;
  return [];
}
