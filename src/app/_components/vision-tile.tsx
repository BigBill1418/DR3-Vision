// T-107 (ADR-0020) — a single Vision Dashboard tile.
//
// Server component (no interactivity beyond the link). Three visual states:
//   - active           → cream card, full color, links to its route
//   - active + featured → chartreuse card with a "NEW" pill (Bonus Management)
//   - coming-soon      → muted, non-interactive, "COMING SOON" pill
//
// Icons come from lucide-react. We resolve the icon name from the tile registry
// against a small allow-list so the registry stays string-typed (no component
// refs in the data) while keeping the bundle to only the icons we use.

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  ClipboardList,
  Coins,
  FileSpreadsheet,
  IdCard,
  LayoutDashboard,
  PenTool,
  Plug,
  Scale,
  ShieldCheck,
  Upload,
  UserCog,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardTile } from '@/lib/dashboard-tiles';

const ICONS: Record<string, LucideIcon> = {
  Activity,
  ClipboardList,
  Coins,
  FileSpreadsheet,
  IdCard,
  LayoutDashboard,
  PenTool,
  Plug,
  Scale,
  ShieldCheck,
  Upload,
  UserCog,
};

export function VisionTile({ tile }: { tile: DashboardTile }) {
  const Icon = ICONS[tile.icon] ?? LayoutDashboard;

  if (tile.status === 'coming-soon') {
    return (
      <div
        data-testid={`tile-${tile.key}`}
        data-status="coming-soon"
        aria-disabled="true"
        className="group relative flex cursor-not-allowed flex-col gap-3 rounded-2xl border border-dr3-cream/10 bg-dr3-green-dark/30 p-6 text-dr3-cream/50"
      >
        <div className="flex items-start justify-between">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-dr3-cream/5">
            <Icon className="h-6 w-6" aria-hidden="true" />
          </span>
          <span className="rounded-full border border-dr3-cream/20 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-dr3-cream/50">
            Coming soon
          </span>
        </div>
        <h3 className="text-lg font-semibold text-dr3-cream/70">{tile.label}</h3>
        <p className="text-sm leading-relaxed text-dr3-cream/40">{tile.description}</p>
      </div>
    );
  }

  const featured = tile.featured === true;
  const surface = featured
    ? 'bg-dr3-chartreuse text-dr3-ink hover:bg-dr3-chartreuse/90 ring-1 ring-dr3-chartreuse/60'
    : 'bg-dr3-cream text-dr3-ink hover:bg-white';

  return (
    <Link
      href={tile.route}
      data-testid={`tile-${tile.key}`}
      data-status="active"
      data-featured={featured ? 'true' : 'false'}
      className={`group relative flex flex-col gap-3 rounded-2xl p-6 shadow-lg shadow-black/20 transition-all hover:-translate-y-0.5 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-dr3-chartreuse focus-visible:ring-offset-2 focus-visible:ring-offset-dr3-green-deep ${surface}`}
    >
      <div className="flex items-start justify-between">
        <span
          className={`flex h-11 w-11 items-center justify-center rounded-xl ${
            featured ? 'bg-dr3-ink/10' : 'bg-dr3-green-deep/10'
          }`}
        >
          <Icon
            className={`h-6 w-6 ${featured ? 'text-dr3-ink' : 'text-dr3-green-deep'}`}
            aria-hidden="true"
          />
        </span>
        {featured ? (
          <span className="rounded-full bg-dr3-green-deep px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-dr3-chartreuse">
            New
          </span>
        ) : null}
      </div>
      <h3 className="text-lg font-semibold">{tile.label}</h3>
      <p className={`text-sm leading-relaxed ${featured ? 'text-dr3-ink/70' : 'text-dr3-ink/60'}`}>
        {tile.description}
      </p>
      <span
        className={`mt-1 inline-flex items-center gap-1 text-sm font-medium ${
          featured ? 'text-dr3-green-dark' : 'text-dr3-green'
        }`}
      >
        Open
        <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </span>
    </Link>
  );
}
