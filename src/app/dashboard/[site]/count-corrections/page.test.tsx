// ADR-0105 — the page-level gate.
//
// The API route test proves a non-manager is refused 403 by the handler. This
// proves the SCREEN is not a way around that: a non-manager gets the denial
// surface and, critically, **no count data is read or rendered**. A page that
// rendered the rows and then hid them behind a CSS class would pass a naive
// "shows Access denied" assertion and still ship the numbers to the browser.
//
// Server-rendered to static markup, the house pattern (page.test.tsx siblings).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const checkManagerForSite = vi.fn();
const isUiSurfaceLive = vi.fn();
const listWindowCountsAtSite = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/auth-helpers', () => ({
  checkManagerForSite: (...a: unknown[]) => checkManagerForSite(...a),
}));
vi.mock('@/lib/notify/rollout', () => ({
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
  UI_SURFACE: { LOADS_INVENTORY: 'loads_inventory' },
}));
vi.mock('@/lib/inventory/correct-count', () => ({
  listWindowCountsAtSite: (...a: unknown[]) => listWindowCountsAtSite(...a),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findMany: (...a: unknown[]) => userFindMany(...a) } },
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  // The page renders the client panel, which calls `useRouter`. Server-rendering
  // it to markup still evaluates the hook, so the mock must supply it.
  useRouter: () => ({ refresh: () => {} }),
}));

import CountCorrectionsPage from './page';

const LIVE_ROW = {
  id: 'snap-live',
  countedDayISO: '2026-07-28',
  enteredAt: new Date('2026-07-28T18:05:00.000Z'),
  physicalTotal: 2_483,
  units_indoor: null,
  units_total: 2_483,
  units_in_processing: 0,
  enteredByUserId: 'user-jt',
  isCorrection: false,
  correctedFromId: null,
  correctedToId: null,
  voidedAt: null,
  voidedByUserId: null,
  voidReason: null,
  correctable: true,
};

/** Server components return a promise; resolve then render. */
async function html(site = 'eugene'): Promise<string> {
  const el = await (
    CountCorrectionsPage as unknown as (p: {
      params: Promise<{ site: string }>;
    }) => Promise<React.ReactElement>
  )({ params: Promise.resolve({ site }) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  checkManagerForSite.mockReset();
  isUiSurfaceLive.mockReset();
  listWindowCountsAtSite.mockReset();
  userFindMany.mockReset();
  userFindMany.mockResolvedValue([{ id: 'user-jt', name: 'JT' }]);
  listWindowCountsAtSite.mockResolvedValue([LIVE_ROW]);
  isUiSurfaceLive.mockResolvedValue(true);
});

describe('ADR-0105 — who gets the page', () => {
  it('an OPERATOR (403) gets the denial surface and NO count data', async () => {
    checkManagerForSite.mockResolvedValue({ ok: false, status: 403 });
    const out = await html();
    expect(out).toContain('Access denied');
    expect(
      listWindowCountsAtSite,
      'the page read the counts before deciding the caller was allowed to see them',
    ).not.toHaveBeenCalled();
    expect(out).not.toContain('2,483');
    expect(out).not.toContain('JT');
  });

  it('an anonymous caller is redirected to login with a next param', async () => {
    checkManagerForSite.mockResolvedValue({ ok: false, status: 401 });
    await expect(html()).rejects.toThrow(
      'REDIRECT:/login?next=/dashboard/eugene/count-corrections',
    );
    expect(listWindowCountsAtSite).not.toHaveBeenCalled();
  });

  it('a manager at a site whose module is dark gets "Not yet activated", not the rows', async () => {
    checkManagerForSite.mockResolvedValue({
      ok: true,
      ctx: { siteId: 'site-eugene', siteName: 'Eugene', role: 'manager', userId: 'u1' },
    });
    isUiSurfaceLive.mockResolvedValue(false);
    const out = await html();
    expect(out).toContain('Not yet activated');
    expect(listWindowCountsAtSite).not.toHaveBeenCalled();
    expect(out).not.toContain('2,483');
  });

  it('an ADMIN passes the activation gate even when the surface is dark', async () => {
    checkManagerForSite.mockResolvedValue({
      ok: true,
      ctx: { siteId: 'site-eugene', siteName: 'Eugene', role: 'admin', userId: 'u1' },
    });
    isUiSurfaceLive.mockResolvedValue(false);
    const out = await html();
    expect(out).toContain('Count corrections');
    expect(listWindowCountsAtSite).toHaveBeenCalledWith('site-eugene');
  });

  it('the site MANAGER gets the rows — the refusals above are the gate, not a dead page', async () => {
    // Without this, every assertion above would pass against a page that always
    // denied, and the suite would be measuring nothing.
    checkManagerForSite.mockResolvedValue({
      ok: true,
      ctx: { siteId: 'site-eugene', siteName: 'Eugene', role: 'manager', userId: 'u1' },
    });
    const out = await html();
    expect(out).toContain('Count corrections — Eugene');
    expect(out).toContain('2,483');
    expect(out).toContain('JT');
    expect(out).toContain('today and yesterday');
  });

  it('an unresolvable enterer renders "not recorded", never a placeholder name', async () => {
    checkManagerForSite.mockResolvedValue({
      ok: true,
      ctx: { siteId: 'site-eugene', siteName: 'Eugene', role: 'manager', userId: 'u1' },
    });
    userFindMany.mockResolvedValue([]);
    const out = await html();
    expect(out).toContain('not recorded');
  });
});
