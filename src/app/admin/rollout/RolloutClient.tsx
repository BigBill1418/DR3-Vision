'use client';

// ADR-0047 — the rollout panel's interactive flip control. Per fleet convention
// (CLAUDE.md hard rule #10) the flip is an onClick handler, not an HTML <form>.
// Flipping opens an inline confirm requiring a criteria note before it PATCHes
// /api/admin/rollout/[id].

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SurfaceRow {
  id: string;
  kind: 'notification' | 'ui';
  surfaceCode: string;
  siteLabel: string;
  state: 'pilot' | 'live';
  flippedByName: string | null;
  flippedAtISO: string | null;
  criteriaNote: string | null;
}

const KIND_LABEL: Record<SurfaceRow['kind'], string> = {
  notification: 'Notification surfaces',
  ui: 'UI surfaces',
};

export function RolloutClient({ rows }: { rows: SurfaceRow[] }) {
  const groups: SurfaceRow['kind'][] = ['notification', 'ui'];
  return (
    <div className="mt-8 space-y-10">
      {groups.map((kind) => {
        const group = rows.filter((r) => r.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind}>
            <h2 className="text-lg font-semibold text-dr3-mist">{KIND_LABEL[kind]}</h2>
            <div className="mt-3 overflow-hidden rounded-lg border border-white/10">
              {group.map((r, i) => (
                <SurfaceRowView key={r.id} row={r} first={i === 0} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StateBadge({ state }: { state: SurfaceRow['state'] }) {
  const live = state === 'live';
  return (
    <span
      className={`inline-block min-w-[52px] rounded px-2 py-0.5 text-center text-xs font-bold uppercase tracking-wide ${
        live ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
      }`}
    >
      {state}
    </span>
  );
}

function SurfaceRowView({ row, first }: { row: SurfaceRow; first: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target: SurfaceRow['state'] = row.state === 'live' ? 'pilot' : 'live';

  const submit = async () => {
    if (note.trim().length < 3) {
      setError('A criteria note is required (what evidence justifies this flip?).');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/rollout/${row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toState: target, criteriaNote: note.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Flip failed (HTTP ${res.status}).`);
        setPending(false);
        return;
      }
      setOpen(false);
      setNote('');
      setPending(false);
      router.refresh();
    } catch {
      setError('Network error — flip not applied.');
      setPending(false);
    }
  };

  return (
    <div className={`px-4 py-3 ${first ? '' : 'border-t border-white/10'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <StateBadge state={row.state} />
        <code className="text-sm text-dr3-mist">{row.surfaceCode}</code>
        <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-dr3-mist-dim">{row.siteLabel}</span>
        <div className="ml-auto">
          {open ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className="text-xs text-dr3-mist-dim underline-offset-2 hover:underline"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded bg-white/10 px-3 py-1 text-xs font-medium text-dr3-mist hover:bg-white/20"
            >
              Flip to {target}
            </button>
          )}
        </div>
      </div>

      {(row.flippedAtISO || row.criteriaNote) && !open && (
        <p className="mt-1 text-xs text-dr3-mist-dim">
          {row.flippedAtISO
            ? `Last flip ${new Date(row.flippedAtISO).toISOString().slice(0, 16).replace('T', ' ')} UTC${
                row.flippedByName ? ` by ${row.flippedByName}` : ''
              }`
            : ''}
          {row.criteriaNote ? ` — “${row.criteriaNote}”` : ''}
        </p>
      )}

      {open && (
        <div className="mt-3 rounded border border-white/10 bg-black/20 p-3">
          <p className="text-xs text-dr3-mist-dim">
            Confirm flip of <code>{row.surfaceCode}</code> ({row.siteLabel}) from{' '}
            <strong>{row.state}</strong> to <strong>{target}</strong>. Record the criteria/evidence — it is
            saved with the flip and audited.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="e.g. 5 consecutive reviewed pilot digests, zero bootstrap noise, 1 true finding handled end-to-end (§8 Stage 4)"
            className="mt-2 w-full rounded border border-white/15 bg-black/30 p-2 text-sm text-dr3-mist placeholder:text-dr3-mist-dim/60"
          />
          {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={pending}
              onClick={() => void submit()}
              className="rounded bg-dr3-cyan/20 px-3 py-1 text-xs font-semibold text-dr3-cyan hover:bg-dr3-cyan/30 disabled:opacity-50"
            >
              {pending ? 'Flipping…' : `Confirm flip to ${target}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
