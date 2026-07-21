// ADR-0046 §3 amendment (handoff §1.6f) — daily AP-approver expiry reaper.
//
// Removes ap_approvers whose `active_until <= now()` (e.g. Kelsey after
// 2026-08-08). The roster resolution (approvers.ts) already excludes expired
// rows, so a DELETE is the clean, idempotent reap — a no-op once the row is
// gone. Each removal is DELETEd inside a $transaction alongside an APPEND-ONLY
// auditLog row (hard rule #6 — audit is written in the same transaction, never
// after; audit rows are never updated/deleted). One ntfy summary fires to the
// Bill-only `dr3-vision-system` topic naming how many expired by user id (never
// PII — no names/emails/body). No-op runs publish nothing.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';

const ACTOR_LABEL = 'system:ap-approver-expiry';

export interface RunApApproverExpiryOpts {
  prisma?: PrismaClient;
  now?: Date;
}

export interface ApApproverExpiryResult {
  expired: number;
  /** User ids of the removed approvers (audit/log evidence — not PII). */
  userIds: string[];
}

/**
 * Reap expired AP approvers. Returns a summary; safe to call repeatedly (a
 * re-run after all expired rows are gone is a clean no-op). Never throws into
 * the caller for a paging failure — the ntfy publish is fail-soft.
 */
export async function runApApproverExpiry(
  opts: RunApApproverExpiryOpts = {},
): Promise<ApApproverExpiryResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();

  const expired = await prisma.apApprover.findMany({
    where: { active_until: { lte: now } },
    select: { id: true, user_id: true, active_until: true },
  });

  if (expired.length === 0) {
    return { expired: 0, userIds: [] };
  }

  const userIds: string[] = [];
  for (const row of expired) {
    // Audit-then-delete inside one transaction (hard rule #6: in-transaction,
    // append-only). The audit row is the durable record of the removal.
    await prisma.$transaction(async (tx) => {
      const t = tx as PrismaClient;
      await t.auditLog.create({
        data: {
          actor_label: ACTOR_LABEL,
          action: 'delete',
          table_name: 'ap_approvers',
          row_id: row.id,
          before: { user_id: row.user_id, active_until: row.active_until?.toISOString() ?? null },
        },
      });
      await t.apApprover.delete({ where: { id: row.id } });
    });
    userIds.push(row.user_id);
  }

  log.info({ expired: userIds.length, userIds }, '[ap-approver-expiry] removed expired approvers');

  await publishNtfy({
    topic: 'dr3-vision-system',
    title: `AP approver expiry — ${userIds.length} removed`,
    body: `Removed ${userIds.length} expired AP approver${userIds.length === 1 ? '' : 's'} (user id${userIds.length === 1 ? '' : 's'}: ${userIds.join(', ')}). The AP approver roster no longer includes them.`,
    priority: 'default',
    tags: ['ap', 'approver-expiry', 'dr3-vision'],
    fingerprint: `ap-approver-expiry:${userIds.slice().sort().join(',')}`,
    cooldownMs: 24 * 60 * 60 * 1000,
  }).catch(() => undefined);

  return { expired: userIds.length, userIds };
}
