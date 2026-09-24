// ADR-0135 BX-11 item 4 — one-off: record two pairs on `/admin/equipment/duplicates`
// as "Different assets", through the app's own path (`markEquipmentDistinct`:
// `equipment_distinct_pairs` row + audit row, one transaction), system actor.
//
// EXECUTED ONCE against production on 2026-09-23 (PDT). Retained as the record of
// what ran and why.
//
// THE TWO PAIRS AND THEIR EVIDENCE
//   `Truck 9 — GMC Box Truck` / `Truck 9 — Chevrolet Truck` (Eugene) — ADR-0087 §1.3:
//     "`Truck 9` and `Truck #9` are two different trucks (GMC box truck vs VIN'd
//     Chevy C2500)"; decision register G7 (docs/plans/2026-08-08-vlm-equipment-
//     decision-register.md). VLM: `Truck #9` 1993 Chevrolet C2500 Dually, VIN
//     1GCGC24K7PE160239, plate 712HQC; `Truck 9` 1995 GMC box truck, plate CN01174.
//   `3 — Fruehauf 28 Ft Swing Door Trailer` / `3 — Wabash 28 Ft Roll Up Door Trailer`
//     (Eugene) — NOT in ADR-0087: its Wabash/Fruehauf pair is unit `95` (register
//     G3). ADR-0135 §8 attributed this pair to ADR-0087 by mistake. The evidence is
//     the VLM register itself (vlm-replica-db, svdp_rescue.equipment, read
//     2026-09-23): unit `3` = Wabash 28 Ft Roll Up, VIN 1JJV281N9PL180863, plate
//     HU21483; unit `03` = 1984 Fruehauf 28 Ft Swing Door, VIN 1H4V02812EJ023049,
//     plate HU89823 — two VINs, two plates, both Active. ADR-0087's own rule: "a
//     corroborating identifier DISPOSES".
//
// LEFT FOR BILL: `2 — Great Dane` / `2 — Trailmobile` and `908` / `Truck 908`.
//
// SAFETY GATES (hard stop before any write): both pairs are in the live queue with
// the expected names; after the writes the queue holds exactly the two pairs left
// for Bill.
//
// RUN (workstation → SSH tunnel to prod Postgres; the image ships no TS runtime):
//   ssh -f -N -L 15432:172.23.0.2:5432 bbarnard065@10.99.0.2
//   DATABASE_URL='postgresql://dr3:…@127.0.0.1:15432/dr3_vision?schema=public' \
//     npx tsx scripts/one-off/2026-09-23-mark-distinct-equipment-pairs.ts [--apply]
// Without `--apply` it is a read-only dry run.
//
// BACKUP: svdp-dev:~/backups-adhoc/ (see ADR-0135 §8 "BX-11 item 4" for the file).

import {
  listPossibleDuplicates,
  markEquipmentDistinct,
  type SystemActorContext,
} from '../../src/lib/admin-equipment';
import { prisma } from '../../src/lib/prisma';

const ACTOR: SystemActorContext = {
  actorLabel:
    "system:mark-distinct-equipment-pairs (ADR-0135 BX-11 item 4, executed by Claude Code at Bill's direction 2026-09-23)",
  ip: null,
  userAgent: null,
};

interface Verdict {
  names: [string, string];
  reason: string;
}

const VERDICTS: readonly Verdict[] = [
  {
    names: ['Truck 9 — GMC Box Truck', 'Truck 9 — Chevrolet Truck'],
    reason:
      'ADR-0087 §1.3 + decision register G7: `Truck 9` and `Truck #9` are two different trucks — 1995 GMC box truck (plate CN01174) vs 1993 Chevrolet C2500 dually (VIN 1GCGC24K7PE160239, plate 712HQC).',
  },
  {
    names: ['3 — Fruehauf 28 Ft Swing Door Trailer', '3 — Wabash 28 Ft Roll Up Door Trailer'],
    reason:
      'VLM register (read 2026-09-23): unit 3 = Wabash 28 Ft Roll Up, VIN 1JJV281N9PL180863, plate HU21483; unit 03 = 1984 Fruehauf 28 Ft Swing Door, VIN 1H4V02812EJ023049, plate HU89823. Two VINs, two plates, both Active.',
  },
];

const LEFT_FOR_BILL = [
  ['2 — Great Dane 28 Ft Swing Door Trailer', '2 — Trailmobile 48 Ft Roll Up Door Trailer'],
  ['908', 'Truck 908 — Volvo Semi Truck (Day Cab)'],
] as const;

const key = (a: string, b: string): string => [a, b].sort().join(' | ');

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const before = await listPossibleDuplicates();
  console.log(`queue before: ${before.length} pair(s)`);
  for (const p of before) console.log(`  ${key(p.a.displayName, p.b.displayName)}`);

  const targets = VERDICTS.map((v) => {
    const pair = before.find((p) => key(p.a.displayName, p.b.displayName) === key(...v.names));
    if (!pair) throw new Error(`STOP: pair not in the live queue: ${key(...v.names)}`);
    return { ...v, aId: pair.a.id, bId: pair.b.id };
  });

  if (!apply) {
    console.log('dry run — would mark:');
    for (const t of targets) console.log(`  ${key(...t.names)} (${t.aId}, ${t.bId})`);
    return;
  }

  for (const t of targets) {
    const r = await markEquipmentDistinct(t.aId, t.bId, t.reason, ACTOR);
    if (!r.ok) throw new Error(`STOP: ${key(...t.names)} refused: ${r.reason}`);
    console.log(`marked: ${key(...t.names)}`);
  }

  const after = await listPossibleDuplicates();
  const got = after.map((p) => key(p.a.displayName, p.b.displayName)).sort();
  const want = LEFT_FOR_BILL.map(([a, b]) => key(a, b)).sort();
  console.log(`queue after: ${after.length} pair(s)`);
  for (const k of got) console.log(`  ${k}`);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`STOP: queue after is not exactly the two pairs left for Bill`);
  }
  console.log('PASS: queue holds exactly the two pairs left for Bill');
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
