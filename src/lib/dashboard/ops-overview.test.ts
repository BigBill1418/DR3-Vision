// Operations Dashboard aggregation — pure-helper contract (ADR-0020).
//
// Covers the two pieces of net-new logic in ops-overview that are pure and
// deterministic: freshness grading (the "is MyMRC stale" signal the operator
// reads) and commodity aging bucketing. The orchestration (`computeOpsOverview`)
// is I/O over already-tested source modules, verified via the rendered surface
// in OpsOverviewPanel.test.tsx.

import { describe, it, expect } from 'vitest';
import { describeFreshness, bucketCommodityAging } from './ops-overview';

const NOW = new Date('2026-07-22T20:00:00.000Z'); // 1:00 PM PDT

describe('describeFreshness', () => {
  it('null last-seen is an alert, "never synced", no absolute time', () => {
    const f = describeFreshness(null, NOW);
    expect(f.tone).toBe('alert');
    expect(f.relative).toBe('never synced');
    expect(f.absolutePacific).toBeNull();
  });

  it('under 2h reads OK with a minutes/hours relative and a Pacific absolute', () => {
    const fresh = describeFreshness(new Date(NOW.getTime() - 12 * 60_000), NOW);
    expect(fresh.tone).toBe('ok');
    expect(fresh.relative).toBe('12 min ago');
    expect(fresh.absolutePacific).toBeTruthy();

    const hour = describeFreshness(new Date(NOW.getTime() - 90 * 60_000), NOW);
    expect(hour.tone).toBe('ok');
    expect(hour.relative).toBe('1 h ago');
  });

  it('2h–8h is a warn; beyond 8h is an alert; multi-day reads in days', () => {
    expect(describeFreshness(new Date(NOW.getTime() - 3 * 3_600_000), NOW).tone).toBe('warn');
    expect(describeFreshness(new Date(NOW.getTime() - 10 * 3_600_000), NOW).tone).toBe('alert');
    const twoDays = describeFreshness(new Date(NOW.getTime() - 50 * 3_600_000), NOW);
    expect(twoDays.tone).toBe('alert');
    expect(twoDays.relative).toBe('2 days ago');
  });
});

describe('bucketCommodityAging', () => {
  it('counts by status and flags aging thresholds (30d ship, 45d invoiced)', () => {
    const rows = [
      {
        status: 'awaiting_invoice' as const,
        daysSinceShip: 40,
        daysSinceInvoiced: null,
        expectedAmount: '1000.00',
      },
      {
        status: 'awaiting_invoice' as const,
        daysSinceShip: 5,
        daysSinceInvoiced: null,
        expectedAmount: '250.00',
      },
      {
        status: 'invoiced' as const,
        daysSinceShip: 60,
        daysSinceInvoiced: 50,
        expectedAmount: '500.00',
      },
      {
        status: 'paid' as const,
        daysSinceShip: 90,
        daysSinceInvoiced: 80,
        expectedAmount: '999.00',
      },
      {
        status: 'disputed' as const,
        daysSinceShip: 20,
        daysSinceInvoiced: null,
        expectedAmount: '75.50',
      },
    ];
    const a = bucketCommodityAging(rows);
    expect(a.total).toBe(5);
    expect(a.awaitingInvoice).toBe(2);
    expect(a.invoiced).toBe(1);
    expect(a.paid).toBe(1);
    expect(a.disputed).toBe(1);
    expect(a.overdueToInvoice).toBe(1); // only the 40-day awaiting row
    expect(a.overduePaid).toBe(1); // the 50-day-invoiced row
    // Outstanding excludes the paid row: 1000 + 250 + 500 + 75.50
    expect(a.outstandingUsd).toBeCloseTo(1825.5, 2);
  });

  it('empty input yields all-zero buckets', () => {
    const a = bucketCommodityAging([]);
    expect(a).toEqual({
      total: 0,
      awaitingInvoice: 0,
      invoiced: 0,
      paid: 0,
      disputed: 0,
      overdueToInvoice: 0,
      overduePaid: 0,
      outstandingUsd: 0,
    });
  });
});
