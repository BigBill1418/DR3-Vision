// ADR-0143 D5 — the list of a site's inventory exceptions (open first).
import Link from 'next/link';
import { listInventoryExceptions } from '@/lib/inventory/exception-service';
import { negativeFloorCopy } from '@/lib/inventory/negative-floor';
import { exceptionGate } from './gate';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function InventoryExceptionsPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await exceptionGate(siteCode, `/dashboard/${siteCode}/inventory-exceptions`);
  if (!gate.ok) return gate.page;
  const rows = await listInventoryExceptions(gate.siteId);
  const open = rows.filter((r) => r.status === 'open');

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link
          href={`/dashboard/${siteCode}/loads-inventory`}
          className="text-sm underline opacity-90"
        >
          ← Loads &amp; inventory
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Inventory exceptions — {gate.siteName}
        </h1>
        <p className="mt-2 max-w-3xl text-sm opacity-80">
          An exception opens when a write drives the program or non-program pool below zero. It
          stays open until a pool adjustment (proposed by one person, approved by another) or an
          approved resolution closes it.{' '}
          {negativeFloorCopy({ kind: 'pool-split', pool: 'program' }).remedy}
        </p>
        {open.length === 0 && (
          <p
            className="mt-6 rounded border border-white/15 bg-black/10 p-4 text-sm"
            data-testid="no-open-exceptions"
          >
            No open exceptions.
          </p>
        )}
        <table className="mt-6 w-full text-left text-sm">
          <thead className="opacity-70">
            <tr>
              <th className="py-2">Status</th>
              <th>Pool</th>
              <th>First negative day</th>
              <th>Opened by</th>
              <th>Deepest shortfall</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/10">
                <td className="py-2">
                  {r.status === 'open' ? (
                    <strong className="text-red-300">Open</strong>
                  ) : (
                    'Resolved'
                  )}
                </td>
                <td>{r.pool === 'program' ? 'Program' : 'Non-program'}</td>
                <td>{r.firstNegativeDay}</td>
                <td>{r.openedByWriter}</td>
                <td>{r.shortfall} units</td>
                <td>
                  <Link
                    href={`/dashboard/${siteCode}/inventory-exceptions/${r.id}`}
                    className="underline"
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
