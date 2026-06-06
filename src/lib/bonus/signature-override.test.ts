// ADR-0019 §5 — Signature OVERRIDE authority unit tests (T-111).
//
// Companion to signatures.test.ts (do NOT overwrite that file). Exercises the
// asymmetric override authority added in T-111:
//
//   - Bill (admin) may override EITHER slot.
//   - Morena (both-sites ops manager, primary_site_id = null) may override
//     Janette's slot ONLY — and is REJECTED for Morena's own slot via override
//     (she signs her own slot naturally, never "on behalf of" herself).
//   - Janette (Woodland facility manager) may override NEITHER slot.
//
// And: a successful override records the slot's signed_* columns AS the actual
// signer, PLUS *_override_actor_id + *_override_reason, and writes an audit row
// carrying actor + slot + reason. A missing/blank reason is rejected.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/observability/metrics', () => ({
  bonusPayPeriodsByState: { inc: vi.fn(), dec: vi.fn() },
}));

import {
  recordSignature,
  canOverrideSlot,
  type SignatureDb,
  type BonusMonthSignatureRow,
  type SignerContext,
} from './signatures';

const WOODLAND = 'site-woodland';

interface Row extends BonusMonthSignatureRow {
  facility_signed_ip: string | null;
  facility_signed_user_agent: string | null;
  facility_override_actor_id: string | null;
  facility_override_reason: string | null;
  ops_signed_ip: string | null;
  ops_signed_user_agent: string | null;
  ops_override_actor_id: string | null;
  ops_override_reason: string | null;
}

let row: Row;
let entries: Array<{ mattress_count: number }>;
const audit: Array<{
  action: string;
  table_name: string;
  actor_user_id: string | null;
  after: Record<string, unknown>;
}> = [];

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
      findMany: async () => entries.map((e) => ({ ...e })),
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
          after: (data['after'] as Record<string, unknown>) ?? {},
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
    facility_override_actor_id: null,
    facility_override_reason: null,
    ops_signed_by_user_id: null,
    ops_signed_at: null,
    ops_signed_ip: null,
    ops_signed_user_agent: null,
    ops_override_actor_id: null,
    ops_override_reason: null,
    total_payout_cents: null,
  };
  entries = [];
  audit.length = 0;
});

describe('canOverrideSlot — asymmetric authority (ADR-0019 §5)', () => {
  it('admin (Bill) may override BOTH slots', () => {
    expect(canOverrideSlot(bill, 'facility')).toBe(true);
    expect(canOverrideSlot(bill, 'ops')).toBe(true);
  });

  it('both-sites ops manager (Morena) may override Janette slot ONLY', () => {
    expect(canOverrideSlot(morena, 'facility')).toBe(true);
    expect(canOverrideSlot(morena, 'ops')).toBe(false);
  });

  it('Woodland facility manager (Janette) may override NEITHER slot', () => {
    expect(canOverrideSlot(janette, 'facility')).toBe(false);
    expect(canOverrideSlot(janette, 'ops')).toBe(false);
  });
});

describe('recordSignature — override path', () => {
  it('Bill overrides Janette slot: records signed_* as Bill + override actor/reason + audit', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'facility',
      overrideReason: 'Janette on leave',
      ip: '203.0.113.9',
      userAgent: 'UA/override',
    });
    expect(res).toMatchObject({
      ok: true,
      slot: 'facility',
      state: 'partially_signed',
      override: true,
    });
    expect(row.facility_signed_by_user_id).toBe('bill');
    expect(row.facility_signed_ip).toBe('203.0.113.9');
    expect(row.facility_override_actor_id).toBe('bill');
    expect(row.facility_override_reason).toBe('Janette on leave');
    const a = audit.find((x) => x.table_name === 'bonus_pay_periods' && x.actor_user_id === 'bill');
    expect(a).toBeDefined();
    expect(a!.after).toMatchObject({
      slot: 'facility',
      override: true,
      override_reason: 'Janette on leave',
    });
  });

  it('Bill overrides Morena slot (admin-only) succeeds', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'ops',
      overrideReason: 'Morena unreachable',
    });
    expect(res).toMatchObject({ ok: true, slot: 'ops', override: true });
    expect(row.ops_signed_by_user_id).toBe('bill');
    expect(row.ops_override_actor_id).toBe('bill');
    expect(row.ops_override_reason).toBe('Morena unreachable');
  });

  it('Morena overrides Janette slot succeeds + records override actor/reason', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: morena,
      onBehalfOf: 'facility',
      overrideReason: 'covering for Janette',
    });
    expect(res).toMatchObject({ ok: true, slot: 'facility', override: true });
    expect(row.facility_signed_by_user_id).toBe('morena');
    expect(row.facility_override_actor_id).toBe('morena');
    expect(row.facility_override_reason).toBe('covering for Janette');
  });

  it('Morena CANNOT override Morena slot → not_authorized', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: morena,
      onBehalfOf: 'ops',
      overrideReason: 'should be rejected',
    });
    expect(res).toEqual({ ok: false, reason: 'not_authorized', slot: 'ops' });
    expect(row.ops_signed_by_user_id).toBeNull();
  });

  it('Janette CANNOT override Janette slot via override path → not_authorized', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: janette,
      onBehalfOf: 'facility',
      overrideReason: 'self-override attempt',
    });
    expect(res).toEqual({ ok: false, reason: 'not_authorized', slot: 'facility' });
  });

  it('Janette CANNOT override Morena slot → not_authorized', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: janette,
      onBehalfOf: 'ops',
      overrideReason: 'nope',
    });
    expect(res).toEqual({ ok: false, reason: 'not_authorized', slot: 'ops' });
  });

  it('override with missing reason → missing_reason (no DB write)', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'facility',
    });
    expect(res).toEqual({ ok: false, reason: 'missing_reason', slot: 'facility' });
    expect(row.facility_signed_by_user_id).toBeNull();
  });

  it('override with blank/whitespace reason → missing_reason', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'facility',
      overrideReason: '   ',
    });
    expect(res).toEqual({ ok: false, reason: 'missing_reason', slot: 'facility' });
  });

  it('override reason is trimmed before persisting', async () => {
    await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'facility',
      overrideReason: '  Janette out sick  ',
    });
    expect(row.facility_override_reason).toBe('Janette out sick');
  });

  it('override of an already-signed slot → already_signed (authority passes first, then slot check)', async () => {
    row.state = 'partially_signed';
    row.facility_signed_by_user_id = 'janette';
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'facility',
      overrideReason: 'Janette out',
    });
    expect(res).toMatchObject({ ok: false, reason: 'already_signed', slot: 'facility' });
  });

  it('Bill override completing the month → signed + override actor preserved', async () => {
    row.state = 'partially_signed';
    row.ops_signed_by_user_id = 'morena';
    row.ops_signed_at = new Date();
    entries = [{ mattress_count: 75 }, { mattress_count: 60 }]; // 1275 + 500 = 1775
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'facility',
      overrideReason: 'Janette unavailable for close',
    });
    expect(res).toMatchObject({
      ok: true,
      slot: 'facility',
      state: 'signed',
      fullySigned: true,
      override: true,
    });
    expect(row.facility_override_actor_id).toBe('bill');
    expect(row.total_payout_cents).toBe(1775);
  });

  it('non-override (natural) signature still works and is NOT marked override', async () => {
    const res = await recordSignature({ db: makeDb(), monthId: 'm1', signer: janette });
    expect(res).toMatchObject({ ok: true, slot: 'facility', override: false });
    expect(row.facility_override_actor_id).toBeNull();
    expect(row.facility_override_reason).toBeNull();
  });
});
