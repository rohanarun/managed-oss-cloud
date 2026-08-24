# Control-plane PostgreSQL backup and restore verification

This directory contains a host-level backup lane for the PostgreSQL database used by the Managed OSS control plane. It does not back up tenant application volumes on private workers; those remain a separate worker responsibility.

The backup job:

1. confirms the configured Compose database is ready;
2. checks conservative local free-space headroom;
3. runs PostgreSQL 17 `pg_dump` in custom format with zstd compression, without owner or privilege statements;
4. checks the `PGDMP` signature and makes `pg_restore` parse the archive;
5. computes SHA-256;
6. records the source database byte count in object metadata and the success record;
7. uploads an immutable, uniquely named dump to GCS using the VM service account;
8. uploads the `.sha256` sidecar last as the completion marker; and
9. removes the mode-`0600` local temporary material on success or failure.

A dump without its matching sidecar is incomplete and must not be restored. Uploads use the XML API's [`x-goog-if-generation-match: 0` precondition](https://docs.cloud.google.com/storage/docs/request-preconditions) so this job cannot overwrite an existing object. The runtime identity should have no delete permission.

## Security boundary

- The script runs `pg_dump` inside the existing database container and never reads or prints the PostgreSQL password.
- Compose receives the existing root-only `runtime.env` by file path. The backup environment file must not contain application or provider secrets.
- The backup configuration, Compose file, Compose directory, and runtime environment are rejected unless root-controlled; secret-bearing environment files must be regular, non-symlink, `root:root` files with no group or world access. The installer repairs ownership and mode on an existing regular backup configuration but refuses symlinks.
- GCS access uses a short-lived token from the Compute Engine metadata service. The token is held in a mode-`0600` temporary curl configuration rather than a process argument, and is removed on exit.
- `set -x` is forcibly disabled. Neither command accepts a password, cloud token, Stripe key, session secret, or encryption key as an argument.
- GCS encrypts stored customer content by default. A bucket can instead use a default customer-managed Cloud KMS key without changing the scripts. Review [Google Cloud default encryption](https://docs.cloud.google.com/docs/security/encryption/default-encryption) and [default CMEK configuration](https://docs.cloud.google.com/storage/docs/encryption/using-customer-managed-keys).
- Use a dedicated backup bucket with uniform bucket-level access and public-access prevention. Do not serve this bucket through a public URL or CDN.
- Treat every restore archive as executable input. PostgreSQL warns that restoring a dump can execute code chosen by a source superuser; verify only objects produced by the trusted backup lane, and use a disposable verification host when source or bucket integrity is uncertain. See the official [`pg_dump` warning](https://www.postgresql.org/docs/17/app-pgdump.html).

## Bucket and IAM prerequisites

Create or select a dedicated private bucket in the required recovery region. Grant the control-plane VM service account only:

- `roles/storage.objectCreator` so the scheduled job can create objects but cannot view, delete, or overwrite them; and
- `roles/storage.objectViewer` so an explicitly invoked verification drill can fetch a selected dump and sidecar.

Do not grant `roles/storage.objectAdmin` to the runtime identity. On a shared backup bucket, use an IAM condition or managed folder to restrict both roles to the configured prefix. A dedicated control-plane bucket is simpler and avoids granting the viewer access to worker backups. Google documents the exact permissions in [Cloud Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles) and recommends minimum required roles in [bucket IAM guidance](https://docs.cloud.google.com/storage/docs/access-control/using-iam-permissions).

The checked-in Terraform grants the runtime service account both roles with a condition limited to the `control-plane/` object prefix. Review that condition in the plan before enabling the timer. Existing manually managed deployments must add equivalent bindings themselves; do not run a fresh-state Terraform apply against an already-created environment. No long-lived storage credential is written to Terraform state or the host.

## Install and schedule

From a trusted checkout on the control-plane host:

```sh
cd deploy/google-cloud/backup
sudo ./install.sh
sudoedit /opt/managed-oss/config/control-plane-backup.env
```

The default installer preserves an existing configuration and explicitly disables the timer. A configured bucket alone never schedules work.

Prove the first backup manually before relying on the timer:

```sh
sudo systemctl start managed-oss-control-plane-backup.service
sudo systemctl status managed-oss-control-plane-backup.service --no-pager
sudo journalctl -u managed-oss-control-plane-backup.service --since today --no-pager
```

The success record contains only the GCS URI, SHA-256, archive byte count, original database byte count, and UTC completion time. Treat a missing success record, nonzero service result, missing sidecar, or missed timer as an alert.

## Restore verification drill

Select a completed `.dump` object that also has a `.dump.sha256` sidecar, then run:

```sh
sudo /usr/local/sbin/managed-oss-control-plane-restore-verify \
  --gcs-object gs://YOUR_PRIVATE_BUCKET/control-plane/TIMESTAMP_ID/opendock.dump
```

For a securely transferred local archive:

```sh
sudo /usr/local/sbin/managed-oss-control-plane-restore-verify \
  --file /secure/path/opendock.dump \
  --sha-file /secure/path/opendock.dump.sha256 \
  --source-database-bytes 123456789
```

For GCS objects, the verifier requires the immutable `x-goog-meta-database-bytes` value written by the backup job and sizes PostgreSQL headroom from that source database, not from the current production database. For a local archive, `--source-database-bytes` is mandatory and must come from the trusted backup success record or preserved object metadata; never substitute a guess or the current database size. Missing, zero, malformed, or arithmetic-unsafe values fail closed before restore.

The verifier checks the sidecar and archive, requires twice the recorded source database size plus 512 MiB of free PostgreSQL-volume headroom, creates a uniquely named `restore_verify_*` database in the existing PostgreSQL container, restores with `--exit-on-error`, verifies user schemas/tables and index validity, and force-drops the temporary database before printing a secret-free JSON result. Its exit trap makes a second cleanup attempt after any earlier failure. It never drops, cleans, renames, or restores over `opendock`.

The temporary database needs substantial free disk and adds load to the production PostgreSQL process. Prefer an off-peak window. For stronger disaster-recovery evidence, run the same verifier on a disposable host configured with an empty PostgreSQL 17 Compose stack and an isolated copy of the production Compose environment shape. An actual recovery must restore into a new empty cluster, validate application health and migration compatibility, then switch traffic through a separately reviewed runbook. This verifier intentionally has no destructive production-restore mode.

After the first manual backup and restore-verification result have both been recorded and reviewed, enable the timer with the explicit acknowledgement:

```sh
sudo ./install.sh --enable --first-restore-proof-completed
systemctl list-timers managed-oss-control-plane-backup.timer --no-pager
```

The flag is an operator assertion, not proof by itself. Do not supply it until the verifier has returned a successful result for a completed backup. The timer then runs once daily at 03:17 UTC with up to 20 minutes of randomized delay, catches up after a host outage, and serializes backup and verification work with a local lock. Terraform-managed hosts must also set both `control_plane_backup_timer_enabled=true` and `control_plane_restore_proof_completed=true` in a reviewed plan; leaving either false keeps the timer off after startup.

## Retention and recovery guidance

- Keep at least 35 daily completed backups until measured recovery objectives justify another window. The example [GCS lifecycle policy](gcs-lifecycle.example.json) deletes only the `control-plane/` prefix after 35 days.
- Test the lifecycle rule against a non-production prefix before applying it. Cloud Storage lifecycle changes can take time to propagate and actions are asynchronous; see [Object Lifecycle Management](https://docs.cloud.google.com/storage/docs/lifecycle).
- Keep Cloud Storage soft delete enabled for an independently chosen recovery window. Soft delete protects deleted objects but adds storage cost; review [the current soft-delete behavior](https://docs.cloud.google.com/storage/docs/soft-delete).
- Consider a bucket retention policy for the minimum immutable period and a separate-region copy for regional disaster recovery. Locking a bucket retention policy is irreversible, so lock it only after a successful backup, restore-verification, lifecycle, and legal-retention review; see [Bucket Lock](https://docs.cloud.google.com/storage/docs/bucket-lock).
- The VM service account has no delete authority. Lifecycle/retention is owned by a separate storage administrator, limiting the effect of a compromised control plane.
- Run and record a restore verification at least monthly and after a PostgreSQL major-version, Compose, schema, storage-policy, or IAM change.
- A SHA-256 match proves object integrity, not authenticity or recoverability. Only a trusted source plus a completed isolated restore and application-level checks prove that a backup is useful.

To apply the example lifecycle file after review:

```sh
gcloud storage buckets update gs://YOUR_PRIVATE_BUCKET \
  --lifecycle-file=deploy/google-cloud/backup/gcs-lifecycle.example.json
```

The example is intentionally simple. If the configured prefix is not `control-plane/`, update `matchesPrefix` before applying it. Retention, soft delete, replication, storage class, and restore cadence have cost implications and must be selected from the service's measured recovery-point and recovery-time objectives.

## Files

- `control-plane-backup.sh`: noninteractive dump, archive validation, checksum, and GCS upload.
- `control-plane-restore-verify.sh`: checksum verification and isolated temporary-database restore.
- `control-plane-backup.env.example`: non-secret runtime coordinates and limits.
- `systemd/managed-oss-control-plane-backup.service`: hardened one-shot service.
- `systemd/managed-oss-control-plane-backup.timer`: persistent daily schedule.
- `gcs-lifecycle.example.json`: reviewed-prefix retention example.
- `install.sh`: idempotent host installer; it does not configure IAM or run the first backup.

## Checked-in verification

Run the non-destructive contract checks from the repository root:

```sh
deploy/google-cloud/backup/tests/verify-backup-contracts.sh
```

These checks cover shell parsing, fail-closed local-size arguments, GCS metadata enforcement, recorded-byte headroom, success JSON, and root-ownership guards. They do not replace a real dump/upload/restore drill on the target Linux host.
