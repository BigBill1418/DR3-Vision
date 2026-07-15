// T-107 (ADR-0020) — a single Vision Dashboard tile.
//
// Server component (no interactivity beyond the link). Keyed to the DR3-Vision
// logo: each tile is a deep-space glass panel with the logo's "eye" set as a
// semi-transparent watermark on the right, a cyan icon glow, and a cyan halo on
// hover. Three visual states:
//   - active            → glass panel, cyan accents, links to its route
//   - active + featured → brighter cyan ring + glow + "NEW" pill (Bonus Mgmt)
//   - coming-soon       → dimmed glass, non-interactive, "COMING SOON" pill
//
// Routes that start with `http` (e.g. the Observability tile → the fleet status
// surface) open in a new tab via a plain anchor; internal routes use next/Link.
//
// Icons come from lucide-react. We resolve the icon name from the tile registry
// against a small allow-list so the registry stays string-typed (no component
// refs in the data) while keeping the bundle to only the icons we use.

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  Boxes,
  CalendarCheck,
  ClipboardList,
  Coins,
  FileCheck,
  FileSpreadsheet,
  IdCard,
  LayoutDashboard,
  ListTodo,
  PenTool,
  Plug,
  Scale,
  ShieldCheck,
  Upload,
  UserCog,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardTile } from '@/lib/dashboard-tiles';

const ICONS: Record<string, LucideIcon> = {
  Activity,
  Boxes,
  CalendarCheck,
  ClipboardList,
  Coins,
  FileCheck,
  FileSpreadsheet,
  IdCard,
  LayoutDashboard,
  ListTodo, // ADR-0045 — ops ledger tile
  PenTool,
  Plug,
  Scale,
  ShieldCheck,
  Upload,
  UserCog,
  Wrench,
};

/** The logo "eye" watermark + a left-fade so tile copy stays legible. */
function TileWatermark({ opacity }: { opacity: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 bg-[url('/brand/dr3-vision-logo.jpg')] bg-cover bg-right ${opacity} transition-opacity duration-300`}
      />
      {/* lighter left-fade so the eye reads more strongly while copy stays legible */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-dr3-space-2 via-dr3-space-2/65 to-transparent"
      />
    </>
  );
}

export function VisionTile({ tile }: { tile: DashboardTile }) {
  const Icon = ICONS[tile.icon] ?? LayoutDashboard;

  if (tile.status === 'coming-soon') {
    return (
      <div
        data-testid={`tile-${tile.key}`}
        data-status="coming-soon"
        aria-disabled="true"
        className="group relative flex min-h-[88px] cursor-not-allowed flex-col gap-2 overflow-hidden rounded-2xl border border-dr3-steel-light/15 bg-dr3-space-2/40 p-4 text-dr3-mist-dim"
      >
        <TileWatermark opacity="opacity-[0.11]" />
        <div className="relative flex items-start justify-between">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-dr3-mist/5 ring-1 ring-dr3-steel-light/20">
            <Icon className="h-5 w-5 text-dr3-mist-dim/70" aria-hidden="true" />
          </span>
          <span className="rounded-full border border-dr3-steel-light/30 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-dr3-mist-dim/70">
            Coming soon
          </span>
        </div>
        <h3 className="relative text-base font-semibold text-dr3-mist/70">{tile.label}</h3>
        <p className="relative line-clamp-2 text-xs leading-relaxed text-dr3-mist-dim/60">
          {tile.description}
        </p>
      </div>
    );
  }

  const featured = tile.featured === true;
  const external = tile.route.startsWith('http');
  const surface = featured
    ? 'border-dr3-cyan/45 bg-dr3-space-2/80 shadow-[0_0_35px_-10px_rgba(80,240,224,0.5)] hover:border-dr3-cyan/70 hover:shadow-[0_0_50px_-8px_rgba(80,240,224,0.65)]'
    : 'border-dr3-steel-light/25 bg-dr3-space-2/70 hover:border-dr3-cyan/50 hover:shadow-[0_0_45px_-10px_rgba(80,240,224,0.45)]';

  const className = `group relative flex min-h-[88px] flex-col gap-2 overflow-hidden rounded-2xl border p-4 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-dr3-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-dr3-space ${surface}`;

  // ADR-0046 — a live count pill (e.g. AP pending requests). Takes the top-right
  // slot; a non-featured tile with a badge shows the count, a featured tile shows
  // its "New" pill (no tile is both in practice).
  const badge = typeof tile.badgeCount === 'number' && tile.badgeCount > 0 ? tile.badgeCount : null;

  const inner = (
    <>
      <TileWatermark
        opacity={
          featured
            ? 'opacity-[0.30] group-hover:opacity-[0.42]'
            : 'opacity-[0.22] group-hover:opacity-[0.34]'
        }
      />

      <div className="relative flex items-start justify-between">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-xl ring-1 transition-colors ${
            featured
              ? 'bg-dr3-cyan/15 ring-dr3-cyan/40'
              : 'bg-dr3-cyan/10 ring-dr3-cyan/20 group-hover:ring-dr3-cyan/40'
          }`}
        >
          <Icon className="h-5 w-5 text-dr3-cyan" aria-hidden="true" />
        </span>
        {badge !== null ? (
          <span
            aria-label={`${badge} pending`}
            className="rounded-full bg-dr3-cyan px-2 py-0.5 text-[11px] font-bold tabular-nums text-dr3-space shadow-[0_0_14px_rgba(80,240,224,0.6)]"
          >
            {badge}
          </span>
        ) : featured ? (
          <span className="rounded-full bg-dr3-cyan px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-dr3-space shadow-[0_0_14px_rgba(80,240,224,0.6)]">
            New
          </span>
        ) : null}
      </div>
      <h3 className="relative text-base font-semibold text-dr3-mist">{tile.label}</h3>
      <p className="relative line-clamp-2 text-xs leading-relaxed text-dr3-mist-dim">
        {tile.description}
      </p>
      <span className="relative mt-1 inline-flex items-center gap-1 text-sm font-medium text-dr3-cyan">
        {external ? 'Open ↗' : 'Open'}
        {external ? null : (
          <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
            →
          </span>
        )}
      </span>
    </>
  );

  if (external) {
    return (
      <a
        href={tile.route}
        target="_blank"
        rel="noreferrer"
        data-testid={`tile-${tile.key}`}
        data-status="active"
        data-featured={featured ? 'true' : 'false'}
        className={className}
      >
        {inner}
      </a>
    );
  }

  return (
    <Link
      href={tile.route}
      data-testid={`tile-${tile.key}`}
      data-status="active"
      data-featured={featured ? 'true' : 'false'}
      className={className}
    >
      {inner}
    </Link>
  );
}
