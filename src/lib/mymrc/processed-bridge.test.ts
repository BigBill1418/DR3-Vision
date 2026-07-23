// ADR-0058 D1/D2 — processed → inventory bridge tests. The repo idiom is an
// in-memory FAKE PrismaClient (no test Postgres — see reconcile-feed.test /
// leg-fetchers.test). The fake here faithfully emulates the money-safe
// `ON CONFLICT (site_id, production_date) DO UPDATE … WHERE source='mymrc' AND
// closed_at IS NULL AND (values IS DISTINCT FROM …)` upsert so idempotency and
// precedence are exercised through realistic upsert semantics, not just the JS
// pre-check. (The raw SQL guard's race-safety is additionally proven live on prod
// via the R4 invariant.)

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { bridgeProcessedToInventory } from './processed-bridge';

// ── in-memory store + fake ────────────────────────────────────────────────

interface MirrorRow {
  site_id: string | null;
  processed_date: Date | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  units: number | null;
  type: string | null;
  disappeared_at: Date | null;
}
interface PudRow {
  id: string;
  site_id: string;
  production_date: Date;
  stripped_program: number;
  stripped_non_program: number;
  source: string;
  closed_at: Date | null;
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
  pud: Map<string, PudRow>; // keyed `${site_id}|${iso}`
  audit: AuditRow[];
}

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);

function mirror(over: Partial<MirrorRow> = {}): MirrorRow {
  return {
    site_id: 'woodland',
    processed_date: new Date('2026-07-20T12:00:00.000Z'),
    program_unit_count: null,
    non_program_unit_count: null,
    units: null,
    type: 'Processing',
    disappeared_at: null,
    ...over,
  };
}

function pud(over: Partial<PudRow> & { production_date: Date }): PudRow {
  return {
    id: `pud-${over.site_id ?? 'woodland'}-${isoOf(over.production_date)}`,
    site_id: 'woodland',
    stripped_program: 0,
    stripped_non_program: 0,
    source: 'mymrc',
    closed_at: null,
    ...over,
  };
}

function store(over: Partial<Store> = {}): Store {
  const s: Store = { mirror: [], pud: new Map(), audit: [], ...over };
  return s;
}

/** A tiny where-matcher for exactly the mirror filters the bridge uses. */
function mirrorMatches(r: MirrorRow, where: Record<string, unknown>): boolean {
  if (where['type'] !== undefined && r.type !== where['type']) return false;
  if (where['disappeared_at'] === null && r.disappeared_at !== null) return false;
  const sid = where['site_id'] as { not?: unknown; in?: string[] } | undefined;
  if (sid) {
    if ('not' in sid && sid.not === null && r.site_id === null) return false;
    if (Array.isArray(sid.in) && (r.site_id === null || !sid.in.includes(r.site_id))) return false;
  }
  const pd = where['processed_date'] as { not?: unknown; gte?: Date } | undefined;
  if (pd) {
    if ('not' in pd && pd.not === null && r.processed_date === null) return false;
    if (pd.gte && (r.processed_date === null || r.processed_date.getTime() < pd.gte.getTime()))
      return false;
  }
  return true;
}

function fakePrisma(s: Store): PrismaClient {
  const tx = {
    $queryRawUnsafe: async (_sql: string, id: string, siteId: string, iso: string, prog: number, nprog: number) => {
      // Emulate the guarded ON CONFLICT upsert against the pud Map.
      const key = `${siteId}|${iso}`;
      const existing = s.pud.get(key);
      if (!existing) {
        s.pud.set(key, {
          id,
          site_id: siteId,
          production_date: new Date(`${iso}T00:00:00.000Z`),
          stripped_program: prog,
          stripped_non_program: nprog,
          source: 'mymrc',
          closed_at: null,
        });
        return [{ id, inserted: true }];
      }
      // Guard: only touch a mymrc, non-closed row whose values actually differ.
      if (
        existing.source === 'mymrc' &&
        existing.closed_at === null &&
        (existing.stripped_program !== prog || existing.stripped_non_program !== nprog)
      ) {
        existing.stripped_program = prog;
        existing.stripped_non_program = nprog;
        return [{ id: existing.id, inserted: false }];
      }
      return []; // guard blocked (manual/import/closed) OR already-equal
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        s.audit.push(data);
        return { id: `audit-${s.audit.length}` };
      },
    },
  };
  return {
    mymrcProcessedMirror: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        s.mirror.filter((r) => mirrorMatches(r, where)),
    },
    processedUnitsDaily: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const sid = (where['site_id'] as { in: string[] }).in;
        const pds = (where['production_date'] as { in: Date[] }).in.map((d) => d.getTime());
        return [...s.pud.values()].filter(
          (r) => sid.includes(r.site_id) && pds.includes(r.production_date.getTime()),
        );
      },
    },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    $queryRawUnsafe: tx.$queryRawUnsafe,
    auditLog: tx.auditLog,
  } as unknown as PrismaClient;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('bridgeProcessedToInventory — aggregation', () => {
  it('SUMs multiple mirror rows for the same (site, day) into one row', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 100, non_program_unit_count: 5 }),
        mirror({ program_unit_count: 200, non_program_unit_count: 10 }),
        mirror({ program_unit_count: 300, non_program_unit_count: 15 }),
      ],
    });
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1, updated: 0, skippedGuarded: 0, unchanged: 0 });
    const row = s.pud.get('woodland|2026-07-20')!;
    expect(row.stripped_program).toBe(600);
    expect(row.stripped_non_program).toBe(30);
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({ action: 'insert', actor_label: 'mymrc-processed-bridge', table_name: 'processed_units_daily' });
  });

  it('EXCLUDES a soft-deleted (disappeared_at set) mirror row', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 500 }),
        mirror({ program_unit_count: 999, disappeared_at: new Date('2026-07-21T00:00:00Z') }),
      ],
    });
    await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(500);
  });

  it('EXCLUDES a non-Processing (or NULL-type) mirror row', async () => {
    const s = store({
      mirror: [
        mirror({ program_unit_count: 500 }),
        mirror({ program_unit_count: 999, type: 'Outbound' }),
        mirror({ program_unit_count: 42, type: null }),
      ],
    });
    await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(500);
  });

  it('maps the program/non-program split 1:1', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 800, non_program_unit_count: 25 })] });
    await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    const row = s.pud.get('woodland|2026-07-20')!;
    expect(row.stripped_program).toBe(800);
    expect(row.stripped_non_program).toBe(25);
  });

  it('falls back to legacy `units` as program-only when program_unit_count is null (no double-count)', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: null, units: 500, non_program_unit_count: 7 })] });
    await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    const row = s.pud.get('woodland|2026-07-20')!;
    expect(row.stripped_program).toBe(500);
    expect(row.stripped_non_program).toBe(0); // non_program ignored on the legacy branch
  });
});

describe('bridgeProcessedToInventory — date mapping', () => {
  it('maps a noon-stamped processed_date to the Pacific @db.Date UTC-midnight key', async () => {
    const s = store({ mirror: [mirror({ processed_date: new Date('2026-07-20T12:00:00.000Z'), program_unit_count: 10 })] });
    await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    const row = s.pud.get('woodland|2026-07-20')!;
    expect(row.production_date.toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });

  it('noon never crosses a UTC day boundary — same UTC day rows share one key', async () => {
    const s = store({
      mirror: [
        mirror({ processed_date: new Date('2026-07-20T00:00:01.000Z'), program_unit_count: 1 }),
        mirror({ processed_date: new Date('2026-07-20T12:00:00.000Z'), program_unit_count: 2 }),
        mirror({ processed_date: new Date('2026-07-20T23:59:59.000Z'), program_unit_count: 3 }),
      ],
    });
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(res.daysConsidered).toBe(1);
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(6);
  });
});

describe('bridgeProcessedToInventory — idempotency (double-count-proof)', () => {
  it('a second run on the same mirror is a no-op — identical values, reported unchanged, no new audit', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 859 })] });
    const prisma = fakePrisma(s);
    const first = await bridgeProcessedToInventory({ prisma });
    expect(first).toMatchObject({ inserted: 1, unchanged: 0 });
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(859);
    expect(s.audit).toHaveLength(1);

    const second = await bridgeProcessedToInventory({ prisma });
    expect(second).toMatchObject({ daysConsidered: 1, inserted: 0, updated: 0, unchanged: 1, skippedGuarded: 0 });
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(859); // NOT 1718
    expect(s.audit).toHaveLength(1); // no second audit row
  });

  it('re-run after the portal revises a day UPDATES to the new absolute value (no increment)', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 800 })] });
    const prisma = fakePrisma(s);
    await bridgeProcessedToInventory({ prisma });
    // portal revises the day upward
    s.mirror = [mirror({ program_unit_count: 820 })];
    const res = await bridgeProcessedToInventory({ prisma });
    expect(res).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(820); // absolute, not 1620
    expect(s.audit).toHaveLength(2); // insert + update
  });
});

describe('bridgeProcessedToInventory — precedence (a human row always wins)', () => {
  it('leaves a source=manual row BYTE-IDENTICAL, counts it skippedGuarded, writes no audit', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 859 })] });
    s.pud.set('woodland|2026-07-20', pud({
      production_date: new Date('2026-07-20T00:00:00.000Z'),
      stripped_program: 12,
      stripped_non_program: 3,
      source: 'manual',
    }));
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(res).toMatchObject({ skippedGuarded: 1, inserted: 0, updated: 0, unchanged: 0 });
    const row = s.pud.get('woodland|2026-07-20')!;
    expect(row.stripped_program).toBe(12); // untouched
    expect(row.stripped_non_program).toBe(3);
    expect(row.source).toBe('manual');
    expect(s.audit).toHaveLength(0);
  });

  it('leaves a source=import (workbook) row untouched', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 859 })] });
    s.pud.set('woodland|2026-07-20', pud({
      production_date: new Date('2026-07-20T00:00:00.000Z'),
      stripped_program: 42,
      source: 'import',
    }));
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(res.skippedGuarded).toBe(1);
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(42);
    expect(s.audit).toHaveLength(0);
  });

  it('leaves a CLOSED mymrc day untouched (never re-open a manager close)', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 859 })] });
    s.pud.set('woodland|2026-07-20', pud({
      production_date: new Date('2026-07-20T00:00:00.000Z'),
      stripped_program: 500,
      source: 'mymrc',
      closed_at: new Date('2026-07-21T03:00:00Z'),
    }));
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(res.skippedGuarded).toBe(1);
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(500);
    expect(s.audit).toHaveLength(0);
  });
});

describe('bridgeProcessedToInventory — window + dry-run + empty', () => {
  it('sinceProductionDate excludes days before the floor', async () => {
    const s = store({
      mirror: [
        mirror({ processed_date: new Date('2026-07-10T12:00:00.000Z'), program_unit_count: 100 }),
        mirror({ processed_date: new Date('2026-07-20T12:00:00.000Z'), program_unit_count: 200 }),
      ],
    });
    const res = await bridgeProcessedToInventory({
      prisma: fakePrisma(s),
      sinceProductionDate: new Date('2026-07-15T00:00:00.000Z'),
    });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1 });
    expect(s.pud.has('woodland|2026-07-10')).toBe(false);
    expect(s.pud.get('woodland|2026-07-20')!.stripped_program).toBe(200);
  });

  it('dry-run writes nothing but reports what WOULD happen', async () => {
    const s = store({ mirror: [mirror({ program_unit_count: 859 })] });
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s), dryRun: true });
    expect(res).toMatchObject({ daysConsidered: 1, inserted: 1 });
    expect(s.pud.size).toBe(0);
    expect(s.audit).toHaveLength(0);
  });

  it('restricts to the given siteIds', async () => {
    const s = store({
      mirror: [
        mirror({ site_id: 'woodland', program_unit_count: 200 }),
        mirror({ site_id: 'eugene', program_unit_count: 300 }),
      ],
    });
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s), siteIds: ['woodland'] });
    expect(res.daysConsidered).toBe(1);
    expect(s.pud.has('woodland|2026-07-20')).toBe(true);
    expect(s.pud.has('eugene|2026-07-20')).toBe(false);
  });

  it('no mirror rows → a clean zero result, no writes', async () => {
    const s = store();
    const res = await bridgeProcessedToInventory({ prisma: fakePrisma(s) });
    expect(res).toEqual({ daysConsidered: 0, inserted: 0, updated: 0, skippedGuarded: 0, unchanged: 0 });
    expect(s.pud.size).toBe(0);
  });
});
