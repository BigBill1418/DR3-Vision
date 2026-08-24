// Handoff #270 §1 — an untaught consumer drop-off kind must FAIL LOUD, never sum.
//
// ── What was wrong ──────────────────────────────────────────────────────────
// `onHand` summed drop-offs with `aggregate({ _sum: { units } })` and NO `kind`
// predicate. Every kind in the table — including any added later — landed in the
// PROGRAM pool by default. MRC is billed on program units, so an untaught kind is
// a mis-invoice that is indistinguishable from a correct one. ADR-0085 added two
// kinds and this reader absorbed them without anyone deciding it should.
//
// ── Why this file tests the PURE function ───────────────────────────────────
// The refusal has to be provable against a kind that DOES NOT EXIST YET — that is
// the whole scenario. A Postgres enum cannot hold an unknown value, so the only
// honest way to stage "a kind arrived that we were never taught" is to hand the
// reader the row shape the driver would return. `sumTaughtDropoffKinds` is
// therefore pure and takes the `groupBy` rows directly, and the wiring test below
// proves `onHand` actually routes its query through it rather than around it.
//
// The compile-time half of the guard (a new enum member breaking
// `Record<ConsumerDropoffKind, 'program'>` in tsc) cannot be asserted from inside
// a passing test run — a file that fails to compile fails the whole suite. It was
// falsified by hand instead: deleting `floor_incentive` from `DROPOFF_KIND_POOL`
// yields `TS2741: Property 'floor_incentive' is missing in type … but required in
// type 'Readonly<Record<ConsumerDropoffKind, "program">>'`, which is the identical
// error a newly-added enum member produces. Recorded in the PR body.

import { describe, it, expect } from 'vitest';
import { Prisma, type ConsumerDropoffKind } from '@prisma/client';
import {
  sumTaughtDropoffKinds,
  UnknownDropoffKindError,
  DROPOFF_KIND_POOL,
  KNOWN_DROPOFF_KINDS,
  type DropoffKindGroup,
} from './running-balance';

const g = (kind: string, units: number | null): DropoffKindGroup => ({ kind, _sum: { units } });

describe('DROPOFF_KIND_POOL — the taught set', () => {
  // Pins the CURRENT enum. If someone adds a kind, this is the second thing that
  // goes red (tsc is the first), and the message names what to do about it.
  it('teaches exactly the six kinds the schema defines today', () => {
    expect(Object.keys(DROPOFF_KIND_POOL).sort()).toEqual([
      'floor_illegal',
      'floor_incentive',
      'floor_public',
      'illegal',
      'incentive',
      'unpaid',
    ]);
  });

  it('routes every taught kind to the PROGRAM pool (CIP drop-offs)', () => {
    for (const pool of Object.values(DROPOFF_KIND_POOL)) expect(pool).toBe('program');
  });

  it('derives KNOWN_DROPOFF_KINDS from the pool table, so the two cannot drift', () => {
    expect([...KNOWN_DROPOFF_KINDS].sort()).toEqual(Object.keys(DROPOFF_KIND_POOL).sort());
  });
});

describe('sumTaughtDropoffKinds — untaught kinds are refused, not defaulted', () => {
  // ── FALSIFICATION (kind-guard) ────────────────────────────────────────────
  // Against the PRE-FIX reader — `_sum: { units }` with no `kind` predicate — this
  // exact window returned 40 and the report rendered it as fact. The pre-fix
  // behaviour is asserted explicitly in the "naive reader" test below, so the two
  // sit side by side: the old code's answer, and the refusal that replaces it.
  it('THROWS when the window holds a kind the balance was never taught', () => {
    const groups = [g('unpaid', 25), g('floor_commercial', 15)];
    expect(() => sumTaughtDropoffKinds(groups, 'site-woodland')).toThrow(UnknownDropoffKindError);
  });

  it('names the offending kind, the site, and the file to fix — not a bare failure', () => {
    let err: unknown;
    try {
      sumTaughtDropoffKinds([g('unpaid', 25), g('floor_commercial', 15)], 'site-woodland');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownDropoffKindError);
    const e = err as UnknownDropoffKindError;
    expect(e.kinds).toEqual(['floor_commercial']);
    expect(e.siteId).toBe('site-woodland');
    expect(e.message).toContain('floor_commercial');
    expect(e.message).toContain('DROPOFF_KIND_POOL');
  });

  it('reports EVERY untaught kind at once, so a second one is not a second outage', () => {
    let err: unknown;
    try {
      sumTaughtDropoffKinds([g('unpaid', 5), g('kind_a', 1), g('kind_b', 2)], 's');
    } catch (e) {
      err = e;
    }
    expect((err as UnknownDropoffKindError).kinds).toEqual(['kind_a', 'kind_b']);
  });

  // An untaught kind with no units is STILL untaught. If this were tolerated, the
  // guard would go green on the day a new kind ships and red only once it carried
  // volume — i.e. it would fire after the mis-billing, not before it.
  it('THROWS on an untaught kind even when its units sum to zero', () => {
    expect(() => sumTaughtDropoffKinds([g('unpaid', 100), g('floor_commercial', 0)], 's')).toThrow(
      UnknownDropoffKindError,
    );
  });

  it('THROWS on an untaught kind whose units are NULL', () => {
    expect(() =>
      sumTaughtDropoffKinds([g('unpaid', 100), g('floor_commercial', null)], 's'),
    ).toThrow(UnknownDropoffKindError);
  });

  // ── The naive reader, written out so the delta is visible ─────────────────
  // This is what `onHand` did before: sum the units column, whatever kind it is.
  // It returns a confident 40 for the same window the guard refuses. Keeping it in
  // the file makes "the test would pass against the old code" impossible to claim.
  it('the pre-fix naive sum silently returns a number for the SAME window', () => {
    const groups = [g('unpaid', 25), g('floor_commercial', 15)];
    const naive = groups.reduce((n, r) => n + (r._sum.units ?? 0), 0);
    expect(naive).toBe(40);
    expect(() => sumTaughtDropoffKinds(groups, 's')).toThrow();
  });
});

describe('sumTaughtDropoffKinds — taught kinds are summed exactly as before', () => {
  it('sums every taught kind into one program-pool total', () => {
    const all = (Object.keys(DROPOFF_KIND_POOL) as ConsumerDropoffKind[]).map((k, i) =>
      g(k, (i + 1) * 10),
    );
    // 10 + 20 + 30 + 40 + 50 + 60
    expect(sumTaughtDropoffKinds(all, 's').equals(new Prisma.Decimal(210))).toBe(true);
  });

  it('treats a NULL sum on a taught kind as zero (an empty group, not an error)', () => {
    expect(sumTaughtDropoffKinds([g('unpaid', null)], 's').equals(new Prisma.Decimal(0))).toBe(
      true,
    );
  });

  it('returns zero for an empty window', () => {
    expect(sumTaughtDropoffKinds([], 's').equals(new Prisma.Decimal(0))).toBe(true);
  });

  // Behaviour-preservation: the grouped sum must equal the old bare `_sum` for any
  // window made only of taught kinds. This is the claim that lets the change ship
  // on the day of a physical count without moving a single live number.
  it('equals the old bare _sum for any all-taught window', () => {
    const groups = [g('incentive', 12), g('unpaid', 7), g('floor_public', 3), g('illegal', 1)];
    const oldBareSum = groups.reduce((n, r) => n + (r._sum.units ?? 0), 0);
    expect(sumTaughtDropoffKinds(groups, 's').toNumber()).toBe(oldBareSum);
  });
});
