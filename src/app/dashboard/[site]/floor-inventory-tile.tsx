// Rollup §3 (2026-07-21 handoff, §15 item 5) — live floor inventory tile.
//
// Server component (no interactivity): program / non-program / total units on
// the floor right now, straight off the ADR-0037 running balance, plus the
// optional "days of program pool remaining" projection. The page is
// force-dynamic and `DockPoller` refreshes the whole route every 5s, so these
// numbers stay live without a dedicated poller. Links into the site-scoped
// loads & inventory surface. Manager surfaces stay on the dark dr3 palette
// (ADR-0014).

import Link from 'next/link';
import type { FloorInventoryTileData } from '@/lib/dashboard/floor-inventory-tile';

/** Decimal(7,1) flows can leave a .5 on the floor; show it only when present. */
function units(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function daysLabel(days: number): string {
  if (days < 1) return '< 1 day';
  const rounded = days.toFixed(1);
  return `≈ ${rounded} days`;
}

function Pool({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div
        className={`font-bold tabular-nums text-dr3-mist ${emphasize ? 'text-3xl' : 'text-2xl'}`}
        data-testid={`floor-pool-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}
      >
        {units(value)}
      </div>
    </div>
  );
}

export function FloorInventoryTile({
  tile,
  siteCode,
}: {
  tile: FloorInventoryTileData;
  siteCode: string;
}) {
  return (
    <Link
      href={`/dashboard/${siteCode}/loads-inventory`}
      className="flex flex-col gap-3 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-4 transition-colors hover:border-dr3-cyan/50"
      data-testid="floor-inventory-tile"
      aria-label="Floor inventory"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-dr3-mist">On the floor now</span>
        <span className="inline-flex items-center gap-2 text-xs text-dr3-mist-dim">
          {tile.anchorPool === 'legacy' && (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
              title="The anchor physical count was recorded without a program/non-program split, so the whole anchor is attributed to the program pool until the next split count."
            >
              unsplit anchor
            </span>
          )}
          Live · as of {tile.asOfISO}
        </span>
      </div>
      {/*
        handoff #270 §4a — a negative floor renders as a DIAGNOSTIC, not a number.
        The building cannot hold −2,439 mattresses, so the figure is not a small
        quantity, it is proof that intake is under-fed and processing has been
        subtracted from it anyway. The pools are replaced by the banner rather
        than shown alongside it: a negative printed anywhere on a manager surface
        gets copied into a spreadsheet, and this one is not a measurement of
        anything. The projection row below is suppressed for the same reason.
      */}
      {tile.negative ? (
        <div
          className="rounded border border-red-500/60 bg-red-500/10 p-3 text-sm leading-relaxed text-red-200"
          data-testid="floor-negative-banner"
          role="status"
        >
          <strong className="block text-red-300">On-hand is computing negative.</strong>
          Intake data is incomplete — processing has been subtracted from inbound that has not all
          been recorded. This figure is not reliable and is not shown. A physical count resets the
          floor.
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <Pool label="Program" value={tile.programOnFloor} emphasize />
          <Pool label="Non-program" value={tile.nonProgramOnFloor} />
          <Pool label="Total" value={tile.totalOnFloor} />
        </div>
      )}
      {/*
        Suppressed entirely (not CSS-hidden) on a negative floor: "≈ 0 days
        remaining" derived from a broken pool is another confident-looking number,
        and markup that is merely `display:none` still ships the sentence to
        anything reading the page's HTML.
      */}
      {!tile.negative && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-dr3-mist-dim">
          <span data-testid="floor-program-days">
            Program pool{' '}
            {tile.programDaysRemaining === null ? (
              <span>— no trailing rate yet</span>
            ) : (
              <>
                <strong className="text-dr3-mist">{daysLabel(tile.programDaysRemaining)}</strong>{' '}
                remaining at the current pace
              </>
            )}
          </span>
          {tile.trailingUnitsPerDay !== null && (
            <span>
              7-day pace{' '}
              <strong className="tabular-nums text-dr3-mist">
                {units(tile.trailingUnitsPerDay)}
              </strong>{' '}
              units/day
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
