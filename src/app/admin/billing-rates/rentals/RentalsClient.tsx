'use client';

// ADR-0040 D5 — container_rental_sites: list + create + edit + active toggle.
// CLAUDE.md hard rule #10: onClick handlers only, no `<form>` element.

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { RentalDto } from '@/lib/billing-rates/admin-rates';
import { rateMessages as M } from '../messages';
import { formatCents, inForce, parseDollarsToCents, parseIntOrNaN, todayISO } from '../format';
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

export function RentalsClient({
  rentals,
  sources,
  sites,
  canWrite,
}: {
  rentals: RentalDto[];
  sources: SourceOpt[];
  sites: SiteOpt[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  const monthlyTotalCents = useMemo(
    () =>
      rentals
        .filter((r) => r.active && inForce(r.effective_from, r.effective_to))
        .reduce((sum, r) => sum + r.monthly_rate_cents, 0),
    [rentals],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const siteName = (id: string) => siteById.get(id)?.name ?? id;
  const sourceName = (id: string | null) => (id ? (sourceById.get(id)?.name ?? id) : M.common.dash);

  return (
    <section className="flex flex-col gap-8">
      {banner ? <SuccessBanner message={banner} testid="rental-banner" /> : null}

      <div className="rounded-md border border-dr3-cyan/30 bg-dr3-space-2 p-4" data-testid="rental-monthly-total">
        <span className="text-xs uppercase tracking-wider text-dr3-cyan">{M.rentals.monthlyTotalLabel}</span>
        <p className="text-2xl font-bold">{formatCents(monthlyTotalCents)}</p>
      </div>

      {rentals.length === 0 ? (
        <div className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-6" data-testid="rental-empty">
          <h2 className="text-lg font-semibold">{M.rentals.emptyHeading}</h2>
          <p className="mt-1 text-sm text-dr3-mist-dim">{M.rentals.emptyBody}</p>
        </div>
      ) : (
        <table className="w-full text-left text-sm" data-testid="rental-table">
          <thead className="text-xs uppercase tracking-wider text-dr3-cyan">
            <tr>
              <th className="py-2 pr-4">{M.rentals.columnSite}</th>
              <th className="py-2 pr-4">{M.rentals.columnLocation}</th>
              <th className="py-2 pr-4">{M.rentals.columnTrailers}</th>
              <th className="py-2 pr-4">{M.rentals.columnMonthly}</th>
              <th className="py-2 pr-4">{M.rentals.columnActive}</th>
              <th className="py-2 pr-4">{M.rentals.columnEffective}</th>
              {canWrite ? <th className="py-2">{M.rentals.columnActions}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rentals.map((r) =>
              editingId === r.id ? (
                <EditRentalRow
                  key={r.id}
                  rental={r}
                  sources={sources}
                  sourceName={sourceName}
                  siteName={siteName(r.site_id)}
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
                <tr key={r.id} className="border-t border-dr3-steel-light/15" data-testid="rental-row">
                  <td className="py-2 pr-4">{siteName(r.site_id)}</td>
                  <td className="py-2 pr-4">
                    {r.location_name}
                    <span className="block text-xs text-dr3-mist-dim">{sourceName(r.source_id)}</span>
                  </td>
                  <td className="py-2 pr-4">
                    {r.trailer_count}
                    {r.trailer_size ? ` · ${r.trailer_size}` : ''}
                  </td>
                  <td className="py-2 pr-4">{formatCents(r.monthly_rate_cents)}</td>
                  <td className="py-2 pr-4">
                    {r.active && inForce(r.effective_from, r.effective_to) ? (
                      <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-100">{M.rentals.inForceBadge}</span>
                    ) : (
                      <span className="rounded-full border border-dr3-steel-light/30 px-2 py-0.5 text-xs text-dr3-mist-dim">{M.rentals.inactiveBadge}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {r.effective_from} → {r.effective_to ?? M.common.effectiveToOpen}
                  </td>
                  {canWrite ? (
                    <td className="py-2">
                      <button type="button" onClick={() => setEditingId(r.id)} className={ghostBtnCls} data-testid="rental-edit">
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
        <CreateRental
          sites={sites}
          sources={sources}
          onCreated={(msg) => {
            setBanner(msg);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

interface RentalFields {
  site_id: string;
  location_name: string;
  source_id: string;
  trailer_count: string;
  trailer_size: string;
  monthly_rate: string;
  active: boolean;
  effective_from: string;
  effective_to: string;
  note: string;
}

function CreateRental({
  sites,
  sources,
  onCreated,
}: {
  sites: SiteOpt[];
  sources: SourceOpt[];
  onCreated: (msg: string) => void;
}) {
  const [f, setF] = useState<RentalFields>({
    site_id: sites[0]?.id ?? '',
    location_name: '',
    source_id: '',
    trailer_count: '0',
    trailer_size: '',
    monthly_rate: '',
    active: true,
    effective_from: todayISO(),
    effective_to: '',
    note: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<RentalFields>) => setF((p) => ({ ...p, ...patch }));

  const handleCreate = async () => {
    setError(null);
    if (!f.site_id) return setError(M.rentals.siteRequired);
    if (!f.location_name.trim()) return setError(M.rentals.locationRequired);
    const cents = parseDollarsToCents(f.monthly_rate);
    if (cents === null || cents <= 0) return setError(M.rentals.invalidRate);
    const count = parseIntOrNaN(f.trailer_count);
    setPending(true);
    try {
      const res = await fetch('/api/admin/billing-rates/rentals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: f.site_id,
          location_name: f.location_name.trim(),
          source_id: f.source_id || null,
          trailer_count: Number.isInteger(count) ? count : 0,
          trailer_size: f.trailer_size.trim() || null,
          monthly_rate_cents: cents,
          active: f.active,
          effective_from: f.effective_from,
          effective_to: f.effective_to || null,
          note: f.note.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? M.common.serverError);
        return;
      }
      set({ location_name: '', source_id: '', trailer_count: '0', trailer_size: '', monthly_rate: '', effective_to: '', note: '' });
      onCreated(M.rentals.savedOk);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-4" data-testid="rental-create">
      <h2 className="text-lg font-semibold">{M.rentals.createHeading}</h2>
      {error ? <ErrorBanner message={error} testid="rental-create-error" /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={M.rentals.site}>
          <select value={f.site_id} onChange={(e) => set({ site_id: e.target.value })} className={inputCls} data-testid="rental-site">
            {sites.map((s) => (
              <option key={s.id} value={s.id} className="text-dr3-space">
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={M.rentals.location}>
          <input type="text" value={f.location_name} onChange={(e) => set({ location_name: e.target.value })} className={inputCls} data-testid="rental-location" />
        </Field>
        <Field label={M.rentals.account}>
          <select value={f.source_id} onChange={(e) => set({ source_id: e.target.value })} className={inputCls} data-testid="rental-source">
            <option value="" className="text-dr3-space">
              {M.rentals.accountNone}
            </option>
            {sources.map((s) => (
              <option key={s.id} value={s.id} className="text-dr3-space">
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={M.rentals.trailerCount}>
          <input type="number" inputMode="numeric" value={f.trailer_count} onChange={(e) => set({ trailer_count: e.target.value })} className={inputCls} data-testid="rental-trailer-count" />
        </Field>
        <Field label={M.rentals.trailerSize}>
          <input type="text" value={f.trailer_size} onChange={(e) => set({ trailer_size: e.target.value })} className={inputCls} data-testid="rental-trailer-size" />
        </Field>
        <Field label={M.rentals.monthlyRate}>
          <input type="number" inputMode="decimal" step="0.01" value={f.monthly_rate} onChange={(e) => set({ monthly_rate: e.target.value })} className={inputCls} data-testid="rental-monthly-rate" />
        </Field>
        <Field label={M.common.effectiveFrom}>
          <input type="date" value={f.effective_from} onChange={(e) => set({ effective_from: e.target.value })} className={inputCls} data-testid="rental-effective-from" />
        </Field>
        <Field label={M.common.effectiveTo}>
          <input type="date" value={f.effective_to} onChange={(e) => set({ effective_to: e.target.value })} className={inputCls} data-testid="rental-effective-to" />
        </Field>
        <Field label={M.common.note}>
          <input type="text" value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder={M.common.notePlaceholder} className={inputCls} data-testid="rental-note" />
        </Field>
      </div>
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={f.active}
          onChange={(e) => set({ active: e.target.checked })}
          className="h-4 w-4 rounded border-dr3-steel-light/40 bg-dr3-space-2 text-dr3-cyan focus:ring-2 focus:ring-dr3-cyan"
          data-testid="rental-active"
        />
        <span className="text-sm text-dr3-mist">{M.rentals.active}</span>
      </label>
      <div>
        <button type="button" onClick={handleCreate} disabled={pending} className={primaryBtnCls} data-testid="rental-create-submit">
          {pending ? M.common.saving : M.common.create}
        </button>
      </div>
    </section>
  );
}

function EditRentalRow({
  rental,
  sources,
  sourceName,
  siteName,
  showActions,
  onDone,
}: {
  rental: RentalDto;
  sources: SourceOpt[];
  sourceName: (id: string | null) => string;
  siteName: string;
  showActions: boolean;
  onDone: (msg: string | null) => void;
}) {
  void sourceName;
  const [locationName, setLocationName] = useState(rental.location_name);
  const [sourceId, setSourceId] = useState(rental.source_id ?? '');
  const [trailerCount, setTrailerCount] = useState(String(rental.trailer_count));
  const [trailerSize, setTrailerSize] = useState(rental.trailer_size ?? '');
  const [monthlyRate, setMonthlyRate] = useState((rental.monthly_rate_cents / 100).toFixed(2));
  const [active, setActive] = useState(rental.active);
  const [effectiveFrom, setEffectiveFrom] = useState(rental.effective_from);
  const [effectiveTo, setEffectiveTo] = useState(rental.effective_to ?? '');
  const [note, setNote] = useState(rental.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSave = async () => {
    setError(null);
    if (!locationName.trim()) return setError(M.rentals.locationRequired);
    const cents = parseDollarsToCents(monthlyRate);
    if (cents === null || cents <= 0) return setError(M.rentals.invalidRate);
    const count = parseIntOrNaN(trailerCount);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/billing-rates/rentals/${rental.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_name: locationName.trim(),
          source_id: sourceId || null,
          trailer_count: Number.isInteger(count) ? count : 0,
          trailer_size: trailerSize.trim() || null,
          monthly_rate_cents: cents,
          active,
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
      onDone(M.rentals.savedOk);
    } finally {
      setPending(false);
    }
  };

  return (
    <tr className="border-t border-dr3-steel-light/15 align-top" data-testid="rental-edit-row">
      <td className="py-2 pr-4">{siteName}</td>
      <td className="py-2 pr-4">
        <div className="flex flex-col gap-1">
          <input type="text" value={locationName} onChange={(e) => setLocationName(e.target.value)} className={inputCls} data-testid="rental-edit-location" />
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={inputCls} data-testid="rental-edit-source">
            <option value="" className="text-dr3-space">
              {M.rentals.accountNone}
            </option>
            {sources.map((s) => (
              <option key={s.id} value={s.id} className="text-dr3-space">
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </td>
      <td className="py-2 pr-4">
        <div className="flex flex-col gap-1">
          <input type="number" inputMode="numeric" value={trailerCount} onChange={(e) => setTrailerCount(e.target.value)} className={`${inputCls} w-24`} data-testid="rental-edit-count" />
          <input type="text" value={trailerSize} onChange={(e) => setTrailerSize(e.target.value)} className={`${inputCls} w-28`} data-testid="rental-edit-size" />
        </div>
      </td>
      <td className="py-2 pr-4">
        <input type="number" inputMode="decimal" step="0.01" value={monthlyRate} onChange={(e) => setMonthlyRate(e.target.value)} className={`${inputCls} w-28`} data-testid="rental-edit-monthly" />
      </td>
      <td className="py-2 pr-4">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="h-4 w-4 rounded border-dr3-steel-light/40 bg-dr3-space-2 text-dr3-cyan focus:ring-2 focus:ring-dr3-cyan"
          data-testid="rental-edit-active"
        />
      </td>
      <td className="py-2 pr-4">
        <div className="flex flex-col gap-1">
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inputCls} data-testid="rental-edit-from" />
          <input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} className={inputCls} data-testid="rental-edit-to" />
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={M.common.notePlaceholder} className={inputCls} data-testid="rental-edit-note" />
          {error ? <span className="text-xs text-red-200">{error}</span> : null}
        </div>
      </td>
      {showActions ? (
        <td className="py-2">
          <div className="flex flex-col gap-2">
            <button type="button" onClick={handleSave} disabled={pending} className={primaryBtnCls} data-testid="rental-edit-save">
              {pending ? M.common.saving : M.common.save}
            </button>
            <button type="button" onClick={() => onDone(null)} className={secondaryBtnCls} data-testid="rental-edit-cancel">
              {M.common.cancel}
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}
