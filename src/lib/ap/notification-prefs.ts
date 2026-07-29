// ADR-0066 §1.6 — per-user, per-event AP notification scoping.
//
// Generalizes what would otherwise be a hardcoded "don't email Shannon" exception.
// She does not work the daily queue and was buried in new-invoice noise for a
// queue she has no role in; the rule that fixes her case is the same rule everyone
// else should be governed by.
//
// Event semantics (§1.6), precisely:
//
//   new_invoice             → every user with the pref on. A broadcast to the
//                             working queue, and the only genuine broadcast here.
//   second_approval_request → ONLY the individual the request routed to (plus the
//                             fallback approver once escalated). NEVER a broadcast:
//                             even with the pref ON, a user is notified solely for
//                             requests routed to THEM. The pref can only REMOVE
//                             someone from their own routed request, never add
//                             them to somebody else's.
//   daily_digest            → Bill only (§1.7).
//   decision_outcome        → NOBODY. Ships as a column with everyone false, for
//                             future flexibility. Bill: "they don't need to know,
//                             it's done."
//
// These filter WITHIN the ADR-0047 `notifyStaff()` chokepoint and the `ap_notify`
// rollout gate. They never bypass either — a pref cannot promote a pilot-gated
// surface to live.
//
// MISSING ROW = DEFAULTS. A user with no prefs row takes the column defaults
// (new_invoice on, second_approval on, digest off, outcome off) rather than being
// silently excluded. Defaulting a missing row to "notify nobody" would recreate
// the silent-drop failure this ADR exists to remove.

import type { PrismaClient } from '@prisma/client';
import type { ResolvedRecipient } from './second-approval-resolver';

export type ApNotificationEvent =
  | 'new_invoice'
  | 'second_approval_request'
  | 'daily_digest'
  | 'decision_outcome';

const PREF_COLUMN: Record<ApNotificationEvent, string> = {
  new_invoice: 'notify_new_invoice',
  second_approval_request: 'notify_second_approval_request',
  daily_digest: 'notify_daily_digest',
  decision_outcome: 'notify_decision_outcome',
};

/** Column defaults, applied when a user has no prefs row at all. */
const DEFAULTS: Record<ApNotificationEvent, boolean> = {
  new_invoice: true,
  second_approval_request: true,
  daily_digest: false,
  decision_outcome: false,
};

/**
 * Does this user want this event? A missing row yields the column default (see
 * the MISSING ROW note above).
 */
export async function wantsEvent(
  prisma: PrismaClient,
  userId: string,
  event: ApNotificationEvent,
): Promise<boolean> {
  const row = await prisma.apNotificationPref.findFirst({
    where: { user_id: userId },
    select: {
      notify_new_invoice: true,
      notify_second_approval_request: true,
      notify_daily_digest: true,
      notify_decision_outcome: true,
    },
  });
  if (!row) return DEFAULTS[event];
  const col = PREF_COLUMN[event] as keyof typeof row;
  const v = row[col];
  return typeof v === 'boolean' ? v : DEFAULTS[event];
}

/**
 * Filter an already-ROUTED recipient list by each person's own
 * `second_approval_request` pref.
 *
 * Note the ordering, which is the safety property: routing decides WHO, the pref
 * can only subtract. Applying the pref as a *selector* over all users would turn
 * a targeted request into a broadcast — explicitly forbidden by the §6 DO-NOT
 * list ("Do NOT broadcast second_approval_request").
 */
export async function filterBySecondApprovalPref(
  prisma: PrismaClient,
  recipients: readonly ResolvedRecipient[],
): Promise<ResolvedRecipient[]> {
  const out: ResolvedRecipient[] = [];
  for (const r of recipients) {
    if (await wantsEvent(prisma, r.userId, 'second_approval_request')) out.push(r);
  }
  return out;
}

/**
 * The users who should receive a `new_invoice` broadcast — the one event that IS
 * a broadcast. Approver roles only; a missing prefs row means "yes" per DEFAULTS.
 */
export async function newInvoiceRecipients(
  prisma: PrismaClient,
): Promise<{ userId: string; email: string; name: string }[]> {
  const users = await prisma.user.findMany({
    where: {
      is_active: true,
      deleted_at: null,
      role: { in: ['manager', 'admin'] },
      email: { not: null },
    },
    select: { id: true, name: true, email: true },
  });
  const out: { userId: string; email: string; name: string }[] = [];
  for (const u of users) {
    if (!u.email) continue;
    if (await wantsEvent(prisma, u.id, 'new_invoice')) {
      out.push({ userId: u.id, email: u.email, name: u.name });
    }
  }
  return out;
}

/** The digest audience (§1.7 — Bill only, by pref rather than by hardcoded name). */
export async function dailyDigestRecipients(
  prisma: PrismaClient,
): Promise<{ userId: string; email: string; name: string }[]> {
  const rows = await prisma.apNotificationPref.findMany({
    where: { notify_daily_digest: true },
    select: { user_id: true },
  });
  if (rows.length === 0) return [];
  const users = await prisma.user.findMany({
    where: {
      id: { in: rows.map((r) => r.user_id) },
      is_active: true,
      deleted_at: null,
      email: { not: null },
    },
    select: { id: true, name: true, email: true },
  });
  return users
    .filter((u): u is typeof u & { email: string } => !!u.email)
    .map((u) => ({ userId: u.id, email: u.email, name: u.name }));
}
