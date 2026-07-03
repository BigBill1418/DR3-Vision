// ADR-0040 D5 — container_rental_sites admin page. manager+ read; rate-manager write.
// Seeds empty by design (Rick settles the values) — honest empty state + a
// computed "monthly total of active rows in force" summary.

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkRateRead, checkRateManager } from '@/lib/auth-helpers';
import { listRentals } from '@/lib/billing-rates/admin-rates';
import { rateMessages as M } from '../messages';
import { RateForbidden, RateShell, ReadOnlyNotice } from '../shell';
import { RentalsClient } from './RentalsClient';

export const dynamic = 'force-dynamic';

export default async function RentalsPage() {
  const gate = await checkRateRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/billing-rates/rentals');
    return <RateForbidden />;
  }
  const write = await checkRateManager();
  const [rentals, sources, sites] = await Promise.all([
    listRentals(),
    prisma.source.findMany({ where: { is_active: true }, select: { id: true, name: true, site_id: true }, orderBy: { name: 'asc' } }),
    prisma.site.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  return (
    <RateShell
      title={M.rentals.title}
      subtitle={M.rentals.subtitle}
      backHref="/admin/billing-rates"
      backLabel={M.backToRates}
    >
      {write.ok ? null : <ReadOnlyNotice />}
      <RentalsClient rentals={rentals} sources={sources} sites={sites} canWrite={write.ok} />
    </RateShell>
  );
}
