// ADR-0078 Amendment 1 — confirm must accept exactly what mint accepts, and it
// must record who uploaded.
//
// The half-applied-change hazard is the reason the first test exists. Loosening
// the MINT gate while leaving CONFIRM strict is not a partial improvement, it is
// strictly worse than doing nothing: the client gets a presigned URL, PUTs the
// bytes to R2, and is then refused the row. That leaves an orphaned object
// costing storage, no `load_photos` row, and a queue entry that still cannot
// drain — the exact defect this amendment exists to remove, plus litter.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireOperatorAtLoadSite = vi.hoisted(() => vi.fn());
type CreateArgs = { data: Record<string, unknown> };
const loadPhotoCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'photo-1' })));
const auditCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'audit-1' })));

/**
 * Typed accessor for a recorded `create({ data })` call.
 *
 * `mock.calls` widens to `[]` on a no-parameter mock, and the repo's tsconfig
 * has `noPropertyAccessFromIndexSignature`, so a bare `Record<string, unknown>`
 * would force bracket access at every assertion and make them harder to read.
 * Callers name the shape they expect instead.
 */
function firstData<T = Record<string, unknown>>(spy: { mock: { calls: unknown[][] } }): T {
  const calls = spy.mock.calls as unknown as CreateArgs[][];
  const first = calls[0]?.[0];
  if (!first) throw new Error('expected the spy to have been called at least once');
  return first.data as T;
}

vi.mock('@/lib/load-photo-guard', () => ({ requireOperatorAtLoadSite }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ loadPhoto: { create: loadPhotoCreate }, auditLog: { create: auditCreate } }),
  },
}));
// The idempotency layer is exercised against real Postgres elsewhere
// (idempotency.db.test.ts); here it is a pass-through so this suite measures the
// ROUTE's behaviour rather than re-testing the claim mechanics.
vi.mock('@/lib/idempotency', () => ({
  withIdempotency: async (args: { key: string | null }, fn: () => Promise<unknown>) => ({
    replayed: false,
    statusCode: 200,
    body: await fn(),
    _actorUserId: (args as unknown as { actorUserId: string }).actorUserId,
  }),
}));
vi.mock('@/lib/loads/route-helpers', () => ({ readIdempotencyKey: () => null }));

import { POST } from './route';

const EUGENE = 'site-eugene';

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1:3000/api/photos/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = { load_id: 'load-1', kind: 'bol', storage_key: 'loads/load-1/bol/a.jpg' };

beforeEach(() => {
  vi.clearAllMocks();
  loadPhotoCreate.mockResolvedValue({ id: 'photo-1' });
});

describe('ADR-0078 Am.1 — confirm.accepts-same-principal-as-mint', () => {
  // FALSIFIED BY HAND by reverting CONFIRM's guard only — i.e. restoring an
  // owner check in `/api/photos/confirm` while leaving the mint site-scoped.
  // This test then goes red naming the refusal, which is the half-applied
  // change that would orphan R2 objects and still not drain. Recorded red:
  //
  //   AssertionError: confirm refused a principal that mint accepts:
  //   expected 403 to be 200
  it('accepts a same-site operator who does not own the load', async () => {
    requireOperatorAtLoadSite.mockResolvedValue({
      loadId: 'load-1',
      siteId: EUGENE,
      actorUserId: 'op-b',
      loadOwnerUserId: 'op-a',
    });
    const res = await post(VALID);
    expect(res.status, 'confirm refused a principal that mint accepts').toBe(200);
    expect(loadPhotoCreate).toHaveBeenCalledTimes(1);
  });

  it('propagates the guard refusal verbatim (cross-site stays 403)', async () => {
    requireOperatorAtLoadSite.mockRejectedValue(new Response('forbidden', { status: 403 }));
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect(loadPhotoCreate).not.toHaveBeenCalled();
  });

  it('keeps 404 distinguishable from 403', async () => {
    requireOperatorAtLoadSite.mockRejectedValue(new Response('load not found', { status: 404 }));
    expect((await post(VALID)).status).toBe(404);
  });
});

describe('ADR-0078 Am.1 — attribution is written on EVERY confirm', () => {
  // FALSIFIED BY HAND: dropping `uploaded_by` from the create makes this red
  // with `undefined`, i.e. the amendment loosens the gate and records nothing —
  // which is the trade going one way only.
  it('stamps uploaded_by with the ACTOR, not the load owner', async () => {
    requireOperatorAtLoadSite.mockResolvedValue({
      loadId: 'load-1',
      siteId: EUGENE,
      actorUserId: 'op-b',
      loadOwnerUserId: 'op-a',
    });
    await post(VALID);
    const data = firstData<{ uploaded_by: string }>(loadPhotoCreate);
    expect(data.uploaded_by, 'uploaded_by must be the uploading session').toBe('op-b');
    expect(data.uploaded_by).not.toBe('op-a');
  });

  it('stamps uploaded_by on a self-upload too', async () => {
    requireOperatorAtLoadSite.mockResolvedValue({
      loadId: 'load-1',
      siteId: EUGENE,
      actorUserId: 'op-a',
      loadOwnerUserId: 'op-a',
    });
    await post(VALID);
    // A column populated only on the exceptional path cannot answer "who
    // uploaded this?" for the ordinary one.
    expect(firstData<{ uploaded_by: string }>(loadPhotoCreate).uploaded_by).toBe('op-a');
  });
});

describe('ADR-0078 Am.1 — the audit row marks the EXCEPTION, not every upload', () => {
  it('writes one audit row when the uploader is not the assigned operator', async () => {
    requireOperatorAtLoadSite.mockResolvedValue({
      loadId: 'load-1',
      siteId: EUGENE,
      actorUserId: 'op-b',
      loadOwnerUserId: 'op-a',
    });
    await post(VALID);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const row = firstData<{
      actor_user_id: string;
      table_name: string;
      after: { cross_operator: boolean; load_assigned_to: string };
    }>(auditCreate);
    expect(row.actor_user_id).toBe('op-b');
    expect(row.table_name).toBe('load_photos');
    expect(row.after.cross_operator).toBe(true);
    expect(row.after.load_assigned_to).toBe('op-a');
  });

  // ADR-0037 noise discipline. A row per confirm would add ~100/day of
  // "operator did the thing they were assigned to do" and bury the case a
  // person would actually go looking for.
  it('writes NO audit row on a self-upload', async () => {
    requireOperatorAtLoadSite.mockResolvedValue({
      loadId: 'load-1',
      siteId: EUGENE,
      actorUserId: 'op-a',
      loadOwnerUserId: 'op-a',
    });
    await post(VALID);
    expect(
      auditCreate,
      'an audit row per confirm buries the exceptional case',
    ).not.toHaveBeenCalled();
  });

  it('writes NO audit row when the load is unassigned', async () => {
    // Nobody was displaced, so there is no exception to record — and comparing
    // an actor against NULL would otherwise flag every unassigned load.
    requireOperatorAtLoadSite.mockResolvedValue({
      loadId: 'load-1',
      siteId: EUGENE,
      actorUserId: 'op-a',
      loadOwnerUserId: null,
    });
    await post(VALID);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
