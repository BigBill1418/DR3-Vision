# 2026-08-07 — Terex processing is CAPTURED daily by a manager, not derived from the floor

**Session context (Bill × Claude, 2026-08-07):**

Bill flagged that Terex units-processed tracking is wrong. On examination the number *exists* but is **derived floor-wide, not captured per-machine** — and that is the defect. Bill's requirement, verbatim in intent: *"we have to have the manager able to enter the terex processing numbers daily to populate the data — remember we are replacing the sheet."*

The current Terex throughput (ADR-0044) is **derived** from the daily processed-units close as `stripped_program + stripped_non_program` — i.e. **everything the floor stripped that day, attributed to the Terex**. The ADR's own reasoning: *"throughput needs NO new capture — it is DERIVED from the daily processed-units close."* That was a clever shortcut and it is the wrong model:

1. It cannot distinguish the Terex from hand-stripping or any second machine — it is the whole floor's output wearing the Terex's name.
2. It does not replace the sheet. The sheet had an **authoritative, manager-entered Terex number**, daily. Vision must have the same.
3. Units-per-run-hour today uses an **assumed 8-hour day** (`assumed_day_hours`, a labeled module constant in `src/lib/equipment/throughput.ts`) — a guess, not the machine's real hours.

**Decisions locked with Bill:**

- **Manager enters daily: units processed + run hours.** Real run hours make units-per-hour real instead of assumed — the primary reason to capture rather than derive.
- **Entered REPLACES derived** as the throughput source. The tile reads the manager's entered Terex number as truth, not the floor-wide proxy.
- **Amendment rules match bonus:** same-day the manager enters/edits freely; a **prior-day change requires justification** through the amendment workflow. This is the third surface to inherit that pattern (bonus counts, saves, now Terex daily) — correct, because throughput feeds the compliance/management picture.

**Relationship to PR #205:** separate, independent handoff. #205 is the five-phase floor/iPad build. This is a manager office-surface capture change. No dependency either direction, though both touch the "amendment workflow as house pattern" theme.

**Standing instruction:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` first, and **verify the schema shape against live code before building** (§1) — do not assume the equipment-event table can carry a daily units+hours record; confirm it.

---

## §1 — Schema: confirm before building

The equipment system (ADR-0044) has `equipment_events` (a capture table: downtime/maintenance/repair/cost/notes, `event_date`, `hours_down`, `cost_cents`, audit-actor columns, `voided_at`/`voided_by`, soft-void, no `locked_at`) and a manager route `/api/manager/[site]/equipment` (`requireManagerForSite`; GET lists events or `?view=throughput`; POST creates; PATCH edits; DELETE soft-voids).

**Claude Code must first determine the cleanest home for a daily units+hours record** and report the choice before building:

- **Option A — extend `equipment_events`** with a `daily_throughput` event kind carrying `units_processed` (int) + `run_hours` (Decimal). Fits the existing surface, route, audit, and soft-void with least new surface area. Watch: `assertEquipmentShape` currently validates kinds and ranges — a new kind must be added to it, not bypassed. Program/non-program split is NOT required (Bill chose units + run hours; a single units total).
- **Option B — a small dedicated `terex_daily_throughput` table** (`site_id`, `equipment_id`, `throughput_date`, `units_processed`, `run_hours`, audit-actor cols, `voided_at`/`voided_by`, unique on `(equipment_id, throughput_date)`) if mixing a recurring daily metric into the event log muddies the maintenance-event semantics.

Prefer A if it fits cleanly (reuses everything); choose B if the daily-metric semantics genuinely conflict with maintenance-event semantics. **Report the decision and why.** Either way: additive migration, clean-replay, CI gate, unique on (equipment, day) so a day cannot be double-entered.

This is `terex`-category equipment scoped, but build it general enough that another machine could use it later — do not hardcode the single Terex id; scope by the equipment record (the canonical Terex is `7e35a4aa` per ADR-0077, but reference it by row, not literal).

## §2 — The manager daily-entry surface

On the existing manager equipment surface (`/dashboard/[site]/equipment`, English-first office surface, green/black, `onClick` not `<form>` per hard rule #10):

- A **daily entry row/control** for the Terex: date (defaults to current **Pacific** day via the existing `currentPacificDayWindow`/`assertCurrentPacificDay` guards — not UTC, not device clock), **units processed**, **run hours**.
- Manager-scoped (`requireManagerForSite`), server-validated: units a non-negative int within a sane max; run hours `> 0` and within a sane max (e.g. `.positive().max(24)` — a machine cannot run more than 24h in a day; validate, don't assume).
- Written inside an audited transaction with the actor's real id (never a system/borrowed id — the ADR-0036 `actor_label` discipline and the "no false claim" hard rule apply).
- One entry per (equipment, day) — the unique index makes a second same-day entry an **edit**, not a duplicate.

## §3 — Amendment rules (same as bonus)

- **Same-day:** the manager enters and freely edits today's Terex numbers on the surface. Audited (edit writes an audit row; history survives; no hard delete — soft-void per hard rule #6).
- **Prior-day:** a change to a past day **requires justification**, routed through the **existing bonus amendment workflow pattern** (`409 requires_amendment` → justification ≥ the established minimum length → the batch/justification path). Do **not** build a parallel prior-day edit path; reuse the amendment mechanism the bonus grid already uses (`/api/bonus/amendments` lineage, `RequestEditModal`/batch flow) or the equivalent generalized surface if one now exists. If the amendment workflow is currently bonus-specific and cannot be cleanly reused for equipment, **report that as a finding** and propose the smallest generalization rather than forking it.
- **"Today" is Pacific**, consistent everywhere.

## §4 — Entered replaces derived (the throughput cutover)

This is the core behavioral change and it must be done carefully because a number on a compliance-adjacent tile is changing its source.

- `src/lib/equipment/throughput.ts` currently computes units/day as `stripped_program + stripped_non_program` (floor-wide) and units/run-hour via `assumed_day_hours − hours_down` (the 8h assumption).
- **After this change:** for the Terex, units/day reads the **manager-entered `units_processed`**, and units/run-hour uses the **entered `run_hours`** (not the 8h constant, not `assumed_day_hours − hours_down`).
- **Days with no manager entry:** show the gap **honestly** — render "not recorded" (neutral tone), **do NOT silently fall back to the derived floor number and do NOT render 0**. This is the exact "not recorded ≠ zero" discipline established by ADR-0077 (downtime) and the null-throughput handling already in this module (`7/30-day rolling means, null days skipped, never counted as zero`). A missing day is missing, not a zero, and not a floor-wide guess wearing the Terex's name. The 7/30-day rolling means skip null days (already the behavior — preserve it).
- The `assumed_day_hours` 8h constant becomes a **fallback for days without entered run-hours only if a units figure somehow exists without hours** — but with manager entry capturing both together, the assumption should no longer be the live path. Leave the constant labeled and documented as legacy/fallback; do not delete blindly if other code references it — verify references first.
- **Tile (`src/lib/equipment/tile.ts`)** and the `?view=throughput` series both read the entered source. Verify the site-dashboard Terex throughput tile (7- & 30-day units/day) now reflects entered numbers.

**Reconciliation opportunity (do NOT auto-act, just surface):** because the derived floor number still exists, entered-vs-derived can be shown side by side or as a flag when they diverge wildly — a manager entering 40 Terex units on a day the floor stripped 400 is either a light Terex day or a data error. **For v1, do not build divergence rules** (that is Layer-3/reconciliation territory, and the reconciliation logic is blocked on Kelsey's method) — but leave the derived number computable so a future cross-check can use it. Entered is truth; derived is retained as a latent cross-check, not shown as a competing number.

## §5 — Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS on main. **Confirm the schema choice (§1 A vs B) against live code and report it before building.**
2. Migration (additive, clean-replay, CI gate, unique on (equipment, day)).
3. Manager daily-entry surface (§2) — units + run hours, Pacific day, manager-scoped, audited, real actor id.
4. Amendment rules (§3) — same-day free, prior-day via the existing amendment workflow; if that workflow can't be cleanly reused for equipment, report and propose the minimal generalization.
5. Throughput cutover (§4) — entered replaces derived for the Terex; missing day = "not recorded", never 0, never a silent floor-fallback; run-hours real, not assumed; tile + series read the entered source; retain derived as a latent cross-check.
6. Tests: entered number drives the tile; a missing day renders "not recorded" (falsify: assert it is NOT 0 and NOT the derived floor number); run-hours drives units/run-hour (not the 8h constant); same-day edit is audited; prior-day edit requires justification; (equipment, day) uniqueness rejects a double-entry; rolling means still skip null days.
7. Adversarial review, then PR → CI → merge → deploy → verify live. Tag Bill with the schema decision, a screenshot/db-proof of an entered day driving the tile, and the "missing day = not recorded" evidence.

**Do NOT:**
- Do NOT keep deriving Terex throughput from the floor-wide stripped total once entry exists — entered is the source.
- Do NOT render a missing day as 0 or silently fall back to the derived floor number — "not recorded", neutral.
- Do NOT use the 8h `assumed_day_hours` assumption when real run-hours are entered.
- Do NOT build a parallel prior-day edit path — reuse the bonus amendment workflow (or report why it can't be reused).
- Do NOT hardcode the single Terex id — scope by equipment row.
- Do NOT write a system/borrowed actor id on a manager entry — real actor, audited.
- Do NOT build entered-vs-derived divergence *rules* in v1 — retain derived as a latent cross-check only.

## §6 — Success criteria

- A Woodland manager enters the Terex's daily units processed + run hours on the equipment surface; the throughput tile reflects the entered number, not the floor-wide derived one.
- Units-per-run-hour uses the entered run hours, not the 8h assumption.
- A day with no entry shows "not recorded" — never 0, never the derived floor number.
- Same-day edits are free and audited; prior-day edits require justification via the amendment workflow.
- (equipment, day) is unique; a second same-day entry edits rather than duplicates.
- The derived floor number remains computable as a latent cross-check but is no longer the displayed Terex throughput.

## §7 — For Bill

This replaces the sheet's Terex column with a real Vision entry, and it fixes something the derived model couldn't: run-hours are now real, so units-per-hour finally means what it says instead of assuming an 8-hour day. The one visible change to watch when it's live: on a day nobody's entered yet, the tile will say "not recorded" rather than showing a number — that's deliberate, so a blank day can never be mistaken for a real low, the same way the downtime fix works. If you later want Vision to flag when the entered Terex number diverges hard from the floor's total (a possible data-entry check), that's a fast follow — the derived number is kept around exactly so that cross-check is buildable, but it needs a rule and that's reconciliation-layer work.
