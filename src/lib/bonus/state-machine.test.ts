// T-106 — Monthly state machine (ADR-0019 §5/§6).
//
// DB-free: we inject a fake prisma/tx (the modules under test all accept an
// injected client) and assert against an in-memory store. The transition
// table, guards, and date math are pure and exercised directly.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  transitionMonth,
  getOrCreateDraftMonth,
  closeMonthsDueForSignature,
  assertEntriesEditable,
  TransitionError,
  EntriesLockedError,
  type BonusMonthRow,
  type BonusMonthState,
  type BonusMonthDb,
} from './state-machine';

// ── In-memory fake prisma/tx ────────────────────────────────────────
//
// Implements only the surface the state machine touches:
//   bonusMonth.findUnique({ where: { site_id_month_start } })
//   bonusMonth.findFirst({ where })
//   bonusMonth.findMany({ where })
//   bonusMonth.create({ data })
//   bonusMonth.update({ where: { id }, data })
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
  p: Partial<BonusMonthRow> & { site_id: string; month_start: Date },
): BonusMonthRow {
  const id = p.id ?? `bm-${++seq}`;
  const ms = p.month_start;
  const row: BonusMonthRow = {
    id,
    site_id: p.site_id,
    month_start: ms,
    month_end: p.month_end ?? dayUTC(ms.getUTCFullYear(), ms.getUTCMonth() + 1, 0),
    state: p.state ?? 'draft',
  };
  monthsStore.set(id, row);
  return row;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

const fakePrisma = {
  bonusMonth: {
    findUnique: async ({
      where,
    }: {
      where: { site_id_month_start?: { site_id: string; month_start: Date }; id?: string };
    }) => {
      if (where.id) return monthsStore.get(where.id) ?? null;
      const key = where.site_id_month_start;
      if (key) {
        for (const r of monthsStore.values()) {
          if (r.site_id === key.site_id && sameDay(r.month_start, key.month_start)) return r;
        }
      }
      return null;
    },
    findMany: async ({
      where,
    }: {
      where?: { site_id?: string; state?: BonusMonthState; month_end?: { lt?: Date } };
    } = {}) => {
      const out: BonusMonthRow[] = [];
      for (const r of monthsStore.values()) {
        if (where?.site_id && r.site_id !== where.site_id) continue;
        if (where?.state && r.state !== where.state) continue;
        if (where?.month_end?.lt && !(r.month_end.getTime() < where.month_end.lt.getTime()))
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
        month_start: data.month_start,
        month_end: data.month_end,
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
  const legal: Array<[BonusMonthState, BonusMonthState]> = [
    ['draft', 'pending_signatures'],
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

  const illegal: Array<[BonusMonthState, BonusMonthState]> = [
    ['draft', 'signed'],
    ['draft', 'paid'],
    ['draft', 'partially_signed'],
    ['signed', 'draft'],
    ['paid', 'draft'],
    ['paid', 'signed'],
    ['pending_signatures', 'signed'],
    ['amended', 'draft'],
    ['draft', 'draft'],
  ];

  it.each(illegal)('rejects %s -> %s', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(false);
  });

  it('ALLOWED_TRANSITIONS only lists the seven legal edges', () => {
    const edges = Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, tos]) =>
      (tos as BonusMonthState[]).map((to) => `${from}->${to}`),
    );
    expect(edges.sort()).toEqual(
      [
        'draft->pending_signatures',
        'pending_signatures->partially_signed',
        'partially_signed->signed',
        'signed->paid',
        'signed->amended',
        'paid->amended',
        'amended->pending_signatures',
      ].sort(),
    );
  });
});

// ── transitionMonth ─────────────────────────────────────────────────

describe('transitionMonth', () => {
  it('performs a legal transition and writes an audit row in the same flow', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      month_start: dayUTC(2026, 4, 1),
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

    const row = auditRows.find((r) => r.table_name === 'bonus_months' && r.row_id === m.id);
    expect(row).toBeDefined();
    expect(row!.action).toBe('update');
    expect(row!.actor_user_id).toBe('admin-1');
    expect(JSON.stringify(row!.before)).toContain('draft');
    expect(JSON.stringify(row!.after)).toContain('pending_signatures');
  });

  it('rejects an illegal transition and does NOT mutate state or write audit', async () => {
    const m = seedMonth({
      site_id: 'site-woodland',
      month_start: dayUTC(2026, 4, 1),
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
      month_start: dayUTC(2026, 4, 1),
      state: 'draft',
    });
    await transitionMonth({
      db: fakePrisma,
      monthId: m.id,
      to: 'pending_signatures',
      actor: { label: 'system:month-close-cron' },
    });
    const row = auditRows.find((r) => r.row_id === m.id);
    expect(row!.actor_user_id).toBeNull();
    expect(row!.actor_label).toBe('system:month-close-cron');
  });
});

// ── getOrCreateDraftMonth ───────────────────────────────────────────

describe('getOrCreateDraftMonth', () => {
  it('creates a draft month covering the given date (correct month boundaries)', async () => {
    const created = await getOrCreateDraftMonth(fakePrisma, 'site-woodland', dayUTC(2026, 1, 14)); // Feb 14
    expect(created.state).toBe('draft');
    expect(created.month_start.getTime()).toBe(dayUTC(2026, 1, 1).getTime()); // Feb 1
    expect(created.month_end.getTime()).toBe(dayUTC(2026, 1, 28).getTime()); // Feb 28 (2026 not leap)
    expect(monthsStore.size).toBe(1);
  });

  it('is idempotent — second call returns the same row, does not create a duplicate', async () => {
    const a = await getOrCreateDraftMonth(fakePrisma, 'site-woodland', dayUTC(2026, 4, 3));
    const b = await getOrCreateDraftMonth(fakePrisma, 'site-woodland', dayUTC(2026, 4, 27));
    expect(b.id).toBe(a.id);
    expect(monthsStore.size).toBe(1);
  });

  it('scopes by site — different sites get different rows for the same month', async () => {
    await getOrCreateDraftMonth(fakePrisma, 'site-woodland', dayUTC(2026, 4, 3));
    await getOrCreateDraftMonth(fakePrisma, 'site-eugene', dayUTC(2026, 4, 3));
    expect(monthsStore.size).toBe(2);
  });

  it('computes Dec month_end correctly (year rollover)', async () => {
    const dec = await getOrCreateDraftMonth(fakePrisma, 'site-woodland', dayUTC(2026, 11, 9)); // Dec 9
    expect(dec.month_start.getTime()).toBe(dayUTC(2026, 11, 1).getTime());
    expect(dec.month_end.getTime()).toBe(dayUTC(2026, 11, 31).getTime());
  });
});

// ── closeMonthsDueForSignature ──────────────────────────────────────

describe('closeMonthsDueForSignature', () => {
  it('transitions ended draft months to pending_signatures', async () => {
    const ended = seedMonth({
      site_id: 'site-woodland',
      month_start: dayUTC(2026, 3, 1), // April
      month_end: dayUTC(2026, 3, 30),
      state: 'draft',
    });
    const now = dayUTC(2026, 4, 2); // May 2 — April has ended

    const result = await closeMonthsDueForSignature(fakePrisma, now);

    expect(result.transitioned).toContain(ended.id);
    expect(monthsStore.get(ended.id)!.state).toBe('pending_signatures');
    expect(auditRows.some((r) => r.row_id === ended.id && r.action === 'update')).toBe(true);
  });

  it('leaves the current (not-yet-ended) draft month alone', async () => {
    const current = seedMonth({
      site_id: 'site-woodland',
      month_start: dayUTC(2026, 4, 1), // May
      month_end: dayUTC(2026, 4, 31),
      state: 'draft',
    });
    const now = dayUTC(2026, 4, 15); // mid-May

    const result = await closeMonthsDueForSignature(fakePrisma, now);

    expect(result.transitioned).not.toContain(current.id);
    expect(monthsStore.get(current.id)!.state).toBe('draft');
  });

  it('ignores non-draft months even if ended', async () => {
    const signed = seedMonth({
      site_id: 'site-woodland',
      month_start: dayUTC(2026, 2, 1),
      month_end: dayUTC(2026, 2, 31),
      state: 'signed',
    });
    const now = dayUTC(2026, 4, 1);

    const result = await closeMonthsDueForSignature(fakePrisma, now);

    expect(result.transitioned).not.toContain(signed.id);
    expect(monthsStore.get(signed.id)!.state).toBe('signed');
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

  const locked: BonusMonthState[] = ['pending_signatures', 'partially_signed', 'signed', 'paid'];
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
