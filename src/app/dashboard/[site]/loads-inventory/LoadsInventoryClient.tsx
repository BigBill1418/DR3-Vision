'use client';

// ADR-0037 D3/D4 (Addendum B1) — manager CRUD-lite panels for the loads/inventory
// record types. CLAUDE.md hard rule #10 — no <form>; every handler is
// onClick/onChange. English-first (manager/office surface, not an operator iPad).
//
// person_name on drop-offs is CIP PII (Exhibit I / ADR-0010) — shown here on the
// access-controlled manager surface, but it is NEVER routed to an export.

import { useCallback, useEffect, useState } from 'react';
import type { DropoffView } from '@/lib/dropoffs/service';
import type { OutboundView } from '@/lib/loads/outbound';
import type { LandfilledView } from '@/lib/loads/landfilled';

type Tab = 'dropoffs' | 'outbound' | 'landfilled';
const TABS: { id: Tab; label: string }[] = [
  { id: 'dropoffs', label: 'Consumer drop-offs' },
  { id: 'outbound', label: 'Outbound materials' },
  { id: 'landfilled', label: 'Landfilled units' },
];
const COMMODITIES = [
  'trash', 'toppers', 'foam', 'metal', 'wood', 'cardboard', 'plastic', 'shoddy', 'cotton',
] as const;
const SUB_CATEGORIES = ['renovation', 'baled', 'shredded'] as const;
const DROPOFF_KINDS = ['incentive', 'unpaid', 'illegal'] as const;
const REASONS = ['bed_bug', 'soiled', 'water_logged', 'other'] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDate(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

async function getRows<T>(url: string): Promise<T[]> {
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { rows: T[] };
  return data.rows;
}

interface FieldMsg {
  kind: 'ok' | 'err';
  text: string;
}

export function LoadsInventoryClient({ siteCode }: { siteCode: string }) {
  const [tab, setTab] = useState<Tab>('dropoffs');
  return (
    <div className="mt-8">
      <div className="flex flex-wrap gap-2 border-b border-white/15">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-t px-3 py-2 text-sm ${
              tab === t.id ? 'bg-black/25 font-semibold text-dr3-chartreuse' : 'text-white/70 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === 'dropoffs' && <DropoffsPanel siteCode={siteCode} />}
        {tab === 'outbound' && <OutboundPanel siteCode={siteCode} />}
        {tab === 'landfilled' && <LandfilledPanel siteCode={siteCode} />}
      </div>
    </div>
  );
}

// Shared bits -------------------------------------------------------------
const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls = 'rounded bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

function Msg({ msg }: { msg: FieldMsg | null }) {
  if (!msg) return null;
  return <span className={msg.kind === 'ok' ? 'text-sm text-dr3-chartreuse' : 'text-sm text-red-300'}>{msg.text}</span>;
}

// Drop-offs ---------------------------------------------------------------
function DropoffsPanel({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<DropoffView[]>([]);
  const [date, setDate] = useState(todayIso());
  const [personName, setPersonName] = useState('');
  const [units, setUnits] = useState('');
  const [kind, setKind] = useState<(typeof DROPOFF_KINDS)[number]>('incentive');
  const [slip, setSlip] = useState('');
  const [check, setCheck] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  const load = useCallback(async () => {
    setRows(await getRows<DropoffView>(`/api/manager/${siteCode}/dropoffs`));
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/dropoffs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dropoffDate: date,
          kind,
          personName,
          units: Number(units),
          slipNumber: slip || undefined,
          checkNumber: check || undefined,
        }),
      });
      if (!res.ok) {
        setMsg({ kind: 'err', text: `Save failed (${res.status}).` });
        return;
      }
      setMsg({ kind: 'ok', text: 'Drop-off recorded.' });
      setPersonName('');
      setUnits('');
      setSlip('');
      setCheck('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canSave = personName.trim() !== '' && Number(units) > 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={labelCls}>
          <span className="opacity-70">Date</span>
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Kind</span>
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as (typeof DROPOFF_KINDS)[number])}>
            {DROPOFF_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Dropped off by</span>
          <input className={inputCls} value={personName} onChange={(e) => setPersonName(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Units</span>
          <input type="number" min="1" className={inputCls} value={units} onChange={(e) => setUnits(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Slip #</span>
          <input className={inputCls} value={slip} onChange={(e) => setSlip(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Check #</span>
          <input className={inputCls} value={check} onChange={(e) => setCheck(e.target.value)} />
        </label>
      </div>
      <div className="flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? 'Saving…' : 'Add drop-off'}
        </button>
        <Msg msg={msg} />
      </div>
      <p className="text-xs opacity-70">Only incentive drop-offs are paid; unpaid and illegal carry no incentive.</p>
      <RecordTable
        head={['Date', 'Kind', 'By', 'Units', 'Incentive', 'Slip']}
        rows={rows.map((r) => [
          isoDate(r.dropoffDate),
          r.kind,
          r.personName,
          String(r.units),
          r.incentiveCents == null ? '—' : `$${(r.incentiveCents / 100).toFixed(2)}`,
          r.slipNumber ?? '—',
        ])}
      />
    </div>
  );
}

// Outbound ----------------------------------------------------------------
function OutboundPanel({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<OutboundView[]>([]);
  const [date, setDate] = useState(todayIso());
  const [commodity, setCommodity] = useState<(typeof COMMODITIES)[number]>('metal');
  const [subCategory, setSubCategory] = useState<(typeof SUB_CATEGORIES)[number]>('baled');
  const [weight, setWeight] = useState('');
  const [whole, setWhole] = useState('');
  const [program, setProgram] = useState('');
  const [nonProgram, setNonProgram] = useState('');
  const [ticket, setTicket] = useState('');
  const [bales, setBales] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  const isRenovation = subCategory === 'renovation';

  const load = useCallback(async () => {
    setRows(await getRows<OutboundView>(`/api/manager/${siteCode}/outbound`));
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/outbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shipDate: date,
          commodity,
          subCategory,
          weightLbs: Number(weight),
          wholeUnits: isRenovation && whole ? Number(whole) : undefined,
          programUnits: isRenovation && whole ? Number(program || '0') : undefined,
          nonProgramUnits: isRenovation && whole ? Number(nonProgram || '0') : undefined,
          ticketNumber: ticket || undefined,
          baleCount: bales ? Number(bales) : undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({ kind: 'err', text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).` });
        return;
      }
      setMsg({ kind: 'ok', text: 'Outbound recorded.' });
      setWeight('');
      setWhole('');
      setProgram('');
      setNonProgram('');
      setTicket('');
      setBales('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canSave = Number(weight) >= 0 && weight !== '';
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={labelCls}>
          <span className="opacity-70">Date</span>
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Commodity</span>
          <select className={inputCls} value={commodity} onChange={(e) => setCommodity(e.target.value as (typeof COMMODITIES)[number])}>
            {COMMODITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Sub-category</span>
          <select className={inputCls} value={subCategory} onChange={(e) => setSubCategory(e.target.value as (typeof SUB_CATEGORIES)[number])}>
            {SUB_CATEGORIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Weight (lbs)</span>
          <input type="number" min="0" className={inputCls} value={weight} onChange={(e) => setWeight(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Ticket #</span>
          <input className={inputCls} value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Bale count</span>
          <input type="number" min="0" className={inputCls} value={bales} onChange={(e) => setBales(e.target.value)} />
        </label>
      </div>
      {isRenovation && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className={labelCls}>
            <span className="opacity-70">Whole units</span>
            <input type="number" min="1" className={inputCls} value={whole} onChange={(e) => setWhole(e.target.value)} />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">Program</span>
            <input type="number" min="0" className={inputCls} value={program} onChange={(e) => setProgram(e.target.value)} />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">Non-program</span>
            <input type="number" min="0" className={inputCls} value={nonProgram} onChange={(e) => setNonProgram(e.target.value)} />
          </label>
        </div>
      )}
      <div className="flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? 'Saving…' : 'Add outbound'}
        </button>
        <Msg msg={msg} />
      </div>
      <p className="text-xs opacity-70">
        Renovation = whole-unit sale (program + non-program must equal whole units; counts toward the running
        balance). Baled / shredded = weight-based commodity sales (never subtract units).
      </p>
      <RecordTable
        head={['Date', 'Commodity', 'Sub-cat', 'Lbs', 'Whole', 'Avg/bale']}
        rows={rows.map((r) => [
          isoDate(r.shipDate),
          r.commodity,
          r.subCategory,
          String(r.weightLbs),
          r.wholeUnits == null ? '—' : String(r.wholeUnits),
          r.avgLbsPerBale ?? '—',
        ])}
      />
    </div>
  );
}

// Landfilled --------------------------------------------------------------
function LandfilledPanel({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<LandfilledView[]>([]);
  const [date, setDate] = useState(todayIso());
  const [units, setUnits] = useState('');
  const [program, setProgram] = useState('0');
  const [nonProgram, setNonProgram] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('other');
  const [slip, setSlip] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  const load = useCallback(async () => {
    setRows(await getRows<LandfilledView>(`/api/manager/${siteCode}/landfilled`));
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/landfilled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          disposalDate: date,
          units: Number(units),
          programUnits: Number(program || '0'),
          nonProgramUnits: Number(nonProgram || '0'),
          reason,
          slipNumber: slip || undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({ kind: 'err', text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).` });
        return;
      }
      setMsg({ kind: 'ok', text: 'Disposal recorded.' });
      setUnits('');
      setProgram('0');
      setNonProgram('');
      setSlip('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canSave = Number(units) > 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={labelCls}>
          <span className="opacity-70">Date</span>
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Units</span>
          <input type="number" min="1" className={inputCls} value={units} onChange={(e) => setUnits(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Program</span>
          <input type="number" min="0" className={inputCls} value={program} onChange={(e) => setProgram(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Non-program</span>
          <input type="number" min="0" className={inputCls} value={nonProgram} onChange={(e) => setNonProgram(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Reason</span>
          <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Slip #</span>
          <input className={inputCls} value={slip} onChange={(e) => setSlip(e.target.value)} />
        </label>
      </div>
      <div className="flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? 'Saving…' : 'Add disposal'}
        </button>
        <Msg msg={msg} />
      </div>
      <p className="text-xs opacity-70">Program + non-program must equal units (server-enforced).</p>
      <RecordTable
        head={['Date', 'Units', 'Program', 'Non-program', 'Reason', 'Slip']}
        rows={rows.map((r) => [
          isoDate(r.disposalDate),
          String(r.units),
          String(r.programUnits),
          String(r.nonProgramUnits),
          r.reason.replace('_', ' '),
          r.slipNumber ?? '—',
        ])}
      />
    </div>
  );
}

// Shared table ------------------------------------------------------------
function RecordTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="opacity-70">
        <tr>
          {head.map((h) => (
            <th key={h} className="py-2">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={head.length} className="py-4 opacity-70">
              No records yet.
            </td>
          </tr>
        )}
        {rows.map((cells, i) => (
          <tr key={i} className="border-t border-white/10">
            {cells.map((c, j) => (
              <td key={j} className="py-2">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
