'use client';

// handoff §1.8 — Yard view client (SCAFFOLD: list + add/edit, no workflow).
// CLAUDE.md hard rule #10 — no <form>; every handler is onClick/onChange. All
// user-facing strings go through `useT` under the `yard.*` namespace (hard rule #4;
// keys already seeded in EN/ES/UR). Working surface → green palette (ADR-0014/0008).

import { useCallback, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { YardTrailerStatus } from '@prisma/client';
import type { YardTrailerView, YardView } from '@/lib/yard/service';

const STATUSES: readonly YardTrailerStatus[] = ['on_yard', 'at_account', 'in_service'];

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls = 'rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';
const smallBtnCls =
  'rounded bg-dr3-cyan px-3 py-1 text-xs font-semibold text-black disabled:opacity-40';
const ghostBtnCls =
  'rounded border border-white/25 px-3 py-1 text-xs text-white/80 hover:text-white';

type Translate = ReturnType<typeof useT>;

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function YardClient({
  siteCode,
  siteName,
  initialView,
}: {
  siteCode: string;
  siteName: string;
  initialView: YardView;
}) {
  const t = useT();
  const [view, setView] = useState<YardView>(initialView);
  const [label, setLabel] = useState('');
  const [locationNote, setLocationNote] = useState('');
  const [status, setStatus] = useState<YardTrailerStatus>('on_yard');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch(`/api/manager/${siteCode}/yard`);
    if (res.ok) setView((await res.json()) as YardView);
  }, [siteCode]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/yard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, locationNote: locationNote || null, status }),
      });
      if (!res.ok) {
        setMsg({ kind: 'err', text: `${t('yard.save_failed')} (${res.status}).` });
        return;
      }
      setMsg({ kind: 'ok', text: t('yard.save_success') });
      setLabel('');
      setLocationNote('');
      setStatus('on_yard');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const canSave = label.trim() !== '';

  return (
    <div className="mt-4">
      <h1 className="text-3xl font-bold tracking-tight">{t('yard.heading')}</h1>
      <p className="mt-1 text-sm opacity-70">{t('yard.subtitle', { site: siteName })}</p>

      <p className="mt-6 text-sm">
        <span className="opacity-70">{t('yard.on_hand_label')}:</span>{' '}
        <span className="font-semibold text-dr3-cyan">{view.onHand}</span>
      </p>

      {/* Rental containers (read-only context) */}
      <section className="mt-8">
        <h2 className="text-xl font-semibold">{t('yard.rentals_heading')}</h2>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="opacity-70">
            <tr>
              <th className="py-2">{t('yard.rentals_location')}</th>
              <th className="py-2">{t('yard.rentals_trailers')}</th>
              <th className="py-2">{t('yard.rentals_size')}</th>
              <th className="py-2">{t('yard.rentals_monthly')}</th>
            </tr>
          </thead>
          <tbody>
            {view.rentals.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 opacity-70">
                  {t('yard.rentals_empty')}
                </td>
              </tr>
            )}
            {view.rentals.map((r) => (
              <tr key={r.id} className="border-t border-white/10">
                <td className="py-2">{r.locationName}</td>
                <td className="py-2">{r.trailerCount}</td>
                <td className="py-2">{r.trailerSize ?? '—'}</td>
                <td className="py-2">{money(r.monthlyRateCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Tracked trailers (add + inline edit) */}
      <section className="mt-10">
        <h2 className="text-xl font-semibold">{t('yard.trailers_heading')}</h2>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="opacity-70">
            <tr>
              <th className="py-2">{t('yard.col_label')}</th>
              <th className="py-2">{t('yard.col_location')}</th>
              <th className="py-2">{t('yard.col_status')}</th>
              <th className="py-2">{t('yard.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {view.trailers.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 opacity-70">
                  {t('yard.empty')}
                </td>
              </tr>
            )}
            {view.trailers.map((trailer) => (
              <TrailerRow
                key={trailer.id}
                siteCode={siteCode}
                trailer={trailer}
                t={t}
                onSaved={reload}
              />
            ))}
          </tbody>
        </table>
      </section>

      {/* Add trailer */}
      <section className="mt-10">
        <h2 className="text-xl font-semibold">{t('yard.add_heading')}</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className={labelCls}>
            <span className="opacity-70">{t('yard.col_label')}</span>
            <input
              className={inputCls}
              value={label}
              placeholder={t('yard.label_placeholder')}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">{t('yard.col_location')}</span>
            <input
              className={inputCls}
              value={locationNote}
              placeholder={t('yard.location_placeholder')}
              onChange={(e) => setLocationNote(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">{t('yard.col_status')}</span>
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as YardTrailerStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`yard.status_${s}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <button type="button" disabled={!canSave || busy} onClick={add} className={btnCls}>
            {busy ? t('yard.saving') : t('yard.add_button')}
          </button>
          {msg && (
            <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
              {msg.text}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function TrailerRow({
  siteCode,
  trailer,
  t,
  onSaved,
}: {
  siteCode: string;
  trailer: YardTrailerView;
  t: Translate;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(trailer.label);
  const [locationNote, setLocationNote] = useState(trailer.locationNote ?? '');
  const [status, setStatus] = useState<YardTrailerStatus>(trailer.status);
  const [busy, setBusy] = useState(false);

  const cancel = () => {
    setLabel(trailer.label);
    setLocationNote(trailer.locationNote ?? '');
    setStatus(trailer.status);
    setEditing(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/manager/${siteCode}/yard/${trailer.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, locationNote: locationNote || null, status }),
      });
      if (res.ok) {
        setEditing(false);
        await onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <tr className="border-t border-white/10">
        <td className="py-2">{trailer.label}</td>
        <td className="py-2">{trailer.locationNote ?? '—'}</td>
        <td className="py-2">{t(`yard.status_${trailer.status}`)}</td>
        <td className="py-2">
          <button type="button" className={ghostBtnCls} onClick={() => setEditing(true)}>
            {t('yard.edit')}
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-white/10">
      <td className="py-2 pr-2">
        <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
      </td>
      <td className="py-2 pr-2">
        <input
          className={inputCls}
          value={locationNote}
          onChange={(e) => setLocationNote(e.target.value)}
        />
      </td>
      <td className="py-2 pr-2">
        <select
          className={inputCls}
          value={status}
          onChange={(e) => setStatus(e.target.value as YardTrailerStatus)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`yard.status_${s}`)}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2">
        <div className="flex gap-2">
          <button
            type="button"
            className={smallBtnCls}
            disabled={busy || label.trim() === ''}
            onClick={save}
          >
            {busy ? t('yard.saving') : t('yard.save')}
          </button>
          <button type="button" className={ghostBtnCls} disabled={busy} onClick={cancel}>
            {t('yard.cancel')}
          </button>
        </div>
      </td>
    </tr>
  );
}
