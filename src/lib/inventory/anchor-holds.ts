// ADR-0072 — held counts: create, release, discard.
//
// A Tier 2 count (swing over the site's threshold) is not rejected and is not
// written. It is HELD, with the entered values intact, until a manager releases
// it or someone explicitly discards it. It is never silently dropped and never
// auto-writes — an operator who counted 1,200 when the floor says 2,483 has
// either found a real problem or fat-fingered a digit, and both deserve a person
// looking, not a timeout.
//
// ── Two release paths, one rule ─────────────────────────────────────────────
// A manager may release on the device with their PIN, or from their own screen
// remotely. Either satisfies the gate; the path taken is recorded, because "a
// manager approved this" and "a manager approved this while standing at the
// iPad" are different facts six months later.
//
// The rule neither path can bend: **the operator who entered the count can never
// release it.** That is enforced three times over — here, in the route, and by a
// CHECK constraint in the database — because it is the whole point of the tier.
//
// ── The swing is RECOMPUTED at release ──────────────────────────────────────
// The hold stores the swing that caused it, but approval does not trust it. The
// anchor may have moved between hold and release (another count, a correction),
// and writing a stale figure against a changed baseline is how a guardrail
// becomes theatre. Release recomputes from live state and re-checks the tier.

import type { PrismaClient } from '@prisma/client';
import { verifyPin } from '@/lib/pin-service';
import { reconcilePhysicalCount } from '@/lib/inventory/running-balance';
import { pacificDayISO, pacificMidnightInstantOfDayISO } from '@/lib/time';
import {
  classifyAnchorWrite,
  loadPriorAnchor,
  loadSwingThresholdPct,
  type AnchorClassification,
} from './anchor-guardrail';

export class HoldNotFoundError extends Error {
  override readonly name = 'HoldNotFoundError';
}
/** The operator who entered the count tried to release it themselves. */
export class SelfReleaseRefusedError extends Error {
  override readonly name = 'SelfReleaseRefusedError';
}
export class NotAManagerError extends Error {
  override readonly name = 'NotAManagerError';
}
export class BadPinError extends Error {
  override readonly name = 'BadPinError';
}
export class HoldNotPendingError extends Error {
  override readonly name = 'HoldNotPendingError';
}

export interface HeldCountInput {
  unitsIndoor: number | null;
  unitsTotal: number | null;
  unitsInProcessing: number;
  programUnits: number | null;
  nonProgramUnits: number | null;
  poolAttribution: 'measured' | 'legacy';
}

/** Record a Tier 2 count as pending. Writes nothing to inventory. */
export async function createHold(
  db: PrismaClient,
  args: {
    siteId: string;
    createdBy: string;
    input: HeldCountInput;
    classification: AnchorClassification;
  },
): Promise<{ id: string }> {
  const c = args.classification;
  const hold = await db.inventoryCountHold.create({
    data: {
      site_id: args.siteId,
      units_indoor: args.input.unitsIndoor,
      units_total: args.input.unitsTotal,
      units_in_processing: args.input.unitsInProcessing,
      program_units: args.input.programUnits,
      non_program_units: args.input.nonProgramUnits,
      pool_attribution: args.input.poolAttribution,
      prior_snapshot_id: c.prior?.id ?? null,
      prior_total: c.prior?.total ?? 0,
      new_total: c.newTotal,
      swing_pct: c.swingPct ?? 0,
      threshold_pct: c.thresholdPct,
      status: 'pending',
      created_by: args.createdBy,
    },
    select: { id: true },
  });

  await db.auditLog.create({
    data: {
      actor_user_id: args.createdBy,
      action: 'insert',
      table_name: 'inventory_count_holds',
      row_id: hold.id,
      after: {
        held: true,
        tier: 2,
        prior_snapshot_id: c.prior?.id ?? null,
        prior_total: c.prior?.total ?? null,
        new_total: c.newTotal,
        swing_pct: c.swingPct,
        threshold_pct: c.thresholdPct,
      },
    },
  });

  return hold;
}

/**
 * A user who may release a held count at this site.
 *
 * Managers and admins. Site reach follows the house rule: an admin, or someone
 * with `all_sites`, reaches any site; everyone else only their primary site.
 */
export async function eligibleApprovers(
  db: PrismaClient,
  siteId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db.user.findMany({
    where: {
      is_active: true,
      OR: [
        { role: 'admin' },
        { role: 'manager', all_sites: true },
        { role: 'manager', primary_site_id: siteId },
      ],
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return rows;
}

async function assertEligible(db: PrismaClient, userId: string, siteId: string): Promise<void> {
  const eligible = await eligibleApprovers(db, siteId);
  if (!eligible.some((u) => u.id === userId)) throw new NotAManagerError('not_a_manager');
}

/**
 * Release a held count and write the anchor.
 *
 * `path` is recorded, not trusted — both paths land here and both are subject to
 * the same three checks: the hold is still pending, the approver is eligible, and
 * the approver is not the operator who entered it.
 */
export async function releaseHold(
  db: PrismaClient,
  args: {
    holdId: string;
    approverUserId: string;
    path: 'pin' | 'remote';
    /** Required for the on-device path; verified against `approverUserId`. */
    pin?: string;
  },
): Promise<{ snapshotId: string; classification: AnchorClassification }> {
  const hold = await db.inventoryCountHold.findUnique({ where: { id: args.holdId } });
  if (!hold) throw new HoldNotFoundError('hold_not_found');
  if (hold.status !== 'pending') throw new HoldNotPendingError(`hold_${hold.status}`);

  // The rule the whole tier exists for. Checked BEFORE the PIN so a self-release
  // attempt cannot be used to probe whether a PIN is right.
  if (hold.created_by === args.approverUserId) {
    throw new SelfReleaseRefusedError('operator_cannot_self_release');
  }
  await assertEligible(db, args.approverUserId, hold.site_id);

  if (args.path === 'pin') {
    if (!args.pin) throw new BadPinError('pin_required');
    const res = await verifyPin(args.approverUserId, args.pin);
    if (res.ok !== true) throw new BadPinError('bad_pin');
  }

  // Recompute against LIVE state — the anchor may have moved since the hold.
  const [prior, thresholdPct] = await Promise.all([
    loadPriorAnchor(db, hold.site_id),
    loadSwingThresholdPct(db, hold.site_id),
  ]);
  const newTotal = (hold.units_total ?? hold.units_indoor ?? 0) + hold.units_in_processing;
  const classification = classifyAnchorWrite({ prior, newTotal, thresholdPct });

  // ── ADR-0118 — the release is ONE transaction, and the CAS runs first ───────
  //
  // What this replaces: four sequential writes on the shared client — write the
  // anchor, stamp the hold `approved`, write the audit row — each able to
  // commit while a later one failed, and none of them guarded by the `pending`
  // check made twenty lines above on a row that could change underneath it.
  //
  // Two failures it made reachable, both silent:
  //
  //   1. TWO ANCHORS FROM ONE HOLD. Two managers releasing the same held count
  //      — the on-device PIN path and the remote screen, which is exactly the
  //      pair ADR-0072 built — both read `status === 'pending'`, both called
  //      `reconcilePhysicalCount`, and both wrote a `physical` snapshot. The
  //      second one becomes the anchor (`created_at DESC`, ADR-0078 D1). One
  //      counted event, two anchors, and the hold recording only one of them.
  //   2. AN ANCHOR WITH NO AUDIT ROW. The snapshot committed; a failure in the
  //      stamp or the audit write left it standing, unattributable, with the
  //      hold still `pending` — so the count could be released AGAIN.
  //
  // The order is deliberate and matches `correct-count.ts` `applyCorrection`:
  // the guarded `updateMany` is FIRST and is the concurrency gate. If it matches
  // nothing, somebody else released this hold between our read and here and we
  // abort before writing anything at all — no snapshot, no audit row, no partial
  // release. Only then is the anchor written, on this same transaction.
  const now = new Date();
  const snapshotId = await db.$transaction(async (tx) => {
    const { count } = await tx.inventoryCountHold.updateMany({
      where: { id: hold.id, status: 'pending' },
      data: {
        status: 'approved',
        approved_by: args.approverUserId,
        approved_at: now,
        approval_path: args.path,
      },
    });
    if (count === 0) {
      // Report the state that actually won, the way the pre-transaction check
      // above does, rather than a bare "conflict" the route cannot translate.
      const row = await tx.inventoryCountHold.findUniqueOrThrow({
        where: { id: hold.id },
        select: { status: true },
      });
      throw new HoldNotPendingError(`hold_${row.status}`);
    }

    // ADR-0078 — `reconcilePhysicalCount` takes an OPEN transaction and writes
    // the snapshot and its audit row on it (`running-balance.ts`). Passing `tx`
    // is what binds the anchor to the release: neither can now exist without
    // the other.
    const result = await reconcilePhysicalCount({
      siteId: hold.site_id,
      countedAt: pacificMidnightInstantOfDayISO(pacificDayISO(new Date())),
      physical: {
        units_indoor: hold.units_indoor,
        units_total: hold.units_total,
        units_in_processing: hold.units_in_processing,
      },
      programUnits: hold.program_units === null ? null : Number(hold.program_units),
      nonProgramUnits: hold.non_program_units === null ? null : Number(hold.non_program_units),
      poolAttribution: hold.pool_attribution === 'legacy' ? 'legacy' : 'measured',
      actorUserId: args.approverUserId,
      tx,
    });

    // Written second because the snapshot id does not exist until the line
    // above. Same transaction, so a hold can never be `approved` while pointing
    // at nothing.
    await tx.inventoryCountHold.update({
      where: { id: hold.id },
      data: { resulting_snapshot_id: result.snapshotId },
    });

    // CLAUDE.md hard rule #6 — the audit row commits with the release it
    // describes, or neither does.
    await tx.auditLog.create({
      data: {
        actor_user_id: args.approverUserId,
        action: 'update',
        table_name: 'inventory_count_holds',
        row_id: hold.id,
        after: {
          released: true,
          approval_path: args.path,
          approver_user_id: args.approverUserId,
          operator_user_id: hold.created_by,
          // The swing AS WRITTEN, which may differ from the one that caused the
          // hold if the anchor moved in between.
          prior_snapshot_id: classification.prior?.id ?? null,
          prior_total: classification.prior?.total ?? null,
          new_total: classification.newTotal,
          swing_pct: classification.swingPct,
          threshold_pct: classification.thresholdPct,
          tier: classification.tier,
          resulting_snapshot_id: result.snapshotId,
        },
      },
    });

    return result.snapshotId;
  });

  return { snapshotId, classification };
}

/** Explicitly abandon a held count. Nothing is written to inventory. */
export async function discardHold(
  db: PrismaClient,
  args: { holdId: string; userId: string; reason: string },
): Promise<void> {
  const hold = await db.inventoryCountHold.findUnique({ where: { id: args.holdId } });
  if (!hold) throw new HoldNotFoundError('hold_not_found');
  if (hold.status !== 'pending') throw new HoldNotPendingError(`hold_${hold.status}`);

  await db.inventoryCountHold.update({
    where: { id: hold.id },
    data: {
      status: 'discarded',
      discarded_by: args.userId,
      discarded_at: new Date(),
      discard_reason: args.reason,
    },
  });
  await db.auditLog.create({
    data: {
      actor_user_id: args.userId,
      action: 'update',
      table_name: 'inventory_count_holds',
      row_id: hold.id,
      after: { discarded: true, reason: args.reason },
    },
  });
}
