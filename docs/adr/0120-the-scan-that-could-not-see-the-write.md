# ADR-0120 — The scan that could not see the write

- **Status:** Accepted — 2026-08-20. Approved by Bill in the 2026-08-19 22:30 PT
  transaction-boundary review; shipped the same night. **The index Bill specified
  was narrowed after verification falsified its premise — see D3.**
- **Context:** `promoteWorkbookImport` refuses to promote into a window that
  already holds live rows. The refusal is a READ, this application runs at READ
  COMMITTED, and a live floor write that commits after the scan lands in the
  window anyway — a silent double count of a real day's volume, feeding MRC
  billing. Found in the 2026-08-19 engineering audit (critical #5).
- **Supersedes / amends:** nothing. Uses the advisory-lock idiom already proven in
  `recycling-rates.ts` and `photos/confirm/route.ts`. **Preserves** ADR-0078 D1
  (the same-day anchor tiebreaker), which the originally-specified index would
  have broken — see D3. Interacts with ADR-0048 (promotion provenance) and
  CLAUDE.md hard rule #2 (site separation).

## Context

`promoteWorkbookImport` opens a transaction, calls `detectConflicts` across five
operational tables — `inbound_loads`, `outbound_materials`, `landfilled_units`,
`consumer_dropoffs`, `site_inventory_snapshots` — and throws
`PromotionConflictError` if the window holds any live row. That scan is correct
and is not the defect.

The defect is that it is a **read**, at READ COMMITTED, which is Postgres's
default and this application's. A row that commits *after* the scan and *before*
the promotion's own inserts is invisible to the scan and lands in the window
regardless. Both sets of rows then stand: `onHand` sums them, the promotion
ledger row records a conflict-free promotion that was not one, and nothing
anywhere errors. The window is a whole month of a real site's volume, and
`stripped_program` and the inbound totals are billing inputs.

The window is not theoretical. A promotion is an admin action that takes seconds
across five `createMany` calls; the floor writes continuously through the same
day from a shared kiosk, an operator iPad, the offline-queue replay endpoint and
the MyMRC scrape.

## Decision

**D1 — Both sides take one transaction-scoped advisory lock, keyed on the SITE.**
`lockSiteAgainstPromotion(tx, siteId)` in `src/lib/audit/promotion-lock.ts`, on
the idiom `recycling-rates.ts` established:
`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`.

The key is the site because it is **the coarsest thing both sides genuinely
know**. A key of `site_id || ':' || window` is unbuildable on the writer side: a
floor write knows one row on one day and has no way to know whether an admin is
promoting a month that contains it.

Taken **before** the conflict scan, not merely before the inserts. Taken after,
it would serialise the writes while leaving the scan reading a snapshot a
concurrent writer could still invalidate — the defect with an extra step.

Every writer of the five tables takes the same key as the first statement inside
the transaction that performs its write, so the hold is the write itself.

**D2 — Lock ordering: exactly one advisory lock per path.** That is what makes
this deadlock-free, and it is the property to preserve. Row locks are taken after
it on every path, so their order is consistent by construction. **If you add a
second advisory lock to a path that already takes this one, you have created a
lock-ordering problem** — acquire in a documented total order (this one first) or
do not add it.

**D3 — The uniqueness backstop is scoped to `source = 'import'`.**

This is a deliberate narrowing of what the review specified, and the reason is
evidence rather than preference.

The review called for a partial unique index on
`(site_id, snapshot_at) WHERE snapshot_kind = 'physical' AND voided_at IS NULL`,
on the premise — stated explicitly as a thing to verify against the real-DB suite
— that correct-count's void-first ordering already satisfies it.

**It does not, and verifying it is what found that out.** Two live physical
counts at one site on one day, sharing a byte-identical `snapshot_at`, are a
**supported and production-observed state**:

- the floor anchors every count at Pacific midnight of its day (ADR-0060 D-3), so
  two counts taken on the same day are stored at the same instant *by
  construction*;
- **ADR-0078 D1 exists because of that.** It added the `created_at DESC` tiebreak
  so "the latest anchor" is a fact rather than a query-planner preference, and its
  suite header records: *"verified in production, where both existing physical
  snapshots sit exactly on 07:00:00 UTC."*

The unguarded index was applied to a scratch database carrying the full migration
chain, and ADR-0078 D1's own suite was run against it:

```
Raw query failed. Code: `23505`.
Message: `Key (site_id, snapshot_at)=(tiebreak-site, 2026-08-07 07:00:00) already exists.`
 Test Files  1 failed (1)   Tests  3 failed (3)
```

Green again with the index dropped and nothing else changed. Shipping it would
have made **the second same-day physical count at a site fail with a raw Postgres
unique violation** — on the operator floor, on an overnight deploy, contradicting
a shipped and tested invariant without superseding it. CONTRIBUTING's floor rules
forbid rendering a raw error to an operator; this would have produced one from a
routine action.

So the index is narrowed to the rows the promotion race actually produces:

```sql
CREATE UNIQUE INDEX site_inventory_snapshots_import_anchor_uniq
  ON site_inventory_snapshots (site_id, snapshot_at)
  WHERE snapshot_kind = 'physical' AND voided_at IS NULL AND source = 'import';
```

It catches two promotions anchoring one site-instant — the promotion-vs-promotion
half of the race, the half an advisory lock inside one transaction cannot see —
and is silent on the manual counts ADR-0078 D1 governs.
`workbook_promotions.import_id` is already UNIQUE, so two promotions of the *same*
import already collide; what this adds is two *different* imports whose windows
share an opening instant.

Production was checked before writing it: 4 snapshot rows total, 3 live physical,
**zero** duplicate `(site_id, snapshot_at)` groups under either predicate.

## Alternatives considered

- **`SERIALIZABLE` for the promotion transaction.** Rejected. It would surface the
  conflict as a serialization failure the admin must retry, and — more decisively
  — it only protects the transaction that opts in. The floor writes would still
  commit; the promotion would just fail more often, with no explanation an
  operator or admin could act on.
- **A two-int key of `(hashtext(site_id), day)`.** Rejected on every axis that
  matters: a month-long promotion would hold ~31 locks instead of 1; every writer
  would need the day of its own row (several derive it rather than hold it); and
  multi-lock acquisition creates a lock-ordering obligation, and therefore a
  deadlock, where a single key has none. Promotions are rare, admin-initiated and
  take seconds; floor writes are frequent and take milliseconds. Blocking the
  frequent-but-fast side for the duration of the rare-but-slow one is the right
  trade and the only shape with no ordering rule to get wrong.
- **`SELECT … FOR UPDATE` over the window.** Rejected: there is no single row, the
  scan spans five tables and a date range, and locking rows that do not exist yet
  is exactly what an advisory lock is for.
- **Shipping the unscoped index as specified.** Rejected on the evidence in D3.
- **Skipping the index and relying on the lock alone.** Rejected: the lock lives in
  application code and can be forgotten by a future writer. The index is the
  database saying no, and it costs one migration.

## Consequences

- **A promotion now blocks every floor write at that site for its duration** —
  seconds, on an admin-initiated action, and only at that site. The db suite
  asserts the site scoping explicitly, because a lock that serialised every site
  would pass the "it blocks" test while quietly turning both floors into one
  queue, against CLAUDE.md hard rule #2.
- Eleven call sites now take the lock. They are listed in `promotion-lock.ts`. A
  **new** writer of any of the five tables that forgets it reopens the hole for
  its own path — the lock is a convention, and the index only backstops the
  snapshot table.
- The MyMRC inbound bridge takes and releases the lock **once per aggregated
  day** rather than once per run, because its transaction is opened inside the
  per-day loop. Deliberate: holding it across a whole backfill would block the
  floor for the length of the backfill.
- The index is SQL-only — Prisma cannot express a partial index — so
  `prisma migrate diff` will report it as drift. That check is advisory and
  non-blocking by design (see `.github/workflows/ci.yml`), and the schema carries
  a comment pointing at the migration.
- **The manual-count half of the promotion race is still only lock-protected**,
  not index-protected, precisely because ADR-0078 D1 requires same-instant manual
  rows to be legal. Recorded in `docs/OPEN-ITEMS.md` 0.BF.
