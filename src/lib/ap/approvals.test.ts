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
  ApLocationConflictError,
  ApNoteRequiredError,
  ApNotActionableError,
  ApSiteRequiredError,
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
// ADR-0126 — args are PASSED THROUGH (they used to be dropped), so the ADR-0037
// grading of a page (topic, priority, fingerprint, cooldown) is assertable rather
// than just its call count.
const publishNtfy = vi.fn(async (args: unknown) => {
  void args; // captured by vi.fn for assertions; not read by the stub itself
  return { ok: true, outcome: 'sent' as const };
});
const notifyStaffSpy = vi.fn();

// §1.6e / Amendment 4 — stamp module mocked so no real Chromium/pdf-lib runs;
// each renderer returns a fixed PDF + sha256 so decision_pdf_sha256 persistence,
// the pdf-vs-image branch, and multi-attachment passthrough can all be asserted.
const stamp = vi.hoisted(() => ({
  stampApproval: vi.fn(async () => ({
    pdf: Buffer.from('%PDF-stub'),
    sha256: 'deadbeef',
  })),
  stampOntoOriginalPdf: vi.fn(async () => ({
    pdf: Buffer.from('%PDF-overlay'),
    sha256: 'pdfsha',
  })),
  stampImage: vi.fn(async () => ({
    pdf: Buffer.from('%PDF-image'),
    sha256: 'imgsha',
  })),
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
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (a: unknown) => publishNtfy(a) }));
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
    decision_mail_filed_out_of_band_at: null,
    quarantine_reason: null,
    site_id: null,
    filed_not_dr3: false,
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
      siteId: 'site-w',
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

  it('M2 — the winning flip + its audit run in ONE transaction (audit enlisted via {tx}, no unaudited window)', async () => {
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
      siteId: 'site-w',
    });
    // The winning audit is written with a transaction client as its 2nd arg — proof
    // it commits with the flip (a crash between flip and audit can't strand a live,
    // unaudited decision).
    const wonCall = writeAudit.mock.calls.find(
      (c) => (c[0] as { after?: { outcome?: string } })?.after?.outcome === 'won',
    );
    expect(wonCall).toBeTruthy();
    expect(wonCall![1]).toMatchObject({ tx: expect.anything() });
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
      siteId: 'site-w',
    });
    writeAudit.mockClear();
    await expect(
      decideRequest({
        prisma,
        requestId: 'req-1',
        decision: 'rejected',
        actorUserId: 'u-janette',
        siteId: 'site-w',
      }),
    ).rejects.toBeInstanceOf(ApAlreadyDecidedError);
    // the losing attempt is audited (outcome=lost)
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const arg = writeAudit.mock.calls[0]![0] as unknown as { after?: { outcome?: string } };
    expect(arg.after?.outcome).toBe('lost');
    // state unchanged from the winner
    expect(db.requests[0]!.status).toBe('approved');
  });

  it('write-stops the deprecated vendor/amount_cents on a non-structured decide, keeping only the note (hard rule #1)', async () => {
    // Hard rule #1 (ADR-0046 Amendment 5) — the deprecated vendor / amount_cents
    // columns are WRITE-STOPPED at decide on EVERY path (kept for historical data, no
    // longer written). Even when a legacy client still supplies `vendor`/`amountCents`
    // they are NOT persisted; the single `note` (decision_note) is the only field a
    // non-structured decision carries.
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
      siteId: 'site-w',
      vendor: 'Acme',
      amountCents: 44100,
      note: 'ok to pay',
    });
    expect(db.requests[0]!.vendor).toBeNull();
    expect(db.requests[0]!.amount_cents).toBeNull();
    expect(db.requests[0]!.decision_note).toBe('ok to pay');
  });

  it('sets ap_requests.site_id from the supplied (resolved) siteId', async () => {
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
  });

  it('2026-07-15 directive — REFUSES a decision without a site tag: no state change, no email, no audit', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    for (const bad of [undefined, '', '   '] as const) {
      await expect(
        decideRequest({
          prisma: fp(db),
          requestId: 'req-1',
          decision: 'approved',
          actorUserId: 'u-morena',
          ...(bad !== undefined ? { siteId: bad } : {}),
        }),
      ).rejects.toBeInstanceOf(ApSiteRequiredError);
    }
    expect(db.requests[0]!.status).toBe('pending');
    expect(db.requests[0]!.site_id).toBeNull();
    expect(notifyStaffSpy).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

// ADR-0046 amendment (2026-07-20) — third location disposition "NOT DR3 — See
// Reason". A decision is EITHER a real DR3 site OR filed_not_dr3=true (site_id
// NULL, reason required) — never both, never neither.
describe('decideRequest — NOT DR3 disposition', () => {
  const recips = [{ email: 'mary@svdp.us', active: true }];

  it('persists filed_not_dr3=true + site_id NULL, requires the reason, records no site', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      decisionRecipients: recips,
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      note: 'mis-addressed — this is a parent-org bill, not a DR3 location',
      filedNotDr3: true,
    });
    expect(res.decision).toBe('approved');
    const row = db.requests[0]!;
    expect(row.status).toBe('approved');
    expect(row.filed_not_dr3).toBe(true);
    expect(row.site_id).toBeNull(); // never filed against a real site
    expect(row.decision_note).toContain('parent-org bill');
    // The winning audit records the disposition.
    const won = writeAudit.mock.calls
      .map(
        (c) =>
          c[0] as { after?: { outcome?: string; filed_not_dr3?: boolean; has_site?: boolean } },
      )
      .find((a) => a.after?.outcome === 'won');
    expect(won?.after?.filed_not_dr3).toBe(true);
    expect(won?.after?.has_site).toBe(false);
  });

  it('REFUSES a NOT DR3 decision with no / blank reason — no state change (approve AND reject)', async () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: recips });
      for (const bad of [undefined, '', '   '] as const) {
        await expect(
          decideRequest({
            prisma: fp(db),
            requestId: 'req-1',
            decision,
            actorUserId: 'u-morena',
            filedNotDr3: true,
            ...(bad !== undefined ? { note: bad } : {}),
          }),
        ).rejects.toBeInstanceOf(ApNoteRequiredError);
      }
      expect(db.requests[0]!.status).toBe('pending'); // untouched
      expect(db.requests[0]!.filed_not_dr3).toBe(false);
      expect(notifyStaffSpy).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
      writeAudit.mockClear();
      notifyStaffSpy.mockClear();
    }
  });

  it('REFUSES when BOTH a site AND NOT DR3 are supplied (mutual exclusion) — no state change', async () => {
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: recips });
    await expect(
      decideRequest({
        prisma: fp(db),
        requestId: 'req-1',
        decision: 'approved',
        actorUserId: 'u-morena',
        note: 'reason',
        siteId: 'site-w',
        filedNotDr3: true,
      }),
    ).rejects.toBeInstanceOf(ApLocationConflictError);
    expect(db.requests[0]!.status).toBe('pending');
    expect(db.requests[0]!.filed_not_dr3).toBe(false);
    expect(db.requests[0]!.site_id).toBeNull();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('a NOT DR3 REJECTION is filed the same way (marker set, site NULL)', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      decisionRecipients: recips,
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actorUserId: 'u-morena',
      note: 'wrong entity — bill belongs to another company',
      filedNotDr3: true,
    });
    expect(res.decision).toBe('rejected');
    expect(db.requests[0]!.status).toBe('rejected');
    expect(db.requests[0]!.filed_not_dr3).toBe(true);
    expect(db.requests[0]!.site_id).toBeNull();
  });

  it('the decision mail renders "NOT DR3 — see reason: <reason>" (body + subject) instead of a site', async () => {
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      // A real site row exists, but NOT DR3 must never resolve/show it.
      sites: [{ id: 'site-w', code: 'woodland', name: 'Woodland' }],
      decisionRecipients: recips,
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      note: 'mis-addressed to DR3 — actually a parent-org bill',
      filedNotDr3: true,
    });
    expect(res.mail).toBe('sent');
    const args = notifyStaffSpy.mock.calls[0]![0] as { subject: string; htmlBody: string };
    // Unmissable in the subject and leading the body facts, in the site slot.
    expect(args.subject).toContain('NOT DR3');
    expect(args.subject).not.toContain('Woodland');
    expect(args.htmlBody).toContain('NOT DR3 — see reason:');
    expect(args.htmlBody).toContain('mis-addressed to DR3 — actually a parent-org bill');
    expect(args.htmlBody).not.toContain('Site: <b>');
    // The stamp/PDF path is told it is NOT DR3 (body-only invoice ⇒ stampApproval).
    const stampArg = (stamp.stampApproval.mock.calls[0]! as unknown[])[0] as { notDr3?: boolean };
    expect(stampArg.notDr3).toBe(true);
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
      siteId: 'site-w',
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
      siteId: 'site-w',
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
      siteId: 'site-w',
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
      siteId: 'site-w',
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
      siteId: 'site-w',
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
      siteId: 'site-w',
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
          // A scanned invoice is a real document (>50 KB) — kept on merit, not via the
          // inline-image fallback (a logo/signature would be filtered out; see below).
          byte_size: 250_000,
          storage_key: 'ap/req-1/att-img/scan.png',
        }),
      ],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
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
      siteId: 'site-w',
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
      siteId: 'site-w',
    });
    expect(res.mail).toBe('sent'); // fail-soft: mail is never blocked
    expect(stamp.stampOntoOriginalPdf).not.toHaveBeenCalled(); // no bytes → no overlay
    expect(stamp.stampApproval).toHaveBeenCalled(); // cover page produced instead
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: unknown[] };
    expect(args.attachments).toHaveLength(1);
    expect(db.requests[0]!.decision_pdf_sha256).toBe('deadbeef'); // cover sha
    expect(db.requests[0]!.decision_pdf_r2_key).toBeNull(); // nothing archived
  });

  // Attachment-first precedence (2026-07-15). The live defect (c38909b2): a forwarded
  // invoice ALWAYS carries a body, so body-first returned the body render and the
  // pdf-lib overlay never ran — accounting got a body render, not the Hertz invoice,
  // and original_attachment_sha256 stayed NULL. Attachments must WIN over the body.
  it('body + PDF coexist: the FILE original wins (overlay + dual-sha), the body render is NOT attached', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const db = newFakeDb({
      requests: [
        pendingReq({
          id: 'req-1',
          // A real forward: a body AND a PDF attachment coexist.
          body_html_sanitized: '<p>Please see attached Hertz invoice.</p>',
          body_text: 'Please see attached Hertz invoice.',
        }),
      ],
      users,
      decisionRecipients: recips,
      attachments: [fileAtt({ id: 'att-a', filename: 'Hertz Invoice 599597504.PDF' })],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
    });
    expect(res.mail).toBe('sent');
    // The PDF original is overlaid — the body render is never produced.
    expect(stamp.stampOntoOriginalPdf).toHaveBeenCalledTimes(1);
    expect(stamp.stampApproval).not.toHaveBeenCalled();
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: { filename: string }[] };
    expect(args.attachments).toHaveLength(1);
    // The stamped ORIGINAL rides (approved-<name>.pdf), NOT the body render (ap-decision-<id>.pdf).
    expect(args.attachments![0]!.filename).toBe('approved-Hertz_Invoice_599597504.pdf');
    expect(args.attachments!.some((a) => a.filename === 'ap-decision-req-1.pdf')).toBe(false);
    // The original bytes' sha is now recorded — the whole point of the fix.
    expect(db.requests[0]!.original_attachment_sha256).not.toBeNull();
    expect(db.requests[0]!.decision_pdf_sha256).toBe('pdfsha');
  });

  it('inline-image filter: a tiny logo image is excluded; the real PDF is kept', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(new Uint8Array([4, 5, 6]));
    const db = newFakeDb({
      requests: [pendingReq({ id: 'req-1' })],
      users,
      decisionRecipients: recips,
      attachments: [
        fileAtt({
          id: 'att-pdf',
          filename: 'invoice.pdf',
          content_type: 'application/pdf',
          byte_size: 120_000,
        }),
        // A forwarded signature/logo image, a few KB — noise, not a document.
        fileAtt({
          id: 'att-logo',
          filename: 'logo.png',
          content_type: 'image/png',
          byte_size: 8_000,
          storage_key: 'ap/req-1/att-logo/logo.png',
        }),
      ],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
    });
    expect(res.mail).toBe('sent');
    // Only the PDF is stamped; the tiny image is filtered out (never image-stamped).
    expect(stamp.stampOntoOriginalPdf).toHaveBeenCalledTimes(1);
    expect(stamp.stampImage).not.toHaveBeenCalled();
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: unknown[] };
    expect(args.attachments).toHaveLength(1);
  });

  it('inline-image filter never empties the mail: an all-tiny-image request keeps its image', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(new Uint8Array([7, 7]));
    const db = newFakeDb({
      requests: [pendingReq({ id: 'req-1' })],
      users,
      decisionRecipients: recips,
      attachments: [
        // The ONLY attachment is a small image — filter would drop it, guard keeps it.
        fileAtt({
          id: 'att-img',
          filename: 'photo.png',
          content_type: 'image/png',
          byte_size: 9_000,
          storage_key: 'ap/req-1/att-img/photo.png',
        }),
      ],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
    });
    expect(res.mail).toBe('sent');
    expect(stamp.stampImage).toHaveBeenCalledTimes(1); // kept via the all-dropped guard
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: unknown[] };
    expect(args.attachments).toHaveLength(1);
  });

  it('duplicate filenames are de-duped so neither MIME part clobbers the other', async () => {
    r2.getApAttachmentBytes.mockResolvedValue(new Uint8Array([1]));
    const db = newFakeDb({
      requests: [pendingReq({ id: 'req-1' })],
      users,
      decisionRecipients: recips,
      attachments: [
        fileAtt({
          id: 'att-a',
          filename: 'invoice.pdf',
          storage_key: 'ap/req-1/att-a/invoice.pdf',
        }),
        fileAtt({
          id: 'att-b',
          filename: 'invoice.pdf',
          storage_key: 'ap/req-1/att-b/invoice.pdf',
        }),
      ],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
    });
    expect(res.mail).toBe('sent');
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: { filename: string }[] };
    const names = args.attachments!.map((a) => a.filename);
    expect(names).toEqual(['approved-invoice.pdf', 'approved-invoice-2.pdf']);
    expect(new Set(names).size).toBe(2); // distinct → no clobber
  });

  it('body-only invoice (no file attachments) still renders the stamped body', async () => {
    const db = newFakeDb({
      requests: [
        pendingReq({
          id: 'req-1',
          body_html_sanitized: '<p>Invoice details inline.</p>',
          body_text: 'Invoice details inline.',
        }),
      ],
      users,
      decisionRecipients: recips,
      // No attachments at all — the body render is the correct fallback.
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
    });
    expect(res.mail).toBe('sent');
    expect(stamp.stampApproval).toHaveBeenCalledTimes(1); // body render
    expect(stamp.stampOntoOriginalPdf).not.toHaveBeenCalled();
    const args = notifyStaffSpy.mock.calls[0]![0] as { attachments?: { filename: string }[] };
    expect(args.attachments).toHaveLength(1);
    expect(args.attachments![0]!.filename).toBe('ap-decision-req-1.pdf'); // body artifact
    expect(db.requests[0]!.original_attachment_sha256).toBeNull(); // no original bytes
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

// ADR-0046 Amendment 3 (reject) + 2026-07-21 amendment (approve) — EVERY decision
// must carry a note. Same minimum for both (non-empty after trim); an approval
// records what the transaction was for + context, a rejection says why.
describe('assertDecisionNote — every decision must carry a note', () => {
  it('throws ApNoteRequiredError for a rejection with no / blank note', () => {
    expect(() => assertDecisionNote('rejected', undefined)).toThrow(ApNoteRequiredError);
    expect(() => assertDecisionNote('rejected', '   ')).toThrow(ApNoteRequiredError);
  });
  it('throws ApNoteRequiredError for an APPROVAL with no / blank note (2026-07-21)', () => {
    expect(() => assertDecisionNote('approved', undefined)).toThrow(ApNoteRequiredError);
    expect(() => assertDecisionNote('approved', '')).toThrow(ApNoteRequiredError);
    expect(() => assertDecisionNote('approved', '   ')).toThrow(ApNoteRequiredError);
  });
  it('the approval message names the transaction-purpose + context requirement', () => {
    expect(() => assertDecisionNote('approved', undefined)).toThrow(
      /what this transaction was for/i,
    );
  });
  it('allows either decision WITH a non-empty note (same trimmed minimum)', () => {
    expect(() => assertDecisionNote('rejected', 'duplicate of #4471')).not.toThrow();
    expect(() =>
      assertDecisionNote('approved', 'fuel for the Woodland box truck, June'),
    ).not.toThrow();
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
      siteId: 'site-w',
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
      siteId: 'site-w',
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

// ADR-0046 Amendment 5 (D-M5-1/4/6) — the STRUCTURED Approve write: structured
// columns persisted, deprecated vendor/amount_cents NOT written, equipment linked
// atomically, variance state stamped.
describe('decideRequest — structured Approve (Amendment 5)', () => {
  it('persists vendor_freeform / explanation / confirmed_amount_cents and does NOT write the deprecated columns', async () => {
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
      siteId: 'site-w',
      vendorFreeform: 'Sunbelt Rentals',
      explanation: 'mower rental for the Woodland yard',
      confirmedAmountCents: 12500,
      equipmentLinks: { equipmentIds: [], notEquipmentRelated: true },
      varianceFlagState: 'not_applicable',
    });
    const row = db.requests[0]!;
    expect(row.status).toBe('approved');
    expect(row.vendor_freeform).toBe('Sunbelt Rentals');
    expect(row.explanation).toBe('mower rental for the Woodland yard');
    expect(row.confirmed_amount_cents).toBe(12500);
    // Deprecated columns are LEFT UNWRITTEN (hard rule #1).
    expect(row.vendor).toBeNull();
    expect(row.amount_cents).toBeNull();
    expect(row.decision_note).toBeNull();
  });

  it('feeds a vision_approval baseline-history row on a terminal (sub-$1K) Approve (D-M5-4)', async () => {
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
      siteId: 'site-w',
      vendorFreeform: 'Clark Pest Control',
      explanation: 'monthly service',
      confirmedAmountCents: 12500,
      equipmentLinks: { equipmentIds: [], notEquipmentRelated: true },
    });
    expect(db.baselineHistory).toHaveLength(1);
    expect(db.baselineHistory[0]!.source).toBe('vision_approval');
    expect(db.baselineHistory[0]!.vendor_name_normalized).toBe('clark pest control');
    expect(db.baselineHistory[0]!.invoice_amount_cents).toBe(12500);
  });

  it('does NOT feed the baseline when a >= $1K Approve routes to second approval', async () => {
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
      siteId: 'site-w',
      vendorFreeform: 'Big Vendor',
      explanation: 'large repair',
      confirmedAmountCents: 250000, // >= $1,000 → pending_second_approval (not terminal)
      equipmentLinks: { equipmentIds: [], notEquipmentRelated: true },
    });
    expect(db.requests[0]!.status).toBe('pending_second_approval');
    expect(db.baselineHistory).toHaveLength(0);
  });

  it('writes a single is_not_equipment_related link for the explicit-none case', async () => {
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
      siteId: 'site-w',
      vendorFreeform: 'Office Depot',
      explanation: 'printer paper',
      confirmedAmountCents: 4200,
      equipmentLinks: { equipmentIds: [], notEquipmentRelated: true },
    });
    expect(db.equipmentLinks).toHaveLength(1);
    expect(db.equipmentLinks[0]!.is_not_equipment_related).toBe(true);
    expect(db.equipmentLinks[0]!.equipment_id).toBeNull();
    expect(db.equipmentLinks[0]!.request_id).toBe('req-1');
  });

  it('writes one link row per selected equipment id', async () => {
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
      siteId: 'site-w',
      vendorFreeform: 'Fleet Fuel',
      explanation: 'diesel',
      confirmedAmountCents: 30000,
      equipmentLinks: { equipmentIds: ['eq-1', 'eq-2'], notEquipmentRelated: false },
    });
    expect(db.equipmentLinks.map((l) => l.equipment_id).sort()).toEqual(['eq-1', 'eq-2']);
    expect(db.equipmentLinks.every((l) => !l.is_not_equipment_related)).toBe(true);
  });

  // ── ADR-0046 Amendment 9 (§2.2/§2.3/§2.4) — the equipment ESCAPE HATCH ──────
  //
  // The hatch's whole value depends on the request row and the link being written
  // by the SAME transaction as the decision. If they can drift, the two failure
  // modes are both silent: an approval with no equipment record at all, or a
  // request nobody filed an invoice for.

  it('escape hatch: writes the request + a link pointing at it, in the decision transaction', async () => {
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      sites: [{ id: 'site-w', code: 'woodland', name: 'DR3 Woodland' }],
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
      vendorFreeform: 'Acme Rentals',
      explanation: 'forklift repair',
      confirmedAmountCents: 45000,
      equipmentLinks: {
        equipmentIds: [],
        notEquipmentRelated: false,
        equipmentRequestDescription: 'Yellow Hyster forklift, unit 7, Woodland',
      },
    });

    expect(db.equipmentRequests).toHaveLength(1);
    expect(db.equipmentRequests[0]).toMatchObject({
      ap_request_id: 'req-1',
      site_id: 'site-w',
      status: 'open',
      requested_by: 'u-morena',
      description: 'Yellow Hyster forklift, unit 7, Woodland',
    });

    // EXACTLY ONE disposition on the link — the other two must stay empty, which
    // is what the DB CHECK enforces in production.
    expect(db.equipmentLinks).toHaveLength(1);
    expect(db.equipmentLinks[0]).toMatchObject({
      request_id: 'req-1',
      equipment_id: null,
      is_not_equipment_related: false,
      equipment_request_id: db.equipmentRequests[0]!.id,
    });

    // The decision still landed. The hatch unblocks the approval; it does not
    // defer or weaken it.
    expect(db.requests[0]!.status).toBe('approved');
  });

  it('escape hatch: audits the disposition as `equipment_request`, never as 0 equipment', async () => {
    // `equipment: 0` would be indistinguishable from a bug that dropped the
    // linkage — the audit has to say which of the three choices was made.
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      sites: [{ id: 'site-w', code: 'woodland', name: 'DR3 Woodland' }],
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
      vendorFreeform: 'Acme Rentals',
      explanation: 'forklift repair',
      confirmedAmountCents: 45000,
      equipmentLinks: {
        equipmentIds: [],
        notEquipmentRelated: false,
        equipmentRequestDescription: 'Yellow Hyster forklift, unit 7',
      },
    });
    // `writeAudit` is spied (see the module mock at the top of this file), so the
    // rows are read off the spy rather than out of the fake db.
    const auditArgs = writeAudit.mock.calls.map(
      (c) => c[0] as { table_name: string; action: string; after?: Record<string, unknown> },
    );
    const decisionAudit = auditArgs.find(
      (a) => a.table_name === 'ap_requests' && a.after?.['outcome'] === 'won',
    );
    expect(decisionAudit?.after?.['equipment']).toBe('equipment_request');

    // And the request row gets its own provenance audit entry.
    expect(
      auditArgs.some((a) => a.table_name === 'ap_equipment_requests' && a.action === 'insert'),
    ).toBe(true);
  });

  it('escape hatch: fires on the >= $1,000 second-approval hop too, not only terminal approvals', async () => {
    // The registry gap is real whether or not a second signature is pending;
    // waiting for it would just delay the fix by a day.
    const db = newFakeDb({
      requests: [pendingReq()],
      users,
      sites: [{ id: 'site-w', code: 'woodland', name: 'DR3 Woodland' }],
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
      vendorFreeform: 'Acme Rentals',
      explanation: 'engine rebuild',
      confirmedAmountCents: 250_000,
      equipmentLinks: {
        equipmentIds: [],
        notEquipmentRelated: false,
        equipmentRequestDescription: 'Kenworth tractor, the blue one',
      },
    });
    expect(res.secondApprovalPending).toBe(true);
    expect(db.requests[0]!.status).toBe('pending_second_approval');
    expect(db.equipmentRequests).toHaveLength(1);
    expect(db.equipmentLinks[0]!.equipment_request_id).toBe(db.equipmentRequests[0]!.id);
  });

  it('stamps variance acknowledgment columns when state=acknowledged', async () => {
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
      siteId: 'site-w',
      vendorFreeform: 'Clark Pest',
      explanation: 'extra treatment',
      confirmedAmountCents: 40000,
      equipmentLinks: { equipmentIds: [], notEquipmentRelated: true },
      varianceFlagState: 'acknowledged',
      varianceAcknowledgedBy: 'u-morena',
      varianceAcknowledgmentNote: 'confirmed with Morena',
    });
    const row = db.requests[0]!;
    expect(row.variance_flag_state).toBe('acknowledged');
    expect(row.variance_acknowledged_by).toBe('u-morena');
    expect(row.variance_acknowledged_at).not.toBeNull();
    expect(row.variance_acknowledgment_note).toBe('confirmed with Morena');
  });

  it('does NOT create equipment links for the loser of a race', async () => {
    const db = newFakeDb({
      requests: [
        pendingReq({ status: 'approved', decided_by: 'u-janette', decided_at: new Date() }),
      ],
      users,
      decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
    });
    await expect(
      decideRequest({
        prisma: fp(db),
        requestId: 'req-1',
        decision: 'approved',
        actorUserId: 'u-morena',
        siteId: 'site-w',
        vendorFreeform: 'Sunbelt Rentals',
        explanation: 'mower rental',
        confirmedAmountCents: 12500,
        equipmentLinks: { equipmentIds: ['eq-1'], notEquipmentRelated: false },
      }),
    ).rejects.toBeInstanceOf(ApAlreadyDecidedError);
    expect(db.equipmentLinks).toHaveLength(0);
  });
});

// ── ADR-0126 — the silent paths stop being silent ──────────────────────────
//
// Two rejections were decided, refused by the transport, never stamped and never
// re-sent; accounting was told about neither for weeks. The `'disabled'` path was
// the worst of the family — it returned without a stamp, without an error log and
// without a page, so a credential outage taking out EVERY decision mail looked
// exactly like a quiet afternoon.

describe('ADR-0126 — decision mail cannot fail silently', () => {
  const recips = [{ email: 'mary@svdp.us', active: true }];

  it('D7: pages + error-logs when M365 is disabled, and does NOT stamp the row', async () => {
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: recips });
    sendSystemEmail.mockResolvedValueOnce({
      delivered: false,
      disabled: true,
      messageId: '',
      retries: 0,
      lastStatus: 0,
    });

    const res = await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actorUserId: 'u-morena',
      note: 'duplicate invoice',
      siteId: 'site-w',
    });

    expect(res.mail).toBe('disabled');
    // The decision STANDS — fail-open on the transport is correct and unchanged.
    expect(db.requests[0]!.status).toBe('rejected');
    // But the mail stamp must NOT be set: it is the sweep's only signal, and a
    // stamp here would make the row indistinguishable from a delivered one.
    expect(db.requests[0]!.decision_mail_sent_at).toBeFalsy();
    expect(publishNtfy).toHaveBeenCalledTimes(1);
  });

  it('D7: the page is keyed on the OUTAGE, not the request that hit it', async () => {
    // A credential expiry stops every decision mail at once. A per-request
    // fingerprint would page once per decision for the whole outage.
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: recips });
    sendSystemEmail.mockResolvedValueOnce({
      delivered: false,
      disabled: true,
      messageId: '',
      retries: 0,
      lastStatus: 0,
    });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'approved',
      actorUserId: 'u-morena',
      siteId: 'site-w',
    });

    const page = publishNtfy.mock.calls[0]?.[0] as unknown as {
      topic: string;
      priority: string;
      fingerprint: string;
      cooldownMs: number;
    };
    expect(page.topic).toBe('dr3-vision-system'); // an EXISTING topic
    expect(page.priority).toBe('high');
    expect(page.fingerprint).toBe('ap-decision-mail-disabled');
    expect(page.fingerprint).not.toContain('req-1');
    expect(page.cooldownMs).toBeGreaterThan(60 * 60 * 1000);
  });

  it('D9: a NOT-DR3 rejection states its reason ONCE, in the location slot', async () => {
    const reason = 'mis-addressed — this is a parent-org bill, not a DR3 location';
    const db = newFakeDb({
      requests: [pendingReq({ sender_address: 'accounting@svdp.us' })],
      users,
      decisionRecipients: recips,
    });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actorUserId: 'u-morena',
      note: reason,
      filedNotDr3: true,
    });

    const arg = notifyStaffSpy.mock.calls[0]?.[0] as { htmlBody: string };
    // Present, and present exactly once — it used to render again as "Note: …",
    // which reads as two facts and invites a hunt for a difference that is not there.
    expect(arg.htmlBody).toContain('NOT DR3 — see reason:');
    expect(arg.htmlBody).toContain(reason);
    expect(arg.htmlBody.split(reason).length - 1).toBe(1);
    expect(arg.htmlBody).not.toContain(`<li>Note: ${reason}</li>`);
  });

  it('D9: a NORMAL (site-filed) rejection still renders its note — dedupe is scoped', async () => {
    // The guard must not swallow the note on every other decision.
    const db = newFakeDb({ requests: [pendingReq()], users, decisionRecipients: recips });
    await decideRequest({
      prisma: fp(db),
      requestId: 'req-1',
      decision: 'rejected',
      actorUserId: 'u-morena',
      note: 'duplicate of invoice 4470',
      siteId: 'site-w',
    });

    const arg = notifyStaffSpy.mock.calls[0]?.[0] as { htmlBody: string };
    expect(arg.htmlBody).toContain('<li>Note: duplicate of invoice 4470</li>');
  });
});
