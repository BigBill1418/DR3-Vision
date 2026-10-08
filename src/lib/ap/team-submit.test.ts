// ADR-0141 — the team-submission channel end to end, its role/site/pilot gate,
// the accounting-staff list, the admin correction, and a regression pin that the
// mailbox intake still creates exactly the row it created before.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { mockTransport, type MailMessage } from '@/lib/msgraph-mail';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeAccountingContact,
  type FakeApRequest,
  type FakeDb,
} from './__testutils__/fake-prisma';
import {
  TeamCorrectionError,
  TeamSubmitError,
  composeTeamSubject,
  correctTeamAccountant,
  parseAmountCents,
  submitTeamInvoice,
  teamSubmitAccess,
  type TeamSubmitDeps,
  type TeamSubmitInput,
} from './team-submit';
import {
  createAccountingContact,
  listAccountingContacts,
  updateAccountingContact,
} from './accounting-contacts';
import { extractInvoiceNumber } from './duplicate-invoice';
import { ingestMessage } from './ingest';

const writeAudit = vi.fn();
const notifyStaffSpy = vi.fn();
const putApAttachment = vi.fn(
  async (a: { requestId: string; attachmentId: string; filename: string | null }) =>
    `ap/${a.requestId}/${a.attachmentId}/${a.filename}`,
);

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/r2', () => ({
  putApAttachment: (a: never) => putApAttachment(a),
  getApAttachmentBytes: vi.fn(async () => null),
  putApDecisionPdf: vi.fn(async () => 'ap/x/decision/y.pdf'),
}));
vi.mock('./stamp', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  stampApproval: vi.fn(async () => ({ pdf: Buffer.from('%PDF-stub'), sha256: 'deadbeef' })),
}));
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: string[] }) => {
    notifyStaffSpy(args);
    return { mode: 'live', disabled: false, delivered: args.recipients.length };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({
  NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify', AP_TEAM_OUTCOME: 'ap_team_outcome' },
  UI_SURFACE: { AP_TEAM_SUBMIT: 'ap_team_submit' },
  isUiSurfaceLive: vi.fn(async () => false),
}));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SEEDED: FakeAccountingContact[] = [
  {
    id: 'acct-gloria',
    display_name: 'Gloria Salpino',
    email: 'gloria.salpino@svdp.us',
    active: true,
  },
  { id: 'acct-mary', display_name: 'Mary Scott', email: 'mary.scott@svdp.us', active: true },
  {
    id: 'acct-yvonne',
    display_name: 'Yvonne Stephens',
    email: 'yvonne.stephens@svdp.us',
    active: true,
  },
  { id: 'acct-old', display_name: 'Former Person', email: 'former@svdp.us', active: false },
];

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}
function freshDb(over: Partial<FakeDb> = {}): FakeDb {
  return newFakeDb({
    accountingContacts: SEEDED.map((c) => ({ ...c })),
    decisionRecipients: [{ email: 'mary.scott@svdp.us', active: true }],
    users: [
      {
        id: 'u-gail',
        name: 'Gail',
        email: 'gail.manager@svdp.us',
        role: 'manager',
        all_sites: false,
        is_active: true,
        primary_site_id: 'site-w',
      },
      {
        id: 'u-morena',
        name: 'Morena',
        email: 'morena@svdp.us',
        role: 'manager',
        all_sites: true,
        is_active: true,
      },
    ],
    sites: [{ id: 'site-w', code: 'woodland', name: 'Woodland' }],
    ...over,
  });
}

const PDF = new TextEncoder().encode('%PDF-1.4 invoice');
function input(prisma: PrismaClient, over: Partial<TeamSubmitInput> = {}): TeamSubmitInput {
  return {
    prisma,
    submitter: { userId: 'u-gail', email: 'Gail.Manager@svdp.us' },
    siteId: 'site-w',
    accountantId: 'acct-gloria',
    vendor: 'ACME Pest',
    invoiceNumber: 'T-70514',
    amountCents: 124050,
    purpose: 'Quarterly pest control, Woodland warehouse',
    files: [{ name: 'invoice.pdf', contentType: 'application/pdf', bytes: PDF }],
    now: new Date('2026-10-08T16:00:00Z'),
    ...over,
  };
}
const notifyNew = vi.fn(async () => undefined);
const deps: TeamSubmitDeps = {
  extract: vi.fn(async () => ({ confidence: 'failed' })) as unknown as NonNullable<
    TeamSubmitDeps['extract']
  >,
  notifyNew,
  approverEmails: async () => ['morena@svdp.us', 'gail.manager@svdp.us'],
};

beforeEach(() => {
  writeAudit.mockClear();
  notifyStaffSpy.mockClear();
  putApAttachment.mockClear();
  notifyNew.mockClear();
});

describe('teamSubmitAccess — managers at their own site, admins anywhere, pilot = admins only', () => {
  const live = async () => true;
  const pilot = async () => false;
  it('admin: any site, pilot or live', async () => {
    expect(await teamSubmitAccess({ role: 'admin', primarySiteId: null }, 'site-e', pilot)).toBe(
      'ok',
    );
    expect(await teamSubmitAccess({ role: 'admin', primarySiteId: 'site-w' }, 'site-e', live)).toBe(
      'ok',
    );
  });
  it('manager at their own site: ok only once the surface is live there', async () => {
    const m = { role: 'manager' as const, primarySiteId: 'site-w' };
    expect(await teamSubmitAccess(m, 'site-w', live)).toBe('ok');
    expect(await teamSubmitAccess(m, 'site-w', pilot)).toBe('pilot');
  });
  it('manager at another site: refused even when live (an all-sites flag does not widen it)', async () => {
    expect(
      await teamSubmitAccess({ role: 'manager', primarySiteId: 'site-w' }, 'site-e', live),
    ).toBe('forbidden_site');
    expect(await teamSubmitAccess({ role: 'manager', primarySiteId: null }, 'site-e', live)).toBe(
      'forbidden_site',
    );
  });
  it('operator: refused', async () => {
    expect(
      await teamSubmitAccess({ role: 'operator', primarySiteId: 'site-w' }, 'site-w', live),
    ).toBe('forbidden_role');
  });
});

describe('submitTeamInvoice — the end-to-end team path', () => {
  it('stores the file in R2 ap/, writes a pending team_submit row, audits, and notifies approvers', async () => {
    const db = freshDb();
    const res = await submitTeamInvoice(input(fp(db)), deps);

    const row = db.requests[0]!;
    expect(row.id).toBe(res.requestId);
    expect(row.status).toBe('pending');
    expect(row.intake_channel).toBe('team_submit');
    expect(row.internet_message_id).toBe(`team-submit:${row.id}`);
    expect(row.sender_address).toBe('gail.manager@svdp.us');
    expect(row.sender_validated).toBe(true);
    expect(row.submitted_by).toBe('u-gail');
    expect(row.submitted_site_id).toBe('site-w');
    expect(row.outcome_recipient_id).toBe('acct-gloria');
    expect(row.outcome_recipient_email).toBe('gloria.salpino@svdp.us');
    expect(row.submitted_vendor).toBe('ACME Pest');
    expect(row.submitted_invoice_number).toBe('T-70514');
    expect(row.submitted_amount_cents).toBe(124050);
    expect(row.body_text).toBe('Quarterly pest control, Woodland warehouse');
    // The approver still keys the decision site; the submission does not pre-file it.
    expect(row.site_id).toBeNull();
    // ADR-0136 finds the number in the composed subject.
    expect(extractInvoiceNumber(row.subject)).toBe('T-70514');

    const files = db.attachments.filter((a) => a.request_id === row.id);
    expect(files).toHaveLength(1);
    expect(files[0]!.storage_key).toMatch(new RegExp(`^ap/${row.id}/`));
    expect(files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const audit = writeAudit.mock.calls[0]![0] as {
      actor_user_id: string;
      table_name: string;
      after: Record<string, unknown>;
    };
    expect(audit.actor_user_id).toBe('u-gail');
    expect(audit.table_name).toBe('ap_requests');
    expect(audit.after).toMatchObject({
      intake_channel: 'team_submit',
      outcome_recipient_id: 'acct-gloria',
      outcome_recipient_email: 'gloria.salpino@svdp.us',
      attachment_count: 1,
    });
    expect(audit.after).not.toHaveProperty('submitted_vendor');

    // The approvers hear about it the same way as a mailbox invoice. The submitter is
    // NOT excluded: Bill decided (2026-10-08) they may decide it like any other.
    expect(notifyNew).toHaveBeenCalledTimes(1);
    expect(notifyNew.mock.calls[0]).toMatchObject([
      { approverEmails: ['morena@svdp.us', 'gail.manager@svdp.us'], attachmentCount: 1 },
    ]);
  });

  it('the submitter is not barred from deciding their own invoice (Bill, 2026-10-08)', async () => {
    const { decideRequest } = await import('./approvals');
    const db = freshDb();
    const { requestId } = await submitTeamInvoice(input(fp(db)), deps);
    const res = await decideRequest({
      prisma: fp(db),
      requestId,
      decision: 'approved',
      actorUserId: 'u-gail',
      siteId: 'site-w',
    });
    expect(res.decision).toBe('approved');
    expect(db.requests[0]!.decided_by).toBe('u-gail');
  });

  it.each([
    [{ vendor: ' ' }, 'vendor_required'],
    [{ invoiceNumber: '' }, 'invoice_number_required'],
    [{ amountCents: 0 }, 'invalid_amount'],
    [{ purpose: '' }, 'purpose_required'],
    [{ accountantId: '' }, 'accountant_required'],
    [{ accountantId: 'acct-nope' }, 'accountant_required'],
    [{ accountantId: 'acct-old' }, 'accountant_inactive'],
    [{ files: [] }, 'file_required'],
    [
      { files: [{ name: 'x.exe', contentType: 'application/x-msdownload', bytes: PDF }] },
      'file_type',
    ],
    [
      {
        files: [
          {
            name: 'big.pdf',
            contentType: 'application/pdf',
            bytes: new Uint8Array(15 * 1024 * 1024 + 1),
          },
        ],
      },
      'file_too_large',
    ],
    [
      {
        files: Array.from({ length: 6 }, (_, i) => ({
          name: `p${i}.jpg`,
          contentType: 'image/jpeg',
          bytes: PDF,
        })),
      },
      'too_many_files',
    ],
  ] as const)('refuses %o with %s and writes nothing', async (over, code) => {
    const db = freshDb();
    await expect(
      submitTeamInvoice(input(fp(db), over as Partial<TeamSubmitInput>), deps),
    ).rejects.toMatchObject({ code });
    expect(db.requests).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('refuses with 503 and files NO row when R2 is unavailable', async () => {
    const db = freshDb();
    putApAttachment.mockResolvedValueOnce(null as unknown as string);
    const err = await submitTeamInvoice(input(fp(db)), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamSubmitError);
    expect((err as TeamSubmitError).status).toBe(503);
    expect(db.requests).toHaveLength(0);
  });

  it('accepts a phone photo (HEIC) and multiple files', async () => {
    const db = freshDb();
    await submitTeamInvoice(
      input(fp(db), {
        files: [
          { name: 'p1.heic', contentType: 'image/heic', bytes: PDF },
          { name: 'p2.jpg', contentType: 'image/jpeg', bytes: PDF },
        ],
      }),
      deps,
    );
    expect(db.attachments).toHaveLength(2);
  });
});

describe('parseAmountCents / composeTeamSubject', () => {
  it('reads common typed amounts and refuses junk', () => {
    expect(parseAmountCents('1,240.50')).toBe(124050);
    expect(parseAmountCents('$40')).toBe(4000);
    expect(parseAmountCents('0')).toBeNull();
    expect(parseAmountCents('12.345')).toBeNull();
    expect(parseAmountCents('abc')).toBeNull();
  });
  it('the subject always carries the invoice number for the duplicate guard', () => {
    expect(extractInvoiceNumber(composeTeamSubject('IM25013731', 'Hertz'))).toBe('IM25013731');
  });
});

function decidedTeamRow(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-t',
    status: 'approved',
    internet_message_id: 'team-submit:req-t',
    conversation_id: null,
    received_at: new Date(),
    sender_address: 'gail.manager@svdp.us',
    sender_validated: true,
    subject: 'Invoice #: 1001 — ACME (team submission)',
    body_html_sanitized: null,
    body_text: 'pest control',
    vendor: null,
    amount_cents: null,
    decided_by: 'u-morena',
    decided_at: new Date(),
    decision_note: null,
    decision_mail_sent_at: new Date(),
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
    intake_channel: 'team_submit',
    submitted_by: 'u-gail',
    submitted_site_id: 'site-w',
    submitted_at: new Date(),
    outcome_recipient_id: 'acct-gloria',
    outcome_recipient_email: 'gloria.salpino@svdp.us',
    ...over,
  };
}

describe('correctTeamAccountant — admin correction, audited, re-sends what is due', () => {
  it('a decided request: re-points, audits before/after, re-sends the decision To the new accountant', async () => {
    const db = freshDb({ requests: [decidedTeamRow()] });
    const res = await correctTeamAccountant({
      prisma: fp(db),
      requestId: 'req-t',
      accountantId: 'acct-yvonne',
      actorUserId: 'u-bill',
    });
    expect(res.accountantEmail).toBe('yvonne.stephens@svdp.us');
    expect(res.resent).toEqual({ kind: 'decision', mail: 'sent' });
    expect(db.requests[0]!.outcome_recipient_id).toBe('acct-yvonne');
    expect(db.requests[0]!.outcome_recipient_email).toBe('yvonne.stephens@svdp.us');

    const sent = notifyStaffSpy.mock.calls.at(-1)![0] as { recipients: string[]; cc: string[] };
    expect(sent.recipients).toEqual(['yvonne.stephens@svdp.us']);
    expect(sent.cc).toEqual(['gail.manager@svdp.us', 'mary.scott@svdp.us']);

    const correction = writeAudit.mock.calls
      .map(
        (c) => c[0] as { actor_user_id: string; before?: unknown; after: { attempted?: string } },
      )
      .find((a) => a.after.attempted === 'correct_team_accountant')!;
    expect(correction.actor_user_id).toBe('u-bill');
    expect(correction.before).toEqual({
      outcome_recipient_id: 'acct-gloria',
      outcome_recipient_email: 'gloria.salpino@svdp.us',
    });
    expect(
      writeAudit.mock.calls.some(
        (c) =>
          (c[0] as { after: { attempted?: string } }).after.attempted ===
          'resend_decision_after_correction',
      ),
    ).toBe(true);
  });

  it('a held request re-sends the hold notice; a pending one sends nothing', async () => {
    const held = freshDb({
      requests: [
        decidedTeamRow({
          status: 'pending_review',
          decided_by: null,
          decided_at: null,
          held_by: 'u-morena',
          held_at: new Date(),
          hold_note: 'Checking the PO',
        }),
      ],
    });
    const r1 = await correctTeamAccountant({
      prisma: fp(held),
      requestId: 'req-t',
      accountantId: 'acct-mary',
      actorUserId: 'u-bill',
    });
    expect(r1.resent).toEqual({ kind: 'hold', mail: 'sent' });
    const holdMail = notifyStaffSpy.mock.calls.at(-1)![0] as { recipients: string[]; cc: string[] };
    expect(holdMail.recipients).toEqual(['mary.scott@svdp.us']);
    expect(holdMail.cc).toEqual(['gail.manager@svdp.us']);

    notifyStaffSpy.mockClear();
    const pending = freshDb({
      requests: [decidedTeamRow({ status: 'pending', decided_by: null, decided_at: null })],
    });
    const r2 = await correctTeamAccountant({
      prisma: fp(pending),
      requestId: 'req-t',
      accountantId: 'acct-mary',
      actorUserId: 'u-bill',
    });
    expect(r2.resent).toBeNull();
    expect(notifyStaffSpy).not.toHaveBeenCalled();
  });

  it('refuses a mailbox row, an inactive accountant and a no-op change', async () => {
    const mailbox = freshDb({
      requests: [
        decidedTeamRow({
          intake_channel: 'mailbox',
          outcome_recipient_id: null,
          outcome_recipient_email: null,
        }),
      ],
    });
    await expect(
      correctTeamAccountant({
        prisma: fp(mailbox),
        requestId: 'req-t',
        accountantId: 'acct-mary',
        actorUserId: 'u-bill',
      }),
    ).rejects.toMatchObject({ code: 'not_team_submission', status: 409 });

    const db = freshDb({ requests: [decidedTeamRow()] });
    await expect(
      correctTeamAccountant({
        prisma: fp(db),
        requestId: 'req-t',
        accountantId: 'acct-old',
        actorUserId: 'u-bill',
      }),
    ).rejects.toBeInstanceOf(TeamCorrectionError);
    await expect(
      correctTeamAccountant({
        prisma: fp(db),
        requestId: 'req-t',
        accountantId: 'acct-gloria',
        actorUserId: 'u-bill',
      }),
    ).rejects.toMatchObject({ code: 'unchanged' });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('accounting-staff list (ADR-0141 D3)', () => {
  it('the active list is the seeded three, by name', async () => {
    const db = freshDb();
    const list = await listAccountingContacts({ activeOnly: true }, fp(db));
    expect(list.map((c) => c.email)).toEqual([
      'gloria.salpino@svdp.us',
      'mary.scott@svdp.us',
      'yvonne.stephens@svdp.us',
    ]);
  });

  it('create: @svdp.us only, lower-cased, unique, audited', async () => {
    const db = freshDb();
    const prisma = fp(db);
    expect(
      await createAccountingContact(
        { displayName: 'X', email: 'x@gmail.com', actorUserId: 'u-bill' },
        prisma,
      ),
    ).toEqual({ ok: false, reason: 'email_not_internal' });
    expect(
      await createAccountingContact(
        { displayName: 'X', email: 'x@svdp.us.evil.com', actorUserId: 'u-bill' },
        prisma,
      ),
    ).toEqual({ ok: false, reason: 'email_not_internal' });
    expect(
      await createAccountingContact(
        { displayName: ' ', email: 'x@svdp.us', actorUserId: 'u-bill' },
        prisma,
      ),
    ).toEqual({ ok: false, reason: 'name_required' });
    expect(
      await createAccountingContact(
        { displayName: 'Dup', email: 'Mary.Scott@SVDP.us', actorUserId: 'u-bill' },
        prisma,
      ),
    ).toEqual({ ok: false, reason: 'email_taken' });
    expect(writeAudit).not.toHaveBeenCalled();

    const ok = await createAccountingContact(
      { displayName: 'New Person', email: ' New.Person@svdp.us ', actorUserId: 'u-bill' },
      prisma,
    );
    expect(ok).toMatchObject({ ok: true, contact: { email: 'new.person@svdp.us', active: true } });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'u-bill',
        action: 'insert',
        table_name: 'ap_accounting_contacts',
      }),
    );
  });

  it('deactivate is an audited update with before/after', async () => {
    const db = freshDb();
    const res = await updateAccountingContact(
      { id: 'acct-yvonne', active: false, actorUserId: 'u-bill' },
      fp(db),
    );
    expect(res).toMatchObject({ ok: true, contact: { active: false } });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        row_id: 'acct-yvonne',
        before: expect.objectContaining({ active: true }),
        after: expect.objectContaining({ active: false }),
      }),
    );
  });
});

describe('REGRESSION — the mailbox intake creates exactly the row it created before ADR-0141', () => {
  it('ingestMessage writes no team columns and the row reads as a mailbox row', async () => {
    const db = newFakeDb();
    const prisma = makeFakePrisma(db);
    const create = vi.spyOn(prisma.apRequest, 'create');
    const t = mockTransport();
    const listed = (await t.listDelta('inbox', null)).messages;
    const msgs: MailMessage[] = await Promise.all(listed.map((m) => t.getMessage(m.id)));
    const msg = msgs.find((m) => m.internetMessageId === '<pdf-invoice-1@svdp.us>')!;
    const newRequest = vi.fn(async () => undefined);

    const out = await ingestMessage(
      {
        prisma: prisma as unknown as PrismaClient,
        transport: t,
        policy: { mode: 'tenant_wide', internalDomain: 'svdp.us', explicitAllow: new Set() },
        approverEmails: ['morena@svdp.us'],
        notifier: { quarantine: vi.fn(), newRequest },
      },
      msg,
    );

    expect(out.kind).toBe('created');
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(
      [
        'body_html_sanitized',
        'body_text',
        'conversation_id',
        'extraction',
        'internet_message_id',
        'received_at',
        'sender_address',
        'sender_validated',
        'status',
        'subject',
      ].sort(),
    );
    const row = db.requests[0]!;
    expect(row.intake_channel).toBeUndefined(); // DB default `mailbox`
    expect(row.outcome_recipient_email).toBeUndefined();
    expect(newRequest).toHaveBeenCalledTimes(1);
  }, 30_000);
});
