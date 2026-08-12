// ADR-0019.3 §2 — separation-of-duties exclusion lookup.
//
// The conflict this resolves: a signature-chain signer who is ALSO the subject
// of bonus entries in the period they are being asked to sign. ADR-0019.3 §2
// recorded that condition as knowingly accepted for Patrick Dills (Eugene ops
// signer, 119 historical entries 2025-01-07 → 2026-01-14). These tests pin the
// lookup that turns it into an enforced exclusion.
//
// The link is a REAL foreign key — `bonus_employees.user_id → users.id` — not a
// name or email match. That matters: a name join would be a weak, spoofable
// predicate. The tests assert the query filters on `user_id` through the
// relation so a future refactor cannot silently downgrade it to a name compare.

import { describe, it, expect } from 'vitest';
import { findSodConflict, type SodDb } from './sod-exclusion';

const PERIOD = 'period-2025-01-07';
const PATRICK = 'user-patrick';

/**
 * Double over the ONE query this module issues. `seen` captures the `where` so a
 * test can assert the predicate itself, not merely the boolean it produced — a
 * lookup that returned the right answer via the wrong filter would be a latent
 * defect the boolean alone cannot see.
 */
function makeDb(
  rows: Array<{ periodId: string; userId: string; employeeId: string; name: string }>,
): { db: SodDb; seen: unknown[] } {
  const seen: unknown[] = [];
  const db: SodDb = {
    bonusDailyEntry: {
      findFirst: async (args) => {
        seen.push(args.where);
        const hit = rows.find(
          (r) =>
            r.periodId === args.where.bonus_pay_period_id &&
            r.userId === args.where.bonus_employee.user_id,
        );
        return hit
          ? { bonus_employee_id: hit.employeeId, bonus_employee: { full_name: hit.name } }
          : null;
      },
    },
  };
  return { db, seen };
}

describe('findSodConflict (ADR-0019.3 §2)', () => {
  it('reports a conflict when the signer is the subject of an entry in that period', async () => {
    const { db } = makeDb([
      { periodId: PERIOD, userId: PATRICK, employeeId: 'be-patrick', name: 'Patrick Dills' },
    ]);

    const conflict = await findSodConflict(PERIOD, PATRICK, db);

    expect(conflict).toEqual({ bonusEmployeeId: 'be-patrick', employeeName: 'Patrick Dills' });
  });

  it('reports no conflict when the period holds none of the signer’s entries', async () => {
    // Patrick IS a bonus subject, but not in this period. This is the current /
    // future-period case ADR-0019.3 must leave completely unaffected.
    const { db } = makeDb([
      {
        periodId: 'other-period',
        userId: PATRICK,
        employeeId: 'be-patrick',
        name: 'Patrick Dills',
      },
    ]);

    expect(await findSodConflict(PERIOD, PATRICK, db)).toBeNull();
  });

  it('reports no conflict for a signer with no linked bonus_employee at all', async () => {
    // Rick Albritton: a chain signer who is not a bonus subject. 132 of the 133
    // production bonus_employees rows have a NULL user_id, so this is the
    // overwhelmingly common case and it must cost one indexed read and nothing else.
    const { db } = makeDb([
      { periodId: PERIOD, userId: PATRICK, employeeId: 'be-patrick', name: 'Patrick Dills' },
    ]);

    expect(await findSodConflict(PERIOD, 'user-rick', db)).toBeNull();
  });

  it('filters on the bonus_employee.user_id FK, not a name match', async () => {
    const { db, seen } = makeDb([]);

    await findSodConflict(PERIOD, PATRICK, db);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      bonus_pay_period_id: PERIOD,
      bonus_employee: { user_id: PATRICK },
    });
  });
});
