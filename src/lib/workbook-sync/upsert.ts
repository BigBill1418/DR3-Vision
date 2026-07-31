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
    await db.processedUnitsDaily.update({ where: { id: existing.id }, data });
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

  return { upserted, overwritten };
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
