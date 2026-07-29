// ADR-0067 — a minimal in-memory Prisma stand-in for the doc-ingest pipeline
// tests. Mirrors `src/lib/ap/__testutils__/fake-prisma.ts` in spirit and scope.
//
// It implements ONLY the query shapes these modules use, plus the two behaviours
// the tests actually depend on:
//
//   1. the `(doc_source_id, ctag)` UNIQUE on versions — `create` throws a
//      P2002-shaped error, which is what makes the idempotency test real rather
//      than a check that the code calls `findUnique` first;
//   2. the PARTIAL unique on OPEN anomalies — enforced here so the raiser's
//      P2002 fallback is exercised, since that partial index is precisely the
//      thing Prisma cannot express and `upsert` cannot use.
//
// It is NOT a general Prisma emulator.

import { Prisma } from '@prisma/client';

let seq = 0;
const uid = (p: string): string => `${p}-${++seq}`;

export function resetFakeIds(): void {
  seq = 0;
}

function p2002(target: string): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });
}

type Row = Record<string, unknown>;

/**
 * Return a DETACHED copy, exactly as real Prisma does.
 *
 * Load-bearing, not tidiness: several call sites read a row, mutate it inside a
 * transaction, and then write an audit `before` from the value they read
 * earlier. Handing back the live store object would let the update mutate that
 * snapshot in place, so the audit's "before" would silently equal its "after" —
 * and the tests would pass while the real code (against real Prisma) behaved
 * differently. A fake that is wrong in the reassuring direction is worse than no
 * fake at all.
 */
function detach<T>(row: T): T {
  return row === null || row === undefined ? row : ({ ...(row as object) } as T);
}

/** Apply a Prisma-ish `data` object, honouring `{ increment: n }`. */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as Row)) {
      const current = typeof row[key] === 'number' ? (row[key] as number) : 0;
      row[key] = current + Number((value as Row)['increment']);
      continue;
    }
    row[key] = value;
  }
  row['updated_at'] = new Date();
}

/** Evaluate one Prisma-ish where clause against a row. Supports the subset used. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key];
    if (condition === null || condition === undefined) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      const c = condition as Row;
      if ('in' in c) {
        if (!(c['in'] as unknown[]).includes(value)) return false;
        continue;
      }
      if ('notIn' in c) {
        if ((c['notIn'] as unknown[]).includes(value)) return false;
        continue;
      }
      if ('not' in c) {
        const not = c['not'];
        if (not === null) {
          if (value === null || value === undefined) return false;
        } else if (value === not) return false;
        continue;
      }
      if ('equals' in c) {
        if (value !== c['equals']) return false;
        continue;
      }
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  const out = [...rows];
  for (const clause of [...clauses].reverse()) {
    const [key, dir] = Object.entries(clause as Row)[0] ?? [];
    if (!key) continue;
    out.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const at = av instanceof Date ? av.getTime() : (av as number | string | null);
      const bt = bv instanceof Date ? bv.getTime() : (bv as number | string | null);
      if (at === bt) return 0;
      if (at === null || at === undefined) return 1;
      if (bt === null || bt === undefined) return -1;
      const cmp = at < bt ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    });
  }
  return out;
}

interface ModelOptions {
  /** Composite-key selectors, e.g. `drive_id_item_id` → ['drive_id','item_id']. */
  compositeKeys?: Record<string, string[]>;
  /** Called before an insert; throw to simulate a unique violation. */
  beforeCreate?: (rows: Row[], data: Row) => void;
  defaults?: () => Row;
  idPrefix: string;
}

function makeModel(store: Row[], opts: ModelOptions) {
  const resolveWhere = (where: Row | undefined): Row | undefined => {
    if (!where) return where;
    for (const [alias, keys] of Object.entries(opts.compositeKeys ?? {})) {
      if (alias in where) {
        const composite = where[alias] as Row;
        const expanded: Row = { ...where };
        delete expanded[alias];
        for (const key of keys) expanded[key] = composite[key];
        return expanded;
      }
    }
    return where;
  };

  const find = (where: Row | undefined): Row | undefined =>
    store.find((r) => matches(r, resolveWhere(where)));

  return {
    async create({ data }: { data: Row }): Promise<Row> {
      opts.beforeCreate?.(store, data);
      const row: Row = {
        id: uid(opts.idPrefix),
        created_at: new Date(),
        updated_at: new Date(),
        ...opts.defaults?.(),
        ...data,
      };
      store.push(row);
      return detach(row);
    },
    async findUnique({ where }: { where: Row }): Promise<Row | null> {
      const row = find(where);
      return row ? detach(row) : null;
    },
    async findUniqueOrThrow({ where }: { where: Row }): Promise<Row> {
      const row = find(where);
      if (!row) throw new Error('not found');
      return detach(row);
    },
    async findFirst(args: { where?: Row; orderBy?: unknown } = {}): Promise<Row | null> {
      const matching = store.filter((r) => matches(r, resolveWhere(args.where)));
      const row = sortRows(matching, args.orderBy)[0];
      return row ? detach(row) : null;
    },
    async findMany(
      args: { where?: Row; orderBy?: unknown; take?: number; distinct?: string[] } = {},
    ): Promise<Row[]> {
      let matching = store.filter((r) => matches(r, resolveWhere(args.where)));
      matching = sortRows(matching, args.orderBy);
      if (args.distinct) {
        const seen = new Set<string>();
        matching = matching.filter((r) => {
          const key = args.distinct!.map((k) => String(r[k])).join('|');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      const page = typeof args.take === 'number' ? matching.slice(0, args.take) : matching;
      return page.map(detach);
    },
    async count(args: { where?: Row } = {}): Promise<number> {
      return store.filter((r) => matches(r, resolveWhere(args.where))).length;
    },
    async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
      const row = find(where);
      if (!row) throw new Error(`update: no ${opts.idPrefix} matching ${JSON.stringify(where)}`);
      applyData(row, data);
      return detach(row);
    },
    async updateMany({ where, data }: { where?: Row; data: Row }): Promise<{ count: number }> {
      const rows = store.filter((r) => matches(r, resolveWhere(where)));
      for (const row of rows) applyData(row, data);
      return { count: rows.length };
    },
  };
}

export interface FakeDocIngestPrisma {
  docSource: ReturnType<typeof makeModel>;
  docSourceVersion: ReturnType<typeof makeModel>;
  docIngestAnomaly: ReturnType<typeof makeModel>;
  docIngestSubscription: ReturnType<typeof makeModel>;
  docIngestSweepRun: ReturnType<typeof makeModel>;
  docIngestConnection: ReturnType<typeof makeModel>;
  fileDrop: ReturnType<typeof makeModel>;
  site: ReturnType<typeof makeModel>;
  auditLog: ReturnType<typeof makeModel>;
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  /** Raw stores, for assertions. */
  _stores: {
    sources: Row[];
    versions: Row[];
    anomalies: Row[];
    subscriptions: Row[];
    sweepRuns: Row[];
    connections: Row[];
    fileDrops: Row[];
    sites: Row[];
    auditLogs: Row[];
  };
}

export function makeFakePrisma(): FakeDocIngestPrisma {
  const sources: Row[] = [];
  const versions: Row[] = [];
  const anomalies: Row[] = [];
  const subscriptions: Row[] = [];
  const sweepRuns: Row[] = [];
  const connections: Row[] = [];
  const fileDrops: Row[] = [];
  const sites: Row[] = [];
  const auditLogs: Row[] = [];

  const fake = {
    docSource: makeModel(sources, {
      idPrefix: 'src',
      compositeKeys: { drive_id_item_id: ['drive_id', 'item_id'] },
      defaults: () => ({
        kind: 'file',
        state: 'active',
        enabled: true,
        depth: 0,
        shared_by_count: 1,
        site_id: null,
        doc_class: null,
        doc_class_source: null,
        classified_at: null,
        classified_by: null,
        period: null,
        proposed_class: null,
        proposed_site_id: null,
        proposed_period: null,
        proposed_confidence: null,
        proposed_reasoning: null,
        proposed_source: null,
        classification_attempted_at: null,
        classification_error: null,
        parent_item_id: null,
        read_blocked_at: null,
        read_blocked_reason: null,
        read_blocked_ctag: null,
        disappeared_at: null,
        last_ingested_at: null,
        owner_upn: null,
        ctag: null,
        etag: null,
        web_url: null,
        path_hint: null,
        content_type: null,
        size_bytes: null,
        last_modified_at: null,
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      }),
    }),
    docSourceVersion: makeModel(versions, {
      idPrefix: 'ver',
      compositeKeys: { doc_source_id_ctag: ['doc_source_id', 'ctag'] },
      // The real UNIQUE (doc_source_id, ctag) — this is what makes a
      // re-delivered notification a no-op instead of a duplicate ingest.
      beforeCreate: (rows, data) => {
        if (
          rows.some(
            (r) => r['doc_source_id'] === data['doc_source_id'] && r['ctag'] === data['ctag'],
          )
        ) {
          throw p2002('doc_source_id_ctag');
        }
      },
      defaults: () => ({
        staged: false,
        staged_reason: null,
        applied_at: null,
        applied_by: null,
        discarded_at: null,
        discarded_by: null,
        parse_summary: null,
        parse_error: null,
        ingested_at: null,
        file_drop_id: null,
        r2_key: null,
        content_sha256: null,
        etag: null,
        size_bytes: null,
        last_modified_at: null,
        observed_at: new Date(),
        fetched_at: null,
      }),
    }),
    docIngestAnomaly: makeModel(anomalies, {
      idPrefix: 'anom',
      // The PARTIAL unique index over OPEN rows. Enforcing it here is the whole
      // point of this fake: it is exactly what Prisma cannot express, so the
      // raiser's conflict fallback would otherwise never be exercised.
      beforeCreate: (rows, data) => {
        if (
          data['status'] === 'open' &&
          rows.some((r) => r['fingerprint'] === data['fingerprint'] && r['status'] === 'open')
        ) {
          throw p2002('fingerprint');
        }
      },
      defaults: () => ({
        severity: 'warning',
        status: 'open',
        occurrences: 1,
        context: null,
        doc_source_id: null,
        subscription_id: null,
        doc_source_version_id: null,
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
        last_paged_at: null,
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      }),
    }),
    docIngestSubscription: makeModel(subscriptions, {
      idPrefix: 'sub',
      defaults: () => ({
        state: 'pending',
        failure_count: 0,
        last_error: null,
        subscription_id: null,
        client_state_hash: null,
        delta_link: null,
        delta_synced_at: null,
        expires_at: null,
        last_renewed_at: null,
        renew_after: null,
        last_notification_at: null,
        validated_at: null,
        notifications_received: 0,
      }),
    }),
    docIngestSweepRun: makeModel(sweepRuns, {
      idPrefix: 'run',
      defaults: () => ({
        finished_at: null,
        trigger: 'scheduled',
        sources_discovered: 0,
        sources_updated: 0,
        versions_created: 0,
        versions_applied: 0,
        versions_staged: 0,
        anomalies_raised: 0,
        subscriptions_renewed: 0,
        error: null,
        run_id: null,
        started_at: new Date(),
      }),
    }),
    docIngestConnection: makeModel(connections, { idPrefix: 'conn' }),
    fileDrop: makeModel(fileDrops, {
      idPrefix: 'drop',
      defaults: () => ({ status: 'received', ingest_source: 'manual', doc_source_id: null }),
    }),
    site: makeModel(sites, { idPrefix: 'site' }),
    auditLog: makeModel(auditLogs, { idPrefix: 'audit' }),
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      // No rollback semantics: these tests assert what was written, not that a
      // partial failure unwinds. Modelling rollback would mean modelling a
      // transaction log, which is far past what a stand-in should carry.
      return fn(fake);
    },
    _stores: {
      sources,
      versions,
      anomalies,
      subscriptions,
      sweepRuns,
      connections,
      fileDrops,
      sites,
      auditLogs,
    },
  };

  return fake as unknown as FakeDocIngestPrisma;
}

/** Cast helper — the fake satisfies only the slice of PrismaClient under test. */
export function asPrisma(fake: FakeDocIngestPrisma): never {
  return fake as unknown as never;
}
