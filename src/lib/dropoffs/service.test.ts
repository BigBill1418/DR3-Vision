// ADR-0037 D3 — dropoffs service tests. Proves the incentive integration
// (resolver rate + per-person daily cap across two same-day drop-offs) and the
// edit-before-lock guard, with a mocked prisma + rule resolver.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface DropRow {
  id: string;
  site_id: string;
  dropoff_date: Date;
  kind: string;
  person_name: string;
  slip_number: string | null;
  units: number;
  incentive_cents: number | null;
  check_number: string | null;
  paid_at: Date | null;
  retrac_id: string | null;
  source: string;
  locked_at: Date | null;
}
const store = { rows: [] as DropRow[], audits: [] as unknown[] };

vi.mock('@/lib/prisma', () => {
  const model = {
    findUnique: async ({ where }: { where: { id: string } }) => store.rows.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: { where: { site_id: string; person_name?: string; dropoff_date?: Date; id?: { not: string } } }) =>
      store.rows.filter(
        (r) =>
          r.site_id === where.site_id &&
          (where.person_name === undefined || r.person_name === where.person_name) &&
          (where.dropoff_date === undefined || r.dropoff_date.getTime() === where.dropoff_date.getTime()) &&
          (where.id?.not === undefined || r.id !== where.id.not),
      ),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `d${store.rows.length + 1}`, paid_at: null, locked_at: null, ...data } as DropRow;
      store.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = store.rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
  };
  return {
    prisma: {
      consumerDropoff: model,
      auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ consumerDropoff: model, auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) } }),
    },
  };
});

// Switchable resolver: default returns the CA collector incentive (300¢/unit,
// cap 5/day); `h.noRule` flips it to throw NoActiveProgramRuleError (finding 5a).
const h = vi.hoisted(() => ({ noRule: false }));
vi.mock('@/lib/program-rules/resolver', () => {
  class NoActiveProgramRuleError extends Error {
    readonly status = 409 as const;
    constructor() {
      super('no active rule');
      this.name = 'NoActiveProgramRuleError';
    }
  }
  return {
    NoActiveProgramRuleError,
    resolveProgramRule: async () => {
      if (h.noRule) throw new NoActiveProgramRuleError();
      return {
        id: 'inc',
        siteId: 'S1',
        ruleKind: 'collector_incentive',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: null,
        rateCents: 300,
        params: { daily_cap_units: 5 },
      };
    },
  };
});

import { createDropoff, updateDropoff, listDropoffs, IncentiveComputationError } from './service';
import { NoActiveProgramRuleError } from '@/lib/program-rules/resolver';
import { RecordLockedError } from '@/lib/loads/record-guards';

const SITE = 'S1';
const DAY = new Date('2026-07-03T00:00:00Z');

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
  h.noRule = false;
});

describe('createDropoff — incentive with per-person daily cap', () => {
  it('pays 3 units × 300¢ = 900¢ for the first incentive drop-off', async () => {
    const v = await createDropoff({
      siteId: SITE,
      dropoffDate: DAY,
      kind: 'incentive',
      personName: 'Jane Public',
      units: 3,
      actorUserId: 'U1',
    });
    expect(v.incentiveCents).toBe(900);
    expect(v.kind).toBe('incentive');
    expect(store.audits).toHaveLength(1);
  });

  it('caps a second same-day drop-off by the same person (3 then 4 → 900 + 600)', async () => {
    await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 3, actorUserId: 'U1' });
    const second = await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 4, actorUserId: 'U1' });
    // 5-unit cap; 3 already paid → only 2 of the 4 pay → 600¢.
    expect(second.incentiveCents).toBe(600);
  });

  it('a different person the same day is not affected by the first person cap', async () => {
    await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 5, actorUserId: 'U1' });
    const other = await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'John Public', units: 5, actorUserId: 'U1' });
    expect(other.incentiveCents).toBe(1500);
  });

  it('an UNPAID drop-off carries a null incentive (no rule needed)', async () => {
    const v = await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'unpaid', personName: 'Anon', units: 4, actorUserId: 'U1' });
    expect(v.incentiveCents).toBeNull();
  });

  it('an ILLEGAL drop-off carries a null incentive (never paid)', async () => {
    const v = await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'illegal', personName: 'Anon', units: 6, actorUserId: 'U1' });
    expect(v.incentiveCents).toBeNull();
    expect(v.kind).toBe('illegal');
  });
});

describe('updateDropoff — edit-before-lock', () => {
  it('recomputes incentive on a units change', async () => {
    const v = await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 2, actorUserId: 'U1' });
    const upd = await updateDropoff({ id: v.id, siteId: SITE, units: 4, actorUserId: 'U1' });
    expect(upd.incentiveCents).toBe(1200);
  });

  it('clears the incentive when kind changes incentive → unpaid', async () => {
    const v = await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 3, actorUserId: 'U1' });
    const upd = await updateDropoff({ id: v.id, siteId: SITE, kind: 'unpaid', actorUserId: 'U1' });
    expect(upd.incentiveCents).toBeNull();
  });

  it('refuses to edit a locked row', async () => {
    const v = await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 2, actorUserId: 'U1' });
    store.rows[0]!.locked_at = new Date();
    await expect(updateDropoff({ id: v.id, siteId: SITE, units: 3, actorUserId: 'U1' })).rejects.toBeInstanceOf(
      RecordLockedError,
    );
  });
});

describe('incentive computation failure paths (finding 5)', () => {
  it('rethrows NoActiveProgramRuleError when the collector_incentive rule is missing (no blind $0)', async () => {
    h.noRule = true;
    await expect(
      createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 3, actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(NoActiveProgramRuleError);
    // Nothing written — the create never reached the transaction.
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('surfaces a typed 500 (not a bare RangeError) when a prior incentive_cents is not divisible by the rate', async () => {
    // Seed a prior same-day row for this person whose stored incentive_cents (250)
    // is not divisible by the current rate (300) — recovery must fail loud+typed.
    store.rows.push({
      id: 'corrupt',
      site_id: SITE,
      dropoff_date: DAY,
      kind: 'incentive',
      person_name: 'Jane Public',
      slip_number: null,
      units: 1,
      incentive_cents: 250,
      check_number: null,
      paid_at: null,
      retrac_id: null,
      source: 'manual',
      locked_at: null,
    });
    try {
      await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 2, actorUserId: 'U1' });
      expect.unreachable('should have thrown a typed error');
    } catch (e) {
      expect(e).toBeInstanceOf(IncentiveComputationError);
      expect((e as IncentiveComputationError).status).toBe(500);
      expect((e as IncentiveComputationError).reason).toBe('incentive_recovery_failed');
    }
  });
});

describe('listDropoffs', () => {
  it('returns rows for the site including person_name for the manager surface', async () => {
    await createDropoff({ siteId: SITE, dropoffDate: DAY, kind: 'incentive', personName: 'Jane Public', units: 2, actorUserId: 'U1' });
    const rows = await listDropoffs(SITE);
    expect(rows[0]?.personName).toBe('Jane Public');
  });
});
