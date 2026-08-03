import { redirect } from 'next/navigation';
import { checkOperatorForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { listPortalHauls, type PortalHaulRow } from '@/lib/loads/portal-hauls';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { FloorPageHeading } from '../../_components/page-heading';
import { HaulsClient, type HaulRowView } from './hauls-client';
import { HaulsPagination } from './pagination';
import { pickHaulsListParams, type HaulsListSearchParams } from './list-url';

// ADR-0074 — EVERY portal haul, searchable, newest first.
//
// Bill's directive (2026-08-03): "on-site iPad operators must be able to see any
// pending haul or load from the MyMRC portal." Until this screen, the iPad's only
// window onto MyMRC was `/queue` — `expected_loads`, bounded to the current
// Pacific day. Measured on production 2026-08-03 13:17 PT that was 5 rows out of
// a 7,285-row mirror: 0.07%.
//
// This PARTIALLY SUPERSEDES ADR-0065 D5, and only its READ half. Bill's earlier
// words — "vision on the ipad is only going to show hauls from the current day …
// no historical or future views" — were about the ACTIONABLE QUEUE: an operator
// must not page back through past production days and confirm counts against
// them. Every one of those write guards stands untouched (`assertCurrentPacificDay`,
// the ADR-0060 D5 `per_load_exists` refusal, the partial unique index, the
// day-scoped inbound API). What changes is that LOOKING is no longer rationed.
// This screen writes nothing.
//
// Gated on its OWN `ipad_hauls` surface (ADR-0047 #3 — born pilot), so Bill ramps
// it per site from /admin/rollout with no deploy, and turning it off cannot touch
// the queue, the inbound confirm screen, or the manager desktop. Gated-off
// degrades to the already-translated "not turned on yet" block below a rendered
// heading — never a 404, never a throw, never a dead end (ADR-0065's rule).
//
// Auth is `checkOperatorForSite`: the site id is derived SERVER-SIDE from the
// session, never from the `[site]` path segment a client controls. ADR-0030
// single-site operators only — there is no `all_sites` path on the floor.

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<HaulsListSearchParams>;
};

function toView(r: PortalHaulRow): HaulRowView {
  return {
    id: r.id,
    externalHaulId: r.externalHaulId,
    status: r.status,
    type: r.type,
    transporterName: r.transporterName,
    collectionSite: r.collectionSite,
    collectionSource: r.collectionSource,
    dockingDateISO: r.dockingDate ? r.dockingDate.toISOString() : null,
    dockingAtISO: r.dockingAt ? r.dockingAt.toISOString() : null,
    programUnits: r.programUnits,
    nonProgramUnits: r.nonProgramUnits,
    consumerDropoffUnits: r.consumerDropoffUnits,
    expectedLoadId: r.expectedLoadId,
  };
}

export default async function FloorHaulsPage({ params, searchParams }: Props) {
  const { site: siteCode } = await params;
  const gate = await checkOperatorForSite(siteCode);
  if (!gate.ok) redirect(`/operator/${siteCode}`);
  const { siteId, siteName } = gate.ctx;

  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = (k: string, vars?: Record<string, string | number>) => translate(dict, k, vars);

  const live = await isUiSurfaceLive(UI_SURFACE.IPAD_HAULS, siteId);
  const view = pickHaulsListParams(await searchParams);

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        {/* Rendered ABOVE the gate branch on purpose: a gated-off operator still
            sees where they are, and the chrome's back + Log Out still apply. */}
        <FloorPageHeading
          title={t('floor.hauls.heading')}
          caption={t('floor.hauls.caption', { site: siteName })}
        />

        {!live ? (
          <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
            <p className="text-lg font-medium">{t('floor.common.not_activated_heading')}</p>
            <p className="mt-2 text-sm text-dr3-cream/70">
              {t('floor.common.not_activated_body', { site: siteName })}
            </p>
          </div>
        ) : (
          await renderList(siteCode, siteId, view)
        )}
      </div>
    </main>
  );
}

async function renderList(
  siteCode: string,
  siteId: string,
  view: ReturnType<typeof pickHaulsListParams>,
) {
  const page = await listPortalHauls({
    siteId,
    q: view.q,
    page: view.page,
    undatedOnly: view.undated,
  });

  // "No matches for what you asked" vs "this site has no portal hauls at all" —
  // Eugene renders the honest second one by construction (the MyMRC mirror is
  // Woodland-only; Eugene's contract has no portal feed).
  const hasAnyHauls = page.total > 0 || page.pending.length > 0 || page.undatedCount > 0;

  return (
    <>
      <HaulsClient
        siteCode={siteCode}
        view={view}
        rows={page.rows.map(toView)}
        pending={page.pending.map(toView)}
        undatedCount={page.undatedCount}
        hasAnyHauls={hasAnyHauls}
      />
      {page.totalPages > 1 && <HaulsPagination page={page.page} totalPages={page.totalPages} />}
    </>
  );
}
