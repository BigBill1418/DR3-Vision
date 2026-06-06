'use client';

// "Month complete — ready to sign" (ADR-0019 §5a). Closes the current draft month
// on demand (draft -> pending_signatures), locking daily entries and emailing the
// facility-manager signer. Shown only while the month is in `draft`.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  monthId: string;
  monthLabel: string;
}

export function CloseMonthButton({ monthId, monthLabel }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmClose() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bonus/months/${monthId}/close`, { method: 'POST' });
      if (res.ok) {
        router.push(`/bonus/months/${monthId}`);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Could not close the month. Please try again.');
    } catch {
      setError('Could not reach the server. Please try again.');
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink transition-colors hover:bg-dr3-chartreuse/90 focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse focus:ring-offset-2 focus:ring-offset-dr3-green-deep"
      >
        Month complete — ready to sign
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Close month for signatures"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6"
        >
          <div className="w-full max-w-md rounded-lg bg-dr3-cream p-6 text-dr3-ink shadow-xl">
            <h2 className="text-lg font-bold">Close {monthLabel} for signatures?</h2>
            <p className="mt-2 text-sm text-dr3-ink/80">
              This locks the daily entries for {monthLabel} and notifies the facility manager to
              sign. Reopening a closed month requires an administrator amendment.
            </p>
            {error && (
              <p className="mt-3 rounded bg-red-100 px-3 py-2 text-sm text-red-800">{error}</p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                className="rounded-md px-4 py-2 text-sm font-medium text-dr3-ink/70 hover:text-dr3-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={confirmClose}
                className="rounded-md bg-dr3-green-deep px-4 py-2 text-sm font-semibold text-dr3-cream hover:bg-dr3-green-dark disabled:opacity-50"
              >
                {busy ? 'Closing…' : 'Close month'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
