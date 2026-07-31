# 2026-07-30 — Processor production quota alert (Woodland, exception-based email)

**Session context (Bill × Claude, 2026-07-30):**

Bill wants a processor performance tool. Through the walkthrough it clarified into something more precise than a dashboard: an **exception alert**, not a monitored board. Nobody watches numbers; the system watches and speaks up only when a Woodland processor misses the production quota twice or more in a week.

**Key reframing:** Bill's insight earlier in the session — the bonus system already captures per-processor daily mattress counts, so this is **the same production data in a different place**. The monitor **reads from the bonus data**; it does not re-enter or mirror it. This matters because the codebase enforces that `workbook-sync` is the sole writer of `processed_units_daily` and rejects a second writer — so this feature is strictly a **reader** of existing per-processor counts, never a writer to production tables.

**All decisions locked with Bill:**

- **Quota:** 75 units/day minimum, **uniform** across all Woodland processors. Configurable setting, seeded at 75 — retunable without a code change after watching real data.
- **Miss definition:** a day with **recorded production** below 75. Days with **no recorded production are skipped entirely** — never a miss. PTO, days off, and non-worked days cannot trigger a flag.
- **Trigger:** **2 or more misses** in a single week (Monday–Sunday).
- **Delivery:** **one end-of-week digest** email listing each flagged processor with their miss days and the actual counts. Suppressed if nobody hit two misses.
- **Recipients:** Bill, Morena, Janette.
- **Scope:** **Woodland processing staff only.**
- **Surface:** its own report under Reports, **separate from the daily production report**. Management/admin-only.

## §1 — Data source

Read per-processor daily production from the **bonus system's** existing per-employee daily counts (the same data feeding the daily bonus entry — verify the exact table during build; likely the bonus daily-entry rows that carry employee + mattress count + date + site).

**This feature is read-only against that data.** It does not write to `processed_units_daily`, does not write to the bonus tables, does not introduce a second writer anywhere. If the natural implementation seems to require writing production data, stop — that is the single-writer rule (ADR-0058 lineage) and the design is wrong.

Per-processor, per-day, Woodland only. A "processor" here is any Woodland employee with recorded production in the bonus data; confirm whether a role/flag distinguishes processors from other bonus-eligible staff, and scope to processors if so.

## §2 — Miss + flag logic

For each Woodland processor, for the Monday–Sunday week:

```
for each day in the week:
    if the processor has NO recorded production that day → SKIP (not a miss, not counted)
    else if recorded units < quota (75) → MISS (record the day + the actual count)
    else → met

if miss_count >= 2 → FLAG the processor for this week
```

- **Only recorded-production days are evaluated.** A processor who logs production 5 days and is under 75 on two of them → flagged. A processor who worked one day under 75 → one miss, not flagged (two-strikes needs two worked days). Name this explicitly in the report copy so a one-day week staying quiet is understood, not seen as a gap.
- Quota comparison is **strictly less than** 75 = miss; exactly 75 = met.
- The quota value comes from a **configurable setting** (default 75), not a literal.

## §3 — The email digest

Fires **once at end of week** (Sunday night / Monday early AM — align with existing cron cadence; a Monday 06:00 PT send pairs naturally with the existing digest infrastructure but keep it a **separate email** from the AP digest and the daily production report).

- **Recipients:** Bill, Morena, Janette. A configurable recipient list, seeded with these three, is preferable to hardcoding.
- **Content per flagged processor:** name, number of misses, and **each miss day with its actual count** — e.g. "Tuesday 62, Thursday 48." The actual numbers matter: they let the managers walk into the conversation knowing whether it's a slow slide or two bad days, rather than just "missed twice."
- **Suppressed entirely** when no processor hit two misses. No empty "all clear" email — silence means everyone met quota (consistent with the AP digest zero-suppression pattern).
- Woodland only. Even though recipients include no Eugene managers, the query itself must be Woodland-scoped so Eugene processors never appear.
- Send through `notifyStaff()` (ADR-0047 chokepoint), respecting whatever rollout gate is appropriate; email primary.

## §4 — The report surface

Under **Reports**, its own entry, **separate from the daily production report** (Bill was explicit — not a block on the existing report).

- **Management/admin-only** — never visible to floor staff. This is per-named-processor performance data; it does not appear on any operator or iPad surface.
- Shows, for a selectable week: each Woodland processor, their recorded-production days, daily counts, misses highlighted, and flag status.
- Default view is the current or just-completed week; allow selecting prior weeks.
- This is the detail behind the alert — the email says who flagged, the report shows the underlying daily numbers for the whole floor.

## §5 — Actions for Claude Code

1. Confirm the bonus per-processor daily-count table and how it identifies Woodland processors. **Read-only** — no writes to production or bonus tables.
2. Quota setting (default 75), configurable via admin settings.
3. Miss/flag computation per §2 — recorded-production days only, <75 = miss, ≥2 misses = flag, Monday–Sunday week, Woodland-scoped.
4. End-of-week digest per §3 — flagged processors with miss days + actual counts, suppressed when empty, recipients configurable (seed Bill/Morena/Janette), via `notifyStaff()`, separate from all existing emails.
5. Report surface under Reports per §4 — admin/management-only, weekly, separate from the daily production report.
6. Tests: skip-no-production-days, exactly-75-is-met, one-worked-day-never-flags, 2-misses-flags, Woodland-only scoping, zero-suppression on the email.

**Do NOT:**

- Do NOT write to `processed_units_daily` or any bonus table. Read-only.
- Do NOT count no-production days as misses.
- Do NOT surface any per-processor number on a floor/operator/iPad screen.
- Do NOT merge this into the daily production report or the AP digest — separate report, separate email.
- Do NOT hardcode the quota or the recipient list.

## §6 — Success criteria

- A Woodland processor under 75 on 2+ recorded-production days in a Mon–Sun week appears in that week's email to Bill/Morena/Janette, with each miss day and its count.
- A processor with days off, or a single sub-75 worked day, does not flag.
- No email sends in a week where nobody missed twice.
- The Reports surface shows the weekly per-processor detail, admin-only.
- Quota (75) and recipients are settings, not literals.
- Nothing writes to production or bonus tables; Eugene never appears.

## §7 — For Bill

Quota is seeded at 75 and tunable — watch the first couple of weeks of real digests and adjust if 75 is catching people it shouldn't or missing people it should. The report surface is there when you want the full floor picture behind any given week's alert.
