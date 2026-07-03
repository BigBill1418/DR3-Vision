// ADR-0037 D3 (Addendum B1) — consumer_dropoffs manager service (CRUD-lite).
//
// Ties the D1 rule resolver + the pure incentive cap function to the DB. A drop-off
// carries a `kind` (Addendum B1): only `incentive` drop-offs resolve the site's
// `collector_incentive` rule (rate + daily_cap_units) and compute `incentive_cents`
// capped per person per day; `unpaid` and `illegal` drop-offs need no rule and
// carry a null incentive. Requiring a resolvable rule for incentive drop-offs
// surfaces a missing-config error rather than silently crediting $0 (money-safety,
// bonus-system lesson).
//
// PII: `person_name` (and any future phone/plate/signature fields) is MRC
// Personal Data — charter Exhibit I / ADR-0010. It is fine on this manager
// surface but MUST be excluded from any CSV/export surface (breach-notification
// scope, 10-business-day deletion-on-termination). Do not add it to exports.

import { type ConsumerDropoffKind } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveProgramRule } from '@/lib/program-rules/resolver';
import { computeDropoffIncentive, paidUnitsFromIncentiveCents } from '@/lib/dropoffs/incentive';
import { RecordValidationError, RecordNotFoundError, assertUnlocked } from '@/lib/loads/record-guards';

const TABLE = 'consumer_dropoffs';

function dropoffDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function assertWholeUnits(units: number): void {
  if (!Number.isInteger(units) || units <= 0 || units > 100000) {
    throw new RecordValidationError(`units must be a whole number in [1, 100000] (got ${String(units)})`);
  }
}

/** Read the cap (units/person/day) from the resolved rule's params, or fail loudly. */
function dailyCapUnits(params: Record<string, unknown> | null): number {
  const cap = Number(params?.['daily_cap_units']);
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new RecordValidationError('collector_incentive rule is missing a valid params.daily_cap_units');
  }
  return cap;
}

export interface DropoffView {
  id: string;
  siteId: string;
  dropoffDate: Date;
  kind: ConsumerDropoffKind;
  personName: string;
  slipNumber: string | null;
  units: number;
  incentiveCents: number | null;
  checkNumber: string | null;
  paidAt: Date | null;
  retracId: string | null;
  source: string;
  lockedAt: Date | null;
}

function toView(r: {
  id: string;
  site_id: string;
  dropoff_date: Date;
  kind: ConsumerDropoffKind;
  person_name: string;
  slip_number: string | null;
  units: number;
  incentive_cents: number | null;
  check_number: string | null;
  paid_at: Date | null;
  retrac_id: string | null;
  source: string;
  locked_at: Date | null;
}): DropoffView {
  return {
    id: r.id,
    siteId: r.site_id,
    dropoffDate: r.dropoff_date,
    kind: r.kind,
    personName: r.person_name,
    slipNumber: r.slip_number,
    units: r.units,
    incentiveCents: r.incentive_cents,
    checkNumber: r.check_number,
    paidAt: r.paid_at,
    retracId: r.retrac_id,
    source: r.source,
    lockedAt: r.locked_at,
  };
}

/**
 * Compute the incentive for a (person, day) at a site, honoring the running
 * per-person daily cap. `excludeId` omits a row being edited from the prior sum.
 */
async function computeIncentiveCents(
  siteId: string,
  personName: string,
  day: Date,
  units: number,
  excludeId?: string,
): Promise<number> {
  const rule = await resolveProgramRule(siteId, 'collector_incentive', day);
  if (rule.rateCents == null) {
    throw new RecordValidationError('collector_incentive rule has no rate_cents');
  }
  const cap = dailyCapUnits(rule.params);
  const priors = await prisma.consumerDropoff.findMany({
    where: {
      site_id: siteId,
      person_name: personName,
      dropoff_date: day,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { incentive_cents: true },
  });
  const priorPaidUnitsToday = priors.reduce(
    (sum, p) => sum + paidUnitsFromIncentiveCents(p.incentive_cents, rule.rateCents as number),
    0,
  );
  return computeDropoffIncentive({
    units,
    rateCents: rule.rateCents,
    dailyCapUnits: cap,
    priorPaidUnitsToday,
  }).incentiveCents;
}

export async function createDropoff(args: {
  siteId: string;
  dropoffDate: Date;
  kind: ConsumerDropoffKind;
  personName: string;
  units: number;
  slipNumber?: string | null;
  checkNumber?: string | null;
  retracId?: string | null;
  actorUserId: string;
}): Promise<DropoffView> {
  assertWholeUnits(args.units);
  if (!args.personName.trim()) throw new RecordValidationError('person_name is required');
  const day = dropoffDateUTC(args.dropoffDate);
  // Only `incentive` drop-offs are ever paid — `unpaid`/`illegal` carry no incentive.
  const incentiveCents =
    args.kind === 'incentive'
      ? await computeIncentiveCents(args.siteId, args.personName.trim(), day, args.units)
      : null;

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.consumerDropoff.create({
      data: {
        site_id: args.siteId,
        dropoff_date: day,
        kind: args.kind,
        person_name: args.personName.trim(),
        units: args.units,
        incentive_cents: incentiveCents,
        slip_number: args.slipNumber ?? null,
        check_number: args.checkNumber ?? null,
        retrac_id: args.retracId ?? null,
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
        // NOTE: person_name is CIP PII (Exhibit I / ADR-0010) but the audit log is
        // access-controlled + append-only; recording it here preserves the who/what.
        after: { dropoff_date: day.toISOString().slice(0, 10), kind: args.kind, units: args.units, incentive_cents: incentiveCents },
      },
    });
    return created;
  });
  return toView(row);
}

export async function updateDropoff(args: {
  id: string;
  siteId: string;
  // `| undefined` is explicit — the repo runs exactOptionalPropertyTypes and
  // callers spread zod `.optional()` output (T | undefined) into this shape.
  units?: number | undefined;
  kind?: ConsumerDropoffKind | undefined;
  slipNumber?: string | null | undefined;
  checkNumber?: string | null | undefined;
  retracId?: string | null | undefined;
  actorUserId: string;
}): Promise<DropoffView> {
  const existing = await prisma.consumerDropoff.findUnique({ where: { id: args.id } });
  if (!existing || existing.site_id !== args.siteId) throw new RecordNotFoundError(TABLE, args.id);
  assertUnlocked(TABLE, args.id, existing.locked_at);

  const units = args.units ?? existing.units;
  assertWholeUnits(units);
  const kind = args.kind ?? existing.kind;
  const incentiveCents =
    kind === 'incentive'
      ? await computeIncentiveCents(args.siteId, existing.person_name, existing.dropoff_date, units, args.id)
      : null;

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.consumerDropoff.update({
      where: { id: args.id },
      data: {
        units,
        kind,
        incentive_cents: incentiveCents,
        ...(args.slipNumber !== undefined ? { slip_number: args.slipNumber } : {}),
        ...(args.checkNumber !== undefined ? { check_number: args.checkNumber } : {}),
        ...(args.retracId !== undefined ? { retrac_id: args.retracId } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: args.id,
        before: { units: existing.units, kind: existing.kind, incentive_cents: existing.incentive_cents },
        after: { units, kind, incentive_cents: incentiveCents },
      },
    });
    return updated;
  });
  return toView(row);
}

export async function listDropoffs(siteId: string, limit = 100): Promise<DropoffView[]> {
  const rows = await prisma.consumerDropoff.findMany({
    where: { site_id: siteId },
    orderBy: { dropoff_date: 'desc' },
    take: limit,
  });
  return rows.map(toView);
}
