// ADR-0096 — the server-side day guard, and the named exception to it.
//
// ## Why this test is a mock, and what it is therefore allowed to claim
//
// Every assertion here is about OUR TYPESCRIPT: which day string the server
// compares, whether it compares at all, and what it does when the caller's
// acknowledgement disagrees with the row. None of that is a claim about
// Postgres, so a mocked client is the right instrument (the same reasoning
// `load-claim.in-transaction.test.ts` sets out). The DB-level guarantees this
// path depends on — the UNIQUE index on `expected_load_id` refusing a second
// mint — are proven in `load-claim.db.test.ts` and are untouched here.
//
// ## The defect being closed
//
// Before this, `startInboundLoad` performed NO day check whatsoever. The
// current-Pacific-day bound of ADR-0074 D5 lived entirely in the two READ
// layers (`portal-hauls.ts` and the queue page's `where`), which ADR-0074 Am.1
// recorded as an open decision and ADR-0094 re-confirmed was still open. A
// bookmarked or stale page, a replayed POST, or a hand-crafted call could mint a
// child load onto any slot at the site, of any age — which is precisely the
// 159-unit mis-booking the day bound exists to prevent.
//
// ## Why the exception is an ACKNOWLEDGEMENT rather than a flag
//
// A boolean `allowAnyDay: true` would close nothing: a stale client would pass
// it just as happily as a correct one. The caller must instead state WHICH day
// it believes the slot is scheduled for, and the server refuses if that
// disagrees with the row. A client that has not actually read this slot's date
// cannot produce the value, so the assert is evidence the operator was looking
// at the truck they are reconciling — ADR-0094's "names the slot it is
// reconciling against and asserts the match server-side."

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, prismaMock } = vi.hoisted(() => {
  const state = {
    expected: null as Record<string, unknown> | null,
    created: null as Record<string, unknown> | null,
    audit: [] as Record<string, unknown>[],
  };
  const tx = {
    expectedLoad: { findUnique: async () => state.expected },
    inboundLoad: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.created = args.data;
        return { id: 'new-load' };
      },
      findUnique: async () => null,
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.audit.push(args.data);
        return { id: 'audit-1' };
      },
    },
    // ADR-0120 — the workbook-promotion site lock. A fake cannot take a
    // real advisory lock, so this accepts it and does nothing. What the lock
    // actually does — block a concurrent floor write at the SAME site, and
    // not block a different site — is a Postgres property, proven in
    // `src/lib/audit/promotion-lock.db.test.ts`. No-op-ing it here keeps this
    // suite measuring the behaviour it is actually about.
    $executeRaw: async () => 0,
  };
  const prismaMock = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    inboundLoad: { findUnique: async () => null },
    auditLog: { create: async () => ({ id: 'a' }) },
  };
  return { state, prismaMock };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { startInboundLoad, LoadAccessError } from '@/lib/load-service';

/** 2026-08-11 17:25 PDT — the instant of the H-136980 incident. */
const NOW = new Date('2026-08-12T00:25:00.000Z');
/** Same Pacific day as NOW: 2026-08-11 09:00 PDT. */
const TODAY_APPT = new Date('2026-08-11T16:00:00.000Z');
/** The day BEFORE — H-136980's real appointment. */
const YESTERDAY_APPT = new Date('2026-08-10T16:00:00.000Z');

const SITE = 'site-w';
const OP = 'user-janette';

function slot(over: Record<string, unknown> = {}) {
  return {
    id: 'exp-h136980',
    site_id: SITE,
    cancelled_at: null,
    source_id: 'src-1',
    transporter_id: 'tr-1',
    bol_number: null,
    expected_arrival_at: YESTERDAY_APPT,
    inbound_load: null,
    ...over,
  };
}

async function start(over: Record<string, unknown> = {}) {
  return startInboundLoad({
    expectedLoadId: 'exp-h136980',
    siteId: SITE,
    operatorUserId: OP,
    now: NOW,
    ...over,
  } as Parameters<typeof startInboundLoad>[0]);
}

beforeEach(() => {
  state.expected = slot();
  state.created = null;
  state.audit = [];
});

describe('the guard that did not exist (ADR-0074 Am.1 open decision, closed)', () => {
  it('REFUSES a slot scheduled for another day when nothing acknowledges it', async () => {
    // The whole point. Before ADR-0096 this minted a load silently.
    await expect(start()).rejects.toMatchObject({
      status: 409,
      reason: 'expected_load_not_due_today',
    });
    expect(state.created).toBeNull();
  });

  it('still starts a slot that IS due today, with no ceremony added', async () => {
    state.expected = slot({ expected_arrival_at: TODAY_APPT });
    const r = await start();
    expect(r).toEqual({ id: 'new-load', claimed: true });
    expect(state.created).toMatchObject({ status: 'arrived', assigned_operator_id: OP });
  });

  it('refuses an UNDATED slot outright — a null day cannot be proven to be today', async () => {
    state.expected = slot({ expected_arrival_at: null });
    await expect(start()).rejects.toMatchObject({ status: 409 });
    expect(state.created).toBeNull();
  });

  it('judges the day in PACIFIC, not UTC — the 5 PM PT trap', async () => {
    // 2026-08-11 17:25 PDT is already 2026-08-12 in UTC. A server comparing UTC
    // days would call today's own slot "not today" for the last 7 hours of every
    // Pacific day — refusing the entire evening shift.
    state.expected = slot({ expected_arrival_at: TODAY_APPT });
    await expect(start()).resolves.toMatchObject({ claimed: true });
  });
});

describe('the named exception: this truck arrived on a different day', () => {
  it('starts the load when the caller acknowledges the slot’s REAL day', async () => {
    const r = await start({ reconcile: { acknowledgedSlotDayISO: '2026-08-10' } });
    expect(r).toEqual({ id: 'new-load', claimed: true });
    expect(state.created).toMatchObject({ status: 'arrived' });
  });

  it('stamps arrived_at with NOW, never with the slot’s stale appointment', async () => {
    // The truck is on the dock at 5:25 PM PT on the 11th. Billing and throughput
    // read `arrived_at`; writing the 10th here would file today's work under
    // yesterday, which is the ADR-0089 defect in miniature.
    await start({ reconcile: { acknowledgedSlotDayISO: '2026-08-10' } });
    expect(state.created?.['arrived_at']).toEqual(NOW);
  });

  it('REFUSES when the acknowledgement names the wrong day', async () => {
    // A stale page that still believes this slot is today's cannot mint. This is
    // the assert that makes the exception evidence rather than a flag.
    await expect(
      start({ reconcile: { acknowledgedSlotDayISO: '2026-08-11' } }),
    ).rejects.toMatchObject({ status: 409, reason: 'slot_day_mismatch' });
    expect(state.created).toBeNull();
  });

  it('a bare boolean cannot be forged in its place — the value must MATCH the row', async () => {
    // Stated as a property: no acknowledgement other than the row's own day is
    // accepted, so `allowAnyDay: true` has no encoding here.
    for (const wrong of ['2026-08-09', '2026-08-11', '2026-01-01', '']) {
      state.created = null;
      await expect(start({ reconcile: { acknowledgedSlotDayISO: wrong } })).rejects.toMatchObject({
        status: 409,
      });
      expect(state.created).toBeNull();
    }
  });

  it('refuses to reconcile an UNDATED slot even with an acknowledgement', async () => {
    // There is no day to agree with, so agreement cannot be demonstrated.
    state.expected = slot({ expected_arrival_at: null });
    await expect(
      start({ reconcile: { acknowledgedSlotDayISO: '2026-08-10' } }),
    ).rejects.toMatchObject({ status: 409, reason: 'expected_load_undated' });
  });

  it('records the divergence on the audit row — the reconcile is not invisible', async () => {
    // A load minted against another day's slot must be answerable later without
    // re-deriving it from two timestamps.
    await start({ reconcile: { acknowledgedSlotDayISO: '2026-08-10' } });
    const after = state.audit[0]?.['after'] as Record<string, unknown> | undefined;
    expect(after?.['reconciled_from_day']).toBe('2026-08-10');
    expect(after?.['reconciled_on_day']).toBe('2026-08-11');
  });

  it('does NOT stamp reconcile fields on an ordinary same-day start', async () => {
    state.expected = slot({ expected_arrival_at: TODAY_APPT });
    await start();
    const after = state.audit[0]?.['after'] as Record<string, unknown> | undefined;
    expect(after?.['reconciled_from_day']).toBeUndefined();
  });
});

describe('the guards that were already there still fire first', () => {
  it('a CANCELLED slot is refused before any day reasoning', async () => {
    state.expected = slot({ cancelled_at: new Date(), expected_arrival_at: TODAY_APPT });
    await expect(start()).rejects.toMatchObject({ status: 409 });
  });

  it('a cancelled slot cannot be reconciled open either', async () => {
    // The reconcile path is an exception to the DAY rule, not to every rule.
    state.expected = slot({ cancelled_at: new Date() });
    await expect(
      start({ reconcile: { acknowledgedSlotDayISO: '2026-08-10' } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.created).toBeNull();
  });

  it('a CONSUMED slot hands back the existing child and mints nothing', async () => {
    state.expected = slot({ inbound_load: { id: 'existing-load' } });
    await expect(start()).resolves.toEqual({ id: 'existing-load', claimed: false });
    expect(state.created).toBeNull();
  });

  it('a slot at ANOTHER SITE is refused even with a correct acknowledgement', async () => {
    state.expected = slot({ site_id: 'site-eugene' });
    await expect(
      start({ reconcile: { acknowledgedSlotDayISO: '2026-08-10' } }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('LoadAccessError shape', () => {
  it('carries a machine-readable reason the clients can map', async () => {
    // D-8's lesson: an unmapped reason is a silent no-op on the floor.
    const err = await start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadAccessError);
    expect((err as LoadAccessError).reason).toBe('expected_load_not_due_today');
  });
});
