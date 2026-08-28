// OPEN-ITEMS §0.BQ — BO-4 residue, executed on Bill's per-group calls
// (session of 2026-08-27, ~4:20 PM PT).
//
// Bill's decisions, verbatim from the four grouped questions:
//   1. ALIAS + CLASSIFY five drifted-spelling sources with the workbook's
//      Woodland mileage (South Tahoe 122, Happy Camp 309, Loyalton 153,
//      Scott River 262, Evans 36). The Loyalton "Sanitary Landfill" vs
//      "Transfer Station" drift was accepted: the MyMRC mirror's Woodland
//      hauls land under "Loyalton Transfer Station" for the same account.
//   2. PLEASANTON at 90 mi. The workbook's two copies disagreed (90 vs 8);
//      the 8 matches Pleasanton's own Stockton-Primary distance exactly (a
//      copy artifact) and geography supports ~90. Same $925 tier as the
//      Tertiary row's own rate.
//   3. ALIAS-ONLY three names onto existing sources with NO workbook
//      Woodland mileage (Chester, San Leandro, Woodfords) — resolver and
//      reconciliation hygiene; classification stays false pending mileage.
//   4. Events + Stockton-side names DROPPED (docs record, no writes here);
//      the nine no-mileage flagged sources go to the Rick chase list.
//
// RUN: npx tsx scripts/one-off/2026-08-27-bo4-residue-apply.ts [--apply]
// (DATABASE_URL exported; dry run without --apply.) Idempotent: existing
// aliases and already-classified sources are skipped.

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();
const BILL_EMAIL = 'bill.barnard@svdp.us';
const UA = 'one-off/bo4-residue';

interface Job {
  /** Exact `sources.name` at Woodland. */
  sourceName: string;
  /** Workbook spelling to register as an alias (null = no alias needed). */
  alias: string | null;
  /** Woodland mileage to classify with (null = alias only, no classification). */
  mileage: number | null;
}

const JOBS: Job[] = [
  // ── Group 1: alias + classify ─────────────────────────────────────────────
  {
    sourceName: 'South Tahoe Refuse Co',
    alias: 'South Tahoe Refuse Transfer Station - South Tahoe Refuse Co.',
    mileage: 122,
  },
  {
    sourceName: 'Happy Camp Transfer Station',
    alias: 'Happy Camp Transfer Station - George M. Chambers',
    mileage: 309,
  },
  { sourceName: 'Loyalton Transfer Station', alias: 'Loyalton Sanitary Landfill', mileage: 153 },
  { sourceName: 'Scott River Watershed Council', alias: 'Scott River Watershed', mileage: 262 },
  { sourceName: 'Evans Furniture', alias: "Evans' Furniture", mileage: 36 },
  // ── Group 2: Pleasanton at 90 (source already resolves; no alias needed) ──
  {
    sourceName: 'Pleasanton Garbage Company - Recycling Resource Recovery Systems LLC',
    alias: null,
    mileage: 90,
  },
  // ── Group 3: alias only ───────────────────────────────────────────────────
  { sourceName: 'Chester Transfer Station', alias: 'Chester Tranfer', mileage: null },
  {
    sourceName: 'City of San Leandro - Public Works Department',
    alias: 'City Of San Leandro',
    mileage: null,
  },
  {
    sourceName: 'Washoe Tribe of Nevada and California - Woodfords Fire House',
    alias: 'Woodsfords Washoe Tribe Wellness Center',
    mileage: null,
  },
];

async function main() {
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (no writes) ===');
  const bill = await prisma.user.findFirst({
    where: { email: BILL_EMAIL, deleted_at: null },
    select: { id: true },
  });
  if (!bill) throw new Error('no Bill user row');
  const woodland = await prisma.site.findFirst({
    where: { code: 'woodland' },
    select: { id: true },
  });
  if (!woodland) throw new Error('no woodland site');

  for (const job of JOBS) {
    const src = await prisma.source.findFirst({
      where: { site_id: woodland.id, name: job.sourceName },
      select: { id: true, name: true, is_trans_charge: true, canonical_mileage: true },
    });
    if (!src) throw new Error(`source not found at Woodland: "${job.sourceName}" — refusing`);

    if (job.alias) {
      const existing = await prisma.sourceAlias.findUnique({ where: { alias: job.alias } });
      if (existing && existing.source_id !== src.id) {
        throw new Error(`alias "${job.alias}" already points at a DIFFERENT source — refusing`);
      }
      if (existing) {
        console.log(`[alias] "${job.alias}" already present — skipping.`);
      } else {
        console.log(`[alias] "${job.alias}" → ${src.name}`);
        if (APPLY) {
          await prisma.$transaction(async (tx) => {
            const id = randomUUID();
            await tx.sourceAlias.create({ data: { id, source_id: src.id, alias: job.alias! } });
            await tx.auditLog.create({
              data: {
                actor_user_id: bill.id,
                action: 'insert',
                table_name: 'source_aliases',
                row_id: id,
                after: { source_id: src.id, alias: job.alias },
                ip: null,
                user_agent: UA,
              },
            });
          });
        }
      }
    }

    if (job.mileage !== null) {
      if (src.is_trans_charge && src.canonical_mileage === job.mileage) {
        console.log(`[classify] ${src.name} already at ${job.mileage} mi — skipping.`);
      } else {
        console.log(`[classify] ${src.name} → is_trans_charge=true, ${job.mileage} mi`);
        if (APPLY) {
          await prisma.$transaction(async (tx) => {
            await tx.auditLog.create({
              data: {
                actor_user_id: bill.id,
                action: 'update',
                table_name: 'sources',
                row_id: src.id,
                before: {
                  is_trans_charge: src.is_trans_charge,
                  canonical_mileage: src.canonical_mileage,
                },
                after: { is_trans_charge: true, canonical_mileage: job.mileage },
                ip: null,
                user_agent: UA,
              },
            });
            await tx.source.update({
              where: { id: src.id },
              data: { is_trans_charge: true, canonical_mileage: job.mileage },
            });
          });
        }
      }
    }
  }
  console.log(APPLY ? '=== APPLY complete ===' : '=== DRY RUN complete — re-run with --apply ===');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
