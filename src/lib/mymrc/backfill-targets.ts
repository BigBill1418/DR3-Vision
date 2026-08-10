// ADR-0057 Phase 1 (D3) — production BackfillTarget wiring for the 4 real
// objects (docs/mymrc-discovery-2026-07-22.md). This is the schema-aware layer
// the schema-agnostic backfill engine (backfill.ts) consumes; it reuses the
// canonical mappers (mappers.ts) so detail-column mapping has ONE source of
// truth shared with the hourly sync.
//
// Cursor keys (object_api_name, list_view_api_name) — ACTIVE + HISTORY views
// (history added ADR-0057 D3, 2026-07-22, so the backfill pulls FULL history):
//   Haul_Request__c   / docking_appointments_rc  → mymrc_hauls_mirror
//   Haul_Request__c   / consumer_drop_off_rc      → mymrc_hauls_mirror
//   Haul_Request__c   / completed_hauls           → mymrc_hauls_mirror        (HISTORY — bulk of haul history)
//   Materials__c      / processed_active          → mymrc_processed_mirror    (Type__c 'Processing')
//   Materials__c      / processed_inactive        → mymrc_processed_mirror    (HISTORY — Type__c 'Processing')
//   Materials__c      / outbound_active           → mymrc_outbound_mirror     (Type__c 'Outbound')
//   Materials__c      / outbound_inactive         → mymrc_outbound_mirror     (HISTORY — Type__c 'Outbound')
//   Dock_Availability_Schedule__c / ''            → mymrc_dock_availability_mirror
// list_view_api_name is a DR3-INTERNAL slug (the transport maps it to the actual
// portal list-view + URL). All three hauls list views bind to the same mirror,
// and both Materials views per Type bind to the same mirror; their detail sweeps
// dedup naturally (idsNeedingDetail reads detail_fetched_at IS NULL, targets run
// sequentially), so an id surfacing in both an active and a history view upserts
// once and its detail is fetched once. The inactive Materials VIEWS only widen
// coverage — routing is still by Type__c, unchanged.
//
// site_id derivation (ADR-0057 Recon B §6): getItems yields ids only, so the
// list-upsert leaves site_id NULL; the DETAIL pass resolves it from the record's
// recycler_name / account_name ("DR3 Woodland" → site code "woodland"). Dock has
// no site discriminator (no site_id column). An unresolved name leaves site_id
// NULL — never a wrong site (money-safe; reconciliation handles the gap).
//
// KNOWN GAP (documented for the integrator, NOT a backfill-engine concern):
// Outbound `vendor` (Outbound_Vendor_Name__c) is a LIST-ONLY column absent from
// the record detail; backfill fetches detail per id, so vendor stays NULL on
// backfilled outbound rows. Capturing it requires threading per-id getItems
// column values through the transport — the same limitation the hourly sync has.

import type { Prisma, PrismaClient } from '@prisma/client';
import type { BackfillPortalClient, BackfillTarget } from './backfill';
import {
  classifyMaterialsType,
  mapDockAvailabilityRecord,
  mapHaulRecord,
  mapOutboundRecord,
  mapProcessedRecord,
} from './mappers';
import {
  DOCK_OPTIONAL_FIELDS,
  HAUL_OPTIONAL_FIELDS,
  MATERIALS_OPTIONAL_FIELDS,
} from './record-fields-client';
import type { SfRecord } from './types';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

// ── site_id resolver (detail pass) ───────────────────────────────────────────

/** "DR3 Woodland" → "woodland", "DR3 Eugene" → "eugene"; unrecognized → null. */
function siteCodeFromMymrcName(name: string | null): 'eugene' | 'woodland' | null {
  if (!name) return null;
  const stripped = name
    .trim()
    .toLowerCase()
    .replace(/^dr3\s+/, '');
  if (stripped === 'woodland' || stripped === 'eugene') return stripped;
  return null;
}

/**
 * Resolve a mirror row's site_id from its MyMRC recycler/account name, verified
 * against the `sites` table. Memoized per run. Returns null when the name is
 * unrecognized or the site row is absent (row stays unresolved — never
 * mis-attributed to a wrong site).
 */
function makeSiteResolver(prisma: PrismaClient): (name: string | null) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (name: string | null): Promise<string | null> => {
    const code = siteCodeFromMymrcName(name);
    if (!code) return null;
    const cached = cache.get(code);
    if (cached !== undefined) return cached;
    const site = await prisma.site.findUnique({ where: { code }, select: { id: true } });
    const id = site?.id ?? null;
    cache.set(code, id);
    return id;
  };
}

// ── Targets ──────────────────────────────────────────────────────────────────

interface TargetDeps {
  prisma: PrismaClient;
  client: BackfillPortalClient;
  resolveSiteId: (name: string | null) => Promise<string | null>;
  log: Logger;
}

function haulsTarget(deps: TargetDeps, listViewApiName: string): BackfillTarget {
  const model = deps.prisma.mymrcHaulsMirror;
  return {
    objectApiName: 'Haul_Request__c',
    listViewApiName,
    optionalFields: HAUL_OPTIONAL_FIELDS,
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async idsNeedingDetail() {
      const rows = await model.findMany({
        where: { detail_fetched_at: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async writeDetail(record, at) {
      const row = mapHaulRecord(record);
      const siteId = await deps.resolveSiteId(row.recycler_name);
      await model.update({
        where: { id: record.id },
        data: {
          site_id: siteId,
          external_haul_id: row.external_id,
          status: row.status,
          type: row.type,
          rate_id: row.rate_id,
          recycler_name: row.recycler_name,
          recycler_account_id: row.recycler_account_id,
          transporter_name: row.transporter_name,
          collection_site: row.collection_site,
          collection_source: row.collection_source,
          commodity: row.commodity,
          container_type: row.container_type,
          program_unit_count: row.program_unit_count,
          non_program_unit_count: row.non_program_unit_count,
          unpaid_consumer_dropoff_units: row.unpaid_consumer_dropoff_units,
          docking_appointment_date: row.docking_appointment_date,
          docking_appointment_at: row.docking_appointment_at,
          door: row.door,
          recycler_reported_delivery_date: row.recycler_reported_delivery_date,
          transporter_reported_delivery_date: row.transporter_reported_delivery_date,
          unit_count_at_unload: row.unit_count_at_unload,
          units: row.units,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
        },
      });
    },
  };
}

function processedTarget(deps: TargetDeps, listViewApiName: string): BackfillTarget {
  const model = deps.prisma.mymrcProcessedMirror;
  return {
    objectApiName: 'Materials__c',
    listViewApiName,
    optionalFields: MATERIALS_OPTIONAL_FIELDS,
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async idsNeedingDetail() {
      const rows = await model.findMany({
        where: { detail_fetched_at: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async writeDetail(record, at) {
      warnOnTypeMismatch(record, 'Processing', deps.log);
      const row = mapProcessedRecord(record);
      const siteId = await deps.resolveSiteId(row.account_name);
      await model.update({
        where: { id: record.id },
        data: {
          site_id: siteId,
          external_materials_id: row.external_id,
          type: row.type,
          account_name: row.account_name,
          account_id: row.account_id,
          materials_status: row.materials_status,
          bol_id: row.bol_id,
          entry_date: row.entry_date,
          processed_date: row.processed_date,
          program_unit_count: row.program_unit_count,
          non_program_unit_count: row.non_program_unit_count,
          units: row.units,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
        },
      });
    },
  };
}

function outboundTarget(deps: TargetDeps, listViewApiName: string): BackfillTarget {
  const model = deps.prisma.mymrcOutboundMirror;
  return {
    objectApiName: 'Materials__c',
    listViewApiName,
    optionalFields: MATERIALS_OPTIONAL_FIELDS,
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async idsNeedingDetail() {
      const rows = await model.findMany({
        where: { detail_fetched_at: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async writeDetail(record, at) {
      warnOnTypeMismatch(record, 'Outbound', deps.log);
      // vendor is list-only (see file header) — detail cannot yield it; stays null.
      const row = mapOutboundRecord(record);
      const siteId = await deps.resolveSiteId(row.account_name);
      await model.update({
        where: { id: record.id },
        data: {
          site_id: siteId,
          external_materials_id: row.external_id,
          type: row.type,
          account_name: row.account_name,
          account_id: row.account_id,
          materials_status: row.materials_status,
          bol_id: row.bol_id,
          vendor: row.vendor,
          entry_date: row.entry_date,
          shipment_date: row.shipment_date,
          program_unit_count: row.program_unit_count,
          non_program_unit_count: row.non_program_unit_count,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
        },
      });
    },
  };
}

function dockTarget(deps: TargetDeps): BackfillTarget {
  const model = deps.prisma.mymrcDockAvailabilityMirror;
  return {
    objectApiName: 'Dock_Availability_Schedule__c',
    listViewApiName: '',
    optionalFields: DOCK_OPTIONAL_FIELDS,
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async idsNeedingDetail() {
      const rows = await model.findMany({
        where: { detail_fetched_at: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async writeDetail(record, at) {
      const row = mapDockAvailabilityRecord(record);
      await model.update({
        where: { id: record.id },
        data: {
          external_schedule_id: row.external_id,
          status: row.status,
          day_of_week: row.day_of_week,
          container_type: row.container_type,
          dock_door: row.dock_door,
          slot_start_time: row.slot_start_time,
          slot_end_time: row.slot_end_time,
          available_appointments: row.available_appointments,
          availability_start_date: row.availability_start_date,
          payload: toJson(row.payload),
          detail_fetched_at: at,
        },
      });
    },
  };
}

/**
 * Materials records carry the same a2L id space across both list views; Type__c
 * is the authoritative splitter. A record surfacing under the wrong view is
 * portal drift — warn (traceable) but still persist to the bound mirror with its
 * raw Type__c recorded, never silently drop.
 */
function warnOnTypeMismatch(
  record: SfRecord,
  expected: 'Processing' | 'Outbound',
  log: Logger,
): void {
  const actual = classifyMaterialsType(record);
  if (actual !== null && actual !== expected) {
    log(
      'warn',
      `mymrc-backfill: Materials ${record.id} Type__c=${actual} under ${expected} view (persisting anyway)`,
    );
  }
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
}

/**
 * The full production target set for the windowed backfill — the 4 real objects
 * across their 8 (object, list-view) cursors: the ACTIVE/default views AND the
 * HISTORY views (ADR-0057 D3, 2026-07-22). The history views are what make the
 * backfill full-history rather than active-only: `completed_hauls` carries the
 * bulk of the haul record history (~720+ completed hauls, paginates), and the two
 * inactive-Materials views widen processed/outbound coverage. Both hauls-history
 * and the active hauls bind to the SAME mymrc_hauls_mirror; an id in both an
 * active and the completed view upserts ONCE (mirror key = salesforce_record_id)
 * and its detail is fetched once (`detail_fetched_at IS NULL`, targets run
 * sequentially). Inactive Materials still route by `Type__c` to processed/outbound
 * — reusing the same `warnOnTypeMismatch` guard as the active views.
 *
 * Order is deliberate: hauls first (feeds expected_loads) — active views before
 * the history sweep — then materials (active then inactive), then non-billing
 * dock last.
 */
export function buildBackfillTargets(args: {
  prisma: PrismaClient;
  client: BackfillPortalClient;
  log?: Logger;
}): BackfillTarget[] {
  const deps: TargetDeps = {
    prisma: args.prisma,
    client: args.client,
    resolveSiteId: makeSiteResolver(args.prisma),
    log: args.log ?? noopLog,
  };
  return [
    haulsTarget(deps, 'docking_appointments_rc'),
    haulsTarget(deps, 'consumer_drop_off_rc'),
    haulsTarget(deps, 'completed_hauls'),
    processedTarget(deps, 'processed_active'),
    processedTarget(deps, 'processed_inactive'),
    outboundTarget(deps, 'outbound_active'),
    outboundTarget(deps, 'outbound_inactive'),
    dockTarget(deps),
  ];
}
