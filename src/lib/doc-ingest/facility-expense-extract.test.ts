// ADR-0104 §D4 — facility expense-log extraction.
//
// Fixtures mirror the REAL "Woodland Invoices tracking.xlsx" read out of R2 on
// 2026-08-16: a two-row title banner, a header on row 3, an unbannered opening
// block, then repeating (month banner -> repeated header -> rows -> subtotal)
// blocks, and a `Yearly Total` row at the foot.
//
// The headline finding this file encodes: the `Invoice Date` column holds
// DAY-OF-MONTH NUMBERS, not dates. Zero of the 332 absorbed rows carry a cell a
// date could be read from.

import { describe, expect, it } from 'vitest';
import {
  extractFacilityExpenseRows,
  sheetSiteToken,
  sheetYearOf,
  type FacilityExpenseSiteScope,
} from './facility-expense-extract';
import type { Cell } from './trailer-extract';

const E: Cell = { text: '', num: null, date: null };
const s = (text: string): Cell => ({ text, num: null, date: null });
const n = (v: number): Cell => ({ text: String(v), num: v, date: null });
const d = (iso: string): Cell => ({ text: iso, num: null, date: iso });

const SCOPE: FacilityExpenseSiteScope = {
  registeredTokens: ['eugene', 'woodland'],
  documentTokens: ['dr3 woodland', 'woodland'],
};

/** The live row-3 header, verbatim (note the lower-case `category` and `day`). */
const HEADER: Cell[] = [
  s('Present on Daily Log'),
  s('desk receipt'),
  E,
  s('Invoice Date'),
  s('Amt.'),
  s('credit amt'),
  s('category'),
  s('Invoice #'),
  s('Notes'),
  s('Machine ID'),
  s('day'),
  s('commodity'),
  E,
  s('gallons'),
];
const TITLE: Cell[] = [s('WOODLAND EXPENSES'), E, E, E];
const BLANK: Cell[] = [E, E, E, E];

interface RowSpec {
  day?: number | Cell;
  amt?: number;
  credit?: number;
  category?: string;
  invoiceNo?: string;
  notes?: string;
  machine?: string;
  commodity?: string;
  gallons?: number;
}

function expenseRow(spec: RowSpec): Cell[] {
  const dayCell =
    spec.day === undefined ? E : typeof spec.day === 'number' ? n(spec.day) : spec.day;
  return [
    E,
    E,
    E,
    dayCell,
    spec.amt === undefined ? E : n(spec.amt),
    spec.credit === undefined ? E : n(spec.credit),
    spec.category === undefined ? E : s(spec.category),
    spec.invoiceNo === undefined ? E : s(spec.invoiceNo),
    spec.notes === undefined ? E : s(spec.notes),
    spec.machine === undefined ? E : s(spec.machine),
    E,
    spec.commodity === undefined ? E : s(spec.commodity),
    E,
    spec.gallons === undefined ? E : n(spec.gallons),
  ];
}

/** A month banner: a row whose ONLY content is the month name. */
function banner(month: string): Cell[] {
  return [E, E, s(month), E, E, E, E, E, E, E, E, E];
}
const SUBTOTAL: Cell[] = [E, E, E, E, s('Monthly Total Expenses'), s('Monthly Total Credit')];
const YEAR_TOTAL: Cell[] = [E, E, E, E, s('Yearly Total Expenses'), s('Yearly Total Credit')];

describe('extractFacilityExpenseRows — the real sheet shape', () => {
  const sheet = [
    TITLE,
    BLANK,
    HEADER,
    expenseRow({ day: 5, amt: 900, category: 'Transportation', invoiceNo: '743833' }),
    expenseRow({ day: 6, amt: 1.32, category: 'Machinery Repair/Maintenance' }),
    SUBTOTAL,
    banner('February'),
    HEADER,
    expenseRow({ day: 12, amt: 248.02, category: 'transportation', commodity: 'H-130100' }),
    expenseRow({ day: 14, amt: 416.88, category: 'Diesel', gallons: 120.5 }),
    SUBTOTAL,
    YEAR_TOTAL,
  ];

  it('reads the expense rows and skips the sheet’s own scaffolding', () => {
    const r = extractFacilityExpenseRows('WOODLAND 2026', sheet, SCOPE);

    expect(r.failure).toBeNull();
    expect(r.headerRowIndex).toBe(3);
    expect(r.sheetYear).toBe(2026);
    expect(r.rows).toHaveLength(4);
    // Every skipped row is COUNTED, not silently dropped — a partial read must
    // not look identical to a complete one.
    expect(r.bannerRows).toBe(1);
    // The `Yearly Total` row counts here too. Absorbing it would have added the
    // year's arithmetic on top of the year.
    expect(r.subtotalRows).toBe(3);
    expect(r.repeatedHeaderRows).toBe(1);
    expect(r.totals.amount).toBeCloseTo(1566.22, 2);
  });

  it('FALSIFIES the subtotal guard: counting the total rows double-counts the sheet', () => {
    // Without the `(monthly|yearly) total` skip these three label rows would be
    // read as expense rows — they carry text in the Amt. column, which is
    // exactly what makes them look like data.
    const naive = sheet.filter((row) => !row.some((c) => /^(monthly|yearly)\s+total/i.test(c.text)));
    const withGuard = extractFacilityExpenseRows('WOODLAND 2026', sheet, SCOPE);
    const withoutTotals = extractFacilityExpenseRows('WOODLAND 2026', naive, SCOPE);

    expect(withGuard.rows).toHaveLength(withoutTotals.rows.length);
    expect(withGuard.subtotalRows).toBe(3);
    expect(withoutTotals.subtotalRows).toBe(0);
  });

  it('forward-fills the month banner and leaves the opening block unstated', () => {
    const r = extractFacilityExpenseRows('WOODLAND 2026', sheet, SCOPE);
    expect(r.rows.map((x) => x.invoiceMonthLabel)).toEqual([
      // The first block has NO banner. "January" would be an inference from
      // position, and 25 of WOODLAND 2026's 138 real rows sit here.
      null,
      null,
      'February',
      'February',
    ]);
  });

  it('recognises a banner written into the Invoice Date column', () => {
    // WOODLAND 2025 row 205 does exactly this. Searching the whole row rather
    // than one fixed cell is why it is a banner and not an expense with the
    // invoice date "November".
    const odd = [TITLE, BLANK, HEADER, expenseRow({ day: s('November') }), expenseRow({ day: 3, amt: 10 })];
    const r = extractFacilityExpenseRows('WOODLAND 2025', odd, SCOPE);
    expect(r.bannerRows).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.invoiceMonthLabel).toBe('November');
  });

  it('skips a repeated header even when its category cell is blank', () => {
    // STOCKTON 2025 has one such row. A single-column `category === 'category'`
    // test — which is what the plan specified — lets it through as data.
    const headerNoCategory = [...HEADER];
    headerNoCategory[6] = E;
    const r = extractFacilityExpenseRows(
      'WOODLAND 2026',
      [TITLE, BLANK, HEADER, headerNoCategory, expenseRow({ day: 3, amt: 10 })],
      SCOPE,
    );
    expect(r.repeatedHeaderRows).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.invoiceDateRaw).toBe('3');
  });
});

describe('the Invoice Date column does not hold dates', () => {
  it('records the day number and leaves the date NULL', () => {
    const r = extractFacilityExpenseRows(
      'WOODLAND 2026',
      [HEADER, expenseRow({ day: 27, amt: 100, category: 'Supplies' })],
      SCOPE,
    );
    const row = r.rows[0];
    expect(row?.invoiceDateISO).toBeNull();
    expect(row?.invoiceDay).toBe(27);
    // ALWAYS what the cell said.
    expect(row?.invoiceDateRaw).toBe('27');
  });

  it('uses the cell’s own date when the sheet did write one', () => {
    const r = extractFacilityExpenseRows(
      'WOODLAND 2026',
      [HEADER, expenseRow({ day: d('2026-01-05'), amt: 100 })],
      SCOPE,
    );
    expect(r.rows[0]?.invoiceDateISO).toBe('2026-01-05');
    expect(r.rows[0]?.invoiceDay).toBeNull();
  });

  it('refuses a number that cannot be a day of the month', () => {
    const r = extractFacilityExpenseRows(
      'WOODLAND 2026',
      [HEADER, expenseRow({ day: 46055, amt: 100 })],
      SCOPE,
    );
    // 46055 is an Excel serial, not a day. Silently converting it here would
    // put a date on a row whose column never carries one.
    expect(r.rows[0]?.invoiceDay).toBeNull();
    expect(r.rows[0]?.invoiceDateISO).toBeNull();
    expect(r.rows[0]?.invoiceDateRaw).toBe('46055');
  });
});

describe('blank is NOT RECORDED, never zero', () => {
  it('keeps a missing amount and a missing credit as null', () => {
    const r = extractFacilityExpenseRows(
      'WOODLAND 2026',
      [HEADER, expenseRow({ day: 3, category: 'Supplies' })],
      SCOPE,
    );
    // An expense with no recorded amount is not a free expense — the same rule
    // ADR-0069 Am.2 wrote for `actual_repair_cost`. 34 of WOODLAND 2026's rows
    // are in exactly this state.
    expect(r.rows[0]?.amount).toBeNull();
    expect(r.rows[0]?.creditAmount).toBeNull();
    expect(r.totals.amount).toBe(0);
  });

  it('keeps the category verbatim AND a lower-cased copy for grouping', () => {
    const r = extractFacilityExpenseRows(
      'WOODLAND 2026',
      [
        HEADER,
        expenseRow({ day: 1, amt: 1, category: 'Transportation' }),
        expenseRow({ day: 2, amt: 1, category: 'transportation' }),
      ],
      SCOPE,
    );
    // The live sheets hold both spellings. Normalising the stored value would
    // invent a taxonomy nobody has agreed; keeping only the raw would make them
    // ungroupable. Both.
    expect(r.rows.map((x) => x.categoryRaw)).toEqual(['Transportation', 'transportation']);
    expect(r.rows.map((x) => x.categoryNorm)).toEqual(['transportation', 'transportation']);
  });

  it('sets haul_ref only for the H-number shape', () => {
    const r = extractFacilityExpenseRows(
      'WOODLAND 2026',
      [
        HEADER,
        expenseRow({ day: 1, amt: 1, commodity: 'H-130100' }),
        expenseRow({ day: 2, amt: 1, commodity: 'pocket coils' }),
      ],
      SCOPE,
    );
    // The column is overloaded: 6 of WOODLAND 2026's rows are haul references
    // and the rest are real commodities. Both are stored verbatim; only the
    // first becomes a reference.
    expect(r.rows.map((x) => [x.commodityRaw, x.haulRef])).toEqual([
      ['H-130100', 'H-130100'],
      ['pocket coils', null],
    ]);
  });
});

describe('the site gate (hard rule #2)', () => {
  it('REFUSES a Stockton sheet by name, with the reason', () => {
    const r = extractFacilityExpenseRows(
      'STOCKTON 2026',
      [TITLE, BLANK, HEADER, expenseRow({ day: 5, amt: 5000, category: 'Commodity' })],
      SCOPE,
    );
    // The sheet is perfectly readable. It is refused because Stockton is not a
    // row in `sites`, so absorbing it would attribute $5,000 of somebody else's
    // expenses to Woodland.
    expect(r.failure?.kind).toBe('site_not_registered');
    expect(r.rows).toHaveLength(0);
    expect(r.totals.amount).toBe(0);
  });

  it('FALSIFIES the site gate: the same sheet absorbs once Stockton is registered', () => {
    const r = extractFacilityExpenseRows(
      'STOCKTON 2026',
      [TITLE, BLANK, HEADER, expenseRow({ day: 5, amt: 5000, category: 'Commodity' })],
      { registeredTokens: ['woodland', 'stockton'], documentTokens: ['stockton'] },
    );
    // Proves the refusal is the SITE REGISTRY talking and not a parse failure
    // wearing a site's name — the rows were always readable.
    expect(r.failure).toBeNull();
    expect(r.rows).toHaveLength(1);
    expect(r.totals.amount).toBe(5000);
  });

  it('refuses a registered site that is not this document’s', () => {
    const r = extractFacilityExpenseRows('EUGENE 2026', [HEADER, expenseRow({ day: 5, amt: 1 })], SCOPE);
    expect(r.failure?.kind).toBe('site_not_this_document');
  });

  it('refuses a sheet with no Invoice Date column', () => {
    const r = extractFacilityExpenseRows('Sheet1', [[s('notes'), s('misc')], [s('x')]], SCOPE);
    expect(r.failure?.kind).toBe('no_header_row');
  });

  it('reports no_rows rather than an empty success', () => {
    const r = extractFacilityExpenseRows('WOODLAND 2026', [HEADER, SUBTOTAL], SCOPE);
    expect(r.failure?.kind).toBe('no_rows');
    expect(r.failure?.message).toContain('1 subtotal row');
  });
});

describe('sheet-name readings', () => {
  it('reads the banner year off the name', () => {
    expect(sheetYearOf('WOODLAND 2026')).toBe(2026);
    expect(sheetYearOf('Sheet1')).toBeNull();
  });

  it('reads the place word off the name, without hardcoding the four sheets', () => {
    expect(sheetSiteToken('WOODLAND 2026')).toBe('woodland');
    expect(sheetSiteToken('STOCKTON 2025')).toBe('stockton');
    // No trailing year -> no claim about a site, so the sheet is judged on its
    // headers alone rather than refused for a name it never made.
    expect(sheetSiteToken('Sheet1')).toBeNull();
  });
});
