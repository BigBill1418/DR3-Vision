'use client';

// ADR-0077 D6 — rendering for the machine ledger.
//
// Every rendering rule here exists to stop a gap looking like a fact:
//   - blank money renders "not recorded", NEVER "$0.00" (a repair nobody priced
//     is not a free repair — the wording is lifted from the TEREX preview screen
//     so both surfaces say the same thing);
//   - an unparsed date renders the RAW cell text in amber, never a guessed date;
//   - `estimated_time_cost` is printed verbatim under an explicit "as written"
//     label, because the column is free text ("2 weeks") pretending to be a
//     number;
//   - the maintenance and AP panels sit SIDE BY SIDE with an explicit "not
//     linked" note — v1 does no invoice↔event matching, and an unlabelled
//     adjacency would read as one.

import Link from 'next/link';
import { formatUsdCents } from '@/lib/invoices/format';
import type { TerexLedger } from '@/lib/equipment/terex-ledger';

/** The one money rule on this page: absent is said out loud, never zeroed. */
function money(cents: number | null) {
  return cents === null ? (
    <span className="opacity-60">not recorded</span>
  ) : (
    <span className="tabular-nums">{formatUsdCents(cents)}</span>
  );
}

function Panel({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 rounded-lg border border-white/10 bg-white/[0.03] p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {sub ? <p className="mt-1 text-xs opacity-70">{sub}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function TerexLedgerClient({ ledger, siteCode }: { ledger: TerexLedger; siteCode: string }) {
  const { maintenance, ap, downtime } = ledger;

  return (
    <div>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="AP spend (all invoices)" value={formatUsdCents(ap.totalCents)} accent />
        <Tile
          label="Repairs (confirmed log)"
          value={
            maintenance.totalRepairCents === null
              ? 'not recorded'
              : formatUsdCents(maintenance.totalRepairCents)
          }
        />
        <Tile
          label="Credited (confirmed log)"
          value={
            maintenance.totalCreditedCents === null
              ? 'not recorded'
              : formatUsdCents(maintenance.totalCreditedCents)
          }
        />
        <Tile
          label="Downtime (recorded)"
          value={
            downtime.totalHours === null ? 'not recorded' : `${downtime.totalHours.toFixed(1)} hrs`
          }
        />
      </div>

      <Panel
        title="AP cost ledger"
        sub={`Every approved invoice tagged to this machine. ${ap.invoices.length} invoice(s), ${formatUsdCents(ap.totalCents)} total.`}
      >
        {ap.invoices.length === 0 ? (
          <p className="text-sm opacity-70">No invoices are tagged to this machine yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide opacity-60">
                <tr>
                  <th className="pb-2 pr-4 font-semibold">Received</th>
                  <th className="pb-2 pr-4 font-semibold">Vendor</th>
                  <th className="pb-2 pr-4 text-right font-semibold">Amount</th>
                  <th className="pb-2 font-semibold">Decision</th>
                </tr>
              </thead>
              <tbody>
                {ap.invoices.map((inv) => (
                  <tr key={inv.linkId} className="border-t border-white/10">
                    <td className="py-2 pr-4 tabular-nums">{inv.receivedAtISO.slice(0, 10)}</td>
                    <td className="py-2 pr-4">
                      {inv.vendor ?? <span className="opacity-60">not recorded</span>}
                    </td>
                    <td className="py-2 pr-4 text-right">{money(inv.amountCents)}</td>
                    <td className="py-2 text-xs">
                      {inv.decisionHref ? (
                        <Link href={inv.decisionHref} className="underline opacity-90">
                          AP history
                        </Link>
                      ) : (
                        // Deliberate: /admin/ap/history 403s for site managers, and
                        // handing them a link that fails is the ADR-0075 defect.
                        <span className="opacity-60">{inv.requestId.slice(0, 8)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 rounded border border-amber-400/30 bg-amber-400/5 p-3 text-xs opacity-90">
          <strong>Invoices are not linked to individual repairs.</strong> Every invoice on this
          machine is from the same vendor within a few days of the others, so matching them to
          maintenance events by date or amount would invent connections rather than find them. The
          two lists are shown side by side and left unjoined on purpose.
        </p>
      </Panel>

      <Panel
        title="Maintenance log"
        sub="Confirmed rows only — money that has been accepted, never a staged preview."
      >
        {maintenance.awaitingAbsorption ? (
          <div className="rounded border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
            <p className="font-semibold">Maintenance log awaiting absorption acceptance.</p>
            <p className="mt-2 opacity-90">
              The TEREX workbook has not been absorbed and accepted into Vision yet, so there are no
              confirmed maintenance events to show. This is an empty <em>inbox</em>, not a machine
              that has never needed a repair — do not read it as a clean history.
            </p>
            <p className="mt-2 text-xs opacity-70">
              An admin completes this at <code>/admin/doc-ingest</code> (classify the source, apply
              the staged revision, then accept the batch at <code>/admin/doc-ingest/terex</code>).
              Tracked as O-12.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide opacity-60">
                <tr>
                  <th className="pb-2 pr-4 font-semibold">Date</th>
                  <th className="pb-2 pr-4 font-semibold">Issue</th>
                  <th className="pb-2 pr-4 font-semibold">Measures taken</th>
                  <th className="pb-2 pr-4 font-semibold">Est. repair time (as written)</th>
                  <th className="pb-2 pr-4 text-right font-semibold">Actual repair</th>
                  <th className="pb-2 text-right font-semibold">Credited</th>
                </tr>
              </thead>
              <tbody>
                {maintenance.events.map((e) => (
                  <tr key={e.id} className="border-t border-white/10 align-top">
                    <td className="py-2 pr-4 tabular-nums">
                      {e.eventDateISO ?? (
                        // The sheet holds "09/16 or 17" and a bare "Jan". Shown as
                        // written, amber, never coerced into a date (ADR-0069 Am.2).
                        <span
                          className="text-amber-300"
                          title="as written in the sheet — not a parsed date"
                        >
                          {e.eventDateRaw ?? 'not recorded'}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {e.issue ?? <span className="opacity-60">—</span>}
                    </td>
                    <td className="py-2 pr-4">
                      {e.measuresTaken ?? <span className="opacity-60">—</span>}
                    </td>
                    <td className="py-2 pr-4 opacity-90">
                      {e.estimatedTimeCost ?? <span className="opacity-60">—</span>}
                    </td>
                    <td className="py-2 pr-4 text-right">{money(e.actualRepairCostCents)}</td>
                    <td className="py-2 text-right">{money(e.amountCreditedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Downtime">
        {downtime.totalHours === null ? (
          <div className="text-sm">
            <p className="font-semibold">Not recorded.</p>
            <p className="mt-2 opacity-90">
              No downtime hours have ever been recorded for this machine —{' '}
              {downtime.eventsConsidered} event(s) are logged and none carries an hours-down figure.
              The workbook has no downtime column either (ADR-0077 D4), so this is a gap in
              collection, not a machine that never stopped. It is deliberately not shown as 0.0.
            </p>
          </div>
        ) : (
          <p className="text-sm">
            <span className="text-xl font-bold tabular-nums">{downtime.totalHours.toFixed(1)}</span>{' '}
            hours across {downtime.eventsWithHours} of {downtime.eventsConsidered} logged event(s).
          </p>
        )}
      </Panel>

      <p className="mt-8 text-xs opacity-60">
        Read-only. This page writes nothing — the maintenance log is written by document absorption,
        the ledger by AP decisions, and the events by the{' '}
        <Link href={`/dashboard/${siteCode}/equipment`} className="underline">
          equipment surface
        </Link>
        .
      </p>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-4 ${accent ? 'border-dr3-cyan/40 bg-dr3-cyan/5' : 'border-white/10 bg-white/[0.03]'}`}
    >
      <div className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
