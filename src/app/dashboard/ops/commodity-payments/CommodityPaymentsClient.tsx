'use client';

// ADR-0052 — the reconciliation working surface. Filter by site/status, edit
// one load's payment record inline (forward transitions only — the server
// re-validates), watch aging, export the filtered view as CSV.

import { useCallback, useMemo, useState } from 'react';
import type { PaymentListRow } from '@/lib/commodity-payments/payments';

type Status = 'awaiting_invoice' | 'invoiced' | 'paid' | 'disputed';

const STATUS_LABEL: Record<Status, string> = {
  awaiting_invoice: 'Awaiting invoice',
  invoiced: 'Invoiced',
  paid: 'Paid',
  disputed: 'Disputed',
};

const STATUS_CHIP: Record<Status, string> = {
  awaiting_invoice: 'bg-amber-400/15 text-amber-300 border-amber-400/40',
  invoiced: 'bg-dr3-cyan/10 text-dr3-cyan border-dr3-cyan/40',
  paid: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/40',
  disputed: 'bg-red-400/15 text-red-300 border-red-400/40',
};

/** Forward transitions the UI offers (mirror of the server table). */
const NEXT: Record<Status, Status[]> = {
  awaiting_invoice: ['invoiced', 'disputed'],
  invoiced: ['paid', 'disputed'],
  disputed: ['invoiced', 'paid'],
  paid: ['disputed'],
};

interface SiteOpt {
  id: string;
  name: string;
}

export function CommodityPaymentsClient({
  initialRows,
  sites,
}: {
  initialRows: PaymentListRow[];
  sites: SiteOpt[];
}) {
  const [rows, setRows] = useState<PaymentListRow[]>(initialRows);
  const [siteFilter, setSiteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [openLoad, setOpenLoad] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!siteFilter || r.siteId === siteFilter) && (!statusFilter || r.status === statusFilter),
      ),
    [rows, siteFilter, statusFilter],
  );

  const refresh = useCallback(async () => {
    const res = await fetch('/api/ops/commodity-payments');
    if (res.ok) {
      const body = (await res.json()) as { rows: PaymentListRow[] };
      setRows(body.rows);
    }
  }, []);

  const csvHref = useMemo(() => {
    const q = new URLSearchParams();
    if (siteFilter) q.set('site', siteFilter);
    if (statusFilter) q.set('status', statusFilter);
    const qs = q.toString();
    return `/api/ops/commodity-payments/export${qs ? `?${qs}` : ''}`;
  }, [siteFilter, statusFilter]);

  const counts = useMemo(() => {
    const c: Record<Status, number> = { awaiting_invoice: 0, invoiced: 0, paid: 0, disputed: 0 };
    for (const r of filtered) c[r.status] += 1;
    return c;
  }, [filtered]);

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs opacity-80">
          Site
          <select
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            className="mt-1 block rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-dr3-mist"
          >
            <option value="">Both sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs opacity-80">
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="mt-1 block rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-dr3-mist"
          >
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs opacity-70">
            {filtered.length} load{filtered.length === 1 ? '' : 's'} · {counts.awaiting_invoice}{' '}
            awaiting · {counts.invoiced} invoiced · {counts.paid} paid · {counts.disputed} disputed
          </span>
          <a
            href={csvHref}
            className="rounded bg-dr3-cyan px-3 py-1.5 text-sm font-semibold text-dr3-space"
          >
            Export CSV
          </a>
        </div>
      </div>

      {msg ? <p className="mt-3 text-sm text-amber-300">{msg}</p> : null}

      <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide opacity-80">
            <tr>
              <th className="px-3 py-2">Shipped</th>
              <th className="px-3 py-2">Site</th>
              <th className="px-3 py-2">Commodity</th>
              <th className="px-3 py-2">Buyer</th>
              <th className="px-3 py-2">Ticket</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Invoice #</th>
              <th className="px-3 py-2 text-right">Expected $</th>
              <th className="px-3 py-2 text-right">Age (ship)</th>
              <th className="px-3 py-2 text-right">Age (invoice)</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <PaymentRow
                key={r.loadId}
                row={r}
                open={openLoad === r.loadId}
                onToggle={() => setOpenLoad(openLoad === r.loadId ? null : r.loadId)}
                busy={busy}
                setBusy={setBusy}
                setMsg={setMsg}
                onSaved={refresh}
              />
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center opacity-60">
                  No loads match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function agingClass(days: number | null, threshold: number): string {
  if (days === null) return 'opacity-50';
  return days > threshold ? 'font-semibold text-amber-300' : '';
}

function PaymentRow({
  row,
  open,
  onToggle,
  busy,
  setBusy,
  setMsg,
  onSaved,
}: {
  row: PaymentListRow;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setMsg: (m: string | null) => void;
  onSaved: () => Promise<void>;
}) {
  const [invoiceRef, setInvoiceRef] = useState(row.buyerInvoiceRef ?? '');
  const [amount, setAmount] = useState(row.expectedAmount ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');

  const save = async (status?: Status) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/ops/commodity-payments/${row.loadId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(status ? { status } : {}),
          buyerInvoiceRef: invoiceRef.trim() || null,
          expectedAmount: amount.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMsg(body.error ?? `save failed (${res.status})`);
      } else {
        await onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr className="border-t border-white/5 hover:bg-white/5">
        <td className="whitespace-nowrap px-3 py-2">{row.shipDateISO}</td>
        <td className="px-3 py-2">{row.siteName}</td>
        <td className="px-3 py-2">
          {row.commodity}
          <span className="opacity-50"> / {row.subCategory}</span>
        </td>
        <td className="px-3 py-2">{row.buyer ?? <span className="opacity-40">—</span>}</td>
        <td className="px-3 py-2">{row.ticketNumber ?? <span className="opacity-40">—</span>}</td>
        <td className="px-3 py-2">
          <span
            className={`inline-block rounded-full border px-2 py-0.5 text-xs ${STATUS_CHIP[row.status]}`}
          >
            {STATUS_LABEL[row.status]}
          </span>
        </td>
        <td className="px-3 py-2">
          {row.buyerInvoiceRef ?? <span className="opacity-40">—</span>}
        </td>
        <td className="px-3 py-2 text-right">{row.expectedAmount ?? ''}</td>
        <td className={`px-3 py-2 text-right ${agingClass(row.daysSinceShip, 30)}`}>
          {row.daysSinceShip}d
        </td>
        <td className={`px-3 py-2 text-right ${agingClass(row.daysSinceInvoiced, 45)}`}>
          {row.daysSinceInvoiced === null ? '—' : `${row.daysSinceInvoiced}d`}
        </td>
        <td className="px-3 py-2 text-right">
          <button onClick={onToggle} className="text-xs text-dr3-cyan underline">
            {open ? 'Close' : 'Update'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-white/5 bg-black/30">
          <td colSpan={11} className="px-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs opacity-80">
                Buyer invoice #
                <input
                  value={invoiceRef}
                  onChange={(e) => setInvoiceRef(e.target.value)}
                  className="mt-1 block w-44 rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-dr3-mist"
                />
              </label>
              <label className="text-xs opacity-80">
                Expected $ (optional)
                <input
                  value={amount}
                  inputMode="decimal"
                  placeholder="1234.50"
                  onChange={(e) => setAmount(e.target.value)}
                  className="mt-1 block w-32 rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-dr3-mist"
                />
              </label>
              <label className="grow text-xs opacity-80">
                Notes
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="mt-1 block w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-dr3-mist"
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => save()}
                disabled={busy}
                className="rounded border border-white/20 px-3 py-1.5 text-sm disabled:opacity-40"
              >
                Save fields
              </button>
              {NEXT[row.status].map((s) => (
                <button
                  key={s}
                  onClick={() => save(s)}
                  disabled={busy}
                  className="rounded bg-dr3-cyan px-3 py-1.5 text-sm font-semibold text-dr3-space disabled:opacity-40"
                >
                  Mark {STATUS_LABEL[s].toLowerCase()}
                </button>
              ))}
              <span className="text-xs opacity-60">
                Marking invoiced/paid stamps today&apos;s date automatically; every change is
                audited.
              </span>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
