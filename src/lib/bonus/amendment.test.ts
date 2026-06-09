// T-116 — Amendment workflow data layer (ADR-0019 §6).
//
// DB-free: an in-memory fake prisma/tx satisfies the structural client types.
// Verifies the unlock / re-submit / month-scoped-edit contract:
//   - unlock signed -> amended: clears BOTH signatures, sets amended_*,
//     self-references amended_from_period_id (PDF marker), preserves payroll_sent_at,
//     and PRESERVES the full prior signed state in an audit row.
//   - unlock paid -> amended likewise.
//   - unlock requires a non-empty reason (422 missing_reason).
//   - unlock of a draft/pending month is rejected (wrong_state).
//   - cross-site month id is not_found (Woodland scope, hard rule #2).
//   - resubmit amended -> pending_signatures (state move + audit).
//   - resubmit of a non-amended month is rejected.
//   - month-scoped entry upsert works while amended, refused once locked.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  unlockMonthForAmendment,
  resubmitAmendedMonth,
  upsertAmendedMonthEntries,
  type AmendmentDb,
  type AmendmentEntryDb,
  type AmendmentMonthRow,
} from './amendment';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

interface AuditRow {
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
}

interface FullMonth extends AmendmentMonthRow {
  period_start: Date;
  period_end: Date;
  payroll_sent_at: Date | null;
  pdf_storage_key: string | null;
}

interface DailyEntry {
  id: string;
  bonus_employee_id: string;
  bonus_pay_period_id: string;
  entry_date: Date;
  mattress_count: number;
  note: string | null;
  entered_by_user_id: string;
}

const monthStore = new Map<string, FullMonth>();
const employeeStore = new Map<string, { id: string; site_id: string }>();
const entryStore: DailyEntry[] = [];
const auditRows: AuditRow[] = [];
let seq = 0;

function reset() {
  monthStore.clear();
  employeeStore.clear();
  entryStore.length = 0;
  auditRows.length = 0;
  seq = 0;
}

function seedSignedMonth(over: Partial<FullMonth> = {}): FullMonth {
  const m: FullMonth = {
    id: 'm1',
    site_id: WOODLAND,
    period_start: new Date(Date.UTC(2026, 4, 1)),
    period_end: new Date(Date.UTC(2026, 4, 31)),
    state: 'signed',
    facility_signed_by_user_id: 'janette',
    facility_signed_at: new Date(Date.UTC(2026, 5, 1, 10)),
    facility_signed_ip: '203.0.113.7',
    facility_signed_user_agent: 'JanetteBrowser/1.0',
    facility_override_actor_id: null,
    facility_override_reason: null,
    ops_signed_by_user_id: 'morena',
    ops_signed_at: new Date(Date.UTC(2026, 5, 1, 11)),
    ops_signed_ip: '203.0.113.8',
    ops_signed_user_agent: 'MorenaBrowser/1.0',
    ops_override_actor_id: null,
    ops_override_reason: null,
    amended_from_period_id: null,
    amendment_reason: null,
    amended_by_user_id: null,
    amended_at: null,
    payroll_sent_at: new Date(Date.UTC(2026, 5, 1, 12)),
    pdf_storage_key: 'pdfs/bonus/woodland/2026-05/orig.pdf',
    ...over,
  };
  monthStore.set(m.id, m);
  return m;
}

// ── Fake prisma satisfying both AmendmentDb and AmendmentEntryDb ────────
const fakeDb = {
  bonusPayPeriod: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const m = monthStore.get(where.id);
      return m ? { ...m } : null;
    },
    findFirst: async ({ where }: { where: { id: string; site_id: string } }) => {
      const m = monthStore.get(where.id);
      if (!m || m.site_id !== where.site_id) return null;
      return { ...m };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const m = monthStore.get(where.id);
      if (!m) throw new Error('not found');
      Object.assign(m, data);
      return { ...m };
    },
  },
  bonusEmployee: {
    findMany: async ({ where }: { where: { id: { in: string[] }; site_id: string } }) =>
      [...employeeStore.values()]
        .filter((e) => where.id.in.includes(e.id) && e.site_id === where.site_id)
        .map((e) => ({ id: e.id })),
  },
  bonusDailyEntry: {
    findUnique: async ({
      where,
    }: {
      where: { bonus_employee_id_entry_date: { bonus_employee_id: string; entry_date: Date } };
    }) => {
      const k = where.bonus_employee_id_entry_date;
      const e = entryStore.find(
        (r) =>
          r.bonus_employee_id === k.bonus_employee_id &&
          r.entry_date.getTime() === k.entry_date.getTime(),
      );
      return e ? { ...e } : null;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { bonus_employee_id_entry_date: { bonus_employee_id: string; entry_date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const k = where.bonus_employee_id_entry_date;
      const existing = entryStore.find(
        (r) =>
          r.bonus_employee_id === k.bonus_employee_id &&
          r.entry_date.getTime() === k.entry_date.getTime(),
      );
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      const row: DailyEntry = {
        id: `de-${++seq}`,
        bonus_employee_id: create['bonus_employee_id'] as string,
        bonus_pay_period_id: create['bonus_pay_period_id'] as string,
        entry_date: create['entry_date'] as Date,
        mattress_count: create['mattress_count'] as number,
        note: (create['note'] as string | null) ?? null,
        entered_by_user_id: create['entered_by_user_id'] as string,
      };
      entryStore.push(row);
      return { ...row };
    },
  },
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push({
        actor_user_id: (data['actor_user_id'] as string | null) ?? null,
        actor_label: (data['actor_label'] as string | null) ?? null,
        action: data['action'] as string,
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        before: data['before'],
        after: data['after'],
      });
      return { id: `audit-${auditRows.length}` };
    },
  },
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
};

const db = fakeDb as unknown as AmendmentDb;
const entryDb = fakeDb as unknown as AmendmentEntryDb;

beforeEach(reset);

// ── Unlock ──────────────────────────────────────────────────────────

describe('unlockMonthForAmendment', () => {
  it('signed -> amended: clears both signatures, sets amended_*, self-refs marker, keeps payroll_sent_at', async () => {
    seedSignedMonth();
    const res = await unlockMonthForAmendment({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill', ip: '198.51.100.1', userAgent: 'BillBrowser/1.0' },
      reason: 'Maria’s 5/12 count was keyed as 60, should be 80.',
    });
    expect(res.ok).toBe(true);

    const m = monthStore.get('m1')!;
    expect(m.state).toBe('amended');
    // Both signature column sets cleared.
    expect(m.facility_signed_by_user_id).toBeNull();
    expect(m.facility_signed_at).toBeNull();
    expect(m.facility_signed_ip).toBeNull();
    expect(m.facility_signed_user_agent).toBeNull();
    expect(m.ops_signed_by_user_id).toBeNull();
    expect(m.ops_signed_at).toBeNull();
    expect(m.ops_signed_ip).toBeNull();
    expect(m.ops_signed_user_agent).toBeNull();
    // Amendment tracking set.
    expect(m.amended_by_user_id).toBe('bill');
    expect(m.amendment_reason).toContain('should be 80');
    expect(m.amended_at).toBeInstanceOf(Date);
    // PDF marker: amended_from_period_id self-reference lights the AMENDED marker.
    expect(m.amended_from_period_id).toBe('m1');
    // Supersedes date preserved.
    expect(m.payroll_sent_at).toBeInstanceOf(Date);
  });

  it('preserves the FULL prior signed state in an audit row (both signatures)', async () => {
    seedSignedMonth();
    await unlockMonthForAmendment({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
      reason: 'correction',
    });
    // The unlock audit row whose before carries both signers.
    const preserved = auditRows.find(
      (r) =>
        r.table_name === 'bonus_pay_periods' &&
        r.row_id === 'm1' &&
        JSON.stringify(r.before).includes('janette') &&
        JSON.stringify(r.before).includes('morena'),
    );
    expect(preserved).toBeDefined();
    expect(preserved!.actor_user_id).toBe('bill');
    const before = preserved!.before as Record<string, unknown>;
    expect(before['facility_signed_by_user_id']).toBe('janette');
    expect(before['ops_signed_by_user_id']).toBe('morena');
    expect(before['state']).toBe('signed');
  });

  it('paid -> amended is allowed', async () => {
    seedSignedMonth({ state: 'paid' });
    const res = await unlockMonthForAmendment({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
      reason: 'late correction after payout',
    });
    expect(res.ok).toBe(true);
    expect(monthStore.get('m1')!.state).toBe('amended');
  });

  it('rejects an empty/whitespace reason with missing_reason', async () => {
    seedSignedMonth();
    const res = await unlockMonthForAmendment({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
      reason: '   ',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing_reason');
    // No mutation on a rejected unlock.
    expect(monthStore.get('m1')!.state).toBe('signed');
    expect(auditRows.length).toBe(0);
  });

  it('rejects unlocking a non-signed/paid month with wrong_state', async () => {
    seedSignedMonth({ state: 'pending_signatures' });
    const res = await unlockMonthForAmendment({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
      reason: 'nope',
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === 'wrong_state') expect(res.state).toBe('pending_signatures');
    expect(monthStore.get('m1')!.state).toBe('pending_signatures');
  });

  it('treats a cross-site month id as not_found (Woodland scope)', async () => {
    seedSignedMonth({ site_id: EUGENE });
    const res = await unlockMonthForAmendment({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
      reason: 'x',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_found');
  });
});

// ── Re-submit ───────────────────────────────────────────────────────

describe('resubmitAmendedMonth', () => {
  it('amended -> pending_signatures (state move + audit)', async () => {
    seedSignedMonth({ state: 'amended' });
    const res = await resubmitAmendedMonth({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
    });
    expect(res.ok).toBe(true);
    expect(monthStore.get('m1')!.state).toBe('pending_signatures');
    expect(auditRows.some((r) => r.table_name === 'bonus_pay_periods' && r.row_id === 'm1')).toBe(
      true,
    );
  });

  it('rejects re-submitting a non-amended month', async () => {
    seedSignedMonth({ state: 'signed' });
    const res = await resubmitAmendedMonth({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === 'wrong_state') expect(res.state).toBe('signed');
  });

  it('treats a cross-site month id as not_found', async () => {
    seedSignedMonth({ state: 'amended', site_id: EUGENE });
    const res = await resubmitAmendedMonth({
      db,
      monthId: 'm1',
      siteId: WOODLAND,
      actor: { userId: 'bill' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_found');
  });
});

// ── Month-scoped edit ───────────────────────────────────────────────

describe('upsertAmendedMonthEntries', () => {
  beforeEach(() => {
    employeeStore.set('e1', { id: 'e1', site_id: WOODLAND });
  });

  it('upserts a count while the month is amended', async () => {
    seedSignedMonth({ state: 'amended' });
    const res = await upsertAmendedMonthEntries(
      entryDb,
      'm1',
      WOODLAND,
      new Date(Date.UTC(2026, 4, 12)),
      [{ bonus_employee_id: 'e1', mattress_count: 80 }],
      { userId: 'bill' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entries[0]!.mattress_count).toBe(80);
      expect(res.entries[0]!.entered_by_user_id).toBe('bill');
    }
    expect(
      auditRows.some((r) => r.table_name === 'bonus_daily_entries' && r.action === 'insert'),
    ).toBe(true);
  });

  it('refuses to edit a still-locked (signed) month', async () => {
    seedSignedMonth({ state: 'signed' });
    const res = await upsertAmendedMonthEntries(
      entryDb,
      'm1',
      WOODLAND,
      new Date(Date.UTC(2026, 4, 12)),
      [{ bonus_employee_id: 'e1', mattress_count: 80 }],
      { userId: 'bill' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === 'month_locked') expect(res.state).toBe('signed');
  });

  it('rejects an employee not in the Woodland site', async () => {
    seedSignedMonth({ state: 'amended' });
    const res = await upsertAmendedMonthEntries(
      entryDb,
      'm1',
      WOODLAND,
      new Date(Date.UTC(2026, 4, 12)),
      [{ bonus_employee_id: 'ghost', mattress_count: 10 }],
      { userId: 'bill' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('employee_not_in_site');
  });

  it('rejects an out-of-range count', async () => {
    seedSignedMonth({ state: 'amended' });
    const res = await upsertAmendedMonthEntries(
      entryDb,
      'm1',
      WOODLAND,
      new Date(Date.UTC(2026, 4, 12)),
      [{ bonus_employee_id: 'e1', mattress_count: 1000 }],
      { userId: 'bill' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('count_out_of_range');
  });

  // T-330 follow-up: this layer now uses the canonical isValidMattressCount
  // contract (0..999, <=1 decimal place), matching the primary daily-entry path,
  // so historical Eugene half-shift corrections (23.5) persist verbatim as the
  // Decimal(5,1) value while two-decimal / negative counts are rejected.
  it('accepts a one-decimal count (23.5) and persists it', async () => {
    seedSignedMonth({ state: 'amended' });
    const res = await upsertAmendedMonthEntries(
      entryDb,
      'm1',
      WOODLAND,
      new Date(Date.UTC(2026, 4, 12)),
      [{ bonus_employee_id: 'e1', mattress_count: 23.5 }],
      { userId: 'bill' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entries[0]!.mattress_count).toBe(23.5);
    expect(entryStore[0]!.mattress_count).toBe(23.5);
  });

  it('rejects a two-decimal count (23.55) as count_out_of_range', async () => {
    seedSignedMonth({ state: 'amended' });
    const res = await upsertAmendedMonthEntries(
      entryDb,
      'm1',
      WOODLAND,
      new Date(Date.UTC(2026, 4, 12)),
      [{ bonus_employee_id: 'e1', mattress_count: 23.55 }],
      { userId: 'bill' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('count_out_of_range');
    expect(entryStore.length).toBe(0);
  });

  it('rejects a negative count (-3) as count_out_of_range', async () => {
    seedSignedMonth({ state: 'amended' });
    const res = await upsertAmendedMonthEntries(
      entryDb,
      'm1',
      WOODLAND,
      new Date(Date.UTC(2026, 4, 12)),
      [{ bonus_employee_id: 'e1', mattress_count: -3 }],
      { userId: 'bill' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('count_out_of_range');
    expect(entryStore.length).toBe(0);
  });
});
