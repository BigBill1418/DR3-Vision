// ADR-0045 D1 — the ops ledger surface for a site: meeting notes + the task
// follow-up queue, with an overdue / due-today tile at the top. Site-scoped
// (hard rule #2) via checkManagerForSite; org-wide rows also appear for
// admin / all_sites callers (reach handled in the services). English-first
// (manager/office surface, not an operator iPad).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { currentOpsViewer } from '@/lib/ops/viewer';
import { hasOrgReach } from '@/lib/ops/reach';
import { dueSummaryForSite, listAssignableAdmins } from '@/lib/ops/tasks';
import { appToday } from '@/lib/time';
import { OpsClient } from './OpsClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function OpsPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/ops`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const identity = await currentOpsViewer();
  const orgReach = identity ? hasOrgReach(identity.viewer) : false;
  const [due, admins] = await Promise.all([
    dueSummaryForSite(result.ctx.siteId, appToday(), orgReach),
    listAssignableAdmins(),
  ]);
  const assignees = admins.map((a) => ({ id: a.id, name: a.name ?? a.email ?? a.id }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto max-w-5xl">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {result.ctx.siteName} dashboard
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Ops ledger — {result.ctx.siteName}
        </h1>
        <p className="mt-1 text-sm opacity-75">
          Meeting notes and task follow-ups in one place. Reminders are in-app and in the daily
          digest — never a push. {orgReach ? 'Org-wide items are shown alongside this site.' : ''}
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <DueTile label="Overdue" value={due.overdue.length} accent />
          <DueTile label="Due today" value={due.dueToday.length} />
        </div>

        <OpsClient siteCode={siteCode} canWriteOrgWide={orgReach} assignees={assignees} />
      </div>
    </main>
  );
}

function DueTile({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-4 ${accent && value > 0 ? 'border-red-400/60 bg-red-950/30' : 'border-white/15 bg-black/10'}`}
    >
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}
