// ADR-0092 — the ONE query behind both staleness surfaces.
//
// The manager dashboard badges stale claims continuously; the 16:45 PT scan
// mails about them once. Those are two readers of one fact, and ADR-0091 — one
// week old — is the standing lesson about what happens when two surfaces
// re-derive the same judgement from their own queries: they disagree, and the
// floor believes whichever one it happened to open.
//
// So the query lives here, once, and both callers filter its verdict rather than
// asking their own question. A third surface must come through this function.

import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { OPEN_DOCK_STATUSES } from '@/lib/loads/open-loads';
import { stalenessOf, type StaleLevel } from '@/lib/loads/stale-claim';

export interface OpenClaimStaleness {
  loadId: string;
  haulNumber: string | null;
  sourceName: string | null;
  holderName: string | null;
  status: string;
  idleMs: number;
  level: StaleLevel;
}

/**
 * Every CLAIMED, still-open, non-voided load at the site, each with its
 * staleness verdict. Callers filter by `level` — `stale-claim-scan.ts` takes
 * `nudge`, the dashboard takes anything above `ok`.
 *
 * ## What is deliberately not in the where-clause
 *
 * No predicate on units of any kind. Every stranded load has `total_units =
 * NULL` — it was never finished — so a magnitude filter would go blind on the
 * exact population this exists to find, and `expected_unit_count` was 0 on three
 * of four live slots on 2026-08-11 anyway.
 *
 * No predicate on age either, and that is the subtle one: staleness is computed
 * from CHILD rows the database cannot compare against `now` in a portable
 * `where`, so filtering in SQL by `updated_at` would silently exclude the
 * mid-count loads whose parent row is frozen — the very false-negative/positive
 * pair the verdict function exists to get right. The row count here is small
 * (single digits per site in production) so reading them all and judging in
 * TypeScript is both correct and cheap.
 */
export async function listOpenClaimsWithStaleness(
  siteId: string,
  now: Date = new Date(),
  db: PrismaClient = prisma,
): Promise<OpenClaimStaleness[]> {
  const rows = await db.inboundLoad.findMany({
    where: {
      site_id: siteId,
      // Imported, never restated — `open-loads.ts` owns this set.
      status: { in: [...OPEN_DOCK_STATUSES] },
      voided_at: null,
      // An unclaimed open row is not a strand: nobody walked away from it.
      assigned_operator_id: { not: null },
    },
    select: {
      id: true,
      status: true,
      updated_at: true,
      assigned_operator: { select: { name: true } },
      expected_load: { select: { external_mymrc_haul_id: true, source_name_at_sync: true } },
      // The two child sources that prove work WITHOUT touching the parent row.
      // `addStack` writes only `load_stacks`; the BOL/weight stages write only
      // `load_photos`. Reading `updated_at` alone reports an operator mid-count
      // as abandoned — see `stale-claim.ts`.
      load_stacks: {
        where: { voided_at: null },
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { created_at: true },
      },
      load_photos: {
        orderBy: { uploaded_at: 'desc' },
        take: 1,
        select: { uploaded_at: true },
      },
    },
  });

  return rows.map((l) => {
    const verdict = stalenessOf(
      {
        updatedAt: l.updated_at,
        lastStackAt: l.load_stacks[0]?.created_at ?? null,
        lastPhotoAt: l.load_photos[0]?.uploaded_at ?? null,
      },
      now,
    );
    return {
      loadId: l.id,
      haulNumber: l.expected_load?.external_mymrc_haul_id ?? null,
      sourceName: l.expected_load?.source_name_at_sync ?? null,
      holderName: l.assigned_operator?.name ?? null,
      status: l.status,
      idleMs: verdict.idleMs,
      level: verdict.level,
    };
  });
}
