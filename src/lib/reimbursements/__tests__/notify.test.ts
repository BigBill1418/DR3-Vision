// ADR-0068 D6 — who hears about a reimbursement, and who must NEVER hear about it.
//
// Why this file exists at all: `notify.ts` shipped with ZERO coverage while being
// the single most dangerous file in the feature. It is fail-soft by design — a
// paging failure must not roll back a filed or decided reimbursement — and
// fail-soft over an EMPTY audience is indistinguishable from success.
//
// This repo already carries that scar. `resolveSlotSigner` had tests that MOCKED
// THE DATABASE INTO AGREEING with a production-wrong query, and ops signers were
// never emailed for months while every surface reported success. So this suite is
// deliberately built the other way round:
//
//   * the REAL `resolveReimbursementApproval` runs, over a fake Prisma whose rows
//     are the only fiction. If the resolver's answer is wrong, these tests break.
//   * ONLY `notifyStaff` is mocked, because it is the email transport — the one
//     boundary a unit test must not cross. The mock ECHOES its arguments back so
//     assertions are made against what the code really asked to send, not against
//     a hand-written expectation of it.
//
// The two directions of D6 are asserted as opposites, positively AND negatively.
// "Mary was emailed" is only half the control; "the submitter was NOT emailed" is
// the half that fails silently.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { NotifyStaffArgs, NotifyStaffResult } from '@/lib/notify/notify-staff';

vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

// ── The transport seam ──────────────────────────────────────────────────────
// Echoes the real audience back so every assertion below is about what the code
// actually asked to send. `override` lets a single test simulate a resolved-empty
// audience or a disabled transport without changing any other test's behaviour.
let sendOverride: Partial<NotifyStaffResult> | null = null;
const notifyStaffMock = vi.fn(async (args: NotifyStaffArgs): Promise<NotifyStaffResult> => {
  const addrs = args.recipients.map((r) => (typeof r === 'string' ? r : r.address));
  return {
    surfaceCode: args.surfaceCode,
    siteId: args.site?.id ?? null,
    mode: 'live',
    intendedRecipients: addrs,
    actualRecipients: addrs,
    sends: [],
    delivered: addrs.length,
    disabled: false,
    ...(sendOverride ?? {}),
  } as NotifyStaffResult;
});

vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: (args: NotifyStaffArgs) => notifyStaffMock(args),
}));

const { notifyReimbursementSubmitted, notifyReimbursementDecided, ACCOUNTING_RECIPIENT } =
  await import('../notify');

// ── Fixtures ────────────────────────────────────────────────────────────────

const SUBMITTED_AT = new Date('2026-07-29T17:30:00.000Z'); // 10:30 AM PDT
const APPROVED_AT = new Date('2026-07-29T19:45:00.000Z'); // 12:45 PM PDT

interface FakeUser {
  id: string;
  name: string;
  email: string | null;
  role: string;
  is_active: boolean;
  all_sites: boolean;
  primary_site_id: string | null;
  deleted_at: Date | null;
}

const JANETTE: FakeUser = {
  id: 'u-jt',
  name: 'Janette Tomas',
  email: 'janette.tomas@svdp.us',
  role: 'manager',
  is_active: true,
  all_sites: false,
  primary_site_id: 'site-w',
  deleted_at: null,
};
const MORENA: FakeUser = {
  id: 'u-mg',
  name: 'Morena Gomez',
  email: 'morena.gomez@svdp.us',
  role: 'manager',
  is_active: true,
  all_sites: false,
  primary_site_id: 'site-w',
  deleted_at: null,
};
const BILL: FakeUser = {
  id: 'u-bb',
  name: 'Bill Barnard',
  email: 'bill.barnard@svdp.us',
  role: 'admin',
  is_active: true,
  all_sites: true,
  primary_site_id: null,
  deleted_at: null,
};

let users: FakeUser[];
let routing: Array<{
  first_approver_id: string;
  second_approver_id: string;
  fallback_approver_id: string | null;
  active: boolean;
}>;

/** The shape `notify.ts`'s `load()` selects, relations included. */
function reimbursementRow(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    submitted_by: 'u-jt',
    employee_user_id: null,
    amount_cents: 4235,
    expense_date: new Date('2026-07-24T00:00:00.000Z'),
    category: 'mileage',
    purpose: 'Dump run to Short Mountain',
    status: 'pending_second_approval',
    submitted_at: SUBMITTED_AT,
    second_approved_at: null,
    decision_note: null,
    employee_name_freeform: 'Diego Ramirez',
    escalation_reason: null,
    employee_user: null,
    submitter: { name: JANETTE.name, email: JANETTE.email },
    second_approver: null,
    routed_to: { name: MORENA.name, email: MORENA.email },
    site: { id: 'site-w', code: 'woodland', name: 'Woodland' },
    ...over,
  };
}

let rows: Array<Record<string, unknown>>;
let updates: Array<{ id: string; data: Record<string, unknown> }>;

function fakePrisma(): PrismaClient {
  const client = {
    reimbursementRequest: {
      // `load()` passes a nested select; the fake returns the whole row. The row
      // IS the fixture, so narrowing it here would only hide fields from the code.
      async findUnique(a: { where: { id: string } }) {
        return rows.find((r) => r['id'] === a.where.id) ?? null;
      },
      async update(a: { where: { id: string }; data: Record<string, unknown> }) {
        updates.push({ id: a.where.id, data: a.data });
        const r = rows.find((x) => x['id'] === a.where.id);
        if (r) Object.assign(r, a.data);
        return r;
      },
    },
    user: {
      async findUnique(a: { where: { id: string } }) {
        return users.find((u) => u.id === a.where.id) ?? null;
      },
      async findMany(a: {
        where?: { id?: { in?: string[] }; role?: string; is_active?: boolean };
      }) {
        let out = users.slice();
        const ids = a.where?.id?.in;
        if (ids) out = out.filter((u) => ids.includes(u.id));
        if (a.where?.role) out = out.filter((u) => u.role === a.where?.role);
        if (a.where?.is_active !== undefined) out = out.filter((u) => u.is_active);
        return out;
      },
    },
    apApprovalRouting: {
      async findFirst(a: { where: { first_approver_id: string; active?: boolean } }) {
        return (
          routing.find((r) => r.first_approver_id === a.where.first_approver_id && r.active) ?? null
        );
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
  };
  return client as unknown as PrismaClient;
}

/** Every address the code asked the transport to write to, primary + cc. */
function audienceOf(call: NotifyStaffArgs): string[] {
  return [
    ...call.recipients.map((r) => (typeof r === 'string' ? r : r.address)),
    ...(call.cc ?? []),
  ].map((a) => a.toLowerCase());
}

function lastCall(): NotifyStaffArgs {
  const c = notifyStaffMock.mock.calls.at(-1);
  if (!c) throw new Error('notifyStaff was never called — expected a send.');
  return c[0] as NotifyStaffArgs;
}

beforeEach(() => {
  users = [{ ...JANETTE }, { ...MORENA }, { ...BILL }];
  routing = [
    {
      first_approver_id: 'u-jt',
      second_approver_id: 'u-mg',
      fallback_approver_id: null,
      active: true,
    },
    {
      first_approver_id: 'u-mg',
      second_approver_id: 'u-jt',
      fallback_approver_id: null,
      active: true,
    },
  ];
  rows = [reimbursementRow()];
  updates = [];
  sendOverride = null;
  notifyStaffMock.mockClear();
});

// ── D6, direction one: APPROVED → Mary, and only Mary ───────────────────────

describe('D6 approved — Mary is the sole primary recipient, and never the submitter', () => {
  beforeEach(() => {
    rows = [
      reimbursementRow({
        status: 'approved',
        second_approver: { name: MORENA.name },
        second_approved_at: APPROVED_AT,
      }),
    ];
  });

  it('sends to Mary as the SOLE primary recipient', async () => {
    const out = await notifyReimbursementDecided(fakePrisma(), 'r1');

    expect(notifyStaffMock).toHaveBeenCalledTimes(1);
    const call = lastCall();
    expect(call.recipients).toHaveLength(1);
    expect(audienceOf(call)).toEqual([ACCOUNTING_RECIPIENT.toLowerCase()]);
    expect(out.problems).toEqual([]);
  });

  it('is addressed to the ratified accounting mailbox', () => {
    // Operator-ratified 2026-07-30. Pinned so a silent edit cannot redirect
    // reimbursement payment mail without this assertion failing.
    expect(ACCOUNTING_RECIPIENT).toBe('mary.scott@svdp.us');
  });

  it('NEVER tells the submitter — they already know they submitted it', async () => {
    await notifyReimbursementDecided(fakePrisma(), 'r1');

    const audience = audienceOf(lastCall());
    expect(audience).not.toContain(JANETTE.email?.toLowerCase());
    // Not smuggled in as a cc or a reply-to either.
    expect(lastCall().cc ?? []).toHaveLength(0);
  });

  it('does not tell the second approver either — the decision is theirs already', async () => {
    await notifyReimbursementDecided(fakePrisma(), 'r1');
    expect(audienceOf(lastCall())).not.toContain(MORENA.email?.toLowerCase());
  });

  it('carries BOTH signatures and Pacific timestamps, never a bare UTC time', async () => {
    await notifyReimbursementDecided(fakePrisma(), 'r1');
    const body = lastCall().htmlBody;

    expect(body).toContain('Janette Tomas'); // signature one
    expect(body).toContain('Morena Gomez'); // signature two
    expect(body).toContain('PT'); // fleet rule: Pacific, labelled
    expect(body).toMatch(/10:30\s?AM/); // 17:30 UTC rendered as Pacific
    expect(body).not.toContain('2026-07-29T17:30'); // no raw UTC ISO leak
  });

  it('stamps sent_to_accounting_at when it really went somewhere', async () => {
    await notifyReimbursementDecided(fakePrisma(), 'r1');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data['sent_to_accounting_at']).toBeInstanceOf(Date);
  });
});

// ── D6, direction two: REJECTED / HELD → the submitting manager ─────────────

describe('D6 rejected/held — the submitting manager, and Mary is never told', () => {
  it('rejected goes to the submitting manager, with the note', async () => {
    rows = [
      reimbursementRow({
        status: 'rejected',
        decision_note: 'No receipt for the fuel portion.',
        second_approver: { name: MORENA.name },
        second_approved_at: APPROVED_AT,
      }),
    ];

    const out = await notifyReimbursementDecided(fakePrisma(), 'r1');

    expect(audienceOf(lastCall())).toEqual([JANETTE.email?.toLowerCase()]);
    expect(lastCall().htmlBody).toContain('No receipt for the fuel portion.');
    expect(out.problems).toEqual([]);
  });

  it('rejected NEVER copies Mary — nothing is owed, so it would be noise on a pay queue', async () => {
    rows = [reimbursementRow({ status: 'rejected', decision_note: 'Duplicate submission.' })];

    await notifyReimbursementDecided(fakePrisma(), 'r1');

    expect(audienceOf(lastCall())).not.toContain(ACCOUNTING_RECIPIENT.toLowerCase());
  });

  it('held goes to the submitting manager and not to Mary', async () => {
    rows = [reimbursementRow({ status: 'held', decision_note: 'Waiting on the odometer photo.' })];

    await notifyReimbursementDecided(fakePrisma(), 'r1');

    const audience = audienceOf(lastCall());
    expect(audience).toEqual([JANETTE.email?.toLowerCase()]);
    expect(audience).not.toContain(ACCOUNTING_RECIPIENT.toLowerCase());
    expect(lastCall().htmlBody).toContain('Waiting on the odometer photo.');
  });

  it('a refusal never stamps sent_to_accounting_at — accounting was not asked to pay', async () => {
    rows = [reimbursementRow({ status: 'rejected', decision_note: 'Not reimbursable.' })];
    await notifyReimbursementDecided(fakePrisma(), 'r1');
    expect(updates).toHaveLength(0);
  });
});

// ── The submission ask: ONLY the routed second approver ────────────────────

describe('submission — only the routed second approver, never a broadcast', () => {
  it('asks exactly the routed peer, and neither the submitter nor Mary', async () => {
    const out = await notifyReimbursementSubmitted(fakePrisma(), 'r1');

    const audience = audienceOf(lastCall());
    expect(audience).toEqual([MORENA.email?.toLowerCase()]);
    expect(audience).not.toContain(JANETTE.email?.toLowerCase());
    expect(audience).not.toContain(ACCOUNTING_RECIPIENT.toLowerCase());
    expect(out.problems).toEqual([]);
  });

  it('escalates to an admin IMMEDIATELY when the routed peer is the beneficiary, and says why', async () => {
    // Morena submits for Janette. Routing points at Janette — the person being paid.
    rows = [
      reimbursementRow({
        submitted_by: 'u-mg',
        employee_user_id: 'u-jt',
        employee_name_freeform: null,
        employee_user: { name: JANETTE.name },
        submitter: { name: MORENA.name, email: MORENA.email },
      }),
    ];

    await notifyReimbursementSubmitted(fakePrisma(), 'r1');

    const audience = audienceOf(lastCall());
    expect(audience).toEqual([BILL.email?.toLowerCase()]);
    // The beneficiary is not asked to approve their own reimbursement.
    expect(audience).not.toContain(JANETTE.email?.toLowerCase());
    // And the recipient is told WHY it reached them out of band.
    expect(lastCall().htmlBody).toContain('escalated immediately');
    expect(lastCall().htmlBody).toMatch(/person being reimbursed/i);
  });
});

// ── The whole point: an empty audience must be LOUD, never silent ──────────

describe('an empty audience is reported, never shrugged off', () => {
  it('submission with no reachable approver at all: not_sent, and it SAYS SO', async () => {
    // Janette submits for herself-by-name, her peer is excluded, and the only
    // admin is unreachable. There is nobody left to ask.
    users = [
      { ...JANETTE },
      { ...MORENA },
      { ...BILL, email: null }, // admin backstop unreachable
    ];
    rows = [
      reimbursementRow({
        submitted_by: 'u-jt',
        employee_user_id: 'u-mg',
        employee_name_freeform: null,
        employee_user: { name: MORENA.name },
      }),
    ];

    const out = await notifyReimbursementSubmitted(fakePrisma(), 'r1');

    expect(out.mode).toBe('not_sent');
    expect(out.intended).toEqual([]);
    // LOUD: the message must state the consequence in plain words, not a code.
    expect(out.problems.join(' ')).toMatch(/NO reachable second approver/i);
    expect(out.problems.join(' ')).toMatch(/nobody has been asked to sign it/i);
    // It must name the money and the person, so the digest line is actionable.
    expect(out.problems.join(' ')).toContain('$42.35');
    expect(out.problems.join(' ')).toContain('Morena Gomez');
    // And it must NOT have quietly emailed anyone.
    expect(notifyStaffMock).not.toHaveBeenCalled();
  });

  it('approved with a resolved-empty audience: reported, and NOT recorded as sent', async () => {
    rows = [reimbursementRow({ status: 'approved', second_approver: { name: MORENA.name } })];
    sendOverride = { intendedRecipients: [], actualRecipients: [], delivered: 0 };

    const out = await notifyReimbursementDecided(fakePrisma(), 'r1');

    expect(out.problems.join(' ')).toMatch(/no accounting recipient/i);
    expect(out.problems.join(' ')).toMatch(/will not get paid/i);
    // The audit field must not claim a delivery that did not happen. A row that
    // looks paid-and-sent is worse than a clear failure.
    expect(updates).toHaveLength(0);
  });

  it('approved while the transport is disabled: reported, and NOT recorded as sent', async () => {
    rows = [reimbursementRow({ status: 'approved', second_approver: { name: MORENA.name } })];
    sendOverride = { disabled: true, delivered: 0, actualRecipients: [] };

    const out = await notifyReimbursementDecided(fakePrisma(), 'r1');

    expect(out.problems.join(' ')).toMatch(/transport is disabled|could not be sent/i);
    expect(out.problems.join(' ')).toMatch(/has NOT been told/i);
    expect(updates).toHaveLength(0);
  });

  it('a refusal whose submitter has no email address: not_sent, and it names them', async () => {
    rows = [
      reimbursementRow({
        status: 'rejected',
        decision_note: 'No receipt.',
        submitter: { name: JANETTE.name, email: null },
      }),
    ];

    const out = await notifyReimbursementDecided(fakePrisma(), 'r1');

    expect(out.mode).toBe('not_sent');
    expect(out.problems.join(' ')).toContain('Janette Tomas');
    expect(out.problems.join(' ')).toMatch(/no email address/i);
    expect(out.problems.join(' ')).toMatch(/have not been told/i);
    expect(notifyStaffMock).not.toHaveBeenCalled();
  });

  it('a refusal whose transport is disabled is reported, not silent', async () => {
    rows = [reimbursementRow({ status: 'rejected', decision_note: 'No receipt.' })];
    sendOverride = { disabled: true, delivered: 0, actualRecipients: [] };

    const out = await notifyReimbursementDecided(fakePrisma(), 'r1');

    expect(out.problems.join(' ')).toMatch(/could not be sent|transport is disabled/i);
  });

  it('a missing reimbursement is reported rather than returning quietly', async () => {
    rows = [];

    const submitted = await notifyReimbursementSubmitted(fakePrisma(), 'nope');
    const decided = await notifyReimbursementDecided(fakePrisma(), 'nope');

    for (const out of [submitted, decided]) {
      expect(out.mode).toBe('not_sent');
      expect(out.problems).not.toEqual([]);
      expect(out.problems.join(' ')).toContain('nope');
    }
    expect(notifyStaffMock).not.toHaveBeenCalled();
  });

  it('surfaces the resolver problems it was handed, instead of swallowing them', async () => {
    // No routing row for the submitter → the resolver raises a configuration
    // problem AND falls back to the admin. Both must survive the notify layer.
    routing = [];

    const out = await notifyReimbursementSubmitted(fakePrisma(), 'r1');

    expect(out.problems.join(' ')).toMatch(/No active ap_approval_routing row/i);
    expect(audienceOf(lastCall())).toEqual([BILL.email?.toLowerCase()]);
  });
});

// ── Surface identity: the ADR-0047 gate must be consulted with the right key ─

describe('the rollout gate is consulted with the reimbursement surface + real site', () => {
  it('every send names the reimbursement_notify surface and the request site', async () => {
    await notifyReimbursementSubmitted(fakePrisma(), 'r1');
    expect(lastCall().surfaceCode).toBe('reimbursement_notify');
    expect(lastCall().site).toEqual({ id: 'site-w', code: 'woodland' });

    notifyStaffMock.mockClear();
    rows = [reimbursementRow({ status: 'approved', second_approver: { name: MORENA.name } })];
    await notifyReimbursementDecided(fakePrisma(), 'r1');
    expect(lastCall().surfaceCode).toBe('reimbursement_notify');
    expect(lastCall().site).toEqual({ id: 'site-w', code: 'woodland' });
  });
});
