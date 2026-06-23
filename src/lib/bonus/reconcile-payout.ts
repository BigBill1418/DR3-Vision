// P0-1 / P0-2 — Payroll payout reconciliation guards (ADR-0033).
//
// Tonight's incident (2026-06-22/23): two INDEPENDENT computations of the same
// bonus payout disagreed. The sign-time lock in `signatures.ts` zeroed the total
// via a Prisma Decimal type bug (`total_payout_cents = 0`) while the PDF page
// recomputed the correct $2,125.50 from the same entries. Nothing compared the
// two, and the failure was silent, so a $0 lock could have been paid.
//
// The calculator (`@/lib/bonus/calculator`) is now sound — it THROWS on bad
// input. This module is the OUTER RING: cheap, exact, integer-equality assertions
// that catch a disagreement between the locked total and the recomputed total
// BEFORE a PDF can be rendered or mailed to payroll, and surface the disagreement
// loudly (the caller pages on a non-OK verdict).
//
// Pure + DB-free + browser-free by design (mirrors `pdf-data.ts`): the caller
// fetches the locked total + the recomputed grand total and hands both here. That
// keeps the money invariant unit-testable and side-effect-free; the I/O (ntfy,
// refusing the render) lives at the call sites (`pdf.ts`, `payroll-delivery.ts`).

import type { BonusPayPeriodState } from '@/lib/bonus/state-machine';

// ────────────────────────────────────────────────────────────────────
// P0-1 — reconciliation tripwire
// ────────────────────────────────────────────────────────────────────

/**
 * States for which the locked `total_payout_cents` is the AUTHORITATIVE, final
 * figure and MUST equal the freshly-recomputed grand total. A payroll PDF is
 * only ever generated/delivered for a period in one of these states (delivery
 * fires on reaching `signed`; `paid` is the post-delivery terminal state), so
 * reconciling here means a mismatched PDF can never reach payroll.
 *
 * Deliberately EXCLUDES:
 *   - `draft` / `pending_signatures` / `partially_signed`: not yet locked.
 *   - `amended`: re-opened + editable (EDITABLE_STATES) — its entries are being
 *     re-keyed, so a stale/absent locked total is expected, not a defect. It
 *     re-locks a fresh total when it transitions back through signing.
 *   - `historical_imported`: prints the AS-PAID legacy total (ADR-0023 Q1), which
 *     intentionally differs from the corrected-formula recompute.
 */
export const RECONCILED_STATES: ReadonlySet<string> = new Set<BonusPayPeriodState>([
  'signed',
  'paid',
]);

export interface ReconcileInput {
  monthId: string;
  state: string;
  /** The total locked at sign time (`bonus_pay_periods.total_payout_cents`). */
  lockedTotalCents: number | null;
  /** The grand total recomputed from the keyed entries via the calculator. */
  recomputedTotalCents: number;
  /**
   * ADR-0023: a historical period that prints the legacy as-paid total rather
   * than the corrected recompute. Such a period is never reconciled even if its
   * state were (incorrectly) one of the reconciled states — its locked figure is
   * intentionally a different number.
   */
  importedWithLegacyFormula?: boolean;
}

export type ReconcileVerdict =
  | { ok: true; reconciled: boolean }
  | {
      ok: false;
      reason: 'total_mismatch' | 'missing_locked_total';
      lockedTotalCents: number | null;
      recomputedTotalCents: number;
    };

/**
 * Decide whether a period's locked total reconciles with the recomputed grand
 * total. Pure — never throws, never does I/O.
 *
 *   - `reconciled: false` (ok) → the period's state is outside RECONCILED_STATES
 *     (or it's a legacy-formula historical import); the invariant does not apply.
 *   - `ok: true, reconciled: true` → exact integer match. Safe to render/deliver.
 *   - `ok: false, reason: 'missing_locked_total'` → a reconciled-state period has
 *     a NULL locked total (a signed period must have locked a number).
 *   - `ok: false, reason: 'total_mismatch'` → the two computations disagree.
 *
 * Exact integer equality of the SAME computation (both flow through the single
 * `@/lib/bonus/calculator` over the same per-day counts), so a true positive is a
 * genuine disagreement and there are no false positives by construction.
 */
export function reconcilePayout(input: ReconcileInput): ReconcileVerdict {
  if (input.importedWithLegacyFormula) return { ok: true, reconciled: false };
  if (!RECONCILED_STATES.has(input.state)) return { ok: true, reconciled: false };

  if (input.lockedTotalCents === null) {
    return {
      ok: false,
      reason: 'missing_locked_total',
      lockedTotalCents: null,
      recomputedTotalCents: input.recomputedTotalCents,
    };
  }
  if (input.lockedTotalCents !== input.recomputedTotalCents) {
    return {
      ok: false,
      reason: 'total_mismatch',
      lockedTotalCents: input.lockedTotalCents,
      recomputedTotalCents: input.recomputedTotalCents,
    };
  }
  return { ok: true, reconciled: true };
}

// ────────────────────────────────────────────────────────────────────
// P0-2 — implausible-(zero)-payout delivery guard
// ────────────────────────────────────────────────────────────────────
//
// A period can LEGITIMATELY be $0 when every processor was below the bonus
// threshold (e.g. Timothy Elich: 24 mattresses < the 50 threshold → $0.00). So a
// $0 payout is NOT, by itself, suspicious. What IS suspicious is a $0 LOCKED total
// that DISAGREES with what the entries actually compute to — exactly the failure
// mode of the Decimal bug, where real production locked to $0.
//
// PREDICATE (the one chosen — documented for the operator):
//   Block delivery iff  lockedTotalCents === 0  AND  recomputedTotalCents > 0.
//
//   - locked 0, recompute 0  → genuinely sub-threshold; ALLOW (a real $0 is valid).
//   - locked 0, recompute >0 → the lock disagrees with the entries; BLOCK + page.
//   - locked >0              → not a zero-payout case; this guard does not apply
//                              (P0-1 reconciliation still asserts exact equality).
//
// This is a strict subset of the P0-1 mismatch (a `total_mismatch` where the
// locked side is specifically 0). It is broken out separately so the operator
// page reads as "a suspected wrong $0" (the highest-signal, most-recognisable
// version of tonight's incident) rather than a generic mismatch. Reconciliation
// (P0-1) would also catch this; this guard makes the $0 case explicit and is the
// one wired into the delivery path's pre-send check.

export interface ZeroPayoutInput {
  lockedTotalCents: number | null;
  recomputedTotalCents: number;
}

/**
 * True when the period's locked total is a SUSPECTED wrong $0 — i.e. it locked $0
 * but the keyed entries recompute to a positive bonus. A locked $0 that agrees
 * with a recomputed $0 (everyone sub-threshold) returns false (allowed).
 */
export function isSuspectedWrongZero(input: ZeroPayoutInput): boolean {
  return input.lockedTotalCents === 0 && input.recomputedTotalCents > 0;
}
