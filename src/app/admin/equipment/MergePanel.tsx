'use client';

// ADR-0075 D4 / ADR-0135 F — merge one record AWAY into a survivor.
//
// Shared by the list's per-row "Merge into…" and the edit page's merge section,
// so the two cannot disagree about what a merge sends.
//
// ADR-0135 lifted the same-site restriction: the same trailer was seeded at one
// yard and re-created at the other (281577 / 282876 / 284460). Every live row is
// a candidate survivor. When the two sit at different yards (or one is
// fleet-wide) the admin MUST say where the survivor lives — Eugene, Woodland or
// fleet-wide — and the choice is sent as `survivorSiteId`; the server refuses a
// cross-site merge without it (`cross_site`), so it is never guessed here either.
//
// CLAUDE.md hard rule #10 — no `<form>`; every action is an `onClick`.

import { useState } from 'react';
import { adminMessages as M } from '@/app/admin/messages';
import { pickerMatches } from '@/lib/equipment/match';
import { FLEET_SITE_CODE } from './list-url';

export interface MergeRow {
  id: string;
  display_name: string;
  /** null = fleet-wide. */
  site_id: string | null;
  site_code: string | null;
  link_count: number;
  resolved_request_count: number;
}

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

export interface MergeReferenceCounts {
  links: number;
  requests: number;
  throughput: number;
  gapAlerts: number;
}

interface Props {
  loser: MergeRow;
  /** Live rows only, the loser excluded. */
  candidates: MergeRow[];
  sites: SiteOption[];
  /** The full preview (incl. throughput + gap alerts) when the caller loaded it. */
  counts?: MergeReferenceCounts | undefined;
  /** Shown under the picker — e.g. where to find rows not in `candidates`. */
  note?: string | undefined;
  /** Called with the total number of references repointed. */
  onMerged: (repointed: number) => void;
  onCancel?: (() => void) | undefined;
}

const siteLabel = (r: MergeRow) => r.site_code ?? M.equipment.fleetWideSite;

export function MergePanel({ loser, candidates, sites, counts, note, onMerged, onCancel }: Props) {
  const [winnerId, setWinnerId] = useState('');
  const [filter, setFilter] = useState('');
  const [survivorSite, setSurvivorSite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const winner = candidates.find((c) => c.id === winnerId);
  const crossSite = !!winner && winner.site_id !== loser.site_id;
  const shown = candidates.filter(
    (c) => c.id === winnerId || pickerMatches(filter, c.display_name),
  );

  const merge = async () => {
    if (!winner) return;
    if (crossSite && !survivorSite) {
      setError(M.equipment.mergeSurvivorSiteRequired);
      return;
    }
    if (!window.confirm(M.equipment.mergeConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/equipment/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          winnerId: winner.id,
          loserId: loser.id,
          ...(crossSite
            ? { survivorSiteId: survivorSite === FLEET_SITE_CODE ? null : survivorSite }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        repointed?: Partial<MergeReferenceCounts>;
        repointedLinks?: number;
        repointedRequests?: number;
      };
      if (!res.ok) {
        // `throughput_conflict` arrives with its dates already in `error`
        // (`M.equipment.throughputConflict`); every refusal renders the same way.
        setError(body.error ?? M.errors.serverError);
        return;
      }
      const r = body.repointed;
      onMerged(
        r
          ? (r.links ?? 0) + (r.requests ?? 0) + (r.throughput ?? 0) + (r.gapAlerts ?? 0)
          : (body.repointedLinks ?? 0) + (body.repointedRequests ?? 0),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-2 flex flex-col gap-2 rounded-md border border-dr3-steel-light/25 bg-dr3-space/60 p-3"
      data-testid={`admin-equipment-merge-panel-${loser.id}`}
    >
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-3 py-2 text-xs text-red-100"
          role="alert"
          data-testid={`admin-equipment-merge-error-${loser.id}`}
        >
          {error}
        </p>
      ) : null}
      <p className="text-xs text-dr3-mist-dim">
        <b className="text-dr3-mist">{M.equipment.mergeLoser}:</b> {loser.display_name} ·{' '}
        {siteLabel(loser)}
      </p>
      <p
        className="text-xs text-dr3-mist-dim"
        data-testid={`admin-equipment-merge-counts-${loser.id}`}
      >
        {M.equipment.mergeMovesHeading}{' '}
        {counts
          ? M.equipment.mergeReferencesFull(counts)
          : M.equipment.mergeReferences(loser.link_count, loser.resolved_request_count)}
      </p>
      {candidates.length === 0 ? (
        <p className="text-xs text-dr3-mist-dim">{M.equipment.empty}</p>
      ) : (
        <>
          <input
            type="text"
            value={filter}
            placeholder={M.equipment.mergeFilterPlaceholder}
            aria-label={M.equipment.mergeFilterPlaceholder}
            onChange={(ev) => setFilter(ev.target.value)}
            className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-2 py-1 text-xs text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
            data-testid={`admin-equipment-merge-filter-${loser.id}`}
          />
          <label className="flex flex-col gap-1 text-xs text-dr3-mist">
            {M.equipment.mergeWinner}
            <select
              value={winnerId}
              onChange={(ev) => {
                setWinnerId(ev.target.value);
                setSurvivorSite('');
                setError(null);
              }}
              className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-2 py-1 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
              data-testid={`admin-equipment-merge-winner-${loser.id}`}
            >
              <option value="" className="text-dr3-space">
                —
              </option>
              {shown.map((c) => (
                <option key={c.id} value={c.id} className="text-dr3-space">
                  {c.display_name} · {siteLabel(c)} (
                  {M.equipment.mergeReferences(c.link_count, c.resolved_request_count)})
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {crossSite ? (
        <label className="flex flex-col gap-1 text-xs text-dr3-mist">
          <span>
            {M.equipment.mergeCrossSite} {M.equipment.mergeSurvivorSite}
          </span>
          <select
            value={survivorSite}
            onChange={(ev) => setSurvivorSite(ev.target.value)}
            className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-2 py-1 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
            data-testid={`admin-equipment-merge-site-${loser.id}`}
          >
            <option value="" className="text-dr3-space">
              {M.equipment.mergeSurvivorSiteChoose}
            </option>
            {sites.map((s) => (
              <option key={s.id} value={s.id} className="text-dr3-space">
                {s.name}
              </option>
            ))}
            <option value={FLEET_SITE_CODE} className="text-dr3-space">
              {M.equipment.fleetWide}
            </option>
          </select>
        </label>
      ) : null}
      {note ? <p className="text-xs text-dr3-mist-dim">{note}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void merge()}
          disabled={busy || !winner || (crossSite && !survivorSite)}
          className="rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-dr3-space disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`admin-equipment-merge-submit-${loser.id}`}
        >
          {M.equipment.mergeSubmit}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            {M.equipment.mergeCancel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
