// ADR-0041 B8 events leg — the ONE mapping from `collection_events` rows onto
// the invoice engine's `EventCostRow`. Wired at merge (both halves now on one
// branch); typed against the real generated client. Null cost fields aggregate
// as 0 (partially-captured events still total cleanly); `mileage_cents` is the
// BILLED dollars (the informational `mileage` miles column never bills).
//
// Audit wave-1 P2 (money path): before the null→0 coalesce can silently zero a
// REAL event's B8/EVENTO + freight line, `assertEventCosted` refuses any event
// that has billable quantities (legs / labor or driver hours / overnight per-diem
// days / vehicle miles) but a null stored cost. Fail-loud, per event — never $0.

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import type { EventCostRow } from './types';
import { assertEventCosted } from './event-leg-guard';
import { dayKeyUTCFromISO } from '@/lib/time';

const decToNumber = (d: { toString(): string } | null): number | null => (d == null ? null : Number(d));

export async function fetchEventCostRows(
  siteId: string,
  windowStartISO: string,
  windowEndISO: string,
): Promise<EventCostRow[]> {
  const rows = await prisma.collectionEvent.findMany({
    where: {
      site_id: siteId,
      event_date: { gte: dayKeyUTCFromISO(windowStartISO), lte: dayKeyUTCFromISO(windowEndISO) },
    },
    orderBy: { event_date: 'asc' },
    select: {
      id: true,
      event_date: true,
      customer: true,
      retrac_id: true,
      freight_cents: true,
      driver_wages_cents: true,
      labor_wages_cents: true,
      mileage_cents: true,
      per_diem_cents: true,
      misc_cents: true,
      // Quantity signals for the uncosted-event guard (audit wave-1 P2).
      labor_hours: true,
      driver_hours: true,
      driver_onsite_hours: true,
      per_diem_days: true,
      overnight: true,
      mileage: true,
    },
  });
  log.debug(
    { op: 'invoice.events_leg', site_id: siteId, window: [windowStartISO, windowEndISO], rows: rows.length },
    '[invoices] events leg loaded',
  );
  // ADR-0056 leg/vehicle capture counts — the freight + IRS-mileage quantity signals
  // (bare-scalar FKs, no relation on the event; counted by event_id).
  const eventIds = rows.map((r) => r.id);
  const legCounts = new Map<string, number>();
  const vehicleCounts = new Map<string, number>();
  if (eventIds.length > 0) {
    const [legGroups, vehicleGroups] = await Promise.all([
      prisma.eventLeg.groupBy({ by: ['event_id'], where: { event_id: { in: eventIds } }, _count: { _all: true } }),
      prisma.eventVehicle.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds }, miles_driven: { gt: 0 } },
        _count: { _all: true },
      }),
    ]);
    for (const g of legGroups) legCounts.set(g.event_id, g._count._all);
    for (const g of vehicleGroups) vehicleCounts.set(g.event_id, g._count._all);
  }
  for (const r of rows) {
    assertEventCosted({
      id: r.id,
      eventDateISO: r.event_date.toISOString().slice(0, 10),
      customer: r.customer ?? null,
      legCount: legCounts.get(r.id) ?? 0,
      laborHours: decToNumber(r.labor_hours),
      driverHours: decToNumber(r.driver_onsite_hours) ?? decToNumber(r.driver_hours),
      perDiemDays: r.per_diem_days ?? null,
      overnight: r.overnight,
      vehicleCount: vehicleCounts.get(r.id) ?? 0,
      mileage: r.mileage ?? null,
      freightCents: r.freight_cents ?? null,
      laborWagesCents: r.labor_wages_cents ?? null,
      driverWagesCents: r.driver_wages_cents ?? null,
      perDiemCents: r.per_diem_cents ?? null,
      mileageCents: r.mileage_cents ?? null,
    });
  }
  return rows.map((r) => ({
    id: r.id,
    eventDateISO: r.event_date.toISOString().slice(0, 10),
    customer: r.customer ?? null,
    retracId: r.retrac_id ?? null,
    driverWagesCents: r.driver_wages_cents ?? 0,
    laborWagesCents: r.labor_wages_cents ?? 0,
    mileageCents: r.mileage_cents ?? 0,
    perDiemCents: r.per_diem_cents ?? 0,
    miscCents: r.misc_cents ?? 0,
    freightCents: r.freight_cents ?? 0,
  }));
}
