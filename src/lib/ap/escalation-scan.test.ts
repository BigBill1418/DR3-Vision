// ADR-0066 §1.5 — the hourly weekday-clock escalation scanner.
//
// The four properties under test are the four ways this could recreate the
// outage it exists to fix:
//
//   1. THE WEEKEND PAUSE   — Bill's decision verbatim: "weekdays only. The clock
//                            pauses Friday evening and resumes Monday." A Friday
//                            4pm first approval must NOT escalate Saturday.
//   2. IDEMPOTENCY         — an already-escalated request is NEVER re-notified.
//                            Asserted by running the scan TWICE and counting.
//   3. ADDITIVE, NOT A TRANSFER — the routed peer stays able to sign.
//   4. NO ROUTING ROW ⇒ IMMEDIATE — degrade LOUDLY (instant escalation + alarm),
//                            never quietly.
//
// Plus the posture that ties them together: a scan that cannot run PAGES rather
// than returning a clean, empty, indistinguishable-from-healthy result.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
} from './__testutils__/fake-prisma';

const publishNtfy = vi.fn(async (args?: unknown) => {
  void args;
  return { ok: true, outcome: 'sent' as const };
});
const notifySecondApprovalEscalated = vi.fn(async (args?: unknown) => {
  void args;
});
const reportSecondApprovalRoutingProblem = vi.fn(async (args?: unknown) => {
  void args;
});

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (args: unknown) => publishNtfy(args) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// `@/lib/audit` is deliberately NOT mocked — the audit row must land in the fake
// db so its SHAPE can be asserted (hard rule #6 is about what is written, not
// that a spy was called).
vi.mock('./notify', () => ({
  notifySecondApprovalEscalated: (args: unknown) => notifySecondApprovalEscalated(args),
  reportSecondApprovalRoutingProblem: (args: unknown) => reportSecondApprovalRoutingProblem(args),
}));

import { runApEscalationScan } from './escalation-scan';
import { canFulfillSecondApprovalByRouting } from './second-approval-resolver';

const fp = (db: FakeDb): PrismaClient => makeFakePrisma(db) as unknown as PrismaClient;

// ── The clock ───────────────────────────────────────────────────────────────
// July 2026 is PDT (UTC-7). 2026-07-24 is a Friday; 07-25 Saturday; 07-27 Monday.
const FRI_4PM_PT = new Date('2026-07-24T23:00:00Z');
const SAT_4PM_PT = new Date('2026-07-25T23:00:00Z'); //  8 business hours later
const MON_8AM_PT = new Date('2026-07-27T15:00:00Z'); // 16 business hours later
const MON_4PM_PT = new Date('2026-07-27T23:00:00Z'); // 24 business hours later

const U = {
  janette: {
    id: 'u-jt',
    name: 'Janette Tomas',
    email: 'janette.tomas@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  morena: {
    id: 'u-mg',
    name: 'Morena Gomez',
    email: 'morena.gomez@svdp.us',
    role: 'manager' as const,
    all_sites: false,
    is_active: true,
  },
  bill: {
    id: 'u-bb',
    name: 'Bill Barnard',
    email: 'bill.barnard@svdp.us',
    role: 'admin' as const,
    all_sites: false,
    is_active: true,
  },
};

const SITES = [
  { id: 's-w', code: 'woodland', name: 'Woodland' },
  { id: 's-e', code: 'eugene', name: 'Eugene' },
];

// Janette → Morena, no explicit fallback ⇒ the fallback is the system admin (Bill).
const ROUTING = [
  {
    id: 'r1',
    first_approver_id: U.janette.id,
    second_approver_id: U.morena.id,
    fallback_approver_id: null,
    fallback_after_hours: 24,
    active: true,
  },
];

function pendingSecond(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending_second_approval',
    internet_message_id: 'msg-1',
    conversation_id: null,
    received_at: new Date('2026-07-24T20:00:00Z'),
    sender_address: 'ap@svdp.us',
    sender_validated: true,
    subject: 'Invoice 4471',
    body_html_sanitized: null,
    body_text: null,
    vendor: null,
    amount_cents: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    decision_mail_sent_at: null,
    quarantine_reason: null,
    site_id: 's-w',
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    first_approver_id: U.janette.id,
    first_approved_at: FRI_4PM_PT,
    escalated_at: null,
    escalated_to: null,
    ...over,
  };
}

const seed = (over: Partial<FakeDb> = {}): FakeDb =>
  newFakeDb({
    users: Object.values(U),
    sites: SITES,
    approvalRouting: ROUTING,
    requests: [pendingSecond()],
    ...over,
  });

beforeEach(() => {
  publishNtfy.mockClear();
  notifySecondApprovalEscalated.mockClear();
  reportSecondApprovalRoutingProblem.mockClear();
});

describe('§1.5 the weekday clock — the escalation deadline pauses over the weekend', () => {
  it('does NOT escalate on Saturday a request first-approved Friday 4pm', async () => {
    const db = seed();
    const res = await runApEscalationScan({ prisma: fp(db), now: SAT_4PM_PT });

    expect(res.scanned).toBe(1);
    expect(res.escalated).toBe(0);
    expect(db.requests[0]?.escalated_at ?? null).toBeNull();
    expect(notifySecondApprovalEscalated).not.toHaveBeenCalled();
  });

  it('still does NOT escalate Monday MORNING — only 16 business hours have accrued', async () => {
    const db = seed();
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_8AM_PT });

    expect(res.escalated).toBe(0);
    expect(db.requests[0]?.escalated_at ?? null).toBeNull();
  });

  it('DOES escalate Monday 4pm — the 24th business hour', async () => {
    const db = seed();
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    expect(res.escalated).toBe(1);
    expect(res.requestIds).toEqual(['req-1']);
    expect(db.requests[0]?.escalated_at).toEqual(MON_4PM_PT);
    // The fallback for a NULL fallback_approver_id is the system admin (§1.4).
    expect(db.requests[0]?.escalated_to).toBe(U.bill.id);
    expect(notifySecondApprovalEscalated).toHaveBeenCalledOnce();
  });

  it('a fleet-wide holiday pauses the clock too', async () => {
    // Monday observed at BOTH sites ⇒ it accrues no business time, so the 24th
    // hour never arrives on Monday. (A one-site holiday would NOT pause it —
    // see the HOLIDAYS note in business-clock.ts.)
    const db = seed({
      siteHolidays: [
        { id: 'h1', site_id: 's-w', holiday_date: new Date('2026-07-27T00:00:00Z') },
        { id: 'h2', site_id: 's-e', holiday_date: new Date('2026-07-27T00:00:00Z') },
      ],
    });
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    expect(res.escalated).toBe(0);
    expect(db.requests[0]?.escalated_at ?? null).toBeNull();
  });

  it('honors a pair’s custom fallback_after_hours instead of the 24h default', async () => {
    const db = seed({
      approvalRouting: [{ ...ROUTING[0]!, fallback_after_hours: 4 }],
    });
    // Saturday: only 8 business hours have accrued, but this pair escalates at 4.
    const res = await runApEscalationScan({ prisma: fp(db), now: SAT_4PM_PT });
    expect(res.escalated).toBe(1);
  });
});

describe('§1.5 IDEMPOTENCY — escalated_at IS NULL is the key', () => {
  it('two runs escalate once, notify once, and write exactly one audit row', async () => {
    const db = seed();
    const prisma = fp(db);

    const first = await runApEscalationScan({ prisma, now: MON_4PM_PT });
    const second = await runApEscalationScan({ prisma, now: MON_4PM_PT });

    expect(first.escalated).toBe(1);
    // The second run does not even SEE it — the candidate query filters on
    // escalated_at IS NULL, and the conditional claim would refuse it anyway.
    expect(second.scanned).toBe(0);
    expect(second.escalated).toBe(0);

    expect(notifySecondApprovalEscalated).toHaveBeenCalledTimes(1);
    const escalationAudits = db.auditLogs.filter(
      (a) => a.actor_label === 'system:ap-escalation-scan',
    );
    expect(escalationAudits).toHaveLength(1);
  });

  it('an already-escalated request is never re-notified even hours later', async () => {
    const db = seed({
      requests: [
        pendingSecond({
          escalated_at: new Date('2026-07-27T23:00:00Z'),
          escalated_to: U.bill.id,
        }),
      ],
    });
    const res = await runApEscalationScan({
      prisma: fp(db),
      now: new Date('2026-07-28T23:00:00Z'),
    });

    expect(res.scanned).toBe(0);
    expect(notifySecondApprovalEscalated).not.toHaveBeenCalled();
  });

  it('ignores requests that are not awaiting second approval', async () => {
    const db = seed({ requests: [pendingSecond({ status: 'approved' })] });
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });
    expect(res.scanned).toBe(0);
  });
});

describe('§1.5 ESCALATION IS ADDITIVE, NEVER A TRANSFER', () => {
  it('leaves the originally routed peer authorized to sign', async () => {
    const db = seed();
    const prisma = fp(db);
    await runApEscalationScan({ prisma, now: MON_4PM_PT });

    const peerStillAuthorized = await canFulfillSecondApprovalByRouting(
      prisma,
      { userId: U.morena.id, role: 'manager' },
      { firstApproverId: U.janette.id, escalated: true },
    );
    expect(peerStillAuthorized).toBe(true);
  });

  it('emails the FALLBACK only — the peer already has the original request', async () => {
    const db = seed();
    await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    const arg = notifySecondApprovalEscalated.mock.calls[0]?.[0] as {
      approverEmails: string[];
      routedToName: string | null;
      thresholdHours: number;
    };
    expect(arg.approverEmails).toEqual([U.bill.email]);
    // …and the copy still names the peer, because they can STILL sign.
    expect(arg.routedToName).toBe(U.morena.name);
    expect(arg.thresholdHours).toBe(24);
  });

  it('does not touch status — an escalation is not a decision', async () => {
    const db = seed();
    await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });
    expect(db.requests[0]?.status).toBe('pending_second_approval');
    expect(db.requests[0]?.decided_by ?? null).toBeNull();
  });

  it('a pref opt-out subtracts the recipient but never blocks the widening', async () => {
    const db = seed({
      notificationPrefs: [
        {
          id: 'p1',
          user_id: U.bill.id,
          notify_new_invoice: false,
          notify_second_approval_request: false,
          notify_daily_digest: true,
          notify_decision_outcome: false,
        },
      ],
    });
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    // Authorization still widened and was still stamped + audited…
    expect(res.escalated).toBe(1);
    expect(db.requests[0]?.escalated_to).toBe(U.bill.id);
    // …the opt-out only emptied the email list.
    const arg = notifySecondApprovalEscalated.mock.calls[0]?.[0] as { approverEmails: string[] };
    expect(arg.approverEmails).toEqual([]);
  });
});

describe('§1.4 no routing row ⇒ escalate IMMEDIATELY, and say so', () => {
  it('escalates a minute-old request and raises the routing alarm', async () => {
    const db = seed({
      approvalRouting: [], // the table is not total — the case §1.4 calls out
      requests: [pendingSecond({ first_approved_at: new Date('2026-07-27T22:59:00Z') })],
    });
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    expect(res.escalated).toBe(1);
    expect(res.problems.join(' ')).toMatch(/No active ap_approval_routing row/i);
    expect(reportSecondApprovalRoutingProblem).toHaveBeenCalledOnce();

    // thresholdHours 0 marks the immediate path — there was no 24h wait to serve.
    const arg = notifySecondApprovalEscalated.mock.calls[0]?.[0] as { thresholdHours: number };
    expect(arg.thresholdHours).toBe(0);
  });

  it('a request with no first_approved_at escalates rather than aging forever', async () => {
    const db = seed({ requests: [pendingSecond({ first_approved_at: null })] });
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });
    expect(res.escalated).toBe(1);
  });

  it('healthy routing raises no alarm', async () => {
    const db = seed();
    await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });
    expect(reportSecondApprovalRoutingProblem).not.toHaveBeenCalled();
  });
});

describe('hard rule #6 — the append-only audit row', () => {
  it('records the system actor, the before/after, and the additive semantics', async () => {
    const db = seed();
    await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });

    const audit = db.auditLogs.find((a) => a.actor_label === 'system:ap-escalation-scan');
    expect(audit).toBeDefined();
    expect(audit?.actor_user_id).toBeNull(); // a system process, not a person
    expect(audit?.action).toBe('update');
    expect(audit?.table_name).toBe('ap_requests');
    expect(audit?.row_id).toBe('req-1');
    expect(audit?.before).toMatchObject({
      status: 'pending_second_approval',
      escalated_at: null,
      escalated_to: null,
    });
    expect(audit?.after).toMatchObject({
      status: 'pending_second_approval',
      escalated_at: MON_4PM_PT.toISOString(),
      escalated_to: U.bill.id,
      routing_outcome: 'escalated',
      threshold_hours: 24,
      additive: true,
    });
    // The authorized set is recorded so an auditor can see the peer was never
    // removed — the property the ADR is most emphatic about.
    const after = audit?.after as { still_authorized: string[] };
    expect(after.still_authorized).toContain(U.morena.id);
  });

  it('writes no audit row when nothing escalates', async () => {
    const db = seed();
    await runApEscalationScan({ prisma: fp(db), now: SAT_4PM_PT });
    expect(db.auditLogs).toHaveLength(0);
  });
});

describe('§B.8 fail LOUD — a scan that cannot run must page, not no-op', () => {
  it('pages dr3-vision-system and re-throws when the candidate query fails', async () => {
    const db = seed();
    const prisma = fp(db);
    prisma.apRequest.findMany = (async () => {
      throw new Error('connection terminated');
    }) as unknown as PrismaClient['apRequest']['findMany'];

    await expect(runApEscalationScan({ prisma, now: MON_4PM_PT })).rejects.toThrow(
      /connection terminated/,
    );

    expect(publishNtfy).toHaveBeenCalledOnce();
    const page = publishNtfy.mock.calls[0]?.[0] as { topic: string; title: string; body: string };
    expect(page.topic).toBe('dr3-vision-system');
    expect(page.body).toMatch(/connection terminated/);
  });

  it('contains a single poisoned row, pages, and keeps scanning the rest', async () => {
    const db = seed({
      requests: [
        pendingSecond({ id: 'req-bad' }),
        pendingSecond({ id: 'req-ok', internet_message_id: 'msg-2' }),
      ],
    });
    const prisma = fp(db);
    const realFindFirst = prisma.apApprovalRouting.findFirst.bind(prisma.apApprovalRouting);
    let calls = 0;
    prisma.apApprovalRouting.findFirst = (async (args: unknown) => {
      calls += 1;
      // The resolver reads first (call 1), then the threshold lookup (call 2) —
      // blow up the threshold lookup for the FIRST request only.
      if (calls === 2) throw new Error('routing read failed');
      return realFindFirst(args as never);
    }) as unknown as PrismaClient['apApprovalRouting']['findFirst'];

    const res = await runApEscalationScan({ prisma, now: MON_4PM_PT });

    expect(res.scanned).toBe(2);
    expect(res.requestIds).toEqual(['req-ok']); // the healthy row still escalated
    expect(res.problems.join(' ')).toMatch(/routing read failed/);
    expect(publishNtfy).toHaveBeenCalledOnce(); // the failure PAGED
  });

  it('does NOT page on a clean, empty run', async () => {
    const db = seed({ requests: [] });
    const res = await runApEscalationScan({ prisma: fp(db), now: MON_4PM_PT });
    expect(res).toMatchObject({ scanned: 0, escalated: 0 });
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});
