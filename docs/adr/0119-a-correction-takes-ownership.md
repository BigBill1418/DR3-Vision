# ADR-0119 — A correction takes ownership

- **Status:** Accepted — 2026-08-20. Approved by Bill in the 2026-08-19 22:30 PT
  transaction-boundary review; shipped the same night.
- **Context:** A human correcting a processed-units day the MyMRC bridge had
  created left `source = 'mymrc'` on the row. The bridge's own precedence guard
  keys on that column, so the next scrape tick believed it still owned the row
  and overwrote the correction — silently, with no error and no audit row. Found
  in the 2026-08-19 engineering audit (critical #4).
- **Supersedes / amends:** nothing. Completes the ownership contract ADR-0058 D2
  designed into `mymrc/processed-bridge.ts` and applies the rule
  `workbook-sync/upsert.ts:150` already follows. The closed-day half enforces
  ADR-0037 D5 and the ADR-0028 amendment discipline. Sits alongside ADR-0118 —
  same night, same audit — but is a different decision and so a different record.

## Context

### 1. The ownership column nobody set

`processed_units_daily` is written by two authors: the office, by hand, and the
MyMRC bridge, from the portal. ADR-0058 D2 designed the arbitration between them
into the bridge's upsert, as a precedence guard in the SQL:

```sql
ON CONFLICT (site_id, production_date) DO UPDATE
  SET stripped_program = EXCLUDED.stripped_program, …
  WHERE processed_units_daily.source = 'mymrc'
    AND processed_units_daily.closed_at IS NULL
    AND ( … values actually differ … )
```

That `source = 'mymrc'` clause **is** the ownership mechanism. It is the entire
reason the bridge does not trample human entry, and it is correct.

The correction path never set the column it keys on. `upsertProcessedUnits`
passed `source: 'manual'` in its `create` payload only; the `update` payload
omitted it. So the sequence was:

1. The bridge creates the day from the portal — `source = 'mymrc'`, 900 units.
2. The office finds 900 wrong and corrects it to 1,234. The row still says
   `source = 'mymrc'`.
3. The next scrape tick runs. The bridge's guard passes — it still believes it
   owns the row — and the portal's 900 overwrites the human's 1,234.

Nothing errors. No audit row records the overwrite (the bridge does not write
one for a value it considers its own). `stripped_program` is the **billing
basis** — P2 bills MRC on it — so the office's correction disappears out of an
invoice input, and the only way to notice is to look at the number again.

`workbook-sync/upsert.ts:150` already sets `source` on its update path for
exactly this reason. This was drift from a rule the codebase had.

### 2. The closed-day check that was a read

The same function refused a closed day like this:

```ts
const existing = await prisma.processedUnitsDaily.findUnique({ … });   // read
if (existing?.closed_at) throw new ProcessedUnitsError('closed', …);   // decide
const row = await prisma.$transaction(async (tx) => {
  const upserted = await tx.processedUnitsDaily.upsert({ … });         // unguarded
```

The read is outside the transaction, and the transaction does not re-check. In
between, the office can close the day — `closeProcessedUnitsDay` is a separate
action on the same surface, and closing is what freezes the day as the billing
and inventory basis (its negative-balance guard exists precisely because closing
locks numbers in). The upsert then overwrote a closed day's figures and reported
success: an in-place post-close edit, which is the exact thing the refusal two
lines above it exists to forbid.

## Decision

**D1 — A manual write sets `source = 'manual'` on the UPDATE path, not only on
insert.** A correction is a claim of ownership. After it, the bridge's own
precedence guard declines the row, which is the behaviour ADR-0058 D2 intended
and could not deliver while the column went unset.

**D2 — The closed-day condition rides ON the statement.** The Prisma `upsert` is
replaced by the bridge's own `ON CONFLICT … DO UPDATE … WHERE closed_at IS NULL`
— copied from `mymrc/processed-bridge.ts`'s `UPSERT_SQL`, including the
`(xmax = 0) AS inserted` discriminator that tells the INSERT path from the
ON-CONFLICT-UPDATE path so the audit row is labelled correctly. Zero rows back
means a row existed and the guard refused it: the day is closed, and the typed
409 is raised inside the transaction so nothing else lands.

Prisma's fluent `upsert` cannot express this. Its `where` selects the row to
update; it is not a condition the update must satisfy. There is no way to say
"update only if still open" without the read this replaces.

**D3 — The view is built from a re-read on the same transaction.** `RETURNING`
carries only what the guard needs (`id`, `inserted`); every other column is read
back from the row that actually landed, so the returned view can never describe
a write that did not commit.

**D4 — The ownership handoff is audited.** `source: 'manual'` goes into the
audit row's `after`, because "this row is now human-owned and the bridge will
decline it" is a state change in its own right, not a side effect of editing a
number.

## Alternatives considered

- **Teach the bridge to skip rows with a recent `entered_by`.** Rejected: it
  replaces one implicit rule with a second implicit rule, in the component that
  should be the *least* clever of the two. `source` already exists, already means
  exactly this, and is already the thing the bridge tests.
- **A separate `owned_by_human` boolean.** Rejected: a second column meaning what
  `source` already means is a second column that can disagree with it.
- **Keep the Prisma `upsert` and re-check `closed_at` inside the transaction.**
  Rejected — it is the same read-then-write one level down. Under READ COMMITTED
  the re-read inside the transaction can still be stale relative to a close that
  commits between it and the write; only a condition on the writing statement is
  evaluated against the row version actually being written.
- **`SERIALIZABLE` for this transaction.** Rejected for the reasons ADR-0118
  records: it converts a silent overwrite into a serialization error that no
  caller here retries.

## Consequences

- The MyMRC bridge will now decline any day a human has touched, permanently,
  until someone changes `source` back. **That is the intent**, and it means a
  corrected day no longer receives portal updates. If the portal later publishes
  a genuinely better number for a corrected day, a human must apply it — which is
  the right escalation for a billing input, and is what "the office corrected
  this" is supposed to mean.
- A day closed concurrently with a correction now raises a typed 409 that the
  route already translates, instead of silently accepting an edit.
- The correction path now uses raw SQL where it used the Prisma client. That is a
  deliberate narrowing of expressiveness for a guarantee the client cannot
  express, and it follows a proven in-repo template rather than a new one. The
  cost is that `check-prisma-write-keys.mjs` cannot statically read this payload;
  the real-database suite covers it instead.
