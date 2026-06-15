'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  open: boolean;
  onClose(): void;
  payload: {
    bonusPayPeriodId: string;
    bonusEmployeeId: string;
    employeeName: string;
    targetEntryDate: string;
    changeType: 'update' | 'insert';
    oldValue: { mattress_count: number; note: string | null } | null;
    newValue: { mattress_count: number; note: string | null };
    approverName: string;
  };
}

export function RequestEditModal({ open, onClose, payload }: Props) {
  const router = useRouter();
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = justification.trim().length < 20;

  if (!open) return null;

  const onSubmit = async () => {
    if (tooShort) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/bonus/amendments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bonusPayPeriodId: payload.bonusPayPeriodId,
          targetEntryDate: payload.targetEntryDate,
          bonusEmployeeId: payload.bonusEmployeeId,
          changeType: payload.changeType,
          newValue: payload.newValue,
          justification: justification.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? `failed (${res.status})`);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-edit-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-dr3-cyan/30 bg-dr3-space-2 p-6 text-dr3-mist shadow-2xl">
        <h2 id="request-edit-title" className="text-lg font-semibold">
          Request edit — {payload.employeeName}
        </h2>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          Date: <span className="text-dr3-mist">{payload.targetEntryDate}</span>
          {payload.changeType === 'update' ? (
            <>
              {' '}
              — count change:{' '}
              <span className="text-dr3-mist">
                {payload.oldValue?.mattress_count ?? '?'} → {payload.newValue.mattress_count}
              </span>
            </>
          ) : (
            <>
              {' '}
              — new entry:{' '}
              <span className="text-dr3-mist">{payload.newValue.mattress_count} mattresses</span>
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-dr3-mist-dim">
          This will be sent to{' '}
          <span className="font-medium text-dr3-mist">{payload.approverName}</span> for approval.
          The change will not apply until they approve.
        </p>

        <label htmlFor="justification" className="mt-4 block text-sm font-medium">
          Justification (required, ≥ 20 characters)
        </label>
        <textarea
          id="justification"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          placeholder="e.g. Faisal worked 67 mattresses, I keyed 76 by mistake"
        />
        <p className="mt-1 text-xs text-dr3-mist-dim">{justification.trim().length} / 20+</p>

        {error ? (
          <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-dr3-steel-light/30 px-4 py-2 text-sm text-dr3-mist hover:bg-dr3-space-2/80"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={tooShort || submitting}
            className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan/90 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </div>
    </div>
  );
}
