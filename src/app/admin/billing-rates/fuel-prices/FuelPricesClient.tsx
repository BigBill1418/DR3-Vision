'use client';

// ADR-0040 D5 — fuel_prices: list (EIA vs manual) + manual entry (audited overwrite).
// CLAUDE.md hard rule #10: onClick handlers only, no `<form>` element.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FuelPriceDto } from '@/lib/billing-rates/admin-rates';
import { rateMessages as M } from '../messages';
import { todayISO } from '../format';
import { ErrorBanner, Field, SuccessBanner, inputCls, primaryBtnCls } from '../ui';

export function FuelPricesClient({ prices, canWrite }: { prices: FuelPriceDto[]; canWrite: boolean }) {
  const router = useRouter();
  const [banner, setBanner] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-8">
      {banner ? <SuccessBanner message={banner} testid="fuel-banner" /> : null}

      <p className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-4 py-2 text-sm text-dr3-mist-dim" data-testid="fuel-overwrite-note">
        {M.fuel.manualOverwriteNote}
      </p>

      {prices.length === 0 ? (
        <p className="text-sm text-dr3-mist-dim" data-testid="fuel-empty">
          {M.fuel.empty}
        </p>
      ) : (
        <table className="w-full text-left text-sm" data-testid="fuel-table">
          <thead className="text-xs uppercase tracking-wider text-dr3-cyan">
            <tr>
              <th className="py-2 pr-4">{M.fuel.columnWeek}</th>
              <th className="py-2 pr-4">{M.fuel.columnPrice}</th>
              <th className="py-2 pr-4">{M.fuel.columnSource}</th>
              <th className="py-2 pr-4">{M.fuel.columnFetched}</th>
              <th className="py-2">{M.fuel.columnNote}</th>
            </tr>
          </thead>
          <tbody>
            {prices.map((p) => (
              <tr key={p.id} className="border-t border-dr3-steel-light/15" data-testid="fuel-row">
                <td className="py-2 pr-4">{p.week_of}</td>
                <td className="py-2 pr-4">${p.usd_per_gal}</td>
                <td className="py-2 pr-4">
                  {p.source === 'manual' ? (
                    <span className="rounded-full bg-dr3-cyan/15 px-2 py-0.5 text-xs font-medium text-dr3-cyan ring-1 ring-dr3-cyan/30" data-testid="fuel-source-manual">
                      {M.fuel.sourceManual}
                    </span>
                  ) : (
                    <span className="rounded-full border border-dr3-steel-light/30 px-2 py-0.5 text-xs text-dr3-mist-dim" data-testid="fuel-source-eia">
                      {M.fuel.sourceEia}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-dr3-mist-dim">{new Date(p.fetched_at).toLocaleString('en-US')}</td>
                <td className="py-2 text-dr3-mist-dim">{p.note ?? M.common.dash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite ? (
        <ManualEntry
          onSaved={(msg) => {
            setBanner(msg);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function ManualEntry({ onSaved }: { onSaved: (msg: string) => void }) {
  const [weekOf, setWeekOf] = useState(todayISO());
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSave = async () => {
    setError(null);
    if (!weekOf) {
      setError(M.fuel.weekRequired);
      return;
    }
    const usd = Number(price.trim().replace(/^\$/, ''));
    if (!Number.isFinite(usd) || usd <= 0 || usd >= 100) {
      setError(M.fuel.invalidPrice);
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/admin/billing-rates/fuel-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week_of: weekOf, usd_per_gal: usd, note: note.trim() || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.common.serverError);
        return;
      }
      setPrice('');
      setNote('');
      onSaved(M.fuel.savedOk);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4" data-testid="fuel-create">
      <h2 className="text-lg font-semibold">{M.fuel.createHeading}</h2>
      {error ? <ErrorBanner message={error} testid="fuel-create-error" /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={M.fuel.weekOf} helper={M.fuel.weekOfHelp}>
          <input type="date" value={weekOf} onChange={(e) => setWeekOf(e.target.value)} className={inputCls} data-testid="fuel-week" />
        </Field>
        <Field label={M.fuel.usdPerGal}>
          <input type="number" inputMode="decimal" step="0.001" value={price} onChange={(e) => setPrice(e.target.value)} className={inputCls} data-testid="fuel-price" />
        </Field>
        <Field label={M.common.note}>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={M.common.notePlaceholder} className={inputCls} data-testid="fuel-note" />
        </Field>
      </div>
      <div>
        <button type="button" onClick={handleSave} disabled={pending} className={primaryBtnCls} data-testid="fuel-create-submit">
          {pending ? M.common.saving : M.common.create}
        </button>
      </div>
    </section>
  );
}
