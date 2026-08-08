// ADR-0086 D3 / D5(a) — the guard, running the REAL verifier over REAL HMAC
// bytes against a REAL `users` read.
//
// What is faked here and why: only `@/lib/auth` (there is no session to have)
// and `@/lib/prisma` (there is no Postgres on the build host — the real-database
// half is `photo-grant-redemption.db.test.ts`). `@/lib/photo-grant` and
// `isValidLoadPhotoStorageKey` are the genuine articles, because every claim
// below is about what the crypto and the prefix rule actually do. A suite that
// stubbed the verifier would be measuring its own stub — the failure mode this
// campaign has caught six times.
//
// Each refusal is asserted BY NAME, not merely as "not ok". A guard that
// refused everything for one reason would pass a `.ok === false` suite while
// being useless; the whole point of the taxonomy is that a red names the field
// that actually mismatched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
const loadFindUnique = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboundLoad: { findUnique: loadFindUnique },
    user: { findUnique: userFindUnique },
  },
}));

import { requireOperatorOrGrantAtLoadSite, type GrantRefusal } from './load-photo-guard';
import { PHOTO_GRANT_HEADER, mintPhotoGrant } from './photo-grant';

const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const EUGENE = 'site-eugene';
const WOODLAND = 'site-woodland';
const KEY = '0000000000abc-0000000000000000key1';

const LOAD = { id: 'load-1', site_id: EUGENE, assigned_operator_id: 'op-owner' };
const ACTIVE_OPERATOR = {
  id: 'op-a',
  is_active: true,
  deleted_at: null,
  role: 'operator',
  primary_site_id: EUGENE,
};

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

function req(token: string | null): Request {
  return new Request('http://127.0.0.1:3000/api/photos/confirm', {
    method: 'POST',
    headers: token ? { [PHOTO_GRANT_HEADER]: token } : {},
  });
}

/** Run the guard and return the refusal reason the route would emit. */
async function refusalFor(
  token: string,
  facts: Parameters<typeof requireOperatorOrGrantAtLoadSite>[1],
): Promise<{ status: number; reason: string | undefined }> {
  try {
    await requireOperatorOrGrantAtLoadSite(req(token), facts);
    return { status: 200, reason: undefined };
  } catch (e) {
    if (!(e instanceof Response)) throw e;
    const body = (await e.json().catch(() => ({}))) as { grant?: string };
    return { status: e.status, reason: body.grant };
  }
}

const saved = { secret: process.env['PHOTO_GRANT_SECRET'] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env['PHOTO_GRANT_SECRET'] = SECRET;
  auth.mockResolvedValue(null); // no session anywhere in this file unless stated
  loadFindUnique.mockResolvedValue(LOAD);
  userFindUnique.mockResolvedValue(ACTIVE_OPERATOR);
});

afterEach(() => {
  if (saved.secret === undefined) delete process.env['PHOTO_GRANT_SECRET'];
  else process.env['PHOTO_GRANT_SECRET'] = saved.secret;
});

// ── The point of the whole feature ───────────────────────────────────────────

describe('ADR-0086 — a grant authorises with NO session at all', () => {
  // This is the property F-3 exists for and the one every other test in this
  // file is a boundary on. `auth()` returns null throughout — there is no
  // session, there is no operator signed in, the shift ended — and the photo
  // still has a right to land.
  //
  // FALSIFIED BY HAND: reverting either photo route to
  // `requireOperatorAtLoadSite` makes this red with a bare 403, which is
  // exactly today's behaviour: the evidence sits on the iPad until somebody
  // signs in, and dies with the device if nobody does.
  it('returns capture-time access for a sessionless request', async () => {
    const access = await requireOperatorOrGrantAtLoadSite(req(grant()), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });

    // Stronger than "it worked": the session was never even CONSULTED. If the
    // guard fell back to `auth()` here, this test would still pass on a machine
    // that happened to have a session and would say nothing about the
    // sessionless case it claims to cover.
    expect(auth, 'the grant path went through the session after all').not.toHaveBeenCalled();
    expect(access.via).toBe('grant');
    // D8 — the CAPTURE-TIME operator, not whoever drained the queue. This is the
    // attribution improving, which runs opposite to the usual direction for a
    // bearer credential.
    expect(access.actorUserId).toBe('op-a');
    expect(access.loadOwnerUserId).toBe('op-owner');
    expect(access.siteId).toBe(EUGENE);
    // The key the confirm MUST present — this is what makes the grant single-use.
    expect(access.grantIdempotencyKey).toBe(KEY);
  });
});

// ── Field substitution (D7) ──────────────────────────────────────────────────

describe('ADR-0086 D7 — field substitution, re-signed with the REAL key', () => {
  // "Must re-sign a MUTATED payload with the real key, so it fails on field
  // MISMATCH rather than on signature." A test that mangled the token would go
  // green off `grant_bad_signature` and prove nothing about the field checks —
  // the load/kind scoping would be entirely absent and this suite would not
  // notice. Hence each grant below is minted, legitimately, for the wrong thing.
  //
  // FALSIFIED BY HAND: deleting the `grant.load_id !== facts.loadId` check makes
  // the first case return 200 — one grant then writes to every load in the site.
  it('a valid grant for load A is refused on a request for load B, naming the field', async () => {
    const other = grant({ loadId: 'load-OTHER' });
    loadFindUnique.mockResolvedValue({ ...LOAD, id: 'load-1' });

    const res = await refusalFor(other, {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.status).toBe(401);
    expect(res.reason, 'a grant for another load was accepted').toBe(
      'grant_load_mismatch' satisfies GrantRefusal,
    );
    // Refused BEFORE any database work — a refusal that still queried is a
    // refusal an attacker can use to probe.
    expect(
      loadFindUnique,
      'the load was read for a grant that could not match',
    ).not.toHaveBeenCalled();
  });

  it('a bol grant cannot post a weight_ticket, naming the field', async () => {
    const res = await refusalFor(grant({ kind: 'bol' }), {
      loadId: 'load-1',
      kind: 'weight_ticket',
      storageKey: 'loads/load-1/weight_ticket/abc.jpg',
    });
    expect(res.reason, 'a bol grant posted a weight_ticket').toBe(
      'grant_kind_mismatch' satisfies GrantRefusal,
    );
  });
});

// ── D3 — object identity by prefix ───────────────────────────────────────────

describe('ADR-0086 D3 — object identity is constrained by PREFIX, not equality', () => {
  // The correction from §4. `storage_key` is NOT in the payload, because the
  // drain re-mints one past eight minutes — so the check has to be structural.
  //
  // FALSIFIED BY HAND: removing the `isValidLoadPhotoStorageKey` call lets the
  // cross-load case return 200, and a grant for load A then writes a row whose
  // evidence object lives under load B.
  it('accepts ANY key under its own load/kind prefix — the re-mint case', async () => {
    // Two different UUIDs, i.e. capture and re-mint. Both must pass: this is
    // precisely what the old equality design got wrong for 100% of the
    // population it existed to serve.
    for (const key of ['loads/load-1/bol/first.jpg', 'loads/load-1/bol/re-minted-different.heic']) {
      const access = await requireOperatorOrGrantAtLoadSite(req(grant()), {
        loadId: 'load-1',
        kind: 'bol',
        storageKey: key,
      });
      expect(access.via, `a legitimately re-minted key was refused: ${key}`).toBe('grant');
    }
  });

  it('refuses a key under ANOTHER load, naming the prefix', async () => {
    const res = await refusalFor(grant(), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-SOMEONE-ELSE/bol/abc.jpg',
    });
    expect(res.reason, "a grant confirmed an object under another load's prefix").toBe(
      'grant_storage_key_prefix' satisfies GrantRefusal,
    );
  });

  it("refuses a key under another KIND's prefix", async () => {
    const res = await refusalFor(grant({ kind: 'bol' }), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/rejection/abc.jpg',
    });
    expect(res.reason).toBe('grant_storage_key_prefix' satisfies GrantRefusal);
  });

  it('refuses a key that walks out of its prefix', async () => {
    for (const key of [
      'loads/load-1/bol/../../load-2/bol/a.jpg',
      'loads/load-1/bol/nested/a.jpg',
      'loads/load-1/bol/',
    ]) {
      const res = await refusalFor(grant(), { loadId: 'load-1', kind: 'bol', storageKey: key });
      expect(res.reason, `traversal accepted: ${key}`).toBe('grant_storage_key_prefix');
    }
  });
});

// ── D5(a) — revocation, the hard requirement ─────────────────────────────────

describe('ADR-0086 D5(a) — revocation is consulted at REDEMPTION', () => {
  // "A grant whose `actor_user_id` is now inactive is refused. Must flip a real
  // `users` row." The row here is a real read through the real guard; only the
  // client is faked, and the flipped field is the one the admin surface writes.
  //
  // Why this is a hard requirement and not a nice-to-have: a grant is a bearer
  // token verified by signature, and signature verification does not consult the
  // `users` table. Without this read, "revoke this person's access" is untrue
  // for up to FOURTEEN DAYS — and that is a claim the compliance surface makes.
  // Kelsey Ruhland's availability ended 2026-08-08; a grant she minted on 08-07
  // would otherwise still authorise a write on 08-21, attributed to her.
  //
  // FALSIFIED BY HAND: deleting the `prisma.user.findUnique` block from
  // `authorizeByGrant` makes every case below return 200 — a departed
  // employee's fortnight of grants outlives their account, silently.
  it('refuses a deactivated actor, naming the user state', async () => {
    userFindUnique.mockResolvedValue({ ...ACTIVE_OPERATOR, is_active: false });
    const res = await refusalFor(grant(), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.status).toBe(401);
    expect(res.reason, "a deactivated employee's grant still wrote a row").toBe(
      'grant_actor_inactive' satisfies GrantRefusal,
    );
  });

  it('refuses a soft-deleted actor', async () => {
    userFindUnique.mockResolvedValue({ ...ACTIVE_OPERATOR, deleted_at: new Date() });
    const res = await refusalFor(grant(), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.reason).toBe('grant_actor_inactive' satisfies GrantRefusal);
  });

  it('refuses an actor who is no longer an operator', async () => {
    userFindUnique.mockResolvedValue({ ...ACTIVE_OPERATOR, role: 'manager' });
    const res = await refusalFor(grant(), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.reason).toBe('grant_actor_not_operator' satisfies GrantRefusal);
  });

  it('refuses an actor transferred to the other site — a grant is never wider than its session', async () => {
    // CLAUDE.md hard rule #2: Eugene and Woodland are strictly separated.
    userFindUnique.mockResolvedValue({ ...ACTIVE_OPERATOR, primary_site_id: WOODLAND });
    const res = await refusalFor(grant(), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.reason).toBe('grant_actor_site_mismatch' satisfies GrantRefusal);
  });

  it('refuses an actor whose row is gone entirely', async () => {
    userFindUnique.mockResolvedValue(null);
    const res = await refusalFor(grant(), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.reason).toBe('grant_actor_unknown' satisfies GrantRefusal);
  });
});

// ── D3 — the LIVE site is the authorization fact ─────────────────────────────

describe('ADR-0086 D3 — the grant’s site_id is advisory, the live load is not', () => {
  // A grant is a 14-day claim and a load's site is mutable state. Trusting a
  // fortnight-old assertion about where a load lives is the same class of error
  // as trusting a snapshot count that has since been superseded — so on
  // divergence the guard refuses rather than guessing which is right.
  //
  // FALSIFIED BY HAND: replacing the comparison with `access.siteId =
  // grant.site_id` makes this green-to-red only here — and in production it
  // would write a Eugene photo onto a Woodland load, across two MRC contracts in
  // two jurisdictions.
  it('refuses when the load has MOVED site since the grant was minted', async () => {
    loadFindUnique.mockResolvedValue({ ...LOAD, site_id: WOODLAND });
    const res = await refusalFor(grant({ siteId: EUGENE }), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.reason, 'a stale site claim was trusted over the live load').toBe(
      'grant_site_mismatch' satisfies GrantRefusal,
    );
  });

  it('404s a load that no longer exists', async () => {
    loadFindUnique.mockResolvedValue(null);
    const res = await refusalFor(grant(), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(res.reason).toBe('grant_load_not_found' satisfies GrantRefusal);
  });
});

// ── Never worse than today ───────────────────────────────────────────────────

describe('ADR-0086 — a refused grant NEVER makes a working upload fail', () => {
  // The regression this design must not introduce. A device whose grant expired
  // but whose operator is signed in has to drain exactly as it does today; a
  // world where presenting a stale credential broke a working path would be
  // strictly worse than not shipping the feature.
  //
  // FALSIFIED BY HAND: returning the grant refusal immediately instead of
  // falling through to `requireOperatorAtLoadSite` makes this red with a 401 —
  // and every iPad holding a fortnight-old grant stops uploading even while
  // somebody is standing there signed in.
  it('falls through to the session when the grant is expired', async () => {
    auth.mockResolvedValue({ user: { id: 'op-b', role: 'operator', primary_site_id: EUGENE } });
    const stale = mintPhotoGrant({
      loadId: 'load-1',
      kind: 'bol',
      actorUserId: 'op-a',
      siteId: EUGENE,
      idempotencyKey: KEY,
      expiresAtSeconds: Math.floor(Date.now() / 1000) - 60,
    })!;

    const access = await requireOperatorOrGrantAtLoadSite(req(stale), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(access.via, 'a stale grant broke a perfectly good signed-in upload').toBe('session');
    // Attributed to the session that actually did it (ADR-0078 Am.1).
    expect(access.actorUserId).toBe('op-b');
    expect(access.grantIdempotencyKey).toBeNull();
  });

  it('falls through to the session when NO secret is provisioned', async () => {
    delete process.env['PHOTO_GRANT_SECRET'];
    auth.mockResolvedValue({ user: { id: 'op-b', role: 'operator', primary_site_id: EUGENE } });

    const access = await requireOperatorOrGrantAtLoadSite(req('someseg.somesig'), {
      loadId: 'load-1',
      kind: 'bol',
      storageKey: 'loads/load-1/bol/abc.jpg',
    });
    expect(access.via, 'an unconfigured deployment stopped accepting photos').toBe('session');
  });

  // With no grant header at all nothing about the guard changes — the refusal is
  // the session guard's own `Response`, not a grant-shaped 401.
  it('a sessionless request with NO grant is refused exactly as before', async () => {
    let status = 0;
    let body = '';
    try {
      await requireOperatorOrGrantAtLoadSite(req(null), { loadId: 'load-1', kind: 'bol' });
    } catch (e) {
      if (!(e instanceof Response)) throw e;
      status = e.status;
      body = await e.text();
    }
    expect(status).toBe(403);
    expect(body).toBe('forbidden');
  });
});

// ── §6.3 — the credential never reaches a log or an error body ───────────────

describe('ADR-0086 §6.3 — a refusal never echoes the credential', () => {
  // Sentry is wired here (`sentry.client.config.ts` / `.server.config.ts`). A
  // 403 handler that echoed the offending header would publish live credentials
  // to an external service — on the one code path an incident guarantees people
  // will be reading.
  //
  // FALSIFIED BY HAND: adding `token` to the thrown JSON body makes this red.
  it('the 401 body carries a reason and a fingerprint, never the token', async () => {
    userFindUnique.mockResolvedValue({ ...ACTIVE_OPERATOR, is_active: false });
    const token = grant();
    let text = '';
    try {
      await requireOperatorOrGrantAtLoadSite(req(token), {
        loadId: 'load-1',
        kind: 'bol',
        storageKey: 'loads/load-1/bol/abc.jpg',
      });
    } catch (e) {
      if (!(e instanceof Response)) throw e;
      text = await e.text();
    }
    expect(text).toContain('grant_actor_inactive');
    expect(text, 'the refusal body echoed the live credential').not.toContain(token);
    // Not even the signature half on its own.
    expect(text).not.toContain(token.split('.')[1]!);
    expect(JSON.parse(text)).toHaveProperty('grant_fp');
  });
});
