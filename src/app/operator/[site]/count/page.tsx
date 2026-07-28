import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { onHand } from '@/lib/inventory/running-balance';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { FloorPageHeading } from '../../_components/page-heading';
import { CountClient } from './count-client';

// ADR-0060 F-3 — floor physical on-hand count. Enters a `measured` physical snapshot as
// the new anchor via reconcilePhysicalCount. Establishes Eugene's first anchor.
// Operator-PIN gated + ADR-0065 rollout-gated on its OWN `ipad_count` surface.
// The count is always of on-hand NOW, so it carries no date affordance.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function FloorCountPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkOperatorForSite(siteCode);
  if (!gate.ok) redirect(`/operator/${siteCode}`);
  const { siteId, siteName } = gate.ctx;

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const live = await isUiSurfaceLive(UI_SURFACE.IPAD_COUNT, siteId);

  let expectedTotal = '0';
  let jurisdiction: 'california' | 'oregon' = 'oregon';
  if (live) {
    const [balance, site] = await Promise.all([
      onHand(siteId, new Date()),
      prisma.site.findUnique({ where: { id: siteId }, select: { jurisdiction: true } }),
    ]);
    expectedTotal = balance.total.toString();
    jurisdiction = site?.jurisdiction === 'california' ? 'california' : 'oregon';
  }

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <FloorPageHeading title={t('floor.count.heading')} />

        {!live ? (
          <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        ) : (
          <CountClient
            siteCode={siteCode}
            expectedTotal={Number(expectedTotal)}
            jurisdiction={jurisdiction}
          />
        )}
      </div>
    </main>
  );
}
