// BS-8 / BS-9 — `startBalance` was a SECOND implementation of `onHand`.
//
// ADR-0037 D6's stated premise is "ONE shared function … never two competing
// spreadsheet sums". There were two, and they disagreed in three ways, each of
// which changes a billing number:
//
//   1. the anchor selector lacked the ADR-0078 D1 `created_at` tiebreak, so on a
//      two-count day the audit could roll forward from a DIFFERENT anchor than the
//      balance it was auditing (BS-9). Woodland has exactly such a day: 2026-08-18
//      carries two rows at a byte-identical `snapshot_at`;
//   2. drop-offs were summed BARE, so an untaught `ConsumerDropoffKind` was silently
//      absorbed into the program pool where `onHand` refuses (BS-8);
//   3. it carried a private copy of the verified-inbound status list.
//
// These assert the SHARED implementation through the audit's own entry point, so
// they fail if the two ever diverge again rather than only if this file is edited.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { startBalance } from './leg-fetchers';
import { UnknownDropoffKindError } from '@/lib/inventory/running-balance';
import type { AuditWindow } from './types';

const SITE = 'site-woodland';
const WINDOW: AuditWindow = {
  siteId: SITE,
  startISO: '2026-08-20',
  endISO: '2026-08-22',
} as AuditWindow;

/** The two same-instant physical counts that exist in production on 2026-08-18. */
const SAME_INSTANT = new Date('2026-08-18T07:00:00.000Z');

interface Scenario {
  snapshots?: Record<string, unknown>[];
  dropoffs?: Record<string, unknown>[];
}

/**
 * A fake client narrow to what `startBalance` touches. Deliberately hand-rolled
 * rather than reusing the 650-line engine in `leg-fetchers.test.ts`: the property
 * under test is the ORDERING of two rows that tie on the primary key, and a fake
 * that silently ignores a secondary sort would make this test pass on the defect.
 */
function fakeDb(s: Scenario): PrismaClient {
  const snapshots = s.snapshots ?? [];
  const dropoffs = s.dropoffs ?? [];
  const emptySum = { _sum: {} as Record<string, number | null> };
  return {
    siteInventorySnapshot: {
      findFirst: vi.fn(async (args: { orderBy?: unknown }) => {
        const ob = args.orderBy;
        // The whole point: honour an ARRAY orderBy. A single-key sort over two
        // equal `snapshot_at` values returns whichever came first in the array,
        // which is how the defect hid.
        const keys: [string, string][] = Array.isArray(ob)
          ? ob.map((o) => Object.entries(o as Record<string, string>)[0]!)
          : ob
            ? [Object.entries(ob as Record<string, string>)[0]!]
            : [];
        const sorted = [...snapshots].sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = (a[k] as Date).getTime();
            const bv = (b[k] as Date).getTime();
            if (av !== bv) return dir === 'desc' ? bv - av : av - bv;
          }
          return 0;
        });
        return sorted[0] ?? null;
      }),
    },
    consumerDropoff: {
      groupBy: vi.fn(async () => dropoffs),
      aggregate: vi.fn(async () => ({ _sum: { units: null } })),
    },
    inboundLoad: { aggregate: vi.fn(async () => emptySum) },
    processedUnitsDaily: { aggregate: vi.fn(async () => emptySum) },
    outboundMaterial: { aggregate: vi.fn(async () => emptySum) },
    landfilledUnit: { aggregate: vi.fn(async () => emptySum) },
  } as unknown as PrismaClient;
}

function snapshot(over: Record<string, unknown>): Record<string, unknown> {
  return {
    snapshot_at: SAME_INSTANT,
    created_at: SAME_INSTANT,
    units_indoor: 0,
    units_total: null,
    units_in_processing: 0,
    program_units: null,
    non_program_units: null,
    pool_attribution: 'legacy',
    ...over,
  };
}

describe('BS-9 — the audit anchors on the LAST-ENTERED of two same-instant counts', () => {
  it('picks the later `created_at` when `snapshot_at` ties', async () => {
    // Production's real shape, with the void removed so both are eligible: one
    // count entered at 14:55 and superseded at 16:59 the same morning.
    const db = fakeDb({
      snapshots: [
        snapshot({
          created_at: new Date('2026-08-19T14:55:42.516Z'),
          units_indoor: 923,
          pool_attribution: 'legacy',
        }),
        snapshot({
          created_at: new Date('2026-08-19T16:59:40.760Z'),
          units_indoor: 923,
          program_units: 201,
          non_program_units: 722,
          pool_attribution: 'measured',
        }),
      ],
    });
    const start = await startBalance(db, WINDOW);
    // The measured row is the one entered last. Anchoring on the legacy row would
    // attribute all 923 units to the PROGRAM pool — a 722-unit mis-billing.
    expect(String(start.program)).toBe('201');
    expect(String(start.nonProgram)).toBe('722');
  });

  it('NEGATIVE CONTROL — reversing the insertion order does not change the answer', async () => {
    // Without the tiebreak this passes on one array order and fails on the other,
    // which is exactly how a planner-dependent defect hides in a test suite.
    const db = fakeDb({
      snapshots: [
        snapshot({
          created_at: new Date('2026-08-19T16:59:40.760Z'),
          units_indoor: 923,
          program_units: 201,
          non_program_units: 722,
          pool_attribution: 'measured',
        }),
        snapshot({
          created_at: new Date('2026-08-19T14:55:42.516Z'),
          units_indoor: 923,
          pool_attribution: 'legacy',
        }),
      ],
    });
    const start = await startBalance(db, WINDOW);
    expect(String(start.program)).toBe('201');
  });
});

describe('BS-8 — the audit REFUSES an untaught drop-off kind, as onHand does', () => {
  it('throws UnknownDropoffKindError rather than absorbing it into the program pool', async () => {
    const db = fakeDb({
      snapshots: [snapshot({ units_indoor: 100 })],
      dropoffs: [{ kind: 'a_kind_nobody_taught_us', _sum: { units: 5000 } }],
    });
    await expect(startBalance(db, WINDOW)).rejects.toBeInstanceOf(UnknownDropoffKindError);
  });

  it('sums a TAUGHT kind normally — the positive control', async () => {
    const db = fakeDb({
      snapshots: [snapshot({ units_indoor: 100 })],
      dropoffs: [{ kind: 'floor_public', _sum: { units: 7 } }],
    });
    const start = await startBalance(db, WINDOW);
    expect(String(start.program)).toBe('107');
  });
});
