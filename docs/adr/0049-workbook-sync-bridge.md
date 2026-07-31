# ADR-0049 — Woodland workbook → Vision sync bridge to cutover

**Status:** Accepted (2026-07-09 — operator build-all order; parser finalization pending the real workbook file). The `Files.Read.All` tenant-wide grant landed 2026-07-09 (`docs/handoffs/2026-07-09-it-permissions-execution-complete-script-fixes-202.md`; app `2da92424-7397-435d-96a1-d2a382293a53`). The bridge is built mock-first per the ADR-0046 transport discipline: a real Graph Files transport and a fixture transport both satisfy one interface, so the entire engine is testable without the tenant. Two things remain GATED and are called out loudly below: (1) the parser maps the Addendum-B fixture shape until Kelsey's real `.xlsm` is in hand (D12), and (2) each `workbook_sources` row is born `is_syncing=false` — a deliberate operator enable turns real polling on. See the post-acceptance notes at the foot of this file.
**Date:** 2026-07-08
**Related:** ADR-0030 (accuracy source), ADR-0037 (loads/inventory model), ADR-0038 (parallel transport pattern), ADR-0039 (becomes Leg C), ADR-0046 (parallel Graph transport), ADR-0047 (cutover flip), ADR-0048 (shares parser)
**Source:** `docs/handoffs/2026-07-09-planning-session-decisions-rollup-2026-07-08.md` §2.1 (verbatim)

## Context

Vision's daily production report (ADR-0030) currently bases numbers on Vision-captured data, which lags Janette's authoritative Woodland daily-log spreadsheet during the pre-cutover window. 7/8 (today) through 8/1 (cutover), the spreadsheet is the source of truth. This ADR replaces the rollout-gate patch (Q-0047-1) with a structural fix.

Beyond fixing ADR-0030 accuracy, sync enables:

- ADR-0039's 3-way audit to have a third leg (workbook mirror) during shadow-billing
- Stage 3 shadow-billing parity to compare Vision-generated invoices against workbook-derived reality
- ADR-0048's June backfill promotion to run against actual workbook shape (not fixtures)

## Decisions

**D1 — Scope**: Full daily log mirror. Every sheet Janette maintains flows into Vision.

**D2 — Cadence**: 10-min polling business hours (6 AM – 8 PM PT, Mon-Fri). Graph delta query for change detection. Outside business hours: no polling.

**D3 — Conflict rule**: Workbook wins pre-cutover. Vision-captured data that disagrees gets overwritten. Audit log records every overwrite. Post-cutover direction flips.

**D4 — Storage source**: Kelsey's personal OneDrive at `svdplanecounty-my.sharepoint.com/personal/kelsey_ruhland_svdp_us/`. File stays where it is; Kelsey remains an SVdP employee through and after 8/1.

**D5 — Monthly file rollover**: Pattern `<MONTH> <YEAR> DAILY LOG WOODLAND.xlsm`. Sync auto-discovers the current month's file each poll. Parser handles a possibly-empty file on the 1st of a new month.

**D6 — Access mechanism**: `Files.Read.All` app permission on the existing dr3-vision Graph app. Tenant-wide OneDrive read scope. Sharing to `dr3-vision@svdp.us` failed (the shared mailbox has no OneDrive to receive shares); delegated auth is fragile; tenant-wide is the only permission that stays functional. Acceptable given SVdP is a single small tenant and Vision is already trusted with `Mail.Send` at tenant scope.

**D7 — Cutover trigger**: Manual admin flip in `/admin/rollout`, on a new surface `workbook_sync`. Flip requires Rick's parity signoff in the audit ledger (soft-gate: UI warns if not present but allows override). R2 archival fires atomically.

**D8 — R2 archival**: `archiveWorkbooksToR2()` runs as part of the cutover flip. Copies all monthly `.xlsm` files that were syncing to `workbooks/{site}/{yearMonth}.xlsm`. Immutable, forever retention.

**D9 — Site parameterization**: `workbook_sources` config table with `site_id`, `share_url`, `naming_pattern`, `is_syncing`, `last_polled_at`. Woodland ships day 1. Eugene is added as a config row when Rick confirms.

**D10 — Historical backfill**: June + July via ADR-0048's promotion pipeline (already built, waiting on D4 files). Sync-side backfill for August+ is unnecessary — sync starts live on 8/1.

**D11 — Mid-edit tolerance**: Rows with required cells empty are skipped on the current poll, retried on next. No error, no alert — eventual consistency.

**D12 — Parser sharing**: Same parser as ADR-0048. Parser is finalized once Kelsey's actual `.xlsm` is in hand.

## Consequences

_Positive:_

- The daily production report becomes accurate the day sync goes live
- ADR-0039 audit gains Leg C during shadow-billing
- Stage 3 parity becomes a real automated comparison
- Post-cutover archival ensures workbook data survives Kelsey's role transitions
- Parser finalized once, reused twice

_Negative:_

- Tenant-wide `Files.Read.All` is a broader permission than typical
- Kelsey's OneDrive as source means account issues could break sync — bounded by her staying employed
- Requires the `Files.Read.All` grant to land before shipping; tenant-admin gated on IT

## Test plan

- Poll finds the current month's file, delta-queries, no full re-download when unchanged
- Poll skips outside business hours
- Mid-edit rows skipped, retried, eventually consistent
- Workbook write overwrites a Vision-captured record with an audit entry
- Monthly rollover: sync switches to August's file on 8/1 without a config change
- Cutover flip: sync stops, R2 archival fires, downstream Vision continues reading its own data
- Post-flip sync is a no-op
- Missing `Files.Read.All`: fail-soft, log + ntfy, no crash

## Migration

`20260709_workbook_sync` adds `workbook_sources` and `workbook_sync_runs` tables (mymrc-shape run ledger). (Deferred with the build; not created in this proposal.)

## Runbook

`docs/operator/workbook-sync.md` — enable, check status, cutover flip, the
`Files.Read.All` dependency + 403 symptom. Written with the build.

## Post-acceptance notes (build 2026-07-09)

Built under Bill's 2026-07-09 "build all out that we can" order, mock-first per the
ADR-0046 transport discipline. Status flipped to Accepted; the migration shipped as
`20260716b_workbook_sync` (not the placeholder `20260709_*` — the `20260716b_`
prefix sorts after the sibling AP `20260716_*` and the main tip
`20260715b_rollup_ap_boardpack_yard`, preserving ADR-0035 lexical ordering).

**What shipped, testable without the tenant:**

- `src/lib/msgraph-files/` — a generic READ-ONLY Graph Files transport (interface +
  live `graphFilesTransport` (client-credentials, `Files.Read.All`, drive-by-UPN per
  D4, path-addressed children, cTag delta per D2) + fixture `mockFilesTransport`).
  The Files creds fall back to the shared `MSGRAPH_MAIL_*` app registration (one app,
  two capabilities — D6). 403 ⇒ `FilesForbiddenError` ⇒ fail-soft.
- `src/lib/workbook-sync/` — the engine (discover current-month file, cTag delta,
  parse, workbook-wins upsert into `processed_units_daily` with an audit row per
  Vision-overwrite (D3), mid-edit skip+count (D11), ledger-always), business-hours
  predicate (PT+DST), monthly rollover (D5), R2 archival (D8), parity soft-gate (D7),
  cutover.
- Internal poll route + `scripts/workbook-sync-cron.mjs` (10-min, business-hours
  enforced at the route) + public-paths exemption (+ regression test — the ADR-0036
  lesson) + the `workbook-sync` compose profile.
- `/admin/workbook-sync` (sources add/edit/enable, run ledger, cutover with parity
  soft-gate). The `workbook_sync` cutover surface also appears in `/admin/rollout`;
  flipping it to `live` there ALSO fires archival (the hook lives in `notify/flip.ts`).
- Seed: Woodland source (born `is_syncing=false`) + `workbook_sync` rollout surface
  (born `pilot`), both idempotent.

**LOUD — what remains gated:**

1. ~~**Parser finalization (D12).**~~ **CLOSED 2026-07-30 — see Amendment 1 below.**
2. **Enable flip.** Each `workbook_sources` row is born `is_syncing=false`; a
   deliberate operator enable turns real polling on. The `workbook-sync` compose
   service is profile-gated for the same reason.

---

## Amendment 1 (2026-07-30) — D12 closed: the adapter derives, it no longer guesses

**Status:** Accepted. Closes the D12 parser-finalization gate. Does NOT flip
`is_syncing` — that remains the operator's call (gate 2 above stands).

### What was wrong

`daily-adapter.ts` matched a sheet named exactly `daily` and read FIXED columns
A–G. No real Woodland workbook has that sheet. Against Kelsey's file it would have
produced either zero rows (silent) or **whatever happened to sit in A–G, mapped
into `processed_units_daily` under workbook-wins semantics** — a guessed column
overwriting a real production figure.

The machinery to do this correctly already existed _and already ran on the same
bytes_: `engine.ts` called the layout-aware `parseWorkbook` (ADR-0039/0048) and
discarded everything except `templateGeneration`, which it printed in a log line.

### Decision

**D12a — the adapter DERIVES from the layout-aware parse.** `deriveDailyRows`
decodes the `daily_close` staging rows the semantic extractor produces from the
Processed sheet (resolved by MEANING via `section-resolver.ts`: row-2 section
label → header signature → prefix-stripped name). The adapter addresses no cell,
no column letter and no sheet name of its own. The bytes are parsed ONCE per poll
and the same `ParsedWorkbook` feeds both staging/provenance and the operational
rows.

**D12b — a missing figure is never a zero.** `stripped_program` and
`stripped_non_program` are billed production figures. A blank cell for either
SKIPS that day and counts it (the existing D11 mid-edit concept, extended with a
per-day reason + provenance), retried next poll, no alert. The extractor
(`section-extractors.ts`) was emitting `?? 0` for both into the staging payload;
it now emits only what the sheet carries, so the promotion decode's `reqNum`
refuses such a day too instead of consuming a manufactured zero.

**D12c — "cannot read" and "no data" are different outcomes.** Refusals return a
`failure` and the engine turns it into a FAILED run with the reason on
`workbook_sync_runs.error_text`, writing nothing and NOT advancing the file
watermark:

| Outcome                                                       | Result                                          |
| ------------------------------------------------------------- | ----------------------------------------------- |
| `templateGeneration === 'unknown'`                            | refuse — `unknown_template_generation`          |
| Processed section never resolved (incl. undeterminable month) | refuse — `daily_section_unresolved`             |
| Days present, none usable                                     | refuse — `all_days_unusable` (names day + cell) |
| One date twice with different figures                         | refuse — `conflicting_duplicate_days`           |
| Every resolvable source name belongs to another site          | refuse — `wrong_site`                           |
| Processed section resolved, zero day rows                     | **ok**, 0 rows — an empty month                 |

`templateGeneration` is therefore load-bearing, not decorative.

**D12d — the mock fixture mirrors the real shape.** `buildFixtureWorkbookBytes`
built an invented `Daily` A–G sheet that cannot occur in production, so it proved
nothing about production — it only made the broken adapter look green. It now
builds a Processed sheet + DAY sheets in the real shape, and carries **no**
employees/processors columns, because the real Processed sheet has none.

### Consequence the operator must decide before enabling

`processed_units_daily.employees_count` / `processors_count` are Vision-captured
fields the workbook does not carry, so the adapter reports them as `null` — the
honest reading of "the workbook did not state one". But `upsert.ts` treats any
field difference as a disagreement, so under workbook-wins a sync will **null out
a Vision-captured headcount** (audited as an overwrite, but destroyed). This is
pre-existing upsert semantics, not new behaviour, and it is deliberately NOT
changed here — narrowing workbook-wins to the fields the workbook actually
carries is an operator decision, not a parser one. It should be settled before
`is_syncing` is flipped.

---

## Amendment 2 (2026-07-30) — pre-activation assessment; five gates before `is_syncing`

**Status:** Proposed. Records findings and a recommendation; changes no code and does not
flip `is_syncing`. Full evidence, with `[M]`/`[D]`/`[I]` labels and file:line, in
[`docs/2026-07-30-workbook-sync-versatility-and-reliability-assessment.md`](../2026-07-30-workbook-sync-versatility-and-reliability-assessment.md).

### Correction to the record

Amendment 1 and the surrounding notes read as though no real workbook had been seen.
Production says otherwise: `workbook_imports` holds `JUNE 2026 DAILY LOG WOODLAND.xlsm`
(47 sheets, 432 rows, `template_generation = woodland_daily`, parsed 2026-07-20 PT), with
23 `daily_close` staging rows from the tab `June26 Processed`. Measured 2026-07-30, those
23 days agree with `processed_units_daily` (MyMRC-sourced) at **delta 0.0 on every day**,
and their `stripped_program` sum (17126) equals the workbook's own Processed SUM-row D
total. The unit-test fixtures remain synthetic; the parser does not.

### Gates before `is_syncing` is flipped

- **A1** Re-parse the archived June bytes with post-Am.1 code and confirm 23 rows with
  `failure === null`. The `snp ?? 0` removal means a _blank_ column E now skips the day; the
  staged rows cannot distinguish blank from zero, so it is currently unknown whether today's
  code refuses Kelsey's real file in full.
- **A2** Cross-check the parser's derived month prefix against the file name's month and
  refuse on mismatch. `deriveMonthPrefix` returns on the **first** dated inbound row and
  nothing compares it to the file name, so one stale copy-forward row dates a whole month
  into the previous month — overwriting closed, billed figures under workbook-wins, with the
  run recorded `ok`.
- **A3** Header-validate the Processed sheet's `D`/`E`/`J` columns (the DAY inbound grid is
  already header-resolved; the billed figure is not). A single inserted column yields wrong
  figures with no refusal.
- **A4** Alarm the silent paths: `not_found` pages nobody, an unreadable rollout state is
  recorded as `ok`/`cutover_noop`, and nothing reads `workbook_sync_runs` except an admin
  page. Add a `last_success_at`, a `skipped` status, and one ADR-0037-graded staleness alert.
- **A5** Settle the D12 open item below — see the recommendation.

### D13 (proposed) — workbook-wins is narrowed per field

`null` from the adapter means "the workbook did not state one", never "the workbook says
none":

| Field                                      | Rule                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `stripped_program`, `stripped_non_program` | Workbook wins unconditionally (unchanged)                                           |
| `material_ticket_number`, `saved_units`    | Workbook wins **when it states a value**; a null leaves the stored value alone      |
| `employees_count`, `processors_count`      | The sync never touches them — absent from the update payload and from `disagrees()` |

Rationale beyond Am.1's: the headcounts are actively captured by the manager and admin close
screens and consumed by the COR prefill, and because `disagrees()` fires on a headcount
difference alone, an unnarrowed sync converts _headcount data entry_ into a permanent
ownership transfer (rewriting `source` to `import` locks the ADR-0058 MyMRC bridge out of
that row for good). Accepted cost: a row becomes mixed-provenance — production figures from
the workbook, headcount from Vision — while `source` remains a single scalar reading
`import`. `source` therefore describes the production figures, not the row; the per-field
audit trail remains the record of what changed.

### Cutover criterion

ADR-0069 §4's "matching the paper record for a full period" is undefined and the surface
implements `disagree === 0` over an operator-typed window with nothing persisted. More
seriously, `/admin/doc-ingest/reconciliation` sources its reference side from the **same**
`parseDailyRows` that will write the Vision side once sync is live — so after activation it
compares the extractor to itself. The durable independent witness is the MyMRC mirror
(`c2-processed`), and it has produced nothing since 2026-07-20. **Fixing the MyMRC scraper is
on the critical path for cutover confidence.** The proposed five-part acceptance statement is
in §4.4 of the assessment note.

---

## Amendment 3 (2026-07-31) — the five activation gates are closed

**Status:** Accepted. Closes A1–A5 from Amendment 2. Does **NOT** flip `is_syncing` —
that remains the operator's call (post-acceptance gate 2 still stands). The
`mode !== 'graph'` transport guard is unchanged; `allowNonGraphWrites` is still
TEST-ONLY. All times Pacific.

### A1 — a blank non-program cell is "none", not "unreadable"

**The measurement that forced this.** Amendment 1's D12b removed the extractor's
`snp ?? 0`, which was right for `stripped_program`: a manufactured zero on the
primary billed figure is a fabricated fact. But the same rule applied to
`stripped_non_program` refuses Kelsey's real workbook **in full**. Re-parsed
2026-07-31 from the archived June bytes
(`workbook-imports/ba3beeeb-…/JUNE_2026_DAILY_LOG_WOODLAND.xlsm`, 759 720 bytes,
sha256 `1eeeccbd…`) with `9800880` code:

```
templateGeneration : woodland_daily      sheets: 47
daysSeen           : 23
ROWS               : 0
midEditCount       : 23
failure            : all_days_unusable
                     day_1 stripped_non_program_unusable @ June26 Processed!D9
                     … all 23 days, identical reason
```

Column E is **blank**, not zero — a direct read of the sheet confirms every `Day N`
row from row 9 to row 39 has an empty E, while D carries the program figure. June
had no non-program stripping and it was left empty rather than typed as `0`. With
`is_syncing` on, that is a refusal every 10 minutes and a page ~28×/business-day,
indefinitely.

**D14 — the rule, narrower than Am.1's.**

| Cell                                                                      | Reading                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| blank `stripped_program`                                                  | the day is genuinely unusable — SKIP + count (unchanged)         |
| blank `stripped_non_program` on a row whose `stripped_program` IS present | **none — 0, recorded as INFERRED**                               |
| `stripped_non_program` PRESENT but unusable (negative, non-numeric)       | still a SKIP — a figure we cannot trust is not a cell left empty |

The inference is marked, not hidden: `DailyProductionRow.strippedNonProgramInferred`
carries it, and `upsert.ts` writes `stripped_non_program_inferred` into the
`audit_log` `after` payload. **The provenance never claims the sheet said zero.**
The distinction is drawn on whether the extractor emitted the KEY, which it does
only for a cell it actually read — so this cannot be confused with a bad value.

**Why this is a correction and not a convenient loosening.** Those same 23 days
match the MyMRC mirror at **delta 0.0 on all 23** and their `stripped_program` sum
cross-foots exactly to the workbook's own Processed SUM-row D total of **17126**
(`June26 Processed!D40`) — both measured under the pre-Am.1 `?? 0` behaviour. The
days are real and complete; their non-program value is genuinely none.

**Acceptance, measured against the real file post-change:** 23 rows,
`failure === null`, `sum(strippedProgram) === 17126`, `midEditCount === 0`, 23 rows
marked `strippedNonProgramInferred`, dates `2026-06-01 … 2026-06-30`. The file was
fetched read-only, used, and destroyed; it is not a fixture and is not in the repo.

### A2 — the month is cross-checked against the file name

`deriveMonthPrefix` returned on the **first** dated inbound row and nothing compared
it to anything, while the file name states the month explicitly and `engine.ts`
already held it. One July-dated row surviving a copy-forward clear-down dated every
August close row into July — overwriting a closed, billed month under workbook-wins
with the run recorded `ok`.

`resolveWorkbookMonth` now settles the month once, from two sources, with three
distinct outcomes:

| Derived from the workbook | From the file name        | Outcome                                                                    |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| present                   | absent, or agrees         | that month                                                                 |
| present                   | present and **disagrees** | **refuse — `month_mismatch`**, no rows built                               |
| absent                    | present                   | that month, with a flag saying the close dates rest on the file name alone |
| absent                    | absent                    | **`month_undeterminable`** — see below                                     |

Neither source overrules the other on disagreement: picking one is exactly the guess
that corrupts a billed month. The adapter additionally rejects any individual
`daily_close` date outside the file's month (`date_outside_file_month`) — defence in
depth against a future path that dates rows individually.

**The honest edge.** Processing recorded before the month's first inbound load used
to produce `monthPrefix === null` → no Processed rows → `daily_section_unresolved` →
a FAILED run that pages. Two changes: the file name now **supplies** the month in
that case, so the normal early-month shape simply works; and where no month exists
at all, the failure carries `notEnoughData: true`, which the engine records as
`skipped` and does **not** page. "Not enough data yet" is not a fault.

### A3 — the Processed columns are header-resolved, not assumed

`STRIPPED_PROGRAM = 4 / STRIPPED_NONPROG = 5 / MATERIAL = 10` were fixed ordinals
justified by a comment observing stability across June and July (n = 2), while the
DAY inbound grid in the same file had always resolved by header text. One inserted
column and both ordinals land on different, still-finite, still-non-negative
numbers; every downstream check accepts them and the run is recorded `ok`.

`findProcessedColumns` mirrors `findDayInboundHeader`. The real header is a **two-row
band** (June: row 7 `DAILY Program` over row 8 `STRIPPED UNITS`), so a column's label
is its two lines joined; the **leftmost** match wins because the "Mid-month totals"
block repeats those exact labels further right (June: L/M/N). On the real file it
resolves D/E at header row 7 — the same columns the ordinals named, now for a reason.

A band it cannot recognise **refuses** — `processed_columns_unrecognised` — rather
than falling back to the ordinals. There is no fallback: an unvalidated ordinal is
the defect.

The material-ticket column carries **no header** on the real sheet, so it is resolved
by CONTENT — the leftmost column right of the non-program figure whose day rows carry
a ticket-shaped value (`M-175506`). Resolving to nothing means the workbook stated no
ticket: that is `null`, not a refusal, because the ticket is not a billed figure and
D13 makes a null a no-op at the upsert.

### A4 — the silent paths now speak, once

Three defects, one fix each:

- **`not_found` told nobody, forever.** The ntfy calls lived only in the engine's
  `catch` block, which `not_found` never reaches, so a rename, a typo, a stray
  `… (1).xlsm` copy or a moved folder went silent indefinitely.
- **An unreadable rollout state was recorded `ok` + `cutover_noop: true`** — a row
  asserting a site was cut over when that is precisely what could not be read. The
  fail-safe DIRECTION is unchanged and still right; only the recording changes. It
  is now `skipped` with `cutover_noop: false` and the reason on `error_text`.
- **`workbook_sources` recorded "we polled" and not "we last got data".**

**Schema (`20260819_adr0049_workbook_sync_activation_guards`, purely additive,
replayed on an empty PG16 and dropped):** `WorkbookSyncStatus += skipped`;
`workbook_sources += last_success_at, consecutive_failures, last_alert_at`.
`last_success_at` is stamped on every poll that READ the workbook — including a
cTag delta no-op and a legitimately empty month — and never on `not_found` or a
refusal.

**Alarm grading, against the ADR-0037 five-question gate.** Priority `high`, never
`urgent` (Q1: a stuck workbook needs Kelsey, not an operator at 02:00). One page per
**site**, not per poll and not per failing check (Q4). Tier-2 click to
`/admin/workbook-sync` (Q5). Two conditions page:

1. a **read failure** (`error` / `forbidden`) — on the FIRST poll of the streak, then
   at most daily;
2. **staleness** — no successful read for **5 days**, whatever the status. This is
   the only thing that pages on `not_found` or `skipped`, and it must be: a
   `not_found` on the 1st of a month, before Kelsey creates the new file, is the
   correct expected state (D5), and a rename produces an identical per-poll signal.
   Duration is the only thing that separates them. Five days rather than two because
   polling is Mon–Fri (D2), so a Friday-evening breakage is legitimately silent until
   Monday.

**The flood is fixed by moving the cooldown into the database.** The 30-minute
window lived in `src/lib/ntfy.ts`'s process-local `Map`, which every container
restart wiped — hence ~28 identical pages per business day. `last_alert_at` is a
column. Regression-tested: 28 consecutive 10-minute polls against a permanently
refused workbook publish **one** page.

### A5 — workbook-wins is narrowed per field (D13, accepted)

D13 as proposed in Amendment 2 is accepted and implemented. `null` from the adapter
means "the workbook did not state one", never "the workbook says none".

The headcount fields are gone from `DailyProductionRow` entirely rather than carried
as always-null: the real Processed sheet has no such column (Am.1 D12d), the sync
never writes them, and a field that is always null and never written is an invitation
to wire it back up. `disagrees()` and the update payload now cover only the fields
the sync will actually write, which is what stops a headcount difference alone from
rewriting `source` to `import` and permanently locking the ADR-0058 MyMRC bridge out
of the row.

**The fidelity cost, recorded plainly rather than left to be discovered:** a row can
now be **mixed-provenance** — production figures from the workbook, headcount from
Vision — while `source` remains a single scalar reading `import`. **`source`
therefore describes the production figures, not the whole row.** The per-field
`audit_log` before/after remains the record of what actually changed, and the `after`
payload omits fields the workbook did not state rather than writing them as null (a
null would read as "we wrote null").

### What Amendment 3 does NOT close

- **`is_syncing` is still `false`.** Unchanged, deliberately.
- **B1 (prior-month grace window), B2 (backoff on re-DOWNLOAD — the paging flood is
  fixed, the re-download of an unchanged failing cTag is not), B3 (ledger the date
  range written)** remain open. B3 is the field that would catch an A2-class failure
  on the first bad poll rather than at month-end; A2's refusal now prevents that
  class, but the ledger still records nothing about which dates a run touched.
- **The MyMRC scraper.** Still the only independent witness to whether the extraction
  is right, still producing nothing since 2026-07-20, still on the critical path for
  cutover confidence.
