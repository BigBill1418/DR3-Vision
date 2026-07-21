// ADR-0056 (rollup §5.3, Rick Albritton 2026-07-19) — TONU (Trailer Order Not Used)
// billability, as a PURE function. TONU = a driver was dispatched with a trailer but
// could not drop it. Rick's rule:
//   - cancelled BEFORE dispatch      → NO bill (the order never became a haul)
//   - cancelled AFTER dispatch       → billed at the haul rate
//   - diverted                       → billed at the haul rate (independent trigger)
// The haul rate is the site's Primary haul rate (Woodland per PR #128 §3.5); it is
// resolved by the caller and passed in — never invented here (rollup §15 DO-NOTs).

/** The `tonu_billing` projection this assessor reads. All times UTC. */
export interface TonuInput {
  /** When the driver was dispatched. Null ⇒ never dispatched (no TONU). */
  dispatchedAt: Date | null;
  /** When the order was cancelled, if it was. */
  cancelledAt: Date | null;
  /** The trailer was diverted mid-route — an independent billable trigger. */
  diverted: boolean;
  /** Site Primary haul rate, integer cents. Null until resolved by the caller. */
  haulRateCents: number | null;
}

/** Why a TONU is or is not billable. */
export type TonuReason =
  | 'not_dispatched'
  | 'cancelled_before_dispatch'
  | 'cancelled_after_dispatch'
  | 'diverted';

/** The billability verdict for a TONU. */
export type TonuAssessment =
  | { billable: false; reason: 'not_dispatched' | 'cancelled_before_dispatch' }
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
 * or guess. Diversion is an independent trigger and wins even if the cancel timing
 * would otherwise say "before dispatch".
 */
export function assessTonu(input: TonuInput): TonuAssessment {
  if (input.diverted) return billed('diverted', input.haulRateCents);

  // No dispatch ⇒ there was no haul to not-use; not a billable TONU.
  if (input.dispatchedAt == null) return { billable: false, reason: 'not_dispatched' };

  // Cancelled strictly before dispatch ⇒ no bill (order never became a haul).
  if (input.cancelledAt != null && input.cancelledAt.getTime() < input.dispatchedAt.getTime()) {
    return { billable: false, reason: 'cancelled_before_dispatch' };
  }

  // Dispatched and (cancelled at/after dispatch, or still cancelled with no earlier
  // timestamp) ⇒ billed at the haul rate.
  if (input.cancelledAt != null) return billed('cancelled_after_dispatch', input.haulRateCents);

  // Dispatched, not cancelled, not diverted ⇒ nothing to bill as a TONU.
  return { billable: false, reason: 'not_dispatched' };
}

function billed(
  reason: 'cancelled_after_dispatch' | 'diverted',
  haulRateCents: number | null,
): TonuAssessment {
  if (haulRateCents == null) throw new TonuHaulRateUnavailableError(reason);
  return { billable: true, reason, billedCents: haulRateCents };
}
