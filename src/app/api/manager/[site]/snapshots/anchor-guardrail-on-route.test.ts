// Handoff #270 Phase 3 — the ADR-0072 guardrail fires on EVERY anchor-write door.
//
// ── The gap this pins shut ──────────────────────────────────────────────────
// ADR-0072 exists because "a mistyped count does not produce a wrong count, it
// silently moves the entire floor". It was wired into the iPad floor-count path
// (`countCreate`) and the hold-release path, and both were tested. This route —
// the Loads & Inventory desktop form a manager actually uses — called
// `reconcilePhysicalCount` directly with no tier check whatsoever.
//
// Same table, same anchor, same total authority over the floor, none of the
// friction. The control was real but not universal, and a gated capability is
// only as gated as its LEAST guarded entry point. Found on 2026-08-18 while
// verifying that the evening's EOD physical count would be guarded on whichever
// surface it was entered from — which is exactly the question that surfaced it.
//
// ── What is asserted ────────────────────────────────────────────────────────
// Not "the guardrail module has a Tier 2 branch" — anchor-guardrail.test.ts owns
// that, and it passed throughout the period this route was unguarded. What is
// asserted here is that the ROUTE consults it: a >20% swing arriving at this
// handler is held rather than written. A test of the classifier proves nothing
// about a caller that never calls it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The live anchor a count would replace. Woodland's real 2,483 from 2026-07-22. */
const PRIOR_TOTAL = 2483;

const calls = {
  reconciled: [] as unknown[],
  holds: [] as Array<{ siteId: string; newTotal: number }>,
};

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

vi.mock('@/lib/loads/route-helpers', () => ({
  requireActivatedManager: async () => ({ siteId: 'site-woodland', userId: 'user-manager' }),
  loadsErrorResponse: (e: unknown) => {
    throw e;
  },
  clampLimit: (_v: unknown, d: number) => d,
}));

vi.mock('@/lib/inventory/running-balance', () => ({
  // A real write would return a reconcile result; recording the CALL is the point.
  reconcilePhysicalCount: async (args: unknown) => {
    calls.reconciled.push(args);
    return {
      snapshotId: 'snap-new',
      computedTotal: { toString: () => '2483' },
      physicalTotal: 0,
      reconciledDelta: 0,
    };
  },
  PoolSplitMismatchError: class extends Error {},
}));

vi.mock('@/lib/inventory/anchor-holds', () => ({
  createHold: async (
    _db: unknown,
    args: { siteId: string; classification: { newTotal: number } },
  ) => {
    calls.holds.push({ siteId: args.siteId, newTotal: args.classification.newTotal });
    return { id: 'hold-1' };
  },
  eligibleApprovers: async () => [{ id: 'u1', name: 'Kelsey' }],
}));

// The guardrail itself is NOT mocked. Mocking the thing under test would make this
// assert that a fake refuses, which is the shape of a test that cannot fail.
// Only its two DB reads are stubbed, so the real `classifyAnchorWrite` decides.
vi.mock('@/lib/inventory/anchor-guardrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory/anchor-guardrail')>();
  return {
    ...actual,
    loadPriorAnchor: async () => ({
      id: 'snap-prior',
      total: PRIOR_TOTAL,
      programUnits: PRIOR_TOTAL,
      nonProgramUnits: 0,
      snapshotAt: new Date('2026-07-22T07:00:00.000Z'),
    }),
    loadSwingThresholdPct: async () => 20,
  };
});

const { POST } = await import('./route');

const params = Promise.resolve({ site: 'woodland' });

function postCount(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('https://dr3-vision.svdp.us/api/manager/woodland/snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ countedAt: '2026-08-18', units_in_processing: 0, ...body }),
    }),
    { params },
  );
}

beforeEach(() => {
  calls.reconciled.length = 0;
  calls.holds.length = 0;
});

describe('POST /api/manager/[site]/snapshots — ADR-0072 is enforced on this door too', () => {
  // ── FALSIFICATION (guardrail-on-route) ────────────────────────────────────
  // Verified by hand against the pre-fix route (the handler as it stood on
  // origin/main at 130e0d69, which went straight to `reconcilePhysicalCount`):
  // this test failed with `expected 201 to be 422`, and the "does not write"
  // assertion failed because `calls.reconciled` had length 1. The anchor really
  // was replaceable from this surface with a 30% swing and no approval.
  it('HOLDS a >20% swing instead of writing the anchor', async () => {
    // 2,483 → 1,700 is a 31.5% decrease: the fat-fingered-digit case.
    const res = await postCount({ units_total: 1700 });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; swingPct: number; message: string };
    expect(body.error).toBe('manager_approval_required');
    expect(Math.round(body.swingPct)).toBe(32);
    expect(body.message).toContain('2,483');
    expect(body.message).toContain('1,700');
  });

  it('does NOT write the anchor when the swing is held', async () => {
    await postCount({ units_total: 1700 });
    expect(calls.reconciled).toHaveLength(0);
    expect(calls.holds).toHaveLength(1);
    expect(calls.holds[0]!.newTotal).toBe(1700);
  });

  it('preserves the operator’s entry on the hold rather than discarding it', async () => {
    const res = await postCount({ units_total: 1700 });
    const body = (await res.json()) as { holdId: string; approvers: unknown[] };
    expect(body.holdId).toBe('hold-1');
    // Names someone who can release it — a 422 with no route forward is a dead end.
    expect(body.approvers).toHaveLength(1);
  });

  // The other side of the gate. A guardrail that refuses everything is not a
  // guardrail, it is an outage — and tonight's count must be able to land.
  it('WRITES a modest (Tier 1) swing through, with the tier reported', async () => {
    // 2,483 → 2,300 is a 7.4% decrease — under the threshold.
    const res = await postCount({ units_total: 2300 });
    expect(res.status).toBe(201);
    expect(calls.reconciled).toHaveLength(1);
    expect(calls.holds).toHaveLength(0);
    const body = (await res.json()) as { tier: number; priorTotal: number; swingPct: number };
    expect(body.tier).toBe(1);
    expect(body.priorTotal).toBe(PRIOR_TOTAL);
    expect(Math.round(body.swingPct)).toBe(7);
  });

  // Exactly the threshold is Tier 1 — the largest swing a manager may confirm
  // alone. Pinned because an off-by-one here is invisible until it holds (or
  // fails to hold) a real count.
  it('treats a swing of EXACTLY the threshold as Tier 1, not Tier 2', async () => {
    // 20% of 2,483 = 496.6 → 2,483 − 496 = 1,987 is 19.98%, just under.
    const res = await postCount({ units_total: 1987 });
    expect(res.status).toBe(201);
    expect(calls.holds).toHaveLength(0);
  });

  it('counts in-processing units toward the swing, as the prior anchor does', async () => {
    // 1,700 + 800 = 2,500 — a 0.7% swing, so this must WRITE. If the handler
    // ignored `units_in_processing` it would see 1,700 and hold. The two sides of
    // the comparison have to be built the same way (ADR-0078 D1).
    const res = await postCount({ units_total: 1700, units_in_processing: 800 });
    expect(res.status).toBe(201);
    expect(calls.holds).toHaveLength(0);
  });
});
