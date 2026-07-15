'use client';

// ADR-0046 D4 — AP approval queue client. The request body is the sanitized HTML
// (already allowlisted server-side at ingest) rendered inside a MAXIMALLY
// restrictive sandboxed <iframe sandbox=""> (no scripts, no same-origin, no forms)
// — the belt-and-suspenders second control after ingest sanitization. Per hard
// rule #10, decisions use onClick handlers, never <form> elements.

import { useCallback, useEffect, useState } from 'react';

type Status = 'pending' | 'pending_review' | 'approved' | 'rejected' | 'quarantined';
type Filter = Status | 'all';

interface ListRow {
  id: string;
  status: Status;
  subject: string | null;
  senderAddress: string;
  senderValidated: boolean;
  receivedAt: string;
  vendor: string | null;
  amountCents: number | null;
  attachmentCount: number;
  followupCount: number;
  heldByName: string | null;
  holdNote: string | null;
}
interface AttachmentView {
  id: string;
  kind: 'file' | 'nested_message' | 'reference_link';
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  storageKey: string | null;
  linkUrl: string | null;
  nestedSubject: string | null;
}
interface Detail extends ListRow {
  conversationId: string | null;
  bodyHtmlSanitized: string | null;
  bodyText: string | null;
  quarantineReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decisionMailSentAt: string | null;
  heldByName: string | null;
  heldAt: string | null;
  holdNote: string | null;
  attachments: AttachmentView[];
  followups: Array<{
    id: string;
    receivedAt: string;
    senderAddress: string;
    bodyText: string | null;
  }>;
}

const TABS: Filter[] = ['pending', 'pending_review', 'approved', 'rejected', 'quarantined', 'all'];

/** Tab/label text — the raw enum value `pending_review` reads as "On hold". */
const STATUS_LABEL: Record<Filter, string> = {
  pending: 'pending',
  pending_review: 'on hold',
  approved: 'approved',
  rejected: 'rejected',
  quarantined: 'quarantined',
  all: 'all',
};

// Render timestamps in Bill's Pacific wall clock, not the browser's local zone —
// toLocaleString() with no timeZone trusts wherever the viewer's machine is set.
// Pin the zone explicitly and label ' PT', matching the AP email + stamp surfaces
// (formatPacificDateTime's medium/short shape).
function fmt(iso: string): string {
  const at = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${at} PT`;
}
function dollars(cents: number | null): string {
  return cents === null ? '' : `$${(cents / 100).toFixed(2)}`;
}

export function ApQueueClient() {
  const [filter, setFilter] = useState<Filter>('pending');
  const [rows, setRows] = useState<ListRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (f: Filter) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ops/ap?status=${f}`);
      if (!res.ok) throw new Error(`list failed (${res.status})`);
      const body = await res.json();
      setRows(body.rows);
      setCounts(body.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/ops/ap/${id}`);
      if (!res.ok) throw new Error(`detail failed (${res.status})`);
      const body = await res.json();
      setDetail(body.request);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load request');
    }
  }, []);

  // Tier-1 deep link: the new-request email links to /dashboard/ops/ap?request=<id>.
  // Open that request on mount (client-only — 'use client', no SSR/Suspense concern).
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('request');
    if (requested) {
      setFilter('all');
      setSelectedId(requested);
    }
  }, []);

  useEffect(() => {
    void loadList(filter);
  }, [filter, loadList]);
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const refresh = useCallback(() => {
    void loadList(filter);
    if (selectedId) void loadDetail(selectedId);
  }, [filter, selectedId, loadList, loadDetail]);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`rounded-full px-3 py-1 text-sm capitalize ${
              filter === t
                ? 'bg-dr3-cyan text-dr3-space'
                : 'bg-dr3-steel/30 text-dr3-mist hover:bg-dr3-steel/50'
            }`}
          >
            {STATUS_LABEL[t]}
            {t !== 'all' && ` (${counts[t] ?? 0})`}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-4 rounded bg-red-900/40 px-3 py-2 text-sm text-red-100">{error}</p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(280px,360px)_1fr]">
        <ul className="space-y-2">
          {loading && rows.length === 0 && <li className="text-sm opacity-70">Loading…</li>}
          {!loading && rows.length === 0 && <li className="text-sm opacity-70">No requests.</li>}
          {rows.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => setSelectedId(r.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left ${
                  selectedId === r.id
                    ? 'border-dr3-cyan bg-white/10'
                    : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {r.subject ?? '(no subject)'}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="mt-1 truncate text-xs opacity-70">
                  {r.senderAddress}
                  {!r.senderValidated && ' · external'} · {fmt(r.receivedAt)}
                </div>
                <div className="mt-1 text-xs opacity-60">
                  {r.attachmentCount} attachment{r.attachmentCount === 1 ? '' : 's'}
                  {r.followupCount > 0 &&
                    ` · ${r.followupCount} follow-up${r.followupCount === 1 ? '' : 's'}`}
                  {r.vendor && ` · ${r.vendor}`}
                  {r.amountCents !== null && ` · ${dollars(r.amountCents)}`}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div>
          {detail ? (
            <DetailPanel detail={detail} onDecided={refresh} />
          ) : (
            <p className="text-sm opacity-60">Select a request to review.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const color: Record<Status, string> = {
    // pending shifts to sky so the amber hold chip is unmistakably distinct.
    pending: 'bg-sky-400 text-dr3-ink',
    pending_review: 'bg-amber-400 text-dr3-ink',
    approved: 'bg-emerald-500 text-white',
    rejected: 'bg-red-500 text-white',
    quarantined: 'bg-zinc-500 text-white',
  };
  const label = status === 'pending_review' ? 'on hold' : status;
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase ${color[status]}`}
    >
      {label}
    </span>
  );
}

function DetailPanel({ detail, onDecided }: { detail: Detail; onDecided: () => void }) {
  const [note, setNote] = useState('');
  const [vendor, setVendor] = useState(detail.vendor ?? '');
  const [amount, setAmount] = useState(
    detail.amountCents !== null ? (detail.amountCents / 100).toFixed(2) : '',
  );
  const [siteCode, setSiteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: 'approved' | 'rejected') => {
      // Amendment 3 — a rejection must say why (plain-English client guard; the
      // server re-validates). Approvals stay note-optional.
      if (decision === 'rejected' && !note.trim()) {
        setMsg('A rejection needs a note explaining why. Add a note, then Reject.');
        return;
      }
      // Operator directive 2026-07-15 — every decision files against a site
      // (the server re-validates).
      if (!siteCode) {
        setMsg('Select the site (Woodland or Eugene) before deciding.');
        return;
      }
      setBusy(true);
      setMsg(null);
      try {
        const amountCents = amount.trim() ? Math.round(parseFloat(amount) * 100) : undefined;
        const res = await fetch(`/api/ops/ap/${detail.id}/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision,
            note: note.trim() || undefined,
            vendor: vendor.trim() || undefined,
            amountCents: Number.isFinite(amountCents) ? amountCents : undefined,
            siteId: siteCode,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.alreadyDecided) {
          setMsg(`This request was ${body.error}. Refreshing.`);
        } else if (!res.ok) {
          setMsg(body.error ?? `decide failed (${res.status})`);
        } else {
          const mailNote =
            body.mail === 'sent'
              ? 'decision emailed to accounting.'
              : body.mail === 'refused_no_recipients'
                ? 'DECIDED, but no decision-recipient configured — email NOT sent (an operator alert was raised). Configure recipients, then Re-send.'
                : body.mail === 'disabled'
                  ? 'decided (mail disabled — M365 not configured).'
                  : 'decided, but the decision email failed to send. Use Re-send.';
          setMsg(`Request ${decision}; ${mailNote}`);
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'decide failed');
      } finally {
        setBusy(false);
        onDecided();
      }
    },
    [amount, note, vendor, siteCode, detail.id, onDecided],
  );

  const resend = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/ops/ap/${detail.id}/resend`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      setMsg(
        res.ok ? `Re-send result: ${body.mail}` : (body.error ?? `re-send failed (${res.status})`),
      );
    } finally {
      setBusy(false);
      onDecided();
    }
  }, [detail.id, onDecided]);

  // Amendment 3 — place the request on hold ("pending review"), REQUIRED note.
  const placeHold = useCallback(async () => {
    if (!note.trim()) {
      setMsg('A hold needs a note explaining why it is being held. Add a note, then Hold.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/ops/ap/${detail.id}/hold`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.alreadyDecided)
        setMsg(`This request was ${body.error}. Refreshing.`);
      else if (!res.ok) setMsg(body.error ?? `hold failed (${res.status})`);
      else setMsg('Placed on hold; accounting was notified it is under review.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'hold failed');
    } finally {
      setBusy(false);
      onDecided();
    }
  }, [note, detail.id, onDecided]);

  // Amendment 3 — update the hold note on an on-hold request, REQUIRED note.
  const saveHoldNote = useCallback(async () => {
    if (!note.trim()) {
      setMsg('The hold note cannot be empty.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/ops/ap/${detail.id}/hold`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? 'Hold note updated.' : (body.error ?? `update failed (${res.status})`));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'update failed');
    } finally {
      setBusy(false);
      onDecided();
    }
  }, [note, detail.id, onDecided]);

  const actionable = detail.status === 'pending' || detail.status === 'pending_review';

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{detail.subject ?? '(no subject)'}</h2>
          <p className="mt-0.5 text-xs opacity-70">
            {detail.senderAddress}{' '}
            {detail.senderValidated ? '· internal' : '· EXTERNAL (unapprovable)'} ·{' '}
            {fmt(detail.receivedAt)}
          </p>
        </div>
        <StatusBadge status={detail.status} />
      </div>

      {detail.status === 'quarantined' && (
        <p className="mt-3 rounded bg-zinc-700/40 px-3 py-2 text-sm">
          Quarantined ({detail.quarantineReason ?? 'unprocessable'}) — admin review only, not
          approvable.
        </p>
      )}

      {detail.status === 'pending_review' && (
        <div className="mt-3 rounded border border-amber-400/60 bg-amber-400/15 px-3 py-2 text-sm">
          <span className="font-semibold text-amber-200">ON HOLD — pending review</span>
          {detail.heldByName && <span className="opacity-90"> · held by {detail.heldByName}</span>}
          {detail.heldAt && <span className="opacity-70"> · {fmt(detail.heldAt)}</span>}
          {detail.holdNote && <div className="mt-1 opacity-90">“{detail.holdNote}”</div>}
        </div>
      )}

      {detail.decidedByName && (
        <p className="mt-3 text-sm opacity-80">
          Decided by {detail.decidedByName}
          {detail.decidedAt && ` at ${fmt(detail.decidedAt)}`}
          {detail.decisionNote && ` — “${detail.decisionNote}”`}
          {detail.decisionMailSentAt
            ? ' · decision emailed.'
            : ' · decision email NOT confirmed sent.'}
        </p>
      )}

      <section className="mt-4">
        <h3 className="text-sm font-semibold opacity-90">Message body</h3>
        {detail.bodyHtmlSanitized ? (
          <iframe
            // Maximally restrictive sandbox: no scripts, no same-origin, no forms.
            sandbox=""
            srcDoc={detail.bodyHtmlSanitized}
            title="invoice message body (sanitized)"
            className="mt-2 h-64 w-full rounded border border-white/10 bg-white"
          />
        ) : detail.bodyText ? (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-white/10 bg-black/30 p-3 text-sm">
            {detail.bodyText}
          </pre>
        ) : (
          <p className="mt-2 text-sm opacity-60">(no body)</p>
        )}
      </section>

      {detail.attachments.length > 0 && (
        <section className="mt-4">
          <h3 className="text-sm font-semibold opacity-90">Attachments</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.attachments.map((a) => (
              <AttachmentRow key={a.id} requestId={detail.id} att={a} />
            ))}
          </ul>
        </section>
      )}

      {detail.followups.length > 0 && (
        <section className="mt-4">
          <h3 className="text-sm font-semibold opacity-90">Follow-ups</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {detail.followups.map((f) => (
              <li key={f.id} className="rounded border border-white/10 bg-white/5 p-2">
                <div className="text-xs opacity-70">
                  {f.senderAddress} · {fmt(f.receivedAt)}
                </div>
                {f.bodyText && (
                  <div className="mt-1 whitespace-pre-wrap opacity-90">{f.bodyText}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {actionable && (
        <section className="mt-5 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold opacity-90">Decision</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="text-xs opacity-80">
              Vendor (optional)
              <input
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
              />
            </label>
            <label className="text-xs opacity-80">
              Amount USD (optional)
              <input
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
              />
            </label>
            <label className="text-xs opacity-80">
              Site <span className="text-amber-300">(required)</span>
              <select
                value={siteCode}
                onChange={(e) => setSiteCode(e.target.value)}
                className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
              >
                <option value="">— select site —</option>
                <option value="eugene">Eugene</option>
                <option value="woodland">Woodland</option>
              </select>
            </label>
          </div>
          <label className="mt-2 block text-xs opacity-80">
            Note{' '}
            <span className="opacity-70">(optional to approve · required to reject or hold)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={
                detail.status === 'pending_review'
                  ? 'Update the hold note, or add a reason to approve/reject'
                  : 'Reason (required to reject or hold)'
              }
              className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => decide('approved')}
              disabled={busy}
              className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => decide('rejected')}
              disabled={busy || !note.trim()}
              title={note.trim() ? undefined : 'A rejection requires a note'}
              className="rounded bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Reject
            </button>
            {detail.status === 'pending' && (
              <button
                onClick={placeHold}
                disabled={busy || !note.trim()}
                title={note.trim() ? undefined : 'A hold requires a note'}
                className="rounded bg-amber-400 px-4 py-2 text-sm font-semibold text-dr3-ink disabled:opacity-50"
              >
                Hold — pending review
              </button>
            )}
            {detail.status === 'pending_review' && (
              <button
                onClick={saveHoldNote}
                disabled={busy || !note.trim()}
                title={note.trim() ? undefined : 'Enter a note to update the hold'}
                className="rounded bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20 disabled:opacity-50"
              >
                Update hold note
              </button>
            )}
          </div>
        </section>
      )}

      {(detail.status === 'approved' || detail.status === 'rejected') && (
        <div className="mt-4">
          <button
            onClick={resend}
            disabled={busy}
            className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-50"
          >
            Re-send decision email
          </button>
        </div>
      )}

      {msg && <p className="mt-3 rounded bg-black/30 px-3 py-2 text-sm">{msg}</p>}
    </div>
  );
}

// ADR-0046 Amendment 4 — inline preview render rules (client mirror of the
// server allowlist; the server is authoritative and signs the inline URL only
// for these types). Anything past the cap opens in a new tab instead of framing.
const PREVIEW_SIZE_CAP = 15 * 1024 * 1024; // 15 MB
const isImagePreview = (ct: string | null): boolean =>
  !!ct && /^image\/(png|jpeg|jpg|webp)$/i.test(ct);
const isPdfPreview = (ct: string | null): boolean => (ct ?? '').toLowerCase() === 'application/pdf';

interface Presigned {
  url: string;
  inline: boolean;
  contentType: string | null;
}

function AttachmentRow({ requestId, att }: { requestId: string; att: AttachmentView }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [presigned, setPresigned] = useState<Presigned | null>(null);

  // Fetch (once) + cache the short-lived presigned URL for this attachment.
  const resolve = useCallback(async (): Promise<Presigned | null> => {
    if (presigned) return presigned;
    const res = await fetch(`/api/ops/ap/${requestId}/attachment/${att.id}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.url) {
      const p: Presigned = {
        url: body.url,
        inline: !!body.inline,
        contentType: body.contentType ?? att.contentType,
      };
      setPresigned(p);
      return p;
    }
    setErr(body.error ?? `download failed (${res.status})`);
    return null;
  }, [presigned, requestId, att.id, att.contentType]);

  const open = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await resolve();
      if (p) window.open(p.url, '_blank', 'noopener');
    } finally {
      setBusy(false);
    }
  }, [resolve]);

  // Collapse/expand the in-panel preview (so many attachments don't all render at
  // once). On first expand, resolve the URL; if the server declined inline (or the
  // file is over the cap), fall back to opening it in a new tab.
  const togglePreview = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const p = await resolve();
      if (p && p.inline) setExpanded(true);
      else if (p) window.open(p.url, '_blank', 'noopener');
    } finally {
      setBusy(false);
    }
  }, [expanded, resolve]);

  if (att.kind === 'reference_link') {
    return (
      <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
        🔗 Reference link: {att.filename ?? 'link'} —{' '}
        {att.linkUrl ? (
          <a
            href={att.linkUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline"
          >
            open in SharePoint/OneDrive
          </a>
        ) : (
          '(no url)'
        )}
        <span className="ml-1 opacity-60">(Vision never fetches this)</span>
      </li>
    );
  }
  if (att.kind === 'nested_message') {
    return (
      <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
        ✉️ Nested message: {att.nestedSubject ?? att.filename ?? '(forwarded message)'}
      </li>
    );
  }
  const previewable = isImagePreview(att.contentType) || isPdfPreview(att.contentType);
  const oversize = att.byteSize != null && att.byteSize > PREVIEW_SIZE_CAP;
  return (
    <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="truncate">
          📄 {att.filename ?? 'attachment'} {att.byteSize ? `(${att.byteSize} bytes)` : ''}
        </span>
        {previewable && !oversize && (
          <button onClick={togglePreview} disabled={busy} className="underline disabled:opacity-50">
            {expanded ? 'Hide preview' : 'Preview'}
          </button>
        )}
        {previewable && oversize && (
          <button onClick={open} disabled={busy} className="underline disabled:opacity-50">
            Preview large file →
          </button>
        )}
        <button onClick={open} disabled={busy} className="underline disabled:opacity-50">
          download
        </button>
        {err && <span className="text-red-300">{err}</span>}
      </div>
      {expanded && presigned?.inline && (
        <div className="mt-2">
          {isImagePreview(presigned.contentType) ? (
            // Presigned R2 image preview; Next/Image can't sign/proxy R2 GETs.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={presigned.url}
              alt={att.filename ?? 'attachment preview'}
              className="max-h-[32rem] w-auto max-w-full rounded border border-white/10 bg-white"
            />
          ) : (
            // No sandbox="" here: a full sandbox kills Chromium's built-in PDF
            // viewer. The frame is cross-origin (R2) and cannot script our origin;
            // CSP frame-src scopes it to the R2 host (ADR-0046 Amendment 4).
            <iframe
              src={presigned.url}
              title={att.filename ?? 'attachment preview'}
              className="h-[32rem] w-full rounded border border-white/10 bg-white"
            />
          )}
        </div>
      )}
    </li>
  );
}
