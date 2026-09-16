// ADR-0131 Amendment 2 — WHICH SITES THE DATA-INVARIANT SUITE SPEAKS FOR.
//
// The suite asserts things about a site's floor: that its anchor is fresh, that
// its pools are not negative, that its workbook source rolls to the next month,
// that its inbound hauls are plausible. Every one of those is a statement about a
// site that is RUNNING Loads & Inventory. Asked of a site that is not, each is
// true-but-useless — Eugene fired two refusal-tier pages at 02:30 PT every night
// from 2026-09-12 for having no physical count and no workbook source, on a site
// with zero rows in every flow table and zero counts in its entire history.
//
// ## Onboarding is the ADR-0047 rollout surface, not a new column
//
// A site is in scope iff its `loads_inventory` UI surface (ADR-0037 D7, made
// data-driven by ADR-0047) is `live`. That row is already the switch that decides
// whether operators and managers can reach the flow at all — `record-guards.ts`
// refuses every loads/inventory write behind it — so it is the repo's existing,
// audited, admin-flipped answer to "is this site running this?". A new
// `sites.onboarded_at` column would be a SECOND answer to a question that already
// has one, and the two would drift the first time somebody flipped one and not the
// other. The read goes through `isUiSurfaceLive`, the one resolver, rather than a
// hand-rolled `rolloutSurface.findMany` — a second predicate is the same drift in
// smaller print.
//
// ## Eugene, specifically
//
// Bill flipped Eugene's `loads_inventory` LIVE on 2026-07-22 12:54 PT and nobody
// ever used it: 0 `inbound_loads`, 0 `consumer_dropoffs`, 0 `processed_units_daily`,
// 0 physical counts, no `workbook_sources` row, and no Eugene account in the MyMRC
// mirror at all. On 2026-09-15 9:52 PM PT he decided — _"Eugene is not running it
// yet - flip it to pilot"_ — and the five Eugene surfaces (`loads_inventory`,
// `ipad_count`, `ipad_inbound`, `ipad_dropoff`, `ipad_queue`) went back to `pilot`
// through `/admin/rollout`, one audit row each. This module is the code half of
// that decision. OPEN-ITEMS 0.BT BT-3.
//
// ## Re-entry is automatic, and that is the point of using the flag
//
// Flip a site's `loads_inventory` back to `live` and it re-enters the suite on the
// next 02:30 run with no deploy. `INV-ANCHOR-FRESH` will immediately demand a first
// physical count from it — which is correct and is the designed behaviour, not a
// regression: a site whose floor is being operated on and never counted is exactly
// what that invariant exists to notice.
//
// ## Placement
//
// Here, beside the runner, rather than under `src/lib/mymrc/`: `tsconfig.mymrc.json`
// pins `rootDir: ./src/lib/mymrc` with no `@/` alias, so anything there importing
// `@/lib/prisma` breaks `npm run build:mymrc` with TS6059 (the forced placement
// already recorded at the top of `loads/invariants.ts` and
// `workbook-sync/invariants.ts`). Nothing under `src/lib/mymrc/` imports the
// invariant suite, so this file never reaches that bundle. It is NOT named
// `invariants.ts`, so `colocation.guard.test.ts` does not demand a registry import
// of a module that defines no invariants; it IS scanned by
// `readonly.guard.test.ts`, which covers every non-test `.ts` in this directory.

import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import type { InvariantOutcome } from './types';

/**
 * The surface whose `live` state MEANS "this site is running Loads & Inventory".
 *
 * Exported so a test can pin it. Swapping it for one of the per-screen ADR-0065
 * gates (`ipad_count`, `ipad_queue`, …) would silently narrow the suite to a
 * different question while every other assertion stayed green.
 */
export const ONBOARDING_SURFACE = UI_SURFACE.LOADS_INVENTORY;

/**
 * Keep only the sites onboarded to Loads & Inventory, in the order given.
 *
 * Fail-CLOSED by inheritance: `isUiSurfaceLive` resolves an unregistered row or a
 * read error to `false`, so a database the suite cannot read yields an EMPTY scope
 * rather than a full one. Paired with {@link noOnboardedSites} that surfaces as
 * "I could not look", never as "every site is fine".
 */
export async function onboardedSites<T extends { id: string }>(all: readonly T[]): Promise<T[]> {
  const live = await Promise.all(all.map((s) => isUiSurfaceLive(ONBOARDING_SURFACE, s.id)));
  return all.filter((_, i) => live[i] === true);
}

/**
 * The outcome for a run in which NO site is onboarded.
 *
 * `verdict(0, [])` returns `ok`, and the runner's vacuity guard would rewrite that
 * to `indeterminate` — so this is belt and braces, deliberately. Two reasons it is
 * worth the six lines: the check must not hand back a green that only a downstream
 * component corrects (anything calling `check()` directly, a test included, would
 * read the green), and the runner's generic note ("examined 0 subjects") cannot say
 * WHY. The reader of a 02:30 digest needs the difference between "the scope is
 * empty because nobody is onboarded" and "my query broke".
 */
export function noOnboardedSites(): InvariantOutcome {
  return {
    status: 'indeterminate',
    subjectsChecked: 0,
    violations: [],
    note:
      'no site has the `loads_inventory` UI surface `live`, so this invariant has ' +
      'nothing it is entitled to speak for (ADR-0131 Amendment 2)',
  };
}
