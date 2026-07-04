// ADR-0041 D3 (Addendum B4 §4 Events / B5 wage constants) — collection_events
// manager service (CRUD-lite: create / list / update-before-lock).
//
// WAGE DEFAULTS, STORED AS ENTERED (the money-safety contract for this table):
//   - The B5 rules `driver_hourly` / `general_labor_hourly` / `per_diem_nightly`
//     (state_program_rules, via the D1 resolver) DEFAULT the wage cents when the
//     operator leaves them blank: driver_wages = round(driver_hours × driver_hourly),
//     labor_wages = round(labor_hours × general_labor_hourly).
//   - When the operator TYPES a wage, it is stored verbatim — the default never
//     overwrites it. Deviation-from-default is DERIVABLE (stored hours × resolved
//     rate vs stored wages), so it is never flagged here.
//   - Defaulting is BEST-EFFORT: if the site has no wage rule in force (e.g. an OR
//     site), the default is skipped and the wage is left null — capture is never
//     blocked. This differs from `consumer_dropoffs` (where the incentive IS the
//     system-owned billed number and a missing rule throws): here wages are entered
//     data the office owns, not a number Vision computes as truth.
//   - `per_diem_cents` has no nights count to multiply, so it is stored as entered;
//     the resolved nightly rate is surfaced by `resolveWageDefaultRates` for a UI
//     prefill, never auto-multiplied server-side.

import { Prisma, type RecordSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { resolveRateCents, NoActiveProgramRuleError } from '@/lib/program-rules/resolver';
import {
  RecordValidationError,
  RecordNotFoundError,
  assertUnlocked,
} from '@/lib/loads/record-guards';
import type { EventCostRow } from '@/lib/events/types';

const TABLE = 'collection_events';

function eventDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function assertCents(name: string, cents: number | null | undefined): void {
  if (cents == null) return;
  if (!Number.isInteger(cents) || cents < 0 || cents > 1_000_000_00) {
    throw new RecordValidationError(
      `${name} must be a whole number of cents in [0, 100000000] (got ${String(cents)})`,
    );
  }
}

function assertUnits(name: string, n: number | null | undefined): void {
  if (n == null) return;
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    throw new RecordValidationError(
      `${name} must be a whole number in [0, 1000000] (got ${String(n)})`,
    );
  }
}

/** Validate hours as a 0..999.99 value and normalize to a 2-dp Decimal for storage. */
function toHours(name: string, hours: number | null | undefined): Prisma.Decimal | null {
  if (hours == null) return null;
  if (!Number.isFinite(hours) || hours < 0 || hours > 999.99) {
    throw new RecordValidationError(
      `${name} must be a number in [0, 999.99] (got ${String(hours)})`,
    );
  }
  return new Prisma.Decimal(hours).toDecimalPlaces(2);
}

/**
 * The default wage cents for a span of hours at an hourly cents rate, rounded to
 * the nearest cent. Pure. `hourlyCents` is already cents-per-hour, so the product
 * is cents. e.g. 2.5 h × 12500¢/h = 31250¢ ($312.50).
 */
export function computeWageDefaultCents(hours: number, hourlyCents: number): number {
  return Math.round(hours * hourlyCents);
}

/** The three B5 wage/per-diem rates in force for a site on a date (null when absent). */
export interface WageDefaultRates {
  driverHourlyCents: number | null;
  generalLaborHourlyCents: number | null;
  perDiemNightlyCents: number | null;
}

/** Best-effort resolve of one flat rate; a missing rule yields null (not a throw). */
async function tryRate(
  siteId: string,
  kind: 'driver_hourly' | 'general_labor_hourly' | 'per_diem_nightly',
  onDate: Date,
): Promise<number | null> {
  try {
    return await resolveRateCents(siteId, kind, onDate);
  } catch (e) {
    if (e instanceof NoActiveProgramRuleError) {
      log.debug(
        { siteId, kind, date: onDate.toISOString().slice(0, 10) },
        '[events] no wage rule in force — default skipped',
      );
      return null;
    }
    throw e;
  }
}

/**
 * Resolve the B5 wage/per-diem rates for a site on a date. Best-effort per rate:
 * a rate with no rule in force comes back null (the wage default for it is skipped
 * rather than blocking capture). Exposed for the UI to prefill entry fields.
 */
export async function resolveWageDefaultRates(
  siteId: string,
  onDate: Date,
): Promise<WageDefaultRates> {
  const day = eventDateUTC(onDate);
  const [driverHourlyCents, generalLaborHourlyCents, perDiemNightlyCents] = await Promise.all([
    tryRate(siteId, 'driver_hourly', day),
    tryRate(siteId, 'general_labor_hourly', day),
    tryRate(siteId, 'per_diem_nightly', day),
  ]);
  return { driverHourlyCents, generalLaborHourlyCents, perDiemNightlyCents };
}

/** Full read projection for the manager list/entry surface. */
export interface EventView {
  id: string;
  siteId: string;
  eventDate: Date;
  customer: string;
  county: string | null;
  slipNumber: string | null;
  units: number | null;
  freightCents: number | null;
  driverHours: string | null;
  driverWagesCents: number | null;
  laborHours: string | null;
  laborWagesCents: number | null;
  mileage: number | null;
  mileageCents: number | null;
  perDiemCents: number | null;
  miscCents: number | null;
  retracId: string | null;
  notes: string | null;
  source: RecordSource;
  lockedAt: Date | null;
}

interface EventRow {
  id: string;
  site_id: string;
  event_date: Date;
  customer: string;
  county: string | null;
  slip_number: string | null;
  units: number | null;
  freight_cents: number | null;
  driver_hours: Prisma.Decimal | null;
  driver_wages_cents: number | null;
  labor_hours: Prisma.Decimal | null;
  labor_wages_cents: number | null;
  mileage: number | null;
  mileage_cents: number | null;
  per_diem_cents: number | null;
  misc_cents: number | null;
  retrac_id: string | null;
  notes: string | null;
  source: RecordSource;
  locked_at: Date | null;
}

function toView(r: EventRow): EventView {
  return {
    id: r.id,
    siteId: r.site_id,
    eventDate: r.event_date,
    customer: r.customer,
    county: r.county,
    slipNumber: r.slip_number,
    units: r.units,
    freightCents: r.freight_cents,
    driverHours: r.driver_hours?.toString() ?? null,
    driverWagesCents: r.driver_wages_cents,
    laborHours: r.labor_hours?.toString() ?? null,
    laborWagesCents: r.labor_wages_cents,
    mileage: r.mileage,
    mileageCents: r.mileage_cents,
    perDiemCents: r.per_diem_cents,
    miscCents: r.misc_cents,
    retracId: r.retrac_id,
    notes: r.notes,
    source: r.source,
    lockedAt: r.locked_at,
  };
}

/** The sibling invoice B8 projection of a stored row. */
export function toEventCostRow(r: EventRow): EventCostRow {
  return {
    id: r.id,
    siteId: r.site_id,
    eventDate: r.event_date,
    freightCents: r.freight_cents,
    driverWagesCents: r.driver_wages_cents,
    laborWagesCents: r.labor_wages_cents,
    mileageCents: r.mileage_cents,
    perDiemCents: r.per_diem_cents,
    miscCents: r.misc_cents,
  };
}

export interface CreateEventArgs {
  siteId: string;
  eventDate: Date;
  customer: string;
  county?: string | null;
  slipNumber?: string | null;
  units?: number | null;
  freightCents?: number | null;
  driverHours?: number | null;
  driverWagesCents?: number | null;
  laborHours?: number | null;
  laborWagesCents?: number | null;
  mileage?: number | null;
  mileageCents?: number | null;
  perDiemCents?: number | null;
  miscCents?: number | null;
  retracId?: string | null;
  notes?: string | null;
  actorUserId: string;
}

/**
 * Resolve the wage cents to persist: an explicitly-supplied value wins verbatim;
 * otherwise, when hours are present and a rate is in force, default from hours ×
 * rate; else leave null. Pure once the rates are resolved.
 */
function defaultedWageCents(
  suppliedCents: number | null | undefined,
  hours: number | null | undefined,
  hourlyCents: number | null,
): number | null {
  if (suppliedCents != null) return suppliedCents;
  if (hours != null && hourlyCents != null) return computeWageDefaultCents(hours, hourlyCents);
  return null;
}

export async function createEvent(args: CreateEventArgs): Promise<EventView> {
  if (!args.customer.trim()) throw new RecordValidationError('customer is required');
  const day = eventDateUTC(args.eventDate);
  assertUnits('units', args.units);
  assertUnits('mileage', args.mileage);
  assertCents('freight_cents', args.freightCents);
  assertCents('driver_wages_cents', args.driverWagesCents);
  assertCents('labor_wages_cents', args.laborWagesCents);
  assertCents('mileage_cents', args.mileageCents);
  assertCents('per_diem_cents', args.perDiemCents);
  assertCents('misc_cents', args.miscCents);
  const driverHours = toHours('driver_hours', args.driverHours);
  const laborHours = toHours('labor_hours', args.laborHours);

  // Resolve B5 wage rates only to DEFAULT blank wages (best-effort; stored as entered).
  const rates = await resolveWageDefaultRates(args.siteId, day);
  const driverWagesCents = defaultedWageCents(
    args.driverWagesCents,
    args.driverHours,
    rates.driverHourlyCents,
  );
  const laborWagesCents = defaultedWageCents(
    args.laborWagesCents,
    args.laborHours,
    rates.generalLaborHourlyCents,
  );

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.collectionEvent.create({
      data: {
        site_id: args.siteId,
        event_date: day,
        customer: args.customer.trim(),
        county: args.county ?? null,
        slip_number: args.slipNumber ?? null,
        units: args.units ?? null,
        freight_cents: args.freightCents ?? null,
        driver_hours: driverHours,
        driver_wages_cents: driverWagesCents,
        labor_hours: laborHours,
        labor_wages_cents: laborWagesCents,
        mileage: args.mileage ?? null,
        mileage_cents: args.mileageCents ?? null,
        per_diem_cents: args.perDiemCents ?? null,
        misc_cents: args.miscCents ?? null,
        retrac_id: args.retracId ?? null,
        notes: args.notes ?? null,
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
          event_date: day.toISOString().slice(0, 10),
          customer: created.customer,
          freight_cents: created.freight_cents,
          driver_wages_cents: created.driver_wages_cents,
          labor_wages_cents: created.labor_wages_cents,
        },
      },
    });
    return created;
  });
  return toView(row);
}

export interface UpdateEventArgs {
  id: string;
  siteId: string;
  // `| undefined` explicit (exactOptionalPropertyTypes; callers spread zod output).
  customer?: string | undefined;
  county?: string | null | undefined;
  slipNumber?: string | null | undefined;
  units?: number | null | undefined;
  freightCents?: number | null | undefined;
  driverHours?: number | null | undefined;
  driverWagesCents?: number | null | undefined;
  laborHours?: number | null | undefined;
  laborWagesCents?: number | null | undefined;
  mileage?: number | null | undefined;
  mileageCents?: number | null | undefined;
  perDiemCents?: number | null | undefined;
  miscCents?: number | null | undefined;
  retracId?: string | null | undefined;
  notes?: string | null | undefined;
  actorUserId: string;
}

export async function updateEvent(args: UpdateEventArgs): Promise<EventView> {
  const existing = await prisma.collectionEvent.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);
  assertUnlocked(TABLE, args.id, existing.locked_at);

  if (args.customer !== undefined && !args.customer.trim())
    throw new RecordValidationError('customer cannot be blank');
  if (args.units !== undefined) assertUnits('units', args.units);
  if (args.mileage !== undefined) assertUnits('mileage', args.mileage);
  if (args.freightCents !== undefined) assertCents('freight_cents', args.freightCents);
  if (args.driverWagesCents !== undefined) assertCents('driver_wages_cents', args.driverWagesCents);
  if (args.laborWagesCents !== undefined) assertCents('labor_wages_cents', args.laborWagesCents);
  if (args.mileageCents !== undefined) assertCents('mileage_cents', args.mileageCents);
  if (args.perDiemCents !== undefined) assertCents('per_diem_cents', args.perDiemCents);
  if (args.miscCents !== undefined) assertCents('misc_cents', args.miscCents);
  const driverHours =
    args.driverHours !== undefined ? toHours('driver_hours', args.driverHours) : undefined;
  const laborHours =
    args.laborHours !== undefined ? toHours('labor_hours', args.laborHours) : undefined;

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.collectionEvent.update({
      where: { id: args.id },
      data: {
        ...(args.customer !== undefined ? { customer: args.customer.trim() } : {}),
        ...(args.county !== undefined ? { county: args.county } : {}),
        ...(args.slipNumber !== undefined ? { slip_number: args.slipNumber } : {}),
        ...(args.units !== undefined ? { units: args.units } : {}),
        ...(args.freightCents !== undefined ? { freight_cents: args.freightCents } : {}),
        ...(driverHours !== undefined ? { driver_hours: driverHours } : {}),
        ...(args.driverWagesCents !== undefined
          ? { driver_wages_cents: args.driverWagesCents }
          : {}),
        ...(laborHours !== undefined ? { labor_hours: laborHours } : {}),
        ...(args.laborWagesCents !== undefined ? { labor_wages_cents: args.laborWagesCents } : {}),
        ...(args.mileage !== undefined ? { mileage: args.mileage } : {}),
        ...(args.mileageCents !== undefined ? { mileage_cents: args.mileageCents } : {}),
        ...(args.perDiemCents !== undefined ? { per_diem_cents: args.perDiemCents } : {}),
        ...(args.miscCents !== undefined ? { misc_cents: args.miscCents } : {}),
        ...(args.retracId !== undefined ? { retrac_id: args.retracId } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before: {
          freight_cents: existing.freight_cents,
          driver_wages_cents: existing.driver_wages_cents,
          labor_wages_cents: existing.labor_wages_cents,
        },
        after: {
          freight_cents: updated.freight_cents,
          driver_wages_cents: updated.driver_wages_cents,
          labor_wages_cents: updated.labor_wages_cents,
        },
      },
    });
    return updated;
  });
  return toView(row);
}

export async function listEvents(siteId: string, limit = 100): Promise<EventView[]> {
  const rows = await prisma.collectionEvent.findMany({
    where: { site_id: siteId },
    orderBy: { event_date: 'desc' },
    take: limit,
  });
  return rows.map(toView);
}

/**
 * The sibling invoice B8 seam: the `EventCostRow` projection for a site over a
 * date window `[from, to]` (inclusive), oldest first. Money-path read the invoice
 * engine can reuse rather than re-deriving the mapping.
 */
export async function listEventCostRows(
  siteId: string,
  from: Date,
  to: Date,
): Promise<EventCostRow[]> {
  const rows = await prisma.collectionEvent.findMany({
    where: { site_id: siteId, event_date: { gte: eventDateUTC(from), lte: eventDateUTC(to) } },
    orderBy: { event_date: 'asc' },
  });
  return rows.map(toEventCostRow);
}
