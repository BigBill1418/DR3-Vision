# ADR-0091 — A consumed slot is a route back in, not an epitaph

**Date:** 2026-08-11
**Status:** Accepted
**Supersedes:** nothing. **Amends:** ADR-0074 Amendment 1 (the consumed-slot card).
**Related:** ADR-0082 (claim + self-serve takeover), ADR-0065 Am.1 (the unfinished-work block).

## Context

At about 07:50 PDT on 2026-08-11, Woodland floor operator **Pablo Ledezma**
reported that he could not finish the **Costco-Innovel-Sacramento** load. The app,
he said, told him it had been *"started by another operator."*

It had not been. He started it himself.

### What the production data says

`inbound_loads.c1649119-7a21-4f49-9282-9c65426df4a1`, the child of expected slot
`94a65e35…` (**H-136311**, Costco-Innovel-Sacramento, appointment 07:00 PDT):

| field | value |
|---|---|
| `status` | `in_progress` |
| `assigned_operator_id` | `2a461884…` = **Pablo Ledezma** |
| `assigned_at` / `arrived_at` | 2026-08-11 **06:46 PDT** |
| `unload_started_at` | 2026-08-11 **06:48 PDT** |
| `total_units` | NULL — nothing counted |
| `load_stacks` | 0 rows |

His last successful write was **06:48:24 PDT**. `audit_log` and
`idempotency_keys` then go silent for him until the escalation — no 4xx, no 5xx,
no failed idempotent replay. **Nothing rejected him.** That is the shape of a
missing affordance, not a failing guard.

There is exactly one Pablo Ledezma row in `users`. No duplicate account, no
session mixup, no orphaned claim.

### The mechanism

ADR-0074 Amendment 1 (2026-08-10, PR #225) fixed a dead card: a consumed slot
used to render a check-in button onto somebody else's finished work. The fix gave
the card **a sentence and no control**, and hard-coded that sentence for every
open child:

```ts
const consumedNote = (c) => {
  if (c.open) return t('floor.common.already_started');  // "Already started by another operator"
  ...
```

`ConsumedLoadRef` carried `status`, `open`, `totalUnits`, `workedAt` — **and no
holder identity at all.** So the card could not have said anything else. It was
not a wrong branch; it was a missing field. And the sentence it defaulted to is
false in exactly the most common case: *you* started it, the iPad slept or the
PWA reloaded, and you came back.

Pablo's route back in was the hauls screen — which is what you reach for when you
know the truck's **name** ("Costco Innovel"), which is what an operator has in
hand. There, the card said a colleague had it and offered nothing.

Reproduced against the running container on CHAD-HQ, signed in as Pablo:

- `/operator/woodland/hauls?q=costco` → H-136311 renders as a plain `<div>`,
  no control, "Already started by another operator".
- `/operator/woodland/queue` → the ADR-0065 Am.1 unfinished-work block **did**
  render `H-136311 · Costco-Innovel -Sacramento … Counting · Arrived Tue, Aug 11
  6:46 AM` as a working **Resume** link.

### Why "this was supposed to be a non-issue" was half right

ADR-0082 did make operator-lock conflicts self-serve: takeover works, and the
data proves it — 11 takeovers recorded, all on 2026-08-10, including one **by
Pablo himself** at 16:47 PDT. The claim model is fine. The write guard
(`assertOwn`) is fine and would have passed for Pablo.

What was wrong is narrower and easier to miss: **one surface had a way out and
the other did not.** The queue was fixed by ADR-0065 Am.1 and ADR-0082; the hauls
screen, added later by ADR-0074, got the explanatory sentence but never got the
route. One surface working is not a fix — it is luck, and on 2026-08-11 the luck
ran out because Pablo used the other screen.

This is also the *second* time these two surfaces have failed identically.
ADR-0074 Am.1's own header says it: *"The blindness was identical but the code was
not shared, so fixing one would have left the other."* It shared the
**classification** (`toConsumedLoad`) and left each surface to re-derive the
**decision**. That is the seam this ADR closes.

## Options considered

1. **Tell operators to use the queue.** Zero code. Rejected: it makes correct
   operation depend on knowing which of two screens is not broken, and the hauls
   screen is the one that matches how an operator identifies a truck.
2. **Delete the hauls card's sentence and re-add the check-in button.** Rejected
   outright — that is precisely the dead affordance ADR-0074 Am.1 removed; it
   would mint a second child load onto a consumed slot.
3. **Show the holder's name but still no control.** Honest, and still a dead end.
   It converts "the app is lying" into "the app is unhelpful" without letting
   Pablo finish the load.
4. **Route an open consumed slot into the load it already has, and decide the
   three cases in one shared function.** Chosen.

## Decision

`ConsumedLoadRef` gains `loadId`, `holderUserId`, `holderName`.

A new **client-safe, dependency-free** module `consumed-slot-view.ts` owns the
offer decision:

```
open && holder === viewer   -> resume : link to /operator/<site>/load/<id>
open && otherwise           -> held   : same link; the load page renders the
                                        ADR-0082 held-by panel + Take over
!open                       -> worked : read-only card, exactly as Am.1 left it
```

It is a separate module from `consumed-slot.ts` because that one reaches
`OPEN_DOCK_STATUSES`, which sits beside `prisma` and cannot enter the browser
bundle — and the hauls list renders in a client component.

Both surfaces now call it. Two `it.each` guards over the source files hold the
chokepoints: one that every check-in surface calls `toConsumedLoad`, and a new
one that every rendering surface calls `describeConsumedSlot`. The two lists are
deliberately different files, which is itself the argument for a shared function
over a convention.

### Why `held` also gets a route

Because ADR-0082 already decided this. It replaced the silent non-assignee
redirect with a held-by panel and a Take over button, and the queue's
`HeldByOthersSection` has linked non-assignees into that page ever since. Sending
the hauls card to the same place is consistency, not new exposure: the load page
is site-scoped (`load.site_id !== site.id ⇒ notFound()`), and the holder's name
is already legible on the queue.

### Why `worked` is untouched

A `submitted` slot has left the floor's hands; there is nothing to go back to.
`open` is the entire difference between the two cases, and the regression guard
("a WORKED slot renders no link and no button") is asserted in both test files.

## Consequences

- Pablo's class of strand cannot recur *on either surface* — an open consumed
  slot always carries a route.
- The card stops asserting a holder it never knew. `holderUserId === null`
  deliberately yields `held`, never `resume`: two nulls must not compare equal
  into "this is yours."
- The offer decision has one home. A third check-in surface that skips it fails
  the chokepoint test rather than the dock.
- **Residual risk, stated plainly:** this makes the load *reachable*. It does not
  change what happens once you are there, and it does not stop a load being
  claimed and abandoned in the first place. The survey run during this incident
  found a **15-hour** stranded `in_progress` claim (H-136796, HWMA, Janette
  Tomas, since 2026-08-10 17:12 PDT) that no automation will notice; the only
  reason it is not a repeat of this incident is that nobody needed it yet.
  Nothing here adds staleness detection, and the 8-minute burst of 8 takeovers on
  2026-08-10 morning suggests the floor is already doing that reaping by hand.
  A stale-claim watchdog is the obvious follow-on and is **not** in this change.
- Also unaddressed: `expected_unit_count` is 0 on three of four live slots, and
  H-136147 was claimed at 07:55 PDT against a 15:00 PDT appointment. Both are
  noted for follow-up, neither is touched here.
