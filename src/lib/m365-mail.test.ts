// T-114 — M365 Graph mail-send (ADR-0021) tests.
//
// DB/network are fully mocked. We drive the REAL sendPayrollPdf handler with:
//   - a fake graph client (via __testing.setClientFactory) whose `.post()`
//     resolves or throws GraphError-shaped objects ({ statusCode })
//   - an in-memory prisma double (bonusPayPeriod.update + auditLog.create)
//   - a spy on publishNtfy
//   - a synchronous sleep seam so backoff doesn't actually wait
//
// Coverage:
//   1. fail-open when required env unset — logs + returns, no throw, no graph call
//   2. 202 success persists message id + payroll_sent_at + audit + success metric
//   3. simulated 429 retries then succeeds (retry metric, then success)
//   4. exhausted retries publish ntfy + leave state signed (NOT paid), failed metric

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── ntfy double ─────────────────────────────────────────────────
const publishNtfyMock = vi.fn<
  (args: Record<string, unknown>) => Promise<{ ok: boolean; outcome: 'sent' }>
>(async () => ({
  ok: true,
  outcome: 'sent' as const,
}));
vi.mock('@/lib/ntfy', () => ({
  publishNtfy: (args: Record<string, unknown>) => publishNtfyMock(args),
}));

// ── prisma double ───────────────────────────────────────────────
interface MonthRow {
  id: string;
  state: string;
  payroll_sent_at: Date | null;
  payroll_message_id: string | null;
  payroll_retry_count: number;
}
interface AuditRow {
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  after: unknown;
}
const monthsStore = new Map<string, MonthRow>();
const auditRows: AuditRow[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusPayPeriod: {
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = monthsStore.get(where.id);
          if (!row) throw new Error(`no month ${where.id}`);
          if (data['payroll_sent_at'] !== undefined)
            row.payroll_sent_at = data['payroll_sent_at'] as Date | null;
          if (data['payroll_message_id'] !== undefined)
            row.payroll_message_id = data['payroll_message_id'] as string | null;
          // payroll_retry_count is written as a { increment } or absolute number
          const rc = data['payroll_retry_count'] as { increment?: number } | number | undefined;
          if (typeof rc === 'number') row.payroll_retry_count = rc;
          else if (rc && typeof rc.increment === 'number') row.payroll_retry_count += rc.increment;
          return row;
        },
      ),
    },
  },
}));

// audit double writes into auditRows
vi.mock('@/lib/audit', () => ({
  writeAudit: vi.fn(async (args: AuditRow) => {
    auditRows.push(args);
  }),
}));

// ── metrics double — capture payrollDeliverySuccess.inc({outcome}) ──
const metricInc = vi.fn();
vi.mock('@/lib/observability/metrics', () => ({
  payrollDeliverySuccess: { inc: (...a: unknown[]) => metricInc(...a) },
}));

// Import AFTER mocks are registered.
import { sendPayrollPdf, __testing } from './m365-mail';

// ── Fake graph client ───────────────────────────────────────────
//
// A GraphError-shaped throw is `{ statusCode: <n> }`. A network error
// is a plain Error with no statusCode. A 202 success resolves.

function graphError(statusCode: number): Error & { statusCode: number } {
  const e = new Error(`graph ${statusCode}`) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

interface FakeRequest {
  header: (k: string, v: string) => FakeRequest;
  post: (body: unknown) => Promise<unknown>;
}
interface FakeClient {
  api: (path: string) => FakeRequest;
}

/** Build a fake client whose .post() runs `behavior` (counts post calls). */
function fakeClient(behavior: () => Promise<unknown>): { client: FakeClient; calls: () => number } {
  let n = 0;
  const client: FakeClient = {
    api: () => {
      const req: FakeRequest = {
        header: () => req,
        post: async () => {
          n += 1;
          return behavior();
        },
      };
      return req;
    },
  };
  return { client, calls: () => n };
}

const ENV_KEYS = [
  'AUTH_MICROSOFT_ENTRA_ID_TENANT_ID',
  'AUTH_MICROSOFT_ENTRA_ID_ID',
  'AUTH_MICROSOFT_ENTRA_ID_SECRET',
  'M365_MAIL_FROM_ADDRESS',
  'M365_PAYROLL_TO_ADDRESS',
] as const;

function setEnv(): void {
  process.env['AUTH_MICROSOFT_ENTRA_ID_TENANT_ID'] = 'tenant-1';
  process.env['AUTH_MICROSOFT_ENTRA_ID_ID'] = 'client-1';
  process.env['AUTH_MICROSOFT_ENTRA_ID_SECRET'] = 'secret-1';
  process.env['M365_MAIL_FROM_ADDRESS'] = 'dr3-vision@svdp.us';
  process.env['M365_PAYROLL_TO_ADDRESS'] = 'payroll@svdp.us';
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function seedSignedMonth(id = 'bm-1'): MonthRow {
  const row: MonthRow = {
    id,
    state: 'signed',
    payroll_sent_at: null,
    payroll_message_id: null,
    payroll_retry_count: 0,
  };
  monthsStore.set(id, row);
  return row;
}

function baseOpts() {
  return {
    monthId: 'bm-1',
    pdfBuffer: Buffer.from('%PDF-1.7 fake'),
    filename: 'DR3-Woodland-Bonus-September-2026.pdf',
    subject: 'DR3 Woodland Bonus Report — September 2026',
    htmlBody: '<p>Attached is the signed monthly processor bonus report.</p>',
    isAmendment: false,
  };
}

beforeEach(() => {
  monthsStore.clear();
  auditRows.length = 0;
  publishNtfyMock.mockClear();
  metricInc.mockClear();
  __testing.resetClientFactory();
  // Make backoff instantaneous in tests.
  __testing.setSleep(async () => {});
  setEnv();
});

afterEach(() => {
  clearEnv();
});

describe('sendPayrollPdf — fail-open', () => {
  it('returns disabled (no throw, no graph call) when M365_MAIL_FROM_ADDRESS is unset', async () => {
    delete process.env['M365_MAIL_FROM_ADDRESS'];
    seedSignedMonth();
    const factory = vi.fn();
    __testing.setClientFactory(factory as never);

    const res = await sendPayrollPdf(baseOpts());

    expect(res.delivered).toBe(false);
    expect(res.disabled).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(publishNtfyMock).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('returns disabled when an Entra credential env var is unset', async () => {
    delete process.env['AUTH_MICROSOFT_ENTRA_ID_SECRET'];
    seedSignedMonth();

    const res = await sendPayrollPdf(baseOpts());

    expect(res.disabled).toBe(true);
    expect(res.delivered).toBe(false);
  });
});

describe('sendPayrollPdf — success', () => {
  it('persists message id + payroll_sent_at, writes audit, increments success metric on 202', async () => {
    const month = seedSignedMonth();
    const { client, calls } = fakeClient(async () => undefined); // 202: resolves with no body
    __testing.setClientFactory(() => client as never);

    const res = await sendPayrollPdf(baseOpts());

    expect(res.delivered).toBe(true);
    expect(res.disabled).toBe(false);
    expect(res.messageId).toBeTruthy();
    expect(calls()).toBe(1);

    // persistence
    expect(month.payroll_message_id).toBe(res.messageId);
    expect(month.payroll_sent_at).toBeInstanceOf(Date);
    expect(month.payroll_retry_count).toBe(0);
    // state untouched (T-114 does not flip to paid)
    expect(month.state).toBe('signed');

    // audit
    expect(auditRows).toHaveLength(1);
    const a = auditRows[0]!;
    expect(a.actor_label).toBe('system:m365-mail-send');
    expect(a.table_name).toBe('bonus_pay_periods');
    expect(a.row_id).toBe('bm-1');
    const after = a.after as Record<string, unknown>;
    expect(after['recipient']).toBe('payroll@svdp.us');
    expect(after['filename']).toBe(baseOpts().filename);
    expect(after['status']).toBe('sent');

    // metric
    expect(metricInc).toHaveBeenCalledWith({ outcome: 'success' });
    // no failure notification
    expect(publishNtfyMock).not.toHaveBeenCalled();
  });
});

describe('sendPayrollPdf — retry then succeed', () => {
  it('retries on 429 then succeeds; records retry + success metrics', async () => {
    const month = seedSignedMonth();
    let attempt = 0;
    const { client, calls } = fakeClient(async () => {
      attempt += 1;
      if (attempt === 1) throw graphError(429);
      return undefined; // second attempt 202
    });
    __testing.setClientFactory(() => client as never);

    const res = await sendPayrollPdf(baseOpts());

    expect(res.delivered).toBe(true);
    expect(calls()).toBe(2);
    expect(month.payroll_retry_count).toBe(1); // one retry happened
    expect(month.payroll_sent_at).toBeInstanceOf(Date);

    expect(metricInc).toHaveBeenCalledWith({ outcome: 'retry' });
    expect(metricInc).toHaveBeenCalledWith({ outcome: 'success' });
    expect(publishNtfyMock).not.toHaveBeenCalled();
  });
});

describe('sendPayrollPdf — exhausted retries', () => {
  it('publishes ntfy, leaves state signed (not paid), records failed metric', async () => {
    const month = seedSignedMonth();
    const { client, calls } = fakeClient(async () => {
      throw graphError(503); // always retryable, never succeeds
    });
    __testing.setClientFactory(() => client as never);

    const res = await sendPayrollPdf(baseOpts());

    expect(res.delivered).toBe(false);
    expect(res.disabled).toBe(false);
    // 1 initial + 5 retries = 6 attempts
    expect(calls()).toBe(6);

    // state preserved, not advanced to paid
    expect(month.state).toBe('signed');
    expect(month.payroll_sent_at).toBeNull();
    expect(month.payroll_retry_count).toBe(5);

    // ntfy with the contracted fingerprint
    expect(publishNtfyMock).toHaveBeenCalledTimes(1);
    const ntfyArg = publishNtfyMock.mock.calls[0]?.[0] ?? {};
    expect(ntfyArg['topic']).toBe('dr3-vision-system');
    expect(ntfyArg['fingerprint']).toBe('bonus-mail-failed:bm-1');

    // failure audit + metric
    expect(metricInc).toHaveBeenCalledWith({ outcome: 'failed' });
    const failAudit = auditRows.find(
      (r) => (r.after as Record<string, unknown>)['status'] === 'failed',
    );
    expect(failAudit).toBeTruthy();
  });

  it('surfaces (does not retry) on 403 permission denied', async () => {
    seedSignedMonth();
    const { client, calls } = fakeClient(async () => {
      throw graphError(403);
    });
    __testing.setClientFactory(() => client as never);

    const res = await sendPayrollPdf(baseOpts());

    expect(res.delivered).toBe(false);
    expect(calls()).toBe(1); // no retries on 403
    expect(publishNtfyMock).toHaveBeenCalledTimes(1);
    expect(metricInc).toHaveBeenCalledWith({ outcome: 'failed' });
  });

  it('refreshes and retries once on 401, then succeeds', async () => {
    const month = seedSignedMonth();
    let attempt = 0;
    let factoryCalls = 0;
    const { client } = fakeClient(async () => {
      attempt += 1;
      if (attempt === 1) throw graphError(401);
      return undefined;
    });
    __testing.setClientFactory(() => {
      factoryCalls += 1;
      return client as never;
    });

    const res = await sendPayrollPdf(baseOpts());

    expect(res.delivered).toBe(true);
    expect(attempt).toBe(2);
    // a fresh client is built for the post-401 refresh
    expect(factoryCalls).toBeGreaterThanOrEqual(2);
    expect(month.payroll_sent_at).toBeInstanceOf(Date);
  });
});
