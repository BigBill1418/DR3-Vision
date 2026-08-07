// ADR-0078 D4 — the replay endpoint's refusals.
//
// This route did not exist before ADR-0078. `replayAll()` had been POSTing to it
// since T-009, Next answered 404, and the queue's hard-4xx branch classified a
// 404 as a permanent conflict — so the very first attempt at replaying anything
// parked it forever. The first test here is therefore not a formality: it pins
// the route's EXISTENCE, which is the whole defect.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the two LEAVES are stubbed: session resolution (which drags in next-auth,
// and whose module graph does not resolve under the vitest node resolver) and
// the terminal write. Everything this suite is actually about —
// `requireActivatedOperator`, the rollout gate it calls, `assertCurrentPacificDay`,
// the scope allowlist, `loadsErrorResponse` — is the REAL implementation. Mocking
// `route-helpers` wholesale would have meant the day pin under test was the one
// written in this file, which is the "guard measures the mock" trap.
const { requireOperatorForSite, assertUiSurfaceActivated, countCreate, addStackHandler } =
  vi.hoisted(() => ({
    requireOperatorForSite: vi.fn(async () => ({
      userId: 'u-operator',
      siteId: 'site-eugene',
      siteCode: 'eugene',
      role: 'operator',
    })),
    assertUiSurfaceActivated: vi.fn(async () => undefined),
    countCreate: vi.fn(async () => ({ status: 201, body: { snapshotId: 'snap-1' } })),
    addStackHandler: vi.fn(async () => ({ status: 201, body: { ok: true } })),
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
  return {
    ...actual,
    FLOOR_SCOPES: {
      ...actual.FLOOR_SCOPES,
      'operator.count.create': {
        ...actual.FLOOR_SCOPES['operator.count.create'],
        handler: countCreate,
      },
      'operator.load.add_stack': {
        ...actual.FLOOR_SCOPES['operator.load.add_stack'],
        handler: addStackHandler,
      },
    },
  };
});

import { POST } from './route';

function call(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1:3000/api/queue/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const KEY = '00000msjczjr2-00000000000000000001';

function envelope(over: Record<string, unknown> = {}) {
  return {
    scope: 'operator.count.create',
    site_code: 'eugene',
    idempotency_key: KEY,
    target_day: '2026-07-28',
    payload: { countDate: '2026-07-28', unitsTotal: 412, unitsInProcessing: 0 },
    ...over,
  };
}

/** First argument `countCreate` was called with. See the note at each call site. */
function firstCall<T>(): T {
  return (countCreate.mock.calls as unknown as Array<[T]>)[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ADR-0078 — the replay endpoint exists and allowlists its scopes', () => {
  // ── FALSIFICATION 8: queue.replay-endpoint-exists ───────────────────────
  //
  // FALSIFIED BY DELETING THE ROUTE: with `src/app/api/queue/replay/route.ts`
  // removed this file cannot even import `./route` — the suite goes red at
  // collection, naming the missing module. That is the pre-ADR-0078 state, in
  // which every replay got a 404 and was parked as an unrecoverable conflict.
  it('answers an unknown scope with 400, NOT 404', async () => {
    const res = await call(envelope({ scope: 'operator.definitely.not.a.scope' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'unknown_scope' });
    // 404 vs 400 is the whole point: the queue treats a hard 4xx as a conflict
    // either way, but a 404 means "this feature does not exist" and a 400 means
    // "that particular entry is not something we replay".
    expect(res.status).not.toBe(404);
  });

  it('refuses an unknown scope BEFORE consulting the rollout gate', async () => {
    await call(envelope({ scope: 'nope' }));
    // An allowlist that authenticates first leaks which scopes exist through
    // timing and error shape.
    expect(requireOperatorForSite).not.toHaveBeenCalled();
  });

  it('gates a known scope on the surface the LIVE route uses, not on the body', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T01:00:00.000Z'));
    await call(envelope());
    expect(requireOperatorForSite).toHaveBeenCalledWith('eugene');
    // The surface comes from the SCOPE's registry entry, never from the body.
    expect(assertUiSurfaceActivated).toHaveBeenCalledWith('operator', 'ipad_count', 'site-eugene');
  });
});

describe('ADR-0078 — the day pin refuses a stale replay', () => {
  // ── FALSIFICATION 4: replay.wrong-day-refused ───────────────────────────
  //
  // Run at a FIXED 2026-07-29T01:00:00Z, which is the UTC-rollover trap
  // `floor-day-pin.test.ts` pins: that instant is already 29 July in UTC but is
  // still 6 PM on 28 July in Pacific. A server-local comparison passes this test
  // for the wrong day and fails an operator's real evening shift, so the fixed
  // clock is load-bearing rather than tidiness.
  //
  // FALSIFIED BY HAND: removing the `assertCurrentPacificDay(day)` call from the
  // route returns 201 and dispatches the write — the silent retarget in which
  // yesterday's count lands on today's inventory.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T01:00:00.000Z')); // = 2026-07-28 18:00 PT
  });

  it('accepts an entry for the current PACIFIC day even when UTC has rolled over', async () => {
    const res = await call(envelope({ target_day: '2026-07-28' }));
    expect(res.status).toBe(201);
    expect(countCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses an entry for a previous day with 422 date_not_today and writes nothing', async () => {
    const res = await call(
      envelope({
        target_day: '2026-07-27',
        payload: { countDate: '2026-07-27', unitsTotal: 412, unitsInProcessing: 0 },
      }),
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'date_not_today' });
    expect(countCreate, 'a refused replay must not reach the write').not.toHaveBeenCalled();
  });

  it('pins on the PAYLOAD day, so an envelope cannot claim a different day', async () => {
    // The envelope says today; the body says yesterday. If the pin trusted the
    // envelope, a stale entry could be waved through by editing one field.
    const res = await call(
      envelope({
        target_day: '2026-07-28',
        payload: { countDate: '2026-07-27', unitsTotal: 412, unitsInProcessing: 0 },
      }),
    );
    expect(res.status).toBe(422);
    expect(countCreate).not.toHaveBeenCalled();
  });

  // ── G1b: replay.count-without-day-refused ───────────────────────────────
  //
  // A day-addressed payload whose day field is simply ABSENT must be refused,
  // not exempted. The earlier `if (day !== null) assert…` skipped the pin for
  // exactly this shape, so an old-format or hand-edited queue entry reached the
  // write and was filed against today — the silent retarget, through the one
  // path with no operator watching.
  //
  // FALSIFIED BY HAND: restoring `if (day !== null) assertCurrentPacificDay(day)`
  // turns this green-side-up — 201, and `countCreate` called.
  it('refuses a day-addressed replay whose payload carries NO day', async () => {
    const res = await call(
      envelope({
        target_day: null,
        payload: { unitsTotal: 412, unitsInProcessing: 0 }, // no countDate
      }),
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'date_not_today' });
    expect(countCreate, 'an unpinned replay must never reach the write').not.toHaveBeenCalled();
  });

  it('still allows a scope that is genuinely not day-addressed', async () => {
    // A stack is identified by its load, not by a day. `dayAddressed: false`
    // must keep meaning "no pin", or the fix above would break the dock.
    const res = await call(
      envelope({
        scope: 'operator.load.add_stack',
        target_day: null,
        payload: { loadId: 'L1', stackIndex: 1, unitCount: 3, countMode: 'ledger' },
      }),
    );
    expect(res.status).not.toBe(422);
  });

  it('re-derives identity from the session and never from the queued body', async () => {
    await call(
      envelope({
        payload: {
          countDate: '2026-07-28',
          unitsTotal: 412,
          unitsInProcessing: 0,
          // Hostile extras. They must not reach the handler's ctx.
          userId: 'u-someone-else',
          siteId: 'site-woodland',
        },
      }),
    );
    const passed = firstCall<{ ctx: { userId: string; siteId: string } }>();
    expect(passed.ctx.userId).toBe('u-operator');
    expect(passed.ctx.siteId).toBe('site-eugene');
  });
});
