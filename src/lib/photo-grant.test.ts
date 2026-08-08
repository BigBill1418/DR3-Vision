// ADR-0086 D7 — the grant primitive, over REAL HMAC bytes.
//
// Nothing in this file stubs `verifyPhotoGrant` or any branch of it. Every
// refusal below is produced by running the real verifier over a token the real
// minter produced (or over one deliberately damaged), because the property under
// test is "an attacker cannot forge or outlive a grant" and a stubbed `verify()`
// returning false proves only that the stub was written to return false. That
// failure — the mock measuring itself — has been caught six times on this
// campaign, so it is named at the top of each test rather than assumed away.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PHOTO_GRANT_TTL_SECONDS,
  grantFingerprint,
  mintPhotoGrant,
  photoGrantsConfigured,
  verifyPhotoGrant,
} from './photo-grant';

const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const MINT = {
  loadId: 'load-1',
  kind: 'bol' as const,
  actorUserId: 'op-a',
  siteId: 'site-eugene',
  idempotencyKey: '0000000000abc-0000000000000000key1',
};

const saved: Record<string, string | undefined> = {};
const VARS = [
  'PHOTO_GRANT_SECRET',
  'PHOTO_GRANT_SECRET_PREVIOUS',
  'PHOTO_GRANT_KEY_VERSION',
] as const;

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('ADR-0086 — fail closed when no secret is provisioned', () => {
  // §6.5 — "a grant feature that silently degrades to no-grants reproduces
  // today's behaviour without telling anyone it did". The telling happens on
  // /healthz; the DEGRADING must be to no-grants, never to unsigned or
  // fixed-key tokens.
  //
  // FALSIFIED BY HAND: making `mintPhotoGrant` fall back to a literal default
  // secret when the env var is missing turns this green-to-red — a token comes
  // back, and it is one every deployment on earth can forge.
  it('mints NOTHING rather than an unsigned or fixed-key token', () => {
    expect(photoGrantsConfigured()).toBe(false);
    expect(mintPhotoGrant(MINT)).toBeNull();
  });

  it('refuses a grant that WAS validly signed, once the secret is gone', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const token = mintPhotoGrant(MINT)!;
    expect(verifyPhotoGrant(token).ok).toBe(true);

    delete process.env['PHOTO_GRANT_SECRET'];
    const after = verifyPhotoGrant(token);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.reason).toBe('grant_not_configured');
  });
});

describe('ADR-0086 D7 — forged signature', () => {
  // "A payload signed with a DIFFERENT key is refused. Must run the real
  // verifier over real HMAC bytes."
  //
  // So the forgery is produced by the real minter under KEY_B — a
  // well-formed, correctly-structured, genuinely-signed token — and then
  // presented to a server that holds KEY_A. Not a hand-mangled string: an
  // attacker with their own key is the actual threat, and a garbage string
  // would be refused by the parser before the HMAC was ever consulted, which
  // would make this test measure the parser.
  //
  // FALSIFIED BY HAND: replacing the `timingSafeEqual` comparison in
  // `verifyPhotoGrant` with `return { ok: true, payload }` makes this red with
  // `expected true to be false`, and the forged actor lands on the row.
  it('refuses a token signed with another key', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_B;
    const forged = mintPhotoGrant({ ...MINT, actorUserId: 'attacker' })!;

    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const res = verifyPhotoGrant(forged);
    expect(res.ok, 'a grant signed with a foreign key was accepted').toBe(false);
    expect(res.ok === false && res.reason).toBe('grant_bad_signature');
  });

  // The subtler forgery: keep OUR signature, edit the payload it covers. This is
  // what an attacker holding a legitimate grant for their own load would try.
  it('refuses a token whose payload was edited under a valid signature', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const token = mintPhotoGrant(MINT)!;
    const [segment, sig] = token.split('.') as [string, string];

    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      load_id: string;
    };
    payload.load_id = 'load-SOMEONE-ELSE';
    const tampered = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${sig}`;

    const res = verifyPhotoGrant(tampered);
    expect(res.ok, 'an edited payload rode a valid signature through').toBe(false);
    expect(res.ok === false && res.reason).toBe('grant_bad_signature');
  });

  it('refuses a flipped signature byte', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const token = mintPhotoGrant(MINT)!;
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(verifyPhotoGrant(flipped).ok).toBe(false);
  });

  it('refuses malformed shapes without throwing', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    for (const bad of ['', 'nodot', 'a.b.c', '.sig', 'seg.', 'x'.repeat(4000)]) {
      const res = verifyPhotoGrant(bad);
      expect(res.ok, `"${bad.slice(0, 12)}" was accepted`).toBe(false);
    }
  });
});

describe('ADR-0086 D5 — expiry, driven by a real clock', () => {
  // "`exp` in the past is refused. Must drive a real clock/injected `now`, not a
  // mocked verifier branch."
  //
  // `nowMs` is threaded through mint AND verify, so this exercises the same
  // arithmetic the server runs; nothing about the verifier is stubbed.
  //
  // FALSIFIED BY HAND: deleting the `payload.exp <= nowSec` check makes the
  // second assertion red — a grant minted fifteen days ago still authorises a
  // write, which is the exact 14-day bound the ADR trades revocation against.
  it('accepts inside the window and refuses one second past it', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const capturedAt = Date.UTC(2026, 7, 8, 12, 0, 0);
    const token = mintPhotoGrant({ ...MINT, nowMs: capturedAt })!;

    // Day 13 — an iPad back from a long weekend. Still good.
    const inside = verifyPhotoGrant(token, capturedAt + 13 * 24 * 3600 * 1000);
    expect(inside.ok, 'a 13-day-old grant was refused inside its own window').toBe(true);

    // One second past 14 days.
    const outside = verifyPhotoGrant(token, capturedAt + (PHOTO_GRANT_TTL_SECONDS + 1) * 1000);
    expect(outside.ok, 'an expired grant still authorised a write').toBe(false);
    expect(outside.ok === false && outside.reason).toBe('grant_expired');
  });

  // D2 — "the re-issue must carry the original `exp` forward, never mint a new
  // 14-day window. Otherwise a device that sweeps hourly refreshes its own
  // credential indefinitely and the expiry means nothing."
  //
  // FALSIFIED BY HAND: dropping `expiresAtSeconds` from the re-issue call in
  // `/api/photos/upload-url` lets this token verify at day 20, i.e. the grant
  // becomes immortal on any device that keeps sweeping.
  it('a re-issue carries the ORIGINAL expiry, so sweeping cannot extend it', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const capturedAt = Date.UTC(2026, 7, 8, 12, 0, 0);
    const original = verifyPhotoGrant(mintPhotoGrant({ ...MINT, nowMs: capturedAt })!, capturedAt);
    expect(original.ok).toBe(true);
    const exp = original.ok ? original.payload.exp : 0;

    // Thirteen days later the device sweeps; the route re-issues.
    const sweptAt = capturedAt + 13 * 24 * 3600 * 1000;
    const reissued = mintPhotoGrant({ ...MINT, nowMs: sweptAt, expiresAtSeconds: exp })!;

    expect(verifyPhotoGrant(reissued, sweptAt).ok).toBe(true);
    const later = verifyPhotoGrant(reissued, capturedAt + 20 * 24 * 3600 * 1000);
    expect(later.ok, 'a sweep extended the credential past its original window').toBe(false);
  });
});

describe('ADR-0086 D6 — key rotation window, over two REAL keys', () => {
  // "A `v=N-1` grant verifies while `N-1` is live and is refused after
  // retirement. Must exercise two real keys."
  //
  // Why this matters more than it looks: a single-key implementation that swaps
  // the secret invalidates every grant in every iPad's IndexedDB at once —
  // converting a routine rotation into precisely the evidence-loss event this
  // feature exists to prevent, silently, because the device only sees refusals.
  //
  // FALSIFIED BY HAND: removing the `v === n - 1` branch from `keyForVersion`
  // makes the "mid-rotation" assertion red — every pre-rotation grant on the
  // floor dies the moment the secret is swapped.
  it('accepts N-1 during the window and refuses it after retirement', () => {
    // Before the rotation: v1 is current.
    process.env['PHOTO_GRANT_KEY_VERSION'] = '1';
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const old = mintPhotoGrant(MINT)!;
    expect(verifyPhotoGrant(old).ok).toBe(true);

    // Rotation day: v2 is current, v1 is retained for the 14-day tail.
    process.env['PHOTO_GRANT_KEY_VERSION'] = '2';
    process.env['PHOTO_GRANT_SECRET'] = KEY_B;
    process.env['PHOTO_GRANT_SECRET_PREVIOUS'] = KEY_A;

    expect(
      verifyPhotoGrant(old).ok,
      'a rotation killed every grant already queued on the floor',
    ).toBe(true);

    const fresh = mintPhotoGrant(MINT)!;
    const freshPayload = verifyPhotoGrant(fresh);
    expect(freshPayload.ok && freshPayload.payload.v, 'the minter must only ever issue N').toBe(2);

    // Retirement, no sooner than max(exp) — 14 days — after the rotation.
    delete process.env['PHOTO_GRANT_SECRET_PREVIOUS'];
    const retired = verifyPhotoGrant(old);
    expect(retired.ok, 'a retired key still verified').toBe(false);
    expect(retired.ok === false && retired.reason).toBe('grant_unknown_key_version');

    // The current key is unaffected by the retirement.
    expect(verifyPhotoGrant(fresh).ok).toBe(true);
  });

  it('refuses a version that was never issued', () => {
    process.env['PHOTO_GRANT_KEY_VERSION'] = '1';
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    process.env['PHOTO_GRANT_KEY_VERSION'] = '9';
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const v9 = mintPhotoGrant(MINT)!;
    process.env['PHOTO_GRANT_KEY_VERSION'] = '1';
    const res = verifyPhotoGrant(v9);
    expect(res.ok, 'a grant naming an unknown key version was accepted').toBe(false);
    expect(res.ok === false && res.reason).toBe('grant_unknown_key_version');
  });
});

describe('ADR-0086 §6.3 — the token never becomes a log line', () => {
  // Sentry is wired in this app. A fingerprint that embedded any part of the
  // credential would publish live credentials to an external service on the
  // first 403 anyone looked at.
  //
  // FALSIFIED BY HAND: returning `token.slice(0, 12)` from `grantFingerprint`
  // — a plausible-looking "prefix for correlation" — makes the containment
  // assertion red.
  it('a fingerprint contains no substring of the grant and is stable', () => {
    process.env['PHOTO_GRANT_SECRET'] = KEY_A;
    const token = mintPhotoGrant(MINT)!;
    const fp = grantFingerprint(token);

    expect(fp).toHaveLength(12);
    expect(token, 'the fingerprint is a slice of the credential').not.toContain(fp);
    expect(grantFingerprint(token), 'a fingerprint must correlate two log lines').toBe(fp);
    expect(grantFingerprint(`${token}x`)).not.toBe(fp);
  });
});
