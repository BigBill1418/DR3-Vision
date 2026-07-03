// ADR-0040 D5 — fuel_prices admin page. manager+ read; rate-manager manual entry.

import { redirect } from 'next/navigation';
import { checkRateRead, checkRateManager } from '@/lib/auth-helpers';
import { listFuelPrices } from '@/lib/billing-rates/admin-rates';
import { rateMessages as M } from '../messages';
import { RateForbidden, RateShell, ReadOnlyNotice } from '../shell';
import { FuelPricesClient } from './FuelPricesClient';

export const dynamic = 'force-dynamic';

export default async function FuelPricesPage() {
  const gate = await checkRateRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/billing-rates/fuel-prices');
    return <RateForbidden />;
  }
  const write = await checkRateManager();
  const prices = await listFuelPrices(52);

  return (
    <RateShell
      title={M.fuel.title}
      subtitle={M.fuel.subtitle}
      backHref="/admin/billing-rates"
      backLabel={M.backToRates}
    >
      {write.ok ? null : <ReadOnlyNotice />}
      <FuelPricesClient prices={prices} canWrite={write.ok} />
    </RateShell>
  );
}
