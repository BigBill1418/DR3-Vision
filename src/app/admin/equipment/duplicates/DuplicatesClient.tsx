'use client';

// ADR-0135 F — the "possible duplicates" queue: one card per pair the matcher
// proposes, two actions per card.
//
//   Merge            → POST /api/admin/equipment/merge { winnerId, loserId, survivorSiteId? }
//                      The admin picks the survivor (default: the row more AP links
//                      cite — fewer references move). A pair at two different
//                      yards must also say where the survivor lives — Eugene,
//                      Woodland or fleet-wide — because the server refuses a
//                      cross-site merge without it (422 `cross_site`).
//   Different assets → POST /api/admin/equipment/duplicates { aId, bId, reason }
//                      A recorded verdict with a real reason, so the pair stops
//                      being proposed.
//
// The matcher proposes; the admin disposes (ADR-0087 / ADR-0135 §4). Nothing here
// merges without an explicit confirm. Every action is a `<button onClick>`
// (CLAUDE.md hard rule #10) and ends in `router.refresh()` so the server
// component re-runs `listPossibleDuplicates()`.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
// TYPE-only: erased at compile time, so the server-only module stays out of the bundle.
import type { DuplicatePair } from '@/lib/admin-equipment';
import { OVERRIDE_REASON_MAX, OVERRIDE_REASON_MIN } from '@/app/admin/constants';
import { adminMessages as M } from '@/app/admin/messages';
import { CATEGORY_LABEL } from '../labels';

export interface SiteOption {
  id: string;
  code: string;
  name: string;
}

type Side = DuplicatePair['a'];

/** The fields this client reads from either route's JSON body. */
interface RouteBody {
  error?: unknown;
  repointed?: Record<string, unknown>;
}

/** Select value for "fleet-wide" — sent to the merge route as `survivorSiteId: null`. */
const FLEET = '__fleet__';

export function DuplicatesClient({
  pairs,
  sites,
}: {
  pairs: DuplicatePair[];
  sites: SiteOption[];
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const siteNameByCode = new Map(sites.map((s) => [s.code, s.name]));

  return (
    <section className="flex flex-col gap-4">
      {notice ? (
        <p
          className="rounded-md bg-emerald-900/40 px-4 py-2 text-sm text-emerald-100"
          role="status"
          data-testid="admin-duplicates-notice"
        >
          {notice}
        </p>
      ) : null}
      {pairs.length === 0 ? (
        <p
          className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-center text-dr3-mist-dim"
          data-testid="admin-duplicates-empty"
        >
          {M.equipment.duplicatesEmpty}
        </p>
      ) : (
        <>
          <p className="text-sm text-dr3-mist-dim">{M.equipment.duplicatesCount(pairs.length)}</p>
          {pairs.map((p) => (
            <PairCard
              key={`${p.a.id}|${p.b.id}`}
              pair={p}
              sites={sites}
              siteNameByCode={siteNameByCode}
              onDone={setNotice}
            />
          ))}
        </>
      )}
    </section>
  );
}

function PairCard({
  pair,
  sites,
  siteNameByCode,
  onDone,
}: {
  pair: DuplicatePair;
  sites: SiteOption[];
  siteNameByCode: Map<string, string>;
  onDone: (notice: string) => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'merge' | 'distinct'>('idle');
  // Default survivor: the row more invoices cite, so fewer references move.
  const [survivor, setSurvivor] = useState<'a' | 'b'>(pair.b.links > pair.a.links ? 'b' : 'a');
  // Cross-site only; deliberately unset — where a trailer lives is a judgement.
  const [survivorSite, setSurvivorSite] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pairId = `${pair.a.id}-${pair.b.id}`;

  const post = async (url: string, body: unknown): Promise<RouteBody | null> => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as RouteBody;
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : M.errors.serverError);
        return null;
      }
      return json;
    } catch {
      setError(M.errors.serverError);
      return null;
    } finally {
      setPending(false);
    }
  };

  const merge = async () => {
    if (pair.crossSite && !survivorSite) {
      setError(M.equipment.mergeCrossSite);
      return;
    }
    if (!window.confirm(M.equipment.mergeConfirm)) return;
    const [winner, loser] = survivor === 'a' ? [pair.a, pair.b] : [pair.b, pair.a];
    const body = await post('/api/admin/equipment/merge', {
      winnerId: winner.id,
      loserId: loser.id,
      ...(pair.crossSite ? { survivorSiteId: survivorSite === FLEET ? null : survivorSite } : {}),
    });
    if (!body) return;
    const repointed = body.repointed ?? {};
    const moved = Object.values(repointed).reduce<number>(
      (n, v) => n + (typeof v === 'number' ? v : 0),
      0,
    );
    onDone(M.equipment.mergeSuccess(moved));
    router.refresh();
  };

  const cancel = () => {
    setMode('idle');
    setError(null);
  };

  const reasonOk = reason.trim().length >= OVERRIDE_REASON_MIN;
  const markDistinct = async () => {
    if (!reasonOk) {
      setError(M.equipment.distinctReasonRequired);
      return;
    }
    const body = await post('/api/admin/equipment/duplicates', {
      aId: pair.a.id,
      bId: pair.b.id,
      reason: reason.trim(),
    });
    if (!body) return;
    onDone(M.equipment.duplicatesDistinctDone);
    router.refresh();
  };

  return (
    <article
      className={`rounded-lg border bg-dr3-space-2 p-4 ${
        pair.crossSite ? 'border-amber-400/50' : 'border-dr3-steel-light/25'
      }`}
      data-testid="admin-duplicate-pair"
    >
      <header className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="uppercase tracking-wider text-dr3-cyan">{M.equipment.duplicatesWhy}:</span>
        <span>{M.equipment.duplicatesReason[pair.reason]}</span>
        {pair.crossSite ? (
          <span
            className="rounded-full bg-amber-500/20 px-2 py-0.5 font-semibold text-amber-200"
            data-testid="admin-duplicate-cross-site"
          >
            {M.equipment.duplicatesCrossSite}
          </span>
        ) : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {(['a', 'b'] as const).map((k) => (
          <SideView
            key={k}
            side={pair[k]}
            siteNameByCode={siteNameByCode}
            choosing={mode === 'merge'}
            chosen={survivor === k}
            onChoose={() => setSurvivor(k)}
            radioName={`survivor-${pairId}`}
            testId={`admin-duplicate-side-${k}`}
          />
        ))}
      </div>

      {error ? (
        <p
          className="mt-3 rounded-md bg-red-900/40 px-3 py-2 text-sm text-red-100"
          role="alert"
          data-testid="admin-duplicate-error"
        >
          {error}
        </p>
      ) : null}

      {mode === 'idle' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode('merge')}
            className="rounded-md bg-dr3-cyan px-3 py-1.5 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright"
            data-testid="admin-duplicate-merge-open"
          >
            {M.equipment.duplicatesMerge}
          </button>
          <button
            type="button"
            onClick={() => setMode('distinct')}
            className="rounded-md border border-dr3-steel-light/30 px-3 py-1.5 text-sm text-dr3-mist hover:border-dr3-cyan/40 hover:text-dr3-cyan"
            data-testid="admin-duplicate-distinct-open"
          >
            {M.equipment.duplicatesDistinct}
          </button>
        </div>
      ) : null}

      {mode === 'merge' ? (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          {pair.crossSite ? (
            <label className="flex flex-col gap-1">
              <span>{M.equipment.mergeSurvivorSite}</span>
              <select
                value={survivorSite}
                onChange={(e) => setSurvivorSite(e.target.value)}
                className="max-w-xs rounded-md border border-dr3-steel-light/30 bg-dr3-space px-2 py-1 text-dr3-mist"
                data-testid="admin-duplicate-survivor-site"
              >
                <option value="">{M.equipment.duplicatesSurvivorSiteChoose}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value={FLEET}>{M.equipment.fleetWide}</option>
              </select>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void merge()}
              disabled={pending || (pair.crossSite && !survivorSite)}
              className="rounded-md bg-dr3-cyan px-3 py-1.5 font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
              data-testid="admin-duplicate-merge-submit"
            >
              {M.equipment.mergeSubmit}
            </button>
            <CancelButton onClick={cancel} />
          </div>
        </div>
      ) : null}

      {mode === 'distinct' ? (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span>{M.equipment.duplicatesDistinctLabel}</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={OVERRIDE_REASON_MAX}
              placeholder={M.equipment.duplicatesDistinctPlaceholder}
              className="rounded-md border border-dr3-steel-light/30 bg-dr3-space px-2 py-1 text-dr3-mist"
              data-testid="admin-duplicate-distinct-reason"
            />
          </label>
          {!reasonOk ? (
            <p className="text-xs text-dr3-mist-dim">{M.equipment.distinctReasonRequired}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void markDistinct()}
              disabled={pending || !reasonOk}
              className="rounded-md bg-dr3-cyan px-3 py-1.5 font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
              data-testid="admin-duplicate-distinct-submit"
            >
              {M.equipment.duplicatesDistinctSubmit}
            </button>
            <CancelButton onClick={cancel} />
          </div>
        </div>
      ) : null}
    </article>
  );
}

function SideView({
  side,
  siteNameByCode,
  choosing,
  chosen,
  onChoose,
  radioName,
  testId,
}: {
  side: Side;
  siteNameByCode: Map<string, string>;
  choosing: boolean;
  chosen: boolean;
  onChoose: () => void;
  radioName: string;
  testId: string;
}) {
  const site = side.siteCode
    ? (siteNameByCode.get(side.siteCode) ?? side.siteCode)
    : M.equipment.duplicatesFleetWide;
  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        choosing && chosen ? 'border-dr3-cyan' : 'border-dr3-steel-light/20'
      }`}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold">{side.displayName}</span>
        <Link
          href={`/admin/equipment/${side.id}`}
          className="shrink-0 text-xs text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          {M.equipment.duplicatesOpen}
        </Link>
      </div>
      <p className="mt-1 text-xs text-dr3-mist-dim">
        {CATEGORY_LABEL[side.category]} · {site} ·{' '}
        {side.isActive ? M.equipment.statusActive : M.equipment.statusInactive} ·{' '}
        {M.equipment.duplicatesLinks(side.links)}
      </p>
      {choosing ? (
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input
            type="radio"
            name={radioName}
            checked={chosen}
            onChange={onChoose}
            data-testid={`${testId}-keep`}
          />
          <span>{M.equipment.duplicatesKeep}</span>
        </label>
      ) : null}
    </div>
  );
}

function CancelButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-dr3-steel-light/30 px-3 py-1.5 text-dr3-mist hover:text-dr3-cyan"
    >
      {M.equipment.mergeCancel}
    </button>
  );
}
