// OPEN-ITEMS §0.BO — the Lake County truck was worked on the Mt View haul card.
//
// EXECUTED ONCE against production on 2026-08-25, at Bill's explicit
// authorization of the §0.BO proposed correction (BO-1).
//
// ── What happened ──────────────────────────────────────────────────────────
//
// The 9:30 AM Woodland truck was Lake County Waste Solutions haul H-138155,
// carried by Ron Lawrence & Son (truck 113 / trailer 10744). Nate Cullison
// worked it start to finish on the RECOLOGY MOUNTAIN VIEW card H-138504 — a
// different supplier, on DR3's own transport account. The load itself is real
// and fully worked (135 units, 11 stacks, BOL + door-open photos, status
// `submitted`); only its ATTRIBUTION is wrong. MyMRC's own mirror already
// carries H-138155 = 135 units delivered 2026-08-25, so the external truth is
// right and it is Vision's internal record that diverges.
//
// At 4:21 PM Janette Tomas opened the still-free Lake County slot as a SECOND
// load and stopped at `arrived` with zero stacks and two junk photos (the
// office floor). `submitted` is inside `INVOICE_STATUSES`, so completing that
// duplicate would have booked ~270 units against one 135-unit truck.
//
// ── Why this is a script and not a product surface ─────────────────────────
//
// Leg 1 (the void) IS a product surface and is driven as one: `voidLoad`
// (ADR-0090 D2) accepts an `arrived` load, severs its `expected_loads` slot and
// writes its own in-transaction audit row. Nothing is hand-rolled there.
//
// Leg 2 (the re-point) has NO shipped path. ADR-0090 D2.3 deliberately refuses
// a floor-side void past `submitted` ("the load has left the floor's hands"),
// and hands the correction to ADR-0073 (manager load corrections), which is
// still proposed — design only, nothing implemented. So the re-point is a
// scripted, guarded, audited UPDATE, authorized by Bill per BO-1, and kept as
// narrow as three columns. ADR-0090's own warning about hand DB surgery is the
// reason this file exists at all rather than a psql session: the guard, the
// before/after audit row and the reversibility snapshot are the product-level
// guardrail, written down.
//
// ── The guard ──────────────────────────────────────────────────────────────
//
// Every column of the frozen before-snapshot is re-asserted in the `updateMany`
// WHERE (ADR-0118 D1 — the condition rides the statement, not a read taken
// before it). If ANY of it moved between the investigation and this run, the
// statement matches zero rows and the whole transaction rolls back. Nothing is
// written on a stale premise.
//
// ── Deliberately NOT done (see §0.BO after-state for the reasoning) ────────
//
//   - `transport_charged` is left FALSE. §0.BO proposed flipping it on the
//     theory that a Ron Lawrence haul is a billable third-party leg. Measured
//     live before writing: `sources.is_trans_charge` is FALSE on ALL 176
//     sources, and `transport_charged` is FALSE with `freight_cents` /
//     `fuel_surcharge_cents` NULL on ALL 774 inbound loads — including all 74
//     Ron Lawrence loads and the one prior Lake County load (`9bd22dd4…`,
//     2026-08-05). There is no precedent to match because the classifier has
//     never been populated. The verify gate derives this column from
//     `sources.is_trans_charge` (verify-gate.ts, ADR-0125 G-2), so re-pointing
//     the source is exactly what makes the app derive it correctly whenever
//     that seed is fixed. Setting `true` here by hand would make this the ONLY
//     true row in the table and the sole input to
//     `resolveTransportationInputs` — with a NULL `freight_cents` — which is a
//     worse distortion than the consistent understatement. Bill's call: BO-4.
//
//   - `weight_lbs` is left NULL and `weight_skipped_at` is left standing. The
//     paper BOL carries a certified NET weight of 23,600 lbs, but `weight_lbs`
//     is captured in the app only alongside a `weight_ticket` PHOTO, and this
//     load has none — writing the number would mint a compliance record with no
//     evidence behind it and a fabricated `weight_captured_at`. `correctWeight`
//     (ADR-0090 Am.1 B) refuses a `submitted` load by design for the same
//     reason. "There was no weight ticket" also remains TRUE as the operator
//     declared it: a BOL certified weight is not a scale ticket. Bill's call:
//     BO-5.
//
//   - `external_mymrc_haul_id` is left NULL. It is set only by the MyMRC bridge
//     and the EOD add-line, never by a dock capture; all 74 Ron Lawrence loads
//     have it NULL. Not a regression, and not in the authorized scope.
//
// RUN: npx tsx scripts/one-off/2026-08-25-bo-lake-county-repoint.ts [--apply]
// (DATABASE_URL exported to the production DB; dry run without --apply.)

import { voidLoad } from '../../src/lib/load-service';
import { writeAudit } from '../../src/lib/audit';
import { prisma } from '../../src/lib/prisma';

/** The real, fully-worked load that was filed against the wrong supplier. */
const REAL_LOAD = '4a8f071d-5fdb-4a02-801b-a9a879a60f30';
/** The empty duplicate opened on the correct card six hours later. */
const DUPLICATE_LOAD = 'ff061601-2d65-40d9-9499-a537aaf82bb9';

const WOODLAND_SITE = 'de9875a3-a09f-484f-aed1-2891ef544b87';

const MT_VIEW_SOURCE = '2c5e6f34-192a-42c2-8bd6-edb9e1665cf0';
const LAKE_COUNTY_SOURCE = 'a471ef1d-6686-44c4-8270-68c59f7a48e5';
const DR3_PARENT_TRANSPORTER = '8a13378c-6c7e-4f36-bff0-aa1458eaea96';
const RON_LAWRENCE_TRANSPORTER = '3bf3ea0e-fb43-43e9-8d0b-8a006c64d9f8';
/** H-138504 — freed by the re-point so the Mt View truck can still check in. */
const MT_VIEW_SLOT = '3ab8434d-8d65-4f0d-b9d3-cfa9e65f44fe';
/** H-138155 — freed by the void, then claimed by the real load. */
const LAKE_COUNTY_SLOT = '8ee5588e-ab61-4986-bb5c-5f0204661dcf';

/** Janette Tomas — the duplicate's assigned operator. */
const JANETTE = 'e319ec7a-7891-44cb-bbf7-e15412d65030';
/** Nate Cullison — the real load's assigned operator; untouched by this script. */
const NATE = '21a42252-5c2e-4cec-b2fd-eb04041390f7';

const ACTOR_LABEL =
  'system:bo-lake-county-repoint (OPEN-ITEMS 0.BO / BO-1, executed by Claude Code ' +
  "at Bill's explicit authorization 2026-08-25)";

/**
 * `voidLoad` takes an `operatorUserId` and both ownership-checks and ATTRIBUTES
 * on it — there is no manager or label-actor void path (`voidLoadAction` is the
 * only caller and it is an operator server action). So the void's own audit row
 * will name Janette, who did not decide it. That is a misattribution and it is
 * not left to be discovered: this supplementary row is written immediately
 * after, in the same run, naming the real actor and the authorization.
 *
 * The alternative — hand-rolling the void's five column writes to get the label
 * right — would have thrown away the transition guard, the severing and the
 * audit shape that ADR-0090 C exists to guarantee. Attribution is recoverable
 * from an extra append-only row; a hand-rolled void is not recoverable at all.
 */
const VOID_ATTRIBUTION_NOTE =
  'voidLoad requires the assigned operator id and attributes its audit row to it, so the ' +
  'preceding void row names Janette Tomas. She did not make this decision and was not ' +
  "consulted: the void was executed out-of-band by Claude Code at Bill's authorization of " +
  'OPEN-ITEMS 0.BO / BO-1. There is no manager-actor or label-actor void path (ADR-0073, ' +
  'which would own one, is proposed only).';

const REPOINT_NOTE =
  'Operator mis-file correction. The 2026-08-25 9:30 AM Woodland truck was Lake County Waste ' +
  'Solutions haul H-138155 carried by Ron Lawrence & Son (truck 113 / trailer 10744); it was ' +
  'worked start to finish on the Recology Mountain View card H-138504. Evidence: the BOL photo ' +
  'on this load reads H-138155 / LAKE COUNTY WASTE, Lakeport CA / RON LAWRENCE AND SON ' +
  'TRANSPORT; MyMRC mirror H-138155 = 135 units delivered 2026-08-25 while H-138504 = 0 with no ' +
  'delivery date; the floor count (135) matches the recycler exactly. The load, its 11 stacks, ' +
  'its photos and every workflow timestamp are correct for the Lake County truck and are NOT ' +
  'touched — only source, transporter and the expected-load slot move. The empty duplicate ' +
  'ff061601-2d65-40d9-9499-a537aaf82bb9 was voided (wrong_haul) immediately before this, freeing ' +
  'slot 8ee5588e. Mt View slot 3ab8434d is released back to free so H-138504 can still check in. ' +
  'No shipped path exists for a post-submitted re-point (ADR-0090 D2.3 refuses it, ADR-0073 is ' +
  'unbuilt), so this is a scripted guarded UPDATE authorized by Bill per BO-1.';

/**
 * The frozen before-state, restated as the WHERE of the guarded write.
 *
 * Not merely the three columns being changed: a load whose status, units or
 * timestamps moved since the investigation is a DIFFERENT load in every sense
 * that matters, and the correction must refuse it rather than apply to it.
 */
const REAL_LOAD_BEFORE = {
  id: REAL_LOAD,
  site_id: WOODLAND_SITE,
  status: 'submitted',
  source_id: MT_VIEW_SOURCE,
  transporter_id: DR3_PARENT_TRANSPORTER,
  expected_load_id: MT_VIEW_SLOT,
  total_units: 135,
  assigned_operator_id: NATE,
  submitted_by_id: NATE,
  voided_at: null,
} as const;

function iso(d: Date | null): string | null {
  return d == null ? null : d.toISOString();
}

async function snapshot(): Promise<void> {
  const loads = await prisma.inboundLoad.findMany({
    where: { id: { in: [REAL_LOAD, DUPLICATE_LOAD] } },
    select: {
      id: true,
      status: true,
      source_id: true,
      transporter_id: true,
      expected_load_id: true,
      voided_from_expected_load_id: true,
      void_reason: true,
      voided_at: true,
      total_units: true,
      transport_charged: true,
      weight_lbs: true,
      weight_skipped_at: true,
      arrived_at: true,
      unload_started_at: true,
      unload_finished_at: true,
      submitted_at: true,
      unload_duration_seconds: true,
      count_mode: true,
    },
    orderBy: { arrived_at: 'asc' },
  });
  for (const l of loads) {
    console.log(
      JSON.stringify(
        {
          ...l,
          voided_at: iso(l.voided_at),
          weight_skipped_at: iso(l.weight_skipped_at),
          arrived_at: iso(l.arrived_at),
          unload_started_at: iso(l.unload_started_at),
          unload_finished_at: iso(l.unload_finished_at),
          submitted_at: iso(l.submitted_at),
        },
        null,
        2,
      ),
    );
  }
  const slots = await prisma.expectedLoad.findMany({
    where: { id: { in: [MT_VIEW_SLOT, LAKE_COUNTY_SLOT] } },
    select: {
      id: true,
      external_mymrc_haul_id: true,
      cancelled_at: true,
      inbound_load: { select: { id: true, status: true } },
    },
  });
  for (const s of slots) {
    console.log(
      `slot ${s.external_mymrc_haul_id} (${s.id}): child = ` +
        (s.inbound_load ? `${s.inbound_load.id} [${s.inbound_load.status}]` : 'NONE (free)'),
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  console.log(`\n=== BEFORE (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  await snapshot();

  // ── Guard, read side. The write below re-asserts all of this atomically; this
  // read exists to FAIL LOUDLY AND EARLY with a diff a human can act on, rather
  // than as the basis for the write.
  const real = await prisma.inboundLoad.findUnique({
    where: { id: REAL_LOAD },
    select: {
      id: true,
      site_id: true,
      status: true,
      source_id: true,
      transporter_id: true,
      expected_load_id: true,
      total_units: true,
      assigned_operator_id: true,
      submitted_by_id: true,
      voided_at: true,
    },
  });
  if (!real) throw new Error(`real load ${REAL_LOAD} not found`);
  for (const [k, want] of Object.entries(REAL_LOAD_BEFORE)) {
    const got = (real as Record<string, unknown>)[k];
    if (got !== want) {
      throw new Error(
        `PRECONDITION FAILED on ${REAL_LOAD}.${k}: expected ${String(want)}, found ${String(got)} — ` +
          'the load moved since the 0.BO investigation. NOTHING WRITTEN. Re-investigate.',
      );
    }
  }

  const dup = await prisma.inboundLoad.findUnique({
    where: { id: DUPLICATE_LOAD },
    select: {
      status: true,
      site_id: true,
      assigned_operator_id: true,
      expected_load_id: true,
      total_units: true,
    },
  });
  if (!dup) throw new Error(`duplicate load ${DUPLICATE_LOAD} not found`);
  if (
    dup.status !== 'arrived' ||
    dup.site_id !== WOODLAND_SITE ||
    dup.assigned_operator_id !== JANETTE ||
    dup.expected_load_id !== LAKE_COUNTY_SLOT ||
    dup.total_units !== null
  ) {
    throw new Error(
      `PRECONDITION FAILED on ${DUPLICATE_LOAD}: ${JSON.stringify(dup)} — it was worked further ` +
        'since the 0.BO investigation. NOTHING WRITTEN. Re-investigate.',
    );
  }

  if (!apply) {
    console.log('\n=== DRY RUN — preconditions PASS, nothing written. Re-run with --apply. ===');
    return;
  }

  // ── LEG 1 — void the duplicate through the shipped path (ADR-0090 D2). ────
  // This severs `expected_load_id`, freeing slot 8ee5588e for leg 2, and writes
  // its own in-transaction audit row.
  console.log('\n[leg 1] voidLoad(duplicate, wrong_haul) …');
  await voidLoad({
    loadId: DUPLICATE_LOAD,
    operatorUserId: JANETTE,
    siteId: WOODLAND_SITE,
    reason: 'wrong_haul',
    note: null,
  });
  await writeAudit({
    actor_label: ACTOR_LABEL,
    action: 'update',
    table_name: 'inbound_loads',
    row_id: DUPLICATE_LOAD,
    after: {
      correction: 'void_actor_attribution',
      void_executed_by: 'Claude Code (out-of-band, one-off script)',
      authorization: 'Bill, OPEN-ITEMS 0.BO / BO-1, 2026-08-25',
      note: VOID_ATTRIBUTION_NOTE,
    },
  });
  console.log('[leg 1] voided; slot 8ee5588e freed.');

  // ── LEG 2 — re-point the real load. ──────────────────────────────────────
  console.log('\n[leg 2] re-point real load …');
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.inboundLoad.updateMany({
      // The whole before-snapshot rides the statement (ADR-0118 D1). A row that
      // moved matches zero and the transaction rolls back.
      where: { ...REAL_LOAD_BEFORE },
      data: {
        source_id: LAKE_COUNTY_SOURCE,
        transporter_id: RON_LAWRENCE_TRANSPORTER,
        expected_load_id: LAKE_COUNTY_SLOT,
      },
    });
    if (count !== 1) {
      throw new Error(
        `guarded re-point matched ${count} rows, expected 1 — rolled back, nothing written`,
      );
    }
    await writeAudit(
      {
        actor_label: ACTOR_LABEL,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: REAL_LOAD,
        before: {
          source_id: MT_VIEW_SOURCE,
          source_name: 'Recology Mountain View',
          transporter_id: DR3_PARENT_TRANSPORTER,
          transporter_name:
            'St. Vincent de Paul Society of Lane County, Inc - DR3 parent account CA',
          expected_load_id: MT_VIEW_SLOT,
          expected_haul: 'H-138504',
        },
        after: {
          source_id: LAKE_COUNTY_SOURCE,
          source_name: 'Lake County Waste Solutions, Inc.',
          transporter_id: RON_LAWRENCE_TRANSPORTER,
          transporter_name: 'Ron Lawrence & Son',
          expected_load_id: LAKE_COUNTY_SLOT,
          expected_haul: 'H-138155',
          reason: 'operator_misfile_correction',
          note: REPOINT_NOTE,
          left_unchanged: {
            transport_charged: false,
            weight_lbs: null,
            weight_skipped_at: 'standing',
            external_mymrc_haul_id: null,
            rationale: 'see OPEN-ITEMS 0.BO BO-4 / BO-5 and this script header',
          },
        },
      },
      { tx },
    );
  });
  console.log('[leg 2] re-pointed.');

  console.log('\n=== AFTER ===');
  await snapshot();
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
