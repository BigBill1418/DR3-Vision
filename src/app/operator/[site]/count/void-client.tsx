'use client';

// ADR-0084 — the operator-facing half of the same-day count void.
//
// JT's ask, literally: "if we accidentally entered the count twice, we should be
// able to remove one." So the screen shows TODAY's counts at this site and
// offers to remove one, behind a confirm.
//
// Amendment 1 (2026-08-08) — Bill: "Widen to site." The list is no longer
// filtered to the signed-in operator's own counts, because floor iPads are
// shared kiosks and the person standing at one at 15:00 is frequently not the
// person who mistyped at 14:00. A count somebody else entered is LABELLED with
// their name and the confirm step says so explicitly — the widened gate is
// paired with telling the operator exactly whose work they are withdrawing.
// The `not_your_count` branch is gone with the 403 it rendered.
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
  /**
   * The name of the operator who entered it, or null when the signed-in operator
   * entered it themselves (or the enterer could not be resolved). Null means
   * "say nothing" — never "you", and never a placeholder.
   */
  enteredByLabel: string | null;
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
            : // ADR-0084 Amendment 1 — there is no `not_your_count` branch any
              // more, because the server no longer produces that refusal. A
              // wrong-SITE id still lands here as `snapshot_not_found` (a 404,
              // never a 403 — hard rule #2, no id probing).
              code === 'snapshot_not_found' || code === 'not_a_physical_count'
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

        {/* ADR-0084 Amendment 1 — the site-scoped half of the confirm. Shown
            ONLY for somebody else's count: it names them, and it says the
            withdrawal is recorded under the signed-in operator's name, which is
            exactly what the audit row now carries (both ids). This sentence is
            the trade for the widened gate — do not remove it without also
            re-narrowing the gate. */}
        {target.enteredByLabel !== null && (
          <p
            className="rounded-lg bg-amber-950/50 px-4 py-3 text-sm leading-relaxed text-dr3-cream/90"
            data-testid="count-void-cross-operator"
          >
            {t('floor.count.void_confirm_other', { name: target.enteredByLabel })}
          </p>
        )}

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
            {c.enteredByLabel !== null && (
              <p className="text-sm font-medium text-amber-200" data-testid="count-void-row-by">
                {t('floor.count.void_entered_by', { name: c.enteredByLabel })}
              </p>
            )}
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
