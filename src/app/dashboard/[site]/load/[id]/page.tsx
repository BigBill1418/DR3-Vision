import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { formatDate, formatTime } from '@/lib/format';
import { ElapsedTime } from '../../elapsed-time';
import { stageLabelForCurrentLocale } from './stage-label-server';

// Manager view of a single inbound load per SPRINT-1-PLAN T-010
// ("Tap a tile → load detail page with all photos, stack counts,
// concerns"). Read-only for T-010 — reassign + override actions land
// in T-011 / T-012. Per CLAUDE.md hard rule #2 every Prisma read scopes
// by `site_id`; per ADR-0014 manager working surfaces stay green.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string; id: string }> };

function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

// `LoadPhoto.storage_key` may be a `pending-r2-…` placeholder until
// T-007's R2 wiring fills in real keys (and even after T-007 ships, a
// load created against unset R2 envs still emits the placeholder per
// the CHANGELOG's fallback). Don't try to render bytes here; T-011+
// adds the presigned-GET preview surface.
function isPendingR2(key: string): boolean {
  return key.startsWith('pending-r2-');
}

function photoCaption(key: string): string {
  return isPendingR2(key) ? '(upload deferred)' : key;
}

export default async function ManagerLoadDetailPage({ params }: Props) {
  const { site: siteCode, id: loadId } = await params;
  const session = await auth();
  if (!session?.user) redirect('/login');

  // Same site-scoping check as the dock view, including the verbatim
  // 403 page for off-site managers.
  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();

  const isAdmin = session.user.role === 'admin';
  // ADR-0024: an all-sites manager reaches every site.
  const isAssigned = session.user.primary_site_id === site.id || session.user.all_sites === true;
  if (!isAdmin && !isAssigned) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">403 — not authorized for this site</h1>
        <p className="mt-2 text-dr3-mist-dim">You don&apos;t have access to {site.name}.</p>
        <Link
          href="/dashboard"
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          Back to your sites
        </Link>
      </main>
    );
  }

  const load = await prisma.inboundLoad.findFirst({
    // findFirst + the explicit site_id constraint enforces per-site
    // separation even if a manager guesses an off-site load UUID.
    where: { id: loadId, site_id: site.id },
    select: {
      id: true,
      bol_number: true,
      status: true,
      arrived_at: true,
      unload_started_at: true,
      unload_finished_at: true,
      submitted_at: true,
      total_units: true,
      count_mode: true,
      weight_lbs: true,
      time_to_unload_start_seconds: true,
      unload_duration_seconds: true,
      rejection_category: true,
      rejection_note: true,
      source: { select: { name: true } },
      transporter: { select: { name: true } },
      assigned_operator: { select: { name: true } },
      load_stacks: {
        // ADR-0090 Am.1 B — a stack the floor took back is still a row. Selected
        // so this page can mark it, because `total_units` beside it already
        // excludes it: without the flag a manager reconciling a load reads
        // "Stack 2 — 9 units" against a total that does not contain those nine,
        // and the page contradicts itself with no explanation.
        select: {
          id: true,
          stack_index: true,
          unit_count: true,
          count_mode: true,
          voided_at: true,
        },
        orderBy: { stack_index: 'asc' },
      },
      load_photos: {
        select: { id: true, kind: true, storage_key: true, captured_at: true },
        orderBy: { captured_at: 'asc' },
      },
      load_concerns: {
        select: {
          id: true,
          category: true,
          note: true,
          created_at: true,
          raised_by_user_id: true,
        },
        orderBy: { created_at: 'asc' },
      },
    },
  });
  if (!load) notFound();

  const audit = await prisma.auditLog.findMany({
    where: { table_name: 'inbound_loads', row_id: load.id },
    select: {
      id: true,
      actor_label: true,
      actor_user_id: true,
      action: true,
      before: true,
      after: true,
      created_at: true,
      actor: { select: { name: true } },
    },
    orderBy: { created_at: 'desc' },
    take: 10,
  });

  // The dock-view "Elapsed" reads "in flight". On the detail page,
  // active loads still tick; submitted/finished loads show the
  // captured duration.
  const isActive = load.submitted_at == null && load.unload_finished_at == null;
  const stageLabelText = await stageLabelForCurrentLocale(load.status);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <Link
          href={`/dashboard/${site.code}`}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          ← {site.name} dock
        </Link>

        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">
            BOL <span className="font-mono">{load.bol_number ?? '—'}</span>
          </h1>
          <p className="text-sm text-dr3-mist-dim">
            {load.source?.name ?? 'Unknown source'} · {load.transporter?.name ?? 'Unknown carrier'}
          </p>
          <p className="text-sm text-dr3-mist-dim">
            Operator: {load.assigned_operator?.name ?? 'Unassigned'}
          </p>
        </header>

        <section className="flex flex-col gap-2 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm uppercase tracking-wide text-dr3-mist-dim">Status</span>
            <span className="rounded-full bg-dr3-cyan/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-dr3-cyan ring-1 ring-dr3-cyan/30">
              {stageLabelText}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-dr3-mist-dim">Arrived</dt>
            <dd className="text-right">
              {load.arrived_at
                ? `${formatDate(load.arrived_at)} ${formatTime(load.arrived_at)}`
                : '—'}
            </dd>
            <dt className="text-dr3-mist-dim">{isActive ? 'Elapsed' : 'Unload duration'}</dt>
            <dd className="text-right">
              {isActive && load.arrived_at ? (
                <ElapsedTime since={load.arrived_at.toISOString()} />
              ) : load.unload_duration_seconds != null ? (
                <span className="font-mono tabular-nums">
                  {formatDuration(load.unload_duration_seconds)}
                </span>
              ) : (
                '—'
              )}
            </dd>
            {load.weight_lbs != null && (
              <>
                <dt className="text-dr3-mist-dim">Weight</dt>
                <dd className="text-right tabular-nums">{load.weight_lbs.toLocaleString()} lbs</dd>
              </>
            )}
            {load.total_units != null && (
              <>
                <dt className="text-dr3-mist-dim">Total units</dt>
                <dd className="text-right tabular-nums">
                  {load.total_units}
                  {load.count_mode != null && (
                    <span className="ml-2 text-xs text-dr3-mist-dim">({load.count_mode})</span>
                  )}
                </dd>
              </>
            )}
            {load.rejection_category != null && (
              <>
                <dt className="text-dr3-mist-dim">Rejection</dt>
                <dd className="text-right">{load.rejection_category}</dd>
                {load.rejection_note && (
                  <>
                    <dt className="text-dr3-mist-dim">Note</dt>
                    <dd className="col-span-1 text-right">{load.rejection_note}</dd>
                  </>
                )}
              </>
            )}
          </dl>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            Photos <span className="text-sm text-dr3-mist-dim">({load.load_photos.length})</span>
          </h2>
          {load.load_photos.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">No photos captured yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {load.load_photos.map((p) => (
                <li
                  key={p.id}
                  className="flex items-baseline justify-between gap-3 rounded-md border border-dr3-steel-light/20 bg-dr3-space-2 px-3 py-2 text-sm"
                >
                  <span className="font-medium capitalize">{p.kind.replace('_', ' ')}</span>
                  <span
                    className="ml-3 max-w-[60%] truncate text-right font-mono text-xs text-dr3-mist-dim"
                    title={p.storage_key}
                  >
                    {photoCaption(p.storage_key)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          {/* ADR-0090 Am.1 B — the count is the LIVE stacks. A voided stack stays
              listed (soft void, never a delete — it is the evidence the operator
              counted it) but is struck through and excluded from the heading, so
              this section agrees with `total_units` above it. */}
          <h2 className="text-lg font-semibold">
            Stacks{' '}
            <span className="text-sm text-dr3-mist-dim">
              ({load.load_stacks.filter((s) => s.voided_at === null).length})
            </span>
          </h2>
          {load.load_stacks.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">No stacks counted yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {load.load_stacks.map((s) => (
                <li
                  key={s.id}
                  data-voided={String(s.voided_at !== null)}
                  className={`flex items-baseline justify-between rounded-md border border-dr3-steel-light/20 bg-dr3-space-2 px-3 py-2 text-sm ${
                    s.voided_at === null ? '' : 'text-dr3-mist-dim line-through'
                  }`}
                >
                  <span>Stack {s.stack_index}</span>
                  <span className="tabular-nums">
                    {s.unit_count} units{' '}
                    <span className="text-xs text-dr3-mist-dim">({s.count_mode})</span>
                    {s.voided_at !== null && (
                      <span className="ml-2 text-xs uppercase no-underline">voided</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            Concerns{' '}
            <span className="text-sm text-dr3-mist-dim">({load.load_concerns.length})</span>
          </h2>
          {load.load_concerns.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">No concerns raised.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {load.load_concerns.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md border border-dr3-steel-light/20 bg-dr3-space-2 px-3 py-2 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium capitalize">{c.category}</span>
                    <span className="text-xs text-dr3-mist-dim">
                      raised by {c.raised_by_user_id ?? 'unknown'}
                    </span>
                  </div>
                  {c.note && <p className="mt-1 text-dr3-mist-dim">{c.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            Audit <span className="text-sm text-dr3-mist-dim">(last {audit.length})</span>
          </h2>
          {audit.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">No audit entries.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {audit.map((a) => {
                const before = (a.before ?? null) as { status?: string } | null;
                const after = (a.after ?? null) as { status?: string } | null;
                const fromStatus = before?.status;
                const toStatus = after?.status;
                const actor = a.actor_label ?? a.actor?.name ?? a.actor_user_id ?? 'system';
                return (
                  <li
                    key={a.id}
                    className="flex items-baseline justify-between gap-3 rounded-md border border-dr3-steel-light/20 bg-dr3-space-2 px-3 py-2 text-xs"
                  >
                    <span>
                      <span className="font-mono text-dr3-mist-dim">{a.action}</span>{' '}
                      <span className="text-dr3-mist-dim">{actor}</span>
                      {fromStatus && toStatus && (
                        <span className="ml-2 text-dr3-mist-dim">
                          {fromStatus} → {toStatus}
                        </span>
                      )}
                      {!fromStatus && toStatus && (
                        <span className="ml-2 text-dr3-mist-dim">{toStatus}</span>
                      )}
                    </span>
                    <span className="font-mono text-dr3-mist-dim">
                      {formatTime(a.created_at)} · {formatDate(a.created_at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
