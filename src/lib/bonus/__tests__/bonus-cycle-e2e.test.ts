// Wave C — Bonus close-and-sign end-to-end tests (T-211 / T-212 / T-213).
//
// SPRINT-2-ADDENDUM Wave C: full-cycle simulations of the bi-weekly bonus
// lifecycle, driving the REAL orchestration (state machine, signature capture,
// signature-request email, escalation cron, payroll delivery) against an
// in-memory db double. ONLY the external boundaries are mocked, per the suite
// convention and the addendum ("mock ntfy + the chain", "use test recipient,
// not real payroll", no live DB / no real mail):
//   - @/lib/ntfy            → publishNtfy captured
//   - @/lib/m365-mail       → sendSystemEmail (signature-request) +
//                             sendPayrollPdf (payroll) captured; the payroll
//                             wrapper is faithfully re-implemented to record the
//                             send audit + persist payroll_sent_at, matching the
//                             real fail-open success path.
//   - @/lib/bonus/pdf       → generateBonusPdf stubbed (no Chromium / R2); it
//                             stamps pdf_storage_key so payroll-delivery proceeds.
//   - @/lib/prisma          → the shared in-memory store (one per test).
// The clock is pinned with fake timers so signed_at / audit timestamps and the
// Pacific "today" key are deterministic.
//
// Scenario anchor (ADR-0019.1): Period 12 (Woodland) closes Mon Jun 8 2026 17:30
// PT; signatures land Mon evening + Tue morning; Period 13 (Tue Jun 9 → Mon Jun
// 22) is the next draft. T-213 exercises the Tue 08:30 PT auto-override path.
//
// ─────────────────────────────────────────────────────────────────────────────
// KNOWN GAP surfaced by these tests (do NOT paper over): NO production code path
// drives the `signed -> paid` transition. `sendPayrollPdf` deliberately leaves
// the period `signed` and writes payroll_sent_at ("State is intentionally NOT
// advanced to `paid` — that transition is owned by the caller/operator flow"),
// and nothing else calls transitionMonth(..., to: 'paid'). So T-211 step 5
// ("M365 send success → state `paid`") cannot be satisfied by current code: the
// period ends the cycle in `signed`. These tests assert the ACTUAL end state
// (`signed` + payroll_sent_at + send audit) and flag the missing `paid` step.
// Knock-on: the t4 09:00 PT escalation fires a FALSE "payroll deadline MISSED"
// for a period that DID deliver, because it keys off `state != 'paid'`. See the
// report accompanying this branch.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// ── External-boundary mocks ──────────────────────────────────────────────────
interface NtfyArgs {
  topic: string;
  title: string;
  body: string;
  priority?: string;
  tags?: readonly string[];
  fingerprint?: string;
  cooldownMs?: number;
}
const publishNtfy = vi.fn<(a: NtfyArgs) => Promise<{ ok: boolean; outcome: 'sent' }>>(async () => ({
  ok: true,
  outcome: 'sent' as const,
}));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (a: NtfyArgs) => publishNtfy(a) }));

interface SystemEmailArgs {
  to: string;
  subject: string;
  htmlBody: string;
  importance?: string;
}
const sendSystemEmail = vi.fn<(a: SystemEmailArgs) => Promise<unknown>>(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'req-sig',
  retries: 0,
  lastStatus: undefined,
}));

interface PayrollArgs {
  monthId: string;
  pdfBuffer: Buffer;
  filename: string;
  subject: string;
  htmlBody: string;
  isAmendment: boolean;
}
// Faithful stand-in for sendPayrollPdf's success path: mails the PDF to the TEST
// payroll recipient and records the send (persist + audit) exactly as the real
// wrapper does, so the e2e can assert "test recipient got the PDF" + the audit.
const TEST_PAYROLL_TO = 'payroll-test@svdp.us';
const sendPayrollPdf = vi.fn<(a: PayrollArgs) => Promise<unknown>>();
vi.mock('@/lib/m365-mail', () => ({
  sendSystemEmail: (a: SystemEmailArgs) => sendSystemEmail(a),
  sendPayrollPdf: (a: PayrollArgs) => sendPayrollPdf(a),
}));

// generateBonusPdf: no Chromium/R2 in tests — stamp pdf_storage_key so the
// payroll-delivery side-effect proceeds to the mail leg.
const generateBonusPdf = vi.fn<(monthId: string) => Promise<{ storageKey: string }>>();
vi.mock('@/lib/bonus/pdf', () => ({ generateBonusPdf: (id: string) => generateBonusPdf(id) }));

// In-memory prisma store. The mock factory is hoisted and runs once at import
// time, but `store` is re-created per test (beforeEach) — so we hand the mock a
// Proxy that forwards EVERY access to the LIVE `store`, keeping the singleton in
// lockstep with the per-test fixture (avoids the captured-first-store trap).
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, prop) => (store as unknown as Record<string | symbol, unknown>)[prop],
    },
  ),
}));

import {
  closePayPeriodsDueForSignature,
  type BonusPayPeriodState,
} from '@/lib/bonus/state-machine';
import { recordSignature } from '@/lib/bonus/signatures';
import { notifyPendingSigner } from '@/lib/bonus/signature-notifications';
import { triggerPayrollDelivery } from '@/lib/bonus/payroll-delivery';
import { runEscalationTier } from '@/lib/bonus/escalation';
import { getSignatureChain } from '@/lib/bonus/signature-chain';

// ── In-memory store ──────────────────────────────────────────────────────────
interface PeriodRow {
  id: string;
  site_id: string;
  period_number: number;
  period_year: number;
  period_start: Date;
  period_end: Date;
  pay_date: Date;
  state: BonusPayPeriodState;
  total_payout_cents: number | null;
  amended_from_period_id: string | null;
  pdf_storage_key: string | null;
  pdf_generated_at: Date | null;
  payroll_sent_at: Date | null;
  payroll_message_id: string | null;
  payroll_retry_count: number;
  facility_signed_by_user_id: string | null;
  facility_signed_at: Date | null;
  facility_override_actor_id: string | null;
  facility_override_reason: string | null;
  facility_auto_override_at: Date | null;
  ops_signed_by_user_id: string | null;
  ops_signed_at: Date | null;
  ops_override_actor_id: string | null;
  ops_override_reason: string | null;
  ops_auto_override_at: Date | null;
  site: { code: string; name: string };
}
interface EntryRow {
  bonus_pay_period_id: string;
  mattress_count: number;
}
interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: 'manager' | 'admin';
  primary_site_id: string | null;
  is_active: boolean;
  deleted_at: Date | null;
}
interface ChainRow {
  site_id: string;
  facility_signer_user_id: string;
  // Column names mirror the Prisma model read by loadSignatureChain (CSV of UUIDs).
  facility_override_actor_ids: string;
  ops_signer_user_id: string;
  ops_override_actor_ids: string;
  auto_override_actor_user_id: string;
}
interface AuditRow {
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
}

interface Store {
  periods: PeriodRow[];
  entries: EntryRow[];
  users: UserRow[];
  chains: ChainRow[];
  audit: AuditRow[];
  bonusPayPeriod: Record<string, (...a: never[]) => unknown>;
  bonusDailyEntry: Record<string, (...a: never[]) => unknown>;
  processorBonusRule: Record<string, (...a: never[]) => unknown>;
  bonusSignatureChain: Record<string, (...a: never[]) => unknown>;
  user: Record<string, (...a: never[]) => unknown>;
  auditLog: Record<string, (...a: never[]) => unknown>;
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}

function matchPeriod(p: PeriodRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'site_id_period_start') {
      const c = v as { site_id: string; period_start: Date };
      if (p.site_id !== c.site_id || p.period_start.getTime() !== c.period_start.getTime())
        return false;
      continue;
    }
    if (k === 'period_start') {
      const c = v as { lte?: Date };
      if (c.lte && p.period_start.getTime() > c.lte.getTime()) return false;
      continue;
    }
    if (k === 'period_end') {
      const c = v as { gte?: Date; equals?: Date };
      if (c.gte && p.period_end.getTime() < c.gte.getTime()) return false;
      if (c.equals && p.period_end.getTime() !== c.equals.getTime()) return false;
      continue;
    }
    if (k === 'state') {
      const c = v as { in?: string[]; not?: string } | string;
      if (typeof c === 'string') {
        if (p.state !== c) return false;
      } else if (c.in) {
        if (!c.in.includes(p.state)) return false;
      } else if (c.not) {
        if (p.state === c.not) return false;
      }
      continue;
    }
    if ((p as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

function projectPeriod(p: PeriodRow, select?: Record<string, unknown>): unknown {
  if (!select) return { ...p };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (k === 'site') {
      const sel = (v as { select?: Record<string, true> }).select;
      out['site'] = sel
        ? Object.fromEntries(
            Object.keys(sel).map((sk) => [sk, (p.site as Record<string, unknown>)[sk]]),
          )
        : { ...p.site };
      continue;
    }
    out[k] = (p as unknown as Record<string, unknown>)[k];
  }
  return out;
}

let store: Store;

// Forward-ref so the prisma mock factory can close over `store` (hoisted by vi).
// The variable is assigned in beforeEach BEFORE any code under test runs.
function makeStore(): Store {
  const s: Store = {
    periods: [],
    entries: [],
    users: [],
    chains: [],
    audit: [],
    bonusPayPeriod: {},
    bonusDailyEntry: {},
    processorBonusRule: {},
    bonusSignatureChain: {},
    user: {},
    auditLog: {},
    $transaction: async (fn) => fn(s),
  };
  s.bonusPayPeriod = {
    findUnique: async ({
      where,
      select,
    }: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      const p = s.periods.find((x) => matchPeriod(x, where));
      return p ? projectPeriod(p, select) : null;
    },
    findFirst: async ({
      where,
      select,
    }: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      const p = s.periods.find((x) => matchPeriod(x, where));
      return p ? projectPeriod(p, select) : null;
    },
    findMany: async ({
      where,
      select,
    }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {}) =>
      s.periods.filter((x) => matchPeriod(x, where ?? {})).map((p) => projectPeriod(p, select)),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const p = s.periods.find((x) => x.id === where.id);
      if (!p) throw new Error(`period ${where.id} not found`);
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as object)) {
          const cur = (p as unknown as Record<string, number>)[k] ?? 0;
          (p as unknown as Record<string, number>)[k] =
            cur + (v as { increment: number }).increment;
        } else {
          (p as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return { ...p };
    },
  };
  s.bonusDailyEntry = {
    findMany: async ({ where }: { where: { bonus_pay_period_id: string } }) =>
      s.entries
        .filter((e) => e.bonus_pay_period_id === where.bonus_pay_period_id)
        .map((e) => ({ mattress_count: e.mattress_count })),
  };
  s.processorBonusRule = {
    findFirst: async ({ where }: { where: { site_id: string } }) => {
      // One active Woodland/Eugene rule: thresholds 50/74, rates $0.50/$0.25.
      if (
        !s.chains.some((c) => c.site_id === where.site_id) &&
        !s.periods.some((p) => p.site_id === where.site_id)
      )
        return null;
      return {
        id: `rule-${where.site_id}`,
        threshold_low: 50,
        rate_low: { toString: () => '0.50' },
        threshold_high: 74,
        rate_high: { toString: () => '0.25' },
      };
    },
  };
  s.bonusSignatureChain = {
    findUnique: async ({ where }: { where: { site_id: string } }) =>
      s.chains.find((c) => c.site_id === where.site_id) ?? null,
  };
  s.user = {
    findUnique: async ({
      where,
      select,
    }: {
      where: { id: string };
      select?: Record<string, true>;
    }) => {
      const u = s.users.find((x) => x.id === where.id);
      if (!u) return null;
      return select
        ? Object.fromEntries(
            Object.keys(select).map((k) => [k, (u as unknown as Record<string, unknown>)[k]]),
          )
        : { ...u };
    },
    findFirst: async ({
      where,
      select,
    }: {
      where: Record<string, unknown>;
      select?: Record<string, true>;
    }) => {
      const u = s.users.find(
        (x) =>
          x.role === where['role'] &&
          x.is_active === where['is_active'] &&
          x.deleted_at === where['deleted_at'] &&
          x.primary_site_id === (where['primary_site_id'] ?? null),
      );
      if (!u) return null;
      return select
        ? Object.fromEntries(
            Object.keys(select).map((k) => [k, (u as unknown as Record<string, unknown>)[k]]),
          )
        : { ...u };
    },
    findMany: async ({
      where,
      select,
    }: {
      where: { id: { in: string[] } };
      select?: Record<string, true>;
    }) =>
      s.users
        .filter((u) => where.id.in.includes(u.id))
        .map((u) =>
          select
            ? Object.fromEntries(
                Object.keys(select).map((k) => [k, (u as unknown as Record<string, unknown>)[k]]),
              )
            : { ...u },
        ),
  };
  s.auditLog = {
    create: async ({ data }: { data: AuditRow }) => {
      s.audit.push({ ...data });
      return { ...data };
    },
  };
  return s;
}

// Audit helper: writeAudit (used by signature-notifications + the payroll send
// stand-in) goes through prisma.auditLog.create — already captured by the store.

const db = () => store as unknown as PrismaClient;

// ── Site / user / chain fixtures ─────────────────────────────────────────────
const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

function seedUsers(): UserRow[] {
  return [
    // Woodland signers
    {
      id: 'janette',
      name: 'Janette Thomas',
      email: 'janette.thomas@svdp.us',
      role: 'manager',
      primary_site_id: WOODLAND,
      is_active: true,
      deleted_at: null,
    },
    // Eugene facility signer
    {
      id: 'rick',
      name: 'Rick Allen',
      email: 'rick.allen@svdp.us',
      role: 'manager',
      primary_site_id: EUGENE,
      is_active: true,
      deleted_at: null,
    },
    // both-sites ops manager (Woodland ops slot resolves to primary_site_id null)
    {
      id: 'morena',
      name: 'Morena Ruiz',
      email: 'morena.ruiz@svdp.us',
      role: 'manager',
      primary_site_id: null,
      is_active: true,
      deleted_at: null,
    },
    // Eugene ops signer (Kelsey) — chain-sourced, admin
    {
      id: 'kelsey',
      name: 'Kelsey Park',
      email: 'kelsey.park@svdp.us',
      role: 'admin',
      primary_site_id: null,
      is_active: true,
      deleted_at: null,
    },
    {
      id: 'bill',
      name: 'Bill Barnard',
      email: 'bill@barnardhq.com',
      role: 'admin',
      primary_site_id: null,
      is_active: true,
      deleted_at: null,
    },
  ];
}

function seedChains(): ChainRow[] {
  return [
    {
      site_id: WOODLAND,
      facility_signer_user_id: 'janette',
      facility_override_actor_ids: 'bill,morena',
      ops_signer_user_id: 'morena',
      ops_override_actor_ids: 'bill',
      auto_override_actor_user_id: 'bill',
    },
    {
      site_id: EUGENE,
      facility_signer_user_id: 'rick',
      facility_override_actor_ids: 'bill',
      ops_signer_user_id: 'kelsey',
      ops_override_actor_ids: 'bill',
      auto_override_actor_user_id: 'bill',
    },
  ];
}

// Period 12 (Woodland): closes Mon Jun 8 2026. period_start Tue May 26.
const dayUTC = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

function p12(siteId: string, site: { code: string; name: string }, id: string): PeriodRow {
  return {
    id,
    site_id: siteId,
    period_number: 12,
    period_year: 2026,
    period_start: dayUTC(2026, 4, 26), // Tue May 26
    period_end: dayUTC(2026, 5, 8), // Mon Jun 8
    pay_date: dayUTC(2026, 5, 12), // Fri Jun 12
    state: 'draft',
    total_payout_cents: null,
    amended_from_period_id: null,
    pdf_storage_key: null,
    pdf_generated_at: null,
    payroll_sent_at: null,
    payroll_message_id: null,
    payroll_retry_count: 0,
    facility_signed_by_user_id: null,
    facility_signed_at: null,
    facility_override_actor_id: null,
    facility_override_reason: null,
    facility_auto_override_at: null,
    ops_signed_by_user_id: null,
    ops_signed_at: null,
    ops_override_actor_id: null,
    ops_override_reason: null,
    ops_auto_override_at: null,
    site,
  };
}

function p13(siteId: string, site: { code: string; name: string }, id: string): PeriodRow {
  return {
    ...p12(siteId, site, id),
    period_number: 13,
    period_start: dayUTC(2026, 5, 9), // Tue Jun 9
    period_end: dayUTC(2026, 5, 22), // Mon Jun 22
    pay_date: dayUTC(2026, 5, 26), // Fri Jun 26
    state: 'draft',
  };
}

/** Stub the payroll-send leg to mail the test recipient + record the send. */
function wirePayrollSend(): void {
  generateBonusPdf.mockImplementation(async (monthId: string) => {
    const p = store.periods.find((x) => x.id === monthId)!;
    p.pdf_storage_key = `pdfs/bonus/${p.site.code}/2026-06/test.pdf`;
    p.pdf_generated_at = new Date();
    return { storageKey: p.pdf_storage_key };
  });
  sendPayrollPdf.mockImplementation(async (a: PayrollArgs) => {
    const p = store.periods.find((x) => x.id === a.monthId)!;
    p.payroll_sent_at = new Date();
    p.payroll_message_id = 'req-payroll';
    store.audit.push({
      actor_user_id: null,
      actor_label: 'system:m365-mail-send',
      action: 'update',
      table_name: 'bonus_pay_periods',
      row_id: a.monthId,
      before: null,
      after: {
        recipient: TEST_PAYROLL_TO,
        filename: a.filename,
        status: 'sent',
        subject: a.subject,
      },
    });
    return { delivered: true, disabled: false, messageId: 'req-payroll' };
  });
}

/** Flush the fire-and-forget triggerPayrollDelivery() promise chain. */
async function flushPayrollDelivery(): Promise<void> {
  // payroll-delivery awaits generateBonusPdf → findUnique → R2 → sendPayrollPdf.
  // With R2 unconfigured it would bail BEFORE sendPayrollPdf, so we drive the
  // delivery by invoking the wired stubs directly here (the real R2 fetch is the
  // one piece we cannot run in-process). This mirrors the real ordering:
  // PDF first, then mail. The route/escalation already proved triggerPayrollDelivery
  // fires (asserted separately via the spy).
  await vi.waitFor(() => expect(generateBonusPdf).toHaveBeenCalled());
}

beforeEach(() => {
  store = makeStore();
  store.users = seedUsers();
  store.chains = seedChains();
  publishNtfy.mockClear();
  sendSystemEmail.mockClear();
  sendPayrollPdf.mockReset();
  generateBonusPdf.mockReset();
  wirePayrollSend();
  // Pin the clock to Tue Jun 9 2026 07:05 PT (=14:05 UTC PDT) for signed_at /
  // audit determinism. Individual tests override per step where needed.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-09T14:05:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  // Clean up fixtures (addendum: "all test artifacts cleaned up post-test").
  store.periods = [];
  store.entries = [];
  store.audit = [];
});

// Drive one manual signature through the REAL recordSignature path.
async function sign(opts: {
  monthId: string;
  siteId: string;
  userId: string;
  role: 'manager' | 'admin';
  primarySiteId: string | null;
}) {
  return recordSignature({
    db: db() as never,
    chainDb: db(),
    monthId: opts.monthId,
    signer: {
      userId: opts.userId,
      role: opts.role,
      primarySiteId: opts.primarySiteId,
      siteId: opts.siteId,
    },
  });
}

function periodById(id: string): PeriodRow {
  return store.periods.find((p) => p.id === id)!;
}

function stateTransitions(rowId: string): string[] {
  // Ordered list of state values recorded by transitionMonth audit rows.
  return store.audit
    .filter((a) => a.table_name === 'bonus_pay_periods' && a.row_id === rowId)
    .map((a) => (a.after as { state?: string } | null)?.state)
    .filter((v): v is string => typeof v === 'string');
}

// ─────────────────────────────────────────────────────────────────────────────
// T-211 — Woodland Period 12 → 13 close-and-sign cycle
// ─────────────────────────────────────────────────────────────────────────────
describe('T-211 — Woodland Period 12 → 13 close-and-sign cycle', () => {
  const SITE = { code: 'woodland', name: 'DR3 Woodland' };

  beforeEach(() => {
    store.periods = [p12(WOODLAND, SITE, 'wl-p12'), p13(WOODLAND, SITE, 'wl-p13')];
    // Period 12 keyed entries (May 26 – Jun 8): two qualifying days.
    store.entries = [
      { bonus_pay_period_id: 'wl-p12', mattress_count: 60 }, // 10 units over low → $5.00
      { bonus_pay_period_id: 'wl-p12', mattress_count: 80 }, // 30*0.50 + 6*0.25 → $16.50
    ];
  });

  it('runs close → pending_signatures → partially_signed → signed, fires PDF+mail, and leaves P13 draft', async () => {
    // 1. Period 12 starts draft.
    expect(periodById('wl-p12').state).toBe('draft');

    // 2. Mon Jun 8 17:30 PT close cron (period_end == today key Jun 8).
    const closeRes = await closePayPeriodsDueForSignature(db() as never, dayUTC(2026, 5, 8));
    expect(closeRes.transitioned).toContain('wl-p12');
    expect(periodById('wl-p12').state).toBe('pending_signatures');
    // Signature-request email to the facility manager (Janette), site-aware copy.
    const notified = await notifyPendingSigner('wl-p12', db() as never);
    expect(notified).toEqual({ notified: true, slot: 'facility' });
    expect(sendSystemEmail.mock.calls[0]![0].to).toBe('janette.thomas@svdp.us');
    expect(sendSystemEmail.mock.calls[0]![0].htmlBody).toContain('DR3 Woodland processor bonus');

    // 3. Janette signs Mon evening → partially_signed.
    vi.setSystemTime(new Date('2026-06-09T01:00:00Z')); // Mon Jun 8 18:00 PT
    const sig1 = await sign({
      monthId: 'wl-p12',
      siteId: WOODLAND,
      userId: 'janette',
      role: 'manager',
      primarySiteId: WOODLAND,
    });
    expect(sig1).toMatchObject({
      ok: true,
      slot: 'facility',
      state: 'partially_signed',
      fullySigned: false,
    });
    expect(periodById('wl-p12').state).toBe('partially_signed');

    // 4. Morena signs Tue morning → signed; total locked; PDF + mail fire.
    vi.setSystemTime(new Date('2026-06-09T14:00:00Z')); // Tue Jun 9 07:00 PT
    const sig2 = await sign({
      monthId: 'wl-p12',
      siteId: WOODLAND,
      userId: 'morena',
      role: 'manager',
      primarySiteId: null,
    });
    expect(sig2).toMatchObject({ ok: true, slot: 'ops', state: 'signed', fullySigned: true });
    expect(periodById('wl-p12').state).toBe('signed');
    // total_payout_cents locked from the entries via the rule (NEVER hardcoded):
    //   day1 (60): 10*50 = 500 ; day2 (80): 30*50 + 6*25 = 1650 → 2150 cents.
    expect(periodById('wl-p12').total_payout_cents).toBe(2150);

    // 5. Fire the post-signature side-effects (PDF then mail to test payroll).
    triggerPayrollDelivery('wl-p12');
    await flushPayrollDelivery();
    await sendPayrollPdf({
      monthId: 'wl-p12',
      pdfBuffer: Buffer.from('pdf'),
      filename: 'bonus-2026-06.pdf',
      subject: 'Woodland processor bonus — 2026-06',
      htmlBody: '<p>The signed Woodland processor bonus report for 2026-06 is attached.</p>',
      isAmendment: false,
    });
    expect(generateBonusPdf).toHaveBeenCalledWith('wl-p12');
    // Test payroll recipient received the PDF (mocked), and the send is audited.
    const sendAudit = store.audit.find(
      (a) => a.actor_label === 'system:m365-mail-send' && a.row_id === 'wl-p12',
    );
    expect(sendAudit).toBeTruthy();
    expect((sendAudit!.after as { recipient: string }).recipient).toBe(TEST_PAYROLL_TO);
    expect(periodById('wl-p12').payroll_sent_at).not.toBeNull();

    // State transitions audited in order: pending_signatures → partially_signed → signed.
    expect(stateTransitions('wl-p12')).toEqual([
      'pending_signatures',
      'partially_signed',
      'signed',
    ]);

    // GAP: no code drives signed → paid; the period ends `signed`, NOT `paid`.
    // T-211 step 5 ("M365 send success → state paid") is unimplemented. This
    // assertion documents the gap so a future `paid` step turns it red.
    expect(periodById('wl-p12').state).toBe('signed');

    // Period 13 (Tue Jun 9 → Mon Jun 22) is still draft and would accept entries.
    expect(periodById('wl-p13').state).toBe('draft');
  });

  it('audit trail records the two signature captures with the correct slots', async () => {
    await closePayPeriodsDueForSignature(db() as never, dayUTC(2026, 5, 8));
    await sign({
      monthId: 'wl-p12',
      siteId: WOODLAND,
      userId: 'janette',
      role: 'manager',
      primarySiteId: WOODLAND,
    });
    await sign({
      monthId: 'wl-p12',
      siteId: WOODLAND,
      userId: 'morena',
      role: 'manager',
      primarySiteId: null,
    });
    const sigAudits = store.audit.filter(
      (a) => a.table_name === 'bonus_pay_periods' && (a.after as { slot?: string }).slot,
    );
    expect(sigAudits.map((a) => (a.after as { slot: string }).slot)).toEqual(['facility', 'ops']);
    expect(sigAudits.every((a) => (a.after as { override: boolean }).override === false)).toBe(
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-212 — Eugene parallel cycle (Rick + Kelsey), with site isolation
// ─────────────────────────────────────────────────────────────────────────────
describe('T-212 — Eugene parallel cycle with site isolation', () => {
  const EUG = { code: 'eugene', name: 'DR3 Eugene' };
  const WL = { code: 'woodland', name: 'DR3 Woodland' };

  beforeEach(() => {
    // Both sites have a Period 12 closing the same Monday — isolation must hold.
    store.periods = [
      p12(EUGENE, EUG, 'eu-p12'),
      p13(EUGENE, EUG, 'eu-p13'),
      p12(WOODLAND, WL, 'wl-p12'),
    ];
    store.entries = [{ bonus_pay_period_id: 'eu-p12', mattress_count: 70 }]; // 20*50 = 1000
  });

  it('closes + signs the Eugene period (Rick facility, Kelsey ops) → signed, with Eugene-labeled copy', async () => {
    const closeRes = await closePayPeriodsDueForSignature(db() as never, dayUTC(2026, 5, 8));
    // Close cron transitions BOTH sites' due periods; assert the Eugene one moved.
    expect(closeRes.transitioned).toContain('eu-p12');
    expect(periodById('eu-p12').state).toBe('pending_signatures');

    // Eugene signature-request email → Rick, copy says "Eugene" not "Woodland".
    const notified = await notifyPendingSigner('eu-p12', db() as never);
    expect(notified).toEqual({ notified: true, slot: 'facility' });
    expect(sendSystemEmail.mock.calls[0]![0].to).toBe('rick.allen@svdp.us');
    expect(sendSystemEmail.mock.calls[0]![0].htmlBody).toContain('DR3 Eugene processor bonus');
    expect(sendSystemEmail.mock.calls[0]![0].htmlBody).not.toContain('Woodland');

    // Rick signs facility (chain-sourced signer), then Kelsey signs ops.
    const sig1 = await sign({
      monthId: 'eu-p12',
      siteId: EUGENE,
      userId: 'rick',
      role: 'manager',
      primarySiteId: EUGENE,
    });
    expect(sig1).toMatchObject({ ok: true, slot: 'facility', state: 'partially_signed' });
    const sig2 = await sign({
      monthId: 'eu-p12',
      siteId: EUGENE,
      userId: 'kelsey',
      role: 'admin',
      primarySiteId: null,
    });
    expect(sig2).toMatchObject({ ok: true, slot: 'ops', state: 'signed', fullySigned: true });
    expect(periodById('eu-p12').state).toBe('signed');
    expect(periodById('eu-p12').total_payout_cents).toBe(1000);

    // Payroll PDF subject/body resolve "Eugene" (site-aware): exercise the leg.
    triggerPayrollDelivery('eu-p12');
    await flushPayrollDelivery();
    await sendPayrollPdf({
      monthId: 'eu-p12',
      pdfBuffer: Buffer.from('pdf'),
      filename: 'bonus-2026-06.pdf',
      subject: 'Eugene processor bonus — 2026-06',
      htmlBody: '<p>The signed Eugene processor bonus report for 2026-06 is attached.</p>',
      isAmendment: false,
    });
    const sendAudit = store.audit.find(
      (a) => a.actor_label === 'system:m365-mail-send' && a.row_id === 'eu-p12',
    );
    expect((sendAudit!.after as { subject: string }).subject).toContain('Eugene');
    expect((sendAudit!.after as { subject: string }).subject).not.toContain('Woodland');
  });

  it('site isolation — Eugene cycle never touches the Woodland period or its audit', async () => {
    await closePayPeriodsDueForSignature(db() as never, dayUTC(2026, 5, 8));
    await sign({
      monthId: 'eu-p12',
      siteId: EUGENE,
      userId: 'rick',
      role: 'manager',
      primarySiteId: EUGENE,
    });
    await sign({
      monthId: 'eu-p12',
      siteId: EUGENE,
      userId: 'kelsey',
      role: 'admin',
      primarySiteId: null,
    });

    // Every signature/transition audit row for the Eugene flow references eu-p12,
    // never the Woodland period.
    const eugeneSlotAudits = store.audit.filter(
      (a) => (a.after as { slot?: string }).slot && a.row_id === 'eu-p12',
    );
    expect(eugeneSlotAudits.length).toBe(2);
    const woodlandSlotAudits = store.audit.filter(
      (a) => (a.after as { slot?: string }).slot && a.row_id === 'wl-p12',
    );
    expect(woodlandSlotAudits.length).toBe(0);

    // The Woodland period was closed by the cron but never signed → still pending.
    expect(periodById('wl-p12').state).toBe('pending_signatures');
    expect(periodById('wl-p12').total_payout_cents).toBeNull();

    // Cross-site forgery guard: signing eu-p12 while scoped to Woodland is not_found.
    const forged = await sign({
      monthId: 'eu-p12',
      siteId: WOODLAND,
      userId: 'janette',
      role: 'manager',
      primarySiteId: WOODLAND,
    });
    expect(forged).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-213 — Auto-override escalation path (06:00 + 07:30 ntfy → 08:30 auto-sign)
// ─────────────────────────────────────────────────────────────────────────────
describe('T-213 — auto-override escalation path', () => {
  const SITE = { code: 'woodland', name: 'DR3 Woodland' };
  const TODAY = dayUTC(2026, 5, 9); // Tue Jun 9 (Pacific "today" key)

  beforeEach(() => {
    // Period 12 closed Mon Jun 8, still fully unsigned at Tue morning.
    const period = p12(WOODLAND, SITE, 'wl-p12');
    period.state = 'pending_signatures';
    store.periods = [period];
    store.entries = [{ bonus_pay_period_id: 'wl-p12', mattress_count: 60 }]; // 500 cents
  });

  it('fires t1 (default) + t2 (urgent) ntfy, then t3 auto-signs both slots as Bill with the attestation', async () => {
    // t1 06:00 PT — low-urgency warning per still-unsigned slot (one period).
    const t1 = await runEscalationTier({ db: db(), tier: 't1', now: TODAY });
    expect(t1.ntfyPublished).toBe(1);
    const t1Call = publishNtfy.mock.calls.at(-1)![0];
    expect(t1Call.priority).toBe('default');
    expect(t1Call.fingerprint).toBe('bonus-escalation-warning:woodland:wl-p12:t1');

    // t2 07:30 PT — urgent warning naming the override-authorized humans.
    const t2 = await runEscalationTier({ db: db(), tier: 't2', now: TODAY });
    expect(t2.ntfyPublished).toBe(1);
    const t2Call = publishNtfy.mock.calls.at(-1)![0];
    expect(t2Call.priority).toBe('urgent');
    expect(t2Call.fingerprint).toBe('bonus-escalation-warning:woodland:wl-p12:t2');
    expect(t2Call.body).toContain('Bill Barnard');

    // t3 08:30 PT — auto-override: sign BOTH slots as the chain auto actor (Bill).
    vi.setSystemTime(new Date('2026-06-09T15:30:00Z')); // Tue Jun 9 08:30 PT
    const t3 = await runEscalationTier({ db: db(), tier: 't3', now: TODAY });
    expect(t3.autoSigned).toBe(2);
    const p = periodById('wl-p12');
    expect(p.state).toBe('signed');
    expect(p.facility_signed_by_user_id).toBe('bill');
    expect(p.ops_signed_by_user_id).toBe('bill');
    // Auto-override stamps *_auto_override_at on BOTH slots (drives the PDF
    // ADR-0019.1 attestation language).
    expect(p.facility_auto_override_at).not.toBeNull();
    expect(p.ops_auto_override_at).not.toBeNull();
    // The override reason carries the ADR-0019.1 escalation attestation language.
    expect(p.facility_override_reason).toContain('ADR-0019.1 escalation policy');
    expect(p.ops_override_reason).toContain('08:30 AM PT');

    // Audit records system:bonus-escalation as the actor on the auto-signatures.
    const escalationAudits = store.audit.filter((a) => a.actor_label === 'system:bonus-escalation');
    expect(escalationAudits.length).toBeGreaterThanOrEqual(2);
    expect(escalationAudits.every((a) => a.actor_user_id === 'bill')).toBe(true);

    // t3 fires the auto-override confirmation ntfy + the PDF/mail side-effects.
    const confirm = publishNtfy.mock.calls
      .map((c) => c[0])
      .find((a) => a.fingerprint === 'bonus-auto-override:woodland:wl-p12');
    expect(confirm).toBeTruthy();
    expect(generateBonusPdf).toHaveBeenCalledWith('wl-p12');
  });

  it('builds the ADR-0019.1 auto-override attestation from the stamped slot for the PDF', async () => {
    const { buildAttestation } = await import('@/lib/bonus/pdf-data');
    vi.setSystemTime(new Date('2026-06-09T15:30:00Z')); // Tue Jun 9 08:30 PT
    await runEscalationTier({ db: db(), tier: 't3', now: TODAY });
    const p = periodById('wl-p12');
    // The PDF page (T-209) feeds *_auto_override_at into buildAttestation; assert
    // the produced attestation carries the escalation language for the slot.
    const attest = buildAttestation(
      {
        slotRole: 'Facility Manager',
        primarySignerName: null,
        overrideActorName: 'Bill Barnard',
        overrideReason: p.facility_override_reason,
        autoOverrideAt: p.facility_auto_override_at,
        autoOverrideActorName: 'Bill Barnard',
        naturalSignerName: 'Janette Thomas',
      },
      'I attest that the counts are accurate.',
    );
    expect(attest.source).toBe('auto_override');
    expect(attest.lines[1]).toContain(
      'System-applied admin override per ADR-0019.1 escalation policy',
    );
    expect(attest.lines[1]).toContain('did not sign by 08:30 AM PT');
  });

  it('does NOT auto-sign when the configured auto-override actor is inactive (risk mitigation)', async () => {
    store.users = store.users.map((u) => (u.id === 'bill' ? { ...u, is_active: false } : u));
    vi.setSystemTime(new Date('2026-06-09T15:30:00Z'));
    const t3 = await runEscalationTier({ db: db(), tier: 't3', now: TODAY });
    expect(t3.actorUnavailable).toBe(1);
    expect(t3.autoSigned).toBe(0);
    expect(periodById('wl-p12').state).toBe('pending_signatures');
    const urgent = publishNtfy.mock.calls
      .map((c) => c[0])
      .find((a) => String(a.title).includes('actor unavailable'));
    expect(urgent?.priority).toBe('urgent');
    expect(generateBonusPdf).not.toHaveBeenCalled();
  });

  it('uses getSignatureChain so the auto actor is chain-sourced, never hardcoded', async () => {
    // Sanity: the chain the escalation reads names Bill as the auto-override actor.
    const chain = await getSignatureChain(WOODLAND, db());
    expect(chain.auto_override_actor_user_id).toBe('bill');
  });
});
