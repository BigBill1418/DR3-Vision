// ADR-0078 G1 — the count route must keep accepting the OLD bundle's body.
//
// The floor iPads are kiosks. The service worker does not `skipWaiting`, so a
// device keeps serving the bundle it already has until an operator accepts the
// update prompt — which can be days. The pre-ADR-0078 bundle sends no
// `countDate`, so making that field required would have answered 422 to every
// physical count at BOTH sites for the whole update window: an outage on the one
// surface this ADR exists to make reliable, caused by the fix.
//
// So the field is optional here and defaulted to the current Pacific day, which
// is byte-for-byte what the route did before. The pin still applies — it just
// pins a day the server supplied rather than one it refused to infer.
//
// The corresponding refusal lives on the REPLAY path, where "now" is not the
// count's day and defaulting would be the silent retarget D10 exists to prevent.
// That asymmetry is the design, and both halves are pinned: here, and in
// `src/app/api/queue/replay/route.test.ts`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireOperatorForSite, assertUiSurfaceActivated, countCreate } = vi.hoisted(() => ({
  requireOperatorForSite: vi.fn(async () => ({
    userId: 'u-operator',
    siteId: 'site-eugene',
    siteCode: 'eugene',
    role: 'operator',
  })),
  assertUiSurfaceActivated: vi.fn(async () => undefined),
  countCreate: vi.fn(async () => ({
    status: 201,
    body: { snapshotId: 'snap-1' },
  })),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/auth-helpers', () => ({ requireOperatorForSite }));
vi.mock('@/lib/loads/record-guards', () => ({
  assertUiSurfaceActivated,
  assertLoadsInventoryActivated: async () => undefined,
  LoadsInventoryNotActivatedError: class extends Error {
    status = 423;
  },
}));
vi.mock('@/lib/operator/floor-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operator/floor-writes')>();
  return { ...actual, countCreate };
});

import { POST } from './route';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1:3000/api/operator/eugene/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ site: 'eugene' }) },
  );
}

/** First argument `countCreate` was called with. See the note at each call site. */
function firstCall<T>(): T {
  return (countCreate.mock.calls as unknown as Array<[T]>)[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // The UTC-rollover trap: already 29 July in UTC, still 28 July 6 PM Pacific.
  vi.setSystemTime(new Date('2026-07-29T01:00:00.000Z'));
});

describe('ADR-0078 G1 — count.legacy-shell-body', () => {
  // VERBATIM the body the current main-branch client sends. No countDate.
  //
  // FALSIFIED BY HAND: making `countDate` required in `CountCreate` (no
  // `.optional()`) makes this 422 — which is precisely the fleet-wide outage
  // this test exists to prevent, so the red is the defect itself.
  it('accepts a pre-ADR-0078 body and anchors it to TODAY in Pacific', async () => {
    const res = await post({
      unitsInProcessing: 0,
      poolAttribution: 'measured',
      unitsTotal: 412,
    });

    expect(res.status).toBe(201);
    // The mock is declared with no parameters (an unused one is a lint error
    // here), so `mock.calls` types as `[]`. The recorded arguments are still
    // there at runtime — vitest captures them regardless of the signature.
    const passed = firstCall<{ payload: { countDate: string } }>();
    // 28 July, not 29: the default is the PACIFIC day, not the UTC one. A
    // server-local default would file the evening shift's count against
    // tomorrow.
    expect(passed.payload.countDate).toBe('2026-07-28');
  });

  it('uses the body’s countDate when the NEW bundle supplies one', async () => {
    const res = await post({
      countDate: '2026-07-28',
      unitsInProcessing: 0,
      unitsTotal: 412,
    });
    expect(res.status).toBe(201);
    // The mock is declared with no parameters (an unused one is a lint error
    // here), so `mock.calls` types as `[]`. The recorded arguments are still
    // there at runtime — vitest captures them regardless of the signature.
    const passed = firstCall<{ payload: { countDate: string } }>();
    expect(passed.payload.countDate).toBe('2026-07-28');
  });

  // The default is a compatibility shim, NOT a bypass. A body that names another
  // day is still refused — otherwise the shim would have quietly removed the pin.
  it('still refuses a body that names a different day', async () => {
    const res = await post({
      countDate: '2026-07-27',
      unitsInProcessing: 0,
      unitsTotal: 412,
    });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'date_not_today' });
    expect(countCreate).not.toHaveBeenCalled();
  });
});
