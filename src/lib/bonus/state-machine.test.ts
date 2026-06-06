// T-106 — Monthly state machine (ADR-0019 §5/§6).
//
// DB-free: we inject a fake prisma/tx (the modules under test all accept an
// injected client) and assert against an in-memory store. The transition
// table, guards, and date math are pure and exercised directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appToday } from '@/lib/time';
import {
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  isAdminOnlyTransition,
  transitionMonth,
  resolveOpenPayPeriod,
  getOrCreateDraftPayPeriod,
  closePayPeriodsDueForSignature,
  assertEntriesEditable,
  TransitionError,
  TransitionForbiddenError,
  EntriesLockedError,
  EDITABLE_STATES,
  type BonusMonthRow,
  type BonusPayPeriodState,
  type BonusMonthDb,
} from './state-machine';

// ── In-memory fake prisma/tx ────────────────────────────────────────
//
// Implements only the surface the state machine touches:
//   bonusPayPeriod.findUnique({ where: { site_id_period_start } })
//   bonusPayPeriod.findFirst({ where })
//   bonusPayPeriod.findMany({ where })
//   bonusPayPeriod.create({ data })
//   bonusPayPeriod.update({ where: { id }, data })
//   auditLog.create({ data })
//   $transaction(fn)

interface AuditRow {
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
}

const monthsStore = new Map<string, BonusMonthRow>();
const auditRows: AuditRow[] = [];
let seq = 0;

function dayUTC(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

function resetStores() {
  monthsStore.clear();
  auditRows.length = 0;
  seq = 0;
}

function seedMonth(
  p: Partial<BonusMonthRow> & { site_id: string; period_start: Date },
): BonusMonthRow {
  const id = p.id ?? `bm-${++seq}`;
  const ms = p.period_start;
  const row: BonusMonthRow = {
    id,
    site_id: p.site_id,
    period_start: ms,
    period_end: p.period_end ?? dayUTC(ms.getUTCFullYear(), ms.getUTCMonth() + 1, 0),
    state: p.state ?? 'draft',
  };
  monthsStore.set(id, row);
  return row;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

const fakePrisma = {
  bonusPayPeriod: {
    findUnique: async ({
      where,
    }: {
      where: { site_id_period_start?: { site_id: string; period_start: Date }; id?: string };
    }) => {
      if (where.id) return monthsStore.get(where.id) ?? null;
      const key = where.site_id_period_start;
      if (key) {
        for (const r of monthsStore.values()) {
          if (r.site_id === key.site_id && sameDay(r.period_start, key.period_start)) return r;
        }
      }
      return null;
    },
    findFirst: async ({
      where,
    }: {
      where: {
        site_id: string;
        period_start?: { lte: Date };
        period_end?: { gte: Date } | { equals: Date };
        state?: BonusPayPeriodState;
      };
    }) => {
      for (const r of monthsStore.values()) {
        if (r.site_id !== where.site_id) continue;
        if (where.state && r.state !== where.state) continue;
        if (
          where.period_start?.lte &&
          !(r.period_start.getTime() <= where.period_start.lte.getTime())
        )
          continue;
        if (where.period_end) {
          if ('gte' in where.period_end) {
            if (!(r.period_end.getTime() >= where.period_end.gte.getTime())) continue;
          } else if ('equals' in where.period_end) {
            if (r.period_end.getTime() !== where.period_end.equals.getTime()) continue;
          }
        }
        return r;
      }
      return null;
    },
    findMany: async ({
      where,
    }: {
      where?: {
        site_id?: string;
        state?: BonusPayPeriodState;
        period_end?: { lt?: Date; equals?: Date };
      };
    } = {}) => {
      const out: BonusMonthRow[] = [];
      for (const r of monthsStore.values()) {
        if (where?.site_id && r.site_id !== where.site_id) continue;
        if (where?.state && r.state !== where.state) continue;
        if (where?.period_end?.lt && !(r.period_end.getTime() < where.period_end.lt.getTime()))
          continue;
        if (
          where?.period_end?.equals &&
          r.period_end.getTime() !== where.period_end.equals.getTime()
        )
          continue;
        out.push(r);
      }
      return out;
    },
    create: async ({ data }: { data: Omit<BonusMonthRow, 'id'> & { id?: string } }) => {
      const id = data.id ?? `bm-${++seq}`;
      const row: BonusMonthRow = {
        id,
        site_id: data.site_id,
        period_start: data.period_start,
        period_end: data.period_end,
        state: data.state,
      };
      monthsStore.set(id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<BonusMonthRow> }) => {
      const r = monthsStore.get(where.id);
      if (!r) throw new Error('not found');
      if (data.state !== undefined) r.state = data.state;
      return r;
    },
  },
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push({
        actor_user_id: (data['actor_user_id'] as string) ?? null,
        actor_label: (data['actor_label'] as string) ?? null,
        action: data['action'] as string,
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        before: data['before'],
        after: data['after'],
      });
      return { id: `audit-${auditRows.length}` };
    },
  },
  $transaction: async <T>(fn: (tx: BonusMonthDb) => Promise<T>): Promise<T> =>
    fn(fakePrisma as unknown as BonusMonthDb),
};

beforeEach(resetStores);

// ── Transition table ────────────────────────────────────────────────

describe('ALLOWED_TRANSITIONS / isTransitionAllowed', () => {
  const legal: Array<[BonusPayPeriodState, BonusPayPeriodState]> = [
    ['draft', 'pending_signatures'],
    ['draft', 'skipped'], // T-203 / ADR-0019.1 bootstrap disposition (admin-only)
    ['pending_signatures', 'partially_signed'],
    ['partially_signed', 'signed'],
    ['signed', 'paid'],
    ['signed', 'amended'],
    ['paid', 'amended'],
    ['amended', 'pending_signatures'],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(true);
  });

  const illegal: Array<[BonusPayPeriodState, BonusPayPeriodState]> = [
    ['draft', 'signed'],
    ['draft', 'paid'],
    ['draft', 'partially_signed'],
    ['signed', 'draft'],
    ['paid', 'draft'],
    ['paid', 'signed'],
    ['pending_signatures', 'signed'],
    ['amended', 'draft'],
    ['draft', 'draft'],
    // `skipped` is terminal — no out-edges, and no other state may reach it.
    ['skipped', 'draft'],
    ['skipped', 'pending_signatures'],
    ['pending_signatures', 'skipped'],
    ['signed', 'skipped'],
    ['amended', 'skipped'],
  ];

  it.each(illegal)('rejects %s -> %s', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(false);
  });

  it('ALLOWED_TRANSITIONS lists exactly the eight legal edges', () => {
    const edges = Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, tos]) =>
      (tos as BonusPayPeriodState[]).map((to) => `${from}->${to}`),
    );
    expect(edges.sort()).toEqual(
      [
        'draft->pending_signatures',
        'draft->skipped',
        'pending_signatures->partially_signed',
        'partially_signed->signed',
        'signed->paid',
        'signed->amended',
        'paid->amended',
        'amended->pending_signatures',
      ].sort(),
    );
  });

  it('only draft->skipped is admin-only', () => {
    expect(isAdminOnlyTransition('draft', 'skipped')).toBe(true);
    expect(isAdminOnlyTransition('draft', 'pending_signatures')).toBe(false);
    expect(isAdminOnlyTransition('signed', 'amended')).toBe(false);
  });
});

// ── transitionMonth ─────────────────────────────────────────────────

describe('transitionMonth', () => {
  it('performs a legal transition and writes an audit row in the same flow', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 1),
      state: 'draft',
    });

    const updated = await transitionMonth({
      db: fakePrisma,
      monthId: m.id,
      to: 'pending_signatures',
      actor: { userId: 'admin-1', label: null },
    });

    expect(updated.state).toBe('pending_signatures');
    expect(monthsStore.get(m.id)!.state).toBe('pending_signatures');

    const row = auditRows.find((r) => r.table_name === 'bonus_pay_periods' && r.row_id === m.id);
    expect(row).toBeDefined();
    expect(row!.action).toBe('update');
    expect(row!.actor_user_id).toBe('admin-1');
    expect(JSON.stringify(row!.before)).toContain('draft');
    expect(JSON.stringify(row!.after)).toContain('pending_signatures');
  });

  it('rejects an illegal transition and does NOT mutate state or write audit', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 1),
      state: 'draft',
    });

    await expect(
      transitionMonth({
        db: fakePrisma,
        monthId: m.id,
        to: 'signed',
        actor: { userId: 'admin-1' },
      }),
    ).rejects.toBeInstanceOf(TransitionError);

    expect(monthsStore.get(m.id)!.state).toBe('draft');
    expect(auditRows.length).toBe(0);
  });

  it('throws TransitionError when the month does not exist', async () => {
    await expect(
      transitionMonth({ db: fakePrisma, monthId: 'nope', to: 'paid', actor: { userId: 'a' } }),
    ).rejects.toBeInstanceOf(TransitionError);
    expect(auditRows.length).toBe(0);
  });

  it('supports a system actor via actor.label', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 1),
      state: 'draft',
    });
    await transitionMonth({
      db: fakePrisma,
      monthId: m.id,
      to: 'pending_signatures',
      actor: { label: 'system:period-close-cron' },
    });
    const row = auditRows.find((r) => r.row_id === m.id);
    expect(row!.actor_user_id).toBeNull();
    expect(row!.actor_label).toBe('system:period-close-cron');
  });

  // ── draft -> skipped (T-203, admin-only) ──────────────────────────
  it('lets an admin actor transition draft -> skipped and audits it', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 1),
      state: 'draft',
    });
    const updated = await transitionMonth({
      db: fakePrisma,
      monthId: m.id,
      to: 'skipped',
      actor: { userId: 'bill', isAdmin: true },
    });
    expect(updated.state).toBe('skipped');
    expect(monthsStore.get(m.id)!.state).toBe('skipped');
    const row = auditRows.find((r) => r.row_id === m.id);
    expect(JSON.stringify(row!.after)).toContain('skipped');
  });

  it('refuses draft -> skipped for a NON-admin actor (403) and leaves state/audit untouched', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 1),
      state: 'draft',
    });
    let err: unknown;
    try {
      await transitionMonth({
        db: fakePrisma,
        monthId: m.id,
        to: 'skipped',
        actor: { userId: 'janette', isAdmin: false },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransitionForbiddenError);
    expect((err as TransitionForbiddenError).status).toBe(403);
    expect(monthsStore.get(m.id)!.state).toBe('draft');
    expect(auditRows.length).toBe(0);
  });

  it('still rejects an illegal edge TO skipped from a non-draft state (409, not 403)', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 1),
      state: 'signed',
    });
    await expect(
      transitionMonth({
        db: fakePrisma,
        monthId: m.id,
        to: 'skipped',
        actor: { userId: 'bill', isAdmin: true },
      }),
    ).rejects.toBeInstanceOf(TransitionError);
    expect(monthsStore.get(m.id)!.state).toBe('signed');
  });
});

// ── resolveOpenPayPeriod (T-203 — seeded-period range lookup, no fabrication) ──

describe('resolveOpenPayPeriod', () => {
  // Period 13 of 2026 for Woodland: Tue 2026-06-09 → Mon 2026-06-22 (per seed).
  function seedPeriod13(siteId: string, state: BonusPayPeriodState = 'draft') {
    return seedMonth({
      site_id: siteId,
      period_start: dayUTC(2026, 5, 9), // Jun 9
      period_end: dayUTC(2026, 5, 22), // Jun 22
      state,
    });
  }

  it('returns the SEEDED period whose [start,end] window contains the day', async () => {
    const p = seedPeriod13('site-woodland');
    // A day mid-window, and the inclusive boundaries.
    for (const day of [dayUTC(2026, 5, 9), dayUTC(2026, 5, 15), dayUTC(2026, 5, 22)]) {
      const got = await resolveOpenPayPeriod(fakePrisma, 'site-woodland', day);
      expect(got?.id).toBe(p.id);
    }
    expect(monthsStore.size).toBe(1); // never fabricates a row
  });

  it('returns null when no seeded period covers the day (no fabrication)', async () => {
    seedPeriod13('site-woodland');
    // Jun 23 falls in the next period (not seeded here) → no match.
    const got = await resolveOpenPayPeriod(fakePrisma, 'site-woodland', dayUTC(2026, 5, 23));
    expect(got).toBeNull();
    expect(monthsStore.size).toBe(1);
  });

  it("scopes by site — the same day resolves to each site's own seeded period", async () => {
    const wo = seedPeriod13('site-woodland');
    const eu = seedPeriod13('site-eugene');
    const day = dayUTC(2026, 5, 15);
    expect((await resolveOpenPayPeriod(fakePrisma, 'site-woodland', day))?.id).toBe(wo.id);
    expect((await resolveOpenPayPeriod(fakePrisma, 'site-eugene', day))?.id).toBe(eu.id);
  });

  it('resolves a year-rollover period (Period 1 spans Dec 2025 → Jan 2026)', async () => {
    const p1 = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2025, 11, 23), // Dec 23 2025
      period_end: dayUTC(2026, 0, 5), // Jan 5 2026
      state: 'draft',
    });
    expect(
      (await resolveOpenPayPeriod(fakePrisma, 'site-woodland', dayUTC(2025, 11, 30)))?.id,
    ).toBe(p1.id);
    expect((await resolveOpenPayPeriod(fakePrisma, 'site-woodland', dayUTC(2026, 0, 2)))?.id).toBe(
      p1.id,
    );
  });

  it('getOrCreateDraftPayPeriod is the back-compat alias for resolveOpenPayPeriod', () => {
    expect(getOrCreateDraftPayPeriod).toBe(resolveOpenPayPeriod);
  });

  // A `skipped` period still resolves by date (lookup is state-agnostic), but it
  // is NOT editable — the daily-entry layer rejects writes against it. This is the
  // mechanism by which a skipped period blocks daily entry.
  it('resolves a skipped period by date, but skipped is not an editable state', async () => {
    const p = seedPeriod13('site-woodland', 'skipped');
    const got = await resolveOpenPayPeriod(fakePrisma, 'site-woodland', dayUTC(2026, 5, 15));
    expect(got?.id).toBe(p.id);
    expect(got?.state).toBe('skipped');
    expect(EDITABLE_STATES).not.toContain<BonusPayPeriodState>('skipped');
    expect(() => assertEntriesEditable({ id: p.id, state: 'skipped' })).toThrow(EntriesLockedError);
  });
});

// ── closePayPeriodsDueForSignature ──────────────────────────────────────

describe('closePayPeriodsDueForSignature (T-203 — period_end == Pacific today)', () => {
  // Period 12 of 2026 for Woodland: Tue 2026-05-26 → Mon 2026-06-08 (per seed).
  // The close cron fires Mon 2026-06-08 17:30 PT; `now` is appToday() = the
  // @db.Date key for 2026-06-08. We pin the clock to that boundary instant so the
  // function-under-test (which receives `now` explicitly) is deterministic, and so
  // the assertion documents the Pacific-aware contract the cron relies on.
  const CLOSE_INSTANT = new Date('2026-06-09T00:30:00Z'); // Mon Jun 8 17:30 PDT
  const PERIOD12_END = dayUTC(2026, 5, 8); // Jun 8

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOSE_INSTANT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions a draft period whose period_end == Pacific today to pending_signatures', async () => {
    const due = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 26), // May 26
      period_end: PERIOD12_END, // Jun 8 — closes today
      state: 'draft',
    });
    // Use appToday() (Pacific) — at CLOSE_INSTANT this is the 2026-06-08 key,
    // NOT the UTC day (2026-06-09). That distinction is the load-bearing point.
    const result = await closePayPeriodsDueForSignature(fakePrisma, appToday());

    expect(appToday().getTime()).toBe(PERIOD12_END.getTime()); // Pacific, not UTC
    expect(result.transitioned).toContain(due.id);
    expect(monthsStore.get(due.id)!.state).toBe('pending_signatures');
    expect(auditRows.some((r) => r.row_id === due.id && r.action === 'update')).toBe(true);
  });

  it('leaves periods whose period_end != today alone (earlier AND later)', async () => {
    const earlier = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 12),
      period_end: dayUTC(2026, 4, 25), // May 25 — already past
      state: 'draft',
    });
    const later = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 5, 9),
      period_end: dayUTC(2026, 5, 22), // Jun 22 — future
      state: 'draft',
    });

    const result = await closePayPeriodsDueForSignature(fakePrisma, appToday());

    expect(result.transitioned).toEqual([]);
    expect(monthsStore.get(earlier.id)!.state).toBe('draft');
    expect(monthsStore.get(later.id)!.state).toBe('draft');
  });

  it('ignores a non-draft period even when its period_end == today', async () => {
    const signed = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 26),
      period_end: PERIOD12_END, // closes today, but already signed
      state: 'signed',
    });
    const result = await closePayPeriodsDueForSignature(fakePrisma, appToday());

    expect(result.transitioned).not.toContain(signed.id);
    expect(monthsStore.get(signed.id)!.state).toBe('signed');
  });

  it('is idempotent — a second fire on the same day does not double-transition', async () => {
    const due = seedMonth({
      site_id: 'site-woodland',
      period_start: dayUTC(2026, 4, 26),
      period_end: PERIOD12_END,
      state: 'draft',
    });
    const first = await closePayPeriodsDueForSignature(fakePrisma, appToday());
    expect(first.transitioned).toEqual([due.id]);
    const second = await closePayPeriodsDueForSignature(fakePrisma, appToday());
    expect(second.transitioned).toEqual([]); // already pending_signatures
    expect(monthsStore.get(due.id)!.state).toBe('pending_signatures');
  });
});

// ── assertEntriesEditable ───────────────────────────────────────────

describe('assertEntriesEditable', () => {
  it('passes for a draft month', () => {
    expect(() => assertEntriesEditable({ id: 'x', state: 'draft' })).not.toThrow();
  });

  // ADR-0019 §6 / T-116: an unlocked (amended) month is editable again so Bill
  // can correct the daily counts before re-collecting signatures.
  it('passes for an amended month', () => {
    expect(() => assertEntriesEditable({ id: 'x', state: 'amended' })).not.toThrow();
  });

  const locked: BonusPayPeriodState[] = [
    'pending_signatures',
    'partially_signed',
    'signed',
    'paid',
  ];
  it.each(locked)('throws EntriesLockedError for state %s', (state) => {
    let err: unknown;
    try {
      assertEntriesEditable({ id: 'x', state });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EntriesLockedError);
    expect((err as EntriesLockedError).status).toBe(409);
  });
});
