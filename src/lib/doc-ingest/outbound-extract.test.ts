// ADR-0104 §D2/§D3 — outbound weight-audit extraction.
//
// Fixtures mirror the REAL workbook read out of R2 on 2026-08-16, header text
// for header text. The three shapes that matter are all reproduced:
//   - `Outbound Feb 2026` — header on row 4, `Account Name` present, real Excel
//     `Date` cells, `Column1` filler at index 1;
//   - `Feb2026 outbounds` — header on row 1, the SAME loads, shipment dates as
//     Excel serials;
//   - `April2026 Outbounds` — `Account Name` replaced by the literal header
//     `Column1`, so the sheet carries no account at all.
//
// Every guard below was FALSIFIED before it was kept — each `it` that asserts a
// trap is closed has a sibling that shows the trap open. A dedup test that
// passes without ever having failed proves nothing.

import { describe, expect, it } from 'vitest';
import {
  COMMODITY_STEMS,
  excelSerialToISO,
  extractOutboundRows,
  usDateTextToISO,
} from './outbound-extract';
import type { Cell } from './trailer-extract';

const E: Cell = { text: '', num: null, date: null };
const s = (text: string): Cell => ({ text, num: null, date: null });
const n = (v: number): Cell => ({ text: String(v), num: v, date: null });
const d = (iso: string): Cell => ({ text: iso, num: null, date: iso });

/**
 * The live monthly header row, verbatim. Index 1 is the `Column1` filler that
 * appears on some sheets and not others — the reason columns are resolved by
 * NAME and never by offset.
 */
function monthlyHeader(opts: { account?: boolean } = {}): Cell[] {
  return [
    s(opts.account === false ? 'Column1' : 'Account Name'),
    s('Column1'),
    s('Materials: Record Type'),
    s('Materials: Materials ID'),
    s('Materials Status'),
    s('# of Attached Files'),
    s('Shipment Date'),
    s('Outbound Vendor Materials Record'),
    s('BOL ID'),
    s('Total Outbound Weight'),
    s('Steel (lbs)'),
    s('Steel Disposition'),
    s('Waste (lbs)'),
    s('Waste Disposition'),
    s('Whole Mattresses and Foundations (lbs)'),
    s('Whole Mattresses/Foundations Disposition'),
    s('Number of Program Units'),
    s('Number of Non-Program Units'),
    s('Total Outbound Materials Weight'),
  ];
}

/** A merged title banner — the reason the header row is not row 1 on 6 sheets. */
const TITLE: Cell[] = [s('Woodland Outbound Auditing 2026'), E, E, E, E];

interface LoadSpec {
  id: string;
  ship: Cell;
  steel?: number;
  waste?: number;
  /** Defaults to the negation of the total, as the real file always writes it. */
  check?: number;
}

function loadRow(spec: LoadSpec): Cell[] {
  const steel = spec.steel ?? 0;
  const waste = spec.waste ?? 0;
  const total = steel + waste;
  return [
    s('DR3 Woodland'),
    E,
    s('Outbound'),
    s(spec.id),
    s('Active'),
    n(1),
    spec.ship,
    s('VC-000113'),
    s('2378'),
    n(total),
    n(steel),
    steel > 0 ? s('Recycling') : E,
    n(waste),
    waste > 0 ? s('Landfill') : E,
    // Always written as a literal 0 by the export — a recorded zero, not a blank.
    n(0),
    E,
    n(0),
    n(0),
    n(spec.check ?? -total),
  ];
}

/** The five pivot sheets carry margins, not loads, and must be REFUSED. */
const PIVOT_SHEET = {
  name: 'Foam_Topper',
  cells: [
    [s('FOAM / TOPPER'), E, E, E],
    [E, E, s('total weight'), s('$/ton'), s('total cost'), s('gross profit'), s('net profit')],
    [E, s('Jan'), n(108480), n(0.06), n(4350), n(11730.82), n(7380.82)],
  ] as Cell[][],
};

describe('extractOutboundRows — the real workbook shape', () => {
  it('finds the header row wherever it is, and reads the loads', () => {
    // Header on row 4, exactly like `Outbound Feb 2026`.
    const result = extractOutboundRows([
      {
        name: 'Outbound Feb 2026',
        cells: [
          TITLE,
          [E],
          [E],
          monthlyHeader(),
          loadRow({ id: 'M-160053', ship: d('2026-02-02'), steel: 6561, waste: 1539 }),
          loadRow({ id: 'M-160054', ship: d('2026-02-02'), steel: 6010, waste: 1410 }),
        ],
      },
    ]);

    expect(result.failure).toBeNull();
    expect(result.sheets[0]?.headerRowIndex).toBe(4);
    expect(result.loads).toHaveLength(2);
    const first = result.loads[0];
    expect(first?.externalMaterialsId).toBe('M-160053');
    expect(first?.totalWeightLbs).toBe(8100);
    expect(first?.shipmentDateISO).toBe('2026-02-02');
    expect(first?.bolId).toBe('2378');
    expect(first?.accountNameRaw).toBe('DR3 Woodland');
    expect(first?.materialsStatus).toBe('Active');
    // Row 5 of the sheet, 1-based — provenance back to the cell.
    expect(first?.rowIndex).toBe(5);
  });

  it('reads a sheet whose header row is row 10 (the January sheet)', () => {
    const blanks = [[E], [E], [E], [E], [E], [E], [E], [E]];
    const result = extractOutboundRows([
      {
        name: 'Outbound Jan 2026',
        cells: [
          TITLE,
          ...blanks,
          monthlyHeader(),
          loadRow({ id: 'M-156388', ship: s('1/2/2026'), steel: 1389 }),
        ],
      },
    ]);
    expect(result.sheets[0]?.headerRowIndex).toBe(10);
    expect(result.loads).toHaveLength(1);
    expect(result.loads[0]?.shipmentDateISO).toBe('2026-01-02');
  });

  it('takes the weight from Total Outbound Weight, never from the check column', () => {
    const result = extractOutboundRows([
      {
        name: 'Outbound Feb 2026',
        cells: [monthlyHeader(), loadRow({ id: 'M-160053', steel: 6561, waste: 1539, ship: E })],
      },
    ]);

    const load = result.loads[0];
    // THE SIGN TRAP. An extractor that reached for the right-most, most
    // official-sounding column would put -8100 here and every weight in the
    // operation would be negative — internally consistent, and wrong.
    expect(load?.totalWeightLbs).toBe(8100);
    expect(load?.totalWeightCheckLbs).toBe(-8100);
    expect(load?.totalWeightLbs).toBeGreaterThan(0);
    expect(result.totals.totalWeightLbs).toBe(8100);
  });

  it('FALSIFIES the sign guard: a check column that is not the negation is reported', () => {
    const result = extractOutboundRows([
      {
        name: 'Outbound Jan 2026',
        cells: [
          monthlyHeader(),
          // The two live rows that genuinely disagree: M-159724 (7760 vs -6286)
          // and M-172079 (4215 vs -4160). They are surfaced, not suppressed, and
          // they do NOT sink the sheet.
          loadRow({ id: 'M-159724', steel: 7760, ship: E, check: -6286 }),
          loadRow({ id: 'M-160053', steel: 6561, waste: 1539, ship: E }),
        ],
      },
    ]);

    expect(result.signCheckFailures).toEqual(['M-159724']);
    // Both loads survive. A disagreeing check column is a finding, not a refusal.
    expect(result.loads).toHaveLength(2);
    expect(result.failure).toBeNull();
  });

  it('reports a commodity total that does not reconcile to the parts', () => {
    const broken = loadRow({ id: 'M-200001', steel: 1000, ship: E });
    // The total says 5000 while the only commodity cell says 1000 — the shape a
    // workbook edit that ADDS a commodity column would produce.
    broken[9] = n(5000);
    broken[18] = n(-5000);
    const result = extractOutboundRows([{ name: 'Outbound Jun 2026', cells: [monthlyHeader(), broken] }]);

    expect(result.partsCheckFailures).toEqual(['M-200001']);
    expect(result.loads).toHaveLength(1);
  });
});

describe('extractOutboundRows — cross-sheet de-duplication (§D3)', () => {
  const febLoads = [
    loadRow({ id: 'M-160053', ship: d('2026-02-02'), steel: 6561, waste: 1539 }),
    loadRow({ id: 'M-160054', ship: d('2026-02-02'), steel: 6010, waste: 1410 }),
  ];
  // The SAME two loads, re-pasted with the shipment date as an Excel serial.
  // 46055 is 2026-02-02.
  const febDuplicateLoads = [
    loadRow({ id: 'M-160053', ship: n(46055), steel: 6561, waste: 1539 }),
    loadRow({ id: 'M-160054', ship: n(46055), steel: 6010, waste: 1410 }),
  ];

  it('keeps the first sheet’s copy and drops the identical second sheet', () => {
    const result = extractOutboundRows([
      { name: 'Outbound Feb 2026', cells: [monthlyHeader(), ...febLoads] },
      { name: 'Feb2026 outbounds', cells: [monthlyHeader(), ...febDuplicateLoads] },
    ]);

    // N loads, NOT 2N. This is the whole point of the workbook-level shape.
    expect(result.loads).toHaveLength(2);
    expect(result.duplicatesRemoved).toBe(2);
    expect(result.duplicateSources).toEqual([
      'M-160053 also on "Outbound Feb 2026"',
      'M-160054 also on "Outbound Feb 2026"',
    ]);
    // The tonnage is the real tonnage, not 1.5x it.
    expect(result.totals.totalWeightLbs).toBe(15520);
    // Both sheets are reported as read — a dropped duplicate is not a skipped
    // sheet, and the outcome distinguishes them.
    expect(result.sheets.map((x) => [x.sheetName, x.rowsSeen, x.loadsFound])).toEqual([
      ['Outbound Feb 2026', 2, 2],
      ['Feb2026 outbounds', 2, 0],
    ]);
  });

  it('FALSIFIES the dedup guard: a naive per-sheet sum would report 2x', () => {
    const perSheetNaive = [
      { name: 'Outbound Feb 2026', cells: [monthlyHeader(), ...febLoads] },
      { name: 'Feb2026 outbounds', cells: [monthlyHeader(), ...febDuplicateLoads] },
    ].map((sheet) => extractOutboundRows([sheet]));

    // Extracting the sheets INDEPENDENTLY — which is what the per-sheet
    // `commodity-extract.ts` shape would do — cannot see the duplication, and
    // the totals add to twice the truth.
    const naiveTotal = perSheetNaive.reduce((a, r) => a + r.totals.totalWeightLbs, 0);
    expect(naiveTotal).toBe(31040);
    expect(naiveTotal).toBe(2 * 15520);
    for (const r of perSheetNaive) expect(r.duplicatesRemoved).toBe(0);
  });

  it('disposes of the filtered subset sheet with no special case', () => {
    // `xtraction (2)` carries 11 ids that all appear on `Outbound Jan 2026`, and
    // only TWO of the thirteen commodity columns.
    const subsetHeader = [
      s('Account Name'),
      s('Column1'),
      s('Materials: Record Type'),
      s('Materials: Materials ID'),
      s('Materials Status'),
      s('# of Attached Files'),
      s('Shipment Date'),
      s('Outbound Vendor Materials Record'),
      s('BOL ID'),
      s('Total Outbound Weight'),
      s('Steel (lbs)'),
      s('Steel Disposition'),
      s('Waste (lbs)'),
      s('Waste Disposition'),
      s('Total Outbound Materials Weight'),
    ];
    const result = extractOutboundRows([
      {
        name: 'Outbound Jan 2026',
        cells: [monthlyHeader(), loadRow({ id: 'M-158258', ship: s('1/19/2026'), steel: 8181, waste: 1919 })],
      },
      {
        name: 'xtraction (2)',
        cells: [
          [s('Extraction'), E],
          subsetHeader,
          [
            s('DR3 Woodland'),
            E,
            s('Outbound'),
            s('M-158258'),
            s('Active'),
            n(1),
            s('1/19/2026'),
            s('VC-000113'),
            s('2476'),
            n(10100),
            n(8181),
            s('Recycling'),
            n(1919),
            s('Landfill'),
            n(-10100),
          ],
        ],
      },
    ]);

    expect(result.loads).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.loads[0]?.sheetName).toBe('Outbound Jan 2026');
  });
});

describe('extractOutboundRows — sheet candidacy (§D3)', () => {
  it('REFUSES the pivot sheets and says which header was missing', () => {
    const result = extractOutboundRows([
      { name: 'Outbound Feb 2026', cells: [monthlyHeader(), loadRow({ id: 'M-1', ship: E, steel: 10 })] },
      PIVOT_SHEET,
    ]);

    const pivot = result.sheets.find((x) => x.sheetName === 'Foam_Topper');
    // Asserted as a REFUSAL, not merely as an absence. A sheet silently missing
    // from the output and a sheet deliberately declined look identical in a row
    // count, and only one of them is correct.
    expect(pivot?.skipped).toBe('not_an_outbound_sheet');
    expect(pivot?.missingHeaders).toEqual(['Materials: Materials ID', 'Shipment Date']);
    expect(result.loads).toHaveLength(1);
  });

  it('refuses a sheet that has the ID column but no Shipment Date', () => {
    const partial = monthlyHeader();
    partial[6] = s('Ship Day');
    const result = extractOutboundRows([{ name: 'half', cells: [partial] }]);
    expect(result.sheets[0]?.missingHeaders).toEqual(['Shipment Date']);
    expect(result.failure?.kind).toBe('no_candidate_sheets');
  });

  it('reports no_loads when a candidate sheet holds no Materials ID', () => {
    const result = extractOutboundRows([{ name: 'Outbound Feb 2026', cells: [monthlyHeader()] }]);
    expect(result.failure?.kind).toBe('no_loads');
    expect(result.sheets[0]?.skipped).toBeNull();
  });

  it('never throws on a sheet with no rows at all', () => {
    expect(() => extractOutboundRows([{ name: 'blank', cells: [] }])).not.toThrow();
    expect(extractOutboundRows([]).failure?.kind).toBe('no_candidate_sheets');
  });
});

describe('extractOutboundRows — columns resolved by name, never by offset', () => {
  it('reads a sheet whose Account Name column is headed Column1', () => {
    // Both April sheets. `accountNameRaw` is null and every other field still
    // resolves — because an absent optional column yields null rather than
    // shifting every column after it.
    const result = extractOutboundRows([
      {
        name: 'April2026 Outbounds',
        cells: [
          monthlyHeader({ account: false }),
          loadRow({ id: 'M-167035', ship: d('2026-04-01'), steel: 34680 }),
        ],
      },
    ]);
    const load = result.loads[0];
    expect(load?.accountNameRaw).toBeNull();
    expect(load?.externalMaterialsId).toBe('M-167035');
    expect(load?.totalWeightLbs).toBe(34680);
    expect(load?.bolId).toBe('2378');
  });

  it('handles the one disposition header that breaks the pattern', () => {
    const result = extractOutboundRows([
      {
        name: 'Outbound Feb 2026',
        cells: [monthlyHeader(), loadRow({ id: 'M-1', ship: E, steel: 100 })],
      },
    ]);
    // `Whole Mattresses and Foundations (lbs)` pairs with
    // `Whole Mattresses/Foundations Disposition`, not with
    // `Whole Mattresses and Foundations Disposition`. Resolving it explicitly is
    // why the 0 cell still produces a row.
    const wm = result.loads[0]?.commodities.find(
      (c) => c.commodity === 'Whole Mattresses and Foundations',
    );
    expect(wm).toBeDefined();
    expect(wm?.weightLbs).toBe(0);
    expect(wm?.disposition).toBeNull();
  });

  it('keeps a recorded 0 and drops a BLANK commodity cell', () => {
    const result = extractOutboundRows([
      {
        name: 'Outbound Feb 2026',
        cells: [monthlyHeader(), loadRow({ id: 'M-1', ship: E, steel: 6561, waste: 1539 })],
      },
    ]);
    const commodities = result.loads[0]?.commodities ?? [];
    // Steel 6561, Waste 1539, Whole Mattresses 0 — three rows. The ten stems
    // whose columns this sheet does not have contribute nothing.
    expect(commodities.map((c) => [c.commodity, c.weightLbs])).toEqual([
      ['Steel', 6561],
      ['Waste', 1539],
      ['Whole Mattresses and Foundations', 0],
    ]);
    expect(commodities.find((c) => c.commodity === 'Steel')?.disposition).toBe('Recycling');
    expect(result.totals.commodityRows).toBe(3);
  });

  it('names all thirteen commodity stems the live workbook uses', () => {
    expect(COMMODITY_STEMS).toHaveLength(13);
    expect(COMMODITY_STEMS).toContain('Whole Mattresses and Foundations');
    expect(COMMODITY_STEMS).toContain('Shoddy/Felt');
  });
});

describe('shipment dates arrive three ways', () => {
  it('converts the Excel serial the duplicate sheets use', () => {
    // 46055 is the serial `Feb2026 outbounds` stores for the shipment that
    // `Outbound Feb 2026` stores as a real Date of 2026-02-02.
    expect(excelSerialToISO(46055)).toBe('2026-02-02');
    expect(excelSerialToISO(46143)).toBe('2026-05-01');
  });

  it('refuses a serial inside the 1900 leap-year artefact rather than shifting it', () => {
    expect(excelSerialToISO(60)).toBeNull();
    expect(excelSerialToISO(1)).toBeNull();
    expect(excelSerialToISO(Number.NaN)).toBeNull();
  });

  it('parses the month-first text the January sheet uses', () => {
    expect(usDateTextToISO('1/2/2026')).toBe('2026-01-02');
    // 19 cannot be a month — this is what proves the order is M/D and not D/M.
    expect(usDateTextToISO('1/19/2026')).toBe('2026-01-19');
  });

  it('returns null rather than rolling an impossible date forward', () => {
    // Date.UTC(2026, 1, 31) silently becomes 2026-03-03.
    expect(usDateTextToISO('2/31/2026')).toBeNull();
    expect(usDateTextToISO('13/1/2026')).toBeNull();
    expect(usDateTextToISO('not a date')).toBeNull();
  });

  it('always keeps the raw cell text, whichever shape it arrived in', () => {
    const result = extractOutboundRows([
      {
        name: 'mixed',
        cells: [
          monthlyHeader(),
          loadRow({ id: 'M-1', ship: d('2026-02-02'), steel: 1 }),
          loadRow({ id: 'M-2', ship: n(46055), steel: 1 }),
          loadRow({ id: 'M-3', ship: s('1/2/2026'), steel: 1 }),
          loadRow({ id: 'M-4', ship: s('sometime in June'), steel: 1 }),
        ],
      },
    ]);
    expect(result.loads.map((l) => [l.shipmentDateRaw, l.shipmentDateISO])).toEqual([
      ['2026-02-02', '2026-02-02'],
      ['46055', '2026-02-02'],
      ['1/2/2026', '2026-01-02'],
      // Unreadable: the ISO is null and the operator's words survive intact.
      ['sometime in June', null],
    ]);
  });
});
