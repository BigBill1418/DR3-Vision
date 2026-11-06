// ADR-0072 Amendment 1 — the page-level gate and the read.
//
// A non-manager gets the denial surface and NO hold is read; a manager gets this
// site's pending holds only, with names, flags and "entered by me" resolved
// server-side. Server-rendered to static markup, the house pattern.

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const checkManagerForSite = vi.fn();
const holdFindMany = vi.fn();
const userFindMany = vi.fn();
const loadPriorAnchor = vi.fn();

vi.mock('@/lib/auth-helpers', () => ({
  checkManagerForSite: (...a: unknown[]) => checkManagerForSite(...a),
}));
vi.mock('@/lib/inventory/anchor-guardrail', () => ({
  loadPriorAnchor: (...a: unknown[]) => loadPriorAnchor(...a),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryCountHold: { findMany: (...a: unknown[]) => holdFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));

import HeldCountsPage from './page';

async function html(site = 'woodland'): Promise<string> {
  const el = await (
    HeldCountsPage as unknown as (p: {
      params: Promise<{ site: string }>;
    }) => Promise<React.ReactElement>
  )({ params: Promise.resolve({ site }) });
  return renderToStaticMarkup(el);
}

const CTX = {
  siteId: 'site-woodland',
  siteCode: 'woodland',
  siteName: 'Woodland',
  userId: 'mgr-1',
  role: 'manager',
};

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    created_at: new Date('2026-11-06T16:05:00.000Z'),
    created_by: 'op-1',
    counted_by: 'Jose',
    confirmed_by: null,
    prior_total: 2483,
    new_total: 1200,
    swing_pct: { toString: () => '51.67' },
    threshold_pct: { toString: () => '20.00' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadPriorAnchor.mockResolvedValue({ id: 's', total: 2483 });
  userFindMany.mockResolvedValue([{ id: 'op-1', name: 'Operator One' }]);
});

describe('gate', () => {
  it('redirects an anonymous visitor to login with a return path', async () => {
    checkManagerForSite.mockResolvedValue({ ok: false, status: 401 });
    await expect(html()).rejects.toThrow('REDIRECT:/login?next=/dashboard/woodland/held-counts');
    expect(holdFindMany).not.toHaveBeenCalled();
  });

  it('denies a non-manager without reading any hold', async () => {
    checkManagerForSite.mockResolvedValue({ ok: false, status: 403 });
    const out = await html();
    expect(out).toContain('Access denied');
    expect(holdFindMany).not.toHaveBeenCalled();
  });
});

describe('read', () => {
  it('reads only this site’s pending holds', async () => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
    holdFindMany.mockResolvedValue([]);
    await html();
    expect(holdFindMany.mock.calls[0]?.[0].where).toEqual({
      site_id: 'site-woodland',
      status: 'pending',
    });
    expect(loadPriorAnchor).toHaveBeenCalledWith(expect.anything(), 'site-woodland');
  });

  it('renders names, the large-swing alert, duplicates and the self-entered note', async () => {
    checkManagerForSite.mockResolvedValue({ ok: true, ctx: CTX });
    holdFindMany.mockResolvedValue([
      row('h1'),
      row('h2', { created_at: new Date('2026-11-06T16:09:00.000Z') }),
      row('h3', { created_by: 'mgr-1', new_total: 2100 }),
    ]);
    userFindMany.mockResolvedValue([
      { id: 'op-1', name: 'Operator One' },
      { id: 'mgr-1', name: 'Manager One' },
    ]);
    const out = await html();
    expect(out).toContain('Held counts — Woodland');
    expect(out).toContain('Entered by Operator One');
    expect(out).toContain('counted by Jose');
    expect(out).toContain('data-testid="large-swing-h1"');
    expect(out).toContain('data-testid="duplicate-h1"');
    expect(out).toContain('data-testid="duplicate-h2"');
    expect(out).not.toContain('data-testid="duplicate-h3"');
    expect(out).toContain('data-testid="mine-h3"');
    expect(out).not.toContain('data-testid="approve-h3"');
    expect(out).toContain('data-testid="approve-h1"');
  });
});
