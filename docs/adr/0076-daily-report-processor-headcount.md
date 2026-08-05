# ADR-0076 — The report counts mattresses; it never counted people

**Status:** Accepted (2026-08-05)
**Related:** ADR-0030 (daily production report), ADR-0019/0019.1/0019.2 (bonus
system), ADR-0023 (historical import), ADR-0032 (reporting-only production
adjustments), ADR-0037 Addendum B4 (daily-close metadata), ADR-0047 (staff-output
rollout gate), ADR-0058 §3.3 (single 8pm send), ADR-0071 (processor quota alert).

## Context

Bill, 2026-08-05: _"the total amount of processors current and the total
historically, similar to how we do the processing numbers — we should have this
data available to harness and use in the system."_ Clarified same day: **worked
that day** (not roster), **same period last month and same day last year yes,
all-time no.**

The 20:00 PT report has always been a units document. It names every processor who
worked and totals their mattresses, but it never says **how many people that was**.
A reader counts table rows, or doesn't.

The data exists and is exact. `bonus_daily_entries` is unique on
`(bonus_employee_id, entry_date)`, so a day's row count _is_ its headcount — no
interpretation, no dedupe. Verified across every production day 2026-07-22 →
08-04: `count(*) === count(distinct bonus_employee_id)`, always.

Two other places claim to hold this number and do not.

`processed_units_daily.employees_count` / `processors_count` were added by ADR-0037
Addendum B4 as workbook daily-close metadata. In production they are **NULL on all
987 rows**, and the table has **zero Eugene rows at all**. Four write paths exist
(manager API, admin API, workbook promotion, the entry clients); none has ever
written a value. `src/lib/cor/prefill.ts` feeds the COR month-end headcount
pre-fill from them, and every cell renders `—` (logged as a follow-up in
OPEN-ITEMS, not bundled here).

`bonus_employees.is_active` is a soft-delete/rehire flag (ADR-0019 §9a), not an
employment feed, and it shows: Woodland carries 40 "active" processors of whom
**8 have not produced in 43–537 days and one never has**. Eugene carries 4, all
current. On the night of 2026-08-04, 19 Woodland processors worked.

## Decision

Add a **Processor Headcount** panel to the daily production report, computed from
`bonus_daily_entries` and nothing else, over the SAME windows the units Trend
block uses:

| line                                                      | window        | Woodland 8/4 | Eugene 8/4 |
| --------------------------------------------------------- | ------------- | ------------ | ---------- |
| Processors today                                          | report day    | 19           | 3          |
| Distinct processors month-to-date                         | Aug 1 – Aug 4 | 21           | 3          |
| Same period last month _(gated by `include_comparisons`)_ | Jul 1 – Jul 4 | 9            | 3          |
| Same day last year _(gated by `include_comparisons`)_     | 2025-08-04    | 12           | 3          |

`today` is `report.lines.length` — already in memory, no query, exact by the
unique constraint. The other three are one
`groupBy(['bonus_employee_id'])` each (measured cost on Woodland, the larger
site: ~21 ms). `groupBy` rather than `findMany({distinct})` because the test
mock discriminates `findMany` calls by the shape of `where.entry_date` — a
distinct variant would silently collide with an existing branch.

**All-time is deliberately absent.** The research recommended it; Bill declined
it same-day ("no not all time"). The comparison rows inherit
`include_comparisons` because they are comparisons; today + MTD always render.

`bonus_daily_report_log` gains **`processors_today`** and **`processors_mtd`** —
nullable, no default (the ~300 rows before this change genuinely did not carry
these figures; a `0` default would assert a false fact about past sends), written
in the existing claim-before-send `create`. This is the "available to harness"
half of the directive, mirroring the `total_today` / `mtd_total` precedent
exactly; comparison windows are not stored, for the same reason the units'
comparisons never were.

No config flag. No new `rollout_surfaces` row — this adds a section to an email
that already ships from a sender on the `no-direct-mail` grandfathered allowlist
(Q-0047-1); recipients, cadence and transport are untouched.

## Options considered

**A — "current" = active roster count (40 Woodland / 4 Eugene).** Rejected on
evidence: 8 of Woodland's 40 actives are 43–537 days idle, one never produced.
Printing "40 processors" beneath a 19-processor day states something false about
staffing, sourced from a flag with no maintenance discipline. Roster hygiene
deserves its own surface; it is not this email's job to leak it.

**B — today + all-time (the literal first reading).** Declined by Bill. All-time
also moves perhaps twice a month — half the content would be inert on a typical
night — and it abandons the "similar to the processing numbers" clause. The
signal lives in the windows: Woodland ran 33 distinct processors across 25
production days in July while any single day ran 8–22; a units total cannot show
that churn, a headcount can.

**C — populate and read `processed_units_daily.processors_count`.** Its
designated sole writer is workbook-sync (ADR-0049/0058); a second writer is the
defect class ADR-0071 warns about, it has no Eugene rows, and it would reconcile
a _typed_ number against a _derived_ one. The payroll source needs no typing.

**D — reuse `computeProcessorQuotaWeek` (ADR-0071).** Hard-bound to a Mon–Sun
week, loads every entry row for per-day miss math, speaks ISO-string dates where
this module speaks UTC-midnight `@db.Date` keys. One is an exception alert, the
other a reported fact; a shared extractor would make them agree by construction
rather than by correctness.

## Consequences

- **Headcount and units are not reconcilable, by design.** ADR-0032 reporting
  adjustments contribute units with no processor attribution (Woodland +1,811
  across 4 rows, Eugene +252 across 1, all June 2026). `mtd.total` includes
  them; `processorCounts.mtd` cannot. The panel carries a footnote saying so;
  the test suite pins it. Anyone who later "fixes" the apparent mismatch will
  break the units total.
- **A processor who worked twenty days counts once** in every window figure.
  This is the point. The distinct-once test was falsified before being trusted
  (grouping by (employee, date) instead of (employee) goes red).
- **History is bounded by the ADR-0023 import horizon** — 2025-01-02 at both
  sites — so same-day-last-year renders real figures from 2026-01-02 onward.
- **`skip_if_zero` is unchanged.** A day whose only entry is `mattress_count = 0`
  (exactly one such row exists in the database) yields `totalToday = 0`,
  `processorsToday = 1`, and stays skipped: a single keyed zero is not a
  report-worthy day, and the 20:00 `bonus-eod-check` ntfy owns missing-data
  alerting. Pinned by a runner test so nobody widens the gate.
- **Three sends inherit the panel automatically** — the scheduled/backfill
  runner, the internal test route, and the admin `[TEST]` send — all route
  through `buildDailyReport` + `sendDailyReport`.
- **Follow-on, out of scope:** the COR month-end headcount pre-fill reads the
  unpopulated `processed_units_daily` columns and renders `—`; the
  `distinctProcessors` helper introduced here could supply it from the payroll
  source. Logged in OPEN-ITEMS.
