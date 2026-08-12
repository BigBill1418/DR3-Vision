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
  /**
   * The bridged appointment instant. The check-in affordance is bounded to the
   * CURRENT PACIFIC DAY on this field — the same column, window and helper the
   * queue page already used (ADR-0065 D5). See ADR-0074 Amendment 1.
   */
  expected_arrival_at: Date | null;
  /**
   * The `inbound_loads` child, when the slot has already been consumed. A
   * non-null value means this expected load has been WORKED — there is nothing
   * left to start, and offering a button routes the tap into the existing load.
   */
  inbound_load: {
    id: string;
    status: string;
    total_units: number | null;
    submitted_at: Date | null;
    /** ADR-0091 — who holds the claim, so the card can tell yours from theirs. */
    assigned_operator_id: string | null;
    assigned_operator: { name: string } | null;
  } | null;
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

/**
 * The instant the 2026-08-10 Santa Rita incident was diagnosed: 3:00 PM PDT,
 * which is H-134743's own appointment time. Every day-bound case below is
 * anchored here so "today", "tomorrow" and "a week ago" are literal.
 */
const NOW = new Date('2026-08-10T22:00:00Z'); // 2026-08-10 15:00 PT
const TODAY_APPT = new Date('2026-08-10T22:00:00Z'); // 2026-08-10 15:00 PT
const TOMORROW_APPT = new Date('2026-08-11T17:00:00Z'); // 2026-08-11 10:00 PT

function expectedRow(over: Partial<ExpectedRow> = {}): ExpectedRow {
  return {
    id: 'exp-default',
    site_id: WOODLAND,
    external_mymrc_haul_id: 'H-100001',
    cancelled_at: null,
    expected_arrival_at: TODAY_APPT,
    inbound_load: null,
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
    // Both siblings are pinned to TODAY and left unconsumed on purpose: this
    // case is about sibling EXISTENCE, and after ADR-0074 Amendment 1 the other
    // two conditions (no child, appointment today) would otherwise confound it.
    store.expected = [
      expectedRow({ id: 'exp-1', external_mymrc_haul_id: 'H-BRIDGED' }),
      expectedRow({
        id: 'exp-2',
        external_mymrc_haul_id: 'H-CANCELLED',
        cancelled_at: new Date('2026-07-29T23:00:00Z'),
      }),
    ];
    const page = await listPortalHauls({ siteId: WOODLAND, now: NOW });
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0074 Amendment 1 — the CONSUMED-SLOT defect (production, 2026-08-10)
//
// ## What happened, in the order it happened
//
// 1. 2026-08-03 16:57 PT — `ipad_hauls` went live for Woodland.
// 2. 2026-08-03 17:01 PT — four minutes later, an operator tapped the pinned
//    "Coming up" card for H-134743 (Santa Rita Jail, appointment 2026-08-10
//    15:00 PT) and STARTED it. Seven days early. Nothing refused the tap: the
//    block is deliberately unbounded in time (D3), and the check-in affordance
//    tested only "a non-cancelled `expected_loads` sibling exists" (D5).
// 3. That load was then worked as if it were the truck on the dock and
//    `submitted` on 2026-08-05 with **159 units** — billed against the wrong
//    haul number.
// 4. 2026-08-10 — the REAL Santa Rita truck arrived. `startInboundLoad` is
//    idempotent on `expected_load_id` (correctly — it is what stops a double-tap
//    minting two billing records), so every tap returned the Aug-3 child. The
//    card became a dead button: the load page rendered the `submitted` terminal
//    branch, which had no controls and no navigation, and the held-by panel
//    showed takeover disabled under the label "Counting".
// 5. The floor was unblocked only by an audited manual DB detach
//    (`audit_log.actor_label = 'system:santa-rita-detach'`, 2026-08-10 15:42 PT),
//    which left load `2b60d7ba` orphaned with its 159 units.
//
// ## Why the idempotency is NOT the bug
//
// `startInboundLoad` returning the existing child is the correct, ADR-0082
// behaviour and is untouched by this fix. The bug is upstream of it: a surface
// that offers a control whose only possible outcome is to land on a corpse. The
// read layer must not produce a check-in target that the write layer will
// refuse to act on — the same rule ADR-0082 applied to `takeable`.
//
// ## Three conditions, not one
//
// The affordance now requires ALL of: a live sibling, NO `inbound_loads` child,
// and an appointment on the current Pacific day. Each case below removes exactly
// one and asserts the button is gone but the ROW is not — a vanished row is the
// silence this repo keeps paying for.
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-0074 Am.1 — a CONSUMED expected load is never check-in-able', () => {
  it('THE INCIDENT: a submitted child kills the button and reports what was worked', async () => {
    store.mirror = [mirrorRow({ external_haul_id: 'H-134743', status: 'Confirmed' })];
    store.expected = [
      expectedRow({
        id: 'exp-santa-rita',
        external_mymrc_haul_id: 'H-134743',
        expected_arrival_at: TODAY_APPT,
        inbound_load: {
          id: '2b60d7ba-efb4-46de-ba27-8801bbf0be5a',
          status: 'submitted',
          total_units: 159,
          submitted_at: new Date('2026-08-05T23:48:00Z'),
          assigned_operator_id: 'user-nate',
          assigned_operator: { name: 'Nate Cullison' },
        },
      }),
    ];

    const page = await listPortalHauls({ siteId: WOODLAND, now: NOW });
    const row = page.pending[0];

    // The button is gone…
    expect(row?.expectedLoadId).toBeNull();
    // …and is replaced by something that SAYS what happened, rather than by a
    // silent gap. "Nothing here" was the state that cost the floor a morning.
    expect(row?.consumedLoad).toEqual({
      // ADR-0091 — the child's id travels with the verdict, because an OPEN slot
      // has to be able to route back into the load it already has.
      loadId: '2b60d7ba-efb4-46de-ba27-8801bbf0be5a',
      status: 'submitted',
      // `open` is decided HERE, not in the client. `OPEN_DOCK_STATUSES` lives
      // next to `prisma` in `open-loads.ts`, so a client component cannot import
      // it — and a client-side copy of the status set is precisely the drift
      // that produced the "Counting" mislabel in `held-by-panel.tsx`.
      open: false,
      totalUnits: 159,
      workedAt: new Date('2026-08-05T23:48:00Z'),
      // ADR-0091 — WHO, so the card stops calling your own load somebody else's.
      holderUserId: 'user-nate',
      holderName: 'Nate Cullison',
    });
    // The haul itself is still listed. Hiding it would mean an operator whose
    // truck is on the dock sees an empty screen and learns nothing.
    expect(ids(page.pending)).toEqual(['H-134743']);
  });

  it('an OPEN child also consumes the slot — the tap would land on someone else’s load', async () => {
    // H-135311 in production: started 2026-07-28, still `in_progress` on
    // 2026-08-10. Its appointment day arrived while the load was open; without
    // this the queue would have offered a second start for a load already held.
    store.mirror = [mirrorRow({ external_haul_id: 'H-135311' })];
    store.expected = [
      expectedRow({
        id: 'exp-open',
        external_mymrc_haul_id: 'H-135311',
        inbound_load: {
          id: 'd792ed15',
          status: 'in_progress',
          total_units: null,
          submitted_at: null,
          assigned_operator_id: 'user-janette',
          assigned_operator: { name: 'Janette Tomas' },
        },
      }),
    ];

    const page = await listPortalHauls({ siteId: WOODLAND, now: NOW });
    expect(page.rows[0]?.expectedLoadId).toBeNull();
    expect(page.rows[0]?.consumedLoad?.status).toBe('in_progress');
    expect(page.rows[0]?.consumedLoad?.open).toBe(true);
    // Not submitted ⇒ no instant to show. The copy must not invent one.
    expect(page.rows[0]?.consumedLoad?.workedAt).toBeNull();
  });

  it('an UNCONSUMED sibling whose appointment is today still gets the button', async () => {
    // The control case. If this ever goes red the fix has blocked the floor,
    // which is a worse defect than the one it closes.
    store.mirror = [mirrorRow({ external_haul_id: 'H-134743', status: 'Confirmed' })];
    store.expected = [expectedRow({ id: 'exp-live', external_mymrc_haul_id: 'H-134743' })];

    const page = await listPortalHauls({ siteId: WOODLAND, now: NOW });
    expect(page.pending[0]?.expectedLoadId).toBe('exp-live');
    expect(page.pending[0]?.consumedLoad).toBeNull();
  });
});

describe('ADR-0074 Am.1 — "Coming up" check-in is bounded to the current Pacific day', () => {
  it('THE ORIGIN OF THE INCIDENT: a future appointment offers no check-in', async () => {
    // On 2026-08-03 this is exactly what H-134743 was: a live, unconsumed
    // sibling seven days out. The consumed-check alone would NOT have stopped
    // the Aug-3 tap — only the day bound does.
    store.mirror = [mirrorRow({ external_haul_id: 'H-136912', status: 'Confirmed' })];
    store.expected = [
      expectedRow({
        id: 'exp-tomorrow',
        external_mymrc_haul_id: 'H-136912',
        expected_arrival_at: TOMORROW_APPT,
      }),
    ];

    const page = await listPortalHauls({ siteId: WOODLAND, now: NOW });
    expect(page.pending[0]?.expectedLoadId).toBeNull();
    // Not consumed either — it is simply not yet startable. The UI must be able
    // to tell "already worked" from "not today", so both fields are null.
    expect(page.pending[0]?.consumedLoad).toBeNull();
    // Still LISTED: seeing tomorrow's schedule is the whole point of D3.
    expect(ids(page.pending)).toEqual(['H-136912']);
  });

  it('the bound is PACIFIC, not the container’s UTC — 6 PM PT is still today', async () => {
    // 2026-08-10 18:00 PDT === 2026-08-11 01:00 UTC. A UTC bound would have
    // rolled to the 11th and taken the evening crew's check-in with it — the
    // ADR-0065 Amendment 1 defect, reintroduced one surface over.
    const evening = new Date('2026-08-11T01:00:00Z');
    store.mirror = [mirrorRow({ external_haul_id: 'H-EVENING', status: 'Confirmed' })];
    store.expected = [
      expectedRow({
        id: 'exp-evening',
        external_mymrc_haul_id: 'H-EVENING',
        expected_arrival_at: new Date('2026-08-11T02:00:00Z'), // 19:00 PT, the 10th
      }),
    ];

    const page = await listPortalHauls({ siteId: WOODLAND, now: evening });
    expect(page.pending[0]?.expectedLoadId).toBe('exp-evening');
  });

  it('a sibling with NO appointment instant is not startable from this surface', async () => {
    // 3,316 undated hauls (ADR-0074 D3). "Unknown day" cannot be proven to be
    // today, and the queue — bounded on the same column — never offered them.
    store.mirror = [mirrorRow({ external_haul_id: 'H-UNDATED', docking_appointment_date: null })];
    store.expected = [
      expectedRow({
        id: 'exp-undated',
        external_mymrc_haul_id: 'H-UNDATED',
        expected_arrival_at: null,
      }),
    ];

    const page = await listPortalHauls({ siteId: WOODLAND, now: NOW });
    expect(page.rows[0]?.expectedLoadId).toBeNull();
    expect(ids(page.rows)).toEqual(['H-UNDATED']);
  });

  it('a PAST appointment offers no check-in either (no writing against a closed day)', async () => {
    store.mirror = [mirrorRow({ external_haul_id: 'H-YESTERDAY' })];
    store.expected = [
      expectedRow({
        id: 'exp-past',
        external_mymrc_haul_id: 'H-YESTERDAY',
        expected_arrival_at: new Date('2026-08-09T22:00:00Z'),
      }),
    ];

    const page = await listPortalHauls({ siteId: WOODLAND, now: NOW });
    expect(page.rows[0]?.expectedLoadId).toBeNull();
  });
});

// ── ADR-0096 ────────────────────────────────────────────────────────────────
//
// H-136980 on 2026-08-11: booked 8/10, never checked in, truck arrived the next
// day. Live, uncancelled, unconsumed — so it reached neither the consumed branch
// nor the startable branch, and the UI had nothing to render but "View only".
describe('a slot booked for another day is RECONCILABLE, not startable', () => {
  const YESTERDAY_APPT = new Date('2026-08-09T22:00:00Z'); // 2026-08-09 15:00 PT

  it('THE INCIDENT: a past-day live slot is named, not silently dropped', async () => {
    store.mirror = [mirrorRow({ external_haul_id: 'H-136980' })];
    store.expected = [
      expectedRow({
        id: 'exp-h136980',
        external_mymrc_haul_id: 'H-136980',
        expected_arrival_at: YESTERDAY_APPT,
      }),
    ];

    const row = (await listPortalHauls({ siteId: WOODLAND, now: NOW })).rows[0];
    // D5 is NOT widened — this is the property that keeps a child load from
    // being minted onto the wrong slot.
    expect(row?.expectedLoadId).toBeNull();
    // …and the divergent state gets its own name and its own route.
    expect(row?.reconcilableExpectedLoadId).toBe('exp-h136980');
    expect(row?.slotDayISO).toBe('2026-08-09');
  });

  it('a FUTURE-day slot is reconcilable too — early trucks are real', async () => {
    // 2026-08-11: H-136147 was claimed at 07:55 PT against a 15:00 PT slot. A
    // truck can be early as easily as late, and both are the same divergence.
    store.mirror = [mirrorRow({ external_haul_id: 'H-136147' })];
    store.expected = [
      expectedRow({
        id: 'exp-future',
        external_mymrc_haul_id: 'H-136147',
        expected_arrival_at: TOMORROW_APPT,
      }),
    ];
    const row = (await listPortalHauls({ siteId: WOODLAND, now: NOW })).rows[0];
    expect(row?.expectedLoadId).toBeNull();
    expect(row?.reconcilableExpectedLoadId).toBe('exp-future');
  });

  it('a TODAY slot is startable and NOT reconcilable — the states are exclusive', async () => {
    store.mirror = [mirrorRow({ external_haul_id: 'H-100001' })];
    store.expected = [expectedRow({ id: 'exp-today' })];
    const row = (await listPortalHauls({ siteId: WOODLAND, now: NOW })).rows[0];
    expect(row?.expectedLoadId).toBe('exp-today');
    expect(row?.reconcilableExpectedLoadId).toBeNull();
  });

  it('an UNDATED slot is neither — there is no day to confirm or to check', async () => {
    // The server assert compares the acknowledgement against the slot's day, so
    // a slot without one cannot produce evidence and must stay read-only.
    store.mirror = [mirrorRow({ external_haul_id: 'H-100001' })];
    store.expected = [expectedRow({ id: 'exp-undated', expected_arrival_at: null })];
    const row = (await listPortalHauls({ siteId: WOODLAND, now: NOW })).rows[0];
    expect(row?.expectedLoadId).toBeNull();
    expect(row?.reconcilableExpectedLoadId).toBeNull();
    expect(row?.slotDayISO).toBeNull();
  });

  it('a CANCELLED past-day slot is NOT reconcilable', async () => {
    // Reconcile is an exception to the DAY rule, never to cancellation.
    store.mirror = [mirrorRow({ external_haul_id: 'H-100001' })];
    store.expected = [
      expectedRow({
        id: 'exp-cancelled',
        expected_arrival_at: YESTERDAY_APPT,
        cancelled_at: new Date('2026-08-09T23:00:00Z'),
      }),
    ];
    const row = (await listPortalHauls({ siteId: WOODLAND, now: NOW })).rows[0];
    expect(row?.reconcilableExpectedLoadId).toBeNull();
  });

  it('a CONSUMED past-day slot reports its child, never a reconcile', async () => {
    store.mirror = [mirrorRow({ external_haul_id: 'H-100001' })];
    store.expected = [
      expectedRow({
        id: 'exp-consumed',
        expected_arrival_at: YESTERDAY_APPT,
        inbound_load: {
          id: 'child-1',
          status: 'submitted',
          total_units: 12,
          submitted_at: new Date('2026-08-09T23:30:00Z'),
          assigned_operator_id: 'user-x',
          assigned_operator: { name: 'X' },
        },
      }),
    ];
    const row = (await listPortalHauls({ siteId: WOODLAND, now: NOW })).rows[0];
    expect(row?.reconcilableExpectedLoadId).toBeNull();
    expect(row?.consumedLoad?.status).toBe('submitted');
  });
});
