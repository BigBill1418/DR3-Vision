'use client';

// ADR-0069 Amendment 2 — the confirm/discard control for a staged TEREX batch.
//
// Two deliberate acts, not one tap. Confirm asks for a typed confirmation and
// discard asks for a reason, because both decisions are about money and both are
// attributed to the person who made them.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function TerexReviewClient({ versionId, count }: { versionId: string; count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'confirming' | 'discarding'>('idle');
  const [reason, setReason] = useState('');

  async function send(action: 'confirm' | 'discard'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/doc-ingest/terex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'confirm'
            ? { action, versionId }
            : { action, versionId, reason: reason.trim() },
        ),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(b?.error ?? 'Could not complete that.');
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
            data-testid="terex-confirm-start"
          >
            Accept these {count} events
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setMode('discarding')}
            className="rounded-md bg-dr3-steel/40 px-4 py-2 text-sm font-medium ring-1 ring-dr3-steel-light/25"
          >
            Discard them
          </button>
        </div>
      )}

      {mode === 'confirming' && (
        <div className="rounded-md bg-dr3-space/60 p-4 ring-1 ring-emerald-500/30">
          <p className="text-sm">
            Accepting records these {count} maintenance events, and the costs shown above, as
            reviewed by you. They stay reference data — nothing is billed or paid from them.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void send('confirm')}
              className="rounded-md bg-emerald-500/80 px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-50"
              data-testid="terex-confirm"
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
              placeholder="e.g. the workbook was mid-edit when it was read"
            />
          </label>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy || reason.trim() === ''}
              onClick={() => void send('discard')}
              className="rounded-md bg-rose-500/80 px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-50"
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
