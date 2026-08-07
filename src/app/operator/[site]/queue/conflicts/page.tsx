import { redirect } from 'next/navigation';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { pacificDayISO } from '@/lib/time';
import { FloorPageHeading } from '../../../_components/page-heading';
import { ConflictsClient } from './conflicts-client';

// ADR-0078 — where a refused queue entry goes to be resolved by a person.
//
// The queue can reach exactly one state it must not resolve on its own: an entry
// whose target day is no longer today. Writing it anyway files a count against
// the wrong production day; dropping it loses the operator's work. Both are
// silent, and this ADR's whole premise is that neither happens quietly — so the
// entry is held, and this screen is where it becomes visible and actionable.
//
// It rides the EXISTING `ipad_queue` gate rather than minting a rollout surface
// of its own. A conflicts screen is not a feature to ramp independently; it is
// the other half of a queue that is already live, and a version of it that could
// be switched off separately would leave stuck entries with nowhere to surface.
//
// It lives UNDER /queue deliberately: `resolveFloorNav` keys the floor chrome on
// the second path segment, so nesting here inherits back-to-hub and Log Out
// without touching `WORK_SEGMENTS` at all — verified, not assumed.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function FloorQueueConflictsPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkOperatorForSite(siteCode);
  if (!gate.ok) redirect(`/operator/${siteCode}`);
  const { siteId, siteName } = gate.ctx;

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const live = await isUiSurfaceLive(UI_SURFACE.IPAD_QUEUE, siteId);

  // Pacific, from the shared helper — never `new Date().toISOString()`, which
  // rolls a day early for every operator west of Greenwich after 5 PM.
  const todayISO = pacificDayISO(new Date());

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <FloorPageHeading title={t('floor.conflicts.heading')} />

        {!live ? (
          <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        ) : (
          <ConflictsClient siteCode={siteCode} todayISO={todayISO} />
        )}
      </div>
    </main>
  );
}
