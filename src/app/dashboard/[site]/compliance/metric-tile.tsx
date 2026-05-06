import Link from 'next/link';
import type { ComplianceBucket } from '@/lib/compliance';

// SPRINT-1-PLAN T-012 — single tile in the compliance grid.
//
// Renders the metric headline + threshold + caption + click-through. The
// whole tile is one anchor (T-011's load-row pattern) so the entire
// surface is the click target — easier to hit on a touchpad and clearer
// affordance for the manager.
//
// Color bands match the T-010 / T-011 convention:
//   green  → bg-dr3-green/20    (meets threshold; using the brand secondary)
//   yellow → bg-orange-400/30   (within 5pp; explicit warning hue, not brand)
//   red    → bg-red-500/30      (below threshold-5pp; explicit alert hue)
//   pending→ bg-dr3-cream/10    (data source not yet wired; no grading)
//
// Per ADR-0014 manager surfaces stay on the green palette; only the
// alert-state inserts (yellow/red) reach for non-brand hues, intentionally.
//
// Per CLAUDE.md hard rule #10 navigation is a Next <Link>, not a form.

const BUCKET_BG: Record<ComplianceBucket, string> = {
  green: 'bg-dr3-green/20 hover:bg-dr3-green/30',
  yellow: 'bg-orange-400/30 hover:bg-orange-400/40',
  red: 'bg-red-500/30 hover:bg-red-500/40',
  pending: 'bg-dr3-cream/10 hover:bg-dr3-cream/15',
};

const BUCKET_DOT: Record<ComplianceBucket, string> = {
  green: 'bg-dr3-green',
  yellow: 'bg-orange-400',
  red: 'bg-red-500',
  pending: 'bg-dr3-cream/40',
};

const BUCKET_LABEL: Record<ComplianceBucket, string> = {
  green: 'On target',
  yellow: 'Approaching threshold',
  red: 'Below threshold',
  pending: 'Pending data source',
};

type Props = {
  title: string;
  value: number;
  threshold: number;
  unit: '%' | 'units' | 'yrs' | '';
  bucket: ComplianceBucket;
  rowCount: number;
  clickThroughHref: string;
  caption?: string | undefined;
};

export function MetricTile({
  title,
  value,
  threshold,
  unit,
  bucket,
  rowCount,
  clickThroughHref,
  caption,
}: Props) {
  const valueDisplay = bucket === 'pending' ? '—' : formatValue(value, unit);
  const thresholdDisplay = formatThreshold(threshold, unit);

  return (
    <Link
      href={clickThroughHref}
      aria-label={`${title}: ${valueDisplay}, threshold ${thresholdDisplay}, ${BUCKET_LABEL[bucket]}`}
      className={`group flex h-full flex-col gap-3 rounded-lg p-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-dr3-chartreuse ${BUCKET_BG[bucket]}`}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-dr3-cream">
          {title}
        </h2>
        <span
          className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${BUCKET_DOT[bucket]}`}
          aria-hidden="true"
        />
      </header>

      <p className="flex items-baseline gap-1">
        <span className="font-mono text-4xl font-bold tabular-nums text-dr3-cream">
          {valueDisplay}
        </span>
        {unit && bucket !== 'pending' && (
          <span className="text-lg font-medium text-dr3-cream/70">{unit === '%' ? '%' : ''}</span>
        )}
      </p>

      <p className="text-xs text-dr3-cream/70">
        Target {thresholdDisplay}
      </p>

      {caption && <p className="text-xs leading-snug text-dr3-cream/60">{caption}</p>}

      <p className="mt-auto text-[11px] uppercase tracking-wide text-dr3-cream/50">
        {bucket === 'pending'
          ? 'No data — see caption'
          : `${rowCount.toLocaleString()} ${unit === 'units' ? 'units' : 'load' + (rowCount === 1 ? '' : 's')} in scope · view →`}
      </p>
    </Link>
  );
}

function formatValue(value: number, unit: '%' | 'units' | 'yrs' | ''): string {
  if (unit === 'units') return value.toLocaleString();
  if (unit === 'yrs') return value.toFixed(1);
  if (unit === '%') return value.toFixed(1);
  return value.toString();
}

function formatThreshold(threshold: number, unit: '%' | 'units' | 'yrs' | ''): string {
  if (unit === 'units') return `≤ ${threshold.toLocaleString()} units`;
  if (unit === 'yrs') return `${threshold} yr window`;
  if (unit === '%') return `≥ ${threshold}%`;
  return threshold.toString();
}
