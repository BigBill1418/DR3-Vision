# Restore drills (P1-3 readiness item — DR proof, not list-tests)

| Date | Snapshot | Performed by | Result |
|---|---|---|---|
| 2026-07-06 | `70cdb6dd` (2026-07-06 10:47 UTC) | Claude (operator-directed; Bill delegated) | **PASS** — clean `pg_restore` into a throwaway postgres:16, zero errors; verified vs prod: latest migration `20260712_ap_approvals`, `bonus_daily_entries=5382`, paid payroll `316275¢` exact, `survey_invites=10`, `state_program_rules=12` |

## Drill procedure gotchas (learned 2026-07-06 — READ before a real DR)

1. **`restic-dr3.env` uses `R2_*` names** — map before running the doc'd restore:
   `AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY`,
   `RESTIC_REPOSITORY="s3:${R2_ENDPOINT%/}/${R2_BUCKET}/dr3-vision"` (mirrors
   `scripts/dr3-pg-backup.sh`).
2. **Postgres-container init race**: a fresh `postgres:16` container starts a
   TEMPORARY init server first — `pg_isready` passes, then it shuts down before
   the real server starts. A `pg_restore` fired in that window fails
   ("database system is shutting down") or, worse, appears to succeed against
   nothing. Wait for the SECOND "ready to accept connections" log line + a
   stable `SELECT 1` before restoring.
3. Restore with `--no-owner --no-privileges` into a scratch role; the dump's
   `dr3` ownership is prod-specific.

Drill cadence: repeat quarterly or after any backup-pipeline change.
