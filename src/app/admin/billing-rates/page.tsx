// ADR-0040 D5 — billing-rates hub. Gated to manager+admin (read). Links to the
// four rate-table surfaces. Write affordances live on each sub-page and key off
// `checkRateManager` there; the hub only reports the caller's write access.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkRateRead, checkRateManager } from '@/lib/auth-helpers';
import { rateMessages as M } from './messages';
import { RateForbidden, RateShell, ReadOnlyNotice } from './shell';

export const dynamic = 'force-dynamic';

const LINKS = [
  { href: '/admin/billing-rates/tiers', label: M.hub.tiersLabel, description: M.hub.tiersDescription, testid: 'rate-tile-tiers' },
  { href: '/admin/billing-rates/haul-rates', label: M.hub.haulRatesLabel, description: M.hub.haulRatesDescription, testid: 'rate-tile-haul-rates' },
  { href: '/admin/billing-rates/rentals', label: M.hub.rentalsLabel, description: M.hub.rentalsDescription, testid: 'rate-tile-rentals' },
  { href: '/admin/billing-rates/fuel-prices', label: M.hub.fuelLabel, description: M.hub.fuelDescription, testid: 'rate-tile-fuel' },
] as const;

export default async function BillingRatesHubPage() {
  const gate = await checkRateRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/billing-rates');
    return <RateForbidden />;
  }
  const write = await checkRateManager();

  return (
    <RateShell
      title={M.hub.title}
      subtitle={M.hub.subtitle}
      backHref={HOME_ROUTE}
      backLabel={M.backToDashboard}
    >
      {write.ok ? null : <ReadOnlyNotice />}
      <section className="grid gap-4 sm:grid-cols-2">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            data-testid={l.testid}
            className="group flex flex-col gap-2 rounded-2xl border border-dr3-steel-light/25 bg-dr3-space-2/70 p-6 transition-colors hover:border-dr3-cyan/50"
          >
            <h2 className="text-lg font-semibold text-dr3-mist">{l.label}</h2>
            <p className="text-sm leading-relaxed text-dr3-mist-dim">{l.description}</p>
            <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-dr3-cyan">
              {M.hub.open}
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                →
              </span>
            </span>
          </Link>
        ))}
      </section>
    </RateShell>
  );
}
