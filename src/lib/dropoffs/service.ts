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
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
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

export function assertWholeUnits(units: number): void {
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

/**
 * ADR-0085 — does this kind mint a Bye-Bye-Mattress check amount by DEFAULT?
 *
 * This function exists because the predicate it replaces was inverted, and the
 * inversion was invisible for a year.
 *
 * The old shape was `if (kind === 'incentive') return null; return units × 300`.
 * Read as a policy that is: *every kind mints $3/unit of check money except the
 * one named exception* — an allowlist of one, guarding the wrong side. Adding
 * ANY enum value silently enrolled it in a payout. That is not hypothetical: this
 * ADR adds two kinds to a flow Bill specified as carrying no money whatsoever,
 * and a version of it that only added enum values would have written 300¢/unit
 * on every walk-up drop-off at both sites with nothing anywhere objecting.
 *
 * Now the allowlist names the kinds that DO mint, and everything else is refused.
 * Two independent guards, on purpose:
 *
 *   - the `never` assertion below makes a new `ConsumerDropoffKind` a COMPILE
 *     ERROR here, so whoever adds one has to state in this file whether it
 *     carries money;
 *   - the trailing `return false` is the RUNTIME floor for the case the compiler
 *     cannot see — a migration that ships a label before the code that knows
 *     about it, a value that arrives through an `as` cast, a row written by an
 *     older deploy. An unclassified kind mints NOTHING.
 *
 * The compile error is what makes the decision explicit. The runtime deny is what
 * holds when the decision was never made.
 *
 * **The `never` assertion is load-bearing and was nearly omitted.** A covered
 * `switch` followed by `return false` type-checks perfectly happily when a new
 * enum member appears: every path still returns `boolean`, so the new member just
 * falls through to the floor and `tsc` exits 0. Reviewed on PR #217 and verified
 * by compiling the shipped shape against an extra member — it passed. The runtime
 * deny alone is the WRONG failure for a kind that SHOULD pay: it would silently
 * pay nothing, which is the same class of quiet-money defect as the inversion
 * this function was rewritten to fix, pointed the other way. Deleting the
 * assertion restores that hole while leaving every test green.
 */
function mintsCheckMoneyByDefault(kind: ConsumerDropoffKind): boolean {
  switch (kind) {
    // §1.3 — the explicit-amount field is for the un-incentivized (unpaid /
    // illegal) Bye-Bye-Mattress check. These two, and only these two.
    case 'unpaid':
    case 'illegal':
      return true;
    // Incentive drop-offs carry the rule-capped `incentive_cents` instead; the
    // explicit-amount field is not theirs.
    case 'incentive':
      return false;
    // Label-only. No money, ever — not even the Incentive programme's $3/unit,
    // which is tracked elsewhere (Bill, 2026-08-07). Also enforced below the
    // application by `consumer_dropoffs_floor_no_money_or_pii`, so a caller that
    // routed around this function still cannot write a cents value.
    case 'floor_public':
    case 'floor_incentive':
      return false;
  }

  // The compile-time half. With every member covered above, `kind` narrows to
  // `never` here and this assignment is legal. Add a member without adding a
  // case and `kind` is that member instead — TS2322, in this file, naming the
  // kind nobody classified.
  //
  // Do NOT "simplify" this away because the switch already looks exhaustive: the
  // `return false` below means the function still type-checks without it, so its
  // absence is invisible. See the header.
  const unclassified: never = kind;
  void unclassified;

  // The runtime half. Unreachable while the switch above is exhaustive; the
  // floor for a value that reached us anyway.
  return false;
}

/** §1.3 — the default `incentive_amount_cents` for a kind. */
function defaultIncentiveAmountCents(
  kind: ConsumerDropoffKind,
  units: number,
  override: number | null | undefined,
): number | null {
  if (override !== undefined && override !== null) return override;
  if (!mintsCheckMoneyByDefault(kind)) return null;
  return units * UNPAID_DROPOFF_CENTS_PER_UNIT;
}

/**
 * Test seam for the deny-by-default floor above.
 *
 * Exported ONLY so `service.money-minting.test.ts` can present a kind the enum
 * does not contain — the "a migration shipped a label before the code" case,
 * which is unreachable through `createDropoff` because zod rejects the value at
 * the route and TypeScript rejects it at the call site. A guard whose failure
 * mode cannot be exercised is a guard nobody has checked.
 */
export const __mintsCheckMoneyByDefaultForTest = mintsCheckMoneyByDefault;

/**
 * An `incentive` row with a NULL `person_name` — impossible while the
 * `consumer_dropoffs_non_floor_requires_person` CHECK holds, so reaching this
 * means the constraint was dropped or the row predates it. Throws rather than
 * substituting a placeholder: the name is the aggregation key for the per-person
 * daily incentive cap, and a stand-in would pool strangers into one person's cap
 * and under-pay them. Loud beats plausible where money is involved.
 */
function assertPersonName(rowId: string): never {
  throw new RecordValidationError(
    `drop-off ${rowId} is an incentive row with no person_name — the per-person daily cap ` +
      'cannot be computed without one; fix the row before editing it',
  );
}

export interface DropoffView {
  id: string;
  siteId: string;
  dropoffDate: Date;
  kind: ConsumerDropoffKind;
  /** ADR-0085 — null for the `floor_*` kinds, which capture no identity at all. */
  personName: string | null;
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
  person_name: string | null;
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
 *
 * ## ADR-0085 — how the cap treats the anonymous `floor_*` rows
 *
 * It does not see them, and that is the correct answer rather than a gap.
 *
 * The cap is a MONEY control: it bounds how many units one person can be PAID
 * for in a day. `floor_public` / `floor_incentive` rows are never paid — no rule
 * is resolved, no `incentive_cents` is computed, and the
 * `consumer_dropoffs_floor_no_money_or_pii` CHECK refuses a row that carries a
 * cents value at all. A cap on an unpaid row would be a cap on nothing.
 *
 * Two mechanical consequences of `person_name` now being nullable, both benign:
 *
 *   - **The anonymous rows cannot be pooled into someone's cap.** The `priors`
 *     query below matches `person_name = <string>`. In SQL a comparison against
 *     NULL is never true, so a floor row is invisible to every person's running
 *     total. If it were not, a stranger's walk-up would silently consume a named
 *     collector's daily allowance and under-pay them.
 *   - **The cap cannot be bypassed by omitting a name.** Reaching this function
 *     at all requires `kind === 'incentive'`, and an `incentive` row with a NULL
 *     `person_name` is refused by `consumer_dropoffs_non_floor_requires_person`.
 *     There is no path that pays money to nobody.
 *
 * The `@@index([site_id, person_name, dropoff_date])` that serves this query is
 * unaffected — a Postgres btree indexes NULLs, and they simply never satisfy the
 * equality predicate.
 *
 * NULL is also the COMPLIANT choice, not merely the convenient one. `person_name`
 * is MRC Personal Data (charter Exhibit I / ADR-0010): it carries breach-
 * notification scope and a 10-business-day deletion-on-termination obligation.
 * A walk-up at the door has no payout to attach a name to, so collecting one
 * would extend that obligation over people the programme has no reason to hold
 * records about. Not collecting it is the smaller footprint and the smaller duty.
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
    // ADR-0120 — serialise against workbook promotion at this site, FIRST
    // statement in the transaction so the hold is the write itself.
    await lockSiteAgainstPromotion(tx, args.siteId);
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

  // ADR-0085 — the two families do not convert into one another.
  //
  // A floor row has no name by construction and a manager row is required to
  // have one, so either direction of this transition would leave the row on the
  // wrong side of `consumer_dropoffs_non_floor_requires_person` (or, going the
  // other way, on the wrong side of `..._floor_no_money_or_pii`). Without this
  // the write reaches Postgres and comes back as a raw constraint violation —
  // a 500 with a constraint name in it, which tells the office nothing. Refused
  // here, in the language of the thing the manager was trying to do.
  const isFloor = (k: ConsumerDropoffKind): boolean =>
    k === 'floor_public' || k === 'floor_incentive';
  if (isFloor(kind) !== isFloor(existing.kind)) {
    throw new RecordValidationError(
      'an iPad drop-off cannot be converted to a manager drop-off (or back): the two carry ' +
        'different required fields — money and a payee name on one, neither on the other',
    );
  }

  const incentiveCents =
    kind === 'incentive'
      ? await computeIncentiveCents(
          args.siteId,
          // Non-floor kinds are guaranteed a name by the
          // `consumer_dropoffs_non_floor_requires_person` CHECK; the `??` satisfies
          // the compiler for the nullable column and is unreachable in practice.
          // NOT defaulted to a placeholder: `computeIncentiveCents` aggregates the
          // per-person daily cap BY this string, so a stand-in would silently pool
          // unrelated people's units into one cap.
          existing.person_name ?? assertPersonName(args.id),
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
