# DR3-Vision — Database Backups

**Status:** Live since 2026-06-22. Nightly, encrypted, off-site to Cloudflare R2.

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
