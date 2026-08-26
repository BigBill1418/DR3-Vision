// OPEN-ITEMS §0.BO / BO-4 — a truck somebody else drove, and no freight leg.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ The gap this closes                                                       │
// │                                                                           │
// │ Measured on production 2026-08-25:                                        │
// │                                                                           │
// │   sources.is_trans_charge = true          0 of 176 sources                │
// │   inbound_loads.transport_charged = true  0 of 774 loads                  │
// │   freight_cents / fuel_surcharge_cents    NULL on all 774                 │
// │   third-party-carried, uncharged          103 loads / 11,734 units /      │
// │                                           7 carriers, trailing 30 days    │
// │                                                                           │
// │ No Ron Lawrence haul has EVER carried a freight charge in Vision, and     │
// │ nothing in the system was capable of noticing.                            │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── This module NEVER writes, and never guesses a number ────────────────────
//
// It counts and it reports. It does not set `transport_charged`, does not touch
// `sources.is_trans_charge`, does not invent a rate. That restraint is the whole
// point: the CA freight zone table and the fuel-surcharge formula are both
// seeded and tested (`prisma/seed.mjs` `seedTransportRateTiers`;
// `state_program_rules.fuel_surcharge`), and the resolver chain
// (`billing-rates/freight-resolver.ts`) fails loud rather than silently billing
// zero. What does NOT exist anywhere in this repo is WHICH sources are
// transport-charged and how many miles each is — that lives in the Woodland
// workbook's `list` tab (~47 trans-charge sites) and `variables!Mileage_Table`
// (61 rows), and ADR-0037 defers it explicitly. So `is_trans_charge = false` on
// all 176 sources is not wrong data; it is the ABSENCE of data. Seeding a guess
// would launder that absence into truth, which ADR-0040's consequences already
// forbid for `account_haul_rates`.
//
// The remedy is a person entering the classification at `/admin/sources`
// (`sources/admin.ts` `is_trans_charge` + `canonical_mileage`). This module's job
// is to make sure nobody can forget that it has not happened.
//
// ── Why the TRANSPORTER and not the source ──────────────────────────────────
//
// `verify-gate.ts` derives `transport_charged` from `source.is_trans_charge`,
// and leaves the column untouched on a load with NO source — a deliberate
// refuse-to-guess. So the source side cannot distinguish "classified as free"
// from "never classified": both read `false`. `transporters.is_internal` CAN:
// it is populated (1 internal — the DR3 parent account — and 10 third-party
// carriers), and a load somebody else's truck delivered is a load that either
// carries a freight leg or has a documented reason not to.
//
// ── ADR-0037 grading: DIGEST-TIER, NOT A PAGE ───────────────────────────────
//
// One line in the 06:00 AP digest, no ntfy publish. It fails the 5-question gate
// for paging on Q1 and Q3: it is not actionable in five minutes (the fix is a
// data-entry session against a workbook) and there is nothing to self-heal. It
// rides `warnings` rather than an items list for the same reason the doc-ingest
// lines do — a warning sends even when the AP queue is empty, and a silently
// uncharged month produces no AP items at all.
//
// It WILL appear every weekday morning until the classification is entered.
// That is the instrument working: this class went unnoticed for the entire life
// of the system precisely because nothing repeated it.
//
// ── Prior art, and why this is not a duplicate ──────────────────────────────
//
// `invoices/generation-inputs.ts` (ADR-0115 F-4) already `log.warn`s when the
// freight leg resolves ZERO transport-charged loads while billing-ready inbound
// exists — "the invoice is UNDER-BILLED until then". That fires once a month,
// into a log nobody reads on a schedule, at the moment the invoice is being cut.
// This is the same fact, per-load, in a surface a human opens daily, weeks
// earlier. Neither replaces the other.

import type { PrismaClient } from '@prisma/client';
import { INVOICE_STATUSES } from '@/lib/exports';
import { pacificDayISO, pacificDayStartInstantPlus } from '@/lib/time';

/**
 * How far back the count reaches, in Pacific days.
 *
 * A trailing window rather than all-time, and 30 days rather than 14: freight is
 * billed monthly, so a month is the unit in which "we did not charge for this"
 * becomes a number somebody can act on. All-time would make the line a constant
 * that stops being read.
 */
export const UNCHARGED_FREIGHT_WINDOW_DAYS = 30;

export interface UnchargedFreightScan {
  windowDays: number;
  /** The Pacific day the window opens on, `YYYY-MM-DD`. */
  sinceDayISO: string;
  /** Billing-ready loads on a third-party truck with no transport charge. */
  loads: number;
  /** Units on those loads. NOT money — this module never values anything. */
  units: number;
  /** The distinct carriers, named, so the line points somewhere. */
  carriers: string[];
}

/**
 * Count the silent class. Read-only; no writes anywhere in this module.
 *
 * The status filter is `INVOICE_STATUSES` — the same four the invoice exports
 * use. A `rejected` or `voided` load is not a delivery and carries no freight
 * leg to be missing, so counting one would be a false finding, and a false
 * finding on a line that repeats every morning is how an instrument gets ignored.
 */
export async function scanUnchargedThirdPartyFreight(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<UnchargedFreightScan> {
  const since = pacificDayStartInstantPlus(-UNCHARGED_FREIGHT_WINDOW_DAYS, now);
  const rows = await prisma.inboundLoad.findMany({
    where: {
      transport_charged: false,
      status: { in: [...INVOICE_STATUSES] },
      arrived_at: { gte: since },
      // `is_internal: false` on the RELATION, not `transporter_id: { not: null }`.
      // A load with no transporter at all (the 637 aggregate and paper rows) is
      // not evidence of an uncharged third-party haul — it is a row that never
      // named a truck, and Prisma's relation filter excludes it by construction.
      transporter: { is_internal: false },
    },
    select: { total_units: true, transporter: { select: { name: true } } },
  });

  const carriers = new Set<string>();
  let units = 0;
  for (const r of rows) {
    units += r.total_units ?? 0;
    if (r.transporter) carriers.add(r.transporter.name);
  }

  return {
    windowDays: UNCHARGED_FREIGHT_WINDOW_DAYS,
    sinceDayISO: pacificDayISO(since),
    loads: rows.length,
    units,
    carriers: [...carriers].sort(),
  };
}

/**
 * The digest line, or `null` when there is nothing to say.
 *
 * Same shape as `docIngestReauthWarning` / `docIngestDiscoveryGapWarning`, which
 * is how a loads-domain finding is allowed into an AP surface at all: a single
 * string on the `warnings` slot, composed by the module that owns the fact.
 */
export async function unchargedThirdPartyFreightWarning(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<string | null> {
  const scan = await scanUnchargedThirdPartyFreight(prisma, now);
  if (scan.loads === 0) return null;

  const carriers =
    scan.carriers.length <= 3
      ? scan.carriers.join(', ')
      : `${scan.carriers.slice(0, 3).join(', ')} and ${scan.carriers.length - 3} more`;

  return (
    `${scan.loads} load${scan.loads === 1 ? '' : 's'} in the last ${scan.windowDays} days ` +
    `(${scan.units.toLocaleString('en-US')} units) came in on a third-party truck with NO ` +
    `transport charge — ${carriers}. No source is flagged is_trans_charge, so Vision derives ` +
    `no freight or fuel-surcharge line for any of them. Either these hauls genuinely carry no ` +
    `DR3 freight leg, or the source classification and mileage have never been entered ` +
    `(/admin/sources). Nothing is billed either way until somebody decides.`
  );
}
