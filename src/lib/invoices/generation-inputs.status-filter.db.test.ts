// P1-1 (audit 2026-07-21) — the transportation-invoice DB-fetch filter.
//
// `resolveTransportationInputs` under-billed freight + CA fuel surcharge because
// it filtered inbound loads on `status: 'verified'` EXACTLY, silently dropping
// `submitted_to_mymrc` / `processed` loads that the MRC Monthly Invoice export
// (`exports/mrc`, via `INVOICE_STATUSES`) already treats as billing-ready. The
// fix routes the fetch through that single canonical set. This is the missing
// DB-fetch-layer coverage: seed a load in EVERY `LoadStatus`, run the real fetch,
// and assert exactly the billing-ready statuses reach the freight AND fuel legs.
//
// The repo has no test Postgres (see site-alias.db.test.ts). We mock the
// `@/lib/prisma` singleton with a faithful in-memory `inboundLoad.findMany` that
// honours the actual `where` clause the function builds — so a regression back to
// `status: 'verified'` (or any drift from `INVOICE_STATUSES`) fails this test.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { LoadStatus } from '@prisma/client';
import { INVOICE_STATUSES } from '@/lib/exports';

interface SeedLoad {
  id: string;
  site_id: string;
  transport_charged: boolean;
  status: string;
  arrived_at: Date;
  source_id: string;
  source: { canonical_mileage: number | null };
}

interface LoadWhere {
  site_id?: string;
  transport_charged?: boolean;
  status?: string | { in: readonly string[] };
  arrived_at?: { gte?: Date; lt?: Date };
}

const store = vi.hoisted(() => ({ loads: [] as SeedLoad[] }));

// Faithful in-memory emulation of the Prisma filter the fetch relies on:
// site_id + transport_charged equality, `status: { in: [...] }` membership, and
// the arrived_at `[gte, lt)` half-open window. Anything the real query would
// exclude, this excludes too — that is what makes the assertion meaningful.
function matches(load: SeedLoad, where: LoadWhere): boolean {
  if (where.site_id !== undefined && load.site_id !== where.site_id) return false;
  if (where.transport_charged !== undefined && load.transport_charged !== where.transport_charged) {
    return false;
  }
  const st = where.status;
  if (typeof st === 'string') {
    if (load.status !== st) return false;
  } else if (st && !st.in.includes(load.status)) {
    return false;
  }
  const at = where.arrived_at;
  if (at) {
    const t = load.arrived_at.getTime();
    if (at.gte && t < at.gte.getTime()) return false;
    if (at.lt && t >= at.lt.getTime()) return false;
  }
  return true;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboundLoad: {
      findMany: vi.fn(async (args: { where: LoadWhere }) =>
        store.loads.filter((l) => matches(l, args.where)),
      ),
    },
    // No rentals for this test — keeps the assertion on the load-status filter.
    containerRentalSite: { findMany: vi.fn(async () => []) },
  },
}));

// Resolvers are exercised elsewhere; here they are fixed stubs so freight/fuel
// membership is decided solely by which loads the status filter admits.
vi.mock('@/lib/billing-rates/freight-resolver', () => ({
  resolveFreightCents: vi.fn(async () => ({ cents: 55650, ref: { kind: 'tier', id: 't1' } })),
}));
vi.mock('@/lib/billing-rates/fuel', () => ({
  computeFuelSurchargeCents: vi.fn(async () => ({
    cents: 5105,
    applied: true,
    ref: { kind: 'fuel', id: 'f1' },
  })),
}));
vi.mock('./event-leg', () => ({ fetchEventCostRows: vi.fn(async () => []) }));

// Imported AFTER the mocks are registered (vi.mock is hoisted regardless).
import { resolveTransportationInputs } from './generation-inputs';

const SITE = 'site-woodland';
// mid-window noon UTC — safely inside the Pacific-day window for June 2026.
const ARRIVED = new Date('2026-06-15T12:00:00Z');

function seedAllStatuses(): void {
  store.loads = Object.values(LoadStatus).map(
    (status): SeedLoad => ({
      id: `load-${status}`,
      site_id: SITE,
      transport_charged: true,
      status,
      arrived_at: ARRIVED,
      source_id: `src-${status}`,
      source: { canonical_mileage: 100 },
    }),
  );
}

describe('resolveTransportationInputs — billing-ready load-status filter (P1-1)', () => {
  beforeEach(() => {
    seedAllStatuses();
  });

  it('admits exactly the INVOICE_STATUSES loads to BOTH the freight and fuel legs', async () => {
    const out = await resolveTransportationInputs({
      siteId: SITE,
      kind: 'ca_transportation_eom',
      billingMonthISO: '2026-06-01',
      windowStartISO: '2026-06-01',
      windowEndISO: '2026-06-30',
    });

    const expected = [...INVOICE_STATUSES].map((s) => `load-${s}`).sort();
    expect(out.freightLoads.map((l) => l.loadId).sort()).toEqual(expected);
    // CA jurisdiction ⇒ the fuel-surcharge path must admit the same set.
    expect(out.fuelLoads.map((l) => l.loadId).sort()).toEqual(expected);
  });

  it('excludes every non-billing-ready status (the drift the fix closes)', async () => {
    const out = await resolveTransportationInputs({
      siteId: SITE,
      kind: 'ca_transportation_eom',
      billingMonthISO: '2026-06-01',
      windowStartISO: '2026-06-01',
      windowEndISO: '2026-06-30',
    });

    const billed = new Set(out.freightLoads.map((l) => l.loadId));
    const nonBillingReady = Object.values(LoadStatus).filter(
      (s) => !([...INVOICE_STATUSES] as string[]).includes(s),
    );
    for (const status of nonBillingReady) {
      expect(billed.has(`load-${status}`)).toBe(false);
    }
    // Guards against the original bug: post-verified loads (the ~$61k June
    // Woodland shape) must NOT be dropped now that they are billing-ready.
    expect(billed.has('load-submitted_to_mymrc')).toBe(true);
    expect(billed.has('load-processed')).toBe(true);
  });
});
