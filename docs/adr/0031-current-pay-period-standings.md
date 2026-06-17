# ADR-0031 — Current pay-period standings (live, in-progress view)

**Status:** Accepted (2026-06-17)
**Related:** ADR-0019 (Bonus Management System), ADR-0019.1 (bi-weekly cadence),
ADR-0019.2 (Eugene enablement), ADR-0023 (historical import / period nomenclature),
ADR-0026 (employee number). Builds on the §8 aggregate views (`aggregates.ts`).

## Context

The Reports area exposes three bonus surfaces. One card, **"Per-employee
history,"** linked to `/bonus/employees` — which is the employee **roster
manager** (add / rename / set-number / deactivate), not a report. It shows no
bonus figures and does not drill into history. The _actual_ cross-period history
page (`/bonus/employee/[id]`) was reachable only from the Annual aggregate page,
and it shows only **closed** periods plus year-to-date.

So an operator clicking "Per-employee history" got a bare employee list with no
data, and nothing anywhere answered the operator's real question: **"where does
each processor stand RIGHT NOW in the open pay period?"** Bonus runs on bi-weekly
pay periods (ADR-0019.1: 26/year, Tue→Mon); the in-progress period
(e.g. Period 13 · Jun 9–22) had no live standings view at all.

Operator ask (Bill, 2026-06-17): a live current-period view per processor —
units so far, days qualified, **days that fell short of the daily minimum**, and
bonus accrued — surfaced both as an all-processor table and on each processor's
detail page.

## Decision

Add a **current pay-period standings** capability, read-only, computed live.

1. **Data layer — `src/lib/bonus/current-period.ts`** (new, isolated). Resolves
   the period covering "today" (Pacific) by the same date-range contract the
   daily grid uses (`period_start ≤ day ≤ period_end`, site-scoped, non-overlap →
   at most one), loads that period's effective `processor_bonus_rules` row, and
   tallies every keyed entry per processor through the shared
   `calculateDailyBonusCents` — so these numbers can never diverge from the daily
   grid or the signed PDF (CLAUDE.md hard rule #3). Two entry points:
   - `currentPeriodStandings(siteId)` → all **active** processors (name-sorted),
     each with `units` / `daysQualified` / `daysShort` / `bonusCents`. A
     processor with no keyed day yet appears at zero, so the full roster is
     visible. Returns a `period: null` state (roster at zero) when today falls
     outside every seeded period.
   - `currentPeriodForEmployee(siteId, employeeId)` → one processor's standing
     via a focused query (the period's entries for that employee only), so it is
     correct for a **since-deactivated** processor too and never loads the whole
     roster. `standing: null` ⇒ no keyed day this period.

2. **"Days short" semantics.** A keyed day whose bonus is `$0` because the
   processor's units did not **exceed** the rule's `threshold_low` minimum
   (Woodland: must beat 50 units/day). Days with **no entry** count on neither
   side, so for any processor `daysQualified + daysShort = days keyed`. The
   threshold is surfaced from the rule, never hardcoded.

3. **Report page — `/bonus/standings`** (new, `force-dynamic`, same
   `tryBonusAccess` gate as the other bonus surfaces; Eugene + Woodland via the
   `?site=` param). Live table — Processor · Units so far · Days qualified · Days
   short · Bonus accrued — with the period label + qualifying minimum in the
   header and a "no open period" empty state. Each row drills into
   `/bonus/employee/[id]`.

4. **Detail-page banner.** `/bonus/employee/[id]` now leads with a **Current pay
   period** banner (the four live metrics, marked _in progress_) above the
   existing YTD + last-12 + history.

5. **Reports card repointed.** The "Per-employee history" card becomes
   **"Current pay period — live standings"** → `/bonus/standings`. The roster
   manager stays reachable from the `/bonus` landing ("Manage Employees"), so
   nothing is orphaned.

## Consequences

- The "Both" surfaces the operator asked for: an all-processor live table and a
  per-processor current-period banner, both fed by one isolated module that
  reuses the canonical calculator.
- Standings list **active** processors only (the working roster); the detail-page
  banner is status-agnostic (focused per-employee query), so a mid-period
  deactivation still shows that period's accrued figures on the detail page.
- New unit tests (`current-period.test.ts`, 8 cases) cover qualified-vs-short
  classification, open-period-only scoping, zero-entry roster inclusion, the
  no-open-period state, site scoping, and the inactive-processor focused query.
  Total suite 917 green; tsc 0; ESLint clean; `next build` ok.

## History-table labels (resolved 2026-06-17)

Initially deferred, then fixed in the same ADR. The cross-period **history**
table on the detail page had labeled each period by calendar month (`monthLabel`,
e.g. "June 2026"), a pre-cadence artifact in `aggregates.ts` — so two bi-weekly
periods inside one calendar month rendered **duplicate** labels.

Fix: a shared `src/lib/bonus/period-label.ts` is now the single source of truth
for the canonical bi-weekly label (`Period 13 · Jun 9–22, 2026`), consumed by the
standings table, the current-period banner, **and** the history table — so all
three read identically. `employeeHistory` now selects `period_number` /
`period_end` and emits `label` (full) + `shortLabel` (`Period 13`, for the trend
bar list). The detail page's stale "month" copy is corrected: "Last 12 months" →
"Last 12 pay periods", "Monthly totals" → "Per-period totals", "Month" column →
"Pay period". A regression test asserts two periods that both start in one
calendar month now carry distinct canonical labels. The `EmployeeMonthTotal.ym`
field is retained as a sort key only (explicitly documented as non-unique — never
a display label). The PDF/email surfaces keep their own `monthLabel` helpers and
are untouched (separate concern).
