# ADR-0071 — Processor production quota alert (Woodland exception digest)

**Status:** accepted, implemented, shipped DISABLED (2026-07-31)
**Supersedes / amends:** nothing. Reads ADR-0019 bonus data; respects the ADR-0049/0058 single-writer rule; sends through the ADR-0047 `notifyStaff()` chokepoint under ADR-0037 alert policy.

## Context

Bill asked for a processor performance tool. Through the walkthrough it clarified
into something more precise than a dashboard: an **exception alert**. Nobody
watches numbers. The system watches, and speaks up only when a Woodland processor
misses the daily production quota twice or more in a week.

The key reframing was Bill's: the bonus system **already captures per-processor
daily mattress counts**, so this is the same production data seen from a different
angle. It is not a new measurement — it is a reading of an existing one.

## Decision

### 1. Strictly a reader

`bonus_daily_entries` is written by the bonus entry flow; `processed_units_daily`
has a designated sole writer (workbook-sync). This feature writes **neither**. The
only tables it owns are `processor_quota_config`, `processor_quota_recipients` and
`processor_quota_logs`. If an implementation of this feature ever appears to need
a write to production or bonus data, the design is wrong, not the rule.

### 2. "No recorded production" is never a miss

The single most important rule, and the one that decides whether managers trust
the alert. A day off, PTO, or any non-worked day must never be able to flag
someone. `bonus_daily_entries` is unique on `(bonus_employee_id, entry_date)`, so
**the absence of a row is the absence of production** — there is nothing to
interpret.

**Verified against live data (2026-07-31):** of **5,733** entries, exactly **one**
carries a zero count. Keying a `0` is therefore not how a day off is recorded, and
evaluating only days that have a row is safe.

Comparison is **strictly less than**: exactly 75 is MET.

### 3. Flag at 2+ misses in a Monday–Sunday week

A processor who worked one day and was under quota shows one miss and is **not**
flagged — two strikes needs two worked days. The report and the email both say
this in words, so a quiet week reads as "everyone met quota" rather than "the
report is broken".

### 4. Suppression is the feature

**No email when nobody flags.** An "all clear" every Monday trains recipients to
archive it unread, and the one week it says something real is archived with the
rest.

The cost of silence is that "nobody missed twice" and "the cron never ran" look
identical from an inbox. So a suppressed week **still writes a
`processor_quota_logs` row** recording that the week was evaluated and what was
found. This codebase has repeatedly shipped a state meaning _"I didn't run"_
disguised as a state meaning _"fine"_; suppression is the most natural place in
this feature for that to happen again, and the log row is the guard.

### 5. Daily cron for a weekly digest

The scheduler fires **daily** at 06:00 PT. The route reports on the most recent
**complete** Mon–Sun week and is idempotent per `(site, week)` via a unique index.
Monday sends; Tuesday–Sunday are no-ops on the same week.

A weekly single-shot cron gets exactly one chance per week: a redeploy, a
container restart, or a brief M365 outage at 06:00 Monday loses the week silently,
and by the next Monday the flagged week has rolled off. Daily firing self-heals.
The irreversible outcome — mailing three managers twice about named employees — is
blocked **in the database**, not by hoping the clock is right.

### 6. Departed employees: in the report, never in the email

Someone who has left still appears in the weekly report — their production that
week was real and the report is the full floor picture. They are never named in
the email, because the email is a list of conversations to have and you cannot
have one with a former employee.

### 7. Configurable, not literal

`quota_units` (seeded 75) and `min_misses` (seeded 2) live in
`processor_quota_config`; recipients live in `processor_quota_recipients`. Retuning
is not a deploy.

## The finding Bill needs before enabling this

**At a quota of 75, this alert flags 13 of 18 Woodland processors.**

Dry-run against the real week of **2026-07-20 → 2026-07-26**, run read-only
against the live database:

|                                              |                      |
| -------------------------------------------- | -------------------- |
| Woodland processors with recorded production | 18                   |
| Flagged at quota 75 / 2 misses               | **13 (72%)**         |
| Entries under 75 across all history          | 2,421 of 5,733 (42%) |

Sample of what the first digest would say: Eloi Bikoba 5/5 days (46, 56, 66, 60,
53); Zach Cassel 5/5 (35, 35, 38.9, 40, 42); Faisal Mehmood 5/5 (60, 60, 66, 60,
56).

**That is a roster, not an exception list.** The design goal — silence means
everyone met quota, and a name in the inbox means go have a conversation — does
not survive naming 72% of the floor every week. Either 75 is above what the floor
actually runs at, or the quota is aspirational rather than a floor.

This is a decision for Bill, not a bug to fix in code, which is exactly why the
quota is a setting. **The feature therefore ships DISABLED** (`enabled = false`)
with the notification surface at `pilot`, so nothing reaches anyone until the
number is settled. `/admin/processor-quota` is live and accurate immediately and
can be used to try thresholds against real weeks before turning the email on.

Measured on that same week, holding the 2-miss threshold — **lowering the quota
alone does not fix this**:

| Quota | Flagged (of 18) |
| ----- | --------------- |
| 75    | 13              |
| 70    | 13              |
| 65    | 12              |
| 60    | 10              |
| 55    | 10              |
| 50    | 8               |
| 40    | 4               |

Even at **40 units — barely half the stated quota — 4 processors still flag.**
That says the sensitivity is coming as much from the **2-miss threshold on a
5-day week** as from the quota: two sub-quota days out of five is a low bar when
daily output varies. If Bill wants a genuine exception list, the lever to reach
for is probably `min_misses` (3, or "more than half the days worked"), not the
quota alone. Both are settings; neither needs a deploy.

## Consequences

- Managers get a short, specific weekly list with the actual counts, or nothing.
- The quota can be retuned from data without a deploy.
- Per-named-employee performance data exists on exactly one admin-only screen and
  in one admin-gated email. It is on **no** operator or iPad surface, and must not
  be added to one.
- A suppressed week is distinguishable from a dead cron, by query.
- **Not built:** trend history across weeks, per-processor targets, and any link
  to bonus dollars. All three were considered and left out — this is an exception
  alert, and each of them turns it back into the dashboard it was explicitly not
  meant to be.

## Verification

25 tests across `processor-quota.test.ts` (14) and `processor-quota-digest.test.ts`
(11), including the six the handoff named: skip-no-production-days,
exactly-75-is-met, one-worked-day-never-flags, 2-misses-flags, Woodland-only
scoping, zero-suppression.

Every guard was **falsified before being kept** — broken on purpose, observed red,
restored:

| Break                                           | Went red |
| ----------------------------------------------- | -------- |
| `<=` instead of `<` (exactly-75 becomes a miss) | ✅ 2     |
| flag on a single miss                           | ✅ 3     |
| Sunday-based week instead of Monday             | ✅ 4     |
| read the UTC day instead of the Pacific day     | ✅ 1     |
| site scoping dropped from the query             | ✅ 8     |
| departed employees named in the email           | ✅ 1     |
| suppression removed (mails an all-clear)        | ✅ 2     |
| suppressed week leaves no record                | ✅ 1     |
| idempotency removed (double-send)               | ✅ 1     |
| reports the week in progress                    | ✅ 5     |
| employee name not HTML-escaped                  | ✅ 1     |

**A defect caught by verifying rather than assuming:** the recipient seed
initially used `morena.chavez@svdp.us` and `janette.gonzalez@svdp.us`. Both are
wrong — the live roster has `morena.gomez@` and `janette.tomas@`. A guessed
address does not fail loudly; it silently seeds a list missing two of the three
people who need the alert. The seed also now guards on `is_active` and a non-empty
address, because all three recipients **also** hold operator accounts carrying an
empty email (PIN-only floor login) and Bill has a deactivated `operations@svdp.us`.
