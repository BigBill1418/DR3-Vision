import { redirect } from 'next/navigation';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { pacificDayISO } from '@/lib/time';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { FloorPageHeading } from '../../_components/page-heading';
import { DropoffClient } from './dropoff-client';

// ADR-0085 — walk-up Public / Incentive drop-off capture.
//
// JT: *"a tile or static button on the iPad; hitting it prompts Public Drop Off
// or Incentive Drop, then asks for total units and a photo; contributes to daily
// inbound and inventory."*
//
// Operator-PIN gated + ADR-0047 rollout-gated on its OWN `ipad_dropoff` surface.
// The gate DEGRADES to the translated "not turned on yet" block rather than a
// redirect or a 404: a bookmarked URL on a floor iPad must never become a dead
// end (the floor-surface-coverage trap asserts exactly this). The security
// boundary is the API, not this branch.
//
// The day is rendered SERVER-side from `pacificDayISO`, never from the device
// clock. A floor iPad's clock is whatever it was last set to, and a drop-off
// filed against the wrong day moves the inventory ledger on two days at once.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function FloorDropoffPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkOperatorForSite(siteCode);
  if (!gate.ok) redirect(`/operator/${siteCode}`);
  const { siteId, siteName } = gate.ctx;

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const live = await isUiSurfaceLive(UI_SURFACE.IPAD_DROPOFF, siteId);

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <FloorPageHeading
          title={t('floor.dropoff.heading')}
          caption={t('floor.dropoff.caption', { site: siteName })}
        />

        {!live ? (
          <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        ) : (
          <DropoffClient siteCode={siteCode} dropoffDate={pacificDayISO(new Date())} />
        )}
      </div>
    </main>
  );
}
