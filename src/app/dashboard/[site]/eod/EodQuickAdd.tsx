'use client';

// ADR-0125 — the gap-fill add-lines for the channels that ALREADY have a write
// path.
//
// These post to the EXISTING manager endpoints — `/api/manager/[site]/outbound`,
// `/api/manager/[site]/dropoffs`, `/api/manager/[site]/processed-units`. Nothing
// here re-plumbs capture. The handoff is explicit about that, and it is also the
// only way the EOD screen and the loads/inventory tabs cannot end up writing the
// same tables through two different sets of validation.
//
// ONE outbound add-line with a commodity selector reproduces all NINE of the
// sheet's per-commodity tables, and the sub-category selector covers the
// Renovation tab too. Nine panels would be nine chances to diverge.
//
// GATE NOTE: those three endpoints are gated on the `loads_inventory` rollout
// surface, while this screen is gated on `eod_review`. An admin passes both. For
// a non-admin manager, BOTH must be live at the site — the error surfaces
// explicitly below rather than failing silently.
//
// CLAUDE.md hard rule #10 — onClick handlers, no <form>.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls = 'rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

const COMMODITIES = [
  'trash',
  'toppers',
  'foam',
  'metal',
  'wood',
  'cardboard',
  'plastic',
  'shoddy',
  'cotton',
] as const;
const SUB_CATEGORIES = ['baled', 'shredded', 'renovation'] as const;

type Msg = { kind: 'ok' | 'err'; text: string } | null;

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error === 'not_activated') {
    return 'This write path is gated by the loads_inventory rollout surface, which is not live for this site yet.';
  }
  if (body.error === 'closed') {
    return 'That day is already closed and locked for billing — corrections follow the amendment path.';
  }
  return body.error ?? `Save failed (${res.status}).`;
}

export function EodQuickAdd({ siteCode, dayKey }: { siteCode: string; dayKey: string }) {
  return (
    <section
      data-testid="eod-quick-add"
      className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-5"
    >
      <h2 className="text-lg font-semibold">Fill a gap</h2>
      <p className="mt-1 text-xs text-dr3-mist-dim">
        These write through the same services the loads &amp; inventory tabs use — same validation,
        same audit rows, same day keys. Nothing here is a second capture path.
      </p>
      <div className="mt-4 flex flex-col gap-6">
        <OutboundAdd siteCode={siteCode} dayKey={dayKey} />
        <DropoffAdd siteCode={siteCode} dayKey={dayKey} />
        <ProcessedAdd siteCode={siteCode} dayKey={dayKey} />
      </div>
    </section>
  );
}

function OutboundAdd({ siteCode, dayKey }: { siteCode: string; dayKey: string }) {
  const router = useRouter();
  const [commodity, setCommodity] = useState<(typeof COMMODITIES)[number]>('trash');
  const [subCategory, setSubCategory] = useState<(typeof SUB_CATEGORIES)[number]>('baled');
  const [weight, setWeight] = useState('');
  const [ticket, setTicket] = useState('');
  const [wholeUnits, setWholeUnits] = useState('');
  const [program, setProgram] = useState('');
  const [nonProgram, setNonProgram] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const isRenovation = subCategory === 'renovation';
  const w = Number(weight);
  const canSave = weight.trim() !== '' && Number.isInteger(w) && w >= 0;

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/outbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shipDate: dayKey,
          commodity,
          subCategory,
          weightLbs: w,
          ...(ticket ? { ticketNumber: ticket } : {}),
          // Renovation is the only sub-category that moves whole units out of
          // inventory; baled/shredded are weight-only and balance-neutral, and
          // the service REFUSES unit fields on them.
          ...(isRenovation && wholeUnits.trim() !== ''
            ? {
                wholeUnits: Number(wholeUnits),
                programUnits: Number(program || '0'),
                nonProgramUnits: Number(nonProgram || '0'),
              }
            : {}),
        }),
      });
      if (!res.ok) return void setMsg({ kind: 'err', text: await errorText(res) });
      setMsg({ kind: 'ok', text: 'Outbound line recorded.' });
      setWeight('');
      setTicket('');
      setWholeUnits('');
      setProgram('');
      setNonProgram('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-dr3-cyan">
        Outbound commodity / renovation
      </h3>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={labelCls}>
          <span className="opacity-70">Commodity</span>
          <select
            className={inputCls}
            value={commodity}
            onChange={(e) => setCommodity(e.target.value as (typeof COMMODITIES)[number])}
          >
            {COMMODITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Sub-category</span>
          <select
            className={inputCls}
            value={subCategory}
            onChange={(e) => setSubCategory(e.target.value as (typeof SUB_CATEGORIES)[number])}
          >
            {SUB_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
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
          <span className="opacity-70">Ticket #</span>
          <input className={inputCls} value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </label>
        {isRenovation && (
          <>
            <label className={labelCls}>
              <span className="opacity-70">Whole units</span>
              <input
                type="number"
                min="1"
                className={inputCls}
                value={wholeUnits}
                onChange={(e) => setWholeUnits(e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span className="opacity-70">Program / non-program</span>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  aria-label="Renovation program units"
                  className={`${inputCls} w-full`}
                  value={program}
                  onChange={(e) => setProgram(e.target.value)}
                />
                <input
                  type="number"
                  min="0"
                  aria-label="Renovation non-program units"
                  className={`${inputCls} w-full`}
                  value={nonProgram}
                  onChange={(e) => setNonProgram(e.target.value)}
                />
              </div>
            </label>
          </>
        )}
      </div>
      <div className="mt-3 flex items-center gap-4">
        <button type="button" className={btnCls} disabled={!canSave || busy} onClick={add}>
          {busy ? 'Saving…' : 'Add outbound line'}
        </button>
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function DropoffAdd({ siteCode, dayKey }: { siteCode: string; dayKey: string }) {
  const router = useRouter();
  // The manager desktop offers exactly these three. The two `floor_*` kinds are
  // iPad-only by CHECK constraint (they require a photo this screen cannot
  // capture), so offering them here would produce a constraint violation instead
  // of a saved record.
  const [kind, setKind] = useState<'unpaid' | 'incentive' | 'illegal'>('unpaid');
  const [person, setPerson] = useState('');
  const [units, setUnits] = useState('');
  const [check, setCheck] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const canSave = person.trim() !== '' && Number(units) > 0;

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/dropoffs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dropoffDate: dayKey,
          kind,
          personName: person,
          units: Number(units),
          ...(check ? { checkNumber: check } : {}),
        }),
      });
      if (!res.ok) return void setMsg({ kind: 'err', text: await errorText(res) });
      setMsg({ kind: 'ok', text: 'Drop-off recorded.' });
      setPerson('');
      setUnits('');
      setCheck('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-dr3-cyan">
        Consumer drop-off
      </h3>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className={labelCls}>
          <span className="opacity-70">Kind</span>
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'unpaid' | 'incentive' | 'illegal')}
          >
            <option value="unpaid">unpaid</option>
            <option value="incentive">incentive</option>
            <option value="illegal">illegal</option>
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Dropped off by</span>
          <input className={inputCls} value={person} onChange={(e) => setPerson(e.target.value)} />
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
          <span className="opacity-70">Check #</span>
          <input className={inputCls} value={check} onChange={(e) => setCheck(e.target.value)} />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <button type="button" className={btnCls} disabled={!canSave || busy} onClick={add}>
          {busy ? 'Saving…' : 'Add drop-off'}
        </button>
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function ProcessedAdd({ siteCode, dayKey }: { siteCode: string; dayKey: string }) {
  const router = useRouter();
  const [program, setProgram] = useState('');
  const [nonProgram, setNonProgram] = useState('0');
  const [ticket, setTicket] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const canSave = program.trim() !== '' && Number.isFinite(Number(program));

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/processed-units`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          productionDate: dayKey,
          strippedProgram: Number(program),
          strippedNonProgram: Number(nonProgram || '0'),
          ...(ticket ? { materialTicketNumber: ticket } : {}),
        }),
      });
      if (!res.ok) return void setMsg({ kind: 'err', text: await errorText(res) });
      setMsg({ kind: 'ok', text: 'Daily close recorded — Bill reviews and locks it.' });
      setProgram('');
      setNonProgram('0');
      setTicket('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-dr3-cyan">
        Processed (stripped units)
      </h3>
      <p className="mt-1 text-xs text-dr3-mist-dim">
        Writing here takes AUTHORSHIP of the day: the row becomes <code>manual</code>, which
        outranks the workbook import and the MyMRC bridge and is never overwritten by either
        (ADR-0123). A day Bill has already closed and locked is refused.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className={labelCls}>
          <span className="opacity-70">Stripped program</span>
          <input
            type="number"
            min="0"
            step="0.1"
            className={inputCls}
            value={program}
            onChange={(e) => setProgram(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Stripped non-program</span>
          <input
            type="number"
            min="0"
            step="0.1"
            className={inputCls}
            value={nonProgram}
            onChange={(e) => setNonProgram(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">M-number</span>
          <input className={inputCls} value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <button type="button" className={btnCls} disabled={!canSave || busy} onClick={add}>
          {busy ? 'Saving…' : 'Record daily close'}
        </button>
        {msg && (
          <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
