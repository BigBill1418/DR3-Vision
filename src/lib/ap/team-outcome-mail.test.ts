// ADR-0141 D4 — who receives each request-scoped AP email.
//
// Team submissions (Bill, 2026-10-08): To = the accountant the submitter picked,
// CC = the submitter + the ap_decision_recipients roster, de-duplicated, on the
// per-site `ap_team_outcome` surface. That holds for every mail the old
// `resolveForwarderRecipients` served: approve, reject, NOT-DR3, hold, the
// second signature (approve and override-reject) and resend.
//
// Mailbox rows: the REGRESSION half. Every one of the same mail types still goes
// To the forwarder, CC the roster, on the org-wide `ap_notify` surface — exactly
// what it did before ADR-0141.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
  type FakeSite,
  type FakeUser,
} from './__testutils__/fake-prisma';
import { decideRequest, holdRequest, sendDecisionEmail } from './approvals';
import { decideSecondApproval } from './second-approval';

const sendSystemEmail = vi.fn(async () => ({ delivered: true, disabled: false }));
const notifyStaffSpy = vi.fn();
const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn() }));
vi.mock('@/lib/m365-mail', () => ({ sendSystemEmail: () => sendSystemEmail() }));
vi.mock('./stamp', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  stampApproval: vi.fn(async () => ({ pdf: Buffer.from('%PDF-stub'), sha256: 'deadbeef' })),
}));
vi.mock('@/lib/r2', () => ({
  getApAttachmentBytes: vi.fn(async () => null),
  putApDecisionPdf: vi.fn(async () => 'ap/x/decision/y.pdf'),
}));
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: async (args: { recipients: string[] }) => {
    notifyStaffSpy(args);
    for (let i = 0; i < args.recipients.length; i++) await sendSystemEmail();
    return { mode: 'live', disabled: false, delivered: args.recipients.length };
  },
}));
vi.mock('@/lib/notify/rollout', () => ({
  NOTIFY_SURFACE: { AP_NOTIFY: 'ap_notify', AP_TEAM_OUTCOME: 'ap_team_outcome' },
}));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: () => publishNtfy() }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUBMITTER = 'gail.manager@svdp.us';
const ACCOUNTANT = 'gloria.salpino@svdp.us';
const ROSTER = 'mary.scott@svdp.us';
const FORWARDER = 'accounting.forwarder@svdp.us';

const sites: FakeSite[] = [
  { id: 'site-w', code: 'woodland', name: 'Woodland' },
  { id: 'site-e', code: 'eugene', name: 'Eugene' },
];
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
    id: 'u-shannon',
    name: 'Shannon',
    email: 'shannon@svdp.us',
    role: 'manager',
    all_sites: true,
    is_active: true,
  },
  {
    id: 'u-gail',
    name: 'Gail',
    email: SUBMITTER,
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 'site-w',
  },
];
const approvalRouting = [
  {
    id: 'ar-morena',
    first_approver_id: 'u-morena',
    second_approver_id: 'u-shannon',
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
];

function baseReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending',
    internet_message_id: '<x@svdp.us>',
    conversation_id: null,
    received_at: new Date(),
    sender_address: FORWARDER,
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

function teamReq(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return baseReq({
    internet_message_id: 'team-submit:req-1',
    sender_address: SUBMITTER,
    subject: 'Invoice #: 4471 — ACME (team submission)',
    intake_channel: 'team_submit',
    submitted_by: 'u-gail',
    submitted_site_id: 'site-w',
    submitted_at: new Date(),
    outcome_recipient_id: 'acct-gloria',
    outcome_recipient_email: ACCOUNTANT,
    ...over,
  });
}

const awaiting = {
  status: 'pending_second_approval' as const,
  site_id: 'site-e',
  vendor_freeform: 'ACME Repairs',
  explanation: 'Baler rebuild',
  confirmed_amount_cents: 250000,
  first_approver_id: 'u-morena',
  first_approved_at: new Date('2026-07-22T10:00:00Z'),
};

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

function db(req: FakeApRequest, roster: string[] = [ROSTER]): FakeDb {
  return newFakeDb({
    requests: [req],
    users,
    sites,
    approvalRouting,
    decisionRecipients: roster.map((email) => ({ email, active: true })),
  });
}

interface Sent {
  surfaceCode: string;
  site: { id: string } | null;
  recipients: string[];
  cc?: string[];
}
const lastMail = (): Sent => notifyStaffSpy.mock.calls.at(-1)![0] as Sent;

// Every mail type, driven through its real entry point.
type Kind = 'approve' | 'reject' | 'not_dr3' | 'hold' | 'second_approve' | 'resend';
async function fire(kind: Kind, req: FakeApRequest, roster?: string[]): Promise<Sent> {
  const d = db(kind === 'second_approve' ? { ...req, ...awaiting } : req, roster);
  const prisma = fp(d);
  switch (kind) {
    case 'approve':
      await decideRequest({
        prisma,
        requestId: 'req-1',
        decision: 'approved',
        actorUserId: 'u-morena',
        siteId: 'site-w',
      });
      break;
    case 'reject':
      await decideRequest({
        prisma,
        requestId: 'req-1',
        decision: 'rejected',
        actorUserId: 'u-morena',
        note: 'Not ours',
        siteId: 'site-w',
      });
      break;
    case 'not_dr3':
      await decideRequest({
        prisma,
        requestId: 'req-1',
        decision: 'approved',
        actorUserId: 'u-morena',
        note: 'Thrift store invoice',
        filedNotDr3: true,
      });
      expect(d.requests[0]!.filed_not_dr3).toBe(true);
      break;
    case 'hold':
      await holdRequest({ prisma, requestId: 'req-1', actorUserId: 'u-morena', note: 'Checking' });
      break;
    case 'second_approve':
      await decideSecondApproval({
        prisma,
        requestId: 'req-1',
        decision: 'approved',
        actor: { userId: 'u-shannon', role: 'manager' },
      });
      break;
    case 'resend':
      d.requests[0]!.status = 'approved';
      d.requests[0]!.decided_by = 'u-morena';
      d.requests[0]!.decided_at = new Date();
      d.requests[0]!.site_id = 'site-w';
      await sendDecisionEmail(prisma, 'req-1');
      break;
  }
  return lastMail();
}

const KINDS: Kind[] = ['approve', 'reject', 'not_dr3', 'hold', 'second_approve', 'resend'];

beforeEach(() => {
  notifyStaffSpy.mockClear();
  sendSystemEmail.mockClear();
  publishNtfy.mockClear();
});

describe('team submission — To the picked accountant, CC submitter + roster (ADR-0141 D4)', () => {
  it.each(KINDS)('%s', async (kind) => {
    const mail = await fire(kind, teamReq());
    expect(mail.recipients).toEqual([ACCOUNTANT]);
    expect(mail.cc).toEqual([SUBMITTER, ROSTER]);
    expect(mail.surfaceCode).toBe('ap_team_outcome');
    expect(mail.site).toEqual({ id: 'site-w' });
  });

  it('second-signature override reject: accountant To; submitter, roster AND first approver CC', async () => {
    const d = db(teamReq(awaiting));
    await decideSecondApproval({
      prisma: fp(d),
      requestId: 'req-1',
      decision: 'rejected',
      note: 'Over budget',
      actor: { userId: 'u-shannon', role: 'manager' },
    });
    const mail = lastMail();
    expect(mail.recipients).toEqual([ACCOUNTANT]);
    expect(mail.cc).toEqual([SUBMITTER, ROSTER, 'morena@svdp.us']);
  });

  it('de-duplicates: the accountant is also on the roster, the submitter too', async () => {
    const mail = await fire('approve', teamReq({ outcome_recipient_email: ROSTER }), [
      ROSTER.toUpperCase(),
      SUBMITTER,
    ]);
    expect(mail.recipients).toEqual([ROSTER]);
    expect(mail.cc).toEqual([SUBMITTER]);
  });

  it('an empty roster leaves the submitter as the only CC', async () => {
    const mail = await fire('approve', teamReq(), []);
    expect(mail.recipients).toEqual([ACCOUNTANT]);
    expect(mail.cc).toEqual([SUBMITTER]);
  });
});

describe('REGRESSION — mailbox rows are routed exactly as before ADR-0141', () => {
  it.each(KINDS)('%s → To forwarder, CC roster, org-wide ap_notify', async (kind) => {
    const mail = await fire(kind, baseReq());
    expect(mail.recipients).toEqual([FORWARDER]);
    expect(mail.cc).toEqual([ROSTER]);
    expect(mail.surfaceCode).toBe('ap_notify');
    expect(mail.site).toBeNull();
  });

  it('a mailbox row with no forwarder still falls back to the roster as To', async () => {
    const mail = await fire('approve', baseReq({ sender_address: '' }));
    expect(mail.recipients).toEqual([ROSTER]);
    expect(mail.cc ?? []).toEqual([]);
    expect(mail.surfaceCode).toBe('ap_notify');
  });

  it('an explicit intake_channel=mailbox reads the same as an absent one', async () => {
    const mail = await fire('reject', baseReq({ intake_channel: 'mailbox' }));
    expect(mail.recipients).toEqual([FORWARDER]);
    expect(mail.cc).toEqual([ROSTER]);
    expect(mail.surfaceCode).toBe('ap_notify');
  });
});
