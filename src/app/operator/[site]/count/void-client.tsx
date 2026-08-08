'use client';

// ADR-0084 — the operator-facing half of the same-day count void.
//
// JT's ask, literally: "if we accidentally entered the count twice, we should be
// able to remove one." So the screen shows the counts THIS operator entered TODAY
// and offers to remove one, behind a confirm.
//
// Three things this deliberately does NOT do:
//
//   - It does not decide anything. The server re-derives ownership, the site, the
//     Pacific day and the physical/computed kind on every request. This chooses
//     what to OFFER; a bypassed confirm changes nothing (same contract as the
//     ADR-0072 tier dialogs in count-client.tsx).
//   - It does not queue. There is no `enqueueAction` here and no `isOfflineError`
//     branch: a void is online-only (ADR-0084 D5, reasoned in void-count.ts). A
//     failed attempt says so and the count stays exactly as it is — which is the
//     safe direction, because the count is already SAVED. Nothing an operator
//     typed is ever at risk here; only the withdrawal waits for a connection.
//   - It does not touch browser storage (CLAUDE.md hard rule #9), and every
//     control is an `onClick` button rather than a `<form>` (hard rule #10).
//
// Layout is written in flex/gap and centred text so it reads correctly under the
// Urdu RTL direction the app shell sets (hard rule #4); colours are the DR3
// green/black tokens (hard rule #3), with amber reserved — as elsewhere on the
// floor — for "a person needs to look at this".

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { newIdempotencyKey } from '@/lib/offline-queue';

export type VoidableCount = {
  id: string;
  /** Pacific-rendered time-of-day, formatted server-side. */
  countedAtLabel: string;
  physicalTotal: number;
};

type Phase = 'list' | 'confirm' | 'done';

export function CountVoidClient({
  siteCode,
  counts,
}: {
  siteCode: string;
  counts: VoidableCount[];
}) {
  const t = useT();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('list');
  const [target, setTarget] = useState<VoidableCount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmVoid(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/${siteCode}/count/void`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // ADR-0078 — a void is idempotent server-side either way, but the key
          // makes a double-tap replay the ORIGINAL response rather than race the
          // service for it.
          'idempotency-key': newIdempotencyKey(),
        },
        body: JSON.stringify({ snapshotId: target.id }),
      });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const code = String(b['error'] ?? '');
        setError(
          // ADR-0084 D4 — the prior-day refusal is `requires_amendment`-SHAPED
          // and routes to the office. It is NOT the bonus amendment workflow and
          // must never be wired into one; this branch only renders the sentence.
          code === 'requires_amendment'
            ? t('floor.count.void_err_prior_day', { day: String(b['countedDate'] ?? '') })
            : code === 'not_your_count'
              ? t('floor.count.void_err_not_yours')
              : code === 'snapshot_not_found' || code === 'not_a_physical_count'
                ? t('floor.count.void_err_gone')
                : t('floor.common.save_failed'),
        );
        setPhase('list');
        return;
      }
      setPhase('done');
      // The floor total on this page is server-rendered from `onHand`, which has
      // just changed. Refresh so the operator sees the number they restored
      // rather than the one the void removed.
      router.refresh();
    } catch {
      // No offline branch on purpose — see the header. An unreachable server
      // means the count stands, which is the state the operator can see.
      setError(t('floor.common.save_failed'));
      setPhase('list');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'done') {
    return (
      <section
        className="flex flex-col gap-4 rounded-xl bg-dr3-green-dark/40 p-5"
        data-testid="count-void-done"
      >
        <p className="text-center text-lg font-bold">{t('floor.count.void_done')}</p>
      </section>
    );
  }

  if (phase === 'confirm' && target) {
    return (
      <section
        className="flex flex-col gap-5 rounded-xl bg-amber-900/50 p-5 ring-1 ring-amber-400/40"
        data-testid="count-void-confirm"
      >
        <p className="text-lg font-bold">{t('floor.count.void_confirm_heading')}</p>
        <p className="text-sm leading-relaxed text-dr3-cream/85">
          {t('floor.count.void_confirm_body', {
            total: target.physicalTotal.toLocaleString(),
            time: target.countedAtLabel,
          })}
        </p>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
          >
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={confirmVoid}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:opacity-50"
          data-testid="count-void-yes"
        >
          {busy ? t('floor.common.saving') : t('floor.count.void_confirm_yes')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setTarget(null);
            setPhase('list');
          }}
          className="min-h-[56px] rounded-lg bg-dr3-green-dark/60 px-4 py-3 text-lg font-semibold text-dr3-cream disabled:opacity-50"
          data-testid="count-void-no"
        >
          {t('floor.count.void_confirm_no')}
        </button>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-xl bg-dr3-green-dark/30 p-5"
      data-testid="count-void-list"
    >
      <p className="text-base font-bold">{t('floor.count.void_heading')}</p>
      <p className="text-sm text-dr3-cream/70">{t('floor.count.void_intro')}</p>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
        >
          {error}
        </p>
      )}

      {counts.length === 0 ? (
        <p className="text-sm text-dr3-cream/60">{t('floor.count.void_none')}</p>
      ) : (
        counts.map((c) => (
          <div
            key={c.id}
            className="flex flex-col gap-3 rounded-lg bg-dr3-green-dark/50 p-4"
            data-testid="count-void-row"
          >
            <p className="text-2xl font-bold tabular-nums">{c.physicalTotal.toLocaleString()}</p>
            <p className="text-sm text-dr3-cream/70">{c.countedAtLabel}</p>
            <button
              type="button"
              onClick={() => {
                setTarget(c);
                setError(null);
                setPhase('confirm');
              }}
              className="min-h-[48px] rounded-lg bg-transparent px-4 py-2 text-base font-semibold text-dr3-cream/80 underline"
            >
              {t('floor.count.void_action')}
            </button>
          </div>
        ))
      )}
    </section>
  );
}
