'use client';

// ADR-0067 §3.4 — the sources + confirm-queue client.
//
// Two sections, because they are two different jobs:
//   1. WAITING FOR YOU — sources with no registered kind. This is the D5 confirm
//      queue, and it is at the top because a document whose kind is unknown is a
//      document the kind-specific checks are not running on. It is NOT true that
//      nothing is ingested until it is answered (this comment said so until
//      2026-07-29): capture and archive happen regardless — `doc_class` gates no
//      admission in `ingest.ts`. Confirmation gates INTERPRETATION, not intake.
//   2. WATCHED — sources already registered. Read-mostly; the only routine
//      action is Bill's kill switch.
//
// Per hard rule #10 there is NO HTML `<form>`: every control is an onClick /
// onChange handler.

import { useCallback, useMemo, useState } from 'react';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import { DOC_KINDS, type DocKind } from '@/lib/doc-ingest/doc-kinds';
import type { DocSourceRow } from '@/lib/doc-ingest/health';

/**
 * ADR-0104 §D9 — the confirmable kinds, DERIVED from the enum.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 * This was a hand-written 5-entry literal that had gone THREE CLASSES STALE:
 * `trailer_list`, `terex_maintenance_log` and `commodity_audit_tracker` — every
 * absorbable class in the product — were missing, though the API route accepted
 * them all. Worse than a missing option: the draft pre-fill below only accepts
 * the classifier's proposal when it is in this list, so a CORRECT
 * `commodity_audit_tracker` proposal was silently dropped from the form and the
 * admin saw an empty dropdown with no explanation.
 *
 * The filter mirrors `CONFIRMABLE_KINDS` in
 * `src/app/api/admin/doc-ingest/sources/route.ts` exactly — `vendor_invoice` is
 * recognised so it can be REFUSED and redirected (ADR-0046's AP mailbox is its
 * address), and `unknown` is not an answer.
 *
 * Adding six more string literals to a list that is already three stale would be
 * shipping the same defect again. A hand-maintained mirror of an enum drifts; a
 * derived one cannot.
 */
const KIND_OPTIONS: readonly DocKind[] = DOC_KINDS.filter(
  (k) => k !== 'vendor_invoice' && k !== 'unknown',
);

/**
 * `Record<DocKind, string>` is the point: a new class fails to COMPILE until it
 * is labelled here. An index signature (`Record<string, string>`, which this
 * was) accepts a missing key silently and renders `undefined`.
 */
const KIND_LABEL: Record<DocKind, string> = {
  daily_log_workbook: 'Daily log workbook',
  trailer_list: 'Trailer list',
  terex_maintenance_log: 'TEREX maintenance log',
  commodity_audit_tracker: 'Commodity audit tracker',
  outbound_weight_audit: 'Outbound weight audit',
  facility_expense_log: 'Facility expense log',
  facility_journal: 'Facility journal (archive only)',
  meeting_notes_log: 'Meeting notes log (archive only)',
  admin_task_tracker: 'Task tracker (archive only)',
  analysis_workbook: 'Analysis workbook (archive only)',
  ap_history_report: 'AP history report',
  equipment_inventory: 'Equipment inventory (archive only)',
  rate_table: 'Rate table',
  mrc_invoice: 'MRC invoice',
  vendor_invoice: 'Vendor invoice (wrong address)',
  unknown: 'Unknown',
};

function labelFor(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? kind;
}

interface Site {
  id: string;
  name: string;
}

/** Pacific wall clock, never the browser's zone — matches every DR3 surface. */
function fmt(iso: string | null): string {
  if (!iso) return '—';
  const at = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${at} PT`;
}

interface Draft {
  kind: string;
  siteId: string;
  period: string;
}

export function SourcesClient({
  initialSources,
  sites,
}: {
  initialSources: DocSourceRow[];
  sites: Site[];
}) {
  const [sources, setSources] = useState(initialSources);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [reparsing, setReparsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/doc-ingest/sources', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { sources: DocSourceRow[] };
    setSources(body.sources);
  }, []);

  const post = useCallback(
    async (payload: Record<string, unknown>, key: string) => {
      setPending(key);
      setError(null);
      try {
        const res = await fetch('/api/admin/doc-ingest/sources', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? M.sources.saveFailed);
          return;
        }
        await refresh();
      } catch {
        setError(M.sources.saveFailed);
      } finally {
        setPending(null);
      }
    },
    [refresh],
  );

  /**
   * ADR-0067 Am.8 §2 — re-derive the stored `parse_summary` from the archived
   * copy. Separate from `post` because it targets a different route and, unlike
   * every other action here, changes nothing about the DOCUMENT — only about our
   * reading of it.
   */
  const reparse = useCallback(
    async (sourceId: string) => {
      setReparsing(sourceId);
      setError(null);
      try {
        const res = await fetch(`/api/admin/doc-ingest/sources/${sourceId}/reparse`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            message?: string;
          } | null;
          setError(body?.message ?? body?.error ?? M.trailers.reparseFailed);
          return;
        }
        await refresh();
      } catch {
        setError(M.trailers.reparseFailed);
      } finally {
        setReparsing(null);
      }
    },
    [refresh],
  );

  // Folders are watched containers, not ingestible documents — they never need a
  // classification, so showing them in the confirm queue would be asking a
  // question with no answer.
  const queue = useMemo(
    () => sources.filter((s) => s.docClass === null && s.kind === 'file'),
    [sources],
  );
  const watched = useMemo(
    () => sources.filter((s) => s.docClass !== null || s.kind === 'folder'),
    [sources],
  );

  const draftFor = (s: DocSourceRow): Draft =>
    drafts[s.id] ?? {
      // Pre-fill from the classifier's proposal — but `unknown`/`vendor_invoice`
      // are not confirmable, so they pre-fill as empty and force a real choice
      // rather than letting a low-confidence guess be accepted by reflex.
      // Now that KIND_OPTIONS is derived from DOC_KINDS, this accepts every
      // absorbable proposal. Before ADR-0104 it silently dropped a correct
      // `commodity_audit_tracker` because that kind was missing from the list.
      kind:
        s.proposedClass && (KIND_OPTIONS as readonly string[]).includes(s.proposedClass)
          ? s.proposedClass
          : '',
      siteId: s.proposedSiteId ?? '',
      period: s.proposedPeriod ?? '',
    };

  const setDraft = (id: string, patch: Partial<Draft>, current: Draft) =>
    setDrafts((d) => ({ ...d, [id]: { ...current, ...patch } }));

  return (
    <div className="flex flex-col gap-10">
      {error ? (
        <p className="rounded-md bg-red-500/10 px-4 py-3 text-sm text-red-300 ring-1 ring-red-500/30">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold">
            {M.sources.confirmQueueHeading}
            {queue.length > 0 ? ` (${queue.length})` : ''}
          </h2>
          <p className="text-sm text-dr3-mist-dim">{M.sources.confirmQueueBody}</p>
        </div>

        {queue.length === 0 ? (
          <p className="text-sm text-dr3-mist-dim">{M.anomalies.empty}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {queue.map((s) => {
              const draft = draftFor(s);
              return (
                <li
                  key={s.id}
                  className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{s.displayName}</span>
                    <span className="text-xs text-dr3-mist-dim">
                      {s.ownerUpn ?? '—'} · {fmt(s.lastSeenISO)}
                    </span>
                  </div>

                  {s.pathHint ? (
                    <p className="mt-1 text-xs text-dr3-mist-dim">{s.pathHint}</p>
                  ) : null}
                  {s.depth > 0 ? (
                    <p className="mt-1 text-xs text-dr3-mist-dim">{M.sources.nestedIn}</p>
                  ) : null}
                  {s.sharedByCount > 1 ? (
                    <p className="mt-1 text-xs text-dr3-cyan">{M.sources.sharedTwice}</p>
                  ) : null}
                  {s.readBlockedReason ? (
                    <p className="mt-1 text-xs text-red-300">
                      {M.sources.readBlocked}: {s.readBlockedReason}
                    </p>
                  ) : null}

                  {s.proposedClass ? (
                    <p className="mt-2 text-sm text-dr3-mist-dim">
                      {M.sources.proposal}:{' '}
                      <span className="text-dr3-mist">
                        {labelFor(s.proposedClass)}
                      </span>
                      {s.proposedConfidence !== null
                        ? ` · ${(s.proposedConfidence * 100).toFixed(0)}% ${M.sources.confidence}`
                        : ''}
                      {s.proposedSource ? ` · ${s.proposedSource}` : ''}
                      {s.proposedReasoning ? ` — ${s.proposedReasoning}` : ''}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                      aria-label={M.sources.columnKind}
                      value={draft.kind}
                      onChange={(e) => setDraft(s.id, { kind: e.target.value }, draft)}
                      className="rounded bg-dr3-space px-2 py-1 text-sm ring-1 ring-dr3-steel-light/30"
                    >
                      <option value="">{M.sources.unclassified}</option>
                      {KIND_OPTIONS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label={M.sources.columnSite}
                      value={draft.siteId}
                      onChange={(e) => setDraft(s.id, { siteId: e.target.value }, draft)}
                      className="rounded bg-dr3-space px-2 py-1 text-sm ring-1 ring-dr3-steel-light/30"
                    >
                      <option value="">{M.sources.noSite}</option>
                      {sites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </select>

                    <input
                      aria-label={M.sources.columnPeriod}
                      value={draft.period}
                      placeholder="2026-07"
                      onChange={(e) => setDraft(s.id, { period: e.target.value }, draft)}
                      className="w-28 rounded bg-dr3-space px-2 py-1 text-sm ring-1 ring-dr3-steel-light/30"
                    />

                    <button
                      type="button"
                      disabled={!draft.kind || pending === s.id}
                      onClick={() =>
                        void post(
                          {
                            action: 'confirm',
                            sourceId: s.id,
                            kind: draft.kind,
                            siteId: draft.siteId || null,
                            period: draft.period.trim() || null,
                          },
                          s.id,
                        )
                      }
                      className="rounded bg-dr3-cyan/20 px-3 py-1 text-sm text-dr3-cyan ring-1 ring-dr3-cyan/40 disabled:opacity-40"
                    >
                      {pending === s.id ? M.sources.saving : M.sources.confirm}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">{M.sources.watchedHeading}</h2>
        {watched.length === 0 ? (
          <p className="text-sm text-dr3-mist-dim">{M.sources.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                <tr>
                  <th className="py-2 pr-4">{M.sources.columnDocument}</th>
                  <th className="py-2 pr-4">{M.sources.columnKind}</th>
                  <th className="py-2 pr-4">{M.sources.columnSite}</th>
                  <th className="py-2 pr-4">{M.sources.columnPeriod}</th>
                  <th className="py-2 pr-4">{M.sources.columnOwner}</th>
                  <th className="py-2 pr-4">{M.sources.columnState}</th>
                  <th className="py-2 pr-4">{M.sources.columnLastIngested}</th>
                  <th className="py-2">{M.sources.columnActions}</th>
                </tr>
              </thead>
              <tbody>
                {watched.map((s) => (
                  <tr key={s.id} className="border-t border-dr3-steel-light/15">
                    <td className="py-2 pr-4">
                      {s.webUrl ? (
                        <a
                          href={s.webUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-dr3-cyan hover:underline"
                        >
                          {s.displayName}
                        </a>
                      ) : (
                        s.displayName
                      )}
                      {s.kind === 'folder' ? (
                        <span className="ml-2 text-xs text-dr3-mist-dim">folder</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      {s.docClass ? labelFor(s.docClass) : M.sources.unclassified}
                    </td>
                    <td className="py-2 pr-4">{s.siteName ?? M.sources.noSite}</td>
                    <td className="py-2 pr-4">{s.period ?? '—'}</td>
                    <td className="py-2 pr-4">{s.ownerUpn ?? '—'}</td>
                    <td className="py-2 pr-4">
                      {!s.enabled ? (
                        <span className="text-dr3-mist-dim">{M.sources.disabled}</span>
                      ) : s.state === 'access_denied' ? (
                        <span className="text-red-300">{M.sources.stateAccessDenied}</span>
                      ) : s.state === 'disappeared' ? (
                        <span className="text-amber-300">{M.sources.stateDisappeared}</span>
                      ) : (
                        <span className="text-emerald-300">{M.sources.stateActive}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{fmt(s.lastIngestedISO)}</td>
                    <td className="py-2">
                      <button
                        type="button"
                        disabled={pending === s.id}
                        onClick={() =>
                          void post(
                            { action: 'setEnabled', sourceId: s.id, enabled: !s.enabled },
                            s.id,
                          )
                        }
                        className="rounded px-2 py-1 text-xs text-dr3-mist-dim ring-1 ring-dr3-steel-light/30 hover:text-dr3-cyan disabled:opacity-40"
                      >
                        {s.enabled ? M.sources.disable : M.sources.enable}
                      </button>
                      {/* ADR-0067 Am.8 §2 — re-derive the stored headers from the
                          archived copy. Needed because a parse only happens on a
                          NEW revision, so a parser fix would otherwise reach an
                          existing document only if someone happened to edit it. */}
                      <button
                        type="button"
                        disabled={reparsing === s.id}
                        title={M.trailers.reparseHint}
                        onClick={() => void reparse(s.id)}
                        className="ml-2 rounded px-2 py-1 text-xs text-dr3-mist-dim ring-1 ring-dr3-steel-light/30 hover:text-dr3-cyan disabled:opacity-40"
                        data-testid="reparse-button"
                      >
                        {reparsing === s.id ? M.trailers.reparsing : M.trailers.reparse}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
