'use client';

import Link from 'next/link';
import { LoadStatus } from '@prisma/client';
import { formatDate, formatTime } from '@/lib/format';
import { useI18n } from '@/i18n/provider';
import { loadStatusLabel } from '@/lib/loads/labels';

// Single row in the load list. Renders as an <li> wrapping a <Link>
// to the per-load detail page (T-010 owns the detail route at
// /dashboard/[site]/load/[id]). Per CLAUDE.md hard rule #10 navigation
// uses <Link> + onClick rather than a form submission, which Next's
// Link delivers natively.
//
// Status pill text is the shared `loadStatusLabel` from
// `@/lib/loads/labels` — same map as the filter chips and (with stage
// variants) the dock tile.

// Color buckets per the T-011 brief:
//   green  — completed (processed)
//   orange — verified (manager-gate clear, awaiting MyMRC)
//   red    — rejected
//   neutral— everything else (submitted, in-flight)
function statusBadgeClass(status: LoadStatus): string {
  if (status === LoadStatus.processed) {
    return 'bg-dr3-green text-dr3-ink';
  }
  if (status === LoadStatus.verified) {
    return 'bg-orange-400 text-dr3-ink';
  }
  if (status === LoadStatus.rejected) {
    return 'bg-red-500 text-white';
  }
  return 'bg-dr3-cream/20 text-dr3-cream';
}

type Props = {
  siteCode: string;
  load: {
    id: string;
    bol_number: string | null;
    status: LoadStatus;
    arrived_at: Date | null;
    total_units: number | null;
    source_name: string | null;
    transporter_name: string | null;
    operator_name: string | null;
  };
};

export function LoadRow({ siteCode, load }: Props) {
  const { t, dict } = useI18n();
  const arrival = load.arrived_at;
  const arrivalLabel = arrival ? `${formatDate(arrival)} · ${formatTime(arrival)}` : '—';

  return (
    <li>
      <Link
        href={`/dashboard/${siteCode}/load/${load.id}`}
        className="grid grid-cols-12 gap-3 px-4 py-3 transition-colors hover:bg-dr3-green-dark/60 focus:bg-dr3-green-dark/60 focus:outline-none"
      >
        <span className="col-span-12 text-sm font-medium tabular-nums text-dr3-cream sm:col-span-3">
          {arrivalLabel}
        </span>
        <span className="col-span-6 truncate text-sm text-dr3-cream/90 sm:col-span-2">
          {load.source_name ?? '—'}
        </span>
        <span className="col-span-6 truncate text-sm text-dr3-cream/80 sm:col-span-2">
          {load.operator_name ?? (
            <span className="text-dr3-cream/50">{t('loads.row_unassigned')}</span>
          )}
        </span>
        <span className="col-span-6 truncate text-sm text-dr3-cream/80 sm:col-span-2">
          {load.transporter_name ?? '—'}
        </span>
        <span className="col-span-3 truncate font-mono text-xs text-dr3-cream/80 sm:col-span-1">
          {load.bol_number ?? '—'}
        </span>
        <span className="col-span-2 text-right text-sm tabular-nums text-dr3-cream sm:col-span-1">
          {load.total_units ?? '—'}
        </span>
        <span className="col-span-12 sm:col-span-1">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(load.status)}`}
          >
            {loadStatusLabel(load.status, dict)}
          </span>
        </span>
      </Link>
    </li>
  );
}
