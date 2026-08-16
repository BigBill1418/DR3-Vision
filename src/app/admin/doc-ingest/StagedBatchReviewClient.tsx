'use client';

// ADR-0104 §D5 — the confirm/discard control for a staged absorption batch.
//
// Two deliberate acts, not one tap. Confirm asks for a second click against a
// restated summary and discard asks for a reason, because the decision is
// attributed to the person who made it and the audit row captures the totals
// that were on screen when they made it.
//
// Parameterised over the endpoint because ADR-0104 ships TWO staging classes at
// once. `TerexReviewClient` is deliberately left alone: it is the same shape,
// but it carries `data-testid` hooks an e2e suite already binds to, and
// rewriting a working control to share code with two new ones is a change with
// risk and no benefit. If a fourth staging class arrives, fold TEREX in then.
//
// Per hard rule #10 there is NO HTML `<form>`: every control is a handler.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface StagedBatchReviewProps {
  /** The API route that owns the decision, e.g. `/api/admin/doc-ingest/outbound`. */
  endpoint: string;
  /** The batch. A VERSION, never a row. */
  versionId: string;
  /** What the button offers to accept, e.g. "831 loads". */
  subject: string;
  /**
   * Restated at the confirm step. Say what accepting MEANS — in particular that
   * these stay reference rows and nothing is billed, paid or reported from them.
   */
  confirmBody: string;
  discardPlaceholder: string;
  /** Distinguishes the two controls when both render on one screen. */
  testIdPrefix: string;
}

export function StagedBatchReviewClient({
  endpoint,
  versionId,
  subject,
  confirmBody,
  discardPlaceholder,
  testIdPrefix,
}: StagedBatchReviewProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'confirming' | 'discarding'>('idle');
  const [reason, setReason] = useState('');

  async function send(action: 'confirm' | 'discard'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'confirm' ? { action, versionId } : { action, versionId, reason: reason.trim() },
        ),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        // `nothing_staged` is not a fault — somebody else most likely just
        // decided it — so it reads as news rather than as a failure.
        setError(
          b?.error === 'nothing_staged'
            ? 'Nothing is staged for this batch any more — it has already been decided. Reload to see the current state.'
            : (b?.error ?? 'Could not complete that.'),
        );
        return;
      }
      setMode('idle');
      setReason('');
      router.refresh();
    } catch {
      setError('Could not complete that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-rose-500/15 px-4 py-2 text-sm text-rose-200 ring-1 ring-rose-500/30"
        >
          {error}
        </p>
      )}

      {mode === 'idle' && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => setMode('confirming')}
            className="rounded-md bg-emerald-500/80 px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-50"
            data-testid={`${testIdPrefix}-confirm-start`}
          >
            Accept these {subject}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setMode('discarding')}
            className="rounded-md bg-dr3-steel/40 px-4 py-2 text-sm font-medium ring-1 ring-dr3-steel-light/25"
            data-testid={`${testIdPrefix}-discard-start`}
          >
            Discard them
          </button>
        </div>
      )}

      {mode === 'confirming' && (
        <div className="rounded-md bg-dr3-space/60 p-4 ring-1 ring-emerald-500/30">
          <p className="text-sm">{confirmBody}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void send('confirm')}
              className="rounded-md bg-emerald-500/80 px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-50"
              data-testid={`${testIdPrefix}-confirm`}
            >
              {busy ? 'Accepting…' : 'Yes, accept'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('idle')}
              className="rounded-md bg-dr3-steel/40 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'discarding' && (
        <div className="rounded-md bg-dr3-space/60 p-4 ring-1 ring-rose-500/30">
          <label className="block text-xs uppercase tracking-wide text-dr3-mist-dim">
            Why are these being discarded?
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md bg-dr3-space px-3 py-2 text-sm text-dr3-mist ring-1 ring-dr3-steel-light/25"
              placeholder={discardPlaceholder}
            />
          </label>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy || reason.trim() === ''}
              onClick={() => void send('discard')}
              className="rounded-md bg-rose-500/80 px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-50"
              data-testid={`${testIdPrefix}-discard`}
            >
              {busy ? 'Discarding…' : 'Discard'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('idle')}
              className="rounded-md bg-dr3-steel/40 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
