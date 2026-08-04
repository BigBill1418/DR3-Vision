// ADR-0075 D5 — the seed must never resurrect a merged loser.
//
// `scripts/seed-equipment-master.mjs` keys its idempotency on
// `(site_id, display_name)`, and a merged loser KEEPS its name — nothing in the
// registry is ever renamed or deleted. So the naive lookup finds the loser by
// name and writes `is_active = true` straight back onto it, silently re-splitting
// the rows an admin just merged and putting the duplicate back in front of every
// AP approver.
//
// This is not hypothetical: the moment Bill merges the three Woodland Terex rows
// (docs/OPEN-ITEMS.md O-10), the next seed run is exactly this scenario.
//
// The prisma client is injected, so this touches no database.

import { describe, it, expect, vi } from 'vitest';
import { resolveSeedTarget, MERGED_TARGET_MISSING } from '../../scripts/seed-equipment-master.mjs';

const WOODLAND = 'site-woodland';

interface Row {
  id: string;
  site_id: string;
  display_name: string;
  category: string;
  is_active: boolean;
  merged_into_id: string | null;
}

function db(rows: Row[]) {
  return {
    equipment: {
      findFirst: vi.fn(
        async ({ where }: { where: { site_id: string; display_name: string } }) =>
          rows.find((r) => r.site_id === where.site_id && r.display_name === where.display_name) ??
          null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      ),
    },
  };
}

const winner: Row = {
  id: 'eq-winner',
  site_id: WOODLAND,
  display_name: 'Terex Machine',
  category: 'terex',
  is_active: true,
  merged_into_id: null,
};
const loser: Row = {
  id: 'eq-loser',
  site_id: WOODLAND,
  display_name: 'Terex machine',
  category: 'terex',
  is_active: false,
  merged_into_id: 'eq-winner',
};

describe('resolveSeedTarget — the resurrection guard', () => {
  it('FOLLOWS merged_into_id: a name that matches a merged loser resolves to the SURVIVOR', async () => {
    const target = await resolveSeedTarget(db([winner, loser]), WOODLAND, 'Terex machine');

    // The bug this prevents: returning `eq-loser` here means the seed's update
    // branch writes is_active=true onto a merged row and un-does the merge.
    expect(target).toMatchObject({ id: 'eq-winner', is_active: true });
    expect((target as Row).id).not.toBe('eq-loser');
  });

  it('returns the row itself when it was never merged', async () => {
    const target = await resolveSeedTarget(db([winner, loser]), WOODLAND, 'Terex Machine');
    expect(target).toMatchObject({ id: 'eq-winner' });
  });

  it('returns null for a name that is not in the registry — the create branch', async () => {
    expect(await resolveSeedTarget(db([winner]), WOODLAND, 'Brand New Baler')).toBeNull();
  });

  it('SKIPS rather than resurrects when the survivor is missing', async () => {
    // Unreachable through the app (`onDelete: Restrict` forbids deleting a
    // survivor), so this means data damage — and falling back to the loser would
    // quietly reactivate a row nobody decided to bring back.
    const orphaned = { ...loser, merged_into_id: 'eq-gone' };
    expect(await resolveSeedTarget(db([orphaned]), WOODLAND, 'Terex machine')).toBe(
      MERGED_TARGET_MISSING,
    );
  });

  it('does not walk a second hop — merge chains are refused at the API, not traversed here', async () => {
    const midway: Row = { ...loser, id: 'eq-mid', merged_into_id: 'eq-winner' };
    const chained: Row = {
      id: 'eq-tail',
      site_id: WOODLAND,
      display_name: 'terex MACHINE',
      category: 'terex',
      is_active: false,
      merged_into_id: 'eq-mid',
    };
    const target = await resolveSeedTarget(
      db([winner, midway, chained]),
      WOODLAND,
      'terex MACHINE',
    );
    expect((target as Row).id).toBe('eq-mid');
  });
});
