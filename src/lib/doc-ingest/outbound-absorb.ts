// ADR-0104 §D2/§D5 — reading the outbound workbook and STAGING the rows.
//
// The exceljs adapter and the DB write live here so `absorb.ts` keeps one shape:
// gate, read bytes, dispatch by kind, record the outcome. `outbound-extract.ts`
// stays pure and is tested against hand-written fixtures.
//
// ── Why these rows STAGE, when the trailer list did not ────────────────────
// `doc_trailer_rows` writes directly because it carries weights and dates rather
// than money. These carry weights too, and they stage anyway. The reason is
// specific, not precautionary (§D5): the outbound weights are the input to
// CalRecycle stewardship percentages and to MRC reporting, this is the largest
// single injection of figures the system has taken (831 loads, ~5.9 million lb),
// and the cross-sheet de-duplication in §D3 is a JUDGEMENT — 556 of 1,387
// candidate rows are dropped as duplicates — that a human should ratify once.
//
// A confirm writes an OPERATOR'S NAME against the batch. Nothing in this module,
// and no route it feeds, can take that decision.

import type { Prisma, PrismaClient } from '@prisma/client';
import { extractOutboundRows, type OutboundExtractResult } from './outbound-extract';
import { toCell } from './trailer-absorb';
import type { Cell } from './trailer-extract';

/**
 * Columns scanned per row.
 *
 * The widest measured monthly sheet is 39 columns (`Total Outbound Materials
 * Weight` sits at index 38 once the `Column1` filler is present). 48 leaves
 * headroom for a commodity column being added without the last column falling
 * off the edge — and if one ever did, the parts-vs-total assertion in the
 * extractor is what would say so, rather than a silently smaller number.
 */
const MAX_COLS = 48;

export interface OutboundWorkbookResult {
  sheetNames: string[];
  result: OutboundExtractResult;
}

/**
 * Read every sheet, then let the extractor decide which are outbound sheets.
 *
 * Every sheet is collected in WORKBOOK ORDER, because that order is the
 * de-duplication tie-break (§D3) — the first sheet to yield a Materials ID wins.
 */
export async function extractOutboundFromWorkbook(
  bytes: Uint8Array,
): Promise<OutboundWorkbookResult> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  type ExcelBuffer = Parameters<typeof workbook.xlsx.load>[0];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await workbook.xlsx.load(view as unknown as ExcelBuffer);

  const sheetNames: string[] = [];
  const handles: { name: string; rowCount: number; get: (r: number, c: number) => unknown }[] = [];
  workbook.eachSheet((ws) => {
    sheetNames.push(ws.name);
    handles.push({
      name: ws.name,
      rowCount: ws.rowCount,
      get: (r, c) => ws.getRow(r).getCell(c).value,
    });
  });

  const collected: { name: string; cells: Cell[][] }[] = [];
  for (const h of handles) {
    const cells: Cell[][] = [];
    for (let r = 1; r <= h.rowCount; r += 1) {
      const row: Cell[] = [];
      for (let c = 1; c <= MAX_COLS; c += 1) row.push(toCell(h.get(r, c)));
      cells.push(row);
    }
    collected.push({ name: h.name, cells });
  }

  return { sheetNames, result: extractOutboundRows(collected) };
}

export interface StageOutboundResult {
  staged: number;
  commodityRows: number;
  /**
   * Materials IDs dropped because another load in the SAME batch already claimed
   * the id.
   *
   * The extractor de-duplicates, so this should always be empty — but the unique
   * index would reject a second one as a hard P2002 and take the WHOLE
   * absorption down with it, and a drop nobody is told about is the silent-zero
   * class this pipeline exists to stop. So it is caught, counted, and recorded
   * in the audit row.
   */
  collisions: string[];
}

/**
 * Replace this VERSION's staged rows with the extracted set.
 *
 * CONFIRMED and DISCARDED rows are never touched. A re-absorption of the same
 * revision refreshes what is waiting for a decision; it does not un-accept a
 * weight somebody already accepted, and it does not resurrect a batch somebody
 * discarded.
 *
 * The `$transaction` wrapper lives in the CALLER (`absorb.ts`), matching the
 * existing three absorbers.
 */
export async function stageOutboundRows(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    sourceId: string;
    versionId: string;
    siteId: string;
    result: OutboundExtractResult;
    now: Date;
  },
): Promise<StageOutboundResult> {
  // Children first: a commodity row whose parent has gone is a weight with no
  // load, and the FK is ON DELETE CASCADE at the version, not at the parent.
  await tx.docOutboundCommodityRow.deleteMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
  });
  await tx.docOutboundLoadRow.deleteMany({
    where: { doc_source_version_id: args.versionId, status: 'staged' },
  });

  const already = await tx.docOutboundLoadRow.findMany({
    where: {
      doc_source_version_id: args.versionId,
      status: { in: ['confirmed', 'discarded'] },
    },
    select: { external_materials_id: true },
  });
  const decided = new Set(already.map((r) => r.external_materials_id));

  const claimed = new Set<string>();
  const collisions: string[] = [];
  const loadData: Prisma.DocOutboundLoadRowCreateManyInput[] = [];
  const commodityData: Prisma.DocOutboundCommodityRowCreateManyInput[] = [];

  for (const load of args.result.loads) {
    const id = load.externalMaterialsId;
    if (decided.has(id)) continue;
    if (claimed.has(id)) {
      collisions.push(id);
      continue;
    }
    claimed.add(id);

    loadData.push({
      doc_source_id: args.sourceId,
      doc_source_version_id: args.versionId,
      site_id: args.siteId,
      sheet_name: load.sheetName,
      row_index: load.rowIndex,
      external_materials_id: id,
      bol_id: load.bolId,
      account_name_raw: load.accountNameRaw,
      materials_status: load.materialsStatus,
      materials_record_type: load.materialsRecordType,
      shipment_date:
        load.shipmentDateISO === null ? null : new Date(`${load.shipmentDateISO}T00:00:00.000Z`),
      shipment_date_raw: load.shipmentDateRaw,
      total_weight_lbs: load.totalWeightLbs,
      total_weight_check_lbs: load.totalWeightCheckLbs,
      program_units: load.programUnits === null ? null : Math.round(load.programUnits),
      non_program_units:
        load.nonProgramUnits === null ? null : Math.round(load.nonProgramUnits),
      status: 'staged' as const,
      absorbed_at: args.now,
    });

    for (const c of load.commodities) {
      commodityData.push({
        doc_source_id: args.sourceId,
        doc_source_version_id: args.versionId,
        site_id: args.siteId,
        external_materials_id: id,
        commodity: c.commodity,
        weight_lbs: c.weightLbs,
        disposition: c.disposition,
        sheet_name: load.sheetName,
        row_index: load.rowIndex,
        status: 'staged' as const,
        absorbed_at: args.now,
      });
    }
  }

  if (loadData.length === 0) return { staged: 0, commodityRows: 0, collisions };
  const loadsCreated = await tx.docOutboundLoadRow.createMany({ data: loadData });
  const commoditiesCreated =
    commodityData.length === 0
      ? { count: 0 }
      : await tx.docOutboundCommodityRow.createMany({ data: commodityData });

  return {
    staged: loadsCreated.count,
    commodityRows: commoditiesCreated.count,
    collisions,
  };
}

/**
 * A human-readable account of what each sheet held and what was removed.
 *
 * This is what the LOUD ZERO says instead of "the document was empty", and it is
 * also what the preview screen shows so that the de-duplicated total is
 * BELIEVABLE rather than merely smaller.
 */
export function describeOutboundSheets(result: OutboundExtractResult): string {
  const read = result.sheets.filter((s) => s.skipped === null);
  const skipped = result.sheets.filter((s) => s.skipped !== null);
  const parts = [
    `${read.length} outbound sheet(s) read: ` +
      `${read.map((s) => `"${s.sheetName}" (${s.loadsFound} load(s) of ${s.rowsSeen} row(s), header row ${s.headerRowIndex})`).join(', ') || '(none)'}.`,
  ];
  if (result.duplicatesRemoved > 0) {
    const sheetsThatDuplicated = [
      ...new Set(read.filter((s) => s.rowsSeen > s.loadsFound).map((s) => s.sheetName)),
    ];
    parts.push(
      `${result.duplicatesRemoved} duplicate load(s) removed — the same shipment appearing on more ` +
        `than one sheet (${sheetsThatDuplicated.map((s) => `"${s}"`).join(', ')}). Counting them ` +
        `would have inflated the tonnage.`,
    );
  }
  if (skipped.length > 0) {
    parts.push(
      `${skipped.length} sheet(s) were NOT outbound listings and were left alone: ` +
        `${skipped.map((s) => `"${s.sheetName}"`).join(', ')}.`,
    );
  }
  if (result.signCheckFailures.length > 0) {
    parts.push(
      `${result.signCheckFailures.length} load(s) where "Total Outbound Materials Weight" is NOT ` +
        `the negation of "Total Outbound Weight" (${result.signCheckFailures.slice(0, 10).join(', ')}). ` +
        `The positive figure was used, as always; this is reported so a change to the workbook's ` +
        `convention cannot pass unnoticed.`,
    );
  }
  if (result.partsCheckFailures.length > 0) {
    parts.push(
      `${result.partsCheckFailures.length} load(s) where the commodity columns do not sum to the ` +
        `load total (${result.partsCheckFailures.slice(0, 10).join(', ')}) — the shape a NEW ` +
        `commodity column this extractor does not know about would produce.`,
    );
  }
  return parts.join(' ');
}
