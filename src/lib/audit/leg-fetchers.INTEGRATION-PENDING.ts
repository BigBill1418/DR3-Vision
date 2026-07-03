/* eslint-disable */
// @ts-nocheck
//
// ════════════════════════════════════════════════════════════════════════
// ADR-0039 — DB-fetch layer (INTEGRATION PENDING — NOT COMPILED/IMPORTED)
// ════════════════════════════════════════════════════════════════════════
//
// ⚠️  This file is deliberately EXCLUDED from the type-check/build and is NOT
//     imported by any compiled module. The leading `// @ts-nocheck` +
//     `/* eslint-disable */` keep it inert even though tsconfig's glob
//     (`**/*.ts`) would otherwise pick it up. It references the sibling
//     ADR-0037 (loads/inventory) and ADR-0038 (MyMRC mirrors) Prisma models,
//     which DO NOT EXIST on `main` yet — this file cannot type-check until they
//     land.
//
// PURPOSE: this is the merge-reconciliation blueprint. It maps the sibling
// Prisma models onto the plain `src/lib/audit/types.ts` interfaces the pure
// comparators consume, and assembles a `RunChecksForWindow` callback the sweep
// (src/lib/audit/sweep.ts) accepts via injection. During merge reconciliation
// (after ADR-0037 + ADR-0038 are on main):
//
//   1. Rename this file to `leg-fetchers.ts` (drop `.INTEGRATION-PENDING`).
//   2. Remove the `// @ts-nocheck` + `/* eslint-disable */` header.
//   3. Fix any field-name drift against the ACTUAL merged Prisma models (the
//      shapes below follow the sibling ADRs incl. their post-Addendum-B
//      revisions, but verify each `select`).
//   4. Wire `buildRunChecksForWindow(prisma, siteId)` into the sweep route:
//        runAuditSweep({ db: prisma, runChecks: buildRunChecksForWindow(prisma, site.id) })
//   5. Add integration tests against a real PG (the comparators are already unit
//      tested; these fetchers need the DB round-trip verified).
//
// Sibling models referenced (all PENDING): processed_units_daily,
// outbound_materials, consumer_dropoffs, landfilled_units, inbound_loads
// extensions (retrac_id / program_unit_count / …), mymrc_hauls_mirror,
// mymrc_processed_mirror, mymrc_outbound_mirror, source_aliases.

import type { PrismaClient } from '@prisma/client';
import {
  c1Inbound,
  c2Processed,
  c3Outbound,
  c4BillingBasis,
  c5Conservation,
  c6InventoryContinuity,
  c7Deadline,
} from './comparators';
import { recomputeSummary, resolveInboundSites } from './workbook/summary-recompute';
import { resolveCheckConfigs } from './config';
import type {
  AuditWindow,
  BillingLegRow,
  CheckCode,
  ConservationRow,
  ConsumerDropoffLegRow,
  Finding,
  InboundLegRow,
  InventoryDayRow,
  LandfilledLegRow,
  MirrorHaulRow,
  MirrorOutboundRow,
  MirrorProcessedRow,
  OutboundLegRow,
  ProcessedLegRow,
} from './types';

const toISO = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const toInstantISO = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const rangeDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// ── Leg fetchers ────────────────────────────────────────────────────────

async function fetchInbound(db: PrismaClient, w: AuditWindow): Promise<InboundLegRow[]> {
  const rows = await db.inboundLoad.findMany({
    where: {
      site_id: w.siteId,
      status: { in: ['verified', 'submitted_to_mymrc', 'processed'] },
      arrived_at: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      retrac_id: true,
      external_mymrc_haul_id: true,
      arrived_at: true,
      total_units: true,
      program_unit_count: true,
      non_program_unit_count: true,
      slip_number: true,
      transport_charged: true,
      source: true,
      verified_at: true,
      // The MyMRC submission instant lands with the ADR-0038 ingestion / status flip.
      submitted_to_mymrc_at: true,
      source_rel: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    retracId: r.retrac_id ?? null,
    externalHaulId: r.external_mymrc_haul_id ?? null,
    businessDateISO: toISO(r.arrived_at) ?? w.startISO,
    totalUnits: r.total_units ?? 0,
    programUnits: r.program_unit_count ?? null,
    nonProgramUnits: r.non_program_unit_count ?? null,
    slipNumber: r.slip_number ?? null,
    transportCharged: r.transport_charged ?? false,
    source: (r.source as InboundLegRow['source']) ?? 'manual',
    sourceSiteName: r.source_rel?.name ?? null,
    verifiedAtISO: toInstantISO(r.verified_at),
    mymrcSubmittedAtISO: toInstantISO(r.submitted_to_mymrc_at),
  }));
}

async function fetchHaulMirror(db: PrismaClient, w: AuditWindow): Promise<MirrorHaulRow[]> {
  const rows = await db.mymrcHaulsMirror.findMany({
    where: { site_id: w.siteId, docking_appointment_at: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) } },
    select: {
      external_haul_id: true,
      retrac_id: true,
      docking_appointment_at: true,
      units: true,
      weight_lbs: true,
      status: true,
      first_seen_at: true,
      detail_fetched_at: true,
    },
  });
  return rows.map((r) => ({
    externalHaulId: r.external_haul_id,
    retracId: r.retrac_id ?? null,
    businessDateISO: toISO(r.docking_appointment_at) ?? w.startISO,
    units: r.units ?? null,
    weightLbs: r.weight_lbs ?? null,
    status: r.status ?? '',
    entryDateISO: toISO(r.first_seen_at),
    firstSeenAtISO: toInstantISO(r.first_seen_at),
  }));
}

async function fetchProcessed(db: PrismaClient, w: AuditWindow): Promise<ProcessedLegRow[]> {
  const rows = await db.processedUnitsDaily.findMany({
    where: { site_id: w.siteId, production_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) } },
    select: {
      id: true,
      production_date: true,
      units_processed: true,
      program_units_processed: true,
      non_program_units_processed: true,
      source: true,
      closed_at: true,
      submitted_to_mymrc_at: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    productionDateISO: toISO(r.production_date) ?? w.startISO,
    unitsProcessed: Number(r.units_processed ?? 0),
    programUnitsProcessed: r.program_units_processed == null ? null : Number(r.program_units_processed),
    nonProgramUnitsProcessed: r.non_program_units_processed == null ? null : Number(r.non_program_units_processed),
    source: (r.source as ProcessedLegRow['source']) ?? 'manual',
    closedAtISO: toInstantISO(r.closed_at),
    mymrcSubmittedAtISO: toInstantISO(r.submitted_to_mymrc_at),
  }));
}

async function fetchProcessedMirror(db: PrismaClient, w: AuditWindow): Promise<MirrorProcessedRow[]> {
  const rows = await db.mymrcProcessedMirror.findMany({
    where: { site_id: w.siteId, processed_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) } },
    select: {
      external_materials_id: true,
      processed_date: true,
      units: true,
      program_units: true,
      non_program_units: true,
      entry_date: true,
    },
  });
  return rows.map((r) => ({
    externalMaterialsId: r.external_materials_id,
    processedDateISO: toISO(r.processed_date) ?? w.startISO,
    units: r.units ?? null,
    programUnits: r.program_units ?? null,
    nonProgramUnits: r.non_program_units ?? null,
    entryDateISO: toISO(r.entry_date),
  }));
}

async function fetchOutbound(db: PrismaClient, w: AuditWindow): Promise<OutboundLegRow[]> {
  const rows = await db.outboundMaterials.findMany({
    where: { site_id: w.siteId, ship_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) } },
    select: {
      id: true,
      ship_date: true,
      commodity: true,
      sub_category: true,
      weight_lbs: true,
      whole_units: true,
      bale_count: true,
      ticket_number: true,
      retrac_id: true,
      buyer: true,
      source: true,
      eod_closed_at: true,
      submitted_to_mymrc_at: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    shipDateISO: toISO(r.ship_date) ?? w.startISO,
    commodity: r.commodity as OutboundLegRow['commodity'],
    subCategory: (r.sub_category as OutboundLegRow['subCategory']) ?? null,
    weightLbs: r.weight_lbs ?? null,
    wholeUnits: r.whole_units ?? null,
    baleCount: r.bale_count ?? null,
    ticketNumber: r.ticket_number ?? null,
    retracId: r.retrac_id ?? null,
    buyer: r.buyer ?? null,
    source: (r.source as OutboundLegRow['source']) ?? 'manual',
    eodClosedAtISO: toInstantISO(r.eod_closed_at),
    mymrcSubmittedAtISO: toInstantISO(r.submitted_to_mymrc_at),
  }));
}

async function fetchLandfilled(db: PrismaClient, w: AuditWindow): Promise<LandfilledLegRow[]> {
  const rows = await db.landfilledUnits.findMany({
    where: { site_id: w.siteId, disposal_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) } },
    select: { id: true, disposal_date: true, units: true, slip_number: true, reason: true, source: true },
  });
  return rows.map((r) => ({
    id: r.id,
    disposalDateISO: toISO(r.disposal_date) ?? w.startISO,
    units: r.units ?? 0,
    slipNumber: r.slip_number ?? null,
    reason: r.reason ?? 'other',
    source: (r.source as LandfilledLegRow['source']) ?? 'manual',
  }));
}

async function fetchOutboundMirror(db: PrismaClient, w: AuditWindow): Promise<MirrorOutboundRow[]> {
  const rows = await db.mymrcOutboundMirror.findMany({
    where: { site_id: w.siteId, ship_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) } },
    select: {
      external_materials_id: true,
      ship_date: true,
      entry_date: true,
      weight_lbs: true,
      units: true,
      ticket_number: true,
      material_type: true,
      vendor: true,
    },
  });
  return rows.map((r) => ({
    externalMaterialsId: r.external_materials_id,
    shipDateISO: toISO(r.ship_date) ?? w.startISO,
    entryDateISO: toISO(r.entry_date),
    weightLbs: r.weight_lbs ?? null,
    units: r.units ?? null,
    ticketNumber: r.ticket_number ?? null,
    materialType: r.material_type ?? null,
    vendor: r.vendor ?? null,
  }));
}

// C4 billing leg: P2 invoice when it exists, else the workbook Summary staging.
async function fetchBilling(db: PrismaClient, w: AuditWindow): Promise<BillingLegRow | null> {
  // P2 not yet shipped — return null so C4 emits a missing-billing finding, or
  // wire the historical workbook Summary staging here for retro windows.
  return null;
}

// C5/C6 internal-invariant inputs are DERIVED from the operational rows — build
// per-day ConservationRow / InventoryDayRow here from the fetched legs +
// site_inventory_snapshots. Left as a typed stub for merge reconciliation.
async function buildConservationRows(db: PrismaClient, w: AuditWindow): Promise<ConservationRow[]> {
  return [];
}
async function buildInventoryDays(db: PrismaClient, w: AuditWindow): Promise<InventoryDayRow[]> {
  return [];
}

// ── Assemble the per-window comparator runner the sweep injects ──────────

export function buildRunChecksForWindow(db: PrismaClient) {
  return async (window: AuditWindow): Promise<{ checkCodes: CheckCode[]; findings: Finding[] }> => {
    const configRows = await db.auditCheckConfig.findMany({
      where: { OR: [{ site_id: null }, { site_id: window.siteId }] },
    });
    const configs = resolveCheckConfigs(window.siteId, configRows);
    const holidays = (
      await db.siteHoliday.findMany({ where: { site_id: window.siteId }, select: { holiday_date: true } })
    ).map((h) => h.holiday_date);

    const [inbound, haulMirror, processed, processedMirror, outbound, landfilled, outboundMirror, billing, conservation, inventoryDays] =
      await Promise.all([
        fetchInbound(db, window),
        fetchHaulMirror(db, window),
        fetchProcessed(db, window),
        fetchProcessedMirror(db, window),
        fetchOutbound(db, window),
        fetchLandfilled(db, window),
        fetchOutboundMirror(db, window),
        fetchBilling(db, window),
        buildConservationRows(db, window),
        buildInventoryDays(db, window),
      ]);

    const findings: Finding[] = [];
    const checkCodes: CheckCode[] = [];
    const run = (code: CheckCode, produce: () => Finding[]) => {
      const cfg = configs.get(code);
      if (!cfg?.enabled) return;
      checkCodes.push(code);
      findings.push(...produce());
    };

    run('c1_inbound', () => c1Inbound(window, inbound, haulMirror, configs.get('c1_inbound')));
    run('c2_processed', () => c2Processed(window, processed, processedMirror, configs.get('c2_processed')));
    run('c3_outbound', () =>
      c3Outbound(window, { outbound, landfilled }, outboundMirror, configs.get('c3_outbound'), holidays),
    );
    run('c4_billing_basis', () => c4BillingBasis(window, processed, billing, configs.get('c4_billing_basis')));
    run('c5_conservation', () => c5Conservation(window, conservation, configs.get('c5_conservation')));
    run('c6_inventory_continuity', () =>
      c6InventoryContinuity(window, inventoryDays, configs.get('c6_inventory_continuity')),
    );
    run('c7_deadline', () =>
      c7Deadline(window, { inbound, processed, outbound }, configs.get('c7_deadline'), holidays),
    );

    return { checkCodes, findings };
  };
}

// Silence "unused" on the recompute imports (used only in the retro path, which
// is assembled in the workbook-import route — kept here for the merge author).
export const _retroHelpers = { recomputeSummary, resolveInboundSites };
