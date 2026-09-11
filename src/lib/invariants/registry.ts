// ADR-0131 D2 — the registry. It holds NO invariants of its own.
//
// Every invariant lives beside the code whose assumption it encodes; this file
// exists only to collect them into one ordered list for the runner. D2's reasoning
// is that a central registry drifts from the ADRs it is supposed to track, so the
// one thing this file must never become is a place where an invariant is DEFINED.
//
// `colocation.guard.test.ts` fails the build when an `invariants.ts` exists
// anywhere under `src/lib/` that this file does not import — the same mechanism as
// `snapshot-void-readers.guard.test.ts`, which D2 explicitly says to copy.

import { INVENTORY_INVARIANTS } from '@/lib/inventory/invariants';
import { NOTIFY_INVARIANTS } from '@/lib/notify/invariants';
import { WORKBOOK_SYNC_INVARIANTS } from '@/lib/workbook-sync/invariants';
import type { Invariant } from './types';

export const INVARIANTS: readonly Invariant[] = [
  ...INVENTORY_INVARIANTS,
  ...WORKBOOK_SYNC_INVARIANTS,
  ...NOTIFY_INVARIANTS,
];

/**
 * ADR-0131 D1 — the refusal-tier budget is 15 for the lifetime of the project.
 * A sixteenth requires deleting one or amending ADR-0131 to argue the budget up.
 * Asserted in `registry.test.ts` so spending the budget is a visible act.
 */
export const REFUSAL_TIER_BUDGET = 15;
