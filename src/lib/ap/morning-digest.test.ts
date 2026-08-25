// ADR-0066 §1.7 — the 06:00 PT weekday AP morning digest.
//
// The headline test is EMPTY-STATE SUPPRESSION. Bill asked for it explicitly and
// it is the easiest requirement in the whole section to lose: every other test
// here passes just as well against a digest that cheerfully mails "0 pending"
// every weekday morning. So it is asserted first, and asserted on the send path
// (notifyStaff never called) rather than on a payload flag.
//
// The other four pins: the 3-day high-priority flag, the missing-routing-row
// warning (how a missing pair gets NOTICED — §1.4 says the table must be total),
// weekday gating (Saturday does not send), and that the audience comes from the
// `notify_daily_digest` PREF rather than a hardcoded address.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// notifyStaff is the ADR-0047 chokepoint — mock it so no mail transport loads.
const notifyStaff = vi.fn();
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: (...a: unknown[]) => notifyStaff(...a),
}));
// morning-digest.ts and rollout.ts import the real prisma client at module load.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
// ADR-0126 — the decided-but-unmailed page. Mocked rather than left to the real
// helper's unconfigured no-op for two reasons: the ADR-0037 grading (priority,
// cooldown, fingerprint, click tier) is only assertable if the call is captured,
// and the real helper holds its cooldown IN-PROCESS, so a live publish in one
// test would suppress the next test's page and hide a regression.
const publishNtfy = vi.fn(async (args: unknown) => {
  void args; // captured by vi.fn for assertions; not read by the stub itself
  return { ok: true, outcome: 'sent' };
});
vi.mock('@/lib/ntfy', () => ({
  publishNtfy: (a: unknown) => publishNtfy(a),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
  type FakeUser,
} from './__testutils__/fake-prisma';
import {
  AGE_WARNING_DAYS,
  buildApMorningDigest,
  pacificCalendarDaysBetween,
  renderApMorningDigestHtml,
  runApMorningDigest,
  STALE_HOLD_DAYS,
} from './morning-digest';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

// ── Fixtures ────────────────────────────────────────────────────────────────

const BILL: FakeUser = {
  id: 'u-bb',
  name: 'Bill Barnard',
  email: 'bill.barnard@svdp.us',
  role: 'admin',
  all_sites: false,
  is_active: true,
};
const JANETTE: FakeUser = {
  id: 'u-jt',
  name: 'Janette Tomas',
  email: 'janette.tomas@svdp.us',
  role: 'manager',
  all_sites: false,
  is_active: true,
};
const MORENA: FakeUser = {
  id: 'u-mg',
  name: 'Morena Gomez',
  email: 'morena.gomez@svdp.us',
  role: 'manager',
  all_sites: false,
  is_active: true,
};

/** A Wednesday, 06:00 America/Los_Angeles (PDT ⇒ 13:00 UTC). The real fire time. */
const WED_0600_PT = new Date('2026-07-29T13:00:00.000Z');
/** The following Saturday, same wall clock. */
const SAT_0600_PT = new Date('2026-08-01T13:00:00.000Z');

/** `days` Pacific-calendar days before `WED_0600_PT`, at ~11am PT that day. */
function daysBefore(days: number): Date {
  return new Date(WED_0600_PT.getTime() - days * 86_400_000 + 5 * 3_600_000);
}

let reqSeq = 0;
function req(over: Partial<FakeApRequest> = {}): FakeApRequest {
  reqSeq += 1;
  return {
    id: `req-${reqSeq}`,
    status: 'pending',
    internet_message_id: `<msg-${reqSeq}@svdp.us>`,
    conversation_id: null,
    received_at: daysBefore(0),
    sender_address: 'ap@svdp.us',
    sender_validated: true,
    subject: `Invoice ${reqSeq}`,
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
    filed_not_dr3: false,
    decision_pdf_sha256: null,
    decision_pdf_r2_key: null,
    original_attachment_sha256: null,
    held_by: null,
    held_at: null,
    hold_note: null,
    escalated_at: null,
    escalated_to: null,
    ...over,
  };
}

/**
 * A fully-configured, fully-quiet fleet: two sites, a total routing table, Bill
 * on the digest pref, and an EMPTY queue. Every test starts from "nothing is
 * wrong" and introduces exactly one thing.
 */
function quietDb(over: Partial<FakeDb> = {}): FakeDb {
  return newFakeDb({
    users: [BILL, JANETTE, MORENA],
    sites: [
      { id: 's-w', code: 'woodland', name: 'Woodland' },
      { id: 's-e', code: 'eugene', name: 'Eugene' },
    ],
    approvalRouting: [
      {
        id: 'r1',
        first_approver_id: JANETTE.id,
        second_approver_id: MORENA.id,
        fallback_approver_id: BILL.id,
        fallback_after_hours: 24,
        active: true,
      },
      {
        id: 'r2',
        first_approver_id: MORENA.id,
        second_approver_id: JANETTE.id,
        fallback_approver_id: BILL.id,
        fallback_after_hours: 24,
        active: true,
      },
      {
        id: 'r3',
        first_approver_id: BILL.id,
        second_approver_id: MORENA.id,
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      },
    ],
    notificationPrefs: [
      {
        id: 'p-bill',
        user_id: BILL.id,
        notify_new_invoice: true,
        notify_second_approval_request: true,
        notify_daily_digest: true,
        notify_decision_outcome: false,
      },
    ],
    ...over,
  });
}

beforeEach(() => {
  publishNtfy.mockClear();
  notifyStaff.mockReset();
  notifyStaff.mockResolvedValue({
    surfaceCode: 'ap_notify',
    siteId: null,
    mode: 'live',
    intendedRecipients: ['bill.barnard@svdp.us'],
    actualRecipients: ['bill.barnard@svdp.us'],
    sends: [],
    delivered: 1,
    disabled: false,
  });
});

// ── 1. Empty-state suppression (the explicit §1.7 requirement) ──────────────

describe('empty-state suppression', () => {
  it('sends NOTHING when there is nothing pending — notifyStaff is never called', async () => {
    const db = quietDb();
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('nothing_to_report');
    // The assertion that matters: no email left the building at all. A payload
    // flag alone would not catch a send path that ignores it.
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('is empty even with DECIDED history in the table — only open work counts', async () => {
    // ADR-0126: the decided rows here are MAILED (`decision_mail_sent_at` set).
    // That is the whole point of the fixture — this test's subject is "closed work
    // does not reopen the digest", and closed means the notice actually went out.
    // Leaving the stamp null would make these rows a genuine delivery failure and
    // the test would be asserting the opposite of what it is named for; the
    // sibling test below covers that case deliberately.
    const db = quietDb({
      requests: [
        req({
          status: 'approved',
          decided_by: JANETTE.id,
          decided_at: daysBefore(1),
          decision_mail_sent_at: daysBefore(1),
        }),
        req({
          status: 'rejected',
          decided_by: MORENA.id,
          decided_at: daysBefore(2),
          decision_mail_sent_at: daysBefore(2),
        }),
        req({ status: 'quarantined', quarantine_reason: 'external_sender' }),
      ],
    });
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('nothing_to_report');
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('a FRESH hold is not stale — one same-day hold does not resurrect the digest', async () => {
    const db = quietDb({
      requests: [
        req({
          status: 'pending_review',
          held_by: JANETTE.id,
          held_at: daysBefore(0),
          hold_note: 'checking PO',
        }),
      ],
    });
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('nothing_to_report');
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('DOES send when the only thing to report is a warning (a missing routing pair)', async () => {
    // Deliberate refinement of "empty" (documented in the module header):
    // suppressing this would keep a real misconfiguration invisible until an
    // invoice happened to arrive — the exact shape of the outage ADR-0066 fixes.
    const db = quietDb({ approvalRouting: [] });
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(result.sent).toBe(true);
    expect(result.counts.pendingSecondApproval).toBe(0);
    expect(result.counts.awaitingFirstApproval).toBe(0);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
  });
});

// ── 2. The 3-day high-priority flag ─────────────────────────────────────────

describe(`${AGE_WARNING_DAYS}-day age flag`, () => {
  it('marks the digest high priority and adds a warning line when an invoice is 3+ days old', async () => {
    const db = quietDb({ requests: [req({ received_at: daysBefore(AGE_WARNING_DAYS) })] });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.highPriority).toBe(true);
    expect(payload.warnings.some((w) => w.includes(`${AGE_WARNING_DAYS}+ days old`))).toBe(true);

    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });
    expect(result.sent).toBe(true);
    expect(result.highPriority).toBe(true);
    const args = notifyStaff.mock.calls[0]?.[0] as { importance?: string; subject: string };
    expect(args.importance).toBe('high');
    expect(args.subject).toContain('ACTION NEEDED');
  });

  it('does NOT flag at 2 days — the boundary is inclusive at 3, not 2', async () => {
    const db = quietDb({ requests: [req({ received_at: daysBefore(AGE_WARNING_DAYS - 1) })] });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.highPriority).toBe(false);
    expect(payload.warnings).toEqual([]);
    // Still SENT — there is a pending invoice, it just isn't urgent.
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });
    expect(result.sent).toBe(true);
    const args = notifyStaff.mock.calls[0]?.[0] as { importance?: string; subject: string };
    expect(args.importance).toBeUndefined();
    expect(args.subject).not.toContain('ACTION NEEDED');
  });

  it('ages in PACIFIC calendar days — a 6pm-PT arrival is 1 day old next morning, not 2', async () => {
    // 2026-07-28 18:00 PT = 2026-07-29 01:00 UTC. Counting in UTC would put the
    // arrival on the 29th... and then read the age as 0 while a UTC-midnight
    // "days" diff against a PT day key reads 2. Only the Pacific day key gives 1.
    const evening = new Date('2026-07-29T01:00:00.000Z');
    expect(pacificCalendarDaysBetween(evening, WED_0600_PT)).toBe(1);
  });
});

// ── 3. The missing-routing-row warning ──────────────────────────────────────

describe('routing-coverage warning', () => {
  it('names every active approver with no ap_approval_routing row', async () => {
    // Morena's row is removed: she can still first-approve, and her approvals
    // would fall back to an admin immediately instead of routing to a peer.
    const db = quietDb({
      approvalRouting: quietDb().approvalRouting.filter((r) => r.first_approver_id !== MORENA.id),
      requests: [req()],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    const warning = payload.warnings.find((w) => w.includes('ap_approval_routing'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Morena Gomez');
    expect(warning).not.toContain('Janette Tomas');
    expect(warning).toContain('1 active approver has');
  });

  it('does not warn when the routing table is total', async () => {
    const db = quietDb({ requests: [req()] });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.warnings.filter((w) => w.includes('ap_approval_routing'))).toEqual([]);
  });

  it('ignores INACTIVE approvers and operator accounts — they cannot first-approve', async () => {
    const db = quietDb({
      users: [
        BILL,
        JANETTE,
        MORENA,
        {
          id: 'u-kr',
          name: 'Kelsey Ruhland',
          email: 'k@svdp.us',
          role: 'manager',
          all_sites: true,
          is_active: false,
        },
        // The email-less operator PIN account from the §1.4 near-miss.
        {
          id: 'u-mg-op',
          name: 'Morena Gomez',
          email: null,
          role: 'operator',
          all_sites: false,
          is_active: true,
        },
      ],
      requests: [req()],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.warnings.filter((w) => w.includes('ap_approval_routing'))).toEqual([]);
  });
});

// ── 4. Weekday gating (the SHARED §1.5 clock) ───────────────────────────────

describe('weekday gating', () => {
  it('does not send on a Saturday, even with a backlog', async () => {
    const db = quietDb({ requests: [req({ received_at: daysBefore(5) })] });
    const result = await runApMorningDigest({ db: fp(db), now: SAT_0600_PT });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('not_business_day');
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('does not send on a FLEET-WIDE holiday — but does when only one site observes it', async () => {
    const backlog = [req({ received_at: daysBefore(5) })];
    const holiday = new Date('2026-07-29T00:00:00.000Z'); // the Pacific day key for WED

    const bothSites = quietDb({
      requests: backlog,
      siteHolidays: [
        { site_id: 's-w', holiday_date: holiday },
        { site_id: 's-e', holiday_date: holiday },
      ],
    });
    const closed = await runApMorningDigest({ db: fp(bothSites), now: WED_0600_PT });
    expect(closed.sent).toBe(false);
    expect(closed.reason).toBe('not_business_day');

    notifyStaff.mockClear();
    const oneSite = quietDb({
      requests: backlog,
      siteHolidays: [{ site_id: 's-w', holiday_date: holiday }],
    });
    const open = await runApMorningDigest({ db: fp(oneSite), now: WED_0600_PT });
    expect(open.sent).toBe(true);
  });
});

// ── 5. Audience comes from the pref, not a hardcoded address ────────────────

describe('audience resolution', () => {
  it('resolves recipients from notify_daily_digest — never a hardcoded address', async () => {
    const db = quietDb({ requests: [req()] });
    await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    const args = notifyStaff.mock.calls[0]?.[0] as {
      recipients: Array<{ address: string }>;
      surfaceCode: string;
      site: unknown;
    };
    expect(args.recipients.map((r) => r.address)).toEqual(['bill.barnard@svdp.us']);
    // Through the ADR-0047 chokepoint, on the org-wide ap_notify surface.
    expect(args.surfaceCode).toBe('ap_notify');
    expect(args.site).toBeNull();
  });

  it('follows the pref when it MOVES — turning Bill off and Janette on re-targets the digest', async () => {
    const db = quietDb({
      requests: [req()],
      notificationPrefs: [
        {
          id: 'p-bill',
          user_id: BILL.id,
          notify_new_invoice: true,
          notify_second_approval_request: true,
          notify_daily_digest: false,
          notify_decision_outcome: false,
        },
        {
          id: 'p-jt',
          user_id: JANETTE.id,
          notify_new_invoice: true,
          notify_second_approval_request: true,
          notify_daily_digest: true,
          notify_decision_outcome: false,
        },
      ],
    });
    await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    const args = notifyStaff.mock.calls[0]?.[0] as { recipients: Array<{ address: string }> };
    expect(args.recipients.map((r) => r.address)).toEqual(['janette.tomas@svdp.us']);
  });

  it('reports no_recipients (loudly, not silently) when nobody has the pref on', async () => {
    const db = quietDb({ requests: [req()], notificationPrefs: [] });
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no_recipients');
    expect(notifyStaff).not.toHaveBeenCalled();
  });
});

// ── 6. Coverage: who owes the signature, stale holds, escalations ───────────

describe('coverage', () => {
  it('names the individual who owes each second signature, via the shared resolver', async () => {
    const db = quietDb({
      requests: [
        req({
          status: 'pending_second_approval',
          first_approver_id: JANETTE.id,
          first_approved_at: daysBefore(1),
          vendor_freeform: 'Acme Hauling',
          confirmed_amount_cents: 250_000,
        }),
      ],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.pendingSecondApproval).toHaveLength(1);
    // Janette signed first ⇒ Morena owes it (§1.4 routing), NOT a site label.
    expect(payload.pendingSecondApproval[0]?.detail).toContain('Owed by: Morena Gomez');
    expect(payload.pendingSecondApproval[0]?.url).toContain('/dashboard/ops/ap?request=');

    const html = renderApMorningDigestHtml(payload);
    expect(html).toContain('Morena Gomez');
    expect(html).toContain('Acme Hauling');
    expect(html).toContain('$2,500.00');
  });

  it('reports the fallback (and a warning) when the first approver has no routing row', async () => {
    const db = quietDb({
      approvalRouting: [],
      requests: [
        req({
          status: 'pending_second_approval',
          first_approver_id: JANETTE.id,
          first_approved_at: daysBefore(1),
        }),
      ],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.pendingSecondApproval[0]?.detail).toContain('Bill Barnard (fallback)');
    expect(payload.warnings.some((w) => w.includes('No active ap_approval_routing row'))).toBe(
      true,
    );
  });

  it(`lists holds stale at ${STALE_HOLD_DAYS}+ days and omits fresher ones`, async () => {
    const db = quietDb({
      requests: [
        req({
          status: 'pending_review',
          held_by: JANETTE.id,
          held_at: daysBefore(STALE_HOLD_DAYS),
          hold_note: 'waiting on vendor',
          subject: 'STALE HOLD',
        }),
        req({
          status: 'pending_review',
          held_by: JANETTE.id,
          held_at: daysBefore(1),
          hold_note: 'checking PO',
          subject: 'FRESH HOLD',
        }),
      ],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.staleHolds.map((h) => h.subject)).toEqual(['STALE HOLD']);
    expect(payload.staleHolds[0]?.detail).toContain('waiting on vendor');
  });

  it('labels an ESCALATED row as "either may sign" — escalation is additive, not a transfer', async () => {
    const db = quietDb({
      requests: [
        req({
          status: 'pending_second_approval',
          first_approver_id: JANETTE.id,
          first_approved_at: daysBefore(2),
          escalated_at: daysBefore(1),
          escalated_to: BILL.id,
        }),
      ],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    const detail = payload.pendingSecondApproval[0]?.detail ?? '';

    // The routed peer (Morena) is still on the hook alongside the fallback (Bill)
    // — calling this a "fallback" would misreport who can still act (§1.5).
    expect(detail).toContain('Morena Gomez');
    expect(detail).toContain('Bill Barnard');
    expect(detail).toContain('either may sign');
    expect(detail).not.toContain('(fallback)');
    expect(detail).toContain('ESCALATED');
  });

  it('reports escalations since the previous business day and ignores older ones', async () => {
    const db = quietDb({
      requests: [
        req({
          status: 'pending_second_approval',
          first_approver_id: JANETTE.id,
          first_approved_at: daysBefore(2),
          escalated_at: daysBefore(1),
          escalated_to: BILL.id,
          subject: 'RECENT ESCALATION',
        }),
        req({
          status: 'pending_second_approval',
          first_approver_id: MORENA.id,
          first_approved_at: daysBefore(10),
          escalated_at: daysBefore(9),
          escalated_to: BILL.id,
          subject: 'OLD ESCALATION',
        }),
      ],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.escalations.map((e) => e.subject)).toEqual(['RECENT ESCALATION']);
  });

  it('escapes HTML in vendor/subject — an invoice subject is untrusted inbound mail', async () => {
    const db = quietDb({
      requests: [req({ subject: '<script>alert(1)</script>', vendor_freeform: 'A & B "Co"' })],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    const html = renderApMorningDigestHtml(payload);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B &quot;Co&quot;');
  });
});

// ── ADR-0068 (Amendment 2) — reimbursements in the 06:00 digest ──────────────
//
// The digest is a FULL-QUEUE oversight tool (§1.7), and reimbursements were
// specified for inclusion but shipped without it — so a reimbursement could sit
// on one person's desk and appear in NO oversight surface Bill reads. These tests
// make the inclusion structural.

function reimb(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rb-1',
    status: 'pending_second_approval',
    site_id: 's-w',
    amount_cents: 4000,
    submitted_at: new Date('2026-07-29T10:00:00.000Z'), // same Pacific day
    escalated_at: null,
    employee_name_freeform: 'Diego Ramirez',
    employee_user: null,
    submitter: { name: 'Janette Tomas' },
    routed_to: { name: 'Morena Gomez' },
    site: { code: 'woodland', name: 'Woodland' },
    ...over,
  };
}

describe('ADR-0068 — pending reimbursements appear in the digest', () => {
  it('lists a pending reimbursement with who owes the signature', async () => {
    const db = quietDb({ reimbursements: [reimb()] } as Partial<FakeDb>);
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.pendingReimbursements).toHaveLength(1);
    const item = payload.pendingReimbursements[0];
    expect(item?.subject).toContain('Diego Ramirez');
    expect(item?.amountCents).toBe(4000);
    // Both facts an approver needs: who filed it, and who it is waiting on.
    expect(item?.detail).toContain('Janette Tomas');
    expect(item?.detail).toContain('Morena Gomez');
    // The link must land on the reimbursement surface, NOT the AP queue — the AP
    // queue does not contain this row.
    expect(item?.url).toContain('/dashboard/woodland/reimbursements');
  });

  it('a pending reimbursement ALONE is enough to send the digest', async () => {
    // Otherwise the one case that matters — an empty invoice queue and a
    // reimbursement nobody has signed — would be suppressed as "nothing to report".
    const db = quietDb({ reimbursements: [reimb()] } as Partial<FakeDb>);
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.empty).toBe(false);
  });

  it('an aged reimbursement raises the WHOLE digest to high priority', async () => {
    const db = quietDb({
      reimbursements: [reimb({ submitted_at: new Date('2026-07-20T10:00:00.000Z') })],
    } as Partial<FakeDb>);
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.highPriority).toBe(true);
    // The warning has to say the consequence, not just the count.
    expect(payload.warnings.join(' ')).toMatch(/Somebody is owed money/i);
  });

  it('marks an ESCALATED reimbursement as such', async () => {
    const db = quietDb({
      reimbursements: [reimb({ escalated_at: new Date('2026-07-29T11:00:00.000Z') })],
    } as Partial<FakeDb>);
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.pendingReimbursements[0]?.detail).toContain('ESCALATED');
  });

  it('renders the reimbursement section into the email body', async () => {
    const db = quietDb({ reimbursements: [reimb()] } as Partial<FakeDb>);
    await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(notifyStaff).toHaveBeenCalled();
    const arg = notifyStaff.mock.calls[0]?.[0] as { htmlBody: string };
    expect(arg.htmlBody).toContain('Reimbursements awaiting a second signature');
    expect(arg.htmlBody).toContain('Diego Ramirez');
  });

  it('stays SILENT when there are no reimbursements and nothing else', async () => {
    // The suppression rule must survive the new section: adding a section that
    // always renders would turn a quiet day into daily zero-state noise.
    const payload = await buildApMorningDigest(fp(quietDb()), WED_0600_PT);
    expect(payload.pendingReimbursements).toHaveLength(0);
    expect(payload.empty).toBe(true);
  });
});

// ── ADR-0126. Decided, but nobody was told ─────────────────────────────────
//
// The backstop for the whole decision-mail path. Two rejections were decided in
// July/August 2026, refused by the transport as oversize, never stamped, and
// never re-sent — accounting was told about neither, and no surface anywhere said
// so for weeks. These tests pin the surface that ends that class of silence.

describe('ADR-0126 — decided but no confirmed decision email', () => {
  /** A decided row whose notice never went out, decided `days` Pacific days ago. */
  const unmailed = (over: Partial<FakeApRequest> = {}) =>
    req({
      status: 'rejected',
      decided_by: JANETTE.id,
      decided_at: daysBefore(1),
      decision_mail_sent_at: null,
      ...over,
    });

  it('RESURRECTS an otherwise-empty digest — the queue being quiet is the dangerous case', async () => {
    // The load-bearing test. Nothing is pending, so every other section is empty
    // and the §1.7 suppression rule would have sent nothing at all. An unmailed
    // decision has to be strong enough on its own to force the mail out, or it
    // stays invisible on exactly the quiet mornings it is most likely to occur.
    const db = quietDb({ requests: [unmailed()] });
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(result.sent).toBe(true);
    expect(result.counts.decidedUnmailed).toBe(1);
    expect(notifyStaff).toHaveBeenCalled();
  });

  it('raises the digest to high priority at ANY age', async () => {
    // A pending invoice is merely slow and gets 3 days. An undelivered decision is
    // already broken — waiting 3 days to say so reproduces part of the incident.
    // 30 minutes ago — same Pacific day, just past the anti-race grace. Note
    // `daysBefore(0)` is NOT usable here: it lands 5h AFTER the 06:00 fire time,
    // i.e. a decision in the future, which correctly fails the grace check.
    const db = quietDb({
      requests: [unmailed({ decided_at: new Date(WED_0600_PT.getTime() - 30 * 60_000) })],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.highPriority).toBe(true);
    expect(payload.decidedUnmailed).toHaveLength(1);
  });

  it('does NOT flag a send that may still be in flight (anti-race grace)', async () => {
    const db = quietDb({
      requests: [unmailed({ decided_at: new Date(WED_0600_PT.getTime() - 60_000) })],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.decidedUnmailed).toHaveLength(0);
    expect(payload.empty).toBe(true);
  });

  it('does NOT flag a >= $1,000 request still awaiting its second signature', async () => {
    // pending_second_approval sends no decision mail BY DESIGN (ADR-0046 D-M5-3).
    // Flagging it would make the sweep noise from its very first run.
    const db = quietDb({
      requests: [
        req({
          status: 'pending_second_approval',
          first_approver_id: JANETTE.id,
          first_approved_at: daysBefore(1),
          decision_mail_sent_at: null,
        }),
      ],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.decidedUnmailed).toHaveLength(0);
  });

  it('does NOT flag a decision whose mail was confirmed sent', async () => {
    const db = quietDb({
      requests: [unmailed({ decision_mail_sent_at: daysBefore(1) })],
    });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.decidedUnmailed).toHaveLength(0);
    expect(payload.empty).toBe(true);
  });

  it('surfaces a decided row with a NULL decided_at rather than hiding it', async () => {
    const db = quietDb({ requests: [unmailed({ decided_at: null })] });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.decidedUnmailed).toHaveLength(1);
    expect(payload.decidedUnmailed[0]?.detail).toContain('an unrecorded time');
  });

  it('renders its own section AND a warning line in the email body', async () => {
    // Both surfaces, deliberately: the section carries the rows, the warning
    // survives into the "Needs attention" block that Bill reads first.
    const db = quietDb({ requests: [unmailed()] });
    await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    const arg = notifyStaff.mock.calls[0]?.[0] as { htmlBody: string; subject: string };
    expect(arg.htmlBody).toContain('DECIDED — but no decision email confirmed sent');
    expect(arg.htmlBody).toContain('accounting was never told');
    expect(arg.subject).toContain('ACTION NEEDED');
  });

  it('pages ntfy on an EXISTING topic, graded high, keyed on the stuck SET', async () => {
    const db = quietDb({ requests: [unmailed({ id: 'req-stuck-1' })] });
    await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const page = publishNtfy.mock.calls[0]?.[0] as unknown as {
      topic: string;
      priority: string;
      fingerprint: string;
      cooldownMs: number;
      clickUrl: string;
      body: string;
    };
    // An EXISTING topic. A new one is a silent black hole — nobody is subscribed.
    expect(page.topic).toBe('dr3-vision-system');
    // ADR-0037: high, not urgent. Accounting is un-notified about a decision that
    // already stands; it is not customer-facing and does not warrant a 3am wake.
    expect(page.priority).toBe('high');
    expect(page.fingerprint).toContain('req-stuck-1');
    // Longer than the daily digest cadence, or it re-pages every morning forever.
    expect(page.cooldownMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    // Exactly one row ⇒ tier-1 deep link (ADR-0036 click policy).
    expect(page.clickUrl).toContain('request=req-stuck-1');
    // ADR-0045 — ids only in a page body, never vendor or amount.
    expect(page.body).toContain('req-stuck-1');
  });

  it('falls back to the tier-2 queue link when several rows are stuck', async () => {
    const db = quietDb({
      requests: [unmailed({ id: 'req-a' }), unmailed({ id: 'req-b', status: 'approved' })],
    });
    await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    const page = publishNtfy.mock.calls[0]?.[0] as unknown as {
      clickUrl: string;
      fingerprint: string;
    };
    expect(page.clickUrl).not.toContain('request=');
    expect(page.clickUrl).toContain('/dashboard/ops/ap');
    // Set-keyed: both ids present, so adding a third row would change the key and
    // page again rather than hiding inside this alert's week-long cooldown.
    expect(page.fingerprint).toContain('req-a');
    expect(page.fingerprint).toContain('req-b');
  });

  it('does NOT page when nothing is stuck', async () => {
    await runApMorningDigest({ db: fp(quietDb()), now: WED_0600_PT });
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('pages even when the digest email itself has nowhere to go', async () => {
    // The co-occurring failure that matters: the same broken credentials that
    // stopped the decision mail would stop the digest reporting it. The alarm must
    // not depend on the channel it is reporting on.
    const db = quietDb({ requests: [unmailed()] });
    for (const p of db.notificationPrefs ?? []) p.notify_daily_digest = false;
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    expect(result.reason).toBe('no_recipients');
    const topics = publishNtfy.mock.calls.map((c) => (c[0] as unknown as { title: string }).title);
    expect(topics.some((t) => t.includes('never confirmed sent'))).toBe(true);
  });
});
