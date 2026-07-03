// C3 — Outbound: `outbound_materials` (all sub-categories incl. renovation) +
// `landfilled_units` (leg A) vs `mymrc_outbound_mirror` (leg B), joined by
// ticket/Material # and compared on weight and date.
//
// Tolerance (ADR-0039 D1): the outbound lateness/gap clock starts at EOD, not
// ticket time — Material # only exists at end-of-day MyMRC entry (Janette Q1).
// So a Vision outbound row that is not yet in MyMRC is tolerated until EOD +
// `graceBusinessDays` (default 1); it becomes a missing-counterpart finding only
// once that grace day has passed relative to the run's `asOfISO`. A purely
// historical run (`asOfISO` undefined) applies no grace — every clock elapsed.

import type {
  AuditWindow,
  CheckConfig,
  Finding,
  LandfilledLegRow,
  MirrorOutboundRow,
  OutboundLegRow,
} from '../types';
import { bothPresent, businessDayAddISO, exceedsTolerance, makeFinder } from './helpers';

export interface C3LegA {
  outbound: readonly OutboundLegRow[];
  landfilled: readonly LandfilledLegRow[];
}

export function c3Outbound(
  window: AuditWindow,
  legA: C3LegA,
  mirror: readonly MirrorOutboundRow[],
  config: CheckConfig,
  holidays: Date[] = [],
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('c3_outbound', window, config);
  const out: Finding[] = [];

  const mirrorByTicket = new Map<string, MirrorOutboundRow>();
  for (const m of mirror) {
    if (m.ticketNumber) mirrorByTicket.set(m.ticketNumber, m);
  }
  const matched = new Set<string>();

  // Whether a still-missing counterpart is past its EOD grace as of the run day.
  const pastGrace = (shipDateISO: string): boolean => {
    if (window.asOfISO === undefined) return true; // historical run — no grace
    const deadlineISO = businessDayAddISO(shipDateISO, config.graceBusinessDays, holidays);
    return window.asOfISO > deadlineISO;
  };

  for (const row of legA.outbound) {
    const m = row.ticketNumber ? mirrorByTicket.get(row.ticketNumber) : undefined;
    if (!m) {
      if (pastGrace(row.shipDateISO)) {
        out.push(
          finding({
            kind: 'missing_counterpart',
            keys: [row.ticketNumber ?? row.id],
            legARef: row.id,
            legBRef: null,
            expected: {
              ticketNumber: row.ticketNumber,
              commodity: row.commodity,
              subCategory: row.subCategory,
              weightLbs: row.weightLbs,
              date: row.shipDateISO,
            },
            actual: null,
            detail: { leg: 'mymrc', note: 'outbound material has no MyMRC counterpart past EOD grace' },
          }),
        );
      }
      continue;
    }
    matched.add(m.externalMaterialsId);

    if (bothPresent(row.weightLbs, m.weightLbs) && exceedsTolerance(row.weightLbs, m.weightLbs, config.weightToleranceLbs)) {
      out.push(
        finding({
          kind: 'value_mismatch',
          keys: [row.ticketNumber ?? row.id, 'weight'],
          legARef: row.id,
          legBRef: m.externalMaterialsId,
          expected: { weightLbs: row.weightLbs },
          actual: { weightLbs: m.weightLbs },
          detail: { field: 'weight_lbs', tolerance: config.weightToleranceLbs },
        }),
      );
    }

    if (row.shipDateISO !== m.shipDateISO) {
      out.push(
        finding({
          kind: 'date_mismatch',
          keys: [row.ticketNumber ?? row.id, 'date'],
          legARef: row.id,
          legBRef: m.externalMaterialsId,
          expected: { date: row.shipDateISO },
          actual: { date: m.shipDateISO },
          detail: { field: 'ship_date' },
        }),
      );
    }
  }

  // Landfilled whole-unit disposals join by slip # against the mirror ticket.
  for (const row of legA.landfilled) {
    const m = row.slipNumber ? mirrorByTicket.get(row.slipNumber) : undefined;
    if (m) {
      matched.add(m.externalMaterialsId);
      continue;
    }
    if (pastGrace(row.disposalDateISO)) {
      out.push(
        finding({
          kind: 'missing_counterpart',
          keys: ['landfilled', row.slipNumber ?? row.id],
          legARef: row.id,
          legBRef: null,
          expected: { units: row.units, reason: row.reason, date: row.disposalDateISO },
          actual: null,
          detail: { leg: 'mymrc', note: 'landfilled units have no MyMRC counterpart past EOD grace' },
        }),
      );
    }
  }

  for (const m of mirror) {
    if (matched.has(m.externalMaterialsId)) continue;
    out.push(
      finding({
        kind: 'missing_counterpart',
        keys: [m.ticketNumber ?? m.externalMaterialsId],
        legARef: null,
        legBRef: m.externalMaterialsId,
        expected: null,
        actual: { ticketNumber: m.ticketNumber, weightLbs: m.weightLbs, date: m.shipDateISO, vendor: m.vendor },
        detail: { leg: 'logs', note: 'MyMRC outbound row has no Vision outbound/landfilled counterpart' },
      }),
    );
  }

  return out;
}
