'use client';

import type { RejectionCategory } from '@prisma/client';
import { useI18n } from '@/i18n/provider';

// ADR-0113 — the reject form's fields, shared by the two places a load can be
// refused from.
//
// Until 2026-08-19 there was only one: `stage-reject.tsx`, mounted on
// `unload_started`. The late reject (`in_progress` / `finished`) needs the same
// three inputs behind a different frame — a panel with a consequence warning
// rather than a stage — and copying them would have put the category list in two
// files.
//
// That list is not cosmetic. It is a hand-written mirror of the
// `RejectionCategory` enum, kept hand-written because the runtime enum object
// from `@prisma/client` must not enter the browser bundle. A member added to the
// schema and not added here simply never renders, silently, on whichever copy
// was forgotten — which is precisely how `held-by-panel.tsx` came to label a
// `submitted` load "Counting" for five days. One copy, and
// `reject-fields.enum.test.ts` pins it to the enum from the server side, where
// the runtime object IS readable.

/**
 * Every `RejectionCategory`, in the order the floor should read them.
 *
 * `bedbugs` sits FIRST rather than in enum order. It is the reason this path
 * exists (H-137759, 2026-08-19), it is the category with the largest
 * consequence — an infested load contaminates the building, not just the
 * invoice — and it is the one an operator is reaching for while holding a
 * mattress they want to put down. `other` stays last, where a catch-all belongs.
 */
export const REJECTION_CATEGORIES: readonly RejectionCategory[] = [
  'bedbugs',
  'contamination',
  'wet',
  'damaged',
  'short',
  'mislabeled',
  'other',
] as const;

/**
 * Mirrors the server's 422 (`rejection_note_required`). Enforced in BOTH places
 * on purpose, exactly as the void does it: the server is the authority, and the
 * button being disabled is what stops an operator meeting a refusal they cannot
 * act on.
 *
 * Only `other` requires prose. Every other category is a statement of fact on
 * its own — "bedbugs" needs no sentence, and demanding one from someone in
 * gloves at a dock is friction that buys nothing.
 */
export function rejectNoteRequired(category: RejectionCategory | ''): boolean {
  return category === 'other';
}

/** True when the server would accept this form. The photo is counted separately. */
export function rejectFormReady(args: {
  category: RejectionCategory | '';
  note: string;
  hasPhoto: boolean;
}): boolean {
  if (args.category === '' || !args.hasPhoto) return false;
  return !rejectNoteRequired(args.category) || args.note.trim().length > 0;
}

export function RejectFields({
  category,
  onCategory,
  note,
  onNote,
  idPrefix,
}: {
  category: RejectionCategory | '';
  onCategory: (c: RejectionCategory | '') => void;
  note: string;
  onNote: (n: string) => void;
  /** Distinguishes the two mount points' test ids; the panels never co-render. */
  idPrefix: string;
}) {
  const { t, locale } = useI18n();
  const noteRequired = rejectNoteRequired(category);

  return (
    <>
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {t('stage_reject.reason_label')}
        <select
          data-testid={`${idPrefix}-category`}
          value={category}
          onChange={(e) => onCategory(e.target.value as RejectionCategory | '')}
          // ADR-0060 gloved-hand sizing — a dock control is never under 56px.
          className="min-h-[56px] rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-3 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
        >
          <option value="">{t('stage_reject.reason_select')}</option>
          {REJECTION_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`stage_reject.category_${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        {noteRequired ? t('stage_reject.note_label_required') : t('stage_reject.note_label')}
        {/* `lang={locale}` so iPadOS dictation picks the right input
            language for voice-to-text per SPRINT-1-PLAN T-008. */}
        <textarea
          data-testid={`${idPrefix}-note`}
          rows={4}
          lang={locale}
          value={note}
          onChange={(e) => onNote(e.target.value.slice(0, 1000))}
          placeholder={t('stage_reject.note_placeholder')}
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream placeholder:text-dr3-cream/40 focus:border-dr3-green focus:outline-none"
        />
        {noteRequired && note.trim().length === 0 && (
          <span className="text-xs text-dr3-cream/60">{t('stage_reject.note_required')}</span>
        )}
      </label>
    </>
  );
}
