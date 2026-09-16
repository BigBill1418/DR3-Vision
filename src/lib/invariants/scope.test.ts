import { describe, expect, it, vi } from 'vitest';

const isUiSurfaceLive = vi.fn();
const siteFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { site: { findMany: (...a: unknown[]) => siteFindMany(...a) } },
}));
vi.mock('@/lib/notify/rollout', async (orig) => ({
  ...(await orig<typeof import('@/lib/notify/rollout')>()),
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
}));

import { UI_SURFACE } from '@/lib/notify/rollout';
import { verdict } from './types';
import { noOnboardedSites, onboardedSites, ONBOARDING_SURFACE } from './scope';

const EUGENE = { id: 'site-e', code: 'eugene' };
const WOODLAND = { id: 'site-w', code: 'woodland' };

/** `loads_inventory` live at Woodland, pilot at Eugene — production, 2026-09-15. */
function productionToday() {
  isUiSurfaceLive.mockImplementation(async (_code: string, siteId: string) => siteId === 'site-w');
}

describe('the onboarding predicate', () => {
  it('reads the loads_inventory UI surface, not some second predicate of its own', async () => {
    // The whole point of ADR-0131 Amendment 2: onboarding is ALREADY expressed by
    // the ADR-0047 rollout surface, so there is no new `sites` column and no
    // parallel definition to drift. Pinning the surface code here is the negative
    // control — swapping in `ipad_count` would narrow the suite to a different,
    // unrelated question while every other test stayed green.
    productionToday();
    await onboardedSites([EUGENE, WOODLAND]);
    expect(isUiSurfaceLive).toHaveBeenCalledWith(UI_SURFACE.LOADS_INVENTORY, 'site-e');
    expect(ONBOARDING_SURFACE).toBe('loads_inventory');
  });

  it('keeps a live site and drops a pilot one', async () => {
    productionToday();
    expect(await onboardedSites([EUGENE, WOODLAND])).toEqual([WOODLAND]);
  });

  it('returns NOTHING when every site is in pilot — it does not fall back to all', async () => {
    // The dangerous shape a "filter" invites: an empty result treated as "no
    // filter", which would silently restore the behaviour this change removes.
    isUiSurfaceLive.mockResolvedValue(false);
    expect(await onboardedSites([EUGENE, WOODLAND])).toEqual([]);
  });

  it('is fail-closed — isUiSurfaceLive swallows a read error into `false`', async () => {
    // Not incidental. A database the suite cannot read must make the suite say
    // "I could not look", never "everything is fine at every site".
    isUiSurfaceLive.mockResolvedValue(false);
    expect(await onboardedSites([WOODLAND])).toEqual([]);
  });
});

describe('the zero-onboarded-sites outcome', () => {
  it('is indeterminate over zero subjects, with the reason stated', async () => {
    const out = noOnboardedSites();
    expect(out.status).toBe('indeterminate');
    expect(out.subjectsChecked).toBe(0);
    expect(out.violations).toEqual([]);
    expect(out.note).toMatch(/loads_inventory/);
  });

  it('NEGATIVE CONTROL — verdict() over zero subjects would have said `ok`', () => {
    // This is why the explicit outcome exists rather than leaning on the runner's
    // vacuity guard alone: the check itself must not hand back a green.
    expect(verdict(0, []).status).toBe('ok');
  });

  it('hands back a FRESH violations array each call', () => {
    const a = noOnboardedSites();
    a.violations.push({ subject: 'x', detail: 'y' });
    expect(noOnboardedSites().violations).toEqual([]);
  });
});
