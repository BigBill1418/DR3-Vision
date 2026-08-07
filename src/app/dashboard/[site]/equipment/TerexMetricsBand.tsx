'use client';

// ADR-0081 — the machine's OTHER real metrics, on the machine's own page.
//
// Bill: "populate this terex page with relevant data metrics for this equipment."
// The throughput chart above answers "how much did it make"; this band answers
// the three questions the chart cannot: what has it cost to keep running, what
// came back as credit, and how long has it been down.
//
// EVERY FIGURE COMES FROM `computeTerexLedger` (src/lib/equipment/terex-ledger.ts),
// resolved server-side in the page and handed down as a prop. Nothing here
// re-derives, re-sums or re-parses any of it. That is the whole point: the
// ledger's guards — confirmed-rows-only, ONE workbook revision only, the
// `isSiteTerexMachine` refusal of shear machines — are what stop this band from
// reporting $231,203.82 instead of $77,067.94, and they only protect ONE
// implementation. A second copy of the arithmetic here would be a second thing to
// get wrong, and it would be wrong SILENTLY because it would look right.
//
// Money is formatted with `formatUsdCents`, NOT the local `centsToDollars` in
// EquipmentClient. These are the SAME numbers the ledger detail page renders one
// click away, and the two surfaces have to agree byte-for-byte — `centsToDollars`
// emits `$77067.94` where the ledger emits `$77,067.94`, and a reader comparing
// the band to the page it links to would be reading a discrepancy that does not
// exist.
//
// THE HOUSE RULE, restated because this band is where it is easiest to break:
// "not recorded" is not 0 and is not $0.00. An unpriced repair is not a free
// repair, and a machine nobody timed is not a machine that never stopped.

import { formatUsdCents } from '@/lib/invoices/format';
import type { TerexLedger } from '@/lib/equipment/terex-ledger';
import { Tile } from './Tile';

/** The one money rule: absent is said out loud, never zeroed. */
function money(cents: number | null): string {
  return cents === null ? 'not recorded' : formatUsdCents(cents);
}

export function TerexMetricsBand({ ledger, siteCode }: { ledger: TerexLedger; siteCode: string }) {
  const { equipment, maintenance, ap, downtime } = ledger;

  // No machine ⇒ NO BAND. `computeTerexLedger` returns `equipment: null` for a
  // site with no Terex (Eugene), for a merged-away row, and for the four
  // `terex`-CATEGORY shear machines that are not the machine. In every one of
  // those cases the totals it returns alongside are empty, and rendering the band
  // would paint a machine that does not exist as one with $0.00 of everything.
  if (!equipment) return null;

  // The LAST ROW OF THE CONFIRMED LOG, in the log's own order (the ledger sorts
  // by `event_date` asc). Deliberately not "the row with the greatest date":
  // `event_date` is NULL on every row whose sheet cell was not a real date, and a
  // max-by-date would silently drop exactly those rows out of contention — the
  // live file's `"09/16 or 17"`, its bare `"Jan"`, its `1/14/202601` typo. The
  // sub-line below says which row this is rather than letting "last" imply a
  // comparison the data cannot support.
  //
  // Absent ⟺ `awaitingAbsorption` (the ledger sets that flag from
  // `events.length === 0`), so the else-branch is the awaiting state, not a
  // second empty case.
  const last = maintenance.events[maintenance.events.length - 1];

  return (
    <section data-testid="terex-metrics-band">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          {equipment.displayName} — cost, repairs &amp; downtime
        </h2>
        <a
          href={`/dashboard/${siteCode}/equipment/${equipment.id}`}
          className="text-sm underline opacity-90 hover:opacity-100"
        >
          Full {equipment.displayName} ledger — every repair, invoice &amp; downtime event →
        </a>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile
          label="Repairs (confirmed log)"
          value={money(maintenance.totalRepairCents)}
          sub={`${maintenance.events.length} confirmed event(s)`}
          accent
        />
        <Tile label="Credited back" value={money(maintenance.totalCreditedCents)} />
        <Tile
          label="AP spend (all invoices)"
          value={formatUsdCents(ap.totalCents)}
          sub={`${ap.invoices.length} invoice(s) tagged to this machine`}
        />
        {/* ADR-0077 D4 — NULL on every production Terex event. "not recorded",
            never "0.0": `hours_down` has never once been written, and the tile
            that used to say 0.0 was reporting a machine nobody measured as a
            machine that never stopped. */}
        <Tile
          label="Downtime (recorded)"
          value={
            downtime.totalHours === null ? 'not recorded' : `${downtime.totalHours.toFixed(1)} hrs`
          }
          sub={
            downtime.totalHours === null
              ? `no hours-down figure on any of ${downtime.eventsConsidered} logged event(s)`
              : `across ${downtime.eventsWithHours} of ${downtime.eventsConsidered} logged event(s)`
          }
        />
      </div>

      {last ? (
        <p
          data-testid="terex-last-maintenance"
          className="mt-3 rounded border border-white/15 bg-black/20 px-3 py-2 text-sm"
        >
          <span className="opacity-70">Last maintenance event:</span>{' '}
          {last.eventDateISO ?? (
            // The sheet cell was not a date. Shown EXACTLY as written, in amber,
            // never coerced — the same treatment the ledger page gives it
            // (ADR-0069 Am.2). A coerced date would look authoritative and be
            // invented.
            <span
              className="text-amber-300"
              title="as written in the sheet — not a parsed date"
              data-testid="terex-last-maintenance-raw-date"
            >
              {last.eventDateRaw ?? 'not recorded'}
            </span>
          )}
          {' — '}
          {last.issue ?? <span className="opacity-60">no issue recorded</span>}
          <span className="ml-1 opacity-55">
            (last row of the confirmed log, in the sheet&apos;s own order)
          </span>
        </p>
      ) : (
        <p
          data-testid="terex-last-maintenance"
          className="mt-3 rounded border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm"
        >
          <strong>Maintenance log awaiting absorption acceptance.</strong> No confirmed maintenance
          rows exist for this machine yet, so there is no repair history to show. This is an empty
          inbox, not a machine that has never needed a repair.
        </p>
      )}
    </section>
  );
}
