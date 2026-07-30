'use client';

// ADR-0068 §4 — the Employee Reimbursement surface.
//
// One screen, two jobs: file a reimbursement, and see what is waiting on you or
// on someone else. The paper form is retired — this replaces it outright (D1).
//
// Per hard rule #10 there is NO HTML `<form>`: the submit control is an onClick
// handler, and Enter-to-submit is wired on the inputs' onKeyDown.
//
// WHAT THIS SCREEN DOES NOT CLAIM: it does not tell the submitter they can
// approve their own request, and it does not offer them the buttons — because
// they cannot. The refusal is enforced server-side and in the database; the UI
// merely declines to lie about it.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface RosterOption {
  id: string;
  name: string;
}

export interface ReimbursementRow {
  id: string;
  amountCents: number;
  expenseDate: string;
  category: string;
  purpose: string;
  status: 'pending_second_approval' | 'approved' | 'rejected' | 'held';
  beneficiary: string;
  submitterName: string;
  submittedAtPacific: string;
  routedToName: string;
  secondApproverName: string | null;
  decisionNote: string | null;
  escalated: boolean;
  /** Server-computed: may the VIEWER sign this one? Never trusted for the write. */
  viewerMayApprove: boolean;
  /** True when the viewer is the person who submitted it. */
  viewerSubmitted: boolean;
}

const CATEGORIES = ['mileage', 'fuel', 'supplies', 'meals', 'tools', 'other'] as const;

const STATUS_LABEL: Record<ReimbursementRow['status'], string> = {
  pending_second_approval: 'Waiting for a second signature',
  approved: 'Approved — sent to accounting',
  rejected: 'Not approved',
  held: 'On hold',
};

const STATUS_STYLE: Record<ReimbursementRow['status'], string> = {
  pending_second_approval: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  rejected: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  held: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
};

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function ReimbursementsClient({
  siteCode,
  roster,
  rows,
  todayPacific,
}: {
  siteCode: string;
  roster: RosterOption[];
  rows: ReimbursementRow[];
  todayPacific: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [useRosterPick, setUseRosterPick] = useState(true);
  const [employeeUserId, setEmployeeUserId] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [amount, setAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayPacific);
  const [category, setCategory] = useState<string>('supplies');
  const [purpose, setPurpose] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const waiting = useMemo(() => rows.filter((r) => r.status === 'pending_second_approval'), [rows]);
  const settled = useMemo(() => rows.filter((r) => r.status !== 'pending_second_approval'), [rows]);

  const submit = useCallback(async () => {
    if (pending) return;
    setError(null);
    setOk(null);

    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Attach a photo or file of the receipt — it is required.');
      return;
    }

    const fd = new FormData();
    if (useRosterPick) fd.set('employeeUserId', employeeUserId);
    else fd.set('employeeNameFreeform', employeeName);
    fd.set('amount', amount);
    fd.set('expenseDate', expenseDate);
    fd.set('category', category);
    fd.set('purpose', purpose);
    fd.set('receipt', file);

    setPending(true);
    try {
      const res = await fetch(`/api/dashboard/${siteCode}/reimbursements`, {
        method: 'POST',
        body: fd,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        message?: string;
        routedTo?: string | null;
        escalated?: boolean;
      };
      if (!res.ok || !json.ok) {
        setError(json.message ?? 'Could not submit that reimbursement.');
        return;
      }
      setOk(
        json.escalated
          ? `Submitted. Because the usual second approver cannot sign this one, it went straight to ${json.routedTo ?? 'an administrator'}.`
          : `Submitted, and sent to ${json.routedTo ?? 'the second approver'} for the second signature. You cannot approve your own submission.`,
      );
      setAmount('');
      setPurpose('');
      setEmployeeName('');
      setEmployeeUserId('');
      if (fileRef.current) fileRef.current.value = '';
      router.refresh();
    } catch {
      setError('Network problem — nothing was submitted. Try again.');
    } finally {
      setPending(false);
    }
  }, [
    pending,
    useRosterPick,
    employeeUserId,
    employeeName,
    amount,
    expenseDate,
    category,
    purpose,
    siteCode,
    router,
  ]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const decide = useCallback(
    async (id: string, decision: 'approved' | 'rejected' | 'held') => {
      let note: string | undefined;
      if (decision !== 'approved') {
        const entered = window.prompt(
          decision === 'rejected'
            ? 'Why is this reimbursement not approved? (required)'
            : 'Why is this on hold? (required)',
        );
        if (!entered || !entered.trim()) return;
        note = entered.trim();
      }
      const res = await fetch(`/api/dashboard/${siteCode}/reimbursements/${id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });
      const json = (await res.json()) as { ok?: boolean; message?: string };
      if (!res.ok || !json.ok) {
        window.alert(json.message ?? 'Could not record that decision.');
        return;
      }
      router.refresh();
    },
    [siteCode, router],
  );

  const inputCls =
    'w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim/60 focus:border-dr3-cyan focus:outline-none';
  const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-dr3-mist-dim';

  return (
    <div className="space-y-8">
      {/* ── File one ─────────────────────────────────────────────────────── */}
      <section className="rounded-lg bg-dr3-steel/20 p-5 ring-1 ring-dr3-steel-light/20">
        <h2 className="text-lg font-semibold text-dr3-mist">Reimburse an employee</h2>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          This replaces the paper form. Because you are signed in, your submission counts as the
          first signature — which is why a second person has to approve it, and why that person
          cannot be you.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <span className={labelCls}>Employee being reimbursed</span>
            <div className="mb-2 flex gap-4 text-sm text-dr3-mist-dim">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={useRosterPick}
                  onChange={() => setUseRosterPick(true)}
                />
                Pick from staff
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={!useRosterPick}
                  onChange={() => setUseRosterPick(false)}
                />
                Type a name
              </label>
            </div>
            {useRosterPick ? (
              <select
                className={inputCls}
                value={employeeUserId}
                onChange={(e) => setEmployeeUserId(e.target.value)}
                data-testid="reimbursement-employee-select"
              >
                <option value="">Choose someone…</option>
                {roster.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={inputCls}
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                onKeyDown={onKey}
                placeholder="Full name — first and last"
                data-testid="reimbursement-employee-name"
              />
            )}
            {!useRosterPick && (
              <p className="mt-1 text-xs text-dr3-mist-dim">
                Use the full name. A first name on its own can’t be matched reliably, so the request
                gets sent to an administrator instead of a peer.
              </p>
            )}
          </div>

          <div>
            <label className={labelCls} htmlFor="reimb-amount">
              Amount
            </label>
            <input
              id="reimb-amount"
              className={inputCls}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={onKey}
              placeholder="40.00"
              inputMode="decimal"
              data-testid="reimbursement-amount"
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="reimb-date">
              Date of expense
            </label>
            <input
              id="reimb-date"
              type="date"
              className={inputCls}
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="reimb-category">
              Category
            </label>
            <select
              id="reimb-category"
              className={inputCls}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls} htmlFor="reimb-receipt">
              Receipt (required)
            </label>
            <input
              id="reimb-receipt"
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              className="w-full text-sm text-dr3-mist-dim"
              data-testid="reimbursement-receipt"
            />
          </div>

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="reimb-purpose">
              What it was for
            </label>
            <input
              id="reimb-purpose"
              className={inputCls}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              onKeyDown={onKey}
              placeholder="Business purpose — e.g. fuel for the Woodland box truck"
              data-testid="reimbursement-purpose"
            />
            {/* ADR-0068 Amendment 3 — reimbursements now appear in the shared AP
                queue, which is deliberately NOT site-scoped. Bill's basis for
                allowing that is a POLICY about content: reimbursements are work
                materials, tools and equipment only. A policy nobody is told about
                stops being true, so the submitter is told the audience here. */}
            <p className="mt-1 text-xs text-dr3-mist-dim">
              Work materials, tools and equipment only. This is visible to approvers at both sites
              in the AP queue — don’t put anything personal or medical here.
            </p>
          </div>
        </div>

        {error && (
          <p
            className="mt-4 rounded-md bg-rose-500/15 px-3 py-2 text-sm text-rose-200 ring-1 ring-rose-500/30"
            data-testid="reimbursement-error"
          >
            {error}
          </p>
        )}
        {ok && (
          <p
            className="mt-4 rounded-md bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200 ring-1 ring-emerald-500/30"
            data-testid="reimbursement-ok"
          >
            {ok}
          </p>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending}
          className="mt-4 rounded-md bg-dr3-cyan/20 px-5 py-2 text-sm font-semibold text-dr3-mist ring-1 ring-dr3-cyan/40 transition hover:bg-dr3-cyan/30 disabled:opacity-50"
          data-testid="reimbursement-submit"
        >
          {pending ? 'Submitting…' : 'Submit reimbursement'}
        </button>
      </section>

      {/* ── Waiting ──────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-dr3-mist">
          Waiting for a second signature{waiting.length > 0 ? ` (${waiting.length})` : ''}
        </h2>
        {waiting.length === 0 ? (
          <p className="rounded-lg border border-dashed border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-center text-sm text-dr3-mist-dim">
            Nothing is waiting.
          </p>
        ) : (
          <ul className="space-y-3">
            {waiting.map((r) => (
              <Card key={r.id} row={r} onDecide={decide} />
            ))}
          </ul>
        )}
      </section>

      {/* ── Settled ──────────────────────────────────────────────────────── */}
      {settled.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-dr3-mist">Decided</h2>
          <ul className="space-y-3">
            {settled.map((r) => (
              <Card key={r.id} row={r} onDecide={decide} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Card({
  row,
  onDecide,
}: {
  row: ReimbursementRow;
  onDecide: (id: string, d: 'approved' | 'rejected' | 'held') => void | Promise<void>;
}) {
  return (
    <li
      className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20"
      data-testid="reimbursement-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="text-lg font-semibold text-dr3-mist">{usd(row.amountCents)}</span>
          <span className="ml-2 text-dr3-mist-dim">for {row.beneficiary}</span>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${STATUS_STYLE[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Field k="What it was for" v={row.purpose} />
        <Field k="Category" v={row.category} />
        <Field k="Date of expense" v={row.expenseDate} />
        <Field k="Submitted" v={`${row.submitterName} — ${row.submittedAtPacific}`} />
        {row.status === 'pending_second_approval' && <Field k="Waiting on" v={row.routedToName} />}
        {row.secondApproverName && <Field k="Second signature" v={row.secondApproverName} />}
        {row.decisionNote && <Field k="Note" v={row.decisionNote} />}
      </dl>

      {row.escalated && row.status === 'pending_second_approval' && (
        <p className="mt-2 text-xs text-amber-300">
          Escalated to an administrator — the usual second approver can’t sign this one.
        </p>
      )}

      {row.status === 'pending_second_approval' && (
        <div className="mt-4 flex flex-wrap gap-2">
          {row.viewerMayApprove ? (
            <>
              <button
                type="button"
                onClick={() => void onDecide(row.id, 'approved')}
                className="rounded-md bg-emerald-500/20 px-4 py-1.5 text-sm font-semibold text-emerald-200 ring-1 ring-emerald-500/40 hover:bg-emerald-500/30"
                data-testid="reimbursement-approve"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void onDecide(row.id, 'rejected')}
                className="rounded-md bg-rose-500/20 px-4 py-1.5 text-sm font-semibold text-rose-200 ring-1 ring-rose-500/40 hover:bg-rose-500/30"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => void onDecide(row.id, 'held')}
                className="rounded-md bg-sky-500/20 px-4 py-1.5 text-sm font-semibold text-sky-200 ring-1 ring-sky-500/40 hover:bg-sky-500/30"
              >
                Hold
              </button>
            </>
          ) : (
            // Say WHY rather than hiding the controls silently. "You submitted
            // this" is the answer to the question the missing buttons raise, and
            // it is the whole point of the feature.
            <p className="text-sm text-dr3-mist-dim" data-testid="reimbursement-cannot-approve">
              {row.viewerSubmitted
                ? 'You submitted this, so you can’t also approve it — it needs a second person.'
                : `This one is ${row.routedToName}’s to sign.`}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-dr3-mist-dim">{k}</dt>
      <dd className="text-dr3-mist">{v}</dd>
    </div>
  );
}
