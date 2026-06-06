// Sprint-1 T-016 — per-session reconciliation table.
//
// Server component: hydrates the upload metadata + every item, then
// hands them to a client component that renders the categorized
// table with per-row resolution actions.
//
// Per-site separation: re-checks the session belongs to the URL's
// site so a stitched-together URL
// (/dashboard/eugene/reconciliation/<woodland-id>) 404s instead of
// leaking. The route layer also enforces this on any resolution POST.

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import { ReconciliationTable, type SerializableItem } from './ReconciliationTable';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string; id: string }> };

export default async function ReconciliationSessionPage({ params }: Props) {
  const { site: siteCode, id } = await params;
  const gate = await checkManagerForSite(siteCode);
  if (!gate.ok) {
    if (gate.status === 401) {
      redirect(`/login?next=/dashboard/${siteCode}/reconciliation/${id}`);
    }
    if (gate.status === 404) notFound();
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">403 — not authorized for this site</h1>
        <Link
          href="/dashboard"
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          Back to your sites
        </Link>
      </main>
    );
  }

  const session = await prisma.mymrcReconciliation.findUnique({
    where: { id },
    select: {
      id: true,
      site_id: true,
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
      weight_tolerance_pct: true,
      content_sha256: true,
    },
  });
  if (!session) notFound();
  if (session.site_id !== gate.ctx.siteId) notFound();

  const items = await prisma.mymrcReconciliationItem.findMany({
    where: { reconciliation_id: id },
    select: {
      id: true,
      external_haul_id: true,
      external_delivery_date: true,
      external_source_name: true,
      external_unit_count: true,
      external_weight_lbs: true,
      matched_load_id: true,
      dr3_unit_count: true,
      dr3_weight_lbs: true,
      status: true,
      resolution: true,
      resolution_notes: true,
      resolved_at: true,
    },
    orderBy: [{ status: 'asc' }, { external_haul_id: 'asc' }],
  });

  const serializable: SerializableItem[] = items.map((it) => ({
    id: it.id,
    external_haul_id: it.external_haul_id,
    external_delivery_date: it.external_delivery_date
      ? it.external_delivery_date.toISOString().slice(0, 10)
      : null,
    external_source_name: it.external_source_name,
    external_unit_count: it.external_unit_count,
    external_weight_lbs: it.external_weight_lbs,
    matched_load_id: it.matched_load_id,
    dr3_unit_count: it.dr3_unit_count,
    dr3_weight_lbs: it.dr3_weight_lbs,
    status: it.status,
    resolution: it.resolution,
    resolution_notes: it.resolution_notes,
    resolved_at: it.resolved_at ? it.resolved_at.toISOString() : null,
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Link
          href={`/dashboard/${siteCode}/reconciliation`}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          data-testid="reconciliation-session-back"
        >
          ← All uploads
        </Link>

        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">{session.filename}</h1>
          <p className="text-sm text-dr3-mist-dim">
            {gate.ctx.siteName} — uploaded{' '}
            {new Date(session.uploaded_at).toISOString().slice(0, 16).replace('T', ' ')} UTC ·
            period {fmtDate(session.period_start)} → {fmtDate(session.period_end)} · tolerance ±
            {session.weight_tolerance_pct.toString()}%
          </p>
          <code className="break-all text-[10px] text-dr3-mist-dim/70" title="content sha256">
            sha256:{session.content_sha256}
          </code>
        </header>

        <SummaryBanner
          total={session.total_rows}
          matchClean={session.match_clean_count}
          weightMismatch={session.weight_mismatch_count}
          countMismatch={session.count_mismatch_count}
          missingInDr3={session.missing_in_dr3_count}
          missingInMymrc={session.missing_in_mymrc_count}
          resolved={session.resolved_count}
        />

        <ReconciliationTable siteCode={siteCode} items={serializable} />
      </div>
    </main>
  );
}

function SummaryBanner(props: {
  total: number;
  matchClean: number;
  weightMismatch: number;
  countMismatch: number;
  missingInDr3: number;
  missingInMymrc: number;
  resolved: number;
}) {
  const cleanPct = props.total > 0 ? ((props.matchClean / props.total) * 100).toFixed(1) : '0';
  return (
    <section
      className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7"
      data-testid="reconciliation-summary"
    >
      <Tile label="Total rows" value={props.total} />
      <Tile label="Clean" value={props.matchClean} sub={`${cleanPct}%`} tone="ok" />
      <Tile label="Weight mismatch" value={props.weightMismatch} tone="warn" />
      <Tile label="Count mismatch" value={props.countMismatch} tone="warn" />
      <Tile label="Missing in DR3" value={props.missingInDr3} tone="bad" />
      <Tile label="Missing in MyMRC" value={props.missingInMymrc} tone="bad" />
      <Tile label="Resolved" value={props.resolved} />
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: 'ok' | 'warn' | 'bad' | 'neutral';
}) {
  const toneClass =
    tone === 'ok'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'bad'
          ? 'text-rose-300'
          : 'text-dr3-mist';
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-dr3-steel-light/20 bg-dr3-space-2 px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-dr3-mist-dim">{label}</span>
      <span className={`text-2xl font-semibold ${toneClass}`}>{value}</span>
      {sub ? <span className="text-[10px] text-dr3-mist-dim">{sub}</span> : null}
    </div>
  );
}

function fmtDate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}
