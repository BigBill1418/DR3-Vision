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
// So this listing is deliberately UNBOUNDED IN TIME, and instead bounded by three
// much tighter predicates:
//   - `assigned_operator_id` = the signed-in operator. Not the site's loads —
//     `load/[id]/page.tsx` redirects anyone who is not the assignee, so listing
//     another operator's load would render a link that bounces. A load belonging
//     to someone who has left is a MANAGER reassignment (T-010), not a floor fix.
//   - a non-terminal dock status. `submitted` / `verified` / `rejected` /
//     `submitted_to_mymrc` / `processed` are done as far as the floor is concerned.
//   - the operator's own site.
//
// Resuming is safe on the write side already: `startInboundLoad` is idempotent
// (returns the existing child rather than minting a duplicate) and the
// `ALLOWED_PRIOR` state machine in `load-service.ts` accepts `finished ->
// submitted`, so a stranded finished load submits normally once reachable.

import { prisma } from '@/lib/prisma';
import type { LoadStatus } from '@prisma/client';

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
}

/**
 * Every load still open on the dock FOR THIS OPERATOR at this site, oldest first
 * so the most-stale unfinished work sits at the top of the list.
 *
 * Deliberately takes no date argument: see the module header for why the
 * current-Pacific-day floor must not apply to unfinished work.
 */
export async function listOperatorOpenLoads(
  siteId: string,
  operatorUserId: string,
): Promise<OpenLoadView[]> {
  const rows = await prisma.inboundLoad.findMany({
    where: {
      site_id: siteId,
      assigned_operator_id: operatorUserId,
      status: { in: [...OPEN_DOCK_STATUSES] },
    },
    select: {
      id: true,
      status: true,
      arrived_at: true,
      bol_number: true,
      total_units: true,
      source: { select: { name: true } },
      transporter: { select: { name: true } },
    },
    // `arrived_at` is nullable on the model; `nulls: 'last'` keeps a row with no
    // arrival instant visible rather than sorting it into an unpredictable slot.
    orderBy: { arrived_at: { sort: 'asc', nulls: 'last' } },
  });

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    arrivedAt: r.arrived_at,
    sourceName: r.source?.name ?? null,
    transporterName: r.transporter?.name ?? null,
    bolNumber: r.bol_number,
    totalUnits: r.total_units,
    readyToSubmit: r.status === 'finished',
  }));
}
