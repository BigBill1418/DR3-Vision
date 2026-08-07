// ADR-0069 Am.3 — commodity audit-coverage extraction.
//
// ── Why these fixtures were rebuilt ────────────────────────────────────────
// The first cut modelled ONE header block per sheet with all streams side by
// side. The fixture agreed with the code, 22 tests went green, and the extractor
// produced silently wrong data against the real workbook: five streams missing,
// their months re-attributed to other streams, and 60 duplicate (stream, month)
// pairs that the destination UNIQUE index would have rejected with P2002 in
// production. The row TOTAL was right both times, which is exactly why it was
// invisible. That is a fixture measuring the code instead of the document.
//
// So these fixtures now mirror the REAL stacked geometry, verified against the
// live bytes:
//
//   Commodity Audit 2026 — 60 rows, 57 cols, 12 streams
//     header  4 → audited cols 3,11,19,27,35,43,51   months rows 5-16
//     header 18 → audited cols 3,11                  months rows 19-30
//     header 20 → audited col  43                    months rows 21-32
//     header 32 → audited col  11                    months rows 33-44
//     header 47 → audited col  11                    months rows 48-59
//   Commodity Audit 2025 — 45 rows, 51 cols, 9 streams
//     header  4 → audited cols 3,11,19,27,35,43      months rows 5-16
//     header 18 → audited cols 3,11                  months rows 19-30
//     header 32 → audited col  11                    months rows 33-44
//
// Note the row-18 / row-20 STAGGER: the row-20 sub-table starts two rows below
// the row-18 one and lives in entirely different columns, so the two overlap
// vertically without touching. A single global row range per sub-table cannot
// express that, which is why the data bound is per column group.
//
// Note also that only ONE free row (17) separates the top block's last month row
// from the row-18 header — so sub-tables carry a single banner row, not the top
// block's two, and a fixed h-2/h-1 offset would name a stream "Dec".
//
// Every guard here was FALSIFIED before it was kept — the extractor was broken
// in the exact way the guard describes, the test was watched go red, and the red
// was checked to NAME THE REAL WRONG VALUE. A guard whose red says `undefined`
// or `[]` is measuring the fixture, not the extractor.

import { describe, expect, it } from 'vitest';
import {
  extractCommodityAuditRows,
  type CommodityAuditRow,
  type CommodityExtractResult,
  type CommodityStreamBlock,
} from './commodity-extract';
import type { Cell } from './trailer-extract';

const E: Cell = { text: '', num: null, date: null };
const s = (text: string): Cell => ({ text, num: null, date: null });
const d = (iso: string): Cell => ({ text: iso, num: null, date: iso });
/** An Excel error cell — row 1 of a live sheet carries one. */
const ERR: Cell = { text: '#REF!', num: null, date: null };
/** A tick in an Audited cell. */
const TICK = s('X');

/** Verbatim from the live sheet, double space and all. */
const TITLE_BANNER = 'Commodity Audit (against Vendor Invoices)  WOODLAND';

/**
 * Verbatim month labels. The abbreviation is genuinely inconsistent and is NOT
 * tidied — March/April/June/July are spelled out and "Sept" is four letters.
 */
const MONTHS = [
  'Jan',
  'Feb',
  'March',
  'April',
  'May',
  'June',
  'July',
  'Aug',
  'Sept',
  'Oct',
  'Nov',
  'Dec',
] as const;
type Month = (typeof MONTHS)[number];

interface Audit {
  audited?: Cell;
  initials?: Cell;
  date?: Cell;
  second?: Cell;
  secondInitials?: Cell;
  secondDate?: Cell;
}

/** One sub-table: its own header row, its own columns, its own streams. */
interface SubTable {
  /** 1-based row carrying Audited | Initials | Date … */
  headerRow: number;
  /** 1-based row carrying the stream labels for this sub-table. */
  labelRow: number;
  /** 1-based row carrying the group banners, when this sub-table has one. */
  groupRow?: number;
  /** 1-based row of this sub-table's Jan. */
  firstMonthRow: number;
  /** 1-based Audited column per stream, with that stream's label/group/data. */
  streams: {
    auditedCol: number;
    label: string;
    group?: string;
    months?: Partial<Record<Month, Audit>>;
  }[];
}

/** Write a cell at 1-based (row, col), padding the ragged grid as needed. */
function put(grid: Cell[][], row: number, col: number, cell: Cell): void {
  const r = (grid[row - 1] ??= []);
  while (r.length < col - 1) r.push(E);
  r[col - 1] = cell;
}

/**
 * Build a sheet from its sub-tables.
 *
 * Banners are written ONLY in each stream's month column — that is where the
 * value of a merged cell lives — so reading a banner at the Audited column
 * requires searching left. Every other column of the block is empty.
 */
function buildSheet(year: string, rowCount: number, subs: SubTable[]): Cell[][] {
  const grid: Cell[][] = Array.from({ length: rowCount }, () => [] as Cell[]);
  put(grid, 1, 1, s(year));
  put(grid, 1, 2, s(TITLE_BANNER));
  put(grid, 1, 3, ERR);

  for (const sub of subs) {
    for (const st of sub.streams) {
      const monthCol = st.auditedCol - 1; // blank-headered column left of Audited
      put(grid, sub.labelRow, monthCol, s(st.label));
      if (sub.groupRow !== undefined && st.group !== undefined) {
        put(grid, sub.groupRow, monthCol, s(st.group));
      }
      put(grid, sub.headerRow, st.auditedCol, s('Audited'));
      put(grid, sub.headerRow, st.auditedCol + 1, s('Initials'));
      put(grid, sub.headerRow, st.auditedCol + 2, s('Date'));
      put(grid, sub.headerRow, st.auditedCol + 3, s('2nd Audit'));
      put(grid, sub.headerRow, st.auditedCol + 4, s('Initials'));
      put(grid, sub.headerRow, st.auditedCol + 5, s('Date'));

      MONTHS.forEach((m, j) => {
        const row = sub.firstMonthRow + j;
        const a = (st.months ?? {})[m] ?? {};
        put(grid, row, monthCol, s(m));
        if (a.audited) put(grid, row, st.auditedCol, a.audited);
        if (a.initials) put(grid, row, st.auditedCol + 1, a.initials);
        if (a.date) put(grid, row, st.auditedCol + 2, a.date);
        if (a.second) put(grid, row, st.auditedCol + 3, a.second);
        if (a.secondInitials) put(grid, row, st.auditedCol + 4, a.secondInitials);
        if (a.secondDate) put(grid, row, st.auditedCol + 5, a.secondDate);
      });
    }
  }
  return grid;
}

/** Every month audited, no date written down — the live 2025 METAL shape. */
const ALL_AUDITED_NO_DATE = Object.fromEntries(
  MONTHS.map((m) => [m, { audited: TICK, initials: s('KR') }]),
) as Partial<Record<Month, Audit>>;

const SHEET_2026 = buildSheet('2026', 60, [
  {
    headerRow: 4,
    labelRow: 3,
    groupRow: 2,
    firstMonthRow: 5,
    streams: [
      {
        auditedCol: 3,
        group: 'METAL',
        label: 'METAL - GreenZone',
        months: {
          Jan: { audited: TICK, initials: s('KR'), date: d('2026-03-10') },
          Feb: { audited: TICK, initials: s('KR'), date: d('2026-04-15') },
          // Three live rows say the literal word "working" in the Date column.
          March: { audited: TICK, initials: s('KR'), date: s('working') },
          April: { audited: TICK, initials: s('KR'), date: s('working') },
          May: { audited: TICK, initials: s('KR'), date: s('working') },
        },
      },
      {
        auditedCol: 11,
        group: 'WOOD',
        label: 'WOOD- Biomass', // no space after WOOD — verbatim
        months: {
          Jan: {
            audited: TICK,
            initials: s('BJ'),
            date: d('2026-02-11'),
            second: TICK,
            secondInitials: s('KR'),
            secondDate: d('2026-02-20'),
          },
        },
      },
      {
        auditedCol: 19,
        group: 'TOPPERS',
        label: 'TOPPERS - All Vendors',
        months: { Sept: { audited: TICK, initials: s('KR'), date: d('2026-10-02') } },
      },
      { auditedCol: 27, group: 'FOAM', label: 'FOAM - All Vendors' },
      { auditedCol: 35, group: 'TRASH', label: 'TRASH - Yolo (Including wood waste)' },
      { auditedCol: 43, group: 'XTRACTION', label: 'XTRACTION' },
      {
        auditedCol: 51,
        group: 'DAILY LOG/MYMRC/SPREADSHEETS',
        label: 'DAILY LOG/MYMRC/SPREADSHEETS',
      },
    ],
  },
  {
    // Only row 17 is free between the top block's Dec (row 16) and this header,
    // so this sub-table carries a label row and NO group row.
    headerRow: 18,
    labelRow: 17,
    firstMonthRow: 19,
    streams: [
      {
        auditedCol: 3,
        label: 'METAL - SA',
        months: { Jan: { audited: TICK, initials: s('KR'), date: d('2026-02-17') } },
      },
      { auditedCol: 11, label: 'WOOD- Sierra' },
    ],
  },
  {
    // THE STAGGER: two rows below the row-18 sub-table, in different columns.
    // Its label row (19) is simultaneously the row-18 sub-table's Jan row.
    headerRow: 20,
    labelRow: 19,
    firstMonthRow: 21,
    streams: [{ auditedCol: 43, label: 'PLASTIC, CARDBOARD, SHODDY' }],
  },
  {
    headerRow: 32,
    labelRow: 31,
    firstMonthRow: 33,
    streams: [{ auditedCol: 11, label: 'WOOD- Yolo' }],
  },
  {
    headerRow: 47,
    labelRow: 46,
    firstMonthRow: 48,
    streams: [
      {
        auditedCol: 11,
        label: 'WOOD- Renovation',
        months: { Feb: { audited: TICK, initials: s('KR') } },
      },
    ],
  },
]);
// The live marker cell: row 31, column 2 — inside the row-18 METAL sub-table's
// month column, and not a month.
put(SHEET_2026, 31, 2, s('* no entries'));

const SHEET_2025 = buildSheet('2025', 45, [
  {
    headerRow: 4,
    labelRow: 3,
    groupRow: 2,
    firstMonthRow: 5,
    streams: [
      {
        auditedCol: 3,
        group: 'METAL',
        label: 'METAL - GreenZone',
        months: ALL_AUDITED_NO_DATE,
      },
      {
        auditedCol: 11,
        group: 'WOOD',
        label: 'WOOD- Biomass',
        months: { Aug: { audited: TICK, initials: s('NONE') } },
      },
      { auditedCol: 19, group: 'TOPPERS', label: 'TOPPERS - All Vendors' },
      { auditedCol: 27, group: 'FOAM', label: 'FOAM - All Vendors' },
      {
        auditedCol: 35,
        group: 'TRASH',
        label: 'TRASH - Yolo (Including wood waste)',
        // The apparent typo: a Dec row dated in JANUARY 2025, near-certainly
        // meant as 2026-01-07. Recorded verbatim.
        months: { Dec: { audited: TICK, initials: s('KR'), date: d('2025-01-07') } },
      },
      { auditedCol: 43, group: 'XTRACTION', label: 'XTRACTION' },
    ],
  },
  {
    headerRow: 18,
    labelRow: 17,
    firstMonthRow: 19,
    streams: [
      { auditedCol: 3, label: 'METAL - SA' },
      { auditedCol: 11, label: 'WOOD- Sierra' },
    ],
  },
  {
    headerRow: 32,
    labelRow: 31,
    firstMonthRow: 33,
    streams: [{ auditedCol: 11, label: 'WOOD- Yolo' }],
  },
]);

const LABELS_2026 = [
  'METAL - GreenZone',
  'WOOD- Biomass',
  'TOPPERS - All Vendors',
  'FOAM - All Vendors',
  'TRASH - Yolo (Including wood waste)',
  'XTRACTION',
  'DAILY LOG/MYMRC/SPREADSHEETS',
  'METAL - SA',
  'WOOD- Sierra',
  'PLASTIC, CARDBOARD, SHODDY',
  'WOOD- Yolo',
  'WOOD- Renovation',
];

const LABELS_2025 = [
  'METAL - GreenZone',
  'WOOD- Biomass',
  'TOPPERS - All Vendors',
  'FOAM - All Vendors',
  'TRASH - Yolo (Including wood waste)',
  'XTRACTION',
  'METAL - SA',
  'WOOD- Sierra',
  'WOOD- Yolo',
];

/**
 * Duplicate (stream, month) pairs computed from the ROWS THEMSELVES.
 *
 * Deliberately NOT read from `res.duplicateStreamMonths`. Asserting on the
 * extractor's own self-report would let a single broken function report zero and
 * keep the guard green — the "falsification measured the mock" failure. This
 * measures the output the database will actually receive.
 */
function duplicatePairs(res: CommodityExtractResult): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const r of res.rows) {
    const key = `${r.streamLabel}::${r.monthLabel}`;
    if (seen.has(key)) dupes.push(key);
    else seen.add(key);
  }
  return dupes;
}

function stream(res: CommodityExtractResult, i: number): CommodityStreamBlock {
  const hit = res.streams[i];
  if (hit) return hit;
  throw new Error(
    `no stream block at index ${i}. Blocks actually detected: ` +
      `${res.streams.map((b) => JSON.stringify(b.label)).join(', ') || '(none — zero blocks)'}. ` +
      `headerRowIndexes=${JSON.stringify(res.headerRowIndexes)} failure=${JSON.stringify(res.failure)}`,
  );
}

/**
 * Select one row, naming what IS present when the selection misses.
 *
 * Without this, a block-detection regression makes `find()` return undefined and
 * the assertion faults on a property of undefined — a red that names nothing.
 */
function row(res: CommodityExtractResult, label: string, month: string): CommodityAuditRow {
  const hit = res.rows.find((r) => r.streamLabel === label && r.monthLabel === month);
  if (hit) return hit;
  const labels = [...new Set(res.rows.map((r) => r.streamLabel))].map((l) => JSON.stringify(l));
  const months = [...new Set(res.rows.map((r) => r.monthLabel))].map((m) => JSON.stringify(m));
  throw new Error(
    `no row for stream ${JSON.stringify(label)} month ${JSON.stringify(month)}. ` +
      `Stream labels actually emitted: ${labels.join(', ') || '(none — zero rows)'}. ` +
      `Month labels actually emitted: ${months.join(', ') || '(none — zero rows)'}. ` +
      `failure=${JSON.stringify(res.failure)}`,
  );
}

describe('extractCommodityAuditRows — stacked sub-tables', () => {
  it('finds EVERY header row, not just the first', () => {
    // FALSIFIED by returning only the first match from findHeaderRows. Red:
    // `expected [ 4 ] to deeply equal [ 4, 18, 20, 32, 47 ]` — the missing
    // sub-tables are named by row number.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    expect(res.headerRowIndexes).toEqual([4, 18, 20, 32, 47]);
    expect(extractCommodityAuditRows('Commodity Audit 2025', SHEET_2025).headerRowIndexes).toEqual([
      4, 18, 32,
    ]);
  });

  it('emits ZERO duplicate (stream, month) pairs — the P2002 guard', () => {
    // THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT.
    // FALSIFIED by restoring single-header-block behaviour (scan every row below
    // the first header row using the top block's columns). Red named the count
    // AND the offenders:
    //   expected { count: 60, examples: [ 'METAL - GreenZone::Jan',
    //     'METAL - GreenZone::Feb', 'METAL - GreenZone::March' ] }
    //     to deeply equal { count: 0, examples: [] }
    // The destination table has a UNIQUE index on
    // (version, sheet_name, stream_label, month_label): duplicates are not a
    // cosmetic problem, they abort the whole absorption with P2002.
    for (const [name, sheet] of [
      ['Commodity Audit 2026', SHEET_2026],
      ['Commodity Audit 2025', SHEET_2025],
    ] as const) {
      const res = extractCommodityAuditRows(name, sheet);
      const dupes = duplicatePairs(res);
      expect({ sheet: name, count: dupes.length, examples: dupes.slice(0, 3) }).toEqual({
        sheet: name,
        count: 0,
        examples: [],
      });
    }
  });

  it('lists ALL 12 streams for 2026 and ALL 9 for 2025, by label', () => {
    // FALSIFIED by dropping the sub-table loop. Red:
    //   expected [ …(7) ] to deeply equal [ …(12) ]
    // with the diff naming 'METAL - SA', 'WOOD- Sierra', 'PLASTIC, CARDBOARD,
    // SHODDY', 'WOOD- Yolo', 'WOOD- Renovation' as absent. Asserting the LABELS
    // rather than a count is what makes a missing block name itself.
    expect(
      extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026).streams.map((b) => b.label),
    ).toEqual(LABELS_2026);
    expect(
      extractCommodityAuditRows('Commodity Audit 2025', SHEET_2025).streams.map((b) => b.label),
    ).toEqual(LABELS_2025);
  });

  it('emits 12 streams × 12 months = 144 rows for 2026, 9 × 12 = 108 for 2025', () => {
    // The totals were UNCHANGED by the original defect — 144 and 108 both times.
    // That is precisely why the count alone is not a guard, and why the duplicate
    // and label assertions above carry the real weight.
    const r26 = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const r25 = extractCommodityAuditRows('Commodity Audit 2025', SHEET_2025);
    expect(r26.rows).toHaveLength(144);
    expect(r25.rows).toHaveLength(108);
    expect(new Set(r26.rows.map((r) => r.streamLabel)).size).toBe(12);
    expect(new Set(r25.rows.map((r) => r.streamLabel)).size).toBe(9);
    expect(r26.failure).toBeNull();
    expect(r25.failure).toBeNull();
  });

  it('gives every stream exactly 12 months, including the staggered sub-tables', () => {
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const perStream = LABELS_2026.map((l) => ({
      label: l,
      months: res.rows.filter((r) => r.streamLabel === l).length,
    }));
    expect(perStream).toEqual(LABELS_2026.map((l) => ({ label: l, months: 12 })));
  });

  it('bounds overlapping sub-tables per COLUMN GROUP, not by a global row range', () => {
    // The row-18 block (columns 2-8) and the row-20 block (columns 42-48) overlap
    // vertically. FALSIFIED by ending every block at the next header row
    // regardless of columns: the row-18 METAL - SA block then stops at row 20 and
    // emits 1 month instead of 12. Red:
    //   expected { 'METAL - SA': 1, … } to deeply equal { 'METAL - SA': 12, … }
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const count = (l: string): number => res.rows.filter((r) => r.streamLabel === l).length;
    expect({ sa: count('METAL - SA'), plastic: count('PLASTIC, CARDBOARD, SHODDY') }).toEqual({
      sa: 12,
      plastic: 12,
    });
    // …and their months come from their own rows: METAL - SA's Jan is sheet row
    // 19, PLASTIC's Jan is sheet row 21.
    expect(row(res, 'METAL - SA', 'Jan').rowIndex).toBe(19);
    expect(row(res, 'PLASTIC, CARDBOARD, SHODDY', 'Jan').rowIndex).toBe(21);
  });

  it("pins every block's month and audited column", () => {
    // The month column is the NEAREST blank-headered column left of "Audited";
    // the blank spacer between blocks sits further left still. FALSIFIED by
    // taking the FARTHEST blank column instead — the blocks then read the spacer
    // (or column 0) and the red names the wrong columns:
    //   expected [ 1, 9, 17, 25, 33, 41, 49, 1, 9, 41, 9, 9 ]
    //     to deeply equal [ 2, 10, 18, 26, 34, 42, 50, 2, 10, 42, 10, 10 ]
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    expect(res.streams.map((b) => b.monthCol)).toEqual([
      2, 10, 18, 26, 34, 42, 50, 2, 10, 42, 10, 10,
    ]);
    expect(res.streams.map((b) => b.auditedCol)).toEqual([
      3, 11, 19, 27, 35, 43, 51, 3, 11, 43, 11, 11,
    ]);
    expect(res.streams.map((b) => b.headerRowIndex)).toEqual([
      4, 4, 4, 4, 4, 4, 4, 18, 18, 20, 32, 47,
    ]);
  });

  it('reads a LOWER sub-table cell end to end', () => {
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const sa = row(res, 'METAL - SA', 'Jan');
    expect(sa.audited).toBe(true);
    expect(sa.initials).toBe('KR');
    expect(sa.auditDateISO).toBe('2026-02-17');
    expect(stream(res, 7).headerRowIndex).toBe(18);

    const reno = row(res, 'WOOD- Renovation', 'Feb');
    expect(reno.audited).toBe(true);
    expect(reno.initials).toBe('KR');
    expect(reno.rowIndex).toBe(49); // sub-table header 47, Jan 48, Feb 49
  });

  it('ignores the "* no entries" marker cell', () => {
    // It sits in the row-18 METAL sub-table's month column (row 31, col 2) and
    // is not a month. FALSIFIED by treating any non-empty month cell as a month:
    // METAL - SA then emits 13 rows and the duplicate guard also fires.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    expect(res.rows.map((r) => r.monthLabel)).not.toContain('* no entries');
    expect(res.rows.filter((r) => r.streamLabel === 'METAL - SA')).toHaveLength(12);
  });
});

describe('extractCommodityAuditRows — banner rows are searched for, not offset', () => {
  it('gives the top block its group AND label from rows 2 and 3', () => {
    // FALSIFIED by reading the banner at the Audited column without searching
    // left. Red: `expected '' to be 'TOPPERS - All Vendors'` — merged banners
    // live in the block's leftmost (month) column, never at Audited.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    expect(stream(res, 2).label).toBe('TOPPERS - All Vendors');
    expect(stream(res, 2).group).toBe('TOPPERS');
    // …and the search must not bleed one block's label into the next.
    expect(stream(res, 3).label).toBe('FOAM - All Vendors');
    expect(stream(res, 3).group).toBe('FOAM');
  });

  it('does NOT name a sub-table stream after the month row above it', () => {
    // The single row between the top block's Dec (16) and the row-18 header is
    // row 17. FALSIFIED by using a fixed h-2 / h-1 offset: the label came from
    // row 16, and the red was `expected 'Dec' to be 'METAL - SA'`. An empty
    // group is correct here — visibly missing beats silently inherited.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    expect(stream(res, 7).label).toBe('METAL - SA');
    expect(stream(res, 7).group).toBe('');
    expect(res.streams.map((b) => b.label)).not.toContain('Dec');
    expect(res.streams.map((b) => b.group)).not.toContain('Dec');
  });

  it('leaves a sub-table with NO banner row unlabelled rather than inheriting', () => {
    // FALSIFIED by removing the month-label stop from the upward search: the
    // scan then walks past the block above's month rows and picks up ITS label,
    // so this sub-table comes back as a second "METAL - GreenZone" — which is
    // both silently wrong and a duplicate-pair P2002 in production. Red:
    //   expected 'METAL - GreenZone' to be ''
    // An empty label is visibly missing; an inherited one is invisible.
    const noBanner = buildSheet('2026', 32, [
      {
        headerRow: 4,
        labelRow: 3,
        groupRow: 2,
        firstMonthRow: 5,
        streams: [{ auditedCol: 3, group: 'METAL', label: 'METAL - GreenZone' }],
      },
      // labelRow 17 is left blank by giving this sub-table an empty label.
      {
        headerRow: 18,
        labelRow: 17,
        firstMonthRow: 19,
        streams: [{ auditedCol: 3, label: '' }],
      },
    ]);
    const res = extractCommodityAuditRows('Commodity Audit 2026', noBanner);
    expect(res.streams.map((b) => b.label)).toEqual(['METAL - GreenZone', '']);
    expect(duplicatePairs(res)).toEqual([]);
  });

  it('reads the staggered row-20 label out of a row that is also month data', () => {
    // Row 19 carries the row-18 sub-table's Jan (col 2) AND this block's label
    // (col 42). Resolving the banner within the block's own columns is what
    // keeps 'Jan' from becoming a stream name.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    expect(stream(res, 9).label).toBe('PLASTIC, CARDBOARD, SHODDY');
    expect(stream(res, 9).headerRowIndex).toBe(20);
  });

  it('reads the year from the row-1 banner and is not confused by an error cell', () => {
    expect(extractCommodityAuditRows('x', SHEET_2026).year).toBe(2026);
    expect(extractCommodityAuditRows('x', SHEET_2025).year).toBe(2025);
    expect(extractCommodityAuditRows('x', SHEET_2026).streams.map((b) => b.label)).not.toContain(
      '#REF!',
    );
  });

  it('detects the FIRST header on row 4, not the row-1 banner', () => {
    // FALSIFIED by taking the first non-empty row (parse.ts's rule).
    // Red: `expected 1 to be 4`.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    expect(res.headerRowIndex).toBe(4);
    const labels = res.streams.map((b) => b.label);
    expect(labels).not.toContain('2026');
    expect(labels).not.toContain(TITLE_BANNER);
    expect(stream(res, 0).label).toBe('METAL - GreenZone');
  });
});

describe('extractCommodityAuditRows — "working" is not a date', () => {
  it('keeps "working" as raw text and refuses to make a date of it', () => {
    // FALSIFIED by falling back to the month's first day when the cell held no
    // real date. Red: `expected '2026-03-01' to be null` — the bogus date is
    // named. Three live 2026 METAL rows say exactly this; a date here would
    // assert an audit finished that has not.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const r = row(res, 'METAL - GreenZone', 'March');
    expect(r.auditDateISO).toBeNull();
    expect(r.auditDateRaw).toBe('working');
    expect(r.audited).toBe(true);
    expect(r.initials).toBe('KR');
  });

  it('records an out-of-range date as raw only, never as ISO', () => {
    const sheet = buildSheet('2026', 20, [
      {
        headerRow: 4,
        labelRow: 3,
        groupRow: 2,
        firstMonthRow: 5,
        streams: [
          {
            auditedCol: 3,
            group: 'METAL',
            label: 'METAL - GreenZone',
            months: { Jan: { audited: TICK, date: d('1900-01-14') } },
          },
        ],
      },
    ]);
    const r = row(extractCommodityAuditRows('x', sheet), 'METAL - GreenZone', 'Jan');
    expect(r.auditDateISO).toBeNull();
    expect(r.auditDateRaw).toBe('1900-01-14');
  });

  it('records the 2025 Dec typo VERBATIM rather than correcting it', () => {
    const res = extractCommodityAuditRows('Commodity Audit 2025', SHEET_2025);
    const r = row(res, 'TRASH - Yolo (Including wood waste)', 'Dec');
    expect(r.auditDateISO).toBe('2025-01-07');
    expect(r.auditDateRaw).toBe('2025-01-07');
  });
});

describe('extractCommodityAuditRows — NOT RECORDED is not NO', () => {
  it('leaves an empty Audited cell NULL, never false', () => {
    // FALSIFIED by writing `Boolean(text)`. Red: `expected false to be null` —
    // names the wrong value AND the exact confusion. This is the load-bearing
    // rule of the whole document: a coverage report exists to find the months
    // NOBODY LOOKED AT. If "not recorded" collapsed into false, "we checked and
    // it failed" and "nobody looked" would be the same row.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const r = row(res, 'FOAM - All Vendors', 'July');
    expect(r.audited).toBeNull();
    expect(r.audited).not.toBe(false);
    expect(r.secondAudit).toBeNull();
    expect(r.initials).toBeNull();
  });

  it('distinguishes "no date written down" from "no date column"', () => {
    // All twelve 2025 METAL rows are audited with no date. Raw must be '' — the
    // cell existed and was blank — while ISO is null. A null raw would mean
    // something different: that the sheet had no date column at all.
    const res = extractCommodityAuditRows('Commodity Audit 2025', SHEET_2025);
    const r = row(res, 'METAL - GreenZone', 'June');
    expect(r.audited).toBe(true);
    expect(r.auditDateISO).toBeNull();
    expect(r.auditDateRaw).toBe('');
  });

  it('keeps the literal initials "NONE" instead of nulling it', () => {
    const res = extractCommodityAuditRows('Commodity Audit 2025', SHEET_2025);
    expect(row(res, 'WOOD- Biomass', 'Aug').initials).toBe('NONE');
  });

  it('resolves the SECOND audit columns separately from the first', () => {
    // The two "Initials" and two "Date" headers per block are identical strings.
    // FALSIFIED by resolving them globally with first-match-wins (the trailer
    // extractor's rule, correct there, wrong here). Red:
    // `expected 'KR' to be 'NONE'` — one block's initials leaking into another.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const r = row(res, 'WOOD- Biomass', 'Jan');
    expect(r.initials).toBe('BJ');
    expect(r.auditDateISO).toBe('2026-02-11');
    expect(r.secondAudit).toBe(true);
    expect(r.secondInitials).toBe('KR');
    expect(r.secondAuditDateISO).toBe('2026-02-20');
  });
});

describe('extractCommodityAuditRows — month labels stay verbatim', () => {
  it('keeps "Sept" as "Sept" and "March" as "March"', () => {
    // FALSIFIED by normalising to a 3-letter form. Red:
    // `expected 'Sep' to be 'Sept'`. The sheet's abbreviation is inconsistent
    // and it is not this extractor's to tidy.
    const res = extractCommodityAuditRows('Commodity Audit 2026', SHEET_2026);
    const labels = res.rows
      .filter((r) => r.streamLabel === 'METAL - GreenZone')
      .map((r) => r.monthLabel);
    expect(labels).toEqual([...MONTHS]);
    expect(row(res, 'METAL - GreenZone', 'Sept').monthNumber).toBe(9);
    expect(row(res, 'METAL - GreenZone', 'March').monthNumber).toBe(3);
  });

  it('emits a month-shaped label it cannot map, with a NULL number', () => {
    // The label is evidence even when it does not resolve to one month. Picking
    // 6 or 7 for "June/July" would be inventing which month was audited.
    const sheet: Cell[][] = [
      [s('2026'), s(TITLE_BANNER)],
      [E, s('METAL'), E, E, E, E, E, E],
      [E, s('METAL - GreenZone'), E, E, E, E, E, E],
      [E, E, s('Audited'), s('Initials'), s('Date'), s('2nd Audit'), s('Initials'), s('Date')],
      [E, s('Jan'), TICK, s('KR'), d('2026-02-01'), E, E, E],
      [E, s('June/July'), TICK, s('KR'), E, E, E, E],
      // Not month-shaped at all — a summary label, which must emit nothing.
      [E, s('Total'), TICK, s('KR'), E, E, E, E],
    ];
    const res = extractCommodityAuditRows('x', sheet);
    expect(res.rows.map((r) => r.monthLabel)).toEqual(['Jan', 'June/July']);
    expect(res.rows[1]!.monthNumber).toBeNull();
    expect(res.rows[1]!.audited).toBe(true);
  });
});

describe('extractCommodityAuditRows — it refuses rather than guessing', () => {
  it('REFUSES a sheet with no "Audited" header and emits zero rows', () => {
    const notAnAudit: Cell[][] = [
      [s('2025'), s('Woodland Trailer List 2025')],
      [E, s('Date of Entry to Yard'), s('Trailer #'), s('Material'), s('Weight (lbs)')],
      [E, d('2025-06-23'), s('533739'), s('pocket coil'), s('7110')],
    ];
    const res = extractCommodityAuditRows('Trailer List Woodland 2025', notAnAudit);
    expect(res.rows).toHaveLength(0);
    expect(res.streams).toHaveLength(0);
    expect(res.headerRowIndex).toBeNull();
    expect(res.failure?.kind).toBe('no_header_row');
    expect(res.failure?.message).toContain('Woodland Trailer List 2025');
    expect(res.failure?.message).toContain('Trailer #');
  });

  it('REFUSES an empty sheet without throwing', () => {
    expect(() => extractCommodityAuditRows('empty', [])).not.toThrow();
    const res = extractCommodityAuditRows('empty', []);
    expect(res.failure?.kind).toBe('no_header_row');
    expect(res.rows).toHaveLength(0);
    expect(res.year).toBeNull();
  });

  it('reports NO MONTH ROWS rather than a successful absorption of nothing', () => {
    const scaffoldOnly: Cell[][] = [
      [s('2026'), s(TITLE_BANNER)],
      [E, s('METAL'), E, E, E, E, E, E],
      [E, s('METAL - GreenZone'), E, E, E, E, E, E],
      [E, E, s('Audited'), s('Initials'), s('Date'), s('2nd Audit'), s('Initials'), s('Date')],
      [E, s('Total'), E, E, E, E, E, E],
    ];
    const res = extractCommodityAuditRows('Commodity Audit 2026', scaffoldOnly);
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('no_month_rows');
    expect(res.failure?.message).toContain('METAL - GreenZone');
    expect(res.headerRowIndex).toBe(4);
  });

  it('REFUSES a sheet whose blocks produced duplicate (stream, month) pairs', () => {
    // Two sub-tables carrying the SAME stream label — the shape the original
    // defect manufactured. Absorbing this hits the destination UNIQUE index and
    // fails with P2002, which names nothing. This refusal names the pairs.
    const twinned = buildSheet('2026', 32, [
      {
        headerRow: 4,
        labelRow: 3,
        groupRow: 2,
        firstMonthRow: 5,
        streams: [{ auditedCol: 3, group: 'METAL', label: 'METAL - GreenZone' }],
      },
      {
        headerRow: 18,
        labelRow: 17,
        firstMonthRow: 19,
        streams: [{ auditedCol: 3, label: 'METAL - GreenZone' }],
      },
    ]);
    const res = extractCommodityAuditRows('Commodity Audit 2026', twinned);
    expect(res.failure?.kind).toBe('duplicate_stream_months');
    expect(res.duplicateStreamMonths).toHaveLength(12);
    expect(res.failure?.message).toContain('METAL - GreenZone::Jan');
    expect(res.failure?.message).toContain('12 duplicate');
  });
});

// ────────────────────────────────────────────────────────────────
// The group banner, resolved COLUMN-WISE (verified against the archived bytes
// 2026-08-07, then pinned here).
//
// Two facts about the real 2026 sheet drive this, and they pull in opposite
// directions — which is why both are tested:
//
//   1. Row 18 is the HEADER row of the METAL - SA / WOOD- Sierra block (cols
//      3–16) and simultaneously carries the group banner "OTHER" at col 42 for
//      the PLASTIC block whose own header is at row 20. Rejecting a candidate
//      group because its ROW happens to be some other block's header row loses a
//      real group.
//   2. The METAL - SA block's label row is 17, so its group candidate is row 16 —
//      the top block's "Dec" data row. Reading `nearestLeft` there returns the
//      Audited CHECKBOX, which produced groups literally named "false"/"true".
//
// So: a data row is disqualified by this block's MONTH column holding a month,
// not by whatever happens to sit nearest the Audited column.
// ────────────────────────────────────────────────────────────────
describe('extractCommodityAuditRows — group banners are per-column, never per-row', () => {
  it('keeps a group whose banner row is ANOTHER block’s header row', () => {
    const sheet = buildSheet('2026', 40, [
      // Left block: header at row 18, so row 18 IS a header row.
      {
        labelRow: 17,
        headerRow: 18,
        firstMonthRow: 19,
        streams: [{ label: 'METAL - SA', auditedCol: 3 }],
      },
      // Right block, two rows lower, with its group banner ON row 18 at col 42.
      {
        labelRow: 19,
        groupRow: 18,
        headerRow: 20,
        firstMonthRow: 21,
        streams: [
          {
            label: 'PLASTIC, CARDBOARD, SHODDY, COTTON, FIBER, OTHER',
            group: 'OTHER',
            auditedCol: 43,
          },
        ],
      },
    ]);

    const res = extractCommodityAuditRows('Commodity Audit 2026', sheet);
    const plastic = res.streams.find((b) =>
      b.label.startsWith('PLASTIC'),
    );
    // Named explicitly so a row-wise rejection reds with `expected '' to be 'OTHER'`.
    expect(plastic?.group).toBe('OTHER');
    // …and the stream is ONE stream, not one per comma. The live sheet holds the
    // whole list in a single merged cell above a single Audited column.
    expect(res.streams.filter((b) => b.label.includes('CARDBOARD'))).toHaveLength(1);
  });

  it('never names a group from a checkbox on the data row above', () => {
    const sheet = buildSheet('2026', 40, [
      // Top block occupies rows 3..16; its Dec row is 16.
      {
        labelRow: 3,
        groupRow: 2,
        headerRow: 4,
        firstMonthRow: 5,
        streams: [
          { label: 'METAL - GreenZone', group: 'METAL', auditedCol: 3, months: ALL_AUDITED_NO_DATE },
        ],
      },
      // Sub-table directly beneath: label row 17, so its group candidate is 16 —
      // a data row of the block above, whose Audited cell holds a checkbox.
      {
        labelRow: 17,
        headerRow: 18,
        firstMonthRow: 19,
        streams: [{ label: 'METAL - SA', auditedCol: 3 }],
      },
    ]);

    const res = extractCommodityAuditRows('Commodity Audit 2026', sheet);
    const sa = res.streams.find((b) => b.label === 'METAL - SA');

    // The top block keeps its real group, so this is not "groups are off".
    expect(res.streams.find((b) => b.label === 'METAL - GreenZone')?.group).toBe('METAL');
    // The sub-table has NO group banner in the sheet, and an absent group must
    // read as absent. `'X'`/`'true'`/`'false'` here would all be inventions.
    expect(sa?.group).toBe('');
  });
});
