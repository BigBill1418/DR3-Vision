// ADR-0125 — the EOD inbound add-line: the manager records a haul the floor
// missed, WITH the identifiers the workbook carries.
//
// ── What this closes (Phase 0 gaps G-2 and G-8) ────────────────────────────
//
// Five of the workbook's identifying columns had a schema home on
// `inbound_loads` and NO human write path — measured 100% NULL across all 743
// production rows: `bol_number`, `dr3_number`, `external_mymrc_haul_id`,
// `slip_number`, plus `transport_charged` sitting `false` on every row. The BOL
// arrives only from the MyMRC scrape; the DR3 number only from the CA verify
// gate, which had never fired. Nobody could enter or correct any of them. This
// is the "home exists in schema, no capture path" class the parity audit existed
// to catch, and it covers most of the `inb trans charges` tab.
//
// `transport_charged` is the one that matters most: it is the ONLY thing
// distinguishing the workbook's two inbound tabs, and with no writer the whole
// CA freight + fuel-surcharge invoice leg selected `where transport_charged =
// true`, matched nothing, and ran its loop zero times without raising anything.
// It now has two writers — the verify gate (defaulting from
// `sources.is_trans_charge`) and this add-line's explicit checkbox.
//
// ── NO AUTOMATIC DR3 NUMBER HERE, deliberately ─────────────────────────────
//
// The `document_sequences` counter still reads `next_value = 5000` while the
// workbook is at DR3 # 4,755 and climbing ~11/day, so Vision issuing numbers
// today would collide with the sheet around late October. Whether to reseed the
// counter above the highest number ever issued or to take over numbering at a
// named cutover date is Bill's decision and it is open. Until he makes it, the
// DR3 number on this line is a field the manager TYPES — transcribing what the
// paperwork says — and nothing here touches the sequence.
//
// ── The double-count guard ─────────────────────────────────────────────────
//
// `onHand` counts BOTH per-load rows and the one-per-day aggregate rows
// (`paper_bulk` / `mymrc_haul` / `ipad_floor`). Adding a per-load line to a day
// an aggregate already covers would count those units twice in the floor and in
// the billing basis. `confirmFloorInboundDay` guards the same collision from the
// other direction (`per_load_exists`); this is its mirror, and it is on the write
// rather than in the UI because the UI is not the boundary.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
import { AGGREGATE_SOURCE_TYPES } from '@/lib/loads/floor-inbound';
import { assertSplit } from '@/lib/loads/bulk-inbound';
import { RecordValidationError } from '@/lib/loads/record-guards';
import { dayISO, pacificMidnightInstantOfDayISO } from '@/lib/time';

const TABLE = 'inbound_loads';

/** A per-load EOD line was refused for a double-count or uniqueness reason. */
export class EodInboundConflictError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly reason: 'aggregate_covers_day' | 'haul_number_taken',
    message: string,
  ) {
    super(message);
    this.name = 'EodInboundConflictError';
  }
}

export interface EodInboundLineInput {
  siteId: string;
  /** The @db.Date-shaped Pacific day key the haul arrived. */
  dayKey: Date;
  totalUnits: number;
  programUnits: number;
  nonProgramUnits: number;
  weightLbs?: number | null;
  sourceId?: string | null;
  /** The sheet's `BOL # or Check #`. Vision holds only the BOL half. */
  bolNumber?: string | null;
  /** TYPED, never issued (see the header). */
  dr3Number?: string | null;
  haulNumber?: string | null;
  slipNumber?: string | null;
  /**
   * Explicit freight / no-freight. Omitted ⇒ defaults from the chosen source's
   * `is_trans_charge` classifier, and `false` when there is no source — never a
   * guess dressed as a measurement.
   */
  transportCharged?: boolean | undefined;
  actorUserId: string;
}

export interface EodInboundLineView {
  id: string;
  dayKey: string;
  totalUnits: number;
  programUnits: number;
  nonProgramUnits: number;
  weightLbs: number | null;
  bolNumber: string | null;
  dr3Number: string | null;
  haulNumber: string | null;
  slipNumber: string | null;
  transportCharged: boolean;
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

/**
 * Resolve the freight flag: the caller's explicit choice wins; otherwise the
 * source's classifier decides; with no source at all it is `false`.
 *
 * PURE, so the precedence is testable without a database. The order matters —
 * defaulting FIRST and letting the checkbox merely agree with it would make an
 * unticked box indistinguishable from "the source says no".
 */
export function resolveTransportCharged(
  explicit: boolean | undefined,
  sourceIsTransCharge: boolean | null,
): boolean {
  if (explicit !== undefined) return explicit;
  return sourceIsTransCharge ?? false;
}

/**
 * Record one missing inbound haul for a day, with its identifiers.
 *
 * Written at `status = 'verified'` with the Q8 split invariant enforced, exactly
 * like `upsertBulkInboundDay`: those are the terms on which `onHand` admits a
 * row as inbound, and a manager filling an EOD gap is making the same statement
 * the verify gate makes — this haul arrived, and this is its pool split.
 */
export async function addEodInboundLine(args: EodInboundLineInput): Promise<EodInboundLineView> {
  assertSplit(args.totalUnits, args.programUnits, args.nonProgramUnits);
  if (args.weightLbs != null) {
    if (!Number.isInteger(args.weightLbs) || args.weightLbs < 0 || args.weightLbs > 100_000) {
      throw new RecordValidationError(
        `weight_lbs must be a whole number in [0, 100000] (got ${String(args.weightLbs)})`,
      );
    }
  }

  const dayISOKey = dayISO(args.dayKey);
  const arrivedAt = pacificMidnightInstantOfDayISO(dayISOKey);
  const dayEnd = pacificMidnightInstantOfDayISO(
    dayISO(new Date(args.dayKey.getTime() + 86_400_000)),
  );

  const source = args.sourceId
    ? await prisma.source.findFirst({
        where: { id: args.sourceId, site_id: args.siteId },
        select: { id: true, is_trans_charge: true },
      })
    : null;
  if (args.sourceId && !source) {
    // Site-scoped by construction (hard rule #2): a source at the OTHER site is
    // not "not found by accident", it is a cross-site write and it is refused.
    throw new RecordValidationError('source not found at this site');
  }
  const transportCharged = resolveTransportCharged(
    args.transportCharged,
    source ? source.is_trans_charge : null,
  );

  const row = await prisma
    .$transaction(async (tx) => {
      // ADR-0120 — serialise against workbook promotion at this site, FIRST.
      await lockSiteAgainstPromotion(tx, args.siteId);

      // The double-count guard, INSIDE the lock: an aggregate row for this Pacific
      // day and a per-load row both feed `onHand`.
      const aggregate = await tx.inboundLoad.findFirst({
        where: {
          site_id: args.siteId,
          load_source_type: { in: [...AGGREGATE_SOURCE_TYPES] },
          status: { not: 'voided' },
          arrived_at: { gte: arrivedAt, lt: dayEnd },
        },
        select: { id: true, load_source_type: true },
      });
      if (aggregate) {
        throw new EodInboundConflictError(
          'aggregate_covers_day',
          `${dayISOKey} is already covered by a whole-day inbound total (${aggregate.load_source_type}); ` +
            'correct that day total instead — adding a per-load line here would count the same units twice',
        );
      }

      const created = await tx.inboundLoad.create({
        data: {
          site_id: args.siteId,
          // A per-load provenance, never an aggregate one: the aggregate types are
          // covered by a partial unique index of one row per site per day, and this
          // line is explicitly one haul among several.
          load_source_type: 'b2b_haul',
          count_mode: 'total',
          status: 'verified',
          arrived_at: arrivedAt,
          submitted_at: new Date(),
          submitted_by_id: args.actorUserId,
          ...(source ? { source_id: source.id } : {}),
          total_units: args.totalUnits,
          program_unit_count: args.programUnits,
          non_program_unit_count: args.nonProgramUnits,
          weight_lbs: args.weightLbs ?? null,
          bol_number: clean(args.bolNumber),
          dr3_number: clean(args.dr3Number),
          external_mymrc_haul_id: clean(args.haulNumber),
          slip_number: clean(args.slipNumber),
          transport_charged: transportCharged,
        },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'insert',
          table_name: TABLE,
          row_id: created.id,
          after: {
            eod_gap_fill: true,
            arrived_at: dayISOKey,
            load_source_type: 'b2b_haul',
            total_units: args.totalUnits,
            program_unit_count: args.programUnits,
            non_program_unit_count: args.nonProgramUnits,
            bol_number: clean(args.bolNumber),
            dr3_number: clean(args.dr3Number),
            external_mymrc_haul_id: clean(args.haulNumber),
            transport_charged: transportCharged,
          },
        },
      });
      return created;
    })
    .catch((e: unknown) => {
      // `external_mymrc_haul_id` is UNIQUE across the table. A manager typing a
      // haul number the MyMRC bridge already owns is a real collision and must say
      // so, not surface as an opaque 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new EodInboundConflictError(
          'haul_number_taken',
          `haul # ${clean(args.haulNumber) ?? ''} is already recorded on another load`,
        );
      }
      throw e;
    });

  return {
    id: row.id,
    dayKey: dayISOKey,
    totalUnits: row.total_units ?? 0,
    programUnits: row.program_unit_count ?? 0,
    nonProgramUnits: row.non_program_unit_count ?? 0,
    weightLbs: row.weight_lbs,
    bolNumber: row.bol_number,
    dr3Number: row.dr3_number,
    haulNumber: row.external_mymrc_haul_id,
    slipNumber: row.slip_number,
    transportCharged: row.transport_charged,
  };
}

/**
 * Flip the freight flag on an existing inbound row.
 *
 * Separate from the add-line because the 743 rows already in production were all
 * written before `transport_charged` had any writer at all, and the freight leg
 * cannot be un-blinded without a way to classify them.
 */
export async function setInboundTransportCharged(args: {
  siteId: string;
  loadId: string;
  transportCharged: boolean;
  actorUserId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.inboundLoad.updateMany({
      // Site-scoped in the WHERE, not checked above it: a cross-site id must
      // match zero rows, not be caught by a read that a concurrent move invalidates.
      where: { id: args.loadId, site_id: args.siteId },
      data: { transport_charged: args.transportCharged },
    });
    if (count === 0) {
      throw new RecordValidationError(`inbound load ${args.loadId} not found at this site`);
    }
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.loadId,
        after: { transport_charged: args.transportCharged },
      },
    });
  });
}
