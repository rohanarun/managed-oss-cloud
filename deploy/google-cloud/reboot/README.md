# Existing-instance reboot durability

This directory closes the startup-metadata gap for the two already-created Google Compute Engine instances without importing or applying Terraform state. The updater can make exactly two changes:

- create `startup-script` on `managed-oss-host` only when that key is absent;
- replace the single existing `startup-script` on `managed-oss-host-worker-0`.

It uses `gcloud compute instances add-metadata`, which merges one metadata key. It never creates, deletes, recreates, resizes, stops, or starts an instance or disk. The apply path hashes every non-startup metadata item before and after each merge and fails if anything else changes.

## Release and runtime contract

`release-v0.4.0.json` pins:

- source commit `4ff94afc860109e683c56c3acffedb8a6c233e03`;
- image digest `sha256:865785081730ce0f459ae925d086b45523e9cd6bda94991a4f7f8aa81cbdb243`;
- the public domain and IP configuration;
- `PROVISIONING_MODE=dry-run`, `BILLING_MODE=disabled`, disabled subscription reconciliation, and hosted entitlement modes;
- SHA-256 digests for every release asset used during reboot;
- the control-only HMAC secret version, never a secret name or value shared with the worker. The reviewed Secret Manager name is supplied separately and rendered only into control-host startup metadata.

The updater also pins the complete manifest's reviewed SHA-256, so an alternate manifest cannot silently change a domain, IP, runtime value, or asset digest while retaining the same release label.

Before metadata can change, both running instances must already have the exact release staged at `/opt/managed-oss/releases/v0.4.0`, owned by root, and must pass the release helper's read-only runtime preflight. The preflight checks the project, zone, instance name, machine type, service account, deletion protection, persistent boot disk, ready marker, exact runtime configuration, running containers, and safe API health. This makes metadata persistence the final step after a successful v0.4.0 rollout, not a substitute for one.

The control startup script resolves the named HMAC secret through the instance service account at boot with shell tracing disabled. The worker startup script contains neither the secret name nor the HMAC environment variable. Existing secret values are never placed in Compute Engine metadata or command output.

## Worker v0.4.1 hotfix

`release-v0.4.1.json`, `reapply-worker-v0.4.1.sh`, and `startup-worker-v0.4.1.sh.in` are a worker-only reboot contract for the Docker missing-network response hotfix. They pin source commit `429ba369226c3193076959cf3ecb3a173e779a80` and image digest `sha256:963a1510094e104e6d0e3b557f04e82b606b4faa2018fc8e9487dbe0da4e18a8` while preserving the v0.4.0 worker identity, capacity, measurement-only storage mode, metadata firewall, and control-plane HMAC isolation.

The worker helper refuses any release directory other than `/opt/managed-oss/releases/v0.4.1`, verifies every root-owned release asset, requires the running agent to use the exact pinned image during preflight, verifies SLSA provenance before pulling at boot, reruns the bridge metadata-isolation proof, and finishes through the normal worker readiness gate. It does not alter the control-host startup contract.

## First dry run

Use a new absolute snapshot directory. The current reviewed topology is in `us-central1-a`: an `e2-medium` control host and an `e2-standard-2` private worker.

```bash
deploy/google-cloud/reboot/update-existing-startup-metadata.sh --dry-run \
  --project local-passage-501917-g0 \
  --zone us-central1-a \
  --control-instance managed-oss-host \
  --control-machine-type e2-medium \
  --control-service-account managed-oss-host@local-passage-501917-g0.iam.gserviceaccount.com \
  --worker-instance managed-oss-host-worker-0 \
  --worker-machine-type e2-standard-2 \
  --worker-service-account managed-oss-worker-0@local-passage-501917-g0.iam.gserviceaccount.com \
  --hmac-secret-name managed-oss-extended-external-evidence-hmac \
  --snapshot-dir /absolute/private/path/managed-oss-startup-before
```

The dry run performs read-only project, instance, IAP SSH, release-integrity, runtime, and health checks. It writes mode-`0600` raw before snapshots for recovery and emits only privacy-safe facts and SHA-256 values. It deliberately reports the control transition as `create-when-absent` and the worker transition as `replace-existing`. A present control startup script, absent worker startup script, duplicate key, changed fingerprint, wrong zone, wrong machine, wrong service account, non-running VM, auto-deleting boot disk, unsafe runtime mode, unhealthy service, or release mismatch fails closed before mutation.

Raw snapshots can contain pre-existing metadata values. Keep the snapshot directory private even though terminal output contains only hashes.

## Apply

After reviewing the dry-run facts, run the same command with `--apply` and a second new snapshot directory. The updater repeats every preflight and checks each metadata fingerprint again immediately before its merge. It then re-describes each instance, proves non-startup metadata is byte-for-byte equivalent after canonical JSON normalization, and proves the stored startup script has the planned SHA-256.

The script does not automatically roll back a partially completed pair. If a provider interruption occurs between the two metadata merges, preserve the snapshot directory and perform a separately reviewed recovery from the mode-`0600` before files. In particular, restoring the control host's original absent state would require a different metadata operation that this guarded updater intentionally refuses to perform.

Do not run `terraform apply`, import unmanaged resources, or reconstruct state as part of this procedure.

## Local contract tests

```bash
bash deploy/google-cloud/reboot/tests/verify-existing-startup-metadata.sh
bash deploy/google-cloud/reboot/tests/verify-worker-hotfix-v0.4.1.sh
```

The existing-instance test suite uses a fake `gcloud` executable. It proves the absent-control/existing-worker transitions, dry-run non-mutation, exact two-key apply behavior, preservation of `enable-oslogin`, private snapshots, HMAC isolation, and refusal on transition or machine drift. The v0.4.1 worker test independently verifies the pinned commit and image, every asset digest, startup-template hashes, HMAC absence, provenance-before-pull ordering, metadata isolation, and readiness. Neither test makes Google Cloud calls.
