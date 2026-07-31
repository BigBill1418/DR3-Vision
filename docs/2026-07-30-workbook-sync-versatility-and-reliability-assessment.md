# Workbook-sync: versatility, reliability, and the cutover criterion

**Date:** 2026-07-30 (all times Pacific)
**Scope:** ADR-0049 workbook-sync bridge at `main` / `9800880`, post-Amendment-1.
**Question asked:** _"make sure this is as versatile and reliable as can be — make sure we
are fully dialed in to use this data to sync until cutover."_
**Posture of this document:** assessment only. No `src/` or `prisma/` change was made.
`is_syncing` was not touched. Production was read, never written.

**Evidence labels used throughout:** `[M]` measured (a command I ran, with when),
`[D]` documented (file:line or schema, quoted from a real read), `[I]` inferred (with
what would falsify it).

---

## 0. Premise correction — read this first

The brief that commissioned this work stated: _"Nothing has ever been validated against a
real workbook — no daily-log workbook has been shared, and every test fixture is
synthetic."_

**The second half is true. The first half is not.** `[M]` 2026-07-30, live Postgres on
svdp-dev:

```
workbook_imports:
  original_filename   = JUNE 2026 DAILY LOG WOODLAND.xlsm
  template_generation = woodland_daily
  sheet_count         = 47
  row_count           = 432
  status              = parsed        (parse_error empty)
  storage_key         = workbook-imports/ba3beeeb-…/JUNE_2026_DAILY_LOG_WOODLAND.xlsm
  created_at          = 2026-07-21 05:36 UTC  (2026-07-20 22:36 PT)
```

Kelsey's real June workbook has been through this exact parser. `workbook_import_rows`
holds 432 staged rows from it, including **23 `daily_close` rows on a tab literally named
`June26 Processed`** `[M]`, e.g.:

```
{"date":"2026-06-01","strippedProgram":944,"strippedNonProgram":0,"materialTicketNumber":"M-175506"}
```

Fixtures are still synthetic — no `.xlsm`/`.xlsx` daily log exists in the repo (negative
control: `find . -path ./node_modules -prune -o \( -iname '*.xlsm' -o -iname '*.xlsx' \)
-print` returns only `prisma/seed/historical/source-archive/Bonus_Spread_Sheet_2026.xlsx`)
`[M]`. But the parser itself has a real-file track record, and it is a good one — see §3.3.

---

## 1. What will break

Ordered by how badly it fails and how quietly.

### 1.1 The month is decided by ONE cell, and nothing cross-checks it against the file name

`[D]` `src/lib/audit/workbook/section-extractors.ts:762-774`:

```ts
/** Derive a 'YYYY-MM' month prefix from the first dated inbound row seen. */
function deriveMonthPrefix(res: ExtractionResult): string | null {
  for (const row of res.stagingRows) {
    if (row.section !== 'inbound' || row.rawValue === null) continue;
    try {
      const d = JSON.parse(row.rawValue) as { date?: string };
      if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) return d.date.slice(0, 7);
```

It **returns on the first hit**. No majority vote, no consistency check across the other
inbound rows, no bound on how far that date may be from the file's own month. Every
`daily_close` date is then built as `${monthPrefix}-${day}` `[D]` line 418.

The file name is `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm` — it _states the month
explicitly_ — and the engine holds it: `[D]` `engine.ts:189`
`fileName = resolveMonthlyFileName(source.naming_pattern, started)`. That value is used
only to fetch and to stamp the ledger. It is never handed to the parser and never compared
to `monthPrefix`.

**Negative control for that absence:** grep across all of `src/` for every export of
`naming.ts` plus the identifier `monthPrefix`. `resolveMonthlyFileName` has exactly one
non-test call site (`engine.ts:189`); `yearMonthKeyFromFileName` / `fileNameMatchesPattern`
appear only in `archive.ts:53,57`; `monthPrefix` appears only inside
`section-extractors.ts`. A cross-check, if one existed, would have to touch one of those
symbols. `[M]`

**The failure this permits.** August's workbook is, in normal practice, a copy of July's
with the data cleared. If any DAY-sheet inbound row survives that clear-down carrying a
July date — or if Kelsey mistypes `7/3` for `8/3` in the earliest inbound row of the month
— then `monthPrefix = "2026-07"`, and **every August "Day N" row is written into July**.
Under workbook-wins that overwrites a month that is already closed and billed. The run
records `status: ok`, `rows_upserted: 12`, and pages nobody. The audit rows exist, but the
ledger gives no hint that anything moved, because it does not record which dates a run
touched (§2.5).

Blast radius from one cell, on a billed figure, silently. This is the single worst thing in
the system.

### 1.2 The Processed sheet's columns are hard-coded ordinals with no header validation

`[D]` `section-extractors.ts:402-406`:

```ts
// Daily rows: col2 = "Day N"; stripped program (col4) / non-program (col5);
// material ticket (col10). Columns are stable across June & July.
const STRIPPED_PROGRAM = 4;
const STRIPPED_NONPROG = 5;
const MATERIAL = 10;
```

"Stable across June & July" is induction from n = 2. There is no header assertion anywhere
in `extractProcessed` — the only `findCol` in that function is for the opening-balance
`/^program$/i` label in rows 3–7 `[D]` lines 388-390.

Contrast the DAY sheets, which the same file resolves **by header text** `[D]`
`section-extractors.ts:196-209`:

```ts
function findDayInboundHeader(ws) {
  …
    const date = findCol(h, /^date$/i);
    const site = findCol(h, /^site$/i);
    const units = findCol(h, /inbound\s*unit\s*#/i);
    const commodity = findCol(h, /^commodity$/i);
    if (date && site && units && commodity) return { row: r, date, site, commodity, units };
```

So the inbound grid is drift-tolerant and the **billed production figure is not.**

**The failure this permits.** Kelsey inserts one column on the Processed sheet left of J.
Column 4 now holds what used to be column C (the daily total, `F+G`) and column 5 holds
what used to be D (program stripped). Both are finite and `>= 0`, so `quantity()` accepts
both `[D]` `daily-adapter.ts:148-151`. Rows are written with wrong figures. `status: ok`.

This is the structural limit of the Amendment-1 refusal architecture: **six refusal paths
all defend against _unreadable_; none defends against _readable but shifted_.** A refusal
system that only fires when parsing fails cannot catch the failure mode where parsing
succeeds against the wrong cells.

### 1.3 The blank-vs-zero fix may refuse the real file outright — UNDETERMINED, and it is the cheapest thing to settle

Amendment 1's D12b stopped `extractProcessed` coercing `snp ?? 0`. Correct fix. But the
consequence is that a **blank** column E now skips the day entirely
(`stripped_non_program_unusable` `[D]` `daily-adapter.ts:325-333`), and if every day is
skipped, `rows.length === 0` → `all_days_unusable` → the whole workbook is refused `[D]`
`daily-adapter.ts:376-393`.

June's Processed sheet has **zero** non-program stripping. Is column E holding literal
zeros, or is it blank?

**The staged production data cannot answer this.** All 23 rows carry
`"strippedNonProgram":0` `[M]` — but they were written 2026-07-21, by the code at
`9800880~1`, which emitted the key unconditionally `[D]`:

```ts
const payload: Record<string, unknown> = {
  date,
  strippedProgram: sp ?? 0,
  strippedNonProgram: snp ?? 0,
};
```

The inventory ledger is no help either — it sums E with `?? 0` `[D]`
`section-extractors.ts:530`, and its staged month total is `"nonProgramStripped":0` `[M]`,
which is what both a column of zeros and a column of blanks produce.

**If E is blank on every June day, today's code refuses Kelsey's workbook in full and pages
every 30 minutes.** The fix for a silent zero would have become a total outage on the very
file it was written for.

**Decisive pre-flight (non-destructive, ~5 minutes):** re-parse the already-archived bytes
at R2 key `workbook-imports/ba3beeeb-442d-46ed-ad30-b1a7975906f9/JUNE_2026_DAILY_LOG_WOODLAND.xlsm`
with `9800880` code and assert `deriveDailyRows()` still yields 23 rows with
`failure === null`. Do this before anything else in this document.

### 1.4 A renamed file goes silent forever, and no one is told

`[D]` `engine.ts:192-197` — a missing file sets `status = 'not_found'` and logs at `info`.
The ntfy calls live **only** in the `catch` block `[D]` `engine.ts:280-293`, which
`not_found` never reaches. There is no page, no digest, no escalation.

`getFile` is a case-insensitive exact match over the folder listing `[D]`
`graph-transport.ts:130-134`, so a case change survives. Everything else does not: a rename,
a `… (1).xlsm` copy, a typo, a stray leading space, or Kelsey working in a differently-named
file for a week all resolve to `not_found`.

**And nothing watches.** Negative control: grep `src/`, `scripts/`, `prisma/` for both the
Prisma model `workbookSyncRun` and the SQL name `workbook_sync_runs`, excluding tests. The
only non-test reader is `[D]` `src/app/admin/workbook-sync/page.tsx:35`:

```ts
prisma.workbookSyncRun.findMany({ orderBy: { started_at: 'desc' }, take: 25 }),
```

— a page an admin has to choose to open `[M]`. And `workbook_sources` has no
`last_success_at` and no failure counter; its columns are `last_polled_at`, `last_file_id`,
`last_file_name`, `last_file_ctag` `[M]` (live `\d workbook_sources`). So **"we polled
recently" is recorded and "we last got data on \_\_\_" is not.** A source that has produced
nothing for three weeks looks identical, from the source row, to a healthy one.

### 1.5 Month-boundary blindness — corrections made after the last business day are lost forever

`[D]` `engine.ts:189` resolves **only** the current Pacific month:
`resolveMonthlyFileName(source.naming_pattern, started)` with `started = nowFn()`. There is
no code path that ever re-reads a prior month's file. `[D]` `naming.ts:42-50` handles
1 January correctly (the year token comes from the same `pacificYearMonth` call, so
`JANUARY 2027 …` resolves without a config change) — the rollover mechanics are fine. The
problem is what happens to the month being left behind.

Combine with `[D]` `business-hours.ts:46-49` (Mon–Fri only, 06:00–20:00 PT): the **last poll
of month M happens on M's last business day.** Anything Kelsey enters into M's file after
that — the entire month-close correction pass, which is the normal shape of this work — is
invisible to Vision permanently. Vision's figures for month M freeze at whatever they were
on M's last business afternoon.

On the 1st of a new month the new file usually does not exist yet → `not_found` → no-op,
which is correct and documented `[D]` D5. But it is also indistinguishable from §1.4.

### 1.6 A refusal loops forever at full cost, with no backoff and no escalation

Deliberately, on refusal the watermark is not advanced `[D]` `engine.ts:244-251`. That is
the right call — but the consequence is unbounded. Next poll: ctag still differs from the
stored one, so re-download the multi-MB `.xlsm`, re-parse 47 sheets, re-fail. Every 10
minutes. Forever.

Paging is capped at one per 30 minutes per site `[D]` `engine.ts:376-387`
(`cooldownMs: 30 * 60 * 1000`), which over a 14-hour business window is ~28 identical pages
per day, indefinitely, with no change in text. And that cooldown ledger is **in-process
memory** `[D]` `src/lib/ntfy.ts:146` (`const cooldownLedger = new Map<string, number>()`),
so any app restart resets it — the DR3 containers had been up 7 minutes when I looked `[M]`.

Against ADR-0037's gate this fails Q3 (has the system tried to self-heal) and Q1 (actionable
in 5 minutes — a template problem needs Kelsey, not an operator). It is the same shape as
the 2026-06-10 marketing-autogen re-page flood: a correct detection wired to a wrong
cadence.

### 1.7 The "unknown rollout state" fail-safe records a state that is not true

`[D]` `engine.ts:169-181`:

```ts
      } else {
        cutoverLive = true; // fail SAFE: unknown cutover state ⇒ do not upsert
```

The **direction** is right and I would not change it (see §3.1). The **recording** is wrong:
the run is written with `status: 'ok'` and `cutover_noop: true` `[D]` `engine.ts:182-187,
298-315`, and no page fires. So a persistent rollout-read failure on a _pilot_ site produces
an unbroken run of clean `ok / cutover_noop` rows asserting the site is cut over when it is
not — and the sync stops feeding Vision while the ledger says everything is fine.

`WorkbookSyncStatus` has no value for this: `[M]` `enum WorkbookSyncStatus { ok, forbidden,
not_found, error }` (schema.prisma:4754-4759). There is no `skipped`.

That is precisely the failure signature the engine's own comments say this codebase keeps
producing — _"a state meaning 'I am not really connected' recorded as a state meaning
'fine'"_ `[D]` `engine.ts:225-226` — reintroduced one layer above the guard that was written
to stop it.

---

## 2. Versatility, item by item

### 2.1 Month and year rollover

The brief's description is **correct as stated** `[D]`: day rows are dated `Day N` +
`monthPrefix`, `monthPrefix` comes from the first dated inbound row
(`section-extractors.ts:763`), and no dated inbound ⇒ `monthPrefix === null` ⇒
`extractProcessed` never runs ⇒ the `processed_daily_close` count key is never bumped
(`bump(res.counts, 'processed_daily_close', n)` at line 449 sits inside the function that
does not run) ⇒ the adapter's discriminator
`PROCESSED_SECTION_COUNT_KEY in parsed.sectionCounts` is false `[D]` `daily-adapter.ts:279`
⇒ refusal `daily_section_unresolved` `[D]` lines 284-296. Verified end to end.

- **1 January:** file-name resolution is correct (`naming.ts:34-50`). The refusal-on-empty
  behaviour is correct. What is wrong is §1.5 — December's close-out edits are abandoned.
- **Mid-month, new file with few rows:** if the file has inbound rows, it works. If Kelsey
  records processing before recording any inbound load — plausible on a 1st or 2nd — then
  `monthPrefix === null` and the run **fails and pages**, when the honest answer is "not
  enough data yet". `[I]` inferred from the code path above; falsified if Kelsey's practice
  guarantees an inbound row precedes the first processed row every month.
- **The copy-forward hazard is the real rollover risk**, not the arithmetic: §1.1.

### 2.2 The naming pattern

| Change Kelsey makes                          | Result                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Case change (`June` → `JUNE`)                | **Survives** — `getFile` lowercases both sides `[D]` `graph-transport.ts:132-133`                                |
| Rename / typo / `… (1).xlsm` copy            | `not_found`, **silent forever** (§1.4)                                                                           |
| Works in a differently-named file for a week | `not_found` for that week, then resumes; the week's data arrives only if it lands back in the pattern-named file |
| >200 files in the folder                     | Survives — `$top=200` with `@odata.nextLink` paging and a 100-page guard `[D]` `graph-transport.ts:112-127`      |
| Folder moved/renamed                         | `listFolder` 404 → `[]` → `not_found`, silent `[D]` line 117                                                     |

The pattern itself is flexible (`{MONTH}` / `{MONTH_TITLE}` / `{YEAR}`, and `patternRegex`
handles repeated tokens without a `SyntaxError` `[D]` `naming.ts:67-89`). The fragility is
not the pattern; it is that a miss is unalarmed.

### 2.3 Template drift

| Drift                                          | Outcome                                                                                                                                                           | Verdict            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Insert a **row**                               | Harmless — rows are found by scanning col 2 for `/^day\s*(\d{1,2})$/i` `[D]` line 410                                                                             | Survivable         |
| Add a **column** on a DAY sheet                | Harmless — header-resolved `[D]` line 196-209                                                                                                                     | Survivable         |
| Add a **column** on the Processed sheet        | **Silently wrong figures** (§1.2)                                                                                                                                 | **Worst case**     |
| Rename the Processed **tab**                   | Usually refuses loud (`daily_section_unresolved`); recovery needs a **code deploy** (§2.4)                                                                        | Loud but expensive |
| Add a **new site tab**                         | Classified `unknown` → `[unmapped]` flag, staged as evidence only `[D]` `section-extractors.ts:913-919`                                                           | Survivable         |
| A new tab whose row 2 contains "PROCESSED"     | Both sheets feed `extractProcessed` `[D]` line 852; colliding days with different figures → `conflicting_duplicate_days` refusal `[D]` `daily-adapter.ts:355-368` | Loud, correct      |
| Change the `Day N` label format (`Day-7`, `7`) | Row not matched → fewer/zero days → `daily_section_unresolved` or a **partial month written as if complete**                                                      | Partly silent      |

The last row deserves a note: `extractProcessed` scanning for `Day N` means a _partial_
match — say the label style changes halfway down the sheet — yields some days and refuses
nothing, because `rows.length > 0`. There is no expectation of how many days a month should
have.

### 2.4 `ROW2_LABEL_CONFIRMATIONS` marks `processed` unconfirmed — how fragile, really?

Resolution order is `[D]` `section-resolver.ts:256-283`: (1) `isDaySheet`, (2) header
signature, (3) row-2 label, (4) prefix-stripped name, (5) `unknown`.

For the Processed tab, step (2) **cannot** fire: `HEADER_SIGNATURES` `[D]` lines 156-171
contains entries for `inb_trans_charges`, `fuel`, `commodities`, `renovation`, `events`,
`container_rentals`, `variables` — and **no `processed` entry** (negative control: I read the
entire table; the array is 7 entries and closed with `] as const`). So the tab resolves on
the row-2 label — marked `confirmed: false` `[D]` line 124 — or on the name fallback, and
nothing else.

**Empirically it works on the real file.** `[M]` the staged import's `daily_close` rows carry
`tab_name = 'June26 Processed'` with correct payloads, so at least one of those two rules
fired on Kelsey's actual June workbook. Which one is undetermined (I have no read of that
sheet's row 2).

**But the name fallback is narrower than it looks.** `[D]` `section-resolver.ts:182-183`:

```ts
const MONTH_PREFIX = /^(january|…|dec)\s?\d{2,4}\s*/i;
```

It requires a 2–4 digit year immediately after the month word, separated by at most one
space. And `BASE_NAME_TYPES` requires the remainder to equal `processed` **exactly** `[D]`
lines 189-206. So these all miss: `June Processed` (no year), `Jun-26 Processed` (hyphen,
not `\s?`), `Processed Units`, `PROCESSING`, `Woodland Processed`, `Processed (2026)`.

`BASE_NAME_TYPES` is a compile-time `const Map` — **there is no operator-editable sheet-name
alias table** (contrast `source_aliases`, which is a real DB table with 54 rows `[M]` and
which the _site_-name path does use). So recovering from a tab rename requires editing
`src/` and deploying — and a `src/` push rebuilds the DR3 image, which is the change class
that strands the dock iPads mid-shift.

Verdict: **fails loud, not silent — which is right — but the recovery path is a production
deploy under time pressure, which is wrong.** The fragility is not in detection; it is in
remediation.

### 2.5 Multi-site / Eugene

Nothing in the engine assumes one source: `runWorkbookSyncPoll` loops `findMany({ where: {
is_syncing: true } })` sequentially `[D]` `engine.ts:113-121`, ntfy fingerprints are
per-site (`workbook-sync-error-${siteId}` `[D]` line 371, 385), archival is per-site
`[D]` `archive.ts:43`. `workbook_sources.site_id` is UNIQUE `[M]`
(`workbook_sources_site_id_key`), so the model is exactly one workbook per site.

To add Eugene you would need:

1. a `workbook_sources` row (drive UPN, folder, naming pattern — note the current pattern
   ends `WOODLAND.xlsm`, so Eugene's must differ);
2. a `rollout_surfaces` row for `kind='workbook_sync'`, site=Eugene. Its **absence is
   handled**: `UnregisteredSurfaceError` is treated as pilot and keeps syncing `[D]`
   `engine.ts:170-173`. Today exactly one such surface exists, Woodland, state `pilot` `[M]`;
3. `source_aliases` coverage for Eugene's inbound source names, or the wrong-site
   cross-check simply never fires (it needs affirmative evidence `[D]`
   `daily-adapter.ts:213-234`);
4. evidence Eugene's workbook has the same Processed shape. `templateGeneration` becomes
   `woodland_daily` for **any** workbook containing one of the six Woodland sections `[D]`
   `parser.ts:187-200` — the name is misleading; it is not site-specific and will not reject
   an Eugene file.

**The real Eugene blocker is not code.** Eugene has 0 rows in `processed_units_daily` and
the MyMRC mirror covers only Woodland `[M]`. There would be **no independent second source
to compare against** — so an Eugene sync could never be validated by the method that
validated Woodland (§3.3). Do not enable Eugene until that is solved.

---

## 3. Reliability, unattended

**What is right, briefly, so it does not get broken later.** The upsert is idempotent — a
`findUnique` then agreement-check no-op `[D]` `upsert.ts:122` — so re-reading the same file
writes nothing. The write ordering is correct: the row upsert runs inside
`prisma.$transaction` `[D]` `engine.ts:253-260`, and the source watermark updates **after**
it `[D]` line 269, so a kill between them costs one idempotent replay and never loses data.
The MyMRC bridge yields cleanly rather than fighting (§3.4). And a ledger row is written on
every path including throws `[D]` `engine.ts:296-321`.

### 3.1 Poll dies mid-write

Safe for data. One provenance hole: the ledger `create` is also outside the transaction
`[D]` `engine.ts:298`. A kill after the row transaction commits but before the ledger write
leaves `processed_units_daily.import_id = <runId>` and `audit_log.actor_label =
system:workbook-sync:<runId>` pointing at a `workbook_sync_runs` row that does not exist.
The data is right; the trail dead-ends. Low severity, worth knowing at 2 a.m.

### 3.2 Concurrency

The cron awaits each fire before sleeping `[D]` `scripts/workbook-sync-cron.mjs`, and the
engine loops sources sequentially, so the daemon cannot overlap itself. There is **no
advisory lock**, so a manual `curl` of `/api/internal/workbook-sync/poll` during a running
poll can race the `findUnique`→`create` and hit the `(site_id, production_date)` unique
index `[M]`, aborting the transaction. Recoverable and noisy, not dangerous.

### 3.3 Does the extraction actually agree with reality? — **yes, measurably, for June**

This is the strongest evidence in this document, and I could produce it because both sides
already exist in production. `[M]` 2026-07-30, joining the staged `daily_close` rows against
`processed_units_daily` for Woodland, 2026-06-01 → 2026-06-30:

- **23 days compared. Delta 0.0 on every single one.** No day in the workbook is missing
  from Vision; no Vision day in the covered span is missing from the workbook.
- Workbook `stripped_program` month total = **17126**, which equals the workbook's **own**
  Processed SUM-row `D` total (staged as
  `{"programStripped":17126,…}` `[M]`). The per-day extraction cross-foots exactly to
  billing truth.

These two sides came from genuinely independent pipelines — an ExcelJS parse of Kelsey's
`.xlsm` versus a Salesforce scrape of MyMRC. That is a real, independent, real-file
validation of the load-bearing figure.

**What this does NOT validate:** `stripped_non_program` (all zeros, and §1.3 means we cannot
even tell blank from zero), `saved_units` (100% NULL in Vision `[M]`),
`material_ticket_number` (100% NULL in Vision `[M]` — the workbook carries them, so the sync
would _populate_ rather than overwrite), headcounts (§4), July, and any month with drift.

### 3.4 Interaction with the MyMRC bridge — a one-way ratchet, correctly built

`processed_units_daily` has four writers `[M]`: `mymrc/processed-bridge.ts:133` (raw
INSERT), `loads/processed-units.ts:196` (operator entry), `audit/workbook-promotion.ts:1119`
(ADR-0048 promotion), and `workbook-sync/upsert.ts`. The MyMRC bridge runs automatically —
`scripts/mymrc-scrape.mjs:199-211` calls `bridgeProcessedToInventory` inside the
`dr3-vision-mymrc-scrape` container, which is up `[M]`.

There is **no ping-pong**, because the bridge yields `[D]` `processed-bridge.ts:136-143`:

```sql
ON CONFLICT (site_id, production_date) DO UPDATE
  SET …
  WHERE processed_units_daily.source = 'mymrc'
    AND processed_units_daily.closed_at IS NULL
    AND ( … IS DISTINCT FROM … )
```

Once workbook-sync stamps `source = 'import'`, the bridge becomes a silent no-op for that
row, permanently. That is the intended ownership transfer and it is implemented correctly.

Two consequences to hold in mind:

1. **It is one-way and per-row.** The first successful poll takes ownership of every day it
   touches. There is no path back short of manual SQL.
2. **`vision_overwrite` is mislabelled.** `[D]` `upsert.ts:124` —
   `const wasVisionCaptured = existing.source !== 'import';` — treats a machine-bridged
   MyMRC row as "Vision-captured". All 976 current rows are `source = 'mymrc'` `[M]`, so on
   the first live poll `rows_overwritten` will be dominated by machine-vs-machine
   disagreement, not by destroyed human input. An operator reading "12 Vision overwrites"
   will draw the wrong conclusion.

### 3.5 Is anyone told when it refuses?

| Outcome                                                       | Ledger                                 | Page?                                                                  |
| ------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `error` (all six refusals, transport drift, download failure) | `status=error`, reason on `error_text` | Yes — `high`, 30-min in-memory cooldown, identical text forever (§1.6) |
| `forbidden` (Graph 403)                                       | `status=forbidden`                     | Yes — `high`                                                           |
| **`not_found`** (rename, typo, folder moved)                  | `status=not_found`                     | **No — nothing**                                                       |
| **rollout-read failure**                                      | `status=ok`, `cutover_noop=true`       | **No — nothing**                                                       |
| Mid-edit skips                                                | `rows_skipped_midedit=N`               | No, by design (D11) — correct                                          |
| Sync has produced nothing for N days                          | nothing                                | **No — nothing watches**                                               |

Two of the three ways this goes quiet are entirely unalarmed.

### 3.6 What the run ledger does NOT record that you would want at 2 a.m.

All of the following are computed and then thrown away:

- **`daysSeen`** — computed `[D]` `daily-adapter.ts:401`, logged `[D]` `engine.ts:265`, not
  persisted. So `rows_upserted: 0` cannot be read as "empty month" vs "everything agreed".
- **`templateGeneration`** — same. It is now load-bearing (it gates a refusal) and it is
  logged only.
- **The date RANGE written.** Nothing records min/max `production_date` for the run. This is
  the single field that would have caught §1.1 on the first bad poll.
- **The per-day skip detail.** `DailySkippedDay { label, reason, provenance }` is built with
  tab/row/column `[D]` `daily-adapter.ts:74-79` and collapsed into one integer.
- **`parsed.flags`** — including `[processed] … CONFIRM month + columns` and the
  inventory-close / inbound-reconciliation cross-checks. None persisted.
- **File identity beyond the name** — no `ctag`, no `lastModifiedDateTime`, no size, though
  all three are already on the `DriveFile` `[D]` `graph-transport.ts:103-109`. You cannot
  later ask "which version of the file produced this number".

Container logs carry some of this, but they are not durable and not joinable to a run.

---

## 4. The cutover model

### 4.1 The D7 no-op and the fail-safe direction — **the reasoning is right**

Skipping the poll when the rollout state is unreadable is correct, and for the reason given:
the asymmetry is real. Resuming workbook-wins on a cut-over site overwrites live
Vision-captured rows, which is irreversible; skipping a poll costs one 10-minute cycle and
self-corrects. Treating `UnregisteredSurfaceError` as pilot rather than folding it into the
same bucket is also right — an unregistered surface is a _deterministic_ answer, not a
failure `[D]` `engine.ts:169-174`.

Two things I would change, neither of them the direction:

- **Record it honestly.** `status: 'ok'` + `cutover_noop: true` for a pilot site is a false
  statement (§1.7). It needs a `skipped` status.
- **Escalate it.** A rollout read that fails for more than a few consecutive polls is a real
  outage of the sync, currently invisible.

The belt-and-braces in `cutover.ts:75-78` (also setting `is_syncing = false` on the flip, so
the stop is durable state and not only a runtime read) is good design and should stay.

### 4.2 Is `/admin/doc-ingest/reconciliation` the right measuring device?

**It is the right idea, the right grain, and the right comparison — and it has three
problems, one of which is fatal to its use as a cutover gate.**

Right: it compares per (site, day, metric); it is exact to 2 dp with **no tolerance band**,
deliberately; and it names the four outcomes an operator actually needs (`agree`,
`disagree`, `missing_in_vision`, `missing_in_reference`).

Problem 1 — **it currently reads nothing.** `doc_reference_rows` has **0 rows** in
production `[M]`. Three `doc_sources` exist and four `doc_source_versions` have `applied_at`
set, but all four have `absorption_status` NULL `[M]`, and the reconciliation filters to
`absorption_status = 'absorbed'`. Whatever the intended reading is, the instrument is
currently blank.

Problem 2 — **the verdict is operator-chosen and not persisted.** "Can this spreadsheet be
retired?" resolves to `settled = daysCovered > 0 && disagree === 0 && missingInVision === 0`
over whatever window was typed into the URL. Set `from = to = <one good day>` and it says
yes. And nothing is written — there is no `create`/`update` anywhere in the module, so there
is no durable record that anyone ever saw agreement, over what window, for which sites. The
ADR argues persistence would go stale, which is true and beside the point: what needs
persisting is not the _comparison_ but the _reading_ — an immutable "on 2026-08-06 we
compared July and got 0/0/0/22".

Problem 3 — **fatal for this purpose: the instrument stops being independent at exactly the
moment it is meant to license the change.** The reference side is produced by
`parseDailyRows` — the _same_ ADR-0049 daily adapter that will write the Vision side once
`is_syncing` is on. `[I]` Once workbook-sync owns `processed_units_daily`, the surface
compares the extractor against itself, and reads green regardless of whether the extraction
is correct; the only residual signal is version skew between the R2-archived revision and
the live file. Falsified if the reference side is ever re-sourced from something other than
`parseDailyRows` — e.g. a human transcription, or a second independent extractor.

**Today it is a genuine independent comparison**, because the Vision side comes from MyMRC
and operator entry. That window closes on activation.

### 4.3 The independent witness you actually have — and it is decaying

The comparison that has real evidentiary force is **workbook vs MyMRC**, which is exactly
what I ran in §3.3 and got 23/23 at delta 0.0. That comparison already has a home in the
codebase: `src/lib/audit/comparators/c2-processed.ts` compares `processed_units_daily`
against `mymrc_processed_mirror` per day, with a tolerance.

The problem: **the MyMRC mirror stopped producing on 2026-07-20.** `[M]` mirror
`max(processed_date) = 2026-07-20 12:00`, and Vision's `processed_units_daily`
`max(production_date) = 2026-07-20`, last written 2026-07-24. That is consistent with the
known MyMRC portal-redesign breakage. So as of today Vision's production data is **10 days
stale**, and the only independent witness to the workbook's correctness is going dark.

This cuts both ways and both matter:

- It is the strongest argument **for** turning workbook-sync on soon — it is the only live
  source of production figures left.
- It is the strongest argument **against** treating the reconciliation surface as the gate —
  by the time you want to prove correctness, the independent side may no longer exist.

### 4.4 What "green enough to cut over" should mean, concretely

ADR-0069 §4 says the extracted figures must match "for a full period". That phrase is not
defined in code or doc, and `settled` does not implement it. Here is a checkable
replacement. Vision is ready to be the system of record for `processed_units_daily` at a
site when **all five** hold:

1. **Two consecutive completed calendar months**, each measured no earlier than the 5th
   business day of the following month (so the month-close correction pass is included —
   §1.5), show **zero `disagree` and zero `missing_in_vision`** on `stripped_program` and
   `stripped_non_program`.
2. For each of those months, the sum of Vision's `stripped_program` equals the workbook's own
   Processed **SUM-row D total** — a cross-foot against a different cell, not a re-sum of the
   same rows. (§3.3 shows this passing for June: 17126 = 17126.)
3. Each measurement names the **file identity** it was taken from — file name plus `ctag` or
   `lastModifiedDateTime` — so "which version said this" is answerable later.
4. **At least one of the two months was measured against a source other than
   `parseDailyRows`** — MyMRC mirror, or a manual spot-count by Rick. Without this, criteria
   1–2 can be satisfied by an extractor agreeing with itself (§4.2 problem 3).
5. The reading is **persisted** as an immutable record carrying site, window, the four
   counts, `totalAbsDelta`, and the file identity — and `hasParitySignoff` requires such a
   record rather than a free-text note.

On criterion 5: today `recordParitySignoff` writes an `audit_log` marker with
`{signed_off: true, note}` and `hasParitySignoff` checks only that _a row exists_
`[D]` `parity-signoff.ts:19-42`. The cutover gate is therefore "somebody typed something",
soft, and overridable `[D]` `cutover.ts:53-54`. There is no link of any kind between that
button and the reconciliation surface. The signoff should carry the measurement, not point
at it.

**And note the sequencing this forces, which contradicts the natural reading of the plan:**
you cannot use the doc-ingest reconciliation to validate the sync _after_ switching the sync
on. Either validate first with `is_syncing` still false (using absorbed revisions for July
and August), or accept that after activation your ongoing witness must be MyMRC — which
means fixing the MyMRC scraper is on the critical path for cutover confidence, not a
separate workstream.

---

## 5. Recommendation on the workbook-wins question

**Recommendation: narrow it — per field, not globally. Treat the adapter's `null` as "the
workbook did not state one", never as "the workbook says none".**

### The three field classes

| Field                                      | Workbook carries it?                                                         | Recommended rule                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `stripped_program`, `stripped_non_program` | Always (a blank skips the whole day upstream)                                | **Workbook wins unconditionally.** No change.                                            |
| `material_ticket_number`, `saved_units`    | Yes, but legitimately optional per day                                       | **Workbook wins when it states a value; a null leaves the stored value alone.**          |
| `employees_count`, `processors_count`      | **Never** — the real Processed sheet has no such column (ADR-0049 Am.1 D12d) | **The sync must not touch them at all** — absent from `data`, absent from `disagrees()`. |

### Why this matters more than the ADR implies

The amendment frames it as a latent risk. It is closer to the surface than that:

- Today the risk is **zero data at stake**: `employees_count` and `processors_count` are
  non-null on **0 of 976** rows `[M]`.
- But they are **actively captured** by the manager close screen `[D]`
  `ProcessedUnitsEntryClient.tsx:73-74` and the admin screen `[D]`
  `ProcessedUnitsClient.tsx:86-87`, both API-validated `[D]`
  `api/manager/[site]/processed-units/route.ts:31-32`,
  `api/admin/processed-units/route.ts:27-28` — and **consumed downstream** by the COR
  prefill `[D]` `src/lib/cor/prefill.ts:164, 187-188, 195-196`.

So the first manager to fill in headcount for a day the workbook also covers loses it at the
next poll, and COR loses its prefill for that day. The window between "we turn this on" and
"someone uses that field" is one shift.

- There is a **second-order harm** that is easy to miss: `disagrees()` returns true on the
  headcount difference **alone** `[D]` `upsert.ts:56-57`. That rewrites the row with
  `source = 'import'`, which permanently locks the MyMRC bridge out of it (§3.4) — even
  though no production figure changed. Unnarrowed workbook-wins silently converts _headcount
  data entry_ into an _ownership transfer_.

### What it costs

- **~15 lines** in `upsert.ts` plus tests. Small.
- **You lose the ability for the workbook to CLEAR a field it does not carry.** For
  headcounts this is not a loss — the workbook never could say that.
- **For `material_ticket_number` / `saved_units` it is a real trade.** After narrowing, a
  ticket number the workbook _deliberately_ removed will persist in Vision. I still
  recommend narrowing them, because the sync re-reads the same file every 10 minutes: a
  mid-edit blank is a routine, every-poll event, while a genuinely retracted ticket number
  is rare and manually correctable. Getting this backwards means routine mid-edit blanks
  chew through real values all day.
- **One honest fidelity cost to write into the ADR:** after narrowing, a row can be
  mixed-provenance — production figures from the workbook, headcount from Vision — while
  `source` remains a single scalar reading `import`. The audit row already records
  before/after per field, so the trail survives; but `source` becomes a statement about the
  _production figures_, not about the row. Say so explicitly rather than letting a future
  reader discover it.

This decision is Bill's, not the parser's. My recommendation is: **narrow it, and settle it
before `is_syncing` is flipped**, because it is cheap now and becomes a data-loss incident
later.

---

## 6. Ranked gaps

### BLOCKS ACTIVATION — do not flip `is_syncing` until these are closed

| #      | Gap                                                                                                                                                                            | Why it blocks                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A1** | **Re-parse the archived June workbook with `9800880` and confirm 23 rows, `failure === null`** (§1.3)                                                                          | It may refuse Kelsey's real file outright. Cheapest possible test, non-destructive, and everything else is moot if it fails. Do this first.                                                                        |
| **A2** | **Cross-check the derived month against the file name; refuse on mismatch** (§1.1)                                                                                             | The one failure that silently corrupts a closed, billed month. The file name already states the answer; the engine already holds it. Also reject any `daily_close` date outside the file's month.                  |
| **A3** | **Header-validate the Processed sheet's D/E/J columns** (§1.2)                                                                                                                 | The only silent-wrong-figure path left. Mirror `findDayInboundHeader`; refuse on signature miss.                                                                                                                   |
| **A4** | **Alarm the silent paths** (§1.4, §1.7) — `not_found` persisting past a grace window; a `last_success_at` on `workbook_sources`; a `skipped` status for the rollout-read no-op | Two of the three ways this goes quiet page nobody, and no watchdog reads the ledger. Grade against the ADR-0037 gate: one `high` per site per day on "no successful sync in N business days", not a per-poll page. |
| **A5** | **Settle the workbook-wins narrowing** (§5)                                                                                                                                    | Explicit ADR-0049 Am.1 open item; one shift's exposure once live; ~15 lines.                                                                                                                                       |

### FIX BEFORE THE FIRST MONTH BOUNDARY

| #      | Gap                                                                                                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | **Prior-month grace window** (§1.5) — keep polling month M's file through the 5th business day of M+1, so the month-close correction pass is ingested. Without this, every month permanently freezes mid-correction. |
| **B2** | **Backoff + escalation on refusal** (§1.6) — exponential backoff on re-download for an unchanged failing ctag; page once, then escalate on a ladder, rather than 28 identical pages a day forever.                   |
| **B3** | **Ledger the date range written** (§3.6) — min/max `production_date` per run. This is the field that catches A2's failure on the first bad poll rather than at month-end.                                            |

### FIX LATER — fine to run with

| #      | Gap                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C1** | Rest of the ledger enrichment: `days_seen`, `template_generation`, file `ctag` + `lastModified`, per-day skip reasons with provenance, `parsed.flags`. |
| **C2** | Persist reconciliation readings; make `hasParitySignoff` require a measurement rather than a note (§4.4 criterion 5); link the two admin pages.        |
| **C3** | Fix the `vision_overwrite` label and split `rows_overwritten` into machine-vs-human (§3.4).                                                            |
| **C4** | Advisory lock around the poll (§3.2).                                                                                                                  |
| **C5** | Operator-editable sheet-name aliases, so a tab rename does not require a production deploy (§2.4).                                                     |
| **C6** | Close the ledger-write-outside-transaction provenance hole (§3.1).                                                                                     |

### NOT A CODE GAP, BUT ON THE CRITICAL PATH

**Fix the MyMRC scraper.** `[M]` the mirror has produced nothing since 2026-07-20; Vision's
production data is 10 days stale as of 2026-07-30. MyMRC is the only _independent_ witness to
whether the workbook extraction is right (§4.3), and the doc-ingest reconciliation cannot
substitute for it after activation because both of its sides then run the same extractor
(§4.2). Cutover confidence depends on it.

---

## 7. Bottom line

The extraction is **better than its own documentation claims** — it has been run against
Kelsey's real June workbook, and its per-day figures agree with MyMRC on 23 of 23 days at
delta 0.0 while cross-footing exactly to the workbook's own month total (§3.3). Amendment 1's
refusal architecture is sound and the fail-safe directions are chosen correctly.

What is missing is not parsing quality. It is that the system has **no way to notice it has
stopped working** (§1.4, §3.5, §3.6), **one unguarded path that corrupts a closed month
silently** (§1.1), **one unguarded path that writes wrong figures silently** (§1.2), and
**an acceptance criterion that dissolves at the moment it is needed** (§4.2).

A1–A5 are all small. None of them is a redesign. Close those and this is genuinely dialled
in for the bridge period.
