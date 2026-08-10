# ADR-0088 — Nine days of silence: an instrument that reads the gap

**Status:** Accepted, implemented, born PILOT (2026-08-08). **Ramped LIVE at
Woodland 2026-08-10** (audited flip via `flipRolloutSurface`, actor
`system:throughput-gap-flip`, at Bill's written instruction) after the first
scheduled pass — 2026-08-10 08:30 PT, which found Friday 2026-08-07 unrecorded
and delivered the pilot nudge 1/1 to admins — proved the instrument end to end.
Eugene stays `pilot` by design (no machine; D3 row 4).

**Builds on:** ADR-0079 (throughput is CAPTURED, not derived; D4's prior-day
refusal), ADR-0079 Am.1 (the capture cutover boundary), ADR-0077 D1/D4 (the
machine is resolved from the registry by evidence; "not recorded" is not zero),
ADR-0047 (the `notifyStaff()` chokepoint and born-pilot rollout), ADR-0043 D5
(the per-site, per-day idempotency-ledger pattern), ADR-0037 (notification noise
policy).

**Supersedes:** nothing. This adds a reader for a state ADR-0079 already modelled
correctly.

---

## Context

On 2026-08-08 Bill asked why the Terex sheet had gone unfilled for nine working
days without anyone noticing. The diagnosis is uncomfortable because nothing was
broken.

ADR-0079 got the hard part right. It made "nobody wrote a number down" a
first-class state — the ABSENCE of a row in `equipment_daily_throughput`,
deliberately never a `0` (ADR-0077 D4) — and every consumer honours it. The trend
page drew all nine of those days as `not_recorded`, faithfully, for nine days
running. ADR-0081 then imported the workbook's own history into the same table
without ever letting the sheet overwrite a manager's row.

**The defect is that the honest answer was only ever written down, never said.**
The complete list of detectors for a capture gap in this system, before this ADR,
is: Bill opens the chart and notices. That is not an instrument. It is a person
doing an instrument's job, and it failed for nine working days, which is exactly
how long it takes for a habit to stop being a habit.

The post-cutover surface inherits the identical silence. JT now types the number
into Vision instead of into Excel. If he stops, the page keeps drawing "not
recorded" and keeps telling nobody, and the second incident will look exactly
like the first.

**What is being fixed is not the data model. The data model was already
correct.** What is missing is a reader.

---

## D1 — One question, once a working morning, per site

An internal job (`/api/internal/equipment/throughput-gap`, driven by
`scripts/equipment-throughput-gap-cron.mjs` at 08:30 PT) asks, per site:

> Did the PREVIOUS WORKING DAY get a live throughput row for the machine the
> registry resolves at this site?

If no → one staff email. That is the entire feature.

**The question is about ROW EXISTENCE, never about magnitude.** A recorded day
with `units_processed = 0` is a RECORDED day: the machine ran and produced
nothing, which is a measurement — `assertDailyThroughputShape` admits `0`
explicitly, and ADR-0077 D4 exists to keep it distinguishable from absence. An
implementation that tested `units_processed > 0` would nudge a manager who did
exactly what was asked, which is the fastest available way to lose them. The
query in `throughput-gap.ts` therefore carries **no units predicate at all**, and
a test asserts the shape of the where-clause so the correct outcome cannot be
reached for the wrong reason.

The mirror case: a day whose only row was **soft-voided** counts as MISSING. This
is not a judgement call — ADR-0079's partial unique index (`WHERE voided_at IS
NULL`) already says a voided row does not hold the day's slot, so the day is
genuinely re-enterable and genuinely not recorded. `voided_at: null` in the scan's
where-clause is the same statement the index makes.

---

## D2 — Previous WORKING day, Pacific, minus the site's own holidays

Monday looks back to **Friday**, not Sunday.

A naive "yesterday" makes every Monday scan a Sunday, find nothing (there never
is anything), and alert every single week — an alert that fires on schedule
regardless of the facts, which trains its reader to filter the sender. The walk
steps back one calendar day at a time while the candidate is a weekend or a
holiday.

Weekends are suppressed **twice, on purpose**: as gap days (the walk skips them)
and as run days (a Saturday pass returns immediately). The second is not
redundant. A Saturday pass would look back to Friday, whose entry window only
just closed, and address a nudge to a floor nobody is standing on; Monday's pass
covers Friday anyway. A scan that never runs cannot mis-fire at all.

**Holidays are SITE-scoped here**, deliberately unlike `ap/business-clock.ts`'s
`fleetWideHolidays`. That module is person-scoped under ADR-0066 routing and
pauses only on a holiday BOTH sites observe, because pausing on one site's
holiday would delay an escalation the other site's staff were working through.
This watchdog is site-scoped end to end, so the right calendar is the site's own:
Woodland closed for a California holiday did not fail to record anything.

Holiday suppression is an addition to the brief, which said Mon–Fri. It is
recorded here rather than assumed because it changes behaviour: it can only ever
_suppress_ an alert on a day the floor was closed, never suppress one on a
working day. That is the safe direction, and the precedent already exists —
`bonus/daily-report-runner.ts` skips the daily production report on a site
holiday for the same reason.

All day arithmetic goes through `@/lib/time`. The weekday is read in UTC off the
day KEY, which is correct precisely because of that module's storage invariant (a
business day's UTC components ARE its Pacific components). Re-shifting a day key
through the Pacific zone would move it back a day and turn every Monday into a
Sunday — the exact 2026-06-06 bug `lib/time` was written to end.

---

## D3 — Four things it must never fire on

| Never fires on                                                      | Why                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pre-cutover days** (`< TEREX_CAPTURE_CUTOVER_ISO` = `2026-08-07`) | Before capture began, an absent row is the sheet era, not a gap (ADR-0079 Am.1). The boundary is a stored constant about when the process changed — never derived from the table's contents, or one backfill would re-label history. |
| **Pilot sites** (`equipment_entry` not `live`)                      | That surface gates the screen carrying the daily-capture form. Where it is pilot, only admins can reach the form; nudging a site's managers to fill in a screen they cannot open is a bug wearing an email.                          |
| **Weekends**                                                        | D2, both directions.                                                                                                                                                                                                                 |
| **Sites with no machine**                                           | `resolveSiteThroughputMachine` returns null at Eugene today. Site-DERIVED, never hardcoded (ADR-0077 D1) — a Terex arriving at Eugene tomorrow is picked up with no code change.                                                     |

The nine days of July are **not** back-alerted. The watchdog's job starts at the
first working day after it deploys. Back-alerting would open with a burst of mail
about days nobody can act on, which is how a new alert channel gets muted in its
first week.

---

## D4 — It is a staff nudge (`notifyStaff`), not an ntfy page

This is the decision the brief asked to be made explicitly, so here is the
reasoning rather than the conclusion.

CLAUDE.md hard rule #5: ntfy goes to Bill ONLY and only for SYSTEM-level events;
operational events are in-app / staff signals, never push. A manager who did not
type a number is an operational event about people and process — it is the
paradigm case of what rule #5 excludes. So this rides `notifyStaff()` (CLAUDE.md
rule 12, the ADR-0047 chokepoint) on its own registered surface,
`equipment_throughput_gap`, **born pilot**: on deploy the nudge goes to admins
with the `[PILOT — would have sent to: …]` header, and Bill ramps it per-site
once he has read a few and agrees with both the content and the targeting.

**Its own surface, not `alert_digest`.** The digest fires at 18:00 PT off the
daily-report tick and is a many-findings rollup a manager may reasonably skim.
This is a single, specific, morning ask directed at the one person who types the
number. Bill must be able to ramp the nudge at Woodland — the only site with the
machine — without ramping the digest, and to pull it back without taking the
digest down with it.

**The audience is the existing `alert_recipients` roster** (Morena + Janette at
Woodland, Rick at Eugene): the site managers, which is exactly who types this
number. A second roster table for one nudge would be a second thing to keep
current and a second thing to get wrong.

**The one thing that DOES page** `dr3-vision-system` is the nudge itself failing
to deliver — 0 of N recipients. The alert channel breaking IS a system event; this
is the same carve-out `alert-digest.ts` already makes, on the **same existing
topic**, fingerprinted with a 6-hour cooldown. **No new ntfy topic is created.** A
topic nobody is subscribed to is a silent black hole, which would be a
particularly ironic way to ship a watchdog.

---

## D5 — Severity `default`, and the ADR-0037 gate answered honestly

| #   | Gate question                      | Answer                                                                                              |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Actionable within 5 minutes?       | **No** — see below.                                                                                 |
| 2   | Customer-visible or imminently so? | **No.** An internal capture gap.                                                                    |
| 3   | Has the system tried to self-heal? | Nothing to heal — the input is a person.                                                            |
| 4   | Deduplicated against root cause?   | **Yes, structurally.** One alert per SITE per missed day, keyed in the database. Never per-machine. |
| 5   | Routes somewhere useful?           | **Yes** — tier-1: the site's equipment page, the exact screen carrying the form.                    |

Failing (1) and (2) is what makes this `default`, not `high`. A `high` here is a
phone buzzing about a spreadsheet field, which is how a fleet teaches its operator
to ignore alerts. `default` maps to a staff email at `importance: normal` and no
push.

**The sharp edge inside question 1.** ADR-0079 D4 REFUSES a prior-day entry
outright (`DailyThroughputAmendmentRequiredError`), so the missed day **cannot
simply be typed in** — it routes to the office. An email that only said "please
enter it" would send the manager to a screen that tells them no. The body
therefore says three things and stops: which day was missed, that today's numbers
can still be entered freely, and that the missed day goes through the office. What
is immediately actionable is the habit, not the row — and the habit is what
actually failed for nine days.

---

## D6 — Idempotency is a DATABASE constraint, not a cooldown

`equipment_throughput_gap_alerts`, unique on **(site_id, gap_date)**.

ADR-0037 asks for a ≥24h cooldown. An in-process cooldown (`publishNtfy`'s
fingerprint map) cannot deliver it here: it lives in the app container's memory,
so a restart re-arms it, and it is keyed on wall time rather than on the fact
being reported. Keying the ledger on the **missed day** — not the run day — makes
the guarantee structural: a given working day is nudged exactly once, ever,
regardless of how many times the cron fires, whether a second cron container
exists, or what restarted in between. That is strictly stronger than the policy
floor.

A ledger row is written only after a **real send decision**. An M365-disabled
no-op and an empty recipient set write nothing, so the nudge is still owed once
the operator closes the config gap. This is `alert-digest.ts`'s discipline,
copied deliberately rather than by coincidence.

Verified live against a clean PG16 (2026-08-08): a second insert for the same
(site, gap_date) is refused by
`equipment_throughput_gap_alerts_site_id_gap_date_key`; `notify_mode = 'urgent'`
and `delivered_count > recipient_count` are refused by their CHECK constraints.

---

## Alternatives considered

**Ride the existing 18:00 PT daily-report tick, as ADR-0043 D5 does.** Rejected.
That ADR's binding constraint was "no new container", and it paid for it with a
documented deviation from its own "07:00 PT" requirement. Here the fire time IS
the feature: a nudge about yesterday that arrives at the END of today is useless,
because the only action it enables (enter today's numbers) has already expired.

**A dashboard tile instead of an email.** Rejected as the primary mechanism, and
this is the crux of the whole ADR. A tile is what already existed — the trend page
drew `not_recorded` for nine days. The failure mode of a passive surface is that
somebody has to choose to look at it, and the incident is proof that nobody did. A
tile would be a fine addition; it is not a detector.

**Alert per machine rather than per site.** Rejected — ADR-0037 gate question 4.
`resolveSiteThroughputMachine` returns at most one machine per site by
construction, but the shape matters for the future: a site that one day has two
machines must still produce one email, not two. A test pins the call count so a
"loop over the site's terex-category rows" refactor cannot quietly fan out five
alerts at Woodland (the ADR-0077 D1 finding — production carries five
`terex`-category rows there).

**Back-alert the nine July days.** Rejected — D3.

**Derive the cutover boundary from the first entered day.** Rejected, and it was
already rejected by ADR-0079 Am.1 for the same reason: one manager backfilling
2026-07-15 would flip a month of history out of the legacy era and into "not
recorded", and this watchdog would then email about every day of it.

---

## Consequences

- A new cron container (`dr3-vision-throughput-gap`) on CHAD-HQ. It carries only
  `INTERNAL_CRON_TOKEN` from `cron.env` — the ADR-0053 addendum secret split
  holds; no `NEXTAUTH_SECRET` reaches it.
- `/api/internal/equipment/` joins the middleware exemption list in
  `public-paths.ts`. That list's comment count moves from TEN to ELEVEN. Without
  the exemption the middleware 307s the session-less POST to `/login`, the daemon
  logs a 200 for the login page, and the ledger stays empty — **and an empty
  ledger reads as "no gaps found"**. That would be the original defect reproduced
  inside its own fix, which is why the daemon also uses `redirect: 'manual'`.
- The nudge ships **dark**. Until Bill flips `equipment_throughput_gap` to `live`
  at a site, the mail goes to admins only. This is the ADR-0047 default and it is
  also what lets him read a week of them before any manager does.
- The scan is read-only with respect to every business figure. It writes exactly
  one row, to one ledger table, and can never move a unit, an hour, a bonus or a
  dollar.
- **Not covered, and deliberately so:** this watchdog detects a missing MACHINE
  throughput entry. It says nothing about a missing daily close, a missing
  physical snapshot (ADR-0043's `m1`/`m2` already do), or a manager who enters a
  wrong number rather than no number. Entered-vs-derived cross-checking is
  OPEN-ITEMS F-3 and stays there.
