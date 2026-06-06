// Admin bonus site picker (ADR-0019.2 §1/§6, T-210). Rendered at `/bonus` when
// the caller can reach more than one site (Bill, Kelsey) and hasn't picked yet.
// Selecting a site posts the `pickBonusSiteAction` server action, which sets the
// `dr3_bonus_site` cookie and redirects to `/bonus?site=<chosen>`.
//
// Pure server component (no client JS) — buttons are <form> submits bound to the
// server action, styled to match the DARK dr3-space / cyan dashboard theme.

import Link from 'next/link';
import { HOME_ROUTE } from '@/lib/routes';
import type { SiteCode } from '@/lib/bonus/access';
import { pickBonusSiteAction } from './site-actions';

const SITE_LABEL: Record<SiteCode, string> = {
  woodland: 'Woodland',
  eugene: 'Eugene',
};

const SITE_BLURB: Record<SiteCode, string> = {
  woodland: 'California — Janette & Morena',
  eugene: 'Oregon — Rick & Kelsey',
};

export function SitePicker({ sites }: { sites: SiteCode[] }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-dr3-mist">
      <div className="flex w-full max-w-lg flex-col gap-8">
        <header className="flex flex-col gap-2 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Choose a site</h1>
          <p className="text-sm text-dr3-mist-dim">
            You manage bonuses for more than one site. Pick the site to view its bonus data; you can
            switch any time from the bonus header.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          {sites.map((site) => (
            <form key={site} action={pickBonusSiteAction}>
              <input type="hidden" name="site" value={site} />
              <button
                type="submit"
                className="flex w-full flex-col items-start gap-1 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2/70 px-5 py-6 text-left transition-colors hover:border-dr3-cyan hover:bg-dr3-space-2 focus:outline-none focus:ring-2 focus:ring-dr3-cyan focus:ring-offset-2 focus:ring-offset-dr3-space"
              >
                <span className="text-xl font-semibold text-dr3-mist">{SITE_LABEL[site]}</span>
                <span className="text-xs text-dr3-mist-dim">{SITE_BLURB[site]}</span>
                <span className="mt-3 text-sm font-medium text-dr3-cyan">View bonuses →</span>
              </button>
            </form>
          ))}
        </div>

        <Link
          href={HOME_ROUTE}
          className="text-center text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
        >
          ← Back to dashboard
        </Link>
      </div>
    </main>
  );
}
