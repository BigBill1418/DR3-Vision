'use client';

import Link from 'next/link';
import type { LoadStatus } from '@prisma/client';
import { ElapsedTime } from './elapsed-time';
import { useI18n } from '@/i18n/provider';
import { loadStageLabel } from '@/lib/loads/labels';

// Per-tile dock view for active operator sessions (T-010). Stage label
// flows through `loadStageLabel`, which differs from the row badge in
// loads-filters/load-row by emphasising the workflow stage ("Door
// open", "Counting") instead of the record state ("Unloading", "In
// progress"). Both maps live in `@/lib/loads/labels` — single source.
//
// `stageLabel` was previously exported here as a synchronous helper for
// the load-detail page. That helper now lives at
// `./load/[id]/stage-label-server.ts` so the detail page can resolve
// the locale without crossing the client/server boundary; this module
// is client-only.

type Props = {
  siteCode: string;
  load: {
    id: string;
    bol_number: string | null;
    status: LoadStatus;
    arrived_at: Date | null;
    operatorName: string;
    sourceName: string;
  };
};

export function DockTile({ siteCode, load }: Props) {
  const { t, dict } = useI18n();
  // Tiles only render for operator-active loads, so `arrived_at` is
  // populated in practice. Guard for the type system + the seed-data
  // edge case where a load somehow lands here without an arrival time.
  const sinceIso = load.arrived_at ? load.arrived_at.toISOString() : null;
  return (
    <Link
      href={`/dashboard/${siteCode}/load/${load.id}`}
      className="block rounded-lg bg-dr3-green-dark/40 p-4 transition-colors hover:bg-dr3-green-dark/70"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-semibold">{load.operatorName}</span>
        <span className="rounded-full bg-dr3-green/30 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-dr3-cream">
          {loadStageLabel(load.status, dict)}
        </span>
      </div>
      <p className="mt-1 text-sm text-dr3-cream/80">{load.sourceName}</p>
      <p className="mt-2 text-xs uppercase tracking-wide text-dr3-cream/60">
        {t('site_dashboard.tile_bol_label')}{' '}
        <span className="font-mono normal-case text-dr3-cream">{load.bol_number ?? '—'}</span>
      </p>
      <p className="mt-3 text-sm">
        <span className="text-dr3-cream/60">{t('site_dashboard.tile_elapsed_label')} </span>
        {sinceIso ? <ElapsedTime since={sinceIso} /> : <span className="font-mono">—</span>}
      </p>
    </Link>
  );
}
