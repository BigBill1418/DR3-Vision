'use client';

// ADR-0105 — the manager count-correction panel.
//
// Minimal on purpose. There is no approval flow (D4), no filter beyond the
// two-day window the API already enforces, and no client-side eligibility logic:
// `correctable` is computed server-side from the SAME predicate `correctPhysicalCount`
// gates on, so this component never decides who may correct what. If it rendered
// its own rule the screen would eventually offer a Correct button on a row the
// service refuses, which is the class of drift ADR-0084 D2 spent a guard test on.
//
// Refusals are surfaced VERBATIM. The 409 bodies already name the counted day,
// today, the earliest correctable day and where to go instead — re-wording them
// here would produce a second, drifting copy of the rule, and the server's copy is
// the one that is true.
//
// CLAUDE.md hard rule #10 — no <form>; every handler is onClick/onChange.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { WindowCountRow } from '@/lib/inventory/correct-count';

/** A row plus the names the page resolved for it (the service holds no `users` dep). */
export interface CountRowView extends Omit<WindowCountRow, 'enteredAt'> {
  /** ISO string — `enteredAt` crosses the server/client boundary as JSON. */
  enteredAtISO: string;
  enteredByName: string | null;
  voidedByName: string | null;
}

const cell = 'px-3 py-2 align-top';
const btn = 'rounded bg-dr3-cyan px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40';
const ghostBtn = 'rounded border border-white/25 px-3 py-1.5 text-sm disabled:opacity-40';
const input = 'w-28 rounded border border-white/20 bg-black/30 px-2 py-1 text-sm text-white';

function timeLabel(iso: string): string {
  // A true instant rendered in Bill's wall clock. `snapshot_at` is Pacific
  // midnight of the counted day, so it is useless for telling two of the day's
  // counts apart; `created_at` is the only column that distinguishes them.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export function CountCorrectionsClient({
  siteCode,
  rows,
}: {
  siteCode: string;
  rows: CountRowView[];
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const byId = new Map(rows.map((r) => [r.id, r]));

  const open = (r: CountRowView) => {
    setOpenId(r.id);
    setValue(String(r.physicalTotal));
    setMsg(null);
  };

  const submit = async (r: CountRowView) => {
    setBusy(true);
    setMsg(null);
    try {
      // The corrected value goes onto the SAME column the original used, so a
      // CA count (indoor) stays an indoor count and an OR count (total) stays a
      // total. Writing it to the other column would silently change what the
      // number means to `snapshotTotalUnits` and to the COR.
      const usesIndoor = r.units_indoor !== null;
      const entered = Number(value);
      const body = {
        units_indoor: usesIndoor ? entered - r.units_in_processing : null,
        units_total: usesIndoor ? null : entered - r.units_in_processing,
        units_in_processing: r.units_in_processing,
      };
      const res = await fetch(`/api/manager/${siteCode}/snapshots/${r.id}/correct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        toPhysicalTotal?: number;
      };
      if (!res.ok) {
        // Verbatim when the server wrote one — it names the window and the route.
        setMsg({
          kind: 'err',
          text:
            data.message ??
            `Correction refused (${res.status}${data.error ? ` ${data.error}` : ''}).`,
        });
        return;
      }
      setMsg({
        kind: 'ok',
        text: `Corrected ${r.physicalTotal.toLocaleString()} → ${(data.toPhysicalTotal ?? entered).toLocaleString()}. The previous count is kept, marked superseded.`,
      });
      setOpenId(null);
      router.refresh();
    } catch {
      setMsg({ kind: 'err', text: 'Could not reach the server. Nothing was changed.' });
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <p className="mt-6 text-sm opacity-80">
        No physical counts were recorded at this site today or yesterday. Corrections reach back one
        day; an older count is changed from <code>/admin/inventory/anchors</code>.
      </p>
    );
  }

  return (
    <div className="mt-6">
      {msg && (
        <p
          data-testid="correction-message"
          className={`mb-4 rounded border px-3 py-2 text-sm ${
            msg.kind === 'ok'
              ? 'border-dr3-cyan/40 bg-dr3-cyan/10'
              : 'border-red-400/40 bg-red-400/10'
          }`}
        >
          {msg.text}
        </p>
      )}

      <table className="w-full border-collapse text-left text-sm">
        <thead className="border-b border-white/20 text-xs uppercase tracking-wide opacity-70">
          <tr>
            <th className={cell}>Counted</th>
            <th className={cell}>Entered</th>
            <th className={cell}>By</th>
            <th className={cell}>Units</th>
            <th className={cell}>State</th>
            <th className={cell} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const superseded = r.voidedAt !== null;
            const replacement = r.correctedToId ? byId.get(r.correctedToId) : undefined;
            const original = r.correctedFromId ? byId.get(r.correctedFromId) : undefined;
            return (
              <tr
                key={r.id}
                data-testid={`count-row-${r.id}`}
                className="border-b border-white/10 align-top"
              >
                <td className={cell}>{r.countedDayISO}</td>
                <td className={cell}>{timeLabel(r.enteredAtISO)}</td>
                <td className={cell}>{r.enteredByName ?? 'not recorded'}</td>
                <td className={cell}>
                  <span className={superseded ? 'line-through opacity-60' : 'font-semibold'}>
                    {r.physicalTotal.toLocaleString()}
                  </span>
                </td>
                <td className={cell}>
                  {/* The chain, stated plainly. No verdict language — the screen
                      says what happened and who did it, and leaves the judgement
                      to the person reading it. */}
                  {!superseded && r.isCorrection && (
                    <span className="opacity-80">
                      corrected from{' '}
                      {original ? original.physicalTotal.toLocaleString() : 'an earlier count'}
                    </span>
                  )}
                  {!superseded && !r.isCorrection && <span className="opacity-60">as entered</span>}
                  {superseded && r.voidReason === 'corrected' && (
                    <span className="opacity-80">
                      superseded by{' '}
                      {replacement ? replacement.physicalTotal.toLocaleString() : 'a correction'}
                      {r.voidedByName ? ` — ${r.voidedByName}` : ''}
                    </span>
                  )}
                  {superseded && r.voidReason === 'withdrawn' && (
                    <span className="opacity-80">
                      withdrawn on the floor{r.voidedByName ? ` — ${r.voidedByName}` : ''}
                    </span>
                  )}
                </td>
                <td className={cell}>
                  {/* No affordance on a superseded row. The server refuses it 422
                      `snapshot_voided` either way — this keeps the screen from
                      offering an action that cannot succeed. */}
                  {r.correctable && openId !== r.id && (
                    <button
                      type="button"
                      className={ghostBtn}
                      onClick={() => open(r)}
                      data-testid={`correct-${r.id}`}
                    >
                      Correct
                    </button>
                  )}
                  {r.correctable && openId === r.id && (
                    <div className="flex items-center gap-2">
                      <label className="sr-only" htmlFor={`v-${r.id}`}>
                        Corrected unit count
                      </label>
                      <input
                        id={`v-${r.id}`}
                        className={input}
                        type="number"
                        inputMode="numeric"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        data-testid={`input-${r.id}`}
                      />
                      <button
                        type="button"
                        className={btn}
                        disabled={busy || value.trim() === ''}
                        onClick={() => void submit(r)}
                        data-testid={`save-${r.id}`}
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className={ghostBtn}
                        disabled={busy}
                        onClick={() => setOpenId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
