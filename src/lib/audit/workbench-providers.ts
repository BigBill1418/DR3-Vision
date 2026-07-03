// ADR-0039 D4a — the Audit Workbench provider interface.
//
// The workbench renders three rollup frames (inbound source-type / outbound
// commodity×sub-category / inventory day-ledger) from a TYPED provider
// interface. The providers read the sibling ADR-0037 operational tables — which
// do NOT exist on `main` yet — so the shipped implementation is a STUB that
// returns an `integration_pending` state. The UI renders honest empty states;
// it never fabricates data. Each rollup declares its drill-down wiring point so
// the merge author knows exactly where the one-click-to-slips resolution hooks
// in (D4a "one-click drill-down").

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
