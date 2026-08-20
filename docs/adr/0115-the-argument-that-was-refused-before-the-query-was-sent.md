# ADR-0115 — The argument that was refused before the query was sent

- **Status:** Accepted, implemented 2026-08-19 (Pacific)
- **Context:** Every inbound workbook promotion has thrown at runtime since
  `87a605be` (2026-07-06, PR #77). `import_id` is NULL on all 743
  `inbound_loads` rows in prod — the path has never landed a row. Found by the
  2026-08-19 Phase 0 Woodland parity audit (finding **F-5**), proven on an
  isolated scratch database, and repaired here.
- **Supersedes / amends:** nothing. Enforces ADR-0048 §86-92 (inbound promotion
  provenance rides on `import_id` alone). Extends ADR-0078 (the real-database
  CI lane) with two suites and ADR-0033/ADR-0035 (the correctness gates) with
  one new hard gate.

## Context

`promoteWorkbookImport` writes six operational tables inside one
`$transaction`. Five of them carry a `RecordSource` provenance column and are
correctly stamped `source: 'import'`. The sixth is `inbound_loads`, and it was
stamped the same way:

```ts
await tx.inboundLoad.createMany({
  data: candidates.inbound.map((i) => ({
    site_id: scope.siteId,
    source_id: i.sourceId,
    ...
    source: 'import' as const,   // ← not a field of this model
    import_id: pid,
  })),
});
```

`InboundLoad.source` is the `Source?` **relation** — where the mattresses came
from, already set one line up via `source_id`. It is not a `RecordSource`
column. `InboundLoadCreateManyInput` has 44 fields and `source` is not among
them; `createMany` cannot write relations at all, only scalars.

The file already knew this. Ninety lines above the defect, its own
`CONFLICT_TABLES` entry says so verbatim:

> NB: `inbound_loads.source` is the Source RELATION (where mattresses come
> from), NOT a RecordSource provenance column. Inbound promotion provenance
> rides on `import_id` alone — so a live (non-promoted) inbound row is exactly
> `import_id IS NULL`.

So does ADR-0048. The code contradicted both, and nothing said so for six weeks.

## What actually happened at runtime

Prisma rejects an unknown argument at **argument validation**, strictly before
the query is sent:

```
PrismaClientValidationError: Invalid `tx.inboundLoad.createMany()` invocation
  Unknown argument `source`. Did you mean `source_id`? Available options are marked with ?.
```

This is the part that matters for blast radius. It is **not** a silently
discarded key, and it is not a failure of the inbound insert alone. The throw
propagates out of `tx.inboundLoad.createMany` and aborts the enclosing
`$transaction`, so the promotion ledger row, the anchor snapshot, and the
processed / outbound / landfilled / dropoff rows all roll back with it. A
promotion containing even one inbound row promoted **nothing**.

The prod corroboration is exact: `import_id` is NULL on all 743
`inbound_loads` rows.

Calibration on the one thing that is _not_ proven: the promotion path is
operator-driven from `/admin/audit/workbook/[importId]`, and we have no record
of how many times an operator attempted it and got a 500. The claim here is
"no promoted inbound row has ever landed", which the NULL column proves. It is
not a claim about how much operator time was lost to it.

## Why nothing caught it

Three independent guards were in place and all three were structurally blind.

**The type-checker cannot see it.** `npx tsc --noEmit` exits 0, with the file
in scope, twice — once with `--incremental false` to defeat the build cache.
The suppression is Prisma's own signature: `SelectSubset<T, S>` maps only the
top-level argument keys (`data`, `skipDuplicates`) and lets `T['data']` through
unmapped, so excess-property ("freshness") checking is gone before the nested
payload is ever compared. This is not a gap in the repo's typecheck
configuration; it is a property of the generated client, and no `tsconfig`
setting recovers it.

**Both promotion suites inject fake clients.**
`workbook-promotion.test.ts:105,134` and
`workbook-promotion.source-link.test.ts:130,146` each build a hand-rolled
object whose inbound writer is:

```ts
createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
  for (const d of data) inbound.push({ id: id(), ...d });
  return { count: data.length };
},
```

A fake that accepts every payload cannot reject an unknown argument. It agreed
with the bug and reported the promotion as successful — the specific failure
mode where a mock is more permissive than the dependency it stands in for, so
the test measures the fixture rather than the system.

**A merely unreachable database would not have caught it either.** This is
worth recording because it is the tempting cheap fix. With a bad
`DATABASE_URL`, the payload _with_ `source` and the payload _without_ it both
raise `PrismaClientInitializationError` — the connection failure masks the
validation failure and the two branches collapse. A test written that way
passes on the broken code. The check is only expressible against a real,
reachable Postgres.

## Decision

**1. Delete the field.** One line. Provenance already rides on `import_id`,
exactly as ADR-0048 specifies. The deletion carries a comment naming the
relation-vs-column distinction, because the next author reading five sibling
tables that all stamp `source` will otherwise "restore" it.

**2. Pin it with a real client.**
`src/lib/audit/workbook-promotion.inbound-write.db.test.ts` drives the real
`promoteWorkbookImport` against a real Postgres, and asserts the landed row
**from the database** rather than from the return value — the return value is
computed before the write and would still have been correct if the transaction
had rolled back. It runs in the ADR-0078 lane, which already stands up an
ephemeral Postgres 16 and applies the whole migration chain.

Verified red-then-green, not assumed: on the unrepaired tree the suite fails
with `Unknown argument 'source'` at `workbook-promotion.ts:1156`; on the
repaired tree it passes and the row is present with `import_id` = the promotion
id and `source_id` = the resolved Source.

**3. Gate the whole class, not the instance.**
`scripts/check-prisma-write-keys.mjs` reads the model field sets out of the
**generated** client and checks every statically-readable Prisma write payload
in `src/` and `scripts/` for keys the model does not accept. It is wired into
CI as a hard gate immediately after `prisma generate`.

Two properties were deliberate:

- **Per-method field sets, never unioned.** `InboundLoadCreateInput` _does_
  have a `source` key — the relation-connect form — while
  `InboundLoadCreateManyInput` does not. A union of the two declares the F-5
  payload legal, and the first draft of this script did exactly that and
  reported the live defect as a clean tree. `createMany` is checked against
  `CreateManyInput` alone; `upsert`'s two halves are checked against different
  sets.
- **It reports what it could not read.** Every run prints
  `payloads checked N · payloads not statically readable M` (currently 344 and
  76). A payload built from a spread, a computed key, or a helper is not
  statically decidable, and a gate that answers "clean" without saying how much
  it skipped is indistinguishable from a gate that is switched off. It also
  exits non-zero — not zero — when the generated client is missing, rather than
  reporting a pass it did not earn.

Falsified before being trusted: re-injecting `source: 'import' as const` makes
the gate exit 1 and name `src/lib/audit/workbook-promotion.ts:1157`.

**4. Make the sibling zero-row silence audible (F-4).** The same audit found
`resolveTransportationInputs` selecting `where transport_charged = true` while
nothing in the codebase writes that column — it is DDL-default `false` on all
743 prod rows, read at `generation-inputs.ts:272` and `leg-fetchers.ts:105`,
written nowhere. Every _per-load_ problem in that function throws loudly, but a
zero-row select just skips the loop: no freight legs, no fuel legs, no error,
and a CA transportation invoice that is structurally empty with nothing saying
so.

This ADR adds the report, and deliberately does **not** add the writer. The two
zero-cases are separated, because a warning that fires on both is noise that
gets tuned out:

| window contains                     | meaning                           | emitted |
| ----------------------------------- | --------------------------------- | ------- |
| no billing-ready inbound at all     | genuinely quiet month             | `info`  |
| billing-ready inbound, none flagged | freight leg silently under-billed | `warn`  |

Pinned by `src/lib/invoices/transportation-zero-row.db.test.ts` (three cases,
including a not-billing-ready load that must stay quiet — the case a count that
forgot the status filter gets wrong). Mutation-checked: neutering the warn
branch fails exactly one of the three.

## Consequences

- Inbound workbook promotion can land rows for the first time since
  2026-07-06. **Nothing was retro-promoted by this change** — the June/July
  imports that failed remain unpromoted and re-running them is an operator
  action, not a migration.
- No schema change, no migration, and no billing amount or status set moves.
  The F-4 change is log-only.
- CI gains one hard gate that runs in about a second and needs no database.
- The two fake-client promotion suites are left in place. They still cover
  decode/resolve/refusal logic cheaply and correctly; what they cannot cover is
  now covered beside them. The lesson is not "delete the fakes" — it is that a
  claim about what the _database driver_ accepts cannot be made against a fake.

## What this does not decide

`transport_charged` still has no writer, so the CA inbound freight and
fuel-surcharge leg still generates empty — it is now merely _loud_ about it. Who
sets that flag (the verify gate from `sources.is_trans_charge`, an EOD
add-line, or an `/admin/sources` surface) is gap **G-2/G-3** of the Phase 0
audit and is Bill's decision, not this ADR's.
