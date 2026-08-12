// The floor's `LoadStatus` → i18n-key map. ONE copy, for every floor surface.
//
// ── Why this file exists (audit D-4, ADR-0090 Q3 / OPEN-ITEMS AW-4) ──────────
// Three copies of this map were live at `origin/main` a10b887d, and they did not
// agree:
//
//   `held-by-panel.tsx:44`  — all twelve statuses, fallback `open_status_unknown`
//   `open-loads.tsx:21`     — the five OPEN statuses, fallback
//                             **`queue.open_status_in_progress`** — "Counting"
//   `load-workflow.tsx:130` — no map at all; rendered the raw enum token
//
// The second one is the defect ADR-0074 Amendment 1 closed in `held-by-panel`,
// still armed one directory away: a `verified`, `voided`, `submitted_to_mymrc`
// or `processed` load reaching `open-loads` is labelled as being counted right
// now. ADR-0090 D1 named this cost exactly — inlining a `??` chain at five call
// sites is *"precisely how `held-by-panel.tsx` came to label a `submitted` load
// 'Counting' for five days."*
//
// So the map moves here and the three call sites import it. A fourth surface
// gets the honest fallback by construction rather than by the author remembering
// which of three copies to copy.
//
// ── Client-safe by construction ─────────────────────────────────────────────
// TYPE-ONLY import of `LoadStatus`. No `@/lib/prisma`, no server module. This is
// the same constraint `consumed-slot-view.ts` documents: the queue page is a
// server component and `hauls-client.tsx` / `load-workflow.tsx` are client
// components, and both must read the same map or they drift apart again.

import type { LoadStatus } from '@prisma/client';

/**
 * Every `LoadStatus` the schema defines, mapped to its operator-facing key.
 *
 * Exported so the enum-walking guard in `floor-status-label.test.ts` can prove
 * completeness: a status added to `schema.prisma` without a label here is how
 * the "Counting" defect got in, so the test is over the WHOLE enum rather than
 * over the cases someone remembered.
 */
export const FLOOR_STATUS_KEY: Record<string, string> = {
  expected: 'queue.open_status_expected',
  arrived: 'queue.open_status_arrived',
  weight_captured: 'queue.open_status_weight_captured',
  unload_started: 'queue.open_status_unload_started',
  in_progress: 'queue.open_status_in_progress',
  finished: 'queue.open_status_finished',
  submitted: 'queue.open_status_submitted',
  verified: 'queue.open_status_verified',
  rejected: 'queue.open_status_rejected',
  voided: 'queue.open_status_voided',
  submitted_to_mymrc: 'queue.open_status_submitted_to_mymrc',
  processed: 'queue.open_status_processed',
};

/**
 * The label for a status this build has never heard of.
 *
 * "Status unknown" rather than any real stage. The failure mode being closed is
 * a CONFIDENT WRONG ANSWER, and a fallback naming a specific live activity is
 * exactly that — which is what `open-loads.tsx` did until this hoist. Admitting
 * ignorance is the honest floor.
 */
export const FLOOR_STATUS_FALLBACK_KEY = 'queue.open_status_unknown';

/** The i18n key for `status`, or the honest fallback. Never throws. */
export function floorStatusKey(status: LoadStatus | string): string {
  return FLOOR_STATUS_KEY[status] ?? FLOOR_STATUS_FALLBACK_KEY;
}
