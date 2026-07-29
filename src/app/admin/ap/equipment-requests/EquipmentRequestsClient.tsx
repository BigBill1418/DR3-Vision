'use client';

// ADR-0046 Amendment 9 (§2.5) — the worklist rows + the resolve/reject actions.
//
// CLAUDE.md hard rule #10 — no `<form>` element anywhere; every action is an
// `onClick`. The resolve panel embeds the EXISTING `/admin/equipment` create form
// (ADR-0063) rather than a second copy of it: same validation, same category
// list, same site-defaulting rule, pre-filled from the approver's description and
// posted at the resolve endpoint via its `endpoint` / `extraBody` seam.

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EquipmentCreateForm } from '@/app/admin/equipment/new/EquipmentCreateForm';
import { pacificAgeLabel } from './age';

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
}

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

const usd = (cents: number | null): string =>
  typeof cents === 'number'
    ? (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : '—';

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
        Nothing here. When an approver describes equipment that isn’t in the fleet list, it lands on
        this list.
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
  const [mode, setMode] = useState<'idle' | 'resolve' | 'reject'>('idle');
  const [backfill, setBackfill] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reject = useCallback(async () => {
    if (!note.trim()) {
      setError('A rejection needs a note explaining why.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/ap/equipment-requests/${request.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', note: note.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Could not reject this request.');
        return;
      }
      setMode('idle');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [note, request.id, router]);

  const open = request.status === 'open';

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
            {request.requesterName ?? 'An approver'} · {request.siteName ?? request.siteCode ?? '—'}{' '}
            · waiting {pacificAgeLabel(new Date(request.requestedAt))}
          </p>
        </div>
        <StatusPill status={request.status} />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-dr3-mist-dim sm:grid-cols-3">
        <Row label="Vendor" value={request.vendor ?? '—'} />
        <Row label="Amount" value={usd(request.amountCents)} />
        <Row label="Invoice" value={request.subject ?? '(no subject)'} />
      </dl>

      {request.status === 'resolved' && (
        <p className="text-xs text-emerald-300">
          Added as <b>{request.resolvedEquipmentName}</b>
          {request.resolverName ? ` by ${request.resolverName}` : ''}
          {request.linkPending
            ? ' · the original invoice was NOT repointed at it'
            : ' · the original invoice now points at it'}
        </p>
      )}
      {request.status === 'rejected' && request.resolutionNote && (
        <p className="text-xs text-amber-300">
          Not equipment — “{request.resolutionNote}”
          {request.resolverName ? ` (${request.resolverName})` : ''}. The invoice stays approved.
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
            onClick={() => setMode('resolve')}
            className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright"
            data-testid="equipment-request-resolve"
          >
            Add to the fleet
          </button>
          <button
            type="button"
            onClick={() => setMode('reject')}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
            data-testid="equipment-request-reject"
          >
            Not equipment
          </button>
          <a
            href={`/dashboard/ops/ap?request=${encodeURIComponent(request.apRequestId)}`}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            View the invoice
          </a>
        </div>
      )}

      {open && mode === 'resolve' && (
        <section className="flex flex-col gap-4 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 p-4">
          <p className="text-xs text-dr3-mist-dim">
            Give the asset the name the crew will recognise in the approver’s picker — the
            description above is what they wrote, not necessarily the name.
          </p>
          <label className="flex items-center gap-2 text-sm text-dr3-mist">
            <input
              type="checkbox"
              checked={backfill}
              onChange={(e) => setBackfill(e.target.checked)}
              data-testid="equipment-request-backfill"
            />
            <span>
              Point the original invoice at this new asset
              <span className="block text-xs text-dr3-mist-dim">
                Recommended — it makes the historical invoice read correctly instead of leaving it
                attached to a description.
              </span>
            </span>
          </label>
          <EquipmentCreateForm
            sites={sites}
            initialDisplayName={suggestName(request.description)}
            initialSiteCode={request.siteCode ?? undefined}
            endpoint={`/api/admin/ap/equipment-requests/${request.id}`}
            extraBody={{ action: 'resolve', backfillLink: backfill }}
            submitLabel="Add to the fleet"
            onSaved={() => {
              setMode('idle');
              router.refresh();
            }}
            backHref="/admin/ap/equipment-requests"
          />
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="self-start text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            Never mind
          </button>
        </section>
      )}

      {open && mode === 'reject' && (
        <section className="flex flex-col gap-3 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 p-4">
          <label className="flex flex-col gap-2 text-sm text-dr3-mist">
            Why isn’t this equipment? <span className="text-amber-300">(required)</span>
            <textarea
              value={note}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
              data-testid="equipment-request-reject-note"
            />
            <span className="text-xs text-dr3-mist-dim">
              The invoice stays approved either way — this only records that no asset needed adding.
            </span>
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={reject}
              disabled={busy || !note.trim()}
              className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-dr3-space disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="equipment-request-reject-submit"
            >
              Record as not equipment
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
            >
              Never mind
            </button>
          </div>
        </section>
      )}
    </article>
  );
}

/**
 * First line of the description, capped — a starting point for the asset name,
 * never the name itself. The resolver always edits it; pre-filling the whole
 * multi-sentence description would produce a picker entry nobody can read.
 */
function suggestName(description: string): string {
  const firstLine = description.split(/[\n.·]/)[0] ?? description;
  return firstLine.trim().slice(0, 60);
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
