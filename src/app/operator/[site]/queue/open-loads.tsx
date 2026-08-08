import Link from 'next/link';
import type { Locale } from '@/i18n/config';
import { formatDate, formatTime } from '@/lib/format';
import type { LoadStatus } from '@prisma/client';
import type { OpenLoadView } from '@/lib/loads/open-loads';

// ADR-0065 Amendment 1 — the "unfinished loads" block at the top of the dock queue.
//
// This is the ONLY navigation path back into a load the operator already started.
// See `src/lib/loads/open-loads.ts` for the three production loads that were
// stranded without it, one of them counted-but-never-submitted.
//
// It sits ABOVE the expected-load list on purpose: finishing work you already
// started outranks starting new work, and a `finished` load is one tap from
// entering inventory.
//
// Server component (like `FloorPageHeading`) — the queue page is a server
// component and resolves its strings with `translate()`, so `t` is passed in
// rather than reached for with `useT()`.

const STATUS_KEY: Record<string, string> = {
  arrived: 'queue.open_status_arrived',
  weight_captured: 'queue.open_status_weight_captured',
  unload_started: 'queue.open_status_unload_started',
  in_progress: 'queue.open_status_in_progress',
  finished: 'queue.open_status_finished',
};

function statusKey(status: LoadStatus): string {
  // Fail SOFT to the generic "in progress" label. An unmapped status must never
  // render a raw enum token at an operator, and must never throw — the whole point
  // of this block is that it is the way out of a stranded load.
  return STATUS_KEY[status] ?? 'queue.open_status_in_progress';
}

export function OpenLoadsSection({
  siteCode,
  rows,
  locale,
  t,
}: {
  siteCode: string;
  rows: OpenLoadView[];
  locale: Locale;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-dr3-chartreuse/10 p-4 ring-1 ring-dr3-chartreuse/40">
      <header>
        <h2 className="text-lg font-bold">{t('queue.open_heading')}</h2>
        <p className="mt-1 text-sm text-dr3-cream/70">{t('queue.open_intro')}</p>
      </header>

      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/operator/${siteCode}/load/${r.id}`}
              // ADR-0060 gloved-hand sizing: a dock control is never smaller than
              // 44px, and this one is a primary action so it gets the full 56.
              className="flex min-h-[56px] items-center justify-between gap-4 rounded-lg bg-dr3-green px-4 py-3 text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream active:bg-dr3-green-dark"
            >
              <span className="min-w-0">
                <span className="block truncate text-base font-bold">
                  {r.sourceName ?? t('queue.unknown_source')}
                </span>
                <span className="mt-0.5 block truncate text-xs opacity-80">
                  {r.transporterName ?? t('queue.unknown_carrier')}
                  {' · '}
                  {t('queue.bol_label')} {r.bolNumber ?? t('queue.bol_dash')}
                </span>
                <span className="mt-1 block text-xs opacity-80">
                  {t(statusKey(r.status))}
                  {r.arrivedAt && (
                    <>
                      {' · '}
                      {/* Pacific-pinned via `@/lib/format` (Amendment 1). A load can
                          be older than today, so the DATE is shown here — unlike the
                          expected-load rows below, which are today by construction. */}
                      {t('queue.open_arrived_at', {
                        when: `${formatDate(r.arrivedAt, locale)} ${formatTime(r.arrivedAt, locale)}`,
                      })}
                    </>
                  )}
                  {r.totalUnits != null && (
                    <>
                      {' · '}
                      {t('queue.open_units', { count: r.totalUnits })}
                    </>
                  )}
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-dr3-ink px-3 py-1 text-sm font-bold text-dr3-cream">
                {r.readyToSubmit ? t('queue.open_submit_ready') : t('queue.open_resume')}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * ADR-0082 — open loads at this site that ANOTHER operator holds.
 *
 * This block did not exist, and its absence is half of the stranding. The queue
 * listed only the signed-in operator's own unfinished loads, so a load whose
 * holder had gone to lunch — or gone home — appeared on nobody's screen but
 * theirs. Production 2026-08-08 held nine of them across five operators, the
 * oldest eleven days old.
 *
 * Rendered BELOW the operator's own unfinished work and visually quieter than it:
 * finishing your own load still outranks taking someone else's, and this is a
 * "somebody should pick this up" list, not a work queue. Each row names the
 * holder and links into the load page, which is where the takeover confirm lives
 * — the list itself takes nothing over, so a mis-tap here costs a page view.
 */
export function HeldByOthersSection({
  siteCode,
  rows,
  locale,
  t,
}: {
  siteCode: string;
  rows: OpenLoadView[];
  locale: Locale;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-dr3-green-dark/30 p-4 ring-1 ring-dr3-cream/20">
      <header>
        <h2 className="text-base font-bold">{t('queue.held_heading')}</h2>
        <p className="mt-1 text-sm text-dr3-cream/70">{t('queue.held_intro')}</p>
      </header>

      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/operator/${siteCode}/load/${r.id}`}
              className="flex min-h-[56px] items-center justify-between gap-4 rounded-lg bg-dr3-green-dark/50 px-4 py-3 transition-colors hover:bg-dr3-green-dark"
            >
              <span className="min-w-0">
                <span className="block truncate text-base font-medium">
                  {r.sourceName ?? t('queue.unknown_source')}
                </span>
                <span className="mt-0.5 block truncate text-xs text-dr3-cream/70">
                  {t('queue.bol_label')} {r.bolNumber ?? t('queue.bol_dash')}
                  {' · '}
                  {t(statusKey(r.status))}
                  {r.arrivedAt && (
                    <>
                      {' · '}
                      {t('queue.open_arrived_at', {
                        when: `${formatDate(r.arrivedAt, locale)} ${formatTime(r.arrivedAt, locale)}`,
                      })}
                    </>
                  )}
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-dr3-ink/70 px-3 py-1 text-xs font-bold text-dr3-cream">
                {/* THE NAME. The single thing the floor could not see before. */}
                {t('queue.held_by', { name: r.claimedByName ?? t('takeover.unknown_holder') })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
