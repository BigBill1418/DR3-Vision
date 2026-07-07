// ADR-0047 acceptance (c)/(d)/D1 — notifyStaff() gate behaviour:
//   - live  ⇒ sends to the real intended recipients;
//   - pilot ⇒ reroutes to active admins with a [PILOT — would have sent to: …]
//             subject + body banner; the intended STAFF receive nothing;
//   - org-wide (site=null) ⇒ pilot unless every site row is live;
//   - an unregistered surface throws UnregisteredSurfaceError (never a silent send).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendSystemEmail = vi.fn(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'm-1',
  retries: 0,
  lastStatus: 202 as number | undefined,
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
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: (...a: unknown[]) => sendSystemEmail(...(a as [])) }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { notifyStaff } from '../notify-staff';
import { UnregisteredSurfaceError } from '../errors';

const ADMINS = [{ email: 'bill@svdp.us', name: 'Bill' }];

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockResolvedValue(ADMINS);
  sendSystemEmail.mockResolvedValue({ delivered: true, disabled: false, messageId: 'm-1', retries: 0, lastStatus: 202 });
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
