// M2 — Missing physical snapshot. No `snapshot_kind=physical` row within N days
// (default 35 — the reconcile cadence backing the COR + quarterly MRC counts).
//
// One finding per site (fingerprint keys `[siteId]`, window-normalized): a stale
// cadence UPDATEs the same finding nightly and auto-resolves the day a physical
// snapshot lands. `asOf` is the run's as-of day (live) or the window end (retro).

import type { AuditWindow, CheckConfig, Finding } from '../types';
import { daysBetweenISO, makeFinder } from './helpers';

export interface M2Input {
  /** Most recent physical snapshot day (`YYYY-MM-DD`), or null if none exists. */
  lastPhysicalSnapshotISO: string | null;
}

function paramDays(config: CheckConfig, key: string, fallback: number): number {
  const v = config.params[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function m2MissingSnapshot(
  window: AuditWindow,
  input: M2Input,
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const cadenceDays = paramDays(config, 'snapshot_cadence_days', 35);
  const asOfISO = window.asOfISO ?? window.endISO;

  const last = input.lastPhysicalSnapshotISO;
  const daysSince = last === null ? null : daysBetweenISO(last, asOfISO);
  const stale = last === null || (daysSince !== null && daysSince > cadenceDays);
  if (!stale) return [];

  const finding = makeFinder('m2_missing_snapshot', window, config);
  return [
    finding({
      kind: 'missing_counterpart',
      keys: [window.siteId],
      legARef: null,
      legBRef: null,
      expected: { physicalSnapshotWithinDays: cadenceDays },
      actual: { lastPhysicalSnapshot: last, daysSince },
      detail: {
        note: last === null
          ? 'no physical inventory snapshot on record'
          : 'physical snapshot cadence exceeded',
        cadenceDays,
        asOf: asOfISO,
      },
    }),
  ];
}
