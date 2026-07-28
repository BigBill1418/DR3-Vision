import { redirect } from 'next/navigation';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { listFloorInboundDays } from '@/lib/loads/floor-inbound';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { FloorPageHeading } from '../../_components/page-heading';
import { InboundClient } from './inbound-client';

// ADR-0060 F-2 — floor inbound haul-count confirmation. Confirm / correct / enter the
// day's inbound; completes the ADR-0059 confirmation contract. Operator-PIN gated +
// ADR-0065 rollout-gated on its OWN `ipad_inbound` surface (not the shared
// `loads_inventory` master gate), and scoped to the CURRENT PACIFIC DAY only.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function FloorInboundPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkOperatorForSite(siteCode);
  if (!gate.ok) redirect(`/operator/${siteCode}`);
  const { siteId, siteName, userId } = gate.ctx;

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const live = await isUiSurfaceLive(UI_SURFACE.IPAD_INBOUND, siteId);

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <FloorPageHeading title={t('floor.inbound.heading')} />

        {!live ? (
          <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        ) : (
          <InboundClient
            siteCode={siteCode}
            // ADR-0065 — today only; no historical or future days on the iPad.
            initialRows={await listFloorInboundDays(siteId, userId, 1)}
          />
        )}
      </div>
    </main>
  );
}
