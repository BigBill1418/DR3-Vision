// ADR-0039 — Audit review surface (findings queue + Workbench shell).
//
// Manager portal, site-scoped per CLAUDE.md hard rule #2. Desktop-first,
// English-first (permitted for the office super-admin surfaces per ADR-0037).
// Two tabs: Findings (the review queue) and Workbench (the D4a rollup frame).

import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { findingStats, listFindings, type FindingFilter } from '@/lib/audit/findings-query';
import { FindingCard, type FindingCardItem } from './finding-card';
import { AuditWorkbench } from './workbench';
import type { CheckCode, Severity } from '@/lib/audit/types';
import type { FindingStatus } from '@/lib/audit/lifecycle';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ tab?: string; status?: string; check?: string; severity?: string }>;
};

const STATUS_FILTERS: (FindingStatus | 'all')[] = ['open', 'acknowledged', 'resolved', 'not_an_issue', 'all'];
const VALID_STATUS = new Set<FindingStatus>(['open', 'acknowledged', 'resolved', 'not_an_issue']);
const VALID_SEVERITY = new Set<Severity>(['low', 'medium', 'high', 'critical']);
const VALID_CHECK = new Set<CheckCode>([
  'c1_inbound',
  'c2_processed',
  'c3_outbound',
  'c4_billing_basis',
  'c5_conservation',
  'c6_inventory_continuity',
  'c7_deadline',
  'summary_recompute',
  'r1_recycling_rate',
  'r2_recovery_rate',
  'm1_missing_close',
  'm2_missing_snapshot',
]);

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function AuditPage({ params, searchParams }: Props) {
  const { site: siteCode } = await params;
  const sp = await searchParams;

  const session = await auth();
  if (!session?.user) redirect('/login');

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();

  const isAdmin = session.user.role === 'admin';
  const canReach = isAdmin || session.user.all_sites === true || session.user.primary_site_id === site.id;
  if (!canReach) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Access denied</h1>
        <p className="mt-2 text-gray-600">You are not assigned to {site.name}.</p>
        <Link href="/dashboard" className="mt-6 inline-block text-emerald-700 underline">
          Back to sites
        </Link>
      </main>
    );
  }

  const tab = sp.tab === 'workbench' ? 'workbench' : 'findings';

  const filter: FindingFilter = {};
  if (sp.status && VALID_STATUS.has(sp.status as FindingStatus)) filter.status = sp.status as FindingStatus;
  else if (sp.status !== 'all') filter.status = 'open'; // default view = the open queue
  if (sp.severity && VALID_SEVERITY.has(sp.severity as Severity)) filter.severity = sp.severity as Severity;
  if (sp.check && VALID_CHECK.has(sp.check as CheckCode)) filter.checkCode = sp.check as CheckCode;

  const [stats, findings] =
    tab === 'findings'
      ? await Promise.all([findingStats(site.id), listFindings(site.id, filter)])
      : [await findingStats(site.id), []];

  const items: FindingCardItem[] = findings.map((f) => ({
    id: f.id,
    checkCode: f.checkCode,
    kind: f.kind,
    severity: f.severity,
    status: f.status,
    windowStartISO: iso(f.windowStart),
    windowEndISO: iso(f.windowEnd),
    legARef: f.legARef,
    legBRef: f.legBRef,
    causeCategory: f.causeCategory,
    firstDetectedISO: f.firstDetectedAt.toISOString(),
    lastSeenISO: f.lastSeenAt.toISOString(),
  }));

  const tabHref = (t: string) => `/dashboard/${site.code}/audit?tab=${t}`;
  const statusHref = (s: string) => `/dashboard/${site.code}/audit?tab=findings&status=${s}`;
  const activeStatus = filter.status ?? (sp.status === 'all' ? 'all' : 'open');

  // Trailing 14-day window for the Workbench frame (matches the nightly sweep).
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 14);

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/dashboard/${site.code}`} className="text-sm text-emerald-700 hover:underline">
            ← {site.name}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-gray-900">Audit</h1>
          <p className="text-sm text-gray-500">3-way reconciliation: daily logs ↔ MyMRC ↔ billing</p>
        </div>
        {isAdmin && (
          <Link
            href="/admin/audit/workbook"
            className="rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-black"
          >
            Import workbook
          </Link>
        )}
      </div>

      <div className="mt-6 flex gap-4 border-b border-gray-200">
        <Link
          href={tabHref('findings')}
          className={`-mb-px border-b-2 px-1 pb-2 text-sm font-medium ${tab === 'findings' ? 'border-emerald-700 text-emerald-800' : 'border-transparent text-gray-500'}`}
        >
          Findings
        </Link>
        <Link
          href={tabHref('workbench')}
          className={`-mb-px border-b-2 px-1 pb-2 text-sm font-medium ${tab === 'workbench' ? 'border-emerald-700 text-emerald-800' : 'border-transparent text-gray-500'}`}
        >
          Workbench
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-800">Open {stats.open}</span>
        <span className="rounded bg-sky-50 px-2 py-1 text-sky-800">Acknowledged {stats.acknowledged}</span>
        <span className="rounded bg-gray-100 px-2 py-1 text-gray-600">Resolved {stats.resolved}</span>
        <span className="rounded bg-gray-100 px-2 py-1 text-gray-500">Not an issue {stats.notAnIssue}</span>
      </div>

      {tab === 'findings' ? (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {STATUS_FILTERS.map((s) => (
              <Link
                key={s}
                href={statusHref(s)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${activeStatus === s ? 'bg-emerald-700 text-white' : 'bg-gray-100 text-gray-700'}`}
              >
                {s.replace(/_/g, ' ')}
              </Link>
            ))}
          </div>

          <div className="mt-4 space-y-2">
            {items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
                No findings match this filter.
              </div>
            ) : (
              items.map((item) => <FindingCard key={item.id} item={item} siteCode={site.code} />)
            )}
          </div>
        </>
      ) : (
        <div className="mt-4">
          <AuditWorkbench siteId={site.id} windowStartISO={iso(start)} windowEndISO={iso(today)} />
        </div>
      )}
    </main>
  );
}
