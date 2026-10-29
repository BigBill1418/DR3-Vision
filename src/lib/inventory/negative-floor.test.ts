// ADR-0143 D1 / D5 — the single non-negative presenter and the single remedy.
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  classifyNegativeFloor,
  negativeFloorCopy,
  presentOnHand,
  remedyForBalance,
  type NegativeFloorCause,
} from './negative-floor';

const D = Prisma.Decimal;

describe('presentOnHand (ADR-0143 D1)', () => {
  it('formats every pool when nothing is negative', () => {
    const p = presentOnHand({
      program: new D(1234),
      nonProgram: new D('56.5'),
      total: new D('1290.5'),
    });
    expect(p.poolsShown).toBe(true);
    expect(p.program).toBe('1,234');
    expect(p.nonProgram).toBe('56.5');
    expect(p.total).toBe('1,290.5');
    expect(p.notice).toBeNull();
    expect(p.cause).toBeNull();
  });

  it('Woodland 2026-10-29 (case 1, program -247 / total +397): pools withheld, total kept, Am.1 sentence', () => {
    const p = presentOnHand({ program: new D(-247), nonProgram: new D(644), total: new D(397) });
    expect(p.poolsShown).toBe(false);
    expect(p.program).toBeNull();
    expect(p.nonProgram).toBeNull();
    // Bill B2 2026-10-29: the total is what matters, and it is not in question.
    expect(p.total).toBe('397');
    expect(p.cause).toEqual({ kind: 'pool-split', pool: 'program' });
    expect(p.notice?.headline).toBe(
      'Program on-hand is computing negative while the total is positive.',
    );
    expect(JSON.stringify(p)).not.toContain('247');
    expect(JSON.stringify(p)).not.toContain('644');
  });

  it('accepts plain numbers (mail renderers hold numbers, not Decimals)', () => {
    const p = presentOnHand({ program: 10, nonProgram: -1, total: 9 });
    expect(p.poolsShown).toBe(false);
    expect(p.cause).toEqual({ kind: 'pool-split', pool: 'non-program' });
  });

  it('total negative with stale intake blames intake, never prints the figure', () => {
    const p = presentOnHand(
      { program: -500, nonProgram: 100, total: -400 },
      { inboundStale: true, inboundDaysSince: 4 },
    );
    expect(p.cause).toEqual({ kind: 'intake-stale', inboundDaysSince: 4 });
    expect(p.total).toBeNull();
    expect(JSON.stringify(p)).not.toContain('400');
  });
});

describe('one remedy (ADR-0143 D5, test T4)', () => {
  const cases: Array<{
    cause: NegativeFloorCause;
    balance: { program: number; nonProgram: number; total: number };
    ctx: { inboundStale: boolean; inboundDaysSince: number | null };
  }> = [
    {
      cause: { kind: 'pool-split', pool: 'program' },
      balance: { program: -1, nonProgram: 5, total: 4 },
      ctx: { inboundStale: false, inboundDaysSince: 0 },
    },
    {
      cause: { kind: 'pool-split', pool: 'non-program' },
      balance: { program: 5, nonProgram: -1, total: 4 },
      ctx: { inboundStale: false, inboundDaysSince: 0 },
    },
    {
      cause: { kind: 'intake-stale', inboundDaysSince: 3 },
      balance: { program: -5, nonProgram: 1, total: -4 },
      ctx: { inboundStale: true, inboundDaysSince: 3 },
    },
    {
      cause: { kind: 'processing-exceeds-inbound', inboundRecorded: true },
      balance: { program: -5, nonProgram: 1, total: -4 },
      ctx: { inboundStale: false, inboundDaysSince: 0 },
    },
    {
      cause: { kind: 'processing-exceeds-inbound', inboundRecorded: false },
      balance: { program: -5, nonProgram: 1, total: -4 },
      ctx: { inboundStale: false, inboundDaysSince: null },
    },
  ];

  it.each(cases)(
    'the notice remedy IS negativeFloorCopy().remedy for $cause.kind',
    ({ cause, balance, ctx }) => {
      const copy = negativeFloorCopy(cause);
      expect(copy.remedy.length).toBeGreaterThan(20);
      expect(classifyNegativeFloor({ ...balance, ...ctx })).toEqual(cause);
      expect(presentOnHand(balance, ctx).notice?.remedy).toBe(copy.remedy);
      expect(remedyForBalance(balance, ctx)).toBe(copy.remedy);
    },
  );

  it('a pool split never tells anyone to count: the floor is mixed (Bill B3, 2026-10-29)', () => {
    const r = negativeFloorCopy({ kind: 'pool-split', pool: 'program' }).remedy;
    expect(r).toMatch(/pool adjustment/);
    expect(r).toMatch(/second person/);
    expect(r).not.toMatch(/physical count resets/i);
  });

  it('remedyForBalance is null when nothing is negative', () => {
    expect(remedyForBalance({ program: 1, nonProgram: 1, total: 2 })).toBeNull();
  });
});
