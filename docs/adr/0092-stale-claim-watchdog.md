# ADR-0092 — A load nobody is working should not need a person to notice it

**Date:** 2026-08-11
**Status:** Accepted, implemented, born PILOT at both sites.
**Builds on:** ADR-0082 (the claim + self-serve takeover), ADR-0091 (the takeover became discoverable), ADR-0088 (the watchdog shape this copies), ADR-0047 (the `notifyStaff()` chokepoint and born-pilot rollout), ADR-0037 (notification noise policy), ADR-0020 (the operations dashboard).
**Amends the framing of:** ADR-0082's "the age of the claim is what carries that."
**Supersedes:** nothing.

---

## Context

On 2026-08-11 a floor operator could not finish a load, and the reason turned out
to be ADR-0091's — the hauls screen called his own load somebody else's. That is
fixed. This ADR is about what the investigation found _next to_ the bug.

Four loads were open on the Woodland dock that morning. One of them, **H-136796**
(Humboldt Waste Management Authority, 117 expected units), had been held by
Janette Tomas since **2026-08-10 17:12 PDT** and was still `in_progress` at
**08:30 PDT the next day — 15.3 hours**. Nothing in the system had noticed. The
only reason it was not a second incident is that nobody needed it yet.

The takeover history says this is routine. **Eleven takeovers exist in
production, and eight of them fired inside one eight-minute window** on
2026-08-10 (08:36–08:44 PDT), one operator sweeping up loads left by two others.
That is a person doing an instrument's job, on a schedule set by when she
happens to look. It worked again on the morning of the 11th: at **09:45:39 PDT**
Janette took over the incident load and submitted it nine seconds later with 102
units.

ADR-0082 built the _mechanism_ to resolve a stranded load, and ADR-0091 made that
mechanism discoverable. Neither built the thing that says _"this load is
stranded."_ That is the gap here — and it is the same shape as ADR-0088's: the
data model was already correct and the honest answer was already written down.
It was only ever read by a human who thought to go look.

---

## D1 — The signal is SILENCE, not claim age

ADR-0082 states the distinction correctly and then names the wrong instrument:

> _"'Open' is not 'stranded' … `in_progress` cannot distinguish a truck being
> unloaded right now from one abandoned at lunch. The age of the claim is what
> carries that."_

Claim age is wrong in both directions, and production supplies a counter-example
for each:

- **False positive.** Early claims are real. H-136147 was claimed at 07:55 PDT on
  2026-08-11 against a **15:00 PDT** appointment. A claim-age detector reports
  that load abandoned at 11:55 while the operator is working it normally.
- **False negative.** A load claimed 20 minutes ago and dropped 19 minutes ago is
  exactly as abandoned as one claimed yesterday. Claim age ranks it the freshest
  thing on the dock.

Pablo's signature on 2026-08-11 was not an old claim — it was **silence after the
last write**: claimed 06:46 PDT, last write 06:48 PDT, then nothing for 70
minutes until it was escalated by phone. Time-since-last-activity is the thing
that was actually true, so that is what this measures.

### The trap inside "last activity"

`inbound_loads.updated_at` alone would have shipped a watchdog that accuses
working operators. **`addStack` creates a `load_stacks` row inside its
transaction and never touches the parent load** (verified in `load-service.ts`),
so `updated_at` _freezes for the entire count_. An operator working a 40-stack
trailer looks idle for as long as the count takes — and that population is the
most likely to be mid-work and the least deserving of being reported abandoned.
Photos are the same story at the other end: the BOL and weight stages write only
`load_photos`, so a stacks-only signal would call the opening twenty minutes of
every load idle.

So the signal is `GREATEST(updated_at, newest non-voided stack, newest photo)`.
Both child sources measurably matter: 21 of 60 claimed loads in production carry
a photo instant _later_ than their own row's `updated_at`.

**The cost, stated plainly.** Taking the maximum means a late offline-queue photo
(ADR-0086 capture-time grants — measured up to **12.8 days** after the row's
`updated_at`) can reset the clock on a genuinely dead load. That is a **miss**,
not a false alarm. It is the deliberate direction: a floor that has just been
told the software was wrong about who held a load will not extend credit to a
watchdog that accuses people mid-count. Quiet-and-occasionally-blind beats
loud-and-occasionally-wrong here, and the in-app badge covers what the mail
misses.

---

## D2 — Two thresholds, sitting in a gap the data actually has

Measured 2026-08-11 over the 58 operator-claimed loads that reached `submitted`:

| population                                        | n   | p50                  | p90    | p99     | max                 |
| ------------------------------------------------- | --- | -------------------- | ------ | ------- | ------------------- |
| submitted the **same** Pacific day it was claimed | 52  | 38 min               | 73 min | 355 min | **511 min (8.5 h)** |
| submitted a **later** Pacific day                 | 6   | **2,980 min (~2 d)** | —      | —       | 5,799 min (~4 d)    |

Healthy dock work **never crosses its own Pacific day**. Every strand is measured
in days. The thresholds sit inside that gap rather than on a boundary the data
argues about:

- **`STALE_BADGE_MS` = 2 h** — in-app only. Past every healthy p90 (73 min),
  short enough that a manager sees it mid-shift.
- **`STALE_NUDGE_MS` = 4 h** — the one that mails. Four hours of _complete
  silence_ is not a slow load, it is a stopped one.

`sites.dock_sla_minutes` (60, `arrived_at → unload_started_at`) is deliberately
**not** reused: it is a compliance-reporting metric for one stage transition
(`compliance.ts` metric 3), not a liveness signal, and overloading it would make
a contractual number move whenever an alerting opinion changed.

---

## D3 — It is a staff nudge and a dashboard panel. It is NOT a page.

The brief asked this to be graded against the fleet ntfy standard. The honest
answer is that the fleet standard routes it away from ntfy entirely.

**CLAUDE.md hard rule #5** settles it by name: ntfy goes to Bill ONLY, for
system-level events, and it lists _"long unloads, SLA breaches"_ as the
operational class that stays in-app. A load somebody claimed and walked away from
is that class exactly. **ADR-0037** reaches the same place independently: _"below
default = dashboard, not notification."_

So the split is:

| surface                              | threshold                   | audience                      | cost                                         |
| ------------------------------------ | --------------------------- | ----------------------------- | -------------------------------------------- |
| **Ops dashboard panel** (primary)    | 2 h                         | site managers, continuously   | nobody is interrupted                        |
| **`notifyStaff()` nudge** (backstop) | 4 h, once daily at 16:45 PT | the `alert_recipients` roster | one mail, only on a day something is stale   |
| **ntfy `dr3-vision-system`**         | —                           | Bill                          | **only** when the nudge reaches 0 recipients |

The dashboard is the primary surface, not a consolation prize: a manager who sees
a load go quiet at 2 h can walk fifty feet and ask, which is the cheapest
resolution available and never becomes an alert at all. The mail exists for the
day nobody opened the dashboard.

**The ntfy carve-out is the alert channel breaking**, which genuinely is a system
event — the same carve-out `alert-digest.ts` and ADR-0088 already make, on the
**same existing topic**, at `priority: high` with a **6-hour** fingerprinted
cooldown. No new topic: a topic nobody is subscribed to is a silent black hole,
which would be an ironic way to ship a watchdog.

### The ADR-0037 five-question gate, answered honestly

| #   | Question                           | Answer                                                                                                             |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Actionable within 5 minutes?       | **Yes** — open the load, Take over, finish it. Unusually, this one passes.                                         |
| 2   | Customer-visible or imminently so? | **No.** Internal floor hygiene. Units are not lost, only unrecorded.                                               |
| 3   | Has the system tried to self-heal? | **N/A by choice** — see D4. Self-serve takeover (ADR-0082) is the heal, performed by a person.                     |
| 4   | Deduplicated against root cause?   | **Yes, structurally.** One mail per SITE per day listing every newly-stale load, and one ledger row per LOAD ever. |
| 5   | Routes somewhere useful?           | **Yes — tier-1.** Every row links to `/operator/<site>/load/<id>`, the exact screen with the Take over button.     |

Failing (2) is what keeps it `default` / `importance: normal`. A phone buzzing
about floor hygiene is how a fleet teaches its operator to ignore alerts.

---

## D4 — No auto-release. Not at any threshold.

The brief left this open and asked for conservatism. The answer is **never**, and
the reason is this week.

An auto-release is the application taking a load away from the person holding it.
The incident on 2026-08-11 was the application being **wrong about who held a
load** and offering him no way back in — and it cost 70 minutes plus an
escalation. An auto-release that fires while an operator is mid-count on a slept
iPad is the same betrayal with a worse blast radius: the operator returns to find
their claim gone, and now they do not trust the count either.

The heal already exists and is now _discoverable_: ADR-0082 built atomic,
audited, self-serve takeover, and ADR-0091 (yesterday) put it on the surface
operators actually use. **This watchdog's entire job is to point at the load; a
person presses the button.** That keeps a human in the loop on every claim
change, keeps `audit_log` honest about who did what, and means the worst failure
mode of this feature is a mail nobody needed — not a lost count.

If auto-release is ever revisited, the precondition is a shift model. The system
does not currently know when a shift ends, and "abandoned" versus "gone to
lunch" is a question about people's hours that the database cannot answer today.

---

## D5 — Idempotency is a DATABASE constraint, keyed on the LOAD

`stale_claim_alerts`, unique on **`load_id`**.

ADR-0037 asks for a cooldown; the brief asked for hours-scale. An in-process
cooldown cannot deliver it — `publishNtfy`'s fingerprint map lives in the app
container's memory, so a restart re-arms it, and it is keyed on wall time rather
than on the fact being reported. Keying the ledger on the **load** makes the
guarantee structural: a given stranded load is reported exactly once, ever,
however many times the cron fires, whether a second cron container exists, or
whatever restarted in between. That is strictly stronger than the policy floor,
and it is what makes the internal route safe to `curl` by hand.

A ledger row is written only after a **real send decision**. An M365-disabled
no-op and an empty recipient set write nothing, so the nudge is still owed once
the operator closes the config gap — `alert-digest.ts`'s discipline, copied
deliberately. A delivery _failure_ **does** write the row (the send decision was
real); the failure itself is what pages.

**The accepted consequence:** a load reported, then worked, then abandoned again
is not mailed a second time. The in-app badge is continuous and always current,
so the second strand is still _visible_; re-mailing about a load somebody already
knows about is the nagging that gets a sender filtered.

---

## D6 — One query, two readers

The dashboard badge and the 16:45 scan both read
`listOpenClaimsWithStaleness()` and filter its verdict. Neither writes its own
query.

This is ADR-0091's lesson applied before the fact rather than after: that
incident happened because two surfaces re-derived the same judgement from their
own code and disagreed, and ADR-0074 Am.1 had already put _identical_ blindness
on both for the same reason. A watchdog whose mail and whose dashboard disagree
about which loads are stale would be worse than neither.

While wiring it, `ops-overview.ts` was found carrying a **byte-for-byte copy** of
`OPEN_DOCK_STATUSES` under a local name (`OPERATOR_ACTIVE_STATUSES`) that was
never imported. It is now the shared constant — the same drift that made
`held-by-panel.tsx` label a `submitted` load "Counting" for five days.

---

## D7 — Robustness to the two parked observations

Both were flagged during the ADR-0091 incident and are deliberately **not**
behaviour-changed here. The question asked was whether this design survives them.

- **`expected_unit_count = 0` on three of four live slots.** Detection is
  **time-only**. `ClaimActivityRow` has no units field at all, the where-clause
  carries no units predicate, and a test asserts both — so there is no division
  and no magnitude gate to go blind through. This matters more than it looks:
  every stranded load has `total_units = NULL` _by definition_ (it was never
  finished), so any detector that reasoned about counts would be blind to its
  entire target population. The mail also never prints a unit figure, because
  rendering an uncounted load as "0 units" would state a measurement where there
  is an absence (the ADR-0077 D4 distinction).
- **Early claims (07:55 PDT claim against a 15:00 PDT appointment).** Handled by
  D1's choice of instrument: an early claim being actively worked is never stale,
  because the work writes. An early claim that sits silent for four hours _is_
  reported — and that is correct, because `startInboundLoad` writes `arrived`,
  so an idle early claim is either a truck that came and stopped or a mis-tap
  that is holding a slot hostage. Both want a manager's eye. The mail says a load
  is quiet, never that anyone did anything wrong.

---

## Alternatives considered

1. **Ride the 18:00 PT alert-digest tick** (no new container). Rejected: 18:00 is
   after the shift, so the one action the mail enables — walk over and close it —
   has expired, and a specific ask buried in a many-findings rollup gets skimmed.
   The fire time is the feature.
2. **Alert on claim age.** Rejected — D1, with a production counter-example in
   each direction.
3. **Auto-release at a long threshold.** Rejected — D4.
4. **A new ntfy topic for stale claims.** Rejected — hard rule #5, ADR-0037, and
   the black-hole problem.
5. **One mail per stale load.** Rejected — fails ADR-0037 gate #4. Three strands
   would produce three mails on the same underlying fact.

---

## Consequences

- A stranded load is visible in-app within 2 h and mailed within a day, instead
  of waiting for somebody to sweep by hand.
- The manual reaping burst becomes measurable: the ledger records what was
  reported, when, at what idle time, and to how many recipients.
- Born **pilot** at both sites (ADR-0047). On deploy the nudge goes to admins
  with the `[PILOT — would have sent to: …]` header; Bill ramps per-site from
  `/admin/rollout` once he agrees with the content _and_ the targeting.
- Two cron daemons that were never covered by the DST regression test now are —
  `equipment-throughput-gap-cron` (ADR-0088, which shipped carrying its own
  untested copy of the offset-reprobe helper) and this one.

### Residual risk

- **The late-photo miss (D1)** is real and unbounded: a trickled offline upload
  can silence the watchdog on a dead load. Accepted deliberately; the badge
  still shows it.
- **A load stranded at 09:00 waits until 16:45** for the mail. The badge covers
  the interval, but there is exactly one fire per day. If the badge turns out not
  to be read, a second midday fire is the obvious next iteration.
- **A load that goes quiet at 15:00** is under 4 h at the 16:45 fire and is not
  mailed that day, so it sits overnight and is caught at 16:45 the _next_ day.
  The clean fix is an end-of-shift "everything still open" sweep, which needs a
  shift model the system does not have (D4).
- **Nothing here prevents a claim being abandoned.** This is a reader, not a cure
  — the same honest limit ADR-0088 states about its own subject.
- **The thresholds rest on 58 loads.** That is the whole production history of
  operator-claimed dock work, not a sample chosen for convenience, but it is
  still 58. They should be re-derived once there are a few hundred.
