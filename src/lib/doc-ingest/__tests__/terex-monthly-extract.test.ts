// ADR-0081 — the monthly-tab extractor, pinned.
//
// The fixtures below are built to the SHAPE MEASURED off the live workbook
// (`TEREX.xlsx`, version `eed9d4cb`, sha256 `36308cbc…`, 490,670 bytes, read out
// of R2 inside the cluster) — an unlabeled column-A day cell, the month and year
// in the title row, units across three columns, and a `Day Total Hrs Used`
// column that is a formula whose cached result is simply absent on the days
// nobody worked. Magnitudes are production magnitudes so that a regression reads
// as a wrong NUMBER rather than as an abstract type error.

import { describe, expect, it } from 'vitest';
import type { Cell } from '../trailer-extract';
import {
  extractMonthlyRows,
  parseMonthName,
  resolveMonthlyColumns,
  type PublishedTotals,
} from '../terex-monthly-extract';

const EMPTY: Cell = { text: '', num: null, date: null };

function n(v: number): Cell {
  return { text: String(v), num: v, date: null };
}
function t(v: string): Cell {
  return { text: v, num: null, date: null };
}

/** A day as the sheet carries it. `hours: null` = the formula never cached. */
interface DayFixture {
  day: number | string;
  pc?: number;
  springs?: number;
  wood?: number;
  hours?: number | null;
}

/**
 * Build one monthly tab in the LIVE LAYOUT: row 1 title (month + year in cells
 * 4 and 5), row 2 headers starting at column B with column A DELIBERATELY BLANK,
 * then the day rows, then the workbook's own totals row.
 */
function monthlyTab(
  name: string,
  monthLabel: string,
  yearLabel: string,
  days: DayFixture[],
): { name: string; cells: Cell[][] } {
  const cells: Cell[][] = [];
  cells.push([t('Terex Operating Data'), EMPTY, EMPTY, t(monthLabel), t(yearLabel)]);
  cells.push([
    EMPTY, // ← the day column's header. Blank on every real tab.
    t('Pocket coil '),
    t('Springs'),
    t('Wood'),
    t('Start Hours'),
    t('End Hours'),
    t('Day Total Hrs Used'),
    t('Units per hour'),
    t('Operator'),
    t('condition*'),
    t('Notes'),
  ]);
  for (const d of days) {
    cells.push([
      typeof d.day === 'number' ? n(d.day) : t(d.day),
      d.pc === undefined ? EMPTY : n(d.pc),
      d.springs === undefined ? EMPTY : n(d.springs),
      d.wood === undefined ? EMPTY : n(d.wood),
      EMPTY,
      EMPTY,
      d.hours === undefined || d.hours === null ? EMPTY : n(d.hours),
    ]);
  }
  // The totals row. Column A blank — which is what bounds the data block.
  const sum = (f: (d: DayFixture) => number | undefined) =>
    days.reduce((s, d) => s + (f(d) ?? 0), 0);
  cells.push([
    EMPTY,
    n(sum((d) => d.pc)),
    n(sum((d) => d.springs)),
    n(sum((d) => d.wood)),
    EMPTY,
    EMPTY,
    n(sum((d) => d.hours ?? 0)),
  ]);
  // The `*Key` legend that sits below every real tab.
  cells.push([t('*Key')]);
  cells.push([t('G'), t('Good')]);
  cells.push([t('LOTO'), t('Full Shutdown (entire day)')]);
  return { name, cells };
}

/** Published totals matching a fixture exactly, with a full declared range. */
function publishedFor(
  tab: { name: string; cells: Cell[][] },
  overrides: Partial<PublishedTotals> = {},
): Map<string, PublishedTotals> {
  let units = 0;
  let hours = 0;
  let firstRow = 0;
  let lastRow = 0;
  for (let r = 2; r < tab.cells.length; r += 1) {
    const row = tab.cells[r]!;
    const day = row[0]?.num;
    if (day == null) break;
    if (firstRow === 0) firstRow = r + 1;
    lastRow = r + 1;
    units += (row[1]?.num ?? 0) + (row[2]?.num ?? 0) + (row[3]?.num ?? 0);
    hours += row[6]?.num ?? 0;
  }
  return new Map([
    [
      tab.name,
      {
        units,
        hours,
        unitsRange: { firstRow, lastRow },
        hoursRange: { firstRow, lastRow },
        overviewHours: null,
        overviewAvgPocketCoil: null,
        ...overrides,
      },
    ],
  ]);
}

describe('resolveMonthlyColumns', () => {
  it('resolves the DAY column as the unlabeled one left of Pocket coil', () => {
    const tab = monthlyTab('Jul26', 'July', '2026', [{ day: 1, pc: 146, hours: 8.5 }]);
    const cols = resolveMonthlyColumns(tab.cells[1]!);
    // Column A (index 0) carries the day and has NO header. Resolving columns
    // from a normalized `headers[]` array — which drops leading blanks — would
    // land every one of these an index to the left.
    expect(cols).toMatchObject({ day: 0, pocketCoil: 1, springs: 2, wood: 3, runHours: 6 });
  });

  it('refuses a sheet missing any canonical column', () => {
    expect(
      resolveMonthlyColumns([t('Date'), t('Processed'), t('Received'), t('Hrs Used')]),
    ).toBeNull();
  });
});

describe('parseMonthName', () => {
  it('accepts the four spellings the workbook actually uses', () => {
    expect(parseMonthName('January')).toBe(1);
    expect(parseMonthName('JAN')).toBe(1);
    expect(parseMonthName('Sept')).toBe(9);
    expect(parseMonthName('DECEMBER')).toBe(12);
  });

  it('refuses the decoy placeholder and an ambiguous prefix', () => {
    // The three decoy tabs literally say `MONTH`.
    expect(parseMonthName('MONTH')).toBeNull();
    // `Ju` is june AND july. Guessing either would silently mis-date a month.
    expect(parseMonthName('Ju')).toBeNull();
  });
});

describe('import.date-never-ordinal', () => {
  // ── THE HEADLINE FALSIFICATION ──────────────────────────────────────────
  // Two fixtures for the same month, identical except that the second has an
  // extra row spliced in at the top of the block. Every day AFTER the splice
  // therefore sits at a DIFFERENT sheet row than it did before, while its
  // column-A day cell is unchanged.
  //
  // Deriving the date from the row ordinal — `header + 1 + i` — produces
  // identical output on the first fixture and shifts every subsequent day by one
  // on the second. Deriving it from the CELL produces identical dates on both.
  // That is the entire test: the dates must not move.
  const withoutSplice = monthlyTab('Jul26', 'July', '2026', [
    { day: 1, pc: 146, hours: 8.5 },
    { day: 2, pc: 153, hours: 7.25 },
    { day: 3, pc: 163, hours: 7.85 },
  ]);
  const withSplice = monthlyTab('Jul26', 'July', '2026', [
    // A blank spacer row of exactly the kind the real tabs carry — no day cell,
    // so it is not a day, but it DOES occupy a row.
    { day: '' },
    { day: 1, pc: 146, hours: 8.5 },
    { day: 2, pc: 153, hours: 7.25 },
    { day: 3, pc: 163, hours: 7.85 },
  ]);

  it('dates come from the day CELL, so inserting a row moves nothing', () => {
    const a = extractMonthlyRows([withoutSplice], publishedFor(withoutSplice));
    const b = extractMonthlyRows([withSplice], publishedFor(withSplice));

    expect(a.rows.map((r) => r.dateISO)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    // The load-bearing assertion. Under any ordinal derivation this reads
    // ['2026-07-02','2026-07-03','2026-07-04'] and names those real wrong dates.
    expect(b.rows.map((r) => r.dateISO)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(b.rows.map((r) => r.unitsTotal)).toEqual([146, 153, 163]);
  });

  it('a day that does not exist in the month is refused, not rolled over', () => {
    // Feb 30. `new Date(2026, 1, 30)` would silently roll over to March 2 — a
    // real day, on the wrong month's tab, looking entirely plausible.
    //
    // The fixture carries a full month of good days around the bad one on
    // purpose: with only two rows a single failure is a 50% failure rate and the
    // R1 ceiling below would reject the whole TAB, so the assertion would be
    // measuring the ceiling instead of the day rule.
    const days: DayFixture[] = [];
    for (let d = 1; d <= 28; d += 1) days.push({ day: d, pc: 100, hours: 6 });
    days.push({ day: 30, pc: 999, hours: 6 });
    const feb = monthlyTab('Feb26', 'February', '2026', days);

    const res = extractMonthlyRows([feb], publishedFor(feb));
    expect(res.rows).toHaveLength(28);
    expect(res.rows.map((r) => r.dateISO)).not.toContain('2026-03-02');
    expect(res.rows[res.rows.length - 1]!.dateISO).toBe('2026-02-28');
    expect(res.tabs[0]!.skips.map((s) => s.reason)).toContain('day_out_of_month');
  });

  it('a duplicate day is refused — the first row to claim it keeps it', () => {
    const days: DayFixture[] = [];
    for (let d = 1; d <= 20; d += 1) days.push({ day: d, pc: 100, hours: 6 });
    days.push({ day: 5, pc: 999, hours: 9 });
    const tab = monthlyTab('Jul26', 'July', '2026', days);
    const res = extractMonthlyRows([tab], publishedFor(tab));

    expect(res.rows.filter((r) => r.dateISO === '2026-07-05')).toHaveLength(1);
    expect(res.rows.find((r) => r.dateISO === '2026-07-05')!.unitsTotal).toBe(100);
    expect(res.tabs[0]!.skips.map((s) => s.reason)).toContain('duplicate_day');
  });

  it('R1 — a tab with more than 10% unresolvable rows contributes NOTHING', () => {
    // The ceiling is a whole-tab refusal, not a per-row one: if this many rows
    // cannot be resolved, the layout assumption itself is wrong and the rows
    // that DID resolve are not trustworthy either.
    const days: DayFixture[] = [];
    for (let d = 1; d <= 10; d += 1) days.push({ day: d, pc: 100, hours: 6 });
    days.push({ day: 30, pc: 1, hours: 6 }, { day: 31, pc: 1, hours: 6 });
    const feb = monthlyTab('Feb26', 'February', '2026', days);

    const res = extractMonthlyRows([feb], publishedFor(feb));
    expect(res.rows).toEqual([]);
    expect(res.tabs[0]!.status).toBe('skipped');
    expect(res.tabs[0]!.skipReason).toBe('too_many_failed_rows');
  });

  it('a weekend-heavy tab is NOT rejected by the ceiling', () => {
    // `no_run_hours` is the normal shape of a pre-printed month: 31 rows of
    // which 20 are weekends and shutdowns. Folding those into the ceiling would
    // fail every correct tab — `Dec25` alone has 20 of them.
    const days: DayFixture[] = [];
    for (let d = 1; d <= 31; d += 1)
      days.push({ day: d, ...(d > 20 ? { pc: 100, hours: 6 } : {}) });
    const tab = monthlyTab('Dec25', 'DECEMBER', '2025', days);
    const res = extractMonthlyRows([tab], publishedFor(tab));

    expect(res.tabs[0]!.status).toBe('extracted');
    expect(res.rows).toHaveLength(11);
  });
});

describe('import.decoys-excluded', () => {
  // `Aug25(1)`, `Template` and `Template (2)` wear byte-identical canonical
  // headers, so header-shape matching cannot tell them from a real month. They
  // are excluded by the 24-name allowlist AND, independently, by the
  // title-row cross-check — all three say the literal `MONTH`/`YEAR`.
  const real = monthlyTab('Aug25', 'AUGUST', '2025', [{ day: 4, pc: 123, hours: 7 }]);
  const decoyAug = monthlyTab('Aug25(1)', 'MONTH ', 'YEAR', [{ day: 1, pc: 123, hours: 7 }]);
  const template = monthlyTab('Template', 'MONTH', 'YEAR', [{ day: 1, pc: 620, hours: 17.5 }]);
  const template2 = monthlyTab('Template (2)', 'MONTH', 'YEAR', [{ day: 1, pc: 620, hours: 17.5 }]);
  const overview = { name: 'OVERVIEW2025', cells: [[t('TEREX DATA 2025')]] };
  const diesel = { name: 'diesel', cells: [[t('Terex units per gallon of gas')]] };
  const y2024 = { name: 'Nov24', cells: [[t('November'), t('Pocket coil'), t('Received')]] };

  const res = extractMonthlyRows(
    [real, decoyAug, template, template2, overview, diesel, y2024],
    publishedFor(real),
  );

  it('takes rows from the real month only', () => {
    expect(res.rows.map((r) => r.tabName)).toEqual(['Aug25']);
    expect(res.rows.map((r) => r.dateISO)).toEqual(['2025-08-04']);
  });

  it('names WHY each non-monthly tab was skipped, so a reader can tell a decision from an oversight', () => {
    const byName = Object.fromEntries(res.tabs.map((x) => [x.name, x.skipReason]));
    expect(byName['Aug25(1)']).toBe('not_a_monthly_tab');
    expect(byName['Template']).toBe('not_a_monthly_tab');
    expect(byName['Template (2)']).toBe('not_a_monthly_tab');
    expect(byName['OVERVIEW2025']).toBe('not_a_monthly_tab');
    expect(byName['diesel']).toBe('not_a_monthly_tab');
    // ADR-0081 R3 — deliberately its own reason, not lumped in with the rest.
    expect(byName['Nov24']).toBe('out_of_scope_2024');
  });

  it('the title cross-check refuses an allowlisted tab whose title says MONTH/YEAR', () => {
    // Belt AND braces: even if the allowlist were loosened, a tab still has to
    // claim the month it is supposed to be. `Aug25` carrying the template's
    // placeholder title is refused.
    const impostor = monthlyTab('Aug25', 'MONTH', 'YEAR', [{ day: 1, pc: 999, hours: 7 }]);
    const out = extractMonthlyRows([impostor], publishedFor(impostor));
    expect(out.rows).toEqual([]);
    expect(out.tabs[0]!.skipReason).toBe('title_month_mismatch');
    expect(out.tabs[0]!.titleMonthRaw).toBeNull();
  });
});

describe('import.insane-totals-hard-stop', () => {
  const tab = monthlyTab('Jul26', 'July', '2026', [
    { day: 1, pc: 146, hours: 8.5 },
    { day: 2, pc: 153, hours: 7.25 },
    { day: 3, pc: 163, hours: 7.85 },
  ]);

  it('reconciles when the workbook agrees with the reading', () => {
    const res = extractMonthlyRows([tab], publishedFor(tab));
    expect(res.hardStop).toBe(false);
    expect(res.offendingTabs).toEqual([]);
    expect(res.rows).toHaveLength(3);
  });

  it('a 2% perturbation of the published units STAGES the whole import', () => {
    const truth = publishedFor(tab).get('Jul26')!;
    const perturbed = publishedFor(tab, { units: truth.units! * 1.02 });
    const res = extractMonthlyRows([tab], perturbed);

    // 2% is four times the ±0.5% tolerance. Nothing may be applied.
    expect(res.hardStop).toBe(true);
    expect(res.offendingTabs).toEqual(['Jul26']);
    const failed = res.tabs[0]!.reconciliation.find((c) => !c.ok)!;
    // The report names the real figures, not just "a check failed".
    expect(failed.extracted).toBe(462);
    expect(failed.published).toBeCloseTo(471.24, 2);
  });

  it('a 2% perturbation of the published HOURS also stages', () => {
    const truth = publishedFor(tab).get('Jul26')!;
    const res = extractMonthlyRows([tab], publishedFor(tab, { hours: truth.hours! * 1.02 }));
    expect(res.hardStop).toBe(true);
  });

  it('float noise in the hours cells does NOT stage', () => {
    // The live hours are Excel formula results: 7.849999999999909, not 7.85.
    const noisy = monthlyTab('Jul26', 'July', '2026', [
      { day: 1, pc: 146, hours: 8.5 },
      { day: 2, pc: 153, hours: 7.25 },
      { day: 3, pc: 163, hours: 7.849999999999909 },
    ]);
    const res = extractMonthlyRows([noisy], publishedFor(noisy, { hours: 23.6 }));
    expect(res.hardStop).toBe(false);
  });

  it('the sanity floor refuses an hour-meter reading mis-read into the hours column', () => {
    // `Aug25(1)`'s real defect: end-hour readings landed in the day-hours column,
    // totalling 3,683.95 hours in a month that has 744.
    const bad = monthlyTab('Jul26', 'July', '2026', [{ day: 1, pc: 146, hours: 1226.15 }]);
    const res = extractMonthlyRows([bad], publishedFor(bad));
    expect(res.rows).toEqual([]);
    expect(res.tabs[0]!.skips[0]!.reason).toBe('run_hours_insane');
  });

  it('the sanity floor refuses a monthly total mis-read into a day', () => {
    const bad = monthlyTab('Jul26', 'July', '2026', [{ day: 1, pc: 58496, hours: 8 }]);
    const res = extractMonthlyRows([bad], publishedFor(bad));
    expect(res.rows).toEqual([]);
    expect(res.tabs[0]!.skips[0]!.reason).toBe('units_insane');
  });
});

describe('import.no-hours-row-skipped', () => {
  // ADR-0079's `run_hours` is NOT NULL and CHECK (> 0). A blank or zero hours
  // cell is a day with NO MEASUREMENT, and the honest representation of that is
  // the absence of a row — never a coerced 8, and never `End - Start`.
  const tab = monthlyTab('Jan25', 'JAN', '2025', [
    { day: 1 }, // pre-printed, never worked
    { day: 2, pc: 96, hours: 5.7 },
    { day: 30, pc: 319, hours: 5.2 },
    { day: 31, hours: 0 }, // the live `Metal baler is down` row: literal 0
  ]);
  const res = extractMonthlyRows([tab], publishedFor(tab));

  it('takes only the days that carry real hours', () => {
    expect(res.rows.map((r) => r.dateISO)).toEqual(['2025-01-02', '2025-01-30']);
    expect(res.rows.map((r) => r.runHours)).toEqual([5.7, 5.2]);
  });

  it('COUNTS every skipped row and says why, rather than dropping it silently', () => {
    const skipped = res.tabs[0]!.skips.filter((s) => s.reason === 'no_run_hours');
    expect(skipped).toHaveLength(2);
    expect(skipped.map((s) => s.rowIndex)).toEqual([3, 6]);
  });

  it('a zero-hours day is never coerced into a run', () => {
    // If any future change defaulted hours (to 8, or to End − Start), this day
    // would appear with a fabricated denominator under it.
    expect(res.rows.map((r) => r.dateISO)).not.toContain('2025-01-31');
  });

  it('a RECORDED ZERO units day with real hours IS taken', () => {
    // The live `Jul26` day 18: the machine ran 8 hours and produced nothing.
    // That is a real 0, not an absence — ADR-0077 D4.
    const z = monthlyTab('Jul26', 'July', '2026', [{ day: 18, hours: 8 }]);
    const out = extractMonthlyRows([z], publishedFor(z));
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.unitsTotal).toBe(0);
    expect(out.rows[0]!.runHours).toBe(8);
  });

  it('a fractional unit count is skipped, never rounded', () => {
    // `March25` day 29 reads 131.75 coils against an INTEGER column — the only
    // such cell in the workbook. 132 invents a quarter of a mattress; 131
    // discards one. Neither number is the operator's.
    const frac = monthlyTab('March25', 'MARCH', '2025', [{ day: 29, pc: 131.75, hours: 5.7 }]);
    const out = extractMonthlyRows([frac], publishedFor(frac));
    expect(out.rows).toEqual([]);
    expect(out.tabs[0]!.skips[0]!.reason).toBe('units_not_integer');
    expect(out.tabs[0]!.skips[0]!.detail).toContain('131.75');
  });
});

describe('units are the THREE commodity columns summed', () => {
  it('sums pocket coil + springs + wood', () => {
    const tab = monthlyTab('Jan25', 'JAN', '2025', [{ day: 14, pc: 30, wood: 616, hours: 11 }]);
    const res = extractMonthlyRows([tab], publishedFor(tab));
    expect(res.rows[0]!.unitsTotal).toBe(646);
    expect(res.rows[0]!.pocketCoil).toBe(30);
    expect(res.rows[0]!.wood).toBe(616);
  });
});

describe('the workbook SUM-range defect is reported, not mistaken for an extraction error', () => {
  // `Dec25` totals `SUM(B3:B32)` / `SUM(G3:G32)`, omitting day 31 (182 coils,
  // 7.45 hours). Reconciling over the DECLARED range passes; the omitted row is
  // surfaced as a coverage gap against the SOURCE DOCUMENT.
  const tab = monthlyTab('Dec25', 'DECEMBER', '2025', [
    { day: 29, pc: 128, hours: 4.8 },
    { day: 30, pc: 177, hours: 6.9 },
    { day: 31, pc: 182, hours: 7.45 },
  ]);
  // Rows 3,4,5 in the fixture; the workbook's range stops one short, at row 4.
  const short = new Map<string, PublishedTotals>([
    [
      'Dec25',
      {
        units: 305,
        hours: 11.7,
        unitsRange: { firstRow: 3, lastRow: 4 },
        hoursRange: { firstRow: 3, lastRow: 4 },
        overviewHours: null,
        overviewAvgPocketCoil: null,
      },
    ],
  ]);
  const res = extractMonthlyRows([tab], short);

  it('reconciles over the range the workbook DECLARES', () => {
    expect(res.hardStop).toBe(false);
  });

  it('still imports the omitted day', () => {
    expect(res.rows.map((r) => r.dateISO)).toContain('2025-12-31');
  });

  it('reports the omission as a defect in the source document', () => {
    expect(res.tabs[0]!.coverageGap).toHaveLength(1);
    expect(res.tabs[0]!.coverageGap[0]).toMatchObject({
      dateISO: '2025-12-31',
      units: 182,
      missingFrom: ['units', 'hours'],
    });
  });
});
