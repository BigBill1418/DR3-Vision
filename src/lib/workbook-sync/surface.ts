// ADR-0049 D7 — the rollout-surface code for the workbook sync/cutover gate.
//
// One `RolloutSurface` row per site, kind `workbook_sync`. Semantics are INVERTED
// vs a UI gate (see schema): `pilot` = sync ACTIVE (workbook wins), `live` = CUT
// OVER (sync no-ops). The engine, cutover route, and admin page all resolve state
// against this single code so a rename never drifts.
export const WORKBOOK_SYNC_SURFACE = 'workbook_sync';
