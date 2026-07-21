// Audit P1-4 — stranded-period keying fix for the bonus escalation orchestration.
//
// Before the fix, `runEscalationTier` keyed EVERY tier to `period_end == yesterday`
// only (escalation.ts:139). A period that missed its entire escalation window (the
// daemon or app was down that morning, so t1–t4 never processed it) was never
// re-examined and stranded FOREVER unpaged. t4 now looks back with `lte` so such a
// period is re-detected and PAGES every 09:00 PT run — WITHOUT auto-signing it
// late (t3 keeps its yesterday-only scoping; late auto-override is out of policy
// per ADR-0019.1's tight Tue 08:30/09:00 PT window).
//
// These tests exercise `runEscalationTier` directly against an in-memory db double
// (ntfy / payroll-delivery / signature service all mocked), mirroring the setup in
// `../escalation.test.ts` but with period rows carrying distinct `period_end`s.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RecordSignatureResult } from '../signatures';
import type { SignatureChain } from '../signature-chain';

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

import { runEscalationTier, type EscalationDb } from '../escalation';

// ── Fixtures ─────────────────────────────────────────────────────────
const TODAY = new Date(Date.UTC(2026, 5, 9)); // Tue Jun 9 2026 (Pacific "today" key)
const YESTERDAY = new Date(Date.UTC(2026, 5, 8)); // Mon Jun 8 2026
const STRANDED_END = new Date(Date.UTC(2026, 5, 5)); // Fri Jun 5 — 3 days before yesterday
const WOODLAND = 'site-woodland';

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

function period(over: Partial<PeriodFixture> = {}): PeriodFixture {
  return {
    id: 'p13',
    site_id: WOODLAND,
    period_number: 13,
    period_year: 2026,
    period_end: YESTERDAY,
    state: 'pending_signatures',
    facility_signed_by_user_id: null,
    ops_signed_by_user_id: null,
    site: { code: 'woodland', name: 'Woodland' },
    ...over,
  };
}

let periods: PeriodFixture[];

/** A db double whose findMany honours both the equality (t1–t3) and `lte` (t4) shapes. */
function makeDb(): EscalationDb {
  const db = {
    bonusPayPeriod: {
      findMany: async (args: {
        where: {
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
  };
  return db as unknown as EscalationDb;
}

function ntfyCall(n = 0): NtfyArgs {
  const call = publishNtfy.mock.calls[n];
  if (!call) throw new Error(`no publishNtfy call at index ${n}`);
  return call[0];
}

beforeEach(() => {
  publishNtfy.mockClear();
  triggerPayrollDelivery.mockClear();
  recordSignature.mockReset();
  getSignatureChain.mockReset();
  periods = [];
});

// ── t4 stranded detection ────────────────────────────────────────────
describe('t4 — stranded period (period_end before yesterday)', () => {
  it('PAGES a stranded, still-unpaid period with the stranded fingerprint (not the deadline-missed one)', async () => {
    periods = [period({ period_end: STRANDED_END, state: 'pending_signatures' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });

    expect(res.stranded).toBe(1);
    expect(res.deadlineMissed).toBe(0);
    expect(res.ntfyPublished).toBe(1);
    const arg = ntfyCall();
    expect(arg.priority).toBe('urgent');
    expect(arg.fingerprint).toBe('bonus-period-stranded:woodland:p13');
    expect(String(arg.title)).toContain('STRANDED');
    expect(arg.body).toContain('3 days ago');
    // The system must NOT auto-sign a period this late.
    expect(recordSignature).not.toHaveBeenCalled();
    expect(triggerPayrollDelivery).not.toHaveBeenCalled();
  });

  it('does NOT page a stranded period in a terminal/archival state (historical_imported)', async () => {
    periods = [period({ period_end: STRANDED_END, state: 'historical_imported' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.stranded).toBe(0);
    expect(res.ntfyPublished).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('does NOT page a stranded period that already reached paid', async () => {
    periods = [period({ period_end: STRANDED_END, state: 'paid' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.stranded).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('pages both a yesterday deadline-miss AND an older stranded period, with distinct fingerprints', async () => {
    periods = [
      period({ id: 'p13', period_end: YESTERDAY, state: 'signed' }),
      period({ id: 'p11', period_number: 11, period_end: STRANDED_END, state: 'pending_signatures' }),
    ];
    const res = await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(res.deadlineMissed).toBe(1);
    expect(res.stranded).toBe(1);
    expect(res.ntfyPublished).toBe(2);
    const fps = publishNtfy.mock.calls.map((c) => c[0].fingerprint).sort();
    expect(fps).toEqual([
      'bonus-payroll-deadline-missed:woodland:p13',
      'bonus-period-stranded:woodland:p11',
    ]);
  });

  it('singularizes "1 day ago" for a period stranded exactly one extra day', async () => {
    const twoDaysBack = new Date(Date.UTC(2026, 5, 7)); // Jun 7 — 1 day before yesterday (Jun 8)
    periods = [period({ period_end: twoDaysBack, state: 'draft' })];
    await runEscalationTier({ db: makeDb(), tier: 't4', now: TODAY });
    expect(ntfyCall().body).toContain('1 day ago');
  });
});

// ── t3 must NOT auto-sign a stranded period late ─────────────────────
describe('t3 — never auto-signs a period past its own window', () => {
  it('ignores an older stranded period entirely (yesterday-only keying preserved)', async () => {
    periods = [period({ period_end: STRANDED_END, state: 'pending_signatures' })];
    const res = await runEscalationTier({ db: makeDb(), tier: 't3', now: TODAY });
    // t3 keys on `period_end == yesterday`; the stranded period_end does not match.
    expect(res.periodsExamined).toBe(0);
    expect(res.autoSigned).toBe(0);
    expect(recordSignature).not.toHaveBeenCalled();
    expect(getSignatureChain).not.toHaveBeenCalled();
  });
});
