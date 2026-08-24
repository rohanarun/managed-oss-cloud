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

## Control-plane v0.4.2 schema release

The v0.4.2 control-plane release is intentionally separate from the worker hotfix:

- `release-v0.4.2.json` pins source commit `20c4a704c77cbbbff1da995e1d91b937625a8aa4` and image digest `sha256:2a32801db1aa72a358527370549d66fb300b57e55e93743917b1b9f0b9ad55d3`;
- the reviewed manifest SHA-256 is `2d34489579f275b15fa86e17ac13eac74ca54a874095e0aa50e479a609403e9b`, the reapply-helper SHA-256 is `6e83f6a41dc49452e71800601a0e39dfb6f2a8990b47bf7b95c9c9e8be42e101`, and the startup-template SHA-256 is `02a6bfed1d9d5f0dc730c68b69a797ce8390e248e4a430aeeae4eaa3dde019af`;
- its runtime contract keeps provisioning in `dry-run`, the provisioning worker disabled, both entitlement modes hosted, storage accounting measurement-only, subscription reconciliation disabled, Compose profiles empty, Stripe secrets empty, and billing disabled;
- `reapply-control-plane-v0.4.2.sh` accepts only `/opt/managed-oss/releases/v0.4.2`, verifies every pinned release asset, preserves only the existing Stripe publishable key, reloads the control-only HMAC secret, and invokes the provenance-gated rollout;
- `startup-control-plane-v0.4.2.sh.in` pins the complete manifest and reapply-helper hashes in the rendered startup metadata; and
- `update-existing-control-startup-v0.4.2.sh` replaces exactly the existing `startup-script` key on `managed-oss-host`. It has no worker argument or worker mutation path.

Do not reuse `update-existing-startup-metadata.sh` for this upgrade. That tool is the original v0.4.0 two-instance transition: it requires an absent control startup key and writes worker startup metadata. The live worker must remain on its independent v0.4.1 reboot contract.

The initial v0.4.2 rollout must complete before the startup-metadata updater can pass its remote preflight. Use this order:

1. Confirm the successful tag workflow used the exact source commit and digest above, and confirm the control host has GitHub CLI 2.97.0 or newer.
2. Stage the reviewed tooling checkout as the root-owned, non-symlink directory `/opt/managed-oss/releases/v0.4.2`. Verify the manifest, reapply helper, and startup template against the exact hashes above, then verify every manifest `assetSha256` entry before changing runtime state.
3. Snapshot the control and worker instance descriptions privately. Verify the worker is still `managed-oss-host-worker-0`, has no public IP, and its startup metadata and running agent remain pinned to v0.4.1. No subsequent v0.4.2 command targets that instance.
4. On the control host, change only `CONTROL_PLANE_IMAGE` in the root-owned `/opt/managed-oss/config/runtime.env` to the exact v0.4.2 digest. Before rollout, prove `PROVISIONING_MODE=dry-run`, `PROVISIONING_WORKER=disabled`, `SUBSCRIPTION_RECONCILIATION_MODE=disabled`, `COMPOSE_PROFILES=` and `BILLING_MODE=disabled`, with empty Stripe secret and webhook values.
5. Run the staged v0.4.2 control helper on the control host. It rechecks every safe mode, refuses a running subscription reconciler, reloads the control-only HMAC secret, and invokes the provenance-gated rollout with the pinned source commit:

   ```bash
   sudo /opt/managed-oss/releases/v0.4.2/deploy/google-cloud/reboot/reapply-control-plane-v0.4.2.sh \
     --project local-passage-501917-g0 \
     --instance managed-oss-host \
     --machine-type e2-medium \
     --hmac-secret-name managed-oss-extended-external-evidence-hmac \
     --release-dir /opt/managed-oss/releases/v0.4.2
   ```

6. Verify the exact control image, PostgreSQL-backed health with `mode: "dry-run"`, `/api/config` with `billingReady: false`, no running subscription reconciler, and a fresh host-ready marker.
7. From the trusted local checkout, run the control-only metadata dry run with a new private snapshot directory:

   ```bash
   deploy/google-cloud/reboot/update-existing-control-startup-v0.4.2.sh --dry-run \
     --project local-passage-501917-g0 \
     --zone us-central1-a \
     --control-instance managed-oss-host \
     --control-machine-type e2-medium \
     --control-service-account managed-oss-host@local-passage-501917-g0.iam.gserviceaccount.com \
     --hmac-secret-name managed-oss-extended-external-evidence-hmac \
     --snapshot-dir /absolute/private/path/managed-oss-control-v0.4.2-dry-run
   ```

8. Review the emitted hashes and `mutationScope: "control-startup-script-only"`. Repeat the same command with `--apply` and a second new snapshot directory. The apply path performs one `gcloud compute instances add-metadata` call for `managed-oss-host`, then proves every non-startup metadata item is unchanged.
9. Re-describe both instances. Prove the control startup script is the planned v0.4.2 hash and the worker description, v0.4.1 startup script, image, private networking, and heartbeat are unchanged. A reboot test is a separate maintenance-window action; reboot only the control host after explicit approval, then repeat the health and safe-mode checks.

The updater fails closed if the control host does not already have exactly one startup script, if it is neither the reviewed v0.4.0 predecessor nor the exact rendered v0.4.2 script, if runtime state is not already healthy on v0.4.2, or if the metadata fingerprint changes between snapshot and apply.

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
bash deploy/google-cloud/reboot/tests/verify-control-plane-v0.4.2.sh
```

The existing-instance test suite uses a fake `gcloud` executable. It proves the absent-control/existing-worker transitions, dry-run non-mutation, exact two-key apply behavior, preservation of `enable-oslogin`, private snapshots, HMAC isolation, and refusal on transition or machine drift. The v0.4.1 worker test independently verifies the pinned commit and image, every asset digest, startup-template hashes, HMAC absence, provenance-before-pull ordering, metadata isolation, and readiness. The v0.4.2 control test proves the exact release contract, safe modes, dry-run non-mutation, a single control-only metadata merge, preservation of all other control metadata, manifest-drift refusal, and rejection of absent or unexpected predecessor scripts. None of these tests makes Google Cloud calls.
