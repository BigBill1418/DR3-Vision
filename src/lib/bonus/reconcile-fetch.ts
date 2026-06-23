// P0-1 / P0-2 — recompute + reconcile (the impure side of ADR-0033).
//
// `reconcile-payout.ts` is the PURE decision logic. This module is the thin I/O
// layer that the delivery + PDF paths call: it recomputes the period's grand
// total FROM the keyed entries (the same way the sign-time lock and the PDF page
// do — single calculator, `.toNumber()` coercion, active rule at period_start),
// hands the locked + recomputed totals to the pure reconciler, and on a non-OK
// verdict fires the contracted ntfy page.
//
// The recompute is INDEPENDENT of the locked total by construction: it re-walks
// the entries through `@/lib/bonus/calculator` rather than trusting the stored
// `total_payout_cents`. That independence is the whole point — it is the second
// computation that catches a disagreement.

import { prisma } from '@/lib/prisma';
import { calculateMonthlyBonusCents } from '@/lib/bonus/calculator';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';
import {
  reconcilePayout,
  isSuspectedWrongZero,
  type ReconcileVerdict,
} from '@/lib/bonus/reconcile-payout';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';

const APP_BASE_URL = (process.env['APP_BASE_URL'] ?? 'https://dr3-vision.svdp.us').replace(
  /\/+$/,
  '',
);

/** Click target for a payout-integrity page — the month's manager page. */
function monthClickUrl(monthId: string): string {
  return `${APP_BASE_URL}/bonus/months/${monthId}`;
}

export interface RecomputedPeriod {
  monthId: string;
  state: string;
  lockedTotalCents: number | null;
  recomputedTotalCents: number;
  importedWithLegacyFormula: boolean;
}

/**
 * Recompute a period's grand total from its keyed entries, returning it alongside
 * the locked total + the fields the reconciler needs. Mirrors the sign-time lock:
 * `mattress_count` is `Decimal(5,1)` at the Prisma edge, coerced via `.toNumber()`
 * (NEVER passed raw — that is the exact bug that zeroed the lock), and the rule is
 * the one active on `period_start`.
 *
 * Throws only if the period is missing or no active rule covers it — both of which
 * are themselves payroll-stopping conditions the caller surfaces.
 */
export async function recomputePeriodTotals(monthId: string): Promise<RecomputedPeriod> {
  const month = await prisma.bonusPayPeriod.findUnique({
    where: { id: monthId },
    select: {
      id: true,
      state: true,
      site_id: true,
      period_start: true,
      total_payout_cents: true,
      imported_with_legacy_formula: true,
    },
  });
  if (!month) throw new Error(`bonus month ${monthId} not found`);

  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_pay_period_id: monthId },
    select: { mattress_count: true },
  });
  const rule = await resolveActiveRule(month.site_id, month.period_start);
  const recomputedTotalCents = calculateMonthlyBonusCents(
    // `.toNumber()` is the load-bearing coercion — a raw Decimal silently zeros.
    entries.map((e) => e.mattress_count.toNumber()),
    {
      threshold_low: rule.threshold_low,
      rate_low: rule.rate_low,
      threshold_high: rule.threshold_high,
      rate_high: rule.rate_high,
    },
  );

  return {
    monthId,
    state: month.state,
    lockedTotalCents: month.total_payout_cents,
    recomputedTotalCents,
    importedWithLegacyFormula: month.imported_with_legacy_formula,
  };
}

export interface ReconcileGateResult {
  /** Safe to render/deliver the PDF. False means the caller must REFUSE. */
  pass: boolean;
  verdict: ReconcileVerdict;
  period: RecomputedPeriod;
}

/**
 * P0-1 reconciliation tripwire. Recompute the period, reconcile against the
 * locked total, and on a mismatch fire an URGENT `dr3-vision-system` page
 * (fingerprint `payout-reconcile-mismatch:<monthId>`) and return `pass:false` so
 * the caller refuses to render/deliver a PDF whose total disagrees with the lock.
 *
 * Never throws on the ntfy side (publishNtfy is fail-soft). A recompute throw
 * (missing month / no active rule) propagates — those are payroll-stopping and
 * the caller already treats a thrown PDF-assembly error as a refusal.
 */
export async function assertPayoutReconciles(monthId: string): Promise<ReconcileGateResult> {
  const period = await recomputePeriodTotals(monthId);
  const verdict = reconcilePayout(period);

  if (!verdict.ok) {
    log.error(
      {
        monthId,
        state: period.state,
        reason: verdict.reason,
        lockedTotalCents: verdict.lockedTotalCents,
        recomputedTotalCents: verdict.recomputedTotalCents,
      },
      '[reconcile] payout reconciliation FAILED — refusing PDF',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Bonus payout reconciliation mismatch — PDF refused',
      body:
        verdict.reason === 'missing_locked_total'
          ? `Period ${monthId} (state ${period.state}) has NO locked total_payout_cents but recomputes to ${verdict.recomputedTotalCents} cents. Refused to render/deliver the payroll PDF. Investigate the sign-time lock before paying.`
          : `Period ${monthId} (state ${period.state}): locked total ${verdict.lockedTotalCents} cents DISAGREES with the recomputed ${verdict.recomputedTotalCents} cents. Refused to render/deliver the payroll PDF — the two independent computations of the payout do not match. Do NOT pay until resolved.`,
      priority: 'urgent',
      tags: ['error', 'bonus', 'payroll', 'reconcile', 'dr3-vision'],
      clickUrl: monthClickUrl(monthId),
      fingerprint: `payout-reconcile-mismatch:${monthId}`,
    });
    return { pass: false, verdict, period };
  }

  return { pass: true, verdict, period };
}

export interface ZeroGuardResult {
  /** Safe to deliver. False means a suspected wrong $0 — caller must BLOCK. */
  pass: boolean;
  /** The recomputed period (for logging / further checks by the caller). */
  period: RecomputedPeriod;
}

/**
 * P0-2 implausible-(zero)-payout delivery guard. BLOCK delivery iff the locked
 * total is $0 but the entries recompute to a positive bonus (a $0 that DISAGREES
 * with the entries — the signature of tonight's incident). A locked $0 that
 * AGREES with a recomputed $0 (every processor sub-threshold) is a legitimate
 * real $0 and is ALLOWED.
 *
 * On block, fire an URGENT page (fingerprint `payout-zero-suspected:<monthId>`)
 * for a human to confirm. Reuses an already-recomputed period if the caller has
 * one (the delivery path recomputes once and passes it to both guards).
 */
export async function assertNotSuspectedWrongZero(
  monthId: string,
  prefetched?: RecomputedPeriod,
): Promise<ZeroGuardResult> {
  const period = prefetched ?? (await recomputePeriodTotals(monthId));

  if (
    isSuspectedWrongZero({
      lockedTotalCents: period.lockedTotalCents,
      recomputedTotalCents: period.recomputedTotalCents,
    })
  ) {
    log.error(
      { monthId, state: period.state, recomputedTotalCents: period.recomputedTotalCents },
      '[reconcile] suspected wrong $0 payout — blocking delivery',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'Suspected wrong $0 bonus payout — delivery blocked',
      body: `Period ${monthId} (state ${period.state}) locked total_payout_cents = $0, but the keyed entries recompute to ${period.recomputedTotalCents} cents. Blocked the payroll delivery for human confirmation — a $0 that disagrees with the entries is the signature of the Decimal-lock incident. If this period is genuinely sub-threshold the recompute would also be $0; it is not.`,
      priority: 'urgent',
      tags: ['error', 'bonus', 'payroll', 'zero-payout', 'dr3-vision'],
      clickUrl: monthClickUrl(monthId),
      fingerprint: `payout-zero-suspected:${monthId}`,
    });
    return { pass: false, period };
  }

  return { pass: true, period };
}
