// ADR-0082 — the load claim, and the self-serve takeover that keeps it honest.
//
// ## What already existed, and what was actually broken
//
// `inbound_loads.assigned_operator_id` / `assigned_at` have been written since
// `startInboundLoad` shipped: starting a load ALREADY claims it. So this module
// is not a new claim mechanism. It is the three things missing around one that
// was already there — an atomic write, a way to hand it on, and a surface that
// says who holds it.
//
// JT: *"Whoever started the load has to be the one to close the load … need to
// keep it open to somebody to close it in case 1st driver goes to lunch."* The
// first half was already enforced, to the letter and past the point of use:
// `assertOwn` in `load-service.ts` refuses every stage action from anyone but
// the assignee, and `load/[id]/page.tsx` REDIRECTED a non-assignee back to the
// queue with no message. So the second operator's experience was a silent loop —
// tap the load, land on the queue, tap the load, land on the queue — with the
// holder's name displayed nowhere on the device. Nothing failed; nothing said
// anything. A load whose operator goes to lunch is stranded until they come
// back, and if they do not come back that day it is stranded until a manager
// intervenes.
//
// Measured in production 2026-08-08 (`dr3_vision` on svdp-dev): **nine open dock
// loads across five different operators**, the oldest claimed 2026-07-28 —
// eleven days — and one sitting at `finished`, meaning its units are counted and
// have never reached billing. Every one of those is reachable ONLY by the
// operator whose name is on it.
//
// A second measurement is worth stating because it is the kind of number that
// lies if you quote it without its cause: across the 40 submitted loads,
// `submitted_by_id <> assigned_operator_id` **zero times**. That is not evidence
// that handoffs do not happen on the floor. It is evidence that the software
// made them impossible to record — `assertOwn` refuses the submit, so the closer
// could only ever be the claimer. After this ADR that column starts being able
// to disagree with the claim, which is the point: it becomes a measurement
// rather than a tautology.
//
// ## The two atomicity guarantees, and the mechanism behind each
//
// Neither is "wrap it in a transaction and hope". A transaction alone buys
// nothing here — Postgres runs READ COMMITTED (Prisma's default and ours), so
// two concurrent transactions BOTH read the pre-state and both proceed. The
// serialisation has to come from a specific database behaviour, named:
//
// 1. **Claiming (`startInboundLoad`)** is serialised by the UNIQUE INDEX on
//    `inbound_loads.expected_load_id`. Two operators tapping the same queue row
//    at the same instant both find no child load and both insert; the index
//    blocks the second until the first commits, then refuses it with P2002. The
//    in-transaction re-read closes the (far more common) SEQUENTIAL window where
//    A committed seconds ago and B's queue page has not re-rendered; the P2002
//    branch closes the genuinely concurrent one. Both are needed and neither is
//    decorative — see `load-service.ts`.
//
// 2. **Takeover** is serialised by Postgres's UPDATE re-check. The re-stamp is a
//    COMPARE-AND-SWAP: `WHERE id = ? AND assigned_operator_id = <the holder I
//    read>`. When two takers race, the second UPDATE blocks on the row lock and
//    then re-evaluates its WHERE against the newly committed version, matches
//    zero rows, and is refused. An unconditional `UPDATE … SET
//    assigned_operator_id = me` would let both "succeed" and would write TWO
//    audit rows each claiming to have taken the load from A — a false history in
//    an append-only table, which is CLAUDE.md hard rule #6 and the exact failure
//    the `mergeEquipment` actor-context work exists to prevent.
//
// ## Honesty rules this module holds to
//
// - The actor on a takeover audit row is the PERSON WHO TOOK IT. Never a system
//   label — a human pressed the button, and `actor_label` is reserved for actors
//   with no `users.id` behind them (`admin-equipment.ts`).
// - Taking over a load you ALREADY hold writes nothing. Re-stamping `assigned_at`
//   for the current holder would move their claim time for an action that changed
//   nothing, and would put an A→A row in the audit log that reads like a handoff.
// - The previous claim is never overwritten out of existence: `before` carries
//   the outgoing operator id and their `assigned_at`, so the whole chain of
//   custody is reconstructible from `audit_log` even though the row itself only
//   holds the current holder.

import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { withIdempotency } from '@/lib/idempotency';
import { LoadAccessError } from '@/lib/load-service';
import { OPEN_DOCK_STATUSES } from '@/lib/loads/open-loads';

/**
 * The statuses a claim may be taken over in — deliberately the SAME set as
 * {@link OPEN_DOCK_STATUSES}, imported rather than restated so the two can never
 * drift apart.
 *
 * Why the whole open set and not just `in_progress`: the lunch case does not
 * care which stage the load is at. An operator can walk away between the BOL
 * photo and the weight ticket exactly as easily as mid-count. And `finished` —
 * counted, one tap from submission, not yet submitted — is the WORST one to
 * leave stranded, because its units are already measured and have not reached
 * inventory or billing. Production is holding one of those right now.
 *
 * Everything outside the set is excluded on purpose: `submitted`, `verified`,
 * `rejected`, `submitted_to_mymrc` and `processed` have left the floor's hands,
 * and re-pointing the operator on a load a manager is verifying is a manager
 * action (T-010 / ADR-0073), not a floor one. `expected` is the `InboundLoad`
 * model default carried by aggregate/bridge rows, never a dock capture.
 */
export const TAKEOVER_STATUSES = OPEN_DOCK_STATUSES;

/** What the caller learns about a claim it did not make. */
export interface ClaimHolder {
  userId: string;
  name: string;
}

export interface TakeoverResult {
  loadId: string;
  /** The operator the claim was taken FROM, or null for an unassigned row. */
  previousHolder: ClaimHolder | null;
  /**
   * False when the caller already held the load and nothing was written. The
   * caller is not "in an error state" — they are already the closer — but no
   * audit row was created and `assigned_at` was not moved.
   */
  restamped: boolean;
}

/**
 * Who holds this load right now — a cheap read, for answering ONE question:
 * "did the claim move out from under me?"
 *
 * ## The displaced-claimer problem this exists for
 *
 * `assertOwn` refuses every stage action from a non-assignee with a 403
 * `load_not_assigned_to_operator`. Before ADR-0082 that 403 was unreachable in
 * practice, because the claim never moved. Takeover makes it reachable and, worse,
 * makes it ROUTINE: A goes to lunch, B takes the load over, A comes back to an
 * iPad still showing the counting screen and taps +1.
 *
 * What A saw at that moment was an error banner carrying Next's PRODUCTION
 * REDACTION — a server action's throw reaches the client with its message
 * replaced, so the reason is not merely unhelpful, it is structurally
 * unavailable. That is the same silence this ADR removes at the page level,
 * one level down, and it would have arrived as a side effect of the feature.
 *
 * So the client re-asks this question on any non-offline stage failure. If the
 * claim moved, the page is refreshed and the held-by panel names B. If it did
 * not, nothing is touched and the real error keeps its banner — a blanket
 * refresh would have swallowed genuine save failures, which is a worse trade
 * than the one it fixes.
 *
 * @returns null when the load does not exist or is not at this site — the caller
 *          treats that as "not mine", which is correct: an operator holding a
 *          claim on a load they cannot see is not a state to keep them in.
 */
export async function readClaimHolder(args: {
  loadId: string;
  siteId: string;
}): Promise<ClaimHolder | null> {
  const load = await prisma.inboundLoad.findUnique({
    where: { id: args.loadId },
    select: { site_id: true, assigned_operator: { select: { id: true, name: true } } },
  });
  if (!load || load.site_id !== args.siteId || !load.assigned_operator) return null;
  return { userId: load.assigned_operator.id, name: load.assigned_operator.name };
}

/**
 * Hand the claim on a still-open dock load to the operator making the request.
 *
 * Self-serve by Bill's decision (2026-08-07): no manager approval, because the
 * approval step IS the stranding — a load whose operator went to lunch must not
 * wait on someone finding a manager.
 *
 * @throws LoadAccessError 404 `load_not_found`
 * @throws LoadAccessError 403 `load_not_at_this_site`
 * @throws LoadAccessError 403 `taker_not_active_operator_at_site`
 * @throws LoadAccessError 409 `load_not_a_dock_capture`
 * @throws LoadAccessError 409 `load_not_open_on_the_dock`
 * @throws LoadAccessError 409 `load_claim_moved` — someone else took it first
 */
export async function takeOverLoad(args: {
  loadId: string;
  /** The TAKER. Never read from a payload — `ctx()` derives it from the session. */
  operatorUserId: string;
  siteId: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Present ⇒ a double-tap re-stamps once and audits once. */
  idempotencyKey?: string | null;
}): Promise<TakeoverResult> {
  return prisma.$transaction(async (tx) => {
    // Re-read INSIDE the transaction. Anything read before it opened is a
    // statement about the past (`idempotency.ts`: "a guard that reads outside
    // the transaction it is guarding is not a guard, it is a race with better
    // manners").
    const load = await tx.inboundLoad.findUnique({
      where: { id: args.loadId },
      select: {
        id: true,
        site_id: true,
        status: true,
        load_source_type: true,
        assigned_operator_id: true,
        assigned_at: true,
        assigned_operator: { select: { id: true, name: true } },
      },
    });
    if (!load) throw new LoadAccessError(404, 'load_not_found');
    if (load.site_id !== args.siteId) {
      // Eugene and Woodland are strictly separated (CLAUDE.md hard rule #2). An
      // operator at one site can never take a claim at the other, and the 403
      // here is the same refusal `assertOwn` gives, for the same reason.
      throw new LoadAccessError(403, 'load_not_at_this_site');
    }
    if (load.load_source_type !== 'b2b_haul') {
      // Aggregate rows (`paper_bulk`, `mymrc_haul`, `ipad_floor`, `event`) are
      // synthesized day-level records, not dock captures — nobody stood at a
      // door and counted them, so there is no claim to hand on. Today every one
      // of them is `verified` and would fail the status gate anyway; this
      // refuses them STRUCTURALLY so a future path that leaves one at `arrived`
      // cannot make an aggregate row takeoverable by accident.
      throw new LoadAccessError(409, 'load_not_a_dock_capture');
    }
    if (!TAKEOVER_STATUSES.includes(load.status)) {
      throw new LoadAccessError(409, 'load_not_open_on_the_dock');
    }

    // Already mine ⇒ nothing to write. See the module header.
    if (load.assigned_operator_id === args.operatorUserId) {
      return { loadId: load.id, previousHolder: null, restamped: false };
    }

    // The taker must be an ACTIVE operator at THIS site. `auth.ts` already
    // refuses an inactive user at sign-in and revokes mid-session, so this is
    // defence in depth rather than the only gate — but a claim is the record of
    // who is answerable for a load, and writing a deactivated or cross-site name
    // into it would make that record wrong at exactly the moment it matters.
    const taker = await tx.user.findUnique({
      where: { id: args.operatorUserId },
      select: {
        id: true,
        name: true,
        role: true,
        is_active: true,
        deleted_at: true,
        primary_site_id: true,
      },
    });
    if (
      !taker ||
      taker.role !== 'operator' ||
      !taker.is_active ||
      taker.deleted_at !== null ||
      taker.primary_site_id !== args.siteId
    ) {
      throw new LoadAccessError(403, 'taker_not_active_operator_at_site');
    }

    const previousHolder: ClaimHolder | null = load.assigned_operator
      ? { userId: load.assigned_operator.id, name: load.assigned_operator.name }
      : null;

    const outcome = await withIdempotency(
      {
        key: args.idempotencyKey ?? null,
        scope: 'operator.load.takeover',
        actorUserId: args.operatorUserId,
        siteId: args.siteId,
        payload: {
          loadId: args.loadId,
          fromOperatorId: load.assigned_operator_id,
          toOperatorId: args.operatorUserId,
        },
        tx,
        statusCode: 200,
      },
      async () => {
        const now = new Date();

        // ── THE COMPARE-AND-SWAP ────────────────────────────────────────────
        // `assigned_operator_id` in the WHERE is the load-bearing clause, not a
        // redundant restatement of the row we just read. Drop it and two
        // concurrent takeovers both report success and both audit "taken from
        // A". `updateMany` rather than `update` because Prisma's `update`
        // accepts only a unique selector, and the whole point is a NON-unique
        // predicate over the state we are swapping out of.
        const swapped = await tx.inboundLoad.updateMany({
          where: {
            id: args.loadId,
            assigned_operator_id: load.assigned_operator_id,
            status: { in: [...TAKEOVER_STATUSES] },
          },
          data: { assigned_operator_id: args.operatorUserId, assigned_at: now },
        });
        if (swapped.count === 0) {
          // Somebody moved the claim between our read and our write. Name who
          // holds it now: "someone else got there first" with no name is the
          // same dead end this ADR is removing, one level down.
          const current = await tx.inboundLoad.findUnique({
            where: { id: args.loadId },
            select: { status: true, assigned_operator: { select: { name: true } } },
          });
          throw new LoadAccessError(
            409,
            `load_claim_moved:${current?.assigned_operator?.name ?? 'unknown'}`,
          );
        }

        // Audit INSIDE the transaction (`audit.ts` `{ tx }`). `load-service.ts`
        // historically wrote its audit rows AFTER the update on the global
        // client, which leaves a window where the claim moved and no row records
        // it; a claim with no audit row is precisely the "silent overwrite" the
        // handoff forbids. Not copied here.
        await writeAudit(
          {
            actor_user_id: args.operatorUserId, // the PERSON. Never a system label.
            action: 'update',
            table_name: 'inbound_loads',
            row_id: args.loadId,
            before: {
              assigned_operator_id: load.assigned_operator_id,
              assigned_at: load.assigned_at,
              status: load.status,
            },
            after: {
              assigned_operator_id: args.operatorUserId,
              assigned_at: now,
              status: load.status,
              reason: 'takeover (ADR-0082)',
            },
            ip: args.ip ?? null,
            user_agent: args.userAgent ?? null,
          },
          { tx },
        );

        return { loadId: args.loadId, previousHolder, restamped: true };
      },
    );

    return outcome.body;
  });
}
