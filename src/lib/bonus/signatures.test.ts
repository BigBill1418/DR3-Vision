// ADR-0019 §5 — Signature data-layer unit tests (T-110).
//
// Exercises recordSignature + naturalSlotFor directly against an in-memory
// SignatureDb double (no Prisma, no DB). Locks: slot derivation, the
// either-order dual-signature state arithmetic, ip/ua/timestamp capture, the
// total_payout_cents lock on the second signature, re-sign rejection, wrong-
// state rejection, cross-site not-found, and the T-111 override seam.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/observability/metrics', () => ({
  bonusMonthsByState: { inc: vi.fn(), dec: vi.fn() },
}));

import {
  recordSignature,
  naturalSlotFor,
  type SignatureDb,
  type BonusMonthSignatureRow,
  type SignerContext,
} from './signatures';

const WOODLAND = 'site-woodland';

interface Row extends BonusMonthSignatureRow {
  janette_signed_ip: string | null;
  janette_signed_user_agent: string | null;
  morena_signed_ip: string | null;
  morena_signed_user_agent: string | null;
}

let row: Row;
let entries: Array<{ mattress_count: number }>;
const audit: Array<{ action: string; table_name: string; actor_user_id: string | null }> = [];

function makeDb(): SignatureDb {
  const db: SignatureDb = {
    bonusMonth: {
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
    month_start: new Date(Date.UTC(2026, 5, 1)),
    month_end: new Date(Date.UTC(2026, 5, 30)),
    state: 'pending_signatures',
    janette_signed_by_user_id: null,
    janette_signed_at: null,
    janette_signed_ip: null,
    janette_signed_user_agent: null,
    morena_signed_by_user_id: null,
    morena_signed_at: null,
    morena_signed_ip: null,
    morena_signed_user_agent: null,
    total_payout_cents: null,
  };
  entries = [];
  audit.length = 0;
});

describe('naturalSlotFor', () => {
  it('Woodland manager → janette', () => {
    expect(naturalSlotFor(janette)).toBe('janette');
  });
  it('both-sites manager (primary null) → morena', () => {
    expect(naturalSlotFor(morena)).toBe('morena');
  });
  it('admin → null (no natural slot; override is T-111)', () => {
    expect(naturalSlotFor(bill)).toBeNull();
  });
  it('Eugene manager → null', () => {
    expect(naturalSlotFor({ ...janette, primarySiteId: 'site-eugene' })).toBeNull();
  });
});

describe('recordSignature', () => {
  it('Janette first → partially_signed, ip/ua/at captured + audit', async () => {
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: janette,
      ip: '203.0.113.7',
      userAgent: 'UA/1',
    });
    expect(res).toMatchObject({
      ok: true,
      slot: 'janette',
      state: 'partially_signed',
      fullySigned: false,
    });
    expect(row.state).toBe('partially_signed');
    expect(row.janette_signed_by_user_id).toBe('janette');
    expect(row.janette_signed_ip).toBe('203.0.113.7');
    expect(row.janette_signed_user_agent).toBe('UA/1');
    expect(row.janette_signed_at).toBeInstanceOf(Date);
    expect(row.total_payout_cents).toBeNull(); // not locked until second signature
    expect(
      audit.some((a) => a.actor_user_id === 'janette' && a.table_name === 'bonus_months'),
    ).toBe(true);
  });

  it('Morena second → signed, total_payout_cents locked from entries', async () => {
    row.state = 'partially_signed';
    row.janette_signed_by_user_id = 'janette';
    row.janette_signed_at = new Date();
    entries = [{ mattress_count: 75 }, { mattress_count: 60 }]; // 1275 + 500 = 1775
    const res = await recordSignature({ db: makeDb(), monthId: 'm1', signer: morena });
    expect(res).toMatchObject({ ok: true, slot: 'morena', state: 'signed', fullySigned: true });
    expect(row.state).toBe('signed');
    expect(row.morena_signed_by_user_id).toBe('morena');
    expect(row.total_payout_cents).toBe(1775);
  });

  it('signatures may land in either order (Morena first, then Janette)', async () => {
    const r1 = await recordSignature({ db: makeDb(), monthId: 'm1', signer: morena });
    expect(r1).toMatchObject({ ok: true, slot: 'morena', state: 'partially_signed' });
    const r2 = await recordSignature({ db: makeDb(), monthId: 'm1', signer: janette });
    expect(r2).toMatchObject({ ok: true, slot: 'janette', state: 'signed', fullySigned: true });
  });

  it('re-sign of a filled slot → already_signed', async () => {
    row.state = 'partially_signed';
    row.janette_signed_by_user_id = 'janette';
    const res = await recordSignature({ db: makeDb(), monthId: 'm1', signer: janette });
    expect(res).toEqual({ ok: false, reason: 'already_signed', slot: 'janette' });
  });

  it('admin with no override target → no_slot', async () => {
    const res = await recordSignature({ db: makeDb(), monthId: 'm1', signer: bill });
    expect(res).toEqual({ ok: false, reason: 'no_slot' });
  });

  it('signing a non-signature-state month → wrong_state', async () => {
    row.state = 'signed';
    const res = await recordSignature({ db: makeDb(), monthId: 'm1', signer: morena });
    expect(res).toMatchObject({ ok: false, reason: 'wrong_state' });
  });

  it('cross-site month id → not_found', async () => {
    // The month belongs to Eugene; Janette (Woodland-scoped) must not reach it.
    row.site_id = 'site-eugene';
    const res = await recordSignature({ db: makeDb(), monthId: 'm1', signer: janette });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('override seam: onBehalfOf fills the named slot regardless of natural slot', async () => {
    // Bill (admin, no natural slot) can still target Janette's slot via the
    // override path T-111 hardens. T-111 requires a reason; full asymmetric
    // authority + reason/audit coverage lives in signature-override.test.ts.
    const res = await recordSignature({
      db: makeDb(),
      monthId: 'm1',
      signer: bill,
      onBehalfOf: 'janette',
      overrideReason: 'Janette unavailable',
    });
    expect(res).toMatchObject({ ok: true, slot: 'janette', state: 'partially_signed' });
    expect(row.janette_signed_by_user_id).toBe('bill');
  });
});
