// ADR-0065 Amendment 1 — the operator's own unfinished dock loads.
//
// The load-bearing property: an operator can always get back to a load THEY
// started, no matter what day its parent expected row falls on and no matter
// whether that parent was cancelled. Those two filters are precisely what
// stranded three production loads at Woodland on 2026-07-30, one of them counted
// and never submitted.
//
// These assertions are about the QUERY SHAPE, because that is where the defect
// lived — the previous behavior was not a wrong result, it was no query at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above every `const` in this file, so the factory cannot
// close over a plain top-level variable (ReferenceError at collect time).
// `vi.hoisted` lifts the spy alongside it.
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { inboundLoad: { findMany } } }));

import { listOperatorOpenLoads, OPEN_DOCK_STATUSES } from './open-loads';

const SITE = 'site-woodland';
const OP = 'user-morena';

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe('OPEN_DOCK_STATUSES', () => {
  it('covers every status the 7-stage dock workflow can be paused in', () => {
    // Mirrors `ALLOWED_PRIOR` in load-service.ts: these are the states a load can
    // sit in while still belonging to the floor.
    expect([...OPEN_DOCK_STATUSES]).toEqual([
      'arrived',
      'weight_captured',
      'unload_started',
      'in_progress',
      'finished',
    ]);
  });

  it("excludes every status that has left the operator's hands", () => {
    // NEGATIVE CONTROL for the set: naming the excluded statuses explicitly means
    // adding one to OPEN_DOCK_STATUSES by mistake fails here rather than silently
    // resurrecting submitted work onto the dock queue.
    for (const done of [
      'expected',
      'submitted',
      'verified',
      'rejected',
      'submitted_to_mymrc',
      'processed',
    ]) {
      expect(OPEN_DOCK_STATUSES, done).not.toContain(done);
    }
  });
});

describe('listOperatorOpenLoads — query shape', () => {
  it('scopes to the signed-in operator AND the site AND open statuses only', async () => {
    await listOperatorOpenLoads(SITE, OP);
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({
      site_id: SITE,
      assigned_operator_id: OP,
      status: { in: [...OPEN_DOCK_STATUSES] },
    });
  });

  it('applies NO date bound — unfinished work is not a "historical view"', async () => {
    // THE REGRESSION GUARD. The ADR-0065 D5 current-Pacific-day floor is correct
    // for BROWSING expected loads and wrong for your own open load: applying it is
    // what hid the 2026-07-29 `arrived` load and the 2026-08-05-parented one. If
    // someone later "makes this consistent" by adding a window, this fails.
    await listOperatorOpenLoads(SITE, OP);
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['arrived_at']).toBeUndefined();
    expect(Object.keys(where).sort()).toEqual(['assigned_operator_id', 'site_id', 'status']);
  });

  it('does NOT filter on the parent expected load being live', async () => {
    // The `finished` Woodland load had 3 units counted and its parent expected row
    // was CANCELLED at 4:00 PM PDT the same day, so any join through
    // `expected_load.cancelled_at: null` would drop it again.
    await listOperatorOpenLoads(SITE, OP);
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['expected_load']).toBeUndefined();
    expect(where['expected_load_id']).toBeUndefined();
  });

  it('orders oldest-first so the most stale unfinished load is at the top', async () => {
    await listOperatorOpenLoads(SITE, OP);
    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual({
      arrived_at: { sort: 'asc', nulls: 'last' },
    });
  });
});

describe('listOperatorOpenLoads — projection', () => {
  it('flags a finished load as ready to submit and passes the count through', async () => {
    findMany.mockResolvedValue([
      {
        id: 'load-finished',
        status: 'finished',
        arrived_at: new Date('2026-07-29T14:30:54.155Z'),
        bol_number: null,
        total_units: 3,
        source: { name: 'Humboldt Sanitation' },
        transporter: null,
      },
    ]);
    const [row] = await listOperatorOpenLoads(SITE, OP);
    expect(row?.readyToSubmit).toBe(true);
    expect(row?.totalUnits).toBe(3);
    expect(row?.sourceName).toBe('Humboldt Sanitation');
    // A missing transporter must be null, not the string "null" or undefined —
    // the view substitutes a translated fallback.
    expect(row?.transporterName).toBeNull();
  });

  it('does NOT flag a mid-workflow load as ready to submit', async () => {
    findMany.mockResolvedValue([
      {
        id: 'load-arrived',
        status: 'arrived',
        arrived_at: new Date('2026-07-29T16:49:14.348Z'),
        bol_number: null,
        total_units: null,
        source: { name: 'Kiefer Landfill' },
        transporter: null,
      },
    ]);
    const [row] = await listOperatorOpenLoads(SITE, OP);
    expect(row?.readyToSubmit).toBe(false);
    expect(row?.totalUnits).toBeNull();
  });

  it('preserves arrivedAt as a Date instant (the view pins the zone, not this layer)', async () => {
    const instant = new Date('2026-07-28T19:55:10.516Z');
    findMany.mockResolvedValue([
      {
        id: 'l',
        status: 'arrived',
        arrived_at: instant,
        bol_number: 'B-1',
        total_units: null,
        source: null,
        transporter: null,
      },
    ]);
    const [row] = await listOperatorOpenLoads(SITE, OP);
    expect(row?.arrivedAt?.toISOString()).toBe(instant.toISOString());
  });
});
