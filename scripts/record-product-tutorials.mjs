#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { findChromiumExecutable, runProductTutorialWorkflow } from "./product-tutorial-browser.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultProductRoot = "/Volumes/SP AI 01_16/managed-oss-product-repos";
const defaultModel = "google/gemini-3.7-flash";
const width = 1280;
const height = 720;
const frameRate = 8;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function redactedMessage(value, secret) {
  let message = String(value ?? "unknown error");
  if (secret) message = message.replaceAll(secret, "[REDACTED]");
  return message
    .replaceAll(/sk-or-[A-Za-z0-9._~-]+/gi, "[REDACTED_OPENROUTER_KEY]")
    .replaceAll(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]");
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

function readyLine(child) {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => rejectReady(new Error("The real product fleet did not become ready. " + stderr)), 45_000);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveReady(stdout.slice(0, newline));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error("The real product fleet exited before recording with code " + code + ". " + stderr));
    });
  });
}

async function startFleet(productRoot) {
  const webKey = `tutorial-browser-key-${createHash("sha256").update(productRoot).digest("hex").slice(0, 24)}`;
  const childEnvironment = { ...process.env, PRODUCT_WEB_KEY: webKey };
  delete childEnvironment.OPENROUTER_API_KEY;
  const child = spawn(process.execPath, ["--import", "tsx", join(repositoryRoot, "scripts", "serve-real-product-screenshot-fleet.mjs"), productRoot, "0"], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = JSON.parse(await readyLine(child));
  if (summary.ok !== true || summary.mode !== "real-backend" || summary.products?.length !== 37) throw new Error("The tutorial fleet returned an invalid readiness summary.");
  return { child, summary };
}

async function stopFleet(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function startFrameRecorder(page, framesDirectory) {
  await mkdir(framesDirectory, { recursive: true });
  let stopped = false;
  let frameCount = 0;
  let captureError;
  const intervalMs = 1000 / frameRate;
  const loop = (async () => {
    while (!stopped) {
      const startedAt = Date.now();
      try {
        await page.screenshot({
          path: join(framesDirectory, `frame-${String(frameCount).padStart(6, "0")}.jpg`),
          type: "jpeg",
          quality: 84,
          animations: "allow",
          caret: "hide",
        });
        frameCount += 1;
      } catch (error) {
        captureError = error;
        stopped = true;
        break;
      }
      const remaining = intervalMs - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
    }
  })();
  return {
    frameCount: () => frameCount,
    async stop() {
      stopped = true;
      await loop;
      if (captureError) throw captureError;
      if (frameCount < frameRate * 8) throw new Error(`Only ${frameCount} tutorial frames were captured.`);
      return { frameCount, durationMs: Math.round((frameCount / frameRate) * 1000) };
    },
  };
}

async function encodeFrames(framesDirectory, outputPath) {
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", String(frameRate),
    "-i", join(framesDirectory, "frame-%06d.jpg"),
    "-vf", "scale=in_range=full:out_range=tv,format=yuv420p",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "24",
    "-pix_fmt", "yuv420p",
    "-color_range", "tv",
    "-movflags", "+faststart",
    "-an",
    outputPath,
  ], { maxBuffer: 10 * 1024 * 1024 });
}

async function videoMetadata(videoPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,duration:format=duration,size",
    "-of", "json",
    videoPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] ?? {};
  return {
    codec: String(stream.codec_name ?? ""),
    width: Number(stream.width),
    height: Number(stream.height),
    durationSeconds: Number(stream.duration ?? parsed.format?.duration),
    sizeBytes: Number(parsed.format?.size),
  };
}

function copySchema() {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      cues: {
        type: "array",
        minItems: 5,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            stepId: { type: "string", enum: ["overview", "connect", "configure", "execute", "inspect"] },
            startMs: { type: "integer", minimum: 0 },
            endMs: { type: "integer", minimum: 1 },
            label: { type: "string" },
            subtitle: { type: "string" },
          },
          required: ["stepId", "startMs", "endMs", "label", "subtitle"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "summary", "cues"],
    additionalProperties: false,
  };
}

function validateGeneratedCopy(copy, timeline) {
  assertExactKeys(copy, ["title", "summary", "cues"], "Gemini tutorial object");
  assertSingleLineText(copy.title, "Gemini tutorial title", 80);
  assertSingleLineText(copy.summary, "Gemini tutorial summary", 320);
  if (!Array.isArray(copy.cues)) throw new Error("Gemini tutorial cues must be an array.");
  if (copy.cues.length !== timeline.length) throw new Error("Gemini returned the wrong tutorial cue count.");
  const expectedStepIds = ["overview", "connect", "configure", "execute", "inspect"];
  if (timeline.length !== expectedStepIds.length) throw new Error("The observed tutorial timeline has the wrong step count.");
  for (const [index, expected] of timeline.entries()) {
    const cue = copy.cues[index];
    if (expected.stepId !== expectedStepIds[index] || !Number.isInteger(expected.startMs) || !Number.isInteger(expected.endMs) || expected.endMs <= expected.startMs || (index === 0 ? expected.startMs !== 0 : expected.startMs !== timeline[index - 1].endMs)) {
      throw new Error(`The observed tutorial timeline is invalid at ${expectedStepIds[index]}.`);
    }
    assertExactKeys(cue, ["stepId", "startMs", "endMs", "label", "subtitle"], `Gemini cue ${index + 1}`);
    if (cue.stepId !== expected.stepId || cue.startMs !== expected.startMs || cue.endMs !== expected.endMs) throw new Error(`Gemini changed the observed timing for ${expected.stepId}.`);
    assertSingleLineText(cue.label, `Gemini label for ${expected.stepId}`, 42);
    assertSingleLineText(cue.subtitle, `Gemini subtitle for ${expected.stepId}`, 130);
  }
  return copy;
}

async function generateTutorialCopy({ apiKey, model, rawVideoPath, product, proof, timeline }) {
  const raw = await readFile(rawVideoPath);
  if (raw.length > 14_000_000) throw new Error(`${product.slug} raw video is too large for a conservative inline Gemini request.`);
  const workflowFacts = {
    product: { slug: product.slug, name: product.name, moduleId: product.moduleId },
    verifiedAction: proof.action,
    verifiedRecord: proof.record,
    verifiedDetail: proof.detail,
    observedTimeline: timeline,
  };
  const responseSchema = copySchema();
  const inputEvidence = {
    rawVideoSha256: sha256(raw),
    workflowFactsSha256: sha256(canonicalJson(workflowFacts)),
  };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    let body;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/rohanarun/managed-oss-cloud",
          "X-Title": "Managed OSS functional tutorials",
        },
        body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You write concise software tutorial overlays from verified evidence. Use only visible video events and supplied facts. Preserve every step ID and timestamp exactly. Never invent a click, result, capability, metric, or external integration.",
          },
          {
            role: "user",
            content: [
              { type: "video_url", video_url: { url: "data:video/mp4;base64," + raw.toString("base64") } },
              {
                type: "text",
                text: "Create one clear label and one short subtitle for each observed step. The subtitle should explain what the viewer can verify on screen, in plain business language. Return the exact supplied startMs and endMs values.\n\nVerified workflow JSON:\n" + JSON.stringify(workflowFacts) + (lastError ? "\n\nA prior response failed validation: " + redactedMessage(lastError.message, apiKey) : ""),
              },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 1400,
        provider: { require_parameters: true },
        response_format: {
          type: "json_schema",
          json_schema: { name: "functional_tutorial_copy", strict: true, schema: responseSchema },
        },
        }),
      });
      body = await response.json().catch(() => ({}));
    } catch (error) {
      lastError = new Error(`OpenRouter request attempt ${attempt} failed: ${redactedMessage(error instanceof Error ? error.message : error, apiKey)}`);
      if (attempt < 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1500));
        continue;
      }
      throw lastError;
    }
    if (!response.ok) {
      lastError = new Error(`OpenRouter returned HTTP ${response.status}: ${redactedMessage(body?.error?.message ?? body?.error ?? "unknown error", apiKey)}`);
      if (attempt < 3 && (response.status === 408 || response.status === 429 || response.status >= 500)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1500));
        continue;
      }
      throw lastError;
    }
    try {
      if (!Array.isArray(body.choices) || body.choices.length !== 1 || body.choices[0]?.finish_reason !== "stop") throw new Error("OpenRouter did not return one complete structured-output choice.");
      if (body.model !== model) throw new Error("OpenRouter returned a different model than the requested Gemini model.");
      if (typeof body.id !== "string" || body.id.trim().length === 0) throw new Error("OpenRouter returned no response identity.");
      if (!Number.isInteger(body.created) || body.created <= 0 || body.created * 1000 > Date.now() + 300_000) throw new Error("OpenRouter returned an invalid response timestamp.");
      const content = body.choices[0]?.message?.content;
      if (typeof content !== "string") throw new Error("OpenRouter structured output was not returned as JSON text.");
      const copy = validateGeneratedCopy(JSON.parse(content), timeline);
      const usage = body.usage;
      if (![usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("OpenRouter returned invalid token usage evidence.");
      return {
        copy,
        generation: {
          provider: "OpenRouter",
          model,
          requestedModel: model,
          responseModel: body.model,
          responseId: body.id,
          responseCreatedAt: new Date(body.created * 1000).toISOString(),
          input: inputEvidence,
          usage: {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          },
        },
      };
    } catch (error) {
      lastError = new Error(redactedMessage(error instanceof Error ? error.message : error, apiKey));
    }
  }
  throw lastError ?? new Error("Gemini tutorial copy validation failed.");
}

async function renderOverlay(context, path, { productName, cue, index, total }) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; background: transparent; }
      body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif; color: white; }
      .step { position: fixed; top: 26px; left: 28px; display: flex; align-items: center; gap: 12px; padding: 12px 17px; border-radius: 16px; background: rgba(10, 17, 31, .92); box-shadow: 0 12px 36px rgba(0,0,0,.24); }
      .number { color: #9ec5ff; font-size: 12px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
      .label { font-size: 18px; font-weight: 760; letter-spacing: -.01em; }
      .product { position: fixed; top: 32px; right: 30px; padding: 9px 13px; border-radius: 12px; background: rgba(10, 17, 31, .72); font-size: 13px; font-weight: 680; }
      .caption { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); width: min(920px, calc(100% - 96px)); box-sizing: border-box; padding: 17px 24px 18px; border-radius: 18px; background: rgba(10, 17, 31, .92); box-shadow: 0 18px 48px rgba(0,0,0,.3); font-size: 22px; font-weight: 650; line-height: 1.25; text-align: center; letter-spacing: -.01em; }
    </style></head><body>
      <div class="step"><span class="number">Step ${index + 1} of ${total}</span><span class="label">${escapeHtml(cue.label)}</span></div>
      <div class="product">${escapeHtml(productName)}</div>
      <div class="caption">${escapeHtml(cue.subtitle)}</div>
    </body></html>`);
    await page.screenshot({ path, type: "png", omitBackground: true });
  } finally {
    await page.close();
  }
}

async function burnOverlays(rawVideoPath, finalVideoPath, overlays, durationSeconds) {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", rawVideoPath];
  for (const overlay of overlays) args.push("-loop", "1", "-framerate", String(frameRate), "-i", overlay.path);
  const filters = [];
  let input = "[0:v]";
  for (const [index, overlay] of overlays.entries()) {
    const output = `[v${index}]`;
    const start = (overlay.startMs / 1000).toFixed(3);
    const end = (overlay.endMs / 1000).toFixed(3);
    filters.push(`${input}[${index + 1}:v]overlay=0:0:enable='between(t,${start},${end})':eof_action=pass${output}`);
    input = output;
  }
  const formatted = "[final]";
  filters.push(`${input}format=yuv420p${formatted}`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", formatted,
    "-t", durationSeconds.toFixed(3),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-color_range", "tv",
    "-movflags", "+faststart",
    "-an",
    finalVideoPath,
  );
  await execFileAsync("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
}

function srtTimestamp(milliseconds) {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function srtFromCues(cues) {
  return cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.subtitle}\n`).join("\n");
}

async function writeProductArtifacts({ productRoot, product, manifest, manifestSha256, proof, timeline, rawVideoPath, rawMetadata, generated, finalVideoPath, finalMetadata }) {
  const docs = join(productRoot, product.slug, "docs");
  await mkdir(docs, { recursive: true });
  const finalBytes = await readFile(finalVideoPath);
  const rawBytes = await readFile(rawVideoPath);
  const srt = srtFromCues(generated.copy.cues);
  const srtBytes = Buffer.from(srt, "utf8");
  const rawSha256 = sha256(rawBytes);
  if (generated.generation.input.rawVideoSha256 !== rawSha256) throw new Error(`${product.slug} generation evidence is bound to the wrong raw video.`);
  const artifact = {
    schema: "managed-oss-functional-tutorial.v1",
    product: { slug: product.slug, name: product.name, moduleId: product.moduleId, version: manifest.release.productVersion, manifestSha256 },
    backend: { release: manifest.release.backendRelease, commit: manifest.release.backendCommit },
    testedAt: new Date().toISOString(),
    browser: proof.browser,
    functionalProof: {
      action: proof.action,
      record: proof.record,
      detail: proof.detail,
      assertions: [
        "browser-authenticated-real-backend",
        "guided-form-submitted",
        "action-http-200",
        "durable-record-returned",
        "record-detail-http-200",
        "exact-record-reopened-in-ui",
      ],
    },
    timeline,
    explanation: { title: generated.copy.title, summary: generated.copy.summary, cues: generated.copy.cues, generation: generated.generation },
    video: {
      raw: { sha256: rawSha256, ...rawMetadata },
      final: { file: "docs/tutorial.mp4", sha256: sha256(finalBytes), ...finalMetadata },
      subtitles: { file: "docs/tutorial.srt", sha256: sha256(srtBytes), format: "SubRip" },
      overlaysBurnedIn: true,
      silent: true,
    },
  };
  await copyFile(finalVideoPath, join(docs, "tutorial.mp4"));
  await writeFile(join(docs, "tutorial.srt"), srtBytes);
  await writeFile(join(docs, "tutorial-proof.json"), safeJson(artifact));
  return artifact;
}

async function recordProduct({ browser, fleetSummary, productRoot, product, apiKey, model, keepTemp }) {
  const temporary = await mkdtemp(join(tmpdir(), `managed-oss-tutorial-${product.slug}-`));
  const frames = join(temporary, "frames");
  const rawVideo = join(temporary, "raw.mp4");
  const finalVideo = join(temporary, "tutorial.mp4");
  const manifestBytes = await readFile(join(productRoot, product.slug, "product-manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light", deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  let recorder;
  const observed = [];
  try {
    const proof = await runProductTutorialWorkflow(page, {
      product,
      webKey: fleetSummary.webKey,
      animatePointer: true,
      onStep: async (step) => {
        if (!recorder) recorder = await startFrameRecorder(page, frames);
        observed.push({ ...step, startFrame: recorder.frameCount() });
      },
      pause: async (step) => {
        const durations = { overview: 2200, connect: 1800, configure: 1800, execute: 1800, inspect: 1500, complete: 2600 };
        await page.waitForTimeout(durations[step.id] ?? 900);
      },
    });
    const recorded = await recorder.stop();
    const timeline = observed.map((step, index) => ({
      stepId: step.id,
      observedLabel: step.label,
      observedFact: step.fact,
      startMs: Math.round((step.startFrame / frameRate) * 1000),
      endMs: index + 1 < observed.length ? Math.round((observed[index + 1].startFrame / frameRate) * 1000) : recorded.durationMs,
    }));
    await encodeFrames(frames, rawVideo);
    const rawMetadata = await videoMetadata(rawVideo);
    if (rawMetadata.codec !== "h264" || rawMetadata.width !== width || rawMetadata.height !== height || rawMetadata.durationSeconds < 8 || rawMetadata.durationSeconds > 60) throw new Error(`${product.slug} raw video metadata is invalid: ${JSON.stringify(rawMetadata)}`);
    const generated = await generateTutorialCopy({ apiKey, model, rawVideoPath: rawVideo, product, proof, timeline });

    const overlays = [];
    for (const [index, cue] of generated.copy.cues.entries()) {
      const path = join(temporary, `overlay-${index}.png`);
      await renderOverlay(context, path, { productName: product.name, cue, index, total: generated.copy.cues.length });
      overlays.push({ path, startMs: cue.startMs, endMs: cue.endMs });
    }
    await burnOverlays(rawVideo, finalVideo, overlays, rawMetadata.durationSeconds);
    const finalMetadata = await videoMetadata(finalVideo);
    if (finalMetadata.codec !== "h264" || finalMetadata.width !== width || finalMetadata.height !== height || Math.abs(finalMetadata.durationSeconds - rawMetadata.durationSeconds) > 0.25) throw new Error(`${product.slug} final video metadata is invalid: ${JSON.stringify(finalMetadata)}`);
    proof.browser = { engine: "Chromium", version: browser.version(), viewport: { width, height } };
    const artifact = await writeProductArtifacts({ productRoot, product, manifest, manifestSha256: sha256(manifestBytes), proof, timeline, rawVideoPath: rawVideo, rawMetadata, generated, finalVideoPath: finalVideo, finalMetadata });
    process.stdout.write(safeJson({ ok: true, slug: product.slug, action: artifact.functionalProof.action.id, recordId: artifact.functionalProof.record.id, video: artifact.video.final, model }));
    return artifact;
  } finally {
    await context.close();
    if (!keepTemp) await rm(temporary, { recursive: true, force: true });
    else process.stderr.write(`${product.slug} temporary recording retained at ${temporary}\n`);
  }
}

async function main() {
  const productRoot = resolve(argument("--root") ?? defaultProductRoot);
  const requested = new Set((argument("--only") ?? "").split(",").map((slug) => slug.trim()).filter(Boolean));
  const model = argument("--model") ?? defaultModel;
  const keepTemp = hasFlag("--keep-temp");
  const apiKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  if (!apiKey || !apiKey.startsWith("sk-or-")) throw new Error("Set OPENROUTER_API_KEY to the supplied OpenRouter credential without writing it to the repository.");
  await Promise.all([execFileAsync("ffmpeg", ["-version"]), execFileAsync("ffprobe", ["-version"])]);
  const executablePath = await findChromiumExecutable();
  const fleet = await startFleet(productRoot);
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const products = requested.size ? fleet.summary.products.filter((product) => requested.has(product.slug)) : fleet.summary.products;
    if (!products.length || (requested.size && products.length !== requested.size)) throw new Error("One or more requested product slugs were not found in the 37-product fleet.");
    for (const product of products) await recordProduct({ browser, fleetSummary: fleet.summary, productRoot, product, apiKey, model, keepTemp });
  } finally {
    await browser.close();
    await stopFleet(fleet.child);
  }
}

main().catch((error) => {
  process.stderr.write(redactedMessage(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
