// 2026-10-13 — a forwarded batch of 25 invoices mailed every approver 25 times.
// One poll now sends ONE new-request notice: the per-request email for a single
// request (unchanged), one summary email for two or more.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const notifyStaff = vi.fn<(arg: unknown) => Promise<undefined>>(async () => undefined);
vi.mock('@/lib/notify/notify-staff', () => ({ notifyStaff: (a: unknown) => notifyStaff(a) }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { notifyNewRequestBatch, type NewRequestItem } from './notify';

const item = (n: number): NewRequestItem => ({
  requestId: `req-${n}`,
  subject: `FW: Invoice ${n}`,
  senderAddress: 'carlos@svdp.us',
  receivedAt: new Date('2026-10-13T22:46:00Z'),
  attachmentCount: 1,
});
const call = (): { subject: string; htmlBody: string; recipients: string[] } =>
  notifyStaff.mock.calls[0]![0] as never;

beforeEach(() => notifyStaff.mockClear());

describe('notifyNewRequestBatch', () => {
  it('sends nothing for an empty batch', async () => {
    await notifyNewRequestBatch({ items: [], approverEmails: ['a@svdp.us'] });
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('one request → the existing per-request email with its deep link', async () => {
    await notifyNewRequestBatch({ items: [item(1)], approverEmails: ['a@svdp.us'] });
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(call().subject).toBe('DR3-Vision — new AP approval request: FW: Invoice 1');
    expect(call().htmlBody).toContain('request=req-1');
  });

  it('25 requests → ONE email to the approvers, listing them', async () => {
    await notifyNewRequestBatch({
      items: Array.from({ length: 25 }, (_, i) => item(i + 1)),
      approverEmails: ['a@svdp.us', 'b@svdp.us'],
    });
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(call().subject).toBe('DR3-Vision — 25 new AP approval requests');
    expect(call().recipients).toEqual(['a@svdp.us', 'b@svdp.us']);
    expect(call().htmlBody).toContain('FW: Invoice 25');
  });

  it('caps the listing and counts the remainder', async () => {
    await notifyNewRequestBatch({
      items: Array.from({ length: 40 }, (_, i) => item(i + 1)),
      approverEmails: ['a@svdp.us'],
    });
    expect(call().htmlBody).toContain('and 10 more');
    expect(call().htmlBody).not.toContain('FW: Invoice 31');
  });

  it('no approver addresses → nothing sent', async () => {
    await notifyNewRequestBatch({ items: [item(1), item(2)], approverEmails: [] });
    expect(notifyStaff).not.toHaveBeenCalled();
  });
});
