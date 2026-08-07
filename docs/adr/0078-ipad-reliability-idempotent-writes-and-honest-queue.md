# ADR-0078 — iPad reliability: exactly-once floor writes, an honest queue, and visible connection state

**Date:** 2026-08-07
**Status:** Accepted, implemented
**Supersedes:** nothing. **Amends:** ADR-0006 (offline queue semantics), ADR-0060/0065 (floor write paths), ADR-0072 (anchor guardrail).

## Context

JT (Janette) asked for one thing: _"we need to make sure the connection isn't dropping … error-free and bulletproof for the iPad and operator connectivity."_ Every feature the floor is about to receive writes through this layer, so it is built and proven first.

An audit of the eleven iPad write paths found that the reliability layer described in ADR-0006 was, in several places, **not connected to anything**. The defects below are not hypotheses; each was verified against the code and, where possible, against production.

Two of them fired _during_ this work, in production, and are recorded here because they are the exact failure class this ADR exists to close.

### The defect table

| #   | Sev      | Defect                                                                                                                                                                                                                                                                                                                                                                                                  | Status   |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1  | CRITICAL | `reconcilePhysicalCount` appends a `site_inventory_snapshots` row unconditionally, with no natural key and no dedupe. Both anchor selectors order by `snapshot_at DESC` **with no tiebreaker** — and the floor route stores every count at Pacific _midnight_, so two counts on the same day are byte-identical in that column. Which one became the inventory anchor was decided by the query planner. | Fixed    |
| D2  | HIGH     | `stage-stacks.tsx` had no queue and no retry. A lost stack silently **undercounts** the load: `finishUnload` sums `load_stacks` into `total_units`, which is billed.                                                                                                                                                                                                                                    | Fixed    |
| D3  | HIGH     | `replayUpload` re-mints a _fresh_ R2 key before replaying, and `/api/photos/confirm` created a row unconditionally. A confirm whose response was lost produced **two `load_photos` rows**, with no natural key able to catch it.                                                                                                                                                                        | Fixed    |
| D4  | HIGH     | `enqueueAction` had **zero callers**, and `replayAll` POSTed to `/api/queue/replay` — **which did not exist**. Next answered 404, the hard-4xx branch classified that as a permanent conflict, and conflicts are never retried. Any queued action would have been stuck on its first attempt, invisibly.                                                                                                | Fixed    |
| D5  | HIGH     | The inbound, processed and count clients had a bare `catch { setError(…) }` and no queue import at all. A mid-submit disconnect **discarded the operator's entry**, leaving only a message telling them to type it again from memory.                                                                                                                                                                   | Fixed    |
| D6  | MED      | A double-tap on the same stack index raised P2002 and was rendered as "couldn't save" — for a write that had **landed**. The operator's natural response is to re-enter a count that already exists.                                                                                                                                                                                                    | Fixed    |
| D7  | MED      | `finishUnload` retried after a successful commit hit `TransitionError`, reporting failure for the one thing that definitely succeeded.                                                                                                                                                                                                                                                                  | Fixed    |
| D8  | —        | **Not a defect — a design narrowing.** See below.                                                                                                                                                                                                                                                                                                                                                       | Recorded |
| D9  | HIGH     | No connection-state UI anywhere. `navigator.onLine` was consulted only _inside_ `offline-queue.ts`, to make decisions no operator ever saw.                                                                                                                                                                                                                                                             | Fixed    |
| D10 | HIGH     | The count route took **no date at all**; the day was derived server-side at write time. Correct for a live submit, silently wrong for a replay — an entry queued Tuesday evening would anchor **Wednesday's** inventory with Tuesday's count.                                                                                                                                                           | Fixed    |
| D11 | MED      | `assertOwn` / `ctx` threw bare `Error`s that `loadsErrorResponse` cannot map, so routine outcomes ("this load isn't yours") surfaced as **500s**.                                                                                                                                                                                                                                                       | Fixed    |

### D8 — the ADR-0006 narrowing, stated explicitly

ADR-0006 says a submission is _"complete from the user's perspective even before the photo finishes uploading."_ That remains true **for photos** and is preserved: `photo-input.tsx` still advances the workflow on a durable local enqueue.

ADR-0078 narrows it. **For count-class writes — count, inbound, processed, stacks, finish — a green/saved state requires a server-acknowledged 2xx.** A queued count shows a visually distinct "queued" state that reports no numbers, because the reconciliation has not happened and previewing it would be the same false confirmation in a quieter font. Photos keep ADR-0006 semantics plus a queued badge.

The reason for the split: a photo is evidence that can arrive late without changing a number. A count _is_ the number.

### Two live incidents, mid-build

**`load_photos` had ZERO rows. Ever.** Every browser upload since the feature shipped had failed the CORS preflight against the R2 bucket (403 — the bucket had no CORS rule). One iPad had silently accumulated 97 photos. The server could not see it: a request that dies at the preflight never arrives. On the device, a blocked preflight surfaces as an opaque `TypeError` — **byte-identical** to the one a genuinely offline device throws — so the queue classified it as "offline" and patiently retried forever. Fixed at the infrastructure level (CORS rule added, preflight now 204).

**The parked rows would not drain even after the fix.** `replayUpload` marked any re-mint 4xx as `conflict:`, and the deployed app had no way to see or clear that flag. Photos queued against a load owned by a _different_ operator login get 403 on re-mint and park permanently — while still being counted as "pending". The device read 99-and-not-draining.

Both are the same class as D9: **a client-side failure the server cannot observe and the operator cannot see.**

## Decision

**D1 — a recorded tiebreaker, not an inferred one.** `site_inventory_snapshots` gains `created_at`. Both selectors order by `[{ snapshot_at: desc }, { created_at: desc }]`, so the count _entered last_ wins, deterministically. Existing rows backfill to their own `snapshot_at`, which makes the tiebreaker a strict no-op for every pre-existing row.

**Exactly-once via a claimed key, in the write's own transaction.** `IdempotencyKey` (`key` PK, scope, actor, site, `request_hash`, stored response) with `INSERT … ON CONFLICT (key) DO NOTHING` **inside the same `$transaction` as the business write**. This is non-negotiable and both failure directions explain why: a claim that commits without its write burns the key and answers a retry with success for a count that vanished; a write that commits without its claim simply has no defence. Postgres blocks on a conflicting _uncommitted_ row rather than skipping it, so the claim also serialises concurrent double-taps.

A replay is pinned to its original **actor, scope and payload hash**. A key is an opaque bearer string; without an owner check, a captured or guessed one reads back someone else's stored response.

**No natural keys are invented where convergence already exists** (processed upsert, inbound day-keyed write, `startInboundLoad`, `LoadStack` unique). Those get response-dedupe only, and the residual non-atomicity is documented in `floor-writes.ts` — it fails in the benign direction.

**One write surface, two transports.** `src/lib/operator/floor-writes.ts` holds every floor write as a named scope with a schema, a rollout gate, a day-pin policy and a handler. The live routes and `/api/queue/replay` both dispatch through it, so "a replay is subject to the same gates as a live submit" is structural rather than a claim two files must keep agreeing on.

**The day pin refuses; it never retargets and never drops.** A day-addressed scope declares `dayAddressed: true` and a replay carrying no day is **refused**, not exempted — the earlier `if (day !== null)` shape let an old-format entry skip the pin entirely. A refused entry parks as a conflict for a person.

**Old-shell compatibility is a first-class constraint.** The iPads are kiosks whose service worker does not `skipWaiting`, so the previous bundle persists until an operator accepts the update prompt. `countDate` is therefore **optional** in the schema and defaulted **on the live route only** — behaviour-identical to the pre-ADR-0078 route. Requiring it would have 422'd every count at both sites for the whole update window: an outage caused by the reliability fix.

**Connection state is chrome, not a page feature.** One hook, one component, mounted once in `FloorChrome`, on all operator screens by construction. It distinguishes four states, and `uploads-blocked` exists because of the incident above: the app reachable while object storage is not is a _different problem with a different fix_, and painting it as "offline" is what hid a weeks-long outage.

**The badge counts what is still trying.** Parked rows are counted separately. A number that sits at 99 across shifts teaches operators that the number means nothing.

**Conflicts get a screen, with Retry and Discard.** Retry clears the flag (and, for uploads, the cached presign — a human retry means a fresh mint). Discard is **audited server-side first**, and the local row is removed only on a 2xx: a refused entry exists nowhere else, so audit-then-delete is the only ordering that cannot lose the record.

## Alternatives considered

- **A unique index on `(site_id, snapshot_at, snapshot_kind)`** instead of idempotency keys — rejected: it forbids a legitimate second count on the same day, which is a real operator action, and it would have made D6's false-failure class worse rather than better.
- **Claiming the key in its own transaction** (simpler, no `tx` threading) — rejected; see the two failure directions above.
- **Relaxing the ownership check for replayed photos** (the photo is the same physical evidence regardless of who is signed in now) — rejected. This is a shared device where operator identity is the entire point of the PIN. The refusal stands; what changed is that it now says what to do about it.
- **`navigator.onLine` alone for connection state** — rejected: on iPadOS it reports whether an interface exists, not whether anything is reachable. An iPad on an AP with a dead uplink reports `true`, which is precisely JT's complaint.
- **A new rollout surface for the conflicts screen** — rejected: it is the other half of a queue that is already live, and a version that could be switched off separately would leave stuck entries with nowhere to surface.

## Consequences

- One additive migration: `idempotency_keys` + `site_inventory_snapshots.created_at`. No drops, no type changes, idempotent on re-run (the ADD and its backfill are bound inside one existence check — the obvious `IF NOT EXISTS` + `WHERE` shape would _reset_ a real post-migration `created_at` on a second application).
- IndexedDB `DB_VERSION` 2. v1 rows are preserved and upgraded, never dropped: uploads keep their blobs and gain a minted idempotency key; undispatchable v1 action rows are flagged as conflicts rather than deleted.
- A daily TTL sweep (`/api/internal/idempotency/sweep`, 7 days) on the established internal-cron pattern.
- `addStackAction` / `finishUnloadAction` / `addConcernAction` take the idempotency key as their **first** argument, so a call site that forgets it is a compile error rather than a silently shifted argument.
- Badge counts are answered from an indexed `state` scalar. Counting by scanning records deserialises every queued photo Blob — hundreds of multi-megabyte reads per minute on the one tab holding data that exists nowhere else.
- **R2 bucket CORS is hand-set infrastructure, not code.** Recorded as an open item; it is currently reproducible only from a shell history.

## Premises that died on checking

Recorded because the handoff asserted them and shipped code disagreed:

1. **"Add `conflicts` to `WORK_SEGMENTS` or the page renders black."** False as built. `resolveFloorNav` keys on the _second_ path segment, and the screen is nested at `/operator/<site>/queue/conflicts`, so it inherits back-to-hub and Log Out with no change to `floor-nav.ts`. Pinned by a test so a future move to `/operator/<site>/conflicts` fails loudly.
2. **"The locale-parity test enforces EN/ES/UR keys."** Both a runtime test _and_ a compile-time `Widen<T>` in `dictionary.ts` do; a missing key is a `tsc` error before any test runs.
3. **"ADR-0012 §4 — no new deps."** ADR-0012 §4 is the decision to swap `next-pwa` for Serwist and imposes no dependency freeze. `offline-queue.ts` has cited a constraint that does not exist. (`fake-indexeddb` added as a devDependency.)
4. **The repo has no ephemeral-Postgres test harness.** The one existing real-DB test self-skips and has therefore **never run in CI**. Since ADR-0078's core claims are claims about Postgres — `ON CONFLICT` returning zero rows, a PK refusing a duplicate, `ORDER BY` breaking a tie — a mocked Prisma would have been enforcing the very rules the tests claim to check. CI's existing `migrations` job (which stood up a real PG16, applied the chain, and asserted nothing) now runs those suites against it.

## The drain engine, and the push-down contract

Bill, during the build: _"drain should happen no matter what page its on and it
should make sure all data is always pushed down - not as an afterthought."_

That is an architectural statement and it ruled out the shape this code had.
Replay lived INSIDE screens — `load-workflow` ran a sweep loop, `pending-banner`
ran a different one, every other screen ran none — so whether an operator's
queued count went anywhere depended on which page they happened to be looking at.

**The engine is mounted once, in `FloorShell`**, above all nine operator screens,
for the same reason the chrome is. Trigger matrix:

| Trigger                        | Why it exists                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| mount                          | anything queued by a previous session drains at once                                                              |
| `online`                       | the network came back                                                                                             |
| `visibilitychange` → visible   | a parked iPad wakes — and its timers were suspended precisely while parked, so the interval alone is useless here |
| `pageshow`                     | Safari BFCache restore, which fires no `visibilitychange` and re-runs no effects                                  |
| 30s interval (foreground only) | the AP reports online but the server is unreachable                                                               |
| **after every enqueue**        | a write that just failed over is retried NOW, not up to 30s later                                                 |

The last row is what makes "always pushed down" true rather than eventually true:
the queue is a retry path, not a waiting room.

**The push-down contract**, as a design principle the feature phases inherit:
_every_ operator write flows through the queue and the engine — online is an
immediate pass-through with a server ack, offline or failed is queued and
retried. So "all data is always pushed" is structural, and P2–P5 get it without
each re-implementing it.

**`replayAll` has exactly ONE caller in app code** (`drainNow`). The connection
hook used to call it too; with an always-on engine that meant two sweep owners
and two un-deduped count refreshes. A test greps the source to keep it at one.

### The honest limit on iOS

Background Sync would let the browser drain with the tab closed. **WebKit has
never shipped it**, and the DR3 floor runs on iPads. So registration is
capability-detected and is a silent no-op there — a supported outcome, not an
error path.

Stated plainly rather than implied: **on an iPad the queue drains whenever the
app is open on any screen, and resumes the instant it is foregrounded. There is
no closed-app execution.** We do not fake it and we do not claim it. Where the
API does exist (Android, desktop) it is registered as a genuine enhancement.

## G7 — the auth redirect that looked like success

The primary blocker of the 99-photo drain, and it never looked like a bug.

Operator sessions idle out after five minutes. `/api/photos/*` is not a public
path, so a session-less queue request was answered `307 → /login`; `fetch`
follows redirects, /login returns `200 text/html`, and `res.ok` was **true**. The
mint "succeeded", parsing the login page as JSON threw a SyntaxError, and that
was recorded as a generic _retryable, unlabelled_ error. The R2 PUT was never
reached. The queue retried forever and nothing said why. This is the ADR-0036
class that bit the reminder-tick on 2026-07-03, arriving through the photo queue.

Both halves are closed. The middleware answers `/api/*` with **401 JSON** instead
of redirecting (browser navigations keep their redirect — sending a _person_ to
/login is what it is for). And every queue fetch uses `redirect: 'manual'` and
treats a redirect, a 401, or a 2xx carrying HTML as `auth:` — a class of its own,
deliberately **not** a conflict, because nothing needs adjudicating: somebody
needs to sign in. The badge says "Sign in to send N items" and carries a return
path, so recovery is one tap and a PIN.

### G8c — signing back in returns you to where you were

The badge links to the name picker with `?next=<current path>`, threaded through
all three hops of the PIN flow (picker → keypad page → post-PIN push). Without
it an operator signing in mid-task lands on the hub and navigates back by hand,
and that friction makes a recovery affordance read as still-broken.

The parameter arrives in a URL and is handed to `router.push`, so it is
VALIDATED, not trusted — an unchecked push target is an open redirect on a shared
device in a browser that has just authenticated. `resolveFloorReturnPath` accepts
only a path under _this_ site's operator surface and refuses absolute URLs, the
protocol-relative `//host` form (which navigates off-site despite starting with a
slash, and is the exact bypass a naive `startsWith('/')` check misses), another
site's paths, and the pre-PIN screens themselves.

### The offline badge nearly went green again

The second review pass caught the G8 refactor reversing the guarantee that is
half this ADR's purpose. `replayAll` early-returns a fully-formed result when the
device is offline, and the new observer read "a result with no auth and no
blocked rows" as a successful sync — so one engine trigger would repaint a red
offline badge green, and stamp a "last sent" time for a sweep that never left the
device.

`ReplayResult` now carries `reached: boolean | null` — `false` when requests were
attempted and nothing got through, `true` when at least one got an HTTP response,
and `null` when nothing was attempted, because an empty queue is _no evidence_
and must not be read as health. That last case is also what keeps the dead-uplink
probe on a schedule now that the hook no longer runs its own sweep: on a `null`
result it asks `/healthz` directly instead of inferring health from silence.

## Recorded, not built: the capture-time upload grant

The remaining gap is that iOS drain requires a live session. The fix is a
capture-time grant: `/api/photos/upload-url` additionally returns an
HMAC-signed `upload_grant` over `{v, load_id, kind, storage_key, actor_user_id,
site_id, idempotency_key, exp≈14d}`, and both photo routes accept a session **or**
an `X-Upload-Grant` pinned to that grant's exact fields, moving them to the
established route-handler-is-the-real-gate pattern.

**Deliberately not in this change.** It needs a new secret (`PHOTO_GRANT_SECRET`)
with its own provisioning and rotation story, and a bearer credential that
authorises a write must not ride a money-path PR as a rider. Recorded in
OPEN-ITEMS as a proposed ADR. Until it lands, G8c makes the session requirement a
single tap rather than a dead end.

## What the adversarial review changed

An independent review before merge found three defects of the _same class this
ADR is about_ — a billed count disappearing while the UI reports success. All
three were introduced by the fix, which is worth recording plainly.

1. **`addStack`'s P2002 tolerance absorbed a genuinely different stack.** It
   keyed off "a key was present", never off whether the row already at that
   index _is_ this write — and a real double-tap mints two different keys, so
   the tolerance was the only thing standing between a collision and silence.
   `nextIndex` derives from rendered state, so after a reload (or on a second
   tab, which `assertOwn` permits) two different stacks can compute the same
   index; absorbing that returned 201, the replay loop deleted the queued entry,
   and the stack was gone from a billed total. Now the existing row must match
   `unit_count` and `count_mode` or it is a 409 and parks as a conflict. The
   original test used the same `unit_count` for both calls and could not have
   caught it.
2. **A replayed stack could land after `finishUnload`.** `addStack` had no
   status guard — unreachable before this ADR, because stacks had no queue.
   `addStack` now refuses a load that is not `in_progress`, and a replayed
   `finishUnload` _recomputes_ `total_units` instead of returning blind.
   Relatedly, replay now halts a load on **any** failure rather than only a
   conflict: a 5xx breaks ordering exactly as thoroughly as a 409.
3. **"Re-submit to today" could overwrite today's real numbers.**
   `confirmFloorInboundDay` and `upsertProcessedUnits` write an ABSOLUTE value
   keyed on the day, so re-filing Tuesday's 400-unit inbound would have replaced
   the 260 the floor already confirmed for today — one tap, no diff, no confirm.
   Re-submit is now offered for the count alone, which is an append.

Two more that would have defeated the feature quietly: the service worker's
`defaultCache` catch-all matched `/healthz`, so the reachability ping would have
returned a **cached 200** on a dead uplink and painted the badge green (now
`NetworkOnly`, first in the matcher list); and a Tier-2 hold sits outside the
idempotency claim by design, so every Retry tap minted another hold — now its
own conflict state with Retry suppressed.

Also caught in the same pass, and worth its own line because it is a testing
defect rather than a product one: the two real-DB suites both truncated
`idempotency_keys`, and vitest runs test _files_ in parallel. They were deleting
each other's rows. Every delete is now scoped to the rows its file created, and
CI runs them with `--no-file-parallelism` — an intermittent, interleaving-
dependent CI failure is the worst kind to ship.

## Amendment 1 (2026-08-07) — the photo gate is site-scoped, and uploads are attributed

**Status:** Accepted, implemented. Amends the D3 photo path only; nothing else in
ADR-0078 changes.

### Context

Bill, verbatim, while JT was mid-drain at 47/103:

> _"we need to drain all users regardless of who is signed in... let's just not
> have this have to be a issue in the future."_

The drain worked — `load_photos` went from 0 rows ever to 47 across 20 loads in
under two hours. Then it hit the wall this amendment removes.
`requireOperatorOwnsLoad` required `load.assigned_operator_id === session.user.id`,
so a photo queued by operator A could not be confirmed while operator B was
signed in. On a shared floor iPad that is not an edge case, it is the normal end
of a shift, and ADR-0078's own conflict path then parked those rows permanently.

### Decision

The gate checks the **site**, not the load's assigned operator.
`requireOperatorOwnsLoad` → **`requireOperatorAtLoadSite`**, returning
`{ loadId, siteId, actorUserId, loadOwnerUserId }`. Both photo routes — mint AND
confirm — take the identical change.

**The trade, stated plainly rather than described as a refactor: the gate
loosened from owner to site; attribution went from none to recorded.**

- **Given up:** an operator can now attach a photo to any load at their own site.
- **Gained:** the evidence survives. Photo blobs live in ONE iPad's IndexedDB and
  nowhere else; a row parked forever is evidence that dies when that device is
  wiped or replaced.
- **Also gained:** `load_photos.uploaded_by` on every confirm. The table
  previously had no uploader column at all — the strict gate enforced who was
  _allowed_ to upload and then kept no record of who _did_. Accountability is
  strictly better after this change than before it.

Unchanged and not to be "restored": cross-site refusal (Eugene and Woodland are
separate MRC contracts in separate jurisdictions, hard rule #2), the operator-role
check, and the 404 for a missing load. The function was **renamed with the
behaviour** precisely so the next reader cannot mistake the removed check for an
oversight and put it back.

**Mint and confirm move together, mandatorily.** A relaxed mint with a strict
confirm is worse than doing nothing: the client gets a presigned URL, PUTs the
bytes, and is then refused the row — an orphaned R2 object, no record, and a
queue entry that still cannot drain. Pinned by
`confirm.accepts-same-principal-as-mint`, falsified by reverting confirm's guard
alone.

**Audit discipline (ADR-0037):** an audit row is written **only** when the
uploader is not the load's assigned operator. A row per confirm would add ~100/day
of "operator did the thing they were assigned to do" and bury the case a person
would actually search for. `uploaded_by` is the durable record for every upload;
the audit row marks the exception.

**`uploaded_by` is nullable and NOT backfilled.** The 47 pre-existing rows have a
genuinely unknown uploader — the session that wrote them was never captured.
Backfilling from `assigned_operator_id` would look tidy and would be a
fabrication: asserting that a specific person uploaded a specific photo, into a
table that feeds MRC billing evidence, on evidence that does not exist. NULL
means "we do not know", which is true. Same reasoning as ADR-0077's "not
recorded" over a fake `0.0`.

### Residual, recorded not hidden

The idempotency replay stays pinned to the **uploading** session's `actorUserId`,
because a key is a bearer string and a replay must belong to the principal that
claimed it. Consequence: if A queues a photo, B drains it, and B's response is
lost, A's later retry of the same key is a different actor and earns 409
`idempotency_key_reused`. The row then parks as a visible conflict rather than
writing a duplicate — degrading into ADR-0078's conflict path, which is the safe
direction and exactly what that path is for.

## Verification

Every guard was falsified by hand before being trusted, and the falsification had to name the **real wrong value**. One did not: the double-tap test, written with a single shared key, passed with the P2002 tolerance deleted — `withIdempotency` short-circuits before the insert, so the assertion was measuring the idempotency path and not the constraint path it named. Rewritten with two keys (which is what a real double-tap mints) it goes red with the actual unique-constraint violation. The green falsification is recorded in the test file, because a guard that cannot go red is worse than no guard.
