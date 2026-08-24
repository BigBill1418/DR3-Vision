'use client';

// ADR-0125 — close the day, or reopen it with a reason.
//
// The close-with-exception control PRE-FILLS the note with the sections that are
// still flagged. Not cosmetic: a free-text box next to a "close anyway" button
// gets "n/a" typed into it, and then the record of what was outstanding is gone.
// The manager can edit or replace the text, but the default says something true.
//
// CLAUDE.md hard rule #10 — onClick handlers, no <form>.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const btnCls = 'rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';
const btnGhost =
  'rounded border border-dr3-steel-light/40 px-4 py-2 text-sm font-semibold text-dr3-mist disabled:opacity-40';

/** Mirrors MIN_EOD_REASON_CHARS in src/lib/eod/day-close.ts. */
const MIN_CHARS = 4;

export function EodCloseControls({
  siteCode,
  dayKey,
  closed,
  missing,
}: {
  siteCode: string;
  dayKey: string;
  closed: boolean;
  missing: string[];
}) {
  const router = useRouter();
  const [note, setNote] = useState(
    missing.length > 0 ? `Still outstanding: ${missing.join(', ')}` : '',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fail = async (res: Response): Promise<void> => {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const text =
      body.error === 'already_closed'
        ? 'That day is already closed — reopen it with a reason first.'
        : body.error === 'not_closed'
          ? 'That day is not closed, so there is nothing to reopen.'
          : body.error === 'not_activated'
            ? 'This surface is not yet activated for this site.'
            : (body.error ?? `Failed (${res.status}).`);
    setMsg({ kind: 'err', text });
  };

  const close = async (outcome: 'clean' | 'exception') => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/eod/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          day: dayKey,
          outcome,
          ...(outcome === 'exception' ? { exceptionNote: note } : {}),
        }),
      });
      if (!res.ok) return void (await fail(res));
      setMsg({ kind: 'ok', text: `Day ${dayKey} closed.` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const reopen = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/eod/close`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ day: dayKey, reason }),
      });
      if (!res.ok) return void (await fail(res));
      setMsg({ kind: 'ok', text: `Day ${dayKey} reopened.` });
      setReason('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (closed) {
    return (
      <section
        data-testid="eod-reopen-controls"
        className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-5"
      >
        <h2 className="text-lg font-semibold">Reopen this day</h2>
        <p className="mt-1 text-xs text-dr3-mist-dim">
          A reopen is recorded with who, when and why. Corrections do not require a reopen — the
          amendment paths work on a closed day; reopen when the day&apos;s review itself was wrong.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex min-w-[20rem] flex-1 flex-col gap-1 text-sm">
            <span className="opacity-70">Reason (required, {MIN_CHARS}+ characters)</span>
            <input
              className={inputCls}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. two hauls were entered on the wrong day"
            />
          </label>
          <button
            type="button"
            className={btnGhost}
            disabled={busy || reason.trim().length < MIN_CHARS}
            onClick={reopen}
          >
            {busy ? 'Reopening…' : 'Reopen day'}
          </button>
          {msg && (
            <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
              {msg.text}
            </span>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="eod-close-controls"
      className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-5"
    >
      <h2 className="text-lg font-semibold">Close this day</h2>
      {missing.length > 0 ? (
        <p className="mt-1 text-sm text-amber-200" data-testid="eod-close-open-gaps">
          {missing.length} section(s) not recorded: {missing.join(', ')}. Fill them, or close with
          an exception naming what is still out.
        </p>
      ) : (
        <p className="mt-1 text-sm text-dr3-mist-dim" data-testid="eod-close-no-gaps">
          Every section is captured.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <button type="button" className={btnCls} disabled={busy} onClick={() => close('clean')}>
          {busy ? 'Closing…' : 'Close clean'}
        </button>
        <label className="flex min-w-[20rem] flex-1 flex-col gap-1 text-sm">
          <span className="opacity-70">Exception note ({MIN_CHARS}+ characters)</span>
          <input
            className={inputCls}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="what is still outstanding"
          />
        </label>
        <button
          type="button"
          className={btnGhost}
          disabled={busy || note.trim().length < MIN_CHARS}
          onClick={() => close('exception')}
        >
          Close with exception
        </button>
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
            {msg.text}
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-dr3-mist-dim">
        Closing marks the day reviewed. It locks nothing — every existing correction path keeps
        working, and this day can be reopened with a reason.
      </p>
    </section>
  );
}
