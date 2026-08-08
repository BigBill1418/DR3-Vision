// ADR-0084 — the falsifications for the same-day count void.
//
// ## Why the fake prisma in this file is not "a mock reading itself back"
//
// This repo has been bitten repeatedly by tests that went green because the mock
// enforced the rule the test was checking. The existing `running-balance.test.ts`
// mock is the shape to avoid: `findFirst: async () => store.anchor` ignores the
// where-clause entirely, so it can never tell a filtered reader from an
// unfiltered one — it returns the fixture's chosen row either way.
//
// The client here is a GENERIC where/orderBy EVALUATOR over an in-memory row
// array. It knows nothing about `voided_at`: the filter is matched by the same
// `value === null` branch that would match `import_id: null`. So the only thing
// deciding whether a voided row reaches `onHand` is whether `onHand`'s OWN
// where-clause carries `NOT_VOIDED` — which is exactly the claim under test. If
// the filter is stripped from the source, these tests go red, and
// `strips the filter and the voided count comes back` proves the evaluator
// discriminates rather than asserting it.
//
// A real Postgres would be better still, and `anchor-tiebreaker.db.test.ts` is
// the model for that. It is not reachable here — see the report; there is no
// Postgres on this host and `DR3_TEST_DATABASE_URL` is unset, so that suite
// `describe.skipIf`s. Numeric assertions use real `Prisma.Decimal` values, never
// hand-rolled stand-ins.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────
// The in-memory database
// ─────────────────────────────────────────────────────────────────────────

interface SnapRow {
  id: string;
  site_id: string;
  snapshot_at: Date;
  created_at: Date;
  snapshot_kind: string;
  units_indoor: number | null;
  units_total: number | null;
  units_in_processing: number;
  program_units: Prisma.Decimal | null;
  non_program_units: Prisma.Decimal | null;
  pool_attribution: string;
  source: string;
  import_id: string | null;
  reconciled_delta: number | null;
  voided_at: Date | null;
  voided_by: string | null;
}

interface AuditRow {
  id: string;
  table_name: string;
  row_id: string;
  action: string;
  actor_user_id: string | null;
  actor_label: string | null;
  created_at: Date;
  before: unknown;
  after: unknown;
}

const db = {
  snapshots: [] as SnapRow[],
  audit: [] as AuditRow[],
  idem: new Map<
    string,
    { scope: string; actor: string | null; hash: string; status: number | null; body: unknown }
  >(),
  seq: 0,
};

const num = (v: unknown): number => (v instanceof Date ? v.getTime() : (v as number));

/**
 * A generic Prisma where-matcher. Deliberately has NO knowledge of any specific
 * column: `voided_at: null` is handled by the same `null` branch as any other
 * nullable field. That is what makes the void assertions in this file real.
 */
function matches(row: object, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  // `object` rather than `Record<string, unknown>` so the concrete row
  // interfaces (which have no index signature) are assignable; field access goes
  // through one local cast rather than weakening the row types themselves.
  const r = row as Record<string, unknown>;
  for (const [key, cond] of Object.entries(where)) {
    const actual = r[key];
    if (cond === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (typeof cond === 'object') {
      for (const [op, raw] of Object.entries(cond as Record<string, unknown>)) {
        switch (op) {
          case 'lt':
            if (!(num(actual) < num(raw))) return false;
            break;
          case 'lte':
            if (!(num(actual) <= num(raw))) return false;
            break;
          case 'gt':
            if (!(num(actual) > num(raw))) return false;
            break;
          case 'gte':
            if (!(num(actual) >= num(raw))) return false;
            break;
          case 'not':
            if (actual === raw) return false;
            break;
          case 'in':
            if (!(raw as unknown[]).includes(actual)) return false;
            break;
          default:
            throw new Error(`fake-prisma: unsupported operator "${op}"`);
        }
      }
      continue;
    }
    if (actual !== cond) return false;
  }
  return true;
}

type OrderBy = Record<string, 'asc' | 'desc'>;

function sorted<T extends object>(rows: T[], orderBy?: OrderBy | OrderBy[]): T[] {
  if (!orderBy) return rows;
  const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
  const at = (row: T, field: string): unknown => (row as Record<string, unknown>)[field];
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const [field, dir] = Object.entries(k)[0] as [string, 'asc' | 'desc'];
      const d = num(at(a, field)) - num(at(b, field));
      if (d !== 0) return dir === 'desc' ? -d : d;
    }
    return 0;
  });
}

const EMPTY_SUM = { _sum: {} as Record<string, null> };

function snapshotDelegate(): Record<string, unknown> {
  return {
    findFirst: async (a: { where?: Record<string, unknown>; orderBy?: OrderBy | OrderBy[] }) =>
      sorted(
        db.snapshots.filter((r) => matches(r, a?.where)),
        a?.orderBy,
      )[0] ?? null,
    findMany: async (a: {
      where?: Record<string, unknown>;
      orderBy?: OrderBy | OrderBy[];
      take?: number;
    }) => {
      const rows = sorted(
        db.snapshots.filter((r) => matches(r, a?.where)),
        a?.orderBy,
      );
      return a?.take ? rows.slice(0, a.take) : rows;
    },
    count: async (a: { where?: Record<string, unknown> }) =>
      db.snapshots.filter((r) => matches(r, a?.where)).length,
    findUnique: async (a: { where: { id: string } }) =>
      db.snapshots.find((r) => r.id === a.where.id) ?? null,
    findUniqueOrThrow: async (a: { where: { id: string } }) => {
      const r = db.snapshots.find((x) => x.id === a.where.id);
      if (!r) throw new Error('not found');
      return r;
    },
    updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = db.snapshots.filter((r) => matches(r, a.where));
      for (const r of hit) Object.assign(r, a.data);
      return { count: hit.length };
    },
  };
}

function auditDelegate(): Record<string, unknown> {
  return {
    findFirst: async (a: { where?: Record<string, unknown>; orderBy?: OrderBy | OrderBy[] }) =>
      sorted(
        db.audit.filter((r) => matches(r, a?.where)),
        a?.orderBy,
      )[0] ?? null,
    findMany: async (a: { where?: Record<string, unknown> }) =>
      db.audit.filter((r) => matches(r, a?.where)),
    create: async ({ data }: { data: Partial<AuditRow> }) => {
      const row = {
        id: `audit-${++db.seq}`,
        created_at: new Date(),
        actor_label: null,
        before: null,
        after: null,
        ...data,
      } as AuditRow;
      db.audit.push(row);
      return row;
    },
  };
}

/**
 * `$executeRaw` / `$queryRaw` against a real `idempotency_keys` table, dispatched
 * on the statement text. Reproduces the three behaviours `withIdempotency`
 * depends on: INSERT ... ON CONFLICT DO NOTHING returning rows-affected, the
 * completion UPDATE, and the replay SELECT — including the JSONB round-trip,
 * which is why `voidedAt` is an ISO string in `VoidSnapshotResult`.
 */
function rawDelegates(): Record<string, unknown> {
  return {
    $executeRaw: async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('INSERT INTO "idempotency_keys"')) {
        const [key, scope, actor, , hash] = v as [string, string, string | null, unknown, string];
        if (db.idem.has(key)) return 0;
        db.idem.set(key, { scope, actor, hash, status: null, body: null });
        return 1;
      }
      if (sql.includes('UPDATE "idempotency_keys"')) {
        const [status, bodyJson, key] = v as [number, string, string];
        const row = db.idem.get(key);
        if (row) {
          row.status = status;
          // JSONB round-trip, exactly as Postgres would: Dates become strings.
          row.body = JSON.parse(bodyJson);
        }
        return 1;
      }
      throw new Error(`fake-prisma: unexpected $executeRaw: ${sql}`);
    },
    $queryRaw: async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "idempotency_keys"')) {
        const row = db.idem.get(v[0] as string);
        return row
          ? [
              {
                scope: row.scope,
                actor_user_id: row.actor,
                request_hash: row.hash,
                status_code: row.status,
                response_body: row.body,
              },
            ]
          : [];
      }
      throw new Error(`fake-prisma: unexpected $queryRaw: ${sql}`);
    },
  };
}

function client(): Record<string, unknown> {
  return {
    siteInventorySnapshot: snapshotDelegate(),
    auditLog: auditDelegate(),
    ...rawDelegates(),
    // `onHand`'s five flow aggregates. Zeroed so the balance IS the anchor total
    // — the assertions are about WHICH ANCHOR was selected, and folding in flow
    // the fake does not window correctly would measure the fake instead.
    inboundLoad: { aggregate: async () => EMPTY_SUM },
    consumerDropoff: { aggregate: async () => EMPTY_SUM },
    processedUnitsDaily: { aggregate: async () => EMPTY_SUM, count: async () => 0 },
    outboundMaterial: { aggregate: async () => EMPTY_SUM },
    landfilledUnit: { aggregate: async () => EMPTY_SUM },
    invoice: { count: async () => 0 },
    outboundMaterialPayment: { count: async () => 0 },
    auditBootstrapGate: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client()),
  };
}

vi.mock('@/lib/prisma', () => ({ prisma: client() }));

import { onHand } from './running-balance';
import { loadPriorAnchor } from './anchor-guardrail';
import { resolveLegLiveness } from '@/lib/audit/bootstrap-gate';
import { NOT_VOIDED } from './snapshot-void';
import {
  SnapshotNotFoundError,
  SnapshotVoidAmendmentRequiredError,
  listTodaysVoidableCountsAtSite,
  voidSnapshot,
} from './void-count';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const SITE = 'site-eugene';
const OTHER_SITE = 'site-woodland';
const JT = 'user-jt';
const MARIA = 'user-maria';

/** 2026-07-28 Pacific midnight = 07:00Z (PDT, UTC−7). */
const PT_JUL28 = new Date('2026-07-28T07:00:00.000Z');
const PT_JUL27 = new Date('2026-07-27T07:00:00.000Z');

/**
 * THE UTC-ROLLOVER TRAP. 2026-07-29T01:00:00Z is 2026-07-28 18:00 Pacific — the
 * 28th is still today locally while UTC has already rolled to the 29th. Any
 * server-local or UTC notion of "today" refuses the 28th's count here.
 */
const EVENING_OF_JUL28 = new Date('2026-07-29T01:00:00.000Z');
/** Comfortably mid-afternoon Pacific on the 28th: 10:00 PT. */
const MIDDAY_JUL28 = new Date('2026-07-28T17:00:00.000Z');

function snap(over: Partial<SnapRow> & { id: string }): SnapRow {
  return {
    site_id: SITE,
    snapshot_at: PT_JUL28,
    created_at: new Date(PT_JUL28.getTime() + 3_600_000),
    snapshot_kind: 'physical',
    units_indoor: null,
    units_total: 0,
    units_in_processing: 0,
    program_units: null,
    non_program_units: null,
    pool_attribution: 'legacy',
    source: 'manual',
    import_id: null,
    reconciled_delta: null,
    voided_at: null,
    voided_by: null,
    ...over,
  };
}

/** The insert audit row `reconcilePhysicalCount` writes — the provenance of WHO. */
function entered(snapshotId: string, actor: string): AuditRow {
  return {
    id: `audit-insert-${snapshotId}`,
    table_name: 'site_inventory_snapshots',
    row_id: snapshotId,
    action: 'insert',
    actor_user_id: actor,
    actor_label: null,
    created_at: new Date(PT_JUL28.getTime() + 3_600_000),
    before: null,
    after: null,
  };
}

/** Yesterday's anchor: 2,000. Today's (mistyped) second count: 2,483. */
function seedTwoAnchors(): void {
  db.snapshots = [
    snap({
      id: 'snap-prior',
      snapshot_at: PT_JUL27,
      created_at: new Date(PT_JUL27.getTime() + 3_600_000),
      units_total: 2_000,
    }),
    snap({ id: 'snap-today', units_total: 2_483 }),
  ];
  db.audit = [entered('snap-prior', JT), entered('snap-today', JT)];
}

beforeEach(() => {
  db.snapshots = [];
  db.audit = [];
  db.idem = new Map();
  db.seq = 0;
});

const voidAuditRows = () =>
  db.audit.filter((a) => a.action === 'update' && a.table_name === 'site_inventory_snapshots');

// ─────────────────────────────────────────────────────────────────────────

describe('F1 — a same-day void is audited AND drops out of anchor selection', () => {
  it('recomputes the floor to the PRIOR anchor exactly, and writes one audit row', async () => {
    seedTwoAnchors();

    const before = await onHand(SITE, MIDDAY_JUL28);
    // The mistyped count is the anchor while it stands.
    expect(before.total).toStrictEqual(new Prisma.Decimal(2_483));

    const result = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      idempotencyKey: null,
      now: MIDDAY_JUL28,
    });
    expect(result.alreadyVoided).toBe(false);
    expect(result.physicalTotal).toBe(2_483);

    // The EXACT prior-anchor-derived value, not merely "different". 2,000 is the
    // 27th's count; anything else means a different anchor was chosen.
    const after = await onHand(SITE, MIDDAY_JUL28);
    expect(after.total).toStrictEqual(new Prisma.Decimal(2_000));

    // The guardrail's selector must have moved with it (ADR-0078 D1 invariant,
    // extended to the where-clause by ADR-0084): a guardrail still measuring
    // against 2,483 would grade the operator's next count against a withdrawn one.
    expect(
      (await loadPriorAnchor({ siteInventorySnapshot: snapshotDelegate() } as never, SITE))?.total,
    ).toBe(2_000);

    // Never a hard delete.
    expect(db.snapshots.map((s) => s.id).sort()).toEqual(['snap-prior', 'snap-today']);
    const voided = db.snapshots.find((s) => s.id === 'snap-today');
    expect(voided?.voided_at).toBeInstanceOf(Date);
    expect(voided?.voided_by).toBe(JT);

    // CLAUDE.md hard rule #6 — audited, in the same transaction, with the void
    // columns in before/after and the operator as the actor.
    expect(voidAuditRows()).toHaveLength(1);
    const audit = voidAuditRows()[0] as AuditRow;
    expect(audit.actor_user_id).toBe(JT);
    expect(audit.row_id).toBe('snap-today');
    expect(audit.before).toEqual({ voided_at: null, voided_by: null });
    expect(audit.after).toMatchObject({ voided_by: JT, physical_total: 2_483 });
  });
});

describe('F2 — a prior-day void is refused with a requires_amendment-shaped 409', () => {
  it('refuses, names the office route, and writes NOTHING', async () => {
    seedTwoAnchors();

    // "Today" is the 29th Pacific; the count is the 28th's.
    const nextDay = new Date('2026-07-29T17:00:00.000Z');
    const err = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      now: nextDay,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SnapshotVoidAmendmentRequiredError);
    const e = err as SnapshotVoidAmendmentRequiredError;
    expect(e.status).toBe(409);
    expect(e.toBody()).toEqual({
      error: 'requires_amendment',
      snapshotId: 'snap-today',
      countedDate: '2026-07-28',
      today: '2026-07-29',
      physicalTotal: 2_483,
    });

    // Refused, not partially applied: no stamp, no audit row, and — the point of
    // the "shaped like, not routed into" rule — no amendment request anywhere.
    expect(db.snapshots.find((s) => s.id === 'snap-today')?.voided_at).toBeNull();
    expect(voidAuditRows()).toHaveLength(0);
    expect((await onHand(SITE, nextDay)).total.toString()).toBe('2483');
  });
});

describe('F3 — "today" is PACIFIC at the UTC rollover', () => {
  it('voids the Pacific-28th count at 2026-07-29T01:00:00Z (18:00 PT on the 28th)', async () => {
    seedTwoAnchors();

    // Sanity: the instant really has rolled in UTC while Pacific has not.
    expect(EVENING_OF_JUL28.toISOString().slice(0, 10)).toBe('2026-07-29');

    const result = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      now: EVENING_OF_JUL28,
    }).catch((e: unknown) => e);

    // The failure message must name the day the code actually believed it was,
    // so a regression reads as "it thought today was the 29th" rather than as a
    // bare rejected promise.
    if (result instanceof SnapshotVoidAmendmentRequiredError) {
      throw new Error(
        `void refused at 2026-07-29T01:00:00Z: the count is dated ${result.toBody().countedDate} ` +
          `and the server believed today was ${result.toBody().today} — it must be 2026-07-28 ` +
          `(18:00 Pacific). Something is reading UTC or server-local instead of Pacific.`,
      );
    }
    expect((result as { alreadyVoided: boolean }).alreadyVoided).toBe(false);
    expect((await onHand(SITE, EVENING_OF_JUL28)).total.toString()).toBe('2000');
  });

  it('the voidable list uses the same Pacific window', async () => {
    seedTwoAnchors();
    const rows = await listTodaysVoidableCountsAtSite(SITE, JT, EVENING_OF_JUL28);
    expect(rows.map((r) => r.id)).toEqual(['snap-today']);
  });
});

describe('F4 — the missed-reader falsification', () => {
  it('strips the filter and the voided count comes back, naming its total', async () => {
    // Drives the SAME evaluator every reader runs on, once with the filter and
    // once without, so the difference is attributable to the where-clause and
    // nothing else. This is what proves the fake discriminates rather than
    // enforcing the rule under test: with the filter removed, the withdrawn
    // 2,483 is what a reader gets back.
    seedTwoAnchors();
    await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      now: MIDDAY_JUL28,
    });

    const delegate = snapshotDelegate() as {
      findFirst: (a: unknown) => Promise<SnapRow | null>;
    };
    const ORDER = [{ snapshot_at: 'desc' }, { created_at: 'desc' }];

    const filtered = await delegate.findFirst({
      where: { ...NOT_VOIDED, site_id: SITE, snapshot_kind: 'physical' },
      orderBy: ORDER,
    });
    const unfiltered = await delegate.findFirst({
      where: { site_id: SITE, snapshot_kind: 'physical' },
      orderBy: ORDER,
    });

    expect(filtered?.id).toBe('snap-prior');
    expect(filtered?.units_total).toBe(2_000);
    // The failure a missed reader produces, stated as a value: the anchor is the
    // withdrawn 2,483.
    expect(unfiltered?.id).toBe('snap-today');
    expect(unfiltered?.units_total).toBe(2_483);
    expect(unfiltered?.voided_at).toBeInstanceOf(Date);
  });

  it('the shipped onHand is on the filtered side of that difference', async () => {
    seedTwoAnchors();
    await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      now: MIDDAY_JUL28,
    });
    const balance = await onHand(SITE, MIDDAY_JUL28);
    expect(
      balance.total.equals(new Prisma.Decimal(2_000)),
      `onHand anchored on ${balance.total.toString()}; 2483 means the void filter is missing from ` +
        `running-balance.ts and the floor is computed from a withdrawn count`,
    ).toBe(true);
  });
});

describe('F5 — a double-tap void is idempotent', () => {
  it('second call succeeds, row unchanged, exactly ONE audit row', async () => {
    seedTwoAnchors();
    const KEY = 'q_0000000000000000000000000';

    const first = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      idempotencyKey: KEY,
      now: MIDDAY_JUL28,
    });
    const stampedAt = db.snapshots.find((s) => s.id === 'snap-today')?.voided_at;

    // The same key again — the ADR-0078 replay path.
    const second = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      idempotencyKey: KEY,
      now: new Date(MIDDAY_JUL28.getTime() + 5_000),
    });

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.voidedAt).toBe(first.voidedAt);
    // Not re-stamped with the later clock.
    expect(db.snapshots.find((s) => s.id === 'snap-today')?.voided_at).toBe(stampedAt);
    // An append-only log that grows one row per redundant tap stops being a record.
    expect(voidAuditRows()).toHaveLength(1);
    expect((await onHand(SITE, MIDDAY_JUL28)).total.toString()).toBe('2000');
  });

  it('a DIFFERENT key naming an already-voided row is a no-op success, not an error', async () => {
    seedTwoAnchors();
    await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      idempotencyKey: 'q_1111111111111111111111111',
      now: MIDDAY_JUL28,
    });
    const again = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      idempotencyKey: 'q_2222222222222222222222222',
      now: MIDDAY_JUL28,
    });
    expect(again.alreadyVoided).toBe(true);
    expect(voidAuditRows()).toHaveLength(1);
  });
});

describe('F6 — the bootstrap gate does not count a voided anchor as evidence', () => {
  it('a site whose ONLY physical count was voided is NOT snapshot-live', async () => {
    db.snapshots = [snap({ id: 'snap-only', units_total: 1_200 })];
    db.audit = [entered('snap-only', JT)];

    const liveBefore = await resolveLegLiveness(client() as never, SITE, MIDDAY_JUL28);
    expect(liveBefore.isLive('snapshot')).toBe(true);

    await voidSnapshot({
      snapshotId: 'snap-only',
      actorUserId: JT,
      siteId: SITE,
      now: MIDDAY_JUL28,
    });

    // A bare `count()` that still sees the voided row would switch M2 on for a
    // site with NO live anchor — the audit then reports a missing-snapshot
    // finding against a site that has never successfully counted, which is the
    // bootstrap noise this gate exists to suppress.
    const liveAfter = await resolveLegLiveness(client() as never, SITE, MIDDAY_JUL28);
    expect(liveAfter.isLive('snapshot')).toBe(false);
  });
});

describe('authorization', () => {
  it('a snapshot from another site is a 404, not a 403 (hard rule #2, no id probing)', async () => {
    db.snapshots = [snap({ id: 'snap-wood', site_id: OTHER_SITE, units_total: 900 })];
    db.audit = [entered('snap-wood', JT)];
    const err = await voidSnapshot({
      snapshotId: 'snap-wood',
      actorUserId: JT,
      siteId: SITE,
      now: MIDDAY_JUL28,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotNotFoundError);
    expect((err as SnapshotNotFoundError).status).toBe(404);
  });

  it('the voidable list drops a count once it is voided', async () => {
    db.snapshots = [snap({ id: 'snap-jt', units_total: 100 })];
    db.audit = [entered('snap-jt', JT)];
    await voidSnapshot({ snapshotId: 'snap-jt', actorUserId: JT, siteId: SITE, now: MIDDAY_JUL28 });
    expect(await listTodaysVoidableCountsAtSite(SITE, JT, MIDDAY_JUL28)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ADR-0084 Amendment 1 — the gate is SITE-scoped, not OWNER-scoped
//
// Bill, 2026-08-08: "Widen to site." These replace the deleted
// `an operator cannot void a count someone else entered (403)` case, which
// pinned the behaviour this amendment removes.
// ─────────────────────────────────────────────────────────────────────────

describe('Am1 — a cross-operator same-day void at the same site SUCCEEDS', () => {
  it('voids JT’s count for Maria, moves the anchor, and records BOTH ids', async () => {
    seedTwoAnchors(); // 'snap-today' (2,483) was entered by JT.

    expect((await onHand(SITE, MIDDAY_JUL28)).total).toStrictEqual(new Prisma.Decimal(2_483));

    // Maria — a DIFFERENT operator at the same site — withdraws it.
    const result = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: MARIA,
      siteId: SITE,
      idempotencyKey: null,
      now: MIDDAY_JUL28,
    });

    expect(result.alreadyVoided).toBe(false);
    expect(result.physicalTotal).toBe(2_483);
    expect(result.enteredByUserId).toBe(JT);
    expect(result.crossOperator).toBe(true);

    // The floor really moved back to the prior anchor — the void was applied,
    // not merely accepted.
    expect((await onHand(SITE, MIDDAY_JUL28)).total).toStrictEqual(new Prisma.Decimal(2_000));
    expect(db.snapshots.find((s) => s.id === 'snap-today')?.voided_by).toBe(MARIA);

    // THE AMENDMENT'S OWN CLAIM: the audit row carries BOTH ids, so the history
    // says who withdrew WHOSE count. An audit row naming only Maria would make
    // a cross-operator void indistinguishable from her withdrawing her own.
    expect(voidAuditRows()).toHaveLength(1);
    const audit = voidAuditRows()[0] as AuditRow;
    expect(audit.actor_user_id).toBe(MARIA); // who withdrew it
    expect(audit.after).toMatchObject({
      voided_by: MARIA,
      entered_by: JT, // whose count it was
      cross_operator: true,
      physical_total: 2_483,
    });
  });

  it('records both ids on a SELF void too, so an absent field is never ambiguous', async () => {
    seedTwoAnchors();
    const result = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: JT,
      siteId: SITE,
      now: MIDDAY_JUL28,
    });
    expect(result.crossOperator).toBe(false);
    expect(result.enteredByUserId).toBe(JT);
    expect((voidAuditRows()[0] as AuditRow).after).toMatchObject({
      voided_by: JT,
      entered_by: JT,
      cross_operator: false,
    });
  });

  it('FALSIFICATION — the site check is the only thing refusing a cross-SITE void', async () => {
    // The amendment removed the OWNER check and kept the SITE check. This proves
    // the remaining refusal is the site comparison and not a leftover of the
    // ownership one: the actor here ENTERED the count (so an owner check would
    // have let it through) and is still refused, because the count is Woodland's
    // and the session is Eugene's.
    db.snapshots = [snap({ id: 'snap-wood', site_id: OTHER_SITE, units_total: 900 })];
    db.audit = [entered('snap-wood', JT)];

    const err = await voidSnapshot({
      snapshotId: 'snap-wood',
      actorUserId: JT, // the ORIGINAL enterer
      siteId: SITE, // ...signed in at the other site
      now: MIDDAY_JUL28,
    }).catch((e: unknown) => e);

    if (!(err instanceof SnapshotNotFoundError)) {
      // Name the site, so deleting the site check reads as "Eugene's session
      // voided Woodland's count" rather than as a bare unresolved promise.
      throw new Error(
        `a session at site "${SITE}" was allowed to void snapshot "snap-wood", which belongs to ` +
          `site "${OTHER_SITE}" — hard rule #2 (separate MRC contracts, separate jurisdictions) ` +
          `requires a 404 here. ADR-0084 Amendment 1 widened the gate from owner to SITE; it did ` +
          `not remove the site check.`,
      );
    }
    expect(err.status).toBe(404);
    expect(db.snapshots.find((s) => s.id === 'snap-wood')?.voided_at).toBeNull();
    expect(voidAuditRows()).toHaveLength(0);
  });

  it('a cross-operator PRIOR-day void is still refused 409 (same-day is unchanged)', async () => {
    seedTwoAnchors();
    const nextDay = new Date('2026-07-29T17:00:00.000Z');
    const err = await voidSnapshot({
      snapshotId: 'snap-today',
      actorUserId: MARIA,
      siteId: SITE,
      now: nextDay,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SnapshotVoidAmendmentRequiredError);
    expect((err as SnapshotVoidAmendmentRequiredError).status).toBe(409);
    expect(db.snapshots.find((s) => s.id === 'snap-today')?.voided_at).toBeNull();
    expect(voidAuditRows()).toHaveLength(0);
  });
});

describe('Am1 — the voidable list is site-scoped and labels whose count it is', () => {
  it("offers a colleague's count, flagged isMine:false with the enterer named", async () => {
    db.snapshots = [
      snap({ id: 'snap-jt', units_total: 100 }),
      snap({ id: 'snap-maria', units_total: 200 }),
    ];
    db.audit = [entered('snap-jt', JT), entered('snap-maria', MARIA)];

    const rows = await listTodaysVoidableCountsAtSite(SITE, JT, MIDDAY_JUL28);

    // Both, not just JT's — that is the amendment.
    expect(rows.map((r) => r.id).sort()).toEqual(['snap-jt', 'snap-maria']);
    const mine = rows.find((r) => r.id === 'snap-jt');
    const theirs = rows.find((r) => r.id === 'snap-maria');
    expect(mine).toMatchObject({ isMine: true, enteredByUserId: JT });
    // The label the confirm screen needs: it must be able to NAME the person
    // whose count is about to be withdrawn.
    expect(theirs).toMatchObject({ isMine: false, enteredByUserId: MARIA });
  });

  it('never offers another SITE’s count', async () => {
    db.snapshots = [
      snap({ id: 'snap-jt', units_total: 100 }),
      snap({ id: 'snap-wood', site_id: OTHER_SITE, units_total: 900 }),
    ];
    db.audit = [entered('snap-jt', JT), entered('snap-wood', MARIA)];
    const rows = await listTodaysVoidableCountsAtSite(SITE, JT, MIDDAY_JUL28);
    expect(rows.map((r) => r.id)).toEqual(['snap-jt']);
  });

  it('leaves the enterer null rather than guessing when no insert row exists', async () => {
    // A system-written snapshot has no operator insert row. NULL is "we do not
    // know", which is true — the same reasoning ADR-0078 Am.1 applied to
    // `uploaded_by` rather than backfilling from the assigned operator.
    db.snapshots = [snap({ id: 'snap-system', units_total: 300 })];
    db.audit = [];
    const rows = await listTodaysVoidableCountsAtSite(SITE, JT, MIDDAY_JUL28);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enteredByUserId: null, isMine: false });

    // ...and it is still voidable, with the unknown enterer recorded as unknown.
    const result = await voidSnapshot({
      snapshotId: 'snap-system',
      actorUserId: JT,
      siteId: SITE,
      now: MIDDAY_JUL28,
    });
    expect(result.enteredByUserId).toBeNull();
    expect(result.crossOperator).toBe(false);
    expect((voidAuditRows()[0] as AuditRow).after).toMatchObject({ entered_by: null });
  });
});
