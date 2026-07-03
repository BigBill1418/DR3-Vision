// ADR-0040 D5 — account_haul_rates admin page. manager+ read; rate-manager write.
// Seeds empty by design (Rick adds overrides from the workbook) — the client
// renders an honest empty state.

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkRateRead, checkRateManager } from '@/lib/auth-helpers';
import { listHaulRates } from '@/lib/billing-rates/admin-rates';
import { rateMessages as M } from '../messages';
import { RateForbidden, RateShell, ReadOnlyNotice } from '../shell';
import { HaulRatesClient } from './HaulRatesClient';

export const dynamic = 'force-dynamic';

export default async function HaulRatesPage() {
  const gate = await checkRateRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/billing-rates/haul-rates');
    return <RateForbidden />;
  }
  const write = await checkRateManager();
  const [rates, sources, sites] = await Promise.all([
    listHaulRates(),
    prisma.source.findMany({ where: { is_active: true }, select: { id: true, name: true, site_id: true }, orderBy: { name: 'asc' } }),
    prisma.site.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  return (
    <RateShell
      title={M.haul.title}
      subtitle={M.haul.subtitle}
      backHref="/admin/billing-rates"
      backLabel={M.backToRates}
    >
      {write.ok ? null : <ReadOnlyNotice />}
      <HaulRatesClient rates={rates} sources={sources} sites={sites} canWrite={write.ok} />
    </RateShell>
  );
}
