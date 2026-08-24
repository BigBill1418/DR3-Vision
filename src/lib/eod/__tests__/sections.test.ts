// ADR-0125 — the day sections, their gap flags, and the month rollup.
//
// Everything under test here is PURE, so the fixtures are the whole story: the
// same `WindowRows` object drives the per-day sections and the rollup, which is
// exactly the property being asserted.
//
// ── Falsification, recorded ─────────────────────────────────────────────────
//
// 1. GAP FLAG. Removing the `: 'missing'` branch (grading every section
//    `captured`) takes "flags a day with no inbound line as ⚠ not recorded" red
//    with `expected 'captured' to be 'missing'`. The positive control in the
//    same describe block is what stops the inverse cheat: a `gapFlags` that
//    returned `'missing'` unconditionally would pass the first assertion and
//    fail "does not flag a section that HAS rows".
//
// 2. THE ROLLUP. Re-pointing `rollupFromDays` at anything other than the day
//    totals — the shape a second query would produce — takes the divergence
//    fixture red: patching ONE row on ONE day moves the day section and the
//    rollup by the same amount only because the rollup folds those totals.
//    Falsified by hand: making the rollup's `inbound.units` sum `d.inbound.lines`
//    instead takes BOTH rollup cases red —
//      AssertionError: expected 5 to be 61 // Object.is equality
//      AssertionError: expected +0 to be 1 // Object.is equality
//    — the second being the divergence fixture noticing that the month figure
//    did not move when the day's row did.

import { describe, it, expect } from 'vitest';
import {
  bucketRowsByDay,
  dayKeysBetween,
  gapFlags,
  hasGaps,
  missingSections,
  rollupFromDays,
  summarizeDay,
  type DaySectionRows,
  type InboundLine,
  type OutboundLine,
  type WindowRows,
} from '../sections';
import { dayKeyUTCFromISO } from '@/lib/time';

// ─────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────

function inbound(dayKey: string, over: Partial<InboundLine> = {}): InboundLine {
  return {
    id: `in-${dayKey}-${Math.random().toString(36).slice(2, 8)}`,
    dayKey,
    arrivedAt: new Date(`${dayKey}T07:00:00.000Z`),
    loadSourceType: 'b2b_haul',
    status: 'verified',
    sourceName: 'Test Source',
    totalUnits: 10,
    programUnits: 10,
    nonProgramUnits: 0,
    weightLbs: 550,
    bolNumber: null,
    dr3Number: null,
    haulNumber: null,
    slipNumber: null,
    transportCharged: false,
    ...over,
  };
}

function outbound(dayKey: string, over: Partial<OutboundLine> = {}): OutboundLine {
  return {
    id: `out-${dayKey}-${Math.random().toString(36).slice(2, 8)}`,
    dayKey,
    commodity: 'metal',
    subCategory: 'baled',
    weightLbs: 1000,
    wholeUnits: null,
    programUnits: null,
    nonProgramUnits: null,
    ticketNumber: null,
    ...over,
  };
}

function emptyDay(dayKey: string, terexApplicable = true): DaySectionRows {
  return {
    dayKey,
    inbound: [],
    outbound: [],
    renovation: [],
    unpaidDropoffs: [],
    incentiveDropoffs: [],
    otherDropoffs: [],
    processed: null,
    terex: null,
    landfilled: [],
    terexApplicable,
  };
}

function emptyWindow(over: Partial<WindowRows> = {}): WindowRows {
  return {
    inbound: [],
    outbound: [],
    dropoffs: [],
    processed: [],
    terex: [],
    landfilled: [],
    terexMachineId: 'terex-1',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe('gap flags', () => {
  it('flags a day with no inbound line as ⚠ not recorded — the assertion is the FLAG, not a silent pass', () => {
    const totals = summarizeDay(emptyDay('2026-08-20'));
    // The literal grade, not "the section is empty". A test that asserted
    // `inbound.lines === 0` would pass just as happily against a surface that
    // never rendered a flag at all.
    expect(totals.flags.inbound).toBe('missing');
    expect(missingSections(totals)).toContain('inbound');
    expect(hasGaps(totals)).toBe(true);
  });

  it('does not flag a section that HAS rows — the positive control', () => {
    // Without this case, `gapFlags` returning 'missing' unconditionally would
    // satisfy every other assertion in this file and the suite would be
    // measuring nothing.
    const day = emptyDay('2026-08-20');
    day.inbound.push(inbound('2026-08-20'));
    const totals = summarizeDay(day);
    expect(totals.flags.inbound).toBe('captured');
    expect(missingSections(totals)).not.toContain('inbound');
  });

  it('grades Terex `not_applicable` at a site with no machine — never a permanent ⚠', () => {
    // Eugene's standing condition. A two-state flag would put a warning on a
    // site that is behaving correctly, which is how a flag gets ignored.
    const eugene = summarizeDay(emptyDay('2026-08-20', false));
    expect(eugene.flags.terex).toBe('not_applicable');
    expect(missingSections(eugene)).not.toContain('terex');
    expect(hasGaps(eugene)).toBe(true); // the OTHER sections still flag

    const woodland = summarizeDay(emptyDay('2026-08-20', true));
    expect(woodland.flags.terex).toBe('missing');
  });

  it('flags NonProgram and unpaid drop-offs — measured near-daily, not near-zero (G-7)', () => {
    const totals = summarizeDay(emptyDay('2026-08-20'));
    expect(totals.flags.nonProgram).toBe('missing');
    expect(totals.flags.unpaidDropoff).toBe('missing');
  });

  it('treats "not recorded" and "zero" as different — a zero-unit line is CAPTURED', () => {
    const day = emptyDay('2026-08-20');
    day.processed = {
      id: 'p1',
      dayKey: '2026-08-20',
      strippedProgram: 0,
      strippedNonProgram: 0,
      savedUnits: null,
      materialTicketNumber: null,
      source: 'manual',
      closed: false,
    };
    const totals = summarizeDay(day);
    expect(totals.processed.strippedProgram).toBe(0);
    expect(totals.flags.processed).toBe('captured');
  });

  it('grades from the totals it is handed, so the flag and the header cannot disagree', () => {
    const day = emptyDay('2026-08-20');
    day.outbound.push(outbound('2026-08-20'));
    const totals = summarizeDay(day);
    const bare = { ...totals } as Partial<typeof totals>;
    delete bare.flags;
    expect(gapFlags(bare as Omit<typeof totals, 'flags'>)).toEqual(totals.flags);
  });
});

describe('bucketing', () => {
  const start = dayKeyUTCFromISO('2026-08-18');
  const end = dayKeyUTCFromISO('2026-08-20');
  const keys = dayKeysBetween(start, end);

  it('covers every day in the window, including the ones with no rows', () => {
    expect(keys).toEqual(['2026-08-18', '2026-08-19', '2026-08-20']);
    const days = bucketRowsByDay(emptyWindow(), keys);
    expect(days.map((d) => d.dayKey)).toEqual(keys);
  });

  it('routes renovation OUT of the commodities bucket — the sheet has two tabs, Vision has one table', () => {
    // Disjoint buckets are what stop the rollup counting one outbound row twice.
    const rows = emptyWindow({
      outbound: [
        outbound('2026-08-19', { subCategory: 'baled', weightLbs: 100 }),
        outbound('2026-08-19', { subCategory: 'renovation', weightLbs: 200, wholeUnits: 5 }),
      ],
    });
    const day = bucketRowsByDay(rows, keys)[1] as DaySectionRows;
    expect(day.outbound).toHaveLength(1);
    expect(day.renovation).toHaveLength(1);
    const totals = summarizeDay(day);
    expect(totals.outbound.weightLbs).toBe(100);
    expect(totals.renovation.weightLbs).toBe(200);
  });

  it('splits drop-offs into unpaid / incentive / other with no overlap', () => {
    const mk = (kind: string, units: number) => ({
      id: `d-${kind}`,
      dayKey: '2026-08-19',
      kind,
      personName: 'A Person',
      units,
      checkNumber: null,
      slipNumber: null,
    });
    const rows = emptyWindow({
      dropoffs: [
        mk('unpaid', 3),
        mk('incentive', 5),
        mk('illegal', 7),
        mk('floor_public', 11),
        // ADR-0085 Am.1 — the iPad Illegal label lands in "other", same as its
        // floor siblings, NOT in the manager `illegal` bucket.
        mk('floor_illegal', 13),
      ],
    });
    const totals = summarizeDay(bucketRowsByDay(rows, keys)[1] as DaySectionRows);
    expect(totals.unpaidDropoff.units).toBe(3);
    expect(totals.incentiveDropoff.units).toBe(5);
    expect(totals.otherDropoff.units).toBe(31);
  });

  it('derives NonProgram from the inbound split, not from a separate table (G-4/D9)', () => {
    const rows = emptyWindow({
      inbound: [
        inbound('2026-08-19', { totalUnits: 10, programUnits: 10, nonProgramUnits: 0 }),
        inbound('2026-08-19', { totalUnits: 8, programUnits: 2, nonProgramUnits: 6 }),
      ],
    });
    const totals = summarizeDay(bucketRowsByDay(rows, keys)[1] as DaySectionRows);
    expect(totals.nonProgram.lines).toBe(1);
    expect(totals.nonProgram.units).toBe(6);
    expect(totals.flags.nonProgram).toBe('captured');
  });

  it('splits freight from no-freight on `transportCharged` — the two inbound tabs', () => {
    const rows = emptyWindow({
      inbound: [
        inbound('2026-08-19', { transportCharged: true }),
        inbound('2026-08-19', { transportCharged: false }),
        inbound('2026-08-19', { transportCharged: false }),
      ],
    });
    const totals = summarizeDay(bucketRowsByDay(rows, keys)[1] as DaySectionRows);
    expect(totals.inbound.freightLines).toBe(1);
    expect(totals.inbound.noFreightLines).toBe(2);
  });
});

describe('month rollup == the sum of the sections it displays (D5)', () => {
  const start = dayKeyUTCFromISO('2026-08-01');
  const end = dayKeyUTCFromISO('2026-08-05');
  const keys = dayKeysBetween(start, end);

  /** Five days of traffic, deliberately uneven. */
  function window(bump = 0): WindowRows {
    return emptyWindow({
      inbound: [
        inbound('2026-08-01', { totalUnits: 10, programUnits: 10, nonProgramUnits: 0 }),
        inbound('2026-08-02', { totalUnits: 12, programUnits: 9, nonProgramUnits: 3 }),
        inbound('2026-08-03', {
          totalUnits: 20 + bump,
          programUnits: 20 + bump,
          nonProgramUnits: 0,
        }),
        inbound('2026-08-03', { totalUnits: 5, programUnits: 5, nonProgramUnits: 0 }),
        inbound('2026-08-05', { totalUnits: 14, programUnits: 14, nonProgramUnits: 0 }),
      ],
      outbound: [
        outbound('2026-08-02', { weightLbs: 900 }),
        outbound('2026-08-04', { weightLbs: 1100, subCategory: 'shredded' }),
        outbound('2026-08-04', { weightLbs: 300, subCategory: 'renovation', wholeUnits: 4 }),
      ],
      processed: [
        {
          id: 'p1',
          dayKey: '2026-08-01',
          strippedProgram: 100.5,
          strippedNonProgram: 10,
          savedUnits: null,
          materialTicketNumber: 'M-1',
          source: 'manual',
          closed: false,
        },
        {
          id: 'p2',
          dayKey: '2026-08-03',
          strippedProgram: 200.5,
          strippedNonProgram: 0,
          savedUnits: 2,
          materialTicketNumber: 'M-2',
          source: 'import',
          closed: false,
        },
      ],
    });
  }

  const totalsFor = (rows: WindowRows) => bucketRowsByDay(rows, keys).map(summarizeDay);

  it('every rollup figure equals the sum of the per-day section figures', () => {
    const perDay = totalsFor(window());
    const rollup = rollupFromDays(perDay);

    const sum = (pick: (d: (typeof perDay)[number]) => number) =>
      perDay.reduce((n, d) => n + pick(d), 0);

    expect(rollup.days).toBe(5);
    expect(rollup.fromDayKey).toBe('2026-08-01');
    expect(rollup.toDayKey).toBe('2026-08-05');
    expect(rollup.inbound.lines).toBe(sum((d) => d.inbound.lines));
    expect(rollup.inbound.units).toBe(sum((d) => d.inbound.units));
    expect(rollup.inbound.units).toBe(61);
    expect(rollup.nonProgram.units).toBe(sum((d) => d.nonProgram.units));
    expect(rollup.outbound.weightLbs).toBe(sum((d) => d.outbound.weightLbs));
    expect(rollup.renovation.wholeUnits).toBe(sum((d) => d.renovation.wholeUnits));
    expect(rollup.processed.strippedProgram).toBe(sum((d) => d.processed.strippedProgram));
    // Decimal folding, not binary float: 100.5 + 200.5 must be exactly 301.
    expect(rollup.processed.strippedProgram).toBe(301);
    expect(rollup.processed.daysRecorded).toBe(2);
  });

  it('DIVERGENCE FIXTURE — patching ONE row moves the day section and the rollup by the same amount', () => {
    // This is the test that a rollup computed from its own query would fail.
    // The +1 is applied to the SOURCE rows, so both the day-3 section total and
    // the month figure have to move together or the two are not one computation.
    const before = totalsFor(window(0));
    const after = totalsFor(window(1));

    const day3Before = before[2];
    const day3After = after[2];
    expect(day3Before?.inbound.units).toBe(25);
    expect(day3After?.inbound.units).toBe(26);

    const rollupBefore = rollupFromDays(before);
    const rollupAfter = rollupFromDays(after);
    expect(rollupAfter.inbound.units - rollupBefore.inbound.units).toBe(1);
    expect(rollupAfter.inbound.programUnits - rollupBefore.inbound.programUnits).toBe(1);

    // And no OTHER day moved — a rollup that re-derived from a wider or narrower
    // window would show the change somewhere this fixture never touched.
    for (const i of [0, 1, 3, 4]) {
      expect(after[i]?.inbound.units).toBe(before[i]?.inbound.units);
    }
  });

  it('counts days with an open gap from the same flags the sections render', () => {
    const perDay = totalsFor(window());
    const rollup = rollupFromDays(perDay);
    expect(rollup.daysWithGaps).toBe(perDay.filter(hasGaps).length);
    // Every day in this fixture is missing at least Terex, so all five flag.
    expect(rollup.daysWithGaps).toBe(5);
  });

  it('folds an empty month to zeroes with no day keys, rather than throwing', () => {
    const rollup = rollupFromDays([]);
    expect(rollup.days).toBe(0);
    expect(rollup.fromDayKey).toBe('');
    expect(rollup.inbound.units).toBe(0);
  });
});
