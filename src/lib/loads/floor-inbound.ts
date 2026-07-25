// ADR-0060 — iPad FLOOR inbound-confirmation service (the confirmed terminal of the
// ADR-0059 provisional lifecycle).
//
// This is the write-side the ADR-0059 module header foretold ("upgraded to confirmed
// later by a manager `paper_bulk` entry or a future iPad floor-confirmation"). A floor
// operator confirms, corrects, or enters the day's inbound haul counts on the iPad
// (`/operator/[site]/inbound`); this service installs ONE aggregate row
// `load_source_type='ipad_floor'` for that (site, delivery day) and retires the day's
// provisional `mymrc_haul` row — the SAME delete-then-write contract
// `upsertBulkInboundDay` (`bulk-inbound.ts`) implements for the office paper path.
//
// PRECEDENCE (ADR-0059 D4, extended by ADR-0060): ipad_floor > paper_bulk > mymrc_haul.
//   - A day owned by an office `paper_bulk` row is REFUSED on the floor (409): the floor
//     never silently clobbers an office entry — office amends via the manager surface.
//   - A day owned by a `mymrc_haul` provisional is retired (audited delete) and replaced.
//   - A day already floor-confirmed (`ipad_floor`) is UPDATED in place (absolute SET —
//     re-confirm is idempotent and double-count-proof).
//
// MONEY-SAFE by construction:
//   - GRAIN is per-(site, delivery day) AGGREGATE. `onHand` sums EVERY verified inbound
//     row for a day regardless of `load_source_type`, so the three-value partial unique
//     index (migration 20260812, `WHERE load_source_type IN ('paper_bulk','mymrc_haul',
//     'ipad_floor')`) keeps at most ONE aggregate row per (site, day).
//   - AGGREGATE-vs-PER-LOAD guard (ADR-0060 D5): the unique index bars two *aggregate*
//     rows but NOT an aggregate row coexisting with per-load `b2b_haul` dock captures for
//     the same day — that would double-count in `onHand`. So a confirm REFUSES (409) any
//     day that already holds a VERIFIED per-load (non-aggregate) inbound row. Latent-safe
//     today (0 per-load rows in prod) but made explicit before either grain goes live.
//   - ABSOLUTE SET (never increment) → re-confirm can never inflate the day.
//   - AUDITED (CLAUDE.md hard rule #6): every delete/insert/update writes its `audit_log`
//     row (`actor_user_id`=operator) in the SAME transaction; a refusal writes none.
//
// Pacific-midnight day key: `inboundArrivedAt` is REUSED from `bulk-inbound.ts` (one
// definition) so a floor-confirmed `arrived_at` is byte-identical to what the office
// paper path, the MyMRC bridge, and `onHand`'s inbound window all key on.

import { prisma } from '@/lib/prisma';
import { VERIFIED_INBOUND_STATUSES } from '@/lib/inventory/running-balance';
import {
  assertSplit,
  inboundArrivedAt,
  PAPER_BULK_SOURCE_TYPE,
  MYMRC_HAUL_SOURCE_TYPE,
  type BulkInboundView,
} from '@/lib/loads/bulk-inbound';
import { dayISO, dayKeyUTCFromISO, pacificDayISO, pacificMidnightInstantOfDayISO } from '@/lib/time';

const TABLE = 'inbound_loads';

/** Provenance tag for every floor-confirmed aggregate row this service writes. */
export const FLOOR_SOURCE_TYPE = 'ipad_floor' as const;

/** The three aggregate inbound provenances the partial unique index spans. */
export const AGGREGATE_SOURCE_TYPES = [
  PAPER_BULK_SOURCE_TYPE,
  MYMRC_HAUL_SOURCE_TYPE,
  FLOOR_SOURCE_TYPE,
] as const;

/**
 * A floor confirm was refused for a money-safety reason. Typed 409 so the route maps it
 * uniformly (mirrors the loads-service status-error shape). `reason` discriminates:
 *   - `per_load_exists` — verified per-load dock captures already cover this day
 *     (aggregate + per-load would double-count in onHand — ADR-0060 D5). Confirm on the
 *     per-load queue instead.
 *   - `office_owned`    — an office `paper_bulk` row owns the day; the floor never
 *     clobbers it (precedence). A manager amends it on the desktop.
 */
export class FloorInboundConflictError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly reason: 'per_load_exists' | 'office_owned',
    message: string,
  ) {
    super(message);
    this.name = 'FloorInboundConflictError';
  }
}

interface FloorRow {
  id: string;
  site_id: string;
  arrived_at: Date | null;
  total_units: number | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  load_source_type: string;
  slip_number: string | null;
}

function toView(r: FloorRow): BulkInboundView {
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

/** The exclusive upper bound of a Pacific delivery day: Pacific-midnight of the NEXT day. */
function nextPacificMidnight(dayKey: string): Date {
  const nextKey = dayISO(new Date(dayKeyUTCFromISO(dayKey).getTime() + 86_400_000));
  return pacificMidnightInstantOfDayISO(nextKey);
}

/**
 * Confirm / correct / enter one floor inbound day. Reuses the ADR-0059 delete-then-write
 * contract: retire the day's provisional and install one `ipad_floor` aggregate, in one
 * audited transaction. Idempotent per (site, day). See the module header for the money
 * path.
 */
export async function confirmFloorInboundDay(args: {
  siteId: string;
  inboundDate: Date;
  totalUnits: number;
  programUnits: number;
  nonProgramUnits: number;
  actorUserId: string;
  /** Optional short note recorded on a correction (stored in `slip_number`). */
  correctionNote?: string | null;
}): Promise<BulkInboundView> {
  assertSplit(args.totalUnits, args.programUnits, args.nonProgramUnits);
  const dayKey = dayISO(args.inboundDate);
  const day = inboundArrivedAt(args.inboundDate);
  const dayEnd = nextPacificMidnight(dayKey);

  const counts = {
    total_units: args.totalUnits,
    program_unit_count: args.programUnits,
    non_program_unit_count: args.nonProgramUnits,
    slip_number: args.correctionNote ?? null,
  };

  const row = await prisma.$transaction(async (tx) => {
    // 1. MONEY-SAFETY GUARD (ADR-0060 D5). A VERIFIED per-load (non-aggregate) inbound row
    //    for this Pacific day means onHand already counts that day's intake per-truck;
    //    adding an aggregate row would double-count. Refuse — confirm on the per-load queue.
    const perLoad = await tx.inboundLoad.findFirst({
      where: {
        site_id: args.siteId,
        status: { in: [...VERIFIED_INBOUND_STATUSES] },
        load_source_type: { notIn: [...AGGREGATE_SOURCE_TYPES] },
        arrived_at: { gte: day, lt: dayEnd },
      },
      select: { id: true },
    });
    if (perLoad) {
      throw new FloorInboundConflictError(
        'per_load_exists',
        `per-load dock captures already exist for ${dayKey}; confirm on the per-load queue instead`,
      );
    }

    // 2. PRECEDENCE. At most one aggregate row can own the (site, day) slot (unique index).
    const existing = (await tx.inboundLoad.findFirst({
      where: {
        site_id: args.siteId,
        load_source_type: { in: [...AGGREGATE_SOURCE_TYPES] },
        arrived_at: day,
      },
      select: {
        id: true,
        load_source_type: true,
        total_units: true,
        program_unit_count: true,
        non_program_unit_count: true,
      },
    })) as Pick<
      FloorRow,
      'id' | 'load_source_type' | 'total_units' | 'program_unit_count' | 'non_program_unit_count'
    > | null;

    // Office owns the day → the floor never clobbers it.
    if (existing && existing.load_source_type === PAPER_BULK_SOURCE_TYPE) {
      throw new FloorInboundConflictError(
        'office_owned',
        `${dayKey} was entered by the office; ask a manager to amend it`,
      );
    }

    // 3. Re-confirm (day already floor-confirmed) → UPDATE in place (absolute SET).
    if (existing && existing.load_source_type === FLOOR_SOURCE_TYPE) {
      const updated = await tx.inboundLoad.update({ where: { id: existing.id }, data: counts });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: TABLE,
          row_id: existing.id,
          before: {
            total_units: existing.total_units,
            program_unit_count: existing.program_unit_count,
            non_program_unit_count: existing.non_program_unit_count,
          },
          after: {
            load_source_type: FLOOR_SOURCE_TYPE,
            arrived_at: dayKey,
            total_units: args.totalUnits,
            program_unit_count: args.programUnits,
            non_program_unit_count: args.nonProgramUnits,
          },
        },
      });
      return updated;
    }

    // 4. Provisional owns the day → retire it (audited delete) before installing the
    //    confirmed row. Same delete-then-write shape as upsertBulkInboundDay.
    if (existing && existing.load_source_type === MYMRC_HAUL_SOURCE_TYPE) {
      await tx.inboundLoad.delete({ where: { id: existing.id } });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'delete',
          table_name: TABLE,
          row_id: existing.id,
          before: {
            load_source_type: MYMRC_HAUL_SOURCE_TYPE,
            arrived_at: dayKey,
            total_units: existing.total_units,
            program_unit_count: existing.program_unit_count,
            non_program_unit_count: existing.non_program_unit_count,
          },
        },
      });
    }

    // 5. Install the confirmed aggregate (enter-from-scratch, or post-provisional-retire).
    const created = await tx.inboundLoad.create({
      data: {
        site_id: args.siteId,
        load_source_type: FLOOR_SOURCE_TYPE,
        count_mode: 'total',
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
        action: 'insert',
        table_name: TABLE,
        row_id: created.id,
        after: {
          load_source_type: FLOOR_SOURCE_TYPE,
          arrived_at: dayKey,
          total_units: args.totalUnits,
          program_unit_count: args.programUnits,
          non_program_unit_count: args.nonProgramUnits,
        },
      },
    });
    return created;
  });

  return toView(row as FloorRow);
}

/** One recent day's inbound state, as the floor confirm screen renders it. */
export interface FloorInboundDayView {
  /** `YYYY-MM-DD` Pacific delivery day. */
  dateISO: string;
  isToday: boolean;
  /** Null when no aggregate row exists yet (the ENTER path — Eugene / a missed day). */
  totalUnits: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  loadSourceType: 'mymrc_haul' | 'paper_bulk' | 'ipad_floor' | null;
  /** `mymrc_haul` — an unconfirmed bridge aggregate awaiting floor confirmation. */
  provisional: boolean;
  /** `ipad_floor` — already floor-confirmed (re-confirm is idempotent). */
  floorConfirmed: boolean;
  /** `ipad_floor` AND confirmed by the signed-in operator (drives the "by you" chip). */
  confirmedByYou: boolean;
  /** `paper_bulk` — office-entered; read-only on the floor (precedence). */
  officeOwned: boolean;
  /** Confirm/entry instant for the chip time (ISO). */
  confirmedAt: string | null;
  /** Verified per-load dock captures exist for the day → confirm on the queue, not here. */
  hasPerLoadCapture: boolean;
}

interface AggRow {
  arrived_at: Date | null;
  total_units: number | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  load_source_type: string;
  submitted_by_id: string | null;
  submitted_at: Date | null;
}

/**
 * List the recent inbound days for the floor confirm screen: the last `days` Pacific days
 * that have an aggregate row or a per-load capture, plus today (always, for the ENTER
 * path), newest first. `operatorUserId` drives the "confirmed by you" chip.
 */
export async function listFloorInboundDays(
  siteId: string,
  operatorUserId: string,
  days = 14,
  now: Date = new Date(),
): Promise<FloorInboundDayView[]> {
  const todayKey = pacificDayISO(now);
  const windowStartKey = dayISO(
    new Date(dayKeyUTCFromISO(todayKey).getTime() - (days - 1) * 86_400_000),
  );
  const windowStart = pacificMidnightInstantOfDayISO(windowStartKey);

  const [aggRows, perLoadRows] = await Promise.all([
    prisma.inboundLoad.findMany({
      where: {
        site_id: siteId,
        load_source_type: { in: [...AGGREGATE_SOURCE_TYPES] },
        arrived_at: { gte: windowStart },
      },
      orderBy: { arrived_at: 'desc' },
      select: {
        arrived_at: true,
        total_units: true,
        program_unit_count: true,
        non_program_unit_count: true,
        load_source_type: true,
        submitted_by_id: true,
        submitted_at: true,
      },
    }),
    prisma.inboundLoad.findMany({
      where: {
        site_id: siteId,
        status: { in: [...VERIFIED_INBOUND_STATUSES] },
        load_source_type: { notIn: [...AGGREGATE_SOURCE_TYPES] },
        arrived_at: { gte: windowStart },
      },
      select: { arrived_at: true },
    }),
  ]);

  const perLoadDays = new Set<string>();
  for (const r of perLoadRows) {
    if (r.arrived_at) perLoadDays.add(pacificDayISO(r.arrived_at));
  }

  const byDay = new Map<string, AggRow>();
  for (const r of aggRows as AggRow[]) {
    if (r.arrived_at) byDay.set(pacificDayISO(r.arrived_at), r);
  }

  const dayKeys = new Set<string>([todayKey, ...byDay.keys(), ...perLoadDays]);
  const sorted = [...dayKeys].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first

  return sorted.map((dateISO) => {
    const agg = byDay.get(dateISO) ?? null;
    const src = (agg?.load_source_type ?? null) as FloorInboundDayView['loadSourceType'];
    return {
      dateISO,
      isToday: dateISO === todayKey,
      totalUnits: agg?.total_units ?? null,
      programUnits: agg?.program_unit_count ?? null,
      nonProgramUnits: agg?.non_program_unit_count ?? null,
      loadSourceType: src,
      provisional: src === MYMRC_HAUL_SOURCE_TYPE,
      floorConfirmed: src === FLOOR_SOURCE_TYPE,
      confirmedByYou: src === FLOOR_SOURCE_TYPE && agg?.submitted_by_id === operatorUserId,
      officeOwned: src === PAPER_BULK_SOURCE_TYPE,
      confirmedAt: agg?.submitted_at ? agg.submitted_at.toISOString() : null,
      hasPerLoadCapture: perLoadDays.has(dateISO),
    };
  });
}

/** Count of unconfirmed (`mymrc_haul`) provisional days in the recent window — F-1 badge. */
export async function countUnconfirmedInboundDays(
  siteId: string,
  days = 14,
  now: Date = new Date(),
): Promise<number> {
  const todayKey = pacificDayISO(now);
  const windowStartKey = dayISO(
    new Date(dayKeyUTCFromISO(todayKey).getTime() - (days - 1) * 86_400_000),
  );
  const windowStart = pacificMidnightInstantOfDayISO(windowStartKey);
  return prisma.inboundLoad.count({
    where: {
      site_id: siteId,
      load_source_type: MYMRC_HAUL_SOURCE_TYPE,
      arrived_at: { gte: windowStart },
    },
  });
}
