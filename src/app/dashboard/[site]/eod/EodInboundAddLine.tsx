'use client';

// ADR-0125 — the inbound gap-fill line, and the freight-flag correction on rows
// that already exist.
//
// This is where a manager spends their time (measured: ~144 inbound rows a
// month), so it is the heaviest affordance on the screen and it carries every
// identifier the workbook does: BOL/Check #, DR3 #, Haul #, Slip #, the
// program/non-program split, the weight and the freight flag.
//
// THE DR3 NUMBER IS TYPED, NOT ISSUED. Vision's counter reads 5000 while the
// sheet is at 4,755 and climbing ~11/day, so automatic issuance would collide
// around late October. Reseed-vs-cutover is Bill's open decision.
//
// The freight checkbox pre-fills from the chosen source's classifier and stays
// editable. Sending it explicitly (rather than letting the server default) means
// what the manager saw is what was stored.
//
// CLAUDE.md hard rule #10 — onClick handlers, no <form>.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls = 'rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

export interface SourceOption {
  id: string;
  name: string;
  isTransCharge: boolean;
}

export interface InboundRowOption {
  id: string;
  label: string;
  transportCharged: boolean;
}

function whole(s: string): number | null {
  if (s.trim() === '') return null;
  const v = Number(s);
  return Number.isInteger(v) ? v : null;
}

export function EodInboundAddLine({
  siteCode,
  dayKey,
  sources,
  rows,
}: {
  siteCode: string;
  dayKey: string;
  sources: SourceOption[];
  rows: InboundRowOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [units, setUnits] = useState('');
  const [program, setProgram] = useState('');
  const [nonProgram, setNonProgram] = useState('0');
  const [weight, setWeight] = useState('');
  const [bol, setBol] = useState('');
  const [dr3, setDr3] = useState('');
  const [haul, setHaul] = useState('');
  const [slip, setSlip] = useState('');
  const [freight, setFreight] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const pickSource = (id: string) => {
    setSourceId(id);
    const s = sources.find((x) => x.id === id);
    // The classifier proposes; the manager disposes. Pre-filling is what makes
    // the freight/no-freight split cheap to get right on ~144 rows a month.
    if (s) setFreight(s.isTransCharge);
  };

  const u = whole(units);
  const p = whole(program);
  const np = whole(nonProgram);
  const splitOk = u !== null && p !== null && np !== null && p >= 0 && np >= 0 && p + np === u;
  const canSave = u !== null && u > 0 && splitOk;

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/eod/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          day: dayKey,
          totalUnits: u,
          programUnits: p,
          nonProgramUnits: np,
          weightLbs: whole(weight),
          sourceId: sourceId === '' ? null : sourceId,
          bolNumber: bol || undefined,
          dr3Number: dr3 || undefined,
          haulNumber: haul || undefined,
          slipNumber: slip || undefined,
          transportCharged: freight,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({
          kind: 'err',
          text:
            body.error === 'aggregate_covers_day'
              ? 'This day already has a whole-day inbound total. Correct that total instead — adding a line here would count the same units twice.'
              : body.error === 'haul_number_taken'
                ? 'That haul # is already on another load.'
                : (body.error ?? `Save failed (${res.status}).`),
        });
        return;
      }
      setMsg({ kind: 'ok', text: 'Inbound line recorded.' });
      setUnits('');
      setProgram('');
      setNonProgram('0');
      setWeight('');
      setBol('');
      setDr3('');
      setHaul('');
      setSlip('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const setRowFreight = async (loadId: string, next: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/eod/inbound`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loadId, transportCharged: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({ kind: 'err', text: body.error ?? `Update failed (${res.status}).` });
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4" data-testid="eod-inbound-addline">
      <button
        type="button"
        className="text-sm text-dr3-mist-dim underline hover:text-dr3-cyan"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide' : 'Add a missing inbound line'}
      </button>

      {open && (
        <div className="mt-3 rounded border border-white/15 bg-black/20 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <label className={labelCls}>
              <span className="opacity-70">Source</span>
              <select
                className={inputCls}
                value={sourceId}
                onChange={(e) => pickSource(e.target.value)}
              >
                <option value="">— none —</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className="opacity-70">Units</span>
              <input
                type="number"
                min="1"
                className={inputCls}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">Program</span>
              <input
                type="number"
                min="0"
                className={inputCls}
                value={program}
                onChange={(e) => setProgram(e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">Non-program</span>
              <input
                type="number"
                min="0"
                className={inputCls}
                value={nonProgram}
                onChange={(e) => setNonProgram(e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">LBS</span>
              <input
                type="number"
                min="0"
                className={inputCls}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">BOL / Check #</span>
              <input className={inputCls} value={bol} onChange={(e) => setBol(e.target.value)} />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">DR3 #</span>
              <input className={inputCls} value={dr3} onChange={(e) => setDr3(e.target.value)} />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">Haul #</span>
              <input className={inputCls} value={haul} onChange={(e) => setHaul(e.target.value)} />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">Slip #</span>
              <input className={inputCls} value={slip} onChange={(e) => setSlip(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input
                type="checkbox"
                data-testid="eod-inbound-freight"
                checked={freight}
                onChange={(e) => setFreight(e.target.checked)}
              />
              <span>Trans charge (freight)</span>
            </label>
          </div>
          {!splitOk && units.trim() !== '' && (
            <p className="mt-2 text-xs text-amber-300">
              Program + non-program must equal units — MRC is billed on the program pool, so a split
              that does not sum would mis-state it.
            </p>
          )}
          <div className="mt-4 flex items-center gap-4">
            <button type="button" className={btnCls} disabled={!canSave || busy} onClick={add}>
              {busy ? 'Saving…' : 'Add inbound line'}
            </button>
            {msg && (
              <span
                className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}
              >
                {msg.text}
              </span>
            )}
          </div>
          <p className="mt-3 text-xs text-dr3-mist-dim">
            DR3 # is typed here, not issued — Vision&apos;s counter and the sheet&apos;s numbering
            have not been reconciled yet, so nothing on this screen consumes a number.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">
            Freight flag (which inbound tab each line belongs to)
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {rows.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={`eod-row-freight-${r.id}`}
                  checked={r.transportCharged}
                  disabled={busy}
                  onChange={(e) => void setRowFreight(r.id, e.target.checked)}
                />
                <span>{r.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
