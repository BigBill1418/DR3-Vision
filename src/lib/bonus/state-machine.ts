// T-106 / T-203 — Pay-period state machine: the lifecycle authority for
// `bonus_pay_periods` (ADR-0019 §5/§6, ADR-0019.1 bi-weekly cadence).
//
// This module is the ONLY place that mutates `bonus_pay_periods.state`. Every other
// bonus ticket (signature capture, payroll send, amendment, the period-close
// cron, daily-entry mutations) routes its state changes through `transitionMonth`
// so the legal-transition table and the append-only audit trail are enforced in
// one spot.
//
// Design notes:
//   - `transitionMonth` / `resolveOpenPayPeriod` / `closePayPeriodsDueForSignature`
//     accept an injected prisma-or-tx client (`BonusMonthDb`) so callers can
//     compose them inside a larger interactive transaction (e.g. T-105 wires a
//     daily-entry write + period lookup in one tx). The default callers can
//     pass the singleton `prisma` from '@/lib/prisma'.
//   - State transitions write an audit row with `action: 'update'` and
//     `table_name: 'bonus_pay_periods'` (the AuditAction enum has no dedicated
//     "transition" verb; a state change is an update). The audit write happens in
//     the SAME transaction as the state update so a transition can never land
//     without its audit row (CLAUDE.md hard rule #6).
//   - PERIOD BOUNDARIES, NOT MONTH BOUNDARIES (T-203 / ADR-0019.1). The 26
//     periods/site/year are PRE-SEEDED (Wave A T-201) with explicit
//     period_start (Tue) / period_end (Mon) / pay_date (Fri). This module never
//     fabricates period rows from calendar-month math; it resolves the seeded
//     period whose [period_start, period_end] window CONTAINS a given day, and
//     the period-close decision keys off `period_end == appToday()` (Pacific),
//     never "the calendar month just ended."
//   - All "today / period_end" decisions go through `@/lib/time` (Pacific-aware);
//     the cron supplies `now` so the function stays deterministic and testable.
//
// Bonus is site-scoped (CLAUDE.md hard rule #2): callers pass the `siteId` from
// `requireBonusAccess()`; this module never widens scope and never hardcodes a
// site (ADR-0019.1 hard rule #2).

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
  | 'skipped'
  | 'historical_imported'; // ADR-0023 — periods loaded from the historical spreadsheet

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
    /**
     * Date-range lookup used by {@link resolveOpenPayPeriod}: the seeded period
     * for `site_id` whose [period_start, period_end] window contains a day
     * (`period_start <= day AND period_end >= day`). Periods never overlap, so
     * at most one row matches.
     */
    findFirst(args: {
      where: {
        site_id: string;
        period_start?: { lte: Date };
        period_end?: { gte: Date } | { equals: Date };
        state?: BonusPayPeriodState;
      };
    }): Promise<BonusMonthRow | null>;
    findMany(args?: {
      where?: {
        site_id?: string;
        state?: BonusPayPeriodState;
        period_end?: { lt?: Date; equals?: Date };
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
  /** System actor label for unattended transitions, e.g. 'system:period-close-cron'. */
  label?: string | null;
  /**
   * Whether the actor holds admin authority (BonusContext.isAdmin). Required to
   * be `true` for an {@link ADMIN_ONLY_TRANSITIONS} edge (e.g. `draft -> skipped`).
   * Unattended system transitions (no `userId`, set `label`) are treated as
   * authorized — the cron path never drives an admin-only edge.
   */
  isAdmin?: boolean;
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

/**
 * Raised (403) when a non-admin actor attempts an {@link ADMIN_ONLY_TRANSITIONS}
 * edge (e.g. a manager trying `draft -> skipped`). The state machine enforces this
 * server-side as a backstop even though the route also guards on `ctx.isAdmin` —
 * authorization for admin-only transitions belongs to the lifecycle authority, not
 * only the route (CLAUDE.md hard rule #6: never trust the client; defense in depth).
 */
export class TransitionForbiddenError extends Error {
  readonly status = 403 as const;
  readonly from: BonusPayPeriodState;
  readonly to: BonusPayPeriodState;
  constructor(from: BonusPayPeriodState, to: BonusPayPeriodState) {
    super(`transition ${from} -> ${to} requires an administrator`);
    this.name = 'TransitionForbiddenError';
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
  // `draft -> skipped` (T-203 / ADR-0019.1 "Bootstrapping question") is the single
  // legal in-edge to the terminal `skipped` state. It is the deploy-time disposition
  // for a period with no real data (e.g. Period 12 of 2026). Admin-only — enforced
  // SERVER-SIDE by {@link assertAdminOnlyTransition} + the route guard; this table
  // only declares legality, not authorization.
  // `draft -> skipped` (T-203 / ADR-0019.1) and `draft -> historical_imported`
  // (ADR-0023) are both admin-only edges into terminal-ish states. The
  // historical_imported state is amendable: a period imported from the
  // spreadsheet can be unlocked for correction via the existing amendment
  // workflow, restarting the signature flow at pending_signatures.
  draft: ['pending_signatures', 'skipped', 'historical_imported'],
  pending_signatures: ['partially_signed'],
  partially_signed: ['signed'],
  signed: ['paid', 'amended'],
  paid: ['amended'],
  amended: ['pending_signatures'],
  // `skipped` is terminal EXCEPT for the ADR-0023 recovery edge: a
  // pre-cutover-skipped period that turns out to have historical data may be
  // moved into historical_imported. Otherwise it stays permanently inert —
  // daily-entry mutations and the signature workflow both refuse to touch it
  // (it is not in EDITABLE_STATES, and it is not pending/partially-signed).
  skipped: ['historical_imported'], // ADR-0023 — a pre-cutover-skipped period that turns out to have historical data
  historical_imported: ['amended'], // ADR-0023 — amendable via existing admin workflow (Q4)
};

/** Transitions that may only be performed by an admin actor (ADR-0019.1). */
export const ADMIN_ONLY_TRANSITIONS: ReadonlySet<`${BonusPayPeriodState}->${BonusPayPeriodState}`> =
  new Set([
    'draft->skipped',
    'draft->historical_imported', // ADR-0023 Q8 — bulk import is admin-only
    'skipped->historical_imported', // ADR-0023 Q8 — same
  ]);

/** True iff `from -> to` is a legal transition. Self-edges are never legal. */
export function isTransitionAllowed(from: BonusPayPeriodState, to: BonusPayPeriodState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** True iff `from -> to` requires an admin actor (e.g. `draft -> skipped`). */
export function isAdminOnlyTransition(from: BonusPayPeriodState, to: BonusPayPeriodState): boolean {
  return ADMIN_ONLY_TRANSITIONS.has(`${from}->${to}`);
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
    // Admin-only edges (e.g. draft -> skipped) require admin authority. An
    // unattended system transition (label set, no userId) is exempt — the cron
    // never drives an admin-only edge, and a `skipped` disposition is operator-
    // initiated by definition. State + audit are left untouched on refusal.
    if (isAdminOnlyTransition(from, to) && actor.userId && !actor.isAdmin) {
      throw new TransitionForbiddenError(from, to);
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
// resolveOpenPayPeriod / getOrCreateDraftPayPeriod — consumed by T-105
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve the SEEDED `bonus_pay_periods` row for `siteId` whose
 * [period_start, period_end] window CONTAINS `day` (`period_start <= day AND
 * period_end >= day`). Returns `null` when no seeded period covers the day.
 *
 * T-203 / ADR-0019.1: periods are pre-seeded (26/site/year, Wave A T-201) with
 * explicit Tue→Mon boundaries that drift across calendar months. This is a pure
 * lookup by date-range + site — it NEVER fabricates a calendar-month row (the
 * pre-cadence behavior). Periods never overlap, so at most one row matches.
 *
 * `day` must be a @db.Date-shaped key (UTC midnight of the Pacific calendar day);
 * callers pass `entryDateUTC(date)` / `appToday()` from `@/lib/time`.
 */
export async function resolveOpenPayPeriod(
  db: BonusMonthDb,
  siteId: string,
  day: Date,
): Promise<BonusMonthRow | null> {
  return db.bonusPayPeriod.findFirst({
    where: {
      site_id: siteId,
      period_start: { lte: day },
      period_end: { gte: day },
    },
  });
}

/**
 * Back-compat alias retained per the T-202 function-name table. Semantics are now
 * a pure resolve against the seeded periods (no create) — see
 * {@link resolveOpenPayPeriod}. Returns `null` when no seeded period covers `day`;
 * the daily-entry layer surfaces that as a clean "no open pay period" error rather
 * than fabricating a row (ADR-0019.1: periods are pre-seeded).
 */
export const getOrCreateDraftPayPeriod = resolveOpenPayPeriod;

// ────────────────────────────────────────────────────────────────────
// closePayPeriodsDueForSignature — period-end auto-transition (T-204 cron)
// ────────────────────────────────────────────────────────────────────

export interface CloseMonthsResult {
  /** Ids of periods transitioned draft -> pending_signatures. */
  transitioned: string[];
}

/**
 * Find every `draft` period whose `period_end` is exactly the Pacific calendar
 * day of `now` (the closing Monday) and transition it
 * `draft -> pending_signatures`. T-203 / ADR-0019.1 §6: the close decision keys
 * off the SEEDED `period_end` matching today, NOT "the calendar month just ended."
 *
 * `now` is the @db.Date-shaped Pacific "today" key — callers pass `appToday()`
 * from `@/lib/time` (the close cron fires Mon 17:30 PT; deriving "today" from the
 * Pacific zone, not the UTC server clock, is the load-bearing correctness point).
 * The cron supplies `now` so the function stays deterministic and testable.
 *
 * Idempotent: a second fire on the same day re-selects the same row only if it is
 * still `draft`; once transitioned it no longer matches `state = 'draft'`.
 */
export async function closePayPeriodsDueForSignature(
  db: BonusMonthDb,
  now: Date,
): Promise<CloseMonthsResult> {
  const due = await db.bonusPayPeriod.findMany({
    where: { state: 'draft', period_end: { equals: now } },
  });

  const transitioned: string[] = [];
  for (const m of due) {
    await transitionMonth({
      db,
      monthId: m.id,
      to: 'pending_signatures',
      actor: { label: 'system:period-close-cron' },
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
