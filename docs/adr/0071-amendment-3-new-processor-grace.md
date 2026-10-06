# ADR-0071 Amendment 3 — a new processor is exempt from the quota for 6 weeks

**Status:** Accepted 2026-10-06 (Bill-decided, verbatim: _"if there is a new processor that is first
entered in the system as a brand new staff - they should be exempt from that report for 6 weeks before
they are held to the quota"_).
**Amends:** ADR-0071 (processor production quota alert). Amendments 1 and 2 are untouched.

## Context

The Friday digest names any processor with 3+ sub-quota worked days in the Mon–Fri week. A processor in
their first weeks is still learning the line, so naming them is noise and an unfair conversation to start.

## Decision

- **Grace = 42 days (6 weeks)** from the Pacific day the processor was **first entered in the system**
  (`bonus_employees.created_at`). Days before `entry day + 42` are _excused_; the 42nd day onward is held to
  the quota as before (75, strictly-less-than, no-entry-is-not-a-miss — all unchanged).
- **Excused days are still recorded and shown**, but can never be a miss, so they cannot flag someone or
  count toward `min_misses`. The grace can end mid-week: only days from the cut-over on can count.
- **Anchor is `created_at`, not first entry and not hire date.** There is no hire-date field, and "first
  entered in the system" is exactly what `created_at` records. Verified on production 2026-10-06: every
  processor created since 2026-08 has `created_at` equal to (or one day before) their first daily entry.
  The two bulk imports (2026-06-06 / 06-09, 94 rows) are older than 42 days and are unaffected.
- **A rehire gets no second grace.** Reactivation reuses the same row (ADR-0019 §9a), so `created_at` stays
  old. If a new person is wrongly added late, or a returning person wrongly added as new, the fix is to
  correct the roster entry, not to add an override here.
- **Pacific day.** `created_at` is converted to its Pacific calendar day before adding 42 (same rule as the
  week bounds), so a 6 pm PT entry does not gain a day.
- **Surfaces.** `/admin/processor-quota` shows a "new — held to quota from <date>" badge, un-reds excused
  days and counts misses over countable days only. The digest's "N of M" uses countable days. The digest
  email names no one in grace, by construction (they cannot be flagged).

## Consequences

- No schema change, no migration, no config knob: the 6 weeks is `NEW_PROCESSOR_GRACE_DAYS` in
  `src/lib/bonus/processor-quota.ts`. Make it a `processor_quota_config` column only if Bill wants it
  tunable per site.
- A processor created in advance of their first shift loses that lead time from their 6 weeks. Accepted:
  simpler than a first-entry scan, and matches "first entered in the system".
- Tests: `src/lib/bonus/processor-quota.test.ts` › "new-processor grace" (boundary day 41/42, mid-week
  crossing, Pacific evening creation, rehire, old processor still flagged).
