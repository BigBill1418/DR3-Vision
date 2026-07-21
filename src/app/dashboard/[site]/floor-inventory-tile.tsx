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
        className={`tabular-nums font-bold text-dr3-mist ${emphasize ? 'text-3xl' : 'text-2xl'}`}
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
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Pool label="Program" value={tile.programOnFloor} emphasize />
        <Pool label="Non-program" value={tile.nonProgramOnFloor} />
        <Pool label="Total" value={tile.totalOnFloor} />
      </div>
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
            <strong className="tabular-nums text-dr3-mist">{units(tile.trailingUnitsPerDay)}</strong>{' '}
            units/day
          </span>
        )}
      </div>
    </Link>
  );
}
