// ADR-0125 — the end-of-day manager review + close screen.
//
// ONE screen per site per day. It is a REVIEW, not eleven blank forms: operators
// enter during the day and the manager arrives at EOD to a day that is already
// mostly captured, clears the ⚠ flags on whatever is genuinely missing, and
// closes — clean, or with a named exception.
//
// This is the surface that retires the Woodland daily-log workbook's functional
// tabs. Which ones, exactly, is in CHANGELOG.md; what is deliberately NOT retired
// (Events, Fuel, Container Rentals) is there too.
//
// Everything on this page is computed by `src/lib/eod/*` and rendered here. The
// on-hand figure is the ADR-0110 banner-aware tile, reused verbatim rather than
// re-implemented — a second renderer of that number is how the two surfaces end
// up disagreeing about when the floor has gone impossible.
//
// Site-scoped and Eugene-ready: nothing here names Woodland, and the Terex
// section grades `not applicable` at a site with no machine rather than carrying
// a permanent warning.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { FloorInventoryTile } from '@/app/dashboard/[site]/floor-inventory-tile';
import { getEodDayReview } from '@/lib/eod/day-review';
import { resolveEodDayKey, EodDayParamError } from '@/lib/eod/day-param';
import { prisma } from '@/lib/prisma';
import { dayKeyUTCFromISO, pacificDateLabel } from '@/lib/time';
import type { FlaggedSection, GapFlag } from '@/lib/eod/sections';
import { EodDayNav } from './EodDayNav';
import { EodCloseControls } from './EodCloseControls';
import { EodInboundAddLine } from './EodInboundAddLine';
import { EodQuickAdd } from './EodQuickAdd';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ day?: string }>;
};

function Denied({ siteCode, title, body }: { siteCode: string; title: string; body: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md opacity-80">{body}</p>
      <Link href={`/dashboard/${siteCode}`} className="mt-6 text-sm underline">
        Back to dashboard
      </Link>
    </main>
  );
}

const SECTION_LABEL: Record<FlaggedSection, string> = {
  inbound: 'Inbound',
  outbound: 'Outbound commodities',
  processed: 'Processed',
  nonProgram: 'Non-program',
  unpaidDropoff: 'Unpaid drop-offs',
  terex: 'Terex',
};

function Flag({ flag }: { flag: GapFlag }) {
  if (flag === 'captured') {
    return (
      <span
        data-testid="gap-flag-captured"
        className="rounded bg-dr3-cyan/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-dr3-cyan"
      >
        ✓ captured
      </span>
    );
  }
  if (flag === 'not_applicable') {
    return (
      <span
        data-testid="gap-flag-na"
        className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-dr3-mist-dim"
        title="This site has no machine of this kind, so there is nothing to record. Not a gap."
      >
        n/a
      </span>
    );
  }
  return (
    <span
      data-testid="gap-flag-missing"
      className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
      title="Nothing was recorded for this section today. That is not the same as zero — if the day genuinely had none, close the day with an exception naming it."
    >
      ⚠ not recorded
    </span>
  );
}

function Section({
  id,
  title,
  flag,
  note,
  children,
}: {
  id: string;
  title: string;
  flag?: GapFlag;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={`eod-section-${id}`}
      className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-dr3-mist">{title}</h2>
        {flag && <Flag flag={flag} />}
      </div>
      {note && <p className="mt-1 text-xs text-dr3-mist-dim">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="text-dr3-mist-dim">
          <tr>
            {head.map((h) => (
              <th key={h} className="py-2 pr-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="py-3 text-dr3-mist-dim">
                Nothing recorded.
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/10">
              {r.map((c, j) => (
                <td key={j} className="py-2 pr-3">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function n(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export default async function EodPage({ params, searchParams }: Props) {
  const { site: siteCode } = await params;
  const result = await checkManagerForSite(siteCode);
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=/dashboard/${siteCode}/eod`);
    return <Denied siteCode={siteCode} title="Access denied" body="This area is restricted." />;
  }

  // ADR-0047 / CLAUDE.md #12 — born pilot. Admins always pass; everyone else
  // waits for Bill to flip `eod_review` live for this site.
  const live = await isUiSurfaceLive(UI_SURFACE.EOD_REVIEW, result.ctx.siteId);
  if (result.ctx.role !== 'admin' && !live) {
    return (
      <Denied
        siteCode={siteCode}
        title="Not yet activated"
        body="The end-of-day review surface is staged but not yet activated for this site. Admin access only until an admin flips the eod_review rollout surface live."
      />
    );
  }

  const { day } = await searchParams;
  let dayKey: Date;
  try {
    dayKey = resolveEodDayKey(day);
  } catch (e) {
    if (e instanceof EodDayParamError) {
      return (
        <Denied
          siteCode={siteCode}
          title="Bad date"
          body="That is not a calendar day. Pick a day from the date control on the end-of-day screen."
        />
      );
    }
    throw e;
  }

  const review = await getEodDayReview({
    siteId: result.ctx.siteId,
    siteCode: result.ctx.siteCode,
    siteName: result.ctx.siteName,
    dayKey,
  });

  // The add-line's source picker. Read here, in the page, so the classifiers a
  // manager sees are the same rows `/admin/sources` maintains.
  const sources = await prisma.source.findMany({
    where: { site_id: result.ctx.siteId, is_active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, is_trans_charge: true },
  });

  const t = review.totals;
  const closed = review.close?.closed === true;

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-10 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Link href={`/dashboard/${siteCode}`} className="text-sm underline opacity-90">
          ← Back to {review.siteName} dashboard
        </Link>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">End of day — {review.siteName}</h1>
            <p className="mt-1 text-sm text-dr3-mist-dim" data-testid="eod-day-label">
              {/* Labelled from the REVIEW's day, not from the parsed parameter:
                  one day on the page, named once. Two sources for "which day is
                  this" is how a heading ends up describing a different day than
                  the sections beneath it. */}
              {pacificDateLabel(dayKeyUTCFromISO(review.dayKey))}
              {review.isToday ? ' · today' : ''} · Pacific
            </p>
          </div>
          <EodDayNav siteCode={siteCode} dayKey={review.dayKey} todayKey={review.todayKey} />
        </header>

        {review.isFuture ? (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-5 text-sm text-amber-200">
            <strong className="block text-amber-300">That day has not happened yet.</strong>A day is
            reviewed and closed after it ends. Pick today or an earlier day.
          </div>
        ) : (
          <>
            <div
              data-testid="eod-close-banner"
              className={`rounded-lg border p-4 text-sm ${
                closed
                  ? review.close?.outcome === 'exception'
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
                    : 'border-dr3-cyan/40 bg-dr3-cyan/10 text-dr3-mist'
                  : 'border-dr3-steel-light/25 bg-dr3-space-2 text-dr3-mist-dim'
              }`}
            >
              {closed ? (
                <>
                  <strong className="text-dr3-mist">
                    Day closed
                    {review.close?.outcome === 'exception' ? ' with an exception' : ' clean'}.
                  </strong>{' '}
                  {review.close?.exceptionNote && (
                    <span data-testid="eod-exception-note">
                      Outstanding: {review.close.exceptionNote}
                    </span>
                  )}
                  <p className="mt-1 text-xs opacity-80">
                    Closing records that the day was reviewed. It does not lock anything — the
                    existing amendment paths still work, and reopening is available with a reason.
                  </p>
                </>
              ) : (
                <>
                  <strong className="text-dr3-mist">Day not closed.</strong> Clear the ⚠ flags
                  below, then close clean — or close with an exception naming what is still out.
                  {review.close && review.close.reopenCount > 0 && (
                    <p className="mt-1 text-xs" data-testid="eod-reopen-note">
                      Reopened {review.close.reopenCount}×. Last reason: {review.close.reopenReason}
                    </p>
                  )}
                </>
              )}
            </div>

            <EodCloseControls
              siteCode={siteCode}
              dayKey={review.dayKey}
              closed={closed}
              missing={review.missing.map((s) => SECTION_LABEL[s])}
            />

            {/* ── On the floor (ADR-0110 banner contract, reused verbatim) ── */}
            <div className="grid gap-4 sm:grid-cols-2">
              <FloorInventoryTile tile={review.onHand} siteCode={siteCode} />
              <div className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-4">
                <div className="text-sm font-medium text-dr3-mist">Inventory check</div>
                <p className="mt-1 text-xs text-dr3-mist-dim">
                  The workbook&apos;s <em>inventory check (should be zero)</em> cell: the counted
                  floor minus the split entered against it.
                </p>
                {review.inventoryCheck.state === 'not_applicable' ? (
                  <p className="mt-2 text-sm text-dr3-mist-dim" data-testid="inventory-check-na">
                    {review.inventoryCheck.reason === 'no_anchor'
                      ? 'No physical count on record — nothing to check against.'
                      : 'The anchor count was taken without a program/non-program split, so the difference would be an artifact, not a measurement.'}
                  </p>
                ) : review.inventoryCheck.state === 'ok' ? (
                  <p className="mt-2 text-sm text-dr3-mist" data-testid="inventory-check-ok">
                    0 — the {n(review.inventoryCheck.physicalTotal ?? 0)}-unit count of{' '}
                    {review.inventoryCheck.anchorDayISO} splits exactly into{' '}
                    {n(review.inventoryCheck.programUnits ?? 0)} program +{' '}
                    {n(review.inventoryCheck.nonProgramUnits ?? 0)} non-program.
                  </p>
                ) : (
                  <p
                    className="mt-2 rounded border border-red-500/60 bg-red-500/10 p-2 text-sm text-red-200"
                    data-testid="inventory-check-off"
                    role="status"
                  >
                    <strong className="block text-red-300">
                      Off by {n(review.inventoryCheck.delta ?? 0)}.
                    </strong>
                    The {review.inventoryCheck.anchorDayISO} physical count totals{' '}
                    {n(review.inventoryCheck.physicalTotal ?? 0)} but its pools sum to{' '}
                    {n(
                      (review.inventoryCheck.programUnits ?? 0) +
                        (review.inventoryCheck.nonProgramUnits ?? 0),
                    )}
                    . Every pool figure on this page is computed forward from that count.
                  </p>
                )}
              </div>
            </div>

            {/* ── Inbound — the workhorse ─────────────────────────────── */}
            <Section
              id="inbound"
              title="Inbound"
              flag={t.flags.inbound}
              note={`${t.inbound.lines} line(s) · ${n(t.inbound.units)} units · ${n(t.inbound.weightLbs)} lbs · ${t.inbound.freightLines} freight / ${t.inbound.noFreightLines} no-freight${
                t.inbound.awaitingVerification > 0
                  ? ` · ${t.inbound.awaitingVerification} awaiting office verification`
                  : ''
              }`}
            >
              <Table
                head={[
                  'Source',
                  'Units',
                  'Program',
                  'Non-prog',
                  'LBS',
                  'BOL / Check #',
                  'DR3 #',
                  'Haul #',
                  'Freight',
                  'Status',
                ]}
                rows={review.rows.inbound.map((r) => [
                  r.sourceName ?? '—',
                  n(r.totalUnits),
                  n(r.programUnits),
                  n(r.nonProgramUnits),
                  r.weightLbs === null ? '—' : n(r.weightLbs),
                  r.bolNumber ?? '—',
                  r.dr3Number ?? '—',
                  r.haulNumber ?? '—',
                  r.transportCharged ? 'yes' : 'no',
                  r.status,
                ])}
              />
              <EodInboundAddLine
                siteCode={siteCode}
                dayKey={review.dayKey}
                sources={sources.map((s) => ({
                  id: s.id,
                  name: s.name,
                  isTransCharge: s.is_trans_charge,
                }))}
                rows={review.rows.inbound.map((r) => ({
                  id: r.id,
                  label: `${r.sourceName ?? 'load'} · ${n(r.totalUnits)} units`,
                  transportCharged: r.transportCharged,
                }))}
              />
            </Section>

            {/* ── Non-program ─────────────────────────────────────────── */}
            <Section
              id="nonprogram"
              title="Non-program"
              flag={t.flags.nonProgram}
              note={`${t.nonProgram.lines} inbound line(s) carrying ${n(t.nonProgram.units)} non-program units. Measured at 12-18 rows a month — near-daily, so it is flagged and it is not collapsed. Recorded on the inbound line above (the split), not on a separate tab.`}
            >
              <Table
                head={['Source', 'Non-program units', 'Freight', 'Haul #']}
                rows={review.rows.inbound
                  .filter((r) => r.nonProgramUnits > 0)
                  .map((r) => [
                    r.sourceName ?? '—',
                    n(r.nonProgramUnits),
                    r.transportCharged ? 'yes' : 'no',
                    r.haulNumber ?? '—',
                  ])}
              />
            </Section>

            {/* ── Outbound commodities ────────────────────────────────── */}
            <Section
              id="outbound"
              title="Outbound commodities"
              flag={t.flags.outbound}
              note={`${t.outbound.lines} line(s) · ${n(t.outbound.weightLbs)} lbs. Measured at ~107 rows a month across nine commodity blocks — the second-heaviest channel, not "8 rows, light". One add-line with a commodity selector reproduces all nine of the sheet's tables.`}
            >
              <Table
                head={['Commodity', 'Sub-category', 'LBS', 'Ticket #']}
                rows={review.rows.outbound.map((r) => [
                  r.commodity,
                  r.subCategory,
                  n(r.weightLbs),
                  r.ticketNumber ?? '—',
                ])}
              />
            </Section>

            {/* ── Processed ───────────────────────────────────────────── */}
            <Section
              id="processed"
              title="Processed"
              flag={t.flags.processed}
              note={
                t.processed.recorded
                  ? `Stripped ${n(t.processed.strippedProgram)} program + ${n(t.processed.strippedNonProgram)} non-program${
                      t.processed.savedUnits ? ` · saved ${n(t.processed.savedUnits)}` : ''
                    }${review.rows.processed?.source ? ` · entered by: ${review.rows.processed.source}` : ''}`
                  : 'No daily close recorded for this day.'
              }
            >
              <Table
                head={[
                  'Stripped program',
                  'Stripped non-program',
                  'Saved',
                  'M-number',
                  'Author',
                  'Locked',
                ]}
                rows={
                  review.rows.processed
                    ? [
                        [
                          n(review.rows.processed.strippedProgram),
                          n(review.rows.processed.strippedNonProgram),
                          review.rows.processed.savedUnits === null
                            ? '—'
                            : n(review.rows.processed.savedUnits),
                          review.rows.processed.materialTicketNumber ?? '—',
                          review.rows.processed.source,
                          review.rows.processed.closed ? 'yes' : 'no',
                        ],
                      ]
                    : []
                }
              />
              <p className="mt-2 text-xs text-dr3-mist-dim">
                Entered and amended at{' '}
                <Link
                  href={`/dashboard/${siteCode}/processed-units-close`}
                  className="underline hover:text-dr3-cyan"
                >
                  daily close entry
                </Link>
                . A row authored <code>manual</code> outranks the workbook import and the MyMRC
                bridge and is never overwritten by either (ADR-0123).
              </p>
            </Section>

            {/* ── Terex ───────────────────────────────────────────────── */}
            <Section
              id="terex"
              title="Terex"
              flag={t.flags.terex}
              note={
                !t.terex.applicable
                  ? 'This site has no throughput machine on the equipment registry, so there is nothing to record here.'
                  : t.terex.recorded
                    ? `${n(t.terex.unitsProcessed)} units · ${n(t.terex.runHours)} run hours`
                    : 'No throughput recorded for this day.'
              }
            >
              <Table
                head={['Units processed', 'Start hours', 'End hours', 'Run hours']}
                rows={
                  review.rows.terex
                    ? [
                        [
                          n(review.rows.terex.unitsProcessed),
                          review.rows.terex.startHours ?? '—',
                          review.rows.terex.endHours ?? '—',
                          review.rows.terex.runHours,
                        ],
                      ]
                    : []
                }
              />
              {t.terex.applicable && (
                <p className="mt-2 text-xs text-dr3-mist-dim">
                  Entered at{' '}
                  <Link
                    href={`/dashboard/${siteCode}/equipment`}
                    className="underline hover:text-dr3-cyan"
                  >
                    equipment
                  </Link>
                  . Start/End are cumulative hour-METER readings, not clock times (ADR-0107).
                </p>
              )}
            </Section>

            {/* ── Drop-offs ───────────────────────────────────────────── */}
            <Section
              id="unpaid"
              title="Unpaid drop-offs"
              flag={t.flags.unpaidDropoff}
              note={`${t.unpaidDropoff.lines} line(s) · ${n(t.unpaidDropoff.units)} units. Measured at 11-21 distinct rows a month — near-daily, so it is flagged and it is not collapsed.`}
            >
              <Table
                head={['Dropped off by', 'Units', 'Check #', 'Slip #']}
                rows={review.rows.unpaidDropoffs.map((r) => [
                  r.personName ?? '—',
                  n(r.units),
                  r.checkNumber ?? '—',
                  r.slipNumber ?? '—',
                ])}
              />
            </Section>

            <Section
              id="otherdropoffs"
              title="Other drop-offs (read-only)"
              note={`${t.otherDropoff.lines} line(s) · ${n(t.otherDropoff.units)} units — illegal drop-offs and the two iPad walk-up kinds. Captured on the floor; shown here for completeness, never re-entered.`}
            >
              <Table
                head={['Kind', 'Units', 'Slip #']}
                rows={review.rows.otherDropoffs.map((r) => [
                  r.kind,
                  n(r.units),
                  r.slipNumber ?? '—',
                ])}
              />
            </Section>

            {/* ── The two genuinely rare channels, collapsed ──────────── */}
            <details
              data-testid="eod-rare-channels"
              className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-5"
            >
              <summary className="cursor-pointer text-lg font-semibold text-dr3-mist">
                Renovation &amp; incentive drop-offs
                <span className="ml-2 text-xs font-normal text-dr3-mist-dim">
                  {t.renovation.lines + t.incentiveDropoff.lines} line(s) today · measured at 2-4
                  and 0-1 a month — collapsed by design
                </span>
              </summary>
              <div className="mt-4 flex flex-col gap-4">
                <Table
                  head={['Renovation commodity', 'Whole units', 'LBS', 'Ticket #']}
                  rows={review.rows.renovation.map((r) => [
                    r.commodity,
                    r.wholeUnits === null ? '—' : n(r.wholeUnits),
                    n(r.weightLbs),
                    r.ticketNumber ?? '—',
                  ])}
                />
                <Table
                  head={['Incentive drop-off by', 'Units', 'Check #']}
                  rows={review.rows.incentiveDropoffs.map((r) => [
                    r.personName ?? '—',
                    n(r.units),
                    r.checkNumber ?? '—',
                  ])}
                />
              </div>
            </details>

            {/* ── The add-lines that reuse the existing write paths ───── */}
            <EodQuickAdd siteCode={siteCode} dayKey={review.dayKey} />

            {/* ── Month to date — replaces the Summary tabs ───────────── */}
            <Section
              id="rollup"
              title={`Month to date — ${review.rollup.fromDayKey} → ${review.rollup.toDayKey}`}
              note="This replaces the workbook's Summary and Trans Summary tabs. Every figure is the sum of the day sections above, added once — not a second computation."
            >
              <Table
                head={['Channel', 'Lines', 'Units', 'LBS']}
                rows={[
                  [
                    'Inbound',
                    n(review.rollup.inbound.lines),
                    n(review.rollup.inbound.units),
                    n(review.rollup.inbound.weightLbs),
                  ],
                  ['— of which freight', n(review.rollup.inbound.freightLines), '—', '—'],
                  [
                    '— of which non-program',
                    n(review.rollup.nonProgram.lines),
                    n(review.rollup.nonProgram.units),
                    '—',
                  ],
                  [
                    'Outbound commodities',
                    n(review.rollup.outbound.lines),
                    '—',
                    n(review.rollup.outbound.weightLbs),
                  ],
                  [
                    'Renovation',
                    n(review.rollup.renovation.lines),
                    n(review.rollup.renovation.wholeUnits),
                    n(review.rollup.renovation.weightLbs),
                  ],
                  [
                    'Unpaid drop-offs',
                    n(review.rollup.unpaidDropoff.lines),
                    n(review.rollup.unpaidDropoff.units),
                    '—',
                  ],
                  [
                    'Incentive drop-offs',
                    n(review.rollup.incentiveDropoff.lines),
                    n(review.rollup.incentiveDropoff.units),
                    '—',
                  ],
                  [
                    'Landfilled',
                    n(review.rollup.landfilled.lines),
                    n(review.rollup.landfilled.units),
                    '—',
                  ],
                ]}
              />
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded border border-white/15 bg-black/20 p-3">
                  <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                    Stripped program (the billing basis)
                  </div>
                  <div className="mt-1 text-2xl font-bold tabular-nums">
                    {n(review.rollup.processed.strippedProgram)}
                  </div>
                  <div className="text-xs text-dr3-mist-dim">
                    {review.rollup.processed.daysRecorded} day(s) recorded
                  </div>
                </div>
                <div className="rounded border border-white/15 bg-black/20 p-3">
                  <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                    Stripped non-program
                  </div>
                  <div className="mt-1 text-2xl font-bold tabular-nums">
                    {n(review.rollup.processed.strippedNonProgram)}
                  </div>
                </div>
                <div className="rounded border border-white/15 bg-black/20 p-3">
                  <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                    Days with an open gap
                  </div>
                  <div className="mt-1 text-2xl font-bold tabular-nums">
                    {review.rollup.daysWithGaps} / {review.rollup.days}
                  </div>
                </div>
              </div>

              {/*
                The sheet reconciliation line. NOT an error state — a reported
                difference. The workbook's own Summary totals sum over duplicated
                rows: `inb no trans charge` and the unpaid drop-off block each
                carry every row exactly twice in July and August, and the sheet's
                Transportation Total and Fuel Surcharge equal the doubled sums
                (July 112,150 raw vs 56,075 distinct — 2.000x). So a Vision figure
                near HALF the sheet's is the expected shape here, and matching the
                sheet would mean reproducing the defect.
              */}
              <div
                data-testid="eod-sheet-reconciliation"
                className="mt-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100"
              >
                <strong className="block text-amber-300">Sheet reconciliation</strong>
                These figures replace the workbook&apos;s <em>Summary</em> and{' '}
                <em>Trans Summary</em> tabs. They will not match those tabs, and that is expected:
                the sheet&apos;s own July and August totals are <strong>known-doubled</strong> —
                every row on <code>inb no trans charge</code> and on the unpaid drop-off block
                appears exactly twice inside the range the tab sums, so its transportation and
                fuel-surcharge totals are 2.000× the distinct rows. Compare the two and{' '}
                <strong>report the divergence</strong>; do not treat a ~2× gap as an error in these
                numbers.
              </div>
            </Section>
          </>
        )}
      </div>
    </main>
  );
}
