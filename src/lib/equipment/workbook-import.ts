// ADR-0081 — the TEREX workbook's monthly history, written into the machine's
// own table.
//
// Bill: "use the excel sheet to pull in the historical data - then STARTING
// TODAY you will just take in the data that JT enters here but ALL OF THAT DATA
// needs to be aggregated and displayed IN THIS PAGE."
//
// The extraction lives in `@/lib/doc-ingest/terex-monthly-extract` (pure, and
// measured against the real 490,670-byte artifact rather than a fixture). This
// module is the part that touches the database, and everything in it exists to
// make one of four promises keepable:
//
//   R4  version-scoped and idempotent — the same revision twice is a NO-OP; a
//       NEWER revision SUPERSEDES rather than accumulating.
//   R5  reconciled or nothing — a month that does not add up stages the WHOLE
//       import; nothing is applied and the offenders are named.
//   JT  a manager's row is never overwritten by the sheet. Adjudicated by the
//       database inside one statement, never by a read-then-write.
//   ——  `processed_units_daily` is NEVER written. Not "not currently"; there is
//       no code path. `import.never-writes-processed-units-daily` spies for it.

import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { dayKeyUTCFromISO } from '@/lib/time';
import {
  MONTHLY_MAX_COLS,
  MONTHLY_TABS,
  extractMonthlyRows,
  type MonthlyExtractResult,
  type PublishedTotals,
} from '@/lib/doc-ingest/terex-monthly-extract';
import { WORKBOOK_IMPORT_SOURCE } from './daily-throughput';
import { toCell } from '@/lib/doc-ingest/trailer-absorb';
import type { Cell } from '@/lib/doc-ingest/trailer-extract';

/**
 * ADR-0036 / ADR-0077 actor discipline. The import has no signed-in human, so it
 * NAMES ITSELF rather than borrowing a `users.id` and writing a false claim into
 * a trail hard rule #6 means we can never take it back out of.
 */
export const WORKBOOK_IMPORT_ACTOR = 'system:workbook-import';

/**
 * The database surface this module actually uses, stated STRUCTURALLY rather
 * than as `PrismaClient`.
 *
 * Two reasons, both load-bearing. It keeps the module's reach VISIBLE — the type
 * is the complete list of what an import may touch, and `processedUnitsDaily` is
 * conspicuously not on it, so widening the blast radius means editing this type
 * in the same diff. And it lets a test pass a fake whose `processedUnitsDaily`
 * THROWS, which is what turns "we don't write that table" from a claim into
 * something `import.never-writes-processed-units-daily` can prove.
 */
export interface ImportTx {
  equipmentDailyThroughput: {
    deleteMany(args: {
      where: { equipment_id: string; source: string };
    }): Promise<{ count: number }>;
  };
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

export interface ImportDb {
  equipmentDailyThroughput: {
    count(args: { where: { equipment_id: string; import_version_id: string } }): Promise<number>;
  };
  $transaction<T>(fn: (tx: ImportTx) => Promise<T>): Promise<T>;
}

type Db = ImportDb;

export interface WorkbookImportOptions {
  siteId: string;
  equipmentId: string;
  /** `doc_source_versions.id` — the revision these rows are a projection of. */
  versionId: string;
  bytes: Uint8Array;
  /**
   * FALSE (the default) runs everything — read, extract, reconcile, and report
   * exactly what WOULD change — and writes nothing. ADR-0081 R6: the preview is
   * the thing a human reads before the thing a human authorises, so it must not
   * be a different code path from the one that writes. It is the same call.
   */
  apply?: boolean;
  prisma?: Db;
  /**
   * Injectable so tests never load exceljs — the same seam `parse.ts` uses for
   * `readWorkbook`/`readPdfText`, and for the same reason. It replaces ONLY the
   * bytes-to-cells step; the extraction, the reconciliation and every write path
   * below are the real ones, so a test that injects cells is still exercising
   * the code that runs in production.
   */
  readWorkbook?: (bytes: Uint8Array) => Promise<ReadWorkbook>;
}

export interface WorkbookImportReport {
  versionId: string;
  applied: boolean;
  /** ADR-0081 R4 — this exact revision was already on record; nothing was done. */
  alreadyApplied: boolean;
  /** ADR-0081 R5 — a month failed to reconcile, so NOTHING was applied. */
  stagedForReconciliation: boolean;
  offendingTabs: string[];
  extraction: MonthlyExtractResult;
  /** Rows the extractor produced and this module offered to the database. */
  rowsOffered: number;
  /** Rows actually inserted or updated. */
  rowsWritten: number;
  /**
   * Days the import did NOT take because a MANAGER owns them. This is the
   * JT-wins rule showing its work: a non-zero count here is the feature
   * operating, not a failure.
   */
  rowsYieldedToManager: string[];
  /** ADR-0081 R4 — prior-version import rows removed as part of supersession. */
  rowsSuperseded: number;
  dateRange: { firstISO: string; lastISO: string } | null;
}

/** One worksheet reduced to the two things the extractor and reconciler need. */
export interface ReadWorkbook {
  sheets: { name: string; cells: Cell[][] }[];
  published: Map<string, PublishedTotals>;
}

/** `SUM(B3:B30)` → `{ firstRow: 3, lastRow: 30 }`. Anything else → null. */
function parseSumRange(formula: unknown): { firstRow: number; lastRow: number } | null {
  if (typeof formula !== 'string') return null;
  const m = /^SUM\([A-Z]+(\d+):[A-Z]+(\d+)\)$/i.exec(formula.trim());
  if (!m) return null;
  const firstRow = Number(m[1]);
  const lastRow = Number(m[2]);
  return Number.isFinite(firstRow) && Number.isFinite(lastRow) ? { firstRow, lastRow } : null;
}

function formulaOf(v: unknown): string | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o['formula'] === 'string' ? o['formula'] : null;
}

function resultOf(v: unknown): number | null {
  if (v === null || typeof v !== 'object') return typeof v === 'number' ? v : null;
  const o = v as Record<string, unknown>;
  return typeof o['result'] === 'number' ? o['result'] : null;
}

/**
 * Read the workbook into cells, and collect the figures the workbook itself
 * PUBLISHES for each month.
 *
 * The published half is gathered here rather than in the pure extractor because
 * it needs two things only the live parser has: the totals row's FORMULA (so the
 * declared SUM range can be read — see `PublishedTotals.unitsRange` for the two
 * tabs whose totals under-cover their own data), and the OVERVIEW tabs' formulas
 * (so the cell that REFERENCES a month's total can be found by what it points
 * at rather than by where it sits on a 193×57 grid).
 */
export async function readMonthlyWorkbook(bytes: Uint8Array): Promise<ReadWorkbook> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  type ExcelBuffer = Parameters<typeof workbook.xlsx.load>[0];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await workbook.xlsx.load(view as unknown as ExcelBuffer);

  const sheets: { name: string; cells: Cell[][] }[] = [];
  for (const ws of workbook.worksheets) {
    const cells: Cell[][] = [];
    for (let r = 1; r <= ws.rowCount; r += 1) {
      const row: Cell[] = [];
      for (let c = 1; c <= MONTHLY_MAX_COLS; c += 1)
        row.push(toCell(ws.getRow(r).getCell(c).value));
      cells.push(row);
    }
    sheets.push({ name: ws.name, cells });
  }

  // ── OVERVIEW cross-references, found by what they POINT AT ────────────────
  // `='Jan 2026'!G34` is the workbook naming its own total-hours cell for
  // January. Matching on the reference rather than on a grid position is what
  // keeps this from breaking when a row is inserted into a summary tab.
  const overviewHours = new Map<string, number>();
  const overviewAvgPocketCoil = new Map<string, number>();
  for (const ws of workbook.worksheets) {
    if (!/^OVERVIEW/i.test(ws.name)) continue;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const f = formulaOf(cell.value);
        const n = resultOf(cell.value);
        if (f === null || n === null) return;
        const direct = /^'?([^'!]+)'?!G\d+$/.exec(f.trim());
        if (direct?.[1] && !overviewHours.has(direct[1])) overviewHours.set(direct[1], n);
        const avg = /AVERAGEIFS\('?([^'!]+)'?!B\d+:B\d+,\s*'?[^'!]+'?!B\d+:B\d+,\s*">0"\)/.exec(f);
        if (avg?.[1] && !overviewAvgPocketCoil.has(avg[1])) overviewAvgPocketCoil.set(avg[1], n);
      });
    });
  }

  const published = new Map<string, PublishedTotals>();
  for (const tab of MONTHLY_TABS) {
    const ws = workbook.getWorksheet(tab.name);
    let units: number | null = null;
    let hours: number | null = null;
    let unitsRange: { firstRow: number; lastRow: number } | null = null;
    let hoursRange: { firstRow: number; lastRow: number } | null = null;

    if (ws) {
      // The totals row is the first row after the last day-number row — the same
      // boundary rule the extractor uses, so both are looking at the same block.
      let started = false;
      for (let r = 2; r <= Math.min(ws.rowCount, 60); r += 1) {
        const a = toCell(ws.getRow(r).getCell(1).value);
        const isDay = a.num !== null && Number.isInteger(a.num) && a.num >= 1 && a.num <= 31;
        if (isDay) {
          started = true;
          continue;
        }
        if (!started) continue;
        const cellVal = (c: number) => ws.getRow(r).getCell(c).value;
        const numAt = (c: number) => toCell(cellVal(c)).num ?? 0;
        units = numAt(2) + numAt(3) + numAt(4);
        hours = numAt(7);
        unitsRange =
          parseSumRange(formulaOf(cellVal(2))) ??
          parseSumRange(formulaOf(cellVal(3))) ??
          parseSumRange(formulaOf(cellVal(4)));
        hoursRange = parseSumRange(formulaOf(cellVal(7)));
        break;
      }
    }

    published.set(tab.name, {
      units,
      hours,
      unitsRange,
      hoursRange,
      overviewHours: overviewHours.get(tab.name) ?? null,
      overviewAvgPocketCoil: overviewAvgPocketCoil.get(tab.name) ?? null,
    });
  }

  return { sheets, published };
}

/**
 * Import the workbook's monthly history for one machine at one site.
 *
 * Ordering is deliberate and is the whole safety argument:
 *   1. extract + reconcile FIRST, touching nothing;
 *   2. refuse outright if any month failed R5 — a partial application of a
 *      workbook one of whose months does not add up is the worst outcome
 *      available, because it looks like it worked;
 *   3. refuse (as a no-op) if this exact version is already on record;
 *   4. only then, in ONE transaction, supersede the prior version's rows and
 *      write this one's.
 */
export async function importWorkbookHistory(
  opts: WorkbookImportOptions,
): Promise<WorkbookImportReport> {
  const db: Db = opts.prisma ?? (defaultPrisma as unknown as Db);
  const apply = opts.apply === true;

  const read = opts.readWorkbook ?? readMonthlyWorkbook;
  const { sheets, published } = await read(opts.bytes);
  const extraction = extractMonthlyRows(sheets, published);

  const sorted = [...extraction.rows].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  const dateRange =
    sorted.length === 0
      ? null
      : { firstISO: sorted[0]!.dateISO, lastISO: sorted[sorted.length - 1]!.dateISO };

  const base: WorkbookImportReport = {
    versionId: opts.versionId,
    applied: false,
    alreadyApplied: false,
    stagedForReconciliation: extraction.hardStop,
    offendingTabs: extraction.offendingTabs,
    extraction,
    rowsOffered: sorted.length,
    rowsWritten: 0,
    rowsYieldedToManager: [],
    rowsSuperseded: 0,
    dateRange,
  };

  // ── ADR-0081 R5 — the hard stop ───────────────────────────────────────────
  // Checked BEFORE the idempotency probe and before any write. A month that does
  // not reconcile means this module's reading of the sheet and the sheet's own
  // arithmetic disagree, and there is no honest way to guess which is right from
  // inside the importer.
  if (extraction.hardStop) return base;

  // ── ADR-0081 R4 — this exact revision, already applied ────────────────────
  const existingThisVersion = await db.equipmentDailyThroughput.count({
    where: { equipment_id: opts.equipmentId, import_version_id: opts.versionId },
  });
  if (existingThisVersion > 0) {
    return { ...base, alreadyApplied: true };
  }

  if (!apply) return base;

  // ── The write ─────────────────────────────────────────────────────────────
  let rowsWritten = 0;
  const rowsYieldedToManager: string[] = [];
  let rowsSuperseded = 0;

  await db.$transaction(async (tx) => {
    // SUPERSEDE, never accumulate (R4). Scoped to `source = 'workbook_import'`
    // so a manager's row is untouchable here as well as in the upsert — the two
    // guards are independent on purpose, because this one runs when the upsert
    // has not happened yet and could not protect anything.
    //
    // A hard DELETE rather than a soft-void: an imported row is a PROJECTION of
    // a document revision, not a person's claim, so replacing it is a
    // re-projection rather than a reversal. Soft-voiding would leave one dead
    // row per day per revision forever, invisible behind the partial unique
    // index and reachable by nothing. The batch is audited below, so the fact
    // that a supersession happened is still append-only history.
    const deleted = await tx.equipmentDailyThroughput.deleteMany({
      where: { equipment_id: opts.equipmentId, source: WORKBOOK_IMPORT_SOURCE },
    });
    rowsSuperseded = deleted.count;

    for (const row of sorted) {
      // ── THE JT-WINS GUARD ────────────────────────────────────────────────
      // `ON CONFLICT (equipment_id, throughput_date) WHERE voided_at IS NULL`
      // infers ADR-0079's PARTIAL unique index; the `DO UPDATE ... WHERE
      // source = 'workbook_import'` makes a manager's row un-overwritable.
      //
      // When the WHERE is false the statement affects ZERO rows — the day is
      // simply left as the manager wrote it. That zero is the signal this loop
      // reads, which is why the guard is in the statement rather than in a
      // prior SELECT: a read-then-write would race a manager saving that same
      // day and would overwrite the entry it had just decided to respect.
      //
      // Every value is a bound parameter. Nothing here is string-interpolated.
      const affected = await tx.$executeRaw`
        INSERT INTO "equipment_daily_throughput"
          ("id", "site_id", "equipment_id", "throughput_date", "units_processed",
           "run_hours", "notes", "created_by", "actor_label", "source",
           "import_version_id", "created_at", "updated_at")
        VALUES
          (gen_random_uuid()::text, ${opts.siteId}, ${opts.equipmentId},
           ${dayKeyUTCFromISO(row.dateISO)}::date, ${row.unitsTotal},
           ${new Prisma.Decimal(row.runHours.toFixed(2))}::decimal(5,2),
           ${row.notes}, NULL, ${WORKBOOK_IMPORT_ACTOR}, ${WORKBOOK_IMPORT_SOURCE},
           ${opts.versionId}, NOW(), NOW())
        ON CONFLICT ("equipment_id", "throughput_date") WHERE "voided_at" IS NULL
        DO UPDATE SET
          "units_processed"   = EXCLUDED."units_processed",
          "run_hours"         = EXCLUDED."run_hours",
          "notes"             = EXCLUDED."notes",
          "import_version_id" = EXCLUDED."import_version_id",
          "updated_at"        = NOW()
        WHERE "equipment_daily_throughput"."source" = ${WORKBOOK_IMPORT_SOURCE}
      `;
      if (affected > 0) rowsWritten += 1;
      else rowsYieldedToManager.push(row.dateISO);
    }

    // One audit row for the BATCH, not 319 of them. The unit of decision here is
    // the revision, and a per-row trail would bury the one fact a reader needs
    // (which revision produced this history) under a day-by-day replay of a
    // document that is itself archived and re-readable.
    await tx.auditLog.create({
      data: {
        actor_user_id: null,
        actor_label: WORKBOOK_IMPORT_ACTOR,
        action: 'insert',
        table_name: 'equipment_daily_throughput',
        row_id: opts.versionId,
        before: rowsSuperseded > 0 ? { superseded_import_rows: rowsSuperseded } : Prisma.DbNull,
        after: {
          import_version_id: opts.versionId,
          equipment_id: opts.equipmentId,
          rows_offered: sorted.length,
          rows_written: rowsWritten,
          rows_yielded_to_manager: rowsYieldedToManager,
          date_range: dateRange,
          tabs_extracted: extraction.tabs
            .filter((t) => t.status === 'extracted')
            .map((t) => t.name),
        },
      },
    });
  });

  return {
    ...base,
    applied: true,
    rowsWritten,
    rowsYieldedToManager,
    rowsSuperseded,
  };
}
