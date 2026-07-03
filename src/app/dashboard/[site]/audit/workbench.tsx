// ADR-0039 D4a — the Audit Workbench frame. Renders three rollups (inbound
// source-type / outbound commodity×sub-category / inventory day-ledger) from the
// typed provider. Live against the merged ADR-0037 tables via
// `dbWorkbenchProvider`; an empty window renders an honest "no activity" state
// (never fabricated data), and each frame names its drill-down wiring point.

import { prisma } from '@/lib/prisma';
import { dbWorkbenchProvider } from '@/lib/audit/workbench-providers';

function Frame({
  title,
  wiring,
  children,
}: {
  title: string;
  wiring: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <div className="mt-2">{children}</div>
      <p className="mt-3 text-xs text-gray-400">Drill-down wiring: {wiring}</p>
    </section>
  );
}

function PendingEmptyState({ note }: { note: string }) {
  return (
    <div className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
      <div className="font-medium text-gray-600">Integration pending</div>
      <p className="mx-auto mt-1 max-w-prose text-xs">{note}</p>
    </div>
  );
}

function NoActivity({ what }: { what: string }) {
  return (
    <div className="rounded border border-dashed border-gray-200 bg-gray-50 px-3 py-5 text-center text-xs text-gray-400">
      No {what} recorded in this window.
    </div>
  );
}

export async function AuditWorkbench({
  siteId,
  windowStartISO,
  windowEndISO,
}: {
  siteId: string;
  windowStartISO: string;
  windowEndISO: string;
}) {
  const rollups = await dbWorkbenchProvider(prisma).rollups(siteId, windowStartISO, windowEndISO);
  const pending = rollups.state === 'integration_pending';

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Kelsey&apos;s hand-built daily-log shortcuts, transcribed: category rollups, auto outbound-weight
        derivation, and the rolling inventory ledger. Window {windowStartISO} → {windowEndISO}.
      </p>

      <Frame
        title="Inbound by source type"
        wiring="each source-type cell → the underlying inbound_loads + consumer_dropoffs list"
      >
        {pending ? (
          <PendingEmptyState note={rollups.pendingNote} />
        ) : rollups.inboundBySourceType.length === 0 ? (
          <NoActivity what="inbound units" />
        ) : (
          <ul className="text-sm text-gray-800">
            {rollups.inboundBySourceType.map((r) => (
              <li key={r.sourceType}>
                {r.label}: {r.units} {r.isNonProgram ? '(non-program)' : ''}
              </li>
            ))}
          </ul>
        )}
      </Frame>

      <Frame
        title="Outbound by commodity × sub-category"
        wiring="each commodity/sub-category cell → the underlying outbound_materials rows + bale photos"
      >
        {pending ? (
          <PendingEmptyState note={rollups.pendingNote} />
        ) : rollups.outboundByCommodity.length === 0 ? (
          <NoActivity what="outbound materials" />
        ) : (
          <ul className="text-sm text-gray-800">
            {rollups.outboundByCommodity.map((r) => (
              <li key={`${r.commodity}-${r.subCategory ?? 'na'}`}>
                {r.commodity} / {r.subCategory ?? '—'}: {r.weightLbs} lbs
              </li>
            ))}
          </ul>
        )}
      </Frame>

      <Frame
        title="Inventory day-ledger"
        wiring="each day row → close lines, physical snapshots, and any audit findings touching those records"
      >
        {pending ? (
          <PendingEmptyState note={rollups.pendingNote} />
        ) : rollups.inventoryLedger.length === 0 ? (
          <NoActivity what="inventory movement" />
        ) : (
          <table className="w-full text-left text-sm text-gray-800">
            <thead>
              <tr className="text-xs uppercase text-gray-500">
                <th className="py-1">Day</th>
                <th>Start</th>
                <th>In</th>
                <th>Processed</th>
                <th>Whole out</th>
                <th>Computed end</th>
                <th>Physical Δ</th>
              </tr>
            </thead>
            <tbody>
              {rollups.inventoryLedger.map((d) => (
                <tr key={d.dateISO} className="border-t border-gray-100">
                  <td className="py-1">{d.dateISO}</td>
                  <td>{d.start}</td>
                  <td>{d.inbound}</td>
                  <td>{d.processed}</td>
                  <td>{d.wholeUnitsOut}</td>
                  <td>{d.computedEnd}</td>
                  <td>{d.reconciledDelta ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Frame>
    </div>
  );
}
