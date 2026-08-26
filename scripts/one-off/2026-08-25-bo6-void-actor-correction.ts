// OPEN-ITEMS §0.BO / BO-6 — the void that named the wrong person.
//
// ADR-0128. `voidLoad` used one argument for two jobs: the ownership check and
// the attribution. The 2026-08-25 Lake County correction voided the duplicate
// load through that shipped path — deliberately, to keep the transition guard,
// the slot severing and the ADR-0090 C audit shape — and `voided_by` came out
// naming **Janette Tomas** for a decision Bill made and a script executed.
//
// The truth was recorded at the time, in a supplementary append-only audit row
// under `actor_label = 'system:bo-lake-county-repoint (…)'`. But §0.BO's own
// words: *"A reader of `inbound_loads.voided_by` alone will still get the wrong
// answer."* ADR-0128 gives the void path a way to name a non-user actor; this
// script uses it on the one row that predates it.
//
// ── Why this is a script and not left as-is ────────────────────────────────
//
// The supplementary row makes the misattribution RECOVERABLE, not absent. Every
// surface that renders "voided by" reads the column, not the log. Leaving a
// named employee attached to a decision she did not make, on a compliance record
// retained indefinitely, is not a cosmetic residual.
//
// ── Why it is safe ─────────────────────────────────────────────────────────
//
// One row, matched on its full before-state (ADR-0118 D1 — the premise rides the
// statement). The void itself is NOT re-run and nothing about the load's status,
// reason, instant or severed slot changes: only who is recorded as having
// decided it. If the row has moved, the update matches zero and the transaction
// rolls back with nothing written.
//
// PRECONDITION: the ADR-0128 migration (`20260857_adr0128_void_actor_label`) must
// already be deployed — the script asserts the column exists before writing.
//
// RUN: npx tsx scripts/one-off/2026-08-25-bo6-void-actor-correction.ts [--apply]

import { prisma } from '../../src/lib/prisma';
import { writeAudit } from '../../src/lib/audit';

/** The empty duplicate opened on the correct card and voided at 4:48 PM PT. */
const DUPLICATE_LOAD = 'ff061601-2d65-40d9-9499-a537aaf82bb9';
/** Janette Tomas — the holder, whose id `voidLoad` borrowed and then signed with. */
const JANETTE = 'e319ec7a-7891-44cb-bbf7-e15412d65030';
/** H-138155 — the slot the void severed. */
const LAKE_COUNTY_SLOT = '8ee5588e-ab61-4986-bb5c-5f0204661dcf';

const NEW_LABEL =
  'system:bo-lake-county-repoint (OPEN-ITEMS 0.BO / BO-1, executed by Claude Code ' +
  "at Bill's explicit authorization 2026-08-25)";

const ACTOR_LABEL =
  'system:bo6-void-actor-correction (OPEN-ITEMS 0.BO / BO-6, ADR-0128, 2026-08-25)';

const NOTE =
  'Attribution-only correction. voidLoad took a single operatorUserId and used it BOTH to ' +
  'authorize the void (Janette Tomas held the load) AND to attribute it, so voided_by named ' +
  'her for a decision Bill authorized and a one-off script executed. ADR-0128 splits the two ' +
  'and adds voided_by_label for a non-user actor. voided_by is cleared and the label now ' +
  'carries the real actor; the holder remains on assigned_operator_id and in the audit trail. ' +
  'The void itself — status, reason, instant, severed slot — is NOT re-run and NOT changed.';

/** The frozen before-state, restated as the WHERE of the guarded write. */
const BEFORE = {
  id: DUPLICATE_LOAD,
  status: 'voided',
  void_reason: 'wrong_haul',
  voided_by: JANETTE,
  voided_by_label: null,
  voided_from_expected_load_id: LAKE_COUNTY_SLOT,
  expected_load_id: null,
  assigned_operator_id: JANETTE,
  total_units: null,
} as const;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  // The migration must be live. Asked of the DB rather than assumed: running
  // this against a pre-migration database would fail mid-transaction with a
  // Prisma error that says nothing about why.
  const [col] = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*)::bigint as n from information_schema.columns
    where table_name = 'inbound_loads' and column_name = 'voided_by_label'`;
  if (!col || Number(col.n) !== 1) {
    throw new Error(
      'PRECONDITION FAILED: inbound_loads.voided_by_label does not exist. Deploy migration ' +
        '20260857_adr0128_void_actor_label first. NOTHING WRITTEN.',
    );
  }

  const row = await prisma.inboundLoad.findUnique({
    where: { id: DUPLICATE_LOAD },
    select: {
      id: true,
      status: true,
      void_reason: true,
      voided_at: true,
      voided_by: true,
      voided_by_label: true,
      voided_from_expected_load_id: true,
      expected_load_id: true,
      assigned_operator_id: true,
      total_units: true,
    },
  });
  if (!row) throw new Error(`load ${DUPLICATE_LOAD} not found`);
  console.log('=== BEFORE ===');
  console.log(JSON.stringify({ ...row, voided_at: row.voided_at?.toISOString() ?? null }, null, 2));

  if (row.voided_by === null && row.voided_by_label !== null) {
    console.log('\n=== ALREADY CORRECTED — nothing to do. ===');
    return;
  }

  for (const [k, want] of Object.entries(BEFORE)) {
    const got = (row as Record<string, unknown>)[k];
    if (got !== want) {
      throw new Error(
        `PRECONDITION FAILED on ${k}: expected ${String(want)}, found ${String(got)} — the row ` +
          'moved since the 0.BO after-state was written. NOTHING WRITTEN. Re-investigate.',
      );
    }
  }

  if (!apply) {
    console.log('\n=== DRY RUN — preconditions PASS, nothing written. Re-run with --apply. ===');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.inboundLoad.updateMany({
      where: { ...BEFORE },
      data: { voided_by: null, voided_by_label: NEW_LABEL },
    });
    if (count !== 1) {
      throw new Error(`guarded correction matched ${count} rows, expected 1 — rolled back`);
    }
    await writeAudit(
      {
        actor_label: ACTOR_LABEL,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: DUPLICATE_LOAD,
        before: { voided_by: JANETTE, voided_by_label: null },
        after: {
          voided_by: null,
          voided_by_label: NEW_LABEL,
          voided_on_behalf_of: JANETTE,
          reason: 'bo6_void_actor_attribution_correction',
          note: NOTE,
        },
      },
      { tx },
    );
  });

  const after = await prisma.inboundLoad.findUnique({
    where: { id: DUPLICATE_LOAD },
    select: { status: true, void_reason: true, voided_by: true, voided_by_label: true },
  });
  console.log('\n=== AFTER ===');
  console.log(JSON.stringify(after, null, 2));
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
