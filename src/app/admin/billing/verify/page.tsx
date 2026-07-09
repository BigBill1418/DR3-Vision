// 2026-07-09 rollup §1.2 (ADR-0039/0041 addendum) — the billing verification
// page Mary reads BEFORE typing an invoice into GP.
//
// READ-ONLY by construction: no mutations, no buttons that write. Gated by
// `checkBillingVerifyRead` (admin role, or the `can_view_billing_verify` flag —
// the flag unlocks exactly this page and nothing else; see auth-helpers). Not an
// ADR-0047 rollout surface: this is an internal admin/accounting page, not a
// staff-facing operator surface. English-only (admin-surface convention).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkBillingVerifyRead } from '@/lib/auth-helpers';
import { KIND_LABEL } from '@/lib/invoices/types';
import { formatUsdCents as usd } from '@/lib/invoices/format';
import {
  buildBillingVerifyModel,
  type VerifyInvoiceEntry,
  type VerifyLight,
} from '@/lib/invoices/verify-view';

export const dynamic = 'force-dynamic';

const M = {
  title: 'Billing verification',
  subtitle:
    'Read-only pre-GP check: the latest invoice per kind for the current and previous Pacific billing months, with the three-way-audit posture of each window. Green — approved and clean: type it into GP. Yellow — findings to read first, or the invoice is still a draft (draft numbers regenerate and are never GP-safe). Red — the trust gate blocks this window; loop back before entering anything.',
  forbiddenHeading: '403 — billing verification access required',
  forbiddenBody:
    'This page is restricted to administrators and users granted billing-verify access.',
  backToDashboard: 'Back to dashboard',
  noInvoices: 'No invoices on file for the current or previous billing month.',
  gross: 'Gross month total',
  tradeDiscount: 'Trade discount (mid-month already invoiced)',
  balanceDue: 'Balance due',
  findings: 'Active findings in window',
  gateBlocked: 'TRUST GATE BLOCKED',
  gateOverridden: 'gate overridden (super-admin)',
} as const;

const LIGHT_STYLE: Record<VerifyLight, { dot: string; label: string }> = {
  green: { dot: 'bg-emerald-400', label: 'Approved + clean — clear to enter' },
  yellow: { dot: 'bg-amber-400', label: 'Review first (findings or still a draft)' },
  red: { dot: 'bg-red-500', label: 'Blocked — do not enter' },
};

function InvoiceCard({ inv }: { inv: VerifyInvoiceEntry }) {
  const light = LIGHT_STYLE[inv.light];
  return (
    <div className="rounded-lg border border-dr3-steel-light/40 bg-dr3-space-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${light.dot}`} aria-hidden />
            <span className="text-sm font-semibold text-dr3-mist">{KIND_LABEL[inv.kind]}</span>
            <span className="text-xs text-dr3-mist-dim">
              v{inv.version} · {inv.status}
            </span>
          </div>
          <div className="mt-1 text-xs text-dr3-mist-dim">
            {inv.billingMonthISO.slice(0, 7)} · window {inv.windowStartISO} → {inv.windowEndISO} ·{' '}
            {light.label}
            {inv.gate.overridden ? ` · ${M.gateOverridden}` : ''}
          </div>
        </div>
        <div className="text-right text-sm font-semibold text-dr3-mist">{usd(inv.totalCents)}</div>
      </div>

      {inv.tradeDiscountCents != null && (
        // rollup §1.3 — the exact three lines Mary types into the GP EOM invoice.
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-dr3-steel-light/30 pt-3 text-xs">
          <dt className="text-dr3-mist-dim">{M.gross}</dt>
          <dd className="text-right text-dr3-mist">
            {inv.grossCents != null ? usd(inv.grossCents) : '—'}
          </dd>
          <dt className="text-dr3-mist-dim">
            {M.tradeDiscount}
            {inv.tradeDiscountReferenceInvoiceId ? (
              <span className="text-dr3-mist-dim/70">
                {' '}
                · ref {inv.tradeDiscountReferenceInvoiceId.slice(0, 8)}
              </span>
            ) : null}
          </dt>
          <dd className="text-right text-dr3-mist">{usd(-inv.tradeDiscountCents)}</dd>
          <dt className="font-semibold text-dr3-mist">{M.balanceDue}</dt>
          <dd className="text-right font-semibold text-dr3-mist">{usd(inv.totalCents)}</dd>
        </dl>
      )}

      {inv.gate.blocked && (
        <div className="mt-3 rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300">
          {M.gateBlocked}
          {inv.gate.findingCodes.length > 0 ? ` — ${inv.gate.findingCodes.join(', ')}` : ''}
        </div>
      )}

      {inv.activeFindings.length > 0 && (
        <div className="mt-3 border-t border-dr3-steel-light/30 pt-3">
          <div className="text-xs font-semibold text-dr3-mist-dim">
            {M.findings} ({inv.activeFindings.length})
          </div>
          <ul className="mt-1 space-y-1">
            {inv.activeFindings.map((f) => (
              <li key={f.id} className="text-xs text-dr3-mist-dim">
                <span className="font-mono">{f.checkCode}</span> · {f.findingKind} · {f.severity} ·{' '}
                {f.status} · {f.windowStartISO} → {f.windowEndISO}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default async function BillingVerifyPage() {
  const gate = await checkBillingVerifyRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/billing/verify');
    return <ForbiddenPage />;
  }

  // Hard rule #2 site reach: admins + all-sites managers see both sites; a
  // single-site manager sees exactly their primary site. A flagged manager
  // with no primary site has no reach — treat as forbidden.
  const { ctx } = gate;
  if (!ctx.allSites && !ctx.primarySiteId) return <ForbiddenPage />;
  const sites = await buildBillingVerifyModel(
    ctx.allSites ? { kind: 'all' } : { kind: 'site', siteId: ctx.primarySiteId! },
  );

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold text-dr3-mist">{M.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-dr3-mist-dim">{M.subtitle}</p>

        {sites.map((site) => (
          <section key={site.siteId} className="mt-8">
            <h2 className="text-lg font-semibold text-dr3-mist">{site.siteName}</h2>
            {site.invoices.length === 0 ? (
              <p className="mt-2 text-sm text-dr3-mist-dim">{M.noInvoices}</p>
            ) : (
              <div className="mt-3 space-y-3">
                {site.invoices.map((inv) => (
                  <InvoiceCard key={inv.id} inv={inv} />
                ))}
              </div>
            )}
          </section>
        ))}

        <div className="mt-10">
          <Link
            href={HOME_ROUTE}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            {M.backToDashboard}
          </Link>
        </div>
      </div>
    </main>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{M.forbiddenHeading}</h1>
      <p className="mt-2 text-dr3-mist-dim">{M.forbiddenBody}</p>
      <Link
        href={HOME_ROUTE}
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
      >
        {M.backToDashboard}
      </Link>
    </main>
  );
}
