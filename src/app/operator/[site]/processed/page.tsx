import { redirect } from 'next/navigation';
import Link from 'next/link';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { listProcessedUnits } from '@/lib/loads/processed-units';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { pacificDayISO, dayISO } from '@/lib/time';
import { ProcessedClient } from './processed-client';

// ADR-0060 F-4 (P2) — floor processed / stripped count confirmation. Confirm-only: the
// floor confirms the day's core stripped counts; payroll-adjacent fields stay on the
// manager surface. Operator-PIN gated + ADR-0047 rollout-gated.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function FloorProcessedPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkOperatorForSite(siteCode);
  if (!gate.ok) redirect(`/operator/${siteCode}`);
  const { siteId, siteName } = gate.ctx;

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const live = await isUiSurfaceLive(UI_SURFACE.LOADS_INVENTORY, siteId);

  const todayISO = pacificDayISO(new Date());
  let todayProgram = 0;
  let todayNonProgram = 0;
  let todayClosed = false;
  if (live) {
    const rows = await listProcessedUnits(siteId, 30);
    const today = rows.find((r) => dayISO(r.productionDate) === todayISO);
    if (today) {
      todayProgram = Math.round(Number(today.strippedProgram));
      todayNonProgram = Math.round(Number(today.strippedNonProgram));
      todayClosed = today.closedAt != null;
    }
  }

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
          <h1 className="text-2xl font-bold tracking-tight">{t('floor.processed.heading')}</h1>
        </header>

        {!live ? (
          <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        ) : (
          <ProcessedClient
            siteCode={siteCode}
            productionDate={todayISO}
            initialProgram={todayProgram}
            initialNonProgram={todayNonProgram}
            closed={todayClosed}
          />
        )}
      </div>
    </main>
  );
}
