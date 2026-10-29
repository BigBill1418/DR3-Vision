'use client';

// ADR-0143 D4 + Bill B4 — propose / approve / reject, four-eyes. `onClick`, never a
// <form> (CLAUDE.md hard rule 10). Every request has a deadline (ADR-0140).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithTimeout } from '@/lib/fetch-timeout';
import type { AdjustmentView } from '@/lib/inventory/exception-service';

type Pool = 'program' | 'non_program';
const LABEL: Record<Pool, string> = { program: 'Program', non_program: 'Non-program' };

const ERRORS: Record<string, string> = {
  four_eyes: 'A different person must approve. You proposed this.',
  already_decided: 'Someone already decided this. The page has been refreshed.',
  stale_proposal:
    'The proposal changed after this page loaded. It has been refreshed: read it again before approving.',
  still_negative: 'The pool is still negative: propose an adjustment instead.',
  reason_too_short: 'Write a reason of at least 10 characters.',
  units_invalid: 'Units must be a positive number (one decimal at most).',
  day_in_future: 'The day cannot be in the future.',
  invalid_input: 'Check the fields and try again.',
  not_activated: 'This surface is not activated for your role yet.',
};

export function ExceptionActions(props: {
  siteCode: string;
  exceptionId: string;
  exceptionOpen: boolean;
  pool: Pool;
  firstNegativeDay: string;
  currentUserId: string;
  adjustments: AdjustmentView[];
  resolutionProposedBy: string | null;
  resolutionProposedNote: string | null;
  resolutionProposedAt: string | null;
}) {
  const router = useRouter();
  const other: Pool = props.pool === 'program' ? 'non_program' : 'program';
  const [day, setDay] = useState(props.firstNegativeDay);
  const [units, setUnits] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const call = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetchWithTimeout(url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(ERRORS[e.error ?? ''] ?? `Refused (${res.status}).`);
      }
      router.refresh();
    } catch {
      setMsg('No answer from the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const base = `/api/manager/${props.siteCode}`;
  return (
    <div className="mt-3 flex flex-col gap-4">
      {msg && (
        <p role="alert" className="rounded bg-red-900/60 px-3 py-2 text-sm text-white">
          {msg}
        </p>
      )}
      {props.adjustments.map((a) => (
        <div key={a.id} className="rounded border border-white/15 bg-black/10 p-3 text-sm">
          <div>
            <strong>{a.units}</strong> units {LABEL[a.fromPool]} → {LABEL[a.toPool]}, dated {a.day}{' '}
            · {a.status.toUpperCase()}
          </div>
          <div className="opacity-80">{a.reason}</div>
          {a.status === 'proposed' && props.exceptionOpen && (
            <div className="mt-2 flex gap-3">
              <button
                type="button"
                disabled={busy || a.proposedBy === props.currentUserId}
                title={
                  a.proposedBy === props.currentUserId
                    ? 'A different person must approve'
                    : undefined
                }
                onClick={() =>
                  call(`${base}/inventory-adjustments/${a.id}`, 'POST', { decision: 'approve' })
                }
                className="rounded bg-dr3-cyan px-3 py-1 font-semibold text-black disabled:opacity-40"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  call(`${base}/inventory-adjustments/${a.id}`, 'POST', { decision: 'reject' })
                }
                className="rounded border border-white/30 px-3 py-1 disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}

      {props.exceptionOpen && (
        <section className="rounded border border-white/15 p-3 text-sm">
          <h3 className="font-semibold">Propose a pool adjustment</h3>
          <p className="opacity-80">
            Moves units from {LABEL[other]} to {LABEL[props.pool]} from the chosen day on. The total
            does not change. A second person must approve it.
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="flex flex-col">
              Day
              <input
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
                className="text-dr3-ink"
              />
            </label>
            <label className="flex flex-col">
              Units
              <input
                inputMode="decimal"
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                className="w-28 text-dr3-ink"
              />
            </label>
            <label className="flex flex-1 flex-col">
              Reason
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="text-dr3-ink"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                call(`${base}/inventory-exceptions/${props.exceptionId}/adjustments`, 'POST', {
                  day,
                  fromPool: other,
                  toPool: props.pool,
                  units: Number(units),
                  reason,
                })
              }
              className="rounded bg-dr3-cyan px-3 py-1 font-semibold text-black disabled:opacity-40"
            >
              Propose
            </button>
          </div>
        </section>
      )}

      {props.exceptionOpen && (
        <section className="rounded border border-white/15 p-3 text-sm">
          <h3 className="font-semibold">Close without an adjustment</h3>
          {props.resolutionProposedBy ? (
            <div>
              <p className="opacity-80">Proposed: {props.resolutionProposedNote}</p>
              <button
                type="button"
                disabled={busy || props.resolutionProposedBy === props.currentUserId}
                onClick={() =>
                  // Binds the approval to the proposal this page showed.
                  call(`${base}/inventory-exceptions/${props.exceptionId}/resolution`, 'PUT', {
                    expectedProposedAt: props.resolutionProposedAt,
                  })
                }
                className="mt-2 rounded bg-dr3-cyan px-3 py-1 font-semibold text-black disabled:opacity-40"
              >
                Approve closing
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <p className="w-full opacity-80">
                Only when the pool is no longer negative (for example, a count already reset it).
              </p>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why it can close"
                className="flex-1 text-dr3-ink"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  call(`${base}/inventory-exceptions/${props.exceptionId}/resolution`, 'POST', {
                    note,
                  })
                }
                className="rounded border border-white/30 px-3 py-1 disabled:opacity-40"
              >
                Propose closing
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
