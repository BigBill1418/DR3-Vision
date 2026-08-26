// OPEN-ITEMS §0.BO / BO-4 — the instrument that makes an uncharged third-party
// haul visible.
//
// What these tests are FOR: this line will appear every weekday morning until
// somebody classifies the sources, so a false positive is not a cosmetic bug —
// it is the thing that trains a reader to skip the warning block. The predicate
// therefore has to be exactly right about who it counts, and every negative case
// below is a class it must refuse to flag.

import { describe, it, expect, vi } from 'vitest';
import {
  scanUnchargedThirdPartyFreight,
  unchargedThirdPartyFreightWarning,
  UNCHARGED_FREIGHT_WINDOW_DAYS,
} from './uncharged-freight';

/** 2026-08-25 17:00 PDT. */
const NOW = new Date('2026-08-26T00:00:00.000Z');

type Row = { total_units: number | null; transporter: { name: string } | null };

/**
 * The shape of the `where` these tests read back off the fake.
 *
 * Written out rather than inferred: `vi.fn(async () => rows)` infers a ZERO-ARG
 * mock, which types `mock.calls[0][0]` as `never` and quietly turns every
 * predicate assertion below into a check on a value TypeScript believes cannot
 * exist. Naming the argument is what keeps those assertions about the query.
 */
type FindManyArgs = {
  where?: {
    transport_charged?: boolean;
    status?: { in?: string[] };
    arrived_at?: { gte?: Date };
    transporter?: { is_internal?: boolean };
  };
  select?: Record<string, unknown>;
};

/**
 * A fake that RECORDS the `where` it was handed, so the tests can assert the
 * predicate itself rather than only the arithmetic over whatever the fake chose
 * to return. A fake that answers a question it was never asked is how a filter
 * test passes on a filter that does not exist.
 */
function fakeDb(rows: Row[]) {
  // The TYPE is on the mock, not on an unused parameter: `vi.fn` records every
  // call regardless of the declared signature, and what the assertions below
  // need is for `mock.calls[0][0]` to be typed as the query rather than `never`.
  const findMany = vi.fn<(args: FindManyArgs) => Promise<Row[]>>(async () => rows);
  return {
    db: { inboundLoad: { findMany } } as unknown as Parameters<
      typeof scanUnchargedThirdPartyFreight
    >[0],
    findMany,
  };
}

const ron = (units: number | null = 135): Row => ({
  total_units: units,
  transporter: { name: 'Ron Lawrence & Son' },
});

describe('scanUnchargedThirdPartyFreight — the predicate', () => {
  it('asks for THIRD-PARTY carriers only, via the relation', () => {
    // `is_internal: false` on the relation, not `transporter_id: { not: null }`.
    // The 637 aggregate and paper rows name no truck at all and are not evidence
    // of an uncharged haul; a `not: null` filter would count them.
    const { db, findMany } = fakeDb([]);
    void scanUnchargedThirdPartyFreight(db, NOW);
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where?.transporter).toEqual({ is_internal: false });
    expect(where?.transport_charged).toBe(false);
  });

  it('counts only BILLING-READY statuses', async () => {
    // A rejected or voided load is not a delivery and has no freight leg to be
    // missing. Counting one would be a false finding on a line that repeats
    // daily.
    const { db, findMany } = fakeDb([]);
    await scanUnchargedThirdPartyFreight(db, NOW);
    const statuses = findMany.mock.calls[0]?.[0]?.where?.status?.in ?? [];
    expect(statuses).toEqual(['submitted', 'verified', 'submitted_to_mymrc', 'processed']);
    expect(statuses).not.toContain('voided');
    expect(statuses).not.toContain('rejected');
  });

  it('bounds the window to the trailing Pacific month, not all time', async () => {
    const scan = await scanUnchargedThirdPartyFreight(fakeDb([]).db, NOW);
    expect(scan.windowDays).toBe(UNCHARGED_FREIGHT_WINDOW_DAYS);
    expect(scan.sinceDayISO).toBe('2026-07-26');
  });

  it('sums units and names the distinct carriers, sorted', async () => {
    const scan = await scanUnchargedThirdPartyFreight(
      fakeDb([
        ron(135),
        ron(112),
        { total_units: 40, transporter: { name: 'Titan Concepts International' } },
      ]).db,
      NOW,
    );
    expect(scan.loads).toBe(3);
    expect(scan.units).toBe(287);
    expect(scan.carriers).toEqual(['Ron Lawrence & Son', 'Titan Concepts International']);
  });

  it('treats a null unit count as zero units, not as zero loads', async () => {
    // The load still happened and the freight leg is still missing; only the
    // units are unknown. Dropping the row would understate the finding.
    const scan = await scanUnchargedThirdPartyFreight(fakeDb([ron(null)]).db, NOW);
    expect(scan.loads).toBe(1);
    expect(scan.units).toBe(0);
  });
});

describe('unchargedThirdPartyFreightWarning — the digest line', () => {
  it('says NOTHING when there is nothing to say', async () => {
    // A clean month must not produce a line. A warning that is always present is
    // a warning nobody reads.
    expect(await unchargedThirdPartyFreightWarning(fakeDb([]).db, NOW)).toBeNull();
  });

  it('names the count, the units and the carriers, and points at the remedy', async () => {
    const line = await unchargedThirdPartyFreightWarning(fakeDb([ron(135), ron(112)]).db, NOW);
    expect(line).toContain('2 loads');
    expect(line).toContain('247 units');
    expect(line).toContain('Ron Lawrence & Son');
    expect(line).toContain('/admin/sources');
    // It must NOT assert that money is owed. Whether these hauls carry a DR3
    // freight leg at all is Bill's open decision (§0.BO BO-4) — the line reports
    // that Vision cannot say, which is the true and useful claim.
    expect(line).toContain('Either these hauls genuinely carry no');
  });

  it('truncates a long carrier list rather than running to a paragraph', async () => {
    const rows = ['A Co', 'B Co', 'C Co', 'D Co', 'E Co'].map((name) => ({
      total_units: 1,
      transporter: { name },
    }));
    const line = await unchargedThirdPartyFreightWarning(fakeDb(rows).db, NOW);
    expect(line).toContain('A Co, B Co, C Co and 2 more');
  });

  it('uses singular grammar for one load', async () => {
    const line = await unchargedThirdPartyFreightWarning(fakeDb([ron(1)]).db, NOW);
    expect(line).toContain('1 load in the last');
  });
});
