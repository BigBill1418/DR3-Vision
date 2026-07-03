// ADR-0040 D1 — pure validation for a proposed `transport_rate_tiers` effective set.
//
// Freight is a ZONE table (Addendum B2): the mileage band a haul falls in fixes a
// flat charge. For the freight resolver to be total (every mileage ≥ 0 maps to at
// most one band, with no ambiguity), a jurisdiction's tiers that share one
// effective window MUST be, when sorted by `min_miles`:
//   1. non-empty,
//   2. start at 0 (contiguous FROM zero),
//   3. each band's bounds ordered (`min_miles <= max_miles`),
//   4. each rate a positive number of cents,
//   5. contiguous with no gap AND no overlap — each band begins exactly one mile
//      past the previous band's inclusive upper bound (`next.min === prev.max + 1`).
//
// No DB constraint expresses (2)/(5) cleanly, so the WRITER validates the whole
// effective set before persisting (ADR-0040 D1). This module is pure (no I/O, no
// Prisma, no Date) so it unit-tests trivially and can run client-side in the tier
// editor for pre-submit feedback. Every problem names the offending row(s) — by
// caller-supplied `id` when present, else by 0-based index and range — so the UI
// can point at exactly what to fix.

/** One proposed tier row. `id` is optional so an unsaved (create) set validates too. */
export interface ProposedTier {
  /** Row id when editing an existing row; omitted for a not-yet-persisted row. */
  id?: string;
  min_miles: number;
  max_miles: number;
  rate_cents: number;
}

/** A single, specific defect in a proposed tier set. Each names the offending row(s). */
export type TierProblem =
  | { kind: 'empty_set' }
  | { kind: 'must_start_at_zero'; row: TierRef; min_miles: number }
  | { kind: 'inverted_bounds'; row: TierRef; min_miles: number; max_miles: number }
  | { kind: 'non_positive_rate'; row: TierRef; rate_cents: number }
  | { kind: 'non_integer_bound'; row: TierRef; field: 'min_miles' | 'max_miles' | 'rate_cents' }
  | { kind: 'gap'; lower: TierRef; upper: TierRef; expected_min: number; actual_min: number }
  | { kind: 'overlap'; lower: TierRef; upper: TierRef; overlap_at: number };

/** How a problem points back at a proposed row — by persisted id and/or ordinal. */
export interface TierRef {
  id: string | null;
  /** 0-based index into the caller's `tiers` array (pre-sort). */
  index: number;
  min_miles: number;
  max_miles: number;
}

/** Thrown by {@link assertValidTierSet}; carries the full problem list for the writer/UI. */
export class TierSetInvalidError extends Error {
  readonly status = 422 as const;
  constructor(readonly problems: readonly TierProblem[]) {
    super(`transport rate tier set is invalid: ${summarize(problems)}`);
    this.name = 'TierSetInvalidError';
  }
}

function refOf(t: ProposedTier, index: number): TierRef {
  return { id: t.id ?? null, index, min_miles: t.min_miles, max_miles: t.max_miles };
}

function summarize(problems: readonly TierProblem[]): string {
  return problems.map((p) => p.kind).join(', ') || 'ok';
}

/**
 * Validate a proposed tier set (all rows are assumed to belong to ONE jurisdiction
 * and ONE effective window — the caller partitions before calling). Returns the
 * list of problems; an EMPTY list means the set is valid. Never throws.
 *
 * The check is order-independent: rows are sorted by `min_miles` internally, and
 * every returned {@link TierRef} carries the row's original array index so callers
 * can map a problem back to the exact input row regardless of input order.
 */
export function validateTierSet(tiers: readonly ProposedTier[]): TierProblem[] {
  if (tiers.length === 0) return [{ kind: 'empty_set' }];

  const problems: TierProblem[] = [];

  // Per-row integrity first (integer bounds, ordering, positive rate).
  const indexed = tiers.map((t, index) => ({ t, index, ref: refOf(t, index) }));
  for (const { t, ref } of indexed) {
    if (!Number.isInteger(t.min_miles)) {
      problems.push({ kind: 'non_integer_bound', row: ref, field: 'min_miles' });
    }
    if (!Number.isInteger(t.max_miles)) {
      problems.push({ kind: 'non_integer_bound', row: ref, field: 'max_miles' });
    }
    if (!Number.isInteger(t.rate_cents)) {
      problems.push({ kind: 'non_integer_bound', row: ref, field: 'rate_cents' });
    }
    if (Number.isInteger(t.min_miles) && Number.isInteger(t.max_miles) && t.min_miles > t.max_miles) {
      problems.push({
        kind: 'inverted_bounds',
        row: ref,
        min_miles: t.min_miles,
        max_miles: t.max_miles,
      });
    }
    if (t.rate_cents <= 0) {
      problems.push({ kind: 'non_positive_rate', row: ref, rate_cents: t.rate_cents });
    }
  }

  // Contiguity/overlap checks need well-formed integer bounds; if any row failed
  // the per-row integrity pass, the adjacency arithmetic below would produce
  // misleading gaps/overlaps. Report the per-row problems alone and stop.
  if (problems.length > 0) return problems;

  const sorted = [...indexed].sort((a, b) => a.t.min_miles - b.t.min_miles);

  const first = sorted[0]!;
  if (first.t.min_miles !== 0) {
    problems.push({ kind: 'must_start_at_zero', row: first.ref, min_miles: first.t.min_miles });
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const expectedMin = prev.t.max_miles + 1;
    if (cur.t.min_miles > expectedMin) {
      problems.push({
        kind: 'gap',
        lower: prev.ref,
        upper: cur.ref,
        expected_min: expectedMin,
        actual_min: cur.t.min_miles,
      });
    } else if (cur.t.min_miles < expectedMin) {
      problems.push({
        kind: 'overlap',
        lower: prev.ref,
        upper: cur.ref,
        overlap_at: cur.t.min_miles,
      });
    }
  }

  return problems;
}

/** Validate and throw {@link TierSetInvalidError} on any problem. Returns void on success. */
export function assertValidTierSet(tiers: readonly ProposedTier[]): void {
  const problems = validateTierSet(tiers);
  if (problems.length > 0) throw new TierSetInvalidError(problems);
}

/** Convenience: which band (if any) a mileage falls in. Assumes a validated set. */
export function tierForMiles<T extends ProposedTier>(tiers: readonly T[], miles: number): T | null {
  return tiers.find((t) => miles >= t.min_miles && miles <= t.max_miles) ?? null;
}
