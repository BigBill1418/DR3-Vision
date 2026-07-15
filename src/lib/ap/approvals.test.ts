// ADR-0046 D4 + §3 amendment — approvals: first-action-wins (both attempts
// audited), decision email routed to the ORIGINAL forwarder (roster as CC/
// fallback), refuse-when-no-valid-recipient, optional site tag, stamped PDF +
// decision_pdf_sha256, pending count, roster-based approver set.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApApprover,
  type FakeApRequest,
  type FakeDb,
  type FakeUser,
} from './__testutils__/fake-prisma';
import {
  ApAlreadyDecidedError,
  ApNoteRequiredError,
  ApNotActionableError,
  apApproverEmails,
  assertDecisionNote,
  decideRequest,
  holdRequest,
  pendingApCount,
  updateHoldNote,
} from './approvals';

const writeAudit = vi.fn();
const sendSystemEmail = vi.fn(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'm',
  retries: 0,
  lastStatus: 202,
}));
const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));
const notifyStaffSpy = vi.fn();

// §1.6e / Amendment 4 — stamp module mocked so no real Chromium/pdf-lib runs;
// each renderer returns a fixed PDF + sha256 so decision_pdf_sha256 persistence,
// the pdf-vs-image branch, and multi-attachment passthrough can all be asserted.
const stamp = vi.hoisted(() => ({
  stampApproval: vi.fn(async () => ({ pdf: Buffer.from('%PDF-stub'), sha256: 'deadbeef' })),
  stampOntoOriginalPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-overlay'), sha256: 'pdfsha' })),
  stampImage: vi.fn(async () => ({ pdf: Buffer.from('%PDF-image'), sha256: 'imgsha' })),
}));
// Amendment 4 — R2 originals download + decision-PDF archive. Default: no bytes
// (R2 unconfigured) so the no-attachment tests never touch it; per-test overrides
// feed bytes to exercise the overlay + archive paths.
const r2 = vi.hoisted(() => ({
  getApAttachmentBytes: vi.fn(async (): Promise<Uint8Array | null> => null),
  putApDecisionPdf: vi.fn(async (): Promise<string | null> => 'ap/x/decision/y.pdf'),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: () => sendSystemEmail() }));
vi.mock('./stamp', () => stamp);
vi.mock('@/lib/r2', () => r2);
// ADR-0047 — the decision email routes through notifyStaff(); mock it as a
// live-mode pass-through to the transport (one send per recipient), capturing
// args so recipient/cc/attachment routing can be asserted.
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: ReadonlyArray<string | { address: string }> }) => {
    notifyStaffSpy(args);
    const recips = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
    const sends: Array<{ delivered: boolean; disabled: boolean }> = [];
    for (let i = 0; i < recips.length; i++) {
      sends.push((await sendSystemEmail()) as { delivered: boolean; disabled: boolean });
    }
    const disabled = sends.length > 0 && sends.every((s) => s.disabled);
    const delivered = sends.filter((s) => s.delivered).length;
    return {
      mode: 'live' as const,
      disabled,
      delivered,
      actualRecipients: recips,
      intendedRecipients: recips,
      sends,
      surfaceCode: 'ap_notify',
      siteId: null,
    };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({ NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify' } }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: () => publishNtfy() }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function pendingReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending',
    internet_message_id: '<x@svdp.us>',
    conversation_id: null,
    received_at: new Date(),
    sender_address: 'morena@svdp.us',
    sender_validated: true,
    subject: 'Invoice #4471',
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    quarantine_reason: null,
    site_id: null,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    ...over,
  };
}
const users: FakeUser[] = [
  {
    id: 'u-morena',
    name: 'Morena',
    email: 'morena@svdp.us',
    role: 'manager',
    all_sites: true,
    is_active: true,
  },
  {
    id: 'u-janette',
    name: 'Janette',
    email: 'janette@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
  },
  { id: 'u-op', name: 'Op', email: null, role: 'operator', all_sites: false, is_active: true },
];
const approvers: FakeApApprover[] = [
  { id: 'ap-morena', user_id: 'u-morena', active_until: null, created_by: null },
  { id: 'ap-janette', user_id: 'u-janette', active_until: null, created_by: null },
];

beforeEach(() => {
  writeAudit.mockClear();
  sendSystemEmail.mockClear();
  publishNtfy.mockClear();
  notifyStaffSpy.mockClear();
  stamp.stampApproval.mockClear();
  stamp.stampOntoOriginalPdf.mockClear();
  stamp.stampImage.mockClear();
  // Reset R2 mocks to their defaults (mockReset wipes once-values from prior tests).
  r2.getApAttachmentBytes.mockReset();
  r2.getApAttachmentBytes.mockResolvedValue(null);
  r2.putApDecisionPdf.mockReset();
  r2.putApDecisionPdf.mockResolvedValue('ap/x/decision/y.pdf');
});

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

describe('decideRequest — first action wins + both attempts audited', () => {
  it('approves a pending request, emails the forwarder, stamps decision_mail_sent_at + decision_pdf_sha256', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.decision).toBe('approved');
    expect(res.mail).toBe('sent');
    expect(db.requests[0]!.status).toBe('approved');
    expect(db.requests[0]!.decided_by).toBe('u-morena');
    expect(db.requests[0]!.decision_mail_sent_at).not.toBeNull();
    expect(db.requests[0]!.decision_pdf_sha256).toBe('deadbeef');
    expect(sendSystemEmail).toHaveBeenCalledTimes(1); // one recipient (the forwarder)
    expect(writeAudit).toHaveBeenCalled();
  });

  it('the loser of a race gets ApAlreadyDecidedError; BOTH attempts are audited', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      approvers,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const prisma = fp(db);
    await decideRequest({
      prisma,
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    writeAudit.mockClear();
    await expect(
      decideRequest({ prisma, requestId: 'req-1', decision: 'rejected', actorUserId: 'u-janette' }),
    ).rejects.toBeInstanceOf(ApAlreadyDecidedError);
    // the losing attempt is audited (outcome=lost)
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const arg = writeAudit.mock.calls[0]![0] as unknown as { after?: { outcome?: string } };
    expect(arg.after?.outcome).toBe('lost');
    // state unchanged from the winner
    expect(db.requests[0]!.status).toBe('approved');
  });

  it('carries the vendor/amount/note when supplied at decision (C9-D5 optional fields)', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      vendor: 'Acme',
      amountCents: 44100,
      note: 'ok to pay',
    });
    expect(db.requests[0]!.vendor).toBe('Acme');
    expect(db.requests[0]!.amount_cents).toBe(44100);
    expect(db.requests[0]!.decision_note).toBe('ok to pay');
  });

  it('sets ap_requests.site_id when a resolved siteId is supplied; leaves it null otherwise', async () => {
    const db1 = newFakeDb({
      requests: [pendingReq()],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    await decideRequest({
      prisma: fp(db1),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-eug',
    });
    expect(db1.requests[0]!.site_id).toBe('site-eug');

    const db2 = newFakeDb({
      requests: [pendingReq()],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    await decideRequest({
      prisma: fp(db2),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(db2.requests[0]!.site_id).toBeNull();
  });
});

describe('decision email — forwarder routing (§3 amendment)', () => {
  it('routes the decision to the ORIGINAL forwarder (sender_address), roster as CC', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.mail).toBe('sent');
    const args = notifyStaffSpy.mock.calls[0]![0] as {
      recipients: string[];
      cc?: string[];
      attachments?: unknown[];
      htmlBody: string;
    };
    expect(args.recipients).toEqual(['accounting@svdp.us']);
    expect(args.cc).toEqual(['mary@svdp.us']);
    // the stamped decision PDF rides along
    expect(args.attachments).toHaveLength(1);
    // Defect fix — "Decided at" renders in Pacific wall-clock (+ ' PT'), NEVER raw
    // UTC ISO (hard rule: never show Bill an unlabeled UTC timestamp).
    expect(args.htmlBody).toMatch(/Decided at:[^<]*\bPT\b/);
    expect(args.htmlBody).not.toMatch(/Decided at:[^<]*\d{4}-\d\d-\d\dT[\d:.]+Z/);
  });

  it('2026-07-15 directive — the site tag rides the subject, body, and stamp', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      sites: [{ id: 'site-w', code: 'woodland', name: 'Woodland' }],
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
    });
    expect(res.mail).toBe('sent');
    const args = notifyStaffSpy.mock.calls[0]![0] as { subject: string; htmlBody: string };
    // Unmissable in the subject (visible before the mail is opened)…
    expect(args.subject).toContain('Woodland');
    // …and leading the decision facts in the body.
    expect(args.htmlBody).toContain('Site: <b>Woodland</b>');
  });

  it('ADR-0046 Amendment 4 — GP keys (subject + request id) are STRIPPED from the body but ride the SUBJECT line', async () => {
    const db = newFakeDb({
      requests: [
        pendingReq({ id: 'req-1', subject: 'Invoice #4471', sender_address: 'accounting@svdp.us' }),
      ],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    const args = notifyStaffSpy.mock.calls[0]![0] as { subject: string; htmlBody: string };
    // Body no longer repeats the matching keys.
    expect(args.htmlBody).not.toContain('Original subject:');
    expect(args.htmlBody).not.toContain('Request id:');
    expect(args.htmlBody).not.toContain('Great Plains matching keys');
    // Both keys still survive: the subject line carries the original subject…
    expect(args.subject).toContain('Invoice #4471');
    // …and the human-facing decision facts remain in the body.
    expect(args.htmlBody).toContain('Decision:');
    expect(args.htmlBody).toContain('Approver:');
  });

  it('uses the forwarder even when the roster is EMPTY (no refuse)', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      decisionRecipients: [],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.mail).toBe('sent');
    const args = notifyStaffSpy.mock.calls[0]![0] as { recipients: string[]; cc?: string[] };
    expect(args.recipients).toEqual(['accounting@svdp.us']);
    expect(args.cc ?? []).toEqual([]);
  });

  it('falls back to the roster when the forwarder is non-internal/empty', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: '' })],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.mail).toBe('sent');
    const args = notifyStaffSpy.mock.calls[0]![0] as { recipients: string[] };
    expect(args.recipients).toEqual(['mary@svdp.us']);
  });

  it('REFUSES + pages when there is NO valid recipient (empty forwarder + empty roster)', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: '' })],
      users,
      decisionRecipients: [],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.mail).toBe('refused_no_recipients');
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(publishNtfy).toHaveBeenCalledTimes(1); // loud refusal
    expect(db.requests[0]!.status).toBe('approved'); // the decision itself stands
  });
});

// ADR-0046 Amendment 4 — stamp the ORIGINAL, attach it (both decisions), archive
// to R2, record the dual-sha tamper record. Multi-attachment loop + image path +
// R2-unconfigured fail-soft.
describe('stamped decision artifacts (Amendment 4)', () => {
  const recips = [{ email: 'mary@svdp.us', active: true }];
  function fileAtt(over: Partial<import('./__testutils__/fake-prisma').FakeApAttachment> = {}) {
    return {
      id: 'att-a',
      request_id: 'req-1',
      kind: 'file' as const,
      filename: 'invoice.pdf',
      content_type: 'application/pdf',
      byte_size: 100,
      storage_key: 'ap/req-1/att-a/invoice.pdf',
      link_url: null,
      nested_subject: null,
      ...over,
    };
  }

  it('overlays + attaches EACH file original, archives to R2, records the dual-sha', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    r2.putApDecisionPdf
      .mockResolvedValueOnce('ap/req-1/decision/ap-decision-att-a.pdf')
      .mockResolvedValueOnce('ap/req-1/decision/ap-decision-att-b.pdf');
    const db = newFakeDb({
      requests: [pendingReq({ id: 'req-1', body_html_sanitized: null, body_text: null })],
      users,
      decisionRecipients: recips,
      attachments: [
        fileAtt({ id: 'att-a', filename: 'inv1.pdf', storage_key: 'ap/req-1/att-a/inv1.pdf' }),
        fileAtt({ id: 'att-b', filename: 'inv2.pdf', storage_key: 'ap/req-1/att-b/inv2.pdf' }),
      ],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.mail).toBe('sent');
    expect(stamp.stampOntoOriginalPdf).toHaveBeenCalledTimes(2); // one overlay per file
    expect(r2.putApDecisionPdf).toHaveBeenCalledTimes(2); // each stamped PDF archived
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: unknown[] };
    expect(args.attachments).toHaveLength(2); // both stamped originals ride the mail
    const row = db.requests[0]!;
    expect(row.decision_pdf_sha256).toBe('pdfsha'); // primary stamped-PDF sha
    expect(row.original_attachment_sha256).not.toBeNull(); // original bytes sha
    expect(row.decision_pdf_r2_key).toBe('ap/req-1/decision/ap-decision-att-a.pdf');
  });

  it('an IMAGE original stamps via the image path, not the PDF overlay', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(new Uint8Array([9, 9, 9]));
    const db = newFakeDb({
      requests: [pendingReq({ id: 'req-1' })],
      users,
      decisionRecipients: recips,
      attachments: [
        fileAtt({
          id: 'att-img',
          filename: 'scan.png',
          content_type: 'image/png',
          storage_key: 'ap/req-1/att-img/scan.png',
        }),
      ],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.mail).toBe('sent');
    expect(stamp.stampImage).toHaveBeenCalledTimes(1);
    expect(stamp.stampOntoOriginalPdf).not.toHaveBeenCalled();
    expect(db.requests[0]!.decision_pdf_sha256).toBe('imgsha');
  });

  it('a REJECTION also stamps + attaches the original', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(new Uint8Array([7]));
    const db = newFakeDb({
      requests: [pendingReq({ id: 'req-1' })],
      users,
      decisionRecipients: recips,
      attachments: [fileAtt()],
    });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actorUserId: 'u-morena',
      note: 'duplicate of #4471',
    });
    expect(stamp.stampOntoOriginalPdf).toHaveBeenCalledTimes(1);
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: unknown[] };
    expect(args.attachments).toHaveLength(1);
    expect(db.requests[0]!.status).toBe('rejected');
  });

  it('R2 unavailable for the original: degrades to a stamped cover; the mail STILL sends', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(null); // R2 unconfigured / placeholder key
    const db = newFakeDb({
      requests: [pendingReq({ id: 'req-1' })],
      users,
      decisionRecipients: recips,
      attachments: [fileAtt()],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
    });
    expect(res.mail).toBe('sent'); // fail-soft: mail is never blocked
    expect(stamp.stampOntoOriginalPdf).not.toHaveBeenCalled(); // no bytes → no overlay
    expect(stamp.stampApproval).toHaveBeenCalled(); // cover page produced instead
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: unknown[] };
    expect(args.attachments).toHaveLength(1);
    expect(db.requests[0]!.decision_pdf_sha256).toBe('deadbeef'); // cover sha
    expect(db.requests[0]!.decision_pdf_r2_key).toBeNull(); // nothing archived
  });
});

describe('approver set + pending count (roster data)', () => {
  it('apApproverEmails = active roster users with an email (single-site Janette included)', async () => {
    const db = newFakeDb({ users, approvers });
    expect((await apApproverEmails(fp(db))).sort()).toEqual(['janette@svdp.us', 'morena@svdp.us']);
  });
  it('apApproverEmails EXCLUDES an approver past active_until (deliverable 1 — all ACTIVE approvers)', async () => {
    const withExpired: FakeApApprover[] = [
      ...approvers,
      {
        id: 'ap-kelsey',
        user_id: 'u-kelsey',
        active_until: new Date('2020-01-01T00:00:00Z'),
        created_by: null,
      },
    ];
    const usersPlusKelsey: FakeUser[] = [
      ...users,
      {
        id: 'u-kelsey',
        name: 'Kelsey',
        email: 'kelsey@svdp.us',
        role: 'manager',
        all_sites: false,
        is_active: true,
      },
    ];
    const db = newFakeDb({ users: usersPlusKelsey, approvers: withExpired });
    const emails = await apApproverEmails(fp(db));
    expect(emails).not.toContain('kelsey@svdp.us'); // expired → excluded
    expect(emails.sort()).toEqual(['janette@svdp.us', 'morena@svdp.us']);
  });
  it('pendingApCount counts only pending', async () => {
    const db = newFakeDb({
      requests: [
        pendingReq({ id: 'a' }),
        pendingReq({ id: 'b', internet_message_id: '<b>', status: 'approved' }),
      ],
    });
    expect(await pendingApCount(fp(db))).toBe(1);
  });
});

// ADR-0046 Amendment 3 — reject-requires-note (deliverable 2).
describe('assertDecisionNote — a rejection must say why', () => {
  it('throws ApNoteRequiredError for a rejection with no / blank note', () => {
    expect(() => assertDecisionNote('rejected', undefined)).toThrow(ApNoteRequiredError);
    expect(() => assertDecisionNote('rejected', '   ')).toThrow(ApNoteRequiredError);
  });
  it('allows a rejection WITH a note, and an approval with or without a note', () => {
    expect(() => assertDecisionNote('rejected', 'duplicate of #4471')).not.toThrow();
    expect(() => assertDecisionNote('approved', undefined)).not.toThrow();
    expect(() => assertDecisionNote('approved', 'ok')).not.toThrow();
  });
});

// ADR-0046 Amendment 3 — hold / "pending review" lifecycle (deliverable 3).
describe('holdRequest — place hold (pending → pending_review)', () => {
  const recips = [{ email: 'mary@svdp.us', active: true }];

  it('holds a pending request, sets the hold record, notifies the forwarder, audits', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'morena@svdp.us' })],
      users,
      approvers,
      decisionRecipients: recips,
    });
    const res = await holdRequest({
      prisma: fp(db),
      requestId: 'req-1',
      actorUserId: 'u-morena',
      note: 'waiting on PO match',
    });
    expect(res.status).toBe('pending_review');
    expect(res.mail).toBe('sent');
    const row = db.requests[0]!;
    expect(row.status).toBe('pending_review');
    expect(row.held_by).toBe('u-morena');
    expect(row.held_at).not.toBeNull();
    expect(row.hold_note).toBe('waiting on PO match');
    // winning transition audited
    expect(writeAudit).toHaveBeenCalled();
    const auditArgs = writeAudit.mock.calls.map(
      (c) => c[0] as { after?: { attempted?: string; outcome?: string } },
    );
    expect(auditArgs.some((a) => a.after?.attempted === 'hold' && a.after?.outcome === 'won')).toBe(
      true,
    );
  });

  it('REQUIRES a hold note', async () => {
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: recips });
    await expect(
      holdRequest({ prisma: fp(db), requestId: 'req-1', actorUserId: 'u-morena', note: '  ' }),
    ).rejects.toBeInstanceOf(ApNoteRequiredError);
    expect(db.requests[0]!.status).toBe('pending'); // untouched
  });

  it('hold-notice content: routes to the forwarder via ap_notify, carries the note + holder', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      approvers,
      decisionRecipients: recips,
    });
    await holdRequest({
      prisma: fp(db),
      requestId: 'req-1',
      actorUserId: 'u-morena',
      note: 'need vendor W-9',
    });
    const args = notifyStaffSpy.mock.calls[0]![0] as {
      recipients: string[];
      cc?: string[];
      surfaceCode: string;
      htmlBody: string;
    };
    expect(args.surfaceCode).toBe('ap_notify'); // pilot-routing: gated surface, never raw mail
    expect(args.recipients).toEqual(['accounting@svdp.us']);
    expect(args.cc).toEqual(['mary@svdp.us']);
    expect(args.htmlBody).toContain('need vendor W-9');
    expect(args.htmlBody).toContain('Morena');
    expect(args.htmlBody).toContain('ON HOLD');
    // Amendment 4 — GP keys stripped from the hold-notice body; subject rides the
    // SUBJECT line.
    expect(args.htmlBody).not.toContain('Original subject:');
    expect(args.htmlBody).not.toContain('Request id:');
  });

  it('concurrent holds — first action wins; the second gets ApAlreadyDecidedError', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      approvers,
      decisionRecipients: recips,
    });
    const prisma = fp(db);
    await holdRequest({ prisma, requestId: 'req-1', actorUserId: 'u-morena', note: 'first' });
    await expect(
      holdRequest({ prisma, requestId: 'req-1', actorUserId: 'u-janette', note: 'second' }),
    ).rejects.toBeInstanceOf(ApAlreadyDecidedError);
    expect(db.requests[0]!.held_by).toBe('u-morena'); // holder unchanged
    expect(db.requests[0]!.hold_note).toBe('first');
  });

  it('cannot hold a quarantined request', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ status: 'quarantined' })],
      users,
      decisionRecipients: recips,
    });
    await expect(
      holdRequest({ prisma: fp(db), requestId: 'req-1', actorUserId: 'u-morena', note: 'x' }),
    ).rejects.toBeInstanceOf(ApNotActionableError);
  });
});

describe('hold → resolve + update note', () => {
  const recips = [{ email: 'mary@svdp.us', active: true }];

  it('an on-hold request can be APPROVED by any approver (pending_review → approved)', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ status: 'pending_review', held_by: 'u-morena', hold_note: 'hold' })],
      users,
      approvers,
      decisionRecipients: recips,
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-janette',
    });
    expect(res.decision).toBe('approved');
    expect(db.requests[0]!.status).toBe('approved');
    const won = writeAudit.mock.calls
      .map((c) => c[0] as { after?: { outcome?: string; from_hold?: boolean } })
      .find((a) => a.after?.outcome === 'won');
    expect(won?.after?.from_hold).toBe(true);
  });

  it('an on-hold request can be REJECTED (pending_review → rejected)', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ status: 'pending_review', held_by: 'u-morena' })],
      users,
      approvers,
      decisionRecipients: recips,
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actorUserId: 'u-morena',
      note: 'not ours',
    });
    expect(res.decision).toBe('rejected');
    expect(db.requests[0]!.status).toBe('rejected');
  });

  it('updateHoldNote refines the note on an on-hold row; keeps the holder', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ status: 'pending_review', held_by: 'u-morena', hold_note: 'old' })],
      users,
      approvers,
    });
    await updateHoldNote({
      prisma: fp(db),
      requestId: 'req-1',
      actorUserId: 'u-janette',
      note: 'new reason',
    });
    expect(db.requests[0]!.hold_note).toBe('new reason');
    expect(db.requests[0]!.held_by).toBe('u-morena'); // holder unchanged
  });

  it('updateHoldNote refuses a non-on-hold request', async () => {
    const db = newFakeDb({ requests: [pendingReq({ status: 'pending' })], users });
    await expect(
      updateHoldNote({ prisma: fp(db), requestId: 'req-1', actorUserId: 'u-morena', note: 'x' }),
    ).rejects.toBeInstanceOf(ApNotActionableError);
  });

  it('updateHoldNote requires a non-empty note', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ status: 'pending_review', held_by: 'u-morena' })],
      users,
    });
    await expect(
      updateHoldNote({ prisma: fp(db), requestId: 'req-1', actorUserId: 'u-morena', note: '' }),
    ).rejects.toBeInstanceOf(ApNoteRequiredError);
  });
});
