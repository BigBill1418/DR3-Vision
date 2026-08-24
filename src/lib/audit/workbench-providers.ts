// ADR-0039 D4a — the Audit Workbench provider interface.
//
// The workbench renders three rollup frames (inbound source-type / outbound
// commodity×sub-category / inventory day-ledger) from a TYPED provider
// interface. The DB-backed provider (`dbWorkbenchProvider`) reads the merged
// ADR-0037 operational tables. The `stubWorkbenchProvider` is retained as the
// honest `integration_pending` fallback (and test double). Each rollup declares
// its drill-down wiring point (D4a "one-click drill-down").

import type { PrismaClient } from '@prisma/client';
import { buildInventoryDays } from './leg-fetchers';

export type RollupState = 'integration_pending' | 'ready';

export interface InboundSourceTypeRow {
  sourceType: string;
  label: string;
  units: number;
  isNonProgram: boolean;
  /** Drill-down target: the underlying inbound_loads / consumer_dropoffs list. */
  drillHref: string | null;
}

export interface OutboundCommodityRow {
  commodity: string;
  subCategory: string | null;
  weightLbs: number;
  wholeUnits: number | null;
  drillHref: string | null;
}

export interface InventoryDayRollup {
  dateISO: string;
  start: number;
  inbound: number;
  processed: number;
  wholeUnitsOut: number;
  computedEnd: number;
  physicalSnapshot: number | null;
  reconciledDelta: number | null;
  drillHref: string | null;
}

export interface WorkbenchRollups {
  state: RollupState;
  /** Present only when `state === 'ready'` (post-integration). */
  inboundBySourceType: InboundSourceTypeRow[];
  outboundByCommodity: OutboundCommodityRow[];
  inventoryLedger: InventoryDayRollup[];
  /** Human note surfaced in the UI while pending. */
  pendingNote: string;
}

export interface WorkbenchProvider {
  rollups(siteId: string, windowStartISO: string, windowEndISO: string): Promise<WorkbenchRollups>;
}

const PENDING_NOTE =
  'Rollups activate once the ADR-0037 loads/inventory tables land (processed_units_daily, ' +
  'outbound_materials, consumer_dropoffs, landfilled_units, inventory snapshots). ' +
  'Until then this frame intentionally shows no data rather than fabricating it.';

/**
 * The current (pre-integration) provider: always `integration_pending`. Swap the
 * body for real queries over the sibling tables during merge reconciliation; the
 * UI contract (this interface) does not change.
 */
export const stubWorkbenchProvider: WorkbenchProvider = {
  async rollups(): Promise<WorkbenchRollups> {
    return {
      state: 'integration_pending',
      inboundBySourceType: [],
      outboundByCommodity: [],
      inventoryLedger: [],
      pendingNote: PENDING_NOTE,
    };
  },
};

const num = (v: unknown): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v));

const INBOUND_SOURCE_LABELS: Record<string, string> = {
  standard_haul: 'Standard hauls (program)',
  standard_haul_np: 'Standard hauls (non-program)',
  event: 'Event units',
  dropoff_incentive: 'Incentive drop-offs',
  dropoff_unpaid: 'Unpaid drop-offs',
  dropoff_illegal: 'Illegal drop-offs',
  // ADR-0085 (+ Am.1) — the label-only iPad walk-up kinds. Without these three
  // the fallback renders the raw `dropoff_floor_*` key in the workbench.
  dropoff_floor_public: 'Public drop-offs (iPad)',
  dropoff_floor_illegal: 'Illegal drop-offs (iPad)',
  dropoff_floor_incentive: 'Incentive drop-offs (iPad)',
};

/**
 * The live (post-integration) provider — reads the merged ADR-0037 tables.
 * Category rollups follow Addendum B §B1 (categories are load-SOURCE types, not
 * unit types): standard hauls / event units over `inbound_loads`, and consumer
 * drop-offs by kind over `consumer_dropoffs`. The inventory ledger reuses the
 * ONE shared running balance (`buildInventoryDays`) so it never forks a second
 * inventory computation. Program/non-program derive from the pool splits (B7).
 */
export function dbWorkbenchProvider(db: PrismaClient): WorkbenchProvider {
  return {
    async rollups(siteId, windowStartISO, windowEndISO): Promise<WorkbenchRollups> {
      const gte = new Date(`${windowStartISO}T00:00:00.000Z`);
      const lt = new Date(`${windowEndISO}T00:00:00.000Z`);
      const drill = (frag: string) =>
        `/dashboard/SITE/loads-inventory?${frag}`.replace('SITE', siteId);

      const [haulAgg, eventAgg, dropoffs, outboundGroups, inventoryDays] = await Promise.all([
        db.inboundLoad.aggregate({
          _sum: { program_unit_count: true, non_program_unit_count: true },
          where: {
            site_id: siteId,
            load_source_type: 'b2b_haul',
            status: { in: ['verified', 'submitted_to_mymrc', 'processed'] },
            arrived_at: { gte, lt },
          },
        }),
        db.inboundLoad.aggregate({
          _sum: { total_units: true },
          where: {
            site_id: siteId,
            load_source_type: 'event',
            status: { in: ['verified', 'submitted_to_mymrc', 'processed'] },
            arrived_at: { gte, lt },
          },
        }),
        db.consumerDropoff.groupBy({
          by: ['kind'],
          _sum: { units: true },
          where: { site_id: siteId, dropoff_date: { gte, lt } },
        }),
        db.outboundMaterial.groupBy({
          by: ['commodity', 'sub_category'],
          _sum: { weight_lbs: true, whole_units: true },
          where: { site_id: siteId, ship_date: { gte, lt } },
        }),
        buildInventoryDays(db, { siteId, startISO: windowStartISO, endISO: windowEndISO }),
      ]);

      const inboundBySourceType: InboundSourceTypeRow[] = [];
      const pushInbound = (
        sourceType: string,
        units: number,
        isNonProgram: boolean,
        frag: string,
      ) => {
        if (units > 0) {
          inboundBySourceType.push({
            sourceType,
            label: INBOUND_SOURCE_LABELS[sourceType] ?? sourceType,
            units,
            isNonProgram,
            drillHref: drill(frag),
          });
        }
      };
      pushInbound(
        'standard_haul',
        num(haulAgg._sum.program_unit_count),
        false,
        'tab=inbound&source=b2b_haul&pool=program',
      );
      pushInbound(
        'standard_haul_np',
        num(haulAgg._sum.non_program_unit_count),
        true,
        'tab=inbound&source=b2b_haul&pool=non_program',
      );
      pushInbound('event', num(eventAgg._sum.total_units), false, 'tab=inbound&source=event');
      for (const d of dropoffs) {
        pushInbound(`dropoff_${d.kind}`, num(d._sum.units), false, `tab=dropoffs&kind=${d.kind}`);
      }

      const outboundByCommodity: OutboundCommodityRow[] = outboundGroups
        .map((g) => ({
          commodity: g.commodity as string,
          subCategory: (g.sub_category as string | null) ?? null,
          weightLbs: num(g._sum.weight_lbs),
          wholeUnits: g._sum.whole_units == null ? null : num(g._sum.whole_units),
          drillHref: drill(`tab=outbound&commodity=${g.commodity}&subCategory=${g.sub_category}`),
        }))
        .sort(
          (a, b) =>
            a.commodity.localeCompare(b.commodity) ||
            (a.subCategory ?? '').localeCompare(b.subCategory ?? ''),
        );

      const inventoryLedger: InventoryDayRollup[] = inventoryDays.map((d) => {
        const computedEnd = (d.recordedEnd ?? 0) + (d.npRecordedEnd ?? 0);
        return {
          dateISO: d.dateISO,
          start: (d.recordedStart ?? 0) + (d.npRecordedStart ?? 0),
          inbound: d.inbound + d.npInbound,
          processed: d.stripped + (d.npStripped ?? 0),
          wholeUnitsOut: d.wholeUnitsSold + d.npSold,
          computedEnd,
          physicalSnapshot: d.physicalSnapshot,
          reconciledDelta: d.physicalSnapshot == null ? null : d.physicalSnapshot - computedEnd,
          drillHref: drill(`tab=inventory&date=${d.dateISO}`),
        };
      });

      return {
        state: 'ready',
        inboundBySourceType,
        outboundByCommodity,
        inventoryLedger,
        pendingNote: '',
      };
    },
  };
}
