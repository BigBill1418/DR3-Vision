// ADR-0049 D3 — workbook-wins upsert into `processed_units_daily` (the D3 target).
//
// Pre-cutover the workbook is the source of truth. For each daily-production row:
//   - no existing row for (site, date)         → INSERT (source=import, import_id).
//   - existing row, values AGREE               → no-op.
//   - existing row, values DISAGREE            → UPDATE to the workbook values AND,
//       when the prior row was VISION-CAPTURED (source != import), write ONE
//       `audit_log` row recording the overwrite (D3) and count it as an overwrite.
// Mid-edit rows (required cells empty) never reach here — the adapter skips + counts
// them (D11). All writes go through the caller's tx client so an overwrite and its
// audit row are atomic. Provenance is consistent with ADR-0048: source=`import`,
// `import_id` = the sync-run id.
//
// `closed_at` is deliberately PRESERVED (never cleared) on overwrite — the sync is
// the authoritative pre-cutover figure but must not disturb the operational close
// metadata; the audit row is the record of the change.
//
// ── ADR-0049 Am.3 / D13 — workbook-wins is NARROWED, per field ───────────────
//
// The rule: a `null` from the adapter means "the workbook did not STATE one". It
// never means "the workbook says none". Before this amendment every field was
// treated alike, with two consequences:
//
//   1. The Processed sheet has no employees / processors columns, so the adapter
//      reports them `null` — and the sync would write that null over a headcount a
//      manager had just entered on the close screen. Audited, but destroyed, and
//      the COR prefill (`src/lib/cor/prefill.ts`) loses its numbers with it.
//   2. Worse: `disagrees()` returned true on the HEADCOUNT ALONE, which rewrote
//      `source` to 'import'. That permanently locks the MyMRC bridge out of the row
//      (it updates only `WHERE source = 'mymrc'`), so unnarrowed workbook-wins
//      silently converted headcount data entry into an irreversible ownership
//      transfer, with no production figure changed.
//
// Three classes now:
//
//   `stripped_program` / `stripped_non_program` — workbook wins UNCONDITIONALLY.
//       Unchanged. A blank one never reaches here: the adapter skips the day
//       (D11/D12b), except for a blank non-program on an otherwise-complete close,
//       which is 0 and marked `strippedNonProgramInferred` (Am.3 A1).
//   `material_ticket_number` / `saved_units` — workbook wins WHEN IT STATES A
//       VALUE; a null leaves the stored value alone. The sync re-reads the same
//       file every 10 minutes, so a mid-edit blank is a routine every-poll event
//       while a deliberately retracted ticket is rare and manually correctable.
//       Getting this backwards means routine blanks chew through real values.
//   `employees_count` / `processors_count` — the sync NEVER touches them. Out of
//       the update payload and out of `disagrees()`.
//
// The honest cost, recorded rather than left for a future reader to discover: a row
// can now be MIXED-PROVENANCE — production figures from the workbook, headcount
// from Vision — while `source` remains a single scalar reading 'import'. `source`
// therefore describes the PRODUCTION FIGURES, not the whole row. The per-field
// audit trail remains the record of what actually changed.
//
// ── ADR-0123 — `manual` is ABOVE `import`, and the sync yields to it ─────────
//
// Everything above describes workbook-wins as a rule between the SYNC and the
// MyMRC BRIDGE. There is a third author, and the paragraph at "Worse:" already
// names the mechanism without noticing it applies to a human: writing
// `source = 'import'` is an OWNERSHIP SEIZURE, and it was unconditional.
//
// ADR-0119 gave the office desktop the same claim — a correction sets
// `source = 'manual'` on the UPDATE path, permanently locking the bridge out of
// a row a person has fixed. It did nothing about this writer, which read
// `existing.source` only to LABEL the audit row (`vision_overwrite`) and then
// overwrote the correction anyway. Audited, and destroyed. `stripped_program` is
// the billing basis P2 invoices MRC on, and this sync re-reads the same file
// every ten minutes during business hours, so a manual correction that disagreed
// with the spreadsheet had a life expectancy of under ten minutes.
//
// The precedence lattice, now stated in one place:
//
//     manual  >  import  >  mymrc
//
//   - `manual` — a person looked at the day and decided. Nothing overwrites it.
//     Corrections are re-corrected by people, on the same screen.
//   - `import` — the workbook, authoritative pre-cutover, still wins over the
//     portal (the original D3 rule, unchanged).
//   - `mymrc`  — the portal's own figure, the weakest claim. Its bridge already
//     yields to both by keying its UPDATE on `WHERE source = 'mymrc'`.
//
// Two of the three edges already existed. This adds the missing one, and the
// guard rides ON THE WRITING STATEMENT rather than on the read above it —
// `updateMany({ where: { id, source: { not: 'manual' } } })` — for the reason
// ADR-0119 D2 gives: under READ COMMITTED only a condition on the writing
// statement is evaluated against the row version actually being written, so a
// correction that commits between this loop's `findUnique` and its `update`
// would otherwise be overwritten by a check that had already passed.
//
// A skipped day is COUNTED and surfaced on the run ledger, never dropped
// silently. It is the same posture the approved-invoice guard (Am.4 B1) takes
// one level up: "the spreadsheet disagrees with something a human owns, and
// resolving that is a human decision, not this sync's."

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { DailyProductionRow } from './daily-adapter';

type TxClient = PrismaClient | Prisma.TransactionClient;

export interface UpsertArgs {
  db: TxClient;
  siteId: string;
  /** workbook_sync_runs.id — becomes `import_id` + the audit actor label suffix. */
  syncRunId: string;
  rows: DailyProductionRow[];
}

export interface UpsertResult {
  upserted: number; // inserts + value-changing updates
  overwritten: number; // subset of upserts that overwrote a Vision-captured row (audited)
  /**
   * ADR-0123 — days the workbook wanted to change that a PERSON owns.
   *
   * Counted rather than dropped. A guard whose only trace is the absence of a
   * write is a guard nobody can tell from a sync that had nothing to do, and
   * this one fires on exactly the days where the spreadsheet and a human
   * disagree — which is the case an operator most needs surfaced.
   */
  skippedManual: number;
}

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

interface ExistingRow {
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  material_ticket_number: string | null;
  saved_units: Prisma.Decimal | null;
}

/**
 * The fields this sync will actually WRITE for `row`, per the D13 narrowing.
 * A field the workbook did not state is simply absent, so Prisma leaves the
 * stored value untouched. `employees_count` / `processors_count` are absent
 * unconditionally — the workbook has no such column and never will.
 */
function writablePayload(row: DailyProductionRow): {
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  material_ticket_number?: string;
  saved_units?: Prisma.Decimal;
} {
  return {
    stripped_program: dec(row.strippedProgram),
    stripped_non_program: dec(row.strippedNonProgram),
    ...(row.materialTicketNumber !== null
      ? { material_ticket_number: row.materialTicketNumber }
      : {}),
    ...(row.savedUnits !== null ? { saved_units: dec(row.savedUnits) } : {}),
  };
}

/**
 * A disagreement check over ONLY the fields the sync will write. A field the
 * workbook did not state cannot disagree with anything — that is the whole point
 * of the narrowing, and it is why the headcounts are absent here as well as from
 * the payload: a headcount difference alone must never trigger a write, because
 * the write is what transfers ownership of the row away from the MyMRC bridge.
 */
function disagrees(row: DailyProductionRow, existing: ExistingRow): boolean {
  if (!existing.stripped_program.equals(dec(row.strippedProgram))) return true;
  if (!existing.stripped_non_program.equals(dec(row.strippedNonProgram))) return true;
  if (
    row.materialTicketNumber !== null &&
    existing.material_ticket_number !== row.materialTicketNumber
  ) {
    return true;
  }
  if (row.savedUnits !== null) {
    const savedNow = dec(row.savedUnits);
    if (existing.saved_units === null || !existing.saved_units.equals(savedNow)) return true;
  }
  return false;
}

export async function upsertDailyProduction(args: UpsertArgs): Promise<UpsertResult> {
  const { db, siteId, syncRunId, rows } = args;
  let upserted = 0;
  let overwritten = 0;
  let skippedManual = 0;

  for (const row of rows) {
    const productionDate = new Date(`${row.productionDate}T00:00:00.000Z`);
    const existing = await db.processedUnitsDaily.findUnique({
      where: { site_id_production_date: { site_id: siteId, production_date: productionDate } },
      select: {
        id: true,
        source: true,
        stripped_program: true,
        stripped_non_program: true,
        material_ticket_number: true,
        saved_units: true,
      },
    });

    const data = {
      ...writablePayload(row),
      source: 'import' as const,
      import_id: syncRunId,
    };

    if (!existing) {
      const created = await db.processedUnitsDaily.create({
        data: { site_id: siteId, production_date: productionDate, ...data },
        select: { id: true },
      });
      upserted += 1;
      await db.auditLog.create({
        data: {
          actor_label: `system:workbook-sync:${syncRunId}`,
          action: 'insert',
          table_name: 'processed_units_daily',
          row_id: created.id,
          before: Prisma.JsonNull,
          after: JSON.parse(
            JSON.stringify({
              site_id: siteId,
              production_date: row.productionDate,
              ...serialize(data, row),
            }),
          ),
        },
      });
      continue;
    }

    if (!disagrees(row, existing)) continue; // agreement ⇒ no-op

    const wasVisionCaptured = existing.source !== 'import';

    // ADR-0123 — the ownership guard, ON the writing statement.
    //
    // `updateMany` rather than `update` for one reason: Prisma's fluent `update`
    // takes a UNIQUE selector, not an arbitrary predicate, so `source` cannot
    // ride along and the check would have to sit on the `findUnique` above —
    // read-then-write, the exact shape ADR-0119 D2 and ADR-0118 D1 were written
    // to remove. Under READ COMMITTED a correction committing between the read
    // and the write is invisible to a check taken before it. `count === 0` is
    // the verdict, the same way `count === 0` is the verdict in `releaseHold`.
    //
    // The payload is scalar-only, so `updateMany`'s restriction costs nothing
    // here — `data` carries no nested writes and never has.
    const written = await db.processedUnitsDaily.updateMany({
      where: { id: existing.id, source: { not: 'manual' } },
      data,
    });
    if (written.count === 0) {
      // A person owns this day. Leave it, count it, and write NO audit row: the
      // sync re-reads the same file every ten minutes, so an audit row per
      // refusal would add ~150 rows a day per disputed day to an append-only
      // table that must never be cleaned up (hard rule #6). The run ledger
      // carries the count, which is the readable surface.
      skippedManual += 1;
      continue;
    }
    upserted += 1;
    if (wasVisionCaptured) overwritten += 1;

    // Audit EVERY change; flag the Vision-overwrite subset explicitly (D3).
    await db.auditLog.create({
      data: {
        actor_label: `system:workbook-sync:${syncRunId}`,
        action: 'update',
        table_name: 'processed_units_daily',
        row_id: existing.id,
        before: JSON.parse(
          JSON.stringify({
            source: existing.source,
            vision_overwrite: wasVisionCaptured,
            stripped_program: existing.stripped_program.toString(),
            stripped_non_program: existing.stripped_non_program.toString(),
            material_ticket_number: existing.material_ticket_number,
            saved_units: existing.saved_units?.toString() ?? null,
          }),
        ),
        after: JSON.parse(JSON.stringify(serialize(data, row))),
      },
    });
  }

  return { upserted, overwritten, skippedManual };
}

/**
 * The audit `after` payload: exactly the fields that were WRITTEN, plus the
 * provenance qualifier the figures need.
 *
 * `stripped_non_program_inferred` is the Am.3 A1 honesty marker. A blank
 * non-program cell on an otherwise-complete close is read as 0, which is right —
 * but the sheet did not SAY zero, and an audit row that records a bare 0 claims it
 * did. Fields the workbook did not state are ABSENT here, not null, because the
 * stored value was left alone and a null would read as "we wrote null".
 */
function serialize(
  data: {
    stripped_program: Prisma.Decimal;
    stripped_non_program: Prisma.Decimal;
    material_ticket_number?: string;
    saved_units?: Prisma.Decimal;
    source: string;
    import_id: string;
  },
  row: DailyProductionRow,
): Record<string, unknown> {
  return {
    stripped_program: data.stripped_program.toString(),
    stripped_non_program: data.stripped_non_program.toString(),
    stripped_non_program_inferred: row.strippedNonProgramInferred,
    ...(data.material_ticket_number !== undefined
      ? { material_ticket_number: data.material_ticket_number }
      : {}),
    ...(data.saved_units !== undefined ? { saved_units: data.saved_units.toString() } : {}),
    source: data.source,
    import_id: data.import_id,
  };
}
