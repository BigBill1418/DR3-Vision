// ADR-0067 Amendment A — the delegated auth-code flow.
//
// Two things carry the security weight of this ADR and both are asserted here
// directly rather than trusted:
//
//   1. `assertServiceAccount` — connecting as Bill personally would silently
//      expose HIS OneDrive instead of the service account's shares. The test
//      models that exact mistake.
//   2. The reauth CLASSIFICATION — only a dead refresh token may latch
//      `reauth_required`. A network blip or a 5xx must NOT, because a page for a
//      hiccup teaches the operator to ignore the page.
//
// Every network path is driven through an injected `fetchImpl`; CI has no
// tenant. What that cannot cover (Entra's actual response bodies) is recorded as
// unverified in the ADR instead of being asserted from imagination.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assertServiceAccount,
  DocIngestHandshakeError,
  DocIngestOAuthError,
  DocIngestReauthRequiredError,
  DocIngestSecretUnavailableError,
  DocIngestWrongAccountError,
  exchangeCode,
  fetchSignedInIdentity,
  HANDSHAKE_TTL_MS,
  pkceChallenge,
  probeDefaultDrive,
  redeemRefreshToken,
  startHandshake,
  verifyHandshake,
  type FetchLike,
} from '../oauth';
import { DOC_INGEST_CLIENT_ID, DOC_INGEST_SERVICE_UPN } from '../config';

const KEY_ENV = 'MYMRC_CRED_KEY'; // ADR-0067: derived, not a second secret
const SECRET_ENV = 'DOC_INGEST_CLIENT_SECRET';
const ORIGINAL_KEY = process.env[KEY_ENV];
const ORIGINAL_SECRET = process.env[SECRET_ENV];

beforeEach(() => {
  process.env[KEY_ENV] = 'unit-test-doc-ingest-key-please-ignore';
  process.env[SECRET_ENV] = 'unit-test-client-secret-please-ignore';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = ORIGINAL_KEY;
  if (ORIGINAL_SECRET === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = ORIGINAL_SECRET;
});

/** A fetch stub that answers once with a fixed status + JSON body. */
function jsonFetch(status: number, body: unknown): FetchLike {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
}

describe('startHandshake', () => {
  it('builds an authorize URL with PKCE S256 over the sealed verifier', () => {
    const { authorizeUrl, cookieValue } = startHandshake('admin-1');
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toContain('login.microsoftonline.com');
    expect(url.searchParams.get('client_id')).toBe(DOC_INGEST_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(cookieValue).toBeTruthy();
  });

  it('requests offline_access — without it there is no refresh token and no ADR', () => {
    const url = new URL(startHandshake('admin-1').authorizeUrl);
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('offline_access');
    expect(scopes).toContain('https://graph.microsoft.com/Files.Read.All');
    expect(scopes).toContain('https://graph.microsoft.com/Sites.Read.All');
  });

  it('forces a fresh sign-in and hints the SERVICE account, not the operator', () => {
    // Without prompt=login Entra silently reuses Bill's own browser session and
    // he connects his personal account by reflex. This is the mitigation.
    const url = new URL(startHandshake('admin-1').authorizeUrl);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('login_hint')).toBe(DOC_INGEST_SERVICE_UPN);
  });

  it('does not put the service-account password anywhere (it is not a runtime credential)', () => {
    const { authorizeUrl } = startHandshake('admin-1');
    expect(authorizeUrl).not.toContain('password');
    expect(authorizeUrl).not.toContain('grant_type');
  });

  it('mints a fresh state and verifier per call', () => {
    const a = new URL(startHandshake('admin-1').authorizeUrl);
    const b = new URL(startHandshake('admin-1').authorizeUrl);
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
  });
});

describe('pkceChallenge', () => {
  it('is RFC 7636 S256: base64url(sha256(verifier))', () => {
    const verifier = 'abc123';
    expect(pkceChallenge(verifier)).toBe(
      createHash('sha256').update(verifier, 'ascii').digest().toString('base64url'),
    );
  });
});

describe('verifyHandshake', () => {
  function started(actor = 'admin-1', now = Date.now()) {
    const s = startHandshake(actor, now);
    const state = new URL(s.authorizeUrl).searchParams.get('state')!;
    return { cookie: s.cookieValue, state };
  }

  it('returns the PKCE verifier on a clean round trip', () => {
    const { cookie, state } = started();
    expect(verifyHandshake(cookie, state, 'admin-1').codeVerifier).toBeTruthy();
  });

  it('refuses when the state does not match — the CSRF control', () => {
    const { cookie } = started();
    expect(() => verifyHandshake(cookie, 'attacker-supplied-state', 'admin-1')).toThrow(
      DocIngestHandshakeError,
    );
  });

  it('refuses a missing cookie', () => {
    const { state } = started();
    expect(() => verifyHandshake(undefined, state, 'admin-1')).toThrow(DocIngestHandshakeError);
  });

  it('refuses a missing state parameter', () => {
    const { cookie } = started();
    expect(() => verifyHandshake(cookie, undefined, 'admin-1')).toThrow(DocIngestHandshakeError);
  });

  it('refuses a forged cookie', () => {
    const { state } = started();
    expect(() => verifyHandshake('forged', state, 'admin-1')).toThrow(DocIngestHandshakeError);
  });

  it('refuses an expired handshake', () => {
    const t0 = 1_000_000;
    const { cookie, state } = started('admin-1', t0);
    expect(() => verifyHandshake(cookie, state, 'admin-1', t0 + HANDSHAKE_TTL_MS + 1)).toThrow(
      DocIngestHandshakeError,
    );
  });

  it('refuses when a DIFFERENT admin completes the callback', () => {
    const { cookie, state } = started('admin-1');
    expect(() => verifyHandshake(cookie, state, 'admin-2')).toThrow(DocIngestHandshakeError);
  });
});

describe('token endpoint classification', () => {
  const ok = {
    access_token: 'at',
    refresh_token: 'rt',
    expires_in: 3600,
    scope: 'Files.Read.All Sites.Read.All User.Read',
    id_token: 'idt',
  };

  it('normalizes a successful exchange', async () => {
    const now = 1_700_000_000_000;
    const set = await exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      fetchImpl: jsonFetch(200, ok),
      now,
    });
    expect(set.accessToken).toBe('at');
    expect(set.refreshToken).toBe('rt');
    expect(set.expiresAt.getTime()).toBe(now + 3_600_000);
    expect(set.grantedScopes).toBe('Files.Read.All Sites.Read.All User.Read');
    expect(set.idToken).toBe('idt');
  });

  it('REFUSES a token set with no refresh_token — offline_access was not granted', async () => {
    // A connection that cannot survive one access-token expiry is not a
    // connection. Accepting it would produce a surface that looks healthy for
    // exactly one hour and then dies with no explanation.
    const noRefresh: Record<string, unknown> = { ...ok };
    delete noRefresh['refresh_token'];
    await expect(
      exchangeCode({ code: 'c', codeVerifier: 'v', fetchImpl: jsonFetch(200, noRefresh) }),
    ).rejects.toThrow(DocIngestOAuthError);
  });

  it('classifies invalid_grant as REAUTH REQUIRED (a human must sign in again)', async () => {
    await expect(
      redeemRefreshToken({
        refreshToken: 'rt',
        fetchImpl: jsonFetch(400, {
          error: 'invalid_grant',
          error_description: 'AADSTS700082: The refresh token has expired.',
        }),
      }),
    ).rejects.toThrow(DocIngestReauthRequiredError);
  });

  it('classifies interaction_required as REAUTH REQUIRED', async () => {
    await expect(
      redeemRefreshToken({
        refreshToken: 'rt',
        fetchImpl: jsonFetch(400, { error: 'interaction_required' }),
      }),
    ).rejects.toThrow(DocIngestReauthRequiredError);
  });

  it('does NOT classify a 5xx as reauth — a blip must never page', async () => {
    const e = await redeemRefreshToken({
      refreshToken: 'rt',
      fetchImpl: jsonFetch(503, { error: 'temporarily_unavailable' }),
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DocIngestOAuthError);
    expect(e).not.toBeInstanceOf(DocIngestReauthRequiredError);
  });

  it('does NOT classify a network failure as reauth', async () => {
    const e = await redeemRefreshToken({
      refreshToken: 'rt',
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DocIngestOAuthError);
    expect(e).not.toBeInstanceOf(DocIngestReauthRequiredError);
  });

  it('fails loudly when no client secret is mounted', async () => {
    delete process.env[SECRET_ENV];
    const originalMail = process.env['MSGRAPH_MAIL_SECRET'];
    delete process.env['MSGRAPH_MAIL_SECRET'];
    try {
      await expect(
        exchangeCode({ code: 'c', codeVerifier: 'v', fetchImpl: jsonFetch(200, ok) }),
      ).rejects.toThrow(DocIngestSecretUnavailableError);
    } finally {
      if (originalMail !== undefined) process.env['MSGRAPH_MAIL_SECRET'] = originalMail;
    }
  });
});

describe('assertServiceAccount — the control that stops Bill connecting himself', () => {
  it('accepts the service account', () => {
    expect(() =>
      assertServiceAccount({ upn: DOC_INGEST_SERVICE_UPN, objectId: 'o', displayName: null }),
    ).not.toThrow();
  });

  it('accepts it case-insensitively (UPNs are not case-sensitive)', () => {
    expect(() =>
      assertServiceAccount({ upn: 'Docs-DR3@SVdP.us', objectId: 'o', displayName: null }),
    ).not.toThrow();
  });

  it('REFUSES Bill signing in as himself, and names the account he used', () => {
    const e = (() => {
      try {
        assertServiceAccount({
          upn: 'bill.barnard@svdp.us',
          objectId: 'o',
          displayName: 'Bill Barnard',
        });
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(DocIngestWrongAccountError);
    expect((e as DocIngestWrongAccountError).signedInUpn).toBe('bill.barnard@svdp.us');
  });
});

describe('fetchSignedInIdentity', () => {
  it('reads the UPN from Graph /me', async () => {
    const identity = await fetchSignedInIdentity(
      'at',
      jsonFetch(200, {
        id: 'obj-1',
        userPrincipalName: DOC_INGEST_SERVICE_UPN,
        displayName: 'Docs',
      }),
    );
    expect(identity.upn).toBe(DOC_INGEST_SERVICE_UPN);
    expect(identity.objectId).toBe('obj-1');
  });

  it('throws rather than accepting a response with no UPN to assert against', async () => {
    await expect(fetchSignedInIdentity('at', jsonFetch(200, { id: 'x' }))).rejects.toThrow(
      DocIngestOAuthError,
    );
  });

  it('treats a 401 as reauth-required', async () => {
    await expect(fetchSignedInIdentity('at', jsonFetch(401, {}))).rejects.toThrow(
      DocIngestReauthRequiredError,
    );
  });
});

describe('probeDefaultDrive — §A.5 async OneDrive provisioning', () => {
  it('treats a 404 as PENDING, not an error', async () => {
    // §A.5: Get-MgUserDefaultDrive 404s right after licensing; the account's
    // first interactive sign-in creates the drive. Failing the connect here
    // would break first-connect for anyone who does it promptly.
    const probe = await probeDefaultDrive('at', jsonFetch(404, {}));
    expect(probe).toEqual({ driveId: null, pending: true, error: null });
  });

  it('returns the drive id when provisioned', async () => {
    const probe = await probeDefaultDrive('at', jsonFetch(200, { id: 'drive-1' }));
    expect(probe).toEqual({ driveId: 'drive-1', pending: false, error: null });
  });

  it('records a 403 as an error but never throws — the connection is still valid', async () => {
    const probe = await probeDefaultDrive('at', jsonFetch(403, {}));
    expect(probe.driveId).toBeNull();
    expect(probe.pending).toBe(false);
    expect(probe.error).toContain('403');
  });

  it('swallows a network failure into the error field', async () => {
    const probe = await probeDefaultDrive('at', () => Promise.reject(new Error('boom')));
    expect(probe.error).toContain('boom');
  });
});
