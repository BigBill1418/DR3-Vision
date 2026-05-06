'use client';

import type { RejectionCategory } from '@prisma/client';
import { useState, useTransition } from 'react';
import { rejectLoadAction } from '../../actions';
import { PhotoInput } from './photo-input';

const CATEGORIES: { value: RejectionCategory; label: string }[] = [
  { value: 'contamination', label: 'Contamination' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'wet', label: 'Wet' },
  { value: 'bedbugs', label: 'Bedbugs' },
  { value: 'short', label: 'Short count' },
  { value: 'mislabeled', label: 'Mislabeled' },
  { value: 'other', label: 'Other' },
];

// Stage 5b — reject. Category dropdown + multi-photo + note + submit.
// Photos are best-effort (T-007 wires R2); for T-006 the operator
// captures one rejection photo and the note carries the rest.

export function StageReject({
  siteCode,
  loadId,
  onCancel,
}: {
  siteCode: string;
  loadId: string;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState<RejectionCategory | ''>('');
  const [hasPhoto, setHasPhoto] = useState(false);
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!category || !hasPhoto) return;
    setError(null);
    startTransition(async () => {
      try {
        await rejectLoadAction(siteCode, loadId, category, note.trim() || null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Reject failed');
      }
    });
  };

  return (
    <section className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-2xl font-bold">5. Reject load</h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-dr3-cream/70 underline-offset-2 hover:underline"
        >
          ← Back
        </button>
      </header>
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        Reason
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as RejectionCategory | '')}
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-3 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
        >
          <option value="">— Select —</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <PhotoInput label="Capture rejection evidence" onCaptured={() => setHasPhoto(true)} />
      <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
        Note (optional)
        <textarea
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 1000))}
          placeholder="Anything else worth recording. Voice-to-text is OK."
          className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream placeholder:text-dr3-cream/40 focus:border-dr3-green focus:outline-none"
        />
      </label>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        type="button"
        disabled={isPending || !category || !hasPhoto}
        onClick={submit}
        className="rounded-lg bg-red-700 px-6 py-4 text-lg font-semibold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? 'Rejecting…' : 'Reject load'}
      </button>
    </section>
  );
}
