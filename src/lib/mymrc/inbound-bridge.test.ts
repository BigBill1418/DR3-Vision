// ADR-0059 D1/D2/D3 — hauls → inventory INBOUND bridge tests. Same repo idiom as
// processed-bridge.test.ts: an in-memory FAKE PrismaClient (no test Postgres). The fake
// faithfully emulates the money-safe `ON CONFLICT (site_id, arrived_at) WHERE
// load_source_type IN ('paper_bulk','mymrc_haul') DO UPDATE … WHERE
// load_source_type='mymrc_haul' AND (values IS DISTINCT FROM …)` upsert so idempotency
// and precedence are exercised through realistic upsert semantics, not just the JS
// pre-check. (The raw SQL guard's race-safety is additionally proven live on prod via the
// R4/R5 invariants.)
//
// The load-bearing DIVERGENCES from the processed bridge get explicit assertions:
//   - Delivered-only (Confirmed/Rejected excluded);
//   - disappeared_at is NOT excluded (the single most important inversion);
//   - General-only (Consumer Dropoff excluded);
//   - undated hauls skipped + counted.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { pacificMidnightInstantOfDayISO } from '@/lib/time';
import { bridgeInboundHaulsToInventory, findDatelessDeliveredHauls } from './inbound-bridge';

// ── in-memory store + fake ────────────────────────────────────────────────

interface MirrorRow {
  site_id: string | null;
  docking_appointment_date: Date | null;
  recycler_reported_delivery_date: Date | null; // ADR-0089 Am.1 — the true delivery date
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  status: string | null;
  type: string | null;
  disappeared_at: Date | null;
}
interface InboundRow {
  id: string;
  site_id: string;
  arrived_at: Date;
  load_source_type: string;
  total_units: number;
  program_unit_count: number;
  non_program_unit_count: number;
}
interface AuditRow {
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  after: unknown;
}
interface Store {
  mirror: MirrorRow[];
  inbound: Map<string, InboundRow>; // keyed `${site_id}|${arrived_at epoch}`
  audit: AuditRow[];
  // ADR-0060 D5 — verified per-load (b2b_haul) dock rows the per-load guard reads.
  perLoad: Array<{ site_id: string; arrived_at: Date; load_source_type: string; status: string }>;
}

/** A noon-stamped delivery date (how the mapper stores Salesforce date-only fields). */
const noon = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`);
/** The Pacific-midnight instant the bridge keys arrived_at to for a delivery day. */
const arrivedFor = (iso: string): Date => pacificMidnightInstantOfDayISO(iso);
const keyOf = (siteId: string, arrivedAt: Date): string => `${siteId}|${arrivedAt.getTime()}`;

function mirror(over: Partial<MirrorRow> = {}): MirrorRow {
  return {
    site_id: 'woodland',
    docking_appointment_date: noon('2026-07-20'),
    // Null by default: pre-Am.1 rows have no recycler date, so the existing test
    // corpus ALSO proves the appointment-date fallback path byte-for-byte.
    recycler_reported_delivery_date: null,
    program_unit_count: null,
    non_program_unit_count: null,
    status: 'Delivered',
    type: 'General',
    disappeared_at: new Date('2026-07-21T00:00:00Z'), // stamped by default — the norm for hauls
    ...over,
  };
}

function inbound(over: Partial<InboundRow> & { arrived_at: Date }): InboundRow {
  return {
    id: `il-${over.site_id ?? 'woodland'}-${over.arrived_at.getTime()}`,
    site_id: 'woodland',
    load_source_type: 'mymrc_haul',
    total_units: 0,
    program_unit_count: 0,
    non_program_unit_count: 0,
    ...over,
  };
}

function store(over: Partial<Store> = {}): Store {
  return { mirror: [], inbound: new Map(), audit: [], perLoad: [], ...over };
}

/** A where-matcher for exactly the mirror filters the bridge uses (NO disappeared_at). */
function mirrorMatches(r: MirrorRow, where: Record<string, unknown>): boolean {
  if (where['status'] !== undefined && r.status !== where['status']) return false;
  if (where['type'] !== undefined && r.type !== where['type']) return false;
  const sid = where['site_id'] as { not?: unknown; in?: string[] } | undefined;
  if (sid) {
    if ('not' in sid && sid.not === null && r.site_id === null) return false;
    if (Array.isArray(sid.in) && (r.site_id === null || !sid.in.includes(r.site_id))) return false;
  }
  return true;
}

function fakePrisma(s: Store): PrismaClient {
  const tx = {
    // ADR-0120 — the workbook-promotion site lock. A fake cannot take a
    // real advisory lock, so this accepts it and does nothing. What the lock
    // actually does — block a concurrent floor write at the SAME site, and
    // not block a different site — is a Postgres property, proven in
    // `src/lib/audit/promotion-lock.db.test.ts`. No-op-ing it here keeps this
    // suite measuring the behaviour it is actually about.
    $executeRaw: async () => 0,
    $queryRawUnsafe: async (
      _sql: string,
      id: string,
      siteId: string,
      arrivedIso: string,
      total: number,
      prog: number,
      nprog: number,
    ) => {
      const arrivedAt = new Date(arrivedIso);
      const key = keyOf(siteId, arrivedAt);
      const existing = s.inbound.get(key);
      if (!existing) {
        s.inbound.set(key, {
          id,
          site_id: siteId,
          arrived_at: arrivedAt,
          load_source_type: 'mymrc_haul',
          total_units: total,
          program_unit_count: prog,
          non_program_unit_count: nprog,
        });
        return [{ id, inserted: true }];
      }
      // Guard: only touch a mymrc_haul row whose values actually differ.
      if (
        existing.load_source_type === 'mymrc_haul' &&
        (existing.program_unit_count !== prog || existing.non_program_unit_count !== nprog)
      ) {
        existing.total_units = total;
        existing.program_unit_count = prog;
        existing.non_program_unit_count = nprog;
        return [{ id: existing.id, inserted: false }];
      }
      return []; // guard blocked (paper_bulk) OR already-equal
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        s.audit.push(data);
        return { id: `audit-${s.audit.length}` };
      },
    },
  };
  return {
    mymrcHaulsMirror: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        s.mirror.filter((r) => mirrorMatches(r, where)),
    },
    inboundLoad: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const sid = (where['site_id'] as { in: string[] }).in;
        const arrivedAt = where['arrived_at'] as
          | { in: Date[] }
          | { gte: Date; lt: Date }
          | undefined;
        const lst = where['load_source_type'] as { in?: string[]; notIn?: string[] };
        // ADR-0060 D5 per-load preload: notIn aggregate types + arrived_at range window.
        if (lst?.notIn && arrivedAt && 'gte' in arrivedAt) {
          const status = where['status'] as { in: string[] } | undefined;
          return s.perLoad
            .filter(
              (r) =>
                sid.includes(r.site_id) &&
                !lst.notIn!.includes(r.load_source_type) &&
                (!status || status.in.includes(r.status)) &&
                r.arrived_at.getTime() >= arrivedAt.gte.getTime() &&
                r.arrived_at.getTime() < arrivedAt.lt.getTime(),
            )
            .map((r) => ({ site_id: r.site_id, arrived_at: r.arrived_at }));
        }
        // Aggregate preload: arrived_at.in + load_source_type.in.
        const arr = (arrivedAt as { in: Date[] }).in.map((d) => d.getTime());
        return [...s.inbound.values()].filter(
          (r) =>
            sid.includes(r.site_id) &&
            arr.includes(r.arrived_at.getTime()) &&
            (lst.in ? lst.in.includes(r.load_source_type) : true),
        );
      },
    },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    $queryRawUnsafe: tx.$queryRawUnsafe,
    auditLog: tx.auditLog,
  } as unknown as PrismaClient;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('bridgeInboundHaulsToInventory — aggregation', () => {
  it('SUMs multiple Delivered General hauls for one (site, delivery day) into one row', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 100, non_program_unit_count: 5 }),
        mirror({ program_unit_count: 200, non_program_unit_count: 10 }),
        mirror({ program_unit_count: 261, non_program_unit_count: 0 }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({
      daysConsidered: 1,
      inserted: 1,
      updated: 0,
      skippedGuarded: 0,
      unchanged: 0,
      haulsUndated: 0,
    });
    const row = s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!;
    expect(row.program_unit_count).toBe(561);
    expect(row.non_program_unit_count).toBe(15);
    expect(row.total_units).toBe(576);
    expect(row.load_source_type).toBe('mymrc_haul');
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({
      action: 'insert',
      actor_label: 'mymrc-inbound-bridge',
      table_name: 'inbound_loads',
    });
  });

  it('maps the program / non-program split 1:1 and totals them', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 96, non_program_unit_count: 0 })] });
    await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    const row = s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!;
    expect(row.program_unit_count).toBe(96);
    expect(row.non_program_unit_count).toBe(0);
    expect(row.total_units).toBe(96);
  });
});

describe('bridgeInboundHaulsToInventory — source filters (the divergences from ADR-0058)', () => {
  it('Delivered ONLY — a Confirmed (scheduled, count 0) and a Rejected haul are excluded', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 527 }),
        mirror({ program_unit_count: 0, status: 'Confirmed', disappeared_at: null }),
        mirror({ program_unit_count: 999, status: 'Rejected' }),
      ],
    });
    await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      527,
    );
  });

  it('disappeared_at is NOT excluded — a Delivered haul WITH disappeared_at IS summed (INVERSE of the processed bridge)', async () => {
    // This is the single most important divergence from ADR-0058. Delivered hauls scroll
    // off the rolling list, so nearly every real one is disappeared_at-stamped; excluding
    // them (as the processed bridge does) would capture almost nothing. Do NOT "fix" the
    // bridge to filter disappeared_at.
    const s = store({
      mirror: [
        mirror({ program_unit_count: 300, disappeared_at: new Date('2026-07-21T09:00:00Z') }),
        mirror({ program_unit_count: 261, disappeared_at: null }),
      ],
    });
    await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    // BOTH counted — the disappeared row was not dropped.
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      561,
    );
  });

  it('General ONLY — a Delivered Consumer Dropoff haul is excluded (belongs to the dropoff leg)', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 527 }),
        mirror({ program_unit_count: 999, type: 'Consumer Dropoff' }),
      ],
    });
    await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      527,
    );
  });

  it('undated Delivered General hauls are SKIPPED and counted in haulsUndated', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 400 }),
        mirror({ program_unit_count: 111, docking_appointment_date: null }),
        mirror({ program_unit_count: 222, docking_appointment_date: null }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1, haulsUndated: 2 });
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      400,
    );
  });
});

describe('bridgeInboundHaulsToInventory — arrived_at date mapping', () => {
  it('arrived_at = Pacific-midnight of the delivery day (07:00Z in PDT), never crossing a Pacific day', async () => {
    const s = store({
      mirror: [mirror({ docking_appointment_date: noon('2026-07-20'), program_unit_count: 10 })],
    });
    await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    const arrivedAt = arrivedFor('2026-07-20');
    // Cross-validate the module's INLINE replica against @/lib/time's canonical helper.
    expect(arrivedAt.toISOString()).toBe('2026-07-20T07:00:00.000Z');
    expect(s.inbound.has(keyOf('woodland', arrivedAt))).toBe(true);
  });

  it('hauls on different delivery days key to different arrived_at slots', async () => {
    const s = store({
      mirror: [
        mirror({ docking_appointment_date: noon('2026-07-20'), program_unit_count: 5 }),
        mirror({ docking_appointment_date: noon('2026-07-21'), program_unit_count: 7 }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res.daysConsidered).toBe(2);
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(5);
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-21')))!.program_unit_count).toBe(7);
  });
});

describe('bridgeInboundHaulsToInventory — idempotency (double-count-proof)', () => {
  it('a second run on the same mirror is a no-op — identical values, reported unchanged, no new audit', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 561 })] });
    const prisma = fakePrisma(s);
    const first = await bridgeInboundHaulsToInventory({ prisma });
    expect(first).toMatchObject({ inserted: 1, unchanged: 0 });
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      561,
    );
    expect(s.audit).toHaveLength(1);

    const second = await bridgeInboundHaulsToInventory({ prisma });
    expect(second).toMatchObject({
      daysConsidered: 1,
      inserted: 0,
      updated: 0,
      unchanged: 1,
      skippedGuarded: 0,
    });
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      561,
    ); // NOT 1122
    expect(s.audit).toHaveLength(1); // no second audit row
  });

  it('re-run after the portal revises a day UPDATES to the new absolute value (no increment)', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 500 })] });
    const prisma = fakePrisma(s);
    await bridgeInboundHaulsToInventory({ prisma });
    s.mirror = [mirror({ program_unit_count: 520 })]; // portal revises upward
    const res = await bridgeInboundHaulsToInventory({ prisma });
    expect(res).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      520,
    ); // absolute, not 1020
    expect(s.audit).toHaveLength(2); // insert + update
  });
});

describe('bridgeInboundHaulsToInventory — precedence (a paper_bulk/confirmed row always wins)', () => {
  it('leaves a paper_bulk row BYTE-IDENTICAL, counts it skippedGuarded, writes no audit, one aggregate row remains', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 561 })] });
    const arrivedAt = arrivedFor('2026-07-20');
    s.inbound.set(
      keyOf('woodland', arrivedAt),
      inbound({
        arrived_at: arrivedAt,
        load_source_type: 'paper_bulk',
        total_units: 180,
        program_unit_count: 150,
        non_program_unit_count: 30,
      }),
    );
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ skippedGuarded: 1, inserted: 0, updated: 0, unchanged: 0 });
    const row = s.inbound.get(keyOf('woodland', arrivedAt))!;
    expect(row.load_source_type).toBe('paper_bulk');
    expect(row.program_unit_count).toBe(150); // untouched
    expect(row.non_program_unit_count).toBe(30);
    // Only ONE aggregate row for the (site, day) — the DB partial unique index invariant.
    expect(
      [...s.inbound.values()].filter((r) => r.arrived_at.getTime() === arrivedAt.getTime()),
    ).toHaveLength(1);
    expect(s.audit).toHaveLength(0);
  });
});

describe('bridgeInboundHaulsToInventory — window + dry-run + site scope + empty', () => {
  it('sinceDeliveryDate excludes delivery days before the floor', async () => {
    const s = store({
      mirror: [
        mirror({ docking_appointment_date: noon('2026-07-10'), program_unit_count: 100 }),
        mirror({ docking_appointment_date: noon('2026-07-20'), program_unit_count: 200 }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({
      prisma: fakePrisma(s),
      sinceDeliveryDate: new Date('2026-07-15T00:00:00.000Z'),
    });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1 });
    expect(s.inbound.has(keyOf('woodland', arrivedFor('2026-07-10')))).toBe(false);
    expect(s.inbound.get(keyOf('woodland', arrivedFor('2026-07-20')))!.program_unit_count).toBe(
      200,
    );
  });

  it('dry-run writes nothing but reports what WOULD happen (incl. undated tally)', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 561 }),
        mirror({ program_unit_count: 5, docking_appointment_date: null }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s), dryRun: true });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1, haulsUndated: 1 });
    expect(s.inbound.size).toBe(0);
    expect(s.audit).toHaveLength(0);
  });

  it('restricts to the given siteIds', async () => {
    const s = store({
      mirror: [
        mirror({ site_id: 'woodland', program_unit_count: 200 }),
        mirror({ site_id: 'eugene', program_unit_count: 300 }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({
      prisma: fakePrisma(s),
      siteIds: ['woodland'],
    });
    expect(res.daysConsidered).toBe(1);
    expect(s.inbound.has(keyOf('woodland', arrivedFor('2026-07-20')))).toBe(true);
    expect(s.inbound.has(keyOf('eugene', arrivedFor('2026-07-20')))).toBe(false);
  });

  it('no matching hauls → a clean zero result, no writes', async () => {
    const s = store();
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toEqual({
      daysConsidered: 0,
      inserted: 0,
      updated: 0,
      skippedGuarded: 0,
      unchanged: 0,
      haulsUndated: 0,
      skippedPerLoad: 0,
    });
    expect(s.inbound.size).toBe(0);
  });
});

describe('bridgeInboundHaulsToInventory — ADR-0060 D5 per-load double-count guard', () => {
  it('SKIPS a day that already has a verified per-load b2b_haul row (no aggregate written, no audit)', async () => {
    const s = store({
      mirror: [mirror({ program_unit_count: 561 })],
      perLoad: [
        {
          site_id: 'woodland',
          // A dock capture inside the 2026-07-20 Pacific day.
          arrived_at: new Date('2026-07-20T18:00:00Z'),
          load_source_type: 'b2b_haul',
          status: 'verified',
        },
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 0, skippedPerLoad: 1 });
    // No aggregate row written for the guarded day; no audit.
    expect(s.inbound.has(keyOf('woodland', arrivedFor('2026-07-20')))).toBe(false);
    expect(s.audit).toHaveLength(0);
  });

  it('a per-load row on a DIFFERENT Pacific day does not block the aggregate', async () => {
    const s = store({
      mirror: [mirror({ program_unit_count: 561 })],
      perLoad: [
        {
          site_id: 'woodland',
          arrived_at: new Date('2026-07-19T18:00:00Z'), // prior Pacific day
          load_source_type: 'b2b_haul',
          status: 'verified',
        },
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1, skippedPerLoad: 0 });
    expect(s.inbound.has(keyOf('woodland', arrivedFor('2026-07-20')))).toBe(true);
  });
});

// ── ADR-0089 Am.1 — the delivery-day key is the RECYCLER date, appointment fallback ──

describe('bridgeInboundHaulsToInventory — ADR-0089 delivery-date key', () => {
  it('keys on the recycler-reported date when present — the appointment can be a week out', async () => {
    // H-136583's live shape: booked for 08-12, physically delivered 08-06.
    const s = store({
      mirror: [
        mirror({
          recycler_reported_delivery_date: noon('2026-08-06'),
          docking_appointment_date: noon('2026-08-12'),
          program_unit_count: 104,
          non_program_unit_count: 0,
        }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1, haulsUndated: 0 });
    expect(s.inbound.has(keyOf('woodland', arrivedFor('2026-08-06')))).toBe(true);
    expect(s.inbound.has(keyOf('woodland', arrivedFor('2026-08-12')))).toBe(false);
  });

  it('bridges a collection-network haul with ONLY a recycler date (dock null)', async () => {
    // The 886-haul population the old key structurally dropped (Golden Bear et al.).
    const s = store({
      mirror: [
        mirror({
          recycler_reported_delivery_date: noon('2026-08-10'),
          docking_appointment_date: null,
          program_unit_count: 110,
          non_program_unit_count: 0,
        }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1, haulsUndated: 0 });
    const row = s.inbound.get(keyOf('woodland', arrivedFor('2026-08-10')));
    expect(row?.program_unit_count).toBe(110);
  });

  it('haulsUndated now means GENUINELY dateless — both fields null', async () => {
    const s = store({
      mirror: [
        mirror({ recycler_reported_delivery_date: null, docking_appointment_date: null }),
        mirror({
          recycler_reported_delivery_date: noon('2026-08-06'),
          docking_appointment_date: null,
          program_unit_count: 18,
        }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1, haulsUndated: 1 });
  });

  it('sinceDeliveryDate windows on the COALESCEd day, not the appointment', async () => {
    // Delivered 07-01 per the recycler; appointment says 08-01. The floor is 07-15,
    // so the haul is OUTSIDE the window — keying on the appointment would leak it in.
    const s = store({
      mirror: [
        mirror({
          recycler_reported_delivery_date: noon('2026-07-01'),
          docking_appointment_date: noon('2026-08-01'),
          program_unit_count: 50,
        }),
      ],
    });
    const res = await bridgeInboundHaulsToInventory({
      prisma: fakePrisma(s),
      sinceDeliveryDate: new Date('2026-07-15T00:00:00.000Z'),
    });
    expect(res).toMatchObject({ daysConsidered: 0, inserted: 0 });
    expect(s.inbound.size).toBe(0);
  });
});

// ── ADR-0089 D2 — genuinely-dateless Delivered hauls are ALERTABLE, not just counted ──

describe('findDatelessDeliveredHauls', () => {
  interface DatelessFakeRow {
    id: string;
    external_haul_id: string | null;
    site_id: string | null;
    status: string | null;
    type: string | null;
    docking_appointment_date: Date | null;
    recycler_reported_delivery_date: Date | null;
    detail_fetched_at: Date | null;
    first_seen_at: Date;
    program_unit_count: number | null;
    non_program_unit_count: number | null;
  }

  const datelessRow = (over: Partial<DatelessFakeRow> = {}): DatelessFakeRow => ({
    id: 'a2K-dateless',
    external_haul_id: 'H-999999',
    site_id: 'woodland',
    status: 'Delivered',
    type: 'General',
    docking_appointment_date: null,
    recycler_reported_delivery_date: null,
    detail_fetched_at: new Date('2026-08-10T18:00:00Z'),
    first_seen_at: new Date('2026-08-10T17:00:00Z'),
    program_unit_count: 110,
    non_program_unit_count: 0,
    ...over,
  });

  // A minimal fake honoring exactly the where-shape the finder must use. Unknown
  // where-keys THROW so the filter set is pinned (the ADR-0088 fake-DB lesson).
  const datelessFake = (rows: DatelessFakeRow[]): PrismaClient =>
    ({
      mymrcHaulsMirror: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          const KNOWN = new Set([
            'status',
            'type',
            'site_id',
            'docking_appointment_date',
            'recycler_reported_delivery_date',
            'detail_fetched_at',
            'first_seen_at',
          ]);
          for (const k of Object.keys(where)) {
            if (!KNOWN.has(k)) throw new Error(`unexpected where key: ${k}`);
          }
          return rows.filter((r) => {
            if (where['status'] !== undefined && r.status !== where['status']) return false;
            if (where['type'] !== undefined && r.type !== where['type']) return false;
            const sid = where['site_id'] as { not?: unknown } | undefined;
            if (sid && 'not' in sid && sid.not === null && r.site_id === null) return false;
            if (where['docking_appointment_date'] === null && r.docking_appointment_date !== null)
              return false;
            if (
              where['recycler_reported_delivery_date'] === null &&
              r.recycler_reported_delivery_date !== null
            )
              return false;
            const df = where['detail_fetched_at'] as { not?: unknown } | undefined;
            if (df && 'not' in df && df.not === null && r.detail_fetched_at === null) return false;
            const fs = where['first_seen_at'] as { gte?: Date } | undefined;
            if (fs?.gte && r.first_seen_at.getTime() < fs.gte.getTime()) return false;
            return true;
          });
        },
      },
    }) as unknown as PrismaClient;

  const seenSince = new Date('2026-08-01T00:00:00Z');

  it('returns a Delivered General haul with no date on either field after a detail fetch', async () => {
    const rows = await findDatelessDeliveredHauls({
      prisma: datelessFake([datelessRow()]),
      seenSince,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ external_haul_id: 'H-999999', site_id: 'woodland' });
  });

  it('excludes hauls whose detail has not been fetched — stale pre-Am.1 rows are D4 work, not an alert', async () => {
    const rows = await findDatelessDeliveredHauls({
      prisma: datelessFake([datelessRow({ detail_fetched_at: null })]),
      seenSince,
    });
    expect(rows).toHaveLength(0);
  });

  it('excludes hauls first seen before the window — the pre-deploy backlog must not storm', async () => {
    const rows = await findDatelessDeliveredHauls({
      prisma: datelessFake([datelessRow({ first_seen_at: new Date('2026-07-20T00:00:00Z') })]),
      seenSince,
    });
    expect(rows).toHaveLength(0);
  });

  it('excludes hauls that have a date on either field', async () => {
    const rows = await findDatelessDeliveredHauls({
      prisma: datelessFake([
        datelessRow({ recycler_reported_delivery_date: noon('2026-08-06') }),
        datelessRow({ docking_appointment_date: noon('2026-08-06') }),
      ]),
      seenSince,
    });
    expect(rows).toHaveLength(0);
  });
});
