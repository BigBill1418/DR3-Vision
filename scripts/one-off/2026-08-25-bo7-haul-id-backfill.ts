// OPEN-ITEMS §0.BO / BO-7 — no dock-captured load is reconcilable.
//
// ADR-0128. The forward fix ships in `startInboundLoad`: a load minted from a
// queue tap now copies its slot's `external_mymrc_haul_id`. This script is the
// other half — the loads that were already captured before that shipped.
//
// ── The defect ─────────────────────────────────────────────────────────────
//
// `inbound_loads.external_mymrc_haul_id` was written by exactly two things: the
// MyMRC inbound bridge and the EOD add-line. Neither touches a dock capture, so
// the column was NULL on ALL 774 production loads (measured 2026-08-25).
//
// The monthly MyMRC reconciliation upload matches DR3 loads to external haul
// rows ON THAT COLUMN (`src/lib/reconciliation.ts`, `categorizeRows`). So every
// truck the floor has ever counted came out of a reconciliation as
// `missing_in_dr3` — "MyMRC has this haul and we do not" — against a load
// sitting in the same table with the same units. The reconciliation was not
// wrong about anything it could see; it could not see any of them.
//
// ── What is derivable, and what is not ─────────────────────────────────────
//
// Only a load with a live `expected_load_id`. `expected_loads.external_mymrc_haul_id`
// is NOT NULL and UNIQUE, and `inbound_loads.expected_load_id` is UNIQUE, so the
// mapping is 1:1 by construction — there is nothing to choose between and
// nothing to guess. Measured on production 2026-08-25: 133 such loads (130
// `submitted`, 3 `rejected`, all Woodland), and ZERO of them would collide with
// an existing value.
//
// The other 641 loads are aggregates and paper rows that never had a slot. They
// are NOT touched and NOT synthesised: a haul number invented for an aggregate
// would be indistinguishable from a real one, and would make the reconciliation
// match a row that does not correspond to a truck. An unreconcilable aggregate
// is honest; a wrongly-reconciled one is not.
//
// VOIDED loads are excluded by the same predicate, and deliberately: `voidLoad`
// severs `expected_load_id` (ADR-0090 C) and, as of ADR-0128, the haul number
// with it. A void asserts the load was never a truck, so it must not appear in a
// reconciliation at all.
//
// ── The guard ──────────────────────────────────────────────────────────────
//
// Every write is an `updateMany` whose WHERE re-asserts `external_mymrc_haul_id:
// null` and the exact parent link the value was derived from (ADR-0118 D1 — the
// condition rides the statement, not a read taken before it). A row that gained
// a haul number, or was re-pointed, between the scan and the write matches zero
// and is reported rather than overwritten. Nothing is written on a stale premise.
//
// Each write carries its own append-only audit row (CLAUDE.md hard rule #6),
// under a label rather than a borrowed `users.id` — the repo's own one-off
// convention, and the same one ADR-0128 gives the void path.
//
// RUN: npx tsx scripts/one-off/2026-08-25-bo7-haul-id-backfill.ts [--apply]
// (DATABASE_URL exported to the production DB; dry run without --apply.)

import { prisma } from '../../src/lib/prisma';
import { writeAudit } from '../../src/lib/audit';

const ACTOR_LABEL =
  'system:bo7-haul-id-backfill (OPEN-ITEMS 0.BO / BO-7, ADR-0128, executed by Claude Code ' +
  '2026-08-25)';

const NOTE =
  'Backfilled inbound_loads.external_mymrc_haul_id from the load’s own expected_loads parent. ' +
  'The column was NULL on every dock-captured load because only the MyMRC bridge and the EOD ' +
  'add-line ever wrote it, and the monthly reconciliation upload matches on it — so no ' +
  'dock-captured load was reconcilable. Derived 1:1 from a UNIQUE, NOT NULL parent column; ' +
  'nothing is synthesised and no load without a parent slot is touched. Forward fix in ' +
  'startInboundLoad (ADR-0128).';

interface Candidate {
  id: string;
  expectedLoadId: string;
  haulId: string;
  status: string;
  siteCode: string;
}

async function scan(): Promise<{ candidates: Candidate[]; collisions: Candidate[] }> {
  const rows = await prisma.inboundLoad.findMany({
    where: { external_mymrc_haul_id: null, expected_load_id: { not: null } },
    select: {
      id: true,
      status: true,
      expected_load_id: true,
      site: { select: { code: true } },
      expected_load: { select: { external_mymrc_haul_id: true } },
    },
    orderBy: { arrived_at: 'asc' },
  });

  const candidates: Candidate[] = [];
  for (const r of rows) {
    // Both are non-null by the query's own predicate and by the schema, but the
    // types are nullable — narrowed rather than asserted, so a schema change
    // that made either optional would show up here as a skipped row instead of
    // as a crash mid-write.
    if (!r.expected_load_id || !r.expected_load) continue;
    candidates.push({
      id: r.id,
      expectedLoadId: r.expected_load_id,
      haulId: r.expected_load.external_mymrc_haul_id,
      status: r.status,
      siteCode: r.site.code,
    });
  }

  // `inbound_loads.external_mymrc_haul_id` is UNIQUE. A candidate whose number is
  // already held by ANOTHER load cannot be written and must be reported, not
  // silently dropped and not allowed to blow up the run halfway through.
  const taken = new Set(
    (
      await prisma.inboundLoad.findMany({
        where: { external_mymrc_haul_id: { in: candidates.map((c) => c.haulId) } },
        select: { external_mymrc_haul_id: true },
      })
    )
      .map((r) => r.external_mymrc_haul_id)
      .filter((v): v is string => v !== null),
  );

  return {
    candidates: candidates.filter((c) => !taken.has(c.haulId)),
    collisions: candidates.filter((c) => taken.has(c.haulId)),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const total = await prisma.inboundLoad.count();
  const alreadySet = await prisma.inboundLoad.count({
    where: { external_mymrc_haul_id: { not: null } },
  });
  const { candidates, collisions } = await scan();

  console.log('=== BO-7 haul-id backfill ===');
  console.log(`inbound_loads total          : ${total}`);
  console.log(`  already carry a haul id    : ${alreadySet}`);
  console.log(`  derivable from a parent    : ${candidates.length}`);
  console.log(`  BLOCKED by a UNIQUE clash  : ${collisions.length}`);
  console.log(
    `  no parent slot (untouched) : ${total - alreadySet - candidates.length - collisions.length}`,
  );

  const bySite = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const c of candidates) {
    bySite.set(c.siteCode, (bySite.get(c.siteCode) ?? 0) + 1);
    byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  }
  console.log(`  by site                    : ${JSON.stringify(Object.fromEntries(bySite))}`);
  console.log(`  by status                  : ${JSON.stringify(Object.fromEntries(byStatus))}`);
  for (const c of collisions) {
    console.log(`  ! COLLISION ${c.id} -> ${c.haulId} (already held by another load)`);
  }
  console.log(
    `  first 5                    : ${candidates
      .slice(0, 5)
      .map((c) => c.haulId)
      .join(', ')}`,
  );

  if (!apply) {
    console.log('\n=== DRY RUN — nothing written. Re-run with --apply. ===');
    return;
  }

  let written = 0;
  const refused: string[] = [];
  for (const c of candidates) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.inboundLoad.updateMany({
        // The premise rides the statement: still unstamped, still pointed at the
        // slot the value came from.
        where: {
          id: c.id,
          external_mymrc_haul_id: null,
          expected_load_id: c.expectedLoadId,
        },
        data: { external_mymrc_haul_id: c.haulId },
      });
      if (count !== 1) {
        refused.push(`${c.id} (matched ${count})`);
        return;
      }
      await writeAudit(
        {
          actor_label: ACTOR_LABEL,
          action: 'update',
          table_name: 'inbound_loads',
          row_id: c.id,
          before: { external_mymrc_haul_id: null },
          after: {
            external_mymrc_haul_id: c.haulId,
            derived_from_expected_load_id: c.expectedLoadId,
            reason: 'bo7_reconciliation_key_backfill',
            note: NOTE,
          },
        },
        { tx },
      );
      written += 1;
    });
  }

  console.log(`\n[applied] wrote ${written} of ${candidates.length}`);
  for (const r of refused) console.log(`  ! REFUSED (row moved, nothing written): ${r}`);

  const after = await prisma.inboundLoad.count({
    where: { external_mymrc_haul_id: { not: null } },
  });
  const stillNull = await prisma.inboundLoad.count({
    where: { external_mymrc_haul_id: null, expected_load_id: { not: null } },
  });
  console.log(`\n=== AFTER ===`);
  console.log(`loads carrying a haul id     : ${alreadySet} -> ${after}`);
  console.log(`still derivable but unstamped: ${stillNull}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
