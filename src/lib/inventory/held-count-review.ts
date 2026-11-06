// ADR-0072 Amendment 1 — what the manager's held-count screen flags.
//
// Pure functions, no I/O, so the two judgements the screen shows can be tested
// without a database and cannot drift between the page and its tests.
//
// Neither flag decides anything. `releaseHold` recomputes the swing from live
// state and applies the same three checks whatever this screen said; these only
// tell the manager where to look before they press a button.

import { pacificDayISO } from '@/lib/time';

/**
 * A swing at least twice the site's own threshold.
 *
 * Every pending hold is already over the threshold — that is what held it — so a
 * fixed number would either flag all of them or none. Tying the warning to the
 * site's configured threshold keeps "large" meaning the same thing the guardrail
 * means, scaled: 2,483 → 1,200 at a 20% threshold (52%) is flagged; 2,483 →
 * 1,900 (23%) is held but not flagged.
 */
export function isLargeSwing(swingPct: number, thresholdPct: number): boolean {
  return swingPct >= 2 * thresholdPct;
}

/**
 * How many pending holds share each hold's (Pacific day, counted total).
 *
 * An iPad that re-submitted, or an operator who tapped Save again after the hold
 * screen appeared, leaves several pending holds for ONE count. Approving all of
 * them writes the same anchor repeatedly, so the screen flags the group and asks
 * the manager to approve one and discard the rest. It does not pick which one:
 * the counts are identical by construction, and the choice is the manager's.
 *
 * Returns a count per hold id; 1 means no lookalike.
 */
export function sameCountPending(
  holds: ReadonlyArray<{ id: string; createdAt: Date; newTotal: number }>,
): Map<string, number> {
  const keyOf = (h: { createdAt: Date; newTotal: number }) =>
    `${pacificDayISO(h.createdAt)}|${h.newTotal}`;
  const sizes = new Map<string, number>();
  for (const h of holds) sizes.set(keyOf(h), (sizes.get(keyOf(h)) ?? 0) + 1);
  return new Map(holds.map((h) => [h.id, sizes.get(keyOf(h)) ?? 1]));
}
