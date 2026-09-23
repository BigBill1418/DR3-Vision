'use client';

// ADR-0046 Amendment 9 (§2.5) / ADR-0135 A — the worklist rows + the resolve /
// reject actions.
//
// CLAUDE.md hard rule #10 — no `<form>` element anywhere; every action is an
// `onClick`.
//
// SEARCH FIRST (ADR-0135 A). 23 of the first 27 resolutions created a new row,
// most of them for assets that were already in the registry — because the
// panel's only primary button was "Add to the fleet". The primary action is now
// "Find it in the fleet": a search over BOTH yards and the fleet-wide assets,
// pre-filled from the request (the approver's structured unit # + type, or the
// unit tokens of a legacy free-text description), ranked by the shared
// unit-aware matcher, with "Use this one" on every result. "Add a new asset
// instead" is the SECONDARY path under the results, and it opens the structured
// create form (ADR-0135 D) — whose server gate re-checks the fleet anyway.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { assetTypeDef } from '@/app/admin/constants';
import { EquipmentCreateForm } from '@/app/admin/equipment/new/EquipmentCreateForm';
import { adminMessages } from '@/app/admin/messages';
import { unitTokens } from '@/lib/equipment/match';
import type { StructuredEquipmentRequest } from '@/lib/equipment/request-description';
import { pacificAgeLabel } from './age';

const M = adminMessages.equipmentRequests;
const E = adminMessages.equipment;

export interface EquipmentRequestRow {
  id: string;
  description: string;
  status: 'open' | 'resolved' | 'rejected';
  /** ISO string — server components cannot hand a Date to a client component. */
  requestedAt: string;
  requesterName: string | null;
  siteId: string;
  siteCode: string | null;
  siteName: string | null;
  apRequestId: string;
  subject: string | null;
  vendor: string | null;
  amountCents: number | null;
  resolvedEquipmentId: string | null;
  resolvedEquipmentName: string | null;
  resolverName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  linkPending: boolean;
  /** ADR-0135 E — the approver's structured fields; null for a legacy free-text request. */
  structured: StructuredEquipmentRequest | null;
}

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

/** One fleet search hit — the `SimilarEquipment` wire shape, the fields we render. */
interface SearchRow {
  id: string;
  displayName: string;
  category: string;
  /** null = fleet-wide. */
  siteCode: string | null;
  isActive: boolean;
  mergedIntoId: string | null;
}

/** Debounce for the fleet search. */
const SEARCH_DEBOUNCE_MS = 300;

const usd = (cents: number | null): string =>
  typeof cents === 'number'
    ? (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : '—';

/**
 * What the "Find it in the fleet" box starts with.
 *
 * Structured request → its unit number (or make, for a type without one) plus
 * the type label: `5327 Trailer`. Legacy free text → the old name suggestion
 * when there is one, else every unit token in the description, so a four-trailer
 * work order searches for all four (`53489 5340 35 282859`) instead of nothing.
 */
export function initialSearch(r: Pick<EquipmentRequestRow, 'description' | 'structured'>): string {
  const s = r.structured;
  if (s) {
    return [s.unitNumber || s.make, assetTypeDef(s.assetType)?.label ?? '']
      .filter(Boolean)
      .join(' ');
  }
  return suggestName(r.description) || unitTokens(r.description).join(' ');
}

export function EquipmentRequestsClient({
  requests,
  sites,
}: {
  requests: EquipmentRequestRow[];
  sites: SiteOption[];
}) {
  if (requests.length === 0) {
    return (
      <p className="rounded-md border border-dr3-steel-light/20 bg-dr3-space-2 px-4 py-6 text-sm text-dr3-mist-dim">
        {M.empty}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-4">
      {requests.map((r) => (
        <li key={r.id}>
          <RequestCard request={r} sites={sites} />
        </li>
      ))}
    </ul>
  );
}

function RequestCard({ request, sites }: { request: EquipmentRequestRow; sites: SiteOption[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'find' | 'create' | 'reject'>('idle');
  const [backfill, setBackfill] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(
    async (body: Record<string, unknown>, failed: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/ap/equipment-requests/${request.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(b.error ?? failed);
          return false;
        }
        setMode('idle');
        router.refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [request.id, router],
  );

  const reject = useCallback(async () => {
    if (!note.trim()) {
      setError(M.rejectNoteRequired);
      return;
    }
    await post({ action: 'reject', note: note.trim() }, M.rejectFailed);
  }, [note, post]);

  /**
   * ADR-0075 D1 — resolve against the asset that already exists. `reactivate`
   * rides along only when the target is inactive, which is also the case the
   * button labels "Reactivate and use" — the click does exactly what it says.
   */
  const useExisting = useCallback(
    async (equipmentId: string, isActive: boolean) => {
      await post(
        {
          action: 'resolve',
          equipmentId,
          backfillLink: backfill,
          ...(isActive ? {} : { reactivate: true }),
        },
        M.resolveFailed,
      );
    },
    [backfill, post],
  );

  const open = request.status === 'open';
  const s = request.structured;

  return (
    <article
      className="flex flex-col gap-3 rounded-lg border border-dr3-steel-light/20 bg-dr3-space-2 p-4"
      data-testid="equipment-request-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="whitespace-pre-wrap border-l-4 border-dr3-cyan pl-3 text-sm text-dr3-mist">
            {request.description}
          </p>
          <p className="text-xs text-dr3-mist-dim">
            {request.requesterName ?? M.anApprover} · {request.siteName ?? request.siteCode ?? '—'}{' '}
            · {M.waiting(pacificAgeLabel(new Date(request.requestedAt)))}
          </p>
        </div>
        <StatusPill status={request.status} />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-dr3-mist-dim sm:grid-cols-3">
        <Row label={M.vendor} value={request.vendor ?? '—'} />
        <Row label={M.amount} value={usd(request.amountCents)} />
        <Row label={M.invoice} value={request.subject ?? M.noSubject} />
      </dl>

      {request.status === 'resolved' && (
        <p className="text-xs text-emerald-300" data-testid="equipment-request-resolved">
          {M.resolvedTo} <b>{request.resolvedEquipmentName}</b>
          {request.resolverName ? M.resolvedBy(request.resolverName) : ''}
          {request.linkPending ? M.linkNotRepointed : M.linkRepointed}
        </p>
      )}
      {request.status === 'rejected' && request.resolutionNote && (
        <p className="text-xs text-amber-300">
          {M.rejectedNote(request.resolutionNote)}
          {request.resolverName ? ` (${request.resolverName})` : ''}
          {M.invoiceStaysApproved}
        </p>
      )}

      {error && (
        <p className="rounded-md bg-red-900/40 px-3 py-2 text-sm text-red-100" role="alert">
          {error}
        </p>
      )}

      {open && mode === 'idle' && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setMode('find')}
            className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright"
            data-testid="equipment-request-find"
          >
            {M.findInFleet}
          </button>
          <button
            type="button"
            onClick={() => setMode('reject')}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
            data-testid="equipment-request-reject"
          >
            {M.notEquipment}
          </button>
          <a
            href={`/dashboard/ops/ap?request=${encodeURIComponent(request.apRequestId)}`}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            {M.viewInvoice}
          </a>
        </div>
      )}

      {open && (mode === 'find' || mode === 'create') && (
        <section className="flex flex-col gap-4 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 p-4">
          <label className="flex items-center gap-2 text-sm text-dr3-mist">
            <input
              type="checkbox"
              checked={backfill}
              onChange={(e) => setBackfill(e.target.checked)}
              data-testid="equipment-request-backfill"
            />
            <span>
              {M.backfillLabel}
              <span className="block text-xs text-dr3-mist-dim">{M.backfillHelp}</span>
            </span>
          </label>

          {mode === 'find' ? (
            <>
              <FleetSearch initialQuery={initialSearch(request)} busy={busy} onUse={useExisting} />
              <div className="flex flex-col gap-1 border-t border-dr3-steel-light/15 pt-3">
                <button
                  type="button"
                  onClick={() => setMode('create')}
                  className="self-start text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
                  data-testid="equipment-request-add-new"
                >
                  {M.addNewInstead}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setMode('find')}
                className="self-start text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
                data-testid="equipment-request-back-to-search"
              >
                {M.backToSearch}
              </button>
              <p className="text-xs text-dr3-mist-dim">{M.addNewHelp}</p>
              <EquipmentCreateForm
                sites={sites}
                initialSiteCode={request.siteCode ?? undefined}
                initialAssetType={s?.assetType}
                initialUnitNumber={s?.unitNumber}
                initialMake={s?.make}
                endpoint={`/api/admin/ap/equipment-requests/${request.id}`}
                extraBody={{ action: 'resolve', backfillLink: backfill }}
                submitLabel={M.addToFleet}
                onSaved={() => setMode('idle')}
                backHref="/admin/ap/equipment-requests"
                similarEndpoint="/api/admin/equipment/similar"
                onUseExisting={useExisting}
              />
            </>
          )}
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="self-start text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            {M.neverMind}
          </button>
        </section>
      )}

      {open && mode === 'reject' && (
        <section className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 p-4">
          <label className="flex flex-col gap-2 text-sm text-dr3-mist">
            {M.rejectNoteLabel} <span className="text-amber-300">{M.required}</span>
            <textarea
              value={note}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
              data-testid="equipment-request-reject-note"
            />
            <span className="text-xs text-dr3-mist-dim">{M.rejectNoteHelp}</span>
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void reject()}
              disabled={busy || !note.trim()}
              className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-dr3-space disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="equipment-request-reject-submit"
            >
              {M.rejectSubmit}
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
            >
              {M.neverMind}
            </button>
          </div>
        </section>
      )}
    </article>
  );
}

/**
 * ADR-0135 A — "Find it in the fleet". Debounced, fleet-wide (both yards and
 * fleet-wide assets), ranked by the server's shared matcher exactly as returned.
 * Merged-away rows are never offered — they are not a thing any more (the
 * matcher already swaps a merged loser for its survivor; this is the belt).
 */
function FleetSearch({
  initialQuery,
  busy,
  onUse,
}: {
  initialQuery: string;
  busy: boolean;
  onUse: (equipmentId: string, isActive: boolean) => Promise<void>;
}) {
  const [q, setQ] = useState(initialQuery);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [rows, setRows] = useState<SearchRow[]>([]);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setStatus('idle');
      setRows([]);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/admin/equipment/similar?search=1&q=${encodeURIComponent(query)}`,
          );
          const body = (await res.json().catch(() => ({}))) as { existing?: SearchRow[] };
          if (cancelled) return;
          if (!res.ok || !Array.isArray(body.existing)) {
            setStatus('error');
            setRows([]);
            return;
          }
          setRows(body.existing.filter((r) => !r.mergedIntoId));
          setStatus('done');
        } catch {
          if (!cancelled) setStatus('error');
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div className="flex flex-col gap-3" data-testid="equipment-request-search">
      <label className="flex flex-col gap-1 text-sm text-dr3-mist">
        {M.searchLabel}
        <input
          type="search"
          value={q}
          placeholder={M.searchPlaceholder}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="equipment-request-search-input"
        />
      </label>
      {status === 'idle' && <p className="text-xs text-dr3-mist-dim">{M.searchHint}</p>}
      {status === 'loading' && <p className="text-xs text-dr3-mist-dim">{M.searching}</p>}
      {status === 'error' && (
        <p className="text-xs text-red-200" role="alert">
          {M.searchFailed}
        </p>
      )}
      {status === 'done' && rows.length === 0 && (
        <p className="text-xs text-dr3-mist-dim" data-testid="equipment-request-no-matches">
          {M.noMatches}
        </p>
      )}
      {status === 'done' && rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-dr3-space-2/70 px-3 py-2"
              data-testid={`equipment-request-result-${r.id}`}
            >
              <span className="text-sm text-dr3-mist">
                {r.displayName}
                <span className="text-dr3-mist-dim">
                  {' '}
                  · {r.category} · {r.siteCode ?? E.fleetWideShort}
                </span>
                {!r.isActive ? (
                  <span className="ms-2 rounded-full bg-stone-900/60 px-2 py-0.5 text-xs text-stone-300">
                    {E.statusInactive}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => void onUse(r.id, r.isActive)}
                disabled={busy}
                className="rounded-md bg-dr3-cyan px-3 py-1.5 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
                data-testid={`equipment-request-use-${r.id}`}
              >
                {r.isActive ? E.useExisting : E.reactivateAndUse}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A starting point for the asset name — or NOTHING, which is often the honest
 * answer.
 *
 * ADR-0075 tightened this. The old version took the first 60 characters of the
 * first line and offered them as a name, and production shows what that
 * produced: a request reading "Fix and repair trailer: 53489, 5340, 35, 282859
 * going to Oregon Stores" is a work order covering FOUR trailers, and seeding it
 * into a `display_name` field puts invoice prose into the AP approver's picker
 * forever. A pre-filled bad name is worse than an empty field, because the
 * resolver is being asked to approve a suggestion rather than write an answer.
 *
 * So: first line only, leading work-order verbs stripped, and an empty string
 * whenever the text looks like a JOB rather than a THING — a comma list (several
 * units in one request) or anything long enough to be a sentence.
 */
const SUGGEST_MAX = 40;
/** Leading work-order verbs, stripped repeatedly ("Fix and repair trailer:"). */
const LEADING_VERB =
  /^(?:fix(?:ed|ing)?|repair(?:ed|ing|s)?|replace(?:d|ment)?|service(?:d|ing)?|maintenance|install(?:ed)?|inspect(?:ed|ion)?|check(?:ed)?|and)\b[\s:;,-]*/i;

export function suggestName(description: string): string {
  const firstLine = (description.split(/[\n·]/)[0] ?? description).trim();
  // A comma list is several units in one request; there is no single name to
  // suggest, and picking the first would file the invoice against one trailer
  // out of four.
  if (firstLine.includes(',')) return '';

  let name = firstLine;
  // Bounded — a pathological input must not spin here.
  for (let i = 0; i < 5; i += 1) {
    const next = name.replace(LEADING_VERB, '');
    if (next === name) break;
    name = next;
  }
  name = name.replace(/[\s:;-]+$/, '').trim();

  return name.length > 0 && name.length <= SUGGEST_MAX ? name : '';
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wide text-dr3-mist-dim/70">{label}</dt>
      <dd className="text-dr3-mist">{value}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: EquipmentRequestRow['status'] }) {
  const cls =
    status === 'open'
      ? 'bg-dr3-cyan/20 text-dr3-cyan'
      : status === 'resolved'
        ? 'bg-emerald-500/20 text-emerald-300'
        : 'bg-amber-500/20 text-amber-300';
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}
