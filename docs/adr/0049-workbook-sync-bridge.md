# ADR-0049 — Woodland workbook → Vision sync bridge to cutover

**Status:** Proposed — approved direction 2026-07-08 (Bill × Claude planning session). Build is GATED on (1) SVdP IT granting the `Files.Read.All` tenant-wide application permission to the existing dr3-vision Graph app, and (2) Kelsey's real `JUNE 2026 DAILY LOG WOODLAND.xlsm` file in hand to finalize the parser. **No code is written for this ADR yet** — this document captures the locked direction so the build can start the moment the gate clears.
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

*Positive:*

- The daily production report becomes accurate the day sync goes live
- ADR-0039 audit gains Leg C during shadow-billing
- Stage 3 parity becomes a real automated comparison
- Post-cutover archival ensures workbook data survives Kelsey's role transitions
- Parser finalized once, reused twice

*Negative:*

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

`docs/operator/workbook-sync.md` — enable, check status, cutover flip. (Written with the build.)
