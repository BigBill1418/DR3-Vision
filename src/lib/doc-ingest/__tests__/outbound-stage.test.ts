// ADR-0104 §D2 — the staging write: replace the PROPOSAL, never the DECISION.
//
// A re-absorption of the same revision happens routinely — a reparse, a retried
// sweep, a backlog drain. It must refresh what is waiting for a decision without
// touching what somebody already decided. Getting that wrong in either direction
// is silent:
//
//   - rewriting a CONFIRMED row would un-accept a weight a person attested to
//     and reset it to `staged`, and the only visible symptom would be a confirm
//     button reappearing;
//   - rewriting a DISCARDED row would resurrect a batch somebody rejected.
//
// Both are asserted here because neither would fail loudly in production.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { stageOutboundRows } from '../outbound-absorb';
import { stageFacilityExpenseRows } from '../facility-expense-absorb';
import type { OutboundExtractResult, OutboundLoad } from '../outbound-extract';
import type { FacilityExpenseExtractResult } from '../facility-expense-extract';

const V = 'ver-1';
const SRC = 'src-1';
const SITE = 'site-woodland';
const NOW = new Date('2026-08-16T18:00:00.000Z');

interface Stored {
  external_materials_id?: string;
  sheet_name: string;
  row_index: number;
  status: string;
  [k: string]: unknown;
}

function makeTx() {
  const loads: Stored[] = [];
  const commodities: Stored[] = [];
  const expenses: Stored[] = [];
  const deleted: string[] = [];

  const table = (rows: Stored[], name: string) => ({
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      deleted.push(`${name}:${String(where['status'])}`);
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i];
        if (
          r &&
          r['doc_source_version_id'] === where['doc_source_version_id'] &&
          r.status === where['status']
        ) {
          rows.splice(i, 1);
        }
      }
      return { count: 0 };
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const wanted = (where['status'] as { in?: string[] } | undefined)?.in ?? [];
      return rows.filter(
        (r) => r['doc_source_version_id'] === where['doc_source_version_id'] && wanted.includes(r.status),
      );
    }),
    createMany: vi.fn(async ({ data }: { data: Stored[] }) => {
      rows.push(...data);
      return { count: data.length };
    }),
  });

  return {
    tx: {
      docOutboundLoadRow: table(loads, 'loads'),
      docOutboundCommodityRow: table(commodities, 'commodities'),
      docFacilityExpenseRow: table(expenses, 'expenses'),
    },
    loads,
    commodities,
    expenses,
    deleted,
  };
}

function load(id: string, weight: number, commodities: string[] = ['Steel']): OutboundLoad {
  return {
    externalMaterialsId: id,
    bolId: '2378',
    accountNameRaw: 'DR3 Woodland',
    materialsStatus: 'Active',
    materialsRecordType: 'Outbound',
    shipmentDateISO: '2026-02-02',
    shipmentDateRaw: '2026-02-02',
    totalWeightLbs: weight,
    totalWeightCheckLbs: -weight,
    programUnits: 0,
    nonProgramUnits: 0,
    sheetName: 'Outbound Feb 2026',
    rowIndex: 5,
    commodities: commodities.map((c) => ({ commodity: c, weightLbs: weight, disposition: 'Recycling' })),
  };
}

function outboundResult(loads: OutboundLoad[]): OutboundExtractResult {
  return {
    loads,
    sheets: [],
    duplicatesRemoved: 0,
    duplicateSources: [],
    signCheckFailures: [],
    partsCheckFailures: [],
    totals: { totalWeightLbs: 0, commodityRows: 0 },
    failure: null,
  };
}

let h: ReturnType<typeof makeTx>;
beforeEach(() => {
  h = makeTx();
});

describe('stageOutboundRows', () => {
  const args = () => ({ sourceId: SRC, versionId: V, siteId: SITE, now: NOW });

  it('stages parent and child rows with full provenance', async () => {
    const res = await stageOutboundRows(h.tx as never, {
      ...args(),
      result: outboundResult([load('M-1', 8100, ['Steel', 'Waste'])]),
    });

    expect(res).toEqual({ staged: 1, commodityRows: 2, collisions: [] });
    expect(h.loads[0]).toMatchObject({
      doc_source_id: SRC,
      doc_source_version_id: V,
      site_id: SITE,
      external_materials_id: 'M-1',
      total_weight_lbs: 8100,
      // Kept so the guardrail can assert the sign. Never read as a weight.
      total_weight_check_lbs: -8100,
      status: 'staged',
      sheet_name: 'Outbound Feb 2026',
      row_index: 5,
    });
    expect(h.commodities.map((c) => c['commodity'])).toEqual(['Steel', 'Waste']);
    // Children are deleted BEFORE parents — a commodity row whose load has gone
    // is a weight with no shipment.
    expect(h.deleted).toEqual(['commodities:staged', 'loads:staged']);
  });

  it('NEVER rewrites a load somebody already confirmed', async () => {
    h.loads.push({
      doc_source_version_id: V,
      external_materials_id: 'M-1',
      sheet_name: 'Outbound Feb 2026',
      row_index: 5,
      status: 'confirmed',
      total_weight_lbs: 8100,
      confirmed_by: 'user-bill',
    });

    // The workbook now says a DIFFERENT weight for the same load.
    const res = await stageOutboundRows(h.tx as never, {
      ...args(),
      result: outboundResult([load('M-1', 99999), load('M-2', 7420)]),
    });

    // M-1 is skipped entirely. Re-staging it would silently reset an accepted
    // weight to `staged` and lose the attestation.
    expect(res.staged).toBe(1);
    expect(h.loads.filter((r) => r.status === 'confirmed')).toHaveLength(1);
    expect(h.loads.find((r) => r.status === 'confirmed')?.['total_weight_lbs']).toBe(8100);
    expect(h.loads.filter((r) => r.status === 'staged').map((r) => r.external_materials_id)).toEqual([
      'M-2',
    ]);
  });

  it('NEVER resurrects a load somebody discarded', async () => {
    h.loads.push({
      doc_source_version_id: V,
      external_materials_id: 'M-1',
      sheet_name: 'Outbound Feb 2026',
      row_index: 5,
      status: 'discarded',
    });
    const res = await stageOutboundRows(h.tx as never, {
      ...args(),
      result: outboundResult([load('M-1', 8100)]),
    });
    expect(res.staged).toBe(0);
    expect(h.loads).toHaveLength(1);
  });

  it('reports a same-batch id collision instead of failing the whole absorption', async () => {
    // The extractor de-duplicates, so this is unreachable through it. But the
    // unique index would reject the second row as a hard P2002 and take the
    // WHOLE absorption down — 831 loads lost to one repeat — and a drop nobody
    // is told about is the silent-zero class this pipeline exists to stop.
    const res = await stageOutboundRows(h.tx as never, {
      ...args(),
      result: outboundResult([load('M-1', 8100), load('M-1', 8100)]),
    });
    expect(res.staged).toBe(1);
    expect(res.collisions).toEqual(['M-1']);
  });
});

describe('stageFacilityExpenseRows', () => {
  function sheet(rowIndexes: number[]): FacilityExpenseExtractResult {
    return {
      sheetName: 'WOODLAND 2026',
      sheetYear: 2026,
      headerRowIndex: 3,
      headers: [],
      rows: rowIndexes.map((rowIndex) => ({
        rowIndex,
        presentOnDailyLog: null,
        receiptRaw: null,
        invoiceDateISO: null,
        invoiceDateRaw: '5',
        invoiceMonthLabel: 'February',
        invoiceDay: 5,
        amount: 900,
        creditAmount: null,
        categoryRaw: 'Transportation',
        categoryNorm: 'transportation',
        invoiceNumber: null,
        notes: null,
        machineIdRaw: null,
        dayRaw: null,
        commodityRaw: null,
        haulRef: null,
        gallons: null,
      })),
      bannerRows: 0,
      subtotalRows: 0,
      repeatedHeaderRows: 0,
      totals: { amount: 900, creditAmount: 0 },
      failure: null,
    };
  }

  it('stages the sheet’s rows with the month/day split preserved', async () => {
    const res = await stageFacilityExpenseRows(h.tx as never, {
      sourceId: SRC,
      versionId: V,
      siteId: SITE,
      perSheet: [sheet([4, 5])],
      now: NOW,
    });
    expect(res).toEqual({ staged: 2, collisions: [] });
    expect(h.expenses[0]).toMatchObject({
      sheet_name: 'WOODLAND 2026',
      sheet_year: 2026,
      // The date the sheet did NOT write stays null; the two halves it DID
      // write are both kept.
      invoice_date: null,
      invoice_date_raw: '5',
      invoice_month_label: 'February',
      invoice_day: 5,
      status: 'staged',
    });
  });

  it('NEVER rewrites a row somebody already decided', async () => {
    h.expenses.push({
      doc_source_version_id: V,
      sheet_name: 'WOODLAND 2026',
      row_index: 4,
      status: 'confirmed',
      amount: 900,
    });
    const res = await stageFacilityExpenseRows(h.tx as never, {
      sourceId: SRC,
      versionId: V,
      siteId: SITE,
      perSheet: [sheet([4, 5])],
      now: NOW,
    });
    expect(res.staged).toBe(1);
    expect(h.expenses.filter((r) => r.status === 'confirmed')).toHaveLength(1);
  });
});
