// ADR-0068 D4 — the decision path refuses the submitter and the beneficiary.
//
// `routing.test.ts` proves the EXCLUSION LOGIC. These tests prove the DECISION
// PATH actually consults it — that the gate is wired, not merely present. Both
// halves matter: a correct resolver nobody calls is exactly the shape of the
// ADR-0066 outage, where authorization and notification each worked in isolation
// and disagreed in production.
//
// A purpose-built fake rather than the shared AP one: `reimbursementRequest` is
// not in that harness, and widening a fixture used by dozens of AP tests to
// serve two new ones is how a shared fake becomes a liability.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  decideReimbursement,
  ReimbursementAlreadyDecidedError,
  ReimbursementNotEligibleError,
  ReimbursementNoteRequiredError,
} from '../service';

vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const NOW = new Date('2026-07-29T20:00:00.000Z');

const USERS = [
  {
    id: 'u-jt',
    name: 'Janette Tomas',
    email: 'janette.tomas@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 'site-w',
    deleted_at: null,
  },
  {
    id: 'u-mg',
    name: 'Morena Gomez',
    email: 'morena.gomez@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 'site-w',
    deleted_at: null,
  },
  {
    id: 'u-bb',
    name: 'Bill Barnard',
    email: 'bill.barnard@svdp.us',
    role: 'admin',
    all_sites: true,
    is_active: true,
    primary_site_id: null,
    deleted_at: null,
  },
];

const ROUTING = [
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

interface Row {
  id: string;
  site_id: string;
  status: string;
  amount_cents: number;
  submitted_by: string;
  employee_user_id: string | null;
  employee_name_freeform: string | null;
  second_approver_id: string | null;
  second_approved_at: Date | null;
  decision_note: string | null;
  escalated_at: Date | null;
}

let rows: Row[];

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'r1',
    site_id: 'site-w',
    status: 'pending_second_approval',
    amount_cents: 4000,
    submitted_by: 'u-jt',
    employee_user_id: null,
    employee_name_freeform: 'Diego Ramirez',
    second_approver_id: null,
    second_approved_at: null,
    decision_note: null,
    escalated_at: null,
    ...over,
  };
}

function pick<T extends object>(o: T, select?: Record<string, unknown>): unknown {
  if (!select) return o;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) out[k] = (o as Record<string, unknown>)[k];
  return out;
}

function fake(): PrismaClient {
  const client = {
    reimbursementRequest: {
      async findUnique(a: { where: { id: string }; select?: Record<string, unknown> }) {
        const r = rows.find((x) => x.id === a.where.id);
        return r ? pick(r, a.select) : null;
      },
      async updateMany(a: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) {
        const r = rows.find(
          (x) =>
            x.id === a.where.id && (a.where.status === undefined || x.status === a.where.status),
        );
        if (!r) return { count: 0 };
        Object.assign(r, a.data);
        return { count: 1 };
      },
      async update(a: { where: { id: string }; data: Record<string, unknown> }) {
        const r = rows.find((x) => x.id === a.where.id);
        if (r) Object.assign(r, a.data);
        return r;
      },
    },
    user: {
      async findUnique(a: { where: { id: string }; select?: Record<string, unknown> }) {
        const u = USERS.find((x) => x.id === a.where.id);
        return u ? pick(u, a.select) : null;
      },
      async findMany(a: {
        where?: { id?: { in?: string[] }; role?: string; is_active?: boolean };
        select?: Record<string, unknown>;
      }) {
        let out = USERS.slice();
        const ids = a.where?.id?.in;
        if (ids) out = out.filter((u) => ids.includes(u.id));
        if (a.where?.role) out = out.filter((u) => u.role === a.where?.role);
        if (a.where?.is_active !== undefined) out = out.filter((u) => u.is_active);
        return out.map((u) => pick(u, a.select));
      },
    },
    apApprovalRouting: {
      async findFirst(a: { where: { first_approver_id: string; active?: boolean } }) {
        return ROUTING.find((r) => r.first_approver_id === a.where.first_approver_id) ?? null;
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
  };
  return client as unknown as PrismaClient;
}

beforeEach(() => {
  rows = [row()];
});

describe('decideReimbursement — the gate is WIRED, not merely present', () => {
  it('REFUSES the submitter, and says why in plain words', async () => {
    // The exact case Mary reported.
    const err = await decideReimbursement({
      prisma: fake(),
      requestId: 'r1',
      decision: 'approved',
      actor: { userId: 'u-jt', role: 'manager' },
      now: NOW,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReimbursementNotEligibleError);
    // "Not authorized" sends an operator hunting. The truth is more useful.
    expect((err as Error).message).toMatch(/submitted this reimbursement/i);
    // And nothing moved.
    expect(rows[0]?.status).toBe('pending_second_approval');
    expect(rows[0]?.second_approver_id).toBeNull();
  });

  it('REFUSES the beneficiary, even though routing points at them', async () => {
    rows = [row({ submitted_by: 'u-mg', employee_user_id: 'u-jt', employee_name_freeform: null })];

    const err = await decideReimbursement({
      prisma: fake(),
      requestId: 'r1',
      decision: 'approved',
      actor: { userId: 'u-jt', role: 'manager' },
      now: NOW,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReimbursementNotEligibleError);
    expect((err as Error).message).toMatch(/pays you/i);
    expect(rows[0]?.status).toBe('pending_second_approval');
  });

  it('ALLOWS the routed peer, and records BOTH signatures', async () => {
    const res = await decideReimbursement({
      prisma: fake(),
      requestId: 'r1',
      decision: 'approved',
      actor: { userId: 'u-mg', role: 'manager' },
      now: NOW,
    });

    expect(res.decision).toBe('approved');
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.second_approver_id).toBe('u-mg');
    expect(rows[0]?.second_approved_at).toEqual(NOW);
    // Signature one is still attributable — two different people, on the record.
    expect(rows[0]?.submitted_by).toBe('u-jt');
  });

  it('refuses an admin who submitted it — the exclusion is about the PERSON', async () => {
    rows = [row({ submitted_by: 'u-bb' })];
    const err = await decideReimbursement({
      prisma: fake(),
      requestId: 'r1',
      decision: 'approved',
      actor: { userId: 'u-bb', role: 'admin' },
      now: NOW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReimbursementNotEligibleError);
  });
});

describe('a refusal must say why', () => {
  it('rejects a REJECT with no note', async () => {
    await expect(
      decideReimbursement({
        prisma: fake(),
        requestId: 'r1',
        decision: 'rejected',
        actor: { userId: 'u-mg', role: 'manager' },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ReimbursementNoteRequiredError);
  });

  it('rejects a HOLD with a whitespace-only note', async () => {
    await expect(
      decideReimbursement({
        prisma: fake(),
        requestId: 'r1',
        decision: 'held',
        actor: { userId: 'u-mg', role: 'manager' },
        note: '   ',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ReimbursementNoteRequiredError);
  });

  it('accepts a REJECT with a note and stores it', async () => {
    await decideReimbursement({
      prisma: fake(),
      requestId: 'r1',
      decision: 'rejected',
      actor: { userId: 'u-mg', role: 'manager' },
      note: 'No receipt for the fuel portion.',
      now: NOW,
    });
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.decision_note).toBe('No receipt for the fuel portion.');
  });
});

describe('first action wins', () => {
  it('tells the loser who won instead of overwriting the decision', async () => {
    const p = fake();
    await decideReimbursement({
      prisma: p,
      requestId: 'r1',
      decision: 'approved',
      actor: { userId: 'u-mg', role: 'manager' },
      now: NOW,
    });

    const err = await decideReimbursement({
      prisma: p,
      requestId: 'r1',
      decision: 'rejected',
      actor: { userId: 'u-bb', role: 'admin' },
      note: 'changed my mind',
      now: NOW,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReimbursementAlreadyDecidedError);
    expect((err as Error).message).toMatch(/already approved by Morena Gomez/i);
    // The winner's decision stands.
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.second_approver_id).toBe('u-mg');
  });
});
