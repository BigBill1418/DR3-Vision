'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { LoadStatus } from '@prisma/client';
import { useI18n } from '@/i18n/provider';
import type { Locale } from '@/i18n/config';
import { formatDate, formatTime } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/offline-queue';
import type { TakeoverActionResult } from '@/lib/loads/load-claim';
import { takeOverLoadAction } from '../../actions';

// ADR-0082 — what a second operator sees instead of a silent bounce.
//
// This screen replaces `redirect('/operator/<site>/queue')`. The whole defect it
// closes is one of SILENCE: the load was held, the device said nothing, and the
// holder's name existed nowhere on the iPad. So the first job here is to print a
// name, and only the second is to offer the button.
//
// The confirm step is a deliberate two-tap, not a `window.confirm()`. Taking a
// load over moves who is answerable for a truck's count, and a gloved thumb on a
// dock iPad finds a single primary button by accident more often than anyone
// would like. Two taps, in-component, per CLAUDE.md hard rule #10 (onClick, never
// a `<form>`).

const STATUS_KEY: Record<string, string> = {
  arrived: 'queue.open_status_arrived',
  weight_captured: 'queue.open_status_weight_captured',
  unload_started: 'queue.open_status_unload_started',
  in_progress: 'queue.open_status_in_progress',
  finished: 'queue.open_status_finished',
};

type Props = {
  siteCode: string;
  loadId: string;
  holderName: string | null;
  /** ISO instant — formatted here, Pacific-pinned by `@/lib/format`. */
  heldSince: string | null;
  sourceName: string | null;
  transporterName: string | null;
  bolNumber: string | null;
  status: LoadStatus;
  totalUnits: number | null;
  /** False for a load the service would refuse — the button is not offered. */
  takeable: boolean;
  locale: Locale;
};

export function HeldByPanel({
  siteCode,
  loadId,
  holderName,
  heldSince,
  sourceName,
  transporterName,
  bolNumber,
  status,
  totalUnits,
  takeable,
  locale,
}: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<TakeoverActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const holder = holderName ?? t('takeover.unknown_holder');
  const heldSinceAt = heldSince ? new Date(heldSince) : null;

  const takeOver = () => {
    setError(null);
    const key = newIdempotencyKey();
    startTransition(async () => {
      // ADR-0082 Am.1 — the outcome is READ FROM THE RETURN VALUE, never from a
      // thrown message. The first cut did `e.message.includes('load_claim_moved')`,
      // which contradicts `use-claim-loss-guard.ts` in the same directory: a
      // Server Action's throw is REDACTED in production, so that match could
      // never fire live and every lost race would have rendered the generic
      // "try again" — a retry into a contest that is already over. Return values
      // are not redacted.
      let result: TakeoverActionResult;
      try {
        result = await takeOverLoadAction(key, siteCode, loadId);
      } catch {
        // Genuinely exceptional (the three unreachable refusals, or a real 500).
        // The catch no longer INSPECTS anything — it maps any throw to the one
        // honest generic. That is the whole difference from the first cut.
        result = { outcome: 'failed', holderName: null };
      }
      setConfirming(false);
      if (result.outcome === 'taken' || result.outcome === 'already_yours') {
        // The action revalidated this path, so the server re-renders it as the
        // workflow. Pushing a route here would race the revalidation and could
        // paint the held-by panel again from cache.
        return;
      }
      setError(result);
      // The header above still names the OLD holder. Refreshing re-renders the
      // server component with whoever actually has it, so the screen and the
      // message agree. Client state (this banner) survives a refresh.
      router.refresh();
    });
  };

  /** Copy for a non-success outcome. Every branch names something. */
  const errorCopy = (r: TakeoverActionResult): string => {
    const name = r.holderName ?? t('takeover.unknown_holder');
    if (r.outcome === 'claim_moved') return t('takeover.error_moved', { name });
    if (r.outcome === 'not_open') return t('takeover.error_not_open');
    if (r.outcome === 'not_takeable') return t('takeover.not_takeable');
    return t('takeover.error');
  };

  return (
    <section className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold">{sourceName ?? t('load_header.unknown_source')}</h1>
        <p className="text-sm text-dr3-cream/70">
          {transporterName ?? t('load_header.unknown_carrier')} · {t('load_header.bol_label')}{' '}
          <span className="font-mono">{bolNumber ?? t('load_header.bol_dash')}</span>
        </p>
      </header>

      <div className="rounded-xl bg-dr3-chartreuse/10 p-5 ring-1 ring-dr3-chartreuse/40">
        {/* The name is the headline. Everything else on this panel is detail. */}
        <p className="text-lg font-bold">{t('takeover.held_by', { name: holder })}</p>
        <p className="mt-1 text-sm text-dr3-cream/70">
          {t(STATUS_KEY[status] ?? 'queue.open_status_in_progress')}
          {heldSinceAt && (
            <>
              {' · '}
              {t('takeover.held_since', {
                when: `${formatDate(heldSinceAt, locale)} ${formatTime(heldSinceAt, locale)}`,
              })}
            </>
          )}
          {totalUnits != null && (
            <>
              {' · '}
              {t('queue.open_units', { count: totalUnits })}
            </>
          )}
        </p>
        <p className="mt-3 text-sm text-dr3-cream/70">{t('takeover.explain')}</p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-dr3-ink/60 p-3 text-sm text-dr3-chartreuse">
          {errorCopy(error)}
        </p>
      )}

      {takeable ? (
        confirming ? (
          <div className="flex flex-col gap-3">
            <p className="text-base font-medium">
              {t('takeover.confirm_question', { name: holder })}
            </p>
            <p className="text-sm text-dr3-cream/70">{t('takeover.confirm_detail')}</p>
            <button
              type="button"
              disabled={isPending}
              onClick={takeOver}
              className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-base font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? t('takeover.working') : t('takeover.confirm_yes')}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setConfirming(false)}
              className="min-h-[44px] rounded-lg bg-dr3-green-dark/40 px-4 py-2 text-base transition-colors hover:bg-dr3-green-dark/70 disabled:opacity-60"
            >
              {t('takeover.confirm_no')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-base font-bold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream"
          >
            {t('takeover.take_over')}
          </button>
        )
      ) : (
        // Not takeable ⇒ say so rather than showing nothing. A blank panel is the
        // silence this ADR exists to remove.
        <p className="rounded-md bg-dr3-green-dark/40 p-4 text-sm">{t('takeover.not_takeable')}</p>
      )}

      <Link
        href={`/operator/${siteCode}/queue`}
        className="min-h-[44px] rounded-lg bg-dr3-green-dark/40 px-4 py-3 text-center text-base transition-colors hover:bg-dr3-green-dark/70"
      >
        {t('takeover.back_to_queue')}
      </Link>
    </section>
  );
}
