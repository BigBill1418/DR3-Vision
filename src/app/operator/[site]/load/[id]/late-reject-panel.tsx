'use client';

import type { RejectionCategory } from '@prisma/client';
import { useEffect, useState, useTransition } from 'react';
import { useI18n } from '@/i18n/provider';
import { pendingActionsForLoad } from '@/lib/offline-queue';
import { rejectLoadAction } from '../../actions';
import { useClaimLossGuard } from './use-claim-loss-guard';
import { PhotoInput } from './photo-input';
import { RejectFields, rejectFormReady, rejectNoteRequired } from './reject-fields';
import type { ReviewStack } from './review-panel';

// ADR-0113 — the way out of a load that turned out to be refusable AFTER the
// counting started.
//
// Bill, 2026-08-19: "we accepted a load as arrived — then found massive bed bugs
// — no path to go back and reject it."
//
// He was right, and it was structural rather than a missing button. The reject
// stage was mounted on exactly one status:
//
//     if (load.status === 'unload_started' && showReject) return <StageReject … />
//
// and `ALLOWED_PRIOR.rejected` stopped at `unload_started` behind it, so even a
// hand-crafted POST would have been refused. The affordance disappeared the
// instant the first stack landed — which is roughly the instant an operator
// starts handling mattresses, and therefore the instant they can first SEE what
// is in them. H-137759 was closed by hand-audited DB surgery.
//
// ## Why this is a panel and not a stage
//
// `StageReject` is a stage: it REPLACES the screen, because at the inspection
// point rejecting is one of the two things you might do next. Here it is not.
// The operator is mid-count and the overwhelming majority of loads are fine, so
// this has to be findable without competing with the count. It sits in the same
// quiet footer stack as the void and the review, below the stage's primary
// action — the hierarchy `load-workflow.tsx` already establishes.
//
// TWO TAPS, NOT ONE, and the second one is behind a form. The first tap opens
// the panel; the panel STATES THE CONSEQUENCE in units before it asks for
// anything. An operator who taps this by accident on the way to "+1 mattress"
// meets a sentence telling them 47 counted units are about to be voided, not a
// committed rejection.
//
// ## The offline hazard, and why the control is withheld rather than hidden
//
// `LOAD_ADD_STACK` and `LOAD_FINISH_UNLOAD` ARE replayable scopes. The rejection
// is not (ADR-0090 D2.4's reasoning, applied in `actions.ts`). So a stack tapped
// while the iPad was offline can replay AFTER a rejection and would be the one
// write asserting that the refused truck delivered units. `addStack` refuses
// anything but `in_progress` and would park it as a conflict — loud, but only
// after the fact.
//
// The honest place to stop it is the offer, and `review-panel.tsx` already
// established the pattern for exactly this ordering hazard: withhold while the
// load has unsent work, FAIL CLOSED when the queue cannot be read, and say so. A
// control that is merely absent teaches the operator the feature is broken.
//
// This is friction at the worst possible moment — bugs found, truck at the dock,
// button greyed. It is accepted knowingly: the rejection is online-only anyway,
// so the queue drains in seconds whenever this control could have worked at all,
// and the alternative is a refusal that a replay partially undoes.

type Props = {
  siteCode: string;
  loadId: string;
  /** Live + voided; the panel counts the live ones itself. */
  stacks: ReviewStack[];
  /** ADR-0109 — rejection-evidence photos already on the server. */
  photoCount: number;
};

export function LateRejectPanel({ siteCode, loadId, stacks, photoCount }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<RejectionCategory | ''>('');
  const [note, setNote] = useState('');
  const [hasPhoto, setHasPhoto] = useState(photoCount > 0);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // ADR-0082 — a refusal may be a takeover, and a Server Action's message is
  // redacted in production, so the client cannot read why. Asked, not guessed.
  const claimLost = useClaimLossGuard(siteCode, loadId);
  const [unsent, setUnsent] = useState(0);

  // Re-read rather than read once, for the reason `review-panel.tsx` gives: the
  // operator can sit on this panel while the chrome's replay loop drains the
  // queue, and a control correctly withheld a moment ago must become available
  // WITHOUT a reload — otherwise the honest guard reads as the dead end it
  // exists to prevent.
  useEffect(() => {
    let live = true;
    const read = () => {
      pendingActionsForLoad(loadId)
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
  }, [loadId]);

  const liveStacks = stacks.filter((s) => s.voided_at === null);
  const liveUnits = liveStacks.reduce((n, s) => n + s.unit_count, 0);
  const ready = rejectFormReady({ category, note, hasPhoto }) && unsent === 0;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="late-reject-open"
        onClick={() => setOpen(true)}
        // Quiet by design, and BELOW the count. The common case is finishing the
        // load; this must never compete with that. Same weight as the void,
        // which is the other thing on this screen that ends a load.
        className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-dr3-cream/70 underline-offset-4 transition-colors hover:text-dr3-cream hover:underline"
      >
        {t('load_reject.open')}
      </button>
    );
  }

  return (
    <section
      data-testid="late-reject-panel"
      className="flex flex-col gap-4 rounded-xl bg-dr3-green-dark/50 p-4 ring-1 ring-dr3-cream/20"
    >
      <header>
        <h2 className="text-lg font-bold">{t('load_reject.heading')}</h2>
        <p className="mt-1 text-sm text-dr3-cream/70">{t('load_reject.subheading')}</p>
      </header>

      {/* The consequence, in units, BEFORE the form asks for anything. A count
          already taken is the thing this action destroys, and an operator who
          opened this panel by mistake should learn that from the panel rather
          than from the queue afterwards. */}
      <p
        data-testid="late-reject-consequence"
        className="rounded-md bg-dr3-green-deep/60 p-3 text-sm font-semibold text-dr3-cream"
      >
        {liveStacks.length > 0
          ? t('load_reject.consequence_counted', {
              stacks: liveStacks.length,
              units: liveUnits,
            })
          : t('load_reject.consequence_uncounted')}
      </p>

      {unsent > 0 ? (
        // Withheld, and SAID. See the header note — an absent control teaches the
        // operator the feature is broken; this teaches them to wait.
        <p data-testid="late-reject-unsent" className="text-sm text-dr3-cream/80">
          {t('load_reject.unsent')}
        </p>
      ) : (
        <>
          <RejectFields
            category={category}
            onCategory={setCategory}
            note={note}
            onNote={setNote}
            idPrefix="late-reject"
          />
          <PhotoInput
            loadId={loadId}
            kind="rejection"
            labelKey="rejection"
            onCaptured={() => setHasPhoto(true)}
            initialCount={photoCount}
          />
          {!hasPhoto && (
            <p className="text-xs text-dr3-cream/60">{t('load_reject.photo_required')}</p>
          )}
        </>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="flex gap-3">
        <button
          type="button"
          data-testid="late-reject-cancel"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="min-h-[56px] flex-1 rounded-lg bg-dr3-green-dark/60 px-4 py-3 text-base font-semibold text-dr3-cream disabled:opacity-40"
        >
          {t('load_reject.cancel')}
        </button>
        <button
          type="button"
          data-testid="late-reject-confirm"
          disabled={!ready || isPending}
          onClick={() =>
            startTransition(async () => {
              if (category === '') return;
              // Mirrors the server's 422s. Both are checked here rather than
              // relying on `disabled` alone, because `disabled` is a rendering
              // decision and this is the last line before a write.
              if (rejectNoteRequired(category) && !note.trim()) return;
              try {
                setError(null);
                await rejectLoadAction(siteCode, loadId, category, note.trim() || null);
              } catch (e) {
                // The claim may have moved while this iPad sat on the screen.
                // Refresh in that case: the page re-renders as the held-by panel
                // and NAMES the new holder, instead of a redacted server message.
                if (await claimLost()) return;
                setError(e instanceof Error ? e.message : t('load_reject.failed'));
              }
            })
          }
          className="min-h-[56px] flex-1 rounded-lg bg-rose-600 px-4 py-3 text-base font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? t('load_reject.rejecting') : t('load_reject.confirm')}
        </button>
      </div>
    </section>
  );
}
