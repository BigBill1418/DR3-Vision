// ADR-0085 — the money-minting predicate, and the regression it closes.
//
// `defaultIncentiveAmountCents` used to read:
//
//     if (kind === 'incentive') return null;
//     return units * UNPAID_DROPOFF_CENTS_PER_UNIT;
//
// which is an allowlist of ONE, guarding the wrong side. The policy it encodes
// is *every drop-off kind mints $3/unit of Bye-Bye-Mattress check money except
// the single named exception* — so adding any enum value enrolled it in a payout
// silently, at both sites, forever.
//
// These are unit tests with no database and no mock, because the thing under
// test is a pure decision about kinds. The DATABASE half of the same guarantee
// (that a row carrying money is refused by `consumer_dropoffs_floor_no_money_or_pii`
// even if this function is bypassed entirely) is proven against real Postgres in
// `floor-dropoff.db.test.ts`. Two layers, two suites, neither standing in for
// the other.

import { describe, expect, it } from 'vitest';
import type { ConsumerDropoffKind } from '@prisma/client';
import { __mintsCheckMoneyByDefaultForTest as mints, UNPAID_DROPOFF_CENTS_PER_UNIT } from './service';

describe('ADR-0085 — which drop-off kinds mint check money', () => {
  it('the two Bye-Bye-Mattress kinds still mint — this ADR changed no existing behaviour', () => {
    // Guarding the guard: the point of the rewrite was to stop NEW kinds minting,
    // not to stop the ones that are supposed to. A version of this change that
    // quietly switched off `unpaid`/`illegal` would break the office's check run
    // and would otherwise look identical in the diff.
    expect(mints('unpaid'), 'unpaid stopped minting the $3/unit check amount').toBe(true);
    expect(mints('illegal'), 'illegal stopped minting the $3/unit check amount').toBe(true);
  });

  it('incentive does not — it carries the rule-capped incentive_cents instead', () => {
    expect(mints('incentive')).toBe(false);
  });

  it('the label-only floor kinds mint nothing', () => {
    expect(mints('floor_public'), 'a Public walk-up minted check money').toBe(false);
    expect(mints('floor_incentive'), 'an Incentive walk-up minted check money').toBe(false);
  });

  it('FALSIFICATION — a kind this file has never heard of mints NOTHING', () => {
    // The case the compiler cannot see and the enum cannot express: a migration
    // that ships a label before the code that knows about it, a value arriving
    // through an `as` cast, a row written by an older deploy. Under the OLD
    // predicate this returned `units × 300`; under the new one the runtime floor
    // denies it.
    //
    // The cast is the whole point — this is unreachable through `createDropoff`,
    // because zod rejects the value at the route and TypeScript rejects it at the
    // call site. A guard whose failure mode cannot be exercised is a guard nobody
    // has ever checked, which is exactly how the original inversion survived a
    // year of review.
    const futureKind = 'some_future_kind_nobody_has_written_yet' as ConsumerDropoffKind;

    const wouldHaveMinted = 4 * UNPAID_DROPOFF_CENTS_PER_UNIT;
    expect(wouldHaveMinted).toBe(1200);

    expect(
      mints(futureKind),
      `an unclassified drop-off kind was enrolled in the $3/unit payout — 4 units would ` +
        `have written ${wouldHaveMinted}¢ of check money nobody decided to pay`,
    ).toBe(false);
  });

  it('the OLD predicate would have failed the test above — the regression is real', () => {
    // Stated as executable history rather than as a comment. This is the exact
    // shipped expression, and it says `true` for both the new floor kinds and for
    // an unknown one. Without this, "the old code minted money on new kinds" is a
    // claim in an ADR; with it, it is a run.
    const oldPredicate = (kind: ConsumerDropoffKind): boolean => kind !== 'incentive';

    expect(oldPredicate('floor_public')).toBe(true);
    expect(oldPredicate('floor_incentive')).toBe(true);
    expect(oldPredicate('anything_at_all' as ConsumerDropoffKind)).toBe(true);

    // …and the new one disagrees on every one of them.
    expect(mints('floor_public')).toBe(false);
    expect(mints('floor_incentive')).toBe(false);
    expect(mints('anything_at_all' as ConsumerDropoffKind)).toBe(false);
  });
});
