// ADR-0069 Am.2 — TEREX maintenance extraction.
//
// Fixtures mirror the REAL workbook pulled from R2 on 2026-07-31: a title row, a
// header row at row 2, an instructional "example" row at row 3, a year/month
// scaffold, and two maintenance-log sheets where one is a strict subset of the
// other.
//
// The headline guard: absorbing both sheets naively doubles $77,067.94 into
// $154,135.88. Every guard here was falsified before being kept.

import { describe, expect, it } from 'vitest';
import { extractTerexRows } from './terex-extract';
import type { Cell } from './trailer-extract';

const E: Cell = { text: '', num: null, date: null };
const s = (text: string): Cell => ({ text, num: null, date: null });
const n = (v: number): Cell => ({ text: String(v), num: v, date: null });
const d = (iso: string): Cell => ({ text: iso, num: null, date: iso });

/** The live header row, verbatim (note the double space in "Time  *"). */
const HEADER: Cell[] = [
  E,
  s('Date *'),
  s('Time  *'),
  s('Issue *'),
  s('Measures taken *'),
  s('Estimated repair time/cost'),
  s('Estimated cost'),
  s('Notes*'),
  s('Actual Repair Cost'),
  s('Amount Credited'),
];
const TITLE: Cell[] = [E, s('TEREX MACHINE MAINTENANCE LOG'), E, E, E, E, E, E, E, E];
/** Row 3 of the real file — instructional, not a repair that happened. */
const EXAMPLE: Cell[] = [
  s('example'),
  s('October     10/9/2024'),
  s('11:52am'),
  s('dripping oil from the back'),
  s('called Jonathan at Powerscreen'),
  s('2 weeks'),
  E,
  s('Fixed by 3:30pm'),
  E,
  E,
];
/** Year/month scaffold rows carry no event. */
const YEAR: Cell[] = [n(2024), s('September'), E, E, E, E, E, E, E, E];
const MONTH: Cell[] = [E, s('October'), E, E, E, E, E, E, E, E];

function event(date: Cell, issue: string, actual: number | null): Cell[] {
  return [E, date, E, s(issue), s('repaired'), E, E, E, actual === null ? E : n(actual), E];
}

function logSheet(name: string, ...events: Cell[][]) {
  return { name, cells: [TITLE, HEADER, EXAMPLE, YEAR, MONTH, ...events] };
}

describe('extractTerexRows — the real log shape', () => {
  it('skips the example row, the scaffold rows, and keeps the events', () => {
    const res = extractTerexRows([
      logSheet('Maintenance Log2026', event(d('2024-11-21'), 'shaft broken', 4850)),
    ]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.issue).toBe('shaft broken');
    expect(res.rows[0]!.actualRepairCost).toBe(4850);
    const sheet = res.sheets[0]!;
    expect(sheet.exampleRows).toBe(1);
    expect(sheet.scaffoldRows).toBe(2);
    // The example is instructional. Absorbing it invents a Powerscreen repair.
    expect(res.rows.some((r) => r.issue?.includes('dripping oil'))).toBe(false);
  });

  it('a blank cost is NOT RECORDED, never 0', () => {
    const res = extractTerexRows([
      logSheet('Maintenance Log2026', event(d('2024-11-11'), 'shaft broke', null)),
    ]);
    expect(res.rows[0]!.actualRepairCost).toBeNull();
    expect(res.totals.actualRepairCost).toBe(0);
  });
});

describe('extractTerexRows — the double-count guard', () => {
  it('DEDUPES an event that appears on two sheets', () => {
    // The real situation: `Maintenance Log 2025` is a strict subset of
    // `Maintenance Log2026`, and both report $77,067.94. Summing both gives
    // exactly double.
    const shared = event(d('2024-11-21'), 'shaft broken', 4850);
    const extra = event(d('2026-01-06'), 'Terex was stalling', 1000);
    const res = extractTerexRows([
      logSheet('Maintenance Log 2025', shared),
      logSheet('Maintenance Log2026', shared, extra),
    ]);
    expect(res.rows).toHaveLength(2);
    expect(res.duplicatesRemoved).toBe(1);
    expect(res.duplicateSources).toContain('Maintenance Log2026');
    // The whole point: the total is the truth, not twice the truth.
    expect(res.totals.actualRepairCost).toBe(5850);
  });

  it('without dedup the same money would be counted twice — proven by a single sheet', () => {
    const shared = event(d('2024-11-21'), 'shaft broken', 4850);
    const one = extractTerexRows([logSheet('Maintenance Log2026', shared)]);
    const two = extractTerexRows([
      logSheet('Maintenance Log 2025', shared),
      logSheet('Maintenance Log2026', shared),
    ]);
    // Two sheets carrying the same event must not move the total at all.
    expect(two.totals.actualRepairCost).toBe(one.totals.actualRepairCost);
  });

  it('two genuinely different events on different sheets both survive', () => {
    // Dedup must not become "drop anything that looks similar".
    const res = extractTerexRows([
      logSheet('Maintenance Log 2025', event(d('2024-11-21'), 'shaft broken', 4850)),
      logSheet('Maintenance Log2026', event(d('2025-03-02'), 'belt tearing', 1584.66)),
    ]);
    expect(res.rows).toHaveLength(2);
    expect(res.duplicatesRemoved).toBe(0);
  });
});

describe('extractTerexRows — the date column is not trustworthy', () => {
  it('keeps a real date', () => {
    const res = extractTerexRows([
      logSheet('Maintenance Log2026', event(d('2025-03-02'), 'belt', 10)),
    ]);
    expect(res.rows[0]!.eventDate).toBe('2025-03-02');
    expect(res.undatedEvents).toBe(0);
  });

  it('REFUSES to guess an ambiguous date, but keeps what was written', () => {
    // The operator wrote "09/16 or 17" because they did not know which day.
    // Inventing one is worse than leaving it undated.
    const res = extractTerexRows([
      logSheet('Maintenance Log2026', event(s('09/16 or 17'), 'hydraulic leak', 200)),
    ]);
    expect(res.rows[0]!.eventDate).toBeNull();
    expect(res.rows[0]!.eventDateRaw).toBe('09/16 or 17');
    expect(res.undatedEvents).toBe(1);
  });

  it('rejects the Excel EPOCH artefact rather than dating an event to 1900', () => {
    // The live file has one: 1900-01-14, from a time value read as a date. Left
    // alone it sorts to the top of every view forever.
    const res = extractTerexRows([
      logSheet('Maintenance Log2026', event(d('1900-01-14'), 'high pressure hose', 300)),
    ]);
    expect(res.rows[0]!.eventDate).toBeNull();
    expect(res.rows[0]!.eventDateRaw).toBe('1900-01-14');
  });

  it('does not parse a month-only or year-less scrawl', () => {
    const res = extractTerexRows([
      logSheet(
        'Maintenance Log2026',
        event(s('Jan.14'), 'a', 1),
        event(s('Jan'), 'b', 2),
        event(s('1/14/202601'), 'c', 3),
      ),
    ]);
    expect(res.rows.every((r) => r.eventDate === null)).toBe(true);
    expect(res.undatedEvents).toBe(3);
  });
});

describe('extractTerexRows — which sheets it will touch', () => {
  it('IGNORES the monthly operating sheets — that is processed_units_daily territory', () => {
    const monthly = {
      name: 'Jan 2026',
      cells: [
        [s('Terex Operating Data'), E, E, s('January'), n(2026)],
        [E, s('Pocket coil'), s('Springs'), s('Wood'), s('Start Hours'), s('End Hours')],
        [n(2), n(182), E, E, n(1657.1), n(1664.7)],
      ],
    };
    const res = extractTerexRows([monthly]);
    expect(res.rows).toHaveLength(0);
    expect(res.sheets[0]!.skipped).toBe('not_a_maintenance_log');
  });

  it('IGNORES the derived OVERVIEW/summary tabs — absorbing a rollup double-counts', () => {
    const overview = {
      name: 'OVERVIEW2026',
      cells: [
        [E, E, s('TEREX DATA 2026')],
        [E, E, s('Month'), s('High'), s('Low'), s('Average')],
        [E, E, s('January'), n(31.5), n(18.5), n(25.6)],
      ],
    };
    const totals = {
      name: 'Combined Totals',
      cells: [
        [E, E, s('Total Hours Used'), s('Maintenance Costs incurred per month')],
        [n(2024), s('September'), n(62.9), n(0)],
      ],
    };
    const res = extractTerexRows([overview, totals]);
    expect(res.rows).toHaveLength(0);
    expect(res.sheets.every((x) => x.skipped === 'not_a_maintenance_log')).toBe(true);
  });

  it('identifies a log by its COLUMNS, not by its tab name', () => {
    // A tab called something else entirely, carrying the real columns, is a log.
    const res = extractTerexRows([logSheet('Repairs (old)', event(d('2025-05-05'), 'motor', 99))]);
    expect(res.rows).toHaveLength(1);
    expect(res.sheets[0]!.skipped).toBeNull();
  });
});
