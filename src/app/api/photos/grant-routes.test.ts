// ADR-0086 D2/D7 — both photo routes, end to end, with the REAL guard and the
// REAL grant crypto.
//
// Only three things are faked, and each for a reason that is not "it was
// easier": `@/lib/auth` (the whole point is that there IS no session),
// `@/lib/prisma` (no Postgres on the build host — the real-database half is
// `photo-grant-redemption.db.test.ts`), and `mintUploadUrl` (so the presign step
// does not depend on R2 credentials). `isValidLoadPhotoStorageKey`,
// `requireOperatorOrGrantAtLoadSite`, `verifyPhotoGrant` and `mintPhotoGrant`
// are all the genuine articles — the claims here are about what they do.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
const loadFindUnique = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());
const loadPhotoCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'photo-1' })));
const auditCreate = vi.hoisted(() => vi.fn(async () => ({ id: 'audit-1' })));
const mintUploadUrl = vi.hoisted(() =>
  vi.fn(async (a: { loadId: string; kind: string }) => ({
    storage_key: `loads/${a.loadId}/${a.kind}/${Math.random().toString(36).slice(2)}.jpg`,
    upload_url: 'https://r2.example/put',
  })),
);

vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboundLoad: { findUnique: loadFindUnique },
    user: { findUnique: userFindUnique },
    // ADR-0109 — `count` and `$executeRaw` exist because the confirm route's
    // three-photo ceiling calls them. 0 held: this suite asks who may write, not
    // how many times.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        loadPhoto: { create: loadPhotoCreate, count: async () => 0 },
        auditLog: { create: auditCreate },
        $executeRaw: async () => 1,
      }),
  },
}));
// PARTIAL mock: the presign is replaced, the prefix rule is NOT. Mocking the
// whole module would silently stub `isValidLoadPhotoStorageKey` and every D3
// assertion below would be measuring the stub.
vi.mock('@/lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/r2')>()),
  mintUploadUrl,
}));
// The claim mechanics are exercised against real Postgres elsewhere; here it is
// a pass-through so this suite measures the ROUTES.
vi.mock('@/lib/idempotency', () => ({
  withIdempotency: async (_args: unknown, fn: () => Promise<unknown>) => ({
    replayed: false,
    statusCode: 200,
    body: await fn(),
  }),
}));

import { POST as MINT } from './upload-url/route';
import { POST as CONFIRM } from './confirm/route';
import { PHOTO_GRANT_HEADER, mintPhotoGrant } from '@/lib/photo-grant';
import { isGrantBearingPhotoRequest } from '@/lib/public-paths';

const SECRET = 'route-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const EUGENE = 'site-eugene';
const KEY = '0000000000abc-0000000000000000key1';
const LOAD = { id: 'load-1', site_id: EUGENE, assigned_operator_id: 'op-a' };
const OPERATOR = {
  id: 'op-a',
  is_active: true,
  deleted_at: null,
  role: 'operator',
  primary_site_id: EUGENE,
};

/**
 * Typed accessor for a recorded `create({ data })` call. `mock.calls` widens to
 * `[]` on a no-parameter mock, and the repo's tsconfig has
 * `noPropertyAccessFromIndexSignature`. Mirrors `confirm.route.test.ts`.
 */
function firstData(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const first = (
    spy.mock.calls as unknown as Array<Array<{ data: Record<string, unknown> }>>
  )[0]?.[0];
  if (!first) throw new Error('expected the spy to have been called at least once');
  return first.data;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:3000${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const MINT_BODY = { load_id: 'load-1', kind: 'bol', content_type: 'image/jpeg' };

function grant(over: Partial<Parameters<typeof mintPhotoGrant>[0]> = {}): string {
  return mintPhotoGrant({
    loadId: 'load-1',
    kind: 'bol',
    actorUserId: 'op-a',
    siteId: EUGENE,
    idempotencyKey: KEY,
    ...over,
  })!;
}

const saved = { secret: process.env['PHOTO_GRANT_SECRET'] };

beforeEach(() => {
  vi.clearAllMocks();
  loadPhotoCreate.mockResolvedValue({ id: 'photo-1' });
  process.env['PHOTO_GRANT_SECRET'] = SECRET;
  auth.mockResolvedValue(null);
  loadFindUnique.mockResolvedValue(LOAD);
  userFindUnique.mockResolvedValue(OPERATOR);
});

afterEach(() => {
  if (saved.secret === undefined) delete process.env['PHOTO_GRANT_SECRET'];
  else process.env['PHOTO_GRANT_SECRET'] = saved.secret;
});

// ── The feature, proved end to end ───────────────────────────────────────────

describe('ADR-0086 — a SESSIONLESS drain lands a photo', () => {
  // The whole point of F-3, driven through both real route handlers with
  // `auth()` returning null at every step: the last operator of the shift signed
  // out, the iPad is in the drawer, and the queue still drains.
  //
  // FALSIFIED BY HAND: reverting either route to `requireOperatorAtLoadSite`
  // makes this red at that step with 403, and the photo stays on the device
  // until somebody signs in — or dies with the device if nobody does.
  it('mint → confirm with no session at any point writes ONE row, attributed to the capturer', async () => {
    const token = grant();

    const mintRes = await MINT(
      post('/api/photos/upload-url', MINT_BODY, { [PHOTO_GRANT_HEADER]: token }),
    );
    expect(mintRes.status, 'the sessionless MINT was refused').toBe(200);
    const minted = (await mintRes.json()) as { storage_key: string; upload_grant?: string };

    // D2 — the mint RE-ISSUES, so the credential survives a multi-day queue life.
    expect(minted.upload_grant, 'the mint issued no grant to carry forward').toBeTruthy();

    const confirmRes = await CONFIRM(
      post(
        '/api/photos/confirm',
        { load_id: 'load-1', kind: 'bol', storage_key: minted.storage_key },
        { [PHOTO_GRANT_HEADER]: minted.upload_grant!, 'idempotency-key': KEY },
      ),
    );
    expect(confirmRes.status, 'the sessionless CONFIRM was refused').toBe(200);

    expect(loadPhotoCreate).toHaveBeenCalledTimes(1);
    const data = firstData(loadPhotoCreate);
    // D8 — the CAPTURE-TIME operator. Under the session path this would be
    // whoever happened to be signed in when the queue drained; here it is the
    // person who actually took the photo, which is more truthful, not less.
    expect(data['uploaded_by']).toBe('op-a');
    expect(data['storage_key']).toBe(minted.storage_key);
    // Self-upload: no audit row (ADR-0037 noise discipline is unchanged).
    expect(auditCreate).not.toHaveBeenCalled();
  });

  // D2 — "the re-issue carries the same `exp` as the presented one, never an
  // extended one". Checked at the ROUTE, because that is where the mistake would
  // be made: the minter happily produces a fresh 14-day window if you forget to
  // pass the old expiry through.
  //
  // FALSIFIED BY HAND: dropping `expiresAtSeconds` from the route's re-issue
  // makes this red, and a device that sweeps hourly then holds an immortal
  // credential.
  it('a re-issued grant carries the ORIGINAL expiry, not a fresh window', async () => {
    const capturedAt = Date.now() - 10 * 24 * 3600 * 1000;
    const original = mintPhotoGrant({
      loadId: 'load-1',
      kind: 'bol',
      actorUserId: 'op-a',
      siteId: EUGENE,
      idempotencyKey: KEY,
      nowMs: capturedAt,
    })!;
    const origExp = JSON.parse(
      Buffer.from(original.split('.')[0]!, 'base64url').toString('utf8'),
    ) as { exp: number };

    const res = await MINT(
      post('/api/photos/upload-url', MINT_BODY, { [PHOTO_GRANT_HEADER]: original }),
    );
    const { upload_grant } = (await res.json()) as { upload_grant: string };
    const reissued = JSON.parse(
      Buffer.from(upload_grant.split('.')[0]!, 'base64url').toString('utf8'),
    ) as { exp: number };

    expect(reissued.exp, 'the sweep extended its own credential').toBe(origExp.exp);
  });
});

// ── D7 symmetry — the structural guard on §2's constraint ────────────────────

describe('ADR-0086 D7 — mint and confirm accept and refuse the SAME grants', () => {
  // §2: "a relaxed mint with a strict confirm PUTs bytes to R2 and then refuses
  // to write the row, which is strictly worse than today — orphaned objects, no
  // record, and a queue row that still cannot drain. Any grant design that
  // authorizes one route and not the other is refused on that basis alone."
  //
  // Asserted STRUCTURALLY, by driving the same grants through both handlers,
  // rather than by two files agreeing by habit. A future edit that loosens or
  // tightens one route alone goes red here regardless of which one it was.
  //
  // FALSIFIED BY HAND: reverting `/api/photos/confirm` alone to the session-only
  // guard makes every `accepted` case red on the confirm side while the mint
  // stays green — which is precisely the half-applied change the ADR refuses.
  const cases: Array<{ name: string; token: string | null; accepted: boolean }> = [];

  beforeEach(() => {
    cases.length = 0;
    cases.push(
      { name: 'a valid grant', token: grant(), accepted: true },
      { name: 'a grant for another load', token: grant({ loadId: 'load-OTHER' }), accepted: false },
      { name: 'a grant for another kind', token: grant({ kind: 'rejection' }), accepted: false },
      {
        name: 'an expired grant',
        token: grant({ expiresAtSeconds: Math.floor(Date.now() / 1000) - 5 }),
        accepted: false,
      },
      { name: 'a tampered grant', token: `${grant().split('.')[0]}.AAAA`, accepted: false },
    );
  });

  it('every grant gets the same verdict from both routes', async () => {
    for (const c of cases) {
      const headers = c.token
        ? { [PHOTO_GRANT_HEADER]: c.token, 'idempotency-key': KEY }
        : { 'idempotency-key': KEY };

      const mintStatus = (await MINT(post('/api/photos/upload-url', MINT_BODY, headers))).status;
      const confirmStatus = (
        await CONFIRM(
          post(
            '/api/photos/confirm',
            { load_id: 'load-1', kind: 'bol', storage_key: 'loads/load-1/bol/a.jpg' },
            headers,
          ),
        )
      ).status;

      expect(
        mintStatus === 200,
        `${c.name}: mint answered ${mintStatus}, expected ${c.accepted ? 'accept' : 'refuse'}`,
      ).toBe(c.accepted);
      expect(
        confirmStatus === 200,
        `${c.name}: mint answered ${mintStatus} but confirm answered ${confirmStatus} — ` +
          'a relaxed mint with a strict confirm orphans R2 objects and still cannot drain',
      ).toBe(c.accepted);
    }
  });
});

// ── D1 — single-use by construction ──────────────────────────────────────────

describe('ADR-0086 D1 — a grant is bound to ONE idempotency key', () => {
  // The binding is what makes a captured grant worth nothing to an attacker: the
  // key it names is claimed in the same transaction as the insert, so a second
  // redemption returns the stored response and writes no second row. A confirm
  // that presented a DIFFERENT key would escape that claim entirely and the
  // grant would authorise unlimited photos.
  //
  // FALSIFIED BY HAND: deleting the `access.grantIdempotencyKey` comparison from
  // `/api/photos/confirm` makes both cases below return 200 — one grant, an
  // unbounded number of rows.
  it('refuses a confirm whose key differs from the grant’s', async () => {
    const res = await CONFIRM(
      post(
        '/api/photos/confirm',
        { load_id: 'load-1', kind: 'bol', storage_key: 'loads/load-1/bol/a.jpg' },
        { [PHOTO_GRANT_HEADER]: grant(), 'idempotency-key': '0000000000abc-0000000000000000key2' },
      ),
    );
    expect(res.status, 'a grant redeemed under a key it does not name').toBe(403);
    expect(await res.json()).toEqual({ error: 'grant_idempotency_key_mismatch' });
    expect(loadPhotoCreate).not.toHaveBeenCalled();
  });

  it('refuses a grant-auth confirm carrying NO key at all', async () => {
    const res = await CONFIRM(
      post(
        '/api/photos/confirm',
        { load_id: 'load-1', kind: 'bol', storage_key: 'loads/load-1/bol/a.jpg' },
        { [PHOTO_GRANT_HEADER]: grant() },
      ),
    );
    expect(res.status, 'an unbounded grant-auth write was allowed').toBe(403);
    expect(loadPhotoCreate).not.toHaveBeenCalled();
  });

  it('a SESSION confirm with no key still works — nothing tightened on that path', async () => {
    auth.mockResolvedValue({ user: { id: 'op-a', role: 'operator', primary_site_id: EUGENE } });
    const res = await CONFIRM(
      post('/api/photos/confirm', {
        load_id: 'load-1',
        kind: 'bol',
        storage_key: 'loads/load-1/bol/a.jpg',
      }),
    );
    expect(res.status, 'the session path was tightened as a side effect').toBe(200);
  });
});

// ── The unconfigured deployment ──────────────────────────────────────────────

describe('ADR-0086 — with NO secret, the session path is byte-for-byte unchanged', () => {
  // The deploy lands before the operator drops photo-grant.env. During that
  // window the app must behave exactly as it did yesterday: presigns minted,
  // photos confirmed, no grants issued, nothing refused that used to work.
  //
  // FALSIFIED BY HAND: making `mintPhotoGrant` throw when unconfigured (the
  // "fail loudly" instinct) turns the first case into a 500 and takes the photo
  // flow down on every deployment that has not yet been given the secret.
  beforeEach(() => {
    delete process.env['PHOTO_GRANT_SECRET'];
    auth.mockResolvedValue({ user: { id: 'op-a', role: 'operator', primary_site_id: EUGENE } });
  });

  it('mints a presign under a session and issues NO grant field', async () => {
    const res = await MINT(post('/api/photos/upload-url', { ...MINT_BODY, idempotency_key: KEY }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['storage_key']).toBeTruthy();
    expect(body['upload_url']).toBe('https://r2.example/put');
    expect(body, 'an unsigned or fixed-key grant was issued').not.toHaveProperty('upload_grant');
  });

  it('confirms under a session and writes the row', async () => {
    const res = await CONFIRM(
      post('/api/photos/confirm', {
        load_id: 'load-1',
        kind: 'bol',
        storage_key: 'loads/load-1/bol/a.jpg',
      }),
    );
    expect(res.status).toBe(200);
    expect(loadPhotoCreate).toHaveBeenCalledTimes(1);
  });

  it('issues no grant even under a session when the caller sends no key to bind', async () => {
    process.env['PHOTO_GRANT_SECRET'] = SECRET;
    const res = await MINT(post('/api/photos/upload-url', MINT_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('upload_grant');
  });
});

// ── D4 — the middleware was NOT weakened ─────────────────────────────────────

describe('ADR-0086 D4 — the middleware exemption is a keyhole, not a door', () => {
  // "An unauthenticated request with NO grant still 307s, and the route still
  // refuses." Read against the code that is now a 401 (ADR-0078 G7), which is
  // why the ADR's own D4 prose about `redirect: 'manual'` is stale — recorded in
  // the long note at `isGrantBearingPhotoRequest`.
  //
  // The predicate is the whole surface the middleware exposes, so this pins its
  // exact shape. `public-paths.test.ts` covers `isPublic` separately; the point
  // here is that the two photo routes are NOT in it.
  //
  // FALSIFIED BY HAND: adding `/api/photos/` to `PUBLIC_PATHS` (or making this
  // predicate return true on a missing header) makes the "no header" and
  // "garbage header" cases red — and puts a bearer-authorized WRITE on the far
  // side of the mechanism that has produced ten documented silent no-ops.
  it('lets through ONLY a POST to the two photo paths carrying a grant-shaped header', async () => {
    const G = 'abc.def';
    expect(isGrantBearingPhotoRequest('/api/photos/upload-url', 'POST', G)).toBe(true);
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', 'POST', G)).toBe(true);

    // No header, empty header, wrong shape — all refused at the edge.
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', 'POST', null)).toBe(false);
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', 'POST', '')).toBe(false);
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', 'POST', 'nodots')).toBe(false);
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', 'POST', 'a.b.c')).toBe(false);
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', 'POST', `${'x'.repeat(3000)}.y`)).toBe(
      false,
    );

    // Wrong method, and every neighbouring path. A MISSING method fails closed
    // rather than throwing — the predicate runs inside the middleware's auth
    // path, where a TypeError would be a 500 on every unauthenticated
    // navigation in the app.
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', 'GET', G)).toBe(false);
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', undefined, G)).toBe(false);
    expect(isGrantBearingPhotoRequest('/api/photos/confirm', null, G)).toBe(false);
    for (const p of [
      '/api/photos',
      '/api/photos/confirm/extra',
      '/api/photos/upload-url/',
      '/api/loads',
      '/api/operator/eugene/count',
      '/admin/users',
    ]) {
      expect(isGrantBearingPhotoRequest(p, 'POST', G), `${p} was let through`).toBe(false);
    }
  });

  it('a syntactically valid but FORGED header still gets refused by the route', async () => {
    // The keyhole only decides who may knock. The route is the gate — this is
    // the half of D4 that must never be traded away for the other half.
    const res = await CONFIRM(
      post(
        '/api/photos/confirm',
        { load_id: 'load-1', kind: 'bol', storage_key: 'loads/load-1/bol/a.jpg' },
        { [PHOTO_GRANT_HEADER]: 'AAAA.BBBB', 'idempotency-key': KEY },
      ),
    );
    expect(res.status, 'a forged grant reached the write').toBe(401);
    expect(loadPhotoCreate).not.toHaveBeenCalled();
  });
});

// ── 2026-08-10 — the expired session, through BOTH real routes ───────────────
//
// The Woodland rejection defect, asserted where the floor actually met it: the
// route's HTTP status. The guard's own suite pins the predicate; this pins that
// both handlers propagate it, because a mint that says 401 and a confirm that
// says 403 would leave the queue classifying the two halves of one photo into
// two different states.
//
// "Mint and confirm must move together" is already the stated contract of both
// route files (a relaxed mint with a strict confirm PUTs bytes to R2 and then
// refuses to write the row). It holds for refusals too.
describe('an expired operator session answers 401 on BOTH photo routes', () => {
  /**
   * The husk Auth.js hands a guard after the 5-minute operator idle window —
   * a truthy `user` with nothing in it. Proved against the real callbacks in
   * `src/lib/session-husk.test.ts`; reproduced here so the routes are driven
   * by the production shape rather than by `null`, which the old code ALSO
   * answered 403 and which is why the pre-existing suites agreed with the bug.
   */
  beforeEach(() => {
    auth.mockResolvedValue({
      user: { name: undefined, email: undefined, image: undefined, all_sites: false },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
  });

  it('the mint answers 401 — the status the queue can act on', async () => {
    const res = await MINT(post('/api/photos/upload-url', { ...MINT_BODY, idempotency_key: KEY }));
    expect(res.status, 'a lapsed session was called FORBIDDEN at the mint').toBe(401);
  });

  it('the confirm answers 401 too — the pair does not split', async () => {
    const res = await CONFIRM(
      post('/api/photos/confirm', {
        load_id: 'load-1',
        kind: 'bol',
        storage_key: 'loads/load-1/bol/a.jpg',
      }),
    );
    expect(res.status, 'mint and confirm disagreed about the same expired session').toBe(401);
    expect(loadPhotoCreate, 'an identity-less request wrote a photo row').not.toHaveBeenCalled();
  });

  // A rejection photo is the kind the defect was reported against, and it is
  // NOT special — same route, same guard, same status. Pinned so nobody
  // re-litigates a per-kind rule that never existed.
  it('does the same for kind=rejection, which is not a special case', async () => {
    const res = await MINT(
      post('/api/photos/upload-url', {
        load_id: 'load-1',
        kind: 'rejection',
        content_type: 'image/jpeg',
        idempotency_key: KEY,
      }),
    );
    expect(res.status).toBe(401);
  });

  // The husk must not become a way IN. With a valid grant on the same request
  // the grant path still authorises it — that is ADR-0086's whole point, and
  // widening the session refusal must not have disturbed it.
  it('still lets a VALID grant through on the same identity-less request', async () => {
    const res = await MINT(
      post(
        '/api/photos/upload-url',
        { ...MINT_BODY, idempotency_key: KEY },
        { [PHOTO_GRANT_HEADER]: grant() },
      ),
    );
    expect(res.status, 'the grant path was collateral damage of the 401 split').toBe(200);
  });
});
