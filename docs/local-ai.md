# Optional local AI runtime

The first-party suite can process AI jobs without sending workspace records to a hosted model provider. The `local-ai` Compose profile runs Ollama and the suite AI worker on the private Compose network. It is disabled unless an operator explicitly selects the profile, and Ollama has no published host port or Caddy route.

The existing `ai` profile remains available for an operator-supplied OpenAI-compatible endpoint. Do not run `ai-worker` and `local-ai-worker` together: both consume the same PostgreSQL-backed job queue.

## Pinned runtime and model

- Runtime: official `ollama/ollama:0.32.5` OCI index pinned to `sha256:4dea9fb511947e24a84237bb636b0203abcb2ff0d3fbc7b4ff865deb91362131`. The digest and its linux/amd64 and linux/arm64 manifests were checked against the [official Docker Hub tag API](https://hub.docker.com/v2/repositories/ollama/ollama/tags/0.32.5) on 2026-08-24.
- Model: official [`qwen3:4b`](https://ollama.com/library/qwen3:4b), a 4.02B-parameter Q4_K_M model whose published weight size is about 2.5 GB and whose included license is Apache-2.0. The init job verifies manifest digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7` after pulling.
- API: Ollama's documented [OpenAI-compatible `/v1/chat/completions`](https://docs.ollama.com/api/openai-compatibility) endpoint, matching the existing provider-neutral AI worker.

The container image itself is roughly 3.3 GB compressed on amd64, in addition to the model. Budget at least 10 GB of free persistent disk for the current image, model, and update headroom. The model file is 2.5 GB, but inference also needs runtime, context/KV-cache, database, and control-plane memory. As an operational baseline, reserve at least 8 GB RAM for a CPU-only local-model host and prefer 12-16 GB when it shares a VM with PostgreSQL and the control plane. A busy `e2-standard-2` can be memory-constrained; use a larger or dedicated model host for production concurrency. CPU-only inference can be slow.

`LOCAL_AI_CONTEXT_LENGTH=8192`, `LOCAL_AI_MAX_LOADED_MODELS=1`, and `LOCAL_AI_NUM_PARALLEL=1` deliberately bound the default memory envelope. Increase them only after measuring peak resident memory. This profile does not configure GPU passthrough.

## Configure

The defaults are recorded in `.env.example`:

```text
LOCAL_AI_MODEL=qwen3:4b
LOCAL_AI_MODEL_DIGEST=359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7
LOCAL_AI_CONTEXT_LENGTH=8192
LOCAL_AI_KEEP_ALIVE=5m
LOCAL_AI_MAX_LOADED_MODELS=1
LOCAL_AI_NUM_PARALLEL=1
```

The local worker overrides its runtime to:

```text
AI_MODE=openai-compatible
AI_BASE_URL=http://ollama:11434/v1
AI_MODEL=${LOCAL_AI_MODEL}
AI_API_KEY=
```

`AI_BASE_URL` must end in `/v1`, identify a reachable host rather than `0.0.0.0`, and must not contain embedded credentials, query parameters, or a fragment. Hosted endpoints such as `https://provider.example/v1` remain supported through `runtime.env` and the `ai` profile.

## Start without exposing Ollama

No model or image is downloaded until this explicit command is run:

```sh
docker compose -f deploy/google-cloud/docker-compose.yml --profile local-ai up -d
```

Startup ordering is health-gated:

1. Ollama starts and must pass `ollama list` against its loopback API.
2. `ollama-model-init` pulls the configured model into `/opt/managed-oss/apps/ollama`, verifies it can be shown, checks its manifest digest, and exits successfully.
3. `local-ai-worker` starts only after PostgreSQL is healthy and model initialization completed.

The pull is idempotent; subsequent runs reuse the persistent model directory. The first initialization requires outbound access to the Ollama registry. Once the image and model are present, inference stays on the Compose network and does not require a hosted inference API.

Check status without publishing port 11434:

```sh
docker compose -f deploy/google-cloud/docker-compose.yml --profile local-ai ps
docker compose -f deploy/google-cloud/docker-compose.yml --profile local-ai logs ollama-model-init local-ai-worker
docker compose -f deploy/google-cloud/docker-compose.yml --profile local-ai exec ollama ollama list
```

Stop local inference while retaining weights:

```sh
docker compose -f deploy/google-cloud/docker-compose.yml --profile local-ai stop local-ai-worker ollama
```

Do not add `ports: ["11434:11434"]` or a Caddy route. Ollama has no authentication on this private endpoint; network isolation is the access control.

## Hosted OpenAI-compatible alternative

To use an approved hosted or separately managed endpoint instead, leave the `local-ai` profile off, set `AI_MODE`, `AI_BASE_URL`, `AI_MODEL`, and optionally `AI_API_KEY` in `runtime.env`, then start only the existing worker profile:

```sh
docker compose -f deploy/google-cloud/docker-compose.yml --profile ai up -d ai-worker
```

The same JSON-result validation and advisory-only side-effect boundary applies to both modes.
