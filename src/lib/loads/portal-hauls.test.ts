// ADR-0074 — the open portal-haul read surface.
//
// ── Why this suite evaluates the query instead of asserting its shape ────────
// The sibling `open-loads.test.ts` asserts the WHERE object literally, because
// there the defect was "no query at all". Here the defect class is different and
// subtler: a plausible-looking extra predicate that silently deletes most of the
// data. `disappeared_at IS NULL` reads like hygiene and would hide 5,455 of the
// 6,269 delivered Woodland hauls; `status NOT IN (...)` written the obvious way
// drops NULL-status rows on SQL three-valued logic. Neither is visible in a shape
// assertion — both are only visible in what comes BACK.
//
// So the mock is a tiny evaluator: it runs the real Prisma filter/order objects
// this module builds against a row fixture and returns what actually matches.
// Every case below is therefore falsifiable — add the wrong filter to
// `portal-hauls.ts` and these go red, which is exactly what was confirmed by
// hand before this file was committed (see the ADR-0074 record).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── The in-memory store the fake client reads ────────────────────────────────
interface MirrorRow {
  id: string;
  site_id: string | null;
  external_haul_id: string | null;
  status: string | null;
  type: string | null;
  transporter_name: string | null;
  collection_site: string | null;
  collection_source: string | null;
  docking_appointment_date: Date | null;
  docking_appointment_at: Date | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  unpaid_consumer_dropoff_units: number | null;
  disappeared_at: Date | null;
}

interface ExpectedRow {
  id: string;
  site_id: string;
  external_mymrc_haul_id: string;
  cancelled_at: Date | null;
}

const store = { mirror: [] as MirrorRow[], expected: [] as ExpectedRow[] };

type Cmp = Record<string, unknown>;

/** Evaluate one Prisma-style field condition against a value. */
function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && +value === +cond;
  if (typeof cond !== 'object') return value === cond;

  const c = cond as Cmp;
  for (const [op, arg] of Object.entries(c)) {
    if (op === 'mode') continue;
    switch (op) {
      case 'equals':
        if (!matchField(value, arg)) return false;
        break;
      case 'not':
        if (matchField(value, arg)) return false;
        break;
      case 'in':
        if (!(arg as unknown[]).includes(value)) return false;
        break;
      case 'notIn':
        // SQL semantics deliberately reproduced: NULL NOT IN (...) is NULL, i.e.
        // NOT a match. This is what makes the NULL-tolerance case real.
        if (value === null || value === undefined) return false;
        if ((arg as unknown[]).includes(value)) return false;
        break;
      case 'contains': {
        if (typeof value !== 'string') return false;
        const insensitive = c['mode'] === 'insensitive';
        const hay = insensitive ? value.toLowerCase() : value;
        const needle = insensitive ? String(arg).toLowerCase() : String(arg);
        if (!hay.includes(needle)) return false;
        break;
      }
      default:
        throw new Error(`fake prisma: unsupported operator "${op}"`);
    }
  }
  return true;
}

function matchWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'AND') {
      const list = (Array.isArray(cond) ? cond : [cond]) as Record<string, unknown>[];
      if (!list.every((w) => matchWhere(row, w))) return false;
    } else if (key === 'OR') {
      const list = cond as Record<string, unknown>[];
      if (!list.some((w) => matchWhere(row, w))) return false;
    } else if (key === 'NOT') {
      const list = (Array.isArray(cond) ? cond : [cond]) as Record<string, unknown>[];
      if (list.some((w) => matchWhere(row, w))) return false;
    } else if (!matchField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

type OrderSpec = Record<
  string,
  'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' }
>;

function compare(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  order: OrderSpec[],
): number {
  for (const spec of order) {
    const [field, raw] = Object.entries(spec)[0] as [string, OrderSpec[string]];
    const dir = typeof raw === 'string' ? raw : raw.sort;
    // Postgres default under DESC is NULLS FIRST; `nulls` overrides it.
    const nulls =
      typeof raw === 'string'
        ? dir === 'desc'
          ? 'first'
          : 'last'
        : (raw.nulls ?? (dir === 'desc' ? 'first' : 'last'));
    const av = a[field] ?? null;
    const bv = b[field] ?? null;
    if (av === null && bv === null) continue;
    if (av === null) return nulls === 'first' ? -1 : 1;
    if (bv === null) return nulls === 'first' ? 1 : -1;
    const an = av instanceof Date ? +av : av;
    const bn = bv instanceof Date ? +bv : bv;
    if (an === bn) continue;
    const lt = (an as number | string) < (bn as number | string);
    return dir === 'desc' ? (lt ? 1 : -1) : lt ? -1 : 1;
  }
  return 0;
}

interface FindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: OrderSpec[];
  take?: number;
  skip?: number;
}

function findMany<T extends Record<string, unknown>>(rows: T[], args: FindManyArgs): T[] {
  let out = rows.filter((r) => matchWhere(r, args.where ?? {}));
  if (args.orderBy) out = [...out].sort((a, b) => compare(a, b, args.orderBy as OrderSpec[]));
  const skip = args.skip ?? 0;
  return args.take === undefined ? out.slice(skip) : out.slice(skip, skip + args.take);
}

const prismaFake = {
  mymrcHaulsMirror: {
    findMany: async (args: FindManyArgs) =>
      findMany(store.mirror as unknown as Record<string, unknown>[], args),
    count: async (args: FindManyArgs) =>
      (store.mirror as unknown as Record<string, unknown>[]).filter((r) =>
        matchWhere(r, args.where ?? {}),
      ).length,
  },
  expectedLoad: {
    findMany: async (args: FindManyArgs) =>
      findMany(store.expected as unknown as Record<string, unknown>[], args),
  },
};

// `vi.mock` is hoisted above every `const` in this file, so the factory must not
// close over a plain top-level binding — it reaches `prismaFake` lazily instead.
vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return prismaFake;
  },
}));

import { listPortalHauls, countPendingPortalHauls, EXCLUDED_HAUL_STATUSES } from './portal-hauls';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

let seq = 0;
function mirrorRow(over: Partial<MirrorRow> = {}): MirrorRow {
  seq += 1;
  return {
    id: `a2K${String(seq).padStart(5, '0')}`,
    site_id: WOODLAND,
    external_haul_id: `H-${100000 + seq}`,
    status: 'Delivered',
    type: 'General',
    transporter_name: 'Ron Lawrence & Son',
    collection_site: 'Recycling Industries Transfer Station',
    collection_source: null,
    docking_appointment_date: new Date('2026-07-01T12:00:00Z'),
    docking_appointment_at: new Date('2026-07-01T22:00:00Z'),
    program_unit_count: 115,
    non_program_unit_count: 0,
    unpaid_consumer_dropoff_units: null,
    disappeared_at: null,
    ...over,
  };
}

beforeEach(() => {
  seq = 0;
  store.mirror = [];
  store.expected = [];
});

const ids = (rows: { externalHaulId: string | null }[]) => rows.map((r) => r.externalHaulId);

describe('listPortalHauls — what comes back', () => {
  it('(a) RETURNS a Delivered haul that carries a disappeared_at stamp', async () => {
    // THE LOAD-BEARING GUARD (ADR-0074 D2). 5,455 of the 6,269 Delivered/General
    // Woodland mirror rows carry this stamp — it means "absent from the last swept
    // LIST VIEW" (ADR-0070 Am.1 §3), not "gone". Filtering on it hides 87% of the
    // delivered hauls, which is the exact blindness this surface exists to end.
    // FALSIFIED BY HAND before commit: adding `disappeared_at: null` to the
    // module's WHERE turns this red.
    store.mirror = [
      mirrorRow({ external_haul_id: 'H-GONE', disappeared_at: new Date('2026-07-20T00:00:00Z') }),
      mirrorRow({ external_haul_id: 'H-HERE' }),
    ];
    const page = await listPortalHauls({ siteId: WOODLAND });
    expect(ids(page.rows)).toContain('H-GONE');
    expect(page.total).toBe(2);
  });

  it('(b) excludes Rejected and Inactive, and still RETURNS a NULL-status row', async () => {
    // NULL status = "list pass landed, detail pass has not" — unknown, never
    // excluded. Written as an explicit OR precisely because `NOT IN` would drop it
    // on SQL three-valued logic (the fake reproduces that logic faithfully, so a
    // regression to `notIn` alone fails here).
    store.mirror = [
      mirrorRow({ external_haul_id: 'H-OK', status: 'Delivered' }),
      mirrorRow({ external_haul_id: 'H-REJ', status: 'Rejected' }),
      mirrorRow({ external_haul_id: 'H-INACT', status: 'Inactive' }),
      mirrorRow({ external_haul_id: 'H-NULL', status: null }),
    ];
    const page = await listPortalHauls({ siteId: WOODLAND });
    expect(ids(page.rows).sort()).toEqual(['H-NULL', 'H-OK']);
    expect([...EXCLUDED_HAUL_STATUSES]).toEqual(['Rejected', 'Inactive']);
  });

  it('(c) sorts undated rows LAST and never drops them', async () => {
    // Postgres sorts NULLs FIRST under DESC. Without the explicit `nulls: 'last'`
    // the 3,316 undated rows would sit ABOVE every real appointment.
    store.mirror = [
      mirrorRow({ external_haul_id: 'H-UNDATED', docking_appointment_date: null }),
      mirrorRow({
        external_haul_id: 'H-OLD',
        docking_appointment_date: new Date('2026-06-01T12:00:00Z'),
      }),
      mirrorRow({
        external_haul_id: 'H-NEW',
        docking_appointment_date: new Date('2026-08-01T12:00:00Z'),
      }),
    ];
    const page = await listPortalHauls({ siteId: WOODLAND });
    expect(ids(page.rows)).toEqual(['H-NEW', 'H-OLD', 'H-UNDATED']);
    expect(page.undatedCount).toBe(1);

    const only = await listPortalHauls({ siteId: WOODLAND, undatedOnly: true });
    expect(ids(only.rows)).toEqual(['H-UNDATED']);
  });

  it('(d) searches external_haul_id case-insensitively (and the other three fields)', async () => {
    store.mirror = [
      mirrorRow({ external_haul_id: 'H-136271' }),
      mirrorRow({ external_haul_id: 'H-999999', transporter_name: 'Total Quality Logistics' }),
      mirrorRow({ external_haul_id: 'H-888888', collection_site: 'City of Folsom' }),
      mirrorRow({ external_haul_id: 'H-777777', collection_source: 'Wexler Yard' }),
    ];
    // An operator types with the on-screen keyboard's auto-capitalisation off, or
    // reads the number off a BOL in lowercase — both must find the row.
    expect(ids((await listPortalHauls({ siteId: WOODLAND, q: 'h-136271' })).rows)).toEqual([
      'H-136271',
    ]);
    expect(ids((await listPortalHauls({ siteId: WOODLAND, q: 'QUALITY' })).rows)).toEqual([
      'H-999999',
    ]);
    expect(ids((await listPortalHauls({ siteId: WOODLAND, q: 'folsom' })).rows)).toEqual([
      'H-888888',
    ]);
    expect(ids((await listPortalHauls({ siteId: WOODLAND, q: 'wexler' })).rows)).toEqual([
      'H-777777',
    ]);
    // Whitespace-only never narrows the list (hard rule #2's cousin: a stray space
    // must not silently empty a floor screen).
    expect((await listPortalHauls({ siteId: WOODLAND, q: '   ' })).total).toBe(4);
  });

  it('(e) never returns another site’s row (hard rule #2 — strict site separation)', async () => {
    store.mirror = [
      mirrorRow({ external_haul_id: 'H-WOOD', site_id: WOODLAND }),
      mirrorRow({ external_haul_id: 'H-EUG', site_id: EUGENE }),
      mirrorRow({ external_haul_id: 'H-ORPHAN', site_id: null }),
    ];
    const page = await listPortalHauls({ siteId: WOODLAND });
    expect(ids(page.rows)).toEqual(['H-WOOD']);
    // Eugene has no MyMRC portal feed at all — the honest empty state, by
    // construction rather than by a special case.
    const eugene = await listPortalHauls({ siteId: EUGENE });
    expect(ids(eugene.rows)).toEqual(['H-EUG']);
    expect(eugene.pending).toEqual([]);
  });

  it('(f) leaves expectedLoadId NULL when there is no live expected_loads sibling', async () => {
    // D5: a mirror row with no sibling is INFORMATION, never work. The UI reads
    // this null to render the row without a check-in control; synthesizing an
    // ExpectedLoad/InboundLoad to make a button possible is forbidden.
    store.mirror = [
      mirrorRow({ external_haul_id: 'H-BRIDGED' }),
      mirrorRow({ external_haul_id: 'H-UNBRIDGED' }),
      mirrorRow({ external_haul_id: 'H-CANCELLED' }),
    ];
    store.expected = [
      { id: 'exp-1', site_id: WOODLAND, external_mymrc_haul_id: 'H-BRIDGED', cancelled_at: null },
      {
        id: 'exp-2',
        site_id: WOODLAND,
        external_mymrc_haul_id: 'H-CANCELLED',
        cancelled_at: new Date('2026-07-29T23:00:00Z'),
      },
    ];
    const page = await listPortalHauls({ siteId: WOODLAND });
    const byId = new Map(page.rows.map((r) => [r.externalHaulId, r.expectedLoadId]));
    expect(byId.get('H-BRIDGED')).toBe('exp-1');
    expect(byId.get('H-UNBRIDGED')).toBeNull();
    // A CANCELLED sibling is not check-in-able; mapping it would render a button
    // whose server action refuses.
    expect(byId.get('H-CANCELLED')).toBeNull();
  });
});

describe('listPortalHauls — pending block and pagination', () => {
  it('pins every Confirmed haul, unpaginated and unaffected by the search term', async () => {
    store.mirror = [
      mirrorRow({ external_haul_id: 'H-SOON', status: 'Confirmed' }),
      mirrorRow({ external_haul_id: 'H-LATER', status: 'Confirmed' }),
      mirrorRow({ external_haul_id: 'H-DONE', status: 'Delivered' }),
    ];
    const page = await listPortalHauls({ siteId: WOODLAND, q: 'H-DONE' });
    expect(ids(page.rows)).toEqual(['H-DONE']);
    // "What is coming" must not depend on what the operator typed.
    expect(ids(page.pending).sort()).toEqual(['H-LATER', 'H-SOON']);
    await expect(countPendingPortalHauls(WOODLAND)).resolves.toBe(2);
  });

  it('paginates at a server-fixed page size a client cannot widen', async () => {
    store.mirror = Array.from({ length: 120 }, (_, i) =>
      mirrorRow({
        external_haul_id: `H-${200000 + i}`,
        docking_appointment_date: new Date(Date.UTC(2026, 0, 1 + i, 12)),
      }),
    );
    const first = await listPortalHauls({ siteId: WOODLAND });
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(120);
    expect(first.totalPages).toBe(3);

    const third = await listPortalHauls({ siteId: WOODLAND, page: 3 });
    expect(third.rows).toHaveLength(20);
    expect(third.page).toBe(3);
    // Newest first across the page boundary, not merely within a page.
    expect(first.rows[0]?.externalHaulId).toBe('H-200119');

    // A caller asking for a bigger page gets the server's ceiling, not its ask.
    const greedy = await listPortalHauls({ siteId: WOODLAND, perPage: 5000 });
    expect(greedy.rows).toHaveLength(50);
    expect(greedy.perPage).toBe(50);
  });

  it('reports one empty page rather than zero pages when nothing matches', async () => {
    store.mirror = [mirrorRow()];
    const page = await listPortalHauls({ siteId: WOODLAND, q: 'no-such-haul' });
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
    // `totalPages: 0` would make the pagination control render "Page 1 of 0".
    expect(page.totalPages).toBe(1);
  });
});
