'use client';

// Sprint-1 T-016 — sortable table grouped by category, with per-row
// resolution actions.
//
// CLAUDE.md hard rule #10 — no <form> elements; resolution buttons
// post via fetch on click.
//
// Each row exposes three resolution buttons:
//   • DR3-Vision is correct      -> 'dr3_correct'
//   • MyMRC is correct           -> 'mymrc_correct'
//   • Flag for follow-up         -> 'flag_followup'
//
// Clicking writes one mymrc_reconciliation_items row update + one
// audit_log entry server-side. The button label flips to the chosen
// resolution; subsequent clicks change the resolution and append a
// new audit row. Notes are optional via a small expandable textarea.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

export type StatusKey =
  | 'match_clean'
  | 'weight_mismatch'
  | 'count_mismatch'
  | 'missing_in_dr3'
  | 'missing_in_mymrc';

export type ResolutionKey = 'unresolved' | 'dr3_correct' | 'mymrc_correct' | 'flag_followup';

export interface SerializableItem {
  id: string;
  external_haul_id: string;
  external_delivery_date: string | null;
  external_source_name: string | null;
  external_unit_count: number | null;
  external_weight_lbs: number | null;
  matched_load_id: string | null;
  dr3_unit_count: number | null;
  dr3_weight_lbs: number | null;
  status: string; // narrowed at runtime to StatusKey via STATUS_ORDER lookup
  resolution: string; // narrowed at runtime to ResolutionKey
  resolution_notes: string | null;
  resolved_at: string | null;
}

interface Props {
  siteCode: string;
  items: SerializableItem[];
}

const STATUS_ORDER: StatusKey[] = [
  'count_mismatch',
  'weight_mismatch',
  'missing_in_dr3',
  'missing_in_mymrc',
  'match_clean',
];

const STATUS_LABEL: Record<StatusKey, string> = {
  match_clean: 'Clean match',
  weight_mismatch: 'Weight mismatch',
  count_mismatch: 'Count mismatch',
  missing_in_dr3: 'Missing in DR3',
  missing_in_mymrc: 'Missing in MyMRC',
};

const STATUS_TONE: Record<StatusKey, string> = {
  match_clean: 'border-emerald-700/50 bg-emerald-900/20',
  weight_mismatch: 'border-amber-700/50 bg-amber-900/20',
  count_mismatch: 'border-amber-700/50 bg-amber-900/20',
  missing_in_dr3: 'border-rose-700/50 bg-rose-900/20',
  missing_in_mymrc: 'border-rose-700/50 bg-rose-900/20',
};

const RESOLUTION_LABEL: Record<ResolutionKey, string> = {
  unresolved: 'Unresolved',
  dr3_correct: 'DR3-Vision is correct',
  mymrc_correct: 'MyMRC is correct',
  flag_followup: 'Flagged for follow-up',
};

function isStatus(s: string): s is StatusKey {
  return (STATUS_ORDER as string[]).includes(s);
}

export function ReconciliationTable({ siteCode, items }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<StatusKey, SerializableItem[]>();
    for (const k of STATUS_ORDER) map.set(k, []);
    for (const it of items) {
      if (isStatus(it.status)) map.get(it.status)!.push(it);
    }
    return map;
  }, [items]);

  return (
    <section className="flex flex-col gap-6" data-testid="reconciliation-table">
      {STATUS_ORDER.map((key) => {
        const rows = grouped.get(key) ?? [];
        if (rows.length === 0) return null;
        return <CategoryGroup key={key} statusKey={key} rows={rows} siteCode={siteCode} />;
      })}
      {items.length === 0 ? (
        <p className="rounded-md bg-dr3-green-dark/30 px-4 py-3 text-sm text-dr3-cream/70">
          No items in this session.
        </p>
      ) : null}
    </section>
  );
}

function CategoryGroup({
  statusKey,
  rows,
  siteCode,
}: {
  statusKey: StatusKey;
  rows: SerializableItem[];
  siteCode: string;
}) {
  type SortKey = 'haul' | 'date' | 'units' | 'weight';
  const [sortKey, setSortKey] = useState<SortKey>('haul');
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'haul') cmp = a.external_haul_id.localeCompare(b.external_haul_id);
      else if (sortKey === 'date')
        cmp = (a.external_delivery_date ?? '').localeCompare(b.external_delivery_date ?? '');
      else if (sortKey === 'units')
        cmp = numberCmp(
          a.external_unit_count ?? a.dr3_unit_count,
          b.external_unit_count ?? b.dr3_unit_count
        );
      else if (sortKey === 'weight')
        cmp = numberCmp(
          a.external_weight_lbs ?? a.dr3_weight_lbs,
          b.external_weight_lbs ?? b.dr3_weight_lbs
        );
      return asc ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, asc]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(true);
    }
  };

  return (
    <div
      className={`flex flex-col gap-3 rounded-md border p-4 ${STATUS_TONE[statusKey]}`}
      data-testid={`reconciliation-group-${statusKey}`}
    >
      <header className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">
          {STATUS_LABEL[statusKey]}{' '}
          <span className="text-sm font-normal text-dr3-cream/70">({rows.length})</span>
        </h3>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-dr3-cream/70">
              <SortHeader
                label="Haul ID"
                active={sortKey === 'haul'}
                asc={asc}
                onClick={() => toggleSort('haul')}
              />
              <SortHeader
                label="Delivery date"
                active={sortKey === 'date'}
                asc={asc}
                onClick={() => toggleSort('date')}
              />
              <th className="px-2 py-1">Source</th>
              <SortHeader
                label="Units (CSV / DR3)"
                active={sortKey === 'units'}
                asc={asc}
                onClick={() => toggleSort('units')}
              />
              <SortHeader
                label="Weight lbs (CSV / DR3)"
                active={sortKey === 'weight'}
                asc={asc}
                onClick={() => toggleSort('weight')}
              />
              <th className="px-2 py-1">Resolution</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <ItemRow key={row.id} row={row} siteCode={siteCode} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  active,
  asc,
  onClick,
}: {
  label: string;
  active: boolean;
  asc: boolean;
  onClick: () => void;
}) {
  return (
    <th className="px-2 py-1">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-dr3-cream/70 hover:text-dr3-cream"
      >
        {label}
        {active ? <span aria-hidden>{asc ? '▲' : '▼'}</span> : null}
      </button>
    </th>
  );
}

function numberCmp(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  return a - b;
}

function ItemRow({ row, siteCode }: { row: SerializableItem; siteCode: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState<string>(row.resolution_notes ?? '');
  const [localResolution, setLocalResolution] = useState<ResolutionKey>(
    (row.resolution as ResolutionKey) ?? 'unresolved'
  );

  const submitResolution = async (choice: Exclude<ResolutionKey, 'unresolved'>) => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/reconciliation/${siteCode}/items/${row.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: choice, notes: notes || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Resolution failed.');
        return;
      }
      setLocalResolution(choice);
      router.refresh();
    } catch (resolveErr) {
      setError(resolveErr instanceof Error ? resolveErr.message : 'Resolution failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <tr className="border-t border-dr3-cream/10" data-testid={`reconciliation-row-${row.id}`}>
        <td className="px-2 py-2 font-mono text-xs">{row.external_haul_id}</td>
        <td className="px-2 py-2">{row.external_delivery_date ?? '—'}</td>
        <td className="px-2 py-2">{row.external_source_name ?? '—'}</td>
        <td className="px-2 py-2">
          {fmtNum(row.external_unit_count)} / {fmtNum(row.dr3_unit_count)}
        </td>
        <td className="px-2 py-2">
          {fmtNum(row.external_weight_lbs)} / {fmtNum(row.dr3_weight_lbs)}
        </td>
        <td className="px-2 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <ResolveButton
              label="DR3 ✓"
              active={localResolution === 'dr3_correct'}
              pending={pending}
              onClick={() => submitResolution('dr3_correct')}
              testId={`resolve-dr3-${row.id}`}
            />
            <ResolveButton
              label="MyMRC ✓"
              active={localResolution === 'mymrc_correct'}
              pending={pending}
              onClick={() => submitResolution('mymrc_correct')}
              testId={`resolve-mymrc-${row.id}`}
            />
            <ResolveButton
              label="Flag"
              active={localResolution === 'flag_followup'}
              pending={pending}
              onClick={() => submitResolution('flag_followup')}
              testId={`resolve-flag-${row.id}`}
            />
            <button
              type="button"
              onClick={() => setShowNotes((v) => !v)}
              className="text-[10px] text-dr3-cream/60 underline-offset-4 hover:text-dr3-cream hover:underline"
            >
              notes
            </button>
          </div>
          {localResolution !== 'unresolved' ? (
            <p className="mt-1 text-[10px] text-dr3-cream/60">
              {RESOLUTION_LABEL[localResolution]}
            </p>
          ) : null}
        </td>
      </tr>
      {showNotes ? (
        <tr>
          <td colSpan={6} className="px-2 pb-3">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes (saved with the next resolution click)"
              rows={2}
              className="w-full rounded-md bg-dr3-green-dark/30 px-2 py-1 text-xs text-dr3-cream"
              data-testid={`resolve-notes-${row.id}`}
            />
          </td>
        </tr>
      ) : null}
      {error ? (
        <tr>
          <td colSpan={6} className="px-2 pb-2 text-xs text-rose-300" role="alert">
            {error}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ResolveButton({
  label,
  active,
  pending,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  pending: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      data-testid={testId}
      className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
        active
          ? 'bg-dr3-chartreuse text-dr3-ink'
          : 'bg-dr3-green-dark/50 text-dr3-cream hover:bg-dr3-green-dark/70'
      }`}
    >
      {label}
    </button>
  );
}

function fmtNum(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}
