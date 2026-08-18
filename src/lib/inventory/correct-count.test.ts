// ADR-0105 — the falsifications for the manager count correction.
//
// ## Why the fake prisma here is not a mock reading itself back
//
// Same construction, and the same reason, as `void-count.test.ts`: the client is
// a GENERIC where/orderBy evaluator over in-memory arrays with no knowledge of
// `voided_at`, `snapshot_kind` or any other column this feature cares about. The
// `voided_at: null` filter is matched by the same `value === null` branch that
// would match `import_id: null`. So the only thing deciding whether a corrected
// row drops out of `onHand` is whether `onHand`'s OWN where-clause carries
// `NOT_VOIDED`, and the only thing deciding whether a correction is refused is
// the service's own gate.
//
// ## One thing this fake models that the sibling's does not: ROLLBACK
//
// `$transaction` here snapshots the tables, runs the callback, and RESTORES them
// if it throws. That is load-bearing rather than decorative — the claim
// "a correction cannot be written without its audit" is a claim about what
// SURVIVES an abort, and a fake that commits partial work regardless would report
// green while the real database rolled back (or, worse, would report green while
// a real database COMMITTED the half-written state this test exists to forbid).
// The rollback is modelled; the throw that triggers it is the thing under test.
//
// A real Postgres would be better still — `snapshot-void.db.test.ts` is the model
// — and is not reachable here (no Postgres on this host, `DR3_TEST_DATABASE_URL`
// unset). Numeric assertions use real `Prisma.Decimal`.

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
  /**
   * Injection points, so a race can be reproduced at the exact instant it
   * happens rather than approximated by pre-staging state.
   * `afterEnteredByRead` fires on the audit `findFirst` the service uses to
   * resolve the original enterer — i.e. after it has seen a LIVE row and before
   * its `NOT_VOIDED`-guarded `updateMany`.
   */
  hooks: { afterEnteredByRead: null as null | (() => void) },
};

const num = (v: unknown): number => (v instanceof Date ? v.getTime() : (v as number));

/**
 * A generic Prisma where-matcher with NO knowledge of any specific column.
 * `voided_at: null` goes through the same `null` branch as any other nullable
 * field — which is what makes the filter assertions in this file real.
 */
function matches(row: object, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
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
    // Present ONLY so the "never a hard delete" falsification is real. Without
    // it, breaking the service to delete the corrected row fails with
    // `deleteMany is not a function` — which is the FAKE refusing, not the
    // assertion catching. A guard that goes red because the double is missing a
    // method has not tested the claim it is named after.
    deleteMany: async (a: { where: Record<string, unknown> }) => {
      const keep = db.snapshots.filter((r) => !matches(r, a.where));
      const removed = db.snapshots.length - keep.length;
      db.snapshots = keep;
      return { count: removed };
    },
    create: async ({ data }: { data: Partial<SnapRow> }) => {
      const row = {
        id: `snap-new-${++db.seq}`,
        // A real insert stamps `created_at` at insert time. Modelled, because the
        // `created_at DESC` tiebreak is how the corrected row beats the row it
        // corrects when both carry the same `snapshot_at` (ADR-0078 D1).
        created_at: new Date(Date.now()),
        units_indoor: null,
        units_total: null,
        units_in_processing: 0,
        program_units: null,
        non_program_units: null,
        pool_attribution: 'measured',
        source: 'manual',
        import_id: null,
        reconciled_delta: null,
        voided_at: null,
        voided_by: null,
        ...data,
      } as SnapRow;
      db.snapshots.push(row);
      return row;
    },
  };
}

function auditDelegate(): Record<string, unknown> {
  return {
    findFirst: async (a: { where?: Record<string, unknown>; orderBy?: OrderBy | OrderBy[] }) => {
      const row =
        sorted(
          db.audit.filter((r) => matches(r, a?.where)),
          a?.orderBy,
        )[0] ?? null;
      // Fires AFTER the read returns, so the service has already resolved the
      // enterer from a live row — see `db.hooks`.
      const hook = db.hooks.afterEnteredByRead;
      if (hook) {
        db.hooks.afterEnteredByRead = null;
        hook();
      }
      return row;
    },
    findMany: async (a: { where?: Record<string, unknown>; orderBy?: OrderBy | OrderBy[] }) =>
      sorted(
        db.audit.filter((r) => matches(r, a?.where)),
        a?.orderBy,
      ),
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
          // JSONB round-trip exactly as Postgres would — Dates become strings.
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

/**
 * ROLLBACK, modelled. The callback sees the live arrays (so a read-back inside
 * the transaction sees its own uncommitted writes, which `assertCorrectionAudited`
 * depends on); on a throw the tables are restored to their pre-call contents.
 * Rows are shallow-copied so an in-place `Object.assign` from `updateMany` — how
 * the void stamp lands — is undone too, not just an append.
 */
function transactionally<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const snapBefore = db.snapshots.map((r) => ({ ...r }));
  const auditBefore = db.audit.map((r) => ({ ...r }));
  const idemBefore = new Map(db.idem);
  return fn(client()).catch((e: unknown) => {
    db.snapshots = snapBefore;
    db.audit = auditBefore;
    db.idem = idemBefore;
    throw e;
  });
}

function client(): Record<string, unknown> {
  return {
    siteInventorySnapshot: snapshotDelegate(),
    auditLog: auditDelegate(),
    ...rawDelegates(),
    // `onHand`'s flow aggregates, zeroed: the assertions are about WHICH ANCHOR
    // was selected, and folding in flow the fake does not window correctly would
    // measure the fake instead of the code.
    inboundLoad: { aggregate: async () => EMPTY_SUM },
    consumerDropoff: { aggregate: async () => EMPTY_SUM },
    processedUnitsDaily: { aggregate: async () => EMPTY_SUM, count: async () => 0 },
    outboundMaterial: { aggregate: async () => EMPTY_SUM },
    landfilledUnit: { aggregate: async () => EMPTY_SUM },
    invoice: { count: async () => 0 },
    outboundMaterialPayment: { count: async () => 0 },
    auditBootstrapGate: { findMany: async () => [] },
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => transactionally(fn),
  };
}

vi.mock('@/lib/prisma', () => ({ prisma: client() }));

import { onHand, PoolSplitMismatchError } from './running-balance';
import { SnapshotNotFoundError, SnapshotNotPhysicalError } from './void-count';
import {
  correctPhysicalCount,
  listWindowCountsAtSite,
  pacificCorrectionWindow,
  CORRECTION_REASON,
  CorrectionUnauditedError,
  CountCorrectionConflictError,
  CountCorrectionNoChangeError,
  CountCorrectionOutsideWindowError,
  SnapshotAlreadyVoidedError,
} from './correct-count';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const SITE = 'site-eugene';
const OTHER_SITE = 'site-woodland';
/** The operator who took the count. */
const JT = 'user-jt';
/** The manager who corrects it. */
const MORENA = 'user-morena';

/** Pacific midnights (PDT, UTC−7) — where ADR-0060 D-3 stores a count. */
const PT_JUL26 = new Date('2026-07-26T07:00:00.000Z');
const PT_JUL27 = new Date('2026-07-27T07:00:00.000Z');
const PT_JUL28 = new Date('2026-07-28T07:00:00.000Z');

/** 10:00 PT on the 28th. Window = [Jul 27 00:00 PT, Jul 29 00:00 PT). */
const MIDDAY_JUL28 = new Date('2026-07-28T17:00:00.000Z');
/**
 * THE UTC-ROLLOVER TRAP: 18:00 PT on the 28th, by which time UTC has already
 * rolled to the 29th. Any UTC or server-local notion of "today" gets this wrong.
 */
const EVENING_OF_JUL28 = new Date('2026-07-29T01:00:00.000Z');

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

/** The count JT entered, plus the insert audit row that records he entered it. */
function seedOperatorCount(
  over: Partial<SnapRow> & { id: string },
  enteredBy: string | null = JT,
): SnapRow {
  const row = snap(over);
  db.snapshots.push(row);
  if (enteredBy !== null) {
    db.audit.push({
      id: `audit-seed-${row.id}`,
      table_name: 'site_inventory_snapshots',
      row_id: row.id,
      action: 'insert',
      actor_user_id: enteredBy,
      actor_label: null,
      created_at: new Date(row.created_at.getTime()),
      before: null,
      after: { snapshot_kind: 'physical' },
    });
  }
  return row;
}

const correctionRowFor = (id: string): AuditRow | undefined =>
  db.audit.find((a) => a.row_id === id && a.action === 'update');

/**
 * The fields ADR-0105 promises on a correction's audit payload. Declared rather
 * than reached for through an index signature so a RENAMED field is a typecheck
 * failure here, not an `undefined` that quietly satisfies `toBeUndefined()`.
 */
interface CorrectionPayload {
  physical_total?: number;
  units_total?: number | null;
  units_in_processing?: number;
  reconciled_delta?: number | null;
  voided_at?: string | null;
  voided_by?: string | null;
  corrected_to?: string;
  corrected_from?: string;
  corrected_by?: string;
  entered_by?: string | null;
  counted_by?: string | null;
  cross_operator?: boolean;
  reason?: string;
}

const after = (r: AuditRow | undefined): CorrectionPayload => (r?.after ?? {}) as CorrectionPayload;
const before = (r: AuditRow | undefined): CorrectionPayload =>
  (r?.before ?? {}) as CorrectionPayload;

beforeEach(() => {
  db.snapshots = [];
  db.audit = [];
  db.idem = new Map();
  db.seq = 0;
  db.hooks.afterEnteredByRead = null;
});

// ═════════════════════════════════════════════════════════════════════════
// F1 — today's count: corrected, audited, prior value RETAINED
// ═════════════════════════════════════════════════════════════════════════

describe("F1 — a manager corrects TODAY's count", () => {
  it('makes the corrected value authoritative and KEEPS the prior one', async () => {
    seedOperatorCount({ id: 'snap-today', units_total: 2_483, reconciled_delta: 17 });

    // The mistyped count is the anchor while it stands.
    expect((await onHand(SITE, MIDDAY_JUL28)).total).toStrictEqual(new Prisma.Decimal(2_483));

    const result = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 2_438, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });

    expect(result.fromPhysicalTotal).toBe(2_483);
    expect(result.toPhysicalTotal).toBe(2_438);
    expect(result.correctedFromSnapshotId).toBe('snap-today');
    expect(result.snapshotId).not.toBe('snap-today');

    // The floor now computes from the corrected number.
    const balance = await onHand(SITE, MIDDAY_JUL28);
    expect(
      balance.total.equals(new Prisma.Decimal(2_438)),
      `onHand anchored on ${balance.total.toString()}; 2483 means the corrected row is not the ` +
        `anchor, and the floor is still computed from the number the manager replaced`,
    ).toBe(true);

    // NEVER a hard delete: the row is still there, every counted value intact.
    const original = db.snapshots.find((r) => r.id === 'snap-today');
    expect(original).toBeDefined();
    expect(original!.units_total).toBe(2_483);
    expect(original!.units_in_processing).toBe(0);
    expect(original!.reconciled_delta).toBe(17);
    expect(original!.voided_at).toBeInstanceOf(Date);
    expect(original!.voided_by).toBe(MORENA);
  });

  it('preserves the computed BASELINE in reconciled_delta rather than re-deriving it', async () => {
    // The original recorded `delta = physical − computed` = 17, so the running
    // balance predicted 2,466. The correction says the COUNT was mis-keyed, not
    // that the floor moved, so the same baseline must hold: 2,438 − 2,466 = −28.
    seedOperatorCount({ id: 'snap-today', units_total: 2_483, reconciled_delta: 17 });

    const result = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 2_438, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });

    expect(result.reconciledDelta).toBe(-28);
    expect(db.snapshots.find((r) => r.id === result.snapshotId)!.reconciled_delta).toBe(-28);

    // THE TRAP, executed rather than described. Re-deriving the delta through
    // `onHand(site, countedAt)` — which is what `reconcilePhysicalCount` does —
    // anchors on the row being corrected: it ties on `snapshot_at` and wins the
    // `created_at DESC` tiebreak, and the soft-void is invisible to it because
    // that read runs outside this transaction. So the naive delta would be
    // `2438 − 2483 = −45`: the SIZE OF THE TYPO recorded where the drift against
    // the running balance belongs, on the column the C6 `physical_reconcile`
    // audit finding reads.
    expect(result.reconciledDelta).not.toBe(-45);
  });

  it('a legacy NULL delta stays NULL — never backfilled from anything', async () => {
    seedOperatorCount({ id: 'snap-today', units_total: 100, reconciled_delta: null });
    const result = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 120, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    expect(result.reconciledDelta).toBeNull();
  });

  it('the corrected row keeps the ORIGINAL counted day, not today', async () => {
    // Edit IN PLACE. Stamping `now` would move a count onto a different Pacific
    // day and re-attribute that day's flows to it.
    seedOperatorCount({ id: 'snap-yday', snapshot_at: PT_JUL27, units_total: 900 });
    const result = await correctPhysicalCount({
      snapshotId: 'snap-yday',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 950, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    expect(db.snapshots.find((r) => r.id === result.snapshotId)!.snapshot_at.toISOString()).toBe(
      PT_JUL27.toISOString(),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F2 — the audit row carries WHO / WHEN / FROM / TO, tied to the operator
// ═════════════════════════════════════════════════════════════════════════

describe('F2 — the correction is audited at the STORAGE layer', () => {
  it('records who changed it, when, from what, to what, and whose entry it was', async () => {
    seedOperatorCount({ id: 'snap-today', units_total: 2_483, reconciled_delta: 17 });

    const result = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 2_438, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });

    const row = correctionRowFor('snap-today');
    expect(row).toBeDefined();

    // WHO — both in the actor column and in the payload.
    expect(row!.actor_user_id).toBe(MORENA);
    expect(after(row).corrected_by).toBe(MORENA);
    // WHOSE ENTRY — tied to the original operator's insert row.
    expect(after(row).entered_by).toBe(JT);
    expect(after(row).cross_operator).toBe(true);
    // WHEN.
    expect(after(row).voided_at).toBe(MIDDAY_JUL28.toISOString());
    // FROM → TO.
    expect(before(row).physical_total).toBe(2_483);
    expect(after(row).physical_total).toBe(2_438);
    expect(before(row).units_total).toBe(2_483);
    expect(after(row).units_total).toBe(2_438);
    expect(before(row).reconciled_delta).toBe(17);
    expect(after(row).reconciled_delta).toBe(-28);
    // The link forward to the row that supersedes it.
    expect(after(row).corrected_to).toBe(result.snapshotId);
    expect(after(row).reason).toBe(CORRECTION_REASON);

    // And the NEW row carries an insert row, so `resolveCounter` and every other
    // provenance reader still resolves a corrected snapshot instead of null.
    const ins = db.audit.find((a) => a.row_id === result.snapshotId && a.action === 'insert');
    expect(ins).toBeDefined();
    expect(ins!.actor_user_id).toBe(MORENA);
    expect(after(ins).corrected_from).toBe('snap-today');
    expect(after(ins).counted_by).toBe(JT);
  });

  it('both ids are written even when the manager corrects their OWN entry', async () => {
    // Unconditional, exactly as ADR-0084 Am.1 argued: a field present only on the
    // cross-operator case is ambiguous between "the same person" and "an older
    // build that did not record it", read years later by someone with neither the
    // code nor the deploy dates.
    seedOperatorCount({ id: 'snap-today', units_total: 10 }, MORENA);
    await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 12, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    const row = correctionRowFor('snap-today');
    expect(after(row).entered_by).toBe(MORENA);
    expect(after(row).cross_operator).toBe(false);
  });

  it('a system-written snapshot has entered_by NULL, not a substitute', async () => {
    seedOperatorCount({ id: 'snap-sys', units_total: 500 }, null);
    const result = await correctPhysicalCount({
      snapshotId: 'snap-sys',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 505, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    expect(result.enteredByUserId).toBeNull();
    expect(after(correctionRowFor('snap-sys')).entered_by).toBeNull();
    expect(after(correctionRowFor('snap-sys')).corrected_by).toBe(MORENA);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F3 — the storage layer REFUSES an unaudited write
// ═════════════════════════════════════════════════════════════════════════

describe('F3 — a correction cannot be written without its audit', () => {
  it('aborts the whole transaction when the audit rows do not land', async () => {
    // The unaudited write path, constructed so it can be tested: an audit writer
    // that accepts the row and writes nothing. This is precisely the shape of the
    // failure that recurs in this codebase — the audit call is refactored away,
    // the state change still lands, every test about the state change still
    // passes, and only the record is gone. Here it must NOT land.
    seedOperatorCount({ id: 'snap-today', units_total: 2_483, reconciled_delta: 17 });

    await expect(
      correctPhysicalCount({
        snapshotId: 'snap-today',
        actorUserId: MORENA,
        siteId: SITE,
        corrected: { units_total: 2_438, units_in_processing: 0 },
        poolAttribution: 'legacy',
        now: MIDDAY_JUL28,
        auditWriter: async () => {
          /* writes nothing — the defect under test */
        },
      }),
    ).rejects.toBeInstanceOf(CorrectionUnauditedError);

    // NOTHING survived: no soft-void stamp, no corrected row, no audit row.
    const original = db.snapshots.find((r) => r.id === 'snap-today');
    expect(
      original!.voided_at,
      'the void stamp survived an unaudited correction — the anchor was withdrawn ' +
        'with no record of who withdrew it or why',
    ).toBeNull();
    expect(db.snapshots).toHaveLength(1);
    expect(db.audit.filter((a) => a.action === 'update')).toHaveLength(0);

    // And the floor is untouched.
    expect((await onHand(SITE, MIDDAY_JUL28)).total).toStrictEqual(new Prisma.Decimal(2_483));
  });

  it('names WHICH audit row was missing, so the abort is diagnosable', async () => {
    seedOperatorCount({ id: 'snap-today', units_total: 10 });
    // Writes the INSERT row and drops the UPDATE row — the half-audited case,
    // which a single "did we write anything?" check would wave through.
    await expect(
      correctPhysicalCount({
        snapshotId: 'snap-today',
        actorUserId: MORENA,
        siteId: SITE,
        corrected: { units_total: 12, units_in_processing: 0 },
        poolAttribution: 'legacy',
        now: MIDDAY_JUL28,
        auditWriter: async (tx, r) => {
          if (r.action === 'insert') await tx.auditLog.create({ data: r });
        },
      }),
    ).rejects.toThrow(/update row for snap-today/);
    expect(db.snapshots.find((r) => r.id === 'snap-today')!.voided_at).toBeNull();
  });

  it('the guard is not vacuous — the REAL writer satisfies it', async () => {
    // Without this, the two tests above would pass against a service that always
    // threw, and the check would be measuring nothing.
    seedOperatorCount({ id: 'snap-today', units_total: 10 });
    await expect(
      correctPhysicalCount({
        snapshotId: 'snap-today',
        actorUserId: MORENA,
        siteId: SITE,
        corrected: { units_total: 12, units_in_processing: 0 },
        poolAttribution: 'legacy',
        now: MIDDAY_JUL28,
      }),
    ).resolves.toMatchObject({ toPhysicalTotal: 12 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F4 — the window: today + yesterday, PACIFIC. Two days back is refused.
// ═════════════════════════════════════════════════════════════════════════

describe('F4 — the Pacific two-day window', () => {
  it("corrects YESTERDAY's count", async () => {
    seedOperatorCount({ id: 'snap-yday', snapshot_at: PT_JUL27, units_total: 1_200 });
    const result = await correctPhysicalCount({
      snapshotId: 'snap-yday',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 1_020, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    expect(result.toPhysicalTotal).toBe(1_020);
    expect(db.snapshots.find((r) => r.id === 'snap-yday')!.voided_at).toBeInstanceOf(Date);
    expect(after(correctionRowFor('snap-yday')).physical_total).toBe(1_020);
  });

  it('REFUSES a count two Pacific days back, and writes nothing', async () => {
    seedOperatorCount({ id: 'snap-2back', snapshot_at: PT_JUL26, units_total: 700 });

    const err = await correctPhysicalCount({
      snapshotId: 'snap-2back',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 750, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CountCorrectionOutsideWindowError);
    const e = err as CountCorrectionOutsideWindowError;
    expect(e.status).toBe(409);
    const body = e.toBody();
    expect(body).toMatchObject({
      error: 'outside_correction_window',
      snapshotId: 'snap-2back',
      countedDate: '2026-07-26',
      today: '2026-07-28',
      earliestCorrectableDate: '2026-07-27',
      physicalTotal: 700,
    });
    // The message must be actionable on its own — a manager reading only this
    // learns the rule and where to go instead.
    expect(body.message).toContain('2026-07-27');
    expect(body.message).toContain('/admin/inventory/anchors');

    // Nothing written: no stamp, no new row, no audit row.
    expect(db.snapshots).toHaveLength(1);
    expect(db.snapshots[0]!.voided_at).toBeNull();
    expect(db.audit.filter((a) => a.action === 'update')).toHaveLength(0);
  });

  it('"today" is PACIFIC at the UTC rollover, not UTC and not server-local', async () => {
    // At 2026-07-29T01:00:00Z it is 18:00 PT on the 28th. A UTC or server-local
    // "today" reads the 29th, which makes the 26th "two days back" — so a count
    // from the 27th (genuinely yesterday) would be REFUSED, and one from the 29th
    // (which has not happened yet) accepted.
    seedOperatorCount({ id: 'snap-27', snapshot_at: PT_JUL27, units_total: 300 });
    const result = await correctPhysicalCount({
      snapshotId: 'snap-27',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 330, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: EVENING_OF_JUL28,
    });
    expect(
      result.toPhysicalTotal,
      'the Pacific-27th count was refused at 18:00 PT on the 28th — the server ' +
        'believed the day had already rolled',
    ).toBe(330);
    expect((await onHand(SITE, EVENING_OF_JUL28)).total.toString()).toBe('330');
  });

  it('the window is DST-correct on the FALL-BACK day (a 25-hour Pacific day)', async () => {
    // 2026-11-01 is the fall-back. The two-day window spans Oct 31 (24h) + Nov 1
    // (25h) = 49h. The naive `start - 86_400_000` construction yields 48h and,
    // on the helper's own measured defect, can collapse to a zero-width bound —
    // which in a path that restates a billing anchor drops every row in range.
    const w = pacificCorrectionWindow(new Date('2026-11-01T19:00:00.000Z'));
    const hours = (w.endExclusive.getTime() - w.start.getTime()) / 3_600_000;
    expect(hours, `two-day Pacific window measured ${hours}h across the fall-back`).toBe(49);
  });

  it('the screen LIST uses the same window as the service', async () => {
    // They must agree by construction, or the screen offers a row the service
    // then refuses.
    seedOperatorCount({ id: 'snap-today', units_total: 1 });
    seedOperatorCount({ id: 'snap-yday', snapshot_at: PT_JUL27, units_total: 2 });
    seedOperatorCount({ id: 'snap-2back', snapshot_at: PT_JUL26, units_total: 3 });
    const rows = await listWindowCountsAtSite(SITE, MIDDAY_JUL28);
    expect(rows.map((r) => r.id).sort()).toEqual(['snap-today', 'snap-yday']);
    expect(rows.find((r) => r.id === 'snap-yday')!.countedDayISO).toBe('2026-07-27');
    expect(rows.every((r) => r.enteredByUserId === JT)).toBe(true);
    expect(rows.every((r) => r.correctable)).toBe(true);
  });

  it('a corrected row stays VISIBLE but stops being correctable, and names its successor', async () => {
    // The screen must still show what the corrected count was corrected FROM —
    // dropping it would make the retained prior value invisible to the only
    // people who can act on it, which is the soft-void discipline defeated by
    // the UI rather than by the database.
    seedOperatorCount({ id: 'snap-today', units_total: 1 });
    const result = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 5, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });

    const rows = await listWindowCountsAtSite(SITE, MIDDAY_JUL28);
    expect(rows.map((r) => r.id).sort()).toEqual([result.snapshotId, 'snap-today'].sort());

    const old = rows.find((r) => r.id === 'snap-today')!;
    expect(old.correctable).toBe(false);
    expect(old.voidReason).toBe('corrected');
    expect(old.correctedToId).toBe(result.snapshotId);
    expect(old.voidedByUserId).toBe(MORENA);
    expect(old.physicalTotal, 'the prior value must still be readable').toBe(1);

    const live = rows.find((r) => r.id === result.snapshotId)!;
    expect(live.correctable).toBe(true);
    expect(live.isCorrection).toBe(true);
    expect(live.correctedFromId).toBe('snap-today');
  });

  it('distinguishes a floor WITHDRAWAL from a correction — the column cannot', async () => {
    // `voided_at` carries both meanings by design (D1). Only the audit row's
    // reason can tell them apart, and the screen has to say which one happened.
    seedOperatorCount({
      id: 'snap-withdrawn',
      units_total: 7,
      voided_at: MIDDAY_JUL28,
      voided_by: JT,
    });
    const rows = await listWindowCountsAtSite(SITE, MIDDAY_JUL28);
    const row = rows.find((r) => r.id === 'snap-withdrawn')!;
    expect(row.voidReason).toBe('withdrawn');
    expect(row.correctedToId).toBeNull();
    expect(row.correctable).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F5 — the chain survives the correction being itself corrected
// ═════════════════════════════════════════════════════════════════════════

describe('F5 — a correction of a correction leaves the chain intact', () => {
  it('links O → C1 → C2 in both directions, with every value retained', async () => {
    seedOperatorCount({ id: 'snap-O', units_total: 2_483, reconciled_delta: 17 });

    const c1 = await correctPhysicalCount({
      snapshotId: 'snap-O',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 2_438, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    const c2 = await correctPhysicalCount({
      snapshotId: c1.snapshotId,
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 2_431, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });

    // Forward: each corrected row names its successor.
    expect(after(correctionRowFor('snap-O')).corrected_to).toBe(c1.snapshotId);
    expect(after(correctionRowFor(c1.snapshotId)).corrected_to).toBe(c2.snapshotId);

    // Backward: each successor's insert row names its predecessor.
    const insOf = (id: string) => db.audit.find((a) => a.row_id === id && a.action === 'insert');
    expect(after(insOf(c1.snapshotId)).corrected_from).toBe('snap-O');
    expect(after(insOf(c2.snapshotId)).corrected_from).toBe(c1.snapshotId);

    // Walk the chain from the head and recover EVERY value that was ever on the
    // record, in order — the whole point of never hard-deleting.
    const walk: number[] = [];
    let cursor: string | undefined = 'snap-O';
    while (cursor) {
      walk.push(db.snapshots.find((r) => r.id === cursor)!.units_total!);
      cursor = after(correctionRowFor(cursor)).corrected_to;
    }
    expect(walk).toEqual([2_483, 2_438, 2_431]);

    // Three rows on the table, exactly one of them live, and it is the last one.
    expect(db.snapshots).toHaveLength(3);
    expect(db.snapshots.filter((r) => r.voided_at === null).map((r) => r.id)).toEqual([
      c2.snapshotId,
    ]);
    expect((await onHand(SITE, MIDDAY_JUL28)).total).toStrictEqual(new Prisma.Decimal(2_431));

    // C1's own "enterer" is the manager who wrote it — the chain records who put
    // each number on the record, not a single flattened author.
    expect(after(correctionRowFor(c1.snapshotId)).entered_by).toBe(MORENA);
    // The original operator's attribution is not rewritten by the second pass.
    expect(after(correctionRowFor('snap-O')).entered_by).toBe(JT);
  });

  it('the superseded middle row cannot be corrected again (no forked chain)', async () => {
    seedOperatorCount({ id: 'snap-O', units_total: 100 });
    const c1 = await correctPhysicalCount({
      snapshotId: 'snap-O',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 110, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    await correctPhysicalCount({
      snapshotId: c1.snapshotId,
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 120, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    });
    await expect(
      correctPhysicalCount({
        snapshotId: c1.snapshotId,
        actorUserId: MORENA,
        siteId: SITE,
        corrected: { units_total: 130, units_in_processing: 0 },
        poolAttribution: 'legacy',
        now: MIDDAY_JUL28,
      }),
    ).rejects.toBeInstanceOf(SnapshotAlreadyVoidedError);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F6 — the refusals that are NOT about the window
// ═════════════════════════════════════════════════════════════════════════

describe('F6 — everything else this refuses', () => {
  it("another SITE's snapshot is a 404, not a 403", async () => {
    // Hard rule #2. A 403 would confirm the id exists and turn this into an
    // id-probe against the other jurisdiction's contract.
    seedOperatorCount({ id: 'snap-wood', site_id: OTHER_SITE, units_total: 400 });
    const err = await correctPhysicalCount({
      snapshotId: 'snap-wood',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 401, units_in_processing: 0 },
      now: MIDDAY_JUL28,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotNotFoundError);
    expect((err as SnapshotNotFoundError).status).toBe(404);
    expect(db.snapshots[0]!.voided_at).toBeNull();
  });

  it('a `computed` marker is not a count and cannot be corrected', async () => {
    seedOperatorCount({ id: 'snap-computed', snapshot_kind: 'computed', units_total: 50 });
    await expect(
      correctPhysicalCount({
        snapshotId: 'snap-computed',
        actorUserId: MORENA,
        siteId: SITE,
        corrected: { units_total: 55, units_in_processing: 0 },
        now: MIDDAY_JUL28,
      }),
    ).rejects.toBeInstanceOf(SnapshotNotPhysicalError);
  });

  it('an already-VOIDED count (ADR-0084) is refused 422, not silently revived', async () => {
    seedOperatorCount({
      id: 'snap-void',
      units_total: 60,
      voided_at: MIDDAY_JUL28,
      voided_by: JT,
    });
    const err = await correctPhysicalCount({
      snapshotId: 'snap-void',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 66, units_in_processing: 0 },
      now: MIDDAY_JUL28,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotAlreadyVoidedError);
    expect((err as SnapshotAlreadyVoidedError).status).toBe(422);
    expect(db.snapshots).toHaveLength(1);
  });

  it('correcting a count to the value it already has is refused', async () => {
    // Not a no-op success: that would soft-void a good anchor and write a
    // byte-identical replacement, adding a chain link recording no correction.
    seedOperatorCount({ id: 'snap-today', units_total: 500, pool_attribution: 'legacy' });
    await expect(
      correctPhysicalCount({
        snapshotId: 'snap-today',
        actorUserId: MORENA,
        siteId: SITE,
        corrected: { units_total: 500, units_in_processing: 0 },
        poolAttribution: 'legacy',
        now: MIDDAY_JUL28,
      }),
    ).rejects.toBeInstanceOf(CountCorrectionNoChangeError);
    expect(db.snapshots).toHaveLength(1);
    expect(db.snapshots[0]!.voided_at).toBeNull();
  });

  it('a measured pool split that does not sum to the corrected total is refused', async () => {
    // ADR-0037 §3 — MRC is billed on program units only, so a wrong split
    // silently mis-bills. Refused BEFORE the transaction, so nothing persists.
    seedOperatorCount({ id: 'snap-today', units_total: 1_000 });
    const err = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 900, units_in_processing: 0 },
      programUnits: 600,
      nonProgramUnits: 250,
      poolAttribution: 'measured',
      now: MIDDAY_JUL28,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoolSplitMismatchError);
    expect((err as Error).message).toContain('850');
    expect(db.snapshots[0]!.voided_at).toBeNull();
  });

  it('a valid measured split is carried onto the corrected row', async () => {
    seedOperatorCount({ id: 'snap-today', units_total: 1_000 });
    const result = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 900, units_in_processing: 0 },
      programUnits: 600,
      nonProgramUnits: 300,
      poolAttribution: 'measured',
      now: MIDDAY_JUL28,
    });
    const row = db.snapshots.find((r) => r.id === result.snapshotId)!;
    expect(row.program_units).toBe(600);
    expect(row.non_program_units).toBe(300);
    expect(row.pool_attribution).toBe('measured');
  });

  it('loses a concurrent race with an ERROR, not a false success', async () => {
    // Two managers correcting the same row to DIFFERENT numbers do not agree on
    // the outcome the way two voids do, so the loser must be told their value is
    // not on the record — the deliberate divergence from ADR-0084 D7's racing
    // voids, which resolve to a no-op success.
    //
    // The race is injected at the ONE instant that reproduces it: `db.hooks.
    // afterEnteredByRead` fires between the service reading a LIVE row and its
    // guarded `updateMany`. A competing correction lands in that window, so
    // `updateMany` matches zero rows and the loser must abort.
    seedOperatorCount({ id: 'snap-race', units_total: 100 });
    db.hooks.afterEnteredByRead = () => {
      const row = db.snapshots.find((r) => r.id === 'snap-race')!;
      row.voided_at = MIDDAY_JUL28;
      row.voided_by = 'user-other-manager';
    };

    const err = await correctPhysicalCount({
      snapshotId: 'snap-race',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 110, units_in_processing: 0 },
      poolAttribution: 'legacy',
      now: MIDDAY_JUL28,
    }).catch((e: unknown) => e);

    expect(
      err,
      'the losing corrector was not refused — two live anchors, or one value ' +
        'silently discarded while its author was told it applied',
    ).toBeInstanceOf(CountCorrectionConflictError);
    expect((err as CountCorrectionConflictError).status).toBe(409);
    // The loser wrote nothing at all — not even an audit row claiming it did.
    expect(db.snapshots).toHaveLength(1);
    expect(db.audit.filter((a) => a.action === 'update')).toHaveLength(0);
  });

  it('the race hook is not self-fulfilling — without it the same call succeeds', async () => {
    // Otherwise the test above would pass against a service that always threw.
    seedOperatorCount({ id: 'snap-race', units_total: 100 });
    await expect(
      correctPhysicalCount({
        snapshotId: 'snap-race',
        actorUserId: MORENA,
        siteId: SITE,
        corrected: { units_total: 110, units_in_processing: 0 },
        poolAttribution: 'legacy',
        now: MIDDAY_JUL28,
      }),
    ).resolves.toMatchObject({ toPhysicalTotal: 110 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F7 — idempotency
// ═════════════════════════════════════════════════════════════════════════

describe('F7 — a double-submit corrects once', () => {
  it('replays the stored response and writes nothing the second time', async () => {
    seedOperatorCount({ id: 'snap-today', units_total: 2_483, reconciled_delta: 17 });

    const first = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 2_438, units_in_processing: 0 },
      poolAttribution: 'legacy',
      idempotencyKey: 'key-1',
      now: MIDDAY_JUL28,
    });

    const snapshotsAfterFirst = db.snapshots.length;
    const auditAfterFirst = db.audit.length;

    // The same submission arriving again. It must NOT reach the service's gates —
    // by then the row is voided, so an un-deduped retry would 422 rather than
    // returning the answer the manager already got.
    const replay = await correctPhysicalCount({
      snapshotId: 'snap-today',
      actorUserId: MORENA,
      siteId: SITE,
      corrected: { units_total: 2_438, units_in_processing: 0 },
      poolAttribution: 'legacy',
      idempotencyKey: 'key-1',
      now: new Date(MIDDAY_JUL28.getTime() + 60_000),
    }).catch((e: unknown) => e);

    // The stored body comes back through a JSONB round-trip, which is why
    // `correctedAt` is an ISO string rather than a Date.
    expect(replay).toMatchObject({
      snapshotId: first.snapshotId,
      correctedAt: MIDDAY_JUL28.toISOString(),
      toPhysicalTotal: 2_438,
    });
    expect(db.snapshots).toHaveLength(snapshotsAfterFirst);
    expect(db.audit).toHaveLength(auditAfterFirst);
  });
});
