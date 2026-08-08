import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { onHand } from '@/lib/inventory/running-balance';
import { countUnconfirmedInboundDays } from '@/lib/loads/floor-inbound';
import { countPendingPortalHauls } from '@/lib/loads/portal-hauls';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate, translatePlural } from '@/i18n/dictionary';
import { FloorPageHeading } from '../../_components/page-heading';

// ADR-0060 F-1 / ADR-0065 — the floor daily-validation HUB and shift landing
// (post-PIN, `keypad.tsx` lands here).
//
// THE HUB IS NEVER ROLLOUT-GATED. Bill: "leave the site picker do not strand
// anyone." PIN success routes here, so gating the hub itself would drop a
// successfully-authenticated operator onto a dead screen with no way forward.
// What IS gated, each on its OWN ADR-0065 surface, is the CONTENT:
//
//   ipad_today_summary  the F-1 on-hand summary block
//   ipad_inbound        the "confirm inbound" card
//   ipad_count          the "count on hand" card
//   ipad_processed      the "confirm processed" card
//   ipad_queue          the truck-queue card (previously hardcoded un-gated)
//
// Every card is now gated, including the queue — an operator must never see a
// card whose destination will refuse them. If every surface is off, the hub
// still renders: the heading, an explanation, and the chrome's Log Out. Bounded,
// honest, and never a dead end.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

type Card = { href: string; title: string; body: string; badge?: string };

export default async function FloorTodayPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkOperatorForSite(siteCode);
  if (!gate.ok) redirect(`/operator/${siteCode}`);
  const { siteId, siteName } = gate.ctx;

  const session = await auth();
  const operatorName = session?.user?.name ?? '';

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const [summaryLive, inboundLive, countLive, processedLive, queueLive, haulsLive, dropoffLive] =
    await Promise.all([
      isUiSurfaceLive(UI_SURFACE.IPAD_TODAY_SUMMARY, siteId),
      isUiSurfaceLive(UI_SURFACE.IPAD_INBOUND, siteId),
      isUiSurfaceLive(UI_SURFACE.IPAD_COUNT, siteId),
      isUiSurfaceLive(UI_SURFACE.IPAD_PROCESSED, siteId),
      isUiSurfaceLive(UI_SURFACE.IPAD_QUEUE, siteId),
      // ADR-0074 — the open portal-haul read surface, on its own gate.
      isUiSurfaceLive(UI_SURFACE.IPAD_HAULS, siteId),
      // ADR-0085 — walk-up drop-off capture, on its own gate.
      isUiSurfaceLive(UI_SURFACE.IPAD_DROPOFF, siteId),
    ]);

  const now = new Date();
  const balance = summaryLive ? await onHand(siteId, now) : null;

  // ADR-0065 — the badge counted a 14-DAY lookback, which is exactly the
  // historical view Bill ruled out for the floor. Scoped to the current
  // Pacific day, so it means "today still needs confirming".
  const unconfirmedToday = inboundLive ? await countUnconfirmedInboundDays(siteId, 1, now) : 0;

  const cards: Card[] = [];
  if (inboundLive) {
    cards.push({
      href: `/operator/${siteCode}/inbound`,
      title: t('floor.hub.card_inbound_title'),
      body: t('floor.hub.card_inbound_body'),
      ...(unconfirmedToday > 0
        ? { badge: translatePlural(dict, 'floor.hub.card_inbound_badge', unconfirmedToday) }
        : {}),
    });
  }
  if (countLive) {
    cards.push({
      href: `/operator/${siteCode}/count`,
      title: t('floor.hub.card_count_title'),
      body: t('floor.hub.card_count_body'),
    });
  }
  if (processedLive) {
    cards.push({
      href: `/operator/${siteCode}/processed`,
      title: t('floor.hub.card_processed_title'),
      body: t('floor.hub.card_processed_body'),
    });
  }
  if (queueLive) {
    cards.push({
      href: `/operator/${siteCode}/queue`,
      title: t('floor.hub.card_queue_title'),
      body: t('floor.hub.card_queue_body'),
    });
  }
  if (dropoffLive) {
    // ADR-0085 — JT's "tile or static button". No badge: a drop-off is a
    // walk-up, so there is no pending queue of them to count, and a "0" the
    // operator has to decode is worse than nothing.
    cards.push({
      href: `/operator/${siteCode}/dropoff`,
      title: t('floor.hub.card_dropoff_title'),
      body: t('floor.hub.card_dropoff_body'),
    });
  }
  if (haulsLive) {
    // ADR-0074 — the badge is the count of hauls MyMRC has scheduled but not yet
    // marked delivered. Read-only and cheap; omitted entirely at zero rather than
    // rendering a "0" the operator has to decode.
    const pendingHauls = await countPendingPortalHauls(siteId);
    cards.push({
      href: `/operator/${siteCode}/hauls`,
      title: t('floor.hub.card_hauls_title'),
      body: t('floor.hub.card_hauls_body'),
      ...(pendingHauls > 0
        ? { badge: translatePlural(dict, 'floor.hub.card_hauls_badge', pendingHauls) }
        : {}),
    });
  }

  const renderCard = (c: Card) => (
    <li key={c.href}>
      <Link
        href={c.href}
        className="flex min-h-[88px] items-center justify-between gap-4 rounded-xl bg-dr3-green px-6 py-5 text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream active:bg-dr3-green-dark"
      >
        <span>
          <span className="block text-xl font-bold">{c.title}</span>
          <span className="mt-1 block text-sm opacity-80">{c.body}</span>
        </span>
        {c.badge && (
          <span className="shrink-0 rounded-full bg-dr3-chartreuse px-3 py-1 text-sm font-bold text-dr3-ink">
            {c.badge}
          </span>
        )}
      </Link>
    </li>
  );

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <FloorPageHeading
          title={t('floor.hub.heading')}
          caption={t('floor.hub.caption', { site: siteName, name: operatorName })}
        />

        {summaryLive && balance && (
          <section className="rounded-xl bg-dr3-green-dark/50 p-6">
            <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
              {t('floor.hub.on_hand_heading')}
            </p>
            <p className="mt-1 text-5xl font-bold tabular-nums">{balance.total.toString()}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.program')} {balance.program.toString()} ·{' '}
              {t('floor.common.non_program')} {balance.nonProgram.toString()}
            </p>
          </section>
        )}

        {cards.length > 0 ? (
          <ul className="flex flex-col gap-3">{cards.map(renderCard)}</ul>
        ) : (
          // Every surface is off. Still not a dead end: the operator keeps the
          // chrome's Log Out and knows why the screen is empty.
          <div className="rounded-lg bg-dr3-green-dark/40 p-6 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
