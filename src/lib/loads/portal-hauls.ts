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

// ── ADR-0074 Amendment 1 (2026-08-10) — THE CONSUMED-SLOT DEFECT ────────────
// The check-in affordance below used to be offered on ONE test: "a non-cancelled
// `expected_loads` sibling exists". That is not the same question as "is there
// work here to start", and the gap cost the floor a morning.
//
// H-134743 (Santa Rita Jail, appointment 2026-08-10 15:00 PT) was STARTED on
// 2026-08-03 17:01 PT — four minutes after `ipad_hauls` went live, and seven days
// early — from the pinned "Coming up" block, which is deliberately unbounded in
// time (D3). It was then worked as if it were the truck on the dock and
// `submitted` on 2026-08-05 with 159 units, against the wrong haul number. When
// the REAL truck arrived on 2026-08-10, `startInboundLoad`'s idempotency on
// `expected_load_id` — correct, and untouched — routed every tap into that
// five-day-old corpse. The floor was unblocked only by an audited manual DB
// detach (`audit_log.actor_label = 'system:santa-rita-detach'`, 15:42 PT).
//
// The affordance now requires THREE conditions, not one: a live sibling, NO
// `inbound_loads` child, and an appointment on the current Pacific day. The
// second closes the dead button; the THIRD closes the mechanism that created the
// mis-attribution in the first place — a consumed-check alone would have left the
// 2026-08-03 tap just as acceptable as it was on the day.
//
// A row that fails any of the three is still LISTED, carrying the reason. The
// alternative — dropping it — reproduces the silence this repo keeps paying for:
// an operator whose truck is on the dock would see an empty screen.

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { pacificDayISO, currentPacificDayWindow } from '@/lib/time';
import {
  CONSUMED_SLOT_SELECT,
  toConsumedLoad,
  type ConsumedLoadRef,
} from '@/lib/loads/consumed-slot';

// Re-exported so callers of this surface keep one import. The TYPE is shared
// with the queue on purpose — both surfaces answer the same question and must
// not drift into two shapes of "already worked".
export type { ConsumedLoadRef };

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
   * The `expected_loads` sibling this haul can be CHECKED IN against — non-null
   * only when the sibling is live, UNCONSUMED, and due on the current Pacific
   * day (D5 + Amendment 1). NULL means read-only: the UI MUST NOT offer a
   * check-in affordance for such a row.
   *
   * This field is the single decision, not a raw id. A caller that wants "does a
   * sibling exist" must not read it — that conflation is the defect Amendment 1
   * closes.
   */
  expectedLoadId: string | null;
  /**
   * Set when the sibling's slot has ALREADY BEEN WORKED. Non-null and
   * `expectedLoadId` non-null are mutually exclusive by construction.
   *
   * Its whole purpose is to let the row say what happened instead of merely
   * going quiet: "already worked — 159 units, submitted 5 Aug" is the answer the
   * dock needed on 2026-08-10 and could not get from any screen.
   */
  consumedLoad: ConsumedLoadRef | null;
  /**
   * ADR-0096 — non-null when this haul's slot is live and unconsumed but
   * scheduled for a DIFFERENT Pacific day. Mutually exclusive with
   * `expectedLoadId` by construction.
   */
  reconcilableExpectedLoadId: string | null;
  /** The slot's own Pacific day, for the confirmation the operator must read. */
  slotDayISO: string | null;
  /**
   * ADR-0099 — non-null when the haul HAS a slot and MyMRC withdrew it. Distinct
   * from `slotDayISO === null` (no slot was ever bridged) and from every other
   * reason `expectedLoadId` is null. The card is read-only either way; the
   * difference is whether it can say why.
   */
  cancelledAt: Date | null;
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
  /**
   * The instant "today" is computed from. Injected so the Pacific-day boundary
   * is testable at 6 PM PT — the hour the equivalent bound broke on the queue
   * (ADR-0065 Amendment 1). Production never passes it.
   */
  now?: Date | undefined;
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

/**
 * What the sibling lookup resolves to for one haul number. Deliberately NOT an
 * id: the caller needs the whole decision, and handing back a bare id is what
 * let the UI ask the wrong question for a week.
 */
interface SiblingVerdict {
  /** Non-null only when the row is genuinely startable right now. */
  startableExpectedLoadId: string | null;
  consumedLoad: ConsumedLoadRef | null;
  /**
   * ADR-0096 — the slot exists, is live and unconsumed, but its appointment is
   * on a DIFFERENT Pacific day. The truck can still be here; this is the state
   * that dead-ended H-136980 on 2026-08-11.
   *
   * Deliberately a SEPARATE field rather than widening `startableExpectedLoadId`
   * to "any day". That bound is what stops a child load being minted onto the
   * wrong slot (the 159-unit mis-booking of ADR-0074 Am.1), so it keeps its exact
   * meaning and the divergent case gets its own name and its own, noisier route.
   */
  reconcilableExpectedLoadId: string | null;
  /** The slot's own Pacific day (`YYYY-MM-DD`) — what the operator must confirm. */
  slotDayISO: string | null;
  /**
   * ADR-0099 — when MyMRC withdrew this slot, or null if it is live.
   *
   * The audit's D-2 finding: a cancelled sibling used to hit a bare `continue`
   * below, which emitted NO verdict at all — so the card fell through to the
   * same "View only" branch as "no sibling" and "not today". Three unrelated
   * conditions, one four-letter label. This field is what lets the card say
   * which one it is.
   */
  cancelledAt: Date | null;
}

function toRow(r: MirrorSelection, expectedByHaulId: Map<string, SiblingVerdict>): PortalHaulRow {
  const verdict = r.external_haul_id ? expectedByHaulId.get(r.external_haul_id) : undefined;
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
    expectedLoadId: verdict?.startableExpectedLoadId ?? null,
    consumedLoad: verdict?.consumedLoad ?? null,
    reconcilableExpectedLoadId: verdict?.reconcilableExpectedLoadId ?? null,
    slotDayISO: verdict?.slotDayISO ?? null,
    cancelledAt: verdict?.cancelledAt ?? null,
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

  // The check-in window: the CURRENT PACIFIC DAY, from the same helper and on the
  // same column the queue page bounds on. Computed once per call so every row on
  // a page is judged against one instant.
  const today = currentPacificDayWindow(args.now ?? new Date());

  const expectedByHaulId = new Map<string, SiblingVerdict>();
  if (haulIds.length > 0) {
    const siblings = await prisma.expectedLoad.findMany({
      where: { site_id: args.siteId, external_mymrc_haul_id: { in: haulIds } },
      select: {
        id: true,
        external_mymrc_haul_id: true,
        cancelled_at: true,
        expected_arrival_at: true,
        // THE FIELD WHOSE ABSENCE WAS THE BUG. Without it this join could not
        // tell a slot waiting for a truck from one worked five days ago.
        inbound_load: { select: CONSUMED_SLOT_SELECT },
      },
    });
    for (const s of siblings) {
      // A CANCELLED expected load is not check-in-able: `startInboundLoad`
      // answers 409 `expected_load_cancelled`, so a control here would be one
      // whose only outcome is a refusal — the thing ADR-0074 Am.1 forbids.
      //
      // ADR-0099 — but it must still SAY SO. This used to be a bare `continue`
      // that emitted no verdict, so the row fell through to the identical "View
      // only" card as "no sibling exists" and "not scheduled today". The
      // operator standing next to a truck whose slot MyMRC withdrew 40 minutes
      // ago got two words and no reason, on the one surface that still showed
      // the row at all — the queue filters it out entirely.
      if (s.cancelled_at !== null) {
        expectedByHaulId.set(s.external_mymrc_haul_id, {
          startableExpectedLoadId: null,
          consumedLoad: s.inbound_load ? toConsumedLoad(s.inbound_load) : null,
          reconcilableExpectedLoadId: null,
          slotDayISO: s.expected_arrival_at !== null ? pacificDayISO(s.expected_arrival_at) : null,
          cancelledAt: s.cancelled_at,
        });
        continue;
      }

      if (s.inbound_load) {
        // CONSUMED. `startInboundLoad` would hand back this existing child, so a
        // button here can only ever land the operator on somebody's finished
        // work. Report it instead.
        expectedByHaulId.set(s.external_mymrc_haul_id, {
          startableExpectedLoadId: null,
          consumedLoad: toConsumedLoad(s.inbound_load),
          // A consumed slot is never reconcilable: the child already exists and
          // ADR-0091 routes into it.
          reconcilableExpectedLoadId: null,
          slotDayISO: null,
          cancelledAt: null,
        });
        continue;
      }

      // NOT TODAY (or undated). A NULL appointment cannot be PROVEN to be today,
      // and 3,316 mirror rows carry no date at all (D3) — so the null must fall
      // on the refusing side. This is the condition that would have stopped the
      // 2026-08-03 tap; the consumed-check above would not have.
      const at = s.expected_arrival_at;
      const startableToday = at !== null && at >= today.start && at < today.endExclusive;

      expectedByHaulId.set(s.external_mymrc_haul_id, {
        startableExpectedLoadId: startableToday ? s.id : null,
        consumedLoad: null,
        // ADR-0096 — dated, live, unconsumed, and NOT today. The undated case is
        // excluded on purpose and stays read-only: there is no day for the
        // operator to confirm, so the server-side assert has nothing to compare
        // and the reconcile cannot be made evidence-bearing.
        reconcilableExpectedLoadId: at !== null && !startableToday ? s.id : null,
        slotDayISO: at !== null ? pacificDayISO(at) : null,
        cancelledAt: null,
      });
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
