'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface RequestRow {
  id: string;
  target_entry_date: Date | string;
  change_type: 'update' | 'insert';
  old_value: { mattress_count: number; note: string | null } | null;
  new_value: { mattress_count: number; note: string | null };
  justification: string;
  bill_pinged_at: Date | string | null;
  bonus_pay_period: { period_number: number; period_year: number };
  bonus_employee: { full_name: string; employee_number: string | null };
  requested_by: { name: string };
  expected_approver: { name: string };
  site: { code: string; name: string };
}

interface Props {
  requests: RequestRow[];
}

export function AmendmentQueue({ requests }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (requests.length === 0) {
    return (
      <p className="mt-8 rounded-md border border-dr3-cyan/20 bg-dr3-space-2/60 px-6 py-8 text-center text-sm text-dr3-mist-dim">
        No pending amendment requests.
      </p>
    );
  }

  const act = async (id: string, action: 'approve' | 'reject', decisionNotes?: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/bonus/amendments/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({ decisionNotes }) : '{}',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? `failed (${res.status})`);
        setBusyId(null);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-4">
      {error ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {requests.map((r) => {
        const date =
          typeof r.target_entry_date === 'string'
            ? r.target_entry_date.slice(0, 10)
            : new Date(r.target_entry_date).toISOString().slice(0, 10);
        const oldCount = r.old_value?.mattress_count ?? null;
        const newCount = r.new_value.mattress_count;
        return (
          <div key={r.id} className="rounded-lg border border-dr3-cyan/20 bg-dr3-space-2/60 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">
                  {r.bonus_employee.full_name}
                  {r.bonus_employee.employee_number
                    ? ` (#${r.bonus_employee.employee_number})`
                    : ''}{' '}
                  — {date}
                </p>
                <p className="text-xs text-dr3-mist-dim">
                  {r.site.name} · Pay Period {r.bonus_pay_period.period_number}/
                  {r.bonus_pay_period.period_year} · requested by {r.requested_by.name}
                  {r.bill_pinged_at ? ' · ⚡ pinged Bill' : ''}
                </p>
              </div>
              <p className="font-mono text-sm">
                {r.change_type === 'insert' ? 'NEW: ' : ''}
                {oldCount !== null ? `${oldCount} → ` : ''}
                {newCount}
              </p>
            </div>
            <p className="mt-3 rounded-md border border-dr3-steel-light/20 bg-dr3-space/60 px-3 py-2 text-sm">
              <span className="text-dr3-mist-dim">Justification: </span>
              {r.justification}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busyId === r.id}
                onClick={() => {
                  if (confirm(`Approve this change for ${r.bonus_employee.full_name}?`)) {
                    void act(r.id, 'approve');
                  }
                }}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-dr3-space hover:bg-emerald-400 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busyId === r.id}
                onClick={() => {
                  const notes = prompt('Reason for rejection:');
                  if (notes && notes.trim().length > 0) {
                    void act(r.id, 'reject', notes.trim());
                  }
                }}
                className="rounded-md bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-400 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
