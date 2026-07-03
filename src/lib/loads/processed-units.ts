// ADR-0037 D5 (Addendum B4) — processed_units_daily service (the daily close).
//
// One row per site per day. Entry is office-desktop, SUPER-ADMIN gated (the
// route/page enforces `is_super_admin`; this layer trusts the actor). Closing a
// day stamps `closed_at` and writes an audit row. Post-close corrections are
// BLOCKED here (a typed error directing to the amendment path) — never in-place
// edits, mirroring the bonus system's ADR-0028 discipline.
//
// The STRIPPED program split IS the billing basis (Addendum B4): billing (P2) reads
// `stripped_program` only. `saved_units` is captured but EXCLUDED from inventory
// math (semantics open, Addendum B10-2). Whole-units-sold + landfilled for the day
// are DERIVED (from renovation outbound rows + landfilled_units) and DISPLAYED at
// close for confirmation — never entered twice. The daily total is derived at read
// time, never stored.
//
// Every mutation writes its audit row in the SAME transaction (hard rule #6).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { onHand } from '@/lib/inventory/running-balance';

export class ProcessedUnitsError extends Error {
  readonly status: number;
  constructor(
    readonly reason: 'closed' | 'not_found' | 'invalid' | 'negative_balance',
    message: string,
    status = 422,
  ) {
    super(message);
    this.name = 'ProcessedUnitsError';
    this.status = status;
  }
}

/** UTC-midnight key for a Pacific calendar day, matching the `@db.Date` columns. */
function productionDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function assertQuantity(name: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 999999.9) {
    throw new ProcessedUnitsError('invalid', `${name} must be a finite quantity in [0, 999999.9] (got ${String(n)})`);
  }
}

function assertOptionalCount(name: string, n: number | null | undefined): void {
  if (n == null) return;
  if (!Number.isInteger(n) || n < 0 || n > 100000) {
    throw new ProcessedUnitsError('invalid', `${name} must be a whole number in [0, 100000] (got ${String(n)})`);
  }
}

/** Derived (never entered) outflow for a day: whole-units-sold + landfilled, by pool. */
export interface DerivedDailyOutflow {
  wholeUnitsSold: { program: number; nonProgram: number; total: number };
  landfilled: { program: number; nonProgram: number; total: number };
}

export interface ProcessedUnitsView {
  id: string;
  siteId: string;
  productionDate: Date;
  strippedProgram: string;
  strippedNonProgram: string;
  /** Derived at read time — never stored. */
  totalStripped: string;
  savedUnits: string | null;
  materialTicketNumber: string | null;
  employeesCount: number | null;
  processorsCount: number | null;
  pocketcoilEstimate: number | null;
  /** Derived for close confirmation (renovation outbound + landfilled for this date). */
  derived: DerivedDailyOutflow;
  closedAt: Date | null;
  source: string;
  notes: string | null;
}

interface ProcessedRow {
  id: string;
  site_id: string;
  production_date: Date;
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  saved_units: Prisma.Decimal | null;
  material_ticket_number: string | null;
  employees_count: number | null;
  processors_count: number | null;
  pocketcoil_estimate: number | null;
  closed_at: Date | null;
  source: string;
  notes: string | null;
}

const ZERO_OUTFLOW: DerivedDailyOutflow = {
  wholeUnitsSold: { program: 0, nonProgram: 0, total: 0 },
  landfilled: { program: 0, nonProgram: 0, total: 0 },
};

function toView(row: ProcessedRow, derived: DerivedDailyOutflow = ZERO_OUTFLOW): ProcessedUnitsView {
  return {
    id: row.id,
    siteId: row.site_id,
    productionDate: row.production_date,
    strippedProgram: row.stripped_program.toString(),
    strippedNonProgram: row.stripped_non_program.toString(),
    totalStripped: row.stripped_program.plus(row.stripped_non_program).toString(),
    savedUnits: row.saved_units?.toString() ?? null,
    materialTicketNumber: row.material_ticket_number,
    employeesCount: row.employees_count,
    processorsCount: row.processors_count,
    pocketcoilEstimate: row.pocketcoil_estimate,
    derived,
    closedAt: row.closed_at,
    source: row.source,
    notes: row.notes,
  };
}

/**
 * Derive whole-units-sold (renovation outbound) + landfilled for a single site/day.
 * Read-only; the close surface DISPLAYS this for confirmation (never entered twice).
 */
export async function deriveDailyOutflow(siteId: string, productionDate: Date): Promise<DerivedDailyOutflow> {
  const day = productionDateUTC(productionDate);
  const [reno, land] = await Promise.all([
    prisma.outboundMaterial.aggregate({
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, sub_category: 'renovation', ship_date: day },
    }),
    prisma.landfilledUnit.aggregate({
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, disposal_date: day },
    }),
  ]);
  const rp = reno._sum.program_units ?? 0;
  const rn = reno._sum.non_program_units ?? 0;
  const lp = land._sum.program_units ?? 0;
  const ln = land._sum.non_program_units ?? 0;
  return {
    wholeUnitsSold: { program: rp, nonProgram: rn, total: rp + rn },
    landfilled: { program: lp, nonProgram: ln, total: lp + ln },
  };
}

/**
 * Create or update the (site, day) processed-units row. Blocked once the day is
 * closed — the caller must use the amendment path instead of an in-place edit.
 */
export async function upsertProcessedUnits(args: {
  siteId: string;
  productionDate: Date;
  strippedProgram: number;
  strippedNonProgram: number;
  savedUnits?: number | null;
  materialTicketNumber?: string | null;
  employeesCount?: number | null;
  processorsCount?: number | null;
  pocketcoilEstimate?: number | null;
  actorUserId: string;
  notes?: string | null;
}): Promise<ProcessedUnitsView> {
  assertQuantity('stripped_program', args.strippedProgram);
  assertQuantity('stripped_non_program', args.strippedNonProgram);
  if (args.savedUnits != null) assertQuantity('saved_units', args.savedUnits);
  assertOptionalCount('employees_count', args.employeesCount);
  assertOptionalCount('processors_count', args.processorsCount);
  assertOptionalCount('pocketcoil_estimate', args.pocketcoilEstimate);
  const day = productionDateUTC(args.productionDate);

  const existing = await prisma.processedUnitsDaily.findUnique({
    where: { site_id_production_date: { site_id: args.siteId, production_date: day } },
    select: { id: true, closed_at: true },
  });
  if (existing?.closed_at) {
    throw new ProcessedUnitsError(
      'closed',
      `processed-units day ${day.toISOString().slice(0, 10)} is closed — corrections follow the amendment path, not in-place edits`,
      409,
    );
  }

  const data = {
    stripped_program: new Prisma.Decimal(args.strippedProgram),
    stripped_non_program: new Prisma.Decimal(args.strippedNonProgram),
    saved_units: args.savedUnits != null ? new Prisma.Decimal(args.savedUnits) : null,
    material_ticket_number: args.materialTicketNumber ?? null,
    employees_count: args.employeesCount ?? null,
    processors_count: args.processorsCount ?? null,
    pocketcoil_estimate: args.pocketcoilEstimate ?? null,
    entered_by: args.actorUserId,
    notes: args.notes ?? null,
  };

  const row = await prisma.$transaction(async (tx) => {
    const upserted = await tx.processedUnitsDaily.upsert({
      where: { site_id_production_date: { site_id: args.siteId, production_date: day } },
      create: { site_id: args.siteId, production_date: day, source: 'manual', ...data },
      update: data,
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: existing ? 'update' : 'insert',
        table_name: 'processed_units_daily',
        row_id: upserted.id,
        after: {
          production_date: day.toISOString().slice(0, 10),
          stripped_program: args.strippedProgram,
          stripped_non_program: args.strippedNonProgram,
        },
      },
    });
    return upserted;
  });
  const derived = await deriveDailyOutflow(args.siteId, day);
  return toView(row, derived);
}

/**
 * Close a processed-units day: stamp `closed_at`, write an audit row. Idempotent-
 * guarded.
 *
 * Negative-balance guard (D6): closing a day locks in that day's stripping as the
 * billing/inventory basis. Before stamping, we compute the pool-aware running
 * balance (the ONE {@link onHand}/computeRunningBalance) as of the END of this
 * production day. If either pool would go negative — more stripped/sold/landfilled
 * than the anchor + inbound can support, i.e. an upstream inbound data gap — we
 * REFUSE with a typed 422 carrying the pool numbers, UNLESS the caller passes
 * `acknowledgeNegative: true`. This is a warn-and-confirm posture: the office may
 * legitimately close a day that exposes a real upstream gap; that acknowledgment is
 * then recorded in the close audit row (never silently absorbed).
 */
export async function closeProcessedUnitsDay(args: {
  id: string;
  siteId: string;
  actorUserId: string;
  acknowledgeNegative?: boolean;
}): Promise<ProcessedUnitsView> {
  const row = await prisma.processedUnitsDaily.findUnique({ where: { id: args.id } });
  if (!row || row.site_id !== args.siteId) {
    throw new ProcessedUnitsError('not_found', `processed-units row ${args.id} not found`, 404);
  }
  if (row.closed_at) {
    throw new ProcessedUnitsError('closed', 'day is already closed', 409);
  }

  // End-of-day boundary: include this day's stripping + any same-day inbound/sold/
  // landfilled, but exclude the next day (production_date is a @db.Date at UTC 00:00).
  const day = productionDateUTC(row.production_date);
  const endOfDay = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);
  const balance = await onHand(args.siteId, endOfDay);
  const wouldGoNegative = balance.program.isNegative() || balance.nonProgram.isNegative();
  if (wouldGoNegative && !args.acknowledgeNegative) {
    throw new ProcessedUnitsError(
      'negative_balance',
      `closing ${day.toISOString().slice(0, 10)} drives inventory negative (program=${balance.program.toString()}, non_program=${balance.nonProgram.toString()}) — resolve the upstream inbound gap, or re-submit with acknowledgeNegative to close anyway`,
      422,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.processedUnitsDaily.update({
      where: { id: args.id },
      data: { closed_at: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: 'processed_units_daily',
        row_id: args.id,
        before: { closed_at: null },
        after: {
          closed_at: u.closed_at?.toISOString() ?? null,
          // Record the acknowledgment (and the numbers it waved through) so a
          // closed-negative day is auditable, never silent.
          ...(wouldGoNegative
            ? {
                acknowledged_negative: true,
                balance_program: balance.program.toString(),
                balance_non_program: balance.nonProgram.toString(),
              }
            : {}),
        },
      },
    });
    return u;
  });
  const derived = await deriveDailyOutflow(args.siteId, updated.production_date);
  return toView(updated, derived);
}

/**
 * Batched equivalent of {@link deriveDailyOutflow} for a set of days: two grouped
 * aggregate queries (renovation outbound by ship_date, landfilled by disposal_date)
 * over the whole date range, mapped back per day. Kills the per-row N+1 in
 * {@link listProcessedUnits} while preserving EXACT per-day semantics — a day with
 * no outflow maps to {@link ZERO_OUTFLOW}, identical to the single-day path.
 */
async function deriveDailyOutflowBatch(siteId: string, days: readonly Date[]): Promise<Map<number, DerivedDailyOutflow>> {
  const out = new Map<number, DerivedDailyOutflow>();
  if (days.length === 0) return out;
  const uniqueDays = [...new Map(days.map((d) => [d.getTime(), d])).values()];
  const [reno, land] = await Promise.all([
    prisma.outboundMaterial.groupBy({
      by: ['ship_date'],
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, sub_category: 'renovation', ship_date: { in: uniqueDays } },
    }),
    prisma.landfilledUnit.groupBy({
      by: ['disposal_date'],
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, disposal_date: { in: uniqueDays } },
    }),
  ]);
  const renoByDate = new Map(reno.map((r) => [r.ship_date.getTime(), r._sum]));
  const landByDate = new Map(land.map((r) => [r.disposal_date.getTime(), r._sum]));
  for (const day of uniqueDays) {
    const rr = renoByDate.get(day.getTime());
    const ll = landByDate.get(day.getTime());
    const rp = rr?.program_units ?? 0;
    const rn = rr?.non_program_units ?? 0;
    const lp = ll?.program_units ?? 0;
    const ln = ll?.non_program_units ?? 0;
    out.set(day.getTime(), {
      wholeUnitsSold: { program: rp, nonProgram: rn, total: rp + rn },
      landfilled: { program: lp, nonProgram: ln, total: lp + ln },
    });
  }
  return out;
}

/** List the most recent processed-units rows for a site, each with its derived outflow. */
export async function listProcessedUnits(siteId: string, limit = 60): Promise<ProcessedUnitsView[]> {
  const rows = await prisma.processedUnitsDaily.findMany({
    where: { site_id: siteId },
    orderBy: { production_date: 'desc' },
    take: limit,
  });
  const byDate = await deriveDailyOutflowBatch(
    siteId,
    rows.map((r) => productionDateUTC(r.production_date)),
  );
  return rows.map((r) => toView(r, byDate.get(productionDateUTC(r.production_date).getTime()) ?? ZERO_OUTFLOW));
}
