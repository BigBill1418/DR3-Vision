'use client';

// ADR-0044 D3 — the equipment trend view + event entry (manager/office surface).
//
// CLAUDE.md hard rule #10 — no <form>; every handler is onClick/onChange.
// English-first (office desktop). Green/black palette (ADR-0014). The throughput
// series is derived server-side and passed in; the event log is fetched here so
// entry + soft-void refresh without a full reload.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { appTodayISO } from '@/lib/time';
import type { EquipmentThroughput, DailyThroughputPoint } from '@/lib/equipment/throughput';
import type { EquipmentEventView } from '@/lib/equipment/service';
import type { DailyThroughputView } from '@/lib/equipment/daily-throughput';

const KINDS = ['downtime', 'maintenance', 'repair', 'cost', 'note'] as const;
type Kind = (typeof KINDS)[number];
const DOWNTIME_KINDS: ReadonlySet<Kind> = new Set(['downtime', 'maintenance', 'repair']);

// ADR-0065 Amendment 2 — the Pacific day, not the UTC day.
//
// This read `new Date().toISOString().slice(0, 10)`. `toISOString()` converts to
// UTC first, so from 5:00 PM Pacific (00:00Z the next day) it returned TOMORROW —
// and every date input on this screen defaulted to a day that had not happened.
// An evening entry silently landed on the wrong production day.
//
// `appTodayISO` already existed for exactly this ("for client default values");
// six client screens each rolled their own instead. Use the shared one.
function todayIso(): string {
  return appTodayISO();
}
function isoDate(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}
function centsToDollars(c: number | null): string {
  return c == null ? '—' : `$${(c / 100).toFixed(2)}`;
}

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls = 'rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

interface FieldMsg {
  kind: 'ok' | 'err';
  text: string;
}

export function EquipmentClient({
  siteCode,
  throughput,
  showTrend = true,
  showEntry = true,
  machines = [],
  machineLabel = 'Equipment',
}: {
  siteCode: string;
  throughput: EquipmentThroughput;
  // ADR-0047 UI gate — the trend view and event entry ramp independently per site.
  showTrend?: boolean;
  showEntry?: boolean;
  /** ADR-0077 D6 — machines with a ledger the CALLER can open. Empty ⇒ no link. */
  machines?: { id: string; displayName: string }[];
  /** ADR-0077 Am.1 — the machine's name where it exists, else "Equipment". */
  machineLabel?: string;
}) {
  return (
    <div className="mt-8 flex flex-col gap-10">
      {machines.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="opacity-70">Machine ledger:</span>
          {machines.map((m) => (
            <a
              key={m.id}
              href={`/dashboard/${siteCode}/equipment/${m.id}`}
              className="underline opacity-90 hover:opacity-100"
            >
              {m.displayName} ledger — maintenance, AP spend &amp; downtime →
            </a>
          ))}
        </div>
      )}
      {showTrend && (
        <>
          <SummaryTiles throughput={throughput} />
          <TrendPanel throughput={throughput} siteCode={siteCode} />
          <CostPanel throughput={throughput} />
        </>
      )}
      {/* ADR-0079 D6 — the daily capture rides the EXISTING `equipment_entry`
          surface rather than being born behind a new gate. ADR-0047's born-pilot
          rule protects an audience from output it has not seen before; this
          audience is the identical one already entering equipment events on this
          exact screen, at a site where `equipment_entry` is already live. A new
          gate would have hidden the replacement for the sheet from the very
          managers being asked to stop using the sheet. */}
      {showEntry && (
        <DailyThroughputEntry
          siteCode={siteCode}
          machineLabel={machineLabel}
          machine={throughput.machine}
        />
      )}
      {showEntry && <EventEntry siteCode={siteCode} machineLabel={machineLabel} />}
    </div>
  );
}

// ── Summary tiles ────────────────────────────────────────────────────────
function SummaryTiles({ throughput }: { throughput: EquipmentThroughput }) {
  const s = throughput.summary;
  // ADR-0079 D3 — "not recorded", never "0.0" and never the floor-wide derived
  // total. These two tiles are means of the MANAGER-ENTERED machine numbers; a
  // window nobody entered has no throughput to report, and saying so plainly is
  // the point. Same discipline as the downtime tile below (ADR-0077 D4).
  const fmt = (n: number | null) => (n == null ? 'not recorded' : n.toFixed(1));
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Tile label="7-day units/day" value={fmt(s.last7UnitsPerDay)} accent />
      <Tile label="30-day units/day" value={fmt(s.last30UnitsPerDay)} />
      {/* ADR-0077 D4 — "not recorded", never "0.0". `hours_down` has never been
          written on any Terex event, and a machine nobody measured is not a
          machine that never stopped. */}
      <Tile
        label="Downtime hrs (window)"
        value={s.totalDowntimeHours == null ? 'not recorded' : s.totalDowntimeHours.toFixed(1)}
      />
      <Tile label="Cost (window)" value={centsToDollars(s.totalCostCents)} />
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-4 ${accent ? 'border-dr3-cyan/50 bg-black/20' : 'border-white/15 bg-black/10'}`}
    >
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

// ── Trend chart (units/day bars + rolling mean + downtime bands + pocketcoil) ──
function TrendPanel({
  throughput,
  siteCode,
}: {
  throughput: EquipmentThroughput;
  siteCode: string;
}) {
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
    .map((d, i) =>
      d.pocketcoilEstimate == null ? null : `${(i + 0.5) * colW},${yPocket(d.pocketcoilEstimate)}`,
    )
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
        <a
          href={csvHref}
          download={csvName}
          className="rounded border border-white/25 px-3 py-1.5 text-sm hover:border-dr3-cyan/60"
        >
          Export CSV
        </a>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-white/15 bg-black/20 p-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label="Daily units per day with rolling mean and downtime overlay"
        >
          {/* downtime red bands (kind=downtime days) */}
          {daily.map((d, i) =>
            d.hoursDown != null && d.hoursDown > 0 ? (
              <rect
                key={`b${i}`}
                x={i * colW}
                y={PAD_T}
                width={colW}
                height={plotH}
                fill="#ef4444"
                opacity={0.18}
              />
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
            <polyline
              points={meanPts((d) => d.mean7)}
              fill="none"
              stroke="#d7ff4f"
              strokeWidth={1.75}
            />
          )}
          {/* pocketcoil overlay (own scale — shape correlation, Juan Q4) */}
          {pocketPts && (
            <polyline
              points={pocketPts}
              fill="none"
              stroke="#fbbf24"
              strokeWidth={1.25}
              strokeDasharray="3 2"
              opacity={0.9}
            />
          )}
          {/* baseline */}
          <line
            x1={0}
            y1={PAD_T + plotH}
            x2={W}
            y2={PAD_T + plotH}
            stroke="#ffffff"
            strokeOpacity={0.2}
          />
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
      {chip('#8fbf3f', false, 'Units/day (entered)')}
      {chip('#d7ff4f', false, '7-day mean')}
      {chip('#ef4444', false, 'Downtime day')}
      {chip('#fbbf24', true, 'Pocket-coil estimate (own scale)')}
      {/* ADR-0079 D3 — this used to read "units/run-hour uses an assumed 8h
          working day". It no longer does: run hours are entered with the units,
          so the rate is measured rather than assumed. A gap in the bars is a day
          nobody recorded — not a zero. */}
      <span className="opacity-60">
        Units/day and units/run-hour are the manager-entered daily figures for this machine. A
        missing bar is a day that was not recorded — not a zero.
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
                className="w-10 rounded-t bg-dr3-cyan/80"
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

// ── Daily throughput capture (ADR-0079) ────────────────────────────────────
//
// The replacement for the sheet's Terex column: units processed + run hours,
// entered by the manager, once a day. `onClick` only (hard rule #10).
function DailyThroughputEntry({
  siteCode,
  machineLabel,
  machine,
}: {
  siteCode: string;
  machineLabel: string;
  machine: { id: string; displayName: string } | null;
}) {
  const [rows, setRows] = useState<DailyThroughputView[]>([]);
  const [date, setDate] = useState(todayIso());
  const [units, setUnits] = useState('');
  const [runHours, setRunHours] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FieldMsg | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/manager/${siteCode}/equipment/daily-throughput`);
    if (!res.ok) return;
    const data = (await res.json()) as { rows: DailyThroughputView[] };
    setRows(data.rows);
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/equipment/daily-throughput`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          throughputDate: date,
          unitsProcessed: Number(units),
          runHours: Number(runHours),
          notes: notes || null,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; today?: string };
        // ADR-0079 D4 — a prior-day change is REFUSED, and the message says so
        // honestly and names where to take it. It does not pretend to have
        // opened a request that does not exist, and it does not quietly accept
        // the edit. See OPEN-ITEMS F-2 for the generalization that would let
        // this route into a real approval flow.
        if (err.error === 'requires_amendment') {
          setMsg({
            kind: 'err',
            text:
              `Only today (${err.today ?? todayIso()}) can be entered or corrected here. ` +
              `Changing a past day needs the office — send them the date and the corrected ` +
              `numbers and they will amend it.`,
          });
          return;
        }
        setMsg({
          kind: 'err',
          text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).`,
        });
        return;
      }
      setMsg({ kind: 'ok', text: "Today's numbers recorded." });
      setUnits('');
      setRunHours('');
      setNotes('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const voidRow = async (id: string) => {
    const res = await fetch(`/api/manager/${siteCode}/equipment/daily-throughput/${id}`, {
      method: 'DELETE',
    });
    if (res.ok) await load();
  };

  // Both figures are required — the whole point of capturing is that the hours
  // arrive WITH the units, so a rate never has to be computed against a guess.
  const canSave =
    date !== '' && units.trim() !== '' && runHours.trim() !== '' && Number(runHours) > 0;

  if (!machine) {
    return (
      <section>
        <h2 className="text-lg font-semibold">Daily processing</h2>
        <p className="mt-2 text-sm opacity-70">
          This site has no machine registered for daily throughput capture, so there is nothing to
          record here.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold">
        {machineLabel === 'Equipment' ? 'Daily processing' : `${machineLabel} — daily processing`}
      </h2>
      <p className="mt-1 text-sm opacity-70">
        Enter what the machine processed today and how many hours it ran. This replaces the
        sheet&apos;s daily column — it is the number the throughput chart reads. Today can be edited
        freely; a past day has to go through the office.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <label className={labelCls}>
          <span className="opacity-70">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Units processed</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className={labelCls}>
          <span className="opacity-70">Run hours</span>
          <input
            type="number"
            min="0.25"
            max="24"
            step="0.25"
            inputMode="decimal"
            value={runHours}
            onChange={(e) => setRunHours(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className={`${labelCls} col-span-2`}>
          <span className="opacity-70">Notes (optional)</span>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" disabled={!canSave || busy} onClick={save} className={btnCls}>
          {busy ? 'Saving…' : 'Save daily numbers'}
        </button>
        <Msg msg={msg} />
      </div>

      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left opacity-70">
              <tr>
                <th className="py-1 pr-4">Date</th>
                <th className="py-1 pr-4">Units</th>
                <th className="py-1 pr-4">Run hrs</th>
                <th className="py-1 pr-4">Units/hr</th>
                <th className="py-1 pr-4">Notes</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hrs = Number(r.runHours);
                return (
                  <tr key={r.id} className="border-t border-white/10">
                    <td className="py-1 pr-4">{r.throughputDateISO}</td>
                    <td className="py-1 pr-4">{r.unitsProcessed}</td>
                    <td className="py-1 pr-4">{r.runHours}</td>
                    <td className="py-1 pr-4">
                      {hrs > 0 ? (r.unitsProcessed / hrs).toFixed(1) : '—'}
                    </td>
                    <td className="py-1 pr-4 opacity-80">{r.notes ?? ''}</td>
                    <td className="py-1">
                      {r.throughputDateISO === todayIso() && (
                        <button
                          type="button"
                          onClick={() => void voidRow(r.id)}
                          className="text-xs underline opacity-70 hover:opacity-100"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Event entry + list ─────────────────────────────────────────────────────
function EventEntry({ siteCode, machineLabel }: { siteCode: string; machineLabel: string }) {
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
        setMsg({
          kind: 'err',
          text: err.error ? `Save failed: ${err.error}` : `Save failed (${res.status}).`,
        });
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
      <h2 className="text-lg font-semibold">
        {machineLabel === 'Equipment' ? 'Log an equipment event' : `Log a ${machineLabel} event`}
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
            onChange={(e) => setKind(e.target.value as Kind)}
          >
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
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
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
        Hours-down applies to downtime, maintenance, and repair; only kind=downtime draws a red band
        on the trend. Any kind may carry a cost. Removing an event soft-voids it (retained for the
        audit trail).
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
  return (
    <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
      {msg.text}
    </span>
  );
}

// ── CSV (client-side, from the derived daily series) ───────────────────────
function buildCsv(daily: readonly DailyThroughputPoint[]): string {
  const head = [
    'date',
    'units_day_entered',
    'run_hours_entered',
    'hours_down',
    'units_per_run_hour',
    'mean_7d',
    'mean_30d',
    'pocketcoil_estimate',
    // ADR-0079 D5 — the retained floor-wide total, named for what it actually is.
    // It is EVERY machine and every hand-stripper that day, not this machine, and
    // the column name has to say so or the export re-tells the lie the tile used
    // to tell. Carried so a future reconciliation cross-check has its input.
    'derived_floor_units_all_sources',
  ];
  const cell = (v: number | null) => (v == null ? '' : String(Math.round(v * 100) / 100));
  const lines = daily.map((d) =>
    [
      d.dateISO,
      cell(d.unitsDay),
      cell(d.runHours),
      cell(d.hoursDown),
      cell(d.unitsPerRunHour),
      cell(d.mean7),
      cell(d.mean30),
      cell(d.pocketcoilEstimate),
      cell(d.derivedFloorUnits),
    ].join(','),
  );
  const csv = [head.join(','), ...lines].join('\r\n');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}
