// ADR-0125 — assembling one manager screen: the day, its gaps, its close state,
// the honest on-hand figure, and the month-to-date rollup that replaces the
// workbook's Summary tabs.
//
// This module COMPOSES. It reads through `sections.ts` (the one row loader and
// the one summarizer), `day-close.ts` (the close state), the ADR-0110
// banner-aware floor tile, and the shared anchor selector. It computes no
// inventory arithmetic of its own — the moment it did, the EOD screen and the
// dashboard tile could print two different floors.
//
// SITE-SCOPED, EUGENE-READY. Nothing here names Woodland. The Terex section
// resolves its machine from the equipment registry, so Eugene — which has no
// machine — grades `not_applicable` rather than carrying a permanent warning.

import { resolveSiteThroughputMachine } from '@/lib/equipment/daily-throughput';
import { loadPriorAnchor } from '@/lib/inventory/anchor-guardrail';
import { resolveAnchorPair } from '@/lib/inventory/running-balance';
import {
  computeFloorInventoryTile,
  type FloorInventoryTileData,
} from '@/lib/dashboard/floor-inventory-tile';
import { endOfReportDay } from '@/lib/loads/eod-inventory';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { appToday, dayISO, dayKeyUTCFromISO, monthStartOfDayKey } from '@/lib/time';
import { getEodDayClose, type EodDayCloseView } from './day-close';
import {
  bucketRowsByDay,
  dayKeysBetween,
  loadWindowRows,
  missingSections,
  rollupFromDays,
  summarizeDay,
  type DaySectionRows,
  type DaySectionTotals,
  type FlaggedSection,
  type MonthRollup,
} from './sections';

/**
 * The workbook's `inventory check (should be zero)` cell (Phase 0 gap G-11),
 * given a home that can actually fire.
 *
 * ── Why it is NOT `total − (program + non_program)` off the running balance ──
 *
 * That is the sheet's arithmetic, and reproducing it here would be a detector
 * that can never report a negative: `computeRunningBalance` DEFINES
 * `total = program + nonProgram`, so the difference is identically zero by
 * construction. A green light wired to a tautology is worse than no light.
 *
 * The statement the sheet is actually making is that the counted floor and the
 * split entered against it agree. In Vision that is a property of the ANCHOR: a
 * `measured` physical count carries both pools, and they are supposed to sum to
 * the counted physical total. `reconcilePhysicalCount` validates that at write
 * time, so a fresh anchor cannot fail — but legacy rows, imported anchors and
 * anything written before that guard existed can, and those are exactly the rows
 * the whole floor is computed forward from.
 *
 * `unsplit_anchor` is reported as NOT APPLICABLE, not as zero: an unsplit
 * anchor's pools are an artifact (`resolveAnchorPair` attributes the whole count
 * to the program pool), so "the difference is 0" would be true and meaningless.
 */
export interface InventoryCheck {
  state: 'ok' | 'off' | 'not_applicable';
  /** Why the check could not run. Null when it did. */
  reason: 'no_anchor' | 'unsplit_anchor' | null;
  anchorDayISO: string | null;
  physicalTotal: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  /** physicalTotal − (program + non_program). Expected 0. */
  delta: number | null;
}

export interface EodDayReview {
  siteId: string;
  siteCode: string;
  siteName: string;
  /** `YYYY-MM-DD` — the Pacific calendar day under review. */
  dayKey: string;
  todayKey: string;
  isToday: boolean;
  /** A future day cannot be reviewed or closed. */
  isFuture: boolean;
  rows: DaySectionRows;
  totals: DaySectionTotals;
  missing: FlaggedSection[];
  close: EodDayCloseView | null;
  /** ADR-0110 banner contract — `negative: true` means render the banner, not the figure. */
  onHand: FloorInventoryTileData;
  inventoryCheck: InventoryCheck;
  rollup: MonthRollup;
}

/**
 * Assemble the whole screen for one (site, day).
 *
 * ONE window load covers both the day sections and the month rollup: the rows
 * are fetched once for month-start → the reviewed day, bucketed per day, and
 * summarized once. The day's section headers and the rollup are then the same
 * numbers by construction — the rollup literally folds the objects the sections
 * render (`rollupFromDays`), which is the G-1/ADR-0110 rule.
 */
export async function getEodDayReview(args: {
  siteId: string;
  siteCode: string;
  siteName: string;
  dayKey: Date;
  now?: Date;
}): Promise<EodDayReview> {
  const now = args.now ?? new Date();
  const todayKey = appToday(now);
  const isToday = args.dayKey.getTime() === todayKey.getTime();
  const isFuture = args.dayKey.getTime() > todayKey.getTime();

  // The rollup runs month-start → the reviewed day. A future day would ask for a
  // window ending before it starts; clamp to the day itself so the fold is empty
  // rather than inverted, and let the caller refuse the day on `isFuture`.
  const monthStart = monthStartOfDayKey(args.dayKey);
  const windowEnd = args.dayKey;

  const machine = await resolveSiteThroughputMachine(args.siteId);

  const [rows, close, anchor] = await Promise.all([
    loadWindowRows(args.siteId, monthStart, windowEnd, { terexMachineId: machine?.id ?? null }),
    getEodDayClose(args.siteId, args.dayKey),
    loadPriorAnchor(prisma, args.siteId),
  ]);

  const dayKeys = dayKeysBetween(monthStart, windowEnd);
  const buckets = bucketRowsByDay(rows, dayKeys);
  const perDay = buckets.map(summarizeDay);
  const dayISOKey = dayISO(args.dayKey);
  const idx = dayKeys.indexOf(dayISOKey);
  const dayRows = buckets[idx] as DaySectionRows;
  const totals = perDay[idx] as DaySectionTotals;

  // On-hand AS OF the reviewed day. Today reads live; a past day reads the same
  // end-of-day bound `eod-inventory.ts` uses, so the two surfaces cannot report
  // different floors for the same historical day.
  const asOf = isToday ? now : endOfReportDay(args.dayKey);
  const onHand = await computeFloorInventoryTile(args.siteId, { now: asOf });

  return {
    siteId: args.siteId,
    siteCode: args.siteCode,
    siteName: args.siteName,
    dayKey: dayISOKey,
    todayKey: dayISO(todayKey),
    isToday,
    isFuture,
    rows: dayRows,
    totals,
    missing: missingSections(totals),
    close,
    onHand,
    inventoryCheck: inventoryCheckFromAnchor(anchor),
    rollup: rollupFromDays(perDay),
  };
}

/** Pure — the anchor consistency check described on {@link InventoryCheck}. */
export function inventoryCheckFromAnchor(
  anchor: {
    total: number;
    programUnits: number | null;
    nonProgramUnits: number | null;
    snapshotAt: Date;
    poolAttribution: string | null;
  } | null,
): InventoryCheck {
  const none: InventoryCheck = {
    state: 'not_applicable',
    reason: 'no_anchor',
    anchorDayISO: null,
    physicalTotal: null,
    programUnits: null,
    nonProgramUnits: null,
    delta: null,
  };
  if (!anchor) return none;

  // The `measured` determination comes from the SHARED resolver, not from a
  // second copy of its predicate here — `resolveAnchorPair` is documented as the
  // single source of truth for how an anchor's pools are derived, and a check
  // that graded an anchor differently from the balance would be checking a
  // different anchor than the floor is computed from.
  const { pool } = resolveAnchorPair({
    units_indoor: null,
    units_total: anchor.total,
    units_in_processing: 0,
    program_units: anchor.programUnits === null ? null : new Prisma.Decimal(anchor.programUnits),
    non_program_units:
      anchor.nonProgramUnits === null ? null : new Prisma.Decimal(anchor.nonProgramUnits),
    pool_attribution: anchor.poolAttribution,
  });
  const anchorDayISO = dayISO(dayKeyUTCFromISO(dayISO(anchor.snapshotAt)));
  if (pool !== 'measured') {
    return { ...none, reason: 'unsplit_anchor', anchorDayISO };
  }
  const program = anchor.programUnits ?? 0;
  const nonProgram = anchor.nonProgramUnits ?? 0;
  const delta = anchor.total - (program + nonProgram);
  return {
    state: delta === 0 ? 'ok' : 'off',
    reason: null,
    anchorDayISO,
    physicalTotal: anchor.total,
    programUnits: program,
    nonProgramUnits: nonProgram,
    delta,
  };
}
