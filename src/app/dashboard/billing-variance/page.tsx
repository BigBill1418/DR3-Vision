// ADR-0040 D6 — rate variance report (manager portal page).
//
// Server component, gated to manager+ via `checkRateRead`. Renders the variance table
// (per trans-charge source: canonical mileage, tier-now vs tier-last-billed, per-haul
// delta, monthly leakage) and links to the CSV export. When the workbook/invoice
// history provider is unavailable (current `main` state), it shows an honest empty
// state: tier-now columns populate, last-billed/leakage read "—" with a TODO banner.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkRateRead } from '@/lib/auth-helpers';
import { buildVarianceReport } from '@/lib/billing-rates/variance';

export const dynamic = 'force-dynamic';

function usd(cents: number | null): string {
  return cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function num(n: number | null): string {
  return n == null ? '—' : String(n);
}

export default async function BillingVariancePage() {
  const gate = await checkRateRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/dashboard/billing-variance');
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Not authorized</h1>
        <p className="mt-2 text-dr3-mist-dim">This report is available to managers and admins.</p>
        <Link href={HOME_ROUTE} className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline">
          ← Back to dashboard
        </Link>
      </main>
    );
  }

  const report = await buildVarianceReport({ date: new Date() });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <Link href={HOME_ROUTE} className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline">
            ← Back to dashboard
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Freight rate variance</h1>
              <p className="text-sm text-dr3-mist-dim">
                Current freight tier vs. the tier each trans-charge source was last billed under. As of {report.as_of}.
              </p>
            </div>
            <a
              href="/api/manager/billing-rates/variance?format=csv"
              download={`dr3-rate-variance-${report.as_of}.csv`}
              className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright"
              data-testid="variance-csv"
            >
              Export CSV
            </a>
          </div>
        </header>

        {!report.provider_available ? (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-100"
            data-testid="variance-provider-unavailable"
          >
            Last-billed history is not yet available. The tier-now column reflects current
            mileage; last-billed, per-haul delta, and monthly leakage populate once the
            workbook/invoice import (ADR-0039 audit engine staging) lands.{' '}
            <span className="opacity-80">TODO(ADR-0040 D6): wire a provider over the workbook staging tables.</span>
          </p>
        ) : (
          <p className="text-sm text-dr3-mist-dim" data-testid="variance-total">
            Total estimated monthly leakage: <span className="font-semibold text-dr3-cyan">{usd(report.total_monthly_leakage_cents)}</span>
          </p>
        )}

        <div className="overflow-x-auto rounded-md border border-dr3-steel-light/25">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="bg-dr3-space-2 text-left text-xs uppercase tracking-wider text-dr3-cyan">
                <Th>Source</Th>
                <Th>Juris.</Th>
                <Th className="text-right">Mileage</Th>
                <Th className="text-right">Tier now</Th>
                <Th className="text-right">Last-billed mi.</Th>
                <Th className="text-right">Tier then</Th>
                <Th className="text-right">Δ / haul</Th>
                <Th className="text-right">Hauls/mo</Th>
                <Th className="text-right">Monthly leakage</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-6 text-center text-dr3-mist-dim">
                    No active trans-charge sources.
                  </td>
                </tr>
              ) : (
                report.rows.map((r) => (
                  <tr key={r.source_id} className="border-t border-dr3-steel-light/15">
                    <Td>{r.source_name}</Td>
                    <Td>{r.jurisdiction}</Td>
                    <Td className="text-right">{num(r.canonical_mileage)}</Td>
                    <Td className="text-right">{usd(r.tier_now_cents)}</Td>
                    <Td className="text-right">{num(r.last_billed_mileage)}</Td>
                    <Td className="text-right">{usd(r.tier_last_cents)}</Td>
                    <Td className="text-right">{usd(r.per_haul_delta_cents)}</Td>
                    <Td className="text-right">{num(r.hauls_per_month)}</Td>
                    <Td className="text-right">{usd(r.monthly_leakage_cents)}</Td>
                    <Td className="text-dr3-mist-dim">{r.note ?? ''}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 font-semibold ${className}`}>{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 ${className}`}>{children}</td>;
}
