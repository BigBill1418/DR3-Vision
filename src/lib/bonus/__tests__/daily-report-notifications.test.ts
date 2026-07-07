// ADR-0030 — §10.3 tests for the daily production report render + send layer.
//
// Mocks the two side-effecting modules (`@/lib/m365-mail`, the pino logger).
// Uses the REAL `@/lib/bonus/calculator` so the bonus-dollar column reflects
// the genuine cents→string formatting. The DailyReport is a plain interface;
// we construct fixtures by hand — no prisma, no DB.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (side effects only) ────────────────────────────────────────
const sendSystemEmail = vi.fn();
vi.mock('@/lib/m365-mail', () => ({
  sendSystemEmail: (...args: unknown[]) => sendSystemEmail(...args),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  renderSubject,
  renderHtmlBody,
  sendDailyReport,
} from '@/lib/bonus/daily-report-notifications';
import { calculateDailyBonusCents, formatCents } from '@/lib/bonus/calculator';
import type { DailyReport, ComparisonTotal } from '@/lib/bonus/daily-report';

// ── Fixtures ─────────────────────────────────────────────────────────

// Woodland rule (ADR-0019 §1): 51–74 each $0.50; 75+ adds $0.25.
const WOODLAND_RULE = {
  threshold_low: 50,
  rate_low: 0.5,
  threshold_high: 74,
  rate_high: 0.25,
};

const utc = (y: number, m1: number, d: number) => new Date(Date.UTC(y, m1 - 1, d));

function makeComparison(total: number | null): ComparisonTotal {
  return { startDate: utc(2025, 6, 1), endDate: utc(2025, 6, 16), total };
}

function makeReport(overrides: Partial<DailyReport> = {}): DailyReport {
  const reportDate = utc(2026, 6, 16);
  const m1 = 79; // Jeremy
  const m2 = 60;
  const m3 = 55;
  const lines = [
    {
      employeeId: 'e1',
      fullName: 'Jeremy',
      mattresses: m1,
      bonusCents: calculateDailyBonusCents(m1, WOODLAND_RULE),
      enteredAt: utc(2026, 6, 16),
    },
    {
      employeeId: 'e2',
      fullName: 'Alex',
      mattresses: m2,
      bonusCents: calculateDailyBonusCents(m2, WOODLAND_RULE),
      enteredAt: utc(2026, 6, 16),
    },
    {
      employeeId: 'e3',
      fullName: 'Sam',
      mattresses: m3,
      bonusCents: calculateDailyBonusCents(m3, WOODLAND_RULE),
      enteredAt: utc(2026, 6, 16),
    },
  ];
  const totalToday = lines.reduce((n, l) => n + l.mattresses, 0);
  const totalBonusCents = lines.reduce((n, l) => n + l.bonusCents, 0);
  return {
    siteId: 'site-wld',
    siteCode: 'woodland',
    siteName: 'Woodland',
    reportDate,
    lines,
    totalToday,
    totalBonusCents,
    sameDayLastYear: makeComparison(820),
    mtd: makeComparison(10153),
    priorMonthSamePeriod: makeComparison(9252),
    paceDeltaPct: 9.7,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── §10.3 cases ──────────────────────────────────────────────────────

describe('renderSubject', () => {
  it('substitutes {site} and {date}', () => {
    const report = makeReport();
    const subject = renderSubject(report, '[DR3-Vision] {site} processing — {date}');
    expect(subject).toContain('Woodland');
    expect(subject).toContain('Jun 16, 2026');
    expect(subject).not.toContain('{site}');
    expect(subject).not.toContain('{date}');
  });
});

describe('renderHtmlBody', () => {
  it('includes the "{Site} Daily Production Report" masthead (DR3 not duplicated here)', () => {
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: true,
      includeComparisons: true,
    });
    expect(html).toContain('Woodland Daily Production Report');
    // "DR3" must NOT appear in the masthead title (it leads the subject + footer).
    expect(html).not.toContain('DR3 - Woodland');
  });

  it('uses our own logo asset, not the dead svdp.us/wp-content hotlink (rider 3)', () => {
    const html = renderHtmlBody(makeReport(), { includeBonusDollars: true, includeComparisons: true });
    expect(html).toContain('src="https://dr3-vision.svdp.us/brand/svdp-logo-white.png"');
    expect(html).not.toContain('svdp.us/wp-content');
  });

  it('shows the bonus column when includeBonusDollars: true', () => {
    const report = makeReport();
    const html = renderHtmlBody(report, {
      includeBonusDollars: true,
      includeComparisons: false,
    });
    expect(html).toContain('>Bonus<'); // the Bonus <th>
    // Real calculator output for Jeremy (79) must appear.
    const jeremyBonus = formatCents(calculateDailyBonusCents(79, WOODLAND_RULE));
    expect(html).toContain(jeremyBonus);
    // Footer total bonus.
    expect(html).toContain(formatCents(report.totalBonusCents));
  });

  it('hides the bonus column when includeBonusDollars: false', () => {
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: false,
      includeComparisons: false,
    });
    expect(html).not.toContain('>Bonus<');
    const jeremyBonus = formatCents(calculateDailyBonusCents(79, WOODLAND_RULE));
    expect(html).not.toContain(jeremyBonus);
  });

  it('shows the comparison block when includeComparisons: true', () => {
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: true,
      includeComparisons: true,
    });
    expect(html).toContain('Same day last year');
    expect(html).toContain('Month-to-date');
    expect(html).toContain('Same period last month');
    expect(html).toContain('Pace vs. last month');
  });

  it('omits the comparison block when includeComparisons: false', () => {
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: true,
      includeComparisons: false,
    });
    expect(html).not.toContain('Same day last year');
    expect(html).not.toContain('Month-to-date');
    expect(html).not.toContain('Pace vs. last month');
  });

  it('renders "no previous data available" when a comparison total is null', () => {
    const report = makeReport({ sameDayLastYear: makeComparison(null) });
    const html = renderHtmlBody(report, {
      includeBonusDollars: true,
      includeComparisons: true,
    });
    expect(html).toContain('no previous data available');
  });
});

describe('sendDailyReport', () => {
  const baseArgs = () => ({
    report: makeReport(),
    recipients: ['bill.barnard@svdp.us', 'bethany.cartledge@svdp.us'] as const,
    subjectTemplate: '[DR3-Vision] {site} processing — {date}',
    includeBonusDollars: true,
    includeComparisons: true,
  });

  it('per-recipient partial failure → delivered_count < attempted, no throw', async () => {
    sendSystemEmail.mockImplementation((args: { to: string }) => {
      if (args.to === 'bill.barnard@svdp.us') {
        return Promise.resolve({
          delivered: true,
          disabled: false,
          messageId: 'msg-1',
          retries: 0,
          lastStatus: 202,
        });
      }
      return Promise.resolve({
        delivered: false,
        disabled: false,
        messageId: '',
        retries: 3,
        lastStatus: 502,
      });
    });

    const result = await sendDailyReport(baseArgs());

    expect(result.attempted).toBe(2);
    expect(result.delivered_count).toBe(1);
    expect(result.delivered_count).toBeLessThan(result.attempted);
    expect(sendSystemEmail).toHaveBeenCalledTimes(2);
  });

  it('M365 disabled → delivered_count === 0, no throw', async () => {
    sendSystemEmail.mockResolvedValue({
      delivered: false,
      disabled: true,
      messageId: '',
      retries: 0,
      lastStatus: undefined,
    });

    const result = await sendDailyReport(baseArgs());

    expect(result.attempted).toBe(2);
    expect(result.delivered_count).toBe(0);
  });
});
