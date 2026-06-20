# ADR-0032 — Reporting-only production adjustments, decoupled from bonus math

**Status:** Accepted — shipped to prod (svdp-dev) 2026-06-20, operator decision
2026-06-19 ("Option B").
**Related:** ADR-0019 (Bonus Management System), ADR-0019.1 (bi-weekly cadence),
ADR-0023 (historical import / legacy-formula payout freeze), ADR-0030 (daily
production report), ADR-0031 (current pay-period standings). Builds on the §8
aggregate views (`aggregates.ts`) and the daily-report aggregation
(`daily-report.ts`).

## Context

DR3 launched its production tracking mid-stream. The Woodland **production
totals** that the operator (Bill) reports on paper diverged from what the system
shows, for two reasons:

1. **Missing days.** Three June days (6/4, 6/5, 6/8) had real production that was
   never keyed into `bonus_daily_entries` during the launch ramp.
2. **Paper reconciliation.** Two June days were keyed slightly off the paper
   sheet: 6/1 system base 944 vs paper 940 (−4), 6/2 system base 682 vs paper 695
   (+13).

Net, the Woodland June month-to-date (through 6/18) read **9,067** in the system
but the true paper figure is **10,874** — a **+1,807** gap.

The hard constraint: the pay period **2026-05-26 … 2026-06-08**
(`a540fc56-2434-4c02-94e1-4c8d5ad80477`) is **closed and locked**
(`state = historical_imported`, `imported_with_legacy_formula = true`). Its payout
was computed by the legacy formula and frozen at
`legacy_total_payout_cents = 96475` ($964.75). That number has been paid; it must
**never move**. Several of the corrections above (6/1, 6/2, and the 6/4/6/5/6/8
backfill) fall inside or adjacent to that closed period.

So we must correct the **production-quantity** totals (daily-report MTD and the
annual year-over-year aggregate) to the true paper figures **without changing any
bonus/payout dollar** — the operator explicitly chose this "reporting-only, keep
payroll frozen" path (Option B) over a payroll-recomputing amendment.

A domain fact that motivated the cleanest design: the "Stockton-crew" rows that
appear under Woodland are **legitimate Woodland production** (Stockton staff work
at Woodland; the crew-sheet tag is only provenance). They are NOT to be deleted,
re-homed, or altered. The correction is purely **additive**.

## Decision

Add a dedicated, additive **reporting-only adjustment** layer that production-
quantity read paths sum in, and that **no bonus-dollar read path ever touches.**

### Mechanism — a separate table (`bonus_reporting_adjustments`)

Migration `20260620_bonus_reporting_adjustments`. One signed unit delta per site
per day:

```
bonus_reporting_adjustments(
  id          TEXT PK,
  site_id     TEXT FK → sites(id),
  entry_date  DATE,           -- Pacific calendar day, UTC-midnight @db.Date key
  units       INTEGER,        -- signed (+add / -subtract) whole mattresses
  reason      TEXT,
  created_by  TEXT? FK → users(id) (ON DELETE SET NULL),
  created_at  TIMESTAMP,
  UNIQUE(site_id, entry_date)
)
```

TEXT ids/FKs per the repo convention (ids are generated app-side; FK columns must
match `sites.id` / `users.id`, which are TEXT not UUID). `created_by` is a scalar
FK with no Prisma relation field on `User` (we never navigate user → adjustments).

**Why a separate table, not the lighter-looking alternatives:**

- **Attribute adjustments to a non-bonus "Reporting Adjustment" employee** —
  rejected. The `is_active` flag on `bonus_employees` exists, but the bonus-dollar
  paths (`annualTotals`, `employeeHistory`, `pdf-data`) deliberately include
  inactive/deactivated employees, so they do **not** filter on `is_active`. An
  adjustment employee would therefore leak into bonus dollars. There is no
  existing "counts in production but earns no bonus" separation to lean on.
- **A `reporting_only BOOLEAN` column on `bonus_daily_entries`** — rejected. It
  would force a `WHERE reporting_only = false` onto **every** bonus-dollar query,
  and a single missed query would silently corrupt a payout. High blast radius.
- **A separate table** — chosen. Every bonus-dollar path queries
  `bonus_daily_entries` and **never** this table, so an adjustment is structurally
  incapable of reaching payroll math. Production-quantity paths opt **in**
  explicitly. The read-path wiring is additive-only and the frozen-payout
  invariant holds by construction, not by remembering to filter.

### Invariant

> **Production-QUANTITY read paths INCLUDE adjustments. Every bonus-DOLLAR read
> path EXCLUDES them.**

### Production-quantity read paths wired (the complete set)

1. **Daily report MTD + all comparison windows** — `sumRangeOrNull` in
   `src/lib/bonus/daily-report.ts`. It now sums `bonus_daily_entries` (floored per
   row) **plus** `bonus_reporting_adjustments.units` over the same window. This one
   function feeds MTD, prior-month-same-period, **and same-day-last-year**, so the
   year-over-year comparison the operator needs is covered. Returns null only when
   neither entries nor adjustments exist in the window. The per-line
   `bonusCents` / `totalBonusCents` (bonus dollars) are computed from the entry
   rows only and are untouched. `totalToday` (today's per-employee unit sum) is
   likewise entry-only; only the range comparisons pick up adjustments.

2. **Annual year-over-year production total** — `src/app/bonus/annual/page.tsx`
   `totalMattresses` now adds `annualAdjustmentUnits(siteId, year)` (new helper in
   `aggregates.ts`). `grandTotalCents` (bonus dollars) is explicitly left as the
   sum of per-employee `bonusCents` — adjustments do not touch it.

3. **Annual CSV export** — `src/app/api/bonus/annual/export/route.ts` passes the
   adjustment units to `csvForAnnual(rows, adjustmentUnits)`, which appends a
   single provenance row `"Reporting adjustment (ADR-0032, production-only)"`
   carrying the unit delta in the mattress column with a `0.00` bonus column. The
   CSV's production total matches the on-screen total; bonus dollars stay clean.

### Paths deliberately NOT touched (bonus dollars / per-employee)

- `aggregates.ts` `employeeHistory`, per-employee `annualTotals` rows,
  `csvForAnnual`'s employee rows — bonus math, per employee.
- `pdf-data.ts` (`assemblePdfRows`, `grandTotalCents`) and the bonus-PDF page —
  these are pure/over `bonus_daily_entries`, so they never see the new table.
- `current-period.ts` standings — per-employee per-period bonus standings; a
  daily-total adjustment has no employee to attribute to and must not enter bonus
  accrual.

## Launch-month one-time data load

Five reporting-only adjustments for Woodland
(`de9875a3-a09f-484f-aed1-2891ef544b87`), reason: _"Launch-month backfill:
missing-day production (6/4, 6/5, 6/8) / paper reconciliation (6/1, 6/2);
reporting-only, payroll frozen per operator 2026-06-19."_

| entry_date | units | basis                  |
| ---------- | ----- | ---------------------- |
| 2026-06-01 | −4    | system 944 → paper 940 |
| 2026-06-02 | +13   | system 682 → paper 695 |
| 2026-06-04 | +694  | missing day            |
| 2026-06-05 | +653  | missing day            |
| 2026-06-08 | +451  | missing day            |

Net **+1,807** → Woodland June MTD-through-6/18 **9,067 → 10,874**.

## Consequences

- The frozen closed-period payout (`legacy_total_payout_cents = 96475`) and the
  bonus-PDF grand total are provably unaffected: no bonus-dollar query reads the
  new table. Verified before/after (see CHANGELOG 2026-06-20).
- Production totals now reflect the operator's true paper figures, including the
  year-over-year comparison surface the operator specifically needs for future
  years.
- This is a launch-stabilization layer. Going forward, real production should be
  keyed into `bonus_daily_entries`; adjustments are for reconciliation deltas the
  daily-entry path cannot express (e.g. days that close before keying).
- No UI is added for creating adjustments in this change — they are operator-
  loaded via SQL with provenance in `reason`. A future ADR can add an admin
  surface if the need recurs.

## Failover & Resilience Guard

Pure additive DDL + read-path summation; no change to write paths, the deployer
contract, or the replication topology. The new table replicates like any other.
On the BOS standby (DB-only) it arrives via streaming replication; no app-tier
change there. Migration auto-runs on deploy (`prisma migrate deploy`).
