// ADR-0040 D5 — transport_rate_tiers admin page. manager+ read; rate-manager write.

import { redirect } from 'next/navigation';
import { checkRateRead, checkRateManager } from '@/lib/auth-helpers';
import { listTiers } from '@/lib/billing-rates/admin-rates';
import { rateMessages as M } from '../messages';
import { RateForbidden, RateShell, ReadOnlyNotice } from '../shell';
import { TiersClient } from './TiersClient';

export const dynamic = 'force-dynamic';

export default async function TransportTiersPage() {
  const gate = await checkRateRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/billing-rates/tiers');
    return <RateForbidden />;
  }
  const write = await checkRateManager();
  const tiers = await listTiers();

  return (
    <RateShell
      title={M.tiers.title}
      subtitle={M.tiers.subtitle}
      backHref="/admin/billing-rates"
      backLabel={M.backToRates}
    >
      {write.ok ? null : <ReadOnlyNotice />}
      <TiersClient tiers={tiers} canWrite={write.ok} />
    </RateShell>
  );
}
