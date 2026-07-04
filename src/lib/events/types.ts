// ADR-0041 (capture half) — the cross-agent contract types for collection events.
//
// `EventCostRow` is the SHAPE the sibling invoice engine's §3.1 B8 consumer codes
// against — do NOT rename it or drop fields without coordinating. It carries every
// money term B8 needs (freight is billed as its own term; the wage/mileage/per-diem/
// misc cents are the event's ancillary cost, aggregated by `eventMiscCents`), plus
// the `event_date` + `site_id` the invoice window filters on.

/**
 * The billing-relevant projection of a `collection_events` row — the exact shape
 * the sibling invoice B8 consumer reads. All money is integer cents; a null field
 * means "not captured" and aggregates as 0 (see {@link eventMiscCents}).
 */
export interface EventCostRow {
  id: string;
  siteId: string;
  eventDate: Date;
  /** Load-level freight charge for the event (CA). Rides the B16 TRANSPORTATION invoice (never B8; never folded into misc). */
  freightCents: number | null;
  driverWagesCents: number | null;
  laborWagesCents: number | null;
  /** Billed mileage dollars (NOT the informational `mileage` miles). Feeds B8 as money. */
  mileageCents: number | null;
  perDiemCents: number | null;
  miscCents: number | null;
}

/**
 * The §3.1 B8 event ancillary-cost total, in integer cents:
 *   driver wages + labor wages + mileage + per diem + misc.
 *
 * Freight is DELIBERATELY excluded — the workbook B8 formula lists exactly these
 * five terms, and freight is billed as its own line/term (`freightCents`). Nulls
 * count as 0 so a partially-captured event still totals cleanly. Pure.
 */
export function eventMiscCents(row: EventCostRow): number {
  return (
    (row.driverWagesCents ?? 0) +
    (row.laborWagesCents ?? 0) +
    (row.mileageCents ?? 0) +
    (row.perDiemCents ?? 0) +
    (row.miscCents ?? 0)
  );
}
