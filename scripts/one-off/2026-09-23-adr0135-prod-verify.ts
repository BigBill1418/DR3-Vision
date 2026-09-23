// ADR-0135 — post-deploy verification against PRODUCTION, through the same
// server functions the pages and routes call. Nobody can sign in as a user from
// here, so this drives the data layer directly:
//
//   1. search-first — `searchEquipment` (what GET /api/admin/equipment/similar
//      calls) returns the EXISTING asset for `161053.`, `Trailer # 19`,
//      `trailer 32-48`, and nothing dash-confused for `48-68`.
//   2. the hard gate — `createEquipment` (what POST /api/admin/equipment and the
//      resolve route's `createEquipmentInTx` run) REFUSES `161053.` with the
//      Freightliner row attached. Refusal = no write, so this is read-only.
//   3. the override — `createEquipmentInTx` with `confirm_distinct`, inside a
//      transaction this script ROLLS BACK: proves the insert, the audit row's
//      `duplicate_override` and the `equipment_distinct_pairs` row all land
//      against the real schema/constraints, then leaves nothing behind.
//   4. the merge repoint — `mergeEquipmentInTx` over two throwaway rows with a
//      daily-throughput row and a gap-alert row on the loser, inside a rolled-back
//      transaction: proves both are repointed on the real schema.
//
// Every write happens inside a transaction that is rolled back; the script then
// re-reads to prove nothing persisted. Nothing committed = nothing for the
// append-only audit rule to protect.
//
// RUN: same tunnel as the merge one-offs —
//   DATABASE_URL='postgresql://…@127.0.0.1:15432/dr3_vision?schema=public' \
//     npx tsx scripts/one-off/2026-09-23-adr0135-prod-verify.ts

import {
  createEquipment,
  createEquipmentInTx,
  mergeEquipmentInTx,
  searchEquipment,
  type SystemActorContext,
} from '../../src/lib/admin-equipment';
import { prisma } from '../../src/lib/prisma';

const ACTOR: SystemActorContext = {
  actorLabel: 'system:adr0135-prod-verify (rolled back)',
  ip: null,
  userAgent: null,
};
const ROLLBACK = new Error('ROLLBACK (verification — intentional)');
const TAG = 'ADR0135-VERIFY';

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${JSON.stringify(detail)}` : ''}`);
}

async function rolledBack(
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

async function main(): Promise<void> {
  const woodland = await prisma.site.findFirstOrThrow({ where: { code: 'woodland' } });

  // ── 1. search-first ───────────────────────────────────────────────────────
  for (const [q, expectName] of [
    ['161053.', '161053 — Freightliner'],
    ['Trailer # 19', 'Trailer #19'],
    ['trailer 32-48', '32-48 — '],
  ] as const) {
    const hits = await searchEquipment({ text: q }, { includeWordMatches: true, limit: 5 });
    check(
      `search "${q}" → top hit starts "${expectName}"`,
      !!hits[0]?.displayName.startsWith(expectName),
      hits.slice(0, 3).map((h) => `${h.displayName} [${h.siteCode ?? 'fleet'}] ${h.reason}`),
    );
  }
  const dash = await searchEquipment({ text: '48-68' }, { includeWordMatches: false });
  check(
    'search "48-68" does NOT return 4868 — Fruehauf',
    !dash.some((h) => h.displayName.startsWith('4868 ')),
    dash.map((h) => h.displayName),
  );

  // ── 2. the hard gate (refusal = no write) ─────────────────────────────────
  const before = await prisma.equipment.count();
  const refused = await createEquipment(
    { site_id: woodland.id, asset_type: 'semi_truck', unit_number: '161053.' },
    { actorUserId: 'unused-refusal-writes-nothing', ip: null, userAgent: null },
  );
  check(
    'create "161053." is REFUSED as probable_duplicate with the Freightliner row',
    !refused.ok &&
      refused.reason === 'probable_duplicate' &&
      !!refused.existing?.some((e) => e.displayName.startsWith('161053 — Freightliner')),
    refused.ok
      ? 'CREATED?!'
      : { reason: refused.reason, existing: refused.existing?.map((e) => e.displayName) },
  );
  check('refusal wrote nothing', (await prisma.equipment.count()) === before);

  // ── 3. the override (rolled back) ─────────────────────────────────────────
  let overrideSeen = false;
  await rolledBack(async (tx) => {
    const dups = await searchEquipment({ text: '161053' }, { includeWordMatches: false }, tx);
    const made = await createEquipmentInTx(
      tx,
      {
        site_id: woodland.id,
        asset_type: 'semi_truck',
        unit_number: '161053',
        make: TAG,
        confirm_distinct: {
          reason: 'verification: a different truck with a colliding unit number',
          distinct_from_ids: dups.filter((d) => d.probableDuplicate).map((d) => d.id),
        },
      },
      ACTOR,
    );
    check(
      'override CREATES when every match is acknowledged with a reason',
      made.ok,
      made.ok ? made.row.display_name : made,
    );
    if (!made.ok) return;
    const audit = await tx.auditLog.findFirst({
      where: { table_name: 'equipment', row_id: made.row.id, action: 'insert' },
    });
    const after = audit?.after as {
      duplicate_override?: { reason?: string; distinct_from?: unknown[] };
    } | null;
    check(
      'override audit row carries reason + distinct_from + actor label',
      !!after?.duplicate_override?.reason &&
        (after.duplicate_override.distinct_from?.length ?? 0) > 0 &&
        audit?.actor_label === ACTOR.actorLabel,
      after?.duplicate_override,
    );
    const pairs = await tx.equipmentDistinctPair.count({
      where: { OR: [{ equipment_a_id: made.row.id }, { equipment_b_id: made.row.id }] },
    });
    check('override wrote equipment_distinct_pairs rows', pairs > 0, pairs);
    overrideSeen = true;
  });
  check(
    'override transaction rolled back — nothing persisted',
    overrideSeen && (await prisma.equipment.count({ where: { make: TAG } })) === 0,
  );

  // ── 4. merge repoints throughput + gap alerts (rolled back) ───────────────
  await rolledBack(async (tx) => {
    const a = await tx.equipment.create({
      data: { site_id: woodland.id, display_name: `${TAG} survivor`, category: 'other' },
    });
    const b = await tx.equipment.create({
      data: { site_id: null, display_name: `${TAG} loser`, category: 'other' },
    });
    await tx.equipmentDailyThroughput.create({
      data: {
        site_id: woodland.id,
        equipment_id: b.id,
        throughput_date: new Date('2099-01-01'),
        units_processed: 1,
        run_hours: 1,
      },
    });
    await tx.equipmentThroughputGapAlert.create({
      data: {
        site_id: woodland.id,
        gap_date: new Date('2099-01-02'),
        equipment_id: b.id,
        scanned_on: new Date('2099-01-03'),
        notify_mode: 'pilot',
        recipient_count: 0,
        delivered_count: 0,
      },
    });
    const r = await mergeEquipmentInTx(tx, a.id, b.id, ACTOR, { survivorSiteId: null });
    check('cross-site merge into fleet-wide succeeds', r.ok, r.ok ? r.repointed : r);
    if (!r.ok) return;
    check(
      'merge repointed 1 throughput + 1 gap-alert row',
      r.repointed.throughput === 1 && r.repointed.gapAlerts === 1,
      r.repointed,
    );
    const left = await tx.equipmentDailyThroughput.count({ where: { equipment_id: b.id } });
    check('no throughput row left on the loser', left === 0, left);
  });
  check(
    'merge transaction rolled back — nothing persisted',
    (await prisma.equipment.count({ where: { display_name: { startsWith: TAG } } })) === 0,
  );

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
