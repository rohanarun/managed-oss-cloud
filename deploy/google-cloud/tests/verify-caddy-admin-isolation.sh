#!/bin/sh
set -eu

fail() {
  printf 'caddy admin isolation test failed: %s\n' "$*" >&2
  exit 1
}

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$script_dir/../../.." && pwd)"
docker_bin="${DOCKER_BIN:-docker}"
caddy_image="caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
node_image="node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
test_suffix="$$"
network="managed-oss-caddy-isolation-$test_suffix"
control_caddy="managed-oss-control-caddy-$test_suffix"
control_upstream="managed-oss-control-upstream-$test_suffix"
worker_caddy="managed-oss-worker-caddy-$test_suffix"
temporary_dir="$(mktemp -d)"

cleanup() {
  "$docker_bin" rm -f "$worker_caddy" "$control_caddy" "$control_upstream" >/dev/null 2>&1 || true
  "$docker_bin" network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

command -v "$docker_bin" >/dev/null 2>&1 || fail "$docker_bin is required"
"$docker_bin" info >/dev/null 2>&1 || fail "the Docker daemon is unavailable"

cat > "$temporary_dir/probe.mjs" <<'EOF'
import { readFile } from "node:fs/promises";
import http from "node:http";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function loadAdmin(caddyfilePath) {
  const caddyfile = await readFile(caddyfilePath, "utf8");
  let lastFailure = "admin endpoint did not respond";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const loaded = await fetch("http://127.0.0.1:2019/load", {
        method: "POST",
        headers: { "content-type": "text/caddyfile" },
        body: caddyfile,
        signal: AbortSignal.timeout(2_000),
      });
      if (!loaded.ok) {
        lastFailure = `load returned ${loaded.status}: ${(await loaded.text()).slice(0, 300)}`;
      } else {
        const current = await fetch("http://127.0.0.1:2019/config/", { signal: AbortSignal.timeout(2_000) });
        const payload = await current.json();
        if (current.ok && payload?.admin?.listen === "127.0.0.1:2019") return;
        lastFailure = `loaded config reported unexpected admin listener ${payload?.admin?.listen}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(lastFailure);
}

async function requireAdminDenied(endpoint) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
    throw new Error(`bridge peer reached Caddy admin with status ${response.status}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("bridge peer reached")) throw error;
  }
}

function requestRoute(hostname, port, hostHeader) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path: "/", headers: { host: hostHeader }, timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function requireRoute(hostname, port, hostHeader, expectedBody) {
  let lastFailure = "route did not respond";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await requestRoute(hostname, Number(port), hostHeader);
      if (response.status === 200 && response.body === expectedBody) return;
      lastFailure = `route returned ${response.status}: ${response.body.slice(0, 300)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(lastFailure);
}

const [mode, ...arguments_] = process.argv.slice(2);
if (mode === "load-admin") await loadAdmin(arguments_[0]);
else if (mode === "admin-denied") await requireAdminDenied(arguments_[0]);
else if (mode === "route") await requireRoute(arguments_[0], arguments_[1], arguments_[2], arguments_[3]);
else throw new Error(`unknown probe mode ${mode}`);
EOF

cat > "$temporary_dir/apps.caddy" <<'EOF'
http://tenant.internal:8080 {
  respond "tenant-route-ok" 200
}
EOF

"$docker_bin" pull "$caddy_image" >/dev/null
"$docker_bin" pull "$node_image" >/dev/null
"$docker_bin" network create "$network" >/dev/null

"$docker_bin" run -d --name "$control_upstream" --network "$network" --network-alias control-plane \
  "$node_image" node --input-type=module -e \
  'import http from "node:http"; http.createServer((_request, response) => { response.end("control-route-ok"); }).listen(8787, "0.0.0.0");' >/dev/null

"$docker_bin" run -d --name "$control_caddy" --network "$network" --network-alias control-edge \
  -e CONTROL_PLANE_DOMAIN=control.localhost -e PLATFORM_IPV4=127.0.0.2 \
  -v "$repo_root/deploy/google-cloud/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$caddy_image" run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

"$docker_bin" run --rm --network "container:$control_caddy" \
  -v "$temporary_dir/probe.mjs:/test/probe.mjs:ro" \
  -v "$repo_root/deploy/google-cloud/Caddyfile:/fixture/Caddyfile:ro" \
  "$node_image" node /test/probe.mjs load-admin /fixture/Caddyfile
"$docker_bin" run --rm --network "container:$control_caddy" -v "$temporary_dir/probe.mjs:/test/probe.mjs:ro" \
  "$node_image" node /test/probe.mjs route control-plane 8787 control-plane control-route-ok
"$docker_bin" run --rm --network "$network" -v "$temporary_dir/probe.mjs:/test/probe.mjs:ro" \
  "$node_image" node /test/probe.mjs admin-denied http://control-edge:2019/config/
"$docker_bin" run --rm --network "$network" -v "$temporary_dir/probe.mjs:/test/probe.mjs:ro" \
  "$node_image" node /test/probe.mjs route control-edge 80 127.0.0.2 control-route-ok

"$docker_bin" rm -f "$control_caddy" >/dev/null

"$docker_bin" run -d --name "$worker_caddy" --network "$network" --network-alias worker-edge \
  -v "$repo_root/deploy/google-cloud/worker/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$temporary_dir/apps.caddy:/etc/caddy/apps.caddy:ro" \
  "$caddy_image" run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

"$docker_bin" exec "$worker_caddy" caddy reload --config /etc/caddy/Caddyfile --address 127.0.0.1:2019
"$docker_bin" run --rm --network "$network" -v "$temporary_dir/probe.mjs:/test/probe.mjs:ro" \
  "$node_image" node /test/probe.mjs admin-denied http://worker-edge:2019/config/
"$docker_bin" run --rm --network "$network" -v "$temporary_dir/probe.mjs:/test/probe.mjs:ro" \
  "$node_image" node /test/probe.mjs route worker-edge 8080 tenant.internal tenant-route-ok

printf 'caddy admin isolation integration checks passed\n'
