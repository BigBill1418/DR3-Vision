import { appTodayISO } from '@/lib/time';
// ADR-0040 D5 — pure display/parse helpers shared by the billing-rates client
// components. No React, no I/O — trivially testable and safe to import anywhere.

import type { TierProblem } from '@/lib/billing-rates/tier-validation';

/** Integer cents → `$1,234.56`. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Parse a user-entered dollar string → integer cents. Returns `null` for blank /
 * non-numeric input so callers can surface a validation message. Rounds to the
 * nearest cent (avoids float drift like 19.99 → 1998.9999).
 */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Parse a whole-number string → integer, or `NaN` (which the tier validator flags). */
export function parseIntOrNaN(input: string): number {
  const trimmed = input.trim();
  if (trimmed === '' || !/^-?\d+$/.test(trimmed)) return Number.NaN;
  return Number.parseInt(trimmed, 10);
}

/**
 * Today as `YYYY-MM-DD` in PACIFIC — the wire format is `@db.Date`, but WHICH day
 * matters and both sites are Pacific.
 *
 * The superseded version returned the UTC day and its comment said "(UTC)" as if
 * that were the point. `toISOString()` converts to UTC first, so from 5:00 PM
 * Pacific it returned TOMORROW and rate effective-dates defaulted to a day that
 * had not happened yet.
 */
export function todayISO(): string {
  return appTodayISO();
}

/**
 * Is an effective window in force on `onDate` (default today)? Dates are
 * `YYYY-MM-DD` strings, which compare lexicographically. `to === null` = open.
 */
export function inForce(from: string, to: string | null, onDate: string = todayISO()): boolean {
  return from <= onDate && (to === null || to >= onDate);
}

/** One human-readable line per tier-set defect. Rows are named 1-based. */
export function tierProblemMessage(p: TierProblem): string {
  switch (p.kind) {
    case 'empty_set':
      return 'Add at least one mileage band.';
    case 'must_start_at_zero':
      return `The lowest band must start at 0 miles (band ${p.row.index + 1} starts at ${p.min_miles}).`;
    case 'inverted_bounds':
      return `Band ${p.row.index + 1}: min miles (${p.min_miles}) is greater than max miles (${p.max_miles}).`;
    case 'non_positive_rate':
      return `Band ${p.row.index + 1}: rate must be greater than $0.`;
    case 'non_integer_bound':
      return `Band ${p.row.index + 1}: ${p.field.replace(/_/g, ' ')} must be a whole number.`;
    case 'gap':
      return `Gap between band ${p.lower.index + 1} and band ${p.upper.index + 1}: the next band should start at ${p.expected_min} miles but starts at ${p.actual_min}.`;
    case 'overlap':
      return `Overlap between band ${p.lower.index + 1} and band ${p.upper.index + 1} at ${p.overlap_at} miles.`;
    default:
      return 'Invalid tier set.';
  }
}
