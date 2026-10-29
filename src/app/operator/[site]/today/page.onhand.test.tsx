// ADR-0143 D1 — test T2: the two raw surfaces render Woodland's 2026-10-29 balance
// (program -247 / non-program 644 / total 397) without the negative, and with the
// presenter's wording. Both pages printed "-247" before this change (RC3).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Prisma } from '@prisma/client';

const onHand = vi.fn();
const isUiSurfaceLive = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { name: 'Op' } }) }));
vi.mock('@/lib/auth-helpers', () => ({
  checkOperatorForSite: async () => ({
    ok: true,
    ctx: {
      siteId: 'site-w',
      siteName: 'Woodland',
      siteCode: 'woodland',
      userId: 'u',
      role: 'admin',
    },
  }),
  checkManagerForSite: async () => ({
    ok: true,
    ctx: {
      siteId: 'site-w',
      siteName: 'Woodland',
      siteCode: 'woodland',
      userId: 'u',
      role: 'admin',
    },
  }),
}));
vi.mock('@/lib/notify/rollout', () => ({
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
  UI_SURFACE: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
}));
vi.mock('@/lib/inventory/running-balance', () => ({ onHand: (...a: unknown[]) => onHand(...a) }));
vi.mock('@/lib/loads/floor-inbound', () => ({ countUnconfirmedInboundDays: async () => 0 }));
vi.mock('@/lib/loads/portal-hauls', () => ({ countPendingPortalHauls: async () => 0 }));
const locale = vi.fn(async () => 'en');
vi.mock('@/i18n/get-locale', () => ({ getLocale: () => locale() }));
const openExceptionForPresenter = vi.fn(async (): Promise<unknown> => null);
vi.mock('@/lib/inventory/exception-service', () => ({
  openExceptionForPresenter: (...a: unknown[]) => openExceptionForPresenter(...(a as [])),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/app/dashboard/[site]/loads-inventory/LoadsInventoryClient', () => ({
  LoadsInventoryClient: () => null,
}));

import TodayPage from './page';
import LoadsInventoryPage from '../../../dashboard/[site]/loads-inventory/page';

const D = Prisma.Decimal;
const WOODLAND = { program: new D(-247), nonProgram: new D(644), total: new D(397) };
const params = Promise.resolve({ site: 'woodland' });

beforeEach(() => {
  locale.mockResolvedValue('en');
  openExceptionForPresenter.mockReset();
  openExceptionForPresenter.mockResolvedValue(null);
  onHand.mockReset();
  isUiSurfaceLive.mockReset();
  isUiSurfaceLive.mockResolvedValue(true);
});

describe('T2 — iPad Today hub', () => {
  it('Woodland case 1: no -247, no 644, total kept, translated withheld line', async () => {
    onHand.mockResolvedValue(WOODLAND);
    const html = renderToStaticMarkup(await TodayPage({ params } as never));
    expect(html).not.toMatch(/[-−]247/);
    expect(html).not.toContain('247');
    expect(html).not.toContain('644');
    expect(html).toContain('397');
    expect(html).toContain('The program / non-program split is being corrected by the office.');
  });

  it('a healthy floor still shows both pools (control)', async () => {
    onHand.mockResolvedValue({ program: new D(120), nonProgram: new D(277), total: new D(397) });
    const html = renderToStaticMarkup(await TodayPage({ params } as never));
    expect(html).toContain('120');
    expect(html).toContain('277');
    expect(html).not.toContain('hub-onhand-withheld');
  });
});

describe('T2 — manager Loads & inventory page', () => {
  it('Woodland case 1: pools withheld, Am.1 sentence + the one remedy, total kept', async () => {
    onHand.mockResolvedValue(WOODLAND);
    const html = renderToStaticMarkup(await LoadsInventoryPage({ params } as never));
    expect(html).not.toContain('247');
    expect(html).not.toContain('644');
    expect(html).toContain('Program on-hand is computing negative while the total is positive.');
    expect(html).toContain('A site manager records a pool adjustment');
    expect(html).toContain('397');
    expect(html).toContain('/dashboard/woodland/inventory-exceptions');
  });
});

// ── CH-12 (Bill, 2026-10-29) — mid-day, live pools positive, exception still open ──
const MIDDAY = { program: new D(138), nonProgram: new D(644), total: new D(782) };
const OPEN = { id: 'ex-woodland-program', pool: 'program' };

describe('CH-12 — an open exception hides the split on both surfaces', () => {
  it('iPad hub (en): 782 shown, 138 / 644 hidden, translated line; the lookup is for THIS site', async () => {
    onHand.mockResolvedValue(MIDDAY);
    openExceptionForPresenter.mockResolvedValue(OPEN);
    const html = renderToStaticMarkup(await TodayPage({ params } as never));
    expect(html).toContain('782');
    expect(html).not.toContain('138');
    expect(html).not.toContain('644');
    expect(html).toContain('The program / non-program split is being corrected by the office.');
    expect(openExceptionForPresenter).toHaveBeenCalledWith('site-w');
  });

  it.each([
    ['es', 'La oficina está corrigiendo la división programa / no programa.'],
    ['ur', 'پروگرام / غیر پروگرام کی تقسیم دفتر درست کر رہا ہے۔'],
  ])(
    'iPad hub (%s): the same line in the operator language, no pool figures',
    async (loc, line) => {
      locale.mockResolvedValue(loc);
      onHand.mockResolvedValue(MIDDAY);
      openExceptionForPresenter.mockResolvedValue(OPEN);
      const html = renderToStaticMarkup(await TodayPage({ params } as never));
      expect(html).toContain(line);
      expect(html).not.toContain('138');
    },
  );

  it('manager page: pools hidden, total kept, the notice links to THE exception', async () => {
    onHand.mockResolvedValue(MIDDAY);
    openExceptionForPresenter.mockResolvedValue(OPEN);
    const html = renderToStaticMarkup(await LoadsInventoryPage({ params } as never));
    expect(html).not.toContain('138');
    expect(html).not.toContain('644');
    expect(html).toContain('782');
    expect(html).toContain('The program / non-program split is being corrected.');
    expect(html).toContain('/dashboard/woodland/inventory-exceptions/ex-woodland-program');
  });

  it('no open exception (resolved): the split reappears on both surfaces', async () => {
    onHand.mockResolvedValue(MIDDAY);
    const hub = renderToStaticMarkup(await TodayPage({ params } as never));
    const mgr = renderToStaticMarkup(await LoadsInventoryPage({ params } as never));
    for (const html of [hub, mgr]) {
      expect(html).toContain('138');
      expect(html).toContain('644');
    }
  });
});
