'use client';

// ADR-0041 D4 — invoice detail + approval surface. CLAUDE.md hard rule #10: no
// <form>; every handler is onClick. Renders every line with drill-down to its
// source rows (the D1 `source` jsonb → records), the window's trust-gate
// findings inline, a prior-version diff, and the approve/void/supersede actions
// (all confirmed). English-first (office surface).

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { money } from '../InvoicesClient';

type Json = unknown;

interface LineView {
  id: string;
  lineCode: string;
  description: string;
  quantity: string | null;
  rateRef: Json;
  amountCents: number;
  source: Json;
  position: number;
}

interface InvoiceView {
  id: string;
  siteId: string;
  kind: string;
  billingMonth: string;
  windowStart: string;
  windowEnd: string;
  version: number;
  supersedesId: string | null;
  status: 'draft' | 'approved' | 'void';
  totalCents: number;
  approvedBy: string | null;
  approvedAt: string | null;
  gateOverrideNote: string | null;
  lines: LineView[];
}

interface GateFinding {
  id: string;
  checkCode: string;
  severity: string;
}
interface GateResult {
  blocked: boolean;
  overridden: boolean;
  blockingFindings: GateFinding[];
  findingCodes: string[];
}
interface Detail {
  invoice: InvoiceView;
  gate: GateResult;
  priorVersion: InvoiceView | null;
}

const btnPrimary =
  'rounded bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';
const btnDanger =
  'rounded border border-red-400/60 px-4 py-2 text-sm font-semibold text-red-200 disabled:opacity-40';
const btnGhost =
  'rounded border border-white/25 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40';

function iso(d: string): string {
  return d.slice(0, 10);
}

/** Extract drill-down record refs from a line's `source` jsonb for linking. */
function sourceRefs(source: Json): { loadIds: string[]; rentalIds: string[] } {
  const s = source as { loads?: { load_id?: string }[]; rentals?: { id?: string }[] } | null;
  return {
    loadIds: (s?.loads ?? []).map((l) => l.load_id).filter((x): x is string => !!x),
    rentalIds: (s?.rentals ?? []).map((r) => r.id).filter((x): x is string => !!x),
  };
}

export function InvoiceDetailClient({
  siteCode,
  invoiceId,
}: {
  siteCode: string;
  invoiceId: string;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [override, setOverride] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/manager/${siteCode}/invoices/${invoiceId}`);
    if (!res.ok) {
      setDetail(null);
      return;
    }
    setDetail((await res.json()) as Detail);
  }, [siteCode, invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (
      action: 'approve' | 'void' | 'supersede',
      body: Record<string, unknown>,
      confirmText: string,
    ) => {
      if (!window.confirm(confirmText)) return;
      setBusy(true);
      setMsg(null);
      try {
        const res = await fetch(`/api/manager/${siteCode}/invoices/${invoiceId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as {
          error?: string;
          findingCodes?: string[];
          invoice?: InvoiceView;
        };
        if (!res.ok) {
          const codes = data.findingCodes ? ` [${data.findingCodes.join(', ')}]` : '';
          setMsg({ kind: 'err', text: `${data.error ?? action + ' failed'}${codes}` });
        } else {
          setMsg({ kind: 'ok', text: `${action} succeeded.` });
          // supersede creates a NEW draft; navigate there. Others refresh in place.
          if (action === 'supersede' && data.invoice) {
            window.location.href = `/dashboard/${siteCode}/invoices/${data.invoice.id}`;
            return;
          }
          await load();
        }
      } finally {
        setBusy(false);
      }
    },
    [siteCode, invoiceId, load],
  );

  if (!detail) return <p className="mt-6 opacity-70">Loading…</p>;
  const { invoice, gate, priorVersion } = detail;
  const priorByCode = new Map((priorVersion?.lines ?? []).map((l) => [l.lineCode, l.amountCents]));

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">
          {invoice.kind} — {iso(invoice.billingMonth).slice(0, 7)}
        </h1>
        <span className="text-sm opacity-70">
          v{invoice.version} · {invoice.status}
        </span>
      </div>
      <p className="mt-1 text-sm opacity-70">
        Window {iso(invoice.windowStart)} .. {iso(invoice.windowEnd)}
      </p>

      {/* Inline trust-gate findings (D4) */}
      <section className="mt-5 rounded-lg border border-white/15 bg-black/20 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-80">
          Window trust gate
        </h2>
        {gate.blocked ? (
          <p className="mt-2 text-sm text-red-300">
            Blocked — {gate.blockingFindings.length} open finding(s) on{' '}
            {gate.findingCodes.join(', ')}. Resolve them (or a super-admin may override at
            approval).
          </p>
        ) : gate.overridden ? (
          <p className="mt-2 text-sm text-amber-300">
            Overridden by a super-admin justification (findings:{' '}
            {gate.findingCodes.join(', ') || 'none'}).
          </p>
        ) : (
          <p className="mt-2 text-sm text-dr3-chartreuse">
            Clean — no blocking findings for this window.
          </p>
        )}
      </section>

      {/* Lines with drill-down */}
      <section className="mt-6">
        <h2 className="text-lg font-semibold">Lines</h2>
        <table className="mt-2 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/20 text-left opacity-70">
              <th className="py-2 pr-3">Code</th>
              <th className="py-2 pr-3">Description</th>
              <th className="py-2 pr-3 text-right">Qty</th>
              <th className="py-2 pr-3 text-right">Amount</th>
              {priorVersion && (
                <th className="py-2 pr-3 text-right">Δ vs v{priorVersion.version}</th>
              )}
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => {
              const prior = priorByCode.get(l.lineCode);
              const delta = prior == null ? null : l.amountCents - prior;
              const refs = sourceRefs(l.source);
              const isOpen = expanded.has(l.id);
              return (
                <Fragment key={l.id}>
                  <tr className="border-b border-white/10">
                    <td className="py-2 pr-3 font-mono text-xs">{l.lineCode}</td>
                    <td className="py-2 pr-3">{l.description}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{l.quantity ?? ''}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(l.amountCents)}</td>
                    {priorVersion && (
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {delta == null ? (
                          <span className="opacity-40">new</span>
                        ) : delta === 0 ? (
                          '—'
                        ) : (
                          money(delta)
                        )}
                      </td>
                    )}
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        className="text-xs text-dr3-chartreuse underline"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(l.id)) next.delete(l.id);
                            else next.add(l.id);
                            return next;
                          })
                        }
                      >
                        {isOpen ? 'Hide source' : 'Source'}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-white/10 bg-black/25">
                      <td colSpan={priorVersion ? 6 : 5} className="px-3 py-3">
                        <div className="flex flex-wrap gap-3 text-xs">
                          {refs.loadIds.map((lid) => (
                            <Link
                              key={lid}
                              href={`/dashboard/${siteCode}/load/${lid}`}
                              className="text-dr3-chartreuse underline"
                            >
                              load {lid.slice(0, 8)}
                            </Link>
                          ))}
                          {refs.loadIds.length === 0 && refs.rentalIds.length === 0 && (
                            <span className="opacity-60">Provenance:</span>
                          )}
                        </div>
                        <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/40 p-2 text-[11px] leading-snug text-white/80">
                          {JSON.stringify({ rate_ref: l.rateRef, source: l.source }, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            <tr className="border-t-2 border-white/30 font-semibold">
              <td className="py-2 pr-3" />
              {/* rollup §1.3 — same GP framing as the xlsx render when the
                  invoice stores a mid-month offset line (keyed on the line,
                  not the kind, so all surfaces agree). */}
              <td className="py-2 pr-3">
                {invoice.lines.some((l) => l.lineCode === 'B22.offset')
                  ? 'Balance due (gross less Trade discount)'
                  : 'Invoice total'}
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3 text-right tabular-nums">{money(invoice.totalCents)}</td>
              {priorVersion && (
                <td className="py-2 pr-3 text-right tabular-nums">
                  {invoice.totalCents - priorVersion.totalCents === 0
                    ? '—'
                    : money(invoice.totalCents - priorVersion.totalCents)}
                </td>
              )}
              <td className="py-2" />
            </tr>
          </tbody>
        </table>
      </section>

      {/* Actions */}
      <section className="mt-8 rounded-lg border border-white/15 bg-black/20 p-4">
        {msg && (
          <p
            className={`mb-3 text-sm ${msg.kind === 'ok' ? 'text-dr3-chartreuse' : 'text-red-300'}`}
          >
            {msg.text}
          </p>
        )}
        {invoice.status === 'draft' && (
          <div className="flex flex-col gap-3">
            {gate.blocked && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-80">
                  Super-admin override justification (required to approve past a blocked gate)
                </span>
                <input
                  className="rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white"
                  value={override}
                  onChange={(e) => setOverride(e.target.value)}
                  placeholder="e.g. vendor invoice confirmed offline; finding acknowledged"
                />
              </label>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={btnPrimary}
                disabled={busy}
                onClick={() =>
                  void act(
                    'approve',
                    gate.blocked ? { overrideJustification: override } : {},
                    'Approve this invoice? Approved invoices are immutable — corrections require a new superseding version.',
                  )
                }
              >
                Approve
              </button>
              <button
                type="button"
                className={btnDanger}
                disabled={busy}
                onClick={() => void act('void', {}, 'Void this draft? This discards it.')}
              >
                Void draft
              </button>
            </div>
          </div>
        )}
        {invoice.status === 'approved' && (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={btnGhost}
              disabled={busy}
              onClick={() =>
                void act(
                  'supersede',
                  {},
                  'Create a new draft version that supersedes this approved invoice? Both are retained.',
                )
              }
            >
              Supersede (new version)
            </button>
            <button
              type="button"
              className={btnDanger}
              disabled={busy}
              onClick={() => void act('void', {}, 'Void this APPROVED invoice? This cancels it.')}
            >
              Void
            </button>
            <a
              className={btnGhost}
              href={`/api/manager/${siteCode}/invoices/${invoiceId}/export?format=xlsx`}
            >
              Download xlsx
            </a>
          </div>
        )}
        {invoice.gateOverrideNote && (
          <p className="mt-3 text-xs text-amber-300">
            Gate override on record: {invoice.gateOverrideNote}
          </p>
        )}
      </section>
    </div>
  );
}
