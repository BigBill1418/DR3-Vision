import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { LoadWorkflow } from './load-workflow';
import { HeldByPanel } from './held-by-panel';
import { HOME_ROUTE } from '@/lib/routes';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { TAKEOVER_STATUSES } from '@/lib/loads/load-claim';
import { HAUL_NUMBER_SELECT, haulNumberOf } from '@/lib/loads/haul-number';
import { FloorPageHeading } from '../../../_components/page-heading';

// Workflow shell. The whole 7-stage flow lives in the
// `LoadWorkflow` client component and dispatches by `load.status`.
// Server-side this page just hydrates the load + the operator's
// session, then hands off.
//
// ADR-0065 Amendment 1 (2026-07-30) — THIS PAGE IS NOW ROLLOUT-GATED on
// `ipad_queue`. ADR-0065 D1 claimed the surface governed "/queue + /load/[id] +
// the dock server actions", but only the actions and the hub card read it. With
// `ipad_queue` at `pilot` this page still rendered all 7 stages, and every stage
// button then threw an ungated `LoadsInventoryNotActivatedError` from
// `../../actions.ts`. There is no operator-scoped error boundary below
// `src/app/operator/` (added in the same amendment), so the operator landed on the
// black English "Something went wrong" page with no back and no Log Out — the exact
// dead end ADR-0065 said it had avoided.
//
// The gate is checked BEFORE the load is fetched: a gated-off surface should not
// read the row at all, and should never `notFound()` (a 404 is indistinguishable
// from "your load is gone", which is alarming rather than informative).

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string; id: string }> };

export default async function LoadPage({ params }: Props) {
  const { site: siteCode, id: loadId } = await params;
  const session = await auth();
  // `?.id`, not `?.user` (2026-08-10). An expired operator session is a HUSK —
  // a truthy `user` carrying no id and no role (see `src/lib/session-husk.test.ts`).
  // The bare check waved it through to the role line below, which sent an idled-out
  // floor operator to HOME_ROUTE and from there to the MANAGER sign-in page. The
  // PIN screen is the only sign-in a person on a forklift can complete.
  if (!session?.user?.id) redirect(`/operator/${siteCode}`);
  if (session.user.role !== 'operator') redirect(HOME_ROUTE);

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();
  if (session.user.primary_site_id !== site.id) redirect('/operator');

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  // Fail-safe: pilot / unregistered / read-error ⇒ not activated.
  if (!(await isUiSurfaceLive(UI_SURFACE.IPAD_QUEUE, site.id))) {
    return (
      <main className="px-6 pb-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
          <FloorPageHeading title={t('queue.heading')} />
          <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: site.name })}
            </p>
          </div>
        </div>
      </main>
    );
  }

  const load = await prisma.inboundLoad.findUnique({
    where: { id: loadId },
    select: {
      id: true,
      site_id: true,
      status: true,
      bol_number: true,
      arrived_at: true,
      unload_started_at: true,
      unload_finished_at: true,
      total_units: true,
      // ADR-0090 Am.1 B — the review panel reads both. JT asked to "go back to
      // fix or CHECK what you entered", and neither the weight nor which photos
      // exist was on any operator screen after its own stage had passed.
      weight_lbs: true,
      load_photos: { select: { kind: true } },
      assigned_operator_id: true,
      assigned_at: true,
      load_source_type: true,
      assigned_operator: { select: { id: true, name: true } },
      source: { select: { name: true } },
      transporter: { select: { name: true } },
      // ADR-0090 A — the haul number, for the header and the held-by panel.
      ...HAUL_NUMBER_SELECT,
      load_stacks: {
        // ADR-0090 Am.1 B — voided stacks are SELECTED, not filtered out. They
        // are struck through and excluded from the running total, and the next
        // stack index is computed over them so an index is never reused. A
        // `where` here would break the monotonic index the `addStack` 409 guard
        // depends on, and would hide the row that explains the total.
        select: {
          id: true,
          stack_index: true,
          unit_count: true,
          count_mode: true,
          voided_at: true,
        },
        orderBy: { stack_index: 'asc' },
      },
    },
  });
  if (!load || load.site_id !== site.id) notFound();

  // ── ADR-0082 — the silent redirect loop, and why it is gone ────────────────
  //
  // This branch used to be `redirect('/operator/<site>/queue')` with the comment
  // "T-010 portal lets a manager reassign it; from the iPad we just bounce back
  // to the queue." What that produced on the floor was a DEAD LOOP with no
  // message anywhere in it: the second operator taps the load, lands on the
  // queue, taps the load, lands on the queue. Nothing failed, nothing said the
  // load was held, and the holder's name appeared on no screen — so the only way
  // to learn what was happening was to ask the room. JT's lunch case looped
  // forever.
  //
  // Now it renders WHO holds it and offers Take over. The read above is
  // deliberately unchanged in scope — a load at another SITE is still `notFound`
  // (CLAUDE.md hard rule #2), because that is not a load this operator may know
  // about, let alone take.
  const haulNumber = haulNumberOf(load);
  const heldByOther = load.assigned_operator_id !== session.user.id;
  if (heldByOther) {
    return (
      <main className="px-6 pb-6">
        <div className="mx-auto max-w-2xl pt-6">
          <HeldByPanel
            siteCode={site.code}
            loadId={load.id}
            holderName={load.assigned_operator?.name ?? null}
            heldSince={load.assigned_at?.toISOString() ?? null}
            sourceName={load.source?.name ?? null}
            transporterName={load.transporter?.name ?? null}
            bolNumber={load.bol_number}
            haulNumber={haulNumber}
            status={load.status}
            totalUnits={load.total_units}
            // A load outside the open-dock set, or an aggregate bridge row, has
            // no claim to hand on — the service refuses both. Deciding it here
            // as well means the button is not offered for a write that would be
            // refused: an operator should never be shown a control whose only
            // outcome is an error.
            takeable={
              load.load_source_type === 'b2b_haul' && TAKEOVER_STATUSES.includes(load.status)
            }
            locale={locale}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="px-6 pb-6">
      <div className="mx-auto max-w-2xl pt-6">
        <header className="mb-4">
          {/* ADR-0090 A — the haul number above the source, so an operator who
              suspects they tapped the wrong truck can confirm it without leaving
              the workflow. Bare mono, matching the hauls screen. */}
          {haulNumber && (
            <p className="font-mono text-sm font-bold tracking-wide text-dr3-cream/80">
              {haulNumber}
            </p>
          )}
          <h1 className="text-xl font-semibold">
            {load.source?.name ?? t('load_header.unknown_source')}
          </h1>
          <p className="text-sm text-dr3-cream/70">
            {load.transporter?.name ?? t('load_header.unknown_carrier')} ·{' '}
            {t('load_header.bol_label')}{' '}
            <span className="font-mono">{load.bol_number ?? t('load_header.bol_dash')}</span>
          </p>
        </header>
        <LoadWorkflow
          siteCode={site.code}
          load={{
            id: load.id,
            status: load.status,
            unload_started_at: load.unload_started_at?.toISOString() ?? null,
            total_units: load.total_units,
            weight_lbs: load.weight_lbs,
            // Deduped: several rows of one kind (a retaken photo) is one answer
            // to "was the BOL captured".
            photo_kinds: [...new Set(load.load_photos.map((p) => p.kind))],
            stacks: load.load_stacks.map((s) => ({
              ...s,
              voided_at: s.voided_at?.toISOString() ?? null,
            })),
          }}
          operatorName={session.user.name}
        />
      </div>
    </main>
  );
}
