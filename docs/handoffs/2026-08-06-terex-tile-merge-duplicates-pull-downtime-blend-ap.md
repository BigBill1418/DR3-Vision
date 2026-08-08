# 2026-08-05 — The Terex tile: merge the duplicates, pull downtime, blend AP spend + maintenance log into one production surface

**Session context (Bill × Claude, 2026-08-05):**

Bill wants the equipment tile **renamed to Terex and upgraded across the board** into a single, math-verified view of one machine: its maintenance log (already absorbing per ADR-0069 Am.2), its **downtime** (on the scraped/synced sheet — location to be confirmed against the real file), and its **AP spend** (both a full cost ledger of every Terex-tagged invoice AND, where matchable, spend linked to specific maintenance events). Visible to **Bill + Woodland managers (Morena, Janette)**. Ready for production.

**This is an UPGRADE of an existing surface, not a new tile.** An equipment tile/surface already exists (ADR-0063 `/admin/equipment`). Find it, rename its Terex view, and build on it — do not create a parallel tile.

**Three phases, strict order.** Phase 1 must land before any dollar figure is trustworthy — you cannot sum spend correctly across three duplicate records. Do not reorder.

**Standing instruction applies with force here:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` first; verify every premise (especially the downtime column's location) against the **real TEREX workbook and live DB** before building. Multiple premises have died on checking this month; the downtime-location premise is the most likely to be one of them.

---

## Phase 1 — Merge the three Terex records into one canonical machine

**The problem, from production (ADR-0075):** Woodland holds three `equipment` rows for one machine, each cited by a different approved invoice:

| id | display_name |
|---|---|
| `7e35a4aa` | `Terex` |
| `bee54def` | `Terex Machine` |
| `1125fb30` | `Terex machine` |

A tile pulling "anything tagged Terex" across these three, un-merged, either triple-counts or (if it picks one) shows a third of the real spend. **Every total downstream is wrong until these are one record.**

**Use the ADR-0075 match-and-merge that already exists** — `resolveEquipmentRequest` now has a merge verb, and ADR-0075 built the collision→merge path. Do not hand-write a new merge; drive the existing one.

- Choose the canonical row (recommend `Terex`, `7e35a4aa`, the shortest clean name — but confirm which has the cleanest category/site data).
- Repoint **all** `ap_equipment_links` rows from `bee54def` and `1125fb30` to the canonical id. Verify the count of links moved equals the count that existed — no link orphaned, no invoice silently dropped from the ledger.
- Deactivate (never hard-delete — ADR-0063 D-onDelete:Restrict) the two non-canonical rows, so historical link integrity holds and the `(site_id, display_name)` unique index (ADR-0063 D3, explicitly NOT weakened by ADR-0075) stays satisfied.
- Record the merge in `audit_log` with before/after and which invoices moved.
- **Acceptance:** exactly one active Terex `equipment` row at Woodland; every previously-Terex-tagged invoice resolves to it; the sum of Terex-tagged invoice amounts is unchanged by the merge (merging must not create or destroy spend).

## Phase 2 — Find and absorb downtime (verify location FIRST)

Bill states downtime is "on the sheet that you already scrape that syncs to this system." **This must be confirmed, not assumed** — the ADR-0069 Am.2 TEREX absorption pulled `Estimated cost` / `Actual Repair Cost` / `Amount Credited` into the absorbed maintenance rows, and **no downtime/days-down column was recorded as absorbed.** So one of these is true, and Claude Code must determine which against the real workbook before building display:

1. **Downtime is a column on the maintenance-log sheets that the extractor is not yet pulling** → extend the TEREX extractor (ADR-0069 Am.2) to capture it into the absorbed rows, through the same preview-then-confirm + de-duplication discipline. Money and downtime both land staged.
2. **Downtime lives on one of the 38 deliberately-untouched sheets** → assess whether that sheet is safe to absorb (watch the single-writer rule: the monthly operating tabs carry per-day processed units = `processed_units_daily`, workbook-sync's sole territory — do NOT absorb those).
3. **Downtime is expressed as event dates / duration in the log** → derive days-down per event from the existing absorbed date fields, honoring the ADR-0069 Am.2 date-integrity rules (free-text dates like `"09/16 or 17"` are kept as text, never coerced; blanks stay blank; no invented days).

There is also an existing **`equipment_events`** table (ADR-0048 D3 Terex history importer) — check whether downtime already belongs there or should.

**Report the finding before building the display.** State which case is true, cite the actual column/sheet, and only then wire it. Downtime that can't be trusted into a number (same class as the untrustworthy date column) is kept as raw text, never guessed.

**Acceptance:** downtime per maintenance event is captured from its real source, with the same "never invent a value" discipline as the cost/date fields; a test asserts the downtime total on the tile equals the sum of confirmed absorbed downtime rows.

## Phase 3 — Rename + upgrade the tile to Terex, blend all three sources, math-verified

**Upgrade the existing equipment surface** (ADR-0063 `/admin/equipment` lineage) — rename the Terex view to "Terex," make it the blended machine view. Visible to **Bill + Morena + Janette** (Woodland managers). Follow the ADR-0017 admin-surface pattern already established; do not invent new chrome.

The blended view carries:

1. **Maintenance events** — from the absorbed TEREX log (`doc_terex_rows` or its confirmed-rows equivalent): event, date (or raw text where undated), actual repair cost, amount credited, and **downtime** (Phase 2). Only **confirmed** rows (the preview-then-confirm gate) — never staged/unaccepted money on a management view.
2. **AP cost ledger** — every invoice tagged to the now-merged canonical Terex record: date, vendor, amount, link to the AP decision. This is the "full ledger" half.
3. **Event-linked spend** — where an AP invoice can be matched to a maintenance event (by date proximity + amount, or an explicit link), show the spend against that event. This is the "link what I can" half. **Matching is best-effort and must be labeled as such** — an unmatched invoice appears in the ledger but not against an event; never force a match. Provide a light manual "link this invoice to this event" affordance if cheap; otherwise leave unmatched invoices in the ledger only.

**Math verification is a hard requirement, proven by tests, not eyeballed:**

- Tile maintenance-cost total **=** sum of confirmed absorbed `Actual Repair Cost` rows (the ADR-0069 Am.2 figure: **$77,067.94** against the current file — the tile must reproduce this exactly, NOT $154k; the subset-sheet de-duplication is the reason and the test must pin it).
- Tile credited total **=** sum of confirmed `Amount Credited` ($4,025.36 currently).
- Tile AP-spend total **=** sum of Terex-tagged invoice amounts across the merged record (Phase 1).
- Downtime total **=** sum of confirmed downtime rows (Phase 2).
- Event-linked spend **≤** total AP spend (a matched subset can never exceed the whole).
- Each of these is a **regression test that goes red on drift.** "Math-verified" means the assertion exists in the suite.

**Guardrails preserved:** confirmed-only money on the view; single-writer rule (this surface READS `processed_units_daily`/bonus/absorbed data, writes none of it); no staged money shown as fact.

---

## Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS on main. Locate the existing equipment tile/surface — this is an upgrade of it.
2. **Phase 1:** drive the ADR-0075 merge on the three Terex ids; repoint all AP links to the canonical row; verify link count and spend total are conserved; audit-log it; deactivate (not delete) the two duplicates.
3. **Phase 2:** inspect the REAL TEREX workbook; report where downtime actually lives (one of the three cases + `equipment_events`); absorb/derive it under the existing preview-then-confirm + date-integrity discipline; never invent a value.
4. **Phase 3:** rename + upgrade the tile to the blended Terex view for Bill/Morena/Janette; blend maintenance log + AP ledger + best-effort event-linked spend; confirmed-money-only; label matches as best-effort.
5. Every total gets a reconciliation test that goes red on drift (the $77,067.94 / $4,025.36 / merged-AP-total / downtime-total assertions).
6. Full adversarial error-test, then PR → CI → merge → deploy → verify live.
7. Tag Bill with: the merge result (one row, links moved, spend conserved), the downtime finding (which case + source), and the four reconciled totals proving the math.

**Do NOT:**
- Do NOT build the tile before the merge (Phase 1 first, always).
- Do NOT hand-write a new merge — use ADR-0075's.
- Do NOT weaken the `(site_id, display_name)` unique index (ADR-0063 D3).
- Do NOT assume where downtime lives — verify against the real file and report before building.
- Do NOT coerce untrustworthy downtime/date values into numbers — keep raw text, same as the existing date discipline.
- Do NOT show staged/unconfirmed money on a management view.
- Do NOT absorb the monthly operating tabs (they carry `processed_units_daily` territory — workbook-sync is sole writer).
- Do NOT force AP-invoice-to-event matches — best-effort, labeled, unmatched stays in the ledger.
- Do NOT create a parallel tile — upgrade the existing equipment surface.

## Success criteria

- One active Terex record at Woodland; all invoices repoint to it; spend conserved through the merge.
- Downtime captured from its confirmed real source, no invented values.
- The renamed Terex tile shows maintenance events (with downtime), the full AP cost ledger, and best-effort event-linked spend, to Bill/Morena/Janette.
- Tile totals reconcile exactly to confirmed absorbed rows and merged AP spend — **$77,067.94** repair / **$4,025.36** credited reproduced, not doubled — each pinned by a test.
- Confirmed-money-only; no new writers to production tables; the merge and any absorption are audited.

## For Bill

Once this lands you'll have one Terex, one number for what it has cost you, one view of what broke and when and how long it was down — and the totals are test-locked so they can't quietly drift. The event-linked spend is best-effort in v1: clean invoices matched to clear repairs will link, ambiguous ones stay in the ledger unlinked rather than guessing. If you want tighter invoice-to-event linking later, that's a fast follow once you see how much matches on its own.
