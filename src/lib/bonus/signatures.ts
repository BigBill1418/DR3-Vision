// T-110 — Signature capture data layer (ADR-0019 §5).
//
// Records one of the two monthly attestation signatures (Janette / Morena) on a
// Woodland `bonus_pay_periods` row and advances the lifecycle via the T-106 state
// machine — the ONLY path that mutates `bonus_pay_periods.state`. The signature
// column write, the audit row, and the state transition all land in ONE
// interactive transaction so a signature can never be captured without its
// audit trail or its state move (CLAUDE.md hard rule #6).
//
// State arithmetic (ADR-0019 §5):
//   pending_signatures  --first signature-->  partially_signed
//   partially_signed    --second signature--> signed
// Signatures may land in either order; this module looks at which slot the
// incoming signature fills and at whether the OTHER slot is already filled to
// decide the target state. A slot that is already signed is rejected (409) — a
// signer cannot re-sign, and the override path cannot stomp an existing
// signature.
//
// SLOT determination (NON-override case — the override case is T-111's job):
//   - Janette slot: the Woodland facility manager (manager, primary_site_id =
//     Woodland site id).
//   - Morena slot:  the both-sites operations manager (manager,
//     primary_site_id = null).
//   - An admin (Bill / Kelsey) signing with NO `onBehalfOf` has no natural
//     slot and is rejected here with a 422 `no_slot` — admin-as-override is
//     T-111, which will pass an explicit `onBehalfOf` slot. The `onBehalfOf`
//     param is the clean seam: it is accepted but NOT yet exposed by the T-110
//     route/UI, so the override semantics (who-may-override-whom, the
//     override_actor_id / override_reason columns) remain entirely T-111's to
//     wire.
//
// Bonus is Woodland-scoped (CLAUDE.md hard rule #2): the month is always
// re-read scoped to the caller's site id; a forged month id for another site
// is treated as not-found.

import type { AuditAction } from '@prisma/client';
import { calculateMonthlyBonusCents } from '@/lib/bonus/calculator';
import { transitionMonth, type BonusPayPeriodState } from '@/lib/bonus/state-machine';
import { entryDateUTC, NoActiveRuleError } from '@/lib/bonus/daily-entry';
import { bonusPayPeriodsByState } from '@/lib/observability/metrics';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/**
 * The two attestation slots on a bonus pay period. Site-neutral per ADR-0019.1
 * §5 so Eugene's chain (Rick/Kelsey) reuses the same slots; the slot value is
 * also the renamed column prefix (`facility_signed_*` / `ops_signed_*`).
 */
export type SignatureSlot = 'facility' | 'ops';

/** Structural type for the prisma/tx client this layer uses. */
export interface SignatureDb {
  bonusPayPeriod: {
    findFirst(args: {
      where: { id: string; site_id: string };
    }): Promise<BonusMonthSignatureRow | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<BonusMonthSignatureRow>;
  };
  bonusDailyEntry: {
    findMany(args: {
      where: { bonus_pay_period_id: string };
    }): Promise<{ mattress_count: number }[]>;
  };
  processorBonusRule: {
    findFirst(args: {
      where: {
        site_id: string;
        effective_date: { lte: Date };
        OR: Array<{ end_date: null } | { end_date: { gte: Date } }>;
      };
      orderBy: { effective_date: 'desc' };
    }): Promise<{
      id: string;
      threshold_low: number;
      rate_low: { toString(): string };
      threshold_high: number;
      rate_high: { toString(): string };
    } | null>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  $transaction<T>(fn: (tx: SignatureDb) => Promise<T>): Promise<T>;
}

/** The subset of a `bonus_pay_periods` row the signature layer reads. */
export interface BonusMonthSignatureRow {
  id: string;
  site_id: string;
  period_start: Date;
  period_end: Date;
  state: BonusPayPeriodState;
  facility_signed_by_user_id: string | null;
  facility_signed_at: Date | null;
  ops_signed_by_user_id: string | null;
  ops_signed_at: Date | null;
  total_payout_cents: number | null;
}

export interface SignerContext {
  /** Authenticated caller id. */
  userId: string;
  /** Caller role. */
  role: 'manager' | 'admin';
  /** Caller's primary_site_id (null = both-sites ops manager). */
  primarySiteId: string | null;
  /** Woodland site id (from BonusContext.siteId). */
  siteId: string;
}

export interface RecordSignatureOpts {
  db: SignatureDb;
  monthId: string;
  signer: SignerContext;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * OVERRIDE (T-111): when set, the signature fills THIS slot on behalf of its
   * assigned signer, regardless of the caller's natural slot. The caller must be
   * authorized to override THIS slot (see {@link canOverrideSlot}) and MUST
   * supply {@link overrideReason}; the signed_* columns record the ACTUAL signer
   * (the caller) plus *_override_actor_id / *_override_reason. T-110 never set
   * this; T-111 wires it from the route/UI.
   */
  onBehalfOf?: SignatureSlot;
  /**
   * Free-text justification for an override. REQUIRED (non-blank) whenever
   * `onBehalfOf` is set; ignored on the natural-signature path.
   */
  overrideReason?: string;
}

export type RecordSignatureResult =
  | {
      ok: true;
      slot: SignatureSlot;
      state: BonusPayPeriodState;
      fullySigned: boolean;
      override: boolean;
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_signed'
        | 'no_slot'
        | 'wrong_state'
        | 'not_authorized'
        | 'missing_reason';
      slot?: SignatureSlot;
    };

// ────────────────────────────────────────────────────────────────────
// Slot determination
// ────────────────────────────────────────────────────────────────────

/**
 * The slot this signer fills in the NON-override case. Returns null for a
 * caller with no natural slot (an admin signing without `onBehalfOf`) — that is
 * the T-111 override path, rejected here.
 */
export function naturalSlotFor(signer: SignerContext): SignatureSlot | null {
  if (signer.role !== 'manager') return null;
  if (signer.primarySiteId === signer.siteId) return 'facility';
  if (signer.primarySiteId === null) return 'ops';
  return null;
}

/**
 * Asymmetric override authority (ADR-0019 §5), enforced SERVER-SIDE:
 *
 *   - Janette's slot may be overridden by Bill (admin) OR Morena (the both-sites
 *     ops manager — manager with primary_site_id = null).
 *   - Morena's slot may be overridden by Bill (admin) ONLY (the facility manager
 *     does not outrank the ops manager in this attestation chain).
 *   - Janette (Woodland facility manager) has NO override authority.
 *
 * Authority is derived from role + primary_site_id (NOT from a name), so any
 * admin (Bill, Kelsey) gets full authority and the both-sites ops manager gets
 * the Janette-only authority — matching how `requireBonusAccess` identifies these
 * principals. Filling one's OWN natural slot is the natural-signature path, never
 * an override, so it is not granted here.
 */
export function canOverrideSlot(signer: SignerContext, slot: SignatureSlot): boolean {
  if (signer.role === 'admin') return true;
  // Both-sites ops manager (Morena) may stand in for Janette only.
  if (signer.role === 'manager' && signer.primarySiteId === null && slot === 'facility') {
    return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────
// recordSignature — the only signature-capture path
// ────────────────────────────────────────────────────────────────────

/**
 * Capture one signature and advance state in a single transaction. The PDF and
 * payroll side-effects are NOT triggered here — the route fires them off the
 * request path once this resolves `fullySigned: true` (the signing user must not
 * wait on Chromium/Graph).
 */
export async function recordSignature(opts: RecordSignatureOpts): Promise<RecordSignatureResult> {
  const { db, monthId, signer } = opts;

  const isOverride = opts.onBehalfOf !== undefined;
  const slot = opts.onBehalfOf ?? naturalSlotFor(signer);
  if (!slot) return { ok: false, reason: 'no_slot' };

  // Override path: enforce the asymmetric authority + a non-blank reason BEFORE
  // touching the DB. The natural path skips both (and ignores overrideReason).
  let reason: string | null = null;
  if (isOverride) {
    if (!canOverrideSlot(signer, slot)) {
      return { ok: false, reason: 'not_authorized', slot };
    }
    reason = (opts.overrideReason ?? '').trim();
    if (reason.length === 0) {
      return { ok: false, reason: 'missing_reason', slot };
    }
  }

  return db.$transaction(async (tx) => {
    const month = await tx.bonusPayPeriod.findFirst({
      where: { id: monthId, site_id: signer.siteId },
    });
    if (!month) return { ok: false, reason: 'not_found' as const };

    // Signatures may only be captured while the month awaits them.
    if (month.state !== 'pending_signatures' && month.state !== 'partially_signed') {
      return { ok: false, reason: 'wrong_state' as const, slot };
    }

    const alreadySigned =
      slot === 'facility'
        ? month.facility_signed_by_user_id !== null
        : month.ops_signed_by_user_id !== null;
    if (alreadySigned) return { ok: false, reason: 'already_signed' as const, slot };

    const otherSigned =
      slot === 'facility'
        ? month.ops_signed_by_user_id !== null
        : month.facility_signed_by_user_id !== null;

    const now = new Date();
    const prefix = slot; // 'facility' | 'ops' — also the renamed column prefix
    // The signed_* columns always record the ACTUAL signer (the caller). On an
    // override we additionally stamp *_override_actor_id / *_override_reason so
    // the PDF can render "Signed by <caller> on behalf of <assignee>".
    const sigData: Record<string, unknown> = {
      [`${prefix}_signed_by_user_id`]: signer.userId,
      [`${prefix}_signed_at`]: now,
      [`${prefix}_signed_ip`]: opts.ip ?? null,
      [`${prefix}_signed_user_agent`]: opts.userAgent ?? null,
      [`${prefix}_override_actor_id`]: isOverride ? signer.userId : null,
      [`${prefix}_override_reason`]: isOverride ? reason : null,
    };

    await tx.bonusPayPeriod.update({ where: { id: monthId }, data: sigData });

    await tx.auditLog.create({
      data: {
        actor_user_id: signer.userId,
        actor_label: null,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_pay_periods',
        row_id: monthId,
        before: { [`${prefix}_signed_by_user_id`]: null, state: month.state },
        after: {
          [`${prefix}_signed_by_user_id`]: signer.userId,
          slot,
          signed_at: now.toISOString(),
          override: isOverride,
          ...(isOverride ? { override_actor_id: signer.userId, override_reason: reason } : {}),
        },
        ip: opts.ip ?? null,
        user_agent: opts.userAgent ?? null,
      },
    });

    // First signature → partially_signed; second → signed. transitionMonth
    // validates the edge and writes its own audit row in this same tx.
    const fullySigned = otherSigned;
    const to: BonusPayPeriodState = fullySigned ? 'signed' : 'partially_signed';
    await transitionMonth({
      db: txForTransition(tx),
      monthId,
      to,
      actor: { userId: signer.userId },
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
    });

    // On reaching `signed`, lock total_payout_cents from the keyed entries using
    // the active rule (NEVER hardcoded — CLAUDE.md hard rule #3).
    if (fullySigned) {
      const entries = await tx.bonusDailyEntry.findMany({
        where: { bonus_pay_period_id: monthId },
      });
      const on = entryDateUTC(month.period_start);
      const ruleRow = await tx.processorBonusRule.findFirst({
        where: {
          site_id: signer.siteId,
          effective_date: { lte: on },
          OR: [{ end_date: null }, { end_date: { gte: on } }],
        },
        orderBy: { effective_date: 'desc' },
      });
      if (!ruleRow) throw new NoActiveRuleError(signer.siteId);
      const total = calculateMonthlyBonusCents(
        entries.map((e) => e.mattress_count),
        {
          threshold_low: ruleRow.threshold_low,
          rate_low: ruleRow.rate_low.toString(),
          threshold_high: ruleRow.threshold_high,
          rate_high: ruleRow.rate_high.toString(),
        },
      );
      await tx.bonusPayPeriod.update({
        where: { id: monthId },
        data: { total_payout_cents: total },
      });
    }

    return { ok: true as const, slot, state: to, fullySigned, override: isOverride };
  });
}

/**
 * Adapt the signature tx handle to the state-machine's `BonusMonthDb` shape.
 * The state machine composes its own `$transaction`; passing a tx whose
 * `$transaction` runs the callback inline keeps the whole signature in one
 * physical transaction. Prisma's interactive `tx` already satisfies this (its
 * `$transaction` is not re-entrant-safe), so we wrap it with a pass-through.
 */
function txForTransition(tx: SignatureDb): import('@/lib/bonus/state-machine').BonusMonthDb {
  return {
    bonusPayPeriod: {
      // The state machine only reads id/site_id/state and writes state.
      findUnique: (args) =>
        tx.bonusPayPeriod.findFirst({
          where: args.where as { id: string; site_id: string },
        }) as never,
      // transitionMonth never calls findFirst on its db; a stub keeps the
      // structural BonusMonthDb shape satisfied.
      findFirst: (() => Promise.resolve(null)) as never,
      findMany: (() => Promise.resolve([])) as never,
      create: (() => Promise.reject(new Error('not used'))) as never,
      update: (args) => tx.bonusPayPeriod.update(args) as never,
    },
    auditLog: tx.auditLog,
    $transaction: ((fn: (t: unknown) => unknown) => fn(txForTransition(tx))) as never,
  };
}

// ────────────────────────────────────────────────────────────────────
// recordBonusMonthsByStateChange — metric helper
// ────────────────────────────────────────────────────────────────────

/**
 * Reflect a single pay-period's state change on the `bonusPayPeriodsByState` gauge. The
 * gauge is a point-in-time count per (site,state); the simplest correct update
 * on a single transition is to decrement the old bucket and increment the new.
 * Callers (the sign route) invoke this AFTER a successful signature.
 */
export function recordStateGauge(
  siteId: string,
  from: BonusPayPeriodState,
  to: BonusPayPeriodState,
): void {
  if (from === to) return;
  bonusPayPeriodsByState.dec({ site: siteId, state: from });
  bonusPayPeriodsByState.inc({ site: siteId, state: to });
}
