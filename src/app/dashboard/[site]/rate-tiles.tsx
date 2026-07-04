// ADR-0043 D3 — the two site rate tiles (recycling by weight, recovery by
// units). Server component (no interactivity): current rolling rate vs the
// contract floor, a trend arrow vs the prior equal-length window, and an
// `estimated` badge when the 55-lb unit-weight estimate contributed. The whole
// tile links into the site-scoped audit findings filtered to the R-check, so a
// red tile is one click from the finding + its explanation.

import Link from 'next/link';
import type { RateTileData, SiteRateTiles } from '@/lib/dashboard/rate-tiles';

const STATUS_STYLE: Record<RateTileData['status'], { ring: string; dot: string; label: string }> = {
  ok: { ring: 'ring-emerald-400/30 bg-emerald-500/10', dot: 'bg-emerald-400', label: 'On track' },
  warn: { ring: 'ring-amber-400/30 bg-amber-500/10', dot: 'bg-amber-400', label: 'Near floor' },
  high: { ring: 'ring-rose-400/40 bg-rose-500/10', dot: 'bg-rose-400', label: 'Below floor' },
  nodata: { ring: 'ring-dr3-steel-light/25 bg-dr3-space-2', dot: 'bg-dr3-mist-dim/50', label: 'No data yet' },
};

function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`;
}

function Trend({ trendPts }: { trendPts: number | null }) {
  if (trendPts === null) {
    return <span className="text-dr3-mist-dim">no prior window</span>;
  }
  const up = trendPts >= 0;
  const arrow = up ? '▲' : '▼';
  const color = up ? 'text-emerald-400' : 'text-rose-400';
  return (
    <span className={color}>
      {arrow} {Math.abs(trendPts).toFixed(1)} pts vs. prior window
    </span>
  );
}

function Tile({ tile, title, siteCode }: { tile: RateTileData; title: string; siteCode: string }) {
  const s = STATUS_STYLE[tile.status];
  return (
    <Link
      href={`/dashboard/${siteCode}/audit?tab=findings&status=open&check=${tile.checkCode}`}
      className={`flex flex-col gap-3 rounded-lg p-4 ring-1 transition-colors hover:brightness-110 ${s.ring}`}
      data-testid={`rate-tile-${tile.metric}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-dr3-mist">{title}</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-dr3-mist-dim">
          <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
          {s.label}
        </span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-3xl font-bold tabular-nums text-dr3-mist">{pct(tile.ratePct)}</span>
        {tile.estimated && (
          <span
            className="mb-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
            title="Includes the 55-lb per-unit weight estimate (Addendum B, estimate only). Precision improves when the destination mapping lands."
          >
            estimated
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="text-dr3-mist-dim">
          Floor <strong className="text-dr3-mist">{tile.floorPct.toFixed(0)}%</strong>
        </span>
        <Trend trendPts={tile.trendPts} />
      </div>
    </Link>
  );
}

export function RateTiles({ tiles, siteCode }: { tiles: SiteRateTiles; siteCode: string }) {
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Contract rate monitoring">
      <Tile tile={tiles.recycling} title="Recycling rate (by weight)" siteCode={siteCode} />
      <Tile tile={tiles.recovery} title="Recovery rate (by units)" siteCode={siteCode} />
    </section>
  );
}
