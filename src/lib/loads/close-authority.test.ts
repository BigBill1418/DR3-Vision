// ADR-0037 Phase 3 (§3.3 Option B) — the money-safe manager/admin boundary.
//
// Managers ENTER and AMEND the daily close; only Bill CLOSES and LOCKS it. This is a
// structural boundary, so it is tested structurally: no close handler may exist under
// the manager namespace, no manager surface may import the close service, and the
// service itself must refuse a manager's write once a day is closed.
//
// If a future change grants managers close authority, it must delete these tests
// deliberately — it cannot happen by accident.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const SRC = join(process.cwd(), 'src');
const MANAGER_API = join(SRC, 'app', 'api', 'manager', '[site]');
const MANAGER_PAGES = join(SRC, 'app', 'dashboard', '[site]');
const ADMIN_CLOSE_ROUTE = join(
  SRC,
  'app',
  'api',
  'admin',
  'processed-units',
  '[id]',
  'close',
  'route.ts',
);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe('close authority — structural boundary', () => {
  it('exposes the ONE close route under the super-admin admin namespace', () => {
    expect(existsSync(ADMIN_CLOSE_ROUTE)).toBe(true);
    const src = readFileSync(ADMIN_CLOSE_ROUTE, 'utf8');
    expect(src).toContain('session?.user?.is_super_admin');
    expect(src).toContain('closeProcessedUnitsDay');
  });

  it('exposes a manager ENTRY route, and no manager route can close the BILLING day', () => {
    const managerFiles = walk(MANAGER_API);
    expect(managerFiles).toContain(join(MANAGER_API, 'processed-units', 'route.ts'));

    // ── ADR-0125 — the filename proxy was narrowed, deliberately ────────────
    //
    // This read `filter((f) => f.includes('close')).toEqual([])`. That was a
    // PROXY for the rule this file's header states: no close handler under the
    // manager namespace, where "close" means closing and LOCKING the billing day
    // (`processed_units_daily.closed_at`) — the thing only Bill may do.
    //
    // ADR-0125 added a manager route whose filename contains "close" and which
    // closes something else entirely: `eod_day_close`, the record that a manager
    // REVIEWED a day. Its D2 is explicit that it locks nothing — every amendment
    // path, `upsertProcessedUnits` included, keeps working on a closed day,
    // which is the exact opposite of `processed_units_daily.closed_at`.
    //
    // So the proxy is replaced by the rule it stood in for, and the replacement
    // is STRICTER for the route it admits: a manager "close" route is allowed
    // only if it is named here AND it demonstrably never reaches the billing
    // close. Every other file still fails the same way it did before, and adding
    // a name to this list is as deliberate an act as deleting the assertion was.
    const ALLOWED_MANAGER_CLOSE_ROUTES = [join(MANAGER_API, 'eod', 'close', 'route.ts')];
    const closeRoutes = managerFiles.filter((f) => f.includes('close')).sort();
    expect(closeRoutes).toEqual(ALLOWED_MANAGER_CLOSE_ROUTES.sort());
    for (const f of closeRoutes) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toContain('closeProcessedUnitsDay');
      expect(src, f).not.toContain('processedUnitsDaily');
      expect(src, f).not.toContain('processed-units');
    }
  });

  it('never imports the close service into a manager route or page', () => {
    const offenders = [...walk(MANAGER_API), ...walk(MANAGER_PAGES)].filter((f) =>
      readFileSync(f, 'utf8').includes('closeProcessedUnitsDay'),
    );
    expect(offenders).toEqual([]);
  });

  it('never calls the admin close endpoint from a manager page', () => {
    const offenders = walk(MANAGER_PAGES).filter((f) =>
      /\/api\/admin\/processed-units/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('gates the manager entry route on requireActivatedManager, not is_super_admin', () => {
    const src = readFileSync(join(MANAGER_API, 'processed-units', 'route.ts'), 'utf8');
    expect(src).toContain('requireActivatedManager');
    expect(src).not.toContain('is_super_admin');
  });
});

// ── Service-level half: a manager can amend up to the close and never past it ──

interface Row {
  id: string;
  site_id: string;
  production_date: Date;
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  saved_units: Prisma.Decimal | null;
  closed_at: Date | null;
}
const store = { rows: [] as Row[], audits: [] as Record<string, unknown>[] };

vi.mock('@/lib/prisma', () => {
  const processedUnitsDaily = {
    findUnique: async ({
      where,
    }: {
      where: { site_id_production_date?: { site_id: string; production_date: Date } };
    }) => {
      const k = where.site_id_production_date!;
      const hit = store.rows.find(
        (r) =>
          r.site_id === k.site_id && r.production_date.getTime() === k.production_date.getTime(),
      );
      return hit ? { ...hit } : null;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { site_id_production_date: { site_id: string; production_date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const k = where.site_id_production_date;
      const found = store.rows.find(
        (r) =>
          r.site_id === k.site_id && r.production_date.getTime() === k.production_date.getTime(),
      );
      if (found) return Object.assign(found, update);
      const row = { id: `p${store.rows.length + 1}`, closed_at: null, ...create } as Row;
      store.rows.push(row);
      return row;
    },
    // ADR-0119 — the service re-reads the committed row to build its view.
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const r = store.rows.find((x) => x.id === where.id);
      if (!r) throw new Error(`row ${where.id} not found`);
      return r;
    },
  };
  const zero = { _sum: {} as Record<string, number | null> };
  const tx = {
    processedUnitsDaily,
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.audits.push(data);
        return data;
      },
    },
    // ADR-0119 — the manual write is now a guarded raw upsert. This fake
    // reproduces its two OUTCOMES against the same fixture store (closed ⇒ zero
    // rows ⇒ the service raises; open ⇒ one row) rather than parsing SQL. The
    // SQL's own guarantee — that the WHERE is re-evaluated against the row
    // version actually being written — is a Postgres property and is proven in
    // `processed-units.db.test.ts`, not here. This suite's subject is the
    // AUTHORITY rule: a manager may amend before the close and never after.
    $queryRaw: async (sql: { values?: unknown[] }) => {
      const v = (sql.values ?? []) as unknown[];
      const [id, siteId, day] = v as [string, string, Date];
      const found = store.rows.find(
        (r) => r.site_id === siteId && r.production_date.getTime() === new Date(day).getTime(),
      );
      if (found) {
        if (found.closed_at) return [];
        Object.assign(found, {
          stripped_program: v[3],
          stripped_non_program: v[4],
          entered_by: v[10],
          notes: v[11],
          source: 'manual',
        });
        return [{ id: found.id, inserted: false }];
      }
      store.rows.push({
        id,
        site_id: siteId,
        production_date: new Date(day),
        stripped_program: v[3],
        stripped_non_program: v[4],
        entered_by: v[10],
        notes: v[11],
        source: 'manual',
        closed_at: null,
      } as unknown as Row);
      return [{ id, inserted: true }];
    },
  };
  return {
    prisma: {
      processedUnitsDaily,
      outboundMaterial: { aggregate: async () => zero, groupBy: async () => [] },
      landfilledUnit: { aggregate: async () => zero, groupBy: async () => [] },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

const { upsertProcessedUnits, ProcessedUnitsError } = await import('@/lib/loads/processed-units');

const SITE = 'site-woodland';
const DAY = new Date('2026-07-20T00:00:00Z');
const entry = (actor: string) => ({
  siteId: SITE,
  productionDate: DAY,
  strippedProgram: 150,
  strippedNonProgram: 25,
  actorUserId: actor,
});

beforeEach(() => {
  store.rows = [];
  store.audits = [];
});

describe('close authority — manager amends before close, never after', () => {
  it('lets a manager enter and then amend an open day', async () => {
    await upsertProcessedUnits(entry('user-morena'));
    const amended = await upsertProcessedUnits({
      ...entry('user-morena'),
      strippedProgram: 161,
    });
    expect(store.rows).toHaveLength(1);
    expect(amended.strippedProgram).toBe('161');
  });

  it('refuses a manager write once Bill has closed the day', async () => {
    await upsertProcessedUnits(entry('user-morena'));
    // Bill closes + locks it via the admin-only path (simulated here as the stamp).
    store.rows[0]!.closed_at = new Date('2026-07-21T15:00:00Z');
    await expect(upsertProcessedUnits(entry('user-morena'))).rejects.toBeInstanceOf(
      ProcessedUnitsError,
    );
    await expect(upsertProcessedUnits(entry('user-morena'))).rejects.toMatchObject({
      reason: 'closed',
      status: 409,
    });
  });
});
