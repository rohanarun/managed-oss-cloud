#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultRoot = "/Volumes/SP AI 01_16/managed-oss-product-repos";
const defaultModel = "google/gemini-3.7-flash";
const expectedStepIds = ["overview", "connect", "configure", "execute", "inspect"];
const expectedAssertions = [
  "browser-authenticated-real-backend",
  "guided-form-submitted",
  "action-http-200",
  "durable-record-returned",
  "record-detail-http-200",
  "exact-record-reopened-in-ui",
];
const forbiddenEvidence = [
  /sk-or-[A-Za-z0-9._~-]+/i,
  /authorization\s*[:=]\s*bearer\b/i,
  /bearer\s+[A-Za-z0-9._~-]{12,}/i,
  /OPENROUTER_API_KEY/i,
  /127\.0\.0\.1/i,
  /localhost/i,
  /webKey/i,
  /apiToken/i,
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unexpected fields.`);
}

function assertSingleLineText(value, label, maximumLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be non-empty, single-line text no longer than ${maximumLength} characters.`);
  }
}

function assertSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${label} is not a SHA-256 digest.`);
}

function assertUsage(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}

function timestampMs(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  if (!match) throw new Error(`Invalid SubRip timestamp ${value}.`);
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function parseSrt(value) {
  const blocks = value.trim().split(/\r?\n\r?\n/);
  return blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    if (Number(lines[0]) !== index + 1) throw new Error("SubRip cues must use consecutive one-based indices.");
    const timing = /^(\S+) --> (\S+)$/.exec(lines[1] ?? "");
    if (!timing || lines.slice(2).join(" ").trim().length === 0) throw new Error(`SubRip cue ${index + 1} is incomplete.`);
    return { startMs: timestampMs(timing[1]), endMs: timestampMs(timing[2]), text: lines.slice(2).join(" ").trim() };
  });
}

async function metadata(path) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width,height,r_frame_rate:format=duration,size",
    "-of", "json",
    path,
  ], { maxBuffer: 4 * 1024 * 1024 });
  const body = JSON.parse(stdout);
  const stream = body.streams?.[0] ?? {};
  return {
    codec: stream.codec_name,
    pixelFormat: stream.pix_fmt,
    width: Number(stream.width),
    height: Number(stream.height),
    frameRate: stream.r_frame_rate,
    durationSeconds: Number(body.format?.duration),
    sizeBytes: Number(body.format?.size),
  };
}

async function meaningfulFrameHashes(path) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", path,
    "-vf", "fps=1/3,scale=320:180",
    "-an", "-f", "framemd5", "-",
  ], { maxBuffer: 4 * 1024 * 1024 });
  return new Set(stdout.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)?.trim()).filter(Boolean));
}

async function verifyOne(root, slug, expectedModel) {
  const productRoot = join(root, slug);
  const videoPath = join(productRoot, "docs", "tutorial.mp4");
  const srtPath = join(productRoot, "docs", "tutorial.srt");
  const proofPath = join(productRoot, "docs", "tutorial-proof.json");
  const [manifestBytes, video, srtBytes, proofBytes] = await Promise.all([
    readFile(join(productRoot, "product-manifest.json")),
    readFile(videoPath),
    readFile(srtPath),
    readFile(proofPath),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const proof = JSON.parse(proofBytes);
  if (video.length < 200_000 || video.length > 8 * 1024 * 1024) throw new Error(`${slug} tutorial must be between 200 KB and 8 MiB.`);
  const moovOffset = video.indexOf(Buffer.from("moov"));
  const mediaOffset = video.indexOf(Buffer.from("mdat"));
  if (video.subarray(4, 8).toString("ascii") !== "ftyp" || moovOffset < 0 || mediaOffset < 0 || moovOffset > mediaOffset || !video.includes(Buffer.from("avc1"))) throw new Error(`${slug} tutorial is not a valid fast-start H.264 MP4.`);
  const videoInfo = await metadata(videoPath);
  if (videoInfo.codec !== "h264" || videoInfo.width !== 1280 || videoInfo.height !== 720 || videoInfo.pixelFormat !== "yuv420p" || videoInfo.durationSeconds < 8 || videoInfo.durationSeconds > 60) throw new Error(`${slug} tutorial metadata is invalid: ${JSON.stringify(videoInfo)}`);
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-f", "null", "-"], { maxBuffer: 4 * 1024 * 1024 });
  const hashes = await meaningfulFrameHashes(videoPath);
  if (hashes.size < 4) throw new Error(`${slug} tutorial does not show enough meaningful visual transitions.`);

  const srt = srtBytes.toString("utf8");
  const cues = parseSrt(srt);
  if (cues.length !== 5 || cues[0].startMs !== 0 || Math.abs(cues.at(-1).endMs - (videoInfo.durationSeconds * 1000)) > 250) throw new Error(`${slug} subtitles do not cover the full verified tutorial timeline.`);
  for (const [index, cue] of cues.entries()) {
    if (cue.endMs <= cue.startMs || (index > 0 && cue.startMs !== cues[index - 1].endMs)) throw new Error(`${slug} subtitle timing is not contiguous and monotonic.`);
  }

  if (proof.schema !== "managed-oss-functional-tutorial.v1" || proof.product?.slug !== slug || proof.product?.name !== manifest.product.name || proof.product?.moduleId !== manifest.module.id || proof.product?.version !== manifest.release.productVersion || proof.product?.manifestSha256 !== sha256(manifestBytes)) throw new Error(`${slug} tutorial proof is bound to the wrong product or manifest bytes.`);
  if (proof.backend?.release !== manifest.release.backendRelease || proof.backend?.commit !== manifest.release.backendCommit) throw new Error(`${slug} tutorial proof is bound to the wrong backend release.`);
  const testedAt = Date.parse(proof.testedAt);
  if (!Number.isFinite(testedAt) || testedAt > Date.now() + 300_000) throw new Error(`${slug} tutorial proof has an invalid test timestamp.`);
  if (proof.browser?.engine !== "Chromium" || typeof proof.browser?.version !== "string" || proof.browser.version.trim().length === 0 || proof.browser?.viewport?.width !== 1280 || proof.browser?.viewport?.height !== 720) throw new Error(`${slug} tutorial proof has invalid browser evidence.`);
  if (proof.functionalProof?.action?.id !== manifest.experience.primaryActionId || proof.functionalProof?.action?.httpStatus !== 200 || proof.functionalProof?.detail?.httpStatus !== 200 || proof.functionalProof?.detail?.matched !== true) throw new Error(`${slug} lacks successful action/detail functional proof.`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(proof.functionalProof?.record?.id ?? "")) throw new Error(`${slug} functional proof has no durable record identity.`);
  if (!Array.isArray(proof.functionalProof?.assertions) || proof.functionalProof.assertions.length !== expectedAssertions.length || expectedAssertions.some((assertion, index) => proof.functionalProof.assertions[index] !== assertion)) throw new Error(`${slug} functional proof is missing required browser/backend assertions.`);

  assertExactKeys(proof.explanation, ["title", "summary", "cues", "generation"], `${slug} tutorial explanation`);
  assertSingleLineText(proof.explanation.title, `${slug} tutorial title`, 80);
  assertSingleLineText(proof.explanation.summary, `${slug} tutorial summary`, 320);
  if (!Array.isArray(proof.timeline) || proof.timeline.length !== expectedStepIds.length || !Array.isArray(proof.explanation.cues) || proof.explanation.cues.length !== expectedStepIds.length) throw new Error(`${slug} lacks the exact tutorial timeline and Gemini cue count.`);
  for (const [index, cue] of cues.entries()) {
    const generated = proof.explanation.cues[index];
    const observed = proof.timeline[index];
    assertExactKeys(observed, ["stepId", "observedLabel", "observedFact", "startMs", "endMs"], `${slug} observed timeline step ${index + 1}`);
    assertExactKeys(generated, ["stepId", "startMs", "endMs", "label", "subtitle"], `${slug} generated cue ${index + 1}`);
    assertSingleLineText(observed.observedLabel, `${slug} observed label ${index + 1}`, 240);
    assertSingleLineText(observed.observedFact, `${slug} observed fact ${index + 1}`, 500);
    assertSingleLineText(generated.label, `${slug} generated label ${index + 1}`, 42);
    assertSingleLineText(generated.subtitle, `${slug} generated subtitle ${index + 1}`, 130);
    if (observed.stepId !== expectedStepIds[index] || generated.stepId !== observed.stepId || !Number.isInteger(observed.startMs) || !Number.isInteger(observed.endMs) || observed.endMs <= observed.startMs || (index === 0 ? observed.startMs !== 0 : observed.startMs !== proof.timeline[index - 1].endMs)) throw new Error(`${slug} observed timeline is invalid at ${expectedStepIds[index]}.`);
    if (generated.startMs !== observed.startMs || generated.endMs !== observed.endMs || generated.startMs !== cue.startMs || generated.endMs !== cue.endMs || generated.subtitle !== cue.text) throw new Error(`${slug} committed subtitles differ from the observed timeline or Gemini cue set.`);
  }

  const generation = proof.explanation.generation;
  if (generation?.provider !== "OpenRouter" || generation?.model !== expectedModel || generation?.requestedModel !== expectedModel || generation?.responseModel !== expectedModel || typeof generation?.responseId !== "string" || generation.responseId.trim().length === 0 || generation.responseId.length > 240) throw new Error(`${slug} lacks exact Gemini/OpenRouter response evidence.`);
  const responseCreatedAt = Date.parse(generation.responseCreatedAt);
  if (!Number.isFinite(responseCreatedAt) || responseCreatedAt > testedAt + 300_000 || responseCreatedAt < testedAt - 900_000) throw new Error(`${slug} OpenRouter response time is not bound to the tutorial run.`);
  assertUsage(generation.usage?.promptTokens, `${slug} OpenRouter prompt-token evidence`);
  assertUsage(generation.usage?.completionTokens, `${slug} OpenRouter completion-token evidence`);
  assertUsage(generation.usage?.totalTokens, `${slug} OpenRouter total-token evidence`);
  if (generation.usage.totalTokens < generation.usage.promptTokens + generation.usage.completionTokens) throw new Error(`${slug} OpenRouter token totals are internally inconsistent.`);
  assertSha256(generation.input?.rawVideoSha256, `${slug} model input video hash`);
  assertSha256(generation.input?.workflowFactsSha256, `${slug} model workflow-facts hash`);
  assertSha256(proof.video?.raw?.sha256, `${slug} raw video hash`);
  const workflowFacts = {
    product: { slug: proof.product.slug, name: proof.product.name, moduleId: proof.product.moduleId },
    verifiedAction: proof.functionalProof.action,
    verifiedRecord: proof.functionalProof.record,
    verifiedDetail: proof.functionalProof.detail,
    observedTimeline: proof.timeline,
  };
  if (generation.input.rawVideoSha256 !== proof.video.raw.sha256 || generation.input.workflowFactsSha256 !== sha256(canonicalJson(workflowFacts))) throw new Error(`${slug} Gemini input evidence is not bound to the recorded workflow.`);

  if (proof.video?.overlaysBurnedIn !== true || proof.video?.silent !== true || proof.video?.final?.file !== "docs/tutorial.mp4" || proof.video?.subtitles?.file !== "docs/tutorial.srt" || proof.video?.subtitles?.format !== "SubRip" || proof.video?.final?.sha256 !== sha256(video) || proof.video?.subtitles?.sha256 !== sha256(srtBytes)) throw new Error(`${slug} tutorial hashes, paths, or overlay claims are invalid.`);
  if (proof.video.final.codec !== videoInfo.codec || proof.video.final.width !== videoInfo.width || proof.video.final.height !== videoInfo.height || proof.video.final.sizeBytes !== videoInfo.sizeBytes || Math.abs(proof.video.final.durationSeconds - videoInfo.durationSeconds) > 0.001) throw new Error(`${slug} committed video metadata differs from the MP4 bytes.`);
  const evidenceStrings = [proofBytes.toString("utf8"), srt];
  for (const pattern of forbiddenEvidence) if (evidenceStrings.some((value) => pattern.test(value))) throw new Error(`${slug} tutorial evidence contains a credential, bearer header, or localhost value.`);
  return { slug, actionId: proof.functionalProof.action.id, recordId: proof.functionalProof.record.id, video: videoInfo, distinctFrames: hashes.size };
}

async function main() {
  const root = resolve(argument("--root") ?? defaultRoot);
  const expectedModel = argument("--model") ?? defaultModel;
  const requested = new Set((argument("--only") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const slugs = requested.size ? directories.filter((slug) => requested.has(slug)) : directories;
  if (!slugs.length || (requested.size && slugs.length !== requested.size) || (!requested.size && slugs.length !== 37)) throw new Error("Tutorial verification requires every requested product repository.");
  const results = [];
  for (const slug of slugs) results.push(await verifyOne(root, slug, expectedModel));
  process.stdout.write(JSON.stringify({ ok: true, verified: results.length, results }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
