// Single source of truth for `LoadStatus` display strings across the
// manager portal. Two label maps live here — both keyed off the same
// `LoadStatus` enum from Prisma, both translated through the manager
// i18n dictionary so EN/ES/UR ship together (CLAUDE.md hard rule #4):
//
//   - `loadStatusLabel(status, dict)`  — generic pill label used in the
//     filter bar + load row badge ("Unloading", "Finished", ...).
//   - `loadStageLabel(status, dict)`   — dock-tile variant emphasising
//     the stage of the workflow ("Door open", "Counting", ...).
//
// The two diverge for the operator-active states (unload_started,
// in_progress, finished) because the dock view talks in workflow
// stages while the filter bar talks in record states. Terminal states
// share their wording across both maps.
//
// Before this hoist three files inlined parallel `const` maps and got
// out of sync as the enum grew. Now `rg "STATUS_LABELS|STAGE_LABELS"`
// resolves to this file alone, by design.

import { LoadStatus } from '@prisma/client';
import { translate } from '@/i18n/dictionary';
import type { Dictionary, ManagerDictionary } from '@/i18n/dictionary';

// Stable enum order — used by the filter bar to render its chips, and
// by the URL serializer so the canonical `?status=...` order matches
// the dropdown order regardless of insertion sequence.
export const ALL_LOAD_STATUSES: readonly LoadStatus[] = [
  LoadStatus.expected,
  LoadStatus.arrived,
  LoadStatus.weight_captured,
  LoadStatus.unload_started,
  LoadStatus.in_progress,
  LoadStatus.finished,
  LoadStatus.submitted,
  LoadStatus.verified,
  LoadStatus.rejected,
  LoadStatus.submitted_to_mymrc,
  LoadStatus.processed,
] as const;

type AnyDict = Dictionary | ManagerDictionary;

/**
 * Localized label for a load status as rendered in lists, filter chips,
 * and detail-page status badges. Reads from `manager.load_status.<enum>`.
 */
export function loadStatusLabel(status: LoadStatus, dict: AnyDict): string {
  return translate(dict, `load_status.${status}`);
}

/**
 * Localized label for a load status as rendered on dock tiles (the
 * live operator view). Diverges from `loadStatusLabel` for active
 * stages (e.g. "Door open" vs "Unloading") because the dock view
 * frames the value as a workflow stage, not a record state.
 * Reads from `manager.load_stage.<enum>`.
 */
export function loadStageLabel(status: LoadStatus, dict: AnyDict): string {
  return translate(dict, `load_stage.${status}`);
}
