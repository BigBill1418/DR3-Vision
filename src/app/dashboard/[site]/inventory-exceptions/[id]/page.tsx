// ADR-0143 D5 — one inventory exception: which day and which leg drove the pool
// below zero, the adjustments proposed against it, and the four-eyes actions.
//
// This is the ONE surface where a computed negative closing is shown, and it is
// shown as a DIAGNOSIS (labelled, in the legs table), never as an on-hand figure:
// the person resolving the exception has to see the day and the leg (ADR-0143 D1
// note). Every on-hand figure elsewhere goes through presentOnHand().
import Link from 'next/link';
import {
  getInventoryExceptionDetail,
  InventoryExceptionError,
} from '@/lib/inventory/exception-service';
import { negativeFloorCopy } from '@/lib/inventory/negative-floor';
import { exceptionGate } from '../gate';
import { ExceptionActions } from './ExceptionActions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string; id: string }> };

const POOL = { program: 'Program', non_program: 'Non-program' } as const;

export default async function InventoryExceptionPage({ params }: Props) {
  const { site: siteCode, id } = await params;
  const gate = await exceptionGate(siteCode, `/dashboard/${siteCode}/inventory-exceptions/${id}`);
  if (!gate.ok) return gate.page;
  let detail;
  try {
    detail = await getInventoryExceptionDetail(gate.siteId, id);
  } catch (e) {
    if (e instanceof InventoryExceptionError && e.status === 404) {
      return (
        <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
          <p>Exception not found at this site.</p>
        </main>
      );
    }
    throw e;
  }
  const { exception: ex, positions, adjustments } = detail;
  const copy = negativeFloorCopy({
    kind: 'pool-split',
    pool: ex.pool === 'program' ? 'program' : 'non-program',
  });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link
          href={`/dashboard/${siteCode}/inventory-exceptions`}
          className="text-sm underline opacity-90"
        >
          ← All inventory exceptions
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          {POOL[ex.pool]} pool below zero — {gate.siteName}
        </h1>
        <p className="mt-1 text-sm opacity-80" data-testid="exception-status">
          {ex.status === 'open' ? 'OPEN' : `RESOLVED — ${ex.resolution ?? ''}`} · first negative day{' '}
          {ex.firstNegativeDay} (Pacific) · opened by {ex.openedByWriter} · deepest shortfall{' '}
          {ex.shortfall} units
        </p>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed">
          {copy.reason} {copy.remedy} Units are not reclassified for MRC reporting: an adjustment
          corrects the floor split only, and the total cannot change.
        </p>

        <h2 className="mt-8 text-xl font-semibold">
          Day by day ({POOL[ex.pool].toLowerCase()} pool)
        </h2>
        <p className="text-xs opacity-70">
          Computed from the ledger (anchor + inbound + drop-offs − stripped − sold − landfilled ±
          adjustments). A negative closing is a diagnosis, not a count.
        </p>
        <table className="mt-3 w-full text-right text-sm tabular-nums">
          <thead className="opacity-70">
            <tr>
              <th className="py-2 text-left">Day</th>
              <th>Opening</th>
              <th>Inbound</th>
              <th>Drop-offs</th>
              <th>Stripped</th>
              <th>Sold</th>
              <th>Landfilled</th>
              <th>Adjustments</th>
              <th>Closing</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr
                key={p.day}
                className={`border-t border-white/10 ${p.negative ? 'text-red-300' : ''}`}
              >
                <td className="py-1 text-left">{p.day}</td>
                <td>{p.opening}</td>
                <td>{p.inbound}</td>
                <td>{p.dropoffs}</td>
                <td>{p.stripped}</td>
                <td>{p.sold}</td>
                <td>{p.landfilled}</td>
                <td>{p.adjustments}</td>
                <td>{p.closing}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="mt-8 text-xl font-semibold">Adjustments</h2>
        {adjustments.length === 0 && <p className="text-sm opacity-80">None proposed yet.</p>}
        <ExceptionActions
          siteCode={siteCode}
          exceptionId={ex.id}
          exceptionOpen={ex.status === 'open'}
          pool={ex.pool}
          firstNegativeDay={ex.firstNegativeDay}
          currentUserId={gate.userId}
          adjustments={adjustments}
          resolutionProposedBy={ex.resolutionProposedBy}
          resolutionProposedNote={ex.resolutionProposedNote}
          resolutionProposedAt={ex.resolutionProposedAt}
        />
      </div>
    </main>
  );
}
