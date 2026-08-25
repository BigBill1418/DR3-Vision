// ADR-0126 — "decided, but nobody was told."
//
// ── The incident ────────────────────────────────────────────────────────────
// Two rejections (2026-07-31 and 2026-08-19) were decided in Vision, the decision
// mail was REFUSED by the transport as oversize, and `decision_mail_sent_at` was
// therefore never stamped. Accounting never received either notice. Nothing
// anywhere swept for that state, so both sat silent for weeks — one of them for
// nineteen days — and were found by a human reading rows, not by the system.
//
// ADR-0114 (upload-session transport) closed the CAUSE of those two. This module
// exists because the cause was never the durable problem: `sendDecisionEmail` has
// at least five ways to return without stamping (no recipients, oversize refusal,
// transport failure, M365 disabled/creds unresolved, or a crash between the decide
// commit and the send), and EVERY one of them is invisible in exactly the same
// way. Fixing the fifth cause would leave four. So the detection is built on the
// STATE — decided with no mail stamp — which is true regardless of which path
// produced it, including paths that do not exist yet.
//
// ── One predicate, two readers (the point of this file) ─────────────────────
// The 06:00 digest sweep and the AP queue's list badge must agree on what
// "decided but unmailed" MEANS. Two copies of that rule drift, and a badge that
// disagrees with the alarm teaches operators to trust neither. So the rule lives
// here once and both import it.

import type { $Enums, Prisma, PrismaClient } from '@prisma/client';

/**
 * The statuses that OWE accounting an email. A decision is terminal — these are
 * the only two states in which a decision notice was supposed to go out.
 *
 * Deliberately NOT `pending_second_approval`: a >= $1,000 first approval sends no
 * decision mail by design (ADR-0046 D-M5-3 — the notice goes out when the SECOND
 * signature lands), so including it would report every in-flight dual approval as
 * a failure and the sweep would be noise from its first run.
 */
export const DECIDED_STATUSES = [
  'approved',
  'rejected',
] as const satisfies readonly $Enums.ApRequestStatus[];

/**
 * How long a decided row is allowed to sit unstamped before the sweep counts it.
 *
 * This is an ANTI-RACE grace, nothing more. `sendDecisionEmail` stamps
 * `decision_mail_sent_at` only after the transport reports delivery, and stamping
 * a large attachment can take tens of seconds; a sweep with no grace would page
 * for a send that is still in flight. Twenty minutes is far longer than any
 * observed send and far shorter than the daily digest cadence, so it costs no
 * detection latency at all — the sweep runs once a day either way.
 */
export const DECISION_MAIL_GRACE_MS = 20 * 60 * 1000;

/**
 * Is this row decided with no evidence its notice ever went out?
 *
 * NO GRACE PERIOD HERE, deliberately — see {@link isDecisionMailStuck} for the
 * grace-applied variant. The two callers want genuinely different things:
 *
 *   - The QUEUE BADGE wants this bare predicate. It is a passive visual on a row
 *     an operator is already looking at, and the decide path awaits the send, so
 *     by the time the list re-renders the stamp is either set or the send really
 *     did fail. Applying a grace here would HIDE a real failure for twenty
 *     minutes from the one person positioned to act on it immediately.
 *   - The SWEEP wants the grace, because it pages.
 */
export function isDecisionMailUnsent(row: {
  status: string;
  decision_mail_sent_at: Date | null;
}): boolean {
  return (
    (DECIDED_STATUSES as readonly string[]).includes(row.status) &&
    row.decision_mail_sent_at === null
  );
}

/**
 * The sweep's predicate: unsent AND old enough that no in-flight send explains it.
 *
 * A row with a decided status and a NULL `decided_at` counts as STUCK. That
 * combination should be impossible — the decide path writes both in one update —
 * so it is either a corrupted row or a code path nobody knows about. Either way,
 * "we cannot tell when this was decided" is a thing to surface, not a thing to
 * quietly exclude. Treating an unreadable timestamp as "not old enough yet" would
 * make the row permanently invisible to the one check built to find it, which is
 * the same shape of silence this ADR exists to end.
 */
export function isDecisionMailStuck(
  row: { status: string; decided_at: Date | null; decision_mail_sent_at: Date | null },
  now: Date,
): boolean {
  if (!isDecisionMailUnsent(row)) return false;
  if (row.decided_at === null) return true;
  return now.getTime() - row.decided_at.getTime() >= DECISION_MAIL_GRACE_MS;
}

/**
 * The Prisma `where` for the coarse read. The grace filter is applied in memory by
 * {@link isDecisionMailStuck} rather than pushed into the query, so the NULL
 * `decided_at` case above stays visible — a `decided_at: { lte: cutoff }` clause
 * would silently drop exactly those rows.
 */
export function decisionMailUnsentWhere(): Prisma.ApRequestWhereInput {
  return { status: { in: [...DECIDED_STATUSES] }, decision_mail_sent_at: null };
}

/**
 * Count decided-but-unmailed rows without loading them (the queue tab badge).
 * Uses the bare predicate — the tab counts what the row badges show.
 */
export async function countDecisionMailUnsent(prisma: PrismaClient): Promise<number> {
  return prisma.apRequest.count({ where: decisionMailUnsentWhere() });
}

/**
 * The ntfy dedup key for a set of stuck requests (ADR-0037 §3).
 *
 * Derived from the SORTED SET OF IDS, which is the property that makes this a real
 * dedup key rather than a decorative one: the same stuck rows produce the same
 * fingerprint on every run and stay suppressed under the cooldown, while a NEW
 * stuck row changes the key and pages immediately instead of hiding behind the
 * previous alert's cooldown window. A per-run id (a timestamp, the digest day)
 * would defeat suppression entirely and page daily forever; a constant key would
 * swallow a genuinely new failure for the length of the cooldown.
 */
export function decisionMailStuckFingerprint(requestIds: readonly string[]): string {
  return `ap-decision-mail-unsent:${[...requestIds].sort().join(',')}`;
}
