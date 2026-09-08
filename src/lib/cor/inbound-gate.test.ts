// PR #196 §2.3/§3.4 — the incident is the acceptance test. On 2026-07-30 the
// delivered-hauls feed had been frozen at 2026-07-21 for nine days while
// Confirmed rows were future-dated to 2026-08-10, and the floor read −3,083 on
// the surface the July COR prefills from. These fixtures pin exactly that
// state: a green gate on the incident fixture is a test failure.

import { describe, expect, it, vi } from 'vitest';

const store = { newestDelivered: null as Date | null };

vi.mock('@/lib/prisma', () => ({
  prisma: {
    // ADR-0089 D3 — the freshness measure is a raw max(COALESCE(delivery,
    // appointment)) over Delivered rows. The fake pins BOTH guard properties in
    // the SQL text: measuring the whole mirror (the 2026-07-30 bug) or measuring
    // the bare appointment column (the ADR-0089 blind spot) throws here.
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?').replace(/\s+/g, ' ');
      if (!sql.includes("status = 'Delivered'")) {
        throw new Error('gate measured the whole mirror — the original 2026-07-30 guard bug');
      }
      if (!sql.includes('COALESCE(recycler_reported_delivery_date, docking_appointment_date)')) {
        throw new Error('gate measured the bare appointment column — the ADR-0089 blind spot');
      }
      return [{ newest: store.newestDelivered }];
    },
  },
}));

import { assessFreshness } from '@/lib/mymrc/freshness';
import {
  assertCorInboundFresh,
  assertCorInventoryNotNegative,
  assertInboundFreshnessForCor,
  CorInboundStaleError,
  CorLedgerNegativeError,
} from './inbound-gate';

const INCIDENT_NOW = new Date('2026-07-30T20:00:00Z');
const FROZEN_DELIVERED_MAX = new Date('2026-07-21T12:00:00Z');
/** The operator-owned closure list this gate now shares with the pager. */
const HOLIDAYS: ReadonlySet<string> = new Set(['2026-07-03', '2026-09-07']);
const NO_HOL: ReadonlySet<string> = new Set<string>();

describe('assertInboundFreshnessForCor (pure) — the 2026-07 incident fixture', () => {
  it('REFUSES on the exact incident state: delivered frozen 07-21, filing on 07-30', () => {
    const f = assessFreshness('hauls', FROZEN_DELIVERED_MAX, INCIDENT_NOW, HOLIDAYS);
    expect(f.stale).toBe(true);
    expect(() => assertInboundFreshnessForCor(f)).toThrowError(CorInboundStaleError);
    try {
      assertInboundFreshnessForCor(f);
    } catch (e) {
      const err = e as CorInboundStaleError;
      expect(err.status).toBe(409);
      expect(err.context.newest).toBe('2026-07-21');
      expect(err.message).toContain('feed is frozen');
      expect(err.message).toContain('2026-07-21');
    }
  });

  it('passes when the newest delivered haul is within the freshness threshold', () => {
    const f = assessFreshness('hauls', new Date('2026-07-29T12:00:00Z'), INCIDENT_NOW, HOLIDAYS);
    expect(() => assertInboundFreshnessForCor(f)).not.toThrow();
  });

  it('gates on the D6 BUSINESS-DAY verdict — Bill 2026-09-07, ADR-0130 Am.2', () => {
    // THIS TEST DELIBERATELY FLIPPED. Until 2026-09-07 it asserted the opposite:
    // that the gate kept calendar hours while the pager moved to business days.
    // Am.1 §A1.2 recorded that as "probably right to convert, but not a decision a
    // notification-noise ADR gets to make implicitly." Bill made it explicitly at
    // 18:20 PDT on 2026-09-07 — "yes convert the COR gate and EOD flag to business
    // days too" — so the coupling is restored on purpose and this is the assertion
    // of the NEW behaviour.
    //
    // The case that motivated it: newest delivered haul Thu 2026-09-03, filing on
    // Mon 2026-09-07, which is Labor Day. 105 CALENDAR hours — the old gate refused
    // to file a COR. ONE business day — a Friday — so nothing is actually stale and
    // the filing goes through.
    const f = assessFreshness(
      'hauls',
      new Date('2026-09-03T12:00:00Z'),
      new Date('2026-09-07T21:00:00Z'),
      new Set(['2026-09-07']),
    );
    expect(f.ageMs).toBeGreaterThan(96 * 3_600_000); // the OLD rule would refuse
    expect(f.businessDaysBehind).toBe(1);
    expect(f.stale).toBe(false);
    expect(() => assertInboundFreshnessForCor(f)).not.toThrow();
  });

  it('still refuses a genuine mid-week freeze — and one day EARLIER than 96h', () => {
    // The direction that matters for a billing document. A freeze beginning Wed
    // 2026-09-16 (last good record Tue 09-15) reaches 3 business days on Fri 09-18;
    // 96 calendar hours is not reached until Sat 09-19. Converting makes the gate
    // STRICTER here, by exactly one day, which is the correct direction: a COR must
    // not be filed on stale inbound data.
    const lastGood = new Date('2026-09-15T12:00:00Z');
    const friday = assessFreshness('hauls', lastGood, new Date('2026-09-18T21:00:00Z'), NO_HOL);
    expect(friday.businessDaysBehind).toBe(3);
    expect(friday.ageMs).toBeLessThan(96 * 3_600_000); // 96h has NOT yet fired
    expect(() => assertInboundFreshnessForCor(friday)).toThrowError(CorInboundStaleError);
  });

  it('the 409 states the business-day count, not only a calendar figure', () => {
    // The rule decides in business days, so the refusal has to say so — otherwise
    // it reads "3.4 days behind" against a threshold of 2 and the reader cannot
    // reconcile the two numbers.
    const f = assessFreshness('hauls', FROZEN_DELIVERED_MAX, INCIDENT_NOW, HOLIDAYS);
    try {
      assertInboundFreshnessForCor(f);
      throw new Error('expected a refusal');
    } catch (e) {
      const err = e as CorInboundStaleError;
      expect(err).toBeInstanceOf(CorInboundStaleError);
      expect(err.message).toMatch(/business day/i);
      // Tue 2026-07-21 -> Thu 2026-07-30 (INCIDENT_NOW is 13:00 PDT that day):
      // 22, 23, 24, 27, 28, 29, 30 = 7 business days.
      expect(err.context.businessDaysBehind).toBe(7);
      // The forward path stays in the message — a refusal with no way out is a wall.
      expect(err.message).toMatch(/fix-woodland-inbound\.sh|physical count/);
    }
  });

  it('an empty mirror is bootstrap, not stale (assessFreshness contract)', () => {
    const f = assessFreshness('hauls', null, INCIDENT_NOW, HOLIDAYS);
    expect(() => assertInboundFreshnessForCor(f)).not.toThrow();
  });
});

describe('assertCorInboundFresh (live measure through prisma)', () => {
  it('measures delivered-only and refuses on the frozen mirror', async () => {
    store.newestDelivered = FROZEN_DELIVERED_MAX;
    await expect(assertCorInboundFresh(INCIDENT_NOW)).rejects.toBeInstanceOf(CorInboundStaleError);
  });

  it('passes on a fresh mirror', async () => {
    store.newestDelivered = new Date('2026-07-30T12:00:00Z');
    await expect(assertCorInboundFresh(INCIDENT_NOW)).resolves.toBeUndefined();
  });
});

describe('assertCorInventoryNotNegative', () => {
  it('refuses the measured incident figures', () => {
    for (const n of [-3083, -5401, -1]) {
      expect(() => assertCorInventoryNotNegative(n)).toThrowError(CorLedgerNegativeError);
    }
    try {
      assertCorInventoryNotNegative(-5401);
    } catch (e) {
      expect((e as CorLedgerNegativeError).status).toBe(422);
      expect((e as CorLedgerNegativeError).context.totalUnits).toBe(-5401);
    }
  });

  it('zero and positive figures pass', () => {
    expect(() => assertCorInventoryNotNegative(0)).not.toThrow();
    expect(() => assertCorInventoryNotNegative(1500)).not.toThrow();
  });
});
