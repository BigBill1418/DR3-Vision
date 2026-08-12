// ADR-0019.3 §2 — separation-of-duties exclusion for bonus signatures.
//
// ADR-0019.3 installed Patrick Dills in the Eugene ops-signer slot, knowingly
// reversing the ADR-0023 / T-312 exclusion that had kept him out of every chain
// slot because he is also a Eugene `BonusEmployee`. §2 recorded the residual
// risk in plain terms — he is now the default approver and signer for periods
// that contain his own bonus rows (119 entries across 27 periods, 2025-01-07 →
// 2026-01-14) — and noted that the DB CHECK prevents `requester == approver`,
// not `approver-has-an-interest`.
//
// This module is the guard that closes it. The rule is deliberately narrow:
//
//   A person may not sign a pay period that contains bonus entries attributable
//   to their own linked bonus_employee.
//
// It says nothing about roles, sites, states or dates. "Historical" is not a
// state test — a period is conflicted for a person precisely when it holds their
// entries, which is what makes the current/future case fall out for free rather
// than needing a carve-out. Patrick's `bonus_employees` row is `is_active=false`,
// so he accrues nothing going forward and no current period can be conflicted
// for him; the guard therefore costs one indexed read and changes nothing about
// normal operation.
//
// THE LINK IS A REAL FOREIGN KEY. `bonus_employees.user_id → users.id` is a
// declared Prisma relation, not a name or email heuristic, so the join is exact.
// In production exactly 1 of 133 `bonus_employees` rows carries a non-NULL
// `user_id` (Patrick's), which is both the blast radius of this guard and the
// reason it is cheap.

/**
 * The conflict, when there is one. Carries the employee identity so the caller
 * can say WHO the person is a subject of rather than emitting a bare boolean —
 * an operator reading a 403 needs to know why they are being refused.
 */
export interface SodConflict {
  bonusEmployeeId: string;
  employeeName: string;
}

/**
 * Structural type for the one query this module issues. Declared here (rather
 * than importing `PrismaClient`) so the check is testable without a database and
 * composable inside the signature transaction handle.
 */
export interface SodDb {
  bonusDailyEntry: {
    findFirst(args: {
      where: {
        bonus_pay_period_id: string;
        /** Relation filter on the FK — NOT a name match. */
        bonus_employee: { user_id: string };
      };
      select: {
        bonus_employee_id: true;
        bonus_employee: { select: { full_name: true } };
      };
    }): Promise<{ bonus_employee_id: string; bonus_employee: { full_name: string } } | null>;
  };
}

/**
 * Resolve whether `userId` is a bonus subject within `periodId`.
 *
 * One indexed read: `bonus_daily_entries` is indexed on `bonus_pay_period_id`,
 * and the relation filter resolves through the `bonus_employee_id` FK. Returns
 * the FIRST matching entry's employee — existence is the whole question, so
 * there is no reason to count.
 */
export async function findSodConflict(
  periodId: string,
  userId: string,
  db: SodDb,
): Promise<SodConflict | null> {
  const hit = await db.bonusDailyEntry.findFirst({
    where: {
      bonus_pay_period_id: periodId,
      bonus_employee: { user_id: userId },
    },
    select: {
      bonus_employee_id: true,
      bonus_employee: { select: { full_name: true } },
    },
  });
  if (!hit) return null;
  return {
    bonusEmployeeId: hit.bonus_employee_id,
    employeeName: hit.bonus_employee.full_name,
  };
}
