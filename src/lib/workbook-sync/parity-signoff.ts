// ADR-0049 D7 — Rick's parity signoff (cutover SOFT-gate).
//
// The cutover flip is soft-gated on Rick's parity signoff: the UI warns when it is
// absent but allows an override with a note. The signoff is recorded as an
// append-only `audit_log` marker (table `workbook_sync_parity_signoff`, row =
// site_id) — no new table, and it inherits the indefinite audit retention. The
// engine/cutover only READS presence; recording is an explicit admin action.

import { prisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';

const SIGNOFF_TABLE = 'workbook_sync_parity_signoff';

/** True when a parity signoff marker exists for the site (D7 soft-gate READ). */
export async function hasParitySignoff(
  siteId: string,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const row = await db.auditLog.findFirst({
    where: { table_name: SIGNOFF_TABLE, row_id: siteId, action: 'restore' },
    select: { id: true },
  });
  return row !== null;
}

/** Record Rick's parity signoff for a site (append-only audit marker). */
export async function recordParitySignoff(args: {
  siteId: string;
  actorUserId: string;
  note: string;
  db?: PrismaClient;
}): Promise<void> {
  const db = args.db ?? prisma;
  await db.auditLog.create({
    data: {
      actor_user_id: args.actorUserId,
      action: 'restore', // marker action — "parity accepted / signed off"
      table_name: SIGNOFF_TABLE,
      row_id: args.siteId,
      after: { signed_off: true, note: args.note.slice(0, 500) },
    },
  });
}
