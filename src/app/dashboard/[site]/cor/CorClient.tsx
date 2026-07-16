'use client';

// ADR-0042 D4 — COR review + finalize surface. Hard rule #10: no <form>; every
// handler is onClick. Month picker, the three pre-filled numbers with drill-down
// (inventory → running balance + snapshot ref; headcount → the month's daily-close
// series), the FT/PT entry, a display-only capacity banner, a diff vs the prior
// version, and a finalize confirmation ("reviewed under penalty of perjury — a
// human signs the printed copy"). English-first (office surface).

import { useCallback, useEffect, useState } from 'react';

interface CorListItem {
  id: string;
  coverMonth: string;
  version: number;
  status: 'draft' | 'finalized' | 'void';
  inventoryUnits: number;
  ftHeadcount: number | null;
  ptHeadcount: number | null;
  supersedesId: string | null;
  finalizedAt: string | null;
}

interface HeadcountSeriesEntry {
  id: string;
  productionDate: string;
  employeesCount: number | null;
  processorsCount: number | null;
}
interface HeadcountSource {
  monthEndCloseId: string | null;
  monthEndDate: string | null;
  employeesCount: number | null;
  processorsCount: number | null;
  consultedCloseRowIds: string[];
  series: HeadcountSeriesEntry[];
}
interface InventorySource {
  asOf?: string;
  anchorSnapshotId?: string | null;
  anchorAt?: string | null;
  anchorPhysicalUnits?: number | null;
  anchorReconciledDelta?: number | null;
  computedProgram?: string;
  computedNonProgram?: string;
  computedTotal?: string;
}

interface CorView {
  id: string;
  coverMonth: string;
  version: number;
  supersedesId: string | null;
  status: 'draft' | 'finalized' | 'void';
  inventoryUnits: number;
  inventorySource: InventorySource;
  ftHeadcount: number | null;
  ptHeadcount: number | null;
  headcountSource: HeadcountSource;
  signerName: string;
  signerTitle: string;
  pdfStorageKey: string | null;
}
interface Reconcile {
  pass: boolean;
  storedUnits: number;
  recomputedUnits: number;
}
interface Detail {
  cert: CorView;
  priorVersion: CorView | null;
  reconcile: Reconcile;
}

const btnPrimary =
  'rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';
const btnGhost =
  'rounded border border-white/25 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40';
const btnDanger =
  'rounded border border-red-400/60 px-4 py-2 text-sm font-semibold text-red-200 disabled:opacity-40';

function monthLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function CorClient({
  siteCode,
  capacityLimit,
  capacityWarn,
}: {
  siteCode: string;
  capacityLimit: number | null;
  capacityWarn: number | null;
}) {
  const [rows, setRows] = useState<CorListItem[]>([]);
  const [month, setMonth] = useState<string>(currentMonthValue());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [ft, setFt] = useState<string>('');
  const [pt, setPt] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [showInvSource, setShowInvSource] = useState(false);
  const [showSeries, setShowSeries] = useState(false);

  const loadList = useCallback(async () => {
    const res = await fetch(`/api/manager/${siteCode}/cor`);
    if (res.ok) setRows(((await res.json()) as { rows: CorListItem[] }).rows);
  }, [siteCode]);

  const loadDetail = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/manager/${siteCode}/cor/${id}`);
      if (!res.ok) {
        setDetail(null);
        return;
      }
      const d = (await res.json()) as Detail;
      setDetail(d);
      setFt(d.cert.ftHeadcount != null ? String(d.cert.ftHeadcount) : '');
      setPt(d.cert.ptHeadcount != null ? String(d.cert.ptHeadcount) : '');
    },
    [siteCode],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const generate = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/cor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverMonth: month }),
      });
      const data = (await res.json()) as { error?: string; cert?: CorView };
      if (!res.ok) {
        setMsg({ kind: 'err', text: data.error ?? 'generate failed' });
      } else if (data.cert) {
        setMsg({
          kind: 'ok',
          text: `Draft v${data.cert.version} generated for ${monthLabel(data.cert.coverMonth)}.`,
        });
        await loadList();
        setSelectedId(data.cert.id);
      }
    } finally {
      setBusy(false);
    }
  }, [siteCode, month, loadList]);

  const act = useCallback(
    async (
      path: string,
      body: Record<string, unknown>,
      confirmText: string | null,
      okText: string,
    ) => {
      if (confirmText && !window.confirm(confirmText)) return;
      setBusy(true);
      setMsg(null);
      try {
        const res = await fetch(`/api/manager/${siteCode}/cor/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as {
          error?: string;
          storedUnits?: number;
          recomputedUnits?: number;
          cert?: CorView;
        };
        if (!res.ok) {
          const recon =
            typeof data.storedUnits === 'number'
              ? ` (stored ${data.storedUnits} vs recomputed ${data.recomputedUnits})`
              : '';
          setMsg({ kind: 'err', text: `${data.error ?? 'failed'}${recon}` });
        } else {
          setMsg({ kind: 'ok', text: okText });
          await loadList();
          // supersede returns a NEW draft — jump to it; others refresh in place.
          if (data.cert && data.cert.id !== selectedId && path.endsWith('/supersede')) {
            setSelectedId(data.cert.id);
          } else if (selectedId) {
            await loadDetail(selectedId);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [siteCode, selectedId, loadList, loadDetail],
  );

  const downloadPdf = useCallback(
    async (id: string) => {
      setBusy(true);
      setMsg(null);
      try {
        // Ensure a fresh artifact exists (also runs the reconcile tripwire).
        const gen = await fetch(`/api/manager/${siteCode}/cor/${id}/pdf`, { method: 'POST' });
        if (!gen.ok) {
          const d = (await gen.json()) as {
            error?: string;
            storedUnits?: number;
            recomputedUnits?: number;
          };
          const recon =
            typeof d.storedUnits === 'number'
              ? ` (stored ${d.storedUnits} vs recomputed ${d.recomputedUnits})`
              : '';
          setMsg({ kind: 'err', text: `PDF refused: ${d.error ?? 'failed'}${recon}` });
          return;
        }
        const dl = await fetch(`/api/manager/${siteCode}/cor/${id}/pdf`);
        const data = (await dl.json()) as { url?: string; error?: string };
        if (dl.ok && data.url) window.open(data.url, '_blank', 'noopener');
        else setMsg({ kind: 'err', text: data.error ?? 'download failed' });
      } finally {
        setBusy(false);
      }
    },
    [siteCode],
  );

  const cert = detail?.cert ?? null;
  const inv = cert?.inventorySource ?? {};
  const hc = cert?.headcountSource ?? null;

  // Capacity banner state (display-only).
  const capacityState =
    cert && capacityLimit != null
      ? cert.inventoryUnits >= capacityLimit
        ? 'over'
        : capacityWarn != null && cert.inventoryUnits >= capacityWarn
          ? 'warn'
          : 'ok'
      : 'na';

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
      {/* Left: month picker + generate + list */}
      <aside className="flex flex-col gap-4">
        <div className="rounded-lg border border-white/15 bg-black/20 p-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="opacity-80">Cover month</span>
            <input
              type="month"
              className="rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={`${btnPrimary} mt-3 w-full`}
            disabled={busy}
            onClick={() => void generate()}
          >
            Generate / regenerate draft
          </button>
        </div>

        <div className="rounded-lg border border-white/15 bg-black/20 p-2">
          <h2 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide opacity-70">
            Certificates
          </h2>
          <ul className="mt-1 flex flex-col">
            {rows.length === 0 && <li className="px-2 py-3 text-sm opacity-60">None yet.</li>}
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-white/10 ${
                    r.id === selectedId ? 'bg-white/10' : ''
                  }`}
                >
                  <span>
                    {monthLabel(r.coverMonth)} <span className="opacity-60">v{r.version}</span>
                  </span>
                  <span
                    className={`text-xs ${
                      r.status === 'finalized'
                        ? 'text-dr3-cyan'
                        : r.status === 'void'
                          ? 'text-red-300/70'
                          : 'opacity-70'
                    }`}
                  >
                    {r.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Right: detail / review */}
      <section>
        {msg && (
          <p className={`mb-4 text-sm ${msg.kind === 'ok' ? 'text-dr3-cyan' : 'text-red-300'}`}>
            {msg.text}
          </p>
        )}
        {!cert ? (
          <p className="opacity-70">Select a certificate, or generate a draft for a month.</p>
        ) : (
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-2xl font-bold">
                {monthLabel(cert.coverMonth)}{' '}
                <span className="text-base opacity-70">v{cert.version}</span>
              </h2>
              <span className="text-sm opacity-70">{cert.status}</span>
            </div>

            {/* Reconcile drift banner */}
            {!detail!.reconcile.pass && (
              <p className="mt-3 rounded border border-red-400/50 bg-red-500/10 p-2 text-sm text-red-200">
                Inventory drift: stored {detail!.reconcile.storedUnits} units, ledger now shows{' '}
                {detail!.reconcile.recomputedUnits}. Regenerate the draft before finalizing.
              </p>
            )}

            {/* Capacity banner (display-only) */}
            {capacityLimit != null && (
              <p
                className={`mt-3 rounded p-2 text-sm ${
                  capacityState === 'over'
                    ? 'border border-red-400/50 bg-red-500/10 text-red-200'
                    : capacityState === 'warn'
                      ? 'border border-amber-400/50 bg-amber-500/10 text-amber-200'
                      : 'border border-white/15 bg-black/20 opacity-80'
                }`}
              >
                Storage capacity: {cert.inventoryUnits.toLocaleString()} /{' '}
                {capacityLimit.toLocaleString()} indoor units
                {capacityWarn != null && ` (warn at ${capacityWarn.toLocaleString()})`}.
                Display-only context.
              </p>
            )}

            {/* Three numbers */}
            <section className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-white/15 bg-black/20 p-4">
                <div className="text-xs uppercase tracking-wide opacity-70">Inventory at close</div>
                <div className="mt-1 text-2xl font-bold text-dr3-cyan">
                  {cert.inventoryUnits.toLocaleString()}
                </div>
                <button
                  type="button"
                  className="mt-2 text-xs text-dr3-cyan underline"
                  onClick={() => setShowInvSource((v) => !v)}
                >
                  {showInvSource ? 'Hide balance detail' : 'Balance ledger + snapshot'}
                </button>
              </div>
              <div className="rounded-lg border border-white/15 bg-black/20 p-4">
                <div className="text-xs uppercase tracking-wide opacity-70">FT / PT split</div>
                <div className="mt-1 text-2xl font-bold">
                  {cert.ftHeadcount ?? '—'} / {cert.ptHeadcount ?? '—'}
                </div>
                <button
                  type="button"
                  className="mt-2 text-xs text-dr3-cyan underline"
                  onClick={() => setShowSeries((v) => !v)}
                >
                  {showSeries ? 'Hide daily-close series' : 'Daily-close series'}
                </button>
              </div>
              <div className="rounded-lg border border-white/15 bg-black/20 p-4">
                <div className="text-xs uppercase tracking-wide opacity-70">Signer</div>
                <div className="mt-1 text-base font-semibold">{cert.signerName}</div>
                <div className="text-xs opacity-70">{cert.signerTitle}</div>
              </div>
            </section>

            {showInvSource && (
              <div className="mt-3 rounded-lg border border-white/10 bg-black/25 p-3 text-xs">
                <p className="opacity-80">
                  Running balance as of {inv.asOf ? inv.asOf.slice(0, 10) : '—'} · program{' '}
                  {inv.computedProgram ?? '—'} · non-program {inv.computedNonProgram ?? '—'} · total{' '}
                  {inv.computedTotal ?? '—'}.
                </p>
                <p className="mt-1 opacity-80">
                  Anchor snapshot {inv.anchorSnapshotId ? inv.anchorSnapshotId.slice(0, 8) : 'none'}{' '}
                  · physical {inv.anchorPhysicalUnits ?? '—'} · reconcile delta{' '}
                  {inv.anchorReconciledDelta ?? '—'}.
                </p>
              </div>
            )}

            {showSeries && hc && (
              <div className="mt-3 rounded-lg border border-white/10 bg-black/25 p-3 text-xs">
                <p className="opacity-80">
                  Pre-fill from month-end close {hc.monthEndDate ?? '—'}: employees{' '}
                  {hc.employeesCount ?? '—'}, processors {hc.processorsCount ?? '—'}. The FT/PT
                  split is your judgment — the daily close captures totals only.
                </p>
                <table className="mt-2 w-full text-left">
                  <thead className="opacity-60">
                    <tr>
                      <th className="py-1 pr-3">Date</th>
                      <th className="py-1 pr-3 text-right">Employees</th>
                      <th className="py-1 text-right">Processors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hc.series.map((s) => (
                      <tr key={s.id} className="border-t border-white/10">
                        <td className="py-1 pr-3">{s.productionDate}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {s.employeesCount ?? '—'}
                        </td>
                        <td className="py-1 text-right tabular-nums">{s.processorsCount ?? '—'}</td>
                      </tr>
                    ))}
                    {hc.series.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-2 opacity-60">
                          No daily-close rows for this month.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Version diff */}
            {detail!.priorVersion && (
              <section className="mt-5 rounded-lg border border-white/15 bg-black/20 p-4 text-sm">
                <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Diff vs v{detail!.priorVersion.version}
                </h3>
                <ul className="mt-2 space-y-1">
                  <li>
                    Inventory: {detail!.priorVersion.inventoryUnits.toLocaleString()} →{' '}
                    {cert.inventoryUnits.toLocaleString()}{' '}
                    {cert.inventoryUnits !== detail!.priorVersion.inventoryUnits && (
                      <span className="text-dr3-cyan">
                        ({cert.inventoryUnits - detail!.priorVersion.inventoryUnits > 0 ? '+' : ''}
                        {(
                          cert.inventoryUnits - detail!.priorVersion.inventoryUnits
                        ).toLocaleString()}
                        )
                      </span>
                    )}
                  </li>
                  <li>
                    FT/PT: {detail!.priorVersion.ftHeadcount ?? '—'}/
                    {detail!.priorVersion.ptHeadcount ?? '—'} → {cert.ftHeadcount ?? '—'}/
                    {cert.ptHeadcount ?? '—'}
                  </li>
                </ul>
              </section>
            )}

            {/* FT/PT entry + actions (draft only) */}
            {cert.status === 'draft' && (
              <section className="mt-6 rounded-lg border border-white/15 bg-black/20 p-4">
                <h3 className="text-sm font-semibold">
                  Enter the FT/PT split (required to finalize)
                </h3>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="opacity-80">Full-time</span>
                    <input
                      type="number"
                      min={0}
                      className="w-28 rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white"
                      value={ft}
                      onChange={(e) => setFt(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="opacity-80">Part-time</span>
                    <input
                      type="number"
                      min={0}
                      className="w-28 rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white"
                      value={pt}
                      onChange={(e) => setPt(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy || ft === '' || pt === ''}
                    onClick={() =>
                      void act(
                        `${cert.id}/headcount`,
                        { ftHeadcount: Number(ft), ptHeadcount: Number(pt) },
                        null,
                        'FT/PT split saved.',
                      )
                    }
                  >
                    Save split
                  </button>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className={btnPrimary}
                    disabled={busy || cert.ftHeadcount == null || cert.ptHeadcount == null}
                    onClick={() =>
                      void act(
                        `${cert.id}/finalize`,
                        {},
                        'Finalize this certificate?\n\nBy finalizing you confirm the reported numbers are reviewed under penalty of perjury. Vision renders the certificate with an EMPTY signature block — a human signs the printed copy. Finalized certificates are immutable; corrections require a new superseding version.',
                        'Finalized. Download the PDF, print, and sign by hand.',
                      )
                    }
                  >
                    Finalize
                  </button>
                  <button
                    type="button"
                    className={btnDanger}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `${cert.id}/void`,
                        {},
                        'Void this draft? This discards it.',
                        'Draft voided.',
                      )
                    }
                  >
                    Void draft
                  </button>
                </div>
                {(cert.ftHeadcount == null || cert.ptHeadcount == null) && (
                  <p className="mt-2 text-xs opacity-70">
                    Enter and save the FT/PT split before finalizing.
                  </p>
                )}
              </section>
            )}

            {/* Finalized actions */}
            {cert.status === 'finalized' && (
              <section className="mt-6 flex flex-wrap gap-3 rounded-lg border border-white/15 bg-black/20 p-4">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={busy}
                  onClick={() => void downloadPdf(cert.id)}
                >
                  Download PDF (print &amp; sign)
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy}
                  onClick={() =>
                    void act(
                      `${cert.id}/supersede`,
                      {},
                      'Create a new draft version that supersedes this finalized certificate? Both are retained.',
                      'New draft version created.',
                    )
                  }
                >
                  Supersede (new version)
                </button>
                <button
                  type="button"
                  className={btnDanger}
                  disabled={busy}
                  onClick={() =>
                    void act(
                      `${cert.id}/void`,
                      {},
                      'Void this FINALIZED certificate? This cancels it.',
                      'Certificate voided.',
                    )
                  }
                >
                  Void
                </button>
              </section>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
