// M2 — writeAudit gained an OPTIONAL tx client so a state flip and its audit row
// can commit (or roll back) together. This asserts the routing contract: no tx →
// the global prisma singleton (every existing caller unchanged); {tx} → the passed
// transaction client and NOT the global.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Prisma } from '@prisma/client';

const globalCreate = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: { auditLog: { create: (...a: unknown[]) => globalCreate(...a) } },
}));

import { writeAudit } from './audit';

const base = { action: 'update' as const, table_name: 'ap_requests', row_id: 'r1' };

beforeEach(() => {
  globalCreate.mockReset().mockResolvedValue({});
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
