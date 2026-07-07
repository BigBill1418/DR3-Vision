'use client';

// ADR-0044 D3 — the equipment trend view + event entry (manager/office surface).
//
// CLAUDE.md hard rule #10 — no <form>; every handler is onClick/onChange.
// English-first (office desktop). Green/black palette (ADR-0014). The throughput
// series is derived server-side and passed in; the event log is fetched here so
// entry + soft-void refresh without a full reload.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EquipmentThroughput, DailyThroughputPoint } from '@/lib/equipment/throughput';
import type { EquipmentEventView } from '@/lib/equipment/service';

const KINDS = ['downtime', 'maintenance', 'repair', 'cost', 'note'] as const;
type Kind = (typeof KINDS)[number];
const DOWNTIME_KINDS: ReadonlySet<Kind> = new Set(['downtime', 'maintenance', 'repair']);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDate(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}
function centsToDollars(c: number | null): string {
  return c == null ? '—' : `$${(c / 100).toFixed(2)}`;
}

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls = 'rounded bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

interface FieldMsg {
  kind: 'ok' | 'err';
  text: string;
}

export function EquipmentClient({
  siteCode,
  throughput,
  showTrend = true,
  showEntry = true,
}: {
  siteCode: string;
  throughput: EquipmentThroughput;
  // ADR-0047 UI gate — the trend view and event entry ramp independently per site.
  showTrend?: boolean;
  showEntry?: boolean;
}) {
  return (
    <div className="mt-8 flex flex-col gap-10">
      {showTrend && (
        <>
          <SummaryTiles throughput={throughput} />
          <TrendPanel throughput={throughput} siteCode={siteCode} />
          <CostPanel throughput={throughput} />
        </>
      )}
      {showEntry && <EventEntry siteCode={siteCode} />}
    </div>
  );
}

// ── Summary tiles ────────────────────────────────────────────────────────
function SummaryTiles({ throughput }: { throughput: EquipmentThroughput }) {
  const s = throughput.summary;
  const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(1));
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Tile label="7-day units/day" value={fmt(s.last7UnitsPerDay)} accent />
      <Tile label="30-day units/day" value={fmt(s.last30UnitsPerDay)} />
      <Tile label="Downtime hrs (window)" value={fmt(s.totalDowntimeHours)} />
      <Tile label="Cost (window)" value={centsToDollars(s.totalCostCents)} />
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${accent ? 'border-dr3-chartreuse/50 bg-black/20' : 'border-white/15 bg-black/10'}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

// ── Trend chart (units/day bars + rolling mean + downtime bands + pocketcoil) ──
function TrendPanel({ throughput, siteCode }: { throughput: EquipmentThroughput; siteCode: string }) {
  const daily = throughput.daily;
  const maxUnits = Math.max(1, ...daily.map((d) => d.unitsDay ?? 0));
  const maxPocket = Math.max(1, ...daily.map((d) => d.pocketcoilEstimate ?? 0));

  const W = Math.max(640, daily.length * 9);
  const H = 200;
  const PAD_B = 22;
  const PAD_T = 8;
  const plotH = H - PAD_B - PAD_T;
  const colW = daily.length > 0 ? W / daily.length : W;
  const barW = Math.max(2, colW * 0.6);

  const yUnits = (v: number) => PAD_T + plotH - (v / maxUnits) * plotH;
  const yPocket = (v: number) => PAD_T + plotH - (v / maxPocket) * plotH;

  const meanPts = (sel: (d: DailyThroughputPoint) => number | null) =>
    daily
      .map((d, i) => {
        const v = sel(d);
        return v == null ? null : `${(i + 0.5) * colW},${yUnits(v)}`;
      })
      .filter((p): p is string => p !== null)
      .join(' ');

  const pocketPts = daily
    .map((d, i) => (d.pocketcoilEstimate == null ? null : `${(i + 0.5) * colW},${yPocket(d.pocketcoilEstimate)}`))
    .filter((p): p is string => p !== null)
    .join(' ');

  const csvHref = useMemo(() => buildCsv(daily), [daily]);
  const csvName = `dr3-equipment-${siteCode}-${throughput.windowStartISO}_${throughput.windowEndISO}.csv`;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          Throughput trend{' '}
          <span className="text-sm font-normal opacity-60">
            {throughput.windowStartISO} → {throughput.windowEndISO}
          </span>
        </h2>
        <a href={csvHref} download={csvName} className="rounded border border-white/25 px-3 py-1.5 text-sm hover:border-dr3-chartreuse/60">
          Export CSV
        </a>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-white/15 bg-black/20 p-3">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Daily units per day with rolling mean and downtime overlay">
          {/* downtime red bands (kind=downtime days) */}
          {daily.map((d, i) =>
            d.hoursDown != null && d.hoursDown > 0 ? (
              <rect key={`b${i}`} x={i * colW} y={PAD_T} width={colW} height={plotH} fill="#ef4444" opacity={0.18} />
            ) : null,
          )}
          {/* units/day bars */}
          {daily.map((d, i) =>
            d.unitsDay != null ? (
              <rect
                key={`u${i}`}
                x={i * colW + (colW - barW) / 2}
                y={yUnits(d.unitsDay)}
                width={barW}
                height={PAD_T + plotH - yUnits(d.unitsDay)}
                fill="#8fbf3f"
                opacity={0.85}
              >
                <title>{`${d.dateISO}: ${d.unitsDay} units${d.hoursDown ? ` · ${d.hoursDown}h down` : ''}`}</title>
              </rect>
            ) : null,
          )}
          {/* 7-day rolling mean */}
          {meanPts((d) => d.mean7) && (
            <polyline points={meanPts((d) => d.mean7)} fill="none" stroke="#d7ff4f" strokeWidth={1.75} />
          )}
          {/* pocketcoil overlay (own scale — shape correlation, Juan Q4) */}
          {pocketPts && <polyline points={pocketPts} fill="none" stroke="#fbbf24" strokeWidth={1.25} strokeDasharray="3 2" opacity={0.9} />}
          {/* baseline */}
          <line x1={0} y1={PAD_T + plotH} x2={W} y2={PAD_T + plotH} stroke="#ffffff" strokeOpacity={0.2} />
        </svg>
      </div>
      <Legend />
    </section>
  );
}

function Legend() {
  const chip = (color: string, dash: boolean, label: string) => (
    <span className="flex items-center gap-1.5">
      <svg width="18" height="8" aria-hidden="true">
        {dash ? (
          <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth="2" strokeDasharray="3 2" />
        ) : (
          <rect x="0" y="0" width="18" height="8" fill={color} rx="1" />
        )}
      </svg>
      {label}
    </span>
  );
  return (
    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs opacity-75">
      {chip('#8fbf3f', false, 'Units/day')}
      {chip('#d7ff4f', false, '7-day mean')}
      {chip('#ef4444', false, 'Downtime day')}
      {chip('#fbbf24', true, 'Pocket-coil estimate (own scale)')}
      <span className="opacity-60">
        Units/run-hour uses an assumed {8}h working day (assumed_day_hours), reduced by that day&apos;s downtime.
      </span>
    </div>
  );
}

// ── Monthly cost series ────────────────────────────────────────────────────
function CostPanel({ throughput }: { throughput: EquipmentThroughput }) {
  const series = throughput.monthlyCost;
  const max = Math.max(1, ...series.map((m) => m.costCents));
  return (
    <section>
      <h2 className="text-lg font-semibold">Monthly cost</h2>
      {series.length === 0 ? (
        <p className="mt-2 text-sm opacity-70">No cost recorded in this window.</p>
      ) : (
        <div className="mt-3 flex items-end gap-4">
          {series.map((m) => (
            <div key={m.monthISO} className="flex flex-col items-center gap-1">
              <div className="text-xs opacity-70">{centsToDollars(m.costCents)}</div>
              <div
                className="w-10 rounded-t bg-dr3-chartreuse/80"
                style={{ height: `${Math.round((m.costCents / max) * 96) + 4}px` }}
                title={`${m.monthISO}: ${centsToDollars(m.costCents)}`}
              />
              <div className="text-xs opacity-70">{m.monthISO}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Event entry + list ─────────────────────────────────────────────────────
function EventEntry({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<EquipmentEventView[]>([]);
  const [date, setDate] = useState(todayIso());
  const [kind, setKind] = useState<Kind>('downtime');
  const [hours, setHours] = useState('');
  const [cost, setCost] = useState('');
  const [vendor, setVendor] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  const showHours = DOWNTIME_KINDS.has(kind);

  const load = useCallback(async () => {
    const res = await fetch(`/api/manager/${siteCode}/equipment`);
    if (!res.ok) return;
    const data = (await res.json()) as { rows: EquipmentEventView[] };
    setRows(data.rows);
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/equipment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventDate: date,
          kind,
          hoursDown: showHours && hours !== '' ? Number(hours) : null,
          costCents: cost !== '' ? Math.round(Number(cost) * 100) : null,
          vendor: vendor || null,
          notes: notes || null,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({ kind: 'err', text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).` });
        return;
      }
      setMsg({ kind: 'ok', text: 'Event recorded.' });
      setHours('');
      setCost('');
      setVendor('');
      setNotes('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const voidEvent = async (id: string) => {
    const res = await fetch(`/api/manager/${siteCode}/equipment/${id}`, { method: 'DELETE' });
    if (res.ok) await load();
  };

  const canSave = date !== '' && (kind !== 'note' || notes.trim() !== '');

  return (
    <section>
      <h2 className="text-lg font-semibold">Log an equipment event</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={labelCls}>
          <span className="opacity-70">Date</span>
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Kind</span>
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Hours down</span>
          <input
            type="number"
            min="0"
            step="0.25"
            className={inputCls}
            value={hours}
            disabled={!showHours}
            placeholder={showHours ? '' : 'n/a'}
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Cost ($)</span>
          <input type="number" min="0" step="0.01" className={inputCls} value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Vendor</span>
          <input className={inputCls} value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Notes</span>
          <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-4">
        <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
          {busy ? 'Saving…' : 'Add event'}
        </button>
        <Msg msg={msg} />
      </div>
      <p className="mt-2 text-xs opacity-70">
        Hours-down applies to downtime, maintenance, and repair; only kind=downtime draws a red band on
        the trend. Any kind may carry a cost. Removing an event soft-voids it (retained for the audit trail).
      </p>

      <table className="mt-5 w-full text-left text-sm">
        <thead className="opacity-70">
          <tr>
            {['Date', 'Kind', 'Hrs down', 'Cost', 'Vendor', 'Notes', ''].map((h) => (
              <th key={h} className="py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="py-4 opacity-70">
                No events yet.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-white/10">
              <td className="py-2">{isoDate(r.eventDate)}</td>
              <td className="py-2">{r.kind}</td>
              <td className="py-2">{r.hoursDown ?? '—'}</td>
              <td className="py-2">{centsToDollars(r.costCents)}</td>
              <td className="py-2">{r.vendor ?? '—'}</td>
              <td className="py-2">{r.notes ?? '—'}</td>
              <td className="py-2">
                <button
                  type="button"
                  onClick={() => void voidEvent(r.id)}
                  className="text-xs text-white/60 underline-offset-2 hover:text-red-300 hover:underline"
                >
                  Void
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Msg({ msg }: { msg: FieldMsg | null }) {
  if (!msg) return null;
  return <span className={msg.kind === 'ok' ? 'text-sm text-dr3-chartreuse' : 'text-sm text-red-300'}>{msg.text}</span>;
}

// ── CSV (client-side, from the derived daily series) ───────────────────────
function buildCsv(daily: readonly DailyThroughputPoint[]): string {
  const head = ['date', 'units_day', 'hours_down', 'units_per_run_hour', 'mean_7d', 'mean_30d', 'pocketcoil_estimate'];
  const cell = (v: number | null) => (v == null ? '' : String(Math.round(v * 100) / 100));
  const lines = daily.map((d) =>
    [d.dateISO, cell(d.unitsDay), cell(d.hoursDown), cell(d.unitsPerRunHour), cell(d.mean7), cell(d.mean30), cell(d.pocketcoilEstimate)].join(','),
  );
  const csv = [head.join(','), ...lines].join('\r\n');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}
