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
import { useRouter } from 'next/navigation';
import { useT, useLocale } from '@/i18n/provider';
import { formatDate, formatTime } from '@/lib/format';
import { QueueRow } from '../queue/queue-row';
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
  expectedLoadId: string | null;
}

type Props = {
  siteCode: string;
  view: HaulsListParams;
  rows: HaulRowView[];
  pending: HaulRowView[];
  undatedCount: number;
  /** True when the site has hauls at all — separates "no matches" from "no data". */
  hasAnyHauls: boolean;
};

export function HaulsClient({ siteCode, view, rows, pending, undatedCount, hasAnyHauls }: Props) {
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

  const renderRow = (r: HaulRowView) => (
    <li key={r.id}>
      {r.expectedLoadId ? (
        // A LIVE `expected_loads` sibling exists — this haul is real dock work, so
        // it gets the same tap-to-start affordance the queue uses. Nothing new is
        // written here; `startLoadAction` is the existing, gated path.
        <QueueRow siteCode={siteCode} expectedLoadId={r.expectedLoadId}>
          {renderBody(r)}
          <p className="mt-2 text-start text-xs font-bold uppercase tracking-wide text-dr3-chartreuse">
            {t('floor.hauls.check_in')}
          </p>
        </QueueRow>
      ) : (
        // No sibling: information, not work. ADR-0074 D5 forbids synthesizing one
        // to make a button possible, so the row renders read-only with NO control.
        <div className="rounded-lg bg-dr3-green-dark/40 p-4">
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
        <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
          <p className="text-lg font-medium">
            {hasAnyHauls ? t('floor.hauls.empty_no_results') : t('floor.hauls.empty_no_hauls')}
          </p>
        </div>
      )}
    </div>
  );
}
