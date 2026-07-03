// ADR-0037 D1 — strict, effective-dated resolver for `state_program_rules`.
//
// Every rate and program rule is DATA, never code (mission §10; CLAUDE.md hard
// rule #3 parallels the bonus system's `resolveActiveRule`). This module is the
// single named resolver for the loads/inventory/billing layer: it picks the row
// whose `effective_from <= onDate` and whose `effective_to` is null or `>= onDate`,
// latest `effective_from` winning — exactly the `processor_bonus_rules` pattern.
//
// TWO structural guards protect the OR-fuel-surcharge impossibility (D1), so a
// future seeding mistake still can't silently bill it:
//   1. The seed never writes a `fuel_surcharge` rule for an Oregon site.
//   2. THIS resolver throws `RuleStructurallyDisallowedError` for any
//      `fuel_surcharge` lookup against an OR-jurisdiction site — read from the
//      site row, never hardcoded to a site id.
//
// Fuel COMPUTATION is deliberately not wired here. `computeFuelSurchargeCents`
// refuses (typed error) while `params.formula` is null, and — even now that the
// CA formula string is captured — still refuses because the actual per-haul
// calculator (EIA rate lookup × miles) is P2 billing scope, not P1 foundations.

import { type StateProgramRuleKind, type Jurisdiction } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** No `state_program_rules` row covers the requested (site, kind, date). */
export class NoActiveProgramRuleError extends Error {
  readonly status = 409 as const;
  constructor(siteId: string, ruleKind: StateProgramRuleKind, onDate: Date) {
    super(
      `no active state_program_rules row for site ${siteId} kind ${ruleKind} on ${onDate
        .toISOString()
        .slice(0, 10)}`,
    );
    this.name = 'NoActiveProgramRuleError';
  }
}

/** The requested rule kind is structurally impossible for the site's jurisdiction. */
export class RuleStructurallyDisallowedError extends Error {
  readonly status = 422 as const;
  constructor(siteId: string, ruleKind: StateProgramRuleKind, jurisdiction: Jurisdiction) {
    super(
      `rule kind ${ruleKind} is structurally disallowed for ${jurisdiction} site ${siteId} (ADR-0037 D1)`,
    );
    this.name = 'RuleStructurallyDisallowedError';
  }
}

/** A fuel-surcharge amount was requested but cannot be computed. */
export class FuelSurchargeNotComputableError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly reason: 'formula_pending' | 'computation_not_implemented',
    message: string,
  ) {
    super(message);
    this.name = 'FuelSurchargeNotComputableError';
  }
}

/** Site row shape the resolver reads — jurisdiction drives the structural guard. */
interface SiteJurisdictionRow {
  jurisdiction: Jurisdiction;
}

/** Resolved rule, coerced to a plain shape (params as an object, rate as cents). */
export interface ResolvedProgramRule {
  id: string;
  siteId: string;
  ruleKind: StateProgramRuleKind;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** Integer cents, or null when the amount is formula-driven (CA fuel). */
  rateCents: number | null;
  params: Record<string, unknown> | null;
}

/**
 * Normalize a Date to UTC midnight of its calendar day, matching how the
 * `@db.Date` effective columns store dates (mirrors `entryDateUTC` in the bonus
 * daily-entry layer — avoids the local-timezone off-by-one on date comparisons).
 */
export function ruleDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isOregonFuel(ruleKind: StateProgramRuleKind, jurisdiction: Jurisdiction): boolean {
  return ruleKind === 'fuel_surcharge' && jurisdiction === 'oregon';
}

/**
 * Resolve the `state_program_rules` row in effect for `(siteId, ruleKind)` on
 * `onDate`. Throws {@link RuleStructurallyDisallowedError} for an OR fuel-surcharge
 * lookup (structural guard, layer 2 of 2) and {@link NoActiveProgramRuleError}
 * when no row covers the date — program math must never fall back to a hardcoded
 * default.
 */
export async function resolveProgramRule(
  siteId: string,
  ruleKind: StateProgramRuleKind,
  onDate: Date,
): Promise<ResolvedProgramRule> {
  // Structural guard runs BEFORE any rate lookup: even if a stray fuel row were
  // somehow seeded for an OR site, it can never be resolved into a billable rate.
  const site = (await prisma.site.findUnique({
    where: { id: siteId },
    select: { jurisdiction: true },
  })) as SiteJurisdictionRow | null;
  if (!site) throw new NoActiveProgramRuleError(siteId, ruleKind, onDate);
  if (isOregonFuel(ruleKind, site.jurisdiction)) {
    throw new RuleStructurallyDisallowedError(siteId, ruleKind, site.jurisdiction);
  }

  const on = ruleDateUTC(onDate);
  const rule = await prisma.stateProgramRule.findFirst({
    where: {
      site_id: siteId,
      rule_kind: ruleKind,
      effective_from: { lte: on },
      OR: [{ effective_to: null }, { effective_to: { gte: on } }],
    },
    orderBy: { effective_from: 'desc' },
  });
  if (!rule) throw new NoActiveProgramRuleError(siteId, ruleKind, onDate);

  return {
    id: rule.id,
    siteId: rule.site_id,
    ruleKind: rule.rule_kind,
    effectiveFrom: rule.effective_from,
    effectiveTo: rule.effective_to,
    rateCents: rule.rate_cents,
    params: (rule.params ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Resolve the integer cents-per-unit rate for a flat-rate rule kind
 * (`processing_rate`, `satellite_collection_rate`, `collector_incentive`).
 * Throws if the resolved row has no `rate_cents` (a formula-driven rule reached
 * a flat-rate caller — a data error worth surfacing, never a silent 0).
 */
export async function resolveRateCents(
  siteId: string,
  ruleKind: Exclude<StateProgramRuleKind, 'fuel_surcharge'>,
  onDate: Date,
): Promise<number> {
  const rule = await resolveProgramRule(siteId, ruleKind, onDate);
  if (rule.rateCents == null) {
    throw new NoActiveProgramRuleError(siteId, ruleKind, onDate);
  }
  return rule.rateCents;
}

/**
 * Compute a fuel-surcharge amount in integer cents. REFUSES, with a typed error,
 * in two cases:
 *   - `params.formula` is null (placeholder rule; formula not yet captured), and
 *   - the formula IS captured but the per-haul calculator (EIA weekly diesel rate
 *     lookup × miles ÷ mpg) is not implemented — that lives in P2 billing, not P1
 *     foundations.
 * Money math must never guess a billing number. Present only so callers get a
 * single, typed refusal rather than a silent 0 or an ad-hoc throw.
 */
export function computeFuelSurchargeCents(rule: ResolvedProgramRule): number {
  if (rule.ruleKind !== 'fuel_surcharge') {
    throw new FuelSurchargeNotComputableError(
      'computation_not_implemented',
      `computeFuelSurchargeCents called with non-fuel rule kind ${rule.ruleKind}`,
    );
  }
  const formula = rule.params?.['formula'];
  if (formula == null) {
    throw new FuelSurchargeNotComputableError(
      'formula_pending',
      'fuel-surcharge formula is not yet captured (params.formula is null) — cannot compute',
    );
  }
  // Formula captured (Rick Albritton, survey Q6) but the EIA-rate × miles ÷ mpg
  // calculator + per-haul miles input is P2 billing scope. Refuse loudly.
  throw new FuelSurchargeNotComputableError(
    'computation_not_implemented',
    'fuel-surcharge computation is P2 billing scope (EIA rate lookup + per-haul miles not wired in P1)',
  );
}
