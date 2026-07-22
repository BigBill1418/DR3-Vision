// ADR-0046 Amendment 5 (D-M5-5) — invoice history search surface.
//
// Gated by checkApHistoryRead — admins + designated second approvers ONLY (the
// general ap_approvers roster does NOT see historical AP data). Renders the filter
// UI + result table over the union of Vision-decided invoices + Bill-uploaded
// history; the client fetches /api/admin/ap/history (same gate). No aggregate
// dashboards (D-M5-5).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { checkApHistoryRead } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { HistoryClient, type ApproverOption } from './HistoryClient';

export const dynamic = 'force-dynamic';

export default async function ApHistoryPage() {
  const gate = await checkApHistoryRead();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/ap/history');
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">403 — AP history access required</h1>
        <p className="mt-2 text-gray-600">
          This surface is restricted to administrators and designated second approvers.
        </p>
        <Link href="/dashboard" className="mt-6 inline-block text-emerald-700 underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // Approver filter options: everyone who has decided an AP request.
  const decided = await prisma.apRequest.findMany({
    where: { status: { in: ['approved', 'rejected'] }, decided_by: { not: null } },
    select: { decided_by: true },
    distinct: ['decided_by'],
  });
  const ids = decided.map((d) => d.decided_by).filter((x): x is string => !!x);
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const approvers: ApproverOption[] = users
    .map((u) => ({ id: u.id, name: u.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/admin" className="text-sm text-emerald-700 hover:underline">
        ← Admin
      </Link>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">AP invoice history</h1>
      <p className="mt-2 max-w-3xl text-sm text-gray-600">
        Search across Vision-decided invoices and Bill-uploaded AP history. Filter by vendor, date,
        amount, site, approver, or source. Click a row for full detail.
      </p>

      <div className="mt-6">
        <HistoryClient approvers={approvers} />
      </div>
    </main>
  );
}
