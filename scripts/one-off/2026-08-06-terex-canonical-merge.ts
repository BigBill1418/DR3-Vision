// ADR-0077 Phase 1 — one-off: collapse the three Woodland Terex rows into one.
//
// EXECUTED ONCE against production on 2026-08-06. Retained in the repo because
// it IS the record of what ran: which service functions, in which order, under
// which actor label, with the conservation figures it asserted. A prose
// changelog entry cannot be re-read by a future session the way this can.
//
// WHY A SCRIPT AND NOT A CLICK. OPEN-ITEMS O-10 filed this as an operator
// action (Bill, via `/admin/equipment` → Merge into…). Bill instead ordered it
// executed in writing (handoff PR #197, 2026-08-06). `requireAdmin()` is the
// HTTP-layer gate on that button; his written order is the authorisation. So
// this drives the SAME audited transaction the admin API drives —
// `mergeEquipment` / `updateEquipment` from `src/lib/admin-equipment.ts`,
// ADR-0075 — rather than hand-rolling repoint SQL that would bypass the
// cross-site guard, the merged-chain guard and the in-transaction audit write.
//
// WHO IT SAYS DID IT. A `SystemActorContext` (ADR-0077 / mirroring ADR-0036's
// `SystemActor`), never a borrowed `users.id`. The audit rows read
// `actor_label = 'system:terex-canonical-merge (ADR-0077, executed by Claude
// Code at Bill's written instruction, PR #197)'` and `actor_user_id = NULL`.
// Stamping Bill's id would write a false claim into an append-only table.
//
// RUN (from a workstation, through an SSH tunnel to the prod Postgres; the
// container image ships no TS runtime):
//   ssh -f -N -L 15432:172.23.0.2:5432 10.99.0.2
//   DATABASE_URL='postgresql://dr3:…@127.0.0.1:15432/dr3_vision?schema=public' \
//     npx tsx scripts/one-off/2026-08-06-terex-canonical-merge.ts --apply
//
// Without `--apply` it is a read-only dry run: baseline + plan, no writes.

import {
  mergeEquipment,
  updateEquipment,
  type SystemActorContext,
} from '../../src/lib/admin-equipment';
import { prisma } from '../../src/lib/prisma';

/**
 * Canonical survivor: `Terex` (ADR-0077 D1).
 *
 * Supersedes O-10's stated direction (…INTO `bee54def`). A merged-away row
 * KEEPS its `display_name` — `mergeEquipment` repoints attribution and stamps
 * the loser, it never renames anything — so merging into `bee54def` would have
 * left the surviving record permanently called `Terex Machine`, with the wanted
 * name `Terex` frozen on a dead row that `(site_id, display_name)` uniqueness
 * then blocks anyone from reusing. `7e35a4aa` also already carries 2 of the 4
 * invoice links and 2 of the 4 resolved requests, including the most recent
 * human resolution (`Terex 815`), so it is the row the fewest facts move away
 * from.
 */
const WINNER = '7e35a4aa-d022-4e65-b64f-580c74f21cf1';
const LOSERS = [
  'bee54def-cf7c-4d80-8a56-f948b87328b4', // 'Terex Machine'
  '1125fb30-c493-4e2c-aaa3-da96d3a427a6', // 'Terex machine'
] as const;

/** Read at 2026-08-06 before any write. Conservation target, not a wish. */
const EXPECTED_BASELINE = { links: 4, spendCents: 202492 } as const;

const ACTOR: SystemActorContext = {
  actorLabel:
    "system:terex-canonical-merge (ADR-0077, executed by Claude Code at Bill's written instruction, PR #197)",
  ip: null,
  userAgent: null,
};

/**
 * Every Terex-tagged invoice and what it is worth, by NAME rather than by id —
 * so it keeps measuring the same real-world set after the ids are collapsed.
 *
 * `COALESCE(confirmed_amount_cents, amount_cents)`: all four of these rows carry
 * their money in `confirmed_amount_cents` with `amount_cents` NULL, so summing
 * the wrong column alone reads 0 and would "prove" conservation of nothing.
 */
async function measure(): Promise<{ links: number; spendCents: number }> {
  const rows = await prisma.$queryRaw<{ links: bigint; spend: bigint | null }[]>`
    SELECT count(*) AS links,
           sum(COALESCE(r.confirmed_amount_cents, r.amount_cents)) AS spend
      FROM ap_equipment_links l
      JOIN equipment e ON e.id = l.equipment_id
      JOIN ap_requests r ON r.id = l.request_id
     WHERE e.display_name ILIKE '%terex%'
  `;
  const row = rows[0];
  if (!row) throw new Error('baseline query returned no row');
  return { links: Number(row.links), spendCents: Number(row.spend ?? 0n) };
}

function fail(message: string): never {
  console.error(`\nHARD STOP — ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const baseline = await measure();
  console.log(`baseline: links=${baseline.links} spend=${baseline.spendCents} cents`);
  if (
    baseline.links !== EXPECTED_BASELINE.links ||
    baseline.spendCents !== EXPECTED_BASELINE.spendCents
  ) {
    fail(
      `baseline moved since the plan was written (expected ${EXPECTED_BASELINE.links}/` +
        `${EXPECTED_BASELINE.spendCents}). A fifth invoice may have landed — re-enumerate ` +
        `and recompute the conservation target before merging.`,
    );
  }

  if (!apply) {
    console.log(`dry run — would merge ${LOSERS.join(', ')} INTO ${WINNER}, then category→terex`);
    return;
  }

  for (const loser of LOSERS) {
    const result = await mergeEquipment(WINNER, loser, ACTOR);
    if (!result.ok) fail(`merge ${loser} → ${WINNER} refused: ${result.reason}`);
    console.log(
      `merged ${loser} → ${WINNER}: repointedLinks=${result.repointedLinks} ` +
        `repointedRequests=${result.repointedRequests}`,
    );
  }

  const categorised = await updateEquipment(WINNER, { category: 'terex' }, ACTOR);
  if (!categorised.ok) fail(`category correction refused: ${categorised.reason}`);
  console.log(`category: ${categorised.equipment.category}`);

  const after = await measure();
  console.log(`after: links=${after.links} spend=${after.spendCents} cents`);
  if (after.links !== baseline.links || after.spendCents !== baseline.spendCents) {
    fail('SPEND NOT CONSERVED — a merge created or destroyed invoice attribution');
  }
  console.log('conserved: link count and spend total unchanged by the merge');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
