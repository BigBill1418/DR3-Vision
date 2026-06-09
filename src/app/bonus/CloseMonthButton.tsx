'use client';

// "Pay period complete — ready to sign" (ADR-0019 §5a). Closes the current draft
// pay period on demand (draft -> pending_signatures), locking daily entries and
// emailing the facility-manager signer. Shown only while the period is `draft`.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  monthId: string;
  /** Human pay-period label, e.g. "Pay Period 13 · Jun 9–22, 2026". */
  periodLabel: string;
}

export function CloseMonthButton({ monthId, periodLabel }: Props) {
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
      setError(body.error ?? 'Could not close the pay period. Please try again.');
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
        className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright focus:outline-none focus:ring-2 focus:ring-dr3-cyan focus:ring-offset-2 focus:ring-offset-dr3-space"
      >
        Pay period complete — ready to sign
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Close month for signatures"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6"
        >
          <div className="w-full max-w-md rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-dr3-mist shadow-xl">
            <h2 className="text-lg font-bold">Close {periodLabel} for signatures?</h2>
            <p className="mt-2 text-sm text-dr3-mist-dim">
              This locks the daily entries for {periodLabel} and notifies the facility manager to
              sign. Reopening a closed pay period requires an administrator amendment.
            </p>
            {error && (
              <p className="mt-3 rounded border border-red-500/30 bg-red-900/40 px-3 py-2 text-sm text-red-100">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                className="rounded-md px-4 py-2 text-sm font-medium text-dr3-mist-dim hover:text-dr3-mist disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={confirmClose}
                className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
              >
                {busy ? 'Closing…' : 'Close pay period'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
