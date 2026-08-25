#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = join(repositoryRoot, "scripts", "generate-product-repositories.mjs");
const tutorialVerifierPath = join(repositoryRoot, "scripts", "verify-product-tutorials.mjs");
const artifactPaths = [
  "docs/product-workspace.png",
  "docs/tutorial.mp4",
  "docs/tutorial.srt",
  "docs/tutorial-proof.json",
];
const requiredPackagePaths = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "Dockerfile",
  "package.json",
  "product-manifest.json",
  ...artifactPaths,
];
const forbiddenReleasePath = /(^|\/)(?:node_modules|\.git|\.env(?:\.[^/]*)?|\.npmrc|npm-debug\.log|\.DS_Store)(?:\/|$)|\.(?:tgz|pem|key)$/i;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return `Usage:
  npm run products:release:verify -- --root /path/to/product-repos
  npm run products:release:verify -- --root /path/to/product-repos --phase published

Options:
  --root PATH          Required unless MANAGED_OSS_PRODUCT_OUTPUT is set.
  --phase stage        Verify generated files, artifacts, package commands, and remote ref safety.
  --phase published    Also require clean pushed tags, remote artifact hashes, and exact-head CI.
  --only a,b           Verify a development subset. Omit for the authoritative 37-product receipt.
  --concurrency N      Product worker count (default: 4, maximum: 8).
`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function redact(value) {
  return String(value ?? "")
    .replaceAll(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .replaceAll(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replaceAll(/(token|webkey)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2[redacted]")
    .slice(-4000);
}

function errorRecord(code, error) {
  return { code, message: redact(error instanceof Error ? error.message : error) };
}

async function command(command, args, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: options.maxBuffer ?? 24 * 1024 * 1024,
      timeout: options.timeout ?? 180_000,
    });
    return { ok: true, durationMs: Date.now() - startedAt, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: redact(error?.stderr || error?.stdout || error?.message || error),
    };
  }
}

async function inventory(root, { skipGit = false } = {}) {
  const files = new Map();
  const errors = [];
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (skipGit && path === root && entry.name === ".git") continue;
      const child = join(path, entry.name);
      const releasePath = normalizedPath(root, child);
      const stats = await lstat(child);
      if (stats.isSymbolicLink()) {
        errors.push({ code: "symlink", message: `${releasePath} is a symbolic link.` });
        continue;
      }
      if (stats.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!stats.isFile()) {
        errors.push({ code: "special-file", message: `${releasePath} is not a regular file.` });
        continue;
      }
      const bytes = await readFile(child);
      files.set(releasePath, {
        bytes,
        sha256: sha256(bytes),
        size: stats.size,
        executable: Boolean(stats.mode & 0o111),
      });
    }
  }
  await visit(root);
  return { files, errors };
}

function compareGeneratedReference(slug, reference, actual) {
  const errors = [...actual.errors];
  for (const [path, expected] of reference.files) {
    const observed = actual.files.get(path);
    if (!observed) {
      errors.push({ code: "generated-file-missing", message: `${slug}/${path} is missing.` });
      continue;
    }
    if (observed.sha256 !== expected.sha256) errors.push({ code: "generated-file-drift", message: `${slug}/${path} differs from the current generator.` });
    if (observed.executable !== expected.executable) errors.push({ code: "generated-mode-drift", message: `${slug}/${path} has the wrong executable mode.` });
  }
  for (const path of actual.files.keys()) {
    if (!reference.files.has(path) && !artifactPaths.includes(path)) errors.push({ code: "unexpected-file", message: `${slug}/${path} is not generator output or an approved media artifact.` });
    if (forbiddenReleasePath.test(path)) errors.push({ code: "forbidden-file", message: `${slug}/${path} is forbidden in a release tree.` });
  }
  for (const path of artifactPaths) {
    if (!actual.files.has(path)) errors.push({ code: "artifact-missing", message: `${slug}/${path} is missing.` });
  }
  return errors;
}

async function generateReference(only) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "managed-oss-release-reference-"));
  const args = ["--import", "tsx", generatorPath, "--output", temporaryRoot];
  if (only.length) args.push("--only", only.join(","));
  const generated = await command(process.execPath, args, { cwd: repositoryRoot, timeout: 180_000 });
  if (!generated.ok) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw new Error(`Reference generation failed: ${generated.error}`);
  }
  let summary;
  try {
    summary = JSON.parse(generated.stdout);
  } catch {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw new Error("Reference generation did not return its machine-readable summary.");
  }
  return { temporaryRoot, summary };
}

function parseGitHubRemote(remote) {
  const match = /github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote);
  return match ? { owner: match[1], repository: match[2] } : undefined;
}

function parseRemoteRefs(stdout) {
  const refs = new Map();
  let defaultBranch;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const symbolic = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/.exec(line);
    if (symbolic) {
      defaultBranch = symbolic[1];
      continue;
    }
    const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line);
    if (match) refs.set(match[2], match[1]);
  }
  return { defaultBranch, refs };
}

function statusEntries(stdout) {
  return stdout.split("\0").filter(Boolean).filter((entry) => /^[ MADRCU?!]{2} /.test(entry));
}

async function gitState(productRoot, slug, packageVersion, phase) {
  const errors = [];
  const baseCalls = await Promise.all([
    command("git", ["rev-parse", "--is-inside-work-tree"], { cwd: productRoot }),
    command("git", ["branch", "--show-current"], { cwd: productRoot }),
    command("git", ["rev-parse", "HEAD"], { cwd: productRoot }),
    command("git", ["remote", "get-url", "origin"], { cwd: productRoot }),
    command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: productRoot }),
    command("git", ["diff", "--check"], { cwd: productRoot }),
    command("git", ["diff", "--cached", "--check"], { cwd: productRoot }),
  ]);
  if (baseCalls.some((result) => !result.ok) || baseCalls[0].stdout.trim() !== "true") {
    errors.push({ code: "git-worktree", message: "The product is not a readable Git worktree with an origin remote." });
    return { errors };
  }
  if (!baseCalls[5].ok || !baseCalls[6].ok) errors.push({ code: "git-diff-check", message: redact(baseCalls[5].error || baseCalls[6].error) });
  const branch = baseCalls[1].stdout.trim();
  const head = baseCalls[2].stdout.trim();
  const remote = baseCalls[3].stdout.trim();
  const entries = statusEntries(baseCalls[4].stdout);
  const conflicts = entries.filter((entry) => /^(?:DD|AU|UD|UA|DU|AA|UU)/.test(entry));
  if (conflicts.length) errors.push({ code: "git-conflict", message: `Unmerged paths: ${conflicts.map((entry) => entry.slice(3)).join(", ")}` });
  const github = parseGitHubRemote(remote);
  if (!github) errors.push({ code: "remote-url", message: `Origin is not a recognized GitHub repository: ${remote}` });
  else if (github.repository !== slug) errors.push({ code: "remote-repository", message: `Origin repository ${github.repository} does not match product slug ${slug}.` });
  const tag = `v${packageVersion}`;
  const refsResult = await command("git", ["ls-remote", "--symref", "origin", "HEAD", "refs/heads/main", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: productRoot, timeout: 60_000 });
  if (!refsResult.ok) {
    errors.push({ code: "remote-unreachable", message: refsResult.error });
    return { branch, head, remote, github, dirty: entries.length > 0, status: entries, tag, errors };
  }
  const parsed = parseRemoteRefs(refsResult.stdout);
  const remoteMain = parsed.refs.get("refs/heads/main");
  const tagObject = parsed.refs.get(`refs/tags/${tag}`);
  const remoteTagCommit = parsed.refs.get(`refs/tags/${tag}^{}`) ?? tagObject;
  const localTagResult = await command("git", ["rev-parse", "--verify", `${tag}^{commit}`], { cwd: productRoot });
  const localTagCommit = localTagResult.ok ? localTagResult.stdout.trim() : undefined;
  if (parsed.defaultBranch !== "main" || !remoteMain) errors.push({ code: "remote-default", message: `Origin default branch is ${parsed.defaultBranch ?? "unknown"}, not main.` });
  if (localTagCommit && remoteTagCommit && localTagCommit !== remoteTagCommit) errors.push({ code: "tag-mismatch", message: `${tag} resolves differently locally and remotely.` });
  if (localTagCommit && localTagCommit !== head) errors.push({ code: "local-tag-collision", message: `${tag} already exists locally at ${localTagCommit}, not candidate HEAD ${head}.` });
  if (remoteTagCommit && !localTagCommit) errors.push({ code: "local-tag-missing", message: `${tag} exists remotely but is missing locally.` });
  if (phase === "stage" && remoteTagCommit && (entries.length > 0 || head !== remoteTagCommit)) {
    errors.push({ code: "version-tag-collision", message: `${tag} already exists at ${remoteTagCommit}; changed release content requires a new package version and tag.` });
  }
  if (phase === "published") {
    if (entries.length) errors.push({ code: "published-dirty", message: "Published verification requires a clean product worktree." });
    if (branch !== "main") errors.push({ code: "published-branch", message: `Published verification requires local main, not ${branch || "detached HEAD"}.` });
    if (head !== remoteMain) errors.push({ code: "published-head", message: `Local HEAD ${head} does not equal remote main ${remoteMain ?? "missing"}.` });
    if (remoteTagCommit !== head || localTagCommit !== head) errors.push({ code: "published-tag", message: `${tag} does not resolve to the published HEAD locally and remotely.` });
  }
  return {
    branch,
    head,
    remote,
    github,
    defaultBranch: parsed.defaultBranch,
    remoteMain,
    tag,
    localTagCommit,
    remoteTagCommit,
    dirty: entries.length > 0,
    status: entries,
    errors,
  };
}

function validatePackageResult(slug, metadata, packageResult) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(packageResult.stdout)?.[0];
  } catch {
    return { errors: [{ code: "pack-json", message: "npm pack --dry-run did not return JSON." }] };
  }
  if (!parsed || parsed.name !== metadata.name || parsed.version !== metadata.version) errors.push({ code: "pack-identity", message: `${slug} package identity differs from package.json.` });
  const paths = new Set((parsed?.files ?? []).map((file) => file.path));
  for (const path of requiredPackagePaths) if (!paths.has(path)) errors.push({ code: "pack-file-missing", message: `${slug} package omits ${path}.` });
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..") || forbiddenReleasePath.test(path)) errors.push({ code: "pack-forbidden-file", message: `${slug} package contains forbidden path ${path}.` });
  }
  return {
    errors,
    receipt: parsed ? {
      id: parsed.id,
      filename: parsed.filename,
      size: parsed.size,
      unpackedSize: parsed.unpackedSize,
      shasum: parsed.shasum,
      integrity: parsed.integrity,
      entryCount: parsed.entryCount,
    } : undefined,
  };
}

async function localCommands(productRoot, slug, metadata, npmCache) {
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|AUTH|API_KEY|WEB_KEY)/i.test(name)));
  const npmEnvironment = {
    ...inheritedEnvironment,
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_logs_dir: join(npmCache, "_logs"),
    npm_config_update_notifier: "false",
  };
  const definitions = [
    { id: "test", args: ["test"] },
    { id: "verify", args: ["run", "verify"] },
    { id: "screenshot", args: ["run", "verify:screenshot"] },
    { id: "tutorial", args: ["run", "verify:tutorial"] },
    { id: "pack", args: ["pack", "--dry-run", "--json"] },
  ];
  const results = [];
  const errors = [];
  let pack;
  for (const definition of definitions) {
    const result = await command("npm", definition.args, { cwd: productRoot, env: npmEnvironment, timeout: 240_000 });
    results.push({ id: definition.id, ok: result.ok, durationMs: result.durationMs });
    if (!result.ok) {
      errors.push({ code: `npm-${definition.id}`, message: `${slug}: ${result.error}` });
      continue;
    }
    if (definition.id === "pack") {
      const validated = validatePackageResult(slug, metadata, result);
      errors.push(...validated.errors);
      pack = validated.receipt;
    }
  }
  return { results, pack, errors };
}

async function verifyRemoteArtifacts(productRoot, git, localInventory) {
  const errors = [];
  const hashes = {};
  if (!git.github || !git.remoteMain) return { errors: [{ code: "remote-artifacts-prerequisite", message: "Remote artifact verification requires a GitHub origin and remote main commit." }] };
  for (const path of artifactPaths.slice(1)) {
    const local = localInventory.files.get(path);
    if (!local) {
      errors.push({ code: "remote-artifact-local-missing", message: `${path} is missing locally.` });
      continue;
    }
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(git.github.owner)}/${encodeURIComponent(git.github.repository)}/${git.remoteMain}/${path}`;
    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": "managed-oss-release-verifier" }, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      errors.push(errorRecord("remote-artifact-fetch", error));
      continue;
    }
    if (!response.ok) {
      errors.push({ code: "remote-artifact-http", message: `${path} returned HTTP ${response.status}.` });
      continue;
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > 12 * 1024 * 1024) {
      errors.push({ code: "remote-artifact-size", message: `${path} exceeds the 12 MiB verifier download ceiling.` });
      continue;
    }
    const remoteBytes = Buffer.from(await response.arrayBuffer());
    if (remoteBytes.length > 12 * 1024 * 1024) {
      errors.push({ code: "remote-artifact-size", message: `${path} exceeds the 12 MiB verifier download ceiling.` });
      continue;
    }
    const remoteHash = sha256(remoteBytes);
    hashes[path] = { local: local.sha256, remote: remoteHash };
    if (remoteHash !== local.sha256) errors.push({ code: "remote-artifact-hash", message: `${path} differs from the published file.` });
  }
  return { hashes, errors };
}

async function verifyRemoteCi(git) {
  if (!git.github || !git.remoteMain) return { errors: [{ code: "ci-prerequisite", message: "CI verification requires a GitHub origin and remote main commit." }] };
  const endpoint = `repos/${git.github.owner}/${git.github.repository}/actions/runs?head_sha=${git.remoteMain}&branch=main&status=completed&per_page=100`;
  const result = await command("gh", ["api", endpoint], { cwd: repositoryRoot, timeout: 60_000 });
  if (!result.ok) return { errors: [{ code: "ci-api", message: result.error }] };
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { errors: [{ code: "ci-json", message: "GitHub Actions API returned invalid JSON." }] };
  }
  const run = (body.workflow_runs ?? []).find((candidate) => candidate.head_sha === git.remoteMain && candidate.path === ".github/workflows/ci.yml" && candidate.status === "completed" && candidate.conclusion === "success");
  if (!run) return { errors: [{ code: "ci-missing", message: `No successful completed CI run exists for ${git.remoteMain}.` }] };
  return {
    run: {
      id: run.id,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      htmlUrl: run.html_url,
      updatedAt: run.updated_at,
    },
    errors: [],
  };
}

async function verifyProduct({ root, referenceRoot, product, phase, npmCache }) {
  const slug = product.slug;
  const productRoot = join(root, slug);
  const errors = [];
  let actual;
  let reference;
  try {
    [actual, reference] = await Promise.all([
      inventory(productRoot, { skipGit: true }),
      inventory(join(referenceRoot, slug)),
    ]);
    errors.push(...compareGeneratedReference(slug, reference, actual));
  } catch (error) {
    errors.push(errorRecord("inventory", error));
    return { slug, ok: false, errors };
  }
  let metadata;
  let manifest;
  try {
    metadata = JSON.parse(actual.files.get("package.json")?.bytes ?? "null");
    manifest = JSON.parse(actual.files.get("product-manifest.json")?.bytes ?? "null");
    if (metadata?.name !== `@managed-oss/${slug}` || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata?.version ?? "")) throw new Error("package name or version is invalid.");
    if (manifest?.product?.slug !== slug || manifest?.release?.productVersion !== metadata.version) throw new Error("manifest identity or version differs from package.json.");
  } catch (error) {
    errors.push(errorRecord("metadata", error));
    return { slug, ok: false, errors };
  }
  const git = await gitState(productRoot, slug, metadata.version, phase);
  errors.push(...git.errors);
  const checks = await localCommands(productRoot, slug, metadata, npmCache);
  errors.push(...checks.errors);
  let remoteArtifacts;
  let ci;
  if (phase === "published") {
    remoteArtifacts = await verifyRemoteArtifacts(productRoot, git, actual);
    ci = await verifyRemoteCi(git);
    errors.push(...remoteArtifacts.errors, ...ci.errors);
  }
  return {
    slug,
    ok: errors.length === 0,
    version: metadata.version,
    moduleId: manifest.module?.id,
    artifacts: Object.fromEntries(artifactPaths.map((path) => [path, actual.files.get(path) ? { sha256: actual.files.get(path).sha256, size: actual.files.get(path).size } : null])),
    git: {
      branch: git.branch,
      head: git.head,
      dirty: git.dirty,
      defaultBranch: git.defaultBranch,
      remoteMain: git.remoteMain,
      tag: git.tag,
      localTagCommit: git.localTagCommit,
      remoteTagCommit: git.remoteTagCommit,
    },
    commands: checks.results,
    pack: checks.pack,
    remoteArtifacts: remoteArtifacts?.hashes,
    ci: ci?.run,
    errors,
  };
}

async function mapConcurrent(items, concurrency, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}

async function main() {
  if (hasFlag("--help")) {
    process.stdout.write(usage());
    return;
  }
  const configuredRoot = argument("--root") ?? process.env.MANAGED_OSS_PRODUCT_OUTPUT;
  if (!configuredRoot) throw new Error("Pass --root or set MANAGED_OSS_PRODUCT_OUTPUT.\n\n" + usage());
  const root = resolve(configuredRoot);
  const phase = argument("--phase") ?? "stage";
  if (!new Set(["stage", "published"]).has(phase)) throw new Error("--phase must be stage or published.");
  const concurrency = Number(argument("--concurrency") ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--concurrency must be an integer from 1 through 8.");
  const only = [...new Set((argument("--only") ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
  const reference = await generateReference(only);
  const npmCache = await mkdtemp(join(tmpdir(), "managed-oss-release-npm-"));
  try {
    const products = reference.summary.products ?? [];
    if ((!only.length && products.length !== 37) || !products.length) throw new Error("The generated reference does not contain the required product fleet.");
    if (!only.length) {
      const rootEntries = await readdir(root, { withFileTypes: true });
      const entries = rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      const expected = products.map((product) => product.slug).sort();
      const missing = expected.filter((slug) => !entries.includes(slug));
      const extra = rootEntries.map((entry) => entry.name).filter((name) => !expected.includes(name));
      if (missing.length || extra.length) throw new Error(`Product root mismatch. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`);
    }
    const startedAt = new Date().toISOString();
    const results = await mapConcurrent(products, concurrency, (product) => verifyProduct({ root, referenceRoot: reference.temporaryRoot, product, phase, npmCache }));
    const tutorialArgs = [tutorialVerifierPath, "--root", root];
    if (only.length) tutorialArgs.push("--only", only.join(","));
    const tutorialFleet = await command(process.execPath, tutorialArgs, { cwd: repositoryRoot, timeout: 300_000 });
    const fleetErrors = tutorialFleet.ok ? [] : [{ code: "fleet-tutorial", message: tutorialFleet.error }];
    const ok = results.every((result) => result.ok) && fleetErrors.length === 0;
    const receipt = {
      schema: "managed-oss-product-release-verifier.v1",
      ok,
      phase,
      partial: only.length > 0,
      root,
      startedAt,
      completedAt: new Date().toISOString(),
      verified: results.length,
      expectedFleetSize: 37,
      source: {
        release: reference.summary.sourceRelease,
        commit: reference.summary.sourceCommit,
        snapshotSha256: reference.summary.sourceSnapshotSha256,
      },
      fleetTutorial: { ok: tutorialFleet.ok, durationMs: tutorialFleet.durationMs },
      products: results,
      errors: fleetErrors,
    };
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
    if (!ok) process.exitCode = 1;
  } finally {
    await Promise.all([
      rm(reference.temporaryRoot, { recursive: true, force: true }),
      rm(npmCache, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
