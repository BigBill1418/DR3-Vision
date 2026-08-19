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
import {
  checkInlineSendBudget,
  planSend,
  GRAPH_INLINE_SEND_LIMIT_BYTES,
  EXCHANGE_MESSAGE_LIMIT_DEFAULT_BYTES,
  sendPayrollPdf,
  sendSystemEmail,
  __testing,
} from './m365-mail';

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

// ── ADR-0034: sendSystemEmail per-message sender/reply-to/cc + object `to` ──
//
// New optional fields on SystemEmailArgs (fromDisplayName, replyTo, cc) and the
// object form of `to`. These must land in the Graph message payload without
// disturbing existing string-`to` callers. We capture the posted payload.

function capturingClient(): {
  client: FakeClient;
  lastPayload: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const client: FakeClient = {
    api: () => {
      const req: FakeRequest = {
        header: () => req,
        post: async (body: unknown) => {
          captured = (body as { message: Record<string, unknown> }).message;
          return undefined; // 202
        },
      };
      return req;
    },
  };
  return { client, lastPayload: () => captured };
}

describe('sendSystemEmail — ADR-0034 sender overrides', () => {
  it('sets from (display name), replyTo, and ccRecipients in the Graph message', async () => {
    const { client, lastPayload } = capturingClient();
    __testing.setClientFactory(() => client as never);

    const res = await sendSystemEmail({
      to: { address: 'rick@svdp.us', name: 'Rick Albritton' },
      subject: 'Your input requested',
      htmlBody: '<p>hi</p>',
      fromDisplayName: 'Bill Barnard via DR3-Vision',
      replyTo: 'bill.barnard@svdp.us',
      cc: ['kelsey@svdp.us'],
    });

    expect(res.delivered).toBe(true);
    const msg = lastPayload();
    // Object `to` carries the display name.
    expect(msg?.['toRecipients']).toEqual([
      { emailAddress: { address: 'rick@svdp.us', name: 'Rick Albritton' } },
    ]);
    // from overrides the display name; the mailbox stays the configured sender.
    expect(msg?.['from']).toEqual({
      emailAddress: { address: 'dr3-vision@svdp.us', name: 'Bill Barnard via DR3-Vision' },
    });
    expect(msg?.['replyTo']).toEqual([{ emailAddress: { address: 'bill.barnard@svdp.us' } }]);
    expect(msg?.['ccRecipients']).toEqual([{ emailAddress: { address: 'kelsey@svdp.us' } }]);
  });

  it('omits from/replyTo/cc when not supplied and accepts a plain string `to` (back-compat)', async () => {
    const { client, lastPayload } = capturingClient();
    __testing.setClientFactory(() => client as never);

    const res = await sendSystemEmail({
      to: 'payroll@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
    });

    expect(res.delivered).toBe(true);
    const msg = lastPayload();
    expect(msg?.['toRecipients']).toEqual([{ emailAddress: { address: 'payroll@svdp.us' } }]);
    expect(msg?.['from']).toBeUndefined();
    expect(msg?.['replyTo']).toBeUndefined();
    expect(msg?.['ccRecipients']).toBeUndefined();
  });
});

// ── The inline-attachment size ceiling ─────────────────────────────────────
//
// Microsoft Graph rejects a `sendMail` carrying inline fileAttachments once the
// request passes 3 MB, and base64 inflates the bytes by a third. Before this
// guard there was no size check on the path at all, and `sendSystemEmail` does
// not throw — so an oversized attachment produced a rejected request that the
// caller was free to record as an ordinary failure, or as nothing at all. These
// tests pin the three properties that make that impossible: nothing is POSTED,
// the refusal is STRUCTURED (not just `delivered:false`), and no throw escapes
// to unwind a decision that has already been committed.

/** A buffer of `mb` megabytes — the only thing these tests care about is size. */
function heavy(mb: number): Buffer {
  return Buffer.alloc(Math.round(mb * 1024 * 1024), 0x41);
}

describe('sendSystemEmail — inline-attachment size ceiling', () => {
  // ADR-0114 CHANGED WHAT "over the inline ceiling" MEANS. It used to mean the
  // message was refused; it now means the message takes the draft + upload-session
  // transport instead of one `sendMail` POST. The MEASUREMENT below is unchanged
  // and still load-bearing — it is what picks the transport — so these tests keep
  // asserting it. What they no longer assert is that exceeding it kills the mail,
  // because that was the defect ADR-0114 fixed, not a contract worth preserving.
  it('measures base64 cost, not raw bytes, when deciding the inline budget', async () => {
    // 2.4 MB raw -> 3.2 MB base64: legal raw, illegal inline.
    const attachment = { filename: 'receipt.pdf', buffer: heavy(2.4) };
    const report = checkInlineSendBudget({
      to: 'mary.scott@svdp.us',
      subject: 'Approved reimbursement',
      htmlBody: '<p>x</p>',
      attachment,
    });

    expect(report).not.toBeNull();
    expect(report?.filenames).toEqual(['receipt.pdf']);
    expect(report?.limitBytes).toBe(GRAPH_INLINE_SEND_LIMIT_BYTES);
    // base64 really is the number that matters — the raw bytes alone are under 3 MB.
    expect(report?.rawAttachmentBytes).toBeLessThan(GRAPH_INLINE_SEND_LIMIT_BYTES);
    expect(report?.encodedAttachmentBytes).toBeGreaterThan(GRAPH_INLINE_SEND_LIMIT_BYTES);
  });

  it('sends an over-inline attachment via the draft path instead of a doomed sendMail', async () => {
    // The pre-ADR-0114 assertion here was `posts === 0` — nothing must reach
    // Graph. That is now wrong in the one way that matters: nothing reaching
    // Graph is precisely why acb03895 never arrived. What must NOT happen is a
    // `sendMail` POST that Graph would reject; the draft route is correct.
    const posted: string[] = [];
    const client: FakeClient = {
      api: (path: string) => {
        const req: FakeRequest = {
          header: () => req,
          post: async () => {
            posted.push(path);
            return /\/messages$/.test(path) ? { id: 'DRAFT1' } : undefined;
          },
        };
        return req;
      },
    };
    __testing.setClientFactory(() => client as never);

    const res = await sendSystemEmail({
      to: 'mary.scott@svdp.us',
      subject: 'Approved reimbursement',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'receipt.pdf', buffer: heavy(2.4) },
    });

    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('upload-session');
    expect(res.oversize).toBeNull();
    expect(posted.some((p) => p.endsWith('/sendMail'))).toBe(false);
  });

  it('is distinguishable from every other non-delivery, so a caller can say WHY', async () => {
    // A transport failure and a size refusal both leave delivered:false. If the
    // only signal were that flag, "Mary was not told because the file was too big"
    // could not be told apart from "Graph was down" — which is how a silent
    // non-delivery gets recorded as a routine retry.
    const failing: FakeClient = {
      api: () => {
        const req: FakeRequest = {
          header: () => req,
          post: async () => {
            throw Object.assign(new Error('boom'), { statusCode: 403 });
          },
        };
        return req;
      },
    };
    __testing.setClientFactory(() => failing as never);

    const transportFailure = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'small.pdf', buffer: Buffer.alloc(16) },
    });
    // Above the MAILBOX limit — the only size that is still unsendable.
    const sizeRefusal = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'huge.pdf', buffer: heavy(30) },
    });

    expect(transportFailure.delivered).toBe(false);
    expect(sizeRefusal.delivered).toBe(false);
    // …and only one of them is a size problem.
    expect(transportFailure.oversize).toBeNull();
    expect(sizeRefusal.oversize).not.toBeNull();
    expect(sizeRefusal.oversize?.ceiling).toBe('exchange-message');
    expect(sizeRefusal.oversize?.limitBytes).toBe(EXCHANGE_MESSAGE_LIMIT_DEFAULT_BYTES);
  });

  it('sums MULTIPLE attachments — the AP path attaches one stamped PDF per original', async () => {
    // Each is comfortably legal alone; together they are not. A per-FILE check
    // would route these inline and Graph would reject the send. The sum is what
    // picks the transport — this is the acb03895 shape exactly.
    const args = {
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachments: [
        { filename: 'a.pdf', buffer: heavy(1.2) },
        { filename: 'b.pdf', buffer: heavy(1.2) },
      ],
    };
    const report = checkInlineSendBudget(args);
    expect(report).not.toBeNull();
    expect(report?.filenames).toEqual(['a.pdf', 'b.pdf']);
    expect(planSend(args).mode).toBe('upload-session');
  });

  it('lets a normal attachment through untouched', async () => {
    const { client, lastPayload } = capturingClient();
    __testing.setClientFactory(() => client as never);

    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'decision.pdf', buffer: heavy(1.6) },
    });

    expect(res.delivered).toBe(true);
    expect(res.oversize).toBeNull();
    // The 1.6 MB composed-PDF budget in @/lib/reimbursements/pdf is chosen to sit
    // under this ceiling; if this ever fails, that budget must move with it.
    const atts = lastPayload()?.['attachments'] as Array<Record<string, unknown>> | undefined;
    expect(atts).toHaveLength(1);
  });

  it('never throws — a committed decision must not unwind because of an attachment', async () => {
    __testing.setClientFactory(() => capturingClient().client as never);
    await expect(
      sendSystemEmail({
        to: 'a@svdp.us',
        subject: 's',
        htmlBody: '<p>x</p>',
        attachment: { filename: 'huge.pdf', buffer: heavy(8) },
      }),
    ).resolves.toMatchObject({ delivered: false });
  });

  it('charges the HTML body against the same ceiling', () => {
    // The limit covers the whole request, so a large body plus a nearly-legal
    // attachment is over even though the attachment alone is not.
    const attachment = { filename: 'x.pdf', buffer: heavy(2.1) };
    expect(
      checkInlineSendBudget({ to: 'a@b.us', subject: 's', htmlBody: '', attachment }),
    ).toBeNull();
    expect(
      checkInlineSendBudget({
        to: 'a@b.us',
        subject: 's',
        htmlBody: 'z'.repeat(300 * 1024),
        attachment,
      }),
    ).not.toBeNull();
  });

  it('ignores messages with no attachment at all (the common case pays nothing)', () => {
    expect(
      checkInlineSendBudget({ to: 'a@b.us', subject: 's', htmlBody: 'z'.repeat(5 * 1024 * 1024) }),
    ).toBeNull();
  });
});
