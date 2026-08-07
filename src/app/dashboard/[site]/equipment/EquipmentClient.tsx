'use client';

// ADR-0044 D3 — the equipment trend view + event entry (manager/office surface).
//
// CLAUDE.md hard rule #10 — no <form>; every handler is onClick/onChange.
// English-first (office desktop). Green/black palette (ADR-0014). The throughput
// series is derived server-side and passed in; the event log is fetched here so
// entry + soft-void refresh without a full reload.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { appTodayISO } from '@/lib/time';
import { isRealMachineSource } from '@/lib/equipment/throughput';
import type { EquipmentThroughput, DailyThroughputPoint } from '@/lib/equipment/throughput';
import type { EquipmentEventView } from '@/lib/equipment/service';
import type { DailyThroughputView } from '@/lib/equipment/daily-throughput';
import type { TerexLedger } from '@/lib/equipment/terex-ledger';
import { TerexMetricsBand } from './TerexMetricsBand';
import { Tile } from './Tile';

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
  ledger = null,
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
  /**
   * ADR-0081 — the machine's cost/repair/downtime metrics, computed server-side
   * by `computeTerexLedger` and passed through untouched. `null` (or a ledger
   * with `equipment: null`) ⇒ no band, never a band of zeros.
   */
  ledger?: TerexLedger | null;
}) {
  return (
    <div className="mt-8 flex flex-col gap-10">
      {/* ADR-0081 — the band SUPERSEDES the bare ledger link: it carries the same
          link plus the figures the link used to be a promise of. The link row is
          kept as the fallback for the case the band refuses to render (no Terex
          at this site), where a machine list may still be non-empty. */}
      {ledger?.equipment ? (
        <TerexMetricsBand ledger={ledger} siteCode={siteCode} />
      ) : machines.length > 0 ? (
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
      ) : null}
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
  // ADR-0079 Am.1 §4 — disclose how much of the window is actually behind the
  // mean. "231.4 units/day" over one recorded day out of seven is not a weekly
  // pace, and the tile should not let it look like one.
  const recorded = s.recordedDays;
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {/* ADR-0081 D5 — the mean is now BLENDED over the two real sources, so the
          composition label rides with it. `meanWindowLabel` built that string in
          the data layer precisely so a blended figure can never reach a screen
          without saying what it is blended from. */}
      <Tile
        label="7-day units/day"
        value={fmt(s.last7UnitsPerDay)}
        sub={`${Math.min(recorded, 7)} of 7 days recorded`}
        note={s.last7Label}
        accent
      />
      <Tile
        label="30-day units/day"
        value={fmt(s.last30UnitsPerDay)}
        sub={`${Math.min(recorded, 30)} of 30 days recorded`}
        note={s.last30Label}
      />
      {/* ADR-0077 D4 — "not recorded", never "0.0". `hours_down` has never been
          written on any Terex event, and a machine nobody measured is not a
          machine that never stopped. */}
      <Tile
        label="Downtime hrs (window)"
        value={s.totalDowntimeHours == null ? 'not recorded' : s.totalDowntimeHours.toFixed(1)}
      />
      {/* ADR-0077 Amendment 2 — an UNPRICED window says "not recorded"; only a
          genuinely recorded zero shows $0.00. `centsToDollars` renders null as
          "—", which is right for a single event's missing cost but wrong for a
          SUMMARY: a dash in a money tile reads as "nothing spent". */}
      <Tile
        label="Cost (window)"
        value={s.totalCostCents == null ? 'not recorded' : centsToDollars(s.totalCostCents)}
      />
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
  const machineName = throughput.machine?.displayName ?? 'this machine';

  // ADR-0079 Am.1, extended by ADR-0081 — the value this day actually DRAWS,
  // chosen off `source` and nothing else.
  //
  // `entered` and `workbook` BOTH draw `unitsDay`, because both ARE `unitsDay`:
  // the machine's own units against the machine's own hours, one typed into
  // Vision and one read off the sheet Vision replaces (`isRealMachineSource`).
  // Only `legacy_derived` draws the floor-wide proxy. A post-cutover gap draws
  // nothing even though `derivedFloorUnits` may well exist for it; substituting
  // that would be the very fallback the original cutover refused.
  const displayUnits = (d: DailyThroughputPoint): number | null =>
    isRealMachineSource(d.source)
      ? d.unitsDay
      : d.source === 'legacy_derived'
        ? d.derivedFloorUnits
        : null;

  // The reported bug, literally: the axis was scaled off `unitsDay` alone, so with
  // zero entered days `maxUnits` collapsed to 1 and every legacy bar would have
  // been drawn off the top of the chart. It scales to what is DRAWN — which is
  // why ADR-0081 needed no change here: `displayUnits` now returns a workbook
  // day's figure, so the axis already includes it. (Verified, not assumed: a
  // workbook-only window scales to the workbook maximum.)
  const maxUnits = Math.max(1, ...daily.map((d) => displayUnits(d) ?? 0));
  const maxPocket = Math.max(1, ...daily.map((d) => d.pocketcoilEstimate ?? 0));
  const hasLegacy = daily.some((d) => d.source === 'legacy_derived');
  const hasWorkbook = daily.some((d) => d.source === 'workbook');

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
          {/* ADR-0079 Am.1 — the legacy hatch. Defined once; a legacy bar fills
              with this instead of solid colour, so "hollow and striped" is the
              shape of a floor-wide figure everywhere it appears.

              ADR-0081 adds `workbookHatch` alongside it in the SAME 45° idiom,
              deliberately not a new visual language. The two are separated by
              WEIGHT, not by angle or hue: `legacyHatch` is hollow (no base fill),
              thin, and sub-opacity because it is the WRONG QUANTITY; while
              `workbookHatch` lays full-strength stripes over a filled base
              because it is a REAL machine figure and belongs to the solid family.
              A reader who learns "the fainter, emptier one is not this machine"
              has learned the whole rule. */}
          <defs>
            <pattern
              id="legacyHatch"
              patternUnits="userSpaceOnUse"
              width={4}
              height={4}
              patternTransform="rotate(45)"
            >
              <line x1={0} y1={0} x2={0} y2={4} stroke="#8fbf3f" strokeWidth={1.2} opacity={0.7} />
            </pattern>
            <pattern
              id="workbookHatch"
              patternUnits="userSpaceOnUse"
              width={3}
              height={3}
              patternTransform="rotate(45)"
            >
              {/* The filled base is what makes this read as solid-family rather
                  than hollow. Darker green so the stripes stay legible on it. */}
              <rect x={0} y={0} width={3} height={3} fill="#4e6d21" />
              <line x1={0} y1={0} x2={0} y2={3} stroke="#8fbf3f" strokeWidth={1.6} />
            </pattern>
          </defs>
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
          {/* ADR-0079 Am.1, extended by ADR-0081 — units/day bars, drawn
              STRUCTURALLY by source. The distinction is deliberately structural
              rather than tonal (a lighter green, a lower opacity), because tone
              does not survive a projector, a screenshot, a colour-blind reader,
              or a print-out — and the one thing this must never do is let the
              floor's number pass as the machine's.

              THE INVARIANT, in three lines, and it must survive every future edit:
                SOLID              ⇒ ENTERED. Always. Nothing else is ever solid.
                STRIPED-AND-STRONG ⇒ the machine's OWN sheet history (workbook).
                HOLLOW-AND-DASHED  ⇒ the floor-wide legacy proxy.

              The first two are the same physical quantity and so share the solid
              family; the third is a different quantity wearing the machine's name
              and is the reason any of this exists.
              `render.legacy-can-never-appear-as-entered` and
              `display.source-visual-guard` each delete this branch and prove the
              red. */}
          {daily.map((d, i) => {
            const v = displayUnits(d);
            if (v == null) return null;
            const isLegacy = d.source === 'legacy_derived';
            const isWorkbook = d.source === 'workbook';
            return (
              <rect
                key={`u${i}`}
                data-testid={`bar-${d.dateISO}`}
                data-source={d.source}
                x={i * colW + (colW - barW) / 2}
                y={yUnits(v)}
                width={barW}
                height={PAD_T + plotH - yUnits(v)}
                fill={
                  isLegacy ? 'url(#legacyHatch)' : isWorkbook ? 'url(#workbookHatch)' : '#8fbf3f'
                }
                stroke={isLegacy || isWorkbook ? '#8fbf3f' : 'none'}
                strokeWidth={isLegacy || isWorkbook ? 1 : 0}
                // Dashes are the legacy tell ALONE. A workbook bar's outline is
                // solid because its number is real.
                strokeDasharray={isLegacy ? '2 1.5' : undefined}
                opacity={isLegacy ? 0.75 : 0.85}
              >
                <title>
                  {isLegacy
                    ? `${d.dateISO}: ${v} units — floor-wide total, not ${machineName}-specific (legacy)`
                    : isWorkbook
                      ? `${d.dateISO}: ${v} units — from the Terex workbook (imported sheet history)`
                      : `${d.dateISO}: ${v} units${d.hoursDown ? ` · ${d.hoursDown}h down` : ''}`}
                </title>
              </rect>
            );
          })}
          {/* 7-day rolling mean. ADR-0081 D5 widened this to the COMBINED REAL
              series (entered + workbook), so the one solid line already covers
              both and no second line is needed — they are the same measurement.
              The disclosure of what the window is made of rides the summary tile
              (`mean7Label`), not a second polyline. `legacy_derived` is still
              never blended in; that is the dashed line below. */}
          {meanPts((d) => d.mean7) && (
            <polyline
              points={meanPts((d) => d.mean7)}
              fill="none"
              stroke="#d7ff4f"
              strokeWidth={1.75}
            />
          )}
          {/* ADR-0079 Am.1 — the LEGACY 7-day mean, over legacy days only. A
              separate dashed line so the eye never reads one continuous average
              spanning two eras that measure different things. */}
          {meanPts((d) => d.legacyMean7) && (
            <polyline
              data-testid="legacy-mean7"
              points={meanPts((d) => d.legacyMean7)}
              fill="none"
              stroke="#d7ff4f"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              opacity={0.6}
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
      {/* ADR-0081 — ALWAYS VISIBLE whenever a workbook bar is on screen. Same
          rule as the legacy legend below and for the same reason: a reader who
          never touches the chart must still be told what a striped bar is. The
          two legends read together — this one claims the machine, that one
          disclaims it — which is why neither may be a tooltip. */}
      {hasWorkbook && (
        <p
          data-testid="workbook-legend"
          className="mt-2 flex items-start gap-2 rounded border border-white/15 bg-black/20 px-3 py-2 text-xs opacity-80"
        >
          <svg width="18" height="10" aria-hidden="true" className="mt-0.5 shrink-0">
            <rect
              x="0"
              y="0"
              width="18"
              height="10"
              fill="url(#workbookHatch)"
              stroke="#8fbf3f"
              strokeWidth="1"
            />
          </svg>
          <span>
            Solid-striped bars are <strong>this machine&apos;s own daily numbers</strong>, read off
            the TEREX workbook — the sheet history that was kept before Vision. Same measurement as
            a day entered here, so the 7- and 30-day averages include them.
          </span>
        </p>
      )}
      {/* ADR-0079 Am.1 — ALWAYS VISIBLE whenever a legacy bar is on screen. Not a
          tooltip, not a hover: a reader who never touches the chart must still be
          told that these bars are the whole floor. */}
      {hasLegacy && (
        <p
          data-testid="legacy-legend"
          className="mt-2 flex items-start gap-2 rounded border border-white/15 bg-black/20 px-3 py-2 text-xs opacity-80"
        >
          <svg width="18" height="10" aria-hidden="true" className="mt-0.5 shrink-0">
            <rect
              x="0"
              y="0"
              width="18"
              height="10"
              fill="url(#legacyHatch)"
              stroke="#8fbf3f"
              strokeWidth="1"
              strokeDasharray="2 1.5"
            />
          </svg>
          {/* ADR-0081 — this read "Striped bars are…". It cannot any more: the
              workbook bars above are also striped, and the one word that used to
              mean "not this machine" now describes two opposite things. The tell
              is HOLLOW AND DASHED, and the sentence has to say the tell. */}
          <span>
            Hollow, dashed-outline bars are the <strong>floor-wide processed total</strong> — before
            daily capture began {throughput.captureCutoverISO}. Not machine-specific.
          </span>
        </p>
      )}
      <Legend hasWorkbook={hasWorkbook} />
    </section>
  );
}

function Legend({ hasWorkbook }: { hasWorkbook: boolean }) {
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
          nobody recorded — not a zero.
          ADR-0081 — and the source clause is now conditional, because on a site
          with no imported history "entered here or read off the workbook" would
          describe a workbook that is not on the screen. */}
      <span className="opacity-60">
        Units/day and units/run-hour are this machine&apos;s own daily figures
        {hasWorkbook
          ? ' — entered here, or read off the TEREX workbook for days before Vision'
          : ''}
        . A missing bar is a day that was not recorded — not a zero.
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
    // ADR-0079 Am.1 — provenance travels with the export too. A spreadsheet that
    // drops the striping keeps the word.
    'source',
    'units_day_entered',
    'run_hours_entered',
    'hours_down',
    'units_per_run_hour',
    'mean_7d',
    'mean_30d',
    'legacy_mean_7d',
    'legacy_mean_30d',
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
      d.source,
      cell(d.unitsDay),
      cell(d.runHours),
      cell(d.hoursDown),
      cell(d.unitsPerRunHour),
      cell(d.mean7),
      cell(d.mean30),
      cell(d.legacyMean7),
      cell(d.legacyMean30),
      cell(d.pocketcoilEstimate),
      cell(d.derivedFloorUnits),
    ].join(','),
  );
  const csv = [head.join(','), ...lines].join('\r\n');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}
