// ADR-0047 acceptance (c)/(d)/D1 — notifyStaff() gate behaviour:
//   - live  ⇒ sends to the real intended recipients;
//   - pilot ⇒ reroutes to active admins with a [PILOT — would have sent to: …]
//             subject + body banner; the intended STAFF receive nothing;
//   - org-wide (site=null) ⇒ pilot unless every site row is live;
//   - an unregistered surface throws UnregisteredSurfaceError (never a silent send).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OversizeAttachmentReport } from '@/lib/m365-mail';

const sendSystemEmail = vi.fn(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'm-1',
  retries: 0,
  lastStatus: 202 as number | undefined,
  oversize: null as OversizeAttachmentReport | null,
  // ADR-0114 — which Graph shape carried it. `notifyStaff` does not branch on
  // this, but the mock's return type is inferred from this literal, so it has to
  // carry every field the real result does or a test cannot set it.
  transport: 'inline' as 'inline' | 'upload-session',
}));
const writeAudit = vi.fn(async () => undefined);

/** Read positional arg `i` of mock call `n` without the empty-tuple type noise. */
function callArg<T>(m: { mock: { calls: unknown[] } }, n: number, i: number): T {
  return (m.mock.calls[n] as unknown[])[i] as T;
}

const surfaceFindUnique = vi.fn();
const surfaceFindMany = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    rolloutSurface: {
      findUnique: (...a: unknown[]) => surfaceFindUnique(...a),
      findMany: (...a: unknown[]) => surfaceFindMany(...a),
    },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
  },
}));
vi.mock('@/lib/m365-mail', () => ({
  sendSystemEmail: (...a: unknown[]) => sendSystemEmail(...(a as [])),
}));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { notifyStaff } from '../notify-staff';
import { UnregisteredSurfaceError } from '../errors';

const ADMINS = [{ email: 'bill@svdp.us', name: 'Bill' }];

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockResolvedValue(ADMINS);
  sendSystemEmail.mockResolvedValue({
    delivered: true,
    disabled: false,
    messageId: 'm-1',
    retries: 0,
    lastStatus: 202,
    oversize: null,
    transport: 'inline',
  });
});

describe('notifyStaff — rollout gate', () => {
  it('LIVE: delivers to the real intended recipients, subject unchanged', async () => {
    surfaceFindUnique.mockResolvedValue({ rollout_state: 'live' });
    const res = await notifyStaff({
      surfaceCode: 'alert_digest',
      site: { id: 'site-w', code: 'woodland' },
      recipients: ['rick@svdp.us'],
      subject: 'Daily digest',
      htmlBody: '<!DOCTYPE html><html><body>hi</body></html>',
    });
    expect(res.mode).toBe('live');
    expect(res.actualRecipients).toEqual(['rick@svdp.us']);
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    const arg = callArg<{ to: unknown; subject: string }>(sendSystemEmail, 0, 0);
    expect(arg.to).toBe('rick@svdp.us');
    expect(arg.subject).toBe('Daily digest');
  });

  it('PILOT: reroutes to admins with header + banner; the staff recipient gets NOTHING', async () => {
    surfaceFindUnique.mockResolvedValue({ rollout_state: 'pilot' });
    const res = await notifyStaff({
      surfaceCode: 'alert_digest',
      site: { id: 'site-w', code: 'woodland' },
      recipients: ['rick@svdp.us'],
      subject: 'Daily digest',
      htmlBody: '<!DOCTYPE html><html><body>hi</body></html>',
    });
    expect(res.mode).toBe('pilot');
    expect(res.actualRecipients).toEqual(['bill@svdp.us']);
    // The intended staff recipient never received the mail. Admins carry a
    // display name, so `to` is an { address, name } object here.
    const recipientsSentTo = sendSystemEmail.mock.calls.map((_c, n) => {
      const to = callArg<{ to: string | { address: string } }>(sendSystemEmail, n, 0).to;
      return typeof to === 'string' ? to : to.address;
    });
    expect(recipientsSentTo).toEqual(['bill@svdp.us']);
    expect(recipientsSentTo).not.toContain('rick@svdp.us');
    const arg = callArg<{ subject: string; htmlBody: string }>(sendSystemEmail, 0, 0);
    expect(arg.subject).toContain('[PILOT — would have sent to: rick@svdp.us]');
    expect(arg.htmlBody).toContain('PILOT MODE');
    expect(arg.htmlBody).toContain('rick@svdp.us');
  });

  it('ORG-WIDE: pilot unless every site row is live (any pilot ⇒ pilot)', async () => {
    surfaceFindMany.mockResolvedValue([{ rollout_state: 'live' }, { rollout_state: 'pilot' }]);
    const res = await notifyStaff({
      surfaceCode: 'ap_notify',
      site: null,
      recipients: ['mary@svdp.us'],
      subject: 'AP',
      htmlBody: '<html><body>x</body></html>',
    });
    expect(res.mode).toBe('pilot');
    expect(res.actualRecipients).toEqual(['bill@svdp.us']);
  });

  it('ORG-WIDE: live only when EVERY site row is live', async () => {
    surfaceFindMany.mockResolvedValue([{ rollout_state: 'live' }, { rollout_state: 'live' }]);
    const res = await notifyStaff({
      surfaceCode: 'ap_notify',
      site: null,
      recipients: ['mary@svdp.us'],
      subject: 'AP',
      htmlBody: '<html><body>x</body></html>',
    });
    expect(res.mode).toBe('live');
    expect(res.actualRecipients).toEqual(['mary@svdp.us']);
  });

  it('UNREGISTERED surface throws UnregisteredSurfaceError (never a silent send)', async () => {
    surfaceFindUnique.mockResolvedValue(null);
    await expect(
      notifyStaff({
        surfaceCode: 'not_a_real_surface',
        site: { id: 'site-w', code: 'woodland' },
        recipients: ['x@svdp.us'],
        subject: 's',
        htmlBody: '<html><body>x</body></html>',
      }),
    ).rejects.toBeInstanceOf(UnregisteredSurfaceError);
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('audits the send decision every time', async () => {
    surfaceFindUnique.mockResolvedValue({ rollout_state: 'live' });
    await notifyStaff({
      surfaceCode: 'alert_digest',
      site: { id: 'site-w', code: 'woodland' },
      recipients: ['rick@svdp.us'],
      subject: 's',
      htmlBody: '<html><body>x</body></html>',
    });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const arg = callArg<{ after?: { mode?: string; intended?: string[] } }>(writeAudit, 0, 0);
    expect(arg.after?.mode).toBe('live');
    expect(arg.after?.intended).toEqual(['rick@svdp.us']);
  });
});

// ── The size refusal has to survive the chokepoint ─────────────────────────
//
// notifyStaff is the ONLY sanctioned route to staff mail, so if it flattens the
// transport's too-large outcome into "delivered: 0", every feature above it loses
// the ability to say why nothing arrived. These pin that it does not.

describe('notifyStaff — oversized attachments', () => {
  it('surfaces the transport size refusal instead of flattening it into a failure', async () => {
    surfaceFindUnique.mockResolvedValue({ rollout_state: 'live' });
    sendSystemEmail.mockResolvedValue({
      delivered: false,
      disabled: false,
      messageId: 'm-1',
      retries: 0,
      lastStatus: undefined,
      oversize: {
        // ADR-0114 — a refusal now means the MAILBOX limit was exceeded, not the
        // Graph inline-request limit (which the draft path carries past).
        ceiling: 'exchange-message',
        limitBytes: 36700160,
        encodedAttachmentBytes: 40000000,
        rawAttachmentBytes: 30000000,
        overheadBytes: 65536,
        filenames: ['receipt.pdf'],
      },
      transport: 'inline',
    });

    const res = await notifyStaff({
      surfaceCode: 'alert_digest',
      site: { id: 'site-w', code: 'woodland' },
      recipients: ['mary.scott@svdp.us'],
      subject: 'Approved reimbursement',
      htmlBody: '<!DOCTYPE html><html><body>hi</body></html>',
      attachments: [{ filename: 'receipt.pdf', buffer: Buffer.alloc(4) }],
    });

    expect(res.delivered).toBe(0);
    // Not a config problem — M365 is configured, the payload is the problem.
    expect(res.disabled).toBe(false);
    expect(res.oversize).not.toBeNull();
    expect(res.oversize?.filenames).toEqual(['receipt.pdf']);

    // The audit row records it, so "was this ever sent?" is answerable from the
    // trail alone rather than by correlating application logs.
    const audited = callArg<{ after: Record<string, unknown> }>(writeAudit, 0, 0);
    expect(audited.after['oversize_refused']).toBe(true);
    expect(audited.after['oversize_filenames']).toEqual(['receipt.pdf']);
  });

  it('reports null on an ordinary send, so the field means what it says', async () => {
    surfaceFindUnique.mockResolvedValue({ rollout_state: 'live' });
    const res = await notifyStaff({
      surfaceCode: 'alert_digest',
      site: { id: 'site-w', code: 'woodland' },
      recipients: ['mary.scott@svdp.us'],
      subject: 'Approved reimbursement',
      htmlBody: '<!DOCTYPE html><html><body>hi</body></html>',
    });
    expect(res.oversize).toBeNull();
    const audited = callArg<{ after: Record<string, unknown> }>(writeAudit, 0, 0);
    expect(audited.after['oversize_refused']).toBe(false);
  });
});

// ── ADR-0126 D8 — the CC set is audit evidence ──────────────────────────────
//
// During the 2026-08 unmailed-decision review the question "was accounting
// actually copied?" was NOT answerable from data. The AP decision mail puts the
// original forwarder in TO and Mary's `ap_decision_recipients` roster in CC, so
// the audit trail recorded the one address nobody was asking about and omitted
// the one everybody was.

describe('notifyStaff — CC is recorded on the audit row (ADR-0126 D8)', () => {
  it('audits the CC addresses so "was accounting copied?" is answerable from data', async () => {
    surfaceFindUnique.mockResolvedValue({ rollout_state: 'live' });
    await notifyStaff({
      surfaceCode: 'alert_digest',
      site: { id: 'site-w', code: 'woodland' },
      recipients: ['forwarder@svdp.us'],
      cc: ['mary.scott@svdp.us', 'ap@svdp.us'],
      subject: 'DR3-Vision AP decision (rejected)',
      htmlBody: '<!DOCTYPE html><html><body>hi</body></html>',
    });

    const audited = callArg<{ after: Record<string, unknown> }>(writeAudit, 0, 0);
    expect(audited.after['cc']).toEqual(['mary.scott@svdp.us', 'ap@svdp.us']);
    expect(audited.after['cc_count']).toBe(2);
    // The TO set is still recorded — CC is additive, not a replacement.
    expect(audited.after['intended']).toEqual(['forwarder@svdp.us']);
  });

  it('records an EMPTY cc as empty rather than omitting the field', async () => {
    // "No CC" and "we did not record CC" must be distinguishable going forward.
    // Rows written before this shipped have neither key, and a reader must treat
    // that absence as UNKNOWN — which only works if a present key always means
    // what it says.
    surfaceFindUnique.mockResolvedValue({ rollout_state: 'live' });
    await notifyStaff({
      surfaceCode: 'alert_digest',
      site: { id: 'site-w', code: 'woodland' },
      recipients: ['forwarder@svdp.us'],
      subject: 'No CC on this one',
      htmlBody: '<!DOCTYPE html><html><body>hi</body></html>',
    });

    const audited = callArg<{ after: Record<string, unknown> }>(writeAudit, 0, 0);
    expect(audited.after).toHaveProperty('cc');
    expect(audited.after['cc']).toEqual([]);
    expect(audited.after['cc_count']).toBe(0);
  });
});
