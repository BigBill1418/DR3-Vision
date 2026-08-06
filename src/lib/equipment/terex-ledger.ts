// ADR-0077 D6 — the blended machine view: one Terex, one page, three sources
// that are deliberately NOT blended into a single number.
//
// Bill asked for one view of one machine: what it cost, what broke and when, and
// how long it was down. Those three facts live in three tables with three
// different provenances, and the whole design problem is refusing to let them
// look more joined-up than they are:
//
//   1. MAINTENANCE — `doc_terex_maintenance_rows`, absorbed from the TEREX
//      workbook. **`status = 'confirmed'` ONLY.** Staged rows are money nobody
//      has accepted yet (ADR-0069 Am.2's preview-then-confirm gate); putting
//      them on a management view would present a proposal as a fact. A test
//      asserts staged rows never appear, and it was falsified before trusted.
//   2. AP LEDGER — every approved invoice tagged to the canonical equipment row.
//      Real money, already decided, already paid.
//   3. DOWNTIME — `equipment_events.hours_down`, which has never been written
//      (ADR-0077 D4). Renders "not recorded", never 0.
//
// WHAT THIS MODULE DOES NOT DO: match invoices to maintenance events. All four
// production invoices are the same vendor inside six days, so any date-or-amount
// heuristic would manufacture links that look authoritative and are guesses. v1
// shows the two lists side by side and says "not linked" out loud. The
// linked-spend invariant (`linkedCents <= totalCents`) is still asserted, and
// holds trivially at 0 — it is there so that the day someone DOES add matching,
// the guard already exists.
//
// READ-ONLY. This module opens no write path of any kind; the surface it feeds
// adds no writer to any production table.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** Free-text `equipment_code` the ADR-0048 history importer writes. */
const TEREX_EVENT_CODE = 'terex';

/**
 * Is this equipment row THE Terex machine for its site?
 *
 * It has to be asked, because two of this ledger's three panels are keyed on the
 * SITE, not on an equipment id: `doc_terex_maintenance_rows` is scoped by
 * `site_id` (ADR-0069 Am.2) and `equipment_events` by the free-text
 * `equipment_code='terex'` with no FK into the registry (ADR-0048 D3). Hand that
 * pairing a different equipment row and it renders the Terex's maintenance log
 * and downtime under someone else's name.
 *
 * `category` alone is NOT that test, which is the trap this guard exists for.
 * The ADR-0062 seed uses `terex` as the category for SHEAR MACHINES, so
 * production carries five `terex`-category rows: `EQ24/EQ43/EQ74 — Shear
 * Machine` at Woodland, `EQ65 — Sheer Machine Shear Machine` at EUGENE, and the
 * actual machine. Bill confirmed on 2026-08-06 that the Terex operates
 * exclusively at Woodland and Eugene has no use for this data at all — so a
 * ledger offered for that Eugene row would be wrong twice over.
 *
 * The second half of the test is that the Terex-tagged invoices resolve HERE.
 * That is a proxy for identity rather than a declaration of it — the schema has
 * no "this row is the machine the log describes" marker — but it is an
 * evidence-based one: it self-corrects if attribution moves, it needs no
 * hardcoded id or site, and today it selects exactly `7e35a4aa` and nothing
 * else. Recorded as a residual; the real fix is a link from the absorbed rows
 * (or `equipment_events`) to an equipment id.
 */
/**
 * The version whose confirmed rows ARE the maintenance log right now.
 *
 * Absorption stages rows PER REVISION of the workbook, and the unique key is
 * `(doc_source_version_id, sheet_name, row_index)` — so two confirmed revisions
 * of the same document coexist happily in the table, each carrying a complete
 * copy of the log. ADR-0069 Am.2's de-duplication is WITHIN a version (the 2025
 * sheet is a subset of the 2026 sheet); it was never meant to reach across them.
 *
 * This bit on 2026-08-06. Registering the source made all THREE applied
 * revisions absorbable at once and the backlog sweep took all three: 240 staged
 * rows, $231,203.82 — exactly 3 × $77,067.94. The per-version totals were each
 * perfect. Summing every confirmed row for the site is what would have been
 * wrong, and it is what this function stops.
 *
 * Newest absorption wins, which is the right document semantic: a revision
 * SUPERSEDES its predecessor rather than adding to it. Superseded batches are
 * discarded through the normal decision path, but this must not DEPEND on that
 * housekeeping having happened — a management total that is only correct when
 * someone remembered to tidy up is not a guarantee.
 */
async function latestConfirmedVersionId(siteId: string): Promise<string | null> {
  const newest = await prisma.docTerexMaintenanceRow.findFirst({
    where: { site_id: siteId, status: 'confirmed' },
    orderBy: { absorbed_at: 'desc' },
    select: { doc_source_version_id: true },
  });
  return newest?.doc_source_version_id ?? null;
}

function isSiteTerexMachine(category: string, apLinkCount: number): boolean {
  return category === 'terex' && apLinkCount > 0;
}

export interface TerexMaintenanceEvent {
  id: string;
  /** ISO day, set ONLY when the sheet cell held a real date in a plausible range. */
  eventDateISO: string | null;
  /**
   * ALWAYS what the cell actually said. The live file carries `"09/16 or 17"`,
   * a bare `"Jan"`, and a `1/14/202601` typo — rendered as written, never
   * coerced into a date that would then look authoritative (ADR-0069 Am.2).
   */
  eventDateRaw: string | null;
  issue: string | null;
  measuresTaken: string | null;
  /**
   * Verbatim. The column is called "Estimated repair time/cost" and holds free
   * text like `"2 weeks"` — its numeric total across ~90 populated rows is 2.
   * Never parsed, never summed, never used as a duration.
   */
  estimatedTimeCost: string | null;
  /** Integer cents, or NULL = not recorded. Never 0 — an unpriced repair is not free. */
  actualRepairCostCents: number | null;
  amountCreditedCents: number | null;
}

export interface TerexApInvoice {
  linkId: string;
  requestId: string;
  receivedAtISO: string;
  /** `vendor_freeform` (keyed at decision) falling back to the parsed `vendor`. */
  vendor: string | null;
  /**
   * `COALESCE(confirmed_amount_cents, amount_cents)`. Production carries all
   * four of these in the CONFIRMED column with `amount_cents` NULL, so reading
   * `amount_cents` alone reports zero.
   */
  amountCents: number | null;
  /**
   * The AP decision, for callers who can actually open it — `/admin/ap/history`
   * is admin-only, and handing a site manager a link that 403s is the exact
   * defect ADR-0075 opens on ("the one instruction it did give 403s for site
   * managers"). NULL for non-admins, who get the invoice identity inline instead.
   */
  decisionHref: string | null;
}

export interface TerexDowntime {
  /**
   * Σ of non-NULL `hours_down`. **NULL = never recorded**, which is not zero
   * (ADR-0077 D4). NULL on every production Terex event today.
   */
  totalHours: number | null;
  /** How many live events carried a downtime figure at all. */
  eventsWithHours: number;
  /** Live (non-voided) Terex events in scope, recorded downtime or not. */
  eventsConsidered: number;
}

export interface TerexLedger {
  equipment: {
    id: string;
    displayName: string;
    category: string;
    siteId: string;
  } | null;
  maintenance: {
    events: TerexMaintenanceEvent[];
    /** NULL when no confirmed row carried a cost — not 0. */
    totalRepairCents: number | null;
    totalCreditedCents: number | null;
    /**
     * True when the maintenance log has not been absorbed+accepted yet, so the
     * panel renders an honest "awaiting acceptance" state rather than looking
     * like a machine that has never needed a repair. See OPEN-ITEMS O-12.
     */
    awaitingAbsorption: boolean;
  };
  ap: {
    invoices: TerexApInvoice[];
    totalCents: number;
    /** v1 is always 0 — no event↔invoice matching. Invariant: `<= totalCents`. */
    linkedCents: number;
  };
  downtime: TerexDowntime;
}

export interface ComputeOpts {
  /** Admins get the `/admin/ap/history` deep link; managers do not (it 403s). */
  isAdmin?: boolean;
}

/** Decimal(12,2) dollars → integer cents, exactly (decimal.js, no float). */
function toCents(d: Prisma.Decimal | null): number | null {
  return d === null ? null : d.times(100).round().toNumber();
}

/** Σ of the non-null values, or NULL when there were none. Never 0-for-absent. */
function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/**
 * The whole machine, for one equipment row at one site.
 *
 * Returns `equipment: null` when the id does not exist, does not belong to
 * `siteId`, or has been merged away — a merged loser must never render as a
 * live machine, because its attribution has moved and its totals would read as
 * a second machine's. Callers treat null as 404.
 */
export async function computeTerexLedger(
  siteId: string,
  equipmentId: string,
  opts: ComputeOpts = {},
): Promise<TerexLedger> {
  const equipment = await prisma.equipment.findFirst({
    where: { id: equipmentId, site_id: siteId, merged_into_id: null },
    select: { id: true, display_name: true, category: true, site_id: true },
  });

  if (!equipment) {
    return {
      equipment: null,
      maintenance: {
        events: [],
        totalRepairCents: null,
        totalCreditedCents: null,
        awaitingAbsorption: true,
      },
      ap: { invoices: [], totalCents: 0, linkedCents: 0 },
      downtime: { totalHours: null, eventsWithHours: 0, eventsConsidered: 0 },
    };
  }

  const [rows, links, events] = await Promise.all([
    latestConfirmedVersionId(siteId).then((versionId) =>
      versionId === null
        ? []
        : prisma.docTerexMaintenanceRow.findMany({
            // CONFIRMED ONLY (the staged-leak guard depends on this clause) and
            // ONE VERSION ONLY (see `latestConfirmedVersionId`).
            where: { site_id: siteId, status: 'confirmed', doc_source_version_id: versionId },
            orderBy: [{ event_date: 'asc' }, { sheet_name: 'asc' }, { row_index: 'asc' }],
          }),
    ),
    prisma.apEquipmentLink.findMany({
      where: { equipment_id: equipment.id },
      select: {
        id: true,
        request_id: true,
        request: {
          select: {
            received_at: true,
            vendor: true,
            vendor_freeform: true,
            amount_cents: true,
            confirmed_amount_cents: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    }),
    prisma.equipmentEvent.findMany({
      where: { site_id: siteId, equipment_code: TEREX_EVENT_CODE, voided_at: null },
      select: { hours_down: true },
    }),
  ]);

  // A `terex`-category row with no Terex invoices behind it is a shear machine,
  // not the machine — refuse it exactly as we refuse a merged-away or off-site id.
  if (!isSiteTerexMachine(equipment.category, links.length)) {
    return {
      equipment: null,
      maintenance: {
        events: [],
        totalRepairCents: null,
        totalCreditedCents: null,
        awaitingAbsorption: true,
      },
      ap: { invoices: [], totalCents: 0, linkedCents: 0 },
      downtime: { totalHours: null, eventsWithHours: 0, eventsConsidered: 0 },
    };
  }

  const maintenanceEvents: TerexMaintenanceEvent[] = rows.map((r) => ({
    id: r.id,
    eventDateISO: r.event_date ? r.event_date.toISOString().slice(0, 10) : null,
    eventDateRaw: r.event_date_raw,
    issue: r.issue,
    measuresTaken: r.measures_taken,
    estimatedTimeCost: r.estimated_time_cost,
    actualRepairCostCents: toCents(r.actual_repair_cost),
    amountCreditedCents: toCents(r.amount_credited),
  }));

  const invoices: TerexApInvoice[] = links.map((l) => ({
    linkId: l.id,
    requestId: l.request_id,
    receivedAtISO: l.request.received_at.toISOString(),
    vendor: l.request.vendor_freeform ?? l.request.vendor,
    amountCents: l.request.confirmed_amount_cents ?? l.request.amount_cents,
    decisionHref: opts.isAdmin ? `/admin/ap/history?request=${l.request_id}` : null,
  }));

  const hours = events
    .map((e) => (e.hours_down === null ? null : e.hours_down.toNumber()))
    .filter((h): h is number => h !== null);

  return {
    equipment: {
      id: equipment.id,
      displayName: equipment.display_name,
      category: equipment.category,
      siteId: equipment.site_id,
    },
    maintenance: {
      events: maintenanceEvents,
      totalRepairCents: sumOrNull(maintenanceEvents.map((e) => e.actualRepairCostCents)),
      totalCreditedCents: sumOrNull(maintenanceEvents.map((e) => e.amountCreditedCents)),
      awaitingAbsorption: maintenanceEvents.length === 0,
    },
    ap: {
      invoices,
      totalCents: invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0),
      // v1: no matching. Kept explicit so the `linked <= total` guard has
      // something real to measure the day matching arrives.
      linkedCents: 0,
    },
    downtime: {
      totalHours: hours.length === 0 ? null : hours.reduce((a, b) => a + b, 0),
      eventsWithHours: hours.length,
      eventsConsidered: events.length,
    },
  };
}
