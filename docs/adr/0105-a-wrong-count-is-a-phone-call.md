# ADR-0105 — A wrong count is a phone call

**Date:** 2026-08-18 (Pacific)
**Status:** Accepted, implemented.
**Builds on:** ADR-0037 D6 + §3 (the anchor and the pool split), ADR-0060 D-3 (counts are stored at Pacific midnight), ADR-0065 (the Pacific day pin), ADR-0072 (recovery by appending), ADR-0078 D1 (the `created_at` tiebreak), ADR-0084 + Amendment 1 (the soft-void, its thirteen readers and their guard), ADR-0089 (Pacific instant windows).
**Retires:** the "call Bill to fix a wrong count" habit and the correction notes written on paper beside the sheet — ADR-0094 §"why the floor keeps calling", ADR-0100's discovery-mechanism argument.
**Deliberately does NOT do:** add a column, add a reader obligation, add an approval gate, or touch the payroll path. §D1, §D6, §"Premises that died".

---

## Context

ADR-0084 gave the floor a way to take back its own mistake: an operator who
double-keys a count can withdraw it, same day, from the iPad. Amendment 1 widened
that to anyone on shift at that site. Both were scoped to the **floor**, and the
ADR closed the door on the desk in as many words:

> **Letting managers void from the desktop too.** Deliberately out of scope. The
> office already has `/admin/inventory/anchors`, and adding a second desktop
> correction path before anyone has asked for one is inventing a mechanism to
> maintain.

Somebody has now asked. The case is the one ADR-0084 itself named and left open:

> The office carries prior-day corrections. A count discovered wrong the next
> morning is a phone call, not a tap.

That sentence describes the current state accurately and it is the defect. A
manager who knows the right number has exactly three options today, and all three
are bad:

1. **Ask the operator to void and re-enter it.** Only works the same Pacific day,
   only if that operator is still on shift, and it is the floor redoing work the
   office has already checked.
2. **`/admin/inventory/anchors` → Re-activate.** Admin-only, and it is the wrong
   verb. Re-activation _out-votes_ a count by copying an earlier row's figures
   forward; it leaves the wrong number live in the chain because "it happened".
   A mis-keyed count did not happen.
3. **Ring Bill.** Which is what actually occurs, and the right number ends up on
   paper next to the sheet — the exact habit ADR-0100 argued the system should
   stop depending on.

The count is the **anchor**. `onHand()` selects the latest live `physical`
snapshot and the floor balance, the loads/inventory screens, the EOD block on the
daily report and the COR filing that goes to MRC are all computed forward from
it. ADR-0072 said it in one line and it is still the whole story: a mistyped
count does not produce a wrong count, **it silently moves the entire floor.**
Leaving the only correction path as a phone call means that movement persists for
as long as the call takes to happen.

---

## Decision

### D1 — A correction is an edit IN PLACE, expressed as the two mechanisms we already have

The corrected value becomes authoritative and the prior value is **retained**:

1. the corrected value is written as a **new `physical` snapshot carrying the
   original's `snapshot_at`** — ADR-0072's "recovery by appending", so no counted
   figure is ever erased or rewritten; and
2. the row it corrects is **soft-voided** with ADR-0084's existing `voided_at` /
   `voided_by` columns, so it drops out of anchor selection.

Keeping the original's `snapshot_at` is what makes this an edit _in place_ rather
than a new count: the corrected number belongs to the day it was counted, so
every day-keyed reader — the EOD block, the COR window, `anchorFlowBounds` — sees
the right number on the day the wrong one was on. Stamping `now` would move
yesterday's count onto today and re-attribute a day of flows to it.

**No new column, and that is the load-bearing choice.** ADR-0084 D2 found
**thirteen** anchor readers on this table, written over eight months by passes
that did not know about each other, and pinned them with one importable
`NOT_VOIDED` predicate plus a source-parsing guard test. A parallel
`superseded_at` would have to be added to all thirteen, and its omission failure
mode is silent in precisely the way the original one was: the floor anchors on a
number a manager has already replaced and nothing reports it. Reusing `voided_at`
means this feature adds **zero** new reader obligations — the moment the stamp
lands, every reader that already honours ADR-0084 honours this too.

The cost, stated rather than glossed: `voided_at` now carries two meanings —
_withdrawn_ (ADR-0084) and _corrected away_ (here). They are distinguished by the
audit row's `reason`, never by the column. That is a real loss of resolution at
the column level, and it buys thirteen readers that cannot be wrong.

Composing with ADR-0084 also gets one property for free: re-activation already
refuses to restore **from** a voided row (422 `snapshot_voided`), so a
corrected-away value cannot be laundered back into the chain by a later admin.

### D2 — Manager or admin, at that site. Operators are unchanged.

`requireManagerForSite` (via `requireActivatedManager`, which layers the ADR-0037
D7 rollout gate every sibling `/api/manager/[site]/**` route carries). Anonymous →
401; **operator → 403**; unknown site → 404; manager off-site → 403; admin and
ADR-0024 all-sites managers reach either site.

Operators keep exactly what ADR-0084 Amendment 1 gave them and not one thing
more: a same-day, site-scoped self-void on the iPad. This route grants the floor
no new capability and removes none. A snapshot id belonging to the other site is
a **404, not a 403** — Eugene and Woodland are separate MRC contracts in separate
jurisdictions (hard rule #2), and a 403 would confirm the id exists.

### D3 — Today and yesterday, Pacific. Two days back is refused.

The window is the current Pacific calendar day and the one before it, resolved
through `pacificDayStartInstantPlus(±1)` — never the device clock, never
server-local. The container runs UTC, so a server-local "today" flips at 5 PM
Pacific and would start refusing an evening manager's real day while accepting
tomorrow's.

Why two days and not one, and why not thirty:

- **Not one.** ADR-0084's same-day bound existed because the audience was a floor
  operator and the office was the escape hatch. Here the caller **is** the
  office; there is nobody to escalate to, so the reasoning that produced the
  one-day bound does not apply. The case ADR-0084 explicitly deferred — "a count
  discovered wrong the next morning" — is the main case this exists for, and it
  is a **yesterday** case.
- **Not thirty.** The further back a correction reaches, the more it silently
  restates numbers that have already left the building: the EOD report is sent
  daily, the COR is filed monthly with MRC. Two days covers the real workflow and
  stops short of restating a day anyone has acted on.

Beyond the window the request is refused **409 `outside_correction_window`**,
with a body naming the counted day, today, the earliest correctable day and where
to go instead. Deliberately **not** `requires_amendment` (ADR-0084 D4 / ADR-0079
D4): that token means "a human with more authority than you must do this" and it
names the office as the route. Sending a manager to themselves would be false,
and it would teach a client to render an amendment affordance for a request no
amendment workflow accepts.

The window helper steps the Pacific **calendar** in both directions rather than
subtracting 86,400,000 ms. That is not fastidiousness: the repo has a measured
defect from exactly that arithmetic — on the 2026-11-01 fall-back day the naive
form produced a **zero-width** window, and a zero-width `lt` bound drops every row
in range. A correction window that collapses one day a year, in a path that
restates a billing anchor, is a money defect. Pinned by a test asserting the
two-day window is **49 hours** across the fall-back.

### D4 — No approval gate. Bill's decision.

The manager types the right number and it is the right number. No second
signature, no pending state, no ADR-0028-style four-eyes workflow, no ADR-0066 AP
peer routing. This is a deliberate departure from every other correction path in
the app, and it is recorded here so that nobody later "restores" a gate that was
never removed.

The reasoning that makes it defensible is the blast radius, which is the same
argument ADR-0084 used for letting an operator void without a manager, inverted:
a correction can only ever move the anchor to a number a human at the site is
asserting, it is bounded to a two-day window, it retains the value it replaced,
and it is audited with the actor. What it cannot do is go unnoticed.

### D5 — The delta keeps the ORIGINAL's baseline, and must not be re-derived

`reconciled_delta` is `physical − computed` at reconcile time (ADR-0037 D6) — the
drift between what was counted and what the running balance predicted. A
correction asserts **the count was mis-keyed**, not that the floor moved, so the
computed baseline is by construction unchanged:

```
correctedDelta = originalDelta + (correctedTotal − originalTotal)
```

which is exact, since `originalDelta = originalTotal − computed`.

**Calling `reconcilePhysicalCount` to re-derive it would be wrong, and silently
so.** That function computes `onHand(siteId, countedAt)`, whose selector is
`snapshot_at <= asOf` ordered `snapshot_at DESC, created_at DESC` — and the
corrected row carries the **original's** `snapshot_at`, so the row being
corrected ties on `snapshot_at` and wins the `created_at` tiebreak. Worse,
`onHand` runs on the shared client rather than the caller's transaction (its own
`tx` parameter documents this), so the soft-void stamped microseconds earlier is
invisible to it. The re-derived delta would therefore be measured against **the
very number being corrected** — recording the size of the typo where the drift
against the running balance belongs, on the column the C6 `physical_reconcile`
audit finding reads.

In the worked fixture: a count of 2,483 with delta 17 corrected to 2,438 must
record **−28**. The naive re-derivation yields **−45**, which is just
`2438 − 2483`. Both numbers look plausible on a screen. Falsified in the suite.

A legacy row whose delta is NULL stays NULL. "We do not know" is true, and it is
never backfilled from anything — ADR-0078 Am.1's `uploaded_by` lesson.

### D6 — The audit is a CONDITION of the write, not a side effect of it

Both rows are written on the same transaction client as the state change (hard
rule #6):

| Row      | On                         | Carries                                                                                                                                                                                                                                                 |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insert` | the **new** snapshot       | `corrected_from`, `counted_by`, the totals, the pools, `reason`                                                                                                                                                                                         |
| `update` | the **corrected** snapshot | `actor_user_id` + `corrected_by` (**who**), `voided_at` (**when**), `before.physical_total` → `after.physical_total` and every counted column (**from → to**), `entered_by` + `cross_operator` (**whose entry**), `corrected_to` (**the link forward**) |

The `insert` row is shaped like `reconcilePhysicalCount`'s so that
`eod-inventory.resolveCounter` and every other provenance reader keeps resolving
a corrected snapshot instead of finding no insert row and reporting null.
`corrected_from` / `corrected_to` make a chain of corrections traversable in both
directions, so walking from the head recovers every value that was ever on the
record, in order.

**And then it is read back, inside the transaction, before it commits.** Every
"audited in the same transaction" contract in this repo is one deleted line away
from not being one, and the deletion is **green**: the state change still lands,
every test about the state change still passes, and only the record is gone.
`assertCorrectionAudited` re-reads both rows on the transaction client and throws
if either is missing, which rolls back the void stamp and the corrected snapshot
with it. The failure mode of a missing audit row is "the correction did not
happen", never "the correction happened quietly".

The audit writer is injectable for exactly one reason: so a test can supply one
that writes nothing and observe the storage layer refuse, rather than asserting
in prose that it would. Production never passes it.

### D7 — Idempotency, and why the gates moved inside the claim

`voidSnapshot` runs its gates before its idempotency claim. This does the
opposite, and the reason is specific rather than stylistic. A void is idempotent
against its own effect: replayed, its gates see a voided row and ADR-0084 D7's
short-circuit answers "already gone", which is correct. **A correction is not.**
Its own effect voids the row it names — so a retry after a lost response, the
exact case an idempotency key exists for, would be refused `snapshot_voided` by
gate 3 before `withIdempotency` ever reached the stored answer. The manager would
be told their correction failed **after it succeeded**, and the obvious next
action is to correct it again.

Claiming first fixes that: a replay returns the stored body and re-executes no
gate. A refusal still writes nothing, because throwing inside the transaction
rolls the claim back too — a rejected request does not burn its key.

Two things this deliberately does **not** treat as idempotent successes:

- **Correcting to the value already on the row** is refused `no_change`. A no-op
  success would soft-void a perfectly good anchor and write a byte-identical
  replacement, adding a chain link that records no correction.
- **Losing a concurrent race** is refused `already_corrected`, not resolved to a
  no-op success the way racing voids are. Two voids agree on the outcome (the
  count is gone); two corrections carry different numbers and do not. Telling the
  loser their value is on the record when it is not would be the worst available
  answer.

### D8 — Online only

`manager.count.correct` is absent from `FLOOR_SCOPES`, so `/api/queue/replay`
answers 400 `unknown_scope`. ADR-0084 D6's reasoning applies with more force, not
less: a void removes an anchor, while a correction removes one **and writes
another**, addressed to one specific row by id. Replayed from a stale queue it
would restate a day the office has moved on from. The desktop is online by
definition.

---

## Alternatives considered

**A `superseded_at` / `corrected_by_snapshot_id` column pair.** Rejected — D1.
More expressive at the column level, thirteen new places to forget it, and the
forgetting is silent.

**Re-using `/admin/inventory/anchors` re-activation.** It is the wrong verb (it
out-votes a count rather than un-saying it), it is admin-only so it does not
reach the site managers who know the number, and it leaves the wrong count live
in the chain. It remains the correct tool for its own case and is untouched here —
including as the escape hatch this ADR's window refusal points at.

**Widening ADR-0084's void to managers, and having them re-enter the count.**
Two writes, two audit trails, and a window between them in which the site has no
anchor at all. It also loses the link: nothing would connect the withdrawal to
the number that replaced it, which is most of what makes the correction
auditable.

**An approval gate.** Bill's call — D4.

**A longer window.** Rejected — D3.

**Re-deriving the delta with `reconcilePhysicalCount`.** The obvious reuse, and
wrong — D5. Recorded because it would have shipped, passed its own tests, and put
a plausible wrong number on a money column.

---

## Premises that died on checking

Shipped code wins; each of these was in the brief and is not true of the repo.

1. **"Counts feed pay."** They do not, and the repo says so in an executed test
   rather than in prose. `src/lib/bonus/__tests__/saves-inventory.test.ts`
   asserts that the saves path — the one that feeds bonus payroll — writes to
   **nothing but `unit_status_movements`**, with
   `expect(touchedModels).not.toContain('siteInventorySnapshot')` as an explicit
   line. ADR-0083 is the reason: saves are paid units, not counted ones. A
   physical count feeds `onHand` → the floor balance, the EOD report, the COR
   filing and MRC billing — the **revenue** path, not the payroll one. Still
   money-adjacent, so the rigor stands; the mechanism named in the brief does
   not. Recorded so nobody looks for a bonus-side consequence of this change,
   and so nobody "reconnects" two paths that were deliberately separated.

2. **"ADR-0084's void targets the bonus grid."** It does not, and ADR-0084 §"The
   re-scope (G3)" records why: operators cannot reach the bonus grid at all, and
   `@@unique(bonus_employee_id, entry_date)` makes a duplicate bonus entry
   structurally impossible. The entity is `site_inventory_snapshots`, and that is
   what this extends. Verified against the shipped `voidSnapshot`, not inferred
   from the handoff's wording.

3. **"The manager can see the void state today."** ADR-0084 already recorded that
   `GET /api/manager/[site]/snapshots` has **no client consumer** — the only
   surface that lists counts to a manager is not rendered anywhere. Re-checked
   this session: still true. The correction API and its `GET` list are therefore
   server-complete and **screen-less**; see "Not verified".

---

## Consequences

- A manager who knows the right number puts it on the record themselves, for
  today or yesterday, and the floor recomputes immediately. The phone call and
  the paper note stop being the mechanism.
- Nothing is ever deleted. Every value that was on the record stays on the
  record, in a chain that reads forward and backward.
- **The daily report's "counted by" line names the MANAGER for a corrected
  count**, because `resolveCounter` reads the insert audit row's actor and the
  manager is who put that number on the record. The operator who physically
  counted is carried as `counted_by` in the payload and as `entered_by` on the
  correction row, so nothing is lost — but the rendered line changes. Recorded
  rather than fixed: changing `resolveCounter` changes a report that is sent, and
  that deserves its own evidence and its own ADR (the same call ADR-0084 made
  about the `created_at DESC` divergence).
- **A manager can now move the anchor without the floor and without an
  approval.** Bounded to two Pacific days, bounded to their own site, audited
  with both ids, and unable to erase what it replaced — but it is a real
  broadening of who can move a billing input, and it is recorded as one.
- The ADR-0084 reader set is unchanged. No new filter, no new obligation.

---

## Verification

Typecheck clean (`tsc --noEmit`, exit 0). ESLint clean at `--max-warnings 0`.
Prettier clean on every authored file.

**A false green was caught and is worth recording.** The first `npm run
typecheck` in the fresh worktree reported success while actually printing
`sh: 1: tsc: not found` — there was no `node_modules`, and the invocation was
piped into `tail`, so the reported exit code was `tail`'s. Every gate in this ADR
was re-run afterwards with the exit code preserved and asserted. A gate that
cannot fail is not a gate.

### The falsifications

Every guard was **broken on purpose, observed red, and restored** by a harness
that reverts the file in a `finally` block. Green-on-first-run was not accepted
as evidence for any of them.

| #   | Break                                            | Went red                                                                                          |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| F-a | `assertCorrectionAudited` call deleted           | ✅ 2 — `promise resolved "{ …(8) }" instead of rejecting`                                         |
| F-b | window narrowed to today only                    | ✅ 5 — `outside_correction_window` on yesterday's count                                           |
| F-c | window widened to three days                     | ✅ 3 — including `two-day Pacific window measured 97h across the fall-back: expected 97 to be 49` |
| F-d | delta re-derived against the row being corrected | ✅ 2 — `expected -45 to be -28`                                                                   |
| F-e | `entered_by` dropped from the audit payload      | ✅ 4 — `expected undefined to be 'user-jt'`                                                       |
| F-f | hard delete instead of soft-void                 | ✅ 4 — `expected undefined to be defined` (the retained row is gone)                              |
| F-g | manager role gate removed from the route         | ✅ 4 — `expected 404 to be 403` for the operator                                                  |

**F-f was fixed after its first run because it went red for the wrong reason.**
The fake Prisma had no `deleteMany`, so breaking the service produced
`deleteMany is not a function` — the double refusing, not the assertion catching.
A guard that goes red because the test double is missing a method has not tested
the claim it is named after. `deleteMany` was added to the fake and the
falsification re-run; it now fails on the retained-row assertion, which is the
claim.

### What the fixtures do and do not prove

The fake Prisma is a **generic where/orderBy evaluator** with no knowledge of
`voided_at`, `snapshot_kind`, or any column this feature cares about — the filter
is matched by the same `value === null` branch that would match `import_id: null`.
So the only thing deciding whether a corrected row leaves anchor selection is
`onHand`'s own where-clause. It additionally models **rollback** (tables restored
on a throw, rows shallow-copied so an in-place void stamp is undone), because
"a correction cannot be written without its audit" is a claim about what survives
an abort and a fake that committed regardless would report green against a real
database that rolled back.

Race conditions are injected at the one instant that reproduces them —
`db.hooks.afterEnteredByRead` fires between the service reading a live row and its
`NOT_VOIDED`-guarded `updateMany` — and each race test is paired with a
**no-hook control** asserting the same call succeeds, so neither can pass against
a service that always throws. The same control exists for the audit guard (`the
guard is not vacuous — the REAL writer satisfies it`) and for the route gate (`the
site manager IS admitted — the refusals above are the ROLE, not a dead route`).

Numeric assertions use real `Prisma.Decimal`.

### Not verified

- **Nothing was run against production or the live database.** No migration was
  authored or applied by this work — this feature adds no schema.
- **No Postgres was reachable from the build host** (`DR3_TEST_DATABASE_URL`
  unset), so the DB-backed suites skip. Two claims are about the database rather
  than the code and no fake can settle them: the planner honouring `NOT_VOIDED`
  in the real anchor `SELECT` under a correction, and two concurrent corrections
  producing exactly one winner. The first is already covered by ADR-0084's
  `snapshot-void.db.test.ts` in CI's `migrations` job; the second is covered here
  only by the modelled race. That is the honest status.
- **There is no screen.** The API and its correctable-counts list are complete and
  gated; no manager UI renders them, because the endpoint that would host it has
  no client consumer today (premise 3). A manager cannot reach this from a browser
  until that surface is built. Recorded as the top residual, not as a detail.
