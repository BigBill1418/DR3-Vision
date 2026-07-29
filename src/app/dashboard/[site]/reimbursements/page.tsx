// ADR-0068 §4 — the Employee Reimbursement page.
//
// Site-scoped (CLAUDE.md hard rule #2) via `checkManagerForSite`: manager or
// admin, and a plain manager is hard-scoped to their own site.
//
// `viewerMayApprove` is computed SERVER-SIDE per row, through the same
// `canApproveReimbursement` the write path uses. The client is told what to
// render; it is never trusted for the decision. That matters here more than
// usual: the whole feature exists because a control that looked enforced was not.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { pacificDayISO } from '@/lib/time';
import { canApproveReimbursement } from '@/lib/reimbursements/routing';
import { beneficiaryLabel } from '@/lib/reimbursements/service';
import { ReimbursementsClient, type ReimbursementRow } from './ReimbursementsClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

function pacific(d: Date): string {
  return `${d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  })} PT`;
}

export default async function ReimbursementsPage({ params }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/reimbursements`);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">This area is restricted to {siteCode} managers.</p>
        <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const { siteId, siteName, userId } = result.ctx;

  // The beneficiary picker: active people on this site, plus all-sites staff.
  // Free text covers everyone else (D2) — not every reimbursed person is a user.
  const roster = await prisma.user.findMany({
    where: {
      is_active: true,
      deleted_at: null,
      OR: [{ primary_site_id: siteId }, { all_sites: true }],
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const raw = await prisma.reimbursementRequest.findMany({
    where: { site_id: siteId },
    select: {
      id: true,
      amount_cents: true,
      expense_date: true,
      category: true,
      purpose: true,
      status: true,
      submitted_at: true,
      submitted_by: true,
      employee_user_id: true,
      employee_name_freeform: true,
      second_approved_at: true,
      decision_note: true,
      escalated_at: true,
      employee_user: { select: { name: true } },
      submitter: { select: { name: true } },
      second_approver: { select: { name: true } },
      routed_to: { select: { name: true } },
    },
    orderBy: [{ submitted_at: 'desc' }],
    take: 200,
  });

  const rows: ReimbursementRow[] = [];
  for (const r of raw) {
    // Server-authoritative, per row, via the SAME function the write path calls.
    const mayApprove =
      r.status === 'pending_second_approval'
        ? await canApproveReimbursement(prisma, userId, {
            submittedBy: r.submitted_by,
            employeeUserId: r.employee_user_id,
            employeeNameFreeform: r.employee_name_freeform,
            escalated: r.escalated_at != null,
            requestSiteId: siteId,
          })
        : false;

    rows.push({
      id: r.id,
      amountCents: r.amount_cents,
      expenseDate: r.expense_date.toISOString().slice(0, 10),
      category: r.category,
      purpose: r.purpose,
      status: r.status,
      beneficiary: beneficiaryLabel(r),
      submitterName: r.submitter.name,
      submittedAtPacific: pacific(r.submitted_at),
      routedToName: r.routed_to.name,
      secondApproverName: r.second_approver?.name ?? null,
      decisionNote: r.decision_note,
      escalated: r.escalated_at != null,
      viewerMayApprove: mayApprove,
      viewerSubmitted: r.submitted_by === userId,
    });
  }

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6">
          <Link
            href={`/dashboard/${siteCode}`}
            className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist"
          >
            ← {siteName}
          </Link>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Employee reimbursement</h1>
          <p className="mt-1 text-sm text-dr3-mist-dim">
            Every reimbursement needs two signatures from two different people, whatever the amount.
            Your submission is the first one.
          </p>
        </header>

        <ReimbursementsClient
          siteCode={siteCode}
          roster={roster}
          rows={rows}
          todayPacific={pacificDayISO(new Date())}
        />
      </div>
    </main>
  );
}
