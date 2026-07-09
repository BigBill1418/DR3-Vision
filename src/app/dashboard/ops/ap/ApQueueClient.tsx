'use client';

// ADR-0046 D4 — AP approval queue client. The request body is the sanitized HTML
// (already allowlisted server-side at ingest) rendered inside a MAXIMALLY
// restrictive sandboxed <iframe sandbox=""> (no scripts, no same-origin, no forms)
// — the belt-and-suspenders second control after ingest sanitization. Per hard
// rule #10, decisions use onClick handlers, never <form> elements.

import { useCallback, useEffect, useState } from 'react';

type Status = 'pending' | 'approved' | 'rejected' | 'quarantined';
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
  attachments: AttachmentView[];
  followups: Array<{ id: string; receivedAt: string; senderAddress: string; bodyText: string | null }>;
}

const TABS: Filter[] = ['pending', 'approved', 'rejected', 'quarantined', 'all'];

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
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
              filter === t ? 'bg-dr3-chartreuse text-dr3-ink' : 'bg-white/10 text-white hover:bg-white/20'
            }`}
          >
            {t}
            {t !== 'all' && ` (${counts[t] ?? 0})`}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 rounded bg-red-900/40 px-3 py-2 text-sm text-red-100">{error}</p>}

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(280px,360px)_1fr]">
        <ul className="space-y-2">
          {loading && rows.length === 0 && <li className="text-sm opacity-70">Loading…</li>}
          {!loading && rows.length === 0 && <li className="text-sm opacity-70">No requests.</li>}
          {rows.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => setSelectedId(r.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left ${
                  selectedId === r.id ? 'border-dr3-chartreuse bg-white/10' : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{r.subject ?? '(no subject)'}</span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="mt-1 truncate text-xs opacity-70">
                  {r.senderAddress}
                  {!r.senderValidated && ' · external'} · {fmt(r.receivedAt)}
                </div>
                <div className="mt-1 text-xs opacity-60">
                  {r.attachmentCount} attachment{r.attachmentCount === 1 ? '' : 's'}
                  {r.followupCount > 0 && ` · ${r.followupCount} follow-up${r.followupCount === 1 ? '' : 's'}`}
                  {r.vendor && ` · ${r.vendor}`}
                  {r.amountCents !== null && ` · ${dollars(r.amountCents)}`}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div>{detail ? <DetailPanel detail={detail} onDecided={refresh} /> : <p className="text-sm opacity-60">Select a request to review.</p>}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const color: Record<Status, string> = {
    pending: 'bg-amber-400 text-dr3-ink',
    approved: 'bg-emerald-500 text-white',
    rejected: 'bg-red-500 text-white',
    quarantined: 'bg-zinc-500 text-white',
  };
  return <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase ${color[status]}`}>{status}</span>;
}

function DetailPanel({ detail, onDecided }: { detail: Detail; onDecided: () => void }) {
  const [note, setNote] = useState('');
  const [vendor, setVendor] = useState(detail.vendor ?? '');
  const [amount, setAmount] = useState(detail.amountCents !== null ? (detail.amountCents / 100).toFixed(2) : '');
  const [siteCode, setSiteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: 'approved' | 'rejected') => {
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
            siteId: siteCode || undefined,
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
      setMsg(res.ok ? `Re-send result: ${body.mail}` : body.error ?? `re-send failed (${res.status})`);
    } finally {
      setBusy(false);
      onDecided();
    }
  }, [detail.id, onDecided]);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{detail.subject ?? '(no subject)'}</h2>
          <p className="mt-0.5 text-xs opacity-70">
            {detail.senderAddress} {detail.senderValidated ? '· internal' : '· EXTERNAL (unapprovable)'} · {fmt(detail.receivedAt)}
          </p>
        </div>
        <StatusBadge status={detail.status} />
      </div>

      {detail.status === 'quarantined' && (
        <p className="mt-3 rounded bg-zinc-700/40 px-3 py-2 text-sm">
          Quarantined ({detail.quarantineReason ?? 'unprocessable'}) — admin review only, not approvable.
        </p>
      )}

      {detail.decidedByName && (
        <p className="mt-3 text-sm opacity-80">
          Decided by {detail.decidedByName}
          {detail.decidedAt && ` at ${fmt(detail.decidedAt)}`}
          {detail.decisionNote && ` — “${detail.decisionNote}”`}
          {detail.decisionMailSentAt ? ' · decision emailed.' : ' · decision email NOT confirmed sent.'}
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
                {f.bodyText && <div className="mt-1 whitespace-pre-wrap opacity-90">{f.bodyText}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.status === 'pending' && (
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
              Site (optional)
              <select
                value={siteCode}
                onChange={(e) => setSiteCode(e.target.value)}
                className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
              >
                <option value="">— none —</option>
                <option value="eugene">Eugene</option>
                <option value="woodland">Woodland</option>
              </select>
            </label>
          </div>
          <label className="mt-2 block text-xs opacity-80">
            Note (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide('approved')}
              disabled={busy}
              className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => decide('rejected')}
              disabled={busy}
              className="rounded bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </section>
      )}

      {(detail.status === 'approved' || detail.status === 'rejected') && (
        <div className="mt-4">
          <button onClick={resend} disabled={busy} className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-50">
            Re-send decision email
          </button>
        </div>
      )}

      {msg && <p className="mt-3 rounded bg-black/30 px-3 py-2 text-sm">{msg}</p>}
    </div>
  );
}

function AttachmentRow({ requestId, att }: { requestId: string; att: AttachmentView }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const open = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/ops/ap/${requestId}/attachment/${att.id}`);
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.url) window.open(body.url, '_blank', 'noopener');
      else setErr(body.error ?? `download failed (${res.status})`);
    } finally {
      setBusy(false);
    }
  }, [requestId, att.id]);

  if (att.kind === 'reference_link') {
    return (
      <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
        🔗 Reference link: {att.filename ?? 'link'} —{' '}
        {att.linkUrl ? (
          <a href={att.linkUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline">
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
  return (
    <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
      📄 {att.filename ?? 'attachment'} {att.byteSize ? `(${att.byteSize} bytes)` : ''}{' '}
      <button onClick={open} disabled={busy} className="ml-1 underline disabled:opacity-50">
        download
      </button>
      {err && <span className="ml-2 text-red-300">{err}</span>}
    </li>
  );
}
