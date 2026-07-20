// F7-AP — the decide route caps stored free-text (note ≤ 2000, vendor ≤ 200) and
// returns 400 on overflow rather than parking an unbounded payload (storage-DoS
// boundary). The cap check runs BEFORE any state change, so an oversized note/
// vendor never flips the request.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { requireApApprover, decideRequest, resolveDecisionSiteId } = vi.hoisted(() => ({
  requireApApprover: vi.fn(async () => ({ userId: 'u-morena' })),
  decideRequest: vi.fn(async (_args: unknown) => ({
    requestId: 'req-1',
    decision: 'approved',
    mail: 'sent',
  })),
  resolveDecisionSiteId: vi.fn(async (_prisma: unknown, _input: unknown) => 'site-w'),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ap/approvers', () => ({ requireApApprover }));
vi.mock('@/lib/ap/approvals', () => ({
  ApAlreadyDecidedError: class extends Error {},
  ApInvalidSiteError: class extends Error {},
  ApLocationConflictError: class extends Error {},
  ApNoteRequiredError: class extends Error {},
  ApNotActionableError: class extends Error {},
  ApRequestNotFoundError: class extends Error {},
  ApSiteRequiredError: class extends Error {},
  assertDecisionNote: () => undefined,
  assertDecisionSite: () => undefined,
  decideRequest,
  resolveDecisionSiteId,
}));

import { POST } from './route';

function call(body: unknown, id = 'req-1'): Promise<Response> {
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
  decideRequest.mockClear();
  resolveDecisionSiteId.mockClear();
});

describe('POST /api/ops/ap/[id]/decide — free-text caps (F7-AP)', () => {
  it('400s an over-length note WITHOUT deciding the request', async () => {
    const res = await call({ decision: 'approved', note: 'x'.repeat(2001), siteId: 'woodland' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/note/i);
    expect(decideRequest).not.toHaveBeenCalled(); // no state change
    expect(resolveDecisionSiteId).not.toHaveBeenCalled();
  });

  it('400s an over-length vendor WITHOUT deciding the request', async () => {
    const res = await call({ decision: 'approved', vendor: 'v'.repeat(201), siteId: 'woodland' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/vendor/i);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('allows a note/vendor at the cap boundary (proceeds to decide)', async () => {
    const res = await call({
      decision: 'approved',
      note: 'x'.repeat(2000),
      vendor: 'v'.repeat(200),
      siteId: 'woodland',
    });
    expect(res.status).toBe(200);
    expect(decideRequest).toHaveBeenCalledTimes(1);
  });
});

// ADR-0046 amendment (2026-07-20) — NOT DR3 disposition at the route boundary.
describe('POST /api/ops/ap/[id]/decide — NOT DR3 disposition', () => {
  it('NOT DR3 with a reason: decides with filedNotDr3, never resolves a site', async () => {
    const res = await call({ decision: 'approved', notDr3: true, note: 'parent-org bill' });
    expect(res.status).toBe(200);
    expect(resolveDecisionSiteId).not.toHaveBeenCalled();
    expect(decideRequest).toHaveBeenCalledTimes(1);
    const arg = decideRequest.mock.calls[0]![0] as { filedNotDr3?: boolean; siteId?: string; note?: string };
    expect(arg.filedNotDr3).toBe(true);
    expect(arg.siteId).toBeUndefined();
    expect(arg.note).toBe('parent-org bill');
  });

  it('400s NOT DR3 with no reason WITHOUT deciding', async () => {
    const res = await call({ decision: 'approved', notDr3: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/NOT DR3 requires a reason/i);
    expect(decideRequest).not.toHaveBeenCalled();
    expect(resolveDecisionSiteId).not.toHaveBeenCalled();
  });

  it('400s NOT DR3 with a blank reason WITHOUT deciding', async () => {
    const res = await call({ decision: 'rejected', notDr3: true, note: '   ' });
    expect(res.status).toBe(400);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it('400s when BOTH a site AND notDr3 are supplied (mutual exclusion)', async () => {
    const res = await call({
      decision: 'approved',
      notDr3: true,
      siteId: 'woodland',
      note: 'reason',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not both/i);
    expect(decideRequest).not.toHaveBeenCalled();
    expect(resolveDecisionSiteId).not.toHaveBeenCalled();
  });

  it('the normal site path is unchanged (resolves the site, decides with siteId)', async () => {
    const res = await call({ decision: 'approved', siteId: 'woodland' });
    expect(res.status).toBe(200);
    expect(resolveDecisionSiteId).toHaveBeenCalledTimes(1);
    const arg = decideRequest.mock.calls[0]![0] as { filedNotDr3?: boolean; siteId?: string };
    expect(arg.filedNotDr3).toBeUndefined();
    expect(arg.siteId).toBe('site-w');
  });
});
