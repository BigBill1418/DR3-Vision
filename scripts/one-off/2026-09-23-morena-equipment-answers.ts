// OPEN-ITEMS §0.BX (BX-2 `48-68`, BX-4 green baler, BX-5 EQ24) — one-off: apply
// Morena Gomez's (Woodland manager) answers, received 2026-09-23 ~7 AM PDT.
//
// Retained as the record of what ran, in the shape of
// `2026-09-23-cross-site-trailer-merge.ts` / `2026-09-23-equipment-followups.ts`.
//
// MORENA'S ANSWERS (verbatim):
//   1. "48-68 trailer" vs 4868 (Fruehauf): "Yes, this is the same trailer."
//   2. Green horizontal baler: "Green Horizontal baler does not have equipment number."
//   3. "EQ 24 is the shear machine. Terex is the terex machine no number."
//
// WHAT RUNS, AND THE EVIDENCE BEHIND EACH (read from the invoices, not the names):
//
// A. MERGE `48-68 trailer` (Woodland) → `4868 — Fruehauf 28 Ft Roll Up Door Trailer`
//    (Eugene seed), survivor FLEET-WIDE (trailers move yards — Bill, BX-2). The
//    loser's only invoice is United Fleet 6743, subject "Unit #4868", approver's
//    note "DOT on trailer 48-68". The merged row keeps its old name, so the dash
//    spelling now resolves to the survivor in every search (ADR-0135 §8, merged
//    losers return their survivor) — that is the alias record.
//
// B. GREEN BALER — the Eugene row `Green Horizontal baler Topper` IS Woodland's green
//    horizontal baler. Its one invoice is Kelliher Machine Works 0174 ($4,005.00):
//    addressed "DR-3, 1233 Commerce Ave Suite B+C, Woodland CA", job "P.O. Green
//    Baler", work "Repair Big Green Baler — trouble shoot hydraulic problem on the top
//    stuffing system … make ram lock for main pressing cylinder". Both open Woodland
//    requests are about that same invoice: Janette's (09-22 11:51 AM PT) carries the
//    byte-identical PDF (sha256 8bf06d14…), Morena's (09-22 9:01 AM PT) is Vision's own
//    08-24 approval mail for it, forwarded back by AP with a GL-coding question. The
//    row was requested by Morena herself and filed at Eugene. So: rename it through
//    the structured name generator (type Baler, details "Green Horizontal", no unit —
//    `Green Horizontal Baler`), type it `baler`, move it to Woodland, and resolve both
//    requests onto it. NOT `… — Kelliher`: Kelliher is the repair shop, not the make,
//    and a `<x> — <rest>` name is read by the matcher as unit `<x>` (seed format).
//
// C. EQ24 — the open request `EQ24 Terex Shredder` (Janette, 09-18) is Kelliher
//    invoices 0182 + 0183 ($9,902.00 on one approval). 0183 ($8,947) reads "TAS815
//    Shredder — repair broken section, build up worn places, hard faced (set 6); RJR
//    shaft assemblies"; Kelly's cover mail is about "the shredder shafts" and
//    Powerscreen parts. That is the Terex shredder, NOT the EQ24 shear — so it
//    resolves onto `Terex`. 0182 ($955) is "replace left side hydraulic cylinder on
//    baler + bent ram; change hydraulic hoses", which the approver called EQ 21: named
//    in the resolution note, NOT given a second link — a link attributes the WHOLE
//    invoice amount, so a second one would count the $9,902 twice. `EQ24 Terex
//    Shredder` never existed as an asset row (it is a request), so there is nothing
//    to merge. `Terex` and `EQ24 — Shear Machine` are recorded as DIFFERENT ASSETS so
//    the duplicates queue never proposes them.
//
// ACTOR: every write names itself (`audit_log.actor_label`), never a person's id
// (CLAUDE.md hard rule #6, ADR-0077). Library paths used where they take a system
// actor: `mergeEquipment`, `updateEquipment`, `markEquipmentDistinct`. The request
// resolves are written inline because `resolveEquipmentRequest` takes a signed-in
// user; each mirrors its "existing" mode field-for-field (stamp conditional on
// `status='open'`, backfill the link, audit), as `2026-09-23-equipment-followups.ts`
// did. `asset_type` is not an `updateEquipment` field, so it is its own audited write.
// ONE transaction per change.
//
// SAFETY GATES (hard stop, before any write): every row is where the plan says (ids,
// sites, names, open/active state, link counts); the merge loser has no throughput /
// gap-alert rows; no live `Green Horizontal Baler` exists yet.
// CONSERVATION (after): the whole `ap_equipment_links` table keeps its row count,
// distinct-invoice count and spend; nothing references the merged row; the three
// requests are resolved and their links point at assets.
//
// RUN (workstation → SSH tunnel to prod Postgres; the image ships no TS runtime):
//   ssh -f -N -L 15432:<postgres container ip>:5432 bbarnard065@10.99.0.2
//   DATABASE_URL='postgresql://dr3:…@127.0.0.1:15432/dr3_vision?schema=public' \
//     npx tsx scripts/one-off/2026-09-23-morena-equipment-answers.ts [--apply]
// Without `--apply` it is a read-only dry run.
//
// BACKUP: svdp-dev:~/backups-adhoc/dr3-equipment-morena-answers-pre-20260923-071127-PT.dump

import {
  markEquipmentDistinct,
  mergeEquipment,
  updateEquipment,
  type SystemActorContext,
} from '../../src/lib/admin-equipment';
import { writeAudit } from '../../src/lib/audit';
import { generateDisplayName } from '../../src/lib/equipment/match';
import { prisma } from '../../src/lib/prisma';

const ACTOR: SystemActorContext = {
  actorLabel:
    "system:morena-equipment-answers (OPEN-ITEMS §0.BX BX-2/BX-4/BX-5, executed by Claude Code on Morena Gomez's answers 2026-09-23)",
  ip: null,
  userAgent: null,
};

const SITE = {
  eugene: 'e76bf5a3-b25f-4b10-888e-1b6656431fbe',
  woodland: 'de9875a3-a09f-484f-aed1-2891ef544b87',
} as const;

const ROW = {
  trailer4868: '89fe4505-49a4-4152-a033-cbe79f363be4', // eugene '4868 — Fruehauf 28 Ft …'
  trailer4868Dash: 'ef09f6a9-b150-49eb-917e-37e40595b88d', // woodland '48-68 trailer'
  greenBaler: 'ef357fc3-901b-4303-8c05-d99a60aead2b', // eugene 'Green Horizontal baler Topper'
  terex: '7e35a4aa-d022-4e65-b64f-580c74f21cf1', // woodland 'Terex'
  eq24Shear: 'cbc2e53e-1578-4776-a9bf-9897c27d066a', // woodland 'EQ24 — Shear Machine'
} as const;

const GREEN_BALER_NAME = generateDisplayName({ details: 'Green Horizontal', assetType: 'Baler' });

interface Resolve {
  label: string;
  requestId: string;
  description: string;
  target: string;
  note: string;
}

export const RESOLVES: readonly Resolve[] = [
  {
    label:
      "woodland request 'green horizontal baler machine Woodland.' (Morena 09-22) → green baler",
    requestId: '9005f58d-e213-4dbe-84b6-dd72baa1cf6b',
    description: 'green horizontal baler machine Woodland.',
    target: ROW.greenBaler,
    note:
      'OPEN-ITEMS BX-4 (2026-09-23): Morena — "Green Horizontal baler does not have equipment ' +
      'number." Kelliher Machine Works invoice 0174 ($4,005.00, "Repair Big Green Baler", DR-3 ' +
      "Woodland); this approval is Vision's own 08-24 decision mail for it, forwarded back by AP. " +
      'Resolved onto the row first created for that invoice (renamed, moved to Woodland).',
  },
  {
    label: "woodland request 'Green Horizontal Baler -Woodland' (Janette 09-22) → green baler",
    requestId: '3cd7c3fd-10c7-4a84-a512-3ce3f684b9fb',
    description: 'Green Horizontal Baler -Woodland',
    target: ROW.greenBaler,
    note:
      'OPEN-ITEMS BX-4 (2026-09-23): Morena — "Green Horizontal baler does not have equipment ' +
      'number." Same Kelliher invoice 0174 PDF as the 08-24 Eugene approval (sha256 8bf06d14…). ' +
      'Resolved onto that row (renamed, moved to Woodland). Paid-once check is BX-8.',
  },
  {
    label: "woodland request 'EQ24 Terex Shredder' (Janette 09-18) → 'Terex'",
    requestId: 'c4a9d589-c664-4338-9023-1223c46f7b1c',
    description: 'EQ24 Terex Shredder',
    target: ROW.terex,
    note:
      'OPEN-ITEMS BX-5 (2026-09-23): Morena — "EQ 24 is the shear machine. Terex is the terex ' +
      'machine no number." Kelliher 0183 ($8,947) is "TAS815 Shredder … RJR shaft assemblies" — ' +
      'the Terex shredder, not the EQ24 shear. The same approval carries Kelliher 0182 ($955, ' +
      '"replace left side hydraulic cylinder on baler + bent ram; change hydraulic hoses"), which ' +
      'the approver named EQ 21; not given a second link (a link counts the whole $9,902).',
  },
];

function fail(message: string): never {
  console.error(`\nHARD STOP — ${message}`);
  process.exit(1);
}

interface Totals {
  links: number;
  invoices: number;
  spendCents: number;
}

/** Whole-table attribution totals. Nothing here may create or drop a link. */
async function totals(): Promise<Totals> {
  const rows = await prisma.$queryRaw<{ links: bigint; invoices: bigint; spend: bigint | null }[]>`
    SELECT count(*) AS links,
           count(DISTINCT l.request_id) AS invoices,
           sum(COALESCE(r.confirmed_amount_cents, r.amount_cents)) AS spend
      FROM ap_equipment_links l
      JOIN ap_requests r ON r.id = l.request_id
  `;
  const row = rows[0];
  if (!row) fail('totals query returned no row');
  return {
    links: Number(row.links),
    invoices: Number(row.invoices),
    spendCents: Number(row.spend ?? 0n),
  };
}

async function expectRow(
  id: string,
  want: { name: string; site: string | null; links: number },
): Promise<void> {
  const [row, links] = await Promise.all([
    prisma.equipment.findUnique({ where: { id } }),
    prisma.apEquipmentLink.count({ where: { equipment_id: id } }),
  ]);
  if (!row) fail(`${want.name}: row missing`);
  if (row.display_name !== want.name) fail(`${want.name}: name drifted to '${row.display_name}'`);
  if (row.site_id !== want.site) fail(`${want.name}: site drifted`);
  if (row.merged_into_id || !row.is_active) fail(`${want.name}: not a live active row`);
  if (links !== want.links) fail(`${want.name}: links ${links} ≠ planned ${want.links} — re-plan`);
  console.log(`plan row ok: ${want.name} links=${links}`);
}

async function preflight(): Promise<void> {
  await expectRow(ROW.trailer4868, {
    name: '4868 — Fruehauf 28 Ft Roll Up Door Trailer',
    site: SITE.eugene,
    links: 0,
  });
  await expectRow(ROW.trailer4868Dash, { name: '48-68 trailer', site: SITE.woodland, links: 1 });
  await expectRow(ROW.greenBaler, {
    name: 'Green Horizontal baler Topper',
    site: SITE.eugene,
    links: 1,
  });
  await expectRow(ROW.terex, { name: 'Terex', site: SITE.woodland, links: 18 });
  await expectRow(ROW.eq24Shear, { name: 'EQ24 — Shear Machine', site: SITE.woodland, links: 1 });

  const [thr, gaps] = await Promise.all([
    prisma.equipmentDailyThroughput.count({ where: { equipment_id: ROW.trailer4868Dash } }),
    prisma.equipmentThroughputGapAlert.count({ where: { equipment_id: ROW.trailer4868Dash } }),
  ]);
  if (thr || gaps) fail(`48-68 carries throughput(${thr})/gap(${gaps}) rows — re-plan`);

  if (GREEN_BALER_NAME !== 'Green Horizontal Baler')
    fail(`generated name is '${GREEN_BALER_NAME}'`);
  const clash = await prisma.equipment.findFirst({
    where: {
      merged_into_id: null,
      display_name: { equals: GREEN_BALER_NAME, mode: 'insensitive' },
    },
  });
  if (clash) fail(`'${GREEN_BALER_NAME}' already exists (${clash.id})`);

  for (const r of RESOLVES) {
    const req = await prisma.apEquipmentRequest.findUnique({ where: { id: r.requestId } });
    if (!req || req.status !== 'open' || req.site_id !== SITE.woodland)
      fail(`${r.label}: not the open Woodland request the plan expects`);
    if (req.description !== r.description) fail(`${r.label}: description drifted`);
    const reqLinks = await prisma.apEquipmentLink.count({
      where: { equipment_request_id: r.requestId },
    });
    if (reqLinks !== 1) fail(`${r.label}: request carries ${reqLinks} links, planned 1`);
    console.log(`plan resolve: ${r.label}`);
  }
}

/** Mirrors `resolveEquipmentRequest` mode 'existing' (no reactivate), with a system actor. */
async function resolve(r: Resolve): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const t = await tx.equipment.findUnique({ where: { id: r.target } });
    if (!t || t.merged_into_id || !t.is_active) throw new Error(`${r.label}: target not live`);
    const stamped = await tx.apEquipmentRequest.updateMany({
      where: { id: r.requestId, status: 'open' },
      data: {
        status: 'resolved',
        resolved_equipment_id: t.id,
        resolved_by: null,
        resolved_at: new Date(),
        resolution_note: r.note,
      },
    });
    if (stamped.count !== 1) throw new Error(`${r.label}: request was no longer open`);
    const backfill = await tx.apEquipmentLink.updateMany({
      where: { equipment_request_id: r.requestId },
      data: { equipment_id: t.id, equipment_request_id: null },
    });
    if (backfill.count !== 1) throw new Error(`${r.label}: backfilled ${backfill.count} links`);
    const req = await tx.apEquipmentRequest.findUniqueOrThrow({ where: { id: r.requestId } });
    await writeAudit(
      {
        actor_label: ACTOR.actorLabel,
        action: 'update',
        table_name: 'ap_equipment_requests',
        row_id: r.requestId,
        before: { status: 'open' },
        after: {
          status: 'resolved',
          resolved_equipment_id: t.id,
          equipment_display_name: t.display_name,
          site_id: t.site_id,
          backfilled_links: backfill.count,
          ap_request_id: req.ap_request_id,
          has_note: true,
          resolution_mode: 'existing',
        },
      },
      { tx },
    );
    console.log(`resolved ${r.label}: → ${t.display_name} backfilledLinks=${backfill.count}`);
  });
}

/** `asset_type` is not an `updateEquipment` field; audited like it (full before/after). */
async function setAssetType(id: string, assetType: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.equipment.findUniqueOrThrow({ where: { id } });
    const after = await tx.equipment.update({ where: { id }, data: { asset_type: assetType } });
    await writeAudit(
      {
        actor_label: ACTOR.actorLabel,
        action: 'update',
        table_name: 'equipment',
        row_id: id,
        before,
        after,
      },
      { tx },
    );
  });
  console.log(`typed ${id} asset_type=${assetType}`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await preflight();
  const before = await totals();
  console.log(
    `baseline: links=${before.links} invoices=${before.invoices} spend=${before.spendCents} cents`,
  );
  if (!apply) {
    console.log('dry run — no writes. Re-run with --apply.');
    return;
  }

  // A — the dash spelling is 4868; survivor fleet-wide.
  const m = await mergeEquipment(ROW.trailer4868, ROW.trailer4868Dash, ACTOR, {
    survivorSiteId: null,
  });
  if (!m.ok) fail(`48-68 merge refused (${m.reason})`);
  console.log(`merged 48-68 → 4868: ${JSON.stringify(m.repointed)} site=${m.winner.site_id}`);

  // B — the Topper row is Woodland's green horizontal baler.
  const u = await updateEquipment(
    ROW.greenBaler,
    { display_name: GREEN_BALER_NAME, site_id: SITE.woodland, category: 'baler' },
    ACTOR,
  );
  if (!u.ok) fail(`green baler update refused (${u.reason})`);
  console.log(`renamed green baler → '${u.equipment.display_name}' site=woodland`);
  await setAssetType(ROW.greenBaler, 'baler');

  // B + C — the three open requests.
  for (const r of RESOLVES) await resolve(r);

  // C — Terex and the EQ24 shear are two machines.
  const d = await markEquipmentDistinct(
    ROW.terex,
    ROW.eq24Shear,
    'Morena Gomez (Woodland manager) 2026-09-23: "EQ 24 is the shear machine. Terex is the terex machine no number."',
    ACTOR,
  );
  if (!d.ok) fail(`mark distinct refused (${d.reason})`);
  console.log("marked 'Terex' ≠ 'EQ24 — Shear Machine'");

  // Verification.
  const after = await totals();
  console.log(
    `after: links=${after.links} invoices=${after.invoices} spend=${after.spendCents} cents`,
  );
  if (
    after.links !== before.links ||
    after.invoices !== before.invoices ||
    after.spendCents !== before.spendCents
  )
    fail('ATTRIBUTION NOT CONSERVED');
  const [loserLinks, loserReqs, loserThr, openLeft, unlinked, survivor] = await Promise.all([
    prisma.apEquipmentLink.count({ where: { equipment_id: ROW.trailer4868Dash } }),
    prisma.apEquipmentRequest.count({ where: { resolved_equipment_id: ROW.trailer4868Dash } }),
    prisma.equipmentDailyThroughput.count({ where: { equipment_id: ROW.trailer4868Dash } }),
    prisma.apEquipmentRequest.count({
      where: { id: { in: RESOLVES.map((r) => r.requestId) }, status: 'open' },
    }),
    prisma.apEquipmentLink.count({
      where: { equipment_request_id: { in: RESOLVES.map((r) => r.requestId) } },
    }),
    prisma.equipment.findUniqueOrThrow({ where: { id: ROW.trailer4868 } }),
  ]);
  if (loserLinks || loserReqs || loserThr)
    fail(`merged row still referenced: links=${loserLinks} reqs=${loserReqs} thr=${loserThr}`);
  if (openLeft || unlinked) fail(`${openLeft} requests still open / ${unlinked} links unresolved`);
  if (survivor.site_id !== null) fail('4868 survivor is not fleet-wide');
  console.log('conserved: links, invoices, spend unchanged; merged row unreferenced; 3 resolved');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
