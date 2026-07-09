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

/** A field-by-field disagreement check between the workbook row and the stored row. */
function disagrees(row: DailyProductionRow, existing: {
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  material_ticket_number: string | null;
  employees_count: number | null;
  processors_count: number | null;
  saved_units: Prisma.Decimal | null;
}): boolean {
  if (!existing.stripped_program.equals(dec(row.strippedProgram))) return true;
  if (!existing.stripped_non_program.equals(dec(row.strippedNonProgram))) return true;
  if ((existing.material_ticket_number ?? null) !== (row.materialTicketNumber ?? null)) return true;
  if ((existing.employees_count ?? null) !== (row.employeesCount ?? null)) return true;
  if ((existing.processors_count ?? null) !== (row.processorsCount ?? null)) return true;
  const savedNow = row.savedUnits === null ? null : dec(row.savedUnits);
  if ((existing.saved_units === null) !== (savedNow === null)) return true;
  if (existing.saved_units !== null && savedNow !== null && !existing.saved_units.equals(savedNow)) return true;
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
        employees_count: true,
        processors_count: true,
        saved_units: true,
      },
    });

    const data = {
      stripped_program: dec(row.strippedProgram),
      stripped_non_program: dec(row.strippedNonProgram),
      material_ticket_number: row.materialTicketNumber,
      employees_count: row.employeesCount,
      processors_count: row.processorsCount,
      saved_units: row.savedUnits === null ? null : dec(row.savedUnits),
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
          after: JSON.parse(JSON.stringify({ site_id: siteId, production_date: row.productionDate, ...serialize(data) })),
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
        before: JSON.parse(JSON.stringify({
          source: existing.source,
          vision_overwrite: wasVisionCaptured,
          stripped_program: existing.stripped_program.toString(),
          stripped_non_program: existing.stripped_non_program.toString(),
          material_ticket_number: existing.material_ticket_number,
          employees_count: existing.employees_count,
          processors_count: existing.processors_count,
          saved_units: existing.saved_units?.toString() ?? null,
        })),
        after: JSON.parse(JSON.stringify(serialize(data))),
      },
    });
  }

  return { upserted, overwritten };
}

function serialize(data: {
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  material_ticket_number: string | null;
  employees_count: number | null;
  processors_count: number | null;
  saved_units: Prisma.Decimal | null;
  source: string;
  import_id: string;
}): Record<string, unknown> {
  return {
    stripped_program: data.stripped_program.toString(),
    stripped_non_program: data.stripped_non_program.toString(),
    material_ticket_number: data.material_ticket_number,
    employees_count: data.employees_count,
    processors_count: data.processors_count,
    saved_units: data.saved_units?.toString() ?? null,
    source: data.source,
    import_id: data.import_id,
  };
}
