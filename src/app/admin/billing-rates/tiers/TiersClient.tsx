'use client';

// ADR-0040 D5 — transport rate tier editor.
//
// CLAUDE.md hard rule #10: no `<form>`, no submit handler — every action is a
// `<button onClick>`. The whole set for a (jurisdiction, effective-from) window
// is validated CLIENT-SIDE with the shared `validateTierSet` before POST, and
// the offending bands are rendered inline; the server re-validates authoritatively.

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { TierDto, FreightJurisdiction } from '@/lib/billing-rates/admin-rates';
import { validateTierSet, type ProposedTier, type TierProblem } from '@/lib/billing-rates/tier-validation';
import { rateMessages as M } from '../messages';
import { formatCents, parseDollarsToCents, parseIntOrNaN, tierProblemMessage, todayISO } from '../format';
import { ErrorBanner, Field, SuccessBanner, inputCls, primaryBtnCls, secondaryBtnCls } from '../ui';

interface EditorRow {
  id?: string;
  min: string;
  max: string;
  rate: string;
}

interface TierWindow {
  key: string;
  jurisdiction: FreightJurisdiction;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  rows: TierDto[];
}

type JFilter = 'ALL' | FreightJurisdiction;

function groupWindows(tiers: TierDto[]): TierWindow[] {
  const map = new Map<string, TierWindow>();
  for (const t of tiers) {
    const key = `${t.jurisdiction}|${t.effective_from}`;
    const existing = map.get(key);
    if (existing) {
      existing.rows.push(t);
    } else {
      map.set(key, {
        key,
        jurisdiction: t.jurisdiction,
        effective_from: t.effective_from,
        effective_to: t.effective_to,
        note: t.note,
        rows: [t],
      });
    }
  }
  return [...map.values()];
}

const emptyRow = (): EditorRow => ({ min: '', max: '', rate: '' });

export function TiersClient({ tiers, canWrite }: { tiers: TierDto[]; canWrite: boolean }) {
  const router = useRouter();
  const windows = useMemo(() => groupWindows(tiers), [tiers]);
  const [filter, setFilter] = useState<JFilter>('ALL');

  const [jurisdiction, setJurisdiction] = useState<FreightJurisdiction>('OR');
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const [effectiveTo, setEffectiveTo] = useState('');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<EditorRow[]>([emptyRow()]);
  const [problems, setProblems] = useState<TierProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const shown = filter === 'ALL' ? windows : windows.filter((w) => w.jurisdiction === filter);

  const setRow = (i: number, patch: Partial<EditorRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const loadWindow = (w: TierWindow) => {
    setJurisdiction(w.jurisdiction);
    setEffectiveFrom(w.effective_from);
    setEffectiveTo(w.effective_to ?? '');
    setNote(w.note ?? '');
    setRows(
      [...w.rows]
        .sort((a, b) => a.min_miles - b.min_miles)
        .map((r) => ({ id: r.id, min: String(r.min_miles), max: String(r.max_miles), rate: (r.rate_cents / 100).toFixed(2) })),
    );
    setProblems([]);
    setError(null);
    setSuccess(null);
  };

  const proposed = (): ProposedTier[] =>
    rows.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      min_miles: parseIntOrNaN(r.min),
      max_miles: parseIntOrNaN(r.max),
      rate_cents: parseDollarsToCents(r.rate) ?? Number.NaN,
    }));

  const handleSave = async () => {
    setError(null);
    setSuccess(null);
    const set = proposed();
    const found = validateTierSet(set);
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    setProblems([]);
    setPending(true);
    try {
      const res = await fetch('/api/admin/billing-rates/tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jurisdiction,
          effective_from: effectiveFrom,
          effective_to: effectiveTo || null,
          note: note.trim() || null,
          tiers: set.map((t) => ({ min_miles: t.min_miles, max_miles: t.max_miles, rate_cents: t.rate_cents })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: TierProblem[] };
        if (body.problems?.length) setProblems(body.problems);
        setError(body.error ?? M.common.serverError);
        return;
      }
      setSuccess(M.tiers.savedOk);
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-8">
      {/* Jurisdiction filter */}
      <div className="flex flex-wrap gap-2" data-testid="tiers-filter">
        {(['ALL', 'CA', 'OR'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === f
                ? 'bg-dr3-cyan text-dr3-space'
                : 'border border-dr3-steel-light/30 bg-dr3-space-2 text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan'
            }`}
          >
            {f === 'ALL' ? M.tiers.filterAll : f === 'CA' ? M.tiers.filterCA : M.tiers.filterOR}
          </button>
        ))}
      </div>

      {/* Existing windows */}
      {shown.length === 0 ? (
        <p className="text-sm text-dr3-mist-dim" data-testid="tiers-empty">
          {M.tiers.empty}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {shown.map((w) => (
            <div
              key={w.key}
              data-testid="tier-window"
              className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-lg font-semibold">
                    {M.tiers.windowHeading(
                      w.jurisdiction === 'CA' ? M.tiers.filterCA : M.tiers.filterOR,
                      w.effective_from,
                    )}
                  </h3>
                  <p className="text-xs text-dr3-mist-dim">
                    {M.common.effectiveTo}: {w.effective_to ?? M.common.effectiveToOpen}
                    {w.note ? ` · ${w.note}` : ''}
                  </p>
                </div>
                {canWrite ? (
                  <button type="button" onClick={() => loadWindow(w)} className={secondaryBtnCls} data-testid="tier-load">
                    {M.tiers.editThisSet}
                  </button>
                ) : null}
              </div>
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-dr3-cyan">
                  <tr>
                    <th className="py-1 pr-4">{M.tiers.minMiles}</th>
                    <th className="py-1 pr-4">{M.tiers.maxMiles}</th>
                    <th className="py-1">{M.tiers.rate}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...w.rows]
                    .sort((a, b) => a.min_miles - b.min_miles)
                    .map((r) => (
                      <tr key={r.id} className="border-t border-dr3-steel-light/15">
                        <td className="py-1.5 pr-4">{r.min_miles}</td>
                        <td className="py-1.5 pr-4">{r.max_miles}</td>
                        <td className="py-1.5">{formatCents(r.rate_cents)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {/* Editor */}
      {canWrite ? (
        <section
          className="flex flex-col gap-4 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4"
          data-testid="tier-editor"
        >
          <div>
            <h2 className="text-lg font-semibold">{M.tiers.editorHeading}</h2>
            <p className="text-xs text-dr3-mist-dim">{M.tiers.editorHelp}</p>
          </div>

          {error ? <ErrorBanner message={error} testid="tier-editor-error" /> : null}
          {success ? <SuccessBanner message={success} testid="tier-editor-success" /> : null}
          {problems.length > 0 ? (
            <div className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100" role="alert" data-testid="tier-problems">
              <p className="font-semibold">{M.tiers.validProblemsHeading}</p>
              <ul className="mt-1 list-disc pl-5">
                {problems.map((p, i) => (
                  <li key={i}>{tierProblemMessage(p)}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={M.tiers.jurisdiction}>
              <select
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value as FreightJurisdiction)}
                className={inputCls}
                data-testid="tier-jurisdiction"
              >
                <option value="OR" className="text-dr3-space">
                  {M.tiers.jurisdictionOR}
                </option>
                <option value="CA" className="text-dr3-space">
                  {M.tiers.jurisdictionCA}
                </option>
              </select>
            </Field>
            <Field label={M.common.note}>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={M.common.notePlaceholder}
                className={inputCls}
                data-testid="tier-note"
              />
            </Field>
            <Field label={M.common.effectiveFrom}>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className={inputCls}
                data-testid="tier-effective-from"
              />
            </Field>
            <Field label={M.common.effectiveTo}>
              <input
                type="date"
                value={effectiveTo}
                onChange={(e) => setEffectiveTo(e.target.value)}
                className={inputCls}
                data-testid="tier-effective-to"
              />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2" data-testid="tier-row">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-dr3-mist-dim">{M.tiers.rowLabel(i + 1)} · {M.tiers.minMiles}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={r.min}
                    onChange={(e) => setRow(i, { min: e.target.value })}
                    className={`${inputCls} w-28`}
                    data-testid="tier-row-min"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-dr3-mist-dim">{M.tiers.maxMiles}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={r.max}
                    onChange={(e) => setRow(i, { max: e.target.value })}
                    className={`${inputCls} w-28`}
                    data-testid="tier-row-max"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-dr3-mist-dim">{M.tiers.rate}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={r.rate}
                    onChange={(e) => setRow(i, { rate: e.target.value })}
                    className={`${inputCls} w-32`}
                    data-testid="tier-row-rate"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs))}
                  disabled={rows.length <= 1}
                  className={secondaryBtnCls}
                  data-testid="tier-row-remove"
                >
                  {M.tiers.removeRow}
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRows((rs) => [...rs, emptyRow()])}
              className={`${secondaryBtnCls} self-start`}
              data-testid="tier-add-row"
            >
              + {M.tiers.addRow}
            </button>
          </div>

          <div>
            <button
              type="button"
              onClick={handleSave}
              disabled={pending}
              className={primaryBtnCls}
              data-testid="tier-save"
            >
              {pending ? M.common.saving : M.tiers.validateAndSave}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
