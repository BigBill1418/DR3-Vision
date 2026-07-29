// ADR-0067 Amendment A — the delegated authorization-code flow.
//
// Bill clicks "Connect document service account" → standard auth-code redirect →
// he signs in INTERACTIVELY as docs-dr3@svdp.us (completing MFA) → Vision
// exchanges the code for access + refresh tokens → the refresh token is stored
// encrypted and rolled forward.
//
// NOT ROPC. The earlier §3.5 framing assumed unattended sign-in implies ROPC and
// worried about Conditional Access; Amendment A retires that. ROPC is
// deprecated, disabled in most tenants, and unnecessary — the MFA claim rides
// the token chain, so no CA change is needed.
//
// ── Everything here is transport-injectable ─────────────────────────────────
// Every network call takes a `fetchImpl`. CI has no tenant, so the unit tests
// drive these functions with a stub. What is NOT stubbable — the actual Entra
// responses — is flagged as unverified in the ADR rather than asserted.
//
// ── Handshake state lives in a sealed cookie, not a table ───────────────────
// The CSRF `state` and the PKCE `code_verifier` are needed for exactly one
// round trip of one browser. A DB table for that would need a TTL sweeper and a
// cleanup cron to avoid growing forever. A sealed (AES-256-GCM) httpOnly cookie
// carries both, self-expires, and cannot be read or forged by the browser. The
// callback is a top-level GET navigation from login.microsoftonline.com, so
// SameSite=Lax still delivers it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DOC_INGEST_CLIENT_ID,
  DOC_INGEST_REQUESTED_SCOPES,
  DOC_INGEST_SERVICE_UPN,
  DOC_INGEST_TENANT_ID,
  authorizeEndpoint,
  docIngestRedirectUri,
  readClientSecret,
  tokenEndpoint,
} from './config';
import { openFromString, sealToString } from './secret-box';

/** Injectable fetch so every network path is testable without a tenant. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 20_000;

/** How long a started handshake stays valid. Longer than a real sign-in + MFA, shorter than a coffee break. */
export const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

/** Name of the sealed handshake cookie. */
export const HANDSHAKE_COOKIE = 'dr3_doc_ingest_oauth';

// ── Typed errors ─────────────────────────────────────────────────────────────

/** The client secret is not mounted. Connect cannot proceed. LOUD, never a silent skip. */
export class DocIngestSecretUnavailableError extends Error {
  override readonly name = 'DocIngestSecretUnavailableError';
  constructor(message: string) {
    super(message);
  }
}

/** State/PKCE verification failed — missing, expired, forged, or actor-mismatched cookie. */
export class DocIngestHandshakeError extends Error {
  override readonly name = 'DocIngestHandshakeError';
  constructor(message: string) {
    super(message);
  }
}

/** Entra or Graph returned an error we cannot recover from within this request. */
export class DocIngestOAuthError extends Error {
  override readonly name = 'DocIngestOAuthError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * The refresh token is dead — revoked, expired, or invalidated (password
 * change, session revocation, MFA policy reset). This is the ONLY error class
 * that means "a human must sign in again", and it is what latches
 * `reauth_required`, pages `dr3-vision-system`, and HALTS ingestion. Distinct
 * from a transient network/5xx failure, which must NOT latch.
 */
export class DocIngestReauthRequiredError extends Error {
  override readonly name = 'DocIngestReauthRequiredError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * A DIFFERENT account completed the sign-in. Connecting as Bill personally
 * would silently expose HIS files instead of the service account's shares — so
 * the connection is REFUSED and no token is persisted.
 */
export class DocIngestWrongAccountError extends Error {
  override readonly name = 'DocIngestWrongAccountError';
  readonly signedInUpn: string;
  constructor(signedInUpn: string) {
    super(
      `signed in as ${signedInUpn}, but this connection must be ${DOC_INGEST_SERVICE_UPN} — connection refused`,
    );
    this.signedInUpn = signedInUpn;
  }
}

// ── PKCE + state ─────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** RFC 7636 S256 challenge. PKCE on a confidential client is defence in depth, not a substitute for the secret. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** What the sealed handshake cookie carries. */
export interface HandshakeEnvelope {
  state: string;
  codeVerifier: string;
  actorUserId: string;
  issuedAt: number;
}

function isHandshakeEnvelope(v: unknown): v is HandshakeEnvelope {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['state'] === 'string' &&
    typeof o['codeVerifier'] === 'string' &&
    typeof o['actorUserId'] === 'string' &&
    typeof o['issuedAt'] === 'number'
  );
}

export interface StartedHandshake {
  /** Where the browser must be sent. */
  authorizeUrl: string;
  /** Sealed value for the {@link HANDSHAKE_COOKIE} cookie. */
  cookieValue: string;
}

/**
 * Begin the auth-code flow for `actorUserId` (the signed-in admin).
 *
 * `prompt=login` is deliberate and load-bearing: without it Entra silently
 * reuses Bill's OWN existing browser session and he ends up connecting his
 * personal account by reflex. `login_hint` pre-fills the service account so the
 * right thing is also the easy thing. The UPN is still asserted server-side
 * afterwards — the hint is ergonomics, never a control.
 */
export function startHandshake(actorUserId: string, now: number = Date.now()): StartedHandshake {
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(64));
  const envelope: HandshakeEnvelope = { state, codeVerifier, actorUserId, issuedAt: now };

  const params = new URLSearchParams({
    client_id: DOC_INGEST_CLIENT_ID,
    response_type: 'code',
    redirect_uri: docIngestRedirectUri(),
    response_mode: 'query',
    scope: DOC_INGEST_REQUESTED_SCOPES.join(' '),
    state,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: 'S256',
    prompt: 'login',
    login_hint: DOC_INGEST_SERVICE_UPN,
  });

  return {
    authorizeUrl: `${authorizeEndpoint()}?${params.toString()}`,
    cookieValue: sealToString(envelope),
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify the callback against the sealed cookie and return the PKCE verifier.
 *
 * Four independent checks, all of which must pass: the cookie decrypts (proves
 * WE issued it), the `state` matches in constant time (CSRF), the envelope has
 * not expired, and the admin completing the callback is the same admin who
 * started it (so one admin cannot be walked into finishing another's handshake).
 */
export function verifyHandshake(
  cookieValue: string | undefined,
  stateFromQuery: string | undefined,
  actorUserId: string,
  now: number = Date.now(),
): { codeVerifier: string } {
  if (!cookieValue) {
    throw new DocIngestHandshakeError('no handshake cookie — start the connection again');
  }
  if (!stateFromQuery) {
    throw new DocIngestHandshakeError('callback carried no state parameter');
  }
  let envelope: unknown;
  try {
    envelope = openFromString(cookieValue);
  } catch {
    throw new DocIngestHandshakeError('handshake cookie failed its integrity check');
  }
  if (!isHandshakeEnvelope(envelope)) {
    throw new DocIngestHandshakeError('handshake cookie has an unrecognized shape');
  }
  if (!constantTimeEquals(envelope.state, stateFromQuery)) {
    throw new DocIngestHandshakeError('state mismatch — possible CSRF, connection refused');
  }
  if (now - envelope.issuedAt > HANDSHAKE_TTL_MS) {
    throw new DocIngestHandshakeError('handshake expired — start the connection again');
  }
  if (envelope.actorUserId !== actorUserId) {
    throw new DocIngestHandshakeError('handshake was started by a different administrator');
  }
  return { codeVerifier: envelope.codeVerifier };
}

// ── Token endpoint ───────────────────────────────────────────────────────────

/** A successful token response, normalized. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of the ACCESS token. */
  expiresAt: Date;
  /** Verbatim `scope` from the response — stored so granted-vs-required can be diffed later. */
  grantedScopes: string;
  /** Present iff an OIDC id_token came back; its presence is how the identity scopes are proven. */
  idToken: string | null;
}

/**
 * Entra `error` codes that mean the refresh token is dead and only a human can
 * fix it. Everything else (network failure, 429, 5xx) is transient and must NOT
 * latch `reauth_required` — latching on a blip would page Bill for a hiccup and
 * teach him to ignore the page.
 */
const REAUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
]);

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postToken(
  body: URLSearchParams,
  fetchImpl: FetchLike,
  now: number,
): Promise<TokenSet> {
  const secret = readClientSecret();
  if (!secret) {
    throw new DocIngestSecretUnavailableError(
      'no client secret is mounted (DOC_INGEST_CLIENT_SECRET / MSGRAPH_MAIL_SECRET) — cannot reach the token endpoint',
    );
  }
  body.set('client_id', DOC_INGEST_CLIENT_ID);
  body.set('client_secret', secret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint(), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    // Network-level failure. Transient by construction — never latches reauth.
    throw new DocIngestOAuthError(`token endpoint unreachable: ${describe(e)}`);
  } finally {
    clearTimeout(timer);
  }

  let raw: RawTokenResponse;
  try {
    raw = (await res.json()) as RawTokenResponse;
  } catch {
    throw new DocIngestOAuthError(`token endpoint returned non-JSON (HTTP ${res.status})`);
  }

  if (typeof raw.error === 'string') {
    // `error_description` embeds the AADSTS code and is safe to keep: it carries
    // no token material. It is what makes "why did this stop working" answerable.
    const detail = typeof raw.error_description === 'string' ? raw.error_description : '';
    const message = `${raw.error}${detail ? `: ${firstLine(detail)}` : ''}`;
    if (REAUTH_ERROR_CODES.has(raw.error)) throw new DocIngestReauthRequiredError(message);
    throw new DocIngestOAuthError(message);
  }
  if (!res.ok) throw new DocIngestOAuthError(`token endpoint returned HTTP ${res.status}`);

  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : null;
  const refreshToken = typeof raw.refresh_token === 'string' ? raw.refresh_token : null;
  if (!accessToken) throw new DocIngestOAuthError('token response carried no access_token');
  if (!refreshToken) {
    // No refresh token means `offline_access` was not actually granted. Failing
    // here is the point: a connection that cannot survive an access-token expiry
    // is not a connection, and accepting it would produce a surface that looks
    // healthy for exactly one hour.
    throw new DocIngestOAuthError(
      'token response carried no refresh_token — offline_access was not granted',
    );
  }
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600;

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now + expiresIn * 1000),
    grantedScopes: typeof raw.scope === 'string' ? raw.scope : '',
    idToken: typeof raw.id_token === 'string' ? raw.id_token : null,
  };
}

/** Exchange an authorization code (plus its PKCE verifier) for a token set. */
export async function exchangeCode(args: {
  code: string;
  codeVerifier: string;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: docIngestRedirectUri(),
    code_verifier: args.codeVerifier,
    scope: DOC_INGEST_REQUESTED_SCOPES.join(' '),
  });
  return postToken(body, args.fetchImpl ?? globalThis.fetch, args.now ?? Date.now());
}

/**
 * Redeem a refresh token. Entra issues a NEW refresh token on every redemption
 * — the caller MUST persist `refreshToken` from the result, or the chain dies
 * when the old one ages out.
 */
export async function redeemRefreshToken(args: {
  refreshToken: string;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    scope: DOC_INGEST_REQUESTED_SCOPES.join(' '),
  });
  return postToken(body, args.fetchImpl ?? globalThis.fetch, args.now ?? Date.now());
}

// ── Graph identity + drive probe ─────────────────────────────────────────────

export interface SignedInIdentity {
  upn: string;
  objectId: string | null;
  displayName: string | null;
}

/**
 * Resolve who actually signed in, from Graph `/me` with the fresh access token.
 *
 * Deliberately NOT parsed out of the id_token. The id_token arrives over a
 * direct TLS back channel and is trustworthy, but `/me` is an authoritative
 * live check against the same credential we are about to store, and it costs
 * one request on a once-per-connect path. The account assertion is the single
 * control preventing "Bill connected himself and exposed his own OneDrive", so
 * it gets the stronger check.
 */
export async function fetchSignedInIdentity(
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<SignedInIdentity> {
  const body = await graphGet(
    `${GRAPH_BASE}/me?$select=id,userPrincipalName,displayName`,
    accessToken,
    fetchImpl,
  );
  const upn = typeof body['userPrincipalName'] === 'string' ? body['userPrincipalName'] : null;
  if (!upn) throw new DocIngestOAuthError('Graph /me returned no userPrincipalName');
  return {
    upn,
    objectId: typeof body['id'] === 'string' ? body['id'] : null,
    displayName: typeof body['displayName'] === 'string' ? body['displayName'] : null,
  };
}

/** Outcome of the §A.5 OneDrive provisioning probe. */
export interface DriveProbe {
  /** The drive id, or null when OneDrive has not provisioned yet. */
  driveId: string | null;
  /**
   * True when Graph answered 404 — OneDrive is still provisioning. §A.5: this
   * is NOT an error. `Get-MgUserDefaultDrive` 404s right after licensing and the
   * account's first interactive sign-in is what creates the drive.
   */
  pending: boolean;
  /** A real failure (403/5xx/network). Recorded, surfaced, but never fatal to the connection. */
  error: string | null;
}

/**
 * Probe the service account's default OneDrive. Never throws: a connection
 * whose drive is still provisioning is a VALID connection, and treating the
 * 404 as fatal would make first-connect fail for everyone who does it promptly.
 */
export async function probeDefaultDrive(
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<DriveProbe> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${GRAPH_BASE}/me/drive?$select=id`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return { driveId: null, pending: true, error: null };
    if (!res.ok) {
      return {
        driveId: null,
        pending: false,
        error: `Graph /me/drive returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? body['id'] : null;
    if (!id) return { driveId: null, pending: false, error: 'Graph /me/drive returned no id' };
    return { driveId: id, pending: false, error: null };
  } catch (e) {
    return { driveId: null, pending: false, error: `Graph /me/drive failed: ${describe(e)}` };
  }
}

async function graphGet(
  url: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch (e) {
    throw new DocIngestOAuthError(`Graph request failed: ${describe(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    throw new DocIngestReauthRequiredError('Graph rejected the access token (401)');
  }
  if (!res.ok) throw new DocIngestOAuthError(`Graph returned HTTP ${res.status} for ${url}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Assert the signed-in account IS the service account. Case-insensitive; UPNs are not case-sensitive. */
export function assertServiceAccount(identity: SignedInIdentity): void {
  if (identity.upn.trim().toLowerCase() !== DOC_INGEST_SERVICE_UPN.toLowerCase()) {
    throw new DocIngestWrongAccountError(identity.upn);
  }
}

/** Tenant id, exposed for the status surface so the ADR value and the runtime value are visibly the same. */
export const CONNECTED_TENANT_ID = DOC_INGEST_TENANT_ID;

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.slice(0, 400) ?? '';
}
