// C1 — Inbound units: verified `inbound_loads` (leg A) vs `mymrc_hauls_mirror`
// (leg B), joined by Re-TRAC / external haul id, compared on units and date.
// Missing-counterpart, value-mismatch, and date-mismatch are DISTINCT finding
// kinds (ADR-0039 D1).

import type { AuditWindow, CheckConfig, Finding, InboundLegRow, MirrorHaulRow } from '../types';
import { bothPresent, exceedsTolerance, makeFinder } from './helpers';

/** The join key for a Vision inbound row: prefer external haul id, else Re-TRAC. */
function inboundJoinKey(row: InboundLegRow): string | null {
  return row.externalHaulId ?? row.retracId ?? null;
}

export function c1Inbound(
  window: AuditWindow,
  inbound: readonly InboundLegRow[],
  mirror: readonly MirrorHaulRow[],
  config: CheckConfig,
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('c1_inbound', window, config);
  const out: Finding[] = [];

  const mirrorByHaul = new Map<string, MirrorHaulRow>();
  const mirrorByRetrac = new Map<string, MirrorHaulRow>();
  for (const m of mirror) {
    mirrorByHaul.set(m.externalHaulId, m);
    if (m.retracId) mirrorByRetrac.set(m.retracId, m);
  }
  const matched = new Set<string>();

  for (const row of inbound) {
    const key = inboundJoinKey(row);
    const m =
      (row.externalHaulId ? mirrorByHaul.get(row.externalHaulId) : undefined) ??
      (row.retracId ? mirrorByRetrac.get(row.retracId) : undefined);

    if (!m) {
      out.push(
        finding({
          kind: 'missing_counterpart',
          keys: [key ?? row.id],
          legARef: row.id,
          legBRef: null,
          expected: { units: row.totalUnits, date: row.businessDateISO, retracId: row.retracId },
          actual: null,
          detail: { leg: 'mymrc', note: 'inbound load has no MyMRC haul counterpart' },
        }),
      );
      continue;
    }
    matched.add(m.externalHaulId);

    if (bothPresent(row.totalUnits, m.units) && exceedsTolerance(row.totalUnits, m.units, config.unitTolerance)) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [key ?? row.id, 'units'],
          legARef: row.id,
          legBRef: m.externalHaulId,
          expected: { units: row.totalUnits },
          actual: { units: m.units },
          detail: { field: 'units', tolerance: config.unitTolerance },
        }),
      );
    }

    if (row.businessDateISO !== m.businessDateISO) {
      out.push(
        finding({
          kind: 'date_mismatch',
          keys: [key ?? row.id, 'date'],
          legARef: row.id,
          legBRef: m.externalHaulId,
          expected: { date: row.businessDateISO },
          actual: { date: m.businessDateISO },
          detail: { field: 'business_date' },
        }),
      );
    }
  }

  for (const m of mirror) {
    if (matched.has(m.externalHaulId)) continue;
    out.push(
      finding({
        kind: 'missing_counterpart',
        keys: [m.retracId ?? m.externalHaulId],
        legARef: null,
        legBRef: m.externalHaulId,
        expected: null,
        actual: { units: m.units, date: m.businessDateISO, retracId: m.retracId },
        detail: { leg: 'logs', note: 'MyMRC haul has no verified inbound load counterpart' },
      }),
    );
  }

  return out;
}
