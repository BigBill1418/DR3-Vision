// ADR-0057 D1/D9 — encrypted MyMRC admin credential store.
//
// Single source of truth for Bill's MyMRC (Salesforce Experience Cloud) admin
// login, replacing the retired per-site env-var scheme (ADR-0057 D1). The
// password is encrypted at rest with AES-256-GCM; only this module ever
// decrypts it, and the plaintext password NEVER crosses a client boundary, an
// API response body, or a log line. `getMymrcCredentialStatus` — the shape the
// UI/status API renders — does not even SELECT the ciphertext columns.
//
// ── Dual-compile constraint ──────────────────────────────────────────────
// This module lives under src/lib/mymrc/ and is compiled BOTH by the Next app
// (tsconfig.json, imported via `@/lib/mymrc`) AND standalone to dist/mymrc/ for
// the scrape worker (tsconfig.mymrc.json, consumed by scripts/mymrc-scrape.mjs
// through createRequire). It therefore CANNOT import `@/lib/prisma` or the
// `server-only` package:
//   - Every function takes a PrismaClient PARAMETER (identical pattern to
//     sync.ts / upsert.ts) — it never imports the app singleton. The app
//     passes its `@/lib/prisma` singleton; the scrape passes its own
//     `new PrismaClient()`.
//   - No `server-only` guard: the `server-only` package throws when required
//     from a plain Node process (the scrape). Server-only-ness is enforced
//     structurally instead — this module is only reached from route handlers
//     (inherently server) and the Node scrape, never from a client bundle, and
//     it reads a secret + uses node:crypto, neither of which exists on a client.
//
// ── Encryption key source (LOAD-BEARING — see report) ────────────────────
// The AES-256 key derives from a DEDICATED `MYMRC_CRED_KEY` secret via scrypt
// with a fixed app-specific salt — NOT from NEXTAUTH_SECRET. The scrape
// container is deliberately stripped of NEXTAUTH_SECRET (ADR-0053 addendum, so
// a compromised Chromium cron cannot mint admin JWTs offline); deriving the
// cred key from it would either break decryption in the scrape or force
// reversing that hardening. A dedicated key keeps the blast radius separate: a
// scrape compromise exposes only the MyMRC cred key (which decrypts MyMRC creds
// the scrape needs anyway), never the JWT-signing secret. BOTH the app (writer)
// and the scrape (reader) MUST have `MYMRC_CRED_KEY` in their environment.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AuditAction, PrismaClient } from '@prisma/client';

/** Fixed primary key of the one and only credential row. */
const SINGLETON_ID = 'singleton';

/** Env var holding the dedicated credential-encryption secret (see header). */
const KEY_ENV = 'MYMRC_CRED_KEY';

/**
 * Fixed, app-specific, NON-secret scrypt salt. Pins the KDF so the same
 * `MYMRC_CRED_KEY` always derives the same AES key across the app and the
 * scrape. It is intentionally a constant (not per-row): rotating the encryption
 * SCHEME means bumping both this salt and `CURRENT_KEY_VERSION` together.
 */
const KEY_SALT = 'dr3-vision.mymrc.credstore.v1';

/** Encryption scheme version persisted per row; gates decrypt (see getMymrcCredentials). */
const CURRENT_KEY_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256
const AUDIT_ACTOR_LABEL = 'mymrc-credential-surface';

// ── Typed errors ─────────────────────────────────────────────────────────────

/** Username/password/actor failed the non-empty (post-trim) precondition. */
export class InvalidCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialInputError';
  }
}

/** `MYMRC_CRED_KEY` is missing/empty — cannot encrypt or decrypt. */
export class CredentialKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialKeyUnavailableError';
  }
}

/**
 * Decryption failed closed: GCM auth check rejected the ciphertext/iv/tag
 * (tampering or wrong key), or the stored `key_version` is not decryptable by
 * the current scheme. NEVER surfaces a partial/garbage plaintext and NEVER
 * degrades to "unconfigured".
 */
export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialDecryptError';
  }
}

// ── Public shapes ────────────────────────────────────────────────────────────

export interface MymrcCredentials {
  username: string;
  password: string;
}

/** Non-secret status for the UI/status API. Carries NO password, NO ciphertext. */
export interface MymrcCredentialStatus {
  configured: boolean;
  username: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

// ── Crypto internals ─────────────────────────────────────────────────────────

interface EncryptedPassword {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

function deriveKey(): Buffer {
  const secret = process.env[KEY_ENV]?.trim();
  if (!secret) {
    throw new CredentialKeyUnavailableError(
      `${KEY_ENV} is not set — cannot encrypt or decrypt MyMRC credentials`,
    );
  }
  return scryptSync(secret, KEY_SALT, KEY_BYTES);
}

function encryptPassword(plaintext: string): EncryptedPassword {
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptPassword(enc: EncryptedPassword): string {
  const key = deriveKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(enc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(enc.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // GCM auth failure (tampered ciphertext/iv/tag, or wrong key). Fail CLOSED.
    throw new CredentialDecryptError('MyMRC credential decryption failed the integrity check');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt + persist the single admin credential row, and append a
 * (password-free) audit-log entry. Rejects empty/whitespace username, password,
 * or actorUserId. The plaintext password is used only to produce ciphertext and
 * is never persisted, logged, or returned.
 */
export async function setMymrcCredentials(
  prisma: PrismaClient,
  input: MymrcCredentials,
  actorUserId: string,
): Promise<void> {
  const username = input.username.trim();
  const actor = actorUserId.trim();
  if (!username) throw new InvalidCredentialInputError('username is required');
  if (!input.password.trim()) throw new InvalidCredentialInputError('password is required');
  if (!actor) throw new InvalidCredentialInputError('actorUserId is required');

  // Encrypt BEFORE the DB round-trip so a key-config error aborts without a
  // partial write. The password is stored exactly as given (not trimmed) so no
  // credential character is silently dropped.
  const enc = encryptPassword(input.password);

  const existing = await prisma.mymrcAdminCredential.findUnique({
    where: { id: SINGLETON_ID },
    select: { id: true, username: true },
  });

  await prisma.mymrcAdminCredential.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      username,
      password_ciphertext: enc.ciphertext,
      password_iv: enc.iv,
      password_auth_tag: enc.authTag,
      key_version: CURRENT_KEY_VERSION,
      updated_by: actor,
    },
    update: {
      username,
      password_ciphertext: enc.ciphertext,
      password_iv: enc.iv,
      password_auth_tag: enc.authTag,
      key_version: CURRENT_KEY_VERSION,
      updated_by: actor,
    },
  });

  // Audit trail. Records ONLY non-secret metadata (who set it, the username,
  // that a credential now exists) — never the password or any ciphertext.
  const action: AuditAction = existing ? 'update' : 'insert';
  const after: Prisma.InputJsonObject = {
    username,
    configured: true,
    key_version: CURRENT_KEY_VERSION,
  };
  await prisma.auditLog.create({
    data: {
      actor_user_id: actor,
      actor_label: AUDIT_ACTOR_LABEL,
      action,
      table_name: 'mymrc_admin_credentials',
      row_id: SINGLETON_ID,
      before: existing
        ? ({ username: existing.username, configured: true } satisfies Prisma.InputJsonObject)
        : Prisma.JsonNull,
      after,
    },
  });
}

/**
 * Decrypt and return the admin credentials, or `null` when none are configured.
 * SERVER/SCRAPE ONLY — this is the sole path that materializes the plaintext
 * password, and the caller must never log or forward it. Throws
 * `CredentialDecryptError` (fail-closed) on tamper or an undecryptable
 * key_version — never returns `null` to mask corruption as "unconfigured".
 */
export async function getMymrcCredentials(prisma: PrismaClient): Promise<MymrcCredentials | null> {
  const row = await prisma.mymrcAdminCredential.findUnique({
    where: { id: SINGLETON_ID },
    select: {
      username: true,
      password_ciphertext: true,
      password_iv: true,
      password_auth_tag: true,
      key_version: true,
    },
  });
  if (!row) return null;
  if (row.key_version !== CURRENT_KEY_VERSION) {
    throw new CredentialDecryptError(
      `MyMRC credential key_version ${row.key_version} is not decryptable by scheme ${CURRENT_KEY_VERSION}`,
    );
  }
  const password = decryptPassword({
    ciphertext: row.password_ciphertext,
    iv: row.password_iv,
    authTag: row.password_auth_tag,
  });
  return { username: row.username, password };
}

/**
 * Non-secret configuration status for the admin surface / status API. Selects
 * no password column at all — the ciphertext never leaves Postgres on this
 * path. Safe to serialize into any API response.
 */
export async function getMymrcCredentialStatus(
  prisma: PrismaClient,
): Promise<MymrcCredentialStatus> {
  const row = await prisma.mymrcAdminCredential.findUnique({
    where: { id: SINGLETON_ID },
    select: { username: true, updated_at: true, updated_by: true },
  });
  if (!row) {
    return { configured: false, username: null, updatedAt: null, updatedBy: null };
  }
  return {
    configured: true,
    username: row.username,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
