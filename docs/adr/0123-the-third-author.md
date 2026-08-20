# ADR-0123 — The third author

- **Status:** Accepted
- **Date:** 2026-08-20
- **Extends:** ADR-0119 (a correction takes ownership), ADR-0049 D3 / Am.3 D13
  (workbook-wins, narrowed), ADR-0058 D2 (the bridge's precedence guard)

## Context

`processed_units_daily` holds the number MRC is invoiced on. It has **three**
writers, and until this ADR only two of them had a rule about each other.

| writer                                                       | `source` written | ownership rule before this ADR                        |
| ------------------------------------------------------------ | ---------------- | ----------------------------------------------------- |
| `upsertProcessedUnits` — the office desktop / manager screen | `manual`         | wins over everything, refuses a closed day (ADR-0119) |
| `bridgeProcessedToInventory` — the MyMRC portal bridge       | `mymrc`          | updates only `WHERE source = 'mymrc'` (ADR-0058 D2)   |
| `upsertDailyProduction` — the workbook sync                  | `import`         | **none**                                              |

ADR-0119's whole mechanism is that a human correction sets `source = 'manual'`,
which permanently yields the row from the bridge. It closed the bridge's half and
did not look at the third writer, which was writing `source = 'import'`
**unconditionally on both paths** — an ownership seizure, not a guard.

`upsert.ts`'s own header already described the mechanism without noticing it
applied to a person. Under "Worse:" it records that an unnarrowed write "rewrites
`source` to 'import'", which "permanently locks the MyMRC bridge out of the row",
and calls that "an irreversible ownership transfer". It reached the same
conclusion about headcounts and stopped one field short of the figures.

So the sync read `existing.source`, used it **only to label the audit row**
(`vision_overwrite: true`), and then overwrote the correction. Audited, and
destroyed. And the sync re-reads the same file every ten minutes during business
hours (Mon–Fri 06:00–20:00 PT), so **a manual correction that disagreed with the
spreadsheet had a life expectancy of under ten minutes.**

The existing test suite made this worse rather than catching it. Two cases —
`upsert.test.ts`'s "overwrites a disagreeing VISION-CAPTURED (manual) row and
writes an audit entry flagging the overwrite" and `engine.test.ts`'s "overwrites
a Vision-captured day with an audit entry" — asserted the clobber **as the
contract**, and asserted the audit row as evidence of correctness. The loss was
recorded; it was just not prevented.

### What prod actually held, and what it did NOT show

The brief for this work stated that Bill's M-186301 correction (2026-08-19
Woodland, 970→960 program / 100→110 non-program) was absent from prod because the
09:39 AM PT workbook import had overwritten it. **The first half is true; the
causal half is not, and it is worth recording rather than repeating.**

```
 site     | production_date | stripped_program | stripped_non_program | ticket   | source | updated_at (UTC)
 woodland | 2026-08-19      |            970.0 |                100.0 | M-186301 | import | 2026-08-20 16:39:18
```

The audit trail for that row holds exactly one entry:

```
 created_at (UTC)        | actor_label                          | action | before | after
 2026-08-20 16:39:18.194 | system:workbook-sync:bc80c46b-…      | insert |        | 970 / 100 / import
```

An **insert**, not an update — so no row existed before 09:39 AM PT today, and
therefore no manual row was overwritten. Every `processed_units_daily` audit row
in the last four days is from workbook-sync; there is **no manual write at all**.
The MyMRC mirror also reads 970/100 for M-186301, and the sync has been running
healthily every ten minutes all day (`changes_detected = t` on several ticks with
`rows_upserted = 0`, i.e. the workbook still says 970/100).

The correction is therefore absent from the workbook, from MyMRC, and from the
app's table. **It was never persisted anywhere the system can see** — which is a
separate open question for Bill, not something this ADR resolves.

What this ADR fixes is the reason re-entering it would not have helped. Today,
without the guard, a correction to 960/110 would be overwritten back to 970/100
by the next sync tick that noticed the disagreement — within ten minutes, with
an audit row recording the loss and nothing preventing it.

## Decision

**D1 — The author-precedence lattice, stated in one place:**

```
manual  >  import  >  mymrc
```

- **`manual`** — a person looked at the day and decided. Nothing overwrites it.
  Corrections are re-corrected by people, on the same screen. (ADR-0119, and the
  closed-day rule still applies on top.)
- **`import`** — the workbook, authoritative pre-cutover, still wins over the
  portal. ADR-0049 D3 is **unchanged**.
- **`mymrc`** — the portal's figure, the weakest claim. Already yields to both.

Two of the three edges existed. This adds the missing one. Nothing about the
existing edges moves, and there is a test asserting the `import > mymrc` edge
specifically so a future reader cannot mistake this for a retirement of
workbook-wins.

**D2 — The guard rides ON the writing statement, not on the read above it.**

```ts
const written = await db.processedUnitsDaily.updateMany({
  where: { id: existing.id, source: { not: 'manual' } },
  data,
});
if (written.count === 0) {
  skippedManual += 1;
  continue;
}
```

`updateMany`, not `update`, because Prisma's fluent `update` takes a **unique
selector** — its `where` picks the row, it is not a condition the update must
satisfy — so `source` cannot ride along and the check would have to sit on the
`findUnique` above. That is read-then-write, the shape ADR-0118 D1 and ADR-0119
D2 exist to remove: under READ COMMITTED, a correction committing between the
read and the write is invisible to a check taken before it. `count === 0` is the
verdict, the same way it is in `releaseHold`.

`updateMany` is scalar-only. That costs nothing here — this payload has never
carried a nested write.

**D3 — A refusal is COUNTED on the run ledger, and writes NO audit row.**

New column `workbook_sync_runs.rows_skipped_manual`, mirroring
`rows_skipped_billed` (ADR-0049 Am.4 B1), which is the same shape one level up:
the approved-invoice guard that leaves a day alone because "resolving that is a
human decision, not this sync's".

A guard whose only trace is the absence of a write cannot be told apart from a
sync that had nothing to do — and this one fires on exactly the days where the
spreadsheet and a person disagree, which is the case an operator most needs
surfaced.

An audit row per refusal was rejected. The sync retries every ten minutes, so one
disputed day is ~84 rows a day in a table that is append-only and must never be
cleaned up (hard rule #6). The audit log records what CHANGED; a refusal changed
nothing.

**D4 — `skippedManual` counts refusals, not manual rows.**

It increments only when the workbook actually wanted to change the row. A day a
person owns and the spreadsheet agrees with is a silent no-op. Conflating the two
would make the counter non-zero forever for every corrected day, and a signal
that is always on is not a signal.

## Alternatives rejected

- **Refuse the whole tick when any day is manually owned.** One corrected day
  would stop the other twenty-nine from syncing. The guard is per-row because the
  ownership is per-row.
- **Skip on the `findUnique` (`if (existing.source === 'manual') continue`).**
  Simpler, and it passes the mocked suite. It loses the mid-tick correction, and
  `upsert-ownership.db.test.ts` has a case that fails on exactly that.
- **Raw SQL with `ON CONFLICT … WHERE`, matching the bridge's `UPSERT_SQL`.**
  Would work. Rejected because `scripts/check-prisma-write-keys.mjs` (ADR-0115)
  cannot statically read a raw-SQL payload — ADR-0119 §Consequences records
  paying that price already, and there is no reason to pay it twice when
  `updateMany` expresses the same predicate.
- **A `locked_by_human` boolean.** A second column meaning what `source` already
  means is a second column that can disagree with it. ADR-0119 rejected the same
  proposal and the reasoning has not changed.
- **Letting the sync write the non-owned fields only.** `source` describes the
  PRODUCTION FIGURES (Am.3's recorded honest cost), and those are precisely the
  fields under dispute. There is nothing left to write.

## Consequences

- **A corrected day stops receiving workbook updates entirely** — the same
  intended consequence ADR-0119 recorded for the bridge, now true of the third
  author. If the workbook is later fixed to agree, the day still reads `manual`
  and keeps the human's figure; changing it back is a human action on the manager
  screen, which is the point.
- **`rows_overwritten` narrows in meaning.** It counted "overwrote a
  Vision-captured row"; with `manual` now unreachable, it counts overwrites of
  `mymrc` rows only. The computation is unchanged, so historic values still mean
  what they meant.
- **Two tests were INVERTED, not deleted.** Both are annotated with the old title
  and the recorded red, because "an existing test pinned the defect as the
  contract" is the most useful thing a future reader can learn from this change.
- **Bill must RE-ENTER the 960/110 correction after this deploys.** The current
  prod value is the uncorrected import figure. It is his data entry and was not
  written on his behalf. Once entered, it will now stand.
- **Residual, unchanged by this ADR:** the INSERT path still has no conflict
  clause, so a manual row created between this loop's `findUnique` and its
  `create` raises a unique violation that fails the tick. Pre-existing, retried
  ten minutes later, and out of scope — recorded in `docs/OPEN-ITEMS.md` §0.BH.
