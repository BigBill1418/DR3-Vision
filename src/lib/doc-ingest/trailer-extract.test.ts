// ADR-0069 Am.1 — trailer-list extraction.
//
// The fixtures mirror the REAL file pulled from R2 on 2026-07-31: header on row
// 2, data starting in column B (column A entirely empty), `"Driver "` with a
// trailing space, `"Days in Yard\n(auto calc)"` with an embedded newline,
// weights recorded as numbers / blanks / the literal "-", and blank spacer rows
// between blocks.
//
// Every guard was falsified before being kept.

import { describe, expect, it } from 'vitest';
import { extractTrailerRows, type Cell } from './trailer-extract';

const E: Cell = { text: '', num: null, date: null };
const s = (text: string): Cell => ({ text, num: null, date: null });
const n = (v: number): Cell => ({ text: String(v), num: v, date: null });
const d = (iso: string): Cell => ({ text: iso, num: null, date: iso });

/** The live sheet's header row, verbatim — trailing space and newline included. */
const HEADER: Cell[] = [
  E,
  s('Date of Entry to Yard'),
  s('Trailer #'),
  s('Material'),
  s('Weight (lbs)'),
  s('Driver '),
  s('Days in Yard\n(auto calc)'),
  s('Exit Date'),
  s('Notes'),
];

const TITLE: Cell[] = [E, s(''), s('Woodland Trailer List 2025'), E, E, E, E, E, E];

function sheet(...dataRows: Cell[][]): Cell[][] {
  return [TITLE, HEADER, ...dataRows];
}

describe('extractTrailerRows — the live layout', () => {
  it('finds the header on row 2 and reads data starting in column B', () => {
    const res = extractTrailerRows(
      'Trailer List Woodland 2025',
      sheet([
        E,
        d('2025-06-23'),
        n(533739),
        s('pocket coil'),
        n(7110),
        E,
        n(129),
        d('2025-10-30'),
        E,
      ]),
    );
    expect(res.failure).toBeNull();
    expect(res.headerRowIndex).toBe(2);
    expect(res.rows).toHaveLength(1);
    const r = res.rows[0]!;
    expect(r.trailerNo).toBe('533739');
    expect(r.entryDate).toBe('2025-06-23');
    expect(r.materialRaw).toBe('pocket coil');
    expect(r.weightLbs).toBe(7110);
    expect(r.exitDate).toBe('2025-10-30');
    // Provenance: sheet row 3, 1-based.
    expect(r.rowIndex).toBe(3);
  });

  it('matches headers by MEANING — a trailing space and a newline do not break it', () => {
    const res = extractTrailerRows(
      'x',
      sheet([E, E, n(1), s('wood'), n(100), s('J. Smith'), n(4), E, s('note')]),
    );
    expect(res.rows[0]!.driver).toBe('J. Smith'); // header was 'Driver '
    expect(res.rows[0]!.daysInYardSheet).toBe(4); // header had an embedded newline
  });
});

describe('extractTrailerRows — a blank is not a zero', () => {
  it('records a "-" weight as NOT RECORDED, never 0', () => {
    // Six live rows carry exactly this. Writing 0 would invent six trailers
    // weighing nothing and drag any average down with them.
    const res = extractTrailerRows(
      'x',
      sheet([E, E, n(2801), s('EMPTY/out of service'), s('-'), E, E, E, E]),
    );
    const r = res.rows[0]!;
    expect(r.weightLbs).toBeNull();
    // …but the dash survives, so the distinction is recoverable.
    expect(r.weightRaw).toBe('-');
  });

  it('records a BLANK weight as not recorded', () => {
    const res = extractTrailerRows('x', sheet([E, E, n(5308), s('EMPTY'), E, E, E, E, E]));
    expect(res.rows[0]!.weightLbs).toBeNull();
    expect(res.rows[0]!.weightRaw).toBeNull();
  });

  it('a real zero weight is kept as zero', () => {
    // The other direction matters just as much: a sheet that says 0 means 0.
    const res = extractTrailerRows('x', sheet([E, E, n(77), s('foam'), n(0), E, E, E, E]));
    expect(res.rows[0]!.weightLbs).toBe(0);
  });

  it('leaves a missing entry or exit date null rather than inventing one', () => {
    const res = extractTrailerRows('x', sheet([E, E, n(9), s('wood'), n(10), E, E, E, E]));
    expect(res.rows[0]!.entryDate).toBeNull();
    expect(res.rows[0]!.exitDate).toBeNull();
  });
});

describe('extractTrailerRows — rows it must skip, and rows it must not', () => {
  it('skips blank spacer rows (28 of them in the live file)', () => {
    const res = extractTrailerRows(
      'x',
      sheet(
        [E, E, n(1), s('wood'), n(10), E, E, E, E],
        [E, E, E, E, E, E, E, E, E],
        [E, E, n(2), s('foam'), n(20), E, E, E, E],
      ),
    );
    expect(res.rows).toHaveLength(2);
    expect(res.skippedBlank).toBe(1);
  });

  it('keeps a row that has a trailer number but nothing else', () => {
    // A trailer in the yard with no details is still a trailer in the yard.
    const res = extractTrailerRows('x', sheet([E, E, n(4242), E, E, E, E, E, E]));
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.materialRaw).toBeNull();
  });

  it('stores messy free-text material VERBATIM', () => {
    // The live file holds "pocket coil", "pocket coils", "Pocketcoil", and a
    // number of ORIGINS ("Recology SF"). Normalising would invent a taxonomy
    // nobody agreed to; mapping to program/non-program would invent a billing
    // fact.
    const res = extractTrailerRows(
      'x',
      sheet(
        [E, E, n(1), s('Pocketcoil'), n(1), E, E, E, E],
        [E, E, n(2), s('  Recology SF  '), n(2), E, E, E, E],
      ),
    );
    expect(res.rows[0]!.materialRaw).toBe('Pocketcoil');
    expect(res.rows[1]!.materialRaw).toBe('Recology SF');
  });
});

describe('extractTrailerRows — it refuses rather than guessing', () => {
  it('REFUSES a sheet with no trailer column', () => {
    const res = extractTrailerRows('x', [
      TITLE,
      [E, s('Date'), s('Vendor'), s('Amount')],
      [E, d('2026-01-01'), s('Acme'), n(10)],
    ]);
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('missing_columns');
    expect(res.failure?.message).toMatch(/trailerNo/);
  });

  it('REFUSES a sheet with a trailer column but no material column', () => {
    const res = extractTrailerRows('x', [
      TITLE,
      [E, s('Trailer #'), s('Weight (lbs)')],
      [E, n(1), n(100)],
    ]);
    expect(res.failure?.kind).toBe('missing_columns');
  });

  it('names what it detected when it refuses, so a wrong guess is diagnosable', () => {
    const res = extractTrailerRows('x', [TITLE, [E, s('Date'), s('Vendor')], [E, E, E]]);
    expect(res.failure?.message).toMatch(/Detected headers on row/);
  });

  it('reports NO ROWS rather than a successful absorption of nothing', () => {
    const res = extractTrailerRows('x', sheet([E, E, E, E, E, E, E, E, E]));
    expect(res.rows).toHaveLength(0);
    expect(res.failure?.kind).toBe('no_rows');
  });

  it('reports NO HEADER on an empty sheet', () => {
    const res = extractTrailerRows('x', []);
    expect(res.failure?.kind).toBe('no_header');
  });
});
