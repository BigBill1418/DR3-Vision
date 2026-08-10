// 2026-08-10 — curated decision pass over the MyMRC source reconciliation queue,
// at Bill's written instruction ("approve the source names in the reconcile
// queue - if you believe that is correct and the best path forward").
//
// NOT a blanket bulk-approve, deliberately. The 50 pending `new_record` items
// contain four spellings of Ikea Emeryville/West Sac/Palo Alto, three of
// Go Getters and four of the Wilkerson Co. `applyReconcileDecision('approved')`
// creates the source VERBATIM, and the sync's fallback normalizer only collapses
// case/whitespace (`normalizeSourceName` — slashes and hyphens survive), so
// blanket approval would mint duplicate sources — the exact disease the queue
// exists to prevent (cf. the VLM equipment table's 492 ghosts).
//
// Curation rules, in order, per item:
//   1. If a Woodland source already resolves the name (exact, or normalized
//      against canonical+alias index): REJECT the queue item (nothing to create);
//      add an alias only if the verbatim spelling would not already resolve.
//   2. CANONICAL names: approve through `applyReconcileDecision` (the audited
//      path — source created + queue flipped + audit row in ONE tx).
//   3. VARIANT spellings: reject the queue item AND create a `source_aliases`
//      row pointing at the canonical source (ADR-0037 Addendum B7 — built for
//      exactly this), each alias write audited.
//   4. SPECIALS: "Oakland Hpusing" → create the CORRECTED source "Oakland
//      Housing" + alias the typo; "DR3 Woodland" → reject (the facility itself
//      is not an inbound source; MRC data artifact).
//
// Decisions are attributed to Bill's user id (he instructed the pass); every
// note says so. Effects on labels land at the NEXT hourly sync (top of hour) —
// upsert re-resolves source_id on expected_loads then.
//
// RUN: DATABASE_URL=<prod via tunnel> npx tsx scripts/one-off/2026-08-10-source-queue-curation.ts [--apply]

import { prisma } from '../../src/lib/prisma';
import { applyReconcileDecision } from '../../src/lib/reconcile/apply';

const BILL_USER_ID = 'c6a6ca68-c1d8-4c36-91b1-4b0dec272ec5'; // Bill Barnard, admin (verified live)
const NOTE_TAG = "at Bill's written instruction 2026-08-10 (curated pass executed by Claude Code)";

/** Variant → canonical-name mapping. Canonicals must be approved (or exist) first. */
const ALIAS_OF: Record<string, string> = {
  'Ikea /Emeryville': 'Ikea Emeryville',
  'Ikea / Emeryville': 'Ikea Emeryville',
  'ikea/ Palo Alto': 'Ikea Palo Alto',
  'Ikea / West Sacramento': 'Ikea West Sacramento',
  'Ikea West Sac': 'Ikea West Sacramento',
  'Go- Getters': 'Go Getters',
  'Go Getter': 'Go Getters',
  'The Wilkerson': 'The Wilkerson Co',
  'Wilkerson Co': 'The Wilkerson Co',
  'The wilkerson company': 'The Wilkerson Co',
  'RC Hauling & Dump': 'RC Hauling',
  // Overlap ("International…Truck") is strong and the blast radius is a label;
  // noted as a judgment call in the decision note.
  'international use truck': 'USC International Truck',
  'Oakland Hpusing': 'Oakland Housing', // corrected source created by this script
};

/** Queue names rejected outright, with reason. */
const REJECT: Record<string, string> = {
  'DR3 Woodland':
    'The facility itself is not an inbound source — MRC data artifact. Revisit only if it recurs meaningfully.',
};

/** Sources this script creates directly (corrected spellings), then aliases. */
const CORRECTED_CREATES: Record<string, true> = { 'Oakland Housing': true };

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const site = await prisma.site.findFirst({ where: { code: 'woodland' }, select: { id: true } });
  if (!site) throw new Error('woodland not found');

  const pending = await prisma.mymrcReconciliationQueue.findMany({
    where: { status: { in: ['pending', 'snoozed'] } },
    select: { id: true, change_kind: true, mymrc_value: true },
    orderBy: { created_at: 'asc' },
  });
  const existing = await prisma.source.findMany({
    where: { site_id: site.id },
    select: { id: true, name: true, aliases: { select: { alias: true } } },
  });
  const byNorm = new Map<string, { id: string; name: string }>();
  for (const s of existing) {
    for (const a of s.aliases) byNorm.set(norm(a.alias), { id: s.id, name: s.name });
  }
  for (const s of existing) byNorm.set(norm(s.name), { id: s.id, name: s.name }); // canonical wins

  const summary = { approved: 0, aliased: 0, rejected: 0, alreadyResolvable: 0 };

  async function createAlias(alias: string, canonicalName: string, note: string): Promise<void> {
    const canonical = byNorm.get(norm(canonicalName));
    if (!canonical)
      throw new Error(`canonical source missing for alias "${alias}" → "${canonicalName}"`);
    if (byNorm.has(norm(alias))) return; // already resolvable
    if (!apply) {
      console.log(`  would create alias "${alias}" → ${canonical.name}`);
      return;
    }
    const row = await prisma.sourceAlias.create({ data: { source_id: canonical.id, alias } });
    byNorm.set(norm(alias), canonical);
    await prisma.auditLog.create({
      data: {
        actor_user_id: BILL_USER_ID,
        actor_label: null,
        action: 'insert',
        table_name: 'source_aliases',
        row_id: row.id,
        after: { source_id: canonical.id, alias, note },
      },
    });
    summary.aliased += 1;
  }

  // Pass 0 — corrected sources this script owns.
  for (const name of Object.keys(CORRECTED_CREATES)) {
    if (byNorm.has(norm(name))) continue;
    if (!apply) {
      console.log(`would create corrected source "${name}"`);
      byNorm.set(norm(name), { id: 'dry-run-planned', name });
      continue;
    }
    const created = await prisma.source.create({ data: { site_id: site.id, name } });
    byNorm.set(norm(name), { id: created.id, name });
    await prisma.auditLog.create({
      data: {
        actor_user_id: BILL_USER_ID,
        actor_label: null,
        action: 'insert',
        table_name: 'sources',
        row_id: created.id,
        after: { site_id: site.id, name, note: `corrected spelling created ${NOTE_TAG}` },
      },
    });
  }

  // Pass 1 — canonicals & standalones (everything not a variant and not a reject).
  for (const item of pending) {
    const name = typeof item.mymrc_value === 'string' ? item.mymrc_value : String(item.mymrc_value);
    if (ALIAS_OF[name] !== undefined || REJECT[name] !== undefined) continue;

    const resolvable = byNorm.get(norm(name));
    if (resolvable) {
      console.log(`ALREADY RESOLVABLE "${name}" → ${resolvable.name}; rejecting queue item`);
      if (apply) {
        await applyReconcileDecision({
          prisma,
          id: item.id,
          decision: 'rejected',
          actorUserId: BILL_USER_ID,
          note: `Already resolvable to source "${resolvable.name}" (normalized match) — no create needed. ${NOTE_TAG}`,
        });
      }
      summary.alreadyResolvable += 1;
      continue;
    }
    console.log(`APPROVE "${name}"`);
    if (apply) {
      const res = await applyReconcileDecision({
        prisma,
        id: item.id,
        decision: 'approved',
        actorUserId: BILL_USER_ID,
        note: `Real collection source, canonical spelling. ${NOTE_TAG}`,
      });
      if (res.applied) byNorm.set(norm(name), { id: res.applied.rowId, name });
    } else {
      byNorm.set(norm(name), { id: 'dry-run-planned', name }); // so pass 2 can plan aliases
    }
    summary.approved += 1;
  }

  // Pass 2 — variants: reject + alias to canonical.
  for (const item of pending) {
    const name = typeof item.mymrc_value === 'string' ? item.mymrc_value : String(item.mymrc_value);
    const canonicalName = ALIAS_OF[name];
    if (canonicalName === undefined) continue;
    console.log(`VARIANT "${name}" → alias of "${canonicalName}"; rejecting queue item`);
    await createAlias(name, canonicalName, `variant spelling of "${canonicalName}" ${NOTE_TAG}`);
    if (apply) {
      await applyReconcileDecision({
        prisma,
        id: item.id,
        decision: 'rejected',
        actorUserId: BILL_USER_ID,
        note: `Variant spelling — aliased to canonical source "${canonicalName}" instead of creating a duplicate. ${NOTE_TAG}`,
      });
    }
    summary.rejected += 1;
  }

  // Pass 3 — outright rejects.
  for (const item of pending) {
    const name = typeof item.mymrc_value === 'string' ? item.mymrc_value : String(item.mymrc_value);
    const reason = REJECT[name];
    if (reason === undefined) continue;
    console.log(`REJECT "${name}" — ${reason}`);
    if (apply) {
      await applyReconcileDecision({
        prisma,
        id: item.id,
        decision: 'rejected',
        actorUserId: BILL_USER_ID,
        note: `${reason} ${NOTE_TAG}`,
      });
    }
    summary.rejected += 1;
  }

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}:`, JSON.stringify(summary));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
