# ADR-0090 — the floor could not tell two trucks apart, could not go back, and could not close a load it never worked

**Status:** Accepted, fully implemented — **all three shipped 2026-08-10 Pacific**. A and C in PR **#226** (merged 5:34 PM PT); **B in PR #227 (merged 7:54 PM PT) under [Amendment 1](#amendment-1--b-shipped-and-the-duration-freezes-at-the-first-finish)**, which also records Bill's `unload_duration_seconds` freeze decision (~6:56 PM PT) that unblocked it. §D3 below is superseded by that amendment and is marked BUILT there.
**A note on dates:** the merge commits carry `2026-08-11` UTC timestamps. Every event in this ADR — JT's three reports, Bill's decision, both merges — happened on **Monday 2026-08-10 Pacific**. Times in this document are Pacific.
**Builds on:** ADR-0065 Am.1 (the unfinished-loads list), ADR-0074 + Am.1 (open-portal haul visibility; the consumed-slot dead end), ADR-0077 D4 ("not recorded" is not zero), ADR-0078 (idempotent floor writes, the honest queue), ADR-0082 (claim takeover and honest attribution), ADR-0084 (the soft-void pattern — and the one decision this ADR deliberately inverts), ADR-0085 (the walk-up drop-off), ADR-0073 (manager load corrections — design-only, and the boundary this respects)

---

## Context

Three things from the floor on 2026-08-10, relayed by Bill, voiced by the
Woodland manager who works the iPad:

> 1. "The loads that were pending and need attention to be closed don't show the
>    Haul number. It would be ideal to know the haul number, in case the reason
>    we paused this haul is because we clicked the wrong one to begin with.
>    Sometimes there's multiple loads coming from same site in 1 day."
> 2. "You can't click the back button after clicking next. It'll be nice to have
>    the back function. Example: when you click a haul, take a pic, then enter
>    weight, click enter or next, start unload, enter units received — if you
>    want to go back to fix or check what you entered is correct, vision doesn't
>    let you."
> 3. "I'm not able to fix the pending one under my name, it doesn't let me 0 it
>    out... I fixed everybody else's."

All three were verified against production the same night. They are not three
opinions; they are three descriptions of the same three loads.

### The three loads

Every open load at Woodland was held by one person:

| Haul     | Source     | Status        | Started                  | What it actually is                                                              |
| -------- | ---------- | ------------- | ------------------------ | -------------------------------------------------------------------------------- |
| H-136796 | HWMA       | `arrived`     | 2026-08-10 3:49:16 PM PT | Tapped **19 seconds** before the Santa Rita check-in. A mis-tap, near-certainly. |
| H-136917 | Pleasanton | `in_progress` | —                        | Genuinely open                                                                   |
| H-135311 | Wexler     | `in_progress` | 2026-07-28               | A 13-day zombie from the pre-#225 early-start era                                |

Three loads, one name, and — on every operator surface — three cards reading
"a load, from a site, with a BOL". The haul number is the only field that
separates them, and no operator surface rendered it.

### Why (3) was not merely a missing button

`addStack` refuses `unitCount < 1` (`load-service.ts`, 422
`stack_unit_count_must_be_at_least_1`), so a load **cannot be zeroed**. And there
is no abandon, cancel, or void path at any of the seven stages. ADR-0073
(manager load corrections) is design-only and addresses **submitted** loads —
a different problem at a different point in the lifecycle.

So "0 it out" was not a UI gap over a working mechanism. There was no mechanism.
Every one of these has been closed by hand-audited DB surgery, which is a
DBA-shaped tool in the hands of an actor with no product-level guardrail — the
exact failure mode ADR-0073 was written to retire and has not yet retired.

---

## Decision

### D1 — A: the haul number leads, everywhere a load is identified

`haulNumberOf()` (`src/lib/loads/haul-number.ts`) is the single read, because the
number lives in two columns: `expected_loads.external_mymrc_haul_id` (NOT NULL on
the parent slot the operator tapped — authoritative for dock work) and the
nullable `inbound_loads.external_mymrc_haul_id` the MyMRC bridge stamps on rows
that never had a parent. Inlining a `??` chain at five call sites is precisely how
`held-by-panel.tsx` came to label a `submitted` load "Counting" for five days.

Rendered on: the queue expected-load cards, the unfinished-loads rows, the
held-by-others rows, the held-by panel, and the load-page header. The "Coming up"
hauls screen already showed it — it reads the MyMRC mirror, not `expected_loads`,
which is why that one surface was fine and the other five were not.

**Bare and mono, with no label string.** The hauls screen already trains the
operator that a mono `H-` token is the haul number, and an identifier reads as
itself. Inventing a label in three locales for it would add translation surface
and say nothing. Null (a walk-up drop-off, ADR-0085) omits the chip; the surfaces
keep their existing BOL line.

Exactly three query sites needed changing (`listSiteOpenLoads`, the load page's
`findUnique`, and the queue page's `expectedLoad.findMany`), which is why this is
the small one.

### D2 — C: `voided` is a new `LoadStatus` member, not a `voided_at` column

**This inverts ADR-0084, deliberately, and the reason is how the two tables are
read.**

`site_inventory_snapshots` is selected by RECENCY — `onHand()` takes the latest
`physical` row. There is no status allow-list to add a member to, so exclusion had
to be a new explicit predicate: `voided_at IS NULL`. ADR-0084 was right.

`inbound_loads` is read through status ALLOW-lists at every path that touches
money or inventory: `INVOICE_STATUSES` (MRC + SVDP exports, invoice freight legs),
`VERIFIED_INBOUND_STATUSES` (`onHand`, EOD inventory, audit legs, workbench
comparators), `OPEN_DOCK_STATUSES` (the floor's unfinished list),
`TAKEOVER_STATUSES`, `VERIFIABLE_FROM`. **A new enum member is excluded from every
one of them by construction.**

A `voided_at` column here would have been **opt-out**: each of those queries would
need a new predicate, and the one that got missed would silently bill a load the
floor had disowned. The enum member is **opt-in**, and it additionally makes
`ALLOWED_PRIOR` (`Record<LoadStatus, LoadStatus[]>`) a **compile error** until the
transition is declared — the only automatic tripwire in this codebase for "a
status was added and someone forgot about it". It fired on the first `tsc` run.

The columns (`voided_at`, `voided_by`, `void_reason`, `void_note`,
`voided_from_expected_load_id`) are therefore not the exclusion mechanism; they
are the record of why, who and when, so `status='voided'` can never disagree with
the facts about the void.

#### D2.1 — a void is not a zero

Deliberately NOT modelled as a 0-unit submit. A truck that arrived carrying
nothing is a real delivery with a real count, and it belongs in `submitted` where
the exports can see it. A load that was never a truck must not appear in a
delivery record at all. ADR-0077 D4 drew the same line between "not recorded" and
zero; collapsing them is how a phantom haul reaches MyMRC.

Hence the **reason picker**, and hence it is required: `wrong_haul` /
`truck_never_arrived` / `other` (+ a note, enforced at 422 server-side and by a
disabled button client-side). A mis-click and a no-show are different facts about
the world. Collapsing them loses the only signal separating a UI problem (are we
showing confusable cards?) from a carrier problem (is this transporter
no-showing?).

#### D2.2 — the slot is SEVERED, and that is what frees the haul

`inbound_loads.expected_load_id` is **UNIQUE**, and `startInboundLoad` is
idempotent on it: a tap on a consumed slot returns the EXISTING child. So a voided
child that kept its parent would hand every future tap back the dead load, and the
real truck could never check in — precisely the dead end ADR-0074 Am.1 closed from
the other side, rebuilt by the fix for a different one.

`voidLoad` therefore NULLs `expected_load_id` and records the original in
`voided_from_expected_load_id`. The slot becomes free for both check-in surfaces
without losing the answer to "which haul did they mis-tap?".

**`consumed-slot.ts` needed no change for this to work** — checked rather than
assumed. Severing means the voided load is no longer any slot's `inbound_load`, so
callers pass `null` and `toConsumedLoad` already returns "free". A one-line
`status === 'voided'` guard was added there anyway, as a boundary invariant: the
cost of being wrong is asymmetric and measured (a consumed-slot misread blocked
the Woodland floor for a morning on 2026-08-10), and a future void path that
forgets to sever now degrades to a re-checkable slot instead of a dead end.

#### D2.3 — voidable from the open-dock set only; the holder only; terminal

`ALLOWED_PRIOR.voided = [arrived, weight_captured, unload_started, in_progress,
finished]`. `finished` is included deliberately — H-135311 sat counted-but-
unsubmitted for 13 days, and refusing the void there would leave the single
most-stranded shape without a remedy. Past `submitted` the load has left the
floor's hands and may already sit on an MRC invoice; that is ADR-0073's territory,
and a floor-side void there would silently restate a filed number.

Nothing lists `voided` as a legal prior. **There is no un-void**, so a mis-tap
cannot re-enter billing by a second mis-tap. A second void call on an
already-voided load is a silent no-op rather than an error (the screen is
reachable from a stale tab, and the FIRST void is the one that happened) — the
same shape as `finishUnload`'s ADR-0078 D7 replay branch, minus the recompute,
because a voided load carries no units anywhere.

**Authorization is the holder, full stop.** Becoming the holder is the existing
ADR-0082 takeover, which is audited and names both parties. So a manager voids by
taking over first, and no second authorization path is invented — two places that
have to agree about who holds a load is exactly the defect ADR-0082 spent a
section removing.

#### D2.4 — online-only, not queued

Not in `FLOOR_SCOPES`, never enqueued — the same decision ADR-0082 D5 recorded for
the takeover, for the same reason. A void is contention-shaped ("this load is not
real"), and replaying one hours later would disown a load whose state has moved
on, possibly one a colleague picked up and legitimately worked. It captures no
operator data: refusing it offline costs a tap, whereas refusing a count loses a
count.

It redirects to the **queue**, not to a sign-out — which is where it differs from
`submitLoadAction` / `rejectLoadAction` and their ADR-0004 auto-logout. Those end
a piece of real work. A void is nearly always followed by "now tap the RIGHT
haul", and the freed slot is on the queue this redirect lands on. Forcing a PIN
re-entry between the mistake and its correction is friction with no safety value.

#### D2.5 — the status-blind readers, enumerated and patched

The allow-lists made most of the codebase safe for free. The danger was entirely
in readers that filter on `site_id` + a date window and take whatever rows fall
in it. All 23 `inboundLoad` query sites were audited; five are reachable by a
floor-voided `b2b_haul` load and are patched through one greppable helper,
`notVoidedLoadWhere` (`src/lib/loads/not-voided.ts`, mirroring
`notVoidedSnapshotWhere`):

- `compliance.ts` metric 1 (MyMRC submission timeliness) — a voided load past its
  deadline would have counted as `late` forever, degrading a **contractual**
  compliance grade with a truck that never came.
- `compliance.ts` metric 3 (dock SLA) — permanently dragging the SLA percentage.
- `compliance.ts` metric 7 (records retention) — setting the retention countdown
  from an event that did not happen.
- `ops-overview.ts` `loadsArrivedToday` (two call sites) — inflating the arrival
  count a manager reads as "trucks that came today".
- `workbook-promotion.ts` live-row conflict scan — wedging a workbook import
  against a conflict that is not one. (The snapshot leg beside it already did the
  equivalent via `notVoidedSnapshotWhere`; the inbound leg had no counterpart.)
- `reconciliation/[site]/upload` — a voided load offered as the DR3-side match for
  an external haul row, carrying `total_units` and `weight_lbs` from before it was
  disowned into a filing.

Sites deliberately NOT patched, recorded so the next reader does not re-derive it:
the `floor-inbound.ts`, `bulk-inbound.ts` and `inbound-bridge.ts` precedence
lookups are status-blind but scoped to `load_source_type` in
`AGGREGATE_SOURCE_TYPES` / `mymrc_haul` / `paper_bulk`. A dock load started from a
queue tap is `b2b_haul` (the model default), so the floor void cannot produce a
row those queries can see. **If a void is ever offered on an aggregate row they
become reachable** — which is why this is written down rather than left silent.

### D3 — B: going back — what ships, what does not, and why

> **Superseded by [Amendment 1](#amendment-1--b-shipped-and-the-duration-freezes-at-the-first-finish)
> (2026-08-11).** B is now built, to this design. The section is kept as written
> so the amendment's deviations are readable as deviations.

**Nothing for B ships in this change.** The design is recorded here because the
research behind it is the expensive part and it should not be redone.

Today's workflow is strictly forward-only and structurally so: stage dispatch is
`load.status` (server truth) plus three one-way client latches (`bolDone`,
`weightSkipped`, `showReject`). Only `showReject` has a control that resets it.
There is no back-edge in the state machine and no stage-level history — all seven
stages render at one URL, and the floor chrome's "Back" pill goes to the hub, by
an explicit ADR-0065 decision never to use `router.back()` (the offline queue and
`revalidatePath` + `redirect` make browser history a lie about where the operator
came from).

The design, per the constraint that back-to-REVIEW is always safe and
back-to-CORRECT must respect what the server already committed:

1. **Review (read-only), reachable from every stage.** Always safe, and it is
   literally half of what was asked ("check what you entered is correct"). Shows
   BOL captured y/n, weight or "no ticket", the stack list and running total.
   Needs `weight_lbs` and the photo kinds added to the load page's `select`.
2. **Weight, correctable in place before `submitted`.** A new audited write that
   changes `weight_lbs` WITHOUT a status transition, appending a second audit row
   (append-only — a corrected weight is never a mutation of the first record).
3. **Stacks, correctable while `in_progress` by soft-voiding an individual stack
   entry.** This is the one with teeth, and three findings shape it:
   - Both `finishUnload` sum sites must filter identically. The primary sum and
     the ADR-0078 D7 late-stack recompute BOTH write `total_units`; filtering one
     and not the other makes the replay path silently _restore_ voided units into
     a billed total.
   - `@@unique(load_id, stack_index)` is a FULL unique index. The answer is
     **monotonic indexes** (`nextIndex` computed over all stacks including voided,
     so an index is never reused) rather than making the index partial — simpler,
     and it preserves the positional meaning of the audit trail.
   - The `addStack` P2002 convergence check must additionally require
     `voided_at IS NULL`. Otherwise: a stack lands, its response is lost, the
     queue entry is retained, the operator voids the stack, the replay finds a
     byte-for-byte match and reports 201 — and a stack of mattresses vanishes from
     a billed total with no record anywhere. The honest outcome is a 409 that
     parks the entry as a conflict for a person.
   - The offer must be guarded to server-acked stacks only (real ids, not `tmp-`).
4. **`finished → in_progress` reopen: NOT designed, escalated.** See Open
   question 1.

**Why it is deferred rather than half-built:** (3) is a schema change plus two
billing-sum edits plus a replay-convergence edit, and a half-tested version of
that is how a load gets under-billed. With C shipped, a genuinely wrong count now
has a floor-side remedy that needs no DBA — void and re-do — where before it had
none. That is strictly better than today and does not foreclose (1)–(3).

### D4 — rollout gating: no new ADR-0047 surface

Stated explicitly because the question must be asked, not assumed. Every surface
touched here — the queue, the unfinished-loads block, the held-by panel, the load
page — is an EXISTING operator surface already gated on `ipad_queue`, and
`voidLoadAction` goes through the same `ctx()` that enforces it. Nothing new is
staff-visible, no new recipient roster exists, no mail is sent. So **no new
`rollout_surfaces` row and no ADR-0047 rollout entry.** The void inherits the
`ipad_queue` gate, which is the correct blast radius: a site that has not
activated the iPad queue cannot reach the void either.

---

## Consequences

- The floor can identify a load. Three trucks from one site on one day are three
  distinguishable cards.
- A mis-tapped load is closable in two taps by the person holding it, with a
  stated reason, and the real haul goes back on the queue.
- DB surgery is no longer the only remedy for the most common floor mistake.
- `LoadStatus` has an eleventh member, and six hand-maintained duplicates of
  status lists now exist across the codebase (three of them documented as
  byte-copies). This addition was safe because every money path uses an
  allow-list, but **that duplication is how the next enum addition gets missed** —
  see Open question 3.
- A voided load is still visible to a manager (filterable, struck-through badge)
  and is excluded from the manager's default view. Soft-void, never a delete.

## Open questions for Bill

1. **`finished → in_progress` reopen.** Should an operator at the Finish stage be
   able to go back and change the count? It is a real case (they see 47, know it
   should be 42). Not built, because `finishUnload` computes
   `unload_duration_seconds` from `unload_started_at` to _now_, so a re-finish
   inflates it by the entire reopen gap — and unload duration feeds throughput and
   productivity surfaces. Either the duration measures to the FIRST finish
   (correct for productivity, wrong as a literal timestamp) or the reopen is
   recorded as its own event. Both are product calls, not engineering ones.
2. **Should a `truck_never_arrived` void notify anyone?** It is the signal that a
   carrier no-showed, and right now it lands in a column nobody watches. Graded
   against ADR-0037 it is not a page — but it might be a daily-digest line or a
   dashboard tile.
3. **Consolidating the six status allow-lists** into one module. Out of scope
   here; recorded in OPEN-ITEMS.
4. **Should managers get the void too**, for a load already `submitted`? That is
   ADR-0073's scope and deliberately untouched — but ADR-0073 is still design-only,
   so the gap it describes remains open.

---

## Amendment 1 — B shipped, and the duration freezes at the first finish

**Accepted 2026-08-11.** Bill made the blocking product call (Open question 1) on
2026-08-10 at ~6:56 PM PT:

> **Freeze the duration at the first finish.** When a finished load is reopened
> to correct entries, `unload_duration_seconds` keeps the value computed at the
> FIRST finish. A re-finish must not recompute it.

That is the first of the two options D3/Open-question-1 laid out ("the duration
measures to the FIRST finish — correct for productivity, wrong as a literal
timestamp"), and it is what unblocked the whole of B.

### Am1.1 — why this decision is the one that mattered

`unload_duration_seconds` is not a diagnostic. It reaches throughput and
productivity surfaces, where it reads as _how long the truck took_. Recomputing
on a re-finish would add the entire reopen gap, so an operator who went back to
fix a number would show up as an operator who unloaded slowly — the surface that
exists to reward accuracy would have punished it. An operator who believes that
will not press the button, and will submit a count they know is wrong instead.
The feature would have shipped and then quietly not been used.

So the freeze is not a detail of the reopen; it is the precondition for the
reopen being usable, and the explainer copy on the button says it out loud in all
three locales (`load_review.reopen_explainer`).

### Am1.2 — the freeze is a WHERE clause, not a branch

The instruction was to make the freeze structural. It is enforced in
`finishUnload` as a conditional UPDATE:

```
UPDATE inbound_loads
   SET unload_finished_at = $now, unload_duration_seconds = $duration
 WHERE id = $load AND unload_duration_seconds IS NULL
```

Not a value read a moment earlier and branched on, and not a decision in the UI.
Three consequences, all wanted:

- The freeze holds **however** the second finish is reached — the reopen path, a
  replayed ADR-0078 queue entry, a hand-crafted POST.
- It holds under **concurrency**. Two finishes racing both compute a duration;
  the loser matches zero rows instead of winning a read-then-write.
- There is exactly **one writer** of those two columns and it refuses to write
  twice, so a future path that forgets the rule inherits it.

`finishUnload` therefore no longer routes through the shared `transition()`
helper — it hand-rolls the status flip, the total and the audit row in one
transaction alongside the conditional timing update, the same shape `voidLoad`
already used. The audit row records which of the two happened
(`unload_timing: 'measured' | 'frozen_at_first_finish'`), so a re-finish is
legible in the log without diffing timestamps.

**Deviation from D3, recorded: `unload_finished_at` is frozen alongside the
duration.** D3 did not consider the pair. Advancing the timestamp while freezing
the duration would leave the two disagreeing — `schema.prisma` documents the
column as `unload_started_at → unload_finished_at`, and anything recomputing the
duration from the timestamps would get a different answer from the stored one.
The instant of a re-finish is not lost; it is the audit row.

### Am1.3 — what shipped against D3, item by item

| D3 item                                           | Shipped                                                                                                                                                                          | Deviation                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1. Review (read-only) from every stage            | Yes — `review-panel.tsx`, opened from a control on all five stage statuses                                                                                                       | Panel, not a route (D3 implied as much); the stage is **hidden, not unmounted** — see Am1.4                    |
| 2. Weight correctable in place before `submitted` | Yes — `correctWeight`, no status transition, appends a second audit row                                                                                                          | Allowed set is `weight_captured / unload_started / in_progress / finished` — **`arrived` excluded**, see Am1.5 |
| 3. Stack soft-void while `in_progress`            | Yes — `voidStack`; both sums filter through one `NOT_VOIDED_STACK` constant; monotonic indexes; `addStack` P2002 requires `voided_at IS NULL`; offer guarded to server-acked ids | Adds an ordering guard D3 did not have — see Am1.6                                                             |
| 4. `finished → in_progress` reopen                | Yes — `reopenLoad`, audited, duration frozen                                                                                                                                     | Was "NOT designed, escalated"; Bill's call closed it                                                           |

D3's three stack findings were implemented exactly as written, and each is pinned
by a real-Postgres test in `src/lib/loads/back-navigation.db.test.ts` — a mocked
Prisma can only be written to agree with claims about a UNIQUE index, a SELECT's
filter and a conditional UPDATE.

### Am1.4 — the stage is HIDDEN, not unmounted

The one thing D3 did not anticipate. Every stage holds operator work in local
React state that exists nowhere else: `StageStacks` carries the optimistic `tmp-`
stacks queued while offline, the running total and the chosen count mode;
`StageWeight` carries a typed weight and a captured photo; the BOL→weight chain
carries a one-way `bolDone` latch. Swapping the stage out for the review panel
would have discarded all of it and dropped the operator back at the top of the
stage — a worse dead end than the one B exists to remove, and precisely the class
of defect ADR-0065 Am.1 and ADR-0074 Am.1 were both written about.

So the stage stays mounted inside a `hidden` container while the review renders
beside it. `bolDone` was additionally lifted out of the old `FromBol` wrapper into
`LoadWorkflow` for the same reason (that wrapper's `onBolDone` prop was also
declared and never used, and is gone).

### Am1.5 — `arrived` is excluded from the weight correction

D3 said "correctable in place before `submitted`". At `arrived` the operator is
still standing **on** the weight stage — there is nothing to go back to — and a
weight written without the stage's `arrived → weight_captured` move would leave
the workflow re-offering a stage they had just completed. `CORRECTABLE_STATUSES`
in `load-service.ts` therefore starts at `weight_captured`, and the review panel
does not offer the control at `arrived`.

### Am1.6 — the reopen's interaction with the ADR-0078 queue

D3 asked that a queued write never be double-submitted after back-nav. The
correction writes are the easy half: `reopenLoad`, `voidStack` and
`correctWeight` are **online-only** and absent from `FLOOR_SCOPES`, the same
decision ADR-0082 D5 and ADR-0090 D2.4 recorded, for the same reasons — a
correction is a statement about the CURRENT state of a record, and replaying one
hours later applies it to a state that has moved on; refusing one offline costs a
tap, where refusing a count loses a count. `withIdempotency` is not involved
because none of the three is an append.

The **reverse** direction is the real hazard, and it is silent: a write queued
BEFORE the correction — a stack, a finish — replays afterwards and lands on top
of it. A queued `finish_unload` replayed against a load the operator has just
reopened would finish it out from under them mid-count.

The honest place to stop that is the OFFER. `pendingActionsForLoad(loadId)` (new,
in `offline-queue.ts`) counts this load's unsent actions, and the review panel
withholds all three corrections while it is non-zero **and says why** — a control
that is merely absent teaches the operator the feature is broken; a sentence
explaining that their earlier taps are still in flight teaches them to wait. It
re-reads on a 3 s tick so a correction becomes available as the queue drains,
without a reload, and it **fails closed**: an unreadable IndexedDB is not an empty
queue. Reading (the half JT asked for first) is never gated on it.

Actions only, not uploads: a queued photo changes no number, and reading the
uploads store materialises every Blob — the cost the `queueCounts` G4 note exists
to avoid. There is no `by-load` index on `pending_actions` (only `pending_uploads`
has one) and adding one would mean an IndexedDB version bump on live iPads to
filter a store that is normally a handful of rows.

### Am1.7 — the reopen edge is declared in `ALLOWED_PRIOR`, then narrowed

`ALLOWED_PRIOR.in_progress` gains `finished`. It is declared there rather than
guarded privately because that table is the single statement of which edges
exist, and its completeness is what makes it the compile-time tripwire D2 relied
on; an edge that guarded itself elsewhere would make the table a partial truth.

But two writers now land on `in_progress` and they mean different things. So
`transition()` gained an `allowedFrom` narrowing — an INTERSECTION with the
declared set, so a caller can only ever restrict, never widen — and `beginUnload`
passes `['unload_started']` while `reopenLoad` passes `['finished']`. Without
that, a hand-crafted `beginUnloadAction` POST would silently reopen a finished
load through the door-open path, with no reopen reason on the audit row. That is
pinned by its own test, and the test was falsified (it goes red when the
narrowing is removed).

**What the reopen deliberately does not change:**

- **The slot.** `expected_load_id` is untouched and `in_progress` is inside
  `OPEN_DOCK_STATUSES`, so a reopened load still consumes its haul — it is live
  work again and the real truck must not check in underneath it. Exactly the
  opposite of the void, which severs the slot because the load was never real.
- **The void's reach.** `ALLOWED_PRIOR.voided` already lists both `in_progress`
  and `finished`, so a reopen moves the load between two equally voidable states.
  Checked, and asserted through the service rather than by restating the table.
- **`total_units`.** Recomputed on the re-finish from the live stacks, which is
  the entire point: the duration is frozen, the COUNT is not.

### Am1.8 — no new status, so AW-4 is untouched

This change adds an EDGE, not a `LoadStatus` member, so the six hand-maintained
allow-lists flagged in OPEN-ITEMS AW-4 need no edit and none was made. The
consolidation was deliberately NOT folded in here: it spans six files across the
export, inventory and audit paths, and bundling it with two billing-sum edits and
a schema change would put a refactor with no test of its own inside the diff that
carries the money risk. AW-4 stays open.

### Am1.9 — rollout gating: still no new ADR-0047 surface

Same reasoning as D4, re-checked rather than assumed. Every surface touched is an
existing operator surface already gated on `ipad_queue`, and all three new server
actions go through the same `ctx()` that enforces it. Nothing new is
staff-visible, no recipient roster exists, no mail is sent. No `rollout_surfaces`
row, no ADR-0047 entry.

### Am1.10 — schema

`load_stacks` gains `voided_at` / `voided_by` (migration
`20260842_adr0090_back_navigation`, purely additive, idempotent, one FK
`ON DELETE SET NULL` and one `voided_at IS NOT NULL OR voided_by IS NULL` CHECK,
mirroring ADR-0084 and the load void beside it). Every existing stack has
`voided_at IS NULL`, which is exactly what the new sum filters select, so the
billed total of every load already in the database is unchanged by construction.

`@@unique(load_id, stack_index)` stays FULL rather than becoming partial, per D3.
Monotonic indexes preserve the positional meaning of the audit trail and — the
load-bearing part — make a P2002 at a voided index provably a replay of the write
that was voided, which is what licenses the 409. A partial index would have
reopened those indexes for reuse and made the two cases indistinguishable.

**No `reopened_at` column.** The reopen lives in `audit_log` (actor, instant,
from/to, `reason: 'reopened_for_correction'`), which is append-only and already
rendered on the manager load page. A column would be a second place that has to
agree with the audit log about one event.

### Am1.11 — one accepted residual

**An offline-queued stack cannot be voided.** A `tmp-` id exists only in the tab
that minted it, so there is no server row to name; the offer is guarded to
server-acked ids, per D3. The operator's route is to wait for the queue to drain
and then correct — which is the same wait the ordering guard in Am1.6 already
imposes. Recorded in OPEN-ITEMS rather than left silent.

### Am1.12 — consequences

- The floor can check every entry from every stage, and the read is never gated
  on the write's conditions.
- A wrong weight, a wrong stack and a wrong final count each have a floor-side
  remedy that is not "void the load and re-walk the truck".
- Going back never costs an operator their measured unload time, and the button
  says so.
- `total_units` now has one filter constant with two call sites instead of two
  unfiltered sums, so a third sum site added later has an obvious thing to reach
  for.
- The manager load page marks voided stacks; without that a manager reconciling a
  load would read "Stack 2 — 9 units" against a total that excludes those nine.

### Am1.13 — open questions still open

Open questions 2 (`truck_never_arrived` notification), 3 (allow-list
consolidation / AW-4) and 4 (manager void of a `submitted` load / ADR-0073) are
untouched by this amendment and remain for Bill.
