'use client';

import type { ConcernCategory } from '@prisma/client';
import { useState, useTransition } from 'react';
import { addConcernAction, submitLoadAction } from '../../actions';

const CONCERN_CATEGORIES: { value: ConcernCategory; label: string }[] = [
  { value: 'damaged', label: 'Damaged units' },
  { value: 'wet', label: 'Wet' },
  { value: 'bedbugs', label: 'Bedbugs' },
  { value: 'contamination', label: 'Contamination' },
  { value: 'short', label: 'Short count vs BOL' },
  { value: 'mislabeled', label: 'Mislabeled' },
  { value: 'other', label: 'Other' },
];

// Stage 6/7 — Finish + optional concern + Submit. Submit signs the
// operator out (per ADR-0004 auto-logout on every load submission)
// and routes back to the name picker.

type Props = {
  siteCode: string;
  loadId: string;
  operatorName: string;
  totalUnits: number | null;
};

export function StageFinish({ siteCode, loadId, operatorName, totalUnits }: Props) {
  const [showConcern, setShowConcern] = useState(false);
  const [concernSaved, setConcernSaved] = useState(false);
  const [category, setCategory] = useState<ConcernCategory | ''>('');
  const [note, setNote] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const saveConcern = () => {
    if (!category) return;
    setError(null);
    startTransition(async () => {
      try {
        await addConcernAction(siteCode, loadId, category, note.trim() || null);
        setConcernSaved(true);
        setShowConcern(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed');
      }
    });
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        await submitLoadAction(siteCode, loadId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Submit failed');
      }
    });
  };

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-2xl font-bold">6. Finish</h2>
        <p className="text-sm text-dr3-cream/70">
          {operatorName} · {totalUnits ?? 0} units counted
        </p>
      </header>

      {!showConcern && !concernSaved && (
        <button
          type="button"
          onClick={() => setShowConcern(true)}
          className="rounded-lg bg-dr3-green-dark/50 px-6 py-4 text-base font-semibold text-dr3-cream transition-colors hover:bg-dr3-green-dark/80"
        >
          Add a concern (optional)
        </button>
      )}

      {showConcern && (
        <div className="flex flex-col gap-3 rounded-lg bg-dr3-green-dark/40 p-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
            Concern type
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ConcernCategory | '')}
              className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
            >
              <option value="">— Select —</option>
              {CONCERN_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-dr3-cream/80">
            Note
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 1000))}
              placeholder="Voice-to-text is OK."
              className="rounded-md border border-dr3-cream/30 bg-dr3-green-deep px-3 py-2 text-base text-dr3-cream focus:border-dr3-green focus:outline-none"
            />
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setShowConcern(false)}
              className="flex-1 rounded-md bg-dr3-green-dark/50 px-4 py-2 text-sm font-semibold text-dr3-cream"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!category || isPending}
              onClick={saveConcern}
              className="flex-1 rounded-md bg-dr3-green px-4 py-2 text-sm font-semibold text-dr3-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save concern
            </button>
          </div>
        </div>
      )}

      {concernSaved && (
        <p className="rounded-md bg-dr3-green-dark/40 px-4 py-2 text-sm text-dr3-cream/80">
          ✓ Concern recorded.
        </p>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      <button
        type="button"
        disabled={isPending}
        onClick={submit}
        className="rounded-lg bg-dr3-chartreuse px-6 py-6 text-xl font-bold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? 'Submitting…' : 'Submit load (sign out)'}
      </button>
    </section>
  );
}
