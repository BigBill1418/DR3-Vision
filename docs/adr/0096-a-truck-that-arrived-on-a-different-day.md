# ADR-0096 — A truck that arrived on a different day

**Date:** 2026-08-11 (incident) / 2026-08-12 (shipped)
**Status:** Accepted, implemented.
**Closes:** the ADR-0074 Am.1 open decision — the day bound is now enforced server-side.
**Builds on:** ADR-0074 D5 + Am.1 (the current-Pacific-day check-in bound), ADR-0091 (a consumed slot is a route), ADR-0094 §P2 (which prescribed this shape), the floor dead-end inventory D-1/D-8.
**Deliberately does NOT do:** widen the D5 day bound.

---

## Context

2026-08-11, 5:18 PM PT. Bill:

> _"Trying to access speedy delivery H-136980. But it won't let us. We are
> clicking it and it does nothing. What is happening here."_

The slot: **H-136980**, Speedy Delivery LLC – Union City, Woodland, booked
**2026-08-10 09:00 AM PT**. Not cancelled. **No child load row** — nobody had
checked it in. The truck turned up on the 11th.

Both check-in surfaces are bounded to the **current Pacific day** (ADR-0074 D5).
So in `portal-hauls.ts` the sibling verdict came out `startableExpectedLoadId:
null` (not today) **and** `consumedLoad: null` (no child), and the card fell
through every branch in `hauls-client.tsx` to the last one — a read-only "View
only" note with **no control attached**. The Queue, bounded on the same column,
never showed it at all.

Tapping it genuinely did nothing. There was no error, because nothing was
attempted.

**This was not a regression from ADR-0091.** That work changed only the branches
for slots that already _have_ a child row; H-136980 had none and never reached
them. It is the pre-existing day-bound branch — the same _family_ of dead-end
card, a different branch. Recorded plainly because the alternative reading
(Monday's fix broke it) is wrong and would send the next reader to the wrong
code.

**Immediate unblock (17:25 PT):** `expected_arrival_at` shifted +1 day into the
current window. Janette checked in at **5:37 PM PT** and the load reached
`submitted`. That was a stopgap with a known short half-life — the MyMRC scrape
re-syncs the field from the portal, which still says 8/10 — and this ADR is the
durable answer.

---

## D1 — The signal is a _named divergence_, not a wider bound

ADR-0094 §P2 is explicit, and this ADR follows it to the letter:

> _"do not simply widen the ADR-0074 D5 day bound. That bound exists to stop a
> child load being minted onto the wrong slot, and removing it re-arms the
> 159-unit mis-booking of ADR-0074 Am.1."_

So `startableExpectedLoadId` keeps its exact meaning — **live, unconsumed, and
due today** — and the divergent case gets its own field,
`reconcilableExpectedLoadId`, plus the slot's own `slotDayISO`. The two are
mutually exclusive by construction, and a test asserts it.

The temptation to widen is real: it is one boolean and the card lights up. What
it also does is make every past slot at the site a one-tap target, which is
precisely how a truck gets booked against the wrong appointment.

**Undated slots are excluded on purpose.** 3,316 mirror rows carry no docking
date. A slot with no day gives the operator nothing to confirm and the server
nothing to compare, so the acknowledgement below could not be made
evidence-bearing. Those rows stay read-only — an honest terminal state rather
than a control that cannot be verified.

---

## D2 — The exception is an ACKNOWLEDGEMENT, not a flag

The operator confirms the slot's own scheduled day; that day travels to the
server; `startInboundLoad` refuses unless it **matches the row**.

A boolean `allowAnyDay: true` would close nothing — a stale client passes it as
happily as a correct one. Naming the day means a caller that has not actually
_read_ this slot cannot produce the value. That is what turns the exception into
evidence that the operator was looking at the truck they are reconciling, rather
than a permission the UI granted itself.

The comparison happens **inside the same transaction that writes**, against the
row, using the same client that mints the load. `acknowledgedSlotDayISO` is never
trusted as an authorization token; operator, site and load id all still come from
the session via `ctx()`.

Refusals are named, not generic: `expected_load_not_due_today`,
`slot_day_mismatch`, `expected_load_undated` — because audit finding D-8 is the
standing lesson that an unmapped reason code is a silent no-op on the floor.

---

## D3 — The day guard now exists server-side. It did not before.

This is the part that matters beyond one truck.

`startInboundLoad` performed **no day check at all**. The entire D5 bound lived
in the two read layers. ADR-0074 Am.1 recorded that as an open decision for Bill;
ADR-0094 confirmed it was still open (_"`assertCurrentPacificDay` still does not
exist in `src/lib/load-service.ts`"_). So a bookmarked page, a replayed POST, a
tab left open across midnight, or a hand-written call could mint a child load
onto **any** slot at the site, of any age — going around the very guard that was
protecting against mis-booking.

It is now enforced where the write happens. **In Pacific, never UTC**: after 5 PM
PDT the UTC day has already rolled, so a UTC comparison would refuse today's own
slots for the last seven hours of every Pacific day — the whole evening shift,
including the 5:25 PM PT moment this was written in. A test pins that.

---

## D4 — Two taps, and the second one reads the slot back

The ordinary check-in is one big tap target, because for a truck due today the
only sane action is to start it. This state is different: the slot about to be
consumed is booked for another day, and consuming the wrong one is the defect D1
protects against. So the control expands in place and the second tap names both
identifying facts — **the haul number and the day it was booked for**.

That friction is deliberate and it mirrors the server: the UI is where the
operator _reads_ the day, the server is where the day is _checked_. Neither alone
would be enough, which is exactly how a UI-only bound came to be bypassable.

Not `window.confirm`: unstyled, unlocalised, and on iPadOS dismissible in ways
that give no signal back (dead-end inventory D-20 records a live case). This
expands inline, in all three locales, at ADR-0060 gloved-hand sizing.

---

## D5 — A refused tap now says so (D-8's lesson, applied to a guard I added)

`QueueRow` was `await startLoadAction(...)` with nothing around it. That was
survivable only because the action could not really refuse — any row that
rendered a button was startable by construction. **Adding a server-side guard
created a refusal that component could receive**, and an unhandled throw there is
the exact shape of D-8: the tap does nothing, no sentence appears, the operator
taps again.

So the one refusal a correctly-rendered page can still hit — rendered before
Pacific midnight, tapped after it — is named, with the reload that fixes it.
`NEXT_REDIRECT` is re-thrown in both new catches; swallowing it would report every
successful check-in as a failure, which is the inverse defect and worse.

**Also in this change (audit D-8 proper):** the online `date_not_today` refusal
was a true silent no-op on all four floor write clients while the translated
sentence sat wired only into the offline replay path. All four now classify it —
and 401 — through one shared `classifyWriteRefusal` chokepoint, reusing the
existing `floor.conflicts.why_wrong_day` and `auth_login.error_session_expired`
strings. `dropoff-client.tsx` never parsed the response body at all; it does now.

The forward control is a **reload**, not "Re-submit to today": that string
interpolates a day the client cannot know without reading the iPad's own clock,
which is the mistake D-23 is the standing finding for.

---

## Alternatives considered

1. **Widen D5 to any day.** Rejected — D1; ADR-0094 §P2 names it as the thing not
   to do.
2. **Let the office re-date the slot** (what was done by hand at 17:25 PT).
   Rejected as the durable answer: it needs an admin at 5 PM, it writes a
   _scheduling_ field to express an _arrival_ fact (the ADR-0089 confusion), and
   the MyMRC scrape reverts it.
3. **Auto-detect "the truck is obviously here" and start it.** Rejected — the
   system has no signal for a truck being present; the operator IS the signal.
4. **A boolean override flag.** Rejected — D2.
5. **Extend `startLoadAction` with an optional day instead of a second action.**
   Rejected: the ordinary path should not carry a parameter that relaxes its own
   guard. A separate, differently-named action keeps the exception greppable.

---

## Consequences

- A truck that arrives on a day other than its booked one is workable from the
  floor, in two taps, without an admin and without a data edit.
- The D5 bound is now enforced in the layer that writes, closing an open decision
  from ADR-0074 Am.1 that had survived two ADRs.
- Early arrivals are covered by the same path — 2026-08-11's H-136147 was claimed
  at 07:55 PT against a 15:00 PT slot, which is the same divergence with the sign
  flipped. A test pins it.
- Every reconciled start is answerable: the audit row carries
  `reconciled_from_day` / `reconciled_on_day`, present only when the days differ,
  so the key's presence is itself the signal.

### Residual risk

- **The acknowledgement proves the DAY, not the SLOT.** Two slots for the same
  source on the same past day are not disambiguated by it. The UI names the haul
  number as well, but the server only checks the day. Narrowing that would mean
  acknowledging the haul id too — deliberately not done here, because it doubles
  the confirm text for a case not yet observed.
- **Nothing prevents the divergence.** This makes the state workable; it does not
  stop MyMRC and the dock disagreeing about the day, which is the underlying
  condition and is ADR-0094's §4 inventory to work through.
- **The reconcile is not rate-limited or manager-gated.** Any floor operator can
  do it. That matches the ADR-0082 posture (a stranded load is a floor problem to
  fix, not a manager escalation), but it is a widening of what the floor can do
  and should be watched.
- **`slotDayISO` is rendered from a `YYYY-MM-DD` string re-parsed at noon UTC**
  for display. That is safe for a calendar day but is a second place a day is
  formatted; the Pacific-pinned `formatDate` still owns the formatting.
- **The undated exclusion means some real trucks stay dead-ended.** A slot MyMRC
  never dated cannot be reconciled, and 3,316 mirror rows are undated. That is a
  known, named terminal state rather than a silent one — but it is not fixed.
