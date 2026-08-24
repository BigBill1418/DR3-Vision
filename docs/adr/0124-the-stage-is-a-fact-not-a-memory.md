# ADR-0124 — The stage is a fact, not a memory

- **Status:** Proposed — **NOT MERGED.** Held for a before-noon operator window.
- **Date:** 2026-08-20
- **Closes:** ADR-0121 §Follow-ups item 2
- **Depends on:** ADR-0122 (the detector, which covers the screens this changes)

## Why this one is parked

ADR-0121 shipped during floor hours because it only made a dead control live.
ADR-0122 shipped during floor hours because it changes nothing an operator can
see. **This changes which screen an operator lands on**, and that is not a change
to make while trucks are on the dock — which is exactly what ADR-0121 said when
it deferred it:

> Move the stage off `bolDone` onto a server-derived stage. The right shape, and
> where this should go — but it changes how every stage is selected, which is not
> a change to make at 1 PM with trucks on the dock.

Per CONTRIBUTING's before-noon `/operator` rule, this merges in the next morning
window with an operator available to walk one real load through the flow.

## Context

`load-workflow.tsx` selected the stage from `load.status` **plus two client
`useState` latches**, and both of them recorded, in one browser tab, that a step
done on the server was finished.

**`bolDone`.** Set when the operator taps Continue on stage 1. Taking the BOL
photo does not move `load.status` — it stays `arrived` — and
`recordBolCapture`'s entire body is:

```ts
// The BOL photo row was written by the client via /api/photos/confirm
// before this action fired. No server-side photo write here.
await assertOwn(args);
```

It writes **nothing**. So the only record that stage 1 was finished lived in one
tab, and any reload or takeover returned to stage 1. On 2026-08-20 that put three
operators in turn onto a BOL screen for a load whose BOL photo was already in
Postgres, and — because of the three composing rules in ADR-0121 — that screen
had no live control at all.

**`weightSkipped`.** Set when the operator taps "None". `recordWeightSkip` also
wrote nothing, under a comment that stated the design out loud:

```ts
// Operator chose "no weight ticket" — no DB change needed; the
// weight stage gates only on the user's choice, not on a status
// transition.
```

The user's choice died with the tab. Nobody has been trapped by it, because
"None" is always live — but a stage the floor can be sent back through
indefinitely is the same class of defect, and **removing one latch while leaving
the other keeps half of it alive.**

#286 made the trapped screen escapable. This makes the operator not land on it.

## Decision

**D1 — The stage is a pure function of server facts.**

New module `src/lib/loads/stage-selection.ts`:

```ts
export function selectStage(facts: StageFacts): StageId | null;
```

with `StageFacts = { status, bolPhotoCount, weightSkipped }`. There is
deliberately **no room for a client hint**, not even a forward-only one: a latch
that could only ever advance the stage would be safe, and would also be a second
answer to a question that already has one — the shape ADR-0091 rules out and the
shape that produced the incident.

**D2 — BOL done ⟺ `photo_counts.bol > 0`.**

The photo row **is** the completion. It is what ADR-0060 forces, it is written by
`/api/photos/confirm` before the stage action fires, and it was **already
plumbed** to this component for ADR-0109 — so nothing new is threaded and no
column is added.

A `bol_captured_at` column was the alternative and is worse on the axis that
matters: it would be a second representation of "the BOL was taken", derivable
from the first, and therefore a thing that can disagree with the photo rows. The
day this ADR is written is the day a second representation of a completed step
cost the floor ninety minutes.

**D3 — The weight SKIP gets a column: `inbound_loads.weight_skipped_at`.**

It is the one decision on this flow that leaves no other trace — no photo, no
status move, no weight. `recordWeightSkip` now stamps it and writes the audit row
in the same transaction (hard rule #6, ADR-0118 D3), and the stamp is
**idempotent**: `updateMany … WHERE weight_skipped_at IS NULL`, so a second
"None" tap from a takeover or a double-tap cannot re-attribute an earlier
operator's decision to a later one. `count === 0` means the decision already
stands and no audit row is written, because nothing changed.

**D4 — The failure mode of a missed revalidation is a RETRY, not a dead screen.**

Advancing now depends on `revalidatePath` re-rendering the route after the stage
action. If that were ever missed, the operator sees the BOL stage with a **live**
Continue and taps it again. That asymmetry is the argument for the server fact:
the worst case is a redundant tap, and ADR-0122's detector would page if it ever
were not. Under the old design the equivalent failure was a screen with nothing
on it.

## Alternatives rejected

- **Keep `bolDone` as an OR-term** (`bolPhotoCount > 0 || bolAdvanced`). Strictly
  safer in-session, and genuinely tempting: it makes the transition instant and
  independent of revalidation timing. Rejected because it leaves two answers to
  one question in the file whose two-answers problem is the subject of this ADR,
  and because D4's failure mode is a retry rather than a trap.
- **`weight_captured` with a NULL `weight_lbs` for the skip.** No column, reuses
  the status machine. Rejected: "there is no weight ticket" and "the weight was
  captured" are different claims, and a `weight_captured` status asserting the
  second while meaning the first would mislead every downstream reader — and this
  repo already has ADR-0104 on the subject of loads that are recorded without a
  weight.
- **Deriving the skip from the absence of a weight photo.** Indistinguishable
  from "the operator has not got to the weight stage yet". That is precisely the
  ambiguity the column removes.
- **Leaving `weightSkipped` a latch and retiring only `bolDone`.** The brief asks
  for `bolDone`. Doing only that leaves a dispatch that is half server-derived,
  and a reloaded operator still re-answering the weight question about a truck
  someone already decided on.

## Consequences

- **The floor behaviour that changes**, stated plainly so it can be walked
  through in the window: a load at `arrived` **with a BOL photo already on the
  server** now opens on stage 2 (weight) instead of stage 1. That is the fix. A
  first visit is unchanged, and a load with no BOL photo still opens on stage 1
  with Continue refused.
- **`recordWeightSkip` writes to the database for the first time**, so the "None"
  tap can now fail where it previously could not. It is a single `updateMany`
  inside a transaction on a row the operator already holds; the offline queue is
  unchanged, as this is a Server Action and always was.
- **The dispatch matrix is testable without React.** It was nested ternaries
  inside a component reading two `useState`s, which is why "which stage does a
  load with its BOL photo land on" was not a question anything could ask.
  `stage-selection.test.ts` asks it; `load-workflow.dispatch.test.tsx` mounts the
  real workflow and checks the rendered heading agrees.
- **ADR-0122's detector follows the change.** Retiring the latches moves which
  stage renders, so the beacon's subject moves with it; there is an explicit
  assertion that a re-entered weight `add` screen is still reported.
- **Stage 2's `add` trap is STILL NOT FIXED.** ADR-0122 §Consequences records it:
  the `add` sub-screen has no way back to `choose`. This ADR makes the weight
  stage more reachable on re-entry, so the trap is arguably now _easier_ to hit —
  it pages, and it is the first thing to fix in the same window. Recorded in
  `docs/OPEN-ITEMS.md`.

## Verification

`stage-selection.ts`'s `arrived` branch replaced with `return 'bol'` — the
pre-ADR-0124 fresh-mount behaviour, both latches false:

```
× the 2026-08-20 re-entry > a load whose BOL photo is already on the server does NOT return to stage 1
  → expected 'bol' to be 'weight'
× the 2026-08-20 re-entry > a recorded weight skip survives the reload that used to erase it
  → expected 'bol' to be 'door'
× reload · takeover · re-entry > a reload of a load whose BOL photo is already on the server lands on the WEIGHT stage
  → Unable to find an element with the text: 2. Weight ticket
× reload · takeover · re-entry > a takeover by the next operator lands where the work actually is
  → Unable to find an element with the text: 2. Weight ticket
× reload · takeover · re-entry > re-entry after the tab was closed does not ask for the BOL again
  → Unable to find an element with the text: 2. Weight ticket
× reload · takeover · re-entry > a recorded weight skip survives the reload
  → Unable to find an element with the text: 3. Door open
```

Every composition failure had the BOL heading on screen instead. That is the
incident, reproduced in a test.

## The window checklist (for the morning)

1. Merge, confirm the deployer rolled the new build SHA and the container
   recreated healthy.
2. Confirm `prisma migrate deploy` applied `20260854_adr0124_weight_skipped_at`
   (additive nullable column; no backfill).
3. One real load, walked by an operator: BOL photo → **reload the iPad** → it
   must open on stage 2, not stage 1.
4. Tap "None" → **reload** → it must open on stage 3.
5. Read `dr3-vision-floor` for anything ADR-0122 paged during the walk.
