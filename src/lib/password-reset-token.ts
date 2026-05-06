import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Stateless reset tokens: HMAC-signed strings of the form
//   `${user_id}.${expires_at_unix}.${nonce}.${signature}`
//
// Using a stateless token keeps the bootstrap simple — no extra DB
// table, no migration, no cleanup. Cost: a leaked token is valid for
// its full TTL (15 min) regardless of any "revoke" action on our side.
// That window is short enough for the manager/admin reset-flow risk
// model. If we later want server-side revocation, swap the encoder
// for a row in `password_reset_tokens` keyed by sha256(token).
//
// HMAC key is `NEXTAUTH_SECRET`, so token validity is bound to the
// JWT-signing key; rotating that key invalidates outstanding reset
// links along with all sessions, which is the desired blast radius.

const TOKEN_TTL_S = 15 * 60; // 15 min

function getKey(): Buffer {
  const secret = process.env['NEXTAUTH_SECRET'];
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  return Buffer.from(secret);
}

function sign(payload: string): string {
  return createHmac('sha256', getKey()).update(payload).digest('base64url');
}

export function issueResetToken(userId: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const nonce = randomBytes(8).toString('base64url');
  const payload = `${userId}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyResetToken(token: string): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [userId, expStr, nonce, sig] = parts;
  if (!userId || !expStr || !nonce || !sig) return null;
  const payload = `${userId}.${expStr}.${nonce}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiresAt = Number.parseInt(expStr, 10);
  if (!Number.isFinite(expiresAt)) return null;
  if (Math.floor(Date.now() / 1000) > expiresAt) return null;
  return { userId };
}
