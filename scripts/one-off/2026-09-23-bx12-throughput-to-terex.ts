// BX-12 (ADR-0137) — one-off: move Woodland's throughput history that landed on
// `EQ24 — Shear Machine` back onto the `Terex`, where the readings belong.
//
// WHAT HAPPENED: the throughput form resolved the site machine as "the OLDEST
// `terex`-category row with an invoice link". EQ24 (seeded 2026-07-28) is older
// than the Terex (2026-07-30) and got its first invoice link 2026-09-02 6:21 AM
// PDT, so from then on every Woodland reading was saved on the shear. The hour
// meter proves they are the Terex's: the Terex's 09-01 row ends at 2,895.25 and
// the shear's 09-02 row starts at 2,895.25, continuing to 3,030.85 on 09-22.
//
// WHAT BILL DECIDED (2026-09-23 ~7:20 AM PDT):
//   - move every EQ24 throughput row + gap alert onto the Terex;
//   - 09-01 was entered on BOTH machines: keep the Terex's, drop the shear's
//     duplicate, and record its values (the full row goes into the audit row);
//   - one transaction, backup first.
//
// GAP-ALERT VERDICTS (computed below, not asserted by hand — see `verdict`):
//   an alert is an ARTEFACT of the split when the Terex HAD a live row for its
//   gap day at the moment the scan asked the shear. Otherwise it was a real gap
//   (nobody had entered that day on EITHER machine at scan time). The alerts have
//   no open/resolved state — `equipment_throughput_gap_alerts` is the idempotency
//   ledger of a nudge that was SENT — so the verdict is recorded on each row's
//   audit entry; nothing is re-sent and nothing is deleted.
//
// ACTOR: `audit_log.actor_label`, never a person's id (hard rule #6, the
// ADR-0077 system-actor convention).
//
// GATES (hard stop before any write): the Woodland designation already names the
// Terex (so the new code is live and no further reading can land on the shear);
// both rows live at Woodland; the shear holds no voided rows; the ONLY day both
// machines hold is 2026-09-01 and the two readings are identical; the shear's gap
// alerts are exactly the five expected days.
// POST-CONDITIONS (inside the transaction — a failure rolls everything back): the
// shear holds zero throughput and zero gap alerts; the table holds exactly one
// row fewer; the Terex's meter chain from 2026-08-25 on is continuous.
//
// RUN (workstation → SSH tunnel to prod Postgres; the image ships no TS runtime):
//   ssh -f -N -L 15432:<postgres container ip>:5432 bbarnard065@10.99.0.2
//   DATABASE_URL='postgresql://…@127.0.0.1:15432/…' \
//     npx tsx scripts/one-off/2026-09-23-bx12-throughput-to-terex.ts [--apply]
// Without `--apply` it runs the WHOLE transaction and rolls it back (a rehearsal).

import { Prisma } from '@prisma/client';
import { writeAudit } from '../../src/lib/audit';
import { prisma } from '../../src/lib/prisma';

const ACTOR_LABEL =
  "system:bx12-throughput-to-terex (ADR-0137, executed by Claude Code at Bill's decision 2026-09-23)";
const SHEAR = 'cbc2e53e-1578-4776-a9bf-9897c27d066a';
const TEREX = '7e35a4aa-d022-4e65-b64f-580c74f21cf1';
const DUPLICATE_DAY = '2026-09-01';
const EXPECTED_GAP_DAYS = ['2026-09-01', '2026-09-03', '2026-09-04', '2026-09-08', '2026-09-18'];
const APPLY = process.argv.includes('--apply');

class Rehearsal extends Error {}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const pt = (d: Date): string =>
  `${d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`;

function fail(msg: string): never {
  throw new Error(`GATE: ${msg}`);
}

async function main(): Promise<void> {
  const woodland = await prisma.site.findUnique({ where: { code: 'woodland' } });
  if (!woodland) fail('no woodland site');

  const designation = await prisma.siteThroughputMachine.findUnique({
    where: { site_id: woodland.id },
  });
  if (designation?.equipment_id !== TEREX) {
    fail(
      `Woodland designation is ${designation?.equipment_id ?? 'absent'}, not the Terex — deploy first`,
    );
  }
  for (const id of [SHEAR, TEREX]) {
    const e = await prisma.equipment.findUnique({ where: { id } });
    if (!e || e.site_id !== woodland.id || !e.is_active || e.merged_into_id) {
      fail(`${id} is not a live Woodland row`);
    }
  }

  const summary = await prisma.$transaction(
    async (tx) => {
      const totalBefore = await tx.equipmentDailyThroughput.count();
      const shearRows = await tx.equipmentDailyThroughput.findMany({
        where: { equipment_id: SHEAR },
        orderBy: { throughput_date: 'asc' },
      });
      if (shearRows.some((r) => r.voided_at)) fail('shear holds voided rows');
      const terexDays = new Map(
        (
          await tx.equipmentDailyThroughput.findMany({
            where: { equipment_id: TEREX, voided_at: null },
          })
        ).map((r) => [iso(r.throughput_date), r]),
      );
      const overlap = shearRows.filter((r) => terexDays.has(iso(r.throughput_date)));
      if (overlap.length !== 1 || iso(overlap[0]!.throughput_date) !== DUPLICATE_DAY) {
        fail(
          `overlap days ${overlap.map((r) => iso(r.throughput_date)).join(',')} ≠ ${DUPLICATE_DAY}`,
        );
      }
      const dup = overlap[0]!;
      const kept = terexDays.get(DUPLICATE_DAY)!;
      const same = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) =>
        a === null || b === null ? a === b : a.equals(b);
      if (
        dup.units_processed !== kept.units_processed ||
        !same(dup.run_hours, kept.run_hours) ||
        !same(dup.start_hours, kept.start_hours) ||
        !same(dup.end_hours, kept.end_hours)
      ) {
        fail(`${DUPLICATE_DAY} readings differ — a person must pick which stands`);
      }

      const gaps = await tx.equipmentThroughputGapAlert.findMany({
        where: { equipment_id: SHEAR },
        orderBy: { gap_date: 'asc' },
      });
      if (gaps.map((g) => iso(g.gap_date)).join() !== EXPECTED_GAP_DAYS.join()) {
        fail(`shear gap alerts ${gaps.map((g) => iso(g.gap_date)).join(',')}`);
      }

      // 1. The duplicate 09-01 — its full row goes into the audit entry.
      await tx.equipmentDailyThroughput.delete({ where: { id: dup.id } });
      await writeAudit(
        {
          actor_label: ACTOR_LABEL,
          action: 'delete',
          table_name: 'equipment_daily_throughput',
          row_id: dup.id,
          before: dup,
          after: {
            resolution:
              `BX-12: duplicate of the Terex's ${DUPLICATE_DAY} reading (row ${kept.id}, entered ` +
              `${pt(kept.created_at)}); this copy was entered on EQ24 — Shear Machine at ` +
              `${pt(dup.created_at)} after the site machine was mis-resolved to the shear. ` +
              'Identical units / meter readings. The Terex row stands (Bill, 2026-09-23).',
            kept_row_id: kept.id,
          },
        },
        { tx },
      );

      // 2. Every other shear day moves to the Terex, one audit row each.
      const moved = shearRows.filter((r) => r.id !== dup.id);
      for (const r of moved) {
        await tx.equipmentDailyThroughput.update({
          where: { id: r.id },
          data: { equipment_id: TEREX },
        });
        await writeAudit(
          {
            actor_label: ACTOR_LABEL,
            action: 'update',
            table_name: 'equipment_daily_throughput',
            row_id: r.id,
            before: r,
            after: {
              ...r,
              equipment_id: TEREX,
              via: 'BX-12: reading belongs to the Terex (mis-resolved to EQ24 — Shear Machine)',
            },
          },
          { tx },
        );
      }

      // 3. Gap alerts move too; each carries its verdict. The scan asks at 08:30 PT
      //    on `scanned_on`; the alert's own `created_at` is that instant.
      const verdicts: { day: string; verdict: string }[] = [];
      for (const g of gaps) {
        const day = iso(g.gap_date);
        const terexRow = terexDays.get(day);
        const artefact = terexRow !== undefined && terexRow.created_at < g.created_at;
        const shearRow = moved.find((r) => iso(r.throughput_date) === day);
        const verdict = artefact
          ? `ARTEFACT of the split: the Terex already had ${day} (entered ${pt(terexRow.created_at)}) ` +
            `when the scan asked the shear at ${pt(g.created_at)}. The nudge was false.`
          : shearRow
            ? `REAL at scan time (${pt(g.created_at)}): no reading for ${day} on either machine; ` +
              `entered late at ${pt(shearRow.created_at)}.`
            : `REAL: no reading for ${day} on either machine, then or now.`;
        verdicts.push({ day, verdict });
        await tx.equipmentThroughputGapAlert.update({
          where: { id: g.id },
          data: { equipment_id: TEREX },
        });
        await writeAudit(
          {
            actor_label: ACTOR_LABEL,
            action: 'update',
            table_name: 'equipment_throughput_gap_alerts',
            row_id: g.id,
            before: g,
            after: { ...g, equipment_id: TEREX, bx12_verdict: verdict },
          },
          { tx },
        );
      }

      // Post-conditions.
      const [shearLeft, shearGapsLeft, totalAfter] = await Promise.all([
        tx.equipmentDailyThroughput.count({ where: { equipment_id: SHEAR } }),
        tx.equipmentThroughputGapAlert.count({ where: { equipment_id: SHEAR } }),
        tx.equipmentDailyThroughput.count(),
      ]);
      if (shearLeft !== 0 || shearGapsLeft !== 0) fail('shear still holds rows');
      if (totalAfter !== totalBefore - 1) fail(`total ${totalBefore} → ${totalAfter}, expected −1`);
      const chain = await tx.equipmentDailyThroughput.findMany({
        where: {
          equipment_id: TEREX,
          voided_at: null,
          throughput_date: { gte: new Date('2026-08-25T00:00:00Z') },
        },
        orderBy: { throughput_date: 'asc' },
      });
      for (let i = 1; i < chain.length; i += 1) {
        const prev = chain[i - 1]!;
        const cur = chain[i]!;
        if (!prev.end_hours || !cur.start_hours || !prev.end_hours.equals(cur.start_hours)) {
          fail(`meter chain breaks at ${iso(cur.throughput_date)}`);
        }
      }

      const out = {
        totalBefore,
        totalAfter,
        deletedDuplicate: { id: dup.id, day: DUPLICATE_DAY, keptRowId: kept.id },
        movedDays: moved.map((r) => iso(r.throughput_date)),
        verdicts,
        terexLatest: iso(chain[chain.length - 1]!.throughput_date),
        terexLatestEndHours: chain[chain.length - 1]!.end_hours?.toString(),
      };
      if (!APPLY) {
        console.log(JSON.stringify({ rehearsal: true, ...out }, null, 2));
        throw new Rehearsal();
      }
      return out;
    },
    { timeout: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  console.log(JSON.stringify({ applied: true, ...summary }, null, 2));
}

main()
  .catch((e: unknown) => {
    if (e instanceof Rehearsal) {
      console.log('DRY RUN — rolled back. Re-run with --apply to commit.');
      return;
    }
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
