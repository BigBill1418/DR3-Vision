import { createHmac, timingSafeEqual } from 'node:crypto';

// ADR-0086 — capture-time photo upload grants (F-3).
//
// ## What this credential IS
//
// A 14-day bearer token minted AT CAPTURE, while a session provably exists, that
// carries the right to attach ONE photo, of ONE declared kind, to ONE named load,
// under ONE already-claimed idempotency key. It cannot read anything, cannot
// enumerate, and cannot write a count, a bonus entry, an inventory row or money.
//
// It exists because on iOS there is no closed-app execution: a queued photo needs
// a live signed-in session at the same site in order to drain, and the bytes live
// in exactly one iPad's IndexedDB. If the last operator of a shift signs out while
// photos are still queued, the evidence sits there until somebody signs in again
// on that same device. A wipe, a reset, a replaced iPad — and it is gone.
//
// ## What is deliberately NOT in the payload: `storage_key`
//
// This is the correction ADR-0086 §4 exists to record, and it must not be
// "fixed" by a later reader.
//
// The earlier recorded design (OPEN-ITEMS §0.AJ) signed the grant over
// `storage_key` and required the request's fields to match the grant EXACTLY.
// That is circular and unbuildable: `replayUpload` treats a presign as stale at
// 8 minutes (the R2 presign lives 600 s), and re-minting produces a brand-new
// key because `mintUploadUrl` embeds a fresh `randomUUID()`. Every photo this
// feature exists for is older than eight minutes, so every one of them would
// fail the grant's own field-match check.
//
// The same fact that makes `storage_key` excluded from the ADR-0078 idempotency
// request hash makes it unusable here: it legitimately CHANGES between an
// attempt and its replay. So the grant is a claim about the right to attach a
// photo, and object identity is constrained STRUCTURALLY instead — by key prefix
// (`isValidLoadPhotoStorageKey` in `@/lib/r2`), which cannot be spoofed into
// another load's prefix and does not care which UUID the mint produced.
//
// ## Encoding
//
//   <base64url(JSON payload)>.<base64url(HMAC-SHA256 over the payload segment)>
//
// The signature covers the ENCODED segment, not the decoded object, so there is
// no canonicalisation gap between what was signed and what is verified.
//
// ## Transport and logging
//
// Header only (`X-Upload-Grant`), never a URL parameter — a grant in a URL lands
// in access logs, `Referer` and browser history. NEVER log the token itself; log
// `grantFingerprint()` instead, which is a truncated hash and is not a credential.
// Sentry is wired in this app, so a 403 handler that echoed the offending header
// would publish live credentials to an external service.

import type { PhotoKind } from '@prisma/client';

/** The one header a grant ever travels in. Lowercase — `Headers.get` is case-insensitive. */
export const PHOTO_GRANT_HEADER = 'x-upload-grant';

/**
 * ADR-0086 D5 — 14 days. It covers a long weekend, a holiday shutdown, and an
 * iPad that spends a week in a drawer, which is the population F-3 is for.
 *
 * The cost is stated rather than hidden: a grant OUTLIVES the operator's
 * employment. That is why {@link verifyPhotoGrant} is only half the check and
 * the redemption-time `users` re-read (D5a) is a hard requirement, not a
 * nice-to-have — see `requireOperatorOrGrantAtLoadSite`.
 */
export const PHOTO_GRANT_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Upper bound on a token we will even attempt to parse. A grant payload is a
 * handful of ids; anything near this is not one, and refusing early keeps a
 * hostile body away from `JSON.parse` and the HMAC.
 */
export const PHOTO_GRANT_MAX_LENGTH = 2048;

export interface PhotoGrantPayload {
  /** Key/format version. SELECTS the verification key — see {@link keyForVersion}. */
  v: number;
  /** The one load this grant can write to. */
  load_id: string;
  /** One of the five `PHOTO_KINDS`. A `bol` grant cannot post a `weight_ticket`. */
  kind: PhotoKind;
  /** The capture-time operator. Becomes `uploaded_by` (ADR-0086 D8). */
  actor_user_id: string;
  /**
   * The load's site as read AT MINT TIME. Advisory only: D3 re-reads the LIVE
   * load and compares, because a load's site is mutable state and a fortnight-old
   * assertion about where a load lives is not an authorization fact.
   */
  site_id: string;
  /** The client-minted queue id this photo already carries. Single-use by construction. */
  idempotency_key: string;
  /** Unix SECONDS. */
  exp: number;
}

/** Why a grant was refused. Never carries the token or the secret. */
export type PhotoGrantFailure =
  | 'grant_not_configured'
  | 'grant_malformed'
  | 'grant_unknown_key_version'
  | 'grant_bad_signature'
  | 'grant_expired';

export type PhotoGrantVerification =
  | { ok: true; payload: PhotoGrantPayload }
  | { ok: false; reason: PhotoGrantFailure };

// ── Key material ─────────────────────────────────────────────────────────────

/**
 * ADR-0086 D6 — `v` selects the key, and that is what makes rotation survivable.
 *
 * A single-key implementation that swapped the secret would invalidate every
 * grant in every iPad's IndexedDB at once — converting a routine credential
 * rotation into precisely the evidence-loss event this feature exists to
 * prevent, and doing it SILENTLY, because the device just sees refusals it would
 * classify as somebody else's problem.
 *
 * So: the verifier accepts `v = N` and `v = N-1`, the minter only ever issues
 * `v = N`, and `N-1` may be retired no sooner than 14 days (`max(exp)`) after the
 * rotation. `PHOTO_GRANT_KEY_VERSION` is N; `PHOTO_GRANT_SECRET` is its key;
 * `PHOTO_GRANT_SECRET_PREVIOUS` is N-1's, present only during a rotation window.
 *
 * Read from `process.env` on every call rather than cached at module load: the
 * tests exercise two real keys and a real rotation, and a module-scope cache
 * would make that untestable without resetting the module registry.
 */
function currentKeyVersion(): number {
  const raw = process.env['PHOTO_GRANT_KEY_VERSION'];
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function secretFor(which: 'current' | 'previous'): string | null {
  const raw =
    which === 'current'
      ? process.env['PHOTO_GRANT_SECRET']
      : process.env['PHOTO_GRANT_SECRET_PREVIOUS'];
  return raw && raw.length > 0 ? raw : null;
}

function keyForVersion(v: number): string | null {
  const n = currentKeyVersion();
  if (v === n) return secretFor('current');
  if (v === n - 1) return secretFor('previous');
  return null;
}

/**
 * True when this process can mint grants at all.
 *
 * Surfaced on `/healthz` as `photo_grants_ok` per ADR-0086 §6.5 ("the app must
 * refuse to mint grants and say so on the health surface"). Deliberately NOT
 * part of the healthz `ok`/`status` verdict: gating the deploy on it would mean
 * the very first deploy of this feature — which necessarily lands before the
 * operator drops the secret file — rolls itself back.
 */
export function photoGrantsConfigured(): boolean {
  return secretFor('current') !== null;
}

// ── base64url ────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(secret: string, segment: string): string {
  return b64url(createHmac('sha256', secret).update(segment).digest());
}

// ── Mint ─────────────────────────────────────────────────────────────────────

export interface MintPhotoGrantArgs {
  loadId: string;
  kind: PhotoKind;
  actorUserId: string;
  siteId: string;
  idempotencyKey: string;
  /**
   * ADR-0086 D2 — a RE-ISSUE carries the original expiry forward, never a fresh
   * 14-day window. Without that, a device that sweeps hourly refreshes its own
   * credential indefinitely and the expiry means nothing at all.
   */
  expiresAtSeconds?: number;
  /** Injected in tests so an expiry test drives a real clock rather than a mocked branch. */
  nowMs?: number;
}

/**
 * Mint a grant, or `null` when no secret is provisioned.
 *
 * `null` rather than a throw, and that is the whole fail-closed posture: an
 * unconfigured deployment must keep minting presigned URLs and writing photos
 * down the ORDINARY session path exactly as it does today. It simply issues no
 * grants. A grant feature that took the session path down with it when its
 * secret was missing would be a strictly worse outage than the residual it
 * closes.
 */
export function mintPhotoGrant(args: MintPhotoGrantArgs): string | null {
  const v = currentKeyVersion();
  const secret = keyForVersion(v);
  if (!secret) return null;
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const payload: PhotoGrantPayload = {
    v,
    load_id: args.loadId,
    kind: args.kind,
    actor_user_id: args.actorUserId,
    site_id: args.siteId,
    idempotency_key: args.idempotencyKey,
    exp: args.expiresAtSeconds ?? nowSec + PHOTO_GRANT_TTL_SECONDS,
  };
  const segment = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${segment}.${sign(secret, segment)}`;
}

// ── Verify ───────────────────────────────────────────────────────────────────

function isPlainString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256;
}

function parsePayload(raw: unknown): PhotoGrantPayload | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Number.isInteger(o['v'])) return null;
  if (!isPlainString(o['load_id'])) return null;
  if (!isPlainString(o['kind'])) return null;
  if (!isPlainString(o['actor_user_id'])) return null;
  if (!isPlainString(o['site_id'])) return null;
  if (!isPlainString(o['idempotency_key'])) return null;
  if (typeof o['exp'] !== 'number' || !Number.isFinite(o['exp'])) return null;
  return {
    v: o['v'] as number,
    load_id: o['load_id'] as string,
    kind: o['kind'] as PhotoKind,
    actor_user_id: o['actor_user_id'] as string,
    site_id: o['site_id'] as string,
    idempotency_key: o['idempotency_key'] as string,
    exp: o['exp'] as number,
  };
}

/**
 * Verify signature, key version and expiry. NOTHING ELSE.
 *
 * This function answers "did we mint this, and is it still inside its window?".
 * It deliberately does not answer "may this write happen", because a bearer
 * token's signature says nothing about whether the person it names still works
 * here. Field matching (load/kind), the live site read, the storage-key prefix
 * and the D5(a) revocation re-read all live in `requireOperatorOrGrantAtLoadSite`,
 * where the database is reachable.
 *
 * @param nowMs injected so the expiry test drives a real clock over real HMAC
 *              bytes rather than stubbing a branch of this function.
 */
export function verifyPhotoGrant(
  token: string | null | undefined,
  nowMs?: number,
): PhotoGrantVerification {
  if (!token || token.length > PHOTO_GRANT_MAX_LENGTH) {
    return { ok: false, reason: 'grant_malformed' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    return { ok: false, reason: 'grant_malformed' };
  }
  const segment = token.slice(0, dot);
  const presented = token.slice(dot + 1);

  let payload: PhotoGrantPayload | null;
  try {
    payload = parsePayload(JSON.parse(fromB64url(segment).toString('utf8')));
  } catch {
    return { ok: false, reason: 'grant_malformed' };
  }
  if (!payload) return { ok: false, reason: 'grant_malformed' };

  // Read the version BEFORE trusting anything else in the payload — it selects
  // the key, and an unknown version must be refused rather than silently
  // verified against the current one.
  const secret = keyForVersion(payload.v);
  if (!secret) {
    return {
      ok: false,
      reason: photoGrantsConfigured() ? 'grant_unknown_key_version' : 'grant_not_configured',
    };
  }

  const expected = sign(secret, segment);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  // Length-check first: `timingSafeEqual` THROWS on a length mismatch, and an
  // uncaught throw here would turn a forged token into a 500 instead of a 403.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'grant_bad_signature' };
  }

  const nowSec = Math.floor((nowMs ?? Date.now()) / 1000);
  if (payload.exp <= nowSec) return { ok: false, reason: 'grant_expired' };

  return { ok: true, payload };
}

/**
 * A non-credential handle for a grant, safe to log.
 *
 * ADR-0086 §6.3: the grant must be redacted in every log, Sentry breadcrumb and
 * error body. A fingerprint still lets two log lines be tied to the same grant
 * during an incident, which is the only reason to log anything about one.
 *
 * Salted with the signing secret so the digest cannot be reversed by anyone
 * holding a candidate token from a device but not the server's key.
 */
export function grantFingerprint(token: string): string {
  const secret = secretFor('current') ?? 'unconfigured';
  return createHmac('sha256', secret).update(`fp:${token}`).digest('hex').slice(0, 12);
}

// The middleware's SYNTACTIC counterpart to this module lives in
// `@/lib/public-paths` (`isGrantBearingPhotoRequest`) and NOT here, deliberately:
// this file imports `node:crypto`, and the middleware runs on the edge runtime,
// where that import fails the build. Same reason `middleware.ts` imports
// `auth.config` rather than `auth`.
