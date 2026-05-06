'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition } from 'react';
import type { LoadStatus } from '@prisma/client';
import { useI18n } from '@/i18n/provider';
import { loadStatusLabel } from '@/lib/loads/labels';

// Filter bar for the load list. Per CLAUDE.md hard rule #10 every
// control is a button / select / input — never a <form>. Each change
// pushes the URL via router.push, so filter state lives in the URL
// (shareable, bookmarkable, back-button friendly) and the server
// component re-runs with the new params.
//
// Status labels are rendered through the shared `loadStatusLabel`
// helper in `@/lib/loads/labels` — same map that backs the row badge
// and the dock tile, so the three surfaces stay aligned.

const RANGE_KEYS = ['today', 'week', 'month', 'custom'] as const;
type RangeKey = (typeof RANGE_KEYS)[number];

export type LoadsFilterOption = { id: string; label: string };

type Props = {
  siteCode: string;
  range: RangeKey;
  from: string;
  to: string;
  statuses: LoadStatus[];
  allStatuses: LoadStatus[];
  sourceId: string | null;
  operatorId: string | null;
  transporterId: string | null;
  sourceOptions: LoadsFilterOption[];
  operatorOptions: LoadsFilterOption[];
  transporterOptions: LoadsFilterOption[];
};

export function LoadsFilters({
  range,
  from,
  to,
  statuses,
  allStatuses,
  sourceId,
  operatorId,
  transporterId,
  sourceOptions,
  operatorOptions,
  transporterOptions,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { t, dict } = useI18n();

  const rangeLabels: Record<RangeKey, string> = {
    today: t('loads.range_today'),
    week: t('loads.range_week'),
    month: t('loads.range_month'),
    custom: t('loads.range_custom'),
  };

  const updateParams = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    // Filter changes always reset pagination to page 1; otherwise the
    // user lands on an empty page when the result count shrinks.
    next.delete('page');
    const qs = next.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  const setRange = (next: string) => {
    updateParams((p) => {
      if (next === 'today') {
        p.delete('range');
      } else {
        p.set('range', next);
      }
      // Clear custom bounds whenever the user leaves the custom range.
      if (next !== 'custom') {
        p.delete('from');
        p.delete('to');
      }
    });
  };

  const setCustomBound = (which: 'from' | 'to', value: string) => {
    updateParams((p) => {
      if (value) {
        p.set(which, value);
      } else {
        p.delete(which);
      }
    });
  };

  const toggleStatus = (status: LoadStatus) => {
    const next = new Set(statuses);
    if (next.has(status)) {
      next.delete(status);
    } else {
      next.add(status);
    }
    updateParams((p) => {
      // Preserve the deterministic enum order so the URL is canonical.
      const ordered = allStatuses.filter((s) => next.has(s));
      if (ordered.length === 0) {
        // Empty string means "filter to nothing" — distinct from the
        // unset default. We encode it as an empty value so the server
        // parser can tell them apart.
        p.set('status', '');
      } else {
        p.set('status', ordered.join(','));
      }
    });
  };

  const setLookup = (key: 'source_id' | 'operator_id' | 'transporter_id', value: string) => {
    updateParams((p) => {
      if (value) {
        p.set(key, value);
      } else {
        p.delete(key);
      }
    });
  };

  return (
    <div
      className="flex flex-col gap-4 rounded-lg bg-dr3-green-dark/30 p-4"
      aria-busy={isPending}
    >
      {/* Range — segmented buttons */}
      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wide text-dr3-cream/60">
          {t('loads.filter_label_date_range')}
        </span>
        <div className="flex flex-wrap gap-2">
          {RANGE_KEYS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setRange(value)}
              disabled={isPending}
              aria-pressed={range === value}
              className={
                range === value
                  ? 'rounded-md bg-dr3-green px-3 py-1.5 text-sm font-semibold text-dr3-ink disabled:opacity-60'
                  : 'rounded-md bg-dr3-green-dark/60 px-3 py-1.5 text-sm font-medium text-dr3-cream hover:bg-dr3-green-dark/80 disabled:opacity-60'
              }
            >
              {rangeLabels[value]}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-dr3-cream/70">
              {t('loads.range_from')}
              <input
                type="date"
                value={from}
                disabled={isPending}
                onChange={(e) => setCustomBound('from', e.target.value)}
                className="rounded-md bg-dr3-green-dark/60 px-2 py-1 text-sm text-dr3-cream"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-dr3-cream/70">
              {t('loads.range_to')}
              <input
                type="date"
                value={to}
                disabled={isPending}
                onChange={(e) => setCustomBound('to', e.target.value)}
                className="rounded-md bg-dr3-green-dark/60 px-2 py-1 text-sm text-dr3-cream"
              />
            </label>
          </div>
        )}
      </div>

      {/* Status — toggle chips */}
      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wide text-dr3-cream/60">
          {t('loads.filter_label_status')}
        </span>
        <div className="flex flex-wrap gap-2">
          {allStatuses.map((s) => {
            const active = statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                disabled={isPending}
                aria-pressed={active}
                className={
                  active
                    ? 'rounded-full bg-dr3-chartreuse px-3 py-1 text-xs font-semibold text-dr3-ink disabled:opacity-60'
                    : 'rounded-full bg-dr3-green-dark/60 px-3 py-1 text-xs font-medium text-dr3-cream/80 hover:bg-dr3-green-dark/80 disabled:opacity-60'
                }
              >
                {loadStatusLabel(s, dict)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Lookup dropdowns */}
      <div className="grid gap-3 sm:grid-cols-3">
        <FilterSelect
          label={t('loads.filter_label_source')}
          value={sourceId ?? ''}
          options={sourceOptions}
          disabled={isPending}
          allLabel={t('loads.filter_all_option', { label: t('loads.filter_label_source') })}
          onChange={(v) => setLookup('source_id', v)}
        />
        <FilterSelect
          label={t('loads.filter_label_operator')}
          value={operatorId ?? ''}
          options={operatorOptions}
          disabled={isPending}
          allLabel={t('loads.filter_all_option', { label: t('loads.filter_label_operator') })}
          onChange={(v) => setLookup('operator_id', v)}
        />
        <FilterSelect
          label={t('loads.filter_label_transporter')}
          value={transporterId ?? ''}
          options={transporterOptions}
          disabled={isPending}
          allLabel={t('loads.filter_all_option', { label: t('loads.filter_label_transporter') })}
          onChange={(v) => setLookup('transporter_id', v)}
        />
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  disabled,
  allLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: LoadsFilterOption[];
  disabled: boolean;
  allLabel: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-dr3-cream/60">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md bg-dr3-green-dark/60 px-2 py-2 text-sm text-dr3-cream disabled:opacity-60"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
