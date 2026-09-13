# DR3-Vision — Database Backups

**Status:** Live since 2026-06-22. Nightly, encrypted, off-site to Cloudflare R2.
**Second provider since 2026-09-11/12** — see "Off-provider copy" at the bottom.

## What runs

- **systemd user units** on svdp-dev: `dr3-vision-pg-backup.timer` → `dr3-vision-pg-backup.service`
- **Schedule:** 03:45 America/Los_Angeles nightly (`Persistent=true`, 5-min randomized delay). Staggered off Guardian (03:00), VLM (03:15), helix-hub (03:30) to avoid a fleet backup stampede.
- **Script:** `scripts/dr3-pg-backup.sh` (in this repo)
- **Mechanism:** `docker exec dr3-vision-postgres pg_dump -Fc dr3_vision` piped straight into `restic backup --stdin` (no plaintext dump ever lands on disk) → Cloudflare R2.
- **Encryption:** restic AES-256. The dump contains bonus/payroll/PII, so it rides the encrypted backup.
- **Retention:** 7 daily / 4 weekly / 12 monthly / 5 yearly (`restic forget --prune`).
- **Repository:** `s3:<R2_ENDPOINT>/dr3-vision-backups/dr3-vision`

## Secrets

- `~/.dr3-vision-secrets/restic-dr3.env` (mode 600) on svdp-dev: R2 S3 creds (mapped from `r2-backups.env`) + `RESTIC_PASSWORD`.
- **`RESTIC_PASSWORD` is the at-rest encryption / recovery key.** It is stored in **1Password (Fleet vault)** — "DR3-Vision Backup Restic Password". Without it the backups cannot be decrypted. The copy in `restic-dr3.env` is on the same host being backed up, so the 1Password copy is the one that matters for disaster recovery.

## Restore (disaster recovery)

```bash
# env: R2 creds + RESTIC_PASSWORD (from 1Password)
export AWS_ACCESS_KEY_ID=<r2 key>  AWS_SECRET_ACCESS_KEY=<r2 secret>
export RESTIC_REPOSITORY="s3:<R2_ENDPOINT>/dr3-vision-backups/dr3-vision"
export RESTIC_PASSWORD=<from 1Password>
IMG=restic/restic:0.17.3
run(){ docker run --rm -i -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY $IMG "$@"; }

run snapshots                                   # list available snapshots
run dump latest dr3_vision.dump > restore.dump  # fetch newest custom-format dump
# restore into a (fresh) DB:
cat restore.dump | docker exec -i dr3-vision-postgres pg_restore -U dr3 -d dr3_vision --clean --if-exists
```

## Operational checks

- `systemctl --user list-timers dr3-vision-pg-backup.timer` — next/last run
- `journalctl --user -u dr3-vision-pg-backup -n 50` — last run log
- `run snapshots` — confirm a fresh snapshot exists each morning
- Failures publish ntfy `dr3-vision-backup` (per ADR-0036).

---

## Off-provider copy: Backblaze B2 (noc-master ADR-0232) — not run by this repo

Everything above lands in **one Cloudflare account**, and R2 has **no object versioning**: a
delete there is terminal and a corrupted overwrite replaces the only copy. Since 2026-09-11/12
the fleet has a **second storage provider** underneath it, which DR3-Vision neither runs nor
configures. Doctrine: `noc-master/docs/adr/0232-second-provider-immutable-nightly-backup.md`.
Operations: `noc-master/docs/runbooks/fleet-b2-backup.md`.

| Lane                                    | What it covers for DR3-Vision                                                                                                                                                                                                                                                                                                         | How it comes back                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleetbackup-chad` (svdp-dev, 05:30 PT) | The host's **whole root filesystem** — so the live `dr3-vision-postgres` **data volume** itself (under `/var/lib/docker/volumes`, verified not excluded), `~/.dr3-vision-secrets/`, the compose files and `/etc`. This is a crash-consistent copy of the database that does **not** depend on `dr3-vision-pg-backup.timer` having run | `restic restore latest --target /var/tmp/… --include <path>` with the lane env on svdp-dev, or from **any** machine using the 1Password values. Fleet runbook §2a |
| `fleetbackup-r2-mirror` (BOS, 07:00 PT) | `rclone copy` — **never `sync`** — of **every** R2 bucket, list read live from the R2 API each run. So both `dr3-vision-backups` (this repo's restic repo) **and `dr3-vision-photos`** are copied                                                                                                                                     | `rclone copy b2:barnardhq-fleet-nightly/fleetbackup-r2-mirror/<bucket>/<key> …`. Fleet runbook §2c                                                                |

**The `dr3-vision-photos` line is the one worth reading twice.** Hard rule 7 in `CLAUDE.md` —
photos go to R2 and are never stored in the DB or on host disk — meant R2 held the **only** copy
of every load photo, receipt and signature image in the system. It no longer does.

Destination: one Backblaze B2 bucket `barnardhq-fleet-nightly` — Object Lock **compliance mode,
90 days**, keep-all-versions, **zero lifecycle rules, no `forget`, no `prune`, ever**. Credentials:
1Password **Fleet** vault, `Fleet B2 nightly — lane chad (key + restic password)` and
`… lane r2-mirror …` — separate from "DR3-Vision Backup Restic Password" above, and a restore
needs nothing that lived on svdp-dev. Health: **one** digest a day at 11:00 PT on ntfy
`infrawatch-alerts` (not `dr3-vision-backup` — that topic still carries this repo's own lane
failures and is unchanged); weekly `restic check`; quarterly restore drills on the 16th of
Jan/Apr/Jul/Oct.

Limits, so nobody over-reads it:

- **It is additive, and slower.** The R2 lane above stays primary: it is scoped, it has a proven
  `pg_restore` path, and it runs at 03:45 PT. Reach for B2 when R2 cannot give it back.
- **Not point-in-time.** Nightly snapshots. The `restic forget --prune` retention above is
  unchanged for R2; **B2 keeps everything forever** and therefore also keeps snapshots R2 has
  already aged out.
- **File-level, not bare-metal** — `/boot` and container image layers are excluded.
- **PII consequence.** These snapshots contain bonus/payroll/PII and every photo, and **nothing in
  that bucket is purgeable for 90 days.** A deletion request that must reach every copy is a
  retention question for the operator, not a `restic forget` — which the bucket refuses anyway.
