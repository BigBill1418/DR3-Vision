# ADR-0099 — The scrape retired a truck that was still coming

**Date:** 2026-08-12 (Pacific)
**Status:** Accepted, implemented.
**Closes:** floor dead-end audit **D-2**, and the `cancelled` third of **D-1**.
**Builds on:** ADR-0009 / T-015 (the original stale-haul sweep), ADR-0065 (+Am.1)
(the Pacific-day pin), ADR-0074 D5 + Am.1 (_"a vanished row tells the operator
standing next to the truck nothing at all"_), ADR-0091 (a consumed slot is a
route), ADR-0096 (the divergent-day reconcile), ADR-0094 §RC-1/§P2.
**Deliberately does NOT do:** give the floor a button that un-cancels a slot. §D4.

---

## Context

The MyMRC scrape runs hourly. On every pass it sweeps `expected_loads` for the
site over `[today, +7 days]` and sets `cancelled_at = now` on any live row the
pass did not list. That has been the behaviour since T-015.

The code has always known the input is unreliable. `upsert.ts` says so two blocks
above the sweep, and has since it was written:

> _"Re-appearing haul → un-cancel. MyMRC sometimes drops then re-adds a haul
> during operator edits; preserve the row identity."_

The audit measured what that costs the floor. What it did **not** measure — and
what changes the severity of this finding from "a known trade-off" to "the sweep
is wrong almost every time it acts" — is how often those cancellations were
subsequently undone.

### The measurement

`audit_log` on `dr3_vision` / `dr3-vision-postgres`, CHAD-HQ, **2026-08-11
22:04 PT**. Cancellations are `actor_label='system:mymrc-scrape'`,
`action='soft_delete'`; restorations are the `update` rows whose `before` carries
a `cancelled_at` and whose `after` does not.

|                                              |        |
| -------------------------------------------- | ------ |
| Auto-cancellations, all time                 | **69** |
| …later UN-cancelled by a subsequent scrape   | **67** |
| …never restored (genuine retirements)        | **2**  |
| …that fired BEFORE the appointment           | 16     |
| …of those, that never produced a load at all | 13     |

Time from cancellation to restoration, bucketed:

```
next scrape (<=70m)   30      <- one miss
70m - 3h               2
>24h                  35      <- median 46.4h, p90 243h
never restored         2
min 0.04h (2.4 minutes)   max 284h
```

**97% of every auto-cancellation this system has ever performed was wrong**, and
the distribution is cleanly bimodal: a burst that resolves inside one scrape
interval, and a long tail of hauls genuinely re-added days later. Each row
flapped exactly once — 69 cancellations across 69 distinct slots — so this is not
a handful of pathological rows, it is the ordinary behaviour of the feed.

### Why the floor felt it

A cancelled slot did not merely lose its check-in button. It disappeared:

- **The queue** filtered on `cancelled_at: null`, so the row **was not rendered
  at all**.
- **The hauls screen** hit a bare `continue` in `portal-hauls.ts`, which emitted
  no verdict, so the card fell through to the same read-only **"View only"**
  branch as _no sibling exists_ and _not scheduled today_. Three unrelated
  conditions, one four-letter label.

So for the 16 pre-appointment firings the floor's experience was: a truck is on
the dock, and it is on no screen — or it is on one screen with two words that
explain nothing. This is exactly the shape ADR-0074 Am.1 named, and the queue's
own source carries the sentence, forty lines below the filter that violated it:

> _"The row is deliberately still SELECTED rather than filtered out … A vanished
> row tells the operator standing next to the truck nothing at all."_

That reasoning was applied to the **consumed** case and never to the **withdrawn**
one.

### Why hauls vanish from the feed at all

Worth recording, because it explains the 13-of-16 that "never got a load".
`feedExpectedLoads` reads the **mirror**, filtered on `disappeared_at: null`. Per
ADR-0070 Am.1 that stamp means _"absent from the last swept LIST VIEW"_, and
MyMRC's `docking_appointments_rc` view lists hauls only while they are SCHEDULED
— once MyMRC marks one `Delivered` it moves to `completed_hauls` and rolls out.
Combined with ADR-0089's finding that the docking appointment date is a
_scheduling_ field that is frequently stale or null, a haul can be marked
delivered upstream while its recorded appointment is still in the future. The
sweep then reads "absent" as "cancelled" and retires a slot whose appointment has
not arrived.

**Absent from one list view is not the same fact as withdrawn.** That conflation
is the root of D-2.

---

## D1 — Cancel on a STREAK, not on a single absence

`expected_loads` gains two columns:

- `missed_scrape_count Int @default(0)` — consecutive passes that have missed
  this haul, reset to 0 by any pass that contains it.
- `first_missed_at DateTime?` — when the current streak began.

A row is cancelled only when the count reaches
`CANCEL_AFTER_CONSECUTIVE_MISSES`. The reset is applied on **both** write paths a
present haul can take — the full update and the no-material-change freshness
touch — because the touch is the path almost every haul takes on almost every
pass, and without it the count would be cumulative rather than consecutive.

### Why N = 3

Not a preference. Read off the distribution above, given an hourly cron
(`scripts/mymrc-cron.mjs` → `msUntilNextHour`):

| N     | Cancellations it would have prevented | Cost                                 |
| ----- | ------------------------------------- | ------------------------------------ |
| 2     | 30 of 69 (43%)                        | ≤1 extra hour of a stale row visible |
| **3** | **32 of 69 (46%)**                    | ≤2 extra hours                       |
| 4+    | 32 of 69 — no further gain            | more                                 |

N=3 sits in the gap between the two modes. It eliminates **every cancellation
that resolved within a day** and cannot touch the >24h population — correctly, a
haul absent for two days really has been withdrawn. N=2 captures 30 of those 32;
the third pass buys the 70m–3h pair plus a margin against one slow or skipped
run, for at most two extra hours of a stale row remaining **visible**, which is
the safe direction: the failure being prevented is a truck on the dock with no
row to tap.

`first_missed_at` takes no part in the decision and is stored anyway, on the row
and on the `soft_delete` audit row, so _"was three the right number?"_ is
answerable from the ledger rather than from this document. ADR-0094 §6 asks that
of every threshold this repo sets.

## D2 — A pass that saw nothing retires nothing

`feedExpectedLoads` reads the mirror, so `upsertScrapedHauls` can be reached with
an empty haul array without `sync.ts`'s zero-anomaly gate (which guards the LIST
pass) or `markDisappeared`'s completeness check ever firing. Under the old
one-miss rule that was a whole-site wipe from a single bad read; under a
three-miss rule it is a whole-site wipe after three.

The sweep now skips entirely when the pass carried zero hauls, and logs a warning
— silence would be indistinguishable from "nothing was stale". Stating the
invariant here is cheaper than depending on two upstream callers continuing to
hold it.

## D3 — The window is the PACIFIC day, not the UTC day

The sweep bounded on `startOfUtcDay(now)` while every read surface bounds on the
Pacific day. Between 17:00 PT and Pacific midnight the UTC day has already
rolled, so the sweep's "today" was the operator's tomorrow and the window's lower
edge had walked past slots still live on the queue — the exact UTC/Pacific class
ADR-0065 was written to eliminate, still in the write path a month later.

`startOfPacificDay` is duplicated locally rather than imported because
`src/lib/mymrc` compiles standalone under `tsconfig.mymrc.json`, whose rootDir
forbids reaching above it — the same constraint that already forces the local
`writeAudit` and `header-safe.ts`. It reads the zone's offset from `Intl` for the
day in question rather than assuming 7 or 8, so it is DST-correct in both
directions.

## D4 — Cancellation becomes VISIBLE, and stays UNCONTROLLED

Both read surfaces now name the state:

- **Hauls**: its own amber card — _"MyMRC withdrew this haul at 11:00 AM"_ plus
  what to do about it — instead of falling into "View only".
- **Queue**: cancelled slots for today are selected and rendered in a separate,
  quieter _"Taken off today's list by MyMRC"_ block instead of being filtered
  away. Consumed ones are excluded, because `listSiteOpenLoads` already rescues
  those above.

**No control is offered, and that is a decision, not an omission.**
`startInboundLoad` answers `409 expected_load_cancelled`, so a check-in or
reconcile button here would be an affordance whose only outcome is a refusal —
precisely what ADR-0074 Am.1 forbids and what this whole audit is about. The card
therefore takes the `count-client.tsx` `hold_remote_note` shape the audit names
as the house best practice: when there is genuinely no control on this screen,
say **who** can act and **from where**.

It also self-heals, like `review-panel.tsx`'s `!correctable` block: the office
re-adding the haul in MyMRC restores the row within the hour, because the
un-cancel path already works — that path is what produced the 67 restorations
measured above. So the sentence the operator reads ("call the office; it comes
back on this screen within the hour") is a description of a mechanism that
demonstrably runs, not a promise.

### The alternative considered and NOT taken: an operator restore button

ADR-0094's framing and the audit both point at _"reconcilable-or-restorable, not
invisible"_, and a restore control is buildable — with D1 in place a restored row
would survive ~3 hours, long enough to work, after which `open-loads.ts` rescues
the load permanently regardless of the slot.

It is not built here for one reason that is not mine to overrule: a load worked
against a haul MyMRC does not list is a **billing** artefact, and whether the
floor may create one is Bill's call, not an engineering default. The technical
argument is finely balanced — the truck and the mattresses are real either way —
so the honest move is to make the state legible now, which removes the stranding,
and put the control to Bill as a decision rather than smuggling it in inside a
dead-end fix. Recorded in `docs/OPEN-ITEMS.md`.

---

## Consequences

- Slots absent for one or two hourly passes stay live and visible. A genuinely
  withdrawn haul is now retired after ~2–3 hours rather than ~1.
- A withdrawn slot is legible on both floor surfaces instead of invisible on one
  and unexplained on the other. D-1's third condition is named, so "View only"
  now means only _no slot, or an undated one_.
- `audit_log` gains no new rows for misses below the threshold — deliberately. A
  miss is a fact about a pass, not a change to the haul, and the table is
  append-only and retained indefinitely (hard rule #6); one row per miss per haul
  per hour would bury the cancellations that matter.
- The two currently-cancelled rows in production are untouched. This changes
  future sweeps only; it does not retroactively restore anything.

## What this does not fix

- **It does not make the feed reliable.** MyMRC will keep dropping and re-adding
  hauls; this bounds the blast radius rather than removing the cause.
- **It does not distinguish "withdrawn" from "rolled out of the list view"** —
  the D-2 root described above. Doing that means reading `completed_hauls`
  membership before retiring a slot, which is a larger change to the mirror
  contract and is not attempted here.
- **N=3 rests on 69 events.** The bimodality is clear but the sample is small,
  and the >24h population is inferred from restoration timing rather than from
  anything MyMRC told us. Re-derive before changing it; the query is above.
- **A truck arriving against a slot withdrawn >3 scrapes ago still has no
  self-service path.** It has an explanation and a phone call, which is strictly
  better than silence and strictly worse than a control. That is D4's open
  decision.

## Verification

- `npm run typecheck`, `npm run lint` clean.
- `src/lib/mymrc/upsert.test.ts` — the threshold (1st and 2nd miss do not cancel,
  3rd does), the streak reset on reappearance, the evidence on the audit row, and
  the empty-pass fence. The pre-existing stale-cancellation tests were updated to
  the new contract rather than deleted: they encoded the one-miss rule.
- `src/lib/loads/portal-hauls.test.ts` — a cancelled slot reports `cancelledAt`
  and still offers no start/reconcile target.
- `src/app/operator/[site]/hauls/hauls-client.test.tsx` — the withdrawn card, its
  Pacific-rendered time, the absence of any control, and that a consumed slot
  still routes even when later withdrawn.
