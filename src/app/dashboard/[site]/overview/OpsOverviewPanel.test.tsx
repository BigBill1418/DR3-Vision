// OpsOverviewPanel — rendered-surface contract (ADR-0020 re-enable).
//
// Server component (no client hooks): render to static markup and assert the
// legibility contract the Eugene iPad depends on — every figure has a label AND
// a unit, panels deep-link to their source, and degraded/empty panels render an
// explicit note instead of vanishing (so "zero" is distinguishable from "not
// loaded").

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpsOverviewPanel } from './OpsOverviewPanel';
import type { OpsOverview } from '@/lib/dashboard/ops-overview';

const full: OpsOverview = {
  siteCode: 'eugene',
  siteName: 'Eugene',
  jurisdiction: 'oregon',
  generatedPacific: 'Jul 22, 2026, 1:00 PM',
  todayISO: '2026-07-22',
  loadsActive: 3,
  loadsArrivedToday: 11,
  floor: {
    programOnFloor: 137,
    nonProgramOnFloor: 1152,
    totalOnFloor: 1289,
    anchorPool: 'measured',
    trailingUnitsPerDay: 237,
    programDaysRemaining: 0.58,
    asOfISO: '2026-07-22',
  },
  rates: {
    recycling: {
      metric: 'recycling_rate',
      checkCode: 'r1_recycling_rate',
      ratePct: 78.2,
      priorRatePct: 76.0,
      trendPts: 2.2,
      floorPct: 75,
      warnThresholdPct: 77,
      status: 'ok',
      estimated: false,
      windowStartISO: '2025-10-22',
      windowEndISO: '2026-07-22',
    },
    recovery: {
      metric: 'recovery_rate',
      checkCode: 'r2_recovery_rate',
      ratePct: 69.1,
      priorRatePct: 70.4,
      trendPts: -1.3,
      floorPct: 70,
      warnThresholdPct: 72,
      status: 'high',
      estimated: true,
      windowStartISO: '2025-10-22',
      windowEndISO: '2026-07-22',
    },
  },
  processed: {
    foundToday: true,
    todayISO: '2026-07-22',
    todayClosed: false,
    todayStrippedProgram: 420,
    todayTotalStripped: 511,
    lastClosedISO: '2026-07-21',
  },
  equipment: {
    last7UnitsPerDay: 231.4,
    last30UnitsPerDay: 244.8,
    machineLabel: 'Terex',
    downtimeHours: 6.5,
    costUsd: 1820,
    lastEvent: { dateISO: '2026-07-20', kind: 'downtime', hoursDown: 2 },
  },
  mirrors: [
    {
      feed: 'hauls',
      label: 'Hauls',
      count: 512,
      freshness: { tone: 'ok', relative: '20 min ago', absolutePacific: 'Jul 22, 12:40 PM' },
      lastRunStatus: 'ok',
    },
    {
      feed: 'processed',
      label: 'Processed',
      count: 1290,
      freshness: { tone: 'warn', relative: '3 h ago', absolutePacific: 'Jul 22, 10:00 AM' },
      lastRunStatus: 'ok',
    },
    {
      feed: 'outbound',
      label: 'Outbound',
      count: 264,
      freshness: { tone: 'ok', relative: '20 min ago', absolutePacific: 'Jul 22, 12:40 PM' },
      lastRunStatus: 'ok',
    },
    {
      feed: 'dock',
      label: 'Dock schedule (shared)',
      count: 14,
      freshness: { tone: 'alert', relative: '2 days ago', absolutePacific: 'Jul 20, 9:00 AM' },
      lastRunStatus: null,
      shared: true,
    },
  ],
  commodity: {
    total: 40,
    awaitingInvoice: 12,
    invoiced: 8,
    paid: 18,
    disputed: 2,
    overdueToInvoice: 3,
    overduePaid: 1,
    outstandingUsd: 24500,
  },
  compliance: {
    green: 5,
    yellow: 1,
    red: 1,
    pending: 0,
    metrics: [
      { label: 'MyMRC submission', bucket: 'green', value: 100, unit: '%' },
      { label: 'Dock SLA', bucket: 'yellow', value: 88, unit: '%' },
      { label: 'Recycling rate', bucket: 'red', value: 69, unit: '%' },
    ],
  },
  bonus: {
    periodLabel: 'Period 13 · Jul 9–22, 2026',
    state: 'draft',
    qualifiedCount: 4,
    employeeCount: 6,
    totalUsd: 1240,
  },
};

describe('OpsOverviewPanel', () => {
  it('renders labeled+united figures and deep-links per panel', () => {
    const html = renderToStaticMarkup(<OpsOverviewPanel data={full} />);
    // Today at a glance
    expect(html).toContain('data-testid="ops-overview"');
    expect(html).toContain('On the dock now');
    expect(html).toContain('active loads');
    expect(html).toContain('href="/dashboard/eugene/loads"');
    // Processing close: open state labeled, program units shown
    expect(html).toContain('420 program units stripped');
    expect(html).toContain('href="/admin/processed-units"');
    // Floor total with unit
    expect(html).toContain('1,289');
    expect(html).toContain('units total');
    // Equipment: 7-day + 30-day + downtime + cost, all deep-link to equipment
    expect(html).toContain('units / day');
    expect(html).toContain('Downtime · 30-day');
    expect(html).toContain('href="/dashboard/eugene/equipment"');
    // Rates deep-link into audit findings with the check code
    expect(html).toContain('check=r1_recycling_rate');
    expect(html).toContain('check=r2_recovery_rate');
    // Compliance slate summary + link
    expect(html).toContain('Compliance slate');
    expect(html).toContain('href="/dashboard/eugene/compliance"');
    // Commodity + bonus
    expect(html).toContain('Awaiting invoice');
    expect(html).toContain('shipped &gt; 30 days ago');
    expect(html).toContain('Bonus period');
    expect(html).toContain('href="/bonus"');
    // MyMRC freshness table with per-feed rows + shared badge + Pacific absolute
    expect(html).toContain('data-testid="ov-mirrors-table"');
    expect(html).toContain('data-testid="ov-mirror-dock"');
    expect(html).toContain('all sites');
    expect(html).toContain('2 days ago');
    expect(html).toContain('Jul 22, 10:00 AM');
  });

  it('degrades cleanly: null equipment/commodity/compliance/bonus + empty mirrors', () => {
    const degraded: OpsOverview = {
      ...full,
      loadsActive: 0,
      loadsArrivedToday: 0,
      floor: null,
      rates: null,
      processed: {
        foundToday: false,
        todayISO: '2026-07-22',
        todayClosed: false,
        todayStrippedProgram: null,
        todayTotalStripped: null,
        lastClosedISO: null,
      },
      equipment: null,
      commodity: null,
      compliance: null,
      bonus: null,
      mirrors: [],
    };
    const html = renderToStaticMarkup(<OpsOverviewPanel data={degraded} />);
    expect(html).toContain('Throughput is not available');
    expect(html).toContain('Contract rate tiles are not available');
    expect(html).toContain('Commodity payments are not available');
    expect(html).toContain('Compliance slate is not available');
    expect(html).toContain('MyMRC mirror status is not available');
    // Still renders the shell + a "No entry" processing state, no throw.
    expect(html).toContain('data-testid="ops-overview"');
    expect(html).toContain('No entry');
  });
});
