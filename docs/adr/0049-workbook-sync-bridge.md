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
