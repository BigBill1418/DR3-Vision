// ADR-0019.3 §2 — separation-of-duties enforcement at the signature data layer.
//
// `recordSignature` is the ONLY path that captures a signature (natural, manual
// override, and the 08:30 PT auto-override all funnel through it), so it is the
// only place this guard can be enforced rather than merely displayed. A UI that
// hides the button is not a guard; these tests exercise the data layer directly,
// with no UI in the picture at all.
//
// Fixture is the Eugene chain from ADR-0019.7 (2026-10-07, Bill option "a"):
//   facility = Patrick Dills       (bonus subject: 119 entries, 27 periods, last 2026-01-14)
//   ops      = Rick Albritton      (not a bonus subject)
//   facility override = [Bill, Rick]
//   ops override      = [Bill]
//   auto-override actor = Bill
// (2026-08-11 → 2026-10-07 the slots were the other way round; ADR-0019.3.)
//
// The shape of the trap: a person who holds a natural slot AND sits in the other
// slot's override list. A guard that only blocked the natural signature would
// leave them able to sign the same conflicted period through the other slot. The
// exclusion is therefore on the (person, period) pair, never on the slot; the
// override-leak test below builds that configuration explicitly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/observability/metrics', () => ({
  bonusPayPeriodsByState: { inc: vi.fn(), dec: vi.fn() },
}));

import {
  recordSignature,
  type SignatureDb,
  type BonusMonthSignatureRow,
  type SignerContext,
} from './signatures';
import { clearSignatureChainCache, type SignatureChainDb } from './signature-chain';

const EUGENE = 'site-eugene';
/** The amended historical period that carries Patrick's own bonus rows. */
const CONFLICTED = 'period-2025-01-07';
/** A period with no entries of Patrick's — the current/future case. */
const CLEAN = 'period-2026-08-11';

function makeChainDb(opsOverride = 'bill'): SignatureChainDb {
  return {
    bonusSignatureChain: {
      findUnique: async ({ where }) =>
        where.site_id === EUGENE
          ? {
              facility_signer_user_id: 'patrick',
              facility_override_actor_ids: 'bill,rick',
              ops_signer_user_id: 'rick',
              ops_override_actor_ids: opsOverride,
              auto_override_actor_user_id: 'bill',
            }
          : null,
    },
  };
}
let chainDb: SignatureChainDb;

interface Row extends BonusMonthSignatureRow {
  facility_signed_ip: string | null;
  facility_signed_user_agent: string | null;
  ops_signed_ip: string | null;
  ops_signed_user_agent: string | null;
}

let row: Row;

/**
 * Only Patrick is a bonus subject, and only in CONFLICTED. This mirrors prod
 * exactly: 1 of 133 `bonus_employees` rows carries a non-NULL `user_id`.
 */
const SUBJECT_ENTRIES = [
  { periodId: CONFLICTED, userId: 'patrick', employeeId: 'be-patrick', name: 'Patrick Dills' },
];

function makeDb(): SignatureDb {
  const db: SignatureDb = {
    bonusPayPeriod: {
      findFirst: async ({ where }) => {
        if (row.id !== where.id) return null;
        if (where.site_id !== undefined && row.site_id !== where.site_id) return null;
        return { ...row };
      },
      update: async ({ data }) => {
        Object.assign(row, data);
        return { ...row };
      },
    },
    bonusDailyEntry: {
      findMany: async () => [
        { entry_date: new Date(Date.UTC(2026, 4, 5)), mattress_count: 60, saves: 0 },
      ],
      // The separation-of-duties read (ADR-0019.3 §2). Declared REQUIRED on
      // SignatureDb so a test double cannot omit it and silently disable the
      // guard — the same truthful-typing discipline `saves` is declared under.
      findFirst: async ({ where }) => {
        const hit = SUBJECT_ENTRIES.find(
          (e) =>
            e.periodId === where.bonus_pay_period_id && e.userId === where.bonus_employee.user_id,
        );
        return hit
          ? { bonus_employee_id: hit.employeeId, bonus_employee: { full_name: hit.name } }
          : null;
      },
    },
    processorBonusRule: {
      // ADR-0019.6 — the lock loads the site rule book and prices each entry
      // by its own entry_date; one open-ended row covers every fixture day.
      findMany: async () => [
        {
          id: 'rule-eu',
          threshold_low: 50,
          rate_low: { toString: () => '0.5000' },
          threshold_high: 74,
          rate_high: { toString: () => '0.2500' },
          effective_date: new Date(Date.UTC(2000, 0, 1)),
          end_date: null,
        },
      ],
    },
    auditLog: { create: async () => ({}) },
    $transaction: async (fn) => fn(db),
  };
  return db;
}

function makeRow(id: string): Row {
  return {
    id,
    site_id: EUGENE,
    period_start: new Date('2025-01-07T00:00:00Z'),
    period_end: new Date('2025-01-20T00:00:00Z'),
    state: 'pending_signatures',
    facility_signed_by_user_id: null,
    facility_signed_at: null,
    facility_signed_ip: null,
    facility_signed_user_agent: null,
    ops_signed_by_user_id: null,
    ops_signed_at: null,
    ops_signed_ip: null,
    ops_signed_user_agent: null,
    total_payout_cents: null,
  };
}

const patrick: SignerContext = {
  userId: 'patrick',
  role: 'manager',
  primarySiteId: EUGENE,
  siteId: EUGENE,
};
const rick: SignerContext = {
  userId: 'rick',
  role: 'manager',
  primarySiteId: EUGENE,
  siteId: EUGENE,
};

beforeEach(() => {
  chainDb = makeChainDb();
  clearSignatureChainCache(chainDb);
  row = makeRow(CONFLICTED);
});

describe('conflicted signer on a period containing their own bonus entries', () => {
  it('refuses the natural signature and names the exclusion', async () => {
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: patrick,
    });

    expect(res).toMatchObject({ ok: false, reason: 'sod_excluded', slot: 'facility' });
  });

  it('writes no signature and leaves the period in pending_signatures', async () => {
    await recordSignature({ db: makeDb(), chainDb, monthId: CONFLICTED, signer: patrick });

    expect(row.facility_signed_by_user_id).toBeNull();
    expect(row.facility_signed_at).toBeNull();
    expect(row.state).toBe('pending_signatures');
  });

  it('refuses an OVERRIDE of the other slot by the same conflicted person', async () => {
    // Put Patrick in ops_override_actor_ids: without a (person, period)
    // exclusion he could then sign the very same conflicted period through the
    // ops slot. This is the leak the guard must close.
    chainDb = makeChainDb('bill,patrick');
    clearSignatureChainCache(chainDb);
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: patrick,
      onBehalfOf: 'ops',
      overrideReason: 'Rick is out',
    });

    expect(res).toMatchObject({ ok: false, reason: 'sod_excluded', slot: 'ops' });
    expect(row.ops_signed_by_user_id).toBeNull();
  });
});

describe('the override chain is a real route, not a dead end', () => {
  it('lets a facility override actor sign the conflicted slot instead', async () => {
    // ADR-0019.3 §2's requirement is EXCLUSION PLUS ROUTING. An exclusion that
    // left the period unsignable would trade a conflict for a missed payroll
    // deadline, so this test is as load-bearing as the refusals above.
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: rick,
      onBehalfOf: 'facility',
      overrideReason: 'ADR-0019.3 §2 separation-of-duties exclusion',
    });

    expect(res).toMatchObject({ ok: true, slot: 'facility', override: true });
    expect(row.facility_signed_by_user_id).toBe('rick');
  });

  it('lets the unconflicted ops signer sign normally on the same period', async () => {
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: rick,
    });

    expect(res).toMatchObject({ ok: true, slot: 'ops' });
    expect(row.ops_signed_by_user_id).toBe('rick');
  });
});

describe('scope: everything outside the conflict is untouched', () => {
  it('lets the conflicted signer sign a period holding none of their entries', async () => {
    row = makeRow(CLEAN);

    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CLEAN,
      signer: patrick,
    });

    expect(res).toMatchObject({ ok: true, slot: 'facility' });
    expect(row.facility_signed_by_user_id).toBe('patrick');
  });

  it('lets a signer with no linked bonus_employee sign a historical period', async () => {
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: rick,
    });

    expect(res).toMatchObject({ ok: true, slot: 'ops' });
  });
});
