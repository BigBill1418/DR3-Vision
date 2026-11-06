'use client';

// ADR-0072 Amendment 1 — approve or discard held counts from the desktop.
//
// No eligibility logic lives here. The server decides who may release what
// (`releaseHold`: still pending, eligible approver, never the person who entered
// it). `enteredByMe` only hides an Approve button the server would refuse, the
// same courtesy count-corrections extends to superseded rows.
//
// Every refusal is named. A manager who sees "something went wrong" on a count
// that is holding the site's inventory hostage stops trusting the screen.
//
// Approve is one tap plus one confirm: it writes the anchor the whole floor is
// computed from. Discard requires a reason, which the route records.
//
// CLAUDE.md hard rule #10 — no <form>; every handler is onClick/onChange.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface HeldCountView {
  id: string;
  createdAtISO: string;
  enteredByName: string | null;
  countedBy: string | null;
  confirmedBy: string | null;
  enteredByMe: boolean;
  priorTotal: number;
  newTotal: number;
  swingPct: number;
  thresholdPct: number;
  largeSwing: boolean;
  /** Pending holds sharing this hold's Pacific day and total, itself included. */
  sameCountPending: number;
}

type Msg = { kind: 'ok' | 'err'; text: string };

const btn =
  'min-h-[44px] rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';
const dangerBtn =
  'min-h-[44px] rounded border border-red-400/60 px-4 py-2 text-sm font-semibold text-red-200 disabled:opacity-40';
const ghostBtn =
  'min-h-[44px] rounded border border-white/25 px-4 py-2 text-sm disabled:opacity-40';

/** Pacific wall clock, labelled — the fleet's display rule for a true instant. */
export function pacificLabel(iso: string): string {
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso))} PT`;
}

/**
 * The sentence for a refused release or discard. `gone` means the hold is no
 * longer pending, so the list should be re-read rather than the action retried.
 */
export function describeRefusal(
  status: number,
  body: { error?: string; message?: string },
): { text: string; gone: boolean } {
  const code = body.error ?? '';
  if (status === 401) {
    return { text: 'Your sign-in has expired. Reload the page and sign in again.', gone: false };
  }
  if (code === 'operator_cannot_self_release') {
    return {
      text: 'You entered this count yourself (on this login or your floor login), so you cannot approve it. Another manager or an admin must approve it.',
      gone: false,
    };
  }
  if (code === 'not_a_manager') {
    return {
      text: 'Your account is not an approver for this site. Only this site’s managers and admins can approve held counts.',
      gone: false,
    };
  }
  if (code === 'forbidden') {
    return { text: 'You do not have manager access to this site.', gone: false };
  }
  if (code === 'hold_not_found') {
    return { text: 'This held count no longer exists. The list has been refreshed.', gone: true };
  }
  if (status === 409) {
    const state =
      code === 'hold_approved' ? 'approved' : code === 'hold_discarded' ? 'discarded' : 'resolved';
    return {
      text: `Someone already ${state} this held count. The list has been refreshed.`,
      gone: true,
    };
  }
  if (code === 'reason_required') {
    return { text: 'Enter a reason before discarding.', gone: false };
  }
  return {
    text: `The server could not complete this (${status}${code ? ` ${code}` : ''}). Nothing was changed. Try again, and tell an admin if it repeats.`,
    gone: false,
  };
}

export function HeldCountsClient({
  siteCode,
  holds,
}: {
  siteCode: string;
  holds: HeldCountView[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<{ id: string; action: 'approve' | 'discard' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const open = (id: string, action: 'approve' | 'discard') => {
    setMode({ id, action });
    setReason('');
    setMsg(null);
  };

  const send = async (h: HeldCountView, action: 'approve' | 'discard') => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/count-holds/${h.id}`, {
        method: action === 'approve' ? 'POST' : 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: action === 'discard' ? JSON.stringify({ reason: reason.trim() }) : null,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        newTotal?: number;
      };
      if (!res.ok) {
        const r = describeRefusal(res.status, data);
        setMsg({ kind: 'err', text: r.text });
        if (r.gone) {
          setMode(null);
          router.refresh();
        }
        return;
      }
      setMsg({
        kind: 'ok',
        text:
          action === 'approve'
            ? `Approved. ${(data.newTotal ?? h.newTotal).toLocaleString('en-US')} units is now the count on record.`
            : `Discarded the held count of ${h.newTotal.toLocaleString('en-US')}. Nothing was written to inventory.`,
      });
      setMode(null);
      router.refresh();
    } catch {
      setMsg({ kind: 'err', text: 'Could not reach the server. Nothing was changed.' });
    } finally {
      setBusy(false);
    }
  };

  if (holds.length === 0) {
    return (
      <div className="mt-6">
        {msg && <Message msg={msg} />}
        <p className="text-sm opacity-80" data-testid="no-holds">
          No counts are waiting for approval at this site.
        </p>
      </div>
    );
  }

  const groups = holds.filter((h) => h.sameCountPending > 1).length;

  return (
    <div className="mt-6 flex flex-col gap-4">
      {msg && <Message msg={msg} />}

      {groups > 0 && (
        <p
          role="status"
          data-testid="duplicates-banner"
          className="rounded border border-amber-400/60 bg-amber-400/10 px-3 py-2 text-sm text-amber-100"
        >
          <strong>Some of these look like the same count entered more than once.</strong> Held
          counts with the same total on the same day are marked below. Approve one of each group and
          discard the rest — approving them all writes the same count again and again.
        </p>
      )}

      <ul className="flex flex-col gap-4" aria-label="Held counts">
        {holds.map((h) => {
          const delta = h.newTotal - h.priorTotal;
          const isOpen = mode?.id === h.id;
          return (
            <li
              key={h.id}
              data-testid={`hold-${h.id}`}
              className={`rounded-lg border p-4 ${
                h.largeSwing ? 'border-red-400/70 bg-red-500/10' : 'border-white/15 bg-white/5'
              }`}
            >
              {h.largeSwing && (
                <p
                  role="alert"
                  data-testid={`large-swing-${h.id}`}
                  className="mb-3 rounded bg-red-900/60 px-3 py-2 text-sm font-semibold text-white"
                >
                  Very large change: {h.swingPct.toFixed(1)}% is more than twice this site&apos;s{' '}
                  {h.thresholdPct}% threshold. Check for a mistyped or missing digit, or recount,
                  before approving.
                </p>
              )}
              {h.sameCountPending > 1 && (
                <p
                  data-testid={`duplicate-${h.id}`}
                  className="mb-3 rounded border border-amber-400/60 px-3 py-1.5 text-sm text-amber-100"
                >
                  Possible duplicate: {h.sameCountPending} held counts show{' '}
                  {h.newTotal.toLocaleString('en-US')} on this day. Approve one, discard the others.
                </p>
              )}

              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs uppercase tracking-wide opacity-70">On record then</dt>
                  <dd className="text-lg">{h.priorTotal.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide opacity-70">Counted</dt>
                  <dd className="text-lg font-bold">{h.newTotal.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide opacity-70">Change</dt>
                  <dd className="text-lg">
                    {delta > 0 ? '+' : ''}
                    {delta.toLocaleString('en-US')} ({h.swingPct.toFixed(1)}%)
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide opacity-70">Entered</dt>
                  <dd>{pacificLabel(h.createdAtISO)}</dd>
                </div>
                <div className="col-span-2 sm:col-span-4">
                  <dt className="sr-only">Who</dt>
                  <dd className="opacity-90">
                    Entered by {h.enteredByName ?? 'not recorded'}
                    {h.countedBy ? ` · counted by ${h.countedBy}` : ''}
                    {h.confirmedBy ? ` · confirmed by ${h.confirmedBy}` : ''}
                  </dd>
                </div>
              </dl>

              <div className="mt-4 flex flex-wrap items-start gap-3">
                {!isOpen && !h.enteredByMe && (
                  <button
                    type="button"
                    className={btn}
                    disabled={busy}
                    onClick={() => open(h.id, 'approve')}
                    data-testid={`approve-${h.id}`}
                  >
                    Approve…
                  </button>
                )}
                {!isOpen && h.enteredByMe && (
                  <p className="text-sm opacity-80" data-testid={`mine-${h.id}`}>
                    You entered this count. Another manager or an admin must approve it.
                  </p>
                )}
                {!isOpen && (
                  <button
                    type="button"
                    className={dangerBtn}
                    disabled={busy}
                    onClick={() => open(h.id, 'discard')}
                    data-testid={`discard-${h.id}`}
                  >
                    Discard…
                  </button>
                )}

                {isOpen && mode?.action === 'approve' && (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm">
                      Write <strong>{h.newTotal.toLocaleString('en-US')}</strong> as this
                      site&apos;s count?
                    </p>
                    <button
                      type="button"
                      className={btn}
                      disabled={busy}
                      onClick={() => void send(h, 'approve')}
                      data-testid={`confirm-approve-${h.id}`}
                    >
                      {busy ? 'Approving…' : 'Yes, approve'}
                    </button>
                    <button
                      type="button"
                      className={ghostBtn}
                      disabled={busy}
                      onClick={() => setMode(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {isOpen && mode?.action === 'discard' && (
                  <div className="flex w-full flex-col gap-2">
                    <label htmlFor={`reason-${h.id}`} className="text-sm">
                      Why are you discarding this count? (required)
                    </label>
                    <textarea
                      id={`reason-${h.id}`}
                      className="w-full max-w-xl rounded border border-white/20 bg-black/30 px-2 py-1 text-sm text-white"
                      rows={2}
                      maxLength={500}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      data-testid={`reason-${h.id}`}
                    />
                    <div className="flex gap-3">
                      <button
                        type="button"
                        className={dangerBtn}
                        disabled={busy || reason.trim() === ''}
                        onClick={() => void send(h, 'discard')}
                        data-testid={`confirm-discard-${h.id}`}
                      >
                        {busy ? 'Discarding…' : 'Discard count'}
                      </button>
                      <button
                        type="button"
                        className={ghostBtn}
                        disabled={busy}
                        onClick={() => setMode(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Message({ msg }: { msg: Msg }) {
  return (
    <p
      role={msg.kind === 'err' ? 'alert' : 'status'}
      data-testid="hold-message"
      className={`rounded border px-3 py-2 text-sm ${
        msg.kind === 'ok' ? 'border-dr3-cyan/40 bg-dr3-cyan/10' : 'border-red-400/40 bg-red-400/10'
      }`}
    >
      {msg.text}
    </p>
  );
}
