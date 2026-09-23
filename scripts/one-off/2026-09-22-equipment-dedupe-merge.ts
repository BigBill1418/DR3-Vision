// ADR-0135 Part B — one-off: condense the four HIGH-CONFIDENCE equipment
// duplicates found in the 2026-09-22 registry sweep.
//
// EXECUTED ONCE against production on 2026-09-22 (PDT). Retained because it IS
// the record of what ran — the pairs, the actor label, and the conservation
// figures it asserted — in the same shape as the ADR-0077 Terex merge
// (`2026-08-06-terex-canonical-merge.ts`), which this copies deliberately.
//
// WHY ONLY FOUR. The sweep found ~20 suspect groups. Only these four pass the
// ADR-0087 D2 rule "the key proposes, corroboration disposes": same site, and
// either an identical canonical name (Terex/terex) or an identical unit number
// PLUS invoice text naming that unit (`Unit #161053`, `Unit #32-48`), or the
// VIN-register verdict (G6, F9). Everything else — cross-site pairs, bare
// numbers, `48-68` vs `4868`, the work-order "assets" — is on Bill's decision
// list in ADR-0135 §6, not here. `-` and `#` are load-bearing in this fleet
// (ADR-0087 §1.3), so no pair here is a separator-only guess.
//
// WHY `mergeEquipment` AND NOT SQL. It is the same audited transaction the
// admin Merge button drives (ADR-0075): re-reads both rows inside the tx,
// refuses cross-site and chained merges, repoints `ap_equipment_links` and
// `ap_equipment_requests.resolved_equipment_id`, stamps the loser
// (`is_active=false`, `merged_into_id`, `merged_at`) and writes the audit row
// in the same transaction. Each pair is its own transaction (the function owns
// its `$transaction`); a failure mid-run leaves every completed pair whole and
// every later pair untouched.
//
// KNOWN GAP IT DOES NOT COVER — asserted, not assumed. `mergeEquipment` does
// NOT repoint `equipment_daily_throughput` or `equipment_throughput_gap_alerts`
// (both FK → equipment, added by ADR-0079/0088 after ADR-0075 was written).
// This script hard-stops if any loser carries a row in either table. All four
// carry zero as of the sweep.
//
// REVERSIBLE: `merged_into_id` is the mapping (loser → survivor), and each
// merge's audit row stores the loser's full `before` image plus the repoint
// counts. The pre-run dump is on svdp-dev at
// ~/backups-adhoc/dr3-equipment-dedupe-pre-20260922-232239-PT.dump
// (sha256 667caa00…9221, restore-tested).
//
// RUN (workstation → SSH tunnel to prod Postgres; the image ships no TS runtime):
//   ssh -f -N -L 15432:172.23.0.2:5432 bbarnard065@10.99.0.2
//   DATABASE_URL='postgresql://dr3:…@127.0.0.1:15432/dr3_vision?schema=public' \
//     npx tsx scripts/one-off/2026-09-22-equipment-dedupe-merge.ts [--apply]
// Without `--apply` it is a read-only dry run.

import { mergeEquipment, type SystemActorContext } from '../../src/lib/admin-equipment';
import { prisma } from '../../src/lib/prisma';

interface Pair {
  winner: string;
  loser: string;
  /** Human label, for the log and the ADR table. */
  label: string;
  /** Links the loser carries at plan time — a drift check, not a wish. */
  expectLoserLinks: number;
}

export const PAIRS: readonly Pair[] = [
  {
    // Woodland. Canonical-identical to the ADR-0077 survivor; minted 2026-08-20
    // by a resolve that ignored the advisory similar-name warning.
    winner: '7e35a4aa-d022-4e65-b64f-580c74f21cf1', // 'Terex'
    loser: '1323e8f6', // 'terex'
    label: "woodland 'terex' → 'Terex'",
    expectLoserLinks: 1,
  },
  {
    // Woodland. Same unit; the loser's only invoice subject reads
    // "Invoice: 6646 | … | Unit #161053" and the same invoice is ALSO linked to
    // the survivor via a second ap_request (see ADR-0135 §6 side finding).
    winner: '994a2d76', // '161053 — Freightliner Semi Truck (Day Cab S/A)'
    loser: '89ea5644', // '161053.'
    label: "woodland '161053.' → '161053 — Freightliner Semi Truck (Day Cab S/A)'",
    expectLoserLinks: 1,
  },
  {
    // Eugene. Same unit including the load-bearing dash; invoice reads
    // "Unit #32-48", same vendor (United Fleet Maintenance) as the survivor's.
    winner: '48ef6ffc', // '32-48 — Trailer 48 Ft Swing Door Trailer'
    loser: 'cfd92a89', // 'trailer 32-48'
    label: "eugene 'trailer 32-48' → '32-48 — Trailer 48 Ft Swing Door Trailer'",
    expectLoserLinks: 1,
  },
  {
    // Eugene. ADR-0087 register G6: one Hyster forklift double-entered in VLM
    // (f9 shell + F-9 full record, same location); the register's own DR3 action
    // is exactly this merge. Zero references either side of the loser.
    winner: '4c6f6d1a', // 'F9 — Hyster Forklift'
    loser: '23ebbb4f', // 'F9'
    label: "eugene 'F9' → 'F9 — Hyster Forklift'",
    expectLoserLinks: 0,
  },
];

const ACTOR: SystemActorContext = {
  actorLabel:
    "system:equipment-dedupe-merge (ADR-0135, executed by Claude Code at Bill's instruction 2026-09-22: 'clean and condense the items')",
  ip: null,
  userAgent: null,
};

function fail(message: string): never {
  console.error(`\nHARD STOP — ${message}`);
  process.exit(1);
}

/** Resolve an 8-char prefix to the one full id it names — refuse ambiguity. */
async function fullId(prefix: string): Promise<string> {
  if (prefix.length === 36) return prefix;
  const rows = await prisma.equipment.findMany({
    where: { id: { startsWith: prefix } },
    select: { id: true },
  });
  if (rows.length !== 1) fail(`id prefix ${prefix} matched ${rows.length} rows`);
  return rows[0]!.id;
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

  const plan = [];
  for (const p of PAIRS) {
    const winner = await fullId(p.winner);
    const loser = await fullId(p.loser);
    const [w, l, links, thr, gaps] = await Promise.all([
      prisma.equipment.findUnique({ where: { id: winner } }),
      prisma.equipment.findUnique({ where: { id: loser } }),
      prisma.apEquipmentLink.count({ where: { equipment_id: loser } }),
      prisma.equipmentDailyThroughput.count({ where: { equipment_id: loser } }),
      prisma.equipmentThroughputGapAlert.count({ where: { equipment_id: loser } }),
    ]);
    if (!w || !l) fail(`${p.label}: row missing`);
    if (w.site_id !== l.site_id) fail(`${p.label}: cross-site — not a plan-time fact`);
    if (w.merged_into_id || l.merged_into_id) fail(`${p.label}: already merged`);
    if (links !== p.expectLoserLinks)
      fail(`${p.label}: loser links ${links} ≠ planned ${p.expectLoserLinks} — re-plan`);
    if (thr || gaps)
      fail(`${p.label}: loser has throughput(${thr})/gap(${gaps}) rows mergeEquipment won't move`);
    console.log(`plan: ${p.label}  [${w.display_name} ← ${l.display_name}] loserLinks=${links}`);
    plan.push({ ...p, winner, loser });
  }

  const ids = plan.flatMap((p) => [p.winner, p.loser]);
  const before = await measure(ids);
  console.log(`baseline: links=${before.links} spend=${before.spendCents} cents`);

  if (!apply) {
    console.log('dry run — no writes. Re-run with --apply.');
    return;
  }

  for (const p of plan) {
    const r = await mergeEquipment(p.winner, p.loser, ACTOR);
    if (!r.ok) fail(`${p.label}: merge refused (${r.reason})`);
    console.log(
      `merged ${p.label}: repointedLinks=${r.repointedLinks} repointedRequests=${r.repointedRequests}`,
    );
  }

  const after = await measure(ids);
  console.log(`after: links=${after.links} spend=${after.spendCents} cents`);
  if (after.links !== before.links || after.spendCents !== before.spendCents)
    fail('ATTRIBUTION NOT CONSERVED');
  const stranded = await prisma.apEquipmentLink.count({
    where: { equipment_id: { in: plan.map((p) => p.loser) } },
  });
  if (stranded !== 0) fail(`${stranded} links still point at a merged-away row`);
  console.log('conserved: link count and spend unchanged; no link left on a loser');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
