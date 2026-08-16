// ADR-0104 §D5 — the decide services that P-46 exists because ADR-0080 lacked.
//
// `doc_commodity_audit_rows` has held 252 `staged` rows since ADR-0080 shipped
// with no confirm control anywhere in the product. These tests are the proof
// that the two new staging classes are not the same shape twice more.
//
// What they pin, and why each one is a specific past defect rather than
// coverage:
//   - CHILD ROWS MOVE WITH THE PARENT. A discarded batch whose per-commodity
//     weights stayed `staged` would leave rejected figures readable, and a
//     confirmed batch whose children stayed staged would report a load total
//     with no commodity split. Both directions are asserted.
//   - THE TOTALS ARE CAPTURED BEFORE THE UPDATE. A CHECK constraint already
//     records WHO confirmed; `totals_accepted` answers the harder question of
//     WHAT THEY WERE LOOKING AT. Read afterwards it would be a tautology.
//   - THE ACTOR IS `{userId}` XOR `{label}` (ADR-0077). A named non-human run
//     must never borrow a `users.id`.

import { describe, expect, it, beforeEach, vi } from 'vitest';

interface Row {
  id: string;
  doc_source_version_id: string;
  status: string;
  total_weight_lbs?: number | null;
  amount?: number | null;
  credit_amount?: number | null;
  confirmed_at?: Date | null;
  confirmed_by?: string | null;
  discarded_at?: Date | null;
  discarded_by?: string | null;
  discard_reason?: string | null;
}

const store = {
  loads: [] as Row[],
  commodities: [] as Row[],
  expenses: [] as Row[],
  audits: [] as Record<string, unknown>[],
  /** Order of operations, so "before the update" is measured rather than assumed. */
  ops: [] as string[],
};

function table(rows: () => Row[], name: string) {
  return {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      store.ops.push(`read:${name}`);
      return rows().filter(
        (r) =>
          r.doc_source_version_id === where['doc_source_version_id'] &&
          r.status === where['status'],
      );
    }),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows().filter(
        (r) =>
          r.doc_source_version_id === where['doc_source_version_id'] &&
          r.status === where['status'],
      ).length,
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        store.ops.push(`write:${name}`);
        const hit = rows().filter(
          (r) =>
            r.doc_source_version_id === where['doc_source_version_id'] &&
            r.status === where['status'],
        );
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    ),
  };
}

const client = {
  docOutboundLoadRow: table(() => store.loads, 'loads'),
  docOutboundCommodityRow: table(() => store.commodities, 'commodities'),
  docFacilityExpenseRow: table(() => store.expenses, 'expenses'),
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    store.ops.push('tx:begin');
    const out = await fn(client);
    store.ops.push('tx:end');
    return out;
  }),
};

// The factory is hoisted, so it must not close over `client` directly.
vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return client;
  },
}));
vi.mock('@/lib/audit', () => ({
  writeAudit: vi.fn(async (row: Record<string, unknown>) => {
    store.audits.push(row);
  }),
}));

import { decideOutboundBatch } from '../outbound-decide';
import { decideFacilityExpenseBatch } from '../facility-expense-decide';

const V = 'ver-1';
const NOW = new Date('2026-08-15T18:00:00.000Z');

beforeEach(() => {
  store.loads = [
    { id: 'l1', doc_source_version_id: V, status: 'staged', total_weight_lbs: 8100 },
    { id: 'l2', doc_source_version_id: V, status: 'staged', total_weight_lbs: 7420 },
    // Already decided in an earlier pass — must not be touched again.
    { id: 'l3', doc_source_version_id: V, status: 'confirmed', total_weight_lbs: 999 },
  ];
  store.commodities = [
    { id: 'c1', doc_source_version_id: V, status: 'staged' },
    { id: 'c2', doc_source_version_id: V, status: 'staged' },
    { id: 'c3', doc_source_version_id: V, status: 'staged' },
  ];
  store.expenses = [
    { id: 'e1', doc_source_version_id: V, status: 'staged', amount: 900, credit_amount: null },
    { id: 'e2', doc_source_version_id: V, status: 'staged', amount: null, credit_amount: 250 },
  ];
  store.audits = [];
  store.ops = [];
});

describe('decideOutboundBatch', () => {
  it('confirms parent AND child in ONE transaction, and captures what was on screen', async () => {
    const result = await decideOutboundBatch('confirm', {
      versionId: V,
      actor: { userId: 'user-bill' },
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, action: 'confirm', rows: 2, commodityRows: 3 });
    expect(store.loads.filter((r) => r.status === 'confirmed').map((r) => r.id)).toEqual([
      'l1',
      'l2',
      'l3',
    ]);
    expect(store.commodities.every((r) => r.status === 'confirmed')).toBe(true);
    expect(store.loads[0]?.confirmed_by).toBe('user-bill');
    expect(store.loads[0]?.confirmed_at).toEqual(NOW);

    // Both writes inside one transaction. A child flipped outside it could
    // survive a parent rollback.
    const begin = store.ops.indexOf('tx:begin');
    const end = store.ops.indexOf('tx:end');
    expect(store.ops.indexOf('write:loads')).toBeGreaterThan(begin);
    expect(store.ops.indexOf('write:commodities')).toBeLessThan(end);

    // The totals were computed from the STAGED rows before anything moved —
    // 8100 + 7420, and NOT the 999 of the already-confirmed row.
    const audit = store.audits.at(0);
    expect(audit?.['table_name']).toBe('doc_outbound_load_rows');
    expect((audit?.['after'] as Record<string, unknown>)['totals_accepted']).toEqual({
      loads: 2,
      total_weight_lbs: 15520,
      commodity_rows: 3,
    });
  });

  it('reads the totals BEFORE the update, not after', async () => {
    await decideOutboundBatch('confirm', { versionId: V, actor: { userId: 'u' }, now: NOW });
    // Read-then-write. Reversed, the read would find zero staged rows and the
    // audit row would record `0 loads` for a batch of two — a totals capture
    // that is always empty is worse than none, because it looks like evidence.
    expect(store.ops.indexOf('read:loads')).toBeLessThan(store.ops.indexOf('write:loads'));
  });

  it('discards parent AND child with the reason, and records what was rejected', async () => {
    const result = await decideOutboundBatch('discard', {
      versionId: V,
      actor: { userId: 'user-bill' },
      reason: 'the workbook was mid-edit',
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, action: 'discard', rows: 2, commodityRows: 3 });
    expect(store.loads[0]?.discard_reason).toBe('the workbook was mid-edit');
    // The child moves too. Leaving it `staged` would keep a REJECTED
    // per-commodity weight readable at staged scope for ever.
    expect(store.commodities.every((r) => r.status === 'discarded')).toBe(true);
    expect((store.audits[0]?.['after'] as Record<string, unknown>)['totals_rejected']).toMatchObject(
      { loads: 2, total_weight_lbs: 15520 },
    );
  });

  it('writes actor_label with a NULL actor_user_id for a named non-human run', async () => {
    await decideOutboundBatch('confirm', {
      versionId: V,
      actor: { label: 'system:adr-0104-execution' },
      now: NOW,
    });
    const audit = store.audits.at(0);
    // ADR-0077's actor discipline: `{userId}` XOR `{label}`. A run that borrowed
    // a `users.id` would put a person's attestation on a decision they did not
    // take.
    expect(audit?.['actor_label']).toBe('system:adr-0104-execution');
    expect(audit?.['actor_user_id']).toBeNull();
    expect(store.loads[0]?.confirmed_by).toBe('system:adr-0104-execution');
  });

  it('answers nothing_staged rather than raising, and writes no audit row', async () => {
    store.loads = store.loads.map((r) => ({ ...r, status: 'confirmed' }));
    const result = await decideOutboundBatch('confirm', { versionId: V, actor: { userId: 'u' } });
    // Most likely somebody else just decided it — not an error worth a 500.
    expect(result).toEqual({ ok: false, reason: 'nothing_staged' });
    expect(store.audits).toHaveLength(0);
    expect(store.ops).not.toContain('write:loads');
  });
});

describe('decideFacilityExpenseBatch', () => {
  it('confirms the batch and records the rows that carried NO amount', async () => {
    const result = await decideFacilityExpenseBatch('confirm', {
      versionId: V,
      actor: { userId: 'user-bill' },
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, action: 'confirm', rows: 2 });
    const totals = (store.audits[0]?.['after'] as Record<string, unknown>)['totals_accepted'];
    // `rows_without_an_amount` is the one the two sums CANNOT show: a blank
    // amount and a $0.00 amount contribute the same nothing, and only one of
    // them means the operator recorded a price.
    expect(totals).toEqual({
      rows: 2,
      amount: 900,
      credit_amount: 250,
      rows_without_an_amount: 1,
    });
  });

  it('discards with a reason and stamps who did it', async () => {
    await decideFacilityExpenseBatch('discard', {
      versionId: V,
      actor: { label: 'system:adr-0104-execution' },
      reason: 'wrong revision',
      now: NOW,
    });
    expect(store.expenses.every((r) => r.status === 'discarded')).toBe(true);
    expect(store.expenses[0]?.discarded_by).toBe('system:adr-0104-execution');
    expect(store.audits[0]?.['actor_user_id']).toBeNull();
  });

  it('answers nothing_staged rather than raising', async () => {
    store.expenses = [];
    expect(
      await decideFacilityExpenseBatch('confirm', { versionId: V, actor: { userId: 'u' } }),
    ).toEqual({ ok: false, reason: 'nothing_staged' });
    expect(store.audits).toHaveLength(0);
  });
});
