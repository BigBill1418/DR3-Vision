# ADR-0109 — Three photos where the flow asks for one, and the cap is per capture point

**Date:** 2026-08-18 (Pacific)
**Status:** Accepted
**Extends:** ADR-0078 (iPad reliability — idempotent writes and an honest queue), ADR-0086 (capture-time photo grants)
**Brief:** Handoff #264 Item 1, under Bill's governing objective _no more sheets_
**Retires:** the floor's extra-photo side channel — pictures of damage, contamination and placards that lived on the iPad camera roll and were texted or emailed, because the load record had room for exactly one

---

## 1. What was asked, and the premise that died

The handoff said:

> Allow **up to 3 photos total per load**. **One required** (unchanged current
> behavior); photos 2 and 3 optional. **Generic, unnamed.**

Measured against production on 2026-08-18, "3 photos total per load" is not a
cap — it is already the ordinary case, and for four loads it is already exceeded:

```
total_photos=219                    loads_with_photos=87
by_kind bol=102  weight_ticket=22  door_open=93  rejection=2

photos_per_load n=2 loads=57
photos_per_load n=3 loads=21
photos_per_load n=4 loads=4
photos_per_load n=5 loads=4
photos_per_load n=6 loads=1
```

An ordinary inbound load takes **three photos as its normal path** — BOL
(`stage-bol`), weight ticket (`stage-weight`), door-open (`stage-door`) — because
they are three separate stages of the workflow, each with its own required
capture. A per-load ceiling of three would have refused the door-open photo on
every load that also took a weight ticket. Door-open is the capture that starts
the unload timer (ADR-0012 §1). **The cap as literally specified would have
stopped the floor on the morning it shipped.**

So the ceiling is **per capture point** — per `(load_id, kind)`. Three photos
wherever the flow asks for one: one required and unchanged, two optional and
unnamed. That satisfies every clause of the brief except the word "total", and
the word "total" is the one the data refuses.

## 2. The capability already existed. Only the bound is new.

`PhotoInput`'s primary button was disabled only while `status === 'uploading'`.
After a successful capture it stayed live, so re-tapping it opened the camera and
uploaded **another** photo of the same kind. Nothing anywhere counted them.

The floor found it:

```
load                                  kind    n  distinct storage_keys  window
fce4fbc5-9fca-4d50-8afb-d074b8994e74  bol     4  4                      3m 38s
70a3e89c-21d6-46fa-af33-83a4d30d2ec9  bol     3  3                      10s
8d7b07fc-e228-4078-9479-93b697e1bb6d  door_open 3 3                     44s
e2c5df91-299e-4bc2-a2c2-d1b525538058  door_open 3 3                     19s
… 18 (load, kind) pairs in total carry more than one row
```

Every one has **distinct storage keys**, so these are not ADR-0078 duplicate
confirms — they are genuinely separate captures, seconds to minutes apart.
`page.tsx` even carried the comment _"Deduped: several rows of one kind (a
retaken photo) is one answer to 'was the BOL captured'"_, which is the same
observation written down and then not acted on.

This ADR therefore adds **no pipeline**. It adds a bound, a count, and a named
affordance to a behaviour the operation was already relying on informally.

## 3. Decision

**D1 — The ceiling is 3 per `(load_id, kind)`.** `MAX_PHOTOS_PER_KIND` lives in
`src/lib/loads/photo-limit.ts`, a Prisma-free module so the browser bundle and
the API route read the same number. A client that hides its control at a
different number than the server refuses at is precisely the "control whose only
outcome is a refusal" CONTRIBUTING.md forbids on `/operator`.

**D2 — Photos 2 and 3 are GENERIC.** No slot labels, no `PhotoKind` values
added, no schema change. The affordance reads "Add another photo" in all three
locales. The floor's extra photo is whatever the operator needed a picture of;
naming the slots would ask them to classify it before they can take it, which is
how a capture that takes four seconds becomes one that takes thirty.

**D3 — Enforced at `/api/photos/confirm`, INSIDE the `withIdempotency`
callback.** This is the load-bearing placement and the one most likely to be
"tidied up" later.

`withIdempotency` runs its callback only when it just claimed the key; a replay
of an already-claimed key returns the stored response without reaching the
callback at all. Putting the count inside therefore means **a photo whose confirm
landed and whose response was lost still drains**, and its own already-written
row can never be the thing that blocks it.

Hoisting the count above the claim — the natural "check before you do work"
refactor — inverts that. Falsified by hand on 2026-08-18 against real Postgres:

```
× a double flush of three queued photos writes THREE rows, not six
  → Error: photo_limit_reached
× a full load still replays a photo that already landed
  → Error: photo_limit_reached
```

That is a fourth-photo guard eating a **first** photo's replay: the row is in the
database, the device's queue entry can never clear, and the conflicts screen
accumulates a photo that is not missing.

**D4 — NOT enforced at `/api/photos/upload-url`.** Refusing the mint would save
an R2 PUT of bytes that can never be confirmed, and that is genuinely tempting.
It is wrong for the same reason as D3: `replayUpload` re-mints on every photo
older than eight minutes, **including one whose confirm already succeeded**. A
capped mint answers 4xx, `classify()` in `offline-queue.ts` calls a hard 4xx a
conflict, conflicts are never retried — so a photo already safely in the database
would park on the conflicts screen forever. The wasted PUT costs bytes; that
would cost evidence.

**D5 — The refusal is 409, not 401 and not a bare 403.** `isAuthResponse` treats
401 as _"sign in and this will send"_, and no amount of signing in makes a fourth
photo fit — that is the 2026-08-10 Woodland failure shape (ADR-0078 G7), an
instruction that cannot work. 409 is a hard 4xx, so the queue parks it as a
`conflict:` for a person to decide about, which is the honest classification: the
photo is real, it is on the device, and the load has no room for it. The body
carries `{error, limit, held}` because "the limit is 3" and "you already have 3"
are different sentences to an operator holding a picture they cannot send.

**D6 — Concurrent drains are serialized with `pg_advisory_xact_lock`.**
Count-then-insert is not atomic under READ COMMITTED, and two drains of one load
are ordinary since ADR-0078 Am.1 made the photo gate site-scoped rather than
owner-scoped: two iPads may hold queued photos for the same load. Without the
lock both read 2 and both insert, landing 4. The advisory-lock pattern is the one
`recycling-rates.ts` already uses, and unlike `SELECT … FOR UPDATE` on the parent
it does not take a row lock on a load an operator may be writing to.

**D7 — The client count is SEEDED from the server.** The BOL stage is gated by a
client latch (`bolDone`), so a reload lands the operator back on a step whose
photos are already in the database. `page.tsx` derives `photo_counts` and threads
it through `LoadWorkflow` to each stage. Without it the screen would offer three
more taps on a step with room for none.

**D8 — A queued or sign-in-parked capture counts.** The blob is in IndexedDB and
`replayAll` will confirm it, so it is a row the load is going to hold. Counting
only completed uploads would let an operator working offline queue three and then
add three more, and the surplus would surface as conflicts on a drain hours later
— learning about a refusal long after the tap, which is the shape ADR-0078
exists to remove.

**D9 — The affordance is offered only from `done` and `queued`.** Not from
`signed_out`: that state's contract is _one instruction, once — sign in_, and a
second control saying "take another one" both dilutes it and grows a queue that
cannot drain until the same single action is taken. Not from `error`, where the
primary button is the retry.

## 4. The freshness composite — verified, not changed

The brief asked whether the load-freshness composite
`GREATEST(updated_at, newest stack, newest photo)` (ADR-0092 D1) includes photos
2 and 3. **It already did, and nothing was changed to make it so.**
`listOpenClaimsWithStaleness` selects `load_photos` with `orderBy: { uploaded_at:
'desc' }, take: 1` and **no `where` clause at all** — no kind filter, no cap. The
newest photo on the load wins whether it is the required one or the third.

That is a claim about code that can rot, so `stale-claim-photo-generic.test.ts`
now fences it in two directions: one test fails the moment anyone adds a `where`
to that select (the most likely tidy-up now that photos have a per-kind ceiling —
_"surely we only want the required one here?"_), and one proves the consequence
rather than the query shape, because a shape assertion alone would pass against a
composite that read the photo and threw it away.

## 5. Alternatives considered

**A per-load ceiling of 3, as literally briefed.** Rejected on measurement — §1.
It refuses the door-open photo on every load with a weight ticket.

**A `slot_index` or a `photo_role` column.** Rejected: it is the "no new
abstraction where an existing one extends" instruction, and it is worse for the
floor. An unnamed extra needs no decision from the operator; a named one does.
`(load_id, kind)` already carries everything the count needs.

**A partial unique index expressing "at most 3".** Not expressible in Postgres
without a counter column, which is a schema change and a second source of truth
for something `count(*)` answers exactly.

**Capping at the mint, or at both.** Rejected — D4. Both would break the replay
of an already-landed photo, and "at both" breaks it in the same place while
looking twice as careful.

**Enforcing only on the client.** Rejected: the offline queue replays
`/api/photos/confirm` from a device whose bundle may be days old. A client-side
ceiling is an affordance, not an invariant.

## 6. Consequences

- Nine production loads already hold more photos than this ceiling allows. Those
  rows are **not retracted** — the cap governs new writes only — and
  `photosRemaining()` clamps at 0 so a load holding four never renders a negative
  count. A load already over the ceiling takes no more (`held >= MAX`, not `===`).
- One real behaviour is withdrawn: an operator who today can take a fourth photo
  of one kind no longer can. That happened once in production (load `fce4fbc5`,
  four BOLs on 2026-08-10). Three is Bill's stated ceiling and the control is
  removed rather than left to refuse, so the floor meets a limit rather than an
  error.
- `LoadView.photo_kinds` was replaced by `photo_counts`, and the review panel's
  kind list is now projected from it. Two fields carrying one fact would have let
  a caller supply a kind list disagreeing with the counts — ADR-0091's standing
  lesson.
- Four new `photo.*` keys in en/es/ur.
- No migration. No new `PhotoKind`. No change to the auth path, the grant path,
  the idempotency contract, or the offline queue's schema or classification.

## 7. Verification

Against an ephemeral `postgres:16-alpine` with the full migration chain applied
by `prisma migrate deploy` (**not** left un-executed — the ADR-0084 residual
CONTRIBUTING.md names):

```
✓ src/lib/loads/photo-limit.db.test.ts (5 tests) 2747ms
✓ src/app/api/photos/confirm/photo-limit.route.test.ts (9 tests)
✓ src/app/operator/[site]/load/[id]/photo-input.limit.test.tsx (11 tests)
✓ src/lib/loads/stale-claim-photo-generic.test.ts (3 tests)
… Test Files 17 passed (17) · Tests 176 passed (176)
```

Each new guard was falsified by hand and the red is quoted verbatim in the suite
that owns it: the ceiling by deleting it from the route (4 failed | 5 passed),
the replay property by hoisting the count above the idempotency claim (2 failed |
3 passed), and the floor affordance by restoring the pre-change component (8
failed | 3 passed). In each case the tests that stayed green are named, because a
suite that only asserted the ceiling would have certified the broken arrangement
in the second experiment.
