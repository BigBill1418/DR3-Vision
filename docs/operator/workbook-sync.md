# Operator runbook — Woodland workbook sync (ADR-0049)

The workbook sync mirrors each site's monthly Woodland daily-log workbook from
Kelsey's OneDrive into Vision's `processed_units_daily` table every 10 minutes
during business hours (6 AM – 8 PM PT, Mon–Fri). Pre-cutover the **workbook wins**:
a disagreeing Vision-captured day is overwritten and the overwrite is recorded in
the append-only audit log. This makes the daily production report (ADR-0030)
accurate during the pre-cutover window (through 8/1).

Built **mock-first** (ADR-0046 discipline): a real Graph Files transport and a
fixture transport satisfy one interface, so everything is testable without the
tenant. Until the Files creds land the transport self-reports `mock` in every
`workbook_sync_runs` ledger row and reads a fixture workbook.

## Dependency — `Files.Read.All`

Sync reads OneDrive with the **`Files.Read.All`** application permission on the
existing dr3-vision Graph app (`2da92424-7397-435d-96a1-d2a382293a53`). The grant
landed 2026-07-09 (`docs/handoffs/2026-07-09-it-permissions-execution-complete-script-fixes-202.md`).

**403 symptom:** if the grant is ever removed/unconsented, a poll fails SOFT —
status `forbidden` in the ledger, a `dr3-vision-system` ntfy page
("Workbook sync forbidden (Files.Read.All)"), and NO crash. Re-consent the app in
Entra admin center to restore.

## Credentials

The Files transport reuses the mail app registration. The three
`MSGRAPH_FILES_*` vars **fall back** to `MSGRAPH_MAIL_*` when unset, so in practice
only `~/.dr3-vision-secrets/msgraph-mail.env` needs to exist (read by the `app`
service). To use a distinct secret, drop `~/.dr3-vision-secrets/msgraph-files.env`
(chmod 600). With neither present the app runs the MOCK transport.

## Enable sync (deliberate, two steps)

1. Confirm the grant is live and the app can read Kelsey's drive.
2. In **/admin/workbook-sync**, the Woodland source is seeded but **disabled**
   (`is_syncing=false`). Click **Enable sync** on it.
3. Start the poll daemon: `docker compose --profile workbook-sync up -d`
   (the container is NOT auto-started — it is profile-gated, mirroring the
   "born disabled" posture). Until a source is enabled the engine no-ops.

Add Eugene later (D9) with **Add a source** on the same page when Rick confirms.

## Check status

**/admin/workbook-sync** shows:

- **Sources** — drive UPN, folder, naming pattern, syncing on/off, last-polled
  time (PT), last file name.
- **Recent runs** — the `workbook_sync_runs` ledger: status, transport mode
  (mock/graph), whether a change was detected, rows upserted / overwritten /
  skipped-mid-edit, and any error text.

Ledger semantics:

- `changes_detected=false` — the file's cTag was unchanged; no re-download (normal).
- `rows_skipped_midedit > 0` — days with a required cell (stripped-program) still
  empty; skipped this poll, retried next, **no alert** (D11, eventual consistency).
- `rows_overwritten > 0` — a Vision-captured day was overwritten by the workbook;
  each carries an audit row (`table_name=processed_units_daily`, `vision_overwrite=true`).
- `status=not_found` — the current month's file does not exist yet (e.g. the 1st of
  a new month before Janette creates it). A clean no-op.
- `status=forbidden` — see the 403 symptom above.

The monthly file **rolls over automatically** (D5): the source's naming pattern
(`{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`) is expanded against the current Pacific
month each poll, so on 8/1 it switches to August's file with no config change.

## Cutover (stop sync + archive)

On/after 8/1, once Rick has signed off on parity, cut over from
**/admin/workbook-sync → Cutover**:

1. (Optional but expected) Record **Rick's parity signoff** for the site. Without
   it the cutover is soft-gated — you may still proceed with the **Override missing
   parity signoff** checkbox and a note.
2. Enter a **criteria note** (mandatory, audited) and click **Cut over → live**.

The flip:

- flips the site's `workbook_sync` rollout surface to **live** — the engine then
  **no-ops** (Vision owns its own data going forward);
- fires **R2 archival** (D8): every monthly `.xlsm` in the source folder is copied
  to `workbooks/{site}/{yearMonth}.xlsm` (immutable, forever retention). Archival is
  fail-soft — an R2/transport error is recorded but never fails the flip.

Rollback is the inverse flip in **/admin/rollout** (set the `workbook_sync` surface
back to `pilot`) — sync resumes on the next poll.

## Parser finalization (still gated)

The per-day column mapping lives in `src/lib/workbook-sync/daily-adapter.ts` and
currently reads the **Addendum-B fixture** `Daily` sheet layout. When Kelsey's real
`JUNE 2026 DAILY LOG WOODLAND.xlsm` is in hand, that ONE file is where the column
mapping is finalized — the transport, engine, ledger, cutover, and tests around it
stay put. The shared ADR-0048 `parseWorkbook` runs alongside for staging/provenance.
