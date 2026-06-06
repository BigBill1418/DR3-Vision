// ADR-0019 §5 — Monthly bonus detail + signature capture page (T-110, server
// component).
//
// Gated via `checkBonusAccess()` (Woodland-scoped): 401 → /login, 403 → in-place
// forbidden surface (Rick / operators). The month is loaded scoped to the
// caller's Woodland site so a forged/cross-site id 404s (CLAUDE.md hard rule #2).
//
// Shows the period, state, and per-employee monthly totals (computed through
// @/lib/bonus/calculator with the active rule — NEVER hardcoded, hard rule #3).
// When the month is `pending_signatures` or `partially_signed`, the client
// SignaturePanel renders the appropriate signature button; once a slot is signed
// the signer name/role/timestamp is shown and the button is hidden.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { checkBonusAccess } from '@/lib/bonus/access';
import { prisma } from '@/lib/prisma';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';
import { calculateDailyBonusCents, formatCents } from '@/lib/bonus/calculator';
import { naturalSlotFor } from '@/lib/bonus/signatures';
import { SignaturePanel, type SignerSlot } from './SignaturePanel';

export const dynamic = 'force-dynamic';

const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_signatures: 'Pending signatures',
  partially_signed: 'Partially signed',
  signed: 'Signed',
  paid: 'Paid',
  amended: 'Amended',
};

function monthLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

/** Render a signature timestamp in Pacific (operator's wall clock). */
function signedAtLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Los_Angeles',
  }).format(d);
}

interface EmployeeTotal {
  name: string;
  totalMattresses: number;
  totalBonusCents: number;
}

export default async function BonusMonthDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await checkBonusAccess();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/bonus');
    return <ForbiddenPage />;
  }
  const ctx = gate.ctx;
  const { id } = await params;

  const month = await prisma.bonusMonth.findFirst({
    where: { id, site_id: ctx.siteId },
    include: {
      janette_signed_by: { select: { name: true } },
      morena_signed_by: { select: { name: true } },
      daily_entries: { select: { bonus_employee_id: true, mattress_count: true } },
    },
  });
  if (!month) notFound();

  const rule = await resolveActiveRule(ctx.siteId, month.month_start);

  const employeeIds = [...new Set(month.daily_entries.map((e) => e.bonus_employee_id))];
  const employees = await prisma.bonusEmployee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, full_name: true },
  });
  const nameById = new Map(employees.map((e) => [e.id, e.full_name]));

  const byEmployee = new Map<string, EmployeeTotal>();
  for (const e of month.daily_entries) {
    const acc = byEmployee.get(e.bonus_employee_id) ?? {
      name: nameById.get(e.bonus_employee_id) ?? e.bonus_employee_id,
      totalMattresses: 0,
      totalBonusCents: 0,
    };
    acc.totalMattresses += e.mattress_count;
    acc.totalBonusCents += calculateDailyBonusCents(e.mattress_count, rule);
    byEmployee.set(e.bonus_employee_id, acc);
  }
  const rows = [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name));
  const grandTotalCents = rows.reduce((s, r) => s + r.totalBonusCents, 0);

  const inSignatureState =
    month.state === 'pending_signatures' || month.state === 'partially_signed';
  const viewerSlot: SignerSlot = naturalSlotFor({
    userId: ctx.userId,
    role: ctx.role,
    primarySiteId: ctx.primarySiteId,
    siteId: ctx.siteId,
  });

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-12 text-dr3-cream">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/bonus"
            className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          >
            ← Back to bonus entry
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">
            {monthLabel(month.month_start)} bonus
          </h1>
          <p className="text-sm text-dr3-cream/70">
            {ctx.siteName} ·{' '}
            <span className="font-medium text-dr3-cream">
              {STATE_LABEL[month.state] ?? month.state}
            </span>
          </p>
        </header>

        {/* Per-employee totals */}
        <section className="rounded-lg bg-dr3-green-dark/40 p-5">
          <h2 className="mb-3 text-lg font-semibold">Monthly totals</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-dr3-cream/70">No mattress counts were keyed this month.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dr3-cream/20 text-left text-dr3-cream/70">
                  <th className="pb-2 font-medium">Processor</th>
                  <th className="pb-2 text-right font-medium">Mattresses</th>
                  <th className="pb-2 text-right font-medium">Bonus</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name} className="border-b border-dr3-cream/10">
                    <td className="py-2">{r.name}</td>
                    <td className="py-2 text-right tabular-nums">{r.totalMattresses}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatCents(r.totalBonusCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="pt-3">Total payout</td>
                  <td className="pt-3" />
                  <td className="pt-3 text-right tabular-nums">{formatCents(grandTotalCents)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>

        {/* Signatures */}
        <section className="rounded-lg bg-dr3-green-dark/40 p-5">
          <h2 className="mb-4 text-lg font-semibold">Signatures</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <SignatureSlotCard
              role="Facility Manager"
              assigned="Janette Thomas"
              signerName={month.janette_signed_by?.name ?? null}
              signedAt={month.janette_signed_at}
            />
            <SignatureSlotCard
              role="Operations Manager"
              assigned="Morena Gomez"
              signerName={month.morena_signed_by?.name ?? null}
              signedAt={month.morena_signed_at}
            />
          </div>

          {inSignatureState && (
            <div className="mt-5 border-t border-dr3-cream/15 pt-5">
              <SignaturePanel
                monthId={month.id}
                viewerSlot={viewerSlot}
                janetteSigned={month.janette_signed_by_user_id !== null}
                morenaSigned={month.morena_signed_by_user_id !== null}
              />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function SignatureSlotCard({
  role,
  assigned,
  signerName,
  signedAt,
}: {
  role: string;
  assigned: string;
  signerName: string | null;
  signedAt: Date | null;
}) {
  const signed = signerName !== null && signedAt !== null;
  return (
    <div className="rounded-md border border-dr3-cream/15 p-4">
      <p className="text-xs uppercase tracking-wide text-dr3-cream/60">{role}</p>
      <p className="mt-1 font-medium">{assigned}</p>
      {signed ? (
        <p className="mt-2 text-sm text-dr3-chartreuse">
          Signed by {signerName} · {signedAtLabel(signedAt!)}
        </p>
      ) : (
        <p className="mt-2 text-sm text-dr3-cream/60">Awaiting signature</p>
      )}
    </div>
  );
}

function ForbiddenPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
      <h1 className="text-2xl font-bold">Access restricted</h1>
      <p className="mt-2 max-w-md text-sm text-dr3-cream/70">
        Bonus management is limited to Woodland managers and administrators.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
