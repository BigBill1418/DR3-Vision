// ADR-0057 D4 — decide route: admin gate, required note, decision validation.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { requireAdmin, applyReconcileDecision } = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ userId: 'u-bill', email: null, name: 'Bill' })),
  applyReconcileDecision: vi.fn(async () => ({ id: 'q1', decision: 'approved', applied: null })),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/auth-helpers', () => ({ requireAdmin }));
// Use the REAL apply module for the note guard + error classes, but stub the DB op.
vi.mock('@/lib/reconcile/apply', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconcile/apply')>(
    '@/lib/reconcile/apply',
  );
  return { ...actual, applyReconcileDecision };
});

import { POST } from './route';

function call(body: unknown, id = 'q1'): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1:3000/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ userId: 'u-bill', email: null, name: 'Bill' });
  applyReconcileDecision
    .mockReset()
    .mockResolvedValue({ id: 'q1', decision: 'approved', applied: null });
});

describe('POST /api/admin/mymrc/reconcile/[id]/decide', () => {
  it('returns the 403 Response when the caller is not an admin, without deciding', async () => {
    requireAdmin.mockRejectedValueOnce(new Response('forbidden', { status: 403 }));
    const res = await call({ decision: 'approved', note: 'ok' });
    expect(res.status).toBe(403);
    expect(applyReconcileDecision).not.toHaveBeenCalled();
  });

  it('400s a missing/invalid decision', async () => {
    const res = await call({ note: 'ok' });
    expect(res.status).toBe(400);
    expect(applyReconcileDecision).not.toHaveBeenCalled();
  });

  it('400s a decision with no note (required-note gate) WITHOUT deciding', async () => {
    const res = await call({ decision: 'approved', note: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/note/i);
    expect(applyReconcileDecision).not.toHaveBeenCalled();
  });

  it('400s an over-length note WITHOUT deciding', async () => {
    const res = await call({ decision: 'rejected', note: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(applyReconcileDecision).not.toHaveBeenCalled();
  });

  it('approves with a valid note, passing the trimmed note + actor through', async () => {
    const res = await call({ decision: 'approved', note: '  verified new source  ' });
    expect(res.status).toBe(200);
    expect(applyReconcileDecision).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q1', decision: 'approved', actorUserId: 'u-bill', note: 'verified new source' }),
    );
  });
});
