import { auth } from '@/lib/auth';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { formatDate, formatTime, formatRelative } from '@/lib/format';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary, translate } from '@/i18n/dictionary';
import { QueueClient } from './queue-client';
import { QueueRow } from './queue-row';
import { OpenLoadsSection, HeldByOthersSection } from './open-loads';
import { HOME_ROUTE } from '@/lib/routes';
import { currentPacificDayWindow } from '@/lib/time';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { listSiteOpenLoads } from '@/lib/loads/open-loads';
import { CONSUMED_SLOT_SELECT, toConsumedLoad } from '@/lib/loads/consumed-slot';
import { describeConsumedSlot } from '@/lib/loads/consumed-slot-view';
import { floorStatusKey } from '@/lib/loads/floor-status-label';
import { FloorPageHeading } from '../../_components/page-heading';

// Expected-loads queue per SPRINT-1-PLAN T-005. Server-renders the
// list of in-window inbound hauls for the operator's site, ordered
// by expected arrival. Auto-refresh + pull-to-refresh are wired in
// the `QueueClient` wrapper.
//
// "In-window" = THE CURRENT PACIFIC DAY ONLY (ADR-0065). It previously meant
// "arriving today or any later date" — an unbounded `gte` that put every future
// load on the queue. On 2026-07-28 that was 14 rows where 1 was actionable.
// Bill's directive for the floor iPad is explicit: "only going to show hauls
// from the current day … no historical or future views."
//
// The bound is Pacific, not server-local. The container runs UTC, so the old
// `new Date(); setHours(0,0,0,0)` computed the UTC day: after 5 PM Pacific the
// queue would silently roll to TOMORROW mid-shift, hiding the loads the
// evening-shift operator was actually working. `currentPacificDayWindow` is the
// same day-key definition `floor-inbound` / `onHand` / the MyMRC bridge use, so
// the iPad and billing agree on what "today" is.
//
// ADR-0065 Amendment 1 (2026-07-30) — TWO corrections here:
//
// 1. THE PAGE IS NOW ROLLOUT-GATED. ADR-0065 D1 stated that `ipad_queue` governs
//    "/queue + /load/[id] + the dock server actions", but only the ACTIONS
//    (`../actions.ts` `ctx()`) and the hub CARD ever read it — the two pages did
//    not. Flipping `ipad_queue` to `pilot` therefore hid the card while leaving a
//    fully-rendered, bookmarkable queue whose every button threw an ungated
//    `LoadsInventoryNotActivatedError`. There is no operator-scoped error boundary
//    below `src/app/operator/`, so that surfaced as the black, English-only
//    "Something went wrong" page with NO navigation at all — precisely the dead end
//    ADR-0065 rejected ("a bookmarked URL should degrade to the already-translated
//    'not turned on yet' block, not a dead end"). Reading the gate here makes the
//    documented behavior real. The write gate in `actions.ts` STAYS — this is
//    defense in depth, not a replacement.
//
// 2. UNFINISHED LOADS ARE LISTED. The queue lists `expected_loads`; the workflow
//    operates on `inbound_loads`. Nothing on the iPad listed the latter, so a load
//    already started had exactly one route back — the redirect the start action
//    performs. Three Woodland loads were stranded in production, one counted and
//    never submitted. See `src/lib/loads/open-loads.ts` for the measurements and
//    for why the current-day floor deliberately does NOT apply to that block.
//
// T-006 wires the load workflow that converts an `ExpectedLoad` into an
// `InboundLoad`; until then "started" loads just sit on the queue.
//
// Per ADR-0014 this is the first OPERATOR working surface — green
// palette, not the auth-screen black. The pre-PIN routes
// (name-picker, keypad) keep the dark + canonical-logo treatment;
// the queue is where the work begins.

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

export default async function OperatorQueuePage({ params }: Props) {
  const { site: siteCode } = await params;
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

  // ADR-0065 D1 / Amendment 1 — the page reads the SAME `ipad_queue` surface the
  // dock server actions assert, so hiding the hub card and refusing the writes can
  // never disagree with what a bookmarked URL renders. Fail-safe by construction:
  // `isUiSurfaceLive` returns false for pilot, unregistered, or a read error.
  const queueLive = await isUiSurfaceLive(UI_SURFACE.IPAD_QUEUE, site.id);
  if (!queueLive) {
    return (
      <main className="px-6 pb-8">
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

  const now = new Date();
  const today = currentPacificDayWindow(now);

  // Unfinished dock work first — NOT day-bounded (see open-loads.ts).
  //
  // ADR-0082 widened this from the operator's OWN open loads to the SITE's,
  // split by holder. The operator-scoped version could not show a stranded load
  // by construction: the one person who could see it was the one who had walked
  // away from it.
  const openLoads = await listSiteOpenLoads(site.id, session.user.id);

  // ADR-0099 — `cancelled_at: null` USED TO BE A PREDICATE HERE, and it is the
  // one filter that contradicted the comment forty lines below in this very
  // query: "A vanished row tells the operator standing next to the truck
  // nothing at all — the identical silence that ADR-0065 Am.1 and ADR-0082 were
  // both written to end." That reasoning was applied to the CONSUMED case and
  // not to the withdrawn one, which is how the audit's sharpest asymmetry came
  // about: a slot MyMRC cancelled was INVISIBLE on the queue and UNEXPLAINED on
  // the hauls screen, and neither surface had a way out.
  //
  // Production says the filter was hiding the wrong thing 97% of the time: of 69
  // auto-cancellations, 67 were undone by a later scrape. So the row is selected
  // and PARTITIONED below, exactly as the consumed row already is.
  const allSlots = await prisma.expectedLoad.findMany({
    where: {
      site_id: site.id,
      // Half-open [start, endExclusive) — current Pacific day only.
      expected_arrival_at: { gte: today.start, lt: today.endExclusive },
    },
    select: {
      id: true,
      expected_arrival_at: true,
      cancelled_at: true,
      // ADR-0090 A — the haul number. NOT NULL on this model, and the only
      // field that separates two of one site's trucks on one day.
      external_mymrc_haul_id: true,
      source_name_at_sync: true,
      source: { select: { name: true } },
      transporter_name_at_sync: true,
      transporter: { select: { name: true } },
      bol_number: true,
      expected_unit_count: true,
      last_synced_at: true,
      // ADR-0074 Amendment 1 — THE FIELD WHOSE ABSENCE BLOCKED THE FLOOR.
      //
      // This query had `{site_id, cancelled_at: null, expected_arrival_at in
      // today}` and nothing else, so on the day an appointment finally came
      // round it could not tell a slot waiting for a truck from one that had
      // been worked days earlier. H-134743's appointment was 2026-08-10 15:00 PT
      // and its slot had been consumed on 2026-08-03; the queue rendered a
      // check-in row anyway, and every tap on it routed into the submitted load.
      //
      // The row is deliberately still SELECTED rather than filtered out with an
      // `inbound_load: null` predicate. A vanished row tells the operator
      // standing next to the truck nothing at all — the identical silence that
      // ADR-0065 Am.1 and ADR-0082 were both written to end. It renders
      // read-only, saying what happened.
      inbound_load: { select: CONSUMED_SLOT_SELECT },
    },
    orderBy: { expected_arrival_at: 'asc' },
  });

  // The live queue keeps its exact previous contents — every consumer below is
  // unchanged. Withdrawn slots are a SEPARATE, quieter block so they cannot be
  // mistaken for work, and so an empty queue with a withdrawn truck on the dock
  // no longer reads as "nothing expected today".
  const loads = allSlots.filter((l) => l.cancelled_at === null);
  const withdrawn = allSlots.filter((l) => l.cancelled_at !== null && l.inbound_load === null);

  // Last-sync timestamp for the empty-state caption — pulled from
  // the freshest scrape across the site's loads. Once T-013 ships
  // the actual MyMRC scrape it can write a system_state row instead;
  // for now max(last_synced_at) is a reasonable proxy.
  const latest = await prisma.expectedLoad.findFirst({
    where: { site_id: site.id },
    orderBy: { last_synced_at: 'desc' },
    select: { last_synced_at: true },
  });
  const lastSyncAt = latest?.last_synced_at ?? null;

  return (
    <main className="px-6 pb-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-6">
        <FloorPageHeading
          title={t('queue.heading')}
          caption={t('queue.site_caption', { site: site.name, name: session.user.name })}
        />

        <QueueClient lastSyncAt={lastSyncAt?.toISOString() ?? null}>
          {/* Wrapper supplies the vertical rhythm the outer page column gives its
              own children — QueueClient renders into a bare `relative` div, so
              without it the resume block sits flush against the list below. */}
          <div className="flex flex-col gap-4">
            <OpenLoadsSection siteCode={site.code} rows={openLoads.mine} locale={locale} t={t} />
            {loads.length === 0 ? (
              <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
                <p className="text-lg font-medium">{t('queue.empty_heading')}</p>
                <p className="mt-2 text-sm text-dr3-cream/70">
                  {lastSyncAt
                    ? t('queue.last_sync', { when: formatRelative(lastSyncAt, now, locale) })
                    : t('queue.no_sync_yet')}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {loads.map((l) => {
                  const sourceName = l.source?.name ?? l.source_name_at_sync;
                  const transporterName =
                    l.transporter?.name ?? l.transporter_name_at_sync ?? t('queue.unknown_carrier');
                  const arrival = l.expected_arrival_at;
                  const consumed = toConsumedLoad(l.inbound_load);
                  const body = (
                    <>
                      {/* No date shown: the queue is current-Pacific-day only
                          (ADR-0065), so every row is today by construction.
                          The TIME is Pacific-pinned as of Amendment 1 — it was
                          rendering in the container's UTC zone, 7 hours ahead. */}
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xl font-semibold tabular-nums">
                          {formatTime(arrival, locale)}
                        </span>
                        {/* ADR-0090 A — bare and mono, exactly as the hauls
                            screen renders it. An identifier reads as itself, so
                            no label string is invented in three locales. */}
                        <span className="font-mono text-sm font-bold text-dr3-cream/80">
                          {l.external_mymrc_haul_id}
                        </span>
                      </div>
                      <p className="mt-2 text-base font-medium">{sourceName}</p>
                      <p className="text-sm text-dr3-cream/70">{transporterName}</p>
                      <p className="mt-2 text-xs uppercase tracking-wide text-dr3-cream/60">
                        {t('queue.bol_label')}{' '}
                        <span className="font-mono normal-case text-dr3-cream">
                          {l.bol_number ?? t('queue.bol_dash')}
                        </span>
                        {l.expected_unit_count != null && (
                          <span className="ms-3">
                            {t('queue.approx_units', { count: l.expected_unit_count })}
                          </span>
                        )}
                      </p>
                    </>
                  );
                  return (
                    <li key={l.id}>
                      {consumed ? (
                        // ADR-0074 Am.1 — the slot is spent, and the line answers
                        // "where did my truck go" rather than leaving the operator
                        // to ask the room.
                        //
                        // ADR-0091 — but "spent" is two different things. A WORKED
                        // slot keeps Amendment 1's read-only card; an OPEN one is
                        // live floor work and now routes into it, through the same
                        // `describeConsumedSlot` the hauls screen reads, so the two
                        // surfaces cannot drift apart again.
                        (() => {
                          const v = describeConsumedSlot(consumed, session.user.id);
                          if (v.kind === 'worked') {
                            return (
                              <div className="rounded-lg bg-dr3-green-dark/40 p-4">
                                {body}
                                <p className="mt-2 text-xs font-bold uppercase tracking-wide text-dr3-cream/70">
                                  {/* Audit D-5 — the same fallback as the hauls
                                      screen, changed in the same commit. These
                                      two surfaces have now failed identically
                                      TWICE (ADR-0074 Am.1, then ADR-0091), so a
                                      copy change on one of them that is not made
                                      on the other is the RC-2 defect, not a
                                      cosmetic omission. */}
                                  {consumed.totalUnits != null && consumed.workedAt
                                    ? t('floor.common.already_worked_detail', {
                                        units: consumed.totalUnits,
                                        date: formatDate(consumed.workedAt, locale),
                                      })
                                    : t('floor.common.already_worked_status', {
                                        status: t(floorStatusKey(consumed.status)),
                                      })}
                                </p>
                              </div>
                            );
                          }
                          return (
                            <Link
                              href={`/operator/${site.code}/load/${v.loadId}`}
                              className="block min-h-[56px] rounded-lg bg-dr3-green-dark/40 p-4 transition-colors hover:bg-dr3-green-dark/80 active:bg-dr3-green-dark"
                            >
                              {body}
                              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-dr3-chartreuse">
                                {v.kind === 'resume'
                                  ? t('floor.common.resume_yours')
                                  : t('floor.common.started_by', {
                                      name: v.holderName ?? t('takeover.unknown_holder'),
                                    })}
                              </p>
                            </Link>
                          );
                        })()
                      ) : (
                        <QueueRow siteCode={site.code} expectedLoadId={l.id}>
                          {body}
                        </QueueRow>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* ADR-0099 — slots MyMRC withdrew for TODAY.
                Below the live queue and visually quieter than it, because this is
                not work: it is the answer to "my truck is here and it is not on
                the screen", which had no answer at all while the query filtered
                these out. No control — `startInboundLoad` answers 409
                `expected_load_cancelled`, and a button whose only outcome is a
                refusal is what ADR-0074 Am.1 forbids. It names the time, the
                actor and the place instead, and it self-heals: the office
                re-adding the haul in MyMRC restores the row within the hour.
                Consumed slots are excluded — a withdrawn slot whose load was
                already started is rescued by `listSiteOpenLoads` above and would
                otherwise appear twice. */}
            {withdrawn.length > 0 && (
              <section
                className="flex flex-col gap-3 rounded-xl bg-amber-900/30 p-4 ring-1 ring-amber-400/40"
                data-testid="queue-withdrawn"
              >
                <header>
                  <h2 className="text-base font-bold">{t('queue.withdrawn_heading')}</h2>
                  <p className="mt-1 text-sm text-dr3-cream/80">
                    {t('floor.hauls.withdrawn_what_to_do')}
                  </p>
                </header>
                <ul className="flex flex-col gap-2">
                  {withdrawn.map((l) => (
                    <li key={l.id} className="rounded-lg bg-dr3-green-dark/40 p-4">
                      <p className="text-base font-medium">
                        <span className="font-mono">{l.external_mymrc_haul_id}</span>
                        {' · '}
                        {l.source?.name ?? l.source_name_at_sync}
                      </p>
                      <p className="mt-1 text-sm text-dr3-cream/70">
                        {formatTime(l.expected_arrival_at, locale)}
                        {l.expected_unit_count != null && (
                          <span className="ms-3">
                            {t('queue.approx_units', { count: l.expected_unit_count })}
                          </span>
                        )}
                      </p>
                      <p className="mt-2 text-sm font-semibold text-amber-100">
                        {t('floor.hauls.withdrawn', {
                          time: l.cancelled_at ? formatTime(l.cancelled_at, locale) : '—',
                        })}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {/* ADR-0082 — LAST on the page, and that ordering is the policy: your
                own unfinished work, then today's expected hauls, then loads
                somebody else is holding. A takeover is help, not a task. */}
            <HeldByOthersSection
              siteCode={site.code}
              rows={openLoads.heldByOthers}
              locale={locale}
              t={t}
            />
          </div>
        </QueueClient>
      </div>
    </main>
  );
}
