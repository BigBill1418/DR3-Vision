# ADR-0082 — Whoever holds the load closes it, and anyone can take it over: an atomic claim, a self-serve handover, and an audit that cannot lie

**Date:** 2026-08-08
**Status:** Accepted, implemented
**Supersedes:** nothing.
**Amends:** ADR-0065 Amendment 1 (the operator-scoped open-loads listing becomes site-wide), ADR-0078 (extends the typed-error and idempotency work to the claim path and adds one conflict code).
**Partially reverses:** the ADR-0065 Am.1 statement that _"a load belonging to someone who has left is a MANAGER reassignment (T-010), not a floor fix"_ — Bill's decision 2026-08-07 makes it a floor fix.

## Context

JT: _"Whoever started the load has to be the one to close the load … need to keep it open to somebody to close it in case 1st driver goes to lunch."_

The first half of that sentence was already enforced — **to the letter, and past the point of usefulness.**

### What was already built

`inbound_loads.assigned_operator_id` and `assigned_at` have existed since the dock workflow shipped, are indexed (`@@index([assigned_operator_id, status])`), and are written by `startInboundLoad`. **Starting a load already claims it.** `assertOwn` in `load-service.ts` then refuses every stage action from anyone but the assignee.

So this ADR does not build a claim. It builds the three things missing around one that already existed: an **atomic** write, a way to **hand it on**, and a surface that **says who holds it**.

### The defect: a silent dead loop

`load/[id]/page.tsx` handled a non-assignee like this:

```ts
if (load.assigned_operator_id !== session.user.id) {
  // T-010 portal lets a manager reassign it; from the iPad we just bounce back to the queue.
  redirect(`/operator/${siteCode}/queue`);
}
```

What that produced on the floor is a loop with **no message anywhere inside it**: the second operator taps the load, lands on the queue, taps the load, lands on the queue. Nothing errors. Nothing is logged. The holder's name appears on **no screen on the device** — the queue listed only the signed-in operator's own open loads, so the load was invisible to everyone except the person who had walked away from it. The only way to find out what was happening was to ask the room.

`startInboundLoad`'s idempotent branch made it worse in a quiet way: tapping the queue row returned **A's load id to B**, so B was redirected _into_ the load and then immediately bounced back out of it.

### What production was actually holding (measured 2026-08-08, `dr3_vision` on svdp-dev)

Query published at **`docs/queries/2026-08-08-open-dock-loads.sql`** — re-runnable, with its definitions and its Pacific-conversion trap written down.

| Fact                                                                     | Value                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Open dock loads (`arrived`…`finished`, `b2b_haul`)                       | **9**, all Woodland                                            |
| Distinct operators holding them                                          | **4** (Juan Perez, Pablo Ledezma, Janette Tomas, Morena Gomez) |
| Claimed on an earlier Pacific day than the measurement day               | **9 of 9** — none was claimed that day                         |
| Oldest claim                                                             | **2026-07-28** — eleven days                                   |
| At `finished` (counted, never submitted → outside inventory and billing) | **1**, carrying **148 units**                                  |
| Parent `expected_loads` row cancelled                                    | **0** (checked, not assumed)                                   |
| Submitted loads where `submitted_by_id <> assigned_operator_id`          | **0 of 40**                                                    |

**"Open" is not "stranded", and the label must not do work the query cannot.** `in_progress` cannot distinguish a truck being unloaded right now from one abandoned at lunch — only the AGE of the claim suggests it, which is why `days_before_today` is in the published output. On this reading all nine predate the measurement day, so none was an in-flight unload; that is a fact about this reading, not a property of the status set. The query also does NOT filter out loads whose parent expected row was cancelled (filtering on a live parent is one of the three things that stranded loads in the first place, ADR-0065 Am.1) — it REPORTS the flag instead, and here it is zero.

The `submitted_by_id` row is the one worth reading carefully, because it is the kind of number that lies when quoted without its cause. It is **not** evidence that handovers do not happen on the floor. It is evidence that the software made them **impossible to record**: `assertOwn` refuses the submit, so the closer could only ever be the claimer. The column was a tautology. After this ADR it becomes a measurement.

### The claim was also not atomic

`startInboundLoad` was a `findUnique` followed by a `create`, with no transaction between them. Two operators tapping the same queue row within the same second both saw `inbound_load: null` and both inserted. The `@unique` on `expected_load_id` did stop the duplicate row — by raising a bare `P2002` out of a server action, which reaches the client as an opaque digest and the logs as a 500. That is precisely the error class ADR-0078 D11 removed everywhere else and did not reach here.

## Decision

### D1 — The claim becomes atomic, with the mechanism named

`startInboundLoad` runs inside `prisma.$transaction` with an **in-transaction re-read** of the parent, plus a **narrow `P2002` catch**. Both, because they close different windows and neither closes the other:

- **Sequential window** (the common one): A committed a few seconds ago and B's queue page has not re-rendered. The in-transaction re-read sees A's committed child and returns it.
- **Concurrent window** (the narrow one): both transactions are open at once, so under READ COMMITTED — Postgres's default, and Prisma's — **neither re-read can see the other's uncommitted insert**. The unique index blocks the loser and then refuses it; the `P2002` branch converts that refusal into the same graceful outcome as the sequential path.

A transaction alone would fix neither. Saying "we wrapped it in a transaction" would have been a fix that reads well and does nothing, and this ADR states the actual serialising mechanism — the unique index — so a future reader can check the claim.

The catch is `isExpectedLoadClaimCollision`, which inspects `e.meta.target`, not a bare `code === 'P2002'`: a bare check would absorb a future unique constraint elsewhere on the table and report an unrelated collision as "someone else claimed it".

`startInboundLoad` now returns `{ id, claimed }` and its bare `Error`s become typed `LoadAccessError`s (ADR-0078 D11 applied here at last).

### D2 — Takeover is a COMPARE-AND-SWAP, not an update

`takeOverLoad` re-stamps with:

```sql
UPDATE inbound_loads
   SET assigned_operator_id = :taker, assigned_at = now()
 WHERE id = :id
   AND assigned_operator_id = :the_holder_I_read   -- ← load-bearing
   AND status IN (open dock statuses)
```

`updateMany` rather than `update`, because Prisma's `update` accepts only a unique selector and the whole point is a **non-unique predicate over the state being swapped out of**. Zero rows matched ⇒ someone moved the claim first ⇒ 409 `load_claim_moved:<the name of whoever holds it now>`.

The serialising mechanism, again named: **Postgres re-evaluates an UPDATE's WHERE against the newly committed row version after it unblocks.** The second taker's update queues on the row lock, re-checks, matches nothing, and is refused.

An unconditional update would let both "succeed" and would write **two audit rows each claiming to have taken the load from A** — a false history in an append-only table (CLAUDE.md hard rule #6), which is exactly the failure the `mergeEquipment` actor-context work exists to prevent.

### D3 — Which statuses, and which rows

Takeover is allowed across the whole open-dock set — `arrived`, `weight_captured`, `unload_started`, `in_progress`, `finished` — imported from `OPEN_DOCK_STATUSES` rather than restated, so the two sets cannot drift.

Not only `in_progress`, because the lunch case does not care which stage the load is at, and because **`finished` is the worst status to strand**: counted, one tap from submission, not yet in inventory or billing. Production is holding one right now.

Everything outside the set is refused: `submitted` and beyond have left the floor's hands, and re-pointing the operator on a load a manager is verifying is a manager action (ADR-0073 / T-010).

Aggregate rows (`paper_bulk`, `mymrc_haul`, `ipad_floor`, `event`) are refused **structurally** on `load_source_type`, not merely by status. Today every aggregate row in production is `verified` and would fail the status gate anyway; the source-type check means a future path that leaves one at `arrived` cannot make a synthesized day-level record takeoverable by accident. Nobody stood at a door and counted it, so there is no claim to hand on.

### D4 — Honesty rules for the audit row

- The actor is **the person who took it** (`actor_user_id`), never `actor_label`. A human pressed the button; `actor_label` is reserved for actors with no `users.id` behind them (`admin-equipment.ts` / ADR-0077).
- `before` carries the outgoing operator id **and their `assigned_at`**, so the full chain of custody is reconstructible from `audit_log` even though the row itself only ever holds the current holder.
- The audit row is written **inside the transaction** (`writeAudit(…, { tx })`), with `ip` and `user_agent`. `load-service.ts` historically wrote its audit rows after the update on the global client and dropped both fields; that pattern is not copied, because a claim that moved with no row recording it is the silent overwrite the handoff forbids.
- **Taking over a load you already hold writes nothing.** Re-stamping `assigned_at` for the current holder would move their claim time for an action that changed nothing, and would put an A→A row in the log that reads like a handover.
- The taker must be an **active operator at the load's site** (`role`, `is_active`, `deleted_at IS NULL`, `primary_site_id`). `auth.ts` already refuses an inactive user at sign-in, so this is defence in depth — but a claim records who is answerable for a load, and writing a deactivated or cross-site name into it would make that record wrong at the moment it matters most.

### D5 — Takeover is ONLINE-ONLY, and that is a decision

It is **not** registered in `FLOOR_SCOPES` and is never enqueued to the offline queue. Two reasons:

1. A takeover is a **contention action** — its entire meaning is "I am at this load now and the other person is not". Replaying one hours later resolves a contest that has already been settled, against a load whose state has moved on.
2. It **captures no operator data**. Refusing it offline costs a tap; refusing a count costs a count. Everything ADR-0078 queued was something that would otherwise be lost.

It still carries an idempotency key, because a double-tap on a live connection is real. `load-claim-surface.test.ts` asserts the absence from `FLOOR_SCOPES` and from the panel, so a future "let's make this consistent" change has to delete the assertion deliberately.

### D6 — The displaced claimer is told what happened

This is the failure the feature itself creates, and it would have shipped as a side effect if it had not been looked for.

`assertOwn` refuses a non-assignee with 403 `load_not_assigned_to_operator`. Before takeover existed that was effectively unreachable. Making claims movable makes it **routine**: A returns from lunch to an iPad still showing the counting screen and taps +1.

- **Live path.** The stage components render `e.message`, and a Server Action's throw arrives at the browser with its message **redacted in production** — the reason is not unhelpful, it is structurally unavailable. (Amendment 1 below had to apply this same fact to the takeover panel itself, which the first cut got wrong.) So on any non-offline stage failure the client asks one question it cannot answer locally (`claimStatusAction`) and, only if the claim has moved, refreshes — the page re-renders as the held-by panel and **names the new holder**. A blanket `router.refresh()` was rejected: most stage errors are not claim losses, and refreshing would take the real error banner with it, trading an opaque message for no message.
- **Replay path.** `classify(403)` already parked the entry as a conflict, and that retry behaviour is correct and unchanged: no number of attempts gives this operator the load back. What was missing was the reason — and worse, `reasonLabel` fell through to `why_session` ("Your sign-in expired before this was sent"), which is **false** and sends the operator to re-enter a PIN that cannot help. New conflict code `conflict:load_taken_over`, matched **before** the generic 403 branch, with copy that says the work is safe and who can enter it.

### D7 — The queue lists the site's open loads, not just yours

`listOperatorOpenLoads` becomes `listSiteOpenLoads(siteId, viewerUserId)`, one query split into `{ mine, heldByOthers }`.

The operator predicate is removed, and the reason it existed is removed with it: ADR-0065 Am.1 filtered on the signed-in operator **because the load page redirected a non-assignee**, so listing someone else's load would have rendered a link that bounces. D6 removes that redirect. What the filter did after that was hide the exactly nine loads that need a taker.

**This is still not the "historical view" ADR-0065 D5 rules out.** That rule governs BROWSING expected hauls — no paging back through production days, no pre-staging future ones — and the current-Pacific-day window on `expected_loads` is untouched. An unfinished load is current work whose arrival timestamp happens to be in the past; that was already the accepted reasoning for showing an operator their own. Widening it from "mine" to "this site's" adds no history, it adds the colleague standing next to you.

Split in memory over one result set rather than issued as two queries: two queries could observe two different instants, and a load taken over between them would land in both lists or in neither.

### D8 — No migration

The claim columns, their index, and `audit_log` all already exist, and a takeover is an `update` in the existing `AuditAction` enum. **Migration prefix `20260835` was assigned to this work and is deliberately unused.** Recorded so the gap in the sequence is explained rather than looking like a lost file.

## Alternatives considered

**Manager-approved handover.** Rejected by Bill, 2026-08-07. The approval step _is_ the stranding: a load whose operator went to lunch must not wait on someone finding a manager. ADR-0073 (manager corrections) remains the right home for reassigning a load that has already left the floor.

**A `load_claims` append-only table.** More faithful to the chain of custody, and unnecessary: `audit_log` is already append-only and already carries `before`/`after`. A second table would be a second place for the truth to live, and the first thing to drift.

**A `SERIALIZABLE` transaction instead of a compare-and-swap.** Would work, and would put a retry-on-serialisation-failure loop on a dock write path for a contention case measured in single-digit occurrences per shift. The CAS is one predicate, needs no retry, and states the invariant in the statement itself.

**Letting the queue-row tap perform the takeover.** Tapping Start on an already-claimed haul is ambiguous — most of the time it means "I did not realise someone had it". Making that gesture silently move a claim is the silent overwrite the handoff forbids. It routes to the load page, which names the holder and asks.

**Keeping `redirect()` and adding a toast.** A toast on the destination page cannot say which load or who holds it without threading state through a redirect, and the operator still ends up somewhere they did not ask to be.

## Consequences

- The floor gains a self-serve handover; the lunch case stops stranding loads, including the nine currently open.
- `submitted_by_id` can now legitimately differ from `assigned_operator_id`. Anything that assumed those were interchangeable (reports, exports, bonus attribution) should be read as "who closed it" vs "who last held it" and no longer as one fact.
- One operator at a site can see another operator's **name** against a load. That is a deliberate widening within a site, and it is the minimum needed to make a handover possible. Cross-site remains fully closed: a load at another site is still `notFound`.
- A takeover cannot be performed offline. An operator with no connection who needs a colleague's load must wait for the connection, which is the same constraint as signing in.
- `startInboundLoad`'s signature changed to `{ id, claimed }`; `listOperatorOpenLoads` is gone in favour of `listSiteOpenLoads`. Both are internal.

## Verification

Falsification-grade, against **real Postgres** (`load-claim.db.test.ts` runs in CI's `migrations` job alongside the ADR-0078 suites). Every claim here is a claim about the database, so a mocked Prisma would be enforcing the rule the test claims to check.

The two race tests are **deterministic, not hopeful**: a bare `Promise.all` is not a race test, because if the two transactions happen to serialise then both takeovers legitimately succeed and the suite passes with the guard deleted. Both force the interleaving with a third transaction holding `SELECT … FOR UPDATE` on the contested row while the contenders complete their reads and block on their writes.

| Falsification                       | Guard removed                                       | Observed red                                                                                      |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Two simultaneous takeovers          | `assigned_operator_id` predicate in the CAS `WHERE` | `exactly one taker may win a simultaneous takeover: expected […] to have a length of 1 but got 2` |
| Two simultaneous starts on one haul | the `isExpectedLoadClaimCollision` catch            | `start rejected with … Unique constraint failed on the fields: (expected_load_id)`                |
| The dead loop                       | restored `redirect('/operator/<site>/queue')`       | `the load page redirects to the queue again`                                                      |
| Displaced-claimer conflict reason   | moved the branch after the generic 403              | `the takeover branch is unreachable behind the generic 403: expected 4190 to be less than 4093`   |

Also pinned: A starts → B takes over → B closes with `submitted_by_id = B`; A's original claim row survives in `audit_log`; a double-tap with one key re-stamps once and audits once (and does not move `assigned_at`); taking over a load you already hold writes nothing; cross-site refusal in **both** shapes (wrong `siteId`, and a right `siteId` with a cross-site taker); deactivated operator refused; aggregate row refused; every open dock status takeable.

---

## Amendment 1 (2026-08-08) — the panel contradicted its own neighbour

**Status:** Accepted, implemented. Raised in review of this ADR, not of the code.

### What was wrong

`use-claim-loss-guard.ts` justifies its entire existence with D6's finding: **a Server Action's throw reaches the browser with its message redacted in production.** Two files away, `held-by-panel.tsx` selected its error copy like this:

```ts
const reason = e instanceof Error ? e.message : '';
setError(reason.includes('load_claim_moved') ? 'takeover.error_moved' : 'takeover.error');
```

Both cannot be true. Because the redaction is real, that match could never fire in production. `takeover.error_moved` — translated into English, Spanish and Urdu — was **dead code in all three locales**, and every operator who lost a takeover race was shown the generic _"That did not go through. Try again."_ That is an invitation to retry a contest already settled: the same loop **D5** declines to queue, arriving through the front door instead.

It had **no test**. That is why it survived review of the code and died only on review of the prose — the contradiction was visible only by reading two files' rationales against each other, which a diff-shaped review does not do.

### The fix

`takeOverLoad` and `takeOverLoadAction` now **return a discriminated outcome** rather than throwing for anything an operator can reach: `taken`, `already_yours`, `claim_moved`, `not_open`, `not_takeable`. **Return values are not redacted.** The panel switches on `outcome` and inspects no message.

Three consequences worth stating:

1. **The winner's name now reaches the screen.** `takeOverLoad` was already computing who won the race and discarding it inside an error string. The copy names them: _"Bruno Vega took this load over first — it is theirs now, not yours. Nothing you entered was lost."_
2. **`not_open` stopped being an exception.** A load submitted by its holder while a second operator reads the panel is reachable with no concurrency at all, so it gets named copy instead of a thrown 409.
3. **`LoadAccessError` is still thrown** for the three refusals a person cannot reach from the button (load absent, wrong site, taker not an active operator here). Those are genuinely exceptional; giving them reassuring copy would invent a story for a state that should never occur. The panel's `catch` maps any throw to the one generic banner **without inspecting it** — that is the whole difference from the first cut.

A `claim_moved` outcome **commits** its idempotency claim rather than rolling it back, and that is correct: the key names an attempt that definitively did not take the load, so replaying it must keep saying so. A second, deliberate tap mints a new key and is re-evaluated from scratch.

### Also in this amendment

- **The measurement is published** as `docs/queries/2026-08-08-open-dock-loads.sql`. Two figures in the original Context were wrong: **four** distinct holders, not five — the first count summed overlapping per-status distinct counts — and the `finished` load carries **148 units**, which the original omitted entirely. "Stranded" was replaced by "open" plus the age column that actually carries the claim, because `in_progress` cannot tell an abandoned load from a truck being unloaded right now.
- **A test pins the in-transaction placement of both re-reads** (`load-claim.in-transaction.test.ts`). D1 and D2 rest on reading through the same client that writes, and nothing checked it: changing `tx.` to `prisma.` reads fine in review and leaves every real-DB test green, because the compare-and-swap and the unique index are WRITE-side guards. The prisma double throws on every global-client model call, so an escaped read fails loudly and names itself.

### Verification

| Falsification                                                                    | Observed red                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Restore the string-match, with the action throwing a production-redacted message | `expected 'That did not go through. Try again.' to be 'Bruno Vega took this load over first …'` |
| Move `takeOverLoad`'s re-read to the global client                               | `ESCAPED TRANSACTION: read inboundLoad through the GLOBAL client`                               |
