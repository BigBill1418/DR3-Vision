// T-205 + T-206 — Bonus escalation orchestration unit tests.
//
// Exercises `runEscalationTier` directly against an in-memory db double, with the
// ntfy publisher, the payroll-delivery side-effect, the signature service, and
// the signature-chain lookup all mocked (per the spec: "mock ntfy + the chain").
// The clock is pinned via a fixed `now` (the @db.Date Pacific "today" key) passed
// in — `runEscalationTier` is deterministic given `now`, so no fake timers are
// needed for the orchestration itself (the daemon's Pacific scheduling is tested
// separately in `__tests__/bonus-escalation-cron.test.ts`).
//
// Scenario anchor (ADR-0019.1): "today" is Tue Jun 9, 2026; the period that
// closed Mon Jun 8 has `period_end = 2026-06-08`. The escalation tiers examine
// that yesterday's-close period.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RecordSignatureResult } from './signatures';
import type { SignatureChain } from './signature-chain';

// ── Mocks ────────────────────────────────────────────────────────────
interface NtfyArgs {
  topic: string;
  title: string;
  body: string;
  priority?: string;
  tags?: readonly string[];
  fingerprint?: string;
  cooldownMs?: number;
}
const publishNtfy =
  vi.fn<(args: NtfyArgs) => Promise<{ ok: boolean; outcome: 'sent' }>>(async () => ({
    ok: true,
    outcome: 'sent' as const,
  }));

/** The args of the Nth (default first) publishNtfy call, typed. */
function ntfyCall(n = 0): NtfyArgs {
  const call = publishNtfy.mock.calls[n];
  if (!call) throw new Error(`no publishNtfy call at index ${n}`);
  return call[0];
}
const triggerPayrollDelivery = vi.fn();
const recordSignature = vi.fn<(opts: unknown) => Promise<RecordSignatureResult>>();
const getSignatureChain = vi.fn<(siteId: string, db?: unknown) => Promise<SignatureChain>>();

vi.mock('@/lib/ntfy', () => ({
  publishNtfy: (args: NtfyArgs) => publishNtfy(args),
}));
vi.mock('@/lib/bonus/payroll-delivery', () => ({
  triggerPayrollDelivery: (...a: unknown[]) => triggerPayrollDelivery(...(a as [])),
}));
vi.mock('@/lib/bonus/signatures', () => ({
  recordSignature: (opts: unknown) => recordSignature(opts),
}));
vi.mock('@/lib/bonus/signature-chain', () => ({
  getSignatureChain: (siteId: string, db?: unknown) => getSignatureChain(siteId, db),
}));

import { runEscalationTier, yesterdayKey, type EscalationDb } from './escalation';

// ── Fixtures ─────────────────────────────────────────────────────────
const TODAY = new Date(Date.UTC(2026, 5, 9)); // Tue Jun 9 2026 (Pacific "today" key)
const PERIOD_END = new Date(Date.UTC(2026, 5, 8)); // Mon Jun 8 2026
const WOODLAND = 'site-woodland';

const WOODLAND_CHAIN: SignatureChain = {
  facility_signer_user_id: 'janette',
  facility_override_actor_user_ids: ['bill', 'morena'],
  ops_signer_user_id: 'morena',
  ops_override_actor_user_ids: ['bill'],
  auto_override_actor_user_id: 'bill',
};

interface PeriodFixture {
  id: string;
  site_id: string;
  period_number: number;
  period_year: number;
  period_end: Date;
  state: string;
  facility_signed_by_user_id: string | null;
  ops_signed_by_user_id: string | null;
  site: { code: string; name: string };
}

let periods: PeriodFixture[];
let users: Array<{ id: string; name: string; is_active: boolean }>;

function pendingPeriod(over: Partial<PeriodFixture> = {}): PeriodFixture {
  return {
    id: 'p13',
    site_id: WOODLAND,
    period_number: 13,
    period_year: 2026,
    period_end: PERIOD_END,
    state: 'pending_signatures',
    facility_signed_by_user_id: null,
    ops_signed_by_user_id: null,
    site: { code: 'woodland', name: 'Woodland' },
    ...over,
  };
}

/** A db double that only implements what the escalation tiers touch. */
function makeDb(): EscalationDb {
  const db = {
    bonusPayPeriod: {
      findMany: async (args: {
        where: {
          // t1–t3 pass an equality Date; t4 (runDeadlineMissed) passes a range.
          period_end: Date | { lte?: Date; lt?: Date };
          state: { in?: string[]; not?: string };
        };
      }) => {
        const pe = args.where.period_end;
        const matchesEnd = (rowEnd: Date): boolean => {
          if (pe instanceof Date) return rowEnd.getTime() === pe.getTime();
          if (pe.lte) return rowEnd.getTime() <= pe.lte.getTime();
          if (pe.lt) return rowEnd.getTime() < pe.lt.getTime();
          return true;
        };
        return periods
          .filter((p) => {
            if (!matchesEnd(p.period_end)) return false;
            const s = args.where.state;
            if (s.in) return s.in.includes(p.state);
            if (s.not) return p.state !== s.not;
            return true;
          })
          .map((p) => ({ ...p }));
      },
    },
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        users.find((u) => u.id === args.where.id) ?? null,
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        users
          .filter((u) => args.where.id.in.includes(u.id))
          .map((u) => ({ id: u.id, name: u.name })),
    },
  };
  return db as unknown as EscalationDb;
}

beforeEach(() => {
  publishNtfy.mockClear();
  triggerPayrollDelivery.mockClear();
  recordSignature.mockReset();
  getSignatureChain.mockReset();
  getSignatureChain.mockResolvedValue(WOODLAND_CHAIN);
  periods = [pendingPeriod()];
  users = [
    { id: 'bill', name: 'Bill Barnard', is_active: true },
    { id: 'morena', name: 'Morena Ruiz', is_active: true },
    { id: 'janette', name: 'Janette Tomas', is_active: true },
  ];
});

// ── yesterdayKey ─────────────────────────────────────────────────────
describe('yesterdayKey', () => {
  it('steps one @db.Date day back (Tue Jun 9 → Mon Jun 8)', () => {
    expect(yesterdayKey(TODAY).toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });
});

// ── t1 06:00 PT ──────────────────────────────────────────────────────
describe('t1 — 06:00 PT low-urgency warning', () => {
  it('publishes a default-priority warning with the :t1 fingerprint for an unsigned period', async () => {
    const res = await runEscalationTier({ db: makeDb(), tier: 't1', now: TODAY });
    expect(res.periodsExamined).toBe(1);
    expect(res.ntfyPublished).toBe(1);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const arg = ntfyCall();
    expect(arg.priority).toBe('default');
    expect(arg.fingerprint).toBe('bonus-escalation-warning:woodland:p13:t1');
    expect(arg.topic).toBe('dr3-vision-system');
    expect(recordSignature).not.toHaveBeenCalled();
  });

  it('does NOT escalate a fully-signed period', async () => {
    periods = [
      pendingPeriod({
        state: 'partially_signed',
        facility_signed_by_user_id: 'janette',
        ops_signed_by_user_id: 'morena',
      }),
    ];
    const res = await runEscalationTier({ db: makeDb(), tier: 't1', now: TODAY });
    expect(res.ntfyPublished).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('ignores periods whose period_end is not yesterday', async () => {
    // findMany filters on period_end; an unrelated period_end yields no rows.
    periods = [];
    const res = await runEscalationTier({ db: makeDb(), tier: 't1', now: TODAY });
    expect(res.periodsExamined).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});

// ── t2 07:30 PT ──────────────────────────────────────────────────────
describe('t2 — 07:30 PT urgent warning with override-authorized humans', () => {
  it('publishes urgent priority with :t2 fingerprint and names the override humans', async () => {
    const res = await runEscalationTier({ db: makeDb(), tier: 't2', now: TODAY });
    expect(res.ntfyPublished).toBe(1);
    const arg = ntfyCall();
    expect(arg.priority).toBe('urgent');
    expect(arg.fingerprint).toBe('bonus-escalation-warning:woodland:p13:t2');
    // Body lists Bill + Morena (override-authorized) by name.
    expect(arg.body).toContain('Bill Barnard');
    expect(arg.body).toContain('Morena Ruiz');
    expect(recordSignature).not.toHaveBeenCalled();
  });
});

// ── t3 08:30 PT auto-override ─────────────────────────────────────────
describe('t3 — 08:30 PT auto-override', () => {
  it('auto-signs both unsigned slots as the chain auto-override actor, then fires payroll delivery', async () => {
    recordSignature.mockImplementation(async (opts) => {
      const o = opts as { onBehalfOf: 'facility' | 'ops' };
      return {
        ok: true,
        slot: o.onBehalfOf,
        state: o.onBehalfOf === 'ops' ? 'signed' : 'partially_signed',
        fullySigned: o.onBehalfOf === 'ops',
        override: true,
        autoOverride: true,
      };
    });

    const res = await runEscalationTier({ db: makeDb(), tier: 't3', now: TODAY });
    expect(res.autoSigned).toBe(2);
    expect(recordSignature).toHaveBeenCalledTimes(2);

    // Each call: signed AS bill (the auto actor), via the override path, with the
    // auto-override flag + the system audit label + the ADR-0019.1 reason.
    for (const call of recordSignature.mock.calls) {
      const o = call[0] as {
        signer: { userId: string; role: string };
        onBehalfOf: string;
        autoOverride: boolean;
        actorLabel: string;
        overrideReason: string;
      };
      expect(o.signer.userId).toBe('bill');
      expect(o.signer.role).toBe('admin');
      expect(o.autoOverride).toBe(true);
      expect(o.actorLabel).toBe('system:bonus-escalation');
      expect(o.overrideReason).toContain('ADR-0019.1 escalation policy');
    }

    // Payroll PDF + M365 delivery fired exactly once for the period.
    expect(triggerPayrollDelivery).toHaveBeenCalledTimes(1);
    expect(triggerPayrollDelivery).toHaveBeenCalledWith('p13');
  });

  it('is idempotent — a slot signed by 08:25 is NOT auto-overridden', async () => {
    // Facility was manually signed before the tick; only ops remains unsigned.
    periods = [pendingPeriod({ state: 'partially_signed', facility_signed_by_user_id: 'janette' })];
    recordSignature.mockImplementation(async (opts) => {
      const o = opts as { onBehalfOf: 'facility' | 'ops' };
      return {
        ok: true,
        slot: o.onBehalfOf,
        state: 'signed',
        fullySigned: true,
        override: true,
        autoOverride: true,
      };
    });

    const res = await runEscalationTier({ db: makeDb(), tier: 't3', now: TODAY });
    // Only the ops slot is auto-signed; facility is left alone.
    expect(res.autoSigned).toBe(1);
    expect(recordSignature).toHaveBeenCalledTimes(1);
    expect((recordSignature.mock.calls[0]![0] as { onBehalfOf: string }).onBehalfOf).toBe('ops');
  });

  it('treats an already_signed rejection from the service as a no-op (idempotent re-fire)', async () => {
    // Simulate a re-POST after both slots were already auto-signed: the service
    // rejects each as already_signed; we must not error and must not deliver.
    recordSignature.mockResolvedValue({
      ok: false,
      reason: 'already_signed',
      slot: 'facility',
    });
    const res = await runEscalationTier({ db: makeDb(), tier: 't3', now: TODAY });
    expect(res.autoSigned).toBe(0);
    expect(triggerPayrollDelivery).not.toHaveBeenCalled();
  });

  it('RISK MITIGATION — inactive auto-override actor: urgent ntfy, no auto-sign, no delivery', async () => {
    users = users.map((u) => (u.id === 'bill' ? { ...u, is_active: false } : u));
    const res = await runEscalationTier({ db: makeDb(), tier: 't3', now: TODAY });
    expect(res.actorUnavailable).toBe(1);
    expect(res.autoSigned).toBe(0);
    expect(recordSignature).not.toHaveBeenCalled();
    expect(triggerPayrollDelivery).not.toHaveBeenCalled();
    const arg = ntfyCall();
    expect(arg.priority).toBe('urgent');
    expect(String(arg.title)).toContain('actor unavailable');
  });

  it('RISK MITIGATION — missing auto-override actor record: urgent ntfy, no auto-sign', async () => {
    users = users.filter((u) => u.id !== 'bill');
    const res = await runEscalationTier({ db: makeDb(), tier: 't3', now: TODAY });
    expect(res.actorUnavailable).toBe(1);
    expect(res.autoSigned).toBe(0);
    expect(recordSignature).not.toHaveBeenCalled();
  });

  it('does nothing for a fully-signed period at t3', async () => {
    periods = [
      pendingPeriod({
        state: 'partially_signed',
        facility_signed_by_user_id: 'janette',
        ops_signed_by_user_id: 'morena',
      }),
    ];
    const res = await runEscalationTier({ db: makeDb(), tier: 't3', now: TODAY });
    expect(res.autoSigned).toBe(0);
    expect(recordSignature).not.toHaveBeenCalled();
    expect(triggerPayrollDelivery).not.toHaveBeenCalled();
  });
});

// ── t4 09:00 PT deadline-missed (T-206) ──────────────────────────────
describe('t4 — 09:00 PT payroll-deadline-missed', () => {
  it('fires urgent deadline-missed ntfy for a non-paid yesterday period', async () => {
    periods = [pendingPeriod({ state: 'signed' })]; // signed but not yet paid
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(1);
    expect(res.ntfyPublished).toBe(1);
    const arg = ntfyCall();
    expect(arg.priority).toBe('urgent');
    expect(arg.fingerprint).toBe('bonus-payroll-deadline-missed:woodland:p13');
  });

  it('does NOT fire for a paid period', async () => {
    periods = [pendingPeriod({ state: 'paid' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('fires for a still-pending_signatures period (auto-override never completed)', async () => {
    periods = [pendingPeriod({ state: 'pending_signatures' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(1);
  });

  it('does NOT fire for a historical_imported period (ADR-0023 archival, not a live deadline)', async () => {
    // Regression: the 2026-06-09 go-live false-positive. Period 12
    // (historical_imported, period_end == yesterday) was wrongly flagged as a
    // missed payroll deadline because the old query was `state != 'paid'`.
    periods = [pendingPeriod({ state: 'historical_imported' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('does NOT fire for a skipped period (pre-cutover, terminal, no PDF)', async () => {
    periods = [pendingPeriod({ state: 'skipped' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('does NOT fire for an amended period (admin correction, paged out-of-band)', async () => {
    periods = [pendingPeriod({ state: 'amended' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('still fires for a draft period that never closed (period-close cron failed)', async () => {
    periods = [pendingPeriod({ state: 'draft' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(1);
  });
});
