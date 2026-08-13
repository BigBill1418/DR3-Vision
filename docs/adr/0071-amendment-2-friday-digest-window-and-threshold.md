# ADR-0071 Amendment 2 — Friday 20:00 PT send, Mon–Fri week, threshold 3+

**Status:** Accepted 2026-08-12 (Bill-decided, batch handoff of the same day).
**Amends:** ADR-0071 (processor production quota alert) and its Amendment 1
(liveness/heartbeat — untouched here).

## Context

Amendment 1 (2026-08-11) made the disabled monitor legible: every config
evaluates and heartbeats; `enabled` gates only sending. What remained were
three operator decisions, made 2026-08-12:

1. The 2-miss threshold made quota-75 flag 13 of 18 processors — a roster,
   not an exception list (OPEN-ITEMS Q-1).
2. A Monday digest about last week arrives after the moment to act on it.
3. Bill had never received the digest at all (`enabled=false` since 07-31).

## Decision

- **Threshold:** flag at **3 or more** sub-75 worked days (majority of a
  5-day week). The 75 bar is unchanged; exactly 75 is MET; **a day with no
  recorded production is never a miss** (unchanged, load-bearing). The
  threshold stays a config column (`min_misses`, Amendment 1); the schema
  default and `DEFAULT_MIN_MISSES` move 2 → 3; live rows are updated by the
  operator (runtime-tunable by design).
- **Schedule:** the digest reports the **current Monday–Friday week** and
  sends **Friday 20:00 PT**. The **daily-fire idempotent design is kept**
  (ADR-0071 §5): the daemon anchor moves 06:00 → 20:00 PT, and
  `latestDueMonFriWeek()` targets the most recent week whose Friday-20:00
  moment has passed — so Saturday/Sunday/Monday ticks still send a missed
  Friday week, then no-op on the `(site, week)` claim.
- **Window arithmetic** reuses the Pacific-day helpers (ADR-0089 lineage);
  no new calendar.

## The data-timing check (D5) — run, not assumed

Reporting Mon–Fri at Friday 20:00 assumes Friday's counts are entered by
then. Measured on live data 2026-08-12: **129 of 129** Friday-dated
`bonus_daily_entries` over the trailing 8 weeks were entered by 20:00 PT
that Friday (zero late; weekday same-day-by-8pm rate 617/642 overall, the
stragglers non-Friday backfills). Mon–Fri ships as specified. If entry
habits change, the threshold and window remain tunable without a deploy.

## Consequences

- Recipients (verified live): morena.gomez@, janette.tomas@,
  **bill.barnard@svdp.us** — present before this amendment; no change.
- Suppression still writes the `processor_quota_logs` row; Amendment 1's
  heartbeat unchanged.
- Migration `20260846_adr0071_a2_min_misses_default_3` changes only the
  column DEFAULT; existing rows are an operator data change (with the
  enable itself) so the numbers stay tunable outside deploys.
