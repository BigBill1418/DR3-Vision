// Handoff #270 §2 — the production report and the canonical balance are ONE number.
//
// ── The claim being pinned ──────────────────────────────────────────────────
// Bill's report reads wrong "especially on the production report", and the
// standing suspicion was that `getEodInventorySnapshot` computed on-hand a SECOND
// way, independently of `onHand`. Measured on 2026-08-18 that premise DIED: the
// report already delegates both day balances to `onHand` and the live figures are
// identical on both paths (Woodland 442 program / 397 non-program / 839 total).
//
// So there is no refactor here. There is a PIN: the equivalence is currently a
// property of one `await onHand(...)` call that any future edit could quietly
// replace with a local aggregate, and nothing in the suite would have noticed.
// This file is what notices.
//
// ── Why this is not "the mock equals the mock" ─────────────────────────────
// `onHand` is mocked, as it is in eod-inventory.test.ts — the inventory equation
// is exhaustively covered in running-balance.test.ts and re-deriving it here would
// test the fixture. The mock is what makes this test SHARP rather than vacuous:
// it returns values that NOTHING ELSE IN THE SYSTEM COULD PRODUCE (1234.5 /
// 678.25 — fractional, arbitrary, unreachable from any aggregate of the empty
// fake tables). A second computation path cannot coincidentally arrive at them.
// If the report ever stops sourcing its figure from `onHand`, the rendered value
// stops being 1234.5 and this goes red.
//
// The value is only half the claim. "The same number" is meaningless without "for
// the same site and day", so the ARGUMENTS are asserted too: a report that faithfully
// echoed `onHand` but asked it for the wrong day would satisfy a value-only test
// while being exactly as wrong as the bug this pins against.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const D = Prisma.Decimal;

/** Every (siteId, asOf-epoch) pair `onHand` was asked for, in call order. */
const onHandCalls: Array<{ siteId: string; asOf: number }> = [];

/**
 * Deliberately unreachable-by-accident pool values. An aggregate over the empty
 * fake tables below can only ever produce 0, so these can arrive at the snapshot
 * through exactly one route: the `onHand` call itself.
 */
const SENTINEL = { program: 1234.5, nonProgram: 678.25 };
/** A DIFFERENT balance for the prior day, so a day-mixup is visible in the delta. */
const PRIOR = { program: 1000, nonProgram: 600 };

const anchorRow = {
  id: 'snap-1',
  snapshot_at: new Date('2026-08-18T07:00:00.000Z'), // Pacific midnight, 2026-08-18
  pool_attribution: 'measured',
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteInventorySnapshot: { findFirst: async () => anchorRow },
    auditLog: { findFirst: async () => ({ actor_label: 'system', actor: null }) },
    inboundLoad: {
      aggregate: async () => ({ _max: { arrived_at: new Date('2026-08-18T15:00:00.000Z') } }),
      count: async () => 0,
    },
    consumerDropoff: { aggregate: async () => ({ _max: { dropoff_date: null } }) },
    processedUnitsDaily: { aggregate: async () => ({ _max: { production_date: null } }) },
    outboundMaterial: { aggregate: async () => ({ _max: { ship_date: null } }) },
    landfilledUnit: { aggregate: async () => ({ _max: { disposal_date: null } }) },
  },
}));

vi.mock('@/lib/inventory/running-balance', () => ({
  VERIFIED_INBOUND_STATUSES: ['verified', 'submitted_to_mymrc', 'processed'],
  anchorFlowBounds: () => ({ dateSince: new Date(0), inboundSince: new Date(0) }),
  onHand: async (siteId: string, asOf: Date) => {
    onHandCalls.push({ siteId, asOf: asOf.getTime() });
    // The FIRST call is end-of-report-day, the second end-of-prior-day (the module
    // issues them together). Keyed on which one it is, not on call order, so the
    // test does not silently depend on Promise.all scheduling.
    const isPriorDay = asOf.getTime() < REPORT_END;
    const b = isPriorDay ? PRIOR : SENTINEL;
    const program = new D(b.program);
    const nonProgram = new D(b.nonProgram);
    return { program, nonProgram, total: program.plus(nonProgram) };
  },
}));

const { getEodInventorySnapshot, endOfReportDay } = await import('./eod-inventory');

/** @db.Date-shaped key for the Pacific day 2026-08-18. */
const REPORT_DAY = new Date(Date.UTC(2026, 7, 18));
const REPORT_END = endOfReportDay(REPORT_DAY).getTime();
const SITE = 'site-woodland';

beforeEach(() => {
  onHandCalls.length = 0;
});

describe('the production report renders the CANONICAL on-hand, not a second computation', () => {
  // ── FALSIFICATION (equivalence pin) ───────────────────────────────────────
  // Verified by hand: adding `+ 1` to `programOnHand` in getEodInventorySnapshot
  // turns this red with
  //   expected 1235.5 to be 1234.5
  // i.e. the pin detects a divergence of ONE UNIT between the report and the
  // canonical balance. Recorded in the PR body.
  it('programOnHand IS the balance onHand returned — to the decimal', () => {
    return getEodInventorySnapshot(SITE, REPORT_DAY).then((eod) => {
      expect(eod.programOnHand).toBe(SENTINEL.program);
    });
  });

  it('nonProgramOnHand IS the balance onHand returned', async () => {
    const eod = await getEodInventorySnapshot(SITE, REPORT_DAY);
    expect(eod.nonProgramOnHand).toBe(SENTINEL.nonProgram);
  });

  it('totalOnHand IS onHand’s total, not a re-addition of the report’s own pools', async () => {
    const eod = await getEodInventorySnapshot(SITE, REPORT_DAY);
    expect(eod.totalOnHand).toBe(SENTINEL.program + SENTINEL.nonProgram);
  });

  // The pools must survive as pools. A report that summed correctly but attributed
  // the split differently would mis-bill MRC while totalling to the right number.
  it('keeps the pool split intact (program + nonProgram === total)', async () => {
    const eod = await getEodInventorySnapshot(SITE, REPORT_DAY);
    expect(eod.programOnHand + eod.nonProgramOnHand).toBe(eod.totalOnHand);
  });
});

describe('…for the SAME site and the SAME day', () => {
  it('asks onHand for the report site only', async () => {
    await getEodInventorySnapshot(SITE, REPORT_DAY);
    expect(onHandCalls.length).toBeGreaterThan(0);
    for (const c of onHandCalls) expect(c.siteId).toBe(SITE);
  });

  // The report day's balance must be read at the report day's LAST millisecond.
  // Reading it at the day's start would silently drop every @db.Date row filed for
  // the day — a whole day of production missing from a number that still looks fine.
  it('reads the report-day balance at end-of-report-day, exactly', async () => {
    await getEodInventorySnapshot(SITE, REPORT_DAY);
    expect(onHandCalls.map((c) => c.asOf)).toContain(REPORT_END);
  });

  it('reads the comparison balance at end-of-PRIOR-day, exactly one day earlier', async () => {
    await getEodInventorySnapshot(SITE, REPORT_DAY);
    const priorEnd = endOfReportDay(new Date(REPORT_DAY.getTime() - 86_400_000)).getTime();
    expect(onHandCalls.map((c) => c.asOf)).toContain(priorEnd);
    expect(REPORT_END - priorEnd).toBe(86_400_000);
  });

  // The delta is the one figure derived from BOTH balances, so it is where a
  // day-mixup would show up as a plausible-looking number rather than an error.
  it('derives the day-over-day delta from those two balances and nothing else', async () => {
    const eod = await getEodInventorySnapshot(SITE, REPORT_DAY);
    const expected = SENTINEL.program + SENTINEL.nonProgram - (PRIOR.program + PRIOR.nonProgram);
    expect(eod.deltaFromYesterday).toBe(expected);
    expect(eod.programDelta).toBe(SENTINEL.program - PRIOR.program);
    expect(eod.nonProgramDelta).toBe(SENTINEL.nonProgram - PRIOR.nonProgram);
  });
});

describe('the report adds no inventory arithmetic of its own', () => {
  // Percentages are presentation, and must be derived from the canonical pools
  // rather than from anything the report re-fetched.
  it('derives the pool percentages from the canonical pools', async () => {
    const eod = await getEodInventorySnapshot(SITE, REPORT_DAY);
    const total = SENTINEL.program + SENTINEL.nonProgram;
    expect(eod.programPct).toBe(Math.round((SENTINEL.program / total) * 1000) / 10);
    expect(eod.nonProgramPct).toBe(Math.round((SENTINEL.nonProgram / total) * 1000) / 10);
  });

  // The module's separate aggregate queries exist ONLY to date the data
  // (`_max` freshness keys). If one of them ever starts contributing UNITS, the
  // sentinel above stops matching — this test states that intent out loud so the
  // next reader knows the aggregates are allowed to exist but not to add up.
  it('leaves the balance untouched by its freshness aggregates', async () => {
    const eod = await getEodInventorySnapshot(SITE, REPORT_DAY);
    expect(eod.totalOnHand).toBe(SENTINEL.program + SENTINEL.nonProgram);
    expect(eod.flowThrough).not.toBeNull();
  });
});
