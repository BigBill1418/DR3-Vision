'use client';

import type { CountMode, LoadStatus, PhotoKind } from '@prisma/client';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { useI18n } from '@/i18n/provider';
import { pendingActionsForLoad } from '@/lib/offline-queue';
import { correctWeightAction, reopenLoadAction, voidStackAction } from '../../actions';
import { useClaimLossGuard } from './use-claim-loss-guard';

// ADR-0090 Amendment 1 (B) — the way BACK.
//
// JT, Woodland, 2026-08-10:
//
//   "You can't click the back button after clicking next. It'll be nice to have
//    the back function. Example: when you click a haul, take a pic, then enter
//    weight, click enter or next, start unload, enter units received — if you
//    want to go back to fix or check what you entered is correct, vision doesn't
//    let you."
//
// Two asks in one sentence, and they have very different costs. CHECKING is free
// and always safe; FIXING has to respect what the server already committed. This
// panel is the single place both live, so the read is never gated behind the
// write's conditions.
//
// ## Why a panel and not a route
//
// All seven stages render at one url, and ADR-0065 rules out `router.back()`
// outright: the offline queue plus `revalidatePath` + `redirect` make browser
// history a lie about where the operator came from. So "back" is a view of the
// SAME load, driven by client state in `load-workflow.tsx`, and every exit from
// it lands the operator on the stage the server says they are on. There is no
// way to get lost.
//
// ## The three corrections, and the one thing that gates all of them
//
//   - WEIGHT — an overwrite before `submitted`, appended to the audit log rather
//     than mutating the first record.
//   - STACK — a soft void while `in_progress`; the row survives as evidence and
//     leaves both billed sums.
//   - REOPEN — `finished → in_progress`. Bill's call, 2026-08-10: the unload
//     duration FREEZES at the first finish, so going back to fix a number can
//     never make an operator look slow. That is the sentence the explainer copy
//     says out loud, because an operator who fears the timer will not use the
//     button.
//
// All three are ONLINE-ONLY (see `actions.ts`). That leaves one ordering hazard,
// and it is silent: a write queued BEFORE the correction — a stack, a finish —
// replays LATER and lands on top of it. So every correction is withheld while
// this load has unsent work, and the panel SAYS SO. A control that is simply
// absent teaches the operator the feature is broken; a sentence explaining that
// their earlier taps are still in flight teaches them to wait.
//
// Photos are review-only: they are already committed, and re-taking one is
// re-doing the stage, not correcting an entry.

/** The photo kinds this panel reports on, in the order the workflow captures them. */
const REVIEWED_PHOTO_KINDS: PhotoKind[] = ['bol', 'weight_ticket', 'door_open'];

/** Mirrors `CORRECTABLE_STATUSES` in `load-service.ts`. See the note below. */
const WEIGHT_CORRECTABLE: readonly LoadStatus[] = [
  'weight_captured',
  'unload_started',
  'in_progress',
  'finished',
] as const;

export type ReviewStack = {
  id: string;
  stack_index: number;
  unit_count: number;
  count_mode: CountMode;
  /** ISO instant, or null while the stack still counts. */
  voided_at: string | null;
};

export type ReviewLoad = {
  id: string;
  status: LoadStatus;
  weightLbs: number | null;
  photoKinds: PhotoKind[];
  stacks: ReviewStack[];
};

type Props = {
  siteCode: string;
  load: ReviewLoad;
  onClose: () => void;
};

export function ReviewPanel({ siteCode, load, onClose }: Props) {
  const { t, locale } = useI18n();
  const [isPending, startTransition] = useTransition();
  // ADR-0082 — a refusal may be a takeover, and a Server Action's message is
  // redacted in production, so the client cannot read why. Asked, not guessed.
  const claimLost = useClaimLossGuard(siteCode, load.id);
  const [error, setError] = useState<string | null>(null);
  const [editingWeight, setEditingWeight] = useState(false);
  const [lbs, setLbs] = useState('');
  const [unsent, setUnsent] = useState(0);

  // Re-read rather than read once. The operator can sit on this panel while the
  // chrome's replay loop drains the queue, and a correction that was correctly
  // withheld a moment ago must become available WITHOUT a reload — otherwise the
  // honest guard reads as the dead end it exists to prevent.
  useEffect(() => {
    let live = true;
    const read = () => {
      pendingActionsForLoad(load.id)
        .then((n) => {
          if (live) setUnsent(n);
        })
        // IndexedDB is unavailable during SSR and in a private-mode browser.
        // FAIL-CLOSED: an unreadable queue is not an empty queue, and treating
        // it as empty is what would let the ordering hazard through.
        .catch(() => {
          if (live) setUnsent(1);
        });
    };
    read();
    const id = window.setInterval(read, 3000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [load.id]);

  const run = useCallback(
    (fn: () => Promise<void>, failKey: string, after?: () => void) => {
      setError(null);
      startTransition(async () => {
        try {
          await fn();
          after?.();
        } catch (e) {
          // The claim may have moved while this iPad sat on the screen. Refresh
          // in that case: the page re-renders as the held-by panel and NAMES the
          // new holder, instead of a redacted server message.
          if (await claimLost()) return;
          setError(e instanceof Error ? e.message : t(failKey));
        }
      });
    },
    [claimLost, t],
  );

  const live = load.stacks.filter((s) => s.voided_at === null);
  const total = live.reduce((acc, s) => acc + s.unit_count, 0);
  const correctable = unsent === 0;
  const canFixWeight = correctable && WEIGHT_CORRECTABLE.includes(load.status);
  const canVoidStack = correctable && load.status === 'in_progress';
  const canReopen = correctable && load.status === 'finished';

  const lbsNum = Number.parseInt(lbs, 10);
  const lbsValid = Number.isInteger(lbsNum) && lbsNum >= 1 && lbsNum <= 100_000;

  return (
    <section
      data-testid="review-panel"
      className="flex flex-col gap-5 rounded-xl bg-dr3-green-dark/40 p-4 ring-1 ring-dr3-cream/20"
    >
      <header>
        <h2 className="text-xl font-bold">{t('load_review.heading')}</h2>
      </header>

      {/* ── Pictures ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-dr3-cream/80">
          {t('load_review.photos_heading')}
        </h3>
        <ul className="flex flex-col gap-1 text-sm">
          {REVIEWED_PHOTO_KINDS.map((kind) => {
            const captured = load.photoKinds.includes(kind);
            return (
              <li
                key={kind}
                data-testid={`review-photo-${kind}`}
                data-captured={String(captured)}
                className="flex justify-between"
              >
                <span>{t(`load_review.photo_${kind}`)}</span>
                <span className={captured ? 'text-dr3-chartreuse' : 'text-dr3-cream/50'}>
                  {t(captured ? 'load_review.photo_captured' : 'load_review.photo_missing')}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── Weight ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-dr3-cream/80">
          {t('load_review.weight_heading')}
        </h3>
        <p data-testid="review-weight" className="text-lg tabular-nums">
          {load.weightLbs == null
            ? t('load_review.weight_none')
            : t('load_review.weight_value', { lbs: load.weightLbs.toLocaleString(locale) })}
        </p>

        {canFixWeight && !editingWeight && (
          <button
            type="button"
            data-testid="review-weight-fix"
            onClick={() => {
              setLbs(load.weightLbs == null ? '' : String(load.weightLbs));
              setEditingWeight(true);
            }}
            className="min-h-[44px] self-start rounded-lg bg-dr3-green-dark/60 px-4 py-2 text-sm font-semibold text-dr3-cream"
          >
            {t('load_review.weight_fix')}
          </button>
        )}

        {editingWeight && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
              {t('load_review.weight_input_label')}
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={100_000}
                data-testid="review-weight-input"
                value={lbs}
                onChange={(e) => setLbs(e.target.value.replace(/\D/g, ''))}
                className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-3 text-2xl tabular-nums text-dr3-cream focus:border-dr3-green focus:outline-none"
              />
              <span className="text-xs text-dr3-cream/60">
                {t('load_review.weight_range_hint')}
              </span>
            </label>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setEditingWeight(false)}
                className="min-h-[44px] flex-1 rounded-lg bg-dr3-green-dark/60 px-4 py-2 text-sm font-semibold text-dr3-cream disabled:opacity-40"
              >
                {t('load_review.weight_cancel')}
              </button>
              <button
                type="button"
                data-testid="review-weight-save"
                disabled={!lbsValid || isPending}
                onClick={() =>
                  run(
                    () => correctWeightAction(siteCode, load.id, lbsNum),
                    'load_review.weight_failed',
                    () => setEditingWeight(false),
                  )
                }
                className="min-h-[44px] flex-1 rounded-lg bg-dr3-green px-4 py-2 text-sm font-bold text-dr3-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isPending ? t('load_review.weight_saving') : t('load_review.weight_save')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── What you counted ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-dr3-cream/80">
          {t('load_review.stacks_heading')}
        </h3>
        {load.stacks.length === 0 ? (
          <p className="text-sm text-dr3-cream/60">{t('load_review.stacks_none')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {load.stacks.map((s) => {
              const voided = s.voided_at !== null;
              // A `tmp-` id exists only in this tab (ADR-0078 optimistic
              // render). There is no server row to void, so the control is not
              // offered — an affordance whose only outcome is a 404 is the
              // ADR-0065 Am.1 dead end.
              const acked = !s.id.startsWith('tmp-');
              return (
                <li
                  key={s.id}
                  data-testid={`review-stack-${s.id}`}
                  data-voided={String(voided)}
                  className={`flex items-baseline justify-between gap-3 ${
                    voided ? 'text-dr3-cream/40 line-through' : ''
                  }`}
                >
                  <span>{t('stage_stacks.stack_index', { n: s.stack_index })}</span>
                  <span className="flex items-baseline gap-3">
                    <span className="tabular-nums">
                      {t('stage_stacks.stack_units', { n: s.unit_count })}
                    </span>
                    {voided && (
                      <span className="text-xs no-underline">{t('load_review.stack_voided')}</span>
                    )}
                    {canVoidStack && !voided && acked && (
                      <button
                        type="button"
                        data-testid={`review-stack-remove-${s.id}`}
                        disabled={isPending}
                        onClick={() =>
                          run(
                            () => voidStackAction(siteCode, load.id, s.id),
                            'load_review.stack_remove_failed',
                          )
                        }
                        className="min-h-[44px] rounded-md px-3 py-1 text-xs font-semibold text-rose-300 underline-offset-4 hover:underline disabled:opacity-40"
                      >
                        {isPending
                          ? t('load_review.stack_removing')
                          : t('load_review.stack_remove')}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p data-testid="review-total" className="text-base font-semibold tabular-nums">
          {t('load_review.total', { units: total })}
        </p>
      </div>

      {/* ── Go back to counting ──────────────────────────────────────────── */}
      {canReopen && (
        <div className="flex flex-col gap-2 rounded-lg bg-dr3-green-deep/60 p-3">
          <h3 className="text-sm font-bold">{t('load_review.reopen_heading')}</h3>
          {/* The timer sentence is load-bearing, not reassurance. An operator who
              believes going back will make their unload look slow will not go
              back — and will submit a number they know is wrong instead. */}
          <p className="text-sm text-dr3-cream/70">{t('load_review.reopen_explainer')}</p>
          <button
            type="button"
            data-testid="review-reopen"
            disabled={isPending}
            onClick={() =>
              run(
                () => reopenLoadAction(siteCode, load.id),
                'load_review.reopen_failed',
                // Land the operator on the stacks stage the reopen just put them
                // back on, rather than leaving them staring at a review of a
                // load whose status changed underneath them.
                onClose,
              )
            }
            className="min-h-[44px] rounded-lg bg-dr3-green px-4 py-3 text-base font-bold text-dr3-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending ? t('load_review.reopening') : t('load_review.reopen')}
          </button>
        </div>
      )}

      {!correctable && (
        <p
          data-testid="review-unsent"
          className="rounded-lg bg-amber-900/50 px-4 py-3 text-sm font-medium text-dr3-cream ring-1 ring-amber-400/40"
        >
          {t('load_review.unsent')}
        </p>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      <button
        type="button"
        data-testid="review-close"
        onClick={onClose}
        className="min-h-[56px] rounded-lg bg-dr3-green-dark/60 px-4 py-3 text-base font-bold text-dr3-cream"
      >
        {t('load_review.close')}
      </button>
    </section>
  );
}
