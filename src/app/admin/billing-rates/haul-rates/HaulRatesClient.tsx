'use client';

// ADR-0040 D5 — account_haul_rates: list + create + edit.
// CLAUDE.md hard rule #10: onClick handlers only, no `<form>` element.

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { HaulRateDto } from '@/lib/billing-rates/admin-rates';
import { rateMessages as M } from '../messages';
import { formatCents, parseDollarsToCents, todayISO } from '../format';
import { ErrorBanner, Field, SuccessBanner, ghostBtnCls, inputCls, primaryBtnCls, secondaryBtnCls } from '../ui';

interface SourceOpt {
  id: string;
  name: string;
  site_id: string;
}
interface SiteOpt {
  id: string;
  code: string;
  name: string;
}

export function HaulRatesClient({
  rates,
  sources,
  sites,
  canWrite,
}: {
  rates: HaulRateDto[];
  sources: SourceOpt[];
  sites: SiteOpt[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);

  const accountLabel = (sourceId: string): string => {
    const src = sourceById.get(sourceId);
    if (!src) return sourceId;
    const site = siteById.get(src.site_id);
    return site ? `${src.name} · ${site.name}` : src.name;
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-8">
      {banner ? <SuccessBanner message={banner} testid="haul-banner" /> : null}

      {rates.length === 0 ? (
        <div
          className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-6"
          data-testid="haul-empty"
        >
          <h2 className="text-lg font-semibold">{M.haul.emptyHeading}</h2>
          <p className="mt-1 text-sm text-dr3-mist-dim">{M.haul.emptyBody}</p>
        </div>
      ) : (
        <table className="w-full text-left text-sm" data-testid="haul-table">
          <thead className="text-xs uppercase tracking-wider text-dr3-cyan">
            <tr>
              <th className="py-2 pr-4">{M.haul.columnAccount}</th>
              <th className="py-2 pr-4">{M.haul.columnRate}</th>
              <th className="py-2 pr-4">{M.haul.columnEffective}</th>
              <th className="py-2 pr-4">{M.haul.columnNote}</th>
              {canWrite ? <th className="py-2">{M.haul.columnActions}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rates.map((r) =>
              editingId === r.id ? (
                <EditRow
                  key={r.id}
                  rate={r}
                  accountLabel={accountLabel(r.source_id)}
                  showActions={canWrite}
                  onDone={(msg) => {
                    setEditingId(null);
                    if (msg) {
                      setBanner(msg);
                      router.refresh();
                    }
                  }}
                />
              ) : (
                <tr key={r.id} className="border-t border-dr3-steel-light/15" data-testid="haul-row">
                  <td className="py-2 pr-4">{accountLabel(r.source_id)}</td>
                  <td className="py-2 pr-4">{formatCents(r.rate_cents)}</td>
                  <td className="py-2 pr-4">
                    {r.effective_from} → {r.effective_to ?? M.common.effectiveToOpen}
                  </td>
                  <td className="py-2 pr-4 text-dr3-mist-dim">{r.note ?? M.common.dash}</td>
                  {canWrite ? (
                    <td className="py-2">
                      <button type="button" onClick={() => setEditingId(r.id)} className={ghostBtnCls} data-testid="haul-edit">
                        {M.common.edit}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      {canWrite ? (
        <CreateHaulRate
          sources={sources}
          accountLabel={accountLabel}
          onCreated={(msg) => {
            setBanner(msg);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function CreateHaulRate({
  sources,
  accountLabel,
  onCreated,
}: {
  sources: SourceOpt[];
  accountLabel: (id: string) => string;
  onCreated: (msg: string) => void;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [rate, setRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const [effectiveTo, setEffectiveTo] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleCreate = async () => {
    setError(null);
    if (!sourceId) {
      setError(M.haul.sourceRequired);
      return;
    }
    const cents = parseDollarsToCents(rate);
    if (cents === null || cents <= 0) {
      setError(M.haul.invalidRate);
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/admin/billing-rates/haul-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_id: sourceId,
          rate_cents: cents,
          effective_from: effectiveFrom,
          effective_to: effectiveTo || null,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.common.serverError);
        return;
      }
      setRate('');
      setEffectiveTo('');
      setNote('');
      onCreated(M.haul.savedOk);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4" data-testid="haul-create">
      <h2 className="text-lg font-semibold">{M.haul.createHeading}</h2>
      {error ? <ErrorBanner message={error} testid="haul-create-error" /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={M.haul.account}>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={inputCls} data-testid="haul-source">
            {sources.map((s) => (
              <option key={s.id} value={s.id} className="text-dr3-space">
                {accountLabel(s.id)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={M.haul.rate}>
          <input type="number" inputMode="decimal" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={inputCls} data-testid="haul-rate" />
        </Field>
        <Field label={M.common.effectiveFrom}>
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inputCls} data-testid="haul-effective-from" />
        </Field>
        <Field label={M.common.effectiveTo}>
          <input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} className={inputCls} data-testid="haul-effective-to" />
        </Field>
        <Field label={M.common.note}>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={M.common.notePlaceholder} className={inputCls} data-testid="haul-note" />
        </Field>
      </div>
      <div>
        <button type="button" onClick={handleCreate} disabled={pending} className={primaryBtnCls} data-testid="haul-create-submit">
          {pending ? M.common.saving : M.common.create}
        </button>
      </div>
    </section>
  );
}

function EditRow({
  rate,
  accountLabel,
  showActions,
  onDone,
}: {
  rate: HaulRateDto;
  accountLabel: string;
  showActions: boolean;
  onDone: (msg: string | null) => void;
}) {
  const [rateStr, setRateStr] = useState((rate.rate_cents / 100).toFixed(2));
  const [effectiveFrom, setEffectiveFrom] = useState(rate.effective_from);
  const [effectiveTo, setEffectiveTo] = useState(rate.effective_to ?? '');
  const [note, setNote] = useState(rate.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSave = async () => {
    setError(null);
    const cents = parseDollarsToCents(rateStr);
    if (cents === null || cents <= 0) {
      setError(M.haul.invalidRate);
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/admin/billing-rates/haul-rates/${rate.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rate_cents: cents,
          effective_from: effectiveFrom,
          effective_to: effectiveTo || null,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.common.serverError);
        return;
      }
      onDone(M.haul.savedOk);
    } finally {
      setPending(false);
    }
  };

  return (
    <tr className="border-t border-dr3-steel-light/15" data-testid="haul-edit-row">
      <td className="py-2 pr-4 align-top">{accountLabel}</td>
      <td className="py-2 pr-4 align-top">
        <input type="number" inputMode="decimal" step="0.01" value={rateStr} onChange={(e) => setRateStr(e.target.value)} className={`${inputCls} w-28`} data-testid="haul-edit-rate" />
      </td>
      <td className="py-2 pr-4 align-top">
        <div className="flex flex-col gap-1">
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inputCls} data-testid="haul-edit-from" />
          <input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} className={inputCls} data-testid="haul-edit-to" />
        </div>
      </td>
      <td className="py-2 pr-4 align-top">
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} data-testid="haul-edit-note" />
        {error ? <span className="mt-1 block text-xs text-red-200">{error}</span> : null}
      </td>
      {showActions ? (
        <td className="py-2 align-top">
          <div className="flex flex-col gap-2">
            <button type="button" onClick={handleSave} disabled={pending} className={primaryBtnCls} data-testid="haul-edit-save">
              {pending ? M.common.saving : M.common.save}
            </button>
            <button type="button" onClick={() => onDone(null)} className={secondaryBtnCls} data-testid="haul-edit-cancel">
              {M.common.cancel}
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}
