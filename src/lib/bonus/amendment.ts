// T-116 — Amendment workflow data layer (ADR-0019 §6, admin-only).
//
// Once a Woodland bonus month is `signed` (PDF emailed to payroll) or `paid`, the
// data is locked. Corrections require an ADMIN-ONLY amendment (Bill / Kelsey):
//
//   1. unlockMonthForAmendment: signed|paid -> amended (via the T-106 state
//      machine — the ONLY path that mutates state). In the SAME transaction it
//      clears BOTH signature column sets (so they must be re-collected) and sets
//      the amended_* tracking columns. A single audit row captures the FULL prior
//      signed state (both signatures) as `before`, so the cleared signatures are
//      never lost (CLAUDE.md hard rule #6 — audit every mutation, in-tx).
//   2. upsertAmendedMonthEntries: while the month is `amended`, daily counts are
//      editable again (assertEntriesEditable now permits draft|amended). This is
//      a MONTH-SCOPED upsert (keyed on a specific monthId, not "the current
//      month" like the T-105 /api/bonus/entries path) so an old month can be
//      corrected without touching the live month.
//   3. resubmitAmendedMonth: amended -> pending_signatures (via the state
//      machine), restarting the dual-signature flow (T-110). The route then
//      re-prompts the next signer (ADR-0019 §5a, notifyPendingSigner).
//
// AMENDED PDF marker: the printable report (assemblePdfRows / the internal PDF
// page) shows the "AMENDED" marker + the "supersedes a prior version emailed on
// {date}" notice when `amended_from_period_id !== null`. This workflow amends a
// month IN PLACE (same row — no new month is created), so we set
// `amended_from_period_id = monthId` (a self-reference, which satisfies the
// `@unique` constraint) to light the marker, and we PRESERVE `payroll_sent_at`
// (the supersedes date) by never clearing it. generateBonusPdf writes a FRESH R2
// key each call, so the original signed PDF is preserved automatically.
//
// Bonus is Woodland-scoped (CLAUDE.md hard rule #2): every read is re-scoped to
// the caller's site id; a forged month id for another site is treated as
// not-found and never mutated.

import { Prisma, type AuditAction } from '@prisma/client';
import {
  assertEntriesEditable,
  transitionMonth,
  type BonusMonthDb,
  type BonusPayPeriodState,
} from '@/lib/bonus/state-machine';

// ────────────────────────────────────────────────────────────────────
// Structural DB types (DB-free testable; satisfied by PrismaClient/tx)
// ────────────────────────────────────────────────────────────────────

/** The subset of a `bonus_pay_periods` row the amendment layer reads/writes. */
export interface AmendmentMonthRow {
  id: string;
  site_id: string;
  state: BonusPayPeriodState;
  facility_signed_by_user_id: string | null;
  facility_signed_at: Date | null;
  facility_signed_ip: string | null;
  facility_signed_user_agent: string | null;
  facility_override_actor_id: string | null;
  facility_override_reason: string | null;
  ops_signed_by_user_id: string | null;
  ops_signed_at: Date | null;
  ops_signed_ip: string | null;
  ops_signed_user_agent: string | null;
  ops_override_actor_id: string | null;
  ops_override_reason: string | null;
  amended_from_period_id: string | null;
  amendment_reason: string | null;
  amended_by_user_id: string | null;
  amended_at: Date | null;
}

/** Client surface the unlock path needs. Composes with the singleton or a `tx`. */
export interface AmendmentDb extends BonusMonthDb {
  bonusPayPeriod: BonusMonthDb['bonusPayPeriod'] & {
    findFirst(args: { where: { id: string; site_id: string } }): Promise<AmendmentMonthRow | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<AmendmentMonthRow>;
  };
}

/** Client surface the month-scoped entry upsert needs. */
export interface AmendmentEntryDb {
  bonusPayPeriod: {
    findFirst(args: {
      where: { id: string; site_id: string };
    }): Promise<{ id: string; site_id: string; state: BonusPayPeriodState } | null>;
  };
  bonusEmployee: {
    findMany(args: {
      where: { id: { in: string[] }; site_id: string };
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
  bonusDailyEntry: {
    findUnique(args: {
      where: { bonus_employee_id_entry_date: { bonus_employee_id: string; entry_date: Date } };
    }): Promise<{
      id: string;
      mattress_count: number;
      note: string | null;
      entered_by_user_id: string;
    } | null>;
    upsert(args: {
      where: { bonus_employee_id_entry_date: { bonus_employee_id: string; entry_date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{
      id: string;
      bonus_employee_id: string;
      mattress_count: number;
      note: string | null;
      entered_by_user_id: string;
    }>;
  };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  $transaction<T>(fn: (tx: AmendmentEntryDb) => Promise<T>): Promise<T>;
}

export interface AmendmentActor {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function serializeForAudit(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

function entryDateUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The full signed-signature snapshot we preserve in the unlock audit `before`. */
function priorSignatureState(m: AmendmentMonthRow) {
  return {
    state: m.state,
    facility_signed_by_user_id: m.facility_signed_by_user_id,
    facility_signed_at: m.facility_signed_at,
    facility_signed_ip: m.facility_signed_ip,
    facility_signed_user_agent: m.facility_signed_user_agent,
    facility_override_actor_id: m.facility_override_actor_id,
    facility_override_reason: m.facility_override_reason,
    ops_signed_by_user_id: m.ops_signed_by_user_id,
    ops_signed_at: m.ops_signed_at,
    ops_signed_ip: m.ops_signed_ip,
    ops_signed_user_agent: m.ops_signed_user_agent,
    ops_override_actor_id: m.ops_override_actor_id,
    ops_override_reason: m.ops_override_reason,
  };
}

/**
 * Adapt an interactive `tx` to the state-machine's `BonusMonthDb` shape so a
 * nested `transitionMonth` runs INLINE inside our outer `$transaction` (Prisma's
 * `tx.$transaction` is not re-entrant). Mirrors `signatures.ts#txForTransition`:
 * the state machine only reads id/site_id/state and writes state + an audit row.
 */
function txForTransition(tx: AmendmentDb): BonusMonthDb {
  return {
    bonusPayPeriod: {
      findUnique: (args) => tx.bonusPayPeriod.findUnique(args) as never,
      findMany: (() => Promise.resolve([])) as never,
      create: (() => Promise.reject(new Error('not used'))) as never,
      update: (args) => tx.bonusPayPeriod.update(args) as never,
    },
    auditLog: tx.auditLog,
    $transaction: ((fn: (t: unknown) => unknown) => fn(txForTransition(tx))) as never,
  };
}

/** The null-out patch that clears BOTH signature column sets. */
const CLEAR_SIGNATURES = {
  facility_signed_by_user_id: null,
  facility_signed_at: null,
  facility_signed_ip: null,
  facility_signed_user_agent: null,
  facility_override_actor_id: null,
  facility_override_reason: null,
  ops_signed_by_user_id: null,
  ops_signed_at: null,
  ops_signed_ip: null,
  ops_signed_user_agent: null,
  ops_override_actor_id: null,
  ops_override_reason: null,
} as const;

// ────────────────────────────────────────────────────────────────────
// 1. Unlock (signed|paid -> amended)
// ────────────────────────────────────────────────────────────────────

export interface UnlockOpts {
  db: AmendmentDb;
  monthId: string;
  siteId: string;
  actor: AmendmentActor;
  /** Required free-text justification (ADR-0019 §6). */
  reason: string;
}

export type UnlockResult =
  | { ok: true; state: 'amended' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'missing_reason' }
  | { ok: false; reason: 'wrong_state'; state: BonusPayPeriodState };

/**
 * Admin-only unlock of a `signed` or `paid` month for correction (ADR-0019 §6).
 * Transitions the month to `amended` via the state machine, clears BOTH
 * signatures, and sets the amendment tracking columns — all in ONE transaction.
 * The pre-amendment signed state (both signatures) is preserved in a single
 * audit row's `before`, so nothing is lost when the columns are nulled.
 *
 * Authorization (admin-only) is enforced by the route; this layer assumes the
 * caller is permitted but still re-scopes the read to `siteId`.
 */
export async function unlockMonthForAmendment(opts: UnlockOpts): Promise<UnlockResult> {
  const { db, monthId, siteId, actor } = opts;
  const reason = opts.reason?.trim() ?? '';
  if (reason.length === 0) return { ok: false, reason: 'missing_reason' };

  const month = await db.bonusPayPeriod.findFirst({ where: { id: monthId, site_id: siteId } });
  if (!month) return { ok: false, reason: 'not_found' };
  if (month.state !== 'signed' && month.state !== 'paid') {
    return { ok: false, reason: 'wrong_state', state: month.state };
  }

  await db.$transaction(async (tx) => {
    const amendmentTx = tx as AmendmentDb;
    // Re-read inside the tx and re-check the state as a backstop against a
    // concurrent transition between the pre-check and the write.
    const fresh = await amendmentTx.bonusPayPeriod.findUnique({ where: { id: monthId } });
    if (!fresh) throw new Error(`bonus month ${monthId} vanished mid-amendment`);
    if (fresh.state !== 'signed' && fresh.state !== 'paid') {
      throw new Error(`bonus month ${monthId} is ${fresh.state}; cannot unlock`);
    }

    // State move + its own audit row (handled inside transitionMonth), run inline
    // inside this transaction via the pass-through adapter.
    await transitionMonth({
      db: txForTransition(amendmentTx),
      monthId,
      to: 'amended',
      actor: { userId: actor.userId },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    });

    // Clear signatures + stamp amendment tracking. Self-reference
    // amended_from_period_id so the PDF AMENDED marker lights (the report keys
    // off amended_from_period_id !== null); payroll_sent_at is left intact as the
    // supersedes date.
    await amendmentTx.bonusPayPeriod.update({
      where: { id: monthId },
      data: {
        ...CLEAR_SIGNATURES,
        amended_from_period_id: monthId,
        amendment_reason: reason,
        amended_by_user_id: actor.userId,
        amended_at: new Date(),
      },
    });

    // One audit row capturing the FULL prior signed state as `before` so the
    // cleared signatures are preserved (ADR-0019 §6).
    await amendmentTx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        actor_label: null,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_pay_periods',
        row_id: monthId,
        before: serializeForAudit(priorSignatureState(month)),
        after: serializeForAudit({ state: 'amended', amendment_reason: reason }),
        ip: actor.ip ?? null,
        user_agent: actor.userAgent ?? null,
      },
    });
  });

  return { ok: true, state: 'amended' };
}

// ────────────────────────────────────────────────────────────────────
// 2. Re-submit (amended -> pending_signatures)
// ────────────────────────────────────────────────────────────────────

export interface ResubmitOpts {
  db: AmendmentDb;
  monthId: string;
  siteId: string;
  actor: AmendmentActor;
}

export type ResubmitResult =
  | { ok: true; state: 'pending_signatures' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'wrong_state'; state: BonusPayPeriodState };

/**
 * Admin-only re-submission of an `amended` month for re-signature (ADR-0019 §6).
 * Transitions `amended -> pending_signatures` via the state machine (which audits
 * the move in-tx). The route then re-prompts the next signer (notifyPendingSigner).
 */
export async function resubmitAmendedMonth(opts: ResubmitOpts): Promise<ResubmitResult> {
  const { db, monthId, siteId, actor } = opts;

  const month = await db.bonusPayPeriod.findFirst({ where: { id: monthId, site_id: siteId } });
  if (!month) return { ok: false, reason: 'not_found' };
  if (month.state !== 'amended') {
    return { ok: false, reason: 'wrong_state', state: month.state };
  }

  await transitionMonth({
    db,
    monthId,
    to: 'pending_signatures',
    actor: { userId: actor.userId },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return { ok: true, state: 'pending_signatures' };
}

// ────────────────────────────────────────────────────────────────────
// 3. Month-scoped daily-entry upsert (edit while amended)
// ────────────────────────────────────────────────────────────────────

export interface AmendmentEntryInput {
  bonus_employee_id: string;
  mattress_count: number;
  note?: string | null;
}

export interface AmendmentUpsertedEntry {
  id: string;
  bonus_employee_id: string;
  mattress_count: number;
  note: string | null;
  entered_by_user_id: string;
}

export type AmendmentEntriesResult =
  | { ok: true; monthId: string; entries: AmendmentUpsertedEntry[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'month_locked'; state: BonusPayPeriodState }
  | { ok: false; reason: 'count_out_of_range' | 'employee_not_in_site' };

const MAX_MATTRESS_COUNT = 999;

/**
 * Upsert daily mattress-count entries for a SPECIFIC month (keyed by monthId,
 * re-scoped to siteId) for a single calendar day. Unlike the T-105
 * /api/bonus/entries path (which resolves "the current month" from the entry
 * date), this targets the month being amended directly, so an old corrected
 * month never collides with the live month.
 *
 * The target month must be editable (`amended` — or `draft`, harmless) per the
 * extended assertEntriesEditable; otherwise 409 month_locked. Every upsert lands
 * an audit row in the SAME transaction (hard rule #6).
 */
export async function upsertAmendedMonthEntries(
  db: AmendmentEntryDb,
  monthId: string,
  siteId: string,
  date: Date,
  inputs: AmendmentEntryInput[],
  actor: AmendmentActor,
): Promise<AmendmentEntriesResult> {
  const entryDate = entryDateUTC(date);

  for (const i of inputs) {
    if (
      !Number.isInteger(i.mattress_count) ||
      i.mattress_count < 0 ||
      i.mattress_count > MAX_MATTRESS_COUNT
    ) {
      return { ok: false, reason: 'count_out_of_range' };
    }
  }

  const month = await db.bonusPayPeriod.findFirst({ where: { id: monthId, site_id: siteId } });
  if (!month) return { ok: false, reason: 'not_found' };
  try {
    assertEntriesEditable({ id: month.id, state: month.state });
  } catch {
    return { ok: false, reason: 'month_locked', state: month.state };
  }

  const ids = inputs.map((i) => i.bonus_employee_id);
  const employees = await db.bonusEmployee.findMany({
    where: { id: { in: ids }, site_id: siteId },
    select: { id: true },
  });
  const validIds = new Set(employees.map((e) => e.id));
  for (const i of inputs) {
    if (!validIds.has(i.bonus_employee_id)) {
      return { ok: false, reason: 'employee_not_in_site' };
    }
  }

  const entries = await db.$transaction(async (tx) => {
    const out: AmendmentUpsertedEntry[] = [];
    for (const input of inputs) {
      const before = await tx.bonusDailyEntry.findUnique({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: input.bonus_employee_id,
            entry_date: entryDate,
          },
        },
      });

      const note = input.note && input.note.trim().length > 0 ? input.note.trim() : null;

      const row = await tx.bonusDailyEntry.upsert({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: input.bonus_employee_id,
            entry_date: entryDate,
          },
        },
        create: {
          bonus_employee_id: input.bonus_employee_id,
          bonus_pay_period_id: monthId,
          entry_date: entryDate,
          mattress_count: input.mattress_count,
          note,
          entered_by_user_id: actor.userId,
        },
        update: {
          mattress_count: input.mattress_count,
          note,
          entered_by_user_id: actor.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          actor_user_id: actor.userId,
          actor_label: null,
          action: (before ? 'update' : 'insert') satisfies AuditAction,
          table_name: 'bonus_daily_entries',
          row_id: row.id,
          before: before
            ? serializeForAudit({
                mattress_count: before.mattress_count,
                note: before.note,
                entered_by_user_id: before.entered_by_user_id,
              })
            : Prisma.JsonNull,
          after: serializeForAudit({
            mattress_count: row.mattress_count,
            note: row.note,
            entered_by_user_id: row.entered_by_user_id,
          }),
          ip: actor.ip ?? null,
          user_agent: actor.userAgent ?? null,
        },
      });

      out.push({
        id: row.id,
        bonus_employee_id: row.bonus_employee_id,
        mattress_count: row.mattress_count,
        note: row.note,
        entered_by_user_id: row.entered_by_user_id,
      });
    }
    return out;
  });

  return { ok: true, monthId, entries };
}

// Re-export internals tests need to drive without a DB.
export const __testing = { serializeForAudit, entryDateUTC, priorSignatureState, CLEAR_SIGNATURES };
