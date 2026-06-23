// ADR-0034 — URL-safe cryptographic tokens for survey invite access.
//
// 32-char base64url tokens. crypto.randomBytes(24) gives 24 bytes = 192 bits
// entropy; base64url-encoded yields exactly 32 chars (no padding).
//
// Never log the token. Never include it in error messages. Always reference
// invites by their internal UUID in logs and audit rows.

import { randomBytes } from 'node:crypto';

const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isValidTokenShape(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}
