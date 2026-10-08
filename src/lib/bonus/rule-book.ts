// Bonus rule selection by ENTRY DATE (ADR-0019.6).
//
// `processor_bonus_rules` rows are effective-dated windows: a row covers every
// business day `d` with `effective_date <= d` and (`end_date` IS NULL or
// `end_date >= d`). A pay period's payout is the sum of each keyed day's bonus,
// and EACH DAY is priced by the rule covering ITS OWN `entry_date` — never by the
// rule on the period's first day, and never by the rule in force "today".
//
// Why per-day and not per-period: until ADR-0019.6 every period-level read
// (sign-time lock, reconcile recompute, PDF, month page, month list, standings,
// history) resolved ONE rule at `period_start` and priced the whole period with
// it. That is correct only while no rule boundary falls inside a period. The
// 2026-10-13 change lands exactly on a period start, but a future mid-period
// change would have silently priced the pre-change days at the new rate (or the
// reverse). Pricing per entry date makes the rule table the single source of
// truth for "which rate applied on this day", whatever the period layout.
//
// This module is PURE (no Prisma) so the server read paths and the client
// amendment editor share one lookup. Dates are compared as `YYYY-MM-DD` strings
// of the UTC calendar day, which is how `@db.Date` columns arrive.

import type { BonusRuleParams } from '@/lib/bonus/calculator';

/** One `processor_bonus_rules` row, serialisable (dates as `YYYY-MM-DD`). */
export interface DatedBonusRule extends BonusRuleParams {
  id: string;
  effective_date: string;
  end_date: string | null;
}

/** Look up the rule that prices a given business day. */
export type RuleLookup = (day: Date | string) => BonusRuleParams;

export class NoActiveRuleError extends Error {
  readonly status = 409 as const;
  constructor(siteId?: string, day?: string) {
    super(
      `no active processor_bonus_rules row${siteId ? ` for site ${siteId}` : ''}${day ? ` on ${day}` : ''}`,
    );
    this.name = 'NoActiveRuleError';
  }
}

/**
 * Two or more rule rows cover the same day. The table is a set of NON-overlapping
 * windows by construction (ADR-0019.6); an overlap is corrupt payroll config, so
 * pricing refuses rather than guessing which row wins.
 */
export class OverlappingBonusRulesError extends Error {
  readonly status = 409 as const;
  constructor(siteId: string | undefined, day: string, ruleIds: string[]) {
    super(
      `processor_bonus_rules overlap${siteId ? ` for site ${siteId}` : ''} on ${day}: ${ruleIds.join(', ')}`,
    );
    this.name = 'OverlappingBonusRulesError';
  }
}

/** `YYYY-MM-DD` of a @db.Date business day (UTC components), or a passthrough. */
export function ruleDayKey(day: Date | string): string {
  if (typeof day === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}/.test(day)) throw new TypeError(`not a YYYY-MM-DD day: ${day}`);
    return day.slice(0, 10);
  }
  if (!(day instanceof Date) || Number.isNaN(day.getTime())) {
    throw new TypeError(`not a valid business day: ${String(day)}`);
  }
  return day.toISOString().slice(0, 10);
}

/**
 * The rule covering `day`. Throws {@link OverlappingBonusRulesError} when more
 * than one row covers it and {@link NoActiveRuleError} when none does.
 *
 * `historicalFallback` (ADR-0023 read-only renders of periods imported from
 * before the earliest seeded rule) returns the site's EARLIEST rule for an
 * uncovered day instead of throwing. Never use it on a live/editable path.
 */
export function ruleForDate(
  book: readonly DatedBonusRule[],
  day: Date | string,
  opts: { siteId?: string; historicalFallback?: boolean } = {},
): DatedBonusRule {
  const key = ruleDayKey(day);
  const covering = book.filter(
    (r) => r.effective_date <= key && (r.end_date === null || r.end_date >= key),
  );
  if (covering.length > 1) {
    throw new OverlappingBonusRulesError(
      opts.siteId,
      key,
      covering.map((r) => r.id),
    );
  }
  if (covering.length === 1) return covering[0]!;
  if (opts.historicalFallback && book.length > 0) {
    return [...book].sort((a, b) => a.effective_date.localeCompare(b.effective_date))[0]!;
  }
  throw new NoActiveRuleError(opts.siteId, key);
}

/** Bind a rule book to a site for {@link ruleForDate} lookups. */
export function ruleLookup(
  book: readonly DatedBonusRule[],
  opts: { siteId?: string; historicalFallback?: boolean } = {},
): RuleLookup {
  return (day) => ruleForDate(book, day, opts);
}

/**
 * A `processor_bonus_rules` row as Prisma (or a structural tx client) returns
 * it: Decimal rates and @db.Date days.
 */
export interface BonusRuleRow {
  id: string;
  threshold_low: number;
  rate_low: { toString(): string };
  threshold_high: number;
  rate_high: { toString(): string };
  effective_date: Date;
  end_date: Date | null;
}

/** Normalise DB rows into a serialisable rule book. */
export function toRuleBook(rows: readonly BonusRuleRow[]): DatedBonusRule[] {
  return rows.map((r) => ({
    id: r.id,
    threshold_low: r.threshold_low,
    rate_low: r.rate_low.toString(),
    threshold_high: r.threshold_high,
    rate_high: r.rate_high.toString(),
    effective_date: ruleDayKey(r.effective_date),
    end_date: r.end_date ? ruleDayKey(r.end_date) : null,
  }));
}
