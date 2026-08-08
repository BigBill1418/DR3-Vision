// ADR-0039 Amendment 1 — leg-liveness bootstrap gating.
//
// A missing-counterpart check (premise: "this leg has no data for the window")
// must NOT emit findings for a site until the leg has EVER contained data for
// that site, OR an admin-editable per-(site, leg) `go_live_date` has passed.
// This turns a fresh site's "true but useless" bootstrap findings (the
// 2026-07-06 incident) off by construction, without touching comparator logic —
// the comparators are correct; the release discipline was not.
//
// The gate is a REGISTRY: adding a future missing-counterpart check inherits the
// behaviour by adding one line to BOOTSTRAP_GATED_CHECKS. Suppressed evaluations
// are counted per-check into the run ledger (`audit_runs.suppressed_bootstrap`)
// — visible in the admin audit page, never silent (ADR-0038 lesson).

import type { PrismaClient } from '@prisma/client';
import { NOT_VOIDED } from '@/lib/inventory/snapshot-void';
import type { CheckCode } from './types';

export type BootstrapLeg = 'billing' | 'close' | 'snapshot' | 'commodity_payment';

/**
 * Registry: each gated check → the leg whose first data (or admin go_live_date)
 * turns real evaluation ON. Future missing-counterpart checks add a line here.
 */
export const BOOTSTRAP_GATED_CHECKS: Partial<Record<CheckCode, BootstrapLeg>> = {
  c4_billing_basis: 'billing',
  m1_missing_close: 'close',
  m2_missing_snapshot: 'snapshot',
  // ADR-0052 — the aging check turns on at Daven's FIRST payment entry for the
  // site (or an admin go_live_date), so a fresh site can't spam stale findings.
  m3_commodity_payment_aging: 'commodity_payment',
};

export const ALL_BOOTSTRAP_LEGS: readonly BootstrapLeg[] = [
  'billing',
  'close',
  'snapshot',
  'commodity_payment',
];

export interface LegLiveness {
  /** True ⇒ the leg has data (or its go-live has passed): evaluate normally. */
  isLive(leg: BootstrapLeg): boolean;
  /** The per-leg resolution, for diagnostics/tests. */
  readonly resolved: Readonly<Record<BootstrapLeg, boolean>>;
}

/** Has this site EVER had a row in the leg's underlying table? (derived liveness) */
async function legHasEverHadData(
  db: PrismaClient,
  siteId: string,
  leg: BootstrapLeg,
): Promise<boolean> {
  switch (leg) {
    case 'billing':
      // The billing leg is P2 invoices (ADR-0041). No invoice ⇒ no billing basis yet.
      return (await db.invoice.count({ where: { site_id: siteId } })) > 0;
    case 'close':
      // The close leg is the daily processed-units close.
      return (await db.processedUnitsDaily.count({ where: { site_id: siteId } })) > 0;
    case 'snapshot':
      // The snapshot leg is a PHYSICAL inventory count (m2's premise).
      //
      // ADR-0084 — voided counts do not make the leg live. A site whose ONLY
      // count was voided has never successfully counted, and treating the
      // withdrawn row as evidence would switch M2 on for a site with no anchor,
      // which is precisely the bootstrap noise this gate exists to suppress.
      return (
        (await db.siteInventorySnapshot.count({
          where: { ...NOT_VOIDED, site_id: siteId, snapshot_kind: 'physical' },
        })) > 0
      );
    case 'commodity_payment':
      // ADR-0052 — live once the reconciliation owner has entered ANY payment
      // record for one of the site's loads.
      return (
        (await db.outboundMaterialPayment.count({
          where: { outbound_material: { site_id: siteId } },
        })) > 0
      );
  }
}

/**
 * Resolve per-leg liveness for a site once per run. `asOf` (the run's anchor day)
 * is the instant a `go_live_date` is measured against. Derived data existence
 * OR a passed go_live_date makes the leg live.
 */
export async function resolveLegLiveness(
  db: PrismaClient,
  siteId: string,
  asOf: Date,
): Promise<LegLiveness> {
  const gateRows = await db.auditBootstrapGate.findMany({
    where: { site_id: siteId },
    select: { leg: true, go_live_date: true },
  });
  const goLiveByLeg = new Map<string, Date | null>();
  for (const g of gateRows) goLiveByLeg.set(g.leg, g.go_live_date);

  const resolved = {} as Record<BootstrapLeg, boolean>;
  for (const leg of ALL_BOOTSTRAP_LEGS) {
    const goLive = goLiveByLeg.get(leg);
    if (goLive && goLive.getTime() <= asOf.getTime()) {
      resolved[leg] = true;
      continue;
    }
    resolved[leg] = await legHasEverHadData(db, siteId, leg);
  }

  return {
    resolved,
    isLive: (leg) => resolved[leg] ?? true, // unknown leg ⇒ evaluate (never suppress the unknown)
  };
}
