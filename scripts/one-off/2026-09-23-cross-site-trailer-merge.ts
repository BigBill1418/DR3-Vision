// ADR-0135 §6.1–6.3 / OPEN-ITEMS BX-2 — one-off: collapse the three trailers that
// were seeded at one yard and re-created at the other into ONE FLEET-WIDE record
// each (Bill, 2026-09-23: trailers move between yards — no home site).
//
// Retained as the record of what ran: the pairs, the actor label, the
// conservation it asserted. Same shape as `2026-09-22-equipment-dedupe-merge.ts`.
//
// SURVIVOR = the SEEDED row (it carries the seed's `<unit> — <make> <type>` name
// and the ADR-0135 unit-number backfill); LOSER = the row a resolver re-created by
// hand in August. `survivorSiteId: null` makes the survivor fleet-wide. The merge
// is `mergeEquipment` — the same audited transaction the admin Merge button
// drives — which since ADR-0135 repoints EVERY FK into `equipment` (links,
// resolved requests, daily throughput, gap alerts, merged children). Each pair is
// its own transaction.
//
// Evidence per pair: identical six-digit unit number on both rows (the matcher's
// "same_unit, long" tier — a six-digit trailer number is not a coincidence), and
// each loser's single invoice names that unit. Bill's decision (2026-09-23)
// settles the only open question the ADR left — which yard — with "neither".
//
// RUN (workstation → SSH tunnel to prod Postgres; the image ships no TS runtime):
//   ssh -f -N -L 15432:<postgres container ip>:5432 bbarnard065@10.99.0.2
//   DATABASE_URL='postgresql://dr3:…@127.0.0.1:15432/dr3_vision?schema=public' \
//     npx tsx scripts/one-off/2026-09-23-cross-site-trailer-merge.ts [--apply]
// Without `--apply` it is a read-only dry run. Requires the ADR-0135 migration
// (`20260862_adr0135_equipment_identity`) to be applied first.

import { mergeEquipment, type SystemActorContext } from '../../src/lib/admin-equipment';
import { prisma } from '../../src/lib/prisma';

interface Pair {
  winner: string;
  loser: string;
  label: string;
  /** Links the loser carries at plan time — a drift check, not a wish. */
  expectLoserLinks: number;
}

export const PAIRS: readonly Pair[] = [
  {
    winner: '3324cbce-6003-4397-a116-2f521e3d0d32', // Woodland '281577 — Great Dane'
    loser: 'bf828ad0-60a7-4085-9681-4e80f6c1f05e', // Eugene 'Trailer 281577'
    label: "281577: Eugene 'Trailer 281577' → '281577 — Great Dane' (fleet-wide)",
    expectLoserLinks: 1,
  },
  {
    winner: 'da85e182-1079-4b97-bebd-88b52229d5c9', // Woodland '282876 — Strick 28 Ft …'
    loser: '2588490b-0704-4c6e-abdb-edc8c5c4fe7e', // Eugene 'Trailer 282876'
    label:
      "282876: Eugene 'Trailer 282876' → '282876 — Strick 28 Ft Roll Up Door Trailer' (fleet-wide)",
    expectLoserLinks: 1,
  },
  {
    winner: '1ed0f856-8425-41a8-9a94-80957021aa40', // Eugene '284460 — Great Dane 28 Ft …'
    loser: 'fdef4b7a-678a-4a87-acf7-b680a84fbc1c', // Woodland 'Trailer #284460'
    label:
      "284460: Woodland 'Trailer #284460' → '284460 — Great Dane 28 Ft Roll Up Door Trailer' (fleet-wide)",
    expectLoserLinks: 1,
  },
];

const ACTOR: SystemActorContext = {
  actorLabel:
    "system:cross-site-trailer-merge (ADR-0135 §6/BX-2, executed by Claude Code at Bill's instruction 2026-09-23: trailers move between yards — merge into one fleet-wide record)",
  ip: null,
  userAgent: null,
};

function fail(message: string): never {
  console.error(`\nHARD STOP — ${message}`);
  process.exit(1);
}

/** Link count + spend over every id in the plan. Merging must conserve both. */
async function measure(ids: string[]): Promise<{ links: number; spendCents: number }> {
  const rows = await prisma.$queryRaw<{ links: bigint; spend: bigint | null }[]>`
    SELECT count(*) AS links,
           sum(COALESCE(r.confirmed_amount_cents, r.amount_cents)) AS spend
      FROM ap_equipment_links l
      JOIN ap_requests r ON r.id = l.request_id
     WHERE l.equipment_id = ANY(${ids})
  `;
  const row = rows[0];
  if (!row) fail('measure query returned no row');
  return { links: Number(row.links), spendCents: Number(row.spend ?? 0n) };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  for (const p of PAIRS) {
    const [w, l, links] = await Promise.all([
      prisma.equipment.findUnique({ where: { id: p.winner } }),
      prisma.equipment.findUnique({ where: { id: p.loser } }),
      prisma.apEquipmentLink.count({ where: { equipment_id: p.loser } }),
    ]);
    if (!w || !l) fail(`${p.label}: row missing`);
    if (w.merged_into_id || l.merged_into_id) fail(`${p.label}: already merged`);
    if (w.site_id === l.site_id) fail(`${p.label}: expected a CROSS-site pair`);
    if (links !== p.expectLoserLinks)
      fail(`${p.label}: loser links ${links} ≠ planned ${p.expectLoserLinks} — re-plan`);
    console.log(`plan: ${p.label}  [${w.display_name} ← ${l.display_name}] loserLinks=${links}`);
  }

  const ids = PAIRS.flatMap((p) => [p.winner, p.loser]);
  const before = await measure(ids);
  console.log(`baseline: links=${before.links} spend=${before.spendCents} cents`);

  if (!apply) {
    console.log('dry run — no writes. Re-run with --apply.');
    return;
  }

  for (const p of PAIRS) {
    const r = await mergeEquipment(p.winner, p.loser, ACTOR, { survivorSiteId: null });
    if (!r.ok) fail(`${p.label}: merge refused (${r.reason})`);
    console.log(
      `merged ${p.label}: ${JSON.stringify(r.repointed)} survivor site=${r.winner.site_id}`,
    );
  }

  const after = await measure(ids);
  console.log(`after: links=${after.links} spend=${after.spendCents} cents`);
  if (after.links !== before.links || after.spendCents !== before.spendCents)
    fail('ATTRIBUTION NOT CONSERVED');
  const losers = PAIRS.map((p) => p.loser);
  const [stranded, strandedReqs, survivors] = await Promise.all([
    prisma.apEquipmentLink.count({ where: { equipment_id: { in: losers } } }),
    prisma.apEquipmentRequest.count({ where: { resolved_equipment_id: { in: losers } } }),
    prisma.equipment.count({
      where: { id: { in: PAIRS.map((p) => p.winner) }, site_id: null, is_active: true },
    }),
  ]);
  if (stranded !== 0 || strandedReqs !== 0)
    fail(`${stranded} links / ${strandedReqs} requests still point at a merged-away row`);
  if (survivors !== PAIRS.length)
    fail(`only ${survivors}/${PAIRS.length} survivors are fleet-wide`);
  console.log(
    'conserved: link count and spend unchanged; nothing left on a loser; 3 fleet-wide survivors',
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
