// ADR-0135 follow-ups — one-off: execute Bill's 2026-09-23 calls on the
// equipment decision list (OPEN-ITEMS §0.BX, BX-3 and BX-6).
//
// EXECUTED ONCE against production on 2026-09-23 (PDT). Retained because it IS
// the record of what ran, in the same shape as the 2026-09-22 dedupe script
// (`2026-09-22-equipment-dedupe-merge.ts`), whose `mergeEquipment` path it reuses.
//
// WHAT BILL DECIDED (2026-09-23):
//   BX-6  `Trailer # 19` (open request, Woodland) → resolve onto Eugene's existing
//         `Trailer #19` (same trailer, moved yards — the earlier invoice reads
//         "DOT for trailer #19 going to Eugene Stores").
//   BX-6  bare `60` → `60 — Strick 28 Ft Roll Up Door Trailer` (Eugene, both seed).
//   BX-6  `Trailer # 5327` (open request, Woodland) → no 5327 exists at either site,
//         so create it in Woodland's trailer naming format and resolve onto it.
//   BX-3  the three work orders posing as assets → repoint each invoice at the real
//         trailer(s) it names, then deactivate the pseudo-asset.
//
// HOW EACH BX-3 ROW WAS READ (the invoice and the VLM register, not the name alone):
//   `fix trailer 95 and 5308` (Woodland) → `5308 — Great Dane…` (Woodland). The
//       `95` in this work order is the 2005 Wabash that lives AT Woodland
//       (decision register G3); the only `95` in the registry is Eugene's 1984
//       Fruehauf — a DIFFERENT trailer — so it is deliberately NOT linked. The
//       Wabash is not in the registry; the note on the request names it.
//   `Fix and repair trailer: 53489, 5340, 35, 282859…` (Woodland) → `35 — 28 Ft
//       Roll Up Door Trailer` (Woodland), the only named unit in the registry at
//       either site. 53489 / 5340 / 282859 are named in the note.
//   `relay order from Aleks` (Woodland) — a Grainger past-due notice for a part.
//       It names NO trailer, so there is nothing true to repoint it at. It is
//       deactivated (off every approver's picker, which is the harm) and its
//       invoice keeps pointing at the deactivated row — a state the resolve path
//       already treats as legitimate. Which machine the relay was for is a
//       question for Morena, not a guess for this script.
//
// WHY THE SCHEMA'S MULTI-ASSET LINKS ARE NOT USED: an invoice MAY carry one
// `ap_equipment_links` row per asset, but the second unit in each work order is
// not in the registry, so there is no row to link. Bill's fallback applies: link
// the one that exists, record a note naming the rest.
//
// ACTOR: every write names itself (`audit_log.actor_label`), never a person's id
// — CLAUDE.md hard rule #6, the ADR-0077 `SystemActorContext` convention. The
// merges run through `mergeEquipment`; the resolves, the create, the deactivate
// and the notes are written here because the library versions of those paths
// take a signed-in user (`ActorContext`) and borrowing one would put a false
// claim in the audit log. Each inline write mirrors its library counterpart
// field-for-field (resolve: `resolveEquipmentRequest`; create:
// `createEquipmentInTx`; deactivate: `setActive`), inside ONE transaction per
// change with its audit row.
//
// SAFETY GATES (hard stop, before any write):
//   - every row is where the plan says (ids, sites, open/active state, link counts);
//   - no loser carries `equipment_daily_throughput` / gap-alert rows
//     (`mergeEquipment` does not repoint those — ADR-0135 §2 known gap);
//   - no `5327` exists at either site at run time.
// CONSERVATION (after): the whole `ap_equipment_links` table keeps its row count,
// its distinct-invoice count and its spend — attribution moves, money never does.
//
// RUN (workstation → SSH tunnel to prod Postgres; the image ships no TS runtime):
//   ssh -f -N -L 15432:172.23.0.2:5432 bbarnard065@10.99.0.2
//   DATABASE_URL='postgresql://dr3:…@127.0.0.1:15432/dr3_vision?schema=public' \
//     npx tsx scripts/one-off/2026-09-23-equipment-followups.ts [--apply]
// Without `--apply` it is a read-only dry run.
//
// BACKUP: svdp-dev:~/backups-adhoc/dr3-equipment-followups-pre-20260923-010936-PT.dump
// (equipment 577 / ap_equipment_links 163 / ap_equipment_requests 32 rows).

import { Prisma } from '@prisma/client';
import { mergeEquipment, type SystemActorContext } from '../../src/lib/admin-equipment';
import { writeAudit } from '../../src/lib/audit';
import { prisma } from '../../src/lib/prisma';

const ACTOR: SystemActorContext = {
  actorLabel:
    "system:equipment-followups (ADR-0135 BX-3/BX-6, executed by Claude Code at Bill's decision 2026-09-23)",
  ip: null,
  userAgent: null,
};

const SITE = {
  eugene: 'e76bf5a3-b25f-4b10-888e-1b6656431fbe',
  woodland: 'de9875a3-a09f-484f-aed1-2891ef544b87',
} as const;

interface Merge {
  label: string;
  winner: string;
  loser: string;
  site: string;
  expectLoserLinks: number;
  /** The escape-hatch request behind the pseudo-asset, and the note naming the
   *  units the registry does not carry. Absent for a plain duplicate. */
  note?: { equipmentRequestId: string; text: string };
}

export const MERGES: readonly Merge[] = [
  {
    label: "eugene '60' → '60 — Strick 28 Ft Roll Up Door Trailer'",
    winner: 'c3a75689-4834-4ee0-8b91-d35e19505c6e',
    loser: 'afd5f26a-d3ce-4101-bf9e-97dad2f5a4fe',
    site: SITE.eugene,
    expectLoserLinks: 0,
  },
  {
    label: "woodland 'fix trailer 95 and 5308' → '5308 — Great Dane 53 Ft Swing Door Trailer'",
    winner: 'd2b6c806-e128-4a30-9523-e497e86f9b34',
    loser: 'd9372c52-75f5-4555-8ff2-6a0857331479',
    site: SITE.woodland,
    expectLoserLinks: 1,
    note: {
      equipmentRequestId: 'a66eea7c-60c0-4505-bdf2-c92d20118e75',
      text:
        'ADR-0135 BX-3 (2026-09-23): this work order names two trailers. Linked to 5308. ' +
        "The other, '95', is the 2005 Wabash kept at Woodland (VLM register G3), which is " +
        "not in the registry; it is NOT Eugene's '95 — Fruehauf', a different trailer.",
    },
  },
  {
    label:
      "woodland 'Fix and repair trailer: 53489, 5340, 35, 282859…' → '35 — 28 Ft Roll Up Door Trailer'",
    winner: 'da22024a-73f8-4929-b52d-32fb45519c2b',
    loser: 'fc211740-df9a-49c2-a57f-2362fe469ade',
    site: SITE.woodland,
    expectLoserLinks: 1,
    note: {
      equipmentRequestId: '32896113-b3c3-45d5-aa4f-b232e29baf75',
      text:
        'ADR-0135 BX-3 (2026-09-23): this work order names four trailers. Linked to 35, the ' +
        'only one in the registry. Also named, not in the registry at either site: 53489, ' +
        '5340, 282859.',
    },
  },
];

/** BX-3 row that names no trailer: deactivate only, link left where it is. */
const DEACTIVATE_ONLY = {
  label: "woodland 'relay order from Aleks' (names no trailer)",
  id: 'cd87a14f-1084-4e8e-a3a6-f44f8aacd1dd',
  site: SITE.woodland,
  expectLinks: 1,
};

interface Resolve {
  label: string;
  requestId: string;
  site: string;
  /** Resolve onto this existing row, or create `create` and resolve onto it. */
  target: { existing: string } | { create: { display_name: string; site: string } };
}

export const RESOLVES: readonly Resolve[] = [
  {
    label: "woodland request 'Trailer # 19' → eugene 'Trailer #19' (moved yards)",
    requestId: 'e6abc201-d2fd-4a37-ad3d-ff7b6d1f8647',
    site: SITE.woodland,
    target: { existing: '4d1dbf0a-c2ee-4773-bef1-ff719afb569b' },
  },
  {
    // Woodland's registry names trailers `<unit> — <make> <length> Ft <door> Trailer`.
    // Invoice 6813 (United Fleet, CA BIT inspection) gives the unit and the type,
    // not the make or length — so only what is known goes in the name.
    label: "woodland request 'Trailer # 5327' → new '5327 — Trailer' (woodland)",
    requestId: 'dfd4cb2d-9c8d-4375-85d5-1d1d5efc3e37',
    site: SITE.woodland,
    target: { create: { display_name: '5327 — Trailer', site: SITE.woodland } },
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

/** Units matching 5327 exactly (as a whole token) at either site. */
async function existing5327(): Promise<{ id: string; display_name: string }[]> {
  return prisma.$queryRaw<{ id: string; display_name: string }[]>`
    SELECT id, display_name FROM equipment
     WHERE display_name ~ '(^|[^0-9])5327([^0-9]|$)'
  `;
}

async function preflight(): Promise<void> {
  for (const m of MERGES) {
    const [w, l, links, thr, gaps] = await Promise.all([
      prisma.equipment.findUnique({ where: { id: m.winner } }),
      prisma.equipment.findUnique({ where: { id: m.loser } }),
      prisma.apEquipmentLink.count({ where: { equipment_id: m.loser } }),
      prisma.equipmentDailyThroughput.count({ where: { equipment_id: m.loser } }),
      prisma.equipmentThroughputGapAlert.count({ where: { equipment_id: m.loser } }),
    ]);
    if (!w || !l) fail(`${m.label}: row missing`);
    if (w.site_id !== m.site || l.site_id !== m.site) fail(`${m.label}: site drifted`);
    if (w.merged_into_id || l.merged_into_id) fail(`${m.label}: already merged`);
    if (!w.is_active) fail(`${m.label}: survivor is inactive`);
    if (links !== m.expectLoserLinks)
      fail(`${m.label}: loser links ${links} ≠ planned ${m.expectLoserLinks} — re-plan`);
    if (thr || gaps)
      fail(`${m.label}: loser has throughput(${thr})/gap(${gaps}) rows mergeEquipment won't move`);
    if (m.note) {
      const req = await prisma.apEquipmentRequest.findUnique({
        where: { id: m.note.equipmentRequestId },
      });
      if (!req || req.resolved_equipment_id !== m.loser)
        fail(`${m.label}: escape-hatch request no longer resolves to the pseudo-asset`);
    }
    console.log(`plan merge: ${m.label}  [${w.display_name} ← ${l.display_name}] links=${links}`);
  }

  const d = await prisma.equipment.findUnique({ where: { id: DEACTIVATE_ONLY.id } });
  const dLinks = await prisma.apEquipmentLink.count({
    where: { equipment_id: DEACTIVATE_ONLY.id },
  });
  if (!d || d.site_id !== DEACTIVATE_ONLY.site || !d.is_active || d.merged_into_id)
    fail(`${DEACTIVATE_ONLY.label}: not the active row the plan expects`);
  if (dLinks !== DEACTIVATE_ONLY.expectLinks)
    fail(`${DEACTIVATE_ONLY.label}: links ${dLinks} ≠ planned ${DEACTIVATE_ONLY.expectLinks}`);
  console.log(`plan deactivate: ${DEACTIVATE_ONLY.label} links=${dLinks} (left in place)`);

  for (const r of RESOLVES) {
    const req = await prisma.apEquipmentRequest.findUnique({ where: { id: r.requestId } });
    if (!req || req.status !== 'open' || req.site_id !== r.site)
      fail(`${r.label}: request is not the open ${r.site} request the plan expects`);
    const reqLinks = await prisma.apEquipmentLink.count({
      where: { equipment_request_id: r.requestId },
    });
    if (reqLinks !== 1) fail(`${r.label}: request carries ${reqLinks} links, planned 1`);
    if ('existing' in r.target) {
      const t = await prisma.equipment.findUnique({ where: { id: r.target.existing } });
      if (!t || !t.is_active || t.merged_into_id) fail(`${r.label}: target not a live asset`);
    } else {
      const clash = await existing5327();
      if (clash.length > 0)
        fail(`${r.label}: a 5327 now exists (${clash.map((c) => c.display_name).join(', ')})`);
    }
    console.log(`plan resolve: ${r.label}`);
  }
}

/** Mirrors `resolveEquipmentRequest` (both modes), with a system actor. */
async function resolve(r: Resolve): Promise<void> {
  await prisma.$transaction(async (tx) => {
    let equipmentId: string;
    let equipmentDisplayName: string;
    let siteId: string;
    let mode: 'existing' | 'create';
    if ('existing' in r.target) {
      const t = await tx.equipment.findUnique({ where: { id: r.target.existing } });
      if (!t || t.merged_into_id) throw new Error(`${r.label}: target vanished or merged`);
      equipmentId = t.id;
      equipmentDisplayName = t.display_name;
      siteId = t.site_id;
      mode = 'existing';
    } else {
      const { display_name, site } = r.target.create;
      const dup = await tx.equipment.findFirst({ where: { site_id: site, display_name } });
      if (dup) throw new Error(`${r.label}: '${display_name}' already exists`);
      const row = await tx.equipment.create({
        data: { site_id: site, display_name, category: 'vehicle', is_active: true },
      });
      await writeAudit(
        {
          actor_label: ACTOR.actorLabel,
          action: 'insert',
          table_name: 'equipment',
          row_id: row.id,
          after: { ...row, via: 'ap_equipment_request_resolve' },
        },
        { tx },
      );
      equipmentId = row.id;
      equipmentDisplayName = row.display_name;
      siteId = row.site_id;
      mode = 'create';
    }

    const stamped = await tx.apEquipmentRequest.updateMany({
      where: { id: r.requestId, status: 'open' },
      data: {
        status: 'resolved',
        resolved_equipment_id: equipmentId,
        resolved_by: null,
        resolved_at: new Date(),
        resolution_note: `ADR-0135 BX-6 — Bill's call 2026-09-23: ${r.label}.`,
      },
    });
    if (stamped.count !== 1) throw new Error(`${r.label}: request was no longer open`);
    const backfill = await tx.apEquipmentLink.updateMany({
      where: { equipment_request_id: r.requestId },
      data: { equipment_id: equipmentId, equipment_request_id: null },
    });
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
          resolved_equipment_id: equipmentId,
          equipment_display_name: equipmentDisplayName,
          site_id: siteId,
          backfilled_links: backfill.count,
          ap_request_id: req.ap_request_id,
          has_note: true,
          resolution_mode: mode,
        },
      },
      { tx },
    );
    console.log(
      `resolved ${r.label}: equipment=${equipmentId} (${equipmentDisplayName}) backfilledLinks=${backfill.count}`,
    );
  });
}

/** Appends the "other units named" note to the pseudo-asset's escape-hatch request. */
async function recordNote(m: Merge): Promise<void> {
  if (!m.note) return;
  const { equipmentRequestId, text } = m.note;
  await prisma.$transaction(async (tx) => {
    const before = await tx.apEquipmentRequest.findUniqueOrThrow({
      where: { id: equipmentRequestId },
    });
    const next = before.resolution_note ? `${before.resolution_note}\n${text}` : text;
    await tx.apEquipmentRequest.update({
      where: { id: equipmentRequestId },
      data: { resolution_note: next },
    });
    await writeAudit(
      {
        actor_label: ACTOR.actorLabel,
        action: 'update',
        table_name: 'ap_equipment_requests',
        row_id: equipmentRequestId,
        before: { resolution_note: before.resolution_note },
        after: { resolution_note: next },
      },
      { tx },
    );
  });
}

/** Mirrors `setActive(id, false)` — audited soft-delete, row never removed. */
async function deactivate(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.equipment.findUniqueOrThrow({ where: { id: DEACTIVATE_ONLY.id } });
    const after = await tx.equipment.update({
      where: { id: DEACTIVATE_ONLY.id },
      data: { is_active: false },
    });
    await writeAudit(
      {
        actor_label: ACTOR.actorLabel,
        action: 'soft_delete',
        table_name: 'equipment',
        row_id: DEACTIVATE_ONLY.id,
        before,
        after: {
          ...after,
          reason:
            'ADR-0135 BX-3: a parts order posing as an asset; names no trailer, so its invoice link is left on this row.',
        },
      },
      { tx },
    );
  });
  console.log(`deactivated ${DEACTIVATE_ONLY.label}`);
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

  for (const m of MERGES) {
    const r = await mergeEquipment(m.winner, m.loser, ACTOR);
    if (!r.ok) fail(`${m.label}: merge refused (${r.reason})`);
    console.log(
      `merged ${m.label}: repointedLinks=${r.repointedLinks} repointedRequests=${r.repointedRequests}`,
    );
    await recordNote(m);
  }
  await deactivate();
  for (const r of RESOLVES) await resolve(r);

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
  const stranded = await prisma.apEquipmentLink.count({
    where: { equipment_id: { in: MERGES.map((m) => m.loser) } },
  });
  if (stranded !== 0) fail(`${stranded} links still point at a merged-away row`);
  console.log('conserved: links, invoices and spend unchanged; no link left on a merged row');
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Prisma.PrismaClientKnownRequestError ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
