// /admin — admin hub. Was a bare redirect to /admin/users; ADR-0040 D5 turns it
// into a small gated tile launcher so the new Billing rates surface is
// discoverable alongside User management and the Audit log. Admin-only, matching
// the ADR-0020 launcher's `admin-only` scope for the "Admin & Audit" tile; the
// billing-rate pages gate independently (manager+ read) so a rate-manager can
// still reach them by direct link.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HOME_ROUTE } from '@/lib/routes';
import { checkAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { adminMessages as AM } from '@/app/admin/messages';

export const dynamic = 'force-dynamic';

const TILES = [
  {
    href: '/admin/users',
    label: 'User management',
    description: 'Seed and manage operators, managers, and admins for both sites.',
    testid: 'admin-tile-users',
  },
  {
    href: '/admin/audit',
    label: 'Audit log',
    description: 'Append-only record of every mutation. Read-only and retained indefinitely.',
    testid: 'admin-tile-audit',
  },
  {
    href: '/admin/billing-rates',
    label: 'Billing rates',
    description: 'Transport tiers, account haul overrides, container rentals, and fuel prices.',
    testid: 'admin-tile-billing-rates',
  },
  {
    href: '/admin/billing/verify',
    label: 'Billing verification',
    description:
      'Read-only pre-GP check: latest invoices with the audit posture of their windows (rollup §1.2).',
    testid: 'admin-tile-billing-verify',
  },
  {
    href: '/admin/rollout',
    label: 'Rollout gate',
    description:
      'Pilot→live control for every staff-facing surface × site (ADR-0047). Flip to ramp; audited.',
    testid: 'admin-tile-rollout',
  },
  {
    href: '/admin/workbook-sync',
    label: 'Workbook sync',
    description:
      'Mirror the Woodland daily-log workbook into Vision (ADR-0049). Sources, run ledger, and cutover.',
    testid: 'admin-tile-workbook-sync',
  },
  {
    href: '/admin/audit/workbook',
    label: 'Workbook import & backfill',
    description:
      'Upload monthly workbooks, then promote June staging rows into the operational tables (ADR-0048).',
    testid: 'admin-tile-workbook',
  },
  {
    href: '/admin/equipment',
    label: 'Terex & equipment assets',
    description:
      "The Terex shear's asset record, plus the rest of the fleet the AP approver tags invoices against (ADR-0063). Site-scoped; deactivate to remove from the picker.",
    testid: 'admin-tile-equipment',
  },
  {
    href: '/admin/equipment/import',
    label: 'Terex history import',
    description: "Import Janette's Terex spreadsheet into the equipment log (ADR-0048 D3).",
    testid: 'admin-tile-terex-import',
  },
  {
    // ADR-0068 Amendment 4 — operator directive 2026-07-30: "its not a tile on my
    // admin portal to get to - its need to be there and accessible to me."
    // Reimbursements are FILED and DECIDED per site, because the authorisation is
    // site-scoped. Oversight is org-wide, and Bill's account has no primary site,
    // so without this tile the only route in was to pick a site first.
    href: '/admin/reimbursements',
    label: 'Employee reimbursements',
    description:
      'Every reimbursement across both sites, with who signed and whether accounting was really told (ADR-0068). Read-only — decisions happen on the site surface.',
    testid: 'admin-tile-reimbursements',
  },
  {
    href: '/admin/ap/routing',
    label: 'AP configuration',
    description:
      'Who checks whose approvals, and who hears about what (ADR-0066). Second-approval routing plus per-user notification preferences, on one screen.',
    testid: 'admin-tile-ap-config',
  },
  {
    href: '/admin/file-drop',
    label: 'File Drop',
    description:
      'Dump any file (invoices, workbooks, images). Captured and listed for routing (O-2).',
    testid: 'admin-tile-file-drop',
  },
  {
    // Points at the SOURCES + CONFIRM QUEUE, not at /connect. The 2026-07-30
    // audit found this tile was the only doc-ingest link in the app and it
    // targeted the connect page, whose only outbound href is back to /admin —
    // so the queue three documents were waiting in was reachable only by typing
    // the URL. Connecting is a one-time act; confirming is the recurring one.
    href: '/admin/doc-ingest',
    label: 'Document ingestion',
    description:
      'Shared documents Vision reads where they live, the confirm queue, and the spreadsheet-vs-Vision reconciliation (ADR-0067 / ADR-0069).',
    testid: 'admin-tile-doc-ingest',
    // ADR-0067 Am.8 — this tile carries a live count. The 2026-07-30 audit found
    // three documents had waited for confirmation since 2026-07-29 09:14 PDT with
    // nothing anywhere in the app saying so. A tile that looks identical whether
    // there is work waiting or not is how that happens.
    badge: 'docIngestAwaiting' as const,
  },
  {
    // ADR-0071. Its own entry, deliberately NOT folded into the daily production
    // report: that report is a production figure a wide audience reads, this one
    // names individuals and is admin-only.
    href: '/admin/processor-quota',
    label: 'Processor quota',
    description:
      'Which Woodland processors finished a week below the daily quota, with the actual counts. The detail behind the weekly exception email (ADR-0071).',
    testid: 'admin-tile-processor-quota',
  },
  {
    // ADR-0019.4. Its own tile rather than a line on the bonus surface: the
    // thing being watched is the CONFIGURATION that lets payroll be signed at
    // all, and it is only load-bearing at 08:30 AM PT on a payroll morning —
    // which is exactly why it needs a standing place someone can look at on any
    // other morning. Twice (2026-07-07, 2026-08-04) the first anyone knew of a
    // dead override actor was the deadline.
    href: '/admin/bonus-chain-health',
    label: 'Bonus signature chain health',
    description:
      'Whether every signer and override actor still resolves to a live account, and whether the 06:30 AM PT check is still running (ADR-0019.4).',
    testid: 'admin-tile-bonus-chain-health',
  },
  {
    // ADR-0072. The recovery path for the one write that can move the whole
    // floor — and the only place a count held for a manager is visible to
    // anyone other than the operator standing at the iPad.
    href: '/admin/inventory/anchors',
    label: 'Inventory anchors',
    description:
      'Anchor history per site, counts held for manager approval, and restoring a prior anchor after a bad count (ADR-0072).',
    testid: 'admin-tile-inventory-anchors',
  },
] as const;

export default async function AdminIndexPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin');
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{AM.forbiddenHeading}</h1>
        <p className="mt-2 text-dr3-mist-dim">{AM.forbiddenBody}</p>
        <Link
          href={HOME_ROUTE}
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          {AM.backToDashboard}
        </Link>
      </main>
    );
  }

  // Same definition as the confirm queue itself (`listDocSources`): a FILE whose
  // classification has been attempted and has no registered kind. Counting
  // anything looser would put a number on the tile that the queue then does not
  // show, which is worse than no number.
  const docIngestAwaiting = await prisma.docSource
    .count({
      where: { doc_class: null, classification_attempted_at: { not: null }, kind: 'file' },
    })
    .catch(() => 0);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href={HOME_ROUTE}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {AM.backToDashboard}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
          <p className="text-sm text-dr3-mist-dim">
            User management, the append-only audit log, and billing rates.
          </p>
        </header>
        <section className="grid gap-4 sm:grid-cols-2">
          {TILES.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              data-testid={t.testid}
              className="group flex flex-col gap-2 rounded-2xl border border-dr3-steel-light/25 bg-dr3-space-2/70 p-6 transition-colors hover:border-dr3-cyan/50"
            >
              <h2 className="flex items-center gap-2 text-lg font-semibold text-dr3-mist">
                {t.label}
                {'badge' in t && t.badge === 'docIngestAwaiting' && docIngestAwaiting > 0 && (
                  <span
                    data-testid="admin-tile-doc-ingest-badge"
                    className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-bold text-amber-300 ring-1 ring-amber-500/40"
                  >
                    {docIngestAwaiting} waiting
                  </span>
                )}
              </h2>
              <p className="text-sm leading-relaxed text-dr3-mist-dim">{t.description}</p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-dr3-cyan">
                Open
                <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                  →
                </span>
              </span>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
