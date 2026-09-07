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
- `status=not_found` — nothing matched in the resolved folder. On the 1st of a new
  month, before the file is created, this is a clean no-op. **After the first few
  days of a month it is not** — see "when `not_found` persists" below.
- `status=forbidden` — see the 403 symptom above.

The monthly file **rolls over automatically** (D5): the source's naming pattern
(`{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`) is expanded against the current Pacific
month each poll, so on 8/1 it switches to August's file with no config change.
**The FOLDER rolls over the same way and only if `folder_path` still contains its
tokens** (ADR-0102) — `…/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland`.

## When `not_found` persists

Two independent defects produce an identical `not_found`, **either one is enough
on its own**, and the page's old advice ("check for a rename, a typo, a stray
copy, a moved folder") sends you looking at the wrong end. Both have now happened
to this source — ADR-0102 (2026-08-12) and again ADR-0130 §4 (2026-09-07). Work
them in this order:

1. **Is the resolved FOLDER this month's?** Read `folder_path` on the source. If
   it contains a literal month name (`August 2026 Woodland`) instead of
   `{MONTH_TITLE}`, the expansion is a no-op and the sync is asking for this
   month's file inside last month's folder. It was correct for exactly one month
   and is silently wrong forever after. Re-tokenise the row.
2. **Is the file named what the pattern says?** Enumerate the resolved folder
   before assuming the file is missing — the `not_found` page now lists the folder
   contents for exactly this reason. Real names seen on this drive:
   `MARCH_2026 DAILY LOG TEMPLATE WOODLAND.xlsm`,
   `MAY 2026 DAILY LOG WOODLAND(1).xlsm`, `SEPT 2026 DAILY LOG WOODLAND.xlsm` —
   **3 of 7 months did not match the pattern.** The tolerant matcher (ADR-0130 D9)
   absorbs case, `_`, a `(n)` copy suffix and a month-name prefix; anything past
   that needs the file renamed at the source.
3. **Only then** is it a genuinely absent file, and only then does anyone need to
   be asked to create it.

The check is read-only and takes one call — list
`…/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland` through the same Graph
transport the sync uses. Six weeks were lost in 2026-07/08 to not making it
(ADR-0102 §1), and six days in 2026-09 to the same omission.

> **What `consecutive_failures` does and does not tell you.** It counts polls, not
> days — 337 of them is under six days at a 10-minute cadence during business
> hours. It says the condition is unbroken, never how long it has been true. Read
> `last_success_at` for that.

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
