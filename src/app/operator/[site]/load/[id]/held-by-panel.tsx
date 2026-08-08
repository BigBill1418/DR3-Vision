'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { LoadStatus } from '@prisma/client';
import { useI18n } from '@/i18n/provider';
import type { Locale } from '@/i18n/config';
import { formatDate, formatTime } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/offline-queue';
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
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const holder = holderName ?? t('takeover.unknown_holder');
  const heldSinceAt = heldSince ? new Date(heldSince) : null;

  const takeOver = () => {
    setError(null);
    const key = newIdempotencyKey();
    startTransition(async () => {
      try {
        await takeOverLoadAction(key, siteCode, loadId);
        // No client-side navigation: the action revalidates this path, so the
        // server re-renders it as the workflow. Pushing a route here would race
        // the revalidation and could paint the held-by panel again from cache.
        setConfirming(false);
      } catch (e) {
        // ADR-0082 — the ONE message this screen must never show is a blank
        // one. A server action's throw arrives as an opaque digest, so the copy
        // is resolved locally: "somebody else took it" is the outcome worth
        // naming, and everything else falls back to "try again".
        const reason = e instanceof Error ? e.message : '';
        setError(reason.includes('load_claim_moved') ? 'takeover.error_moved' : 'takeover.error');
        setConfirming(false);
      }
    });
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
          {t(error)}
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
