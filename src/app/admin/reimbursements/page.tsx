// ADR-0068 Amendment 4 — the ORG-WIDE reimbursement oversight surface.
//
// ── Why this exists separately from the site surfaces ───────────────────────
// Reimbursements are filed and decided per site (`/dashboard/<site>/reimbursements`),
// because the authorisation that governs a decision is site-scoped: a non-admin
// without `all_sites` may only act on their own site. That is correct for DOING
// the work.
//
// It is wrong for OVERSIGHT. Bill's account is `admin` with `primary_site_id =
// NULL` and `all_sites = false`, so he lands on the picker and never on a site
// page by default — the same reason the tile had to move to the primary dashboard
// (Amendment 2). Operator directive 2026-07-30: *"its not a tile on my admin
// portal to get to - its need to be there and accessible to me."*
//
// ── Read-only, deliberately ─────────────────────────────────────────────────
// There are no Approve/Reject controls here, and that is not an omission. Only
// ONE person can act on any given reimbursement — `canApproveReimbursement`
// hard-stops the submitter and the beneficiary — and the check that decides who
// lives on the site surface. A second decision path would put the control in two
// places, which is how controls drift apart. Every row links to the surface where
// the real, server-authorised decision happens.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const STATUS_LABEL = {
  pending_second_approval: 'Waiting for a second signature',
  approved: 'Approved — sent to accounting',
  rejected: 'Not approved',
  held: 'On hold',
} as const;

const STATUS_STYLE = {
  pending_second_approval: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  rejected: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  held: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
} as const;

type Status = keyof typeof STATUS_LABEL;

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Pacific, always — a bare UTC timestamp shown to a human is the defect. */
function pacific(d: Date | null): string {
  if (!d) return '—';
  return `${d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  })} PT`;
}

export default async function AdminReimbursementsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Admin POWERS (not site reach) — this is an org-wide oversight surface.
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">Reimbursement oversight is restricted to administrators.</p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const rows = await prisma.reimbursementRequest.findMany({
    select: {
      id: true,
      status: true,
      amount_cents: true,
      expense_date: true,
      category: true,
      purpose: true,
      submitted_at: true,
      second_approved_at: true,
      sent_to_accounting_at: true,
      escalated_at: true,
      decision_note: true,
      employee_name_freeform: true,
      employee_user: { select: { name: true } },
      submitter: { select: { name: true } },
      second_approver: { select: { name: true } },
      routed_to: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
    orderBy: { submitted_at: 'desc' },
    take: 500,
  });

  const pending = rows.filter((r) => r.status === 'pending_second_approval');
  const paidCents = rows
    .filter((r) => r.status === 'approved')
    .reduce((a, r) => a + r.amount_cents, 0);
  // "Approved but accounting was never told" is the one number that means money is
  // owed and nobody is acting on it. `sent_to_accounting_at` records that Mary was
  // REALLY told, not that a send was attempted (Amendment 1).
  const approvedUnsent = rows.filter(
    (r) => r.status === 'approved' && r.sent_to_accounting_at === null,
  );

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link href="/admin" className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist">
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Employee reimbursements</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          Every reimbursement carries two signatures from two different people, at every amount. The
          submitter cannot approve their own, and neither can the person being paid. This view is
          read-only — decisions are made on the site surface, where the authorisation check that
          governs them lives.
        </p>

        {/* ── Scorecard ─────────────────────────────────────────────────── */}
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Awaiting a signature"
            value={String(pending.length)}
            tone={pending.length > 0 ? 'warn' : 'ok'}
          />
          <Stat label="Approved (all time)" value={usd(paidCents)} tone="neutral" />
          <Stat
            label="Approved, accounting not told"
            value={String(approvedUnsent.length)}
            tone={approvedUnsent.length > 0 ? 'alert' : 'ok'}
          />
          <Stat label="Total on record" value={String(rows.length)} tone="neutral" />
        </div>

        {approvedUnsent.length > 0 && (
          <p
            className="mt-4 rounded-md bg-rose-500/15 px-4 py-3 text-sm text-rose-200 ring-1 ring-rose-500/30"
            data-testid="admin-reimb-unsent-warning"
          >
            <strong>{approvedUnsent.length}</strong> approved reimbursement
            {approvedUnsent.length === 1 ? ' has' : 's have'} no record of reaching accounting.
            Somebody is owed money and Mary may never have been told. Check the mail transport
            before assuming these were paid.
          </p>
        )}

        {/* ── The list ──────────────────────────────────────────────────── */}
        <div className="mt-6 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
              <tr>
                <th className="px-3 py-2">Employee</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2">What for</th>
                <th className="px-3 py-2">Submitted</th>
                <th className="px-3 py-2">Second signature</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-dr3-mist-dim">
                    Nothing has been submitted yet.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const status = r.status as Status;
                return (
                  <tr
                    key={r.id}
                    className="border-t border-dr3-steel-light/15 align-top"
                    data-testid="admin-reimb-row"
                  >
                    <td className="px-3 py-2 font-medium">
                      {r.employee_user?.name ?? r.employee_name_freeform ?? '(unnamed)'}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{usd(r.amount_cents)}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/${r.site.code}/reimbursements`}
                        className="text-dr3-cyan underline-offset-2 hover:underline"
                      >
                        {r.site.name}
                      </Link>
                    </td>
                    <td className="max-w-[22ch] px-3 py-2 text-dr3-mist-dim">
                      {r.category} · {r.purpose}
                    </td>
                    <td className="px-3 py-2 text-xs text-dr3-mist-dim">
                      {r.submitter.name}
                      <br />
                      {pacific(r.submitted_at)}
                    </td>
                    <td className="px-3 py-2 text-xs text-dr3-mist-dim">
                      {r.second_approver ? (
                        <>
                          {r.second_approver.name}
                          <br />
                          {pacific(r.second_approved_at)}
                        </>
                      ) : (
                        <>
                          waiting on {r.routed_to.name}
                          {r.escalated_at && (
                            <>
                              <br />
                              <span className="text-amber-300">escalated</span>
                            </>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${STATUS_STYLE[status]}`}
                      >
                        {STATUS_LABEL[status]}
                      </span>
                      {r.status === 'approved' && r.sent_to_accounting_at === null && (
                        <span className="mt-1 block text-xs text-rose-300">
                          accounting NOT told
                        </span>
                      )}
                      {r.decision_note && (
                        <span className="mt-1 block max-w-[24ch] text-xs text-dr3-mist-dim">
                          “{r.decision_note}”
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'alert' | 'neutral';
}) {
  const toneCls =
    tone === 'alert'
      ? 'text-rose-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'ok'
          ? 'text-emerald-300'
          : 'text-dr3-mist';
  return (
    <div className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20">
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}
