import { redirect } from 'next/navigation';
import Link from 'next/link';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { listFloorInboundDays } from '@/lib/loads/floor-inbound';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { InboundClient } from './inbound-client';

// ADR-0060 F-2 — floor inbound haul-count confirmation. Confirm / correct / enter the
// day's inbound; completes the ADR-0059 confirmation contract. Operator-PIN gated +
// ADR-0047 rollout-gated.

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

  const live = await isUiSurfaceLive(UI_SURFACE.LOADS_INVENTORY, siteId);

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-8 text-dr3-cream">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <Link
            href={`/operator/${siteCode}/today`}
            className="self-start rounded-md px-2 py-2 text-base font-semibold text-dr3-cream/80 hover:text-dr3-cream"
          >
            {t('floor.common.back')}
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{t('floor.inbound.heading')}</h1>
        </header>

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
            initialRows={await listFloorInboundDays(siteId, userId)}
          />
        )}
      </div>
    </main>
  );
}
