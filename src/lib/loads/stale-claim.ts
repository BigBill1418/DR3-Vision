// ADR-0092 — how long a claimed load has been QUIET, and what that means.
//
// Pure and dependency-free on purpose: no `prisma`, no `@prisma/client` enum
// import, nothing that pins it to the server. The manager dashboard renders this
// verdict server-side and the queue can badge it client-side, and both must
// reach the same conclusion from the same function — the ADR-0091 lesson, one
// week old, is that two surfaces re-deriving the same judgement is how they end
// up disagreeing in production.
//
// ## What "stale" is measured FROM, and why it is not the claim
//
// ADR-0082 says: *"'Open' is not 'stranded' … `in_progress` cannot distinguish a
// truck being unloaded right now from one abandoned at lunch. The age of the
// claim is what carries that."* That was right about the distinction and, this
// module argues, one field off about the instrument.
//
// Claim age is wrong in both directions:
//
//   - FALSE POSITIVE. Early claims are real. On 2026-08-11 H-136147 was claimed
//     at 07:55 PDT against a 15:00 PDT appointment. A claim-age detector calls
//     that load abandoned at 11:55 while the operator is working it normally.
//   - FALSE NEGATIVE. A load claimed 20 minutes ago and dropped 19 minutes ago is
//     as abandoned as one claimed yesterday; claim age says it is the freshest
//     thing on the dock.
//
// Pablo Ledezma's signature on 2026-08-11 was not an old claim — it was **silence
// after the last write** (claimed 06:46 PDT, last write 06:48 PDT, then nothing).
// That is the signal, so that is what this measures.
//
// ## The trap inside "last write"
//
// `inbound_loads.updated_at` alone is NOT the answer, and reading it alone would
// have shipped a watchdog that accuses working operators. `addStack` creates a
// `load_stacks` row inside its transaction and **does not update the parent
// load** (see `load-service.ts`) — so `updated_at` FREEZES for the entire count.
// An operator working a 40-stack trailer looks idle to a naive detector for as
// long as the count takes, which is exactly the population most likely to be
// mid-work and least deserving of being reported abandoned.
//
// Photos are the same story on the other end of the workflow: the BOL and weight
// stages write `load_photos` rows, so a stacks-only signal would call the opening
// twenty minutes of every load idle.
//
// Hence the MAXIMUM of all three. Erring toward "more recent activity" makes the
// watchdog QUIETER, which is the correct direction for a new alert (ADR-0037) and
// the correct direction for a floor that has just been told the software was
// wrong about who held a load. The cost is a real miss: a late offline-queue
// photo (ADR-0086 capture-time grants — measured up to 12.8 days after the row's
// own `updated_at` in production) can reset the clock on a genuinely dead load.
// That is a miss, not a false alarm, and it is the trade this module chooses
// deliberately. Recorded in ADR-0092 rather than left to be discovered.

/**
 * The three instants that constitute evidence that the system saw work on a
 * load. Deliberately carries NO unit counts — see the note on magnitude below.
 */
export interface ClaimActivityRow {
  /** `inbound_loads.updated_at` — stage transitions, weight, finish. */
  updatedAt: Date;
  /** Newest non-voided `load_stacks.created_at`, or null when none exist. */
  lastStackAt: Date | null;
  /** Newest `load_photos.uploaded_at`, or null when none exist. */
  lastPhotoAt: Date | null;
}

/** Escalating bands. `ok` is silence; only `nudge` ever sends anything. */
export type StaleLevel = 'ok' | 'badge' | 'nudge';

export interface StalenessVerdict {
  level: StaleLevel;
  /** Milliseconds since the last evidence of work. Floored at 0. */
  idleMs: number;
  lastActivity: Date;
}

/**
 * Show a staleness marker in-app after this long. Passive: a badge on a manager
 * dashboard, no mail, no push, nobody interrupted.
 *
 * 2h. Production p90 for healthy same-Pacific-day dock work is 73 MINUTES end to
 * end (52 loads, 2026-08-11), so 2h of total silence is already well outside
 * normal — while staying short enough that a manager sees a strand mid-shift
 * rather than after it.
 */
export const STALE_BADGE_MS = 2 * 60 * 60 * 1000;

/**
 * Tell a human after this long. 4h.
 *
 * Chosen from the same measurement: healthy work has p99 = 355 minutes (~6h)
 * CLAIM-TO-SUBMIT, and that window contains many writes — four hours of complete
 * silence is not a slow load, it is a stopped one. The six loads that crossed a
 * Pacific day (the strands this exists for) sat for 2–4 DAYS, so the threshold
 * sits in a wide empty gap rather than on a boundary the data argues about.
 */
export const STALE_NUDGE_MS = 4 * 60 * 60 * 1000;

/**
 * The most recent evidence of work, across all three sources.
 *
 * MAX, never "the newest row type" — a late replay can carry an instant older
 * than a stage write that already happened, and taking it would REWIND the clock
 * and manufacture staleness out of a load that is moving.
 */
export function lastActivityAt(row: ClaimActivityRow): Date {
  let ms = row.updatedAt.getTime();
  if (row.lastStackAt && row.lastStackAt.getTime() > ms) ms = row.lastStackAt.getTime();
  if (row.lastPhotoAt && row.lastPhotoAt.getTime() > ms) ms = row.lastPhotoAt.getTime();
  return new Date(ms);
}

/**
 * How stale a claimed, still-open load is.
 *
 * NOTE WHAT IS ABSENT: no unit count, no `expected_unit_count`, no
 * `total_units`. This is not an oversight, it is the invariant. Every stranded
 * load has `total_units = NULL` **by definition** — it was never finished — and
 * on 2026-08-11 three of four live expected slots carried
 * `expected_unit_count = 0`. A detector that reasoned about magnitude would
 * either divide by zero or quietly decide an uncounted load was not worth
 * reporting, i.e. it would go blind on precisely the population it exists to
 * find. `ClaimActivityRow` has no units field so the wrong question cannot be
 * asked, and a test asserts that shape.
 *
 * The caller is responsible for only passing loads that are actually open —
 * `OPEN_DOCK_STATUSES` in `open-loads.ts` is the single definition of that, and
 * this module deliberately does not restate it.
 */
export function stalenessOf(row: ClaimActivityRow, now: Date): StalenessVerdict {
  const lastActivity = lastActivityAt(row);
  // Floored at zero: two clocks in one transaction can place a child row a
  // moment "ahead" of `now`, and a negative idle must not wrap into a huge one.
  const idleMs = Math.max(0, now.getTime() - lastActivity.getTime());
  const level: StaleLevel =
    idleMs > STALE_NUDGE_MS ? 'nudge' : idleMs > STALE_BADGE_MS ? 'badge' : 'ok';
  return { level, idleMs, lastActivity };
}
