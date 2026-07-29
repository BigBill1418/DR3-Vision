// ADVERSARIAL — scratch. Not part of the suite's contract.
//
// The 06:00 digest is the LAST BACKSTOP for every silent-notification path in
// ADR-0066. Two blind spots in it:
//
//   A. THE ASYMMETRY. §1.7's own rationale for sending on an empty queue is that
//      "suppressing it would keep a missing pair invisible until an invoice
//      happened to arrive". That reasoning is applied to a MISSING routing row
//      (W1) and NOT to a BROKEN one. A routing row pointing at a deactivated /
//      email-less peer is only reported when the resolver happens to run over a
//      real pending row — so with an empty queue it is suppressed, which is
//      exactly the state the ADR says it refuses to suppress. `computeProblems()`
//      on the admin screen already detects it; the digest never asks.
//
//   B. THE BACKSTOP'S OWN FAILURE IS SILENT. If nobody carries
//      `notify_daily_digest` (pref flipped, row deleted, account replaced), the
//      digest returns `no_recipients` and writes ONE log line. No ntfy, no email,
//      no alarm — the same fail-soft-over-an-empty-recipient-set shape the ADR
//      exists to eliminate, in the component built to detect it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const notifyStaff = vi.fn();
const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: (...a: unknown[]) => notifyStaff(...a),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...(a as [])) }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  makeFakePrisma,
  newFakeDb,
  type FakeApRequest,
  type FakeDb,
  type FakeUser,
} from '../__testutils__/fake-prisma';
import { buildApMorningDigest, runApMorningDigest } from '../morning-digest';
import { resolveSecondApproval } from '../second-approval-resolver';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

// Wednesday 2026-07-29, 06:00 PT = 13:00 UTC (PDT).
const WED_0600_PT = new Date('2026-07-29T13:00:00Z');

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
/** Off-boarded on Friday: deactivated + soft-deleted, the real shape. */
const MORENA_GONE: FakeUser = {
  id: 'u-mg',
  name: 'Morena Gomez',
  email: 'morena.gomez@svdp.us',
  role: 'manager',
  all_sites: false,
  is_active: false,
  deleted_at: new Date('2026-07-24T00:00:00Z'),
};

function req(over: Partial<FakeApRequest> = {}): FakeApRequest {
  return {
    id: 'req-1',
    status: 'pending_second_approval',
    internet_message_id: 'm-1',
    conversation_id: null,
    received_at: new Date('2026-07-29T00:00:00Z'),
    sender_address: 'ap@svdp.us',
    sender_validated: true,
    subject: 'Invoice 1',
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
    first_approver_id: JANETTE.id,
    first_approved_at: new Date('2026-07-29T01:00:00Z'),
    escalated_at: null,
    escalated_to: null,
    ...over,
  };
}

/** Routing table is TOTAL (no W1 warning) but Janette's row points at a gone user. */
function brokenPairDb(over: Partial<FakeDb> = {}): FakeDb {
  return newFakeDb({
    users: [BILL, JANETTE, MORENA_GONE],
    sites: [
      { id: 's-w', code: 'woodland', name: 'Woodland' },
      { id: 's-e', code: 'eugene', name: 'Eugene' },
    ],
    approvalRouting: [
      {
        id: 'r1',
        first_approver_id: JANETTE.id,
        second_approver_id: MORENA_GONE.id, // ← unreachable
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      },
      {
        id: 'r2',
        first_approver_id: BILL.id,
        second_approver_id: JANETTE.id,
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
  publishNtfy.mockClear();
});

describe('ADVERSARIAL A — a BROKEN routing pair is suppressed while a MISSING one is not', () => {
  it('the resolver DOES know the pair is broken', async () => {
    const routed = await resolveSecondApproval(fp(brokenPairDb()), {
      firstApproverId: JANETTE.id,
    });
    expect(routed.outcome).toBe('fallback_unreachable_peer');
    expect(routed.problems.join(' ')).toContain('unreachable second approver');
  });

  it('DEFECT: with an empty queue the digest is suppressed entirely — the broken pair stays invisible', async () => {
    const db = brokenPairDb(); // no requests at all
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);

    expect(payload.warnings).toEqual([]); // <- nothing noticed
    expect(payload.empty).toBe(true);

    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('nothing_to_report');
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('CONTRAST: the same pair is reported the moment ONE invoice happens to arrive', async () => {
    const db = brokenPairDb({ requests: [req()] });
    const payload = await buildApMorningDigest(fp(db), WED_0600_PT);
    expect(payload.warnings.join(' ')).toContain('unreachable second approver');
  });

  it('CONTRAST: a MISSING row over the same empty queue DOES send', async () => {
    const db = brokenPairDb({ approvalRouting: [] });
    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });
    expect(result.sent).toBe(true);
  });
});

describe('ADVERSARIAL B — the digest dies silently when its own audience empties', () => {
  it('DEFECT: no digest pref ⇒ no send, no page, no email — one log line only', async () => {
    const db = brokenPairDb({ requests: [req()], notificationPrefs: [] });

    const result = await runApMorningDigest({ db: fp(db), now: WED_0600_PT });

    // There WAS something to report…
    expect(result.counts.pendingSecondApproval).toBe(1);
    expect(result.counts.warnings).toBeGreaterThan(0);
    // …and it went nowhere, with nothing raised.
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no_recipients');
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});
