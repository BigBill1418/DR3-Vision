// ADR-0037 D4 (Addendum B1) — outbound_materials manager service (CRUD-lite).
//
// Outbound is two axes: commodity × sub-category.
//   - `renovation` rows are WHOLE-UNIT sales (the old renovator channel, folded in
//     here). They carry `whole_units` + a program/non-program split
//     (`program_units + non_program_units == whole_units` when whole_units is set)
//     and feed the running balance's WholeUnitsSold term. This is the
//     recovery-rate-workable shape (whole units + pool split, per MRC rules).
//   - `baled` / `shredded` rows are weight-based commodity SALES: `whole_units` and
//     both split columns are absent (null); only `weight_lbs` is meaningful. They
//     NEVER subtract from the inventory running balance (post-deconstruction
//     commodities; deconstruction is what `processed` already counts).
//
// Avg-per-bale is DERIVED at read time (`weight_lbs / bale_count`), never stored.
// `allocation_pct` is a nullable placeholder (semantics pending Kelsey).

import { Prisma, type OutboundCommodity, type OutboundSubCategory } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { RecordValidationError, RecordNotFoundError, assertUnlocked } from '@/lib/loads/record-guards';
import { deriveOutboundRecycling, type OutboundRecyclingResult } from '@/lib/loads/recycling-rates';

const TABLE = 'outbound_materials';

function shipDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function assertWeight(lbs: number): void {
  if (!Number.isInteger(lbs) || lbs < 0 || lbs > 10000000) {
    throw new RecordValidationError(`weight_lbs must be a whole number in [0, 10000000] (got ${String(lbs)})`);
  }
}

function assertUnit(name: string, n: number, min = 0): void {
  if (!Number.isInteger(n) || n < min || n > 100000) {
    throw new RecordValidationError(`${name} must be a whole number in [${min}, 100000] (got ${String(n)})`);
  }
}

/** The renovation whole-unit + split shape, resolved for validation and persistence. */
interface RenovationShape {
  wholeUnits: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
}

/**
 * Enforce the commodity × sub-category shape (Addendum B1):
 *   - `renovation` + whole_units present → program/non-program required and must
 *     sum to whole_units; renovation with all three null is allowed (unknown split).
 *   - `baled` / `shredded` → whole_units and BOTH split columns must be absent.
 * Pure; returns the normalized shape to persist.
 */
export function assertOutboundShape(
  subCategory: OutboundSubCategory,
  wholeUnits: number | null | undefined,
  programUnits: number | null | undefined,
  nonProgramUnits: number | null | undefined,
): RenovationShape {
  const whole = wholeUnits ?? null;
  const program = programUnits ?? null;
  const nonProgram = nonProgramUnits ?? null;

  if (subCategory !== 'renovation') {
    if (whole != null || program != null || nonProgram != null) {
      throw new RecordValidationError(
        `${subCategory} is a weight-based commodity sale — whole_units / program_units / non_program_units must be absent`,
      );
    }
    return { wholeUnits: null, programUnits: null, nonProgramUnits: null };
  }

  // renovation
  if (whole == null) {
    if (program != null || nonProgram != null) {
      throw new RecordValidationError('renovation split requires whole_units when program/non-program units are given');
    }
    return { wholeUnits: null, programUnits: null, nonProgramUnits: null };
  }
  assertUnit('whole_units', whole, 1);
  const program0 = program ?? 0;
  const nonProgram0 = nonProgram ?? 0;
  assertUnit('program_units', program0);
  assertUnit('non_program_units', nonProgram0);
  if (program0 + nonProgram0 !== whole) {
    throw new RecordValidationError(
      `program_units (${program0}) + non_program_units (${nonProgram0}) must equal whole_units (${whole})`,
    );
  }
  return { wholeUnits: whole, programUnits: program0, nonProgramUnits: nonProgram0 };
}

export interface OutboundView {
  id: string;
  siteId: string;
  shipDate: Date;
  commodity: OutboundCommodity;
  subCategory: OutboundSubCategory;
  weightLbs: number;
  wholeUnits: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  ticketNumber: string | null;
  retracId: string | null;
  baleCount: number | null;
  allocationPct: string | null;
  buyer: string | null;
  // ADR-0055 — structured recycler + DERIVED CalRecycle stewardship split (O-7).
  // `recycledLbs`/`landfilledLbs` are null when no rate covered (vendor, commodity,
  // ship_date) — the no-rate flag the UI surfaces. Invariant when present:
  // recycledLbs + landfilledLbs === weightLbs.
  vendorId: string | null;
  recycledLbs: number | null;
  landfilledLbs: number | null;
  /** Decimal(5,4) snapshot of the fraction applied, e.g. "0.8100"; null when not derived. */
  recyclingPercentApplied: string | null;
  /** Derived: weight_lbs / bale_count, or null when no bales. Never stored. */
  avgLbsPerBale: string | null;
  source: string;
  lockedAt: Date | null;
}

function toView(r: {
  id: string;
  site_id: string;
  ship_date: Date;
  commodity: OutboundCommodity;
  sub_category: OutboundSubCategory;
  weight_lbs: number;
  whole_units: number | null;
  program_units: number | null;
  non_program_units: number | null;
  ticket_number: string | null;
  retrac_id: string | null;
  bale_count: number | null;
  allocation_pct: Prisma.Decimal | null;
  buyer: string | null;
  vendor_id: string | null;
  recycled_lbs: number | null;
  landfilled_lbs: number | null;
  recycling_percent_applied: Prisma.Decimal | null;
  source: string;
  locked_at: Date | null;
}): OutboundView {
  const avg =
    r.bale_count && r.bale_count > 0
      ? new Prisma.Decimal(r.weight_lbs).dividedBy(r.bale_count).toDecimalPlaces(1).toString()
      : null;
  return {
    id: r.id,
    siteId: r.site_id,
    shipDate: r.ship_date,
    commodity: r.commodity,
    subCategory: r.sub_category,
    weightLbs: r.weight_lbs,
    wholeUnits: r.whole_units,
    programUnits: r.program_units,
    nonProgramUnits: r.non_program_units,
    ticketNumber: r.ticket_number,
    retracId: r.retrac_id,
    baleCount: r.bale_count,
    allocationPct: r.allocation_pct?.toString() ?? null,
    buyer: r.buyer,
    vendorId: r.vendor_id,
    recycledLbs: r.recycled_lbs,
    landfilledLbs: r.landfilled_lbs,
    recyclingPercentApplied: r.recycling_percent_applied?.toFixed(4) ?? null,
    avgLbsPerBale: avg,
    source: r.source,
    lockedAt: r.locked_at,
  };
}

/**
 * Map an {@link OutboundRecyclingResult} to the persistable derived-field columns.
 * `no_vendor` / `no_rate` both clear the fields to null — a missing rate is never
 * silently assumed to be 100% recycled (ADR-0055 no-rate policy).
 */
function derivedColumns(d: OutboundRecyclingResult): {
  recycled_lbs: number | null;
  landfilled_lbs: number | null;
  recycling_percent_applied: string | null;
  recycling_rate_id: string | null;
} {
  if (d.status === 'derived') {
    return {
      recycled_lbs: d.recycledLbs,
      landfilled_lbs: d.landfilledLbs,
      recycling_percent_applied: d.recyclingPercent,
      recycling_rate_id: d.rateId,
    };
  }
  return {
    recycled_lbs: null,
    landfilled_lbs: null,
    recycling_percent_applied: null,
    recycling_rate_id: null,
  };
}

export async function createOutbound(args: {
  siteId: string;
  shipDate: Date;
  commodity: OutboundCommodity;
  subCategory: OutboundSubCategory;
  weightLbs: number;
  wholeUnits?: number | null;
  programUnits?: number | null;
  nonProgramUnits?: number | null;
  ticketNumber?: string | null;
  retracId?: string | null;
  baleCount?: number | null;
  buyer?: string | null;
  vendorId?: string | null;
  actorUserId: string;
}): Promise<OutboundView> {
  assertWeight(args.weightLbs);
  if (args.baleCount != null && (!Number.isInteger(args.baleCount) || args.baleCount < 0)) {
    throw new RecordValidationError('bale_count must be a non-negative whole number');
  }
  const shape = assertOutboundShape(args.subCategory, args.wholeUnits, args.programUnits, args.nonProgramUnits);
  const day = shipDateUTC(args.shipDate);
  // ADR-0055 — derive the CalRecycle stewardship split at ENTRY TIME from
  // (vendor_id, commodity, ship_date). Resolved (a read) before the write tx; the
  // percent is snapshotted so the row is reproducible even if the rate later changes.
  const vendorId = args.vendorId ?? null;
  const derived = derivedColumns(
    await deriveOutboundRecycling({ vendorId, commodity: args.commodity, shipDate: day, weightLbs: args.weightLbs }),
  );
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.outboundMaterial.create({
      data: {
        site_id: args.siteId,
        ship_date: day,
        commodity: args.commodity,
        sub_category: args.subCategory,
        weight_lbs: args.weightLbs,
        whole_units: shape.wholeUnits,
        program_units: shape.programUnits,
        non_program_units: shape.nonProgramUnits,
        ticket_number: args.ticketNumber ?? null,
        retrac_id: args.retracId ?? null,
        bale_count: args.baleCount ?? null,
        buyer: args.buyer ?? null,
        vendor_id: vendorId,
        recycled_lbs: derived.recycled_lbs,
        landfilled_lbs: derived.landfilled_lbs,
        recycling_percent_applied: derived.recycling_percent_applied,
        recycling_rate_id: derived.recycling_rate_id,
        source: 'manual',
        created_by: args.actorUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'insert',
        table_name: TABLE,
        row_id: created.id,
        after: {
          ship_date: day.toISOString().slice(0, 10),
          commodity: args.commodity,
          sub_category: args.subCategory,
          weight_lbs: args.weightLbs,
          whole_units: shape.wholeUnits,
        },
      },
    });
    return created;
  });
  return toView(row);
}

export async function updateOutbound(args: {
  id: string;
  siteId: string;
  // `| undefined` explicit (exactOptionalPropertyTypes; callers spread zod output).
  subCategory?: OutboundSubCategory | undefined;
  weightLbs?: number | undefined;
  wholeUnits?: number | null | undefined;
  programUnits?: number | null | undefined;
  nonProgramUnits?: number | null | undefined;
  ticketNumber?: string | null | undefined;
  retracId?: string | null | undefined;
  baleCount?: number | null | undefined;
  buyer?: string | null | undefined;
  vendorId?: string | null | undefined;
  actorUserId: string;
}): Promise<OutboundView> {
  const existing = await prisma.outboundMaterial.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);
  assertUnlocked(TABLE, args.id, existing.locked_at);
  if (args.weightLbs !== undefined) assertWeight(args.weightLbs);

  const subCategory = args.subCategory ?? existing.sub_category;
  const wholeUnits = args.wholeUnits !== undefined ? args.wholeUnits : existing.whole_units;
  const programUnits = args.programUnits !== undefined ? args.programUnits : existing.program_units;
  const nonProgramUnits = args.nonProgramUnits !== undefined ? args.nonProgramUnits : existing.non_program_units;
  const shape = assertOutboundShape(subCategory, wholeUnits, programUnits, nonProgramUnits);

  // ADR-0055 — re-derive the stewardship split whenever the vendor or weight changes
  // (commodity + ship_date are immutable post-create). Always overwrites the derived
  // columns from the CURRENT effective values so they never drift from the row.
  const vendorId = args.vendorId !== undefined ? args.vendorId : existing.vendor_id;
  const weightLbs = args.weightLbs !== undefined ? args.weightLbs : existing.weight_lbs;
  const derived = derivedColumns(
    await deriveOutboundRecycling({
      vendorId,
      commodity: existing.commodity,
      shipDate: existing.ship_date,
      weightLbs,
    }),
  );

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.outboundMaterial.update({
      where: { id: args.id },
      data: {
        sub_category: subCategory,
        whole_units: shape.wholeUnits,
        program_units: shape.programUnits,
        non_program_units: shape.nonProgramUnits,
        ...(args.weightLbs !== undefined ? { weight_lbs: args.weightLbs } : {}),
        ...(args.ticketNumber !== undefined ? { ticket_number: args.ticketNumber } : {}),
        ...(args.retracId !== undefined ? { retrac_id: args.retracId } : {}),
        ...(args.baleCount !== undefined ? { bale_count: args.baleCount } : {}),
        ...(args.buyer !== undefined ? { buyer: args.buyer } : {}),
        vendor_id: vendorId,
        recycled_lbs: derived.recycled_lbs,
        landfilled_lbs: derived.landfilled_lbs,
        recycling_percent_applied: derived.recycling_percent_applied,
        recycling_rate_id: derived.recycling_rate_id,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before: { weight_lbs: existing.weight_lbs, whole_units: existing.whole_units },
        after: { weight_lbs: updated.weight_lbs, whole_units: updated.whole_units },
      },
    });
    return updated;
  });
  return toView(row);
}

export async function listOutbound(siteId: string, limit = 100): Promise<OutboundView[]> {
  const rows = await prisma.outboundMaterial.findMany({
    where: { site_id: siteId },
    orderBy: { ship_date: 'desc' },
    take: limit,
  });
  return rows.map(toView);
}
