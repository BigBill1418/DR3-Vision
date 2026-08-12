// ADR-0019.4 §4 — /admin/bonus-chain-health render smoke tests.
//
// The one behaviour worth pinning here is the EMPTY LEDGER. A page whose
// "Recent checks" table renders as a quiet blank when nothing has ever run
// looks identical to one where every check passed, and only one of those is
// safe — that ambiguity is the whole reason ADR-0019.4 exists as a readable
// surface rather than another alert. The other two cases assert that a red
// chain actually says BROKEN and that a green one names the actor, because a
// banner that renders the same either way is worth nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChainHealthReport } from '@/lib/bonus/chain-health';

const checkAdmin = vi.fn();
const loadChainHealth = vi.fn();
const findMany = vi.fn();

vi.mock('@/lib/auth-helpers', () => ({ checkAdmin: () => checkAdmin() }));
vi.mock('@/lib/bonus/chain-health', () => ({ loadChainHealth: () => loadChainHealth() }));
vi.mock('@/lib/prisma', () => ({
  prisma: { bonusChainHealthRun: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
// next/navigation redirect throws (like the real one) so a non-admin render
// short-circuits instead of returning markup.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import BonusChainHealthPage from './page';

const GREEN: ChainHealthReport = {
  overall: 'green',
  sites: [
    {
      siteCode: 'woodland',
      siteName: 'Woodland',
      status: 'green',
      findings: [],
      autoOverrideActorName: 'Bill Barnard',
      sodExclusions: [],
    },
  ],
};

const RED: ChainHealthReport = {
  overall: 'red',
  sites: [
    {
      siteCode: 'eugene',
      siteName: 'Eugene',
      status: 'red',
      autoOverrideActorName: null,
      sodExclusions: [],
      findings: [
        {
          slot: 'auto_override',
          reason: 'inactive',
          userId: 'u-dead',
          detail: 'The auto-override actor is INACTIVE. The 08:30 PT auto-override will REFUSE.',
        },
      ],
    },
  ],
};

beforeEach(() => {
  checkAdmin.mockReset().mockResolvedValue({ ok: true, ctx: {} });
  loadChainHealth.mockReset().mockResolvedValue(GREEN);
  findMany.mockReset().mockResolvedValue([]);
});

describe('BonusChainHealthPage (ADR-0019.4)', () => {
  it('an empty ledger reads as UNWATCHED, never as healthy', async () => {
    loadChainHealth.mockResolvedValue(GREEN);
    findMany.mockResolvedValue([]);

    const html = renderToStaticMarkup(await BonusChainHealthPage());

    expect(html).toContain('chain-runs-empty');
    expect(html).toContain('No checks recorded yet');
    expect(html).toContain('06:30');
    // The point of the note: it must actively deny the healthy reading.
    expect(html).toContain('not evidence that the chain is healthy');
  });

  it('a green chain names the auto-override actor', async () => {
    const html = renderToStaticMarkup(await BonusChainHealthPage());

    expect(html).toContain('Signature chain healthy');
    expect(html).toContain('Bill Barnard');
    expect(html).toContain('chain-site-woodland');
  });

  it('a broken chain says BROKEN and prints the finding detail verbatim', async () => {
    loadChainHealth.mockResolvedValue(RED);

    const html = renderToStaticMarkup(await BonusChainHealthPage());

    expect(html).toContain('Signature chain BROKEN');
    expect(html).toContain('will REFUSE');
    expect(html).toContain('unresolvable');
    expect(html).not.toContain('Signature chain healthy');
  });

  it('renders ledger rows newest-first with a Pacific timestamp and the page flag', async () => {
    findMany.mockResolvedValue([
      {
        id: 'run-1',
        // 2026-08-04 06:30 PDT === 13:30Z. If this ever renders as 13:30 the
        // Pacific helper has been dropped.
        observed_at: new Date('2026-08-04T13:30:00.000Z'),
        status: 'red',
        paged: true,
        site: { code: 'eugene', name: 'Eugene' },
      },
    ]);

    const html = renderToStaticMarkup(await BonusChainHealthPage());

    expect(html).toContain('6:30');
    expect(html).toContain('PT');
    expect(html).toContain('eugene');
    expect(html).toContain('yes');
    expect(html).not.toContain('chain-runs-empty');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, orderBy: { observed_at: 'desc' } }),
    );
  });

  it('explains a separation-of-duties exclusion on an otherwise-green card', async () => {
    // ADR-0019.3 §2 — the exclusion is standing context, not a finding. A green
    // chain stays green AND still tells the operator why an override actor will
    // be signing certain periods; otherwise the only place that answer exists is
    // an ADR nobody reads at 06:30 on payroll morning.
    loadChainHealth.mockResolvedValue({
      overall: 'green',
      sites: [
        {
          siteCode: 'eugene',
          siteName: 'Eugene',
          status: 'green',
          findings: [],
          autoOverrideActorName: 'Bill Barnard',
          sodExclusions: [
            { slot: 'ops_signer', userId: 'u-patrick', employeeName: 'Patrick Dills' },
          ],
        },
      ],
    });
    findMany.mockResolvedValue([]);

    const html = renderToStaticMarkup(await BonusChainHealthPage());

    expect(html).toContain('Patrick Dills');
    expect(html).toContain('override chain');
    expect(html).toContain('not a fault');
  });

  it('a non-admin is redirected rather than shown the chain', async () => {
    checkAdmin.mockResolvedValue({ ok: false, status: 403 });

    await expect(BonusChainHealthPage()).rejects.toThrow('REDIRECT:/admin');
  });
});
