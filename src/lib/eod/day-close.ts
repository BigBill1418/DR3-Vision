// ADR-0125 — closing the business day.
//
// The Woodland daily-log workbook ends each day because a person looks at it and
// decides it is finished. Vision had no equivalent, so a day with nothing
// recorded and a day a manager reviewed and found genuinely empty were
// byte-identical on every surface. "Not recorded" and "zero" are different
// statements about a business day (ADR-0077 D4, restated for a whole day), and
// the gap flags on the EOD screen are worth nothing without a row that says
// which of the two happened.
//
// TWO OUTCOMES, and the second one is the point. `clean` says every section was
// captured. `exception` says gaps remain AND names them. A close that could only
// be clean would be lied to on the first day something was genuinely still out;
// a close that never recorded the reason would be a checkbox.
//
// CLOSING NEVER LOCKS ANYTHING. The amendment paths — `upsertProcessedUnits`,
// `updateOutbound`, `updateDropoff`, the count-correction window, the ADR-0106
// prior-day equipment write — are untouched by this table and keep working on a
// closed day. This is deliberate and is the opposite of
// `processed_units_daily.closed_at`, which DOES block writes: that column locks
// ONE billing figure that Bill has signed off; this row records that a manager
// reviewed a DAY. Conflating them would make "I have looked at this" a
// destructive act.
//
// Every write here is a compare-and-swap whose `where` restates the state the
// caller believes it is in, and every audit row commits on the same transaction
// as its subject (ADR-0118 D1/D3).

import { Prisma, type EodCloseOutcome } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appToday, dayISO } from '@/lib/time';

const TABLE = 'eod_day_close';

/**
 * Minimum characters for an exception note or a reopen reason.
 *
 * Same floor as `MIN_PRIOR_DAY_REASON_CHARS` in
 * `src/lib/equipment/daily-throughput.ts` (ADR-0106 D3), deliberately: two
 * reason fields on the same manager's screen disagreeing about what counts as
 * an explanation is a small inconsistency that trains people to type "x".
 */
export const MIN_EOD_REASON_CHARS = 4;

/** A close/reopen was refused. `status` is what the route reports. */
export class EodCloseError extends Error {
  readonly status: 409 | 422;
  constructor(
    readonly reason:
      | 'already_closed'
      | 'not_closed'
      | 'note_required'
      | 'note_not_allowed'
      | 'reason_required'
      | 'future_day',
    message: string,
    status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = 'EodCloseError';
    this.status = status;
  }
}

export interface EodDayCloseView {
  id: string;
  siteId: string;
  /** `YYYY-MM-DD` — the Pacific calendar day this close covers. */
  closeDate: string;
  outcome: EodCloseOutcome;
  exceptionNote: string | null;
  /** True when the day stands CLOSED right now. False after a reopen. */
  closed: boolean;
  closedBy: string | null;
  closedAt: Date | null;
  reopenedBy: string | null;
  reopenedAt: Date | null;
  reopenReason: string | null;
  reopenCount: number;
}

interface CloseRow {
  id: string;
  site_id: string;
  close_date: Date;
  outcome: EodCloseOutcome;
  exception_note: string | null;
  closed_by: string | null;
  closed_at: Date | null;
  reopened_by: string | null;
  reopened_at: Date | null;
  reopen_reason: string | null;
  reopen_count: number;
}

function toView(r: CloseRow): EodDayCloseView {
  return {
    id: r.id,
    siteId: r.site_id,
    closeDate: dayISO(r.close_date),
    outcome: r.outcome,
    exceptionNote: r.exception_note,
    closed: r.closed_at !== null,
    closedBy: r.closed_by,
    closedAt: r.closed_at,
    reopenedBy: r.reopened_by,
    reopenedAt: r.reopened_at,
    reopenReason: r.reopen_reason,
    reopenCount: r.reopen_count,
  };
}

/** Collapse a whitespace-only string to null — a required reason cannot be a space bar. */
function clean(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

/**
 * A close is a statement about a day that has happened. Refuse a future day
 * outright rather than letting a mistyped date pre-close tomorrow — the day
 * would then render "closed" to everyone working it, which is the one thing a
 * gap-flag surface must never say wrongly.
 */
function assertNotFuture(closeDate: Date, today: Date): void {
  if (closeDate.getTime() > today.getTime()) {
    throw new EodCloseError(
      'future_day',
      `cannot close ${dayISO(closeDate)} — it is after today (${dayISO(today)})`,
    );
  }
}

/** Read the close state of one (site, day). Null when the day was never closed. */
export async function getEodDayClose(
  siteId: string,
  closeDate: Date,
): Promise<EodDayCloseView | null> {
  const row = await prisma.eodDayClose.findUnique({
    where: { site_id_close_date: { site_id: siteId, close_date: closeDate } },
  });
  return row ? toView(row as CloseRow) : null;
}

/** Read the close state of every day in a range, keyed by `YYYY-MM-DD`. */
export async function listEodDayCloses(
  siteId: string,
  startKey: Date,
  endKey: Date,
): Promise<Map<string, EodDayCloseView>> {
  const rows = await prisma.eodDayClose.findMany({
    where: { site_id: siteId, close_date: { gte: startKey, lte: endKey } },
  });
  return new Map(rows.map((r) => [dayISO(r.close_date), toView(r as CloseRow)]));
}

/**
 * Close a day — clean, or with a named exception.
 *
 * Refuses a second close on an already-closed day (409 `already_closed`). That
 * refusal is NOT decided by a read: the re-close path is an `updateMany` guarded
 * on `closed_at: null`, and the first-close path relies on the
 * `(site_id, close_date)` unique index to raise P2002. Under READ COMMITTED a
 * concurrent close committing between a read and a write is invisible to a check
 * taken before it (ADR-0118 D1), and this screen is reachable from two tabs and
 * from a double-tapped button.
 */
export async function closeEodDay(args: {
  siteId: string;
  closeDate: Date;
  outcome: EodCloseOutcome;
  exceptionNote?: string | null;
  actorUserId: string;
  now?: Date;
}): Promise<EodDayCloseView> {
  const now = args.now ?? new Date();
  assertNotFuture(args.closeDate, appToday(now));

  const note = clean(args.exceptionNote);
  if (args.outcome === 'exception') {
    if (!note) {
      throw new EodCloseError(
        'note_required',
        'closing with an exception requires a note naming what is still outstanding',
      );
    }
    if (note.length < MIN_EOD_REASON_CHARS) {
      throw new EodCloseError(
        'note_required',
        `the exception note must be at least ${MIN_EOD_REASON_CHARS} characters (got ${note.length})`,
      );
    }
  } else if (note) {
    // A note on a `clean` close reads as an unresolved exception to anyone
    // scanning the column. If there is something to say, the close is not clean.
    throw new EodCloseError(
      'note_not_allowed',
      'a clean close carries no note — use close-with-exception to record an open gap',
    );
  }

  const closeFields = {
    outcome: args.outcome,
    exception_note: args.outcome === 'exception' ? note : null,
    closed_by: args.actorUserId,
    closed_at: now,
  };

  return prisma.$transaction(async (tx) => {
    // Path A — the day exists and stands REOPENED. The guard IS the write.
    const reclosed = await tx.eodDayClose.updateMany({
      where: { site_id: args.siteId, close_date: args.closeDate, closed_at: null },
      data: closeFields,
    });
    if (reclosed.count === 1) {
      const row = await tx.eodDayClose.findUniqueOrThrow({
        where: { site_id_close_date: { site_id: args.siteId, close_date: args.closeDate } },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: TABLE,
          row_id: row.id,
          before: { closed: false, reopen_count: row.reopen_count },
          after: {
            closed: true,
            close_date: dayISO(args.closeDate),
            outcome: args.outcome,
            exception_note: closeFields.exception_note,
            reclose: true,
          },
        },
      });
      return toView(row as CloseRow);
    }

    // Path B — no row yet. The unique index is the arbiter, not a prior read: a
    // second closer racing us loses here with P2002 rather than silently
    // writing a second verdict for the same day.
    try {
      const row = await tx.eodDayClose.create({
        data: { site_id: args.siteId, close_date: args.closeDate, ...closeFields },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'insert',
          table_name: TABLE,
          row_id: row.id,
          after: {
            close_date: dayISO(args.closeDate),
            outcome: args.outcome,
            exception_note: closeFields.exception_note,
          },
        },
      });
      return toView(row as CloseRow);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new EodCloseError(
          'already_closed',
          `${dayISO(args.closeDate)} is already closed — reopen it with a reason before closing it again`,
          409,
        );
      }
      throw e;
    }
  });
}

/**
 * Reopen a closed day. The reason is REQUIRED and is recorded twice: on the row
 * (the current state) and on an append-only audit row (the history), because a
 * later reopen overwrites the row's copy and hard rule #6 says the audit log is
 * the permanent record.
 *
 * Refusing on `closed_at: { not: null }` rather than on a prior read is the same
 * ADR-0118 D1 point as `closeEodDay`: two managers reopening the same day would
 * otherwise both pass a check and both write, and the second would silently
 * overwrite the first one's reason with its own while `reopen_count` counted one.
 */
export async function reopenEodDay(args: {
  siteId: string;
  closeDate: Date;
  reason: string;
  actorUserId: string;
  now?: Date;
}): Promise<EodDayCloseView> {
  const now = args.now ?? new Date();
  const reason = clean(args.reason);
  if (!reason) {
    throw new EodCloseError('reason_required', 'reopening a closed day requires a reason');
  }
  if (reason.length < MIN_EOD_REASON_CHARS) {
    throw new EodCloseError(
      'reason_required',
      `the reopen reason must be at least ${MIN_EOD_REASON_CHARS} characters (got ${reason.length})`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.eodDayClose.updateMany({
      where: { site_id: args.siteId, close_date: args.closeDate, closed_at: { not: null } },
      data: {
        closed_by: null,
        closed_at: null,
        reopened_by: args.actorUserId,
        reopened_at: now,
        reopen_reason: reason,
        reopen_count: { increment: 1 },
      },
    });
    if (count === 0) {
      throw new EodCloseError(
        'not_closed',
        `${dayISO(args.closeDate)} is not closed — there is nothing to reopen`,
        409,
      );
    }
    const row = await tx.eodDayClose.findUniqueOrThrow({
      where: { site_id_close_date: { site_id: args.siteId, close_date: args.closeDate } },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: row.id,
        before: { closed: true, outcome: row.outcome },
        after: {
          closed: false,
          close_date: dayISO(args.closeDate),
          reopened: true,
          reopen_reason: reason,
          reopen_count: row.reopen_count,
        },
      },
    });
    return toView(row as CloseRow);
  });
}
