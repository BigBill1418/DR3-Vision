// Sprint-1 T-016 — manager monthly reconciliation upload landing.
//
// Lists prior reconciliation sessions for the site and renders the
// upload widget. Clicking a session row routes to
// /dashboard/{site}/reconciliation/{id} where the per-row engine
// table + resolution actions live.
//
// Per-site separation: the page calls `checkManagerForSite` so a
// manager scoped to Eugene who navigates to
// /dashboard/woodland/reconciliation gets a 403 surface, not data.
// Admin sees both sites because the dashboard root lets them pick
// either site context.

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { UploadClient } from './UploadClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function ReconciliationLandingPage({ params }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkManagerForSite(siteCode);
  if (!gate.ok) {
    if (gate.status === 401) redirect(`/login?next=/dashboard/${siteCode}/reconciliation`);
    if (gate.status === 404) notFound();
    return <ForbiddenSurface siteCode={siteCode} />;
  }

  const sessions = await prisma.mymrcReconciliation.findMany({
    where: { site_id: gate.ctx.siteId },
    select: {
      id: true,
      filename: true,
      uploaded_at: true,
      period_start: true,
      period_end: true,
      total_rows: true,
      match_clean_count: true,
      weight_mismatch_count: true,
      count_mismatch_count: true,
      missing_in_dr3_count: true,
      missing_in_mymrc_count: true,
      resolved_count: true,
    },
    orderBy: { uploaded_at: 'desc' },
    take: 20,
  });

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-8 text-dr3-cream">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <Link
          href={`/dashboard/${siteCode}`}
          className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          data-testid="reconciliation-back-link"
        >
          ← {gate.ctx.siteName} dock
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">MyMRC reconciliation</h1>
          <p className="text-sm text-dr3-cream/70">
            {gate.ctx.siteName} — upload the monthly MyMRC CSV to reconcile against DR3-Vision
            loads.
          </p>
        </header>

        <UploadClient siteCode={siteCode} />

        <section className="flex flex-col gap-3" data-testid="reconciliation-history">
          <h2 className="text-xl font-semibold">Prior uploads</h2>
          {sessions.length === 0 ? (
            <p className="rounded-md bg-dr3-green-dark/30 px-4 py-3 text-sm text-dr3-cream/70">
              No uploads yet for {gate.ctx.siteName}. Upload the first monthly MyMRC CSV above.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/${siteCode}/reconciliation/${s.id}`}
                    className="block rounded-md bg-dr3-green-dark/40 px-4 py-3 transition-colors hover:bg-dr3-green-dark/70"
                    data-testid={`reconciliation-session-${s.id}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <code className="break-all text-sm font-medium text-dr3-cream">
                        {s.filename}
                      </code>
                      <span className="text-xs text-dr3-cream/70">
                        {new Date(s.uploaded_at).toISOString().slice(0, 10)} ·{' '}
                        {fmtDate(s.period_start)}–{fmtDate(s.period_end)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-dr3-cream/80">
                      <span>{s.total_rows} rows</span>
                      <span className="text-emerald-300">{s.match_clean_count} clean</span>
                      <span className="text-amber-300">{s.weight_mismatch_count} weight</span>
                      <span className="text-amber-300">{s.count_mismatch_count} count</span>
                      <span className="text-rose-300">
                        {s.missing_in_dr3_count} missing-in-dr3
                      </span>
                      <span className="text-rose-300">
                        {s.missing_in_mymrc_count} missing-in-mymrc
                      </span>
                      <span className="text-dr3-cream/60">{s.resolved_count} resolved</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function ForbiddenSurface({ siteCode }: { siteCode: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
      <h1 className="text-2xl font-semibold">403 — not authorized for this site</h1>
      <p className="mt-2 text-dr3-cream/70">
        You don&apos;t have access to reconcile {siteCode} data.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 text-sm text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
      >
        Back to your sites
      </Link>
    </main>
  );
}

function fmtDate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}
