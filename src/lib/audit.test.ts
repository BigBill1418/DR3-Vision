// M2 — writeAudit gained an OPTIONAL tx client so a state flip and its audit row
// can commit (or roll back) together. This asserts the routing contract: no tx →
// the global prisma singleton (every existing caller unchanged); {tx} → the passed
// transaction client and NOT the global.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Prisma } from '@prisma/client';

const globalCreate = vi.fn();
const globalCreateMany = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    auditLog: {
      create: (...a: unknown[]) => globalCreate(...a),
      createMany: (...a: unknown[]) => globalCreateMany(...a),
    },
  },
}));

import { writeAudit, writeAuditMany } from './audit';

const base = { action: 'update' as const, table_name: 'ap_requests', row_id: 'r1' };

beforeEach(() => {
  globalCreate.mockReset().mockResolvedValue({});
  globalCreateMany.mockReset().mockResolvedValue({ count: 0 });
});

describe('writeAudit — optional tx client (M2)', () => {
  it('uses the global prisma singleton when no tx is passed (existing callers unchanged)', async () => {
    await writeAudit({ ...base, after: { x: 1 } });
    expect(globalCreate).toHaveBeenCalledTimes(1);
  });

  it('writes through the provided tx client (and NOT the global) when {tx} is passed', async () => {
    const txCreate = vi.fn().mockResolvedValue({});
    const tx = { auditLog: { create: txCreate } } as unknown as Prisma.TransactionClient;
    await writeAudit({ ...base, before: { s: 'pending' }, after: { s: 'approved' } }, { tx });
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(globalCreate).not.toHaveBeenCalled();
  });

  it('serializes before/after and never passes literal undefined to Prisma', async () => {
    await writeAudit({ ...base }); // no before/after supplied
    const arg = globalCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data['before']).not.toBeUndefined(); // mapped to Prisma.JsonNull
    expect(arg.data['after']).not.toBeUndefined();
  });
});

// ADR-0113 D4 — `writeAuditMany`, added so `rejectLoad` can soft-void every
// stack on a load and record each one WITHOUT N sequential round trips inside an
// interactive transaction. Ledger mode writes one `load_stacks` row per
// mattress, so a 240-unit load is 240 of them against Prisma's 5-second default
// timeout — and the whole point of the transaction is that it cannot half-happen.
describe('writeAuditMany — many rows, one round trip (ADR-0113)', () => {
  it('produces byte-identical rows to writeAudit for the same input', async () => {
    // The two share `toAuditRow`, and this is what holds them together. A
    // hand-written second mapping is how a batched writer comes to drop
    // `actor_label`, or store `null` where the singular writer stores
    // `Prisma.JsonNull` — a difference nothing else in the system would notice,
    // in an append-only table nobody re-reads until an audit.
    const args = {
      ...base,
      actor_user_id: 'u1',
      actor_label: 'system:x',
      before: { a: 1 },
      after: { a: 2 },
    };
    await writeAudit(args);
    await writeAuditMany([args]);
    const single = (globalCreate.mock.calls[0]![0] as { data: unknown }).data;
    const batched = (globalCreateMany.mock.calls[0]![0] as { data: unknown[] }).data[0];
    expect(batched).toEqual(single);
  });

  it('writes every row in ONE createMany, not one call per row', async () => {
    await writeAuditMany([base, { ...base, row_id: 'r2' }, { ...base, row_id: 'r3' }]);
    expect(globalCreateMany).toHaveBeenCalledTimes(1);
    expect((globalCreateMany.mock.calls[0]![0] as { data: unknown[] }).data).toHaveLength(3);
  });

  it('is a no-op on an empty list — never an empty createMany', async () => {
    // A load refused before anyone counted is the ordinary case, not an edge one.
    await writeAuditMany([]);
    expect(globalCreateMany).not.toHaveBeenCalled();
  });

  it('writes through the provided tx client (and NOT the global) when {tx} is passed', async () => {
    const txCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { auditLog: { createMany: txCreateMany } } as unknown as Prisma.TransactionClient;
    await writeAuditMany([base], { tx });
    expect(txCreateMany).toHaveBeenCalledTimes(1);
    expect(globalCreateMany).not.toHaveBeenCalled();
  });
});
