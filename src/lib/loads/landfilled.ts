// ADR-0037 D4/D6 — landfilled_units manager service (CRUD-lite).
//
// Whole-unit disposal (workbook Landfilled Units block). `units` subtract from the
// inventory running balance (D6). Pool split (survey amendment, 2026-07-03):
// `program_units + non_program_units == units`.

import { type LandfilledReason } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { RecordValidationError, RecordNotFoundError, assertUnlocked } from '@/lib/loads/record-guards';

const TABLE = 'landfilled_units';

function disposalDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function assertWhole(name: string, n: number, min = 0): void {
  if (!Number.isInteger(n) || n < min || n > 100000) {
    throw new RecordValidationError(`${name} must be a whole number in [${min}, 100000] (got ${String(n)})`);
  }
}

function assertSplit(units: number, programUnits: number, nonProgramUnits: number): void {
  assertWhole('units', units, 1);
  assertWhole('program_units', programUnits);
  assertWhole('non_program_units', nonProgramUnits);
  if (programUnits + nonProgramUnits !== units) {
    throw new RecordValidationError(
      `program_units (${programUnits}) + non_program_units (${nonProgramUnits}) must equal units (${units})`,
    );
  }
}

export interface LandfilledView {
  id: string;
  siteId: string;
  disposalDate: Date;
  units: number;
  programUnits: number;
  nonProgramUnits: number;
  slipNumber: string | null;
  reason: LandfilledReason;
  source: string;
  lockedAt: Date | null;
}

function toView(r: {
  id: string;
  site_id: string;
  disposal_date: Date;
  units: number;
  program_units: number;
  non_program_units: number;
  slip_number: string | null;
  reason: LandfilledReason;
  source: string;
  locked_at: Date | null;
}): LandfilledView {
  return {
    id: r.id,
    siteId: r.site_id,
    disposalDate: r.disposal_date,
    units: r.units,
    programUnits: r.program_units,
    nonProgramUnits: r.non_program_units,
    slipNumber: r.slip_number,
    reason: r.reason,
    source: r.source,
    lockedAt: r.locked_at,
  };
}

export async function createLandfilledUnit(args: {
  siteId: string;
  disposalDate: Date;
  units: number;
  programUnits: number;
  nonProgramUnits: number;
  reason: LandfilledReason;
  slipNumber?: string | null;
  actorUserId: string;
}): Promise<LandfilledView> {
  assertSplit(args.units, args.programUnits, args.nonProgramUnits);
  const day = disposalDateUTC(args.disposalDate);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.landfilledUnit.create({
      data: {
        site_id: args.siteId,
        disposal_date: day,
        units: args.units,
        program_units: args.programUnits,
        non_program_units: args.nonProgramUnits,
        reason: args.reason,
        slip_number: args.slipNumber ?? null,
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
        after: { disposal_date: day.toISOString().slice(0, 10), units: args.units, reason: args.reason },
      },
    });
    return created;
  });
  return toView(row);
}

export async function updateLandfilledUnit(args: {
  id: string;
  siteId: string;
  // `| undefined` explicit (exactOptionalPropertyTypes; callers spread zod output).
  units?: number | undefined;
  programUnits?: number | undefined;
  nonProgramUnits?: number | undefined;
  reason?: LandfilledReason | undefined;
  slipNumber?: string | null | undefined;
  actorUserId: string;
}): Promise<LandfilledView> {
  const existing = await prisma.landfilledUnit.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);
  assertUnlocked(TABLE, args.id, existing.locked_at);

  const units = args.units ?? existing.units;
  const programUnits = args.programUnits ?? existing.program_units;
  const nonProgramUnits = args.nonProgramUnits ?? existing.non_program_units;
  assertSplit(units, programUnits, nonProgramUnits);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.landfilledUnit.update({
      where: { id: args.id },
      data: {
        units,
        program_units: programUnits,
        non_program_units: nonProgramUnits,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args.slipNumber !== undefined ? { slip_number: args.slipNumber } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before: { units: existing.units },
        after: { units },
      },
    });
    return updated;
  });
  return toView(row);
}

export async function listLandfilledUnits(siteId: string, limit = 100): Promise<LandfilledView[]> {
  const rows = await prisma.landfilledUnit.findMany({
    where: { site_id: siteId },
    orderBy: { disposal_date: 'desc' },
    take: limit,
  });
  return rows.map(toView);
}
