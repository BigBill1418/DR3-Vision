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
import { log } from '@/lib/observability/logger';
import { resolveProgramRule, NoActiveProgramRuleError } from '@/lib/program-rules/resolver';
import { computeDropoffIncentive, paidUnitsFromIncentiveCents } from '@/lib/dropoffs/incentive';
import {
  RecordValidationError,
  RecordNotFoundError,
  assertUnlocked,
} from '@/lib/loads/record-guards';

const TABLE = 'consumer_dropoffs';

/**
 * A stored `incentive_cents` could not be reconciled to the current rate (a mid-day
 * rate change or corrupt data). Surfaced as a 500 with context rather than letting a
 * bare RangeError escape — the office needs to know WHOSE row and WHICH day so the
 * data gap can be fixed, not a stack trace.
 */
export class IncentiveComputationError extends Error {
  readonly status = 500 as const;
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'IncentiveComputationError';
  }
}

function dropoffDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function assertWholeUnits(units: number): void {
  if (!Number.isInteger(units) || units <= 0 || units > 100000) {
    throw new RecordValidationError(
      `units must be a whole number in [1, 100000] (got ${String(units)})`,
    );
  }
}

/** Read the cap (units/person/day) from the resolved rule's params, or fail loudly. */
function dailyCapUnits(params: Record<string, unknown> | null): number {
  const cap = Number(params?.['daily_cap_units']);
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new RecordValidationError(
      'collector_incentive rule is missing a valid params.daily_cap_units',
    );
  }
  return cap;
}

/**
 * ADR-0037 amendment (§1.3) — the Bye-Bye-Mattress default for the explicit check amount
 * on an UNPAID / ILLEGAL drop-off: $3/unit = 300¢/unit. Overridable at capture.
 */
export const UNPAID_DROPOFF_CENTS_PER_UNIT = 300;

/** §1.3 — the default `incentive_amount_cents` for a kind, or `null` (incentive kind). */
function defaultIncentiveAmountCents(
  kind: ConsumerDropoffKind,
  units: number,
  override: number | null | undefined,
): number | null {
  if (override !== undefined && override !== null) return override;
  // Incentive drop-offs carry the rule-capped `incentive_cents`; the explicit-amount field
  // is for the un-incentivized (unpaid / illegal) Bye-Bye-Mattress check.
  if (kind === 'incentive') return null;
  return units * UNPAID_DROPOFF_CENTS_PER_UNIT;
}

export interface DropoffView {
  id: string;
  siteId: string;
  dropoffDate: Date;
  kind: ConsumerDropoffKind;
  personName: string;
  consumerName: string | null;
  slipNumber: string | null;
  units: number;
  incentiveCents: number | null;
  incentiveAmountCents: number | null;
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
  consumer_name: string | null;
  slip_number: string | null;
  units: number;
  incentive_cents: number | null;
  incentive_amount_cents: number | null;
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
    consumerName: r.consumer_name,
    slipNumber: r.slip_number,
    units: r.units,
    incentiveCents: r.incentive_cents,
    incentiveAmountCents: r.incentive_amount_cents,
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
  const dateKey = day.toISOString().slice(0, 10);
  let rule;
  try {
    rule = await resolveProgramRule(siteId, 'collector_incentive', day);
  } catch (e) {
    // A missing rule means we'd have to credit $0 blind — log the (site, date) so
    // the office knows which effective-dated rule row to seed, then rethrow.
    if (e instanceof NoActiveProgramRuleError) {
      log.warn(
        { siteId, date: dateKey, ruleKind: 'collector_incentive' },
        '[dropoffs] no active collector_incentive rule — cannot compute incentive',
      );
    }
    throw e;
  }
  if (rule.rateCents == null) {
    throw new RecordValidationError('collector_incentive rule has no rate_cents');
  }
  const rateCents = rule.rateCents;
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
  let priorPaidUnitsToday: number;
  try {
    priorPaidUnitsToday = priors.reduce(
      (sum, p) => sum + paidUnitsFromIncentiveCents(p.incentive_cents, rateCents),
      0,
    );
  } catch (e) {
    // paidUnitsFromIncentiveCents throws when a stored incentive_cents is not
    // divisible by the current rate. A bare RangeError would 500 with no context;
    // log the offending row ids/date and rethrow a typed 500 the office can act on.
    // Deliberately NOT logging person_name: it is CIP PII (Exhibit I / ADR-0010)
    // and log retention is not the DB — the row ids identify the records for
    // anyone with legitimate access.
    log.error(
      { siteId, date: dateKey, rateCents, priorRowCount: priors.length, err: e },
      '[dropoffs] failed to recover prior paid units from a stored incentive_cents',
    );
    throw new IncentiveComputationError(
      'incentive_recovery_failed',
      `could not recover prior paid units for a drop-off on ${dateKey} — a stored incentive_cents is not divisible by the current rate (${rateCents}¢); resolve the data gap`,
    );
  }
  return computeDropoffIncentive({
    units,
    rateCents,
    dailyCapUnits: cap,
    priorPaidUnitsToday,
  }).incentiveCents;
}

export async function createDropoff(args: {
  siteId: string;
  dropoffDate: Date;
  kind: ConsumerDropoffKind;
  personName: string;
  consumerName?: string | null;
  units: number;
  slipNumber?: string | null;
  checkNumber?: string | null;
  retracId?: string | null;
  // §1.3 — explicit unpaid/illegal check amount; when omitted, defaults to units × 300¢.
  incentiveAmountCents?: number | null;
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
  const incentiveAmountCents = defaultIncentiveAmountCents(
    args.kind,
    args.units,
    args.incentiveAmountCents,
  );

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.consumerDropoff.create({
      data: {
        site_id: args.siteId,
        dropoff_date: day,
        kind: args.kind,
        person_name: args.personName.trim(),
        consumer_name: args.consumerName?.trim() || null,
        units: args.units,
        incentive_cents: incentiveCents,
        incentive_amount_cents: incentiveAmountCents,
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
        after: {
          dropoff_date: day.toISOString().slice(0, 10),
          kind: args.kind,
          units: args.units,
          incentive_cents: incentiveCents,
        },
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
  consumerName?: string | null | undefined;
  slipNumber?: string | null | undefined;
  checkNumber?: string | null | undefined;
  retracId?: string | null | undefined;
  incentiveAmountCents?: number | null | undefined;
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
      ? await computeIncentiveCents(
          args.siteId,
          existing.person_name,
          existing.dropoff_date,
          units,
          args.id,
        )
      : null;
  // §1.3 — re-derive the explicit amount: an explicit override wins; else if units or kind
  // changed, recompute the units×300 default (incentive kind → null).
  const incentiveAmountCents =
    args.incentiveAmountCents !== undefined
      ? defaultIncentiveAmountCents(kind, units, args.incentiveAmountCents)
      : defaultIncentiveAmountCents(kind, units, existing.incentive_amount_cents);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.consumerDropoff.update({
      where: { id: args.id },
      data: {
        units,
        kind,
        incentive_cents: incentiveCents,
        incentive_amount_cents: incentiveAmountCents,
        ...(args.consumerName !== undefined
          ? { consumer_name: args.consumerName?.trim() || null }
          : {}),
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
        before: {
          units: existing.units,
          kind: existing.kind,
          incentive_cents: existing.incentive_cents,
        },
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
