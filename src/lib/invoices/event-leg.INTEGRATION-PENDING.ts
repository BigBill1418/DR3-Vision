// @ts-nocheck
// ADR-0041 B8 events leg — INTEGRATION-PENDING (do NOT wire into the build).
//
// ── Why this file is quarantined ────────────────────────────────────────
// The invoice engine (this agent) and the CAPTURE half (sibling agent) were
// built in parallel. The sibling owns the `collection_events` table + service.
// This engine consumes events ONLY through the typed `EventCostRow` interface in
// `./types.ts`. This file is the ONE place that maps a real `collection_events`
// row onto that interface — coded against the sibling's SPECCED shape from
// ADR-0041 D3, NOT against generated Prisma types (the `CollectionEvent` model
// does not exist in this half's client). It is:
//   - marked `@ts-nocheck` (top of file),
//   - excluded from tsc / eslint / vitest via the `**/*.INTEGRATION-PENDING.ts`
//     glob (tsconfig, eslint.config.mjs, vitest.config.ts),
// so it can reference the not-yet-merged model without breaking the gate.
//
// ── Merge wiring (for the integrator) ───────────────────────────────────
// At merge, once both halves land on one branch:
//   1. rename this file to `event-leg.ts` (drops it back into the build),
//   2. remove the `@ts-nocheck` line and confirm the Prisma field names below
//      match the sibling's final `collection_events` columns (D3 shape),
//   3. in `generation-inputs.ts`, replace `emptyEventLeg()` with a call to
//      `fetchEventCostRows(...)` and set `eventsPending: false`.
// Until then, generation treats the events leg as zero-with-warning and the B8
// line renders with `source.pending = 'events-integration'` (never absent, D6).
//
// ── ADR-0041 D3 `collection_events` shape this maps from ────────────────
//   collection_events(id, site_id, event_date, customer, county?, slip_number?,
//     units?, freight_cents?, driver_hours?, driver_wages_cents?, labor_hours?,
//     labor_wages_cents?, mileage?, per_diem_cents?, misc_cents?, retrac_id?,
//     notes?, …audit)
// Wage fields default from the B5 rules (driver $125/hr, labor $90/hr, per diem
// $275) but are STORED as entered — so the mapping trusts the stored cents and
// only falls back to hours×rate when the cents field is null.

import type { PrismaClient } from '@prisma/client';
import type { EventCostRow } from './types';

// B5 rule constants (cents) — fallbacks only; stored actuals win.
const DRIVER_HOURLY_CENTS = 12500;
const LABOR_HOURLY_CENTS = 9000;

function wagesCents(storedCents: number | null, hours: unknown, hourlyCents: number): number {
  if (typeof storedCents === 'number') return storedCents;
  const h = Number(hours ?? 0);
  return Math.round(h * hourlyCents);
}

/**
 * Fetch the collection events whose `event_date` falls in the (inclusive)
 * window and map each to an `EventCostRow`. `mileage` in `collection_events` is
 * a dollar-reimbursement amount recorded in cents at the entry surface (D3);
 * this mapping passes it straight through. `freight_cents` is carried onto B16,
 * not B8 (the engine's composers enforce the split).
 */
export async function fetchEventCostRows(
  db: PrismaClient,
  siteId: string,
  windowStartISO: string,
  windowEndISO: string,
): Promise<EventCostRow[]> {
  const start = new Date(`${windowStartISO}T00:00:00Z`);
  const end = new Date(`${windowEndISO}T00:00:00Z`);
  const rows = await db.collectionEvent.findMany({
    where: { site_id: siteId, event_date: { gte: start, lte: end } },
    orderBy: { event_date: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    eventDateISO: r.event_date.toISOString().slice(0, 10),
    customer: r.customer ?? null,
    driverWagesCents: wagesCents(r.driver_wages_cents, r.driver_hours, DRIVER_HOURLY_CENTS),
    laborWagesCents: wagesCents(r.labor_wages_cents, r.labor_hours, LABOR_HOURLY_CENTS),
    mileageCents: r.mileage ?? 0,
    perDiemCents: r.per_diem_cents ?? 0,
    miscCents: r.misc_cents ?? 0,
    freightCents: r.freight_cents ?? 0,
    retracId: r.retrac_id ?? null,
  }));
}
