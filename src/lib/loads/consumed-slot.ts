// ADR-0074 Amendment 1 — "has this expected load already been worked?", once.
//
// TWO surfaces offer the floor a check-in affordance against `expected_loads`:
// the day-bounded queue (`/operator/[site]/queue`) and the open portal-haul list
// (`/operator/[site]/hauls`, ADR-0074). On 2026-08-10 BOTH were blind to the
// same thing — neither asked whether the slot already had an `inbound_loads`
// child — and the floor was blocked for a morning because of it.
//
// The blindness was identical but the code was not shared, so fixing one would
// have left the other. This module is the single answer both now read. Adding a
// third check-in surface without going through it is the way this defect comes
// back.
//
// ## Why a consumed slot is not merely "already claimed"
//
// `startInboundLoad` is idempotent on `expected_load_id` and returns the
// existing child (ADR-0082). That is CORRECT and untouched — it is what stops
// two operators tapping one truck from minting two billing records. The
// consequence is that a tap on a consumed slot cannot fail loudly; it succeeds,
// quietly, into somebody else's finished work. So the refusal has to happen
// where the affordance is OFFERED, and it has to be able to say why.

import type { LoadStatus } from '@prisma/client';
import { OPEN_DOCK_STATUSES } from '@/lib/loads/open-loads';

/** What became of an expected load's slot, in the terms the floor cares about. */
export interface ConsumedLoadRef {
  /**
   * ADR-0091 — the child load's id, i.e. THE ROUTE BACK INTO THE WORK.
   *
   * Amendment 1 deliberately gave the consumed card no control, and for a
   * `submitted` slot that is still right: there is nothing to go back to. But
   * the same card is shown for an OPEN child, where a route absolutely exists
   * (`/operator/<site>/load/<id>` renders the workflow to its holder and the
   * ADR-0082 held-by panel to anyone else) and withholding it is what stranded
   * Pablo Ledezma on H-136311 for ~70 minutes on 2026-08-11.
   */
  loadId: string;
  status: string;
  /**
   * True while the child is still on the floor (an operator has it open), false
   * once it has left the floor's hands.
   *
   * Decided HERE, server-side, rather than in a client component.
   * {@link OPEN_DOCK_STATUSES} sits beside `prisma` in `open-loads.ts` and
   * cannot be imported into the browser bundle — and a hand-copied status set in
   * the UI is precisely how `held-by-panel.tsx` came to label a `submitted` load
   * "Counting" for five days.
   */
  open: boolean;
  totalUnits: number | null;
  /** `submitted_at`. NULL while the load is open, or if it never got there. */
  workedAt: Date | null;
  /**
   * ADR-0091 — WHO holds the claim, so the card can stop guessing.
   *
   * Without this the card had no way to tell your own load from a colleague's,
   * so it called every open child "Already started by another operator" — a
   * sentence that is false exactly when the reader is the holder, which is the
   * common case (you started it, the iPad slept, you came back). Null only for a
   * legacy row with no assignee; the column is nullable, so the type says so.
   */
  holderUserId: string | null;
  holderName: string | null;
}

/** The child row every caller must select to be able to answer the question. */
export const CONSUMED_SLOT_SELECT = {
  id: true,
  status: true,
  total_units: true,
  submitted_at: true,
  assigned_operator_id: true,
  assigned_operator: { select: { name: true } },
} as const;

export interface InboundChildRow {
  id: string;
  status: LoadStatus;
  total_units: number | null;
  submitted_at: Date | null;
  assigned_operator_id: string | null;
  assigned_operator: { name: string } | null;
}

/**
 * NULL ⇒ the slot is free and (subject to the caller's own day bound) startable.
 * Non-null ⇒ it has been worked, and the row must render read-only.
 */
export function toConsumedLoad(child: InboundChildRow | null | undefined): ConsumedLoadRef | null {
  if (!child) return null;
  // ADR-0090 C — a VOIDED child does not consume its slot.
  //
  // In practice this branch is unreachable: `voidLoad` NULLs `expected_load_id`,
  // so a voided load is no longer any slot's `inbound_load` and callers pass
  // `null` here. It is kept because the cost of being wrong is asymmetric and
  // measured — on 2026-08-10 a consumed-slot misread blocked the Woodland floor
  // for a morning — and because it states the invariant at the boundary that
  // enforces it, rather than leaving it implicit in a `data:` clause two modules
  // away. A future void path that forgets to sever degrades to a re-checkable
  // slot instead of a dead end.
  if (child.status === 'voided') return null;
  return {
    loadId: child.id,
    status: child.status,
    open: OPEN_DOCK_STATUSES.includes(child.status),
    totalUnits: child.total_units,
    workedAt: child.submitted_at,
    holderUserId: child.assigned_operator_id,
    holderName: child.assigned_operator?.name ?? null,
  };
}
