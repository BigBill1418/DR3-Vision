// PR #196 §2.3/§3.4 — the incident is the acceptance test. On 2026-07-30 the
// delivered-hauls feed had been frozen at 2026-07-21 for nine days while
// Confirmed rows were future-dated to 2026-08-10, and the floor read −3,083 on
// the surface the July COR prefills from. These fixtures pin exactly that
// state: a green gate on the incident fixture is a test failure.

import { describe, expect, it, vi } from 'vitest';

const store = { newestDelivered: null as Date | null };

vi.mock('@/lib/prisma', () => ({
  prisma: {
    mymrcHaulsMirror: {
      aggregate: async (args: { where?: { status?: string } }) => {
        // The gate must measure DELIVERED rows only — a whole-table max is
        // permanently masked by future-dated Confirmed appointments.
        if (args?.where?.status !== 'Delivered') {
          throw new Error('gate measured the whole mirror — the original 2026-07-30 guard bug');
        }
        return { _max: { docking_appointment_date: store.newestDelivered } };
      },
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

describe('assertInboundFreshnessForCor (pure) — the 2026-07 incident fixture', () => {
  it('REFUSES on the exact incident state: delivered frozen 07-21, filing on 07-30', () => {
    const f = assessFreshness('hauls', FROZEN_DELIVERED_MAX, INCIDENT_NOW);
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
    const f = assessFreshness('hauls', new Date('2026-07-29T12:00:00Z'), INCIDENT_NOW);
    expect(() => assertInboundFreshnessForCor(f)).not.toThrow();
  });

  it('an empty mirror is bootstrap, not stale (assessFreshness contract)', () => {
    const f = assessFreshness('hauls', null, INCIDENT_NOW);
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
