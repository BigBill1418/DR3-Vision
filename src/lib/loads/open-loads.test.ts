// ADR-0065 Amendment 1 + ADR-0082 — the site's unfinished dock loads.
//
// The load-bearing property ADR-0065 Am.1 established: an operator can always get
// back to a load THEY started, no matter what day its parent expected row falls on
// and no matter whether that parent was cancelled. Those two filters are precisely
// what stranded three production loads at Woodland on 2026-07-30, one of them
// counted and never submitted. Every guard for that survives below.
//
// ADR-0082 widened the query from the operator's OWN loads to the SITE's, split by
// holder — because the operator-scope was itself a stranding: a load whose holder
// had gone to lunch appeared on nobody's screen but theirs, and production held
// NINE of those across five operators on 2026-08-08. The `assigned_operator_id`
// predicate is therefore GONE from the WHERE and asserted absent, which is a
// deliberate reversal recorded in ADR-0082, not an eroded guard.
//
// These assertions are about the QUERY SHAPE, because that is where the defect
// lived — the previous behavior was not a wrong result, it was no query at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above every `const` in this file, so the factory cannot
// close over a plain top-level variable (ReferenceError at collect time).
// `vi.hoisted` lifts the spy alongside it.
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { inboundLoad: { findMany } } }));

import { listSiteOpenLoads, OPEN_DOCK_STATUSES } from './open-loads';

const SITE = 'site-woodland';
const OP = 'user-morena';
const OTHER = 'user-juan';

/** A row in the shape the `select` above produces. */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'load-1',
    status: 'arrived',
    arrived_at: new Date('2026-07-28T19:55:10.516Z'),
    bol_number: null,
    total_units: null,
    assigned_operator_id: OP,
    source: null,
    transporter: null,
    assigned_operator: { id: OP, name: 'Morena Gomez' },
    ...over,
  };
}

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

describe('listSiteOpenLoads — query shape', () => {
  it('scopes to the SITE and open statuses, and no longer to one operator', async () => {
    await listSiteOpenLoads(SITE, OP);
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({
      site_id: SITE,
      status: { in: [...OPEN_DOCK_STATUSES] },
    });
  });

  it('carries NO assigned_operator_id predicate (ADR-0082 — that filter WAS the stranding)', async () => {
    // The reversal, asserted as its own claim. Re-adding the operator predicate
    // "for consistency with the old behaviour" would silently restore the state
    // where nine open loads were visible to nobody but their absent holders.
    await listSiteOpenLoads(SITE, OP);
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['assigned_operator_id']).toBeUndefined();
  });

  it('applies NO date bound — unfinished work is not a "historical view"', async () => {
    // THE REGRESSION GUARD. The ADR-0065 D5 current-Pacific-day floor is correct
    // for BROWSING expected loads and wrong for an open load: applying it is what
    // hid the 2026-07-29 `arrived` load and the 2026-08-05-parented one. If
    // someone later "makes this consistent" by adding a window, this fails.
    await listSiteOpenLoads(SITE, OP);
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['arrived_at']).toBeUndefined();
    expect(Object.keys(where).sort()).toEqual(['site_id', 'status']);
  });

  it('does NOT filter on the parent expected load being live', async () => {
    // The `finished` Woodland load had 3 units counted and its parent expected row
    // was CANCELLED at 4:00 PM PDT the same day, so any join through
    // `expected_load.cancelled_at: null` would drop it again.
    await listSiteOpenLoads(SITE, OP);
    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['expected_load']).toBeUndefined();
    expect(where['expected_load_id']).toBeUndefined();
  });

  it('orders oldest-first so the most stale unfinished load is at the top', async () => {
    await listSiteOpenLoads(SITE, OP);
    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual({
      arrived_at: { sort: 'asc', nulls: 'last' },
    });
  });

  it('issues ONE query for both lists', async () => {
    // Two queries could observe two different instants, so a load taken over
    // between them would land in both lists or in neither. The split is in memory
    // over a single result set precisely to make that impossible.
    await listSiteOpenLoads(SITE, OP);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe('listSiteOpenLoads — the mine / held-by-others split', () => {
  it("puts the viewer's own loads in `mine` and everyone else's in `heldByOthers`", async () => {
    findMany.mockResolvedValue([
      row({ id: 'mine-1' }),
      row({
        id: 'juans-1',
        assigned_operator_id: OTHER,
        assigned_operator: { id: OTHER, name: 'Juan Perez' },
      }),
    ]);
    const { mine, heldByOthers } = await listSiteOpenLoads(SITE, OP);
    expect(mine.map((r) => r.id)).toEqual(['mine-1']);
    expect(heldByOthers.map((r) => r.id)).toEqual(['juans-1']);
  });

  it('names the holder — the one fact the floor could not see before', async () => {
    findMany.mockResolvedValue([
      row({
        id: 'juans-1',
        assigned_operator_id: OTHER,
        assigned_operator: { id: OTHER, name: 'Juan Perez' },
      }),
    ]);
    const { heldByOthers } = await listSiteOpenLoads(SITE, OP);
    expect(heldByOthers[0]?.claimedByName).toBe('Juan Perez');
    expect(heldByOthers[0]?.claimedByUserId).toBe(OTHER);
  });

  it('treats an UNASSIGNED load as held by others, not as the viewer’s own', async () => {
    // `assigned_operator_id` is nullable. `null === viewerUserId` is false, so an
    // unassigned row lands in `heldByOthers` and is offered for takeover — which
    // is the right home for it. The dangerous failure would be the other way
    // round: an unassigned load appearing under "your unfinished loads" and being
    // driven by someone the claim does not name.
    findMany.mockResolvedValue([
      row({ id: 'orphan', assigned_operator_id: null, assigned_operator: null }),
    ]);
    const { mine, heldByOthers } = await listSiteOpenLoads(SITE, OP);
    expect(mine).toEqual([]);
    expect(heldByOthers[0]?.claimedByName).toBeNull();
  });
});

describe('listSiteOpenLoads — projection', () => {
  it('flags a finished load as ready to submit and passes the count through', async () => {
    findMany.mockResolvedValue([
      row({
        id: 'load-finished',
        status: 'finished',
        arrived_at: new Date('2026-07-29T14:30:54.155Z'),
        total_units: 3,
        source: { name: 'Humboldt Sanitation' },
      }),
    ]);
    const [r] = (await listSiteOpenLoads(SITE, OP)).mine;
    expect(r?.readyToSubmit).toBe(true);
    expect(r?.totalUnits).toBe(3);
    expect(r?.sourceName).toBe('Humboldt Sanitation');
    // A missing transporter must be null, not the string "null" or undefined —
    // the view substitutes a translated fallback.
    expect(r?.transporterName).toBeNull();
  });

  it('does NOT flag a mid-workflow load as ready to submit', async () => {
    findMany.mockResolvedValue([
      row({ id: 'load-arrived', status: 'arrived', source: { name: 'Kiefer Landfill' } }),
    ]);
    const [r] = (await listSiteOpenLoads(SITE, OP)).mine;
    expect(r?.readyToSubmit).toBe(false);
    expect(r?.totalUnits).toBeNull();
  });

  it('preserves arrivedAt as a Date instant (the view pins the zone, not this layer)', async () => {
    const instant = new Date('2026-07-28T19:55:10.516Z');
    findMany.mockResolvedValue([row({ arrived_at: instant, bol_number: 'B-1' })]);
    const [r] = (await listSiteOpenLoads(SITE, OP)).mine;
    expect(r?.arrivedAt?.toISOString()).toBe(instant.toISOString());
  });
});
