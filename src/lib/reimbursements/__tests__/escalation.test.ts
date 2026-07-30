// ADR-0068 D5 (Amendment 2) — the plain 24-hour weekday timeout escalation.
//
// The property that matters most here is NEGATIVE: a reimbursement escalated
// IMMEDIATELY at submit time (routed peer is the beneficiary, ambiguous name, or
// no routing row) must never be re-escalated or double-paged by this scanner.
// `escalated_at IS NULL` is both the candidate filter and the claim condition, so
// that holds structurally — and this file asserts it rather than trusting it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const notifyEscalated = vi.fn(async () => ({ mode: 'live', intended: ['x@y'], problems: [] }));
vi.mock('../notify', () => ({
  notifyReimbursementEscalated: (...a: unknown[]) => notifyEscalated(...(a as [])),
}));

// The weekday clock is the AP one. Stubbed so these tests assert the SCANNER's
// decisions, not the calendar — business-clock has its own suite.
const exceeds = vi.fn(async () => true);
vi.mock('@/lib/ap/business-clock', () => ({
  businessHoursElapsedExceeds: (...a: unknown[]) => exceeds(...(a as [])),
}));

import { runReimbursementEscalationScan } from '../escalation';

const NOW = new Date('2026-07-30T18:00:00.000Z');

const USERS = [
  {
    id: 'u-jt',
    name: 'Janette Tomas',
    email: 'jt@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 's-w',
    deleted_at: null,
  },
  {
    id: 'u-mg',
    name: 'Morena Gomez',
    email: 'mg@svdp.us',
    role: 'manager',
    all_sites: false,
    is_active: true,
    primary_site_id: 's-w',
    deleted_at: null,
  },
  {
    id: 'u-bb',
    name: 'Bill Barnard',
    email: 'bb@svdp.us',
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
    fallback_approver_id: 'u-bb',
    fallback_after_hours: 24,
    active: true,
  },
];

interface Row {
  [k: string]: unknown;
}
let rows: Row[];

function row(over: Row = {}): Row {
  return {
    id: 'rb-1',
    site_id: 's-w',
    status: 'pending_second_approval',
    amount_cents: 4000,
    submitted_by: 'u-jt',
    submitted_at: new Date('2026-07-28T18:00:00.000Z'),
    employee_user_id: null,
    employee_name_freeform: 'Diego Ramirez',
    escalated_at: null,
    escalated_to: null,
    escalation_reason: null,
    ...over,
  };
}

function pick(o: Row, select?: Record<string, unknown>): unknown {
  if (!select) return o;
  const out: Row = {};
  for (const k of Object.keys(select)) out[k] = o[k];
  return out;
}

function fake(): PrismaClient {
  const client = {
    reimbursementRequest: {
      async findMany(
        a: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {},
      ) {
        const w = a.where ?? {};
        return rows
          .filter(
            (r) =>
              (w['status'] === undefined || r['status'] === w['status']) &&
              (w['escalated_at'] !== null || r['escalated_at'] === null),
          )
          .map((r) => pick(r, a.select));
      },
      async updateMany(a: { where: Record<string, unknown>; data: Row }) {
        const r = rows.find(
          (x) =>
            x['id'] === a.where['id'] &&
            x['status'] === a.where['status'] &&
            x['escalated_at'] === null,
        );
        if (!r) return { count: 0 };
        Object.assign(r, a.data);
        return { count: 1 };
      },
    },
    user: {
      async findUnique(a: { where: { id: string }; select?: Record<string, unknown> }) {
        const u = USERS.find((x) => x.id === a.where.id);
        return u ? pick(u as Row, a.select) : null;
      },
      async findMany(
        a: {
          where?: { id?: { in?: string[] }; role?: string };
          select?: Record<string, unknown>;
        } = {},
      ) {
        let out = USERS.slice();
        const ids = a.where?.id?.in;
        if (ids) out = out.filter((u) => ids.includes(u.id));
        if (a.where?.role) out = out.filter((u) => u.role === a.where?.role);
        return out.map((u) => pick(u as Row, a.select));
      },
    },
    apApprovalRouting: {
      async findFirst(a: { where: { first_approver_id: string } }) {
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
  notifyEscalated.mockClear();
  exceeds.mockReset();
  exceeds.mockResolvedValue(true);
});

describe('the timeout escalation', () => {
  it('escalates a row whose weekday clock has run out, ADDITIVELY', async () => {
    const res = await runReimbursementEscalationScan({ prisma: fake(), now: NOW });
    expect(res.escalated).toBe(1);
    expect(rows[0]?.['escalated_at']).toEqual(NOW);
    expect(rows[0]?.['escalation_reason']).toBe('timeout');
    // Escalation is NOT a decision — the row is still awaiting a signature.
    expect(rows[0]?.['status']).toBe('pending_second_approval');
    expect(notifyEscalated).toHaveBeenCalledTimes(1);
  });

  it('does NOTHING when the clock has not run out', async () => {
    exceeds.mockResolvedValue(false);
    const res = await runReimbursementEscalationScan({ prisma: fake(), now: NOW });
    expect(res.escalated).toBe(0);
    expect(rows[0]?.['escalated_at']).toBeNull();
    expect(notifyEscalated).not.toHaveBeenCalled();
  });

  // ── THE headline: no double-escalation of the immediate path ───────────────
  it('NEVER re-escalates a row escalated IMMEDIATELY at submit time', async () => {
    // Beneficiary conflict: `submitReimbursement` already stamped escalated_at.
    rows = [
      row({
        escalated_at: new Date('2026-07-28T18:00:01.000Z'),
        escalation_reason: 'beneficiary_conflict',
        escalated_to: 'u-bb',
      }),
    ];
    const res = await runReimbursementEscalationScan({ prisma: fake(), now: NOW });

    expect(res.scanned).toBe(0);
    expect(res.escalated).toBe(0);
    expect(notifyEscalated).not.toHaveBeenCalled();
    // And the original reason is intact — not overwritten with 'timeout'.
    expect(rows[0]?.['escalation_reason']).toBe('beneficiary_conflict');
  });

  it('is IDEMPOTENT — a second run claims nothing and notifies nobody', async () => {
    const p = fake();
    await runReimbursementEscalationScan({ prisma: p, now: NOW });
    notifyEscalated.mockClear();
    const second = await runReimbursementEscalationScan({ prisma: p, now: NOW });
    expect(second.escalated).toBe(0);
    expect(notifyEscalated).not.toHaveBeenCalled();
  });

  it('does NOT relax the control — the submitter is still excluded after widening', async () => {
    await runReimbursementEscalationScan({ prisma: fake(), now: NOW });
    expect(rows[0]?.['escalated_to']).not.toBe('u-jt');
  });

  it('reports LOUDLY and does not stamp when nobody is reachable to escalate to', async () => {
    // Bill submits for himself and is the only admin: after widening there is
    // still nobody who is neither submitter nor beneficiary.
    rows = [row({ submitted_by: 'u-bb', employee_user_id: 'u-bb', employee_name_freeform: null })];
    const res = await runReimbursementEscalationScan({ prisma: fake(), now: NOW });

    expect(res.escalated).toBe(0);
    // Left NULL on purpose so the next run retries once the roster is fixed —
    // stamping it would mark an unpayable row "handled" forever.
    expect(rows[0]?.['escalated_at']).toBeNull();
    expect(res.problems.join(' ')).toMatch(/NO reachable approver|nobody to escalate/i);
  });

  it('one poisoned row does not strand the rest of the backlog', async () => {
    rows = [row({ id: 'rb-bad', submitted_at: null }), row({ id: 'rb-ok' })];
    const res = await runReimbursementEscalationScan({ prisma: fake(), now: NOW });
    // The good row still escalated.
    expect(res.requestIds).toContain('rb-ok');
    expect(res.problems.length).toBeGreaterThan(0);
  });
});
