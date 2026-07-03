// ADR-0040 D4 (Addendum B3) — CA fuel-surcharge computation.
//
// This is the P2 calculator the P1 program-rules resolver deliberately refused
// (`computeFuelSurchargeCents` there throws `computation_not_implemented`). It wires
// the three inputs the surcharge needs:
//   - the weekly diesel index (`fuel_prices`, keyed by the Monday of the week), and
//   - the CA `fuel_surcharge` rule's params (`trigger_usd_per_gal`, `mpg`) read
//     through the EXISTING `resolveProgramRule` — which is also the OR structural
//     guard: an OR site throws `RuleStructurallyDisallowedError` before any price is
//     ever consulted (ADR-0037 D1 / ADR-0040 D4).
//
// Contract (Addendum B3): the surcharge applies IFF `price > trigger` ($5.05, in
// state_program_rules) — `$5.05` exactly is NOT above the trigger, so no surcharge.
// When it applies: `surcharge = (price / mpg) × miles` dollars, rounded to cents.
// A missing week's price is a typed {@link MissingFuelPriceError}, never a silent $0
// (ADR-0040 D7 — money paths fail loud).
//
// Week convention (documented once, here): a load's fuel week is the UTC Monday of
// the ISO week the load date falls in (Mon–Sun). EIA publishes the West Coast weekly
// retail diesel price stamped on the Monday of each week, so `fuel_prices.week_of`
// stores that Monday and `mondayOfWeekUTC()` maps any load date onto it.

import { resolveProgramRule } from '@/lib/program-rules/resolver';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';

/** No `fuel_prices` row exists for the requested week. */
export class MissingFuelPriceError extends Error {
  readonly status = 422 as const;
  constructor(readonly weekOf: string) {
    super(`no fuel price on record for week starting ${weekOf} (Monday)`);
    this.name = 'MissingFuelPriceError';
  }
}

/** The CA `fuel_surcharge` rule is missing `trigger_usd_per_gal` / `mpg` params. */
export class FuelSurchargeConfigError extends Error {
  readonly status = 422 as const;
  constructor(readonly missing: 'trigger_usd_per_gal' | 'mpg', readonly ruleId: string) {
    super(`fuel_surcharge rule ${ruleId} is missing required param '${missing}'`);
    this.name = 'FuelSurchargeConfigError';
  }
}

/**
 * The UTC Monday of the ISO week containing `date`. JS `getUTCDay()` is 0=Sun..6=Sat;
 * we shift so Monday is day 0 of the week, then subtract that offset.
 */
export function mondayOfWeekUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offsetFromMonday = (d.getUTCDay() + 6) % 7; // Mon→0, Tue→1, …, Sun→6
  d.setUTCDate(d.getUTCDate() - offsetFromMonday);
  return d;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** True iff the price is strictly above the trigger — `$5.05` exactly does NOT apply. */
export function fuelSurchargeApplies(usdPerGal: number, triggerUsdPerGal: number): boolean {
  return usdPerGal > triggerUsdPerGal;
}

export interface FuelPriceLookup {
  usdPerGal: number;
  weekOf: Date;
  source: 'eia_api' | 'manual';
}

/**
 * Resolve the diesel index for the week containing `date`. Throws
 * {@link MissingFuelPriceError} when no row exists — never returns a default.
 */
export async function resolveFuelPrice(date: Date): Promise<FuelPriceLookup> {
  const weekOf = mondayOfWeekUTC(date);
  const row = await prisma.fuelPrice.findUnique({ where: { week_of: weekOf } });
  if (!row) {
    log.warn({ week_of: isoDay(weekOf), date: isoDay(date) }, '[fuel] no price on record for week');
    throw new MissingFuelPriceError(isoDay(weekOf));
  }
  return { usdPerGal: Number(row.usd_per_gal), weekOf, source: row.source };
}

export interface FuelSurchargeResult {
  /** Integer cents of surcharge; 0 when the price is at/below the trigger. */
  cents: number;
  applied: boolean;
  usdPerGal: number;
  triggerUsdPerGal: number;
  mpg: number;
  ref: { rule_id: string; fuel_price_week: string };
}

export interface ComputeFuelSurchargeArgs {
  siteId: string;
  date: Date;
  /** Billable miles for the haul the surcharge rides on. */
  miles: number;
}

/**
 * Compute the CA fuel surcharge in integer cents for a haul.
 *
 * Throws (never silently 0):
 *   - `RuleStructurallyDisallowedError` for an OR site (via `resolveProgramRule`),
 *   - `NoActiveProgramRuleError` when no CA fuel rule is in force on the date,
 *   - {@link FuelSurchargeConfigError} when the rule lacks trigger/mpg params,
 *   - {@link MissingFuelPriceError} when the week's diesel price is not on record.
 *
 * Returns `{ cents: 0, applied: false }` ONLY when a price IS on record but is at or
 * below the trigger — a real, computed "no surcharge this week", not a missing input.
 */
export async function computeFuelSurchargeCents(
  args: ComputeFuelSurchargeArgs,
): Promise<FuelSurchargeResult> {
  // resolveProgramRule is the OR structural guard: it throws
  // RuleStructurallyDisallowedError for an OR site BEFORE any fuel price is read.
  const rule = await resolveProgramRule(args.siteId, 'fuel_surcharge', args.date);

  const trigger = numericParam(rule.params, 'trigger_usd_per_gal');
  if (trigger == null) throw new FuelSurchargeConfigError('trigger_usd_per_gal', rule.id);
  const mpg = numericParam(rule.params, 'mpg');
  if (mpg == null) throw new FuelSurchargeConfigError('mpg', rule.id);

  const price = await resolveFuelPrice(args.date);
  const ref = { rule_id: rule.id, fuel_price_week: isoDay(price.weekOf) };

  if (!fuelSurchargeApplies(price.usdPerGal, trigger)) {
    log.debug(
      { site_id: args.siteId, date: isoDay(args.date), price: price.usdPerGal, trigger, applied: false },
      '[fuel] price at/below trigger — no surcharge',
    );
    return {
      cents: 0,
      applied: false,
      usdPerGal: price.usdPerGal,
      triggerUsdPerGal: trigger,
      mpg,
      ref,
    };
  }

  // (price $/gal ÷ mpg mi/gal) = $/mi; × miles = dollars; × 100 = cents.
  const cents = Math.round((price.usdPerGal / mpg) * args.miles * 100);
  log.debug(
    { site_id: args.siteId, date: isoDay(args.date), price: price.usdPerGal, trigger, mpg, miles: args.miles, cents },
    '[fuel] surcharge computed',
  );
  return { cents, applied: true, usdPerGal: price.usdPerGal, triggerUsdPerGal: trigger, mpg, ref };
}

function numericParam(params: Record<string, unknown> | null, key: string): number | null {
  const v = params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
