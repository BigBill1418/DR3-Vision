// ADR-0126 D6 — the AP queue LIST surfaces a decided-but-unmailed request.
//
// Before this, "decision email NOT confirmed sent" existed only inside ONE
// request's detail pane. Finding the two orphaned rejections through that surface
// would have meant opening every decided request one at a time; nobody does that,
// which is why nobody did, and both sat silent (one for nineteen days).
//
// The shared `__testutils__/fake-prisma` has no `groupBy` and no `_count` select,
// so this uses a purpose-built double for `listApRequests` rather than growing the
// shared fake for one read model.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  DECISION_MAIL_UNSENT_FILTER,
  isApListFilter,
  listApRequests,
  type ApListFilter,
} from './queue';

interface Row {
  id: string;
  status: string;
  decision_mail_sent_at: Date | null;
}

/** Captures the `where` each call received so the filter can be asserted. */
function stubPrisma(rows: Row[]) {
  const seen: { findManyWhere?: unknown; countWhere?: unknown } = {};
  const matches = (r: Row, where: Record<string, unknown> | undefined): boolean => {
    if (!where || Object.keys(where).length === 0) return true;
    const status = where['status'] as string | { in?: string[] } | undefined;
    if (typeof status === 'string' && r.status !== status) return false;
    if (status && typeof status === 'object' && !status.in?.includes(r.status)) return false;
    if (where['decision_mail_sent_at'] === null && r.decision_mail_sent_at !== null) return false;
    return true;
  };
  const prisma = {
    apRequest: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        seen.findManyWhere = args.where;
        return rows
          .filter((r) => matches(r, args.where))
          .map((r) => ({
            id: r.id,
            status: r.status,
            subject: `Invoice ${r.id}`,
            sender_address: 'ap@svdp.us',
            sender_validated: true,
            received_at: new Date('2026-08-19T18:00:00.000Z'),
            vendor: null,
            amount_cents: null,
            held_by: null,
            hold_note: null,
            decision_mail_sent_at: r.decision_mail_sent_at,
            _count: { attachments: 0, followups: 0 },
          }));
      },
      groupBy: async () => [],
      count: async (args: { where?: Record<string, unknown> }) => {
        seen.countWhere = args.where;
        return rows.filter((r) => matches(r, args.where)).length;
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, seen };
}

const unmailed = (id: string, status = 'rejected'): Row => ({
  id,
  status,
  decision_mail_sent_at: null,
});
const mailed = (id: string, status = 'approved'): Row => ({
  id,
  status,
  decision_mail_sent_at: new Date('2026-08-19T18:05:00.000Z'),
});

describe('AP queue list — decisionMailUnsent badge (ADR-0126 D6)', () => {
  it('flags a decided row with no confirmed decision email', async () => {
    const { prisma } = stubPrisma([unmailed('req-a')]);
    const { rows } = await listApRequests('all', prisma);
    expect(rows[0]?.decisionMailUnsent).toBe(true);
  });

  it('does NOT flag a decided row whose mail was confirmed sent', async () => {
    const { prisma } = stubPrisma([mailed('req-b')]);
    const { rows } = await listApRequests('all', prisma);
    expect(rows[0]?.decisionMailUnsent).toBe(false);
  });

  it('does NOT flag work that is still open', async () => {
    // A pending row has a null stamp too — the badge must key on the DECISION,
    // not on the absence of a timestamp, or the whole queue lights up red.
    const { prisma } = stubPrisma([
      unmailed('req-c', 'pending'),
      unmailed('req-d', 'pending_review'),
      unmailed('req-e', 'pending_second_approval'),
      unmailed('req-f', 'quarantined'),
    ]);
    const { rows } = await listApRequests('all', prisma);
    expect(rows.map((r) => r.decisionMailUnsent)).toEqual([false, false, false, false]);
  });

  it('counts the stuck rows on EVERY load, even from an unrelated tab', async () => {
    // The tab only renders when the count is non-zero, so the count has to be
    // known before anyone thinks to open it.
    const { prisma } = stubPrisma([unmailed('req-a'), unmailed('req-b'), mailed('req-c')]);
    const { counts } = await listApRequests('pending', prisma);
    expect(counts[DECISION_MAIL_UNSENT_FILTER]).toBe(2);
  });

  it('the dedicated filter returns exactly the stuck rows', async () => {
    const { prisma, seen } = stubPrisma([
      unmailed('req-a'),
      mailed('req-b'),
      unmailed('req-c', 'pending'),
    ]);
    const { rows } = await listApRequests(DECISION_MAIL_UNSENT_FILTER, prisma);
    expect(rows.map((r) => r.id)).toEqual(['req-a']);
    // It queries the shared predicate rather than a status, which is the point:
    // the view cuts ACROSS approved + rejected.
    expect(seen.findManyWhere).toEqual({
      status: { in: ['approved', 'rejected'] },
      decision_mail_sent_at: null,
    });
  });

  it('accepts the new filter value at the API boundary', async () => {
    expect(isApListFilter(DECISION_MAIL_UNSENT_FILTER)).toBe(true);
    expect(isApListFilter('all')).toBe(true);
    expect(isApListFilter('nonsense')).toBe(false);
    expect(isApListFilter(null)).toBe(false);
  });

  it('leaves the ordinary status filters untouched', async () => {
    const { prisma, seen } = stubPrisma([unmailed('req-a', 'pending')]);
    await listApRequests('pending' as ApListFilter, prisma);
    expect(seen.findManyWhere).toEqual({ status: 'pending' });
  });
});
