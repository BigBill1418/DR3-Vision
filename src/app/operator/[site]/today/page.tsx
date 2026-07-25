import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { onHand } from '@/lib/inventory/running-balance';
import { countUnconfirmedInboundDays } from '@/lib/loads/floor-inbound';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate, translatePlural } from '@/i18n/dictionary';
import { SignOutButton } from '../queue/sign-out-button';

// ADR-0060 F-1 — floor daily-validation HUB and shift landing (post-PIN). On-hand
// headline + entry cards for the three validation tasks (confirm inbound, count on-hand,
// confirm processed) when the site's ADR-0047 loads_inventory surface is live, plus the
// pre-existing per-load queue card which stays reachable regardless of rollout state.

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

  const live = await isUiSurfaceLive(UI_SURFACE.LOADS_INVENTORY, siteId);

  const now = new Date();
  const [balance, unconfirmed] = live
    ? await Promise.all([onHand(siteId, now), countUnconfirmedInboundDays(siteId, 14, now)])
    : [null, 0];

  const validationCards: Card[] = live
    ? [
        {
          href: `/operator/${siteCode}/inbound`,
          title: t('floor.hub.card_inbound_title'),
          body: t('floor.hub.card_inbound_body'),
          ...(unconfirmed > 0
            ? { badge: translatePlural(dict, 'floor.hub.card_inbound_badge', unconfirmed) }
            : {}),
        },
        {
          href: `/operator/${siteCode}/count`,
          title: t('floor.hub.card_count_title'),
          body: t('floor.hub.card_count_body'),
        },
        {
          href: `/operator/${siteCode}/processed`,
          title: t('floor.hub.card_processed_title'),
          body: t('floor.hub.card_processed_body'),
        },
      ]
    : [];

  // The per-load queue is the pre-existing surface — always reachable, not rollout-gated.
  const queueCard: Card = {
    href: `/operator/${siteCode}/queue`,
    title: t('floor.hub.card_queue_title'),
    body: t('floor.hub.card_queue_body'),
  };

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
    <main className="min-h-screen bg-dr3-green-deep px-6 py-8 text-dr3-cream">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('floor.hub.heading')}</h1>
            <p className="text-sm text-dr3-cream/70">
              {t('floor.hub.caption', { site: siteName, name: operatorName })}
            </p>
          </div>
          <SignOutButton siteCode={siteCode} />
        </header>

        {live && balance && (
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

        {!live && (
          <div className="rounded-lg bg-dr3-green-dark/40 p-6 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        )}

        <ul className="flex flex-col gap-3">
          {validationCards.map(renderCard)}
          {renderCard(queueCard)}
        </ul>
      </div>
    </main>
  );
}
