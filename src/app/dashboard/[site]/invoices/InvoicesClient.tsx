'use client';

// ADR-0041 — invoices list + generate panel. CLAUDE.md hard rule #10: no
// <form>; every handler is onClick/onChange. English-first (office surface).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface InvoiceListItem {
  id: string;
  kind: string;
  billingMonth: string;
  version: number;
  status: 'draft' | 'approved' | 'void';
  totalCents: number;
  supersedesId: string | null;
  generatedAt: string;
  approvedAt: string | null;
}

const KINDS: { id: string; label: string; site: 'CA' | 'OR' }[] = [
  { id: 'ca_processing_mid_month', label: 'CA Processing — Mid-Month', site: 'CA' },
  { id: 'ca_processing_eom', label: 'CA Processing — EOM', site: 'CA' },
  { id: 'ca_transportation_eom', label: 'CA Transportation — EOM', site: 'CA' },
  { id: 'or_processing_eom', label: 'OR Processing — EOM', site: 'OR' },
  { id: 'or_transportation_eom', label: 'OR Transportation — EOM', site: 'OR' },
  { id: 'or_collection_site_count', label: 'OR Collection-Site Count', site: 'OR' },
];

const KIND_LABEL = new Map(KINDS.map((k) => [k.id, k.label]));

export function money(cents: number): string {
  const neg = cents < 0;
  const v = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `($${v})` : `$${v}`;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const btnCls = 'rounded bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-white/15 text-white',
  approved: 'bg-dr3-chartreuse/90 text-black',
  void: 'bg-black/40 text-white/60 line-through',
};

export function InvoicesClient({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<InvoiceListItem[]>([]);
  const [kind, setKind] = useState<string>('ca_processing_eom');
  const [month, setMonth] = useState<string>(currentMonth());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/manager/${siteCode}/invoices`);
    if (!res.ok) {
      setRows([]);
      return;
    }
    const data = (await res.json()) as { rows: InvoiceListItem[] };
    setRows(data.rows);
  }, [siteCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, billingMonth: month }),
      });
      const data = (await res.json()) as { error?: string; findingCodes?: string[] };
      if (!res.ok) {
        setMsg({ kind: 'err', text: data.error ?? 'generation failed' });
      } else {
        setMsg({ kind: 'ok', text: 'Draft generated.' });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }, [siteCode, kind, month, load]);

  return (
    <div className="mt-8">
      <section className="rounded-lg border border-white/15 bg-black/20 p-5">
        <h2 className="text-lg font-semibold">Generate a draft</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="opacity-80">Invoice kind</span>
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="opacity-80">Billing month</span>
            <input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <button type="button" className={btnCls} onClick={() => void generate()} disabled={busy}>
            {busy ? 'Generating…' : 'Generate draft'}
          </button>
          {msg && (
            <span className={`text-sm ${msg.kind === 'ok' ? 'text-dr3-chartreuse' : 'text-red-300'}`}>{msg.text}</span>
          )}
        </div>
        <p className="mt-3 text-xs opacity-60">
          A draft is a preview — it is not billable until approved. Regenerating replaces the current draft with a new
          version. The OR collection-site-count invoice is built from manually-entered lines (no data feed yet).
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Invoices</h2>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm opacity-70">No invoices yet. Generate a draft above.</p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/20 text-left opacity-70">
                <th className="py-2 pr-3">Month</th>
                <th className="py-2 pr-3">Kind</th>
                <th className="py-2 pr-3">Ver</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3 text-right">Total</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-white/10">
                  <td className="py-2 pr-3">{r.billingMonth.slice(0, 7)}</td>
                  <td className="py-2 pr-3">{KIND_LABEL.get(r.kind) ?? r.kind}</td>
                  <td className="py-2 pr-3">
                    v{r.version}
                    {r.supersedesId ? <span className="ml-1 opacity-50">(supersede)</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(r.totalCents)}</td>
                  <td className="py-2 text-right">
                    <Link
                      href={`/dashboard/${siteCode}/invoices/${r.id}`}
                      className="text-dr3-chartreuse underline"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
