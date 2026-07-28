import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { formatTime, formatRelative } from '@/lib/format';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { PendingBanner } from './pending-banner';
import { QueueClient } from './queue-client';
import { QueueRow } from './queue-row';
import { HOME_ROUTE } from '@/lib/routes';
import { currentPacificDayWindow } from '@/lib/time';
import { FloorPageHeading } from '../../_components/page-heading';

// Expected-loads queue per SPRINT-1-PLAN T-005. Server-renders the
// list of in-window inbound hauls for the operator's site, ordered
// by expected arrival. Auto-refresh + pull-to-refresh are wired in
// the `QueueClient` wrapper.
//
// "In-window" = THE CURRENT PACIFIC DAY ONLY (ADR-0065). It previously meant
// "arriving today or any later date" — an unbounded `gte` that put every future
// load on the queue. On 2026-07-28 that was 14 rows where 1 was actionable.
// Bill's directive for the floor iPad is explicit: "only going to show hauls
// from the current day … no historical or future views."
//
// The bound is Pacific, not server-local. The container runs UTC, so the old
// `new Date(); setHours(0,0,0,0)` computed the UTC day: after 5 PM Pacific the
// queue would silently roll to TOMORROW mid-shift, hiding the loads the
// evening-shift operator was actually working. `currentPacificDayWindow` is the
// same day-key definition `floor-inbound` / `onHand` / the MyMRC bridge use, so
// the iPad and billing agree on what "today" is.
//
// T-006 wires the load workflow that converts an `ExpectedLoad` into an
// `InboundLoad`; until then "started" loads just sit on the queue.
//
// Per ADR-0014 this is the first OPERATOR working surface — green
// palette, not the auth-screen black. The pre-PIN routes
// (name-picker, keypad) keep the dark + canonical-logo treatment;
// the queue is where the work begins.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function OperatorQueuePage({ params }: Props) {
  const { site: siteCode } = await params;
  const session = await auth();
  if (!session?.user) redirect(`/operator/${siteCode}`);
  if (session.user.role !== 'operator') redirect(HOME_ROUTE);

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();
  if (session.user.primary_site_id !== site.id) redirect('/operator');

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const now = new Date();
  const today = currentPacificDayWindow(now);

  const loads = await prisma.expectedLoad.findMany({
    where: {
      site_id: site.id,
      cancelled_at: null,
      // Half-open [start, endExclusive) — current Pacific day only.
      expected_arrival_at: { gte: today.start, lt: today.endExclusive },
    },
    select: {
      id: true,
      expected_arrival_at: true,
      source_name_at_sync: true,
      source: { select: { name: true } },
      transporter_name_at_sync: true,
      transporter: { select: { name: true } },
      bol_number: true,
      expected_unit_count: true,
      last_synced_at: true,
    },
    orderBy: { expected_arrival_at: 'asc' },
  });

  // Last-sync timestamp for the empty-state caption — pulled from
  // the freshest scrape across the site's loads. Once T-013 ships
  // the actual MyMRC scrape it can write a system_state row instead;
  // for now max(last_synced_at) is a reasonable proxy.
  const latest = await prisma.expectedLoad.findFirst({
    where: { site_id: site.id },
    orderBy: { last_synced_at: 'desc' },
    select: { last_synced_at: true },
  });
  const lastSyncAt = latest?.last_synced_at ?? null;

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <FloorPageHeading
          title={t('queue.heading')}
          caption={t('queue.site_caption', { site: site.name, name: session.user.name })}
        />

        <QueueClient lastSyncAt={lastSyncAt?.toISOString() ?? null}>
          <PendingBanner />
          {loads.length === 0 ? (
            <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
              <p className="text-lg font-medium">{t('queue.empty_heading')}</p>
              <p className="mt-2 text-sm text-dr3-cream/70">
                {lastSyncAt
                  ? t('queue.last_sync', { when: formatRelative(lastSyncAt, now, locale) })
                  : t('queue.no_sync_yet')}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {loads.map((l) => {
                const sourceName = l.source?.name ?? l.source_name_at_sync;
                const transporterName =
                  l.transporter?.name ?? l.transporter_name_at_sync ?? t('queue.unknown_carrier');
                const arrival = l.expected_arrival_at;
                return (
                  <li key={l.id}>
                    <QueueRow siteCode={site.code} expectedLoadId={l.id}>
                      {/* No date shown: the queue is current-Pacific-day only
                          (ADR-0065), so every row is today by construction. */}
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xl font-semibold tabular-nums">
                          {formatTime(arrival, locale)}
                        </span>
                      </div>
                      <p className="mt-2 text-base font-medium">{sourceName}</p>
                      <p className="text-sm text-dr3-cream/70">{transporterName}</p>
                      <p className="mt-2 text-xs uppercase tracking-wide text-dr3-cream/60">
                        {t('queue.bol_label')}{' '}
                        <span className="font-mono normal-case text-dr3-cream">
                          {l.bol_number ?? t('queue.bol_dash')}
                        </span>
                        {l.expected_unit_count != null && (
                          <span className="ms-3">
                            {t('queue.approx_units', { count: l.expected_unit_count })}
                          </span>
                        )}
                      </p>
                    </QueueRow>
                  </li>
                );
              })}
            </ul>
          )}
        </QueueClient>
      </div>
    </main>
  );
}
