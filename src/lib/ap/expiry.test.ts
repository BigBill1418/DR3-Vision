// ADR-0046 §3 amendment (handoff §1.6f) — daily AP-approver expiry reaper:
// removes expired rows with an in-transaction append-only audit row, publishes
// ONE ntfy summary, and no-ops cleanly when nothing is expired.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeApApprover, type FakeDb } from './__testutils__/fake-prisma';

const publishNtfy = vi.fn(async (args?: unknown) => {
  void args;
  return { ok: true, outcome: 'sent' as const };
});

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (args: unknown) => publishNtfy(args) }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runApApproverExpiry } from './expiry';

const NOW = new Date('2026-08-09T00:05:00Z');
const PAST = new Date('2026-08-08T07:00:00Z'); // Kelsey's expiry, extended to 8/8 per rollup §7 (already passed at NOW)
const FUTURE = new Date('2026-12-01T00:00:00Z');

function fp(db: FakeDb): PrismaClient {
  return makeFakePrisma(db) as unknown as PrismaClient;
}

beforeEach(() => {
  publishNtfy.mockClear();
});

describe('runApApproverExpiry', () => {
  it('removes expired approvers, writes an append-only delete audit, and pages once', async () => {
    const approvers: FakeApApprover[] = [
      { id: 'a-morena', user_id: 'u-morena', active_until: null, created_by: 'u-bill' }, // permanent
      { id: 'a-rick', user_id: 'u-rick', active_until: FUTURE, created_by: 'u-bill' }, // active
      { id: 'a-kelsey', user_id: 'u-kelsey', active_until: PAST, created_by: 'u-bill' }, // EXPIRED
    ];
    const db = newFakeDb({ approvers });
    const res = await runApApproverExpiry({ prisma: fp(db), now: NOW });

    expect(res.expired).toBe(1);
    expect(res.userIds).toEqual(['u-kelsey']);
    // only the expired row is gone
    expect(db.approvers.map((a) => a.user_id).sort()).toEqual(['u-morena', 'u-rick']);
    // append-only audit row for the removal
    expect(db.auditLogs).toHaveLength(1);
    const audit = db.auditLogs[0]!;
    expect(audit.action).toBe('delete');
    expect(audit.table_name).toBe('ap_approvers');
    expect(audit.actor_label).toBe('system:ap-approver-expiry');
    expect((audit.before as { user_id: string }).user_id).toBe('u-kelsey');
    // exactly one ntfy summary
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const call = publishNtfy.mock.calls[0]![0] as { topic: string; body: string };
    expect(call.topic).toBe('dr3-vision-system');
    expect(call.body).toContain('u-kelsey');
  });

  it('no-ops cleanly when nothing is expired (no delete, no audit, no page)', async () => {
    const approvers: FakeApApprover[] = [
      { id: 'a-morena', user_id: 'u-morena', active_until: null, created_by: null },
      { id: 'a-rick', user_id: 'u-rick', active_until: FUTURE, created_by: null },
    ];
    const db = newFakeDb({ approvers });
    const res = await runApApproverExpiry({ prisma: fp(db), now: NOW });

    expect(res).toEqual({ expired: 0, userIds: [] });
    expect(db.approvers).toHaveLength(2);
    expect(db.auditLogs).toHaveLength(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('removes multiple expired approvers in one run', async () => {
    const approvers: FakeApApprover[] = [
      { id: 'a1', user_id: 'u-a', active_until: PAST, created_by: null },
      { id: 'a2', user_id: 'u-b', active_until: PAST, created_by: null },
      { id: 'a3', user_id: 'u-c', active_until: null, created_by: null },
    ];
    const db = newFakeDb({ approvers });
    const res = await runApApproverExpiry({ prisma: fp(db), now: NOW });
    expect(res.expired).toBe(2);
    expect(db.approvers.map((a) => a.user_id)).toEqual(['u-c']);
    expect(db.auditLogs).toHaveLength(2);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
  });
});
