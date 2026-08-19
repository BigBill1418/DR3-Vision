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
  renderEodInventoryHtml,
  sendDailyReport,
} from '@/lib/bonus/daily-report-notifications';
import { calculateDailyBonusCents, formatCents } from '@/lib/bonus/calculator';
import type { DailyReport, ComparisonTotal } from '@/lib/bonus/daily-report';
import type { EodInventorySnapshot } from '@/lib/loads/eod-inventory';

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
    // ADR-0076 — headcount defaults for the fixture (today mirrors lines.length).
    processorCounts: { today: 3, mtd: 5, priorMonthSamePeriod: 4, sameDayLastYear: 2 },
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
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: true,
      includeComparisons: true,
    });
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

// ── ADR-0037 Phase 4 (spec §4) — End-of-Day Inventory section ────────

const REPORT_DAY = utc(2026, 7, 22);

function makeEod(overrides: Partial<EodInventorySnapshot> = {}): EodInventorySnapshot {
  return {
    siteId: 'site-wld',
    reportDate: REPORT_DAY,
    state: 'healthy',
    programOnHand: 3748,
    nonProgramOnHand: 229,
    totalOnHand: 3977,
    deltaFromYesterday: -142,
    programDelta: -122,
    nonProgramDelta: -20,
    programPct: 94.2,
    nonProgramPct: 5.8,
    anchor: {
      countedAt: new Date(Date.UTC(2026, 6, 22, 17, 0, 0)),
      poolAttribution: 'measured',
      daysSince: 0,
      counter: 'Morena',
    },
    flowThrough: REPORT_DAY,
    movementToday: true,
    inboundProvisional: false,
    // handoff #270 §4b — a HEALTHY default: intake arrived on the report day, so
    // the base fixture carries no suspicion flag and every existing expectation
    // about the healthy panel keeps measuring what it always did.
    inboundThrough: REPORT_DAY,
    inboundDaysSince: 0,
    inboundStale: false,
    staleDays: 14,
    inboundStaleDays: 4,
    ...overrides,
  };
}

function bodyWithEod(eod: EodInventorySnapshot | undefined): string {
  return renderHtmlBody(makeReport({ eodInventory: eod }), {
    includeBonusDollars: false,
    includeComparisons: false,
  });
}

// ── handoff #270 §4 — a wrong on-hand can never render silently ─────────────
//
// The disease this closes: the panel printed a confident figure no matter how
// starved its inputs were. Woodland's −5,401 (July) and −2,439 (August) went out
// on the production report as though someone had measured them.
//
// Two shapes, deliberately different:
//   NEGATIVE     — impossible. The figure is REPLACED by a diagnostic. The
//                  load-bearing assertion is the absence one: the bare number
//                  must not appear anywhere in the body.
//   INTAKE STALE — the figure is still the best available, so it RENDERS, with a
//                  flag saying why it is suspect.
describe('renderHtmlBody — EOD inventory, negative floor (§4a)', () => {
  /** A floor that has walked negative behind a fresh, measured, same-day anchor —
   *  the worst case, because everything about the anchor looks trustworthy. */
  const negativeEod = () =>
    makeEod({
      state: 'negative',
      programOnHand: -2439,
      nonProgramOnHand: 512,
      totalOnHand: -1927,
      programPct: null,
      nonProgramPct: null,
      inboundThrough: utc(2026, 7, 9),
      inboundDaysSince: 13,
      inboundStale: true,
    });

  // ── FALSIFICATION (banner) ──────────────────────────────────────────────
  // Verified by hand against the pre-fix renderer (no `negative` branch, so this
  // fixture fell through to the healthy path): the banner assertions failed with
  // `expected '…' to contain 'On-hand is computing negative'`, and the ABSENCE
  // assertions below failed because the body really did contain '−2,439'.
  it('renders the LOUD banner instead of the figures', () => {
    const html = bodyWithEod(negativeEod());
    expect(html).toContain('On-hand is computing negative');
    expect(html).toContain('2,439'); // the magnitude, inside the sentence
    expect(html).toContain('This figure is not reliable');
  });

  it('explains WHY — the intake age, not just that it is broken', () => {
    const html = bodyWithEod(negativeEod());
    expect(html).toContain('Intake data is incomplete');
    expect(html).toContain('13 days old');
  });

  // THE assertion of this whole concern. A banner that appears NEXT TO the bare
  // negative has changed nothing: the number still gets read, quoted and pasted.
  //
  // Scoped to the PANEL, not the whole body, so the claim is precise. The
  // magnitude does appear once, inside the sentence "computing negative (−2,439)"
  // — that is the diagnostic, and the handoff asks for it explicitly. What must
  // not exist is the figure in a VALUE position: a labelled row, a bold figure, a
  // tabular-numeral cell. Those are what get read as a measurement.
  it('does NOT render the negative in any value position', () => {
    const panel = renderEodInventoryHtml(negativeEod(), 'Woodland');

    // No labelled figure rows at all.
    expect(panel).not.toContain('Program units on hand');
    expect(panel).not.toContain('Non-program units on hand');
    expect(panel).not.toContain('Total on hand');
    // No right-aligned tabular-numeral cells — the panel's figure-cell signature.
    expect(panel).not.toContain('tabular-nums');
    // No derived figures computed off a broken floor.
    expect(panel).not.toContain('Change from yesterday');
    expect(panel).not.toContain('Program / non-program split');

    // The magnitude appears EXACTLY ONCE, and it is inside the diagnostic sentence.
    expect(panel.split('2,439').length - 1).toBe(1);
    expect(panel).toContain('computing negative (−2,439)');
  });

  // Proves the assertion above is not true-by-construction. The SAME renderer,
  // the SAME fixture shape, positive figures: every marker claimed absent above is
  // demonstrably present on a healthy floor. Without this control, "does not
  // contain 'Total on hand'" would also pass on an empty string.
  it('(control) every one of those markers DOES render on a healthy floor', () => {
    const panel = renderEodInventoryHtml(makeEod(), 'Woodland');
    expect(panel).toContain('Program units on hand');
    expect(panel).toContain('Non-program units on hand');
    expect(panel).toContain('Total on hand');
    expect(panel).toContain('tabular-nums');
    expect(panel).toContain('Change from yesterday');
    expect(panel).toContain('Program / non-program split');
  });

  it('still names the anchor, so the reader knows how to fix it', () => {
    const html = bodyWithEod(negativeEod());
    expect(html).toContain('Last physical count');
    expect(html).toContain('A physical count resets the floor');
  });

  it('a NEGATIVE PROGRAM pool inside a positive total is still banner-worthy', () => {
    // MRC bills on program units, so this is a billing-grade error that a
    // total-only check would wave straight through.
    const panel = renderEodInventoryHtml(
      makeEod({ state: 'negative', programOnHand: -300, nonProgramOnHand: 1200, totalOnHand: 900 }),
      'Woodland',
    );
    expect(panel).toContain('On-hand is computing negative');
    expect(panel).toContain('(−300)'); // the worst pool, not the positive total
    expect(panel).not.toContain('Program units on hand');
  });

  it('falls back to a truthful line when the site has NO inbound on record', () => {
    // Eugene's standing condition. Asserting "0 days old" here would read as
    // though intake were perfectly healthy, which is the opposite of the truth.
    const html = bodyWithEod(
      makeEod({ state: 'negative', totalOnHand: -5, inboundThrough: null, inboundDaysSince: null }),
    );
    expect(html).toContain('no inbound has ever been recorded');
    expect(html).not.toContain('days old');
  });

  // ADR-0058 §3.3 gates its "estimated floor after today" block on
  // `state === 'healthy'`, so the new state suppresses it for free. Pinned,
  // because the alternative is projecting tomorrow's floor off a broken one.
  it('suppresses the ADR-0058 estimated-floor block', () => {
    const html = bodyWithEod(negativeEod());
    expect(html).not.toContain('Estimated floor after today');
  });
});

describe('renderHtmlBody — EOD inventory, stale intake (§4b)', () => {
  it('renders the number WITH a why-suspect flag when intake has gone quiet', () => {
    const html = bodyWithEod(makeEod({ inboundStale: true, inboundDaysSince: 9 }));
    // The figure still renders — this is the best available number, unlike §4a.
    expect(html).toContain('3,748');
    expect(html).toContain('Intake feed is quiet');
    expect(html).toContain('9 days old');
    expect(html).toContain('trends low until intake catches up');
  });

  it('names the tolerance it breached, so the flag is auditable', () => {
    const html = bodyWithEod(makeEod({ inboundStale: true, inboundDaysSince: 9 }));
    expect(html).toContain('4-day tolerance');
  });

  it('renders NO flag when intake is current', () => {
    const html = bodyWithEod(makeEod({ inboundStale: false, inboundDaysSince: 0 }));
    expect(html).not.toContain('Intake feed is quiet');
  });
});

describe('renderHtmlBody — EOD inventory', () => {
  it('HEALTHY renders the figures, delta, split, count date and counter', () => {
    const html = bodyWithEod(makeEod());
    expect(html).toContain('End-of-Day Inventory — Woodland');
    expect(html).toContain('Program units on hand');
    expect(html).toContain('3,748');
    expect(html).toContain('229');
    expect(html).toContain('3,977');
    expect(html).toContain('142'); // change from yesterday
    expect(html).toContain('net outbound');
    expect(html).toContain('94.2% / 5.8%');
    expect(html).toContain('Jul 22, 2026 (today)');
    expect(html).toContain('Morena');
    expect(html).not.toContain('Inventory pending physical count');
  });

  it('ADR-0059: HEALTHY shows the provisional-inbound label only when inboundProvisional is true', () => {
    const provisional = bodyWithEod(makeEod({ inboundProvisional: true }));
    expect(provisional).toContain('Inbound: provisional');
    expect(provisional).toContain('pending floor confirmation');

    const confirmed = bodyWithEod(makeEod({ inboundProvisional: false }));
    expect(confirmed).not.toContain('Inbound: provisional');
    // The honesty footer still explains what "provisional" means in either case.
    expect(confirmed).toContain('not yet floor-confirmed');
  });

  it('HEALTHY renders a `${date}T00:00:00Z` count date as its own day, not the prior day', () => {
    // Regression (finding 4): the manager API writes snapshot_at at UTC midnight. Rendering
    // that @db.Date key in the Pacific zone printed the PREVIOUS day (e.g. "Jul 21").
    const html = bodyWithEod(
      makeEod({
        anchor: {
          countedAt: new Date('2026-07-22T00:00:00Z'),
          poolAttribution: 'measured',
          daysSince: 0,
          counter: 'Morena',
        },
      }),
    );
    expect(html).toContain('Jul 22, 2026 (today)');
    expect(html).not.toContain('Jul 21, 2026');
  });

  it('HEALTHY labels a positive delta as net inbound', () => {
    const html = bodyWithEod(makeEod({ deltaFromYesterday: 88 }));
    expect(html).toContain('net inbound');
    expect(html).not.toContain('net outbound');
  });

  it('STALE renders the warning band with the last anchor + age, and NO figures', () => {
    const html = bodyWithEod(
      makeEod({
        state: 'stale',
        anchor: {
          countedAt: new Date(Date.UTC(2026, 5, 30, 17, 0, 0)),
          poolAttribution: 'measured',
          daysSince: 22,
          counter: 'Morena',
        },
      }),
    );
    expect(html).toContain('Inventory pending physical count');
    expect(html).toContain('Jun 30, 2026');
    expect(html).toContain('22 days ago');
    expect(html).toContain('verify with a floor count');
    // The healthy-state format must NEVER appear behind a stale anchor.
    expect(html).not.toContain('Program units on hand');
    expect(html).not.toContain('3,748');
    expect(html).not.toContain('94.2% / 5.8%');
  });

  it('STALE with no anchor at all still refuses the healthy format', () => {
    const html = bodyWithEod(makeEod({ state: 'stale', anchor: null }));
    expect(html).toContain('Inventory pending physical count');
    expect(html).toContain('No physical count on record');
    expect(html).not.toContain('Program units on hand');
  });

  it('ZERO (pre-backfill) renders a neutral band, not a stale alarm', () => {
    const html = bodyWithEod(
      makeEod({
        state: 'zero',
        programOnHand: 0,
        nonProgramOnHand: 0,
        totalOnHand: 0,
        deltaFromYesterday: 0,
        programDelta: 0,
        nonProgramDelta: 0,
        programPct: null,
        nonProgramPct: null,
        anchor: null,
      }),
    );
    expect(html).toContain('End-of-Day Inventory — Woodland');
    expect(html).toContain('No inventory activity recorded yet');
    expect(html).not.toContain('Inventory pending physical count');
    expect(html).not.toContain('Program units on hand');
  });

  it('omits the section entirely when the inventory read was unavailable', () => {
    const html = bodyWithEod(undefined);
    expect(html).not.toContain('End-of-Day Inventory');
  });

  it('escapes the counter name (the one untrusted string in the panel)', () => {
    const html = bodyWithEod(
      makeEod({
        anchor: {
          countedAt: new Date(Date.UTC(2026, 6, 22, 17, 0, 0)),
          poolAttribution: 'measured',
          daysSince: 0,
          counter: '<script>x</script>',
        },
      }),
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('HEALTHY carries the on-hand caveat (reconciled floor, not a live net position)', () => {
    const html = bodyWithEod(makeEod());
    expect(html).toContain('On-hand is the reconciled floor from the last physical count');
    expect(html).toContain('not reflected in this number');
  });
});

// ADR-0058 §3.3 — same-day production vs. inventory reconciliation (mirror-lag).
describe("renderHtmlBody — Today's Production vs. Inventory (ADR-0058 §3.3)", () => {
  // A fresh measured anchor whose data does NOT yet reflect today's production
  // (movementToday false = the mirror-lag case this section exists for).
  const laggingEod = (over: Partial<EodInventorySnapshot> = {}): EodInventorySnapshot =>
    makeEod({
      programOnHand: 1597,
      nonProgramOnHand: 886,
      totalOnHand: 2483,
      movementToday: false,
      anchor: {
        countedAt: new Date('2026-07-22T00:00:00Z'),
        poolAttribution: 'measured',
        daysSince: 1,
        counter: 'Morena',
      },
      ...over,
    });

  it('renders the three labelled facts with an EXPLICIT estimate when the floor lags today', () => {
    // makeReport default totalToday = 79 + 60 + 55 = 194.
    const html = renderHtmlBody(makeReport({ eodInventory: laggingEod() }), {
      includeBonusDollars: false,
      includeComparisons: false,
    });
    expect(html).toContain("Today's Production vs. Inventory");
    expect(html).toContain('Reconciled floor (as of Jul 22, 2026 count)');
    expect(html).toContain('2,483 units');
    expect(html).toContain('Processed today (entered)');
    expect(html).toContain('194 units');
    expect(html).toContain('confirmed in MyMRC in 1–3 days');
    // Estimate = (1597 − 194) program + 886 non-program = 2,289.
    expect(html).toContain('Estimated floor after today');
    expect(html).toContain('2,289 units');
    expect(html).toContain('(estimate)');
    // ADR-0059 — the caveat now names inbound as provisional (inbound IS fed now).
    expect(html).toContain('does not yet fully reflect today');
    expect(html).toContain('inbound is provisional from MyMRC haul counts');
  });

  it('collapses (renders nothing extra) once today is reflected in the floor (movementToday)', () => {
    const html = renderHtmlBody(makeReport({ eodInventory: laggingEod({ movementToday: true }) }), {
      includeBonusDollars: false,
      includeComparisons: false,
    });
    expect(html).not.toContain("Today's Production vs. Inventory");
  });

  it('renders nothing on a zero-production day', () => {
    const zeroLines = makeReport({ eodInventory: laggingEod(), lines: [], totalToday: 0 });
    const html = renderHtmlBody(zeroLines, {
      includeBonusDollars: false,
      includeComparisons: false,
    });
    expect(html).not.toContain("Today's Production vs. Inventory");
  });

  it('renders nothing behind a stale anchor (no trustworthy floor to estimate from)', () => {
    const html = renderHtmlBody(makeReport({ eodInventory: laggingEod({ state: 'stale' }) }), {
      includeBonusDollars: false,
      includeComparisons: false,
    });
    expect(html).not.toContain("Today's Production vs. Inventory");
  });
});

// ── ADR-0076 — Processor Headcount panel ────────────────────────────

describe('renderHtmlBody — processor headcount (ADR-0076)', () => {
  it('renders the panel with today + MTD always, comparisons when enabled', () => {
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: true,
      includeComparisons: true,
    });
    expect(html).toContain('Processor Headcount — Woodland');
    expect(html).toContain('Processors today');
    expect(html).toContain('Distinct processors month-to-date');
    expect(html).toContain('Same period last month');
    expect(html).toContain('Same day last year');
    // The distinct-once + no-adjustment-attribution footnote (the sentence that
    // prevents a future "reconciliation fix" against the units totals).
    expect(html).toContain('counts once');
    expect(html).toContain('no processor attribution');
  });

  it('comparisons off → today + MTD still render, comparison rows absent', () => {
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: true,
      includeComparisons: false,
    });
    expect(html).toContain('Processor Headcount — Woodland');
    expect(html).toContain('Processors today');
    expect(html).toContain('Distinct processors month-to-date');
    expect(html).not.toContain('Same period last month (');
    expect(html).not.toContain('Same day last year (');
  });

  it('the MTD window label is byte-identical to the Trend MTD label', () => {
    const html = renderHtmlBody(makeReport(), {
      includeBonusDollars: true,
      includeComparisons: true,
    });
    const m = html.match(/Month-to-date \(([^)]+)\)/);
    expect(m).not.toBeNull();
    expect(html).toContain(`Distinct processors month-to-date (${m?.[1]})`);
  });
});
