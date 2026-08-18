// ADR-0109 — three photos per capture point, and the FOURTH is refused.
//
// ## Written naive-first, and here is the naive failure
//
// These tests were written against the confirm route BEFORE the cap existed —
// the callback goes straight to `tx.loadPhoto.create(...)` with no count in
// front of it, which is `main` at cbab98b. Re-falsified 2026-08-18 by deleting
// the single `if (!canAddPhoto(held)) throw ...` line and re-running. VERBATIM:
//
//     × ADR-0109 — the ceiling is enforced at confirm > refuses the FOURTH photo of a kind with 409
//       → a load already holding 3 photos of this kind took a fourth: expected 200 to be 409 // Object.is equality
//     × ADR-0109 — the ceiling is enforced at confirm > writes no row when the limit is reached
//       → expected "spy" to not be called at all, but actually been called 1 times
//     × ADR-0109 — the ceiling is enforced at confirm > refuses a load that is ALREADY over the ceiling
//       → expected 200 to be 409 // Object.is equality
//     × ADR-0109 — 409 and not 401 ... > does not answer 401, which the queue would classify as auth:
//       → expected 200 to be greater than or equal to 400
//
//     Tests  4 failed | 5 passed (9)
//
// The 5 that stayed green are the "one required, two optional" cases — which is
// the point: the naive route is not wrong about those, only about the ceiling.
//
// That is not a hypothetical red. Production holds the same shape today:
//
//     load fce4fbc5-9fca-4d50-8afb-d074b8994e74 | bol | 4 rows | 4 DISTINCT
//     storage keys | 2026-08-10 23:48:01 → 23:51:39
//
// Four separate BOL captures, seconds apart, all accepted. The capability this
// PR bounds is one the floor already had by accident; what did not exist was
// any ceiling on it.
//
// ## What is deliberately NOT asserted here
//
// Nothing about the idempotency claim: `withIdempotency` is stubbed to a
// pass-through in this suite (as it is in `confirm.route.test.ts` beside it) so
// these tests measure the ROUTE. The property that a REPLAY skips the cap
// entirely — the one that keeps an already-landed photo drainable — is a
// property of the claim mechanism and is proven against real Postgres in
// `photo-limit.db.test.ts`, where it can actually fail.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PHOTOS_PER_KIND } from '@/lib/loads/photo-limit';

const requireOperatorOrGrantAtLoadSite = vi.hoisted(() => vi.fn());
const loadPhotoCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'photo-4' })));
const loadPhotoCount = vi.hoisted(() => vi.fn(async () => 0));
const auditCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'audit-1' })));
const executeRaw = vi.hoisted(() => vi.fn(async () => 1));

vi.mock('@/lib/load-photo-guard', () => ({ requireOperatorOrGrantAtLoadSite }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    // The REAL `$transaction` semantic that matters to this suite is that a
    // throw from inside propagates out and nothing commits. Modelled by simply
    // letting the rejection escape — the rollback of the idempotency claim is
    // Postgres's job and is asserted in the .db test, not faked here.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        loadPhoto: { create: loadPhotoCreate, count: loadPhotoCount },
        auditLog: { create: auditCreate },
        $executeRaw: executeRaw,
      }),
  },
}));
vi.mock('@/lib/idempotency', () => ({
  withIdempotency: async (_args: unknown, fn: () => Promise<unknown>) => ({
    replayed: false,
    statusCode: 200,
    body: await fn(),
  }),
}));
vi.mock('@/lib/loads/route-helpers', () => ({ readIdempotencyKey: () => null }));

import { POST } from './route';

const EUGENE = 'site-eugene';
const VALID = { load_id: 'load-1', kind: 'bol', storage_key: 'loads/load-1/bol/a.jpg' };

function post(body: Record<string, unknown> = VALID): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1:3000/api/photos/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  loadPhotoCreate.mockResolvedValue({ id: 'photo-4' });
  executeRaw.mockResolvedValue(1);
  requireOperatorOrGrantAtLoadSite.mockResolvedValue({
    loadId: 'load-1',
    siteId: EUGENE,
    actorUserId: 'op-a',
    loadOwnerUserId: 'op-a',
    via: 'session',
    grantIdempotencyKey: null,
  });
});

describe('ADR-0109 — the ceiling is enforced at confirm', () => {
  it('accepts the FIRST photo (the required one is unchanged)', async () => {
    loadPhotoCount.mockResolvedValue(0);
    expect((await post()).status).toBe(200);
    expect(loadPhotoCreate).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('accepts an optional extra when the load holds %i', async (held) => {
    loadPhotoCount.mockResolvedValue(held);
    expect((await post()).status, `a load holding ${held} must still take one more`).toBe(200);
    expect(loadPhotoCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses the FOURTH photo of a kind with 409', async () => {
    loadPhotoCount.mockResolvedValue(MAX_PHOTOS_PER_KIND);
    const res = await post();
    expect(res.status, 'a load already holding 3 photos of this kind took a fourth').toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'photo_limit_reached',
      limit: MAX_PHOTOS_PER_KIND,
      held: MAX_PHOTOS_PER_KIND,
    });
  });

  it('writes no row when the limit is reached', async () => {
    loadPhotoCount.mockResolvedValue(MAX_PHOTOS_PER_KIND);
    await post();
    expect(loadPhotoCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a load that is ALREADY over the ceiling', async () => {
    // Nine production loads hold 4-6 photos and one holds four of a single kind.
    // Introducing a limit does not retract those rows, but it must not let them
    // grow either — a `=== MAX` comparison would read 4 as "not at the limit".
    loadPhotoCount.mockResolvedValue(4);
    expect((await post()).status).toBe(409);
    expect(loadPhotoCreate).not.toHaveBeenCalled();
  });

  it('counts THIS kind only — a full BOL step does not block the door-open photo', async () => {
    // The premise that died on checking. An ordinary load takes BOL + weight
    // ticket + door-open, so 21 live loads already hold exactly three photos. A
    // per-LOAD ceiling of three would refuse the door-open capture on every load
    // that also took a weight ticket — and door-open is what starts the unload
    // timer (ADR-0012 §1). This asserts the count is scoped to the kind.
    loadPhotoCount.mockResolvedValue(0);
    await post({ ...VALID, kind: 'door_open', storage_key: 'loads/load-1/door_open/a.jpg' });
    expect(loadPhotoCount).toHaveBeenCalledWith({
      where: { load_id: 'load-1', kind: 'door_open' },
    });
  });

  it('serializes concurrent drains before counting', async () => {
    // Count-then-insert is not atomic under READ COMMITTED. Without the lock two
    // drains of one load both read 2 and both insert. Asserting the lock is
    // TAKEN, and taken BEFORE the count, is the only cheap way to pin an
    // ordering that a unit test cannot otherwise race.
    loadPhotoCount.mockResolvedValue(0);
    await post();
    expect(executeRaw).toHaveBeenCalled();
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      loadPhotoCount.mock.invocationCallOrder[0]!,
    );
  });
});

describe('ADR-0109 — 409 and not 401, because a sign-in cannot make room', () => {
  it('does not answer 401, which the queue would classify as auth:', async () => {
    // `isAuthResponse` in `offline-queue.ts` treats 401 as "sign in and this
    // will send". No amount of signing in makes a fourth photo fit, so a 401
    // here would hand the floor an instruction that can never work — the exact
    // shape ADR-0078 G7 and the 2026-08-10 Woodland reject exist to prevent.
    loadPhotoCount.mockResolvedValue(MAX_PHOTOS_PER_KIND);
    const res = await post();
    expect(res.status).not.toBe(401);
    // ...and it IS a hard 4xx, so `classify()` parks it as a conflict a person
    // resolves rather than a retry loop that never ends.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(408);
  });
});
