# ADR-0048 — June operational backfill + Terex history import (the tracking month)

**Status:** PROPOSED — awaiting operator review (Bill)
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
