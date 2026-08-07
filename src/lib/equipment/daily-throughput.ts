// ADR-0079 — the manager's DAILY machine capture: units processed + run hours.
//
// ADR-0044 D2 derived the Terex's throughput from the daily processed-units close
// (`stripped_program + stripped_non_program`) and reasoned that "throughput needs
// NO new capture". That number is the WHOLE FLOOR's output wearing one machine's
// name — it cannot tell the Terex from hand-stripping or a second machine — and
// production shows the scale: Woodland's derived "Terex" days run 1,000–1,250
// units. The paper sheet this product replaces carried an authoritative,
// manager-entered Terex number every day. This module is that number.
//
// Capturing rather than deriving also buys the thing the derived model could never
// have: REAL run hours. Units-per-hour was computed against an ASSUMED 8-hour day
// (`ASSUMED_DAY_HOURS` in ./throughput) — a labeled guess standing in for a
// measurement. With `run_hours` entered alongside the units, units-per-hour finally
// means what it says.
//
// Site-scoped (CLAUDE.md hard rule #2). Every write is audited (hard rule #6 —
// append-only, never deleted). There is NO hard delete: removal is a soft-void.
// The machine is resolved from the equipment REGISTRY (ADR-0077's identity rule),
// never a hardcoded id.
//
// DAY DISCIPLINE (D4): today is the PACIFIC day, everywhere. Same-day entry and
// edit are free and audited; a PRIOR day is REFUSED, not silently accepted — see
// `DailyThroughputAmendmentRequiredError` and the ADR-0079 D4 note on why this
// refuses rather than reusing the bonus amendment workflow.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appToday, dayISO } from '@/lib/time';
import type { AnyActorContext } from '@/lib/admin-equipment';

const TABLE = 'equipment_daily_throughput';

/**
 * Upper bound on a single day's units. Not a business rule — a TYPO CATCH.
 * Woodland's entire floor closes 1,000–1,250 units on a working day, so a single
 * machine cannot plausibly reach 10,000; a fat-fingered `10630` for `1063` is
 * refused rather than silently becoming the machine's record day.
 */
export const MAX_UNITS_PROCESSED = 10_000;

/**
 * A machine cannot run more than the 24 hours a calendar day has. Mirrored as a
 * DB CHECK so the invariant survives a future write path that forgets this module.
 */
export const MAX_RUN_HOURS = 24;

/** `Decimal(5,2)` — run hours are recorded to the hundredth of an hour. */
const RUN_HOURS_SCALE = 2;

export class DailyThroughputValidationError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'DailyThroughputValidationError';
  }
}

export class DailyThroughputNotFoundError extends Error {
  readonly status = 404;
  constructor(id: string) {
    super(`daily throughput entry ${id} not found`);
    this.name = 'DailyThroughputNotFoundError';
  }
}

export class NoMachineForSiteError extends Error {
  readonly status = 404;
  constructor() {
    super('no_machine_for_site');
    this.name = 'NoMachineForSiteError';
  }
}

/**
 * ADR-0079 D4 — a PRIOR-day change is refused, and says why.
 *
 * The handoff asked for prior-day edits to route through "the existing bonus
 * amendment workflow". They cannot, and the reason is structural rather than
 * cosmetic — see ADR-0079 D4 and OPEN-ITEMS F-2. The decisive one:
 * `resolveAmendmentApprover` sources the approver from `bonus_signature_chains`
 * and THROWS `AmendmentWorkflowForbiddenError` for any requester who is not a
 * bonus payroll signer. A Woodland equipment manager is not necessarily one, so
 * routing equipment through it would hand the exact audience this feature is for
 * a 403 they could do nothing about.
 *
 * Forking a parallel four-eyes system for one field was explicitly out of scope.
 * So this REFUSES — visibly, with the office named as the route — rather than
 * silently accepting a backdated change to a compliance-adjacent number. The
 * shape deliberately mirrors the bonus `409 requires_amendment` body so the
 * eventual generalization is a swap, not a rewrite.
 */
export class DailyThroughputAmendmentRequiredError extends Error {
  readonly status = 409;
  readonly error = 'requires_amendment' as const;
  constructor(
    readonly targetDateISO: string,
    readonly todayISO: string,
    readonly existing: { unitsProcessed: number; runHours: string } | null,
    readonly proposed: { unitsProcessed: number; runHours: string },
  ) {
    super('requires_amendment');
    this.name = 'DailyThroughputAmendmentRequiredError';
  }

  /** The 409 response body. Mirrors the bonus shape (`error` + context). */
  toBody(): {
    error: 'requires_amendment';
    targetDate: string;
    today: string;
    existing: { unitsProcessed: number; runHours: string } | null;
    proposed: { unitsProcessed: number; runHours: string };
  } {
    return {
      error: this.error,
      targetDate: this.targetDateISO,
      today: this.todayISO,
      existing: this.existing,
      proposed: this.proposed,
    };
  }
}

/**
 * Enforce the daily-entry shape. Pure — no DB, no clock.
 *
 * `units_processed` is a non-negative INTEGER: `0` is a legitimate RECORDED value
 * (the machine ran and produced nothing), and it is NOT the same fact as "nobody
 * entered a number", which is the ABSENCE of a row (ADR-0077 D4, restated).
 *
 * `run_hours` must be strictly POSITIVE. A day the machine did not run at all is
 * not an entry with zero hours — it is the absence of an entry, and admitting a
 * `0` here would put a divide-by-zero into the units-per-hour path.
 */
export function assertDailyThroughputShape(
  unitsProcessed: number,
  runHours: number,
): { unitsProcessed: number; runHours: Prisma.Decimal } {
  if (!Number.isInteger(unitsProcessed) || unitsProcessed < 0) {
    throw new DailyThroughputValidationError(
      `units_processed must be a whole number >= 0 (got ${String(unitsProcessed)})`,
    );
  }
  if (unitsProcessed > MAX_UNITS_PROCESSED) {
    throw new DailyThroughputValidationError(
      `units_processed must be <= ${MAX_UNITS_PROCESSED} (got ${String(unitsProcessed)})`,
    );
  }
  if (typeof runHours !== 'number' || !Number.isFinite(runHours) || runHours <= 0) {
    throw new DailyThroughputValidationError(
      `run_hours must be a positive number (got ${String(runHours)})`,
    );
  }
  if (runHours > MAX_RUN_HOURS) {
    throw new DailyThroughputValidationError(
      `run_hours must be <= ${MAX_RUN_HOURS} — a machine cannot run more than a day (got ${String(runHours)})`,
    );
  }
  return {
    unitsProcessed,
    runHours: new Prisma.Decimal(runHours.toFixed(RUN_HOURS_SCALE)),
  };
}

/**
 * ADR-0077's identity rule, as a resolver — the ONE place this feature learns
 * which machine it is talking about.
 *
 * A `terex`-CATEGORY row is not the test: the ADR-0062 seed uses `terex` as the
 * category for SHEAR MACHINES, so production carries five `terex`-category rows at
 * Woodland/Eugene of which exactly one is the machine. The evidence that
 * distinguishes it is that the Terex INVOICES actually resolve to it
 * (`links: { some: {} }`) — the same test `isSiteTerexMachine` and
 * `siteMachineLabel` already apply.
 *
 * Merged-away rows (ADR-0075) and deactivated rows are excluded, so a duplicate
 * can never quietly accumulate a parallel day-history.
 *
 * Site-DERIVED, never hardcoded: Eugene honestly resolves to `null` (it has no
 * such machine) and a Terex arriving there tomorrow is picked up with no code
 * change. The canonical Woodland machine is `7e35a4aa` today — reached through
 * this query, never written down.
 */
export async function resolveSiteThroughputMachine(
  siteId: string,
): Promise<{ id: string; displayName: string } | null> {
  const machine = await prisma.equipment.findFirst({
    where: {
      site_id: siteId,
      category: 'terex',
      is_active: true,
      merged_into_id: null,
      links: { some: {} },
    },
    select: { id: true, display_name: true },
    orderBy: { created_at: 'asc' },
  });
  return machine ? { id: machine.id, displayName: machine.display_name } : null;
}

export interface DailyThroughputView {
  id: string;
  siteId: string;
  equipmentId: string;
  throughputDateISO: string;
  unitsProcessed: number;
  /** Decimal string — never a float, so the recorded scale survives the round trip. */
  runHours: string;
  notes: string | null;
  createdBy: string | null;
  actorLabel: string | null;
  voidedAt: Date | null;
  createdAt: Date;
}

interface DailyRow {
  id: string;
  site_id: string;
  equipment_id: string;
  throughput_date: Date;
  units_processed: number;
  run_hours: Prisma.Decimal;
  notes: string | null;
  created_by: string | null;
  actor_label: string | null;
  voided_at: Date | null;
  created_at: Date;
}

function toView(r: DailyRow): DailyThroughputView {
  return {
    id: r.id,
    siteId: r.site_id,
    equipmentId: r.equipment_id,
    throughputDateISO: dayISO(r.throughput_date),
    unitsProcessed: r.units_processed,
    runHours: r.run_hours.toString(),
    notes: r.notes,
    createdBy: r.created_by,
    actorLabel: r.actor_label,
    voidedAt: r.voided_at,
    createdAt: r.created_at,
  };
}

function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

function isSystemActor(
  a: AnyActorContext,
): a is { actorLabel: string; ip: string | null; userAgent: string | null } {
  return 'actorLabel' in a;
}

/** The actor columns for either shape — a real id, or a self-naming label. NEVER both. */
function actorColumns(actor: AnyActorContext): {
  created_by: string | null;
  actor_label: string | null;
} {
  return isSystemActor(actor)
    ? { created_by: null, actor_label: actor.actorLabel }
    : { created_by: actor.actorUserId, actor_label: null };
}

function auditActor(actor: AnyActorContext): {
  actor_user_id: string | null;
  actor_label: string | null;
} {
  return isSystemActor(actor)
    ? { actor_user_id: null, actor_label: actor.actorLabel }
    : { actor_user_id: actor.actorUserId, actor_label: null };
}

/**
 * Record (or amend) the machine's day. Same-day only.
 *
 * The (equipment, day) partial unique makes a second same-day submission an EDIT
 * rather than a duplicate: an existing LIVE row for the day is UPDATED in place
 * and the change is audited with both before and after. A voided row does not
 * hold the slot, so a reversed entry leaves the day genuinely re-enterable.
 *
 * `nowISO` is injectable so the Pacific-day boundary is testable without mocking
 * the clock; it defaults to the real Pacific today.
 */
export async function upsertDailyThroughput(args: {
  siteId: string;
  throughputDate: Date;
  unitsProcessed: number;
  runHours: number;
  notes?: string | null;
  actor: AnyActorContext;
  /** Injectable "today" (a `@db.Date` key). Defaults to the Pacific day. */
  today?: Date;
}): Promise<DailyThroughputView> {
  const shape = assertDailyThroughputShape(args.unitsProcessed, args.runHours);
  const today = args.today ?? appToday();
  const day = new Date(
    Date.UTC(
      args.throughputDate.getUTCFullYear(),
      args.throughputDate.getUTCMonth(),
      args.throughputDate.getUTCDate(),
    ),
  );

  // A day that has not happened cannot have throughput. Refused as invalid input
  // rather than as an amendment — there is nothing to amend.
  if (day.getTime() > today.getTime()) {
    throw new DailyThroughputValidationError(
      `throughput_date is in the future (${dayISO(day)} > ${dayISO(today)})`,
    );
  }

  const machine = await resolveSiteThroughputMachine(args.siteId);
  if (!machine) throw new NoMachineForSiteError();

  const existing = await prisma.equipmentDailyThroughput.findFirst({
    where: { equipment_id: machine.id, throughput_date: day, voided_at: null },
  });

  // ADR-0079 D4 — the prior-day refusal. Deliberately AFTER `existing` is loaded
  // so the 409 can show the manager what is on record versus what they typed;
  // a refusal that cannot say what it is refusing to change is not actionable.
  if (day.getTime() < today.getTime()) {
    throw new DailyThroughputAmendmentRequiredError(
      dayISO(day),
      dayISO(today),
      existing
        ? { unitsProcessed: existing.units_processed, runHours: existing.run_hours.toString() }
        : null,
      { unitsProcessed: shape.unitsProcessed, runHours: shape.runHours.toString() },
    );
  }

  // Snapshot the BEFORE side before anything can mutate it. The audit's `before`
  // is the only record of what the number used to be (hard rule #6 — the row
  // itself is overwritten in place), so it must not be read back off an object
  // the update has already touched.
  const before = existing
    ? { units_processed: existing.units_processed, run_hours: existing.run_hours.toString() }
    : null;

  const row = await prisma.$transaction(async (tx) => {
    // `before` is non-null exactly when `existing` is; testing both narrows the
    // audit payload's type without an assertion.
    if (existing && before) {
      const updated = await tx.equipmentDailyThroughput.update({
        where: { id: existing.id },
        data: {
          units_processed: shape.unitsProcessed,
          run_hours: shape.runHours,
          ...(args.notes !== undefined ? { notes: clean(args.notes) } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          ...auditActor(args.actor),
          action: 'update',
          table_name: TABLE,
          row_id: existing.id,
          before,
          after: {
            units_processed: shape.unitsProcessed,
            run_hours: shape.runHours.toString(),
          },
        },
      });
      return updated;
    }

    const created = await tx.equipmentDailyThroughput.create({
      data: {
        site_id: args.siteId,
        equipment_id: machine.id,
        throughput_date: day,
        units_processed: shape.unitsProcessed,
        run_hours: shape.runHours,
        notes: clean(args.notes),
        ...actorColumns(args.actor),
      },
    });
    await tx.auditLog.create({
      data: {
        ...auditActor(args.actor),
        action: 'insert',
        table_name: TABLE,
        row_id: created.id,
        after: {
          equipment_id: machine.id,
          throughput_date: dayISO(day),
          units_processed: shape.unitsProcessed,
          run_hours: shape.runHours.toString(),
        },
      },
    });
    return created;
  });

  return toView(row as DailyRow);
}

/**
 * Soft-void an entry (hard rule #6 — no hard delete). The day becomes
 * "not recorded" again and is re-enterable, because the unique index is partial
 * on `voided_at IS NULL`. Idempotent: re-voiding writes no second audit row.
 */
export async function voidDailyThroughput(args: {
  id: string;
  siteId: string;
  actor: AnyActorContext;
}): Promise<DailyThroughputView> {
  const existing = await prisma.equipmentDailyThroughput.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId)
    throw new DailyThroughputNotFoundError(args.id);
  if (existing.voided_at) return toView(existing as DailyRow);

  const row = await prisma.$transaction(async (tx) => {
    const voided = await tx.equipmentDailyThroughput.update({
      where: { id: args.id },
      data: {
        voided_at: new Date(),
        voided_by: isSystemActor(args.actor) ? null : args.actor.actorUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        ...auditActor(args.actor),
        action: 'soft_delete',
        table_name: TABLE,
        row_id: args.id,
        before: {
          voided_at: null,
          units_processed: existing.units_processed,
          run_hours: existing.run_hours.toString(),
        },
        after: { voided_at: voided.voided_at?.toISOString() ?? null },
      },
    });
    return voided;
  });
  return toView(row as DailyRow);
}

/** The machine's recorded days, newest first. Voided rows excluded by default. */
export async function listDailyThroughput(
  siteId: string,
  opts: { limit?: number; includeVoided?: boolean } = {},
): Promise<DailyThroughputView[]> {
  const machine = await resolveSiteThroughputMachine(siteId);
  if (!machine) return [];
  const rows = await prisma.equipmentDailyThroughput.findMany({
    where: {
      site_id: siteId,
      equipment_id: machine.id,
      ...(opts.includeVoided ? {} : { voided_at: null }),
    },
    orderBy: [{ throughput_date: 'desc' }, { created_at: 'desc' }],
    take: opts.limit ?? 60,
  });
  return rows.map((r) => toView(r as DailyRow));
}

/**
 * The machine's ENTERED days across a window, keyed by ISO day — the input the
 * throughput series and the tile read instead of the floor-wide derived total.
 *
 * A day with no row is ABSENT from the map, never a zero. That distinction is the
 * whole point (ADR-0077 D4): the caller must be able to tell "the machine
 * processed nothing" from "nobody wrote it down", and only the first is a number.
 */
export async function enteredThroughputByDay(
  siteId: string,
  startKey: Date,
  endKey: Date,
  machineId?: string,
): Promise<Map<string, { unitsProcessed: number; runHours: number }>> {
  const id = machineId ?? (await resolveSiteThroughputMachine(siteId))?.id;
  const out = new Map<string, { unitsProcessed: number; runHours: number }>();
  if (!id) return out;

  const rows = await prisma.equipmentDailyThroughput.findMany({
    where: {
      site_id: siteId,
      equipment_id: id,
      voided_at: null,
      throughput_date: { gte: startKey, lte: endKey },
    },
    select: { throughput_date: true, units_processed: true, run_hours: true },
  });
  for (const r of rows) {
    out.set(dayISO(r.throughput_date), {
      unitsProcessed: r.units_processed,
      runHours: r.run_hours.toNumber(),
    });
  }
  return out;
}
