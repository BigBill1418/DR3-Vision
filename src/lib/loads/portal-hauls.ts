// ADR-0074 — the iPad's OPEN, searchable, newest-first read of the MyMRC haul
// mirror. Read-only. Zero writes. No row is ever synthesized from here.
//
// ── Why this module exists ───────────────────────────────────────────────────
// The floor iPad's only window onto MyMRC was `/queue`, which lists
// `expected_loads` bounded to the current Pacific day (ADR-0065 D5). Measured on
// production (dr3_vision on CHAD-HQ) 2026-08-03 13:17 PT:
//
//     mymrc_hauls_mirror            7,285 rows
//     expected_loads                  718 rows
//     visible on the iPad today         5 rows   (0.07% of the mirror)
//
// Bill's directive (2026-08-03): on-site iPad operators must be able to see ANY
// pending haul or load from the MyMRC portal, searchable, newest to oldest. This
// module is the read half of that. It reads the MIRROR (D1), not
// `expected_loads`, because the mirror is the only table that carries every haul
// the portal has ever shown us — `expected_loads` holds 714 mirror rows' worth of
// join (9.8%), and it exists to drive the dock workflow, not to be a catalogue.
//
// ── `disappeared_at` IS DELIBERATELY NOT A FILTER (ADR-0074 D2) ──────────────
// LOAD-BEARING. Do not "tidy this up" by excluding rows with a `disappeared_at`
// stamp. Measured on production 2026-08-03: 5,455 of the 6,269 `Delivered` /
// `General` mirror rows carry one. Per ADR-0070 Amendment 1 §3 the stamp means
// "this id was absent from the last swept LIST VIEW", not "this haul is gone" —
// MyMRC's list views are windowed and a delivered haul rolls out of them as a
// matter of course. Filtering on it would hide 87% of the delivered hauls, which
// is precisely the blindness this ADR exists to end.
//
// What IS excluded is a two-value status denylist (`Rejected`, `Inactive`) —
// hauls the portal itself has taken off the table. The check is NULL-TOLERANT by
// construction: a NULL status means "we have not detailed this row yet", which is
// unknown, never excluded. (Production carries zero NULL-status rows today; the
// tolerance is for the ingestion window, where a list-pass row exists before its
// detail pass lands.)

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

/**
 * Statuses the portal itself has retired. Everything else — including the
 * undocumented fifth status and anything MyMRC invents next — stays visible.
 * A denylist, not an allowlist: an unknown status must surface, not vanish.
 */
export const EXCLUDED_HAUL_STATUSES = ['Rejected', 'Inactive'] as const;

/** The status that means "scheduled, not yet delivered" — the pinned top block. */
export const PENDING_HAUL_STATUS = 'Confirmed';

/** Server-fixed page size. Not client-supplied: this is an iPad, not an export. */
export const PORTAL_HAULS_PER_PAGE = 50;

/** Longest `?q=` we honour. Mirrors `hauls/list-url.ts` SEARCH_MAX. */
const SEARCH_MAX = 100;

export interface PortalHaulRow {
  /** Salesforce record id — the mirror PK. Never rendered. */
  id: string;
  /** Portal haul number, e.g. "H-136271". The operator's handle on the row. */
  externalHaulId: string | null;
  status: string | null;
  type: string | null;
  transporterName: string | null;
  collectionSite: string | null;
  collectionSource: string | null;
  /**
   * `Docking_Appointment_Date__c`. Stored at 12:00 so every timezone renders the
   * same calendar day; safe through the Pacific-pinned `formatDate`.
   */
  dockingDate: Date | null;
  /** A true instant parsed from the free-text appointment time. Pacific-pinned. */
  dockingAt: Date | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  consumerDropoffUnits: number | null;
  /**
   * The `expected_loads` sibling this haul was bridged into, when one exists and
   * is not cancelled. NULL means read-only: there is nothing to check in against,
   * and the UI MUST NOT offer a check-in affordance for such a row (D5).
   */
  expectedLoadId: string | null;
}

export interface PortalHaulsPage {
  rows: PortalHaulRow[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  /** Every `Confirmed` haul for the site, unpaginated — the pinned top block. */
  pending: PortalHaulRow[];
  /** How many visible hauls carry no docking date at all (the chip's count). */
  undatedCount: number;
}

/**
 * How many hauls the portal has scheduled but not yet marked delivered.
 *
 * Its own tiny query so the hub can badge the card without loading a page of
 * rows. Read-only, like everything in this module.
 */
export function countPendingPortalHauls(siteId: string): Promise<number> {
  return prisma.mymrcHaulsMirror.count({
    where: { site_id: siteId, status: PENDING_HAUL_STATUS },
  });
}

export interface ListPortalHaulsArgs {
  /** Server-derived. NEVER a client-supplied site id. */
  siteId: string;
  q?: string | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
  undatedOnly?: boolean | undefined;
}

/**
 * The NULL-tolerant status denylist, written out rather than expressed as
 * `NOT: { status: { in: [...] } }`.
 *
 * In SQL, `NULL NOT IN ('Rejected','Inactive')` evaluates to NULL, so a
 * not-yet-detailed row would be silently dropped. Rather than depend on whether
 * the ORM special-cases nullable columns, the tolerance is stated explicitly and
 * is therefore provable from this file alone.
 */
function visibleStatusFilter(): Prisma.MymrcHaulsMirrorWhereInput {
  return {
    OR: [{ status: null }, { status: { notIn: [...EXCLUDED_HAUL_STATUSES] } }],
  };
}

/** Case-insensitive substring search across the four fields an operator knows. */
function searchFilter(q: string): Prisma.MymrcHaulsMirrorWhereInput {
  const term = q.slice(0, SEARCH_MAX);
  return {
    OR: [
      { external_haul_id: { contains: term, mode: 'insensitive' } },
      { transporter_name: { contains: term, mode: 'insensitive' } },
      { collection_site: { contains: term, mode: 'insensitive' } },
      { collection_source: { contains: term, mode: 'insensitive' } },
    ],
  };
}

function buildWhere(args: {
  siteId: string;
  q?: string | undefined;
  undatedOnly?: boolean | undefined;
}): Prisma.MymrcHaulsMirrorWhereInput {
  const and: Prisma.MymrcHaulsMirrorWhereInput[] = [visibleStatusFilter()];
  const term = args.q?.trim();
  if (term) and.push(searchFilter(term));
  return {
    site_id: args.siteId,
    ...(args.undatedOnly ? { docking_appointment_date: null } : {}),
    AND: and,
  };
}

const SELECT = {
  id: true,
  external_haul_id: true,
  status: true,
  type: true,
  transporter_name: true,
  collection_site: true,
  collection_source: true,
  docking_appointment_date: true,
  docking_appointment_at: true,
  program_unit_count: true,
  non_program_unit_count: true,
  unpaid_consumer_dropoff_units: true,
} as const;

type MirrorSelection = {
  id: string;
  external_haul_id: string | null;
  status: string | null;
  type: string | null;
  transporter_name: string | null;
  collection_site: string | null;
  collection_source: string | null;
  docking_appointment_date: Date | null;
  docking_appointment_at: Date | null;
  program_unit_count: number | null;
  non_program_unit_count: number | null;
  unpaid_consumer_dropoff_units: number | null;
};

/**
 * Newest first, undated LAST.
 *
 * `nulls: 'last'` is the whole reason undated hauls survive at all: 3,316 of the
 * 7,285 mirror rows carry no docking date (measured 2026-08-03), and Postgres
 * sorts NULLs FIRST under `DESC` by default. Without the explicit `nulls`, half
 * the list would be undated rows above every real appointment. They are sorted
 * to the bottom and reachable through the `Undated (N)` chip — never dropped.
 * `external_haul_id DESC` is the tiebreaker so the order is total and stable
 * (haul numbers are monotonic, so it is also "newest first" within a day).
 */
const ORDER_BY: Prisma.MymrcHaulsMirrorOrderByWithRelationInput[] = [
  { docking_appointment_date: { sort: 'desc', nulls: 'last' } },
  { external_haul_id: 'desc' },
];

function toRow(r: MirrorSelection, expectedByHaulId: Map<string, string>): PortalHaulRow {
  return {
    id: r.id,
    externalHaulId: r.external_haul_id,
    status: r.status,
    type: r.type,
    transporterName: r.transporter_name,
    collectionSite: r.collection_site,
    collectionSource: r.collection_source,
    dockingDate: r.docking_appointment_date,
    dockingAt: r.docking_appointment_at,
    programUnits: r.program_unit_count,
    nonProgramUnits: r.non_program_unit_count,
    consumerDropoffUnits: r.unpaid_consumer_dropoff_units,
    expectedLoadId: r.external_haul_id ? (expectedByHaulId.get(r.external_haul_id) ?? null) : null,
  };
}

/**
 * One page of the site's portal hauls, plus the pinned pending block and the
 * undated count.
 *
 * Read-only by construction: this module performs `findMany` / `count` and
 * nothing else. It NEVER creates an `ExpectedLoad` or an `InboundLoad` to make a
 * mirror row actionable — a haul MyMRC has not bridged is information, not work
 * (ADR-0074 D5). The check-in affordance is offered only where a real, live
 * `expected_loads` sibling already exists.
 */
export async function listPortalHauls(args: ListPortalHaulsArgs): Promise<PortalHaulsPage> {
  const perPage =
    args.perPage && args.perPage > 0
      ? Math.min(args.perPage, PORTAL_HAULS_PER_PAGE)
      : PORTAL_HAULS_PER_PAGE;
  const page = args.page && args.page > 0 ? Math.floor(args.page) : 1;
  const where = buildWhere(args);

  const [total, rawRows, rawPending, undatedCount] = await Promise.all([
    prisma.mymrcHaulsMirror.count({ where }),
    prisma.mymrcHaulsMirror.findMany({
      where,
      select: SELECT,
      orderBy: ORDER_BY,
      take: perPage,
      skip: (page - 1) * perPage,
    }),
    // The pending block is the site's whole `Confirmed` set — unpaginated and
    // deliberately NOT narrowed by the search term or the undated chip, so the
    // "what is coming" answer never depends on what the operator typed.
    prisma.mymrcHaulsMirror.findMany({
      where: { site_id: args.siteId, status: PENDING_HAUL_STATUS },
      select: SELECT,
      orderBy: ORDER_BY,
    }),
    prisma.mymrcHaulsMirror.count({
      where: { ...buildWhere({ siteId: args.siteId }), docking_appointment_date: null },
    }),
  ]);

  const rows = rawRows as MirrorSelection[];
  const pending = rawPending as MirrorSelection[];

  // ONE join query for both blocks. `external_mymrc_haul_id` is unique on
  // `expected_loads`, so this is at most one row per haul number.
  const haulIds = [...rows, ...pending]
    .map((r) => r.external_haul_id)
    .filter((v): v is string => v !== null);

  const expectedByHaulId = new Map<string, string>();
  if (haulIds.length > 0) {
    const siblings = await prisma.expectedLoad.findMany({
      where: { site_id: args.siteId, external_mymrc_haul_id: { in: haulIds } },
      select: { id: true, external_mymrc_haul_id: true, cancelled_at: true },
    });
    for (const s of siblings) {
      // A CANCELLED expected load is not check-in-able. Mapping it would render a
      // button whose server action refuses — worse than no button at all.
      if (s.cancelled_at === null) expectedByHaulId.set(s.external_mymrc_haul_id, s.id);
    }
  }

  return {
    rows: rows.map((r) => toRow(r, expectedByHaulId)),
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    pending: pending.map((r) => toRow(r, expectedByHaulId)),
    undatedCount,
  };
}
