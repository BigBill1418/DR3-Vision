// T-110 — Signature capture data layer (ADR-0019 §5).
// T-208 — Made site-aware: signer/override identity now comes from the
//         `bonus_signature_chains` row for the period's site, NEVER hardcoded
//         (addendum hard rules #2 & #3).
//
// Records one of the two attestation signatures (facility / ops) on a
// `bonus_pay_periods` row and advances the lifecycle via the T-106 state
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
// SLOT determination (NON-override case) — CHAIN-SOURCED (T-208):
//   - facility slot: the user whose id === chain.facility_signer_user_id for
//     the period's site (Janette @ Woodland, Rick @ Eugene).
//   - ops slot:      the user whose id === chain.ops_signer_user_id (Morena @
//     Woodland, Kelsey @ Eugene).
//   - A caller who is neither configured signer and supplies NO `onBehalfOf`
//     has no natural slot and is rejected with `no_slot` — admin-as-override
//     passes an explicit `onBehalfOf` slot (the override path).
//
// OVERRIDE authority — CHAIN-SOURCED (T-208) + admin (ADR-0019.2 §3):
//   - any admin may override either slot (admins occupy any slot they're
//     authorized for; Woodland's chain need not list them).
//   - a non-admin may override a slot iff their id is in that slot's
//     `*_override_actor_user_ids` list. For Woodland: Morena (ops_signer) is
//     also in facility_override, so she may override facility but NOT ops; she
//     signs her OWN ops slot naturally, never via override.
//
// Bonus is site-scoped (CLAUDE.md hard rule #2): the month is always re-read
// scoped to the caller's site id; a forged month id for another site is treated
// as not-found.

import type { AuditAction } from '@prisma/client';
import { calculateMonthlyBonusCents } from '@/lib/bonus/calculator';
import { transitionMonth, type BonusPayPeriodState } from '@/lib/bonus/state-machine';
import { entryDateUTC, NoActiveRuleError } from '@/lib/bonus/daily-entry';
import { bonusPayPeriodsByState } from '@/lib/observability/metrics';
import { getSignatureChain, type SignatureChainDb } from '@/lib/bonus/signature-chain';

// Re-export so the escalation cron (T-205) imports the auto-override actor from
// one place (and so callers needn't reach into two modules).
export { getAutoOverrideActor } from '@/lib/bonus/signature-chain';

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
  /**
   * Client used to read the `bonus_signature_chains` row (T-208). Defaults to
   * the global Prisma singleton; the route passes `prisma`, tests pass a chain
   * double. Kept separate from `db` because `db` is the (possibly transactional)
   * signature client whose structural type does not include the chain model.
   */
  chainDb?: SignatureChainDb;
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
  /**
   * AUTO-OVERRIDE (T-205, ADR-0019.1 §4): when true, this is a system-applied
   * admin override fired by the Tue 08:30 PT escalation cron. It is structurally
   * the SAME path as a manual override (requires `onBehalfOf` + a non-blank
   * `overrideReason`, enforces the same chain-sourced authority on the actor),
   * but additionally stamps `*_auto_override_at` so the PDF (T-209) can render
   * the ADR-0019.1 escalation attestation instead of the manual-override
   * language, and labels the audit row {@link actorLabel}.
   */
  autoOverride?: boolean;
  /**
   * Audit `actor_label` for this signature. The natural/manual paths leave it
   * null (the actor_user_id carries identity); the escalation cron passes
   * `'system:bonus-escalation'` (ADR-0019.1 §4) so the audit trail flags the
   * automated origin.
   */
  actorLabel?: string;
}

export type RecordSignatureResult =
  | {
      ok: true;
      slot: SignatureSlot;
      state: BonusPayPeriodState;
      fullySigned: boolean;
      override: boolean;
      autoOverride: boolean;
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
// Slot determination & authority — CHAIN-SOURCED (T-208)
// ────────────────────────────────────────────────────────────────────

/**
 * The minimal principal the chain-sourced checks need: an id and a role. Role
 * only grants the blanket admin override (ADR-0019.2 §3); WHO signs and WHO may
 * override a slot otherwise comes entirely from the chain.
 */
export interface UserPrincipal {
  id: string;
  role: 'manager' | 'admin';
}

/**
 * Whether `user` is the configured PRIMARY signer for `slot` at `siteId`.
 *   `user.id === chain.{slot}_signer_user_id`
 * Pure chain lookup — no role logic (an admin who is also the configured signer
 * is a primary signature, not an override; e.g. Kelsey is Eugene's ops_signer).
 */
export async function canSignSlot(
  user: UserPrincipal,
  slot: SignatureSlot,
  siteId: string,
  db?: SignatureChainDb,
): Promise<boolean> {
  const chain = await getSignatureChain(siteId, db);
  const signerId = slot === 'facility' ? chain.facility_signer_user_id : chain.ops_signer_user_id;
  return user.id === signerId;
}

/**
 * Whether `user` may OVERRIDE (sign on behalf of the configured signer for)
 * `slot` at `siteId`:
 *   - any admin → true (ADR-0019.2 §3: admins occupy any slot they're
 *     authorized for; the per-site override list need not enumerate them);
 *   - otherwise → `user.id ∈ chain.{slot}_override_actor_user_ids`.
 *
 * Woodland outcome (unchanged): Bill/Kelsey (admin) → both slots; Morena (in
 * facility_override) → facility only; Janette (in neither list) → neither.
 * Eugene: Bill/Kelsey (admin) → both; Rick (in neither list) → neither.
 */
export async function canOverrideSlot(
  user: UserPrincipal,
  slot: SignatureSlot,
  siteId: string,
  db?: SignatureChainDb,
): Promise<boolean> {
  if (user.role === 'admin') return true;
  const chain = await getSignatureChain(siteId, db);
  const list =
    slot === 'facility'
      ? chain.facility_override_actor_user_ids
      : chain.ops_override_actor_user_ids;
  return list.includes(user.id);
}

/**
 * The slot this signer fills in the NON-override case, sourced from the chain.
 * Returns null for a caller who is neither configured signer (an admin or a
 * non-signer must use the override path with an explicit `onBehalfOf`).
 */
export async function naturalSlotFor(
  signer: UserPrincipal,
  siteId: string,
  db?: SignatureChainDb,
): Promise<SignatureSlot | null> {
  const chain = await getSignatureChain(siteId, db);
  if (signer.id === chain.facility_signer_user_id) return 'facility';
  if (signer.id === chain.ops_signer_user_id) return 'ops';
  return null;
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
  const chainDb = opts.chainDb;
  const principal: UserPrincipal = { id: signer.userId, role: signer.role };

  const isOverride = opts.onBehalfOf !== undefined;
  // Auto-override (T-205) is a system-fired override: it travels the SAME
  // override path (authority + reason enforced below), only adding the
  // `*_auto_override_at` stamp and the audit actor_label. It is meaningless
  // without `onBehalfOf` (there is no "natural auto-signature").
  const isAutoOverride = opts.autoOverride === true && isOverride;
  // Slot identity is CHAIN-SOURCED (T-208): on a natural signature it is the
  // slot whose configured signer is the caller; on an override it is the
  // explicit target.
  const slot = opts.onBehalfOf ?? (await naturalSlotFor(principal, signer.siteId, chainDb));
  if (!slot) return { ok: false, reason: 'no_slot' };

  // Override path: enforce chain-sourced authority + a non-blank reason BEFORE
  // touching the DB. The natural path skips both (and ignores overrideReason).
  let reason: string | null = null;
  if (isOverride) {
    if (!(await canOverrideSlot(principal, slot, signer.siteId, chainDb))) {
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
      // Only the system auto-override stamps this; a manual override leaves it
      // null so the PDF (T-209) distinguishes the two by `*_auto_override_at`.
      [`${prefix}_auto_override_at`]: isAutoOverride ? now : null,
    };

    await tx.bonusPayPeriod.update({ where: { id: monthId }, data: sigData });

    await tx.auditLog.create({
      data: {
        actor_user_id: signer.userId,
        actor_label: opts.actorLabel ?? null,
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
          ...(isAutoOverride ? { auto_override_at: now.toISOString() } : {}),
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

    return {
      ok: true as const,
      slot,
      state: to,
      fullySigned,
      override: isOverride,
      autoOverride: isAutoOverride,
    };
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
