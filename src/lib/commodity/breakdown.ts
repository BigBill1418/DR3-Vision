// ADR-0041 amendment (rollup §5.1/§11) — the monthly COMMODITY BREAKDOWN model.
//
// The companion document Rick confirmed rides the EOM invoice (§5.1). §11 derived
// an 11-BLOCK taxonomy from the real 2025 Stockton production workbook: one block
// per commodity, per-transaction rows within each block, a per-block total, a
// facility header once per block, laid out landscape.
//
// SCHEMA-REALITY DIVERGENCE (documented, adapted — the spec speaks idealized):
//   • §11's block names (Landfill / Steel / Xtraction Landfill / Covanta WTE / …)
//     do NOT match the REAL `OutboundCommodity` enum, which is the daily-log-9 the
//     office actually captures: trash, toppers, foam, metal, wood, cardboard,
//     plastic, shoddy, cotton (schema comment: the daily-log-9 → billing-workbook-11
//     mapping is destination-driven and OPEN pending Kelsey/Janette; NOT built).
//   • The steel split into "Steel" (recycled) vs "Xtraction Landfill" (the 19%
//     landfill fraction) vs "Covanta WTE" is a VENDOR/destination split of the
//     single `metal` commodity — the recycled/landfilled lbs already live on the
//     row (ADR-0055 `recycled_lbs` / `landfilled_lbs` / `recycling_percent_applied`),
//     but the exact MRC block boundary (separate Xtraction-Landfill block? Covanta
//     WTE %?) is PENDING Rick (email 2026-07-20 — §11/§17 soft blocker).
//   • `outbound_materials` has no `slip_number` (only `unit_status_movements` does),
//     so §11's Landfill "Slip #" column renders from what exists (ticket/retrac).
//
// This module therefore renders the AVAILABLE taxonomy faithfully: the daily-log
// commodity blocks (with recycler + recovery-% shown where the row carries them)
// plus the whole-unit "Landfilled Units" block from the status ledger. It is
// TAXONOMY-DRIVEN (a declared block list) so, when Rick's classification lands,
// the metal→Steel/Xtraction/WTE split is a data change to `BLOCK_TAXONOMY`, not a
// renderer rewrite. Pure: the builder takes already-fetched typed rows.

/** One outbound-material transaction (decoupled from Prisma; §11 commodity blocks). */
export interface OutboundBreakdownRow {
  shipDateISO: string; // YYYY-MM-DD
  commodity: string; // OutboundCommodity value
  weightLbs: number;
  ticketNumber: string | null;
  retracId: string | null;
  recyclerName: string | null; // vendor/buyer, when known
  recyclingPercentApplied: number | null; // 0..1 snapshot, when a rate resolved
  recycledLbs: number | null;
  landfilledLbs: number | null;
}

/** One whole-unit landfill movement (§11 block 11 — Landfilled Units). */
export interface LandfilledUnitRow {
  movementDateISO: string; // YYYY-MM-DD
  reason: string; // LandfilledReason value (bed_bug|soiled|water_logged|other)
  units: number;
  slipNumber: string | null;
  retracId: string | null;
}

export interface CommodityBreakdownInput {
  siteName: string;
  /** Human period label, e.g. "June 2026" (the EOM billing month). */
  periodLabel: string;
  facilityLabel: string; // §11 "Facility label at row 6" — repeated per block
  outbound: readonly OutboundBreakdownRow[];
  landfilledUnits: readonly LandfilledUnitRow[];
}

/** A rendered block: a title, its facility header, columns, rows, and totals. */
export interface CommodityBlockModel {
  key: string;
  title: string;
  facilityLabel: string;
  columns: string[];
  /** Per-transaction rows; each cell already string-formatted for the renderer. */
  rows: string[][];
  /** Per-block totals shown at the bottom (label → formatted value). */
  totals: { label: string; value: string }[];
  /** True when this block has no rows for the period (renders "no activity"). */
  empty: boolean;
}

export interface CommodityBreakdownModel {
  siteName: string;
  periodLabel: string;
  blocks: CommodityBlockModel[];
  /** Whether ANY block has activity (a fully-empty breakdown is flagged, never silent). */
  hasActivity: boolean;
}

/**
 * The §11 block taxonomy, mapped to the REAL daily-log-9 commodities. `vendorPct`
 * blocks (metal/wood — the recovery-rate-bearing commodities per ADR-0055) show
 * the recycler + recovery-% columns; the rest show the plain weight columns. The
 * `metal` block is titled "Steel (metal)" — a single block for now; the
 * Xtraction-Landfill/Covanta-WTE sub-split is the PENDING-Rick classification
 * (§11) and slots in here as additional entries when it lands.
 */
interface BlockDef {
  key: string;
  title: string;
  commodity: string;
  vendorPct: boolean;
}

export const BLOCK_TAXONOMY: readonly BlockDef[] = [
  { key: 'trash', title: 'Landfill (trash)', commodity: 'trash', vendorPct: false },
  { key: 'metal', title: 'Steel (metal)', commodity: 'metal', vendorPct: true },
  { key: 'wood', title: 'Wood', commodity: 'wood', vendorPct: true },
  { key: 'toppers', title: 'Toppers', commodity: 'toppers', vendorPct: false },
  { key: 'foam', title: 'Foam', commodity: 'foam', vendorPct: false },
  { key: 'cardboard', title: 'Cardboard', commodity: 'cardboard', vendorPct: false },
  { key: 'plastic', title: 'Plastic', commodity: 'plastic', vendorPct: false },
  { key: 'shoddy', title: 'Shoddy', commodity: 'shoddy', vendorPct: false },
  { key: 'cotton', title: 'Cotton', commodity: 'cotton', vendorPct: false },
] as const;

const LANDFILLED_REASON_LABEL: Record<string, string> = {
  bed_bug: 'Bed Bug',
  soiled: 'Soiled',
  water_logged: 'Wet', // §11: "wet" == water_logged
  other: 'Other',
};

function fmtLbs(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} lb`;
}

function fmtPct(fraction: number | null): string {
  return fraction == null ? '—' : `${(fraction * 100).toFixed(2)}%`;
}

function dash(s: string | null): string {
  return s && s.trim() ? s : '—';
}

/** Build one commodity block from the rows whose commodity matches. Pure. */
function buildCommodityBlock(def: BlockDef, rows: readonly OutboundBreakdownRow[], facility: string): CommodityBlockModel {
  const mine = rows.filter((r) => r.commodity === def.commodity);
  const columns = def.vendorPct
    ? ['Date', 'Recycler', 'Recovery %', 'Lbs', 'Recycled Lbs', 'Ticket #', 'Retrac ID']
    : ['Date', 'Lbs', 'Ticket #', 'Retrac ID'];
  const body = mine.map((r) =>
    def.vendorPct
      ? [
          r.shipDateISO,
          dash(r.recyclerName),
          fmtPct(r.recyclingPercentApplied),
          fmtLbs(r.weightLbs),
          r.recycledLbs == null ? '—' : fmtLbs(r.recycledLbs),
          dash(r.ticketNumber),
          dash(r.retracId),
        ]
      : [r.shipDateISO, fmtLbs(r.weightLbs), dash(r.ticketNumber), dash(r.retracId)],
  );
  const totalLbs = mine.reduce((acc, r) => acc + r.weightLbs, 0);
  const totalRecycled = mine.reduce((acc, r) => acc + (r.recycledLbs ?? 0), 0);
  const totals: { label: string; value: string }[] = [
    { label: 'Total Lbs', value: fmtLbs(totalLbs) },
  ];
  if (def.vendorPct) totals.push({ label: 'Total Recycled Lbs', value: fmtLbs(totalRecycled) });
  return { key: def.key, title: def.title, facilityLabel: facility, columns, rows: body, totals, empty: mine.length === 0 };
}

/** Build the §11 block 11 — whole-unit Landfilled Units by reason. Pure. */
function buildLandfilledUnitsBlock(rows: readonly LandfilledUnitRow[], facility: string): CommodityBlockModel {
  const columns = ['Date', 'Reason', 'Units', 'Slip #', 'Retrac ID'];
  const body = rows.map((r) => [
    r.movementDateISO,
    LANDFILLED_REASON_LABEL[r.reason] ?? r.reason,
    String(r.units),
    dash(r.slipNumber),
    dash(r.retracId),
  ]);
  const totalUnits = rows.reduce((acc, r) => acc + r.units, 0);
  return {
    key: 'landfilled_units',
    title: 'Landfilled Units (Bed Bug / Soiled / Wet)',
    facilityLabel: facility,
    columns,
    rows: body,
    totals: [{ label: 'Total Units', value: String(totalUnits) }],
    empty: rows.length === 0,
  };
}

/**
 * Build the full commodity-breakdown model for a period. Renders every taxonomy
 * block (empty blocks included — §11 wants the block present with a "no activity"
 * marker, never silently dropped) plus the Landfilled Units block. Pure.
 */
export function buildCommodityBreakdown(input: CommodityBreakdownInput): CommodityBreakdownModel {
  const blocks = BLOCK_TAXONOMY.map((def) =>
    buildCommodityBlock(def, input.outbound, input.facilityLabel),
  );
  blocks.push(buildLandfilledUnitsBlock(input.landfilledUnits, input.facilityLabel));
  return {
    siteName: input.siteName,
    periodLabel: input.periodLabel,
    blocks,
    hasActivity: blocks.some((b) => !b.empty),
  };
}
