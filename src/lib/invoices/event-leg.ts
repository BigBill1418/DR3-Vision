// ADR-0041 B8 events leg — the ONE mapping from `collection_events` rows onto
// the invoice engine's `EventCostRow`. Wired at merge (both halves now on one
// branch); typed against the real generated client. Null cost fields aggregate
// as 0 (partially-captured events still total cleanly); `mileage_cents` is the
// BILLED dollars (the informational `mileage` miles column never bills).

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import type { EventCostRow } from './types';
import { dayKeyUTCFromISO } from '@/lib/time';

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
    },
  });
  log.debug(
    { op: 'invoice.events_leg', site_id: siteId, window: [windowStartISO, windowEndISO], rows: rows.length },
    '[invoices] events leg loaded',
  );
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
