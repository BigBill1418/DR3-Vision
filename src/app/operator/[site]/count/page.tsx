import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { onHand } from '@/lib/inventory/running-balance';
import { loadPriorAnchor, loadSwingThresholdPct } from '@/lib/inventory/anchor-guardrail';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { formatPacificDateTime, pacificDayISO } from '@/lib/time';
import { listTodaysVoidableCounts } from '@/lib/inventory/void-count';
import { FloorPageHeading } from '../../_components/page-heading';
import { CountClient } from './count-client';
import { CountVoidClient, type VoidableCount } from './void-client';

// ADR-0060 F-3 — floor physical on-hand count. Enters a `measured` physical snapshot as
// the new anchor via reconcilePhysicalCount. Establishes Eugene's first anchor.
// Operator-PIN gated + ADR-0065 rollout-gated on its OWN `ipad_count` surface.
// The count is always of on-hand NOW, so it carries no date affordance in the UI —
// but ADR-0078 D10 makes the DAY explicit in the request. Derived here, server-side
// and in Pacific: the iPad's own clock is not trustworthy enough to decide which
// production day a count is filed against.

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
  // ADR-0072 — the anchor this count would REPLACE, and the site's swing
  // threshold. Both are read here only to decide which screen the operator sees;
  // the write path recomputes them, so a stale render cannot widen the gate.
  let priorTotal: number | null = null;
  let thresholdPct = 20;
  // ADR-0084 — today's counts THIS operator entered, resolved server-side. Sent
  // as already-rendered Pacific strings rather than Dates: the prop crosses the
  // server/client boundary, and a raw Date would be re-formatted in the browser's
  // zone — the iPad's clock is exactly what the whole day-discipline chain
  // (ADR-0065, ADR-0078 D10) refuses to trust.
  let voidable: VoidableCount[] = [];
  if (live) {
    const [balance, site, prior, threshold, todays] = await Promise.all([
      onHand(siteId, new Date()),
      prisma.site.findUnique({ where: { id: siteId }, select: { jurisdiction: true } }),
      loadPriorAnchor(prisma, siteId),
      loadSwingThresholdPct(prisma, siteId),
      listTodaysVoidableCounts(siteId, gate.ctx.userId),
    ]);
    expectedTotal = balance.total.toString();
    jurisdiction = site?.jurisdiction === 'california' ? 'california' : 'oregon';
    priorTotal = prior?.total ?? null;
    thresholdPct = threshold;
    voidable = todays.map((c) => ({
      id: c.id,
      countedAtLabel: formatPacificDateTime(c.enteredAt, locale, { timeStyle: 'short' }),
      physicalTotal: c.physicalTotal,
    }));
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
          <>
            <CountClient
              siteCode={siteCode}
              expectedTotal={Number(expectedTotal)}
              jurisdiction={jurisdiction}
              priorTotal={priorTotal}
              thresholdPct={thresholdPct}
              countDate={pacificDayISO(new Date())}
            />
            {/* ADR-0084 — rendered only when there IS something to withdraw, so
                the entry screen is not carrying a permanently-empty panel. The
                affordance appears the moment a count exists and disappears at
                the Pacific day roll, which matches what the server will accept. */}
            {voidable.length > 0 && <CountVoidClient siteCode={siteCode} counts={voidable} />}
          </>
        )}
      </div>
    </main>
  );
}
