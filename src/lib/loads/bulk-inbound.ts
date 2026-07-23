// ADR-0037 Phase 3 (§3.2 option b) — paper-bootstrap BULK DAILY INBOUND.
//
// Woodland and Eugene run on paper daily logs until the operator iPads are in
// service, so there is no per-load inbound capture to feed the D6 running balance.
// This service lets a site manager enter ONE synthesized `inbound_loads` row per
// site per day: the day's total units + the program / non-program split. That
// preserves the inflow arithmetic
//
//   End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled
//
// without demanding operator-level per-load detail.
//
// Provenance is explicit and never ambiguous: `load_source_type = 'paper_bulk'`
// and `count_mode = 'total'`. A paper_bulk row is NEVER a dock capture — it carries
// no BOL, no photos, no transporter, and no unload timings. When the iPads come
// online the aggregate rows simply stop being written and per-load rows take over.
//
// The row is written at `status = 'verified'` with `arrived_at` at the PACIFIC-midnight
// instant of the business day (not UTC midnight), because that is exactly what
// {@link onHand} counts as inbound (VERIFIED_INBOUND_STATUSES + the `arrived_at` window)
// AND what the D1 promotion conflict detector keys on (`pacificMidnightInstantOfDayISO`
// bounds). A UTC-midnight instant lands 7/8 h earlier — one Pacific day back — so a
// first-of-month paper row would escape that month's promotion-refusal window and get
// silently double-counted (finding 3). Pacific midnight of day N always falls within UTC
// calendar day N, so the UTC-day-based running-balance/EOD math is unchanged. The Q8 verify-gate
// invariant — `program + non_program == total_units` — is enforced here before the
// write, so a paper row can never enter the balance with a split that does not sum.
//
// One row per site per day is enforced twice: a partial unique index in the
// migration, and the amend-in-place path below (re-entering a day UPDATEs that
// day's row rather than creating a second one). Every mutation writes its audit row
// in the SAME transaction (CLAUDE.md hard rule #6).

import { prisma } from '@/lib/prisma';
import { RecordValidationError } from '@/lib/loads/record-guards';
import { dayISO, pacificMidnightInstantOfDayISO } from '@/lib/time';

const TABLE = 'inbound_loads';

/** Provenance tag for every row this service writes. */
export const PAPER_BULK_SOURCE_TYPE = 'paper_bulk' as const;

/**
 * The `arrived_at` instant for a paper-bulk business day: PACIFIC midnight of that
 * day (derived from the input's UTC calendar Y/M/D — the day key). This is the value
 * both the day-keyed unique index and the D1 promotion window key on; a UTC-midnight
 * value would sit one Pacific day earlier and slip a first-of-month row out of its own
 * month's promotion-refusal window (finding 3).
 */
function inboundArrivedAt(date: Date): Date {
  return pacificMidnightInstantOfDayISO(dayISO(date));
}

function assertWhole(name: string, n: number, min = 0): void {
  if (!Number.isInteger(n) || n < min || n > 100000) {
    throw new RecordValidationError(
      `${name} must be a whole number in [${min}, 100000] (got ${String(n)})`,
    );
  }
}

/**
 * Q8 split invariant. MRC is billed on PROGRAM units only, so a split that does not
 * sum to the day's total would silently mis-state the billable pool.
 */
function assertSplit(totalUnits: number, programUnits: number, nonProgramUnits: number): void {
  assertWhole('total_units', totalUnits, 1);
  assertWhole('program_units', programUnits);
  assertWhole('non_program_units', nonProgramUnits);
  if (programUnits + nonProgramUnits !== totalUnits) {
    throw new RecordValidationError(
      `program_units (${programUnits}) + non_program_units (${nonProgramUnits}) must equal total_units (${totalUnits})`,
    );
  }
}

export interface BulkInboundView {
  id: string;
  siteId: string;
  /** The business day this aggregate covers (Pacific midnight of the day). */
  inboundDate: Date;
  totalUnits: number;
  programUnits: number;
  nonProgramUnits: number;
  /** Always `paper_bulk` — the provenance tag that distinguishes it from a dock capture. */
  loadSourceType: string;
  /** Paper daily-log slip / page reference, when the manager records one. */
  slipNumber: string | null;
}

interface BulkRow {
  id: string;
  site_id: string;
  arrived_at: Date | null;
  total_units: number | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  load_source_type: string;
  slip_number: string | null;
}

function toView(r: BulkRow): BulkInboundView {
  return {
    id: r.id,
    siteId: r.site_id,
    inboundDate: r.arrived_at ?? new Date(0),
    totalUnits: r.total_units ?? 0,
    programUnits: r.program_unit_count ?? 0,
    nonProgramUnits: r.non_program_unit_count ?? 0,
    loadSourceType: r.load_source_type,
    slipNumber: r.slip_number,
  };
}

/**
 * Create — or amend in place — the site's paper-bulk aggregate row for one day.
 *
 * Idempotent per (site, day): re-entering a day corrects that day's numbers rather
 * than double-counting the inflow. Both paths write an audit row carrying the
 * before/after unit counts.
 */
export async function upsertBulkInboundDay(args: {
  siteId: string;
  inboundDate: Date;
  totalUnits: number;
  programUnits: number;
  nonProgramUnits: number;
  actorUserId: string;
  slipNumber?: string | null;
}): Promise<BulkInboundView> {
  assertSplit(args.totalUnits, args.programUnits, args.nonProgramUnits);
  const day = inboundArrivedAt(args.inboundDate);

  const existing = await prisma.inboundLoad.findFirst({
    where: { site_id: args.siteId, load_source_type: PAPER_BULK_SOURCE_TYPE, arrived_at: day },
    select: { id: true, total_units: true, program_unit_count: true, non_program_unit_count: true },
  });

  const counts = {
    total_units: args.totalUnits,
    program_unit_count: args.programUnits,
    non_program_unit_count: args.nonProgramUnits,
    slip_number: args.slipNumber ?? null,
  };

  const row = await prisma.$transaction(async (tx) => {
    const written = existing
      ? await tx.inboundLoad.update({ where: { id: existing.id }, data: counts })
      : await tx.inboundLoad.create({
          data: {
            site_id: args.siteId,
            load_source_type: PAPER_BULK_SOURCE_TYPE,
            // Counted from the paper log as a single day total, not stack-by-stack.
            count_mode: 'total',
            // What onHand() counts as inbound: a verified status + an arrived_at in
            // the window. The split invariant above is the same one the dock verify
            // gate enforces, so this row is admissible on identical terms.
            status: 'verified',
            arrived_at: day,
            submitted_at: new Date(),
            submitted_by_id: args.actorUserId,
            ...counts,
          },
        });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: existing ? 'update' : 'insert',
        table_name: TABLE,
        row_id: written.id,
        ...(existing
          ? {
              before: {
                total_units: existing.total_units,
                program_unit_count: existing.program_unit_count,
                non_program_unit_count: existing.non_program_unit_count,
              },
            }
          : {}),
        after: {
          load_source_type: PAPER_BULK_SOURCE_TYPE,
          arrived_at: day.toISOString().slice(0, 10),
          total_units: args.totalUnits,
          program_unit_count: args.programUnits,
          non_program_unit_count: args.nonProgramUnits,
        },
      },
    });
    return written;
  });
  return toView(row as BulkRow);
}

/** List a site's paper-bulk aggregate days, newest first. Never includes dock captures. */
export async function listBulkInboundDays(siteId: string, limit = 60): Promise<BulkInboundView[]> {
  const rows = await prisma.inboundLoad.findMany({
    where: { site_id: siteId, load_source_type: PAPER_BULK_SOURCE_TYPE },
    orderBy: { arrived_at: 'desc' },
    take: limit,
    select: {
      id: true,
      site_id: true,
      arrived_at: true,
      total_units: true,
      program_unit_count: true,
      non_program_unit_count: true,
      load_source_type: true,
      slip_number: true,
    },
  });
  return rows.map((r) => toView(r as BulkRow));
}
