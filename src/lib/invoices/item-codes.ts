// ADR-0041 amendment (rollup §9) — the LOCKED Great-Plains item-code taxonomy.
//
// The 7 GP "Item" codes were confirmed VERBATIM from the real June-2026 invoice
// PDFs (rollup §9/§10). They are the codes Mary types into the GP Item column,
// so the strings here are the source of truth and must match GP EXACTLY —
// including the embedded spaces in `MILES 0` and `OREGON MATTRESS` (a stray
// `MILES0` or `OREGONMATTRESS` would not resolve in GP).
//
// These supersede the earlier PR-#128 assumption (empty `item` on every line —
// see the pre-rollup export-json comment): the real PDFs carry explicit codes.
//
// The codes map to the pure §3.1 workbook LINE codes (`LINE_CODE` in types.ts):
//   LOCATION         — the $0 section header/spacer (no workbook leaf; presentation only)
//   UNITSMO          — the processed-units charge (B6 / B20)
//   REIMBO           — consumer drop-off reimbursement / incentive (B7) · CA only
//   EVENTO           — event labor aggregate (B8) · CA only
//   MILES 0          — freight + event-transport + rental AGGREGATE (§9) · both jurisdictions
//   FUEL             — fuel surcharge · CA only (OR emits no fuel line by construction)
//   OREGON MATTRESS  — collection-site per-mattress ($2.25) · OR collections
//
// `MILES 0` is the aggregation rule made concrete (§9): three workbook leaves
// (`B16.freight`, `B16.event_freight`, `B16.rentals`) collapse into ONE GP line.
// Only `B16.fuel` keeps its own line (`FUEL`). The composer still stores the
// three leaves separately (full provenance); the aggregation is a GP-presentation
// concern applied at export time — see export-json.ts.

import { LINE_CODE } from './types';

/** The 7 locked GP item codes, verbatim (rollup §9). Spaces are significant. */
export const GP_ITEM_CODE = {
  location: 'LOCATION',
  unitsMo: 'UNITSMO',
  reimbo: 'REIMBO',
  evento: 'EVENTO',
  miles0: 'MILES 0',
  fuel: 'FUEL',
  oregonMattress: 'OREGON MATTRESS',
} as const;

export type GpItemCode = (typeof GP_ITEM_CODE)[keyof typeof GP_ITEM_CODE];

/**
 * The workbook line codes that the `MILES 0` GP line AGGREGATES into one row
 * (§9): regular freight + event transportation + container rental. `B16.fuel` is
 * DELIBERATELY excluded — fuel is the one transport component that keeps its own
 * GP line (`FUEL`).
 */
export const MILES_0_MEMBER_CODES: readonly string[] = [
  LINE_CODE.freight,
  LINE_CODE.eventFreight,
  LINE_CODE.rentals,
] as const;

/**
 * The GP item code for a stored workbook leaf line, or `null` when the leaf does
 * not map to a standalone GP line (e.g. the B22 trade-discount offset, which GP
 * renders as the Trade-discount TOTAL field, not an item line). Pure lookup.
 */
export function itemCodeForLineCode(lineCode: string): GpItemCode | null {
  switch (lineCode) {
    case LINE_CODE.processing:
    case LINE_CODE.midMonthProcessing:
      return GP_ITEM_CODE.unitsMo;
    case LINE_CODE.incentives:
      return GP_ITEM_CODE.reimbo;
    case LINE_CODE.eventMisc:
      return GP_ITEM_CODE.evento;
    case LINE_CODE.freight:
    case LINE_CODE.eventFreight:
    case LINE_CODE.rentals:
      return GP_ITEM_CODE.miles0;
    case LINE_CODE.fuel:
      return GP_ITEM_CODE.fuel;
    case LINE_CODE.satellite:
      return GP_ITEM_CODE.oregonMattress;
    default:
      return null; // B22.offset, manual, etc. — no standalone GP item line
  }
}
