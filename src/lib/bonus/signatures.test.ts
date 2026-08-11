// ADR-0019 §5 — Signature data-layer unit tests (T-110).
//
// Exercises recordSignature + naturalSlotFor directly against an in-memory
// SignatureDb double (no Prisma, no DB). Locks: slot derivation, the
// either-order dual-signature state arithmetic, ip/ua/timestamp capture, the
// total_payout_cents lock on the second signature, re-sign rejection, wrong-
// state rejection, cross-site not-found, and the T-111 override seam.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/observability/metrics', () => ({
  bonusPayPeriodsByState: { inc: vi.fn(), dec: vi.fn() },
}));

import {
  recordSignature,
  naturalSlotFor,
  type SignatureDb,
  type DecimalLike,
  type BonusMonthSignatureRow,
  type SignerContext,
} from './signatures';

const toDec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);
import { clearSignatureChainCache, type SignatureChainDb } from './signature-chain';

const WOODLAND = 'site-woodland';

// Woodland chain double (T-208): facility=Janette, ops=Morena, facility may be
// overridden by Bill+Morena, ops by Bill only, auto-override actor = Bill.
// Outcomes match the pre-T-208 role heuristic exactly — identity is now sourced
// from this row instead of inferred.
function makeChainDb(): SignatureChainDb {
  return {
    bonusSignatureChain: {
      findUnique: async ({ where }) =>
        where.site_id === WOODLAND
          ? {
              facility_signer_user_id: 'janette',
              facility_override_actor_ids: 'bill,morena',
              ops_signer_user_id: 'morena',
              ops_override_actor_ids: 'bill',
              auto_override_actor_user_id: 'bill',
            }
          : null,
    },
  };
}
const chainDb = makeChainDb();

const EUGENE = 'site-eugene';

// Eugene chain double mirroring the seed as of 2026-08-11 — facility=Rick,
// ops=Patrick, facility-override=[bill,patrick], ops-override=[bill], auto=Bill.
// Patrick took the ops slot from Shannon Rockwell (who covered for Kelsey
// Ruhland), reversing the T-312 / ADR-0023 separation-of-duties exclusion.
// Kelsey now occupies NO slot, so she is the fixture for the rejection path.
function makeEugeneChainDb(): SignatureChainDb {
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
const eugeneChainDb = makeEugeneChainDb();

interface Row extends BonusMonthSignatureRow {
  facility_signed_ip: string | null;
  facility_signed_user_agent: string | null;
  ops_signed_ip: string | null;
  ops_signed_user_agent: string | null;
}

let row: Row;
// mattress_count is `Decimal(5,1)` in the schema, so REAL Prisma hands the lock site
// `Prisma.Decimal` objects, not JS numbers. The double therefore allows either shape
// (DecimalLike) so a regression test can push genuine Decimals through the lock path —
// the form that previously zeroed the payout (2026-06 Woodland $0 incident).
let entries: Array<{ mattress_count: DecimalLike }>;
const audit: Array<{ action: string; table_name: string; actor_user_id: string | null }> = [];

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
      // ADR-0083 — the SignatureDb contract requires `saves`. These fixtures
      // are count-only legacy cases, so saves defaults to 0 unless the fixture
      // sets it; supplying it here keeps the double HONEST rather than letting
      // the lock read a shape the real client would never return.
      findMany: async () => entries.map((e) => ({ saves: 0, ...e })),
    },
    processorBonusRule: {
      findFirst: async () => ({
        id: 'rule-wo',
        threshold_low: 50,
        rate_low: { toString: () => '0.5000' },
        threshold_high: 74,
        rate_high: { toString: () => '0.2500' },
      }),
    },
    auditLog: {
      create: async ({ data }) => {
        audit.push({
          action: data['action'] as string,
          table_name: data['table_name'] as string,
          actor_user_id: (data['actor_user_id'] as string | null) ?? null,
        });
        return {};
      },
    },
    $transaction: async (fn) => fn(db),
  };
  return db;
}

const janette: SignerContext = {
  userId: 'janette',
  role: 'manager',
  primarySiteId: WOODLAND,
  siteId: WOODLAND,
};
const morena: SignerContext = {
  userId: 'morena',
  role: 'manager',
  primarySiteId: null,
  siteId: WOODLAND,
};
const bill: SignerContext = {
  userId: 'bill',
  role: 'admin',
  primarySiteId: null,
  siteId: WOODLAND,
};
// Patrick Dills — Eugene manager, holder of the Eugene OPS slot since 2026-08-11.
const patrick: SignerContext = {
  userId: 'patrick',
  role: 'manager',
  primarySiteId: EUGENE,
  siteId: EUGENE,
};
// Kelsey Ruhland — active Eugene manager who held the ops slot until 2026-08-08
// and now occupies none. She is the current stand-in for "a manager the chain
// does not know about", the role Patrick used to play in these tests.
const kelsey: SignerContext = {
  userId: 'kelsey',
  role: 'manager',
  primarySiteId: EUGENE,
  siteId: EUGENE,
};

beforeEach(() => {
  row = {
    id: 'm1',
    site_id: WOODLAND,
    period_start: new Date(Date.UTC(2026, 5, 1)),
    period_end: new Date(Date.UTC(2026, 5, 30)),
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
  entries = [];
  audit.length = 0;
  clearSignatureChainCache(chainDb);
  clearSignatureChainCache(eugeneChainDb);
});

const p = (s: SignerContext) => ({ id: s.userId, role: s.role });

describe('naturalSlotFor (chain-sourced, T-208)', () => {
  it('Woodland facility signer (Janette) → facility', async () => {
    expect(await naturalSlotFor(p(janette), WOODLAND, chainDb)).toBe('facility');
  });
  it('Woodland ops signer (Morena) → ops', async () => {
    expect(await naturalSlotFor(p(morena), WOODLAND, chainDb)).toBe('ops');
  });
  it('admin not configured as a signer → null (no natural slot; override path)', async () => {
    expect(await naturalSlotFor(p(bill), WOODLAND, chainDb)).toBeNull();
  });
  it('a user who is no slot signer at this site → null', async () => {
    expect(await naturalSlotFor({ id: 'rick', role: 'manager' }, WOODLAND, chainDb)).toBeNull();
  });
});

describe('recordSignature', () => {
  it('Janette first → partially_signed, ip/ua/at captured + audit', async () => {
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: 'm1',
      signer: janette,
      ip: '203.0.113.7',
      userAgent: 'UA/1',
    });
    expect(res).toMatchObject({
      ok: true,
      slot: 'facility',
      state: 'partially_signed',
      fullySigned: false,
    });
    expect(row.state).toBe('partially_signed');
    expect(row.facility_signed_by_user_id).toBe('janette');
    expect(row.facility_signed_ip).toBe('203.0.113.7');
    expect(row.facility_signed_user_agent).toBe('UA/1');
    expect(row.facility_signed_at).toBeInstanceOf(Date);
    expect(row.total_payout_cents).toBeNull(); // not locked until second signature
    expect(
      audit.some((a) => a.actor_user_id === 'janette' && a.table_name === 'bonus_pay_periods'),
    ).toBe(true);
  });

  it('Morena second → signed, total_payout_cents locked from entries', async () => {
    row.state = 'partially_signed';
    row.facility_signed_by_user_id = 'janette';
    row.facility_signed_at = new Date();
    entries = [{ mattress_count: 75 }, { mattress_count: 60 }]; // 1275 + 500 = 1775
    const res = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: morena });
    expect(res).toMatchObject({ ok: true, slot: 'ops', state: 'signed', fullySigned: true });
    expect(row.state).toBe('signed');
    expect(row.ops_signed_by_user_id).toBe('morena');
    expect(row.total_payout_cents).toBe(1775);
  });

  // REGRESSION (2026-06 Woodland $0 payroll incident): real Prisma returns
  // `Decimal` mattress_count objects, not JS numbers. Before the fix, the lock site
  // passed raw Decimals to the calculator, `Number.isFinite(Decimal)` was false, every
  // entry contributed 0, and a $2,125.50 period locked to $0 — then went to payroll.
  // This test feeds genuine Decimals through the SAME lock path and asserts the correct
  // non-zero total. It FAILS on the pre-fix code and passes after the `toCount` coercion.
  it('locks correct total when entries carry Prisma Decimal counts (not JS numbers)', async () => {
    row.state = 'partially_signed';
    row.facility_signed_by_user_id = 'janette';
    row.facility_signed_at = new Date();
    // Same counts as the number-based test above, but as real Decimals: 1275 + 500 = 1775.
    entries = [{ mattress_count: toDec(75) }, { mattress_count: toDec(60) }];
    const res = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: morena });
    expect(res).toMatchObject({ ok: true, slot: 'ops', state: 'signed', fullySigned: true });
    expect(row.total_payout_cents).toBe(1775);
    expect(row.total_payout_cents).not.toBe(0); // the exact failure mode being guarded
  });

  // Mirrors the real Woodland period 9b3dc951 shape (fractional-capable Decimal counts):
  // a multi-entry month whose Decimals must sum to a real payout, never $0.
  it('locks a non-zero total across many Decimal entries (Woodland-shaped)', async () => {
    row.state = 'partially_signed';
    row.facility_signed_by_user_id = 'janette';
    row.facility_signed_at = new Date();
    // 80,80,80 → each MAX(80-50,0)*50 + MAX(80-74,0)*25 = 1500 + 150 = 1650; ×3 = 4950.
    entries = [
      { mattress_count: toDec(80) },
      { mattress_count: toDec(80) },
      { mattress_count: toDec(80) },
    ];
    await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: morena });
    expect(row.total_payout_cents).toBe(4950);
  });

  it('signatures may land in either order (Morena first, then Janette)', async () => {
    const r1 = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: morena });
    expect(r1).toMatchObject({ ok: true, slot: 'ops', state: 'partially_signed' });
    const r2 = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: janette });
    expect(r2).toMatchObject({ ok: true, slot: 'facility', state: 'signed', fullySigned: true });
  });

  it('re-sign of a filled slot → already_signed', async () => {
    row.state = 'partially_signed';
    row.facility_signed_by_user_id = 'janette';
    const res = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: janette });
    expect(res).toEqual({ ok: false, reason: 'already_signed', slot: 'facility' });
  });

  it('admin with no override target → no_slot', async () => {
    const res = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: bill });
    expect(res).toEqual({ ok: false, reason: 'no_slot' });
  });

  it('signing a non-signature-state month → wrong_state', async () => {
    row.state = 'signed';
    const res = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: morena });
    expect(res).toMatchObject({ ok: false, reason: 'wrong_state' });
  });

  // T-203: a `skipped` period is inert — the signature workflow refuses it
  // (it is neither pending_signatures nor partially_signed), and nothing is written.
  it('signing a SKIPPED period → wrong_state (signature workflow blocked)', async () => {
    row.state = 'skipped';
    const res = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: morena });
    expect(res).toMatchObject({ ok: false, reason: 'wrong_state' });
    expect(row.ops_signed_by_user_id).toBeNull();
    expect(row.state).toBe('skipped');
    expect(audit.length).toBe(0);
  });

  it('cross-site month id → not_found', async () => {
    // The month belongs to Eugene; Janette (Woodland-scoped) must not reach it.
    row.site_id = 'site-eugene';
    const res = await recordSignature({ db: makeDb(), chainDb, monthId: 'm1', signer: janette });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('override seam: onBehalfOf fills the named slot regardless of natural slot', async () => {
    // Bill (admin, no natural slot) can still target Janette's slot via the
    // override path T-111 hardens. T-111 requires a reason; full asymmetric
    // authority + reason/audit coverage lives in signature-override.test.ts.
    const res = await recordSignature({
      db: makeDb(),
      chainDb,
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'facility',
      overrideReason: 'Janette unavailable',
    });
    expect(res).toMatchObject({ ok: true, slot: 'facility', state: 'partially_signed' });
    expect(row.facility_signed_by_user_id).toBe('bill');
  });
});

// ────────────────────────────────────────────────────────────────────
// A manager outside the Eugene chain is rejected by the signature guard
// ────────────────────────────────────────────────────────────────────
//
// This block used to be "Patrick Dills (T-312) rejected at Eugene". Since
// 2026-08-11 Patrick HOLDS the Eugene ops slot, so the non-member persona is now
// Kelsey Ruhland — an active Eugene manager with bonus VIEW access who occupies
// no slot. The rule under test is unchanged and is membership-driven, not
// person-specific: the SAME recordSignature guard that gates every other signer
// must reject any non-member attempt:
//   - a natural attempt (no onBehalfOf) has no slot      → no_slot
//   - an explicit override attempt at the facility slot  → not_authorized
// The Eugene month exists and is in a signable state, so the rejection is the
// AUTHORIZATION guard firing, not the cross-site not-found path.
describe('a non-chain Eugene manager — rejected by the signature guard', () => {
  function makeEugeneDb(): SignatureDb {
    const erow: Row = {
      id: 'me1',
      site_id: EUGENE,
      period_start: new Date(Date.UTC(2026, 5, 1)),
      period_end: new Date(Date.UTC(2026, 5, 30)),
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
    const db: SignatureDb = {
      bonusPayPeriod: {
        findFirst: async ({ where }) => {
          if (erow.id !== where.id) return null;
          if (where.site_id !== undefined && erow.site_id !== where.site_id) return null;
          return { ...erow };
        },
        update: async ({ data }) => {
          Object.assign(erow, data);
          return { ...erow };
        },
      },
      bonusDailyEntry: { findMany: async () => [] },
      processorBonusRule: {
        findFirst: async () => ({
          id: 'rule-eu',
          threshold_low: 50,
          rate_low: { toString: () => '0.5000' },
          threshold_high: 74,
          rate_high: { toString: () => '0.2500' },
        }),
      },
      auditLog: {
        create: async ({ data }) => {
          audit.push({
            action: data['action'] as string,
            table_name: data['table_name'] as string,
            actor_user_id: (data['actor_user_id'] as string | null) ?? null,
          });
          return {};
        },
      },
      $transaction: async (fn) => fn(db),
    };
    return db;
  }

  it('Kelsey holds no Eugene slot', async () => {
    expect(await naturalSlotFor(p(kelsey), EUGENE, eugeneChainDb)).toBeNull();
  });

  it('natural attempt → no_slot (Kelsey signs no Eugene slot)', async () => {
    const res = await recordSignature({
      db: makeEugeneDb(),
      chainDb: eugeneChainDb,
      monthId: 'me1',
      signer: kelsey,
    });
    expect(res).toEqual({ ok: false, reason: 'no_slot' });
  });

  it('explicit facility-override attempt → not_authorized (in no override list)', async () => {
    const res = await recordSignature({
      db: makeEugeneDb(),
      chainDb: eugeneChainDb,
      monthId: 'me1',
      signer: kelsey,
      onBehalfOf: 'facility',
      overrideReason: 'attempting to sign a slot she no longer holds',
    });
    expect(res).toEqual({ ok: false, reason: 'not_authorized', slot: 'facility' });
  });

  it('no signature or audit row is written on rejection', async () => {
    audit.length = 0;
    const db = makeEugeneDb();
    await recordSignature({
      db,
      chainDb: eugeneChainDb,
      monthId: 'me1',
      signer: kelsey,
      onBehalfOf: 'facility',
      overrideReason: 'attempting to sign a slot she no longer holds',
    });
    const after = await db.bonusPayPeriod.findFirst({ where: { id: 'me1', site_id: EUGENE } });
    expect(after?.facility_signed_by_user_id).toBeNull();
    expect(audit.length).toBe(0);
  });

  // The positive counterpart: the guard must ADMIT the new ops signer. Without
  // this, the block above would still pass if the Eugene chain were empty.
  it('Patrick, the configured ops signer, resolves to the ops slot and signs', async () => {
    expect(await naturalSlotFor(p(patrick), EUGENE, eugeneChainDb)).toBe('ops');
    const res = await recordSignature({
      db: makeEugeneDb(),
      chainDb: eugeneChainDb,
      monthId: 'me1',
      signer: patrick,
    });
    expect(res).toMatchObject({ ok: true, slot: 'ops' });
  });
});
