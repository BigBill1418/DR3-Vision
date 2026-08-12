// ADR-0019.3 §2 — separation-of-duties enforcement at the signature data layer.
//
// `recordSignature` is the ONLY path that captures a signature (natural, manual
// override, and the 08:30 PT auto-override all funnel through it), so it is the
// only place this guard can be enforced rather than merely displayed. A UI that
// hides the button is not a guard; these tests exercise the data layer directly,
// with no UI in the picture at all.
//
// Fixture is the real Eugene chain as of 2026-08-11 (verified against prod):
//   facility = Rick Albritton      (not a bonus subject)
//   ops      = Patrick Dills       (bonus subject: 119 entries, 27 periods)
//   facility override = [Bill, Patrick]
//   ops override      = [Bill]
//   auto-override actor = Bill
//
// Note the shape of the trap: Patrick sits in `facility_override_actor_ids`. A
// guard that only blocked his NATURAL ops signature would leave him able to sign
// the same conflicted period through the facility slot instead. The exclusion is
// therefore on the (person, period) pair, never on the slot.

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

function makeChainDb(): SignatureChainDb {
  return {
    bonusSignatureChain: {
      findUnique: async ({ where }) =>
        where.site_id === EUGENE
          ? {
              facility_signer_user_id: 'rick',
              facility_override_actor_ids: 'bill,patrick',
              ops_signer_user_id: 'patrick',
              ops_override_actor_ids: 'bill',
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
      findMany: async () => [{ mattress_count: 60, saves: 0 }],
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
      findFirst: async () => ({
        id: 'rule-eu',
        threshold_low: 50,
        rate_low: { toString: () => '0.5000' },
        threshold_high: 74,
        rate_high: { toString: () => '0.2500' },
      }),
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
const bill: SignerContext = {
  userId: 'bill',
  role: 'admin',
  primarySiteId: null,
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

    expect(res).toMatchObject({ ok: false, reason: 'sod_excluded', slot: 'ops' });
  });

  it('writes no signature and leaves the period in pending_signatures', async () => {
    await recordSignature({ db: makeDb(), chainDb, monthId: CONFLICTED, signer: patrick });

    expect(row.ops_signed_by_user_id).toBeNull();
    expect(row.ops_signed_at).toBeNull();
    expect(row.state).toBe('pending_signatures');
  });

  it('refuses an OVERRIDE of the other slot by the same conflicted person', async () => {
    // Patrick is a member of facility_override_actor_ids, so without a
    // (person, period) exclusion he could sign the very same conflicted period
    // through the facility slot. This is the leak the guard must close.
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: patrick,
      onBehalfOf: 'facility',
      overrideReason: 'Rick is out',
    });

    expect(res).toMatchObject({ ok: false, reason: 'sod_excluded', slot: 'facility' });
    expect(row.facility_signed_by_user_id).toBeNull();
  });
});

describe('the override chain is a real route, not a dead end', () => {
  it('lets the ops override actor sign the conflicted slot instead', async () => {
    // ADR-0019.3 §2's requirement is EXCLUSION PLUS ROUTING. An exclusion that
    // left the period unsignable would trade a conflict for a missed payroll
    // deadline, so this test is as load-bearing as the refusals above.
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: bill,
      onBehalfOf: 'ops',
      overrideReason: 'ADR-0019.3 §2 separation-of-duties exclusion',
    });

    expect(res).toMatchObject({ ok: true, slot: 'ops', override: true });
    expect(row.ops_signed_by_user_id).toBe('bill');
  });

  it('lets the unconflicted facility signer sign normally on the same period', async () => {
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: rick,
    });

    expect(res).toMatchObject({ ok: true, slot: 'facility' });
    expect(row.facility_signed_by_user_id).toBe('rick');
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

    expect(res).toMatchObject({ ok: true, slot: 'ops' });
    expect(row.ops_signed_by_user_id).toBe('patrick');
  });

  it('lets a signer with no linked bonus_employee sign a historical period', async () => {
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: CONFLICTED,
      signer: rick,
    });

    expect(res).toMatchObject({ ok: true, slot: 'facility' });
  });
});
