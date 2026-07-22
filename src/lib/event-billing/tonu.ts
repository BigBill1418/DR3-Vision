// ADR-0056 (rollup §5.3, Rick Albritton 2026-07-19) — TONU (Trailer Order Not Used)
// billability, as a PURE function. TONU = a driver was DISPATCHED with a trailer but
// could not drop it. Dispatch is the precondition for the whole concept — a TONU that
// never dispatched is not a TONU at all (no haul to not-use), regardless of any stray
// cancel/divert flag. Rick's rule, once dispatched:
//   - cancelled BEFORE dispatch      → NO bill (the order never became a haul)
//   - cancelled AFTER dispatch       → billed at the haul rate
//   - diverted                       → billed at the haul rate (independent trigger)
// The haul rate is the site's Primary haul rate (Woodland per PR #128 §3.5); it is
// resolved by the caller and passed in — never invented here (rollup §15 DO-NOTs).

/** The `tonu_billing` projection this assessor reads. All times UTC. */
export interface TonuInput {
  /**
   * ADR-0056 amendment (Addendum A §A.3) — the haul-mode gate. A TONU is by
   * definition DR3 dispatching a trailer; it can only occur when DR3 performed
   * the haul (Mode A). When the event was hauled by a customer / third party
   * (Mode B, `dr3_hauled = false`) DR3 never dispatched, so there is no TONU to
   * bill — this guard runs FIRST, before dispatch timing.
   */
  dr3Hauled: boolean;
  /** When the driver was dispatched. Null ⇒ never dispatched (no TONU). */
  dispatchedAt: Date | null;
  /** When the order was cancelled, if it was. */
  cancelledAt: Date | null;
  /**
   * The trailer was diverted mid-route — an independent billable trigger, but only
   * for a DISPATCHED order (a divert flag on a never-dispatched order is a capture
   * slip, not a haul). See {@link assessTonu}.
   */
  diverted: boolean;
  /** Site Primary haul rate, integer cents. Null until resolved by the caller. */
  haulRateCents: number | null;
}

/** Why a TONU is or is not billable. */
export type TonuReason =
  | 'not_dr3_hauled'
  | 'not_dispatched'
  | 'dispatched_no_bill'
  | 'cancelled_before_dispatch'
  | 'cancelled_after_dispatch'
  | 'diverted';

/** The billability verdict for a TONU. */
export type TonuAssessment =
  | {
      billable: false;
      reason: 'not_dr3_hauled' | 'not_dispatched' | 'dispatched_no_bill' | 'cancelled_before_dispatch';
    }
  | { billable: true; reason: 'cancelled_after_dispatch' | 'diverted'; billedCents: number };

/** A TONU is billable but its haul rate is unseeded/null — refuse, never invent. */
export class TonuHaulRateUnavailableError extends Error {
  readonly status = 409 as const;
  constructor(readonly reason: 'cancelled_after_dispatch' | 'diverted') {
    super(
      `TONU is billable (${reason}) but the Primary haul rate is unseeded (haulRateCents is null) — ` +
        `refusing to bill (never guess a rate)`,
    );
    this.name = 'TonuHaulRateUnavailableError';
  }
}

/**
 * Assess whether a TONU bills, and at what amount. PURE. A billable TONU (cancelled
 * after dispatch, or diverted) bills exactly the Primary haul rate; when that rate is
 * null the assessor REFUSES ({@link TonuHaulRateUnavailableError}) rather than bill $0
 * or guess. Dispatch is the precondition for ANY bill — the no-dispatch guard runs
 * FIRST, so a stray `diverted`/`cancelledAt` flag on a never-dispatched order never
 * bills. Among dispatched orders, diversion is an independent trigger and wins even if
 * the cancel timing would otherwise say "before dispatch".
 */
export function assessTonu(input: TonuInput): TonuAssessment {
  // ADR-0056 amendment §A.3 — haul-mode gate FIRST. A TONU is DR3 dispatching a
  // trailer; if the event was hauled by a customer / third party (Mode B), DR3
  // never dispatched and there is no TONU to bill, regardless of any stray
  // dispatch/cancel/divert flag captured on the record.
  if (!input.dr3Hauled) return { billable: false, reason: 'not_dr3_hauled' };

  // No dispatch ⇒ there was no haul to not-use; not a billable TONU. This guard is
  // FIRST so a data-entry `diverted`/`cancelledAt` flag on a never-dispatched order
  // cannot bill the haul rate (Rick §5.3: TONU requires a dispatch).
  if (input.dispatchedAt == null) return { billable: false, reason: 'not_dispatched' };

  // Diversion is an independent trigger and wins over cancel timing (dispatch already
  // confirmed above).
  if (input.diverted) return billed('diverted', input.haulRateCents);

  // Cancelled strictly before dispatch ⇒ no bill (order never became a haul).
  if (input.cancelledAt != null && input.cancelledAt.getTime() < input.dispatchedAt.getTime()) {
    return { billable: false, reason: 'cancelled_before_dispatch' };
  }

  // Dispatched and cancelled at/after dispatch ⇒ billed at the haul rate.
  if (input.cancelledAt != null) return billed('cancelled_after_dispatch', input.haulRateCents);

  // Dispatched, not cancelled, not diverted ⇒ nothing to bill (the driver dropped the
  // trailer normally). Distinct from `not_dispatched` so an operator surface never
  // mislabels a real dispatch as "never dispatched".
  return { billable: false, reason: 'dispatched_no_bill' };
}

function billed(
  reason: 'cancelled_after_dispatch' | 'diverted',
  haulRateCents: number | null,
): TonuAssessment {
  if (haulRateCents == null) throw new TonuHaulRateUnavailableError(reason);
  return { billable: true, reason, billedCents: haulRateCents };
}
