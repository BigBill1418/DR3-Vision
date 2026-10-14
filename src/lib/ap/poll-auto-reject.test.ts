// ADR-0136 Amendment 2 — the 2026-10-13 batch end to end: 25 re-forwards of invoices
// already approved in September go through the REAL poll → ingest → duplicate guard →
// decideRequest chain. None may reach the approvers as a new-request notice; each gets
// the ordinary rejection decision mail instead.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeApRequest } from './__testutils__/fake-prisma';
import { mockTransport, type MockMessageSpec } from '@/lib/msgraph-mail';
import { runApPoll } from './poll';

const notifyStaffSpy = vi.fn();
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/r2', () => ({
  putApAttachment: vi.fn(async () => null),
  getApAttachmentBytes: vi.fn(async () => null),
  putApDecisionPdf: vi.fn(async () => 'ap/x/decision/y.pdf'),
}));
vi.mock('./stamp', () => ({
  stampApproval: vi.fn(async () => ({ pdf: Buffer.from('%PDF-stub'), sha256: 'deadbeef' })),
  stampOntoOriginalPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-o'), sha256: 'o' })),
  stampImage: vi.fn(async () => ({ pdf: Buffer.from('%PDF-i'), sha256: 'i' })),
}));
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { subject: string; recipients: ReadonlyArray<unknown> }) => {
    notifyStaffSpy(args);
    return {
      mode: 'live' as const,
      disabled: false,
      delivered: args.recipients.length,
      actualRecipients: args.recipients,
      intendedRecipients: args.recipients,
      sends: args.recipients.map(() => ({ delivered: true, disabled: false })),
      surfaceCode: 'ap_notify',
      siteId: null,
    };
  },
}));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const subjectFor = (n: number): string =>
  `FW: Invoice: ${6652 + n} | Service Order: ${7400 + n} | United Fleet Maintenance`;

function approved(n: number): FakeApRequest {
  return {
    id: `sept-${n}`,
    status: 'approved',
    internet_message_id: `<sept-${n}@svdp.us>`,
    conversation_id: null,
    received_at: new Date('2026-09-08T20:00:00Z'),
    sender_address: 'carlos@svdp.us',
    sender_validated: true,
    subject: subjectFor(n),
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: 'u-morena',
    decided_at: new Date('2026-09-09T17:05:00Z'),
    decision_note: null,
    decision_mail_sent_at: null,
    decision_mail_filed_out_of_band_at: null,
    quarantine_reason: null,
    site_id: 'site-w',
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
  };
}

function reforward(id: string, subject: string): MockMessageSpec {
  return {
    id,
    internetMessageId: `<${id}@svdp.us>`,
    conversationId: null,
    receivedDateTime: '2026-10-13T22:30:00Z',
    from: 'carlos@svdp.us',
    fromName: 'Carlos',
    subject,
    bodyHtml: '<p>see attached</p>',
    bodyText: 'see attached',
    hasAttachments: false,
    folder: 'inbox',
    attachments: [],
  };
}

function seed(): ReturnType<typeof newFakeDb> {
  return newFakeDb({
    requests: Array.from({ length: 25 }, (_, i) => approved(i)),
    users: [
      {
        id: 'u-morena',
        name: 'Morena',
        email: 'morena@svdp.us',
        role: 'manager',
        all_sites: true,
        is_active: true,
      },
    ],
    approvers: [{ id: 'ap-m', user_id: 'u-morena', active_until: null, created_by: null }],
    decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
  });
}
const fp = (db: ReturnType<typeof newFakeDb>): PrismaClient =>
  makeFakePrisma(db) as unknown as PrismaClient;
const newRequestNotices = (): string[] =>
  notifyStaffSpy.mock.calls
    .map((c) => (c[0] as { subject: string }).subject)
    .filter((s) => /new AP approval request/.test(s));

beforeEach(() => {
  notifyStaffSpy.mockClear();
  delete process.env['AP_AUTO_REJECT_DUPLICATES'];
});

describe('runApPoll — a batch of already-approved re-forwards', () => {
  it('25 duplicates → 25 auto-rejected, ZERO new-request notices', async () => {
    const db = seed();
    const transport = mockTransport({
      messages: Array.from({ length: 25 }, (_, i) => reforward(`dup-${i}`, subjectFor(i))),
    });
    const res = await runApPoll({ prisma: fp(db), transport });
    expect(res.status).toBe('ok');
    expect(res.requestsCreated).toBe(25);
    expect(res.autoRejected).toBe(25);
    const fresh = db.requests.filter((r) => r.id.startsWith('sept-') === false);
    expect(fresh).toHaveLength(25);
    expect(fresh.every((r) => r.status === 'rejected')).toBe(true);
    expect(newRequestNotices()).toEqual([]);
  });

  it('a genuinely new invoice in the same batch is still announced (alone)', async () => {
    const db = seed();
    const transport = mockTransport({
      messages: [
        ...Array.from({ length: 3 }, (_, i) => reforward(`dup-${i}`, subjectFor(i))),
        reforward('new-1', 'FW: Invoice: 9001 | Service Order: 9100 | United Fleet Maintenance'),
      ],
    });
    const res = await runApPoll({ prisma: fp(db), transport });
    expect(res.autoRejected).toBe(3);
    expect(newRequestNotices()).toEqual([
      'DR3-Vision — new AP approval request: FW: Invoice: 9001 | Service Order: 9100 | United Fleet Maintenance',
    ]);
  });

  it('kill switch off → the batch is announced as pending work, as before', async () => {
    process.env['AP_AUTO_REJECT_DUPLICATES'] = 'false';
    const db = seed();
    const transport = mockTransport({
      messages: Array.from({ length: 25 }, (_, i) => reforward(`dup-${i}`, subjectFor(i))),
    });
    const res = await runApPoll({ prisma: fp(db), transport });
    expect(res.autoRejected).toBe(0);
    expect(newRequestNotices()).toEqual(['DR3-Vision — 25 new AP approval requests']);
  });
});
