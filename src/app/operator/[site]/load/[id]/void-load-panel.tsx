'use client';

import type { LoadVoidReason } from '@prisma/client';
import { useState, useTransition } from 'react';
import { useI18n } from '@/i18n/provider';
import { voidLoadAction } from '../../actions';
import { useClaimLossGuard } from './use-claim-loss-guard';

// ADR-0090 C — the floor's way out of a load that should never have started.
//
// JT, 2026-08-10: "I'm not able to fix the pending one under my name, it doesn't
// let me 0 it out... I fixed everybody else's."
//
// She could not, and the reason is structural rather than a missing button:
// `addStack` refuses `unitCount < 1`, so a load cannot be zeroed, and no abandon
// path existed at any stage. The three loads stuck under her name on 2026-08-10
// were each closable only by hand-audited DB surgery.
//
// TWO TAPS, NOT ONE. The first opens the reason picker; the second commits. A
// single-tap void on a screen an operator reaches by accident would trade one
// irreversible mistake for another, and `voided` has no legal successor — there
// is no un-void, deliberately (see ALLOWED_PRIOR in load-service.ts).

const REASONS: LoadVoidReason[] = ['wrong_haul', 'truck_never_arrived', 'other'];

export function VoidLoadPanel({ siteCode, loadId }: { siteCode: string; loadId: string }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<LoadVoidReason | ''>('');
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();
  // ADR-0082 — a refusal may be a takeover, and a Server Action's message is
  // redacted in production, so the client cannot read why. Asked, not guessed.
  const claimLost = useClaimLossGuard(siteCode, loadId);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the server's 422 (`void_note_required`). Enforced in BOTH places on
  // purpose: the server is the authority, and the button being disabled is what
  // stops an operator meeting a refusal they cannot act on.
  const noteRequired = reason === 'other';
  const ready = reason !== '' && (!noteRequired || note.trim().length > 0);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Quiet by design. This sits below the stage's primary action and must
        // never compete with it — the common case is finishing the load.
        className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-dr3-cream/70 underline-offset-4 transition-colors hover:text-dr3-cream hover:underline"
      >
        {t('load_void.open')}
      </button>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl bg-dr3-green-dark/50 p-4 ring-1 ring-dr3-cream/20">
      <header>
        <h2 className="text-lg font-bold">{t('load_void.heading')}</h2>
        <p className="mt-1 text-sm text-dr3-cream/70">{t('load_void.subheading')}</p>
      </header>

      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {t('load_void.reason_label')}
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as LoadVoidReason | '')}
          className="min-h-[44px] rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
        >
          <option value="">{t('load_void.reason_select')}</option>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`load_void.reason_${r}`)}
            </option>
          ))}
        </select>
      </label>

      {noteRequired && (
        <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
          {t('load_void.note_label')}
          {/* `lang={locale}` so iPadOS dictation picks the right input language
              for voice-to-text, matching stage-finish.tsx (T-008). */}
          <textarea
            rows={3}
            lang={locale}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 1000))}
            placeholder={t('load_void.note_placeholder')}
            className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
          />
          {note.trim().length === 0 && (
            <span className="text-xs text-dr3-cream/60">{t('load_void.note_required')}</span>
          )}
        </label>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="min-h-[44px] flex-1 rounded-lg bg-dr3-green-dark/60 px-4 py-3 text-base font-semibold text-dr3-cream disabled:opacity-40"
        >
          {t('load_void.cancel')}
        </button>
        <button
          type="button"
          disabled={!ready || isPending}
          onClick={() =>
            startTransition(async () => {
              if (reason === '') return;
              try {
                setError(null);
                await voidLoadAction(siteCode, loadId, reason, note.trim() || null);
              } catch (e) {
                // The claim may have moved while this iPad sat on the screen.
                // Refresh in that case: the page re-renders as the held-by panel
                // and NAMES the new holder, instead of a redacted server message.
                if (await claimLost()) return;
                setError(e instanceof Error ? e.message : t('load_void.failed'));
              }
            })
          }
          className="min-h-[44px] flex-1 rounded-lg bg-rose-600 px-4 py-3 text-base font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? t('load_void.closing') : t('load_void.confirm')}
        </button>
      </div>
    </section>
  );
}
