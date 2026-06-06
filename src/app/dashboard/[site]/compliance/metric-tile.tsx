'use client';

import Link from 'next/link';
import type { ComplianceBucket } from '@/lib/compliance';
import { useT } from '@/i18n/provider';

// SPRINT-1-PLAN T-012 — single tile in the compliance grid.
//
// Renders the metric headline + threshold + caption + click-through. The
// whole tile is one anchor (T-011's load-row pattern) so the entire
// surface is the click target — easier to hit on a touchpad and clearer
// affordance for the manager.
//
// Color bands carry the grading semantics; on the dark Vision theme the
// status hues stay deliberately non-brand so green/amber/red read as
// status, not decoration:
//   green  → emerald wash        (meets threshold)
//   yellow → amber wash          (within 5pp; explicit warning hue)
//   red    → rose wash           (below threshold-5pp; explicit alert hue)
//   pending→ neutral steel wash  (data source not yet wired; no grading)
//
// The "ok" hue is emerald (not brand cyan) so a passing metric reads as a
// distinct status colour against the cyan chrome, matching the
// reconciliation tone scale (emerald/amber/rose).
//
// Per CLAUDE.md hard rule #10 navigation is a Next <Link>, not a form.

const BUCKET_BG: Record<ComplianceBucket, string> = {
  green: 'bg-emerald-500/15 ring-1 ring-emerald-400/30 hover:bg-emerald-500/25',
  yellow: 'bg-amber-500/15 ring-1 ring-amber-400/30 hover:bg-amber-500/25',
  red: 'bg-rose-500/15 ring-1 ring-rose-400/30 hover:bg-rose-500/25',
  pending: 'bg-dr3-space-2 ring-1 ring-dr3-steel-light/25 hover:bg-dr3-steel/40',
};

const BUCKET_DOT: Record<ComplianceBucket, string> = {
  green: 'bg-emerald-400',
  yellow: 'bg-amber-400',
  red: 'bg-rose-400',
  pending: 'bg-dr3-mist-dim/50',
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
  const t = useT();
  const valueDisplay = bucket === 'pending' ? '—' : formatValue(value, unit);
  const thresholdDisplay = formatThreshold(threshold, unit, t);

  const bucketLabels: Record<ComplianceBucket, string> = {
    green: t('compliance_tile.bucket_green'),
    yellow: t('compliance_tile.bucket_yellow'),
    red: t('compliance_tile.bucket_red'),
    pending: t('compliance_tile.bucket_pending'),
  };

  const scopeText =
    bucket === 'pending'
      ? t('compliance_tile.scope_pending')
      : t('compliance_tile.scope_count', {
          count: rowCount.toLocaleString(),
          unit:
            unit === 'units'
              ? t('compliance_tile.unit_units')
              : rowCount === 1
                ? t('compliance_tile.unit_load_one')
                : t('compliance_tile.unit_load_other'),
        });

  return (
    <Link
      href={clickThroughHref}
      aria-label={`${title}: ${valueDisplay}, ${t('compliance_tile.target_label')} ${thresholdDisplay}, ${bucketLabels[bucket]}`}
      className={`group flex h-full flex-col gap-3 rounded-lg p-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-dr3-cyan ${BUCKET_BG[bucket]}`}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-dr3-mist">{title}</h2>
        <span
          className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${BUCKET_DOT[bucket]}`}
          aria-hidden="true"
        />
      </header>

      <p className="flex items-baseline gap-1">
        <span className="font-mono text-4xl font-bold tabular-nums text-dr3-mist">
          {valueDisplay}
        </span>
        {unit && bucket !== 'pending' && (
          <span className="text-lg font-medium text-dr3-mist-dim">{unit === '%' ? '%' : ''}</span>
        )}
      </p>

      <p className="text-xs text-dr3-mist-dim">
        {t('compliance_tile.target_label')} {thresholdDisplay}
      </p>

      {caption && <p className="text-xs leading-snug text-dr3-mist-dim">{caption}</p>}

      <p className="mt-auto text-[11px] uppercase tracking-wide text-dr3-mist-dim/70">
        {scopeText}
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

function formatThreshold(
  threshold: number,
  unit: '%' | 'units' | 'yrs' | '',
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (unit === 'units')
    return t('compliance_tile.threshold_units', { value: threshold.toLocaleString() });
  if (unit === 'yrs') return t('compliance_tile.threshold_yrs', { value: threshold });
  if (unit === '%') return t('compliance_tile.threshold_pct', { value: threshold });
  return threshold.toString();
}
