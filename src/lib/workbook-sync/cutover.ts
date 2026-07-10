// ADR-0049 D7 — the cutover orchestrator for the dedicated /admin/workbook-sync
// control. Applies the parity SOFT-gate on top of the shared rollout flip (which
// itself fires the R2 archival for a `workbook_sync` surface — see notify/flip.ts).
//
// Soft-gate: if Rick's parity signoff is absent, the cutover is REFUSED unless the
// caller passes `overrideNoParity` (the UI warns + collects an override note). The
// flip's own criteria note remains mandatory.

import { prisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { flipRolloutSurface, RolloutFlipError } from '@/lib/notify/flip';
import { hasParitySignoff } from './parity-signoff';
import { WORKBOOK_SYNC_SURFACE } from './surface';

export class CutoverError extends Error {
  readonly status: number;
  constructor(
    readonly reason: 'source_not_found' | 'surface_not_found' | 'parity_signoff_required',
    status: number,
  ) {
    super(`cutover error: ${reason}`);
    this.name = 'CutoverError';
    this.status = status;
  }
}

export interface CutoverArgs {
  siteId: string;
  actorUserId: string;
  criteriaNote: string;
  /** When true, proceed despite a missing parity signoff (UI-collected override). */
  overrideNoParity?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  db?: PrismaClient;
}

export interface CutoverResult {
  siteId: string;
  paritySignoffPresent: boolean;
  overrodeParity: boolean;
}

export async function cutoverWorkbookSync(args: CutoverArgs): Promise<CutoverResult> {
  const db = args.db ?? prisma;

  const surface = await db.rolloutSurface.findUnique({
    where: { surface_code_site_id: { surface_code: WORKBOOK_SYNC_SURFACE, site_id: args.siteId } },
    select: { id: true },
  });
  if (!surface) throw new CutoverError('surface_not_found', 404);

  const parity = await hasParitySignoff(args.siteId, db);
  if (!parity && !args.overrideNoParity) throw new CutoverError('parity_signoff_required', 409);

  try {
    await flipRolloutSurface({
      surfaceId: surface.id,
      toState: 'live',
      criteriaNote: args.criteriaNote,
      actorUserId: args.actorUserId,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
      db,
    });
  } catch (e) {
    if (e instanceof RolloutFlipError) throw new CutoverError('surface_not_found', e.status);
    throw e;
  }

  // Belt: also stop the source itself. The engine's per-poll rollout check is
  // the primary guard, but a cut-over site must not depend on a single runtime
  // read — flipping is_syncing=false makes the stop durable state on the
  // source row (the engine no-ops disabled sources before any rollout read).
  await db.workbookSource.updateMany({
    where: { site_id: args.siteId },
    data: { is_syncing: false },
  });

  return { siteId: args.siteId, paritySignoffPresent: parity, overrodeParity: !parity };
}
