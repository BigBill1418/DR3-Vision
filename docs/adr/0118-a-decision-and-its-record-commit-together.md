# ADR-0118 — A decision and its record commit together

- **Status:** Accepted — 2026-08-19. Approved by Bill in the 2026-08-19 22:30 PT
  transaction-boundary review; shipped the same night across four PRs.
- **Context:** The 2026-08-19 engineering audit found eleven places where a state
  change and the append-only audit row describing it were written as separate
  statements on the shared Prisma client, and where the check authorising the
  change was a read taken before it rather than a condition on it.
- **Supersedes / amends:** nothing. Enforces CLAUDE.md hard rule #6 (the audit
  log is the record, not a side effect) and generalises the compare-and-swap
  idiom already proven in `correct-count.ts` `applyCorrection`, `void-count.ts`
  `voidWrite` and `load-service.ts` `finishUnload`. Uses the ADR-0078 real-database
  test lane and the `tx` seam ADR-0078 added to `reconcilePhysicalCount`.

## Context

This ADR covers one decision applied in several places, which is why it is one
ADR and not eleven. The decision is a rule, and the rule is that **the thing that
authorises a write must be part of the write, and the record of a write must
commit with it.**

Two failure shapes recur across the codebase, both silent.

### 1. A read-then-write where a compare-and-swap belongs

The pattern is everywhere:

```ts
const current = await assertOwn({ ... });          // read: status is X
if (!allowed.includes(current.status)) throw ...;  // decide
await prisma.inboundLoad.update({ where: { id }, data: { status: to } });  // write
```

Between the read and the write, anything may happen. The floor is the reason
this is not theoretical: the same load is reachable from a shared kiosk, an
operator's iPad and the offline-queue replay endpoint, and ADR-0072 deliberately
built **two** release paths for a held count. Two requests both pass the check
and both write. Nothing errors. `load-claim.ts:372-376` names this exact defect
in a comment and fixes it for claims only.

The correction is a `updateMany` whose `where` restates the condition and whose
`count` is the verdict — `count === 0` means somebody else won.

### 2. An audit row written after its subject already committed

```ts
await prisma.$transaction((tx) => writeRows(tx, { ... }));  // commits
await writeAudit({ ... });                                   // separate
```

If the process dies between them — a container recreate, and this stack
auto-deploys from `main` on every push — the rows exist with no record of who
wrote them or why. Hard rule #6 calls the audit log the permanent record; a
record that can be absent for a write that happened is not one.

The worst instance is the anchor-reactivation route. That route is the one
action in the app that **moves the whole floor without counting anything** — it
copies a prior count's figures forward into a new live anchor. Its
`anchor_reactivation` audit row is the only thing distinguishing that from a
count somebody took. Lose it and a re-anchor is indistinguishable, to every
downstream reader and to any later audit, from a physical count that was never
performed — which is exactly the laundering the ADR-0084 voided-source refusal
three lines above it exists to prevent, arriving through the back door.

## Decision

**D1 — A state change is guarded by a compare-and-swap, not by a prior read.**
The `where` clause restates the state the caller believes it is in. `count === 0`
is a conflict and raises a typed error the route can translate. Where the losing
side needs to name the state that won, re-read it inside the transaction — as
`void-count.ts` `voidWrite` already does — rather than returning a bare conflict.

**D2 — The guard runs FIRST, before anything else in the transaction.** This is
the order `correct-count.ts` `applyCorrection` documents and the reason it works:
if the gate matches nothing, we abort before writing anything at all, so the
two-live-rows state never exists even transiently inside the transaction.

**D3 — An audit row is written on the same transaction as its subject**, via
`writeAudit(args, { tx })` or `tx.auditLog.create`. Never after the transaction
that wrote the thing it describes.

**D4 — A helper that accepts a transaction is given one.**
`reconcilePhysicalCount` has taken an optional `tx` since ADR-0078 precisely so a
caller can bind the snapshot to its own work. Callers that omitted it were not
choosing independence; they predated the parameter.

### Applied in this PR

- `src/lib/inventory/anchor-holds.ts` `releaseHold` — the whole release becomes
  one transaction: a `pending`-guarded `updateMany` first, then the anchor
  written with `tx`, then the snapshot link, then the audit row.
- `src/app/api/admin/inventory/anchors/reactivate/route.ts` — the re-anchor and
  its anti-laundering audit row commit together.

### Applied in the sibling PRs of this set

- `src/lib/loads/verify-gate.ts` — the DR3 number burn race (a guarded
  `updateMany` inside the sequence transaction).
- `src/lib/commodity-payments/payments.ts`, `src/lib/load-service.ts` (×2),
  `src/lib/doc-ingest/absorb.ts` (×5) — the eight high-severity siblings.

## Alternatives considered

- **`SERIALIZABLE` isolation on the affected transactions.** Rejected. It moves
  the failure from "two rows silently written" to "a serialization error the
  caller must retry", and every one of these call sites would then need retry
  logic that does not exist. A `updateMany` guard expresses the same constraint
  as an ordinary, already-understood conditional write, on the default isolation
  level the rest of the codebase runs at.
- **`SELECT … FOR UPDATE` before the read.** Rejected as more machinery for the
  same result: it needs raw SQL at each site, holds a row lock for the whole
  transaction rather than the write, and the guarded `updateMany` is already the
  house idiom with three proven instances.
- **A database trigger enforcing "no state change without an audit row".**
  Rejected. It would enforce the invariant everywhere at once, which is
  attractive — but it puts application semantics in a place no test in this repo
  currently reaches, and it cannot express *which* audit row belongs to which
  change. Worth revisiting as a backstop; not a substitute for the call sites
  being correct.
- **Leaving the audit writes where they are and accepting the window.**
  Rejected: the window is a container recreate, this stack recreates on every
  push to `main`, and the row that goes missing is the one that proves an
  admin-only floor-wide action was legitimate.

## Consequences

- Every state change in this set now fails LOUDLY on a lost race, where it
  previously succeeded twice and left the second write as the winner.
- Callers must handle a new conflict error. Each site raises the typed error its
  route already translates (`HoldNotPendingError`, `VerifyGateError`,
  `TransitionError`), so no route gains an untranslated enum — CONTRIBUTING's
  floor rule forbids rendering one.
- Transactions now hold locks for slightly longer, since the audit insert has
  moved inside them. The rows are small and the transactions short; no call site
  in this set takes a lock it did not already effectively need.
- **A pre-existing race is narrowed but not closed** in `releaseHold`: the
  ADR-0072 swing classification is still recomputed *before* the transaction, so
  an anchor landing between that recompute and the release is still classified
  against the older baseline. `reconcilePhysicalCount`'s `onHand` read is
  outside the transaction for the same documented reason (ADR-0078,
  `running-balance.ts:511-517`). Both are read-side, both are wider than this
  ADR's subject, and pulling a six-table aggregate into every caller's
  transaction changes the lock footprint of every count — a separate change that
  deserves its own evidence. Recorded in `docs/OPEN-ITEMS.md` 0.BF.
