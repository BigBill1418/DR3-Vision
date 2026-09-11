// Production data-invariant suite — the contract.
//
// ## The gap this closes
//
// This repo has ~6,100 tests and every one of them runs against FIXTURES. Nothing
// continuously checks that production DATA still satisfies what the code and the
// ADRs assume about it. Three incidents in three days share that one shape:
//
//   1. ADR-0102's folder-rollover fix shipped in `engine.ts` and the production
//      `workbook_sources` row was never migrated, so the transport asked for
//      September's workbook inside August's folder for 398 consecutive polls. The
//      ADR had predicted that exact failure IN WRITING (P-63).
//   2. `src/lib/ntfy.ts` recorded "DR3-Vision runs a single replica so this is
//      sufficient" — true of the web app when written, false of every cron child
//      (ADR-0130).
//   3. Program units on hand are wrong again, after prior repair work, with dated
//      diagnoses from 2026-07-30 and 2026-08-11.
//
// Each is an assumption that was TRUE when it was written down and went false
// later, with no symptom. A green fixture suite cannot see any of them, because
// the fixture is built from the same assumption the code makes.
//
// ## What an invariant is here
//
// An executable assertion about LIVE production state, carrying a pointer back to
// the ADR that motivated it, run on a schedule, that says loudly and specifically
// when it stops holding. It DIAGNOSES; it never repairs, and it never blocks.

/**
 * ADR-0131 D1 — the two tiers, and the split is the whole design.
 *
 * `refusal`     a statement that, if false, means some number is CERTAINLY wrong.
 *               Provable from the data alone; no threshold, no judgement. May page.
 *               D1 budget: 15 for the lifetime of the project.
 * `implausibility`  a statement that a value is outside anything this system has
 *               ever seen. Statistical, thresholded, arguable. NEVER pages.
 *
 * Both must exist. ADR-0131's own worked example is that a `refusal` tier could
 * not have caught the 2026-09-04 defect (MyMRC asserts 6,020 units and MyMRC is
 * the system of record, so nothing is provably false), and an `implausibility`
 * tier could never have caught the 2,193-unit duplicate, which is exact.
 */
export type InvariantTier = 'refusal' | 'implausibility';

/**
 * ADR-0037 §1 grading. `default` is the floor; anything weaker is a dashboard
 * tile, which is what `implausibility` is.
 */
export type InvariantSeverity = 'urgent' | 'high' | 'default';

/**
 * Three states, never two.
 *
 * `indeterminate` is the load-bearing one: a check that could not run must not be
 * reportable as `ok`. A monitor that cannot separate "I looked and it is fine"
 * from "I could not look" reports health it never measured — which is the same
 * silence this whole suite exists to delete.
 */
export type InvariantStatus = 'ok' | 'violated' | 'indeterminate';

/** One failing subject. Kept to one line so a digest of them stays readable. */
export interface Violation {
  /** What failed — a site code, a row id, a source name. Never PII, never a secret. */
  subject: string;
  /** Why it failed, with the actual numbers. The reader must be able to judge
   *  whether the DATA is wrong or the ASSERTION is wrong from this line alone. */
  detail: string;
}

export interface InvariantOutcome {
  status: InvariantStatus;
  /**
   * How many subjects the check actually examined — the OPPORTUNITY count.
   *
   * REQUIRED, and the runner enforces it: an `ok` with zero subjects examined is
   * rewritten to `indeterminate` (`vacuous: true`). This is the single most
   * important guard in the file, and it is the one place this implementation
   * deliberately goes BEYOND ADR-0131 D3.
   *
   * D3 types a check as returning "the violating rows — empty means PASS". That
   * makes PASS and "my query matched nothing" the same value. A check whose
   * column was renamed, whose enum member was replaced, or whose filter no longer
   * selects anything returns `[]` and scores a perfect, permanent pass — and a
   * suite of unfalsifiable green lights is a more expensive failure than no suite,
   * because it is believed. A check that filters to an empty set scores a
   * perfect pass forever and is indistinguishable from a working one — and it is
   * not hypothetical here: the seed `workbook_sources.folder_path` invariant
   * examines Woodland's row and is structurally blind to Eugene, which HAS NO ROW
   * AT ALL. Without this field that blindness reads as green.
   */
  subjectsChecked: number;
  violations: Violation[];
  /** Free-form context. On `indeterminate`, say what stopped the check. */
  note?: string;
}

/** What a check is handed. Deliberately tiny — no request, no session, no actor. */
export interface InvariantContext {
  /** Read-only by construction and by guard test; see `readonly.guard.test.ts`. */
  now: Date;
}

export interface Invariant {
  /** Stable, unique, never recycled. Appears verbatim in the digest. */
  id: string;
  tier: InvariantTier;
  /** One line, present tense, stating what MUST be true. */
  title: string;
  /**
   * ADR-0131 D3 — the ADR this invariant PINS, e.g. `ADR-0037`.
   *
   * REQUIRED so the assertion and its reason cannot drift apart. It is a real
   * citation, not a label, and it is checked twice: `registry.test.ts` asserts the
   * file exists on disk, and `scripts/check-adr-citations.mjs` is a hard build gate
   * over `src/`, so an invariant naming an ADR that does not exist fails CI.
   */
  adr: string;
  /**
   * ADR-0131 D3 — the sentence from that ADR this invariant makes falsifiable,
   * quoted as closely as the ADR states it.
   *
   * This is the load-bearing field. A `title` is what the invariant's author
   * thought; `assumption` is what the RECORD claims. When they diverge, the
   * invariant is pinning something nobody wrote down.
   */
  assumption: string;
  severity: InvariantSeverity;
  /**
   * The ADR-0037 five-question grading, written out. REQUIRED.
   *
   * Not decoration — it is the artifact that makes a severity reviewable. An
   * invariant whose author could not write this line has not graded it, and an
   * ungraded alert is how a suite becomes a storm.
   */
  gate: string;
  /**
   * ADR-0131 D3 — what a human should DO. Not what broke; what to do about it.
   *
   * A finding with no remedy is a line in a backlog, and ADR-0131 opens by noting
   * this repo already holds 894 of those.
   */
  remedy: string;
  check(ctx: InvariantContext): Promise<InvariantOutcome>;
}

export interface InvariantRunResult extends InvariantOutcome {
  id: string;
  title: string;
  adr: string;
  tier: InvariantTier;
  assumption: string;
  severity: InvariantSeverity;
  remedy: string;
  /** Wall-clock cost of this one check. Reported so the suite's price is visible. */
  durationMs: number;
  /** True when the check claimed `ok` having examined nothing. See `subjectsChecked`. */
  vacuous: boolean;
}

export interface InvariantReport {
  ranAt: string;
  durationMs: number;
  results: InvariantRunResult[];
  counts: { ok: number; violated: number; indeterminate: number };
  /**
   * Every invariant came back `indeterminate` — the suite saw NOTHING. This is a
   * distinct condition from "no violations" and it is the one thing here that
   * pages, because a blind detector reports the same green as a healthy one.
   */
  blind: boolean;
}

/**
 * Build an outcome from an opportunity count and a violation list.
 *
 * Shared so no check hand-rolls the `status` decision — a check that returns
 * `ok` alongside a non-empty `violations` array would be reported as passing,
 * and that mistake is invisible in review.
 */
export function verdict(
  subjectsChecked: number,
  violations: Violation[],
  note?: string,
): InvariantOutcome {
  return {
    status: violations.length > 0 ? 'violated' : 'ok',
    subjectsChecked,
    violations,
    ...(note ? { note } : {}),
  };
}
