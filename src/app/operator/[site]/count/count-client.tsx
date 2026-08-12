'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { enqueueAction, isOfflineError, newIdempotencyKey } from '@/lib/offline-queue';
import {
  classifyWriteRefusal,
  WriteRefusalNotice,
  type WriteRefusal,
} from '../../_components/write-refusal';
import { NumberStepper } from '../number-stepper';

// ADR-0060 F-3 client — physical on-hand count.
// ADR-0072 — the tiered overwrite guardrail's OPERATOR-FACING half.
//
// The count is the inventory anchor: every downstream number is computed forward
// from it, so a mistyped digit does not produce a wrong count — it silently moves
// the whole floor. Three tiers:
//
//   Tier 0 — no anchor yet. Save, no friction. (Every Eugene count today.)
//   Tier 1 — a modest overwrite. One confirm screen showing current-vs-new and
//            the change IN WORDS, because "2,483 → 2,150" is exactly the kind of
//            thing that reads as fine at a glance.
//   Tier 2 — a large overwrite. Held for a manager; the operator cannot release
//            it themselves.
//
// This component decides which screen to SHOW. It does not decide whether the
// write is allowed — the server recomputes the tier on every request, so a
// bypassed dialog changes nothing. A Tier 2 count comes back as a 422 carrying
// the hold id, and this renders the approval screen from that response rather
// than from its own arithmetic.

type Props = {
  siteCode: string;
  expectedTotal: number;
  jurisdiction: 'california' | 'oregon';
  /** Total of the anchor this count would replace; null when there is none. */
  priorTotal: number | null;
  thresholdPct: number;
  /** ADR-0078 D10 — the Pacific day this count is FOR, rendered server-side. */
  countDate: string;
};

type Result = { computedTotal: string; physicalTotal: number; reconciledDelta: number };

type Hold = {
  holdId: string;
  priorTotal: number | null;
  newTotal: number;
  swingPct: number | null;
  approvers: Array<{ id: string; name: string }>;
};

type Phase = 'entry' | 'confirm' | 'held' | 'discarded';

export function CountClient({
  siteCode,
  expectedTotal,
  jurisdiction,
  priorTotal,
  countDate,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [primary, setPrimary] = useState(0); // units_indoor (CA) or units_total (OR)
  const [inProcessing, setInProcessing] = useState(0);
  const [splitOn, setSplitOn] = useState(false);
  const [program, setProgram] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Audit D-8 — held separately from `error` because these two refusals are not
   * "couldn't save, try again": one of them carries a control, and neither may
   * be shown next to the generic sentence that told the floor to retap forever.
   */
  const [refusal, setRefusal] = useState<WriteRefusal | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [phase, setPhase] = useState<Phase>('entry');
  const [hold, setHold] = useState<Hold | null>(null);
  /** ADR-0078 — queued-but-not-acked. Deliberately NOT `result`; see submit(). */
  const [queued, setQueued] = useState(false);
  const [approverId, setApproverId] = useState('');
  const [pin, setPin] = useState('');

  const physicalTotal = primary + inProcessing;
  const nonProgram = Math.max(0, physicalTotal - program);
  const primaryLabel =
    jurisdiction === 'california' ? t('floor.count.indoor_label') : t('floor.count.total_label');

  const delta = priorTotal === null ? null : physicalTotal - priorTotal;
  const swingPct =
    priorTotal === null || priorTotal === 0 ? null : (Math.abs(delta ?? 0) / priorTotal) * 100;

  function reset(): void {
    setResult(null);
    setPrimary(0);
    setInProcessing(0);
    setProgram(0);
    setSplitOn(false);
    setHold(null);
    setQueued(false);
    setApproverId('');
    setPin('');
    setError(null);
    setRefusal(null);
    setPhase('entry');
  }

  /**
   * Audit D-8 — the way out of a day mismatch.
   *
   * `countDate` is a prop from the server page, so a soft refresh re-renders it
   * to the current Pacific day while the typed counts survive in local state.
   * The operator taps Save once more and it lands.
   */
  function refreshToToday(): void {
    setRefusal(null);
    setError(null);
    router.refresh();
  }

  function bodyForSubmit(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      // ADR-0078 D10 — the count now SAYS which day it is for. The server used
      // to derive that from its own clock at write time, which is right for a
      // live submit and silently wrong for one replayed the next morning.
      // `countDate` comes from the server-rendered page (Pacific), not from the
      // iPad's clock, which operators can and do set wrong.
      countDate,
      unitsInProcessing: inProcessing,
      poolAttribution: 'measured',
    };
    if (jurisdiction === 'california') body['unitsIndoor'] = primary;
    else body['unitsTotal'] = primary;
    if (splitOn) {
      body['programUnits'] = Math.min(program, physicalTotal);
      body['nonProgramUnits'] = nonProgram;
    }
    return body;
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setRefusal(null);
    // ADR-0078 — minted HERE, once, before the attempt. Reused verbatim by the
    // queued entry if this request never gets an answer, so a submit that
    // actually landed and merely lost its response replays to the SAME write
    // rather than a second anchor. A key minted per attempt would defeat the
    // entire mechanism.
    const idempotencyKey = newIdempotencyKey();
    const payload = bodyForSubmit();
    try {
      const res = await fetch(`/api/operator/${siteCode}/count`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        // Audit D-8 — BEFORE every other branch. The 422 the ADR-0065 day pin
        // throws and the 401 an expired session earns are both refusals no
        // retap can clear, and until this they arrived as "Couldn't save. Try
        // again." — the sentence that produced the retap.
        const refused = classifyWriteRefusal(res.status, b['error']);
        if (refused) {
          setRefusal(refused);
          return;
        }
        // Tier 2 — the server HELD it. Not an error to retry past: the count is
        // stored safely and needs a person, so this is a state change, not a
        // failure message.
        if (b['error'] === 'manager_approval_required') {
          setHold({
            holdId: String(b['holdId']),
            priorTotal: (b['priorTotal'] as number | null) ?? null,
            newTotal: Number(b['newTotal']),
            swingPct: (b['swingPct'] as number | null) ?? null,
            approvers: (b['approvers'] as Array<{ id: string; name: string }>) ?? [],
          });
          setPhase('held');
          return;
        }
        setError(
          b['error'] === 'pool_mismatch'
            ? t('floor.count.err_split')
            : t('floor.common.save_failed'),
        );
        return;
      }
      setResult(b as unknown as Result);
      setPhase('entry');
      router.refresh();
    } catch (e) {
      // ADR-0078 D5 — this used to be a bare `catch { setError(…) }`. A count
      // typed on a dropping connection produced an error message and nothing
      // else: the operator's work was gone, and the only record of it was a
      // sentence telling them to try again. Now it is queued.
      //
      // Note what is NOT set: `result`. Green means server-acked, always. A
      // queued count shows its own distinct state, because a confirmation the
      // server never gave is the lie that makes an operator stop checking.
      if (isOfflineError(e)) {
        await enqueueAction({
          scope: 'operator.count.create',
          site_code: siteCode,
          target_day: countDate,
          idempotency_key: idempotencyKey,
          payload,
          endpoint: `/api/operator/${siteCode}/count`,
        });
        setQueued(true);
        setPhase('entry');
      } else {
        setError(t('floor.common.save_failed'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function approve(): Promise<void> {
    if (!hold) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const res = await fetch(`/api/operator/${siteCode}/count/holds/${hold.holdId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approverUserId: approverId, pin }),
      });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        // Audit D-8 — a hold released behind an expired session read "Couldn't
        // save" and invited the operator to retype a manager's PIN into a screen
        // that cannot answer. Say which thing is wrong.
        const refused = classifyWriteRefusal(res.status, b['error']);
        if (refused) {
          setRefusal(refused);
          setPin('');
          return;
        }
        const code = String(b['error'] ?? '');
        setError(
          code === 'bad_pin'
            ? t('floor.count.err_bad_pin')
            : code === 'operator_cannot_self_release'
              ? t('floor.count.err_self_release')
              : code === 'not_a_manager'
                ? t('floor.count.err_not_manager')
                : t('floor.common.save_failed'),
        );
        setPin('');
        return;
      }
      setResult({
        computedTotal: String(hold.priorTotal ?? 0),
        physicalTotal: hold.newTotal,
        reconciledDelta: hold.newTotal - (hold.priorTotal ?? 0),
      });
      setHold(null);
      setPhase('entry');
      router.refresh();
    } catch {
      setError(t('floor.common.save_failed'));
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (!hold) return;
    const reason = window.prompt(t('floor.count.hold_discard_reason')) ?? '';
    if (reason.trim() === '') return;
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch(`/api/operator/${siteCode}/count/holds/${hold.holdId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) {
        setHold(null);
        setPhase('discarded');
      } else {
        // Audit D-8 — same treatment as Approve, one control over.
        const refused = classifyWriteRefusal(res.status, null);
        if (refused) setRefusal(refused);
        else setError(t('floor.common.save_failed'));
      }
    } catch {
      setError(t('floor.common.save_failed'));
    } finally {
      setBusy(false);
    }
  }

  // ── Queued (ADR-0078) ────────────────────────────────────────────────────
  // Visually distinct from Saved on purpose. Saved is green and reports the
  // reconciled delta, because the server computed one. This reports no numbers
  // at all — the reconciliation has not happened yet and inventing a preview of
  // it would be the same false confirmation in a quieter font.
  if (queued) {
    return (
      <div className="flex flex-col gap-6">
        <div
          className="rounded-xl bg-amber-900/50 p-6 text-center ring-1 ring-amber-400/40"
          data-testid="count-queued"
        >
          <p className="text-lg font-bold">{t('floor.common.queued')}</p>
          <p className="mt-2 text-sm text-dr3-cream/85">
            {t('floor.conflicts.target_day', { day: countDate })}
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink"
        >
          {t('floor.count.count_again')}
        </button>
      </div>
    );
  }

  // ── Saved ────────────────────────────────────────────────────────────────
  if (result) {
    const d = result.reconciledDelta;
    const msg =
      d === 0
        ? t('floor.count.result_match')
        : d > 0
          ? t('floor.count.result_more', { n: d })
          : t('floor.count.result_fewer', { n: Math.abs(d) });
    return (
      <div className="flex flex-col gap-6">
        <div className="rounded-xl bg-dr3-green-dark/50 p-6 text-center">
          <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
            {t('floor.count.result_heading')}
          </p>
          <p className="mt-1 text-5xl font-bold tabular-nums">{result.physicalTotal}</p>
          <p className="mt-3 text-lg">{msg}</p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink"
        >
          {t('floor.count.count_again')}
        </button>
      </div>
    );
  }

  // ── Discarded ────────────────────────────────────────────────────────────
  if (phase === 'discarded') {
    return (
      <div className="flex flex-col gap-6">
        <p className="rounded-xl bg-dr3-green-dark/50 p-6 text-center text-lg">
          {t('floor.count.hold_discarded')}
        </p>
        <button
          type="button"
          onClick={reset}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink"
        >
          {t('floor.count.count_again')}
        </button>
      </div>
    );
  }

  // ── Tier 2 — held for a manager ──────────────────────────────────────────
  if (phase === 'held' && hold) {
    return (
      <div className="flex flex-col gap-5" data-testid="count-hold">
        <div className="rounded-xl bg-amber-900/50 p-5 ring-1 ring-amber-400/40">
          <p className="text-lg font-bold">{t('floor.count.hold_heading')}</p>
          <p className="mt-2 text-sm leading-relaxed text-dr3-cream/85">
            {t('floor.count.hold_body')}
          </p>
        </div>

        <ComparePanel t={t} prior={hold.priorTotal} next={hold.newTotal} swingPct={hold.swingPct} />

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
          >
            {error}
          </p>
        )}
        {refusal && <WriteRefusalNotice refusal={refusal} onRefresh={refreshToToday} />}

        <label className="flex flex-col gap-2 text-base font-semibold">
          {t('floor.count.hold_manager_label')}
          <select
            value={approverId}
            onChange={(e) => setApproverId(e.target.value)}
            className="min-h-[56px] rounded-lg bg-dr3-green-dark/60 px-3 text-lg text-dr3-cream"
            data-testid="hold-approver"
          >
            <option value="">{t('floor.count.hold_manager_placeholder')}</option>
            {hold.approvers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-base font-semibold">
          {t('floor.count.hold_pin_label')}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="min-h-[56px] rounded-lg bg-dr3-green-dark/60 px-3 text-lg tracking-[0.4em] text-dr3-cream"
            data-testid="hold-pin"
          />
        </label>

        <button
          type="button"
          disabled={busy || approverId === '' || pin === ''}
          onClick={approve}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:opacity-50"
          data-testid="hold-approve"
        >
          {busy ? t('floor.common.saving') : t('floor.count.hold_approve')}
        </button>

        <p className="text-sm leading-relaxed text-dr3-cream/70">
          {t('floor.count.hold_remote_note')}
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={discard}
          className="min-h-[48px] rounded-lg bg-transparent px-4 py-2 text-base font-semibold text-dr3-cream/70 underline disabled:opacity-50"
        >
          {t('floor.count.hold_discard')}
        </button>
      </div>
    );
  }

  // ── Tier 1 — confirm an overwrite ────────────────────────────────────────
  if (phase === 'confirm') {
    return (
      <div className="flex flex-col gap-5" data-testid="count-confirm">
        <p className="text-lg font-bold">{t('floor.count.confirm_heading')}</p>

        <ComparePanel t={t} prior={priorTotal} next={physicalTotal} swingPct={swingPct} />

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
          >
            {error}
          </p>
        )}
        {refusal && <WriteRefusalNotice refusal={refusal} onRefresh={refreshToToday} />}

        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:opacity-50"
          data-testid="confirm-save"
        >
          {busy ? t('floor.common.saving') : t('floor.count.confirm_save')}
        </button>
        <button
          type="button"
          disabled={busy}
          // Cancel returns to entry with the typed value INTACT — a guardrail that
          // makes you re-key the number teaches people to rush past it.
          onClick={() => setPhase('entry')}
          className="min-h-[56px] rounded-lg bg-dr3-green-dark/60 px-4 py-3 text-lg font-semibold text-dr3-cream"
          data-testid="confirm-cancel"
        >
          {t('floor.count.confirm_cancel')}
        </button>
      </div>
    );
  }

  // ── Entry ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-dr3-cream/70">{t('floor.count.intro')}</p>

      <section className="rounded-xl bg-dr3-green-dark/40 p-5">
        <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
          {t('floor.count.expected_heading')}
        </p>
        <p className="mt-1 text-4xl font-bold tabular-nums">{expectedTotal}</p>
      </section>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-900/60 px-4 py-3 text-sm font-medium text-white"
        >
          {error}
        </p>
      )}
      {refusal && <WriteRefusalNotice refusal={refusal} onRefresh={refreshToToday} />}

      <NumberStepper label={primaryLabel} value={primary} onChange={setPrimary} />
      <NumberStepper
        label={t('floor.count.processing_label')}
        value={inProcessing}
        onChange={setInProcessing}
      />

      <p className="text-xl font-bold">
        {t('floor.count.your_total_label')}: <span className="tabular-nums">{physicalTotal}</span>
      </p>

      <label className="flex items-center gap-3 text-base font-semibold">
        <input
          type="checkbox"
          checked={splitOn}
          onChange={(e) => setSplitOn(e.target.checked)}
          className="h-6 w-6 accent-dr3-green"
        />
        {t('floor.count.program_label')} / {t('floor.count.non_program_label')}
      </label>

      {splitOn && (
        <div className="flex flex-col gap-4 rounded-lg bg-dr3-green-dark/30 p-4">
          <NumberStepper
            label={t('floor.count.program_label')}
            value={program}
            onChange={setProgram}
            max={physicalTotal}
          />
          <p className="text-base">
            {t('floor.count.non_program_label')}:{' '}
            <span className="font-bold tabular-nums">{nonProgram}</span>
          </p>
        </div>
      )}

      <button
        type="button"
        disabled={busy || physicalTotal < 0}
        // Tier 0 (no anchor) saves directly; anything that REPLACES an existing
        // anchor goes through the confirm screen first.
        onClick={() => (priorTotal === null ? void submit() : setPhase('confirm'))}
        className="min-h-[56px] rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink disabled:opacity-50"
      >
        {busy ? t('floor.common.saving') : t('floor.count.submit')}
      </button>
    </div>
  );
}

/**
 * Current-vs-new, plus the change in WORDS.
 *
 * The two numbers alone are what get skimmed past; the sentence is what makes a
 * wrong one look wrong.
 */
function ComparePanel({
  t,
  prior,
  next,
  swingPct,
}: {
  t: (k: string, vars?: Record<string, string | number>) => string;
  prior: number | null;
  next: number;
  swingPct: number | null;
}) {
  if (prior === null) {
    return (
      <div className="rounded-xl bg-dr3-green-dark/40 p-5">
        <p className="text-base">{t('floor.count.confirm_first')}</p>
        <p className="mt-2 text-4xl font-bold tabular-nums">{next}</p>
      </div>
    );
  }
  const diff = next - prior;
  const sentence = t(diff < 0 ? 'floor.count.confirm_decrease' : 'floor.count.confirm_increase', {
    prior: prior.toLocaleString(),
    next: next.toLocaleString(),
    n: Math.abs(diff).toLocaleString(),
    pct: swingPct === null ? '—' : swingPct.toFixed(0),
  });
  return (
    <div className="rounded-xl bg-dr3-green-dark/40 p-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
            {t('floor.count.confirm_current')}
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-dr3-cream/70">
            {prior.toLocaleString()}
          </p>
        </div>
        <div className="text-2xl text-dr3-cream/50">→</div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
            {t('floor.count.confirm_new')}
          </p>
          <p className="mt-1 text-4xl font-bold tabular-nums">{next.toLocaleString()}</p>
        </div>
      </div>
      <p className="mt-4 text-base font-semibold leading-relaxed" data-testid="swing-sentence">
        {sentence}
      </p>
    </div>
  );
}
