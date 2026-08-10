// PR #196 §2.3 — the COR stale-feed block.
//
// A Certificate of Recycling files the on-hand inventory figure, and `onHand`'s
// inbound leg is bridged from DELIVERED hauls (`mymrc_hauls_mirror`,
// status='Delivered' → `inbound_loads`, ADR-0059). When that feed freezes the
// ledger goes one-sided — processing keeps subtracting while nothing is added —
// and the balance drifts toward a confident, wrong, eventually negative number
// (measured −3,083 → −5,401 across 2026-07-24 → 2026-08-03 while every surface
// rendered it as fact). A regulatory filing must never be derivable from a feed
// known to be frozen, so end-of-month prefill AND finalize both refuse:
//
//   1. when the delivered-hauls feed is STALE (newest delivered haul older than
//      the mirror-freshness threshold — the same delivered-only measure the
//      2026-07-31 guard fix uses; a whole-table max is permanently masked by
//      future-dated Confirmed appointments and must never be reintroduced), or
//   2. when the balance itself is NEGATIVE — physically impossible on a floor,
//      always a drifted one-sided ledger, never a fileable figure.
//
// Mid-month CORs file inventory BLANK (ADR-0042 amendment) and are untouched.
// An EMPTY mirror is NOT stale (bootstrap semantics inherited from
// `assessFreshness`); the D2.1/D3 reconcile tripwire still governs that case.

import { prisma } from '@/lib/prisma';
import {
  DEFAULT_MAX_AGE_MS,
  measureFeedFreshness,
  type FeedFreshness,
} from '@/lib/mymrc/freshness';

/** The delivered-hauls feed is stale — refuse to derive a COR figure from it. */
export class CorInboundStaleError extends Error {
  readonly status = 409 as const;
  constructor(readonly context: { newest: string | null; ageDays: number | null }) {
    super(
      `COR refused: the inbound (delivered-hauls) feed is frozen — newest delivered haul is dated ` +
        `${context.newest ?? 'never'}` +
        (context.ageDays !== null ? ` (${context.ageDays.toFixed(1)} days behind)` : '') +
        `. The on-hand figure is computed from a one-sided ledger and must not be filed. ` +
        `Recover inbound (scripts/fix-woodland-inbound.sh) or take a fresh physical count, ` +
        `then regenerate the draft (PR #196 §2.3).`,
    );
    this.name = 'CorInboundStaleError';
  }
}

/** The recomputed balance is negative — never a fileable inventory figure. */
export class CorLedgerNegativeError extends Error {
  readonly status = 422 as const;
  constructor(readonly context: { totalUnits: number }) {
    super(
      `COR refused: the on-hand balance is NEGATIVE (${context.totalUnits} units). A negative ` +
        `floor is a drifted one-sided ledger (inbound missing), not a fileable inventory figure. ` +
        `Recover inbound or take a fresh physical count, then regenerate the draft (PR #196 §2.3).`,
    );
    this.name = 'CorLedgerNegativeError';
  }
}

/**
 * Pure decision, unit-testable without a DB — the 2026-07 incident is the
 * acceptance fixture (delivered frozen at 07-21 while Confirmed rows are dated
 * to 08-10 MUST refuse).
 */
export function assertInboundFreshnessForCor(f: FeedFreshness): void {
  if (!f.stale) return;
  throw new CorInboundStaleError({
    newest: f.newest ? f.newest.toISOString().slice(0, 10) : null,
    ageDays: f.ageMs !== null ? f.ageMs / 86_400_000 : null,
  });
}

/** Measure the delivered-hauls feed live and refuse when stale. */
export async function assertCorInboundFresh(now: Date = new Date()): Promise<void> {
  // Feed 'hauls' measures max(COALESCE(recycler_reported_delivery_date,
  // docking_appointment_date)) over DELIVERED rows only (src/lib/mymrc/freshness.ts,
  // corrected 2026-07-31 for rows, re-keyed 2026-08-10 per ADR-0089 D3) — the SAME
  // key the inbound bridge aggregates on, which is exactly the signal that feeds
  // the COR's inventory figure. This gate inherits both fixes with no code here.
  const f = await measureFeedFreshness({
    prisma,
    feed: 'hauls',
    now,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
  });
  assertInboundFreshnessForCor(f);
}

/** Refuse a negative end-of-month inventory figure. */
export function assertCorInventoryNotNegative(totalUnits: number): void {
  if (totalUnits < 0) throw new CorLedgerNegativeError({ totalUnits });
}
