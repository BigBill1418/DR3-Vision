// T-106 — Monthly state machine: the lifecycle authority for `bonus_pay_periods`
// (ADR-0019 §5/§6, SPRINT-2 plan T-106).
//
// This module is the ONLY place that mutates `bonus_pay_periods.state`. Every other
// bonus ticket (signature capture, payroll send, amendment, the month-close
// cron, daily-entry mutations) routes its state changes through `transitionMonth`
// so the legal-transition table and the append-only audit trail are enforced in
// one spot.
//
// Design notes:
//   - `transitionMonth` / `getOrCreateDraftPayPeriod` / `closePayPeriodsDueForSignature`
//     accept an injected prisma-or-tx client (`BonusMonthDb`) so callers can
//     compose them inside a larger interactive transaction (e.g. T-105 wires a
//     daily-entry write + draft-month upsert in one tx). The default callers can
//     pass the singleton `prisma` from '@/lib/prisma'.
//   - State transitions write an audit row with `action: 'update'` and
//     `table_name: 'bonus_pay_periods'` (the AuditAction enum has no dedicated
//     "transition" verb; a state change is an update). The audit write happens in
//     the SAME transaction as the state update so a transition can never land
//     without its audit row (CLAUDE.md hard rule #6).
//   - Date math for month boundaries is done in UTC. `@db.Date` columns store a
//     calendar date with no zone; building the first/last day in UTC avoids the
//     local-timezone off-by-one that bites `new Date(y, m, d)` in non-UTC envs.
//
// Bonus is Woodland-scoped (CLAUDE.md hard rule #2): callers pass the
// Woodland `siteId` from `requireBonusAccess()`; this module never widens scope.

import type { AuditAction } from '@prisma/client';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/** Mirrors the Prisma `BonusPayPeriodState` enum (prisma/schema.prisma). */
export type BonusPayPeriodState =
  | 'draft'
  | 'pending_signatures'
  | 'partially_signed'
  | 'signed'
  | 'paid'
  | 'amended'
  | 'skipped';

/** The subset of a `bonus_pay_periods` row this module reads/writes. */
export interface BonusMonthRow {
  id: string;
  site_id: string;
  period_start: Date;
  period_end: Date;
  state: BonusPayPeriodState;
}

/**
 * Structural type for the injected prisma/tx client. Declaring only the methods
 * we use (rather than importing `PrismaClient`) keeps the module composable with
 * both the singleton client and an interactive `tx` handle, and keeps the tests
 * DB-free.
 */
export interface BonusMonthDb {
  bonusPayPeriod: {
    findUnique(args: {
      where: { id: string } | { site_id_period_start: { site_id: string; period_start: Date } };
    }): Promise<BonusMonthRow | null>;
    findMany(args?: {
      where?: {
        site_id?: string;
        state?: BonusPayPeriodState;
        period_end?: { lt?: Date };
      };
    }): Promise<BonusMonthRow[]>;
    create(args: {
      data: {
        site_id: string;
        period_start: Date;
        period_end: Date;
        state: BonusPayPeriodState;
      };
    }): Promise<BonusMonthRow>;
    update(args: {
      where: { id: string };
      data: { state: BonusPayPeriodState };
    }): Promise<BonusMonthRow>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  $transaction<T>(fn: (tx: BonusMonthDb) => Promise<T>): Promise<T>;
}

export interface TransitionActor {
  /** Authenticated caller id (from BonusContext.userId). */
  userId?: string;
  /** System actor label for unattended transitions, e.g. 'system:month-close-cron'. */
  label?: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────

/** Raised when a transition is illegal or the target month is missing. */
export class TransitionError extends Error {
  readonly status = 409 as const;
  readonly from: BonusPayPeriodState | null;
  readonly to: BonusPayPeriodState;
  constructor(message: string, to: BonusPayPeriodState, from: BonusPayPeriodState | null) {
    super(message);
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
  }
}

/** States in which daily mattress-count entries may be added/edited. */
export const EDITABLE_STATES: readonly BonusPayPeriodState[] = ['draft', 'amended'];

/** Raised when a daily-entry mutation is attempted on a non-editable month. */
export class EntriesLockedError extends Error {
  readonly status = 409 as const;
  readonly state: BonusPayPeriodState;
  constructor(state: BonusPayPeriodState) {
    super(`bonus month is ${state}; daily entries are only editable while draft or amended`);
    this.name = 'EntriesLockedError';
    this.state = state;
  }
}

// ────────────────────────────────────────────────────────────────────
// Transition table
// ────────────────────────────────────────────────────────────────────

/**
 * Legal `bonus_pay_periods.state` transitions (ADR-0019 §5/§6). Any edge not listed
 * here is rejected by {@link transitionMonth}. The `amended -> pending_signatures`
 * edge is what restarts the signature flow after a Bill-only amendment.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<BonusPayPeriodState, readonly BonusPayPeriodState[]>
> = {
  draft: ['pending_signatures'],
  pending_signatures: ['partially_signed'],
  partially_signed: ['signed'],
  signed: ['paid', 'amended'],
  paid: ['amended'],
  amended: ['pending_signatures'],
  // `skipped` is a terminal state mirrored from the Prisma enum (ADR-0019.1).
  // The `draft -> skipped` in-edge and admin-only guard are owned by T-203;
  // T-202 only adds the type/key so the transition table stays exhaustive.
  skipped: [],
};

/** True iff `from -> to` is a legal transition. Self-edges are never legal. */
export function isTransitionAllowed(from: BonusPayPeriodState, to: BonusPayPeriodState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ────────────────────────────────────────────────────────────────────
// transitionMonth — the only path that changes state
// ────────────────────────────────────────────────────────────────────

export interface TransitionMonthOpts {
  db: BonusMonthDb;
  monthId: string;
  to: BonusPayPeriodState;
  actor: TransitionActor;
  /** Optional audit context. */
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Validate and apply a state transition, writing an audit row in the same
 * transaction. Throws {@link TransitionError} if the month is missing or the
 * transition is illegal (state and audit are left untouched in that case).
 */
export async function transitionMonth(opts: TransitionMonthOpts): Promise<BonusMonthRow> {
  const { db, monthId, to, actor } = opts;

  return db.$transaction(async (tx) => {
    const month = await tx.bonusPayPeriod.findUnique({ where: { id: monthId } });
    if (!month) {
      throw new TransitionError(`bonus month ${monthId} not found`, to, null);
    }
    const from = month.state;
    if (!isTransitionAllowed(from, to)) {
      throw new TransitionError(`illegal transition ${from} -> ${to}`, to, from);
    }

    const updated = await tx.bonusPayPeriod.update({
      where: { id: monthId },
      data: { state: to },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId ?? null,
        actor_label: actor.label ?? null,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_pay_periods',
        row_id: monthId,
        before: { state: from },
        after: { state: to },
        ip: opts.ip ?? null,
        user_agent: opts.userAgent ?? null,
      },
    });

    return updated;
  });
}

// ────────────────────────────────────────────────────────────────────
// Month-boundary helpers (UTC, zone-safe for @db.Date)
// ────────────────────────────────────────────────────────────────────

/** First day of the month containing `date`, at UTC midnight. */
export function monthStartUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Last day of the month containing `date`, at UTC midnight. */
export function monthEndUTC(date: Date): Date {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

// ────────────────────────────────────────────────────────────────────
// getOrCreateDraftPayPeriod — consumed by T-105
// ────────────────────────────────────────────────────────────────────

/**
 * Return the `bonus_pay_periods` row covering the month of `date` for `siteId`,
 * creating it in `draft` state if absent. Idempotent and safe under the
 * `UNIQUE(site_id, period_start)` constraint: it looks up by the composite key
 * first and only creates on a miss.
 *
 * NOTE: a true concurrency-safe upsert would catch the unique-violation and
 * re-read; callers that race (the daily-entry path) should wrap this in their
 * own tx and rely on the DB constraint as the backstop. For the single-operator
 * Woodland workflow the find-then-create path is sufficient.
 */
export async function getOrCreateDraftPayPeriod(
  db: BonusMonthDb,
  siteId: string,
  date: Date,
): Promise<BonusMonthRow> {
  const period_start = monthStartUTC(date);
  const existing = await db.bonusPayPeriod.findUnique({
    where: { site_id_period_start: { site_id: siteId, period_start } },
  });
  if (existing) return existing;

  return db.bonusPayPeriod.create({
    data: {
      site_id: siteId,
      period_start,
      period_end: monthEndUTC(date),
      state: 'draft',
    },
  });
}

// ────────────────────────────────────────────────────────────────────
// closePayPeriodsDueForSignature — month-end auto-transition (Wave C cron)
// ────────────────────────────────────────────────────────────────────

export interface CloseMonthsResult {
  /** Ids of months transitioned draft -> pending_signatures. */
  transitioned: string[];
}

/**
 * Find every `draft` month whose calendar month has fully ended as of `now`
 * (i.e. `period_end` falls before the first day of `now`'s month) and transition
 * it `draft -> pending_signatures`. Used by the Wave C month-close cron; the cron
 * supplies `now` so the function stays deterministic and testable.
 */
export async function closePayPeriodsDueForSignature(
  db: BonusMonthDb,
  now: Date,
): Promise<CloseMonthsResult> {
  const currentMonthStart = monthStartUTC(now);
  const due = await db.bonusPayPeriod.findMany({
    where: { state: 'draft', period_end: { lt: currentMonthStart } },
  });

  const transitioned: string[] = [];
  for (const m of due) {
    await transitionMonth({
      db,
      monthId: m.id,
      to: 'pending_signatures',
      actor: { label: 'system:month-close-cron' },
    });
    transitioned.push(m.id);
  }
  return { transitioned };
}

// ────────────────────────────────────────────────────────────────────
// assertEntriesEditable — guard for daily-entry mutations
// ────────────────────────────────────────────────────────────────────

/**
 * Throw {@link EntriesLockedError} (409) unless the month is editable. Daily
 * mattress-count entries may only be added/edited while the month is open
 * (`draft`) or has been unlocked for correction (`amended`, ADR-0019 §6); once
 * it moves to `pending_signatures` the totals are frozen pending signature.
 * Callers (T-105 daily-entry API, T-116 amendment edit) call this before any write.
 */
export function assertEntriesEditable(month: { id: string; state: BonusPayPeriodState }): void {
  if (!EDITABLE_STATES.includes(month.state)) {
    throw new EntriesLockedError(month.state);
  }
}
