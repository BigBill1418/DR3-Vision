# ADR-0048 — June operational backfill + Terex history import (the tracking month)

**Status:** Accepted (2026-07-06 evening PT, approved by Bill)
**Date:** 2026-07-06 evening PT
**Directive:** Bill 2026-07-06: "backfill all of June — that is our tracking month" · "all Terex history needs pulled in" · "Eugene: last week of June". Supersedes the go-live plan's anchor-forward + manual-Terex recommendations (PR #74 Part 4 #1/#2).

## Context

June is the validation baseline: Kelsey's July cross-checks, equipment trends,
running-balance continuity, and the July COR all read better against a real June.
The ADR-0039 workbook import is deliberately staging-only; ADR-0037 D8 equally
deliberately gave every operational table `source=import` provenance. This ADR
connects the two: a one-shot, idempotent, audited **promotion** of parsed
workbook staging rows into the operational tables — the ADR-0023
historical-bonus-import discipline applied to loads/inventory.

## Decisions

### D1 — Staging→operational promotion (one-shot, idempotent, audited)

`promoteWorkbookImport(importId, scope)` promotes staged rows into:
`processed_units_daily` (June closes, stripped P/NP per B4), `outbound_materials`
(commodity/sub-category rows incl. renovation), `landfilled_units`,
`consumer_dropoffs`, and `inbound_loads` (import-shape rows: date/source/slip/
units/retrac; no photos/timers — `source=import`, never touching iPad-era
semantics). Idempotent on (import_id) with a SHA gate (ADR-0023 pattern);
every promoted row carries `source=import` + the import id in provenance;
re-runs are no-ops; a promotion writes ONE audit row per table with counts.
Scope parameter enforces the directive: Woodland = 2026-06-01→30,
Eugene = 2026-06-24→30. Promotion REFUSES windows overlapping live-entered data
(any non-import row in scope ⇒ typed error listing conflicts — no silent merge).

### D2 — Inventory anchor + continuity

Promote the June 1 opening inventory as the anchor `site_inventory_snapshots`
physical row (from the workbook's DAY1 start), letting the balance run June
forward and **prove itself against the known 4,062 June-close figure** — which
becomes a live assertion, not a fixture. The DAY6 broken-roll and Friday-carry
defects in the source data surface as retro-audit findings, exactly as designed.

### D3 — Terex history import

Small admin upload accepting Janette's Terex spreadsheet (exact shape read from
the real file — importer written against it, fixtures derived from it) →
`equipment_events` rows (`source=import`): productivity notes → kind=note,
downtime entries → kind=downtime w/ hours where stated. Full history per
directive. Idempotent on (site, date, kind, note-hash).

### D4 — Inputs Bill must supply (the only blockers)

1. `JUNE 2026 DAILY LOG WOODLAND.xlsm` (the live copy w/ Kelsey's category tabs)
2. Eugene's June daily log (whatever artifact holds Jun 24–30)
3. Janette's Terex spreadsheet (full history)
   Drop path: the admin workbook-import surface for #1/#2 once this lands; #3 via
   the new Terex upload. Until supplied, everything ships tested against
   Addendum-B-shaped fixtures.

## Acceptance

Promotion counts reconcile to the workbook's own totals · June 30 Woodland
balance == 4,062 via the live function · re-run = no-op · zero mutation of any
non-import row · Eugene scope clipped to Jun 24–30 · Terex events render in the
trend view with June downtime bands.

## Post-acceptance notes (2026-07-07 — implementation)

**What shipped.** `src/lib/audit/workbook-promotion.ts` (+ test),
`src/lib/equipment/import.ts` (+ test), `src/lib/audit/backfill-scopes.ts`, the
promote/preview route (`/api/admin/audit/workbook/[importId]/promote`), the Terex
upload route (`/api/admin/equipment/import`), the workbook-import detail +
promotion panel, the Terex upload page, migration `20260714_june_backfill`, and
`docs/operator/june-backfill.md`. Gate: prisma generate → tsc 0 → eslint 0 → full
vitest green (1681 passed) → next build OK → migration clean-replays on empty PG16.

**The promotion staging contract.** The ADR-0039 parser is deliberately thin
(structural source-type rollups). The promotion consumes a RICHER, documented
per-record staging shape — the shape the _finalized_ daily-log parser will emit
once Bill supplies the real `.xlsm` (D4). Each promotable `WorkbookImportRow`
carries `section` (the target selector), `raw_value` (the record's full field-set
as JSON, decoded strictly), `site_name_raw` (the inbound source, resolved via
`source_aliases`), and `provenance`. Sections: `opening_inventory`, `daily_close`,
`inbound`, `outbound`, `landfilled`, `dropoff`. This keeps `workbook_import_rows`
the single source and is fully fixture-testable today; the real-file parser is a
follow-up that emits this contract (see D4).

**Provenance decision — `inbound_loads` has no `RecordSource` column.** Its
`source` field is the _Source relation_ (where mattresses come from), not
provenance. So inbound promotion provenance rides on the new `import_id` column
alone, and the conflict check for inbound is `import_id IS NULL` (a live,
non-promoted row) rather than `source != 'import'`. This is exactly why ADR-0048
adds the bare `import_id` column to all seven tables — traceability AND cheap
conflict/idempotency checks. The other six tables use `source != 'import'`.

**NOT-NULL compromises for import-shape inbound rows — none.** `inbound_loads`
required columns are `site_id`, `load_source_type` (default `b2b_haul`), `status`
(set to `verified` so the row counts in `running-balance`'s verified-inbound
term), and the timestamps (defaults). Everything the import-shape omits (photos,
timers, weight, operator, expected-load link, MyMRC ids, `dr3_number`) is
nullable. No column was weakened and no placeholder value was invented.

**The D2 assertion is computed from the promoted candidate set** via the shared
`computeRunningBalance`, inside the transaction, throwing to refuse commit. The
candidate set maps 1:1 onto the rows the transaction inserts, so this proves the
promoted numbers close to 4,062. The expected total lives in `backfill-scopes.ts`
(config), not in code. Anchor pool follows `onHand`'s documented default (the
physical anchor is attributed entirely to the program pool until historical pool
attribution lands).

**Deferred / follow-ups.** (1) The real-file parser that emits the promotion
staging contract — written against Bill's `.xlsm`/Terex files on receipt (D4). (2)
The DAY6 broken-roll and Friday-carry defects surface as retro-audit findings via
the existing ADR-0039 engine; the promotion does not attempt to "correct" them —
it promotes the workbook's own numbers and lets the 4,062 assertion + audit
findings expose drift. (3) A Terex trend view with June downtime bands consumes
the imported `equipment_events` through the existing ADR-0044 throughput/tile
surface — no new capture path was added.

## D3 finalized against Janette's real file (2026-07-21)

The pre-receipt importer used a flexible date/notes/hours/downtime header detector
and failed on the real file (`could not find a date column ... TEREX MACHINE
MAINTENANCE LOG`). The real workbook is a 41-sheet `.xlsx` whose actual shape drove
the finalization (`src/lib/equipment/import.ts`, `parseMaintenanceLogSheet`):

- **Targets:** the two `"Maintenance Log <year>"` sheets ("Maintenance Log 2025",
  "Maintenance Log2026"). Recognition is by sheet name (`isMaintenanceLogSheetName`,
  `/maintenance\s*log/i`) — so `"Maintenance Prices"`, `"diesel"`, and every monthly
  operating tab (`"Jan 2026"`, `"Feb26"`, …) are **skipped**. The import fails loud
  (typed 422, listing the sheets it saw) **only when ZERO** log sheets are present.
- **Layout quirks handled:** a banner row (col B) above the header row; a header row
  whose labels carry trailing asterisks (`"Date *"`, `"Notes*"`) with an UNLABELED
  leading col A; a literal `example` row (col A = `"example"`) skipped; month-separator
  rows (a bare month name in the Date cell) and year-marker rows (a 4-digit year in
  col A) skipped; SUM/subtotal rows (money, no date) and bare-date rows (date, no
  content) skipped. The maintenance-log path **skips** a non-date row rather than
  throwing (unlike the generic CSV path) because the real log is known to interleave
  them — freeform-date fragments ("Jan.6,2026", "02/01 thru 02-08") therefore skip too.
- **Kind + money mapping:** an `Actual Repair Cost` becomes `cost_cents`
  (kind=`repair`); a cost-less entry is kind=`maintenance` (no `hours_down` column
  exists in this file, so downtime bands come from manual entry, not the import).
  `Amount Credited` has **no column of its own** in `equipment_events` (one money
  field), so it is preserved in the note text (`Amount credited: $X.XX`); a
  credit-only row therefore stays kind=`maintenance` with `cost_cents=null` (never a
  negative cost — the service shape-guard forbids it). The Issue / Measures taken /
  Notes columns compose the event note (`—`-joined).
- **Contracts unchanged:** `source='import'`, per-batch `import_id`, `source_sha256`
  UNIQUE (re-upload no-op), `(site, event_date, kind, note-hash)` idempotency,
  admin-only route, one audit row per batch.
- **Real-file parse (dev-loop, not committed):** Maintenance Log 2025 → **55** events
  (7 with cost), Maintenance Log2026 → **68** events (7 with cost); **123** total.
  Fixtures are the sanitized `__fixtures__/build-terex-log.ts` workbook (5 + 3
  entries), never the real file. **Residual:** `Amount Credited` lives in note text,
  not a structured column — a future `credited_cents` column could recover it, but no
  schema change was made here.
