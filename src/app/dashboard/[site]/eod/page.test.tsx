// ADR-0125 — the EOD page's gates and its two load-bearing renders.
//
// Four claims:
//
//   1. A NON-MANAGER GETS NO PAGE — and no data is read before the decision.
//   2. The surface is BORN PILOT: a manager at a site where `eod_review` is not
//      live gets the not-activated screen; an ADMIN passes anyway.
//   3. A MISSING SECTION RENDERS ⚠, and a captured one does not (the control).
//   4. A NEGATIVE ON-HAND RENDERS THE ADR-0110 BANNER, and the bare figure is
//      asserted ABSENT from the markup — not merely hidden. A `display:none`
//      still ships the number into the HTML, and a negative printed anywhere on
//      a manager surface gets copied into a spreadsheet.
//
// ── FALSIFIED BY HAND (2026-08-24) ─────────────────────────────────────────
//
// Rendering the pools unconditionally in `FloorInventoryTile` (dropping the
// `tile.negative` branch) takes case 4 red with
//   AssertionError: expected '<main class="min-h-screen bg-dr3-spac…' to contain
//     'data-testid="floor-negative-banner"'
// and the printed markup then carries
//   <div ... data-testid="floor-pool-program">-2,439</div>
// which is exactly the figure this page exists to never emit.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const checkManagerForSite = vi.fn();
const isUiSurfaceLive = vi.fn();
const getEodDayReview = vi.fn();
const sourceFindMany = vi.fn();

vi.mock('@/lib/auth-helpers', () => ({
  checkManagerForSite: (...a: unknown[]) => checkManagerForSite(...a),
}));
vi.mock('@/lib/notify/rollout', () => ({
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
  UI_SURFACE: { EOD_REVIEW: 'eod_review' },
}));
vi.mock('@/lib/eod/day-review', () => ({
  getEodDayReview: (...a: unknown[]) => getEodDayReview(...a),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { source: { findMany: (...a: unknown[]) => sourceFindMany(...a) } },
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  // The page renders client islands that call `useRouter`; server-rendering to
  // markup still evaluates the hook, so the mock must supply it.
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import EodPage from './page';

const CTX = {
  siteId: 'site-1',
  siteCode: 'woodland',
  siteName: 'Woodland',
  userId: 'u-1',
  role: 'manager' as const,
};

/** A review whose sections are all empty — every flagged section reads `missing`. */
function review(over: Record<string, unknown> = {}) {
  const flags = {
    inbound: 'missing',
    outbound: 'missing',
    processed: 'missing',
    nonProgram: 'missing',
    unpaidDropoff: 'missing',
    terex: 'missing',
  };
  const zero = { lines: 0, units: 0 };
  return {
    siteId: CTX.siteId,
    siteCode: CTX.siteCode,
    siteName: CTX.siteName,
    dayKey: '2026-08-20',
    todayKey: '2026-08-20',
    isToday: true,
    isFuture: false,
    rows: {
      dayKey: '2026-08-20',
      inbound: [],
      outbound: [],
      renovation: [],
      unpaidDropoffs: [],
      incentiveDropoffs: [],
      otherDropoffs: [],
      processed: null,
      terex: null,
      landfilled: [],
      terexApplicable: true,
    },
    totals: {
      dayKey: '2026-08-20',
      inbound: {
        lines: 0,
        units: 0,
        programUnits: 0,
        nonProgramUnits: 0,
        weightLbs: 0,
        freightLines: 0,
        noFreightLines: 0,
        awaitingVerification: 0,
      },
      outbound: { lines: 0, weightLbs: 0 },
      renovation: { lines: 0, weightLbs: 0, wholeUnits: 0 },
      processed: {
        recorded: false,
        strippedProgram: 0,
        strippedNonProgram: 0,
        savedUnits: 0,
      },
      nonProgram: zero,
      unpaidDropoff: zero,
      incentiveDropoff: zero,
      otherDropoff: zero,
      terex: { recorded: false, applicable: true, unitsProcessed: 0, runHours: 0 },
      landfilled: zero,
      flags,
    },
    missing: ['inbound', 'outbound', 'processed', 'nonProgram', 'unpaidDropoff', 'terex'],
    close: null,
    onHand: {
      programOnFloor: 100,
      nonProgramOnFloor: 50,
      totalOnFloor: 150,
      anchorPool: 'measured',
      negative: false,
      trailingUnitsPerDay: null,
      programDaysRemaining: null,
      asOfISO: '2026-08-20',
    },
    inventoryCheck: {
      state: 'ok',
      reason: null,
      anchorDayISO: '2026-08-18',
      physicalTotal: 150,
      programUnits: 100,
      nonProgramUnits: 50,
      delta: 0,
    },
    rollup: {
      fromDayKey: '2026-08-01',
      toDayKey: '2026-08-20',
      days: 20,
      daysWithGaps: 20,
      inbound: {
        lines: 0,
        units: 0,
        programUnits: 0,
        nonProgramUnits: 0,
        weightLbs: 0,
        freightLines: 0,
        noFreightLines: 0,
        awaitingVerification: 0,
      },
      outbound: { lines: 0, weightLbs: 0 },
      renovation: { lines: 0, weightLbs: 0, wholeUnits: 0 },
      processed: { daysRecorded: 0, strippedProgram: 0, strippedNonProgram: 0, savedUnits: 0 },
      nonProgram: zero,
      unpaidDropoff: zero,
      incentiveDropoff: zero,
      otherDropoff: zero,
      terex: { daysRecorded: 0, unitsProcessed: 0, runHours: 0 },
      landfilled: zero,
    },
    ...over,
  };
}

/** Server components return a promise; resolve then render. */
async function html(site = 'woodland', day?: string): Promise<string> {
  const el = await (
    EodPage as unknown as (p: {
      params: Promise<{ site: string }>;
      searchParams: Promise<{ day?: string }>;
    }) => Promise<React.ReactElement>
  )({
    params: Promise.resolve({ site }),
    searchParams: Promise.resolve(day === undefined ? {} : { day }),
  });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  checkManagerForSite.mockReset();
  isUiSurfaceLive.mockReset();
  getEodDayReview.mockReset();
  sourceFindMany.mockReset();
  sourceFindMany.mockResolvedValue([]);
  getEodDayReview.mockResolvedValue(review());
  isUiSurfaceLive.mockResolvedValue(true);
});

describe('access', () => {
  it('an operator gets Access denied — and the day is never read', async () => {
    checkManagerForSite.mockResolvedValue({ ok: false, status: 403 });
    const out = await html();
    expect(out).toContain('Access denied');
    expect(out).not.toContain('End of day —');
    // The gate decides BEFORE the data is fetched. Reading the day and then
    // discarding it would still have put a site's figures through this process.
    expect(getEodDayReview).not.toHaveBeenCalled();
  });

  it('an anonymous visitor is redirected to login with a next= back to this page', async () => {
    checkManagerForSite.mockResolvedValue({ ok: false, status: 401 });
    await expect(html()).rejects.toThrow('REDIRECT:/login?next=/dashboard/woodland/eod');
  });

  it('a manager at a site where the surface is still PILOT gets the not-activated screen', async () => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
    isUiSurfaceLive.mockResolvedValue(false);
    const out = await html();
    expect(out).toContain('Not yet activated');
    expect(out).toContain('eod_review');
    expect(getEodDayReview).not.toHaveBeenCalled();
  });

  it('an ADMIN passes the pilot gate — the positive control on the gate itself', async () => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: { ...CTX, role: 'admin' } });
    isUiSurfaceLive.mockResolvedValue(false);
    const out = await html();
    expect(out).not.toContain('Not yet activated');
    expect(out).toContain('End of day —');
    expect(getEodDayReview).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed ?day= rather than quietly resolving it to today', async () => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
    const out = await html('woodland', 'yesterday');
    expect(out).toContain('Bad date');
    expect(getEodDayReview).not.toHaveBeenCalled();
  });
});

describe('gap flags on the page', () => {
  beforeEach(() => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
  });

  it('renders ⚠ not recorded for a section with nothing captured', async () => {
    const out = await html();
    expect(out).toContain('data-testid="gap-flag-missing"');
    expect(out).toContain('⚠ not recorded');
    // And the close control names what is still out, so the exception note
    // cannot be written against a blank memory.
    expect(out).toContain('data-testid="eod-close-open-gaps"');
    expect(out).toContain('Inbound');
  });

  it('renders ✓ captured for a section that HAS rows — the control', async () => {
    // Without this, a page that printed ⚠ unconditionally would pass above.
    const r = review();
    (r.totals.flags as Record<string, string>)['inbound'] = 'captured';
    r.missing = ['outbound'];
    getEodDayReview.mockResolvedValue(r);
    const out = await html();
    expect(out).toContain('data-testid="gap-flag-captured"');
    expect(out).toContain('✓ captured');
  });

  it('renders n/a — not ⚠ — for Terex at a site with no machine (Eugene-ready)', async () => {
    const r = review();
    (r.totals.flags as Record<string, string>)['terex'] = 'not_applicable';
    r.totals.terex.applicable = false;
    r.rows.terexApplicable = false;
    r.missing = ['inbound'];
    getEodDayReview.mockResolvedValue(r);
    const out = await html();
    expect(out).toContain('data-testid="gap-flag-na"');
    expect(out).toContain('no throughput machine');
  });
});

describe('on-hand — the ADR-0110 banner contract, on THIS page', () => {
  beforeEach(() => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
  });

  it('a NEGATIVE floor renders the banner and the bare figure is ABSENT from the markup', async () => {
    getEodDayReview.mockResolvedValue(
      review({
        onHand: {
          programOnFloor: -2439,
          nonProgramOnFloor: 900,
          totalOnFloor: -1539,
          anchorPool: 'measured',
          negative: true,
          trailingUnitsPerDay: 12,
          programDaysRemaining: 0,
          asOfISO: '2026-08-20',
        },
      }),
    );
    const out = await html();
    expect(out).toContain('data-testid="floor-negative-banner"');
    expect(out).toContain('On-hand is computing negative.');
    // The figures themselves must not be in the HTML at all. `-2,439` is the
    // real August Woodland number that was rendered as though it were a
    // measurement; it is the string this page exists to never emit.
    expect(out).not.toContain('-2,439');
    expect(out).not.toContain('2,439');
    expect(out).not.toContain('-1,539');
    // The days-remaining projection derived from a broken pool is suppressed
    // entirely, not CSS-hidden.
    expect(out).not.toContain('remaining at the current pace');
  });

  it('a HEALTHY floor renders the pools — the control that proves the case above measures something', async () => {
    const out = await html();
    expect(out).not.toContain('data-testid="floor-negative-banner"');
    expect(out).toContain('data-testid="floor-pool-program"');
  });
});

describe('the month rollup and its reconciliation line', () => {
  beforeEach(() => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
  });

  it('says on the page that it replaces the Summary tabs and that the sheet is known-doubled', async () => {
    const out = await html();
    expect(out).toContain('data-testid="eod-sheet-reconciliation"');
    expect(out).toContain('Sheet reconciliation');
    expect(out).toContain('known-doubled');
    // The divergence is REPORTED, not called an error.
    expect(out).toContain('report the divergence');
  });

  it('refuses to review a future day', async () => {
    getEodDayReview.mockResolvedValue(review({ isFuture: true }));
    const out = await html();
    expect(out).toContain('That day has not happened yet.');
    expect(out).not.toContain('data-testid="eod-close-controls"');
  });
});

describe('close state', () => {
  beforeEach(() => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
  });

  it('shows the exception note on a day closed with an exception', async () => {
    getEodDayReview.mockResolvedValue(
      review({
        close: {
          id: 'c1',
          siteId: CTX.siteId,
          closeDate: '2026-08-20',
          outcome: 'exception',
          exceptionNote: 'Terex hours still outstanding',
          closed: true,
          closedBy: 'u-1',
          closedAt: new Date('2026-08-20T23:00:00.000Z'),
          reopenedBy: null,
          reopenedAt: null,
          reopenReason: null,
          reopenCount: 0,
        },
      }),
    );
    const out = await html();
    expect(out).toContain('data-testid="eod-exception-note"');
    expect(out).toContain('Terex hours still outstanding');
    // A closed day offers the audited reopen, not a second close.
    expect(out).toContain('data-testid="eod-reopen-controls"');
    expect(out).not.toContain('data-testid="eod-close-controls"');
  });

  it('says a closed day is still correctable — closing locks nothing (D2)', async () => {
    getEodDayReview.mockResolvedValue(
      review({
        close: {
          id: 'c1',
          siteId: CTX.siteId,
          closeDate: '2026-08-20',
          outcome: 'clean',
          exceptionNote: null,
          closed: true,
          closedBy: 'u-1',
          closedAt: new Date('2026-08-20T23:00:00.000Z'),
          reopenedBy: null,
          reopenedAt: null,
          reopenReason: null,
          reopenCount: 0,
        },
      }),
    );
    const out = await html();
    expect(out).toContain('It does not lock anything');
  });
});
