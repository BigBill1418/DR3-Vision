'use client';

// ADR-0029 — Batch amendment request modal.
//
// A single manager "save" that touches N prior-day line items produces ONE
// amendment request batch (and therefore ONE notification per direction) rather
// than N separate modals + N notifications. This modal lists every pending
// prior-day change, takes ONE justification (≥ 20 chars; enforced
// client+server+DB), shows who it routes to, and POSTs the whole batch in one
// request.
//
// CLAUDE.md hard rule #10 — onClick only, no <form>. Hard rule #3 — DR3 brand
// is green/black; no red/navy/gold (the cyan accents are the existing bonus
// surface's space-theme tokens, consistent with the rest of /bonus).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { amendmentErrorMessage } from '@/lib/bonus/amendment-error-messages';
import { amendmentSummaryLine } from '@/lib/bonus/amendment-display';

export interface BatchItem {
  bonusEmployeeId: string;
  employeeName: string;
  changeType: 'update' | 'insert';
  oldValue: { mattress_count: number; saves: number; note: string | null } | null;
  newValue: { mattress_count: number; saves: number; note: string | null };
}

interface Props {
  open: boolean;
  onClose(): void;
  bonusPayPeriodId: string;
  targetEntryDate: string;
  approverName: string;
  items: BatchItem[];
}

const JUSTIFICATION_MIN = 20;

export function RequestEditBatchModal({
  open,
  onClose,
  bonusPayPeriodId,
  targetEntryDate,
  approverName,
  items,
}: Props) {
  const router = useRouter();
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = justification.trim().length < JUSTIFICATION_MIN;

  if (!open) return null;

  const onSubmit = async () => {
    if (tooShort || items.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/bonus/amendments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bonusPayPeriodId,
          targetEntryDate,
          justification: justification.trim(),
          items: items.map((i) => ({
            bonusEmployeeId: i.bonusEmployeeId,
            changeType: i.changeType,
            newValue: i.newValue,
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          amendmentErrorMessage(body?.error, `Could not submit these corrections (${res.status}).`),
        );
        setSubmitting(false);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  const countLabel =
    items.length === 1 ? '1 prior-day change' : `${items.length} prior-day changes`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-edit-batch-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-dr3-cyan/30 bg-dr3-space-2 p-6 text-dr3-mist shadow-2xl">
        <h2 id="request-edit-batch-title" className="text-lg font-semibold">
          Request prior-day edit
        </h2>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          Date: <span className="text-dr3-mist">{targetEntryDate}</span> · {countLabel}
        </p>

        <ul
          className="mt-3 max-h-56 overflow-y-auto rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 px-3 py-2 text-sm"
          data-testid="batch-items"
        >
          {items.map((i) => (
            <li
              key={i.bonusEmployeeId}
              className="flex items-baseline justify-between gap-3 border-b border-dr3-steel-light/10 py-1 last:border-b-0"
            >
              <span className="text-dr3-mist">{i.employeeName}</span>
              {/* ADR-0083 — shared formatter, so the count AND the saves change
                  are both named. See `amendment-display.ts`. */}
              <span className="font-mono text-dr3-mist-dim">
                {amendmentSummaryLine(i.changeType, i.oldValue, i.newValue)}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-2 text-xs text-dr3-mist-dim">
          {items.length === 1 ? 'This change' : 'These changes'} will be sent to{' '}
          <span className="font-medium text-dr3-mist">{approverName}</span> for approval as a single
          request. {items.length === 1 ? 'It' : 'They'} will not apply until approved.
        </p>

        <label htmlFor="batch-justification" className="mt-4 block text-sm font-medium">
          Justification (required, ≥ {JUSTIFICATION_MIN} characters)
        </label>
        <textarea
          id="batch-justification"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          placeholder="e.g. Correcting yesterday's counts — I keyed several rows from the wrong tally sheet."
          data-testid="batch-justification"
        />
        <p className="mt-1 text-xs text-dr3-mist-dim">
          {justification.trim().length} / {JUSTIFICATION_MIN}+
        </p>

        {error ? (
          <p
            className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
            role="alert"
            data-testid="batch-error"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-dr3-steel-light/30 px-4 py-2 text-sm text-dr3-mist hover:bg-dr3-space-2/80"
            data-testid="batch-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={tooShort || submitting}
            className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan/90 disabled:opacity-50"
            data-testid="batch-submit"
          >
            {submitting ? 'Submitting…' : `Submit request (${items.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
