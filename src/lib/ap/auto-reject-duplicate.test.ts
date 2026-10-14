// ADR-0136 Amendment 2 — an already-approved invoice is rejected at intake.
// 2026-10-13: ~28 re-forwarded United Fleet Maintenance invoices, all approved in
// September, became pending requests that approvers rejected one by one. These run
// the REAL match (findApprovedDuplicates) and the REAL decision path (decideRequest)
// against the fake Prisma, with mail/stamp/R2 mocked as in approvals.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApAttachment,
  type FakeApRequest,
  type FakeDb,
  type FakeUser,
} from './__testutils__/fake-prisma';
import {
  autoRejectEnabled,
  autoRejectIfDuplicate,
  hasCorrectionLanguage,
} from './auto-reject-duplicate';
import { decideRequest } from './approvals';
import { AP_DUPLICATE_GUARD_ACTOR } from './duplicate-invoice';

const writeAudit = vi.fn();
const sendSystemEmail = vi.fn(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'm',
  retries: 0,
  lastStatus: 202,
}));
const notifyStaffSpy = vi.fn();
const mailFault = { throwOnce: false };
const stamp = vi.hoisted(() => ({
  stampApproval: vi.fn(async () => ({ pdf: Buffer.from('%PDF-stub'), sha256: 'deadbeef' })),
  stampOntoOriginalPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-o'), sha256: 'pdfsha' })),
  stampImage: vi.fn(async () => ({ pdf: Buffer.from('%PDF-i'), sha256: 'imgsha' })),
}));
const r2 = vi.hoisted(() => ({
  getApAttachmentBytes: vi.fn(async (): Promise<Uint8Array | null> => null),
  putApDecisionPdf: vi.fn(async (): Promise<string | null> => 'ap/x/decision/y.pdf'),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: () => sendSystemEmail() }));
vi.mock('./stamp', () => stamp);
vi.mock('@/lib/r2', () => r2);
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: ReadonlyArray<string | { address: string }> }) => {
    notifyStaffSpy(args);
    if (mailFault.throwOnce) {
      mailFault.throwOnce = false;
      throw new Error('graph 503 after commit');
    }
    const recips = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
    for (let i = 0; i < recips.length; i++) await sendSystemEmail();
    return {
      mode: 'live' as const,
      disabled: false,
      delivered: recips.length,
      actualRecipients: recips,
      intendedRecipients: recips,
      sends: recips.map(() => ({ delivered: true, disabled: false })),
      surfaceCode: 'ap_notify',
      siteId: null,
    };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({ NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify' } }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUBJECT = 'FW: Invoice: 6652 | Service Order: 7480 | Unit #161053 | United Fleet Maintenance';
const PDF = 'a'.repeat(64);

function req(over: Partial<FakeApRequest>): FakeApRequest {
  return {
    id: 'r',
    status: 'pending',
    internet_message_id: `<${over.id ?? 'r'}@svdp.us>`,
    conversation_id: null,
    received_at: new Date('2026-10-13T22:30:00Z'),
    sender_address: 'carlos@svdp.us',
    sender_validated: true,
    subject: null,
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
const approvedOriginal = (over: Partial<FakeApRequest> = {}): FakeApRequest =>
  req({
    id: 'sept',
    status: 'approved',
    subject: `${SUBJECT} Woodland, CA`,
    vendor_freeform: 'United Fleet Maintenance',
    decided_by: 'u-morena',
    decided_at: new Date('2026-09-09T17:05:00Z'),
    site_id: 'site-w',
    ...over,
  } as Partial<FakeApRequest>);
const users: FakeUser[] = [
  {
    id: 'u-morena',
    name: 'Morena',
    email: 'morena@svdp.us',
    role: 'manager',
    all_sites: true,
    is_active: true,
  },
];
function att(over: Partial<FakeApAttachment>): FakeApAttachment {
  return {
    id: 'a',
    request_id: 'r',
    kind: 'file',
    filename: 'Invoice.pdf',
    content_type: 'application/pdf',
    byte_size: 1000,
    storage_key: `ap/${over.request_id ?? 'r'}/${over.id ?? 'a'}`,
    link_url: null,
    nested_subject: null,
    ...over,
  };
}
function setup(requests: FakeApRequest[], attachments: FakeApAttachment[] = []): FakeDb {
  return newFakeDb({
    requests,
    attachments,
    users,
    decisionRecipients: [{ email: 'mary@svdp.us', active: true }],
  });
}
const fp = (db: FakeDb): PrismaClient => makeFakePrisma(db) as unknown as PrismaClient;
const ON = { env: {} };
const audits = (): Array<Record<string, unknown>> =>
  writeAudit.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => {
  mailFault.throwOnce = false;
  writeAudit.mockClear();
  sendSystemEmail.mockClear();
  notifyStaffSpy.mockClear();
});

describe('autoRejectIfDuplicate', () => {
  it('rejects a re-forward whose invoice number + vendor match an approved request', async () => {
    const db = setup([approvedOriginal(), req({ id: 'new', subject: SUBJECT })]);
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject: SUBJECT, bodyText: 'see attached', vendors: ['United'] },
      ON,
    );
    expect(v).toEqual({ rejected: true, matchedRequestIds: ['sept'], mail: 'sent' });
    const row = db.requests.find((r) => r.id === 'new')!;
    expect(row.status).toBe('rejected');
    expect(row.decided_by).toBe(AP_DUPLICATE_GUARD_ACTOR);
    expect(row.site_id).toBe('site-w');
    expect(row.decision_note).toBe(
      'Auto-rejected: duplicate of already-approved request sept (invoice 6652, approved Sep 9, 2026, 10:05 AM PT by Morena).',
    );
    // The system actor rides actor_label (audit_log.actor_user_id is a users FK).
    const won = audits().find(
      (a) => (a['after'] as Record<string, unknown>)?.['outcome'] === 'won',
    );
    expect(won).toMatchObject({ actor_label: AP_DUPLICATE_GUARD_ACTOR });
    expect(won).not.toHaveProperty('actor_user_id');
    expect(audits()).toContainEqual(
      expect.objectContaining({
        actor_label: AP_DUPLICATE_GUARD_ACTOR,
        row_id: 'new',
        after: expect.objectContaining({
          outcome: 'auto_rejected_duplicate',
          invoice_number: '6652',
          matched_request_ids: ['sept'],
        }),
      }),
    );
    // The ordinary decision mail: To the forwarder, CC the accounting roster,
    // naming the automatic check (not "another approver") as the decider.
    const mail = notifyStaffSpy.mock.calls[0]![0] as {
      recipients: string[];
      cc?: string[];
      htmlBody: string;
    };
    expect(mail.recipients).toEqual(['carlos@svdp.us']);
    expect(mail.htmlBody).toContain('Decision: <b>REJECTED</b>');
    expect(mail.htmlBody).toContain('DR3-Vision duplicate check (automatic)');
    expect(mail.htmlBody).toContain('Auto-rejected: duplicate of already-approved request sept');
  });

  // One PDF can legitimately be two approvals (a statement covering several
  // invoices — ADR-0136 addendum), so the file key alone never rejects at intake.
  it('a same-FILE match with no number stays pending (file_only_match)', async () => {
    const subject = 'FW: Invoice(s) Posted';
    const db = setup(
      [approvedOriginal({ subject: 'FW: Invoice(s) Posted-Ramos' }), req({ id: 'new', subject })],
      [
        att({ id: 'f-old', request_id: 'sept', sha256: PDF }),
        att({ id: 'f-new', request_id: 'new', sha256: PDF }),
      ],
    );
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject, bodyText: null, vendors: ['United'] },
      ON,
    );
    expect(v).toEqual({ rejected: false, skip: 'file_only_match' });
    expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('same file, DIFFERENT invoice number → stays pending (statement case)', async () => {
    const subject = 'FW: Invoice: 7001 | United Fleet Maintenance';
    const db = setup(
      [approvedOriginal(), req({ id: 'new', subject })],
      [
        att({ id: 'f-old', request_id: 'sept', sha256: PDF }),
        att({ id: 'f-new', request_id: 'new', sha256: PDF }),
      ],
    );
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject, bodyText: null, vendors: ['United'] },
      ON,
    );
    expect(v).toEqual({ rejected: false, skip: 'file_only_match' });
    expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('same file AND same invoice number rejects even with a blank intake vendor', async () => {
    const db = setup(
      [approvedOriginal(), req({ id: 'new', subject: SUBJECT })],
      [
        att({ id: 'f-old', request_id: 'sept', sha256: PDF }),
        att({ id: 'f-new', request_id: 'new', sha256: PDF }),
      ],
    );
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: [] },
      ON,
    );
    expect(v.rejected).toBe(true);
    expect(db.requests.find((r) => r.id === 'new')!.decision_note).toContain('(invoice 6652,');
  });

  it('number match with a BLANK intake vendor and no file → stays pending', async () => {
    const db = setup([approvedOriginal(), req({ id: 'new', subject: SUBJECT })]);
    for (const vendors of [[], [null], ['  ']]) {
      const v = await autoRejectIfDuplicate(
        fp(db),
        { requestId: 'new', subject: SUBJECT, bodyText: null, vendors },
        ON,
      );
      expect(v).toEqual({ rejected: false, skip: 'vendor_unconfirmed' });
    }
    expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('number match where the ORIGINAL has no vendor on record → stays pending', async () => {
    const db = setup([
      approvedOriginal({ vendor_freeform: null } as Partial<FakeApRequest>),
      req({ id: 'new', subject: SUBJECT }),
    ]);
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: ['United'] },
      ON,
    );
    expect(v).toEqual({ rejected: false, skip: 'vendor_unconfirmed' });
  });

  it('number match with a DIFFERENT vendor → no match at all', async () => {
    const db = setup([approvedOriginal(), req({ id: 'new', subject: SUBJECT })]);
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: ['Kelliher Propane'] },
      ON,
    );
    expect(v).toEqual({ rejected: false, skip: 'no_match' });
  });

  it('rejects Vision’s own approval mail forwarded back (no vendor needed)', async () => {
    const subject = `FW: DR3-Vision AP decision (approved — Woodland) — ${SUBJECT} Woodland, CA`;
    const db = setup([approvedOriginal(), req({ id: 'new', subject })]);
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject, bodyText: null, vendors: [] },
      ON,
    );
    expect(v.rejected).toBe(true);
    expect(audits()).toContainEqual(
      expect.objectContaining({
        after: expect.objectContaining({
          outcome: 'auto_rejected_duplicate',
          rejected_on: 'forwarded_approval',
        }),
      }),
    );
  });

  it('a throw AFTER the rejection committed is still reported as rejected', async () => {
    mailFault.throwOnce = true;
    const db = setup([approvedOriginal(), req({ id: 'new', subject: SUBJECT })]);
    const logs: string[] = [];
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: ['United'] },
      { env: {}, log: (_l, m) => logs.push(m) },
    );
    // The exception really escaped decideRequest (post-commit) and was caught here.
    expect(logs.some((m) => m.includes('threw') && m.includes('graph 503 after commit'))).toBe(
      true,
    );
    const row = db.requests.find((r) => r.id === 'new')!;
    expect(row.status).toBe('rejected');
    expect(v).toEqual({ rejected: true, matchedRequestIds: ['sept'], mail: 'failed' });
    expect(row.decision_mail_sent_at).toBeNull();
    expect(audits()).toContainEqual(
      expect.objectContaining({
        after: expect.objectContaining({ outcome: 'auto_rejected_duplicate', mail: 'failed' }),
      }),
    );
  });

  it('a throw BEFORE anything committed stays decide_failed (pending)', async () => {
    const db = setup([approvedOriginal(), req({ id: 'new', subject: SUBJECT })]);
    const prisma = fp(db);
    const realUpdate = prisma.apRequest.updateMany.bind(prisma.apRequest);
    (prisma.apRequest as { updateMany: unknown }).updateMany = async () => {
      throw new Error('db down');
    };
    const logs: string[] = [];
    const v = await autoRejectIfDuplicate(
      prisma,
      { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: ['United'] },
      { env: {}, log: (_l, m) => logs.push(m) },
    );
    void realUpdate;
    expect(logs.some((m) => m.includes('db down'))).toBe(true);
    expect(v).toEqual({ rejected: false, skip: 'decide_failed' });
    expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
  });

  it.each([
    ['subject', `${SUBJECT} -Note Correction`, null],
    ['body', SUBJECT, 'Please re-submit, the amount was revised.'],
    ['body', SUBJECT, 'Attached is the updated invoice.'],
    ['subject', `${SUBJECT} AMENDED`, null],
    ['body', SUBJECT, 'Credit memo attached against this one.'],
    ['subject', `${SUBJECT} - Reissued`, null],
    ['body', SUBJECT, 'This is a replacement for the earlier copy.'],
  ])(
    'leaves correction/resubmission wording (%s) pending for a person',
    async (_w, subject, body) => {
      const db = setup([approvedOriginal(), req({ id: 'new', subject })]);
      const v = await autoRejectIfDuplicate(
        fp(db),
        { requestId: 'new', subject, bodyText: body, vendors: [] },
        ON,
      );
      expect(v).toEqual({ rejected: false, skip: 'correction_language' });
      expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
      expect(sendSystemEmail).not.toHaveBeenCalled();
    },
  );

  it('kill switch off → stays pending', async () => {
    for (const value of ['false', '0', ' FALSE ']) {
      const db = setup([approvedOriginal(), req({ id: 'new', subject: SUBJECT })]);
      const v = await autoRejectIfDuplicate(
        fp(db),
        { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: [] },
        { env: { AP_AUTO_REJECT_DUPLICATES: value } },
      );
      expect(v).toEqual({ rejected: false, skip: 'disabled' });
      expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
    }
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('no match (different invoice, or no key at all) → unchanged', async () => {
    const db = setup([approvedOriginal(), req({ id: 'new', subject: 'FW: Invoice 7001' })]);
    expect(
      await autoRejectIfDuplicate(
        fp(db),
        { requestId: 'new', subject: 'FW: Invoice 7001', bodyText: null, vendors: [] },
        ON,
      ),
    ).toEqual({ rejected: false, skip: 'no_match' });
    expect(
      await autoRejectIfDuplicate(
        fp(db),
        { requestId: 'new', subject: 'FW: hello', bodyText: null, vendors: [] },
        ON,
      ),
    ).toEqual({ rejected: false, skip: 'no_key' });
    expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['rejected', 'no_match'],
    ['pending', 'no_match'],
    ['pending_second_approval', 'original_not_terminal'],
  ] as const)('a %s original never triggers a rejection', async (status, skip) => {
    const db = setup([approvedOriginal({ status }), req({ id: 'new', subject: SUBJECT })]);
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: ['United'] },
      ON,
    );
    expect(v).toEqual({ rejected: false, skip });
    expect(db.requests.find((r) => r.id === 'new')!.status).toBe('pending');
  });

  it('an original filed NOT DR3 (no site to file under) never triggers a rejection', async () => {
    const db = setup([
      approvedOriginal({ site_id: null, filed_not_dr3: true }),
      req({ id: 'new', subject: SUBJECT }),
    ]);
    const v = await autoRejectIfDuplicate(
      fp(db),
      { requestId: 'new', subject: SUBJECT, bodyText: null, vendors: ['United'] },
      ON,
    );
    expect(v).toEqual({ rejected: false, skip: 'original_not_terminal' });
  });
});

describe('decideRequest — human actors are unchanged', () => {
  it('a person’s decision still writes actor_user_id (never actor_label)', async () => {
    const db = setup([req({ id: 'new', subject: 'FW: Invoice 7001' })]);
    await decideRequest({
      prisma: fp(db),
      requestId: 'new',
      decision: 'rejected',
      actorUserId: 'u-morena',
      siteId: 'site-w',
      note: 'not ours',
    });
    const won = audits().find(
      (a) => (a['after'] as Record<string, unknown>)?.['outcome'] === 'won',
    );
    expect(won).toMatchObject({ actor_user_id: 'u-morena' });
    expect(won).not.toHaveProperty('actor_label');
    expect(db.requests.find((r) => r.id === 'new')!.decided_by).toBe('u-morena');
  });
});

describe('helpers', () => {
  it('kill switch defaults ON', () => {
    expect(autoRejectEnabled({})).toBe(true);
    expect(autoRejectEnabled({ AP_AUTO_REJECT_DUPLICATES: 'true' })).toBe(true);
    expect(autoRejectEnabled({ AP_AUTO_REJECT_DUPLICATES: '0' })).toBe(false);
  });
  it('correction wording', () => {
    expect(hasCorrectionLanguage('Corrected invoice 6646')).toBe(true);
    expect(hasCorrectionLanguage(null, 'resubmission attached')).toBe(true);
    expect(hasCorrectionLanguage('FW: Invoice: 6652 | United Fleet Maintenance')).toBe(false);
    for (const t of [
      'Amended invoice',
      'CREDIT MEMO 44',
      'creditmemo',
      'reissued',
      'Re-issue',
      'replacement copy',
    ]) {
      expect(hasCorrectionLanguage(t)).toBe(true);
    }
    // Word-bounded: these must not trip it.
    expect(hasCorrectionLanguage('Amendola Tire', 'Credit card receipt')).toBe(false);
  });
});
