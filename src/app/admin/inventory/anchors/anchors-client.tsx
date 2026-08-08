'use client';

// ADR-0072 §3 — the anchor list plus the re-activate action.
//
// Re-activation is deliberately two deliberate acts: pick the anchor, then type
// a reason. There is no one-tap restore, because restoring the wrong anchor has
// exactly the same blast radius as the mistyped count it is meant to fix.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type AnchorRow = {
  id: string;
  siteCode: string;
  siteName: string;
  at: string;
  total: number;
  programUnits: number | null;
  nonProgramUnits: number | null;
  reconciledDelta: number | null;
  /** ADR-0084 — Pacific-rendered void instant, or null when the count is live. */
  voidedAt: string | null;
};

export function AnchorsClient({ rows }: { rows: AnchorRow[] }) {
  const router = useRouter();
  // ADR-0084 — the `current` badge follows the ANCHOR SELECTOR, which skips
  // voided rows. Before this it was `i === 0`, so voiding the newest count would
  // have left this page badging a withdrawn row as current while every server
  // reader had already moved on to the one below it. The list is already sorted
  // newest-first by the page, matching `onHand`'s ordering.
  const currentId = rows.find((r) => r.voidedAt === null)?.id ?? null;
  const [selected, setSelected] = useState<AnchorRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function reactivate(): Promise<void> {
    if (!selected || reason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/inventory/anchors/reactivate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshotId: selected.id, reason }),
      });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(String(b['error'] ?? 'Could not re-activate that anchor.'));
        return;
      }
      setDone(
        `Restored ${selected.siteName} to ${selected.total.toLocaleString()} units as a new snapshot.`,
      );
      setSelected(null);
      setReason('');
      router.refresh();
    } catch {
      setError('Could not re-activate that anchor.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Anchor history</h2>

      {done && (
        <p className="mt-3 rounded-md bg-emerald-500/15 px-4 py-3 text-sm text-emerald-200 ring-1 ring-emerald-500/30">
          {done}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md bg-rose-500/15 px-4 py-3 text-sm text-rose-200 ring-1 ring-rose-500/30"
        >
          {error}
        </p>
      )}

      <div className="mt-3 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
            <tr>
              <th className="px-3 py-2">Site</th>
              <th className="px-3 py-2">Counted at</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Program</th>
              <th className="px-3 py-2 text-right">Non-program</th>
              <th className="px-3 py-2 text-right">vs. system</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-dr3-mist-dim">
                  No physical anchors recorded yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-t border-dr3-steel-light/15 ${
                  r.voidedAt === null ? '' : 'opacity-60'
                }`}
                data-testid="anchor-row"
                data-voided={r.voidedAt === null ? 'false' : 'true'}
              >
                <td className="px-3 py-2">{r.siteName}</td>
                <td className="px-3 py-2 text-xs text-dr3-mist-dim">{r.at}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {/* ADR-0084 — struck through, not hidden. The number stays
                      readable because the history is the point. */}
                  <span className={r.voidedAt === null ? '' : 'line-through'}>
                    {r.total.toLocaleString()}
                  </span>
                  {r.id === currentId && (
                    <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                      current
                    </span>
                  )}
                  {r.voidedAt !== null && (
                    <span
                      className="ml-2 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-rose-300"
                      title={`Voided ${r.voidedAt}`}
                      data-testid="anchor-voided-badge"
                    >
                      voided
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                  {r.programUnits === null ? '—' : r.programUnits.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                  {r.nonProgramUnits === null ? '—' : r.nonProgramUnits.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-dr3-mist-dim">
                  {r.reconciledDelta === null
                    ? '—'
                    : r.reconciledDelta > 0
                      ? `+${r.reconciledDelta}`
                      : String(r.reconciledDelta)}
                </td>
                <td className="px-3 py-2 text-right">
                  {/* ADR-0084 — no Re-activate on a voided count. Re-activation
                      copies a row's figures forward into a NEW live anchor, so
                      offering it here would launder a withdrawn number back into
                      the chain. The route refuses it independently (422
                      `snapshot_voided`); this only stops the offer being made. */}
                  {r.voidedAt === null && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(r);
                        setDone(null);
                        setError(null);
                      }}
                      className="rounded-md bg-dr3-steel/40 px-3 py-1.5 text-xs font-medium ring-1 ring-dr3-steel-light/25 hover:bg-dr3-steel/60"
                    >
                      Re-activate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="mt-5 rounded-lg bg-dr3-steel/20 p-5 ring-1 ring-amber-500/30">
          <p className="text-sm">
            Re-activate <strong>{selected.siteName}</strong>&apos;s anchor of{' '}
            <strong className="tabular-nums">{selected.total.toLocaleString()}</strong> units from{' '}
            {selected.at}. This writes a <strong>new</strong> snapshot with those figures. The
            anchor being replaced stays in the history.
          </p>
          <label className="mt-3 block text-xs uppercase tracking-wide text-dr3-mist-dim">
            Why is this being restored?
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md bg-dr3-space px-3 py-2 text-sm text-dr3-mist ring-1 ring-dr3-steel-light/25"
              placeholder="e.g. 07-31 count was mistyped — restoring the 07-22 anchor"
            />
          </label>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy || reason.trim() === ''}
              onClick={reactivate}
              className="rounded-md bg-amber-500/80 px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-50"
            >
              {busy ? 'Restoring…' : 'Restore this anchor'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setSelected(null)}
              className="rounded-md bg-dr3-steel/40 px-4 py-2 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
