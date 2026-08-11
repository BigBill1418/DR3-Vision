// ADR-0065 Amendment 1 (2026-07-30) — the operator's OWN unfinished dock loads.
//
// ── The defect this closes ───────────────────────────────────────────────────
// The floor queue lists `expected_loads`, not `inbound_loads`. Once an operator
// taps a queue row, `startInboundLoad` mints an `inbound_loads` row and the 7-stage
// workflow lives at `/operator/<site>/load/<id>`. There was NO surface anywhere on
// the iPad that listed in-progress loads — so the ONLY route back into an
// unfinished one was the redirect the start action itself performs. Lose that tab
// (iPad sleeps, PWA reloads, the operator logs out for a shift handoff, another
// operator uses the shared device) and the load is unreachable: an operator cannot
// type a UUID.
//
// The queue row is not a fallback, because THREE independent filters remove it:
//   1. `expected_arrival_at` is bounded to the current Pacific day (ADR-0065 D5),
//      so yesterday's or a future-dated parent row is gone.
//   2. `cancelled_at: null` — MyMRC can cancel the expected row after the dock
//      work is already done.
//   3. The queue only ever showed the PARENT expected row, never the child load.
//
// Measured in production 2026-07-30 (dr3_vision on svdp-dev), three Woodland loads
// were stranded, each by a different one of those filters:
//   - `arrived`  parent expected 2026-07-29 10:00 AM PDT   -> filter 1 (past day)
//   - `finished` 3 units counted, parent CANCELLED 2026-07-29 4:00 PM PDT
//                -> filters 1 AND 2. The units were counted and never submitted,
//                   so they never reached inventory or billing.
//   - `arrived`  parent expected 2026-08-05 12:00 PM PDT   -> filter 1 (future day)
//
// ── Why this is NOT the "historical view" ADR-0065 D5 rules out ──────────────
// Bill: "only going to show hauls from the current day … no historical or future
// views." That rule is about BROWSING — an operator must not be able to page back
// through past production days or pre-stage future ones. Your own load that is
// still mid-workflow is not history; it is unfinished CURRENT work whose arrival
// timestamp happens to be in the past. Applying the day floor to it does not
// protect anything: it strands units that are already counted, which is strictly
// worse for production accuracy than showing the row.
//
// So this listing is deliberately UNBOUNDED IN TIME, and instead bounded by two
// much tighter predicates:
//   - a non-terminal dock status. `submitted` / `verified` / `rejected` /
//     `submitted_to_mymrc` / `processed` are done as far as the floor is concerned.
//   - the operator's own site.
//
// ── ADR-0082 SUPERSEDES A THIRD PREDICATE ────────────────────────────────────
// This listing was ALSO scoped to `assigned_operator_id` = the signed-in
// operator, and the stated reason was that `load/[id]/page.tsx` redirected any
// non-assignee, so listing another operator's load would render a link that
// bounces. ADR-0082 replaced that redirect with a held-by state and a Take over
// button, so the reason is gone — and the filter's remaining effect was to hide
// the loads that most need a taker. `listSiteOpenLoads` below is site-wide and
// splits by holder; the claim of "a load belonging to someone who has left is a
// MANAGER reassignment (T-010), not a floor fix" was Bill's decision reversed on
// 2026-08-07: self-serve takeover, no manager, because waiting for a manager IS
// the stranding.
//
// Resuming is safe on the write side already: `startInboundLoad` is idempotent
// (returns the existing child rather than minting a duplicate) and the
// `ALLOWED_PRIOR` state machine in `load-service.ts` accepts `finished ->
// submitted`, so a stranded finished load submits normally once reachable.

import { prisma } from '@/lib/prisma';
import type { LoadStatus } from '@prisma/client';
import { HAUL_NUMBER_SELECT, haulNumberOf } from '@/lib/loads/haul-number';

/**
 * Dock statuses that are still the FLOOR's work. Anything outside this set has
 * left the operator's hands (`submitted` awaits manager verification; `verified`,
 * `rejected`, `submitted_to_mymrc` and `processed` are terminal downstream).
 *
 * `expected` is excluded on purpose: it is the `InboundLoad` model default and
 * belongs to aggregate/bridge rows, never to a load a dock operator started
 * (`startInboundLoad` writes `arrived`).
 */
export const OPEN_DOCK_STATUSES: readonly LoadStatus[] = [
  'arrived',
  'weight_captured',
  'unload_started',
  'in_progress',
  'finished',
] as const;

export interface OpenLoadView {
  id: string;
  status: LoadStatus;
  /** True instant — render with a Pacific-pinned formatter, never a bare one. */
  arrivedAt: Date | null;
  sourceName: string | null;
  transporterName: string | null;
  bolNumber: string | null;
  /** Units counted so far (null until the stacks stage writes a total). */
  totalUnits: number | null;
  /** The load is counted and only the submit press is missing — surface it first. */
  readyToSubmit: boolean;
  /**
   * ADR-0082 — who currently holds the claim, BY NAME. Null only for a legacy
   * row with no assignee (none exist in production; the column is nullable, so
   * the type says so rather than asserting a shape the database does not
   * guarantee).
   */
  claimedByUserId: string | null;
  claimedByName: string | null;
  /**
   * ADR-0090 A — the MyMRC haul number ("H-136796"), or null when the load has
   * no haul linkage at all (a walk-up drop-off). Source + carrier + BOL do not
   * separate two trucks from one collection site on one day, which is the
   * ordinary case JT described; the haul number does.
   */
  haulNumber: string | null;
}

/** ADR-0082 — the site's open dock work, split by who holds each claim. */
export interface SiteOpenLoads {
  /** The viewer's own unfinished loads. Finishing your own work outranks helping. */
  mine: OpenLoadView[];
  /** Open loads another operator at this site holds — takeover candidates. */
  heldByOthers: OpenLoadView[];
}

/**
 * Every load still open on the dock AT THIS SITE, oldest first so the most-stale
 * unfinished work sits at the top of each list.
 *
 * ── ADR-0082: why this is site-wide, where ADR-0065 Am.1 was operator-scoped ──
 *
 * The original listing filtered on `assigned_operator_id = the signed-in
 * operator`, and the reason it gave was sound at the time: `load/[id]/page.tsx`
 * REDIRECTED a non-assignee, so listing someone else's load would have rendered a
 * link that bounced. ADR-0082 removes that redirect — the load page now renders a
 * held-by state with a Take over button — so the reason the filter existed is
 * gone, and what the filter now does is hide the exact loads that need a taker.
 *
 * Production 2026-08-08: nine open loads across five operators at Woodland, the
 * oldest eleven days old, one of them `finished` with its units counted and
 * unbilled. Every one of those was invisible to everybody except the one person
 * whose name was on it. That is the stranding, and an operator-scoped list cannot
 * show it by construction.
 *
 * ── This is still NOT the "historical view" ADR-0065 D5 rules out ─────────────
 *
 * Bill's rule is about BROWSING — no paging back through past production days, no
 * pre-staging future ones. It governs `expected_loads`, which is where the
 * current-Pacific-day window still applies untouched. An unfinished load is not
 * history; it is current work whose arrival timestamp happens to be in the past,
 * and that was already the accepted reasoning for showing the operator their own.
 * Widening it from "mine" to "this site's" does not add a day of history — it adds
 * the colleague standing next to you.
 *
 * Deliberately takes no date argument: applying the day floor is what stranded the
 * three loads ADR-0065 Am.1 was written about.
 */
export async function listSiteOpenLoads(
  siteId: string,
  viewerUserId: string,
): Promise<SiteOpenLoads> {
  const rows = await prisma.inboundLoad.findMany({
    where: {
      site_id: siteId,
      status: { in: [...OPEN_DOCK_STATUSES] },
    },
    select: {
      id: true,
      status: true,
      arrived_at: true,
      bol_number: true,
      total_units: true,
      assigned_operator_id: true,
      source: { select: { name: true } },
      transporter: { select: { name: true } },
      assigned_operator: { select: { id: true, name: true } },
      ...HAUL_NUMBER_SELECT,
    },
    // `arrived_at` is nullable on the model; `nulls: 'last'` keeps a row with no
    // arrival instant visible rather than sorting it into an unpredictable slot.
    orderBy: { arrived_at: { sort: 'asc', nulls: 'last' } },
  });

  const views: OpenLoadView[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    arrivedAt: r.arrived_at,
    sourceName: r.source?.name ?? null,
    transporterName: r.transporter?.name ?? null,
    bolNumber: r.bol_number,
    totalUnits: r.total_units,
    readyToSubmit: r.status === 'finished',
    claimedByUserId: r.assigned_operator?.id ?? null,
    claimedByName: r.assigned_operator?.name ?? null,
    haulNumber: haulNumberOf(r),
  }));

  // Split in memory rather than issuing two queries: one index scan over
  // `(site_id, status)` already has every row, and two queries could observe two
  // different instants — a load taken over between them would appear in both
  // lists or in neither.
  return {
    mine: views.filter((v) => v.claimedByUserId === viewerUserId),
    heldByOthers: views.filter((v) => v.claimedByUserId !== viewerUserId),
  };
}
