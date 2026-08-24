# Control-plane image provenance gate

Every live control-plane or worker-agent rollout must use an image in exactly this form:

```text
ghcr.io/rohanarun/managed-oss-cloud@sha256:64_LOWERCASE_HEX_CHARACTERS
```

Tags, other registries, forks, and alternate repository paths are rejected. The verifier then:

1. downloads the exact remote manifest from GHCR;
2. requires HTTP 200 and an exact `Docker-Content-Digest` header;
3. hashes the returned manifest bytes and requires the same SHA-256 digest;
4. invokes `gh attestation verify --bundle-from-oci` so verification reads the registry-stored bundle instead of requiring GitHub API credentials;
5. requires signer workflow `rohanarun/managed-oss-cloud/.github/workflows/container.yml`, that workflow's signer digest and the source-repository digest to equal the operator-supplied 40-character commit, SLSA provenance v1, and a GitHub-hosted runner; and
6. writes a small immutable JSON proof without credentials or the full attestation bundle.

GitHub CLI 2.97.0 or newer is mandatory and must support `--bundle-from-oci`, `--signer-workflow`, `--signer-digest`, `--source-digest`, `--deny-self-hosted-runners`, and JSON output. The script rejects older clients instead of silently weakening policy. GitHub documents the [container attestation verification flow](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) and the complete [`gh attestation verify` policy flags](https://cli.github.com/manual/gh_attestation_verify). OCI requires a successful manifest response to include `Docker-Content-Digest`; the script additionally verifies the returned bytes as required by the [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md).

## Host prerequisites

- GitHub CLI 2.97.0 or newer;
- `curl`, `jq`, and `sha256sum`;
- the digest and exact source commit copied from the successful `Publish control-plane container` workflow; and
- a trusted checkout containing these scripts.

The public image and its registry-stored attestation bundle are verified without a GitHub API credential. The script supplies a fixed, deliberately invalid `GH_TOKEN` only to satisfy the CLI's local auth preflight; `--bundle-from-oci` prevents API attestation lookup. Never place GitHub or GHCR tokens in `runtime.env`, the proof record, command history, or Terraform state.

## Verify without deploying

```sh
sudo install -d -m 0750 /opt/managed-oss/provenance
sudo deploy/google-cloud/provenance/verify-control-plane-image.sh \
  --image ghcr.io/rohanarun/managed-oss-cloud@sha256:REVIEWED_DIGEST \
  --source-commit REVIEWED_40_HEX_COMMIT \
  --proof-file /opt/managed-oss/provenance/control-plane-REVIEWED_DIGEST.json
```

Success emits the same non-secret JSON written to the proof path. Failure creates no proof.

## Existing-host control-plane rollout

Update only the digest-pinned `CONTROL_PLANE_IMAGE` value in the root-owned `/opt/managed-oss/config/runtime.env`, then run:

```sh
sudo deploy/google-cloud/rollout-control-plane.sh \
  --source-commit REVIEWED_40_HEX_COMMIT
```

The rollout script installs and enables the persistent IPv4 and IPv6 `DOCKER-USER` metadata firewall, verifies the exact image currently in `runtime.env`, pulls that verified image directly, and proves host metadata remains reachable while a real bridge container cannot reach either metadata address. Only then can the first Compose pull or migration run. The resulting machine-readable firewall proof is mandatory input to control-plane readiness. Do not replace this command with raw `docker-compose pull` or `docker-compose up` commands.

## Contract tests

```sh
deploy/google-cloud/provenance/tests/verify-provenance-contracts.sh
```

The deterministic suite uses fake registry and GitHub clients. It covers tag rejection, registry header and body mismatches, obsolete GitHub CLI versions, unavailable GitHub policy flags, registry-bundle selection with a non-secret local-auth sentinel, failed or wrong-subject attestations, proof suppression on failure, metadata-firewall installation and failure, and both proof gates before Compose ordering. A real release still requires online provenance verification and the real bridge-container firewall proof on the target host.
