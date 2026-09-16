import { describe, expect, it, vi, beforeEach } from 'vitest';

// ADR-0131 Amendment 2. The comment this invariant carried asked for exactly one
// thing — "if a Woodland-only source registry is intentional, the right fix is to
// narrow this invariant deliberately and say so HERE" — and these tests are the
// half of that fix a comment cannot supply.

const siteFindMany = vi.fn();
const sourceFindMany = vi.fn();
const isUiSurfaceLive = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findMany: (...a: unknown[]) => siteFindMany(...a) },
    workbookSource: { findMany: (...a: unknown[]) => sourceFindMany(...a) },
  },
}));
vi.mock('@/lib/notify/rollout', async (orig) => ({
  ...(await orig<typeof import('@/lib/notify/rollout')>()),
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
}));

import { WORKBOOK_SYNC_INVARIANTS } from './invariants';

const inv = WORKBOOK_SYNC_INVARIANTS.find((i) => i.id === 'INV-WORKBOOK-PATH-TOKEN')!;
const ctx = { now: new Date('2026-09-16T09:30:00Z') };

const EUGENE = { id: 'site-e', code: 'eugene' };
const WOODLAND = { id: 'site-w', code: 'woodland' };

/** Production: one row, Woodland, tokenised, syncing. Eugene has none. */
const WOODLAND_SOURCE = {
  site_id: 'site-w',
  folder_path: '{MONTH} {YYYY} Woodland',
  naming_pattern: 'DR3 Woodland Daily Log {MONTH} {YYYY}.xlsx',
  is_syncing: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  siteFindMany.mockResolvedValue([EUGENE, WOODLAND]);
  sourceFindMany.mockResolvedValue([WOODLAND_SOURCE]);
  isUiSurfaceLive.mockImplementation(async (_c: string, siteId: string) => siteId === 'site-w');
});

describe('INV-WORKBOOK-PATH-TOKEN is scoped to onboarded sites', () => {
  it('stops reporting Eugene for having no workbook_sources row', async () => {
    // The 02:30 PT page of 2026-09-14, verbatim: "eugene: no workbook_sources row,
    // so this invariant cannot speak for the site". A site that is not running
    // Loads & Inventory is not supposed to have one.
    const out = await inv.check(ctx);
    expect(out.status).toBe('ok');
    expect(out.subjectsChecked).toBe(1);
    expect(JSON.stringify(out.violations)).not.toContain('eugene');
  });

  it('still reports an ONBOARDED site with no source row', async () => {
    // The blind spot the original comment was written about is not being sealed —
    // it is being scoped. Woodland losing its row is still a finding.
    sourceFindMany.mockResolvedValue([]);
    const out = await inv.check(ctx);
    expect(out.status).toBe('violated');
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0]!.subject).toBe('woodland');
  });

  it('still reports an onboarded site whose path lost its {TOKEN}', async () => {
    sourceFindMany.mockResolvedValue([{ ...WOODLAND_SOURCE, folder_path: 'August 2026 Woodland' }]);
    const out = await inv.check(ctx);
    expect(out.status).toBe('violated');
    expect(out.violations[0]!.detail).toContain('August 2026 Woodland');
  });

  it('re-enters a site the moment loads_inventory is flipped live', async () => {
    isUiSurfaceLive.mockResolvedValue(true);
    const out = await inv.check(ctx);
    expect(out.status).toBe('violated');
    expect(out.subjectsChecked).toBe(2);
    expect(out.violations.map((v) => v.subject)).toEqual(['eugene']);
  });

  it('is indeterminate — never ok — when no site is onboarded at all', async () => {
    isUiSurfaceLive.mockResolvedValue(false);
    const out = await inv.check(ctx);
    expect(out.status).toBe('indeterminate');
    expect(out.subjectsChecked).toBe(0);
    expect(out.note).toMatch(/loads_inventory/);
  });

  it('says in its own title that it speaks only for onboarded sites', () => {
    expect(inv.title).toMatch(/onboarded/i);
    expect(inv.assumption).toMatch(/loads_inventory|onboard/i);
  });
});
