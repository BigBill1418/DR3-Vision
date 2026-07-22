'use client';

// ADR-0046 Amendment 5 (D-M5-5) — invoice history search client. Builds the filter
// query string, GETs /api/admin/ap/history, renders the union table, and opens a
// per-row detail modal (full decision context for Vision rows; raw values for
// imports). No <form> submit — an explicit "Search" onClick.

import { useCallback, useState } from 'react';

export interface ApproverOption {
  id: string;
  name: string;
}

interface HistoryEntry {
  id: string;
  source: 'vision' | 'import';
  vendorName: string;
  amountCents: number | null;
  invoiceDate: string;
  siteCode: string | null;
  status?: string;
  approverName?: string | null;
  explanation?: string | null;
  decisionNote?: string | null;
  importedBy?: string | null;
}

const usd = (cents: number | null): string =>
  cents === null ? '—' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const SITE_LABEL: Record<string, string> = {
  woodland: 'Woodland',
  eugene: 'Eugene',
  not_dr3: 'NOT DR3',
};

export function HistoryClient({ approvers }: { approvers: ApproverOption[] }) {
  const [vendor, setVendor] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [site, setSite] = useState('');
  const [approverId, setApproverId] = useState('');
  const [source, setSource] = useState('');
  const [rows, setRows] = useState<HistoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);

  const search = useCallback(async () => {
    setBusy(true);
    const q = new URLSearchParams();
    if (vendor.trim()) q.set('vendor', vendor.trim());
    if (dateFrom) q.set('dateFrom', dateFrom);
    if (dateTo) q.set('dateTo', dateTo);
    if (amountMin.trim()) q.set('amountMin', amountMin.trim());
    if (amountMax.trim()) q.set('amountMax', amountMax.trim());
    if (site) q.set('site', site);
    if (approverId) q.set('approverId', approverId);
    if (source) q.set('source', source);
    try {
      const res = await fetch(`/api/admin/ap/history?${q.toString()}`);
      if (res.ok) {
        const b = (await res.json()) as { rows: HistoryEntry[] };
        setRows(b.rows);
      } else {
        setRows([]);
      }
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [vendor, dateFrom, dateTo, amountMin, amountMax, site, approverId, source]);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <Field label="Vendor">
          <input
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="type to match…"
            className="w-44 rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="From">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm" />
        </Field>
        <Field label="To">
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm" />
        </Field>
        <Field label="Min $">
          <input value={amountMin} onChange={(e) => setAmountMin(e.target.value)} inputMode="numeric" placeholder="0" className="w-20 rounded border border-gray-300 px-2 py-1 text-right text-sm" />
        </Field>
        <Field label="Max $">
          <input value={amountMax} onChange={(e) => setAmountMax(e.target.value)} inputMode="numeric" placeholder="∞" className="w-20 rounded border border-gray-300 px-2 py-1 text-right text-sm" />
        </Field>
        <Field label="Site">
          <select value={site} onChange={(e) => setSite(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm">
            <option value="">Any</option>
            <option value="woodland">Woodland</option>
            <option value="eugene">Eugene</option>
            <option value="not_dr3">NOT DR3</option>
          </select>
        </Field>
        <Field label="Approver">
          <select value={approverId} onChange={(e) => setApproverId(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm">
            <option value="">Any</option>
            {approvers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source">
          <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm">
            <option value="">Both</option>
            <option value="vision">Vision-decided</option>
            <option value="import">Imported history</option>
          </select>
        </Field>
        <button
          onClick={search}
          disabled={busy}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {rows && (
        <div className="mt-4">
          <div className="mb-2 text-sm text-gray-600">{rows.length} result{rows.length === 1 ? '' : 's'}</div>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Vendor</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Site</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Approver</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                      No matching invoices.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={`${r.source}-${r.id}`} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 tabular-nums text-gray-600">{r.invoiceDate}</td>
                      <td className="px-3 py-1.5">{r.vendorName || '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.amountCents)}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.siteCode ? (SITE_LABEL[r.siteCode] ?? r.siteCode) : '—'}</td>
                      <td className="px-3 py-1.5">
                        <span className={r.source === 'vision' ? 'text-emerald-700' : 'text-gray-500'}>
                          {r.source === 'vision' ? 'Vision' : 'Import'}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-gray-600">{r.approverName ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button onClick={() => setSelected(r)} className="text-xs text-emerald-700 hover:underline">
                          Detail
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && <DetailModal entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="text-xs text-gray-600">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
    </label>
  );
}

function DetailModal({ entry, onClose }: { entry: HistoryEntry; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{entry.vendorName || '(no vendor)'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
        <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-gray-500">Source</dt>
          <dd>{entry.source === 'vision' ? 'Vision-decided' : 'Imported history (Bill upload)'}</dd>
          <dt className="text-gray-500">Date</dt>
          <dd className="tabular-nums">{entry.invoiceDate}</dd>
          <dt className="text-gray-500">Amount</dt>
          <dd className="tabular-nums">{usd(entry.amountCents)}</dd>
          <dt className="text-gray-500">Site</dt>
          <dd>{entry.siteCode ? (SITE_LABEL[entry.siteCode] ?? entry.siteCode) : '—'}</dd>
          {entry.source === 'vision' && (
            <>
              <dt className="text-gray-500">Status</dt>
              <dd>{entry.status ?? '—'}</dd>
              <dt className="text-gray-500">Approver</dt>
              <dd>{entry.approverName ?? '—'}</dd>
              <dt className="text-gray-500">Explanation</dt>
              <dd>{entry.explanation ?? '—'}</dd>
              <dt className="text-gray-500">Note</dt>
              <dd>{entry.decisionNote ?? '—'}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
