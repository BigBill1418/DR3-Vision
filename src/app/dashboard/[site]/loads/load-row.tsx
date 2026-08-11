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

// Color buckets per the T-011 brief, on the dark Vision theme the status
// badges stay as semantic status hues (filled, dark text) so they read at
// a glance against the steel chrome:
//   emerald — completed (processed)
//   amber   — verified (manager-gate clear, awaiting MyMRC)
//   rose    — rejected
//   neutral — everything else (submitted, in-flight)
function statusBadgeClass(status: LoadStatus): string {
  if (status === LoadStatus.processed) {
    return 'bg-emerald-400 text-dr3-space';
  }
  if (status === LoadStatus.verified) {
    return 'bg-amber-400 text-dr3-space';
  }
  if (status === LoadStatus.rejected) {
    return 'bg-rose-500 text-white';
  }
  // ADR-0090 C — a voided load must not look like a submitted one. Without this
  // branch it fell to the same neutral grey as `submitted`, so a disowned load
  // and a load awaiting verification were visually identical in the list a
  // manager triages from.
  if (status === LoadStatus.voided) {
    return 'bg-dr3-steel/30 text-dr3-mist-dim line-through';
  }
  return 'bg-dr3-steel/60 text-dr3-mist';
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
        className="grid grid-cols-12 gap-3 px-4 py-3 transition-colors hover:bg-dr3-steel/40 focus:bg-dr3-steel/40 focus:outline-none"
      >
        <span className="col-span-12 text-sm font-medium tabular-nums text-dr3-mist sm:col-span-3">
          {arrivalLabel}
        </span>
        <span className="col-span-6 truncate text-sm text-dr3-mist sm:col-span-2">
          {load.source_name ?? '—'}
        </span>
        <span className="col-span-6 truncate text-sm text-dr3-mist-dim sm:col-span-2">
          {load.operator_name ?? (
            <span className="text-dr3-mist-dim/70">{t('loads.row_unassigned')}</span>
          )}
        </span>
        <span className="col-span-6 truncate text-sm text-dr3-mist-dim sm:col-span-2">
          {load.transporter_name ?? '—'}
        </span>
        <span className="col-span-3 truncate font-mono text-xs text-dr3-mist-dim sm:col-span-1">
          {load.bol_number ?? '—'}
        </span>
        <span className="col-span-2 text-right text-sm tabular-nums text-dr3-mist sm:col-span-1">
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
