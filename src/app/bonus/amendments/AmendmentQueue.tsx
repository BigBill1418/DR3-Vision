'use client';

// ADR-0028 / ADR-0029 — Pending-amendments review queue.
//
// ADR-0029: requests submitted together share a `submission_group_id`. The
// queue groups them so a multi-line correction is approved/rejected as ONE
// action ("Approve all" / "Reject all") and produces ONE result notification.
// Singletons (null group id) render and act exactly as before.
//
// CLAUDE.md hard rule #3 — DR3 brand is GREEN + BLACK. Approve is brand-green;
// reject is a neutral outline (NOT red — the prior red buttons + a red error
// banner violated the brand). Hard rule #10 — onClick only, no <form>.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { amendmentErrorMessage } from '@/lib/bonus/amendment-error-messages';

export interface RequestRow {
  id: string;
  target_entry_date: Date | string;
  change_type: 'update' | 'insert';
  old_value: { mattress_count: number; note: string | null } | null;
  new_value: { mattress_count: number; note: string | null };
  justification: string;
  bill_pinged_at: Date | string | null;
  submission_group_id: string | null;
  bonus_pay_period: { period_number: number; period_year: number };
  bonus_employee: { full_name: string; employee_number: string | null };
  requested_by: { name: string };
  expected_approver: { name: string };
  site: { code: string; name: string };
}

interface Props {
  requests: RequestRow[];
}

interface Group {
  /** Stable key: the group id, or the lone request id for a singleton. */
  key: string;
  /** The id POSTed to approve/reject — any member works (the route expands the group). */
  actionId: string;
  isBatch: boolean;
  rows: RequestRow[];
}

function dateOf(r: RequestRow): string {
  return typeof r.target_entry_date === 'string'
    ? r.target_entry_date.slice(0, 10)
    : new Date(r.target_entry_date).toISOString().slice(0, 10);
}

export function AmendmentQueue({ requests }: Props) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline reject reason per group (replaces window.prompt).
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Group rows by submission_group_id (preserving order); singletons stand alone.
  const groups = useMemo<Group[]>(() => {
    const byGroup = new Map<string, RequestRow[]>();
    const order: string[] = [];
    for (const r of requests) {
      const k = r.submission_group_id ?? `single:${r.id}`;
      if (!byGroup.has(k)) {
        byGroup.set(k, []);
        order.push(k);
      }
      byGroup.get(k)!.push(r);
    }
    return order.map((k) => {
      const rows = byGroup.get(k)!;
      return {
        key: k,
        actionId: rows[0]!.id,
        isBatch: rows[0]!.submission_group_id !== null && rows.length > 1,
        rows,
      };
    });
  }, [requests]);

  if (requests.length === 0) {
    return (
      <p className="mt-8 rounded-md border border-dr3-cyan/20 bg-dr3-space-2/60 px-6 py-8 text-center text-sm text-dr3-mist-dim">
        No pending amendment requests.
      </p>
    );
  }

  const act = async (g: Group, action: 'approve' | 'reject', decisionNotes?: string) => {
    setBusyKey(g.key);
    setError(null);
    try {
      const res = await fetch(`/api/bonus/amendments/${g.actionId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({ decisionNotes }) : '{}',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          amendmentErrorMessage(body?.error, `Could not complete this action (${res.status}).`),
        );
        setBusyKey(null);
        return;
      }
      setRejectFor(null);
      setRejectReason('');
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-4">
      {error ? (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {groups.map((g) => {
        const head = g.rows[0]!;
        const date = dateOf(head);
        const busy = busyKey === g.key;
        const approveLabel = g.isBatch ? `Approve all (${g.rows.length})` : 'Approve';
        const rejectLabel = g.isBatch ? `Reject all (${g.rows.length})` : 'Reject';
        return (
          <div
            key={g.key}
            className="rounded-lg border border-dr3-cyan/20 bg-dr3-space-2/60 p-5"
            data-testid={`amendment-group-${g.key}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">
                  {g.isBatch
                    ? `${g.rows.length} prior-day corrections — ${date}`
                    : `${head.bonus_employee.full_name}${
                        head.bonus_employee.employee_number
                          ? ` (#${head.bonus_employee.employee_number})`
                          : ''
                      } — ${date}`}
                </p>
                <p className="text-xs text-dr3-mist-dim">
                  {head.site.name} · Pay Period {head.bonus_pay_period.period_number}/
                  {head.bonus_pay_period.period_year} · requested by {head.requested_by.name}
                  {head.bill_pinged_at ? ' · pinged Bill' : ''}
                </p>
              </div>
            </div>

            <ul className="mt-3 flex flex-col gap-1 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 px-3 py-2 text-sm">
              {g.rows.map((r) => {
                const oldCount = r.old_value?.mattress_count ?? null;
                return (
                  <li key={r.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-dr3-mist">
                      {r.bonus_employee.full_name}
                      {r.bonus_employee.employee_number
                        ? ` (#${r.bonus_employee.employee_number})`
                        : ''}
                    </span>
                    <span className="font-mono text-dr3-mist-dim">
                      {r.change_type === 'insert' ? 'NEW: ' : ''}
                      {oldCount !== null ? `${oldCount} → ` : ''}
                      {r.new_value.mattress_count}
                    </span>
                  </li>
                );
              })}
            </ul>

            <p className="mt-3 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 px-3 py-2 text-sm">
              <span className="text-dr3-mist-dim">Justification: </span>
              {head.justification}
            </p>

            {rejectFor === g.key ? (
              <div className="mt-4 flex flex-col gap-2" data-testid={`reject-form-${g.key}`}>
                <label htmlFor={`reject-reason-${g.key}`} className="text-sm font-medium">
                  Reason for {g.isBatch ? 'rejecting all' : 'rejection'} (required)
                </label>
                <textarea
                  id={`reject-reason-${g.key}`}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
                  placeholder="e.g. Counts are correct as originally keyed."
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy || rejectReason.trim().length === 0}
                    onClick={() => void act(g, 'reject', rejectReason.trim())}
                    className="rounded-md border border-dr3-cyan/40 px-4 py-2 text-sm font-semibold text-dr3-mist hover:bg-dr3-space-2/80 disabled:opacity-50"
                    data-testid={`reject-confirm-${g.key}`}
                  >
                    Confirm {rejectLabel.toLowerCase()}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRejectFor(null);
                      setRejectReason('');
                    }}
                    className="rounded-md border border-dr3-steel-light/30 px-4 py-2 text-sm text-dr3-mist-dim hover:bg-dr3-space-2/80"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(g, 'approve')}
                  className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-dr3-cyan-bright disabled:opacity-50"
                  data-testid={`approve-${g.key}`}
                >
                  {busy ? 'Working…' : approveLabel}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRejectFor(g.key);
                    setRejectReason('');
                    setError(null);
                  }}
                  className="rounded-md border border-dr3-steel-light/30 px-4 py-2 text-sm font-semibold text-dr3-mist hover:bg-dr3-space-2/80 disabled:opacity-50"
                  data-testid={`reject-${g.key}`}
                >
                  {rejectLabel}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
