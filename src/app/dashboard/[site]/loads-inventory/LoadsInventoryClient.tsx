'use client';

// ADR-0037 D3/D4 (Addendum B1) — manager CRUD-lite panels for the loads/inventory
// record types. CLAUDE.md hard rule #10 — no <form>; every handler is
// onClick/onChange. English-first (manager/office surface, not an operator iPad).
//
// person_name on drop-offs is CIP PII (Exhibit I / ADR-0010) — shown here on the
// access-controlled manager surface, but it is NEVER routed to an export.

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { DropoffView } from '@/lib/dropoffs/service';
import type { OutboundView } from '@/lib/loads/outbound';
import type { LandfilledView } from '@/lib/loads/landfilled';
import type { EventView } from '@/lib/events/service';
import type { OrCountView } from '@/lib/events/or-counts';

type Tab = 'physical' | 'dropoffs' | 'outbound' | 'landfilled' | 'events' | 'orcounts';
// ADR-0047 UI gate — the events + OR-counts tabs are gated by
// `loads_events_or_tabs`; the base physical/drop-off/outbound/landfilled tabs are not.
const EVENTS_OR_TABS: ReadonlySet<Tab> = new Set(['events', 'orcounts']);
const TABS: { id: Tab; label: string }[] = [
  { id: 'physical', label: 'Physical count' },
  { id: 'dropoffs', label: 'Consumer drop-offs' },
  { id: 'outbound', label: 'Outbound materials' },
  { id: 'landfilled', label: 'Landfilled units' },
  { id: 'events', label: 'Collection events' },
  { id: 'orcounts', label: 'OR collection counts' },
];
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

export function LoadsInventoryClient({
  siteCode,
  showEventsOrTabs = true,
  computedTotal,
}: {
  siteCode: string;
  // ADR-0047 UI gate — hide the events/OR-counts tabs unless flipped live for
  // the site (or the viewer is an admin). Passed from the server page.
  showEventsOrTabs?: boolean;
  // ADR-0037 §3 — the server-computed running total (from onHand), shown in the
  // physical-count panel as the reconcile-delta preview. Optional/additive.
  computedTotal?: string;
}) {
  const [tab, setTab] = useState<Tab>('physical');
  const tabs = showEventsOrTabs ? TABS : TABS.filter((t) => !EVENTS_OR_TABS.has(t.id));
  return (
    <div className="mt-8">
      <div className="flex flex-wrap gap-2 border-b border-white/15">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-t px-3 py-2 text-sm ${
              tab === t.id
                ? 'bg-black/25 font-semibold text-dr3-chartreuse'
                : 'text-white/70 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === 'physical' && (
          <PhysicalCountPanel siteCode={siteCode} computedTotal={computedTotal} />
        )}
        {tab === 'dropoffs' && <DropoffsPanel siteCode={siteCode} />}
        {tab === 'outbound' && <OutboundPanel siteCode={siteCode} />}
        {tab === 'landfilled' && <LandfilledPanel siteCode={siteCode} />}
        {tab === 'events' && <EventsPanel siteCode={siteCode} />}
        {tab === 'orcounts' && <OrCountsPanel siteCode={siteCode} />}
      </div>
    </div>
  );
}

// Shared bits -------------------------------------------------------------
const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls =
  'rounded bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

function Msg({ msg }: { msg: FieldMsg | null }) {
  if (!msg) return null;
  return (
    <span className={msg.kind === 'ok' ? 'text-sm text-dr3-chartreuse' : 'text-sm text-red-300'}>
      {msg.text}
    </span>
  );
}

// Physical count (ADR-0037 §3 pool split) --------------------------------
/** A count field: whole number or null when blank. */
function unitOrNull(s: string): number | null {
  if (s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? Math.trunc(v) : null;
}
/** A live numeric value for the running total (blank/invalid → 0). */
function liveNum(s: string): number {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

function PhysicalCountPanel({
  siteCode,
  computedTotal,
}: {
  siteCode: string;
  computedTotal?: string | undefined;
}) {
  const t = useT();
  const [date, setDate] = useState(todayIso());
  const [indoor, setIndoor] = useState('');
  const [outdoor, setOutdoor] = useState('');
  const [total, setTotal] = useState('');
  const [processing, setProcessing] = useState('');
  const [program, setProgram] = useState('');
  const [nonProgram, setNonProgram] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  // Live physical-count total = the jurisdiction unit fields + in-processing.
  const physicalTotal =
    liveNum(indoor) + liveNum(outdoor) + liveNum(total) + liveNum(processing);
  const bothPools = program.trim() !== '' && nonProgram.trim() !== '';
  const splitSum = liveNum(program) + liveNum(nonProgram);
  const mismatch = bothPools && splitSum !== physicalTotal;
  const computed = computedTotal != null && computedTotal !== '' ? Number(computedTotal) : null;
  const reconcileDelta = computed != null ? physicalTotal - computed : null;

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/snapshots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          countedAt: date,
          units_indoor: unitOrNull(indoor),
          units_outdoor: unitOrNull(outdoor),
          units_total: unitOrNull(total),
          units_in_processing: liveNum(processing),
          program_units: unitOrNull(program) ?? undefined,
          non_program_units: unitOrNull(nonProgram) ?? undefined,
          pool_attribution: 'measured',
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setMsg({
          kind: 'err',
          text: err.message ?? `${t('physical_count.save_failed')} (${res.status}).`,
        });
        return;
      }
      setMsg({ kind: 'ok', text: t('physical_count.save_success') });
      setIndoor('');
      setOutdoor('');
      setTotal('');
      setProcessing('');
      setProgram('');
      setNonProgram('');
    } finally {
      setBusy(false);
    }
  };

  const canSave = physicalTotal > 0 && !mismatch;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-dr3-chartreuse">
          {t('physical_count.heading')}
        </h2>
        <p className="mt-1 text-xs opacity-70">{t('physical_count.help')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={labelCls}>
          <span className="opacity-70">{t('physical_count.date_label')}</span>
          <input
            type="date"
            className={inputCls}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">{t('physical_count.units_indoor_label')}</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={indoor}
            onChange={(e) => setIndoor(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">{t('physical_count.units_outdoor_label')}</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={outdoor}
            onChange={(e) => setOutdoor(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">{t('physical_count.units_total_label')}</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={total}
            onChange={(e) => setTotal(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">{t('physical_count.units_processing_label')}</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={processing}
            onChange={(e) => setProcessing(e.target.value)}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className={labelCls}>
          <span className="opacity-70">{t('physical_count.program_units_label')}</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={program}
            onChange={(e) => setProgram(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">{t('physical_count.non_program_units_label')}</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={nonProgram}
            onChange={(e) => setNonProgram(e.target.value)}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <CountStat label={t('physical_count.count_total_label')} value={String(physicalTotal)} accent />
        <CountStat
          label={t('physical_count.split_entered_label')}
          value={bothPools ? String(splitSum) : '—'}
          warn={mismatch}
        />
        <CountStat
          label={t('physical_count.computed_total_label')}
          value={computed != null ? String(computed) : '—'}
        />
        <CountStat
          label={t('physical_count.reconcile_delta_label')}
          value={reconcileDelta != null ? (reconcileDelta > 0 ? `+${reconcileDelta}` : String(reconcileDelta)) : '—'}
        />
      </div>
      {mismatch && (
        <Msg
          msg={{
            kind: 'err',
            text: t('physical_count.mismatch_error', {
              program: liveNum(program),
              nonProgram: liveNum(nonProgram),
              sum: splitSum,
              total: physicalTotal,
            }),
          }}
        />
      )}
      <div className="flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? t('physical_count.recording') : t('physical_count.record_button')}
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

function CountStat({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  const border = warn
    ? 'border-red-400/60'
    : accent
      ? 'border-dr3-chartreuse/50'
      : 'border-white/15';
  return (
    <div className={`rounded-lg border ${border} bg-black/10 p-3`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className={`mt-1 text-xl font-bold ${warn ? 'text-red-300' : ''}`}>{value}</div>
    </div>
  );
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
          <input
            type="date"
            className={inputCls}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Kind</span>
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof DROPOFF_KINDS)[number])}
          >
            {DROPOFF_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Dropped off by</span>
          <input
            className={inputCls}
            value={personName}
            onChange={(e) => setPersonName(e.target.value)}
          />
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
      <p className="text-xs opacity-70">
        Only incentive drop-offs are paid; unpaid and illegal carry no incentive.
      </p>
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
        setMsg({
          kind: 'err',
          text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).`,
        });
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
          <input
            type="date"
            className={inputCls}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
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
            {SUB_CATEGORIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Weight (lbs)</span>
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
        <label className={labelCls}>
          <span className="opacity-70">Bale count</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={bales}
            onChange={(e) => setBales(e.target.value)}
          />
        </label>
      </div>
      {isRenovation && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className={labelCls}>
            <span className="opacity-70">Whole units</span>
            <input
              type="number"
              min="1"
              className={inputCls}
              value={whole}
              onChange={(e) => setWhole(e.target.value)}
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
        </div>
      )}
      <div className="flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? 'Saving…' : 'Add outbound'}
        </button>
        <Msg msg={msg} />
      </div>
      <p className="text-xs opacity-70">
        Renovation = whole-unit sale (program + non-program must equal whole units; counts toward
        the running balance). Baled / shredded = weight-based commodity sales (never subtract
        units).
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
        setMsg({
          kind: 'err',
          text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).`,
        });
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
          <input
            type="date"
            className={inputCls}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
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
          <span className="opacity-70">Reason</span>
          <select
            className={inputCls}
            value={reason}
            onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
          >
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
      <p className="text-xs opacity-70">
        Program + non-program must equal units (server-enforced).
      </p>
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

// Money helpers -----------------------------------------------------------
/** A dollar string ('312.50') → integer cents, or undefined when blank. */
function dollarsToCents(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}
function centsToDollars(c: number | null): string {
  return c == null ? '—' : `$${(c / 100).toFixed(2)}`;
}
function numOrUndef(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// Collection events -------------------------------------------------------
function EventsPanel({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<EventView[]>([]);
  const [date, setDate] = useState(todayIso());
  const [customer, setCustomer] = useState('');
  const [county, setCounty] = useState('');
  const [slip, setSlip] = useState('');
  const [units, setUnits] = useState('');
  const [freight, setFreight] = useState('');
  const [driverHours, setDriverHours] = useState('');
  const [driverWages, setDriverWages] = useState('');
  const [laborHours, setLaborHours] = useState('');
  const [laborWages, setLaborWages] = useState('');
  const [mileage, setMileage] = useState('');
  const [mileageDollars, setMileageDollars] = useState('');
  const [perDiem, setPerDiem] = useState('');
  const [misc, setMisc] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  const load = useCallback(async () => {
    setRows(await getRows<EventView>(`/api/manager/${siteCode}/events`));
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventDate: date,
          customer,
          county: county || undefined,
          slipNumber: slip || undefined,
          units: numOrUndef(units),
          freightCents: dollarsToCents(freight),
          driverHours: numOrUndef(driverHours),
          driverWagesCents: dollarsToCents(driverWages),
          laborHours: numOrUndef(laborHours),
          laborWagesCents: dollarsToCents(laborWages),
          mileage: numOrUndef(mileage),
          mileageCents: dollarsToCents(mileageDollars),
          perDiemCents: dollarsToCents(perDiem),
          miscCents: dollarsToCents(misc),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({
          kind: 'err',
          text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).`,
        });
        return;
      }
      setMsg({ kind: 'ok', text: 'Event recorded.' });
      setCustomer('');
      setCounty('');
      setSlip('');
      setUnits('');
      setFreight('');
      setDriverHours('');
      setDriverWages('');
      setLaborHours('');
      setLaborWages('');
      setMileage('');
      setMileageDollars('');
      setPerDiem('');
      setMisc('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canSave = customer.trim() !== '';
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={labelCls}>
          <span className="opacity-70">Date</span>
          <input
            type="date"
            className={inputCls}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Customer</span>
          <input
            className={inputCls}
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">County</span>
          <input className={inputCls} value={county} onChange={(e) => setCounty(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Slip #</span>
          <input className={inputCls} value={slip} onChange={(e) => setSlip(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Units</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={units}
            onChange={(e) => setUnits(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Freight ($)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={freight}
            onChange={(e) => setFreight(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Driver hrs</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={driverHours}
            onChange={(e) => setDriverHours(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Driver wages ($)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={driverWages}
            onChange={(e) => setDriverWages(e.target.value)}
            placeholder="auto from rate"
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Labor hrs</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={laborHours}
            onChange={(e) => setLaborHours(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Labor wages ($)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={laborWages}
            onChange={(e) => setLaborWages(e.target.value)}
            placeholder="auto from rate"
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Mileage (mi)</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={mileage}
            onChange={(e) => setMileage(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Mileage billed ($)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={mileageDollars}
            onChange={(e) => setMileageDollars(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Per diem ($)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={perDiem}
            onChange={(e) => setPerDiem(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Misc ($)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={misc}
            onChange={(e) => setMisc(e.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? 'Saving…' : 'Add event'}
        </button>
        <Msg msg={msg} />
      </div>
      <p className="text-xs opacity-70">
        Wages left blank auto-fill from the site&apos;s driver / general-labor hourly rates (hours ×
        rate); a typed wage is stored as entered. Mileage (mi) is informational; the billed mileage
        dollars is what feeds the invoice event total.
      </p>
      <RecordTable
        head={[
          'Date',
          'Customer',
          'Units',
          'Freight',
          'Driver wages',
          'Labor wages',
          'Mileage $',
          'Per diem',
          'Misc',
        ]}
        rows={rows.map((r) => [
          isoDate(r.eventDate),
          r.customer,
          r.units == null ? '—' : String(r.units),
          centsToDollars(r.freightCents),
          centsToDollars(r.driverWagesCents),
          centsToDollars(r.laborWagesCents),
          centsToDollars(r.mileageCents),
          centsToDollars(r.perDiemCents),
          centsToDollars(r.miscCents),
        ])}
      />
    </div>
  );
}

// OR collection-site counts -----------------------------------------------
function OrCountsPanel({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<OrCountView[]>([]);
  const [month, setMonth] = useState(todayIso().slice(0, 7) + '-01');
  const [location, setLocation] = useState('');
  const [units, setUnits] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  const load = useCallback(async () => {
    setRows(await getRows<OrCountView>(`/api/manager/${siteCode}/or-counts`));
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/or-counts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ billingMonth: month, location, units: Number(units) }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({
          kind: 'err',
          text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).`,
        });
        return;
      }
      setMsg({ kind: 'ok', text: 'Count recorded.' });
      setLocation('');
      setUnits('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canSave = location.trim() !== '' && Number(units) >= 0 && units !== '';
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className={labelCls}>
          <span className="opacity-70">Billing month</span>
          <input
            type="date"
            className={inputCls}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Location</span>
          <input
            className={inputCls}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Units</span>
          <input
            type="number"
            min="0"
            className={inputCls}
            value={units}
            onChange={(e) => setUnits(e.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? 'Saving…' : 'Add count'}
        </button>
        <Msg msg={msg} />
      </div>
      <p className="text-xs opacity-70">
        Oregon (Eugene) only — the $2.25/unit rate lives in the program rules; billing is computed
        by the invoice layer, not here. A non-Oregon site is refused.
      </p>
      <RecordTable
        head={['Month', 'Location', 'Units']}
        rows={rows.map((r) => [isoDate(r.billingMonth).slice(0, 7), r.location, String(r.units)])}
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
