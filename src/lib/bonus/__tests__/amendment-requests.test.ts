// ADR-0028 — Amendment-request service tests.
//
// DB-free: an in-memory prisma store (modeled on bonus-cycle-e2e.test.ts) backs
// the REAL submit/approve/reject/cancel/ping/route-predicate functions. Only the
// boundaries are mocked: @/lib/prisma (the store), @/lib/bonus/signature-chain
// (fixed chains), and @/lib/time#appToday (pinned so prior-day math is
// deterministic). Asserts the four-eyes behavior, the atomic apply-on-approval,
// the audit rows written in-transaction, and the routing predicate.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

// ── signature-chain double ───────────────────────────────────────────
const CHAINS: Record<
  string,
  {
    auto_override_actor_user_id: string;
    facility_signer_user_id: string;
    ops_signer_user_id: string;
  }
> = {
  [WOODLAND]: {
    facility_signer_user_id: 'janette',
    ops_signer_user_id: 'morena',
    auto_override_actor_user_id: 'bill',
  },
  [EUGENE]: {
    facility_signer_user_id: 'rick',
    ops_signer_user_id: 'kelsey',
    auto_override_actor_user_id: 'bill',
  },
};
vi.mock('@/lib/bonus/signature-chain', () => ({
  getSignatureChain: async (siteId: string) => {
    const c = CHAINS[siteId];
    if (!c) throw new Error(`no chain for ${siteId}`);
    return {
      facility_signer_user_id: c.facility_signer_user_id,
      facility_override_actor_user_ids: ['bill'],
      ops_signer_user_id: c.ops_signer_user_id,
      ops_override_actor_user_ids: ['bill'],
      auto_override_actor_user_id: c.auto_override_actor_user_id,
    };
  },
}));

// ── time double — pin "today" to 2026-06-15 (UTC-midnight @db.Date key) ──
const TODAY = new Date(Date.UTC(2026, 5, 15));
vi.mock('@/lib/time', () => ({ appToday: () => TODAY }));

// ── in-memory store ──────────────────────────────────────────────────
interface PeriodRow {
  id: string;
  site_id: string;
  state: string;
}
interface EmployeeRow {
  id: string;
  site_id: string;
}
interface EntryRow {
  id: string;
  bonus_employee_id: string;
  bonus_pay_period_id: string;
  entry_date: Date;
  mattress_count: { toNumber(): number };
  note: string | null;
  entered_by_user_id: string;
  entered_at: Date;
}
interface AmendmentRow {
  id: string;
  bonus_pay_period_id: string;
  site_id: string;
  target_entry_date: Date;
  bonus_employee_id: string;
  change_type: string;
  old_value: unknown;
  new_value: unknown;
  justification: string;
  requested_by_user_id: string;
  requested_at: Date;
  state: string;
  expected_approver_user_id: string;
  bill_pinged_at: Date | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  decision_notes: string | null;
  applied_audit_id: string | null;
  created_at: Date;
  updated_at: Date;
}
interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
}

interface Store {
  periods: PeriodRow[];
  employees: EmployeeRow[];
  entries: EntryRow[];
  amendments: AmendmentRow[];
  audit: AuditRow[];
  bonusPayPeriod: Record<string, (...a: never[]) => unknown>;
  bonusEmployee: Record<string, (...a: never[]) => unknown>;
  bonusDailyEntry: Record<string, (...a: never[]) => unknown>;
  bonusAmendmentRequest: Record<string, (...a: never[]) => unknown>;
  auditLog: Record<string, (...a: never[]) => unknown>;
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}

let store: Store;
let seq = 0;
const dec = (n: number) => ({ toNumber: () => n });

function entryByKey(s: Store, empId: string, date: Date): EntryRow | undefined {
  return s.entries.find(
    (e) => e.bonus_employee_id === empId && e.entry_date.getTime() === date.getTime(),
  );
}

function makeStore(): Store {
  const s: Store = {
    periods: [],
    employees: [],
    entries: [],
    amendments: [],
    audit: [],
    bonusPayPeriod: {},
    bonusEmployee: {},
    bonusDailyEntry: {},
    bonusAmendmentRequest: {},
    auditLog: {},
    $transaction: async (fn) => fn(s),
  };

  s.bonusPayPeriod = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      s.periods.find((p) => p.id === where.id) ?? null,
  };
  s.bonusEmployee = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      s.employees.find((e) => e.id === where.id) ?? null,
  };
  s.bonusDailyEntry = {
    findUnique: async ({
      where,
    }: {
      where: { bonus_employee_id_entry_date: { bonus_employee_id: string; entry_date: Date } };
    }) => {
      const k = where.bonus_employee_id_entry_date;
      return entryByKey(s, k.bonus_employee_id, k.entry_date) ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const e = s.entries.find((x) => x.id === where.id);
      if (!e) throw new Error(`entry ${where.id} not found`);
      if (data['mattress_count'] !== undefined)
        e.mattress_count = dec(data['mattress_count'] as number);
      if ('note' in data) e.note = data['note'] as string | null;
      if (data['entered_by_user_id']) e.entered_by_user_id = data['entered_by_user_id'] as string;
      if (data['entered_at']) e.entered_at = data['entered_at'] as Date;
      return { ...e };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const e: EntryRow = {
        id: `entry-${++seq}`,
        bonus_employee_id: data['bonus_employee_id'] as string,
        bonus_pay_period_id: data['bonus_pay_period_id'] as string,
        entry_date: data['entry_date'] as Date,
        mattress_count: dec(data['mattress_count'] as number),
        note: (data['note'] as string | null) ?? null,
        entered_by_user_id: data['entered_by_user_id'] as string,
        entered_at: (data['entered_at'] as Date) ?? new Date(),
      };
      s.entries.push(e);
      return { ...e };
    },
  };
  s.bonusAmendmentRequest = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const a = s.amendments.find((x) => x.id === where.id);
      return a ? { ...a } : null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      s.amendments
        .filter((a) => {
          for (const [k, v] of Object.entries(where)) {
            if (k === 'target_entry_date') {
              if ((a.target_entry_date as Date).getTime() !== (v as Date).getTime()) return false;
            } else if ((a as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        })
        .map((a) => ({ ...a })),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const a: AmendmentRow = {
        id: `amd-${++seq}`,
        bonus_pay_period_id: data['bonus_pay_period_id'] as string,
        site_id: data['site_id'] as string,
        target_entry_date: data['target_entry_date'] as Date,
        bonus_employee_id: data['bonus_employee_id'] as string,
        change_type: data['change_type'] as string,
        old_value: data['old_value'] === Prisma.JsonNull ? null : data['old_value'],
        new_value: data['new_value'],
        justification: data['justification'] as string,
        requested_by_user_id: data['requested_by_user_id'] as string,
        requested_at: new Date(),
        state: 'pending',
        expected_approver_user_id: data['expected_approver_user_id'] as string,
        bill_pinged_at: null,
        reviewed_by_user_id: null,
        reviewed_at: null,
        decision_notes: null,
        applied_audit_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      s.amendments.push(a);
      return { ...a };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const a = s.amendments.find((x) => x.id === where.id);
      if (!a) throw new Error(`amendment ${where.id} not found`);
      Object.assign(a, data);
      return { ...a };
    },
  };
  s.auditLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: AuditRow = {
        id: `audit-${++seq}`,
        actor_user_id: (data['actor_user_id'] as string | null) ?? null,
        actor_label: (data['actor_label'] as string | null) ?? null,
        action: data['action'] as string,
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        before: data['before'] === Prisma.JsonNull ? null : data['before'],
        after: data['after'],
        ip: (data['ip'] as string | null) ?? null,
        user_agent: (data['user_agent'] as string | null) ?? null,
      };
      s.audit.push(row);
      return { ...row };
    },
  };
  return s;
}

vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy(
    {},
    { get: (_t, prop) => (store as unknown as Record<string | symbol, unknown>)[prop] },
  ),
}));

import {
  submitAmendmentRequest,
  approveAmendmentRequest,
  rejectAmendmentRequest,
  cancelAmendmentRequest,
  pingBill,
  shouldRequireAmendment,
} from '../amendment-requests';
import { AmendmentWorkflowForbiddenError } from '../amendment-approvers';

const PRIOR_DAY = new Date(Date.UTC(2026, 5, 10)); // before TODAY (2026-06-15)

function seedDraftWoodland() {
  store.periods.push({ id: 'p-wo', site_id: WOODLAND, state: 'draft' });
  store.employees.push({ id: 'emp-amy', site_id: WOODLAND });
  store.employees.push({ id: 'emp-eve', site_id: EUGENE });
}

function seedEntry(empId: string, count: number, note: string | null = null) {
  store.entries.push({
    id: `entry-seed-${empId}`,
    bonus_employee_id: empId,
    bonus_pay_period_id: 'p-wo',
    entry_date: PRIOR_DAY,
    mattress_count: dec(count),
    note,
    entered_by_user_id: 'janette',
    entered_at: new Date(),
  });
}

function submitInput(over: Partial<Parameters<typeof submitAmendmentRequest>[0]> = {}) {
  return {
    siteId: WOODLAND,
    bonusPayPeriodId: 'p-wo',
    targetEntryDate: PRIOR_DAY,
    bonusEmployeeId: 'emp-amy',
    changeType: 'update' as const,
    newValue: { mattress_count: 67, note: null },
    justification: 'Keyed 76 by mistake, the real count was 67 mattresses.',
    requesterUserId: 'janette',
    ...over,
  };
}

beforeEach(() => {
  store = makeStore();
  seq = 0;
});

describe('submitAmendmentRequest', () => {
  it('happy path (update): creates a pending row, leaves the period + entry untouched, writes an audit row', async () => {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    const created = await submitAmendmentRequest(submitInput());

    expect(created.state).toBe('pending');
    expect(created.change_type).toBe('update');
    expect(created.expected_approver_user_id).toBe('morena');
    expect(created.old_value).toEqual({ mattress_count: 76, note: null });
    // period unchanged; entry unchanged (still 76).
    expect(store.periods[0]!.state).toBe('draft');
    expect(entryByKey(store, 'emp-amy', PRIOR_DAY)!.mattress_count.toNumber()).toBe(76);
    const audit = store.audit.find(
      (a) => a.table_name === 'bonus_amendment_requests' && a.action === 'insert',
    );
    expect(audit).toBeTruthy();
    expect(audit!.row_id).toBe(created.id);
  });

  it('happy path (insert): creates a pending insert request with no existing entry', async () => {
    seedDraftWoodland();
    const created = await submitAmendmentRequest(
      submitInput({ changeType: 'insert', newValue: { mattress_count: 40, note: null } }),
    );
    expect(created.change_type).toBe('insert');
    expect(created.old_value).toBeNull();
    expect(store.entries.length).toBe(0);
  });

  it('justification < 20 chars → justification_too_short (422)', async () => {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    await expect(
      submitAmendmentRequest(submitInput({ justification: 'too short' })),
    ).rejects.toMatchObject({ reason: 'justification_too_short', status: 422 });
  });

  it('count with two decimals (23.55) → invalid_count', async () => {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    await expect(
      submitAmendmentRequest(submitInput({ newValue: { mattress_count: 23.55, note: null } })),
    ).rejects.toMatchObject({ reason: 'invalid_count', status: 422 });
  });

  it('negative count (-1) → invalid_count', async () => {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    await expect(
      submitAmendmentRequest(submitInput({ newValue: { mattress_count: -1, note: null } })),
    ).rejects.toMatchObject({ reason: 'invalid_count' });
  });

  it('period not in draft → period_not_draft', async () => {
    store.periods.push({ id: 'p-wo', site_id: WOODLAND, state: 'signed' });
    store.employees.push({ id: 'emp-amy', site_id: WOODLAND });
    seedEntry('emp-amy', 76);
    await expect(submitAmendmentRequest(submitInput())).rejects.toMatchObject({
      reason: 'period_not_draft',
    });
  });

  it('employee from the wrong site → employee_not_in_site', async () => {
    seedDraftWoodland();
    await expect(
      submitAmendmentRequest(submitInput({ bonusEmployeeId: 'emp-eve' })),
    ).rejects.toMatchObject({ reason: 'employee_not_in_site' });
  });

  it('update against a non-existent entry → entry_not_found_for_update', async () => {
    seedDraftWoodland();
    await expect(submitAmendmentRequest(submitInput())).rejects.toMatchObject({
      reason: 'entry_not_found_for_update',
    });
  });

  it('insert when an entry already exists → entry_exists_for_insert', async () => {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    await expect(
      submitAmendmentRequest(
        submitInput({ changeType: 'insert', newValue: { mattress_count: 5, note: null } }),
      ),
    ).rejects.toMatchObject({ reason: 'entry_exists_for_insert' });
  });

  it('Patrick (non-chain manager) → propagates AmendmentWorkflowForbiddenError', async () => {
    store.periods.push({ id: 'p-eu', site_id: EUGENE, state: 'draft' });
    store.employees.push({ id: 'emp-eu', site_id: EUGENE });
    await expect(
      submitAmendmentRequest(
        submitInput({
          siteId: EUGENE,
          bonusPayPeriodId: 'p-eu',
          bonusEmployeeId: 'emp-eu',
          changeType: 'insert',
          newValue: { mattress_count: 10, note: null },
          requesterUserId: 'patrick',
        }),
      ),
    ).rejects.toBeInstanceOf(AmendmentWorkflowForbiddenError);
  });

  it('auto-cancels a prior pending request from the same requester for the same target', async () => {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    const first = await submitAmendmentRequest(submitInput());
    const second = await submitAmendmentRequest(
      submitInput({ newValue: { mattress_count: 70, note: null } }),
    );
    expect(second.id).not.toBe(first.id);
    expect(store.amendments.find((a) => a.id === first.id)!.state).toBe('cancelled');
    const supersede = store.audit.find(
      (a) =>
        a.actor_label === 'system:amendment-supersede' &&
        (a.after as { reason?: string }).reason === 'superseded_by_new_request',
    );
    expect(supersede).toBeTruthy();
  });
});

describe('approveAmendmentRequest', () => {
  async function pending(over: Partial<Parameters<typeof submitAmendmentRequest>[0]> = {}) {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    return submitAmendmentRequest(submitInput(over));
  }

  it('happy path (update): applies the new count, writes the entry-audit row, marks approved, links applied_audit_id', async () => {
    const req = await pending();
    const result = await approveAmendmentRequest({
      requestId: req.id,
      reviewerUserId: 'morena',
      reviewerIsAdmin: false,
    });
    // entry now updated to 67, stamped by the reviewer.
    const entry = entryByKey(store, 'emp-amy', PRIOR_DAY)!;
    expect(entry.mattress_count.toNumber()).toBe(67);
    expect(entry.entered_by_user_id).toBe('morena');
    // entry audit row with the amendment-approved label.
    const entryAudit = store.audit.find(
      (a) =>
        a.table_name === 'bonus_daily_entries' && a.actor_label === 'system:amendment-approved',
    );
    expect(entryAudit).toBeTruthy();
    expect(entryAudit!.action).toBe('update');
    // request approved + audit linked.
    expect(result.request.state).toBe('approved');
    expect(result.request.applied_audit_id).toBe(entryAudit!.id);
    expect(result.entryAuditId).toBe(entryAudit!.id);
  });

  it('happy path (insert): creates the missing entry on approval', async () => {
    seedDraftWoodland();
    const req = await submitAmendmentRequest(
      submitInput({ changeType: 'insert', newValue: { mattress_count: 42, note: 'late entry' } }),
    );
    const result = await approveAmendmentRequest({
      requestId: req.id,
      reviewerUserId: 'morena',
      reviewerIsAdmin: false,
    });
    const entry = entryByKey(store, 'emp-amy', PRIOR_DAY)!;
    expect(entry.mattress_count.toNumber()).toBe(42);
    expect(entry.entered_by_user_id).toBe('morena');
    const entryAudit = store.audit.find(
      (a) => a.table_name === 'bonus_daily_entries' && a.action === 'insert',
    );
    expect(entryAudit).toBeTruthy();
    expect(result.request.state).toBe('approved');
  });

  it('the requester trying to approve their own request → not_eligible_to_approve (403)', async () => {
    const req = await pending();
    await expect(
      approveAmendmentRequest({
        requestId: req.id,
        reviewerUserId: 'janette',
        reviewerIsAdmin: false,
      }),
    ).rejects.toMatchObject({ reason: 'not_eligible_to_approve', status: 403 });
  });

  it('a random non-chain non-admin → 403', async () => {
    const req = await pending();
    await expect(
      approveAmendmentRequest({
        requestId: req.id,
        reviewerUserId: 'stranger',
        reviewerIsAdmin: false,
      }),
    ).rejects.toMatchObject({ reason: 'not_eligible_to_approve' });
  });

  it('a non-counterpart admin always wins', async () => {
    const req = await pending();
    const result = await approveAmendmentRequest({
      requestId: req.id,
      reviewerUserId: 'someadmin',
      reviewerIsAdmin: true,
    });
    expect(result.request.state).toBe('approved');
  });

  it('the chain auto-override actor (Bill) with bill_pinged_at set → succeeds', async () => {
    const req = await pending();
    await pingBill(req.id, 'janette', null, null);
    const result = await approveAmendmentRequest({
      requestId: req.id,
      reviewerUserId: 'bill',
      reviewerIsAdmin: false,
    });
    expect(result.request.state).toBe('approved');
  });

  it('the chain auto-override actor (Bill) with bill_pinged_at null → 403', async () => {
    const req = await pending();
    await expect(
      approveAmendmentRequest({
        requestId: req.id,
        reviewerUserId: 'bill',
        reviewerIsAdmin: false,
      }),
    ).rejects.toMatchObject({ reason: 'not_eligible_to_approve' });
  });

  it('period concurrently transitioned out of draft → period_not_draft (409)', async () => {
    const req = await pending();
    store.periods[0]!.state = 'pending_signatures';
    await expect(
      approveAmendmentRequest({
        requestId: req.id,
        reviewerUserId: 'morena',
        reviewerIsAdmin: false,
      }),
    ).rejects.toMatchObject({ reason: 'period_not_draft', status: 409 });
  });
});

describe('rejectAmendmentRequest', () => {
  async function pending() {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    return submitAmendmentRequest(submitInput());
  }

  it('without decisionNotes → reject_requires_notes (422)', async () => {
    const req = await pending();
    await expect(
      rejectAmendmentRequest({
        requestId: req.id,
        reviewerUserId: 'morena',
        reviewerIsAdmin: false,
      }),
    ).rejects.toMatchObject({ reason: 'reject_requires_notes', status: 422 });
  });

  it('happy path: marks rejected with notes, writes an audit row, does NOT touch the entry', async () => {
    const req = await pending();
    const decided = await rejectAmendmentRequest({
      requestId: req.id,
      reviewerUserId: 'morena',
      reviewerIsAdmin: false,
      decisionNotes: 'Count is correct as originally keyed.',
    });
    expect(decided.state).toBe('rejected');
    expect(decided.decision_notes).toBe('Count is correct as originally keyed.');
    expect(entryByKey(store, 'emp-amy', PRIOR_DAY)!.mattress_count.toNumber()).toBe(76);
    const audit = store.audit.find(
      (a) =>
        a.table_name === 'bonus_amendment_requests' &&
        (a.after as { state?: string }).state === 'rejected',
    );
    expect(audit).toBeTruthy();
  });
});

describe('cancelAmendmentRequest', () => {
  async function pending() {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    return submitAmendmentRequest(submitInput());
  }

  it('only the requester can cancel → 403 for others', async () => {
    const req = await pending();
    await expect(cancelAmendmentRequest(req.id, 'morena', null, null)).rejects.toMatchObject({
      reason: 'cancel_only_by_requester',
      status: 403,
    });
  });

  it('the requester cancels → state cancelled + audit row', async () => {
    const req = await pending();
    const updated = await cancelAmendmentRequest(req.id, 'janette', null, null);
    expect(updated.state).toBe('cancelled');
    const audit = store.audit.find(
      (a) => (a.after as { reason?: string }).reason === 'cancelled_by_requester',
    );
    expect(audit).toBeTruthy();
  });
});

describe('pingBill', () => {
  async function pending() {
    seedDraftWoodland();
    seedEntry('emp-amy', 76);
    return submitAmendmentRequest(submitInput());
  }

  it('only the requester can ping → 403 for others', async () => {
    const req = await pending();
    await expect(pingBill(req.id, 'morena', null, null)).rejects.toMatchObject({
      reason: 'cancel_only_by_requester',
      status: 403,
    });
  });

  it('is idempotent: the second ping returns firstPing:false and writes no second audit row', async () => {
    const req = await pending();
    const first = await pingBill(req.id, 'janette', null, null);
    expect(first.firstPing).toBe(true);
    const pingAuditsAfterFirst = store.audit.filter(
      (a) => (a.after as { bill_pinged_at?: string }).bill_pinged_at !== undefined,
    ).length;
    const second = await pingBill(req.id, 'janette', null, null);
    expect(second.firstPing).toBe(false);
    const pingAuditsAfterSecond = store.audit.filter(
      (a) => (a.after as { bill_pinged_at?: string }).bill_pinged_at !== undefined,
    ).length;
    expect(pingAuditsAfterSecond).toBe(pingAuditsAfterFirst);
  });
});

describe('shouldRequireAmendment (routing predicate)', () => {
  const PRIOR = new Date(Date.UTC(2026, 5, 10));

  it('prior day + count change → amendment (update)', () => {
    const r = shouldRequireAmendment(
      {
        periodState: 'draft',
        entryDate: PRIOR,
        newCount: 67,
        existingCount: 76,
        actorIsAdmin: false,
      },
      'old note',
    );
    expect(r.route).toBe('amendment');
    if (r.route !== 'amendment') throw new Error('unreachable');
    expect(r.changeType).toBe('update');
    expect(r.oldValue).toEqual({ mattress_count: 76, note: 'old note' });
  });

  it('prior day + no existing entry → amendment (insert)', () => {
    const r = shouldRequireAmendment({
      periodState: 'draft',
      entryDate: PRIOR,
      newCount: 40,
      existingCount: null,
      actorIsAdmin: false,
    });
    expect(r.route).toBe('amendment');
    if (r.route !== 'amendment') throw new Error('unreachable');
    expect(r.changeType).toBe('insert');
    expect(r.oldValue).toBeNull();
  });

  it('same day (today) + count change → direct (same_day_or_future)', () => {
    const r = shouldRequireAmendment({
      periodState: 'draft',
      entryDate: TODAY,
      newCount: 67,
      existingCount: 76,
      actorIsAdmin: false,
    });
    expect(r).toEqual({ route: 'direct', reason: 'same_day_or_future' });
  });

  it('prior day + note-only change (same count) → direct (note_only_edit)', () => {
    const r = shouldRequireAmendment(
      {
        periodState: 'draft',
        entryDate: PRIOR,
        newCount: 76,
        existingCount: 76,
        actorIsAdmin: false,
      },
      'old note',
    );
    expect(r).toEqual({ route: 'direct', reason: 'note_only_edit' });
  });

  it('admin actor → direct (admin_direct_path)', () => {
    const r = shouldRequireAmendment({
      periodState: 'draft',
      entryDate: PRIOR,
      newCount: 67,
      existingCount: 76,
      actorIsAdmin: true,
    });
    expect(r).toEqual({ route: 'direct', reason: 'admin_direct_path' });
  });

  it('period not draft → direct (period_not_draft_handled_upstream)', () => {
    const r = shouldRequireAmendment({
      periodState: 'signed',
      entryDate: PRIOR,
      newCount: 67,
      existingCount: 76,
      actorIsAdmin: false,
    });
    expect(r).toEqual({ route: 'direct', reason: 'period_not_draft_handled_upstream' });
  });
});
