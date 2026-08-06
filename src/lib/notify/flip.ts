// ADR-0047 — the audited rollout-state flip. The ONE place a surface's pilot↔live
// state changes; the admin route and any test drive this. Every flip records the
// criteria evidence (directive §8 standing rule 2) and writes an audit row.

import { prisma } from '@/lib/prisma';
import type { PrismaClient, RolloutState } from '@prisma/client';
import { writeAudit } from '@/lib/audit';

export class RolloutFlipError extends Error {
  readonly status: number;
  constructor(
    readonly reason: 'surface_not_found' | 'criteria_note_required' | 'invalid_state',
    status: number,
  ) {
    super(`rollout flip error: ${reason}`);
    this.name = 'RolloutFlipError';
    this.status = status;
  }
}

/** A criteria note shorter than this is treated as absent (flip is refused). */
export const CRITERIA_NOTE_MIN_LENGTH = 3;

export interface FlipArgs {
  surfaceId: string;
  toState: RolloutState;
  criteriaNote: string;
  actorUserId: string;
  /**
   * ADR-0077 — set INSTEAD of a real `users.id` for a named non-human flip.
   * `flipped_by` is a bare string column, so the label lands there and the audit
   * row carries `actor_label` with `actor_user_id` NULL.
   */
  actorLabel?: string | undefined;
  ip?: string | null;
  userAgent?: string | null;
  db?: PrismaClient;
}

/**
 * Flip a surface to `toState`, recording who/when + the criteria note, audited.
 * A missing criteria note is refused (422) — every ramp must carry its evidence.
 * The change is immediate (directive §6 (d)); rollback is the inverse flip.
 */
export async function flipRolloutSurface(args: FlipArgs) {
  const db = args.db ?? prisma;
  const note = args.criteriaNote?.trim() ?? '';
  if (args.toState !== 'pilot' && args.toState !== 'live')
    throw new RolloutFlipError('invalid_state', 422);
  if (note.length < CRITERIA_NOTE_MIN_LENGTH)
    throw new RolloutFlipError('criteria_note_required', 422);

  const before = await db.rolloutSurface.findUnique({ where: { id: args.surfaceId } });
  if (!before) throw new RolloutFlipError('surface_not_found', 404);

  const updated = await db.rolloutSurface.update({
    where: { id: args.surfaceId },
    data: {
      rollout_state: args.toState,
      flipped_by: args.actorLabel ?? args.actorUserId,
      flipped_at: new Date(),
      criteria_note: note,
    },
  });

  await writeAudit({
    actor_user_id: args.actorLabel ? null : args.actorUserId,
    actor_label: args.actorLabel ?? null,
    action: 'update',
    table_name: 'rollout_surfaces',
    row_id: args.surfaceId,
    before: {
      surface_code: before.surface_code,
      site_id: before.site_id,
      rollout_state: before.rollout_state,
    },
    after: { rollout_state: updated.rollout_state, criteria_note: note },
    ip: args.ip ?? null,
    user_agent: args.userAgent ?? null,
  });

  // ADR-0049 D7/D8 — flipping a `workbook_sync` surface to `live` IS the cutover:
  // it stops sync (the engine no-ops) and fires R2 archival. Runs here so a flip
  // from EITHER /admin/rollout or the dedicated /admin/workbook-sync page archives.
  // Fail-soft + audited: an R2/transport error never fails the flip (the state
  // change is authoritative); the archival outcome is recorded as its own audit row.
  if (before.kind === 'workbook_sync' && args.toState === 'live' && before.site_id) {
    await runCutoverArchival(db, before.site_id, args.actorUserId).catch(() => undefined);
  }

  return updated;
}

/** Best-effort cutover archival + its own audit record (ADR-0049 D8). */
async function runCutoverArchival(
  db: PrismaClient,
  siteId: string,
  actorUserId: string,
): Promise<void> {
  const { archiveWorkbooksToR2 } = await import('@/lib/workbook-sync/archive');
  const site = await db.site.findUnique({ where: { id: siteId }, select: { code: true } });
  const result = await archiveWorkbooksToR2({ db, siteId, siteCode: site?.code ?? siteId });
  await writeAudit({
    actor_user_id: actorUserId,
    action: 'insert',
    table_name: 'workbook_cutover_archival',
    row_id: siteId,
    after: {
      archived_keys: result.archivedKeys,
      files_considered: result.filesConsidered,
      skipped: result.skipped,
      error: result.error,
    },
  });
}
