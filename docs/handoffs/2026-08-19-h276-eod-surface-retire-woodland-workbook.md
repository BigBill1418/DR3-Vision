# 2026-08-19 — The End-of-Day manager surface that retires the Woodland daily log

**Session context (Bill × Claude, 2026-08-19):**

This is the surface that ends the sheet. The `JULY_2026_DAILY_LOG_WOODLAND.xlsm` workbook is the last major spreadsheet DR3 still runs the floor from; the standing objective across this whole program is **Vision as single source of truth — no more sheets.** Bill: _"we need an end-of-day UI flow for the manager to enter the data from the day; all-inclusive yet not over-complicated… make sure we have UI surfaces built and fully functional to access them all… this is critically important."_

**Design decisions, locked with Bill (measured against the real sheet, not assumed):**

- **Shape:** ONE end-of-day screen, per day, per site — a **review-and-complete** surface. Operators enter during the day (counts, loads, dropoffs, Terex); the manager **reviews the day, sees gap flags, and fills only the holes** at EOD. It is not 11 blank forms; it is the day's captured data with entry where something's missing. This is what makes it all-inclusive yet not over-complicated.
- **Close Day:** the manager closes the day, and **chooses** — close clean, or **close with a noted exception** for open gaps. A closed day is **reopenable with an audited reason.**
- **Month-to-date rollup on the same screen**, replacing the `Summary` / `Trans Summary` tabs — Vision becomes where you _read_ the month.
- **Site:** Woodland now; **design so Eugene drops in cleanly** (site-scoped, no Woodland hardcoding).
- **Out of the daily flow by decision:** `Fuel` (auto-sourced from EIA, `fuel_prices.source = eia_api|manual`; a monthly rate-management concern, not EOD) and `Container Rentals` (monthly, effective-dated, has the `yard_list` admin surface already). Neither belongs in a _daily_ screen.
- **DAY0–DAY31 tabs are NOT in scope** — that per-day operator entry is already captured through the iPad/floor surfaces. This flow is the manager's office-side review + the functional tabs.

**Volume reality (measured from July's actual sheet — sizes the UI so effort matches use):**

- `inb no trans charge`: **93 rows** — the daily workhorse; heaviest affordance goes here.
- `inb trans charges`: **19 rows** — freight/mileage inbound; moderate.
- `Container Rentals`: 42 rows — but monthly, OUT of daily flow.
- `Commodities` (outbound): **8 rows** — light.
- `NonProgram`: **0**, `incentive_unpaid`: **1**, `Renovation`: **1 (a "Total: 0")** — essentially unused. These get a **simple add-line presence, NOT a dedicated built-out surface.** Building heavy UI for a channel used once a month is exactly the over-complication Bill warned against.

**Standing instruction:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` first; verify every premise against live code/DB. Premises have died on checking all month.

---

## PHASE 0 — Parity audit FIRST: prove every sheet column has a Vision home (gates the build)

Before building the surface, **map every functional-tab column to its Vision field**, and produce a written parity table. This is the "make sure we are not missing anything" proof Bill flagged as critical — the build targets whatever this surfaces. The exact columns to account for (read from the real July workbook):

- **`inb trans charges`** (freight inbound): Date · Site · inbound unit # · LBS (55/unit) · BOL#/Check# · DR3# · Haul# · **Freight Rate · Mileage · Mileage_Table.Assignment · Fuel Surcharge · Total · Freight**. → map to the event-billing engine (`event_freight`, mile-rate tables, `dr3_hauled` gating, `fuel.ts` CA surcharge). Confirm each of the freight/mileage/surcharge fields has a capture+compute home.
- **`inb no trans charge`** (the 93-row workhorse): Date · Site · commodity · inbound unit # · LBS · BOL#/Check# · DR3# · Haul# · trans charge. → the inbound bridge / `inbound_loads`. Confirm every column maps, especially commodity + haul#.
- **`incentive_unpaid`** (incentive/unpaid dropoff): the inbound cols + Outbound Unit# + a second Date/Site/commodity block. → the ADR-0085 dropoff capture (`floor_incentive` / unpaid). Confirm.
- **`NonProgram`**: inbound cols. → the non-program pool classification (ADR 2026-07-23). Confirm the pool split is captured.
- **`Renovation`**: Date · Site · commodity · sub category · LBS · BOL# · DR3# · Material# (+ outbound block). → `outbound_materials` (renovation folds the renovator channel in). Confirm it has _a_ home (used ~once/month, so a home + add-line is enough).
- **`Commodities`** (outbound, 8 rows): Date · Site · commodity · sub category · Outbound Unit# · LBS · BOL# · DR3# · Material#. → the absorbed outbound weights (`external_materials_id`, ADR-0104) + iPad outbound entry. Confirm the manual outbound-entry path covers every column.
- **`Processed`**: begins with beginning balances → `processed_units_daily` + the anchor/running-balance. Confirm.
- **`Container Rentals`** & **`Fuel`**: confirm they have homes (`container_rental_sites`, `fuel_prices`) but note they are **monthly/auto and OUT of the daily flow** — they are audited for completeness, not built into EOD.

**Output: a parity table — every column → Vision field, or FLAGGED missing.** Any genuinely-missing field is a finding reported before the build proceeds. Do not build the entry surface for a field until its home is confirmed or created. This audit is the proof that closing the sheet is safe.

## PHASE 1 — The EOD review-and-complete surface (Woodland, Eugene-ready)

A single manager screen, `/dashboard/[site]/eod` (or the established manager-route pattern — verify the convention), `requireManagerForSite`, English-first, EN/ES/UR, green/black, `onClick` not `<form>`.

**Structure — a reviewable day, not blank forms:**

- **Header:** site, the day (Pacific, via `currentPacificDayWindow`), day open/closed status.
- **Sections, each showing what's already captured for the day + a gap flag:**
  - **Inbound** (the workhorse) — lists the day's inbound loads (both freight and no-freight), each with its columns; manager can **add a missing inbound line** inline (full affordance: commodity, units, LBS, BOL/DR3/haul#, and for freight loads the rate/mileage/surcharge). This is where managers spend their time — make it fast.
  - **Outbound commodities** — the day's outbound loads (8-row-scale); add-line inline.
  - **Processed** — the day's processed close + on-hand (read from the running balance; this is the ADR-0110 number — show it honestly, including the negative/stale banner if it fires; never a bare wrong number).
  - **Non-program / Incentive / Renovation** — **simple add-line rows**, collapsed by default (near-zero use). Present so nothing is un-enterable, but not built-out surfaces.
  - **Terex** — the day's Terex entry (units + start/end hours per ADR-0107) or a "not recorded" gap flag.
  - **Dropoffs** — the day's public/incentive dropoffs (count + photo, ADR-0085), read-only summary.
- **Gap flags are the point:** each section shows ✓ captured or ⚠ missing, so the manager's job is "clear the warnings," not "re-type the day." An empty section a manager expects to be empty is fine; the flag just makes absence visible (the "not recorded ≠ zero" discipline).
- **Reuse existing entry paths** — do NOT rebuild inbound/outbound/Terex/dropoff capture. Where an operator surface already writes a table, the EOD screen reads it and offers the same write for gap-fill. New build is the _aggregation + review + close_, not re-plumbing capture. Respect the `processed_units_daily` precedence rule (three writers; not sole-writer) on any write.

**Close Day:**

- A **"Close Day"** action. The manager chooses: **close clean** (no open gaps) or **close with a noted exception** (open gaps remain, a reason/note is recorded naming what's outstanding).
- A closed day is **reopenable with an audited reason** (who/when/why), same audit discipline as the count-amendment and Terex prior-day work. Closing does not hard-lock the data from correction via the existing amendment paths; it marks the day reviewed and records exceptions.
- Store day-close state in a small table (`eod_day_close`: site, date, closed_by, closed_at, clean|exception, exception_note, reopened_by/at/reason) — additive migration, audited, unique on (site, date).
- **"Day" is Pacific** everywhere.

## PHASE 2 — Month-to-date rollup on the EOD screen (retires Summary / Trans Summary)

- On the same screen, a **month-to-date rollup** section: the running totals the `Summary` and `Trans Summary` tabs show — inbound units/LBS, outbound commodities, processed, transportation/freight summary, month-running vs mid-month.
- **Derived from the same tables the sections read** — do NOT recompute independently (the ADR-0110 lesson: two computations of one number is the defect). One source, rolled up.
- The stale `Summary!` / `Trans Summary!` sheet tabs are already advisory-only in ingestion (`[summary-stale]` flag) — this rollup is what makes them unnecessary to open.
- Label clearly that this replaces the sheet's Summary tabs.

---

## Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS on main; verify the manager-route convention and each capture path named above.
2. **Phase 0:** produce the column→Vision parity table for all functional tabs; flag any missing field; **report before building**. Build no entry surface for an unconfirmed field.
3. **Phase 1:** the EOD review-and-complete screen — sections show captured-vs-gap, inbound gets full add-line affordance, rare channels get collapsed add-lines, processed shows the honest on-hand (banner-aware), everything site-scoped and Eugene-ready. Reuse existing capture paths; build the aggregation/review/close, not re-plumbing.
4. **Close Day:** clean-or-exception close, audited reopen, `eod_day_close` table, Pacific day.
5. **Phase 2:** month-to-date rollup on the screen, derived from the same tables (no independent recompute), replacing the Summary tabs.
6. Falsification-grade tests: a missing inbound line raises the gap flag (assert ⚠, not a silent pass); close-with-exception records the note; reopen is audited; the rollup equals the sum of the sections (not a second computation); a negative on-hand shows the ADR-0110 banner here too, never a bare figure.
7. Each PR names **which sheet tab it retires**. Adversarial review; per phase PR → CI → merge → deploy → verify live.
8. Tag Bill with: the parity table (the proof), the EOD screen live at Woodland, a close-clean and a close-with-exception example, and the month rollup matching the sheet's Summary.

**Do NOT:**

- Do NOT build the entry surface for any column before Phase 0 confirms/creates its home.
- Do NOT rebuild inbound/outbound/Terex/dropoff/processed capture — reuse; build only aggregation/review/close.
- Do NOT build dedicated surfaces for renovation/nonprogram/incentive — collapsed add-lines only (measured near-zero use).
- Do NOT put Fuel or Container Rentals in the daily flow — monthly/auto, audited-only.
- Do NOT recompute the month rollup independently — derive from the section tables (ADR-0110).
- Do NOT show a bare negative/stale on-hand — reuse the ADR-0110 banner.
- Do NOT hardcode Woodland — site-scoped, Eugene-ready.
- Do NOT let Close Day hard-erase the path to correction — closing is review + exception recording, corrections still flow through the amendment paths.

## Success criteria

- A written parity table proves every functional-tab column has a Vision home (or the gaps are named and closed).
- A manager can, on one screen, review the whole day, see exactly what's missing, fill the gaps (fast for inbound, simple for the rare channels), and close the day clean or with a noted exception — reopenable, audited.
- The month-to-date rollup on that screen reproduces the Summary / Trans Summary tabs, derived from one source.
- On-hand shown on the screen is the honest ADR-0110 number (banner-aware), never a bare wrong figure.
- Every piece is site-scoped and Eugene-ready.
- Each retired tab is named in its PR — the checklist of what can go dark.

## For Bill

This is the surface that lets you actually stop opening the workbook. Phase 0 is the part that matters most for your "make sure we're not missing anything" — it produces a literal column-by-column proof that every field the sheet holds has a home in Vision before a single entry box is built, so retiring the sheet is a proven-safe act, not a hopeful one. The screen itself is a review, not a re-typing: operators fill the day as they work, and at EOD the manager clears warnings and closes — clean, or with a noted exception when something's genuinely still out. The month rollup means you read the month in Vision too, not the Summary tab. When this lands, the only reasons left to open that workbook are Fuel and Container Rentals — both monthly, both already have homes — and those are a small, separate finish, not part of the daily grind. After a month of running this alongside the sheet to confirm they match, the daily log goes dark.
