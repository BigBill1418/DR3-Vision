# ADR-0113 — A load can be refused after the counting has started

**Date:** 2026-08-19 (Pacific)
**Status:** Accepted, implemented. Floor-facing — held for a window, then **rebased onto ADR-0124 on 2026-08-24** (see §D13); merges and deploys in the **Monday 2026-08-24 before-noon PT** window per ADR-0100 D7, after #289.
**Also builds on (absorbed at the 2026-08-24 rebase):** ADR-0118 (the guarded transition + the scalar-only `updateMany` surface), ADR-0124 (server-derived stage selection — this ADR's mount gate is expressed in its `StageId` vocabulary), ADR-0122 (the stage-liveness reason vocabulary, which gains `no_note` here), ADR-0121 (untouched — its re-entry suite is a regression gate for this change).
**Builds on:** ADR-0090 C + Amendment 1 (the void, the soft-void pattern, the holder-only rule), ADR-0091 (a consumed slot is a route, not an epitaph), ADR-0086 + Am.1 (capture-time photo grants), ADR-0078 (idempotent floor writes, the honest queue), ADR-0082 (claim takeover), ADR-0074 Am.1 (the terminal screen is a route), ADR-0109 (three photos per capture point), ADR-0100 (dead-end telemetry)
**Deliberately does NOT do:** change the schema, add a migration, sever the expected-load slot, offer the reject to a manager who does not hold the load, or make the rejection replayable from the offline queue. §D5, §D6, §D7, §6.
**Retires:** hand-audited DB surgery as the only remedy for a truck refused after its unload began — the same class of remedy ADR-0090 retired for the mis-tapped haul, and the last one still standing on this screen.

---

## 1. Context

Bill, 2026-08-19:

> we accepted a load as arrived — then found massive bed bugs — no path to go
> back and reject it… rectify and redesign the operator UI to accommodate this.

**H-137759** (Ron Lawrence & Son, Placer landfill) checked in, the operator
photographed the BOL, opened the trailer, began the unload, and started counting.
Somewhere in the first stack the floor found a live bed-bug infestation.

There was no way back. The load was closed at ~11:20 AM PT by audited manual
rectification — `in_progress → rejected`, category `bedbugs`, one stack
soft-voided in the same transaction, evidence photos retained, actor
`system:h137759-bedbug-rejection`. Inventory and pay were never touched, because
non-verified statuses feed nothing.

That rectification is the correct end state. It is also **exactly the
DBA-shaped tool in the hands of an actor with no product-level guardrail** that
ADR-0090's own Context paragraph names as the failure mode it exists to retire.
ADR-0090 retired it for the mis-tapped haul. This ADR retires the last one on
this screen.

### 1.1 The mechanism — two halves, both closed

**The transition table stopped short.** `src/lib/load-service.ts`:

```ts
rejected: ['arrived', 'weight_captured', 'unload_started'],
```

**And the screen mounted the reject stage on one status.**
`load-workflow.tsx`:

```tsx
if (load.status === 'unload_started' && showReject) return <StageReject … />;
```

So the entire refusal decision lived inside the ONE stage between opening the
trailer door and the first stack landing. Past that the affordance was gone from
the UI, and a hand-crafted POST would have met `illegal transition in_progress →
rejected` behind it.

### 1.2 Why that boundary was wrong, and not merely narrow

The bugs are not in the trailer doorway. They are in the mattresses, and you find
them **by handling the mattresses** — which is to say, after the load is
`in_progress`, because handling the mattresses is what moves it there.

Placing the last exit before the first stack asks the floor to make the refusal
decision with the evidence still in the truck. The stage is called "Inspect the
load", and the honest description of what an operator can inspect at that moment
is: the outside of a stack.

### 1.3 What ADR-0100 could and could not see

The floor hit an actionless state, so the natural question is whether a
`<DeadEndBeacon>` should have been counting it. **It could not have been, and
still cannot.**

ADR-0100's beacon measures **rendered actionless states** — a screen with a
route missing, mounted inside the JSX branch that renders it (D6). Here the
screen was not actionless. `StageStacks` rendered, the count worked, the timer
ran, every control on it did what it said. What was missing was one exit that
nothing on the page referred to.

A stage that renders real work while lacking one affordance is, to that
instrument, **indistinguishable from a healthy stage**. There is no beacon to
place, because there is no branch that knows something is absent. This is a real
limit of the ADR-0100 model, recorded here rather than left to be rediscovered
(`P-57`).

What ADR-0100 _should_ have been counting, and was not, is §D8.

---

## 2. Decision

### D1 — `rejected` gains `in_progress` and `finished`

```ts
rejected: ['arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished'],
```

`finished` is included deliberately, on ADR-0090 D2.3's reasoning applied from
this side: bugs found while looking at the finished pile are found at
`finished`, and admitting `in_progress` while refusing `finished` rebuilds the
identical dead end one stage further along. The ADR-0090 Am.1 reopen edge would
technically route around it — reopen the load, then reject it — but that is a
remedy behind a door labelled something else, which on a floor is the same as no
remedy.

Past `submitted` is unchanged and stays ADR-0073's territory: the load may
already sit on an MRC invoice, and a floor-side refusal there would silently
restate a filed number.

**The set is now identical to `voided`'s, and to `OPEN_DOCK_STATUSES`.** That is
the real statement: _the floor may take either terminal exit from exactly the
states where the load is still the floor's work._ The three-way equality is
**pinned by a test rather than expressed by sharing one constant**, and the
distinction matters both ways round. A shared constant could not drift — but it
also could not be _deliberately_ narrowed without an argument, and worse, it
would let `reject` silently WIDEN because somebody added a status to
`OPEN_DOCK_STATUSES` for an unrelated reason. A pin makes a future divergence
edit the pin and say why.

### D2 — `rejectLoad` is rebuilt on the `voidLoad` pattern

The old implementation was four lines through the generic `transition()` helper,
and each of the following was missing rather than decided:

- **The audit row said nothing.** `transition` writes `after: { status:
'rejected' }`. **In the entire history of this table, no rejection's REASON has
  ever reached the append-only log.** The category and note landed on the mutable
  `inbound_loads` row and nowhere else — the one place a later correction can
  overwrite them. CLAUDE.md hard rule #6 makes the audit log the durable record;
  the rejection was not in it.
- **It was not transactional.** `transition` does the update and the audit as two
  awaits, leaving the "decision stands but the audit is missing" window
  `voidLoad` closes. Bolting a stack sweep onto that would have widened the
  window to "load refused, stacks still counting".
- **A second tap was a 409.** The screen is reachable from a stale tab.

So it now mirrors `voidLoad` exactly: one `prisma.$transaction`, validation
before the ownership read, replay-as-silent-no-op, audit enlisted with `{ tx }`.
The two floor exits stay legible as siblings, which is most of why a future
reader will get them right.

### D3 — the evidence photo is enforced where it can be enforced

`stage-reject.tsx` gated on `!hasPhoto` client-side and **the server never
looked**. A hand-crafted POST could refuse a truck with no evidence at all.

A rejection is a contractual assertion to the carrier and to MRC — the photo is
the whole of the proof. It is now a server-side 422 (`rejection_photo_required`),
counted inside the same transaction as the write, and `purged_at: null` is part
of the predicate: a purged R2 object is a record that a photo once existed, not
evidence anyone can look at.

The count is safe to take at this moment because the reject is **online-only**
(D7) — the `LoadPhoto` row is written by `/api/photos/confirm` before the action
fires, so by the time we are here the row either exists or the operator has no
evidence. ADR-0109's multi-photo capture is unchanged; one is the floor.

### D4 — every live stack is soft-voided in the same transaction

Prior values retained — `unit_count`, `stack_index`, `count_mode` untouched,
only `voided_at` / `voided_by` written. ADR-0090 Am.1's rule, and it matters here
for a reason of its own: **"we counted 47 before we found the bugs" is evidence
about the load, not a mistake to erase.**

This is not belt-and-braces. `rejected` sits outside every money allow-list, so
the LOAD is already excluded — but the stacks would remain **the only rows in the
database asserting that a refused truck delivered units**. Both `finishUnload`
sum sites filter `voided_at IS NULL`, which is what makes the sweep sufficient.

One audit row per stack, so "what happened to stack 7" stays answerable through
the `([table_name, row_id])` index — the shape `voidStack` already writes. They
go out through a new `writeAuditMany` (`src/lib/audit.ts`), because **ledger mode
writes one `load_stacks` row per mattress**: a 240-unit load would be 240
sequential round trips inside an interactive transaction, against Prisma's
5-second default timeout. `writeAudit` and `writeAuditMany` share one
`toAuditRow` mapping, so they cannot produce different rows for the same input.

### D5 — the expected-load slot is RETAINED, inverting the void

**This is the decision most likely to be "fixed" by a future reader reasoning
from analogy, so the argument is written out.**

`voidLoad` NULLs `expected_load_id` because a void asserts **the slot was never
legitimately consumed** — wrong haul, or no truck — so the real haul must stay
checkable-in.

A reject asserts the **opposite**: the truck came, against **this** haul, and we
refused it. That is a true and final fact about the slot. Severing it would:

1. offer the refused haul for a second check-in, minting a second child for one
   physical delivery — the collision the UNIQUE index on `expected_load_id`
   exists to prevent; and
2. erase the only link between a scheduled haul and what became of it.

**Both check-in surfaces already render this correctly, and have since ADR-0091.**
`toConsumedLoad` returns a non-null ref for a `rejected` child, `open` is false
(`rejected ∉ OPEN_DOCK_STATUSES`), `describeConsumedSlot` answers `worked`, and
the card falls to `already_worked_status`, which reads **"Rejected at the dock"**
through `floorStatusKey`. The hauls surface already carries an
`already_worked` beacon on that branch. That path was built for the early reject
and needed no change for the late one — verified against the code, not assumed;
ADR-0091's own D-5 comment names the `rejected` case explicitly and records the
two such loads live in production at 2026-08-11.

**Severing would therefore be a regression**, turning a card that correctly says
"we refused this" back into a free slot inviting a second check-in.

**The fumigated redelivery** is the scenario that makes this feel wrong, and it
resolves cleanly: a truck that returns days later after treatment is a **new
delivery** — new appointment, new BOL, new MyMRC haul row. It is not a re-entry
into the slot of the load we turned away. Filing it there would date the
redelivery to the day we refused it.

**And it is what the early reject already does.** A load refused at the gate
keeps its slot. Giving the late reject different slot semantics would mean the
floor's behaviour depends on _when_ the bugs were spotted — which is not a fact
about the world.

### D6 — the holder, full stop

ADR-0090 D2.3's rule, unchanged, and the rule the early reject already had.

The floor found the bugs mid-unload with the truck at the dock. **A path that
requires finding a manager first IS the dead end, relocated** — it would turn a
30-second refusal into a hunt, and an operator who cannot refuse a load in front
of them will keep counting it. A manager rejects by taking over first (ADR-0082),
which is audited and names both parties. No second authorization path is
invented; two places that have to agree about who holds a load is the defect
ADR-0082 spent a section removing.

The loudness that makes this safe is the audit row, not a gate: who, when, from
which status, which category, which note, which slot, and how many stacks and
units were voided.

### D7 — online-only, and the offer is withheld while writes are in flight

Not in `FLOOR_SCOPES`, never enqueued — ADR-0090 D2.4's decision for the same
reason. A rejection is contention-shaped, and replaying one hours later would
refuse a load whose state has moved on.

That leaves the reverse hazard, and it is the sharp one: **`LOAD_ADD_STACK` and
`LOAD_FINISH_UNLOAD` ARE replayable scopes.** A stack tapped while the iPad was
offline can replay AFTER the rejection, and would then be the one write asserting
that the refused truck delivered units. `addStack` refuses anything but
`in_progress` and parks it as a conflict — loud, but only after the fact.

The honest place to stop it is the offer. `review-panel.tsx` established the
pattern for exactly this ordering hazard, and the panel reuses it verbatim:
withhold while `pendingActionsForLoad(loadId) > 0`, **fail CLOSED** when
IndexedDB cannot be read at all (an unreadable queue is not an empty queue), poll
every 3 s so the control unlocks without a reload, and **say why** — a control
that is merely absent teaches the operator the feature is broken.

**The cost is accepted knowingly and stated plainly:** this is friction at the
worst possible moment — bugs found, truck at the dock, button greyed. It is
tolerable only because the rejection is online-only anyway, so the queue drains
in seconds whenever this control could have worked at all. The alternative is a
refusal a replay partially undoes, silently, in a billed number.

### D8 — the terminal reject screen was never counted, and now is

ADR-0100 §P0 wired `load_closed` onto `load-workflow.tsx`'s `!STAGE_STATUSES`
branch and left the `submitted` / `rejected` branch beside it unmeasured. The
omission was invisible because the two branches look alike.

They are not alike, and that distinction is why **only one of them** gets the
beacon:

- **`submitted` reports nothing.** It is the designed end of the workflow — the
  floor lands there having done everything right, and it is the single most
  common terminal render on the screen. Counting it as a dead end would bury
  every real one underneath it, in the same motion that made the metric look
  thorough.
- **`rejected` reports `load_closed`.** A load with no work left in it, and
  after this change it is reached by an operator who was mid-count moments
  before. How often that happens is the only measure of whether the late reject
  is being used as intended.

An existing `DeadEndState` is reused rather than a new one minted, because that
is what this is — no edit to the closed union or to its runtime mirror in the
route.

**Consequence, stated so nobody re-derives it from a graph:** the
`dr3_vision_floor_dead_end_renders_total{state="load_closed"}` series **steps up
when this ships and is not comparable across the deploy.**

### D9 — the UI: a panel, not a stage

`StageReject` _replaces_ the screen, because at the inspection point rejecting is
one of the two things you might do next. Mid-count it is not: the operator is
counting, and the overwhelming majority of loads are fine.

So the late reject sits in the quiet footer stack `load-workflow.tsx` already
establishes, in the order of how final the three controls are:

|     | control                             | weight                             |
| --- | ----------------------------------- | ---------------------------------- |
| 1   | Review what I entered               | quiet link — the common correction |
| 2   | **Found a problem with this load?** | quiet link → panel                 |
| 3   | Can't finish this load? (void)      | quiet link → panel                 |

**Two taps, and the second is behind a form.** The first tap opens the panel; the
panel **states the consequence in units before it asks for anything** — "This
voids the 2 stacks you have counted (21 units) and records the load as rejected.
It cannot be undone." An operator who taps this on the way to "+1 mattress" meets
a sentence about the 21 units they are about to destroy, not a committed
rejection. Voided stacks are excluded from that figure; showing 61 where the
truth is 21 would make the one number that matters a lie.

`bedbugs` leads the category list rather than sitting in enum order: it is why
this path exists, it carries the largest consequence — an infested load
contaminates the building, not just the invoice — and it is what an operator is
reaching for while holding a mattress they want to put down. `other` stays last.

The category list and the note rule moved to a shared `reject-fields.tsx`. The
list is a hand-written mirror of the `RejectionCategory` enum (the runtime enum
object must not enter the browser bundle), and a second copy is how a schema
addition comes to render on one screen and not the other — the
`held-by-panel.tsx` failure, exactly. One copy, pinned to the enum from the
server side where the runtime object IS readable.

No verdict language anywhere on the voided stacks, per ADR-0105's rendering
discipline: they are marked taken-back, and nothing on the screen grades them.

### D10 — the note rule, tightened on BOTH paths

Required when the category is `other`, server-enforced (422
`rejection_note_required`), mirrored by a disabled button. ADR-0090's rule:
`other` with no note spends the category field and records nothing, while
`bedbugs` states a fact on its own and demanding prose from someone in gloves at
a dock buys nothing.

**This tightens the existing pre-acceptance reject too, deliberately.** One
function serves both entry points, and a note rule that depended on _when_ the
problem was spotted is the same incoherence D5 refuses for the slot. Same for the
photo (D3). Nothing legitimate breaks — the client already required a photo, and
`other`-with-no-note was always a record with nothing in it.

### D11 — no ADR-0047 rollout surface

Asked, not assumed. Every surface touched is an EXISTING operator surface already
gated on `ipad_queue`, and `rejectLoadAction` goes through the same `ctx()` that
enforces it. Nothing staff-visible, no recipient roster, no mail. **No new
`rollout_surfaces` row.** The reject inherits the `ipad_queue` gate, which is the
correct blast radius.

### D12 — no schema change, no migration

Every column already exists: `rejection_category`, `rejection_note`,
`load_stacks.voided_at` / `voided_by`, the `rejection` `PhotoKind`, the audit
table. **The defect was the transition table and the mount condition, not the
data model.** Stated explicitly because "add a `rejected_at` column" is the
obvious-looking move and it is not needed — `submitted_at` / `submitted_by`
already carry the instant and the actor on the reject path, as they have since
T-006.

---

### D13 — rebased onto ADR-0124 (2026-08-24), and what that changed

This ADR was written on 2026-08-19 and held for a floor window. Twelve merges
landed underneath it (ADRs 0115–0124). Four of them changed decisions here, and
they are recorded as decisions rather than as merge mechanics because in three
cases the code changed, not just the context.

**D13.1 — one claim in D2 became FALSE and is corrected.** The original text
argued for leaving `transition()` partly because "it was not transactional".
**ADR-0118 made it transactional** — a guarded `updateMany` plus an
in-transaction audit — so that bullet was wrong by the time it would have
shipped. It now reads "it cannot carry the stack sweep", which is what is
actually still true: `transition` cannot soft-void the load's stacks and audit
each of them in the same transaction, and that is the whole of D4. The other
three reasons (the silent audit, the missing photo check, the 409 on replay)
were re-checked against the file and all still hold. **A citation is a promise
(ADR-0098); an inherited rationale is a claim with a date on it.**

**D13.2 — the status flip is now GUARDED, the ADR-0118 way.** `assertOwn` reads
the status on the shared client, and the write this ADR originally shipped was
`update({ where: { id } })` — which writes whatever the row has become by the
time it runs. ADR-0118 names that defect and fixes it for `transition`; the
reject adopts the identical shape:

```ts
const { count } = await tx.inboundLoad.updateMany({
  where: { id: args.loadId, status: current.status },
  data: { status: 'rejected', … },
});
if (count === 0) { /* re-read and throw TransitionError */ }
```

This makes the reject **stricter than the void**, which still writes
`update({ where: { id } })`. That asymmetry is deliberate for today: widening
ADR-0118's guard to `voidLoad` is a second behaviour change on a floor-facing
day, and it belongs in its own change (`P-61`).

`updateMany` is scalar-only, which forces `submitted_by_id: args.operatorUserId`
in place of `submitted_by: { connect: … }`. That is the same edit ADR-0118 made
to `submitLoad` and to the old `rejectLoad`; a nested relation write here is
refused at Prisma **argument validation**, aborting the enclosing transaction —
the ADR-0115 failure mode, where nothing is wrong with the data.

**D13.3 — the mount gate is re-expressed in ADR-0124's vocabulary.** ADR-0124
moved stage selection off the client `useState` latches onto `selectStage()`, a
pure function of server facts, and **deleted `STAGE_STATUSES`** — the constant
this ADR's `LATE_REJECTABLE` was defined against. The gate is now a `StageId`
list:

```ts
const LATE_REJECT_STAGES: readonly StageId[] = ['stacks', 'finish'] as const;
```

Same two screens, asked in the terms the dispatch now answers in, and better
typed: renaming a stage is a compile error here, where a stale `LoadStatus[]`
would have gone on silently matching nothing and the affordance would have
vanished exactly as it did on 2026-08-19. `selectStage` never returns `reject` —
that sub-screen is still entered by the `decision` stage's control and owned by
the workflow shell — so the footer panel remains the only path from `stacks` and
`finish`, which is the hole this ADR exists to close.

**D13.4 — `no_note` joins ADR-0122's closed reason vocabulary.** ADR-0122 gave
the reject stage `useLiveControl('reject_submit', submitReason)`, where
`submitReason` is BOTH what disables the button and what the detector reports
when a screen goes dead. D10's note-on-`other` rule is a fourth refusal, so it
needed a vocabulary entry rather than an extra `||` on the button: a `disabled`
that could be true while `submitReason` was `null` would make the ADR-0122
snapshot a record of a different screen than the one the operator is stuck on.
`no_note` is deliberately distinct from `no_category` — "pick a reason" is the
wrong instruction for someone who already has.

**D13.5 — `LateRejectPanel` does NOT register with `useLiveControl`, and that is
a decision.** The hook "no-ops outside a boundary" by design, and the footer sits
outside `StageLivenessBoundary` — so registering there would add a control that
_looks_ measured and is not, which is worse than not registering. The review
button and `VoidLoadPanel` are outside it for the same reason, and no footer
control appears in `STAGE_CONTROL_IDS`.

The honest consequence: ADR-0122's detector can report `no_live_controls` on a
`stacks` screen whose reject exit is sitting right there in the footer. That was
already true of the void and the review; this ADR does not worsen it and does
not fix it, and moving the boundary is not a change to make in a pre-floor window
(`P-62`).

## 3. Alternatives considered

1. **Widen `ALLOWED_PRIOR.rejected` and stop there.** Rejected. The state machine
   permitting a transition that no screen offers is the same dead end with a
   longer changelog. It is also the more dangerous half-fix, because it looks
   done from the server tests.
2. **Reuse `StageReject` as a full-screen stage on `in_progress`.** Rejected. It
   would replace the count mid-count, and it carries no consequence warning —
   the operator would not learn what they were destroying until it was gone.
3. **Manager-gated.** Rejected — §D6. It reproduces the dead end with an extra
   person in it.
4. **Model the refusal as a 0-unit submit.** Rejected, for ADR-0090 D2.1's
   reason read from the other side: a rejected truck is a real delivery that
   really arrived and was really turned away. It must not be recorded as a load
   that never existed, and it must not be recorded as a delivery of nothing.
5. **Sever the slot, like the void.** Rejected — §D5. It is a regression against
   behaviour ADR-0091 already got right.
6. **Delete the counted stacks.** Rejected. Soft-void, never a delete —
   CLAUDE.md hard rule #6's spirit and ADR-0090 Am.1's letter. What was counted
   before the bugs were found is evidence.
7. **Make the reject offline-replayable so the dock is never blocked.**
   Rejected — §D7. Replaying a refusal onto a load whose state has moved on is
   worse than waiting ten seconds for a queue to drain.
8. **A new `DeadEndState` for "a stage missing an affordance".** Rejected as
   unmeasurable — §1.3. You would have to already know the affordance was missing
   to emit it.

---

## 4. Consequences

- The floor can refuse a bad load at any point it still holds it, in two taps
  plus a photo, with the count it already took preserved as evidence and voided
  as a number.
- **Hand-audited DB surgery is no longer the remedy for a truck refused
  mid-unload.** That was the last such remedy on this screen.
- A rejection's reason now reaches the append-only audit log for the first time.
  Rejections written before 2026-08-19 have their category only on the mutable
  load row.
- The pre-acceptance reject is strictly stricter than it was: server-enforced
  photo, server-enforced note on `other`, replay instead of a 409, and its own
  audit row now carries the reason.
- `load_closed` steps up (§D8). Not comparable across the deploy.
- `LATE_REJECTABLE` in `load-workflow.tsx` and `ALLOWED_PRIOR.rejected` answer
  two different questions — what is OFFERED here, and what is LEGAL — and are
  deliberately not the same list. A seventh hand-maintained status list now
  exists, which is ADR-0090's Open question 3 getting one worse (`P-58`).

---

## 5. What this does not fix, stated plainly

- **MyMRC still shows H-137759 as `Confirmed`.** Vision cannot write to MRC, and
  nothing here changes that. Refusing a load in Vision does not refuse it
  upstream; that remains an operator action Bill takes in MyMRC. A rejected load
  and a mirror that disagrees with it is a real, live inconsistency this ADR does
  not close (`P-59`).
- **No notification.** A bed-bug rejection lands in a column nobody watches —
  the same gap ADR-0090's Open question 2 recorded for `truck_never_arrived`.
  Graded against ADR-0037 it is not a page (nothing is actionable within five
  minutes by anyone not already standing there), but an infestation is a
  building-level event and a daily-digest line is arguable. Not built.
- **No redelivery link.** D5 argues a fumigated redelivery is a new haul, which
  is true and also leaves nothing in the data connecting the two. Answering "did
  this ever come back?" is still a human reading two rows.
- **The `worked` consumed-slot card on the QUEUE has no dead-end beacon**, while
  the hauls card does. Noticed while verifying D5; deliberately not fixed here,
  because adding a beacon to an unrelated surface mid-feature changes what a
  second gauge means (`P-60`).
- **ADR-0100 still cannot see a missing affordance** (§1.3). This class of defect
  is found by a person on a floor, and that is the discovery mechanism ADR-0100
  is named for wanting to retire.

---

## 6. Verification

Gates, on the branch, with node_modules symlinked from the primary checkout:

```
npx tsc --noEmit                       → exit 0
node scripts/check-adr-citations.mjs   → exit 0
npx vitest run src/lib/load-service.reject.test.ts   → 33 passed
npx vitest run …/late-reject-panel.test.tsx          → 17 passed
npx vitest run …/load-workflow.test.tsx             → 48 passed (was 35)
npx vitest run src/lib/audit.test.ts                 → 7 passed (was 3)
```

### 6.0 Re-verified after the 2026-08-24 rebase

Twelve merges landed under this branch. Re-run on the rebased tree, after
`npx prisma generate` (ADR-0124 added `weight_skipped_at`, so the shared client
was stale and every DB-typed file would have failed for the wrong reason):

```
npx prisma generate                                  → client carries weight_skipped_at
npx tsc --noEmit                                     → exit 0
npx vitest run <floor + liveness + hygiene set>      → 643 passed | 52 skipped
  ├─ stage-reentry.test.tsx      (ADR-0121)          → 12 passed, file UNTOUCHED
  ├─ stage-liveness.test.tsx     (ADR-0122)          → 17 passed
  ├─ stage-controls.test.ts      (ADR-0122 vocab)    → 20 passed, with `no_note` added
  ├─ stage-selection.test.ts     (ADR-0124)          → 21 passed
  ├─ load-workflow.dispatch.test.tsx (ADR-0124)      → 14 passed
  └─ repo-hygiene.conflict-markers.test.ts           →  2 passed
```

Two suites went red first and both were real:

- **`load-service.reject.test.ts`** — `tx.inboundLoad.updateMany is not a
function`. The harness still stubbed the unguarded `update`; D13.2 changed the
  write. The test noticed before CI did.
- **`load-workflow.dispatch.test.tsx`** (ADR-0124's composition suite, which
  mocks only the I/O boundary and mounts everything else for real) — `No
"pendingActionsForLoad" export is defined on the "@/lib/offline-queue" mock`.
  The footer now carries `LateRejectPanel`, which reads the queue depth on mount
  (D7). Its mock gained the export; **no assertion in that suite was changed.**

### 6.0.1 The DB lane caught what the local suite structurally could not

The local "full suite" was green — and it **skips 18 files**, because
`*.db.test.ts` is gated on `DR3_TEST_DATABASE_URL` and there is no database in
the dev sandbox. CI went red on the very first push after the rebase:

```
FAIL src/lib/loads/tx-discipline.db.test.ts
  > ADR-0118 — guarded state changes … > two racing transitions
  AssertionError: expected 'arrived' to be 'rejected'
```

**ADR-0118's race test used `rejectLoad` as its vehicle** for proving
`transition()`'s guard, and its fixture has no rejection photo — so D3's new
server-side requirement refused both racers and the load stayed `arrived`. The
requirement was working; the fixture predated it.

Seeding a photo would have made it green and left it **lying**: ADR-0113 D2 moved
`rejectLoad` off `transition()` entirely, so the test would have gone on passing
while covering a different function than this file's header describes and than
its own recorded hand-falsification refers to. So:

- **ADR-0118's test keeps its subject** — the vehicle is now `submitLoad`
  (`finished → submitted`), a real `transition()` caller. Its assertions and its
  falsification note are unchanged and still true.
- **A sibling test races `rejectLoad`'s own guard** against a real Postgres, with
  the photo and a counted stack seeded, asserting the identical contract plus the
  D4 sweep and the D5 "a reject must not look like a void" columns.

Both were then run against a throwaway `postgres:16-alpine` with all 111
migrations applied — **the whole DB lane, 21 files / 109 tests, green** — rather
than pushed and hoped for.

### 6.1 Falsification

Every guard was broken deliberately and the red read for its REASON, not its
colour. The load-bearing ones:

**The transition edge reverted to the pre-ADR-0113 list** — the failure is the
incident's own error string:

```
× refuses a load that is already being counted (`in_progress`)
  → illegal transition in_progress → rejected
× refuses a load whose unload has already FINISHED
  → illegal transition finished → rejected
```

**The server-side photo check removed:**

```
× REFUSES a rejection with no evidence photo
  → promise resolved "undefined" instead of rejecting
```

**The stack sweep skipped:**

```
× soft-voids every live stack in the SAME transaction as the status flip
  → expected "spy" to be called once, but got 0 times
× writes one audit row per voided stack, BATCHED, inside the transaction
  → expected "spy" to be called once, but got 0 times
```

**The slot severed, by analogy with `voidLoad`** — the D5 regression, caught:

```
× leaves `expected_load_id` in place
  → expected { status: 'rejected', …(6) } to not have property "expected_load_id"
```

**`rejected` added to the money and inventory allow-lists** — §4's pin:

```
× is not billable — absent from INVOICE_STATUSES
  → expected [ 'rejected', 'submitted', …(3) ] to not include 'rejected'
× does not move inventory — absent from VERIFIED_INBOUND_STATUSES
  → expected [ 'rejected', 'verified', …(2) ] to not include 'rejected'
```

**The UI mount reverted to `unload_started`-only** — the dead end itself:

```
× THE DEAD END: `in_progress` now offers a reject affordance
  → Unable to find an element by: [data-testid="late-reject-panel"]
× THE DEAD END: `finished` now offers a reject affordance
  → Unable to find an element by: [data-testid="late-reject-panel"]
```

**The beacon put on the `submitted` branch too** (D8's discrimination), and then
removed entirely (ADR-0100's omission):

```
× a `submitted` load reports NOTHING — it is the happy path ending
  → expected "spy" to not be called at all, but actually been called 1 times

× a `rejected` load reports a dead end
  → expected "spy" to be called at least once
```

**The offline gate made to fail OPEN, and the withholding removed:**

```
× WITHHOLDS the controls while the load has unsent writes, and says why
  → Unable to find an element by: [data-testid="late-reject-unsent"]
× FAILS CLOSED when the queue cannot be read at all
  → Unable to find an element by: [data-testid="late-reject-unsent"]
```

**Voided stacks counted in the consequence line:**

```
× names the stacks and units that are about to be voided
  → expected 'This voids the 3 stacks you have coun…' to be
             'This voids the 2 stacks you have coun…' // Object.is equality
```

Added at the rebase, for D13.2:

**The guard's `WHERE` reduced to the id alone** — the unguarded write ADR-0118
names:

```
× restates the authorised-FROM status in the WHERE, not just the id
  → expected { id: 'load-h137759' } to deeply equal { id: 'load-h137759', …(1) }
```

**The `count === 0` refusal removed** (guard present but inert):

```
× LOSES to a concurrent write that moved the load between read and write
  → promise resolved "undefined" instead of rejecting
```

**The ADR-0115 nested `connect` reintroduced:**

```
× sets `submitted_by_id` as a SCALAR, never a nested connect
  → expected undefined to be 'user-jt' // Object.is equality
```

**The new DB race test, falsified against real Postgres** — `rejectLoad`'s guard
reduced to `where: { id }`:

```
× ADR-0113 — two racing REJECTIONS: one wins, one is refused, ONE load audit row
  → exactly one rejection may commit: expected [ … ] to have a length of 1 but got 2
  → the loser must be refused: expected [] to have a length of 1 but got +0
  → a refused rejection must leave no audit row: expected [ … ] to have a length of 1 but got 2
```

Two winners, and an audit log carrying two rows each claiming to be the
rejection — the ADR-0118 defect, reproduced for `rejectLoad` and then closed.

### 6.2 One assertion was found vacuous and tightened

The consequence test first read `expect(text).toContain('2')`, which passes on
any string containing a `2` — including the wrong one it was meant to exclude. It
now asserts the whole rendered sentence against the interpolated i18n string, and
was re-falsified afterwards (the Object.is failure quoted above is from the
tightened version).
