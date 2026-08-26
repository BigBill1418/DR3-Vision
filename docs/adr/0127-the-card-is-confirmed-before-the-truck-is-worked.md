# ADR-0127 — The card is confirmed before the truck is worked

- **Status:** Accepted
- **Date:** 2026-08-25
- **Follows:** ADR-0090 A (haul numbers on five operator surfaces); ADR-0096 (the day acknowledgement); ADR-0074 Amendment 1 (the consumed-slot defect); ADR-0060 (gloved-hand sizing); ADR-0082 (the claim)
- **Closes:** OPEN-ITEMS §0.BO, BO-3

## Context

On 2026-08-25 the 9:30 AM Woodland truck — **Lake County Waste Solutions haul
H-138155, carried by Ron Lawrence & Son** (truck 113 / trailer 10744) — was
worked start to finish on the **Recology Mountain View** card **H-138504**. A
different supplier, on DR3's own transport account.

|             | What happened                                                   |
| ----------- | --------------------------------------------------------------- |
| Card tapped | Recology Mountain View, slot `3ab8434d…` (H-138504), 8:30 appt  |
| Truck       | Lake County, slot `8ee5588e…` (H-138155), 10:00 appt            |
| Operator    | Nate Cullison                                                   |
| Worked      | 9:45 arrive → 10:01 unload → 10:56 finish, 11 stacks, 135 units |
| Ended       | `submitted` — inside `INVOICE_STATUSES`                         |

Fifty-five minutes of work, eleven stacks, a BOL photo of the _correct_
paperwork, and a submit. At no point between the tap and the submit did anything
ask "is this the right truck?". A floor-side duplicate re-file attempt followed
at 4:21 PM, which would have booked ~270 units for one 135-unit truck had it been
completed.

### The uncomfortable part

**Every identifying fact was already on the card.** ADR-0090 A put the haul
number there for precisely this reason — JT asked for it so a paused load could
be recognised as the one tapped by mistake. The supplier was there. The
transporter was there, and the two rows differed starkly on it:

```
H-138504  Recology Mountain View     St. Vincent de Paul Society of Lane County, Inc - DR3 parent account CA
H-138155  Lake County Waste Solutions, Inc.   Ron Lawrence & Son
```

So the diagnosis "surface the transporter" is wrong: it was surfaced. What was
missing is that **one tap committed to it**. A chip you are never asked about is
a chip you do not read — the card's largest, boldest element was the appointment
time, and two trucks on one day differ by an hour.

This repo has already learned the same lesson once, from the other direction.
ADR-0096 gave the late-arrival control two taps and a read-back, _because
consuming the wrong slot is expensive_ — and then left the ordinary path at one
tap, on the grounds that "the friction is scoped to the divergent state; the
common path is untouched." The common path is where the mis-card happened.

## The decision

**D1 — Check-in is a confirmation, not a tap.** `QueueRow` — the one component
behind BOTH check-in surfaces, `/queue` and `/hauls` — expands in place on the
first tap and reads the truck back before the second one commits:

```
Is this the truck on the dock?

H-138155
Lake County Waste Solutions, Inc.
Carried by Ron Lawrence & Son

[ Yes — check it in ]   No, wrong card
```

Three facts, on three lines, at a size that is read rather than glanced past.
The **carrier** is deliberately not the dimmest thing on the panel: it is the
line that most starkly separated the two cards on 2026-08-25 and it was the
faintest text on the row.

**D2 — The confirmed haul number TRAVELS, and the server compares it.**
`startInboundLoad` takes an `acknowledgedHaulId` and compares it against
`expected_loads.external_mymrc_haul_id` **inside the writing transaction**. A
mismatch is `409 haul_number_mismatch` and nothing is minted.

This is ADR-0096's discipline applied to identity rather than to date: the UI is
where the operator READS the fact; the server is where it is CHECKED. Neither
alone is enough — a read-back nobody verifies is a decoration, and a server check
nobody was shown is a refusal out of nowhere.

**D3 — The argument is REQUIRED, not optional.** ADR-0096 refused
`allowAnyDay: true` because "a stale client would pass it exactly as happily as a
correct one". An optional acknowledgement has the same defect one level up: a
future caller that forgets it gets the pre-ADR behaviour silently. Making it
required turned it into a compile error at six call sites, every one of which was
a place that had to state which haul it believed it was starting.

It is also NOT the expected-load id restated. The id is what the operator
_tapped_; the haul number is what they were _shown_. Checking one against the
other is the entire prevention; restating the id would be a tautology.

**D4 — The comparison is exact, modulo surrounding whitespace.** Haul numbers are
machine-issued (`H-138155`). A case-insensitive or fuzzy compare would be a guess
wearing a check's clothes. The value crosses an RSC boundary as text, so both
sides are trimmed and otherwise compared byte-for-byte.

**D5 — The guard runs BEFORE the idempotent already-claimed return.** A mismatch
means the page no longer describes this slot; handing back somebody else's
existing load in that state answers a question the operator did not ask. The
idempotent branch (ADR-0082) is for a double-tap on the _right_ card.

**D6 — A row that cannot name itself renders read-only.** `hauls-client.tsx`
previously passed `r.externalHaulId ?? t('floor.hauls.no_date')` into the
late-arrival panel — a placeholder that read "No date" where a haul number
belongs. Now that the label travels to the server, a stand-in string would be a
guaranteed 409: a control whose only outcome is a refusal, which ADR-0074 Am.1
forbids. The null case is guarded in the branch condition and falls through to
the read-only card instead.

**D7 — A refusal is SHOWN.** The floor dead-end audit's D-8 is the class where a
refused floor write renders nothing and the operator retaps forever. The catch
names the refusal and offers the reload that fixes it, and the `NEXT_REDIRECT`
control-flow signal is re-thrown — swallowing it would report every SUCCESS as a
failure, which is the inverse defect and the worse one. That predicate is now one
shared, tested function (`lib/next-redirect.ts`) rather than two inlined copies.

## Alternatives rejected

**BOL-photo OCR matched against the tapped card.** The strongest possible
prevention: the BOL attached to the mis-carded load reads `H-138155` in plain
text, so a machine comparing it to `H-138504` would have caught this at 9:45 AM.
Out of scope for this pass — it needs an OCR path, a confidence policy, a
what-happens-when-it-cannot-read answer, and a decision about whether a
low-confidence read may BLOCK a truck on the dock. Noted as a possible future
layer; recorded in §0.BO rather than half-built here.

**`window.confirm`.** Unstyled, unlocalised (this app ships English, Spanish and
Urdu RTL on day one — CLAUDE.md hard rule #4), and on iPadOS dismissible in ways
that give no signal back — the floor dead-end audit's D-20 records a live case.
The in-place disclosure is the idiom `ReconcileRow` already established here.

**A confirm only on "risky" cards** (two slots the same day, adjacent
appointments, similar names). Every such rule is a guess about which mis-tap is
likely, and the one that actually happened would have had to be guessed in
advance. A rule that fires sometimes also teaches the operator that its absence
means "safe".

**Making the second tap a different gesture** (long-press, swipe-to-confirm).
Gloves, cold hands and an outdoor screen. Two ordinary 56px targets are what the
rest of the floor surface uses.

## Consequences

- **Every check-in is now two taps.** That is the cost, it is paid on every
  truck, and it is accepted: the alternative cost was 135 units filed against the
  wrong supplier and a near-miss double-count.
- Six call sites of `startInboundLoad` had to state the haul they were starting.
  Two are production (`startLoadAction`, `startLoadReconciledAction`); four are
  test fixtures, each of which now names its slot's number once rather than
  passing an argument it never had to think about.
- The `/hauls` screen's late-arrival control now sends **two** acknowledgements —
  the day and the haul. It already read both back; only one of them used to be
  checked.
- A stale tab whose slot MyMRC re-pointed under it now gets a named refusal and a
  reload button instead of a silent success on the wrong row.

## What this does NOT fix

The operator can still confirm a card that is genuinely wrong — this asks the
question, it does not answer it. What it removes is the _reflex_: a tap that
committed to an identity nobody was shown. Machine-checking the identity against
the paper (the OCR layer above) is the next rung, and it is not on this ladder
yet.
