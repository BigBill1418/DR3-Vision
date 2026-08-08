// ADR-0083 — the inventory leg of a saves entry.
//
// Bill: a saved mattress "becomes resale inventory". This module is where that
// happens, and it is the FIRST WRITER of `unit_status_movements` — the ADR-0037
// aggregate movement ledger has existed in the schema with zero writers since it
// was introduced. Read the model's own doc comment in `prisma/schema.prisma`
// before changing anything here; it records the Rick-vs-Kelsey ruling this file
// implements.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT A SAVE DOES TO INVENTORY — and, more importantly, what it does NOT
// ─────────────────────────────────────────────────────────────────────────
//
// 1. It records an `on_floor → saved` movement of N units for the site and day.
//
// 2. It does NOT decrement the live on-hand floor balance.
//
//    This is the G1 resolution and it is BINDING — do not "fix" it. Kelsey's
//    Addendum-A §A.2 immediate-subtraction model (a save leaves inventory the
//    moment it is saved) was operationally wrong and is RETRACTED. Rick's live
//    model, which is what the floor actually does: a saved unit is set aside but
//    stays physically on the floor until it is transferred to a store. It leaves
//    inventory on the `saved → sold` store transfer, not here.
//
//    `running-balance.ts` already encodes this — it deliberately omits
//    `savedUnits` from the live `onHand` computation and carries a comment
//    saying so. This module writes the ledger row WITHOUT touching that path, so
//    the floor tile and the COR numbers are unchanged by a save. A save adds
//    resale stock; it does not remove a mattress from the floor. Counting it as
//    both would be the double-count.
//
// 3. It writes NOTHING to `processed_units_daily`.
//
//    That table has THREE writers under a precedence rule
//    (`source='mymrc' AND closed_at IS NULL` wins) — the handoff's correction 1.
//    A save is not a processed unit, so it has no business in that table at all,
//    and staying out of it is how we respect the precedence rule rather than
//    racing it. The disjointness is the point: a saved mattress is never also
//    counted processed, because the two live in different columns of the bonus
//    entry and feed different ledgers.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY MOVEMENTS ARE DELTAS
// ─────────────────────────────────────────────────────────────────────────
//
// `bonus_daily_entries` is UPSERTED — a manager keys 10 saves, then corrects it
// to 14. The movement ledger is an APPEND-ONLY signed ledger (a live per-status
// count is the signed sum of movements into vs out of a bucket), so the correct
// response to that correction is a +4 row, not a second +14 row and not an
// edit of the first. We therefore write the DELTA between the previous stored
// saves value and the new one:
//
//     10 keyed          → +10  (on_floor → saved)
//     corrected to 14   →  +4  (on_floor → saved)
//     corrected to 9    →  -5  → written as a REVERSING `saved → on_floor` row
//     corrected to 9    →   0  → no row at all
//
// A downward correction is expressed as a movement in the opposite direction
// rather than a negative `units` value: `units` is a count of units crossing
// between buckets and a negative count is not a thing that happened. Reversing
// the direction keeps every row's arithmetic honest and keeps the signed-sum
// definition of "how many units are in the saved bucket" working without a
// special case. `note` records that the row is a correction.
//
// Writing a row per SAVE EVENT rather than a running total also means the
// ledger reads as a history of what the floor did, which is what an aggregate
// movement ledger is for.

import { Prisma } from '@prisma/client';

/**
 * Inputs for one saves entry's inventory leg. `previousSaves` is null when the
 * bonus entry was just inserted (there was no prior value), which is different
 * from 0 (a prior value that happened to be zero) — though both yield the same
 * delta, keeping them distinct means the audit trail can say which happened.
 */
export interface SavesMovementInput {
  siteId: string;
  /** UTC-midnight `@db.Date` key for the Pacific calendar day, as stored on the entry. */
  movementDate: Date;
  previousSaves: number | null;
  currentSaves: number;
  /** The `bonus_daily_entries` row this movement derives from (source ref). */
  entryId: string;
  actorUserId: string;
}

/**
 * Record the `on_floor → saved` movement implied by a saves entry, on the
 * CALLER'S transaction.
 *
 * The `tx` parameter is not optional and is deliberately not defaulted to the
 * prisma singleton: a paid save whose inventory movement committed separately
 * (or not at all) is exactly the split-write this repo has been bitten by
 * before. The bonus entry, its audit row and this movement land together or
 * none of them do.
 *
 * Returns the created movement row id, or null when the delta was zero and no
 * row was warranted (a note-only edit, or a re-save of the same number). A
 * no-op is a legitimate outcome, not a failure.
 */
export async function recordSavesMovement(
  tx: Prisma.TransactionClient,
  input: SavesMovementInput,
): Promise<string | null> {
  const previous = input.previousSaves ?? 0;
  const delta = input.currentSaves - previous;

  // Nothing crossed a bucket boundary. Writing a 0-unit movement row would put
  // noise in a ledger whose whole value is that every row is a thing that
  // happened.
  if (delta === 0) return null;

  const isCorrection = input.previousSaves !== null;
  const isReversal = delta < 0;

  // `units` is Int on the model while `saves` is Decimal(5,1). A fractional save
  // is a real possibility (the column inherits `mattress_count`'s half-shift
  // resolution), so round rather than truncate — and only AFTER taking the
  // delta, so a sequence of fractional corrections cannot accumulate a drift the
  // way per-row rounding would.
  const units = Math.abs(Math.round(delta * 10) / 10);
  const wholeUnits = Math.round(units);
  if (wholeUnits === 0) return null;

  const created = await tx.unitStatusMovement.create({
    data: {
      site_id: input.siteId,
      movement_date: input.movementDate,
      units: wholeUnits,
      // A downward correction moves units back onto the floor rather than
      // recording a negative save. See the header.
      from_status: isReversal ? 'saved' : 'on_floor',
      to_status: isReversal ? 'on_floor' : 'saved',
      source: 'manual',
      created_by: input.actorUserId,
      note: isCorrection
        ? `ADR-0083 saves correction on bonus entry ${input.entryId}: ${previous} → ${input.currentSaves}`
        : `ADR-0083 saves entry ${input.entryId}`,
    },
    select: { id: true },
  });

  return created.id;
}
