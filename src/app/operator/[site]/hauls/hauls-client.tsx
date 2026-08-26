'use client';

// ADR-0074 — the iPad's open portal-haul list: search box, undated chip, pinned
// pending block, and the rows themselves.
//
// NO `<form>` AND NO SUBMIT HANDLER (CLAUDE.md hard rule #10). The search button
// is a plain `onClick` and Enter is handled by an explicit `onKeyDown` — the same
// shape `src/app/admin/equipment/EquipmentSearchClient.tsx` established, since
// this surface's job is identical: push `?q=` and let the server component
// re-query. All view state is URL state (`hauls/list-url.ts`), so handing the
// iPad to the next shift mid-search reproduces exactly what is on the screen.
//
// SIZED FOR THE FLOOR, NOT A DESK. Every control clears 56px, the input asks iOS
// for the search keyboard with an uppercase-first shift (haul numbers read
// "H-136271"), and the palette is the ADR-0008 green the operator surfaces use
// outdoors. Every horizontal offset is logical (`ms-*` / `me-*` / `text-start`)
// so the Urdu RTL build mirrors correctly rather than shearing.
//
// Instants are rendered through the Pacific-pinned `formatTime` / `formatDate`
// from `@/lib/format` (ADR-0065 Amendment 1 A1.1). The container runs UTC; a bare
// `Intl` call here would tell a Woodland operator a 15:00Z appointment is "3:00
// PM" when it is 8:00 AM — the single field this screen exists to communicate.

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { describeConsumedSlot } from '@/lib/loads/consumed-slot-view';
import { floorStatusKey } from '@/lib/loads/floor-status-label';
import { DeadEndBeacon } from '../../_components/dead-end-beacon';
import { useT, useLocale } from '@/i18n/provider';
import { formatDate, formatTime } from '@/lib/format';
import { QueueRow } from '../queue/queue-row';
import { ReconcileRow } from './reconcile-row';
import { SEARCH_MAX, buildHaulsListHref, type HaulsListParams } from './list-url';

/**
 * A row as it crosses the RSC boundary — instants as ISO strings, per the
 * repo's existing floor-client convention (`FloorInboundDayView`).
 */
export interface HaulRowView {
  id: string;
  externalHaulId: string | null;
  status: string | null;
  type: string | null;
  transporterName: string | null;
  collectionSite: string | null;
  collectionSource: string | null;
  dockingDateISO: string | null;
  dockingAtISO: string | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  consumerDropoffUnits: number | null;
  /** Non-null ⇒ startable RIGHT NOW (live, unconsumed, due today). */
  expectedLoadId: string | null;
  /** ADR-0096 — live + unconsumed but booked for ANOTHER Pacific day. */
  reconcilableExpectedLoadId: string | null;
  /** That slot's own Pacific day, `YYYY-MM-DD`. */
  slotDayISO: string | null;
  /** ADR-0099 — non-null when MyMRC WITHDREW this haul's slot. */
  cancelledAtISO: string | null;
  /** Non-null ⇒ the slot has already been worked. See `portal-hauls.ts`. */
  consumedLoad: {
    status: string;
    open: boolean;
    totalUnits: number | null;
    workedAtISO: string | null;
    /** ADR-0091 — the route back in, and who holds it. */
    loadId: string;
    holderUserId: string | null;
    holderName: string | null;
  } | null;
}

type Props = {
  siteCode: string;
  view: HaulsListParams;
  rows: HaulRowView[];
  pending: HaulRowView[];
  undatedCount: number;
  /** True when the site has hauls at all — separates "no matches" from "no data". */
  hasAnyHauls: boolean;
  /**
   * ADR-0091 — the signed-in operator, resolved from the SESSION on the server
   * (`page.tsx`), never from the `[site]` path segment. Used only to compare
   * against `consumedLoad.holderUserId`, so a tampered value could at worst
   * mislabel a card the load page then re-authorises from the session anyway.
   */
  viewerUserId: string;
};

export function HaulsClient({
  siteCode,
  view,
  rows,
  pending,
  undatedCount,
  hasAnyHauls,
  viewerUserId,
}: Props) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [term, setTerm] = useState(view.q ?? '');

  // Any navigation resets to page 1: a term typed on page 7 has no page 7.
  const go = useCallback(
    (next: Partial<HaulsListParams>) => {
      router.push(buildHaulsListHref(siteCode, { ...view, page: 1, ...next }));
    },
    [router, siteCode, view],
  );

  const submit = useCallback(() => {
    const q = term.trim();
    go({ q: q ? q : undefined });
  }, [go, term]);

  const clear = useCallback(() => {
    setTerm('');
    go({ q: undefined });
  }, [go]);

  const renderBody = (r: HaulRowView) => {
    const units = (r.programUnits ?? 0) + (r.nonProgramUnits ?? 0) + (r.consumerDropoffUnits ?? 0);
    const dockingDate = r.dockingDateISO ? new Date(r.dockingDateISO) : null;
    const dockingAt = r.dockingAtISO ? new Date(r.dockingAtISO) : null;
    return (
      <>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-mono text-xl font-semibold tabular-nums">
            {r.externalHaulId ?? '—'}
          </span>
          <span className="text-sm font-semibold uppercase tracking-wide text-dr3-cream/70">
            {r.status === 'Delivered'
              ? t('floor.hauls.status_delivered')
              : r.status === 'Confirmed'
                ? t('floor.hauls.status_confirmed')
                : (r.status ?? '—')}
          </span>
        </div>
        <p className="mt-2 text-start text-base font-medium">
          {r.collectionSite ?? r.collectionSource ?? '—'}
        </p>
        <p className="text-start text-sm text-dr3-cream/70">{r.transporterName ?? '—'}</p>
        <p className="mt-2 text-start text-sm tabular-nums text-dr3-cream/80">
          {dockingDate ? formatDate(dockingDate, locale) : t('floor.hauls.no_date')}
          {dockingAt && <span className="ms-2">{formatTime(dockingAt, locale)}</span>}
          <span className="ms-3">
            {units > 0 ? `${units} ${t('floor.common.units')}` : t('floor.hauls.units_pending')}
          </span>
        </p>
      </>
    );
  };

  /**
   * ADR-0074 Amendment 1 — what a CONSUMED slot says instead of nothing.
   *
   * The read layer already refuses to hand back a check-in target for a worked
   * slot, so this text is the whole remaining job: telling the operator where
   * their truck went. On 2026-08-10 no screen anywhere could answer that, which
   * is why the floor stopped rather than adapted.
   */
  const consumedNote = (c: NonNullable<HaulRowView['consumedLoad']>) => {
    // ADR-0091 — an OPEN child is no longer described by guesswork. The three
    // cases are decided once, in `describeConsumedSlot`, shared with the queue.
    const v = describeConsumedSlot(c, viewerUserId);
    if (v.kind === 'resume') return t('floor.common.resume_yours');
    if (v.kind === 'held') {
      return t('floor.common.started_by', {
        name: v.holderName ?? t('takeover.unknown_holder'),
      });
    }
    const workedAt = c.workedAtISO ? new Date(c.workedAtISO) : null;
    // Units AND a date, or neither — an "already worked — null units" line reads
    // as a bug and invites the operator to distrust the rest of the screen.
    if (c.totalUnits != null && workedAt) {
      return t('floor.common.already_worked_detail', {
        units: c.totalUnits,
        date: formatDate(workedAt, locale),
      });
    }
    // Audit D-5 — the fallback used to be the bare two words "Already worked",
    // which told the operator the slot was spent and nothing about what happened
    // to it. It is reachable for a `rejected` child (never submitted, so
    // `submitted_at` and therefore `workedAtISO` are null); production held 2 at
    // 2026-08-11 22:04 PT, both with null units AND null date, so both landed
    // here. Saying the STATUS costs one interpolation and turns "something
    // happened" into "it was rejected at the dock".
    return t('floor.common.already_worked_status', { status: t(floorStatusKey(c.status)) });
  };

  const renderRow = (r: HaulRowView) => (
    <li key={r.id}>
      {/* THREE states, and the order of these branches is the safety property:
          `consumedLoad` is tested FIRST, so even if a future read-layer change
          hands back both fields — the exact prod state on 2026-08-10 — this
          component still refuses to render a button onto a worked slot. Two
          independent reasons the dead card cannot come back. */}
      {r.consumedLoad && r.consumedLoad.open ? (
        // ADR-0091 — an OPEN child is LIVE FLOOR WORK, so the card is a route
        // into it, not an epitaph. `/load/<id>` renders the workflow to its
        // holder and the ADR-0082 held-by + Take over panel to anyone else, and
        // is site-scoped on the server, so one link serves both cases safely.
        //
        // This does NOT reintroduce the dead card Amendment 1 killed: that was a
        // control onto WORKED (`submitted`) slots, which still fall to the
        // read-only branch below. `open` is the whole difference.
        <Link
          href={`/operator/${siteCode}/load/${r.consumedLoad.loadId}`}
          // ADR-0060 gloved-hand sizing — a dock control is never under 56px.
          className="block min-h-[56px] rounded-lg bg-dr3-green-dark/40 p-4 text-start transition-colors hover:bg-dr3-green-dark/80 active:bg-dr3-green-dark"
        >
          {renderBody(r)}
          <p className="mt-2 text-start text-xs font-bold uppercase tracking-wide text-dr3-chartreuse">
            {consumedNote(r.consumedLoad)}
          </p>
        </Link>
      ) : r.consumedLoad ? (
        <div className="rounded-lg bg-dr3-green-dark/40 p-4">
          <DeadEndBeacon
            siteCode={siteCode}
            surface="hauls"
            state="already_worked"
            objectId={r.externalHaulId}
          />
          {renderBody(r)}
          <p className="mt-2 text-start text-xs font-bold uppercase tracking-wide text-dr3-cream/70">
            {consumedNote(r.consumedLoad)}
          </p>
        </div>
      ) : r.expectedLoadId && r.externalHaulId ? (
        // Live sibling, unconsumed, and due TODAY — this haul is real dock work,
        // so it gets the same tap-to-start affordance the queue uses. Nothing new
        // is written here; `startLoadAction` is the existing, gated path.
        //
        // ADR-0127 — `externalHaulId` joins the condition rather than being
        // defaulted to a dash. It is non-null by construction on this branch
        // (`portal-hauls.ts` resolves the sibling BY haul number, so a row with
        // none can never carry an `expectedLoadId`), and a placeholder would be
        // a value the server assert rejects — a control whose only outcome is a
        // refusal, which ADR-0074 Am.1 forbids. Falling through to the read-only
        // branch is the honest answer to a row that cannot name itself.
        <QueueRow
          siteCode={siteCode}
          expectedLoadId={r.expectedLoadId}
          haulLabel={r.externalHaulId}
          sourceLabel={r.collectionSite ?? r.collectionSource ?? t('queue.unknown_source')}
          transporterLabel={r.transporterName ?? t('queue.unknown_carrier')}
        >
          {renderBody(r)}
          <p className="mt-2 text-start text-xs font-bold uppercase tracking-wide text-dr3-chartreuse">
            {t('floor.hauls.check_in')}
          </p>
        </QueueRow>
      ) : r.reconcilableExpectedLoadId && r.slotDayISO && r.externalHaulId ? (
        // ADR-0096 — a LIVE, UNCONSUMED slot booked for another Pacific day. The
        // truck can be on the dock right now; H-136980 was, on 2026-08-11, and
        // this branch is why tapping its card did nothing.
        //
        // Note what is NOT done here: `expectedLoadId` is untouched. ADR-0074 D5
        // still means "due today", because that bound is what stops a child load
        // being minted onto the wrong slot. This is a separately named state with
        // its own, deliberately slower control.
        <ReconcileRow
          siteCode={siteCode}
          expectedLoadId={r.reconcilableExpectedLoadId}
          slotDayISO={r.slotDayISO}
          slotDayLabel={formatDate(new Date(`${r.slotDayISO}T12:00:00Z`), locale)}
          // ADR-0127 — was `?? t('floor.hauls.no_date')`, a placeholder that
          // read "No date" where a haul number belongs. It is now guarded in the
          // branch condition instead: the label travels to the server and is
          // compared against the slot, so a stand-in string would be a guaranteed
          // 409 rather than a cosmetic wobble.
          haulLabel={r.externalHaulId}
        >
          {renderBody(r)}
        </ReconcileRow>
      ) : r.cancelledAtISO ? (
        // ADR-0099 — MyMRC WITHDREW this slot. Until now this hit a bare
        // `continue` in `portal-hauls.ts` and fell into the "View only" branch
        // below, so a withdrawn haul, an undated one and a haul with no slot at
        // all were the same two words.
        //
        // No control, deliberately: `startInboundLoad` answers 409
        // `expected_load_cancelled`, so a button here would be one whose only
        // outcome is a refusal. What it gets instead is the `hold_remote_note`
        // shape the audit names as the house best practice for exactly this
        // case — say WHEN it happened, WHO can act, and FROM WHERE. And it
        // self-heals: the office re-adding the haul in MyMRC brings the row back
        // within the hour, because the scrape's un-cancel path already works.
        <div
          className="rounded-lg bg-amber-900/40 p-4 ring-1 ring-amber-400/40"
          data-testid="haul-withdrawn"
        >
          {/* ADR-0100 §P0 — the state ADR-0099 measured at 69 firings, 67 of them
              wrong. Now that it is legible it also has to be COUNTABLE: the
              three-miss threshold is a judgement made on 69 events, and this is
              the readout that says whether it was the right one. */}
          <DeadEndBeacon
            siteCode={siteCode}
            surface="hauls"
            state="slot_withdrawn"
            objectId={r.externalHaulId}
          />
          {renderBody(r)}
          <p className="mt-2 text-start text-sm font-semibold text-amber-100">
            {t('floor.hauls.withdrawn', {
              time: formatTime(new Date(r.cancelledAtISO), locale),
            })}
          </p>
          <p className="mt-1 text-start text-sm text-dr3-cream/80">
            {t('floor.hauls.withdrawn_what_to_do')}
          </p>
        </div>
      ) : (
        // No sibling at all, or an UNDATED one: information, not work. ADR-0074
        // D5 forbids synthesizing a slot to make a button possible, and an
        // undated slot has no day for the operator to confirm or the server to
        // check — so it stays read-only rather than getting a reconcile control
        // whose acknowledgement could not be verified.
        <div className="rounded-lg bg-dr3-green-dark/40 p-4">
          {/* ADR-0100 §P0 — "View only" is the branch that dead-ended H-136980 on
              2026-08-11 and produced a 5:18 PM phone call. It is the single
              highest-value thing on the floor to have a count of. */}
          <DeadEndBeacon
            siteCode={siteCode}
            surface="hauls"
            state="view_only"
            objectId={r.externalHaulId}
          />
          {renderBody(r)}
          <p className="mt-2 text-start text-xs uppercase tracking-wide text-dr3-cream/50">
            {t('floor.hauls.view_only')}
          </p>
        </div>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-dr3-cream/70">
          {t('floor.hauls.search_label')}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={term}
            maxLength={SEARCH_MAX}
            inputMode="search"
            enterKeyHint="search"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t('floor.hauls.search_placeholder')}
            aria-label={t('floor.hauls.search_label')}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            className="min-h-[56px] min-w-0 flex-1 rounded-lg bg-dr3-green-dark/60 px-4 py-3 text-start text-lg text-dr3-cream placeholder:text-dr3-cream/40 focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
            data-testid="floor-hauls-search-input"
          />
          <button
            type="button"
            onClick={submit}
            className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink"
            data-testid="floor-hauls-search-submit"
          >
            {t('floor.hauls.search_submit')}
          </button>
          {view.q ? (
            <button
              type="button"
              onClick={clear}
              className="min-h-[56px] rounded-lg bg-dr3-green-deep px-4 py-3 text-lg font-bold text-dr3-cream ring-1 ring-dr3-green"
              data-testid="floor-hauls-search-clear"
            >
              {t('floor.hauls.search_clear')}
            </button>
          ) : null}
        </div>
        {undatedCount > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => go({ undated: !view.undated })}
              aria-pressed={view.undated}
              className={
                view.undated
                  ? 'min-h-[44px] rounded-full bg-dr3-chartreuse px-4 py-2 text-sm font-bold text-dr3-ink'
                  : 'min-h-[44px] rounded-full bg-dr3-green-deep px-4 py-2 text-sm font-bold text-dr3-cream ring-1 ring-dr3-green'
              }
              data-testid="floor-hauls-undated-chip"
            >
              {undatedCount === 1
                ? t('floor.hauls.undated_chip_one', { count: undatedCount })
                : t('floor.hauls.undated_chip_other', { count: undatedCount })}
            </button>
          </div>
        )}
      </div>

      {pending.length > 0 && (
        // PINNED, UNPAGINATED, AND NOT NARROWED BY THE SEARCH. "What is coming"
        // must not depend on what the operator typed — it is the one answer the
        // dock needs before a truck is in front of them.
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-start text-lg font-bold">{t('floor.hauls.pending_heading')}</h2>
            {/* Confirmed hauls carry 0 units until MyMRC marks them delivered —
                say so, or the zeros read as an empty truck. */}
            <p className="text-start text-sm text-dr3-cream/70">{t('floor.hauls.pending_note')}</p>
          </div>
          <ul className="flex flex-col gap-3">{pending.map(renderRow)}</ul>
        </section>
      )}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-3">{rows.map(renderRow)}</ul>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-lg bg-dr3-green-dark/40 p-8 text-center">
          <p className="text-lg font-medium">
            {hasAnyHauls ? t('floor.hauls.empty_no_results') : t('floor.hauls.empty_no_hauls')}
          </p>
          {/* Audit D-6 — "No portal hauls for this site." was a bare <p> that
              ended the conversation, and for EUGENE it is the PERMANENT state of
              this screen: the MyMRC mirror is Woodland-only by contract. A
              Eugene operator tapping through saw a flat refusal with no
              indication it was by design. The "no results" case keeps its Clear
              button above and needs nothing here; the "no data" case gets the
              reason and a route, in the house `not_activated_body` style. */}
          {!hasAnyHauls && (
            <>
              {/* Eugene's PERMANENT state, by contract. Counting it separates
                  "designed and explained" from "nobody has looked at this yet". */}
              <DeadEndBeacon siteCode={siteCode} surface="hauls" state="no_portal_feed" />
              <p className="text-sm text-dr3-cream/70">{t('floor.hauls.empty_no_hauls_why')}</p>
              <Link
                href={`/operator/${siteCode}/queue`}
                className="min-h-[56px] rounded-lg bg-dr3-green px-6 py-3 text-base font-bold text-dr3-ink"
              >
                {t('floor.inbound.go_to_queue')}
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
